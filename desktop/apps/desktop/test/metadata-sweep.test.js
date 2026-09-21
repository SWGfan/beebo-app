// The whole-library metadata sweep (metadataSweep.js): every collaborator here is a fake, so
// these tests never touch the network or the manifest file - they only check the engine's own
// decisions (which files get looked up, batching, pacing, and the error stop condition). The
// real TMDB matching (titleMatch.js: shouldLookUp, matchParsed, applyVerdict, and its 429
// retry/backoff) is exercised by title-match.test.js; this file assumes that works and only
// asks: does the sweep call it safely, for the right files, without overrunning the library?
// Run: node --test test/metadata-sweep.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { createRequire } = require('node:module')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))
const sweep = localRequire('./electron/metadataSweep')

test('clampBatchSize', () => {
  assert.equal(sweep.clampBatchSize(undefined), sweep.DEFAULT_BATCH_SIZE)
  assert.equal(sweep.clampBatchSize(0), sweep.DEFAULT_BATCH_SIZE)
  assert.equal(sweep.clampBatchSize(-5), sweep.DEFAULT_BATCH_SIZE)
  assert.equal(sweep.clampBatchSize(9999), sweep.MAX_BATCH_SIZE)
  assert.equal(sweep.clampBatchSize(10), 10)
})

// Builds a runner over an in-memory file list and an in-memory "needs lookup" set, with a
// no-op sleep (tests would otherwise take delayMs * items to run).
function makeHarness({ files, needsLookup, lookupOutcomes = {} } = {}) {
  const calls = { shouldLookUp: [], lookupOne: [] }
  const runner = sweep.createSweepRunner({
    listCandidates: () => files,
    shouldLookUp: (fileName) => { calls.shouldLookUp.push(fileName); return needsLookup.has(fileName) },
    lookupOne: async (fileName) => {
      calls.lookupOne.push(fileName)
      const outcome = lookupOutcomes[fileName]
      if (outcome && outcome.error) throw new Error(outcome.error)
      return outcome || { id: 1 }
    },
    delayMs: 5,
    sleep: () => Promise.resolve() // no real waiting in tests
  })
  return { runner, calls }
}

test('only files that shouldLookUp() says need one are actually looked up', async () => {
  const files = ['a.mkv', 'b.mkv', 'c.mkv']
  const { runner, calls } = makeHarness({ files, needsLookup: new Set(['b.mkv']) })
  const out = await runner.run()
  assert.equal(out.ok, true)
  assert.equal(out.result.examined, 3, 'every file is examined')
  assert.equal(out.result.lookedUp, 1, 'only the one that needed it')
  assert.deepEqual(calls.lookupOne, ['b.mkv'])
})

test('an empty library finishes immediately, having looked nothing up', async () => {
  const { runner, calls } = makeHarness({ files: [], needsLookup: new Set() })
  const out = await runner.run()
  assert.equal(out.result.examined, 0)
  assert.equal(out.result.lookedUp, 0)
  assert.equal(calls.lookupOne.length, 0)
})

test('batchSize caps how many files one run examines, not just how many it looks up', async () => {
  const files = Array.from({ length: 10 }, (_, i) => `m${i}.mkv`)
  const { runner, calls } = makeHarness({ files, needsLookup: new Set(files) })
  const out = await runner.run({ batchSize: 4 })
  assert.equal(out.result.examined, 4)
  assert.equal(out.result.lookedUp, 4)
  assert.equal(out.result.stoppedEarly, 'batch_size')
  assert.equal(calls.lookupOne.length, 4, 'file 5 onward was never reached')
})

test('a file whose shouldLookUp() itself throws is treated as not needing a lookup, not a crash', async () => {
  const files = ['bad.mkv', 'ok.mkv']
  const runner = sweep.createSweepRunner({
    listCandidates: () => files,
    shouldLookUp: (fileName) => { if (fileName === 'bad.mkv') throw new Error('boom'); return true },
    lookupOne: async () => ({ id: 1 }),
    sleep: () => Promise.resolve()
  })
  const out = await runner.run()
  assert.equal(out.ok, true)
  assert.equal(out.result.examined, 2)
  assert.equal(out.result.lookedUp, 1)
  assert.equal(out.result.errors.length, 0)
})

test('five lookup failures in a row stop the run rather than grinding through a dead connection', async () => {
  const files = Array.from({ length: 8 }, (_, i) => `m${i}.mkv`)
  const lookupOutcomes = {}
  for (const f of files) lookupOutcomes[f] = { error: 'network_error' }
  const { runner, calls } = makeHarness({ files, needsLookup: new Set(files), lookupOutcomes })
  const out = await runner.run()
  assert.equal(out.result.stoppedEarly, 'errors')
  assert.equal(out.result.errors.length, 5)
  assert.ok(calls.lookupOne.length <= 5, 'stopped at the fifth consecutive failure')
})

test('an occasional failure does not stop the run as long as it is not five in a row', async () => {
  const files = ['a.mkv', 'b.mkv', 'c.mkv']
  const { runner } = makeHarness({
    files,
    needsLookup: new Set(files),
    lookupOutcomes: { 'b.mkv': { error: 'not_found' } }
  })
  const out = await runner.run()
  assert.equal(out.result.lookedUp, 2)
  assert.equal(out.result.errors.length, 1)
  assert.equal(out.result.stoppedEarly, null)
})

test('refuses a second run while one is already in progress', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  const runner = sweep.createSweepRunner({
    listCandidates: async () => { await gate; return [] },
    shouldLookUp: () => true,
    lookupOne: async () => ({ id: 1 }),
    sleep: () => Promise.resolve()
  })
  const first = runner.run()
  assert.equal(runner.isRunning(), true)
  const second = await runner.run()
  assert.equal(second.ok, false)
  assert.equal(second.error, 'already_running')
  release()
  const out = await first
  assert.equal(out.ok, true)
  assert.equal(runner.isRunning(), false)
})

test('lastResult() remembers the most recent finished run', async () => {
  const { runner } = makeHarness({ files: ['a.mkv'], needsLookup: new Set(['a.mkv']) })
  assert.equal(runner.lastResult(), null)
  await runner.run()
  const last = runner.lastResult()
  assert.equal(last.lookedUp, 1)
  assert.equal(typeof last.finishedAt, 'number')
})

test('a library listing failure is treated as an empty library, not a crash', async () => {
  const runner = sweep.createSweepRunner({
    listCandidates: () => { throw new Error('disk error') },
    shouldLookUp: () => true,
    lookupOne: async () => ({ id: 1 }),
    sleep: () => Promise.resolve()
  })
  const out = await runner.run()
  assert.equal(out.ok, true)
  assert.equal(out.result.examined, 0)
})
