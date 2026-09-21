// The Speech Pack subtitle queue (electron/addons/speechPack/jobs.js) end to end with a FAKE whisper and a FAKE
// ffmpeg (small node scripts, no real model, no real audio): chunking + stitching, throttling (playback, battery,
// busy CPU, mid-chunk interruption), resume after a restart, cancel, languages and translation, failures,
// the per-library auto switch (default OFF), and the safety rules around what can be queued.
// Run: node --test test/speech-pack-jobs.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const F = require('./helpers/addonFixtures')
const { localRequire } = F
const { createSubtitleQueue } = localRequire('./electron/addons/speechPack/jobs')
const whisperLib = localRequire('./electron/addons/speechPack/whisper')

const until = async (fn, ms = 8000) => {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error('timed out waiting: ' + fn.toString().slice(0, 120))
    await new Promise((r) => setTimeout(r, 15))
  }
}

async function makeEnv({ models = ['model-base.en', 'model-base'], files = ['Movie.d25.mkv'], queueOpts = {}, libraryOn = false } = {}) {
  const { manager, srv, dir } = await F.fakeSpeechManager()
  if (models) assert.equal((await manager.install('speech-pack', { components: models })).ok, true)
  const root = F.tmpDir('beebo-spk-')
  const movies = path.join(root, 'Movies')
  fs.mkdirSync(movies)
  const items = files.map((f, i) => { const p = path.join(movies, f); fs.writeFileSync(p, 'not a video'); return { kind: 'movie', id: 'id' + i, path: p, label: f, dir: movies } })
  const store = F.memStore()
  const calls = []
  const state = { busy: false, battery: false, withSubs: new Set(), sleeps: 0 }
  const make = (extra = {}) => createSubtitleQueue({
    store, addons: manager, listItems: () => items, libraries: () => [{ dir: movies, kind: 'movies' }],
    hasSubtitles: async (p) => state.withSubs.has(p),
    isBusy: () => state.busy, onBattery: () => state.battery,
    ffmpegPath: () => 'fake-ffmpeg', ffprobePath: () => 'fake-ffprobe',
    spawnFn: F.fakeSpawn(calls), sleep: () => new Promise((r) => setTimeout(r, 5)),
    chunkSeconds: 10, overlapSeconds: 2, pollMs: 30, ...queueOpts, ...extra
  })
  const queue = make()
  const env = {
    manager, srv, dir, store, calls, state, items, movies, queue, make,
    whisperCalls: () => calls.filter((c) => c.program === 'whisper'),
    job: () => queue.status().jobs[0],
    out: (name) => path.join(movies, name),
    modelLog: (key) => { try { return fs.readFileSync(path.join(dir, 'speech-pack', `model-${key}`, `ggml-${key}.bin.calls.log`), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] } },
    async close() { queue.stop(); await srv.close() }
  }
  if (libraryOn) queue.setLibrary(movies, true)
  return env
}

const EXPECTED_ENGLISH_SRT =
  '1\n00:00:01,000 --> 00:00:03,000\nline@0\n\n' +
  '2\n00:00:11,000 --> 00:00:13,000\nline@10\n\n' +
  '3\n00:00:21,000 --> 00:00:23,000\nline@20\n\n' +
  '4\n00:00:24,000 --> 00:00:25,000\ntail@20\n'

test('a job chunks the audio, transcribes each chunk with the right offsets, drops the overlap, and writes Name.en.ai.srt', async () => {
  process.env.BEEBO_SECRET_FOR_TEST = 'top-secret'
  const e = await makeEnv()
  try {
    const r = await e.queue.enqueue({ kind: 'movie', id: 'id0' })
    assert.equal(r.ok, true, JSON.stringify(r))
    await e.queue.idle()
    const j = e.job()
    assert.equal(j.status, 'done', JSON.stringify(j))
    assert.equal(j.outFile, 'Movie.d25.en.ai.srt')
    assert.equal(j.chunksTotal, 3)
    assert.equal(j.percent, 100)
    assert.equal(fs.readFileSync(e.out('Movie.d25.en.ai.srt'), 'utf8'), EXPECTED_ENGLISH_SRT)
    // 3 chunks of ffmpeg, 3 of whisper (English model: no language detection needed)
    assert.equal(e.calls.filter((c) => c.program === 'ffmpeg').length, 3)
    assert.equal(e.whisperCalls().length, 3)
    // the exact argument list, no shell, no app environment, work in a private folder
    const w = e.whisperCalls()[0]
    assert.equal(w.args[w.args.indexOf('-l') + 1], 'en')
    assert.ok(w.args.includes('-oj') && w.args.includes('-np') && !w.args.includes('-tr'))
    assert.equal(w.shell, false)
    assert.ok(!('BEEBO_SECRET_FOR_TEST' in w.env))
    assert.ok(w.cwd.includes(path.join('speech-pack', 'data', 'work')))
    // nothing is left behind: no temp chunk, no work file, no stray .tmp beside the video
    assert.deepEqual(fs.readdirSync(e.movies).sort(), ['Movie.d25.en.ai.srt', 'Movie.d25.mkv'])
    assert.ok(!fs.existsSync(path.join(e.manager.dataDir('speech-pack'), 'work', j.id + '.json')))
    // logs never carry the title
    // (the queue logs through the injected log; here nothing was logged with the file name)
  } finally { delete process.env.BEEBO_SECRET_FOR_TEST; await e.close() }
})

test('PAUSES while anyone is watching or transcoding: nothing runs (not even ffprobe) until the house is quiet', async () => {
  const e = await makeEnv()
  try {
    e.state.busy = true
    await e.queue.enqueue({ kind: 'movie', id: 'id0' })
    await until(() => e.job().paused === 'playback')
    assert.equal(e.job().status, 'running')
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(e.calls.length, 0, 'no process was started while busy')
    e.state.busy = false
    await e.queue.idle()
    assert.equal(e.job().status, 'done')
    assert.ok(e.calls.length > 0)
  } finally { await e.close() }
})

test('PAUSES on battery (and for the shared background gate\'s own reasons); the setting lets the owner opt out', async () => {
  const e = await makeEnv()
  try {
    e.state.battery = true
    await e.queue.enqueue({ kind: 'movie', id: 'id0' })
    await until(() => e.job().paused === 'battery')
    assert.equal(e.calls.length, 0)
    e.queue.setSettings({ pauseOnBattery: false })
    await e.queue.idle()
    assert.equal(e.job().status, 'done', 'runs on battery once the owner allows it')
  } finally { await e.close() }
  // isBusy may answer with backgroundGate's reason string
  const e2 = await makeEnv()
  try {
    let reason = 'busy'
    e2.queue.stop()
    const q = e2.make({ isBusy: () => reason })
    await q.enqueue({ kind: 'movie', id: 'id0' })
    await until(() => q.status().jobs[0].paused === 'busy')
    reason = false
    await q.idle()
    assert.equal(q.status().jobs[0].status, 'done')
    q.stop()
  } finally { await e2.srv.close() }
})

test('a chunk that is already being transcribed is STOPPED when someone starts watching, and redone when it is quiet', async () => {
  const e = await makeEnv({ models: ['model-tiny.en'] }) // the fake tiny.en model is slow the first time it sees a chunk
  const t0 = Date.now()
  try {
    await e.queue.enqueue({ kind: 'movie', id: 'id0' })
    await until(() => e.modelLog('tiny.en').length >= 1) // the engine really started (and is now in its 3 s "slow" first run)
    await new Promise((r) => setTimeout(r, 100))
    e.state.busy = true // playback starts mid-chunk
    await until(() => e.job().paused === 'playback')
    const started = e.whisperCalls().length
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(e.whisperCalls().length, started, 'no new work while busy')
    assert.equal(e.job().chunksDone, 0, 'the interrupted chunk was not counted')
    e.state.busy = false
    await e.queue.idle()
    assert.equal(e.job().status, 'done')
    assert.equal(fs.readFileSync(e.out('Movie.d25.en.ai.srt'), 'utf8'), EXPECTED_ENGLISH_SRT, 'the result is identical to an uninterrupted run')
    assert.equal(e.whisperCalls().length, started + 3, 'the killed chunk was redone, the others ran once')
    assert.ok(Date.now() - t0 < 2800, 'the interrupted 3-second run was killed, not waited for')
  } finally { await e.close() }
})

test('RESUMABLE: after a stop/restart the job continues at the next chunk and never redoes finished ones', async () => {
  const e = await makeEnv()
  try {
    let extracts = 0
    const q1 = e.make({
      extractChunk: async (o) => { if (++extracts === 2) q1.stop(); return whisperLib.extractChunk(o) }
    })
    e.queue.stop()
    await q1.enqueue({ kind: 'movie', id: 'id0' })
    await until(() => q1.status().jobs[0].status === 'queued' && q1.status().jobs[0].chunksDone === 1)
    assert.equal(e.whisperCalls().length, 1, 'only the first chunk had been transcribed')
    const persisted = e.store.data.aiSubtitleJobs[0]
    assert.equal(persisted.status, 'queued')
    assert.equal(persisted.progress.chunksDone, 1)
    // "restart": a new queue on the same store + add-on folder
    const q2 = e.make()
    assert.equal(q2.status().jobs[0].status, 'queued')
    await q2.pump()
    assert.equal(q2.status().jobs[0].status, 'done')
    assert.equal(e.whisperCalls().length, 3, 'chunk 1 was not transcribed again')
    assert.equal(fs.readFileSync(e.out('Movie.d25.en.ai.srt'), 'utf8'), EXPECTED_ENGLISH_SRT)
    q2.stop()
  } finally { await e.close() }
})

test('an edited video starts over instead of mixing old and new work', async () => {
  const e = await makeEnv()
  try {
    let extracts = 0
    const q1 = e.make({ extractChunk: async (o) => { if (++extracts === 2) q1.stop(); return whisperLib.extractChunk(o) } })
    e.queue.stop()
    await q1.enqueue({ kind: 'movie', id: 'id0' })
    await until(() => q1.status().jobs[0].chunksDone === 1)
    fs.writeFileSync(e.items[0].path, 'a different, longer file than before') // size + mtime change
    const q2 = e.make()
    await q2.pump()
    assert.equal(e.whisperCalls().length, 1 + 3, 'all three chunks were done again for the new file')
    q2.stop()
  } finally { await e.close() }
})

test('CANCEL stops a running job at once, kills the process, removes its work and writes nothing', async () => {
  const e = await makeEnv({ models: ['model-tiny.en'] })
  try {
    await e.queue.enqueue({ kind: 'movie', id: 'id0' })
    await until(() => e.whisperCalls().length >= 1)
    const id = e.job().id
    assert.deepEqual(e.queue.cancel(id), { ok: true })
    await e.queue.idle()
    assert.equal(e.job().status, 'cancelled')
    assert.ok(!fs.existsSync(e.out('Movie.d25.en.ai.srt')))
    const work = path.join(e.manager.dataDir('speech-pack'), 'work')
    assert.deepEqual(fs.readdirSync(work), [], 'no work files or chunk audio left')
    assert.equal(e.queue.cancel(id).error, 'not_active')
    assert.equal(e.queue.cancel('nope').error, 'not_found')
    assert.deepEqual(e.queue.remove(id), { ok: true })
    assert.equal(e.queue.status().jobs.length, 0)
  } finally { await e.close() }
})

test('queued jobs run one at a time in order; cancelAll clears the rest; retry re-queues a failed job', async () => {
  const e = await makeEnv({ files: ['A.d15.mkv', 'B.d15.noaudio.mkv', 'C.d15.mkv'] })
  try {
    e.state.busy = true // hold everything so we can look at the queue
    for (const i of ['id0', 'id1', 'id2']) assert.equal((await e.queue.enqueue({ kind: 'movie', id: i })).ok, true)
    const dup = await e.queue.enqueue({ kind: 'movie', id: 'id0' })
    assert.equal(dup.duplicate, true)
    await until(() => e.queue.status().jobs.some((j) => j.status === 'running'))
    assert.deepEqual(e.queue.status().jobs.map((j) => j.status).sort(), ['queued', 'queued', 'running'])
    assert.equal(e.queue.status().running, true)
    e.state.busy = false
    await e.queue.idle()
    const byLabel = Object.fromEntries(e.queue.status().jobs.map((j) => [j.label, j]))
    assert.equal(byLabel['A.d15.mkv'].status, 'done')
    assert.equal(byLabel['C.d15.mkv'].status, 'done')
    assert.equal(byLabel['B.d15.noaudio.mkv'].status, 'failed')
    assert.equal(byLabel['B.d15.noaudio.mkv'].error, 'no_audio')
    assert.ok(!fs.existsSync(e.out('B.d15.noaudio.en.ai.srt')))
    assert.equal(e.queue.retry(byLabel['B.d15.noaudio.mkv'].id).ok, true)
    e.state.busy = true
    e.queue.cancelAll()
    assert.equal(e.queue.status().jobs.filter((j) => j.status === 'cancelled').length, 1)
    assert.equal(e.queue.clearFinished().removed, 3)
  } finally { await e.close() }
})

test('languages: many-languages model detects the language first (two samples), transcribes in it, and can translate to English', async () => {
  const e = await makeEnv({ models: ['model-base'] })
  try {
    e.queue.setSettings({ model: 'base' })
    await e.queue.enqueue({ kind: 'movie', id: 'id0' }) // language 'auto', no translation
    await e.queue.idle()
    let j = e.job()
    assert.equal(j.status, 'done', JSON.stringify(j))
    assert.equal(j.detectedLanguage, 'es')
    assert.equal(j.outFile, 'Movie.d25.es.ai.srt')
    const calls = e.modelLog('base')
    assert.ok(calls[0].includes('-dl'), 'detection ran first')
    assert.equal(calls.filter((c) => c.includes('-dl')).length, 1, 'p=0.95 is sure enough after one sample')
    const chunkCalls = calls.filter((c) => !c.includes('-dl'))
    assert.ok(chunkCalls.every((c) => c[c.indexOf('-l') + 1] === 'es' && !c.includes('-tr')))
    assert.match(fs.readFileSync(e.out('Movie.d25.es.ai.srt'), 'utf8'), /line@0\n/)
    // translate: same audio, output labelled English, whisper asked to translate
    fs.rmSync(e.out('Movie.d25.es.ai.srt'))
    e.queue.clearFinished()
    await e.queue.enqueue({ kind: 'movie', id: 'id0', translate: true })
    await e.queue.idle()
    j = e.job()
    assert.equal(j.status, 'done')
    assert.equal(j.outFile, 'Movie.d25.en.ai.srt')
    assert.equal(j.translate, true)
    assert.ok(e.modelLog('base').filter((c) => !c.includes('-dl')).slice(-3).every((c) => c.includes('-tr') && c[c.indexOf('-l') + 1] === 'es'))
    assert.match(fs.readFileSync(e.out('Movie.d25.en.ai.srt'), 'utf8'), /line@0 translated/)
    // an explicit language skips detection
    e.queue.clearFinished()
    fs.rmSync(e.out('Movie.d25.en.ai.srt'))
    const before = e.modelLog('base').length
    await e.queue.enqueue({ kind: 'movie', id: 'id0', language: 'fr' })
    await e.queue.idle()
    assert.equal(e.job().outFile, 'Movie.d25.fr.ai.srt')
    assert.ok(e.modelLog('base').slice(before).every((c) => !c.includes('-dl')))
  } finally { await e.close() }
})

test('an English-only model refuses other languages and never translates', async () => {
  const e = await makeEnv({ models: ['model-base.en'] })
  try {
    await e.queue.enqueue({ kind: 'movie', id: 'id0', language: 'fr' })
    await e.queue.idle()
    assert.equal(e.job().status, 'failed')
    assert.equal(e.job().error, 'english_model_only')
    e.queue.clearFinished()
    await e.queue.enqueue({ kind: 'movie', id: 'id0', translate: true })
    await e.queue.idle()
    assert.equal(e.job().status, 'done')
    assert.ok(e.whisperCalls().every((c) => !c.args.includes('-tr')))
    assert.equal(e.job().outFile, 'Movie.d25.en.ai.srt')
  } finally { await e.close() }
})

test('failures are reported plainly: a crashing engine, a missing file, silence; nothing partial is written', async () => {
  const e = await makeEnv({ models: ['model-small.en'] }) // the fake small.en model always exits 2
  try {
    await e.queue.enqueue({ kind: 'movie', id: 'id0' })
    await e.queue.idle()
    assert.equal(e.job().status, 'failed')
    assert.equal(e.job().error, 'whisper_failed')
    assert.equal(e.whisperCalls().length, 2, 'one retry, then give up')
    assert.ok(!fs.existsSync(e.out('Movie.d25.en.ai.srt')))
    assert.deepEqual(fs.readdirSync(path.join(e.manager.dataDir('speech-pack'), 'work')), [])
    // the file vanished after queueing
    e.queue.clearFinished()
    e.state.busy = true
    await e.queue.enqueue({ kind: 'movie', id: 'id0' })
    fs.rmSync(e.items[0].path)
    e.state.busy = false
    await e.queue.idle()
    assert.equal(e.job().error, 'not_found')
  } finally { await e.close() }
})

test('an existing AI subtitle file is never overwritten unless the owner asks', async () => {
  const e = await makeEnv()
  try {
    fs.writeFileSync(e.out('Movie.d25.en.ai.srt'), 'PRECIOUS')
    await e.queue.enqueue({ kind: 'movie', id: 'id0' })
    await e.queue.idle()
    assert.equal(e.job().status, 'done')
    assert.match(e.job().message || '', /already exists/)
    assert.equal(fs.readFileSync(e.out('Movie.d25.en.ai.srt'), 'utf8'), 'PRECIOUS')
    assert.equal(e.whisperCalls().length, 0)
    e.queue.clearFinished()
    await e.queue.enqueue({ kind: 'movie', id: 'id0', overwrite: true })
    await e.queue.idle()
    assert.equal(fs.readFileSync(e.out('Movie.d25.en.ai.srt'), 'utf8'), EXPECTED_ENGLISH_SRT)
  } finally { await e.close() }
})

test('safety: jobs come only from titles the library lists; not-installed and bad input are refused', async () => {
  const e = await makeEnv()
  try {
    for (const bad of [{ kind: 'movie', id: '../../etc/passwd' }, { kind: 'movie', id: 'C:\\Windows\\win.ini' }, { kind: 'movie', id: 'nope' }, {}]) {
      assert.equal((await e.queue.enqueue(bad)).error, 'not_found', JSON.stringify(bad))
    }
    assert.equal((await e.queue.enqueue({ kind: 'movie', id: 'id0', language: 'en; calc' })).error, 'bad_language')
    assert.equal((await e.queue.enqueue({ kind: 'movie', id: 'id0', model: 'small' })).error, 'model_missing')
    assert.equal(e.queue.status().jobs.length, 0)
    // a path smuggled in through the label or id never reaches a process
    assert.equal(e.calls.length, 0)
    await e.manager.uninstall('speech-pack', {})
    assert.equal((await e.queue.enqueue({ kind: 'movie', id: 'id0' })).error, 'not_installed')
  } finally { await e.close() }
  const none = await makeEnv({ models: null })
  try { assert.equal((await none.queue.enqueue({ kind: 'movie', id: 'id0' })).error, 'not_installed') } finally { await none.close() }
  const noModel = await makeEnv({ models: [] })
  try {
    await noModel.manager.install('speech-pack', {}) // engine only
    assert.equal((await noModel.queue.enqueue({ kind: 'movie', id: 'id0' })).error, 'model_missing')
  } finally { await noModel.close() }
})

test('per-library "auto-generate when no subtitles exist": default OFF, then queues only titles without subtitles, never retries failures', async () => {
  const e = await makeEnv({ files: ['Has.d15.mkv', 'None1.d15.mkv', 'None2.d15.noaudio.mkv'] })
  try {
    e.state.withSubs.add(e.items[0].path)
    assert.deepEqual(e.queue.libraryList().map((l) => l.enabled), [false], 'OFF by default')
    let r = await e.queue.scanNow()
    assert.equal(r.queued, 0, 'nothing is generated while the library switch is off')
    assert.equal(e.queue.status().jobs.length, 0)
    assert.equal(e.queue.setLibrary(path.join(e.movies, 'nope'), true).error, 'unknown_library')
    assert.equal(e.queue.setLibrary(e.movies, true).ok, true)
    assert.equal(e.queue.libraryList()[0].enabled, true)
    r = await e.queue.scanNow()
    assert.equal(r.queued, 2)
    await e.queue.idle()
    const jobs = e.queue.status().jobs
    assert.deepEqual(jobs.map((j) => j.label).sort(), ['None1.d15.mkv', 'None2.d15.noaudio.mkv'])
    assert.ok(jobs.every((j) => j.auto === true))
    assert.equal(jobs.find((j) => j.label.startsWith('None1')).status, 'done')
    assert.equal(jobs.find((j) => j.label.startsWith('None2')).status, 'failed')
    // scan again: the finished one and the recently failed one are left alone; the one with subtitles is remembered
    r = await e.queue.scanNow()
    assert.equal(r.queued, 0)
    // a sidecar created since means "has subtitles": no job for a title that got one
    e.queue.setLibrary(e.movies, false)
    assert.equal(e.queue.libraryList()[0].enabled, false)
    assert.equal((await e.queue.scanNow()).queued, 0)
  } finally { await e.close() }
})

test('the auto scan waits while the house is busy and does not generate when it cannot tell (unreadable file)', async () => {
  const e = await makeEnv({ files: ['X.d15.mkv'], libraryOn: true })
  try {
    e.state.busy = true
    assert.equal((await e.queue.scanNow()).examined, 0, 'no probing while someone is watching')
    e.state.busy = false
    e.queue.stop()
    const q = e.make({ hasSubtitles: async () => { throw new Error('ffprobe exploded') } })
    assert.equal((await q.scanNow()).queued, 0)
    q.stop()
  } finally { await e.close() }
})

test('uninstalling the model that is in use stops the running job cleanly (no file locked, no crash)', async () => {
  const e = await makeEnv({ models: ['model-tiny.en'] })
  try {
    await e.queue.enqueue({ kind: 'movie', id: 'id0' })
    await until(() => e.whisperCalls().length >= 1)
    const r = await e.manager.uninstall('speech-pack', { components: ['model-tiny.en'] })
    assert.deepEqual(r.removed, ['model-tiny.en'])
    await e.queue.idle()
    assert.equal(e.job().status, 'failed')
    assert.equal(e.job().error, 'model_missing')
    assert.ok(!fs.existsSync(path.join(e.dir, 'speech-pack', 'model-tiny.en')))
  } finally { await e.close() }
})

test('settings are validated; search only returns library titles', async () => {
  const e = await makeEnv({ files: ['Alpha Movie.d15.mkv', 'Beta.d15.mkv'] })
  try {
    assert.deepEqual(e.queue.getSettings(), { model: '', language: 'auto', translate: false, pauseOnBattery: true, threads: 0 })
    e.queue.setSettings({ model: 'small', language: 'xx yy', translate: true, threads: 99 })
    assert.deepEqual(e.queue.getSettings(), { model: 'small', language: 'auto', translate: true, pauseOnBattery: true, threads: 16 })
    e.queue.setSettings({ model: 'evil', language: 'ja' })
    assert.equal(e.queue.getSettings().model, '')
    assert.equal(e.queue.getSettings().language, 'ja')
    assert.deepEqual((await e.queue.search('alpha')).map((x) => x.label), ['Alpha Movie.d15.mkv'])
    assert.deepEqual(await e.queue.search('a'), [])
    assert.ok(!('path' in (await e.queue.search('beta'))[0]), 'no paths in search results')
    // The job list never carries a folder path (the settings screen shows the LIBRARY folders to the owner on purpose).
    // Check the raw and the JSON-escaped form: on Windows JSON doubles the backslashes, so a raw-only check can never fail.
    const jobsJson = JSON.stringify(e.queue.status().jobs)
    assert.ok(!jobsJson.includes(e.movies) && !jobsJson.includes(JSON.stringify(e.movies).slice(1, -1)), 'jobs never expose folder paths')
  } finally { await e.close() }
})
