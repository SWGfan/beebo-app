// Removing a person from the home server: what goes, what stays, and who may do it.
// Run: node --test test/user-deletion.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))
const auth = localRequire('./electron/auth')
const { purgeUserData } = localRequire('./electron/userDeletion')

function memoryStore() {
  const data = {}
  return { data, get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] }, onDidChange: () => () => {} }
}

function household(store) {
  const owner = auth.createUser(store, 'Owner Person', 'owner@example.com')
  auth.setUserAdmin(store, owner.user.id, true)
  const robin = auth.createUser(store, 'Robin', 'robin@example.com')
  const sam = auth.createUser(store, 'Sam', 'sam@example.com')
  const r = robin.user.id
  const s = sam.user.id
  store.set('watchHistory', [
    { userId: r, fileName: 'a.mp4', position: 10 },
    { userId: s, fileName: 'a.mp4', position: 20 }
  ])
  store.set('watchHistoryPending', [{ userId: r, sessionId: 'x', lastUpdate: Date.now() }, { userId: s, sessionId: 'y', lastUpdate: Date.now() }])
  store.set('watchlist', { [r]: [{ id: '1' }], [s]: [{ id: '2' }] })
  store.set('libraryFlags', { [r]: { fav: true }, [s]: { fav: false } })
  store.set('userLastSeen', { [r]: { time: 1 }, [s]: { time: 2 } })
  store.set('qualityFlags', [{ filePath: '/m/a.mp4', flaggedBy: [{ userId: r, userName: 'Robin' }, { userId: s, userName: 'Sam' }] }])
  store.set('missingRequests', [{ title: 'Next', requestedBy: [{ userId: r, userName: 'Robin' }] }])
  store.set('playbackMarkers', [{ key: 'show', setBy: { userId: r, userName: 'Robin' } }, { key: 'other', setBy: { userId: s, userName: 'Sam' } }])
  store.set('featureSuggestions', [{ id: 's1', text: 'hi', userId: r, userName: 'Robin' }])
  return { owner, robin, sam }
}

test('purgeUserData removes the person and their personal data, and nobody else\'s', () => {
  const store = memoryStore()
  const { owner, robin, sam } = household(store)
  const r = robin.user.id
  const s = sam.user.id

  const out = purgeUserData(store, r)
  assert.equal(out.removed, true)
  const d = store.data
  assert.deepEqual(d.authUsers.map((u) => u.id).sort(), [owner.user.id, s].sort())
  assert.deepEqual(d.watchHistory.map((e) => e.userId), [s])
  assert.deepEqual(d.watchHistoryPending.map((e) => e.userId), [s])
  assert.deepEqual(Object.keys(d.watchlist), [s])
  assert.deepEqual(Object.keys(d.libraryFlags), [s])
  assert.deepEqual(Object.keys(d.userLastSeen), [s])
  // Shared rows stay (they are about the library), without the person's name.
  assert.deepEqual(d.qualityFlags[0].flaggedBy, [{ userId: s, userName: 'Sam' }])
  assert.equal(d.qualityFlags[0].filePath, '/m/a.mp4')
  assert.deepEqual(d.missingRequests[0].requestedBy, [])
  assert.equal(d.playbackMarkers[0].setBy, null)
  assert.deepEqual(d.playbackMarkers[1].setBy, { userId: s, userName: 'Sam' })
  assert.equal(d.featureSuggestions[0].userId, '')
  assert.equal(JSON.stringify(d).includes('Robin'), false, 'no trace of the name')
  assert.equal(JSON.stringify(d).includes(r), false, 'no trace of the id')

  assert.deepEqual(purgeUserData(store, r), { removed: false })
  assert.deepEqual(purgeUserData(store, ''), { removed: false })
})

test('/api/me/delete: the member confirms with their password; the last admin cannot', async () => {
  const server = localRequire('./electron/streamServer')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'beebo-del-test-'))
  let info
  try {
    const store = memoryStore()
    const { owner, robin, sam } = household(store)
    const port = 47000 + Math.floor(Math.random() * 900) + 50
    info = server.startStreamServer({
      port, store, getMoviesDir: () => dir, getTvShowsDir: () => dir,
      getAllMoviesDirs: () => [dir], getAllTvShowsDirs: () => [],
      log: () => {}, agentSecret: 'x'.repeat(64)
    })
    const base = 'http://127.0.0.1:' + info.port
    for (let i = 0; i < 50; i++) {
      try { await fetch(base + '/login', { redirect: 'manual' }); break } catch { await new Promise((r) => setTimeout(r, 100)) }
    }
    const call = (p, token, body) => fetch(base + p, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
      body: JSON.stringify(body || {})
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }))
    const login = async (u, code) => (await call('/api/login', null, { username: u.user.username, password: code })).body.token

    const robinToken = await login(robin, robin.code)
    assert.ok(robinToken)
    assert.equal((await call('/api/me/delete', null, { password: robin.code })).status, 401, 'needs a sign-in')
    assert.equal((await call('/api/me/delete', robinToken, {})).status, 400)
    assert.equal((await call('/api/me/delete', robinToken, { password: 'wrong' })).status, 401)
    assert.ok(store.data.authUsers.some((u) => u.id === robin.user.id), 'still here after a wrong password')

    const del = await call('/api/me/delete', robinToken, { password: robin.code })
    assert.equal(del.status, 200)
    assert.equal(del.body.deleted, true)
    assert.equal(store.data.authUsers.some((u) => u.id === robin.user.id), false)
    assert.equal(Object.keys(store.data.watchlist).includes(robin.user.id), false)
    const me = await fetch(base + '/api/me', { headers: { authorization: 'Bearer ' + robinToken } })
    assert.equal(me.status, 401, 'the old token is dead')

    // The server's only admin can't delete themselves (nobody could run it after).
    const ownerToken = await login(owner, owner.code)
    const self = await call('/api/me/delete', ownerToken, { password: owner.code })
    assert.equal(self.status, 409)
    assert.equal(self.body.error, 'last_admin')
    assert.ok(store.data.authUsers.some((u) => u.id === owner.user.id))

    // Password guesses here count per account, not only per address: from rotating
    // viewer addresses (as the host agent reports them) Sam's account still locks.
    const samToken = await login(sam, sam.code)
    const viaAgent = (n) => ({ 'x-beebo-viewer-ip': '198.51.100.' + n, 'x-beebo-agent-key': 'x'.repeat(64) })
    const guess = (n, password) => fetch(base + '/api/me/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + samToken, ...viaAgent(n) },
      body: JSON.stringify({ password })
    }).then((r) => r.status)
    const statuses = []
    for (let i = 0; i < 12; i++) statuses.push(await guess(i + 1, 'wrong-' + i))
    assert.ok(statuses.includes(429), 'the account locks: ' + statuses.join(','))
    assert.equal(await guess(99, sam.code), 429, 'even the right password waits out the lock')
    assert.ok(store.data.authUsers.some((u) => u.id === sam.user.id))
  } finally {
    if (info) await new Promise((r) => info.close(r))
    await fs.rm(dir, { recursive: true, force: true })
  }
})
