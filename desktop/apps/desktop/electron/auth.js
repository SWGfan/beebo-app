const crypto = require('crypto')
const viewingPrivacy = require('./viewingPrivacy')
const householdPlan = require('./householdPlan')
const authSessions = require('./authSessions')
const securityLog = require('./securityLog')
const passwordPolicy = require('./passwordPolicy')

function guardPrivateCredentials(store, userId) {
  if (viewingPrivacy.isPrivate(store, userId)) {
    const error = new Error(viewingPrivacy.RECOVERY_MESSAGE)
    error.code = 'private_profile_self_recovery'
    throw error
  }
}

// Shared user-account logic used by both the public stream server (login/session
// checks) and the Electron main process (admin IPC handlers for the Users tab).
// Nothing here is reachable from the public internet except: submitting an access
// request, and logging in with a code you already have. Approving/denying/revoking
// only happens through the desktop app's IPC, never over HTTP.

const SESSION_DAYS = 365

// Memoized after the first read: verifySession runs on every request and
// electron-store re-reads + re-parses config.json on every get(). The secret
// is generated once and never rotated in-app — the only thing that can change
// it underneath us is a whole-store restore (backup.importBackup), which calls
// forgetSecrets() so the next request re-reads it.
let sessionSecretMemo = null
function getSecret(store) {
  if (sessionSecretMemo) return sessionSecretMemo
  let secret = store.get('sessionSecret')
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex')
    store.set('sessionSecret', secret)
  }
  sessionSecretMemo = secret
  return secret
}

function forgetSecrets() {
  sessionSecretMemo = null
  // A restore can swap the whole store, so the session list is re-read too.
  authSessions.reset()
}

// A key for one purpose (two-factor challenges, ...), derived from the session secret so
// nothing new has to be stored and a restore that swaps the secret retires them too.
function deriveKey(store, label) {
  return crypto.createHmac('sha256', getSecret(store)).update('beebo:' + String(label)).digest()
}

function normalizeCode(raw) {
  return String(raw || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase()
}

// --- access codes ---
//
// Codes used to be 4 characters (about a million combinations) stored as an
// unsalted SHA-256, which a proxy pool could guess online and anyone holding
// config.json could reverse instantly. Now:
//   - new codes are 8 characters from the same unambiguous alphabet (40 bits);
//   - hashes are salted scrypt, stored as "scrypt$N$r$p$salt$hash" so the cost
//     can be raised later without breaking what's saved;
//   - an old SHA-256 hash still verifies, and is rewritten as scrypt on that
//     person's next successful login (see findUserByUsernameAndSecret).
// Existing 4-character codes keep working; the Users tab recommends replacing
// them (isWeakCode / weakCodeUsers).
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no 0/O/1/I ambiguity
const CODE_LENGTH = 8
const STRONG_CODE_MIN_LENGTH = 8
// N=2^13, r=8 measured ~35-50 ms per check on the dev PC: login stays under
// 100 ms while an offline guess costs thousands of times more than SHA-256.
const CODE_KDF = { N: 8192, r: 8, p: 1, keylen: 32 }

function isLegacyCodeHash(stored) {
  return typeof stored === 'string' && /^[0-9a-f]{64}$/.test(stored)
}

function hashCode(code, { salt } = {}) {
  const { N, r, p, keylen } = CODE_KDF
  const s = salt || crypto.randomBytes(16).toString('hex')
  const dk = crypto.scryptSync(normalizeCode(code), s, keylen, { N, r, p, maxmem: 256 * N * r })
  return `scrypt$${N}$${r}$${p}$${s}$${dk.toString('hex')}`
}

function verifyCode(code, stored) {
  if (!stored || typeof stored !== 'string') return false
  const normalized = normalizeCode(code)
  if (!normalized) return false
  if (isLegacyCodeHash(stored)) {
    const legacy = crypto.createHash('sha256').update(normalized).digest()
    return crypto.timingSafeEqual(legacy, Buffer.from(stored, 'hex'))
  }
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, nStr, rStr, pStr, salt, hashHex] = parts
  const N = Number(nStr)
  const r = Number(rStr)
  const p = Number(pStr)
  // Refuse silly parameters from a hand-edited file instead of hanging login.
  if (!(N >= 2 && N <= 1 << 16 && (N & (N - 1)) === 0 && r >= 1 && r <= 16 && p >= 1 && p <= 4)) return false
  if (!salt || !/^[0-9a-f]{32,128}$/.test(hashHex || '')) return false
  const expected = Buffer.from(hashHex, 'hex')
  let candidate
  try {
    candidate = crypto.scryptSync(normalized, salt, expected.length, { N, r, p, maxmem: 256 * N * r })
  } catch {
    return false
  }
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected)
}

function generateCode() {
  return Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('')
}

// Someone still logging in with a short code (made before 8-character codes,
// or typed in by hand) and no password. Shown as "strengthen codes" in Users.
function isWeakCode(user) {
  if (!user || user.passwordHash || !(user.codeHash || user.code)) return false
  if (typeof user.code === 'string' && user.code) return normalizeCode(user.code).length < STRONG_CODE_MIN_LENGTH
  // No plain copy to measure: an unsalted hash can only be an old code.
  return isLegacyCodeHash(user.codeHash)
}

function weakCodeUsers(store) {
  return getUsers(store)
    .filter((u) => u.status === 'approved' && isWeakCode(u))
    .map((u) => ({ id: u.id, name: u.name, username: u.username }))
}

// --- real passwords (self-service signup) ---
//
// Uses Node's built-in scrypt instead of a package like bcrypt specifically
// because bcrypt ships a native module that has to be rebuilt for Electron —
// scrypt needs nothing extra and works identically across platforms. Stored
// as "salt:hash" (both hex) so verifyPassword doesn't need a separate salt
// column anywhere.
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex')
  return `${salt}:${hash}`
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string' || !stored.includes(':')) return false
  const [salt, hashHex] = stored.split(':')
  if (!salt || !hashHex) return false
  const expected = Buffer.from(hashHex, 'hex')
  const candidate = crypto.scryptSync(String(password || ''), salt, 64)
  if (candidate.length !== expected.length) return false
  return crypto.timingSafeEqual(candidate, expected)
}

function slugifyUsername(name) {
  const slug = String(name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 20)
  return slug || 'user'
}

function normalizeUsername(raw) {
  return String(raw || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '')
}

function uniqueUsername(store, base) {
  const users = getUsers(store)
  let candidate = base
  let n = 1
  while (users.some((u) => u.username === candidate)) {
    n += 1
    candidate = `${base}${n}`
  }
  return candidate
}

function getUsers(store) {
  const users = store.get('authUsers') || []
  // Backfill usernames for users created before login required one.
  let changed = false
  const seen = new Set()
  const withUsernames = users.map((u) => {
    if (u.username) {
      seen.add(u.username)
      return u
    }
    changed = true
    let base = slugifyUsername(u.name)
    let candidate = base
    let n = 1
    while (seen.has(candidate)) {
      n += 1
      candidate = `${base}${n}`
    }
    seen.add(candidate)
    return { ...u, username: candidate }
  })
  if (changed) store.set('authUsers', withUsernames)
  return withUsernames
}
function setUsers(store, users) {
  store.set('authUsers', users)
}
// Change one person's row in place: `change` is a patch object or a function from the current
// row to the new one. Returns the new row, or null if there is no such person.
function updateUser(store, userId, change) {
  let updated = null
  const users = getUsers(store).map((u) => {
    if (u.id !== userId) return u
    updated = typeof change === 'function' ? change(u) : { ...u, ...change }
    return updated
  })
  if (updated) setUsers(store, users)
  return updated
}
function getRequests(store) {
  return store.get('accessRequests') || []
}
function setRequests(store, reqs) {
  store.set('accessRequests', reqs)
}

function remoteEnabledUser(user) {
  if (!user || user.status !== 'approved' || hasRemoteAccess(user)) return { user, pass: null }
  const rm = require('./remoteMembers')
  const pass = rm.generateRemotePass()
  const next = { ...user, remoteAccessDisabled: false, remote: { ...rm.hashRemotePass(pass), enabledAt: Date.now() } }
  if (!next.passwordHash && next.code && verifyCode(next.code, next.codeHash)) {
    next.remoteLogin = rm.rememberLogin(next, next.code) || next.remoteLogin
  }
  const ready = next.remoteLogin?.from === rm.credentialFingerprint(next)
  return { user: next, pass: ready ? null : pass }
}

function applyRemoteDefault(store, user) {
  if (store.get('remoteAccessDefault') !== true || user.remoteAccessDisabled) return user
  return remoteEnabledUser(user).user
}

function enableAllRemoteAccess(store) {
  const passes = []
  let enabled = 0
  const users = getUsers(store).map(user => {
    if (user.status !== 'approved' || hasRemoteAccess(user)) return user
    const next = remoteEnabledUser(user)
    enabled++
    if (next.pass) passes.push({ id: user.id, name: user.name, username: user.username, pass: next.pass })
    return next.user
  })
  setUsers(store, users)
  store.set('remoteAccessDefault', true)
  return { ok: true, enabled, passes }
}

function createUser(store, name, email) {
  const place = householdPlan.admission(store)
  if (!place.ok) return place
  const users = getUsers(store)
  const code = generateCode()
  const username = uniqueUsername(store, slugifyUsername(name))
  const user = {
    id: crypto.randomUUID(),
    name: name?.trim() || 'Unnamed',
    username,
    email: (email || '').trim().toLowerCase(),
    code, // kept in plain text so the admin can always look it up again (this is a
    // private home-server PIN, not a real account password — trade-off made on
    // purpose so you never have to reset it blind)
    codeHash: hashCode(code),
    status: 'approved',
    isAdmin: false,
    createdAt: Date.now()
  }
  const approved = applyRemoteDefault(store, user)
  users.push(approved)
  setUsers(store, users)
  return { user: approved, code }
}

function revokeUser(store, userId) {
  const users = getUsers(store).map((u) => (u.id === userId ? { ...u, status: 'revoked' } : u))
  setUsers(store, users)
  // Status alone stops a token while the account is revoked, but every check re-reads it: approving the
  // person again (reactivateUser) would bring every cookie and token they (or a thief) still hold back to
  // life. End them now so a reactivated account starts with a clean slate.
  try { authSessions.revokeAll(store, userId) } catch {}
}

function deleteUser(store, userId) {
  const users = getUsers(store).filter((u) => u.id !== userId)
  setUsers(store, users)
  try { authSessions.forgetUser(store, userId) } catch {}
}

function setUserAdmin(store, userId, isAdmin) {
  const users = getUsers(store).map((u) => (u.id === userId ? { ...u, isAdmin: !!isAdmin } : u))
  setUsers(store, users)
}

/**
 * Turn away-from-home access on for one person and return the pass ONCE.
 *
 * The pass is generated here and only its PBKDF2 hash is ever stored or sent, so
 * nobody — not us, not the Worker — can read it back later. If it is lost, make
 * a new one; that is the trade for it not being recoverable from a stolen file.
 *
 * Nothing is pushed from here. The caller syncs, so the UI can show the pass even
 * if the network is down and catch up afterwards.
 */
function setUserRemoteAccess(store, userId) {
  const rm = require('./remoteMembers')
  const pass = rm.generateRemotePass()
  const rec = rm.hashRemotePass(pass)
  const users = getUsers(store).map((u) =>
    u.id === userId
      ? { ...u, remoteAccessDisabled: false, remote: { pw_hash: rec.pw_hash, pw_salt: rec.pw_salt, pw_iter: rec.pw_iter, enabledAt: Date.now() } }
      : u
  )
  setUsers(store, users)
  return pass
}

/** Turn it off for one person. Everyone else keeps theirs. */
function clearUserRemoteAccess(store, userId) {
  const users = getUsers(store).map((u) => {
    if (u.id !== userId) return u
    const { remote, ...rest } = u
    return { ...rest, remoteAccessDisabled: true }
  })
  setUsers(store, users)
}

/** Does this person currently have away-from-home access? */
function hasRemoteAccess(user) {
  return !!(user && user.remote && user.remote.pw_hash)
}

function renameUser(store, userId, name) {
  const users = getUsers(store).map((u) => (u.id === userId ? { ...u, name: name?.trim() || u.name } : u))
  setUsers(store, users)
}

function setUserEmail(store, userId, email) {
  guardPrivateCredentials(store, userId)
  const users = getUsers(store).map((u) =>
    u.id === userId ? { ...u, email: (email || '').trim().toLowerCase() } : u
  )
  setUsers(store, users)
}

function reactivateUser(store, userId) {
  const current = getUsers(store)
  const target = current.find(u => u.id === userId)
  if (!target) return { ok: false, error: 'not_found', message: 'That household member was not found.' }
  const place = householdPlan.admission(store, { userId })
  if (!place.ok) return place
  if (target.status === 'approved') return { ok: true, unchanged: true, user: target }
  const users = current.map((u) => (u.id === userId ? applyRemoteDefault(store, { ...u, status: 'approved' }) : u))
  setUsers(store, users)
  return { ok: true, user: users.find(u => u.id === userId) }
}

function regenerateCode(store, userId) {
  guardPrivateCredentials(store, userId)
  const code = generateCode()
  const users = getUsers(store).map((u) => (u.id === userId ? { ...u, code, codeHash: hashCode(code) } : u))
  setUsers(store, users)
  return code
}

// Admin sets a specific code for a user (the "change password" action) instead of
// a random one. Returns the normalized code that was actually saved.
function setUserCode(store, userId, rawCode) {
  guardPrivateCredentials(store, userId)
  const code = normalizeCode(rawCode)
  if (!code) return null
  const users = getUsers(store).map((u) => (u.id === userId ? { ...u, code, codeHash: hashCode(code) } : u))
  setUsers(store, users)
  return code
}

// --- self-service signup + email verification ---
//
// Separate from the admin-invite flow above (createUser/approveRequest,
// which still generates a short code): this lets anyone hit /signup, pick
// their own username + password, and verify ownership of their email before
// the account can log in. Chosen to auto-activate the moment the email link
// is clicked (no separate admin-approval step) — trade-off made on purpose
// since email verification is itself proof of a real, reachable person.
const SIGNUP_TOKEN_HOURS = 24

function usernameTaken(store, uname) {
  return getUsers(store).some((u) => u.username === uname)
}

function createSignup(store, { username, email, password }) {
  const uname = normalizeUsername(username)
  if (!uname || uname.length < 3) {
    return { error: 'Username must be at least 3 characters (letters and numbers only).' }
  }
  const emailNorm = (email || '').trim().toLowerCase()
  if (!emailNorm || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm)) {
    return { error: 'Enter a valid email address.' }
  }
  const weak = passwordPolicy.refusal(password, { username: uname, email: emailNorm })
  if (weak) return { error: weak }
  if (usernameTaken(store, uname)) {
    return { error: 'That username is already taken.' }
  }

  const place = householdPlan.admission(store)
  if (!place.ok) return place
  const token = crypto.randomBytes(24).toString('hex')
  const user = {
    id: crypto.randomUUID(),
    name: String(username).trim().slice(0, 40) || uname,
    username: uname,
    email: emailNorm,
    passwordHash: hashPassword(password),
    code: null,
    codeHash: null,
    status: 'pending_verification',
    isAdmin: false,
    createdAt: Date.now(),
    verifyToken: hashResetToken(token), // only the hash is kept (the mailed link is the one copy of the token)
    verifyTokenExpires: Date.now() + SIGNUP_TOKEN_HOURS * 60 * 60 * 1000
  }
  user.remoteLogin = require('./remoteMembers').rememberLogin(user, password)
  const users = getUsers(store)
  users.push(user)
  setUsers(store, users)
  return { user, token }
}

// Returns { ok: true, user } on success, or { ok: false, reason } where
// reason is 'invalid' (no such token / already used) or 'expired'.
function verifySignupToken(store, token) {
  if (!token) return { ok: false, reason: 'invalid' }
  const users = getUsers(store)
  // Constant-time; matches the stored hash, or a raw token stored by an older build.
  const user = users.find((u) => u.verifyToken && (equalStrings(u.verifyToken, hashResetToken(token)) || equalStrings(u.verifyToken, token)))
  if (!user) return { ok: false, reason: 'invalid' }
  if (user.verifyTokenExpires && Date.now() > user.verifyTokenExpires) {
    return { ok: false, reason: 'expired' }
  }
  const updated = users.map((u) =>
    u.id === user.id ? applyRemoteDefault(store, { ...u, status: 'approved', verifyToken: null, verifyTokenExpires: null }) : u
  )
  setUsers(store, updated)
  return { ok: true, user }
}

// Admin-driven password reset for pre-existing accounts still on the old
// generated-code system (from the Users tab, one at a time) — moves that
// account onto real passwords and clears its code so the code stops working.
function setUserPassword(store, userId, rawPassword) {
  if (viewingPrivacy.isPrivate(store, userId)) return { ok: false, error: viewingPrivacy.RECOVERY_MESSAGE }
  const target = getUsers(store).find((u) => u.id === userId)
  const weak = passwordPolicy.refusal(rawPassword, { username: target && target.username, name: target && target.name, email: target && target.email })
  if (weak) return { error: weak }
  applyNewPassword(store, userId, rawPassword, { reason: 'owner_set' })
  return { ok: true }
}

// The one place a new password lands, for every route to one (owner sets it, the email reset
// link, an owner's one-time reset code, the person changing their own): hash it, retire the old
// access code and any reset link/code, make it work away from home straight away (the owner's
// set had this: before, a password set here only worked away once the person had signed in on this
// computer), and sign the account out of every other device - whoever held the old password
// (or a stolen cookie) loses their way in. keepSid keeps the device that is making the change.
// The caller has already checked the new password with passwordPolicy.
function applyNewPassword(store, userId, newPassword, { reason = 'changed', keepSid, ip } = {}) {
  let changed = null
  const users = getUsers(store).map((u) => {
    if (u.id !== userId) return u
    changed = {
      ...u,
      passwordHash: hashPassword(newPassword),
      code: null,
      codeHash: null,
      resetToken: null,
      resetTokenHash: null,
      resetTokenExpires: null,
      resetCode: null,
      ...(u.viewingHistoryPrivate ? { privacySessionSalt: crypto.randomBytes(24).toString('hex') } : {})
    }
    return changed
  })
  if (!changed) return null
  setUsers(store, users)
  rememberRemoteLogin(store, changed, newPassword)
  try { authSessions.revokeAll(store, userId, { exceptSid: keepSid }) } catch {}
  securityLog.record(store, { type: 'password_changed', userId, username: changed.username, known: true, ip, detail: reason })
  return changed
}

// Login lookup used by /login now — checks a real password if the account
// has one (self-service signups, or anyone an admin has manually reset),
// otherwise falls back to the legacy access code so existing accounts keep
// working until they're migrated.
// A right username costs one scrypt check and a wrong one used to cost nothing, so the time a login
// took told a stranger which names exist. An unknown (or unusable) account now pays for one check
// against a throwaway hash, the way resetCodes.js already does.
let dummyPasswordHash = null
function burnPasswordCheck(secret) {
  try {
    if (!dummyPasswordHash) dummyPasswordHash = hashPassword(crypto.randomBytes(16).toString('hex'))
    verifyPassword(secret, dummyPasswordHash)
  } catch {}
}

function findUserByUsernameAndSecret(store, username, secret) {
  const uname = normalizeUsername(username)
  if (!uname) return null
  const user = getUsers(store).find((u) => u.username === uname && u.status === 'approved')
  if (!user || !(user.passwordHash || user.codeHash)) { burnPasswordCheck(secret); return null }
  let signedIn = null
  if (user.passwordHash) {
    if (verifyPassword(secret, user.passwordHash)) signedIn = user
  } else if (user.codeHash && verifyCode(secret, user.codeHash)) {
    signedIn = user
    if (isLegacyCodeHash(user.codeHash)) {
      // Transparent upgrade: the code was right, so re-hash it with scrypt now.
      const upgraded = hashCode(secret)
      setUsers(
        store,
        getUsers(store).map((u) => (u.id === user.id && u.codeHash === user.codeHash ? { ...u, codeHash: upgraded } : u))
      )
      signedIn = { ...user, codeHash: upgraded }
    }
  }
  if (!signedIn) return null
  rememberRemoteLogin(store, signedIn, secret)
  return signedIn
}

// Someone with away-from-home access just proved their password here: keep a hash of
// it the Worker can check, so the phone app's one sign-in screen takes the same
// username and password away from home. Never throws; login must not depend on it.
function rememberRemoteLogin(store, user, secret) {
  try {
    const rec = require('./remoteMembers').rememberLogin(user, secret)
    if (!rec) return
    setUsers(store, getUsers(store).map((u) => (u.id === user.id ? { ...u, remoteLogin: rec } : u)))
  } catch (e) {}
}

function submitAccessRequest(store, name, email, message) {
  const reqs = getRequests(store)
  const entry = {
    id: crypto.randomUUID(),
    name: (name || 'Anonymous').trim().slice(0, 80),
    email: (email || '').trim().toLowerCase().slice(0, 200),
    message: (message || '').trim().slice(0, 300),
    status: 'pending',
    createdAt: Date.now()
  }
  reqs.push(entry)
  setRequests(store, reqs)
  return entry
}

function approveRequest(store, requestId) {
  const reqs = getRequests(store)
  const reqEntry = reqs.find((r) => r.id === requestId)
  if (!reqEntry) return null
  if (reqEntry.status && reqEntry.status !== 'pending') return { ok: false, error: 'request_already_processed', message: 'This access request has already been processed.' }
  const result = createUser(store, reqEntry.name, reqEntry.email)
  if (result.error) return result
  setRequests(
    store,
    reqs.map((r) => (r.id === requestId ? { ...r, status: 'approved', userId: result.user.id } : r))
  )
  return result
}

function findApprovedUserByEmail(store, email) {
  const normalized = (email || '').trim().toLowerCase()
  if (!normalized) return null
  return getUsers(store).find((u) => u.email === normalized && u.status === 'approved') || null
}

// --- forgot password (self-service reset for anyone with a real password) ---
//
// Separate from /forgot-code above, which re-issues the legacy access code —
// this issues a time-limited reset token instead, since there's no plaintext
// password to just email back. Works for any approved account regardless of
// whether it currently has a password or is still on a code: resetting sets
// a real password either way, so this doubles as another self-service path
// off codes (alongside the admin's manual "switch to password" in Users).
const RESET_TOKEN_HOURS = 1

// A reset link's token is 192 random bits, so a plain SHA-256 is enough to keep config.json from
// holding a working link: only the hash is stored, and the link (mailed, or shown to the owner)
// is the only place the token exists. Links made before this stored the token itself
// (resetToken); those still work until they expire.
function hashResetToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex')
}

function equalStrings(a, b) {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

function createPasswordResetToken(store, email, { ip } = {}) {
  const user = findApprovedUserByEmail(store, email)
  if (!user) return null
  const token = crypto.randomBytes(24).toString('hex')
  updateUser(store, user.id, {
    resetToken: null,
    resetTokenHash: hashResetToken(token),
    resetTokenExpires: Date.now() + RESET_TOKEN_HOURS * 60 * 60 * 1000
  })
  securityLog.record(store, { type: 'password_reset_requested', userId: user.id, username: user.username, known: true, ip })
  return { user, token }
}

// Returns { ok: true } on success, or { ok: false, reason } where reason is
// 'invalid' (no such token / already used), 'expired', or a validation
// message for the new password itself.
function resetPasswordWithToken(store, token, newPassword, { ip } = {}) {
  if (!token || typeof token !== 'string') return { ok: false, reason: 'invalid' }
  const hash = hashResetToken(token)
  const users = getUsers(store)
  const user = users.find(
    (u) => (u.resetTokenHash && equalStrings(u.resetTokenHash, hash)) || (u.resetToken && equalStrings(u.resetToken, token))
  )
  if (!user) {
    securityLog.record(store, { type: 'password_reset_failed', ip, detail: 'unknown or used reset link' })
    return { ok: false, reason: 'invalid' }
  }
  if (user.resetTokenExpires && Date.now() > user.resetTokenExpires) {
    return { ok: false, reason: 'expired' }
  }
  const weak = passwordPolicy.refusal(newPassword, { username: user.username, name: user.name, email: user.email })
  if (weak) return { ok: false, reason: weak }
  applyNewPassword(store, user.id, newPassword, { reason: 'email reset link', ip })
  securityLog.record(store, { type: 'password_reset_completed', userId: user.id, username: user.username, known: true, ip, detail: 'email reset link' })
  return { ok: true }
}

function denyRequest(store, requestId) {
  const reqs = getRequests(store)
  setRequests(
    store,
    reqs.map((r) => (r.id === requestId ? { ...r, status: 'denied' } : r))
  )
}

function findApprovedUserByCode(store, code) {
  return getUsers(store).find((u) => u.status === 'approved' && u.codeHash && verifyCode(code, u.codeHash)) || null
}

function findApprovedUserByUsernameAndCode(store, username, code) {
  const uname = normalizeUsername(username)
  return (
    getUsers(store).find((u) => u.username === uname && u.status === 'approved' && u.codeHash && verifyCode(code, u.codeHash)) ||
    null
  )
}

// --- presence (best-effort "online now" indicator, driven by requests from the
// public site — page loads, video-progress pings, and a small heartbeat while a
// tab is open) ---

// Now records the IP the request came from alongside the timestamp (was just
// a bare number before) — lets the Users tab show "last online ... from
// <ip>" instead of only a time, and gives something to look at if an
// account's access ever needs auditing. Keeps whatever IP was last seen if a
// particular call site doesn't have one to pass (e.g. an older caller).
//
// Throttled: this is called on every authenticated request (each video Range
// request, every 20 s heartbeat, every progress ping) and electron-store has
// no write cache — every set() is a full read + stringify + fsync'd temp-file
// rename of config.json. So the freshest value per user lives in
// `lastSeenLive` below and the store copy is refreshed at most once a minute
// per user. An IP change is written sooner (the "from <ip>" part is the
// audit-worthy bit), but with a short floor so two devices on one account
// alternating requests can't turn that back into a write per request.
// getLastSeenMap overlays the live values, so the Users tab / admin API still
// see the exact latest time and ip, never the throttled one.
const LAST_SEEN_WRITE_MS = 60 * 1000
const LAST_SEEN_IP_CHANGE_FLOOR_MS = 10 * 1000
const lastSeenLive = new Map() // userId -> { time, ip, writtenAt, writtenIp }

function touchLastSeen(store, userId, ip) {
  const now = Date.now()
  const live = lastSeenLive.get(userId)
  const nextIp = ip || (live && live.ip) || null
  const sinceWrite = live ? now - live.writtenAt : Infinity
  const ipChanged = !!live && nextIp !== live.writtenIp
  const due =
    !live ||
    sinceWrite < 0 || // clock went backwards — don't get stuck never writing
    sinceWrite >= LAST_SEEN_WRITE_MS ||
    (ipChanged && sinceWrite >= LAST_SEEN_IP_CHANGE_FLOOR_MS)
  if (!due) {
    live.time = now
    live.ip = nextIp
    return
  }
  const seen = store.get('userLastSeen') || {}
  const prev = seen[userId]
  const prevIp = prev && typeof prev === 'object' ? prev.ip : null
  const entry = { time: now, ip: nextIp || prevIp || null }
  seen[userId] = entry
  store.set('userLastSeen', seen)
  lastSeenLive.set(userId, { time: now, ip: entry.ip, writtenAt: now, writtenIp: entry.ip })
}

function getLastSeenMap(store) {
  const seen = Object.assign({}, store.get('userLastSeen') || {})
  // Overlay the in-memory values (see touchLastSeen) so readers get the real
  // latest sighting, not the last one that happened to be flushed to disk.
  for (const [userId, live] of lastSeenLive) {
    const prev = seen[userId]
    const prevTime = prev && typeof prev === 'object' ? prev.time || 0 : typeof prev === 'number' ? prev : 0
    if (live.time >= prevTime) {
      seen[userId] = { time: live.time, ip: live.ip || (prev && typeof prev === 'object' ? prev.ip : null) || null }
    }
  }
  return seen
}

// --- "admin" username watch — logs every login attempt (successful or not)
// that used the literal username "admin", and keeps a rolling history so it
// shows up in the Users tab even without checking email. Most real users get
// an auto-generated username (nick, samplehouse86, etc), so someone typing
// "admin" specifically is almost always a probe, not a real login — worth a
// heads up either way.
const MAX_ADMIN_ATTEMPTS = 200

function logAdminUsernameAttempt(store, { ip, success }) {
  const list = store.get('adminUsernameAttempts') || []
  list.unshift({ time: Date.now(), ip: ip || null, success: !!success })
  store.set('adminUsernameAttempts', list.slice(0, MAX_ADMIN_ATTEMPTS))
}

function getAdminUsernameAttempts(store) {
  return store.get('adminUsernameAttempts') || []
}

// --- login lockout + failed-attempt alerting ---
//
// Three layers, all checked BEFORE the submitted code/password is compared (so
// a locked-out guesser burns no scrypt time and learns nothing):
//
// 1. Per IP (as before): N failed attempts from one address (default 5,
//    adjustable in the Admin tab) lock it out. The lock length now doubles on
//    each repeat offence (5, 10, 20 … minutes, capped at a day), and the
//    strike count is forgotten after a quiet day.
// 2. Per username: an attacker rotating through a proxy pool never trips the
//    per-IP limit, so failures against one username are also counted across
//    every address. ACCOUNT_LOCK_THRESHOLD of them inside ACCOUNT_WINDOW_MS
//    lock that username for a minute, doubling per repeat up to an hour.
//    Every username tried is tracked, real or not, so the lock doesn't reveal
//    which accounts exist.
// 3. Server-wide: more than GLOBAL_MAX_FAILURES failures in GLOBAL_WINDOW_MS
//    and new attempts are refused until the rate drops.
//
// So an attacker can't lock the real person out of their own account, the
// account and server-wide locks don't apply to the address that person last
// used successfully (auth.getLastSeenMap). The per-IP lock always applies.
//
// Every failure is also logged (time, ip, username tried) for the Admin tab,
// capped to the most recent 200, and counted towards the alert email (default
// every 30, adjustable).
//
// Storage: all of this used to be rewritten to config.json (a full read,
// stringify and fsync'd rename) on every single failed attempt, and the per-IP
// map was never pruned, so a proxy pool could grow the file without limit. It
// now lives in memory, is pruned as it goes, and is flushed at most every
// LOGIN_FLUSH_MS (and by flushLoginState) with at most MAX_TRACKED entries.
const DEFAULT_LOCKOUT_THRESHOLD = 5
const DEFAULT_LOCKOUT_DURATION_MINUTES = 5
const DEFAULT_ALERT_THRESHOLD = 30
const MAX_FAILED_LOG = 200

const IP_LOCK_CAP_MS = 24 * 60 * 60 * 1000
const ACCOUNT_LOCK_THRESHOLD = 10
const ACCOUNT_WINDOW_MS = 15 * 60 * 1000
const ACCOUNT_BASE_LOCK_MS = 60 * 1000
const ACCOUNT_LOCK_CAP_MS = 60 * 60 * 1000
const GLOBAL_WINDOW_MS = 10 * 60 * 1000
const GLOBAL_MAX_FAILURES = 60
const STRIKE_RESET_MS = 24 * 60 * 60 * 1000
const MAX_TRACKED = 1000
const LOGIN_FLUSH_MS = 5000

// All clamped to sane minimums so a stray "0" saved from the Admin tab can't
// lock out every single login attempt, lock people out forever, or spam an
// email on every one.
function getLockoutThreshold(store) {
  const v = Number(store.get('loginLockoutThreshold'))
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : DEFAULT_LOCKOUT_THRESHOLD
}

function getLockoutDurationMinutes(store) {
  const v = Number(store.get('loginLockoutDurationMinutes'))
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : DEFAULT_LOCKOUT_DURATION_MINUTES
}

function getAlertThreshold(store) {
  const v = Number(store.get('loginAlertThreshold'))
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : DEFAULT_ALERT_THRESHOLD
}

// One in-memory copy per store (tests use several).
const loginStates = new WeakMap()

function entriesFrom(obj) {
  const map = new Map()
  if (!obj || typeof obj !== 'object') return map
  for (const [key, e] of Object.entries(obj)) {
    if (!e || typeof e !== 'object') continue
    map.set(key, {
      attempts: Array.isArray(e.attempts) ? e.attempts.filter((t) => Number.isFinite(t)) : [],
      lockedUntil: Number(e.lockedUntil) || 0,
      strikes: Number(e.strikes) || 0,
      lastFailAt: Number(e.lastFailAt) || Math.max(0, ...(Array.isArray(e.attempts) ? e.attempts : []), Number(e.lockedUntil) || 0)
    })
  }
  return map
}

function loginState(store) {
  let st = loginStates.get(store)
  if (st) return st
  const log = store.get('failedLoginLog')
  st = {
    ips: entriesFrom(store.get('loginLockouts')),
    accounts: entriesFrom(store.get('loginAccountLockouts')),
    global: [],
    log: Array.isArray(log) ? log.slice(0, MAX_FAILED_LOG) : [],
    alertCounter: Number(store.get('failedLoginAlertCounter')) || 0,
    dirty: false,
    timer: null
  }
  loginStates.set(store, st)
  pruneLoginState(st, Date.now())
  return st
}

function pruneMap(map, windowMs, now) {
  for (const [key, e] of map) {
    e.attempts = e.attempts.filter((t) => now - t < windowMs && t <= now)
    if (e.lockedUntil > now || e.attempts.length) continue
    // Nothing active: keep only the strike count, and only for a day.
    if (!e.strikes || now - e.lastFailAt >= STRIKE_RESET_MS) map.delete(key)
  }
  if (map.size <= MAX_TRACKED) return
  // Over the cap: drop the least interesting first (not locked, oldest failure).
  const ranked = [...map.entries()].sort((a, b) => {
    const la = a[1].lockedUntil > now ? 1 : 0
    const lb = b[1].lockedUntil > now ? 1 : 0
    return la - lb || a[1].lastFailAt - b[1].lastFailAt
  })
  for (let i = 0; map.size > MAX_TRACKED && i < ranked.length; i++) map.delete(ranked[i][0])
}

function pruneLoginState(st, now, ipWindowMs = DEFAULT_LOCKOUT_DURATION_MINUTES * 60 * 1000) {
  pruneMap(st.ips, ipWindowMs, now)
  pruneMap(st.accounts, ACCOUNT_WINDOW_MS, now)
  st.global = st.global.filter((t) => now - t < GLOBAL_WINDOW_MS && t <= now)
}

function mapToObject(map) {
  const out = {}
  for (const [key, e] of map) out[key] = { attempts: e.attempts, lockedUntil: e.lockedUntil, strikes: e.strikes, lastFailAt: e.lastFailAt }
  return out
}

function flushLoginState(store) {
  // Same quit-time flush for the other in-memory account-security state.
  try { securityLog.flush(store) } catch {}
  try { authSessions.flush(store) } catch {}
  const st = loginStates.get(store)
  if (!st) return false
  if (st.timer) {
    clearTimeout(st.timer)
    st.timer = null
  }
  if (!st.dirty) return false
  pruneLoginState(st, Date.now(), getLockoutDurationMinutes(store) * 60 * 1000)
  st.dirty = false
  store.set('loginLockouts', mapToObject(st.ips))
  store.set('loginAccountLockouts', mapToObject(st.accounts))
  store.set('failedLoginLog', st.log)
  store.set('failedLoginAlertCounter', st.alertCounter)
  return true
}

function markDirty(store, st) {
  st.dirty = true
  if (st.timer) return
  st.timer = setTimeout(() => {
    st.timer = null
    try {
      flushLoginState(store)
    } catch {}
  }, LOGIN_FLUSH_MS)
  if (st.timer && typeof st.timer.unref === 'function') st.timer.unref()
}

function lockMs(base, strikes, cap) {
  return Math.min(cap, base * Math.pow(2, Math.min(20, Math.max(0, strikes - 1))))
}

// One failure against a counter (per IP or per username). Returns true if it
// has just become locked.
function bumpEntry(map, key, now, { windowMs, threshold, baseMs, capMs }) {
  const entry = map.get(key) || { attempts: [], lockedUntil: 0, strikes: 0, lastFailAt: 0 }
  if (entry.strikes && now - entry.lastFailAt >= STRIKE_RESET_MS) entry.strikes = 0
  entry.attempts = entry.attempts.filter((t) => now - t < windowMs && t <= now)
  entry.attempts.push(now)
  entry.lastFailAt = now
  let locked = false
  if (entry.attempts.length >= threshold) {
    entry.strikes += 1
    entry.lockedUntil = now + lockMs(baseMs, entry.strikes, capMs)
    entry.attempts = []
    locked = true
  }
  map.set(key, entry)
  return locked ? entry.lockedUntil - now : 0
}

function isLoopbackIp(ip) {
  const s = String(ip || '').replace(/^::ffff:/i, '')
  return !s || s === '::1' || s.startsWith('127.') || s === 'unknown'
}

// The address this account last signed in from (not loopback, which the local
// host agent can share with others). Such a device gets past the account and
// server-wide locks, so an attacker can't lock the real person out.
function isTrustedIpForUsername(store, uname, ip) {
  if (!uname || isLoopbackIp(ip)) return false
  try {
    const user = getUsers(store).find((u) => u.username === uname)
    if (!user) return false
    const seen = getLastSeenMap(store)[user.id]
    return !!(seen && typeof seen === 'object' && seen.ip && seen.ip === ip)
  } catch {
    return false
  }
}

function lockedResult(scope, until, now) {
  const remainingMs = until - now
  return { locked: true, scope, remainingMs, minutesRemaining: Math.max(1, Math.ceil(remainingMs / 60000)) }
}

function recordFailedLogin(store, { ip, username }) {
  const key = ip || 'unknown'
  const st = loginState(store)
  const now = Date.now()
  const lockoutThreshold = getLockoutThreshold(store)
  const alertThreshold = getAlertThreshold(store)
  const baseMs = getLockoutDurationMinutes(store) * 60 * 1000
  pruneLoginState(st, now, baseMs)

  const ipLockMs = bumpEntry(st.ips, key, now, { windowMs: baseMs, threshold: lockoutThreshold, baseMs, capMs: IP_LOCK_CAP_MS })
  const uname = normalizeUsername(username)
  const accountLockMs = uname
    ? bumpEntry(st.accounts, uname, now, {
        windowMs: ACCOUNT_WINDOW_MS,
        threshold: ACCOUNT_LOCK_THRESHOLD,
        baseMs: ACCOUNT_BASE_LOCK_MS,
        capMs: ACCOUNT_LOCK_CAP_MS
      })
    : 0
  st.global.push(now)

  st.log.unshift({ time: now, ip, username: username ? String(username).slice(0, 60) : null })
  if (st.log.length > MAX_FAILED_LOG) st.log.length = MAX_FAILED_LOG

  st.alertCounter += 1
  let shouldAlert = false
  if (st.alertCounter >= alertThreshold) {
    shouldAlert = true
    st.alertCounter = 0
  }
  markDirty(store, st)

  return {
    justLocked: ipLockMs > 0,
    accountLocked: accountLockMs > 0,
    shouldAlert,
    alertCount: alertThreshold,
    lockoutThreshold,
    lockoutDurationMinutes: Math.max(1, Math.round((ipLockMs || baseMs) / 60000)),
    accountLockMinutes: accountLockMs ? Math.max(1, Math.ceil(accountLockMs / 60000)) : 0
  }
}

// Checked BEFORE the username/code are even compared. `username` is optional
// (older callers); without it only the per-IP lock is checked. Routes behind a
// session pass trustLastSeenIp: false: every signed-in request refreshes the
// last-seen address, so there the exemption would always match the guesser.
function checkLockout(store, ip, username, { trustLastSeenIp = true } = {}) {
  const key = ip || 'unknown'
  const st = loginState(store)
  const now = Date.now()
  const ipEntry = st.ips.get(key)
  if (ipEntry && ipEntry.lockedUntil > now) return lockedResult('ip', ipEntry.lockedUntil, now)
  const uname = username === undefined ? '' : normalizeUsername(username)
  const acct = uname ? st.accounts.get(uname) : null
  const accountLocked = !!(acct && acct.lockedUntil > now)
  st.global = st.global.filter((t) => now - t < GLOBAL_WINDOW_MS && t <= now)
  const globalLocked = username !== undefined && st.global.length >= GLOBAL_MAX_FAILURES
  if ((accountLocked || globalLocked) && !(trustLastSeenIp && isTrustedIpForUsername(store, uname, ip))) {
    if (accountLocked) return lockedResult('account', acct.lockedUntil, now)
    // Opens again once enough of the window's failures have aged out.
    const reopenAt = st.global[st.global.length - GLOBAL_MAX_FAILURES] + GLOBAL_WINDOW_MS
    return lockedResult('global', reopenAt, now)
  }
  return { locked: false }
}

// Called on a successful login, or by the Admin tab's Unlock button — clears
// that IP's failed-attempt count so a real user who mistyped their code a
// couple of times isn't one guess from a lockout next time. The Admin tab
// lists username locks as "account:<username>"; unlocking one clears it.
function clearFailedLogin(store, ip) {
  const key = ip || 'unknown'
  const st = loginState(store)
  const map = key.startsWith('account:') ? st.accounts : st.ips
  const mapKey = key.startsWith('account:') ? normalizeUsername(key.slice(8)) : key
  if (map.has(mapKey)) {
    map.delete(mapKey)
    markDirty(store, st)
  }
}

function getFailedLoginLog(store) {
  return loginState(store).log.slice()
}

// Wipes the failed-attempt history shown in the Admin tab — doesn't touch
// any active lockout, so clearing the log doesn't let a currently-locked-out
// IP back in early (use clearFailedLogin/the "Unlock" button for that).
function clearFailedLoginLog(store) {
  loginState(store).log = []
  store.set('failedLoginLog', [])
}

function clearAdminUsernameAttempts(store) {
  store.set('adminUsernameAttempts', [])
}

// Currently-locked-out IPs (and usernames, as "account:<name>"), for the Admin
// tab — filters out anything whose lockout has already expired.
function getActiveLockouts(store) {
  const st = loginState(store)
  const now = Date.now()
  const out = []
  for (const [ip, e] of st.ips) if (e.lockedUntil > now) out.push({ ip, lockedUntil: e.lockedUntil, kind: 'ip' })
  for (const [name, e] of st.accounts) if (e.lockedUntil > now) out.push({ ip: `account:${name}`, lockedUntil: e.lockedUntil, kind: 'account' })
  return out.sort((a, b) => b.lockedUntil - a.lockedUntil)
}

function isUserApproved(store, userId) {
  const u = getUsers(store).find((x) => x.id === userId)
  return !!u && u.status === 'approved'
}

// --- session cookie (HMAC-signed, no server-side session storage needed) ---

// Cookie shapes (all signed with the session secret):
//   userId.expires.sig            made before the session list existed, and by code that has no
//                                 request to describe (tests, internal callers). Still valid, and
//                                 ended by "sign out everywhere" through the cut-off time.
//   userId.expires.sid.sig        a signed-in device with a record in authSessions (listed,
//                                 individually revocable). Made when someone signs in.
//   userId.expires.desktop.sig    the desktop app's own windows (the owner opening BeeboSchool, the
//                                 web player). A trusted local window: not listed, never revoked
//                                 remotely, exempt from the "admins must use two-factor" hold.
// signSession(store, userId)                                          -> legacy cookie
// signSession(store, userId, { track: true, ip, userAgent, method })  -> tracked cookie
// signSession(store, userId, { desktop: true })                       -> desktop cookie
function signSession(store, userId, opts) {
  const secret = getSecret(store)
  const now = Date.now()
  const expires = now + SESSION_DAYS * 24 * 60 * 60 * 1000
  let payload = `${userId}.${expires}`
  if (opts && opts.desktop) {
    payload += '.desktop'
  } else if (opts && opts.track) {
    const made = authSessions.create(store, userId, { ip: opts.ip, userAgent: opts.userAgent, method: opts.method, kind: 'web', days: SESSION_DAYS, now })
    payload += `.${made.sid}`
  }
  const salt = viewingPrivacy.sessionSalt(store, userId)
  const sig = crypto.createHmac('sha256', secret).update(salt ? `${payload}|${salt}` : payload).digest('hex')
  return `${payload}.${sig}`
}

// What a cookie says about itself, WITHOUT checking it (call verifySession for that).
function parseSessionCookie(cookieValue) {
  const parts = String(cookieValue || '').split('.')
  if (parts.length === 3) return { userId: parts[0], sid: null, desktop: false, legacy: true }
  if (parts.length === 4) return { userId: parts[0], sid: parts[2] === 'desktop' ? null : parts[2], desktop: parts[2] === 'desktop', legacy: false }
  return null
}

function verifySession(store, cookieValue) {
  if (!cookieValue) return null
  const parts = cookieValue.split('.')
  if (parts.length !== 3 && parts.length !== 4) return null
  const userId = parts[0]
  const expiresStr = parts[1]
  const sid = parts.length === 4 ? parts[2] : null
  const sig = parts[parts.length - 1]
  const secret = getSecret(store)
  const salt = viewingPrivacy.sessionSalt(store, userId)
  const payload = sid ? `${userId}.${expiresStr}.${sid}` : `${userId}.${expiresStr}`
  const expected = crypto.createHmac('sha256', secret).update(salt ? `${payload}|${salt}` : payload).digest('hex')
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null
  if (Date.now() > Number(expiresStr)) return null
  if (!isUserApproved(store, userId)) return null
  if (!sid) {
    // No session record: only the person's cut-off ("sign out everywhere") can end it.
    if (authSessions.issuedBeforeCutoff(store, userId, Number(expiresStr) - SESSION_DAYS * 24 * 60 * 60 * 1000)) return null
  } else if (sid !== 'desktop' && !authSessions.check(store, userId, sid)) {
    return null
  }
  return userId
}

function parseCookies(req) {
  const header = req.headers.cookie || ''
  const out = {}
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=')
    if (idx === -1) return
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim())
  })
  return out
}

// --- first-run owner bootstrap ---
// The very first account on a brand-new server: a real username + password, admin, approved,
// with no email or invite code. Deliberately refuses once an owner already exists, so it can only
// ever create the FIRST admin (the setup wizard calls it on a fresh install).
function hasOwner(store) {
  return getUsers(store).some((u) => u && u.isAdmin && u.status === 'approved')
}

function createOwner(store, { username, password } = {}) {
  if (hasOwner(store)) return { error: 'This server already has an owner account.' }
  const uname = normalizeUsername(username)
  if (!uname || uname.length < 3) return { error: 'Username must be at least 3 characters (letters and numbers only).' }
  // The first owner keeps the old 6-character floor (setup wizards and headless installs use it),
  // but the most-breached passwords are refused like everywhere else.
  const weak = passwordPolicy.refusal(password, { username: uname, minLength: 6 })
  if (weak) return { error: weak }
  if (getUsers(store).some((u) => u.username === uname)) return { error: 'That username is already taken.' }
  const place = householdPlan.admission(store)
  if (!place.ok) return place
  const user = {
    id: crypto.randomUUID(),
    name: String(username).trim().slice(0, 40) || uname,
    username: uname,
    email: '',
    passwordHash: hashPassword(password),
    code: null,
    codeHash: null,
    status: 'approved',
    isAdmin: true,
    createdAt: Date.now()
  }
  const users = getUsers(store)
  users.push(user)
  setUsers(store, users)
  return { user }
}

module.exports = {
  normalizeCode,
  hasOwner,
  createOwner,
  normalizeUsername,
  getUsers,
  getRequests,
  createUser,
  revokeUser,
  reactivateUser,
  deleteUser,
  setUserAdmin,
  setUserRemoteAccess,
  enableAllRemoteAccess,
  clearUserRemoteAccess,
  hasRemoteAccess,
  renameUser,
  setUserEmail,
  setUserCode,
  hashPassword,
  verifyPassword,
  createSignup,
  verifySignupToken,
  setUserPassword,
  findUserByUsernameAndSecret,
  touchLastSeen,
  getLastSeenMap,
  logAdminUsernameAttempt,
  getAdminUsernameAttempts,
  recordFailedLogin,
  checkLockout,
  clearFailedLogin,
  getFailedLoginLog,
  clearFailedLoginLog,
  clearAdminUsernameAttempts,
  getActiveLockouts,
  flushLoginState,
  hashCode,
  verifyCode,
  isLegacyCodeHash,
  isWeakCode,
  weakCodeUsers,
  generateCode,
  CODE_LENGTH,
  getLockoutThreshold,
  getAlertThreshold,
  getLockoutDurationMinutes,
  DEFAULT_LOCKOUT_THRESHOLD,
  DEFAULT_ALERT_THRESHOLD,
  DEFAULT_LOCKOUT_DURATION_MINUTES,
  regenerateCode,
  submitAccessRequest,
  approveRequest,
  denyRequest,
  findApprovedUserByCode,
  findApprovedUserByUsernameAndCode,
  findApprovedUserByEmail,
  createPasswordResetToken,
  resetPasswordWithToken,
  signSession,
  verifySession,
  parseSessionCookie,
  applyNewPassword,
  updateUser,
  deriveKey,
  hashResetToken,
  forgetSecrets,
  parseCookies
}
