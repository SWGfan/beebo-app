// Signed-in devices: a record per sign-in, individual revoke, "sign out everywhere" (which also ends
// cookies and tokens made without a record), and the desktop app's own trusted windows.
// Run: node --test test/auth-sessions.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const auth = require(path.join(__dirname, '..', 'electron', 'auth.js'))
const authSessions = require(path.join(__dirname, '..', 'electron', 'authSessions.js'))
const securityLog = require(path.join(__dirname, '..', 'electron', 'securityLog.js'))

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
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const PHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'

function world() {
  const store = fakeStore({ authUsers: [
    { id: 'u1', name: 'Ann', username: 'ann', status: 'approved', passwordHash: auth.hashPassword('lantern-copper-orbit-42') },
    { id: 'u2', name: 'Bob', username: 'bob', status: 'approved', passwordHash: auth.hashPassword('lantern-copper-orbit-43') }
  ] })
  auth.forgetSecrets()
  return store
}
const cookieOf = (store, userId, ua = CHROME, ip = '203.0.113.9') => auth.signSession(store, userId, { track: true, ip, userAgent: ua, method: 'password' })
const sidOf = (cookie) => auth.parseSessionCookie(cookie).sid

test('a tracked cookie is listed with a device label and a masked address, and never the raw sid', () => {
  const store = world()
  const cookie = cookieOf(store, 'u1')
  assert.equal(auth.verifySession(store, cookie), 'u1')
  const rows = authSessions.list(store, 'u1', { currentSid: sidOf(cookie) })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].device, 'Chrome on Windows')
  assert.equal(rows[0].ip, '203.0.113.0', 'last octet of a public address is masked')
  assert.equal(rows[0].current, true)
  assert.ok(!JSON.stringify(store.data).includes(sidOf(cookie)), 'only a hash of the session id is stored')
  assert.ok(!JSON.stringify(rows).includes(sidOf(cookie)))
  assert.deepEqual(authSessions.list(store, 'u2'), [])
})

test('device labels are coarse, and the raw User-Agent is not kept', () => {
  assert.equal(authSessions.deviceLabel(PHONE), 'Safari on iOS')
  assert.equal(authSessions.deviceLabel('Dalvik/2.1.0 (Linux; U; Android 14)'), 'Beebo app on Android')
  assert.equal(authSessions.deviceLabel(''), 'Unknown device')
  const store = world()
  cookieOf(store, 'u1', CHROME + ' secret-looking-suffix')
  assert.ok(!JSON.stringify(store.data.authSessions).includes('secret-looking-suffix'))
})

test('revoking one device ends exactly that cookie; a copy of it stops working', () => {
  const store = world()
  const laptop = cookieOf(store, 'u1', CHROME)
  const phone = cookieOf(store, 'u1', PHONE)
  const rows = authSessions.list(store, 'u1', { currentSid: sidOf(laptop) })
  const phoneRow = rows.find((r) => r.device.includes('iOS'))
  assert.equal(authSessions.revoke(store, 'u1', phoneRow.id).ok, true)
  assert.equal(auth.verifySession(store, phone), null)
  assert.equal(auth.verifySession(store, laptop), 'u1')
  assert.equal(authSessions.revoke(store, 'u1', phoneRow.id).ok, false, 'already gone')
})

test('one person cannot revoke another person\'s session, or guess a handle', () => {
  const store = world()
  const annCookie = cookieOf(store, 'u1')
  const handle = authSessions.list(store, 'u1')[0].id
  assert.equal(authSessions.revoke(store, 'u2', handle).ok, false)
  assert.equal(authSessions.revoke(store, 'u1', '../etc/passwd').ok, false)
  assert.equal(authSessions.revoke(store, 'u1', '').ok, false)
  assert.equal(auth.verifySession(store, annCookie), 'u1')
})

test('sign out everywhere ends tracked AND legacy cookies (the cut-off), but not other people', (t) => {
  const clock = withClock(t)
  const store = world()
  const legacy = auth.signSession(store, 'u1')
  const tracked = cookieOf(store, 'u1')
  const bob = cookieOf(store, 'u2')
  assert.equal(auth.verifySession(store, legacy), 'u1')
  clock.advance(1000)
  const result = authSessions.revokeAll(store, 'u1')
  assert.equal(result.ended, 1)
  assert.equal(auth.verifySession(store, legacy), null, 'a cookie with no record is ended by the cut-off')
  assert.equal(auth.verifySession(store, tracked), null)
  assert.equal(auth.verifySession(store, bob), 'u2')
  clock.advance(1000)
  assert.equal(auth.verifySession(store, auth.signSession(store, 'u1')), 'u1', 'a cookie made afterwards works')
})

test('sign out everywhere except this device keeps the one you name', () => {
  const store = world()
  const keep = cookieOf(store, 'u1', CHROME)
  const other = cookieOf(store, 'u1', PHONE)
  authSessions.revokeAll(store, 'u1', { exceptSid: sidOf(keep) })
  assert.equal(auth.verifySession(store, keep), 'u1')
  assert.equal(auth.verifySession(store, other), null)
})

test('desktop cookies (the owner\'s own windows) are not listed and survive "sign out everywhere"', (t) => {
  const clock = withClock(t)
  const store = world()
  const desktop = auth.signSession(store, 'u1', { desktop: true })
  assert.equal(auth.verifySession(store, desktop), 'u1')
  assert.deepEqual(authSessions.list(store, 'u1'), [])
  clock.advance(500)
  authSessions.revokeAll(store, 'u1')
  assert.equal(auth.verifySession(store, desktop), 'u1')
  assert.equal(auth.parseSessionCookie(desktop).desktop, true)
})

test('a tampered or re-labelled cookie fails: the sid is part of what is signed', () => {
  const store = world()
  const cookie = cookieOf(store, 'u1')
  const [uid, exp, sid, sig] = cookie.split('.')
  assert.equal(auth.verifySession(store, [uid, exp, 'desktop', sig].join('.')), null, 'cannot turn a tracked cookie into a desktop one')
  assert.equal(auth.verifySession(store, [uid, exp, sid.slice(0, -1) + (sid.endsWith('A') ? 'B' : 'A'), sig].join('.')), null)
  assert.equal(auth.verifySession(store, [uid, exp, sig].join('.')), null, 'dropping the sid fails the signature')
  assert.equal(auth.verifySession(store, 'a.b.c.d.e'), null)
})

test('expired records stop working and are pruned; each person keeps only their newest 50', (t) => {
  const clock = withClock(t)
  const store = world()
  const cookie = cookieOf(store, 'u1')
  clock.advance(366 * 24 * 60 * 60 * 1000)
  assert.equal(auth.verifySession(store, cookie), null)
  const s2 = world()
  for (let i = 0; i < authSessions.MAX_PER_USER + 5; i++) cookieOf(s2, 'u1')
  assert.equal(authSessions.list(s2, 'u1').length, authSessions.MAX_PER_USER)
})

test('the list survives a restart (read back from the store) and a restore resets it', () => {
  const store = world()
  const cookie = cookieOf(store, 'u1')
  authSessions.reset() // like a fresh process: nothing in memory
  assert.equal(auth.verifySession(store, cookie), 'u1')
  assert.equal(authSessions.list(store, 'u1').length, 1)
  // Restoring a backup clears the in-memory copy and re-reads the store.
  store.data.authSessions = []
  auth.forgetSecrets()
  assert.equal(auth.verifySession(store, cookie), null)
})

test('deleting a person forgets their sessions; revoked accounts stop at once', () => {
  const store = world()
  const cookie = cookieOf(store, 'u1')
  auth.revokeUser(store, 'u1')
  assert.equal(auth.verifySession(store, cookie), null)
  auth.deleteUser(store, 'u1')
  assert.deepEqual(authSessions.list(store, 'u1'), [])
})

test('changing a password (any route) signs every other device out and logs it', () => {
  const store = world()
  const a = cookieOf(store, 'u1', CHROME)
  const b = cookieOf(store, 'u1', PHONE)
  assert.deepEqual(auth.setUserPassword(store, 'u1', 'brand-new-lantern-passphrase-9'), { ok: true })
  assert.equal(auth.verifySession(store, a), null)
  assert.equal(auth.verifySession(store, b), null)
  const events = securityLog.list(store, { userId: 'u1' })
  assert.ok(events.some((e) => e.type === 'password_changed'))
})

test('the last-seen time is refreshed on use and throttled', (t) => {
  const clock = withClock(t)
  const store = world()
  const cookie = cookieOf(store, 'u1')
  const first = authSessions.list(store, 'u1')[0].lastSeenAt
  clock.advance(5000)
  auth.verifySession(store, cookie)
  assert.equal(authSessions.list(store, 'u1')[0].lastSeenAt, first, 'no refresh inside the throttle window')
  clock.advance(60000)
  auth.verifySession(store, cookie)
  assert.ok(authSessions.list(store, 'u1')[0].lastSeenAt > first)
})
