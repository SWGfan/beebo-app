// The home theatre routes on a real server: /playback/info carries badges + the plan for the calling device,
// /playback/negotiate returns DirectPlay | DirectStream | Transcode with reasons and the URL that plays it, and the
// direct-stream tickets (master.m3u8, index.m3u8, init.mp4, seg-N.m4s) serve real fragmented MP4 made by a real ffmpeg
// (skipped without one). Also: settings (force transcode, per-person override), tickets that cannot be forged.
// Run: node --test test/playback-negotiate.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { createRequire } = require('node:module')
const { testPort } = require('./helpers/testPort')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))

function findTool(name) {
  const convert = localRequire('./electron/convert')
  const fromApp = name === 'ffmpeg' ? convert.ffmpegPath() : convert.ffprobePath()
  if (fromApp) return fromApp
  const r = spawnSync(name, ['-version'], { windowsHide: true })
  return r.status === 0 ? name : null
}
const FFMPEG = findTool('ffmpeg')
const FFPROBE = findTool('ffprobe')
const ff = (args) => spawnSync(FFMPEG, ['-hide_banner', '-v', 'error', '-y', ...args], { encoding: 'utf8', windowsHide: true })
const encoders = FFMPEG ? String(ff(['-encoders']).stdout || '') : ''
const H264 = /libx264\b/.test(encoders) ? ['-c:v', 'libx264', '-preset', 'ultrafast'] : /libopenh264/.test(encoders) ? ['-c:v', 'libopenh264'] : null
const skip = !FFMPEG || !FFPROBE || !H264 ? 'needs ffmpeg + ffprobe with an H.264 encoder' : false

async function startServer({ moviesDir, tmpRoot }) {
  const server = localRequire('./electron/streamServer')
  const auth = localRequire('./electron/auth')
  const data = {}
  const store = { get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] }, onDidChange: () => () => {} }
  const { user } = auth.createUser(store, 'Viewer', 'viewer@example.com')
  const port = testPort()
  const info = server.startStreamServer({
    port, store, getMoviesDir: () => moviesDir, getTvShowsDir: () => null,
    getAllMoviesDirs: () => [moviesDir], getAllTvShowsDirs: () => [], log: () => {},
    playback: { tmpRoot, ffmpegPath: () => FFMPEG, ffprobePath: () => FFPROBE }
  })
  const base = 'http://127.0.0.1:' + info.port
  for (let i = 0; i < 50; i++) {
    try { await (await fetch(base + '/api/ping')).arrayBuffer(); break } catch { await new Promise((r) => setTimeout(r, 100)) }
  }
  const call = async (u, opts = {}, who = user) => {
    const res = await fetch(base + u, { ...opts, headers: { Authorization: 'Bearer ' + server.makeApiToken(store, who.id), 'content-type': 'application/json', ...(opts.headers || {}) } })
    const text = await res.text()
    let body = null
    try { body = JSON.parse(text) } catch { /* not json */ }
    return { status: res.status, body, text, headers: res.headers }
  }
  return { server, info, base, store, data, user, call }
}

async function stop(s, root) {
  await new Promise((r) => s.info.close(r))
  await new Promise((r) => setTimeout(r, 300))
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 })
}

function makeMovies(dir) {
  const moviesDir = path.join(dir, 'Movies')
  fs.mkdirSync(moviesDir)
  const clip = (name, audio, extra = []) => {
    const r = ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=20', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20,aformat=channel_layouts=5.1', '-map', '0:v', '-map', '1:a',
      ...H264, '-pix_fmt', 'yuv420p', '-force_key_frames', 'expr:gte(t,n_forced*3)', '-c:a', audio, '-b:a', '384k', ...extra, path.join(moviesDir, name)])
    assert.equal(r.status, 0, String(r.stderr))
  }
  clip('Plain (2020).mp4', 'aac', ['-ac', '6'])
  clip('Remux (2021).mkv', 'eac3')
  return moviesDir
}

const APPLE_UA = 'AppleTV11,1/16.1'

test('info: badges, the precise format and a plan for the calling device (from its User-Agent or X-Beebo-Client)', { skip }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-ht-info-'))
  const s = await startServer({ moviesDir: makeMovies(root), tmpRoot: path.join(root, 'tmp') })
  try {
    const id = s.server.encodeId('Remux (2021).mkv')
    let r = await s.call(`/api/playback/info?kind=movie&id=${encodeURIComponent(id)}`, { headers: { 'user-agent': APPLE_UA } })
    assert.equal(r.status, 200)
    const ht = r.body.homeTheater
    assert.ok(ht, 'homeTheater block')
    assert.ok(ht.badges.includes('5.1'), `badges ${ht.badges}`)
    assert.equal(ht.video.hdrType, 'SDR'); assert.equal(ht.video.bitDepth, 8)
    assert.equal(ht.audio[0].family, 'ddp'); assert.equal(ht.audio[0].layout, '5.1')
    assert.equal(ht.profile.client, 'appletv'); assert.equal(ht.profile.source, 'default:appletv')
    // an MKV on Apple TV: container repackaged, picture and sound copied
    assert.equal(ht.plan.method, 'DirectStream')
    assert.equal(ht.plan.video.action, 'copy'); assert.equal(ht.plan.audio.action, 'copy'); assert.ok(ht.plan.reasonCodes.includes('CONTAINER_NOT_SUPPORTED'))
    // the existing fields grew the precise facts too
    assert.equal(r.body.video.hdrType, 'SDR'); assert.equal(r.body.video.resolutionClass, 'SD')
    assert.equal(r.body.audio[0].family, 'ddp'); assert.equal(r.body.audio[0].spatialFormat, 'None')
    // the same file for a client that says so explicitly
    r = await s.call(`/api/playback/info?kind=movie&id=${encodeURIComponent(id)}`, { headers: { 'x-beebo-client': 'chrome' } })
    assert.equal(r.body.homeTheater.profile.client, 'chrome')
    assert.equal(r.body.homeTheater.plan.audio.action, 'transcode', 'a browser without AC-3 / E-AC-3 gets the sound converted')
    assert.equal(r.body.homeTheater.plan.video.action, 'copy')
    // a plain MP4 on a browser plays as it is
    const id2 = s.server.encodeId('Plain (2020).mp4')
    r = await s.call(`/api/playback/info?kind=movie&id=${encodeURIComponent(id2)}`, { headers: { 'x-beebo-client': 'chrome' } })
    assert.equal(r.body.homeTheater.plan.method, 'DirectPlay')
    // the GET route that tells a client which profile the server assumed
    r = await s.call('/api/playback/hometheater', { headers: { 'user-agent': 'Roku/DVP-12.5' } })
    assert.equal(r.body.profile.client, 'roku'); assert.equal(r.body.settings.directPlayPreferred, true); assert.equal(r.body.remux.available, true)
  } finally { await stop(s, root) }
})

test('negotiate: DirectPlay returns the original file URL, and that URL serves the file', { skip }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-ht-dp-'))
  const s = await startServer({ moviesDir: makeMovies(root), tmpRoot: path.join(root, 'tmp') })
  try {
    const id = s.server.encodeId('Plain (2020).mp4')
    const r = await s.call('/api/playback/negotiate', { method: 'POST', body: JSON.stringify({ kind: 'movie', id, client: 'chrome' }) })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.body.method, 'DirectPlay'); assert.match(r.body.url, /^\/file\?id=/); assert.equal(r.body.mimeType, 'video/mp4')
    assert.equal(r.body.plan.method, 'DirectPlay'); assert.equal(r.body.plan.summary, 'Direct play')
    const file = await fetch(s.base + r.body.url, { headers: { Range: 'bytes=0-99' } })
    assert.equal(file.status, 206)
    assert.equal((await file.arrayBuffer()).byteLength, 100)
    // a bad request, an unknown file
    assert.equal((await s.call('/api/playback/negotiate', { method: 'POST', body: JSON.stringify({ kind: 'movie' }) })).status, 400)
    assert.equal((await s.call('/api/playback/negotiate', { method: 'POST', body: JSON.stringify({ kind: 'movie', id: s.server.encodeId('Nope.mkv') }) })).status, 404)
    assert.equal((await fetch(s.base + '/api/playback/negotiate', { method: 'POST', body: '{}' })).status, 401)
  } finally { await stop(s, root) }
})

test('negotiate: DirectStream serves a master playlist, index, init segment and pieces that make a playable copy', { skip }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-ht-ds-'))
  const s = await startServer({ moviesDir: makeMovies(root), tmpRoot: path.join(root, 'tmp') })
  try {
    const id = s.server.encodeId('Remux (2021).mkv')
    // A film whose key frames have not been read yet answers "preparing" (503 + Retry-After) and the client asks again, exactly like the
    // waiting line of the live conversion. On a busy computer the first read can take a while, so ask up to a minute.
    let r
    for (let i = 0; i < 30; i++) {
      r = await s.call('/api/playback/negotiate', { method: 'POST', headers: { 'user-agent': APPLE_UA }, body: JSON.stringify({ kind: 'movie', id, waitMs: i === 0 ? 0 : 5000 }) })
      if (r.status !== 503) break
      assert.equal(r.body.error, 'preparing'); assert.equal(r.headers.get('retry-after'), '3'); assert.equal(r.body.plan.method, 'DirectStream')
    }
    assert.equal(r.status, 200, r.text)
    assert.equal(r.body.method, 'DirectStream'); assert.match(r.body.url, /^\/hls\/.+\/master\.m3u8$/); assert.equal(r.body.container, 'hls-fmp4')
    assert.equal(r.body.plan.video.tag, 'avc1'); assert.equal(r.body.plan.audio.action, 'copy')
    const master = await (await fetch(s.base + r.body.url)).text()
    assert.match(master, /#EXT-X-STREAM-INF:.*CODECS="avc1\.[0-9a-f]{6},ec-3".*VIDEO-RANGE=SDR/)
    const indexUrl = r.body.url.replace('master.m3u8', 'index.m3u8')
    const index = await (await fetch(s.base + indexUrl)).text()
    assert.match(index, /#EXT-X-MAP:URI="init\.mp4"/)
    const names = index.match(/^seg-\d+\.m4s$/gm)
    assert.ok(names.length >= 3)
    const init = Buffer.from(await (await fetch(s.base + indexUrl.replace('index.m3u8', 'init.mp4'))).arrayBuffer())
    assert.equal(init.toString('latin1', 4, 8), 'ftyp')
    const pieces = []
    for (const n of names) {
      const res = await fetch(s.base + indexUrl.replace('index.m3u8', n))
      assert.equal(res.status, 200); assert.equal(res.headers.get('content-type'), 'video/mp4')
      pieces.push(Buffer.from(await res.arrayBuffer()))
    }
    const joined = path.join(root, 'joined.mp4')
    fs.writeFileSync(joined, Buffer.concat([init, ...pieces]))
    const probe = JSON.parse(spawnSync(FFPROBE, ['-v', 'error', '-show_streams', '-of', 'json', joined], { encoding: 'utf8' }).stdout)
    assert.deepEqual(probe.streams.map((x) => x.codec_name), ['h264', 'eac3'])
    // bit-exact with the source (a copy)
    const md5 = (f, sel) => String(ff(['-i', f, '-map', sel, '-c', 'copy', '-f', 'md5', '-']).stdout).trim()
    const src = path.join(root, 'Movies', 'Remux (2021).mkv')
    assert.equal(md5(joined, '0:v:0'), md5(src, '0:v:0')); assert.equal(md5(joined, '0:a:0'), md5(src, '0:a:0'))
    // tickets cannot be forged or borrowed
    const fake = Buffer.from(JSON.stringify({ v: 1, k: 'movie', i: id, u: s.user.id, rx: { ac: 'copy', t: 'avc1' } })).toString('base64url') + '.9999999999999.AAAA'
    for (const f of ['master.m3u8', 'index.m3u8', 'init.mp4', 'seg-0.m4s']) { const x = await fetch(s.base + `/hls/${fake}/${f}`); assert.equal(x.status, 403, f); await x.arrayBuffer() }
    // the live conversion's tickets do not answer for fMP4 files
    const start = await s.call('/api/playback/start', { method: 'POST', body: JSON.stringify({ kind: 'movie', id, quality: '720p' }) })
    assert.equal(start.status, 200)
    const cross = await fetch(s.base + start.body.url.replace('index.m3u8', 'init.mp4'))
    assert.equal(cross.status, 404); await cross.arrayBuffer()
    // stopping closes the session
    assert.equal((await s.call('/api/playback/stop', { method: 'POST', body: JSON.stringify({ ticket: r.body.ticket }) })).status, 200)
  } finally { await stop(s, root) }
})

test('negotiate: Transcode (forced in Settings) starts the live conversion and says why; a per-person override wins', { skip }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-ht-tc-'))
  const s = await startServer({ moviesDir: makeMovies(root), tmpRoot: path.join(root, 'tmp') })
  try {
    const id = s.server.encodeId('Plain (2020).mp4')
    s.data.homeTheater = { forceTranscode: true }
    let r = await s.call('/api/playback/negotiate', { method: 'POST', body: JSON.stringify({ kind: 'movie', id, client: 'chrome' }) })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.body.method, 'Transcode'); assert.match(r.body.url, /index\.m3u8$/); assert.equal(r.body.container, 'hls-ts')
    assert.ok(r.body.plan.reasonCodes.includes('FORCED_TRANSCODE'))
    assert.ok(r.body.ticket, 'the live conversion returns its usual fields')
    // the person's own override turns it off just for them
    s.data.homeTheaterUsers = { [s.user.id]: { forceTranscode: false } }
    r = await s.call('/api/playback/negotiate', { method: 'POST', body: JSON.stringify({ kind: 'movie', id, client: 'chrome' }) })
    assert.equal(r.body.method, 'DirectPlay')
    // ... and the reverse
    s.data.homeTheater = { forceTranscode: false }
    s.data.homeTheaterUsers = { [s.user.id]: { forceTranscode: true } }
    r = await s.call('/api/playback/negotiate', { method: 'POST', body: JSON.stringify({ kind: 'movie', id, client: 'chrome' }) })
    assert.equal(r.body.method, 'Transcode')
    // a bitrate limit converts a big file
    s.data.homeTheaterUsers = {}
    s.data.homeTheater = { maxBitrateKbps: 10 }
    r = await s.call('/api/playback/negotiate', { method: 'POST', body: JSON.stringify({ kind: 'movie', id, client: 'chrome' }) })
    assert.equal(r.body.method, 'Transcode'); assert.ok(r.body.plan.reasonCodes.includes('BITRATE_EXCEEDS_LIMIT'))
    // direct stream switched off: an MKV is converted
    s.data.homeTheater = { allowDirectStream: false }
    r = await s.call('/api/playback/negotiate', { method: 'POST', body: JSON.stringify({ kind: 'movie', id: s.server.encodeId('Remux (2021).mkv'), client: 'chrome' }) })
    assert.equal(r.body.method, 'Transcode'); assert.ok(r.body.plan.reasonCodes.includes('DIRECT_STREAM_OFF'))
    // the device profile can arrive in the body as a declaration: this one plays nothing but H.264 in MP4 -> the MKV is converted
    s.data.homeTheater = {}
    r = await s.call('/api/playback/negotiate', { method: 'POST', body: JSON.stringify({ kind: 'movie', id: s.server.encodeId('Remux (2021).mkv'), deviceProfile: { client: 'chrome', containers: ['mp4'], streaming: ['hls-ts'] } }) })
    assert.equal(r.body.method, 'Transcode'); assert.ok(r.body.plan.reasonCodes.includes('NO_STREAMING_FORMAT'))
    assert.equal(r.body.plan.profileSource, 'declared+default:chrome')
  } finally { await stop(s, root) }
})
