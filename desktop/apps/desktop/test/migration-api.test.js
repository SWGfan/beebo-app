// The importer's owner-only contract (electron/migrationApi.js) and its wiring into the real stream
// server (the desktop app's IPC bridge and the admin route). Run: node --test test/migration-api.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const api = require('../electron/migrationApi')
const fx = require('./helpers/migrationFixtures')

const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))
const { owner, sam } = fx
const KEY = 'abcdef0123456789ABCDEF'
const AGENT_SECRET = 'migration-api-test-secret-' + 'k'.repeat(40)

const viewerOf = (u) => ({ id: u.id, isAdmin: !!u.isAdmin, name: u.name })
async function call(h, viewer, method, p, body, query, transport = 'ipc') {
  return api.handle({ method, path: p, query: new URLSearchParams(query || {}), body: body || {}, viewer, transport }, { importer: () => h.importer })
}
async function poll(h, viewer, id) {
  for (let i = 0; i < 400; i++) {
    const r = await call(h, viewer, 'GET', 'sessions/' + id)
    if (r.body.session && (r.body.session.status === 'ready' || r.body.session.status === 'error')) return r.body.session
    await new Promise((res) => setTimeout(res, 15))
  }
  throw new Error('never ready')
}

test('owner only: no viewer is 401, a household member is 403, before anything is read or made', async () => {
  const h = fx.makeImporter()
  try {
    let r = await api.handle({ method: 'GET', path: 'sources', viewer: null }, { importer: () => h.importer })
    assert.equal(r.status, 401)
    for (const [m, p, b] of [['GET', 'sources'], ['POST', 'connect', { source: 'jellyfin', baseUrl: 'http://x', apiKey: KEY }], ['POST', 'sessions', { source: 'letterboxd', files: [] }], ['GET', 'imports'], ['POST', 'imports/imp_abcdef12/undo'], ['GET', 'sessions/ms_abcdefgh12/preview']]) {
      r = await call(h, viewerOf(sam), m, p, b)
      assert.equal(r.status, 403, m + ' ' + p)
      assert.deepEqual(r.body, { ok: false, error: 'owner_only' })
    }
    assert.equal(fs.readdirSync(h.journalDir).length, 0)
    r = await call(h, { id: 'u-x', isAdmin: false }, 'GET', 'sources')
    assert.equal(r.status, 403)
  } finally { fs.rmSync(h.journalDir, { recursive: true, force: true }) }
})

test('sources: the ways in, and "a folder" only where the app\u2019s own file dialog exists', async () => {
  const h = fx.makeImporter({ deps: { resolveGrant: () => null, libraryRoots: () => [] } })
  try {
    let r = await call(h, viewerOf(owner), 'GET', 'sources', null, null, 'ipc')
    assert.equal(r.status, 200)
    assert.deepEqual(r.body.sources.map((s) => s.id), ['plex', 'jellyfin', 'emby', 'kodi', 'letterboxd'])
    assert.deepEqual(r.body.sources.find((s) => s.id === 'kodi').modes.map((m) => m.id), ['folder', 'files', 'library'])
    r = await call(h, viewerOf(owner), 'GET', 'sources', null, null, 'http')
    assert.deepEqual(r.body.sources.find((s) => s.id === 'kodi').modes.map((m) => m.id), ['files', 'library'])
    r = await call(h, viewerOf(owner), 'POST', 'sessions', { source: 'kodi', mode: 'folder', grantId: 'g_x' }, null, 'http')
    assert.deepEqual([r.status, r.body.error], [400, 'unknown_mode'], 'a folder cannot be named over the web')
  } finally { fs.rmSync(h.journalDir, { recursive: true, force: true }) }
})

test('the whole flow through the contract: connect, session, preview, configure, dry run, import, list, undo', async () => {
  const srv = await fx.startMockServer(fx.jellyfinHandler(KEY))
  const h = fx.makeImporter()
  const me = viewerOf(owner)
  try {
    let r = await call(h, me, 'POST', 'connect', { source: 'jellyfin', baseUrl: srv.url, apiKey: KEY })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual(r.body.users.map((u) => u.name), ['Nick', 'Sam'])
    assert.ok(!JSON.stringify(r.body).includes(KEY))
    r = await call(h, me, 'POST', 'connect', { source: 'jellyfin', baseUrl: srv.url, apiKey: 'wrongwrong0123456789' })
    assert.deepEqual([r.status, r.body.error], [400, 'http_401'])
    assert.match(r.body.message, /refused the key/)
    assert.doesNotMatch(JSON.stringify(r.body), /wrongwrong/)

    const body = { source: 'jellyfin', baseUrl: srv.url, apiKey: KEY, userIds: ['11111111-aaaa-bbbb-cccc-000000000001'] }
    r = await call(h, me, 'POST', 'sessions', body)
    assert.equal(r.status, 200)
    assert.equal(body.apiKey, '', 'the request body no longer holds the key once it is read')
    const id = r.body.session.id
    assert.match(id, /^ms_/)
    const session = await poll(h, me, id)
    assert.equal(session.status, 'ready')
    const userKey = session.users[0].key

    r = await call(h, me, 'GET', `sessions/${id}/preview`, null, { filter: 'all', limit: '2', offset: '1', type: 'movie' })
    assert.equal(r.status, 200)
    assert.equal(r.body.items.length, 2)
    assert.equal(r.body.offset, 1)
    assert.ok(r.body.items.every((i) => i.type === 'movie'))

    r = await call(h, me, 'POST', `sessions/${id}/configure`, { userMap: { [userKey]: 'u-sam' }, options: { lists: false } })
    assert.deepEqual(r.body.session.config.userMap, { [userKey]: 'u-sam' })
    assert.equal(r.body.session.config.options.lists, false)

    r = await call(h, me, 'POST', `sessions/${id}/import`, { dryRun: true })
    assert.equal(r.status, 200)
    assert.equal(r.body.report.dryRun, true)
    assert.ok(r.body.report.counts.watched >= 2)
    assert.deepEqual(h.store.get('watchHistory') || [], [], 'a dry run wrote nothing')

    r = await call(h, me, 'POST', `sessions/${id}/import`, { dryRun: false })
    assert.equal(r.status, 200)
    const importId = r.body.report.importId
    assert.ok(importId)
    assert.equal((h.store.get('watchHistory') || []).length, 2, 'the two resume points')

    r = await call(h, me, 'GET', 'imports')
    assert.deepEqual(r.body.imports.map((i) => [i.id, i.status, i.source]), [[importId, 'applied', 'jellyfin']])
    r = await call(h, me, 'POST', `imports/${importId}/undo`)
    assert.equal(r.status, 200)
    assert.equal(r.body.result.changedSince, 0)
    assert.deepEqual(h.store.get('watchHistory'), [])
    r = await call(h, me, 'POST', `imports/${importId}/undo`)
    assert.deepEqual([r.status, r.body.error], [409, 'already_undone'])

    r = await call(h, me, 'DELETE', `sessions/${id}`)
    assert.equal(r.status, 200)
    r = await call(h, me, 'GET', `sessions/${id}`)
    assert.deepEqual([r.status, r.body.error], [404, 'session_not_found'])
  } finally { await srv.close(); fs.rmSync(h.journalDir, { recursive: true, force: true }) }
})

test('a letterboxd zip travels as base64 in the body; a bad request is a JSON error, never a thrown one', async () => {
  const h = fx.makeImporter()
  const me = viewerOf(owner)
  try {
    let r = await call(h, me, 'POST', 'sessions', { source: 'letterboxd', files: [{ name: 'export.zip', base64: fx.letterboxdZip().toString('base64') }] }, null, 'http')
    assert.equal(r.status, 200)
    const s = await poll(h, me, r.body.session.id)
    assert.equal(s.counts.matched, 7)
    r = await call(h, me, 'POST', `sessions/${s.id}/configure`, { decisions: { i0: { targetKey: 'movie:Nope.mkv' } } })
    assert.deepEqual([r.status, r.body.error], [400, 'bad_choice'])
    r = await call(h, me, 'POST', `sessions/${s.id}/configure`, { userMap: 'nope', options: 5, decisions: [] })
    assert.equal(r.status, 200, 'wrongly-shaped fields are ignored, not trusted')
    for (const [m, p] of [['GET', 'nope'], ['POST', 'sessions/ms_abcdefgh12/whatever'], ['PUT', 'sessions'], ['GET', 'imports/x/undo'], ['GET', 'sessions/' + s.id + '/nope']]) {
      r = await call(h, me, m, p)
      assert.ok(r.status === 404 || r.status === 400, m + ' ' + p + ' -> ' + r.status)
      assert.equal(r.body.ok, false)
    }
    r = await call(h, me, 'GET', 'imports/../../x')
    assert.equal(r.status, 404)
    r = await call(h, me, 'POST', 'imports/..%2F..%2Fx/undo')
    assert.deepEqual([r.status, r.body.error], [404, 'import_not_found'])
    // A failure inside the importer never leaks its message.
    const boom = await api.handle({ method: 'GET', path: 'sources', viewer: me }, { importer: () => { throw new Error('secret path C:\\Users\\nick\\key.txt') } })
    assert.deepEqual([boom.status, boom.body], [500, { ok: false, error: 'server_error' }])
  } finally { fs.rmSync(h.journalDir, { recursive: true, force: true }) }
})

test('on the real stream server: the desktop bridge imports for the owner, a member is refused, and the admin route is behind TLS', async () => {
  const server = localRequire('./electron/streamServer')
  const auth = localRequire('./electron/auth')
  const watchedState = localRequire('./electron/watchedState')
  const savedKey = process.env.TMDB_API_KEY
  delete process.env.TMDB_API_KEY
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'beebo-mig-api-'))
  const moviesDir = path.join(root, 'Movies')
  const tvDir = path.join(root, 'TV')
  const cacheDir = path.join(root, 'tmdb')
  const journals = path.join(root, 'undo')
  let info
  try {
    await fsp.mkdir(moviesDir, { recursive: true })
    await fsp.mkdir(tvDir, { recursive: true })
    await fsp.mkdir(cacheDir, { recursive: true })
    for (const f of ['The Matrix (1999).mp4', 'Heat (1995).mp4', 'Alien (1979).mp4']) await fsp.writeFile(path.join(moviesDir, f), 'x')
    await fsp.writeFile(path.join(cacheDir, 'manifest.json'), JSON.stringify({
      'The Matrix (1999).mp4': { id: 603, title: 'The Matrix', release_date: '1999-03-30' },
      'Heat (1995).mp4': { id: 949, title: 'Heat', release_date: '1995-12-15' },
      'Alien (1979).mp4': { id: 348, title: 'Alien', release_date: '1979-05-25' }
    }))
    const data = {}
    const store = { get: (k) => data[k], set: (k, v) => { data[k] = JSON.parse(JSON.stringify(v)) }, delete: (k) => { delete data[k] }, onDidChange: () => () => {} }
    const created = auth.createOwner(store, { username: 'nick', password: 'nick-owner-test-passphrase' })
    const ownerUser = created.user || auth.getUsers(store).find((u) => u.isAdmin)
    const { user: kid } = auth.createUser(store, 'Kid', 'kid@example.com')
    const tokKid = server.makeApiToken(store, kid.id)
    const tokOwner = server.makeApiToken(store, ownerUser.id)
    const port = 47000 + Math.floor(Math.random() * 900) + 50
    info = server.startStreamServer({
      port, store, getMoviesDir: () => moviesDir, getTvShowsDir: () => tvDir,
      getAllMoviesDirs: () => [moviesDir], getAllTvShowsDirs: () => [tvDir],
      getTmdbCacheDir: () => cacheDir, log: () => {}, migrationDir: journals, agentSecret: AGENT_SECRET
    })
    const base = 'http://127.0.0.1:' + info.port
    for (let i = 0; i < 50; i++) {
      try { await (await fetch(base + '/api/ping')).arrayBuffer(); break } catch { await new Promise((r) => setTimeout(r, 100)) }
    }
    const me = { id: ownerUser.id, isAdmin: true, name: ownerUser.name }
    const bridge = (method, p, body, user = me, query) => info.migration.call(method, p, query || {}, body || {}, user)

    // A member is refused; nobody signed in is 401.
    let r = await bridge('GET', 'sources', null, { id: kid.id, isAdmin: false, name: 'Kid' })
    assert.deepEqual([r.status, r.body.error], [403, 'owner_only'])
    r = await bridge('GET', 'sources', null, null)
    assert.equal(r.status, 401)

    // The owner: read a Letterboxd export, match it against the library on disk, import, undo.
    r = await bridge('POST', 'sessions', { source: 'letterboxd', files: [{ name: 'export.zip', base64: fx.letterboxdZip().toString('base64') }] })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const id = r.body.session.id
    let session
    for (let i = 0; i < 300; i++) {
      session = (await bridge('GET', 'sessions/' + id)).body.session
      if (session.status === 'ready' || session.status === 'error') break
      await new Promise((res) => setTimeout(res, 20))
    }
    assert.equal(session.status, 'ready', JSON.stringify(session.error))
    assert.equal(session.counts.matched, 3, 'The Matrix, Heat and Alien are in this library (matched by title and year from the TMDB cache)')
    assert.deepEqual(session.config.userMap, { letterboxd: ownerUser.id })
    r = await bridge('POST', `sessions/${id}/import`, { dryRun: false })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.report.counts.watched, 2)
    assert.deepEqual(r.body.report.counts, { watched: 2, resume: 0, ratings: 2, favorites: 1, watchlist: 1, lists: 1, listItems: 3, metadata: 0 })
    assert.equal(watchedState.isWatched(store, ownerUser.id, 'movie', 'The Matrix (1999).mp4'), true)
    assert.equal(watchedState.isWatched(store, ownerUser.id, 'movie', 'Alien (1979).mp4'), false)
    assert.ok(fs.existsSync(path.join(journals, r.body.report.importId + '.json')), 'the undo journal is in the folder the server was given')
    // The website's own Watchlist and favourites routes see what was written.
    const wl = await fetch(base + '/api/watchlist', { headers: { Authorization: 'Bearer ' + tokOwner } })
    const wlJson = await wl.json()
    assert.deepEqual(wlJson.items.map((i) => i.title), ['Alien'])
    const favs = await (await fetch(base + '/api/favorites', { headers: { Authorization: 'Bearer ' + tokOwner } })).json()
    assert.equal(favs.items.length, 1)
    r = await bridge('POST', `imports/${r.body.report.importId}/undo`)
    assert.equal(r.body.result.changedSince, 0)
    assert.equal(watchedState.isWatched(store, ownerUser.id, 'movie', 'The Matrix (1999).mp4'), false)

    // Over HTTP the route is an admin route: plain HTTP is refused for everyone before it looks at the token.
    for (const tok of [tokOwner, tokKid]) {
      const res = await fetch(base + '/api/admin/migration/sources', { headers: { Authorization: 'Bearer ' + tok } })
      const j = await res.json()
      assert.equal(res.status, 403)
      assert.equal(j.error, 'https_required')
    }
    // Behind the second door (the host agent's secret stands in for TLS), the route works for an admin
    // and only an admin, over JSON, and carries the same contract.
    const viaTls = (tok, extra = {}) => ({ headers: { Authorization: 'Bearer ' + tok, 'X-Beebo-Agent-Key': AGENT_SECRET, 'content-type': 'application/json', ...extra } })
    let res = await fetch(base + '/api/admin/migration/sources', viaTls(tokKid))
    assert.deepEqual([res.status, (await res.json()).error], [403, 'admin_only'])
    res = await fetch(base + '/api/admin/migration/sources', viaTls(tokOwner))
    const srcs = await res.json()
    assert.equal(res.status, 200)
    assert.deepEqual(srcs.sources.find((x) => x.id === 'kodi').modes.map((m) => m.id), ['files', 'library'], 'no "folder" over HTTP')
    res = await fetch(base + '/api/admin/migration/sessions', { method: 'POST', ...viaTls(tokOwner), body: JSON.stringify({ source: 'letterboxd', files: [{ name: 'e.zip', base64: fx.letterboxdZip().toString('base64') }] }) })
    const started = await res.json()
    assert.equal(res.status, 200, JSON.stringify(started))
    let over
    for (let i = 0; i < 300; i++) {
      over = (await (await fetch(base + '/api/admin/migration/sessions/' + started.session.id, viaTls(tokOwner))).json()).session
      if (over.status === 'ready' || over.status === 'error') break
      await new Promise((r2) => setTimeout(r2, 20))
    }
    assert.equal(over.status, 'ready')
    res = await fetch(base + '/api/admin/migration/sessions/' + started.session.id + '/import', { method: 'POST', ...viaTls(tokOwner), body: JSON.stringify({ dryRun: true }) })
    const dry = await res.json()
    assert.equal(dry.report.dryRun, true)
    assert.equal(dry.report.counts.watched, 2)
    res = await fetch(base + '/api/admin/migration/sessions/' + started.session.id + '/preview?filter=matched', viaTls(tokOwner))
    assert.equal((await res.json()).total, 3)
    res = await fetch(base + '/api/admin/migration/imports', viaTls(tokKid))
    assert.equal(res.status, 403)
    await res.arrayBuffer()
    // An oversized body is refused before it is read: the request only announces 300 MB and sends none.
    const refused = await new Promise((resolve, reject) => {
      const req = require('node:http').request({
        host: '127.0.0.1', port: info.port, path: '/api/admin/migration/sessions', method: 'POST',
        headers: { Authorization: 'Bearer ' + tokOwner, 'X-Beebo-Agent-Key': AGENT_SECRET, 'content-type': 'application/json', 'content-length': String(300 * 1024 * 1024) }
      }, (res2) => { res2.resume(); resolve(res2.statusCode) })
      req.on('error', reject)
      req.flushHeaders()
      setTimeout(() => { req.destroy(); resolve('no answer') }, 3000)
    })
    assert.equal(refused, 413)
    const anon = await fetch(base + '/api/admin/migration/sources')
    assert.equal(anon.status, 401)
    await anon.arrayBuffer()
    // A folder grant is single-purpose: it is only ever what the file dialog returned, and it expires.
    const grant = info.migration.grantFolder(path.join(root, 'nfo'))
    assert.match(grant, /^g_[A-Za-z0-9_-]{8,}$/)
  } finally {
    if (info) await new Promise((res) => info.close(res))
    if (savedKey !== undefined) process.env.TMDB_API_KEY = savedKey
    await fsp.rm(root, { recursive: true, force: true })
  }
})
