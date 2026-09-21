// Security review #18: online guessing of access codes from rotating IPs.
// Per-username and server-wide limits, exponential backoff, pruning, no
// config.json rewrite per failure, 8-character codes, salted scrypt hashes.
// Run: node --test test/login-bruteforce.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const path = require('node:path')
const auth = require(path.join(__dirname, '..', 'electron', 'auth.js'))

// electron-store's surface over a plain object, counting writes.
function fakeStore(initial = {}) {
  const data = JSON.parse(JSON.stringify(initial))
  const s = {
    data,
    writes: 0,
    get: (k, d) => (k in data ? data[k] : d),
    set: (k, v) => {
      s.writes += 1
      data[k] = v
    },
    has: (k) => k in data,
    delete: (k) => {
      delete data[k]
    }
  }
  return s
}

// Date.now under test control.
function withClock(t) {
  const realNow = Date.now
  let now = realNow()
  Date.now = () => now
  t.after(() => {
    Date.now = realNow
  })
  return { advance: (ms) => (now += ms), get: () => now }
}

const ip = (i) => `203.0.${Math.floor(i / 250)}.${(i % 250) + 1}`

// The login path in streamServer.attemptLogin, reduced to the auth calls.
function attempt(store, { ip: from, username, password }) {
  const lock = auth.checkLockout(store, from, username)
  if (lock.locked) return { ok: false, locked: lock }
  const user = auth.findUserByUsernameAndSecret(store, username, password)
  if (!user) {
    auth.recordFailedLogin(store, { ip: from, username })
    return { ok: false }
  }
  auth.clearFailedLogin(store, from)
  auth.touchLastSeen(store, user.id, from)
  return { ok: true, user }
}

test('guesses at one username from rotating IPs are stopped (per-username lock)', (t) => {
  withClock(t)
  const store = fakeStore()
  const { user, code } = auth.createUser(store, 'Nick', '')
  let blocked = 0
  let tried = 0
  for (let i = 0; i < 2000; i++) {
    const r = attempt(store, { ip: ip(i), username: user.username, password: 'WRONG' + i })
    if (r.locked) blocked += 1
    else tried += 1
  }
  assert.ok(tried <= 60, `only a handful of guesses get through, got ${tried}`)
  assert.ok(blocked >= 1900)
  // Still locked for a brand-new IP, even with the right code.
  const r = attempt(store, { ip: '198.51.100.7', username: user.username, password: code })
  assert.equal(r.ok, false)
  assert.ok(['account', 'global'].includes(r.locked.scope))
})

test('the account lock backs off exponentially and expires', (t) => {
  const clock = withClock(t)
  const store = fakeStore()
  const { user, code } = auth.createUser(store, 'Ann', '')
  const lockFor = () => {
    for (let i = 0; i < 10; i++) auth.recordFailedLogin(store, { ip: ip(clock.get() % 1000 + i), username: user.username })
    return auth.checkLockout(store, '198.51.100.9', user.username)
  }
  const first = lockFor()
  assert.equal(first.locked, true)
  assert.equal(first.scope, 'account')
  clock.advance(first.remainingMs + 1)
  assert.equal(auth.checkLockout(store, '198.51.100.9', user.username).locked, false)
  const second = lockFor()
  assert.ok(second.remainingMs >= first.remainingMs * 2 - 5, `${second.remainingMs} doubles ${first.remainingMs}`)
  clock.advance(second.remainingMs + 1)
  assert.equal(attempt(store, { ip: '198.51.100.9', username: user.username, password: code }).ok, true)
})

test('the per-IP lock also backs off exponentially', (t) => {
  const clock = withClock(t)
  const store = fakeStore()
  for (let i = 0; i < 5; i++) auth.recordFailedLogin(store, { ip: '198.51.100.1', username: 'u' + i })
  const first = auth.checkLockout(store, '198.51.100.1', 'x')
  assert.equal(first.scope, 'ip')
  clock.advance(first.remainingMs + 1)
  for (let i = 0; i < 5; i++) auth.recordFailedLogin(store, { ip: '198.51.100.1', username: 'v' + i })
  const second = auth.checkLockout(store, '198.51.100.1', 'x')
  assert.equal(second.remainingMs, first.remainingMs * 2)
})

test('a server-wide failure budget stops spraying many usernames from many IPs', (t) => {
  withClock(t)
  const store = fakeStore()
  let through = 0
  for (let i = 0; i < 500; i++) {
    const r = attempt(store, { ip: ip(i), username: 'guess' + i, password: 'AAAA' })
    if (!r.locked) through += 1
  }
  assert.ok(through <= 60, `server-wide limit holds, ${through} got through`)
  assert.equal(auth.checkLockout(store, '198.51.100.3', 'someone').scope, 'global')
})

test("the person's own last-used address still gets in during an account or global lock", (t) => {
  withClock(t)
  const store = fakeStore()
  const { user, code } = auth.createUser(store, 'Owner', '')
  assert.equal(attempt(store, { ip: '100.64.1.2', username: user.username, password: code }).ok, true)
  for (let i = 0; i < 300; i++) attempt(store, { ip: ip(i), username: user.username, password: 'NOPE' })
  assert.equal(attempt(store, { ip: '198.51.100.4', username: user.username, password: code }).ok, false)
  assert.equal(attempt(store, { ip: '100.64.1.2', username: user.username, password: code }).ok, true)
})

test('failures are not written to config.json one by one, and old entries are pruned', (t) => {
  const clock = withClock(t)
  const store = fakeStore({ loginLockouts: { '192.0.2.1': { attempts: [1], lockedUntil: 2 } } })
  const before = store.writes
  for (let i = 0; i < 2000; i++) auth.recordFailedLogin(store, { ip: ip(i), username: 'nick' })
  assert.equal(store.writes - before, 0, 'no store write per failure')
  assert.equal(auth.getFailedLoginLog(store).length, 200, 'readers still see the failures')
  assert.equal(auth.flushLoginState(store), true)
  assert.ok(Object.keys(store.data.loginLockouts).length <= 1000, 'bounded')
  assert.equal(store.data.loginLockouts['192.0.2.1'], undefined, 'expired legacy entry pruned')
  assert.equal(store.data.failedLoginLog.length, 200)
  // A day later, everything has aged out.
  clock.advance(25 * 60 * 60 * 1000)
  auth.recordFailedLogin(store, { ip: '192.0.2.50', username: 'x' })
  auth.flushLoginState(store)
  assert.deepEqual(Object.keys(store.data.loginLockouts), ['192.0.2.50'])
  assert.deepEqual(Object.keys(store.data.loginAccountLockouts), ['x'])
})

test('the Admin tab lists and unlocks both kinds of lock', (t) => {
  withClock(t)
  const store = fakeStore()
  for (let i = 0; i < 10; i++) auth.recordFailedLogin(store, { ip: ip(i % 2), username: 'nick' })
  const list = auth.getActiveLockouts(store)
  assert.ok(list.some((l) => l.ip === 'account:nick'))
  assert.ok(list.some((l) => l.ip === ip(0)))
  auth.clearFailedLogin(store, 'account:nick')
  auth.clearFailedLogin(store, ip(0))
  assert.equal(auth.checkLockout(store, ip(0), 'nick').locked, false)
})

test('new codes are 8 characters from the unambiguous alphabet, hashed with salted scrypt', () => {
  const store = fakeStore()
  const { user, code } = auth.createUser(store, 'Kid', '')
  assert.match(code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/)
  assert.match(user.codeHash, /^scrypt\$\d+\$\d+\$\d+\$[0-9a-f]+\$[0-9a-f]{64}$/)
  assert.notEqual(auth.hashCode(code), auth.hashCode(code), 'salted')
  assert.equal(auth.isWeakCode(user), false)
  assert.match(auth.regenerateCode(store, user.id), /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/)
  // Best of three, so a busy test machine doesn't make this flaky.
  let ms = Infinity
  for (let i = 0; i < 3; i++) {
    const started = process.hrtime.bigint()
    assert.equal(auth.findUserByUsernameAndSecret(store, user.username, auth.getUsers(store)[0].code.toLowerCase())?.id, user.id)
    ms = Math.min(ms, Number(process.hrtime.bigint() - started) / 1e6)
  }
  assert.ok(ms < 100, `login check took ${ms} ms`)
})

test('an existing 4-character code still works, migrates to scrypt, and is flagged as weak', () => {
  const legacyHash = crypto.createHash('sha256').update('7F3K').digest('hex')
  const store = fakeStore({
    authUsers: [
      { id: 'u1', name: 'Old', username: 'old', code: '7F3K', codeHash: legacyHash, status: 'approved', isAdmin: false },
      { id: 'u2', name: 'Pw', username: 'pw', passwordHash: auth.hashPassword('longpassword'), code: null, codeHash: null, status: 'approved' }
    ]
  })
  assert.deepEqual(auth.weakCodeUsers(store).map((u) => u.username), ['old'])
  assert.equal(auth.findUserByUsernameAndSecret(store, 'old', 'ZZZZ'), null)
  assert.equal(auth.getUsers(store)[0].codeHash, legacyHash, 'no migration on a wrong code')
  assert.equal(auth.findUserByUsernameAndSecret(store, 'old', '7f3k')?.id, 'u1')
  const migrated = auth.getUsers(store)[0].codeHash
  assert.match(migrated, /^scrypt\$/)
  assert.equal(auth.findUserByUsernameAndSecret(store, 'old', '7F3K')?.id, 'u1', 'still works after migration')
  assert.equal(auth.isWeakCode(auth.getUsers(store)[0]), true, 'still short, still recommended to strengthen')
})
