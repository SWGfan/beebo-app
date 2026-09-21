'use strict'
// Beebo client-side licensing (Electron main process).
//
// Responsibilities:
//   - derive a stable per-install device id
//   - hold the current signed license token (persisted in electron-store)
//   - verify + evaluate it OFFLINE every time the server decides whether to serve
//   - talk to the licensing backend to start a trial, activate a key, or renew
//   - re-validate periodically, with the offline grace baked into token expiry
//
// Enforcement is FEATURE-FLAGGED. Until `licensingEnabled` is true AND a public
// key + backend URL are configured, evaluate() returns serve:true so nothing
// changes for existing installs (and the owner's own server). This lets the code
// ship dark and be switched on when the backend is live.
//
// All external effects (store, fetch, crypto randomness, clock) are injectable
// so this file is unit-testable without Electron.

const crypto = require('crypto')
const { verifyToken, evaluateLicense } = require('./licenseToken')

const TOKEN_KEY = 'license.token'
const DEVICE_KEY = 'license.deviceId'
const LASTCHECK_KEY = 'license.lastServerContact' // unix seconds of last successful backend contact

function defaultConfig() {
  return {
    // Flip to true (and ship a real publicKey + backendUrl) to turn enforcement on.
    enabled: false,
    // Ed25519 public key (SPKI PEM). Replace with the production key at setup.
    publicKey: '',
    // e.g. 'https://login.beebo.tv'
    backendUrl: '',
    // Tried in order when backendUrl cannot be reached or its edge answers with a
    // gateway error (e.g. the old workers.dev address while DNS moves).
    fallbackUrls: [],
    // Product/plan this build sells.
    plan: 'beebo-standard',
  }
}

function createLicense(deps = {}) {
  const store = deps.store // electron-store instance (get/set/delete)
  const fetchImpl = deps.fetch || globalThis.fetch
  const now = deps.now || (() => Math.floor(Date.now() / 1000))
  const machineInfo = deps.machineInfo || (() => `${require('os').hostname()}|${require('os').platform()}|${require('os').arch()}`)
  const cfg = Object.assign(defaultConfig(), deps.config || {})
  const timeoutMs = Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : 20000
  const clockMs = deps.clockMs || (() => Date.now())

  // Backend addresses, primary first. After a fallback answered, it is used first
  // for a while (so every call doesn't wait on a dead primary), then the primary
  // is tried again.
  const STICKY_MS = 10 * 60 * 1000
  let preferred = ''
  let preferredUntil = 0
  function backendUrls() {
    const seen = new Set()
    const list = []
    for (const u of [cfg.backendUrl, ...(Array.isArray(cfg.fallbackUrls) ? cfg.fallbackUrls : [])]) {
      const v = String(u || '').trim().replace(/\/+$/, '')
      if (v && /^https:\/\//i.test(v) && !seen.has(v)) { seen.add(v); list.push(v) }
    }
    return list
  }
  // The address other parts of the app should talk to right now.
  function backendUrl() {
    const list = backendUrls()
    if (preferred && clockMs() < preferredUntil && list.includes(preferred)) return preferred
    return list[0] || ''
  }
  // Gateway errors from an edge in front of the service: the service itself did
  // not answer, so another address may. Anything else is a real answer.
  const TRY_NEXT_STATUS = new Set([502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530])

  function getDeviceId() {
    let id = store.get(DEVICE_KEY)
    if (id) return id
    // Seed from stable-ish machine info + random, hashed. Stable across restarts
    // (persisted), reasonably distinct per machine, and not personally identifying.
    const seed = machineInfo() + '|' + crypto.randomBytes(8).toString('hex')
    id = 'dev_' + crypto.createHash('sha256').update(seed).digest('hex').slice(0, 24)
    store.set(DEVICE_KEY, id)
    return id
  }

  function getToken() { return store.get(TOKEN_KEY) || '' }
  let tokenGeneration = 0
  function setToken(tok) {
    tokenGeneration++
    if (tok) { store.set(TOKEN_KEY, tok); store.set(LASTCHECK_KEY, now()) }
  }
  function clearToken() { tokenGeneration++; store.delete(TOKEN_KEY) }

  // The single source of truth the server asks before serving content.
  function evaluate() {
    if (!cfg.enabled || !cfg.publicKey || !cfg.backendUrl) {
      return { serve: true, state: 'disabled', enforced: false }
    }
    const tok = getToken()
    if (!tok) return { serve: false, state: 'none', enforced: true }
    const v = verifyToken(tok, cfg.publicKey)
    if (!v.valid) return { serve: false, state: 'invalid', reason: v.reason, enforced: true }
    // The token's expiry already encodes the offline tolerance: the backend sets
    // expiresAt = subscription period end + grace, so an offline app keeps serving
    // until then and no separate offline cap is needed. Trials expire at trial end.
    // The device-only trial (/trial/start, no email) is retired: every trial now
    // starts with an email sign-in, which is what a beebo.tv address and Beebo on
    // other devices need. A computer still holding one of those tokens is asked
    // to sign in with email; it is not crashed or silently wiped.
    if (isRetiredDeviceTrial(v.payload)) {
      return { serve: false, state: 'email_required', enforced: true, payload: v.payload }
    }
    const ev = evaluateLicense(v.payload, { now: now(), deviceId: getDeviceId() })
    return Object.assign({ enforced: true, payload: v.payload }, ev)
  }

  // Home access is independent of a paid away-from-home entitlement. Keep
  // evaluate().serve unchanged: the remote host and relay still depend on it.
  function accessStatus() {
    const entitlement = evaluate()
    return { ...entitlement, homeAllowed: true, awayAllowed: entitlement.serve === true }
  }

  async function callBackend(pathName, body) {
    const list = backendUrls()
    const first = backendUrl()
    const order = [first, ...list.filter((u) => u !== first)]
    const payload = JSON.stringify(Object.assign({ deviceId: getDeviceId(), plan: cfg.plan }, body || {}))
    let lastError = null
    let lastAnswer = null
    for (let i = 0; i < order.length; i++) {
      const base = order[i]
      const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload }
      if (timeoutMs > 0 && typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') init.signal = AbortSignal.timeout(timeoutMs)
      let res
      try {
        res = await fetchImpl(base + pathName, init)
      } catch (e) {
        lastError = e
        continue
      }
      let data = {}
      try { data = await res.json() } catch (_) {}
      const answer = { httpOk: res.ok, status: res.status, data }
      if (TRY_NEXT_STATUS.has(res.status) && i < order.length - 1) { lastAnswer = answer; continue }
      if (base === list[0]) { preferred = ''; preferredUntil = 0 } else { preferred = base; preferredUntil = clockMs() + STICKY_MS }
      return answer
    }
    if (lastAnswer) return lastAnswer
    throw lastError || new Error('no backend configured')
  }

  // Accept a token the backend returned: verify it before trusting/persisting.
  function acceptToken(tok) {
    if (!tok) return { ok: false, reason: 'no_token' }
    const v = verifyToken(tok, cfg.publicKey)
    if (!v.valid) return { ok: false, reason: 'bad_token:' + v.reason }
    if (v.payload.deviceId && v.payload.deviceId !== getDeviceId()) {
      return { ok: false, reason: 'device_mismatch' }
    }
    setToken(tok)
    // Cache the plan alongside the token. evaluate() already re-derives the
    // authoritative plan from the signed payload every time it runs (see
    // below); this plain store copy exists only so other main-process
    // modules (e.g. streamServer.js's away-from-home quality cap) can read
    // "what plan is this household on" via `store` the same way they read
    // other cross-module policy state, without needing a reference to this
    // license instance. Never trust it over the signed payload.
    if (v.payload && v.payload.plan) {
      try { store.set('license.plan', v.payload.plan) } catch {}
    }
    // Extra household seats (worker/seatAddon.js) ride the same signed payload
    // as plan, cached the same way for householdPlan.js's capacity check.
    // A payload with no `seats` field at all (an older Worker reply, or a
    // trial token) leaves the cached value alone — see the plan cache's own
    // "no plan in the new payload - previous value is left alone" rule just
    // above; 0 is a real, meaningful answer (no extra seats bought), not "unset".
    if (v.payload && typeof v.payload.seats === 'number') {
      try { store.set('license.seats', v.payload.seats) } catch {}
    }
    return { ok: true, payload: v.payload }
  }

  // There is no device-only trial any more (see isRetiredDeviceTrial): a free
  // trial is registerTrial(email, password).
  async function registerTrial(email, password) {
    try {
      const em = String(email || '').trim().toLowerCase()
      const r = await callBackend('/auth/register-trial', { email: em, password: String(password || '') })
      if (!r.httpOk) return { ok: false, reason: (r.data && r.data.error) || ('http_' + r.status), status: r.status }
      // Account + trial created — now sign in to receive the signed token.
      return await login(em, password)
    } catch (e) { return { ok: false, reason: 'network:' + (e && e.message) } }
  }

  async function login(email, password) {
    try {
      const r = await callBackend('/auth/login', { email: String(email || '').trim().toLowerCase(), password: String(password || '') })
      if (r.httpOk && r.data && r.data.token) {
        const a = acceptToken(r.data.token)
        return Object.assign(a, { status: r.data.status, plan: r.data.plan, periodEnd: r.data.periodEnd })
      }
      return { ok: false, reason: (r.data && r.data.error) || ('http_' + r.status), status: r.status }
    } catch (e) { return { ok: false, reason: 'network:' + (e && e.message) } }
  }

  async function activate(licenseKey) {
    try {
      const r = await callBackend('/activate', { licenseKey: String(licenseKey || '').trim() })
      if (r.httpOk && r.data && r.data.token) return acceptToken(r.data.token)
      return { ok: false, reason: (r.data && r.data.error) || ('http_' + r.status) }
    } catch (e) { return { ok: false, reason: 'network:' + (e && e.message) } }
  }

  // Renew the current token if the backend still says the subscription is good.
  // Never downgrades: a failed renew leaves the existing token in place so a
  // transient outage can't lock a paying customer before their token truly expires.
  async function revalidate() {
    const tok = getToken()
    const generation = tokenGeneration
    // Nothing to renew: a retired device-only trial stays put so the app can keep
    // explaining why it needs an email sign-in, instead of the backend revoking it
    // into a bare "not activated".
    if (tok) {
      const v = verifyToken(tok, cfg.publicKey)
      if (v.valid && isRetiredDeviceTrial(v.payload)) return { ok: false, reason: 'email_required' }
    }
    try {
      const r = await callBackend('/validate', { token: tok })
      if (generation !== tokenGeneration) return { ok: false, reason: 'session_changed' }
      if (r.httpOk && r.data) {
        if (r.data.revoked) { clearToken(); return { ok: true, revoked: true } }
        if (r.data.token) { store.set(LASTCHECK_KEY, now()); return acceptToken(r.data.token) }
        // Backend reachable but no new token (e.g. still valid): record contact.
        store.set(LASTCHECK_KEY, now())
        return { ok: true, unchanged: true }
      }
      return { ok: false, reason: 'http_' + r.status }
    } catch (e) { return { ok: false, reason: 'network:' + (e && e.message) } }
  }

  return {
    config: cfg, backendUrl, backendUrls, getDeviceId, getToken, clearToken, evaluate, accessStatus,
    activate, login, registerTrial, revalidate, acceptToken,
  }
}

// A token from the retired /trial/start: a trial with no licence and no email.
function isRetiredDeviceTrial(payload) {
  return !!(payload && payload.type === 'trial' && !payload.email && !payload.licenseId)
}

module.exports = { createLicense, defaultConfig, isRetiredDeviceTrial }
