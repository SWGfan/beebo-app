// /api/playlists/* (phone, bearer token) and /playlists + /playlists/api/*
// (website, cookie session) on a real server over a fixture library.
// No TMDB key, so no network. Run: node --test test/playlists-api.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const { testPort } = require('./helpers/testPort')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))

test('playlists over HTTP: CRUD, per-user access, smart, play order, website twin, account deletion', async () => {
  const server = localRequire('./electron/streamServer')
  const auth = localRequire('./electron/auth')
  const userDeletion = localRequire('./electron/userDeletion')
  const savedKey = process.env.TMDB_API_KEY
  delete process.env.TMDB_API_KEY
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'beebo-pl-api-'))
  const moviesDir = path.join(root, 'Movies')
  const tvDir = path.join(root, 'TV')
  const cacheDir = path.join(root, 'tmdb')
  let info
  try {
    await fs.mkdir(moviesDir, { recursive: true })
    await fs.mkdir(path.join(tvDir, 'Test Show', 'Season 1'), { recursive: true })
    await fs.mkdir(cacheDir, { recursive: true })
    for (const f of ['Alpha (1994).mp4', 'Beta (2021).mp4', 'Gamma (1999).mp4']) await fs.writeFile(path.join(moviesDir, f), 'x')
    for (const e of ['Test Show S01E01.mp4', 'Test Show S01E02.mp4']) await fs.writeFile(path.join(tvDir, 'Test Show', 'Season 1', e), 'x')
    await fs.writeFile(path.join(cacheDir, 'manifest.json'), JSON.stringify({
      'Alpha (1994).mp4': { id: 1, title: 'Alpha', release_date: '1994-01-01', genre_ids: [28], certification: 'PG' },
      'Beta (2021).mp4': { id: 2, title: 'Beta', release_date: '2021-01-01', genre_ids: [35], certification: 'R' },
      'Gamma (1999).mp4': { id: 3, title: 'Gamma', release_date: '1999-01-01', genre_ids: [28], certification: 'R' }
    }))

    const data = {}
    const store = { get: (k) => data[k], set: (k, v) => { data[k] = JSON.parse(JSON.stringify(v)) }, delete: (k) => { delete data[k] }, onDidChange: () => () => {} }
    const owner = auth.createOwner(store, { username: 'nick', password: 'nick-owner-test-passphrase' })
    const ownerId = (owner.user || auth.getUsers(store).find((u) => u.isAdmin)).id
    const { user: kid } = auth.createUser(store, 'Kid', 'kid@example.com')
    const { user: other } = auth.createUser(store, 'Other', 'other@example.com')
    const tokOwner = server.makeApiToken(store, ownerId)
    const tokKid = server.makeApiToken(store, kid.id)
    const tokOther = server.makeApiToken(store, other.id)

    // The parental-controls seam: Kid never sees R-rated titles in a playlist.
    const playlistItemFilter = (viewer) => (viewer.id === kid.id ? (item) => item.certification !== 'R' : null)
    const port = testPort()
    info = server.startStreamServer({
      port, store, getMoviesDir: () => moviesDir, getTvShowsDir: () => tvDir,
      getAllMoviesDirs: () => [moviesDir], getAllTvShowsDirs: () => [tvDir],
      getTmdbCacheDir: () => cacheDir, log: () => {}, playlistItemFilter
    })
    const base = 'http://127.0.0.1:' + info.port
    for (let i = 0; i < 50; i++) {
      try { await (await fetch(base + '/api/ping')).arrayBuffer(); break } catch { await new Promise((r) => setTimeout(r, 100)) }
    }
    const call = async (method, u, body, tok = tokKid) => {
      const res = await fetch(base + u, {
        method,
        headers: { Authorization: 'Bearer ' + tok, 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined
      })
      return { status: res.status, json: await res.json() }
    }
    const alpha = server.encodeId('Alpha (1994).mp4')
    const beta = server.encodeId('Beta (2021).mp4')
    const showKey = server.encodeId('test show')

    let r = await fetch(base + '/api/playlists')
    assert.equal(r.status, 401)
    await r.arrayBuffer()

    // Create with a whole show, add a film, reorder.
    r = await call('POST', '/api/playlists', { name: 'Weekend', add: [{ type: 'show', showKey }] })
    assert.equal(r.status, 200, JSON.stringify(r.json))
    const pid = r.json.playlist.id
    assert.deepEqual(r.json.items.map((i) => i.title), ['Test Show — S1E1', 'Test Show — S1E2'])
    assert.match(r.json.items[0].stream, /^\/tvfile\?id=.*&mt=/)
    r = await call('POST', `/api/playlists/${pid}/items`, { items: [{ type: 'movie', id: alpha }], position: 0 })
    assert.equal(r.json.added, 1)
    assert.equal(r.json.items[0].title, 'Alpha')
    r = await call('POST', `/api/playlists/${pid}/items/move`, { entryId: r.json.items[0].entryId, toIndex: 2 })
    assert.deepEqual(r.json.items.map((i) => i.title), ['Test Show — S1E1', 'Test Show — S1E2', 'Alpha'])
    // An R-rated film can be added by id, but Kid's views leave it out.
    r = await call('POST', `/api/playlists/${pid}/items`, { type: 'movie', id: beta })
    assert.equal(r.json.added, 1)
    assert.equal(r.json.count, 3)

    // Someone else: not found, cannot edit.
    assert.equal((await call('GET', `/api/playlists/${pid}`, null, tokOther)).status, 404)
    assert.equal((await call('POST', `/api/playlists/${pid}/delete`, null, tokOther)).status, 404)
    assert.deepEqual((await call('GET', '/api/playlists', null, tokOther)).json.playlists, [])

    // Play order + shuffle + progress + resume.
    r = await call('GET', `/api/playlists/${pid}/play`)
    assert.deepEqual(r.json.items.map((i) => i.title), ['Test Show — S1E1', 'Test Show — S1E2', 'Alpha'])
    const shuffled = await call('GET', `/api/playlists/${pid}/play?shuffle=1&seed=77`)
    assert.deepEqual((await call("GET", `/api/playlists/${pid}/play?shuffle=1&seed=77`)).json.items.map((i) => i.entryId), shuffled.json.items.map((i) => i.entryId))
    await call('POST', `/api/playlists/${pid}/progress`, { entryId: shuffled.json.items[2].entryId, index: 2, shuffle: true, seed: 77 })
    r = await call('GET', `/api/playlists/${pid}/play?shuffle=1&resume=1`)
    assert.equal(r.json.startIndex, 2)
    assert.deepEqual(r.json.items.map((i) => i.entryId), shuffled.json.items.map((i) => i.entryId))

    // Smart: a template, live preview count, the owner shares one.
    assert.equal((await call('POST', '/api/playlists', { name: 'Shared', shared: true })).status, 403)
    r = await call('POST', '/api/playlists', { name: 'Action', rules: { match: 'all', conditions: [{ field: 'genre', op: 'is', value: 'Action' }], sort: { by: 'year', dir: 'asc' } }, shared: true }, tokOwner)
    assert.equal(r.status, 200)
    assert.deepEqual(r.json.items.map((i) => i.title), ['Alpha', 'Gamma'])
    const shared = r.json.playlist.id
    r = await call('GET', '/api/playlists')
    const row = r.json.playlists.find((p) => p.id === shared)
    assert.equal(row.itemCount, 1, 'Kid sees the shared list without the R-rated film')
    assert.equal(row.canEdit, false)
    assert.equal((await call('POST', `/api/playlists/${shared}/update`, { name: 'mine now' })).status, 403)
    r = await call('POST', '/api/playlists/preview', { rules: { match: 'all', conditions: [{ field: 'decade', op: 'is', value: 1990 }] } }, tokOther)
    assert.equal(r.json.count, 2)
    r = await call('POST', '/api/playlists/expand', { items: [{ type: 'season', showKey, season: 1 }] })
    assert.equal(r.json.items.length, 2)
    assert.equal((await call('POST', '/api/playlists/preview', { rules: { conditions: [{ field: 'nope' }] } })).status, 400)
    assert.ok((await call('GET', '/api/playlists/fields')).json.fields.watchState)

    // Website twin: the page, JSON reads, JSON-only writes.
    const cookie = 'beebo_session=' + auth.signSession(store, kid.id)
    let res = await fetch(base + '/playlists', { headers: { cookie }, redirect: 'manual' })
    assert.equal(res.status, 200)
    const html = await res.text()
    assert.match(html, /id="pl-app"/)
    assert.match(html, /href="\/playlists"/, 'in the navigation')
    res = await fetch(base + '/playlists/api/', { headers: { cookie } })
    assert.equal((await res.json()).playlists.length, 2)
    res = await fetch(base + '/playlists/api/', { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: 'name=x' })
    assert.equal(res.status, 415)
    await res.arrayBuffer()
    res = await fetch(base + '/playlists/api/', { method: 'POST', headers: { cookie, 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{"name":"x"}' })
    assert.equal(res.status, 403, 'refused up front by the shared cross-site guard (was 415 from the route)')
    await res.arrayBuffer()
    res = await fetch(base + '/playlists/api/' + pid + '/update', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{"name":"Renamed"}' })
    assert.equal((await res.json()).playlist.name, 'Renamed')
    res = await fetch(base + '/playlists/api/', { redirect: 'manual' })
    assert.equal(res.status, 302, 'logged out goes to the login page like every website route')
    await res.arrayBuffer()
    // The library pages carry the add-to-playlist script; the player carries the queue.
    const lib = await (await fetch(base + '/', { headers: { cookie } })).text()
    assert.match(lib, /beeboQueue/)
    const player = await (await fetch(base + '/watch?id=' + encodeURIComponent(alpha), { headers: { cookie } })).text()
    assert.match(player, /Next in your queue/)

    // Deleting Kid's account takes Kid's playlists, not the owner's.
    userDeletion.purgeUserData(store, kid.id)
    assert.deepEqual(data.playlists.lists.map((p) => p.name), ['Action'])
  } finally {
    if (savedKey !== undefined) process.env.TMDB_API_KEY = savedKey
    if (info) await new Promise((r) => info.close(r))
    await fs.rm(root, { recursive: true, force: true })
  }
})
