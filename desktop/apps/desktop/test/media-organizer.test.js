'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { createMediaOrganizer } = require('../electron/mediaOrganizer')

async function fixture(t, options = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'beebo-organizer-test-'))
  t.after(async () => {
    const resolved = path.resolve(base)
    assert.ok(path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('beebo-organizer-test-'))
    await fs.rm(resolved, { recursive: true, force: true })
  })
  const source = path.join(base, 'source')
  const destination = path.join(base, 'organized')
  await fs.mkdir(source)
  const organizer = createMediaOrganizer({ freeSpace: async () => 10 ** 12, ...options })
  const put = async (name, contents = 'sample-' + name) => {
    const file = path.join(source, name)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, contents)
    return file
  }
  const scan = async (args = {}) => {
    assert.equal(organizer.scan({ roots: [source], ...args }).ok, true)
    await organizer.whenIdle()
    return organizer.status()
  }
  const execute = async plan => {
    assert.equal(plan.ok, true, plan.message)
    assert.equal(organizer.execute({ planId: plan.planId }).ok, true)
    await organizer.whenIdle()
    return organizer.status()
  }
  return { base, source, destination, organizer, put, scan, execute }
}
const exists = async p => fs.access(p).then(() => true, () => false)
const digest = b => crypto.createHash('sha256').update(b).digest('hex')

test('read-only discovery excludes system folders, managed roots, junctions and overlapping roots', async t => {
  const f = await fixture(t)
  await f.put('movie.MP4'); await f.put('nested/picture.jpg'); await f.put('note.txt')
  for (const dir of ['Windows', 'AppData', 'node_modules', '.git', 'managed']) await f.put(dir + '/hidden.mp4')
  const linked = path.join(f.source, 'linked')
  await fs.symlink(path.join(f.source, 'nested'), linked, process.platform === 'win32' ? 'junction' : 'dir')
  const roots = [f.source, path.join(f.source, 'nested'), f.source]
  if (process.platform === 'win32') roots.push(f.source.toUpperCase())
  const result = await f.scan({ roots, excludeRoots: [path.join(f.source, 'managed')] })
  assert.equal(result.state, 'ready'); assert.equal(result.total, 2)
  assert.deepEqual(result.items.map(x => x.fileName).sort(), ['movie.MP4', 'picture.jpg'])
  assert.equal(await exists(f.destination), false)
})

test('matched-only review includes photos and confirmed posters, skips incomplete matching and performs no writes', async t => {
  const f = await fixture(t, { matchVideo: async item => item.fileName.startsWith('Good') ? { tmdbId: 12, title: 'Good Movie', year: 2020, poster: '/poster.jpg' } : { id: 13, title: 'No Poster' } })
  await f.put('Good.MP4'); await f.put('Unknown.mp4'); await f.put('photo.JPG')
  await f.scan({ matchPosters: true })
  const plan = await f.organizer.plan({ destination: f.destination, matchedOnly: true })
  assert.equal(plan.ok, true, plan.message); assert.equal(plan.count, 2); assert.equal(plan.unmatchedSkipped, 1)
  assert.ok(plan.items.some(x => x.destination.endsWith(path.join('Movies', 'Good Movie (2020).mp4'))))
  assert.ok(plan.items.some(x => path.basename(x.destination) === 'photo.jpg'))
  assert.equal(await exists(f.destination), false)
})

test('copy verifies bytes, preserves originals and existing destination files, records manifest and only runs a plan once', async t => {
  const observed = []
  const f = await fixture(t, { onOrganized: async item => observed.push(item) })
  const data = crypto.randomBytes(1024 * 1024 + 7)
  const original = await f.put('Movie.mp4', data)
  await fs.mkdir(path.join(f.destination, 'Movies'), { recursive: true })
  const existing = path.join(f.destination, 'Movies', 'Movie.mp4')
  await fs.writeFile(existing, 'existing-file')
  await f.scan()
  const plan = await f.organizer.plan({ destination: f.destination })
  assert.equal(path.basename(plan.items[0].destination), 'Movie (2).mp4')
  const result = await f.execute(plan)
  assert.equal(result.state, 'complete'); assert.equal(result.errors, 0, JSON.stringify(result.details)); assert.equal(result.copied, 1); assert.equal(result.moved, 0)
  assert.deepEqual(await fs.readFile(original), data)
  assert.deepEqual(await fs.readFile(plan.items[0].destination), data)
  assert.equal(await fs.readFile(existing, 'utf8'), 'existing-file')
  const manifest = (await fs.readFile(result.manifestPath, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(manifest.find(x => x.action === 'verified_copy').sha256, digest(data))
  assert.equal(manifest.at(-1).action, 'finished'); assert.equal(observed.length, 1)
  assert.equal(f.organizer.execute({ planId: plan.planId }).error, 'invalid_plan')
  assert.deepEqual((await fs.readdir(path.dirname(existing))).filter(x => x.startsWith('.beebo-copying-')), [])
})

test('move removes a source only after full verification and classifies explicit episodes', async t => {
  const f = await fixture(t)
  const original = await f.put('My.Show.S02E03.mp4', 'episode sample')
  await f.scan()
  const plan = await f.organizer.plan({ destination: f.destination, operation: 'move' })
  assert.ok(plan.items[0].destination.includes(path.join('TV Shows', 'My Show', 'Season 02')))
  const result = await f.execute(plan)
  assert.equal(result.errors, 0, JSON.stringify(result.details)); assert.equal(result.moved, 1)
  assert.equal(await exists(original), false)
  assert.equal(await fs.readFile(plan.items[0].destination, 'utf8'), 'episode sample')
  const manifest = await fs.readFile(result.manifestPath, 'utf8')
  assert.ok(manifest.indexOf('verified_copy') < manifest.indexOf('ready_to_remove_original'))
  assert.ok(manifest.includes('"action":"moved"'))
})

test('changed originals and destinations appearing after review are preserved', async t => {
  const f = await fixture(t)
  const a = await f.put('A.mp4', 'original-a'); const b = await f.put('B.mp4', 'original-b')
  await f.scan()
  const plan = await f.organizer.plan({ destination: f.destination, operation: 'move' })
  await fs.writeFile(a, 'changed-original-a')
  const targetB = plan.items.find(x => x.source === b).destination
  await fs.mkdir(path.dirname(targetB), { recursive: true }); await fs.writeFile(targetB, 'appeared-after-review')
  const result = await f.execute(plan)
  assert.equal(result.state, 'complete'); assert.equal(result.errors, 2); assert.equal(result.moved, 0)
  assert.deepEqual(result.details.map(x => x.code).sort(), ['destination_exists', 'source_changed'])
  assert.equal(await fs.readFile(a, 'utf8'), 'changed-original-a'); assert.equal(await fs.readFile(b, 'utf8'), 'original-b')
  assert.equal(await fs.readFile(targetB, 'utf8'), 'appeared-after-review')
})

test('cancel promptly interrupts a stuck matcher and leaves originals untouched', async t => {
  let entered
  const started = new Promise(resolve => { entered = resolve })
  const f = await fixture(t, { matchVideo: async (_, { signal }) => { entered(signal); return new Promise(() => {}) }, matchTimeoutMs: 60000 })
  const original = await f.put('Movie.mp4')
  assert.equal(f.organizer.scan({ roots: [f.source], matchPosters: true }).ok, true)
  const signal = await started
  assert.equal(f.organizer.cancel().ok, true)
  await f.organizer.whenIdle()
  assert.equal(signal.aborted, true); assert.equal(f.organizer.status().state, 'cancelled')
  assert.equal(await exists(original), true); assert.equal(await exists(f.destination), false)
})

test('cancel execution keeps all originals and records cancellation', async t => {
  const f = await fixture(t)
  const original = await f.put('Movie.mp4', crypto.randomBytes(1024 * 1024))
  await f.scan()
  const plan = await f.organizer.plan({ destination: f.destination, operation: 'move' })
  assert.equal(f.organizer.execute({ planId: plan.planId }).ok, true)
  f.organizer.cancel(); await f.organizer.whenIdle()
  const result = f.organizer.status()
  assert.equal(result.state, 'cancelled'); assert.equal(result.moved, 0); assert.equal(await exists(original), true)
  assert.match(await fs.readFile(result.manifestPath, 'utf8'), /"action":"cancelled"/)
})

test('insufficient space, invalid selections and file destinations fail during read-only review', async t => {
  const f = await fixture(t, { freeSpace: async () => 1 })
  const original = await f.put('Movie.mp4'); await f.scan()
  assert.equal((await f.organizer.plan({ destination: f.destination })).error, 'insufficient_space')
  assert.equal((await f.organizer.plan({ destination: f.destination, selectedIds: ['made-up-id'] })).error, 'invalid_selection')
  assert.equal((await f.organizer.plan({ destination: original })).error, 'not_directory')
  assert.equal(await exists(f.destination), false)
})

test('linked destinations and replaced source junctions cannot redirect an execution', async t => {
  const f = await fixture(t)
  await f.put('nested/Movie.mp4')
  const outside = path.join(f.base, 'outside'); await fs.mkdir(outside)
  const link = path.join(f.base, 'destination-link')
  await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
  await f.scan()
  assert.equal((await f.organizer.plan({ destination: link })).error, 'linked_path')
  const plan = await f.organizer.plan({ destination: f.destination, operation: 'move' })
  await fs.rename(path.join(f.source, 'nested'), path.join(f.source, 'original-nested'))
  await fs.writeFile(path.join(outside, 'Movie.mp4'), 'outside-file')
  await fs.symlink(outside, path.join(f.source, 'nested'), process.platform === 'win32' ? 'junction' : 'dir')
  const result = await f.execute(plan)
  assert.equal(result.moved, 0); assert.equal(result.details[0].code, 'linked_path')
  assert.equal(await fs.readFile(path.join(outside, 'Movie.mp4'), 'utf8'), 'outside-file')
  assert.equal(await exists(path.join(f.source, 'original-nested', 'Movie.mp4')), true)
})

test('scan cap, pagination and plan expiry stay bounded', async t => {
  let now = 1000
  const f = await fixture(t, { maxFiles: 2, now: () => now })
  for (const name of ['A.mp4', 'B.mp4', 'C.mp4']) await f.put(name)
  const result = await f.scan()
  assert.equal(result.total, 2); assert.equal(result.truncated, true)
  assert.equal(f.organizer.status({ offset: 1, limit: 1 }).items.length, 1)
  const plan = await f.organizer.plan({ destination: f.destination, selectedIds: [result.items[0].id] })
  assert.equal(plan.count, 1)
  now += 31 * 60 * 1000
  assert.equal(f.organizer.execute({ planId: plan.planId }).error, 'expired_plan')
  assert.equal(await exists(f.destination), false)
})

test('missing matcher or timed-out metadata never marks a video as poster matched', async t => {
  const f = await fixture(t, { matchVideo: async () => new Promise(() => {}), matchTimeoutMs: 100 })
  await f.put('Unknown.mp4'); const result = await f.scan({ matchPosters: true })
  assert.equal(result.matched, 0); assert.equal(result.errors, 1); assert.equal(result.items[0].match, null)
  assert.equal((await f.organizer.plan({ destination: f.destination, matchedOnly: true })).error, 'nothing_to_organize')
  assert.equal(await exists(f.destination), false)
})

test('files already inside the destination and configured managed roots are skipped', async t => {
  const f = await fixture(t)
  await f.put('Movie.mp4'); await f.put('managed/Photo.jpg')
  const g = createMediaOrganizer({ freeSpace: async () => 10 ** 12, getExcludedRoots: () => [path.join(f.source, 'managed')] })
  assert.equal(g.scan({ roots: [f.source] }).ok, true); await g.whenIdle()
  assert.equal(g.status().total, 1)
  assert.equal((await g.plan({ destination: f.source })).error, 'nothing_to_organize')
})

test('non-hard-link volumes use an exclusive verified fallback copy', async t => {
  const f = await fixture(t)
  const contents = crypto.randomBytes(700001)
  const original = await f.put('Fallback.mp4', contents)
  await f.scan()
  const plan = await f.organizer.plan({ destination: f.destination, operation: 'move' })
  const originalLink = fs.link
  fs.link = async () => { throw Object.assign(new Error('Fixture volume has no hard links'), { code: 'ENOTSUP' }) }
  try {
    const result = await f.execute(plan)
    assert.equal(result.errors, 0, JSON.stringify(result.details)); assert.equal(result.moved, 1)
    assert.deepEqual(await fs.readFile(plan.items[0].destination), contents)
    assert.equal(await exists(original), false)
  } finally { fs.link = originalLink }
})

test('review exposes total space including staging and warns when capacity cannot be read', async t => {
  const f = await fixture(t, { freeSpace: async () => null })
  await f.put('Movie.mp4', Buffer.alloc(1024)); await f.scan()
  const plan = await f.organizer.plan({ destination: f.destination })
  assert.equal(plan.ok, true); assert.equal(plan.requiredBytes, 2048 + 16 * 1024 * 1024)
  assert.equal(plan.availableBytes, null); assert.ok(plan.warnings.some(x => /Free space could not be measured/.test(x)))
  assert.equal(await exists(f.destination), false)
})

test('every reviewed destination is available through bounded pagination', async t => {
  const f = await fixture(t)
  await Promise.all(Array.from({ length: 205 }, (_, i) => f.put('Movie-' + i + '.mp4')))
  await f.scan(); const plan = await f.organizer.plan({ destination: f.destination })
  assert.equal(plan.count, 205); assert.equal(plan.items.length, 200)
  const page = f.organizer.preview({ planId: plan.planId, offset: 200, limit: 50 })
  assert.equal(page.ok, true); assert.equal(page.items.length, 5)
  assert.equal(new Set([...plan.items, ...page.items].map(x => x.id)).size, 205)
  assert.equal(await exists(f.destination), false)
})
