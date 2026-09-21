'use strict'
// What the service worker (served at /sw.js, see pwa.js) is allowed to touch. This is the only part of it
// that makes a decision, so it is a plain module with no browser or Node dependencies: the SAME two
// functions below are unit-tested here and are pasted, via Function.prototype.toString, into the worker's
// source. Keep them free of closures (everything they need arrives in `cfg`) and of syntax the oldest iOS
// we care about (15) cannot run, since the worker is plain script and is not transpiled.
//
// The rule is "leave everything alone unless it is on a short list":
//   'static'   an icon or the offline page: served from a versioned cache (cache first)
//   'navigate' a page navigation: always asks the network; the cache is never consulted or written. Only
//              when the network itself fails does the worker answer, with the offline page
//   'bypass'   the worker does not call respondWith at all, so the browser does exactly what it would do
//              with no worker: API calls, media, HLS pieces, Range requests, uploads, anything with a token
// Nothing here can make a signed-in page, an API answer, a stream or a token URL land in a cache, because
// the only responses ever written are the ones canStore() approves for a path on the static allowlist.

const VERSION = 1 // bump when the worker or its cached files change; it is part of every cache name

const CONFIG = Object.freeze({
  version: VERSION,
  cachePrefix: 'beebo-pwa-',
  // Exact paths, no query string. The only things ever cached.
  staticPaths: Object.freeze(['/pwa/offline', '/pwa/icon-192.png', '/pwa/icon-432.png', '/pwa/apple-touch-icon.png']),
  // Fetched and stored when the worker installs. Kept tiny on purpose.
  precache: Object.freeze(['/pwa/offline', '/pwa/icon-192.png']),
  // Never answered by the worker, even for a navigation. Prefixes are matched on the lower-cased path
  // with repeated slashes collapsed, so `//API/x` and `/Api/x` cannot slip past.
  neverPrefixes: Object.freeze([
    '/api/', '/playback-api/', '/music-api/', '/photos-api/', '/hls/', '/subtitles/', '/trickplay/', '/download/', '/media/',
    '/watch', '/tvwatch', '/file', '/tvfile', '/upload', '/progress', '/heartbeat', '/health', '/_rtc/',
    '/logout', '/verify', '/reset-password', '/sw.js', '/manifest.webmanifest'
  ]),
  // Any request carrying one of these query parameters is a credential or a signed link.
  tokenParams: Object.freeze(['mt', 'token', 'access_token', 'ticket', 'sig', 'signature', 'key', 'code', 'auth'])
})

/** Decide what the worker does with one request. req: { url, method, hasRange }; cfg: CONFIG plus { origin }. */
function decide(req, cfg) {
  if (!req || String(req.method).toUpperCase() !== 'GET') return 'bypass'
  if (req.hasRange) return 'bypass'
  var u
  try { u = new URL(req.url) } catch (e) { return 'bypass' }
  if (u.origin !== cfg.origin) return 'bypass'
  var path = u.pathname.toLowerCase().replace(/\/{2,}/g, '/')
  var i
  if (path === '/api' || /^\/[a-z0-9-]+-api(\/|$)/.test(path)) return 'bypass' // /api, /playback-api, /music-api, any future *-api
  for (i = 0; i < cfg.neverPrefixes.length; i++) {
    var p = cfg.neverPrefixes[i]
    // A prefix ending in "/" matches the folder; one without matches the exact path and anything below it
    // ("/watch" and "/watch/x", but not "/watchlist").
    if (p.charAt(p.length - 1) === '/' ? path.indexOf(p) === 0 : (path === p || path.indexOf(p + '/') === 0)) return 'bypass'
  }
  if (/\.json$/.test(path)) return 'bypass' // data, never a page
  var keys = Array.from(u.searchParams.keys())
  for (i = 0; i < keys.length; i++) {
    if (cfg.tokenParams.indexOf(keys[i].toLowerCase()) >= 0) return 'bypass'
  }
  if (u.search === '' && cfg.staticPaths.indexOf(u.pathname) >= 0) return 'static'
  if (req.mode === 'navigate') return 'navigate'
  return 'bypass'
}

/**
 * May this response be written to the static cache? path is the request's pathname; type is response.type.
 * A response that sets a cookie is never stored (browsers hide Set-Cookie from scripts, so this is belt and
 * braces: the static files never send one, and a test holds them to it).
 */
function canStore(path, status, type, contentType, setCookie) {
  if (status !== 200 || type !== 'basic' || setCookie) return false
  var ct = String(contentType || '').toLowerCase()
  if (path === '/pwa/offline') return ct.indexOf('text/html') === 0
  return /\.png$/.test(path) && ct.indexOf('image/png') === 0
}

module.exports = { VERSION, CONFIG, decide, canStore }
