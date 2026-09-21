'use strict'
// Security review A-02 .. A-04: authentication and token hygiene.
//   A-02  revoking an account also ends its sessions, so approving it again does not resurrect a stolen
//         cookie / app token (before: status alone stopped them, and reactivation brought them all back)
//   A-03  a login for a name that does not exist costs one password check, like a real one (timing oracle)
//   A-04  the Jellyfin-compatible sign-in and tokens honour the owner's "admins need two-factor" hold, and
//         a person with two-factor on cannot sign in there with the password alone
// Run: node --test test/sec-auth-tokens.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const path = require('node:path')

const electron = (f) => path.join(__dirname, '..', 'electron', f)
const auth = require(electron('auth.js'))
const authSessions = require(electron('authSessions.js'))
const twoFactor = require(electron('twoFactor.js'))
const totp = require(electron('totp.js'))
const server = require(electron('streamServer.js'))
const { createAuth } = require(electron('jellyfin/auth.js'))
const { createIds } = require(electron('jellyfin/ids.js'))
const { withServer } = require('./security-harness')

function fakeStore(initial = {}) {
  const data = JSON.parse(JSON.stringify(initial))
  return { data, get: (k, d) => (k in data ? data[k] : d), set: (k, v) => { data[k] = v }, has: (k) => k in data, delete: (k) => { delete data[k] } }
}
function withClock(t) {
  const realNow = Date.now
  let now = realNow()
  Date.now = () => now
  t.after(() => { Date.now = realNow })
  return { advance: (ms) => (now += ms) }
}
const PW = 'lantern-copper-orbit-42'
function world() {
  const store = fakeStore({ authUsers: [
    { id: 'u1', name: 'Ann', username: 'ann', status: 'approved', passwordHash: auth.hashPassword(PW) },
    { id: 'boss', name: 'Boss', username: 'boss', status: 'approved', isAdmin: true, passwordHash: auth.hashPassword(PW + '3') }
  ] })
  auth.forgetSecrets()
  return store
}
const sess = { track: true, ip: '203.0.113.9', userAgent: 'Mozilla/5.0 Chrome/126 Windows', method: 'password' }
const reapprove = (store, id) => store.set('authUsers', store.get('authUsers').map((u) => (u.id === id ? { ...u, status: 'approved' } : u)))

// ---- A-02 ----------------------------------------------------------------------------------------------
test('A-02: revoking then re-approving an account does not bring old cookies and tokens back', (t) => {
  const clock = withClock(t)
  const store = world()
  const cookieTracked = auth.signSession(store, 'u1', sess)
  const cookieLegacy = auth.signSession(store, 'u1')
  const tokenTracked = server.makeApiToken(store, 'u1', 365, sess)
  const tokenLegacy = server.makeApiToken(store, 'u1')
  assert.equal(auth.verifySession(store, cookieTracked), 'u1')
  assert.equal(server.verifyApiToken(store, tokenTracked), 'u1')

  clock.advance(10)
  auth.revokeUser(store, 'u1')
  assert.equal(auth.verifySession(store, cookieTracked), null, 'revoked: stopped by status')
  clock.advance(10)
  reapprove(store, 'u1')

  assert.equal(auth.verifySession(store, cookieTracked), null, 'tracked cookie stays dead after re-approval')
  assert.equal(auth.verifySession(store, cookieLegacy), null, 'legacy cookie stays dead after re-approval')
  assert.equal(server.verifyApiToken(store, tokenTracked), null, 'tracked app token stays dead after re-approval')
  assert.equal(server.verifyApiToken(store, tokenLegacy), null, 'legacy app token stays dead after re-approval')
  assert.deepEqual(authSessions.list(store, 'u1'), [])

  // A sign-in made AFTER the re-approval is fine, and other people are untouched.
  clock.advance(10)
  assert.equal(auth.verifySession(store, auth.signSession(store, 'u1', sess)), 'u1')
  assert.equal(server.verifyApiToken(store, server.makeApiToken(store, 'u1')), 'u1')
})

test('A-02: revoking one person leaves another person\'s sessions alone', (t) => {
  const clock = withClock(t)
  const store = world()
  const boss = auth.signSession(store, 'boss', sess)
  clock.advance(5)
  auth.revokeUser(store, 'u1')
  assert.equal(auth.verifySession(store, boss), 'boss')
})

// ---- A-03 ----------------------------------------------------------------------------------------------
test('A-03: an unknown username costs a password check, the same as a known one', () => {
  const store = world()
  const real = crypto.scryptSync
  let calls = 0
  crypto.scryptSync = function (...args) { calls++; return real.apply(this, args) }
  try {
    assert.equal(auth.findUserByUsernameAndSecret(store, 'ann', 'wrong-password-entirely'), null)
    const known = calls
    assert.ok(known >= 1, 'a known name is checked')
    calls = 0
    assert.equal(auth.findUserByUsernameAndSecret(store, 'nobody-here', 'wrong-password-entirely'), null)
    const unknown = calls
    assert.ok(unknown >= 1, 'an unknown name must also pay for a check (was ' + unknown + ')')
    calls = 0
    // The right password still works, and only pays once.
    assert.equal(auth.findUserByUsernameAndSecret(store, 'ann', PW).id, 'u1')
    assert.equal(calls, 1)
  } finally { crypto.scryptSync = real }
})

// ---- A-04 ----------------------------------------------------------------------------------------------
function jellyfinAuth(store) {
  const host = {
    makeApiToken: (s, id) => server.makeApiToken(s, id),
    verifyApiToken: (s, tok) => server.verifyApiToken(s, tok),
    getUser: (id) => auth.getUsers(store).find((u) => u && u.id === id) || null,
    // What streamServer.attemptLogin does for a person with two-factor on and no code sent.
    attemptLogin: async ({ username, password }) => {
      const u = auth.findUserByUsernameAndSecret(store, username, password)
      if (!u) return { ok: false, reason: 'bad_credentials' }
      if (twoFactor.isEnabled(u)) return { ok: false, reason: 'two_factor_required' }
      return { ok: true, user: u, method: 'password' }
    }
  }
  return createAuth({ store, host, ids: createIds(store) })
}
const DEVICE = { id: 'd1', name: 'TV', client: 'Jellyfin', version: '1' }

test('A-04: an admin held for two-factor set-up cannot sign in, use an old token, or redeem Quick Connect on the Jellyfin API', async () => {
  const store = world()
  const jf = jellyfinAuth(store)
  // Before the policy: fine.
  const before = await jf.login({ username: 'boss', password: PW + '3', device: DEVICE, ip: '127.0.0.1' })
  assert.equal(before.ok, true)
  const oldToken = before.body.AccessToken
  assert.ok(jf.userForToken(oldToken))

  twoFactor.setPolicy(store, { requireForAdmins: true })
  const held = await jf.login({ username: 'boss', password: PW + '3', device: DEVICE, ip: '127.0.0.1' })
  assert.equal(held.ok, false, 'sign-in refused while the admin has no two-factor')
  assert.equal(jf.userForToken(oldToken), null, 'a token made before the policy is held too')

  // Quick Connect: a code approved as the held admin gives nothing when the TV redeems it.
  const init = jf.quickConnectInitiate({ device: DEVICE, ip: '127.0.0.1' })
  assert.equal(init.ok, true)
  const bossRow = auth.getUsers(store).find((u) => u.id === 'boss')
  assert.equal(jf.quickConnectAuthorize(bossRow, init.body.Code).ok, true)
  assert.equal(jf.quickConnectRedeem({ secret: init.body.Secret, device: DEVICE, ip: '127.0.0.1' }), null, 'held admin: Quick Connect redeems nothing')
  // A person who is not held can still use everything.
  const ann = await jf.login({ username: 'ann', password: PW, device: DEVICE, ip: '127.0.0.1' })
  assert.equal(ann.ok, true)
  assert.ok(jf.userForToken(ann.body.AccessToken))

  // Turning the policy off releases the admin again.
  twoFactor.setPolicy(store, { requireForAdmins: false })
  assert.ok(jf.userForToken(oldToken))
})

test('A-04: a held admin who completes two-factor set-up is released', async () => {
  const store = world()
  const jf = jellyfinAuth(store)
  twoFactor.setPolicy(store, { requireForAdmins: true })
  assert.equal((await jf.login({ username: 'boss', password: PW + '3', device: DEVICE, ip: '127.0.0.1' })).ok, false)
  const begun = twoFactor.beginSetup(store, 'boss')
  assert.equal(twoFactor.confirmSetup(store, 'boss', totp.totp(begun.secret)).ok, true)
  // Two-factor is on now: the password alone still does not sign in over Jellyfin (there is no code step there).
  assert.equal((await jf.login({ username: 'boss', password: PW + '3', device: DEVICE, ip: '127.0.0.1' })).ok, false)
})

const jfHeaders = { 'content-type': 'application/json', 'x-emby-authorization': 'MediaBrowser Client="t", Device="d", DeviceId="i", Version="1"' }

test('A-04 (real server): Jellyfin AuthenticateByName never signs in a two-factor account on the password alone, and honours the admin hold', async () => {
  await withServer({}, async ({ store, user, raw }) => {
    store.set('jellyfinCompat', true)
    auth.setUserPassword(store, user.id, PW)
    const login = () => raw({ method: 'POST', pathname: '/Users/AuthenticateByName', headers: jfHeaders, body: { Username: 'owner', Pw: PW } })
    let r = await login()
    assert.equal(r.status, 200, 'baseline: an admin without two-factor and without the policy signs in: ' + r.text)
    const tokenBefore = r.json.AccessToken
    const me = (tok) => raw({ method: 'GET', pathname: '/Users/Me', headers: { 'x-emby-token': tok } })
    assert.equal((await me(tokenBefore)).status, 200)

    // The owner requires two-factor for admins and this admin has none: held.
    twoFactor.setPolicy(store, { requireForAdmins: true })
    r = await login()
    assert.equal(r.status, 401, 'held admin must not sign in')
    assert.equal((await me(tokenBefore)).status, 401, 'and an earlier Jellyfin token stops working')
    twoFactor.setPolicy(store, { requireForAdmins: false })

    // Two-factor on: the password alone is refused (fail closed), whatever the policy.
    const begun = twoFactor.beginSetup(store, user.id)
    assert.equal(twoFactor.confirmSetup(store, user.id, totp.totp(begun.secret)).ok, true)
    r = await login()
    assert.equal(r.status, 401, 'two-factor account: password alone is not enough')
  })
})
