'use strict'
/**
 * The bridge between the library and playlists.js.
 *
 *   buildCatalog(input)     -> every movie and episode as a flat rule-ready item
 *   buildViewerContext(...) -> what is personal to one viewer (watched, progress,
 *                              watchlist, favourites, Continue Watching)
 *   expandAdd(request, idx) -> "add this show / season / film / episode" as items
 *   resolveEntries(...)     -> a playlist's items as playable rows, in order
 *
 * No I/O and no require of streamServer: the server (and the desktop app) pass
 * the library in, so the tests can too.
 */

const crypto = require('crypto')
const playlists = require('./playlists')

const str = (v) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v))
const posNum = (v) => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function yearOf(date) {
  const y = Number(str(date).slice(0, 4))
  return Number.isInteger(y) && y > 1800 ? y : null
}

/**
 * input = {
 *   movies:  [{ id, fileName, fullPath, size, mtimeMs }],
 *   tvFiles: [{ id, relPath, fileName, fullPath, size, mtimeMs, showKey, showName, showYear, season, episode }],
 *   tracks:  [ musicLibrary.js track records, as returned by library.trackList() ],
 *   movieMeta(fileName) -> TMDB meta | null,
 *   tvMeta(showKey)     -> TMDB meta | null,
 *   genreNames: { movie: {id: name}, tv: {id: name} },
 *   qualityOf(fullPath, statLike) -> '2160p' | '1080p' | '720p' | '480p' | null,
 *   addedAtOf(fullPath) -> ms | 0,
 *   collectionOf(tmdbId) -> { id, name } | null,
 *   castOf(kind, tmdbId) -> [{ id, name }],
 *   durations: Map<'movie:<fileName>'|'tv:<relPath>', seconds>,
 *   movieTitle(fileName, meta), episodeTitle(file, meta),
 *   parsedMovieYear(fileName) -> number | null
 * }
 * Every reader is optional and wrapped: one broken cache entry costs that one
 * field, never the whole catalog. Tracks need none of that TMDB machinery -
 * musicLibrary.js already scanned their tags - so they are just reshaped.
 */
function buildCatalog(input = {}) {
  const safe = (fn, ...args) => {
    try {
      return typeof fn === 'function' ? fn(...args) : null
    } catch {
      return null
    }
  }
  const names = (kind, ids) => {
    const map = (input.genreNames && input.genreNames[kind]) || {}
    return (ids || []).map((id) => map[id]).filter(Boolean)
  }
  const durations = input.durations instanceof Map ? input.durations : new Map()
  const out = []

  for (const m of Array.isArray(input.movies) ? input.movies : []) {
    if (!m || !m.id) continue
    const meta = safe(input.movieMeta, m.fileName) || null
    const tmdbId = meta && meta.id != null ? meta.id : null
    const collection = tmdbId != null ? safe(input.collectionOf, tmdbId) : null
    const key = 'movie:' + str(m.fileName)
    const genres = Array.isArray(meta && meta.genre_ids) ? meta.genre_ids.slice() : []
    const runtime = posNum(meta && meta.runtime) * 60
    out.push({
      type: 'movie',
      id: m.id,
      key,
      fileName: str(m.fileName),
      title: str(safe(input.movieTitle, m.fileName, meta)) || (meta && meta.title) || str(m.fileName),
      year: yearOf(meta && meta.release_date) || safe(input.parsedMovieYear, m.fileName) || null,
      genres,
      genreNames: names('movie', genres),
      rating: posNum(meta && meta.vote_average) || null,
      certification: (meta && meta.certification) ? str(meta.certification) : null,
      addedAt: posNum(safe(input.addedAtOf, m.fullPath)) || posNum(m.mtimeMs),
      quality: safe(input.qualityOf, m.fullPath, m) || null,
      durationSeconds: posNum(durations.get(key)) || runtime || null,
      cast: (tmdbId != null && safe(input.castOf, 'movie', tmdbId)) || [],
      collectionId: collection && collection.id != null ? collection.id : null,
      collectionName: collection ? str(collection.name) || null : null,
      tmdbId,
      posterPath: meta ? meta.poster_path || null : null,
      showKey: null,
      showName: null,
      season: null,
      episode: null
    })
  }

  const castByShow = new Map()
  for (const f of Array.isArray(input.tvFiles) ? input.tvFiles : []) {
    if (!f || !f.id) continue
    const meta = safe(input.tvMeta, f.showKey) || null
    const tmdbId = meta && meta.id != null ? meta.id : null
    const key = 'tv:' + str(f.relPath)
    const genres = Array.isArray(meta && meta.genre_ids) ? meta.genre_ids.slice() : []
    if (tmdbId != null && !castByShow.has(tmdbId)) castByShow.set(tmdbId, safe(input.castOf, 'tv', tmdbId) || [])
    const runTimes = meta && Array.isArray(meta.episode_run_time) ? meta.episode_run_time : []
    const showName = (meta && meta.name) || str(f.showName)
    out.push({
      type: 'episode',
      id: f.id,
      key,
      fileName: str(f.relPath),
      title: str(safe(input.episodeTitle, f, meta)) ||
        `${showName}${f.season !== null && f.season !== undefined ? ` — S${f.season}E${f.episode}` : ''}`,
      year: yearOf(meta && meta.first_air_date) || (Number(f.showYear) || null),
      genres,
      genreNames: names('tv', genres),
      rating: posNum(meta && meta.vote_average) || null,
      certification: (meta && meta.certification) ? str(meta.certification) : null,
      addedAt: posNum(safe(input.addedAtOf, f.fullPath)) || posNum(f.mtimeMs),
      quality: safe(input.qualityOf, f.fullPath, f) || null,
      durationSeconds: posNum(durations.get(key)) || posNum(runTimes[0]) * 60 || null,
      cast: tmdbId != null ? castByShow.get(tmdbId) : [],
      collectionId: null,
      collectionName: null,
      tmdbId,
      posterPath: meta ? meta.poster_path || null : null,
      showKey: f.showKey || null,
      showName: showName || null,
      season: f.season === undefined ? null : f.season,
      episode: f.episode === undefined ? null : f.episode
    })
  }

  for (const t of Array.isArray(input.tracks) ? input.tracks : []) {
    if (!t || !t.id) continue
    out.push({
      type: 'track',
      id: t.id,
      key: 'track:' + str(t.id),
      fileName: null,
      title: str(t.title) || 'Unknown',
      year: posNum(t.year) || null,
      genres: [],
      genreNames: t.genre ? [str(t.genre)] : [],
      rating: null,
      certification: null,
      addedAt: posNum(t.addedAt),
      quality: null,
      durationSeconds: posNum(t.duration) || null,
      cast: [],
      collectionId: null,
      collectionName: null,
      tmdbId: null,
      posterPath: null,
      showKey: null,
      showName: null,
      season: null,
      episode: null,
      artist: str(t.artist) || null,
      artistId: t.artistId || null,
      albumName: str(t.album) || null,
      albumId: t.albumId || null,
      lossless: !!t.lossless,
      coverId: t.coverId || null
    })
  }
  return out
}

/** Longest duration any session reported per file - a player knows the real length. */
function durationsFromHistory(rows) {
  const map = new Map()
  for (const e of Array.isArray(rows) ? rows : []) {
    if (!e || typeof e !== 'object') continue
    const d = posNum(e.duration)
    if (!d || !e.fileName) continue
    const kind = e.kind === 'tv' || (e.kind !== 'movie' && /[\\/]/.test(str(e.fileName))) ? 'tv' : 'movie'
    const key = kind + ':' + str(e.fileName)
    if (d > (map.get(key) || 0)) map.set(key, d)
  }
  return map
}

/**
 * input = {
 *   watchedFiles: watchedState.userFiles(...)          { key: {watched} }
 *   resumable:    history.continueWatching(...)        [{ fileName, kind, percent, currentTime, updatedAt }]
 *   continueRows: grouped Continue Watching rows       [{ fileName, kind }]
 *   viewed:       history.viewedHistory(...)           [{ fileName, kind, updatedAt }]
 *   watchlist:    store.watchlist[userId]              [{ kind, id, showKey }]
 *   flags:        store.libraryFlags[userId]           { 'movie:<id>': {favorite} }
 *   now
 * }
 */
function buildViewerContext(input = {}) {
  const k = (r) => (r.kind === 'tv' ? 'tv' : 'movie') + ':' + str(r.fileName)
  const watched = new Set()
  for (const [key, rec] of Object.entries(input.watchedFiles || {})) if (rec && rec.watched) watched.add(key)
  const progress = new Map()
  for (const r of Array.isArray(input.resumable) ? input.resumable : []) {
    if (r && r.fileName) progress.set(k(r), { percent: posNum(r.percent), at: posNum(r.updatedAt), seconds: posNum(r.currentTime) })
  }
  const onDeck = new Set()
  for (const r of Array.isArray(input.continueRows) ? input.continueRows : []) if (r && r.fileName) onDeck.add(k(r))
  const lastWatched = new Map()
  for (const r of Array.isArray(input.viewed) ? input.viewed : []) {
    if (!r || !r.fileName) continue
    const key = k(r)
    lastWatched.set(key, Math.max(lastWatched.get(key) || 0, posNum(r.updatedAt)))
  }
  // Continue rows that are "up next" carry the finished episode's time.
  for (const r of Array.isArray(input.continueRows) ? input.continueRows : []) {
    if (r && r.fileName && posNum(r.updatedAt)) lastWatched.set(k(r), Math.max(lastWatched.get(k(r)) || 0, posNum(r.updatedAt)))
  }
  const watchlist = new Set()
  for (const w of Array.isArray(input.watchlist) ? input.watchlist : []) {
    if (!w) continue
    if (w.showKey) watchlist.add('show:' + str(w.showKey))
    if (w.kind === 'show') watchlist.add('show:' + str(w.id))
    else if (w.id) watchlist.add((w.kind === 'tv' ? 'tv:' : 'movie:') + str(w.id))
  }
  const favorites = new Set()
  for (const [key, f] of Object.entries(input.flags || {})) if (f && f.favorite) favorites.add(key)
  return { now: posNum(input.now) || Date.now(), watched, progress, onDeck, lastWatched, watchlist, favorites }
}

function indexCatalog(catalog) {
  const byRef = new Map()
  const shows = new Map()
  for (const it of catalog) {
    byRef.set(it.type + '|' + it.id, it)
    if (it.type === 'episode' && it.showKey) {
      if (!shows.has(it.showKey)) shows.set(it.showKey, [])
      shows.get(it.showKey).push(it)
    }
  }
  const order = (a, b) => ((a.season ?? 9999) - (b.season ?? 9999)) || ((a.episode ?? 9999) - (b.episode ?? 9999)) || (a.fileName < b.fileName ? -1 : 1)
  for (const eps of shows.values()) eps.sort(order)
  return { byRef, shows }
}

/**
 * What one "Add to playlist" tap means, as concrete items.
 *   { type: 'movie' | 'episode' | 'track' | 'photo', id }
 *   { type: 'show', showKey }            -> every episode, in watching order
 *   { type: 'season', showKey, season }  -> that season's episodes (season null = unsorted)
 * Throws PlaylistError('not_found') for a movie / episode / show the library does
 * not have. A track id is taken as given here too - resolveEntries is what
 * checks it against the music library, same as a movie that later left disk.
 * Photo ids are still taken as given: that library validates them when played,
 * and an unknown one is skipped then.
 */
function expandAdd(request, index) {
  const { PlaylistError } = playlists
  const reqs = Array.isArray(request) ? request : [request]
  const out = []
  for (const r of reqs) {
    if (!r || typeof r !== 'object') throw new PlaylistError('bad_item')
    const type = str(r.type || (r.kind === 'tv' ? 'episode' : r.kind))
    if (type === 'show' || type === 'season') {
      const key = str(r.showKey || r.id)
      const eps = index.shows.get(key)
      if (!eps || !eps.length) throw new PlaylistError('not_found', 404)
      const season = r.season === null || r.season === undefined || r.season === '' ? null : Number(r.season)
      const pick = type === 'show' ? eps : eps.filter((e) => (season === null ? e.season === null : e.season === season))
      if (!pick.length) throw new PlaylistError('not_found', 404)
      for (const e of pick) out.push({ type: 'episode', id: e.id, title: e.title })
      continue
    }
    if (type === 'movie' || type === 'episode') {
      const hit = index.byRef.get(type + '|' + str(r.id))
      if (!hit) throw new PlaylistError('not_found', 404)
      out.push({ type, id: hit.id, title: hit.title })
      continue
    }
    if (!/^[a-z][a-z0-9_-]{0,19}$/.test(type) || !r.id) throw new PlaylistError('bad_item')
    out.push({ type, id: str(r.id), title: str(r.title) })
  }
  return out
}

function smartEntryId(it) {
  return 's_' + crypto.createHash('sha1').update(it.type + '|' + it.id).digest('base64url').slice(0, 16)
}

/**
 * A playlist as rows the apps can show and play.
 *   opts = { index, catalog, ctx, seed, allow(item), decorate(item) -> {poster, stream} }
 * Returns { entries, skipped }: `entries` are in playlist order (smart: rule
 * order) and each has `available`; `skipped` counts items of a type no library
 * on this server can play yet (a photo before that library exists). A movie,
 * episode or track missing from its own library shows up instead, marked
 * `available: false`.
 */
function resolveEntries(playlist, opts = {}) {
  const { index, catalog, ctx = {}, seed = 1, allow, decorate } = opts
  let skipped = 0
  const kindOf = (type) => (type === 'episode' ? 'tv' : type === 'movie' ? 'movie' : type)
  const row = (it, entryId, addedAt) => {
    const extra = typeof decorate === 'function' ? decorate(it) || {} : {}
    const prog = ctx.progress && ctx.progress.get(it.key)
    return {
      entryId,
      type: it.type,
      id: it.id,
      kind: kindOf(it.type),
      title: it.title,
      showKey: it.showKey,
      showName: it.showName,
      season: it.season,
      episode: it.episode,
      artist: it.artist || null,
      album: it.albumName || null,
      year: it.year,
      durationSeconds: it.durationSeconds,
      quality: playlists.qualityClass(it.quality),
      watched: !!(ctx.watched && ctx.watched.has(it.key)),
      percent: prog ? prog.percent : 0,
      resumeSeconds: prog ? prog.seconds : 0,
      addedAt: addedAt || it.addedAt || 0,
      available: true,
      poster: extra.poster || null,
      stream: extra.stream || null
    }
  }
  const entries = []
  if (playlist.kind === 'smart') {
    for (const it of playlists.evaluateRules(playlist.rules, catalog, ctx, { seed, allow })) entries.push(row(it, smartEntryId(it)))
    return { entries, skipped }
  }
  for (const item of playlist.items || []) {
    if (item.type !== 'movie' && item.type !== 'episode' && item.type !== 'track') {
      // photo / anything newer: no resolver on this server yet.
      skipped++
      continue
    }
    const it = index.byRef.get(item.type + '|' + item.id)
    if (!it) {
      entries.push({
        entryId: item.entryId, type: item.type, id: item.id, kind: kindOf(item.type),
        title: item.title || 'No longer in the library', available: false, addedAt: item.addedAt,
        watched: false, percent: 0, resumeSeconds: 0, poster: null, stream: null
      })
      continue
    }
    // Hidden from this viewer (parental controls): left out, not flagged, so
    // nothing about it is shown.
    if (allow && !allow(it)) continue
    entries.push(row(it, item.entryId, item.addedAt))
  }
  return { entries, skipped }
}

module.exports = {
  buildCatalog,
  durationsFromHistory,
  buildViewerContext,
  indexCatalog,
  expandAdd,
  resolveEntries,
  smartEntryId
}
