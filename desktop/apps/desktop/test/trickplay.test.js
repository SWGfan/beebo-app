// Seek-bar preview thumbnails on a real server: auth, caching (one ffmpeg pass, not one per
// request), and (when ffmpeg is on this machine) real generated JPEGs from a tiny test clip.
// Run: node --test test/trickplay.test.js
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

async function startServer({ moviesDir, tmpRoot, extra = {} }) {
  const server = localRequire('./electron/streamServer')
  const auth = localRequire('./electron/auth')
  const data = {}
  const store = { get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] }, onDidChange: () => () => {} }
  const { user } = auth.createUser(store, 'Viewer', 'viewer@example.com')
  const port = testPort()
  const info = server.startStreamServer({
    port, store, getMoviesDir: () => moviesDir, getTvShowsDir: () => null,
    getAllMoviesDirs: () => [moviesDir], getAllTvShowsDirs: () => [], log: () => {},
    playback: { tmpRoot, ffmpegPath: () => FFMPEG, ffprobePath: () => FFPROBE, ...extra }
  })
  const base = 'http://127.0.0.1:' + info.port
  for (let i = 0; i < 50; i++) {
    try { await (await fetch(base + '/api/ping')).arrayBuffer(); break } catch { await new Promise((r) => setTimeout(r, 100)) }
  }
  const tokenFor = (u) => server.makeApiToken(store, u.id)
  const call = async (u, opts = {}) => {
    const res = await fetch(base + u, { ...opts, headers: { Authorization: 'Bearer ' + tokenFor(user), 'content-type': 'application/json', ...(opts.headers || {}) } })
    const text = await res.text()
    let body = null
    try { body = JSON.parse(text) } catch {}
    return { status: res.status, body, text, headers: res.headers }
  }
  return { server, info, base, store, user, call }
}

test('info: too short a file reports unavailable, never errors', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-tp-short-'))
  const moviesDir = path.join(root, 'Movies')
  fs.mkdirSync(moviesDir)
  fs.writeFileSync(path.join(moviesDir, 'Clip (2020).mkv'), 'not really a video')
  const s = await startServer({ moviesDir, tmpRoot: path.join(root, 'tmp') })
  try {
    const id = s.server.encodeId('Clip (2020).mkv')
    const r = await s.call(`/api/playback/trickplay/info?kind=movie&id=${encodeURIComponent(id)}`)
    assert.equal(r.status, 200, r.text)
    assert.equal(r.body.ok, true)
    assert.equal(r.body.available, false)
  } finally {
    await new Promise((r) => s.info.close(r))
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('auth: the thumbnail route needs a valid media token, the info route needs a login', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-tp-auth-'))
  const moviesDir = path.join(root, 'Movies')
  fs.mkdirSync(moviesDir)
  fs.writeFileSync(path.join(moviesDir, 'Clip (2020).mkv'), 'not really a video')
  const s = await startServer({ moviesDir, tmpRoot: path.join(root, 'tmp') })
  try {
    const id = s.server.encodeId('Clip (2020).mkv')
    let r = await fetch(s.base + `/api/playback/trickplay/info?kind=movie&id=${encodeURIComponent(id)}`)
    assert.equal(r.status, 401)
    await r.arrayBuffer()
    r = await fetch(s.base + `/trickplay/thumb?kind=movie&id=${encodeURIComponent(id)}&t=0`)
    assert.equal(r.status, 403, 'no media token at all')
    await r.arrayBuffer()
    const otherMt = s.server.makeMediaToken(s.store, s.server.encodeId('Other.mkv'))
    r = await fetch(s.base + `/trickplay/thumb?kind=movie&id=${encodeURIComponent(id)}&t=0&mt=${otherMt}`)
    assert.equal(r.status, 403, 'a token for a different file does not open this one')
    await r.arrayBuffer()
  } finally {
    await new Promise((r) => s.info.close(r))
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('real ffmpeg: one pass generates every frame, served by timestamp, cached (not regenerated)', { skip: !(FFMPEG && FFPROBE) ? 'ffmpeg/ffprobe not found' : false, timeout: 120000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-tp-real-'))
  const moviesDir = path.join(root, 'Movies')
  fs.mkdirSync(moviesDir)
  const clip = path.join(moviesDir, 'Clip (2020).mkv')
  // 35s so it clears MIN_DURATION_SEC (30) with room to spare.
  const enc = spawnSync(FFMPEG, ['-hide_banner', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=10:d=35',
    '-c:v', 'mpeg4', '-q:v', '5', clip], { encoding: 'utf8', windowsHide: true })
  assert.equal(enc.status, 0, enc.stderr)

  const s = await startServer({ moviesDir, tmpRoot: path.join(root, 'tmp') })
  try {
    const id = s.server.encodeId('Clip (2020).mkv')
    const qid = encodeURIComponent(id)

    // First call kicks the ffmpeg pass off but does not wait for it - info answers immediately.
    let info = await s.call(`/api/playback/trickplay/info?kind=movie&id=${qid}`)
    assert.equal(info.status, 200, info.text)
    assert.equal(info.body.ok, true)

    // Poll until the one background pass finishes (real ffmpeg on a 35s clip is quick, but not
    // instant - this is the same "don't block the request" behaviour a real scrub relies on).
    let ready = info.body
    for (let i = 0; i < 100 && !ready.available; i++) {
      await new Promise((r) => setTimeout(r, 200))
      const again = await s.call(`/api/playback/trickplay/info?kind=movie&id=${qid}`)
      ready = again.body
    }
    assert.equal(ready.available, true, 'generation did not finish in time')
    assert.equal(ready.intervalSec, 10)
    assert.equal(ready.count, 4) // t=0,10,20,30 for a 35s clip
    assert.match(ready.thumbUrl, /^\/trickplay\/thumb\?kind=movie&id=/)

    // A frame near the middle of the file, by media token (no login cookie needed for the image).
    const mt = ready.thumbUrl.match(/mt=([^&]+)/)[1]
    const jpg = await fetch(s.base + `/trickplay/thumb?kind=movie&id=${qid}&t=22&mt=${mt}`)
    assert.equal(jpg.status, 200)
    assert.equal(jpg.headers.get('content-type'), 'image/jpeg')
    const buf = Buffer.from(await jpg.arrayBuffer())
    assert.ok(buf.length > 200, 'a real, non-trivial JPEG')
    assert.equal(buf[0], 0xff)
    assert.equal(buf[1], 0xd8, 'JPEG SOI marker')

    // Past the end of the file: clamps to the last real frame rather than 404ing.
    const last = await fetch(s.base + `/trickplay/thumb?kind=movie&id=${qid}&t=99999&mt=${mt}`)
    assert.equal(last.status, 200)
    await last.arrayBuffer()

    // A second server against the SAME cache dir must not re-run ffmpeg: fake spawn that would
    // fail the test if it were ever called, proving the cached manifest/frames are reused.
    const s2 = await startServer({
      moviesDir, tmpRoot: path.join(root, 'tmp'),
      extra: { spawnFn: () => { throw new Error('ffmpeg should not run again - the set is already cached') } }
    })
    try {
      const info2 = await s2.call(`/api/playback/trickplay/info?kind=movie&id=${qid}`)
      assert.equal(info2.body.available, true)
      assert.equal(info2.body.count, 4)
    } finally {
      await new Promise((r) => s2.info.close(r))
    }
  } finally {
    await new Promise((r) => s.info.close(r))
    fs.rmSync(root, { recursive: true, force: true })
  }
})
