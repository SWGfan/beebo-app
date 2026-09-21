'use strict'
// ============================================================================
// phoneSpeakersIpc.js - the desktop app's "Phone speakers" button (movie / episode details page) and its settings.
// ----------------------------------------------------------------------------
//   phoneSpeakers:start { kind, fileName, relPath?, title? }
//       -> starts a room for that library file as the owner (parental controls are checked by the room manager),
//          copies the phones' join link to the clipboard, and opens the Beebo player window already showing the QR code
//          panel (the window is the "TV": put it on the big screen). Returns { ok, joinUrl, code } or { ok:false, message }.
//   phoneSpeakers:getSettings / phoneSpeakers:setSettings { enabled?, allowRemote?, quality?, fillIn? } -> the settings
//       (phoneSpeakersServer.js documents each one) plus how many rooms are open and how busy the audio cutter is.
// Everything the renderer sends is a file name and a title; the room, the join address and the player address are all
// made here from the same modules the website uses.
// ============================================================================

const { getActive } = require('./phoneSpeakersServer')
const { playerPath, encodeId } = require('./detailsIpc')

function register(deps) {
  const { ipcMain, BrowserWindow, clipboard, store, auth, getStreamPort, log = () => {} } = deps

  function owner() {
    const users = auth.getUsers(store) || []
    return users.find((u) => u && u.isAdmin && u.status === 'approved') || users.find((u) => u && u.isAdmin) || null
  }

  ipcMain.handle('phoneSpeakers:start', async (_e, arg) => {
    const a = arg && typeof arg === 'object' ? arg : {}
    const kind = a.kind === 'tv' ? 'tv' : 'movie'
    const idSource = kind === 'tv' ? String(a.relPath || a.fileName || '') : String(a.fileName || '')
    if (!idSource) return { ok: false, error: 'bad_media', message: 'That title cannot be shared.' }
    const svc = getActive()
    const me = owner()
    if (!svc || !me) return { ok: false, error: 'server_not_ready', message: 'The Beebo server is not running yet.' }
    const made = await svc.createForOwner({ userId: me.id, kind, id: encodeId(idSource), title: String(a.title || '') })
    if (!made.ok) return { ok: false, error: made.error, message: made.message }
    try { clipboard.writeText(made.joinUrl) } catch {}
    try {
      const port = getStreamPort()
      const win = new BrowserWindow({
        width: 1280, height: 780, backgroundColor: '#000000', autoHideMenuBar: true,
        title: String(a.title || 'Beebo Entertainment').slice(0, 120),
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
      })
      await win.webContents.session.cookies.set({
        url: `http://127.0.0.1:${port}`, name: 'beebo_session', value: auth.signSession(store, me.id),
        httpOnly: true, sameSite: 'lax', expirationDate: Math.floor(Date.now() / 1000) + 24 * 3600
      })
      const base = playerPath({ kind, fileName: idSource })
      await win.loadURL(`http://127.0.0.1:${port}${base}&spk=${encodeURIComponent(made.code)}`)
    } catch (err) {
      log(`[phone-speakers] player window failed: ${err && err.message}`)
    }
    return { ok: true, joinUrl: made.joinUrl, code: made.code }
  })

  ipcMain.handle('phoneSpeakers:getSettings', async () => {
    const svc = getActive()
    return svc ? { ok: true, ...svc.getSettings() } : { ok: false, error: 'server_not_ready' }
  })
  ipcMain.handle('phoneSpeakers:setSettings', async (_e, patch) => {
    const svc = getActive()
    return svc ? { ok: true, ...svc.setSettings(patch) } : { ok: false, error: 'server_not_ready' }
  })
}

module.exports = { register }
