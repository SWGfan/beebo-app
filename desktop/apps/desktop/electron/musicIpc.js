// The desktop app's side of the Music library: which folders hold music, and
// the IPC the Settings screen (src/components/MusicSettings.jsx) uses.
//
// Settings keys: 'musicDir' (the main Music folder, empty until the owner picks
// one) and 'extraMusicDirs' (more folders, e.g. a second drive). Nothing is
// scanned until a folder is chosen.

const path = require('path')

function getMusicDir(store) {
  return store.get('musicDir') || ''
}

function getExtraMusicDirs(store) {
  const list = store.get('extraMusicDirs')
  return Array.isArray(list) ? list.filter((d) => typeof d === 'string' && d) : []
}

function getAllMusicDirs(store) {
  const seen = new Set()
  return [getMusicDir(store), ...getExtraMusicDirs(store)].filter((d) => {
    if (!d) return false
    const k = path.resolve(d).toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

// Cover art, lyrics and converted copies live beside the TMDB cache when the owner has set one,
// otherwise in the app's own data folder.
function getMusicCacheDir(store, app) {
  const tmdb = store.get('tmdbCacheDir')
  if (tmdb) return tmdb
  try {
    return app.getPath('userData')
  } catch {
    return null
  }
}

function registerMusicIpc({ ipcMain, dialog, store, app, library }) {
  const settings = () => ({
    musicDir: getMusicDir(store),
    extraMusicDirs: getExtraMusicDirs(store),
    suggestedDir: (() => { try { return app.getPath('music') } catch { return '' } })(),
    status: library.status()
  })
  const changed = () => {
    library.refreshWatch()
    library.scan()
    return settings()
  }
  ipcMain.handle('music:getSettings', () => settings())
  ipcMain.handle('music:status', () => library.status())
  ipcMain.handle('music:pickFolder', async () => {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (res.canceled || !res.filePaths[0]) return settings()
    store.set('musicDir', res.filePaths[0])
    return changed()
  })
  ipcMain.handle('music:useFolder', (_e, dir) => {
    // Only the suggested Windows Music folder can be set without the picker.
    let suggested = ''
    try { suggested = app.getPath('music') } catch {}
    if (!dir || dir !== suggested) return settings()
    store.set('musicDir', dir)
    return changed()
  })
  ipcMain.handle('music:addExtraDir', async () => {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (res.canceled || !res.filePaths[0]) return settings()
    const list = getExtraMusicDirs(store)
    if (!list.includes(res.filePaths[0])) list.push(res.filePaths[0])
    store.set('extraMusicDirs', list)
    return changed()
  })
  ipcMain.handle('music:removeExtraDir', (_e, dir) => {
    store.set('extraMusicDirs', getExtraMusicDirs(store).filter((d) => d !== dir))
    return changed()
  })
  ipcMain.handle('music:rescan', () => {
    library.scan()
    return library.status()
  })
}

module.exports = { getMusicDir, getExtraMusicDirs, getAllMusicDirs, getMusicCacheDir, registerMusicIpc }
