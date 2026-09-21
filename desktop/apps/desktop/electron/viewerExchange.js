'use strict'
// POST /api/viewer-session: a TV, set-top box or Jellyfin-style client that talks plain HTTPS
// to this server (no WebRTC) trades the 12-hour Worker `viewer` token its phone approved
// (worker/tvPair.js) for an ordinary Beebo API bearer token, so nobody types a password on a
// remote. Contract, error codes and client sequence: docs/VIEWER-EXCHANGE.md.
//
// The route only ever answers the question "may this signed Worker token act as an existing
// local user?". It creates no user and no permission: the token it issues is
// makeApiToken(store, user.id), the same kind /api/login and /api/remote-session issue, so
// parental controls, restricted profiles and viewing privacy apply to it exactly as they do to
// a password sign-in.
//
// Trust chain, every step must hold:
//   1. transport   TLS, or a private/loopback peer (localAccessPolicy), or the host agent's tunnel
//   2. not locked  per-address failure budget, a global one for non-LAN callers, and the
//                  address-level sign-in lockout (auth.checkLockout)
//   3. signature   the Worker's Ed25519 public key (the one the licence already uses)
//   4. kind        typ === 'viewer' and nothing else the Worker signs (licence, rewards, vpn ...)
//   5. time        iat not in the future, exp not passed, lifetime not absurd
//   6. house       the token names THIS house and carries THIS licence's account email
//   7. person      owner, or a household member who STILL has away access; never a household
//                  pass or a library-share guest; never an admin through the member door
// Steps 3 to 6 fail with one identical 401 whatever went wrong; the precise reason goes to the
// server log as a fixed code, never with token contents.

const crypto = require('crypto')
const auth = require('./auth')
const viewingPrivacy = require('./viewingPrivacy')
const twoFactor = require('./twoFactor')
const licenseToken = require('./licenseToken')
const { _v6Prefix64 } = require('./viewerIdentity')

const MAX_TOKEN_CHARS = 4096
const MAX_PAYLOAD_BYTES = 2048
const MAX_BODY_BYTES = 2048
const ED25519_SIG_BYTES = 64
// The Worker's viewer tokens live 12 hours and TOKEN_MAX_DAYS (worker.js) caps any token at 30.
// Beyond that a payload is not something the Worker would sign.
const MAX_LIFETIME_S = 30 * 24 * 3600
// Only for a not-yet-valid `iat`: this PC's clock may run a little behind the Worker's.
const CLOCK_SKEW_S = 60
// Shorter than /api/login's 365 days: a TV that has to re-pair once a month is a small price for
// a credential that lives in a set-top box, and there is no per-token revocation to fall back on.
const SESSION_DAYS = 30
// A viewer token is meant to be spent once; a few retries cover a lost response.
const REPLAY_LIMIT = 5
const REPLAY_TRACKED = 5000
const FAIL_MAX = 10
const FAIL_WINDOW_MS = 15 * 60 * 1000
const GLOBAL_FAIL_MAX = 200
const GLOBAL_WINDOW_MS = 10 * 60 * 1000
const TRACKED_ADDRESSES = 2000
const AUDIT_KEY = 'viewerExchangeLog'
const AUDIT_MAX = 100
const DEVICE_NAME_MAX = 40
const FAILURE = Object.freeze({ status: 401, body: Object.freeze({ ok: false, error: 'unauthorized' }) })

const b64url = /^[A-Za-z0-9_-]+$/
const isNum = (n) => typeof n === 'number' && Number.isFinite(n)
const normEmail = (e) => String(e || '').trim().toLowerCase()

// Pure: the token's signature, kind and time. `publicKey` is the Worker's PEM. Returns
// { ok: true, claims } or { ok: false, reason } with a fixed reason code.
function verifyViewerToken(token, { publicKey, nowS = Math.floor(Date.now() / 1000) } = {}) {
  if (typeof token !== 'string' || !token || token.length > MAX_TOKEN_CHARS) return { ok: false, reason: 'malformed' }
  if (!publicKey) return { ok: false, reason: 'no_public_key' }
  const parts = token.split('.')
  if (parts.length !== 2 || !b64url.test(parts[0]) || !b64url.test(parts[1])) return { ok: false, reason: 'malformed' }
  const payloadBytes = Buffer.from(parts[0], 'base64url')
  const sig = Buffer.from(parts[1], 'base64url')
  if (sig.length !== ED25519_SIG_BYTES || payloadBytes.length > MAX_PAYLOAD_BYTES) return { ok: false, reason: 'malformed' }
  let signed = false
  try { signed = crypto.verify(null, payloadBytes, publicKey, sig) } catch { signed = false }
  if (!signed) return { ok: false, reason: 'bad_signature' }
  let p = null
  try { p = JSON.parse(payloadBytes.toString('utf8')) } catch { p = null }
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { ok: false, reason: 'malformed' }
  if (p.typ !== 'viewer') return { ok: false, reason: 'wrong_kind' }
  if (!isNum(p.exp) || !isNum(p.iat)) return { ok: false, reason: 'malformed' }
  if (p.exp <= nowS) return { ok: false, reason: 'expired' }
  if (p.iat > nowS + CLOCK_SKEW_S) return { ok: false, reason: 'not_yet_valid' }
  if (p.exp <= p.iat || p.exp - p.iat > MAX_LIFETIME_S || p.exp - nowS > MAX_LIFETIME_S + CLOCK_SKEW_S) return { ok: false, reason: 'lifetime' }
  if (typeof p.name !== 'string' || !p.name || typeof p.email !== 'string' || !p.email) return { ok: false, reason: 'malformed' }
  let via = 'owner'
  let member = ''
  if (p.via === 'member') {
    member = String(p.member || '').trim().toLowerCase()
    if (!/^[a-z0-9._-]{1,64}$/.test(member)) return { ok: false, reason: 'malformed' }
    via = 'member'
  } else if (p.via === 'household' || p.via === 'guest') {
    via = p.via
  } else if (p.via !== undefined && p.via !== null && p.via !== '') {
    return { ok: false, reason: 'unknown_via' }
  }
  return { ok: true, claims: { name: p.name, email: normEmail(p.email), via, member, exp: p.exp } }
}

const bearerToken = (header) => {
  const m = /^Bearer[ \t]+([A-Za-z0-9_.-]{1,4096})[ \t]*$/i.exec(typeof header === 'string' ? header : '')
  return m ? m[1] : ''
}

// Who is asking, for budgets: an IPv6 caller is a whole /64, as everywhere else in this server.
function budgetKey(ip) {
  const s = String(ip || 'unknown').split('%')[0]
  return s.includes(':') && !s.includes('.') && s !== 'unknown' ? _v6Prefix64(s) : s
}

// In memory, bounded, and forgiving on restart. Failures only ever count; success does not clear
// them, so someone holding one valid token cannot reset the counter between guesses.
function createLimiter({ now = () => Date.now() } = {}) {
  const ips = new Map()
  let recent = []
  return {
    ipMinutes(key) {
      const f = ips.get(key)
      if (!f) return 0
      const t = now()
      if (f.until > t) return Math.ceil((f.until - t) / 60000)
      if (t - f.first > FAIL_WINDOW_MS) ips.delete(key)
      return 0
    },
    ipFail(key) {
      const t = now()
      let f = ips.get(key)
      if (!f || t - f.first > FAIL_WINDOW_MS) f = { first: t, count: 0, until: 0 }
      f.count++
      if (f.count >= FAIL_MAX) f.until = t + FAIL_WINDOW_MS
      ips.delete(key)
      ips.set(key, f)
      if (ips.size > TRACKED_ADDRESSES) ips.delete(ips.keys().next().value)
    },
    globalMinutes() {
      const t = now()
      recent = recent.filter((at) => t - at < GLOBAL_WINDOW_MS && at <= t)
      if (recent.length < GLOBAL_FAIL_MAX) return 0
      return Math.max(1, Math.ceil((recent[recent.length - GLOBAL_FAIL_MAX] + GLOBAL_WINDOW_MS - t) / 60000))
    },
    globalFail() {
      recent.push(now())
      if (recent.length > GLOBAL_FAIL_MAX * 4) recent = recent.slice(-GLOBAL_FAIL_MAX * 2)
    }
  }
}

// Spent viewer tokens by SHA-256 (never the token), until they expire.
function createSpent({ now = () => Date.now() } = {}) {
  const seen = new Map()
  return {
    count: (token) => {
      const e = seen.get(crypto.createHash('sha256').update(token).digest('hex'))
      return e && e.expMs > now() ? e.count : 0
    },
    add(token, expS) {
      const key = crypto.createHash('sha256').update(token).digest('hex')
      const e = seen.get(key)
      if (e) e.count++
      else seen.set(key, { count: 1, expMs: expS * 1000 })
      if (seen.size > REPLAY_TRACKED) {
        const t = now()
        for (const [k, v] of seen) if (v.expMs <= t) seen.delete(k)
        if (seen.size > REPLAY_TRACKED) seen.delete(seen.keys().next().value)
      }
    }
  }
}

// The device name is text a TV chose for itself and an owner may later read: no control or
// bidi-override characters, short.
function cleanDeviceName(v) {
  const s = String(v === undefined || v === null ? '' : v)
    .replace(/[ --​-‏‪-‮⁦-⁩﻿]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DEVICE_NAME_MAX)
  return s || 'Unnamed device'
}

// Same person-mapping /api/remote-session uses: a member is their own approved user and must
// still have away access; the owner is this server's first approved admin.
function mapToUser(users, claims) {
  const approved = users.filter((u) => u && u.status === 'approved')
  return claims.via === 'member'
    ? approved.find((u) => u.username === claims.member && auth.hasRemoteAccess(u)) || null
    : approved.find((u) => u.isAdmin) || null
}

// How the request reached this server, for the transport rule and the audit line.
//   tunnel  through the host agent's WebRTC data channel (encrypted end to end)
//   lan     a private or loopback peer with no proxy in front (localAccessPolicy)
//   direct  anything else that arrived on the TLS socket itself
// Plain HTTP from anywhere but `lan` is refused: the token must not cross the internet in clear.
function transportOf(req, localAccess) {
  if (localAccess.fromHostAgent(req)) return { secure: true, lan: false, path: 'tunnel' }
  const lan = !!localAccess.isHomeRequest(req)
  return { secure: lan || !!(req && req.socket && req.socket.encrypted), lan, path: lan ? 'lan' : 'direct' }
}

async function readSmallJson(req) {
  const chunks = []
  let size = 0
  try {
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY_BYTES) return { tooBig: true, body: {} }
      chunks.push(chunk)
    }
  } catch { return { tooBig: false, body: {} } }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return { tooBig: false, body: {} }
  try {
    const b = JSON.parse(raw)
    return { tooBig: false, body: b && typeof b === 'object' && !Array.isArray(b) ? b : null }
  } catch { return { tooBig: false, body: null } }
}

// deps: { store, license, localAccess, clientIp(req), makeApiToken(store, userId, days),
//         userShape(user), getHouseName(), log(msg), now() }
function createViewerExchange(deps) {
  const { store, license, localAccess, clientIp, makeApiToken, userShape } = deps
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()
  const note = typeof deps.log === 'function' ? deps.log : () => {}
  const limiter = createLimiter({ now })
  const spent = createSpent({ now })

  const setting = (key) => { try { return store.get(key) !== false } catch { return true } }
  const houseName = () => { try { return String((typeof deps.getHouseName === 'function' && deps.getHouseName()) || '') } catch { return '' } }
  // The licence account this server belongs to. Read from the stored, signature-checked licence
  // token even while enforcement is off (a development build), so the house check never depends on it.
  const licence = () => {
    try {
      const publicKey = (license && license.config && license.config.publicKey) || ''
      const ev = license && typeof license.evaluate === 'function' ? license.evaluate() : null
      let payload = ev && ev.payload
      if (!payload && publicKey && typeof license.getToken === 'function') {
        const v = licenseToken.verifyToken(license.getToken(), publicKey)
        if (v.valid) payload = v.payload
      }
      return { publicKey, email: normEmail(payload && payload.email) }
    } catch { return { publicKey: '', email: '' } }
  }

  const refuse = (ctx, reason) => {
    note(`[viewer-exchange] refused: ${reason} (${ctx.path}, ${ctx.ipClass})`)
    return FAILURE
  }

  function audit(user, via, device, path) {
    try {
      const prev = store.get(AUDIT_KEY)
      const list = Array.isArray(prev) ? prev : []
      store.set(AUDIT_KEY, [{ at: now(), userId: user.id, via, device, path }, ...list].slice(0, AUDIT_MAX))
    } catch { /* the record is a courtesy; a sign-in must not fail on it */ }
  }

  async function exchange(req) {
    const method = String(req.method || 'GET').toUpperCase()
    if (method !== 'POST') return { status: 405, headers: { Allow: 'POST' }, body: { ok: false, error: 'method_not_allowed' } }
    if (!setting('allowViewerExchange')) return { status: 403, body: { ok: false, error: 'viewer_exchange_disabled' } }
    const t = transportOf(req, localAccess)
    if (!t.secure) return { status: 403, body: { ok: false, error: 'https_required', message: 'Sign in over https (or from this home network); a sign-in token never travels in the clear.' } }
    if (!t.lan && !setting('allowViewerExchangeAway')) return { status: 403, body: { ok: false, error: 'viewer_exchange_disabled' } }

    const ip = clientIp(req)
    const key = budgetKey(ip)
    const ctx = { path: t.path, ipClass: t.lan ? 'lan' : 'remote' }
    let wait = limiter.ipMinutes(key) || (t.lan ? 0 : limiter.globalMinutes())
    if (!wait) {
      try { const l = auth.checkLockout(store, ip); if (l.locked) wait = l.minutesRemaining } catch { /* no lockout data */ }
    }
    if (wait) return { status: 429, headers: { 'Retry-After': String(wait * 60) }, body: { ok: false, error: 'locked', minutesRemaining: wait } }

    const fail = (reason) => {
      limiter.ipFail(key)
      if (!t.lan) limiter.globalFail()
      return refuse(ctx, reason)
    }

    const token = bearerToken(req.headers && req.headers.authorization)
    if (!token) return fail('no_bearer')
    const lic = licence()
    const checked = verifyViewerToken(token, { publicKey: lic.publicKey, nowS: Math.floor(now() / 1000) })
    if (!checked.ok) return fail(checked.reason)
    const claims = checked.claims
    const name = houseName()
    if (!name || !lic.email) return fail('no_house')
    if (claims.name !== name) return fail('other_house')
    if (claims.email !== lic.email) return fail('other_account')
    if (spent.count(token) >= REPLAY_LIMIT) return fail('replayed')

    if (claims.via === 'household') {
      note(`[viewer-exchange] refused: household_pass (${ctx.path})`)
      return { status: 403, body: { ok: false, error: 'household_pass', message: 'A household pass is not a person. Sign in with your own account.' } }
    }
    if (claims.via === 'guest') {
      note(`[viewer-exchange] refused: guest (${ctx.path})`)
      return { status: 403, body: { ok: false, error: 'guest_not_supported', message: 'A shared-library guest cannot sign a TV in this way.' } }
    }

    const parsed = await readSmallJson(req)
    if (parsed.tooBig) return { status: 413, body: { ok: false, error: 'too_large' } }
    if (!parsed.body) return { status: 400, body: { ok: false, error: 'bad_request' } }
    const device = cleanDeviceName(parsed.body.deviceName)

    let users = []
    try { users = auth.getUsers(store) } catch { users = [] }
    const user = mapToUser(users, claims)
    if (!user) {
      note(`[viewer-exchange] refused: no_remote_access (${ctx.path})`)
      return { status: 403, body: { ok: false, error: 'no_remote_access', message: 'This person does not have away-from-home access on this server.' } }
    }
    if (claims.via === 'member' && user.isAdmin) {
      note(`[viewer-exchange] refused: admin_member (${ctx.path})`)
      return { status: 403, body: { ok: false, error: 'admin_requires_password', message: 'Administrators sign in to a TV as the account owner, or with their password.' } }
    }
    if (viewingPrivacy.isPrivate(store, user.id)) {
      return { status: 403, body: { ok: false, error: 'private_profile_sign_in', message: 'Use your own Beebo username and password to open this private profile.' } }
    }

    // Two-factor: the Worker's viewer token proves the person passed the Worker's sign-in, not this
    // server's second step. /api/remote-session (same idea: a Worker-vouched away sign-in) sends a
    // person with two-factor on to the code step; a TV has no way to ask for one, so it is refused
    // and the person signs in with username, password and code (security review 2026-09-21, L-2).
    if (twoFactor.isEnabled(user)) {
      note(`[viewer-exchange] refused: two_factor (${ctx.path})`)
      return { status: 403, body: { ok: false, error: 'two_factor_sign_in', message: 'This account uses two-factor. Sign in with your own username, password and code.' } }
    }
    if (twoFactor.setupRequired(store, user)) {
      note(`[viewer-exchange] refused: two_factor_setup_required (${ctx.path})`)
      return { status: 403, body: { ok: false, error: 'two_factor_setup_required', message: 'The owner of this server requires two-factor for admins. Turn it on under Account security on the website first.' } }
    }

    spent.add(token, claims.exp)
    // A tracked session (listed under Account security, ended by "sign out" / "sign out everywhere").
    // An untracked 30-day token would also read as issued ~335 days ago and be refused after any
    // sign-out-everywhere in that span (security review 2026-09-21, L-3).
    const apiToken = makeApiToken(store, user.id, SESSION_DAYS, { track: true, ip, userAgent: 'Beebo TV: ' + device, method: 'viewer' })
    if (!apiToken) return { status: 500, body: { ok: false, error: 'server_error' } }
    auth.touchLastSeen(store, user.id, ip)
    audit(user, claims.via, device, t.path)
    note(`[viewer-exchange] signed in user=${user.id} via=${claims.via} device="${device}" path=${t.path}`)
    return {
      status: 200,
      body: {
        ok: true,
        token: apiToken,
        user: userShape(user),
        expiresAt: Math.floor(Number(apiToken.split('.').slice(-2)[0]) / 1000),
        server: { name }
      }
    }
  }

  async function handle(req, res, send) {
    const out = await exchange(req)
    if (out.headers) for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v)
    send(out.status, out.body)
  }

  return { handle, exchange }
}

module.exports = {
  createViewerExchange,
  verifyViewerToken,
  transportOf,
  cleanDeviceName,
  mapToUser,
  SESSION_DAYS,
  MAX_LIFETIME_S,
  CLOCK_SKEW_S,
  REPLAY_LIMIT,
  FAIL_MAX,
  GLOBAL_FAIL_MAX,
  AUDIT_KEY
}
