// Password reset with no email server: the owner's one-time code, plus the hardened emailed link.
// Run: node --test test/reset-codes.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const auth = require(path.join(__dirname, '..', 'electron', 'auth.js'))
const resetCodes = require(path.join(__dirname, '..', 'electron', 'resetCodes.js'))
const securityLog = require(path.join(__dirname, '..', 'electron', 'securityLog.js'))
const twoFactor = require(path.join(__dirname, '..', 'electron', 'twoFactor.js'))
const totp = require(path.join(__dirname, '..', 'electron', 'totp.js'))

function fakeStore(initial = {}) {
  const data = JSON.parse(JSON.stringify(initial))
  return { data, get: (k, d) => (k in data ? data[k] : d), set: (k, v) => { data[k] = v }, has: (k) => k in data, delete: (k) => { delete data[k] } }
}
function withClock(t, start = 1700000000000) {
  const realNow = Date.now
  let now = start
  Date.now = () => now
  t.after(() => { Date.now = realNow })
  return { advance: (ms) => (now += ms) }
}
const OLD = 'old-lantern-copper-orbit-1'
const NEW = 'brand-new-lantern-passphrase-9'
function world(extra = []) {
  const store = fakeStore({ authUsers: [
    { id: 'u1', name: 'Ann', username: 'ann', email: 'ann@example.test', status: 'approved', passwordHash: auth.hashPassword(OLD) },
    { id: 'u2', name: 'Bob', username: 'bob', status: 'approved', passwordHash: auth.hashPassword(OLD) },
    ...extra
  ] })
  auth.forgetSecrets()
  return store
}
const row = (store, id) => auth.getUsers(store).find((u) => u.id === id)

test('the owner makes a 12-character code, shown once, stored only as a hash, with an expiry', () => {
  const store = world()
  const out = resetCodes.issue(store, 'u1')
  assert.equal(out.ok, true)
  assert.match(out.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/)
  assert.equal(out.minutes, 30)
  const stored = JSON.stringify(row(store, 'u1').resetCode)
  assert.ok(!stored.includes(out.code) && !stored.includes(out.code.replace(/-/g, '')))
  assert.ok(row(store, 'u1').resetCode.h.startsWith('scrypt$'))
  assert.equal(resetCodes.pending(store, 'u1').active, true)
  assert.equal(resetCodes.pending(store, 'u2').active, false)
  assert.ok(!JSON.stringify(securityLog.list(store)).includes(out.code), 'the code is never in the security log')
  assert.equal(resetCodes.issue(store, 'nobody').error, 'not_found')
  assert.equal(resetCodes.issue(store, 'u1', { minutes: 99999 }).minutes, 24 * 60, 'capped at a day')
})

test('redeeming sets the password, works exactly once, and signs the person out everywhere', () => {
  const store = world()
  const cookie = auth.signSession(store, 'u1', { track: true, ip: '203.0.113.4', userAgent: 'Chrome/1', method: 'password' })
  assert.equal(auth.verifySession(store, cookie), 'u1')
  const { code } = resetCodes.issue(store, 'u1')
  const out = resetCodes.redeem(store, { username: 'Ann', code: code.toLowerCase().replace(/-/g, ' '), newPassword: NEW, ip: '203.0.113.4' })
  assert.deepEqual(out, { ok: true, userId: 'u1' })
  assert.ok(auth.verifyPassword(NEW, row(store, 'u1').passwordHash))
  assert.equal(auth.verifyPassword(OLD, row(store, 'u1').passwordHash), false)
  assert.equal(row(store, 'u1').resetCode, null)
  assert.equal(auth.verifySession(store, cookie), null, 'every existing session ended')
  const again = resetCodes.redeem(store, { username: 'ann', code, newPassword: 'another-lantern-passphrase-3' })
  assert.equal(again.ok, false)
  assert.ok(auth.verifyPassword(NEW, row(store, 'u1').passwordHash), 'single use')
  const events = securityLog.list(store, { userId: 'u1' }).map((e) => e.type)
  assert.ok(events.includes('password_reset_code_issued') && events.includes('password_reset_completed') && events.includes('password_changed'))
})

test('it expires', (t) => {
  const clock = withClock(t)
  const store = world()
  const { code } = resetCodes.issue(store, 'u1', { minutes: 10 })
  clock.advance(10 * 60 * 1000 + 1000)
  assert.equal(resetCodes.pending(store, 'u1').active, false)
  assert.equal(resetCodes.redeem(store, { username: 'ann', code, newPassword: NEW }).ok, false)
  assert.ok(auth.verifyPassword(OLD, row(store, 'u1').passwordHash))
})

test('five wrong tries burn the code, even with the right one afterwards (fixed key: the code itself)', () => {
  const store = world()
  const { code } = resetCodes.issue(store, 'u1')
  for (let i = 0; i < resetCodes.MAX_TRIES; i++) {
    assert.equal(resetCodes.redeem(store, { username: 'ann', code: 'AAAA-BBBB-CCC' + i, newPassword: NEW, ip: `203.0.113.${i}` }).ok, false)
  }
  assert.equal(resetCodes.pending(store, 'u1').active, false)
  assert.equal(resetCodes.redeem(store, { username: 'ann', code, newPassword: NEW }).ok, false)
  assert.ok(auth.verifyPassword(OLD, row(store, 'u1').passwordHash))
  assert.ok(securityLog.list(store, { type: 'password_reset_locked' }).length === 1)
})

test('every refusal reads the same: no hint whether the name exists, the code was wrong, expired or used', () => {
  const store = world()
  resetCodes.issue(store, 'u1')
  const answers = [
    resetCodes.redeem(store, { username: 'ann', code: 'WRONG-WRONG-WRON', newPassword: NEW }),
    resetCodes.redeem(store, { username: 'nobody', code: 'WRONG-WRONG-WRON', newPassword: NEW }),
    resetCodes.redeem(store, { username: 'bob', code: 'WRONG-WRONG-WRON', newPassword: NEW }),
    resetCodes.redeem(store, { username: '', code: '', newPassword: NEW }),
    resetCodes.redeem(store, {})
  ]
  for (const a of answers) assert.deepEqual(a, answers[0])
})

test('the check takes the same work whether or not the person has a live code (a stand-in hash)', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'electron', 'resetCodes.js'), 'utf8')
  assert.match(source, /DUMMY_HASH/)
  assert.match(source, /verifyCode\(code, live \? rc\.h : DUMMY_HASH\)/)
  // and the comparison inside is timing-safe
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'electron', 'auth.js'), 'utf8'), /crypto\.timingSafeEqual\(candidate, expected\)/)
})

test('a weak new password is refused and does NOT spend the code', () => {
  const store = world()
  const { code } = resetCodes.issue(store, 'u1')
  const weak = resetCodes.redeem(store, { username: 'ann', code, newPassword: 'password1' })
  assert.equal(weak.ok, false)
  assert.equal(weak.error, 'weak')
  assert.equal(resetCodes.pending(store, 'u1').active, true)
  assert.equal(resetCodes.redeem(store, { username: 'ann', code, newPassword: NEW }).ok, true)
})

test('a new code replaces the old one; the owner can cancel one', () => {
  const store = world()
  const first = resetCodes.issue(store, 'u1')
  const second = resetCodes.issue(store, 'u1')
  assert.equal(resetCodes.redeem(store, { username: 'ann', code: first.code, newPassword: NEW }).ok, false)
  assert.equal(resetCodes.cancel(store, 'u1').ok, true)
  assert.equal(resetCodes.redeem(store, { username: 'ann', code: second.code, newPassword: NEW }).ok, false)
})

test('a private-history profile cannot be reset by the owner; revoked people cannot use a code', () => {
  const store = world([{ id: 'p1', name: 'Pat', username: 'pat', status: 'approved', adult: true, viewingHistoryPrivate: true, passwordHash: auth.hashPassword(OLD) }])
  assert.equal(resetCodes.issue(store, 'p1').error, 'private_profile_self_recovery')
  const { code } = resetCodes.issue(store, 'u2')
  auth.revokeUser(store, 'u2')
  assert.equal(resetCodes.redeem(store, { username: 'bob', code, newPassword: NEW }).ok, false)
})

test('a reset does not switch two-factor off: the person still needs their authenticator', () => {
  const store = world()
  const begun = twoFactor.beginSetup(store, 'u1')
  twoFactor.confirmSetup(store, 'u1', totp.totp(begun.secret))
  const { code } = resetCodes.issue(store, 'u1')
  assert.equal(resetCodes.redeem(store, { username: 'ann', code, newPassword: NEW }).ok, true)
  assert.equal(twoFactor.isEnabled(row(store, 'u1')), true)
})

test('the emailed reset link is hashed at rest, single use, expiring, and ends every session', (t) => {
  const clock = withClock(t)
  const store = world()
  const cookie = auth.signSession(store, 'u1', { track: true, ip: '203.0.113.4', userAgent: 'Chrome/1' })
  const made = auth.createPasswordResetToken(store, 'ann@example.test', { ip: '203.0.113.4' })
  assert.match(made.token, /^[0-9a-f]{48}$/)
  const stored = row(store, 'u1')
  assert.equal(stored.resetToken, null)
  assert.equal(stored.resetTokenHash, auth.hashResetToken(made.token))
  assert.ok(!JSON.stringify(store.data).includes(made.token), 'the link token itself is nowhere in config.json')
  assert.equal(auth.resetPasswordWithToken(store, 'a'.repeat(48), NEW).reason, 'invalid')
  assert.deepEqual(auth.resetPasswordWithToken(store, made.token, NEW), { ok: true })
  assert.equal(auth.verifySession(store, cookie), null)
  assert.equal(auth.resetPasswordWithToken(store, made.token, 'yet-another-lantern-pass-5').reason, 'invalid', 'single use')
  const again = auth.createPasswordResetToken(store, 'ann@example.test')
  clock.advance(2 * 60 * 60 * 1000)
  assert.equal(auth.resetPasswordWithToken(store, again.token, NEW).reason, 'expired')
  assert.equal(auth.createPasswordResetToken(store, 'nobody@example.test'), null)
})

test('a link made before the upgrade (plain resetToken) still works until it expires', () => {
  const store = world()
  auth.updateUser(store, 'u1', { resetToken: 'c'.repeat(48), resetTokenExpires: Date.now() + 60000 })
  assert.deepEqual(auth.resetPasswordWithToken(store, 'c'.repeat(48), NEW), { ok: true })
  assert.equal(row(store, 'u1').resetToken, null)
})
