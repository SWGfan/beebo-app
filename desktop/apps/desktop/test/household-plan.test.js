const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('node:os')
const path = require('node:path')
const auth = require('../electron/auth')
const plan = require('../electron/householdPlan')
const { testPort } = require('./helpers/testPort')

function store(initial = {}) {
  const data = structuredClone(initial)
  return { data, get: key => data[key], set: (key, value) => { data[key] = value }, delete: key => { delete data[key] }, onDidChange: () => () => {} }
}
const member = (id, status = 'approved') => ({ id, name: id, username: id, status, createdAt: 1 })
const six = () => Array.from({ length: 6 }, (_, i) => ({ ...member('person' + i), isAdmin: i === 0 }))

 test('six household people includes the owner and is independent of storage-computer licence limits', () => {
  const s = store({ license: { max_devices: 1 } })
  assert.ok(auth.createOwner(s, { username: 'owner', password: 'owner test password' }).user)
  for (let i = 0; i < 5; i++) assert.ok(auth.createUser(s, 'Family ' + i, '').user)
  const before = JSON.stringify(s.data)
  const extra = auth.createUser(s, 'Seventh person', '')
  assert.equal(extra.error, 'household_full')
  assert.match(extra.message, /6 people, including the owner/)
  assert.equal(JSON.stringify(s.data), before)
  assert.deepEqual(plan.capacity(s), { limit: 6, used: 6, approved: 6, pending: 0, available: 0, full: true, overLimit: false, includesOwner: true })
  s.data.license.max_devices = 99
  assert.equal(auth.createUser(s, 'Still seventh', '').error, 'household_full')
 })

 test('reserved invitations and unverified signups consume places; denied and revoked records do not', () => {
  const s = store({ authUsers: [member('owner'), member('invited', 'invited'), member('pending', 'pending'), member('signup', 'pending_verification'), { id: 'legacy', username: 'legacy' }, member('revoked', 'revoked'), member('denied', 'denied')] })
  assert.equal(plan.capacity(s).used, 5)
  const signup = auth.createSignup(s, { username: 'newfamily', email: 'family@example.test', password: 'family test password' })
  assert.ok(signup.token)
  assert.equal(plan.capacity(s).used, 6)
  const denied = auth.createSignup(s, { username: 'anotherfamily', email: 'another@example.test', password: 'another test password' })
  assert.equal(denied.error, 'household_full')
  assert.equal(auth.verifySignupToken(s, signup.token).ok, true)
  assert.equal(plan.capacity(s).used, 6, 'verification uses its reserved place')
  assert.equal(auth.reactivateUser(s, 'invited').ok, true, 'approving an invitation uses its reserved place')
  assert.equal(auth.reactivateUser(s, 'revoked').error, 'household_full')
  assert.equal(s.data.authUsers.find(u => u.id === 'revoked').status, 'revoked')
  auth.revokeUser(s, 'legacy')
  assert.equal(auth.reactivateUser(s, 'revoked').ok, true)
  assert.equal(plan.capacity(s).used, 6)
  assert.equal(auth.reactivateUser(s, 'missing').error, 'not_found')
 })

 test('requests do not reserve slots; approval does, and retries cannot create duplicate accounts', () => {
  const s = store({ authUsers: six().slice(0, 5) })
  const request = auth.submitAccessRequest(s, 'New member', 'new@example.test', 'Please add me')
  auth.submitAccessRequest(s, 'Waiting member', 'waiting@example.test', '')
  assert.equal(plan.capacity(s).used, 5)
  const approved = auth.approveRequest(s, request.id)
  assert.ok(approved.user)
  assert.equal(plan.capacity(s).used, 6)
  assert.equal(s.data.accessRequests.find(r => r.id === request.id).userId, approved.user.id)
  assert.equal(auth.approveRequest(s, request.id).error, 'request_already_processed')
  const pending = s.data.accessRequests.find(r => r.status === 'pending')
  assert.equal(auth.approveRequest(s, pending.id).error, 'household_full')
  assert.equal(s.data.accessRequests.find(r => r.id === pending.id).status, 'pending')
  assert.equal(plan.capacity(s).used, 6)
 })

 test('legacy households above six retain their existing members and sign-ins', () => {
  const s = store({ authUsers: [...six(), member('legacyseventh')] })
  const before = JSON.stringify(s.data.authUsers)
  assert.equal(plan.capacity(s).overLimit, true)
  assert.equal(auth.reactivateUser(s, 'legacyseventh').ok, true)
  assert.equal(auth.createUser(s, 'New eighth', '').error, 'household_full')
  assert.equal(JSON.stringify(s.data.authUsers), before)
  const token = auth.signSession(s, 'legacyseventh')
  assert.equal(auth.verifySession(s, token), 'legacyseventh')
 })

 test('extra purchased seats (worker/seatAddon.js) raise the household cap above the base 6', () => {
  const s = store({ authUsers: six(), 'license.seats': 2 })
  assert.deepEqual(plan.capacity(s), { limit: 8, used: 6, approved: 6, pending: 0, available: 2, full: false, overLimit: false, includesOwner: true })
  for (let i = 0; i < 2; i++) assert.ok(auth.createUser(s, 'Extra ' + i, '').user)
  assert.equal(plan.capacity(s).used, 8)
  const extra = auth.createUser(s, 'Ninth person', '')
  assert.equal(extra.error, 'household_full')
  assert.match(extra.message, /8 people, including the owner/)
})

test('a token with no seats field (old Worker reply, or no licence at all) behaves exactly as before: 0 extra seats', () => {
  const s = store({ authUsers: six() })
  assert.equal(plan.extraSeats(s), 0)
  assert.equal(plan.maxMembers(s), 6)
  const s2 = store({ authUsers: six(), 'license.seats': 0 })
  assert.equal(plan.extraSeats(s2), 0)
  // Garbage/negative/non-numeric values fail closed to 0 extra seats, never a guess.
  for (const bad of [-3, 'lots', null, undefined, NaN]) {
    assert.equal(plan.extraSeats(store({ 'license.seats': bad })), 0, JSON.stringify(bad))
  }
})

test('a purchased seat count is clamped to the documented maximum of 6 extra, never trusted past it', () => {
  const s = store({ 'license.seats': 999 })
  assert.equal(plan.extraSeats(s), plan.MAX_EXTRA_SEATS)
  assert.equal(plan.maxMembers(s), plan.BASE_MAX_MEMBERS + plan.MAX_EXTRA_SEATS)
})

test('first-owner creation cannot exceed the same household limit', () => {
  const s = store({ authUsers: six().map(u => ({ ...u, isAdmin: false })) })
  const result = auth.createOwner(s, { username: 'newowner', password: 'a good owner password' })
  assert.equal(result.error, 'household_full')
  assert.equal(s.data.authUsers.length, 6)
  auth.revokeUser(s, 'person5')
  assert.ok(auth.createOwner(s, { username: 'newowner', password: 'a good owner password' }).user)
  assert.equal(plan.capacity(s).used, 6)
 })

 test('concurrent signup callbacks cannot reserve more than six household places', async () => {
  const s = store({ authUsers: [{ ...member('owner'), isAdmin: true }] })
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => Promise.resolve().then(() => auth.createSignup(s, { username: 'member' + i, email: 'member' + i + '@example.test', password: 'a long test password' }))))
  assert.equal(results.filter(r => r.user).length, 5)
  assert.equal(results.filter(r => r.error === 'household_full').length, 7)
  assert.equal(plan.capacity(s).used, 6)
 })

 test('HTTP admission reports household_full clearly for reactivation, approval and public signup', async () => {
  const server = require('../electron/streamServer')
  const data = store({ authUsers: [...six(), member('revoked', 'revoked')], accessRequests: [{ id: 'request', name: 'Waiting', email: 'waiting@example.test', status: 'pending' }] })
  const agentSecret = 'household-capacity-test-secret-' + 'k'.repeat(40)
  let info
  try {
    info = server.startStreamServer({ port: testPort(), store: data, getMoviesDir: () => path.join(os.tmpdir(), 'beebo-nonexistent-household-test-library'), getTvShowsDir: () => '', getAllMoviesDirs: () => [], getAllTvShowsDirs: () => [], log: () => {}, agentSecret })
    const base = 'http://127.0.0.1:' + info.port
    const headers = { authorization: 'Bearer ' + server.makeApiToken(data, 'person0'), 'x-beebo-agent-key': agentSecret, 'content-type': 'application/json' }
    for (const [url, body] of [['/api/admin/users/reactivate', { userId: 'revoked' }], ['/api/admin/requests/approve', { requestId: 'request' }]]) {
      const response = await fetch(base + url, { method: 'POST', headers, body: JSON.stringify(body) })
      assert.equal(response.status, 409)
      const result = await response.json()
      assert.equal(result.error, 'household_full')
      assert.match(result.message, /6 people, including the owner/)
    }
    const response = await fetch(base + '/signup', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: 'eighthmember', email: 'eighth@example.test', password: 'safe test password' }) })
    assert.equal(response.status, 200)
    const html = await response.text()
    assert.match(html, /6 people, including the owner/)
    assert.equal(plan.capacity(data).used, 6)
    assert.equal(data.data.authUsers.find(u => u.id === 'revoked').status, 'revoked')
  } finally {
    if (info) await new Promise(resolve => info.close(resolve))
    auth.forgetSecrets(); server.forgetSecrets()
  }
 })
