'use strict'
// Personal API keys: storage, scopes, revocation, rate limiting, and the wall around everything
// that is not /api/v1. Real server over a fixture library.
// Run: node --test test/api-keys.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const apiKeys = require('../electron/apiKeys')
const history = require('../electron/history')
const { createFixture, webAdmin } = require('./helpers/publicApiFixture')

const fakeStore = (initial = {}) => {
  const data = { ...initial }
  return { data, get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] } }
}

async function makeKey(f, body = { name: 'Test key' }, who = 'owner') {
  const r = await f.admin('/api/admin/api-keys/create', body, who)
  assert.equal(r.status, 200, r.text)
  return r.body
}

test('create: plaintext once, only a hash stored, read-only by default', () => {
  const store = fakeStore()
  const out = apiKeys.create(store, { name: '  Home   Assistant ', ownerUserId: 'owner' })
  assert.equal(out.ok, true)
  assert.match(out.token, /^beebo_pat_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/)
  assert.equal(out.key.name, 'Home Assistant')
  assert.deepEqual(out.key.scopes, ['library'], 'library only until more is ticked')
  assert.equal(out.key.ratePerMinute, apiKeys.DEFAULT_RATE_PER_MINUTE)

  const secret = out.token.split('_').slice(3).join('_')
  const stored = JSON.stringify(store.data)
  assert.ok(!stored.includes(secret), 'the secret is nowhere in the store')
  assert.ok(!stored.includes(out.token))
  assert.deepEqual(Object.keys(store.data.apiKeys[0]).sort(), ['createdAt', 'hash', 'id', 'lastUsedAt', 'name', 'ownerUserId', 'ratePerMinute', 'scopes'])
  assert.doesNotMatch(JSON.stringify(apiKeys.list(store)), /hash|beebo_pat_[0-9a-f]{12}_[A-Za-z0-9_-]{43}/, 'listing never shows the hash or the secret')

  assert.equal(apiKeys.verify(store, out.token).ok, true)
  assert.equal(apiKeys.verify(store, out.token.slice(0, -1) + (out.token.endsWith('A') ? 'B' : 'A')).reason, 'bad_secret')
  assert.equal(apiKeys.verify(store, 'beebo_pat_000000000000_' + 'A'.repeat(43)).reason, 'unknown')
  assert.equal(apiKeys.verify(store, 'beebo_pat_nope').reason, 'malformed')
  assert.equal(apiKeys.verify(store, '').reason, 'malformed')
})

test('create: names, scopes and limits are validated', () => {
  const store = fakeStore()
  const make = (o) => apiKeys.create(store, { name: 'k', ownerUserId: 'owner', ...o })
  assert.equal(make({ name: '' }).error, 'bad_name')
  assert.equal(make({ name: 'x'.repeat(61) }).error, 'bad_name')
  assert.equal(make({ ownerUserId: '' }).error, 'bad_owner')
  assert.equal(make({ scopes: [] }).error, 'bad_key_scope')
  assert.equal(make({ scopes: ['library', 'admin'] }).error, 'bad_key_scope', 'no scope outside the read-only list can be granted')
  assert.equal(make({ scopes: ['webhooks'] }).error, 'bad_key_scope')
  assert.equal(make({ scopes: 'library' }).error, 'bad_key_scope')
  assert.equal(make({ ratePerMinute: 5 }).error, 'bad_rate')
  assert.equal(make({ ratePerMinute: 1201 }).error, 'bad_rate')
  assert.equal(make({ ratePerMinute: 'lots' }).error, 'bad_rate')
  assert.deepEqual(make({ scopes: ['now-playing', 'library'] }).key.scopes, ['library', 'now-playing'])
  for (let i = 1; i < apiKeys.MAX_KEYS; i++) assert.equal(make({}).ok, true)
  assert.equal(make({}).error, 'too_many_keys')
})

test('over HTTP: a key opens /api/v1 within its scopes and nothing beyond them', async (t) => {
  const f = await createFixture(t)
  const { token, key } = await makeKey(f)
  assert.deepEqual(key.scopes, ['library'])

  const idx = await f.call(token, '/api/v1')
  assert.equal(idx.status, 200)
  assert.equal(idx.body.auth.type, 'api_key')
  assert.equal(idx.body.auth.keyName, 'Test key')
  assert.deepEqual(idx.body.auth.scopes, ['library'])
  assert.ok(idx.body.endpoints.every((e) => e.scope === 'library'), 'only the endpoints it may call are advertised')

  const movies = await f.call(token, '/api/v1/library/movies')
  assert.equal(movies.status, 200)
  assert.equal(movies.body.total, 3)
  for (const route of ['/api/v1/history', '/api/v1/continue', '/api/v1/now-playing']) {
    const r = await f.call(token, route)
    assert.equal(r.status, 403, route)
    assert.equal(r.body.error, 'insufficient_scope')
  }

  const wide = await makeKey(f, { name: 'Wide', scopes: ['library', 'history', 'now-playing'] })
  assert.equal((await f.call(wide.token, '/api/v1/now-playing')).status, 200)
  assert.equal((await f.call(wide.token, '/api/v1/history')).status, 200)
})

test('a key can never reach admin, sign-in, parental, the private vault, or any write route', async (t) => {
  const f = await createFixture(t)
  const { token } = await makeKey(f, { name: 'All read scopes', scopes: ['library', 'history', 'now-playing'] })
  const before = JSON.stringify(f.data.apiKeys)

  const attempts = [
    ['GET', '/api/admin/api-keys'],
    ['GET', '/api/admin/users'],
    ['GET', '/api/admin/settings'],
    ['GET', '/api/admin/dashboard'],
    ['POST', '/api/admin/api-keys/create', { name: 'sneaky' }],
    ['POST', '/api/admin/api-keys/revoke', { id: 'x' }],
    ['POST', '/api/admin/users/set-admin', { userId: 'member', isAdmin: true }],
    ['POST', '/api/login', { username: 'owner', password: 'x' }],
    ['GET', '/api/me'],
    ['GET', '/api/parental/status'],
    ['POST', '/api/parental/unlock', { pin: '1234' }],
    ['POST', '/api/profiles/switch', { userId: 'member' }],
    ['GET', '/api/private-vault/status'],
    ['POST', '/api/private-vault/unlock', {}],
    ['POST', '/api/watched', { kind: 'movie', id: 'x' }],
    ['POST', '/api/history/clear', { scope: 'all' }],
    ['POST', '/api/title-requests', { kind: 'movie', title: 'Dune' }],
    ['POST', '/api/missing-request', { kind: 'movie', title: 'Dune' }],
    ['POST', '/api/me/delete', { password: 'x' }],
    ['GET', '/api/movies'],
    ['GET', '/api/library/clear']
  ]
  for (const [method, route, body] of attempts) {
    const r = await f.call(token, route, { method, body })
    assert.equal(r.status, 403, `${method} ${route} -> ${r.status} ${r.text}`)
    assert.equal(r.body.error, 'api_key_scope', `${method} ${route}`)
  }
  assert.equal(JSON.stringify(f.data.apiKeys), before, 'nothing changed: no key made or removed, and no use recorded')
  assert.equal(f.data.authUsers.find((u) => u.id === 'member').isAdmin, undefined)

  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const r = await f.call(token, '/api/v1/library/movies', { method, body: {} })
    assert.equal(r.status, 405, method)
  }
  // The key only ever means "/api/v1": presenting it as the admin cookie header or agent key does nothing.
  const asAgent = await f.call(token, '/api/admin/api-keys', { headers: { 'X-Beebo-Agent-Key': 'not-the-secret' } })
  assert.equal(asAgent.status, 403)
})

test('revoking a key stops it immediately; the others keep working', async (t) => {
  const f = await createFixture(t)
  const a = await makeKey(f, { name: 'A' })
  const b = await makeKey(f, { name: 'B' })
  assert.equal((await f.call(a.token, '/api/v1/library/movies')).status, 200)
  assert.equal((await f.call(b.token, '/api/v1/library/movies')).status, 200)

  const rev = await f.admin('/api/admin/api-keys/revoke', { id: a.key.id })
  assert.equal(rev.status, 200)
  assert.equal((await f.call(a.token, '/api/v1/library/movies')).status, 401, 'the very next request is refused')
  assert.equal((await f.call(b.token, '/api/v1/library/movies')).status, 200)
  assert.equal((await f.admin('/api/admin/api-keys/revoke', { id: a.key.id })).status, 404)
  const list = await f.admin('/api/admin/api-keys')
  assert.deepEqual(list.body.keys.map((k) => k.name), ['B'])
  assert.doesNotMatch(list.text, /hash/)
  assert.doesNotMatch(list.text, new RegExp(b.token.split('_')[3]), 'the list never shows the secret')
})

test('only an admin manages every key, and a key never outlives the rights of the person who made it', async (t) => {
  const f = await createFixture(t)
  assert.equal((await f.admin('/api/admin/api-keys/create', { name: 'x' }, 'member')).status, 403)
  assert.equal((await f.admin('/api/admin/api-keys', undefined, 'member')).status, 403)
  assert.equal((await f.call('member', '/api/admin/api-keys/create', { method: 'POST', body: { name: 'x' } })).status, 403, 'and not without the agent key either')

  const { token } = await makeKey(f, { name: 'By second admin' }, 'admin2')
  const owns = await makeKey(f, { name: 'Dashboard', scopes: ['library', 'now-playing'] }, 'admin2')
  assert.equal((await f.call(token, '/api/v1/library/movies')).status, 200)
  assert.equal((await f.call(owns.token, '/api/v1/now-playing')).status, 200)
  f.data.authUsers = f.data.authUsers.map((u) => (u.id === 'admin2' ? { ...u, isAdmin: false } : u))
  // Demoted: the key is now a member's key, so it keeps what a member may have and loses the rest.
  assert.equal((await f.call(token, '/api/v1/library/movies')).status, 200, 'library is still theirs')
  const noLonger = await f.call(owns.token, '/api/v1/now-playing')
  assert.equal(noLonger.status, 403, 'who is watching is not: the scope is gone with the admin rights')
  assert.equal(noLonger.body.error, 'insufficient_scope')
  assert.deepEqual((await f.call(owns.token, '/api/v1')).body.auth.scopes, ['library'])
  f.data.authUsers = f.data.authUsers.map((u) => (u.id === 'admin2' ? { ...u, isAdmin: true, status: 'revoked' } : u))
  assert.equal((await f.call(token, '/api/v1/library/movies')).status, 401, 'revoked account: dead')
})

test('deleting the account that made a key removes the key', () => {
  const store = fakeStore({ authUsers: [{ id: 'u1', name: 'A', status: 'approved' }, { id: 'u2', name: 'B', status: 'approved' }] })
  apiKeys.create(store, { name: 'one', ownerUserId: 'u1' })
  apiKeys.create(store, { name: 'two', ownerUserId: 'u2' })
  require('../electron/userDeletion').purgeUserData(store, 'u1')
  assert.deepEqual(apiKeys.list(store).map((k) => k.name), ['two'])
})

test('the only use recorded is a last-used time', async (t) => {
  const f = await createFixture(t)
  const { token, key } = await makeKey(f)
  const before = JSON.stringify(f.data.apiKeys[0])
  assert.equal(f.data.apiKeys[0].lastUsedAt, null)
  await f.call(token, '/api/v1/library/movies?q=heat')
  const row = f.data.apiKeys[0]
  assert.equal(typeof row.lastUsedAt, 'number')
  assert.ok(Math.abs(row.lastUsedAt - Date.now()) < 10000)
  assert.deepEqual({ ...row, lastUsedAt: null }, { ...JSON.parse(before), lastUsedAt: null }, 'nothing else about the key changed')
  assert.ok(!JSON.stringify(f.data).includes('heat'), 'no query text or request body is kept anywhere')
  const list = await f.admin('/api/admin/api-keys')
  assert.equal(list.body.keys[0].id, key.id)
  assert.equal(typeof list.body.keys[0].lastUsedAt, 'number')
})

test('rate limit: each key has its own per-minute budget, refused with Retry-After', async (t) => {
  const f = await createFixture(t)
  const slow = await makeKey(f, { name: 'Slow', ratePerMinute: 10 })
  const other = await makeKey(f, { name: 'Other', ratePerMinute: 10 })
  for (let i = 0; i < 10; i++) assert.equal((await f.call(slow.token, '/api/v1')).status, 200, 'request ' + (i + 1))
  const over = await f.call(slow.token, '/api/v1')
  assert.equal(over.status, 429)
  assert.equal(over.body.error, 'rate_limited')
  assert.ok(over.body.retryAfterSeconds >= 1)
  assert.ok(Number(over.headers.get('retry-after')) >= 1)
  assert.equal((await f.call(other.token, '/api/v1')).status, 200, 'a second key is not slowed by the first')
  assert.equal((await f.call('owner', '/api/v1')).status, 200, 'and the account token has no key budget')
})

test('rate limit: a limiter unit test with a fake clock', () => {
  let t = 1000
  const guard = apiKeys.createGuard({ now: () => t })
  const key = { id: 'k1', ratePerMinute: 3 }
  assert.equal(guard.hit(key).ok, true)
  assert.equal(guard.hit(key).ok, true)
  assert.equal(guard.hit(key).ok, true)
  assert.equal(guard.hit(key).ok, false)
  t += 61 * 1000
  assert.equal(guard.hit(key).ok, true, 'the window slides')
  for (let i = 0; i < apiKeys.FAIL_MAX; i++) { assert.equal(guard.lockedMinutes('1.2.3.4'), 0); guard.noteFailure('1.2.3.4') }
  assert.ok(guard.lockedMinutes('1.2.3.4') > 0)
  assert.equal(guard.lockedMinutes('5.6.7.8'), 0)
  t += 16 * 60 * 1000
  assert.equal(guard.lockedMinutes('1.2.3.4'), 0, 'the lock ages out')
})

test('guessing keys locks the address out, valid key included, like a login brute force', async (t) => {
  const f = await createFixture(t)
  const { token } = await makeKey(f)
  const wrongSecret = token.slice(0, token.lastIndexOf('_') + 1) + 'A'.repeat(43)
  for (let i = 0; i < apiKeys.FAIL_MAX; i++) {
    const r = await f.call(i % 2 ? wrongSecret : 'beebo_pat_' + '0'.repeat(12) + '_' + 'B'.repeat(43), '/api/v1')
    assert.equal(r.status, 401, 'guess ' + (i + 1))
  }
  const locked = await f.call(token, '/api/v1')
  assert.equal(locked.status, 429)
  assert.equal(locked.body.error, 'locked')
  assert.ok(Number(locked.headers.get('retry-after')) > 0)
  // An account token from the same address is a different door and is not caught by this lock.
  assert.equal((await f.call('owner', '/api/v1')).status, 200)
})

test('an address already locked out by failed sign-ins cannot try keys either', async (t) => {
  const f = await createFixture(t)
  const { token } = await makeKey(f)
  const auth = require('../electron/auth')
  for (let i = 0; i < 12; i++) auth.recordFailedLogin(f.store, { ip: '127.0.0.1', username: 'someone' })
  assert.equal(auth.checkLockout(f.store, '127.0.0.1').locked, true)
  assert.equal((await f.call(token, '/api/v1')).status, 429)
})

test('history scope reads only the key owner\'s own history', async (t) => {
  const f = await createFixture(t)
  const sid = history.startSession(f.store, { userId: 'owner', userName: 'Owner', title: 'Heat', fileName: 'Heat (1995).mp4', kind: 'movie' })
  history.updateSession(f.store, sid, { currentTime: 60, duration: 6000 })
  const other = history.startSession(f.store, { userId: 'member', userName: 'Member', title: 'Alien', fileName: 'Alien (1979).mp4', kind: 'movie' })
  history.updateSession(f.store, other, { currentTime: 60, duration: 6000 })
  const { token } = await makeKey(f, { name: 'hist', scopes: ['history'] })
  const r = await f.call(token, '/api/v1/history')
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.items.map((i) => i.title), ['Heat'])
  assert.equal((await f.call(token, '/api/v1/library/movies')).status, 403, 'and no library scope')
})

test('web admin: API keys tab makes a key (shown once) and removes it', async (t) => {
  const f = await createFixture(t)
  const web = webAdmin(f)
  if (!web) { t.skip('openssl not available'); return }
  const page = await web('GET', '/admin?tab=apikeys')
  assert.equal(page.status, 200)
  assert.match(page.body, /Make a new key/)
  assert.match(page.body, /No API keys yet/)

  const made = await web('POST', '/admin/api-keys/create', { tab: 'apikeys', name: 'Dashboard', scope_library: '1', 'scope_now-playing': '1', ratePerMinute: '' })
  assert.equal(made.status, 303)
  const shown = await web('GET', made.headers.location)
  const token = /(beebo_pat_[0-9a-f]{12}_[A-Za-z0-9_-]{43})/.exec(shown.body)
  assert.ok(token, 'the new key is on the page it lands on')
  assert.match(shown.body, /can't be shown again/)
  assert.equal((await f.call(token[1], '/api/v1/library/movies')).status, 200)
  assert.equal((await f.call(token[1], '/api/v1/now-playing')).status, 200)

  const again = await web('GET', made.headers.location)
  assert.doesNotMatch(again.body, /beebo_pat_[0-9a-f]{12}_[A-Za-z0-9_-]{43}/, 'the flash is consumed on display')
  const tab = await web('GET', '/admin?tab=apikeys')
  assert.doesNotMatch(tab.body, /beebo_pat_[0-9a-f]{12}_[A-Za-z0-9_-]{43}/, 'and the tab itself never carries the secret')
  assert.match(tab.body, /Dashboard/)
  assert.match(tab.body, /Library, Now playing/)
  assert.match(tab.body, /last used/)

  const id = f.data.apiKeys[0].id
  const bad = await web('POST', '/admin/api-keys/create', { tab: 'apikeys', name: 'No scopes' })
  assert.equal(bad.status, 303)
  assert.match((await web('GET', bad.headers.location)).body, /Tick at least one thing/)
  assert.equal(f.data.apiKeys.length, 1)

  const removed = await web('POST', '/admin/api-keys/revoke', { tab: 'apikeys', id })
  assert.equal(removed.status, 303)
  assert.equal((await f.call(token[1], '/api/v1/library/movies')).status, 401)
})
