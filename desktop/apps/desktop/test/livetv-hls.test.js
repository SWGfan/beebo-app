// Live TV, watching: the ffmpeg command, the live playlist, tickets, and (when ffmpeg exists) a real
// tuner -> HLS run against the fake HDHomeRun. Run: node --test test/livetv-hls.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const { createRequire } = require('node:module')
const fake = require('./helpers/fakeHdhr')

const localRequire = createRequire(path.join(path.resolve(__dirname, '..'), 'package.json'))
const live = localRequire('./electron/liveTv/liveHls')
const hls = localRequire('./electron/hlsTranscoder')
const { createTunerPool, TunerBusyError } = localRequire('./electron/liveTv/tunerPool')

const FFMPEG = fake.findFfmpeg()
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-livetv-test-'))
const chan = (key = '2.1', devices = ['1A2B3C4D']) => ({ key, guideNumber: key, name: 'KTST', devices })
const argAfter = (args, flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined }

test('ffmpeg command: stdin MPEG-TS in, de-interlaced H.264 + stereo AAC out, 2 s pieces, key frames on the boundary', () => {
  const args = live.buildLiveArgs({ encoder: 'libx264', quality: '720p', outDir: '/x', run: 0, startNumber: 0, listSize: 60 })
  assert.equal(argAfter(args, '-i'), 'pipe:0')
  assert.equal(argAfter(args, '-f'), 'mpegts')
  const vf = argAfter(args, '-vf')
  assert.match(vf, /^yadif=mode=0:parity=-1:deint=1,/)
  assert.match(vf, /setsar=1/)
  assert.match(vf, /min\(1280,iw\)/)
  assert.match(vf, /format=yuv420p$/)
  assert.equal(argAfter(args, '-c:v'), 'libx264')
  assert.equal(argAfter(args, '-c:a'), 'aac')
  assert.equal(argAfter(args, '-ac'), '2')
  assert.match(argAfter(args, '-af'), /alimiter/)
  assert.equal(argAfter(args, '-hls_time'), '2')
  assert.equal(argAfter(args, '-force_key_frames'), 'expr:gte(t,n_forced*2)')
  assert.equal(argAfter(args, '-hls_list_size'), '60')
  assert.ok(args.includes('0:a:0?'), 'audio is optional')
  assert.equal(args[args.length - 1], path.join('/x', 'run-0.m3u8'))
  assert.match(argAfter(live.buildLiveArgs({ encoder: 'h264_qsv', quality: '480p', outDir: '/x' }), '-vf'), /format=nv12$/)
  assert.throws(() => live.buildLiveArgs({ encoder: 'libx264', quality: '4k', outDir: '/x' }), { code: 'bad_quality' })
})

test('live playlist: sliding window, no ENDLIST while live, discontinuities carried, ENDLIST when the tuner is gone', () => {
  const entries = [{ seq: 10, dur: 2 }, { seq: 11, dur: 2.002 }, { seq: 12, dur: 2, disc: true }, { seq: 13, dur: 2.5 }]
  const text = live.buildLivePlaylist(entries, { discSeq: 3 })
  assert.match(text, /#EXT-X-MEDIA-SEQUENCE:10\n/)
  assert.match(text, /#EXT-X-DISCONTINUITY-SEQUENCE:3\n/)
  assert.match(text, /#EXT-X-TARGETDURATION:3\n/)
  assert.match(text, /#EXT-X-DISCONTINUITY\n#EXTINF:2.000,\nseg-12.ts/)
  assert.ok(!text.includes('ENDLIST'))
  assert.ok(!text.includes('PLAYLIST-TYPE'), 'no EVENT/VOD type: players start at the live edge')
  assert.match(live.buildLivePlaylist(entries, { ended: true }), /#EXT-X-ENDLIST\n$/)
  assert.ok(!live.buildLivePlaylist(entries).includes('DISCONTINUITY-SEQUENCE'))
  assert.match(live.buildLivePlaylist([]), /MEDIA-SEQUENCE:0/)
  assert.deepEqual(live.parseRunPlaylist('#EXTM3U\n#EXTINF:2.000000,\nseg-5.ts\n#EXTINF:1.9,\nseg-6.ts\n#EXTINF:2,\n../etc/passwd\nseg-7.ts\n'), [{ seq: 5, dur: 2 }, { seq: 6, dur: 1.9 }])
})

test('tickets: signed, tamper-proof, path-safe; quality must be a known one', () => {
  const secret = crypto.randomBytes(16).toString('hex')
  const sign = (id) => crypto.createHmac('sha256', secret).update(id).digest('base64url')
  const verify = (id, token) => token === sign(id)
  const t = live.makeLiveTicket(sign, { c: '2.1', q: '720p', u: 'owner', n: 'abc' })
  assert.match(t, /^[A-Za-z0-9_.-]+$/)
  assert.deepEqual(live.readLiveTicket(verify, t), { channel: '2.1', quality: '720p', userId: 'owner', nonce: 'abc' })
  assert.equal(live.readLiveTicket(verify, t.slice(0, -2) + 'xx'), null)
  const [payload, sig] = t.split('.')
  const forged = Buffer.from(JSON.stringify({ v: 1, c: '9.1', q: '720p', u: 'owner' })).toString('base64url')
  assert.equal(live.readLiveTicket(verify, forged + '.' + sig), null)
  assert.equal(live.readLiveTicket(verify, live.makeLiveTicket(sign, { c: '2.1', q: '4k', u: 'x' })), null)
  assert.equal(live.readLiveTicket(verify, ''), null)
  assert.equal(live.readLiveTicket(verify, 'x'.repeat(2000)), null)
  assert.equal(live.readLiveTicket(verify, payload), null)
})

// ---------------------------------------------------------- a fake ffmpeg
function fakeSpawn(record) {
  return (exe, args) => {
    const child = new EventEmitter()
    child.pid = 1
    child.stdin = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => { child.emit('exit', null) }
    const dir = path.dirname(args[args.length - 1])
    const run = path.basename(args[args.length - 1])
    const start = Number(argAfter(args, '-start_number'))
    record.runs.push({ start, run })
    let n = 0
    child.timer = setInterval(() => {
      const seq = start + n++
      fs.writeFileSync(path.join(dir, `seg-${seq}.ts`), Buffer.alloc(1000, 1))
      const lines = ['#EXTM3U']
      for (let i = 0; i < n; i++) lines.push('#EXTINF:2.000000,', `seg-${start + i}.ts`)
      fs.writeFileSync(path.join(dir, run), lines.join('\n') + '\n')
    }, 20)
    child.on('exit', () => clearInterval(child.timer))
    record.children.push(child)
    return child
  }
}

async function harness(t, { tunerCount = 2, spawnFn, encoder = { encoder: 'libx264', label: 'x264' }, ...opts } = {}) {
  const dev = await fake.createFakeHdhr({ real: false, tunerCount })
  const root = tmp()
  const pool = createTunerPool({ getDevices: () => [dev.device()] })
  const mgr = live.createLiveHls({ pool, ffmpegPath: 'ffmpeg', getEncoder: async () => encoder, tmpRoot: root, sweepEveryMs: 0, spawnFn, waitTimeoutMs: 3000, pollMs: 20, ...opts })
  t.after(async () => { mgr.closeAll(); pool.closeAll(); await dev.close(); fs.rmSync(root, { recursive: true, force: true }) })
  return { dev, pool, mgr, root }
}

test('session: viewers of one channel share a session and a tuner; pieces appear; playlist is a live window; last viewer leaving frees the tuner', async (t) => {
  const rec = { runs: [], children: [] }
  const { dev, mgr } = await harness(t, { spawnFn: fakeSpawn(rec) })
  const a = await mgr.open({ channel: chan(), quality: '720p', userId: 'u1', nonce: 'A' })
  const b = await mgr.open({ channel: chan(), quality: '720p', userId: 'u2', nonce: 'B' })
  assert.equal(a.key, b.key)
  assert.equal(dev.activeStreams(), 1)
  assert.equal(rec.runs.length, 1, 'one ffmpeg for both viewers')
  assert.equal(await mgr.ready(a), true)
  const text = mgr.playlist(a, 'A')
  assert.match(text, /#EXTINF:2.000,\nseg-0.ts/)
  assert.ok(!text.includes('ENDLIST'))
  assert.ok(mgr.segmentFile(a, 0, 'A').endsWith('seg-0.ts'))
  assert.equal(mgr.segmentFile(a, 9999, 'A'), null)
  assert.equal(mgr.info(a).viewers, 2)
  mgr.leave(a.key, 'A')
  assert.equal(mgr.get(a.key) !== null, true, 'still one viewer')
  assert.equal(dev.activeStreams(), 1)
  const dir = a.dir
  mgr.leave(a.key, 'B')
  assert.equal(mgr.get(a.key), null)
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(dev.activeStreams(), 0, 'tuner released')
  assert.equal(rec.children.length, 1)
  await new Promise((r) => setTimeout(r, 900))
  assert.equal(fs.existsSync(dir), false, 'session folder removed')
})

test('session: a different channel takes the second tuner, a third is refused politely', async (t) => {
  const { mgr } = await harness(t, { spawnFn: fakeSpawn({ runs: [], children: [] }) })
  await mgr.open({ channel: chan('2.1'), quality: '720p', userId: 'u', nonce: 'a' })
  await mgr.open({ channel: chan('4.1'), quality: '720p', userId: 'u', nonce: 'b' })
  await assert.rejects(mgr.open({ channel: chan('9.1'), quality: '720p', userId: 'u', nonce: 'c' }), (e) => e instanceof TunerBusyError && /All 2 tuners are busy/.test(e.message))
})

test('session: rolling window drops the oldest pieces (and counts dropped discontinuities), disk cap is honoured', async (t) => {
  const rec = { runs: [], children: [] }
  const { mgr } = await harness(t, { spawnFn: fakeSpawn(rec), settings: () => ({ timeshiftMinutes: 5, timeshiftMaxMB: 512 }) })
  const s = await mgr.open({ channel: chan(), quality: '720p', userId: 'u', nonce: 'A' })
  await mgr.ready(s)
  const dir = s.dir
  for (let i = 0; i < 200; i++) fs.writeFileSync(path.join(dir, `seg-${1000 + i}.ts`), Buffer.alloc(10, 1))
  s.index.set(999, { seq: 999, dur: 2, size: 10, disc: true })
  for (let i = 0; i < 200; i++) s.index.set(1000 + i, { seq: 1000 + i, dur: 2, size: 10, disc: false })
  const text = mgr.playlist(s, 'A')
  const seqs = [...text.matchAll(/^seg-(\d+)\.ts$/gm)].map((m) => Number(m[1]))
  assert.ok(seqs.length <= 150, 'five minutes of 2 s pieces at most: ' + seqs.length)
  assert.equal(seqs[seqs.length - 1] >= 1199, true)
  assert.match(text, /#EXT-X-DISCONTINUITY-SEQUENCE:1/, 'the dropped discontinuity is counted')
  assert.equal(fs.existsSync(path.join(dir, 'seg-1000.ts')), false, 'old piece deleted from disk')
  s.index.clear()
  const small = 3
  for (let i = 0; i < 20; i++) s.index.set(5000 + i, { seq: 5000 + i, dur: 2, size: 200 * 1024 * 1024, disc: false })
  const t2 = mgr.playlist(s, 'A')
  assert.ok([...t2.matchAll(/^seg-(\d+)\.ts$/gm)].length <= 3 + small, 'the disk cap shrinks the window')
})

test('session: preempted by a recording, the viewers are told and the playlist ends', async (t) => {
  const { mgr, pool } = await harness(t, { tunerCount: 1, spawnFn: fakeSpawn({ runs: [], children: [] }) })
  const s = await mgr.open({ channel: chan('2.1'), quality: '720p', userId: 'u', nonce: 'A' })
  await mgr.ready(s)
  const rec = await pool.acquire({ channel: chan('4.1'), purpose: 'record', label: 'News' })
  assert.equal(s.state, 'ended')
  assert.equal(s.endReason, 'needed_for_recording')
  assert.match(mgr.playlist(s, 'A'), /ENDLIST/)
  assert.match(mgr.info(s).endMessage, /recording/)
  rec.release()
})

test('session: idle viewers are dropped and the tuner released; a paused-forever viewer is dropped too', async (t) => {
  let clock = 1000000
  const { dev, mgr } = await harness(t, { spawnFn: fakeSpawn({ runs: [], children: [] }), now: () => clock, viewerIdleMs: 45000, pausedReleaseMs: 20 * 60 * 1000 })
  const s = await mgr.open({ channel: chan(), quality: '720p', userId: 'u', nonce: 'A' })
  await mgr.ready(s)
  clock += 30000
  mgr.playlist(s, 'A')
  mgr.sweep()
  assert.equal(mgr.size(), 1, 'still polling')
  clock += 44000
  mgr.playlist(s, 'A')
  mgr.sweep()
  assert.equal(mgr.size(), 1)
  clock += 21 * 60 * 1000
  mgr.playlist(s, 'A')
  mgr.sweep()
  assert.equal(mgr.size(), 0, 'polling the playlist forever without ever fetching a piece is paused-forever')
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(dev.activeStreams(), 0)
  const s2 = await mgr.open({ channel: chan(), quality: '720p', userId: 'u', nonce: 'A' })
  clock += 60000
  mgr.sweep()
  assert.equal(mgr.size(), 0, 'nobody asked for 60 s')
  assert.equal(s2.closed, true)
})

test('session: ffmpeg dying is restarted with a discontinuity and numbering continues; too many restarts end the session', async (t) => {
  const rec = { runs: [], children: [] }
  const { mgr } = await harness(t, { spawnFn: fakeSpawn(rec), maxRestarts: 2, earlyFailMs: 0 })
  const s = await mgr.open({ channel: chan(), quality: '720p', userId: 'u', nonce: 'A' })
  await mgr.ready(s)
  await new Promise((r) => setTimeout(r, 150))
  const first = rec.children[0]
  const before = mgr.playlist(s, 'A').match(/seg-(\d+)\.ts/g).length
  s.restarts = []
  first.emit('exit', 1)
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(rec.runs.length, 2, 'restarted')
  assert.ok(rec.runs[1].start > 0, 'numbering continues')
  const text = mgr.playlist(s, 'A')
  assert.match(text, /#EXT-X-DISCONTINUITY\n#EXTINF:2.000,\nseg-\d+\.ts/)
  assert.ok(text.match(/seg-(\d+)\.ts/g).length > before)
  assert.equal(s.state, 'running')
})

// Encoders in a chain: a graphics encoder that dies at once (other programs using Quick Sync) or hangs
// hands the SAME session to the next one, software last - the viewer never sees "tuner ended".
function chainSpawn(rec, behaviour) {
  const good = fakeSpawn(rec)
  return (exe, args) => {
    const enc = argAfter(args, '-c:v')
    rec.encoders.push(enc)
    const how = behaviour[enc]
    if (!how) return good(exe, args)
    const child = new EventEmitter()
    child.pid = 1
    child.stdin = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => { child.killed = true; setImmediate(() => child.emit('exit', null)) }
    if (how === 'exit') setTimeout(() => { child.stderr.write('Error initializing an internal MFX session\n'); child.emit('exit', 1) }, 10)
    rec.children.push(child)
    return child
  }
}

test('live encoder chain: a hardware encoder that exits early with no pieces falls back to the next encoder, software last', async (t) => {
  const rec = { runs: [], children: [], encoders: [] }
  const logs = []
  const { dev, mgr } = await harness(t, {
    spawnFn: chainSpawn(rec, { h264_qsv: 'exit', h264_nvenc: 'exit' }), log: (l) => logs.push(l),
    encoder: { encoder: 'h264_nvenc', chain: ['h264_nvenc', 'h264_qsv', 'libx264'], label: 'x' }
  })
  const s = await mgr.open({ channel: chan(), quality: '720p', userId: 'u', nonce: 'A' })
  assert.equal(await mgr.ready(s), true, 'pieces appear on the encoder that works')
  assert.deepEqual(rec.encoders, ['h264_nvenc', 'h264_qsv', 'libx264'])
  assert.equal(s.state, 'running', 'not "tuner ended"')
  assert.equal(s.encoder, 'libx264')
  assert.equal(s.fallbacks, 2)
  assert.equal(logs.filter((l) => /stopped .* - continuing with/.test(l)).length, 2)
  assert.equal(dev.activeStreams(), 1, 'the tuner stayed with the session')
  assert.equal(mgr.info(s).state, 'running')
})

test('live encoder chain: a graphics encoder that hangs with no picture is killed and replaced; the last encoder is never given up on', async (t) => {
  const rec = { runs: [], children: [], encoders: [] }
  const events = { failed: [], ok: [] }
  const { mgr } = await harness(t, {
    spawnFn: chainSpawn(rec, { h264_qsv: 'hang' }), hwStallMs: 60,
    encoder: { encoder: 'h264_qsv', chain: ['h264_qsv', 'libx264'], noteFailure: (id) => events.failed.push(id), noteSuccess: (id) => events.ok.push(id) }
  })
  const s = await mgr.open({ channel: chan(), quality: '720p', userId: 'u', nonce: 'A' })
  assert.equal(await mgr.ready(s), true)
  assert.deepEqual(rec.encoders, ['h264_qsv', 'libx264'])
  assert.equal(rec.children[0].killed, true)
  assert.deepEqual(events.failed, ['h264_qsv'])
  assert.deepEqual(events.ok, ['libx264'])
  // With nothing left to fall back to, an early exit ends the session exactly as before.
  const rec2 = { runs: [], children: [], encoders: [] }
  const h2 = await harness(t, { spawnFn: chainSpawn(rec2, { libx264: 'exit' }), encoder: { encoder: 'libx264', chain: ['libx264'] }, earlyFailMs: 4000 })
  const s2 = await h2.mgr.open({ channel: chan(), quality: '720p', userId: 'u', nonce: 'A' })
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(s2.state, 'ended')
  assert.equal(s2.endReason, 'encoder_failed')
})

// A hand-driven tuner: the test writes the bytes and closes the stream itself, so the tuner closing in
// the same moment as an encoder crash (the pipe closing looks identical from ffmpeg's side) can be staged.
function drivenTuner() {
  const t = { consumer: null, live: true, released: false }
  const lease = { subscribe: (c) => { t.consumer = c; return () => {} }, release: () => { t.released = true }, isLive: () => t.live }
  t.pool = { acquire: async () => lease }
  return t
}
// ffmpeg stand-in: `how[encoder]` = 'crash' (stderr text + exit 1 after a moment, no pieces) or 'healthy'
// (makes pieces from what it is fed; exits 0 once its input is closed). Records what each encoder was fed.
function drivenSpawn(rec, how) {
  return (exe, args) => {
    const enc = argAfter(args, '-c:v')
    const dir = path.dirname(args[args.length - 1])
    const run = path.basename(args[args.length - 1])
    const start = Number(argAfter(args, '-start_number'))
    const child = new EventEmitter()
    child.pid = 1
    child.stdin = new PassThrough()
    child.stderr = new PassThrough()
    const fed = { encoder: enc, bytes: 0, ended: false }
    rec.fed.push(fed)
    child.stdin.on('data', (d) => { fed.bytes += d.length })
    child.stdin.on('end', () => { fed.ended = true })
    child.stdin.on('error', () => {})
    child.kill = () => { child.killed = true; setImmediate(() => child.emit('exit', null)) }
    child.stdin.resume()
    const mode = how[enc] || 'healthy'
    if (mode === 'crash') {
      setTimeout(() => { child.stderr.write('[h264_qsv @ 0000] Error initializing an internal MFX session: unsupported (-3)\n'); child.emit('exit', 1) }, 30)
    } else {
      child.stdin.on('end', () => {
        fs.writeFileSync(path.join(dir, `seg-${start}.ts`), Buffer.alloc(1000, 1))
        fs.writeFileSync(path.join(dir, run), `#EXTM3U\n#EXTINF:2.000000,\nseg-${start}.ts\n`)
        setTimeout(() => child.emit('exit', 0), 10)
      })
    }
    return child
  }
}

test('live: the tuner closing in the same moment as an encoder crash is an ENCODER failure - the next encoder gets the kept start of the stream', async (t) => {
  const rec = { fed: [] }
  const tuner = drivenTuner()
  const root = tmp()
  const logs = []
  const mgr = live.createLiveHls({
    pool: tuner.pool, ffmpegPath: 'ffmpeg', tmpRoot: root, sweepEveryMs: 0, pollMs: 10, waitTimeoutMs: 3000, log: (l) => logs.push(l),
    spawnFn: drivenSpawn(rec, { h264_qsv: 'crash' }), getEncoder: async () => ({ encoder: 'h264_qsv', chain: ['h264_qsv', 'libx264'] })
  })
  t.after(() => { mgr.closeAll(); fs.rmSync(root, { recursive: true, force: true }) })
  const s = await mgr.open({ channel: chan(), quality: '480p', userId: 'u', nonce: 'A' })
  tuner.consumer.write(Buffer.alloc(188 * 50, 0x47))
  tuner.consumer.write(Buffer.alloc(188 * 50, 0x47))
  tuner.live = false
  tuner.consumer.end({ code: 'tuner_ended', message: 'The tuner stopped the stream.' }) // pipe closes at once ...
  for (let i = 0; i < 100 && s.state !== 'ended'; i++) await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(rec.fed.map((f) => f.encoder), ['h264_qsv', 'libx264'], '... yet the crash is told from the tuner ending, and the software encoder takes over')
  assert.equal(rec.fed[1].bytes, 188 * 100, 'the next encoder was given the start of the stream again')
  assert.equal(rec.fed[1].ended, true, 'and its input closed, because the tuner had')
  assert.equal(s.fallbacks, 1)
  assert.equal(s.state, 'ended')
  assert.equal(s.endReason, 'tuner_ended', 'it made pieces, so this is a genuine tuner end')
  assert.equal(mgr.info(s).pieces, 1)
  assert.equal(logs.filter((l) => /stopped .* - continuing with/.test(l)).length, 1)
})

test('live: a real tuner end (input closes while ffmpeg is healthy) stays a tuner end - no fallback, no blame on the encoder', async (t) => {
  const rec = { fed: [] }
  const tuner = drivenTuner()
  const root = tmp()
  const mgr = live.createLiveHls({
    pool: tuner.pool, ffmpegPath: 'ffmpeg', tmpRoot: root, sweepEveryMs: 0, pollMs: 10, waitTimeoutMs: 3000,
    spawnFn: drivenSpawn(rec, {}), getEncoder: async () => ({ encoder: 'h264_qsv', chain: ['h264_qsv', 'libx264'] })
  })
  t.after(() => { mgr.closeAll(); fs.rmSync(root, { recursive: true, force: true }) })
  const s = await mgr.open({ channel: chan(), quality: '480p', userId: 'u', nonce: 'A' })
  tuner.consumer.write(Buffer.alloc(188 * 50, 0x47))
  tuner.consumer.end({ code: 'tuner_ended', message: 'The tuner stopped the stream.' })
  for (let i = 0; i < 100 && s.state !== 'ended'; i++) await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(rec.fed.map((f) => f.encoder), ['h264_qsv'])
  assert.equal(s.endReason, 'tuner_ended')
  assert.equal(s.fallbacks, 0)
  // A tuner that sent nothing at all is a tuner problem, immediately.
  const rec2 = { fed: [] }
  const t2 = drivenTuner()
  const mgr2 = live.createLiveHls({ pool: t2.pool, ffmpegPath: 'ffmpeg', tmpRoot: tmp(), sweepEveryMs: 0, spawnFn: drivenSpawn(rec2, {}), getEncoder: async () => ({ encoder: 'h264_qsv', chain: ['h264_qsv', 'libx264'] }) })
  t.after(() => mgr2.closeAll())
  const s2 = await mgr2.open({ channel: chan('4.1'), quality: '480p', userId: 'u', nonce: 'A' })
  t2.consumer.end({ code: 'tuner_ended', message: 'The tuner stopped the stream.' })
  assert.equal(s2.state, 'ended')
  assert.equal(s2.endReason, 'tuner_ended')
  assert.equal(mgr2.info(s2).bytesIn, 0)
})

test('live: with every encoder crashing the session ends as an encoder failure, not a tuner end', async (t) => {
  const rec = { fed: [] }
  const tuner = drivenTuner()
  const root = tmp()
  const mgr = live.createLiveHls({
    pool: tuner.pool, ffmpegPath: 'ffmpeg', tmpRoot: root, sweepEveryMs: 0, pollMs: 10, waitTimeoutMs: 3000,
    spawnFn: drivenSpawn(rec, { h264_qsv: 'crash', libx264: 'crash' }), getEncoder: async () => ({ encoder: 'h264_qsv', chain: ['h264_qsv', 'libx264'] })
  })
  t.after(() => { mgr.closeAll(); fs.rmSync(root, { recursive: true, force: true }) })
  const s = await mgr.open({ channel: chan(), quality: '480p', userId: 'u', nonce: 'A' })
  tuner.consumer.write(Buffer.alloc(188 * 50, 0x47))
  tuner.consumer.end({ code: 'tuner_ended', message: 'The tuner stopped the stream.' })
  for (let i = 0; i < 100 && s.state !== 'ended'; i++) await new Promise((r) => setTimeout(r, 20))
  assert.equal(s.endReason, 'encoder_failed')
  assert.deepEqual(rec.fed.map((f) => f.encoder), ['h264_qsv', 'libx264'])
})

test('live ffmpeg command: VAAPI opens its render node and uploads frames; Quick Sync reads NV12', () => {
  const va = live.buildLiveArgs({ encoder: 'h264_vaapi', quality: '480p', outDir: '/x', device: '/dev/dri/renderD129' })
  assert.deepEqual(va.slice(va.indexOf('-init_hw_device'), va.indexOf('-init_hw_device') + 4), ['-init_hw_device', 'vaapi=va:/dev/dri/renderD129', '-filter_hw_device', 'va'])
  assert.ok(va.indexOf('-init_hw_device') < va.indexOf('-i'))
  assert.match(argAfter(va, '-vf'), /format=nv12,hwupload$/)
  assert.equal(argAfter(va, '-c:v'), 'h264_vaapi')
  assert.equal(live.buildLiveArgs({ encoder: 'libx264', quality: '480p', outDir: '/x' }).includes('-init_hw_device'), false)
})

test('no encoder or no ffmpeg: a plain-words error, no tuner taken', async (t) => {
  const h1 = await harness(t, { spawnFn: fakeSpawn({ runs: [], children: [] }), encoder: { encoder: null } })
  await assert.rejects(h1.mgr.open({ channel: chan(), quality: '720p', userId: 'u', nonce: 'A' }), { code: 'no_encoder' })
  assert.equal(h1.dev.activeStreams(), 0)
  const h2 = await harness(t, { spawnFn: fakeSpawn({ runs: [], children: [] }), ffmpegPath: () => null })
  await assert.rejects(h2.mgr.open({ channel: chan(), quality: '720p', userId: 'u', nonce: 'A' }), { code: 'no_ffmpeg' })
  assert.equal(h2.dev.activeStreams(), 0)
})

// ------------------------------------------------- the real thing (ffmpeg needed)
test('REAL ffmpeg: fake tuner MPEG-TS becomes a playable live HLS with 2 s pieces', { skip: !FFMPEG && 'ffmpeg not available', timeout: 240000 }, async (t) => {
  const probe = await hls.probeEncoders({ ffmpegPath: FFMPEG })
  if (!probe.encoder) return t.skip('no H.264-class encoder in this ffmpeg')
  const dev = await fake.createFakeHdhr({ real: true, tunerCount: 2 })
  const root = tmp()
  const pool = createTunerPool({ getDevices: () => [dev.device()] })
  const mgr = live.createLiveHls({ pool, ffmpegPath: FFMPEG, getEncoder: async () => probe, tmpRoot: root, sweepEveryMs: 0, waitTimeoutMs: 150000 })
  t.after(async () => { mgr.closeAll(); pool.closeAll(); await dev.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const s = await mgr.open({ channel: chan(), quality: '480p', userId: 'u', nonce: 'A' })
  assert.equal(await mgr.ready(s), true, 'first pieces appear')
  for (let i = 0; i < 400 && mgr.info(s).pieces < 4; i++) await new Promise((r) => setTimeout(r, 200))
  const text = mgr.playlist(s, 'A')
  const pieces = [...text.matchAll(/#EXTINF:([0-9.]+),\n(seg-\d+\.ts)/g)]
  assert.ok(pieces.length >= 3, 'several pieces: ' + pieces.length)
  for (const p of pieces.slice(0, -1)) assert.ok(Math.abs(Number(p[1]) - 2) < 0.7, 'about 2 s each: ' + p[1])
  const file = mgr.segmentFile(s, Number(/seg-(\d+)/.exec(pieces[0][2])[1]), 'A')
  const buf = fs.readFileSync(file)
  assert.equal(buf[0], 0x47, 'a real MPEG-TS piece')
  const ffprobe = require('../electron/convert').ffprobePath() || 'ffprobe'
  const r = require('node:child_process').spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_name,codec_type,width,height', '-of', 'json', file], { encoding: 'utf8' })
  if (r.status === 0) {
    const streams = JSON.parse(r.stdout).streams
    assert.ok(streams.some((x) => x.codec_type === 'video' && /h264|mpeg4/.test(x.codec_name)), 'H.264-class video')
    assert.ok(streams.some((x) => x.codec_type === 'audio' && x.codec_name === 'aac'), 'AAC stereo audio')
  }
  mgr.leave(s.key, 'A')
  await new Promise((r2) => setTimeout(r2, 300))
  assert.equal(dev.activeStreams(), 0, 'tuner released after the viewer left')
})
