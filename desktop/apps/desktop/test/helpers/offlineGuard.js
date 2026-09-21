'use strict'
// Offline guard: makes a Node process behave as if the internet is gone, while the home network works.
//
// Anything that would leave the machine for a PUBLIC address (fetch, http/https, raw sockets, TLS, DNS
// lookups, UDP) is logged and then fails or hangs. Loopback, RFC 1918, link-local, unique-local and
// multicast/broadcast (SSDP, mDNS, NAT-PMP to the router) are left alone, because "no internet" must
// not mean "no Wi-Fi".
//
// Two failure modes, because they break apps in different ways:
//   unreachable  (default)  DNS answers ENOTFOUND and connects answer ENETUNREACH at once.
//                           A router with its WAN cable pulled, a captive/none network.
//   blackhole               DNS never answers and connects never complete. Packets vanish; only an
//                           explicit timeout or abort ends the wait. This is the mode that finds a
//                           missing timeout, and it is what a half-dead uplink looks like.
//
// Use it as a preload so every process in the tree is covered, child processes included:
//   node --require test/helpers/offlineGuard.js headless/main.js
//   NODE_OPTIONS="--require /abs/path/offlineGuard.js" (inherited by children)
// Env:  BEEBO_OFFLINE_MODE=unreachable|blackhole   BEEBO_OFFLINE_LOG=<file, one JSON object per line>
//       BEEBO_OFFLINE_ALLOW=host1,host2            hosts the process may still reach (test fixtures)
//
// Or in-process: require('./offlineGuard').install({ mode, onAttempt }).
//
// Nothing here talks to the network. It only refuses to.

const net = require('net')
const dns = require('dns')
const dgram = require('dgram')
const fs = require('fs')

let installed = null

function isPrivateV4(ip) {
  const p = ip.split('.').map(Number)
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [a, b] = p
  if (a === 10 || a === 127 || a === 0) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  if (a >= 224) return true // multicast (SSDP, mDNS) and the limited broadcast address
  return false // includes 100.64/10 (carrier-grade NAT): that is the ISP's network, not the home
}

function isPrivateV6(ip) {
  const s = ip.toLowerCase().split('%')[0]
  if (s === '::1' || s === '::') return true
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s)
  if (mapped) return isPrivateV4(mapped[1])
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(s)
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16)
    const lo = parseInt(mappedHex[2], 16)
    return isPrivateV4([hi >> 8, hi & 255, lo >> 8, lo & 255].join('.'))
  }
  if (/^fe[89ab]/.test(s)) return true // link-local fe80::/10
  if (/^f[cd]/.test(s)) return true // unique local fc00::/7
  if (/^ff/.test(s)) return true // multicast
  return false
}

function isLocalName(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '')
  return h === 'localhost' || h.endsWith('.localhost') || h === 'localhost.localdomain' || h === ''
}

// True when `host` (a name or an address) is somewhere the home network can reach.
function isHomeTarget(host, allow) {
  const h = String(host || '').replace(/^\[|\]$/g, '')
  if (allow && allow.has(h.toLowerCase())) return true
  const kind = net.isIP(h)
  if (kind === 4) return isPrivateV4(h)
  if (kind === 6) return isPrivateV6(h)
  return isLocalName(h) || /\.local$/i.test(h) // mDNS names resolve on the LAN
}

function install(options = {}) {
  if (installed) return installed
  const mode = options.mode === 'blackhole' || process.env.BEEBO_OFFLINE_MODE === 'blackhole' ? 'blackhole' : 'unreachable'
  const logFile = options.logFile || process.env.BEEBO_OFFLINE_LOG || ''
  const allow = new Set(String(options.allow || process.env.BEEBO_OFFLINE_ALLOW || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))
  const attempts = []
  const started = Date.now()

  let seq = 0
  const write = (entry) => {
    if (logFile) { try { fs.appendFileSync(logFile, JSON.stringify(entry) + '\n') } catch { /* the log is best effort */ } }
    if (typeof options.onAttempt === 'function') { try { options.onAttempt(entry) } catch { /* never break the app for a logger */ } }
  }
  const record = (kind, target, extra) => {
    const entry = Object.assign({ id: `${process.pid}-${++seq}`, t: Date.now() - started, pid: process.pid, kind, target: String(target).slice(0, 200), mode }, extra || {})
    attempts.push(entry)
    write(entry)
    return entry
  }
  // A call that will never be answered (blackhole mode). Logged as its own line so a reader of the file can tell
  // which of them a timeout or abort later ended: hung without a matching released = nothing ever gave up.
  const hang = (entry) => { entry.hung = true; write({ kind: 'hung', of: entry.kind, ref: entry.id, t: Date.now() - started, pid: process.pid, target: entry.target }) }
  const release = (entry, since) => { entry.hung = false; entry.releasedAfterMs = Date.now() - since; write({ kind: 'released', ref: entry.id, t: Date.now() - started, pid: process.pid, target: entry.target, afterMs: entry.releasedAfterMs }) }
  const allowed = (host) => isHomeTarget(host, allow)

  const dnsError = (host, syscall) => {
    const e = new Error(`${syscall || 'getaddrinfo'} ENOTFOUND ${host}`)
    e.code = 'ENOTFOUND'; e.errno = -3008; e.syscall = syscall || 'getaddrinfo'; e.hostname = host
    return e
  }
  const netError = (host, port) => {
    const e = new Error(`connect ENETUNREACH ${host}:${port}`)
    e.code = 'ENETUNREACH'; e.errno = -4062; e.syscall = 'connect'; e.address = host; e.port = port
    return e
  }

  // ---- DNS -------------------------------------------------------------------------------------
  const origLookup = dns.lookup
  const wrapLookup = function lookup(hostname, options2, callback) {
    let cb = callback
    if (typeof options2 === 'function') cb = options2
    if (allowed(hostname)) return origLookup.apply(this, arguments)
    const entry = record('dns.lookup', hostname)
    if (mode === 'unreachable') process.nextTick(() => cb && cb(dnsError(hostname)))
    else hang(entry) // never calls back: a lookup that never returns
    return {}
  }
  dns.lookup = wrapLookup
  const resolvers = ['resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname', 'resolveMx', 'resolveNs', 'resolveTxt', 'resolveSrv', 'resolvePtr', 'reverse']
  for (const name of resolvers) {
    const orig = dns[name]
    if (typeof orig === 'function') {
      dns[name] = function guardedResolve(hostname, ...rest) {
        if (name !== 'reverse' && allowed(hostname)) return orig.apply(this, arguments)
        if (name === 'reverse' && allowed(hostname)) return orig.apply(this, arguments)
        const cb = rest.find((a) => typeof a === 'function')
        record('dns.' + name, hostname)
        if (mode === 'unreachable') process.nextTick(() => cb && cb(dnsError(hostname, 'query')))
        return undefined
      }
    }
    if (dns.Resolver && dns.Resolver.prototype[name]) {
      const protoOrig = dns.Resolver.prototype[name]
      dns.Resolver.prototype[name] = function guardedResolverMethod(hostname, ...rest) {
        if (allowed(hostname)) return protoOrig.apply(this, arguments)
        const cb = rest.find((a) => typeof a === 'function')
        record('dns.Resolver.' + name, hostname)
        if (mode === 'unreachable') process.nextTick(() => cb && cb(dnsError(hostname, 'query')))
        return undefined
      }
    }
  }
  const promises = dns.promises
  const origPromiseLookup = promises.lookup
  promises.lookup = function lookup(hostname) {
    if (allowed(hostname)) return origPromiseLookup.apply(this, arguments)
    const entry = record('dns.promises.lookup', hostname)
    if (mode === 'unreachable') return Promise.reject(dnsError(hostname))
    hang(entry)
    return new Promise(() => {})
  }
  for (const name of resolvers) {
    const orig = promises[name]
    if (typeof orig !== 'function') continue
    promises[name] = function guardedPromiseResolve(hostname) {
      if (allowed(hostname)) return orig.apply(this, arguments)
      const entry = record('dns.promises.' + name, hostname)
      if (mode === 'unreachable') return Promise.reject(dnsError(hostname, 'query'))
      hang(entry)
      return new Promise(() => {})
    }
  }

  // ---- TCP / TLS (everything: fetch, http, https, ws, raw net) ------------------------------------
  const origConnect = net.Socket.prototype.connect
  net.Socket.prototype.connect = function guardedConnect(...args) {
    let normalized
    try { normalized = net._normalizeArgs(args) } catch { return origConnect.apply(this, args) }
    const opts = normalized[0] || {}
    if (opts.path) return origConnect.apply(this, args) // a named pipe / unix socket is local
    const host = opts.host || 'localhost'
    const port = opts.port
    if (allowed(host)) return origConnect.apply(this, args)
    const entry = record('connect', `${host}:${port}`)
    if (mode === 'blackhole') {
      hang(entry)
      this.connecting = true
      const stamp = Date.now()
      this.once('close', () => release(entry, stamp))
      return this // the SYN goes nowhere and nothing ever comes back
    }
    this.connecting = true
    process.nextTick(() => { this.connecting = false; this.destroy(netError(host, port)) })
    return this
  }

  // ---- UDP (STUN, NAT-PMP, DNS-over-UDP by hand) ------------------------------------------------
  const origSend = dgram.Socket.prototype.send
  dgram.Socket.prototype.send = function guardedSend(...args) {
    // send(msg, [offset, length,] [port,] [address,] [cb]) — the address is the last string argument.
    const strings = args.filter((a) => typeof a === 'string')
    const address = strings.length ? strings[strings.length - 1] : ''
    if (!address || allowed(address)) return origSend.apply(this, args)
    record('udp.send', address)
    const cb = args.find((a) => typeof a === 'function')
    if (mode === 'unreachable') process.nextTick(() => { const e = netError(address, 0); e.syscall = 'send'; if (cb) cb(e); else this.emit('error', e) })
    return undefined
  }

  // ---- fetch: log the NAME that was asked for (the socket layer only sees what DNS returned) -------
  if (typeof globalThis.fetch === 'function' && !globalThis.fetch.__beeboOfflineGuard) {
    const origFetch = globalThis.fetch
    const guardedFetch = function fetch(input, init) {
      let host = ''
      let url = ''
      try {
        url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input && input.url) || ''
        host = new URL(url).hostname
      } catch { /* relative or malformed: let the real fetch complain */ }
      if (!host || allowed(host)) return origFetch.apply(this, arguments)
      const entry = record('fetch', host, { path: (() => { try { return new URL(url).pathname } catch { return '' } })() })
      if (mode === 'unreachable') {
        const err = new TypeError('fetch failed')
        err.cause = dnsError(host)
        return Promise.reject(err)
      }
      hang(entry)
      const signal = (init && init.signal) || (input && input.signal)
      const stamp = Date.now()
      return new Promise((resolve, reject) => {
        if (!signal) return // no timeout, no abort: this call would hang for good. It stays hung.
        const done = () => { release(entry, stamp); const e = new Error('This operation was aborted'); e.name = signal.reason && signal.reason.name === 'TimeoutError' ? 'TimeoutError' : 'AbortError'; reject(signal.reason && signal.reason.name ? signal.reason : e) }
        if (signal.aborted) done()
        else signal.addEventListener('abort', done, { once: true })
      })
    }
    guardedFetch.__beeboOfflineGuard = true
    globalThis.fetch = guardedFetch
  }

  installed = {
    mode,
    attempts,
    hung: () => attempts.filter((a) => a.hung),
    // Only the public hosts that were asked for by name (dns/fetch entries), de-duplicated.
    hosts: () => [...new Set(attempts.map((a) => a.target.replace(/:\d+$/, '')))].sort(),
    isHomeTarget: (h) => allowed(h)
  }
  return installed
}

if (process.env.BEEBO_OFFLINE === '1') install()

module.exports = { install, isPrivateV4, isPrivateV6, isHomeTarget }
