'use strict'
// ============================================================================
// addonsIpc.js - Settings > Add-ons on the PC app: the window's door to the add-on manager and
// the Speech Pack's subtitle queue. Only the app's own main window may call these (they install
// software and start heavy background work), and progress is pushed back to that window only.
//
//   addons:list | addons:install {id, components} | addons:cancel {id} | addons:uninstall {id, components, purge}
//   addons:verify {id}
//   speech:call {name, args}   -> speechPack.api(name, args) (status, enqueue, cancel, search, settings, libraries ...)
//   event 'addons:progress'    -> { id, componentId, phase, received, total, percent, message, ... }
// ============================================================================

const { getSharedManager } = require('./addons')

function register({ ipcMain, getMainWindow, getSpeechPack, log = () => {}, manager = null }) {
  const addons = manager || getSharedManager({ log })

  const trusted = (event) => {
    const win = getMainWindow()
    return !!win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame
  }
  const forbidden = { ok: false, error: 'forbidden', message: 'Use the Beebo desktop window to manage add-ons.' }
  const str = (v) => (typeof v === 'string' ? v : '')
  const strList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 50) : [])

  function handle(channel, fn) {
    ipcMain.handle(channel, async (event, args) => {
      if (!trusted(event)) return forbidden
      try { return await fn(args || {}) } catch (e) {
        log(`add-ons: ${channel} failed (${e && e.code ? e.code : 'error'})`)
        return { ok: false, error: (e && e.code) || 'failed', message: 'That did not work. Try again.' }
      }
    })
  }

  handle('addons:list', () => ({ ok: true, addons: addons.list() }))
  handle('addons:install', (a) => addons.install(str(a.id), { components: strList(a.components) }))
  handle('addons:cancel', (a) => addons.cancel(str(a.id)))
  handle('addons:uninstall', (a) => addons.uninstall(str(a.id), { components: strList(a.components), purge: a.purge === true }))
  handle('addons:verify', (a) => addons.verify(str(a.id)))
  handle('speech:call', (a) => {
    const sp = getSpeechPack()
    if (!sp) return { ok: false, error: 'server_not_running', message: 'The server is not running yet.' }
    return sp.api(str(a.name), a.args)
  })

  // Progress goes to the main window only.
  addons.on('progress', (ev) => {
    const win = getMainWindow()
    if (win && !win.isDestroyed()) { try { win.webContents.send('addons:progress', ev) } catch {} }
  })
  return { manager: addons }
}

module.exports = { register }
