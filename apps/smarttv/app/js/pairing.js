// =====================================================================================
//  Device-code pairing ("tvpair") - the wire contract lives in worker/tvPair.js
// =====================================================================================
// Everything that depends on that contract is in THIS file (+ test/pairing.test.mjs), so a later
// change to the Worker means editing only this seam.
//
//   POST {PAIR_BASE}/tvpair/start   { device_name?, device_model? }
//        -> { device_code, user_code "ABCD-EFGH", verification_uri, verification_uri_complete,
//             expires_in (<= 600), interval (5) }
//   POST {PAIR_BASE}/tvpair/poll    { device_code }
//        -> { status: 'pending'|'slow_down'|'denied'|'expired'|'approved',
//             interval?, name?, token?, iceServers?, expiresAt? }
//        'slow_down' arrives with HTTP 429 + Retry-After; 'approved' is delivered exactly once.
//   404 on every /tvpair/* route means the feature is switched off on the Worker.
//
// WHAT "APPROVED" GIVES A TV:
//   `token` is a 12-hour WebRTC *viewer* token for the house. The home server's plain /api/* REJECTS
//   it directly, so it is exchanged once (exchangeViewerToken below) for a normal API session:
//
//   POST {serverBase}/api/viewer-session   Authorization: Bearer <viewer token>   { deviceName? }
//        -> 200 { token: <normal API bearer>, user:{id,name,isAdmin}, expiresAt, server:{name} }
//        every failure is a generic 401; 403 / 429 = not allowed / rate limited; 404 = an older
//        server without the route. (Route is being built on the desktop server; this is the target
//        contract - if it changes, change exchangeViewerToken() and nothing else.)
//   On anything but 200 the app falls back to typed username + password (POST /api/login).
//   The viewer token is only ever sent over https, or over http to a private LAN address; it is
//   discarded right after the exchange and never stored or logged. The returned API bearer is then
//   used exactly like an /api/login token.
//
//   PAIR_BASE = https://beebo.tv (the Worker origin; overridable via the `pairBase` setting).
// =====================================================================================

import { safeText } from './util/escape.js'
import { isPrivateHost } from './util/urls.js'

export var PAIR_BASE_DEFAULT = 'https://beebo.tv'
export var START_PATH = '/tvpair/start'
export var POLL_PATH = '/tvpair/poll'
export var SLOW_DOWN_STEP_SEC = 5
export var MAX_POLL_FAILURES = 5

var MIN_INTERVAL_SEC = 1
var MAX_INTERVAL_SEC = 30
var DEFAULT_INTERVAL_SEC = 5
var DEFAULT_EXPIRES_SEC = 600

/**
 * The single place that decides what an approved poll turns into (pure).
 * @param {{name?:string, token?:string}} reply the /tvpair/poll answer (name already validated)
 * @returns {{houseName:string, viewerToken:string}} viewerToken is '' when the Worker sent none/garbage
 */
export function finishApproved(reply) {
  var tok = reply && typeof reply.token === 'string' && reply.token.length > 0 && reply.token.length <= 4096 && !/\s/.test(reply.token) ? reply.token : ''
  return { houseName: reply.name, viewerToken: tok }
}

// A house name is one DNS label (worker/ddns.js name rules).
function validHouseName(n) {
  return typeof n === 'string' && /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(n)
}

// ---------------------------------------------------------------------------------------
//  Pure state machine
// ---------------------------------------------------------------------------------------

export function initialState() {
  return {
    phase: 'idle', // idle | starting | waiting | approved | denied | expired | unavailable | error
    userCode: '',
    verificationUri: '',
    deviceCode: '',
    expiresAt: 0,
    intervalMs: DEFAULT_INTERVAL_SEC * 1000,
    failures: 0,
    error: '',
    houseName: '' // set on approval; safe to keep (it is a public host label, not a credential)
  }
}

function clamp(n, lo, hi, fallback) {
  n = Number(n)
  return isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback
}

/** Validate + normalise a /tvpair/start reply. Returns null when unusable. */
export function parseStartReply(body) {
  if (!body || typeof body !== 'object') return null
  var deviceCode = typeof body.device_code === 'string' ? body.device_code : ''
  var userCode = safeText(body.user_code, 32).trim().toUpperCase()
  var uri = safeText(body.verification_uri, 200).trim()
  if (!deviceCode || deviceCode.length > 512 || /\s/.test(deviceCode)) return null
  if (!/^[A-Z0-9][A-Z0-9-]{2,30}[A-Z0-9]$/.test(userCode)) return null
  if (!/^https:\/\/[^\s"'<>]+$/i.test(uri)) return null // the page where a code is typed must be https
  return {
    deviceCode: deviceCode,
    userCode: userCode,
    verificationUri: uri,
    expiresInSec: clamp(body.expires_in, 30, 1800, DEFAULT_EXPIRES_SEC),
    intervalSec: clamp(body.interval, MIN_INTERVAL_SEC, MAX_INTERVAL_SEC, DEFAULT_INTERVAL_SEC)
  }
}

/** "https://beebo.tv/tv?x=1" -> "beebo.tv/tv" - what the person should type on their phone. */
export function displayUri(uri) {
  return String(uri || '').replace(/^https?:\/\//i, '').replace(/[?#].*$/, '').replace(/\/+$/, '')
}

/**
 * reduce(state, event) -> new state. Events:
 *   { type:'start' }
 *   { type:'start_ok', body, now }   { type:'start_fail', message, feature_off? }
 *   { type:'poll_ok', body, now }    { type:'poll_fail', message }
 *   { type:'tick', now }             { type:'reset' }
 */
export function reduce(state, ev) {
  var s = {}
  for (var k in state) s[k] = state[k]
  switch (ev.type) {
    case 'reset':
      return initialState()
    case 'start':
      s = initialState()
      s.phase = 'starting'
      return s
    case 'start_fail':
      s.phase = ev.feature_off ? 'unavailable' : 'error'
      s.error = ev.feature_off ? '' : safeText(ev.message, 200) || 'Could not start pairing.'
      return s
    case 'start_ok': {
      var parsed = parseStartReply(ev.body)
      if (!parsed) {
        s.phase = 'error'
        s.error = 'The sign-in service sent an unexpected answer.'
        return s
      }
      s.phase = 'waiting'
      s.userCode = parsed.userCode
      s.verificationUri = parsed.verificationUri
      s.deviceCode = parsed.deviceCode
      s.expiresAt = ev.now + parsed.expiresInSec * 1000
      s.intervalMs = parsed.intervalSec * 1000
      s.failures = 0
      s.error = ''
      return s
    }
    case 'poll_ok': {
      if (s.phase !== 'waiting') return s
      var body = ev.body && typeof ev.body === 'object' ? ev.body : {}
      var known = body.status === 'approved' || body.status === 'denied' || body.status === 'expired' || body.status === 'slow_down' || body.status === 'pending'
      if (known) s.failures = 0
      if (body.status === 'approved') {
        if (!validHouseName(body.name)) {
          s.phase = 'error'
          s.error = 'The sign-in service approved this TV but sent no usable house name.'
          s.deviceCode = ''
          return s
        }
        s.phase = 'approved'
        s.houseName = finishApproved(body).houseName // the token in `body` is NOT kept in state
        s.deviceCode = ''
        return s
      }
      if (body.status === 'denied') { s.phase = 'denied'; s.deviceCode = ''; return s }
      if (body.status === 'expired') { s.phase = 'expired'; s.deviceCode = ''; return s }
      if (body.status === 'slow_down') {
        var asked = Number(body.interval)
        var next = isFinite(asked) && asked > 0 ? asked * 1000 : s.intervalMs + SLOW_DOWN_STEP_SEC * 1000
        s.intervalMs = Math.min(MAX_INTERVAL_SEC * 1000, Math.max(s.intervalMs, next))
        return s
      }
      if (body.status === 'pending') return s
      // Unknown status: a soft failure, so a bad server cannot make us spin forever.
      s.failures += 1
      if (s.failures >= MAX_POLL_FAILURES) { s.phase = 'error'; s.error = 'The sign-in service sent an unexpected answer.' }
      return s
    }
    case 'poll_fail':
      if (s.phase !== 'waiting') return s
      s.failures += 1
      // Back off a little on each failure, never hammer a struggling service.
      s.intervalMs = Math.min(MAX_INTERVAL_SEC * 1000, s.intervalMs + 1000)
      if (s.failures >= MAX_POLL_FAILURES) {
        s.phase = 'error'
        s.error = safeText(ev.message, 200) || 'Lost contact with the sign-in service.'
      }
      return s
    case 'tick':
      if (s.phase === 'waiting' && ev.now >= s.expiresAt) { s.phase = 'expired'; s.deviceCode = '' }
      return s
    default:
      return s
  }
}

export function isTerminal(state) {
  var p = state.phase
  return p === 'approved' || p === 'denied' || p === 'expired' || p === 'error' || p === 'unavailable'
}

/** Seconds left on the code, for the countdown text. */
export function secondsLeft(state, now) {
  return state.phase === 'waiting' ? Math.max(0, Math.ceil((state.expiresAt - now) / 1000)) : 0
}

/**
 * Thin transport over an HTTP client (see api.js createPairTransport): posts the two calls and
 * normalises the two quirks of the Worker's answers -
 *   * 429 {status:'slow_down'} is a normal poll answer, not an error;
 *   * 404 means the feature is off (rejected with err.featureOff = true).
 */
export function createTransport(post, opts) {
  var o = opts || {}
  return {
    start: function () {
      var body = { device_name: safeText(o.deviceName || 'Beebo TV app', 40), device_model: safeText(o.deviceModel || '', 40) }
      return post(START_PATH, body).then(null, function (err) {
        if (err && err.kind === 'not_found') err.featureOff = true
        throw err
      })
    },
    poll: function (deviceCode) {
      return post(POLL_PATH, { device_code: deviceCode }).then(null, function (err) {
        if (err && err.body && typeof err.body === 'object' && err.body.status === 'slow_down') return err.body
        throw err
      })
    }
  }
}

/**
 * Driver: start -> poll loop, respecting `interval`, reporting every state via onState.
 *   deps.start() -> Promise<startReply>     deps.poll(deviceCode) -> Promise<pollReply>
 *   deps.now() -> ms                        deps.setTimer(fn, ms) -> handle    deps.clearTimer(handle)
 *   deps.onState(state)
 *   deps.onApproved({ houseName, viewerToken }) -> called ONCE on approval. This is the only place the
 *                            viewer token leaves this module; state objects never contain it.
 * Returns { cancel() }.
 */
export function runPairing(deps) {
  var state = reduce(initialState(), { type: 'start' })
  var timer = null
  var cancelled = false
  var approvedFired = false

  function emit() { if (!cancelled) deps.onState(state) }
  function apply(ev) {
    state = reduce(state, ev)
    emit()
  }
  function schedulePoll() {
    if (cancelled || isTerminal(state)) return
    timer = deps.setTimer(doPoll, state.intervalMs)
  }
  function doPoll() {
    timer = null
    if (cancelled) return
    apply({ type: 'tick', now: deps.now() })
    if (isTerminal(state)) return
    var code = state.deviceCode
    Promise.resolve()
      .then(function () { return deps.poll(code) })
      .then(
        function (body) {
          apply({ type: 'poll_ok', body: body, now: deps.now() })
          if (state.phase === 'approved' && !cancelled && !approvedFired) {
            approvedFired = true
            var fin = finishApproved(body)
            deps.onApproved({ houseName: state.houseName, viewerToken: fin.viewerToken })
          }
        },
        function (err) { apply({ type: 'poll_fail', message: err && err.friendly ? err.friendly : '' }) }
      )
      .then(schedulePoll)
  }

  emit()
  Promise.resolve()
    .then(function () { return deps.start() })
    .then(
      function (body) { apply({ type: 'start_ok', body: body, now: deps.now() }) },
      function (err) { apply({ type: 'start_fail', message: err && err.friendly ? err.friendly : '', feature_off: !!(err && err.featureOff) }) }
    )
    .then(schedulePoll)

  return {
    cancel: function () {
      cancelled = true
      if (timer !== null) { deps.clearTimer(timer); timer = null }
    }
  }
}

// ---------------------------------------------------------------------------------------
//  Viewer-token -> API-session exchange
// ---------------------------------------------------------------------------------------

export var EXCHANGE_PATH = '/api/viewer-session'

/** The viewer token may only be sent over https, or over http to a private LAN address. */
export function isSafeExchangeOrigin(origin) {
  var m = /^(https?):\/\/([^/:?#@]+)(:\d{1,5})?\/?$/i.exec(String(origin || ''))
  if (!m) return false
  if (m[1].toLowerCase() === 'https') return true
  return isPrivateHost(m[2])
}

/**
 * Exchange the phone-approved viewer token for a normal API session on the home server.
 *   deps.post(origin, path, json, bearer) -> Promise<{status, body}>; may also reject with an error
 *        carrying .status / .body (the api.js client does that for non-2xx). Network failure = status 0.
 * Resolves (never rejects) with one of:
 *   { status:'signed_in', token, userName, serverName }   -> use the token like an /api/login one
 *   { status:'insecure' }      refused locally: would send the token over plain http off-LAN
 *   { status:'unsupported' }   404: older server without the route
 *   { status:'rejected' }      401: generic refusal (expired/invalid token, unknown account...)
 *   { status:'not_allowed' }   403
 *   { status:'rate_limited' }  429
 *   { status:'unreachable' }   could not reach the server
 *   { status:'bad_response' }  200 without a usable token
 * Anything but 'signed_in' means: fall back to typed username + password. No result ever contains
 * the viewer token.
 */
export function exchangeViewerToken(deps, origin, viewerToken, deviceName) {
  if (!isSafeExchangeOrigin(origin)) return Promise.resolve({ status: 'insecure' })
  if (typeof viewerToken !== 'string' || !viewerToken) return Promise.resolve({ status: 'rejected' })
  var body = deviceName ? { deviceName: safeText(deviceName, 40) } : {}
  function classify(res) {
    var status = res && typeof res.status === 'number' ? res.status : 0
    var b = res && res.body && typeof res.body === 'object' ? res.body : {}
    if (status === 200) {
      var tok = b.token
      if (typeof tok !== 'string' || !tok || tok.length > 4096 || /\s/.test(tok)) return { status: 'bad_response' }
      return {
        status: 'signed_in',
        token: tok,
        userName: safeText(b.user && b.user.name, 60).trim(),
        serverName: safeText(b.server && b.server.name, 60).trim()
      }
    }
    if (status === 404) return { status: 'unsupported' }
    if (status === 401) return { status: 'rejected' }
    if (status === 403) return { status: 'not_allowed' }
    if (status === 429) return { status: 'rate_limited' }
    return { status: 'unreachable' }
  }
  return Promise.resolve()
    .then(function () { return deps.post(origin, EXCHANGE_PATH, body, viewerToken) })
    .then(classify, function (err) { return classify({ status: err && typeof err.status === 'number' ? err.status : 0, body: err && err.body }) })
}
