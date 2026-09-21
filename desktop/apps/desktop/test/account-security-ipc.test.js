// The owner's account-security controls over IPC: policy, reset codes (with and without email), disabling
// two-factor for someone who lost their phone, sessions, the log - and no secret ever crosses to the screen.
// Run: node --test test/account-security-ipc.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const auth = require(path.join(__dirname, '..', 'electron', 'auth.js'))
const totp = require(path.join(__dirname, '..', 'electron', 'totp.js'))
const twoFactor = require(path.join(__dirname, '..', 'electron', 'twoFactor.js'))
const resetCodes = require(path.join(__dirname, '..', 'electron', 'resetCodes.js'))
const securityIpc = require(path.join(__dirname, '..', 'electron', 'accountSecurityIpc.js'))

function fakeStore(initial = {}) {
  const data = JSON.parse(JSON.stringify(initial))
  return { data, get: (k, d) => (k in data ? data[k] : d), set: (k, v) => { data[k] = v }, has: (k) => k in data, delete: (k) => { delete data[k] } }
}

function setup({ mail } = {}) {
  const store = fakeStore({ authUsers: [
    { id: 'boss', name: 'Boss', username: 'boss', status: 'approved', isAdmin: true, passwordHash: auth.hashPassword('lantern-copper-orbit-42') },
    { id: 'ann', name: 'Ann', username: 'ann', email: 'ann@example.test', status: 'approved', passwordHash: auth.hashPassword('lantern-copper-orbit-43') },
    { id: 'gone', name: 'Gone', username: 'gone', status: 'revoked', passwordHash: auth.hashPassword('lantern-copper-orbit-44') }
  ] })
  auth.forgetSecrets()
  const handlers = {}
  securityIpc.register({ ipcMain: { handle: (name, fn) => { handlers[name] = fn } }, store, mailer: mail, getServerUrls: () => ['http://192.168.1.20:47811'] })
  const call = (name, arg) => handlers[name]({}, arg)
  return { store, handlers, call }
}

test('every channel the preload exposes has a handler, and vice versa', () => {
  const { handlers } = setup()
  const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8')
  const used = [...preload.matchAll(/ipcRenderer\.invoke\('(security:[A-Za-z0-9]+)'/g)].map((m) => m[1]).sort()
  assert.deepEqual(used, Object.keys(handlers).sort())
})

test('the overview lists approved people with a summary of two-factor, never a secret or hash', async () => {
  const { store, call } = setup()
  const begun = twoFactor.beginSetup(store, 'ann')
  const done = twoFactor.confirmSetup(store, 'ann', totp.totp(begun.secret))
  resetCodes.issue(store, 'boss')
  const o = await call('security:overview')
  assert.deepEqual(o.users.map((u) => u.username).sort(), ['ann', 'boss'], 'revoked people are not listed')
  const ann = o.users.find((u) => u.id === 'ann')
  assert.equal(ann.twoFactor.enabled, true)
  assert.equal(ann.twoFactor.recoveryRemaining, 10)
  assert.equal(o.users.find((u) => u.id === 'boss').resetCode.active, true)
  const text = JSON.stringify(o)
  assert.ok(!text.includes(begun.secret) && !text.includes('scrypt$'))
  for (const code of done.recoveryCodes) assert.ok(!text.includes(code))
  assert.equal(o.serverUrl, 'http://192.168.1.20:47811')
  assert.equal(o.mailConfigured, false)
})

test('policy toggles and is logged; the log can be read, filtered and cleared', async () => {
  const { call } = setup()
  assert.equal((await call('security:setPolicy', { requireForAdmins: true })).policy.requireForAdmins, true)
  assert.equal((await call('security:setPolicy', { requireForAdmins: 'true' })).policy.requireForAdmins, false)
  const all = await call('security:events', {})
  assert.ok(all.events.some((e) => e.type === 'policy_changed'))
  assert.deepEqual((await call('security:events', { severity: 'alert' })).events, [])
  await call('security:clearEvents')
  assert.deepEqual((await call('security:events', {})).events, [])
})

test('a reset code comes back once with a link that keeps the code out of the query string', async () => {
  const { store, call } = setup()
  const out = await call('security:makeResetCode', { userId: 'ann', minutes: 10 })
  assert.equal(out.ok, true)
  assert.match(out.code, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){2}$/)
  assert.equal(out.minutes, 10)
  assert.equal(out.emailed, false)
  const url = new URL(out.link)
  assert.equal(url.pathname, '/reset-with-code')
  assert.equal(url.searchParams.get('u'), 'ann')
  assert.equal(url.search.includes(out.code), false, 'the code is in the fragment, which browsers never send')
  assert.equal(url.hash, '#c=' + out.code)
  assert.equal(resetCodes.redeem(store, { username: 'ann', code: out.code, newPassword: 'a-brand-new-lantern-passphrase-7' }).ok, true)
  assert.equal((await call('security:makeResetCode', { userId: 'gone' })).ok, false)
  assert.equal((await call('security:makeResetCode', { userId: 'nobody' })).error, 'not_found')
  assert.equal((await call('security:cancelResetCode', { userId: 'boss' })).ok, true)
})

test('with email set up the owner can also have it mailed; without it nothing is sent', async () => {
  const sent = []
  const mail = { isConfigured: () => true, sendMail: async (_s, msg) => { sent.push(msg); return { ok: true } } }
  const { call } = setup({ mail })
  const out = await call('security:makeResetCode', { userId: 'ann', email: true })
  assert.equal(out.emailed, true)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].to, 'ann@example.test')
  assert.ok(sent[0].text.includes(out.code))
  assert.ok(sent[0].text.includes('192.168.1.20:47811/reset-with-code'))
  // Not asked for: not sent.
  await call('security:makeResetCode', { userId: 'ann' })
  assert.equal(sent.length, 1)
  // Someone with no address: nothing to send to.
  const none = await call('security:makeResetCode', { userId: 'boss', email: true })
  assert.equal(none.emailed, false)
  // And with no mail server at all.
  const bare = setup({ mail: { isConfigured: () => false, sendMail: async () => { throw new Error('should not be called') } } })
  assert.equal((await bare.call('security:makeResetCode', { userId: 'ann', email: true })).emailed, false)
})

test('the owner can turn two-factor off for someone who lost their phone, and clear a lock', async () => {
  const { store, call } = setup()
  const begun = twoFactor.beginSetup(store, 'ann')
  twoFactor.confirmSetup(store, 'ann', totp.totp(begun.secret))
  for (let i = 0; i < 5; i++) twoFactor.verifyCode(store, 'ann', '000000')
  assert.equal(twoFactor.lockStatus(store, 'ann').locked, true)
  assert.equal((await call('security:unlockTwoFactor', { userId: 'ann' })).cleared, true)
  assert.equal(twoFactor.lockStatus(store, 'ann').locked, false)
  assert.equal((await call('security:disableTwoFactor', { userId: 'ann' })).ok, true)
  assert.equal(twoFactor.isEnabled(auth.getUsers(store).find((u) => u.id === 'ann')), false)
  assert.equal((await call('security:disableTwoFactor', { userId: 'nobody' })).error, 'not_found')
  const log = (await call('security:events', {})).events.map((e) => e.type)
  assert.ok(log.includes('two_factor_disabled_by_owner') && log.includes('two_factor_unlocked'))
})

test('the owner sets up two-factor for their own admin account here; other accounts are refused', async () => {
  const { store, call } = setup()
  const denied = await call('security:twoFactorBegin', { userId: 'ann' })
  assert.equal(denied.error, 'admin_only')
  const begun = await call('security:twoFactorBegin', { userId: 'boss' })
  assert.equal(begun.ok, true)
  assert.match(begun.uri, /^otpauth:\/\//)
  assert.match(begun.qrSvg, /^<svg /)
  const secret = /secret=([A-Z2-7]+)/.exec(begun.uri)[1]
  assert.equal((await call('security:twoFactorConfirm', { userId: 'boss', code: '000000' })).ok, false)
  const done = await call('security:twoFactorConfirm', { userId: 'boss', code: totp.totp(secret) })
  assert.equal(done.ok, true)
  assert.equal(done.recoveryCodes.length, 10)
  assert.equal(twoFactor.isEnabled(auth.getUsers(store).find((u) => u.id === 'boss')), true)
})

test("the owner can list and end anyone's sessions", async () => {
  const { store, call } = setup()
  const cookie = auth.signSession(store, 'ann', { track: true, ip: '203.0.113.5', userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/126.0', method: 'password' })
  const listed = await call('security:sessions', { userId: 'ann' })
  assert.equal(listed.sessions.length, 1)
  const gone = await call('security:revokeSession', { userId: 'ann', id: listed.sessions[0].id })
  assert.equal(gone.ok, true)
  assert.equal(auth.verifySession(store, cookie), null)
  const c2 = auth.signSession(store, 'ann', { track: true, ip: '203.0.113.5', userAgent: 'Firefox/120', method: 'password' })
  await call('security:revokeAllSessions', { userId: 'ann' })
  assert.equal(auth.verifySession(store, c2), null)
  assert.equal((await call('security:sessions', { userId: 'nobody' })).ok, false)
})

test('the user list the desktop screen receives carries a summary of two-factor, not the secret', () => {
  const { store } = setup()
  const begun = twoFactor.beginSetup(store, 'ann')
  twoFactor.confirmSetup(store, 'ann', totp.totp(begun.secret))
  resetCodes.issue(store, 'ann')
  const viewingPrivacy = require(path.join(__dirname, '..', 'electron', 'viewingPrivacy.js'))
  const shown = auth.getUsers(store).map(viewingPrivacy.desktopUser).find((u) => u.id === 'ann')
  assert.deepEqual(Object.keys(shown.twoFactor).sort(), ['enabled', 'enabledAt', 'recoveryRemaining'])
  assert.equal(shown.resetCode, undefined)
  assert.ok(!JSON.stringify(shown).includes(begun.secret))
})
