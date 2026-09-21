// The whole-library subtitle sweep (subtitleSweep.js): every collaborator here is a fake, so
// these tests never touch the network, ffprobe or a real file - they only check the engine's own
// decisions (what counts as "missing", batching, pacing, and every quota/error stop condition).
// The real OpenSubtitles search/download code (openSubtitles.js) and its rate limiting are
// exercised by playback-api.test.js and title-requests.test.js; this file assumes they work and
// only asks: does the sweep call them safely?
// Run: node --test test/subtitle-sweep.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { createRequire } = require('node:module')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))
const sweep = localRequire('./electron/subtitleSweep')

test('clampBatchSize / clampMinRemaining', () => {
  assert.equal(sweep.clampBatchSize(undefined), sweep.DEFAULT_BATCH_SIZE)
  assert.equal(sweep.clampBatchSize(0), sweep.DEFAULT_BATCH_SIZE)
  assert.equal(sweep.clampBatchSize(-5), sweep.DEFAULT_BATCH_SIZE)
  assert.equal(sweep.clampBatchSize(9999), sweep.MAX_BATCH_SIZE)
  assert.equal(sweep.clampBatchSize(10), 10)
  assert.equal(sweep.clampMinRemaining(undefined), sweep.DEFAULT_MIN_REMAINING)
  assert.equal(sweep.clampMinRemaining(-1), sweep.DEFAULT_MIN_REMAINING)
  assert.equal(sweep.clampMinRemaining(999), sweep.MAX_MIN_REMAINING)
  assert.equal(sweep.clampMinRemaining(0), 0)
})

test('normalizeLanguage', () => {
  assert.equal(sweep.normalizeLanguage(''), 'any')
  assert.equal(sweep.normalizeLanguage(undefined), 'any')
  assert.equal(sweep.normalizeLanguage('any'), 'any')
  assert.equal(sweep.normalizeLanguage(' EN '), 'en')
})

const sameLanguage = (a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase()

test('isMissing: "any" means no subtitle at all; a language means none matching', () => {
  assert.equal(sweep.isMissing([], 'any', sameLanguage), true)
  assert.equal(sweep.isMissing([{ language: 'fr' }], 'any', sameLanguage), false)
  assert.equal(sweep.isMissing([{ language: 'fr' }], 'en', sameLanguage), true)
  assert.equal(sweep.isMissing([{ language: 'en' }, { language: 'fr' }], 'en', sameLanguage), false)
  assert.equal(sweep.isMissing(null, 'en', sameLanguage), true)
})

// Builds a runner over an in-memory library, an in-memory OpenSubtitles fake, and a no-op sleep
// (tests would otherwise take delayMs * items to run). Each helper records every call it gets so
// tests can assert the sweep never calls search/download for a title that already has subtitles.
function makeHarness({ items, subsByItem = {}, searchResults = {}, downloadOutcomes = {}, configured = true, quota = { remainingDownloads: 100 } } = {}) {
  const calls = { info: [], search: [], download: [] }
  const runner = sweep.createSweepRunner({
    listCandidates: () => items,
    getInfo: async (kind, id) => {
      calls.info.push(`${kind}:${id}`)
      return { status: 200, body: { ok: true, subtitles: subsByItem[id] || [] } }
    },
    search: async (kind, id, language) => {
      calls.search.push(`${kind}:${id}:${language}`)
      const r = searchResults[id]
      if (r === undefined) return { status: 200, body: { ok: true, results: [] } }
      if (r && r.error) return { status: 200, body: { ok: false, error: r.error, message: r.error } }
      return { status: 200, body: { ok: true, results: r } }
    },
    download: async (body) => {
      calls.download.push(body)
      const out = downloadOutcomes[body.id]
      if (out === undefined) return { status: 200, body: { ok: true, savedAs: 'x.srt', remaining: 100 } }
      if (out && out.error) return { status: 200, body: { ok: false, error: out.error, message: out.error } }
      return { status: 200, body: { ok: true, savedAs: 'x.srt', ...out } }
    },
    configured: () => configured,
    testQuota: async () => quota,
    sameLanguage,
    delayMs: 5,
    sleep: () => Promise.resolve() // no real waiting in tests
  })
  return { runner, calls }
}

test('refuses to run when OpenSubtitles is not configured, without listing the library', async () => {
  const listed = []
  const runner = sweep.createSweepRunner({
    listCandidates: () => { listed.push(1); return [] },
    getInfo: async () => ({ status: 200, body: { ok: true, subtitles: [] } }),
    search: async () => ({ status: 200, body: { ok: true, results: [] } }),
    download: async () => ({ status: 200, body: { ok: true } }),
    configured: () => false,
    testQuota: async () => ({ remainingDownloads: 10 }),
    sameLanguage
  })
  const out = await runner.run({ language: 'en' })
  assert.equal(out.ok, false)
  assert.equal(out.error, 'not_configured')
  assert.equal(listed.length, 0)
})

test('refuses to start once the preflight quota check says today\'s downloads are gone', async () => {
  const { runner, calls } = makeHarness({ items: [{ kind: 'movie', id: 'a', label: 'A' }], quota: { remainingDownloads: 0 } })
  const out = await runner.run({ language: 'en' })
  assert.equal(out.ok, true)
  assert.equal(out.result.stoppedEarly, 'quota_exhausted')
  assert.equal(out.result.examined, 0)
  assert.equal(calls.info.length, 0, 'never even looked at a title')
})

test('a title already carrying the wanted language is skipped without calling OpenSubtitles', async () => {
  const items = [{ kind: 'movie', id: 'a', label: 'Has English' }, { kind: 'movie', id: 'b', label: 'Has none' }]
  const { runner, calls } = makeHarness({
    items,
    subsByItem: { a: [{ language: 'en' }] },
    searchResults: { b: [{ fileId: 5, language: 'en' }] }
  })
  const out = await runner.run({ language: 'en' })
  assert.equal(out.result.examined, 2)
  assert.equal(out.result.skipped, 1)
  assert.equal(out.result.missing, 1)
  assert.equal(out.result.downloaded, 1)
  assert.deepEqual(calls.search, ['movie:b:en'])
  assert.equal(calls.download.length, 1)
  assert.equal(calls.download[0].id, 'b')
  assert.equal(calls.download[0].fileId, 5)
})

test('"any" language downloads the best result regardless of its language, and only needs zero subtitles to count as missing', async () => {
  const items = [{ kind: 'movie', id: 'a', label: 'A' }]
  const { runner, calls } = makeHarness({ items, searchResults: { a: [{ fileId: 9, language: 'fr' }] } })
  const out = await runner.run({ language: 'any' })
  assert.equal(out.result.downloaded, 1)
  assert.equal(calls.search[0], 'movie:a:') // no language filter sent for "any"
  assert.equal(calls.download[0].lang, 'fr', 'falls back to the result\'s own language when none was requested')
})

test('stops the whole run the moment a download response reports remaining <= minRemaining', async () => {
  const items = [
    { kind: 'movie', id: 'a', label: 'A' }, { kind: 'movie', id: 'b', label: 'B' }, { kind: 'movie', id: 'c', label: 'C' }
  ]
  const { runner, calls } = makeHarness({
    items,
    searchResults: { a: [{ fileId: 1, language: 'en' }], b: [{ fileId: 2, language: 'en' }], c: [{ fileId: 3, language: 'en' }] },
    downloadOutcomes: { a: { remaining: 5 }, b: { remaining: 2 } }
  })
  const out = await runner.run({ language: 'en', minRemaining: 3 })
  assert.equal(out.result.downloaded, 2)
  assert.equal(out.result.stoppedEarly, 'quota_low')
  assert.equal(out.result.remainingDownloads, 2)
  assert.equal(calls.download.length, 2, 'title C was never attempted')
})

test('OpenSubtitles answering "limit reached" on a search stops the run at once', async () => {
  const items = [{ kind: 'movie', id: 'a', label: 'A' }, { kind: 'movie', id: 'b', label: 'B' }]
  const { runner, calls } = makeHarness({ items, searchResults: { a: { error: 'limit' } } })
  const out = await runner.run({ language: 'en' })
  assert.equal(out.result.stoppedEarly, 'quota_exhausted')
  assert.equal(out.result.downloaded, 0)
  assert.equal(calls.search.length, 1, 'title B was never reached')
})

test('OpenSubtitles answering "limit reached" on a download stops the run at once', async () => {
  const items = [{ kind: 'movie', id: 'a', label: 'A' }, { kind: 'movie', id: 'b', label: 'B' }]
  const { runner, calls } = makeHarness({
    items,
    searchResults: { a: [{ fileId: 1, language: 'en' }], b: [{ fileId: 2, language: 'en' }] },
    downloadOutcomes: { a: { error: 'limit' } }
  })
  const out = await runner.run({ language: 'en' })
  assert.equal(out.result.stoppedEarly, 'quota_exhausted')
  assert.equal(out.result.downloaded, 0)
  assert.equal(calls.download.length, 1, 'title B was never attempted')
})

test('five search/download failures in a row stop the run rather than grinding through a dead connection', async () => {
  const items = Array.from({ length: 8 }, (_, i) => ({ kind: 'movie', id: 'm' + i, label: 'M' + i }))
  const searchResults = {}
  for (const it of items) searchResults[it.id] = { error: 'offline' }
  const { runner, calls } = makeHarness({ items, searchResults })
  const out = await runner.run({ language: 'en' })
  assert.equal(out.result.stoppedEarly, 'errors')
  assert.equal(out.result.errors.length, 5)
  assert.ok(calls.search.length <= 6, 'stopped soon after the fifth consecutive failure')
})

test('batchSize caps how many titles one run examines', async () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ kind: 'movie', id: 'm' + i, label: 'M' + i }))
  const { runner } = makeHarness({ items, subsByItem: Object.fromEntries(items.map((i) => [i.id, [{ language: 'en' }]])) })
  const out = await runner.run({ language: 'en', batchSize: 4 })
  assert.equal(out.result.examined, 4)
  assert.equal(out.result.stoppedEarly, 'batch_size')
})

test('a title that cannot be read (playback.info failed) is recorded as an error and does not stop the run', async () => {
  const items = [{ kind: 'movie', id: 'a', label: 'A' }, { kind: 'movie', id: 'b', label: 'B' }]
  const runner = sweep.createSweepRunner({
    listCandidates: () => items,
    getInfo: async (kind, id) => (id === 'a' ? { status: 404, body: { ok: false, error: 'not_found' } } : { status: 200, body: { ok: true, subtitles: [] } }),
    search: async () => ({ status: 200, body: { ok: true, results: [] } }),
    download: async () => ({ status: 200, body: { ok: true } }),
    configured: () => true,
    testQuota: async () => ({ remainingDownloads: 10 }),
    sameLanguage,
    sleep: () => Promise.resolve()
  })
  const out = await runner.run({ language: 'en' })
  assert.equal(out.result.examined, 2)
  assert.equal(out.result.errors.length, 1)
  assert.equal(out.result.errors[0].error, 'unreadable')
  assert.equal(out.result.stoppedEarly, null)
})

test('refuses a second run while one is already in progress', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  const runner = sweep.createSweepRunner({
    listCandidates: async () => { await gate; return [] },
    getInfo: async () => ({ status: 200, body: { ok: true, subtitles: [] } }),
    search: async () => ({ status: 200, body: { ok: true, results: [] } }),
    download: async () => ({ status: 200, body: { ok: true } }),
    configured: () => true,
    testQuota: async () => ({ remainingDownloads: 10 }),
    sameLanguage,
    sleep: () => Promise.resolve()
  })
  const first = runner.run({ language: 'en' })
  assert.equal(runner.isRunning(), true)
  const second = await runner.run({ language: 'en' })
  assert.equal(second.ok, false)
  assert.equal(second.error, 'already_running')
  release()
  const out = await first
  assert.equal(out.ok, true)
  assert.equal(runner.isRunning(), false)
})

test('lastResult() remembers the most recent finished run', async () => {
  const items = [{ kind: 'movie', id: 'a', label: 'A' }]
  const { runner } = makeHarness({ items, subsByItem: { a: [{ language: 'en' }] } })
  assert.equal(runner.lastResult(), null)
  await runner.run({ language: 'en' })
  const last = runner.lastResult()
  assert.equal(last.examined, 1)
  assert.equal(last.skipped, 1)
  assert.equal(typeof last.finishedAt, 'number')
})
