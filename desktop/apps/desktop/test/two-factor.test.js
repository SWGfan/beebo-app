// Two-factor sign-in for local accounts: set-up, TOTP replay prevention, single-use hashed recovery codes,
// the fixed-key lockout (holds across every address, backs off, expires), login challenges, owner policy.
// Run: node --test test/two-factor.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const auth = require(path.join(__dirname, '..', 'electron', 'auth.js'))
const totp = require(path.join(__dirname, '..', 'electron', 'totp.js'))
const twoFactor = require(path.join(__dirname, '..', 'electron', 'twoFactor.js'))
const securityLog = require(path.join(__dirname, '..', 'electron', 'securityLog.js'))
const viewingPrivacy = require(path.join(__dirname, '..', 'electron', 'viewingPrivacy.js'))

function fakeStore(initial = {}) {
  const data = JSON.parse(JSON.stringify(initial))
  return { data, get: (k, d) => (k in data ? data[k] : d), set: (k, v) => { data[k] = v }, has: (k) => k in data, delete: (k) => { delete data[k] } }
}
function withClock(t, start = 1700000000000) {
  const realNow = Date.now
  let now = start
  Date.now = () => now
  t.after(() => { Date.now = realNow })
  return { advance: (ms) => (now += ms), get: () => now }
}

function world() {
  const store = fakeStore({ authUsers: [
    { id: 'u1', name: 'Ann', username: 'ann', status: 'approved', isAdmin: false, passwordHash: auth.hashPassword('lantern-copper-orbit-42') },
    { id: 'boss', name: 'Boss', username: 'boss', status: 'approved', isAdmin: true, passwordHash: auth.hashPassword('lantern-copper-orbit-43') }
  ] })
  auth.forgetSecrets()
  return store
}
const userOf = (store, id) => auth.getUsers(store).find((u) => u.id === id)

// Set two-factor up for `id` and hand back the secret and the recovery codes.
function enable(store, id = 'u1') {
  const begun = twoFactor.beginSetup(store, id)
  assert.equal(begun.ok, true)
  const done = twoFactor.confirmSetup(store, id, totp.totp(begun.secret))
  assert.equal(done.ok, true, JSON.stringify(done))
  return { secret: begun.secret, recovery: done.recoveryCodes }
}
// A code from a later step than anything used so far (advance the clock 30 s first).
const codeNow = (secret) => totp.totp(secret)

test('set-up: a fresh secret, an otpauth URI, and nothing is on until a code from the app is proven', () => {
  const store = world()
  const begun = twoFactor.beginSetup(store, 'u1')
  assert.match(begun.secret, /^[A-Z2-7]{32}$/)
  assert.equal(begun.uri, totp.otpauthUri({ secret: begun.secret, account: 'ann', issuer: 'Beebo Entertainment' }))
  assert.equal(twoFactor.isEnabled(userOf(store, 'u1')), false, 'pending only')
  assert.equal(twoFactor.confirmSetup(store, 'u1', '000000').ok, false)
  assert.equal(twoFactor.isEnabled(userOf(store, 'u1')), false)
  const done = twoFactor.confirmSetup(store, 'u1', totp.totp(begun.secret))
  assert.equal(done.ok, true)
  assert.equal(done.recoveryCodes.length, 10)
  assert.equal(new Set(done.recoveryCodes).size, 10)
  for (const code of done.recoveryCodes) assert.match(code, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/)
  assert.equal(twoFactor.isEnabled(userOf(store, 'u1')), true)
  assert.equal(twoFactor.beginSetup(store, 'u1').error, 'already_enabled', 'cannot silently replace a working secret')
})

test('an abandoned or stale set-up expires', (t) => {
  const clock = withClock(t)
  const store = world()
  const begun = twoFactor.beginSetup(store, 'u1')
  clock.advance(twoFactor.PENDING_TTL_MS + 1000)
  assert.equal(twoFactor.confirmSetup(store, 'u1', totp.totp(begun.secret, { time: clock.get() })).error, 'setup_expired')
})

test('the confirmation step is rate-limited too', (t) => {
  withClock(t)
  const store = world()
  twoFactor.beginSetup(store, 'u1')
  for (let i = 0; i < 5; i++) assert.equal(twoFactor.confirmSetup(store, 'u1', '111111').error, 'invalid_code')
  assert.equal(twoFactor.confirmSetup(store, 'u1', '111111').error, 'locked')
})

test('the secret and the recovery codes are stored encrypted-or-hashed, never in a status or a screen view', () => {
  const store = world()
  const { secret, recovery } = enable(store)
  const row = userOf(store, 'u1')
  assert.equal(row.twoFactor.secret, secret, 'the TOTP key must be readable to check codes; secretSettings encrypts the field at rest')
  const rawRecovery = JSON.stringify(row.twoFactor.recovery)
  for (const code of recovery) {
    assert.ok(!rawRecovery.includes(code) && !rawRecovery.includes(code.replace('-', '')), 'recovery codes are only stored as hashes')
  }
  assert.ok(row.twoFactor.recovery.every((r) => r.h.startsWith('scrypt$')))
  const shown = JSON.stringify([twoFactor.status(store, row), twoFactor.publicView(row), viewingPrivacy.desktopUser(row).twoFactor])
  assert.ok(!shown.includes(secret))
  assert.ok(!shown.includes('scrypt$'))
  assert.equal(twoFactor.status(store, row).recoveryRemaining, 10)
  const { DEFAULT_FIELD_SECRETS } = require(path.join(__dirname, '..', 'electron', 'secretSettings.js'))
  assert.ok(DEFAULT_FIELD_SECRETS.authUsers.fields.includes('twoFactor'), 'encrypted at rest with the rest of the row\'s secrets')
})

test('a TOTP code works once: replaying it, or an older one, is refused and counted', (t) => {
  const clock = withClock(t)
  const store = world()
  const { secret } = enable(store)
  clock.advance(30000)
  const code = codeNow(secret)
  assert.deepEqual(twoFactor.verifyCode(store, 'u1', code, { ip: '203.0.113.5' }), { ok: true, method: 'totp' })
  const replay = twoFactor.verifyCode(store, 'u1', code, { ip: '203.0.113.5' })
  assert.equal(replay.ok, false)
  assert.equal(replay.error, 'code_reused')
  // Shoulder-surfed: the same code from another address, a few seconds later, is still no good.
  clock.advance(5000)
  assert.equal(twoFactor.verifyCode(store, 'u1', code, { ip: '198.51.100.7' }).ok, false)
  // The previous step's code (still inside the drift window) is also refused after a newer one was used.
  assert.equal(twoFactor.verifyCode(store, 'u1', totp.totp(secret, { time: clock.get() - 30000 })).ok, false)
  // The next code is fine.
  clock.advance(30000)
  assert.equal(twoFactor.verifyCode(store, 'u1', codeNow(secret)).ok, true)
  assert.ok(securityLog.list(store, { userId: 'u1', type: 'two_factor_replay' }).length >= 1)
})

test('five wrong codes lock the second step for that person - from EVERY address, even for the right code', (t) => {
  const clock = withClock(t)
  const store = world()
  const { secret } = enable(store)
  clock.advance(30000)
  let last
  for (let i = 0; i < 5; i++) last = twoFactor.verifyCode(store, 'u1', '000000', { ip: `203.0.113.${i + 1}` }) // a different address each time
  assert.equal(last.justLocked, true)
  const right = twoFactor.verifyCode(store, 'u1', codeNow(secret), { ip: '192.0.2.99' })
  assert.deepEqual([right.ok, right.error], [false, 'locked'])
  assert.equal(right.minutesRemaining, 5)
  assert.equal(twoFactor.status(store, userOf(store, 'u1')).locked, true)
  // Other people are not affected.
  assert.equal(twoFactor.lockStatus(store, 'boss').locked, false)
  // A locked attempt does not extend the lock.
  clock.advance(5 * 60 * 1000 + 1000)
  assert.equal(twoFactor.verifyCode(store, 'u1', totp.totp(secret, { time: clock.get() })).ok, true, 'opens again after five minutes')
  const kinds = securityLog.list(store, { userId: 'u1' }).map((e) => e.type)
  assert.ok(kinds.includes('two_factor_locked'))
})

test('the lock backs off (5, 10, 20 ... minutes) and is forgotten after a quiet day', (t) => {
  const clock = withClock(t)
  const store = world()
  enable(store)
  const lockMinutes = () => {
    for (let i = 0; i < 5; i++) twoFactor.verifyCode(store, 'u1', '000000')
    return twoFactor.lockStatus(store, 'u1').minutesRemaining
  }
  clock.advance(30000)
  assert.equal(lockMinutes(), 5)
  clock.advance(5 * 60 * 1000 + 1)
  assert.equal(lockMinutes(), 10)
  clock.advance(10 * 60 * 1000 + 1)
  assert.equal(lockMinutes(), 20)
  clock.advance(48 * 60 * 60 * 1000)
  assert.equal(lockMinutes(), 5, 'strikes reset after a quiet day')
})

test('the lock survives a restart (it is persisted when it trips), and the owner can clear it', (t) => {
  withClock(t)
  const store = world()
  enable(store)
  for (let i = 0; i < 5; i++) twoFactor.verifyCode(store, 'u1', '000000')
  assert.ok(store.data.twoFactorLocks.u1.lockedUntil > Date.now())
  assert.equal(twoFactor.clearLock(store, 'u1'), true)
  assert.equal(twoFactor.lockStatus(store, 'u1').locked, false)
})

test('recovery codes: each works once, case and dash do not matter, the count goes down, a wrong one counts as a failure', (t) => {
  const clock = withClock(t)
  const store = world()
  const { recovery } = enable(store)
  clock.advance(30000)
  const first = twoFactor.verifyCode(store, 'u1', recovery[3].toLowerCase().replace('-', ' '), { ip: '203.0.113.1' })
  assert.deepEqual(first, { ok: true, method: 'recovery', recoveryRemaining: 9 })
  const again = twoFactor.verifyCode(store, 'u1', recovery[3])
  assert.equal(again.ok, false, 'a spent code is spent')
  assert.equal(twoFactor.verifyCode(store, 'u1', recovery[4]).ok, true)
  assert.equal(twoFactor.status(store, userOf(store, 'u1')).recoveryRemaining, 8)
  assert.equal(twoFactor.verifyCode(store, 'u1', 'AAAAA-AAAAA').ok, false)
  assert.ok(securityLog.list(store, { userId: 'u1', type: 'recovery_code_used' }).length === 2)
})

test('a code guessed as a recovery code counts towards the same lock', (t) => {
  const clock = withClock(t)
  const store = world()
  enable(store)
  clock.advance(30000)
  for (let i = 0; i < 5; i++) twoFactor.verifyCode(store, 'u1', 'ZZZZZ-ZZZZ' + i)
  assert.equal(twoFactor.verifyCode(store, 'u1', '123456').error, 'locked')
})

test('regenerating recovery codes replaces all ten; turning it off removes the secret and hashes', (t) => {
  const clock = withClock(t)
  const store = world()
  const { recovery } = enable(store)
  clock.advance(30000)
  const fresh = twoFactor.regenerateRecoveryCodes(store, 'u1')
  assert.equal(fresh.recoveryCodes.length, 10)
  assert.equal(twoFactor.verifyCode(store, 'u1', recovery[0]).ok, false, 'old codes are dead')
  assert.equal(twoFactor.verifyCode(store, 'u1', fresh.recoveryCodes[0]).ok, true)
  assert.equal(twoFactor.disable(store, 'u1').ok, true)
  assert.equal(userOf(store, 'u1').twoFactor, undefined)
  assert.equal(twoFactor.isEnabled(userOf(store, 'u1')), false)
  assert.equal(twoFactor.verifyCode(store, 'u1', '123456').error, 'not_enabled')
  const kinds = securityLog.list(store, { userId: 'u1' }).map((e) => e.type)
  assert.ok(kinds.includes('two_factor_enabled') && kinds.includes('two_factor_disabled') && kinds.includes('recovery_codes_regenerated'))
  twoFactor.disable(store, 'boss', { byOwner: true })
})

test('login challenges: signed, five minutes, tamper-proof, five tries, single use', (t) => {
  const clock = withClock(t)
  const store = world()
  enable(store)
  const token = twoFactor.issueChallenge(store, 'u1')
  const read = twoFactor.readChallenge(store, token)
  assert.equal(read.ok, true)
  assert.equal(read.userId, 'u1')
  // Tampering: swap the user, flip a signature char, truncate, garbage.
  const [payload, sig] = token.split('.')
  const evil = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), u: 'boss' })).toString('base64url')
  assert.equal(twoFactor.readChallenge(store, `${evil}.${sig}`).ok, false)
  assert.equal(twoFactor.readChallenge(store, `${payload}.${sig.slice(0, -1)}A`).ok, false)
  for (const junk of ['', 'x', 'a.b.c', null, undefined, 42, 'x'.repeat(2000)]) assert.equal(twoFactor.readChallenge(store, junk).ok, false)
  // A different server secret cannot read it (a restore that swaps the secret retires challenges).
  const other = world()
  other.data.sessionSecret = 'f'.repeat(64)
  auth.forgetSecrets()
  assert.equal(twoFactor.readChallenge(other, token).ok, false)
  auth.forgetSecrets()
  // Five wrong tries kill it.
  let dead = false
  for (let i = 0; i < twoFactor.CHALLENGE_MAX_TRIES; i++) dead = twoFactor.challengeFailed(read.nonce, read.exp)
  assert.equal(dead, true)
  assert.equal(twoFactor.readChallenge(store, token).exhausted, true)
  // Single use.
  const t2 = twoFactor.issueChallenge(store, 'u1')
  const r2 = twoFactor.readChallenge(store, t2)
  twoFactor.consumeChallenge(r2.nonce, r2.exp)
  assert.equal(twoFactor.readChallenge(store, t2).ok, false)
  // Expiry.
  const t3 = twoFactor.issueChallenge(store, 'u1')
  clock.advance(twoFactor.CHALLENGE_TTL_MS + 1000)
  assert.equal(twoFactor.readChallenge(store, t3).ok, false)
})

test('owner policy: admins must use two-factor; a member does not; policy changes are logged', () => {
  const store = world()
  assert.equal(twoFactor.setupRequired(store, userOf(store, 'boss')), false)
  twoFactor.setPolicy(store, { requireForAdmins: true })
  assert.equal(twoFactor.setupRequired(store, userOf(store, 'boss')), true)
  assert.equal(twoFactor.setupRequired(store, userOf(store, 'u1')), false)
  assert.equal(twoFactor.status(store, userOf(store, 'boss')).setupRequired, true)
  enable(store, 'boss')
  assert.equal(twoFactor.setupRequired(store, userOf(store, 'boss')), false)
  assert.equal(twoFactor.setPolicy(store, { requireForAdmins: 'yes' }).requireForAdmins, false, 'only a real true turns it on')
  assert.ok(securityLog.list(store, { type: 'policy_changed' }).length >= 2)
})

test('the second step never accepts junk input or throws', (t) => {
  const clock = withClock(t)
  const store = world()
  enable(store)
  clock.advance(30000)
  for (const junk of [undefined, null, '', '   ', {}, [], 12345678901234567890n.toString(), 'x'.repeat(5000), ' ', '123 456 789']) {
    assert.equal(twoFactor.verifyCode(store, 'u1', junk).ok, false)
  }
})
