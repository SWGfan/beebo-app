'use strict'
/**
 * <name>.home.beebo.tv — this PC's DIRECT address, kept pointed at the house.
 *
 * WHY THIS EXISTS
 * <name>.beebo.tv goes through the Worker (P2P / relay) and needs nothing from
 * here. The older DIRECT route, https://<address>:47811 straight to this PC's
 * forwarded port, used DuckDNS to follow the house's changing public IP. Beebo
 * now does that itself: while this PC is signed in and its beebo.tv name is
 * registered, it tells the Worker "I'm here" at start and every 5 minutes, and
 * the Worker keeps an A (and AAAA) record for <name>.home.beebo.tv pointed at the
 * address it saw. An unchanged address costs the Worker nothing (no DNS call).
 *
 * Same credential and base URL as the member push and the host agent: the
 * licence token, POSTed to https://<name>.beebo.tv/rtc/... . Never throws.
 */

const HOME_SUFFIX = 'home.beebo.tv'
const INTERVAL_MS = 5 * 60 * 1000
const FIRST_DELAY_MS = 15 * 1000
const REQUEST_TIMEOUT_MS = 20 * 1000

const homeHostname = (name) => (name ? `${name}.${HOME_SUFFIX}` : '')
const cleanName = (n) => String(n || '').toLowerCase().replace(/\.beebo\.tv$/, '').replace(/[^a-z0-9]/g, '').slice(0, 30)

// Only a public IPv4 is worth sending as a hint; the Worker refuses anything else.
function publicIpv4(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(s || '').trim())
  if (!m) return ''
  const [a, b, c] = m.slice(1).map(Number)
  if ([a, b, c, Number(m[4])].some((n) => n > 255)) return ''
  if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return ''
  return m.slice(1).map(Number).join('.')
}

/** Plain words for the one line in Settings. */
function reasonText(code) {
  switch (code) {
    case 'home_address_not_configured': return 'beebo.tv isn’t handing out direct addresses yet'
    case 'unauthorized': return 'beebo.tv didn’t accept this computer’s subscription'
    case 'not_your_beebo': return 'this address belongs to a different Beebo account'
    case 'name_reserved': return 'that name is reserved'
    case 'name_invalid': return 'that name isn’t a valid address'
    case 'rate_limited': return 'too many changes this hour; it will try again shortly'
    case 'no_public_ip': return 'beebo.tv couldn’t see a public internet address for this computer'
    case 'dns_update_failed':
    case 'dns_zone_not_found': return 'beebo.tv couldn’t update its DNS right now'
    case 'timeout': return 'beebo.tv didn’t answer in time'
    case 'network': return 'no internet connection to beebo.tv'
    default: return code ? `beebo.tv refused the update (${code})` : 'unknown problem'
  }
}

/**
 * POST to https://<name>.beebo.tv<path> with the licence token. Resolves to
 * { ok, status, body, error } and never rejects.
 */
async function postWorker({ name, path, body, fetchImpl, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const doFetch = fetchImpl || globalThis.fetch
  if (typeof doFetch !== 'function') return { ok: false, status: 0, body: {}, error: 'network' }
  let timer = null
  try {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => { try { if (ctl) ctl.abort() } catch (_e) {} ; resolve('timeout') }, timeoutMs)
      if (timer && timer.unref) timer.unref()
    })
    const req = doFetch(`https://${name}.beebo.tv${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl ? ctl.signal : undefined,
    })
    const res = await Promise.race([req, timeout])
    if (res === 'timeout') return { ok: false, status: 0, body: {}, error: 'timeout' }
    let j = {}
    try { j = (await res.json()) || {} } catch (_e) { j = {} }
    const ok = res.status === 200 && !!j.ok
    return { ok, status: res.status, body: j, error: ok ? '' : (j.error || `http_${res.status}`) }
  } catch (e) {
    return { ok: false, status: 0, body: {}, error: e && e.name === 'AbortError' ? 'timeout' : 'network' }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * opts:
 *   getName()      the REGISTERED beebo.tv name (bare), or '' while there isn't one
 *   getToken()     the licence token, or null while signed out
 *   getPublicIp()  optional: the router's external IPv4 (sent only if public)
 *   fetchImpl, log, intervalMs, firstDelayMs, now, setTimeout/clearTimeout/setInterval/clearInterval
 */
function createHomeAddress(opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now()
  const T = {
    setTimeout: opts.setTimeout || setTimeout,
    clearTimeout: opts.clearTimeout || clearTimeout,
    setInterval: opts.setInterval || setInterval,
    clearInterval: opts.clearInterval || clearInterval,
  }
  const intervalMs = Number.isFinite(opts.intervalMs) ? opts.intervalMs : INTERVAL_MS
  const firstDelayMs = Number.isFinite(opts.firstDelayMs) ? opts.firstDelayMs : FIRST_DELAY_MS

  let firstTimer = null
  let loop = null
  let inFlight = null
  let lastLogged = ''
  const st = {
    state: 'idle',        // idle | waiting | ok | error
    name: '',
    hostname: '',
    ip: '',
    ipv4: '',
    ipv6: '',
    error: '',
    reason: '',
    checkedAt: null,      // last attempt (ISO)
    updatedAt: null,      // last success (ISO)
    goodHostname: '',     // last hostname the Worker confirmed; the certificate default
  }

  const note = (key, msg) => {
    if (key === lastLogged) return
    lastLogged = key
    try { log(msg) } catch (_e) {}
  }

  async function runOnce() {
    if (inFlight) return inFlight
    inFlight = (async () => {
      try {
        let name = ''
        let token = null
        try { name = cleanName(typeof opts.getName === 'function' ? opts.getName() : '') } catch (_e) { name = '' }
        try { token = typeof opts.getToken === 'function' ? opts.getToken() : null } catch (_e) { token = null }
        if (!name || name.length < 3 || !token) {
          const why = !token ? 'not signed in' : 'no beebo.tv address yet'
          // Signed out: forget the address. Name briefly missing while the host
          // agent restarts: keep showing the last result instead of flickering.
          if (!token) { st.state = 'waiting'; st.name = ''; st.hostname = ''; st.goodHostname = ''; st.error = ''; st.reason = why }
          else if (st.state !== 'ok' && st.state !== 'error') { st.state = 'waiting'; st.error = ''; st.reason = why }
          return { ok: false, skipped: true, reason: why }
        }
        const body = { token, name }
        let hint = ''
        try { hint = publicIpv4(typeof opts.getPublicIp === 'function' ? opts.getPublicIp() : '') } catch (_e) { hint = '' }
        if (hint) body.ip = hint
        const r = await postWorker({ name, path: '/rtc/home-address', body, fetchImpl: opts.fetchImpl })
        st.checkedAt = new Date(now()).toISOString()
        st.name = name
        st.hostname = homeHostname(name)
        if (r.ok) {
          st.state = 'ok'
          st.error = ''
          st.reason = ''
          st.ip = r.body.ip || ''
          st.ipv4 = r.body.ipv4 || ''
          st.ipv6 = r.body.ipv6 || ''
          st.updatedAt = st.checkedAt
          st.goodHostname = r.body.hostname || st.hostname
          note(`ok:${st.hostname}:${st.ipv4}:${st.ipv6}`, `[home-address] ${st.hostname} -> ${[st.ipv4, st.ipv6].filter(Boolean).join(', ')}${r.body.changed ? ' (updated)' : ' (up to date)'}`)
          return { ok: true, hostname: st.hostname, ip: st.ip, changed: !!r.body.changed }
        }
        st.state = 'error'
        st.error = r.error
        st.reason = reasonText(r.error)
        note(`err:${name}:${r.error}`, `[home-address] ${st.hostname} not updated: ${r.error}`)
        return { ok: false, error: r.error, reason: st.reason }
      } catch (e) {
        st.state = 'error'
        st.error = 'error'
        st.reason = String((e && e.message) || e)
        return { ok: false, error: 'error', reason: st.reason }
      }
    })()
    // Cleared after assignment: a check that finishes without awaiting would
    // otherwise null it first and leave the finished promise stuck in place.
    const mine = inFlight
    mine.then(() => { if (inFlight === mine) inFlight = null })
    return mine
  }

  function start() {
    stop()
    firstTimer = T.setTimeout(() => { firstTimer = null; runOnce().catch(() => {}) }, firstDelayMs)
    if (firstTimer && firstTimer.unref) firstTimer.unref()
    loop = T.setInterval(() => { runOnce().catch(() => {}) }, intervalMs)
    if (loop && loop.unref) loop.unref()
  }
  function stop() {
    if (firstTimer) { T.clearTimeout(firstTimer); firstTimer = null }
    if (loop) { T.clearInterval(loop); loop = null }
  }
  // "The name just registered": check now unless a check succeeded a moment ago.
  function kick() {
    const last = st.updatedAt ? Date.parse(st.updatedAt) : 0
    if (st.state === 'ok' && last && now() - last < 60 * 1000) return Promise.resolve({ ok: true, skipped: true })
    return runOnce()
  }
  function status() {
    return { ...st, running: !!loop }
  }

  return { start, stop, runOnce, kick, status }
}

module.exports = {
  HOME_SUFFIX,
  INTERVAL_MS,
  homeHostname,
  publicIpv4,
  reasonText,
  postWorker,
  createHomeAddress,
}
