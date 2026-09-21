'use strict'

const path = require('node:path')
const { createHouseholdCatalog, CAPABILITY } = require('./householdCatalog')
const { defaults } = require('./storageDefaults')

function registerHouseholdCatalogIpc({ ipcMain, dialog, store, app, getMainWindow, isEnabled = () => store.get(CAPABILITY) === true, getHouseholdId = () => null, authorizeRemoteHost, now } = {}) {
  const catalog = createHouseholdCatalog({
    store, isEnabled, getHouseholdId, authorizeRemoteHost, now,
    getExcludedRoots: () => [store.get('privateVaultDir') || defaults().privateVaultDir, app.getPath('userData'), app.getPath('appData')].filter(Boolean)
  })
  function trusted(event) {
    const window = getMainWindow()
    return !!window && !window.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame
  }
  const errors = new Set(['capability_disabled', 'consent_required', 'invalid_kind', 'invalid_folder', 'linked_folder', 'private_folder', 'folder_unavailable', 'source_limit', 'duplicate_folder', 'source_not_found', 'busy', 'host_limit', 'invalid_connection', 'port_conflict'])
  function handle(name, callback, allowDisabled = false) {
    ipcMain.handle('householdLibrary:' + name, async (event, args) => {
      if (!trusted(event)) return { ok: false, error: 'forbidden', message: 'Use the Beebo desktop window to manage household library sources.' }
      if (!allowDisabled && isEnabled() !== true) return { ok: false, error: 'capability_disabled', message: 'The household library pilot is not enabled on this computer.' }
      try { return await callback(args || {}) }
      catch (error) { return { ok: false, error: errors.has(error.code) ? error.code : 'operation_failed', message: errors.has(error.code) ? error.message : 'This operation could not finish. Check the source folder and try again.' } }
    })
  }
  handle('info', () => catalog.info(), true)
  handle('configureLocalHost', args => catalog.configureLocalHost(args))
  handle('pickSource', async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), { title: 'Choose a household Movies or TV folder', properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths?.[0]) return { ok: true, cancelled: true }
    if (isEnabled() !== true) return { ok: false, error: 'capability_disabled' }
    const folder = result.filePaths[0]
    if (typeof folder !== 'string' || !path.isAbsolute(folder)) return { ok: false, error: 'invalid_folder' }
    return { ok: true, cancelled: false, folder }
  })
  handle('addSource', args => catalog.addSource(args))
  handle('removeSource', args => catalog.removeSource(args))
  handle('scanSource', args => catalog.scanSource(args))
  handle('cancelScan', () => catalog.cancelScan())
  handle('scanStatus', () => catalog.scanStatus())
  handle('catalog', args => catalog.catalog(args))
  // Deliberately no import/heartbeat IPC. Future authenticated connector code
  // receives this return value; a browser cannot declare a remote host trusted.
  return catalog
}
module.exports = { registerHouseholdCatalogIpc }
