// The licence backend moves to Beebo's own server: https://login.beebo.tv first,
// the old workers.dev address as a fallback when the primary cannot be reached
// or its edge answers with a gateway error.
// Run: node --test test/license-backend-fallback.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const localRequire = createRequire(path.join(path.resolve(__dirname, '..'), 'package.json'))
const { createLicense } = localRequire('./electron/license')
const { signToken } = localRequire('./electron/licenseToken')

const keys = crypto.generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})
const PRIMARY = 'https://login.beebo.tv'
const FALLBACK = 'https://fallback.example.test'
const nowS = Math.floor(Date.now() / 1000)

function setup(handler, extra = {}) {
  const data = { 'license.deviceId': 'dev_test' }
  const store = { get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] } }
  const calls = []
  let clock = 1_000_000
  const fetch = async (url, init) => {
    calls.push(String(url))
    return handler(String(url), init)
  }
  const lic = createLicense({
    store, fetch, clockMs: () => clock,
    config: { enabled: true, publicKey: keys.publicKey, backendUrl: PRIMARY, fallbackUrls: [FALLBACK], ...extra },
  })
  return { lic, calls, data, advance: (ms) => { clock += ms } }
}
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const token = () => signToken({ type: 'subscription', plan: 'beebo-standard', licenseId: 'BEEBO-AAAA-BBBB-CCCC', deviceId: 'dev_test', email: 'kim@example.com', expiresAt: nowS + 30 * 86400 }, keys.privateKey)

test('the PC app ships with login.beebo.tv first (no fallback address is listed in the public source)', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
  assert.match(main, /backendUrl: 'https:\/\/login\.beebo\.tv',/)
  assert.match(main, /fallbackUrls: \[\],/)
  // Callers ask license.backendUrl() (follows a fallback); only "is licensing configured" reads the setting.
  assert.equal((main.match(/license\.config\.backendUrl/g) || []).length, 1)
  assert.match(main, /configured: !!\(license\.config\.enabled && license\.config\.publicKey && license\.config\.backendUrl\)/)
  assert.ok((main.match(/license\.backendUrl\(\)/g) || []).length >= 3)
})

test('primary answers: only the primary is asked', async () => {
  const { lic, calls } = setup((url) => json(200, { token: token(), status: 'active' }))
  const r = await lic.login('kim@example.com', 'pw-123456')
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.deepEqual(calls, [PRIMARY + '/auth/login'])
  assert.equal(lic.backendUrl(), PRIMARY)
})

test('primary unreachable (DNS/TLS/connection error): the fallback answers, and is used first for a while', async () => {
  const { lic, calls, advance } = setup((url) => {
    if (url.startsWith(PRIMARY)) throw new TypeError('fetch failed')
    return json(200, { token: token(), status: 'active' })
  })
  let r = await lic.login('kim@example.com', 'pw-123456')
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.deepEqual(calls, [PRIMARY + '/auth/login', FALLBACK + '/auth/login'])
  assert.equal(lic.backendUrl(), FALLBACK, 'other parts of the app follow')
  calls.length = 0
  r = await lic.revalidate()
  assert.equal(r.ok, true)
  assert.deepEqual(calls, [FALLBACK + '/validate'], 'no wait on the dead primary')
  advance(11 * 60 * 1000)
  assert.equal(lic.backendUrl(), PRIMARY, 'the primary is tried again later')
})

test('gateway errors fall through; real answers (401, 400, 404, 429) do not', async () => {
  for (const status of [502, 503, 504, 521, 522, 530]) {
    const { lic, calls } = setup((url) => url.startsWith(PRIMARY) ? json(status, {}) : json(200, { token: token() }))
    const r = await lic.login('kim@example.com', 'pw-123456')
    assert.equal(r.ok, true, 'status ' + status)
    assert.equal(calls.length, 2, 'status ' + status)
  }
  for (const status of [400, 401, 404, 429]) {
    const { lic, calls } = setup(() => json(status, { error: 'invalid_credentials' }))
    const r = await lic.login('kim@example.com', 'wrong-password')
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'invalid_credentials')
    assert.deepEqual(calls, [PRIMARY + '/auth/login'], 'status ' + status + ' is an answer, not an outage')
  }
})

test('both down: the last answer or a network reason, never a throw', async () => {
  let s = setup((url) => url.startsWith(PRIMARY) ? json(502, {}) : json(503, { error: 'maintenance' }))
  let r = await s.lic.login('kim@example.com', 'pw-123456')
  assert.equal(r.ok, false)
  assert.equal(r.status, 503)
  s = setup(() => { throw new TypeError('fetch failed') })
  r = await s.lic.activate('BEEBO-AAAA-BBBB-CCCC')
  assert.deepEqual(r, { ok: false, reason: 'network:fetch failed' })
  assert.equal(s.lic.backendUrl(), PRIMARY)
  const v = await s.lic.revalidate()
  assert.equal(v.ok, false)
  assert.match(v.reason, /^network:/)
})

test('an owner override in licenseConfig still wins; only https addresses are used', async () => {
  const { lic, calls } = setup(() => json(200, { token: token() }), { backendUrl: 'https://staging.beebo.tv/', fallbackUrls: ['http://insecure.example', FALLBACK, FALLBACK] })
  assert.deepEqual(lic.backendUrls(), ['https://staging.beebo.tv', FALLBACK])
  await lic.login('kim@example.com', 'pw-123456')
  assert.deepEqual(calls, ['https://staging.beebo.tv/auth/login'])
  const none = setup(() => json(200, {}), { backendUrl: '', fallbackUrls: undefined })
  assert.equal(none.lic.evaluate().state, 'disabled', 'still switched off without a backend')
})
