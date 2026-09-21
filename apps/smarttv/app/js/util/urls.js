// Server address parsing and route/URL building. DOM-free.
//
// The routes below are the EXISTING Beebo home-server routes (desktop/apps/desktop/electron/
// streamServer.js + playbackApi.js) - the same ones the Android app uses, authenticated with
// "Authorization: Bearer <token>". Only /tvpair/* (see ../pairing.js) is new and assumed.

import { isSafeRelPath } from './escape.js'

export var DEFAULT_PORT = 47811

/** "192.168.1.20" / "10.x" / "172.16-31.x" / "169.254.x" / "100.64-127.x" (Tailscale) / localhost. */
export function isPrivateHost(host) {
  var h = String(host || '').toLowerCase()
  if (h === 'localhost' || h === '127.0.0.1' || h === '[::1]') return true
  var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!m) return false
  var a = parseInt(m[1], 10)
  var b = parseInt(m[2], 10)
  if (a === 10 || a === 127) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 169 && b === 254) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  return false
}

function isIPv4(host) {
  var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return false
  for (var i = 1; i <= 4; i++) if (parseInt(m[i], 10) > 255) return false
  return true
}

function isDnsName(host) {
  if (host.length > 253) return false
  var labels = host.split('.')
  for (var i = 0; i < labels.length; i++) {
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(labels[i])) return false
  }
  return true
}

/**
 * Turn what someone typed with a remote into a server origin.
 *
 *   "192.168.1.20"            -> http://192.168.1.20:47811   (private LAN address: plain http, as the
 *                                 server serves LAN clients over http, see streamServer.js)
 *   "192.168.1.20:8080"       -> http://192.168.1.20:8080
 *   "nick"                    -> https://nick.home.beebo.tv:47811   (Beebo name -> direct home address,
 *                                 docs/HOME-ADDRESS.md)
 *   "nick.beebo.tv"           -> https://nick.home.beebo.tv:47811   (the beebo.tv page itself is the
 *                                 WebRTC viewer, not an HTTP API a TV can call - see README)
 *   "https://x.example:47811" -> as typed; "http://<non-LAN host>" is upgraded to https
 *
 * Returns { ok:true, origin, host, port, secure, kind } or { ok:false, error }.
 * Paths, queries and credentials are refused/stripped: an address must never carry a token.
 */
export function normalizeServerAddress(input) {
  var raw = String(input === null || input === undefined ? '' : input).trim()
  if (!raw) return { ok: false, error: 'empty' }
  if (raw.length > 200) return { ok: false, error: 'too_long' }
  if (/\s/.test(raw)) return { ok: false, error: 'invalid' }

  var scheme = ''
  var rest = raw
  var sm = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw)
  if (sm) {
    scheme = sm[1].toLowerCase()
    if (scheme !== 'http' && scheme !== 'https') return { ok: false, error: 'scheme' }
    rest = raw.slice(sm[0].length)
  }
  if (rest.indexOf('@') >= 0) return { ok: false, error: 'credentials' }
  // Anything after the first "/" (path) is ignored; "?" and "#" are refused outright.
  if (/[?#]/.test(rest)) return { ok: false, error: 'invalid' }
  var slash = rest.indexOf('/')
  var hostPort = slash >= 0 ? rest.slice(0, slash) : rest
  var tail = slash >= 0 ? rest.slice(slash) : ''
  if (tail.length > 1) return { ok: false, error: 'path' }

  var host = hostPort
  var port = null
  var pm = /^(.*):(\d{1,5})$/.exec(hostPort)
  if (pm) {
    host = pm[1]
    port = parseInt(pm[2], 10)
    if (!(port >= 1 && port <= 65535)) return { ok: false, error: 'port' }
  } else if (hostPort.indexOf(':') >= 0) {
    return { ok: false, error: 'invalid' } // bare IPv6 / stray colon: not supported in v1
  }
  host = host.toLowerCase().replace(/\.$/, '')
  if (!host) return { ok: false, error: 'invalid' }

  var kind = 'lan'
  if (isIPv4(host)) {
    kind = isPrivateHost(host) ? 'lan' : 'ip'
  } else if (host === 'localhost') {
    kind = 'lan'
  } else if (/^\d+(\.\d+)*$/.test(host)) {
    return { ok: false, error: 'invalid' } // digits and dots but not a valid IPv4
  } else {
    if (!isDnsName(host)) return { ok: false, error: 'invalid' }
    if (host.indexOf('.') < 0) {
      // A bare Beebo name.
      host = host + '.home.beebo.tv'
      kind = 'beebo-name'
    } else if (/^[a-z0-9-]+\.beebo\.tv$/.test(host) && host !== 'www.beebo.tv') {
      host = host.replace(/\.beebo\.tv$/, '.home.beebo.tv')
      kind = 'beebo-name'
    } else if (/\.home\.beebo\.tv$/.test(host)) {
      kind = 'beebo-name'
    } else {
      kind = 'dns'
    }
  }

  // Plain http only ever goes to a private LAN address (the server serves LAN clients over http).
  // Anything else - even if typed as http:// - is upgraded to https.
  var secure = kind === 'lan' ? scheme === 'https' : true
  if (port === null) port = DEFAULT_PORT
  var defaultPortForScheme = secure ? 443 : 80
  var origin = (secure ? 'https://' : 'http://') + host + (port === defaultPortForScheme ? '' : ':' + port)
  return { ok: true, origin: origin, host: host, port: port, secure: secure, kind: kind }
}

/** Percent-encode a query object; skips null/undefined/''. Keys are sorted for stable tests. */
export function buildQuery(params) {
  if (!params) return ''
  var keys = Object.keys(params).sort()
  var out = []
  for (var i = 0; i < keys.length; i++) {
    var v = params[keys[i]]
    if (v === null || v === undefined || v === '') continue
    out.push(encodeURIComponent(keys[i]) + '=' + encodeURIComponent(String(v)))
  }
  return out.length ? '?' + out.join('&') : ''
}

/** origin + "/api/..." path + query. `path` must be a server-relative path. */
export function buildUrl(origin, path, params) {
  if (!isSafeRelPath(path)) throw new Error('unsafe path')
  return String(origin).replace(/\/+$/, '') + path + buildQuery(params)
}

/**
 * Turn a server-relative path from an API response (poster, stream, hls url) into a full URL.
 * Returns '' for anything that is not a safe relative path.
 */
export function assetUrl(origin, relPath) {
  if (!isSafeRelPath(relPath)) return ''
  return String(origin).replace(/\/+$/, '') + relPath
}

// --- API route table (one place; mirrors the Android app's contract) --------------------------

export var routes = {
  ping: function () { return { path: '/api/ping' } },
  health: function () { return { path: '/health' } },
  login: function () { return { path: '/api/login' } },
  me: function () { return { path: '/api/me' } },
  // Paged public API (electron/publicApi.js): { ok, total, limit, offset, items } , limit <= 500.
  libraryMovies: function (o) { return { path: '/api/v1/library/movies', query: { q: o && o.q, limit: o && o.limit, offset: o && o.offset } } },
  libraryTvShows: function (o) { return { path: '/api/v1/library/tvshows', query: { q: o && o.q, limit: o && o.limit, offset: o && o.offset } } },
  // Unpaged legacy routes (the phone app's): the whole list in one answer. Fallback only.
  movies: function (o) { return { path: '/api/movies', query: { q: o && o.q, genre: o && o.genre, sort: o && o.sort, limit: o && o.limit, offset: o && o.offset } } },
  tvShows: function (o) { return { path: '/api/tvshows', query: { q: o && o.q, genre: o && o.genre, limit: o && o.limit, offset: o && o.offset } } },
  episodes: function (showKey) { return { path: '/api/tvshows/' + encodeURIComponent(showKey) + '/episodes' } },
  continueWatching: function () { return { path: '/api/continue' } },
  recentlyAdded: function () { return { path: '/api/recently-added' } },
  upNext: function (kind, id) { return { path: '/api/upnext', query: { kind: kind === 'tv' ? 'tv' : 'movie', id: id } } },
  episodeContext: function (id) { return { path: '/api/episode-context', query: { kind: 'tv', id: id } } },
  playbackInfo: function (kind, id) { return { path: '/api/playback/info', query: { kind: kind === 'tv' ? 'tv' : 'movie', id: id } } },
  playbackStart: function () { return { path: '/api/playback/start' } },
  playbackStop: function () { return { path: '/api/playback/stop' } },
  watchSession: function () { return { path: '/api/watch-session' } },
  progress: function () { return { path: '/api/progress' } }
}

export function routeUrl(origin, route) {
  return buildUrl(origin, route.path, route.query)
}

/**
 * Remove anything secret-ish from a URL before it is logged or shown: media tokens (mt), API/pair
 * tokens, HLS tickets (path segment after /hls/) and user codes. Used by every log/error path.
 */
export function redactUrl(u) {
  var s = String(u === null || u === undefined ? '' : u)
  s = s.replace(/([?&](?:mt|token|t|access_token|code|device_code|user_code|sig)=)[^&#]*/gi, '$1[redacted]')
  s = s.replace(/(\/hls\/)[^/]+/i, '$1[redacted]')
  return s
}

/** The public origin (scheme+host+port) of a URL string, or ''. */
export function originOf(u) {
  var m = /^(https?:\/\/[^/?#]+)/i.exec(String(u || ''))
  return m ? m[1].toLowerCase() : ''
}
