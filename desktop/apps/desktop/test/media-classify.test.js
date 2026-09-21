// Precise file classification (mediaClassify.js) from hand-written ffprobe JSON: resolution class,
// HDR type (SDR / HDR10 / HDR10+ / HLG / Dolby Vision profile + compatibility id), bit depth,
// audio family (Dolby Digital, Dolby Digital Plus, TrueHD, DTS, DTS-HD MA, Atmos, DTS:X), channel
// layouts, badges, and the Jellyfin vocabulary (VideoRangeType, AudioSpatialFormat).
// Run: node --test test/media-classify.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { createRequire } = require('node:module')
const localRequire = createRequire(path.join(path.resolve(__dirname, '..'), 'package.json'))
const cls = localRequire('./electron/mediaClassify')
const F = require('./helpers/ffprobeFixtures')

const video = (probe, opts) => cls.classifyProbe(probe, opts).video
const audio0 = (a) => cls.classifyAudioStream(a)

test('resolution classes come from the picture size, scope films included', () => {
  const table = [
    [[3840, 2160], '4K'], [[4096, 2160], '4K'], [[3840, 1600], '4K'], [[7680, 4320], '8K'],
    [[2560, 1440], '1440p'], [[1920, 1080], '1080p'], [[1920, 800], '1080p'], [[1280, 720], '720p'],
    [[1024, 576], '576p'], [[720, 480], '480p'], [[320, 240], 'SD'], [[0, 0], null]
  ]
  for (const [[w, h], want] of table) assert.equal(cls.resolutionClass(w, h), want, `${w}x${h}`)
})

test('HDR classification table: SDR / HDR10 / HDR10+ / HLG / Dolby Vision profiles', () => {
  // [fixture, hdrType, hdrFormats, fallbackHdrType, badges of the picture]
  const table = [
    ['sdr1080', 'SDR', [], 'SDR', ['1080p']],
    ['scope1080', 'SDR', [], 'SDR', ['1080p']],
    ['uhd4kSdr', 'SDR', [], 'SDR', ['4K']],
    ['hdr10_4k', 'HDR10', ['HDR10'], 'HDR10', ['4K', 'HDR10']],
    ['hdr10Plus_4k', 'HDR10+', ['HDR10+', 'HDR10'], 'HDR10+', ['4K', 'HDR10+', 'HDR10']],
    ['hlg4k', 'HLG', ['HLG'], 'HLG', ['4K', 'HLG']],
    ['hlg1080', 'HLG', ['HLG'], 'HLG', ['1080p', 'HLG']],
    ['dv5', 'Dolby Vision', ['Dolby Vision'], 'none', ['4K', 'Dolby Vision']],
    ['dv81', 'Dolby Vision', ['Dolby Vision', 'HDR10'], 'HDR10', ['4K', 'Dolby Vision', 'HDR10']],
    ['dv84', 'Dolby Vision', ['Dolby Vision', 'HLG'], 'HLG', ['4K', 'Dolby Vision', 'HLG']],
    ['dv82', 'Dolby Vision', ['Dolby Vision'], 'SDR', ['1080p', 'Dolby Vision']],
    ['dv7fel', 'Dolby Vision', ['Dolby Vision', 'HDR10'], 'HDR10', ['4K', 'Dolby Vision', 'HDR10']],
    ['dv81Plus', 'Dolby Vision', ['Dolby Vision', 'HDR10+', 'HDR10'], 'HDR10+', ['4K', 'Dolby Vision', 'HDR10+', 'HDR10']],
    ['av1Hdr', 'HDR10', ['HDR10'], 'HDR10', ['4K', 'HDR10']],
    ['uhd8k', 'HDR10', ['HDR10'], 'HDR10', ['8K', 'HDR10']]
  ]
  for (const [name, type, formats, fallback, badges] of table) {
    const v = video(F[name]())
    assert.equal(v.hdrType, type, `${name} hdrType`)
    assert.deepEqual(v.hdrFormats, formats, `${name} formats`)
    assert.equal(v.fallbackHdrType, fallback, `${name} fallback`)
    assert.deepEqual(v.badges, badges, `${name} badges`)
    assert.equal(v.hdr, type !== 'SDR', `${name} hdr flag`)
  }
})

test('Dolby Vision details: profile label, compatibility id, layers', () => {
  const p5 = video(F.dv5()).dolbyVision
  assert.equal(p5.profile, 5); assert.equal(p5.label, '5'); assert.equal(p5.baseLooksLike, 'None'); assert.equal(p5.elPresent, false)
  const p81 = video(F.dv81()).dolbyVision
  assert.equal(p81.label, '8.1'); assert.equal(p81.compatId, 1); assert.equal(p81.baseLooksLike, 'HDR10'); assert.equal(p81.level, 6)
  const p84 = video(F.dv84()).dolbyVision
  assert.equal(p84.label, '8.4'); assert.equal(p84.baseLooksLike, 'HLG')
  const p82 = video(F.dv82()).dolbyVision
  assert.equal(p82.label, '8.2'); assert.equal(p82.baseLooksLike, 'SDR')
  const p7 = video(F.dv7fel()).dolbyVision
  assert.equal(p7.profile, 7); assert.equal(p7.elPresent, true); assert.equal(p7.label, '7 (dual layer)'); assert.equal(p7.baseLooksLike, 'HDR10')
  // the container field says PQ for profile 5, but the picture is not an HDR10 picture
  assert.equal(video(F.dv5()).hdrBase, 'DV-only')
  // a tag with no configuration record is still Dolby Vision, flagged so
  const tagOnly = video(F.dvTagOnly()).dolbyVision
  assert.ok(tagOnly); assert.equal(tagOnly.fromTagOnly, true); assert.equal(tagOnly.profile, null)
  assert.equal(video(F.hdr10_4k()).dolbyVision, null)
})

test('HDR10+ can be seen on the stream or only on the first frames (second ffprobe call)', () => {
  assert.equal(video(F.hdr10_4k_plusInFrames()).hdrType, 'HDR10', 'without the frame probe it is plain HDR10')
  const found = cls.parseFrameSideData({ frames: [{ side_data_list: [{ side_data_type: 'Mastering display metadata' }, { side_data_type: 'HDR Dynamic Metadata SMPTE2094-40 (HDR10+)' }] }, { side_data_list: [{ side_data_type: 'Mastering display metadata' }] }] })
  assert.deepEqual(found, ['Mastering display metadata', 'HDR Dynamic Metadata SMPTE2094-40 (HDR10+)'])
  const v = video(F.hdr10_4k_plusInFrames(), { frameSideData: found })
  assert.equal(v.hdrType, 'HDR10+'); assert.equal(v.hdr10Plus, true)
  // which files are worth the extra call
  assert.equal(cls.wantsFrameProbe(F.hdr10_4k().streams[0]), true)
  assert.equal(cls.wantsFrameProbe(F.sdr1080().streams[0]), false)
  assert.equal(cls.wantsFrameProbe(F.hlg4k().streams[0]), false, 'HLG has no HDR10+')
  assert.equal(cls.wantsFrameProbe(F.h264_10bit().streams[0]), false)
  assert.equal(cls.wantsFrameProbe(null), false)
  assert.ok(cls.FRAME_PROBE_ARGS.includes('-show_frames'))
})

test('bit depth, chroma, primaries, transfer', () => {
  const v = video(F.hdr10_4k())
  assert.equal(v.bitDepth, 10); assert.equal(v.chroma, '4:2:0')
  assert.equal(v.colorPrimaries, 'bt2020'); assert.equal(v.colorTransfer, 'smpte2084'); assert.equal(v.colorSpace, 'bt2020nc')
  assert.equal(video(F.sdr1080()).bitDepth, 8)
  assert.equal(video(F.h264_10bit()).bitDepth, 10)
  assert.equal(cls.bitDepthOf({ pix_fmt: 'yuv420p12le' }), 12)
  assert.equal(cls.bitDepthOf({ pix_fmt: 'p010le' }), 10)
  assert.equal(cls.bitDepthOf({ pix_fmt: 'nv12' }), 8)
  assert.equal(cls.bitDepthOf({ pix_fmt: 'yuv444p10le' }), 10)
  assert.equal(cls.bitDepthOf({}), null)
  assert.equal(cls.chromaOf('yuv444p10le'), '4:4:4'); assert.equal(cls.chromaOf('yuv422p'), '4:2:2')
  // a 10-bit SDR file gets a 10-bit badge (it matters to a TV that cannot decode it)
  assert.deepEqual(video(F.h264_10bit()).badges, ['1080p', '10-bit'])
  assert.equal(video(F.mpeg2Dvd()).interlaced, true)
  assert.equal(video(F.sdr1080()).interlaced, false)
})

test('audio classification table: family, name, lossless, object audio, layout', () => {
  // [fixture, family, name, lossless, objectAudio, layout, spatialFormat, badges]
  const table = [
    ['aacStereo', 'aac', 'AAC', false, null, 'Stereo', 'None', []],
    ['dd51', 'dd', 'Dolby Digital', false, null, '5.1', 'None', []],
    ['ddp51', 'ddp', 'Dolby Digital Plus', false, null, '5.1', 'None', []],
    ['ddp71', 'ddp', 'Dolby Digital Plus', false, null, '7.1', 'None', []],
    ['ddpAtmos', 'ddp', 'Dolby Digital Plus + Dolby Atmos', false, 'atmos', '5.1', 'DolbyAtmos', ['Atmos']],
    ['truehd51', 'truehd', 'Dolby TrueHD', true, null, '5.1', 'None', ['Dolby TrueHD']],
    ['truehd71', 'truehd', 'Dolby TrueHD', true, null, '7.1', 'None', ['Dolby TrueHD']],
    ['truehdAtmos', 'truehd', 'Dolby TrueHD + Dolby Atmos', true, 'atmos', '7.1', 'DolbyAtmos', ['Atmos']],
    ['dtsCore', 'dts', 'DTS', false, null, '5.1', 'None', []],
    ['dtsEs', 'dts', 'DTS-ES', false, null, '6.1', 'None', []],
    ['dtsHra', 'dtshd', 'DTS-HD High Resolution', false, null, '7.1', 'None', ['DTS-HD HRA']],
    ['dtsHdMa51', 'dtshd', 'DTS-HD Master Audio', true, null, '5.1', 'None', ['DTS-HD MA']],
    ['dtsHdMa71', 'dtshd', 'DTS-HD Master Audio', true, null, '7.1', 'None', ['DTS-HD MA']],
    ['dtsX', 'dtshd', 'DTS:X', true, 'dtsx', '7.1', 'DTSX', ['DTS:X']],
    ['flac51', 'flac', 'FLAC', true, null, '5.1', 'None', []]
  ]
  for (const [name, family, label, lossless, objects, layout, spatial, badges] of table) {
    const a = audio0(F[name]())
    assert.equal(a.family, family, `${name} family`)
    assert.equal(a.name, label, `${name} name`)
    assert.equal(a.lossless, lossless, `${name} lossless`)
    assert.equal(a.objectAudio, objects, `${name} object audio`)
    assert.equal(a.layout, layout, `${name} layout`)
    assert.equal(a.spatialFormat, spatial, `${name} spatial`)
    assert.deepEqual(a.badges, badges, `${name} badges`)
    assert.equal(a.inferred, false, `${name} not inferred`)
    assert.equal(cls.jellyfinAudioSpatialFormat(a), spatial)
  }
  assert.equal(cls.describeAudio(audio0(F.truehdAtmos())), 'Dolby TrueHD + Dolby Atmos 7.1')
})

test('Atmos from the track title only (old ffmpeg) is marked inferred, and only for Dolby codecs', () => {
  const a = audio0(F.ddpAtmosTitleOnly())
  assert.equal(a.objectAudio, 'atmos'); assert.equal(a.inferred, true)
  const dts = audio0(F.audio({ codec_name: 'dts', profile: 'DTS-HD MA', channels: 8, channel_layout: '7.1', tags: { title: 'DTS:X 7.1' } }))
  assert.equal(dts.objectAudio, 'dtsx'); assert.equal(dts.inferred, true)
  // A stereo AAC track with "Atmos" in the title is not Atmos
  const aac = audio0(F.audio({ tags: { title: 'Atmos mix (stereo fold)' } }))
  assert.equal(aac.objectAudio, null)
  // Plain Dolby Digital Plus with an unrelated title stays plain
  assert.equal(audio0(F.audio({ codec_name: 'eac3', profile: '', channels: 6, channel_layout: '5.1(side)', tags: { title: 'English 5.1' } })).objectAudio, null)
})

test('channel layout labels', () => {
  const t = [[2, 'stereo', 'Stereo'], [1, 'mono', 'Mono'], [6, '5.1(side)', '5.1'], [6, '5.1', '5.1'], [8, '7.1', '7.1'], [8, '', '7.1'], [6, '', '5.1'], [12, '7.1.4', '7.1.4'], [10, '5.1.4', '5.1.4'], [7, '6.1', '6.1'], [3, '', '2.1'], [9, '', '9ch']]
  for (const [ch, layout, want] of t) assert.equal(cls.layoutLabel(ch, layout), want, `${ch} ${layout}`)
})

test('file badges: the short labels every screen shows', () => {
  const b = (probe, opts) => cls.classifyProbe(probe, opts).badges
  assert.deepEqual(b(F.sdr1080()), ['1080p'])
  assert.deepEqual(b(F.hdr10_4k()), ['4K', 'HDR10', '5.1'])
  // UHD Blu-ray remux: Dolby Vision profile 7 + TrueHD Atmos 7.1
  assert.deepEqual(b(F.dv7fel()), ['4K', 'Dolby Vision', 'HDR10', 'Atmos', '7.1'])
  // Streaming rip: Dolby Vision 8.1 + Dolby Digital Plus Atmos
  assert.deepEqual(b(F.dv81()), ['4K', 'Dolby Vision', 'HDR10', 'Atmos', '5.1'])
  // A file with two audio tracks: Atmos and DTS:X both show, the default track sets the layout badge
  const two = F.withAudio(F.ddpAtmos(), F.hdr10Plus_4k().streams[0])
  two.streams.push({ ...F.dtsX(), index: 2, disposition: { default: 0 } })
  assert.deepEqual(b(two), ['4K', 'HDR10+', 'HDR10', 'Atmos', 'DTS:X', '5.1'])
  // HDR10+ found on the frames adds the badge
  assert.deepEqual(b(F.hdr10_4k_plusInFrames(), { frameSideData: ['HDR Dynamic Metadata SMPTE2094-40 (HDR10+)'] }), ['4K', 'HDR10+', 'HDR10', '5.1'])
  // DTS-HD MA 7.1 on 1080p SDR
  assert.deepEqual(b(F.withAudio(F.dtsHdMa71(), F.video())), ['1080p', 'DTS-HD MA', '7.1'])
  // an audio-only or garbage probe never throws
  assert.equal(cls.classifyProbe(null), null)
  assert.deepEqual(cls.classifyProbe({ streams: [] }).badges, [])
  assert.equal(cls.classifyProbe({ streams: [F.audio()] }).video, null)
})

test('Jellyfin vocabulary: VideoRangeType', () => {
  const t = [
    ['sdr1080', 'SDR'], ['hdr10_4k', 'HDR10'], ['hdr10Plus_4k', 'HDR10Plus'], ['hlg4k', 'HLG'], ['dv5', 'DOVI'], ['dv81', 'DOVIWithHDR10'],
    ['dv84', 'DOVIWithHLG'], ['dv82', 'DOVIWithSDR'], ['dv7fel', 'DOVIWithEL'], ['dv81Plus', 'DOVIWithHDR10Plus']
  ]
  for (const [name, want] of t) assert.equal(cls.jellyfinVideoRangeType(video(F[name]())), want, name)
  assert.equal(cls.jellyfinVideoRangeType(null), 'Unknown')
})

test('the extended ffprobe argument lists ask for what the classifier reads', () => {
  const tracks = localRequire('./electron/playbackTracks')
  const li = localRequire('./electron/libraryInfo')
  for (const key of ['color_primaries', 'color_space', 'color_transfer', 'bits_per_raw_sample', 'codec_tag_string', 'level', 'profile']) {
    assert.match(tracks.PROBE_ARGS.join(' '), new RegExp(key), `playbackTracks asks for ${key}`)
    assert.match(li.PROBE_ARGS.join(' '), new RegExp(key), `libraryInfo asks for ${key}`)
  }
  assert.match(tracks.PROBE_ARGS.join(' '), /stream_side_data/)
  assert.match(li.PROBE_ARGS.join(' '), /stream_side_data/)
})
