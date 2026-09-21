'use strict'

const crypto = require('crypto')
const parental = require('./parentalControls')

const PRIVATE_MESSAGE = 'Viewing history is private. Use your own sign-in. The owner can still monitor bandwidth, devices, connection status and aggregate usage.'
const RECOVERY_MESSAGE = 'This person keeps their viewing history private. They must use Forgot password with their own email; an administrator cannot replace their credentials.'

function users(store) {
  const all = store.get('authUsers')
  return Array.isArray(all) ? all : []
}
function privateUserIds(store) {
  return new Set(users(store).filter(u => u && u.viewingHistoryPrivate === true).map(u => u.id))
}
function isPrivate(store, userId) {
  return !!userId && privateUserIds(store).has(userId)
}
function publicHistory(store, rows) {
  const hidden = privateUserIds(store)
  return (Array.isArray(rows) ? rows : []).filter(row => row && !hidden.has(row.userId))
}
function sessionSalt(store, userId) {
  const u = users(store).find(u => u && u.id === userId)
  return typeof u?.privacySessionSalt === 'string' ? u.privacySessionSalt : ''
}
function status(store, userId) {
  const u = users(store).find(u => u && u.id === userId)
  const adult = u?.adult === true
  const enabled = u?.viewingHistoryPrivate === true
  const hasPassword = !!u?.passwordHash
  const eligible = !!u && u.status === 'approved' && adult && !parental.isRestricted(parental.getPolicy(store, userId))
  return { ok: true, adult, enabled, eligible, hasPassword,
    message: enabled ? PRIVATE_MESSAGE : !eligible ? 'The owner must label your profile as an adult and turn off parental restrictions before you can enable viewing privacy.' : !hasPassword ? 'Set up your own sign-in password first.' : 'Only you can change this setting, using your current password.' }
}
function setAdult(store, userId, adult) {
  if (typeof adult !== 'boolean') return { ok: false, error: 'bad_adult', message: 'Choose adult or standard profile.' }
  const list = users(store)
  const u = list.find(u => u && u.id === userId)
  if (!u) return { ok: false, error: 'not_found' }
  if (!adult && u.viewingHistoryPrivate === true) return { ok: false, error: 'private_profile', message: 'This person must turn off viewing privacy before their adult label can be removed.' }
  store.set('authUsers', list.map(row => row.id === userId ? { ...row, adult } : row))
  return status(store, userId)
}
function setPreference(store, userId, body) {
  if (!body || typeof body.enabled !== 'boolean' || (body.userId != null && body.userId !== userId)) {
    return { ok: false, error: 'bad_request', message: 'Change only your own viewing privacy setting.' }
  }
  const list = users(store)
  const u = list.find(u => u && u.id === userId && u.status === 'approved')
  if (!u) return { ok: false, error: 'unauthorized' }
  const info = status(store, userId)
  if (body.enabled && !info.eligible) return { ok: false, error: 'adult_profile_required', message: info.message }
  if (!u.passwordHash) return { ok: false, error: 'password_required', message: 'Set up your own sign-in password before enabling viewing privacy.' }
  if (typeof body.password !== 'string' || body.password.length > 256 || !require('./auth').verifyPassword(body.password, u.passwordHash)) {
    return { ok: false, error: 'wrong_password', message: 'That is not your current password.' }
  }
  if (info.enabled !== body.enabled) {
    store.set('authUsers', list.map(row => row.id === userId ? {
      ...row, viewingHistoryPrivate: body.enabled,
      privacySessionSalt: crypto.randomBytes(24).toString('hex'),
      // Old owner-created access codes and reset links cannot bypass this choice.
      code: null, codeHash: null, resetToken: null, resetTokenHash: null, resetTokenExpires: null, resetCode: null,
    } : row))
  }
  return status(store, userId)
}
// What the desktop screens may hold of a user row. Two-factor and reset-code fields hold secrets
// (the authenticator key, recovery-code hashes, a reset-code hash): the screen gets a summary only.
function withoutTwoFactorSecrets(u) {
  if (!u || (!u.twoFactor && !u.resetCode && !u.resetTokenHash)) return u
  const out = { ...u }
  if (out.twoFactor) {
    const recovery = Array.isArray(out.twoFactor.recovery) ? out.twoFactor.recovery.filter((r) => !r.usedAt).length : 0
    out.twoFactor = { enabled: !!(out.twoFactor.enabled && out.twoFactor.secret), enabledAt: out.twoFactor.enabledAt || null, recoveryRemaining: recovery }
  }
  delete out.resetCode
  delete out.resetTokenHash
  return out
}
function desktopUser(row) {
  const u = withoutTwoFactorSecrets(row)
  if (!u?.viewingHistoryPrivate) return u
  const out = { ...u, passwordHash: !!u.passwordHash }
  for (const key of ['code', 'codeHash', 'resetToken', 'resetTokenExpires', 'verifyToken', 'privacySessionSalt', 'remoteLogin']) delete out[key]
  if (out.remote) out.remote = { pw_hash: true, enabledAt: out.remote.enabledAt }
  return out
}
module.exports = { isPrivate, privateUserIds, publicHistory, sessionSalt, status, setAdult, setPreference, desktopUser, PRIVATE_MESSAGE, RECOVERY_MESSAGE }
