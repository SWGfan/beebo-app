// license.js caches the household's plan (from the signed token payload) into
// `store` on every accepted token, so other main-process modules (streamServer.js's
// away-from-home quality cap) can read "what plan is this household on" the same
// way other cross-module policy state is read from store, without needing a
// reference to the license instance itself. The signed payload stays the
// authoritative source wherever it's reachable (streamServer.js prefers
// license.evaluate().payload.plan and only falls back to this store key) -
// this cache exists for convenience/other consumers, not as the source of truth.
// Run: node --test test/license-plan-persistence.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const path = require('node:path')
const { createRequire } = require('node:module')
const localRequire = createRequire(path.join(path.resolve(__dirname, '..'), 'package.json'))
const { createLicense } = localRequire('./electron/license')
const { signToken } = localRequire('./electron/licenseToken')

const keys = crypto.generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})
const now = Math.floor(Date.now() / 1000)

function setup() {
  const data = { 'license.deviceId': 'dev_test' }
  const store = { get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] } }
  return { data, store }
}

const subscription = (plan) => ({ type: 'subscription', plan, email: 'owner@example.test', deviceId: 'dev_test', issuedAt: now - 100, expiresAt: now + 86400 })

test('acceptToken (via login) caches the plan from the signed payload into store', async () => {
  const { data, store } = setup()
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(String(url))
    return { ok: true, status: 200, json: async () => ({ token: signToken(subscription('beebo-standard-4k'), keys.privateKey), status: 'active', plan: 'beebo-standard-4k' }) }
  }
  const lic = createLicense({ store, fetch: fetchImpl, config: { enabled: true, publicKey: keys.publicKey, backendUrl: 'https://licensing.example' } })
  const r = await lic.login('owner@example.test', 'hunter22')
  assert.equal(r.ok, true)
  assert.equal(data['license.plan'], 'beebo-standard-4k')
})

test('a plan change on renewal (revalidate) updates the cached plan', async () => {
  const { data, store } = setup()
  data['license.token'] = signToken(subscription('beebo-standard-4k'), keys.privateKey)
  let nextToken = signToken(subscription('beebo-standard'), keys.privateKey)
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ token: nextToken }) })
  const lic = createLicense({ store, fetch: fetchImpl, config: { enabled: true, publicKey: keys.publicKey, backendUrl: 'https://licensing.example' } })
  // Simulate the plan already cached from an earlier session before this test's revalidate runs.
  data['license.plan'] = 'beebo-standard-4k'
  const r = await lic.revalidate()
  assert.equal(r.ok, true)
  assert.equal(data['license.plan'], 'beebo-standard', 'downgraded plan is re-cached, not left stale')
})

test('activate() also caches the plan (every acceptToken call site is covered)', async () => {
  const { data, store } = setup()
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ token: signToken(subscription('beebo-standard'), keys.privateKey) }) })
  const lic = createLicense({ store, fetch: fetchImpl, config: { enabled: true, publicKey: keys.publicKey, backendUrl: 'https://licensing.example' } })
  const r = await lic.activate('BEEBO-TEST-0001')
  assert.equal(r.ok, true)
  assert.equal(data['license.plan'], 'beebo-standard')
})

test('a token without a plan field never overwrites (or fabricates) a cached plan', async () => {
  const { data, store } = setup()
  data['license.plan'] = 'beebo-standard-4k'
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ token: signToken({ type: 'trial', deviceId: 'dev_test', email: 'owner@example.test', expiresAt: now + 86400 }, keys.privateKey) }) })
  const lic = createLicense({ store, fetch: fetchImpl, config: { enabled: true, publicKey: keys.publicKey, backendUrl: 'https://licensing.example' } })
  await lic.login('owner@example.test', 'hunter22')
  assert.equal(data['license.plan'], 'beebo-standard-4k', 'no plan in the new payload - previous value is left alone, not cleared')
})

// Extra household seats (worker/seatAddon.js) ride the same signed payload as
// plan, cached into store the same way, for householdPlan.js's capacity check.
test('acceptToken also caches extra household seats from the signed payload', async () => {
  const { data, store } = setup()
  const payload = Object.assign(subscription('beebo-standard'), { seats: 3 })
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ token: signToken(payload, keys.privateKey) }) })
  const lic = createLicense({ store, fetch: fetchImpl, config: { enabled: true, publicKey: keys.publicKey, backendUrl: 'https://licensing.example' } })
  const r = await lic.login('owner@example.test', 'hunter22')
  assert.equal(r.ok, true)
  assert.equal(data['license.seats'], 3)
})

test('a seat count of exactly 0 is cached (a real, meaningful answer), not treated as "no field"', async () => {
  const { data, store } = setup()
  data['license.seats'] = 4
  const payload = Object.assign(subscription('beebo-standard'), { seats: 0 })
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ token: signToken(payload, keys.privateKey) }) })
  const lic = createLicense({ store, fetch: fetchImpl, config: { enabled: true, publicKey: keys.publicKey, backendUrl: 'https://licensing.example' } })
  await lic.login('owner@example.test', 'hunter22')
  assert.equal(data['license.seats'], 0, 'cancelling every extra seat is applied, not ignored because 0 is falsy')
})

test('a token with no seats field at all (old Worker reply, or a trial) never overwrites a cached seat count', async () => {
  const { data, store } = setup()
  data['license.seats'] = 2
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ token: signToken({ type: 'trial', deviceId: 'dev_test', email: 'owner@example.test', expiresAt: now + 86400 }, keys.privateKey) }) })
  const lic = createLicense({ store, fetch: fetchImpl, config: { enabled: true, publicKey: keys.publicKey, backendUrl: 'https://licensing.example' } })
  await lic.login('owner@example.test', 'hunter22')
  assert.equal(data['license.seats'], 2, 'no seats field in the new payload - previous value is left alone')
})
