// Seek-preview cache limit + LRU eviction, and the low-impact queue / library sweep (no ffmpeg needed).
// Run: node --test test/trickplay-cache-job.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))
const cache = localRequire('./electron/trickplayCache')
const job = localRequire('./electron/trickplayJob')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-tpc-'))

function makeSet(root, name, { frames = 3, frameBytes = 1000, usedMsAgo = 0, identity = null } = {}) {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  for (let i = 0; i < frames; i++) fs.writeFileSync(path.join(dir, String(i).padStart(6, '0') + '.jpg'), Buffer.alloc(frameBytes, 1))
  const manifest = path.join(dir, 'manifest.json')
  fs.writeFileSync(manifest, JSON.stringify({ intervalSec: 10, width: 160, count: frames, identity }))
  const t = new Date(Date.now() - usedMsAgo)
  fs.utimesSync(manifest, t, t)
  return dir
}

test('clampMaxMB: sane default, floor and ceiling', () => {
  assert.equal(cache.clampMaxMB(undefined), cache.DEFAULT_MAX_MB)
  assert.equal(cache.clampMaxMB('abc'), cache.DEFAULT_MAX_MB)
  assert.equal(cache.clampMaxMB(1), cache.MIN_MAX_MB)
  assert.equal(cache.clampMaxMB(10 ** 9), cache.MAX_MAX_MB)
  assert.equal(cache.clampMaxMB(2048.4), 2048)
})

test('listSets / totalBytes count finished sets only, not .part directories', () => {
  const root = tmp()
  try {
    makeSet(root, 'aaa', { frames: 2, frameBytes: 500 })
    fs.mkdirSync(path.join(root, 'bbb.part'))
    fs.writeFileSync(path.join(root, 'bbb.part', '000000.jpg'), Buffer.alloc(9999))
    fs.mkdirSync(path.join(root, 'ccc'))
    const sets = cache.listSets(root)
    assert.deepEqual(sets.map((s) => s.name), ['aaa'])
    assert.ok(cache.totalBytes(root) >= 1000 && cache.totalBytes(root) < 1200)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('prune: evicts the least recently used sets first until it fits, and never a protected set', () => {
  const root = tmp()
  try {
    makeSet(root, 'old', { usedMsAgo: 3 * 3600e3 })
    makeSet(root, 'mid', { usedMsAgo: 2 * 3600e3 })
    makeSet(root, 'new', { usedMsAgo: 1 * 3600e3 })
    const one = cache.listSets(root)[0].bytes
    // Room for exactly two sets.
    let r = cache.prune(root, { maxBytes: one * 2 + 10 })
    assert.deepEqual(r.removed, ['old'])
    assert.equal(fs.existsSync(path.join(root, 'old')), false)
    assert.equal(fs.existsSync(path.join(root, 'mid')), true)
    // Room for one, but the oldest is protected (it is the set just written): the next-oldest goes.
    r = cache.prune(root, { maxBytes: one + 10, protect: new Set(['mid']) })
    assert.deepEqual(r.removed, ['new'])
    assert.equal(fs.existsSync(path.join(root, 'mid')), true)
    // A limit of zero with everything protected removes nothing rather than looping.
    r = cache.prune(root, { maxBytes: 0, protect: new Set(['mid']) })
    assert.deepEqual(r.removed, [])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('touch: reading a set makes it the most recently used, at most once a minute', () => {
  const root = tmp()
  try {
    const dir = makeSet(root, 'a', { usedMsAgo: 3600e3 })
    const before = fs.statSync(path.join(dir, 'manifest.json')).mtimeMs
    cache.touch(dir)
    const after = fs.statSync(path.join(dir, 'manifest.json')).mtimeMs
    assert.ok(after > before + 1000 * 60 * 59)
    cache.touch(dir, Date.now() + 1000)
    assert.equal(fs.statSync(path.join(dir, 'manifest.json')).mtimeMs, after, 'throttled inside a minute')
    makeSet(root, 'b', { usedMsAgo: 1800e3 })
    const one = cache.listSets(root)[0].bytes
    const r = cache.prune(root, { maxBytes: one + 10 })
    assert.deepEqual(r.removed, ['b'], 'the touched set outlives the one that was only written')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('sweepStaleParts: removes abandoned .part dirs, keeps fresh ones and ones a pass still owns', () => {
  const root = tmp()
  try {
    for (const n of ['stale.part', 'fresh.part', 'owned.part']) fs.mkdirSync(path.join(root, n))
    const old = new Date(Date.now() - 3 * 3600e3)
    fs.utimesSync(path.join(root, 'stale.part'), old, old)
    fs.utimesSync(path.join(root, 'owned.part'), old, old)
    const n = cache.sweepStaleParts(root, { inFlight: new Set(['owned']) })
    assert.equal(n, 1)
    assert.equal(fs.existsSync(path.join(root, 'stale.part')), false)
    assert.equal(fs.existsSync(path.join(root, 'fresh.part')), true)
    assert.equal(fs.existsSync(path.join(root, 'owned.part')), true)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------- queue
const instantSleep = () => new Promise((r) => setImmediate(r))

test('queue: runs one job at a time per lane, in order, and shares a duplicate key', async () => {
  const q = job.createTrickplayQueue({ sleep: instantSleep, pauseBetweenMs: 0 })
  const log = []
  let live = 0
  let peak = 0
  const mk = (n) => async () => { live++; peak = Math.max(peak, live); log.push('start ' + n); await instantSleep(); await instantSleep(); log.push('end ' + n); live--; return { state: 'ready', n } }
  const a = q.enqueue('a', mk('a'))
  const b = q.enqueue('b', mk('b'))
  const a2 = q.enqueue('a', mk('again'))
  assert.equal(a2, a, 'same key, same run')
  const rs = await Promise.all([a, b])
  assert.deepEqual(rs.map((r) => r.n), ['a', 'b'])
  assert.equal(peak, 1)
  assert.deepEqual(log, ['start a', 'end a', 'start b', 'end b'])
})

test('queue: background work waits while the house is busy, resumes when quiet; urgent work does not wait', async () => {
  let busy = true
  let polls = 0
  const q = job.createTrickplayQueue({ isBusy: () => busy, sleep: async () => { polls++; if (polls >= 5) busy = false; await instantSleep() }, pauseBetweenMs: 0 })
  const order = []
  const bg = q.enqueue('bg', async () => { order.push('bg'); return { state: 'ready' } })
  const urgent = q.enqueue('urgent', async () => { order.push('urgent'); return { state: 'ready' } }, { urgent: true })
  await urgent
  assert.deepEqual(order, ['urgent'], 'urgent ran while the background job was still held back')
  assert.equal(q.status().paused, 'playback')
  await bg
  assert.deepEqual(order, ['urgent', 'bg'])
  assert.ok(polls >= 5)
  assert.equal(q.status().paused, null)
})

test('queue: an urgent request promotes a job waiting in the background lane', async () => {
  let busy = true
  const q = job.createTrickplayQueue({ isBusy: () => busy, sleep: async () => { await instantSleep() }, pauseBetweenMs: 0 })
  let ran = 0
  const bg = q.enqueue('film', async () => { ran++; return { state: 'ready' } })
  const again = q.enqueue('film', async () => { ran++; return { state: 'ready' } }, { urgent: true })
  assert.equal(again, bg)
  const r = await bg
  assert.equal(r.state, 'ready')
  assert.equal(ran, 1)
  assert.equal(busy, true, 'ran without the house going quiet')
})

test('queue: a job that throws resolves as failed and the queue carries on', async () => {
  const q = job.createTrickplayQueue({ sleep: instantSleep, pauseBetweenMs: 0, log: () => {} })
  const bad = q.enqueue('bad', async () => { throw new Error('boom') })
  const good = q.enqueue('good', async () => ({ state: 'ready' }))
  assert.equal((await bad).state, 'failed')
  assert.equal((await good).state, 'ready')
})

test('queue: switched off, background jobs are dropped (aborted) without running', async () => {
  let ran = false
  const q = job.createTrickplayQueue({ enabled: () => false, sleep: instantSleep, pauseBetweenMs: 0 })
  const r = await q.enqueue('x', async () => { ran = true; return { state: 'ready' } })
  assert.equal(r.state, 'aborted')
  assert.equal(ran, false)
})

// ---------------------------------------------------------------- sweep
function sweepFixture({ files, ready = new Set(), used = 0, max = 1000, store = {}, generate }) {
  const data = { ...store }
  const s = { get: (k) => data[k], set: (k, v) => { data[k] = v } }
  const queue = job.createTrickplayQueue({ sleep: instantSleep, pauseBetweenMs: 0 })
  const stats = new Map(files.map((f) => [f, { size: 10, mtimeMs: 5 }]))
  const generated = []
  const sweep = job.createTrickplaySweep({
    store: s,
    queue,
    listItems: async () => files.map((p) => ({ path: p })),
    generate: async (p) => { generated.push(p); return generate(p) },
    readyIdentities: () => ready,
    usedBytes: () => used,
    maxBytes: () => max,
    statFile: (p) => stats.get(p) || null,
    identityOf: (p, size, m) => `${p}|${size}|${m}`,
    now: () => 1000000,
    timers: { setTimeout: () => null, clearTimeout() {}, setInterval: () => null, clearInterval() {} }
  })
  return { sweep, generated, data }
}

test('sweep: makes sets only for files that lack one, and only once', async () => {
  const f = sweepFixture({ files: ['/a', '/b', '/c'], ready: new Set(['/b|10|5']), generate: async () => ({ state: 'ready', bytes: 100 }) })
  const st = await f.sweep.runPass()
  assert.deepEqual(f.generated, ['/a', '/c'])
  assert.equal(st.done, 2)
})

test('sweep: remembers files that cannot be done and does not retry them next pass', async () => {
  const f = sweepFixture({
    files: ['/short', '/broken', '/fine'],
    generate: async (p) => (p === '/short' ? { state: 'ineligible' } : p === '/broken' ? { state: 'failed' } : { state: 'ready', bytes: 1 })
  })
  await f.sweep.runPass()
  assert.deepEqual(f.generated, ['/short', '/broken', '/fine'])
  const skips = f.data[job.SKIP_STORE_KEY]
  assert.equal(skips['/short|10|5'].state, 'ineligible')
  assert.equal(skips['/short|10|5'].retryAt, 1000000 + job.RETRY_INELIGIBLE_MS)
  assert.equal(skips['/broken|10|5'].retryAt, 1000000 + job.RETRY_FAILED_MS)
  assert.equal(skips['/fine|10|5'], undefined)
  f.generated.length = 0
  const again = sweepFixture({ files: ['/short', '/broken'], store: { [job.SKIP_STORE_KEY]: skips }, generate: async () => ({ state: 'failed' }) })
  await again.sweep.runPass()
  assert.deepEqual(again.generated, [], 'inside the retry window nothing is attempted')
})

test('sweep: stops when the cache is 90% full instead of evicting to make room', async () => {
  let bytes = 0
  const f = sweepFixture({ files: ['/a', '/b', '/c', '/d'], max: 1000, used: 0, generate: async () => ({ state: 'ready', bytes: 400 }) })
  const st = await f.sweep.runPass()
  bytes = f.generated.length * 400
  assert.equal(f.generated.length, 3, 'a, b and c fill it to 1200; d never starts')
  assert.equal(st.stoppedBecause, 'cache_full')
  assert.ok(bytes >= 900)
})

test('sweep: switched off, it does nothing', async () => {
  const data = {}
  const queue = job.createTrickplayQueue({ sleep: instantSleep, pauseBetweenMs: 0 })
  let listed = false
  const sweep = job.createTrickplaySweep({
    store: { get: (k) => data[k], set: (k, v) => { data[k] = v } }, queue,
    listItems: async () => { listed = true; return [] }, generate: async () => ({ state: 'ready' }),
    readyIdentities: () => new Set(), usedBytes: () => 0, maxBytes: () => 1, statFile: () => null, identityOf: () => '',
    enabled: () => false, timers: { setTimeout: () => null, clearTimeout() {}, setInterval: () => null, clearInterval() {} }
  })
  await sweep.runPass()
  assert.equal(listed, false)
})
