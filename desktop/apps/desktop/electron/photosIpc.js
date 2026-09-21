'use strict'
// The PC window's Photos screen (src/components/Photos.jsx). Same library and rules as the phone and
// the website (photosApi.photoServices), reached over IPC; pictures load from the local server with
// media tokens, so the window never touches a file path directly.
const photosApi = require('./photosApi')

function register({ ipcMain, dialog, shell, store, auth, makeMediaToken, getPort, log = () => {} }) {
  const services = () => photosApi.photoServices(store, { log })
  // The PC window is the owner's own screen.
  const OWNER_ACCESS = { view: true, backup: true, owner: true }
  const base = () => 'http://127.0.0.1:' + getPort()
  const url = (id, variant) => `${base()}/api/photos/media/${variant}?id=${id}&mt=${encodeURIComponent(makeMediaToken(store, photosApi.mediaTokenId(id, variant)))}`
  const safe = (fn) => async (_e, arg) => {
    try { return await fn(arg || {}) } catch (e) { return { ok: false, error: e.status ? e.message : 'Photos are unavailable right now.' } }
  }

  ipcMain.handle('photos:overview', safe(async () => {
    const { library, backup } = services()
    let backupFolder = null
    try { backupFolder = library.backupRoot() } catch {}
    const users = auth.getUsers(store).filter((u) => u.status !== 'revoked').map((u) => {
      const a = library.access(u)
      return { id: u.id, name: u.name || u.username, owner: a.owner, view: a.view, backup: a.backup }
    })
    const summary = await backup.summary({ id: '__pc__', isAdmin: true }, new URLSearchParams())
    return { ok: true, folders: library.folders(), showLocation: library.showLocation(), backupFolder, users, devices: summary.devices }
  }))

  ipcMain.handle('photos:timeline', safe(async ({ offset = 0, limit = 200, album = '', type = '' }) => {
    const { library } = services()
    const params = new URLSearchParams({ offset: String(offset), limit: String(limit) })
    if (album) params.set('album', album)
    if (type) params.set('type', type)
    const out = await library.timeline(params, OWNER_ACCESS)
    for (const it of out.items) {
      it.thumbUrl = url(it.id, 'thumb')
      it.viewUrl = url(it.id, 'view')
      it.originalUrl = url(it.id, 'original')
    }
    return out
  }))

  ipcMain.handle('photos:albums', safe(async () => {
    const out = await services().library.albums(OWNER_ACCESS)
    for (const a of out.albums) a.coverUrl = url(a.coverId, 'thumb')
    return out
  }))

  ipcMain.handle('photos:map', safe(async () => {
    const { library } = services()
    const out = await library.mapPoints(OWNER_ACCESS)
    for (const it of out.items) {
      it.thumbUrl = url(it.id, 'thumb')
      it.viewUrl = url(it.id, 'view')
      it.originalUrl = url(it.id, 'original')
      it.location = { lat: it.lat, lon: it.lon } // shape the Viewer already knows how to show
    }
    return out
  }))

  ipcMain.handle('photos:addFolder', safe(async () => {
    const { library } = services()
    const res = await dialog.showOpenDialog({ title: 'Add a Photos folder', properties: ['openDirectory'] })
    if (res.canceled || !res.filePaths[0]) return { ok: true, folders: library.folders() }
    const saved = store.get('photosDirs')
    const current = Array.isArray(saved) && saved.length ? saved : library.folders()
    return { ok: true, folders: await library.setFolders([...current, res.filePaths[0]]) }
  }))

  ipcMain.handle('photos:removeFolder', safe(async ({ folder }) => {
    const { library } = services()
    const left = library.folders().filter((f) => f !== folder)
    if (!left.length) return { ok: false, error: 'Keep at least one Photos folder. Phone backups are saved inside the first one.' }
    return { ok: true, folders: await library.setFolders(left) }
  }))

  ipcMain.handle('photos:makePrimary', safe(async ({ folder }) => {
    const { library } = services()
    const list = library.folders()
    if (!list.includes(folder)) return { ok: false, error: 'That folder is not in the list.' }
    return { ok: true, folders: await library.setFolders([folder, ...list.filter((f) => f !== folder)]) }
  }))

  ipcMain.handle('photos:setShowLocation', safe(async ({ on }) => {
    services().library.setShowLocation(on === true)
    return { ok: true, showLocation: on === true }
  }))

  ipcMain.handle('photos:setAccess', safe(async ({ userId, view, backup }) => {
    const user = auth.getUsers(store).find((u) => u.id === userId)
    if (!user) return { ok: false, error: 'That person is not on this Beebo.' }
    if (user.isAdmin) return { ok: true }
    return { ok: true, access: services().library.setAccess(userId, { view: view === true, backup: backup === true }) }
  }))

  ipcMain.handle('photos:item', safe(async ({ id }) => {
    const { library } = services()
    const item = await library.resolveItem(String(id || ''))
    return { ok: true, item: library.publicItem(item, OWNER_ACCESS) }
  }))

  ipcMain.handle('photos:showInFolder', safe(async ({ id }) => {
    const item = await services().library.resolveItem(String(id || ''))
    shell.showItemInFolder(item.full)
    return { ok: true }
  }))

  ipcMain.handle('photos:openBackupFolder', safe(async () => {
    const fs = require('node:fs')
    const dir = services().library.backupRoot()
    fs.mkdirSync(dir, { recursive: true })
    await shell.openPath(dir)
    return { ok: true }
  }))

  ipcMain.handle('photos:rescan', safe(async () => {
    const { library } = services()
    library.invalidate()
    await library.current({ fresh: true })
    return { ok: true }
  }))
}

module.exports = { register }
