// Live conversion that never leaves a dead player: the session manager's encoder ladder
// (restart on the next encoder when one dies or hangs), HDR tone-map fallbacks, the waiting line
// with its "server busy" answer, the load readout and the old-PC priority (hlsTranscoder.js).
// ffmpeg is played by test/helpers/fakeSpawn.js - no ffmpeg, no GPU.
// Run: node --test test/transcode-fallback.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))
const hls = localRequire('./electron/hlsTranscoder')
const dashboard = localRequire('./electron/serverDashboard')
const { createFakeSpawn } = require('./helpers/fakeSpawn')

const SECRET_FILE = 'D:\\Movies\\Secret Film (2020).mkv'
const TRACKS = (hdr = false, durationSec = 400) => ({
  durationSec,
  video: { streamIndex: 0, codec: hdr ? 'hevc' : 'h264', width: 1920, height: 1080, fps: 24, hdr },
  audio: [{ ordinal: 0, streamIndex: 1, codec: 'aac', channels: 2, language: 'eng', isDefault: true }],
  subtitles: []
})

const encOf = (args) => args[args.indexOf('-c:v') + 1]
const startOf = (args) => Number(args[args.indexOf('-start_number') + 1])
const vfOf = (args) => args[args.indexOf('-vf') + 1] || ''
const dirOf = (args) => path.dirname(args[args.indexOf('-hls_segment_filename') + 1])
function writePieces(args, count) {
  fs.mkdirSync(dirOf(args), { recursive: true })
  for (let i = 0; i < count; i++) fs.writeFileSync(path.join(dirOf(args), `seg-${startOf(args) + i}.ts`), 'ts')
}
const FAIL = (stderr, code = 1) => ({ code, stderr })
const OK = (args, pieces = 6) => { writePieces(args, pieces); return { hang: true } }

/**
 * A manager whose ffmpeg is scripted: script(args, { enc, start, n }) returns a fakeSpawn plan
 * ({ code, stderr } = exits, { hang: true } = keeps running). Every spawned fake child is kept.
 */
function harness(script, opts = {}) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-fb-'))
  const logs = []
  const events = { failed: [], ok: [] }
  const priorities = []
  const clock = { t: 5_000_000 }
  const spawn = createFakeSpawn((exe, args) => script(args, { enc: encOf(args), start: startOf(args), n: spawn.calls.length }))
  const children = []
  const spawnFn = (...a) => { const c = spawn(...a); children.push(c); return c }
  const m = hls.createTranscodeManager({
    ffmpegPath: 'ffmpeg', tmpRoot, sweepEveryMs: 0, pollMs: 4, spawnFn, now: () => clock.t,
    log: (l) => logs.push(l), setPriority: (pid) => priorities.push(pid),
    onEncoderFailure: (id, why) => events.failed.push([id, why]), onEncoderSuccess: (id) => events.ok.push(id),
    ...opts
  })
  const cleanup = () => { m.closeAll(); for (const c of children) { try { c.kill() } catch {} } try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch {} }
  return { m, spawn, children, logs, events, priorities, clock, cleanup, tmpRoot }
}
const spec = (over = {}) => ({ key: 'k1', owner: 'u1', fileKey: 'movie|a', filePath: SECRET_FILE, tracks: TRACKS(), quality: '480p', encoder: 'libopenh264', ...over })
const encoders = (h) => h.spawn.calls.map((c) => encOf(c.args))

test('a dying encoder hands the same session to the next one; software last; one redacted log line per switch', async () => {
  const h = harness((args, { enc }) => {
    if (enc === 'h264_nvenc') return FAIL(`Cannot load nvcuda.dll while reading ${SECRET_FILE}?mt=abc123`)
    if (enc === 'h264_qsv') return FAIL('Error initializing an internal MFX session: unsupported (-3)')
    return OK(args)
  })
  try {
    const s = h.m.open(spec({ encoder: 'h264_nvenc', chain: ['h264_nvenc', 'h264_qsv', 'libopenh264'] }))
    const file = await h.m.segment(s, 0)
    assert.ok(fs.existsSync(file), 'the viewer gets their piece - no error')
    assert.deepEqual(encoders(h), ['h264_nvenc', 'h264_qsv', 'libopenh264'], 'best first, software last')
    assert.equal(s.encoder, 'libopenh264')
    assert.equal(s.fallbacks, 2)
    assert.equal(s.error, null)
    const switches = h.logs.filter((l) => /stopped .* - continuing with/.test(l))
    assert.equal(switches.length, 2, 'exactly one line per switch')
    assert.match(switches[0], /NVIDIA graphics card stopped \(.*\) - continuing with Intel Quick Sync/)
    assert.match(switches[1], /Intel Quick Sync stopped \(.*\) - continuing with processor \(OpenH264\)/)
    const all = h.logs.join('\n')
    assert.ok(!/Secret|D:\\|abc123/.test(all), 'no file name, path or token in the log: ' + all)
    // The service is told: two failures, then a success on the encoder that delivered.
    assert.deepEqual(h.events.failed.map((f) => f[0]), ['h264_nvenc', 'h264_qsv'])
    assert.ok(h.events.failed.every((f) => !/Secret|D:\\|abc123/.test(f[1])))
    assert.deepEqual(h.events.ok, ['libopenh264'])
    // A later seek stays on the encoder that works (the session is sticky).
    await h.m.segment(s, 90)
    assert.equal(encoders(h).at(-1), 'libopenh264')
    assert.equal(h.spawn.calls.length, 4)
  } finally { h.cleanup() }
})

test('mid-film failure: the restart continues right after the last piece made, same position, next encoder', async () => {
  const h = harness((args, { enc }) => {
    if (enc === 'h264_nvenc') { writePieces(args, 3); return FAIL('[h264_nvenc] OpenEncodeSessionEx failed: out of memory (10)') }
    return OK(args)
  })
  try {
    const s = h.m.open(spec({ encoder: 'h264_nvenc', chain: ['h264_nvenc', 'libopenh264'] }))
    await h.m.segment(s, 0)
    const p3 = await h.m.segment(s, 3)
    assert.ok(fs.existsSync(p3))
    assert.deepEqual(encoders(h), ['h264_nvenc', 'libopenh264'])
    const second = h.spawn.calls[1].args
    assert.equal(startOf(second), 3, 'continues after piece 2')
    assert.equal(second[second.indexOf('-ss') + 1], '12.000')
    assert.equal(second[second.indexOf('-output_ts_offset') + 1], '12.000', 'the clock stays the film\'s clock')
  } finally { h.cleanup() }
})

test('a graphics encoder that makes nothing while a viewer waits is given up on (and killed)', async () => {
  const h = harness((args, { enc }) => (enc === 'h264_qsv' ? { hang: true } : OK(args)), { now: Date.now, hwStallMs: 60 })
  try {
    const s = h.m.open(spec({ encoder: 'h264_qsv', chain: ['h264_qsv', 'libopenh264'] }))
    const t0 = Date.now()
    const file = await h.m.segment(s, 0)
    assert.ok(fs.existsSync(file))
    assert.ok(Date.now() - t0 >= 50, 'waited for the stall window first')
    assert.deepEqual(encoders(h), ['h264_qsv', 'libopenh264'])
    assert.equal(h.children[0].killed, true, 'the stuck process was killed')
    assert.equal(h.logs.filter((l) => /no picture from Intel Quick Sync/.test(l)).length, 1)
    assert.deepEqual(h.events.failed.map((f) => f[0]), ['h264_qsv'])
  } finally { h.cleanup() }
  // Software is never stall-killed: there is nothing behind it, so it is left to finish (the normal timeout applies).
  const s2 = harness(() => ({ hang: true }), { now: Date.now, hwStallMs: 20, waitTimeoutMs: 150 })
  try {
    const s = s2.m.open(spec({ encoder: 'libopenh264', chain: ['libopenh264'] }))
    await assert.rejects(s2.m.segment(s, 0), /timed out waiting/)
    assert.equal(s2.spawn.calls.length, 1)
    assert.equal(s2.children[0].killed, false)
  } finally { s2.cleanup() }
})

test('a bad FILE is not blamed on the graphics card: no fallback, no demotion, a plain error', async () => {
  const h = harness(() => FAIL(`${SECRET_FILE}: Invalid data found when processing input`))
  try {
    const s = h.m.open(spec({ encoder: 'h264_nvenc', chain: ['h264_nvenc', 'libopenh264'] }))
    await assert.rejects(h.m.segment(s, 0), (e) => /ffmpeg stopped \(1\)/.test(e.message) && !/Secret|D:\\/.test(e.message))
    assert.equal(h.spawn.calls.length, 1, 'other encoders would fail the same way')
    assert.deepEqual(h.events.failed, [])
    assert.ok(!h.logs.join('\n').match(/Secret|D:\\/))
  } finally { h.cleanup() }
})

test('every encoder failing reports an error; the next request after a while starts the ladder again from the best one', async () => {
  let allFail = true
  const h = harness((args) => (allFail ? FAIL('Error while opening encoder for output stream #0:0') : OK(args)), { now: Date.now, exhaustedRetryMs: 30 })
  try {
    const s = h.m.open(spec({ encoder: 'h264_nvenc', chain: ['h264_nvenc', 'libopenh264'] }))
    await assert.rejects(h.m.segment(s, 0), /ffmpeg stopped \(1\)/)
    assert.deepEqual(encoders(h), ['h264_nvenc', 'libopenh264'])
    allFail = false
    await new Promise((r) => setTimeout(r, 50))
    const file = await h.m.segment(s, 0)
    assert.ok(fs.existsSync(file))
    assert.equal(encoders(h).at(-1), 'h264_nvenc', 'tried the best encoder again')
  } finally { h.cleanup() }
})

test('HDR: the ladder tries each tone-map method per encoder, GPU first, and ends with "no tone-map" rather than nothing', async () => {
  assert.deepEqual(hls.buildLadder(['h264_nvenc', 'libopenh264'], true, ['libplacebo', 'tonemap_opencl', 'zscale']), [
    { encoder: 'h264_nvenc', tonemap: 'libplacebo' }, { encoder: 'h264_nvenc', tonemap: 'tonemap_opencl' }, { encoder: 'h264_nvenc', tonemap: 'zscale' },
    { encoder: 'libopenh264', tonemap: 'libplacebo' }, { encoder: 'libopenh264', tonemap: 'tonemap_opencl' }, { encoder: 'libopenh264', tonemap: 'zscale' },
    { encoder: 'libopenh264', tonemap: null }
  ])
  assert.deepEqual(hls.buildLadder(['h264_vaapi', 'libopenh264'], true, ['tonemap_vaapi', 'tonemap_opencl', 'zscale']), [
    { encoder: 'h264_vaapi', tonemap: 'tonemap_vaapi' }, { encoder: 'h264_vaapi', tonemap: 'zscale' },
    { encoder: 'libopenh264', tonemap: 'tonemap_opencl' }, { encoder: 'libopenh264', tonemap: 'zscale' }, { encoder: 'libopenh264', tonemap: null }
  ])
  assert.deepEqual(hls.buildLadder(['libopenh264'], true, []), [{ encoder: 'libopenh264', tonemap: null }], 'no method proven: safe plain conversion')
  assert.deepEqual(hls.buildLadder(['h264_nvenc', 'libopenh264'], false, ['zscale']), [{ encoder: 'h264_nvenc', tonemap: null }, { encoder: 'libopenh264', tonemap: null }], 'SDR: no tone-map steps')

  // A GPU tone-map that fails at run time falls to the next method on the SAME encoder - and the
  // graphics card is not blamed for a filter problem.
  const h = harness((args, { enc }) => (/libplacebo/.test(vfOf(args)) ? FAIL('Error reinitializing filters!\nFailed to create Vulkan device') : OK(args)))
  try {
    const s = h.m.open(spec({ tracks: TRACKS(true), encoder: 'h264_nvenc', chain: ['h264_nvenc', 'libopenh264'], tonemapMethods: ['libplacebo', 'zscale'] }))
    await h.m.segment(s, 0)
    assert.deepEqual(encoders(h), ['h264_nvenc', 'h264_nvenc'])
    assert.match(vfOf(h.spawn.calls[0].args), /libplacebo/)
    assert.match(vfOf(h.spawn.calls[1].args), /zscale=t=linear/)
    assert.equal(s.tonemapMethod, 'zscale')
    assert.deepEqual(h.events.failed, [], 'a filter failure does not count against the encoder')
    assert.equal(h.logs.filter((l) => /continuing with/.test(l)).length, 1)
  } finally { h.cleanup() }

  // Nothing tone-maps: the last step plays the film with plain colours instead of dying.
  const g = harness((args) => (/zscale|libplacebo/.test(vfOf(args)) ? FAIL('Impossible to convert between the formats supported by the filter') : OK(args)))
  try {
    const s = g.m.open(spec({ tracks: TRACKS(true), encoder: 'libopenh264', chain: ['libopenh264'], tonemapMethods: ['libplacebo', 'zscale'] }))
    const file = await g.m.segment(s, 0)
    assert.ok(fs.existsSync(file))
    assert.equal(g.spawn.calls.length, 3)
    assert.doesNotMatch(vfOf(g.spawn.calls[2].args), /zscale|libplacebo|tonemap/)
  } finally { g.cleanup() }
})

test('legacy open({ encoder, tonemap: true }) still works: a chain of one, zscale for HDR', async () => {
  const h = harness((args) => OK(args))
  try {
    const s = h.m.open(spec({ tracks: TRACKS(true), encoder: 'libx264', tonemap: true }))
    await h.m.segment(s, 0)
    assert.equal(encoders(h)[0], 'libx264')
    assert.match(vfOf(h.spawn.calls[0].args), /tonemap=tonemap=hable/)
    assert.deepEqual(s.ladder.map((a) => a.tonemap), ['zscale', null])
  } finally { h.cleanup() }
})

test('ffmpeg runs at below-normal priority (not on a fake pid 0), with the old-PC profile applied', async () => {
  const h = harness((args) => OK(args), { profile: () => ({ tier: 'low', threads: 1, filterThreads: 1, x264Preset: 'ultrafast', scaleFlags: 'bilinear', openh264Cheap: true }) })
  try {
    const s = h.m.open(spec())
    await h.m.segment(s, 0)
    assert.deepEqual(h.priorities, [4242], 'lowered once, for the child')
    const a = h.spawn.calls[0].args
    assert.equal(a[a.indexOf('-threads') + 1], '1')
    assert.ok(a.includes('-loopfilter'))
  } finally { h.cleanup() }
  // The real default lowers the priority through os.setPriority and ignores a pid that is not a real one.
  const before = os.getPriority(0)
  const d = hls.createTranscodeManager({ ffmpegPath: 'ffmpeg', tmpRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-fb-')), sweepEveryMs: 0, pollMs: 4, spawnFn: () => { throw new Error('unused') } })
  d.closeAll()
  assert.equal(os.getPriority(0), before, 'the app itself was never re-niced')
})

// ------------------------------------------------------ the waiting line
test('over the limit: an ETA-less first-come-first-served line, places held, expiring, never jumped', () => {
  const h = harness(() => ({ hang: true }), { maxConcurrent: 1, queueTtlMs: 30000, reserveMs: 20000 })
  try {
    const { m, clock } = h
    assert.deepEqual(m.admit('u1', 'movie|a'), { ok: true }, 'a free slot is held for the first viewer')
    let r = m.admit('u2', 'movie|b')
    assert.deepEqual([r.ok, r.position, r.waiting], [false, 1, 1])
    r = m.admit('u3', 'movie|c')
    assert.deepEqual([r.ok, r.position, r.waiting], [false, 2, 2])
    r = m.admit('u2', 'movie|b')
    assert.deepEqual([r.ok, r.position, r.waiting], [false, 1, 2], 'asking again keeps the place')
    // u1 starts: the held place becomes a real conversion; the line is unchanged.
    const s1 = m.open(spec({ key: 'a', owner: 'u1', fileKey: 'movie|a' }))
    assert.equal(m.admit('u2', 'movie|b').ok, false)
    assert.equal(m.load().queued, 2)
    // u1 finishes. u3 asks first but u2 was ahead: u3 does not jump the line.
    m.close(s1.key)
    r = m.admit('u3', 'movie|c')
    assert.deepEqual([r.ok, r.position], [false, 2])
    assert.deepEqual(m.admit('u2', 'movie|b'), { ok: true })
    r = m.admit('u3', 'movie|c')
    assert.deepEqual([r.ok, r.position], [false, 1], 'u2 holds the slot; u3 is next')
    // Nobody else can grab u2's held slot by opening directly...
    assert.throws(() => m.open(spec({ key: 'x', owner: 'u9', fileKey: 'movie|z' })), (e) => e.code === 'busy')
    // ...but if u2 never turns up, the held place frees itself.
    clock.t += 21000
    assert.deepEqual(m.admit('u3', 'movie|c'), { ok: true })
    // A viewer who stopped asking for a while has left the line.
    m.leaveLine('u3', 'movie|c')
    m.open(spec({ key: 'c', owner: 'u3', fileKey: 'movie|c' }))
    m.admit('u4', 'movie|d')
    clock.t += 5000
    m.admit('u5', 'movie|e')
    clock.t += 26000
    m.get('c').lastAccess = clock.t // u3 is still watching
    r = m.admit('u5', 'movie|e')
    assert.deepEqual([r.ok, r.position, r.waiting], [false, 1, 1], 'u4 timed out of the line, u5 kept asking')
  } finally { h.cleanup() }
})

test('busy answers: BusyError names the line; switching quality on what you already watch never queues you behind others', () => {
  const h = harness(() => ({ hang: true }), { maxConcurrent: 1 })
  try {
    const { m } = h
    m.open(spec({ key: 'a', owner: 'u1', fileKey: 'movie|a' }))
    assert.equal(m.hasSlotFor('u2', 'movie|b'), false)
    assert.equal(m.admit('u2', 'movie|b').ok, false)
    // u1 changes 720p -> 480p: their own slot is theirs, u2 (waiting) does not get in front.
    assert.deepEqual(m.admit('u1', 'movie|a'), { ok: true })
    const s2 = m.open(spec({ key: 'a2', owner: 'u1', fileKey: 'movie|a', quality: '720p' }))
    assert.ok(s2)
    assert.equal(m.get('a'), null, 'their old conversion made way')
    const err = new hls.BusyError(2, 3)
    assert.equal(err.code, 'busy')
    assert.match(err.message, /server is busy right now/)
    assert.match(err.message, /number 3 in line/)
    assert.doesNotMatch(new hls.BusyError(2).message, /in line/)
    // closeOwner (a viewer stopping) also takes them out of the line.
    m.admit('u3', 'movie|c')
    assert.equal(m.load().queued, 2)
    m.closeOwner('u3')
    assert.equal(m.load().queued, 1)
  } finally { h.cleanup() }
})

test('load readout: running / allowed / waiting, which encoders, how many switched', async () => {
  const h = harness((args, { enc }) => (enc === 'h264_nvenc' ? FAIL('Cannot load nvcuda.dll') : OK(args)), { maxConcurrent: 2 })
  try {
    assert.deepEqual(h.m.load(), { active: 0, running: 0, max: 2, queued: 0, encoders: {}, hardware: false, fallbacks: 0 })
    const s = h.m.open(spec({ encoder: 'h264_nvenc', chain: ['h264_nvenc', 'libopenh264'] }))
    await h.m.segment(s, 0)
    h.m.open(spec({ key: 'k2', owner: 'u2', fileKey: 'movie|b' }))
    h.m.admit('u3', 'movie|c')
    const l = h.m.load()
    assert.equal(l.active, 2)
    assert.equal(l.running, 1)
    assert.equal(l.max, 2)
    assert.equal(l.queued, 1)
    assert.equal(l.fallbacks, 1)
    assert.equal(l.hardware, false, 'the film that started on the graphics card is now on the processor')
    assert.deepEqual(l.encoders, { libopenh264: 2 })
    const row = h.m.list().find((x) => x.key === 'k1')
    assert.equal(row.encoder, 'libopenh264')
    assert.equal(row.fallbacks, 1)
    assert.equal(row.file, 'Secret Film (2020).mkv')
  } finally { h.cleanup() }
})

test('server dashboard: "Transcode load" rides along in health, and a live conversion is matched to its viewer', () => {
  const dash = dashboard.createServerDashboard({ store: { get: () => undefined, set: () => {} } })
  assert.equal(dash.health().transcode, null, 'no transcoder wired: nothing shown')
  dash.setHooks({ getTranscodeLoad: () => ({ active: 2, running: 1, max: 2, queued: 1, hardware: true, fallbacks: 3, encoders: { h264_nvenc: 2 } }) })
  assert.deepEqual(dash.health().transcode, { active: 2, running: 1, max: 2, queued: 1, hardware: true, fallbacks: 3 })
  dash.setHooks({ getTranscodeLoad: () => { throw new Error('x') } })
  assert.equal(dash.health().transcode, null, 'a broken hook reads as unknown')

  // Now playing: a viewer whose film is being converted (no direct stream) shows as converting.
  const t = Date.now()
  const entry = { sessionId: 's1', userId: 'u1', userName: 'Nick', kind: 'movie', fileName: 'Heat (1995).mp4', title: 'Heat', startedAt: t - 60000, lastUpdate: t - 1000, currentTime: 600, duration: 6000 }
  const live = dashboard.createServerDashboard({ store: { get: () => undefined, set: () => {} }, history: { getHistory: () => [entry], getPendingSessions: () => [] } })
  assert.equal(live.nowPlaying()[0].playback, 'direct')
  live.setTranscodeProvider(() => [{ owner: 'u1', filePath: path.join(os.tmpdir(), 'Movies', 'Heat (1995).mp4'), label: 'Converting to 480p (graphics card)', reason: 'Quality 480p', videoCodec: 'h264', audioCodec: 'aac' }])
  const row = live.nowPlaying()[0]
  assert.equal(row.playback, 'transcode')
  assert.equal(row.playbackLabel, 'Converting to 480p (graphics card)')
  live.setTranscodeProvider(() => [{ owner: 'someone-else', filePath: path.join(os.tmpdir(), 'Movies', 'Heat (1995).mp4'), label: 'x' }])
  assert.equal(live.nowPlaying()[0].playback, 'direct', 'another person\'s conversion of the same film is not this viewer\'s')
})
