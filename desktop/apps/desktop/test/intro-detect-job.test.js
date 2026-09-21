// The background scanner (introDetectJob.js): scheduling, politeness, persistence and failure
// handling, with EVERY collaborator faked - no ffmpeg, no real clock, no real library.
// Run: node --test test/intro-detect-job.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))
const D = localRequire('./electron/introDetect')
const M = localRequire('./electron/markerModel')
const J = localRequire('./electron/introDetectJob')
const A = require('./helpers/syntheticAudio')

// ---- small synthetic episodes (90 s each) -----------------------------------------------------
const fpCache = new Map()
function episodeFp(seed, at) {
  const key = seed + '|' + at
  if (fpCache.has(key)) return fpCache.get(key)
  const bg = A.background(90, seed)
  const j = A.jingle(20, 99)
  const s0 = Math.round(at * A.SR)
  for (let i = 0; i < j.length; i++) bg[s0 + i] = bg[s0 + i] * 0.15 + j[i]
  const fp = D.fingerprintPcm(A.toInt16(bg))
  fpCache.set(key, fp)
  return fp
}

function memStore(initial = {}) {
  const data = { ...initial }
  return { get: (k) => data[k], set: (k, v) => { data[k] = JSON.parse(JSON.stringify(v)) }, data }
}

// A library of one 4-episode season of "Show" plus one film, each with a fake file identity.
function makeEnv(overrides = {}) {
  const files = new Map()
  const addFile = (p) => files.set(p, { size: 1000 + files.size, mtimeMs: 5000 })
  const ats = [5, 30, 12, 44]
  const items = ats.map((at, i) => ({ kind: 'tv', id: 'e' + i, path: `/tv/Show/S01E0${i + 1}.mkv`, showKey: 'show-key', showName: 'Show', season: 1, episode: i + 1, label: `S01E0${i + 1}` }))
  items.push({ kind: 'movie', id: 'm1', path: '/movies/Film.mkv', label: 'Film.mkv' })
  for (const it of items) addFile(it.path)
  const fpByPath = new Map(items.filter((i) => i.kind === 'tv').map((it, i) => [it.path, episodeFp(600 + i, ats[i])]))
  const calls = { probe: [], extract: [], tail: [], sleeps: [] }
  let inFlight = 0, maxInFlight = 0
  const env = {
    files, items, calls, ats,
    store: overrides.store || memStore(),
    busy: false,
    enabled: true,
    concurrency: 1,
    ffmpeg: 'ffmpeg-fake',
    extractFail: new Set(),
    tailFail: new Set(),
    now: 1_000_000,
    cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-fpcache-')),
    get maxInFlight() { return maxInFlight }
  }
  env.make = (extra = {}) => J.createIntroScanner({
    store: env.store,
    listItems: () => env.items,
    isBusy: () => env.busy,
    ffmpegPath: () => env.ffmpeg,
    ffprobePath: () => 'ffprobe-fake',
    cacheDir: () => env.cacheDir,
    now: () => env.now,
    statFile: (p) => files.get(p) || null,
    sleep: async (ms) => { calls.sleeps.push(ms); if (env.onSleep) env.onSleep(ms); if (env.sleepReal) await new Promise((r) => setTimeout(r, ms)) },
    pollMs: 10,
    pauseBetweenMs: 0,
    settings: { enabled: () => env.enabled, concurrency: () => env.concurrency },
    probe: async (p) => { calls.probe.push(p); return 1500 },
    extract: async (p, opts) => {
      calls.extract.push({ path: p, opts })
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setImmediate(r))
      inFlight--
      if (env.extractFail.has(p)) return { ok: false, error: 'boom' }
      return { ok: true, fp: fpByPath.get(p) }
    },
    analyseTail: async (p, opts) => {
      calls.tail.push({ path: p, opts })
      if (env.tailFail.has(p)) throw new Error('ffmpeg exploded')
      const dur = opts.durationSeconds
      return { ok: true, black: [{ start: dur - 130, end: dur }], silence: [] }
    },
    ...extra
  })
  return env
}

test('a full pass finds every intro and credits, stores them by file identity, and reports progress', async () => {
  const env = makeEnv()
  const s = env.make()
  const r = await s.runPass()
  assert.equal(r.ok, true)
  const stored = env.store.data.autoMarkers
  assert.equal(Object.keys(stored).length, 5)
  for (const [i, it] of env.items.slice(0, 4).entries()) {
    const rec = stored[M.fileIdentity(it.path, env.files.get(it.path))]
    assert.ok(rec, 'record for ' + it.path)
    assert.equal(rec.version, D.DETECTOR_VERSION)
    assert.ok(Math.abs(rec.introStart - env.ats[i]) < 1, `intro start ${rec.introStart} vs ${env.ats[i]}`)
    assert.ok(Math.abs(rec.introEnd - (env.ats[i] + 20)) < 1)
    assert.ok(rec.introConfidence >= M.AUTO_MIN_CONFIDENCE)
    assert.equal(rec.creditsStart, 1370)
    assert.equal(rec.durationSec, 1500)
    assert.equal(rec.showKey, 'show-key')
    assert.ok(rec.detectedAt > 0)
    const eff = M.effectiveMarkers({ viewer: {}, auto: rec, durationSeconds: 1500 })
    assert.equal(eff.source, 'auto')
  }
  const film = stored[M.fileIdentity('/movies/Film.mkv', env.files.get('/movies/Film.mkv'))]
  assert.equal(film.creditsStart, 1370)
  assert.equal(film.introStart == null, true)
  const st = s.status()
  assert.equal(st.itemsTotal, 5)
  assert.equal(st.itemsDone, 5)
  assert.equal(st.introFound, 4)
  assert.equal(st.creditsFound, 5)
  assert.equal(st.running, false)
  assert.equal(env.store.data.autoMarkerScan.itemsDone, 5)
})

test('the scanner uses low priority and never exceeds one process at a time by default', async () => {
  const env = makeEnv()
  await env.make().runPass()
  assert.ok(env.calls.extract.length > 0)
  assert.ok(env.calls.extract.every((c) => c.opts.priority === true && c.opts.ffmpegPath === 'ffmpeg-fake'))
  assert.equal(env.maxInFlight, 1)
})

test('concurrency is configurable but capped at two', async () => {
  const env = makeEnv()
  env.concurrency = 9
  await env.make().runPass()
  assert.equal(env.maxInFlight, 2)
})

test('it waits while anyone is watching, then resumes by itself', async () => {
  const env = makeEnv()
  env.busy = true
  env.sleepReal = true
  let polls = 0
  env.onSleep = () => { if (++polls === 4) env.busy = false }
  const s = env.make()
  const pass = s.runPass()
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(env.calls.extract.length, 0, 'nothing ran while busy')
  assert.equal(s.status().paused, 'playback')
  await pass
  assert.equal(polls >= 4, true)
  assert.equal(env.calls.extract.length, 4)
  assert.equal(s.status().paused, null)
  assert.equal(s.status().itemsDone, 5)
})

test('playback starting mid-season pauses it before the next process, never in the middle of one', async () => {
  const env = makeEnv()
  let started = 0
  const s = env.make({
    extract: async (p, opts) => {
      env.calls.extract.push({ path: p, opts })
      if (++started === 2) env.busy = true
      return { ok: true, fp: episodeFp(600 + env.items.findIndex((i) => i.path === p), env.ats[env.items.findIndex((i) => i.path === p)]) }
    }
  })
  let polls = 0
  env.onSleep = () => { if (++polls === 3) env.busy = false }
  await s.runPass()
  assert.equal(started, 4)
  assert.ok(polls >= 3, 'it waited for the house to go quiet before continuing')
})

test('progress survives a restart: results and cached fingerprints mean nothing is decoded twice', async () => {
  const env = makeEnv()
  let s1
  let count = 0
  s1 = env.make({
    extract: async (p, opts) => {
      env.calls.extract.push({ path: p, opts })
      const idx = env.items.findIndex((i) => i.path === p)
      if (++count === 3) s1.stop() // "the app is closed" after two fingerprints are safely on disk
      return { ok: true, fp: episodeFp(600 + idx, env.ats[idx]) }
    }
  })
  await s1.runPass()
  s1.flush()
  const firstRun = env.calls.extract.length
  assert.ok(firstRun >= 3)

  const s2 = env.make()
  await s2.runPass()
  const secondRun = env.calls.extract.length - firstRun
  assert.ok(secondRun < 4, `only the missing fingerprints are decoded again (${secondRun})`)
  assert.equal(s2.status().itemsDone, 5)
  const paths = env.calls.extract.map((c) => c.path)
  assert.equal(new Set(paths).size, 4, 'each episode was decoded exactly once across the restart')
})

test('a second pass over an unchanged library does no work at all', async () => {
  const env = makeEnv()
  await env.make().runPass()
  const before = { p: env.calls.probe.length, e: env.calls.extract.length, t: env.calls.tail.length }
  await env.make().runPass()
  assert.deepEqual({ p: env.calls.probe.length, e: env.calls.extract.length, t: env.calls.tail.length }, before)
})

test('only new or changed files are analysed: a new episode reuses the cached fingerprints of the rest', async () => {
  const env = makeEnv()
  await env.make().runPass()
  const e0 = env.calls.extract.length, t0 = env.calls.tail.length
  const newPath = '/tv/Show/S01E05.mkv'
  env.files.set(newPath, { size: 777, mtimeMs: 9000 })
  env.items.splice(4, 0, { kind: 'tv', id: 'e4', path: newPath, showKey: 'show-key', showName: 'Show', season: 1, episode: 5, label: 'S01E05' })
  const extra = episodeFp(650, 55)
  const s = env.make({
    extract: async (p, opts) => { env.calls.extract.push({ path: p, opts }); return p === newPath ? { ok: true, fp: extra } : { ok: false, error: 'should have been cached' } }
  })
  await s.runPass()
  assert.equal(env.calls.extract.length - e0, 1, 'only the new episode was decoded')
  assert.equal(env.calls.tail.length - t0, 1, 'only the new episode got a credits pass')
  const rec = s.lookup(newPath)
  assert.ok(Math.abs(rec.introStart - 55) < 1, String(rec && rec.introStart))
  // and the older episodes still have theirs
  assert.ok(s.lookup('/tv/Show/S01E01.mkv').introEnd > 0)
})

test('a changed file (new mtime) is analysed again; the stale result is never applied to it', async () => {
  const env = makeEnv()
  const s = env.make()
  await s.runPass()
  const p = '/movies/Film.mkv'
  const old = s.lookup(p)
  assert.ok(old && old.creditsStart)
  env.files.set(p, { size: 5, mtimeMs: 123456 })
  assert.equal(s.lookup(p), null, 'a different file identity has no result yet')
  const t0 = env.calls.tail.length
  await s.runPass()
  assert.equal(env.calls.tail.length - t0, 1)
})

test('missing files are skipped without errors', async () => {
  const env = makeEnv()
  env.files.delete('/tv/Show/S01E03.mkv')
  env.files.delete('/movies/Film.mkv')
  const s = env.make()
  const r = await s.runPass()
  assert.equal(r.ok, true)
  assert.equal(s.status().itemsTotal, 3)
  assert.ok(!env.calls.probe.includes('/tv/Show/S01E03.mkv'))
  assert.equal(s.status().lastError, '')
})

test('a file that fails is remembered and left alone; the others are unaffected; nothing throws', async () => {
  const env = makeEnv()
  env.extractFail.add('/tv/Show/S01E02.mkv')
  env.tailFail.add('/tv/Show/S01E04.mkv')
  const s = env.make()
  const r = await s.runPass()
  assert.equal(r.ok, true)
  const bad = s.lookup('/tv/Show/S01E02.mkv')
  assert.equal(bad.introError, 'boom')
  assert.equal(bad.introConfidence == null || bad.introConfidence === 0 || bad.introStart == null, true)
  const badTail = s.lookup('/tv/Show/S01E04.mkv')
  assert.match(badTail.creditsError, /exploded/)
  assert.ok(s.lookup('/tv/Show/S01E01.mkv').introEnd > 0)
  assert.ok(s.lookup('/tv/Show/S01E01.mkv').creditsStart > 0)
  const e = env.calls.extract.length, t = env.calls.tail.length
  await s.runPass()
  assert.equal(env.calls.extract.length, e, 'a failed file is not retried on every pass')
  assert.equal(env.calls.tail.length, t)
  env.now += J.RETRY_AFTER_MS + 1000
  env.tailFail.clear()
  await s.runPass()
  assert.ok(env.calls.tail.length > t, 'after a week it gets another chance')
  assert.ok(s.lookup('/tv/Show/S01E04.mkv').creditsStart > 0)
})

test('a library listing that throws does not crash anything', async () => {
  const env = makeEnv()
  const s = env.make({ listItems: () => { throw new Error('disk unplugged') } })
  const r = await s.runPass()
  assert.equal(r.ok, true)
  assert.equal(s.status().itemsTotal, 0)
})

test('the setting switches it off and on; no ffmpeg means it stays idle', async () => {
  const env = makeEnv()
  env.enabled = false
  const s = env.make()
  const off = await s.runPass()
  assert.equal(off.ok, false)
  assert.equal(s.status().enabled, false)
  assert.equal(env.calls.probe.length, 0)
  env.enabled = true
  env.ffmpeg = null
  assert.equal((await s.runPass()).error, 'no_ffmpeg')
  assert.equal(s.status().paused, 'no_ffmpeg')
  env.ffmpeg = 'ffmpeg-fake'
  assert.equal((await s.runPass()).ok, true)
  assert.equal(s.status().itemsDone, 5)
})

test('the default for "Detect intros and credits automatically" is ON', async () => {
  const env = makeEnv()
  const s = J.createIntroScanner({ store: env.store, listItems: () => [], ffmpegPath: () => null })
  assert.equal(s.status().enabled, true)
  env.store.data.autoMarkersEnabled = false
  assert.equal(s.status().enabled, false)
})

test('a season with a single episode gets no intro pass, but its credits are still looked at', async () => {
  const env = makeEnv()
  env.items = [env.items[0], env.items[4]]
  const s = env.make()
  await s.runPass()
  assert.equal(env.calls.extract.length, 0)
  assert.ok(s.lookup('/tv/Show/S01E01.mkv').creditsStart > 0)
  assert.equal(s.lookup('/tv/Show/S01E01.mkv').introStart == null, true)
  assert.equal(s.status().itemsDone, 2)
})

test('clear removes the show\'s auto markers and stays cleared; re-scan starts over from scratch', async () => {
  const env = makeEnv()
  const s = env.make()
  await s.runPass()
  const r = s.clearShow('show-key')
  assert.equal(r.cleared, 4)
  const rec = s.lookup('/tv/Show/S01E01.mkv')
  assert.equal(M.guardAutoRecord(rec, 1500).introEndSeconds, null)
  assert.equal(M.guardAutoRecord(rec, 1500).creditsStartSeconds, null)
  const e = env.calls.extract.length
  await s.runPass()
  assert.equal(env.calls.extract.length, e, 'cleared means not guessed again')
  s.rescanShow('show-key')
  while (s.status().running) await new Promise((r) => setImmediate(r))
  assert.ok(env.calls.extract.length > e, 'a re-scan decodes again')
  assert.ok(M.guardAutoRecord(s.lookup('/tv/Show/S01E01.mkv'), 1500).introEndSeconds > 0)
  assert.equal(s.summary().find((x) => x.key === 'show-key').intro, 4)
})

test('start() schedules the first pass after a delay and stop() cancels it', () => {
  const env = makeEnv()
  const scheduled = []
  const timers = {
    setTimeout: (fn, ms) => { const h = { fn, ms, cleared: false }; scheduled.push(h); return h },
    clearTimeout: (h) => { if (h) h.cleared = true },
    setInterval: (fn, ms) => { const h = { fn, ms, cleared: false, interval: true }; scheduled.push(h); return h },
    clearInterval: (h) => { if (h) h.cleared = true }
  }
  const s = env.make({ timers, startDelayMs: 180000, intervalMs: 1800000 })
  s.start()
  assert.deepEqual(scheduled.map((h) => h.ms), [180000, 1800000])
  s.stop()
  assert.ok(scheduled.every((h) => h.cleared))
})
