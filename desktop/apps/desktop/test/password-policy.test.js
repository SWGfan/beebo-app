// Password strength and the offline breached-password check: no network, a small bundled list,
// the usual tweaks caught, long passphrases left alone, and the rule wired into every place a
// password is chosen.
// Run: node --test test/password-policy.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const policy = require(path.join(__dirname, '..', 'electron', 'passwordPolicy.js'))
const { COMMON_PASSWORDS } = require(path.join(__dirname, '..', 'electron', 'commonPasswords.js'))
const auth = require(path.join(__dirname, '..', 'electron', 'auth.js'))

function fakeStore(initial = {}) {
  const data = JSON.parse(JSON.stringify(initial))
  return { data, get: (k, d) => (k in data ? data[k] : d), set: (k, v) => { data[k] = v }, has: (k) => k in data, delete: (k) => { delete data[k] } }
}

test('the bundled list is small, lower-case and free of duplicates', () => {
  assert.ok(COMMON_PASSWORDS.length > 300 && COMMON_PASSWORDS.length < 5000)
  assert.equal(new Set(COMMON_PASSWORDS).size, COMMON_PASSWORDS.length)
  for (const w of COMMON_PASSWORDS) assert.equal(w, w.toLowerCase())
})

test('it never touches the network', () => {
  for (const file of ['passwordPolicy.js', 'commonPasswords.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'electron', file), 'utf8')
    assert.doesNotMatch(source, /require\(['"](?:https?|net|dns|node:https?|node:net|node:dns)['"]\)|fetch\(|XMLHttpRequest/)
  }
})

test('the most-breached passwords are refused, including the usual disguises', () => {
  for (const pw of ['password', 'Password1', 'PASSWORD123', 'p4ssw0rd', 'P@ssw0rd!', 'qwerty123', 'letmein', 'Welcome1!', 'iloveyou', 'Dragon2024', 'abc1234']) {
    const r = policy.checkPassword(pw)
    assert.equal(r.ok, false, pw)
    assert.ok(r.issues.some((i) => i.code === 'breached'), pw)
    assert.equal(policy.isBreached(pw), true, pw)
  }
})

test('runs of one character and obvious sequences are refused', () => {
  for (const pw of ['aaaaaaaa', '11111111', 'abcdefgh', '87654321', 'qwertyui']) {
    assert.equal(policy.checkPassword(pw).ok, false, pw)
  }
})

test('too short is refused with the old wording; the owner floor can be lowered', () => {
  assert.equal(policy.checkPassword('Xk9!v').issues[0].message, 'Password must be at least 8 characters.')
  assert.equal(policy.refusal('Xk9!v'), 'Password must be at least 8 characters.')
  assert.equal(policy.checkPassword('Xk9!vq', { minLength: 6 }).ok, true)
  assert.equal(policy.refusal('x'.repeat(300)), 'Password must be at most 256 characters.')
  assert.equal(policy.refusal(undefined), 'Password must be at least 8 characters.')
})

test('a password built from the name or username is refused', () => {
  assert.ok(policy.checkPassword('samplehouse86!', { username: 'samplehouse86' }).issues.some((i) => i.code === 'personal'))
  assert.ok(policy.checkPassword('Nick-Will-2024', { name: 'Nick Will' }).issues.some((i) => i.code === 'personal'))
  assert.equal(policy.checkPassword('purple-elephant-tuesday-samplehouse', { username: 'samplehouse' }).ok, true, 'a long passphrase is fine')
})

test('a long passphrase is not caught by a dictionary word inside it, and scores well', () => {
  const r = policy.checkPassword('correct horse battery staple')
  assert.equal(r.ok, true)
  assert.ok(r.score >= 3, `score ${r.score}`)
  assert.equal(policy.checkPassword('my-password-is-a-secret-tuesday').ok, true)
})

test('the strength meter orders good above bad and always explains a refusal', () => {
  const weak = policy.checkPassword('password')
  const fair = policy.checkPassword('Hq7#nd2x')
  const strong = policy.checkPassword('lantern-copper-orbit-42-Waffles')
  assert.ok(weak.score < fair.score || weak.score <= 1)
  assert.ok(strong.score >= 3)
  assert.equal(policy.LABELS.length, 5)
  assert.ok(weak.issues[0].message.length > 10)
})

test('every route to a new password is checked: signup, owner set, owner bootstrap, email reset', () => {
  const store = fakeStore()
  assert.equal(auth.createSignup(store, { username: 'newperson', email: 'n@example.test', password: 'password123' }).error.includes('most commonly used'), true)
  assert.match(auth.createSignup(store, { username: 'newperson', email: 'n@example.test', password: 'short' }).error, /at least 8/)
  assert.ok(auth.createSignup(store, { username: 'newperson', email: 'n@example.test', password: 'lantern-copper-orbit-42' }).user)

  const owner = fakeStore()
  assert.match(auth.createOwner(owner, { username: 'boss', password: 'letmein' }).error, /commonly used/)
  assert.ok(auth.createOwner(owner, { username: 'boss', password: 'Hq7#nd' }).user, 'the 6-character floor for the first owner is kept')

  const s2 = fakeStore({ authUsers: [{ id: 'u1', name: 'Ann', username: 'ann', email: 'ann@example.test', status: 'approved', passwordHash: auth.hashPassword('old-password-value-1') }] })
  assert.match(auth.setUserPassword(s2, 'u1', 'qwerty123').error, /commonly used/)
  assert.deepEqual(auth.setUserPassword(s2, 'u1', 'lantern-copper-orbit-42'), { ok: true })
  const reset = auth.createPasswordResetToken(s2, 'ann@example.test')
  assert.match(auth.resetPasswordWithToken(s2, reset.token, 'password1').reason, /commonly used/)
  assert.deepEqual(auth.resetPasswordWithToken(s2, reset.token, 'another-good-passphrase-7'), { ok: true })
})
