'use strict'
// Electron hardening for the main process (security review section 3). Everything here is plain
// logic over injected objects, so it is unit-tested without launching Electron (test/main-security.test.js).
//
//   isSafeExternalUrl   what may be handed to shell.openExternal (parsed https URL, not a bare startsWith)
//   createPolicy        which page URLs are "the app's own" (the packaged dist/index.html, or the dev server)
//   wrapIpcMain         every ipcMain.handle/on callback first checks event.senderFrame is the app's own page
//   guardWebContents    window.open, will-navigate, will-redirect, <webview> for every window
//   installSessionPolicy  permission request/check handlers (deny by default) + report-only CSP
const path = require('path')
const { fileURLToPath } = require('url')
const net = require('net')

// ------------------------------------------------------------ external URLs ----

/**
 * -> the normalised https URL, or null. https only, no credentials, a real DNS name (no IP
 * literals, no localhost / .local / single-label hosts: those would reach this PC or its LAN),
 * no control characters, and a sane length.
 */
function isSafeExternalUrl(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return null
  if (Array.from(raw).some((ch) => { const c = ch.charCodeAt(0); return c <= 32 || c === 127 })) return null // controls and whitespace
  let u
  try { u = new URL(raw) } catch { return null }
  if (u.protocol !== 'https:') return null
  if (u.username || u.password) return null
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host || net.isIP(host)) return null
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.indexOf('.') < 0) return null
  if (u.port && u.port !== '443') return null
  return u.href
}

// ------------------------------------------------------------- app origins ----

const samePath = (a, b) => (process.platform === 'win32' || process.platform === 'darwin'
  ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
  : path.resolve(a) === path.resolve(b))

/**
 *   distIndex      absolute path of the packaged renderer (dist/index.html)
 *   devUrl         dev-server URL, honoured only while getIsPackaged() is false
 *   getIsPackaged  () => boolean
 *   getLocalOrigin () => 'http://127.0.0.1:<port>' the media server the school/player windows show
 */
function createPolicy({ distIndex, devUrl, getIsPackaged = () => true, getLocalOrigin = () => '' } = {}) {
  const devOrigin = () => { try { return getIsPackaged() || !devUrl ? '' : new URL(devUrl).origin } catch { return '' } }

  /** The renderer of the app itself. */
  function isAppPageUrl(raw) {
    let u
    try { u = new URL(String(raw)) } catch { return false }
    if (u.protocol === 'file:') {
      if (u.hostname && u.hostname !== 'localhost') return false // no UNC / network file URLs
      try { return samePath(fileURLToPath(u), distIndex) } catch { return false }
    }
    const d = devOrigin()
    return !!d && u.origin === d
  }
  /** The local media server's own pages (BeeboSchool, the track-picking player): this exact origin only. */
  function isLocalServerUrl(raw) {
    let u
    try { u = new URL(String(raw)) } catch { return false }
    const o = getLocalOrigin()
    return !!o && u.origin === o
  }
  /** A message from a renderer: the top frame of a page that is the app's own. */
  function isTrustedSender(event) {
    try {
      const frame = event && event.senderFrame
      const contents = event && event.sender
      const url = frame && typeof frame.url === 'string' ? frame.url : (contents && contents.getURL ? contents.getURL() : '')
      if (!url || !isAppPageUrl(url)) return false
      // Sub-frames (an <iframe> inside the app page) are not the app.
      if (frame && contents && contents.mainFrame && frame !== contents.mainFrame) return false
      return true
    } catch { return false }
  }
  return { isAppPageUrl, isLocalServerUrl, isTrustedSender }
}

// ---------------------------------------------------------------------- IPC ----

/**
 * A stand-in for ipcMain: identical, except that every handle/handleOnce/on/once callback is
 * skipped (handle -> the caller's promise rejects; on -> ignored) unless isTrusted(event).
 * Modules that are handed this object need no change of their own.
 */
function wrapIpcMain(ipcMain, isTrusted, onDenied = () => {}) {
  const guard = (channel, fn, mode) => function guarded(event, ...args) {
    if (!isTrusted(event)) {
      try { onDenied(channel, event) } catch { /* logging never breaks a call */ }
      if (mode === 'handle') throw new Error('Blocked: this message did not come from the Beebo window.')
      return undefined
    }
    return fn.call(this, event, ...args)
  }
  const proxy = new Proxy(ipcMain, {
    get(target, prop) {
      if (prop === 'handle' || prop === 'handleOnce') return (channel, fn) => target[prop](channel, guard(channel, fn, 'handle'))
      if (prop === 'on' || prop === 'once' || prop === 'addListener') return (channel, fn) => { target[prop](channel, guard(channel, fn, 'on')); return proxy }
      const v = target[prop]
      return typeof v === 'function' ? v.bind(target) : v
    }
  })
  return proxy
}

// -------------------------------------------------------------- web contents ----

/**
 * Applies to every window the app makes (call from app.on('web-contents-created')).
 *   kind 'app'   : the React renderer (has the preload bridge): may only ever show the app's own page
 *   kind 'local' : windows onto the media server: may only ever show that exact origin
 * New windows are always denied; an https link is handed to the default browser instead.
 */
function guardWebContents(contents, { kind, policy, shell, log = () => {} }) {
  const allowed = (url) => (kind === 'app' ? policy.isAppPageUrl(url) : policy.isLocalServerUrl(url))
  const external = (url) => {
    const safe = isSafeExternalUrl(url)
    if (safe) { try { shell.openExternal(safe) } catch (e) { log('openExternal failed: ' + (e && e.message)) } } else log('blocked a link to ' + String(url).slice(0, 60))
  }
  contents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' } })
  const block = (event, url) => {
    if (allowed(url) || String(url).startsWith('devtools://')) return
    event.preventDefault()
    external(url)
  }
  contents.on('will-navigate', (event, url) => block(event, url))
  contents.on('will-redirect', (event, url) => block(event, url))
  contents.on('will-attach-webview', (event) => { event.preventDefault() }) // the app uses no <webview>
}

// ------------------------------------------------------------- permissions ----

// What a window may be granted. Nothing else: no camera, microphone, screen capture, location,
// notifications, MIDI, USB/HID/serial, or "open external app".
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen'])

const CSP_REPORT_ONLY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: http://127.0.0.1:* http://localhost:* https://image.tmdb.org https://*.tile.openstreetmap.org https://img.youtube.com https://i.ytimg.com",
  "media-src 'self' blob: http://127.0.0.1:*",
  "font-src 'self' data:",
  "connect-src 'self' http://127.0.0.1:* http://localhost:* ws://localhost:* https://*.beebo.tv https://beeboentertainment.com https://www.beeboentertainment.com https://api.themoviedb.org https://api.opensubtitles.com https://*.workers.dev",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ')

/**
 * session: an Electron Session. isOwnOrigin(url) says whether a requesting page is one of ours.
 * Denied requests are logged once per permission (log).
 */
function installSessionPolicy(session, { policy, log = () => {}, csp = CSP_REPORT_ONLY }) {
  const seen = new Set()
  const ours = (url) => !!url && (policy.isAppPageUrl(url) || policy.isLocalServerUrl(url))
  const note = (permission, url) => {
    if (seen.has(permission)) return
    seen.add(permission)
    log(`denied the "${permission}" permission (asked by ${String(url || '?').slice(0, 60)})`)
  }
  session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const url = (details && details.requestingUrl) || (webContents && webContents.getURL && webContents.getURL())
    const ok = ALLOWED_PERMISSIONS.has(permission) && ours(url)
    if (!ok) note(permission, url)
    callback(ok)
  })
  session.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    const url = (details && details.requestingUrl) || requestingOrigin || (webContents && webContents.getURL && webContents.getURL())
    return ALLOWED_PERMISSIONS.has(permission) && ours(url)
  })
  // Report-only CSP on the renderer's own responses; violations show up as console messages
  // ("[Report Only] Refused to ...") which main.js writes to the redacted main log.
  if (session.webRequest && typeof session.webRequest.onHeadersReceived === 'function') {
    session.webRequest.onHeadersReceived((details, callback) => {
      const headers = Object.assign({}, details.responseHeaders)
      if (policy.isAppPageUrl(details.url)) {
        headers['Content-Security-Policy-Report-Only'] = [csp]
        headers['Referrer-Policy'] = ['no-referrer']
        headers['X-Content-Type-Options'] = ['nosniff']
      }
      callback({ responseHeaders: headers })
    })
  }
}

/** A "[Report Only] Refused to ..." console message from a renderer -> one short log line, else ''. */
function cspViolationLine(message) {
  const m = String(message || '')
  if (!/Content Security Policy|Content-Security-Policy/i.test(m) || !/Refused to/i.test(m)) return ''
  return 'renderer CSP report-only: ' + m.replace(/\s+/g, ' ').slice(0, 300)
}

module.exports = {
  isSafeExternalUrl, createPolicy, wrapIpcMain, guardWebContents, installSessionPolicy,
  cspViolationLine, ALLOWED_PERMISSIONS, CSP_REPORT_ONLY
}
