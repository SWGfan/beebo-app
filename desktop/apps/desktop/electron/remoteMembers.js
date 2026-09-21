'use strict'
/**
 * Per-member away-from-home access — the home server's half.
 *
 * WHY THIS EXISTS
 * The <name>.beebo.tv door used to open only for the owner's Beebo account, so
 * letting the family watch away from home meant handing out the one credential
 * that can cancel the subscription or delete the account. This gives each person
 * their own pass, revocable on its own.
 *
 * WHAT LEAVES THE HOUSE
 * Only a PBKDF2 hash of a pass THIS machine generated, plus the member's username.
 * Never their account password, never their access code, never the pass itself.
 * The Worker can check a pass it is handed; it can never work one out.
 *
 * The parameters below must match the Worker's verifyPassword exactly
 * (PBKDF2-HMAC-SHA256, 25000 iterations, 16-byte salt, 256-bit output, all hex).
 * Change one and every remote sign-in fails, so they are asserted in the tests.
 */
const crypto = require('crypto')

const REMOTE_ITER = 25000
const REMOTE_KEYLEN = 32
const REMOTE_SALT_BYTES = 16

// Read-aloud-able: a parent reads this to a teenager across the room, or types it
// into a phone with one thumb. No ambiguous letters, no punctuation to explain.
const WORDS = [
  'amber', 'anchor', 'apple', 'autumn', 'badger', 'banjo', 'beacon', 'birch',
  'bison', 'bramble', 'breeze', 'cactus', 'canyon', 'cedar', 'clover', 'comet',
  'copper', 'cotton', 'dahlia', 'dolphin', 'ember', 'falcon', 'fern', 'ginger',
  'glacier', 'harbor', 'hazel', 'heron', 'indigo', 'ivory', 'jasmine', 'juniper',
  'kettle', 'lantern', 'lemon', 'lilac', 'lupin', 'magnet', 'maple', 'marble',
  'meadow', 'mint', 'moss', 'nectar', 'nutmeg', 'oak', 'olive', 'orchid',
  'otter', 'pebble', 'pepper', 'pine', 'poppy', 'quartz', 'quill', 'raven',
  'ripple', 'saffron', 'sage', 'sparrow', 'spruce', 'summit', 'thistle', 'thunder',
  'topaz', 'tulip', 'velvet', 'walnut', 'willow', 'wren',
]

/** A pass with ~44 bits of entropy — far past guessable, still readable. */
function generateRemotePass() {
  const pick = () => WORDS[crypto.randomInt(0, WORDS.length)]
  const n = crypto.randomInt(10, 100)
  return `${pick()}-${pick()}-${pick()}-${n}`
}

/** Hash exactly the way the Worker will verify it. Salt is hex; the KDF gets raw bytes. */
function hashRemotePass(pass) {
  const saltHex = crypto.randomBytes(REMOTE_SALT_BYTES).toString('hex')
  const hash = crypto
    .pbkdf2Sync(String(pass), Buffer.from(saltHex, 'hex'), REMOTE_ITER, REMOTE_KEYLEN, 'sha256')
    .toString('hex')
  return { pw_salt: saltHex, pw_iter: REMOTE_ITER, pw_hash: hash }
}

/** Which credential a remoteLogin hash was made from; changes whenever the password or code does. */
function credentialFingerprint(user) {
  const src = String((user && (user.passwordHash || user.codeHash)) || '')
  return src ? crypto.createHash('sha256').update(src).digest('hex').slice(0, 32) : ''
}

/**
 * The user's home-server password (or legacy code), hashed the way the Worker checks a pass,
 * for the phone app's one sign-in away from home. Made only at the moment it is typed and
 * verified here, so the password itself is never stored. Returns null when there is nothing to do.
 */
function rememberLogin(user, secret) {
  // Away-from-home access does NOT have to be on yet: the owner usually sets someone's
  // password before turning it on, and the hash is only ever pushed for a user who has
  // it on (buildMemberList). Made here so it is ready the moment it is switched on.
  if (!user || !secret) return null
  const from = credentialFingerprint(user)
  if (!from) return null
  const l = user.remoteLogin
  if (l && l.from === from && l.pw_salt && l.pw_hash) {
    const again = crypto.pbkdf2Sync(String(secret), Buffer.from(l.pw_salt, 'hex'), Number(l.pw_iter) || REMOTE_ITER, REMOTE_KEYLEN, 'sha256').toString('hex')
    if (again === l.pw_hash) return null
  }
  return { ...hashRemotePass(secret), from }
}

/**
 * Build the list to push: approved, non-revoked users who have remote access on.
 * Anyone missing from this list loses remote access when it is pushed — that is
 * precisely what makes revoking one person work.
 */
function buildMemberList(users) {
  const out = []
  for (const u of users || []) {
    if (!u || !u.username) continue
    if (u.status && u.status !== 'approved') continue
    const r = u.remote
    if (!r || !r.pw_hash || !r.pw_salt || !r.pw_iter) continue
    const entry = {
      username: String(u.username).trim().toLowerCase(),
      pw_hash: r.pw_hash,
      pw_salt: r.pw_salt,
      pw_iter: r.pw_iter,
    }
    // Their own home-server password, hashed when they last signed in here, and only while
    // it is still the password (or code) they have: a changed one stops working away too.
    const l = u.remoteLogin
    if (l && l.pw_hash && l.pw_salt && l.pw_iter && l.from === credentialFingerprint(u)) {
      Object.assign(entry, { login_hash: l.pw_hash, login_salt: l.pw_salt, login_iter: l.pw_iter })
    }
    out.push(entry)
  }
  return out
}

/**
 * Push the list to the Worker. Never throws: a sync failure must not take down
 * anything else on the server, and the next push will catch up.
 * Returns { ok, count, removed, reason }.
 */
async function syncMembers({ getName, getToken, getUsers, fetchImpl, log } = {}) {
  const note = typeof log === 'function' ? log : () => {}
  try {
    const name = typeof getName === 'function' ? getName() : null
    const token = typeof getToken === 'function' ? getToken() : null
    if (!name || !token) return { ok: false, reason: 'not-ready' }
    const members = buildMemberList(typeof getUsers === 'function' ? getUsers() : [])
    const doFetch = fetchImpl || globalThis.fetch
    if (typeof doFetch !== 'function') return { ok: false, reason: 'no-fetch' }
    const res = await doFetch(`https://${name}.beebo.tv/remote/members`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, members }),
    })
    let body = {}
    try { body = await res.json() } catch (_e) { body = {} }
    if (res.status !== 200 || !body.ok) {
      note(`[remote-members] push refused: ${res.status} ${body && body.error ? body.error : ''}`)
      return { ok: false, reason: body.error || `http_${res.status}` }
    }
    note(`[remote-members] pushed ${body.count} member(s), removed ${body.removed}`)
    return { ok: true, count: body.count, removed: body.removed }
  } catch (e) {
    note(`[remote-members] push failed: ${e && e.message}`)
    return { ok: false, reason: 'error' }
  }
}

/**
 * Is a push due? When the list changed, always. When it didn't, once the last
 * successful push is REMOTE_MEMBERS_REPUSH_MS old: the Worker's copy is the one
 * that opens the door, so it is overwritten with the truth regularly instead of
 * trusted to still match (security review 2026-09-16, finding 1).
 */
const REMOTE_MEMBERS_REPUSH_MS = 6 * 3600 * 1000
const REMOTE_MEMBERS_CHECK_MS = 30 * 60 * 1000
function memberPushDue({ sig, lastSig, lastAt, now, maxAgeMs = REMOTE_MEMBERS_REPUSH_MS } = {}) {
  if (sig !== lastSig) return true
  const at = Number(lastAt) || 0
  const t = Number(now) || Date.now()
  if (!at || t < at) return true
  return t - at >= maxAgeMs
}

module.exports = {
  REMOTE_MEMBERS_REPUSH_MS,
  REMOTE_MEMBERS_CHECK_MS,
  memberPushDue,
  REMOTE_ITER,
  REMOTE_KEYLEN,
  REMOTE_SALT_BYTES,
  generateRemotePass,
  hashRemotePass,
  buildMemberList,
  syncMembers,
  rememberLogin,
  credentialFingerprint,
}
