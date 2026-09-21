'use strict'
// Security review 2026-09-21 (L-2): POST /api/viewer-session traded a Worker viewer token for a full
// API token WITHOUT the second factor, although /api/remote-session (the same kind of Worker-vouched
// away sign-in) and /api/login both stop a person with two-factor at the code step.
// Run: node --test test/sec-viewer-exchange-2fa.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { Readable } = require('node:stream')
const auth = require('../electron/auth')
const server = require('../electron/streamServer')
const licenseToken = require('../electron/licenseToken')
const viewerExchange = require('../electron/viewerExchange')
const twoFactor = require('../electron/twoFactor')
const { createLocalAccessPolicy } = require('../electron/localAccessPolicy')

const HOUSE = 'nickhouse'
const OWNER_EMAIL = 'owner@example.com'
const KEYS = crypto.generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } })
const nowS = () => Math.floor(Date.now() / 1000)
const mint = (claims = {}) => licenseToken.signToken({ typ: 'viewer', name: HOUSE, email: OWNER_EMAIL, iat: nowS() - 5, exp: nowS() + 12 * 3600, jti: crypto.randomBytes(6).toString('hex'), ...claims }, KEYS.privateKey)
const REMOTE = { pw_hash: 'a'.repeat(64), pw_salt: 'b'.repeat(32), pw_iter: 25000 }
const TWO = { enabled: true, secret: 'JBSWY3DPEHPK3PXP', enabledAt: Date.now(), recovery: [] }

function harness(userList, extra = {}) {
  const base = { status: 'approved', adult: true, passwordHash: auth.hashPassword('Sec-viewer-exchange-pw-1') }
  const data = { authUsers: userList.map((u) => ({ ...base, ...u })), ...extra }
  const store = { data, get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] }, onDidChange: () => () => {} }
  const localAccess = createLocalAccessPolicy({ agentSecret: 'x'.repeat(64), interfaces: () => ({ eth0: [{ address: '192.168.1.5', netmask: '255.255.255.0', family: 'IPv4', internal: false, cidr: '192.168.1.5/24' }] }) })
  const ex = viewerExchange.createViewerExchange({
    store, license: { config: { publicKey: KEYS.publicKey }, evaluate: () => ({ enforced: false, serve: true, payload: { email: OWNER_EMAIL } }) },
    localAccess, makeApiToken: server.makeApiToken, userShape: (u) => ({ id: u.id, name: u.name }),
    clientIp: (req) => req.socket.remoteAddress, getHouseName: () => HOUSE, log: () => {}
  })
  const call = (token) => {
    const req = Readable.from([Buffer.from('{}')])
    req.method = 'POST'
    req.headers = { authorization: 'Bearer ' + token }
    req.socket = { remoteAddress: '192.168.1.40', encrypted: false }
    return ex.exchange(req)
  }
  return { store, call }
}

test('a person with two-factor on cannot skip the code by way of a TV viewer token', async () => {
  const h = harness([
    { id: 'owner', name: 'Owner', username: 'owner', isAdmin: true, twoFactor: TWO },
    { id: 'robin', name: 'Robin', username: 'robin', remote: REMOTE, twoFactor: TWO },
    { id: 'sam', name: 'Sam', username: 'sam', remote: REMOTE }
  ])
  let r = await h.call(mint())
  assert.deepEqual([r.status, r.body.error], [403, 'two_factor_sign_in'], 'owner with 2FA is refused')
  assert.equal(r.body.token, undefined)
  r = await h.call(mint({ via: 'member', member: 'robin' }))
  assert.deepEqual([r.status, r.body.error], [403, 'two_factor_sign_in'], 'member with 2FA is refused')
  r = await h.call(mint({ via: 'member', member: 'sam' }))
  assert.equal(r.status, 200, 'a member without 2FA still signs in as before')
})

test('the exchanged token is a tracked session: it survives an earlier sign-out-everywhere, is listed, and can be ended', async () => {
  const authSessions = require('../electron/authSessions')
  const h = harness([{ id: 'sam', name: 'Sam', username: 'sam', remote: REMOTE }])
  // Sam signed out everywhere 100 days ago. An untracked 30-day token reads as issued ~335 days ago
  // and was refused; a tracked one is judged on its own session record.
  authSessions.revokeAll(h.store, 'sam', { now: Date.now() - 100 * 86400000 })
  const r = await h.call(mint({ via: 'member', member: 'sam' }))
  assert.equal(r.status, 200)
  assert.equal(server.verifyApiToken(h.store, r.body.token), 'sam', 'the fresh token works')
  const sid = /~([A-Za-z0-9_-]{22})\./.exec(r.body.token)
  assert.ok(sid, 'the token carries a session id')
  assert.equal(authSessions.list(h.store, 'sam').length, 1, 'and shows up in the person\'s device list')
  authSessions.revokeAll(h.store, 'sam')
  assert.equal(server.verifyApiToken(h.store, r.body.token), null, 'sign out everywhere ends it')
})

test('an admin the owner policy requires to have two-factor, and who has none yet, is held like every other sign-in', async () => {
  const h = harness([{ id: 'owner', name: 'Owner', username: 'owner', isAdmin: true }])
  twoFactor.setPolicy(h.store, { requireForAdmins: true })
  assert.equal(twoFactor.setupRequired(h.store, h.store.get('authUsers')[0]), true, 'precondition: policy is on')
  const r = await h.call(mint())
  assert.deepEqual([r.status, r.body.error], [403, 'two_factor_setup_required'])
  assert.equal(r.body.token, undefined)
})
