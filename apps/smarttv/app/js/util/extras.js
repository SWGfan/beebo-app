// Live TV, Audiobooks, Podcasts and Internet Radio for the TV apps: routes and reply handling. DOM-free.
//
// Server contracts: desktop/apps/desktop/docs/LIVE-TV.md, AUDIOBOOKS.md and docs/PODCASTS-AND-RADIO.md. Every route is a
// Bearer JSON route on the home server; the audio / video itself is played from a short-lived signed address in the answer
// (`?mt=` media token or a signed ticket in the path), so <audio> and <video> need no headers. A server that does not have a
// feature (an older Beebo, the feature switched off, no tuner, no books) answers 404 / 403 / an empty state: the matching Home
// row is then simply not shown (see screens/home.js and api.js `extras`).
//
// Everything the server sends is DATA: text is cut to length and shown with textContent only, and an address is followed only
// if it has exactly the shape the server makes (checked below), so a wrong reply can never send the player somewhere else.

import { safeLine, safeRelPath, safeInt, clampNumber } from './escape.js'

function str(v, max) { return safeLine(v, max || 200) }
function list(v) { return Array.isArray(v) ? v : [] }
function sid(v) {
  var s = typeof v === 'string' ? v : ''
  return s.length > 0 && s.length <= 200 && /^[A-Za-z0-9:._~-]+$/.test(s) ? s : ''
}

export var extraRoutes = {
  // Live TV (the owner's own HDHomeRun tuner)
  liveStatus: function () { return { path: '/api/livetv/status' } },
  liveChannels: function () { return { path: '/api/livetv/channels' } },
  liveWatch: function () { return { path: '/api/livetv/watch' } },
  liveStop: function () { return { path: '/api/livetv/stop' } },
  // Audiobooks
  bookStatus: function () { return { path: '/api/audiobooks/status' } },
  bookContinue: function () { return { path: '/api/audiobooks/continue', query: { limit: 20 } } },
  books: function () { return { path: '/api/audiobooks/books', query: { sort: 'added', limit: 40 } } },
  book: function (id) { return { path: '/api/audiobooks/book/' + encodeURIComponent(id), query: { tokens: 1 } } },
  bookProgress: function (id) { return { path: '/api/audiobooks/book/' + encodeURIComponent(id) + '/progress' } },
  // Podcasts
  podcastStatus: function () { return { path: '/api/podcasts/status' } },
  podcastContinue: function () { return { path: '/api/podcasts/continue', query: { tokens: 1 } } },
  podcastLatest: function () { return { path: '/api/podcasts/latest', query: { tokens: 1, limit: 30 } } },
  podcastProgress: function (key) { return { path: '/api/podcasts/episode/' + encodeURIComponent(key) + '/progress' } },
  // Internet radio
  radioStatus: function () { return { path: '/api/radio/status' } },
  radioFavorites: function () { return { path: '/api/radio/favorites' } },
  radioRecent: function () { return { path: '/api/radio/recent' } },
  radioPopular: function () { return { path: '/api/radio/browse', query: { order: 'votes', limit: 20 } } },
  radioPlay: function () { return { path: '/api/radio/play', query: { tokens: 1 } } },
  radioSession: function (id) { return { path: '/api/radio/session/' + encodeURIComponent(id) } }
}

// ---- Live TV ---------------------------------------------------------------------------------------------------------------

/** GET /api/livetv/status -> { available, channelCount }. Available = on, with a tuner and at least one channel. */
export function normalizeLiveStatus(b) {
  var body = b && typeof b === 'object' ? b : {}
  var n = safeInt(body.channelCount, 0) || 0
  return { available: body.ok !== false && body.enabled === true && n > 0, channelCount: n }
}

function programme(p) {
  if (!p || typeof p !== 'object') return null
  var t = str(p.title, 100)
  return t ? { title: t, start: safeInt(p.start, 0) || 0, stop: safeInt(p.stop, 0) || 0 } : null
}

/** GET /api/livetv/channels -> [{ key, number, name, hd, favourite, now, next }] (favourites first, then by number). */
export function normalizeChannels(b) {
  var out = []
  var src = list(b && b.channels)
  for (var i = 0; i < src.length && out.length < 600; i++) {
    var c = src[i]
    if (!c || typeof c !== 'object') continue
    var key = sid(c.key)
    if (!key) continue
    out.push({
      key: key,
      number: str(c.number, 12),
      name: str(c.name, 60) || 'Channel',
      hd: c.hd === true,
      favourite: c.favourite === true,
      now: programme(c.now),
      next: programme(c.next)
    })
  }
  return out
}

/** The answer of POST /api/livetv/watch, or null when it is not a live playlist on this server. */
export function normalizeLiveWatch(b) {
  if (!b || typeof b !== 'object' || b.ok === false) return null
  var url = safeRelPath(b.url)
  if (!url || !/^\/livetv\/hls\/[^/?#]+\/index\.m3u8(\?|$)/.test(url)) return null
  var ch = b.channel && typeof b.channel === 'object' ? b.channel : {}
  return {
    url: url,
    ticket: typeof b.ticket === 'string' && b.ticket.length < 512 ? b.ticket : '',
    channelKey: sid(ch.key),
    number: str(ch.number, 12),
    name: str(ch.name, 60),
    now: programme(b.now),
    timeshiftMinutes: clampNumber(b.timeshiftMinutes, 0, 24 * 60, 0)
  }
}

/** A plain sentence for a failed POST /api/livetv/watch. */
export function explainLiveFailure(err) {
  var b = err && err.body
  if (b && b.error === 'tuners_busy') return 'Every tuner is busy right now. Try again in a moment.'
  if (b && typeof b.message === 'string' && b.message) return str(b.message, 200)
  if (err && err.status === 403) return 'Live TV is not available for this profile.'
  if (err && err.friendly) return err.friendly
  return 'Live TV could not start.'
}

// ---- Audiobooks -------------------------------------------------------------------------------------------------------------

function coverPath(v) {
  var p = safeRelPath(v)
  return p && /^\/api\/audiobooks\/cover\/[A-Za-z0-9_-]+$/.test(p) ? p : null
}

/** One book row (as in /books items, /continue items[].book, /continue nextUp[].book): { id, title, author, cover, duration, position, finished }. */
export function normalizeBook(b, progress) {
  if (!b || typeof b !== 'object') return null
  var id = typeof b.id === 'string' && /^[a-f0-9]{16}$/.test(b.id) ? b.id : ''
  if (!id) return null
  var p = progress || b.progress
  var duration = clampNumber(b.duration, 0, 1e7, 0)
  return {
    kind: 'book',
    id: id,
    title: str(b.title) || 'Untitled',
    author: str(b.author, 100),
    series: str(b.series, 100),
    cover: coverPath(b.cover),
    duration: duration,
    position: p && typeof p === 'object' ? clampNumber(p.position, 0, 1e7, 0) : 0,
    finished: !!(p && typeof p === 'object' && p.finished === true)
  }
}

/** /continue -> the "continue listening" books first, then the next book of a series being listened through. */
export function normalizeBookShelf(continueBody, booksBody) {
  var out = []
  var seen = {}
  function add(x) { if (x && !seen[x.id] && out.length < 40) { seen[x.id] = 1; out.push(x) } }
  var items = list(continueBody && continueBody.items)
  for (var i = 0; i < items.length; i++) add(normalizeBook(items[i] && items[i].book, items[i] && items[i].progress))
  var next = list(continueBody && continueBody.nextUp)
  for (var j = 0; j < next.length; j++) add(normalizeBook(next[j] && next[j].book, null))
  var books = list(booksBody && booksBody.items)
  for (var k = 0; k < books.length; k++) {
    var nb = normalizeBook(books[k], null)
    if (nb && !nb.finished) add(nb)
  }
  return out
}

/**
 * GET /api/audiobooks/book/<id>?tokens=1 -> { book, position, speed } with the parts' stream addresses (media token attached),
 * or null. Chapters are whole-book seconds; a part says where in the book it starts.
 */
export function normalizeBookDetail(body) {
  var b = body && typeof body === 'object' ? body : null
  if (!b || b.ok === false) return null
  var base = normalizeBook(b.book, b.progress)
  if (!base) return null
  var parts = []
  var ps = list(b.book && b.book.parts)
  for (var i = 0; i < ps.length && parts.length < 300; i++) {
    var p = ps[i]
    var url = p && typeof p === 'object' ? safeRelPath(p.stream) : null
    if (!url || !/^\/api\/audiobooks\/book\/[a-f0-9]{16}\/stream\/\d+(\?|$)/.test(url)) continue
    parts.push({ index: safeInt(p.index, parts.length) || 0, start: clampNumber(p.start, 0, 1e7, 0), duration: clampNumber(p.duration, 0, 1e7, 0), stream: url })
  }
  if (!parts.length) return null
  var chapters = []
  var cs = list(b.book && b.book.chapters)
  for (var j = 0; j < cs.length && chapters.length < 2000; j++) {
    var c = cs[j]
    if (!c || typeof c !== 'object') continue
    chapters.push({ title: str(c.title, 100) || 'Chapter ' + (chapters.length + 1), start: clampNumber(c.start, 0, 1e7, 0), end: clampNumber(c.end, 0, 1e7, 0) })
  }
  var pos = b.progress && typeof b.progress === 'object' && b.progress.finished !== true ? clampNumber(b.progress.position, 0, 1e7, 0) : 0
  return { book: base, parts: parts, chapters: chapters, position: pos, speed: clampNumber(b.speed, 0.5, 3, 1) }
}

/** The part of a book that holds a whole-book position, and the offset inside that part. */
export function locatePart(parts, position) {
  var pos = position > 0 ? position : 0
  var at = 0
  for (var i = 0; i < parts.length; i++) if (pos >= parts[i].start) at = i
  return { index: at, offset: Math.max(0, pos - parts[at].start) }
}

// ---- Podcasts ---------------------------------------------------------------------------------------------------------------

/** One episode from /latest, /continue or /show/<id> (asked with ?tokens=1 so `stream` carries its media token). */
export function normalizeEpisode(e) {
  if (!e || typeof e !== 'object') return null
  var key = typeof e.key === 'string' && /^[a-f0-9]{12}\.[a-f0-9]{16}$/.test(e.key) ? e.key : ''
  var stream = safeRelPath(e.stream)
  if (!key || !stream || stream.indexOf('/api/podcasts/episode/' + key + '/stream') !== 0) return null
  return {
    kind: 'podcast',
    key: key,
    id: key,
    title: str(e.title) || 'Episode',
    show: str(e.feedTitle, 100),
    durationSec: clampNumber(e.durationSec, 0, 1e6, 0),
    position: clampNumber(e.progressSec, 0, 1e6, 0),
    played: e.played === true,
    stream: stream
  }
}

/** /continue first (episodes already started), then the newest episodes, each once. */
export function normalizeEpisodeShelf(continueBody, latestBody) {
  var out = []
  var seen = {}
  var groups = [list(continueBody && continueBody.episodes), list(latestBody && latestBody.episodes)]
  for (var g = 0; g < groups.length; g++) {
    for (var i = 0; i < groups[g].length && out.length < 40; i++) {
      var e = normalizeEpisode(groups[g][i])
      if (e && !seen[e.key] && (g === 0 || !e.played)) { seen[e.key] = 1; out.push(e) }
    }
  }
  return out
}

// ---- Internet radio -----------------------------------------------------------------------------------------------------------

/** A station from /favorites, /recent or /browse. `id` is the server's own id ("rb:<uuid>" or "c:<12 hex>"). */
export function normalizeStation(s) {
  if (!s || typeof s !== 'object') return null
  var id = typeof s.id === 'string' && /^(rb:[0-9a-f-]{36}|c:[a-f0-9]{12})$/.test(s.id) ? s.id : ''
  if (!id) return null
  var tags = list(s.tags)
  var sub = str(s.country, 40)
  if (!sub && tags.length) sub = str(tags[0], 30)
  return { kind: 'radio', id: id, title: str(s.name, 100) || 'Station', sub: sub }
}

/** favourites, then recent, then (only if both are empty) the popular list; each station once. */
export function normalizeStationShelf(favBody, recentBody, popularBody) {
  var out = []
  var seen = {}
  var groups = [list(favBody && favBody.favorites), list(recentBody && recentBody.recent)]
  if (!groups[0].length && !groups[1].length) groups.push(list(popularBody && popularBody.stations))
  for (var g = 0; g < groups.length; g++) {
    for (var i = 0; i < groups[g].length && out.length < 40; i++) {
      var s = normalizeStation(groups[g][i])
      if (s && !seen[s.id]) { seen[s.id] = 1; out.push(s) }
    }
  }
  return out
}

/** POST /api/radio/play?tokens=1 -> { id, name, stream } or null. */
export function normalizeRadioSession(b) {
  var s = b && typeof b === 'object' && b.session && typeof b.session === 'object' ? b.session : null
  if (!s) return null
  var id = typeof s.id === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(s.id) ? s.id : ''
  var stream = safeRelPath(s.stream)
  if (!id || !stream || stream.indexOf('/api/radio/session/' + id + '/stream') !== 0) return null
  var st = s.station && typeof s.station === 'object' ? s.station : {}
  return { id: id, name: str(st.name, 100) || 'Radio', stream: stream, nowPlaying: nowPlaying(s) }
}

/** "Artist - Title" from a session's ICY metadata, or ''. */
export function nowPlaying(session) {
  var np = session && typeof session === 'object' ? session.nowPlaying : null
  if (!np || typeof np !== 'object') return ''
  var artist = str(np.artist, 80)
  var title = str(np.title, 120)
  if (artist && title) return artist + ' - ' + title
  return title || str(np.raw, 160)
}

/** GET /api/radio/session/<id> -> a short line for the screen. */
export function radioLine(body) {
  var s = body && typeof body === 'object' ? body.session : null
  if (!s || typeof s !== 'object') return ''
  var np = nowPlaying(s)
  if (np) return np
  if (s.state === 'reconnecting') return 'Reconnecting…'
  if (typeof s.error === 'string' && s.error) return 'The station is not answering.'
  return ''
}
