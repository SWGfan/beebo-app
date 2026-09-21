'use strict'
// ============================================================================
// movieNightIpc.js - the desktop app's "Start Movie Night" button and its Settings section.
// ----------------------------------------------------------------------------
//   movieNight:start { fileName?, title?, mode: 'window' | 'tv' }
//       -> makes a room as the owner (about this film, when the button is on a film's page) and either
//            'window'  opens the TV screen in a window on this computer (plug the PC into the TV, or cast the window), or
//            'tv'      holds the room for the next TV that opens <this computer's address>/tv within 15 minutes.
//          Returns { ok, code, tvAddress, mode, poolCount }. The room's secret tickets stay in the main process
//          (the window gets its own through the address fragment) and are never sent to the renderer.
//   movieNight:getSettings / movieNight:saveSettings   the owner's settings (max guests, games, rating cap, ...)
// The renderer only ever sends a file name, a title and a choice; everything else is made here.
// ============================================================================

const { getActive, normalizeSettings, DEFAULT_SETTINGS } = require('./movieNight')
const gamesInfo = require('./movieNightGames')
const library = require('./movieNightLibrary')
const { encodeId } = require('./detailsIpc')

const SETTINGS_KEY = 'movieNight'

function register(deps) {
  const { ipcMain, BrowserWindow, store, auth, getStreamPort, log = () => {} } = deps

  function owner() {
    const users = auth.getUsers(store) || []
    return users.find((u) => u && u.isAdmin && u.status === 'approved') || users.find((u) => u && u.isAdmin) || null
  }

  ipcMain.handle('movieNight:getSettings', () => ({
    settings: normalizeSettings(store.get(SETTINGS_KEY)),
    games: gamesInfo.GAME_IDS.filter((id) => id !== 'intermission').map((id) => ({ id, title: gamesInfo.GAME_INFO[id].title })),
    caps: library.CAPS,
    limits: { maxGuests: 12 },
    defaults: DEFAULT_SETTINGS
  }))

  ipcMain.handle('movieNight:saveSettings', (_e, partial) => {
    const now = normalizeSettings(store.get(SETTINGS_KEY))
    const p = partial && typeof partial === 'object' && !Array.isArray(partial) ? partial : {}
    // Only known keys, each normalised on its own: a bad value can never be stored.
    const merged = normalizeSettings({ ...now, ...pick(p, Object.keys(DEFAULT_SETTINGS)) })
    store.set(SETTINGS_KEY, merged)
    return { ok: true, settings: merged }
  })

  ipcMain.handle('movieNight:start', async (_e, arg) => {
    const a = arg && typeof arg === 'object' ? arg : {}
    const mn = getActive()
    const me = owner()
    if (!mn || !me) return { ok: false, error: 'server_not_ready', message: 'The Beebo server is not running yet.' }
    const fileName = typeof a.fileName === 'string' ? a.fileName : ''
    const featured = fileName ? { key: encodeId(fileName), title: String(a.title || '').slice(0, 120) } : null
    const mode = a.mode === 'tv' ? 'tv' : 'window'
    const made = await mn.createForDesktop({ userId: me.id, featured, awaitTv: mode === 'tv' })
    if (!made.ok) return { ok: false, error: made.error, message: made.message }
    if (mode === 'window') {
      try {
        const port = getStreamPort()
        const win = new BrowserWindow({
          width: 1280, height: 720, backgroundColor: '#0b0d12', autoHideMenuBar: true, title: 'Movie Night',
          webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
        })
        // "Play it" opens the film in this same window, so it needs the owner's session (like the Watch together window).
        await win.webContents.session.cookies.set({
          url: `http://127.0.0.1:${port}`, name: 'beebo_session', value: auth.signSession(store, me.id),
          httpOnly: true, sameSite: 'lax', expirationDate: Math.floor(Date.now() / 1000) + 24 * 3600
        })
        await win.loadURL(`http://127.0.0.1:${port}${made.tvPath}#${made.hash}`)
      } catch (err) {
        log(`[movie-night] window failed: ${err && err.message}`)
        return { ok: false, error: 'window_failed', message: 'Could not open the Movie Night window.' }
      }
    }
    return { ok: true, mode, code: made.code, tvAddress: made.tvAddress, poolCount: made.poolCount }
  })
}

function pick(obj, keys) {
  const out = {}
  for (const k of keys) if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k]
  return out
}

module.exports = { register, SETTINGS_KEY }
