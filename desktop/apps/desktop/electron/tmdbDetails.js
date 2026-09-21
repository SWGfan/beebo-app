'use strict'
// ============================================================================
// tmdbDetails.js - TMDB lookups for the movie / show details pages, main process only.
// ----------------------------------------------------------------------------
// The API key stays here: the renderer asks for an id and gets back a trimmed,
// already-shaped answer. Nothing but TMDB ids and titles ever leaves the machine
// (no file paths, no user names, no watch history).
//
// Endpoints and how long an answer is kept (memory + JSON files in the shared TMDB
// cache folder, so the pages keep working offline once seen):
//   /movie/{id}?append_to_response=credits,release_dates,recommendations   14 days
//   /tv/{id}?append_to_response=aggregate_credits,content_ratings            7 days
//   /tv/{id}/season/{n}                    (guest stars per episode)         7 days
//   /tv/{id}/season/{n}/episode/{e}/credits (cast + guests of one episode) 180 days
//   /person/{id}                                                            30 days
// A lookup that fails (no key, offline, TMDB down) is never cached; an expired
// answer is still returned, marked stale, when TMDB cannot be reached.
// At most MAX_CONCURRENT requests are in flight at once, however many pages ask.
// ============================================================================

const fs = require('fs')
const path = require('path')

const DAY = 24 * 60 * 60 * 1000
const TTL = {
  movie: 14 * DAY,
  tv: 7 * DAY,
  season: 7 * DAY,
  episode: 180 * DAY,
  person: 30 * DAY
}
const MAX_ENTRIES = { movie: 3000, tv: 1500, season: 3000, episode: 4000, person: 3000 }
const MAX_CONCURRENT = 4
const MAX_CAST = 24
const MAX_TV_CAST = 60
const MAX_RECOMMENDATIONS = 12
const WRITE_DELAY_MS = 1500
const PROFILE_PATH_RE = /^\/[A-Za-z0-9._-]{1,120}$/

const str = (v) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v))
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null }
const posInt = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null }
// TMDB image paths are "/abc123.jpg"; anything else is dropped rather than trusted.
const imgPath = (v) => (typeof v === 'string' && PROFILE_PATH_RE.test(v) ? v : null)
const yearOf = (date) => (/^\d{4}/.test(str(date)) ? str(date).slice(0, 4) : '')

function person(p) {
  const id = posInt(p && p.id)
  if (!id) return null
  return { id, name: str(p.name), profilePath: imgPath(p.profile_path) }
}

// ---------------------------------------------------------------- normalisers (pure)

// The rating a region publishes (theatrical first, then any); that region's, else the US one.
function pickMovieCertification(releaseDates, region = 'US') {
  const results = releaseDates && Array.isArray(releaseDates.results) ? releaseDates.results : []
  const ratingOf = (code) => {
    const entry = results.find((r) => r && r.iso_3166_1 === code)
    const rows = entry && Array.isArray(entry.release_dates) ? entry.release_dates.filter((rd) => rd && rd.certification) : []
    const theatrical = rows.find((rd) => rd.type === 3)
    return str((theatrical || rows[0] || {}).certification) || null
  }
  return ratingOf(region) || (region === 'US' ? null : ratingOf('US'))
}

const WRITER_JOBS = new Set(['Writer', 'Screenplay', 'Story', 'Novel', 'Characters', 'Teleplay', 'Author'])

/** /movie/{id} with credits, release_dates and recommendations appended -> the page's movie record. */
function normalizeMovie(data, region = 'US') {
  if (!data || !posInt(data.id)) return null
  const credits = data.credits || {}
  const crew = Array.isArray(credits.crew) ? credits.crew : []
  const directors = []
  const writers = []
  const seenD = new Set()
  for (const c of crew) {
    const p = person(c)
    if (!p) continue
    if (c.job === 'Director' && !seenD.has(p.id)) { seenD.add(p.id); directors.push(p) }
    else if (WRITER_JOBS.has(c.job)) {
      // One person credited for two writing jobs shows once, with both jobs.
      const existing = writers.find((w) => w.id === p.id)
      if (!existing) writers.push({ ...p, job: c.job })
      else if (!existing.job.split(', ').includes(c.job)) existing.job += `, ${c.job}`
    }
  }
  const cast = (Array.isArray(credits.cast) ? credits.cast : [])
    .map((c) => { const p = person(c); return p ? { ...p, character: str(c.character) || null, order: num(c.order) } : null })
    .filter(Boolean)
    .slice(0, MAX_CAST)
  const recs = (data.recommendations && Array.isArray(data.recommendations.results) ? data.recommendations.results : [])
    .filter((r) => r && posInt(r.id) && !r.adult)
    .slice(0, MAX_RECOMMENDATIONS)
    .map((r) => ({ id: r.id, title: str(r.title), year: yearOf(r.release_date), posterPath: imgPath(r.poster_path), voteAverage: num(r.vote_average) }))
  return {
    id: data.id,
    title: str(data.title),
    tagline: str(data.tagline),
    overview: str(data.overview),
    releaseDate: str(data.release_date),
    year: yearOf(data.release_date),
    runtime: posInt(data.runtime),
    genres: (Array.isArray(data.genres) ? data.genres : []).map((g) => str(g && g.name)).filter(Boolean),
    voteAverage: num(data.vote_average),
    voteCount: num(data.vote_count),
    backdropPath: imgPath(data.backdrop_path),
    posterPath: imgPath(data.poster_path),
    certification: pickMovieCertification(data.release_dates, region),
    collection: data.belongs_to_collection && posInt(data.belongs_to_collection.id) ? { id: data.belongs_to_collection.id, name: str(data.belongs_to_collection.name) } : null,
    directors,
    writers,
    cast,
    recommendations: recs
  }
}

/** /tv/{id} with aggregate_credits and content_ratings appended -> the show page's record. */
function normalizeTv(data, region = 'US') {
  if (!data || !posInt(data.id)) return null
  const agg = data.aggregate_credits || {}
  const cast = (Array.isArray(agg.cast) ? agg.cast : [])
    .map((c, i) => {
      const p = person(c)
      if (!p) return null
      const roles = Array.isArray(c.roles) ? c.roles : []
      return {
        ...p,
        characters: roles.map((r) => str(r && r.character).trim()).filter(Boolean),
        episodeCount: posInt(c.total_episode_count) || roles.reduce((n, r) => n + (posInt(r && r.episode_count) || 0), 0),
        order: num(c.order) !== null ? num(c.order) : i
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.order - b.order)
    .slice(0, MAX_TV_CAST)
  const byJob = (jobs, limit) => (Array.isArray(agg.crew) ? agg.crew : [])
    .map((c) => {
      const p = person(c)
      const list = Array.isArray(c.jobs) ? c.jobs : []
      const matching = list.filter((j) => jobs.has(str(j && j.job)))
      if (!p || !matching.length) return null
      return { ...p, job: matching[0].job, episodeCount: matching.reduce((n, j) => n + (posInt(j.episode_count) || 0), 0) }
    })
    .filter(Boolean)
    .sort((a, b) => b.episodeCount - a.episodeCount)
    .slice(0, limit)
  const ratings = data.content_ratings && Array.isArray(data.content_ratings.results) ? data.content_ratings.results : []
  const us = ratings.find((r) => r && r.iso_3166_1 === region && r.rating) || ratings.find((r) => r && r.iso_3166_1 === 'US')
  return {
    id: data.id,
    name: str(data.name),
    overview: str(data.overview),
    firstAirDate: str(data.first_air_date),
    year: yearOf(data.first_air_date),
    status: str(data.status),
    genres: (Array.isArray(data.genres) ? data.genres : []).map((g) => str(g && g.name)).filter(Boolean),
    voteAverage: num(data.vote_average),
    voteCount: num(data.vote_count),
    backdropPath: imgPath(data.backdrop_path),
    posterPath: imgPath(data.poster_path),
    certification: us && us.rating ? str(us.rating) : null,
    creators: (Array.isArray(data.created_by) ? data.created_by : []).map(person).filter(Boolean),
    directors: byJob(new Set(['Director']), 6),
    writers: byJob(WRITER_JOBS, 6),
    seasons: (Array.isArray(data.seasons) ? data.seasons : [])
      .filter((s) => s && Number.isInteger(s.season_number) && s.season_number >= 0)
      .map((s) => ({ seasonNumber: s.season_number, name: str(s.name), episodeCount: posInt(s.episode_count) || 0, airDate: str(s.air_date), posterPath: imgPath(s.poster_path) })),
    cast
  }
}

/** /tv/{id}/season/{n} -> the guest stars of every episode in it. */
function normalizeSeason(data, seasonNumber) {
  if (!data || !Array.isArray(data.episodes)) return null
  return {
    season: Number.isInteger(data.season_number) ? data.season_number : seasonNumber,
    posterPath: imgPath(data.poster_path),
    episodes: data.episodes
      .filter((e) => e && posInt(e.episode_number))
      .map((e) => ({
        episode: e.episode_number,
        name: str(e.name),
        guests: (Array.isArray(e.guest_stars) ? e.guest_stars : [])
          .map((g) => { const p = person(g); return p ? { ...p, character: str(g.character) || null } : null })
          .filter(Boolean)
      }))
  }
}

/** /tv/{id}/season/{n}/episode/{e}/credits -> { cast, guests } for one episode. */
function normalizeEpisodeCredits(data) {
  if (!data || typeof data !== 'object') return null
  const rows = (list) => (Array.isArray(list) ? list : [])
    .map((c) => { const p = person(c); return p ? { ...p, character: str(c.character) || null } : null })
    .filter(Boolean)
  return { cast: rows(data.cast), guests: rows(data.guest_stars) }
}

/** /person/{id} -> the person page's header. */
function normalizePerson(data) {
  const p = person(data)
  if (!p) return null
  return {
    ...p,
    biography: str(data.biography).slice(0, 6000),
    birthday: str(data.birthday),
    deathday: str(data.deathday),
    placeOfBirth: str(data.place_of_birth),
    knownFor: str(data.known_for_department)
  }
}

// ---------------------------------------------------------------- cache + limiter

function createTtlStore({ getFile, ttlMs, maxEntries, now = () => Date.now(), fsImpl = fs }) {
  const mem = new Map() // key -> { at, v }
  let loadedFrom = null
  let timer = null
  const file = () => { try { return getFile() } catch { return null } }

  function load() {
    const f = file()
    if (!f) return null
    if (loadedFrom === f) return f
    loadedFrom = f
    try {
      const data = JSON.parse(fsImpl.readFileSync(f, 'utf8'))
      for (const [k, e] of Object.entries((data && data.entries) || {})) {
        if (e && typeof e.at === 'number' && !mem.has(k)) mem.set(k, e)
      }
    } catch {
      // no file yet, or a damaged one: start empty
    }
    return f
  }

  function flush() {
    if (timer) { clearTimeout(timer); timer = null }
    const f = file()
    if (!f) return
    try {
      fsImpl.mkdirSync(path.dirname(f), { recursive: true })
      const tmp = `${f}.tmp`
      fsImpl.writeFileSync(tmp, JSON.stringify({ v: 1, entries: Object.fromEntries(mem) }))
      fsImpl.renameSync(tmp, f)
    } catch {
      // a failed write only means a repeat lookup later
    }
  }

  return {
    /** { value, fresh } or undefined. Expired entries are returned (fresh: false) so offline still has something. */
    get(key) {
      load()
      const hit = mem.get(key)
      if (!hit) return undefined
      return { value: hit.v, fresh: now() - hit.at <= ttlMs }
    },
    set(key, value) {
      load()
      mem.delete(key)
      mem.set(key, { at: now(), v: value })
      while (mem.size > maxEntries) mem.delete(mem.keys().next().value)
      if (!timer) {
        timer = setTimeout(flush, WRITE_DELAY_MS)
        if (timer.unref) timer.unref()
      }
    },
    flush,
    size: () => { load(); return mem.size }
  }
}

function createLimiter(max) {
  let active = 0
  const queue = []
  const next = () => {
    if (active >= max || !queue.length) return
    active++
    const { fn, resolve, reject } = queue.shift()
    Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; next() })
  }
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next() })
}

// ---------------------------------------------------------------- the service

function createTmdbDetails({ getApi, getCacheDir, getLocale, now = () => Date.now(), fsImpl = fs, maxConcurrent = MAX_CONCURRENT } = {}) {
  const limit = createLimiter(maxConcurrent)
  const inFlight = new Map()
  const stores = new Map()
  const dir = () => { try { return getCacheDir ? getCacheDir() : null } catch { return null } }

  // Each language keeps its own cache files, so switching language never mixes or loses answers.
  const locale = () => {
    let l = null
    try { l = getLocale ? getLocale() : null } catch { l = null }
    return { language: (l && l.language) || 'en-US', region: (l && l.region) || 'US' }
  }
  const tagFor = (loc) => (loc.language === 'en-US' && loc.region === 'US' ? '' : `.${loc.language}_${loc.region}`)

  function storeFor(kind, baseName) {
    const fileName = baseName.replace(/\.json$/, `${tagFor(locale())}.json`)
    const k = `${kind}|${fileName}`
    if (!stores.has(k)) {
      // Per-show episode files stay small; a few dozen open at a time is plenty.
      if (stores.size > 40) stores.delete(stores.keys().next().value)
      stores.set(k, createTtlStore({
        getFile: () => (dir() ? path.join(dir(), 'details', fileName) : null),
        ttlMs: TTL[kind], maxEntries: MAX_ENTRIES[kind], now, fsImpl
      }))
    }
    return stores.get(k)
  }

  // One cached, de-duplicated, rate-limited TMDB lookup.
  async function lookup({ kind, fileName, key, path: apiPath, params, normalize }) {
    const loc = locale()
    const store = storeFor(kind, fileName)
    const hit = store.get(key)
    if (hit && hit.fresh) return { ok: true, data: hit.value, cached: true }
    const flightKey = `${fileName}${tagFor(loc)}|${key}`
    if (inFlight.has(flightKey)) return inFlight.get(flightKey)
    const job = (async () => {
      const api = getApi ? getApi() : null
      if (!api) return hit ? { ok: true, data: hit.value, cached: true, stale: true } : { ok: false, error: 'no_api_key' }
      const res = await limit(() => api.get(apiPath, { language: loc.language, include_adult: 'false', ...params }))
      if (!res || !res.ok) {
        if (hit) return { ok: true, data: hit.value, cached: true, stale: true }
        return { ok: false, error: res && res.status === 404 ? 'not_found' : res && res.status ? `http_${res.status}` : 'offline' }
      }
      const data = normalize(res.data, loc.region)
      if (!data) return { ok: false, error: 'not_found' }
      store.set(key, data)
      return { ok: true, data, cached: false }
    })().finally(() => inFlight.delete(flightKey))
    inFlight.set(flightKey, job)
    return job
  }

  const id = (v) => posInt(v)

  return {
    movie: (movieId) => {
      const n = id(movieId)
      return n ? lookup({ kind: 'movie', fileName: 'movies.json', key: String(n), path: `/movie/${n}`, params: { append_to_response: 'credits,release_dates,recommendations' }, normalize: normalizeMovie }) : Promise.resolve({ ok: false, error: 'bad_id' })
    },
    tv: (tvId) => {
      const n = id(tvId)
      return n ? lookup({ kind: 'tv', fileName: 'shows.json', key: String(n), path: `/tv/${n}`, params: { append_to_response: 'aggregate_credits,content_ratings' }, normalize: normalizeTv }) : Promise.resolve({ ok: false, error: 'bad_id' })
    },
    tvSeason: (tvId, season) => {
      const n = id(tvId)
      const s = Number(season)
      if (!n || !Number.isInteger(s) || s < 0 || s > 500) return Promise.resolve({ ok: false, error: 'bad_id' })
      return lookup({ kind: 'season', fileName: `season-${n}.json`, key: String(s), path: `/tv/${n}/season/${s}`, params: {}, normalize: (d) => normalizeSeason(d, s) })
    },
    tvEpisode: (tvId, season, episode) => {
      const n = id(tvId)
      const s = Number(season)
      const e = id(episode)
      if (!n || !Number.isInteger(s) || s < 0 || s > 500 || !e || e > 5000) return Promise.resolve({ ok: false, error: 'bad_id' })
      return lookup({ kind: 'episode', fileName: `episodes-${n}.json`, key: `${s}:${e}`, path: `/tv/${n}/season/${s}/episode/${e}/credits`, params: {}, normalize: normalizeEpisodeCredits })
    },
    person: (personId) => {
      const n = id(personId)
      return n ? lookup({ kind: 'person', fileName: 'people.json', key: String(n), path: `/person/${n}`, params: {}, normalize: normalizePerson }) : Promise.resolve({ ok: false, error: 'bad_id' })
    },
    flush: () => { for (const s of stores.values()) s.flush() }
  }
}

module.exports = {
  createTmdbDetails,
  createTtlStore,
  createLimiter,
  normalizeMovie,
  normalizeTv,
  normalizeSeason,
  normalizeEpisodeCredits,
  normalizePerson,
  pickMovieCertification,
  TTL,
  MAX_CONCURRENT
}
