// Music volume levelling, phase 1: ReplayGain read from the files' own tags and passed on (never applied
// to the audio bytes). Parsing, both tag readers, the saved index upgrade, the API shape, lossless left
// alone, and which gain a player should apply.
// Run: node --test test/music-gain.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { createRequire } = require('node:module')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))
const lib = localRequire('./electron/musicLibrary')
const gain = localRequire('./electron/musicGain')
const transcode = localRequire('./electron/musicTranscode')

function findFf(name) {
  const bundled = transcode.resolveFf(name)
  if (bundled) return bundled
  const probe = spawnSync(name, ['-version'], { windowsHide: true })
  return probe.status === 0 ? name : null
}
const FFMPEG = findFf('ffmpeg')
const FFPROBE = findFf('ffprobe')
const SKIP = !FFMPEG || !FFPROBE ? 'ffmpeg/ffprobe not found' : false
const ff = (args) => spawnSync(FFMPEG, ['-v', 'error', '-y', ...args], { windowsHide: true }).status === 0

// ------------------------------------------------------------------ parsing
test('parseGainDb: the shapes tag writers use, and nothing else', () => {
  const ok = [['-6.50 dB', -6.5], ['+3.20 dB', 3.2], ['-6.5', -6.5], ['0 dB', 0], ['  -0.01 DB ', -0.01], ['-6,5 dB', -6.5], [-4.25, -4.25], [{ dB: -3.1, ratio: 0.7 }, -3.1], [['-2.0 dB'], -2], ['12.345678 dB', 12.35]]
  for (const [input, want] of ok) assert.equal(lib.parseGainDb(input), want, JSON.stringify(input))
  for (const bad of [undefined, null, '', ' ', 'loud', 'NaN dB', '-6.5 dB extra', '--6', '31 dB', -31, NaN, Infinity, {}, { dB: 'x' }, [], true, '1e3']) {
    assert.equal(lib.parseGainDb(bad), null, JSON.stringify(bad))
  }
})

test('parsePeak: linear peaks only', () => {
  assert.equal(lib.parsePeak('0.988553'), 0.988553)
  assert.equal(lib.parsePeak(1.0117), 1.0117)
  assert.equal(lib.parsePeak({ ratio: 0.5 }), 0.5)
  assert.equal(lib.parsePeak('0,75'), 0.75)
  for (const bad of [undefined, null, '', 0, -1, 'x', NaN, 99, {}, []]) assert.equal(lib.parsePeak(bad), null, JSON.stringify(bad))
})

test('parseR128Gain: Opus Q7.8 against -23 LUFS becomes ReplayGain-reference dB', () => {
  assert.equal(lib.parseR128Gain('0'), 5)
  assert.equal(lib.parseR128Gain('-1280'), 0)
  assert.equal(lib.parseR128Gain('-2560'), -5)
  assert.equal(lib.parseR128Gain(['512']), 7)
  for (const bad of [undefined, null, '', 'x', NaN]) assert.equal(lib.parseR128Gain(bad), null, JSON.stringify(bad))
})

test('music-metadata result: common fields, native fields, R128, and files with no tags', () => {
  assert.deepEqual(lib.replayGainFromMusicMetadata({ common: { replaygain_track_gain: { dB: -7.2, ratio: 0.43 }, replaygain_album_gain: { dB: -5.9, ratio: 0.5 }, replaygain_track_peak: { ratio: 0.93, dB: -0.6 }, replaygain_album_peak: { ratio: 1.0 } } }),
    { gainDb: -7.2, albumGainDb: -5.9, gainPeak: 0.93, albumGainPeak: 1 })
  assert.deepEqual(lib.replayGainFromMusicMetadata({ common: {}, native: { vorbis: [{ id: 'REPLAYGAIN_TRACK_GAIN', value: '-8.10 dB' }, { id: 'replaygain_track_peak', value: '0.5' }] } }),
    { gainDb: -8.1, albumGainDb: null, gainPeak: 0.5, albumGainPeak: null })
  assert.deepEqual(lib.replayGainFromMusicMetadata({ common: {}, native: { vorbis: [{ id: 'R128_TRACK_GAIN', value: '-1536' }, { id: 'R128_ALBUM_GAIN', value: '-1024' }] } }),
    { gainDb: -1, albumGainDb: 1, gainPeak: null, albumGainPeak: null })
  assert.deepEqual(lib.replayGainFromMusicMetadata({ common: {} }), { gainDb: null, albumGainDb: null, gainPeak: null, albumGainPeak: null })
  assert.deepEqual(lib.replayGainFromMusicMetadata({}), { gainDb: null, albumGainDb: null, gainPeak: null, albumGainPeak: null })
  assert.equal(lib.replayGainFromMusicMetadata({ common: { replaygain_track_gain: { dB: 55 } } }).gainDb, null, 'absurd values are dropped')
  // ReplayGain tags win over R128 when both exist.
  assert.equal(lib.replayGainFromMusicMetadata({ common: { replaygain_track_gain: { dB: -3 } }, native: { vorbis: [{ id: 'R128_TRACK_GAIN', value: '0' }] } }).gainDb, -3)
})

test('ffprobe tags: lower-cased keys as plain strings', () => {
  assert.deepEqual(lib.replayGainFromTags({ replaygain_track_gain: '-6.50 dB', replaygain_track_peak: '0.988553', replaygain_album_gain: '-5.10 dB', replaygain_album_peak: '1.000000' }),
    { gainDb: -6.5, albumGainDb: -5.1, gainPeak: 0.988553, albumGainPeak: 1 })
  assert.deepEqual(lib.replayGainFromTags({ r128_track_gain: '-512' }), { gainDb: 3, albumGainDb: null, gainPeak: null, albumGainPeak: null })
  assert.deepEqual(lib.replayGainFromTags({}), { gainDb: null, albumGainDb: null, gainPeak: null, albumGainPeak: null })
  assert.deepEqual(lib.replayGainFromTags(null), { gainDb: null, albumGainDb: null, gainPeak: null, albumGainPeak: null })
  assert.deepEqual(lib.replayGainFromTags({ replaygain_track_gain: 'garbage', replaygain_track_peak: '-3' }), { gainDb: null, albumGainDb: null, gainPeak: null, albumGainPeak: null })
})

// ------------------------------------------------------------ which gain to use
test('replayGainDb: album mode uses the album gain, track mode the track gain, each falls back to the other', () => {
  const t = { gainDb: -6, albumGainDb: -4 }
  assert.equal(gain.replayGainDb(t, 'track'), -6)
  assert.equal(gain.replayGainDb(t, 'album'), -4)
  assert.equal(gain.replayGainDb({ gainDb: -6 }, 'album'), -6)
  assert.equal(gain.replayGainDb({ albumGainDb: -4 }, 'track'), -4)
  assert.equal(gain.replayGainDb({}, 'album'), null)
  assert.equal(gain.replayGainDb(null, 'track'), null)
  assert.equal(gain.replayGainDb({ gainDb: null, albumGainDb: null }, 'track'), null)
  assert.equal(gain.replayGainDb({ gainDb: 'loud' }, 'track'), null)
  assert.equal(gain.replayGainDb({ gainDb: NaN }, 'track'), null)
})

test('replayGainDb: never lets the tag peak clip, stays within -30..+12', () => {
  assert.equal(gain.replayGainDb({ gainDb: 6, gainPeak: 1 }, 'track'), 0, 'a full-scale song is not boosted')
  const r = gain.replayGainDb({ gainDb: 9, gainPeak: 0.5 }, "track")
  assert.ok(Math.abs(r - 6.0206) < 0.001, `peak 0.5 leaves 6.02 dB of room (${r})`)
  assert.equal(gain.replayGainDb({ gainDb: -6, gainPeak: 1 }, 'track'), -6, 'attenuation is always fine')
  assert.equal(gain.replayGainDb({ gainDb: 20 }, 'track'), 12)
  assert.equal(gain.replayGainDb({ gainDb: -29.9 }, 'track'), -29.9)
  // Album mode is limited by the album's peak; a missing album peak falls back to the song's.
  assert.equal(gain.replayGainDb({ gainDb: -6, albumGainDb: 3, albumGainPeak: 1 }, 'album'), 0)
  assert.ok(Math.abs(gain.replayGainDb({ gainDb: -6, albumGainDb: 3, gainPeak: 0.5 }, 'album') - 3) < 1e-9)
  for (let i = 0; i < 500; i++) {
    const g = (Math.random() - 0.5) * 60
    const peak = Math.random() * 1.5 + 0.01
    const db = gain.replayGainDb({ gainDb: g, gainPeak: peak }, 'track')
    assert.ok(peak * gain.dbToLinear(db) <= 1 + 1e-9 || db === -30, `no clipping: gain ${g.toFixed(2)} peak ${peak.toFixed(3)} -> ${db}`)
  }
  assert.equal(gain.dbToLinear(null), 1)
  assert.equal(gain.dbToLinear(NaN), 1)
  assert.ok(Math.abs(gain.dbToLinear(-6.0206) - 0.5) < 1e-3)
})

test('replayGainDb is self-contained: the Music page embeds this very function', () => {
  const embedded = new Function('return (' + gain.replayGainDb.toString() + ')')()
  for (const [t, mode] of [[{ gainDb: -6, albumGainDb: -4 }, 'album'], [{ gainDb: -6, albumGainDb: -4 }, 'track'], [{ gainDb: 5, gainPeak: 0.8 }, 'track'], [{}, 'album'], [null, 'album']]) {
    assert.equal(embedded(t, mode), gain.replayGainDb(t, mode))
  }
})

// ------------------------------------------------------- real files, both readers
test('ReplayGain in real MP3, FLAC, Ogg and M4A files, via music-metadata and via ffprobe', { skip: SKIP, timeout: 120000 }, async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'beebo-music-gain-'))
  try {
    const tone = ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1']
    const rg = (extra = {}) => Object.entries({ REPLAYGAIN_TRACK_GAIN: '-6.50 dB', REPLAYGAIN_TRACK_PEAK: '0.988553', REPLAYGAIN_ALBUM_GAIN: '-5.25 dB', REPLAYGAIN_ALBUM_PEAK: '1.000000', ...extra }).flatMap(([k, v]) => ['-metadata', `${k}=${v}`])
    const files = {
      flac: path.join(root, 'a.flac'), mp3: path.join(root, 'b.mp3'), ogg: path.join(root, 'c.ogg'), m4a: path.join(root, 'd.m4a'), none: path.join(root, 'e.flac')
    }
    assert.ok(ff([...tone, '-c:a', 'flac', ...rg(), files.flac]))
    assert.ok(ff([...tone, '-c:a', 'libmp3lame', '-write_id3v2', '1', ...rg(), files.mp3]))
    assert.ok(ff([...tone, '-c:a', 'libvorbis', ...rg(), files.ogg]) || ff([...tone, '-c:a', 'flac', '-f', 'ogg', ...rg(), files.ogg]))
    assert.ok(ff([...tone, '-c:a', 'aac', '-movflags', 'use_metadata_tags', ...rg(), files.m4a]))
    assert.ok(ff([...tone, '-c:a', 'flac', '-metadata', 'title=No gain here', files.none]))
    const viaMm = lib.defaultTagReader({})
    const viaProbe = (f) => lib.readTagsWithFfprobe(f, { ffprobePath: FFPROBE, ffmpegPath: FFMPEG })
    for (const [kind, file] of Object.entries(files)) {
      for (const [name, read] of [['music-metadata', viaMm], ['ffprobe', viaProbe]]) {
        const tags = await read(file)
        if (kind === 'none') {
          assert.equal(tags.gainDb ?? null, null, `${name} ${kind}`)
          assert.equal(tags.albumGainDb ?? null, null)
          continue
        }
        // ffmpeg writes MP4 free-form tags in a layout music-metadata cannot name (iTunes and foobar2000 write the
        // standard one, which it can), so that one file type is only asserted through the ffprobe reader.
        if (kind === 'm4a' && name === 'music-metadata') continue
        assert.equal(tags.gainDb, -6.5, `${name} ${kind} track gain`)
        assert.equal(tags.albumGainDb, -5.25, `${name} ${kind} album gain`)
        assert.ok(Math.abs(tags.gainPeak - 0.988553) < 1e-6, `${name} ${kind} peak ${tags.gainPeak}`)
        assert.equal(tags.albumGainPeak, 1)
      }
    }
    // The audio bytes are untouched by the scan.
    const before = fs.readFileSync(files.flac)
    const library = lib.createMusicLibrary({ getDirs: () => [root], getCacheDir: () => path.join(root, 'cache'), readTags: lib.defaultTagReader({ ffprobePath: FFPROBE, ffmpegPath: FFMPEG }) })
    await library.scan()
    assert.ok(before.equals(fs.readFileSync(files.flac)), 'the file is not rewritten')
    const flac = library.trackList().find((t) => t.path === files.flac)
    assert.equal(flac.gainDb, -6.5)
    assert.equal(flac.albumGainDb, -5.25)
    assert.equal(flac.lossless, true)
    assert.equal(flac.tagVersion, lib.INDEX_VERSION)
    const none = library.trackList().find((t) => t.path === files.none)
    assert.equal(none.gainDb, null)
    assert.equal(none.albumGainDb, null)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

// ------------------------------------------------------- the saved index upgrade
test('an index saved by version 1 is still read, and every song in it is tagged again once', { skip: SKIP, timeout: 120000 }, async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'beebo-music-idx-'))
  try {
    const dir = path.join(root, 'Music')
    await fsp.mkdir(dir)
    const song = path.join(dir, 'Song.flac')
    assert.ok(ff(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'flac', '-metadata', 'title=Song', '-metadata', 'REPLAYGAIN_TRACK_GAIN=-4.00 dB', song]))
    const st = fs.statSync(song)
    const id = lib.trackIdFor(song)
    const cache = path.join(root, 'cache')
    await fsp.mkdir(path.join(cache, 'music'), { recursive: true })
    const oldAdded = 1_600_000_000_000
    fs.writeFileSync(path.join(cache, 'music', 'library.json'), JSON.stringify({
      version: 1, savedAt: 1, tracks: [{ id, path: song, size: st.size, mtimeMs: st.mtimeMs, addedAt: oldAdded, title: 'Song', artist: 'A', album: 'B', codec: 'flac', lossless: true, container: 'flac' }]
    }))
    let reads = 0
    const real = lib.defaultTagReader({ ffprobePath: FFPROBE, ffmpegPath: FFMPEG })
    const library = lib.createMusicLibrary({ getDirs: () => [dir], getCacheDir: () => cache, readTags: (f) => { reads++; return real(f) } })
    assert.equal(library.track(id).title, 'Song', 'served from the old index straight away')
    assert.equal(library.track(id).gainDb, undefined, 'no gain known yet')
    await library.scan()
    assert.equal(reads, 1, 'tagged again although the file did not change')
    const t = library.track(id)
    assert.equal(t.gainDb, -4)
    assert.equal(t.addedAt, oldAdded, 'recently-added order survives the upgrade')
    assert.equal(t.id, id)
    const saved = JSON.parse(fs.readFileSync(path.join(cache, 'music', 'library.json'), 'utf8'))
    assert.equal(saved.version, lib.INDEX_VERSION)
    await library.scan()
    assert.equal(reads, 1, 'and only once')
    // A future version is ignored (its shape is unknown), not half-read.
    fs.writeFileSync(path.join(cache, 'music', 'library.json'), JSON.stringify({ version: 99, tracks: [{ id, path: song, title: 'Future' }] }))
    const lib2 = lib.createMusicLibrary({ getDirs: () => [dir], getCacheDir: () => cache, readTags: real })
    assert.equal(lib2.track(id), null)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

// -------------------------------------------------------------------- the API shape
test('trackShape carries the gain fields (null when the file has none) and changes nothing else', () => {
  const { createMusicApi } = localRequire('./electron/musicApi')
  const api = createMusicApi({ library: {}, store: { get: () => undefined, set() {} }, makeMediaToken: () => 't', verifyMediaToken: () => false })
  const base = { id: 'a'.repeat(20), title: 'T', artist: 'A', album: 'B', codec: 'flac', lossless: true }
  const tagged = api.trackShape({ ...base, gainDb: -6.5, albumGainDb: -5.25, gainPeak: 0.9, albumGainPeak: 1 })
  assert.equal(tagged.gainDb, -6.5)
  assert.equal(tagged.albumGainDb, -5.25)
  assert.equal(tagged.gainPeak, 0.9)
  assert.equal(tagged.albumGainPeak, 1)
  assert.equal(tagged.lossless, true)
  assert.equal(tagged.codec, 'flac')
  const plain = api.trackShape(base)
  for (const k of ['gainDb', 'albumGainDb', 'gainPeak', 'albumGainPeak']) assert.equal(plain[k], null, k)
  const weird = api.trackShape({ ...base, gainDb: 'loud', albumGainDb: NaN })
  assert.equal(weird.gainDb, null)
  assert.equal(weird.albumGainDb, null)
  assert.equal(api.trackShape({ ...base, gainDb: 0 }).gainDb, 0, 'a real 0 dB is kept')
})

test('lossless files are served as they are: no conversion because of gain, for a browser or the phone', () => {
  const flac = { codec: 'flac', lossless: true, bitrate: 900000, sampleRate: 44100, channels: 2, gainDb: -8 }
  assert.equal(transcode.decide(flac, {}), null, 'the Music page asks for nothing special')
  assert.equal(transcode.decide(flac, { codecs: 'mp3,aac,flac,opus,vorbis,alac,pcm' }), null)
  assert.equal(transcode.decide({ ...flac, codec: 'alac' }, { codecs: 'mp3,aac,flac,alac' }), null)
  assert.equal(transcode.decide({ ...flac, gainDb: null }, {}), transcode.decide(flac, {}), 'the gain tag is not part of the decision')
})
