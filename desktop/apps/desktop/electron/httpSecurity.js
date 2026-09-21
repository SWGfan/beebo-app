'use strict'
// HTTP-level hardening for the home server's own pages and API (security review F5, F6, F11 and the
// header wrapper). Pure helpers with no dependency on streamServer.js so they can be tested alone.
//
//   Host policy    - which Host values this server answers to (DNS-rebinding guard, link building)
//   Cookies        - session cookie flags (HttpOnly, SameSite=Lax, Secure whenever the client is on TLS)
//   Cross-site     - one guard for cookie-authenticated state-changing requests
//   Headers        - CSP (report-only), Referrer-Policy, X-Content-Type-Options, frame-ancestors
const os = require('os')

// ------------------------------------------------------------------ Host ----

/** 'Foo.Example:47811' -> 'foo.example'; '[::1]:80' -> '::1'; anything odd -> ''. */
function hostnameOf(hostHeader) {
  let h = String(hostHeader == null ? '' : hostHeader).split(',')[0].trim().toLowerCase()
  if (!h || h.length > 255) return ''
  if (h.startsWith('[')) {
    const end = h.indexOf(']')
    if (end < 0) return ''
    const inner = h.slice(1, end)
    return /^[0-9a-f:.]+$/.test(inner) ? inner : ''
  }
  const colon = h.lastIndexOf(':')
  if (colon >= 0) {
    if (!/^\d{1,5}$/.test(h.slice(colon + 1))) return ''
    h = h.slice(0, colon)
  }
  h = h.replace(/\.$/, '')
  return /^[a-z0-9]([a-z0-9_-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9_-]*[a-z0-9])?)*$/.test(h) ? h : ''
}

const isIpv4 = (h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h)
const isIpLiteral = (h) => isIpv4(h) || (h.indexOf(':') >= 0 && /^[0-9a-f:.]+$/.test(h))
function isLoopbackHost(h) {
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '0:0:0:0:0:0:0:1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) || h === '::ffff:127.0.0.1'
}

// Names that only exist on a private network. A page on the public internet cannot make a browser
// send one of these as Host, so DNS rebinding cannot use them.
const LOCAL_SUFFIXES = ['.local', '.lan', '.home.arpa', '.internal', '.ts.net']

function cleanName(n) {
  return String(n || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30)
}

/** A configured public address ('https://media.example.com[:port]'), as { origin, host } or null. */
function parseBaseUrl(raw) {
  try {
    const u = new URL(String(raw || '').trim())
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    if (u.username || u.password) return null
    if (!hostnameOf(u.host)) return null
    return { origin: u.origin, host: u.host.toLowerCase(), hostname: u.hostname.toLowerCase().replace(/^\[|\]$/g, '') }
  } catch { return null }
}

/**
 * Every getter is optional and is read on each call (settings change while the server runs).
 *   getPublicName / getHouseName  the owner's <name> for <name>.beebo.tv and <name>.home.beebo.tv
 *   getCertDomain                 the DuckDNS / custom domain the certificate is for
 *   getPublicBaseUrl              owner setting 'publicBaseUrl': the address a reverse proxy serves us on
 *   getExtraHosts                 owner setting 'allowedHosts' (array of host names) and env BEEBO_ALLOWED_HOSTS
 *   getMachineName                this computer's name (tests override)
 */
function createHostPolicy({ getPublicName, getHouseName, getCertDomain, getPublicBaseUrl, getExtraHosts, getMachineName, env = process.env } = {}) {
  const call = (fn) => { try { return typeof fn === 'function' ? fn() : fn } catch { return undefined } }
  const machine = () => { try { return String((typeof getMachineName === 'function' ? getMachineName() : os.hostname()) || '').toLowerCase() } catch { return '' } }
  const envHosts = String(env.BEEBO_ALLOWED_HOSTS || '').split(',').map((s) => hostnameOf(s.trim())).filter(Boolean)
  const envBase = parseBaseUrl(env.BEEBO_PUBLIC_URL)

  function configuredBase() {
    return parseBaseUrl(call(getPublicBaseUrl)) || envBase
  }
  function isKnownHostname(h) {
    if (!h) return true // no Host at all (HTTP/1.0): nothing to echo, nothing a browser could rebind
    if (isIpLiteral(h) || isLoopbackHost(h)) return true
    if (h.indexOf('.') < 0) return true // a bare LAN name such as "mypc" cannot be a public site
    if (LOCAL_SUFFIXES.some((s) => h.endsWith(s))) return true
    const m = machine()
    if (m && (h === m || h === m + '.local')) return true
    return isOwnHostname(h)
  }
  // Names the owner (or the service) gave THIS server: <name>.beebo.tv, the certificate domain,
  // the configured public address, allowedHosts. Not LAN addresses, which any device could claim.
  function isOwnHostname(h) {
    if (!h) return false
    const names = [cleanName(call(getPublicName)), cleanName(call(getHouseName))].filter(Boolean)
    if (names.length) {
      for (const n of names) if (h === n + '.beebo.tv' || h === n + '.home.beebo.tv') return true
    } else if (h.endsWith('.beebo.tv')) {
      return true // name not registered yet: allow the service's own domain rather than lock the owner out
    }
    const cert = hostnameOf(String(call(getCertDomain) || ''))
    if (cert && h === cert) return true
    const base = configuredBase()
    if (base && h === base.hostname) return true
    const extra = [].concat(call(getExtraHosts) || [], envHosts).map((s) => hostnameOf(String(s || ''))).filter(Boolean)
    return extra.includes(h)
  }
  return {
    hostnameOf,
    isKnown: (hostHeader) => isKnownHostname(hostnameOf(hostHeader)) && (!String(hostHeader || '').trim() || !!hostnameOf(hostHeader)),
    isLoopback: (hostHeader) => isLoopbackHost(hostnameOf(hostHeader)),
    isOwnName: (hostHeader) => isOwnHostname(hostnameOf(hostHeader)),
    configuredBase
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Should this request be refused because of its Host? Only state-changing requests are gated: with
 * an unknown (public DNS) Host a browser that was rebound to this server could otherwise make
 * same-origin POSTs that pass the cross-site check. GETs stay open (they carry no cookie of ours
 * for a foreign name) so an unconfigured reverse proxy still browses, and the message says how
 * to fix it.
 */
function hostRejection(policy, req) {
  if (SAFE_METHODS.has(String(req.method || 'GET').toUpperCase())) return null
  if (policy.isKnown(req.headers && req.headers.host)) return null
  return {
    status: 421,
    body: { ok: false, error: 'unknown_host', message: 'This server does not answer to that address. Open it by its beebo.tv name, its LAN address, or set the public address in Beebo Settings.' }
  }
}

/**
 * The origin to put in a link, from the request's own Host only when that Host is one of ours
 * (or from the configured base). '' when there is nothing trustworthy to use: the caller then
 * falls back to its configured address. Loopback is never returned: a link to 127.0.0.1 is no use
 * to another device.
 */
function trustedOrigin(policy, req, { tlsActive = false } = {}) {
  const base = policy.configuredBase()
  if (base) return base.origin
  const hostHeader = String((req.headers && req.headers.host) || '').split(',')[0].trim()
  const hn = hostnameOf(hostHeader)
  if (!hn || policy.isLoopback(hostHeader) || !policy.isKnown(hostHeader)) return ''
  const viaProxyHttps = String((req.headers && req.headers['x-forwarded-proto']) || '').split(',')[0].trim().toLowerCase() === 'https'
  const https = !!(req.socket && req.socket.encrypted) || viaProxyHttps || !!tlsActive
  return (https ? 'https://' : 'http://') + hostHeader
}

/**
 * The Host to bounce a plain-HTTP request to over https: the request's own Host when it is one of
 * ours, else the configured certificate domain on the server's port, else '' (no redirect).
 */
function redirectHost(policy, hostHeader, fallbackDomain, port) {
  const h = String(hostHeader || '').trim()
  if (h && hostnameOf(h) && policy.isKnown(h)) return h
  const fb = hostnameOf(String(fallbackDomain || ''))
  return fb ? fb + ':' + port : ''
}

/** Only a path may follow the host in a redirect. */
function safeRequestPath(url) {
  const u = String(url || '/')
  return u.startsWith('/') && !u.startsWith('//') && !/[\r\n\\]/.test(u) ? u : '/'
}

/** Constant-time string equality (hashes both sides first, so length differences leak nothing). */
function safeEqual(a, b) {
  const crypto = require('crypto')
  const ha = crypto.createHash('sha256').update(String(a == null ? '' : a)).digest()
  const hb = crypto.createHash('sha256').update(String(b == null ? '' : b)).digest()
  return crypto.timingSafeEqual(ha, hb)
}

// ------------------------------------------------- data inside <script> ----

/**
 * JSON that is safe to write inside an inline <script> block: JSON.stringify leaves "<" alone, so a
 * title such as `</script><script>...` would end the script and start another one (stored XSS
 * through a file name or a metadata title). "<", ">", "&" and the JS line separators are written as
 * unicode escapes, which mean the same thing to JSON.parse and to a JavaScript literal.
 */
function jsonForScript(value) {
  const bs = String.fromCharCode(92)
  const esc = (ch) => bs + 'u' + ch.charCodeAt(0).toString(16).padStart(4, '0')
  const text = JSON.stringify(value === undefined ? null : value)
  return text.replace(new RegExp('[<>&' + String.fromCharCode(0x2028, 0x2029) + ']', 'g'), esc)
}

// --------------------------------------------------------------- Cookies ----

/** True when the browser reached us over TLS (directly, or through a proxy that says so). */
function isSecureRequest(req) {
  if (req && req.socket && req.socket.encrypted) return true
  const xfp = String((req && req.headers && req.headers['x-forwarded-proto']) || '').split(',')[0].trim().toLowerCase()
  return xfp === 'https'
}

/**
 * A cookie header value. HttpOnly and SameSite=Lax always; Secure whenever the connection is TLS.
 * (A `__Host-` prefix is intentionally not used: it would rename the session cookie clients and
 * tests already know, and it is refused over plain-http LAN access.)
 */
function buildCookie(req, name, value, { maxAge, path = '/', sameSite = 'Lax', httpOnly = true } = {}) {
  let c = `${name}=${value}; Path=${path}`
  if (maxAge != null) c += `; Max-Age=${Math.max(0, Math.floor(maxAge))}`
  if (httpOnly) c += '; HttpOnly'
  c += `; SameSite=${sameSite}`
  if (isSecureRequest(req)) c += '; Secure'
  return c
}

// ------------------------------------------------------------ Cross-site ----

/**
 * Is this browser request from another site? Sec-Fetch-Site is the browser's own word for it
 * ("same-origin" and "none" are ours; "same-site" counts as cross-site because every *.beebo.tv name
 * is same-site with every other). Without it, the Origin must be this Host, or one of this
 * server's own names (a request relayed through the away-from-home tunnel arrives under
 * 127.0.0.1 but still carries the browser's https://<name>.beebo.tv Origin). No Origin at all is
 * a non-browser client.
 */
function isCrossSite(headers, policy) {
  const h = headers || {}
  const site = String(h['sec-fetch-site'] || '').toLowerCase()
  if (site === 'same-origin' || site === 'none') return false
  if (site === 'cross-site' || site === 'same-site') return true
  const origin = h.origin
  if (!origin) return false
  if (origin === 'null') return true
  try {
    const u = new URL(String(origin))
    if (u.host.toLowerCase() === String(h.host || '').toLowerCase()) return false
    return !(policy && policy.isOwnName && policy.isOwnName(u.host))
  } catch { return true }
}

// A cross-site page can only send a POST with one of these content types without a CORS
// preflight (which this server never answers), and cannot add a custom header.
const SIMPLE_CONTENT_TYPE = /^(application\/x-www-form-urlencoded|multipart\/form-data|text\/plain)\b/

/**
 * The one guard for a state-changing request authenticated by the browser's session cookie.
 *   - a request the browser says came from another site is refused (403 cross_site);
 *   - with `strict`, a POST that a plain cross-site form could have sent (no content type, or a
 *     "simple" one) and that has no custom header (X-Beebo-CSRF / X-Requested-With) is refused
 *     (415). JSON, audio and binary bodies, and PUT/PATCH/DELETE, cannot be sent cross-site.
 * Returns null when fine, else { status, error }.
 */
function cookieWriteRejection(req, { strict = true, policy } = {}) {
  const headers = req.headers || {}
  if (isCrossSite(headers, policy)) return { status: 403, error: 'cross_site' }
  if (strict && String(req.method || '').toUpperCase() === 'POST') {
    const ct = String(headers['content-type'] || '').toLowerCase().trim()
    const custom = headers['x-beebo-csrf'] || headers['x-requested-with']
    if ((!ct || SIMPLE_CONTENT_TYPE.test(ct)) && !custom) return { status: 415, error: 'json_required' }
  }
  return null
}

// Cookie-authenticated website routes that are fetch()ed by the site's own scripts with a JSON or
// binary body: these also require a non-simple content type or the custom header.
const STRICT_COOKIE_WRITES = [
  /^\/history\/clear$/, /^\/library\/clear$/, /^\/upload\/(delete|begin|status|chunk|finish|cancel)$/,
  /^\/flag-unplayable$/, /^\/flag-quality$/, /^\/markers$/, /^\/progress$/,
  /^\/playlists\/api\//, /^\/playback-api\//, /^\/music-api\/recordings(\/|$)/
]

/**
 * How a cookie-authenticated request must be checked: null (a read; nothing to check),
 * 'strict' (cross-site + non-simple content type/custom header) or 'form' (cross-site check only:
 * plain HTML forms such as /upload, the admin pages and /school/... post like this).
 */
function classifyCookieWrite(method, pathname) {
  if (SAFE_METHODS.has(String(method || 'GET').toUpperCase())) return null
  return STRICT_COOKIE_WRITES.some((re) => re.test(pathname)) ? 'strict' : 'form'
}

// --------------------------------------------------------------- Headers ----

const CSP_REPORT_PATH = '/__csp-report'
// The server's own pages use inline styles and small inline scripts, so this policy starts
// report-only: it tells us (in the redacted log) what an enforcing policy would break.
const CSP_REPORT_ONLY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://image.tmdb.org https://img.youtube.com https://i.ytimg.com https://tile.openstreetmap.org",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
  'report-uri ' + CSP_REPORT_PATH
].join('; ')

/**
 * Headers every response from the home server carries. Set with setHeader before the route runs,
 * so a route's own writeHead still wins for the same name (and the media routes are unaffected).
 * `frame-ancestors` is enforced (Report-Only ignores it); the rest of the CSP reports only.
 */
function applySecurityHeaders(res, { tlsActive = false } = {}) {
  try {
    if (res.headersSent) return
    if (!res.getHeader('X-Content-Type-Options')) res.setHeader('X-Content-Type-Options', 'nosniff')
    if (!res.getHeader('Referrer-Policy')) res.setHeader('Referrer-Policy', 'same-origin')
    if (!res.getHeader('X-Frame-Options')) res.setHeader('X-Frame-Options', 'SAMEORIGIN')
    if (!res.getHeader('Content-Security-Policy')) res.setHeader('Content-Security-Policy', "frame-ancestors 'self'")
    if (!res.getHeader('Content-Security-Policy-Report-Only')) res.setHeader('Content-Security-Policy-Report-Only', CSP_REPORT_ONLY)
    void tlsActive
  } catch { /* headers are best effort */ }
}

/**
 * Handles POST /__csp-report: a browser's violation report goes to the (redacted) server log,
 * capped and rate-limited. -> true when it took over the response.
 */
function createCspReportHandler({ log, maxPerMinute = 30, now = () => Date.now() } = {}) {
  let windowStart = 0
  let count = 0
  return function handle(req, res, pathname) {
    if (pathname !== CSP_REPORT_PATH) return false
    if (String(req.method).toUpperCase() !== 'POST') { res.writeHead(405); res.end(); return true }
    const t = now()
    if (t - windowStart > 60000) { windowStart = t; count = 0 }
    const over = ++count > maxPerMinute
    let size = 0
    const chunks = []
    req.on('data', (c) => { size += c.length; if (size <= 8192) chunks.push(c) })
    req.on('end', () => {
      if (!over && typeof log === 'function') {
        try {
          const raw = Buffer.concat(chunks).toString('utf8')
          const j = JSON.parse(raw)
          const r = (j && (j['csp-report'] || (Array.isArray(j) && j[0] && j[0].body) || j)) || {}
          const pick = (k) => String(r[k] == null ? '' : r[k]).replace(/[\r\n]+/g, ' ').slice(0, 200)
          // Only the directive and the blocked/document origins, never a full URL with its query.
          const origin = (v) => { try { const u = new URL(v); return u.origin } catch { return String(v).slice(0, 40) } }
          log(`CSP report-only violation: ${pick('violated-directive') || pick('effectiveDirective')} blocked=${origin(pick('blocked-uri') || pick('blockedURL'))} page=${origin(pick('document-uri') || pick('documentURL'))}`)
        } catch { /* not JSON: ignore */ }
      }
      res.writeHead(204, { 'Cache-Control': 'no-store' })
      res.end()
    })
    return true
  }
}

module.exports = {
  hostnameOf, createHostPolicy, hostRejection, trustedOrigin, redirectHost, safeRequestPath, parseBaseUrl,
  isSecureRequest, buildCookie, cookieWriteRejection, classifyCookieWrite, isCrossSite, STRICT_COOKIE_WRITES, safeEqual, jsonForScript,
  CSP_REPORT_PATH, CSP_REPORT_ONLY, applySecurityHeaders, createCspReportHandler, SAFE_METHODS
}
