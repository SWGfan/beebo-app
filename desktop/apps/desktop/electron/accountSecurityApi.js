'use strict'
// ============================================================================
// accountSecurityApi.js - one person's own security settings, as a small JSON API.
// ----------------------------------------------------------------------------
// The same handler answers the website (cookie session, /account/security/api/*) and the phone app
// (bearer token, /api/account/security/*), the way the playlists routes do. It is only ever called
// for a signed-in, approved person acting on THEMSELVES; the owner's controls over other people
// live in the desktop app (accountSecurityIpc.js) and are never reachable over HTTP.
//
// Anything that changes how someone gets in (turn two-factor on/off, new recovery codes, new
// password) asks for the current password again, and for a two-factor code where two-factor is
// already on - a stolen, still-signed-in browser cannot lock the real person out or weaken the
// account. Wrong passwords / codes here count against the same per-address, per-username and
// server-wide limits as the sign-in page (auth.checkLockout / recordFailedLogin), plus the
// per-person second-step lock (twoFactor.js).
// ============================================================================
const auth = require('./auth')
const twoFactor = require('./twoFactor')
const authSessions = require('./authSessions')
const securityLog = require('./securityLog')
const passwordPolicy = require('./passwordPolicy')
const viewingPrivacy = require('./viewingPrivacy')
const { qrSvg } = require('./qrSvg')

const OWN_EVENT_LIMIT = 15

function result(status, body, extra) {
  return { status, body, ...(extra || {}) }
}

function credentialOk(user, secret) {
  if (typeof secret !== 'string' || !secret || secret.length > 256) return false
  if (user.passwordHash) return auth.verifyPassword(secret, user.passwordHash)
  if (user.codeHash) return auth.verifyCode(secret, user.codeHash)
  return false
}

function create({ store }) {
  function lockedAnswer(lock) {
    return result(429, { ok: false, error: 'locked', minutesRemaining: lock.minutesRemaining, message: `Too many attempts. Wait ${lock.minutesRemaining} minute${lock.minutesRemaining === 1 ? '' : 's'} and try again.` })
  }

  // Password (and, if asked, a two-factor code) re-check. null = proven; otherwise the answer to send.
  function prove(user, ip, { password, code, needCode }) {
    const lock = auth.checkLockout(store, ip, user.username, { trustLastSeenIp: false })
    if (lock.locked) return lockedAnswer(lock)
    if (!credentialOk(user, password)) {
      auth.recordFailedLogin(store, { ip, username: user.username })
      securityLog.record(store, { type: 'login_failed', userId: user.id, username: user.username, known: true, ip, detail: 'wrong password on a security setting' })
      return result(401, { ok: false, error: 'wrong_password', message: 'That is not your current password.' })
    }
    if (needCode && twoFactor.isEnabled(user)) {
      const check = twoFactor.verifyCode(store, user.id, code, { ip })
      if (!check.ok) {
        if (check.error === 'locked') return lockedAnswer(check)
        auth.recordFailedLogin(store, { ip, username: user.username })
        return result(401, {
          ok: false,
          error: check.error === 'code_reused' ? 'code_reused' : 'invalid_code',
          message: check.error === 'code_reused' ? 'That code was already used. Wait for the next one and try again.' : 'That two-factor code did not work.'
        })
      }
    }
    return null
  }

  function overview(user, currentSid) {
    const events = securityLog.list(store, { userId: user.id, limit: OWN_EVENT_LIMIT }).map((e) => ({ time: e.time, label: e.label, type: e.type, ip: e.ip }))
    return {
      ok: true,
      user: { id: user.id, username: user.username, name: user.name, isAdmin: !!user.isAdmin },
      hasPassword: !!user.passwordHash,
      twoFactor: twoFactor.status(store, user),
      policy: twoFactor.getPolicy(store),
      privateProfile: viewingPrivacy.isPrivate(store, user.id),
      sessions: authSessions.list(store, user.id, { currentSid }),
      events,
      minPasswordLength: passwordPolicy.MIN_LENGTH
    }
  }

  /**
   * ctx: { method, sub, body, user, ip, currentSid, reissue }
   *   reissue() -> { sid, cookie? , token? } makes a fresh tracked session for this person (used when
   *   the change ends every other session, so the device making it stays signed in).
   * Returns { status, body } and, when a fresh session was made, { session: <what reissue returned> }.
   */
  function handle(ctx) {
    const { method, body = {}, user, ip, currentSid, reissue } = ctx
    const sub = String(ctx.sub || '').replace(/^\/+|\/+$/g, '')
    if (!user || user.guest) return result(403, { ok: false, error: 'not_available_to_guests' })

    if ((sub === '' || sub === 'status') && method === 'GET') return result(200, overview(user, currentSid))
    if (method !== 'POST' && !(sub === 'sessions' && method === 'GET')) return result(405, { ok: false, error: 'method_not_allowed' })

    if (sub === 'sessions' && method === 'GET') {
      return result(200, { ok: true, sessions: authSessions.list(store, user.id, { currentSid }) })
    }

    if (sub === 'password-check') {
      const check = passwordPolicy.checkPassword(typeof body.password === 'string' ? body.password : '', { username: user.username, name: user.name, email: user.email })
      return result(200, { ok: true, ...check })
    }

    if (sub === '2fa/begin') {
      if (twoFactor.isEnabled(user)) return result(409, { ok: false, error: 'already_enabled', message: 'Two-factor is already on for this account.' })
      const denied = prove(user, ip, { password: body.password, needCode: false })
      if (denied) return denied
      const out = twoFactor.beginSetup(store, user.id)
      if (!out.ok) return result(400, out)
      return result(200, { ok: true, secret: out.secret, secretSpaced: out.secretSpaced, uri: out.uri, account: out.account, issuer: out.issuer, qrSvg: qrSvg(out.uri, { label: 'QR code for your authenticator app' }) })
    }

    if (sub === '2fa/confirm') {
      const lock = auth.checkLockout(store, ip, user.username, { trustLastSeenIp: false })
      if (lock.locked) return lockedAnswer(lock)
      const out = twoFactor.confirmSetup(store, user.id, body.code, { ip })
      if (!out.ok) {
        if (out.error === 'invalid_code') auth.recordFailedLogin(store, { ip, username: user.username })
        return result(out.error === 'locked' ? 429 : out.error === 'invalid_code' ? 401 : 400, out)
      }
      return result(200, { ok: true, recoveryCodes: out.recoveryCodes, message: 'Two-factor is on. Save these recovery codes somewhere safe: each works once, and they are shown only now.' })
    }

    if (sub === '2fa/disable') {
      if (!twoFactor.isEnabled(user)) return result(200, { ok: true, unchanged: true })
      if (user.isAdmin && twoFactor.getPolicy(store).requireForAdmins) {
        return result(403, { ok: false, error: 'required_by_policy', message: 'The owner requires two-factor for admins, so it cannot be turned off here.' })
      }
      const denied = prove(user, ip, { password: body.password, code: body.code, needCode: true })
      if (denied) return denied
      twoFactor.disable(store, user.id, { ip })
      return result(200, { ok: true })
    }

    if (sub === '2fa/recovery-codes') {
      if (!twoFactor.isEnabled(user)) return result(409, { ok: false, error: 'not_enabled', message: 'Turn two-factor on first.' })
      const denied = prove(user, ip, { password: body.password, code: body.code, needCode: true })
      if (denied) return denied
      const out = twoFactor.regenerateRecoveryCodes(store, user.id, { ip })
      return result(out.ok ? 200 : 400, out.ok ? { ok: true, recoveryCodes: out.recoveryCodes } : out)
    }

    if (sub === 'password') {
      const denied = prove(user, ip, { password: body.currentPassword, code: body.code, needCode: true })
      if (denied) return denied
      const weak = passwordPolicy.checkPassword(typeof body.newPassword === 'string' ? body.newPassword : '', { username: user.username, name: user.name, email: user.email })
      if (!weak.ok) return result(400, { ok: false, error: 'weak_password', message: weak.issues[0].message, strength: weak })
      auth.applyNewPassword(store, user.id, body.newPassword, { reason: 'changed by the person', ip })
      // Every session, this device's included, just ended; make it a fresh one (after the change, so a
      // private-history profile's rotated session salt is what the new cookie is signed with).
      const fresh = typeof reissue === 'function' ? reissue() : null
      return result(200, { ok: true, message: 'Password changed. Every other device was signed out.' }, fresh ? { session: fresh } : undefined)
    }

    if (sub === 'sessions/revoke') {
      const out = authSessions.revoke(store, user.id, body.id)
      if (!out.ok) return result(404, { ok: false, error: 'not_found', message: 'That device is not signed in any more.' })
      securityLog.record(store, { type: 'session_revoked', userId: user.id, username: user.username, known: true, ip, detail: out.device })
      return result(200, { ok: true, sessions: authSessions.list(store, user.id, { currentSid }) })
    }

    if (sub === 'sessions/revoke-all') {
      // Default: keep the device that asked. includeCurrent ends it too (the caller then signs out).
      const includeCurrent = body.includeCurrent === true
      const fresh = !includeCurrent && typeof reissue === 'function' ? reissue() : null
      const out = authSessions.revokeAll(store, user.id, { exceptSid: fresh ? fresh.sid : undefined })
      securityLog.record(store, { type: 'sessions_revoked_all', userId: user.id, username: user.username, known: true, ip, detail: includeCurrent ? 'including this device' : 'everything else' })
      return result(200, { ok: true, ended: out.ended, signedOut: includeCurrent, sessions: authSessions.list(store, user.id, { currentSid: fresh && fresh.sid }) }, fresh ? { session: fresh } : { clearSession: true })
    }

    return result(404, { ok: false, error: 'not_found' })
  }

  return { handle, overview }
}

module.exports = { create, credentialOk }
