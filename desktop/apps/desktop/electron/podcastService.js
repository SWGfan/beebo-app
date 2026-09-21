'use strict'
// Podcasts: the shared show catalog, each person's own listening state, the background refresher,
// the capped download folder and the audio tools (chapters, skip-silence).
//
// What is shared and what is personal:
//   - SHARED (the household): a show is fetched once, however many people subscribe to it. Its
//     feed record, episode list and downloaded audio files live in <dir>/ and are removed when
//     the last subscriber leaves.
//   - PERSONAL (one account): subscriptions, per-show auto-download, what is played, where each
//     episode was left, the play queue and listening preferences (speed, skip silence). Nothing
//     personal is ever readable through another person's id (see the API layer), and removeUser()
//     drops it with the account (userDeletion.js).
//
// Storage (<dir> defaults to podcasts/ beside the app store's file):
//   state.json          feeds + people (safeJson atomic write, .bak kept, corrupt file quarantined)
//   feeds/<feedId>.json the episode list of one show (newest 500)
//   downloads/<feedId>/<episodeId>.<ext> and .ns.m4a (silence-skipped copy)
//   chapters/<key>.json fetched Podcasting 2.0 chapters
//
// Every outbound request goes through outboundFetch.js (SSRF guard, redirect re-checks, byte and
// time limits). Feed URLs are never written to the log (private feeds carry a token in the URL).

const fs = require('fs')
const fsp = require('fs/promises')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { spawn } = require('child_process')
const { readJsonSafe, writeJsonAtomic } = require('./safeJson')
const feedLib = require('./podcastFeed')
const { inputArgs } = require('./ffmpegArgs')
const xmlLite = require('./xmlLite')
const { readId3Chapters } = require('./id3Chapters')
const { createFetcher } = require('./outboundFetch')

const SETTINGS_KEY = 'podcastSettings'
const MB = 1024 * 1024
const FEED_MAX_BYTES = 8 * MB
const KEY_RE = /^[a-f0-9]{12}\.[a-f0-9]{16}$/
const FEED_ID_RE = /^[a-f0-9]{12}$/
const MAX_FEEDS = 1000
const MAX_SUBS_PER_USER = 200
const MAX_QUEUE = 500
const MAX_EPISODE_STATES = 5000
const MAX_OPML_IMPORT = 200
const MAX_PINNED_PER_USER = 50
const SPEED_MIN = 0.5
const SPEED_MAX = 3

const DEFAULT_SETTINGS = Object.freeze({
  refreshMinutes: 60,
  downloadCapMb: 5120,
  maxEpisodeMb: 600,
  maxAutoDownload: 10,
  allowPrivateNetwork: false
})

const fail = (status, code) => Object.assign(new Error(code), { status, code })
const own = (o, k) => (o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined)
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex')
const clampInt = (v, lo, hi, dflt) => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt
}

/** 0.5x to 3x in steps of 0.05, whatever the caller sent. */
function clampSpeed(v, dflt = 1) {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.round(Math.min(SPEED_MAX, Math.max(SPEED_MIN, n)) * 20) / 20
}

function cleanSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  return {
    refreshMinutes: clampInt(r.refreshMinutes, 15, 1440, DEFAULT_SETTINGS.refreshMinutes),
    downloadCapMb: clampInt(r.downloadCapMb, 0, 1024 * 1024, DEFAULT_SETTINGS.downloadCapMb),
    maxEpisodeMb: clampInt(r.maxEpisodeMb, 10, 4096, DEFAULT_SETTINGS.maxEpisodeMb),
    maxAutoDownload: clampInt(r.maxAutoDownload, 0, 50, DEFAULT_SETTINGS.maxAutoDownload),
    allowPrivateNetwork: r.allowPrivateNetwork === true
  }
}

const EXT_BY_MIME = { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/flac': 'flac', 'audio/webm': 'webm', 'video/mp4': 'mp4', 'video/x-m4v': 'm4v', 'video/webm': 'webm', 'application/ogg': 'ogg' }
const MIME_BY_EXT = { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', opus: 'audio/ogg', oga: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac', webm: 'audio/webm', mp4: 'video/mp4', m4v: 'video/mp4' }

function extFor(ep) {
  const mime = String(ep.audioType || '').split(';')[0].trim().toLowerCase()
  if (EXT_BY_MIME[mime]) return EXT_BY_MIME[mime]
  try {
    const e = path.extname(new URL(ep.audioUrl).pathname).slice(1).toLowerCase()
    if (MIME_BY_EXT[e]) return e
  } catch {}
  return 'mp3'
}

// A download must look like media. An HTML page (a paywall, an error) saved as episode.mp3 is worse than a failure.
const acceptMedia = (h) => {
  const t = String(h['content-type'] || '').split(';')[0].trim().toLowerCase()
  return !t || /^(audio\/|video\/|application\/(ogg|octet-stream|binary|x-mpegurl))/.test(t)
}

// ffmpeg's silenceremove: trim leading silence, and shorten every later pause over half a second to 0.2s.
function silenceArgs(input, output) {
  // inputArgs: "file:" prefix and a protocol whitelist, so a path can only ever be a local file (ffmpegArgs.js).
  return ['-v', 'error', '-nostdin', '-y', ...inputArgs(input), '-map', '0:a:0', '-vn', '-sn', '-map_metadata', '-1',
    '-af', 'silenceremove=start_periods=1:start_silence=0.1:start_threshold=-50dB:stop_periods=-1:stop_duration=0.5:stop_silence=0.2:stop_threshold=-50dB:detection=peak',
    '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', '-f', 'mp4', output]
}

function defaultRunFfmpeg(ffmpegPath, args, timeoutMs) {
  return new Promise((resolve) => {
    if (!ffmpegPath) { resolve({ ok: false, error: 'no_ffmpeg' }); return }
    let stderr = ''
    let done = false
    let child
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r) } }
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} finish({ ok: false, error: 'timeout' }) }, timeoutMs)
    if (timer.unref) timer.unref()
    try {
      child = spawn(ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (err) { finish({ ok: false, error: String(err && err.code || err) }); return }
    child.stderr.on('data', (d) => { if (stderr.length < 2000) stderr += d })
    child.on('error', (err) => finish({ ok: false, error: String(err && err.code || err) }))
    child.on('close', (code) => finish(code === 0 ? { ok: true } : { ok: false, error: stderr.trim().split('\n').pop() || 'ffmpeg_failed' }))
  })
}

function defaultDir(store) {
  return store && store.path ? path.join(path.dirname(store.path), 'podcasts') : path.join(os.tmpdir(), 'beebo-podcasts')
}

/**
 * @param {object} o
 * @param {object} o.store         the app store (settings only)
 * @param {string} [o.dir]         where the catalog and downloads live
 * @param {object} [o.fetcher]     outboundFetch fetcher (tests pass a fake)
 * @param {Function} [o.now]
 * @param {Function} [o.log]
 * @param {string} [o.ffmpegPath]
 * @param {Function} [o.runFfmpeg] (args, timeoutMs) => Promise<{ ok, error? }>
 */
function createPodcasts({ store, dir, fetcher, searchFetcher, now = Date.now, log, ffmpegPath, runFfmpeg, autoStart = false } = {}) {
  const say = typeof log === 'function' ? log : () => {}
  const root = dir || defaultDir(store)
  const stateFile = path.join(root, 'state.json')
  const settings = () => {
    let raw
    try { raw = store && store.get(SETTINGS_KEY) } catch {}
    return cleanSettings(raw)
  }
  const net = fetcher || createFetcher({ allowPrivateNetwork: () => settings().allowPrivateNetwork })
  // Apple's directory is a fixed public host: it never gets the local-network allowance.
  const publicNet = searchFetcher || fetcher || createFetcher({ allowPrivateNetwork: false })
  const ff = runFfmpeg || ((args, ms) => defaultRunFfmpeg(ffmpegPath, args, ms))

  // ----- state -----------------------------------------------------------------------------
  const loaded = readJsonSafe(stateFile, () => ({}))
  const state = loaded.data && typeof loaded.data === 'object' && !Array.isArray(loaded.data) ? loaded.data : {}
  if (!state.feeds || typeof state.feeds !== 'object') state.feeds = {}
  if (!state.users || typeof state.users !== 'object') state.users = {}
  if (!state.downloads || typeof state.downloads !== 'object') state.downloads = {}
  state.version = 1

  let saveTimer = null
  function saveNow() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
    try { writeJsonAtomic(stateFile, state, { indent: 0, backupEveryMs: 10 * 60 * 1000 }) } catch (err) { say(`podcasts: could not save state: ${err && err.code || err}`) }
  }
  function saveSoon() {
    if (saveTimer) return
    saveTimer = setTimeout(saveNow, 1500)
    if (saveTimer.unref) saveTimer.unref()
  }

  const episodeCache = new Map()
  const episodesFile = (feedId) => path.join(root, 'feeds', feedId + '.json')
  function loadEpisodes(feedId) {
    if (!FEED_ID_RE.test(feedId)) return []
    if (episodeCache.has(feedId)) return episodeCache.get(feedId)
    const r = readJsonSafe(episodesFile(feedId), () => ({ episodes: [] }))
    const list = r.data && Array.isArray(r.data.episodes) ? r.data.episodes : []
    episodeCache.set(feedId, list)
    return list
  }
  function saveEpisodes(feedId, list) {
    episodeCache.set(feedId, list)
    try { writeJsonAtomic(episodesFile(feedId), { episodes: list }, { indent: 0, backup: false }) } catch (err) { say(`podcasts: could not save episodes: ${err && err.code || err}`) }
  }
  const keyOf = (feedId, epId) => `${feedId}.${epId}`
  function findEpisode(key) {
    if (!KEY_RE.test(String(key))) return null
    const [feedId, epId] = key.split('.')
    const feed = own(state.feeds, feedId)
    if (!feed) return null
    const ep = loadEpisodes(feedId).find((e) => e.id === epId)
    return ep ? { feed, ep, key } : null
  }

  // ----- people ----------------------------------------------------------------------------
  function userOf(userId, create) {
    if (!userId) throw fail(401, 'unauthorized')
    let u = own(state.users, userId)
    if (!u && create) {
      u = { subs: {}, episodes: {}, queue: [], prefs: { speed: 1, skipSilence: false, speedByFeed: {} } }
      state.users[userId] = u
    }
    return u || null
  }
  const subOf = (u, feedId) => (u ? own(u.subs, feedId) : undefined)
  const isDone = (u, key) => !!(u && own(u.episodes, key) && u.episodes[key].done)
  const progressOf = (u, key) => (u && own(u.episodes, key) ? u.episodes[key].pos || 0 : 0)
  const subscribersOf = (feedId) => Object.keys(state.users).filter((id) => subOf(state.users[id], feedId))

  function needSubscription(userId, feedId) {
    const u = userOf(userId, false)
    if (!u || !subOf(u, feedId)) throw fail(403, 'not_subscribed')
    return u
  }

  // ----- shapes ----------------------------------------------------------------------------
  const streamPath = (key) => `/api/podcasts/episode/${key}/stream`

  function shapeFeed(feed, u) {
    const eps = loadEpisodes(feed.id)
    let unplayed = 0
    if (u) for (const e of eps) if (!isDone(u, keyOf(feed.id, e.id))) unplayed++
    const sub = subOf(u, feed.id)
    return {
      id: feed.id, title: feed.title || feed.url, author: feed.author || '', description: feed.description || '', link: feed.link || '',
      image: feed.image || '', language: feed.language || '', explicit: !!feed.explicit, categories: feed.categories || [], showType: feed.showType || 'episodic',
      episodeCount: eps.length, unplayed, lastCheckedAt: feed.lastCheckedAt || 0, lastSuccessAt: feed.lastSuccessAt || 0,
      error: feed.failures > 0 ? feed.lastError || 'error' : '', pending: !feed.lastSuccessAt,
      subscribed: !!sub, autoDownload: sub ? sub.autoDownload || 0 : 0, newFeedUrl: feed.newFeedUrl || ''
    }
  }

  function shapeEpisode(u, feed, ep, { notes = false } = {}) {
    const key = keyOf(feed.id, ep.id)
    const dl = own(state.downloads, key)
    const st = u && own(u.episodes, key)
    const out = {
      key, feedId: feed.id, feedTitle: feed.title || '', id: ep.id, title: ep.title, publishedAt: ep.publishedAt || 0, durationSec: ep.durationSec || 0,
      summary: ep.summary || '', image: ep.image || feed.image || '', season: ep.season, episode: ep.episode, episodeType: ep.episodeType, explicit: !!ep.explicit,
      sizeBytes: ep.sizeBytes || 0, link: ep.link || '',
      downloaded: !!dl, downloadPinned: !!(dl && dl.pinned), hasSilenceVariant: !!(dl && dl.silence),
      played: !!(st && st.done), progressSec: st ? st.pos || 0 : 0,
      inQueue: !!(u && u.queue.includes(key)),
      hasChapters: !!(ep.chaptersUrl || (ep.chapters && ep.chapters.length) || dl),
      stream: streamPath(key)
    }
    if (notes) { out.notesHtml = ep.notesHtml || ''; out.transcripts = ep.transcripts || [] }
    return out
  }

  // ----- feed refresh ----------------------------------------------------------------------
  const intervalMs = () => settings().refreshMinutes * 60000
  const jitter = (ms) => Math.round(ms * (0.9 + Math.random() * 0.2))

  function fromFetchError(err) {
    const code = err && err.code ? String(err.code) : 'network_error'
    const status = code === 'bad_url' || code === 'blocked_address' || code === 'blocked_private' ? 400 : code === 'unresolvable' ? 422 : 502
    return fail(status, code)
  }

  // Fetch and parse; changes nothing. Conditional GET when this show was fetched before.
  async function pull(feed, { force = false } = {}) {
    const headers = { Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5' }
    const haveEpisodes = !!feed.lastSuccessAt
    if (!force && haveEpisodes) {
      if (feed.etag) headers['If-None-Match'] = feed.etag
      if (feed.lastModified) headers['If-Modified-Since'] = feed.lastModified
    }
    let r
    try {
      r = await net.get(feed.url, { headers, maxBytes: FEED_MAX_BYTES, timeoutMs: 30000 })
    } catch (err) { throw fromFetchError(err) }
    if (r.status === 304) return { notModified: true }
    if (r.status < 200 || r.status >= 300) throw fail(502, 'http_' + r.status)
    const hash = sha1(r.body)
    if (!force && haveEpisodes && feed.contentHash === hash) return { unchanged: true, headers: r.headers }
    let parsed
    try {
      parsed = feedLib.parseFeed(r.body)
    } catch (err) {
      throw fail(422, err instanceof xmlLite.XmlError || err.code === 'not_a_podcast_feed' ? 'not_a_podcast_feed' : 'bad_feed')
    }
    return { parsed, hash, headers: r.headers }
  }

  // Applies a pull() to the feed record and its episode file. Returns { changed, newEpisodes }.
  function commit(feed, pulled) {
    const t = now()
    feed.lastCheckedAt = t
    feed.failures = 0
    feed.lastError = ''
    feed.nextCheckAt = t + jitter(intervalMs())
    if (pulled.notModified || pulled.unchanged) {
      if (pulled.unchanged && pulled.headers) { feed.etag = pulled.headers.etag || feed.etag || ''; feed.lastModified = pulled.headers['last-modified'] || feed.lastModified || '' }
      feed.lastSuccessAt = feed.lastSuccessAt || t
      saveSoon()
      return { changed: false, newEpisodes: 0 }
    }
    const { show, episodes } = pulled.parsed
    const old = loadEpisodes(feed.id)
    const oldIds = new Set(old.map((e) => e.id))
    const newEpisodes = episodes.filter((e) => !oldIds.has(e.id)).length
    // Episodes a feed has dropped stay while they are still downloaded, so they keep playing.
    const inFeed = new Set(episodes.map((e) => e.id))
    const kept = old.filter((e) => !inFeed.has(e.id) && own(state.downloads, keyOf(feed.id, e.id)))
    const merged = episodes.concat(kept).slice(0, feedLib.MAX_EPISODES_KEPT)
    saveEpisodes(feed.id, merged)
    Object.assign(feed, {
      title: show.title, author: show.author, description: show.description, link: show.link, image: show.image, language: show.language,
      explicit: show.explicit, categories: show.categories, showType: show.showType, newFeedUrl: show.newFeedUrl && show.newFeedUrl !== feed.url ? show.newFeedUrl : '',
      etag: pulled.headers.etag || '', lastModified: pulled.headers['last-modified'] || '', contentHash: pulled.hash, lastSuccessAt: t, lastChangedAt: t
    })
    saveNow()
    return { changed: true, newEpisodes }
  }

  function noteFailure(feed, err) {
    feed.lastCheckedAt = now()
    feed.failures = (feed.failures || 0) + 1
    feed.lastError = err && err.code ? String(err.code) : 'error'
    // 1x, 2x, 4x ... the normal interval, never longer than a day.
    feed.nextCheckAt = now() + Math.min(24 * 3600000, intervalMs() * Math.pow(2, Math.min(feed.failures, 6)))
    saveSoon()
  }

  const inflightRefresh = new Map()
  /** One show, now. Never throws for a fetch problem: the failure is recorded on the show. */
  function refreshFeed(feedId, { force = false } = {}) {
    const feed = own(state.feeds, feedId)
    if (!feed) return Promise.resolve({ ok: false, error: 'not_found' })
    if (inflightRefresh.has(feedId)) return inflightRefresh.get(feedId)
    const p = (async () => {
      try {
        const res = commit(feed, await pull(feed, { force }))
        try { await autoDownloadPass(feedId) } catch (err) { say(`podcasts: auto-download failed: ${err && err.code || err}`) }
        return { ok: true, ...res }
      } catch (err) {
        noteFailure(feed, err)
        say(`podcasts: refresh of "${feed.title || 'a show'}" failed: ${err && err.code || err}`)
        return { ok: false, error: err && err.code ? String(err.code) : 'error' }
      } finally {
        inflightRefresh.delete(feedId)
      }
    })()
    inflightRefresh.set(feedId, p)
    return p
  }

  let ticking = false
  /** The background pass: every show that has a subscriber and is due, a few at a time. */
  async function tick({ max = 20 } = {}) {
    if (ticking) return { refreshed: 0 }
    ticking = true
    try {
      const t = now()
      const due = Object.values(state.feeds)
        .filter((f) => subscribersOf(f.id).length && (f.nextCheckAt || 0) <= t)
        .sort((a, b) => (a.nextCheckAt || 0) - (b.nextCheckAt || 0))
        .slice(0, max)
      let refreshed = 0
      for (const f of due) {
        await refreshFeed(f.id, { force: !f.lastSuccessAt })
        refreshed++
      }
      if (!state.lastCleanupAt || t - state.lastCleanupAt > 6 * 3600000) await cleanup()
      return { refreshed }
    } finally {
      ticking = false
    }
  }

  let timer = null
  function start({ firstDelayMs = 45000, everyMs = 60000 } = {}) {
    if (timer) return
    const run = () => { tick().catch((err) => say(`podcasts: background pass failed: ${err && err.code || err}`)) }
    const first = setTimeout(run, firstDelayMs)
    if (first.unref) first.unref()
    timer = setInterval(run, everyMs)
    if (timer.unref) timer.unref()
    timer._first = first
  }
  async function stop() {
    if (timer) { clearInterval(timer); clearTimeout(timer._first); timer = null }
    saveNow()
  }

  // ----- subscriptions ---------------------------------------------------------------------
  function subscriptions(userId) {
    const u = userOf(userId, false)
    if (!u) return []
    return Object.keys(u.subs).map((id) => own(state.feeds, id)).filter(Boolean)
      .map((f) => shapeFeed(f, u))
      .sort((a, b) => a.title.localeCompare(b.title))
  }

  function addSub(u, feedId, autoDownload) {
    const max = settings().maxAutoDownload
    u.subs[feedId] = { addedAt: now(), autoDownload: clampInt(autoDownload, 0, max, 0) }
  }

  /** Subscribe by RSS address. Fetches the feed first, so a bad address is refused instead of saved. */
  async function subscribe(userId, rawUrl, { autoDownload = 0 } = {}) {
    const url = feedLib.normalizeFeedUrl(rawUrl)
    if (!url) throw fail(400, 'bad_url')
    const u = userOf(userId, true)
    const feedId = feedLib.feedIdFor(url)
    if (!own(u.subs, feedId) && Object.keys(u.subs).length >= MAX_SUBS_PER_USER) throw fail(409, 'too_many_subscriptions')
    let feed = own(state.feeds, feedId)
    if (!feed) {
      if (Object.keys(state.feeds).length >= MAX_FEEDS) throw fail(409, 'too_many_shows')
      const fresh = { id: feedId, url, title: '', addedAt: now(), addedBy: userId, failures: 0, nextCheckAt: 0 }
      commit(fresh, await pull(fresh, { force: true }))
      state.feeds[feedId] = feed = fresh
    }
    addSub(u, feedId, autoDownload)
    saveNow()
    autoDownloadPass(feedId).catch(() => {})
    return shapeFeed(feed, u)
  }

  function updateSubscription(userId, feedId, patch) {
    const u = needSubscription(userId, feedId)
    if (patch && patch.autoDownload !== undefined) u.subs[feedId].autoDownload = clampInt(patch.autoDownload, 0, settings().maxAutoDownload, 0)
    saveNow()
    autoDownloadPass(feedId).catch(() => {})
    return shapeFeed(state.feeds[feedId], u)
  }

  async function unsubscribe(userId, feedId) {
    const u = userOf(userId, false)
    if (!u || !subOf(u, feedId)) throw fail(404, 'not_found')
    delete u.subs[feedId]
    u.queue = u.queue.filter((k) => !k.startsWith(feedId + '.'))
    if (u.prefs && u.prefs.speedByFeed) delete u.prefs.speedByFeed[feedId]
    if (!subscribersOf(feedId).length) await dropFeed(feedId)
    saveNow()
    return { ok: true }
  }

  async function dropFeed(feedId) {
    delete state.feeds[feedId]
    episodeCache.delete(feedId)
    for (const key of Object.keys(state.downloads)) if (key.startsWith(feedId + '.')) delete state.downloads[key]
    for (const u of Object.values(state.users)) for (const key of Object.keys(u.episodes)) if (key.startsWith(feedId + '.')) delete u.episodes[key]
    await fsp.rm(path.join(root, 'downloads', feedId), { recursive: true, force: true }).catch(() => {})
    await fsp.rm(episodesFile(feedId), { force: true }).catch(() => {})
    await fsp.rm(episodesFile(feedId) + '.bak', { force: true }).catch(() => {})
  }

  /** Account deletion: their subscriptions, progress and queue. Shows nobody else follows go too. */
  async function removeUser(userId) {
    const u = userOf(userId, false)
    if (!u) return
    const feeds = Object.keys(u.subs)
    delete state.users[userId]
    for (const id of feeds) if (own(state.feeds, id) && !subscribersOf(id).length) await dropFeed(id)
    saveNow()
  }

  /** Apple's iTunes Search API, for discovery only: we keep the feed address, not their catalogue. */
  const searchCache = new Map()
  const searchHits = []
  async function search(userId, term, { country = 'US' } = {}) {
    const q = String(term || '').trim().slice(0, 100)
    if (q.length < 2) throw fail(400, 'query_too_short')
    const cc = /^[a-zA-Z]{2}$/.test(String(country)) ? String(country).toUpperCase() : 'US'
    const ck = cc + '|' + q.toLowerCase()
    const t = now()
    const cached = searchCache.get(ck)
    let results
    if (cached && t - cached.at < 10 * 60000) results = cached.results
    else {
      // Apple asks for roughly 20 calls a minute: stay well under it for the whole household.
      while (searchHits.length && t - searchHits[0] > 60000) searchHits.shift()
      if (searchHits.length >= 15) throw fail(429, 'rate_limited')
      searchHits.push(t)
      const url = 'https://itunes.apple.com/search?' + new URLSearchParams({ media: 'podcast', entity: 'podcast', limit: '25', country: cc, term: q }).toString()
      let r
      try { r = await publicNet.get(url, { headers: { Accept: 'application/json' }, maxBytes: 2 * MB, timeoutMs: 10000, allowHosts: ['itunes.apple.com'] }) } catch (err) { throw fromFetchError(err) }
      if (r.status !== 200) throw fail(502, 'directory_' + r.status)
      let json
      try { json = JSON.parse(r.body.toString('utf8')) } catch { throw fail(502, 'directory_bad_answer') }
      results = feedLib.parseItunesSearch(json)
      searchCache.set(ck, { at: t, results })
      if (searchCache.size > 100) searchCache.delete(searchCache.keys().next().value)
    }
    const u = userOf(userId, false)
    return results.map((r) => {
      const id = feedLib.feedIdFor(r.feedUrl)
      return { ...r, feedId: id, subscribed: !!subOf(u, id) }
    })
  }

  async function importOpml(userId, bytes) {
    let items
    try { items = feedLib.parseOpml(bytes) } catch (err) { throw fail(422, err instanceof xmlLite.XmlError || err.code === 'not_opml' ? 'not_opml' : 'bad_opml') }
    const u = userOf(userId, true)
    let added = 0
    let existing = 0
    let skipped = 0
    for (const it of items.slice(0, MAX_OPML_IMPORT)) {
      const feedId = feedLib.feedIdFor(it.xmlUrl)
      if (own(u.subs, feedId)) { existing++; continue }
      if (Object.keys(u.subs).length >= MAX_SUBS_PER_USER || (!own(state.feeds, feedId) && Object.keys(state.feeds).length >= MAX_FEEDS)) { skipped++; continue }
      if (!own(state.feeds, feedId)) {
        // Not fetched here (an import can be hundreds of shows): the background pass picks each up, oldest first.
        state.feeds[feedId] = { id: feedId, url: it.xmlUrl, title: it.title || '', link: it.htmlUrl || '', addedAt: now(), addedBy: userId, failures: 0, nextCheckAt: 0 }
      }
      addSub(u, feedId, 0)
      added++
    }
    saveNow()
    return { ok: true, added, existing, skipped, ignored: Math.max(0, items.length - MAX_OPML_IMPORT), total: items.length }
  }

  function exportOpml(userId) {
    const u = userOf(userId, false)
    const shows = u ? Object.keys(u.subs).map((id) => own(state.feeds, id)).filter(Boolean).map((f) => ({ title: f.title, url: f.url, link: f.link })) : []
    return feedLib.buildOpml(shows, { now: new Date(now()) })
  }

  // ----- listening state -------------------------------------------------------------------
  function pruneStates(u) {
    const keys = Object.keys(u.episodes)
    if (keys.length <= MAX_EPISODE_STATES) return
    keys.sort((a, b) => (u.episodes[a].updatedAt || 0) - (u.episodes[b].updatedAt || 0))
    for (const k of keys.slice(0, keys.length - MAX_EPISODE_STATES)) delete u.episodes[k]
  }

  /** The player reports where it is. Reaching the end (within 30s or 2%) marks the episode played. */
  function setProgress(userId, key, position, duration) {
    const hit = findEpisode(key)
    if (!hit) throw fail(404, 'not_found')
    const u = needSubscription(userId, hit.feed.id)
    const dur = Math.max(0, Math.min(Number(duration) || hit.ep.durationSec || 0, 48 * 3600))
    const pos = Math.max(0, Math.min(Number(position) || 0, dur || 48 * 3600))
    const prev = own(u.episodes, key) || {}
    const finished = dur > 60 && dur - pos <= Math.max(30, dur * 0.02)
    u.episodes[key] = { pos: finished ? 0 : Math.round(pos), dur: Math.round(dur), done: finished || !!prev.done, at: finished ? now() : prev.at || 0, updatedAt: now() }
    if (finished) u.queue = u.queue.filter((k) => k !== key)
    pruneStates(u)
    saveSoon()
    return { ok: true, played: u.episodes[key].done, progressSec: u.episodes[key].pos }
  }

  function markPlayed(userId, key, played) {
    const hit = findEpisode(key)
    if (!hit) throw fail(404, 'not_found')
    const u = needSubscription(userId, hit.feed.id)
    const prev = own(u.episodes, key) || {}
    u.episodes[key] = { pos: 0, dur: prev.dur || hit.ep.durationSec || 0, done: played !== false, at: played !== false ? now() : 0, updatedAt: now() }
    if (played !== false) u.queue = u.queue.filter((k) => k !== key)
    saveSoon()
    return { ok: true, played: played !== false }
  }

  function getEpisode(userId, key) {
    const hit = findEpisode(key)
    if (!hit) throw fail(404, 'not_found')
    return shapeEpisode(userOf(userId, false), hit.feed, hit.ep, { notes: true })
  }

  function episodes(userId, feedId, { offset = 0, limit = 50, unplayed = false, oldestFirst = false } = {}) {
    const feed = own(state.feeds, feedId)
    if (!feed) throw fail(404, 'not_found')
    const u = needSubscription(userId, feedId)
    let list = loadEpisodes(feedId)
    if (oldestFirst) list = list.slice().reverse()
    if (unplayed) list = list.filter((e) => !isDone(u, keyOf(feedId, e.id)))
    const off = clampInt(offset, 0, 1e6, 0)
    const lim = clampInt(limit, 1, 200, 50)
    return { feed: shapeFeed(feed, u), total: list.length, offset: off, episodes: list.slice(off, off + lim).map((e) => shapeEpisode(u, feed, e)) }
  }

  /** New episodes across everything this person follows, newest first. */
  function latest(userId, { limit = 30 } = {}) {
    const u = userOf(userId, false)
    if (!u) return []
    const all = []
    for (const feedId of Object.keys(u.subs)) {
      const feed = own(state.feeds, feedId)
      if (!feed) continue
      for (const e of loadEpisodes(feedId).slice(0, 25)) if (!isDone(u, keyOf(feedId, e.id))) all.push({ feed, e })
    }
    all.sort((a, b) => (b.e.publishedAt || 0) - (a.e.publishedAt || 0))
    return all.slice(0, clampInt(limit, 1, 100, 30)).map(({ feed, e }) => shapeEpisode(u, feed, e))
  }

  // Continue listening: things started and not finished, most recent first.
  function inProgress(userId, { limit = 20 } = {}) {
    const u = userOf(userId, false)
    if (!u) return []
    return Object.keys(u.episodes).filter((k) => u.episodes[k].pos > 5 && !u.episodes[k].done)
      .sort((a, b) => (u.episodes[b].updatedAt || 0) - (u.episodes[a].updatedAt || 0))
      .map((k) => findEpisode(k)).filter(Boolean).slice(0, clampInt(limit, 1, 50, 20))
      .map((h) => shapeEpisode(u, h.feed, h.ep))
  }

  // ----- the queue -------------------------------------------------------------------------
  function queueList(userId) {
    const u = userOf(userId, false)
    if (!u) return []
    return u.queue.map((k) => findEpisode(k)).filter(Boolean).map((h) => shapeEpisode(u, h.feed, h.ep))
  }
  function queueAdd(userId, key, { position, next = false } = {}) {
    const hit = findEpisode(key)
    if (!hit) throw fail(404, 'not_found')
    const u = needSubscription(userId, hit.feed.id)
    u.queue = u.queue.filter((k) => k !== key)
    if (u.queue.length >= MAX_QUEUE) throw fail(409, 'queue_full')
    const at = next ? 0 : Number.isInteger(position) ? Math.max(0, Math.min(position, u.queue.length)) : u.queue.length
    u.queue.splice(at, 0, key)
    saveSoon()
    return queueList(userId)
  }
  function queueRemove(userId, key) {
    const u = userOf(userId, false)
    if (u) { u.queue = u.queue.filter((k) => k !== key); saveSoon() }
    return queueList(userId)
  }
  function queueReorder(userId, order) {
    const u = userOf(userId, false)
    if (!u || !Array.isArray(order)) throw fail(400, 'bad_order')
    const have = new Set(u.queue)
    const wanted = order.filter((k, i) => have.has(k) && order.indexOf(k) === i)
    u.queue = wanted.concat(u.queue.filter((k) => !wanted.includes(k)))
    saveSoon()
    return queueList(userId)
  }
  function queueClear(userId) {
    const u = userOf(userId, false)
    if (u) { u.queue = []; saveSoon() }
    return []
  }

  // ----- listening preferences -------------------------------------------------------------
  function getPrefs(userId) {
    const u = userOf(userId, false)
    const p = (u && u.prefs) || { speed: 1, skipSilence: false, speedByFeed: {} }
    return { speed: clampSpeed(p.speed), skipSilence: !!p.skipSilence, speedByFeed: { ...(p.speedByFeed || {}) } }
  }
  function setPrefs(userId, patch = {}) {
    const u = userOf(userId, true)
    const p = u.prefs
    if (patch.speed !== undefined) p.speed = clampSpeed(patch.speed, p.speed)
    if (patch.skipSilence !== undefined) p.skipSilence = patch.skipSilence === true
    if (patch.feedId !== undefined && patch.feedSpeed !== undefined) {
      if (!FEED_ID_RE.test(String(patch.feedId))) throw fail(400, 'bad_feed')
      if (patch.feedSpeed === null) delete p.speedByFeed[patch.feedId]
      else p.speedByFeed[patch.feedId] = clampSpeed(patch.feedSpeed)
    }
    saveSoon()
    return getPrefs(userId)
  }

  // ----- downloads -------------------------------------------------------------------------
  const downloadsDir = (feedId) => path.join(root, 'downloads', feedId)
  const fileOf = (key, name) => path.join(downloadsDir(key.split('.')[0]), name)
  const totalBytes = () => Object.values(state.downloads).reduce((n, d) => n + (d.size || 0) + (d.silence ? d.silence.size || 0 : 0), 0)
  const dlStatus = new Map()
  const dlQueue = []
  let dlActive = 0
  const idleWaiters = []
  const DL_CONCURRENCY = 1

  function settleIdle() {
    if (!dlActive && !dlQueue.length && !silenceRunning && !silenceQueue.length) for (const w of idleWaiters.splice(0)) w()
  }
  const whenIdle = () => new Promise((resolve) => { idleWaiters.push(resolve); settleIdle() })

  /** Queue one episode for download. `pinned` = a person asked for it (kept until they remove it). */
  function queueDownload(key, { pinned = false, by = '' } = {}) {
    const hit = findEpisode(key)
    if (!hit) throw fail(404, 'not_found')
    if (settings().downloadCapMb <= 0) throw fail(409, 'downloads_off')
    const have = own(state.downloads, key)
    if (have) { if (pinned && !have.pinned) { have.pinned = true; have.by = by; saveSoon() } return { status: 'downloaded' } }
    // Queued or running: leave it. A failed one is tried again when someone asks (or the next auto pass).
    const cur = dlStatus.get(key)
    if (cur && cur.status !== 'failed') return { status: cur.status }
    dlStatus.set(key, { status: 'queued' })
    dlQueue.push({ key, pinned, by })
    setImmediate(pumpDownloads)
    return { status: 'queued' }
  }

  function pumpDownloads() {
    while (dlActive < DL_CONCURRENCY && dlQueue.length) {
      const job = dlQueue.shift()
      dlActive++
      dlStatus.set(job.key, { status: 'downloading' })
      runDownload(job).catch((err) => {
        dlStatus.set(job.key, { status: 'failed', error: err && err.code ? String(err.code) : 'error' })
        say(`podcasts: download failed: ${err && err.code || err}`)
      }).finally(() => { dlActive--; if (dlStatus.get(job.key) && dlStatus.get(job.key).status === 'downloading') dlStatus.delete(job.key); pumpDownloads(); settleIdle() })
    }
  }

  async function runDownload({ key, pinned, by }) {
    const hit = findEpisode(key)
    if (!hit) throw fail(404, 'not_found')
    const cfg = settings()
    const cap = cfg.downloadCapMb * MB
    const ext = extFor(hit.ep)
    const name = `${hit.ep.id}.${ext}`
    const expected = hit.ep.sizeBytes || 0
    if (totalBytes() + expected > cap) await cleanup({ needBytes: expected })
    if (totalBytes() + expected > cap) throw fail(507, 'cap_reached')
    const dest = fileOf(key, name)
    const r = await net.download(hit.ep.audioUrl, dest, { maxBytes: Math.min(cfg.maxEpisodeMb * MB, Math.max(MB, cap - totalBytes())), timeoutMs: 30 * 60000, accept: acceptMedia })
      .catch((err) => { throw err && err.code ? err : fail(502, 'download_failed') })
    state.downloads[key] = { file: name, ext, mime: MIME_BY_EXT[ext] || 'application/octet-stream', size: r.size, at: now(), pinned: !!pinned, by: pinned ? by : '' }
    dlStatus.delete(key)
    saveNow()
  }

  /** Auto-download: the newest N episodes of a show for whoever asked for N, skipping ones everyone has played. */
  async function autoDownloadPass(feedId) {
    for (const key of wantedAuto(feedId)) {
      if (own(state.downloads, key) || dlStatus.has(key)) continue
      try { queueDownload(key) } catch { break }
    }
  }
  function wantedAuto(feedId) {
    const feed = own(state.feeds, feedId)
    if (!feed) return []
    const interested = subscribersOf(feedId).map((id) => ({ id, u: state.users[id], n: Math.min(subOf(state.users[id], feedId).autoDownload || 0, settings().maxAutoDownload) })).filter((x) => x.n > 0)
    if (!interested.length) return []
    const eps = loadEpisodes(feedId)
    const out = []
    for (const { u, n } of interested) {
      for (const e of eps.slice(0, n)) {
        const key = keyOf(feedId, e.id)
        if (!isDone(u, key) && !out.includes(key)) out.push(key)
      }
    }
    return out
  }

  function keepSet() {
    const keep = new Set()
    for (const feedId of Object.keys(state.feeds)) for (const k of wantedAuto(feedId)) keep.add(k)
    for (const u of Object.values(state.users)) {
      for (const k of u.queue) keep.add(k)
      for (const k of Object.keys(u.episodes)) if (u.episodes[k].pos > 5 && !u.episodes[k].done) keep.add(k)
    }
    return keep
  }

  async function removeDownloadFiles(key, d) {
    await fsp.rm(fileOf(key, d.file), { force: true }).catch(() => {})
    if (d.silence) await fsp.rm(fileOf(key, d.silence.file), { force: true }).catch(() => {})
  }

  /**
   * Keeps the folder tidy: drops downloads nobody needs any more (not among the newest N of a show
   * someone auto-downloads, not queued, not half-played, not pinned), then, if the folder is still
   * over its cap, the least needed first: unneeded, then unpinned, then oldest published.
   */
  async function cleanup({ needBytes = 0 } = {}) {
    const keep = keepSet()
    let removed = 0
    let freed = 0
    const evict = async (key) => {
      const d = state.downloads[key]
      if (!d) return
      freed += (d.size || 0) + (d.silence ? d.silence.size || 0 : 0)
      delete state.downloads[key]
      await removeDownloadFiles(key, d)
      removed++
    }
    for (const key of Object.keys(state.downloads)) {
      const d = state.downloads[key]
      if (!findEpisode(key) || (!keep.has(key) && !d.pinned)) await evict(key)
      else if (!fs.existsSync(fileOf(key, d.file))) { delete state.downloads[key]; removed++ } // the file was removed outside the app
    }
    const cap = settings().downloadCapMb * MB
    let total = totalBytes()
    if (total + needBytes > cap) {
      const rank = (key) => {
        const hit = findEpisode(key)
        return [keep.has(key) ? 1 : 0, state.downloads[key].pinned ? 1 : 0, hit ? hit.ep.publishedAt || 0 : 0]
      }
      const order = Object.keys(state.downloads).sort((a, b) => {
        const ra = rank(a)
        const rb = rank(b)
        return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2]
      })
      for (const key of order) {
        if (total + needBytes <= cap) break
        const d = state.downloads[key]
        total -= (d.size || 0) + (d.silence ? d.silence.size || 0 : 0)
        await evict(key)
      }
    }
    state.lastCleanupAt = now()
    saveNow()
    return { removed, freedBytes: freed, totalBytes: totalBytes(), capBytes: cap }
  }

  async function removeDownload(userId, key) {
    const hit = findEpisode(key)
    if (!hit) throw fail(404, 'not_found')
    needSubscription(userId, hit.feed.id)
    const d = own(state.downloads, key)
    if (!d) return { ok: true }
    delete state.downloads[key]
    await removeDownloadFiles(key, d)
    saveNow()
    return { ok: true }
  }

  function downloadInfo(key) {
    const d = own(state.downloads, key)
    const s = dlStatus.get(key)
    return { downloaded: !!d, pinned: !!(d && d.pinned), size: d ? d.size : 0, status: d ? 'downloaded' : s ? s.status : 'none', error: s && s.error ? s.error : '', silence: d && d.silence ? { ready: true, size: d.silence.size } : { ready: false, status: (silenceJobs.get(key) || {}).status || 'none', error: (silenceJobs.get(key) || {}).error || '' } }
  }

  function requestDownload(userId, key) {
    const hit = findEpisode(key)
    if (!hit) throw fail(404, 'not_found')
    needSubscription(userId, hit.feed.id)
    // A person may keep a limited number of episodes pinned; the folder cap protects the disk overall.
    const pinnedNow = Object.keys(state.downloads).filter((k) => state.downloads[k].pinned && state.downloads[k].by === userId).length
    if (pinnedNow >= MAX_PINNED_PER_USER && !own(state.downloads, key)) throw fail(409, 'too_many_downloads')
    queueDownload(key, { pinned: true, by: userId })
    return downloadInfo(key)
  }

  /** Where the audio for an episode comes from: the downloaded file, or the publisher's own address. */
  function resolveAudio(key, { variant = '' } = {}) {
    const hit = findEpisode(key)
    if (!hit) return null
    const d = own(state.downloads, key)
    if (variant === 'nosilence') {
      if (!d || !d.silence || !fs.existsSync(fileOf(key, d.silence.file))) return { kind: 'missing' }
      return { kind: 'file', path: fileOf(key, d.silence.file), mime: 'audio/mp4', episode: hit.ep }
    }
    if (d && fs.existsSync(fileOf(key, d.file))) return { kind: 'file', path: fileOf(key, d.file), mime: d.mime, episode: hit.ep }
    return { kind: 'remote', url: hit.ep.audioUrl, mime: hit.ep.audioType || '', episode: hit.ep }
  }

  // ----- skip silence ----------------------------------------------------------------------
  const silenceJobs = new Map()
  const silenceQueue = []
  let silenceRunning = false

  /** Makes (in the background) a copy of a downloaded episode with the long pauses cut. One at a time. */
  function requestSilenceSkip(userId, key) {
    const hit = findEpisode(key)
    if (!hit) throw fail(404, 'not_found')
    needSubscription(userId, hit.feed.id)
    const d = own(state.downloads, key)
    if (!d) throw fail(409, 'download_first')
    if (d.silence) return downloadInfo(key)
    if (!ffmpegPath && !runFfmpeg) throw fail(501, 'no_ffmpeg')
    const j = silenceJobs.get(key)
    if (j && (j.status === 'queued' || j.status === 'running')) return downloadInfo(key)
    silenceJobs.set(key, { status: 'queued' })
    silenceQueue.push(key)
    setImmediate(pumpSilence)
    return downloadInfo(key)
  }

  async function pumpSilence() {
    if (silenceRunning) return
    const key = silenceQueue.shift()
    if (!key) { settleIdle(); return }
    silenceRunning = true
    silenceJobs.set(key, { status: 'running' })
    try {
      const d = own(state.downloads, key)
      if (!d) throw fail(404, 'not_found')
      const name = d.file.replace(/\.[a-z0-9]+$/, '') + '.ns.m4a'
      const out = fileOf(key, name)
      const tmp = out + '.part'
      const r = await ff(silenceArgs(fileOf(key, d.file), tmp), 30 * 60000)
      if (!r.ok) { await fsp.rm(tmp, { force: true }).catch(() => {}); throw fail(500, r.error === 'no_ffmpeg' ? 'no_ffmpeg' : 'silence_failed') }
      await fsp.rename(tmp, out)
      const st = await fsp.stat(out)
      if (!own(state.downloads, key)) { await fsp.rm(out, { force: true }).catch(() => {}); throw fail(404, 'not_found') }
      state.downloads[key].silence = { file: name, size: st.size }
      silenceJobs.delete(key)
      saveNow()
    } catch (err) {
      silenceJobs.set(key, { status: 'failed', error: err && err.code ? String(err.code) : 'error' })
      say(`podcasts: skip-silence failed: ${err && err.code || err}`)
    } finally {
      silenceRunning = false
      setImmediate(pumpSilence)
    }
  }

  // ----- chapters --------------------------------------------------------------------------
  async function chapters(userId, key) {
    const hit = findEpisode(key)
    if (!hit) throw fail(404, 'not_found')
    needSubscription(userId, hit.feed.id)
    const { ep } = hit
    const cacheFile = path.join(root, 'chapters', key + '.json')
    if (ep.chaptersUrl) {
      const cached = readJsonSafe(cacheFile, () => null)
      if (cached.data && Array.isArray(cached.data.chapters) && now() - (cached.data.fetchedAt || 0) < 24 * 3600000) return { source: 'json', chapters: cached.data.chapters }
      try {
        const r = await net.get(ep.chaptersUrl, { headers: { Accept: 'application/json+chapters, application/json;q=0.9, */*;q=0.5' }, maxBytes: 2 * MB, timeoutMs: 15000 })
        if (r.status === 200) {
          const list = feedLib.parseChaptersJson(r.body)
          if (list.length) {
            try { writeJsonAtomic(cacheFile, { fetchedAt: now(), chapters: list }, { indent: 0, backup: false }) } catch {}
            return { source: 'json', chapters: list }
          }
        }
      } catch (err) { say(`podcasts: chapters fetch failed: ${err && err.code || err}`) }
    }
    if (ep.chapters && ep.chapters.length) return { source: 'feed', chapters: ep.chapters }
    const d = own(state.downloads, key)
    if (d) {
      const list = await readId3Chapters(fileOf(key, d.file))
      if (list.length) return { source: 'id3', chapters: list }
    }
    return { source: 'none', chapters: [] }
  }

  // ----- settings + status -----------------------------------------------------------------
  function getSettings() { return settings() }
  function setSettings(patch) {
    const next = cleanSettings({ ...settings(), ...(patch && typeof patch === 'object' ? patch : {}) })
    store.set(SETTINGS_KEY, next)
    return next
  }
  function status() {
    const cfg = settings()
    return {
      settings: cfg,
      shows: Object.keys(state.feeds).length,
      downloads: { count: Object.keys(state.downloads).length, bytes: totalBytes(), capBytes: cfg.downloadCapMb * MB, active: dlActive + dlQueue.length },
      ffmpeg: !!(ffmpegPath || runFfmpeg),
      lastCleanupAt: state.lastCleanupAt || 0
    }
  }
  async function refreshAll({ force = false } = {}) {
    let refreshed = 0
    for (const f of Object.values(state.feeds)) {
      if (!subscribersOf(f.id).length) continue
      await refreshFeed(f.id, { force })
      refreshed++
    }
    return { refreshed }
  }

  if (autoStart) start()

  return {
    // shows
    subscribe, updateSubscription, unsubscribe, subscriptions, search, importOpml, exportOpml, refreshFeed, refreshAll, tick, start, stop, removeUser,
    // episodes and listening state
    episodes, latest, inProgress, getEpisode, setProgress, markPlayed, chapters,
    queueList, queueAdd, queueRemove, queueReorder, queueClear, getPrefs, setPrefs,
    // audio
    resolveAudio, openRemote: (url, headers) => net.open(url, { headers, timeoutMs: 20000 }), requestDownload, removeDownload, downloadInfo, requestSilenceSkip, cleanup, whenIdle,
    // admin
    getSettings, setSettings, status, saveNow,
    isSubscribed: (userId, feedId) => !!subOf(userOf(userId, false), feedId),
    keyFor: keyOf, findEpisode: (key) => findEpisode(key), root,
    _state: state
  }
}

module.exports = { createPodcasts, clampSpeed, cleanSettings, silenceArgs, DEFAULT_SETTINGS, KEY_RE, FEED_ID_RE, SPEED_MIN, SPEED_MAX }
