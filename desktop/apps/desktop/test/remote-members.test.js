// The member list the Worker holds must be re-pushed on a timer, not only when
// the PC's own list changes: otherwise anything written there by someone else
// (security review 2026-09-16, finding 1) would stay for ever.
// Run: node --test test/remote-members.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { createRequire } = require('node:module')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))
const rm = localRequire('./electron/remoteMembers')

const H = 3600 * 1000

test('a changed list is always due', () => {
  assert.equal(rm.memberPushDue({ sig: 'b', lastSig: 'a', lastAt: 1000, now: 1001 }), true)
})

test('an unchanged list is due again once the last good push is six hours old', () => {
  const t0 = 1_700_000_000_000
  assert.equal(rm.REMOTE_MEMBERS_REPUSH_MS, 6 * H)
  assert.equal(rm.memberPushDue({ sig: 'a', lastSig: 'a', lastAt: t0, now: t0 + 5 * H }), false)
  assert.equal(rm.memberPushDue({ sig: 'a', lastSig: 'a', lastAt: t0, now: t0 + 6 * H }), true)
  // Never pushed successfully: due.
  assert.equal(rm.memberPushDue({ sig: 'a', lastSig: 'a', lastAt: 0, now: t0 }), true)
  // A clock that went backwards doesn't wedge it either.
  assert.equal(rm.memberPushDue({ sig: 'a', lastSig: 'a', lastAt: t0 + 10 * H, now: t0 }), true)
})

test('the re-push check runs often enough that six hours is never missed by much', () => {
  assert.ok(rm.REMOTE_MEMBERS_CHECK_MS > 0 && rm.REMOTE_MEMBERS_CHECK_MS <= H)
})

test('main.js wires the timer and the age check into the push', () => {
  const src = require('node:fs').readFileSync(path.join(appRoot, 'electron', 'main.js'), 'utf8')
  assert.match(src, /memberPushDue\(/)
  assert.match(src, /setInterval\(\s*\(\)\s*=>\s*schedulePushRemoteMembers\(/)
})

// A family member's own password has to work away from home the moment the owner
// sets it. Before this it only worked after that person had signed in on the home
// computer once, so someone who had never used the computer was told, away from
// home, that their password was wrong (Owner, 2026-09-17).
test('a password the owner sets is usable away from home straight away', () => {
  const auth = localRequire('./electron/auth')
  const data = {}
  const store = { get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] }, onDidChange: () => () => {} }
  const { user } = auth.createUser(store, 'Kid', 'kid@example.com')

  // Password first, away-from-home access afterwards: the usual order on the Users screen.
  assert.equal(auth.setUserPassword(store, user.id, 'a good password').ok, true)
  const afterPw = auth.getUsers(store).find((u) => u.id === user.id)
  assert.ok(afterPw.remoteLogin && afterPw.remoteLogin.pw_hash, 'hashed for away-from-home at once')

  // Once away-from-home access is on, that hash is what goes up to beebo.tv.
  const withRemote = auth.getUsers(store).map((u) => (u.id === user.id
    ? { ...u, status: 'approved', remote: rm.hashRemotePass(rm.generateRemotePass()) }
    : u))
  const entry = rm.buildMemberList(withRemote).find((m) => m.username === afterPw.username)
  assert.ok(entry, 'in the pushed list')
  assert.ok(entry.login_hash && entry.login_salt && entry.login_iter, 'their own password goes up with it')

  // Changing the password replaces the hash, so the old one stops working away too.
  const before = auth.getUsers(store).find((u) => u.id === user.id).remoteLogin.pw_hash
  auth.setUserPassword(store, user.id, 'a different password')
  const after = auth.getUsers(store).find((u) => u.id === user.id).remoteLogin.pw_hash
  assert.notEqual(after, before)
})
