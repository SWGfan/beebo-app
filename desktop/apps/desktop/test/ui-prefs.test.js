// Remembered look-and-feel choices: sidebar mode, poster size, and the two poster display
// switches. Covers the main-process store (electron/uiPrefs.js and its two IPC handlers),
// the renderer's cache + IPC wrapper (src/lib/uiPrefs.js) and the markup contract that lets
// the "posters only" look hide every overlay with one attribute.
// Run: node --test test/ui-prefs.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { pathToFileURL } = require('node:url')

const appRoot = path.resolve(__dirname, '..')
const uiPrefs = require(path.join(appRoot, 'electron', 'uiPrefs.js'))
const loadRenderer = () => import(pathToFileURL(path.join(appRoot, 'src', 'lib', 'uiPrefs.js')).href)
const read = (rel) => fs.readFileSync(path.join(appRoot, rel), 'utf8')

const memoryStore = (initial = {}) => {
  const data = { ...initial }
  return { data, get: (k) => data[k], set: (k, v) => { data[k] = v } }
}

const DEFAULTS = { sidebarMode: 'pinned', posterSize: 160, showPosterIcons: true, showPosterTitles: true }

test('a fresh install reads the defaults: sidebar pinned, 160px posters, icons and titles shown', () => {
  assert.deepEqual(uiPrefs.read(memoryStore()), DEFAULTS)
})

test('writes are validated, partial, and clamped; bad input changes nothing', () => {
  const store = memoryStore()
  assert.deepEqual(uiPrefs.write(store, { sidebarMode: 'hidden' }), { ...DEFAULTS, sidebarMode: 'hidden' })
  assert.deepEqual(uiPrefs.write(store, { posterSize: 240.4 }), { ...DEFAULTS, sidebarMode: 'hidden', posterSize: 240.4 })
  assert.equal(uiPrefs.write(store, { posterSize: 5000 }).posterSize, 320)
  assert.equal(uiPrefs.write(store, { posterSize: -1 }).posterSize, 90)
  assert.equal(uiPrefs.write(store, { showPosterIcons: false }).showPosterIcons, false)
  const kept = JSON.stringify(store.data)
  for (const bad of [{ sidebarMode: 'floating' }, { sidebarMode: '' }, { posterSize: 'huge' }, { posterSize: NaN }, { showPosterTitles: 'no' }, { showPosterIcons: 0 }, null, [], 'pinned', 3]) {
    assert.throws(() => uiPrefs.write(store, bad), (e) => e.code === 'ui_pref_invalid', JSON.stringify(bad))
    assert.equal(JSON.stringify(store.data), kept, 'a rejected write stores nothing')
  }
})

test('unknown keys are ignored, so this channel cannot store anything else', () => {
  const store = memoryStore()
  uiPrefs.write(store, { sidebarMode: 'hover', tmdbApiKey: 'secret', authUsers: [] })
  assert.deepEqual(Object.keys(store.data), [uiPrefs.STORE_KEY])
  assert.deepEqual(Object.keys(store.data[uiPrefs.STORE_KEY]).sort(), ['posterSize', 'showPosterIcons', 'showPosterTitles', 'sidebarMode'])
})

test('corrupt stored values are repaired on read instead of breaking the layout', () => {
  const store = memoryStore({ uiPrefs: { sidebarMode: 'sideways', posterSize: 'x', showPosterIcons: 'yes', showPosterTitles: false } })
  assert.deepEqual(uiPrefs.read(store), { ...DEFAULTS, showPosterIcons: true, showPosterTitles: false })
  assert.deepEqual(uiPrefs.read(memoryStore({ uiPrefs: 'garbage' })), DEFAULTS)
})

function handler(name, store) {
  const source = read('electron/main.js')
  const start = source.indexOf(`ipcMain.handle('${name}'`)
  assert.ok(start >= 0, `${name} is registered`)
  const end = source.indexOf('\n', start)
  let registered
  vm.runInNewContext(source.slice(start, end), { ipcMain: { handle: (_, fn) => { registered = fn } }, uiPrefs, store })
  return registered
}

test('the registered IPC handlers read and write the store, and the preload exposes them', () => {
  const store = memoryStore()
  const get = handler('uiPrefs:get', store)
  const set = handler('uiPrefs:set', store)
  assert.deepEqual(get(), DEFAULTS)
  set(null, { sidebarMode: 'hover', posterSize: 200 })
  assert.deepEqual(get(), { ...DEFAULTS, sidebarMode: 'hover', posterSize: 200 })
  assert.throws(() => set(null, { sidebarMode: 'nope' }))
  const preload = read('electron/preload.js')
  assert.match(preload, /uiPrefsGet: \(\) => ipcRenderer\.invoke\('uiPrefs:get'\)/)
  assert.match(preload, /uiPrefsSet: \(partial\) => ipcRenderer\.invoke\('uiPrefs:set', partial\)/)
})

test('the generic settings channel still refuses these keys (they have their own validated channel)', () => {
  const policy = require(path.join(appRoot, 'electron', 'desktopSettingsPolicy.js'))
  assert.throws(() => policy.writeSettings(memoryStore(), { sidebarMode: 'hidden' }), (e) => e.code === 'setting_not_allowed')
})

test('main and renderer agree on the limits and the defaults', async () => {
  const R = await loadRenderer()
  assert.deepEqual(R.normalizeUiPrefs(null), DEFAULTS)
  for (const [input, size] of [[5, 90], [90, 90], [160, 160], [320, 320], [900, 320]]) {
    assert.equal(R.normalizeUiPrefs({ posterSize: input }).posterSize, size)
    assert.equal(uiPrefs.write(memoryStore(), { posterSize: input }).posterSize, size)
  }
  for (const mode of ['pinned', 'hover', 'hidden', 'other']) {
    const expected = mode === 'other' ? 'pinned' : mode
    assert.equal(R.normalizeUiPrefs({ sidebarMode: mode }).sidebarMode, expected)
  }
})

function fakeStorage(initial) {
  const map = new Map(Object.entries(initial || {}))
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => { map.set(k, String(v)) }, map }
}

test('renderer: the first paint reads the synchronous cache; the store then wins and refreshes the cache', async () => {
  const R = await loadRenderer()
  const storage = fakeStorage({ 'beebo.uiPrefs': JSON.stringify({ sidebarMode: 'hidden', posterSize: 120, showPosterIcons: false }) })
  const api = { uiPrefsGet: async () => ({ sidebarMode: 'hover', posterSize: 220, showPosterIcons: true, showPosterTitles: false }) }
  const prefs = R.createUiPrefs({ storage, api })
  assert.deepEqual(prefs.cached(), { sidebarMode: 'hidden', posterSize: 120, showPosterIcons: false, showPosterTitles: true })
  const loaded = await prefs.load()
  assert.deepEqual(loaded, { sidebarMode: 'hover', posterSize: 220, showPosterIcons: true, showPosterTitles: false })
  assert.deepEqual(JSON.parse(storage.map.get('beebo.uiPrefs')), loaded)
})

test('renderer: saving writes the cache immediately and sends only what changed over IPC', async () => {
  const R = await loadRenderer()
  const storage = fakeStorage()
  const sent = []
  const prefs = R.createUiPrefs({ storage, api: { uiPrefsSet: async (partial) => { sent.push(partial) } } })
  const after = await prefs.save({ sidebarMode: 'hidden' })
  assert.equal(after.sidebarMode, 'hidden')
  assert.equal(JSON.parse(storage.map.get('beebo.uiPrefs')).sidebarMode, 'hidden')
  assert.deepEqual(sent, [{ sidebarMode: 'hidden' }])
  await prefs.save({ posterSize: 300 })
  assert.equal(prefs.cached().sidebarMode, 'hidden', 'earlier choices survive a later save')
  assert.deepEqual(sent[1], { posterSize: 300 })
})

test('renderer: without IPC, storage or a working store it still returns usable values', async () => {
  const R = await loadRenderer()
  assert.deepEqual(await R.createUiPrefs().load(), DEFAULTS)
  const broken = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
  const failing = { uiPrefsGet: async () => { throw new Error('ipc down') }, uiPrefsSet: async () => { throw new Error('ipc down') } }
  const prefs = R.createUiPrefs({ storage: broken, api: failing })
  assert.deepEqual(await prefs.load(), DEFAULTS)
  assert.equal((await prefs.save({ sidebarMode: 'hover' })).sidebarMode, 'hover')
  const junk = R.createUiPrefs({ storage: fakeStorage({ 'beebo.uiPrefs': '{not json' }) })
  assert.deepEqual(junk.cached(), DEFAULTS)
})

// The posters-only look is one attribute on <html> plus one shared class. If a new badge is
// drawn on a poster without the class, it would stay visible with icons switched off.
function functionBody(source, marker) {
  const start = source.indexOf(marker)
  assert.ok(start >= 0, marker)
  const next = source.indexOf('\n  const ', start + marker.length)
  return source.slice(start, next > 0 ? next : undefined)
}

test('every button and badge drawn over a poster carries the shared poster-overlay class', () => {
  const movies = functionBody(read('src/components/Movies.jsx'), 'const movieCard = (m, anchorId) => {')
  const buttons = movies.match(/<button\b[\s\S]*?>/g) || []
  assert.ok(buttons.length >= 5, 'the five action buttons')
  for (const tag of buttons) assert.match(tag, /className="poster-overlay"/, tag.slice(0, 80))
  assert.match(movies, /<div\s+className="poster-overlay"/, 'the description overlay')
  const art = read('src/components/LibraryControls.jsx')
  assert.match(art, /className="poster-overlay poster-badge"/)
  assert.match(art, /className="poster-overlay poster-ribbon"/)
  assert.match(art, /className="poster-overlay">\{placeholderExtra\}/)
  const fresh = read('src/components/NewItems.jsx')
  assert.match(fresh, /poster-overlay poster-badge/)
  assert.match(fresh, /poster-overlay poster-ribbon/)
  const tv = functionBody(read('src/components/TVShows.jsx'), 'const showCard = (s, anchorId) => {')
  assert.doesNotMatch(tv, /position: 'absolute'/, 'TV cards draw their overlays through PosterArt')
})

test('all three poster card kinds are keyboard-focusable and named, via one shared helper', () => {
  for (const file of ['Movies', 'TVShows', 'NewItems']) {
    assert.match(read(`src/components/${file}.jsx`), /posterCardProps\(/, file)
  }
  const css = read('src/styles.css')
  assert.match(css, /\[data-poster-icons='off'\] \.poster-overlay \{ display: none!important; \}/)
  assert.match(css, /\[data-poster-titles='off'\] \.poster-card \.meta \{ display: none; \}/)
})
