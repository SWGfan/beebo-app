// Several files of one film on a real server: one entry per film in the lists, `versions` on the
// phone list and /playback/info, the remembered per-user choice, and progress shared by the files.
// Run: node --test test/movie-versions-api.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))

async function startServer(moviesDir, tmpRoot) {
  const server = localRequire('./electron/streamServer')
  const auth = localRequire('./electron/auth')
  const data = {}
  const store = { get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] }, onDidChange: () => () => {} }
  const { user } = auth.createUser(store, 'Viewer', 'viewer@example.com')
  const { user: other } = auth.createUser(store, 'Other', 'other@example.com')
  const port = 47000 + Math.floor(Math.random() * 900) + 50
  const info = server.startStreamServer({
    port, store, getMoviesDir: () => moviesDir, getTvShowsDir: () => null,
    getAllMoviesDirs: () => [moviesDir], getAllTvShowsDirs: () => [], log: () => {},
    playback: { tmpRoot, ffmpegPath: () => null, ffprobePath: () => null }
  })
  const base = 'http://127.0.0.1:' + info.port
  for (let i = 0; i < 50; i++) {
    try { await (await fetch(base + '/api/ping')).arrayBuffer(); break } catch { await new Promise((r) => setTimeout(r, 100)) }
  }
  const call = async (u, opts = {}, who = user) => {
    const res = await fetch(base + u, { ...opts, headers: { Authorization: 'Bearer ' + server.makeApiToken(store, who.id), 'content-type': 'application/json', ...(opts.headers || {}) } })
    const text = await res.text()
    let body = null
    try { body = JSON.parse(text) } catch {}
    return { status: res.status, body }
  }
  return { server, info, base, store, data, user, other, call }
}

test('one entry per film, versions on the list and /playback/info, remembered choice, shared progress', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-versions-'))
  const moviesDir = path.join(root, 'Movies')
  fs.mkdirSync(moviesDir)
  fs.writeFileSync(path.join(moviesDir, 'Inception (2010) 2160p HDR.mkv'), Buffer.alloc(4000))
  fs.writeFileSync(path.join(moviesDir, 'Inception (2010) 1080p.mkv'), Buffer.alloc(2000))
  fs.writeFileSync(path.join(moviesDir, "Inception (2010) - Director's Cut.mkv"), Buffer.alloc(3000))
  fs.writeFileSync(path.join(moviesDir, 'Other Film (2011).mkv'), Buffer.alloc(500))
  const s = await startServer(moviesDir, path.join(root, 'tmp'))
  try {
    const enc = s.server.encodeId
    const id4k = enc('Inception (2010) 2160p HDR.mkv')
    const id1080 = enc('Inception (2010) 1080p.mkv')
    const idDc = enc("Inception (2010) - Director's Cut.mkv")

    // The list: two films, not four files. The primary keeps its id; old clients ignore `versions`.
    const list = (await s.call('/api/movies')).body
    assert.equal(list.items.length, 2)
    const film = list.items.find((i) => /Inception/.test(i.title))
    assert.equal(film.id, id1080, 'the phone-friendly 1080p file is the primary')
    assert.equal(film.versions.length, 3)
    assert.deepEqual(film.versions.map((v) => v.id).sort(), [id4k, id1080, idDc].sort())
    const v4k = film.versions.find((v) => v.id === id4k)
    assert.equal(v4k.label, 'Standard · 4K HDR')
    assert.equal(film.versions.find((v) => v.id === idDc).label, "Director's Cut")
    assert.equal(v4k.height, 2160)
    assert.equal(v4k.hdr, 'HDR')
    assert.equal(v4k.sizeBytes, 4000)
    assert.equal(film.versions.filter((v) => v.isDefault).length, 1)
    assert.equal(film.versions.find((v) => v.isDefault).id, id1080)
    assert.equal(list.items.find((i) => /Other/.test(i.title)).versions, undefined, 'a lone file has no versions field')

    // /playback/info from ANY version's id lists the group and marks the current one.
    let info = (await s.call(`/api/playback/info?kind=movie&id=${encodeURIComponent(id4k)}`)).body
    assert.equal(info.ok, true)
    assert.equal(info.versions.length, 3)
    assert.deepEqual(info.versions.filter((v) => v.isCurrent).map((v) => v.id), [id4k])
    assert.ok(info.versions.every((v) => ['id', 'label', 'height', 'hdr', 'edition', 'sizeBytes', 'isDefault', 'isCurrent'].every((k) => k in v)))
    assert.equal(info.preferredVersionId, id4k, 'nothing probed (no ffprobe): the tallest is taken, no cap')
    const lone = (await s.call(`/api/playback/info?kind=movie&id=${encodeURIComponent(enc('Other Film (2011).mkv'))}`)).body
    assert.equal(lone.versions, undefined)
    assert.equal(lone.preferredVersionId, undefined)

    // A quality preference is respected when the user has not chosen.
    await s.call('/api/playback/prefs', { method: 'POST', body: JSON.stringify({ quality: '1080p' }) })
    info = (await s.call(`/api/playback/info?kind=movie&id=${encodeURIComponent(id4k)}`)).body
    assert.equal(info.preferredVersionId, id1080)

    // The choice is remembered per user, through any version's id.
    let r = await s.call('/api/playback/version', { method: 'POST', body: JSON.stringify({ id: id1080, versionId: idDc }) })
    assert.equal(r.status, 200)
    assert.equal(r.body.preferredVersionId, idDc)
    info = (await s.call(`/api/playback/info?kind=movie&id=${encodeURIComponent(id1080)}`)).body
    assert.equal(info.preferredVersionId, idDc)
    assert.deepEqual(info.versions.filter((v) => v.isCurrent).map((v) => v.id), [id1080])
    const others = (await s.call(`/api/playback/info?kind=movie&id=${encodeURIComponent(id1080)}`, {}, s.other)).body
    assert.notEqual(others.preferredVersionId, idDc, 'another user is unaffected')
    assert.ok(Object.keys(s.data.movieVersionChoices[s.user.id]).length === 1)
    r = await s.call('/api/playback/version', { method: 'POST', body: JSON.stringify({ id: id1080, versionId: enc('Nope.mkv') }) })
    assert.equal(r.status, 404)
    assert.equal((await s.call('/api/playback/version', { method: 'POST', body: JSON.stringify({ id: enc('Other Film (2011).mkv'), versionId: '' }) })).status, 404, 'a lone film has no versions to choose from')
    r = await s.call('/api/playback/version', { method: 'POST', body: '{}' })
    assert.equal(r.status, 400)
    r = await s.call('/api/playback/version', { method: 'POST', body: JSON.stringify({ id: id1080, versionId: '' }) })
    assert.equal(r.status, 200)
    info = (await s.call(`/api/playback/info?kind=movie&id=${encodeURIComponent(id1080)}`)).body
    assert.equal(info.preferredVersionId, id1080, 'forgotten: back to the default under the 1080p preference')

    // Every version's id resolves on the per-file routes.
    for (const id of [id4k, id1080, idDc]) {
      assert.equal((await s.call(`/api/playback/info?kind=movie&id=${encodeURIComponent(id)}`)).status, 200)
    }

    // Progress is one thing per film: part-watched in the 4K file, offered to resume from the 1080p id.
    const sess = (await s.call('/api/watch-session', { method: 'POST', body: JSON.stringify({ kind: 'movie', id: id4k }) })).body
    assert.equal(sess.ok, true)
    await s.call('/api/progress', { method: 'POST', body: JSON.stringify({ sessionId: sess.sessionId, currentTime: 900, duration: 6000 }) })
    const cont = (await s.call('/api/continue')).body.items
    assert.equal(cont.length, 1)
    const history = localRequire('./electron/history')
    assert.equal(history.resumeFor(s.store, s.user.id, 'Inception (2010) 1080p.mkv').currentTime, 900, 'resume follows the film, not the file')
    assert.equal(history.resumeFor(s.store, s.user.id, 'Other Film (2011).mkv'), null)

    // Marking one version watched marks the film; unmarking clears them all.
    r = await s.call('/api/watched/movie', { method: 'POST', body: JSON.stringify({ id: id1080, watched: true }) })
    assert.equal(r.status, 200)
    for (const id of [id4k, id1080, idDc]) {
      assert.equal((await s.call('/api/library-status?kind=movie&id=' + id)).body.watched, true)
    }
    assert.equal((await s.call('/api/library-status?kind=movie&id=' + enc('Other Film (2011).mkv'))).body.watched, false)
    assert.equal((await s.call('/api/continue')).body.items.length, 0, 'watched leaves Continue Watching')
    await s.call('/api/watched/movie', { method: 'POST', body: JSON.stringify({ id: idDc, watched: false }) })
    for (const id of [id4k, id1080, idDc]) {
      assert.equal((await s.call('/api/library-status?kind=movie&id=' + id)).body.watched, false)
    }
  } finally {
    await new Promise((r) => s.info.close(r))
    fs.rmSync(root, { recursive: true, force: true })
  }
})
