'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { createHouseholdCatalog, presentation, connectionGuidance, CAPABILITY, STORE_KEY, HOST_KEY, HEARTBEAT_MS } = require('../electron/householdCatalog')

async function fixture(t, options = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'beebo-household-catalog-'))
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(base)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(base).startsWith('beebo-household-catalog-'))
    await fs.rm(base, { recursive: true, force: true })
  })
  const root = path.join(base, 'Movies'), privateRoot = path.join(root, 'Private')
  await fs.mkdir(privateRoot, { recursive: true })
  const settings = { [CAPABILITY]: true }, writes = []
  const store = { get: key => settings[key], set: (key, value) => { settings[key] = structuredClone(value); writes.push(key) } }
  let clock = 1800000000000, householdId = 'household-test-one', protectedRoots = [privateRoot]
  const dependencies = { store, now: () => clock, getHouseholdId: () => householdId, getExcludedRoots: () => protectedRoots, ...options }
  const catalog = createHouseholdCatalog(dependencies)
  const put = async (name, content = 'fixture movie bytes') => { const target = path.join(root, name); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, content); return target }
  const add = async args => (await catalog.addSource({ folder: root, name: 'Family movies', kind: 'movies', consent: true, ...args })).source
  const scan = async sourceId => { catalog.scanSource({ sourceId }); await catalog.whenIdle(); return catalog.scanStatus() }
  return { base, root, privateRoot, store, settings, writes, catalog, dependencies, put, add, scan, advance: value => { clock += value }, setHousehold: value => { householdId = value }, protect: roots => { protectedRoots = roots } }
}
function remoteSnapshot(f, extra = {}) {
  return { version: 1, householdId: 'household-test-one', generatedAt: 1800000000000, host: { hostId: crypto.randomUUID(), label: 'Travelling laptop' },
    sources: [{ sourceId: crypto.randomUUID(), kind: 'movies', label: 'Travel movies', lastScanAt: 1800000000000, folder: 'C:\\secret-path', items: [{ id: crypto.randomBytes(32).toString('hex'), kind: 'movie', title: 'Our holiday', bytes: 42, year: 2024, modifiedAt: 1790000000000, filePath: 'C:\\secret-file.mp4', token: 'never-copy-me' }] }], ...extra }
}
const trusted = async ({ hostId, householdId, context }) => context === 'verified-connector' ? { hostId, householdId } : false

test('default-off construction and info never scan or initialize a personal catalogue', async t => {
  const f = await fixture(t); delete f.settings[CAPABILITY]
  const catalog = createHouseholdCatalog(f.dependencies)
  assert.equal(catalog.info().enabled, false)
  assert.deepEqual(f.writes, [])
  await assert.rejects(catalog.addSource({ folder: f.root, kind: 'movies', consent: true }), { code: 'capability_disabled' })
  assert.throws(() => catalog.scanSource({ sourceId: crypto.randomUUID() }), { code: 'capability_disabled' })
  assert.equal(f.settings[HOST_KEY], undefined)
})

test('local host and source identities persist; registering a folder does not scan it', async t => {
  const f = await fixture(t); await f.put('Sample.Movie.2024.mp4')
  const source = await f.add(), first = f.catalog.info()
  assert.equal(f.catalog.catalog().total, 0)
  assert.equal(source.availability, 'unknown'); assert.equal(source.canPlay, false)
  const reopened = createHouseholdCatalog(f.dependencies)
  assert.equal(reopened.info().host.hostId, first.host.hostId)
  assert.equal(reopened.catalog().hosts[0].sources[0].sourceId, source.sourceId)
  await assert.rejects(f.add({ consent: false }), { code: 'consent_required' })
  await assert.rejects(f.add(), { code: 'duplicate_folder' })
})

test('manual metadata scan is read-only, bounded to video sources, and exports no paths', async t => {
  const f = await fixture(t)
  const original = await f.put('Sample.Movie.2024.mp4'), before = await fs.stat(original)
  await f.put('nested/Another.2020.mkv'); await f.put('picture.jpg'); await f.put('Private/Secret.Title.mp4')
  await f.put('AppData/Hidden.Title.mp4'); await f.put('Movie.converting.mp4')
  const source = await f.add(); assert.equal((await f.scan(source.sourceId)).state, 'complete')
  const view = f.catalog.catalog()
  assert.equal(view.total, 2); assert.ok(view.items.every(item => item.sources[0].availability === 'available'))
  assert.equal(view.playbackSupported, false)
  const snapshot = f.catalog.exportSnapshot(), serialized = JSON.stringify(snapshot)
  assert.equal(snapshot.sources[0].items.length, 2)
  for (const secret of [f.root, 'relativePath', 'Secret.Title', 'Hidden.Title', 'fileName']) assert.ok(!serialized.includes(secret), secret)
  assert.equal(await fs.readFile(original, 'utf8'), 'fixture movie bytes')
  assert.equal((await fs.stat(original)).mtimeMs, before.mtimeMs)
  const ids = view.items.map(item => item.id).sort(); await f.scan(source.sourceId)
  assert.deepEqual(f.catalog.catalog().items.map(item => item.id).sort(), ids)
  const reopened = createHouseholdCatalog(f.dependencies)
  assert.equal(reopened.catalog().total, 2)
  assert.ok(reopened.catalog().items.every(item => item.sources[0].availability === 'unknown'))
})

test('private roots and junctions cannot become sources, and newly protected titles disappear', async t => {
  const f = await fixture(t)
  await assert.rejects(f.add({ folder: f.privateRoot }), { code: 'private_folder' })
  const junction = path.join(f.base, 'linked')
  await fs.symlink(f.root, junction, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(f.add({ folder: junction }), { code: 'linked_folder' })
  const secret = await f.put('nested/Secret.2024.mp4'), source = await f.add()
  await fs.symlink(f.privateRoot, path.join(f.root, 'private-link'), process.platform === 'win32' ? 'junction' : 'dir')
  await f.put('Private/Encrypted.Folder.Video.mp4')
  await f.scan(source.sourceId); assert.equal(f.catalog.catalog().total, 1)
  f.protect([f.privateRoot, path.dirname(secret)])
  assert.equal(f.catalog.catalog().total, 0)
  assert.equal(f.catalog.exportSnapshot().sources[0].items.length, 0)
  f.protect([f.root])
  assert.equal(f.catalog.catalog().hosts[0].sources.length, 0)
  assert.throws(() => f.catalog.scanSource({ sourceId: source.sourceId }), { code: 'private_folder' })
})

test('TV metadata identifies episode numbers without fetching third-party artwork', async t => {
  const f = await fixture(t); await f.put('Sample.Show.S02E03.mp4')
  const source = await f.add({ kind: 'tv' }); await f.scan(source.sourceId)
  const item = f.catalog.catalog().items[0]
  assert.equal(item.kind, 'episode'); assert.match(item.title, /S02E03/)
  assert.equal(item.seriesTitle, 'Sample Show'); assert.equal(item.season, 2); assert.equal(item.episode, 3)
})

test('cancelled, missing and oversized scans retain the last complete catalogue', async t => {
  const f = await fixture(t, { maxItems: 1 }); const original = await f.put('One.mp4'), source = await f.add()
  await f.scan(source.sourceId); assert.equal(f.catalog.catalog().total, 1)
  await f.put('Two.mp4')
  assert.equal((await f.scan(source.sourceId)).error, 'scan_limit'); assert.equal(f.catalog.catalog().total, 1)
  f.catalog.scanSource({ sourceId: source.sourceId }); assert.equal(f.catalog.cancelScan().ok, true)
  await f.catalog.whenIdle(); assert.equal(f.catalog.scanStatus().state, 'cancelled'); assert.equal(f.catalog.catalog().total, 1)
  await fs.rename(f.root, path.join(f.base, 'offline-drive'))
  assert.equal((await f.scan(source.sourceId)).state, 'failed')
  assert.equal(f.catalog.catalog().items[0].sources[0].availability, 'missing')
  assert.equal(await fs.readFile(path.join(f.base, 'offline-drive', path.basename(original)), 'utf8'), 'fixture movie bytes')
})

test('removing a source removes only its catalogue and never its files', async t => {
  const f = await fixture(t); const original = await f.put('Keep.mp4'), source = await f.add(); await f.scan(source.sourceId)
  assert.equal(f.catalog.removeSource({ sourceId: source.sourceId }).ok, true)
  assert.equal(f.catalog.catalog().total, 0); assert.equal(await fs.readFile(original, 'utf8'), 'fixture movie bytes')
})

test('remote imports default denied and require verified exact household membership', async t => {
  const f = await fixture(t), snapshot = remoteSnapshot(f)
  await assert.rejects(f.catalog.importSnapshot(snapshot, 'verified-connector'), { code: 'untrusted_host' })
  const permitted = createHouseholdCatalog({ ...f.dependencies, authorizeRemoteHost: trusted })
  await assert.rejects(permitted.importSnapshot(snapshot, 'renderer-says-trusted'), { code: 'untrusted_host' })
  await assert.rejects(permitted.importSnapshot({ ...snapshot, householdId: 'another-household' }, 'verified-connector'), { code: 'invalid_snapshot' })
  assert.equal((await permitted.importSnapshot(snapshot, 'verified-connector')).ok, true)
  const persisted = JSON.stringify(f.settings[STORE_KEY])
  assert.ok(!persisted.includes('secret-path')); assert.ok(!persisted.includes('secret-file')); assert.ok(!persisted.includes('never-copy-me'))
  assert.equal(permitted.catalog().hosts.length, 2)
  assert.equal(permitted.catalog().items[0].sources[0].availability, 'offline')
  await assert.rejects(permitted.importSnapshot(snapshot, 'verified-connector'), { code: 'stale_snapshot' })
  await assert.rejects(permitted.importSnapshot(remoteSnapshot(f), 'verified-connector'), { code: 'host_limit' })
  f.setHousehold('different-household')
  assert.equal(permitted.catalog().total, 0); assert.equal(permitted.catalog().hosts.length, 1)
})

test('remote heartbeat works across networks, expires, and never makes cached startup state online', async t => {
  const f = await fixture(t, { authorizeRemoteHost: trusted }), snapshot = remoteSnapshot(f)
  await f.catalog.importSnapshot(snapshot, 'verified-connector')
  const hostId = snapshot.host.hostId, sourceId = snapshot.sources[0].sourceId
  await assert.rejects(f.catalog.recordHeartbeat({ hostId, availableSourceIds: [sourceId] }, 'unverified'), { code: 'untrusted_host' })
  await f.catalog.recordHeartbeat({ hostId, availableSourceIds: [sourceId] }, 'verified-connector')
  assert.equal(f.catalog.catalog().items[0].sources[0].availability, 'available')
  assert.equal(f.catalog.catalog().hosts.find(host => host.hostId === hostId).status, 'online')
  const reopened = createHouseholdCatalog(f.dependencies)
  assert.equal(reopened.catalog().items[0].sources[0].availability, 'offline')
  f.advance(HEARTBEAT_MS + 1)
  assert.equal(f.catalog.catalog().items[0].sources[0].availability, 'offline')
  assert.equal(f.catalog.catalog().total, 1)
})

test('connection preferences never claim a tested route and Direct explains unique ports', async t => {
  const f = await fixture(t)
  const info = f.catalog.configureLocalHost({ name: 'Travel computer', connectionType: 'direct', externalPort: 47812 })
  assert.equal(info.host.connection.preferredType, 'direct')
  assert.equal(info.host.connection.externalPort, 47812)
  assert.equal(info.host.connection.observedType, null); assert.equal(info.host.connection.testStatus, 'not_tested')
  assert.match(info.host.connection.guidance, /own external port/)
  assert.throws(() => f.catalog.configureLocalHost({ connectionType: 'direct', externalPort: 70000 }), { code: 'invalid_connection' })
  assert.equal(connectionGuidance().preferredType, 'relay')
  assert.equal(presentation({ hostOnline: false }).availability, 'offline')
  assert.equal(presentation({ hostOnline: true }).availability, 'unknown')
})
