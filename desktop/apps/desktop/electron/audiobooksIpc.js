'use strict'
// The desktop app's side of the Audiobooks library: which folders hold audiobooks, the optional
// Open Library lookup switch, and the IPC the Settings screen (src/components/AudiobooksSettings.jsx)
// uses. The Audiobooks tab itself goes through main.js 'audiobooks:call' (the /api/audiobooks contract).
//
// Settings keys: 'audiobooksDir' (the main Audiobooks folder, empty until the owner picks one),
// 'extraAudiobooksDirs' (more folders, e.g. a second drive) and 'audiobooksOnlineLookup' (true once
// the owner has turned on the Open Library lookup; off by default). Nothing is scanned until a folder
// is chosen, and nothing leaves the computer unless the lookup is on.

const path = require('path')

const getAudiobooksDir = (store) => store.get('audiobooksDir') || ''

function getExtraAudiobookDirs(store) {
  const list = store.get('extraAudiobooksDirs')
  return Array.isArray(list) ? list.filter((d) => typeof d === 'string' && d) : []
}

function getAllAudiobookDirs(store) {
  const seen = new Set()
  return [getAudiobooksDir(store), ...getExtraAudiobookDirs(store)].filter((d) => {
    if (!d) return false
    const k = path.resolve(d).toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

const isLookupEnabled = (store) => store.get('audiobooksOnlineLookup') === true

// `getLookup` returns the stream server's Open Library helper (or null while it is not running).
function registerAudiobooksIpc({ ipcMain, dialog, store, library, getLookup = () => null }) {
  const settings = () => ({
    audiobooksDir: getAudiobooksDir(store),
    extraAudiobooksDirs: getExtraAudiobookDirs(store),
    onlineLookup: isLookupEnabled(store),
    lookup: (() => { try { const l = getLookup(); return l ? l.status() : null } catch { return null } })(),
    status: library.status(),
    skipped: library.skippedFiles().slice(0, 50)
  })
  const changed = () => {
    library.refreshWatch()
    library.scan()
    return settings()
  }
  ipcMain.handle('audiobooks:getSettings', () => settings())
  ipcMain.handle('audiobooks:status', () => library.status())
  ipcMain.handle('audiobooks:pickFolder', async () => {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (res.canceled || !res.filePaths[0]) return settings()
    store.set('audiobooksDir', res.filePaths[0])
    return changed()
  })
  ipcMain.handle('audiobooks:addExtraDir', async () => {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (res.canceled || !res.filePaths[0]) return settings()
    const list = getExtraAudiobookDirs(store)
    if (!list.includes(res.filePaths[0])) list.push(res.filePaths[0])
    store.set('extraAudiobooksDirs', list)
    return changed()
  })
  ipcMain.handle('audiobooks:removeExtraDir', (_e, dir) => {
    store.set('extraAudiobooksDirs', getExtraAudiobookDirs(store).filter((d) => d !== dir))
    return changed()
  })
  ipcMain.handle('audiobooks:rescan', () => {
    library.scan()
    return library.status()
  })
  // The owner's choice, and only a boolean: turning it on starts looking books up in the background.
  ipcMain.handle('audiobooks:setOnlineLookup', (_e, on) => {
    store.set('audiobooksOnlineLookup', on === true)
    if (on === true) { try { const l = getLookup(); if (l) l.kick() } catch {} }
    return settings()
  })
  ipcMain.handle('audiobooks:lookupNow', () => {
    try { const l = getLookup(); if (l && isLookupEnabled(store)) l.enrichAll().catch(() => {}) } catch {}
    return settings()
  })
}

module.exports = { getAudiobooksDir, getExtraAudiobookDirs, getAllAudiobookDirs, isLookupEnabled, registerAudiobooksIpc }
