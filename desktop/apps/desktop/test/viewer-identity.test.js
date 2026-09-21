// Remote viewers must not share one lockout as 127.0.0.1, and nobody but the
// host agent may choose which address a login attempt counts against.
// Run: node --test test/viewer-identity.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { createRequire } = require('node:module')
const { testPort } = require('./helpers/testPort')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))
const vi = localRequire('./electron/viewerIdentity')

const SECRET = crypto.randomBytes(32).toString('hex')
const req = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers })
const vouched = (ip, key = SECRET) => ({ 'x-beebo-viewer-ip': ip, 'x-beebo-agent-key': key })

test('the agent on loopback, with the secret, is believed', () => {
  assert.equal(vi.clientIp(req('127.0.0.1', vouched('198.51.100.23')), SECRET), '198.51.100.23')
  assert.equal(vi.clientIp(req('::ffff:127.0.0.1', vouched('198.51.100.23')), SECRET), '198.51.100.23')
  assert.equal(vi.clientIp(req('::1', vouched('::ffff:198.51.100.24')), SECRET), '198.51.100.24')
})

test('IPv6 viewers are keyed on their /64', () => {
  assert.equal(vi.clientIp(req('127.0.0.1', vouched('2001:db8:1:2:aaaa:bbbb:cccc:dddd')), SECRET), '2001:db8:1:2::/64')
  assert.equal(vi.clientIp(req('127.0.0.1', vouched('2001:db8::1')), SECRET), '2001:db8:0:0::/64')
})

test('anyone else sending the header gets their own socket address', () => {
  // A LAN device that knows the header names but not the secret.
  assert.equal(vi.clientIp(req('::ffff:192.168.1.40', vouched('203.0.113.9', 'guess')), SECRET), '192.168.1.40')
  // Even with the right secret, a request that isn't from this machine is not the agent.
  assert.equal(vi.clientIp(req('192.168.1.40', vouched('203.0.113.9')), SECRET), '192.168.1.40')
  // On loopback without the secret (another program on the PC, or a local browser).
  assert.equal(vi.clientIp(req('127.0.0.1', vouched('203.0.113.9', '')), SECRET), '127.0.0.1')
  assert.equal(vi.clientIp(req('127.0.0.1', vouched('203.0.113.9', SECRET.slice(0, -1) + 'x')), SECRET), '127.0.0.1')
  // A server started without a secret believes nobody.
  assert.equal(vi.clientIp(req('127.0.0.1', vouched('203.0.113.9')), ''), '127.0.0.1')
  // Not an address at all.
  assert.equal(vi.clientIp(req('127.0.0.1', vouched('203.0.113.9, 10.0.0.1')), SECRET), '127.0.0.1')
  assert.equal(vi.clientIp(req('127.0.0.1', vouched('unknown')), SECRET), '127.0.0.1')
})

// The admin transport gate accepts the tunnel (encrypted to the phone) only when
// the agent's secret proves the request really came through it.
test('fromHostAgent: loopback plus the exact secret, and nothing else', () => {
  const key = (k) => ({ 'x-beebo-agent-key': k })
  assert.equal(vi.fromHostAgent(req('127.0.0.1', key(SECRET)), SECRET), true)
  assert.equal(vi.fromHostAgent(req('::ffff:127.0.0.1', key(SECRET)), SECRET), true)
  assert.equal(vi.fromHostAgent(req('::1', key(SECRET)), SECRET), true)
  // No viewer address needed: the agent may not know one.
  assert.equal(vi.fromHostAgent(req('127.0.0.1', { ...key(SECRET), 'x-beebo-viewer-ip': '' }), SECRET), true)
  assert.equal(vi.fromHostAgent(req('192.168.1.40', key(SECRET)), SECRET), false)
  assert.equal(vi.fromHostAgent(req('127.0.0.1', key('guess')), SECRET), false)
  assert.equal(vi.fromHostAgent(req('127.0.0.1', key(SECRET.slice(0, -1) + 'x')), SECRET), false)
  assert.equal(vi.fromHostAgent(req('127.0.0.1', {}), SECRET), false)
  assert.equal(vi.fromHostAgent(req('127.0.0.1', key('')), ''), false)
  assert.equal(vi.fromHostAgent(req('127.0.0.1', { 'x-beebo-remote': '1' }), SECRET), false)
  assert.equal(vi.fromHostAgent(null, SECRET), false)
})

// The real media server on a spare port: five bad logins from one remote viewer
// lock that viewer out, not the next one, and a spoofed header counts as the
// socket it came from.
test('login lockouts follow the vouched viewer, not 127.0.0.1', async () => {
  const server = localRequire('./electron/streamServer')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'beebo-vi-test-'))
  let info
  try {
    const data = {}
    const store = { get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] }, onDidChange: () => () => {} }
    const port = testPort()
    info = server.startStreamServer({
      port, store, getMoviesDir: () => dir, getTvShowsDir: () => dir,
      getAllMoviesDirs: () => [dir], getAllTvShowsDirs: () => [],
      log: () => {}, agentSecret: SECRET
    })
    const base = 'http://127.0.0.1:' + info.port
    for (let i = 0; i < 50; i++) {
      try { await fetch(base + '/login', { redirect: 'manual' }); break } catch { await new Promise((r) => setTimeout(r, 100)) }
    }
    const login = (headers) => fetch(base + '/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ username: 'nobody', password: 'wrong' })
    }).then(async (r) => ({ status: r.status, body: await r.json() }))

    let last
    for (let i = 0; i < 5; i++) last = await login(vouched('198.51.100.23'))
    assert.equal(last.body.locked, true, 'the guesser is locked out')
    // The next remote viewer is not.
    const other = await login(vouched('198.51.100.99'))
    assert.equal(other.status, 401)
    assert.notEqual(other.body.locked, true, 'another remote viewer is not locked out')
    // Someone on this PC trying to pin the lockout on that viewer without the secret
    // is counted as 127.0.0.1.
    await login(vouched('198.51.100.99', 'not-the-secret'))

    // Lockout state is kept in memory and flushed on a timer (review #18).
    localRequire('./electron/auth').flushLoginState(store)
    const lockouts = data.loginLockouts || {}
    assert.ok(lockouts['198.51.100.23'] && lockouts['198.51.100.23'].lockedUntil > Date.now())
    assert.ok(!lockouts['198.51.100.99'] || !lockouts['198.51.100.99'].lockedUntil)
    assert.equal(lockouts['127.0.0.1'].attempts.length, 1)
    assert.ok((data.failedLoginLog || []).some((e) => e.ip === '198.51.100.23'))
  } finally {
    if (info) await new Promise((r) => info.close(r))
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('remoteViewer: only the agent (loopback + secret) can say who signed in', () => {
  const who = (ip, headers, secret = SECRET) => vi.remoteViewer(req(ip, headers), secret)
  const vouch = (extra) => ({ 'x-beebo-agent-key': SECRET, ...extra })
  assert.deepEqual(who('127.0.0.1', vouch({ 'x-beebo-remote-via': 'member', 'x-beebo-remote-member': 'Robin' })), { via: 'member', member: 'robin' })
  assert.deepEqual(who('::1', vouch({ 'x-beebo-remote-via': 'owner' })), { via: 'owner' })
  assert.deepEqual(who('127.0.0.1', vouch({ 'x-beebo-remote-via': 'household' })), { via: 'household' })
  // A forged header from anywhere else, or without the secret, means nothing.
  assert.equal(who('192.168.1.40', vouch({ 'x-beebo-remote-via': 'member', 'x-beebo-remote-member': 'robin' })), null)
  assert.equal(who('127.0.0.1', { 'x-beebo-agent-key': 'guess', 'x-beebo-remote-via': 'owner' }), null)
  assert.equal(who('127.0.0.1', { 'x-beebo-remote-via': 'owner' }), null)
  assert.equal(who('127.0.0.1', vouch({ 'x-beebo-remote-via': 'owner' }), ''), null)
  assert.equal(who('127.0.0.1', vouch({ 'x-beebo-remote-via': 'member' })), null)
  assert.equal(who('127.0.0.1', vouch({ 'x-beebo-remote-via': 'member', 'x-beebo-remote-member': 'a b' })), null)
  assert.equal(who('127.0.0.1', vouch({ 'x-beebo-remote-via': 'admin' })), null)
})

test('/api/remote-session signs in the person the agent vouches for, and nobody else', async () => {
  const server = localRequire('./electron/streamServer')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'beebo-rs-test-'))
  let info
  try {
    const remote = { pw_hash: 'a'.repeat(64), pw_salt: 'b'.repeat(32), pw_iter: 25000 }
    const data = {
      authUsers: [
        { id: 'u-owner', name: 'Owner', username: 'owner', status: 'approved', isAdmin: true },
        { id: 'u-robin', name: 'Robin', username: 'robin', status: 'approved', remote },
        { id: 'u-sam', name: 'Sam', username: 'sam', status: 'approved' },
        { id: 'u-old', name: 'Old', username: 'old', status: 'revoked', remote },
      ],
    }
    const store = { get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] }, onDidChange: () => () => {} }
    const port = testPort()
    info = server.startStreamServer({
      port, store, getMoviesDir: () => dir, getTvShowsDir: () => dir,
      getAllMoviesDirs: () => [dir], getAllTvShowsDirs: () => [],
      log: () => {}, agentSecret: SECRET
    })
    const base = 'http://127.0.0.1:' + info.port
    for (let i = 0; i < 50; i++) {
      try { await fetch(base + '/login', { redirect: 'manual' }); break } catch { await new Promise((r) => setTimeout(r, 100)) }
    }
    const rs = (headers, method = 'POST') => fetch(base + '/api/remote-session', { method, headers })
      .then(async (r) => ({ status: r.status, body: await r.json() }))
    const key = { 'x-beebo-agent-key': SECRET, 'x-beebo-remote': '1' }

    let r = await rs({ ...key, 'x-beebo-remote-via': 'member', 'x-beebo-remote-member': 'robin' })
    assert.equal(r.status, 200)
    assert.equal(r.body.user.id, 'u-robin')
    const me = await fetch(base + '/api/me', { headers: { authorization: 'Bearer ' + r.body.token } }).then((x) => x.json())
    assert.equal(me.user.id, 'u-robin', 'a normal API token')

    r = await rs({ ...key, 'x-beebo-remote-via': 'owner' })
    assert.equal(r.status, 200)
    assert.equal(r.body.user.id, 'u-owner')

    // Forged: no secret, the wrong secret.
    assert.equal((await rs({ 'x-beebo-remote-via': 'member', 'x-beebo-remote-member': 'robin' })).status, 401)
    assert.equal((await rs({ 'x-beebo-agent-key': 'nope', 'x-beebo-remote-via': 'owner' })).status, 401)
    // Not allowed away from home, revoked, unknown, the household pass.
    for (const m of ['sam', 'old', 'nobody']) {
      assert.equal((await rs({ ...key, 'x-beebo-remote-via': 'member', 'x-beebo-remote-member': m })).status, 403, m)
    }
    const hh = await rs({ ...key, 'x-beebo-remote-via': 'household' })
    assert.equal(hh.status, 403)
    assert.equal(hh.body.error, 'household_pass')
    assert.equal((await rs({ ...key, 'x-beebo-remote-via': 'owner' }, 'GET')).status, 405)
  } finally {
    if (info) await new Promise((r) => info.close(r))
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('the home-password hash for away from home follows the password, and only for people allowed away', () => {
  const rm = localRequire('./electron/remoteMembers')
  const remote = { pw_hash: 'a'.repeat(64), pw_salt: 'b'.repeat(32), pw_iter: 25000 }
  const user = { id: 'u1', username: 'robin', status: 'approved', passwordHash: 'salt:hash1', remote }
  // Made even before away-from-home access is switched on: the owner usually sets the
  // password first, and a hash that only appeared after that person's next sign-in on
  // this computer looked, away from home, like a wrong password (2026-09-17).
  const early = rm.rememberLogin({ ...user, remote: undefined }, 'secret')
  assert.ok(early && early.pw_hash, 'hashed as soon as the password is known')
  // It is never pushed for someone who is not allowed away from home.
  assert.deepEqual(rm.buildMemberList([{ ...user, remote: undefined, remoteLogin: early }]), [])
  const rec = rm.rememberLogin(user, 'robins password')
  assert.ok(rec && rec.pw_hash && rec.from === rm.credentialFingerprint(user))
  const again = crypto.pbkdf2Sync('robins password', Buffer.from(rec.pw_salt, 'hex'), rec.pw_iter, 32, 'sha256').toString('hex')
  assert.equal(again, rec.pw_hash, 'the shape the Worker verifies')
  assert.equal(rm.rememberLogin({ ...user, remoteLogin: rec }, 'robins password'), null, 'unchanged: nothing to store')
  assert.ok(rm.rememberLogin({ ...user, remoteLogin: rec }, 'a new password'), 'a different password is stored again')

  let list = rm.buildMemberList([{ ...user, remoteLogin: rec }])
  assert.equal(list[0].login_hash, rec.pw_hash)
  // The password changed since: the old hash is not pushed.
  list = rm.buildMemberList([{ ...user, passwordHash: 'salt:hash2', remoteLogin: rec }])
  assert.equal(list[0].login_hash, undefined)
  assert.equal(list[0].pw_hash, remote.pw_hash)
})
