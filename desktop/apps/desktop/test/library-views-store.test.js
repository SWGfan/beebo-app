// Where the library views are remembered: the main-process store (electron/uiPrefs.js, per person),
// its two IPC channels and the part-watched progress the marks channel now carries
// (electron/libraryTableIpc.js), and the renderer's shared store (src/lib/libraryViewStore.js).
// Run: node --test test/library-views-store.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const appRoot = path.resolve(__dirname, '..')
const uiPrefs = require(path.join(appRoot, 'electron', 'uiPrefs.js'))
const ipc = require(path.join(appRoot, 'electron', 'libraryTableIpc.js'))
const lib = (f) => import(pathToFileURL(path.join(appRoot, 'src', 'lib', f)).href)

const memoryStore = (initial = {}) => {
  const data = { ...initial }
  return { data, get: (k) => data[k], set: (k, v) => { data[k] = v } }
}
function fakeIpc() {
  const handlers = new Map()
  return { handle: (name, fn) => handlers.set(name, fn), call: (name, ...args) => handlers.get(name)({ sender: { id: 1, isDestroyed: () => false, send() {} } }, ...args) }
}

const SAMPLE = {
  movies: { mode: 'grouped', groupBy: 'decade', sort: { id: 'rating', dir: 'desc' }, filters: { genres: ['Drama'], yearMin: 1990 }, active: 'v1', saved: [{ id: 'v1', name: 'Night', mode: 'grouped', filters: { hdr: 'hdr' } }] },
  tv: { mode: 'shelves' }
}

// ------------------------------------------------------------------ main-process store

test('views are kept per person and never mix, and the plain UI prefs are untouched', () => {
  const store = memoryStore()
  uiPrefs.write(store, { sidebarMode: 'hidden' })
  uiPrefs.writeLibraryViews(store, 'alice', SAMPLE)
  uiPrefs.writeLibraryViews(store, 'bob', { movies: { mode: 'table' } })
  assert.equal(uiPrefs.readLibraryViews(store, 'alice').movies.mode, 'grouped')
  assert.equal(uiPrefs.readLibraryViews(store, 'alice').movies.saved[0].name, 'Night')
  assert.equal(uiPrefs.readLibraryViews(store, 'bob').movies.mode, 'table')
  assert.deepEqual(uiPrefs.readLibraryViews(store, 'carol'), {}, 'a person with nothing saved gets an empty answer')
  assert.equal(uiPrefs.read(store).sidebarMode, 'hidden')
  assert.deepEqual(Object.keys(store.data[uiPrefs.STORE_KEY]).sort(), ['posterSize', 'showPosterIcons', 'showPosterTitles', 'sidebarMode'], 'the existing prefs key gained nothing')
  uiPrefs.write(store, { posterSize: 200 })
  assert.equal(uiPrefs.readLibraryViews(store, 'alice').movies.mode, 'grouped', 'writing plain prefs leaves the views alone')
})

test('a write replaces that person\'s block and keeps only the two known screens', () => {
  const store = memoryStore()
  uiPrefs.writeLibraryViews(store, 'a', SAMPLE)
  uiPrefs.writeLibraryViews(store, 'a', { movies: { mode: 'table' }, photos: { mode: 'x' }, extra: 1 })
  const got = uiPrefs.readLibraryViews(store, 'a')
  assert.deepEqual(Object.keys(got), ['movies'])
  assert.equal(got.movies.mode, 'table')
})

test('bad writes are refused and store nothing; oversized and hostile values are bounded', () => {
  const store = memoryStore()
  const bad = (userId, value) => assert.throws(() => uiPrefs.writeLibraryViews(store, userId, value), (e) => e.code === 'ui_pref_invalid')
  bad('a', null)
  bad('a', [])
  bad('a', 'text')
  bad('', SAMPLE)
  bad('../../x', SAMPLE)
  bad(42, SAMPLE)
  assert.equal(store.data[uiPrefs.LIBRARY_VIEWS_KEY], undefined)
  const saved = Array.from({ length: 500 }, (_, i) => ({ id: `v${i}`, name: `View ${i}` }))
  uiPrefs.writeLibraryViews(store, 'a', { movies: { saved, mode: 'x'.repeat(5000), __proto__: { polluted: 1 }, 'bad key!': 1 } })
  const got = uiPrefs.readLibraryViews(store, 'a').movies
  assert.equal(got.saved.length, 40)
  assert.equal(got.mode.length, 200)
  assert.ok(!('bad key!' in got))
  assert.equal({}.polluted, undefined)
  let deep = { v: 1 }
  for (let i = 0; i < 40; i++) deep = { d: deep }
  uiPrefs.writeLibraryViews(store, 'a', { movies: { filters: deep } })
  assert.ok(JSON.stringify(uiPrefs.readLibraryViews(store, 'a')).length < 2000, 'depth is capped')
})

test('a damaged stored value reads as empty instead of throwing', () => {
  assert.deepEqual(uiPrefs.readLibraryViews(memoryStore({ [uiPrefs.LIBRARY_VIEWS_KEY]: 'garbage' }), 'a'), {})
  assert.deepEqual(uiPrefs.readLibraryViews(memoryStore({ [uiPrefs.LIBRARY_VIEWS_KEY]: { a: 7 } }), 'a'), {})
})

test('only the newest people are kept', () => {
  const store = memoryStore()
  for (let i = 0; i < 60; i++) uiPrefs.writeLibraryViews(store, `user${i}`, { movies: { mode: 'table' } })
  assert.equal(Object.keys(store.data[uiPrefs.LIBRARY_VIEWS_KEY]).length, 50)
  assert.equal(uiPrefs.readLibraryViews(store, 'user59').movies.mode, 'table')
  assert.deepEqual(uiPrefs.readLibraryViews(store, 'user0'), {})
})

// ------------------------------------------------------------------ IPC

const users = (list) => ({ getUsers: () => list })

test('the views channels file everything under the desktop person (the first approved admin)', () => {
  const store = memoryStore()
  const ipcMain = fakeIpc()
  const auth = users([{ id: 'kid', status: 'approved' }, { id: 'boss', isAdmin: true, status: 'approved' }])
  ipc.register({ ipcMain, store, ffprobePath: () => null, getLibraryRoots: () => [], cacheFile: null, auth })
  assert.deepEqual(ipcMain.call('libraryViews:get'), { userId: 'boss', views: {} })
  const res = ipcMain.call('libraryViews:set', SAMPLE)
  assert.equal(res.ok, true)
  assert.equal(res.userId, 'boss')
  assert.equal(ipcMain.call('libraryViews:get').views.tv.mode, 'shelves')
  assert.ok(store.data[uiPrefs.LIBRARY_VIEWS_KEY].boss, 'filed under the person')
  assert.equal(store.data[uiPrefs.LIBRARY_VIEWS_KEY].kid, undefined)
  assert.deepEqual(ipcMain.call('libraryViews:set', 'nope'), { ok: false, error: 'ui_pref_invalid' })
  assert.equal(ipcMain.call('libraryViews:get').views.tv.mode, 'shelves', 'a bad write changes nothing')
})

test('with nobody signed up the views are filed under one stable name', () => {
  const store = memoryStore()
  const ipcMain = fakeIpc()
  ipc.register({ ipcMain, store, ffprobePath: () => null, getLibraryRoots: () => [], cacheFile: null, auth: users([]) })
  assert.equal(ipcMain.call('libraryViews:get').userId, 'owner')
  const none = memoryStore()
  const ipc2 = fakeIpc()
  ipc.register({ ipcMain: ipc2, store: none, ffprobePath: () => null, getLibraryRoots: () => [], cacheFile: null })
  assert.equal(ipc2.call('libraryViews:get').userId, 'owner', 'no auth module at all')
})

// ------------------------------------------------------------------ progress on the marks channel

test('the owner\'s part-watched files come back with the marks, and only theirs', () => {
  const watchedState = require('../electron/watchedState')
  const auth = require('../electron/auth')
  const viewingPrivacy = require('../electron/viewingPrivacy')
  const history = require('../electron/history')
  const state = { authUsers: [{ id: 'me', username: 'me', isAdmin: true, status: 'approved' }, { id: 'kid', username: 'kid', status: 'approved' }] }
  const store = { get: (k) => state[k], set: (k, v) => { state[k] = v }, delete: (k) => { delete state[k] } }
  const at = Date.now()
  state.watchHistory = [
    { id: 's1', userId: 'me', fileName: 'Alien (1979).mkv', title: 'Alien', kind: 'movie', currentTime: 3000, duration: 7000, lastUpdate: at },
    { id: 's2', userId: 'me', fileName: 'Show\\Season 1\\E1.mkv', title: 'Show — S1E1', kind: 'tv', currentTime: 600, duration: 2400, lastUpdate: at - 5 },
    { id: 's3', userId: 'me', fileName: 'Done.mkv', title: 'Done', kind: 'movie', currentTime: 6900, duration: 7000, lastUpdate: at },
    { id: 's4', userId: 'kid', fileName: 'Kid.mkv', title: 'Kid', kind: 'movie', currentTime: 100, duration: 1000, lastUpdate: at }
  ]
  const r = ipc.ownersMarks({ store, auth, watchedState, viewingPrivacy, history })
  assert.equal(r.ok, true)
  assert.deepEqual(r.progress.map((p) => [p.kind, p.fileName, p.percent]), [['movie', 'Alien (1979).mkv', 43], ['tv', 'Show\\Season 1\\E1.mkv', 25]])
  assert.ok(r.progress.every((p) => p.at > 0))
  // without the history module the marks still work
  assert.deepEqual(ipc.ownersMarks({ store, auth, watchedState, viewingPrivacy }).progress, [])
  // viewing privacy still hides everything, progress included
  state.authUsers[0].viewingHistoryPrivate = true
  assert.deepEqual(ipc.ownersMarks({ store, auth, watchedState, viewingPrivacy, history }), { ok: false, private: true })
})

// ------------------------------------------------------------------ renderer store

const memoryStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), map: m } }
const manualTimers = () => {
  const jobs = new Map()
  let n = 0
  return {
    setTimer: (fn) => { jobs.set(++n, fn); return n },
    clearTimer: (id) => jobs.delete(id),
    fire: () => { for (const [id, fn] of [...jobs]) { jobs.delete(id); fn() } },
    pending: () => jobs.size
  }
}

test('the first paint uses the cached copy; the stored copy replaces it once it arrives', async () => {
  const { createLibraryViewStore } = await lib('libraryViewStore.js')
  const { emptyUserViews, patchCurrent } = await lib('libraryViews.js')
  const storage = memoryStorage()
  storage.setItem('beebo.libraryViews', JSON.stringify(patchCurrent(emptyUserViews(), 'movies', { mode: 'table' })))
  let release
  const api = { getViews: () => new Promise((res) => { release = res }), setViews: async () => ({ ok: true }) }
  const store = createLibraryViewStore({ api, storage })
  assert.equal(store.get().movies.mode, 'table', 'synchronous, from the cache')
  const seen = []
  store.subscribe(() => seen.push(store.get().movies.mode))
  const loading = store.load()
  release({ userId: 'u', views: { movies: { mode: 'shelves' } } })
  await loading
  assert.equal(store.get().movies.mode, 'shelves')
  assert.equal(store.userId(), 'u')
  assert.equal(store.loaded(), true)
  assert.deepEqual(seen, ['shelves'])
  assert.equal(JSON.parse(storage.getItem('beebo.libraryViews')).movies.mode, 'shelves', 'the cache follows')
})

test('changes are saved once, shortly after they stop, and identical changes are not saved at all', async () => {
  const { createLibraryViewStore } = await lib('libraryViewStore.js')
  const { patchCurrent, saveCurrentAsView } = await lib('libraryViews.js')
  const timers = manualTimers()
  const writes = []
  const store = createLibraryViewStore({ api: { getViews: async () => ({ userId: 'u', views: { movies: { mode: 'posters' } } }), setViews: async (v) => { writes.push(v) } }, storage: memoryStorage(), ...timers })
  await store.load()
  store.dispatch((s) => patchCurrent(s, 'movies', { mode: 'table' }))
  store.dispatch((s) => patchCurrent(s, 'movies', { mode: 'grouped' }))
  store.dispatch((s) => saveCurrentAsView(s, 'movies', 'Mine', 5))
  assert.equal(writes.length, 0, 'nothing sent while changes keep coming')
  assert.equal(timers.pending(), 1)
  timers.fire()
  await store.flush()
  assert.equal(writes.length, 1)
  assert.equal(writes[0].movies.mode, 'grouped')
  assert.equal(writes[0].movies.saved[0].name, 'Mine')
  store.dispatch((s) => patchCurrent(s, 'movies', { mode: 'grouped' }))
  assert.equal(timers.pending(), 0, 'setting what is already set writes nothing')
})

test('garbage a changer returns is cleaned before it is kept or sent', async () => {
  const { createLibraryViewStore } = await lib('libraryViewStore.js')
  const store = createLibraryViewStore({ storage: memoryStorage() })
  store.dispatch(() => ({ movies: { mode: 'cover-flow', filters: { hdr: 'evil' } }, tv: 5 }))
  assert.equal(store.get().movies.mode, 'posters')
  assert.equal(store.get().movies.filters.hdr, 'any')
  assert.equal(store.get().tv.mode, 'posters')
})

test('without a bridge (a plain browser) the store still works from its cache; a failed save is retried on the next change', async () => {
  const { createLibraryViewStore } = await lib('libraryViewStore.js')
  const { patchCurrent } = await lib('libraryViews.js')
  const noApi = createLibraryViewStore({ storage: memoryStorage() })
  await noApi.load()
  noApi.dispatch((s) => patchCurrent(s, 'tv', { mode: 'folders' }))
  assert.equal(noApi.get().tv.mode, 'folders')
  let fail = true
  const sent = []
  const timers = manualTimers()
  const store = createLibraryViewStore({ api: { getViews: async () => ({ userId: 'u', views: { movies: {} } }), setViews: async (v) => { if (fail) throw new Error('down'); sent.push(v) } }, storage: memoryStorage(), ...timers })
  await store.load()
  store.dispatch((s) => patchCurrent(s, 'movies', { mode: 'table' }))
  timers.fire()
  await store.flush()
  assert.equal(sent.length, 0)
  fail = false
  store.dispatch((s) => patchCurrent(s, 'movies', { mode: 'shelves' }))
  timers.fire()
  await store.flush()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].movies.mode, 'shelves')
})

test('a first-ever load carries over the old Posters | Table choice once', async () => {
  const { createLibraryViewStore } = await lib('libraryViewStore.js')
  const timers = manualTimers()
  const sent = []
  const store = createLibraryViewStore({
    api: { getViews: async () => ({ userId: 'u', views: {} }), setViews: async (v) => { sent.push(v) } },
    storage: memoryStorage(),
    migrate: async (state) => ({ ...state, movies: { ...state.movies, mode: 'table' } }),
    ...timers
  })
  await store.load()
  assert.equal(store.get().movies.mode, 'table')
  assert.equal(store.get().tv.mode, 'posters')
  assert.equal(sent.length, 1, 'the carried-over choice is saved straight away')
  // a person who already has saved views is not migrated
  const kept = createLibraryViewStore({ api: { getViews: async () => ({ userId: 'u', views: { movies: { mode: 'shelves' } } }), setViews: async () => {} }, storage: memoryStorage(), migrate: async () => { throw new Error('should not run') } })
  await kept.load()
  assert.equal(kept.get().movies.mode, 'shelves')
})
