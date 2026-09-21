'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { registerHouseholdCatalogIpc } = require('../electron/householdCatalogIpc')
const { CAPABILITY } = require('../electron/householdCatalog')

async function fixture(t, enabled = true) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'beebo-household-ipc-'))
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(base)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(base).startsWith('beebo-household-ipc-'))
    await fs.rm(base, { recursive: true, force: true })
  })
  const root = path.join(base, 'Movies'), privateRoot = path.join(base, 'vault'); await fs.mkdir(root); await fs.mkdir(privateRoot)
  await fs.writeFile(path.join(root, 'Our.Sample.Movie.mp4'), 'fixture')
  const settings = { [CAPABILITY]: enabled, privateVaultDir: privateRoot }, writes = [], handlers = new Map(), frame = {}
  const window = { isDestroyed: () => false, webContents: { mainFrame: frame } }, event = { sender: window.webContents, senderFrame: frame }
  let dialogs = 0
  const catalog = registerHouseholdCatalogIpc({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    dialog: { showOpenDialog: async () => { dialogs++; return { canceled: false, filePaths: [root] } } },
    app: { getPath: name => path.join(base, name) }, getMainWindow: () => window,
    store: { get: key => settings[key], set: (key, value) => { settings[key] = structuredClone(value); writes.push(key) } }
  })
  return { root, privateRoot, catalog, settings, writes, handlers, event, dialogs: () => dialogs, call: (name, args, from = event) => handlers.get('householdLibrary:' + name)(from, args) }
}

test('every household IPC route requires the main desktop frame and exposes no remote trust hooks', async t => {
  const f = await fixture(t)
  for (const handler of f.handlers.values()) {
    assert.equal((await handler({ sender: {}, senderFrame: {} }, {})).error, 'forbidden')
    assert.equal((await handler({ sender: f.event.sender, senderFrame: {} }, {})).error, 'forbidden')
  }
  assert.equal(f.dialogs(), 0); assert.deepEqual(f.writes, [])
  assert.equal(f.handlers.has('householdLibrary:importSnapshot'), false)
  assert.equal(f.handlers.has('householdLibrary:recordHeartbeat'), false)
})

test('disabled pilot does not open a picker, write an identity or scan even from the main window', async t => {
  const f = await fixture(t, false)
  assert.equal((await f.call('info')).enabled, false)
  for (const name of ['configureLocalHost', 'pickSource', 'addSource', 'removeSource', 'scanSource', 'cancelScan', 'scanStatus', 'catalog']) {
    assert.equal((await f.call(name, { folder: f.root, kind: 'movies', consent: true })).error, 'capability_disabled')
  }
  assert.equal(f.dialogs(), 0); assert.deepEqual(f.writes, [])
})

test('approved local registration needs consent and explicit scan; files remain unchanged', async t => {
  const f = await fixture(t)
  assert.equal((await f.call('pickSource')).folder, f.root)
  assert.equal((await f.call('addSource', { folder: f.root, kind: 'movies' })).error, 'consent_required')
  assert.equal((await f.call('addSource', { folder: f.privateRoot, kind: 'movies', consent: true })).error, 'private_folder')
  const added = await f.call('addSource', { folder: f.root, kind: 'movies', consent: true })
  assert.equal(added.ok, true); assert.equal((await f.call('catalog')).total, 0)
  assert.equal((await f.call('scanSource', { sourceId: added.source.sourceId })).ok, true)
  await f.catalog.whenIdle()
  assert.equal((await f.call('scanStatus')).state, 'complete'); assert.equal((await f.call('catalog')).total, 1)
  assert.equal((await f.call('removeSource', { sourceId: added.source.sourceId })).ok, true)
  assert.equal(await fs.readFile(path.join(f.root, 'Our.Sample.Movie.mp4'), 'utf8'), 'fixture')
})

test('revoking the pilot hides saved metadata and blocks further local operations', async t => {
  const f = await fixture(t)
  const added = await f.call('addSource', { folder: f.root, kind: 'movies', consent: true })
  await f.call('scanSource', { sourceId: added.source.sourceId }); await f.catalog.whenIdle()
  assert.equal((await f.call('catalog')).total, 1)
  f.settings[CAPABILITY] = false
  assert.equal((await f.call('catalog')).error, 'capability_disabled')
  assert.equal((await f.call('info')).host, undefined)
  assert.equal((await f.call('scanSource', { sourceId: added.source.sourceId })).error, 'capability_disabled')
  assert.equal(await fs.readFile(path.join(f.root, 'Our.Sample.Movie.mp4'), 'utf8'), 'fixture')
})
