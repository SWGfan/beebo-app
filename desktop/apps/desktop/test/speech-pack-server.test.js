// The Speech Pack on a REAL stream server: the subtitle list every player uses labels "Name.<lang>.ai.srt"
// as "(AI-generated)", serves it as WebVTT, and the owner-only admin routes exist but are not open to
// anyone else. (The queue itself is covered in speech-pack-jobs.test.js.)
// Run: node --test test/speech-pack-server.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const F = require('./helpers/addonFixtures')
const { localRequire } = F

async function startServer(moviesDir, speechPack) {
  const server = localRequire('./electron/streamServer')
  const auth = localRequire('./electron/auth')
  const data = {}
  const store = { get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] }, onDidChange: () => () => {} }
  const { user } = auth.createUser(store, 'Viewer', 'viewer@example.com')
  const port = 47000 + Math.floor(Math.random() * 900) + 50
  const info = server.startStreamServer({
    port, store, getMoviesDir: () => moviesDir, getTvShowsDir: () => null,
    getAllMoviesDirs: () => [moviesDir], getAllTvShowsDirs: () => [], log: () => {},
    playback: { tmpRoot: path.join(moviesDir, '..', 'tmp') },
    speechPack
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

test('sidecar subtitle list: AI files are labelled "(AI-generated)" beside human ones, and serve as WebVTT', async () => {
  const root = F.tmpDir('beebo-spk-srv-')
  const moviesDir = path.join(root, 'Movies')
  fs.mkdirSync(moviesDir)
  fs.writeFileSync(path.join(moviesDir, 'Clip (2020).mkv'), 'not really a video')
  fs.writeFileSync(path.join(moviesDir, 'Clip (2020).en.srt'), '1\n00:00:01,000 --> 00:00:02,000\nHuman made\n')
  fs.writeFileSync(path.join(moviesDir, 'Clip (2020).en.ai.srt'), '1\n00:00:01,000 --> 00:00:02,500\nMachine made\n')
  fs.writeFileSync(path.join(moviesDir, 'Clip (2020).es.ai.srt'), '1\n00:00:01,000 --> 00:00:02,500\nHecho por IA\n')
  const { manager, srv } = await F.fakeSpeechManager()
  const s = await startServer(moviesDir, { manager })
  try {
    const id = s.server.encodeId('Clip (2020).mkv')
    const r = await s.call(`/api/subtitles?kind=movie&id=${encodeURIComponent(id)}`)
    assert.equal(r.status, 200, r.text)
    const labels = r.body.tracks.map((t) => t.label).sort()
    assert.deepEqual(labels, ['English', 'English (AI-generated)', 'Spanish (AI-generated)'])
    const aiEn = r.body.tracks.find((t) => t.label === 'English (AI-generated)')
    assert.equal(aiEn.lang, 'en')
    const vtt = await fetch(s.base + aiEn.url)
    assert.equal(vtt.status, 200)
    const text = await vtt.text()
    assert.match(text, /^WEBVTT/)
    assert.match(text, /Machine made/)
    assert.doesNotMatch(text, /Human made/, 'each track serves its own file')
    const human = r.body.tracks.find((t) => t.label === 'English')
    assert.match(await (await fetch(s.base + human.url)).text(), /Human made/)
  } finally { s.info.close(); await srv.close() }
})

test('the server exposes the Speech Pack; its owner-only admin routes reject anonymous and plain-http callers', async () => {
  const root = F.tmpDir('beebo-spk-srv2-')
  const moviesDir = path.join(root, 'Movies')
  fs.mkdirSync(moviesDir)
  const { manager, srv } = await F.fakeSpeechManager()
  const s = await startServer(moviesDir, { manager })
  try {
    assert.equal(typeof s.info.speechPack.api, 'function')
    assert.equal(typeof s.info.speechPack.queue.enqueue, 'function')
    // no login
    let r = await fetch(s.base + '/api/admin/ai-subtitles')
    assert.ok([401, 403].includes(r.status), String(r.status))
    // logged in as an ordinary viewer over plain http: the admin gates say no before the queue is ever reached
    r = await s.call('/api/admin/ai-subtitles')
    assert.equal(r.status, 403)
    r = await s.call('/api/admin/ai-subtitles/enqueue', { method: 'POST', body: JSON.stringify({ kind: 'movie', id: 'x' }) })
    assert.equal(r.status, 403)
    // the same handler, reached the way the owner reaches it, does the work
    const sp = s.info.speechPack
    let a = await sp.adminApi('GET', '', {})
    assert.equal(a.status, 200)
    assert.equal(a.body.installed, false)
    a = await sp.adminApi('POST', '/enqueue', { kind: 'movie', id: 'nope' })
    assert.equal(a.status, 400)
    assert.equal(a.body.error, 'not_installed')
    a = await sp.adminApi('POST', '/cancel', { id: 'nope' })
    assert.equal(a.status, 404)
    a = await sp.adminApi('DELETE', '', {})
    assert.equal(a.status, 405)
    assert.equal((await sp.api('nope', {})).error, 'unknown_call')
    assert.equal((await sp.api('constructor', {})).error, 'unknown_call', 'only the listed calls are reachable')
  } finally { s.info.close(); await srv.close() }
})
