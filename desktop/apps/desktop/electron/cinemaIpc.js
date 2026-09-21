'use strict'
// ============================================================================
// cinemaIpc.js - Settings > Playback > Cinema (the desktop console).
// ----------------------------------------------------------------------------
// The desktop app is the OWNER's console, so it edits (1) the server-wide Cinema settings and (2) the
// owner's own per-person choices; it can never name another person. Other household members set their
// own pre-show choices in the player (cinemaModeWeb.js).
//
// The renderer never supplies a file path: the Cinema folder is picked with the native dialog here, the
// intro is chosen from the file names found in that folder, and everything is normalised by cinemaMode.js.
// ============================================================================

const fs = require('fs')
const path = require('path')
const cinema = require('./cinemaMode')
const cinemaOnline = require('./cinemaOnline')
const parental = require('./parentalControls')

/** The person whose choices the desktop console edits: the owner (first approved admin). */
function ownerId(store) {
  try {
    const users = store.get('authUsers')
    const owner = Array.isArray(users) ? users.find((u) => u && u.isAdmin && u.status === 'approved') : null
    return owner && typeof owner.id === 'string' ? owner.id : null
  } catch { return null }
}

const CONFIG_FIELDS = ['available', 'allowOnline', 'maxTrailers', 'maxTrailerSeconds', 'introFile']

/** Pure operations over the store (testable without Electron). */
function createCinemaAdmin({ store, getDefaultDir = () => '', getApi = () => null, getCacheDir = () => null, fsImpl = fs }) {
  const effectiveFolder = () => cinema.getConfig(store).folder || getDefaultDir() || ''
  const online = cinemaOnline.createOnlineSource({ getApi, getCacheDir })

  function folderInfo() {
    const p = effectiveFolder()
    let exists = false
    try { exists = !!p && fsImpl.statSync(p).isDirectory() } catch { exists = false }
    const files = exists ? cinema.listCinemaFolder(p, { fsImpl }) : { intros: [], trailers: [] }
    return { path: p, isDefault: !cinema.getConfig(store).folder, exists, intros: files.intros.map((f) => f.name), trailers: files.trailers.map((f) => f.name) }
  }

  function getState() {
    const owner = ownerId(store)
    const cfg = cinema.getConfig(store)
    return {
      ok: true,
      hasOwner: !!owner,
      config: { available: cfg.available, allowOnline: cfg.allowOnline, maxTrailers: cfg.maxTrailers, maxTrailerSeconds: cfg.maxTrailerSeconds, introFile: cfg.introFile },
      folder: folderInfo(),
      prefs: owner ? cinema.getPrefs(store, owner, '') : cinema.normalizePrefs(null),
      hasTmdbKey: online.hasKey()
    }
  }

  function saveConfig(partial) {
    const p = partial && typeof partial === 'object' ? partial : {}
    const patch = {}
    for (const k of CONFIG_FIELDS) if (k in p) patch[k] = p[k]
    if ('introFile' in patch) {
      // Only a file that really is in the Cinema folder (or '' to clear it).
      const name = patch.introFile
      if (typeof name !== 'string' || (name && !folderInfo().intros.includes(name))) delete patch.introFile
    }
    cinema.setConfig(store, patch)
    return getState()
  }

  /** dir came from the native folder dialog, never from the renderer. */
  function setFolder(dir) {
    if (typeof dir !== 'string' || !dir) return { ok: false, error: 'no_folder' }
    let ok = false
    try { ok = fsImpl.statSync(dir).isDirectory() } catch { ok = false }
    if (!ok) return { ok: false, error: 'not_a_folder' }
    cinema.setConfig(store, { folder: dir, introFile: '' })
    return getState()
  }

  function ensureFolder() {
    const p = effectiveFolder()
    if (!p) return { ok: false, error: 'no_folder' }
    try {
      fsImpl.mkdirSync(path.join(p, 'Intros'), { recursive: true })
      fsImpl.mkdirSync(path.join(p, 'Trailers'), { recursive: true })
    } catch { return { ok: false, error: 'cannot_create' } }
    return { ok: true, path: p }
  }

  function saveMyPrefs(patch) {
    const owner = ownerId(store)
    if (!owner) return { ok: false, error: 'no_owner' }
    cinema.setPrefs(store, owner, '', patch)
    return getState()
  }

  function clearHistory() {
    const owner = ownerId(store)
    if (!owner) return { ok: false, error: 'no_owner' }
    cinema.createShownLog(store).forget(cinema.viewerKeyOf(owner, ''))
    return { ok: true }
  }

  async function comingSoon() {
    const owner = ownerId(store)
    if (owner && parental.isRestricted(parental.getPolicy(store, owner))) return { ok: true, restricted: true, upcoming: [], nowPlaying: [], attribution: cinemaOnline.TMDB_ATTRIBUTION }
    if (!online.hasKey()) return { ok: true, restricted: false, noKey: true, upcoming: [], nowPlaying: [], attribution: cinemaOnline.TMDB_ATTRIBUTION }
    const shelf = await online.comingSoon()
    return { ok: true, restricted: false, online: online.isReachable(), ...shelf, attribution: cinemaOnline.TMDB_ATTRIBUTION }
  }

  return { getState, saveConfig, setFolder, ensureFolder, saveMyPrefs, clearHistory, comingSoon, effectiveFolder }
}

function register({ ipcMain, dialog, shell, store, app, getMainWindow = () => null, getApi, getCacheDir, log = () => {} }) {
  // The server reads the default folder from the store: userData/Cinema unless the owner picked another.
  try { store.set('cinemaDefaultDir', path.join(app.getPath('userData'), 'Cinema')) } catch (e) { log('[cinema] no default folder: ' + (e && e.message)) }
  const admin = createCinemaAdmin({ store, getDefaultDir: () => { try { return path.join(app.getPath('userData'), 'Cinema') } catch { return '' } }, getApi, getCacheDir })
  const guard = (fn) => async (_e, arg) => { try { return await fn(arg) } catch (e) { log('[cinema] ' + (e && e.message)); return { ok: false, error: 'failed' } } }

  ipcMain.handle('cinema:getState', guard(() => admin.getState()))
  ipcMain.handle('cinema:saveConfig', guard((partial) => admin.saveConfig(partial)))
  ipcMain.handle('cinema:saveMyPrefs', guard((patch) => admin.saveMyPrefs(patch)))
  ipcMain.handle('cinema:clearHistory', guard(() => admin.clearHistory()))
  ipcMain.handle('cinema:comingSoon', guard(() => admin.comingSoon()))
  ipcMain.handle('cinema:pickFolder', guard(async () => {
    const win = getMainWindow()
    const res = await dialog.showOpenDialog(win || undefined, { title: 'Choose your Cinema folder', properties: ['openDirectory', 'createDirectory'] })
    if (res.canceled || !res.filePaths || !res.filePaths[0]) return { ok: false, canceled: true }
    return admin.setFolder(res.filePaths[0])
  }))
  ipcMain.handle('cinema:openFolder', guard(async () => {
    const made = admin.ensureFolder()
    if (!made.ok) return made
    const err = await shell.openPath(made.path)
    return err ? { ok: false, error: 'open_failed' } : { ok: true }
  }))
  return { admin }
}

module.exports = { register, createCinemaAdmin, ownerId }
