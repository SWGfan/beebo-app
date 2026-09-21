// Live HLS conversion (hlsTranscoder.js): sizes, playlist, ffmpeg commands, encoder fallback,
// signed tickets, and the session manager's lifecycle with a fake ffmpeg.
// Run: node --test test/playback-hls.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const crypto = require('node:crypto')
const { createRequire } = require('node:module')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))
const hls = localRequire('./electron/hlsTranscoder')

const TRACKS = {
  durationSec: 61,
  video: { streamIndex: 0, codec: 'hevc', width: 1920, height: 800, fps: 23.976, hdr: false },
  audio: [
    { ordinal: 0, streamIndex: 1, codec: 'eac3', channels: 6, language: 'eng', isDefault: true },
    { ordinal: 1, streamIndex: 2, codec: 'ac3', channels: 2, language: 'fra', isDefault: false }
  ],
  subtitles: [
    { ordinal: 0, streamIndex: 3, codec: 'subrip', kind: 'text' },
    { ordinal: 1, streamIndex: 4, codec: 'hdmv_pgs_subtitle', kind: 'image' }
  ]
}

const argAfter = (args, flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined }
const allAfter = (args, flag) => args.map((a, i) => (a === flag ? args[i + 1] : null)).filter((x) => x != null)

test('outputSize fits the quality box, keeps the shape, never enlarges, stays even', () => {
  assert.deepEqual(hls.outputSize(1920, 1080, '720p'), { width: 1280, height: 720 })
  assert.deepEqual(hls.outputSize(1920, 800, '720p'), { width: 1280, height: 534 })
  assert.deepEqual(hls.outputSize(3840, 1600, '1080p'), { width: 1920, height: 800 })
  assert.deepEqual(hls.outputSize(1280, 720, '1080p'), { width: 1280, height: 720 }, 'no upscale')
  assert.deepEqual(hls.outputSize(720, 576, '480p'), { width: 600, height: 480 })
  assert.deepEqual(hls.outputSize(0, 0, '480p'), { width: -2, height: 480 })
  assert.equal(hls.outputSize(1920, 1080, '4k'), null)
})

test('qualitiesFor marks qualities above the source as upscales', () => {
  const q = hls.qualitiesFor({ width: 1280, height: 720 })
  assert.deepEqual(q.map((x) => x.id), ['1080p', '720p', '480p'])
  assert.equal(q[0].upscale, true)
  assert.equal(q[1].upscale, false)
  assert.equal(q[0].videoKbps, 8000)
  assert.equal(q[1].videoKbps, 4000)
  assert.equal(q[2].videoKbps, 1500)
})

test('the VOD playlist covers the whole film in fixed pieces', () => {
  const text = hls.buildVodPlaylist(10.5, 4)
  const lines = text.trim().split('\n')
  assert.equal(lines[0], '#EXTM3U')
  assert.ok(lines.includes('#EXT-X-PLAYLIST-TYPE:VOD'))
  assert.ok(lines.includes('#EXT-X-TARGETDURATION:5'))
  assert.deepEqual(lines.filter((l) => l.startsWith('seg-')), ['seg-0.ts', 'seg-1.ts', 'seg-2.ts'])
  assert.deepEqual(lines.filter((l) => l.startsWith('#EXTINF')), ['#EXTINF:4.000000,', '#EXTINF:4.000000,', '#EXTINF:2.500000,'])
  assert.equal(lines[lines.length - 1], '#EXT-X-ENDLIST')
  assert.equal(hls.segmentCount(8, 4), 2, 'an exact multiple has no empty tail piece')
  assert.equal(hls.segmentCount(0, 4), 0)
  // A sliver at the end joins the last piece.
  assert.equal(hls.segmentCount(24.02, 4), 6)
  assert.match(hls.buildVodPlaylist(24.02, 4), /#EXTINF:4\.020000,\nseg-5\.ts\n#EXT-X-ENDLIST/)
  assert.equal(hls.segmentCount(24.6, 4), 7)
})

test('ffmpeg command: seek, scale, chosen audio, forced key frames, HLS pieces numbered from the seek', () => {
  const args = hls.buildTranscodeArgs({ input: 'C:/m/film.mkv', tracks: TRACKS, quality: '720p', encoder: 'libx264', audioStreamIndex: 2, startNumber: 10, outDir: '/tmp/s' })
  assert.equal(argAfter(args, '-ss'), '40.000')
  assert.ok(args.indexOf('-ss') < args.indexOf('-i'), 'input seek (fast) before -i')
  assert.equal(argAfter(args, '-i'), 'file:C:/m/film.mkv')
  assert.equal(argAfter(args, '-protocol_whitelist'), 'file,crypto,pipe')
  assert.deepEqual(allAfter(args, '-map').slice(0, 2), ['0:0', '0:2'])
  assert.equal(argAfter(args, '-vf'), 'scale=1280:534,format=yuv420p')
  assert.equal(argAfter(args, '-c:v'), 'libx264')
  assert.equal(argAfter(args, '-preset'), 'veryfast')
  assert.equal(argAfter(args, '-b:v'), '4000k')
  assert.equal(argAfter(args, '-force_key_frames'), 'expr:gte(t,n_forced*4)')
  assert.equal(argAfter(args, '-g'), '96')
  assert.equal(argAfter(args, '-c:a'), 'aac')
  assert.equal(argAfter(args, '-ac'), '2')
  assert.equal(argAfter(args, '-output_ts_offset'), '40.000')
  assert.equal(argAfter(args, '-start_number'), '10')
  assert.equal(argAfter(args, '-hls_segment_type'), 'mpegts')
  assert.match(argAfter(args, '-hls_flags'), /temp_file/)
  assert.equal(argAfter(args, '-hls_segment_filename'), path.join('/tmp/s', 'seg-%d.ts'))
  assert.ok(args.includes('-sn'), 'text subtitles never go into the video')
})

test('ffmpeg command: default audio, no seek at the start, 480p bitrate', () => {
  const args = hls.buildTranscodeArgs({ input: 'f.mp4', tracks: TRACKS, quality: '480p', encoder: 'libx264', outDir: 'o' })
  assert.equal(args.includes('-ss'), false)
  assert.equal(args.includes('-output_ts_offset'), false)
  assert.deepEqual(allAfter(args, '-map').slice(0, 2), ['0:0', '0:1'], 'the default audio track')
  assert.equal(argAfter(args, '-b:v'), '1500k')
  assert.equal(argAfter(args, '-start_number'), '0')
  // Unknown audio index falls back to the default instead of failing.
  const bad = hls.buildTranscodeArgs({ input: 'f.mp4', tracks: TRACKS, quality: '480p', encoder: 'libx264', audioStreamIndex: 99, outDir: 'o' })
  assert.deepEqual(allAfter(bad, '-map').slice(0, 2), ['0:0', '0:1'])
  // No audio at all.
  const silent = hls.buildTranscodeArgs({ input: 'f.mp4', tracks: { ...TRACKS, audio: [] }, quality: '480p', encoder: 'libx264', outDir: 'o' })
  assert.ok(silent.includes('-an'))
  assert.throws(() => hls.buildTranscodeArgs({ input: 'f', tracks: TRACKS, quality: '4k', encoder: 'libx264', outDir: 'o' }))
})

test('ffmpeg command: picture subtitles are burnt in with an overlay', () => {
  const args = hls.buildTranscodeArgs({ input: 'f.mkv', tracks: TRACKS, quality: '1080p', encoder: 'h264_nvenc', burnSubtitleStreamIndex: 4, outDir: 'o' })
  const fc = argAfter(args, '-filter_complex')
  assert.match(fc, /^\[0:0\]\[0:4\]overlay=/)
  assert.match(fc, /scale=1920:800,format=yuv420p\[vout\]$/)
  assert.equal(args.includes('-vf'), false)
  assert.deepEqual(allAfter(args, '-map').slice(0, 2), ['[vout]', '0:1'])
})

test('encoder settings per encoder', () => {
  const q = hls.QUALITIES['720p']
  assert.deepEqual(hls.encoderArgs('h264_nvenc', q).slice(0, 2), ['-c:v', 'h264_nvenc'])
  assert.ok(hls.encoderArgs('h264_nvenc', q).includes('-forced-idr'))
  assert.deepEqual(hls.encoderArgs('h264_qsv', q).slice(0, 2), ['-c:v', 'h264_qsv'])
  assert.deepEqual(hls.encoderArgs('h264_amf', q).slice(0, 2), ['-c:v', 'h264_amf'])
  assert.deepEqual(hls.encoderArgs('libopenh264', q).slice(0, 2), ['-c:v', 'libopenh264'])
  // QSV wants NV12 frames.
  const args = hls.buildTranscodeArgs({ input: 'f', tracks: TRACKS, quality: '720p', encoder: 'h264_qsv', outDir: 'o' })
  assert.match(argAfter(args, '-vf'), /format=nv12$/)
  // HDR sources are tone-mapped when the ffmpeg build can.
  const hdr = { ...TRACKS, video: { ...TRACKS.video, hdr: true } }
  assert.match(argAfter(hls.buildTranscodeArgs({ input: 'f', tracks: hdr, quality: '720p', encoder: 'libx264', outDir: 'o', tonemap: true }), '-vf'), /tonemap=tonemap=hable/)
  assert.doesNotMatch(argAfter(hls.buildTranscodeArgs({ input: 'f', tracks: hdr, quality: '720p', encoder: 'libx264', outDir: 'o', tonemap: false }), '-vf'), /tonemap/)
})

test('encoder probe: hardware first, proved by a test encode, falls back to software', async () => {
  const calls = []
  const run = async (args) => {
    calls.push(args)
    if (args.includes('-encoders')) return { code: 0, stdout: ' V....D h264_nvenc  NVIDIA\n V..... h264_qsv  QSV\n V....D libx264 x264\n V....D libopenh264 oh264\n' }
    if (args.includes('-filters')) return { code: 0, stdout: ' zscale  tonemap ' }
    const enc = args[args.indexOf('-c:v') + 1]
    return { code: enc === 'libx264' ? 0 : 1, stdout: '' }
  }
  const r = await hls.probeEncoders({ ffmpegPath: 'ffmpeg', run })
  assert.equal(r.encoder, 'libx264')
  assert.equal(r.hardware, false)
  assert.equal(r.tonemap, true)
  // Every candidate is answered (the whole list is kept so a conversion can fall back down it).
  assert.deepEqual(r.tried.map((t) => [t.encoder, t.ok]), [['h264_nvenc', false], ['h264_qsv', false], ['h264_amf', false], ['libx264', true], ['libopenh264', false]])
  assert.deepEqual(r.chain, ['libx264'])
  // h264_amf is not in this ffmpeg, so it was never test-encoded.
  assert.equal(calls.filter((a) => a.includes('h264_amf')).length, 0)

  const hw = await hls.probeEncoders({ ffmpegPath: 'ffmpeg', run: async (args) => (args.includes('-encoders') ? { code: 0, stdout: 'h264_nvenc libx264' } : { code: 0, stdout: '' }) })
  assert.equal(hw.encoder, 'h264_nvenc')
  assert.equal(hw.hardware, true)
  const qsvArgs = hls.testEncodeArgs('h264_qsv')
  assert.match(qsvArgs[qsvArgs.indexOf('-vf') + 1], /format=nv12$/)

  const none = await hls.probeEncoders({ ffmpegPath: 'ffmpeg', run: async (args) => ({ code: args.includes('-encoders') ? 0 : 1, stdout: 'libx264' }) })
  assert.equal(none.encoder, null)
  assert.equal((await hls.probeEncoders({ ffmpegPath: null })).encoder, null)
})

test('tickets: signed, tamper-proof, carry the choices', () => {
  const secret = 'k'
  const sign = (id) => { const exp = Date.now() + 1000; return `${exp}.${crypto.createHmac('sha256', secret).update(`${id}|${exp}`).digest('base64url')}` }
  const verify = (id, tok) => {
    const [exp, sig] = String(tok).split('.')
    if (!sig || Date.now() > Number(exp)) return false
    return sig === crypto.createHmac('sha256', secret).update(`${id}|${exp}`).digest('base64url')
  }
  const t = hls.makeTicket(sign, { k: 'tv', i: 'abc', q: '720p', a: 2, s: null, u: 'user1' })
  assert.match(t, /^[A-Za-z0-9_.-]+$/, 'path-safe')
  const read = hls.readTicket(verify, t)
  assert.deepEqual({ ...read.fields }, { v: 1, k: 'tv', i: 'abc', q: '720p', a: 2, s: null, u: 'user1' })
  assert.match(read.sessionKey, /^[0-9a-f]{20}$/)
  // Same choices -> same session, even with a fresh expiry.
  assert.equal(hls.readTicket(verify, hls.makeTicket(sign, { k: 'tv', i: 'abc', q: '720p', a: 2, s: null, u: 'user1' })).sessionKey, read.sessionKey)
  // Changing the payload (e.g. to another film) breaks the signature.
  const [payload, ...rest] = t.split('.')
  const forged = Buffer.from(JSON.stringify({ v: 1, k: 'tv', i: 'OTHER', q: '720p', a: 2, s: null, u: 'user1' })).toString('base64url') + '.' + rest.join('.')
  assert.equal(hls.readTicket(verify, forged), null)
  assert.equal(hls.readTicket(verify, payload), null)
  assert.equal(hls.readTicket(verify, ''), null)
  assert.equal(hls.readTicket(verify, 'x'.repeat(5000)), null)
})

// ------------------------------------------------------------ session manager
// A fake ffmpeg: writes seg-<n>.ts files, one every `every` ms, from its -start_number.
function fakeFfmpeg({ every = 5, fail = false, burst = 1 } = {}) {
  const runs = []
  const spawnFn = (exe, args) => {
    const child = new EventEmitter()
    child.stderr = new EventEmitter()
    child.pid = 0
    const outPattern = argAfter(args, '-hls_segment_filename')
    let n = Number(argAfter(args, '-start_number'))
    const run = { args, start: n, killed: false }
    runs.push(run)
    const end = 1000
    const timer = setInterval(() => {
      if (fail) { clearInterval(timer); child.stderr.emit('data', 'Error: boom\n'); child.emit('exit', 1); return }
      for (let b = 0; b < burst; b++) {
        if (n > end) { clearInterval(timer); child.emit('exit', 0); return }
        try { fs.writeFileSync(outPattern.replace('%d', String(n)), 'ts' + n) } catch {}
        n++
      }
    }, every)
    child.kill = () => { run.killed = true; clearInterval(timer); setImmediate(() => child.emit('exit', null)) }
    return child
  }
  return { spawnFn, runs }
}

function manager(opts = {}) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-hls-test-'))
  let clock = 1_000_000
  const m = hls.createTranscodeManager({ ffmpegPath: 'ffmpeg', tmpRoot, sweepEveryMs: 0, pollMs: 5, now: () => clock, ...opts })
  return { m, tmpRoot, advance: (ms) => { clock += ms } }
}
const spec = (over = {}) => ({ key: 'k1', owner: 'u1', fileKey: 'movie|a', filePath: 'a.mkv', tracks: { ...TRACKS, durationSec: 400 }, quality: '720p', encoder: 'libx264', ...over })

test('manager: first piece starts ffmpeg, a far seek restarts it there, pieces behind are deleted', async () => {
  const fake = fakeFfmpeg()
  const { m } = manager({ spawnFn: fake.spawnFn, keepBehindSegments: 2 })
  try {
    const s = m.open(spec())
    assert.match(m.playlist(s), /seg-99\.ts/)
    const p0 = await m.segment(s, 0)
    assert.equal(fs.readFileSync(p0, 'utf8'), 'ts0')
    assert.equal(fake.runs.length, 1)
    const p3 = await m.segment(s, 3)
    assert.equal(fs.readFileSync(p3, 'utf8'), 'ts3')
    assert.equal(fake.runs.length, 1, 'nearby piece: same run')
    // Seek far ahead.
    const p80 = await m.segment(s, 80)
    assert.equal(fs.readFileSync(p80, 'utf8'), 'ts80')
    assert.equal(fake.runs.length, 2)
    assert.equal(fake.runs[1].start, 80)
    assert.equal(fake.runs[0].killed, true)
    assert.equal(argAfter(fake.runs[1].args, '-ss'), '320.000')
    // Pieces well behind the viewer are gone.
    assert.equal(fs.existsSync(p0), false)
    // Seek back: restarts again.
    await m.segment(s, 5)
    assert.equal(fake.runs.length, 3)
    assert.equal(fake.runs[2].start, 5)
    // Past the end / nonsense.
    assert.equal(await m.segment(s, 100), null)
    assert.equal(await m.segment(s, -1), null)
  } finally { m.closeAll() }
})

test('manager: stops ffmpeg that is far ahead of the viewer and restarts it as they catch up', async () => {
  const fake = fakeFfmpeg({ every: 5, burst: 4 })
  const { m } = manager({ spawnFn: fake.spawnFn, maxAheadSegments: 10, resumeWithinSegments: 4 })
  try {
    const s = m.open(spec({ tracks: { ...TRACKS, durationSec: 4000 } }))
    await m.segment(s, 0)
    await new Promise((r) => setTimeout(r, 200))
    await m.segment(s, 1)
    assert.equal(fake.runs[0].killed, true, 'paused when far ahead')
    assert.equal(s.proc, null)
    const ready = s.readyUpTo
    assert.ok(ready >= 11)
    await m.segment(s, 2)
    assert.equal(fake.runs.length, 1, 'still plenty ready: stays paused')
    await m.segment(s, ready - 3)
    assert.equal(fake.runs.length, 2, 'caught up: resumed')
    assert.equal(fake.runs[1].start, ready + 1, 'resumes right after the last ready piece')
  } finally { m.closeAll() }
})

test('manager: an ffmpeg failure is reported, not waited on forever', async () => {
  const fake = fakeFfmpeg({ fail: true })
  const { m } = manager({ spawnFn: fake.spawnFn })
  try {
    const s = m.open(spec())
    await assert.rejects(m.segment(s, 0), /ffmpeg stopped \(1\): Error: boom/)
  } finally { m.closeAll() }
})

test('manager: at most N conversions; the same viewer switching quality replaces theirs', () => {
  const fake = fakeFfmpeg()
  const { m, advance } = manager({ spawnFn: fake.spawnFn, maxConcurrent: 2 })
  try {
    m.open(spec({ key: 'a', owner: 'u1', fileKey: 'movie|x' }))
    m.open(spec({ key: 'b', owner: 'u2', fileKey: 'movie|y' }))
    assert.equal(m.size(), 2)
    assert.equal(m.hasSlotFor('u3', 'movie|z'), false)
    assert.throws(() => m.open(spec({ key: 'c', owner: 'u3', fileKey: 'movie|z' })), (e) => e.code === 'busy')
    // u1 switches quality on the same film: their old session makes way.
    assert.equal(m.hasSlotFor('u1', 'movie|x'), true)
    m.open(spec({ key: 'a2', owner: 'u1', fileKey: 'movie|x', quality: '480p' }))
    assert.equal(m.get('a'), null)
    assert.ok(m.get('a2'))
    // Reopening the same key is the same session.
    assert.equal(m.open(spec({ key: 'a2', owner: 'u1', fileKey: 'movie|x', quality: '480p' })), m.get('a2'))
    // Someone who stopped asking for a while gives up their slot.
    advance(31000)
    m.get('a2').lastAccess += 31000
    assert.equal(m.hasSlotFor('u3', 'movie|z'), true)
    m.open(spec({ key: 'c', owner: 'u3', fileKey: 'movie|z' }))
    assert.equal(m.get('b'), null)
    assert.equal(m.size(), 2)
    assert.throws(() => m.open(spec({ key: 'd', tracks: { ...TRACKS, durationSec: 0 } })), /unknown_duration/)
  } finally { m.closeAll() }
})

test('manager: idle sessions are closed and their folders removed', async () => {
  const fake = fakeFfmpeg()
  const { m, advance, tmpRoot } = manager({ spawnFn: fake.spawnFn, idleMs: 60000 })
  try {
    const s = m.open(spec())
    await m.segment(s, 0)
    assert.ok(fs.existsSync(s.dir))
    advance(30000)
    m.sweep()
    assert.ok(m.get('k1'), 'not idle long enough')
    advance(31000)
    m.sweep()
    assert.equal(m.get('k1'), null)
    assert.equal(fake.runs[0].killed, true)
    for (let i = 0; i < 40 && fs.existsSync(s.dir); i++) await new Promise((r) => setTimeout(r, 25))
    assert.equal(fs.existsSync(s.dir), false)
    // A request that was waiting on a closed session just gets nothing.
    assert.equal(await m.segment(s, 50), null)
    // Stop by owner.
    const s2 = m.open(spec({ key: 'k2' }))
    m.closeOwner('u1')
    assert.equal(m.get('k2'), null)
    assert.ok(s2.closed)
    assert.ok(fs.existsSync(tmpRoot))
  } finally { m.closeAll() }
})
