'use strict'
// The desktop window's Table view of Movies and TV Shows (src/components/LibraryTable.jsx):
//   libraryTable:getPrefs / setPrefs   Posters-or-Table, which columns, their widths and the sort, saved
//                                      per screen in the app's settings store, so they survive a restart.
//   libraryTable:info / cancel         what is inside the video files on screen (libraryInfo.js), read
//                                      lazily, with results pushed back as 'libraryTable:info' events.
//   libraryTable:marks                 the owner's own watched marks, watchlist and part-watched progress, for the
//                                      optional columns, the watched / in-progress filters and the Shelves view.
//   libraryViews:get / set             how each library screen is shown, grouping, sort, filters and the person's
//                                      saved views (electron/uiPrefs.js), kept per person: the desktop window's
//                                      person is the first approved admin, the same rule the marks use.
// Registered on ipcMain only: nothing here is reachable from the phone app or the website.

const path = require('path')
const { createLibraryInfo } = require('./libraryInfo')
const uiPrefs = require('./uiPrefs')

const PREFS_KEY = 'libraryTablePrefs'
const KINDS = ['movies', 'tv']
const ID = /^[A-Za-z][A-Za-z0-9]{0,31}$/

// One screen's saved choices, cleaned. Unknown shapes become defaults; the renderer drops
// column ids it does not know, this only makes sure nothing odd is written to the store.
function cleanKind(raw) {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const out = { mode: o.mode === 'table' ? 'table' : 'posters', columns: null, widths: {}, sort: null }
  if (Array.isArray(o.columns)) out.columns = [...new Set(o.columns.filter((id) => typeof id === 'string' && ID.test(id)))].slice(0, 64)
  if (o.widths && typeof o.widths === 'object' && !Array.isArray(o.widths)) {
    for (const [id, w] of Object.entries(o.widths).slice(0, 64)) {
      if (ID.test(id) && Number.isFinite(w)) out.widths[id] = Math.min(900, Math.max(48, Math.round(w)))
    }
  }
  if (o.sort && typeof o.sort === 'object' && typeof o.sort.id === 'string' && ID.test(o.sort.id)) {
    out.sort = { id: o.sort.id, dir: o.sort.dir === 'desc' ? 'desc' : 'asc' }
  }
  return out
}

function readPrefs(store) {
  const raw = store.get(PREFS_KEY) || {}
  return { movies: cleanKind(raw.movies), tv: cleanKind(raw.tv) }
}

// Only files inside the managed Movies / TV Shows folders may be read. The renderer is our own
// code, but a path is still a path: this keeps the channel from being a way to read any file.
function pathAllowed(roots, filePath) {
  const resolved = path.resolve(String(filePath || ''))
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p)
  return roots.some((root) => {
    const r = norm(path.resolve(root))
    const f = norm(resolved)
    return f.startsWith(r.endsWith(path.sep) ? r : r + path.sep)
  })
}

const decodeId = (id) => { try { return Buffer.from(String(id || ''), 'base64url').toString('utf8') } catch { return '' } }

// The desktop window's person is the first approved admin (the same rule the details page uses).
// A person who has switched viewing privacy on gets no marks at all, like History.
function desktopPerson(auth, store) {
  const users = auth.getUsers(store) || []
  return users.find((u) => u && u.isAdmin && u.status === 'approved') || users.find((u) => u && u.isAdmin) || null
}

// The id saved views are filed under. With nobody signed up yet (a brand-new install) everything is filed
// under one stable name, so the first person to be created inherits what was set up before.
const viewsOwner = (auth, store) => {
  try {
    const me = auth ? desktopPerson(auth, store) : null
    return me && typeof me.id === 'string' && me.id ? me.id : 'owner'
  } catch { return 'owner' }
}

function ownersMarks({ store, auth, watchedState, viewingPrivacy, history }) {
  const me = desktopPerson(auth, store)
  if (!me) return { ok: false }
  if (viewingPrivacy.isPrivate(store, me.id)) return { ok: false, private: true }
  const watchedMovies = []
  const watchedEpisodes = []
  for (const [key, rec] of Object.entries(watchedState.userFiles(store, me.id))) {
    if (!rec || !rec.watched) continue
    if (key.startsWith('movie:')) watchedMovies.push(key.slice(6))
    else if (key.startsWith('tv:')) watchedEpisodes.push(key.slice(3))
  }
  const list = (store.get('watchlist') || {})[me.id]
  const watchlistMovies = (Array.isArray(list) ? list : []).filter((x) => x && x.kind === 'movie').map((x) => decodeId(x.id)).filter(Boolean)
  // Part-watched files (history.continueWatching: one row per file, newest first, nothing finished).
  // { kind: 'movie' | 'tv', fileName, percent (1-99), at }
  const progress = []
  if (history && typeof history.continueWatching === 'function') {
    try {
      for (const row of history.continueWatching(store, me.id).slice(0, 500)) {
        if (!row || !row.fileName || !(row.percent > 0)) continue
        progress.push({ kind: row.kind === 'tv' ? 'tv' : 'movie', fileName: String(row.fileName), percent: Math.min(99, Math.round(row.percent)), at: Number(row.updatedAt) || 0 })
      }
    } catch { /* no progress rather than no marks */ }
  }
  return { ok: true, watchedMovies, watchedEpisodes, watchlistMovies, progress }
}

function register({ ipcMain, store, ffprobePath, getLibraryRoots, cacheFile, auth, watchedState, viewingPrivacy, history, log = () => {} }) {
  const service = createLibraryInfo({ ffprobePath, cacheFile, log })

  ipcMain.handle('libraryTable:getPrefs', () => readPrefs(store))

  ipcMain.handle('libraryTable:setPrefs', (_e, kind, patch) => {
    if (!KINDS.includes(kind) || !patch || typeof patch !== 'object') return readPrefs(store)
    const all = readPrefs(store)
    const cleaned = cleanKind({ ...all[kind], ...patch })
    // Only the fields the caller named change: cleanKind fills defaults for the rest.
    const next = { ...all[kind] }
    for (const field of Object.keys(patch)) if (field in cleaned) next[field] = cleaned[field]
    store.set(PREFS_KEY, { ...all, [kind]: next })
    return readPrefs(store)
  })

  ipcMain.handle('libraryTable:info', (event, scope, paths, opts) => {
    const sender = event.sender
    const name = String(scope || 'table').slice(0, 24)
    const roots = getLibraryRoots().filter(Boolean)
    const allowed = (Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string' && pathAllowed(roots, p))
    return service.request(`${sender.id}:${name}`, allowed, (batch) => {
      if (!sender.isDestroyed()) sender.send('libraryTable:info', { scope: name, ...batch })
    }, { statOnly: !!(opts && opts.statOnly) })
  })

  ipcMain.handle('libraryTable:marks', () => {
    if (!auth || !watchedState || !viewingPrivacy) return { ok: false }
    try { return ownersMarks({ store, auth, watchedState, viewingPrivacy, history }) } catch { return { ok: false } }
  })

  // Saved views and the look of each library screen, for this window's person.
  ipcMain.handle('libraryViews:get', () => {
    const userId = viewsOwner(auth, store)
    return { userId, views: uiPrefs.readLibraryViews(store, userId) }
  })
  ipcMain.handle('libraryViews:set', (_e, views) => {
    const userId = viewsOwner(auth, store)
    try { return { ok: true, userId, views: uiPrefs.writeLibraryViews(store, userId, views) } } catch (e) { return { ok: false, error: e && e.code ? e.code : 'ui_pref_invalid' } }
  })

  ipcMain.handle('libraryTable:cancel', (event, scope) => {
    service.cancel(`${event.sender.id}:${String(scope || 'table').slice(0, 24)}`)
    return true
  })

  return { service, saveSync: () => service.saveSync() }
}

module.exports = { register, cleanKind, readPrefs, pathAllowed, ownersMarks, viewsOwner, PREFS_KEY }
