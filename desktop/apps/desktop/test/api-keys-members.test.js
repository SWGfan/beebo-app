'use strict'
// Per-user API keys: a person makes and removes their own, with only the scopes their role allows;
// the owner sees everyone's; nobody touches anyone else's. Real server over a fixture library.
// Run: node --test test/api-keys-members.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const apiKeys = require('../electron/apiKeys')
const { createFixture, AGENT_SECRET } = require('./helpers/publicApiFixture')

// The self-service routes need a secure connection like Admin does; the desktop agent key is the local way in.
const me = (f, who, route, body) => f.call(who, route, { method: body === undefined ? 'GET' : 'POST', body, headers: { 'X-Beebo-Agent-Key': AGENT_SECRET } })

test('a member makes their own key: library and history only, secret shown once', async (t) => {
  const f = await createFixture(t)
  const listed = await me(f, 'member', '/api/me/api-keys')
  assert.equal(listed.status, 200)
  assert.deepEqual(listed.body.scopes, ['library', 'history'], 'what a member may grant')
  assert.equal(listed.body.maxKeys, apiKeys.MAX_KEYS_MEMBER)
  assert.deepEqual(listed.body.keys, [])

  const made = await me(f, 'member', '/api/me/api-keys/create', { name: 'My phone shortcut', scopes: ['library', 'history'] })
  assert.equal(made.status, 200, made.text)
  assert.match(made.body.token, /^beebo_pat_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/)
  assert.equal(made.body.key.ownerUserId, 'member')

  // The key acts as the member: their library, their own history, nothing of the owner's.
  const idx = await f.call(made.body.token, '/api/v1')
  assert.equal(idx.status, 200)
  assert.deepEqual(idx.body.auth.scopes, ['library', 'history'])
  assert.equal((await f.call(made.body.token, '/api/v1/library/movies')).status, 200)
  assert.equal((await f.call(made.body.token, '/api/v1/history')).status, 200)

  const again = await me(f, 'member', '/api/me/api-keys')
  assert.equal(again.body.keys.length, 1)
  assert.doesNotMatch(again.text, /hash|beebo_pat_[0-9a-f]{12}_[A-Za-z0-9_-]{43}/, 'the list never carries the secret')
})

test('scope enforcement: a member cannot ask for now-playing or metrics, and a default key is library only', async (t) => {
  const f = await createFixture(t)
  for (const scope of ['now-playing', 'metrics']) {
    const r = await me(f, 'member', '/api/me/api-keys/create', { name: 'Sneaky', scopes: ['library', scope] })
    assert.equal(r.status, 400, scope)
    assert.equal(r.body.error, 'scope_not_allowed')
    assert.equal(r.body.scope, scope)
  }
  assert.equal((await me(f, 'member', '/api/me/api-keys/create', { name: 'Nonsense', scopes: ['admin'] })).body.error, 'bad_key_scope')
  assert.equal(f.data.apiKeys, undefined, 'nothing was made')
  const plain = await me(f, 'member', '/api/me/api-keys/create', { name: 'Default' })
  assert.deepEqual(plain.body.key.scopes, ['library'])

  // An admin's own key may carry all of them.
  const admin = await me(f, 'owner', '/api/me/api-keys/create', { name: 'Dashboard', scopes: ['library', 'now-playing', 'metrics'] })
  assert.equal(admin.status, 200, admin.text)
  assert.deepEqual(admin.body.key.scopes, ['library', 'now-playing', 'metrics'])
})

test('a scope stored on a key is checked again on every request against what its owner may hold', async (t) => {
  const f = await createFixture(t)
  // A row written by hand (or by an older build) that gives a member a scope they may not have.
  const made = apiKeys.create(f.store, { name: 'Tampered', ownerUserId: 'member', scopes: ['library', 'now-playing', 'metrics'] })
  assert.equal(made.ok, true, 'the storage layer alone does not know roles')
  const idx = await f.call(made.token, '/api/v1')
  assert.deepEqual(idx.body.auth.scopes, ['library'], 'the request path drops what the member may not hold')
  assert.equal((await f.call(made.token, '/api/v1/now-playing')).status, 403)
  assert.equal((await f.call(made.token, '/api/v1/events')).status, 403)
  assert.equal((await f.call(made.token, '/api/v1/metrics')).status, 403)
})

test('removing keys: your own only, and someone else\'s looks like it does not exist', async (t) => {
  const f = await createFixture(t)
  const mine = await me(f, 'member', '/api/me/api-keys/create', { name: 'Mine' })
  const other = await me(f, 'admin2', '/api/me/api-keys/create', { name: 'Theirs' })
  const owners = await me(f, 'owner', '/api/me/api-keys/create', { name: 'Owner\'s' })

  const wrong = await me(f, 'member', '/api/me/api-keys/revoke', { id: other.body.key.id })
  assert.equal(wrong.status, 404, 'not 403: a member cannot even learn which ids exist')
  assert.equal(wrong.body.error, 'not_found')
  assert.equal((await f.call(other.body.token, '/api/v1/library/movies')).status, 200, 'and the other key is untouched')

  const ok = await me(f, 'member', '/api/me/api-keys/revoke', { id: mine.body.key.id })
  assert.equal(ok.status, 200)
  assert.equal((await f.call(mine.body.token, '/api/v1/library/movies')).status, 401, 'gone at once')
  assert.equal((await me(f, 'member', '/api/me/api-keys')).body.keys.length, 0)

  // Each person's own list shows only their keys; the owner's admin list shows everyone's, with names.
  assert.deepEqual((await me(f, 'admin2', '/api/me/api-keys')).body.keys.map((k) => k.name), ['Theirs'])
  const all = await f.admin('/api/admin/api-keys')
  assert.deepEqual(all.body.keys.map((k) => k.name).sort(), ['Owner\'s', 'Theirs'])
  assert.ok(all.body.keys.every((k) => k.ownerName), 'the owner sees whose each one is')

  // The owner can remove anyone's.
  const rem = await f.admin('/api/admin/api-keys/revoke', { id: other.body.key.id })
  assert.equal(rem.status, 200)
  assert.equal((await f.call(other.body.token, '/api/v1/library/movies')).status, 401)
  assert.equal((await f.call(owners.body.token, '/api/v1/library/movies')).status, 200)
})

test('who may make keys: not a limited profile, not a key, and only over a secure connection', async (t) => {
  const f = await createFixture(t)
  const kid = await me(f, 'kid', '/api/me/api-keys/create', { name: 'Kid key' })
  assert.equal(kid.status, 403, 'a profile under parental limits')
  assert.equal(kid.body.error, 'not_available')
  assert.equal((await me(f, 'kid', '/api/me/api-keys')).status, 403)

  const plain = await f.call('member', '/api/me/api-keys/create', { method: 'POST', body: { name: 'Over plain http' } })
  assert.equal(plain.status, 403)
  assert.equal(plain.body.error, 'https_required', 'the secret is shown once, so not over a connection anyone can read')
  assert.equal(f.data.apiKeys, undefined)

  const made = await me(f, 'member', '/api/me/api-keys/create', { name: 'Real' })
  const viaKey = await f.call(made.body.token, '/api/me/api-keys/create', { method: 'POST', body: { name: 'Key makes key' }, headers: { 'X-Beebo-Agent-Key': AGENT_SECRET } })
  assert.equal(viaKey.status, 403)
  assert.equal(viaKey.body.error, 'api_key_scope', 'a key can never make more keys')
  assert.equal(f.data.apiKeys.length, 1)
  assert.equal((await me(f, 'member', '/api/me/api-keys', undefined)).status, 200)
  assert.equal((await f.call(null, '/api/me/api-keys')).status, 401)
})

test('per-person cap: a member holds 10, an admin 25, and one person\'s keys do not count against another', async (t) => {
  const f = await createFixture(t)
  for (let i = 0; i < apiKeys.MAX_KEYS_MEMBER; i++) assert.equal((await me(f, 'member', '/api/me/api-keys/create', { name: 'k' + i })).status, 200)
  const over = await me(f, 'member', '/api/me/api-keys/create', { name: 'one too many' })
  assert.equal(over.status, 400)
  assert.equal(over.body.error, 'too_many_keys')
  assert.equal((await me(f, 'admin2', '/api/me/api-keys/create', { name: 'their first' })).status, 200, 'the other person is not affected')
})

test('a restricted owner\'s key stops working; a deleted account\'s keys are removed with it', async (t) => {
  const f = await createFixture(t)
  const made = await me(f, 'member', '/api/me/api-keys/create', { name: 'Mine' })
  assert.equal((await f.call(made.body.token, '/api/v1/library/movies')).status, 200)
  const parental = require('../electron/parentalControls')
  parental.setPolicy(f.store, 'member', parental.presetPolicy('kids'))
  assert.equal((await f.call(made.body.token, '/api/v1/library/movies')).status, 401, 'put under parental limits: the key is off')

  assert.equal(apiKeys.removeOwnedBy(f.store, 'member'), 1)
  assert.equal((await f.call(made.body.token, '/api/v1/library/movies')).status, 401)
})

test('web: "My API keys" page lets a member make and remove their own key, and never lists anyone else\'s', async (t) => {
  const { webAdmin } = require('./helpers/publicApiFixture')
  const f = await createFixture(t)
  const member = webAdmin(f, 'member')
  if (!member) { t.skip('openssl not available'); return }
  const owner = webAdmin(f, 'owner')
  const ownerKey = (await me(f, 'owner', '/api/me/api-keys/create', { name: 'Owner dashboard', scopes: ['library', 'now-playing'] })).body

  const page = await member('GET', '/my-api-keys')
  assert.equal(page.status, 200)
  assert.match(page.body, /API keys/)
  assert.match(page.body, /name="scope" value="library"/)
  assert.match(page.body, /name="scope" value="history"/)
  assert.doesNotMatch(page.body, /value="now-playing"|value="metrics"/, 'a member is not offered the owner\'s scopes')
  assert.match(page.body, /No API keys yet/)
  assert.doesNotMatch(page.body, /Owner dashboard/)
  assert.match(page.body, /href="\/my-api-keys"/, 'it is in the navigation')

  const made = await member('POST', '/my-api-keys', undefined, { action: 'create', name: 'Phone shortcut', scopes: ['library', 'history'] })
  assert.equal(made.status, 200, made.body)
  const created = JSON.parse(made.body)
  assert.match(created.token, /^beebo_pat_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/)
  assert.equal((await f.call(created.token, '/api/v1/library/movies')).status, 200)
  const after = await member('GET', '/my-api-keys')
  assert.match(after.body, /Phone shortcut/)
  assert.doesNotMatch(after.body, /beebo_pat_[0-9a-f]{12}_[A-Za-z0-9_-]{43}/, 'the page never carries a secret')

  const tooMuch = await member('POST', '/my-api-keys', undefined, { action: 'create', name: 'Greedy', scopes: ['now-playing'] })
  assert.equal(tooMuch.status, 400)
  assert.equal(JSON.parse(tooMuch.body).error, 'scope_not_allowed')
  const foreign = await member('POST', '/my-api-keys', undefined, { action: 'revoke', id: ownerKey.key.id })
  assert.equal(foreign.status, 404, 'not theirs')
  assert.equal((await f.call(ownerKey.token, '/api/v1/library/movies')).status, 200)
  assert.equal((await member('POST', '/my-api-keys', undefined, { action: 'nonsense' })).status, 400)
  const asForm = await member('POST', '/my-api-keys', { action: 'create', name: 'form post' })
  assert.equal(asForm.status, 415, 'JSON only, so a cross-site form cannot make a key')

  const gone = await member('POST', '/my-api-keys', undefined, { action: 'revoke', id: created.key.id })
  assert.equal(gone.status, 200)
  assert.equal((await f.call(created.token, '/api/v1/library/movies')).status, 401)

  // The owner's own page offers all four, and they still see only their own keys there.
  const ownerPage = await owner('GET', '/my-api-keys')
  assert.match(ownerPage.body, /value="now-playing"/)
  assert.match(ownerPage.body, /value="metrics"/)
  assert.match(ownerPage.body, /Owner dashboard/)
})

test('web: "My API keys" is for signed-in people, and not for a profile under parental limits', async (t) => {
  const { webAdmin } = require('./helpers/publicApiFixture')
  const f = await createFixture(t)
  const kid = webAdmin(f, 'kid')
  if (!kid) { t.skip('openssl not available'); return }
  const page = await kid('GET', '/my-api-keys')
  assert.equal(page.status, 200)
  assert.match(page.body, /not available on a profile with parental limits/)
  assert.doesNotMatch(page.body, /key-form/)
  const made = await kid('POST', '/my-api-keys', undefined, { action: 'create', name: 'Kid key' })
  assert.equal(made.status, 403)
  assert.equal(f.data.apiKeys, undefined)
  const anon = await fetch(f.base + '/my-api-keys', { redirect: 'manual' })
  assert.equal(anon.status, 302)
  assert.match(anon.headers.get('location'), /login/)
})
