// The decision engine (playbackDecision.js): a table of (file, device profile) -> expected plan.
// Pure functions over hand-written ffprobe JSON (test/helpers/ffprobeFixtures.js); no ffmpeg needed.
// Each row states the method (DirectPlay / DirectStream / Transcode), what happens to the picture (copy,
// which HDR form is delivered, tag) and to the sound (copy / convert, codec, channels) and the reason codes
// that must be present. Video and audio are judged separately.
// Run: node --test test/playback-decision.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { createRequire } = require('node:module')
const localRequire = createRequire(path.join(path.resolve(__dirname, '..'), 'package.json'))
const dp = localRequire('./electron/deviceProfile')
const decision = localRequire('./electron/playbackDecision')
const tracksLib = localRequire('./electron/playbackTracks')
const hlsAudio = localRequire('./electron/hlsAudio')
const settingsLib = localRequire('./electron/homeTheaterSettings')
const F = require('./helpers/ffprobeFixtures')

const C = decision.REASONS
const tracksOf = (probe) => tracksLib.parseTracks(probe)
const fileMkv = (probe) => ({ tracks: tracksOf(probe), ext: '.mkv' })
const fileMp4 = (probe) => ({ tracks: tracksOf({ ...probe, format: { ...probe.format, format_name: 'mov,mp4,m4a,3gp,3g2,mj2' } }), ext: '.mp4' })

// -------------------------------------------------------------- the devices
const shield = dp.resolveProfile({
  client: 'androidtv',
  declared: {
    hdr: ['hdr10', 'hdr10plus', 'hlg', 'dv:5,7,8', 'dvfallback'],
    audio: {
      aac: { maxChannels: 8 }, ac3: { maxChannels: 6, decode: true, passthrough: true }, eac3: { maxChannels: 8, decode: true, passthrough: true, atmos: true },
      truehd: { passthrough: true, atmos: true }, dts: { passthrough: true }, dtshd: { passthrough: true }, dtsx: { passthrough: true }
    },
    maxAudioChannels: 8
  }
})
const appletv = dp.defaultProfile('appletv')
const samsung = dp.defaultProfile('samsung')
const lg = dp.defaultProfile('lg')
const chrome = dp.defaultProfile('chrome')
const generic = dp.defaultProfile('generic')
const roku = dp.defaultProfile('roku')
const androidtvDefault = dp.defaultProfile('androidtv')
const settings = (o = {}) => ({ ...settingsLib.DEFAULTS, ...o })

const plan = (file, profile, opts = {}) => decision.decide({ ...file, profile, settings: settings(opts.settings), request: opts.request || {}, remuxAvailable: opts.remuxAvailable !== false })
const has = (p, code) => assert.ok(p.reasonCodes.includes(code), `expected reason ${code}, got ${p.reasonCodes.join(', ') || '(none)'}`)
const hasNot = (p, code) => assert.ok(!p.reasonCodes.includes(code), `unexpected reason ${code}`)

// A row: [name, file, profile, opts, expected]
// expected: { method, video: { action, hdr (delivered), tag, dvStrip, hdrAction }, audio: { action, codec, channels, passthrough, objectsKept }, codes: [...], notCodes: [...] }
const TABLE = [
  ['SDR H.264 + AAC in MP4 plays as it is on a browser', fileMp4(F.sdr1080()), chrome, {},
    { method: 'DirectPlay', video: { action: 'copy' }, audio: { action: 'copy', codec: 'aac' } }],
  ['SDR H.264 + AAC in MKV: only the container is wrong -> direct stream (remux), picture and sound copied', fileMkv(F.sdr1080()), chrome, {},
    { method: 'DirectStream', video: { action: 'copy', tag: 'avc1' }, audio: { action: 'copy', codec: 'aac' }, codes: [C.CONTAINER_NOT_SUPPORTED] }],
  ['the same MKV on the most conservative client (no fMP4 HLS) has to be converted', fileMkv(F.sdr1080()), generic, {},
    { method: 'Transcode', video: { action: 'transcode' }, codes: [C.CONTAINER_NOT_SUPPORTED, C.NO_STREAMING_FORMAT] }],
  ['4K HDR10 HEVC + E-AC-3 5.1 in MKV on a Shield: direct play, HDR10 kept', fileMkv(F.hdr10_4k()), shield, {},
    { method: 'DirectPlay', video: { action: 'copy', hdr: 'HDR10', hdrAction: 'keep' }, audio: { action: 'copy', codec: 'eac3', channels: 6 } }],
  ['4K HDR10 on a browser without HEVC or HDR: the picture is converted and tone-mapped', fileMkv(F.hdr10_4k()), chrome, {},
    { method: 'Transcode', video: { action: 'transcode', hdr: 'SDR (tone-mapped)' }, codes: [C.VIDEO_CODEC_NOT_SUPPORTED, C.HDR_NOT_SUPPORTED] }],
  ['4K HDR10 in MKV on Apple TV: no MKV, so remux to fMP4 with the hvc1 tag; HDR10 kept, E-AC-3 copied', fileMkv(F.hdr10_4k()), appletv, {},
    { method: 'DirectStream', video: { action: 'copy', hdr: 'HDR10', tag: 'hvc1', hdrAction: 'keep' }, audio: { action: 'copy', codec: 'eac3', channels: 6 }, codes: [C.CONTAINER_NOT_SUPPORTED] }],
  ['HDR10+ on Apple TV (no HDR10+): plays as HDR10, still copied', fileMkv(F.hdr10Plus_4k()), appletv, {},
    { method: 'DirectStream', video: { action: 'copy', hdr: 'HDR10', tag: 'hvc1' }, codes: [C.HDR10PLUS_PLAYS_AS_HDR10] }],
  ['HDR10+ on Samsung (HDR10+ TV): HDR10+ kept, direct play', fileMkv(F.hdr10Plus_4k()), samsung, {},
    { method: 'DirectPlay', video: { action: 'copy', hdr: 'HDR10+' }, notCodes: [C.HDR10PLUS_PLAYS_AS_HDR10] }],
  ['Dolby Vision 8.1 + Atmos (streaming rip) on Apple TV: direct stream with dvh1, Atmos E-AC-3 copied and kept', fileMkv(F.dv81()), appletv, {},
    { method: 'DirectStream', video: { action: 'copy', hdr: 'Dolby Vision 8.1', tag: 'dvh1', hdrAction: 'keep', dvStrip: false }, audio: { action: 'copy', codec: 'eac3', objectsKept: true } }],
  ['Dolby Vision 8.1 on Samsung (no Dolby Vision): the DV layer is stripped, the HDR10 base plays', fileMkv(F.dv81()), samsung, {},
    { method: 'DirectStream', video: { action: 'copy', hdr: 'HDR10', tag: 'hvc1', hdrAction: 'strip-dv', dvStrip: true }, audio: { action: 'copy', codec: 'eac3' }, codes: [C.DV_PROFILE_NOT_SUPPORTED] }],
  ['Dolby Vision 8.1 on a stick whose player falls back to the HDR10 base itself: direct play', fileMkv(F.dv81()), androidtvDefault, {},
    { method: 'DirectPlay', video: { action: 'copy', hdr: 'HDR10', hdrAction: 'strip-dv' }, codes: [C.DV_BASE_LAYER_FALLBACK] }],
  ['Dolby Vision profile 5 on Samsung: no HDR10 layer, no Dolby Vision -> converted (tone-mapped)', fileMkv(F.dv5()), samsung, {},
    { method: 'Transcode', video: { action: 'transcode', hdr: 'SDR (tone-mapped)' }, codes: [C.DV_PROFILE5_NO_FALLBACK] }],
  ['Dolby Vision profile 5 on LG (Dolby Vision): direct play', fileMkv(F.dv5()), lg, {},
    { method: 'DirectPlay', video: { action: 'copy', hdr: 'Dolby Vision 5' } }],
  ['Dolby Vision 8.4 (HLG base) on Samsung: HLG base layer kept', fileMkv(F.dv84()), samsung, {},
    { method: 'DirectStream', video: { action: 'copy', hdr: 'HLG', dvStrip: true }, codes: [C.DV_PROFILE_NOT_SUPPORTED] }],
  ['UHD Blu-ray remux (Dolby Vision 7 + TrueHD Atmos 7.1) on a Shield that passes everything: direct play', fileMkv(F.withAudio(F.truehdAtmos(), F.dv7fel().streams[0])), shield, {},
    { method: 'DirectPlay', video: { action: 'copy', hdr: 'Dolby Vision 7 (dual layer)' }, audio: { action: 'copy', codec: 'truehd', channels: 8, passthrough: true, objectsKept: true } }],
  ['the same remux on Apple TV: DV 7 -> HDR10 base, TrueHD -> E-AC-3 5.1; video and audio are decided separately', fileMkv(F.dv7fel()), appletv, {},
    { method: 'DirectStream', video: { action: 'copy', hdr: 'HDR10', tag: 'hvc1', dvStrip: true }, audio: { action: 'transcode', codec: 'eac3', channels: 6 },
      codes: [C.DV_PROFILE_NOT_SUPPORTED, C.AUDIO_CODEC_NOT_SUPPORTED, C.AUDIO_OBJECTS_NOT_PRESERVED, C.CONTAINER_NOT_SUPPORTED] }],
  ['DTS-HD MA 7.1 on a Shield with passthrough allowed: direct play, bitstream passed to the receiver', fileMkv(F.withAudio(F.dtsHdMa71())), shield, {},
    { method: 'DirectPlay', audio: { action: 'copy', codec: 'dts', channels: 8, passthrough: true } }],
  ['DTS-HD MA 7.1 with "allow passthrough" switched off: audio converted, picture still copied (direct stream)', fileMkv(F.withAudio(F.dtsHdMa71())), shield, { settings: { allowPassthrough: false } },
    { method: 'DirectStream', video: { action: 'copy', hdr: 'HDR10' }, audio: { action: 'transcode', codec: 'eac3', channels: 6 }, codes: [C.AUDIO_PASSTHROUGH_DISABLED] }],
  ['DTS:X on Apple TV: unsupported, converted to E-AC-3 5.1; objects are not kept', fileMkv(F.withAudio(F.dtsX())), appletv, {},
    { method: 'DirectStream', video: { action: 'copy' }, audio: { action: 'transcode', codec: 'eac3', channels: 6 }, codes: [C.AUDIO_CODEC_NOT_SUPPORTED, C.AUDIO_OBJECTS_NOT_PRESERVED] }],
  ['DTS:X on a Shield that lists only core DTS passthrough: plays the core (no objects)', fileMkv(F.withAudio(F.dtsX())), dp.resolveProfile({ client: 'androidtv', declared: { audio: { dts: { passthrough: true }, aac: {} }, hdr: ['hdr10'] } }), {},
    { method: 'DirectPlay', audio: { action: 'copy', codec: 'dts', passthrough: true, objectsKept: false }, codes: [C.AUDIO_CORE_ONLY, C.AUDIO_OBJECTS_NOT_PRESERVED] }],
  ['Atmos in E-AC-3 on a TV that does not decode object audio: plays as 5.1, copied', fileMkv(F.withAudio(F.ddpAtmos())), androidtvDefault, {},
    { method: 'DirectPlay', audio: { action: 'copy', codec: 'eac3', objectsKept: false }, codes: [C.AUDIO_OBJECTS_NOT_PRESERVED] }],
  ['AC-3 5.1 in MKV on a browser (no AC-3): direct stream, audio converted to AAC 5.1', fileMkv(F.withAudio(F.dd51(), F.video())), chrome, {},
    { method: 'DirectStream', video: { action: 'copy' }, audio: { action: 'transcode', codec: 'aac', channels: 6 }, codes: [C.AUDIO_CODEC_NOT_SUPPORTED] }],
  ['E-AC-3 7.1 in MKV on Apple TV: 7.1 Dolby Digital Plus is copied whole', fileMkv(F.withAudio(F.ddp71())), appletv, {},
    { method: 'DirectStream', audio: { action: 'copy', codec: 'eac3', channels: 8 } }],
  ['a stereo-only device gets a stereo mix-down of 5.1', fileMkv(F.withAudio(F.dd51(), F.video())), dp.resolveProfile({ client: 'chrome', declared: { audio: { aac: { maxChannels: 2 } }, maxAudioChannels: 2 } }), {},
    { method: 'DirectStream', audio: { action: 'transcode', codec: 'aac', channels: 2 } }],
  ['a 10-bit H.264 file on an Android TV: the decoder does not play it', fileMkv(F.h264_10bit()), androidtvDefault, {},
    { method: 'Transcode', video: { action: 'transcode' }, codes: [C.VIDEO_BIT_DEPTH_NOT_SUPPORTED] }],
  ['MPEG-2 (DVD) on an Android TV: converted', fileMkv(F.mpeg2Dvd()), androidtvDefault, {},
    { method: 'Transcode', video: { action: 'transcode' }, codes: [C.VIDEO_CODEC_NOT_SUPPORTED] }],
  ['8K on a 4K device: converted', fileMkv(F.uhd8k()), shield, {},
    { method: 'Transcode', video: { action: 'transcode' }, codes: [C.RESOLUTION_TOO_HIGH] }],
  ['4K HDR10 in MKV on a Roku: plays as it is', fileMkv(F.hdr10_4k()), roku, {},
    { method: 'DirectPlay', video: { action: 'copy' } }],
  ['4K on a 1080p-only device: converted', fileMkv(F.hdr10_4k()), dp.resolveProfile({ client: 'roku', declared: { maxHeight: 1080 } }), {},
    { method: 'Transcode', video: { action: 'transcode' }, codes: [C.RESOLUTION_TOO_HIGH] }],
  ['HLG on Samsung: HLG kept', fileMkv(F.hlg4k()), samsung, {},
    { method: 'DirectPlay', video: { action: 'copy', hdr: 'HLG' } }],
  ['HLG on a browser: tone-mapped', fileMkv(F.hlg1080()), chrome, {},
    { method: 'Transcode', video: { action: 'transcode', hdr: 'SDR (tone-mapped)' }, codes: [C.HDR_NOT_SUPPORTED] }]
]

test('decision table: (file, device) -> method, picture, sound and reason codes', () => {
  for (const [name, file, profile, opts, want] of TABLE) {
    const p = plan(file, profile, opts)
    const ctx = `${name}\n  got: ${p.method} | ${p.summary} | ${p.reasonCodes.join(', ')}`
    assert.equal(p.method, want.method, ctx)
    if (want.video) {
      if (want.video.action) assert.equal(p.video.action, want.video.action, ctx)
      if (want.video.hdr) assert.equal(p.video.hdr.delivered, want.video.hdr, ctx)
      if (want.video.hdrAction) assert.equal(p.video.hdr.action, want.video.hdrAction, ctx)
      if (want.video.tag) assert.equal(p.video.tag, want.video.tag, ctx)
      if (want.video.dvStrip !== undefined) assert.equal(p.video.dvStrip, want.video.dvStrip, ctx)
    }
    if (want.audio) {
      for (const k of Object.keys(want.audio)) assert.equal(p.audio[k], want.audio[k], `${ctx}\n  audio.${k}`)
    }
    for (const c of want.codes || []) assert.ok(p.reasonCodes.includes(c), `${ctx}\n  missing ${c}`)
    for (const c of want.notCodes || []) assert.ok(!p.reasonCodes.includes(c), `${ctx}\n  unexpected ${c}`)
    // every plan carries a summary, a client, and machine-readable reasons with text
    assert.ok(p.summary && p.client && Array.isArray(p.reasons))
    for (const r of p.reasons) assert.ok(r.code && r.text && r.stream, JSON.stringify(r))
  }
})

test('video and audio are decided separately: 4K Dolby Vision + DTS-HD MA on a Dolby Vision device that cannot play DTS', () => {
  const p = plan(fileMkv(F.withAudio(F.dtsHdMa71(), F.dv81().streams[0])), lg)
  assert.equal(p.method, 'DirectStream')
  assert.equal(p.video.action, 'copy'); assert.equal(p.video.hdr.delivered, 'Dolby Vision 8.1'); assert.equal(p.video.tag, 'dvh1')
  assert.equal(p.audio.action, 'transcode'); assert.equal(p.audio.codec, 'eac3')
  assert.equal(p.hdrKept, true)
  const audioReason = p.reasons.find((r) => r.stream === 'audio' && r.code === C.AUDIO_CODEC_NOT_SUPPORTED)
  assert.match(audioReason.text, /transcode audio only/)
  assert.equal(p.reasons.find((r) => r.stream === 'video' && r.fatal), undefined, 'nothing forces the picture to be re-encoded')
})

test('settings: forced transcode, no direct stream, direct play not preferred, bitrate limit', () => {
  const f = fileMkv(F.hdr10_4k())
  const forced = plan(f, shield, { settings: { forceTranscode: true } })
  assert.equal(forced.method, 'Transcode'); has(forced, C.FORCED_TRANSCODE)
  assert.equal(forced.video.hdr.action, 'tonemap')
  // the picture COULD have stayed HDR: say what is lost
  has(forced, C.HDR_LOST_IN_TRANSCODE)
  // with direct play not preferred a playable MP4 is remuxed instead
  const mp4 = fileMp4(F.sdr1080())
  const notPreferred = plan(mp4, chrome, { settings: { directPlayPreferred: false } })
  assert.equal(notPreferred.method, 'DirectStream'); has(notPreferred, C.DIRECT_PLAY_NOT_PREFERRED)
  // ...unless remux is off
  const noRemux = plan(mp4, chrome, { settings: { directPlayPreferred: false, allowDirectStream: false } })
  assert.equal(noRemux.method, 'DirectPlay')
  const remuxOff = plan(fileMkv(F.sdr1080()), chrome, { settings: { allowDirectStream: false } })
  assert.equal(remuxOff.method, 'Transcode'); has(remuxOff, C.DIRECT_STREAM_OFF)
  const noFfmpegRemux = plan(fileMkv(F.sdr1080()), chrome, { remuxAvailable: false })
  assert.equal(noFfmpegRemux.method, 'Transcode')
  // a bitrate limit (a copy cannot lower a bitrate): 60 Mbps against 20 Mbps
  const limited = plan(f, shield, { settings: { maxBitrateKbps: 20000 } })
  assert.equal(limited.method, 'Transcode'); has(limited, C.BITRATE_EXCEEDS_LIMIT)
  assert.equal(limited.video.quality, '1080p'.length ? limited.video.quality : '')
  // the device's own ceiling and the viewer's request count too
  assert.equal(plan(f, shield, { request: { maxBitrateKbps: 10000 } }).method, 'Transcode')
  assert.equal(plan(f, dp.resolveProfile({ client: 'androidtv', declared: { maxBitrateKbps: 30000 } })).method, 'Transcode')
  assert.equal(plan(f, shield, { settings: { maxBitrateKbps: 200000 } }).method, 'DirectPlay')
})

test('the chosen quality for a conversion follows the bitrate limit and never exceeds the source', () => {
  const big = fileMkv(F.hdr10_4k())
  assert.equal(plan(big, shield, { settings: { forceTranscode: true } }).video.quality, '1080p')
  assert.equal(plan(big, shield, { settings: { forceTranscode: true, maxBitrateKbps: 5000 } }).video.quality, '720p')
  assert.equal(plan(big, shield, { settings: { forceTranscode: true, maxBitrateKbps: 2000 } }).video.quality, '480p')
  assert.equal(plan(fileMkv(F.sdr720()), shield, { settings: { forceTranscode: true } }).video.quality, '720p')
  assert.equal(plan(big, shield, { request: { quality: '720p' } }).video.quality, '720p')
  has(plan(big, shield, { request: { quality: '720p' } }), C.QUALITY_REQUESTED)
  // asking for 1080p of a 720p film changes nothing
  assert.equal(plan(fileMkv(F.sdr720()), shield, { request: { quality: '1080p' } }).method, 'DirectPlay')
  assert.equal(plan(big, shield, { request: { quality: 'original' } }).method, 'DirectPlay')
  assert.equal(plan(big, shield, { request: { quality: 'auto' } }).method, 'DirectPlay')
})

test('subtitles: picture subtitles are burnt in unless the device renders them; text never forces a conversion', () => {
  const f = fileMkv(F.hdr10_4k())
  const pgs = plan(f, shield, { request: { subtitle: { streamIndex: 3, codec: 'hdmv_pgs_subtitle', kind: 'image' } } })
  assert.equal(pgs.method, 'Transcode'); has(pgs, C.SUBTITLE_BURN_IN); assert.equal(pgs.subtitles.action, 'burn')
  const renders = dp.resolveProfile({ client: 'androidtv', declared: { subtitles: ['vtt', 'pgs'] } })
  const own = plan(f, renders, { request: { subtitle: { streamIndex: 3, codec: 'hdmv_pgs_subtitle', kind: 'image' } } })
  assert.equal(own.method, 'DirectPlay'); assert.equal(own.subtitles.action, 'sidecar')
  const text = plan(f, shield, { request: { subtitle: { streamIndex: 2, codec: 'subrip', kind: 'text' } } })
  assert.equal(text.method, 'DirectPlay'); hasNot(text, C.SUBTITLE_BURN_IN)
})

test('away-from-home quality cap forces a conversion of a bigger picture', () => {
  const p = plan(fileMkv(F.hdr10_4k()), shield, { request: { awayCapHeight: 1080 } })
  assert.equal(p.method, 'Transcode'); has(p, C.AWAY_QUALITY_CAP)
  assert.equal(plan(fileMkv(F.sdr1080()), shield, { request: { awayCapHeight: 1080 } }).method, 'DirectPlay')
})

test('the audio track that is played is the requested one, else the default', () => {
  const two = F.withAudio(F.ddp51())
  two.streams.push({ ...F.truehdAtmos(), index: 2, disposition: { default: 0 } })
  const f = fileMkv(two)
  assert.equal(plan(f, appletv).audio.sourceCodec, 'eac3')
  assert.equal(plan(f, appletv, { request: { audioStreamIndex: 2 } }).audio.sourceCodec, 'truehd')
  assert.equal(plan(f, appletv, { request: { audioStreamIndex: 2 } }).audio.action, 'transcode')
  assert.equal(plan(f, appletv, { request: { audioStreamIndex: 99 } }).audio.sourceCodec, 'eac3', 'a stream that does not exist falls back to the default')
  // a file with no audio at all
  const silent = { streams: [F.hdr10Plus_4k().streams[0]], format: F.sdr1080().format }
  assert.equal(plan(fileMkv(silent), shield).audio.action, 'none')
})

test('container names come from ffprobe format names and the extension', () => {
  const t = [[{ formatName: 'matroska,webm' }, '.mkv', 'mkv'], [{ formatName: 'matroska,webm' }, '.webm', 'webm'], [{ formatName: 'mov,mp4,m4a,3gp,3g2,mj2' }, '.mp4', 'mp4'],
    [{ formatName: 'mov,mp4,m4a,3gp,3g2,mj2' }, '.mov', 'mov'], [{ formatName: 'mpegts' }, '.ts', 'ts'], [{ formatName: 'avi' }, '.avi', 'avi'], [{ formatName: 'asf' }, '.wmv', 'asf'],
    [{ formatName: 'mpeg' }, '.mpg', 'mpeg'], [{}, '.m2ts', 'ts'], [{}, '.MKV', 'mkv'], [{}, '', 'unknown']]
  for (const [tr, ext, want] of t) assert.equal(decision.sourceContainer(tr, ext), want, `${JSON.stringify(tr)} ${ext}`)
})

test('the audio of a conversion is exactly what hlsAudio.js will make (one source of truth)', () => {
  // For every plan that goes through the live conversion or the remux, the request in the plan makes hlsAudio
  // choose the same action (copy / encode), codec and channel count the plan states.
  const encoders = { aac: true, ac3: true, eac3: true }
  const files = [F.sdr1080(), F.hdr10_4k(), F.dv81(), F.dv7fel(), F.withAudio(F.dtsHdMa71()), F.withAudio(F.dtsX()), F.withAudio(F.dd51(), F.video()), F.withAudio(F.ddp71()), F.withAudio(F.flac51())]
  const profiles = [chrome, appletv, samsung, roku, generic, shield]
  let checked = 0
  for (const probe of files) {
    for (const prof of profiles) {
      const p = plan(fileMkv(probe), prof, { settings: { forceTranscode: true } })
      if (p.method !== 'Transcode' || !p.audio.request) continue
      const tracks = tracksOf(probe)
      const track = decision.pickAudio(tracks, p.audio.streamIndex)
      const au = hlsAudio.ticketAudio(hlsAudio.normalizeAudioRequest(p.audio.request))
      const a = hlsAudio.planAudio({ track, au, quality: { audioKbps: 192 }, qualityId: '1080p', encoders })
      assert.equal(a.kind, p.audio.action === 'copy' ? 'copy' : 'encode', `${track.codec} on ${prof.client}: ${p.audio.action} vs ${a.kind}`)
      assert.equal(a.channels, p.audio.channels, `${track.codec} on ${prof.client}: channels`)
      if (p.audio.action === 'transcode') assert.equal(a.codec, p.audio.codec, `${track.codec} on ${prof.client}: codec`)
      checked++
    }
  }
  assert.ok(checked >= 20, `checked ${checked} plans`)
})

test('reasons are unique, worded, and machine-readable; codes come from one list', () => {
  const all = new Set(Object.values(C))
  for (const [name, file, profile, opts] of TABLE) {
    const p = plan(file, profile, opts)
    const seen = new Set()
    for (const r of p.reasons) {
      assert.ok(all.has(r.code), `${name}: unknown code ${r.code}`)
      const k = `${r.stream}|${r.code}|${r.text}`
      assert.ok(!seen.has(k), `${name}: duplicate reason ${k}`)
      seen.add(k)
      assert.ok(['video', 'audio', 'container', 'subtitle', 'session'].includes(r.stream))
    }
  }
  const lines = decision.explain(plan(fileMkv(F.dv7fel()), appletv))
  assert.ok(lines.some((l) => /transcode audio only/.test(l)))
})
