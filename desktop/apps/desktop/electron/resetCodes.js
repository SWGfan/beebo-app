'use strict'
// ============================================================================
// resetCodes.js - password reset that needs no email server.
// ----------------------------------------------------------------------------
// A home server usually has no working SMTP, so "email me a link" cannot be the only way
// back in. Instead the owner, at the PC running Beebo, makes a ONE-TIME RESET CODE for a
// person (Users -> Security -> Make reset code) and gives it to them in person, by text, or
// - if email IS set up - has it mailed. The person opens the server's /reset-with-code page,
// types their username, the code and a new password.
//
//   - the code is 12 random characters (60 bits) in groups of four, shown to the owner ONCE
//     and stored only as a salted scrypt hash on the user row (resetCode.h);
//   - it expires (default 30 minutes, at most 24 hours) and works exactly once;
//   - it is limited on a FIXED key, the code itself: five wrong tries against it and it is
//     dead, whichever address the guesses came from. The owner makes another. (streamServer
//     also runs each try through the per-address / per-username limits in auth.js.)
//   - every answer to a stranger is the same "that code did not work" - no hint whether the
//     name exists, the code expired, or was already used.
//   - a private-history profile is refused: the owner cannot reset it (viewingPrivacy).
//   - a successful reset signs the person out everywhere (auth.applyNewPassword). It does NOT
//     switch off two-factor: the person still needs their authenticator (or a recovery code) to
//     sign in. If they lost that too, the owner turns two-factor off for them.
// ============================================================================
const crypto = require('crypto')
const auth = require('./auth')
const passwordPolicy = require('./passwordPolicy')
const securityLog = require('./securityLog')
const viewingPrivacy = require('./viewingPrivacy')

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 12
const DEFAULT_MINUTES = 30
const MAX_MINUTES = 24 * 60
const MAX_TRIES = 5

function makeCode() {
  let s = ''
  for (let i = 0; i < CODE_LENGTH; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)]
  return s.replace(/(.{4})(?=.)/g, '$1-')
}

// A stand-in hash so "no such user" costs as much time as "wrong code".
const DUMMY_HASH = auth.hashCode('DUMMYDUMMYDU')

/**
 * The owner makes a code for one person. Replaces any earlier code.
 * -> { ok, code, expiresAt, minutes, username } (code is shown once) | { ok: false, error, message }
 */
function issue(store, userId, { minutes = DEFAULT_MINUTES, now = Date.now() } = {}) {
  const user = auth.getUsers(store).find((u) => u.id === userId)
  if (!user || user.status !== 'approved') return { ok: false, error: 'not_found', message: 'That household member was not found.' }
  if (viewingPrivacy.isPrivate(store, userId)) return { ok: false, error: 'private_profile_self_recovery', message: viewingPrivacy.RECOVERY_MESSAGE }
  const mins = Math.max(1, Math.min(MAX_MINUTES, Math.floor(Number(minutes)) || DEFAULT_MINUTES))
  const code = makeCode()
  const expiresAt = now + mins * 60 * 1000
  auth.updateUser(store, userId, { resetCode: { h: auth.hashCode(code), createdAt: now, expiresAt, tries: 0 } })
  securityLog.record(store, { type: 'password_reset_code_issued', userId, username: user.username, known: true, detail: `expires in ${mins} min` })
  return { ok: true, code, expiresAt, minutes: mins, username: user.username, name: user.name, email: user.email || '' }
}

/** Is there a live code for this person? (never the code) */
function pending(store, userId, now = Date.now()) {
  const user = auth.getUsers(store).find((u) => u.id === userId)
  const rc = user && user.resetCode
  if (!rc || !rc.h || rc.expiresAt <= now || (rc.tries || 0) >= MAX_TRIES) return { active: false }
  return { active: true, expiresAt: rc.expiresAt, triesLeft: MAX_TRIES - (rc.tries || 0) }
}

function cancel(store, userId) {
  const user = auth.getUsers(store).find((u) => u.id === userId)
  if (!user || !user.resetCode) return { ok: true, unchanged: true }
  auth.updateUser(store, userId, { resetCode: null })
  return { ok: true }
}

/**
 * The person uses the code. -> { ok: true } | { ok: false, error: 'invalid' | 'weak', message }
 * Every failure to find/prove the code is 'invalid' with one message.
 */
function redeem(store, { username, code, newPassword, ip, now = Date.now() } = {}) {
  const fail = { ok: false, error: 'invalid', message: 'That code did not work. It may be wrong, expired or already used. Ask the owner for a new one.' }
  const uname = auth.normalizeUsername(username)
  const user = uname ? auth.getUsers(store).find((u) => u.username === uname && u.status === 'approved') : null
  const rc = user && user.resetCode
  const live = !!(rc && rc.h && rc.expiresAt > now && (rc.tries || 0) < MAX_TRIES)
  // Always do one scrypt check, against the real hash or a stand-in, so timing does not tell.
  const matches = auth.verifyCode(code, live ? rc.h : DUMMY_HASH) && live
  if (!matches) {
    if (live) {
      const tries = (rc.tries || 0) + 1
      auth.updateUser(store, user.id, { resetCode: tries >= MAX_TRIES ? null : { ...rc, tries } })
      securityLog.record(store, { type: tries >= MAX_TRIES ? 'password_reset_locked' : 'password_reset_failed', userId: user.id, username: user.username, known: true, ip, detail: tries >= MAX_TRIES ? 'reset code burned after 5 wrong tries' : 'wrong reset code' })
    } else {
      securityLog.record(store, { type: 'password_reset_failed', ip, detail: 'no live reset code for that name' })
    }
    return fail
  }
  const weak = passwordPolicy.refusal(newPassword, { username: user.username, name: user.name, email: user.email })
  if (weak) return { ok: false, error: 'weak', message: weak } // the code is NOT spent by a weak password
  auth.applyNewPassword(store, user.id, newPassword, { reason: 'owner reset code', ip })
  // applyNewPassword cleared the code: single use.
  securityLog.record(store, { type: 'password_reset_completed', userId: user.id, username: user.username, known: true, ip, detail: 'owner reset code' })
  return { ok: true, userId: user.id }
}

module.exports = { issue, pending, cancel, redeem, MAX_TRIES, DEFAULT_MINUTES, CODE_LENGTH }
