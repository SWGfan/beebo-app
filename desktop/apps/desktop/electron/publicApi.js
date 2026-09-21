'use strict'
// The public /api/v1 contract: an allowlist of read-only routes plus the JSON shapes they answer with.
//
// Nothing here talks to the server. streamServer.js calls the same internal functions the
// unversioned /api/* routes call and hands the raw result to a shaper below, so an internal refactor
// can change what /api/movies returns without an outside tool noticing: the shape lives here, not there.
//
// The routes are an ALLOWLIST (mirroring RESTRICTED_API_BLOCKED, inverted): a path that is not in
// ROUTES is a 404 whatever else /api/* grows later.

const { GENRE_NAMES_MOVIE, GENRE_NAMES_TV } = require('./genres')

const API_VERSION = 1

// A personal API key is granted some of these; an account token has all of them.
// `now-playing` also opens the live event stream; `metrics` is the Prometheus scrape (off until the
// owner turns it on). Both, and now-playing itself, are the owner's: a key made by anyone who is
// not an admin can only ever hold library and history (apiKeys.MEMBER_SCOPES).
const SCOPES = Object.freeze(['library', 'history', 'now-playing', 'metrics'])

const ROUTES = new Map([
  ['/api/v1', { id: 'index', scope: null }],
  ['/api/v1/library/movies', { id: 'movies', scope: 'library', library: 'movies' }],
  ['/api/v1/library/tvshows', { id: 'tvshows', scope: 'library', library: 'tv' }],
  ['/api/v1/library/collections', { id: 'collections', scope: 'library', library: 'movies' }],
  ['/api/v1/library/recently-added', { id: 'recently-added', scope: 'library', library: 'both' }],
  ['/api/v1/history', { id: 'history', scope: 'history', library: 'both' }],
  ['/api/v1/continue', { id: 'continue', scope: 'history', library: 'both' }],
  ['/api/v1/now-playing', { id: 'now-playing', scope: 'now-playing' }],
  ['/api/v1/events', { id: 'events', scope: 'now-playing', stream: true }],
  ['/api/v1/metrics', { id: 'metrics', scope: 'metrics', text: true }]
])

const PAGE_DEFAULT = 100
const PAGE_MAX = 500

function normalizePath(pathname) {
  return String(pathname || '').replace(/\/+$/, '') || '/'
}

function routeFor(pathname) {
  return ROUTES.get(normalizePath(pathname)) || null
}

function endpointList() {
  return [...ROUTES.entries()]
    .filter(([, r]) => r.id !== 'index')
    .map(([path, r]) => ({ path, scope: r.scope }))
}

const intOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const strOrNull = (v) => (typeof v === 'string' && v ? v : null)

function pageOf(searchParams) {
  const limit = intOrNull(searchParams.get('limit'))
  const offset = intOrNull(searchParams.get('offset'))
  return {
    limit: limit !== null && limit > 0 ? Math.min(limit, PAGE_MAX) : PAGE_DEFAULT,
    offset: offset !== null && offset > 0 ? offset : 0
  }
}

function paged(items, page, extra = {}) {
  return {
    ok: true,
    apiVersion: API_VERSION,
    total: items.length,
    limit: page.limit,
    offset: page.offset,
    ...extra,
    items: items.slice(page.offset, page.offset + page.limit)
  }
}

function genresOf(ids, names) {
  return (Array.isArray(ids) ? ids : [])
    .map((id) => ({ id: Number(id), name: names[id] || null }))
    .filter((g) => Number.isFinite(g.id))
}

function movieItem(m) {
  return {
    id: String(m.id),
    title: String(m.title || ''),
    year: intOrNull(m.year),
    overview: strOrNull(m.overview),
    tmdbId: intOrNull(m.tmdbId),
    voteAverage: numOrNull(m.voteAverage),
    quality: strOrNull(m.quality),
    genres: genresOf(m.genres, GENRE_NAMES_MOVIE),
    collection: m.collectionId != null ? { id: intOrNull(m.collectionId), name: strOrNull(m.collectionName) } : null,
    isNew: !!m.isNew,
    poster: strOrNull(m.poster),
    backdrop: strOrNull(m.backdrop)
  }
}

function showItem(s) {
  return {
    id: String(s.key),
    title: String(s.name || ''),
    year: intOrNull(s.year),
    tmdbId: intOrNull(s.tmdbId),
    voteAverage: numOrNull(s.voteAverage),
    quality: strOrNull(s.quality),
    genres: genresOf(s.genres, GENRE_NAMES_TV),
    episodeCount: intOrNull(s.episodeCount) || 0,
    isNew: !!s.isNew,
    poster: strOrNull(s.poster),
    backdrop: strOrNull(s.backdrop)
  }
}

function collectionItem(c) {
  return {
    id: intOrNull(c.id),
    name: String(c.displayName || c.name || ''),
    ownedCount: intOrNull(c.ownedCount) || 0,
    total: intOrNull(c.total) || 0,
    complete: !!c.complete,
    firstYear: intOrNull(c.firstYear),
    lastYear: intOrNull(c.lastYear),
    poster: strOrNull(c.poster)
  }
}

function shapeMovies(raw, page) {
  return paged(((raw && raw.items) || []).map(movieItem), page)
}

function shapeTvShows(raw, page) {
  return paged(((raw && raw.items) || []).map(showItem), page)
}

function shapeCollections(raw, page) {
  return paged(((raw && raw.items) || []).map(collectionItem), page)
}

// entries: [{ at, item: { id, kind, title, poster } }], newest first.
function shapeRecentlyAdded(entries, page) {
  const items = (entries || []).map((e) => ({
    id: String(e.item.id),
    kind: e.item.kind === 'tv' ? 'tv' : 'movie',
    title: String(e.item.title || ''),
    addedAt: e.at > 0 ? e.at : null,
    poster: strOrNull(e.item.poster)
  }))
  return paged(items, page)
}

// rows: history.js rows after decorateHistoryRows(). The stream URL (it carries a media token),
// the file name and the user id never leave through here.
function shapeHistory(rows, page) {
  const items = (rows || []).map((r) => ({
    id: String(r.id),
    kind: r.kind === 'tv' ? 'tv' : 'movie',
    title: String(r.title || ''),
    poster: strOrNull(r.poster),
    positionSeconds: Math.max(0, Math.round(Number(r.currentTime) || 0)),
    durationSeconds: Math.max(0, Math.round(Number(r.duration) || 0)),
    percent: intOrNull(r.percent) || 0,
    watched: !!r.watched,
    upNext: !!r.upNext,
    updatedAt: intOrNull(r.updatedAt)
  }))
  return paged(items, page)
}

// rows: serverDashboard.nowPlaying(). `hideUser(userId)` says whose viewing is not for an outside
// tool: profiles with private history, and profiles under parental controls. Their streams are
// left out of the list altogether rather than masked, because "someone is watching" is itself a leak.
// `extras.mediaOf(row)` adds the item's ids (TMDB / IMDb / TVDB), year and show/season/episode;
// `extras.refOf(row)` is the same one-way session reference the webhook events carry, so a dashboard
// can line a row up with the events it has heard.
function shapeNowPlaying(rows, hideUser, extras = {}) {
  const items = []
  for (const r of rows || []) {
    if (!r || r.historyPrivate) continue
    if (typeof hideUser === 'function' && hideUser(r.userId)) continue
    let media = null
    try { media = typeof extras.mediaOf === 'function' ? extras.mediaOf(r) : null } catch { media = null }
    let ref = null
    try { ref = typeof extras.refOf === 'function' ? extras.refOf(r) : null } catch { ref = null }
    const ids = media && media.ids && typeof media.ids === 'object' ? media.ids : {}
    const tx = r.playback === 'transcode' && r.transcode && typeof r.transcode === 'object' ? r.transcode : null
    items.push({
      sessionId: strOrNull(ref),
      user: r.userId ? { id: String(r.userId), name: String(r.user || '') } : null,
      title: String(r.title || ''),
      kind: r.kind === 'tv' ? 'tv' : 'movie',
      media: {
        year: intOrNull(media && media.year),
        show: strOrNull(media && media.show),
        season: intOrNull(media && media.season),
        episode: intOrNull(media && media.episode),
        ids: { tmdb: intOrNull(ids.tmdb), imdb: strOrNull(ids.imdb), tvdb: intOrNull(ids.tvdb) }
      },
      device: strOrNull(r.device),
      location: strOrNull(r.where),
      playback: r.playback === 'transcode' ? 'transcode' : 'direct',
      transcode: tx ? { reason: strOrNull(tx.reason), videoCodec: strOrNull(tx.videoCodec), audioCodec: strOrNull(tx.audioCodec), quality: strOrNull(tx.quality) } : null,
      positionSeconds: numOrNull(r.positionSeconds) === null ? null : Math.round(r.positionSeconds),
      durationSeconds: numOrNull(r.durationSeconds) === null ? null : Math.round(r.durationSeconds),
      progress: numOrNull(r.progress),
      paused: !!r.paused,
      state: r.paused ? 'paused' : 'playing',
      bandwidthKbps: numOrNull(r.currentBitsPerSec) === null ? null : Math.round(r.currentBitsPerSec / 1000),
      startedAt: intOrNull(r.startedAt)
    })
  }
  return { ok: true, apiVersion: API_VERSION, count: items.length, items }
}

function shapeIndex(principal) {
  return {
    ok: true,
    apiVersion: API_VERSION,
    app: 'beeboentertainment',
    auth: {
      type: principal.type,
      ...(principal.keyName ? { keyName: principal.keyName } : {}),
      scopes: principal.scopes
    },
    endpoints: endpointList().filter((e) => principal.scopes.includes(e.scope))
  }
}

module.exports = {
  API_VERSION,
  SCOPES,
  ROUTES,
  PAGE_DEFAULT,
  PAGE_MAX,
  routeFor,
  endpointList,
  pageOf,
  shapeMovies,
  shapeTvShows,
  shapeCollections,
  shapeRecentlyAdded,
  shapeHistory,
  shapeNowPlaying,
  shapeIndex
}
