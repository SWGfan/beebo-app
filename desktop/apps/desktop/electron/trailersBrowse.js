'use strict'
// The Trailers screen's main-process half: TMDB discover / recommendations /
// person search / videos, an on-disk cache with a size bound, the trailer picker,
// and the two URL builders that are the only way anything reaches the browser.
//
// electron/trailers.js is the phone's older ▶ button and keeps its own picker; this
// file is separate on purpose (different language rules, strict 11-character keys).
//
// The renderer never holds the TMDB key and never supplies a URL: it names a TMDB
// id and a media type, and this file builds every URL that leaves the app.

const fs = require('fs')
const path = require('path')
const titleMatch = require('./titleMatch')
const titleParse = require('./titleParse')
const parental = require('./parentalControls')
const { GENRE_NAMES_MOVIE, GENRE_NAMES_TV, splitTvGenreIds } = require('./genres')

const HOUR = 60 * 60 * 1000
const TTL = {
  videos: 7 * 24 * HOUR,
  // New titles get their trailer late, so "none yet" is re-asked daily.
  videosNone: 24 * HOUR,
  details: 7 * 24 * HOUR,
  list: 12 * HOUR, // discover, search, recommendations, person credits
  person: HOUR
}

const YOUTUBE_KEY_RE = /^[A-Za-z0-9_-]{11}$/
const POSTER_PATH_RE = /^\/[A-Za-z0-9_-]{1,80}\.(jpg|jpeg|png|webp)$/
const MEDIA = ['movie', 'tv']
const MAX_ID = 2147483647
const MIN_YEAR = 1880
const MAX_GENRES = 6
const RESULT_LIMIT = 24
const LIBRARY_LIMIT = 200
const SEED_COUNT = 5
const DISCOVER_PAGES = 2
const RATE_LIMIT_COOLDOWN_MS = 30 * 1000

// A TV genre id a film genre id stands for, where TMDB's TV list lumps genres together
// (see genres.js for the same lumping in the other direction).
const MOVIE_TO_TV_GENRE = { 28: 10759, 12: 10759, 878: 10765, 14: 10765, 10752: 10768 }

const MIN_VOTES = {
  movie: { popular: 150, rating: 500 },
  tv: { popular: 100, rating: 300 },
  person: 50,
  search: 10
}

// ---------------------------------------------------------------------------
// Trailer choice and the URLs that open it
// ---------------------------------------------------------------------------

function isValidYouTubeKey(key) {
  return typeof key === 'string' && YOUTUBE_KEY_RE.test(key)
}

function youtubeWatchUrl(key) {
  return isValidYouTubeKey(key) ? 'https://www.youtube.com/watch?v=' + key : null
}

function cleanText(value, max) {
  const s = String(value == null ? '' : value)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return max && s.length > max ? s.slice(0, max).trim() : s
}

// The fallback when TMDB lists no trailer: a YouTube results page, never a video.
function youtubeSearchUrl(title, year) {
  const words = cleanText(title, 120)
  if (!words) return null
  const q = [words, year ? String(year) : '', 'trailer'].filter(Boolean).join(' ')
  return 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q)
}

// 'en-US' -> { tag: 'en-US', lang: 'en' }. Anything odd falls back to English.
function parseLocale(input) {
  const s = String(input || '').replace('_', '-')
  const m = /^([A-Za-z]{2,3})(?:-([A-Za-z]{2}))?$/.exec(s)
  if (!m) return { tag: 'en-US', lang: 'en' }
  const lang = m[1].toLowerCase()
  return { tag: m[2] ? lang + '-' + m[2].toUpperCase() : lang, lang }
}

const TYPE_RANK = { Trailer: 0, Teaser: 1 }

function publishedMs(v) {
  const t = Date.parse(v && v.published_at)
  return Number.isFinite(t) ? t : -Infinity
}

// Order: type (Trailer over Teaser), official first, app language then English then any
// other, newest published, then key so the answer never depends on the order TMDB sent.
// Clips, featurettes and other types are never picked.
function pickTrailer(videos, { language = 'en' } = {}) {
  const want = String(language || 'en').toLowerCase()
  const rows = (Array.isArray(videos) ? videos : []).filter(
    (v) =>
      v &&
      typeof v === 'object' &&
      typeof v.site === 'string' &&
      v.site.toLowerCase() === 'youtube' &&
      Object.prototype.hasOwnProperty.call(TYPE_RANK, v.type) &&
      isValidYouTubeKey(v.key)
  )
  if (!rows.length) return null
  const langRank = (v) => {
    const l = typeof v.iso_639_1 === 'string' ? v.iso_639_1.toLowerCase() : ''
    return l === want ? 0 : l === 'en' ? 1 : 2
  }
  rows.sort((a, b) => {
    const t = TYPE_RANK[a.type] - TYPE_RANK[b.type]
    if (t) return t
    const o = (b.official === true ? 1 : 0) - (a.official === true ? 1 : 0)
    if (o) return o
    const l = langRank(a) - langRank(b)
    if (l) return l
    const pa = publishedMs(a)
    const pb = publishedMs(b)
    if (pa !== pb) return pa < pb ? 1 : -1
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
  })
  const best = rows[0]
  return { key: best.key, name: cleanText(best.name, 120) || null, type: best.type, official: best.official === true }
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

function genreTable(media) {
  return media === 'tv' ? GENRE_NAMES_TV : GENRE_NAMES_MOVIE
}

function toId(v) {
  const n = typeof v === 'string' && /^\d{1,10}$/.test(v) ? Number(v) : v
  return Number.isSafeInteger(n) && n > 0 && n <= MAX_ID ? n : null
}

// Anything a renderer sends -> the only shapes the rest of this file will look at.
function normalizeFilters(raw, { now = () => Date.now() } = {}) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const media = r.media === 'tv' ? 'tv' : 'movie'
  const table = genreTable(media)
  const genres = [
    ...new Set((Array.isArray(r.genres) ? r.genres : []).map(toId).filter((g) => g !== null && Object.prototype.hasOwnProperty.call(table, g)))
  ]
    .sort((a, b) => a - b)
    .slice(0, MAX_GENRES)
  const maxYear = new Date(now()).getUTCFullYear() + 3
  const year = (v) => {
    const n = toId(v)
    return n !== null && n >= MIN_YEAR && n <= maxYear ? n : null
  }
  let yearFrom = year(r.yearFrom)
  let yearTo = year(r.yearTo)
  if (yearFrom === null && yearTo !== null) yearFrom = yearTo
  if (yearTo === null && yearFrom !== null) yearTo = yearFrom
  if (yearFrom !== null && yearTo !== null && yearFrom > yearTo) [yearFrom, yearTo] = [yearTo, yearFrom]
  return {
    media,
    genres,
    yearFrom,
    yearTo,
    personId: toId(r.personId),
    text: cleanText(r.text, 100),
    sort: r.sort === 'rating' ? 'rating' : 'popular'
  }
}

function hasAnyFilter(f) {
  return !!(f.genres.length || f.yearFrom !== null || f.personId !== null || f.text)
}

function tmdbGenreIds(media, ids) {
  if (media !== 'tv') return ids.slice()
  return [...new Set(ids.map((g) => MOVIE_TO_TV_GENRE[g] || g))].sort((a, b) => a - b)
}

// Which TMDB call answers these filters. TMDB's discover cannot search by title
// (any media) or by actor (TV), so those routes search or read credits and the
// remaining filters are applied here afterwards; `local` is what is still to apply.
function buildQueryPlan(filters, { language = 'en-US' } = {}) {
  const f = filters
  const media = f.media
  const base = { include_adult: 'false', language }
  const wide = f.yearFrom !== null && f.yearTo !== null ? { from: f.yearFrom, to: f.yearTo } : null
  const local = { genres: f.genres, yearFrom: f.yearFrom, yearTo: f.yearTo, creditsOf: null }

  if (f.text) {
    const params = { ...base, query: f.text, page: 1 }
    if (wide && wide.from === wide.to) params[media === 'tv' ? 'first_air_date_year' : 'primary_release_year'] = wide.from
    return { source: 'search', path: '/search/' + media, params, pages: 1, local: { ...local, creditsOf: f.personId }, minVotes: MIN_VOTES.search }
  }
  if (media === 'tv' && f.personId !== null) {
    return { source: 'credits', path: '/person/' + f.personId + '/tv_credits', params: { language }, pages: 1, local, minVotes: MIN_VOTES.person }
  }
  const params = {
    ...base,
    sort_by: f.sort === 'rating' ? 'vote_average.desc' : 'popularity.desc',
    'vote_count.gte': f.personId !== null ? MIN_VOTES.person : MIN_VOTES[media][f.sort]
  }
  if (f.genres.length) params.with_genres = tmdbGenreIds(media, f.genres).join(',')
  if (wide) {
    const key = media === 'tv' ? 'first_air_date' : 'primary_release_date'
    params[key + '.gte'] = wide.from + '-01-01'
    params[key + '.lte'] = wide.to + '-12-31'
  }
  if (f.personId !== null) params.with_cast = f.personId
  return { source: 'discover', path: '/discover/' + media, params, pages: DISCOVER_PAGES, local: { genres: [], yearFrom: null, yearTo: null, creditsOf: null }, minVotes: params['vote_count.gte'] }
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

function yearOf(dateString) {
  const y = Number(String(dateString || '').slice(0, 4))
  return Number.isInteger(y) && y >= MIN_YEAR ? y : null
}

function shortOverview(text) {
  const s = cleanText(text, 1000)
  if (s.length <= 240) return s
  const cut = s.slice(0, 240)
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), 160)).trim() + '…'
}

function posterUrl(posterPath) {
  return typeof posterPath === 'string' && POSTER_PATH_RE.test(posterPath) ? 'https://image.tmdb.org/t/p/w342' + posterPath : null
}

// One TMDB result row (movie or tv shaped) -> what the renderer shows. Null when unusable.
function toCard(media, raw) {
  if (!raw || typeof raw !== 'object' || raw.adult === true) return null
  const id = toId(raw.id)
  const title = cleanText(media === 'tv' ? raw.name : raw.title, 200)
  if (id === null || !title) return null
  const votes = Number(raw.vote_count) || 0
  const rating = Number(raw.vote_average)
  const genreIds = Array.isArray(raw.genre_ids) ? raw.genre_ids.map(Number).filter(Number.isInteger) : []
  return {
    tmdbId: id,
    mediaType: media,
    title,
    year: yearOf(media === 'tv' ? raw.first_air_date : raw.release_date),
    rating: votes > 0 && Number.isFinite(rating) ? Math.round(rating * 10) / 10 : null,
    votes,
    overview: shortOverview(raw.overview),
    posterUrl: posterUrl(raw.poster_path),
    popularity: Number(raw.popularity) || 0,
    genreIds: media === 'tv' ? splitTvGenreIds(genreIds) : genreIds
  }
}

function publicCard(c) {
  const { popularity, genreIds, votes, ...rest } = c // eslint-disable-line no-unused-vars
  return rest
}

function applyLocalFilters(cards, local, creditIds) {
  return cards.filter((c) => {
    if (local.genres.length && !local.genres.every((g) => c.genreIds.includes(g))) return false
    if (local.yearFrom !== null && (c.year === null || c.year < local.yearFrom || c.year > local.yearTo)) return false
    if (local.creditsOf !== null && !(creditIds && creditIds.has(c.tmdbId))) return false
    return true
  })
}

function rankCards(cards, sort) {
  const key = sort === 'rating' ? (c) => c.rating || 0 : (c) => c.popularity
  return cards.slice().sort((a, b) => key(b) - key(a) || b.popularity - a.popularity || a.tmdbId - b.tmdbId)
}

// ---------------------------------------------------------------------------
// The library, as the Trailers screen needs it
// ---------------------------------------------------------------------------

// sources: { movieFiles: [{ fileName, path }], movieManifest, movieCredits, tvManifest, tvCredits }
// -- all read from what the app already indexed; nothing here calls TMDB.
function buildLibrary(sources, { posterFor = () => null } = {}) {
  const s = sources || {}
  const items = []
  const seen = new Set()
  const ids = new Set()
  const titles = { movie: new Map(), tv: new Map() }

  const remember = (media, title, year) => {
    const key = titleMatch.normalizeTitle(title)
    if (!key) return
    if (!titles[media].has(key)) titles[media].set(key, new Set())
    titles[media].get(key).add(year)
  }

  const add = (media, meta, extra) => {
    const id = toId(meta.id)
    if (id === null) return false
    ids.add(media + ':' + id)
    const title = cleanText(media === 'tv' ? meta.name : meta.title, 200)
    const year = yearOf(media === 'tv' ? meta.first_air_date : meta.release_date)
    remember(media, title, year)
    remember(media, media === 'tv' ? meta.original_name : meta.original_title, year)
    if (seen.has(media + ':' + id) || !title) return true
    seen.add(media + ':' + id)
    const credits = (media === 'tv' ? s.tvCredits : s.movieCredits) || {}
    const cast = Array.isArray(credits[id]) ? credits[id] : []
    const rating = Number(meta.vote_average)
    items.push({
      mediaType: media,
      tmdbId: id,
      title,
      year,
      rating: Number.isFinite(rating) && rating > 0 ? Math.round(rating * 10) / 10 : null,
      overview: shortOverview(meta.overview),
      genreIds: Array.isArray(meta.genre_ids) ? (media === 'tv' ? splitTvGenreIds(meta.genre_ids) : meta.genre_ids).map(Number) : [],
      certification: meta.certification ? cleanText(meta.certification, 12) : null,
      castIds: cast.map((c) => Number(c && c.id)).filter(Number.isInteger),
      posterUrl: posterFor(media, id, meta.poster_path) || posterUrl(meta.poster_path),
      ...extra
    })
    return true
  }

  const movieManifest = s.movieManifest || {}
  for (const f of Array.isArray(s.movieFiles) ? s.movieFiles : []) {
    if (!f || typeof f.fileName !== 'string') continue
    const meta = movieManifest[f.fileName]
    if (meta && add('movie', meta, { path: typeof f.path === 'string' ? f.path : null })) continue
    // Not matched to TMDB yet: it still counts as owned, by the title and year in its file name.
    const parsed = titleParse.parseMovieTitle(f.fileName)
    if (parsed && parsed.title) remember('movie', parsed.title, parsed.year ? Number(parsed.year) : null)
  }

  const tvManifest = s.tvManifest || {}
  for (const showKey of Object.keys(tvManifest)) {
    const meta = tvManifest[showKey]
    if (meta && add('tv', meta, { showKey })) continue
    remember('tv', showKey, null)
  }

  return { items, index: { ids, titles } }
}

// By TMDB id first; else the same normalised title within a year of each other (a file
// name's year is often off by one), or with either year unknown.
function isInLibrary(index, cand) {
  if (!index || !cand) return false
  if (cand.tmdbId != null && index.ids.has(cand.mediaType + ':' + cand.tmdbId)) return true
  const table = index.titles[cand.mediaType]
  const years = table && table.get(titleMatch.normalizeTitle(cand.title))
  if (!years) return false
  if (cand.year == null || years.has(null)) return true
  for (const y of years) if (y !== null && Math.abs(y - cand.year) <= 1) return true
  return false
}

// The library items that satisfy every filter (AND). Cast is only known for titles whose
// credits the app has already downloaded.
function matchLibrary(items, filters) {
  const words = titleMatch.normalizeTitle(filters.text).split(' ').filter(Boolean)
  return items
    .filter((it) => {
      if (it.mediaType !== filters.media) return false
      if (words.length) {
        const t = titleMatch.normalizeTitle(it.title)
        if (!words.every((w) => t.includes(w))) return false
      }
      if (filters.genres.length && !filters.genres.every((g) => it.genreIds.includes(g))) return false
      if (filters.yearFrom !== null && (it.year === null || it.year < filters.yearFrom || it.year > filters.yearTo)) return false
      if (filters.personId !== null && !it.castIds.includes(filters.personId)) return false
      return true
    })
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }) || a.tmdbId - b.tmdbId)
}

function publicLibraryItem(it) {
  const { castIds, genreIds, ...rest } = it // eslint-disable-line no-unused-vars
  return rest
}

function hashString(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

// A handful of the library's better-liked titles to ask TMDB "more like this" about. The pick
// changes each day (so suggestions do not go stale) but is stable within a day.
function pickSeeds(items, media, dayKey, count = SEED_COUNT) {
  const mine = items.filter((it) => it.mediaType === media)
  const liked = mine.filter((it) => (it.rating || 0) >= 6.5)
  const pool = liked.length >= count ? liked : mine
  return pool
    .map((it) => ({ it, h: hashString(dayKey + ':' + it.tmdbId) }))
    .sort((a, b) => a.h - b.h || a.it.tmdbId - b.it.tmdbId)
    .slice(0, count)
    .map((x) => x.it.tmdbId)
}

// ---------------------------------------------------------------------------
// Who may use this
// ---------------------------------------------------------------------------

// A profile with parental controls on gets no Trailers at all. TMDB's discover and
// recommendation rows carry no certification (that is a separate call per title, US-only
// and often missing for new releases), so a ceiling cannot be enforced reliably; the phone
// and web server make the same call by blocking /api/trailer and /api/suggestions.
function viewerAccess(policy) {
  let p
  try {
    p = parental.normalizePolicy(policy)
  } catch {
    return { allowed: false, reason: 'restricted_profile' }
  }
  return parental.isRestricted(p) ? { allowed: false, reason: 'restricted_profile' } : { allowed: true }
}

// ---------------------------------------------------------------------------
// Request limiter and disk cache
// ---------------------------------------------------------------------------

function createLimiter(max) {
  const limit = Math.max(1, Math.floor(max) || 1)
  const waiting = []
  let active = 0
  let peak = 0
  const pump = () => {
    while (active < limit && waiting.length) {
      const job = waiting.shift()
      active++
      peak = Math.max(peak, active)
      Promise.resolve()
        .then(job.fn)
        .then(job.resolve, job.reject)
        .finally(() => {
          active--
          pump()
        })
    }
  }
  return {
    run: (fn) =>
      new Promise((resolve, reject) => {
        waiting.push({ fn, resolve, reject })
        pump()
      }),
    stats: () => ({ active, queued: waiting.length, peak })
  }
}

// One JSON file of { key: { at, exp, v } }, bounded by entry count and total size, oldest out first.
function createDiskCache({ file, now = () => Date.now(), maxEntries = 400, maxBytes = 3 * 1024 * 1024, maxEntryBytes = 256 * 1024, flushDelayMs = 1500 } = {}) {
  let map = null
  let bytes = 0
  let timer = null
  let dirty = false
  // A function so the location can wait until the app's data folder is known.
  const fileOf = () => (typeof file === 'function' ? file() : file)

  const sizeOf = (key, e) => key.length + JSON.stringify(e.v).length + 40

  function load() {
    if (map) return
    map = new Map()
    bytes = 0
    const target = fileOf()
    if (!target) return
    try {
      const data = JSON.parse(fs.readFileSync(target, 'utf8'))
      const entries = data && data.entries && typeof data.entries === 'object' ? data.entries : {}
      for (const [k, e] of Object.entries(entries)) {
        if (e && typeof e.exp === 'number' && typeof e.at === 'number' && 'v' in e) {
          map.set(k, e)
          bytes += sizeOf(k, e)
        }
      }
      prune()
    } catch {
      // a missing or damaged cache is just an empty one
    }
  }

  function drop(key) {
    const e = map.get(key)
    if (!e) return
    bytes -= sizeOf(key, e)
    map.delete(key)
    dirty = true
  }

  function prune() {
    const t = now()
    for (const [k, e] of [...map]) if (e.exp <= t) drop(k)
    // Map iterates in insertion order and set() re-inserts, so the first key is the oldest write.
    while (map.size > maxEntries || bytes > maxBytes) {
      const oldest = map.keys().next().value
      if (oldest === undefined) break
      drop(oldest)
    }
  }

  function flush() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    const target = fileOf()
    if (!target || !dirty || !map) return
    dirty = false
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      const tmp = target + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, entries: Object.fromEntries(map) }))
      fs.renameSync(tmp, target)
    } catch {
      // a failed write only means a repeat lookup later
    }
  }

  function schedule() {
    dirty = true
    if (timer || !fileOf()) return
    timer = setTimeout(flush, flushDelayMs)
    if (timer.unref) timer.unref()
  }

  return {
    get(key) {
      load()
      const e = map.get(key)
      if (!e) return undefined
      if (e.exp <= now()) {
        drop(key)
        schedule()
        return undefined
      }
      return e.v
    },
    set(key, value, ttlMs) {
      load()
      const e = { at: now(), exp: now() + ttlMs, v: value }
      if (sizeOf(key, e) > maxEntryBytes) return
      drop(key)
      map.set(key, e)
      bytes += sizeOf(key, e)
      prune()
      schedule()
    },
    size: () => (load(), map.size),
    bytes: () => (load(), bytes),
    flush
  }
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

class TrailersError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

function failureCode(err) {
  return err instanceof TrailersError ? err.code : 'internal'
}

function parseWatchRequest(req) {
  if (!req || typeof req !== 'object' || Array.isArray(req)) return null
  const keys = Object.keys(req)
  if (keys.length !== 2 || !keys.includes('tmdbId') || !keys.includes('mediaType')) return null
  if (typeof req.tmdbId !== 'number' || !Number.isSafeInteger(req.tmdbId) || req.tmdbId <= 0 || req.tmdbId > MAX_ID) return null
  if (!MEDIA.includes(req.mediaType)) return null
  return { tmdbId: req.tmdbId, mediaType: req.mediaType }
}

function createTrailersService({
  getApiKey,
  getLanguage = () => 'en-US',
  getLibrarySources = async () => ({}),
  posterFor,
  openExternal,
  cacheFile = null,
  fetchImpl,
  sleep,
  now = () => Date.now(),
  concurrency = 3,
  cacheOptions = {}
} = {}) {
  const cache = createDiskCache({ file: cacheFile, now, ...cacheOptions })
  const limiter = createLimiter(concurrency)
  const inflight = new Map()
  let coolUntil = 0
  let apiFor = { key: null, api: null }

  const locale = () => parseLocale(getLanguage())

  function api() {
    const key = getApiKey()
    if (!key) throw new TrailersError('no_api_key')
    if (apiFor.key !== key) apiFor = { key, api: titleMatch.createTmdbApi(key, fetchImpl, sleep ? { sleep } : undefined) }
    if (!apiFor.api) throw new TrailersError('offline')
    return apiFor.api
  }

  const cacheKeyOf = (p, params) =>
    p +
    '?' +
    Object.keys(params)
      .sort()
      .map((k) => k + '=' + params[k])
      .join('&')

  // Cached, de-duplicated, rate-limited TMDB GET. `shape` runs once on a fresh answer, so the
  // cache holds the small shaped value and not TMDB's full JSON.
  // `accept` lets a caller refuse a cached value that is not the shape it wrote (a damaged file).
  async function tmdb(p, params, ttlMs, shape, accept) {
    const ck = cacheKeyOf(p, params)
    const hit = cache.get(ck)
    if (hit !== undefined && (!accept || accept(hit))) return hit
    if (inflight.has(ck)) return inflight.get(ck)
    const job = (async () => {
      if (now() < coolUntil) throw new TrailersError('rate_limited')
      const client = api()
      const res = await limiter.run(() => client.get(p, params))
      if (!res.ok) {
        if (res.status === 429) {
          coolUntil = now() + RATE_LIMIT_COOLDOWN_MS
          throw new TrailersError('rate_limited')
        }
        if (res.status === 404) throw new TrailersError('not_found')
        if (res.status === 401) throw new TrailersError('bad_api_key')
        throw new TrailersError(res.status === 0 ? 'offline' : 'tmdb_error')
      }
      const value = shape(res.data)
      cache.set(ck, value, typeof ttlMs === 'function' ? ttlMs(value) : ttlMs)
      return value
    })().finally(() => inflight.delete(ck))
    inflight.set(ck, job)
    return job
  }

  const cardsOf = (media, data) => (Array.isArray(data && data.results) ? data.results : []).map((r) => toCard(media, r)).filter(Boolean)

  async function loadLibrary() {
    const sources = await getLibrarySources()
    return buildLibrary(sources, { posterFor })
  }

  async function searchPeople(query) {
    const q = cleanText(query, 80)
    if (q.length < 2) return []
    const people = await tmdb('/search/person', { include_adult: 'false', language: locale().tag, query: q, page: 1 }, TTL.person, (d) =>
      (Array.isArray(d && d.results) ? d.results : [])
        .filter((p) => p && p.adult !== true && toId(p.id) !== null && cleanText(p.name, 100))
        .slice(0, 8)
        .map((p) => ({
          id: p.id,
          name: cleanText(p.name, 100),
          department: cleanText(p.known_for_department, 40) || null,
          knownFor: (Array.isArray(p.known_for) ? p.known_for : [])
            .map((k) => cleanText(k && (k.title || k.name), 80))
            .filter(Boolean)
            .slice(0, 2)
        }))
    )
    return people
  }

  async function creditIds(media, personId) {
    const ids = await tmdb('/person/' + personId + '/' + media + '_credits', { language: locale().tag }, TTL.list, (d) => [
      ...new Set((Array.isArray(d && d.cast) ? d.cast : []).map((c) => toId(c && c.id)).filter((x) => x !== null))
    ])
    return new Set(ids)
  }

  async function runPlan(filters) {
    const plan = buildQueryPlan(filters, { language: locale().tag })
    const pageJobs = []
    for (let page = 1; page <= plan.pages; page++) {
      const params = plan.source === 'credits' ? plan.params : { ...plan.params, page }
      pageJobs.push(
        tmdb(plan.path, params, TTL.list, (d) => {
          const rows = plan.source === 'credits' ? d && d.cast : d && d.results
          const out = []
          const seen = new Set()
          for (const r of Array.isArray(rows) ? rows : []) {
            const c = toCard(filters.media, r)
            if (c && !seen.has(c.tmdbId)) {
              seen.add(c.tmdbId)
              out.push(c)
            }
          }
          return out
        }).catch((err) => {
          // a later page failing must not lose page one
          if (page > 1) return []
          throw err
        })
      )
    }
    const pages = await Promise.all(pageJobs)
    const seen = new Set()
    let cards = []
    for (const c of pages.flat()) {
      if (!seen.has(c.tmdbId)) {
        seen.add(c.tmdbId)
        cards.push(c)
      }
    }
    if (plan.minVotes) cards = cards.filter((c) => c.votes >= plan.minVotes)
    const ids = plan.local.creditsOf !== null ? await creditIds(filters.media, plan.local.creditsOf) : null
    return applyLocalFilters(cards, plan.local, ids)
  }

  async function recommendationsFrom(media, seeds) {
    const lists = await Promise.all(
      seeds.map((id) =>
        tmdb('/' + media + '/' + id + '/recommendations', { include_adult: 'false', language: locale().tag, page: 1 }, TTL.list, (d) => cardsOf(media, d)).catch(
          (err) => {
            if (err instanceof TrailersError && (err.code === 'not_found' || err.code === 'tmdb_error')) return []
            throw err
          }
        )
      )
    )
    const merged = new Map()
    for (const list of lists) {
      for (const c of list) {
        const e = merged.get(c.tmdbId)
        if (e) e.hits++
        else merged.set(c.tmdbId, { c, hits: 1 })
      }
    }
    const floor = MIN_VOTES[media].popular
    return [...merged.values()]
      .filter((e) => e.c.votes >= floor)
      .sort((a, b) => b.hits - a.hits || (b.c.rating || 0) - (a.c.rating || 0) || b.c.popularity - a.c.popularity || a.c.tmdbId - b.c.tmdbId)
      .map((e) => e.c)
  }

  async function library(rawFilters) {
    const filters = normalizeFilters(rawFilters, { now })
    const lib = await loadLibrary()
    const matches = matchLibrary(lib.items, filters)
    return { items: matches.slice(0, LIBRARY_LIMIT).map(publicLibraryItem), total: matches.length, filters }
  }

  // -> { items, basis: 'filters' | 'library' | 'popular' }
  async function suggestions(rawFilters) {
    const filters = normalizeFilters(rawFilters, { now })
    const lib = await loadLibrary()
    let basis = 'filters'
    let cards
    if (hasAnyFilter(filters)) {
      cards = await runPlan(filters)
    } else {
      const dayKey = new Date(now()).toISOString().slice(0, 10)
      const seeds = pickSeeds(lib.items, filters.media, dayKey)
      if (seeds.length) {
        basis = 'library'
        cards = await recommendationsFrom(filters.media, seeds)
      } else {
        basis = 'popular'
        cards = await runPlan(filters)
      }
    }
    const fresh = cards.filter((c) => c.posterUrl && !isInLibrary(lib.index, c))
    const ordered = basis === 'library' ? fresh : rankCards(fresh, filters.sort)
    return { items: ordered.slice(0, RESULT_LIMIT).map(publicCard), basis, filters }
  }

  async function lookupTrailer({ tmdbId, mediaType }) {
    const { tag, lang } = locale()
    const langs = [...new Set([lang, 'en', 'null'])].join(',')
    const wrapped = await tmdb('/' + mediaType + '/' + tmdbId + '/videos', { language: tag, include_video_language: langs }, (v) => (v.trailer ? TTL.videos : TTL.videosNone), (d) => ({
      trailer: pickTrailer(d && d.results, { language: lang })
    }), (v) => !!v && typeof v === 'object' && (v.trailer === null || isValidYouTubeKey(v.trailer && v.trailer.key)))
    return wrapped.trailer
  }

  async function lookupTitle({ tmdbId, mediaType }) {
    return tmdb('/' + mediaType + '/' + tmdbId, { language: locale().tag }, TTL.details, (d) => ({
      title: cleanText(mediaType === 'tv' ? d && d.name : d && d.title, 200),
      year: yearOf(mediaType === 'tv' ? d && d.first_air_date : d && d.release_date)
    }))
  }

  async function open(url) {
    if (!/^https:\/\/www\.youtube\.com\/(watch\?v=[A-Za-z0-9_-]{11}|results\?search_query=[A-Za-z0-9%._~*'()!-]+)$/.test(url || '')) {
      throw new TrailersError('internal')
    }
    try {
      await openExternal(url)
    } catch {
      throw new TrailersError('open_failed')
    }
  }

  // req is exactly { tmdbId, mediaType }; anything else, above all a URL, is refused.
  async function watchTrailer(req) {
    const parsed = parseWatchRequest(req)
    if (!parsed) return { ok: false, error: 'bad_request' }
    try {
      const trailer = await lookupTrailer(parsed)
      if (trailer) {
        await open(youtubeWatchUrl(trailer.key))
        return { ok: true, opened: 'trailer', name: trailer.name }
      }
      const info = await lookupTitle(parsed)
      const url = youtubeSearchUrl(info.title, info.year)
      if (!url) return { ok: false, error: 'not_found' }
      await open(url)
      return { ok: true, opened: 'search', title: info.title }
    } catch (err) {
      return { ok: false, error: failureCode(err) }
    }
  }

  return {
    searchPeople,
    library,
    suggestions,
    watchTrailer,
    flush: cache.flush,
    limiterStats: limiter.stats,
    cache
  }
}

module.exports = {
  TTL,
  YOUTUBE_KEY_RE,
  MOVIE_TO_TV_GENRE,
  MIN_VOTES,
  RATE_LIMIT_COOLDOWN_MS,
  TrailersError,
  isValidYouTubeKey,
  youtubeWatchUrl,
  youtubeSearchUrl,
  parseLocale,
  pickTrailer,
  normalizeFilters,
  hasAnyFilter,
  tmdbGenreIds,
  buildQueryPlan,
  toCard,
  buildLibrary,
  isInLibrary,
  matchLibrary,
  pickSeeds,
  viewerAccess,
  parseWatchRequest,
  createLimiter,
  createDiskCache,
  createTrailersService
}
