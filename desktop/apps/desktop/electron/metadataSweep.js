'use strict'
// ============================================================================
// metadataSweep.js - proactively re-check movies whose TMDB match is still
// unanswered, instead of waiting for someone to open that title (or press
// "Re-check all movie matches") before the matcher ever runs again.
// ----------------------------------------------------------------------------
// Modeled directly on subtitleSweep.js's shape: a scheduler on top of the
// existing single-file lookup path (titleMatch.shouldLookUp() decides what
// needs a look, the injected lookupOne() - the real tmdbLookup() in
// streamServer.js - does the actual match/applyVerdict/manifest write).
// Nothing here makes an HTTP request of its own, so a bug in a bulk sweep
// can never open a second door to TMDB beyond what a single-title lookup
// already could - and createTmdbApi()'s own 429 retry/backoff already
// protects every call this makes, exactly as it protects every other caller.
//
// Movies only, for now. TV shows go through tmdbLookupTv(), a materially
// different and older cache (tvCache/tvManifestHit in streamServer.js) with
// no decision store, no review queue, and no shouldLookUp-style "unanswered
// vs no such show" distinction. Extending this sweep to TV needs that
// groundwork first, not a copy of this file - see PLEX-PARITY-PLAN.md #2.
//
// Safety limits, so a reviewer can see the whole blast radius from this file:
//   * SEQUENTIAL - one file at a time, never several at once.
//   * a pause between files (delayMs, default 1.5s), even when nothing was
//     found, so a big library can never turn into a burst of requests.
//   * a hard cap on how many files one run EXAMINES (batchSize, default 40,
//     clamped 1-200) - counted against every file the sweep looks at, not
//     just the ones that needed a lookup, so a huge library still finishes
//     one run in bounded time. A big library needs several runs (or days).
//   * offline / no API key: lookupOne is expected to fail cheaply (the real
//     tmdbLookup() already returns the on-disk cache with no network call
//     when there is no key) - a run over an offline library finishes fast.
//   * five lookup failures in a row stops the run rather than ploughing
//     through the rest of the library with a dead connection.
// ============================================================================

const DEFAULT_BATCH_SIZE = 40
const MAX_BATCH_SIZE = 200
const DEFAULT_DELAY_MS = 1500
const MAX_CONSECUTIVE_ERRORS = 5

function clampBatchSize(n) {
  const v = Math.trunc(Number(n))
  return Number.isFinite(v) && v > 0 ? Math.min(MAX_BATCH_SIZE, v) : DEFAULT_BATCH_SIZE
}

/**
 * Builds the runner. Every collaborator is injected so this can be unit tested with fakes and,
 * in the app, wired to the real library walk + titleMatch.shouldLookUp + tmdbLookup - never
 * anything new.
 */
function createSweepRunner({
  listCandidates,   // () => Promise<[fileName]> | [fileName] - every movie file
  shouldLookUp,     // (fileName) => boolean - true when this file still needs a TMDB lookup
  lookupOne,        // (fileName) => Promise<any> - performs the lookup; writes the manifest/queue itself
  log = () => {},
  now = () => Date.now(),
  delayMs = DEFAULT_DELAY_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
} = {}) {
  let running = false
  let lastResult = null

  async function run({ batchSize = DEFAULT_BATCH_SIZE } = {}) {
    if (running) return { ok: false, error: 'already_running', message: 'A metadata sweep is already running.' }
    running = true
    const result = {
      startedAt: now(),
      finishedAt: null,
      batchSize: clampBatchSize(batchSize),
      examined: 0,
      lookedUp: 0,
      errors: [],
      stoppedEarly: null
    }
    try {
      let candidates = []
      try { candidates = (await listCandidates()) || [] } catch (e) {
        log(`metadata sweep: could not list the library (${e && e.message})`)
        candidates = []
      }

      let calledLookup = false
      let consecutiveErrors = 0
      for (const fileName of candidates) {
        if (result.examined >= result.batchSize) { result.stoppedEarly = result.stoppedEarly || 'batch_size'; break }
        result.examined++

        let needsLookup = false
        try { needsLookup = !!shouldLookUp(fileName) } catch { needsLookup = false }
        if (!needsLookup) continue

        if (calledLookup) await sleep(delayMs)
        calledLookup = true

        try {
          await lookupOne(fileName)
          result.lookedUp++
          consecutiveErrors = 0
          log(`metadata sweep: looked up ${fileName}`)
        } catch (e) {
          result.errors.push({ item: fileName, error: (e && e.message) || 'lookup_failed' })
          consecutiveErrors++
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) { result.stoppedEarly = 'errors'; break }
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
  DEFAULT_DELAY_MS,
  MAX_CONSECUTIVE_ERRORS,
  clampBatchSize,
  createSweepRunner
}
