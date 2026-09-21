// Turn server JSON into small, sanitised, memory-light objects. DOM-free.
//
// EVERY field that will reach the screen passes through safeText/safeLine here, every path/URL
// through safeRelPath/safeImageUrl, and ids are kept as opaque strings. Anything the server sends
// that we do not list is dropped (a 1300-show library should not keep 20 unused fields per row).

import { safeText, safeLine, safeRelPath, safeImageUrl, safeInt, clampNumber, hasControlChars } from './escape.js'

function str(v, max) { return safeLine(v, max || 200) }
function id(v) {
  var s = typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''
  return s.length > 0 && s.length <= 1024 && !hasControlChars(s) ? s : ''
}
function list(v) { return Array.isArray(v) ? v : [] }

/** /api/movies item */
export function normalizeMovie(m) {
  if (!m || typeof m !== 'object') return null
  var mid = id(m.id)
  if (!mid) return null
  return {
    kind: 'movie',
    id: mid,
    title: str(m.title) || 'Untitled',
    year: safeInt(m.year, 0) || 0,
    poster: safeRelPath(m.poster),
    backdrop: safeImageUrl(m.backdrop),
    rating: clampNumber(m.voteAverage, 0, 10, 0),
    overview: safeText(m.overview, 600),
    quality: str(m.quality, 12),
    isNew: m.isNew === true,
    stream: safeRelPath(m.stream)
  }
}

/** /api/tvshows item */
export function normalizeShow(s) {
  if (!s || typeof s !== 'object') return null
  // /api/tvshows sends {key,name}; the paged /api/v1 route sends {id,title}.
  var key = id(s.key !== undefined ? s.key : s.id)
  if (!key) return null
  return {
    kind: 'tv',
    key: key,
    id: key,
    title: str(s.name !== undefined ? s.name : s.title) || 'Untitled',
    year: safeInt(s.year, 0) || 0,
    poster: safeRelPath(s.poster),
    backdrop: safeImageUrl(s.backdrop),
    rating: clampNumber(s.voteAverage, 0, 10, 0),
    episodeCount: safeInt(s.episodeCount, 0) || 0,
    isNew: s.isNew === true,
    overview: ''
  }
}

/** Map a whole list response, dropping unusable rows. */
export function normalizeList(items, fn, max) {
  var out = []
  var src = list(items)
  var cap = max || 20000
  for (var i = 0; i < src.length && out.length < cap; i++) {
    var n = fn(src[i])
    if (n) out.push(n)
  }
  return out
}

/** /api/continue row (episode or movie; `id` is the playable file id). */
export function normalizeContinue(r) {
  if (!r || typeof r !== 'object') return null
  var rid = id(r.id)
  if (!rid) return null
  var kind = r.kind === 'tv' ? 'tv' : 'movie'
  return {
    kind: kind,
    id: rid,
    fileId: rid,
    title: str(r.title) || 'Untitled',
    poster: safeRelPath(r.poster),
    stream: safeRelPath(r.stream),
    currentTime: clampNumber(r.currentTime, 0, 1e7, 0),
    duration: clampNumber(r.duration, 0, 1e7, 0),
    percent: clampNumber(r.percent, 0, 100, 0),
    watched: r.watched === true,
    upNext: r.upNext === true
  }
}

/** /api/recently-added row: a movie (id) or a show (showKey). */
export function normalizeRecent(r) {
  if (!r || typeof r !== 'object') return null
  if (r.kind === 'tv') {
    var key = id(r.showKey || r.id)
    if (!key) return null
    return { kind: 'tv', key: key, id: key, title: str(r.title) || 'Untitled', poster: safeRelPath(r.poster), year: 0, rating: 0, overview: '', backdrop: null, isNew: true, episodeCount: 0 }
  }
  var mid = id(r.id)
  if (!mid) return null
  return { kind: 'movie', id: mid, title: str(r.title) || 'Untitled', poster: safeRelPath(r.poster), year: 0, rating: 0, overview: '', backdrop: null, quality: '', isNew: true, stream: safeRelPath(r.stream), partial: true }
}

/** /api/tvshows/<key>/episodes */
export function normalizeEpisodes(body) {
  var b = body && typeof body === 'object' ? body : {}
  var show = b.show && typeof b.show === 'object' ? b.show : {}
  var seasons = []
  var src = list(b.seasons)
  for (var i = 0; i < src.length && i < 100; i++) {
    var s = src[i]
    if (!s || typeof s !== 'object') continue
    var eps = []
    var es = list(s.episodes)
    for (var j = 0; j < es.length && j < 1000; j++) {
      var e = es[j]
      var eid = e && typeof e === 'object' ? id(e.id) : ''
      if (!eid) continue
      eps.push({
        kind: 'tv',
        id: eid,
        season: safeInt(e.season, null),
        episode: safeInt(e.episode, null),
        title: str(e.title, 160) || 'Episode',
        episodeName: str(e.episodeName, 160),
        watched: e.watched === true,
        watchedPercent: clampNumber(e.watchedPercent, 0, 100, 0),
        stream: safeRelPath(e.stream)
      })
    }
    seasons.push({
      season: s.season === null || s.season === undefined ? null : safeInt(s.season, null),
      episodes: eps
    })
  }
  return {
    show: {
      key: id(show.key),
      title: str(show.name) || 'Untitled',
      poster: safeRelPath(show.poster),
      overview: safeText(show.overview, 800)
    },
    seasons: seasons
  }
}

/** "Season 2" / "Specials" / "Other" */
export function seasonLabel(season) {
  if (season === null || season === undefined) return 'Other'
  if (season === 0) return 'Specials'
  return 'Season ' + season
}

/** /api/playback/info */
export function normalizePlaybackInfo(b) {
  var body = b && typeof b === 'object' ? b : {}
  var direct = body.direct && typeof body.direct === 'object' ? body.direct : {}
  var video = body.video && typeof body.video === 'object' ? body.video : {}
  var audio = []
  var a = list(body.audio)
  for (var i = 0; i < a.length && i < 32; i++) {
    var t = a[i]
    if (!t || typeof t !== 'object') continue
    var si = safeInt(t.streamIndex, null)
    if (si === null) continue
    audio.push({
      streamIndex: si,
      label: str(t.label, 80) || str(t.language, 12) || 'Track ' + (audio.length + 1),
      language: str(t.language, 12),
      channels: safeInt(t.channels, 0) || 0,
      isDefault: t.isDefault === true
    })
  }
  var subs = []
  var s = list(body.subtitles)
  for (var k = 0; k < s.length && k < 64; k++) {
    var st = s[k]
    if (!st || typeof st !== 'object') continue
    var url = safeRelPath(st.url)
    // Only text tracks with a URL can be shown (picture subtitles would need burning in).
    if (st.kind !== 'text' || !url) continue
    subs.push({
      key: str(st.key, 40),
      label: str(st.label, 80) || str(st.language, 12) || 'Subtitles',
      language: str(st.language, 12),
      forced: st.forced === true,
      url: url
    })
  }
  var qualities = []
  var q = list(body.qualities)
  for (var n = 0; n < q.length && n < 8; n++) {
    var qi = q[n]
    if (qi && typeof qi.id === 'string' && /^(1080p|720p|480p)$/.test(qi.id)) qualities.push({ id: qi.id, label: str(qi.label, 12) || qi.id })
  }
  return {
    durationSec: clampNumber(body.durationSec, 0, 1e7, 0),
    height: safeInt(video.height, 0) || 0,
    directBrowser: direct.browser === true,
    audio: audio,
    subtitles: subs,
    qualities: qualities,
    transcodeAvailable: !!(body.transcode && body.transcode.available === true),
    // GET /api/playback/info carries a `homeTheater` block on a server that has POST /api/playback/negotiate
    // (docs/HOME-THEATER.md). Its presence is the feature test: an older server has none, and the player then keeps using
    // /api/playback/start. `badges` are the file's own labels ("4K", "Dolby Vision", "Atmos"...), shown as text.
    homeTheater: !!(body.homeTheater && typeof body.homeTheater === 'object'),
    badges: homeTheaterBadges(body.homeTheater)
  }
}

function homeTheaterBadges(ht) {
  var out = []
  var src = ht && typeof ht === 'object' ? list(ht.badges) : []
  for (var i = 0; i < src.length && out.length < 8; i++) {
    var b = str(src[i], 20)
    if (b) out.push(b)
  }
  return out
}

/** /api/playback/start -> { url, ticket } or null */
export function normalizePlaybackStart(b) {
  if (!b || typeof b !== 'object' || b.ok === false) return null
  var url = safeRelPath(b.url)
  if (!url) return null
  return { url: url, ticket: typeof b.ticket === 'string' && b.ticket.length < 512 ? b.ticket : '', height: safeInt(b.height, 0) || 0 }
}

/** /api/upnext next/previous -> item or null */
export function normalizeNeighbour(n) {
  if (!n || typeof n !== 'object') return null
  var nid = id(n.id)
  if (!nid) return null
  return { kind: n.kind === 'tv' ? 'tv' : 'movie', id: nid, title: str(n.title) || 'Next', poster: safeRelPath(n.poster), showKey: id(n.showKey) || null, stream: safeRelPath(n.stream) }
}

/** /api/login and /api/me user */
export function normalizeUser(u) {
  if (!u || typeof u !== 'object') return { name: '' }
  return { name: str(u.name || u.username, 60) }
}
