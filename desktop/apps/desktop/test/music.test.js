// The Music library: LRC parsing, conversion decisions, tag reading from real
// audio files, and the /api/music routes (auth, ranges, media tokens, ids that
// try to escape, conversion, the website page).
//
// Audio fixtures are made at test time with ffmpeg (the bundled one, or one on
// PATH). Without ffmpeg the fixture tests are skipped; the pure tests still run.
// Run: node --test test/music.test.js
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
const lyrics = localRequire('./electron/musicLyrics')
const transcode = localRequire('./electron/musicTranscode')
const musicLibrary = localRequire('./electron/musicLibrary')

function findFf(name) {
  const bundled = transcode.resolveFf(name)
  if (bundled) return bundled
  const probe = spawnSync(name, ['-version'], { windowsHide: true })
  return probe.status === 0 ? name : null
}
const FFMPEG = findFf('ffmpeg')
const FFPROBE = findFf('ffprobe')

function ff(args) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-y', ...args], { windowsHide: true })
  return r.status === 0
}

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

test('parseLrc: timestamps, several stamps per line, metadata, offset, enhanced word stamps', () => {
  const r = lyrics.parseLrc([
    '﻿[ar:Someone]',
    '[ti:A Song]',
    '[offset:+500]',
    '[00:12.30]First line',
    '[00:05.1][01:00.00]Chorus <00:05.50>word',
    '',
    '[1:02:03.456]Very late',
    '[00:07:25]Hundredths form',
    'not a lyric line'
  ].join('\r\n'))
  assert.equal(r.synced, true)
  assert.equal(r.meta.ar, 'Someone')
  assert.equal(r.offsetMs, 500)
  assert.deepEqual(r.lines.map((l) => [l.timeMs, l.text]), [
    [4600, 'Chorus word'],
    [6750, 'Hundredths form'],
    [11800, 'First line'],
    [59500, 'Chorus word'],
    [3722956, 'Very late']
  ])
  assert.equal(lyrics.activeLineIndex(r.lines, 0), -1)
  assert.equal(lyrics.activeLineIndex(r.lines, 4600), 0)
  assert.equal(lyrics.activeLineIndex(r.lines, 20000), 2)
  assert.equal(lyrics.activeLineIndex(r.lines, 10 ** 9), 4)

  const plain = lyrics.parseLrc('Just words\nNo times\n')
  assert.equal(plain.synced, false)
  assert.equal(plain.text, 'Just words\nNo times')
  assert.deepEqual(plain.lines, [])
})

test('embeddedLyricsText: plain strings, v11 lyric tags, synced SYLT text', () => {
  assert.equal(lyrics.embeddedLyricsText(null), '')
  assert.equal(lyrics.embeddedLyricsText(['hello']), 'hello')
  assert.equal(lyrics.embeddedLyricsText([{ text: 'unsynced words', syncText: [] }]), 'unsynced words')
  const synced = lyrics.embeddedLyricsText([{ syncText: [{ timestamp: 1500, text: 'one' }, { timestamp: 61000, text: 'two' }] }])
  assert.equal(synced, '[00:01.50]one\n[01:01.00]two')
  assert.equal(lyrics.parseLrc(synced).lines[1].timeMs, 61000)
})

test('decodeText: UTF-8, UTF-16 with BOM, and Latin-1 fallback', () => {
  assert.equal(lyrics.decodeText(Buffer.from('héllo', 'utf8')), 'héllo')
  assert.equal(lyrics.decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi ♪', 'utf16le')])), 'hi ♪')
  assert.equal(lyrics.decodeText(Buffer.from([0x63, 0x61, 0x66, 0xe9])), 'café')
})

test('conversion decision: only for codecs the player lacks or a quality cap', () => {
  const flac = { id: 'a'.repeat(20), codec: 'flac', lossless: true, bitrate: 900000 }
  const mp3 = { id: 'b'.repeat(20), codec: 'mp3', lossless: false, bitrate: 320000 }
  const aac128 = { id: 'c'.repeat(20), codec: 'aac', lossless: false, bitrate: 128000 }
  assert.equal(transcode.decide(flac, {}), null, 'no codecs list: assume it plays')
  assert.equal(transcode.decide(flac, { codecs: 'mp3,aac,flac' }), null)
  assert.deepEqual(transcode.decide(flac, { codecs: 'mp3,aac' }), { format: 'aac', kbps: 256 })
  assert.deepEqual(transcode.decide(flac, { codecs: 'mp3,aac,opus', format: 'opus' }), { format: 'opus', kbps: 192 })
  assert.deepEqual(transcode.decide(flac, { codecs: 'mp3,aac', format: 'opus' }), { format: 'aac', kbps: 256 }, 'no opus decoder, no opus')
  assert.deepEqual(transcode.decide(mp3, { quality: 'low' }), { format: 'aac', kbps: 96 })
  assert.equal(transcode.decide(aac128, { quality: 'medium' }), null, 'already under the cap')
  assert.equal(transcode.decide(aac128, { quality: 'bogus' }), null)
  assert.deepEqual(transcode.decide({ ...aac128, codec: 'alac', lossless: true }, { codecs: 'aac,flac' }), { format: 'aac', kbps: 256 })
  assert.deepEqual(transcode.decide({ ...mp3, bitrate: 128000 }, { codecs: 'aac' }), { format: 'aac', kbps: 128 }, 'no more bits than the source had')
  assert.deepEqual(Array.from(transcode.parseCodecs('MP3, wav ,ogg,nonsense')), ['mp3', 'pcm', 'vorbis'])
})

test('normalizeCodec and sortKey', () => {
  assert.equal(musicLibrary.normalizeCodec('MPEG 1 Layer 3', 'MPEG', '.mp3'), 'mp3')
  assert.equal(musicLibrary.normalizeCodec('ALAC', 'M4A/isom', '.m4a'), 'alac')
  assert.equal(musicLibrary.normalizeCodec('AAC', 'M4A/isom', '.m4a'), 'aac')
  assert.equal(musicLibrary.normalizeCodec('Vorbis I', 'Ogg', '.ogg'), 'vorbis')
  assert.equal(musicLibrary.normalizeCodec(undefined, undefined, '.flac'), 'flac')
  assert.equal(musicLibrary.normalizeCodec('PCM', 'WAVE', '.wav'), 'pcm')
  assert.equal(musicLibrary.sortKey('The Beatles'), 'beatles')
  assert.equal(musicLibrary.sortKey('Émile'), 'emile')
})

// ---------------------------------------------------------------------------
// Real files
// ---------------------------------------------------------------------------

async function makeFixtures(root) {
  const music = path.join(root, 'Music')
  const albumOne = path.join(music, 'Test Artist', 'First Album')
  const albumTwo = path.join(music, 'Test Artist', 'Second Album')
  const comp = path.join(music, 'Compilations', 'Summer Mix')
  const loose = path.join(music, 'Loose')
  for (const d of [albumOne, albumTwo, comp, loose]) await fsp.mkdir(d, { recursive: true })
  const cover = path.join(root, 'cover-src.png')
  assert.ok(ff(['-f', 'lavfi', '-i', 'color=c=red:s=16x16', '-frames:v', '1', cover]), 'make a cover image')
  const tone = (secs, freq = 440) => ['-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${secs}`]
  const tags = (o) => Object.entries(o).flatMap(([k, v]) => ['-metadata', `${k}=${v}`])

  // 1. FLAC with an embedded cover and embedded (unsynced) lyrics.
  assert.ok(ff([...tone(2), '-i', cover, '-map', '0:a', '-map', '1:v', '-c:a', 'flac', '-c:v', 'png', '-disposition:v', 'attached_pic',
    ...tags({ title: 'Opening Song', artist: 'Test Artist', album_artist: 'Test Artist', album: 'First Album', track: '1/2', disc: '1/1', date: '2001-05-01', genre: 'Rock', lyrics: 'La la la\nSecond line' }),
    path.join(albumOne, '01 Opening Song.flac')]), 'flac fixture')
  // 2. AAC in M4A, same album, no picture of its own, and a synced sidecar .lrc.
  assert.ok(ff([...tone(2, 660), '-c:a', 'aac', '-b:a', '96k',
    ...tags({ title: 'Closing Song', artist: 'Test Artist', album_artist: 'Test Artist', album: 'First Album', track: '2/2', disc: '1/1', date: '2001', genre: 'Rock' }),
    path.join(albumOne, '02 Closing Song.m4a')]), 'm4a fixture')
  await fsp.writeFile(path.join(albumOne, '02 Closing Song.lrc'), '[ti:Closing Song]\n[00:00.50]Hello\n[00:01.20]Goodbye\n')
  // 3. A second album that only has folder art (cover.png).
  assert.ok(ff([...tone(1, 520), '-c:a', 'flac', ...tags({ title: 'Deep Cut', artist: 'Test Artist', album_artist: 'Test Artist', album: 'Second Album', track: '1', date: '2005' }),
    path.join(albumTwo, 'Deep Cut.flac')]), 'second album fixture')
  await fsp.copyFile(cover, path.join(albumTwo, 'cover.png'))
  // 4. A compilation: two artists, no album artist, same folder.
  assert.ok(ff([...tone(1, 300), '-c:a', 'aac', ...tags({ title: 'Sunny', artist: 'Band One', album: 'Summer Mix', track: '1' }), path.join(comp, '01.m4a')]))
  assert.ok(ff([...tone(1, 350), '-c:a', 'aac', ...tags({ title: 'Breezy', artist: 'Band Two', album: 'Summer Mix', track: '2' }), path.join(comp, '02.m4a')]))
  // 5. An untagged WAV: title from the file name, album from the folder.
  assert.ok(ff([...tone(1, 700), '-c:a', 'pcm_s16le', path.join(loose, '07 - Field Recording.wav')]))
  // 6. Not audio, and something that looks like audio but is not.
  await fsp.writeFile(path.join(loose, 'notes.txt'), 'nothing')
  await fsp.writeFile(path.join(loose, 'broken.mp3'), 'this is not an mp3')
  return { music, albumOne, albumTwo, comp, loose }
}

test('library scan reads tags, covers, lyrics and groups albums', { skip: !FFMPEG && 'ffmpeg not found' }, async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'beebo-music-lib-'))
  try {
    const fx = await makeFixtures(root)
    const cache = path.join(root, 'cache')
    let reads = 0
    const real = musicLibrary.defaultTagReader({ ffprobePath: FFPROBE, ffmpegPath: FFMPEG })
    const lib = musicLibrary.createMusicLibrary({
      getDirs: () => [fx.music],
      getCacheDir: () => cache,
      readTags: (f) => { reads++; return real(f) }
    })
    const summary = await lib.scan()
    assert.equal(summary.trackCount, 7, 'six songs plus the unreadable one')
    assert.equal(reads, 7)

    const albums = lib.albums()
    const first = albums.find((a) => a.title === 'First Album')
    assert.ok(first)
    assert.equal(first.artist, 'Test Artist')
    assert.equal(first.trackCount, 2)
    assert.equal(first.year, 2001)
    assert.equal(first.genre, 'Rock')
    assert.match(first.coverId, /^[a-f0-9]{32}$/, 'album cover from the embedded picture')
    assert.ok(lib.coverFile(first.coverId))

    const { tracks } = lib.album(first.id)
    assert.deepEqual(tracks.map((t) => t.title), ['Opening Song', 'Closing Song'])
    const [opening, closing] = tracks
    assert.equal(opening.codec, 'flac')
    assert.equal(opening.lossless, true)
    assert.equal(opening.trackNo, 1)
    assert.equal(opening.trackTotal, 2)
    assert.equal(opening.discNo, 1)
    assert.equal(opening.albumArtist, 'Test Artist')
    assert.ok(opening.duration > 1.8 && opening.duration < 2.3, `duration ${opening.duration}`)
    assert.equal(opening.embeddedLyrics, true)
    assert.equal(closing.codec, 'aac')
    assert.equal(closing.sidecarLrc, true)
    assert.equal(closing.coverId, null)

    const emb = lib.lyrics(opening.id)
    assert.equal(emb.source, 'embedded')
    assert.equal(emb.synced, false)
    assert.match(emb.text, /La la la/)
    const lrc = lib.lyrics(closing.id)
    assert.equal(lrc.source, 'lrc')
    assert.equal(lrc.synced, true)
    assert.deepEqual(lrc.lines.map((l) => l.timeMs), [500, 1200])

    const second = albums.find((a) => a.title === 'Second Album')
    assert.match(second.coverId, /^[a-f0-9]{32}$/, 'folder art')
    assert.equal(second.coverId, first.coverId, 'same picture, stored once')

    const summer = albums.find((a) => a.title === 'Summer Mix')
    assert.equal(summer.artist, 'Various Artists')
    assert.equal(summer.trackCount, 2)

    const loose = lib.trackList().find((t) => t.title === 'Field Recording')
    assert.ok(loose, 'untagged: title from the file name')
    assert.equal(loose.album, 'Loose')
    assert.equal(loose.trackNo, null)
    assert.equal(loose.codec, 'pcm')

    const artists = lib.artists().map((a) => a.name)
    assert.ok(artists.includes('Test Artist') && artists.includes('Various Artists'))
    const ta = lib.artist(lib.artists().find((a) => a.name === 'Test Artist').id)
    assert.deepEqual(ta.albums.map((a) => a.title), ['First Album', 'Second Album'], 'oldest first')

    const found = lib.search('closing')
    assert.deepEqual(found.tracks.map((t) => t.title), ['Closing Song'])
    assert.deepEqual(lib.search('band two').tracks.map((t) => t.title), ['Breezy'])
    assert.deepEqual(lib.search('summer').albums.map((a) => a.title), ['Summer Mix'])

    // Ids are stable, and a list of ids comes back in the order asked.
    const ids = [closing.id, 'f'.repeat(20), opening.id]
    assert.deepEqual(lib.trackList({ ids }).map((t) => t.title), ['Closing Song', 'Opening Song'])

    // A rescan with nothing changed reads no tags; a changed file is read again.
    const reader2 = new Set()
    const lib2 = musicLibrary.createMusicLibrary({ getDirs: () => [fx.music], getCacheDir: () => cache, readTags: (f) => { reader2.add(f); return real(f) } })
    await lib2.scan()
    assert.equal(reader2.size, 0, 'the saved index is reused')
    assert.equal(lib2.album(first.id).tracks[0].id, opening.id)
    const later = new Date(Date.now() + 5000)
    await fsp.utimes(path.join(fx.albumOne, '02 Closing Song.m4a'), later, later)
    await lib2.scan()
    assert.deepEqual(Array.from(reader2).map((f) => path.basename(f)), ['02 Closing Song.m4a'])

    // A folder removed from settings stops being served at once.
    const lib3 = musicLibrary.createMusicLibrary({ getDirs: () => [], getCacheDir: () => cache, readTags: real })
    assert.ok(lib3.track(opening.id), 'still in the saved index')
    assert.equal(lib3.trackFile(opening.id), null, 'but not served from outside the Music folders')
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

test('the /api/music routes', { skip: !FFMPEG && 'ffmpeg not found' }, async () => {
  const server = localRequire('./electron/streamServer')
  const auth = localRequire('./electron/auth')
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'beebo-music-api-'))
  const savedFf = process.env.BEEBO_FFMPEG
  let info
  try {
    const fx = await makeFixtures(root)
    const cache = path.join(root, 'cache')
    await fsp.mkdir(path.join(root, 'Movies'), { recursive: true })
    const data = {}
    const store = { get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] }, onDidChange: () => () => {} }
    const { user } = auth.createUser(store, 'Listener', 'listener@example.com')
    const { user: admin } = auth.createUser(store, 'Owner', 'owner@example.com')
    auth.setUserAdmin(store, admin.id, true)
    const token = server.makeApiToken(store, user.id)
    const adminToken = server.makeApiToken(store, admin.id)

    const lib = musicLibrary.createMusicLibrary({
      getDirs: () => [fx.music],
      getCacheDir: () => cache,
      readTags: musicLibrary.defaultTagReader({ ffprobePath: FFPROBE, ffmpegPath: FFMPEG })
    })
    await lib.scan()
    // The transcoder the server builds finds ffmpeg through BEEBO_FFMPEG.
    if (FFMPEG !== 'ffmpeg') process.env.BEEBO_FFMPEG = FFMPEG
    else {
      const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'], { encoding: 'utf8' })
      process.env.BEEBO_FFMPEG = which.stdout.split(/\r?\n/)[0].trim()
    }

    const port = 47000 + Math.floor(Math.random() * 900) + 50
    info = server.startStreamServer({
      port, store, getMoviesDir: () => path.join(root, 'Movies'), getTvShowsDir: () => null,
      getAllMoviesDirs: () => [path.join(root, 'Movies')], getAllTvShowsDirs: () => [],
      getTmdbCacheDir: () => cache, log: () => {}, music: lib
    })
    const base = 'http://127.0.0.1:' + info.port
    for (let i = 0; i < 50; i++) {
      try { await (await fetch(base + '/api/ping')).arrayBuffer(); break } catch { await new Promise((r) => setTimeout(r, 100)) }
    }
    const get = async (u, { bearer = token, headers = {}, method = 'GET' } = {}) => {
      const res = await fetch(base + u, { method, redirect: 'manual', headers: { ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}), ...headers } })
      const buf = Buffer.from(await res.arrayBuffer())
      let body = null
      try { body = JSON.parse(buf.toString('utf8')) } catch {}
      return { status: res.status, headers: res.headers, buf, body }
    }

    // --- signed in only ---
    for (const u of ['/api/music/status', '/api/music/artists', '/api/music/albums', '/api/music/tracks', '/api/music/search?q=a']) {
      const r = await get(u, { bearer: null })
      assert.equal(r.status, 401, u)
    }
    assert.equal((await get('/api/music/artists', { bearer: 'someone.123.forged' })).status, 401)

    let r = await get('/api/music/status')
    assert.equal(r.status, 200)
    assert.equal(r.body.trackCount, 7)
    assert.equal(r.body.configured, true)

    r = await get('/api/music/albums')
    const first = r.body.items.find((a) => a.title === 'First Album')
    assert.match(first.cover, /^\/api\/music\/cover\/[a-f0-9]{32}$/)
    assert.equal(first.trackCount, 2)

    r = await get('/api/music/artists')
    const artist = r.body.items.find((a) => a.name === 'Test Artist')
    assert.equal(artist.albumCount, 2)
    r = await get('/api/music/artist/' + artist.id)
    assert.deepEqual(r.body.albums.map((a) => a.title), ['First Album', 'Second Album'])
    r = await get('/api/music/albums?artistId=' + artist.id)
    assert.equal(r.body.items.length, 2)

    r = await get('/api/music/album/' + first.id)
    assert.equal(r.status, 200)
    const [opening, closing] = r.body.tracks
    assert.equal(opening.title, 'Opening Song')
    assert.equal(opening.stream, `/api/music/track/${opening.id}/stream`, 'no token unless asked')
    assert.equal(opening.hasLyrics, true)
    assert.equal(closing.hasLyrics, true)
    assert.equal(opening.albumId, first.id)
    assert.ok(!('path' in opening), 'never a file path')
    assert.ok(!JSON.stringify(r.body).includes(root.replace(/\\/g, '\\\\')), 'no folder names leak')

    r = await get('/api/music/tracks?ids=' + [closing.id, opening.id].join(','))
    assert.deepEqual(r.body.items.map((t) => t.title), ['Closing Song', 'Opening Song'])
    r = await get('/api/music/tracks?limit=2&offset=1')
    assert.equal(r.body.total, 7)
    assert.equal(r.body.items.length, 2)

    r = await get('/api/music/search?q=deep')
    assert.deepEqual(r.body.tracks.map((t) => t.title), ['Deep Cut'])

    r = await get(`/api/music/track/${closing.id}/lyrics`)
    assert.equal(r.body.lyrics.synced, true)
    assert.deepEqual(r.body.lyrics.lines.map((l) => l.text), ['Hello', 'Goodbye'])

    // --- ids that are not ids ---
    for (const bad of ['..%2F..%2Fwindows%2Fwin.ini', '..%5C..%5Cwin.ini', 'ZZZZZZZZZZZZZZZZZZZZ', 'f'.repeat(20), '%00', opening.id + '.flac']) {
      assert.equal((await get(`/api/music/track/${bad}/stream`)).status, 404, 'stream ' + bad)
      assert.equal((await get(`/api/music/album/${bad}`)).status, 404, 'album ' + bad)
      assert.equal((await get(`/api/music/cover/${bad}`, { bearer: null })).status, 404, 'cover ' + bad)
    }
    assert.equal((await get('/api/music/track/..%2F..%2F..%2Fetc%2Fpasswd/lyrics')).status, 404)
    assert.equal((await get('/api/music/cover/..%5C..%5Clibrary.json', { bearer: null })).status, 404)

    // --- the audio ---
    const original = await fsp.readFile(path.join(fx.albumOne, '01 Opening Song.flac'))
    r = await get(`/api/music/track/${opening.id}/stream`)
    assert.equal(r.status, 200)
    assert.equal(r.headers.get('content-type'), 'audio/flac')
    assert.equal(r.headers.get('accept-ranges'), 'bytes')
    assert.ok(r.buf.equals(original))
    r = await get(`/api/music/track/${opening.id}/stream`, { headers: { Range: 'bytes=10-19' } })
    assert.equal(r.status, 206)
    assert.equal(r.headers.get('content-range'), `bytes 10-19/${original.length}`)
    assert.ok(r.buf.equals(original.subarray(10, 20)))
    r = await get(`/api/music/track/${opening.id}/stream`, { headers: { Range: 'bytes=-4' } })
    assert.ok(r.buf.equals(original.subarray(original.length - 4)))
    assert.equal((await get(`/api/music/track/${opening.id}/stream`, { headers: { Range: `bytes=${original.length}-` } })).status, 416)
    r = await get(`/api/music/track/${opening.id}/stream`, { method: 'HEAD' })
    assert.equal(r.status, 200)
    assert.equal(Number(r.headers.get('content-length')), original.length)

    // Media tokens: signed for one song only.
    assert.equal((await get(`/api/music/track/${opening.id}/stream`, { bearer: null })).status, 401)
    r = await get(`/api/music/album/${first.id}?tokens=1`)
    const tokened = r.body.tracks[0].stream
    assert.match(tokened, /\?mt=/)
    assert.equal((await get(tokened, { bearer: null })).status, 200)
    const mt = decodeURIComponent(tokened.split('mt=')[1])
    assert.equal((await get(`/api/music/track/${opening.id}/stream`, { bearer: null, headers: { 'X-Beebo-Media-Token': mt } })).status, 200, 'header form')
    assert.equal((await get(`/api/music/track/${closing.id}/stream?mt=${encodeURIComponent(mt)}`, { bearer: null })).status, 401, 'token for another song')
    const videoToken = server.makeMediaToken(store, opening.id)
    assert.equal((await get(`/api/music/track/${opening.id}/stream?mt=${encodeURIComponent(videoToken)}`, { bearer: null })).status, 401, 'a video token is not a music token')
    assert.equal((await get(`/api/music/track/${opening.id}/lyrics?mt=${encodeURIComponent(mt)}`, { bearer: null })).status, 401, 'tokens only open the stream')

    // Cover art: public by content hash.
    r = await get(first.cover, { bearer: null })
    assert.equal(r.status, 200)
    assert.equal(r.headers.get('content-type'), 'image/png')
    assert.equal(r.buf.subarray(1, 4).toString('ascii'), 'PNG')

    // Conversion: a player without FLAC gets AAC in MP4, which ranges like any file.
    r = await get(`/api/music/track/${opening.id}/stream?codecs=mp3,aac`)
    assert.equal(r.status, 200)
    assert.equal(r.headers.get('x-beebo-music-transcode'), 'aac-256')
    assert.equal(r.headers.get('content-type'), 'audio/mp4')
    assert.ok(r.buf.length > 1000 && !r.buf.equals(original))
    assert.equal(r.buf.subarray(4, 8).toString('ascii'), 'ftyp')
    const converted = r.buf
    r = await get(`/api/music/track/${opening.id}/stream?codecs=mp3,aac`, { headers: { Range: 'bytes=0-99' } })
    assert.equal(r.status, 206)
    assert.ok(r.buf.equals(converted.subarray(0, 100)), 'the same cached copy')
    r = await get(`/api/music/track/${closing.id}/stream?codecs=aac,flac`)
    assert.equal(r.headers.get('x-beebo-music-transcode'), 'original')
    r = await get(`/api/music/track/${opening.id}/stream?quality=low`)
    assert.equal(r.headers.get('x-beebo-music-transcode'), 'aac-96')

    // Rescan: admins only, POST only.
    assert.equal((await get('/api/music/rescan', { method: 'POST' })).status, 403)
    assert.equal((await get('/api/music/rescan')).status, 405)
    r = await get('/api/music/rescan', { method: 'POST', bearer: adminToken })
    assert.equal(r.status, 200)
    await lib.scan()

    // --- the website page ---
    r = await get('/music', { bearer: null })
    assert.equal(r.status, 302, 'login first')
    assert.equal((await get('/music/album.json?id=' + first.id, { bearer: null })).status, 302)
    const cookie = 'beebo_session=' + auth.signSession(store, user.id)
    r = await get('/music', { bearer: null, headers: { Cookie: cookie } })
    assert.equal(r.status, 200)
    const html = r.buf.toString('utf8')
    assert.match(html, /First Album/)
    assert.match(html, /Various Artists/)
    assert.match(html, /href="\/music"/, 'in the sidebar')
    r = await get('/music/album.json?id=' + first.id, { bearer: null, headers: { Cookie: cookie } })
    assert.equal(r.body.tracks.length, 2)
    assert.equal((await get(r.body.tracks[0].stream, { bearer: null })).status, 200, 'the page plays with media tokens')
    assert.equal((await get('/music/album.json?id=nope', { bearer: null, headers: { Cookie: cookie } })).status, 404)
  } finally {
    if (savedFf === undefined) delete process.env.BEEBO_FFMPEG
    else process.env.BEEBO_FFMPEG = savedFf
    if (info) await new Promise((r) => info.close(r))
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('/api/music with no Music folder configured', async () => {
  const server = localRequire('./electron/streamServer')
  const auth = localRequire('./electron/auth')
  const data = {}
  const store = { get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] }, onDidChange: () => () => {} }
  const { user } = auth.createUser(store, 'Listener', 'l@example.com')
  const token = server.makeApiToken(store, user.id)
  const port = 47000 + Math.floor(Math.random() * 900) + 50
  const info = server.startStreamServer({ port, store, getMoviesDir: () => null, getTvShowsDir: () => null, getAllMoviesDirs: () => [], getAllTvShowsDirs: () => [], getTmdbCacheDir: () => null, log: () => {} })
  try {
    const base = 'http://127.0.0.1:' + info.port
    for (let i = 0; i < 50; i++) {
      try { await (await fetch(base + '/api/ping')).arrayBuffer(); break } catch { await new Promise((r) => setTimeout(r, 100)) }
    }
    const res = await fetch(base + '/api/music/status', { headers: { Authorization: 'Bearer ' + token } })
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.configured, false)
    assert.equal(body.trackCount, 0)
    const albums = await (await fetch(base + '/api/music/albums', { headers: { Authorization: 'Bearer ' + token } })).json()
    assert.deepEqual(albums.items, [])
  } finally {
    await new Promise((r) => info.close(r))
  }
})

test('activeLineIndex is self-contained: the Music page embeds this very function', () => {
  const embedded = new Function('return (' + lyrics.activeLineIndex.toString() + ')')()
  const lines = [{ timeMs: 1000, text: 'a' }, { timeMs: 2500, text: 'b' }, { timeMs: 2500, text: 'c' }, { timeMs: 9000, text: 'd' }]
  for (const [pos, want] of [[0, -1], [999, -1], [1000, 0], [2499, 0], [2500, 2], [8999, 2], [9000, 3], [10 ** 9, 3]]) {
    assert.equal(embedded(lines, pos), want, `at ${pos}ms`)
    assert.equal(lyrics.activeLineIndex(lines, pos), want, `at ${pos}ms`)
  }
  assert.equal(embedded([], 5000), -1)
  assert.equal(embedded(null, 5000), -1)
  assert.equal(embedded(undefined, 5000), -1)
})

test('the Music page: its script is valid JavaScript and shares activeLineIndex', () => {
  const { createMusicApi } = localRequire('./electron/musicApi')
  const library = { status: () => ({ configured: true, scanning: false, progress: { done: 0, total: 0 }, albumCount: 0, trackCount: 0 }), albums: () => [] }
  const api = createMusicApi({ library, store: { get: () => undefined, set() {} }, makeMediaToken: () => 't', verifyMediaToken: () => false })
  let html = ''
  const res = { writeHead() {}, end(h) { html = h } }
  assert.equal(api.handleWeb({}, res, new URL('http://x/music'), { renderPage: (b) => b, nav: '' }), true)
  const start = html.indexOf('<script>') + '<script>'.length
  const code = html.slice(start, html.indexOf('</script>', start))
  assert.doesNotThrow(() => new Function(code), 'the inline script is valid JavaScript')
  assert.ok(code.includes(lyrics.activeLineIndex.toString()), 'the page embeds the tested lookup verbatim')
  assert.match(code, /activeLineIndex\(lyr,audio\.currentTime\*1000\)/)
  assert.match(html, /id="mly"/)
  assert.match(html, /id="mrec"/)
  assert.match(html, /id="mrecs"/)
})
