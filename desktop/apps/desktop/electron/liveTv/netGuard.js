'use strict'
// ============================================================================
// netGuard.js - what Live TV is allowed to talk to.
// ----------------------------------------------------------------------------
// Live TV only ever contacts a network tuner on the owner's own LAN. So:
//   * a tuner address must be a plain IPv4 literal (no host names: nothing to resolve, nothing to
//     rebind), and must be private (RFC 1918) or link-local. Anything else - this PC's loopback, a
//     public address, carrier-grade NAT space - is refused unless the owner explicitly typed it and
//     confirmed, and addresses that are never a tuner (0.0.0.0, multicast, broadcast, the cloud
//     metadata address) are refused outright.
//   * requests to a tuner never follow a redirect, are size-capped and time-capped, and only go to
//     the fixed documented paths. Nothing the device says (BaseURL, LineupURL, per-channel URL)
//     is ever used as an address: URLs are always built from the address the owner approved.
//   * the optional guide download (XMLTV) resolves the host itself, refuses private addresses unless
//     the owner confirmed, connects to the address it checked, and re-checks every redirect.
// ============================================================================

const dns = require('dns')
const http = require('http')
const https = require('https')
const zlib = require('zlib')
const { embeddedIPv4 } = require('../ipEmbedded')

function parseIPv4(text) {
  const s = String(text == null ? '' : text).trim()
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return null
  const parts = s.split('.')
  const out = []
  for (const p of parts) {
    if (p.length > 1 && p[0] === '0') return null
    const n = Number(p)
    if (!(n >= 0 && n <= 255)) return null
    out.push(n)
  }
  return out
}

/** 'lan' | 'linklocal' | 'loopback' | 'cgnat' | 'public' | 'blocked' for an IPv4 or IPv6 literal. */
function classifyIp(text) {
  const s = String(text == null ? '' : text).trim().toLowerCase()
  const v4 = parseIPv4(s)
  if (v4) return classifyV4(v4)
  if (s.includes(':')) {
    // An IPv4 address wearing an IPv6 coat (::ffff:7f00:1, ::7f00:1, NAT64, 6to4: a URL parser writes the
    // hex form) is judged as the IPv4 address it carries, or "http://[::ffff:7f00:1]/" was "public".
    const inner = embeddedIPv4(s)
    if (inner) { const m = parseIPv4(inner); return m ? classifyV4(m) : 'blocked' }
    if (s === '::1') return 'loopback'
    if (s === '::') return 'blocked'
    if (/^f[cd][0-9a-f]{2}:/.test(s) || /^fe[c-f][0-9a-f]:/.test(s)) return 'lan' // unique-local, and the old site-local range
    if (/^fe[89ab][0-9a-f]:/.test(s)) return 'linklocal'
    if (/^ff[0-9a-f]{2}:/.test(s)) return 'blocked'
    return 'public'
  }
  return 'blocked'
}

function classifyV4([a, b, c, d]) {
  if (a === 0 || a >= 224) return 'blocked'
  if (a === 169 && b === 254) return c === 169 && d === 254 ? 'blocked' : 'linklocal'
  if (a === 127) return 'loopback'
  if (a === 10) return 'lan'
  if (a === 172 && b >= 16 && b <= 31) return 'lan'
  if (a === 192 && b === 168) return 'lan'
  if (a === 100 && b >= 64 && b <= 127) return 'cgnat'
  return 'public'
}

const isLan = (klass) => klass === 'lan' || klass === 'linklocal'

/**
 * Checks an address the owner typed (or that answered a broadcast) before anything is sent to it.
 * -> { ok: true, ip, port, klass } | { ok: false, error, needsConfirm?, message }
 */
function validateTunerTarget(input, { confirmNonLan = false } = {}) {
  const raw = input && typeof input === 'object' ? input : { host: input }
  const hostRaw = raw.host !== undefined ? raw.host : raw.ip
  const ip = typeof hostRaw === 'string' ? hostRaw.trim() : ''
  if (!parseIPv4(ip)) {
    return { ok: false, error: 'bad_address', message: 'Enter the tuner’s IP address, like 192.168.1.50 (its name on the network is not accepted).' }
  }
  let port = 80
  if (raw.port !== undefined && raw.port !== null && raw.port !== '') {
    port = Number(raw.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: 'bad_port', message: 'That port number is not valid.' }
  }
  const klass = classifyIp(ip)
  if (klass === 'blocked') return { ok: false, error: 'blocked_address', message: 'That address can never be a tuner.' }
  if (!isLan(klass) && confirmNonLan !== true) {
    return {
      ok: false, error: 'not_on_lan', needsConfirm: true, klass,
      message: klass === 'loopback'
        ? 'That address is this computer itself, not a tuner on your network. Beebo only talks to tuners on your home network.'
        : 'That address is not on your home network (it is not a private 192.168.x.x, 10.x.x.x or 172.16-31.x.x address). Beebo only talks to tuners on your home network unless you explicitly confirm it.'
    }
  }
  return { ok: true, ip, port, klass }
}

class GuardError extends Error {
  constructor(code, message) { super(message || code); this.code = code }
}

/** GET a small JSON document from an approved tuner address. No redirects, no big bodies, no waiting forever. */
function getJson(ip, port, pathname, { timeoutMs = 4000, maxBytes = 2 * 1024 * 1024, method = 'GET', requestImpl = http.request } = {}) {
  return new Promise((resolve, reject) => {
    if (!parseIPv4(ip) || !/^\/[A-Za-z0-9_./?=&-]*$/.test(pathname)) { reject(new GuardError('bad_request')); return }
    let settled = false
    const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v) } }
    const req = requestImpl({ host: ip, port, path: pathname, method, agent: false, headers: { Accept: 'application/json', 'User-Agent': 'Beebo-LiveTV', 'Content-Length': '0' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); done(reject, new GuardError(res.statusCode >= 300 && res.statusCode < 400 ? 'redirect' : 'http_' + res.statusCode)); req.destroy(); return }
      const chunks = []
      let size = 0
      res.on('data', (c) => {
        size += c.length
        if (size > maxBytes) { done(reject, new GuardError('too_large')); req.destroy(); return }
        chunks.push(c)
      })
      res.on('end', () => {
        try {
          const v = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (v === null || typeof v !== 'object') throw new Error('not json object')
          done(resolve, v)
        } catch { done(reject, new GuardError('bad_json')) }
      })
      res.on('error', () => done(reject, new GuardError('network')))
    })
    const timer = setTimeout(() => { done(reject, new GuardError('timeout')); req.destroy() }, timeoutMs)
    if (timer.unref) timer.unref()
    req.on('error', () => done(reject, new GuardError('network')))
    req.end()
  })
}

// ------------------------------------------------------------- guide download
function parseGuideUrl(text) {
  let u
  try { u = new URL(String(text || '').trim()) } catch { return null }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (u.username || u.password) return null
  return u
}

async function resolveChecked(hostname, { allowPrivate }) {
  const literal = hostname.replace(/^\[|\]$/g, '')
  let addrs
  if (parseIPv4(literal) || literal.includes(':')) addrs = [{ address: literal, family: literal.includes(':') ? 6 : 4 }]
  else {
    try { addrs = await dns.promises.lookup(literal, { all: true }) } catch { throw new GuardError('dns', 'That address could not be found.') }
  }
  if (!addrs.length) throw new GuardError('dns', 'That address could not be found.')
  for (const a of addrs) {
    const klass = classifyIp(a.address)
    if (klass === 'blocked') throw new GuardError('blocked_address', 'That address is not allowed.')
    if (klass !== 'public' && !allowPrivate) throw new GuardError('private_address', 'That address is on your own network. Confirm it if that is really where your guide file lives.')
  }
  return addrs[0]
}

/**
 * Downloads the guide file (XMLTV, optionally gzipped). The owner supplied the URL; even so it is
 * resolved here, checked, and connected to by the address that was checked, up to 3 redirects.
 */
async function fetchGuideUrl(urlText, { allowPrivate = false, maxBytes = 64 * 1024 * 1024, timeoutMs = 60000, redirects = 3, lookupImpl = resolveChecked, requestImpls = { 'http:': http.request, 'https:': https.request } } = {}) {
  let current = parseGuideUrl(urlText)
  if (!current) throw new GuardError('bad_url', 'Enter a web address that starts with http:// or https://.')
  for (let hop = 0; hop <= redirects; hop++) {
    const target = await lookupImpl(current.hostname, { allowPrivate })
    const res = await new Promise((resolve, reject) => {
      const secure = current.protocol === 'https:'
      const req = requestImpls[current.protocol]({
        host: target.address, port: current.port || (secure ? 443 : 80), path: current.pathname + current.search, method: 'GET', agent: false,
        headers: { Host: current.host, 'User-Agent': 'Beebo-LiveTV', 'Accept-Encoding': 'gzip', Accept: 'application/xml,text/xml,*/*' },
        ...(secure ? { servername: current.hostname } : {})
      }, resolve)
      const timer = setTimeout(() => req.destroy(new GuardError('timeout', 'The guide download took too long.')), timeoutMs)
      if (timer.unref) timer.unref()
      req.on('close', () => clearTimeout(timer))
      req.on('error', (e) => reject(e instanceof GuardError ? e : new GuardError('network', 'The guide could not be downloaded.')))
      req.end()
    })
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume()
      const next = parseGuideUrl(new URL(res.headers.location, current).toString())
      if (!next) throw new GuardError('bad_url', 'The guide address redirected somewhere that is not allowed.')
      current = next
      continue
    }
    if (res.statusCode !== 200) { res.resume(); throw new GuardError('http_' + res.statusCode, 'The guide server answered with an error (' + res.statusCode + ').') }
    const chunks = []
    let size = 0
    await new Promise((resolve, reject) => {
      res.on('data', (c) => { size += c.length; if (size > maxBytes) { reject(new GuardError('too_large', 'The guide file is too large.')); res.destroy(); return } chunks.push(c) })
      res.on('end', resolve)
      res.on('error', () => reject(new GuardError('network', 'The guide download was interrupted.')))
    })
    return gunzipIfNeeded(Buffer.concat(chunks), maxBytes * 4)
  }
  throw new GuardError('too_many_redirects', 'The guide address redirected too many times.')
}

function gunzipIfNeeded(buf, maxOutput = 256 * 1024 * 1024) {
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try { return zlib.gunzipSync(buf, { maxOutputLength: maxOutput }) } catch { throw new GuardError('bad_gzip', 'The guide file is damaged or too large.') }
  }
  return buf
}

module.exports = { parseIPv4, classifyIp, isLan, validateTunerTarget, getJson, fetchGuideUrl, gunzipIfNeeded, parseGuideUrl, GuardError }
