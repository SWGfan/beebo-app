// Sing-along recordings on the Music page: who may save, list, play and delete which
// recording (only their own), the size and type limits, and removal with the account.
// Run: node --test test/music-recordings.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { Readable } = require('node:stream')
const { createRequire } = require('node:module')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))
const recordingsLib = localRequire('./electron/musicRecordings')

function memoryStore() {
  const data = {}
  return { get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] }, onDidChange: () => () => {} }
}

const mkTmp = () => fsp.mkdtemp(path.join(os.tmpdir(), 'beebo-recs-'))
const countFiles = (dir) => {
  let n = 0
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name))
      else n++
    }
  }
  try { walk(dir) } catch {}
  return n
}

test('parseRecordingMime: only the types a browser recorder makes, parameters ignored', () => {
  assert.deepEqual(recordingsLib.parseRecordingMime('audio/webm;codecs=opus'), { mime: 'audio/webm', ext: 'webm', kind: 'audio' })
  assert.deepEqual(recordingsLib.parseRecordingMime('VIDEO/WEBM; codecs=vp8,opus'), { mime: 'video/webm', ext: 'webm', kind: 'video' })
  assert.deepEqual(recordingsLib.parseRecordingMime('audio/mp4'), { mime: 'audio/mp4', ext: 'm4a', kind: 'audio' })
  assert.deepEqual(recordingsLib.parseRecordingMime('video/mp4'), { mime: 'video/mp4', ext: 'mp4', kind: 'video' })
  for (const bad of ['', null, undefined, 'text/html', 'application/octet-stream', 'audio/x-wav', 'video/x-matroska', 'audio/../webm']) {
    assert.equal(recordingsLib.parseRecordingMime(bad), null, String(bad))
  }
})

test('recordings store: save, list, find, remove, per person, with limits', async () => {
  const dir = await mkTmp()
  try {
    const store = memoryStore()
    const recs = recordingsLib.createRecordings({ store, dir, maxBytes: 100 })
    const bytes = Buffer.from('a'.repeat(60))
    const a = await recs.save('user-a', Readable.from([bytes]), { type: 'audio/webm;codecs=opus', trackId: 't1', trackTitle: 'Song', trackArtist: 'Band', mixed: true, durationMs: '4200' })
    assert.equal(a.kind, 'audio')
    assert.equal(a.size, 60)
    assert.equal(a.mixed, true)
    assert.equal(a.durationMs, 4200)
    assert.equal(a.trackTitle, 'Song')
    assert.ok(!('path' in a) && !('ext' in a), 'no file details leak')
    assert.match(a.id, /^[a-f0-9]{20}$/)

    assert.deepEqual(recs.list('user-a').map((r) => r.id), [a.id])
    assert.deepEqual(recs.list('user-b'), [])
    assert.equal(recs.find('user-b', a.id), null, 'someone else\'s id is just not found')
    assert.equal(recs.find('user-a', '../../etc/passwd'), null)
    assert.equal(recs.find('user-a', a.id.toUpperCase()), null)
    const hit = recs.find('user-a', a.id)
    assert.ok(hit.path.startsWith(dir))
    assert.ok(fs.readFileSync(hit.path).equals(bytes))

    await assert.rejects(recs.save('user-a', Readable.from([Buffer.alloc(101)]), { type: 'audio/webm' }), { code: 'too_large', status: 413 })
    await assert.rejects(recs.save('user-a', Readable.from([Buffer.alloc(0)]), { type: 'audio/webm' }), { code: 'empty', status: 400 })
    await assert.rejects(recs.save('user-a', Readable.from([bytes]), { type: 'text/html' }), { code: 'unsupported_type', status: 415 })
    await assert.rejects(recs.save('', Readable.from([bytes]), { type: 'audio/webm' }), { status: 401 })
    assert.equal(countFiles(dir), 1, 'refused uploads leave nothing behind, not even a partial file')
    assert.equal(recs.list('user-a').length, 1)

    assert.equal(await recs.remove('user-b', a.id), false, 'not theirs')
    assert.equal(recs.list('user-a').length, 1)
    assert.equal(await recs.remove('user-a', a.id), true)
    assert.equal(await recs.remove('user-a', a.id), false)
    assert.equal(countFiles(dir), 0)
    assert.equal(store.get('musicRecordings')['user-a'], undefined, 'no empty rows kept')

    // A restored backup carries rows but not the files: those rows are not listed.
    const b = await recs.save('user-b', Readable.from([bytes]), { type: 'video/webm' })
    fs.rmSync(recs.find('user-b', b.id).path)
    assert.deepEqual(recs.list('user-b'), [])
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('removeUserData drops the rows and the files of that person only', async () => {
  const dir = await mkTmp()
  try {
    const store = memoryStore()
    const recs = recordingsLib.createRecordings({ store, dir })
    await recs.save('user-a', Readable.from([Buffer.from('one')]), { type: 'audio/webm' })
    await recs.save('user-a', Readable.from([Buffer.from('two')]), { type: 'audio/webm' })
    const keep = await recs.save('user-b', Readable.from([Buffer.from('three')]), { type: 'audio/webm' })
    recordingsLib.removeUserData(store, 'user-a', dir)
    assert.deepEqual(recs.list('user-a'), [])
    assert.equal(countFiles(dir), 1)
    assert.deepEqual(recs.list('user-b').map((r) => r.id), [keep.id])
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('/api/music/recordings and the page\'s /music-api/recordings: everything is scoped to the signed-in person', async () => {
  const server = localRequire('./electron/streamServer')
  const auth = localRequire('./electron/auth')
  const userDeletion = localRequire('./electron/userDeletion')
  const dir = await mkTmp()
  const store = memoryStore()
  const alice = auth.createUser(store, 'Alice', 'a@example.com').user
  const bob = auth.createUser(store, 'Bob', 'b@example.com').user
  const tokenA = server.makeApiToken(store, alice.id)
  const tokenB = server.makeApiToken(store, bob.id)
  const cookieA = 'beebo_session=' + auth.signSession(store, alice.id)
  const cookieB = 'beebo_session=' + auth.signSession(store, bob.id)
  const port = 47000 + Math.floor(Math.random() * 900) + 50
  const info = server.startStreamServer({ port, store, getMoviesDir: () => null, getTvShowsDir: () => null, getAllMoviesDirs: () => [], getAllTvShowsDirs: () => [], getTmdbCacheDir: () => null, log: () => {}, musicRecordingsDir: dir })
  try {
    const base = 'http://127.0.0.1:' + info.port
    for (let i = 0; i < 50; i++) {
      try { await (await fetch(base + '/api/ping')).arrayBuffer(); break } catch { await new Promise((r) => setTimeout(r, 100)) }
    }
    const call = async (method, u, { token, cookie, type, body, headers } = {}) => {
      const h = { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(type ? { 'Content-Type': type } : {}), ...headers }
      const res = await fetch(base + u, { method, redirect: 'manual', headers: h, body })
      const buf = Buffer.from(await res.arrayBuffer())
      let json = null
      try { json = JSON.parse(buf.toString('utf8')) } catch {}
      return { status: res.status, headers: res.headers, buf, json }
    }
    const sample = Buffer.from('EBML-pretend-webm-bytes-'.repeat(50))

    // Signed in only.
    assert.equal((await call('GET', '/api/music/recordings')).status, 401)
    assert.equal((await call('POST', '/api/music/recordings', { type: 'audio/webm', body: sample })).status, 401)
    assert.equal((await call('GET', '/api/music/recordings/' + 'a'.repeat(20) + '/file')).status, 401)
    assert.equal((await call('DELETE', '/api/music/recordings/' + 'a'.repeat(20))).status, 401)
    assert.equal((await call('GET', '/api/music/recordings', { token: 'someone.123.forged' })).status, 401)
    assert.equal((await call('GET', '/music-api/recordings')).status, 302, 'the page route sends a visitor to sign in')

    // Only the browser recorder's types.
    assert.equal((await call('POST', '/api/music/recordings', { token: tokenA, type: 'text/html', body: '<script>x</script>' })).status, 415)
    assert.equal((await call('POST', '/api/music/recordings', { token: tokenA, type: 'application/octet-stream', body: sample })).status, 415)
    assert.equal((await call('POST', '/api/music/recordings', { token: tokenA, type: 'audio/webm', body: Buffer.alloc(0) })).status, 400)

    // Alice saves one.
    let r = await call('POST', '/api/music/recordings?trackId=nope&mixed=1&durationMs=1234', { token: tokenA, type: 'audio/webm;codecs=opus', body: sample })
    assert.equal(r.status, 201)
    assert.equal(r.json.recording.kind, 'audio')
    assert.equal(r.json.recording.size, sample.length)
    assert.equal(r.json.recording.trackId, null, 'an unknown song id is not stored')
    assert.equal(r.json.recording.mixed, true)
    assert.equal(r.json.recording.durationMs, 1234)
    const recA = r.json.recording.id

    // Bob saves a video one, through the page's cookie route.
    r = await call('POST', '/music-api/recordings', { cookie: cookieB, type: 'video/webm', body: sample, headers: { 'Sec-Fetch-Site': 'same-origin' } })
    assert.equal(r.status, 201)
    assert.equal(r.json.recording.kind, 'video')
    const recB = r.json.recording.id

    // Each sees only their own.
    r = await call('GET', '/api/music/recordings', { token: tokenA })
    assert.deepEqual(r.json.items.map((x) => x.id), [recA])
    r = await call('GET', '/api/music/recordings', { token: tokenB })
    assert.deepEqual(r.json.items.map((x) => x.id), [recB])
    r = await call('GET', '/music-api/recordings', { cookie: cookieA })
    assert.deepEqual(r.json.items.map((x) => x.id), [recA], 'the cookie route is the same list')
    assert.ok(!JSON.stringify(r.json).includes(dir.replace(/\\/g, '\\\\')), 'no folder names leak')

    // Playing: your own only, byte for byte, with ranges and a type we chose.
    r = await call('GET', `/api/music/recordings/${recA}/file`, { token: tokenA })
    assert.equal(r.status, 200)
    assert.equal(r.headers.get('content-type'), 'audio/webm')
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff')
    assert.ok(r.buf.equals(sample))
    r = await call('GET', `/api/music/recordings/${recA}/file`, { token: tokenA, headers: { Range: 'bytes=2-9' } })
    assert.equal(r.status, 206)
    assert.ok(r.buf.equals(sample.subarray(2, 10)))
    r = await call('GET', `/music-api/recordings/${recA}/file`, { cookie: cookieA })
    assert.equal(r.status, 200)
    assert.ok(r.buf.equals(sample))
    for (const [label, req] of [
      ['bearer', () => call('GET', `/api/music/recordings/${recA}/file`, { token: tokenB })],
      ['cookie', () => call('GET', `/music-api/recordings/${recA}/file`, { cookie: cookieB })]
    ]) {
      const out = await req()
      assert.equal(out.status, 404, `${label}: another person's recording is not found`)
      assert.ok(!out.buf.equals(sample))
    }
    assert.equal((await call('GET', `/api/music/recordings/${'0'.repeat(20)}/file`, { token: tokenA })).status, 404)
    for (const bad of ['..%2F..%2Fwindows%2Fwin.ini', '..%5C..%5Cwin.ini', '%00', recA + '.webm']) {
      assert.equal((await call('GET', `/api/music/recordings/${bad}/file`, { token: tokenA })).status, 404, bad)
    }

    // Deleting: not someone else's (and it does not even say it exists), then your own.
    assert.equal((await call('DELETE', `/api/music/recordings/${recA}`, { token: tokenB })).status, 404)
    assert.equal((await call('DELETE', `/music-api/recordings/${recA}`, { cookie: cookieB })).status, 404)
    assert.equal((await call('GET', '/api/music/recordings', { token: tokenA })).json.items.length, 1, 'still there')
    assert.equal(countFiles(dir), 2)
    assert.equal((await call('POST', `/api/music/recordings/${recA}`, { token: tokenA })).status, 405)

    // A request another site started with the cookie may not change anything.
    r = await call('DELETE', `/music-api/recordings/${recA}`, { cookie: cookieA, headers: { 'Sec-Fetch-Site': 'cross-site' } })
    assert.equal(r.status, 403)
    r = await call('POST', '/music-api/recordings', { cookie: cookieA, type: 'audio/webm', body: sample, headers: { Origin: 'http://evil.example' } })
    assert.equal(r.status, 403)
    assert.equal((await call('GET', '/api/music/recordings', { token: tokenA })).json.items.length, 1)

    r = await call('DELETE', `/api/music/recordings/${recA}`, { token: tokenA })
    assert.equal(r.status, 200)
    assert.equal((await call('GET', `/api/music/recordings/${recA}/file`, { token: tokenA })).status, 404)
    assert.deepEqual((await call('GET', '/api/music/recordings', { token: tokenA })).json.items, [])
    assert.equal(countFiles(dir), 1, 'the file is gone from disk')
    assert.equal((await call('DELETE', `/music-api/recordings/${recB}`, { cookie: cookieB })).status, 200, 'the page can delete too')
    assert.equal(countFiles(dir), 0)

    // Removing an account takes its recordings with it.
    r = await call('POST', '/api/music/recordings', { token: tokenA, type: 'audio/mp4', body: sample })
    assert.equal(r.status, 201)
    assert.equal(countFiles(dir), 1)
    const out = userDeletion.purgeUserData(store, alice.id, { musicRecordingsDir: dir })
    assert.equal(out.removed, true)
    assert.equal(countFiles(dir), 0)
    assert.equal(store.get('musicRecordings')[alice.id], undefined)
  } finally {
    await new Promise((r) => info.close(r))
    await fsp.rm(dir, { recursive: true, force: true })
  }
})
