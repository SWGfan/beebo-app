// What the details page shows and offers for one file (electron/mediaInfo.js):
// the "1080p (HEVC Main 10)" line, the audio and subtitle pickers built from
// ffprobe JSON, and the ffprobe call itself (argument array, never a shell).
// ffprobe is faked; nothing here needs the real one.
// Run: node --test test/media-info.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const mediaInfo = require('../electron/mediaInfo')

const video = (extra = {}) => ({ index: 0, codec_type: 'video', codec_name: 'hevc', profile: 'Main 10', width: 1920, height: 1080, avg_frame_rate: '24000/1001', ...extra })
const audio = (index, codec, channels, lang, extra = {}) => ({
  index, codec_type: 'audio', codec_name: codec, channels, tags: lang ? { language: lang } : {}, disposition: {}, ...extra
})
const sub = (index, codec, lang, extra = {}) => ({
  index, codec_type: 'subtitle', codec_name: codec, tags: lang ? { language: lang } : {}, disposition: {}, ...extra
})
const probeJson = (streams, format = { duration: '5400.5', format_name: 'matroska,webm' }) => ({ streams, format })

const RICH = probeJson([
  video(),
  audio(1, 'dts', 8, 'eng', { profile: 'DTS-HD MA', disposition: { default: 1 } }),
  audio(2, 'ac3', 6, 'jpn'),
  audio(3, 'aac', 2, 'und', { tags: { title: "Director's Commentary" }, disposition: { comment: 1 } }),
  audio(4, 'aac', 2, 'xx-unknown'),
  sub(5, 'subrip', 'eng', { disposition: { default: 1 } }),
  sub(6, 'subrip', 'eng', { disposition: { forced: 1 } }),
  sub(7, 'hdmv_pgs_subtitle', 'fre'),
  sub(8, 'mov_text', 'spa', { tags: { language: 'spa', title: 'SDH' }, disposition: { hearing_impaired: 1 } }),
  sub(9, 'dvb_teletext', 'eng')
])

test('resolutionLabel: tiers by picture lines, scope crops judged by width', () => {
  const { resolutionLabel } = mediaInfo
  assert.equal(resolutionLabel(3840, 2160), '4K')
  assert.equal(resolutionLabel(1920, 1080), '1080p')
  assert.equal(resolutionLabel(1920, 800), '1080p', 'a 2.40:1 crop is still 1080p')
  assert.equal(resolutionLabel(1280, 720), '720p')
  assert.equal(resolutionLabel(1280, 536), '720p')
  assert.equal(resolutionLabel(720, 576), '576p')
  assert.equal(resolutionLabel(854, 480), '480p')
  assert.equal(resolutionLabel(320, 240), '240p')
  assert.equal(resolutionLabel(0, 0), null)
  assert.equal(resolutionLabel(undefined, undefined), null)
})

test('videoCodecLabel: friendly names, profile appended, unknown codecs kept', () => {
  const { videoCodecLabel } = mediaInfo
  assert.equal(videoCodecLabel('hevc', 'Main 10'), 'HEVC Main 10')
  assert.equal(videoCodecLabel('h264', 'High'), 'H.264 High')
  assert.equal(videoCodecLabel('av1'), 'AV1')
  assert.equal(videoCodecLabel('mpeg2video', 'Main'), 'MPEG-2 Main')
  assert.equal(videoCodecLabel('weirdcodec'), 'WEIRDCODEC')
  assert.equal(videoCodecLabel('hevc', 'unknown'), 'HEVC')
  assert.equal(videoCodecLabel(''), '')
})

test('describeProbe: the video line reads "1080p (HEVC Main 10)"', () => {
  const d = mediaInfo.describeProbe(RICH)
  assert.equal(d.video.label, '1080p (HEVC Main 10)')
  assert.equal(d.video.resolution, '1080p')
  assert.equal(d.durationSec, 5400.5)
})

test('describeProbe: HDR is named, and a missing size still gives the codec', () => {
  const hdr = mediaInfo.describeProbe(probeJson([video({ width: 3840, height: 2160, color_transfer: 'smpte2084' })]))
  assert.equal(hdr.video.label, '4K (HEVC Main 10, HDR10)')
  assert.equal(hdr.video.hdrType, 'HDR10'); assert.deepEqual(hdr.badges, ['4K', 'HDR10'])
  const noSize = mediaInfo.describeProbe(probeJson([video({ width: undefined, height: undefined })]))
  assert.equal(noSize.video.label, 'HEVC Main 10')
  assert.equal(mediaInfo.describeProbe(probeJson([audio(0, 'aac', 2, 'eng')])).video, null)
})

test('audio picker: language + codec + channels, DTS-HD by profile, unknown language kept honest', () => {
  const d = mediaInfo.describeProbe(RICH)
  assert.deepEqual(d.audio.map((a) => a.label), [
    'English (DTS-HD MA 7.1)',
    'Japanese (Dolby Digital 5.1)',
    "Unknown language (AAC Stereo) · Director's Commentary",
    'XX-UNKNOWN (AAC Stereo)'
  ])
  assert.deepEqual(d.audio.map((a) => a.streamIndex), [1, 2, 3, 4], 'stream indexes are the ones the player takes')
  assert.deepEqual(d.audio.map((a) => a.isDefault), [true, false, false, false])
  assert.deepEqual(d.audio.map((a) => a.ordinal), [0, 1, 2, 3])
})

test('audio picker: the example wording "English (DTS 5.1)"', () => {
  const d = mediaInfo.describeProbe(probeJson([video(), audio(1, 'dts', 6, 'eng', { profile: 'DTS' })]))
  assert.equal(d.audio[0].label, 'English (DTS 5.1)')
})

test('audio picker: a title that only repeats the codec is not added', () => {
  const d = mediaInfo.describeProbe(probeJson([video(), audio(1, 'ac3', 6, 'eng', { tags: { language: 'eng', title: 'AC3 5.1' } })]))
  assert.equal(d.audio[0].label, 'English (Dolby Digital 5.1)')
})

test('subtitle picker: text and picture tracks, forced and SDH flagged, teletext left out', () => {
  const d = mediaInfo.describeProbe(RICH)
  assert.deepEqual(d.subtitles.map((s) => s.key), ['emb:5', 'emb:6', 'emb:7', 'emb:8'])
  assert.equal(d.subtitles[0].label, 'English · SRT')
  assert.equal(d.subtitles[1].label, 'English (Forced) · SRT')
  assert.equal(d.subtitles[1].forced, true)
  assert.equal(d.subtitles[2].label, 'French · picture')
  assert.equal(d.subtitles[2].kind, 'image')
  assert.equal(d.subtitles[3].label, 'Spanish (SDH) · MP4 text')
  assert.equal(d.subtitles[3].hearingImpaired, true)
  assert.ok(d.subtitles.every((s) => s.source === 'embedded'))
})

test('a file with no subtitles and one audio track', () => {
  const d = mediaInfo.describeProbe(probeJson([video(), audio(1, 'aac', 2, 'eng')]))
  assert.deepEqual(d.subtitles, [])
  assert.equal(d.audio.length, 1)
})

test('a file with no audio at all', () => {
  const d = mediaInfo.describeProbe(probeJson([video()]))
  assert.deepEqual(d.audio, [])
})

test('unusable probe output -> null', () => {
  assert.equal(mediaInfo.describeProbe(null), null)
  assert.equal(mediaInfo.describeProbe('nope'), null)
  const empty = mediaInfo.describeProbe({})
  assert.deepEqual(empty.audio, [])
  assert.equal(empty.video, null)
})

test('two-letter and three-letter language tags name the same language', () => {
  const d = mediaInfo.describeProbe(probeJson([video(), audio(1, 'aac', 2, 'en'), audio(2, 'aac', 2, 'fra'), audio(3, 'aac', 2, 'de-AT')]))
  assert.deepEqual(d.audio.map((a) => a.languageName), ['English', 'French', 'German'])
})

// ---- files beside the video ----------------------------------------------------------------------
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-mediainfo-'))
}
const touch = (dir, name, body = 'x') => { const p = path.join(dir, name); fs.writeFileSync(p, body); return p }

test('subtitle files next to the video become picker entries with a language', () => {
  const dir = tmpDir()
  try {
    const movie = touch(dir, 'Film (2010).mkv')
    touch(dir, 'Film (2010).en.srt')
    touch(dir, 'Film (2010).en.forced.srt')
    touch(dir, 'Film (2010).fr.vtt')
    touch(dir, 'Film (2010).srt')
    touch(dir, 'Other Film.en.srt')
    touch(dir, 'Film (2010).nfo')
    const found = mediaInfo.findSidecarSubtitles(movie)
    const byKey = Object.fromEntries(found.map((s) => [s.key, s]))
    assert.deepEqual(Object.keys(byKey).sort(), ['side:#0', 'side:en#0', 'side:en#1', 'side:fr#0'])
    assert.equal(byKey['side:fr#0'].label, 'French · file')
    const forced = found.find((s) => s.forced)
    assert.equal(forced.language, 'en')
    assert.equal(forced.label, 'English (Forced) · file')
    assert.equal(found.filter((s) => s.language === 'en' && !s.forced).length, 1)
    assert.equal(byKey['side:#0'].label, 'Subtitles · file')
    assert.ok(found.every((s) => s.source === 'file' && s.kind === 'text'))
    assert.equal(found[0].key, 'side:fr#0', 'the player lists .vtt files first')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a folder that cannot be read has no subtitle files', () => {
  assert.deepEqual(mediaInfo.findSidecarSubtitles(path.join(os.tmpdir(), 'no-such-dir-beebo', 'a.mkv')), [])
})

// ---- the ffprobe call -------------------------------------------------------------------------------
function fakeExec(json, calls) {
  return (exe, args, opts, cb) => {
    calls.push({ exe, args, opts })
    setImmediate(() => cb(null, JSON.stringify(json)))
  }
}

test('ffprobe gets the path as ONE argument, with no shell, whatever the path contains', async () => {
  const dir = tmpDir()
  try {
    const names = [
      "A Film's Name (2010) & more.mkv",
      'semi;colon $(touch pwned) `id` %PATH% ^caret.mkv',
      'spaces   in   name.mp4',
      'quote\'s.mkv',
      '$HOME.mkv',
      '"; echo hi;.mkv'.replace(/"/g, '')
    ]
    for (const name of names) {
      const file = touch(dir, name)
      const calls = []
      const mi = mediaInfo.createMediaInfo({ ffprobePath: '/fake/ffprobe', execFileFn: fakeExec(RICH, calls) })
      const out = await mi.info(file)
      assert.equal(out.ok, true, name)
      assert.equal(calls.length, 1)
      assert.equal(calls[0].exe, '/fake/ffprobe')
      assert.ok(Array.isArray(calls[0].args))
      const a = calls[0].args
      assert.equal(a[a.indexOf('-i') + 1], 'file:' + file, 'the path is ONE argument after -i, file:-prefixed, otherwise untouched')
      assert.equal(a.filter((x) => x === 'file:' + file).length, 1)
      assert.equal(a[a.indexOf('-protocol_whitelist') + 1], 'file,crypto,pipe')
      assert.ok(a.indexOf('-protocol_whitelist') < a.indexOf('-i'), 'the whitelist is an input option')
      assert.ok(!calls[0].opts.shell, 'never through a shell')
      assert.equal(calls[0].opts.windowsHide, true)
      assert.ok(calls[0].opts.timeout > 0, 'bounded run time')
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('paths ffprobe could mistake for options or that hide a second line are refused before any process starts', async () => {
  const calls = []
  const mi = mediaInfo.createMediaInfo({ ffprobePath: '/fake/ffprobe', execFileFn: fakeExec(RICH, calls) })
  const bad = ['', 'relative/path.mkv', '-i evil.mkv', '--help', 'C:\\ok.mkv\0.txt', '/tmp/a\nb.mkv', null, undefined, 42, {}, '/x'.repeat(3000)]
  for (const p of bad) {
    const out = await mi.info(p)
    assert.equal(out.ok, false)
    assert.equal(out.error, 'bad_path')
  }
  assert.equal(calls.length, 0)
  assert.equal(mediaInfo.isSafeMediaPath(path.join(os.tmpdir(), 'fine name.mkv')), true)
  assert.equal(mediaInfo.isSafeMediaPath('-rf'), false)
})

test('a path that does not exist is not_found and does not start ffprobe', async () => {
  const calls = []
  const mi = mediaInfo.createMediaInfo({ ffprobePath: '/fake/ffprobe', execFileFn: fakeExec(RICH, calls) })
  const out = await mi.info(path.join(os.tmpdir(), 'definitely-not-here-beebo.mkv'))
  assert.deepEqual(out, { ok: false, error: 'not_found' })
  assert.equal(calls.length, 0)
  const dir = tmpDir()
  try {
    assert.equal((await mi.info(dir)).error, 'not_found', 'a folder is not a video')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('missing ffprobe: a clear error, and the subtitle files beside the video are still offered', async () => {
  const dir = tmpDir()
  try {
    const movie = touch(dir, 'Film.mkv')
    touch(dir, 'Film.en.srt')
    const mi = mediaInfo.createMediaInfo({ ffprobePath: null })
    const out = await mi.info(movie)
    assert.equal(out.ok, false)
    assert.equal(out.error, 'no_ffprobe')
    assert.deepEqual(out.subtitles.map((s) => s.key), ['side:en#0'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('ffprobe failing (corrupt file, timeout) is reported as unreadable, not thrown', async () => {
  const dir = tmpDir()
  try {
    const movie = touch(dir, 'Broken.mkv')
    const mi = mediaInfo.createMediaInfo({ ffprobePath: '/fake/ffprobe', execFileFn: (exe, args, opts, cb) => setImmediate(() => cb(new Error('boom'))) })
    assert.deepEqual((await mi.info(movie)).error, 'unreadable')
    const garbage = mediaInfo.createMediaInfo({ ffprobePath: '/fake/ffprobe', execFileFn: (exe, args, opts, cb) => setImmediate(() => cb(null, 'not json')) })
    assert.deepEqual((await garbage.info(movie)).error, 'unreadable')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the picker data joins embedded tracks and files, and repeat opens do not probe again', async () => {
  const dir = tmpDir()
  try {
    const movie = touch(dir, 'Film.mkv')
    touch(dir, 'Film.de.srt')
    const calls = []
    const mi = mediaInfo.createMediaInfo({ ffprobePath: '/fake/ffprobe', execFileFn: fakeExec(RICH, calls) })
    const [a, b] = await Promise.all([mi.info(movie), mi.info(movie)])
    assert.equal(calls.length, 1, 'two simultaneous opens share one probe')
    assert.deepEqual(a, b)
    assert.deepEqual(a.subtitles.map((s) => s.key), ['emb:5', 'emb:6', 'emb:7', 'emb:8', 'side:de#0'])
    await mi.info(movie)
    assert.equal(calls.length, 1)
    fs.writeFileSync(movie, 'a different, longer body')
    await mi.info(movie)
    assert.equal(calls.length, 2, 'an edited file is probed again')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('results survive a restart through the disk cache, and the cache stays bounded', async () => {
  const dir = tmpDir()
  const cacheDir = path.join(dir, 'cache')
  try {
    const movie = touch(dir, 'Film.mkv')
    const calls = []
    const first = mediaInfo.createMediaInfo({ ffprobePath: '/fake/ffprobe', getCacheDir: () => cacheDir, execFileFn: fakeExec(RICH, calls) })
    await first.info(movie)
    assert.equal(calls.length, 1)
    assert.ok(fs.existsSync(path.join(cacheDir, mediaInfo.CACHE_FILE)))

    const second = mediaInfo.createMediaInfo({ ffprobePath: '/fake/ffprobe', getCacheDir: () => cacheDir, execFileFn: fakeExec(RICH, calls) })
    const out = await second.info(movie)
    assert.equal(calls.length, 1, 'a fresh process reads the disk cache')
    assert.equal(out.video.label, '1080p (HEVC Main 10)')

    const many = {}
    for (let i = 0; i < mediaInfo.MAX_DISK + 50; i++) many[`k${i}`] = { at: i, d: { audio: [], subtitles: [], video: null } }
    fs.writeFileSync(path.join(cacheDir, mediaInfo.CACHE_FILE), JSON.stringify({ v: 1, entries: many }))
    const third = mediaInfo.createMediaInfo({ ffprobePath: '/fake/ffprobe', getCacheDir: () => cacheDir, execFileFn: fakeExec(RICH, calls) })
    await third.info(movie)
    const saved = JSON.parse(fs.readFileSync(path.join(cacheDir, mediaInfo.CACHE_FILE), 'utf8'))
    assert.ok(Object.keys(saved.entries).length <= mediaInfo.MAX_DISK)
    assert.ok(!('k0' in saved.entries), 'the oldest entries go first')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a corrupt cache file is ignored, not fatal', async () => {
  const dir = tmpDir()
  const cacheDir = path.join(dir, 'cache')
  try {
    fs.mkdirSync(cacheDir)
    fs.writeFileSync(path.join(cacheDir, mediaInfo.CACHE_FILE), '{{{ not json')
    const movie = touch(dir, 'Film.mkv')
    const mi = mediaInfo.createMediaInfo({ ffprobePath: '/fake/ffprobe', getCacheDir: () => cacheDir, execFileFn: fakeExec(RICH, []) })
    assert.equal((await mi.info(movie)).ok, true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
