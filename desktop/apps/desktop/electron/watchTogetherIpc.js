'use strict'
// ============================================================================
// watchTogetherIpc.js - the desktop app's "Watch together" button (movie / episode details page).
// ----------------------------------------------------------------------------
//   watchTogether:start { kind, fileName, relPath?, title? }
//       -> starts a room for that library file as the owner, copies the invite link to the clipboard,
//          and opens the Beebo player window already inside the room (the owner is the host).
//          Returns { ok, inviteUrl, code } (the code only to show it; the link is what people use).
// Everything the renderer sends is a file name and a title; the room, the invite address and the player
// address are all made here from the same modules the website uses (watchTogetherHttp.createInvite).
// ============================================================================

const { getActive } = require('./watchTogether')
const { playerPath, encodeId } = require('./detailsIpc')

function register(deps) {
  const { ipcMain, BrowserWindow, clipboard, store, auth, getStreamPort, log = () => {} } = deps

  function owner() {
    const users = auth.getUsers(store) || []
    return users.find((u) => u && u.isAdmin && u.status === 'approved') || users.find((u) => u && u.isAdmin) || null
  }

  ipcMain.handle('watchTogether:start', async (_e, arg) => {
    const a = arg && typeof arg === 'object' ? arg : {}
    const kind = a.kind === 'tv' ? 'tv' : 'movie'
    const idSource = kind === 'tv' ? String(a.relPath || a.fileName || '') : String(a.fileName || '')
    if (!idSource) return { ok: false, error: 'bad_media' }
    const wt = getActive()
    const me = owner()
    if (!wt || !me) return { ok: false, error: 'server_not_ready', message: 'The Beebo server is not running yet.' }
    const made = await wt.createInvite({ userId: me.id, kind, id: encodeId(idSource), title: String(a.title || '') })
    if (!made.ok) return { ok: false, error: made.error, message: made.message }
    try { clipboard.writeText(made.inviteUrl) } catch {}
    try {
      const port = getStreamPort()
      const win = new BrowserWindow({
        width: 1280, height: 780, backgroundColor: '#000000', autoHideMenuBar: true,
        title: String(a.title || 'Beebo Entertainment').slice(0, 120),
        webPreferences: { contextIsolation: true, nodeIntegration: false }
      })
      await win.webContents.session.cookies.set({
        url: `http://127.0.0.1:${port}`, name: 'beebo_session', value: auth.signSession(store, me.id),
        httpOnly: true, sameSite: 'lax', expirationDate: Math.floor(Date.now() / 1000) + 24 * 3600
      })
      const base = playerPath({ kind, fileName: idSource })
      await win.loadURL(`http://127.0.0.1:${port}${base}&wt=${encodeURIComponent(made.code)}`)
    } catch (err) {
      log(`[watch-together] player window failed: ${err && err.message}`)
    }
    return { ok: true, inviteUrl: made.inviteUrl, code: made.code }
  })
}

module.exports = { register }
