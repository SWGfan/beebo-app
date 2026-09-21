// Settings > Playback > Cinema (the desktop console): owner-only operations, folder chosen through the
// dialog only, intro chosen from files that exist, per-person choices for the owner only, IPC wiring, and
// the Movie page's "Play with pre-show" address. No Electron: the pure admin object and a fake ipcMain.
// Run: node --test test/cinema-ipc.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const ipc = require('../electron/cinemaIpc')
const cinema = require('../electron/cinemaMode')
const details = require('../electron/detailsIpc')

const memStore = (init = {}) => { const d = { ...init }; return { get: (k) => d[k], set: (k, v) => { d[k] = v }, data: d } }
const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-cinema-ipc-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d }
const users = [{ id: 'kid', status: 'approved' }, { id: 'owner', isAdmin: true, status: 'approved' }]

test('the owner is the first approved administrator; without one nothing personal can be saved', () => {
  assert.equal(ipc.ownerId(memStore({ authUsers: users })), 'owner')
  assert.equal(ipc.ownerId(memStore({})), null)
  assert.equal(ipc.ownerId(memStore({ authUsers: [{ id: 'a', isAdmin: true, status: 'pending' }] })), null)
  const admin = ipc.createCinemaAdmin({ store: memStore({}) })
  assert.equal(admin.saveMyPrefs({ enabled: true }).error, 'no_owner')
  assert.equal(admin.clearHistory().error, 'no_owner')
  assert.equal(admin.getState().hasOwner, false)
})

test('defaults: OFF, the default folder, no intro; nothing is created until asked', (t) => {
  const dir = path.join(tmp(t), 'Cinema')
  const admin = ipc.createCinemaAdmin({ store: memStore({ authUsers: users }), getDefaultDir: () => dir })
  const s = admin.getState()
  assert.equal(s.prefs.enabled, false)
  assert.equal(s.config.available, true)
  assert.equal(s.config.introFile, '')
  assert.deepEqual(s.folder, { path: dir, isDefault: true, exists: false, intros: [], trailers: [] })
  assert.equal(fs.existsSync(dir), false)
  assert.equal(admin.ensureFolder().ok, true)
  assert.ok(fs.existsSync(path.join(dir, 'Intros')) && fs.existsSync(path.join(dir, 'Trailers')))
})

test('the intro must be a file that really is in the Cinema folder', (t) => {
  const dir = tmp(t)
  fs.writeFileSync(path.join(dir, 'Feature Presentation.mp4'), 'x')
  fs.mkdirSync(path.join(dir, 'Intros'))
  fs.writeFileSync(path.join(dir, 'Intros', 'Countdown.webm'), 'x')
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x')
  const store = memStore({ authUsers: users })
  const admin = ipc.createCinemaAdmin({ store, getDefaultDir: () => dir })
  assert.deepEqual(admin.getState().folder.intros.sort(), ['Countdown.webm', 'Feature Presentation.mp4'])
  assert.equal(admin.saveConfig({ introFile: 'Feature Presentation.mp4' }).config.introFile, 'Feature Presentation.mp4')
  assert.equal(admin.saveConfig({ introFile: 'Countdown.webm' }).config.introFile, 'Countdown.webm')
  for (const bad of ['../secret.mp4', 'C:\\Windows\\x.mp4', 'notes.txt', 'missing.mp4', { a: 1 }]) {
    assert.equal(admin.saveConfig({ introFile: bad }).config.introFile, 'Countdown.webm', 'unchanged for ' + JSON.stringify(bad))
  }
  assert.equal(admin.saveConfig({ introFile: '' }).config.introFile, '')
})

test('the folder can only be set from a real directory (the dialog result), never from a saveConfig field', (t) => {
  const dir = tmp(t)
  const other = tmp(t)
  const store = memStore({ authUsers: users })
  const admin = ipc.createCinemaAdmin({ store, getDefaultDir: () => dir })
  admin.saveConfig({ folder: other, available: false })
  assert.equal(admin.getState().folder.path, dir, 'a folder field in saveConfig is ignored')
  assert.equal(admin.getState().config.available, false, 'the other fields are applied')
  assert.equal(admin.setFolder(path.join(dir, 'nope')).error, 'not_a_folder')
  assert.equal(admin.setFolder('').error, 'no_folder')
  assert.equal(admin.setFolder(other).folder.path, other)
  assert.equal(admin.getState().folder.isDefault, false)
})

test('saveConfig keeps only known fields and clamps them', (t) => {
  const store = memStore({ authUsers: users })
  const admin = ipc.createCinemaAdmin({ store, getDefaultDir: () => tmp(t) })
  const s = admin.saveConfig({ maxTrailers: 99, maxTrailerSeconds: 1, allowOnline: false, evil: '<script>', __proto__: { x: 1 } })
  assert.equal(s.config.maxTrailers, 5)
  assert.equal(s.config.maxTrailerSeconds, 30)
  assert.equal(s.config.allowOnline, false)
  assert.ok(!('evil' in store.data.cinemaConfig))
  assert.equal(admin.saveConfig(null).ok, true)
})

test('my choices are the OWNER\'s own and nobody else\'s', () => {
  const store = memStore({ authUsers: users })
  const admin = ipc.createCinemaAdmin({ store })
  const s = admin.saveMyPrefs({ enabled: true, count: 4, sources: { online: false }, userId: 'kid', neverShow: false })
  assert.equal(s.prefs.enabled, true)
  assert.equal(s.prefs.count, 4)
  assert.equal(s.prefs.sources.online, false)
  assert.equal(cinema.getPrefs(store, 'owner', '').enabled, true)
  assert.equal(cinema.getPrefs(store, 'kid', '').enabled, false, 'a household member is not changed from the console')
  cinema.createShownLog(store).record('owner', ['l:abc'])
  assert.equal(cinema.createShownLog(store).recent('owner', 30).size, 1)
  assert.equal(admin.clearHistory().ok, true)
  assert.equal(cinema.createShownLog(store).recent('owner', 30).size, 0)
})

test('coming soon: owner only, no key = a hint, a restricted owner profile = nothing', async () => {
  const noKey = ipc.createCinemaAdmin({ store: memStore({ authUsers: users }) })
  const a = await noKey.comingSoon()
  assert.equal(a.noKey, true)
  assert.match(a.attribution, /TMDB/)
  const restricted = ipc.createCinemaAdmin({ store: memStore({ authUsers: users, parentalControls: { owner: { enabled: true, preset: 'custom', movieMax: 'PG' } } }) })
  assert.equal((await restricted.comingSoon()).restricted, true)
})

test('IPC glue: channels are registered, the default folder is stored for the server, errors never escape', async (t) => {
  const handlers = {}
  const ipcMain = { handle: (name, fn) => { handlers[name] = fn } }
  const dir = tmp(t)
  const store = memStore({ authUsers: users })
  const dialog = { showOpenDialog: async () => ({ canceled: false, filePaths: [dir] }) }
  let opened = null
  const shell = { openPath: async (p) => { opened = p; return '' } }
  ipc.register({ ipcMain, dialog, shell, store, app: { getPath: () => dir }, getApi: () => null, getCacheDir: () => null })
  assert.equal(store.data.cinemaDefaultDir, path.join(dir, 'Cinema'))
  for (const ch of ['getState', 'saveConfig', 'saveMyPrefs', 'clearHistory', 'comingSoon', 'pickFolder', 'openFolder']) assert.equal(typeof handlers['cinema:' + ch], 'function', ch)
  assert.equal((await handlers['cinema:getState']({})).ok, true)
  assert.equal((await handlers['cinema:pickFolder']({})).folder.path, dir)
  assert.equal((await handlers['cinema:openFolder']({})).ok, true)
  assert.equal(opened, dir)
  const cancelled = ipc.register({ ipcMain: { handle: (n, fn) => { handlers['x' + n] = fn } }, dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }, shell, store: memStore({}), app: { getPath: () => dir } })
  assert.ok(cancelled.admin)
  assert.equal((await handlers['xcinema:pickFolder']({})).canceled, true)
  const bad = ipc.register({ ipcMain: { handle: (n, fn) => { handlers['y' + n] = fn } }, dialog: { showOpenDialog: async () => { throw new Error('dialog broke') } }, shell, store: memStore({}), app: { getPath: () => { throw new Error('no path') } } })
  assert.ok(bad.admin)
  assert.deepEqual(await handlers['ycinema:pickFolder']({}), { ok: false, error: 'failed' })
})

test('the Movie page: "Play with pre-show" asks the web player for the pre-show, for films only', () => {
  const id = details.encodeId('Film (2020).mp4')
  assert.match(details.playerPath({ kind: 'movie', fileName: 'Film (2020).mp4', preshow: true }), new RegExp('^/watch\\?id=' + id + '&preshow=1$'))
  assert.ok(!details.playerPath({ kind: 'movie', fileName: 'Film (2020).mp4' }).includes('preshow'))
  assert.ok(!details.playerPath({ kind: 'movie', fileName: 'Film (2020).mp4', preshow: 'yes' }).includes('preshow'), 'only a real true')
  assert.ok(!details.playerPath({ kind: 'tv', fileName: 'Show/S01E01.mp4', preshow: true }).includes('preshow'), 'no pre-show before an episode')
  const withTracks = details.playerPath({ kind: 'movie', fileName: 'Film (2020).mp4', preshow: true, startSeconds: 90, audioStreamIndex: 1 })
  assert.match(withTracks, /t=90/)
  assert.match(withTracks, /preshow=1/)
})
