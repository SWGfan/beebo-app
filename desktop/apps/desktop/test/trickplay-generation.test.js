// Seek-preview generation on a real server with real ffmpeg: the Settings switch, long-GOP files, and
// the background sweep that waits for the house to go quiet.
// Run: node --test test/trickplay-generation.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync, spawn } = require('node:child_process')
const { createRequire } = require('node:module')
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
const SKIP = !(FFMPEG && FFPROBE) ? 'ffmpeg/ffprobe not found' : false

async function startServer({ moviesDir, tmpRoot, extra = {} }) {
  const server = localRequire('./electron/streamServer')
  const auth = localRequire('./electron/auth')
  const data = {}
  const store = { get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] }, onDidChange: () => () => {} }
  const { user } = auth.createUser(store, 'Viewer', 'viewer@example.com')
  const port = 47600 + Math.floor(Math.random() * 90) + 5
  const info = server.startStreamServer({
    port, store, getMoviesDir: () => moviesDir, getTvShowsDir: () => null,
    getAllMoviesDirs: () => [moviesDir], getAllTvShowsDirs: () => [], log: process.env.TP_DEBUG ? console.log : () => {},
    playback: { tmpRoot, ffmpegPath: () => FFMPEG, ffprobePath: () => FFPROBE, ...extra }
  })
  const base = 'http://127.0.0.1:' + info.port
  for (let i = 0; i < 50; i++) {
    try { await (await fetch(base + '/api/ping')).arrayBuffer(); break } catch { await new Promise((r) => setTimeout(r, 100)) }
  }
  const call = async (u, opts = {}) => {
    const res = await fetch(base + u, { ...opts, headers: { Authorization: 'Bearer ' + server.makeApiToken(store, user.id), 'content-type': 'application/json', ...(opts.headers || {}) } })
    const text = await res.text()
    let body = null
    try { body = JSON.parse(text) } catch {}
    return { status: res.status, body, text }
  }
  return { server, info, base, store, call }
}

const waitFor = async (fn, ms = 45000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 100)) }
  return null
}
const makeClip = (file, seconds, extra = []) => {
  const enc = spawnSync(FFMPEG, ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=320x180:r=10:d=${seconds}`, ...extra, file], { encoding: 'utf8', windowsHide: true })
  assert.equal(enc.status, 0, enc.stderr)
}
const readSets = (tmpRoot) => {
  const dir = path.join(tmpRoot, 'trickplay')
  let names = []
  try { names = fs.readdirSync(dir) } catch {}
  return names.filter((n) => !n.endsWith('.part')).map((n) => ({ name: n, dir: path.join(dir, n), manifest: JSON.parse(fs.readFileSync(path.join(dir, n, 'manifest.json'), 'utf8')) }))
}
const closeAll = async (s, root) => {
  await new Promise((r) => s.info.close(r))
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }) } catch {}
}

test('switched off in Settings: nothing is generated and the answer says why', { skip: SKIP, timeout: 120000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-tp-off-'))
  const moviesDir = path.join(root, 'Movies')
  fs.mkdirSync(moviesDir)
  makeClip(path.join(moviesDir, 'Clip (2020).mkv'), 35, ['-c:v', 'mpeg4', '-q:v', '5'])
  let spawned = 0
  const s = await startServer({ moviesDir, tmpRoot: path.join(root, 'tmp'), extra: { spawnFn: (...a) => { spawned++; return spawn(...a) } } })
  try {
    s.store.set('trickplayEnabled', false)
    const qid = encodeURIComponent(s.server.encodeId('Clip (2020).mkv'))
    const r = await s.call(`/api/playback/trickplay/info?kind=movie&id=${qid}`)
    assert.equal(r.status, 200, r.text)
    assert.equal(r.body.available, false)
    assert.equal(r.body.disabled, true)
    await new Promise((res) => setTimeout(res, 500))
    assert.deepEqual(readSets(path.join(root, 'tmp')), [])
    assert.equal(spawned, 0)
    // Absent setting means ON: the next look starts a pass.
    s.store.delete('trickplayEnabled')
    const again = await s.call(`/api/playback/trickplay/info?kind=movie&id=${qid}`)
    assert.equal(again.body.generating, true)
    assert.ok(await waitFor(() => readSets(path.join(root, 'tmp')).length === 1))
  } finally {
    await closeAll(s, root)
  }
})

test('a long-GOP file (one key frame every 60 s) still gets a picture per interval, incl. the tail', { skip: SKIP, timeout: 90000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-tp-gop-'))
  const moviesDir = path.join(root, 'Movies')
  fs.mkdirSync(moviesDir)
  const clip = path.join(moviesDir, 'Long (2020).mp4')
  const enc = spawnSync(FFMPEG, ['-hide_banner', '-encoders'], { encoding: 'utf8', windowsHide: true })
  if (!/libx264/.test(enc.stdout)) { t.skip('no libx264 in this ffmpeg'); fs.rmSync(root, { recursive: true, force: true }); return }
  makeClip(clip, 125, ['-c:v', 'libx264', '-preset', 'ultrafast', '-g', '600', '-keyint_min', '600', '-sc_threshold', '0', '-pix_fmt', 'yuv420p'])
  const tmpRoot = path.join(root, 'tmp')
  const s = await startServer({ moviesDir, tmpRoot })
  try {
    const qid = encodeURIComponent(s.server.encodeId('Long (2020).mp4'))
    await s.call(`/api/playback/trickplay/info?kind=movie&id=${qid}`)
    const sets = await waitFor(() => { const x = readSets(tmpRoot); return x.length ? x : null })
    assert.ok(sets, 'generation did not finish')
    const m = sets[0].manifest
    assert.equal(m.count, 13, 't=0..120 every 10 s')
    assert.equal(m.keyframesOnly, true, 'the cheap pass was good enough')
    assert.ok(fs.readdirSync(sets[0].dir).filter((n) => n.endsWith('.jpg')).length >= 13, 'every frame the manifest promises exists on disk')
    assert.ok(m.bytes > 0)
    const info = await s.call(`/api/playback/trickplay/info?kind=movie&id=${qid}`)
    const mt = info.body.thumbUrl.match(/mt=([^&]+)/)[1]
    for (const at of [0, 65, 120, 5000]) {
      const jpg = await fetch(s.base + `/trickplay/thumb?kind=movie&id=${qid}&t=${at}&mt=${mt}`)
      assert.equal(jpg.status, 200, `t=${at}`)
      assert.equal(Buffer.from(await jpg.arrayBuffer())[0], 0xff)
    }
  } finally {
    await closeAll(s, root)
  }
})

test('background sweep: makes previews for films nobody asked for, but only while the house is quiet', { skip: SKIP, timeout: 90000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-tp-sweep-'))
  const moviesDir = path.join(root, 'Movies')
  fs.mkdirSync(moviesDir)
  makeClip(path.join(moviesDir, 'Sweep One (2020).mkv'), 35, ['-c:v', 'mpeg4', '-q:v', '5'])
  makeClip(path.join(moviesDir, 'Sweep Two (2021).mkv'), 40, ['-c:v', 'mpeg4', '-q:v', '5'])
  const tmpRoot = path.join(root, 'tmp')
  let busy = true
  const s = await startServer({
    moviesDir, tmpRoot,
    extra: {
      trickplayOptions: { pollMs: 50, pauseBetweenMs: 0 },
      trickplaySweep: { startDelayMs: 100, intervalMs: 3600000, isBusy: () => busy }
    }
  })
  try {
    await new Promise((res) => setTimeout(res, 1500))
    assert.deepEqual(readSets(tmpRoot), [], 'held back while somebody is watching')
    busy = false
    const sets = await waitFor(() => { const x = readSets(tmpRoot); return x.length === 2 ? x : null }, 30000)
    assert.ok(sets, 'both films got previews once the house went quiet')
    for (const x of sets) assert.ok(x.manifest.identity && x.manifest.identity.includes('Sweep'), 'the manifest names the file it belongs to')
    const skips = s.store.get('trickplaySkips')
    assert.ok(!skips || Object.keys(skips).length === 0, 'nothing failed')
  } finally {
    await closeAll(s, root)
  }
})
