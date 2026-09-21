'use strict'
// HTTP GET for the importer's own servers (a Jellyfin, Emby or Plex the owner points us at).
//
// The address comes from a person typing it into a form, and the person is the owner of this
// machine, so a server on the home network (192.168.x.x, 127.0.0.1) is exactly what is expected.
// What must NOT be possible is using this as a way to reach things the owner did not mean:
//
//   - only http and https, no user:password@ in the address, sane ports;
//   - the name is resolved HERE, every answer is checked, and the socket is then opened to the
//     address that was checked (so the name cannot change its answer between the check and the
//     connection: no DNS rebinding);
//   - never link-local (169.254.x.x, fe80::, which is where cloud metadata services live), never
//     "this host" (0.0.0.0, ::), multicast or broadcast; `publicOnly` (used for plex.tv) also
//     refuses loopback and private ranges;
//   - redirects are NOT followed (a 3xx is an error), so a server cannot bounce the request, and
//     the access key with it, somewhere else;
//   - time and size limits, and the credential only ever travels in a header, never in the address.
//
// Errors are short codes ('timeout', 'blocked_address', 'http_401' ...). They never contain the
// address, the headers or any part of the response body.

const http = require('http')
const https = require('https')
const dns = require('dns')
const net = require('net')

const DEFAULT_TIMEOUT_MS = 25000
const DEFAULT_MAX_BYTES = 48 * 1024 * 1024

class FetchError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status || 0 }
}

function ipv4Parts(ip) {
  const p = ip.split('.').map(Number)
  return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? p : null
}

/** 'loopback' | 'private' | 'public' | 'blocked' for one literal IP address. */
function classifyAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ipv4Parts(ip)
    if (a === 0) return 'blocked' // "this host"
    if (a === 169 && b === 254) return 'blocked' // link-local, cloud metadata
    if (a >= 224) return 'blocked' // multicast, reserved, broadcast
    if (a === 127) return 'loopback'
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return 'private'
    return 'public'
  }
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase()
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(low)
    if (mapped) return classifyAddress(mapped[1])
    if (low === '::' || low === '::0') return 'blocked'
    if (low === '::1') return 'loopback'
    if (/^fe[89ab]/.test(low)) return 'blocked' // link-local
    if (/^ff/.test(low)) return 'blocked' // multicast
    if (/^f[cd]/.test(low)) return low.startsWith('fd00:ec2') ? 'blocked' : 'private' // unique local; AWS metadata
    return 'public'
  }
  return 'blocked'
}

/**
 * Parses and vets an address. Returns the URL, or throws FetchError('bad_address').
 * Accepts a bare "192.168.1.5:8096" (http is assumed), which is how people type these.
 */
function parseBaseUrl(raw) {
  let text = String(raw == null ? '' : raw).trim()
  if (!text || text.length > 300 || /[\s\0]/.test(text)) throw new FetchError('bad_address')
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = 'http://' + text
  let url
  try { url = new URL(text) } catch { throw new FetchError('bad_address') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new FetchError('bad_address')
  if (url.username || url.password) throw new FetchError('bad_address')
  if (!url.hostname) throw new FetchError('bad_address')
  if (url.port && (Number(url.port) < 1 || Number(url.port) > 65535)) throw new FetchError('bad_address')
  // The query and fragment are ours to add; a pasted address that carries them (often with a
  // token in it) is refused so the token cannot end up in a log line.
  if (url.search || url.hash) throw new FetchError('bad_address')
  return url
}

function resolveChecked(hostname, { publicOnly, lookup }) {
  const host = hostname.replace(/^\[|\]$/g, '')
  const check = (addrs) => {
    if (!addrs.length) throw new FetchError('unresolved')
    for (const a of addrs) {
      const c = classifyAddress(a.address)
      if (c === 'blocked') throw new FetchError('blocked_address')
      if (publicOnly && c !== 'public') throw new FetchError('blocked_address')
    }
    return addrs[0]
  }
  if (net.isIP(host)) return Promise.resolve(check([{ address: host, family: net.isIPv4(host) ? 4 : 6 }]))
  const doLookup = lookup || ((h, cb) => dns.lookup(h, { all: true, verbatim: true }, cb))
  return new Promise((resolve, reject) => {
    doLookup(host, (err, addrs) => {
      if (err) return reject(new FetchError('unresolved'))
      try { resolve(check(Array.isArray(addrs) ? addrs : [{ address: addrs, family: net.isIPv4(addrs) ? 4 : 6 }])) } catch (e) { reject(e) }
    })
  })
}

/**
 * GET `pathAndQuery` on `base` and parse the JSON body.
 * @param {string|URL} base   already vetted with parseBaseUrl (or a string, which is vetted here)
 * @param {string} pathAndQuery  starts with "/"
 * @param {{ headers?, timeoutMs?, maxBytes?, publicOnly?, insecureTls?, lookup? }} opts
 * @returns {Promise<any>} the parsed JSON
 */
async function getJson(base, pathAndQuery, opts = {}) {
  const url = base instanceof URL ? new URL(base.href) : parseBaseUrl(base)
  if (typeof pathAndQuery !== 'string' || !pathAndQuery.startsWith('/')) throw new FetchError('bad_address')
  const prefix = url.pathname.replace(/\/+$/, '')
  const target = new URL(prefix + pathAndQuery, url.origin)
  const addr = await resolveChecked(url.hostname, { publicOnly: !!opts.publicOnly, lookup: opts.lookup })
  const secure = url.protocol === 'https:'
  const mod = secure ? https : http
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS
  const maxBytes = opts.maxBytes || DEFAULT_MAX_BYTES
  const isLocal = classifyAddress(addr.address) !== 'public'
  return new Promise((resolve, reject) => {
    let settled = false
    let timer = null
    const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v) } }
    const req = mod.request({
      protocol: url.protocol,
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port || (secure ? 443 : 80),
      path: target.pathname + target.search,
      method: 'GET',
      headers: { accept: 'application/json', 'user-agent': 'BeeboMigration/1', ...(opts.headers || {}) },
      // Connect to the address that was vetted, whatever the name would resolve to now.
      lookup: (_h, _o, cb) => (_o && _o.all ? cb(null, [{ address: addr.address, family: addr.family }]) : cb(null, addr.address, addr.family)),
      // A self-signed certificate is normal on a home server; allowed only for a private address
      // and only when the person ticked the box.
      rejectUnauthorized: !(opts.insecureTls === true && secure && isLocal)
    }, (res) => {
      const status = res.statusCode || 0
      if (status >= 300 && status < 400) { res.resume(); return done(reject, new FetchError('redirect_refused', status)) }
      if (status < 200 || status >= 300) { res.resume(); return done(reject, new FetchError('http_' + status, status)) }
      const chunks = []
      let size = 0
      res.on('data', (c) => {
        size += c.length
        if (size > maxBytes) { req.destroy(); return done(reject, new FetchError('too_big')) }
        chunks.push(c)
      })
      res.on('end', () => {
        try { done(resolve, JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { done(reject, new FetchError('not_json')) }
      })
      res.on('error', () => done(reject, new FetchError('network')))
    })
    timer = setTimeout(() => { req.destroy(); done(reject, new FetchError('timeout')) }, timeoutMs)
    req.on('error', (err) => done(reject, new FetchError(err && /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|HOSTNAME/i.test(String(err.code || err.message)) ? 'tls_untrusted' : 'network')))
    req.end()
  })
}

/** A short, safe explanation for an error code, for screens and logs. Never includes the address. */
function explain(code) {
  const c = String(code || '')
  if (/^http_401$|^http_403$/.test(c)) return 'The server refused the key. Check that it is correct and still active.'
  if (c === 'http_404') return 'The server answered, but not with the page expected. Check the address and port.'
  if (/^http_5/.test(c)) return 'The server had an error. Try again in a moment.'
  return ({
    bad_address: 'That address does not look right. Use something like http://192.168.1.20:8096.',
    blocked_address: 'That address is not allowed.',
    unresolved: 'That address could not be found.',
    timeout: 'The server did not answer in time.',
    network: 'Could not reach the server.',
    tls_untrusted: 'The server certificate is not trusted. If it is your own server you can allow this.',
    redirect_refused: 'The server redirected the request. Use its direct address.',
    too_big: 'The server sent more data than expected.',
    not_json: 'The server did not answer the way a media server does.'
  })[c] || 'Could not read from the server.'
}

module.exports = { getJson, parseBaseUrl, classifyAddress, explain, FetchError }
