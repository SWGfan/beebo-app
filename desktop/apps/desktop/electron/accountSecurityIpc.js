'use strict'
// ============================================================================
// accountSecurityIpc.js - the owner's account-security controls (desktop app only).
// ----------------------------------------------------------------------------
// Everything the owner does about OTHER people's security lives here, over Electron IPC and
// never over HTTP: the "require two-factor for admins" policy, one-time reset codes, turning
// two-factor off for someone who lost their phone, unlocking a locked second step, ending a
// person's sessions, and reading the security event log. (People manage their own settings on the
// website: accountSecurityApi.js.) Kept out of main.js on purpose, like sharingIpc.js.
//
// No handler here returns a secret except the two that must show one ONCE by design: a fresh
// reset code (resetCodes.issue) and the set-up secret/QR + recovery codes for the owner's own admin
// account (twoFactor.beginSetup / confirmSetup).
// ============================================================================
const auth = require('./auth')
const twoFactor = require('./twoFactor')
const authSessions = require('./authSessions')
const securityLog = require('./securityLog')
const resetCodes = require('./resetCodes')
const passwordPolicy = require('./passwordPolicy')
const { qrSvg } = require('./qrSvg')

function register({ ipcMain, store, mailer, getServerUrls }) {
  const userById = (id) => auth.getUsers(store).find((u) => u && u.id === id) || null
  const serverUrl = () => {
    try {
      const urls = typeof getServerUrls === 'function' ? getServerUrls() : []
      return (Array.isArray(urls) && urls[0]) || ''
    } catch { return '' }
  }

  ipcMain.handle('security:overview', () => {
    const users = auth.getUsers(store).filter((u) => u && u.status === 'approved')
    return {
      policy: twoFactor.getPolicy(store),
      mailConfigured: !!(mailer && mailer.isConfigured && mailer.isConfigured(store)),
      serverUrl: serverUrl(),
      users: users.map((u) => ({
        id: u.id,
        name: u.name || '',
        username: u.username || '',
        email: u.email || '',
        isAdmin: !!u.isAdmin,
        hasPassword: !!u.passwordHash,
        twoFactor: twoFactor.status(store, u),
        resetCode: resetCodes.pending(store, u.id),
        sessions: authSessions.list(store, u.id).length
      }))
    }
  })

  ipcMain.handle('security:setPolicy', (_e, { requireForAdmins } = {}) => ({ ok: true, policy: twoFactor.setPolicy(store, { requireForAdmins: requireForAdmins === true }) }))

  ipcMain.handle('security:events', (_e, { limit, userId, severity } = {}) => ({
    ok: true,
    events: securityLog.list(store, { limit: Number(limit) || 200, userId: userId || undefined, severity: severity || undefined })
  }))
  ipcMain.handle('security:clearEvents', () => { securityLog.clear(store); return { ok: true } })

  // --- other people's sessions
  ipcMain.handle('security:sessions', (_e, { userId } = {}) => {
    if (!userById(userId)) return { ok: false, error: 'not_found' }
    return { ok: true, sessions: authSessions.list(store, userId) }
  })
  ipcMain.handle('security:revokeSession', (_e, { userId, id } = {}) => {
    const user = userById(userId)
    if (!user) return { ok: false, error: 'not_found' }
    const out = authSessions.revoke(store, userId, id)
    if (out.ok) securityLog.record(store, { type: 'session_revoked', userId, username: user.username, known: true, detail: `${out.device} (by the owner)` })
    return { ...out, sessions: authSessions.list(store, userId) }
  })
  ipcMain.handle('security:revokeAllSessions', (_e, { userId } = {}) => {
    const user = userById(userId)
    if (!user) return { ok: false, error: 'not_found' }
    const out = authSessions.revokeAll(store, userId)
    securityLog.record(store, { type: 'sessions_revoked_all', userId, username: user.username, known: true, detail: 'by the owner' })
    return { ...out, sessions: [] }
  })

  // --- two-factor for other people: the owner can switch it off (lost phone) or clear a lock
  ipcMain.handle('security:disableTwoFactor', (_e, { userId } = {}) => {
    if (!userById(userId)) return { ok: false, error: 'not_found' }
    return twoFactor.disable(store, userId, { byOwner: true })
  })
  ipcMain.handle('security:unlockTwoFactor', (_e, { userId } = {}) => {
    const user = userById(userId)
    if (!user) return { ok: false, error: 'not_found' }
    const cleared = twoFactor.clearLock(store, userId)
    if (cleared) securityLog.record(store, { type: 'two_factor_unlocked', userId, username: user.username, known: true })
    return { ok: true, cleared }
  })

  // --- the owner setting up two-factor for their own admin account, on this PC
  ipcMain.handle('security:twoFactorBegin', (_e, { userId } = {}) => {
    const user = userById(userId)
    if (!user || !user.isAdmin) return { ok: false, error: 'admin_only', message: 'Two-factor is set up by each person on the website; this shortcut is for admin accounts.' }
    const out = twoFactor.beginSetup(store, userId)
    if (!out.ok) return out
    return { ok: true, uri: out.uri, secretSpaced: out.secretSpaced, qrSvg: qrSvg(out.uri, { label: 'QR code for your authenticator app' }) }
  })
  ipcMain.handle('security:twoFactorConfirm', (_e, { userId, code } = {}) => {
    const user = userById(userId)
    if (!user || !user.isAdmin) return { ok: false, error: 'admin_only' }
    return twoFactor.confirmSetup(store, userId, code, {})
  })

  // --- one-time password reset codes (no email needed)
  ipcMain.handle('security:makeResetCode', async (_e, { userId, minutes, email } = {}) => {
    const out = resetCodes.issue(store, userId, { minutes })
    if (!out.ok) return out
    const base = serverUrl()
    const link = base ? `${base.replace(/\/+$/, '')}/reset-with-code?u=${encodeURIComponent(out.username)}#c=${out.code}` : ''
    let emailed = false
    if (email === true && out.email && mailer && mailer.isConfigured && mailer.isConfigured(store)) {
      const sent = await mailer.sendMail(store, {
        to: out.email,
        subject: 'Your Beebo Entertainment password reset code',
        text: `Hi ${out.name},\n\nThe owner made you a one-time password reset code.\n\nUsername: ${out.username}\nCode: ${out.code}\n${link ? `\nOr open this link: ${link}\n` : ''}\nIt works once and expires in ${out.minutes} minutes. If you did not ask for it, ignore this email; your password has not changed.`
      })
      emailed = !!sent.ok
    }
    return { ok: true, code: out.code, expiresAt: out.expiresAt, minutes: out.minutes, username: out.username, link, path: '/reset-with-code', emailed }
  })
  ipcMain.handle('security:cancelResetCode', (_e, { userId } = {}) => resetCodes.cancel(store, userId))

  ipcMain.handle('security:passwordCheck', (_e, { password, username } = {}) => passwordPolicy.checkPassword(typeof password === 'string' ? password : '', { username }))
}

module.exports = { register }
