'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const auth = require('../electron/auth')
const parental = require('../electron/parentalControls')
const history = require('../electron/history')
const server = require('../electron/streamServer')
const { testPort } = require('./helpers/testPort')

const PASSWORD = 'Private-user-test-password-43'
const SECRET = crypto.randomBytes(32).toString('hex')
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'beebo-viewing-privacy-'))
  const moviesDir = path.join(root, 'movies')
  await fs.mkdir(moviesDir)
  await fs.writeFile(path.join(moviesDir, 'A Private Film.mp4'), Buffer.alloc(4096, 1))
  await fs.writeFile(path.join(moviesDir, 'A Public Film.mp4'), Buffer.alloc(4096, 2))
  const remote = { pw_hash: 'a'.repeat(64), pw_salt: 'b'.repeat(32), pw_iter: 25000 }
  const data = { authUsers: [
    { id: 'owner', name: 'Owner', username: 'owner', status: 'approved', isAdmin: true, passwordHash: auth.hashPassword(PASSWORD) },
    { id: 'adult', name: 'Adult', username: 'adult', status: 'approved', adult: true, passwordHash: auth.hashPassword(PASSWORD), email: 'adult@example.test', remote },
    { id: 'other', name: 'Other adult', username: 'other', status: 'approved', adult: true, passwordHash: auth.hashPassword(PASSWORD) },
    { id: 'unlabeled', name: 'Unlabeled', username: 'unlabeled', status: 'approved', passwordHash: auth.hashPassword(PASSWORD) },
    { id: 'child', name: 'Child', username: 'child', status: 'approved', adult: true, passwordHash: auth.hashPassword(PASSWORD) },
    { id: 'code', name: 'Code only', username: 'code', status: 'approved', adult: true, code: 'ABCDEFGH', codeHash: auth.hashCode('ABCDEFGH') }
  ] }
  const store = { get: k => data[k], set: (k, v) => { data[k] = v }, delete: k => { delete data[k] }, onDidChange: () => () => {} }
  parental.setPolicy(store, 'child', parental.presetPolicy('kids'))
  auth.forgetSecrets(); server.forgetSecrets()
  const info = server.startStreamServer({
    port: testPort(),
    store, getMoviesDir: () => moviesDir, getTvShowsDir: () => root,
    getAllMoviesDirs: () => [moviesDir], getAllTvShowsDirs: () => [],
    agentSecret: SECRET, log: () => {}, ...(options.license ? { license: options.license } : {})
  })
  t.after(async () => {
    await new Promise(resolve => info.close(resolve))
    await fs.rm(root, { recursive: true, force: true })
  })
  const base = 'http://127.0.0.1:' + info.port
  let ready = false
  for (let i = 0; i < 50; i++) {
    try { await (await fetch(base + '/api/ping')).arrayBuffer(); ready = true; break }
    catch { await new Promise(resolve => setTimeout(resolve, 50)) }
  }
  assert.equal(ready, true, 'fixture server started')
  const tokens = Object.fromEntries(data.authUsers.map(u => [u.id, server.makeApiToken(store, u.id)]))
  async function api(who, route, body, headers = {}) {
    const response = await fetch(base + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: 'Bearer ' + (tokens[who] || who) } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual'
    })
    const text = await response.text()
    let result = null
    try { result = JSON.parse(text) } catch {}
    return { status: response.status, body: result, text, headers: response.headers }
  }
  const admin = (route, body) => api('owner', route, body, { 'X-Beebo-Agent-Key': SECRET })
  const user = id => data.authUsers.find(u => u.id === id)
  async function enable(id = 'adult') {
    const result = await api(id, '/api/viewing-privacy', { enabled: true, password: PASSWORD })
    assert.equal(result.status, 200, result.text)
    assert.equal(result.body.enabled, true)
    assert.equal(typeof result.body.token, 'string')
    tokens[id] = result.body.token
    return result
  }
  return { data, store, base, tokens, api, admin, user, enable }
}

test('viewing privacy requires an authenticated unrestricted adult and their current password', async t => {
  const f = await fixture(t)
  assert.equal((await f.api(null, '/api/viewing-privacy')).status, 401)
  const initial = await f.api('adult', '/api/viewing-privacy')
  assert.equal(initial.status, 200)
  assert.equal(initial.body.adult, true)
  assert.equal(initial.body.eligible, true)
  assert.equal(initial.body.enabled, false)
  assert.equal(initial.body.hasPassword, true)
  for (const id of ['unlabeled', 'child', 'code']) {
    const result = await f.api(id, '/api/viewing-privacy', { enabled: true, password: PASSWORD })
    assert.equal(result.status, 403, id + ': ' + result.text)
    assert.notEqual(f.user(id).viewingHistoryPrivate, true)
  }
  for (const password of ['', 'a-wrong-password']) {
    const result = await f.api('adult', '/api/viewing-privacy', { enabled: true, password })
    assert.ok([400, 401, 403].includes(result.status), result.text)
    assert.notEqual(f.user('adult').viewingHistoryPrivate, true)
  }
  const malformed = await f.api('adult', '/api/viewing-privacy', { enabled: 'true', password: PASSWORD })
  assert.equal(malformed.status, 400)
  const targeted = await f.api('adult', '/api/viewing-privacy', { enabled: true, password: PASSWORD, userId: 'unlabeled' })
  assert.ok([200, 400, 403].includes(targeted.status), targeted.text)
  assert.notEqual(f.user('unlabeled').viewingHistoryPrivate, true, 'supplied target never changes someone else')
})

test('enabling privacy retires older API and browser sessions; only self history remains visible', async t => {
  const f = await fixture(t)
  const privateSession = history.startSession(f.store, { userId: 'adult', userName: 'Adult', title: 'A Private Film', fileName: 'A Private Film.mp4', kind: 'movie' })
  const publicSession = history.startSession(f.store, { userId: 'other', userName: 'Other adult', title: 'A Public Film', fileName: 'A Public Film.mp4', kind: 'movie' })
  history.updateSession(f.store, privateSession, { currentTime: 600, duration: 3000 })
  history.updateSession(f.store, publicSession, { currentTime: 500, duration: 3000 })
  const oldToken = f.tokens.adult
  const oldCookie = auth.signSession(f.store, 'adult')
  assert.equal((await f.admin('/api/admin/history')).body.items.length, 2)
  await f.enable()
  assert.equal(server.verifyApiToken(f.store, oldToken), null)
  assert.equal(auth.verifySession(f.store, oldCookie), null)
  assert.equal((await f.api(oldToken, '/api/history')).status, 401)
  const own = await f.api('adult', '/api/history')
  assert.equal(own.status, 200)
  assert.ok(own.body.items.some(i => i.title === 'A Private Film'), own.text)
  const adminHistory = await f.admin('/api/admin/history')
  assert.equal(adminHistory.status, 200)
  assert.deepEqual(adminHistory.body.items.map(i => i.sessionId), [publicSession])
  assert.doesNotMatch(adminHistory.text, /A Private Film|A%20Private|QSBQcml2YXRl/)
  const otherHistory = await f.api('other', '/api/history?userId=adult')
  assert.doesNotMatch(otherHistory.text, /A Private Film/)
  const clear = await f.admin('/api/admin/history/clear', { userId: 'adult', scope: 'all' })
  assert.equal(clear.status, 403, clear.text)
  assert.ok(history.getHistory(f.store).some(i => i.sessionId === privateSession))
  const wrongDisable = await f.api('adult', '/api/viewing-privacy', { enabled: false, password: 'wrong' })
  assert.ok([400, 401, 403].includes(wrongDisable.status))
  assert.equal(f.user('adult').viewingHistoryPrivate, true)
  const disabled = await f.api('adult', '/api/viewing-privacy', { enabled: false, password: PASSWORD })
  assert.equal(disabled.status, 200, disabled.text)
  assert.equal(disabled.body.enabled, false)
  assert.equal((await f.admin('/api/admin/history')).body.items.length, 2)
})

test('owner cannot impersonate a private adult through profile switching, remote credentials, or relabeling', async t => {
  const f = await fixture(t)
  await f.enable()
  const switched = await f.api('owner', '/api/profiles/switch', { userId: 'adult' })
  assert.equal(switched.status, 403, switched.text)
  assert.equal(switched.body.error, 'private_profile_sign_in')
  const remote = await f.api(null, '/api/remote-session', {}, { 'X-Beebo-Agent-Key': SECRET, 'X-Beebo-Remote-Via': 'member', 'X-Beebo-Remote-Member': 'adult' })
  assert.equal(remote.status, 403, remote.text)
  const regenerate = await f.admin('/api/admin/users/regenerate-code', { userId: 'adult' })
  assert.equal(regenerate.status, 403, regenerate.text)
  const demote = await f.admin('/api/admin/users/adult', { userId: 'adult', adult: false })
  assert.equal(demote.status, 409, demote.text)
  assert.equal(f.user('adult').viewingHistoryPrivate, true)
  const selfLabel = await f.api('unlabeled', '/api/admin/users/adult', { userId: 'unlabeled', adult: true }, { 'X-Beebo-Agent-Key': SECRET })
  assert.equal(selfLabel.status, 403, selfLabel.text)
  assert.notEqual(f.user('unlabeled').adult, true)
  const label = await f.admin('/api/admin/users/adult', { userId: 'unlabeled', adult: true })
  assert.equal(label.status, 200, label.text)
  assert.equal(f.user('unlabeled').adult, true)
  const normalLogin = await f.api(null, '/api/login', { username: 'adult', password: PASSWORD })
  assert.equal(normalLogin.status, 200, normalLogin.text)
  assert.equal(normalLogin.body.user.id, 'adult')
})

test('progress updates cannot target another person, including a hidden private session', async t => {
  const f = await fixture(t)
  const sessionId = history.startSession(f.store, { userId: 'adult', userName: 'Adult', title: 'A Private Film', fileName: 'A Private Film.mp4', kind: 'movie' })
  await f.enable()
  const other = await f.api('other', '/api/progress', { sessionId, currentTime: 1000, duration: 3000 })
  assert.ok([403, 404].includes(other.status), other.text)
  assert.equal(history.getHistory(f.store).find(i => i.sessionId === sessionId).currentTime, 0)
  const ownerCookie = auth.signSession(f.store, 'owner')
  const response = await fetch(f.base + '/progress', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'beebo_session=' + ownerCookie }, body: JSON.stringify({ sessionId, currentTime: 2000, duration: 3000 }), redirect: 'manual' })
  await response.arrayBuffer()
  assert.ok([403, 404].includes(response.status), 'browser progress must apply the same ownership check')
  assert.equal(history.getHistory(f.store).find(i => i.sessionId === sessionId).currentTime, 0)
  const own = await f.api('adult', '/api/progress', { sessionId, currentTime: 100, duration: 3000 })
  assert.equal(own.status, 200, own.text)
  assert.equal(history.getHistory(f.store).find(i => i.sessionId === sessionId).currentTime, 100)
})


async function browser(f, cookie, route, body, headers = {}) {
  const response = await fetch(f.base + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(cookie ? { Cookie: 'beebo_session=' + cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    redirect: 'manual'
  })
  const text = await response.text()
  let result = null
  try { result = JSON.parse(text) } catch {}
  return { status: response.status, body: result, text, headers: response.headers }
}

test('browser privacy form rotates its cookie, keeps this browser signed in, and rejects cross-site forms', async t => {
  const f = await fixture(t)
  const oldCookie = auth.signSession(f.store, 'adult')
  const page = await browser(f, oldCookie, '/viewing-privacy')
  assert.equal(page.status, 200)
  assert.match(page.text, /Keep my viewing history private/)
  assert.match(page.text, /direct access to the storage computer/)
  assert.equal(page.headers.get('cache-control'), 'no-store')
  for (const headers of [
    { Origin: 'https://evil.example.test' },
    { Origin: 'null' },
    { 'Sec-Fetch-Site': 'cross-site' },
    { 'Content-Type': 'application/x-www-form-urlencoded' }
  ]) {
    const blocked = await browser(f, oldCookie, '/viewing-privacy', { enabled: true, password: PASSWORD }, headers)
    assert.ok([403, 415].includes(blocked.status), 'refused by the shared cookie-write guard (403) or the route (415): ' + blocked.status + ' ' + blocked.text)
    assert.notEqual(f.user('adult').viewingHistoryPrivate, true)
  }
  const saved = await browser(f, oldCookie, '/viewing-privacy', { enabled: true, password: PASSWORD }, { Origin: f.base })
  assert.equal(saved.status, 200, saved.text)
  const setCookie = saved.headers.get('set-cookie')
  assert.match(setCookie, /HttpOnly/)
  assert.match(setCookie, /SameSite=Lax/)
  const freshCookie = /^beebo_session=([^;]+)/.exec(setCookie)[1]
  assert.notEqual(freshCookie, oldCookie)
  assert.equal(auth.verifySession(f.store, oldCookie), null)
  assert.equal(auth.verifySession(f.store, freshCookie), 'adult')
  assert.equal((await browser(f, oldCookie, '/viewing-privacy')).status, 302)
  const fresh = await browser(f, freshCookie, '/viewing-privacy')
  assert.equal(fresh.status, 200)
  assert.match(fresh.text, /id="private-history"[^>]*checked/)
  const disabled = await browser(f, freshCookie, '/viewing-privacy', { enabled: false, password: PASSWORD }, { Origin: f.base })
  assert.equal(disabled.status, 200, disabled.text)
  assert.equal(f.user('adult').viewingHistoryPrivate, false)
})

test('privacy password attempts share the sign-in lockout and cannot brute force indefinitely', async t => {
  const f = await fixture(t)
  f.data.loginLockoutThreshold = 3
  for (let i = 0; i < 3; i++) {
    const wrong = await f.api('adult', '/api/viewing-privacy', { enabled: true, password: 'wrong-password-' + i })
    assert.equal(wrong.status, 401, wrong.text)
  }
  const locked = await f.api('adult', '/api/viewing-privacy', { enabled: true, password: PASSWORD })
  assert.equal(locked.status, 429, locked.text)
  assert.notEqual(f.user('adult').viewingHistoryPrivate, true)
  const cookie = auth.signSession(f.store, 'adult')
  const web = await browser(f, cookie, '/viewing-privacy', { enabled: true, password: PASSWORD })
  assert.equal(web.status, 429, web.text)
})

test('privacy leaves remote configuration intact and parental restrictions cannot expose private history', async t => {
  const f = await fixture(t)
  f.data.remoteName = 'example-home'
  f.data.rtcRelay = { kind: 'beebo', enabled: true }
  const beforeRemote = structuredClone(f.user('adult').remote)
  const id = history.startSession(f.store, { userId: 'adult', userName: 'Adult', title: 'A Private Film', fileName: 'A Private Film.mp4', kind: 'movie' })
  await f.enable()
  assert.deepEqual(f.user('adult').remote, beforeRemote)
  assert.equal(f.data.remoteName, 'example-home')
  assert.deepEqual(f.data.rtcRelay, { kind: 'beebo', enabled: true })
  const restricted = await f.admin('/api/admin/parental/set', { userId: 'adult', preset: 'kids' })
  assert.equal(restricted.status, 200, restricted.text)
  const status = await f.api('adult', '/api/viewing-privacy')
  assert.equal(status.body.eligible, false)
  assert.equal(status.body.enabled, true)
  assert.equal((await f.admin('/api/admin/history')).body.items.some(row => row.sessionId === id), false)
  assert.equal((await f.api('owner', '/api/profiles/switch', { userId: 'adult' })).status, 403)
  const clearRestriction = await f.admin('/api/admin/parental/set', { userId: 'adult', preset: 'off' })
  assert.equal(clearRestriction.status, 200)
  assert.equal(f.user('adult').viewingHistoryPrivate, true)
  assert.equal((await f.admin('/api/admin/history')).body.items.length, 0)
  assert.equal((await f.admin('/api/admin/users/adult', { userId: 'adult', adult: false })).status, 409)
})

test('private credentials cannot be replaced by admin helpers; own email recovery still works', async t => {
  const f = await fixture(t)
  await f.enable()
  const before = structuredClone(f.user('adult'))
  for (const action of [
    () => auth.regenerateCode(f.store, 'adult'),
    () => auth.setUserCode(f.store, 'adult', 'ABCDEFGH'),
    () => auth.setUserEmail(f.store, 'adult', 'owner@example.test')
  ]) assert.throws(action, error => error.code === 'private_profile_self_recovery')
  const passwordChange = auth.setUserPassword(f.store, 'adult', 'Owner-would-know-this-password')
  assert.equal(passwordChange.ok, false)
  assert.deepEqual(f.user('adult'), before)
  const reset = auth.createPasswordResetToken(f.store, 'adult@example.test')
  assert.equal(reset.user.id, 'adult')
  assert.equal(auth.resetPasswordWithToken(f.store, reset.token, 'A-new-private-password-42').ok, true)
  assert.equal(f.user('adult').viewingHistoryPrivate, true)
  assert.equal(server.verifyApiToken(f.store, f.tokens.adult), null, 'email recovery also retires old private sessions')
  assert.equal(auth.findUserByUsernameAndSecret(f.store, 'adult', 'A-new-private-password-42').id, 'adult')
})

test('browser adult-label action is reachable and rejects a cross-site form', async t => {
  const f = await fixture(t)
  const cookie = auth.signSession(f.store, 'owner')
  const headers = { 'X-Beebo-Agent-Key': SECRET, 'Content-Type': 'application/x-www-form-urlencoded' }
  const form = new URLSearchParams({ userId: 'unlabeled', adult: 'true', tab: 'users' }).toString()
  const evil = await browser(f, cookie, '/admin/users/adult', form, { ...headers, Origin: 'https://evil.example.test', 'Sec-Fetch-Site': 'same-site' })
  assert.equal(evil.status, 403, evil.text)
  assert.notEqual(f.user('unlabeled').adult, true)
  const valid = await browser(f, cookie, '/admin/users/adult', form, { ...headers, Origin: f.base })
  assert.equal(valid.status, 303, valid.text)
  assert.equal(f.user('unlabeled').adult, true)
  const page = await browser(f, cookie, '/admin?tab=users', undefined, { 'X-Beebo-Agent-Key': SECRET })
  assert.equal(page.status, 200)
  assert.match(page.text, /Remove adult label/)
})

test('expired away entitlement keeps home API usable but denies forwarded remote API', async t => {
  const f = await fixture(t, { license: { evaluate: () => ({ enforced: true, serve: false, state: 'expired' }) } })
  const home = await f.api('adult', '/api/me')
  assert.equal(home.status, 200, home.text)
  // Only a request that really came through the host agent can be Beebo Relay traffic, and
  // the agent with no path header (or relay-beebo) is not proven free.
  for (const headers of [
    { 'X-Beebo-Agent-Key': SECRET },
    { 'X-Beebo-Agent-Key': SECRET, 'X-Beebo-Remote-Path': 'relay-beebo' }
  ]) {
    const remote = await f.api('adult', '/api/me', undefined, headers)
    assert.equal(remote.status, 402, remote.text)
  }
  // Direct HTTPS is free: away from home, not through the agent, so it can never have used
  // Beebo's relay. Forwarding headers only ever make a request "away" (never home).
  for (const headers of [
    { 'X-Forwarded-For': '198.51.100.7', 'X-Forwarded-Proto': 'https' },
    { 'X-Beebo-Remote': '1' }
  ]) {
    const direct = await f.api('adult', '/api/me', undefined, headers)
    assert.equal(direct.status, 200, direct.text)
  }
  const health = await fetch(f.base + '/health', { headers: { 'X-Beebo-Agent-Key': SECRET } })
  assert.equal(health.status, 200)
  await health.arrayBuffer()
})
