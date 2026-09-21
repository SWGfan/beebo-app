'use strict'
// ============================================================================
// twoFactor.js - authenticator-app (TOTP) two-factor sign-in for local accounts.
// ----------------------------------------------------------------------------
// Per person, opt-in (the owner can also require it for admins). What is stored on the
// user row (authUsers[].twoFactor, encrypted at rest with the rest of the row's secrets by
// secretSettings.js when the OS offers it):
//
//   { enabled, enabledAt, secret (base32), lastStep, recovery: [{ h, usedAt }],
//     pending: { secret, createdAt } }          <- only while someone is setting it up
//
//   - the TOTP secret has to be readable to check a code, so it is encrypted, not hashed;
//   - recovery codes are ten random single-use codes, stored ONLY as salted scrypt hashes
//     (auth.hashCode); the plain codes are shown once, at set-up / regeneration;
//   - lastStep is the newest 30-second step already accepted. A code from that step or an
//     older one is refused, so a code cannot be replayed (RFC 6238 section 5.2).
//
// Guessing: six digits are only a million possibilities, so the second step has its own
// lock on a FIXED key (the person, not the address - the same idea as the fixed-address keys
// the Cloudflare login limiter uses for pairing). Five wrong codes in ten minutes lock that
// person's second step for five minutes, doubling on each repeat up to an hour, from EVERY
// address and whatever the password step did. It sits alongside, not instead of, the
// per-address / per-username / server-wide limits in auth.js (streamServer calls both).
//
// A partly signed-in person holds a "challenge": a short-lived (5 min) signed token that
// says "this password was right for user X". It is not a session and grants nothing but the
// right to submit a code; it dies after five wrong codes or one success.
// ============================================================================
const crypto = require('crypto')
const auth = require('./auth')
const totp = require('./totp')
const securityLog = require('./securityLog')

const ISSUER = 'Beebo Entertainment'
const RECOVERY_COUNT = 10
const RECOVERY_LENGTH = 10
const PENDING_TTL_MS = 15 * 60 * 1000
const CHALLENGE_TTL_MS = 5 * 60 * 1000
const CHALLENGE_MAX_TRIES = 5
const LOCK_KEY = 'twoFactorLocks'
const POLICY_KEY = 'requireTwoFactorForAdmins'

const LIMIT = { threshold: 5, windowMs: 10 * 60 * 1000, baseMs: 5 * 60 * 1000, capMs: 60 * 60 * 1000, strikeResetMs: 24 * 60 * 60 * 1000 }

// ---- the fixed-key lock ----------------------------------------------------
const lockStates = new WeakMap()

function locks(store) {
  let m = lockStates.get(store)
  if (m) return m
  m = new Map()
  try {
    const saved = store.get(LOCK_KEY)
    if (saved && typeof saved === 'object') {
      for (const [k, e] of Object.entries(saved)) {
        if (e && typeof e === 'object') m.set(k, { fails: [], lockedUntil: Number(e.lockedUntil) || 0, strikes: Number(e.strikes) || 0, lastFailAt: Number(e.lastFailAt) || 0 })
      }
    }
  } catch {}
  lockStates.set(store, m)
  return m
}

function saveLocks(store) {
  const now = Date.now()
  const out = {}
  for (const [k, e] of locks(store)) {
    if (e.lockedUntil > now || (e.strikes && now - e.lastFailAt < LIMIT.strikeResetMs)) out[k] = { lockedUntil: e.lockedUntil, strikes: e.strikes, lastFailAt: e.lastFailAt }
  }
  try { store.set(LOCK_KEY, out) } catch {}
}

function lockStatus(store, key, now = Date.now()) {
  const e = locks(store).get(key)
  if (e && e.lockedUntil > now) {
    const ms = e.lockedUntil - now
    return { locked: true, remainingMs: ms, minutesRemaining: Math.max(1, Math.ceil(ms / 60000)) }
  }
  return { locked: false }
}

// One wrong code. Returns { justLocked, minutesRemaining } when it tips the key over.
function noteFailure(store, key, now = Date.now()) {
  const m = locks(store)
  const e = m.get(key) || { fails: [], lockedUntil: 0, strikes: 0, lastFailAt: 0 }
  if (e.strikes && now - e.lastFailAt >= LIMIT.strikeResetMs) e.strikes = 0
  e.fails = e.fails.filter((t) => now - t < LIMIT.windowMs && t <= now)
  e.fails.push(now)
  e.lastFailAt = now
  let justLocked = false
  if (e.fails.length >= LIMIT.threshold) {
    e.strikes += 1
    e.lockedUntil = now + Math.min(LIMIT.capMs, LIMIT.baseMs * Math.pow(2, Math.min(20, e.strikes - 1)))
    e.fails = []
    justLocked = true
  }
  m.set(key, e)
  if (justLocked) saveLocks(store)
  return justLocked ? { justLocked: true, minutesRemaining: Math.max(1, Math.ceil((e.lockedUntil - now) / 60000)) } : { justLocked: false }
}

function noteSuccess(store, key) {
  const m = locks(store)
  if (m.delete(key)) saveLocks(store)
}

// The owner's Unlock button.
function clearLock(store, userId) {
  const had = locks(store).delete(String(userId)) | locks(store).delete('setup:' + userId)
  if (had) saveLocks(store)
  return !!had
}

// ---- state on the user row -------------------------------------------------
function findUser(store, userId) {
  return auth.getUsers(store).find((u) => u.id === userId) || null
}

function isEnabled(user) {
  return !!(user && user.twoFactor && user.twoFactor.enabled && user.twoFactor.secret)
}

function recoveryRemaining(user) {
  const t = user && user.twoFactor
  return t && Array.isArray(t.recovery) ? t.recovery.filter((r) => !r.usedAt).length : 0
}

function getPolicy(store) {
  return { requireForAdmins: store.get(POLICY_KEY) === true }
}

function setPolicy(store, { requireForAdmins } = {}) {
  const value = requireForAdmins === true
  const before = getPolicy(store).requireForAdmins
  store.set(POLICY_KEY, value)
  if (before !== value) securityLog.record(store, { type: 'policy_changed', detail: `Require two-factor for admins: ${value ? 'on' : 'off'}` })
  return getPolicy(store)
}

// True for an admin who must set two-factor up before doing anything else (owner policy).
function setupRequired(store, user) {
  return !!(user && user.isAdmin && user.status === 'approved' && getPolicy(store).requireForAdmins && !isEnabled(user))
}

// What a screen may show. Never the secret or any hash.
function status(store, user) {
  const t = (user && user.twoFactor) || {}
  const lock = user ? lockStatus(store, user.id) : { locked: false }
  return {
    enabled: isEnabled(user),
    enabledAt: isEnabled(user) ? t.enabledAt || null : null,
    recoveryRemaining: recoveryRemaining(user),
    setupInProgress: !!(t.pending && t.pending.createdAt && Date.now() - t.pending.createdAt < PENDING_TTL_MS),
    setupRequired: setupRequired(store, user),
    locked: lock.locked,
    minutesRemaining: lock.minutesRemaining || 0
  }
}

// Fields safe to send to a screen in place of the raw twoFactor block.
function publicView(user) {
  const t = user && user.twoFactor
  if (!t) return null
  return { enabled: isEnabled(user), enabledAt: t.enabledAt || null, recoveryRemaining: recoveryRemaining(user) }
}

// ---- recovery codes --------------------------------------------------------
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function makeRecoveryCode() {
  let s = ''
  for (let i = 0; i < RECOVERY_LENGTH; i++) s += RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)]
  return s.slice(0, 5) + '-' + s.slice(5)
}

function newRecoverySet() {
  const codes = Array.from({ length: RECOVERY_COUNT }, makeRecoveryCode)
  return { codes, records: codes.map((c) => ({ h: auth.hashCode(c), usedAt: null })) }
}

// ---- set-up ----------------------------------------------------------------
function accountLabel(user) {
  return user.username || user.name || 'account'
}

/** Start (or restart) set-up: a fresh secret, kept as pending until a code from it is proven. */
function beginSetup(store, userId, { now = Date.now() } = {}) {
  const user = findUser(store, userId)
  if (!user || user.status !== 'approved') return { ok: false, error: 'not_found' }
  if (isEnabled(user)) return { ok: false, error: 'already_enabled', message: 'Two-factor is already on for this account.' }
  const secret = totp.generateSecret()
  auth.updateUser(store, userId, (u) => ({ ...u, twoFactor: { ...(u.twoFactor || {}), enabled: false, pending: { secret, createdAt: now } } }))
  return {
    ok: true,
    secret,
    secretSpaced: secret.replace(/(.{4})/g, '$1 ').trim(),
    uri: totp.otpauthUri({ secret, account: accountLabel(user), issuer: ISSUER }),
    account: accountLabel(user),
    issuer: ISSUER
  }
}

/** Finish set-up with a code from the app. Returns the recovery codes ONCE. */
function confirmSetup(store, userId, code, { ip, now = Date.now() } = {}) {
  const user = findUser(store, userId)
  if (!user || user.status !== 'approved') return { ok: false, error: 'not_found' }
  if (isEnabled(user)) return { ok: false, error: 'already_enabled', message: 'Two-factor is already on for this account.' }
  const pending = user.twoFactor && user.twoFactor.pending
  if (!pending || !pending.secret || now - pending.createdAt > PENDING_TTL_MS) {
    return { ok: false, error: 'setup_expired', message: 'That set-up timed out. Start again to get a fresh code.' }
  }
  const key = 'setup:' + userId
  const lock = lockStatus(store, key, now)
  if (lock.locked) return { ok: false, error: 'locked', minutesRemaining: lock.minutesRemaining, message: `Too many wrong codes. Try again in ${lock.minutesRemaining} minute${lock.minutesRemaining === 1 ? '' : 's'}.` }
  const check = totp.verifyTotp(pending.secret, code, { time: now })
  if (!check.ok) {
    noteFailure(store, key, now)
    return { ok: false, error: 'invalid_code', message: 'That code did not match. Check the time on your phone and try the newest code.' }
  }
  noteSuccess(store, key)
  const set = newRecoverySet()
  auth.updateUser(store, userId, (u) => ({
    ...u,
    twoFactor: { enabled: true, enabledAt: now, secret: pending.secret, lastStep: check.step, recovery: set.records }
  }))
  securityLog.record(store, { type: 'two_factor_enabled', userId, username: user.username, known: true, ip })
  return { ok: true, recoveryCodes: set.codes }
}

// ---- checking a code at sign-in (and for sensitive changes) ----------------
/**
 * verifyCode(store, userId, input, { ip, now }) - a six-digit app code or a recovery code.
 * -> { ok: true, method: 'totp' | 'recovery', recoveryRemaining? }
 *  | { ok: false, error: 'locked' | 'invalid_code' | 'code_reused' | 'not_enabled', minutesRemaining?, justLocked? }
 * Every failure counts towards the fixed per-person lock; a locked person is refused before the
 * code is even looked at.
 */
function verifyCode(store, userId, input, { ip, now = Date.now() } = {}) {
  const user = findUser(store, userId)
  if (!user || !isEnabled(user)) return { ok: false, error: 'not_enabled' }
  const known = { userId, username: user.username, known: true, ip }
  const lock = lockStatus(store, userId, now)
  if (lock.locked) return { ok: false, error: 'locked', minutesRemaining: lock.minutesRemaining }
  const raw = String(input == null ? '' : input).slice(0, 64)
  const digits = totp.normalizeCode(raw)
  if (digits !== null) {
    const t = user.twoFactor
    const check = totp.verifyTotp(t.secret, digits, { time: now, lastStep: Number.isFinite(t.lastStep) ? t.lastStep : -1 })
    if (check.ok) {
      auth.updateUser(store, userId, (u) => ({ ...u, twoFactor: { ...u.twoFactor, lastStep: check.step } }))
      noteSuccess(store, userId)
      return { ok: true, method: 'totp' }
    }
    const fail = noteFailure(store, userId, now)
    securityLog.record(store, { ...known, type: check.replay ? 'two_factor_replay' : 'two_factor_failed' })
    if (fail.justLocked) securityLog.record(store, { ...known, type: 'two_factor_locked', detail: `Locked for ${fail.minutesRemaining} min` })
    return { ok: false, error: check.replay ? 'code_reused' : 'invalid_code', justLocked: fail.justLocked, minutesRemaining: fail.minutesRemaining }
  }
  // Not six digits: try it as a recovery code.
  const normalized = auth.normalizeCode(raw)
  const records = Array.isArray(user.twoFactor.recovery) ? user.twoFactor.recovery : []
  let hitIndex = -1
  if (normalized.length === RECOVERY_LENGTH) {
    // Every unused code is checked (each check is timing-safe); no early exit on a hit.
    records.forEach((r, i) => {
      if (!r.usedAt && auth.verifyCode(normalized, r.h) && hitIndex < 0) hitIndex = i
    })
  }
  if (hitIndex >= 0) {
    auth.updateUser(store, userId, (u) => ({
      ...u,
      twoFactor: { ...u.twoFactor, recovery: u.twoFactor.recovery.map((r, i) => (i === hitIndex ? { ...r, usedAt: now } : r)) }
    }))
    noteSuccess(store, userId)
    const remaining = recoveryRemaining(findUser(store, userId))
    securityLog.record(store, { ...known, type: 'recovery_code_used', detail: `${remaining} recovery code${remaining === 1 ? '' : 's'} left` })
    return { ok: true, method: 'recovery', recoveryRemaining: remaining }
  }
  const fail = noteFailure(store, userId, now)
  securityLog.record(store, { ...known, type: 'two_factor_failed' })
  if (fail.justLocked) securityLog.record(store, { ...known, type: 'two_factor_locked', detail: `Locked for ${fail.minutesRemaining} min` })
  return { ok: false, error: 'invalid_code', justLocked: fail.justLocked, minutesRemaining: fail.minutesRemaining }
}

// ---- changes ---------------------------------------------------------------
/** Turn it off. The caller has already proven password + code (self) or is the owner (byOwner). */
function disable(store, userId, { byOwner = false, ip } = {}) {
  const user = findUser(store, userId)
  if (!user) return { ok: false, error: 'not_found' }
  if (!user.twoFactor) return { ok: true, unchanged: true }
  auth.updateUser(store, userId, (u) => {
    const { twoFactor, ...rest } = u
    return rest
  })
  clearLock(store, userId)
  securityLog.record(store, { type: byOwner ? 'two_factor_disabled_by_owner' : 'two_factor_disabled', userId, username: user.username, known: true, ip })
  return { ok: true }
}

/** Replace the recovery codes. The caller has already proven password + code. Returns the new plain codes once. */
function regenerateRecoveryCodes(store, userId, { ip } = {}) {
  const user = findUser(store, userId)
  if (!user || !isEnabled(user)) return { ok: false, error: 'not_enabled' }
  const set = newRecoverySet()
  auth.updateUser(store, userId, (u) => ({ ...u, twoFactor: { ...u.twoFactor, recovery: set.records } }))
  securityLog.record(store, { type: 'recovery_codes_regenerated', userId, username: user.username, known: true, ip })
  return { ok: true, recoveryCodes: set.codes }
}

// ---- login challenges ------------------------------------------------------
const triesByNonce = new Map() // nonce -> { tries, exp }
const usedNonces = new Map() // nonce -> exp

function challengeKey(store) {
  return auth.deriveKey(store, 'two-factor-challenge')
}

function sweepNonces(now) {
  for (const [n, e] of triesByNonce) if (e.exp < now) triesByNonce.delete(n)
  for (const [n, exp] of usedNonces) if (exp < now) usedNonces.delete(n)
}

/** A signed, 5-minute "password was right" token to send back with the code. */
function issueChallenge(store, userId, { purpose = 'login', now = Date.now() } = {}) {
  const payload = Buffer.from(JSON.stringify({ u: userId, e: now + CHALLENGE_TTL_MS, n: crypto.randomBytes(12).toString('base64url'), p: purpose })).toString('base64url')
  const sig = crypto.createHmac('sha256', challengeKey(store)).update(payload).digest('base64url')
  return `${payload}.${sig}`
}

/** -> { ok, userId, nonce, purpose } or { ok: false }. Does not consume it. */
function readChallenge(store, token, { now = Date.now() } = {}) {
  if (typeof token !== 'string' || token.length > 600) return { ok: false }
  const dot = token.indexOf('.')
  if (dot < 1 || token.indexOf('.', dot + 1) !== -1) return { ok: false }
  const payload = token.slice(0, dot)
  const expect = crypto.createHmac('sha256', challengeKey(store)).update(payload).digest('base64url')
  if (!totp.safeEqual(token.slice(dot + 1), expect)) return { ok: false }
  let body
  try { body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) } catch { return { ok: false } }
  if (!body || typeof body.u !== 'string' || !Number.isFinite(body.e) || typeof body.n !== 'string') return { ok: false }
  if (now > body.e) return { ok: false, expired: true }
  sweepNonces(now)
  if (usedNonces.has(body.n)) return { ok: false }
  const t = triesByNonce.get(body.n)
  if (t && t.tries >= CHALLENGE_MAX_TRIES) return { ok: false, exhausted: true }
  return { ok: true, userId: body.u, nonce: body.n, purpose: body.p || 'login', exp: body.e }
}

function challengeFailed(nonce, exp) {
  const t = triesByNonce.get(nonce) || { tries: 0, exp }
  t.tries += 1
  triesByNonce.set(nonce, t)
  return t.tries >= CHALLENGE_MAX_TRIES
}

function consumeChallenge(nonce, exp) {
  usedNonces.set(nonce, exp)
  triesByNonce.delete(nonce)
}

module.exports = {
  isEnabled, status, publicView, recoveryRemaining,
  getPolicy, setPolicy, setupRequired,
  beginSetup, confirmSetup, verifyCode, disable, regenerateRecoveryCodes,
  issueChallenge, readChallenge, challengeFailed, consumeChallenge,
  lockStatus, clearLock, noteFailure,
  LIMIT, RECOVERY_COUNT, RECOVERY_LENGTH, PENDING_TTL_MS, CHALLENGE_TTL_MS, CHALLENGE_MAX_TRIES
}
