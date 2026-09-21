'use strict'
// cloudFetch: how this app behaves when the internet is slow or gone.
//
// Beebo runs from the home network. Almost everything that reaches the internet is a nicety: poster and
// title look-ups, an update check, price lists, the licence renewal. None of it may ever make a page, a
// stream or the start-up wait. Node's fetch has no time limit of its own, so before this module one dead
// connection could hold a web page open forever (found by test/offline-e2e.test.js: with a TMDB key set
// and the router's uplink cut, the home page never loaded).
//
// installGlobal() puts three rules under EVERY fetch made by the main process, so no caller has to
// remember them:
//
//   1. A wait limit on the response head. A public request with no signal of its own gets one (3 s for
//      look-ups that only decorate a page, 15 s for the rest). It ends when the response starts, so a big
//      download or a long stream is never cut short. A caller that passes its own signal keeps its own limit.
//   2. A short memory for look-ups that only decorate. Until a host has answered once, only ONE request to
//      it is in flight at a time (a dead resolver ties up one of Node's four file-and-DNS worker threads,
//      and five at once would freeze local file reads and sign-ins too). After one of them fails because the
//      network is gone (not because a server said no), the same host answers "offline" immediately for a
//      few seconds instead of making every other request wait the full limit again. A page that asks for
//      forty look-ups waits once, not forty times. One trial request is let through when the pause ends.
//   3. A record of what happened, so the app can say "You're offline" truthfully (status()).
//
// Deliberately NOT done: the pause never applies to Beebo's own service (sign-in, licence), so someone
// who reconnects can sign in at once; and nothing here ever grants access to anything. It only shortens
// how long the app waits for the internet. Home and LAN addresses are never touched.

const net = require('net')

// Hosts whose answers only decorate: a poster, a title, a price list. Short limit and a pause after failure.
const COSMETIC_HOSTS = [
  'api.themoviedb.org', 'image.tmdb.org', 'api.tvmaze.com', 'api.opensubtitles.com', 'openlibrary.org',
  'covers.openlibrary.org', 'itunes.apple.com', 'all.api.radio-browser.info', 'api.radio-browser.info',
  'www.beeboentertainment.com', 'beeboentertainment.com', 'api.papermc.io', 'i.ytimg.com', 'img.youtube.com'
]

const DEFAULTS = Object.freeze({
  cosmeticTimeoutMs: 3000,
  defaultTimeoutMs: 15000,
  pauseStartMs: 10000,
  pauseMaxMs: 60000,
  // A success this recent means "online" even if one host has since failed.
  onlineWindowMs: 5 * 60 * 1000
})

// Error codes that mean "the network is not there", as opposed to "the server answered badly".
const NETWORK_GONE = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'BEEBO_OFFLINE', 'BEEBO_TIMEOUT'
])

// The subset that means the whole internet is out of reach (not just that one server is down or refused us).
const INTERNET_GONE = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'BEEBO_OFFLINE', 'BEEBO_TIMEOUT'])

function isPrivateV4(ip) {
  const p = ip.split('.').map(Number)
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n))) return false
  const [a, b] = p
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
}

// True for an address or name that is on this computer or this home network. Those are never limited or paused.
function isHomeHost(hostname) {
  const h = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase()
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true
  const kind = net.isIP(h)
  if (kind === 4) return isPrivateV4(h)
  if (kind === 6) return h === '::1' || /^fe[89ab]/.test(h) || /^f[cd]/.test(h)
  return false
}

function causeCode(err) {
  let e = err
  for (let i = 0; e && i < 4; i++) {
    if (e.code) return String(e.code)
    e = e.cause
  }
  return ''
}

function offlineError(host) {
  const err = new TypeError('fetch failed')
  err.cause = Object.assign(new Error('offline: not asking ' + host + ' again yet'), { code: 'BEEBO_OFFLINE', hostname: host })
  return err
}

function createCloudFetch({ fetchImpl, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, options = {}, onInternetGone = null } = {}) {
  const real = fetchImpl || globalThis.fetch
  const cfg = Object.assign({}, DEFAULTS, options)
  const cosmetic = new Set(COSMETIC_HOSTS)
  const hosts = new Map() // host -> { fails, pausedUntil, verified, probe }
  let lastOkAt = 0
  let lastFailAt = 0
  let lastInternetFailAt = 0
  let lastFailHost = ''
  let lastFailCode = ''

  const hostState = (h) => { let s = hosts.get(h); if (!s) { s = { fails: 0, pausedUntil: 0, verified: false, probe: null }; hosts.set(h, s) } return s }

  function noteOk(host) {
    lastOkAt = now()
    const s = hosts.get(host)
    if (s) { s.fails = 0; s.pausedUntil = 0; s.verified = true }
  }
  function noteFail(host, code) {
    lastFailAt = now(); lastFailHost = host; lastFailCode = code || ''
    // BEEBO_OFFLINE is our own pause answering: it says nothing new about the network, so it never counts.
    const gone = INTERNET_GONE.has(code) && code !== 'BEEBO_OFFLINE'
    if (gone) lastInternetFailAt = lastFailAt
    const s = hostState(host)
    s.verified = false
    s.fails++
    if (cosmetic.has(host)) s.pausedUntil = Math.max(s.pausedUntil, now() + Math.min(cfg.pauseMaxMs, cfg.pauseStartMs * 2 ** (s.fails - 1)))
    if (gone && typeof onInternetGone === 'function') { try { onInternetGone(host) } catch { /* a listener must not break a fetch */ } }
  }

  // status(): 'online' | 'offline' | 'unknown', from what really happened. Nothing is sent to find out.
  function status() {
    const t = now()
    let state = 'unknown'
    if (lastInternetFailAt && lastInternetFailAt > lastOkAt) state = 'offline'
    else if (lastOkAt) state = 'online'
    return { state, lastOkAt, lastFailAt, lastInternetFailAt, lastFailHost, lastFailCode, pausedHosts: [...hosts].filter(([, s]) => s.pausedUntil > t).map(([h]) => h) }
  }

  async function cloudFetch(input, init) {
    let host = ''
    try {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : (input && input.url) || ''
      host = new URL(raw).hostname.toLowerCase()
    } catch { host = '' }
    if (!host || isHomeHost(host)) return real(input, init)

    const isCosmetic = cosmetic.has(host)
    const s = hostState(host)
    let releaseProbe = null
    if (isCosmetic) {
      // One request at a time until this host has answered; everyone else waits for that answer.
      for (;;) {
        if (s.pausedUntil > now()) throw offlineError(host)
        if (s.verified || !s.probe) break
        await s.probe
      }
      if (!s.verified) {
        s.probe = new Promise((resolve) => { releaseProbe = () => { s.probe = null; resolve() } })
      }
    }

    // (A Request object always carries a signal of its own, so only an explicit one counts as the caller's.)
    const callerSignal = (init && init.signal) || null
    let controller = null
    let timer = null
    let timedOut = false
    let nextInit = init
    if (!callerSignal && typeof AbortController === 'function') {
      controller = new AbortController()
      const limit = isCosmetic ? cfg.cosmeticTimeoutMs : cfg.defaultTimeoutMs
      timer = setTimer(() => { timedOut = true; try { controller.abort() } catch { /* already done */ } }, limit)
      if (timer && timer.unref) timer.unref()
      nextInit = Object.assign({}, init || {}, { signal: controller.signal })
    }
    try {
      const res = await real(input, nextInit)
      if (timer) clearTimer(timer) // the head arrived: a long body is not our business
      noteOk(host)
      return res
    } catch (err) {
      if (timer) clearTimer(timer)
      const code = timedOut || (err && (err.name === 'TimeoutError' || (err.cause && err.cause.name === 'TimeoutError'))) ? 'BEEBO_TIMEOUT' : causeCode(err)
      if (timedOut || NETWORK_GONE.has(code)) noteFail(host, code)
      if (timedOut) {
        const e = new TypeError('fetch failed')
        e.cause = Object.assign(new Error('no answer from ' + host + ' within ' + Math.round((isCosmetic ? cfg.cosmeticTimeoutMs : cfg.defaultTimeoutMs) / 1000) + ' s'), { code: 'BEEBO_TIMEOUT', hostname: host })
        throw e
      }
      throw err
    } finally {
      if (releaseProbe) releaseProbe()
    }
  }
  cloudFetch.__beeboCloudFetch = true

  return { fetch: cloudFetch, status, isCosmeticHost: (h) => cosmetic.has(String(h || '').toLowerCase()), noteOk, noteFail, reset: () => { hosts.clear(); lastOkAt = lastFailAt = lastInternetFailAt = 0 } }
}

// ---- a quiet check that the internet is back (or was never there) -----------------------------------------
// Opens a plain TCP connection to port 443 of a host the app already talks to, and closes it at once. Nothing
// is sent, so it is not a request. It runs
//   - once, a moment after start-up, if the caller lists a host (a TMDB key is saved), so the very first page
//     load on a computer whose internet is out does not have to find out the slow way, and
//   - every 8 s while the internet is known to be out, so the pauses lift within seconds of it coming back.
// When everything is fine it does not run at all.
function createInternetProbe({ cloud, getHosts, connect = net.connect, timeoutMs = 1500, offlineEveryMs = 8000, firstDelayMs = 1500, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let timer = null
  let running = false
  let stopped = false

  function tryHost(host) {
    return new Promise((resolve) => {
      let done = false
      let sock = null
      const finish = (result) => { if (done) return; done = true; clearTimer(t); try { if (sock) sock.destroy() } catch { /* closed already */ } resolve(result) }
      const t = setTimer(() => finish({ ok: false, code: 'BEEBO_TIMEOUT' }), timeoutMs)
      if (t && t.unref) t.unref()
      try {
        sock = connect({ host, port: 443 })
        sock.once('connect', () => finish({ ok: true }))
        sock.once('error', (e) => finish({ ok: false, code: (e && e.code) || 'ERR' }))
      } catch (e) { finish({ ok: false, code: (e && e.code) || 'ERR' }) }
    })
  }

  async function run() {
    timer = null
    if (stopped || running) return
    running = true
    let anyDown = false
    try {
      const hosts = (typeof getHosts === 'function' ? getHosts() : []) || []
      for (const host of hosts) {
        const r = await tryHost(host)
        if (r.ok) cloud.noteOk(host)
        else if (INTERNET_GONE.has(r.code)) { cloud.noteFail(host, r.code); anyDown = true }
      }
    } catch { /* a probe must never become an app problem */ }
    running = false
    if (anyDown) arm(offlineEveryMs)
  }

  function arm(ms) {
    if (stopped || timer) return
    timer = setTimer(run, ms)
    if (timer && timer.unref) timer.unref()
  }

  return { start() { stopped = false; arm(firstDelayMs) }, arm, stop() { stopped = true; if (timer) { clearTimer(timer); timer = null } }, runNow: run, tryHost }
}

let shared = null
// Replaces globalThis.fetch for this process. Safe to call twice. `getProbeHosts` lists the public hosts worth
// checking quietly at start-up and while offline (see createInternetProbe); leave it out for none.
function installGlobal(opts = {}) {
  if (shared) return shared
  if (typeof globalThis.fetch !== 'function') return null
  const { getProbeHosts, ...options } = opts
  let probe = null
  shared = createCloudFetch({ fetchImpl: globalThis.fetch, options, onInternetGone: () => { if (probe) probe.arm(8000) } })
  probe = createInternetProbe({ cloud: shared, getHosts: getProbeHosts || (() => []) })
  shared.probe = probe
  globalThis.fetch = shared.fetch
  return shared
}
const getShared = () => shared

// A plain-language line for a network error, for messages a person will read.
function friendlyNetworkMessage(err) {
  const code = causeCode(err) || (err && err.code) || ''
  if (NETWORK_GONE.has(code) || /fetch failed|ENOTFOUND|ENETUNREACH|EAI_AGAIN|timed? ?out/i.test(String(err && err.message))) {
    return "You're offline right now. Everything on your home network still works; this will work again when the internet is back."
  }
  return ''
}

module.exports = { createCloudFetch, createInternetProbe, installGlobal, getShared, isHomeHost, friendlyNetworkMessage, COSMETIC_HOSTS, DEFAULTS, NETWORK_GONE, INTERNET_GONE }
