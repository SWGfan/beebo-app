'use strict'
// HTTP for trip sharing. streamServer.js only forwards here; the rules live in tripShares.js
// (storage, links) and tripSharePage.js (what a page may say), so all of it is testable without the
// 700 KB server.
//
//  - handlePublic: /trip/<token> and /trip/<token>/m/<n>, plus /robots.txt. No sign-in: the token in
//    the address is the credential. GET/HEAD only, rate limited per viewer address, and a token that is
//    unknown, expired or revoked gets the same answer.
//  - handle: /api/trip-shares/*, signed-in phones (and the PC window) managing their own trips and links.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { createTripShares, TOKEN_RE } = require('./tripShares')
const { renderPage, renderUnavailable, CSP } = require('./tripSharePage')
const { cleanPhoto } = require('./tripShareMedia')

const servicesByStore = new WeakMap()

/** One trip-share service per settings store, shared by the web server and the PC window. */
function tripShareServices(store, opts = {}) {
  let s = servicesByStore.get(store)
  if (s) return s
  const dataDir = opts.dataDir || (store && store.path ? path.join(path.dirname(store.path), 'trip-shares') : path.join(os.tmpdir(), 'beebo-trip-shares'))
  s = { shares: createTripShares({ dataDir, log: opts.log, autoSweep: opts.autoSweep !== false }), dataDir }
  servicesByStore.set(store, s)
  return s
}

/**
 * A fixed-window counter per key (a viewer address). take() counts one event and says whether it is
 * still allowed; peek() only reads. The key table is bounded so a flood of addresses cannot grow it.
 */
function createRateLimiter({ windowMs, max, now = Date.now, maxKeys = 5000 }) {
  const table = new Map()
  const fresh = (key) => {
    const e = table.get(key)
    if (e && now() - e.start < windowMs) return e
    if (e) table.delete(key)
    return null
  }
  function trim() {
    if (table.size <= maxKeys) return
    for (const [k, e] of table) if (now() - e.start >= windowMs) table.delete(k)
    if (table.size > maxKeys) {
      let drop = Math.ceil(table.size / 2)
      for (const k of table.keys()) { table.delete(k); if (--drop <= 0) break }
    }
  }
  return {
    take(key) {
      let e = fresh(key)
      if (!e) { trim(); e = { start: now(), count: 0 }; table.set(key, e) }
      e.count++
      return e.count <= max
    },
    peek(key) { const e = fresh(key); return e ? e.count : 0 },
    blocked(key) { return this.peek(key) >= max },
    retryAfterSec(key) { const e = fresh(key); return e ? Math.max(1, Math.ceil((e.start + windowMs - now()) / 1000)) : 1 },
    size: () => table.size
  }
}

// Failed lookups (a guessed or dead token) are the ones that matter most, so they get a small budget.
const defaultLimits = {}
function defaultLimiters() {
  if (!defaultLimits.all) {
    defaultLimits.all = createRateLimiter({ windowMs: 60 * 1000, max: 600 })
    defaultLimits.bad = createRateLimiter({ windowMs: 10 * 60 * 1000, max: 20 })
  }
  return defaultLimits
}

const SECURITY_HEADERS = {
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'same-origin'
}

const MAX_CLEANING = 6 // photos being cleaned / sent from memory at once
let cleaningNow = 0

const ROUTE = /^\/trip\/([A-Za-z0-9_-]{43})(?:\/m\/(\d{1,4}))?\/?$/

const claimsPublic = (pathname) => pathname === '/trip' || pathname.startsWith('/trip/') || pathname === '/robots.txt'

function sendText(res, status, body, type, extra = {}) {
  const buf = Buffer.from(body, 'utf8')
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': buf.length, ...SECURITY_HEADERS, ...extra })
  res.end(buf)
}

const sendPage = (req, res, status, html, extra = {}) => {
  const buf = Buffer.from(html, 'utf8')
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-store',
    'Content-Security-Policy': CSP, 'X-Frame-Options': 'DENY', ...SECURITY_HEADERS, ...extra
  })
  res.end(req.method === 'HEAD' ? undefined : buf)
}

/** Stream a file with single-range support so a clip can seek. */
function streamFile(req, res, full, size, mime, extra = {}) {
  const head = { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Content-Disposition': 'inline', 'Content-Security-Policy': "default-src 'none'; sandbox", ...SECURITY_HEADERS, ...extra }
  const range = req.headers.range
  const pipe = (opts) => {
    const rs = fs.createReadStream(full, { ...opts, highWaterMark: 1 << 20 })
    res.on('close', () => rs.destroy())
    rs.on('error', () => { try { res.destroy() } catch {} })
    rs.pipe(res)
  }
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim())
    const suffix = m && !m[1] && m[2] ? Number(m[2]) : null
    const start = suffix !== null ? Math.max(0, size - suffix) : m && m[1] ? Number(m[1]) : 0
    const end = suffix !== null ? size - 1 : m && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
    if (!m || (!m[1] && !m[2]) || suffix === 0 || start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}`, ...SECURITY_HEADERS }); res.end(); return
    }
    res.writeHead(206, { ...head, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 })
    if (req.method === 'HEAD') { res.end(); return }
    pipe({ start, end })
    return
  }
  res.writeHead(200, { ...head, 'Content-Length': size })
  if (req.method === 'HEAD') { res.end(); return }
  pipe({})
}

/**
 * Public routes. [ctx]: { services, clientIp(req), now? }. Returns after answering.
 */
async function handlePublic(ctx, req, res, url) {
  const p = url.pathname
  const method = req.method
  if (p === '/robots.txt') {
    sendText(res, 200, 'User-agent: *\nDisallow: /\n', 'text/plain; charset=utf-8', { 'Cache-Control': 'public, max-age=86400' })
    return
  }
  const lim = ctx.limiters || defaultLimiters()
  const ip = String(ctx.clientIp(req) || 'unknown')
  if (method !== 'GET' && method !== 'HEAD') {
    req.resume()
    sendText(res, 405, 'Method not allowed', 'text/plain; charset=utf-8', { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' })
    return
  }
  if (!lim.all.take(ip) || lim.bad.blocked(ip)) {
    sendText(res, 429, 'Too many requests. Please wait a few minutes.', 'text/plain; charset=utf-8', { 'Retry-After': String(lim.bad.blocked(ip) ? lim.bad.retryAfterSec(ip) : lim.all.retryAfterSec(ip)), 'Cache-Control': 'no-store' })
    return
  }
  const unavailable = () => {
    lim.bad.take(ip)
    sendPage(req, res, 404, renderUnavailable())
  }
  const m = ROUTE.exec(p)
  if (!m) { unavailable(); return } // no directory listing, no other path under /trip/
  const shares = ctx.services.shares
  const share = shares.resolve(m[1])
  if (!share) { unavailable(); return }

  if (m[2] === undefined) {
    const data = await shares.shareData(share)
    if (!data) { unavailable(); return }
    shares.noteView(share)
    const token = m[1]
    const html = renderPage({ page: data.page, mediaRefs: data.mediaRefs, expiresAt: share.expiresAt, options: share.options }, (i) => `/trip/${token}/m/${i}`)
    sendPage(req, res, 200, html)
    return
  }

  const file = await shares.mediaFile(share, Number(m[2]))
  if (!file) { unavailable(); return }
  const cache = { 'Cache-Control': 'private, max-age=300' }
  if (file.kind === 'photo' && !share.options.includeLocation) {
    // A link made without location serves every photo with its metadata removed, whatever was stored.
    // The whole photo is held in memory while it is cleaned and sent, so only a few at a time: anyone holding a link
    // could otherwise open hundreds of slow connections and use up this PC's memory.
    if (cleaningNow >= MAX_CLEANING) {
      sendText(res, 503, 'Busy. Please try again in a moment.', 'text/plain; charset=utf-8', { 'Retry-After': '2', 'Cache-Control': 'no-store' })
      return
    }
    cleaningNow++
    let released = false
    const release = () => { if (!released) { released = true; cleaningNow-- } }
    res.on('close', release)
    let clean
    try { clean = cleanPhoto(await fs.promises.readFile(file.full), file.mime) } catch (e) { release(); throw e }
    if (!clean) { unavailable(); return }
    res.writeHead(200, { 'Content-Type': file.mime, 'Content-Length': clean.length, 'Content-Disposition': 'inline', 'Content-Security-Policy': "default-src 'none'; sandbox", ...SECURITY_HEADERS, ...cache })
    res.end(method === 'HEAD' ? undefined : clean)
    return
  }
  streamFile(req, res, file.full, file.size, file.mime, cache)
}

/* --------------------------------- signed-in API --------------------------------- */

async function readJson(req, limit = 1024 * 1024) {
  const parts = []
  let total = 0
  for await (const c of req) {
    total += c.length
    if (total > limit) { const e = new Error('too_large'); e.status = 413; e.code = 'too_large'; throw e }
    parts.push(c)
  }
  const raw = Buffer.concat(parts).toString('utf8')
  if (!raw) return {}
  try { const v = JSON.parse(raw); return v && typeof v === 'object' && !Array.isArray(v) ? v : {} } catch { const e = new Error('bad_json'); e.status = 400; e.code = 'bad_json'; throw e }
}

function sendError(ctx, e) {
  const status = e.status || 500
  if (status === 500 && ctx.log) ctx.log('trip shares api error: ' + (e.stack || e.message))
  ctx.send(status, { ok: false, error: e.status ? (typeof e.code === 'string' && e.code ? e.code : e.message) : 'server_error', ...(e.status ? e.extra || {} : {}) })
}

/**
 * Signed-in routes. [ctx]: { services, send(status,obj), log, canShare(user), linkOrigin() }.
 * A user may manage only their own trips and links; the owner (isAdmin) may see and turn off any.
 */
async function handle(ctx, req, res, url, p, method, user) {
  const svc = ctx.services.shares
  res.setHeader('Cache-Control', 'no-store')
  const owner = !!user && user.isAdmin === true
  const only = (...ms) => { if (ms.includes(method)) return true; req.resume(); ctx.send(405, { ok: false, error: 'method_not_allowed' }); return false }
  if (!user || user.guest || !ctx.canShare(user)) { req.resume(); ctx.send(403, { ok: false, error: 'trip_share_not_allowed' }); return }
  try {
    switch (p) {
      case '/api/trip-shares/status': {
        if (!only('GET')) return
        const origin = ctx.linkOrigin()
        ctx.send(200, {
          ok: true, owner, settings: svc.settings(), usage: await svc.usage(), chunkSize: 512 * 1024,
          linkBase: origin, reachableAnywhere: /^https:\/\//.test(origin)
        })
        return
      }
      case '/api/trip-shares/settings': {
        if (!only('POST')) return
        if (!owner) { req.resume(); ctx.send(403, { ok: false, error: 'owner_only' }); return }
        ctx.send(200, { ok: true, settings: svc.setSettings(await readJson(req, 16 * 1024)) })
        return
      }
      case '/api/trip-shares/check':
        if (!only('POST')) return
        ctx.send(200, await svc.check(user, await readJson(req)))
        return
      case '/api/trip-shares/media/begin':
        if (!only('POST')) return
        ctx.send(200, await svc.begin(user, await readJson(req, 16 * 1024)))
        return
      case '/api/trip-shares/media/chunk':
        if (!only('POST', 'PUT')) return
        ctx.send(200, await svc.chunk(user, req, url.searchParams))
        return
      case '/api/trip-shares/media/status':
        if (!only('GET')) return
        ctx.send(200, await svc.status(user, url.searchParams.get('uploadId') || ''))
        return
      case '/api/trip-shares/media/finish':
        if (!only('POST')) return
        ctx.send(200, await svc.finish(user, await readJson(req, 16 * 1024)))
        return
      case '/api/trip-shares': {
        if (!only('GET', 'POST')) return
        if (method === 'GET') {
          ctx.send(200, { ok: true, shares: svc.list(user, { all: url.searchParams.get('all') === '1' && owner }) })
          return
        }
        const out = await svc.createShare(user, await readJson(req))
        const origin = ctx.linkOrigin()
        ctx.send(200, { ...out, url: origin + out.path, reachableAnywhere: /^https:\/\//.test(origin) })
        return
      }
      case '/api/trip-shares/trips':
        if (!only('GET')) return
        ctx.send(200, { ok: true, trips: await svc.packages(user, { all: url.searchParams.get('all') === '1' && owner }), usage: await svc.usage() })
        return
      case '/api/trip-shares/revoke':
        if (!only('POST')) return
        ctx.send(200, await svc.revoke(user, (await readJson(req, 4096)).id))
        return
      case '/api/trip-shares/extend': {
        if (!only('POST')) return
        const body = await readJson(req, 4096)
        ctx.send(200, await svc.extend(user, body.id, body.hours))
        return
      }
      case '/api/trip-shares/delete':
        if (!only('POST')) return
        ctx.send(200, await svc.removeShare(user, (await readJson(req, 4096)).id))
        return
      case '/api/trip-shares/trip/delete': {
        if (!only('POST')) return
        const body = await readJson(req, 4096)
        ctx.send(200, await svc.deleteTrip(user, body.pkg && owner ? { pkg: body.pkg } : { tripId: body.tripId }))
        return
      }
      default:
        req.resume()
        ctx.send(404, { ok: false, error: 'not_found' })
    }
  } catch (e) { sendError(ctx, e) }
}

module.exports = { tripShareServices, createRateLimiter, handlePublic, handle, claimsPublic, ROUTE, TOKEN_RE }
