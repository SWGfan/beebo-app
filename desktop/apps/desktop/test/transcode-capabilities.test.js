// Encoder capability probe, the owner's override, tone-mapping and the old-PC profile
// (electron/encoderCapabilities.js + hlsVideoChain.js + hlsTranscoder.buildTranscodeArgs).
// No ffmpeg, no GPU: a fake `run` plays ffmpeg's answers, so every machine (with or without hardware) is tested.
// Run: node --test test/transcode-capabilities.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { createRequire } = require('node:module')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))
const caps = localRequire('./electron/encoderCapabilities')
const chain = localRequire('./electron/hlsVideoChain')
const hls = localRequire('./electron/hlsTranscoder')

const VERSION_LGPL = 'ffmpeg version 7.1-test Copyright (c) 2000-2025 the FFmpeg developers\nconfiguration: --enable-version3 --enable-libopenh264 --enable-vaapi\n'
const ENCODERS_ALL = [
  ' V....D h264_nvenc           NVIDIA NVENC H.264 encoder',
  ' V....D hevc_nvenc           NVIDIA NVENC hevc encoder',
  ' V..... h264_qsv             H.264 (Intel Quick Sync Video acceleration)',
  ' V....D h264_amf             AMD AMF H.264 Encoder',
  ' V....D h264_videotoolbox    VideoToolbox H.264',
  ' V....D h264_vaapi           H.264/AVC (VAAPI)',
  ' V....D libopenh264          OpenH264 H.264 / AVC',
  ' A....D aac                  AAC',
  ' A....D ac3                  ATSC A/52A (AC-3)',
  ''
].join('\n')
const FILTERS_ALL = [' .S zscale            V->V       resize', ' .S tonemap           V->V       tonemap', ' .. libplacebo        N->V       placebo', ' .. tonemap_opencl    V->V       opencl', ' .. tonemap_vaapi     V->V       vaapi', ''].join('\n')

/**
 * A fake ffmpeg. `outcomes` maps an encoder id or tone-map method to { code, stderr, hang }.
 * Everything else succeeds. Records every call in `calls`.
 */
function fakeRun({ version = VERSION_LGPL, encoders = ENCODERS_ALL, filters = FILTERS_ALL, outcomes = {}, throwOn = null } = {}) {
  const calls = []
  const run = async (args) => {
    calls.push(args)
    if (throwOn && throwOn(args)) throw new Error('spawn EPERM D:\\Movies\\Secret Film (2020).mkv')
    if (args.includes('-version')) return { code: 0, stdout: version }
    if (args.includes('-encoders')) return { code: 0, stdout: encoders }
    if (args.includes('-filters')) return { code: 0, stdout: filters }
    const vf = args[args.indexOf('-vf') + 1] || ''
    const enc = args.includes('-c:v') ? args[args.indexOf('-c:v') + 1] : null
    let key = enc
    if (!enc) {
      key = /tonemap_vaapi/.test(vf) ? 'tonemap_vaapi' : /libplacebo/.test(vf) ? 'libplacebo' : /tonemap_opencl/.test(vf) ? 'tonemap_opencl' : 'zscale'
    }
    const o = outcomes[key]
    if (o && o.byDevice) {
      const dev = (args.find((a) => /^vaapi=va:/.test(a)) || '').slice('vaapi=va:'.length)
      const d = o.byDevice[dev]
      if (d) return { code: d.code, stdout: '', stderr: d.stderr || '' }
    }
    if (o && !o.byDevice) return { code: o.code == null ? 1 : o.code, stdout: '', stderr: o.stderr || '', timedOut: !!o.timedOut }
    return { code: 0, stdout: '', stderr: '' }
  }
  return { run, calls }
}

const byId = (c) => Object.fromEntries(c.encoders.map((e) => [e.id, e]))

test('probe: every candidate is test-encoded; each is recorded working or unavailable with a plain reason', async () => {
  const f = fakeRun({
    outcomes: {
      h264_nvenc: { stderr: 'Cannot load nvcuda.dll\n[h264_nvenc @ 000001b2c3d4e5f6] Cannot load nvcuda.dll' },
      hevc_nvenc: { stderr: 'Cannot load nvcuda.dll' },
      h264_qsv: { stderr: 'Error initializing an internal MFX session: unsupported (-3)' },
      h264_amf: { stderr: 'DLL amfrt64.dll failed to open' }
    }
  })
  const c = await caps.probeCapabilities({ ffmpegPath: 'ffmpeg', run: f.run, platform: 'win32' })
  const e = byId(c)
  assert.equal(c.installed, true)
  assert.equal(c.ffmpeg.version, '7.1-test')
  assert.equal(c.ffmpeg.license, 'lgpl')
  assert.equal(e.h264_nvenc.ok, false)
  assert.equal(e.h264_nvenc.reason, 'No NVIDIA graphics card or driver found.')
  assert.equal(e.hevc_nvenc.reason, 'No NVIDIA graphics card or driver found.')
  assert.equal(e.hevc_nvenc.usedForHls, false, 'HEVC is detected and shown, not used for HLS pieces')
  assert.match(e.h264_qsv.reason, /Intel Quick Sync/)
  assert.match(e.h264_amf.reason, /AMD/)
  assert.equal(e.libopenh264.ok, true)
  assert.equal(e.libopenh264.state, 'ok')
  assert.equal(e.libopenh264.hardware, false)
  // Not applicable on Windows: never even run.
  assert.equal(e.h264_videotoolbox.state, 'skipped')
  assert.equal(e.h264_vaapi.state, 'skipped')
  assert.equal(f.calls.filter((a) => a.includes('h264_videotoolbox') || a.includes('h264_vaapi')).length, 0)
  // libx264 is not in this (LGPL) ffmpeg: recorded as such, not test-encoded.
  assert.equal(e.libx264.reason, 'Not built into this ffmpeg.')
  assert.equal(f.calls.filter((a) => a.includes('libx264')).length, 0)
  // The test encode is one second of a real (interlaced) picture: 30 frames at 29.97 fps.
  const nv = f.calls.find((a) => a.includes('h264_nvenc'))
  assert.equal(nv[nv.indexOf('-frames:v') + 1], '30')
  assert.match(nv[nv.indexOf('-i') + 1], /rate=30000\/1001:duration=1/)
  assert.deepEqual(c.audio, { aac: true, ac3: true, eac3: false })
})

test('probe: hardware that works is recorded; a GPL build is flagged; a listing alone never counts', async () => {
  const f = fakeRun({ version: 'ffmpeg version 6.0\nconfiguration: --enable-gpl --enable-libx264\n', encoders: ' V....D h264_nvenc x\n V....D libx264 x\n V....D libopenh264 x\n' })
  const c = await caps.probeCapabilities({ ffmpegPath: 'ffmpeg', run: f.run, platform: 'linux', listRenderNodes: () => [] })
  const e = byId(c)
  assert.equal(e.h264_nvenc.ok, true)
  assert.equal(e.h264_nvenc.hardware, true)
  assert.equal(e.libx264.ok, true)
  assert.equal(c.ffmpeg.license, 'gpl')
  // Listed in ffmpeg but the test encode failed: NOT usable.
  const f2 = fakeRun({ encoders: ' V....D h264_nvenc x\n V....D libopenh264 x\n', outcomes: { h264_nvenc: { code: 1, stderr: 'boom' } } })
  const c2 = await caps.probeCapabilities({ ffmpegPath: 'ffmpeg', run: f2.run, platform: 'win32' })
  assert.equal(byId(c2).h264_nvenc.ok, false)
  assert.match(byId(c2).h264_nvenc.reason, /^Test encode failed: boom/)
})

test('probe: VAAPI auto-detects the /dev/dri render node - the first one that really encodes wins', async () => {
  const f = fakeRun({
    outcomes: { h264_vaapi: { byDevice: { '/dev/dri/renderD128': { code: 1, stderr: 'Failed to initialise VAAPI connection: -1 (unknown libva error).' }, '/dev/dri/renderD129': { code: 0 } } } }
  })
  const c = await caps.probeCapabilities({ ffmpegPath: 'ffmpeg', run: f.run, platform: 'linux', listRenderNodes: () => ['/dev/dri/renderD128', '/dev/dri/renderD129'] })
  const v = byId(c).h264_vaapi
  assert.equal(v.ok, true)
  assert.equal(v.device, '/dev/dri/renderD129')
  const args = f.calls.filter((a) => a.includes('h264_vaapi'))
  assert.equal(args.length, 2, 'both nodes tried in order')
  assert.ok(args[0].includes('vaapi=va:/dev/dri/renderD128'))
  assert.match(args[0][args[0].indexOf('-vf') + 1], /format=nv12,hwupload$/)
  // No render node at all: a plain reason, nothing spawned for VAAPI.
  const f2 = fakeRun()
  const c2 = await caps.probeCapabilities({ ffmpegPath: 'ffmpeg', run: f2.run, platform: 'linux', listRenderNodes: () => [] })
  assert.equal(byId(c2).h264_vaapi.ok, false)
  assert.match(byId(c2).h264_vaapi.reason, /No graphics render device/)
  assert.equal(f2.calls.filter((a) => a.includes('h264_vaapi')).length, 0)
  // Permission problem on the node is explained.
  const f3 = fakeRun({ outcomes: { h264_vaapi: { code: 1, stderr: 'Failed to open /dev/dri/renderD128: Permission denied' } } })
  const c3 = await caps.probeCapabilities({ ffmpegPath: 'ffmpeg', run: f3.run, platform: 'linux', listRenderNodes: () => ['/dev/dri/renderD128'] })
  assert.match(byId(c3).h264_vaapi.reason, /"render" group/)
  // Render-node listing is Linux only, and only renderD*.
  assert.deepEqual(caps.defaultRenderNodes('win32'), [])
  assert.deepEqual(caps.defaultRenderNodes('linux', () => ['card0', 'renderD129', 'renderD128', 'by-path']), ['/dev/dri/renderD128', '/dev/dri/renderD129'])
  assert.deepEqual(caps.defaultRenderNodes('linux', () => { throw new Error('ENOENT') }), [])
})

test('the self-test encode is the REAL thing in miniature: interlaced input, de-interlace, the same chain and the same encoder settings as a 480p conversion', async () => {
  const vf = (a) => a[a.indexOf('-vf') + 1]
  const q = hls.QUALITIES['480p']
  for (const enc of ['h264_nvenc', 'h264_qsv', 'h264_amf', 'libopenh264']) {
    const a = caps.testEncodeArgs(enc, { deinterlace: true })
    assert.match(a[a.indexOf('-i') + 1], /setfield=tff/, 'top-field-first interlaced 480i-style picture')
    assert.match(vf(a), /^yadif=mode=0:parity=-1:deint=1,scale=854:480,format=(nv12|yuv420p)$/)
    // Exactly the encoder arguments a conversion uses (bitrate, profile, IDR handling) - not defaults.
    const real = hls.encoderArgs(enc, q)
    assert.deepEqual(a.slice(a.indexOf('-c:v'), a.indexOf('-c:v') + real.length), real)
    assert.equal(a[a.indexOf('-force_key_frames') + 1], 'expr:gte(t,n_forced*2)')
  }
  assert.match(vf(caps.testEncodeArgs('h264_qsv', { deinterlace: true })), /format=nv12$/, 'Quick Sync reads NV12')
  const nv = caps.testEncodeArgs('h264_nvenc', { deinterlace: true })
  assert.ok(nv.includes('-forced-idr') && nv.includes('-profile:v') && nv.includes('-b:v'))
  // VAAPI: device opened, frames uploaded.
  const va = caps.testEncodeArgs('h264_vaapi', { deinterlace: true, device: '/dev/dri/renderD129' })
  assert.ok(va.includes('vaapi=va:/dev/dri/renderD129'))
  assert.match(vf(va), /^yadif=.*,format=nv12,hwupload$/)
  // HEVC is not a live-conversion encoder: it only has to start.
  const hev = caps.testEncodeArgs('hevc_nvenc', { deinterlace: true })
  assert.deepEqual(hev.slice(hev.indexOf('-c:v'), hev.indexOf('-c:v') + 2), ['-c:v', 'hevc_nvenc'])
  assert.equal(hev.includes('-b:v'), false)
  // An encoder Beebo has never heard of gets its own name, not x264's flags.
  const odd = caps.testEncodeArgs('h264_foo')
  assert.equal(odd[odd.indexOf('-c:v') + 1], 'h264_foo')
  assert.equal(odd.includes('-preset'), false)
  // No yadif in this ffmpeg -> the probe leaves it out instead of failing every encoder.
  assert.doesNotMatch(vf(caps.testEncodeArgs('libopenh264', { deinterlace: false })), /yadif/)
  const f = fakeRun({ filters: ' .S zscale x\n .S tonemap x\n', encoders: ' V libopenh264 x\n' })
  await caps.probeCapabilities({ ffmpegPath: 'ffmpeg', run: f.run, platform: 'win32' })
  assert.ok(f.calls.filter((c) => c.includes('libopenh264')).every((c) => !/yadif/.test(vf(c))))
  const f2 = fakeRun({ filters: ' TS yadif x\n', encoders: ' V libopenh264 x\n' })
  await caps.probeCapabilities({ ffmpegPath: 'ffmpeg', run: f2.run, platform: 'win32' })
  assert.ok(f2.calls.filter((c) => c.includes('libopenh264')).every((c) => /^yadif=/.test(vf(c))))
})

test('a hardware encoder that only fails with its real settings is caught by the probe (it can no longer say "works" when a conversion would die)', async () => {
  // Fake driver: accepts a bare encode but refuses the real options (-forced_idr / a bitrate).
  const run = async (args) => {
    if (args.includes('-version') || args.includes('-encoders') || args.includes('-filters')) return { code: 0, stdout: args.includes('-encoders') ? ' V h264_qsv x\n V libopenh264 x\n' : '' }
    const enc = args[args.indexOf('-c:v') + 1]
    if (enc === 'h264_qsv' && args.includes('-forced_idr')) return { code: 1, stderr: 'Error initializing an internal MFX session: invalid video param (-15)' }
    return { code: 0 }
  }
  const c = await caps.probeCapabilities({ ffmpegPath: 'ffmpeg', run, platform: 'win32' })
  assert.equal(byId(c).h264_qsv.ok, false)
  assert.equal(byId(c).libopenh264.ok, true)
  assert.deepEqual(caps.planEncoders(c).chain, ['libopenh264'])
})

test('probe never throws: a run that throws, hangs or cannot start is just "not available"', async () => {
  // Every child fails to start.
  const c = await caps.probeCapabilities({ ffmpegPath: 'ffmpeg', run: async () => { throw new Error('spawn EPERM') }, platform: 'win32' })
  assert.equal(c.installed, true)
  assert.ok(c.encoders.every((e) => !e.ok), 'nothing works, nothing crashed')
  // A driver that hangs: the timeout reason, and the error text never leaks a path.
  const f = fakeRun({ outcomes: { h264_nvenc: { code: 1, timedOut: true } }, throwOn: (a) => a.includes('h264_amf') })
  const c2 = await caps.probeCapabilities({ ffmpegPath: 'ffmpeg', run: f.run, platform: 'win32', timeoutMs: 15000 })
  assert.match(byId(c2).h264_nvenc.reason, /within 15 s/)
  assert.ok(!/Secret Film|D:\\/.test(JSON.stringify(c2)), 'no library path in what is stored/shown')
  assert.equal(byId(c2).libopenh264.ok, true, 'the rest were still probed')
  // No ffmpeg at all.
  const none = await caps.probeCapabilities({ ffmpegPath: null })
  assert.equal(none.installed, false)
  assert.deepEqual(none.encoders, [])
  // A real ffmpeg path that does not exist: the default runner resolves, it does not throw.
  const real = await caps.probeCapabilities({ ffmpegPath: path.join(__dirname, 'definitely-not-ffmpeg.exe'), platform: 'win32' })
  assert.ok(real.encoders.every((e) => !e.ok))
})

test('tone-mapping: each method is listed AND proven; the best working one is chosen; missing filters are said so', async () => {
  const f = fakeRun({
    outcomes: {
      libplacebo: { code: 1, stderr: 'Error opening output files: Generic error in an external library' },
      tonemap_opencl: { code: 1, stderr: 'Error parsing global options: No such device' }
    }
  })
  const c = await caps.probeCapabilities({ ffmpegPath: 'ffmpeg', run: f.run, platform: 'win32' })
  const m = Object.fromEntries(c.tonemap.methods.map((x) => [x.id, x]))
  assert.equal(m.zscale.ok, true)
  assert.equal(m.libplacebo.ok, false)
  assert.equal(m.libplacebo.reason, 'No working Vulkan graphics driver.')
  assert.equal(m.tonemap_opencl.reason, 'No OpenCL graphics device found.')
  assert.equal(m.tonemap_vaapi.reason, 'Linux only.')
  assert.deepEqual(c.tonemap.working, ['zscale'])
  assert.equal(c.tonemap.best, 'zscale')
  // The proof runs against a picture tagged as HDR10 (PQ / BT.2020).
  const zs = f.calls.find((a) => (a[a.indexOf('-vf') + 1] || '').includes('tonemap=tonemap=hable'))
  assert.match(zs[zs.indexOf('-i') + 1], /color_trc=smpte2084/)

  // GPU methods win when they work; VAAPI tone-map needs a working VAAPI encoder.
  const f2 = fakeRun()
  const c2 = await caps.probeCapabilities({ ffmpegPath: 'ffmpeg', run: f2.run, platform: 'linux', listRenderNodes: () => ['/dev/dri/renderD128'] })
  assert.deepEqual(c2.tonemap.working, ['tonemap_vaapi', 'libplacebo', 'tonemap_opencl', 'zscale'])
  assert.equal(c2.tonemap.best, 'tonemap_vaapi')
  const va = f2.calls.find((a) => (a[a.indexOf('-vf') + 1] || '').includes('tonemap_vaapi'))
  assert.ok(va.includes('vaapi=va:/dev/dri/renderD128'), 'proved on the render node that encodes')
  assert.match(va[va.indexOf('-vf') + 1], /hwdownload,format=nv12$/)

  // Filters not built in: reported, never spawned; no method at all = 'none' (the safe fallback).
  const f3 = fakeRun({ filters: ' .. scale V->V scale\n' })
  const c3 = await caps.probeCapabilities({ ffmpegPath: 'ffmpeg', run: f3.run, platform: 'win32' })
  assert.deepEqual(c3.tonemap.working, [])
  assert.equal(c3.tonemap.best, 'none')
  assert.ok(c3.tonemap.methods.every((x) => x.reason === 'Not built into this ffmpeg.' || x.reason === 'Linux only.'))
})

test('HDR filter chains: the picture is made small first, each method has its own device setup', () => {
  const size = { width: 1280, height: 720 }
  const z = chain.videoFilterPlan({ encoder: 'libopenh264', size, tonemap: 'zscale' })
  assert.deepEqual(z.chain, ['scale=1280:720', 'zscale=t=linear:npl=100', 'format=gbrpf32le', 'zscale=p=bt709', 'tonemap=tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv', 'format=yuv420p'])
  assert.deepEqual(z.initArgs, [])
  const q = chain.videoFilterPlan({ encoder: 'h264_qsv', size, tonemap: 'zscale' })
  assert.equal(q.chain[q.chain.length - 1], 'format=nv12', 'Quick Sync reads NV12')
  const p = chain.videoFilterPlan({ encoder: 'h264_nvenc', size, tonemap: 'libplacebo' })
  assert.match(p.chain[0], /^libplacebo=w=1280:h=720:tonemapping=bt\.2390/)
  const o = chain.videoFilterPlan({ encoder: 'h264_nvenc', size, tonemap: 'tonemap_opencl' })
  assert.deepEqual(o.initArgs, ['-init_hw_device', 'opencl=ocl', '-filter_hw_device', 'ocl'])
  assert.ok(o.chain.includes('hwupload') && o.chain.includes('hwdownload'))
  const v = chain.videoFilterPlan({ encoder: 'h264_vaapi', size, tonemap: 'tonemap_vaapi', device: '/dev/dri/renderD129' })
  assert.deepEqual(v.initArgs, ['-init_hw_device', 'vaapi=va:/dev/dri/renderD129', '-filter_hw_device', 'va'])
  assert.match(v.chain[v.chain.length - 1], /^tonemap_vaapi=format=nv12/)
  // A method that cannot combine with the encoder is ignored (one -filter_hw_device per command).
  const bad = chain.videoFilterPlan({ encoder: 'h264_vaapi', size, tonemap: 'tonemap_opencl', device: '/dev/dri/renderD129' })
  assert.deepEqual(bad.chain, ['scale=1280:720', 'format=nv12', 'hwupload'])
  const plainVaapi = chain.videoFilterPlan({ encoder: 'h264_vaapi', size })
  assert.deepEqual(plainVaapi.chain, ['scale=1280:720', 'format=nv12', 'hwupload'])
  // Only the methods that fit, best first.
  assert.deepEqual(chain.methodsForEncoder(['tonemap_vaapi', 'libplacebo', 'tonemap_opencl', 'zscale'], 'h264_vaapi'), ['tonemap_vaapi', 'libplacebo', 'zscale'])
  assert.deepEqual(chain.methodsForEncoder(['tonemap_vaapi', 'libplacebo', 'tonemap_opencl', 'zscale'], 'h264_nvenc'), ['libplacebo', 'tonemap_opencl', 'zscale'])

  // The real command: HDR only tone-maps when the source is HDR; SDR is untouched; unknown methods are safe.
  const tracks = (hdr) => ({ durationSec: 60, video: { streamIndex: 0, width: 3840, height: 2160, fps: 24, hdr }, audio: [] })
  const vf = (a) => a[a.indexOf('-vf') + 1]
  assert.match(vf(hls.buildTranscodeArgs({ input: 'f', tracks: tracks(true), quality: '720p', encoder: 'libopenh264', outDir: 'o', tonemap: 'zscale' })), /^scale=1280:720,zscale=/)
  assert.doesNotMatch(vf(hls.buildTranscodeArgs({ input: 'f', tracks: tracks(false), quality: '720p', encoder: 'libopenh264', outDir: 'o', tonemap: 'zscale' })), /zscale|tonemap/)
  assert.doesNotMatch(vf(hls.buildTranscodeArgs({ input: 'f', tracks: tracks(true), quality: '720p', encoder: 'libopenh264', outDir: 'o', tonemap: null })), /zscale|tonemap/, 'no method = plain scale (dull but playing)')
  const va = hls.buildTranscodeArgs({ input: 'f', tracks: tracks(true), quality: '720p', encoder: 'h264_vaapi', outDir: 'o', tonemap: 'tonemap_vaapi', device: '/dev/dri/renderD129' })
  assert.ok(va.indexOf('-init_hw_device') < va.indexOf('-i'), 'device is set up before the input')
  assert.deepEqual(va.slice(va.indexOf('-c:v'), va.indexOf('-c:v') + 4), ['-c:v', 'h264_vaapi', '-profile:v', 'high'])
})

test('planEncoders: Automatic = hardware first then processor; "software" and "prefer" overrides; never empty while anything works', async () => {
  const f = fakeRun({ encoders: ' V h264_nvenc\n V h264_qsv\n V h264_amf\n V libopenh264\n', outcomes: { h264_amf: { code: 1, stderr: 'AMF failed' } } })
  const c = await caps.probeCapabilities({ ffmpegPath: 'ffmpeg', run: f.run, platform: 'win32' })
  assert.deepEqual(caps.planEncoders(c).chain, ['h264_nvenc', 'h264_qsv', 'libopenh264'])
  assert.deepEqual(caps.planEncoders(c, { mode: 'auto' }).chain, ['h264_nvenc', 'h264_qsv', 'libopenh264'])
  assert.deepEqual(caps.planEncoders(c, { mode: 'software' }).chain, ['libopenh264'])
  assert.deepEqual(caps.planEncoders(c, { mode: 'h264_qsv' }).chain, ['h264_qsv', 'h264_nvenc', 'libopenh264'], 'preferred first, the rest still behind it as fallbacks')
  const missing = caps.planEncoders(c, { mode: 'h264_amf' })
  assert.deepEqual(missing.chain, ['h264_nvenc', 'h264_qsv', 'libopenh264'])
  assert.match(missing.note, /preferred encoder .* not working/)
  assert.equal(caps.planEncoders(c).primary.id, 'h264_nvenc')
  // Hardware that failed while people were watching goes last (but is not thrown away).
  const health = new Map([['h264_nvenc', { failures: 2, demotedUntil: 5000 }]])
  assert.deepEqual(caps.planEncoders(c, { health, now: 1000 }).chain, ['h264_qsv', 'libopenh264', 'h264_nvenc'])
  assert.deepEqual(caps.planEncoders(c, { health, now: 6000 }).chain, ['h264_nvenc', 'h264_qsv', 'libopenh264'], 'the demotion expires')
  // Forced software with no software encoder working: the hardware is used rather than a dead player.
  const f2 = fakeRun({ encoders: ' V h264_nvenc\n', outcomes: {} })
  const c2 = await caps.probeCapabilities({ ffmpegPath: 'ffmpeg', run: f2.run, platform: 'win32' })
  const p = caps.planEncoders(c2, { mode: 'software' })
  assert.deepEqual(p.chain, ['h264_nvenc'])
  assert.match(p.note, /No processor encoder/)
  // Nothing works: an empty chain (live conversion off), not a crash.
  assert.deepEqual(caps.planEncoders(caps.emptyCaps('x')).chain, [])
  assert.equal(caps.planEncoders(null).primary, null)
})

function memoryStore() {
  const data = {}
  return { data, get: (k) => data[k], set: (k, v) => { data[k] = JSON.parse(JSON.stringify(v)) } }
}

test('service: probes once, caches to the settings store, re-probes when the ffmpeg file changes, after the TTL, or on demand', async () => {
  const store = memoryStore()
  let clock = 1_000_000
  let stat = { size: 100, mtimeMs: 111 }
  const f = fakeRun()
  const mk = () => caps.createEncoderService({ getFfmpegPath: () => 'C:\\ffmpeg\\ffmpeg.exe', store, run: f.run, platform: 'win32', now: () => clock, statFn: () => stat, cpus: 4, totalMem: 8 * 1024 ** 3 })
  const a = mk()
  const first = await a.capabilities()
  const probes = () => f.calls.filter((c) => c.includes('-version')).length
  assert.equal(probes(), 1)
  // Concurrent callers share one probe; later ones hit memory.
  await Promise.all([a.capabilities(), a.capabilities()])
  await a.selection()
  assert.equal(probes(), 1)
  assert.ok(store.data.transcodeProbeCache && store.data.transcodeProbeCache.caps.encoders.length > 0, 'saved to the store')
  // A fresh service (app restart) reads the cache: no new test encodes.
  const b = mk()
  const again = await b.capabilities()
  assert.equal(probes(), 1)
  assert.deepEqual(again.encoders.map((e) => e.id), first.encoders.map((e) => e.id))
  // The ffmpeg binary changed (an update dropped a new build in): probed again.
  stat = { size: 100, mtimeMs: 222 }
  await b.capabilities()
  assert.equal(probes(), 2)
  await mk().capabilities()
  assert.equal(probes(), 2, 'the new fingerprint was cached too')
  // Old cache: re-probed.
  clock += 4 * 24 * 3600 * 1000
  await mk().capabilities()
  assert.equal(probes(), 3)
  // On demand ("Check again").
  await b.capabilities({ force: true })
  assert.equal(probes(), 4)
  // A different platform's cache is not trusted.
  const other = caps.createEncoderService({ getFfmpegPath: () => 'C:\\ffmpeg\\ffmpeg.exe', store, run: f.run, platform: 'linux', now: () => clock, statFn: () => stat, listRenderNodes: () => [] })
  await other.capabilities()
  assert.equal(probes(), 5)
  // No ffmpeg: nothing spawned, a clear answer.
  const none = caps.createEncoderService({ getFfmpegPath: () => null, store, run: f.run })
  assert.equal((await none.selection()).encoder, null)
  assert.equal((await none.status()).ok, false)
  assert.match((await none.status()).message, /not installed/)
  assert.equal(probes(), 5)
})

test('service: a hardware encoder that fails while people watch is demoted after two strikes, forgiven on success', async () => {
  let clock = 1000
  const f = fakeRun({ encoders: ' V h264_nvenc\n V libopenh264\n' })
  const svc = caps.createEncoderService({ getFfmpegPath: () => 'ffmpeg', run: f.run, platform: 'win32', now: () => clock, cpus: 4, totalMem: 8 * 1024 ** 3, demoteMs: 60000 })
  assert.deepEqual((await svc.selection()).chain, ['h264_nvenc', 'libopenh264'])
  svc.noteFailure('h264_nvenc', 'Cannot load nvcuda.dll')
  assert.deepEqual((await svc.selection()).chain, ['h264_nvenc', 'libopenh264'], 'one strike: still first')
  svc.noteFailure('h264_nvenc', 'Cannot load nvcuda.dll')
  assert.deepEqual((await svc.selection()).chain, ['libopenh264', 'h264_nvenc'], 'two strikes: software first, hardware last-resort')
  const st = await svc.status()
  const row = st.detected.find((d) => d.id === 'h264_nvenc')
  assert.equal(row.ok, true)
  assert.equal(row.demoted, true)
  assert.equal(row.failedInUse, true)
  assert.match(row.failedReason, /nvcuda/)
  clock += 61000
  assert.deepEqual((await svc.selection()).chain, ['h264_nvenc', 'libopenh264'], 'the demotion times out')
  svc.noteFailure('h264_nvenc', 'x'); svc.noteFailure('h264_nvenc', 'x')
  svc.noteSuccess('h264_nvenc')
  assert.deepEqual((await svc.selection()).chain, ['h264_nvenc', 'libopenh264'], 'a real success forgives')
  // Software failing is never demoted (nothing behind it).
  svc.noteFailure('libopenh264', 'y'); svc.noteFailure('libopenh264', 'y'); svc.noteFailure('libopenh264', 'y')
  assert.deepEqual((await svc.selection()).chain, ['h264_nvenc', 'libopenh264'])
})

test('service status: what Settings > Hardware acceleration shows', async () => {
  const f = fakeRun({ encoders: ' V h264_nvenc\n V h264_qsv\n V libopenh264\n', outcomes: { h264_nvenc: { code: 1, stderr: 'Cannot load nvcuda.dll' } } })
  const svc = caps.createEncoderService({ getFfmpegPath: () => 'ffmpeg', run: f.run, platform: 'win32', cpus: 4, totalMem: 8 * 1024 ** 3 })
  const st = await svc.status({ mode: '' })
  assert.equal(st.ok, true)
  assert.equal(st.encoder, 'h264_qsv')
  assert.equal(st.hardware, true)
  assert.match(st.message, /Intel Quick Sync \(hardware/)
  const nv = st.detected.find((d) => d.id === 'h264_nvenc')
  assert.deepEqual([nv.ok, nv.reason], [false, 'No NVIDIA graphics card or driver found.'])
  assert.match(st.hdr, /HDR films are converted to normal colours using: Graphics card \(libplacebo/)
  assert.equal(st.tonemap.best, 'libplacebo')
  const sw = await svc.status({ mode: 'software' })
  assert.equal(sw.encoder, 'libopenh264')
  assert.match(sw.message, /processor does the work/)
  // No graphics acceleration anywhere: said plainly.
  const f2 = fakeRun({ encoders: ' V libopenh264\n' })
  const svc2 = caps.createEncoderService({ getFfmpegPath: () => 'ffmpeg', run: f2.run, platform: 'win32', cpus: 2, totalMem: 8 * 1024 ** 3 })
  const s2 = await svc2.status()
  assert.match(s2.message, /No graphics acceleration was found/)
  assert.match(s2.message, /gentle mode/)
  // A "prefer" choice that does not work explains itself.
  const s3 = await svc.status({ mode: 'h264_nvenc' })
  assert.match(s3.message, /preferred encoder/)
  assert.equal(s3.encoder, 'h264_qsv')
})

test('old-PC profile: gentle defaults for a weak computer, more for a strong one, overridable', () => {
  const GB = 1024 ** 3
  const cpu = (n, speed = 3000) => Array.from({ length: n }, () => ({ speed }))
  const weak = caps.performanceProfile({ cpus: cpu(2, 2200), totalMem: 4 * GB })
  assert.equal(weak.tier, 'low')
  assert.equal(weak.threads, 1)
  assert.equal(weak.x264Preset, 'ultrafast')
  assert.equal(weak.scaleFlags, 'bilinear')
  assert.equal(weak.openh264Cheap, true)
  assert.equal(caps.performanceProfile({ cpus: cpu(4, 2000), totalMem: 8 * GB }).tier, 'low', 'four slow cores')
  assert.equal(caps.performanceProfile({ cpus: cpu(4, 3400), totalMem: 8 * GB }).tier, 'normal')
  assert.equal(caps.performanceProfile({ cpus: cpu(8), totalMem: 2 * GB }).tier, 'low', 'not enough memory')
  const normal = caps.performanceProfile({ cpus: cpu(6), totalMem: 16 * GB })
  assert.equal(normal.tier, 'normal')
  assert.equal(normal.threads, 5, 'one core stays free')
  assert.equal(normal.x264Preset, 'veryfast')
  assert.equal(normal.scaleFlags, '')
  const high = caps.performanceProfile({ cpus: cpu(16), totalMem: 32 * GB })
  assert.equal(high.tier, 'high')
  assert.ok(high.threads <= 8)
  assert.equal(caps.performanceProfile({ cpus: cpu(16), totalMem: 32 * GB, cpuMode: 'gentle' }).tier, 'low', 'owner override')
  assert.equal(caps.performanceProfile({ cpus: cpu(2, 1800), totalMem: 2 * GB, cpuMode: 'normal' }).tier, 'normal')
  // Default number of conversions at once.
  assert.equal(caps.defaultMaxConcurrent(weak, false), 1)
  assert.equal(caps.defaultMaxConcurrent(normal, false), 2)
  assert.equal(caps.defaultMaxConcurrent(normal, true), 3)
  assert.equal(caps.defaultMaxConcurrent(high, true), 4)
  assert.equal(caps.defaultMaxConcurrent(null, false), 2)
})

test('old-PC profile reaches ffmpeg: capped threads, fastest preset, cheap scaler - and no profile = the long-standing command', () => {
  const tracks = { durationSec: 60, video: { streamIndex: 0, width: 1920, height: 1080, fps: 24 }, audio: [] }
  const base = { input: 'f', tracks, quality: '720p', outDir: 'o' }
  const weak = caps.performanceProfile({ cpus: [{ speed: 2000 }, { speed: 2000 }], totalMem: 4 * 1024 ** 3 })
  const x = hls.buildTranscodeArgs({ ...base, encoder: 'libx264', profile: weak })
  assert.equal(x[x.indexOf('-preset') + 1], 'ultrafast')
  assert.equal(x[x.indexOf('-threads') + 1], '1')
  assert.equal(x[x.indexOf('-filter_threads') + 1], '1')
  assert.match(x[x.indexOf('-vf') + 1], /scale=1280:720:flags=bilinear/)
  const o = hls.buildTranscodeArgs({ ...base, encoder: 'libopenh264', profile: weak })
  assert.ok(o.includes('-loopfilter') && o.includes('-coder'))
  assert.ok(o.includes('-threads'))
  // Graphics hardware does its own work: its threads are left alone.
  const g = hls.buildTranscodeArgs({ ...base, encoder: 'h264_nvenc', profile: weak })
  assert.equal(g.includes('-threads'), false)
  // Nothing configured: identical to before.
  const plain = hls.buildTranscodeArgs({ ...base, encoder: 'libx264' })
  assert.equal(plain[plain.indexOf('-preset') + 1], 'veryfast')
  assert.equal(plain.includes('-threads'), false)
  assert.equal(plain.includes('-filter_threads'), false)
  assert.equal(hls.encoderArgs('libopenh264', { videoKbps: 1500 }).includes('-loopfilter'), false)
})

test('failure text: classified for the fallback decision, redacted for the log', () => {
  assert.equal(caps.classifyRunFailure('Cannot load nvcuda.dll'), 'encoder')
  assert.equal(caps.classifyRunFailure('[h264_qsv @ 00000] Error initializing an internal MFX session'), 'encoder')
  assert.equal(caps.classifyRunFailure('D:\\Movies\\A.mkv: Invalid data found when processing input'), 'input')
  assert.equal(caps.classifyRunFailure('Error reinitializing filters!\nFailed to inject frame into filter network: Invalid argument'), 'filter')
  assert.equal(caps.classifyRunFailure('Impossible to convert between the formats supported by the filter'), 'filter')
  assert.equal(caps.classifyRunFailure('something odd'), 'unknown')
  const r = caps.redactReason('[h264_nvenc @ 000001b2c3d4e5f6] Could not open D:\\Movies\\Secret Film (2020).mkv?mt=abcdef&x=1\n/home/nick/Movies/Secret Film.mkv: Permission denied')
  assert.ok(!/Secret|nick|D:\\/i.test(r), r)
  assert.ok(r.length <= 140)
  assert.equal(caps.redactReason(''), '')
  assert.ok(caps.redactReason('x'.repeat(500)).length <= 140)
})

test('Settings IPC: override / limit / gentle-mode are validated and saved; status and load come from the running server', async () => {
  const ipc = localRequire('./electron/playbackSettingsIpc')
  const handlers = {}
  const ipcMain = { handle: (name, fn) => { handlers[name] = fn } }
  const store = memoryStore()
  const service = {
    defaultMax: () => 3,
    status: async ({ mode, force }) => ({ ok: true, encoder: 'h264_qsv', mode, forced: !!force, detected: [] })
  }
  let load = { active: 1, max: 3, queued: 0 }
  ipc.register({ ipcMain, store, getTranscode: () => ({ service, load: () => load }) })
  const call = (n, ...a) => handlers[n]({}, ...a)

  let s = await call('playback:getSettings')
  assert.equal(s.transcodeEncoder, '')
  assert.equal(s.transcodeMaxConcurrent, 3, 'automatic = the computer\'s own default')
  assert.equal(s.transcodeMaxConcurrentAuto, true)
  assert.equal(s.transcodeCpuMode, '')

  await call('playback:saveSettings', { transcodeEncoder: 'software', transcodeMaxConcurrent: 5, transcodeCpuMode: 'gentle' })
  s = await call('playback:getSettings')
  assert.deepEqual([s.transcodeEncoder, s.transcodeMaxConcurrent, s.transcodeMaxConcurrentAuto, s.transcodeCpuMode], ['software', 5, false, 'gentle'])
  await call('playback:saveSettings', { transcodeEncoder: 'h264_vaapi', transcodeMaxConcurrent: 99 })
  s = await call('playback:getSettings')
  assert.equal(s.transcodeEncoder, 'h264_vaapi')
  assert.equal(s.transcodeMaxConcurrent, 8, 'capped')
  // Junk is ignored, never stored.
  await call('playback:saveSettings', { transcodeEncoder: 'rm -rf', transcodeCpuMode: 'turbo' })
  s = await call('playback:getSettings')
  assert.equal(s.transcodeEncoder, 'h264_vaapi')
  assert.equal(s.transcodeCpuMode, 'gentle')
  // Back to automatic.
  await call('playback:saveSettings', { transcodeEncoder: '', transcodeMaxConcurrent: 'auto', transcodeCpuMode: '' })
  s = await call('playback:getSettings')
  assert.deepEqual([s.transcodeEncoder, s.transcodeMaxConcurrentAuto, s.transcodeMaxConcurrent, s.transcodeCpuMode], ['', true, 3, ''])

  await call('playback:saveSettings', { transcodeEncoder: 'h264_nvenc' })
  const st = await call('playback:encoderStatus', true)
  assert.deepEqual([st.encoder, st.mode, st.forced], ['h264_qsv', 'h264_nvenc', true], 'the owner\'s choice and "check again" reach the service')
  assert.deepEqual(await call('playback:transcodeLoad'), { active: 1, max: 3, queued: 0 })
  load = null
  assert.equal(await call('playback:transcodeLoad'), null)
})
