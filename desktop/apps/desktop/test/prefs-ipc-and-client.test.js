'use strict'
// The desktop app's side: the IPC dispatcher (main process) and the renderer helpers (profileApply.js), plus a
// contract check on the Appearance editor's source (keyboard-accessible reordering, live preview, contrast fix).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const ipc = require('../electron/prefsIpc')
const prefs = require('../electron/prefsStore')

const appRoot = path.resolve(__dirname, '..')
const load = () => import(pathToFileURL(path.join(appRoot, 'src', 'lib', 'profileApply.js')).href)
const read = (rel) => fs.readFileSync(path.join(appRoot, rel), 'utf8')

const makeStore = (users) => {
  const data = { authUsers: users }
  return { data, get: (k) => data[k], set: (k, v) => { data[k] = JSON.parse(JSON.stringify(v)) }, delete: (k) => { delete data[k] } }
}
const OWNER = [{ id: 'owner', isAdmin: true, status: 'approved' }, { id: 'kid', status: 'approved' }]
const io = (file) => ({
  saved: [],
  async saveText(name, text) { this.saved.push({ name, text }); return { ok: true, path: '/x/' + name } },
  async openText() { return file === null ? { ok: false, canceled: true } : { ok: true, name: 'in.beebo-profile', text: file } }
})

// ---- IPC ---------------------------------------------------------------------------------------------------------

test('IPC acts only on the owner\'s profile; with no owner it refuses; it cannot name another person', async () => {
  const none = makeStore([])
  assert.equal((await ipc.call(none, io(), 'get')).error, 'no_owner')
  const store = makeStore(OWNER)
  assert.equal(ipc.ownerId(store), 'owner')
  const patched = await ipc.call(store, io(), 'patch', { layout: { density: 'compact' }, userId: 'kid' })
  assert.equal(patched.ok, false, 'an extra userId is not a known section')
  const ok = await ipc.call(store, io(), 'patch', { layout: { density: 'compact' } })
  assert.equal(ok.ok, true)
  assert.deepEqual(Object.keys(store.data.userPrefs), ['owner'])
  assert.equal(prefs.describe(store, 'kid').effective.layout.density, 'comfortable')
  const got = await ipc.call(store, io(), 'get')
  assert.equal(got.effective.layout.density, 'compact')
  assert.ok(got.render.attrs['data-density'])
})

test('IPC ops: unknown op, bad arguments, reset, pack, preview and theme check', async () => {
  const store = makeStore(OWNER)
  assert.equal((await ipc.call(store, io(), 'rm -rf')).error, 'unknown_op')
  assert.equal((await ipc.call(store, io(), 'pack', { kind: 'nope', id: 'x' })).ok, false)
  assert.equal((await ipc.call(store, io(), 'pack', 'string')).ok, false)
  assert.equal((await ipc.call(store, io(), 'pack', { kind: 'layout', id: 'beebo.compact-library' })).ok, true)
  assert.equal((await ipc.call(store, io(), 'get')).effective.layout.density, 'compact')
  assert.equal((await ipc.call(store, io(), 'preview', { layout: { density: 'spacious' } })).spec.attrs['data-density'], 'spacious')
  assert.equal((await ipc.call(store, io(), 'get')).effective.layout.density, 'compact', 'preview did not save')
  const chk = await ipc.call(store, io(), 'themeCheck', { preset: 'graphite', custom: { '--text': '#6b6c72' } })
  assert.equal(chk.ok, true)
  assert.equal(chk.fixable, true)
  assert.equal((await ipc.call(store, io(), 'reset', { section: 'all' })).ok, true)
  assert.equal((await ipc.call(store, io(), 'get')).effective.layout.density, 'comfortable')
})

test('IPC export writes a .beebo-profile through the save dialog; import previews then applies; hostile files are refused', async () => {
  const store = makeStore(OWNER)
  await ipc.call(store, io(), 'patch', { layout: { density: 'spacious' }, access: { largeText: true } })
  const sink = io()
  const exported = await ipc.call(store, sink, 'exportFile')
  assert.equal(exported.ok, true)
  assert.equal(sink.saved[0].name, 'beebo.beebo-profile')
  const file = JSON.parse(sink.saved[0].text)
  assert.equal(file.format, 'beebo-profile')

  const other = makeStore(OWNER)
  const picked = await ipc.call(other, io(sink.saved[0].text), 'importPick')
  assert.equal(picked.ok, true, JSON.stringify(picked))
  assert.equal(picked.kind, 'profile')
  assert.ok(picked.diff.length > 0)
  assert.equal(other.data.userPrefs, undefined, 'picking a file previews only')
  const applied = await ipc.call(other, io(), 'importApply', { file: picked.file })
  assert.equal(applied.ok, true)
  assert.deepEqual(prefs.describe(other, 'owner').effective, prefs.describe(store, 'owner').effective)

  const canceled = await ipc.call(other, io(null), 'importPick')
  assert.deepEqual([canceled.ok, canceled.canceled], [false, true])
  const evil = fs.readFileSync(path.join(__dirname, 'fixtures', 'packs', 'malicious', 'theme-remote-url.json'), 'utf8')
  const refused = await ipc.call(other, io(evil), 'importPick')
  assert.equal(refused.ok, false)
  const notJson = await ipc.call(other, io('{oops'), 'importPick')
  assert.equal(notJson.ok, false)
  assert.equal((await ipc.call(other, io(), 'importApply', { file: 'x' })).ok, false)
})

test('the IPC bridge is one channel and the preload exposes one function for it', () => {
  assert.match(read('electron/preload.js'), /prefsCall: \(op, arg\) => ipcRenderer\.invoke\('prefs:call', op, arg\)/)
  assert.match(read('electron/main.js'), /require\('\.\/prefsIpc'\)\.register\(/)
  assert.match(read('electron/prefsIpc.js'), /ipcMain\.handle\('prefs:call'/)
})

// ---- renderer helpers --------------------------------------------------------------------------------------------

test('applyRenderSpec writes only the attributes and variables it owns, and clears them when the spec omits them', async () => {
  const { applyRenderSpec } = await load()
  const attrs = { 'data-poster-density': 'compact' } // someone else's attribute on <html>
  const style = { 'color-scheme': 'dark' }
  const root = {
    setAttribute: (k, v) => { attrs[k] = v }, removeAttribute: (k) => { delete attrs[k] },
    style: { setProperty: (k, v) => { style[k] = v }, removeProperty: (k) => { delete style[k] } }
  }
  applyRenderSpec({ attrs: { 'data-density': 'compact', 'data-reduce-motion': '1', 'onclick': 'x', 'data-large-text': 'a"b' }, vars: { '--ui-font-scale': '1.25', '--evil': 'red', '--radius-card': '5px;color:red' } }, root)
  assert.equal(attrs['data-density'], 'compact')
  assert.equal(attrs['data-reduce-motion'], '1')
  assert.equal(attrs.onclick, undefined)
  assert.equal(attrs['data-large-text'], undefined, 'an unsafe value is not written')
  assert.equal(attrs['data-poster-density'], 'compact', 'other code\'s attribute is left alone')
  assert.equal(style['--ui-font-scale'], '1.25')
  assert.equal(style['--evil'], undefined)
  assert.equal(style['--radius-card'], undefined)
  assert.equal(style['color-scheme'], 'dark')
  applyRenderSpec({ attrs: {}, vars: {} }, root)
  assert.equal(attrs['data-density'], undefined)
  assert.equal(style['--ui-font-scale'], undefined)
  applyRenderSpec(null, root)
  applyRenderSpec({}, null)
})

test('orderNav: profile order first, hidden removed, locked kept, group headings follow the items', async () => {
  const { orderNav } = await load()
  const tabs = [
    { id: 'getstarted', label: 'Get Started', group: 'Start here' },
    { id: 'movies', label: 'Movies', group: 'Library' },
    { id: 'tvshows', label: 'TV Shows' },
    { id: 'upload', label: 'Upload', group: 'Manage' },
    { id: 'admin', label: 'Admin' },
    { id: 'settings', label: 'Settings' }
  ]
  assert.deepEqual(orderNav(tabs, null).map((t) => t.id), tabs.map((t) => t.id))
  assert.deepEqual(orderNav(tabs, { order: [], hidden: [] }).map((t) => t.group), ['Start here', 'Library', undefined, 'Manage', undefined, undefined])
  const out = orderNav(tabs, { order: ['tvshows', 'movies', 'nonsense', 'tvshows'], hidden: ['getstarted', 'settings', 'admin'] })
  assert.deepEqual(out.map((t) => t.id), ['tvshows', 'movies', 'upload', 'settings'], 'settings is locked so it is never hidden')
  assert.deepEqual(out.map((t) => t.group), ['Library', undefined, 'Manage', undefined], 'a heading appears once, before the first item of its group')
  assert.equal(orderNav(tabs, { order: 'x', hidden: 5 }).length, tabs.length, 'garbage in the profile is ignored')
})

test('moveEntry, moveTo and reorderWithin: pure, in-bounds, and a filtered view only permutes its own slots', async () => {
  const { moveEntry, moveTo, reorderWithin, fullOrder, fullShelves } = await load()
  const list = ['a', 'b', 'c', 'd']
  assert.deepEqual(moveEntry(list, 1, -1), ['b', 'a', 'c', 'd'])
  assert.deepEqual(moveEntry(list, 1, 1), ['a', 'c', 'b', 'd'])
  assert.equal(moveEntry(list, 0, -1), list)
  assert.equal(moveEntry(list, 3, 1), list)
  assert.deepEqual(list, ['a', 'b', 'c', 'd'], 'the input is never mutated')
  assert.deepEqual(moveTo(list, 0, 3), ['b', 'c', 'd', 'a'])
  assert.equal(moveTo(list, 2, 2), list)
  assert.equal(moveTo(list, -1, 2), list)
  const full = ['a', 'x', 'b', 'y', 'c']
  assert.deepEqual(reorderWithin(full, ['a', 'b', 'c'], 2, 0), ['c', 'x', 'a', 'y', 'b'], 'x and y (not shown) keep their slots')
  assert.equal(reorderWithin(full, ['a', 'b', 'c'], 0, 0), full)
  assert.deepEqual(fullOrder(['a', 'b', 'c'], ['c', 'zzz']), ['c', 'a', 'b'])
  assert.deepEqual(fullShelves(['s1', 's2', 's3'], [{ id: 's3', on: false }, { id: 'bogus', on: true }]), [{ id: 's3', on: false }, { id: 's1', on: true }, { id: 's2', on: true }])
})

test('first-paint cache: read what was written, survive private mode and junk', async () => {
  const { readCachedSpec, writeCachedSpec } = await load()
  const mem = {}
  const storage = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = v } }
  assert.equal(readCachedSpec(storage), null)
  writeCachedSpec(storage, { attrs: { 'data-density': 'compact' }, vars: {}, nav: { order: [], hidden: ['x'] } })
  assert.deepEqual(readCachedSpec(storage).attrs, { 'data-density': 'compact' })
  assert.deepEqual(readCachedSpec(storage).nav.hidden, ['x'])
  mem['beebo.profileSpec'] = '{bad json'
  assert.equal(readCachedSpec(storage), null)
  assert.doesNotThrow(() => writeCachedSpec({ setItem() { throw new Error('quota') } }, {}))
  assert.equal(readCachedSpec(null), null)
})

// ---- the editor's source contract -----------------------------------------------------------------------------------

test('the Appearance editor: keyboard reordering, live announcements, live preview, contrast fix, import preview, reset', () => {
  const src = read('src/components/AppearanceSettings.jsx')
  assert.match(src, /aria-label=\{t\('appearance\.moveUp'/, 'a labelled Move up button')
  assert.match(src, /aria-label=\{t\('appearance\.moveDown'/, 'a labelled Move down button')
  assert.match(src, /e\.altKey/, 'Alt+Arrow moves a row from the keyboard')
  assert.match(src, /aria-live="polite"/, 'moves are announced')
  assert.match(src, /draggable/, 'dragging is offered on top of the buttons')
  assert.match(src, /call\('preview'/, 'changes preview live through the main process validator')
  assert.match(src, /themeCheck/)
  assert.match(src, /t\('appearance\.fixAuto'\)/)
  assert.match(src, /call\('importPick'\)/)
  assert.match(src, /t\('appearance\.reset'\)/)
  assert.match(src, /appearance\.motion\./)
  assert.match(src, /appearance\.largeText/)
  assert.ok(!/>\s*[A-Z][a-z]+ [a-z]+[^<{]*</.test(src), 'no hard-coded English sentence between tags: every visible string goes through t()')
  assert.ok(!/dangerouslySetInnerHTML|innerHTML|eval\(/.test(src), 'no HTML injection path in the editor')
  assert.match(read('src/components/Settings.jsx'), /<AppearanceSettings \/>/)
  assert.match(read('src/App.jsx'), /orderNav\(TABS, sidebarPrefs\)/)
  assert.match(read('src/main.jsx'), /bootProfile\(\)/)
})

test('desktop stylesheet: rules exist for every attribute the spec can set, and none for anything else', () => {
  const css = read('src/profile.css')
  for (const attr of ['data-density', 'data-card-style', 'data-poster-aspect', 'data-radius', 'data-font-scale', 'data-reduce-motion']) assert.ok(css.includes(attr), attr)
  assert.ok(!/@import|url\(/.test(css))
})
