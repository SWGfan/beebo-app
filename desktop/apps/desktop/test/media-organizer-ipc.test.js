'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { registerMediaOrganizerIpc } = require('../electron/mediaOrganizerIpc')
const { initialize, defaults } = require('../electron/storageDefaults')
async function fixture(t, matching = false) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'beebo-organizer-ipc-test-'))
  t.after(async () => { assert.equal(path.dirname(path.resolve(base)), path.resolve(os.tmpdir())); assert.ok(path.basename(base).startsWith('beebo-organizer-ipc-test-')); await fs.rm(base, { recursive: true, force: true }) })
  const root = path.join(base, 'source'), destination = path.join(base, 'organized'), privateDir = path.join(root, 'vault')
  await fs.mkdir(privateDir, { recursive: true })
  await fs.writeFile(path.join(root, 'Sample.Movie.2020.mp4'), 'demo-file')
  await fs.writeFile(path.join(privateDir, 'private-photo.jpg'), 'private-sample')
  const settings = { privateVaultDir: privateDir, tmdbApiKey: matching ? 'fixture-key-not-real' : undefined }
  const handlers = new Map(), opened = [], requests = [], frame = {}
  const window = { isDestroyed: () => false, webContents: { mainFrame: frame } }
  const event = { sender: window.webContents, senderFrame: frame }
  const organizer = registerMediaOrganizerIpc({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [root] }) },
    shell: { openPath: async p => { opened.push(p); return '' } },
    store: { get: key => settings[key] }, app: { getPath: key => path.join(base, key) }, getMainWindow: () => window,
    listDrives: async () => [root],
    fetchImpl: async (url, options) => { requests.push({ url, signal: options.signal }); return { ok: true, json: async () => ({ results: [{ id: 123, title: 'Sample Movie', release_date: '2020-01-01', poster_path: '/sample.jpg', vote_count: 100 }] }) } }
  })
  return { root, destination, privateDir, settings, organizer, opened, requests, event, call: (name, args, caller = event) => handlers.get('organizer:' + name)(caller, args) }
}
test('organizer IPC is restricted to the main desktop frame', async t => {
  const f = await fixture(t)
  assert.equal((await f.call('info')).ok, true)
  assert.equal((await f.call('info', {}, { sender: {}, senderFrame: {} })).error, 'forbidden')
  assert.equal((await f.call('scan', { roots: [f.root] }, { sender: f.event.sender, senderFrame: {} })).error, 'forbidden')
  assert.equal(f.organizer.status().state, 'idle'); assert.deepEqual((await f.call('drives')).roots, [f.root])
})
test('private folders are excluded even when managed-folder skipping is disabled', async t => {
  const f = await fixture(t)
  assert.equal((await f.call('scan', { roots: [f.root], kinds: ['video', 'photo'], excludeManaged: false })).ok, true)
  await f.organizer.whenIdle(); assert.equal((await f.call('status')).total, 1)
  assert.equal((await f.call('plan', { destination: f.privateDir })).error, 'protected_destination')
  assert.equal((await f.call('plan', { destination: path.join(f.privateDir, 'child') })).error, 'protected_destination')
  assert.equal((await f.call('openDestination', { path: f.root })).error, 'not_ready'); assert.equal(f.opened.length, 0)
})
test('TMDB requests require opt-in and return only confident poster matches', async t => {
  const f = await fixture(t, true)
  await f.call('scan', { roots: [f.root], kinds: ['video'], matchPosters: false }); await f.organizer.whenIdle()
  assert.equal(f.requests.length, 0)
  await f.call('scan', { roots: [f.root], kinds: ['video'], matchPosters: true }); await f.organizer.whenIdle()
  assert.ok(f.requests.length > 0)
  assert.ok(f.requests.every(r => new URL(r.url).searchParams.get('query') === 'Sample Movie'))
  assert.ok(f.requests.every(r => r.signal instanceof AbortSignal))
  assert.equal((await f.call('status')).items[0].match.tmdbId, 123)
  const plan = await f.call('plan', { destination: f.destination, matchedOnly: true }); assert.equal(plan.ok, true, plan.message)
  assert.equal((await f.call('preview', { planId: plan.planId })).items.length, 1)
  assert.equal((await f.call('execute', { planId: plan.planId })).ok, true); await f.organizer.whenIdle()
  assert.equal(f.organizer.status().errors, 0)
  assert.equal((await f.call('openDestination', { path: f.root })).ok, true); assert.deepEqual(f.opened, [f.destination])
})
test('fresh defaults use C:\\Beebo and existing installations retain every configured path', () => {
  const settings = {}, store = { get: key => settings[key], set: (key, value) => { settings[key] = value } }
  initialize(store, { platform: 'win32', createDirectories: false })
  assert.equal(defaults('win32').root, 'C:\\Beebo'); assert.equal(settings.moviesDir, 'C:\\Beebo\\Movies')
  assert.equal(settings.privateVaultDir, 'C:\\Beebo\\Private Folders')
  const existing = { storageDefaultsVersion: 1, moviesDir: 'D:\\Old Movies', inboxDir: 'D:\\Incoming', privateVaultDir: 'C:\\BeeboEntertainment\\Private Folders' }, before = { ...existing }
  initialize({ get: key => existing[key], set: (key, value) => { existing[key] = value } }, { platform: 'win32', createDirectories: false })
  assert.deepEqual(existing, before)
})


test('generated Movies, Photos and audit subfolders cannot write into protected storage', async t => {
  for (const child of ['Movies', 'Photos', '.beebo-organizer']) {
    const f = await fixture(t)
    await fs.writeFile(path.join(f.root, 'Photo.jpg'), 'public-photo')
    f.settings.privateVaultDir = path.join(f.destination, child)
    assert.equal((await f.call('scan', { roots: [f.root], kinds: ['video', 'photo'] })).ok, true)
    await f.organizer.whenIdle()
    const result = await f.call('plan', { destination: f.destination, operation: 'move' })
    assert.equal(result.ok, false, child)
    assert.equal(result.error, 'protected_destination', child)
    assert.equal(await fs.access(f.destination).then(() => true, () => false), false)
    assert.equal(await fs.readFile(path.join(f.root, 'Sample.Movie.2020.mp4'), 'utf8'), 'demo-file')
    assert.equal(await fs.readFile(path.join(f.root, 'Photo.jpg'), 'utf8'), 'public-photo')
  }
})

test('execution rechecks current source protections before any filesystem writes', async t => {
  const f = await fixture(t)
  await f.call('scan', { roots: [f.root], kinds: ['video'] }); await f.organizer.whenIdle()
  const plan = await f.call('plan', { destination: f.destination, operation: 'move' })
  assert.equal(plan.ok, true)
  f.settings.privateVaultDir = f.root
  const result = await f.call('execute', { planId: plan.planId })
  assert.equal(result.ok, false); assert.equal(result.error, 'protected_source')
  assert.equal(await fs.access(f.destination).then(() => true, () => false), false)
  assert.equal(await fs.readFile(path.join(f.root, 'Sample.Movie.2020.mp4'), 'utf8'), 'demo-file')
  assert.equal((await f.call('execute', { planId: plan.planId })).error, 'invalid_plan')
})

test('execution rechecks generated destination protections after review', async t => {
  const f = await fixture(t)
  await f.call('scan', { roots: [f.root], kinds: ['video'] }); await f.organizer.whenIdle()
  const plan = await f.call('plan', { destination: f.destination, operation: 'move' })
  assert.equal(plan.ok, true)
  f.settings.privateVaultDir = path.join(f.destination, 'Movies')
  const result = await f.call('execute', { planId: plan.planId })
  assert.equal(result.ok, false); assert.equal(result.error, 'protected_destination')
  assert.equal(await fs.access(f.destination).then(() => true, () => false), false)
  assert.equal(await fs.readFile(path.join(f.root, 'Sample.Movie.2020.mp4'), 'utf8'), 'demo-file')
})
