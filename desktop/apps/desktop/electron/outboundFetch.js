'use strict'
// Outbound HTTP for things a person typed or subscribed to (podcast feeds and episodes, radio
// stations, directory lookups). Any address like that is an SSRF surface, so every request here
// follows the rules electron/webhooks.js set for its targets:
//
//   - the host is resolved and EVERY answer is judged (classifyAddress): link-local (cloud
//     metadata), multicast, reserved and "this network" are never reachable; loopback / RFC 1918 /
//     CGNAT / unique-local only when the caller says the owner allowed the local network;
//   - the connection is pinned to the addresses that were judged (no second lookup to rebind);
//   - redirects are followed by hand, at most maxRedirects of them, and each hop is resolved and
//     judged again, so a public page cannot bounce the request to 169.254.169.254 or 192.168.x.x;
//   - only http: and https:, no credentials in the URL, a time limit, and a byte limit;
//   - compressed answers are unpacked with the SAME byte limit applied to the unpacked size.
//
// Nothing here logs a URL's query string (feed URLs of private podcasts carry a token in it).

const http = require('http')
const https = require('https')
const net = require('net')
const tls = require('tls')
const zlib = require('zlib')
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const { Transform, PassThrough } = require('stream')
const { pipeline } = require('stream/promises')
const webhooks = require('./webhooks')
const safeFetch = require('./safeFetch')

let version = '0'
try { version = require('../package.json').version || '0' } catch {}
const USER_AGENT = `BeeboEntertainment/${version} (+https://www.beeboentertainment.com; podcasts and radio)`

const REDIRECT = new Set([301, 302, 303, 307, 308])
const DEFAULTS = Object.freeze({ timeoutMs: 15000, maxBytes: 5 * 1024 * 1024, maxRedirects: 5 })

class FetchError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'FetchError'
    this.code = code
    this.detail = detail || ''
  }
}

const bareHost = (hostname) => String(hostname || '').replace(/^\[|\]$/g, '')

function mapNetworkError(err) {
  if (err instanceof FetchError) return err
  const code = err && err.code ? String(err.code) : ''
  if (code === 'ECONNREFUSED') return new FetchError('connection_refused')
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new FetchError('unresolvable')
  if (code === 'ECONNRESET' || code === 'EPIPE') return new FetchError('connection_reset')
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return new FetchError('timeout')
  if (/CERT|SSL|TLS|ERR_TLS/i.test(code) || /certificate|self.signed/i.test(String(err && err.message))) return new FetchError('tls_error')
  return new FetchError('network_error', code.toLowerCase())
}

// One request to one already-judged address set. Resolves with the response (not read yet).
function hop({ url, addresses, method, headers, timeoutMs, lenientHttp }) {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === 'https:'
    const host = bareHost(url.hostname)
    const pinned = (_h, opts, cb) => {
      if (opts && opts.all) cb(null, addresses.map((a) => ({ address: a.address, family: a.family })))
      else cb(null, addresses[0].address, addresses[0].family)
    }
    let settled = false
    let req
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { req.destroy() } catch {}
      reject(new FetchError('timeout'))
    }, timeoutMs)
    if (timer.unref) timer.unref()
    try {
      req = (isHttps ? https : http).request({
        protocol: url.protocol,
        hostname: host,
        port: url.port || (isHttps ? 443 : 80),
        path: (url.pathname || '/') + (url.search || ''),
        method,
        headers,
        lookup: pinned,
        agent: false,
        // Internet radio: older Shoutcast servers answer "ICY 200 OK" and other loosely formed headers.
        ...(lenientHttp ? { insecureHTTPParser: true } : {}),
        ...(isHttps && !net.isIP(host) ? { servername: host } : {})
      })
    } catch (err) {
      clearTimeout(timer)
      reject(mapNetworkError(err))
      return
    }
    req.on('response', (res) => {
      if (settled) { res.destroy(); return }
      settled = true
      clearTimeout(timer)
      resolve({ res, req })
    })
    req.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(mapNetworkError(err))
    })
    req.end()
  })
}

// A plain-socket request for the servers whose answer Node's HTTP parser refuses outright: old Shoutcast
// v1 says "ICY 200 OK" instead of a real HTTP status line. HTTP/1.0 (so nothing is chunked), the head is
// parsed here with a size cap, and whatever follows it is the body. Same pinned addresses as hop().
function rawHop({ url, addresses, method, headers, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === 'https:'
    const host = bareHost(url.hostname)
    const pinned = (_h, opts, cb) => {
      if (opts && opts.all) cb(null, addresses.map((a) => ({ address: a.address, family: a.family })))
      else cb(null, addresses[0].address, addresses[0].family)
    }
    const opts = { host, port: Number(url.port) || (isHttps ? 443 : 80), lookup: pinned, ...(isHttps && !net.isIP(host) ? { servername: host } : {}) }
    const socket = isHttps ? tls.connect(opts) : net.connect(opts)
    let settled = false
    const timer = setTimeout(() => finish(new FetchError('timeout')), timeoutMs)
    if (timer.unref) timer.unref()
    function finish(err, value) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) { try { socket.destroy() } catch {} reject(err) } else resolve(value)
    }
    socket.on('error', (e) => finish(mapNetworkError(e)))
    socket.once(isHttps ? 'secureConnect' : 'connect', () => {
      const lines = [`${method} ${(url.pathname || '/') + (url.search || '')} HTTP/1.0`, `Host: ${url.host}`]
      for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${String(v).replace(/[\r\n]+/g, ' ')}`)
      socket.write(lines.join('\r\n') + '\r\nConnection: close\r\n\r\n')
    })
    let head = Buffer.alloc(0)
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk])
      const end = head.indexOf('\r\n\r\n')
      if (end === -1) { if (head.length > 16 * 1024) finish(new FetchError('bad_response')); return }
      socket.removeListener('data', onData)
      socket.pause()
      const lines = head.subarray(0, end).toString('latin1').split('\r\n')
      const status = /^(?:HTTP\/\d(?:\.\d)?|ICY)\s+(\d{3})/i.exec(lines[0])
      if (!status) { finish(new FetchError('bad_response')); return }
      const resHeaders = {}
      for (const l of lines.slice(1)) {
        const i = l.indexOf(':')
        if (i > 0) resHeaders[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim()
      }
      const res = new PassThrough()
      res.statusCode = Number(status[1])
      res.headers = resHeaders
      res.socket = socket
      const rest = head.subarray(end + 4)
      if (rest.length) res.write(rest)
      socket.pipe(res)
      socket.on('close', () => { if (!res.writableEnded) res.end() })
      res.on('close', () => { try { socket.destroy() } catch {} })
      finish(null, { res, req: { destroy: () => { try { socket.destroy() } catch {} } } })
    }
    socket.on('data', onData)
  })
}

/**
 * @param {object} [cfg]
 * @param {() => boolean | boolean} [cfg.allowPrivateNetwork]  may this fetcher reach the owner's own network?
 * @param {string} [cfg.userAgent]
 * @param {Function} [cfg.resolve]  replaces webhooks.resolveTarget (tests)
 */
function createFetcher(cfg = {}) {
  const userAgent = cfg.userAgent || USER_AGENT
  const resolve = cfg.resolve || webhooks.resolveTarget
  const allowPrivate = (o) => {
    if (o && typeof o.allowPrivateNetwork === 'boolean') return o.allowPrivateNetwork
    try { return typeof cfg.allowPrivateNetwork === 'function' ? cfg.allowPrivateNetwork() === true : cfg.allowPrivateNetwork === true } catch { return false }
  }

  // Follows redirects (each hop judged again) and returns { status, headers, stream, url, close }.
  async function open(rawUrl, o = {}) {
    const maxRedirects = o.maxRedirects != null ? o.maxRedirects : DEFAULTS.maxRedirects
    const timeoutMs = o.timeoutMs || DEFAULTS.timeoutMs
    let current = String(rawUrl)
    for (let i = 0; i <= maxRedirects; i++) {
      // A fixed-host service (a directory API): safeFetch's rules on every hop, including redirects: https only,
      // port 443, no credentials, and the host must be on the list. Anything else never gets resolved.
      if (Array.isArray(o.allowHosts) && !safeFetch.vetUrl(current, o.allowHosts)) throw new FetchError('blocked_url')
      const target = await resolve(current, { allowPrivateNetwork: allowPrivate(o) })
      if (!target.ok) throw new FetchError(target.error, target.address || target.detail)
      const headers = { 'User-Agent': userAgent, Accept: '*/*', ...(o.headers || {}) }
      const hopArgs = { url: target.url, addresses: target.addresses, method: o.method || 'GET', headers, timeoutMs, lenientHttp: o.lenientHttp === true }
      let got
      try {
        got = await hop(hopArgs)
      } catch (err) {
        // A status line Node cannot parse ("ICY 200 OK"): once more, reading the answer by hand.
        if (o.lenientHttp === true && err instanceof FetchError && /^hpe_/.test(err.detail || '')) got = await rawHop(hopArgs)
        else throw err
      }
      const { res, req } = got
      if (REDIRECT.has(res.statusCode) && res.headers.location) {
        res.resume()
        try { req.destroy() } catch {}
        try { current = new URL(res.headers.location, target.url).toString() } catch { throw new FetchError('bad_redirect') }
        continue
      }
      return { status: res.statusCode || 0, headers: res.headers, stream: res, url: target.url.toString(), close: () => { try { req.destroy() } catch {} } }
    }
    throw new FetchError('too_many_redirects')
  }

  // Whole answer into memory, capped. Sends Accept-Encoding and unpacks under the same cap.
  async function get(rawUrl, o = {}) {
    const maxBytes = o.maxBytes || DEFAULTS.maxBytes
    const timeoutMs = o.timeoutMs || DEFAULTS.timeoutMs
    let active = null
    let timedOut = false
    const deadline = setTimeout(() => { timedOut = true; if (active) active.close() }, timeoutMs)
    if (deadline.unref) deadline.unref()
    try {
      const r = await open(rawUrl, { ...o, timeoutMs, headers: { 'Accept-Encoding': 'gzip, deflate, br', ...(o.headers || {}) } })
      active = r
      if (r.status === 304 || r.status === 204) { r.close(); return { status: r.status, headers: r.headers, body: Buffer.alloc(0), url: r.url } }
      const declared = Number(r.headers['content-length'])
      if (Number.isFinite(declared) && declared > maxBytes && !r.headers['content-encoding']) { r.close(); throw new FetchError('too_large') }
      let source = r.stream
      const enc = String(r.headers['content-encoding'] || '').toLowerCase().trim()
      let unpack = null
      if (enc === 'gzip' || enc === 'x-gzip') unpack = zlib.createGunzip()
      else if (enc === 'deflate') unpack = zlib.createInflate()
      else if (enc === 'br') unpack = zlib.createBrotliDecompress()
      else if (enc && enc !== 'identity') { r.close(); throw new FetchError('unsupported_encoding', enc) }
      const chunks = []
      let size = 0
      const sink = new Transform({
        transform(chunk, _e, cb) {
          size += chunk.length
          if (size > maxBytes) cb(new FetchError('too_large'))
          else { chunks.push(chunk); cb() }
        }
      })
      try {
        if (unpack) await pipeline(source, unpack, sink)
        else await pipeline(source, sink)
      } catch (err) {
        r.close()
        throw timedOut ? new FetchError('timeout') : mapNetworkError(err)
      }
      return { status: r.status, headers: r.headers, body: Buffer.concat(chunks), url: r.url }
    } catch (err) {
      throw timedOut ? new FetchError('timeout') : mapNetworkError(err)
    } finally {
      clearTimeout(deadline)
    }
  }

  // Streams the answer to `file` (via file.part, then a rename). Refuses a non-200 answer, a body
  // over maxBytes, and, when `accept(headers)` says no, the wrong kind of content.
  async function download(rawUrl, file, o = {}) {
    const maxBytes = o.maxBytes || 500 * 1024 * 1024
    const timeoutMs = o.timeoutMs || 30 * 60 * 1000
    let active = null
    let timedOut = false
    const deadline = setTimeout(() => { timedOut = true; if (active) active.close() }, timeoutMs)
    if (deadline.unref) deadline.unref()
    const part = file + '.part'
    try {
      const r = await open(rawUrl, { ...o, timeoutMs: Math.min(timeoutMs, o.connectTimeoutMs || 20000), headers: { 'Accept-Encoding': 'identity', ...(o.headers || {}) } })
      active = r
      if (r.status !== 200) { r.close(); throw new FetchError('http_status', String(r.status)) }
      if (typeof o.accept === 'function' && !o.accept(r.headers)) { r.close(); throw new FetchError('wrong_type') }
      const declared = Number(r.headers['content-length'])
      if (Number.isFinite(declared) && declared > maxBytes) { r.close(); throw new FetchError('too_large') }
      await fsp.mkdir(path.dirname(file), { recursive: true })
      let size = 0
      // A server that sends a byte a minute would otherwise keep the (single) download slot for the whole 30
      // minutes, so nothing else could download behind it: no data for idleTimeoutMs ends the download.
      const idleMs = o.idleTimeoutMs || 60000
      let idleTimer = null
      const arm = () => {
        clearTimeout(idleTimer)
        idleTimer = setTimeout(() => { timedOut = true; r.close() }, idleMs)
        if (idleTimer.unref) idleTimer.unref()
      }
      arm()
      const limiter = new Transform({
        transform(chunk, _e, cb) {
          size += chunk.length
          if (size > maxBytes) cb(new FetchError('too_large'))
          else { arm(); cb(null, chunk) }
        }
      })
      try {
        await pipeline(r.stream, limiter, fs.createWriteStream(part, { flags: 'w' }))
      } catch (err) {
        r.close()
        throw timedOut ? new FetchError('timeout') : mapNetworkError(err)
      } finally {
        clearTimeout(idleTimer)
      }
      if (size === 0) throw new FetchError('empty')
      await fsp.rename(part, file)
      return { size, headers: r.headers, url: r.url }
    } catch (err) {
      await fsp.rm(part, { force: true }).catch(() => {})
      throw timedOut ? new FetchError('timeout') : mapNetworkError(err)
    } finally {
      clearTimeout(deadline)
    }
  }

  return { open, get, download, userAgent }
}

module.exports = { createFetcher, FetchError, USER_AGENT, DEFAULTS }
