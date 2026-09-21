// Movie Night contract for the TV apps. DOM-free.
//
// The TV app does NOT draw the games itself: the Beebo server serves the shared screen as a web page
// (desktop/apps/desktop/electron/movieNightWeb.js, docs/MOVIE-NIGHT.md). The app's job is:
//   1. ask the server whether Movie Night is available          GET  /api/movie-night/status        (Bearer)
//   2. start a room as the signed-in person                     POST /api/movie-night/tv/create     (Bearer)
//        -> { ok, code, ticket, tvPath: '/movie-night/tv', hash: 'k=<ticket>' }
//   3. open <server origin> + tvPath + '#' + hash in the TV's own web view
// The reply is DATA from the network: this file checks it before the app navigates anywhere. The address it
// builds is always on the server the person already chose, on exactly one path, with a ticket that has the
// shape the server makes, so a wrong or hostile reply can never send the TV somewhere else.

export var TV_PATH = '/movie-night/tv'
var TICKET_RE = /^[A-Za-z0-9_-]{32}$/
var CODE_RE = /^[2-9A-HJ-NP-Z]{6}$/

export var movieNightRoutes = {
  status: function () { return { path: '/api/movie-night/status' } },
  create: function () { return { path: '/api/movie-night/tv/create' } }
}

/** GET /api/movie-night/status reply -> { available, reason, message } (always safe to show). */
export function normalizeStatus(body) {
  var b = body && typeof body === 'object' ? body : {}
  var reason = typeof b.reason === 'string' ? b.reason.slice(0, 40) : ''
  var message = typeof b.message === 'string' ? cleanLine(b.message, 200) : ''
  return { available: b.available === true, reason: reason, message: message }
}

/**
 * The create reply -> { ok:true, url, code } for a reply that is exactly what the server sends, else { ok:false }.
 * `origin` is the server the person already connected to (scheme://host[:port], no path).
 */
export function tvUrlFromReply(origin, body) {
  var b = body && typeof body === 'object' ? body : null
  if (!b || b.ok !== true) return { ok: false }
  if (typeof origin !== 'string' || !/^https?:\/\/[^/?#\s@\\]+$/i.test(origin)) return { ok: false }
  if (b.tvPath !== TV_PATH) return { ok: false }
  if (typeof b.ticket !== 'string' || !TICKET_RE.test(b.ticket)) return { ok: false }
  if (b.hash !== 'k=' + b.ticket) return { ok: false }
  return { ok: true, url: origin + TV_PATH + '#k=' + b.ticket, code: typeof b.code === 'string' && CODE_RE.test(b.code) ? b.code : '' }
}

/** Is this address one the app may open for Movie Night? Same origin, the TV path, and (optionally) a ticket fragment. */
export function isMovieNightUrl(origin, url) {
  if (typeof origin !== 'string' || typeof url !== 'string') return false
  var base = origin + TV_PATH
  if (url === base) return true
  if (url.indexOf(base + '#k=') !== 0) return false
  return TICKET_RE.test(url.slice(base.length + 3))
}

/** What to tell the person when the server says no. */
export function explainFailure(err) {
  var status = err && err.status
  if (err && err.body && typeof err.body.message === 'string' && err.body.message) return safeLine(err.body.message)
  if (status === 401) return 'This TV is no longer signed in.'
  if (status === 403) return 'Movie Night works on the home Wi-Fi. Connect this TV to it and try again.'
  if (status === 404) return 'Movie Night is not available on this server. Update Beebo on the computer, or ask the owner to turn it on.'
  if (status === 429) return 'Too many Movie Nights were started just now. Wait a minute and try again.'
  if (err && err.friendly) return err.friendly
  return 'Could not start Movie Night.'
}

// Control, bidi and separator characters become spaces (written with char codes so no escape can be misread).
function cleanLine(s, max) {
  var str = String(s)
  var out = ''
  for (var i = 0; i < str.length && out.length < max; i++) {
    var c = str.charCodeAt(i)
    out += c < 32 || (c >= 127 && c <= 159) || (c >= 8232 && c <= 8238) ? ' ' : str.charAt(i)
  }
  return out
}

function safeLine(s) {
  return cleanLine(s, 200)
}
