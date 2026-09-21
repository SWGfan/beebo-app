'use strict'
// ============================================================================
// subtitleSweep.js - "Search online" for subtitles, for every title at once.
// ----------------------------------------------------------------------------
// This is a scheduler on top of playbackApi.js's onlineSearch/onlineDownload -
// the exact same functions the single-title "Search online" button in the
// phone/TV/web player calls, which in turn are the only code in this app that
// talks to openSubtitles.js's one client (one login cache, one set of
// friendly errors for a 406/429 "limit reached"). Nothing in this file makes
// an HTTP request of its own, computes a hash, writes a sidecar file, or
// tracks a quota number itself - all of that stays exactly once, in
// openSubtitles.js and playbackApi.js, so a bug in a bulk sweep can never
// open a second door to the owner's daily OpenSubtitles download allowance.
//
// Safety limits, so a reviewer can see the whole blast radius from this file:
//   * SEQUENTIAL - one title's search-then-maybe-download at a time, never
//     several at once.
//   * a pause between titles (delayMs, default 1.5s) even when nothing was
//     downloaded, so a big library can never turn into a burst of requests.
//   * a hard cap on how many titles one run examines (batchSize, default 25,
//     clamped 1-100) - a sweep nibbles at the library, it does not devour it
//     in one sitting. A big library needs several runs (or several days).
//   * before starting, asks OpenSubtitles how many downloads are left today
//     (subtitleClient.test(), the exact call the Settings "Test" button
//     makes) and refuses to start at all once today's allowance is gone.
//   * after every real download, reads `remaining` straight out of that
//     download's own response (openSubtitles.js's download(), the same field
//     the single-title flow already shows the viewer) - never a locally
//     guessed number - and stops the rest of the run the moment it reaches
//     minRemaining (default 3) or below.
//   * OpenSubtitles answering "limit reached" on a search OR a download
//     (openSubtitles.js's friendlyError -> error code 'limit') stops the run
//     immediately, whatever title it happens on.
//   * five network errors in a row (offline, OpenSubtitles unreachable, etc)
//     stops the run rather than ploughing through the rest of the library
//     with a dead connection.
//   * a title that already has a subtitle in the wanted language - sidecar or
//     embedded text track, exactly what playback.info() already reports for
//     the single-title picker - is skipped without ever calling OpenSubtitles.
// ============================================================================

const DEFAULT_BATCH_SIZE = 25
const MAX_BATCH_SIZE = 100
const DEFAULT_MIN_REMAINING = 3
const MAX_MIN_REMAINING = 50
const DEFAULT_DELAY_MS = 1500
const MAX_CONSECUTIVE_ERRORS = 5

function clampBatchSize(n) {
  const v = Math.trunc(Number(n))
  return Number.isFinite(v) && v > 0 ? Math.min(MAX_BATCH_SIZE, v) : DEFAULT_BATCH_SIZE
}

function clampMinRemaining(n) {
  const v = Math.trunc(Number(n))
  return Number.isFinite(v) && v >= 0 ? Math.min(MAX_MIN_REMAINING, v) : DEFAULT_MIN_REMAINING
}

/** Normalizes whatever a settings screen might have saved for the wanted language. */
function normalizeLanguage(raw) {
  const s = String(raw || '').trim().toLowerCase()
  return s === '' || s === 'any' ? 'any' : s
}

/**
 * Does this title still need a subtitle in `language` ('any' = no subtitle at all yet)?
 * `subtitles` is playback.info()'s own `subtitles` array (sidecars + embedded text tracks) -
 * the same list the single-title picker shows - so "missing" here means exactly what it would
 * mean to someone looking at that picker themselves.
 */
function isMissing(subtitles, language, sameLanguage) {
  const list = Array.isArray(subtitles) ? subtitles : []
  if (language === 'any') return list.length === 0
  return !list.some((s) => s && typeof sameLanguage === 'function' && sameLanguage(s.language, language))
}

/**
 * Builds the runner. Every collaborator is injected so this can be unit tested with fakes and,
 * in the app, wired to playback.info / playback.onlineSearch / playback.onlineDownload /
 * playback.subtitleClient.configured / playback.testOpenSubtitles - never anything new.
 */
function createSweepRunner({
  listCandidates,     // () => Promise<[{ kind, id, label }]> | [...] - e.g. every movie + episode file
  getInfo,            // (kind, id) => Promise<{ status, body }>  - playback.info()
  search,             // (kind, id, language) => Promise<{ status, body }> - playback.onlineSearch()
  download,           // (body) => Promise<{ status, body }> - playback.onlineDownload()
  configured,         // () => boolean - subtitleClient.configured()
  testQuota,          // () => Promise<{ remainingDownloads }> - subtitleClient.test()
  sameLanguage,       // (a, b) => boolean - playbackTracks.sameLanguage
  log = () => {},
  now = () => Date.now(),
  delayMs = DEFAULT_DELAY_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
} = {}) {
  let running = false
  let lastResult = null

  async function run({ language = 'en', batchSize = DEFAULT_BATCH_SIZE, minRemaining = DEFAULT_MIN_REMAINING } = {}) {
    if (running) return { ok: false, error: 'already_running', message: 'A subtitle sweep is already running.' }
    if (typeof configured === 'function' && !configured()) {
      return { ok: false, error: 'not_configured', message: 'Subtitle search is not set up yet. Add an OpenSubtitles key in Settings first.' }
    }
    running = true
    const lang = normalizeLanguage(language)
    const result = {
      startedAt: now(),
      finishedAt: null,
      language: lang,
      batchSize: clampBatchSize(batchSize),
      minRemaining: clampMinRemaining(minRemaining),
      examined: 0,
      missing: 0,
      downloaded: 0,
      skipped: 0,
      errors: [],
      stoppedEarly: null,
      remainingDownloads: null
    }
    try {
      if (typeof testQuota === 'function') {
        try {
          const q = await testQuota()
          if (q && typeof q.remainingDownloads === 'number') {
            result.remainingDownloads = q.remainingDownloads
            if (q.remainingDownloads <= 0) {
              result.stoppedEarly = 'quota_exhausted'
              return finish()
            }
          }
        } catch {
          // Same as the Settings "Test" button: if the account-info call fails, search can
          // still work (a key alone searches with no login) - just skip the preflight number.
        }
      }

      let candidates = []
      try { candidates = (await listCandidates()) || [] } catch (e) { log(`subtitle sweep: could not list the library (${e && e.message})`); candidates = [] }

      let calledNetwork = false
      let consecutiveErrors = 0
      for (const item of candidates) {
        if (result.examined >= result.batchSize) { result.stoppedEarly = result.stoppedEarly || 'batch_size'; break }
        result.examined++

        let info = null
        try { info = await getInfo(item.kind, item.id) } catch { info = null }
        const subtitles = info && info.body && info.body.ok !== false && Array.isArray(info.body.subtitles) ? info.body.subtitles : null
        if (subtitles === null) { result.errors.push({ item: item.label || item.id, error: 'unreadable' }); continue }
        if (!isMissing(subtitles, lang, sameLanguage)) { result.skipped++; continue }
        result.missing++

        if (calledNetwork) await sleep(delayMs)
        calledNetwork = true

        let searchRes = null
        try { searchRes = await search(item.kind, item.id, lang === 'any' ? '' : lang) } catch { searchRes = null }
        const sBody = searchRes && searchRes.body
        if (!sBody || !sBody.ok) {
          if (sBody && sBody.error === 'limit') { result.stoppedEarly = 'quota_exhausted'; break }
          result.errors.push({ item: item.label || item.id, error: (sBody && sBody.error) || 'search_failed' })
          consecutiveErrors++
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) { result.stoppedEarly = 'errors'; break }
          continue
        }
        consecutiveErrors = 0
        const best = Array.isArray(sBody.results) ? sBody.results[0] : null
        if (!best) { result.skipped++; continue }

        let dlRes = null
        try {
          dlRes = await download({
            kind: item.kind,
            id: item.id,
            fileId: best.fileId,
            lang: lang === 'any' ? best.language : lang,
            hearingImpaired: false,
            forced: false
          })
        } catch { dlRes = null }
        const dBody = dlRes && dlRes.body
        if (!dBody || !dBody.ok) {
          if (dBody && dBody.error === 'limit') { result.stoppedEarly = 'quota_exhausted'; break }
          result.errors.push({ item: item.label || item.id, error: (dBody && dBody.error) || 'download_failed' })
          consecutiveErrors++
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) { result.stoppedEarly = 'errors'; break }
          continue
        }
        consecutiveErrors = 0
        result.downloaded++
        log(`subtitle sweep: saved ${lang === 'any' ? '' : lang + ' '}subtitles for ${item.label || item.id}`)
        if (typeof dBody.remaining === 'number') {
          result.remainingDownloads = dBody.remaining
          if (dBody.remaining <= result.minRemaining) { result.stoppedEarly = 'quota_low'; break }
        }
      }
      return finish()
    } finally {
      running = false
    }

    function finish() {
      result.finishedAt = now()
      lastResult = result
      return { ok: true, result }
    }
  }

  return {
    run,
    isRunning: () => running,
    lastResult: () => lastResult
  }
}

module.exports = {
  DEFAULT_BATCH_SIZE,
  MAX_BATCH_SIZE,
  DEFAULT_MIN_REMAINING,
  MAX_MIN_REMAINING,
  DEFAULT_DELAY_MS,
  MAX_CONSECUTIVE_ERRORS,
  clampBatchSize,
  clampMinRemaining,
  normalizeLanguage,
  isMissing,
  createSweepRunner
}
