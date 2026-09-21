'use strict'
// Settings > Jellyfin apps: the owner's controls for the Jellyfin-compatible mode, over Electron IPC (never over HTTP).
// The work lives in electron/jellyfin/admin.js inside the running server; this is only the doorway. No handler returns a secret
// except createAppPassword, which must show the new app password ONCE (only its hash is kept).

function register({ ipcMain, getServerInfo }) {
  const admin = () => {
    try {
      const info = typeof getServerInfo === 'function' ? getServerInfo() : null
      return (info && info.jellyfin) || null
    } catch { return null }
  }
  const notRunning = { ok: false, error: 'server_not_running' }
  const wrap = (fn) => async (_e, arg) => {
    const a = admin()
    if (!a) return notRunning
    try { return await fn(a, arg || {}) } catch (err) { return { ok: false, error: String((err && err.message) || err) } }
  }

  ipcMain.handle('jellyfin:status', wrap((a) => ({ ok: true, ...a.status() })))
  ipcMain.handle('jellyfin:users', wrap((a) => ({ ok: true, users: a.users() })))
  ipcMain.handle('jellyfin:sessions', wrap((a) => ({ ok: true, sessions: a.sessions() })))
  ipcMain.handle('jellyfin:revokeSession', wrap((a, { userId, id }) => a.revokeSession(String(userId || ''), String(id || ''))))
  ipcMain.handle('jellyfin:quickConnectPending', wrap((a) => ({ ok: true, pending: a.quickConnectPending() })))
  ipcMain.handle('jellyfin:quickConnectApprove', wrap((a, { code, userId }) => a.approveQuickConnect(String(code || ''), userId ? String(userId) : undefined)))
  ipcMain.handle('jellyfin:appPasswords', wrap((a) => ({ ok: true, items: a.appPasswords() })))
  ipcMain.handle('jellyfin:createAppPassword', wrap((a, { userId, label }) => a.createAppPassword(String(userId || ''), String(label || ''))))
  ipcMain.handle('jellyfin:removeAppPassword', wrap((a, { id }) => a.removeAppPassword(String(id || ''))))
  ipcMain.handle('jellyfin:selfTest', wrap((a, { userId }) => a.selfTest({ userId: userId ? String(userId) : undefined })))
}

module.exports = { register }
