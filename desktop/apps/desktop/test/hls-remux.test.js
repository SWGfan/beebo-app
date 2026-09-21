// Direct stream (hlsRemux.js): key frame index, piece plan, playlists, codec strings, the fMP4 box handling, and -
// against a REAL ffmpeg when one is on this machine - that the picture and the sound come out bit for bit
// (stream copy), that pieces made by different runs (a seek) line up with the init segment, and what the
// muxer does with the formats a home theatre cares about (E-AC-3, TrueHD, DTS, HEVC/hvc1, Dolby Vision).
// Only features of ffmpeg's own libavformat / libavcodec are used (no GPL-only filter or encoder is needed to COPY),
// and clips are made with whichever H.264 encoder exists (libx264, else the LGPL libopenh264). HEVC and the
// Dolby Vision signalling tests need an HEVC encoder (libx265, or Kvazaar as in the bundled LGPL build) and are skipped without one.
// Run: node --test test/hls-remux.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { createRequire } = require('node:module')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))
const rx = localRequire('./electron/hlsRemux')
const tracksLib = localRequire('./electron/playbackTracks')
const F = require('./helpers/ffprobeFixtures')
const { addDolbyVisionBox } = require('./helpers/dolbyVisionMp4')

function findTool(name) {
  const convert = localRequire('./electron/convert')
  const fromApp = name === 'ffmpeg' ? convert.ffmpegPath() : convert.ffprobePath()
  if (fromApp) return fromApp
  const r = spawnSync(name, ['-version'], { windowsHide: true })
  return r.status === 0 ? name : null
}
const FFMPEG = findTool('ffmpeg')
const FFPROBE = findTool('ffprobe')
const REAL = !!(FFMPEG && FFPROBE)
const ff = (args, opts = {}) => spawnSync(FFMPEG, ['-hide_banner', '-v', 'error', '-y', ...args], { encoding: opts.binary ? null : 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true })
const encoders = REAL ? String(ff(['-encoders']).stdout || '') : ''
const H264 = /libx264\b/.test(encoders) ? ['-c:v', 'libx264', '-preset', 'ultrafast'] : /libopenh264/.test(encoders) ? ['-c:v', 'libopenh264'] : null
// An HEVC encoder for test clips: x265 (10-bit, real HDR10 signalling) where the ffmpeg is a GPL build, else Kvazaar, which the LGPL build
// bundled with the app has (8-bit only; the PQ / BT.2020 flags are written into the stream with the hevc_metadata bitstream filter).
// Both are only used to MAKE a test picture: copying HEVC (what the app does) needs no encoder at all.
const HEVC = /libx265\b/.test(encoders) ? { kind: 'x265', bits: 10, pix: 'yuv420p10le' } : /libkvazaar/.test(encoders) ? { kind: 'kvazaar', bits: 8, pix: 'yuv420p' } : null
/** Encoder arguments (and input pixel format) for a 3-second-GOP, B-frame, PQ / BT.2020 HEVC picture. */
const hevcArgs = () => (HEVC.kind === 'x265'
  ? ['-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'keyint=72:min-keyint=72:scenecut=0:bframes=3:hdr10=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1):max-cll=1000,400:log-level=error', '-pix_fmt', HEVC.pix]
  : ['-c:v', 'libkvazaar', '-kvazaar-params', 'gop=8:period=72', '-pix_fmt', HEVC.pix, '-bsf:v', 'hevc_metadata=colour_primaries=9:transfer_characteristics=16:matrix_coefficients=9'])

const skipHevc = !REAL || !HEVC ? 'needs an ffmpeg with an HEVC encoder (libx265 or libkvazaar)' : false

// -------------------------------------------------------------- pure parts
test('key frame list: only K packets, sorted, de-duplicated, in seconds', () => {
  const csv = ['0.000000,-0.083000,K__', '0.167000,0.000000,___', '2.000000,1.917000,K__', 'N/A,N/A,K__', '2.000000,1.917000,K__', '4.500000,4.417000,K_D', '1.000000,0.917000,___', ''].join('\n')
  assert.deepEqual(rx.parseKeyframeCsv(csv), [0, 2, 4.5])
  assert.deepEqual(rx.parseKeyframeCsv(''), [])
  assert.deepEqual(rx.parseKeyframeCsv('garbage'), [])
  assert.deepEqual(rx.keyframeProbeArgs(3).slice(0, 4), ['-v', 'error', '-select_streams', '3'])
})

test('piece plan: starts and ends on key frames, about 6 s each, real durations, deterministic', () => {
  // a key frame every 2.5 s for 100 s
  const kf = Array.from({ length: 41 }, (_, i) => i * 2.5)
  const segs = rx.planSegments(kf, 100)
  assert.equal(segs[0].start, 0)
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]
    assert.equal(s.index, i)
    assert.ok(kf.includes(s.end) || s.end === 100, `piece ${i} ends on a key frame or at the end`)
    if (i < segs.length - 1) { assert.ok(s.duration >= 6 - 1e-6 && s.duration < 6 + 2.5, `piece ${i} is ${s.duration} s`); assert.equal(segs[i + 1].start, s.end); assert.equal(segs[i + 1].kfStart, s.kfEnd) }
  }
  assert.equal(segs[segs.length - 1].end, 100)
  assert.ok(Math.abs(segs.reduce((n, s) => n + s.duration, 0) - 100) < 1e-6, 'pieces add up to the whole film')
  assert.deepEqual(rx.planSegments(kf, 100), segs)
  // long GOPs: a 10 s key frame interval gives 10 s pieces; a 1 s interval gives 6 s pieces
  assert.equal(rx.planSegments([0, 10, 20, 30], 40)[1].duration, 10)
  assert.equal(rx.planSegments(Array.from({ length: 30 }, (_, i) => i), 30)[0].duration, 6)
  // a film whose first key frame is late still starts at 0; a single key frame is one piece
  assert.equal(rx.planSegments([1.2, 9], 20)[0].start, 0)
  assert.equal(rx.planSegments([0], 42).length, 1)
  assert.deepEqual(rx.planSegments([], 42), []); assert.deepEqual(rx.planSegments([0, 1], 0), [])
})

test('media playlist: fMP4 (EXT-X-MAP), VOD, whole film, exact durations', () => {
  const segs = rx.planSegments([0, 3, 6, 9, 12, 15], 18)
  const m = rx.buildMediaPlaylist(segs)
  assert.match(m, /^#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:6\n/)
  assert.match(m, /#EXT-X-PLAYLIST-TYPE:VOD/); assert.match(m, /#EXT-X-MAP:URI="init.mp4"/); assert.match(m, /#EXT-X-ENDLIST\n$/)
  assert.deepEqual(m.match(/^seg-\d+\.m4s$/gm), ['seg-0.m4s', 'seg-1.m4s', 'seg-2.m4s'])
  assert.deepEqual(m.match(/#EXTINF:[\d.]+/g), ['#EXTINF:6.000000', '#EXTINF:6.000000', '#EXTINF:6.000000'])
})

test('codec strings and the master playlist (HDR / Dolby Vision signalling; unverified on Apple hardware)', () => {
  const t = (probe) => tracksLib.parseTracks(probe)
  const hdr10 = t(F.hdr10_4k()).video
  assert.equal(rx.videoCodecString(hdr10), 'hvc1.2.4.L153.B0')
  assert.equal(rx.videoCodecString(t(F.sdr1080()).video), 'avc1.640029')
  assert.equal(rx.videoCodecString(t(F.uhd4kSdr()).video), 'hvc1.1.6.L153.B0')
  const dv81 = t(F.dv81()).video
  assert.equal(rx.supplementalCodec(dv81), 'dvh1.08.06/db1p')
  assert.equal(rx.supplementalCodec(t(F.dv84()).video), 'dvh1.08.06/db4h')
  assert.equal(rx.supplementalCodec(t(F.dv82()).video), 'dvh1.08.06/db2g')
  assert.equal(rx.supplementalCodec(t(F.dv5()).video), '', 'profile 5 uses dvh1 as the main codec, not a supplement')
  assert.equal(rx.videoCodecString(t(F.dv5()).video, { dvKept: true }), 'dvh1.05.09')
  assert.equal(rx.audioCodecString('eac3'), 'ec-3'); assert.equal(rx.audioCodecString('ac3'), 'ac-3'); assert.equal(rx.audioCodecString('aac'), 'mp4a.40.2'); assert.equal(rx.audioCodecString('truehd'), '')
  const master = rx.buildMasterPlaylist({ video: dv81, dvKept: true, range: 'PQ', audioCodec: 'eac3', audioChannels: '16/JOC', bandwidth: 60000000 })
  assert.match(master, /CODECS="hvc1\.2\.4\.L153\.B0,ec-3"/); assert.match(master, /SUPPLEMENTAL-CODECS="dvh1\.08\.06\/db1p"/)
  assert.match(master, /VIDEO-RANGE=PQ/); assert.match(master, /RESOLUTION=3840x2160/); assert.match(master, /FRAME-RATE=23\.976/); assert.match(master, /\nindex\.m3u8\n$/)
  // HLG stays HLG; SDR says SDR
  assert.equal(rx.videoRangeOf('HLG'), 'HLG'); assert.equal(rx.videoRangeOf('SDR (tone-mapped)'), 'SDR'); assert.equal(rx.videoRangeOf('HDR10+'), 'PQ')
})

test('ffmpeg command: copy, hvc1 / dvh1 tags, -strict unofficial only for Dolby Vision, RPU strip, seek by key frame, audio copy or convert', () => {
  const tracks = tracksLib.parseTracks(F.dv81())
  const argsOf = (o) => rx.buildRemuxArgs({ input: 'D:\\Movies\\film.mkv', tracks, ...o })
  const after = (a, f) => a[a.indexOf(f) + 1]
  // Dolby Vision kept
  let a = argsOf({ rx: { a: 1, ac: 'copy', t: 'dvh1' } })
  assert.equal(after(a, '-c:v'), 'copy'); assert.equal(after(a, '-tag:v'), 'dvh1'); assert.equal(after(a, '-strict'), 'unofficial'); assert.equal(after(a, '-c:a'), 'copy')
  assert.ok(!a.includes('-bsf:v')); assert.ok(!a.includes('-ss'))
  assert.equal(after(a, '-f'), 'mp4'); assert.match(after(a, '-movflags'), /frag_keyframe/); assert.match(after(a, '-movflags'), /delay_moov/); assert.match(after(a, '-movflags'), /frag_discont/); assert.equal(a[a.length - 1], 'pipe:1')
  assert.ok(a.includes('-nostdin') && a.includes('-sn'))
  // HDR10 (no Dolby Vision): no strict flag
  a = argsOf({ rx: { a: 1, ac: 'copy', t: 'hvc1' } })
  assert.equal(after(a, '-tag:v'), 'hvc1'); assert.ok(!a.includes('-strict'))
  // Dolby Vision removed: the RPU bitstream filter
  a = argsOf({ rx: { a: 1, ac: 'copy', t: 'hvc1', s: 1 } })
  assert.equal(after(a, '-bsf:v'), 'dovi_rpu=strip=1'); assert.ok(!a.includes('-strict'))
  // a seek starts on the key frame: a hair early, and the run keeps the film's clock
  a = argsOf({ rx: { a: 1, ac: 'copy', t: 'hvc1' }, startSec: 12 })
  assert.equal(after(a, '-ss'), '11.9995'); assert.equal(after(a, '-output_ts_offset'), '12.0000'); assert.equal(after(a, '-copypriorss'), '0')
  assert.ok(a.indexOf('-ss') < a.indexOf('-i'), 'the seek is an input option (fast, on the container index)')
  // audio converted by hlsAudio: E-AC-3 5.1 from an 8-channel TrueHD track
  const hd = tracksLib.parseTracks(F.dv7fel())
  const au = localRequire('./electron/hlsAudio').ticketAudio({ mode: 'surround', downmix: 'standard', caps: { maxChannels: 6, codecs: ['eac3'] } })
  a = rx.buildRemuxArgs({ input: 'x.mkv', tracks: hd, rx: { a: 1, ac: 'encode', t: 'hvc1', au }, audioEncoders: { aac: true, ac3: true, eac3: true } })
  assert.equal(after(a, '-c:a'), 'eac3'); assert.match(after(a, '-af'), /pan=5\.1/); assert.equal(after(a, '-b:a'), '640k')
  // the input goes through the file: prefix helper (no bare paths, protocol whitelist)
  assert.ok(a.some((x) => /^file:/.test(x)) || a.includes('-protocol_whitelist'))
  assert.throws(() => rx.buildRemuxArgs({ input: 'x', tracks: { audio: [] }, rx: {} }), /no video/)
})

test('MP4 box reader: chunks of any size, 64-bit sizes, boxes come out whole', () => {
  const mk = (type, body) => { const b = Buffer.alloc(8 + body.length); b.writeUInt32BE(b.length); b.write(type, 4, 'latin1'); body.copy(b, 8); return b }
  const big = Buffer.alloc(16 + 10); big.writeUInt32BE(1); big.write('mdat', 4, 'latin1'); big.writeBigUInt64BE(26n, 8)
  const all = Buffer.concat([mk('ftyp', Buffer.from('isom0000')), mk('moov', Buffer.alloc(100, 7)), mk('moof', Buffer.alloc(33, 1)), big])
  for (const size of [1, 3, 7, 16, 64, 1000]) {
    const got = []
    const r = rx.createBoxReader((b) => got.push(b))
    for (let i = 0; i < all.length; i += size) r.push(all.subarray(i, i + size))
    assert.deepEqual(got.map((b) => b.type), ['ftyp', 'moov', 'moof', 'mdat'], `chunks of ${size}`)
    assert.equal(got[1].buf.length, 108); assert.equal(got[3].buf.length, 26)
    assert.ok(Buffer.concat(got.map((b) => b.buf)).equals(all))
  }
  assert.throws(() => rx.createBoxReader(() => {}).push(Buffer.from([0, 0, 0, 4, 0x6d, 0x6f, 0x6f, 0x76])), /bad MP4 box/)
})

test('the remux manager refuses a key frame index that does not match the file (a fragment far from its key frame)', async () => {
  // Fake ffmpeg that writes one fragment starting at 40 s where the index says 0 s: the session must fail loudly, not serve rubbish.
  const { EventEmitter } = require('node:events')
  const { PassThrough } = require('node:stream')
  const mkBox = (type, body) => { const b = Buffer.alloc(8 + body.length); b.writeUInt32BE(b.length); b.write(type, 4, 'latin1'); body.copy(b, 8); return b }
  const fullBox = (type, ver, payload) => mkBox(type, Buffer.concat([Buffer.from([ver, 0, 0, 0]), payload]))
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b }
  const trak = mkBox('trak', Buffer.concat([
    fullBox('tkhd', 0, Buffer.concat([u32(0), u32(0), u32(1), Buffer.alloc(72)])),
    mkBox('mdia', Buffer.concat([fullBox('mdhd', 0, Buffer.concat([u32(0), u32(0), u32(1000), u32(0), u32(0)])), fullBox('hdlr', 0, Buffer.concat([u32(0), Buffer.from('vide'), Buffer.alloc(13)]))]))
  ]))
  const moov = mkBox('moov', trak)
  const tfdtV1 = (t) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(t)); return b }
  const moof = mkBox('moof', mkBox('traf', Buffer.concat([fullBox('tfhd', 0, u32(1)), fullBox('tfdt', 1, tfdtV1(40000))])))
  const spawnFn = () => { const c = new EventEmitter(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.pid = 0; c.kill = () => { c.emit('close', null) }; setImmediate(() => { c.stdout.write(Buffer.concat([mkBox('ftyp', Buffer.from('isom0000')), moov, moof, mkBox('mdat', Buffer.alloc(10))])) }); return c }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-rx-fake-'))
  const m = rx.createRemuxManager({ ffmpegPath: 'ffmpeg', tmpRoot: tmp, spawnFn, sweepEveryMs: 0, waitTimeoutMs: 3000, pollMs: 5 })
  const tracks = { durationSec: 30, video: { streamIndex: 0, codec: 'h264' }, audio: [] }
  const s = m.open({ key: 'k1', owner: 'u', fileKey: 'movie|x', filePath: 'x.mkv', tracks, keyframes: [0, 3, 6, 9, 12, 15, 18, 21, 24, 27], rx: { ac: 'copy' } })
  await assert.rejects(m.segment(s, 0), /key frame index does not match/)
  m.closeAll()
  fs.rmSync(tmp, { recursive: true, force: true })
})

// -------------------------------------------------------- against real ffmpeg
const skip = !REAL || !H264 ? 'needs ffmpeg + ffprobe with an H.264 encoder' : false

function workDir(label) { return fs.mkdtempSync(path.join(os.tmpdir(), `beebo-rx-${label}-`)) }

/** 42 s of 640x360 test picture, key frame every 3 s, B-frames off (libopenh264) or on (libx264), Dolby Digital Plus 5.1 sound. */
function makeClip(dir, name, { seconds = 42, gop = 3, audio = 'eac3' } = {}) {
  const out = path.join(dir, name)
  const r = ff(['-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=24:duration=${seconds}`, '-f', 'lavfi', '-i', `sine=frequency=330:duration=${seconds},aformat=channel_layouts=5.1`,
    '-map', '0:v', '-map', '1:a', ...H264, '-pix_fmt', 'yuv420p', '-force_key_frames', `expr:gte(t,n_forced*${gop})`, ...(H264[1] === 'libx264' ? ['-bf', '2', '-sc_threshold', '0'] : []),
    '-c:a', audio, '-b:a', '384k', out])
  assert.equal(r.status, 0, String(r.stderr))
  return out
}

const probeJson = (file, extra = []) => JSON.parse(spawnSync(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', ...extra, file], { encoding: 'utf8' }).stdout)
const packetsOf = (file, sel) => String(spawnSync(FFPROBE, ['-v', 'error', '-select_streams', sel, '-show_entries', 'packet=pts_time,dts_time,duration_time,flags,size', '-of', 'csv=p=0', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout).trim().split(/\r?\n/).map((l) => l.split(','))
const md5Of = (file, sel) => String(ff(['-i', file, '-map', sel, '-c', 'copy', '-f', 'md5', '-']).stdout).trim()

function newManager(dir, extra = {}) {
  const index = rx.createKeyframeIndex({ ffprobePath: FFPROBE, cacheDir: path.join(dir, 'kf') })
  const manager = rx.createRemuxManager({ ffmpegPath: FFMPEG, keyframeIndex: index, tmpRoot: path.join(dir, 'remux'), sweepEveryMs: 0, pollMs: 10, waitTimeoutMs: 60000, ...extra })
  return { index, manager }
}
async function openSession(env, file, rxReq, key = 'sess1') {
  const prober = tracksLib.createTrackProber({ ffprobePath: FFPROBE })
  const tracks = await prober.probe(file)
  const kf = await env.index.wait(file, tracks.video.streamIndex, 120000)
  assert.equal(kf.state, 'ready', 'key frame index')
  const s = env.manager.open({ key, owner: 'u', fileKey: 'movie|' + path.basename(file), filePath: file, tracks, keyframes: kf.keyframes, rx: rxReq, audioEncoders: { aac: true, ac3: true, eac3: true } })
  return { s, tracks, kf: kf.keyframes }
}
const join = (dir, name, parts) => { const f = path.join(dir, name); fs.writeFileSync(f, Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : fs.readFileSync(p))))); return f }

test('real ffmpeg: the key frame index finds the forced key frames and is cached on disk', { skip }, async () => {
  const dir = workDir('idx')
  try {
    const clip = makeClip(dir, 'clip.mkv')
    const index = rx.createKeyframeIndex({ ffprobePath: FFPROBE, cacheDir: path.join(dir, 'kf') })
    assert.equal(index.get(clip, 0).state, 'scanning')
    const r = await index.wait(clip, 0, 120000)
    assert.equal(r.state, 'ready')
    assert.deepEqual(r.keyframes.slice(0, 5), [0, 3, 6, 9, 12])
    assert.equal(r.keyframes.length, 14)
    assert.ok(fs.readdirSync(path.join(dir, 'kf')).some((f) => f.endsWith('.json')))
    // a fresh index object reads it from disk: no ffprobe needed (a missing one does not matter)
    const again = rx.createKeyframeIndex({ ffprobePath: null, cacheDir: path.join(dir, 'kf') })
    assert.equal(again.get(clip, 0).state, 'ready')
    assert.equal(rx.createKeyframeIndex({ ffprobePath: FFPROBE }).get(path.join(dir, 'nope.mkv'), 0).state, 'failed')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('real ffmpeg: a full run is a bit-exact copy of the picture and the sound (no re-encode), pieces line up with the playlist', { skip }, async () => {
  const dir = workDir('copy')
  const env = newManager(dir)
  try {
    const clip = makeClip(dir, 'clip.mkv')
    const { s, tracks } = await openSession(env, clip, { a: 1, ac: 'copy', t: 'avc1' })
    const init = await env.manager.initSegment(s)
    assert.equal(init.toString('latin1', 4, 8), 'ftyp')
    const files = []
    for (let n = 0; n < s.segments.length; n++) {
      const f = await env.manager.segment(s, n)
      assert.ok(f, `piece ${n}`)
      files.push(f)
    }
    assert.equal(env.manager.segment(s, s.segments.length) instanceof Promise, true)
    assert.equal(await env.manager.segment(s, s.segments.length), null, 'past the end there is nothing')
    // the playlist promises what the pieces contain: durations add up to the film, and each piece starts on its key frame
    const out = join(dir, 'joined.mp4', [init, ...files])
    const st = probeJson(out).streams
    assert.deepEqual(st.map((x) => x.codec_name), ['h264', 'eac3'])
    assert.equal(st[0].codec_tag_string, 'avc1'); assert.equal(st[1].codec_tag_string, 'ec-3')
    assert.equal(st[1].channels, 6)
    // BIT-EXACT: the joined file's picture and sound are the source's, byte for byte
    assert.equal(md5Of(out, '0:v:0'), md5Of(clip, '0:v:0'), 'picture copied untouched')
    assert.equal(md5Of(out, '0:a:0'), md5Of(clip, '0:a:0'), 'sound copied untouched')
    // every piece starts on the key frame the playlist says (within a millisecond)
    const keyPts = packetsOf(out, 'v:0').filter((p) => /K/.test(p[4])).map((p) => Number(p[0]))
    assert.equal(keyPts.length, s.keyframes.length)
    keyPts.forEach((t, i) => assert.ok(Math.abs(t - s.keyframes[i]) < 0.002, `key frame ${i}: ${t} vs ${s.keyframes[i]}`))
    // the playlist text matches the plan
    assert.equal((env.manager.playlist(s).match(/seg-\d+\.m4s/g) || []).length, s.segments.length)
    assert.ok(Math.abs(s.segments.reduce((n, g) => n + g.duration, 0) - tracks.durationSec) < 0.01)
  } finally { env.manager.closeAll(); fs.rmSync(dir, { recursive: true, force: true }) }
})

/**
 * Play pieces 0-1 from the first run, then seek to piece 4 (a second run), and check that the joined result (init of the first run +
 * pieces of both) puts every key frame where the playlist says and keeps the sound with the picture.
 */
async function seekScenario(dir, clip, { hevc = false } = {}) {
  const env = newManager(dir)
  try {
    const { s } = await openSession(env, clip, { a: 1, ac: 'copy', t: hevc ? 'hvc1' : 'avc1' })
    const init = await env.manager.initSegment(s)
    const n = s.segments.length
    assert.ok(n >= 6)
    const first = [await env.manager.segment(s, 0), await env.manager.segment(s, 1)]
    // Copy is so fast that the first run has already finished the whole film, so make the seek real the way it happens on a long
    // film: the pieces the viewer skipped over were never kept (deleted here), and the run has ended.
    for (let i = 0; i < 40 && s.proc; i++) await new Promise((r) => setTimeout(r, 50))
    for (let i = 2; i < n; i++) { try { fs.unlinkSync(path.join(s.dir, `seg-${i}.m4s`)) } catch { /* not made */ } }
    const runsBefore = s.runs
    const seekPiece = 4
    const second = []
    for (let i = seekPiece; i < n; i++) second.push(await env.manager.segment(s, i))
    assert.ok(s.runs > runsBefore, 'the seek started another ffmpeg run')
    // ffmpeg's mp4 muxer writes a different edit-list offset for a run that starts mid-film with B-frames in open GOPs, so without the
    // shift the second run's picture would sit a fraction of a second off the sound and off the first run (measured: 125 ms).
    if (hevc && HEVC.kind === 'x265') assert.ok(Object.values(s.lastRunDelta).some((d) => d !== 0), `the seek run needed a shift: ${JSON.stringify(s.lastRunDelta)}`)
    const out = join(dir, `seek-${hevc ? 'hevc' : 'h264'}.mp4`, [init, ...first, ...second])
    const v = packetsOf(out, 'v:0').map((p) => ({ pts: Number(p[0]), key: /K/.test(p[4]) }))
    const a = packetsOf(out, 'a:0').map((p) => ({ pts: Number(p[0]) }))
    const keyTimes = v.filter((p) => p.key).map((p) => p.pts)
    const want = [...s.keyframes.slice(0, s.segments[2].kfStart), ...s.keyframes.slice(s.segments[seekPiece].kfStart)]
    assert.equal(keyTimes.length, want.length)
    keyTimes.forEach((t, i) => assert.ok(Math.abs(t - want[i]) < 0.002, `key frame ${i}: ${t} vs ${want[i]}`))
    // inside each run the picture advances one frame at a time (leading pictures of an open GOP before the seek key frame are skipped)
    const vs = v.map((p) => p.pts).sort((x, y) => x - y)
    for (let i = 1; i < vs.length; i++) {
      const gap = vs[i] - vs[i - 1]
      if (vs[i] < s.segments[2].start) assert.ok(Math.abs(gap - 1 / 24) < 0.002, `frame gap ${gap} at ${vs[i - 1]}`)
      else if (vs[i - 1] >= s.segments[seekPiece].start) assert.ok(Math.abs(gap - 1 / 24) < 0.002, `frame gap ${gap} after the seek at ${vs[i - 1]}`)
    }
    // the sound after the seek starts where the picture does (within one audio frame), not a B-frame delay off
    const afterSeek = a.filter((p) => p.pts >= s.segments[seekPiece].start - 0.2)
    assert.ok(Math.abs(afterSeek[0].pts - s.segments[seekPiece].start) < 0.06, `audio restarts at ${afterSeek[0].pts}, piece starts at ${s.segments[seekPiece].start}`)
    const later = a.filter((p) => p.pts >= s.segments[seekPiece].start).map((p) => p.pts)
    for (let i = 1; i < later.length; i++) assert.ok(later[i] - later[i - 1] < 0.05, `audio gap after the seek at ${later[i - 1]}`)
    // and the sound of the first run is contiguous up to the end of piece 1
    const early = a.filter((p) => p.pts < s.segments[2].start).map((p) => p.pts)
    for (let i = 1; i < early.length; i++) assert.ok(early[i] - early[i - 1] < 0.05, `audio gap before the seek at ${early[i - 1]}`)
    return s
  } finally { env.manager.closeAll() }
}

test('real ffmpeg: a seek starts a new run, and its pieces join the first run\'s init and pieces without a jump (H.264, picture and sound)', { skip }, async () => {
  const dir = workDir('seek')
  try { await seekScenario(dir, makeClip(dir, 'clip.mkv')) } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('real ffmpeg: the same seek on an HEVC film with B-frames (x265: 10-bit open GOPs, which need the run-to-run shift)', { skip: skipHevc }, async () => {
  const dir = workDir('seekhevc')
  try {
    const src = makeHdr10(dir, 'hevc.mkv', 42)
    await seekScenario(dir, src, { hevc: true })
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('real ffmpeg: a run that is stopped far ahead of the viewer resumes where it stopped, and pieces stay contiguous', { skip }, async () => {
  const dir = workDir('resume')
  const env = newManager(dir, { maxAheadSegments: 2, keepBehindSegments: 50 })
  try {
    const clip = makeClip(dir, 'clip.mkv')
    const { s } = await openSession(env, clip, { a: 1, ac: 'copy', t: 'avc1' })
    const init = await env.manager.initSegment(s)
    const got = []
    for (let n = 0; n < s.segments.length; n++) got.push(await env.manager.segment(s, n))
    assert.ok(s.runs >= 1)
    const out = join(dir, 'resume.mp4', [init, ...got])
    assert.equal(md5Of(out, '0:v:0'), md5Of(clip, '0:v:0'), 'still a bit-exact copy after runs were stopped and resumed')
    assert.equal(md5Of(out, '0:a:0'), md5Of(clip, '0:a:0'))
  } finally { env.manager.closeAll(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('real ffmpeg: audio converted alone (5.1 Dolby Digital Plus source -> stereo AAC) while the picture stays a copy', { skip }, async () => {
  const dir = workDir('audio')
  const env = newManager(dir)
  try {
    const clip = makeClip(dir, 'clip.mkv')
    const au = localRequire('./electron/hlsAudio').ticketAudio({ mode: 'stereo', downmix: 'dialogue' })
    const { s } = await openSession(env, clip, { a: 1, ac: 'encode', t: 'avc1', au })
    const init = await env.manager.initSegment(s)
    const got = []
    for (let n = 0; n < s.segments.length; n++) got.push(await env.manager.segment(s, n))
    const out = join(dir, 'aac.mp4', [init, ...got])
    const st = probeJson(out).streams
    assert.deepEqual(st.map((x) => x.codec_name), ['h264', 'aac']); assert.equal(st[1].channels, 2)
    assert.equal(md5Of(out, '0:v:0'), md5Of(clip, '0:v:0'), 'the picture is untouched even though the sound was converted')
    // the converted sound spans the film
    const a = packetsOf(out, 'a:0')
    assert.ok(Number(a[a.length - 1][0]) > 40)
  } finally { env.manager.closeAll(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('real ffmpeg: what the muxer does with Dolby Digital Plus, TrueHD and DTS in fragmented MP4 (the audio side of passthrough)', { skip }, () => {
  const dir = workDir('audiofmt')
  try {
    const tone = (layout) => ['-f', 'lavfi', '-i', `sine=frequency=440:duration=3,aformat=channel_layouts=${layout}`]
    const mux = (name, args) => { const r = ff(args); return { ok: r.status === 0, err: String(r.stderr) } }
    // E-AC-3 5.1 and 7.1 are made with ffmpeg's own encoder; TrueHD and DTS with its (experimental) native encoders
    assert.ok(mux('e', [...tone('5.1'), '-c:a', 'eac3', '-b:a', '640k', path.join(dir, 'e.mkv')]).ok)
    assert.ok(mux('t', [...tone('7.1'), '-c:a', 'truehd', '-strict', '-2', path.join(dir, 't.mkv')]).ok)
    assert.ok(mux('d', [...tone('5.1'), '-c:a', 'dca', '-strict', '-2', '-b:a', '1536k', path.join(dir, 'd.mkv')]).ok)
    const frag = ['-c', 'copy', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof+delay_moov']
    // E-AC-3 copies into fMP4 as ec-3, but ONLY with delay_moov (the muxer must see a frame before it can write the header)
    const noDelay = ff(['-i', path.join(dir, 'e.mkv'), '-c', 'copy', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov', path.join(dir, 'e0.mp4')])
    assert.notEqual(noDelay.status, 0, 'without delay_moov the E-AC-3 header cannot be written')
    assert.match(String(noDelay.stderr), /Cannot write moov atom before EAC3 packets parsed/)
    assert.equal(ff(['-i', path.join(dir, 'e.mkv'), ...frag, path.join(dir, 'e.mp4')]).status, 0)
    assert.equal(probeJson(path.join(dir, 'e.mp4')).streams[0].codec_tag_string, 'ec-3')
    // TrueHD: refused unless -strict -2 (experimental in MP4), then written as mlpa - but no HLS player plays it
    const th = ff(['-i', path.join(dir, 't.mkv'), ...frag, path.join(dir, 't.mp4')])
    assert.notEqual(th.status, 0); assert.match(String(th.stderr), /truehd in MP4 support is experimental/)
    assert.equal(ff(['-i', path.join(dir, 't.mkv'), ...frag, '-strict', '-2', path.join(dir, 't2.mp4')]).status, 0)
    assert.equal(probeJson(path.join(dir, 't2.mp4')).streams[0].codec_tag_string, 'mlpa')
    // DTS: goes in as mp4a with an object-type indication - nothing standard, so it is never offered in HLS
    assert.equal(ff(['-i', path.join(dir, 'd.mkv'), ...frag, path.join(dir, 'd.mp4')]).status, 0)
    assert.equal(probeJson(path.join(dir, 'd.mp4')).streams[0].codec_tag_string, 'mp4a')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

// ----------------------------------------------------- HEVC, HDR10, Dolby Vision
function makeHdr10(dir, name = 'hdr10.mp4', seconds = 9) {
  const out = path.join(dir, name)
  const r = ff(['-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=24:duration=${seconds},format=${HEVC.pix}`, '-f', 'lavfi', '-i', `sine=frequency=330:duration=${seconds},aformat=channel_layouts=5.1`,
    '-map', '0:v', '-map', '1:a', ...hevcArgs(), ...(/\.mp4$/.test(name) ? ['-tag:v', 'hvc1'] : []), '-c:a', 'eac3', '-b:a', '384k', out])
  assert.equal(r.status, 0, String(r.stderr))
  return out
}

test('real ffmpeg: HEVC with HDR10 signalling is copied into fragmented MP4 as hvc1 with the signalling intact', { skip: skipHevc }, async () => {
  const dir = workDir('hdr10')
  const env = newManager(dir)
  try {
    const src = makeHdr10(dir, 'hdr10.mkv')
    const { s, tracks } = await openSession(env, src, { a: 1, ac: 'copy', t: 'hvc1' })
    assert.equal(tracks.video.hdrType, 'HDR10'); assert.equal(tracks.video.bitDepth, HEVC.bits)
    const init = await env.manager.initSegment(s)
    const got = []
    for (let n = 0; n < s.segments.length; n++) got.push(await env.manager.segment(s, n))
    const out = join(dir, 'out.mp4', [init, ...got])
    const st = probeJson(out).streams
    assert.equal(st[0].codec_name, 'hevc'); assert.equal(st[0].codec_tag_string, 'hvc1'); assert.equal(st[0].pix_fmt, HEVC.pix)
    assert.equal(st[0].color_transfer, 'smpte2084'); assert.equal(st[0].color_primaries, 'bt2020'); assert.equal(st[0].color_space, 'bt2020nc')  // from the stream's own VUI: the copy did not touch it
    assert.equal(st[1].codec_tag_string, 'ec-3')
    assert.equal(md5Of(out, '0:v:0'), md5Of(src, '0:v:0'), 'HDR10 picture copied bit for bit')
    // the default tag would have been hev1, which Apple devices and browsers refuse
    const def = ff(['-i', src, '-map', '0:v', '-c', 'copy', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', path.join(dir, 'default.mp4')])
    assert.equal(def.status, 0)
    assert.equal(probeJson(path.join(dir, 'default.mp4')).streams[0].codec_tag_string, 'hev1')
  } finally { env.manager.closeAll(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('real ffmpeg: Dolby Vision signalling survives the copy only with -strict unofficial and the dvh1 tag; the RPU can be stripped for an HDR10-only player', { skip: skipHevc }, () => {
  const dir = workDir('dv')
  try {
    // an MP4 that declares Dolby Vision profile 8.1 (the picture has no RPU: this exercises probe, tag and box, not Dolby playback)
    const plain = makeHdr10(dir, 'plain.mp4')
    const dvFile = path.join(dir, 'dv81.mp4')
    fs.writeFileSync(dvFile, addDolbyVisionBox(fs.readFileSync(plain), { profile: 8, level: 6, compatId: 1 }))
    const parsed = tracksLib.parseTracks(probeJson(dvFile, ['-show_entries', 'stream_side_data']).streams ? JSON.parse(spawnSync(FFPROBE, [...tracksLib.PROBE_ARGS, dvFile], { encoding: 'utf8' }).stdout) : null)
    assert.equal(parsed.video.hdrType, 'Dolby Vision'); assert.equal(parsed.video.dolbyVision.label, '8.1'); assert.equal(parsed.video.dolbyVision.baseLooksLike, 'HDR10')
    const has = (f, box) => fs.readFileSync(f).includes(box)
    const remux = (name, extra) => { const o = path.join(dir, name); const r = ff(['-i', dvFile, '-map', '0', '-c', 'copy', ...extra, '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof+delay_moov', o]); assert.equal(r.status, 0, String(r.stderr)); return o }
    // WITHOUT the flag the muxer keeps the dvh1 name but silently drops the configuration box: a Dolby Vision file that is not one
    const noFlag = remux('noflag.mp4', ['-tag:v', 'dvh1'])
    assert.equal(has(noFlag, 'dvvC') || has(noFlag, 'dvcC'), false, 'measured: the box is dropped without -strict unofficial')
    // WITH it, the box (dvvC for profile 8) is written and the probe sees the same Dolby Vision profile again
    const kept = remux('kept.mp4', ['-tag:v', 'dvh1', '-strict', 'unofficial'])
    assert.ok(has(kept, 'dvvC'))
    const back = tracksLib.parseTracks(JSON.parse(spawnSync(FFPROBE, [...tracksLib.PROBE_ARGS, kept], { encoding: 'utf8' }).stdout))
    assert.equal(back.video.dolbyVision.label, '8.1'); assert.equal(back.video.dolbyVision.fromTagOnly, false)
    assert.equal(probeJson(kept).streams[0].codec_tag_string, 'dvh1')
    // stripped for a player without Dolby Vision: no box, hvc1, still HDR10
    const stripped = remux('stripped.mp4', ['-tag:v', 'hvc1', '-bsf:v', 'dovi_rpu=strip=1'])
    assert.equal(has(stripped, 'dvvC') || has(stripped, 'dvcC'), false)
    const s2 = tracksLib.parseTracks(JSON.parse(spawnSync(FFPROBE, [...tracksLib.PROBE_ARGS, stripped], { encoding: 'utf8' }).stdout))
    assert.equal(s2.video.hdrType, 'HDR10'); assert.equal(s2.video.dolbyVision, null)
    // profile 7 is written with a dvcC box (profiles up to 7 use dvcC, 8 and up use dvvC)
    const p7 = path.join(dir, 'dv7.mp4')
    fs.writeFileSync(p7, addDolbyVisionBox(fs.readFileSync(plain), { profile: 7, level: 6, el: 1, compatId: 6 }))
    const o7 = path.join(dir, 'o7.mp4')
    assert.equal(ff(['-i', p7, '-map', '0', '-c', 'copy', '-tag:v', 'dvh1', '-strict', 'unofficial', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof+delay_moov', o7]).status, 0)
    assert.ok(has(o7, 'dvcC'))
    // the same through the app's own command builder
    const tr = parsed
    const args = rx.buildRemuxArgs({ input: dvFile, tracks: tr, rx: { a: tr.audio[0].streamIndex, ac: 'copy', t: 'dvh1' } })
    const viaBuilder = path.join(dir, 'builder.mp4')
    const run = spawnSync(FFMPEG, [...args.slice(0, -1), viaBuilder], { maxBuffer: 64 * 1024 * 1024 })
    assert.equal(run.status, 0, String(run.stderr))
    assert.ok(has(viaBuilder, 'dvvC'))
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
