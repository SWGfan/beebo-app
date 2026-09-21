'use strict'
// ============================================================================
// cinemaMode.js - CINEMA MODE: a movie-theatre style pre-show before the feature.
// ----------------------------------------------------------------------------
// Off by default, per person. When a person has turned it on (or picked "Play with pre-show" for one
// film) the player asks GET /api/playback/preroll?kind=movie&id=<id> for an ordered list:
//     [ optional intro/bumper ("Feature Presentation"), then 0-5 trailers ]
// The trailers are chosen for THIS viewer and THIS feature (see pickTrailers):
//   tier "local"   a trailer FILE next to a library title (Jellyfin / Plex / Kodi conventions) or in
//                  the owner's Cinema folder; played from this computer.
//   tier "owned"   an unwatched title the person OWNS whose trailer is found through TMDB; played
//                  through YouTube's own embedded player.
//   tier "online"  an official trailer of a TMDB "recommended / similar" title; same embed rule.
// Rules that always apply, in this order:
//   * parental controls: a restricted profile never gets a trailer above its limit, an unrated one, or
//     one in a blocked genre / title / collection (parentalControls.decide, made STRICTER: unrated = no);
//   * theatre etiquette: a trailer is never rated above the feature (G before G/PG only, no horror
//     before a family film);
//   * no repeats within N days (per person, remembered by trailer AND by title);
//   * offline / no TMDB key: online tiers quietly give nothing, local ones still play.
// Legal line (read docs/CINEMA-MODE.md): this file NEVER fetches, caches, downloads or re-streams a
// YouTube video. It only hands out an 11-character video id; the browser plays it in YouTube's
// official IFrame player. Local trailers are files the owner already has.
//
// Wiring in streamServer.js is two one-liners (routes) + the player page includes cinemaModeWeb.js.
// Settings live in the store: cinemaConfig (owner), cinemaPrefs[viewer] (each person), cinemaShown.
// ============================================================================

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const parental = require('./parentalControls')
const cinemaOnline = require('./cinemaOnline')
const fileServe = require('./fileServe')

// ------------------------------------------------------------------ constants

const DAY_MS = 24 * 60 * 60 * 1000
const MAX_TRAILERS = 5
const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/
// What a browser can play without a conversion. (No .mkv/.avi: the pre-show is never transcoded.)
const PLAYABLE_EXT = new Set(['.mp4', '.m4v', '.webm', '.mov', '.ogv'])
const MIME = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.ogv': 'video/ogg' }
const HORROR = 27
const FAMILY_MAX_LEVEL = 1 // G and PG on parentalControls' movie scale
const KEY_RE = /^[a-z]:[A-Za-z0-9_-]{1,80}$/
const HISTORY_CAP = 400
const ATTRIBUTION_YOUTUBE = 'Trailer from YouTube, played in YouTube\'s embedded player. Movie information from TMDB.'
const ATTRIBUTION_LOCAL = 'A video file on this computer.'
const ATTRIBUTION_INTRO = 'Your own intro clip.'

// ------------------------------------------------------------------ small helpers

const hash = (s, n = 20) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, n)
const clampInt = (v, lo, hi, dflt) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt }
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

function plainText(value, max = 120) {
  // eslint-disable-next-line no-control-regex
  const s = String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max).trim() : s
}

/** A tiny seeded PRNG so a given viewer+film+day picks the same trailers (and tests are exact). */
function seededRandom(seedText) {
  let a = parseInt(hash(seedText, 8), 16) >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '')
const extOf = (name) => path.extname(String(name || '')).toLowerCase()
const stemOf = (name) => path.basename(String(name || ''), extOf(name))
const isPlayableVideo = (name) => PLAYABLE_EXT.has(extOf(name))

// ------------------------------------------------------------------ settings

const DEFAULT_PREFS = Object.freeze({
  enabled: false, neverShow: false, count: 2, useIntro: true,
  sources: { local: true, owned: true, online: true },
  dedupeDays: 30, oncePerNight: false, nightGapHours: 6, matchFeatureRating: true
})

/** Anything stored or posted -> a complete, safe per-person setting. */
function normalizePrefs(raw) {
  const r = isObj(raw) ? raw : {}
  const s = isObj(r.sources) ? r.sources : {}
  return {
    enabled: r.enabled === true,
    neverShow: r.neverShow === true,
    count: clampInt(r.count, 0, MAX_TRAILERS, DEFAULT_PREFS.count),
    useIntro: r.useIntro !== false,
    sources: { local: s.local !== false, owned: s.owned !== false, online: s.online !== false },
    dedupeDays: clampInt(r.dedupeDays, 0, 365, DEFAULT_PREFS.dedupeDays),
    oncePerNight: r.oncePerNight === true,
    nightGapHours: clampInt(r.nightGapHours, 1, 24, DEFAULT_PREFS.nightGapHours),
    matchFeatureRating: r.matchFeatureRating !== false
  }
}

const DEFAULT_CONFIG = Object.freeze({ available: true, folder: '', introFile: '', allowOnline: true, maxTrailers: MAX_TRAILERS, maxTrailerSeconds: 240 })

/** A bare file name (no folders) with a playable extension, or ''. */
function safeIntroName(name) {
  const n = typeof name === 'string' ? name.trim() : ''
  if (!n || n.length > 200 || n !== path.basename(n) || /[\\/:*?"<>|\u0000-\u001f]/.test(n) || n.startsWith('.')) return ''
  return isPlayableVideo(n) ? n : ''
}

/** The owner's server-wide settings. */
function normalizeConfig(raw) {
  const r = isObj(raw) ? raw : {}
  return {
    available: r.available !== false,
    folder: typeof r.folder === 'string' && r.folder.length < 1024 && !r.folder.includes('\u0000') ? r.folder.trim() : '',
    introFile: safeIntroName(r.introFile),
    allowOnline: r.allowOnline !== false,
    maxTrailers: clampInt(r.maxTrailers, 0, MAX_TRAILERS, MAX_TRAILERS),
    maxTrailerSeconds: clampInt(r.maxTrailerSeconds, 30, 600, DEFAULT_CONFIG.maxTrailerSeconds)
  }
}

const viewerKeyOf = (userId, profile) => (profile ? `${userId}:${String(profile).slice(0, 64)}` : String(userId))

function readMap(store, key) {
  try { const v = store.get(key); return isObj(v) ? v : {} } catch { return {} }
}
const getConfig = (store) => { let v = null; try { v = store.get('cinemaConfig') } catch { v = null } return normalizeConfig(v) }
function setConfig(store, patch) {
  const next = normalizeConfig({ ...getConfig(store), ...(isObj(patch) ? patch : {}) })
  store.set('cinemaConfig', next)
  return next
}
function getPrefs(store, userId, profile) {
  const all = readMap(store, 'cinemaPrefs')
  return normalizePrefs(all[viewerKeyOf(userId, profile)] || (profile ? all[String(userId)] : null))
}
function setPrefs(store, userId, profile, patch) {
  const all = { ...readMap(store, 'cinemaPrefs') }
  const cur = getPrefs(store, userId, profile)
  const p = isObj(patch) ? patch : {}
  const merged = { ...cur, ...p, sources: { ...cur.sources, ...(isObj(p.sources) ? p.sources : {}) } }
  const next = normalizePrefs(merged)
  all[viewerKeyOf(userId, profile)] = next
  const keys = Object.keys(all)
  if (keys.length > 500) for (const k of keys.slice(0, keys.length - 500)) delete all[k]
  store.set('cinemaPrefs', all)
  return next
}

/**
 * Is a pre-show wanted for this play? `param` is the one-off choice from the Movie page
 * ('1' = with pre-show, '0' = without); it never beats "never show trailers".
 */
function decideEnabled({ config, prefs, param, resuming = false, lastPreshowAt = 0, now = Date.now(), isGuest = false }) {
  if (isGuest) return { enabled: false, reason: 'guest' }
  if (!config.available) return { enabled: false, reason: 'unavailable' }
  if (prefs.neverShow) return { enabled: false, reason: 'never' }
  if (param === '0') return { enabled: false, reason: 'off_this_time' }
  if (param === '1') return { enabled: true, reason: 'asked' }
  if (!prefs.enabled) return { enabled: false, reason: 'disabled' }
  if (resuming) return { enabled: false, reason: 'resuming' }
  if (prefs.oncePerNight && lastPreshowAt && now - lastPreshowAt < prefs.nightGapHours * 3600 * 1000) return { enabled: false, reason: 'once_per_night' }
  return { enabled: true, reason: 'on' }
}

// ------------------------------------------------------------------ "shown" log (no repeats)

function createShownLog(store, { now = () => Date.now() } = {}) {
  const all = () => readMap(store, 'cinemaShown')
  const entry = (a, key) => (isObj(a[key]) ? a[key] : { last: 0, items: [] })
  return {
    /** Set of item keys and title keys shown to this person within `days`. */
    recent(viewerKey, days) {
      if (!days) return new Set()
      const e = entry(all(), viewerKey)
      const since = now() - days * DAY_MS
      return new Set((Array.isArray(e.items) ? e.items : []).filter((x) => x && typeof x.at === 'number' && x.at >= since).map((x) => x.k))
    },
    lastPreshowAt(viewerKey) { return Number(entry(all(), viewerKey).last) || 0 },
    /** keys: strings already validated against KEY_RE. */
    record(viewerKey, keys, { preshow = true } = {}) {
      const a = { ...all() }
      const e = entry(a, viewerKey)
      const at = now()
      const items = (Array.isArray(e.items) ? e.items : []).filter((x) => x && KEY_RE.test(String(x.k)))
      for (const k of keys) items.push({ k, at })
      a[viewerKey] = { last: preshow ? at : Number(e.last) || 0, items: items.slice(-HISTORY_CAP) }
      const ids = Object.keys(a)
      if (ids.length > 500) for (const k of ids.slice(0, ids.length - 500)) delete a[k]
      try { store.set('cinemaShown', a) } catch { /* a lost dedupe entry only allows one repeat */ }
    },
    forget(viewerKey) {
      const a = { ...all() }
      delete a[viewerKey]
      try { store.set('cinemaShown', a) } catch { /* nothing to do */ }
    }
  }
}

// ------------------------------------------------------------------ local trailer discovery

const TRAILER_MARK = /(^|[\s._\-[(])(trailer|teaser)\d*[\])]?$/i
const isTrailerFileName = (name) => TRAILER_MARK.test(stemOf(name)) || /^(trailer|teaser)\d*$/i.test(stemOf(name))
const stripTrailerMark = (stem) => String(stem).replace(TRAILER_MARK, '').replace(/[\s._\-[(]+$/, '')

/** Regular (non-symlink) entries of one folder; never throws. */
function listFolder(dir, fsImpl) {
  try {
    return fsImpl.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e && typeof e.name === 'string' && (e.isFile() || e.isDirectory()))
      .map((e) => ({ name: e.name, dir: e.isDirectory() }))
  } catch { return [] }
}

/**
 * Local trailer lookup for library films, from folder listings read once.
 *   <film>-trailer.mp4  <film>_trailer  <film>.trailer  <film> - Trailer  (Kodi / Jellyfin / Plex)
 *   trailers/<film>[-trailer].mp4   (a shared "trailers" folder, matched by name)
 *   <film>/Trailer.mp4  <film>/<anything>-trailer.mp4  <film>/trailers/*.mp4   (one folder per film)
 * Only browser-playable containers count. Symlinks are ignored.
 */
function buildTrailerIndex(dirs, { fsImpl = fs } = {}) {
  const cache = new Map()
  const load = (dir) => {
    if (!cache.has(dir)) cache.set(dir, listFolder(dir, fsImpl))
    return cache.get(dir)
  }
  const sub = (dir, name) => path.join(dir, name)
  const findDir = (dir, wanted) => load(dir).find((e) => e.dir && e.name.toLowerCase() === wanted)
  return {
    roots: (Array.isArray(dirs) ? dirs : []).filter(Boolean),
    forMovie(fileName, dir) {
      const nb = norm(stemOf(fileName))
      if (!dir || nb.length < 1) return []
      const found = []
      const add = (d, name) => { const p = path.join(d, name); if (!found.includes(p)) found.push(p) }
      // 1. next to the film
      for (const e of load(dir)) {
        if (e.dir || e.name === fileName || !isPlayableVideo(e.name) || !TRAILER_MARK.test(stemOf(e.name))) continue
        if (norm(stripTrailerMark(stemOf(e.name))) === nb) add(dir, e.name)
      }
      // 2. a shared trailers/ folder
      const shared = findDir(dir, 'trailers') || findDir(dir, 'trailer')
      if (shared) {
        const sd = sub(dir, shared.name)
        for (const e of load(sd)) {
          if (e.dir || !isPlayableVideo(e.name)) continue
          const n = norm(stripTrailerMark(stemOf(e.name)))
          if (n === nb || (nb.length >= 4 && n.startsWith(nb))) add(sd, e.name)
        }
      }
      // 3. one folder per film: <dir>/<film>/Trailer.mp4 and <dir>/<film>/trailers/*
      const own = load(dir).find((e) => e.dir && norm(e.name) === nb)
      if (own) {
        const od = sub(dir, own.name)
        for (const e of load(od)) {
          if (e.dir || !isPlayableVideo(e.name)) continue
          if (isTrailerFileName(e.name)) add(od, e.name)
        }
        const t = findDir(od, 'trailers') || findDir(od, 'trailer')
        if (t) for (const e of load(sub(od, t.name))) if (!e.dir && isPlayableVideo(e.name)) add(sub(od, t.name), e.name)
      }
      return found.sort().slice(0, 3)
    }
  }
}

/** '[PG-13]' or '(R)' inside a Cinema-folder file name -> that certification (lets the owner label a trailer). */
function certFromName(name) {
  const m = /[[(]\s*(G|PG|PG-13|R|NC-17|TV-Y7|TV-Y|TV-G|TV-PG|TV-14|TV-MA|NR)\s*[\])]/i.exec(String(name || ''))
  return m ? m[1].toUpperCase() : null
}

/** Files in the Cinema folder: intros (folder root + Intros/) and generic trailers (Trailers/). */
function listCinemaFolder(folder, { fsImpl = fs } = {}) {
  const out = { intros: [], trailers: [] }
  if (!folder) return out
  const names = (dir) => listFolder(dir, fsImpl).filter((e) => !e.dir && isPlayableVideo(e.name) && !e.name.startsWith('.')).map((e) => e.name)
  const root = listFolder(folder, fsImpl)
  out.intros = names(folder).map((n) => ({ name: n, path: path.join(folder, n) }))
  for (const e of root) {
    if (!e.dir) continue
    const low = e.name.toLowerCase()
    const d = path.join(folder, e.name)
    if (low === 'intros' || low === 'intro') for (const n of names(d)) out.intros.push({ name: n, path: path.join(d, n) })
    if (low === 'trailers' || low === 'trailer') for (const n of names(d)) out.trailers.push({ name: n, path: path.join(d, n) })
  }
  return out
}

// ------------------------------------------------------------------ rating rules + scoring

const levelOfCert = (cert) => parental.levelOf('movie', cert, 'US')

/**
 * May this candidate be shown to this viewer, before this feature?
 *   ctx: { policy, restricted, featureLevel, matchFeatureRating }
 * -> { ok: true } | { ok: false, reason }
 */
function evaluateCandidate(cand, ctx) {
  const kind = cand.kind === 'tv' ? 'tv' : 'movie'
  const info = { kind, id: cand.id, tmdbId: cand.tmdbId, certification: cand.certification, genres: cand.genres || [], collectionId: cand.collectionId }
  if (ctx.restricted) {
    // A trailer must not be a way round the limits: an unreadable rating is refused, always.
    const d = parental.decide({ ...ctx.policy, blockUnrated: true }, info)
    if (!d.allowed) return { ok: false, reason: 'parental_' + d.reason }
  }
  const level = levelOfCert(cand.certification)
  const fl = ctx.featureLevel
  if (ctx.matchFeatureRating !== false && fl !== null && fl !== undefined) {
    if (level === null && fl <= FAMILY_MAX_LEVEL) return { ok: false, reason: 'unrated_for_family_feature' }
    if (level !== null && level > fl) return { ok: false, reason: 'above_feature' }
    if (fl <= FAMILY_MAX_LEVEL && (cand.genres || []).includes(HORROR)) return { ok: false, reason: 'horror_for_family_feature' }
  }
  return { ok: true }
}

/** Higher = a better neighbour for this feature: shared genres, near decade, near rating, a little luck. */
function scoreCandidate(cand, feature, rng = Math.random) {
  const fg = new Set(feature.genres || [])
  const cg = new Set(cand.genres || [])
  const union = new Set([...fg, ...cg]).size
  let shared = 0
  for (const g of cg) if (fg.has(g)) shared++
  let score = union ? (3 * shared) / union : 0
  if (feature.year && cand.year) {
    const gap = Math.abs(feature.year - cand.year)
    score += gap <= 5 ? 1 : gap <= 10 ? 0.6 : gap <= 20 ? 0.25 : 0
  }
  const fl = levelOfCert(feature.certification)
  const cl = levelOfCert(cand.certification)
  if (fl !== null && cl !== null) score += Math.abs(fl - cl) === 0 ? 1 : Math.abs(fl - cl) === 1 ? 0.5 : 0
  return score + rng() * 0.5
}

// ------------------------------------------------------------------ the picker

const validCandidate = (c) => !!c && ((c.local && typeof c.local.path === 'string' && c.local.path) || (typeof c.youtubeKey === 'string' && YT_ID_RE.test(c.youtubeKey)))

/**
 * Chooses up to `count` trailers, taking one from each enabled tier in turn (local, owned, online) so a
 * night is varied, best-scoring first inside a tier. Pure apart from `resolve` (the network step).
 *   tiers    { local: [cand], owned: [cand], online: [cand] }   already score-sorted
 *   resolve  async (cand) => cand with youtubeKey (and certification/genres) | null   (owned/online only)
 *   evaluate (cand) => { ok, reason }
 *   recent   Set of keys/title keys not to repeat
 * -> { picked: [cand], skipped: [{ title, reason }], probes }
 */
async function pickTrailers({ tiers, order = ['local', 'owned', 'online'], count, evaluate, resolve, recent = new Set(), maxProbes = 10, timeUp = () => false }) {
  const picked = []
  const skipped = []
  const takenTitles = new Set()
  const cursors = {}
  for (const t of order) cursors[t] = 0
  let probes = 0
  const note = (c, reason) => { if (skipped.length < 40) skipped.push({ title: c.title || '', reason }) }

  async function nextFrom(tier) {
    const list = tiers[tier] || []
    while (cursors[tier] < list.length) {
      let c = list[cursors[tier]++]
      if (recent.has(c.key) || recent.has(c.titleKey)) { note(c, 'recent'); continue }
      if (takenTitles.has(c.titleKey)) continue
      if (!validCandidate(c)) {
        if (!resolve || tier === 'local') { note(c, 'no_trailer'); continue }
        if (probes >= maxProbes || timeUp()) { cursors[tier] = list.length; return null }
        probes++
        let r = null
        try { r = await resolve(c) } catch { r = null }
        if (!r || !validCandidate(r)) { note(c, 'no_trailer'); continue }
        c = r
      }
      const ev = evaluate(c)
      if (!ev.ok) { note(c, ev.reason); continue }
      return c
    }
    return null
  }

  while (picked.length < count) {
    let progressed = false
    for (const tier of order) {
      if (picked.length >= count) break
      const c = await nextFrom(tier)
      if (c) { picked.push(c); takenTitles.add(c.titleKey); progressed = true }
    }
    if (!progressed) break
  }
  return { picked, skipped, probes }
}

// ------------------------------------------------------------------ the service

const readJsonBody = (req, limit = 16 * 1024) => new Promise((resolve) => {
  let size = 0
  const chunks = []
  let over = false
  req.on('data', (c) => {
    if (over) return // too big: swallow the rest (the caller answers 400) rather than cut the connection mid-request
    size += c.length
    if (size > limit) { over = true; chunks.length = 0; resolve(null); return }
    chunks.push(c)
  })
  req.on('end', () => { if (over) return; try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { resolve(null) } })
  req.on('error', () => resolve(null))
})

/**
 * deps:
 *   store                     settings store (get/set)
 *   getMovieDirs()            every library movie folder
 *   listOwned(userId)         [{ id, fileName, dir, watched, tmdbId?, meta? | getMeta() }]  meta: { tmdbId, title, year, genres, certification, collectionId }
 *                             (getMeta is only called for the films actually considered, so a big library stays cheap)
 *   resolveFeature(kind, id)  { fileName, dir, meta } | null   what is about to be played
 *   getApi()                  TMDB client (titleMatch.createTmdbApi) or null
 *   getCacheDir()             TMDB cache folder (optional)
 *   getPolicy(userId)         parental policy (default: parentalControls.getPolicy)
 *   sign(id) / check(id, token)   media-token helpers (streamServer's makeMediaToken / checkMediaToken)
 *   probeDuration(file)       async seconds | null   (optional)
 *   now, random, fsImpl, budgetMs, online (a ready cinemaOnline source, for tests)
 */
function createCinemaService(deps) {
  const {
    store, getMovieDirs = () => [], listOwned = () => [], resolveFeature = () => null, getApi = () => null,
    getCacheDir = () => null, sign = () => '', check = () => false, probeDuration = null,
    now = () => Date.now(), fsImpl = fs, budgetMs = 4500
  } = deps
  const getPolicy = deps.getPolicy || ((userId) => parental.getPolicy(store, userId))
  const online = deps.online || cinemaOnline.createOnlineSource({ getApi, getCacheDir, now })
  const shown = createShownLog(store, { now })
  const registry = new Map() // file id -> { path, root }
  const durations = new Map() // path|mtime -> seconds
  const hits = new Map() // userId -> [timestamps] (rate limit for the network steps)

  const config = () => getConfig(store)
  const defaultDir = () => { try { const v = store.get('cinemaDefaultDir'); return typeof v === 'string' ? v : '' } catch { return '' } }
  const cinemaFolder = () => config().folder || defaultDir()

  function networkAllowed(userId) {
    const t = now()
    const list = (hits.get(userId) || []).filter((x) => t - x < 60000)
    if (list.length >= 8) { hits.set(userId, list); return false }
    list.push(t)
    hits.set(userId, list)
    return true
  }

  // ---- served files ----
  function insideRoot(file, root) {
    try {
      const f = fsImpl.realpathSync(file)
      const r = fsImpl.realpathSync(root)
      const cmp = (p) => (process.platform === 'win32' ? p.toLowerCase() : p)
      const rr = cmp(r).endsWith(path.sep) ? cmp(r) : cmp(r) + path.sep
      return cmp(f).startsWith(rr)
    } catch { return false }
  }
  /** Hands out /cinema/media/<id>?mt=<token> for a file under a library folder or the Cinema folder. */
  function register(file) {
    if (!isPlayableVideo(file)) return null
    const roots = [...getMovieDirs(), cinemaFolder()].filter(Boolean)
    const root = roots.find((r) => insideRoot(file, r))
    if (!root) return null
    try { if (!fsImpl.statSync(file).isFile()) return null } catch { return null }
    const id = hash(path.resolve(file))
    registry.delete(id)
    registry.set(id, { path: file, root })
    while (registry.size > 1500) registry.delete(registry.keys().next().value)
    return { id, url: `/cinema/media/${id}?mt=${encodeURIComponent(sign('cinema:' + id))}` }
  }
  async function durationOf(file) {
    if (!probeDuration) return null
    let key = file
    try { key = file + '|' + fsImpl.statSync(file).mtimeMs } catch { return null }
    if (durations.has(key)) return durations.get(key)
    let sec = null
    try {
      const v = await Promise.race([probeDuration(file), new Promise((r) => setTimeout(() => r(null), 2500))])
      sec = Number.isFinite(v) && v > 0 && v < 3600 ? Math.round(v) : null
    } catch { sec = null }
    if (sec !== null) durations.set(key, sec)
    return sec
  }

  // ---- candidates ----
  const MAX_OWNED_CONSIDERED = 300
  function ownedCandidates(rowsAll, feature, index, prefs, rng) {
    let rows = []
    for (const o of rowsAll) {
      if (!o || !o.fileName || o.watched) continue
      if (o.fileName === feature.fileName || isTrailerFileName(o.fileName)) continue
      const tid = o.tmdbId || (o.meta && o.meta.tmdbId) || null
      if (feature.tmdbId && tid === feature.tmdbId) continue
      rows.push(o)
    }
    if (rows.length > MAX_OWNED_CONSIDERED) {
      // A big library: a seeded sample, so the same person + film + day is stable and the work stays bounded.
      rows = rows.map((o) => ({ o, r: rng() })).sort((a, b) => a.r - b.r).slice(0, MAX_OWNED_CONSIDERED).map((x) => x.o)
    }
    rows = rows.map((o) => { let m = o.meta; if (!m && typeof o.getMeta === 'function') { try { m = o.getMeta() } catch { m = null } } return { ...o, meta: m || {} } })
    const local = []
    const owned = []
    for (const o of rows) {
      const m = o.meta || {}
      const base = {
        kind: 'movie', id: o.id, fileName: o.fileName, tmdbId: m.tmdbId || null, title: plainText(m.title || stemOf(o.fileName)),
        year: m.year || null, genres: Array.isArray(m.genres) ? m.genres : [], certification: m.certification || null, collectionId: m.collectionId || null,
        titleKey: m.tmdbId ? `t:m${m.tmdbId}` : `f:${hash(o.fileName, 16)}`
      }
      const files = prefs.sources.local ? index.forMovie(o.fileName, o.dir) : []
      if (files.length) local.push({ ...base, tier: 'local', local: { path: files[0] }, key: `l:${hash(files[0], 16)}` })
      else if (prefs.sources.owned && base.tmdbId) owned.push({ ...base, tier: 'owned', local: null, youtubeKey: null, key: `y:t${base.tmdbId}` })
    }
    return { local, owned }
  }

  function bankCandidates(prefs) {
    if (!prefs.sources.local) return []
    return listCinemaFolder(cinemaFolder(), { fsImpl }).trailers.map((f) => ({
      tier: 'local', kind: 'movie', tmdbId: null, title: plainText(stemOf(f.name).replace(/\s*[[(][^\])]*[\])]\s*/g, ' ')) || 'Trailer',
      year: null, genres: [], certification: certFromName(f.name), collectionId: null, local: { path: f.path },
      key: `l:${hash(f.path, 16)}`, titleKey: `b:${hash(f.path, 16)}`
    }))
  }

  async function onlineTier(feature, ownedTmdb) {
    if (!online.hasKey()) return []
    const seeds = feature.tmdbId ? await online.related(feature.tmdbId) : []
    const rows = seeds.length ? seeds : await online.popular()
    return rows.filter((s) => !ownedTmdb.has(s.tmdbId) && s.tmdbId !== feature.tmdbId).map((s) => ({
      tier: 'online', kind: 'movie', tmdbId: s.tmdbId, title: s.title, year: s.year, genres: [], certification: null, collectionId: null,
      local: null, youtubeKey: null, key: `y:t${s.tmdbId}`, titleKey: `t:m${s.tmdbId}`, seedRank: s.popularity || 0
    }))
  }

  const toItem = async (c) => {
    if (c.local) {
      const reg = register(c.local.path)
      if (!reg) return null
      return { type: 'local', role: 'trailer', url: reg.url, title: c.title, durationSec: await durationOf(c.local.path), attribution: ATTRIBUTION_LOCAL, key: c.key, titleKey: c.titleKey }
    }
    return { type: 'youtube', role: 'trailer', videoId: c.youtubeKey, title: c.title, durationSec: null, attribution: ATTRIBUTION_YOUTUBE, key: `y:${c.youtubeKey}`, titleKey: c.titleKey }
  }

  async function introItem() {
    const cfg = config()
    if (!cfg.introFile) return null
    const file = path.join(cinemaFolder() || '', cfg.introFile)
    const inFolder = listCinemaFolder(cinemaFolder(), { fsImpl }).intros.find((f) => f.name === cfg.introFile)
    const target = inFolder ? inFolder.path : file
    const reg = cinemaFolder() ? register(target) : null
    if (!reg) return null
    return { type: 'local', role: 'intro', url: reg.url, title: plainText(stemOf(cfg.introFile)) || 'Feature Presentation', durationSec: await durationOf(target), attribution: ATTRIBUTION_INTRO, key: `i:${hash(target, 16)}` }
  }

  // ---- the answer ----

  /** GET /api/playback/preroll. Never throws: any failure is "no pre-show". */
  async function preroll({ userId, profile = '', kind = 'movie', id = '', param = '', resuming = false, isGuest = false }) {
    const cfg = config()
    const prefs = getPrefs(store, userId, profile)
    const vk = viewerKeyOf(userId, profile)
    // `wants` = this person has Cinema Mode on (the player remembers it to hold the feature at once next time).
    const base = { ok: true, skipAllowed: true, wants: !!(prefs.enabled && !prefs.neverShow && cfg.available), maxTrailerSeconds: cfg.maxTrailerSeconds, tmdbAttribution: cinemaOnline.TMDB_ATTRIBUTION }
    const off = (reason) => ({ ...base, enabled: false, reason, items: [] })
    const decision = decideEnabled({ config: cfg, prefs, param, resuming, lastPreshowAt: shown.lastPreshowAt(vk), now: now(), isGuest })
    if (!decision.enabled) return off(decision.reason)
    if (kind !== 'movie') return off('not_a_movie')
    if (!/^[A-Za-z0-9_-]{1,2048}$/.test(String(id))) return off('bad_id')
    let feature = null
    try { feature = await resolveFeature('movie', id) } catch { feature = null }
    if (!feature || !feature.fileName) return off('not_found')
    // The stream routes already refuse a film above a restricted profile; answer the same way here (the cookie route has no such check).
    const policy = getPolicy(userId)
    const restricted = parental.isRestricted(policy)
    if (restricted) {
      const fm = feature.meta || {}
      const d = parental.decide(policy, { kind: 'movie', id: String(id), tmdbId: fm.tmdbId, certification: fm.certification, genres: fm.genres || [], collectionId: fm.collectionId })
      if (!d.allowed) return off('not_found')
    }

    const items = []
    try { if (prefs.useIntro) { const intro = await introItem(); if (intro) items.push(intro) } } catch { /* no intro */ }

    const count = Math.min(prefs.count, cfg.maxTrailers)
    let onlineOk = null
    let partial = false
    if (count > 0) {
      const fm = feature.meta || {}
      const featureInfo = { fileName: feature.fileName, tmdbId: fm.tmdbId || null, genres: Array.isArray(fm.genres) ? fm.genres : [], year: fm.year || null, certification: fm.certification || null }
      const ctx = { policy, restricted, featureLevel: levelOfCert(featureInfo.certification), matchFeatureRating: prefs.matchFeatureRating }
      const rng = deps.random || seededRandom([vk, feature.fileName, new Date(now()).toISOString().slice(0, 10)].join('|'))
      const index = buildTrailerIndex(getMovieDirs(), { fsImpl })
      let ownedRows = []
      try { ownedRows = listOwned(userId) || [] } catch { ownedRows = [] }
      const { local, owned } = ownedCandidates(ownedRows, featureInfo, index, prefs, rng)
      const local2 = local.concat(bankCandidates(prefs))
      const sortDesc = (list) => list.map((c) => ({ c, s: scoreCandidate(c, featureInfo, rng) })).sort((a, b) => b.s - a.s).map((x) => x.c)
      const netOk = cfg.allowOnline && networkAllowed(userId) && online.hasKey()
      const started = now()
      const timeUp = () => now() - started > budgetMs
      const ownedTmdb = new Set(ownedRows.map((o) => o && (o.tmdbId || (o.meta && o.meta.tmdbId))).filter(Boolean))
      const tiers = {
        local: sortDesc(local2),
        owned: netOk ? sortDesc(owned) : [],
        online: netOk && prefs.sources.online ? await onlineTier(featureInfo, ownedTmdb).catch(() => []) : []
      }
      // Online seeds carry no genres yet: order them by TMDB's own ranking until resolve() fills the details in.
      tiers.online.sort((a, b) => (b.seedRank || 0) - (a.seedRank || 0))
      const resolve = async (c) => {
        const d = await online.details(c.tmdbId)
        if (!d || !d.youtubeKey) return null
        return { ...c, title: plainText(d.title || c.title), year: d.year || c.year, genres: d.genres.length ? d.genres : c.genres, certification: d.certification || c.certification, collectionId: d.collectionId || c.collectionId, youtubeKey: d.youtubeKey, key: 'y:' + d.youtubeKey }
      }
      const result = await pickTrailers({
        tiers, count, recent: shown.recent(vk, prefs.dedupeDays), resolve, timeUp,
        evaluate: (c) => evaluateCandidate(c, ctx)
      })
      partial = timeUp()
      onlineOk = netOk ? online.isReachable() : null
      for (const c of result.picked) { const item = await toItem(c); if (item) items.push(item) }
    }
    return { ...base, enabled: true, reason: decision.reason, items, online: onlineOk, partial }
  }

  /** POST /api/playback/preroll/seen { items: [{ key, titleKey? }] } - remember what was shown. */
  function markSeen({ userId, profile = '', body }) {
    const list = Array.isArray(body && body.items) ? body.items.slice(0, 12) : []
    const keys = []
    let any = false
    for (const it of list) {
      if (!isObj(it)) continue
      any = true
      for (const k of [it.key, it.titleKey]) if (typeof k === 'string' && KEY_RE.test(k) && !k.startsWith('i:') && !keys.includes(k)) keys.push(k)
    }
    if (!any) return { ok: false, error: 'bad_request' }
    shown.record(viewerKeyOf(userId, profile), keys)
    return { ok: true, recorded: keys.length }
  }

  function publicState(userId, profile = '') {
    const cfg = config()
    const folder = cinemaFolder()
    return {
      ok: true,
      prefs: getPrefs(store, userId, profile),
      available: cfg.available,
      onlineAllowed: cfg.allowOnline,
      hasIntro: !!cfg.introFile,
      maxTrailers: cfg.maxTrailers,
      hasFolder: !!folder
    }
  }

  async function comingSoon(userId) {
    const policy = getPolicy(userId)
    // The cards carry no age rating, so a restricted profile gets none (same call the Trailers screen makes).
    if (parental.isRestricted(policy)) return { ok: true, restricted: true, upcoming: [], nowPlaying: [], attribution: cinemaOnline.TMDB_ATTRIBUTION }
    const shelf = await online.comingSoon()
    return { ok: true, restricted: false, online: online.isReachable(), ...shelf, attribution: cinemaOnline.TMDB_ATTRIBUTION }
  }

  // ---- HTTP ----
  const claims = (p) => p === '/playback/preroll' || p === '/playback/preroll/seen' || p === '/playback/cinema' || p === '/playback/cinema/coming-soon'

  /** p is the path after /api or /playback-api. Returns true when it answered. */
  async function handle(req, res, p, url, { userId, send, isGuest = false }) {
    if (!claims(p)) return false
    const method = req.method || 'GET'
    const profile = url.searchParams.get('profile') || String(req.headers['x-beebo-profile'] || '') || ''
    if (p === '/playback/preroll' && method === 'GET') {
      const kind = url.searchParams.get('kind') === 'tv' ? 'tv' : 'movie'
      const id = url.searchParams.get('id') || ''
      if (!id) { send(400, { ok: false, error: 'bad_request' }); return true }
      const param = url.searchParams.get('preshow') === '1' ? '1' : url.searchParams.get('preshow') === '0' ? '0' : ''
      const out = await preroll({ userId, profile, kind, id, param, resuming: url.searchParams.get('resume') === '1', isGuest })
      send(200, out)
      return true
    }
    if (p === '/playback/preroll/seen' && method === 'POST') {
      const body = await readJsonBody(req)
      if (!body) { send(400, { ok: false, error: 'bad_request' }); return true }
      const out = markSeen({ userId, profile, body })
      send(out.ok ? 200 : 400, out)
      return true
    }
    if (p === '/playback/cinema' && method === 'GET') { send(200, publicState(userId, profile)); return true }
    if (p === '/playback/cinema' && method === 'POST') {
      const body = await readJsonBody(req)
      if (!body || !isObj(body)) { send(400, { ok: false, error: 'bad_request' }); return true }
      if (body.clearHistory === true) shown.forget(viewerKeyOf(userId, profile))
      setPrefs(store, userId, body.profile || profile, body)
      send(200, publicState(userId, body.profile || profile))
      return true
    }
    if (p === '/playback/cinema/coming-soon' && method === 'GET') { send(200, await comingSoon(userId)); return true }
    send(405, { ok: false, error: 'method_not_allowed' })
    return true
  }

  /** GET/HEAD /cinema/media/<id>?mt=<token>. No login: the signed token is the credential (like /hls). */
  function handlePublic(req, res, url) {
    const m = /^\/cinema\/media\/([a-f0-9]{20})$/.exec(url.pathname)
    if (!m) return false
    const method = String(req.method || 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') { res.writeHead(405); res.end(); return true }
    const entry = registry.get(m[1])
    const token = url.searchParams.get('mt') || ''
    if (!entry || !check('cinema:' + m[1], token) || !insideRoot(entry.path, entry.root)) { res.writeHead(404); res.end('Not found'); return true }
    fileServe.serveFile(req, res, entry.path, { mime: MIME[extOf(entry.path)] || 'application/octet-stream', headers: { 'Cache-Control': 'private, max-age=300' } })
    return true
  }

  return { preroll, markSeen, publicState, comingSoon, handle, handlePublic, claims, claimsPublic: (p) => p.startsWith('/cinema/media/'), register, online, shown }
}

module.exports = {
  // settings
  DEFAULT_PREFS, DEFAULT_CONFIG, normalizePrefs, normalizeConfig, getConfig, setConfig, getPrefs, setPrefs, viewerKeyOf, safeIntroName, decideEnabled,
  // local discovery
  isTrailerFileName, stripTrailerMark, buildTrailerIndex, listCinemaFolder, certFromName, PLAYABLE_EXT,
  // picking
  levelOfCert, evaluateCandidate, scoreCandidate, pickTrailers, seededRandom, createShownLog,
  // service
  createCinemaService,
  // shared constants
  YT_ID_RE, KEY_RE, MAX_TRAILERS
}
