// /api/collections and /api/collections/<id>: the phone's franchise views.
// A real server on a spare port over a fixture library and a fixture TMDB
// cache (manifest.json + collections.json). No TMDB key, so no network.
// Run: node --test test/collections-api.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))
const collections = localRequire('./electron/collections')

const ALIEN = {
  id: 8091,
  name: 'Alien Collection',
  parts: [
    { id: 679, title: 'Aliens', release_date: '1986-07-18', poster_path: '/aliens.jpg' },
    { id: 999999, title: 'Untitled Alien Sequel', release_date: null, poster_path: null },
    { id: 348, title: 'Alien', release_date: '1979-05-25', poster_path: '/alien.jpg' },
    { id: 8077, title: 'Alien³', release_date: '1992-05-22', poster_path: '/alien3.jpg' }
  ]
}
const TOY = {
  id: 10194,
  name: 'Toy Story',
  parts: [
    { id: 863, title: 'Toy Story 2', release_date: '1999-11-24', poster_path: '/ts2.jpg' },
    { id: 862, title: 'Toy Story', release_date: '1995-11-22', poster_path: '/ts1.jpg' }
  ]
}

test('groupFranchises: release order, owned counts, nothing-owned left out, sorted by name', () => {
  const byMovie = { 348: ALIEN, 679: ALIEN, 862: TOY, 949: null }
  const out = collections.groupFranchises(['862', 348, '679', '949', '5'], (id) => byMovie[id])
  assert.deepEqual(out.map((f) => f.name), ['Alien Collection', 'Toy Story'])
  assert.deepEqual(out[0].parts.map((p) => p.id), [348, 679, 8077, 999999], 'oldest first, undated last')
  assert.equal(out[0].ownedCount, 2)
  assert.equal(out[1].ownedCount, 1)
  // A franchise known only through a film that isn't owned is not listed.
  assert.deepEqual(collections.groupFranchises(['1'], () => TOY), [])
  // The input collection is not reordered in place.
  assert.equal(ALIEN.parts[0].id, 679)
})

test('collectionDisplayName', () => {
  assert.equal(collections.collectionDisplayName('Alien Collection'), 'Alien Collection')
  assert.equal(collections.collectionDisplayName('Toy Story'), 'Toy Story Collection')
  assert.equal(collections.collectionDisplayName(''), 'Collection')
})

test('the collections endpoints over a fixture library', async () => {
  const server = localRequire('./electron/streamServer')
  const auth = localRequire('./electron/auth')
  const savedKey = process.env.TMDB_API_KEY
  delete process.env.TMDB_API_KEY
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'beebo-col-test-'))
  const moviesDir = path.join(root, 'Movies')
  const cacheDir = path.join(root, 'tmdb')
  let info
  try {
    await fs.mkdir(moviesDir, { recursive: true })
    await fs.mkdir(path.join(cacheDir, 'posters'), { recursive: true })
    for (const f of ['Alien (1979).mp4', 'Aliens (1986).mkv', 'Heat (1995).mp4', 'Toy Story (1995).mp4']) {
      await fs.writeFile(path.join(moviesDir, f), 'x')
    }
    // Only Alien has a poster cached on disk.
    await fs.writeFile(path.join(cacheDir, 'posters', '348.jpg'), 'jpg')
    await fs.writeFile(path.join(cacheDir, 'manifest.json'), JSON.stringify({
      'Alien (1979).mp4': { id: 348, title: 'Alien', release_date: '1979-05-25', poster_path: '/alien.jpg', genre_ids: [27] },
      'Aliens (1986).mkv': { id: 679, title: 'Aliens', release_date: '1986-07-18', poster_path: '/aliens.jpg', genre_ids: [28] },
      'Heat (1995).mp4': { id: 949, title: 'Heat', release_date: '1995-12-15', poster_path: '/heat.jpg', genre_ids: [80] },
      'Toy Story (1995).mp4': { id: 862, title: 'Toy Story', release_date: '1995-11-22', poster_path: '/ts1.jpg', genre_ids: [16] }
    }))
    await fs.writeFile(path.join(cacheDir, 'collections.json'), JSON.stringify({ 348: ALIEN, 679: ALIEN, 949: null, 862: TOY }))

    const data = {}
    const store = { get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] }, onDidChange: () => () => {} }
    const { user } = auth.createUser(store, 'Viewer', 'viewer@example.com')
    const token = server.makeApiToken(store, user.id)

    const port = 47000 + Math.floor(Math.random() * 900) + 50
    info = server.startStreamServer({
      port, store, getMoviesDir: () => moviesDir, getTvShowsDir: () => null,
      getAllMoviesDirs: () => [moviesDir], getAllTvShowsDirs: () => [],
      getTmdbCacheDir: () => cacheDir, log: () => {}
    })
    const base = 'http://127.0.0.1:' + info.port
    for (let i = 0; i < 50; i++) {
      try { await (await fetch(base + '/api/ping')).arrayBuffer(); break } catch { await new Promise((r) => setTimeout(r, 100)) }
    }
    const call = async (u, opts = {}) => {
      const res = await fetch(base + u, { ...opts, headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json', ...(opts.headers || {}) } })
      return { status: res.status, body: await res.json() }
    }

    let r = await fetch(base + '/api/collections')
    assert.equal(r.status, 401, 'signed-in only')
    await r.arrayBuffer()

    r = await call('/api/collections')
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    assert.equal(r.body.unchecked, 0)
    assert.equal(r.body.refreshing, false, 'no key, no background lookups')
    assert.deepEqual(r.body.items.map((c) => c.id), [8091, 10194])
    const alien = r.body.items[0]
    assert.equal(alien.name, 'Alien Collection')
    assert.equal(alien.displayName, 'Alien Collection')
    assert.equal(alien.ownedCount, 2)
    assert.equal(alien.total, 4)
    assert.equal(alien.complete, false)
    assert.equal(alien.poster, '/media/poster/348.jpg', 'cover art is the first owned film, from the local cache')
    assert.equal(alien.firstYear, 1979)
    assert.equal(alien.lastYear, 1992)
    const toy = r.body.items[1]
    assert.equal(toy.displayName, 'Toy Story Collection')
    assert.equal(toy.poster, null, 'never a TMDB URL in poster')
    assert.equal(toy.tmdbPoster, 'https://image.tmdb.org/t/p/w300/ts1.jpg')

    // Same answer again (from the memo).
    const again = await call('/api/collections')
    assert.deepEqual(again.body, r.body)

    r = await call('/api/collections/8091')
    assert.equal(r.status, 200)
    const col = r.body.collection
    assert.equal(col.name, 'Alien Collection')
    assert.equal(col.ownedCount, 2)
    assert.equal(col.total, 4)
    assert.deepEqual(col.parts.map((p) => p.tmdbId), [348, 679, 8077, 999999], 'release order')
    assert.deepEqual(col.parts.map((p) => p.owned), [true, true, false, false])
    assert.deepEqual(col.parts.map((p) => p.year), [1979, 1986, 1992, null])
    const owned = col.parts[0].movie
    assert.equal(owned.title, 'Alien')
    assert.equal(owned.id, server.encodeId('Alien (1979).mp4'))
    assert.match(owned.stream, /^\/file\?id=/)
    assert.equal(owned.collectionId, 8091)
    assert.equal(col.parts[2].movie, null)
    assert.equal(col.parts[2].poster, null)
    assert.equal(col.parts[2].tmdbPoster, 'https://image.tmdb.org/t/p/w300/alien3.jpg')
    assert.equal(col.parts[2].request, null)

    // The badge on /api/movies still comes through after the item builder was shared.
    r = await call('/api/movies')
    const alienRow = r.body.items.find((m) => m.title === 'Alien')
    assert.equal(alienRow.collectionId, 8091)
    assert.equal(alienRow.collectionName, 'Alien Collection')
    assert.equal(r.body.items.find((m) => m.title === 'Heat').collectionId, null)

    // A missing part someone has asked for shows the request.
    r = await call('/api/title-requests', { method: 'POST', body: JSON.stringify({ kind: 'movie', tmdbId: 8077, title: 'Alien³', year: 1992 }) })
    assert.equal(r.status, 200)
    r = await call('/api/collections/8091')
    assert.deepEqual(r.body.collection.parts[2].request, { id: r.body.collection.parts[2].request.id, status: 'requested', mine: true })

    r = await call('/api/collections/424242')
    assert.equal(r.status, 404)
    r = await call('/api/collections/abc')
    assert.equal(r.status, 400)
  } finally {
    if (savedKey !== undefined) process.env.TMDB_API_KEY = savedKey
    if (info) await new Promise((r) => info.close(r))
    await fs.rm(root, { recursive: true, force: true })
  }
})
