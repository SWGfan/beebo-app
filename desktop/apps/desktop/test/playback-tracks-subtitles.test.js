// Audio/subtitle track lists (playbackTracks.js) and "Search online" (openSubtitles.js) against
// a fake OpenSubtitles server on localhost. No real network.
// Run: node --test test/playback-tracks-subtitles.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { createRequire } = require('node:module')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))
const tracks = localRequire('./electron/playbackTracks')
const osub = localRequire('./electron/openSubtitles')

const PROBE = {
  streams: [
    { index: 0, codec_type: 'video', codec_name: 'hevc', width: 3840, height: 2160, avg_frame_rate: '24000/1001', color_transfer: 'smpte2084', pix_fmt: 'yuv420p10le' },
    { index: 1, codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } },
    { index: 2, codec_type: 'audio', codec_name: 'truehd', channels: 8, tags: { language: 'eng', title: 'Atmos' }, disposition: { default: 1 } },
    { index: 3, codec_type: 'audio', codec_name: 'ac3', channels: 6, tags: { language: 'fre' } },
    { index: 4, codec_type: 'audio', codec_name: 'aac', channels: 2, tags: { language: 'eng', title: 'Director commentary' }, disposition: { comment: 1 } },
    { index: 5, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'eng' } },
    { index: 6, codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle', tags: { language: 'eng', title: 'SDH' }, disposition: { hearing_impaired: 1 } },
    { index: 7, codec_type: 'subtitle', codec_name: 'ass', tags: { language: 'spa' }, disposition: { forced: 1 } },
    { index: 8, codec_type: 'subtitle', codec_name: 'dvd_subtitle' },
    { index: 9, codec_type: 'subtitle', codec_name: 'eia_608' }
  ],
  format: { format_name: 'matroska,webm', duration: '7200.5', bit_rate: '40000000' }
}

test('parseTracks: video, audio and subtitle lists with plain-English labels and stream indexes', () => {
  const t = tracks.parseTracks(PROBE)
  assert.equal(t.durationSec, 7200.5)
  assert.equal(t.bitrateKbps, 40000)
  assert.deepEqual({ ...t.video }, { streamIndex: 0, codec: 'hevc', profile: null, width: 3840, height: 2160, fps: 23.976, pixFmt: 'yuv420p10le', hdr: true, bitrateKbps: null })
  assert.deepEqual(t.audio.map((a) => [a.ordinal, a.streamIndex, a.label, a.isDefault]), [
    [0, 2, 'English · 7.1 · Dolby TrueHD (Atmos)', true],
    [1, 3, 'French · 5.1 · Dolby Digital', false],
    [2, 4, 'English · Stereo · AAC · Commentary (Director commentary)', false]
  ])
  assert.deepEqual(t.subtitles.map((s) => [s.streamIndex, s.kind, s.label]), [
    [5, 'text', 'English'],
    [6, 'image', 'English (SDH) · picture subtitles'],
    [7, 'text', 'Spanish (Forced)'],
    [8, 'image', 'Unknown language · picture subtitles'],
    [9, 'unsupported', 'Unknown language']
  ])
  assert.equal(tracks.parseTracks(null), null)
})

test('language helpers', () => {
  assert.equal(tracks.languageName('ger'), 'German')
  assert.equal(tracks.languageName('und'), '')
  assert.equal(tracks.twoLetter('eng'), 'en')
  assert.equal(tracks.twoLetter('pt-BR'), 'pt-br')
  assert.equal(tracks.sameLanguage('fre', 'fr'), true)
  assert.equal(tracks.sameLanguage('en', 'es'), false)
  assert.equal(tracks.sameLanguage('', ''), false)
  assert.equal(tracks.subtitleKind('mov_text'), 'text')
  assert.equal(tracks.subtitleKind('hdmv_pgs_subtitle'), 'image')
})

test('extractArgs maps one stream to WebVTT', () => {
  const a = tracks.extractArgs('in.mkv', 5, 'out.vtt')
  assert.deepEqual(a.slice(a.indexOf('-map')), ['-map', '0:5', '-c:s', 'webvtt', '-f', 'webvtt', 'out.vtt'])
})

test('track prober caches by file version and uses ffprobe once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-probe-'))
  const file = path.join(dir, 'a.mkv')
  fs.writeFileSync(file, 'x')
  let calls = 0
  const execFileFn = (exe, args, opts, cb) => { calls++; setImmediate(() => cb(null, JSON.stringify(PROBE))) }
  const p = tracks.createTrackProber({ ffprobePath: () => 'ffprobe', execFileFn })
  const [a, b] = await Promise.all([p.probe(file), p.probe(file)])
  assert.equal(calls, 1)
  assert.equal(a, b)
  assert.equal(await p.probe(path.join(dir, 'missing.mkv')), null)
  assert.equal(await tracks.createTrackProber({ ffprobePath: () => null }).probe(file), null)
  fs.rmSync(dir, { recursive: true, force: true })
})

// ----------------------------------------------------------------- hash
test('OpenSubtitles hash: size plus 64-bit word sums of the first and last 64 KB', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-hash-'))
  try {
    const size = 200000
    const buf = Buffer.alloc(size)
    for (let i = 0; i < size; i++) buf[i] = (i * 31 + 7) & 0xff
    const file = path.join(dir, 'movie.bin')
    fs.writeFileSync(file, buf)
    // Independent reference: add the words with plain BigInt arithmetic.
    let sum = BigInt(size)
    const add = (off) => { for (let i = 0; i < 65536; i += 8) sum += buf.readBigUInt64LE(off + i) }
    add(0); add(size - 65536)
    const expected = (sum % (1n << 64n)).toString(16).padStart(16, '0')
    assert.equal(await osub.computeHash(file), expected)
    assert.match(expected, /^[0-9a-f]{16}$/)
    // Overflow wraps at 64 bits.
    const ff = Buffer.alloc(65536, 0xff)
    assert.equal(osub.hashBuffers(1, ff, ff), ((1n + 2n * 8192n * ((1n << 64n) - 1n)) % (1n << 64n)).toString(16).padStart(16, '0'))
    // Too small to hash, or missing.
    fs.writeFileSync(path.join(dir, 'tiny'), 'abc')
    assert.equal(await osub.computeHash(path.join(dir, 'tiny')), null)
    assert.equal(await osub.computeHash(path.join(dir, 'nope')), null)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('search query: keys sorted, values lowercased, empties dropped', () => {
  assert.equal(osub.searchQuery({ query: 'The Matrix', languages: 'EN', year: 1999, season_number: null, moviehash: '' }), 'languages=en&query=the%20matrix&year=1999')
})

// ----------------------------------------------------------- fake server
function fakeOpenSubtitles() {
  const seen = []
  let tokenIssued = 0
  let failNextDownloadWith401 = false
  const srv = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body })
      const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }
      if (req.url.startsWith('/files/')) {
        res.writeHead(200, { 'Content-Type': 'application/x-subrip' })
        return res.end('1\r\n00:00:01,000 --> 00:00:02,000\r\nHi\r\n')
      }
      if (req.headers['api-key'] !== 'KEY') return json(401, { message: 'You cannot consume this service, invalid api key' })
      if (req.url === '/api/v1/login' && req.method === 'POST') {
        const b = JSON.parse(body)
        if (b.username !== 'nick' || b.password !== 'pw') return json(401, { message: 'Invalid username/password' })
        tokenIssued++
        return json(200, { token: 'TOKEN' + tokenIssued, base_url: 'api.opensubtitles.com', user: { allowed_downloads: 20 } })
      }
      if (req.url.startsWith('/api/v1/subtitles?')) {
        return json(200, {
          total_count: 3,
          data: [
            { id: '1', attributes: { language: 'en', download_count: 5000, moviehash_match: false, release: 'Popular.WEB', files: [{ file_id: 11, file_name: 'popular.srt' }], feature_details: { title: 'The Matrix', year: 1999 } } },
            { id: '2', attributes: { language: 'en', download_count: 10, moviehash_match: true, hearing_impaired: true, release: 'Exact.BluRay', files: [{ file_id: 22, file_name: 'exact.srt' }], feature_details: { title: 'The Matrix', year: 1999 } } },
            { id: '3', attributes: { language: 'en', download_count: 9999, files: [] } }
          ]
        })
      }
      if (req.url === '/api/v1/download' && req.method === 'POST') {
        if (failNextDownloadWith401) { failNextDownloadWith401 = false; return json(401, { message: 'token expired' }) }
        if (!/^Bearer TOKEN\d+$/.test(req.headers.authorization || '')) return json(401, { message: 'auth required' })
        const b = JSON.parse(body)
        return json(200, { link: `http://127.0.0.1:${srv.address().port}/files/${b.file_id}.srt`, file_name: 'exact.srt', remaining: 17, reset_time: '23 hours' })
      }
      if (req.url === '/api/v1/infos/user') {
        if (!/^Bearer /.test(req.headers.authorization || '')) return json(401, { message: 'auth' })
        return json(200, { data: { allowed_downloads: 20, remaining_downloads: 18, level: 'Sub leecher', vip: false } })
      }
      if (req.url.startsWith('/files/')) {
        res.writeHead(200, { 'Content-Type': 'application/x-subrip' })
        return res.end('1\r\n00:00:01,000 --> 00:00:02,000\r\nHi\r\n')
      }
      json(404, { message: 'nope' })
    })
  })
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({
    srv, seen, base: `http://127.0.0.1:${srv.address().port}/api/v1`,
    expireToken: () => { failNextDownloadWith401 = true },
    issued: () => tokenIssued
  })))
}

test('client: offline-safe without a key; search sorts hash matches first; download logs in', async () => {
  const fake = await fakeOpenSubtitles()
  try {
    let cfg = { apiKey: '', username: '', password: '' }
    const client = osub.createOpenSubtitlesClient({ config: () => cfg, baseUrl: fake.base })
    assert.equal(client.configured(), false)
    await assert.rejects(client.search({ query: 'x' }), (e) => e.code === 'not_configured')
    assert.equal(fake.seen.length, 0, 'no key: nothing sent anywhere')

    cfg = { apiKey: 'KEY', username: '', password: '' }
    const results = await client.search({ moviehash: 'ABCDEF0123456789', query: 'The Matrix', year: 1999, languages: 'en', type: 'movie' })
    const url = fake.seen[0].url
    assert.equal(url, '/api/v1/subtitles?languages=en&moviehash=abcdef0123456789&query=the%20matrix&type=movie&year=1999')
    assert.equal(fake.seen[0].headers['user-agent'], 'Beebo v1')
    assert.deepEqual(results.map((r) => [r.fileId, r.hashMatch]), [[22, true], [11, false]], 'hash match first; entries without files dropped')
    assert.equal(results[0].hearingImpaired, true)

    await assert.rejects(client.download(22), (e) => e.code === 'no_login')

    cfg = { apiKey: 'KEY', username: 'nick', password: 'pw' }
    const got = await client.download(22)
    assert.match(got.data.toString(), /-->/)
    assert.equal(got.remaining, 17)
    assert.equal(fake.issued(), 1)
    await client.download(22)
    assert.equal(fake.issued(), 1, 'token reused')
    fake.expireToken()
    await client.download(22)
    assert.equal(fake.issued(), 2, 'a 401 signs in again once')

    const t = await client.test()
    assert.equal(t.allowedDownloads, 20)
    assert.equal(t.remainingDownloads, 18)
    assert.match(t.message, /20 subtitles a day; 18 left today/)

    cfg = { apiKey: 'WRONG', username: 'nick', password: 'pw' }
    await assert.rejects(client.test(), (e) => e.code === 'bad_key')
    cfg = { apiKey: 'KEY', username: 'nick', password: 'bad' }
    await assert.rejects(client.test(), (e) => e.code === 'bad_login')
    cfg = { apiKey: 'KEY', username: '', password: '' }
    const keyOnly = await client.test()
    assert.equal(keyOnly.loggedIn, false)

    const offline = osub.createOpenSubtitlesClient({ config: { apiKey: 'KEY' }, baseUrl: 'http://127.0.0.1:1/api/v1' })
    await assert.rejects(offline.search({ query: 'x' }), (e) => e.code === 'offline')
  } finally { fake.srv.close() }
})

test('sidecars: named like Plex, numbered when taken, never overwrite', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-sidecar-'))
  try {
    const video = path.join(dir, 'The Matrix (1999).mkv')
    fs.writeFileSync(video, 'v')
    fs.writeFileSync(path.join(dir, 'The Matrix (1999).en.srt'), 'ORIGINAL')
    const a = osub.writeSidecar(video, 'en', 'NEW1')
    assert.equal(path.basename(a), 'The Matrix (1999).en.2.srt')
    const b = osub.writeSidecar(video, 'en', 'NEW2')
    assert.equal(path.basename(b), 'The Matrix (1999).en.3.srt')
    assert.equal(fs.readFileSync(path.join(dir, 'The Matrix (1999).en.srt'), 'utf8'), 'ORIGINAL')
    assert.equal(path.basename(osub.writeSidecar(video, 'es', 'x', { hearingImpaired: true })), 'The Matrix (1999).es.sdh.srt')
    assert.equal(path.basename(osub.sidecarPathFor(video, 'fr', { forced: true, ext: 'vtt' })), 'The Matrix (1999).fr.forced.vtt')
    assert.equal(osub.looksLikeSubtitle(Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nHi')), true)
    assert.equal(osub.looksLikeSubtitle(Buffer.from('<html>error</html>')), false)
    assert.equal(osub.looksLikeSubtitle(Buffer.from('PKzip')), false)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
