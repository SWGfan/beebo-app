'use strict'
// Opt-in CORS for packaged TV apps (Samsung Tizen / LG webOS).
//
// A packaged TV app runs from a file:// page, so its browser engine treats every call to
// the home server as cross-origin and blocks the answer unless the server sends
// Access-Control-Allow-* headers. This server sends none (the phone apps are not
// browsers), so the TV app cannot connect at all. The owner can switch this module on
// with the `tvAppCors` setting (Settings > "Allow TV apps (Samsung/LG) to connect").
// DEFAULT OFF. When off this module does nothing at all.
//
// When on, and only for a small allow-list of API routes (never anything under
// /api/admin, the vault, parental, school, api keys, ...):
//   * a CORS preflight (OPTIONS + Access-Control-Request-Method) is answered 204;
//   * the real request's answer (every status, so a TV app can read a 401 / 402 / 429)
//     carries Access-Control-Allow-Origin echoing the request's Origin (including the
//     literal `null` a file:// page sends) and Vary: Origin.
// NEVER Access-Control-Allow-Credentials: a browser will not hand the answer to a
// cross-origin page that sent cookies, so the cookie session is never usable cross-site;
// only a Bearer token (Authorization header) works. A request that carries a session
// cookie and no Bearer header gets no CORS headers at all, so a cross-site page cannot use
// a logged-in browser. See docs/TV-APP-CORS.md for the risk analysis.
//
// Media routes (/hls/*, /trickplay/*, /subtitles/*) authenticate with a signed ticket in
// the URL, carry no cookies, and already answer `Access-Control-Allow-Origin: *` on their
// own (playbackApi.js), with the setting on or off. They are intentionally not handled here.

const ALLOWED_HEADERS = 'authorization, content-type, x-beebo-client, x-beebo-download'
const ALLOWED_METHODS = 'GET, POST, OPTIONS'
const MAX_AGE = '600'

// Exactly this path (a trailing slash is tolerated), nothing beneath it.
const EXACT_ROUTES = new Set([
  '/api/ping', '/api/login', '/api/viewer-session', '/api/continue', '/api/recently-added',
  '/api/progress', '/api/markers', '/api/watch-session',
  // Read by the TV app itself (who am I, up next, next-episode context).
  '/api/me', '/api/upnext', '/api/episode-context'
])
// This path and anything beneath it (path + '/...').
const TREE_ROUTES = ['/api/v1', '/api/tvshows', '/api/movies', '/api/playlists', '/api/playback']

function normalizePath(pathname) {
  return String(pathname || '').replace(/\/+$/, '')
}
function routeAllowed(pathname) {
  const p = normalizePath(pathname)
  if (EXACT_ROUTES.has(p)) return true
  return TREE_ROUTES.some((root) => p === root || p.startsWith(root + '/'))
}
// scheme://host[:port], scheme:// (some engines send file://), or the literal "null".
const ORIGIN_RE = /^(null|[a-z][a-z0-9+.-]*:\/\/[^\s/\\?#]*)$/i
function cleanOrigin(value) {
  if (typeof value !== 'string') return ''
  const v = value.trim()
  return v.length > 0 && v.length <= 300 && ORIGIN_RE.test(v) ? v : ''
}
function hasBearer(req) {
  return /^Bearer[ \t]+\S+/i.test(String((req.headers && req.headers.authorization) || ''))
}
function hasCookie(req) {
  return String((req.headers && req.headers.cookie) || '').trim() !== ''
}

// Which Origin (if any) may be echoed for this request. '' = no CORS headers.
function allowedOrigin(req, pathname) {
  const origin = cleanOrigin(req && req.headers && req.headers.origin)
  if (!origin || !routeAllowed(pathname)) return ''
  // Cookie session without a Bearer token: never cross-origin.
  if (hasCookie(req) && !hasBearer(req)) return ''
  return origin
}

function withVaryOrigin(existing) {
  const list = String(existing || '').split(',').map((s) => s.trim()).filter(Boolean)
  if (list.includes('*')) return '*'
  if (!list.some((s) => s.toLowerCase() === 'origin')) list.push('Origin')
  return list.join(', ')
}

// Set the answer headers now, and make sure a route that passes its own headers object to
// writeHead() (with its own Vary) cannot drop Vary: Origin.
function decorate(res, origin) {
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Vary', withVaryOrigin(res.getHeader('Vary')))
  const original = res.writeHead
  res.writeHead = function corsWriteHead(status, ...rest) {
    const at = rest.findIndex((x) => x && typeof x === 'object')
    if (at >= 0 && !Array.isArray(rest[at])) {
      const merged = { ...rest[at] }
      const key = Object.keys(merged).find((k) => k.toLowerCase() === 'vary')
      if (key) merged[key] = withVaryOrigin(merged[key])
      rest[at] = merged
    }
    return original.call(this, status, ...rest)
  }
}

function preflight(res, origin) {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': ALLOWED_HEADERS,
    'Access-Control-Allow-Methods': ALLOWED_METHODS,
    'Access-Control-Max-Age': MAX_AGE,
    'Vary': 'Origin',
    'Content-Length': 0
  })
  res.end()
}

function create({ isEnabled } = {}) {
  const enabled = () => { try { return typeof isEnabled === 'function' && isEnabled() === true } catch { return false } }
  // Returns true when it answered the request itself (a preflight). Otherwise it may have
  // decorated `res`, and the caller carries on as normal.
  function intercept(req, res, url) {
    try {
      if (!enabled() || !req || !req.headers || !req.headers.origin) return false
      const pathname = (url && url.pathname) || ''
      const method = String(req.method || 'GET').toUpperCase()
      const isPreflight = method === 'OPTIONS' && !!req.headers['access-control-request-method']
      const origin = allowedOrigin(req, pathname)
      if (isPreflight) {
        if (origin) { preflight(res, origin); return true }
        // A preflight for an API route that is not on the list: refuse plainly, no CORS headers.
        if (normalizePath(pathname).startsWith('/api') && !routeAllowed(pathname) && !hasCookie(req)) {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          res.end('{"ok":false,"error":"cors_not_allowed"}')
          return true
        }
        return false
      }
      if (origin) decorate(res, origin)
      return false
    } catch {
      return false
    }
  }
  return { intercept, isEnabled: enabled }
}

module.exports = { create, routeAllowed, allowedOrigin, cleanOrigin, ALLOWED_HEADERS, ALLOWED_METHODS, MAX_AGE, EXACT_ROUTES, TREE_ROUTES }
