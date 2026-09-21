'use strict'
// POST /api/viewer-session: a Worker viewer token (worker/tvPair.js) for a normal API token.
// Unit tests of the verifier and the route with a fake clock, then a real stream server, then the
// real Worker's pairing flow feeding a real server.
// Run: node --test test/viewer-exchange.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { Readable } = require('node:stream')
const { pathToFileURL } = require('node:url')
const auth = require('../electron/auth')
const parental = require('../electron/parentalControls')
const server = require('../electron/streamServer')
const licenseToken = require('../electron/licenseToken')
const viewerExchange = require('../electron/viewerExchange')
const { createLocalAccessPolicy } = require('../electron/localAccessPolicy')

const PASSWORD = 'Viewer-exchange-test-password-9'
const OWNER_EMAIL = 'owner@example.com'
const HOUSE = 'nickhouse'
const AGENT_SECRET = crypto.randomBytes(32).toString('hex')
const KEYS = crypto.generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
})
const OTHER_KEYS = crypto.generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
})
const nowS = () => Math.floor(Date.now() / 1000)
const REMOTE = { pw_hash: 'a'.repeat(64), pw_salt: 'b'.repeat(32), pw_iter: 25000 }

// signToken is licenseToken's: same wire format, byte for byte, as worker.js signToken (asserted below).
const mint = (claims = {}, key = KEYS.privateKey) => licenseToken.signToken({ typ: 'viewer', name: HOUSE, email: OWNER_EMAIL, iat: nowS() - 5, exp: nowS() + 12 * 3600, jti: crypto.randomBytes(6).toString('hex'), ...claims }, key)
const mintMember = (member, claims = {}) => mint({ via: 'member', member, ...claims })
const licence = (extra = {}) => ({ config: { publicKey: KEYS.publicKey }, evaluate: () => ({ enforced: false, serve: true, payload: { email: OWNER_EMAIL }, ...extra }) })

function users() {
  const base = { status: 'approved', adult: true, passwordHash: auth.hashPassword(PASSWORD) }
  return [
    { id: 'owner', name: 'Owner', username: 'owner', isAdmin: true, ...base },
    { id: 'robin', name: 'Robin', username: 'robin', ...base, remote: REMOTE },
    { id: 'sam', name: 'Sam', username: 'sam', ...base },
    { id: 'old', name: 'Old', username: 'old', ...base, status: 'revoked', remote: REMOTE },
    { id: 'adm2', name: 'Second admin', username: 'adm2', isAdmin: true, ...base, remote: REMOTE },
    { id: 'hidden', name: 'Hidden', username: 'hidden', ...base, viewingHistoryPrivate: true, remote: REMOTE },
    { id: 'kid', name: 'Kid', username: 'kid', status: 'approved', passwordHash: auth.hashPassword(PASSWORD), remote: REMOTE }
  ]
}
function makeStore(extra = {}) {
  const data = { authUsers: users(), ...extra }
  const store = { data, get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] }, onDidChange: () => () => {} }
  parental.setPolicy(store, 'kid', parental.presetPolicy('kids'))
  return store
}

// ---------------------------------------------------------------- the route without a server

const LAN_IFACES = () => ({ eth0: [{ address: '192.168.1.5', netmask: '255.255.255.0', family: 'IPv4', internal: false, cidr: '192.168.1.5/24' }] })
const localAccess = createLocalAccessPolicy({ agentSecret: AGENT_SECRET, interfaces: LAN_IFACES })
const userShape = (u) => ({ id: u.id, name: u.name, isAdmin: !!u.isAdmin })

function harness({ store = makeStore(), lic = licence(), house = HOUSE, clock = { t: Date.now() } } = {}) {
  const logs = []
  let ipOverride = null
  const ex = viewerExchange.createViewerExchange({
    store, license: lic, localAccess, makeApiToken: server.makeApiToken, userShape,
    clientIp: (req) => ipOverride || req.socket.remoteAddress,
    getHouseName: () => house, log: (m) => logs.push(String(m)), now: () => clock.t
  })
  const call = ({ token, headers = {}, body, method = 'POST', ip = '192.168.1.40', encrypted = false, socketIp } = {}) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))])
    req.method = method
    req.headers = { ...(token ? { authorization: 'Bearer ' + token } : {}), ...headers }
    req.socket = { remoteAddress: socketIp || ip, encrypted }
    ipOverride = ip
    return ex.exchange(req)
  }
  return { ex, store, logs, call, clock }
}

// A LAN peer, a public peer on TLS, a public peer on plain http, and the host agent's tunnel.
const LAN = {}
const DIRECT_TLS = { ip: '203.0.113.9', encrypted: true }
const INTERNET_PLAIN = { ip: '203.0.113.9', encrypted: false }
const TUNNEL = { ip: '127.0.0.1', headers: { 'x-beebo-agent-key': AGENT_SECRET, 'x-beebo-remote-path': 'direct' } }

test('the token the real Worker signs verifies here, byte for byte the same wire format', { skip: require('./helpers/privateParts').skipIfMissing('worker/worker.js') }, async () => {
  const { _test } = await import(pathToFileURL(path.resolve(__dirname, '..', '..', '..', '..', 'worker', 'worker.js')).href)
  const payload = { typ: 'viewer', name: HOUSE, email: OWNER_EMAIL, iat: nowS(), exp: nowS() + 12 * 3600 }
  const fromWorker = await _test.signToken(payload, KEYS.privateKey)
  const fromDesktop = licenseToken.signToken(payload, KEYS.privateKey)
  assert.equal(fromWorker, fromDesktop, 'Ed25519 is deterministic: same bytes')
  const v = viewerExchange.verifyViewerToken(fromWorker, { publicKey: KEYS.publicKey })
  assert.equal(v.ok, true)
  assert.deepEqual(v.claims, { name: HOUSE, email: OWNER_EMAIL, via: 'owner', member: '', exp: payload.exp })
})

test('verifyViewerToken: what is accepted, and the fixed reason for everything else', () => {
  const t = nowS()
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const sig = (bytes) => crypto.sign(null, bytes, KEYS.privateKey).toString('base64url')
  const forge = (o) => { const bytes = Buffer.from(JSON.stringify(o)); return bytes.toString('base64url') + '.' + sig(bytes) }
  const good = mint()
  const [gp, gs] = good.split('.')
  const flip = (s) => s.slice(0, 10) + (s[10] === 'A' ? 'B' : 'A') + s.slice(11)
  const table = [
    ['owner', good, true],
    ['member', mintMember('robin'), true],
    ['iat a few seconds ahead of this clock: within the skew', mint({ iat: t + 30 }), true],
    ['tampered payload, original signature', flip(gp) + '.' + gs, 'bad_signature'],
    ['tampered signature', gp + '.' + flip(gs), 'bad_signature'],
    ['signed by another key', mint({}, OTHER_KEYS.privateKey), 'bad_signature'],
    ['expired', mint({ exp: t - 1 }), 'expired'],
    ['expires this second', mint({ exp: t }), 'expired'],
    ['not yet valid', mint({ iat: t + 3600, exp: t + 7200 }), 'not_yet_valid'],
    ['no iat', mint({ iat: undefined }), 'malformed'],
    ['no exp', mint({ exp: undefined }), 'malformed'],
    ['exp is a string', mint({ exp: String(t + 100) }), 'malformed'],
    ['absurdly far exp', mint({ exp: t + 40 * 86400 }), 'lifetime'],
    ['exp not after iat', mint({ iat: t + 50, exp: t + 40 }), 'lifetime'],
    ['iat far in the past, exp still 40 days after it', mint({ iat: t - 40 * 86400, exp: t + 3600 }), 'lifetime'],
    ['licence token', mint({ typ: undefined, type: 'subscription', expiresAt: t + 86400 }), 'wrong_kind'],
    ['licence token with an email', licenseToken.signToken({ type: 'subscription', email: OWNER_EMAIL, deviceId: 'dev_x', expiresAt: t + 86400 }, KEYS.privateKey), 'wrong_kind'],
    ['rewards token', mint({ typ: 'rewards' }), 'wrong_kind'],
    ['ad_reward token', mint({ typ: 'ad_reward' }), 'wrong_kind'],
    ['vpn token', mint({ typ: 'vpn', vpnLicenseId: 'v1', householdId: 'h1', maxDevices: 6, wgPublicKey: 'A'.repeat(43) + '=' }), 'wrong_kind'],
    ['wallet_act token', mint({ typ: 'wallet_act', act: 'x' }), 'wrong_kind'],
    ['a payload with no typ at all', licenseToken.signToken({ name: HOUSE, email: OWNER_EMAIL, iat: t, exp: t + 60 }, KEYS.privateKey), 'wrong_kind'],
    ['payload is an array', forge([1, 2]), 'malformed'],
    ['unknown via', mint({ via: 'admin' }), 'unknown_via'],
    ['member with a bad name', mintMember('a b'), 'malformed'],
    ['member with no name', mint({ via: 'member' }), 'malformed'],
    ['no name', mint({ name: '' }), 'malformed'],
    ['no email', mint({ email: undefined }), 'malformed'],
    ['a Beebo API token', server.makeApiToken(makeStore(), 'owner'), 'malformed'],
    ['no dot', 'abcdef', 'malformed'],
    ['three parts', good + '.abc', 'malformed'],
    ['padding characters', gp + '=.' + gs, 'malformed'],
    ['empty', '', 'malformed'],
    ['huge', 'A'.repeat(5000) + '.' + 'B'.repeat(10), 'malformed'],
    ['short signature', gp + '.' + gs.slice(0, 40), 'malformed'],
    ['not a string', 12345, 'malformed']
  ]
  for (const [label, token, want] of table) {
    const v = viewerExchange.verifyViewerToken(token, { publicKey: KEYS.publicKey, nowS: t })
    if (want === true) assert.equal(v.ok, true, label)
    else assert.deepEqual([v.ok, v.reason], [false, want], label)
  }
  assert.equal(viewerExchange.verifyViewerToken(good, { publicKey: '' }).ok, false, 'no key to trust: nothing verifies')
  assert.equal(b64({ a: 1 }).includes('.'), false)
})

test('a guest and a household pass verify as what they are, so the route can refuse them by name', () => {
  const g = viewerExchange.verifyViewerToken(mint({ via: 'guest', share: 'sh_0123456789abcdef', guest: 'jo@example.com' }), { publicKey: KEYS.publicKey })
  const h = viewerExchange.verifyViewerToken(mint({ via: 'household' }), { publicKey: KEYS.publicKey })
  assert.equal(g.claims.via, 'guest')
  assert.equal(h.claims.via, 'household')
})

test('route: owner and member sign in as themselves; the token is a normal API token, 30 days, never admin for a member', async () => {
  const h = harness()
  let r = await h.call({ token: mint(), body: { deviceName: 'Den TV' } })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.deepEqual(r.body.user, { id: 'owner', name: 'Owner', isAdmin: true })
  assert.equal(r.body.server.name, HOUSE)
  assert.equal(server.verifyApiToken(h.store, r.body.token), 'owner', 'verifyApiToken accepts it: an ordinary API token')
  const exp = Number(r.body.token.split('.').slice(-2)[0])
  assert.equal(r.body.expiresAt, Math.floor(exp / 1000), 'expiresAt is the token\'s own expiry, in unix seconds')
  assert.ok(Math.abs((exp - Date.now()) / 86400000 - viewerExchange.SESSION_DAYS) < 0.01, `${viewerExchange.SESSION_DAYS} days, not the 365 of a password sign-in`)

  r = await h.call({ token: mintMember('robin') })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.user, { id: 'robin', name: 'Robin', isAdmin: false })
  assert.equal(server.verifyApiToken(h.store, r.body.token), 'robin')
  assert.equal(JSON.stringify(r.body).includes(mint().split('.')[0]), false, 'the viewer token is never echoed')
})

test('route: the person must still exist, be approved, and (a member) still have away access', async () => {
  const h = harness()
  const ask = (member) => h.call({ token: mintMember(member) })
  assert.equal((await ask('robin')).status, 200)
  const cases = [['sam', 'never had away access'], ['old', 'revoked'], ['ghost', 'unknown to this server']]
  for (const [m, label] of cases) {
    const r = await ask(m)
    assert.deepEqual([r.status, r.body.error], [403, 'no_remote_access'], label)
  }
  auth.clearUserRemoteAccess(h.store, 'robin')
  assert.equal((await ask('robin')).body.error, 'no_remote_access', 'away access revoked after pairing')
  auth.setUserRemoteAccess(h.store, 'robin')
  assert.equal((await ask('robin')).status, 200)
  auth.deleteUser(h.store, 'robin')
  assert.equal((await ask('robin')).body.error, 'no_remote_access', 'deleted after pairing')
  const solo = harness({ store: makeStore({ authUsers: users().filter((u) => u.id !== 'adm2') }) })
  assert.equal((await solo.call({ token: mint() })).status, 200)
  auth.revokeUser(solo.store, 'owner')
  assert.equal((await solo.call({ token: mint() })).body.error, 'no_remote_access', 'no approved admin left: nobody is the owner')
  const two = await h.call({ token: mint() })
  assert.equal(two.body.user.id, 'owner', 'with two admins the first is the owner, as /api/remote-session decides')
})

test('route: never an admin through the member door, never a household pass or a share guest, never a private profile', async () => {
  const h = harness()
  const admin = await h.call({ token: mintMember('adm2') })
  assert.deepEqual([admin.status, admin.body.error], [403, 'admin_requires_password'])
  const household = await h.call({ token: mint({ via: 'household' }) })
  assert.deepEqual([household.status, household.body.error], [403, 'household_pass'])
  const guest = await h.call({ token: mint({ via: 'guest', share: 'sh_0123456789abcdef', guest: 'jo@example.com' }) })
  assert.deepEqual([guest.status, guest.body.error], [403, 'guest_not_supported'])
  const hidden = await h.call({ token: mintMember('hidden') })
  assert.deepEqual([hidden.status, hidden.body.error], [403, 'private_profile_sign_in'])
  for (const r of [admin, household, guest, hidden]) assert.equal(r.body.token, undefined)
  assert.equal((await h.call({ token: mint() })).body.user.isAdmin, true, 'the owner keeps what /api/login gives the owner')
})

test('route: another house, another account, and a server with no house or licence identity are refused', async () => {
  const cases = [
    ['another house', harness(), mint({ name: 'otherhouse' })],
    ['same house name, a different account', harness(), mint({ email: 'stranger@example.com' })],
    ['this server has no house name yet', harness({ house: '' }), mint()],
    ['this server has no licence email', harness({ lic: licence({ payload: {} }) }), mint()],
    ['this server has no licence at all', harness({ lic: null }), mint()],
    ['this server cannot name the Worker key', harness({ lic: { config: {}, evaluate: () => ({ payload: { email: OWNER_EMAIL } }) } }), mint()]
  ]
  for (const [label, h, token] of cases) {
    const r = await h.call({ token })
    assert.deepEqual([r.status, r.body], [401, { ok: false, error: 'unauthorized' }], label)
  }
  const h = harness({ house: 'NickHouse'.toLowerCase() })
  assert.equal((await h.call({ token: mint({ email: '  OWNER@example.com ' }) })).status, 200, 'e-mail compared normalised')
})

test('route: with enforcement off (a dev build) the house account still comes from the signed stored licence, never from an unsigned one', async () => {
  const stored = (key, email) => ({
    config: { publicKey: KEYS.publicKey }, evaluate: () => ({ enforced: false, serve: true }),
    getToken: () => licenseToken.signToken({ type: 'subscription', email, expiresAt: nowS() + 86400 }, key)
  })
  assert.equal((await harness({ lic: stored(KEYS.privateKey, OWNER_EMAIL) }).call({ token: mint() })).status, 200)
  assert.equal((await harness({ lic: stored(OTHER_KEYS.privateKey, OWNER_EMAIL) }).call({ token: mint() })).status, 401)
  assert.equal((await harness({ lic: stored(KEYS.privateKey, 'stranger@example.com') }).call({ token: mint() })).status, 401)
})

test('route: every verification failure is the same 401, byte for byte; the reason goes only to the log', async () => {
  const h = harness()
  const t = nowS()
  const bad = [
    undefined, 'garbage', 'a.b', mint({ exp: t - 5 }), mint({}, OTHER_KEYS.privateKey), mint({ typ: 'rewards' }),
    mint({ name: 'otherhouse' }), mint({ email: 'x@example.com' }), mint({ iat: t + 999, exp: t + 5000 }), mint({ exp: t + 90 * 86400 }),
    server.makeApiToken(h.store, 'owner'), mint({ via: 'zzz' })
  ]
  const seen = new Set()
  let n = 0
  for (const token of bad) {
    const r = await h.call({ token, ip: '198.51.100.' + ++n, encrypted: true })
    assert.equal(r.status, 401)
    assert.equal(r.headers, undefined)
    seen.add(JSON.stringify(r.body))
  }
  assert.deepEqual([...seen], ['{"ok":false,"error":"unauthorized"}'])
  const reasons = h.logs.join('\n')
  for (const code of ['no_bearer', 'malformed', 'expired', 'bad_signature', 'wrong_kind', 'other_house', 'other_account', 'not_yet_valid', 'lifetime', 'unknown_via']) assert.match(reasons, new RegExp('refused: ' + code), code)
})

test('route: the token is read from the Authorization header only', async () => {
  const h = harness()
  const token = mint()
  for (const [label, o] of [
    ['token in the body, no header', { body: { token } }],
    ['token in the body as viewerToken', { body: { viewerToken: token, deviceName: 'TV' } }],
    ['Basic scheme', { headers: { authorization: 'Basic ' + token } }],
    ['no scheme', { headers: { authorization: token } }],
    ['Bearer with nothing', { headers: { authorization: 'Bearer ' } }],
    ['two tokens', { headers: { authorization: 'Bearer ' + token + ' ' + token } }],
    ['token with a newline', { headers: { authorization: 'Bearer ' + token + '\nX: y' } }],
    ['a huge header', { headers: { authorization: 'Bearer ' + 'A'.repeat(9000) } }]
  ]) {
    const r = await h.call({ ip: '192.168.1.' + (10 + Math.floor(Math.random() * 200)), ...o })
    assert.equal(r.status, 401, label)
    assert.deepEqual(r.body, { ok: false, error: 'unauthorized' }, label)
  }
  assert.equal((await h.call({ headers: { authorization: 'bearer ' + token } })).status, 200, 'the scheme is case-insensitive')
})

test('route: methods, master switches and the request body', async () => {
  const h = harness()
  for (const m of ['GET', 'HEAD', 'PUT', 'DELETE']) {
    const r = await h.call({ token: mint(), method: m })
    assert.equal(r.status, 405, m)
    assert.deepEqual(r.headers, { Allow: 'POST' })
  }
  assert.equal((await h.call({ token: mint(), body: '{not json' })).status, 400)
  assert.equal((await h.call({ token: mint(), body: '[1]' })).status, 400)
  assert.equal((await h.call({ token: mint(), body: JSON.stringify({ deviceName: 'x'.repeat(5000) }) })).status, 413)
  assert.equal((await h.call({ token: mint(), body: '' })).status, 200, 'no body at all is fine')

  h.store.set('allowViewerExchange', false)
  let r = await h.call({ token: mint() })
  assert.deepEqual([r.status, r.body.error], [403, 'viewer_exchange_disabled'], 'off everywhere, even at home')
  h.store.set('allowViewerExchange', true)
  h.store.set('allowViewerExchangeAway', false)
  assert.equal((await h.call({ token: mint(), ...LAN })).status, 200, 'LAN-only setting still serves the LAN')
  r = await h.call({ token: mint(), ...DIRECT_TLS })
  assert.deepEqual([r.status, r.body.error], [403, 'viewer_exchange_disabled'], 'away switched off')
  r = await h.call({ token: mint(), ...TUNNEL })
  assert.equal(r.status, 403, 'the tunnel is away too')
  h.store.delete('allowViewerExchangeAway')
  assert.equal((await h.call({ token: mint(), ...DIRECT_TLS })).status, 200, 'default: on for away as well')
})

test('transport: plain http only from this network; TLS or the tunnel from anywhere', async () => {
  const h = harness()
  const asks = [
    ['LAN, plain', LAN, 200, 'lan'],
    ['this computer, plain', { ip: '127.0.0.1' }, 200, 'lan'],
    ['LAN over TLS', { encrypted: true }, 200, 'lan'],
    ['internet over TLS (port forward / home.beebo.tv)', DIRECT_TLS, 200, 'direct'],
    ['through the host agent tunnel', TUNNEL, 200, 'tunnel'],
    ['internet, plain', INTERNET_PLAIN, 403, null],
    ['LAN address behind a proxy that forwards', { headers: { 'x-forwarded-for': '203.0.113.9' } }, 403, null],
    ['a proxy claiming https on a plain hop', { ...INTERNET_PLAIN, headers: { 'x-forwarded-proto': 'https' } }, 403, null],
    ['the agent header without the secret', { ip: '203.0.113.9', headers: { 'x-beebo-agent-key': 'guess', 'x-beebo-remote-path': 'direct' } }, 403, null],
    ['the agent secret from a public address', { ip: '203.0.113.9', headers: { 'x-beebo-agent-key': AGENT_SECRET } }, 403, null],
    ['public IPv6, plain', { ip: '2001:db8::5' }, 403, null],
    ['CGNAT/Tailscale address, plain', { ip: '100.101.102.103' }, 403, null]
  ]
  for (const [label, o, status, pathClass] of asks) {
    const r = await h.call({ token: mint(), ...o })
    assert.equal(r.status, status, label)
    if (status === 403) {
      assert.equal(r.body.error, 'https_required', label)
      assert.equal(r.body.token, undefined)
    } else {
      assert.equal(h.store.data.viewerExchangeLog[0].path, pathClass, label)
    }
  }
})

test('transport: a plain-http refusal does not count against the budget and a wrong token over TLS does', async () => {
  const h = harness()
  for (let i = 0; i < 25; i++) assert.equal((await h.call({ token: mint(), ...INTERNET_PLAIN })).status, 403)
  assert.equal((await h.call({ token: mint(), ...DIRECT_TLS })).status, 200)
})

test('rate limit: a locked address gets 429 even with a good token, recovers after the window, and forgives nothing early', async () => {
  const h = harness()
  const ip = '198.51.100.7'
  for (let i = 0; i < viewerExchange.FAIL_MAX; i++) {
    const r = await h.call({ token: 'bad.token', ip, encrypted: true })
    assert.equal(r.status, 401, 'attempt ' + (i + 1))
  }
  let r = await h.call({ token: mint(), ip, encrypted: true })
  assert.equal(r.status, 429)
  assert.equal(r.body.error, 'locked')
  assert.ok(r.body.minutesRemaining >= 1)
  assert.equal(r.headers['Retry-After'], String(r.body.minutesRemaining * 60))
  assert.equal((await h.call({ token: mint(), ip: '198.51.100.8', encrypted: true })).status, 200, 'another address is untouched')
  h.clock.t += 14 * 60 * 1000
  assert.equal((await h.call({ token: mint(), ip, encrypted: true })).status, 429, 'still locked at 14 minutes')
  h.clock.t += 2 * 60 * 1000
  assert.equal((await h.call({ token: mint(), ip, encrypted: true })).status, 200, 'free again after the window')
})

test('rate limit: a success does not reset the failure count', async () => {
  const h = harness()
  const ip = '198.51.100.20'
  for (let i = 0; i < viewerExchange.FAIL_MAX - 1; i++) {
    await h.call({ token: 'x.y', ip, encrypted: true })
    assert.equal((await h.call({ token: mint({ jti: i }), ip, encrypted: true })).status, 200)
  }
  await h.call({ token: 'x.y', ip, encrypted: true })
  assert.equal((await h.call({ token: mint(), ip, encrypted: true })).status, 429)
})

test('rate limit: the global budget shuts away callers, never the LAN, and reopens', async () => {
  const h = harness()
  for (let i = 0; i < viewerExchange.GLOBAL_FAIL_MAX; i++) await h.call({ token: 'x.y', ip: '203.0.' + (i % 250) + '.' + (1 + Math.floor(i / 250)), encrypted: true })
  const r = await h.call({ token: mint(), ip: '198.51.100.99', encrypted: true })
  assert.deepEqual([r.status, r.body.error], [429, 'locked'], 'a fresh address away is refused while the whole house is being probed')
  assert.equal((await h.call({ token: mint(), ...LAN })).status, 200, 'the TV on the LAN is not')
  assert.equal((await h.call({ token: mint(), ...TUNNEL })).status, 429, 'the tunnel counts as away')
  h.clock.t += 11 * 60 * 1000
  assert.equal((await h.call({ token: mint(), ip: '198.51.100.99', encrypted: true })).status, 200)
})

test('rate limit: a bad viewer token never counts toward a real user\'s login lockout, and a locked-out address gets no sign-in here either', async () => {
  const h = harness()
  const ip = '192.168.1.60'
  for (let i = 0; i < 30; i++) await h.call({ token: 'bad.token', ip })
  assert.equal(auth.checkLockout(h.store, ip, 'owner').locked, false)
  assert.deepEqual(auth.getFailedLoginLog(h.store), [], 'nothing was recorded as a failed login')
  assert.equal(auth.getActiveLockouts(h.store).length, 0)
  const lockedIp = '192.168.1.61'
  for (let i = 0; i < 6; i++) auth.recordFailedLogin(h.store, { ip: lockedIp, username: 'nobody' })
  assert.equal(auth.checkLockout(h.store, lockedIp).locked, true)
  const r = await h.call({ token: mint(), ip: lockedIp })
  assert.deepEqual([r.status, r.body.error], [429, 'locked'])
})

test('replay: a viewer token is good for a handful of exchanges, then it is spent', async () => {
  const h = harness()
  const token = mint()
  for (let i = 0; i < viewerExchange.REPLAY_LIMIT; i++) assert.equal((await h.call({ token, ip: '192.168.1.' + (70 + i) })).status, 200)
  const r = await h.call({ token, ip: '192.168.1.99' })
  assert.deepEqual([r.status, r.body], [401, { ok: false, error: 'unauthorized' }])
  assert.match(h.logs.join('\n'), /refused: replayed/)
  assert.equal((await h.call({ token: mint({ iat: nowS() - 4 }), ip: '192.168.1.98' })).status, 200, 'a different token is unaffected')
})

test('logs and the audit record never hold the viewer token, the API token or the password', async () => {
  const h = harness()
  const good = mint()
  const bad = mint({ exp: nowS() - 10 })
  const wrong = mint({ name: 'otherhouse' })
  const r = await h.call({ token: good, body: { deviceName: 'Den\u202e TV\u0000  with   spaces' } })
  await h.call({ token: bad, ip: '192.168.1.11' })
  await h.call({ token: wrong, ip: '192.168.1.12' })
  await h.call({ token: mint({ via: 'household' }), ip: '192.168.1.13' })
  const everything = h.logs.join('\n') + JSON.stringify(h.store.data.viewerExchangeLog)
  for (const secret of [good, bad, wrong, r.body.token, PASSWORD, ...good.split('.'), ...wrong.split('.'), r.body.token.split('.').pop()]) assert.equal(everything.includes(secret), false, 'no secret in logs or audit')
  assert.match(h.logs.join('\n'), /signed in user=owner via=owner device="Den TV with spaces" path=lan/)
  assert.deepEqual(Object.keys(h.store.data.viewerExchangeLog[0]).sort(), ['at', 'device', 'path', 'userId', 'via'])
  assert.equal(h.store.data.viewerExchangeLog[0].device, 'Den TV with spaces', 'control and bidi characters gone, spaces collapsed')
  await h.call({ token: mint(), body: { deviceName: '' } })
  assert.equal(h.store.data.viewerExchangeLog[0].device, 'Unnamed device')
  for (let i = 0; i < 130; i++) await h.call({ token: mint(), ip: '192.168.1.' + (1 + (i % 200)) })
  assert.equal(h.store.data.viewerExchangeLog.length, 100, 'the record is capped')
})

// ---------------------------------------------------------------- a real server

let seq = 0
async function boot(t, { lic = licence(), data, house = HOUSE, serverOpts = {} } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'beebo-viewer-exchange-'))
  const store = makeStore(data)
  auth.forgetSecrets(); server.forgetSecrets()
  const logs = []
  const info = server.startStreamServer({
    port: 44000 + (process.pid % 1400) + ++seq, store, getMoviesDir: () => root, getTvShowsDir: () => root,
    getAllMoviesDirs: () => [root], getAllTvShowsDirs: () => [], log: (m) => logs.push(String(m)),
    agentSecret: AGENT_SECRET, license: lic, getHouseName: () => house, ...serverOpts
  })
  t.after(async () => { await new Promise((r) => info.close(r)); await fs.rm(root, { recursive: true, force: true }) })
  const base = 'http://127.0.0.1:' + info.port
  for (let i = 0; i < 60; i++) { try { await (await fetch(base + '/api/ping')).arrayBuffer(); break } catch { await new Promise((r) => setTimeout(r, 100)) } }
  const send = async (p, { method = 'POST', headers = {}, body, token } = {}) => {
    const r = await fetch(base + p, { method, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined })
    const text = await r.text()
    let json = null
    try { json = JSON.parse(text) } catch { json = null }
    return { status: r.status, text, json, headers: r.headers }
  }
  return { base, store, logs, send, exchange: (token, body, headers) => send('/api/viewer-session', { token, body, headers }) }
}

test('server: a phone-approved viewer token becomes a working API session', async (t) => {
  const s = await boot(t)
  const r = await s.exchange(mint(), { deviceName: 'Living room Roku' })
  assert.equal(r.status, 200, r.text)
  assert.deepEqual(Object.keys(r.json).sort(), ['expiresAt', 'ok', 'server', 'token', 'user'])
  assert.equal(r.json.user.id, 'owner')
  assert.equal(r.json.server.name, HOUSE)
  assert.equal(r.headers.get('cache-control'), 'no-store')
  const me = await s.send('/api/me', { method: 'GET', token: r.json.token })
  assert.equal(me.status, 200, me.text)
  assert.equal(me.json.user.id, 'owner')
  assert.equal((await s.send('/api/me', { method: 'GET', token: mint() })).status, 401, 'the viewer token itself is no API token')
  assert.equal(s.logs.join('\n').includes(r.json.token), false)
  assert.match(s.logs.join('\n'), /\[viewer-exchange\] signed in user=owner via=owner device="Living room Roku" path=lan/)
})

test('server: the exchanged token has exactly the reach of a /api/login token, restricted profile included', async (t) => {
  const s = await boot(t)
  const loginOf = async (username) => (await s.send('/api/login', { body: { username, password: PASSWORD } })).json
  const cases = [['robin', mintMember('robin')], ['kid', mintMember('kid')]]
  for (const [username, viewerToken] of cases) {
    const login = await loginOf(username)
    assert.equal(login.ok, true, username)
    const ex = (await s.exchange(viewerToken)).json
    assert.equal(ex.ok, true, username)
    assert.deepEqual(ex.user, login.user, username + ': same user shape as /api/login')
    for (const p of ['/api/me', '/api/parental/status', '/api/movies', '/api/tvshows', '/api/admin/users', '/api/admin/settings', '/api/upnext', '/api/history']) {
      const a = await s.send(p, { method: 'GET', token: login.token })
      const b = await s.send(p, { method: 'GET', token: ex.token })
      assert.equal(b.status, a.status, `${username} ${p}`)
      assert.equal(b.text, a.text, `${username} ${p}`)
    }
  }
  const kid = (await s.exchange(mintMember('kid'))).json.user
  assert.equal(kid.restricted, true)
  assert.equal(kid.isAdmin, false)
  const admin = await s.send('/api/admin/users', { method: 'GET', token: (await s.exchange(mintMember('robin'))).json.token })
  assert.equal(admin.status, 403, 'a member is never an admin')
})

test('server: same person and same refusals as /api/remote-session through the tunnel', async (t) => {
  const s = await boot(t)
  const vouch = (via, member) => ({ 'x-beebo-agent-key': AGENT_SECRET, 'x-beebo-remote': '1', 'x-beebo-remote-via': via, ...(member ? { 'x-beebo-remote-member': member } : {}) })
  const both = async (viewerToken, via, member) => {
    const rs = await s.send('/api/remote-session', { headers: vouch(via, member) })
    const ex = await s.exchange(viewerToken)
    return [rs, ex]
  }
  for (const [via, member] of [['owner'], ['member', 'robin']]) {
    const [rs, ex] = await both(via === 'owner' ? mint() : mintMember(member), via, member)
    assert.equal(ex.status, rs.status)
    assert.equal(ex.json.user.id, rs.json.user.id)
  }
  for (const member of ['sam', 'old', 'ghost']) {
    const [rs, ex] = await both(mintMember(member), 'member', member)
    assert.deepEqual([ex.status, ex.json.error], [rs.status, rs.json.error], member)
  }
  const [rs, ex] = await both(mint({ via: 'household' }), 'household')
  assert.deepEqual([ex.status, ex.json.error], [rs.status, rs.json.error])
  const hidden = await both(mintMember('hidden'), 'member', 'hidden')
  assert.deepEqual([hidden[1].status, hidden[1].json.error], [hidden[0].status, hidden[0].json.error])
})

test('server: over plain http from the internet the route refuses without even looking at the token', async (t) => {
  const s = await boot(t)
  const via = { 'x-forwarded-for': '203.0.113.9' }
  const r = await s.exchange(mint(), {}, via)
  assert.deepEqual([r.status, r.json.error], [403, 'https_required'])
  assert.equal(r.json.token, undefined)
  assert.equal((await s.exchange(mint())).status, 200, 'the same request from this network is served')
})

test('server: through the tunnel the same route works and is audited as such', async (t) => {
  const s = await boot(t)
  const r = await s.exchange(mint(), { deviceName: 'Phone' }, { 'x-beebo-agent-key': AGENT_SECRET, 'x-beebo-remote': '1', 'x-beebo-remote-path': 'direct', 'x-beebo-viewer-ip': '203.0.113.50' })
  assert.equal(r.status, 200, r.text)
  assert.equal(s.store.data.viewerExchangeLog[0].path, 'tunnel')
  const fake = await s.exchange(mint(), {}, { 'x-beebo-agent-key': 'wrong', 'x-beebo-remote': '1' })
  assert.deepEqual([fake.status, fake.json.error], [403, 'https_required'], 'a claimed agent without the secret is a remote caller on plain http')
})

test('server: sessions die with the user, and a login lockout is not touched by bad viewer tokens', async (t) => {
  const s = await boot(t)
  const robin = (await s.exchange(mintMember('robin'))).json.token
  assert.equal((await s.send('/api/me', { method: 'GET', token: robin })).status, 200)
  auth.revokeUser(s.store, 'robin')
  assert.equal((await s.send('/api/me', { method: 'GET', token: robin })).status, 401, 'disabled: dead at once')
  auth.reactivateUser(s.store, 'robin')
  const again = (await s.exchange(mintMember('robin', { iat: nowS() - 9 }))).json.token
  assert.equal((await s.send('/api/me', { method: 'GET', token: again })).status, 200)
  auth.deleteUser(s.store, 'robin')
  assert.equal((await s.send('/api/me', { method: 'GET', token: again })).status, 401, 'deleted: dead at once')

  for (let i = 0; i < 12; i++) await s.exchange('nope.nope')
  const login = await s.send('/api/login', { body: { username: 'owner', password: PASSWORD } })
  assert.equal(login.status, 200, 'the real owner can still sign in from the address that sent bad viewer tokens')
})

test('server: the two switches are settable through the admin API (over the tunnel) and turn the route off', async (t) => {
  const s = await boot(t)
  const owner = (await s.send('/api/login', { body: { username: 'owner', password: PASSWORD } })).json.token
  const tunnel = { 'x-beebo-agent-key': AGENT_SECRET, 'x-beebo-remote': '1', 'x-beebo-remote-path': 'direct' }
  let r = await s.send('/api/admin/settings', { method: 'GET', token: owner, headers: tunnel })
  assert.equal(r.status, 200, r.text)
  assert.equal(r.json.settings.allowViewerExchange, true)
  assert.equal(r.json.settings.allowViewerExchangeAway, true)
  assert.ok(r.json.settings.settableFields.includes('allowViewerExchange'))
  r = await s.send('/api/admin/settings', { token: owner, headers: tunnel, body: { allowViewerExchange: false } })
  assert.equal(r.json.ok, true, r.text)
  assert.equal(r.json.settings.allowViewerExchange, false)
  assert.equal((await s.exchange(mint())).status, 403)
  r = await s.send('/api/admin/settings', { token: owner, headers: tunnel, body: { allowViewerExchange: true, allowViewerExchangeAway: false } })
  assert.equal(r.json.ok, true, r.text)
  assert.equal((await s.exchange(mint())).status, 200, 'the LAN still works')
  assert.equal((await s.exchange(mint(), {}, tunnel)).status, 403, 'away does not')
  r = await s.send('/api/admin/settings', { token: owner, headers: tunnel, body: { allowViewerExchange: 'no' } })
  assert.equal(r.status, 400, 'only real booleans')
})

test('entitlement: the exchange takes the same road as every other request, so nothing becomes free or uncapped', async (t) => {
  const lapsed = licence({ enforced: true, serve: false, state: 'expired', payload: { email: OWNER_EMAIL, plan: 'beebo-standard' } })
  const s = await boot(t, { lic: lapsed })
  const away = { 'x-forwarded-for': '203.0.113.9' }
  // Direct HTTPS is free: a request that is away from home but did NOT come through the host
  // agent can never have used Beebo's relay (that always terminates at the agent), so a lapsed
  // plan does not gate it. This test socket is plain http, so the route's own transport rule
  // then answers 403 https_required, which proves the plan gate let the request through.)
  let r = await s.exchange(mint(), {}, away)
  assert.deepEqual([r.status, r.json.error], [403, 'https_required'], 'a direct away request (no agent) is free: no plan needed')
  r = await s.exchange(mint(), {}, { ...away, 'x-beebo-remote-path': 'relay-beebo' })
  assert.deepEqual([r.status, r.json.error], [403, 'https_required'], 'a forged path header without the agent key proves nothing, it is direct anyway')
  r = await s.exchange(mint(), {}, { ...away, 'x-beebo-agent-key': 'wrong', 'x-beebo-remote-path': 'relay-beebo' })
  assert.deepEqual([r.status, r.json.error], [403, 'https_required'], 'a wrong agent key is not the agent: direct')
  r = await s.exchange(mint())
  assert.equal(r.status, 200, 'home is always free, plan or no plan')
  const tunnel = (path) => ({ 'x-beebo-agent-key': AGENT_SECRET, 'x-beebo-remote': '1', 'x-beebo-remote-path': path })
  assert.equal((await s.exchange(mint(), {}, tunnel('direct'))).status, 200, 'the tunnel on a direct path is free')
  assert.equal((await s.exchange(mint(), {}, tunnel('relay-beebo'))).status, 402, 'Beebo Relay still needs the plan')
  assert.equal((await s.exchange(mint(), {}, { 'x-beebo-agent-key': AGENT_SECRET, 'x-beebo-remote': '1' })).status, 402, 'through the agent with no path header: not proven free, still gated')

  const awayApi = (token, extra = {}) => s.send('/api/me', { method: 'GET', token, headers: { ...away, ...extra } })
  const login = (await s.exchange(mint({ iat: nowS() - 30 }))).json.token
  assert.equal((await awayApi(login)).status, 200, 'an exchanged token used from a non-LAN direct address is free like any direct request')
  assert.equal((await awayApi(login, tunnel('relay-beebo'))).status, 402, 'the same token through Beebo Relay is gated by the plan')
})

// ---------------------------------------------------------------- the real Worker feeds the real server

test('end to end: the real Worker\'s TV pairing (owner and member) is exchanged on the server', { skip: require('./helpers/privateParts').skipIfMissing('worker/worker.js') }, async (t) => {
  const repo = path.resolve(__dirname, '..', '..', '..', '..')
  const w = await import(pathToFileURL(path.join(repo, 'worker', 'worker.js')).href)
  const { makeD1, fakeRequest } = await import(pathToFileURL(path.join(repo, 'worker', 'test', 'd1-mock.mjs')).href)
  const DB = makeD1()
  const env = { DB, LICENSE_PUBLIC_KEY: KEYS.publicKey, LICENSE_PRIVATE_KEY: KEYS.privateKey, BEEBO_TVPAIR_ENABLED: '1' }
  let ip = 0
  const call = async (p, { body, token } = {}) => {
    const h = { 'cf-connecting-ip': '198.51.100.' + (++ip % 250 + 1), ...(token ? { authorization: 'Bearer ' + token } : {}) }
    const res = await w.default.fetch(fakeRequest('https://login.beebo.tv' + p, { method: 'POST', body, headers: h }), env)
    return { status: res.status, body: JSON.parse(await res.text()) }
  }
  await w._test.ensureAuthSchema(env)
  await w._test.upsertUserPassword(env, OWNER_EMAIL, 'owner account pw')
  const at = nowS()
  await DB.prepare('INSERT INTO server_names (name, email, hostname, created_at, updated_at) VALUES (?,?,?,?,?)').bind(HOUSE, OWNER_EMAIL, HOUSE + '.beebo.tv', at, at).run()
  const gen = await w._test.derivePasswordHash('robin generated pass')
  await DB.prepare('INSERT INTO server_members (name, username, pw_hash, pw_salt, pw_iter, updated_at) VALUES (?,?,?,?,?,?)').bind(HOUSE, 'robin', gen.hash, gen.salt, gen.iterations, at).run()

  const pair = async (phoneToken) => {
    const s = (await call('/tvpair/start', { body: { device_name: 'Roku Ultra', device_model: 'Roku' } })).body
    assert.equal((await call('/tvpair/approve', { body: { user_code: s.user_code, decision: 'approve' }, token: phoneToken })).status, 200)
    const got = (await call('/tvpair/poll', { body: { device_code: s.device_code } })).body
    assert.equal(got.status, 'approved')
    return got
  }
  const ownerPhone = (await call('/rtc/find-home', { body: { email: OWNER_EMAIL, password: 'owner account pw' } })).body
  const memberPhone = (await call('/rtc/find-home', { body: { email: OWNER_EMAIL, username: 'robin', pass: 'robin generated pass' } })).body
  assert.equal(ownerPhone.name, HOUSE)

  const s = await boot(t)
  const tvOwner = await pair(ownerPhone.token)
  assert.equal(tvOwner.name, HOUSE)
  const o = await s.exchange(tvOwner.token, { deviceName: tvOwner.name + ' Roku' })
  assert.equal(o.status, 200, o.text)
  assert.equal(o.json.user.id, 'owner')
  assert.equal(o.json.server.name, tvOwner.name)

  const tvMember = await pair(memberPhone.token)
  const m = await s.exchange(tvMember.token)
  assert.equal(m.status, 200, m.text)
  assert.deepEqual(m.json.user, { id: 'robin', name: 'Robin', isAdmin: false, adult: true, viewingHistoryPrivate: false })
  assert.equal((await s.send('/api/me', { method: 'GET', token: m.json.token })).json.user.id, 'robin')

  const wrongHouse = await boot(t, { house: 'somewhereelse' })
  assert.equal((await wrongHouse.exchange(tvOwner.token)).status, 401, 'another house refuses this token')
  const otherAccount = await boot(t, { lic: licence({ payload: { email: 'someoneelse@example.com' } }) })
  assert.equal((await otherAccount.exchange(tvOwner.token)).status, 401, 'another account with the same name refuses it too')
})
