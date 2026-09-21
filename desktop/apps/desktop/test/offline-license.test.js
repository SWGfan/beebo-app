'use strict'
// The licence with the internet gone. A signed token carries its own offline grace (the service sets its expiry to
// the end of the paid period plus 14 days), so a household whose internet is down keeps its away-from-home plan
// until then, and home viewing is never gated at all. Nothing on this side can extend or forge that time.
// Run: node --test test/offline-license.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { createLicense } = require('../electron/license')
const { signToken } = require('../electron/licenseToken')
const { createRevalidateSchedule, isOutage } = require('../electron/revalidateSchedule')

const keys = crypto.generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } })
const other = crypto.generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } })
const DAY = 86400
const T0 = 1_800_000_000
const DEVICE = 'dev_offline_test'

function household(payload, { signWith = keys.privateKey, fetch, clock = { t: T0 } } = {}) {
  const data = { 'license.deviceId': DEVICE }
  if (payload) data['license.token'] = signToken(payload, signWith)
  const store = { get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] } }
  const calls = []
  const lic = createLicense({
    store, now: () => clock.t,
    fetch: fetch || (async (url) => { calls.push(String(url)); throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }) }),
    config: { enabled: true, publicKey: keys.publicKey, backendUrl: 'https://login.example.test' }
  })
  return { lic, data, calls, clock }
}
// What the service issues: the paid period ends at periodEnd; the token lasts 14 days past it.
const subscription = (periodEnd, extra = {}) => ({ type: 'subscription', plan: 'beebo-standard', email: 'kim@example.test', deviceId: DEVICE, issuedAt: periodEnd - 30 * DAY, expiresAt: periodEnd + 14 * DAY, ...extra })

test('internet down: a paid household keeps its away-from-home plan until the token\'s own expiry, and is asked to renew', async () => {
  const h = household(subscription(T0 - 5 * DAY)) // period ended 5 days ago; 9 of the 14 grace days remain
  let ev = h.lic.evaluate()
  assert.equal(ev.serve, true)
  assert.equal(ev.state, 'grace', 'inside the renew window: still serving, will renew when it can')
  const r = await h.lic.revalidate()
  assert.equal(r.ok, false)
  assert.match(r.reason, /^network:/)
  assert.ok(h.data['license.token'], 'a failed renewal never removes the token')
  ev = h.lic.evaluate()
  assert.equal(ev.serve, true, 'still valid after the failed renewal')
})

test('the period ended 10 days ago and the internet has been down since: 4 of the 14 grace days are left, then it stops', () => {
  const periodEnd = T0 - 10 * DAY
  const clock = { t: T0 }
  const h = household(subscription(periodEnd), { clock })
  assert.equal(h.lic.evaluate().serve, true)
  clock.t = periodEnd + 14 * DAY - 1
  assert.equal(h.lic.evaluate().serve, true, 'the last second of the grace')
  clock.t = periodEnd + 14 * DAY
  const ev = h.lic.evaluate()
  assert.equal(ev.serve, false)
  assert.equal(ev.state, 'expired')
})

test('a failed renewal does not extend anything, and there is no offline extension on this side', async () => {
  const clock = { t: T0 }
  const h = household(subscription(T0 - 13 * DAY), { clock }) // expires in one day
  for (let i = 0; i < 5; i++) await h.lic.revalidate()
  clock.t = T0 + DAY + 1
  assert.equal(h.lic.evaluate().serve, false, 'five "successful" contacts with nobody home change nothing: the signed expiry decides')
  assert.equal(h.lic.evaluate().state, 'expired')
})

test('home is never gated, whatever the licence says, online or off', () => {
  const clock = { t: T0 }
  const cases = [null, subscription(T0 - 30 * DAY), subscription(T0 + 30 * DAY, { deviceId: 'another-device' }), { type: 'trial', expiresAt: T0 + DAY }]
  for (const payload of cases) {
    const s = household(payload, { clock }).lic.accessStatus()
    assert.equal(s.homeAllowed, true)
    assert.equal(s.awayAllowed, false)
  }
  assert.equal(household(subscription(T0 + 30 * DAY), { clock }).lic.accessStatus().awayAllowed, true)
})

test('offline cannot be used to get a paid entitlement: forged, other-device, tampered and unsigned tokens all stay locked', () => {
  const good = subscription(T0 + 30 * DAY)
  assert.equal(household(good, { signWith: other.privateKey }).lic.evaluate().serve, false, 'signed with someone else\'s key')
  assert.equal(household({ ...good, deviceId: 'copied-from-another-pc' }).lic.evaluate().serve, false, 'issued to another install')
  const h = household(good)
  const [payload, sig] = h.data['license.token'].split('.')
  const bumped = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), expiresAt: T0 + 3650 * DAY })).toString('base64url')
  h.data['license.token'] = bumped + '.' + sig
  assert.equal(h.lic.evaluate().serve, false, 'expiry edited by hand')
  assert.equal(household(null).lic.evaluate().serve, false, 'no token: no entitlement, home unaffected')
})

test('a token the service never issued cannot be made valid by "revalidating" with the internet down', async () => {
  const h = household(null)
  const r = await h.lic.revalidate()
  assert.equal(r.ok, false)
  assert.equal(h.lic.evaluate().serve, false)
  assert.equal(h.lic.accessStatus().homeAllowed, true)
})

test('sign-in with the internet down fails quickly with a network reason, never a throw, and nothing is saved', async () => {
  const h = household(null)
  const t0 = Date.now()
  const r = await h.lic.login('kim@example.test', 'a long password')
  assert.equal(r.ok, false)
  assert.match(r.reason, /^network:/)
  assert.ok(Date.now() - t0 < 1000)
  assert.equal(h.data['license.token'], undefined)
  assert.equal(h.lic.accessStatus().homeAllowed, true)
})

// ---- when Beebo asks again --------------------------------------------------------------------------------------
function fakeTimers() {
  const pending = []
  return {
    setTimer: (fn, ms) => { const t = { fn, ms, unref() {} }; pending.push(t); return t },
    clearTimer: (t) => { const i = pending.indexOf(t); if (i >= 0) pending.splice(i, 1) },
    next: () => pending.shift(),
    pending
  }
}
const MIN = 60 * 1000

test('renewal schedule: nothing is sent when signed out', async () => {
  const tm = fakeTimers()
  let ran = 0
  const s = createRevalidateSchedule({ run: async () => { ran++; return { ok: true } }, hasToken: () => false, setTimer: tm.setTimer, clearTimer: tm.clearTimer })
  s.start()
  assert.equal(tm.pending[0].ms, 8000)
  await tm.next().fn()
  assert.equal(ran, 0, 'no token, nothing to renew, nothing asked of beebo.tv')
  assert.equal(tm.pending[0].ms, 12 * 60 * MIN)
})

test('renewal schedule: an unreachable service is retried after 2, 5, 15, 30, then every 60 minutes; an answer returns it to 12 hours', async () => {
  const tm = fakeTimers()
  const results = [
    { ok: false, reason: 'network:fetch failed' }, { ok: false, reason: 'network:fetch failed' }, { ok: false, reason: 'http_503' },
    { ok: false, reason: 'network:x' }, { ok: false, reason: 'network:x' }, { ok: false, reason: 'network:x' },
    { ok: true, unchanged: true }
  ]
  let i = 0
  const s = createRevalidateSchedule({ run: async () => results[i++], hasToken: () => true, setTimer: tm.setTimer, clearTimer: tm.clearTimer })
  s.start()
  const delays = []
  for (let k = 0; k < results.length; k++) { await tm.next().fn(); delays.push(tm.pending[0].ms / MIN) }
  assert.deepEqual(delays, [2, 5, 15, 30, 60, 60, 720])
  assert.equal(s.failures(), 0)
})

test('renewal schedule: "the service said no" is an answer, not an outage', () => {
  assert.equal(isOutage({ ok: false, reason: 'network:fetch failed' }), true)
  assert.equal(isOutage({ ok: false, reason: 'http_502' }), true)
  assert.equal(isOutage({ ok: false, reason: 'http_401' }), false)
  assert.equal(isOutage({ ok: false, reason: 'email_required' }), false)
  assert.equal(isOutage({ ok: true, revoked: true }), false)
})

test('renewal schedule: a throwing renewal never becomes an app problem, and stop() ends it', async () => {
  const tm = fakeTimers()
  const s = createRevalidateSchedule({ run: async () => { throw new Error('boom') }, hasToken: () => true, setTimer: tm.setTimer, clearTimer: tm.clearTimer })
  s.start()
  await tm.next().fn()
  assert.equal(tm.pending.length, 1, 'still scheduled')
  s.stop()
  assert.equal(tm.pending.length, 0)
})
