// Relay metering, prices, the Cloudflare -> Beebo Relay switch-over, and relay
// credential lifetime. Run: node --test test/relay-metering.test.js
// (The agent-side tests need werift: set BEEBO_RTC_NODE_MODULES, as for own-relay.test.js.)
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const Module = require('node:module')

const appRoot = path.resolve(__dirname, '..')
const E = (f) => require(path.join(appRoot, 'electron', f))
const pricingMod = E('relayPricing.js')
const meter = E('relayMeter.js')
const policy = E('relayPolicy.js')
const { createRelayController, fetchCloudflareTurnEgress } = E('relayController.js')

const GB = 1e9
// The bundled file says Beebo Relay is free with 0% markup (see
// connection-options.test.js). These tests exercise the charging maths, so
// they use the same file as if fees had started, with a markup.
const BUNDLED = JSON.parse(fs.readFileSync(path.join(appRoot, 'electron', 'relay-pricing.fallback.json'), 'utf8'))
const DRAFT = JSON.parse(JSON.stringify(BUNDLED))
Object.assign(DRAFT, { status: 'live', freeAtThisTime: false, includedWithSubscription: false })
Object.assign(DRAFT.beeboRelay, { costPerGB: 0.011, payAsYouGoMarkupPercent: 20, prepaidMarkupPercent: 10, topUp: { amounts: [10, 25, 50], bonusTiers: [{ minAmount: 25, bonusPercent: 5 }, { minAmount: 50, bonusPercent: 10 }] }, lowBalanceWarnPercents: [25, 10] })
const P = pricingMod.parsePricing(DRAFT)
const T0 = Date.UTC(2026, 8, 15, 12, 0, 0)   // 2026-09-15 12:00 UTC

function fakeStore(initial = {}) {
  const data = JSON.parse(JSON.stringify(initial))
  return { data, get: (k, d) => (k in data ? JSON.parse(JSON.stringify(data[k])) : d), set: (k, v) => { data[k] = JSON.parse(JSON.stringify(v)) }, delete: (k) => { delete data[k] } }
}

// --- prices ---------------------------------------------------------------------

test('pricing: versions 2, 3 and 4 parsed; price per GB = cost x (1 + markup/100) for both ways of paying', () => {
  assert.equal(P.version, 4)
  assert.equal(P.free, false)
  assert.equal(P.beebo.costPerGB, 0.011)
  assert.equal(P.beebo.payAsYouGoPricePerGB, 0.0132)     // 0.011 x 1.20
  assert.equal(P.beebo.prepaidPricePerGB, 0.0121)        // 0.011 x 1.10
  assert.equal(P.beebo.chargedPricePerGB, 0.0132)
  assert.deepEqual(P.cloudflare, { freeGBPerMonth: 1000, switchAtGB: 950, pricePerGB: 0.05, pricesCheckedOn: '2026-09-15', source: 'https://developers.cloudflare.com/realtime/sfu/pricing/' })
  // An older version-2 file (planned, with markups) still reads.
  const v2 = JSON.parse(JSON.stringify(DRAFT)); v2.version = 2; v2.status = 'planned'; delete v2.freeAtThisTime
  assert.equal(pricingMod.parsePricing(v2).beebo.payAsYouGoPricePerGB, 0.0132)
  assert.equal(pricingMod.parsePricing(v2).free, false)
  // The bundled copy: free, at cost.
  const B = pricingMod.parsePricing(BUNDLED)
  assert.equal(B.free, true)
  assert.equal(B.beebo.payAsYouGoPricePerGB, 0)
  assert.equal(B.beebo.chargedPricePerGB, 0)
  assert.deepEqual(P.beebo.bonusTiers, [{ minAmount: 25, bonusPercent: 5 }, { minAmount: 50, bonusPercent: 10 }])
  assert.equal(pricingMod.topUpBonus(10, P.beebo.bonusTiers), 0)
  assert.equal(pricingMod.topUpBonus(25, P.beebo.bonusTiers), 1.25)
  assert.equal(pricingMod.topUpBonus(60, P.beebo.bonusTiers), 6)
  // Changing a number in the file changes the price: nothing hard-coded.
  const cheaper = JSON.parse(JSON.stringify(DRAFT)); cheaper.beeboRelay.costPerGB = 0.02; cheaper.beeboRelay.payAsYouGoMarkupPercent = 50
  assert.equal(pricingMod.parsePricing(cheaper).beebo.payAsYouGoPricePerGB, 0.03)
})

test('pricing: a wrong version, missing or bad numbers, or junk are refused', () => {
  const bad = (mut) => { const j = JSON.parse(JSON.stringify(DRAFT)); mut(j); return pricingMod.parsePricing(j) }
  assert.equal(bad((j) => { j.version = 1 }), null)
  assert.equal(bad((j) => { j.version = 5 }), null)
  assert.equal(bad((j) => { j.beeboRelay.prepaidMarkupPercent = -5 }), null)
  assert.equal(bad((j) => { j.beeboRelay.payAsYouGoMarkupPercent = '20' }), null)
  assert.equal(bad((j) => { delete j.beeboRelay.prepaidMarkupPercent }).beebo.prepaidMarkupPercent, 0, 'a missing markup is 0%')
  assert.equal(bad((j) => { j.beeboRelay.costPerGB = -1 }), null)
  assert.equal(bad((j) => { j.cloudflare.pricePerGB = '0.05' }), null)
  assert.equal(bad((j) => { j.cloudflare.switchAtGB = 1200 }), null)
  assert.equal(pricingMod.parsePricing('not json'), null)
  assert.equal(pricingMod.parsePricing(null), null)
  // Unknown extra fields are ignored.
  assert.ok(bad((j) => { j.somethingNew = { x: 1 } }))
})

test('pricing source: site -> cached in the store; failures keep the cache; nothing valid -> bundled copy', async () => {
  const store = fakeStore()
  let now = T0
  let reply = { ok: true, text: async () => JSON.stringify(DRAFT) }
  const calls = []
  const src = pricingMod.createPricingSource({ store, now: () => now, fetch: async (u) => { calls.push(u); return reply } })
  assert.equal(src.current().source, 'bundled')
  assert.equal(src.current().pricing.beebo.payAsYouGoPricePerGB, 0)
  assert.equal(src.current().pricing.free, true, 'the bundled copy: free at this time')
  const live = JSON.parse(JSON.stringify(DRAFT)); live.beeboRelay.costPerGB = 0.012
  reply = { ok: true, text: async () => JSON.stringify(live) }
  const r = await src.refresh(true)
  assert.equal(calls[0], 'https://www.beeboentertainment.com/relay-pricing.json')
  assert.equal(r.source, 'site')
  assert.equal(r.pricing.beebo.costPerGB, 0.012)
  // Inside 12 h: no refetch.
  await src.refresh()
  assert.equal(calls.length, 1)
  // Later, the site serves junk / a version this app doesn't know: the cache stays.
  now += 13 * 3600 * 1000
  reply = { ok: true, text: async () => JSON.stringify({ version: 9 }) }
  const r2 = await src.refresh()
  assert.equal(r2.pricing.beebo.costPerGB, 0.012)
  assert.equal(r2.source, 'cached')
  reply = { ok: false, status: 500, text: async () => '' }
  assert.equal((await src.refresh(true)).pricing.beebo.costPerGB, 0.012)
  // A corrupted cache falls back to the bundled copy.
  store.set('relayPricingCache', { fetchedAt: now, json: { version: 2 } })
  assert.equal(src.current().source, 'bundled')
})

// --- metering -------------------------------------------------------------------

test('meter: billing month from the reset day, in UTC', () => {
  const p = meter.periodFor(T0, 1)
  assert.equal(p.key, '2026-09-01')
  assert.equal(new Date(p.end).toISOString(), '2026-10-01T00:00:00.000Z')
  assert.equal(meter.periodFor(Date.UTC(2026, 8, 30, 23, 59, 59), 1).key, '2026-09-01')
  assert.equal(meter.periodFor(Date.UTC(2026, 9, 1, 0, 0, 0), 1).key, '2026-10-01')
  // Reset on the 20th: the 15th belongs to the month that began Aug 20.
  assert.equal(meter.periodFor(T0, 20).key, '2026-08-20')
  assert.equal(new Date(meter.periodFor(T0, 20).end).toISOString(), '2026-09-20T00:00:00.000Z')
  // December -> January, and days that not every month has are refused.
  assert.equal(new Date(meter.periodFor(Date.UTC(2026, 11, 31), 1).end).toISOString(), '2027-01-01T00:00:00.000Z')
  assert.equal(meter.periodFor(Date.UTC(2027, 0, 3), 5).key, '2026-12-05')
  assert.equal(meter.clampResetDay(31), 1)
  assert.equal(meter.clampResetDay('15'), 15)
})

test('meter: deltas add up per provider, survive a save/load, and roll over at the month boundary', () => {
  const store = fakeStore()
  let s = meter.addUsage(undefined, { cloudflare: 3 * GB, beebo: 1 * GB }, T0, 1)
  s = meter.addUsage(s, { cloudflare: 0.5 * GB, custom: 42, bogus: 99, beebo: -5 }, T0 + 1000, 1)
  store.set(meter.STORE_KEY, s)
  // "Restart": read it back.
  s = meter.normalize(store.get(meter.STORE_KEY), T0 + 2000, 1)
  assert.deepEqual(s.bytes, { cloudflare: 3.5 * GB, beebo: 1 * GB, custom: 42 })
  // Junk deltas are ignored.
  s = meter.addUsage(s, { cloudflare: 'lots', beebo: 1e14 }, T0 + 3000, 1)
  assert.equal(s.bytes.cloudflare, 3.5 * GB)
  s.policy.onBeebo = true
  // Midnight UTC on the 1st: a fresh month, the old one kept for reference.
  const oct = Date.UTC(2026, 9, 1, 0, 0, 1)
  const n = meter.addUsage(s, { cloudflare: 10 }, oct, 1)
  assert.equal(n.periodKey, '2026-10-01')
  assert.deepEqual(n.bytes, { cloudflare: 10, beebo: 0, custom: 0 })
  assert.equal(n.policy.onBeebo, false, 'the switch-over starts again each month')
  assert.equal(n.previous.periodKey, '2026-09-01')
  assert.equal(n.previous.bytes.cloudflare, 3.5 * GB)
})

test('meter: moving the reset day mid-month carries the count (never under-counts); provider figures win when higher', () => {
  let s = meter.addUsage(undefined, { cloudflare: 100 * GB }, T0, 1)
  const moved = meter.normalize(s, T0 + 1000, 10)
  assert.equal(moved.periodKey, '2026-09-10')
  assert.equal(moved.bytes.cloudflare, 100 * GB)
  s = meter.setReported(s, 'cloudflare', 120 * GB, '2026-09-01', T0, 1)
  assert.equal(meter.effectiveBytes(s, 'cloudflare'), 120 * GB)
  s = meter.setReported(s, 'cloudflare', 90 * GB, '2026-09-01', T0, 1)
  assert.equal(meter.effectiveBytes(s, 'cloudflare'), 100 * GB, 'our higher count stays')
  // A figure for a different month is ignored.
  s = meter.setReported(s, 'beebo', 5 * GB, '2026-08-01', T0, 1)
  assert.equal(meter.effectiveBytes(s, 'beebo'), 0)
})

// --- switch-over and modes --------------------------------------------------------

function usageWith(cfGB, pol = {}) {
  const s = meter.addUsage(undefined, { cloudflare: Math.round(cfGB * GB) }, T0, 1)
  Object.assign(s.policy, pol)
  return s
}

test('mode 3: below 950 GB offers Cloudflare; at 950 switches new connections to Beebo once, with hysteresis', () => {
  const base = { mode: 'cloudflare_then_beebo', ownKind: 'cloudflare', pricing: P, now: T0, beebo: { available: null } }
  let d = policy.decide({ ...base, usage: usageWith(949.9) })
  assert.deepEqual(d.order, ['cloudflare'])
  assert.equal(d.events.length, 0)
  d = policy.decide({ ...base, usage: usageWith(950) })
  assert.deepEqual(d.order, ['beebo', 'cloudflare'])
  assert.equal(d.policy.onBeebo, true)
  assert.deepEqual(d.events.map((e) => e.type), ['switched_to_beebo'])
  // Already switched: no second notice, and a correction to 940 (inside the 25 GB band) doesn't flap back.
  let d2 = policy.decide({ ...base, usage: usageWith(951, d.policy) })
  assert.equal(d2.events.length, 0)
  d2 = policy.decide({ ...base, usage: usageWith(940, d.policy) })
  assert.deepEqual(d2.order, ['beebo', 'cloudflare'])
  assert.equal(policy.HYSTERESIS_GB, 25)
  // Only a real drop below 925 goes back.
  const d3 = policy.decide({ ...base, usage: usageWith(920, d.policy) })
  assert.deepEqual(d3.order, ['cloudflare'])
  assert.deepEqual(d3.events.map((e) => e.type), ['back_to_cloudflare'])
})

test('mode 3: Beebo Relay not available or not allowed keeps Cloudflare and records that Cloudflare is now paid', () => {
  const base = { mode: 'cloudflare_then_beebo', ownKind: 'cloudflare', pricing: P, now: T0 }
  // Worker flag off: order still tries Beebo first (the agent pauses and falls back), notice once.
  let d = policy.decide({ ...base, usage: usageWith(960), beebo: { available: false, error: 'not_offered' } })
  assert.deepEqual(d.order, ['beebo', 'cloudflare'])
  assert.equal(d.status.code, 'cloudflare_paid')
  assert.ok(d.policy.payingCloudflareSince)
  assert.ok(d.events.some((e) => e.type === 'beebo_unavailable_paying_cloudflare' && e.reason === 'not_offered'))
  const again = policy.decide({ ...base, now: T0 + 60000, usage: usageWith(961, d.policy), beebo: { available: false, error: 'not_offered' } })
  assert.equal(again.events.length, 0, 'no repeat notice within 6 hours')
  // The wallet hook says no: Beebo isn't even tried.
  policy.setBeeboRelayAllowedHook(() => ({ allowed: false, reason: 'balance_empty' }))
  try {
    const allowed = policy.beeboRelayAllowed({})
    assert.deepEqual(allowed, { allowed: false, reason: 'balance_empty' })
    d = policy.decide({ ...base, usage: usageWith(970), allowed, beebo: { available: true } })
    assert.deepEqual(d.order, ['cloudflare'])
    assert.equal(d.status.code, 'cloudflare_paid')
    assert.equal(d.status.beeboBlocked, 'balance_empty')
  } finally { policy.setBeeboRelayAllowedHook(null) }
  assert.deepEqual(policy.beeboRelayAllowed({}), { allowed: true, reason: '' })
  // A hook that throws fails closed for Beebo (Cloudflare continues).
  policy.setBeeboRelayAllowedHook(() => { throw new Error('x') })
  try { assert.equal(policy.beeboRelayAllowed({}).allowed, false) } finally { policy.setBeeboRelayAllowedHook(null) }
})

test('modes 1, 2 and 4, and old settings', () => {
  const u = usageWith(2000)
  assert.deepEqual(policy.decide({ mode: 'off', ownKind: 'cloudflare', usage: u, pricing: P, now: T0 }).order, [])
  assert.deepEqual(policy.decide({ mode: 'own', ownKind: 'cloudflare', usage: u, pricing: P, now: T0 }).order, ['cloudflare'], 'own Cloudflare never switches')
  assert.deepEqual(policy.decide({ mode: 'own', ownKind: 'turn', usage: u, pricing: P, now: T0 }).order, ['custom'])
  assert.deepEqual(policy.decide({ mode: 'own', ownKind: null, usage: u, pricing: P, now: T0 }).order, [])
  assert.deepEqual(policy.decide({ mode: 'beebo_only', ownKind: 'cloudflare', usage: usageWith(0), pricing: P, now: T0 }).order, ['beebo'])
  assert.deepEqual(policy.decide({ mode: 'beebo_only', ownKind: null, usage: u, pricing: P, now: T0, allowed: { allowed: false, reason: 'no_consent' } }).order, [])
  assert.equal(policy.normalizeMode(undefined, true), 'own', 'someone who already set up their own relay keeps using it')
  assert.equal(policy.normalizeMode(undefined, false), 'off')
})

test('settings model: figures and costs; "Beebo Relay only" never exposes Cloudflare figures', () => {
  let u = meter.addUsage(undefined, { cloudflare: 1100 * GB, beebo: 50 * GB }, T0, 1)
  const log = [
    { at: T0, title: 'Relay moved to Beebo Relay', body: 'Your Cloudflare relay has carried 950 GB this month', mentions: ['cloudflare'] },
    { at: T0, title: 'Beebo note', body: 'plain', mentions: [] },
  ]
  const m3 = policy.settingsModel({ mode: 'cloudflare_then_beebo', ownKind: 'cloudflare', usage: u, pricing: P, pricingSource: 'site', status: { code: 'beebo' }, log, now: T0 })
  assert.equal(m3.cloudflare.gb, 1100)
  assert.equal(m3.cloudflare.estimatedCost, 5)          // 100 GB over x $0.05
  assert.equal(m3.cloudflare.switchAtGB, 950)
  assert.equal(m3.beebo.gb, 50)
  assert.equal(m3.beebo.estimatedCost, 0.66)            // 50 x 0.0132
  assert.equal(m3.period.resetDate, '2026-10-01')
  assert.match(m3.example, /2-hour HD film/)
  assert.equal(m3.log.length, 2)
  assert.equal(m3.guideUrl, 'https://www.beeboentertainment.com/own-relay.html')

  const m4 = policy.settingsModel({ mode: 'beebo_only', ownKind: 'cloudflare', usage: u, pricing: P, pricingSource: 'site', status: { code: 'beebo' }, log, now: T0 })
  assert.equal(m4.cloudflare, undefined)
  assert.equal(m4.custom, undefined)
  assert.equal(m4.beebo.gb, 50)
  // The option labels name the other modes, and `pricing` is the published price
  // list for the side-by-side cost comparison of every option; nothing else may.
  const { modes, pricing: _p, ...rest } = m4
  assert.doesNotMatch(JSON.stringify(rest), /cloudflare/i)
  assert.ok(!JSON.stringify(rest).includes('1100') && !JSON.stringify(rest).includes('1,100'))
  assert.deepEqual(m4.log.map((e) => e.title), ['Beebo note'])
  // Even with Beebo unavailable, the notice doesn't mention Cloudflare.
  const m4b = policy.settingsModel({ mode: 'beebo_only', ownKind: 'cloudflare', usage: u, pricing: P, status: { code: 'beebo_unavailable', beeboBlocked: 'not_offered' }, now: T0 })
  const { modes: _m, pricing: _p2, ...rest2 } = m4b
  assert.doesNotMatch(JSON.stringify(rest2), /cloudflare/i)

  const own = policy.settingsModel({ mode: 'own', ownKind: 'cloudflare', usage: u, pricing: P, status: { code: 'own' }, now: T0 })
  assert.ok(own.cloudflare && own.beebo === undefined, 'own Cloudflare: no Beebo figures')
  assert.equal(own.cloudflare.switchAtGB, null)
  const off = policy.settingsModel({ mode: 'off', ownKind: null, usage: u, pricing: P, status: { code: 'direct' }, now: T0 })
  assert.ok(!off.cloudflare && !off.beebo)
})

test('controller: agent usage reports persist, cross 950 GB, send the new plan, notify once and log it', () => {
  const store = fakeStore({ relayMode: 'cloudflare_then_beebo', rtcRelay: { kind: 'cloudflare', keyId: 'abcdef0123456789', secretEnc: 'x' } })
  const plans = [], notes = []
  let now = T0
  const make = () => createRelayController({
    store,
    pricing: { current: () => ({ pricing: P, source: 'site' }), refresh: async () => ({}) },
    getOwnRelay: () => ({ kind: 'cloudflare', keyId: 'abcdef0123456789' }),
    getRemoteHost: () => ({ setRelayPlan: (p) => plans.push(p.order.join(',')) }),
    notify: (n) => notes.push(n),
    now: () => now,
  })
  let c = make()
  c.evaluate()
  assert.equal(plans.at(-1), 'cloudflare')
  c.onAgentMessage({ type: 'relayUsage', deltas: { cloudflare: 949 * GB } })
  assert.equal(plans.at(-1), 'cloudflare')
  c = make()   // app restart: the count is in the store
  c.onAgentMessage({ type: 'relayUsage', deltas: { cloudflare: 1 * GB } })
  assert.equal(plans.at(-1), 'beebo,cloudflare')
  assert.equal(notes.length, 1)
  assert.equal(notes[0].title, 'Relay moved to Beebo Relay')
  c.onAgentMessage({ type: 'relayUsage', deltas: { cloudflare: 5 * GB, beebo: 2 * GB } })
  assert.equal(notes.length, 1, 'one notice per switch')
  assert.equal(store.data.relayLog.length, 1)
  // Beebo Relay's own figure for the same calendar month is used when higher.
  c.onAgentMessage({ type: 'relayStatus', beeboUsage: { month: '2026-09', bytes: 3 * GB } })
  let m = c.getModel()
  assert.equal(m.beebo.gb, 3)
  assert.equal(m.cloudflare.gb, 955)
  assert.equal(m.log[0].title, 'Relay moved to Beebo Relay')
  // Beebo Relay turns out to be unavailable: shown, logged, Cloudflare kept.
  c.onAgentMessage({ type: 'relayStatus', beebo: { available: false, error: 'relay_not_enabled' } })
  m = c.getModel()
  assert.equal(m.status, 'cloudflare_paid')
  assert.match(m.notice, /isn’t turned on for your account/)
  assert.equal(notes.length, 2)
  // Switching to Beebo only hides Cloudflare from the model.
  assert.equal(c.setMode('beebo_only').ok, true)
  assert.equal(plans.at(-1), 'beebo')
  assert.equal(c.getModel().cloudflare, undefined)
  assert.equal(c.setMode('nonsense').ok, false)
  assert.equal(c.setResetDay(29).ok, false)
  // Next month: back to Cloudflare first.
  c.setMode('cloudflare_then_beebo')
  now = Date.UTC(2026, 9, 1, 0, 5)
  c.evaluate()
  assert.equal(plans.at(-1), 'cloudflare')
  assert.equal(c.getModel().cloudflare.gb, 0)
})

test('Cloudflare analytics reconciliation: the documented GraphQL call, summed egress, the higher figure wins', async () => {
  const seen = []
  const fakeFetch = async (url, opts) => {
    seen.push({ url, opts })
    return { ok: true, json: async () => ({ data: { viewer: { accounts: [{ callsTurnUsageAdaptiveGroups: [{ sum: { egressBytes: 600 * GB } }, { sum: { egressBytes: 400 * GB } }] }] } } }) }
  }
  const bytes = await fetchCloudflareTurnEgress({ accountId: 'a'.repeat(32), apiToken: 'ANALYTICS-TOKEN', keyId: 'abcdef0123456789', from: '2026-09-01', to: '2026-09-15' }, fakeFetch)
  assert.equal(bytes, 1000 * GB)
  assert.equal(seen[0].url, 'https://api.cloudflare.com/client/v4/graphql')
  assert.equal(seen[0].opts.headers.authorization, 'Bearer ANALYTICS-TOKEN')
  const body = JSON.parse(seen[0].opts.body)
  assert.match(body.query, /callsTurnUsageAdaptiveGroups/)
  assert.match(body.query, /egressBytes/)
  assert.deepEqual(body.variables, { accountTag: 'a'.repeat(32), keyId: 'abcdef0123456789', from: '2026-09-01', to: '2026-09-15' })
  await assert.rejects(fetchCloudflareTurnEgress({ accountId: 'a', apiToken: 't', keyId: 'k', from: 'x', to: 'y' }, async () => ({ ok: false, status: 403 })), /http_403/)

  const store = fakeStore({ relayMode: 'cloudflare_then_beebo', cloudflareAnalytics: { accountId: 'a'.repeat(32) }, cloudflareAnalyticsToken: 'ANALYTICS-TOKEN' })
  const plans = []
  const c = createRelayController({
    store, fetch: fakeFetch, now: () => T0,
    pricing: { current: () => ({ pricing: P, source: 'site' }), refresh: async () => ({}) },
    getOwnRelay: () => ({ kind: 'cloudflare', keyId: 'abcdef0123456789' }),
    getRemoteHost: () => ({ setRelayPlan: (p) => plans.push(p.order.join(',')) }),
  })
  c.onAgentMessage({ type: 'relayUsage', deltas: { cloudflare: 10 * GB } })
  assert.equal(plans.at(-1), 'cloudflare')
  await c.reconcileCloudflare(true)
  const m = c.getModel()
  assert.equal(m.cloudflare.gb, 1000, 'Cloudflare says more than we counted: use theirs')
  assert.equal(m.cloudflare.fromCloudflare, true)
  assert.equal(plans.at(-1), 'beebo,cloudflare', 'and the switch happens on it')
  assert.ok(!JSON.stringify(m).includes('ANALYTICS-TOKEN'), 'the token never reaches Settings')
})

// --- agent: meter maths, credentials ----------------------------------------------

const NM = [process.env.BEEBO_RTC_NODE_MODULES, path.join(appRoot, 'resources', 'beebo-rtc-host', 'node_modules')]
  .filter(Boolean).find((d) => fs.existsSync(path.join(d, 'werift', 'package.json')))
const skip = NM ? false : 'werift not found (set BEEBO_RTC_NODE_MODULES)'
function loadAgent() {
  process.env.BEEBO_HOST_TOKEN = 'test.token'
  process.env.BEEBO_VERBOSE = '0'
  process.env.NODE_PATH = NM
  Module._initPaths()
  return require(path.join(appRoot, 'resources', 'beebo-rtc-host', 'beebo-rtc-host.js'))
}

test('agent meter: only relayed pairs count, both directions, twice when both ends relay, with overhead', { skip }, async () => {
  const a = loadAgent()
  assert.equal(a.billableBytes(0, 0), 0)
  assert.equal(a.billableBytes(1000, 1), Math.ceil((1000 + a.METER_PACKET_OVERHEAD) * a.METER_OVERHEAD_FACTOR))
  assert.ok(a.billableBytes(1200, 1) > 1200 * 1.05, 'a typical datagram is over-counted by more than 5%')
  const pair = (l, r) => ({ localCandidate: { type: l }, remoteCandidate: { type: r } })
  assert.equal(a.pairRelayHops(undefined), 0)
  assert.equal(a.pairRelayHops(pair('host', 'srflx')), 0)
  assert.equal(a.pairRelayHops(pair('host', 'relay')), 1)
  assert.equal(a.pairRelayHops(pair('relay', 'host')), 1)
  assert.equal(a.pairRelayHops(pair('relay', 'relay')), 2)
  // A stand-in for werift's ICE Connection.
  const subs = []
  const conn = { nominated: pair('host', 'srflx'), sent: 0, sendTo: async function (d) { this.sent += d.length }, onData: { subscribe: (fn) => subs.push(fn) } }
  const pc = { iceTransports: [{ connection: conn }] }
  a.takeMeterDeltas()
  a.attachMeter({ relayProvider: 'cloudflare' }, pc)
  a.attachMeter({ relayProvider: 'cloudflare' }, pc)   // attaching twice doesn't double count
  await conn.sendTo(Buffer.alloc(1000))
  subs.forEach((f) => f(Buffer.alloc(100)))
  assert.deepEqual(a.takeMeterDeltas(), {}, 'direct: nothing counted')
  assert.equal(conn.sent, 1000, 'data still goes out')
  conn.nominated = pair('host', 'relay')
  await conn.sendTo(Buffer.alloc(1000))
  subs.forEach((f) => f(Buffer.alloc(100)))
  assert.deepEqual(a.takeMeterDeltas(), { cloudflare: a.billableBytes(1100, 2) })
  conn.nominated = pair('relay', 'relay')
  await conn.sendTo(Buffer.alloc(1000))
  assert.deepEqual(a.takeMeterDeltas(), { cloudflare: a.billableBytes(2000, 2) })
  // A session given no relay by this house isn't counted even if the viewer relays.
  const conn2 = { nominated: pair('host', 'relay'), sendTo: async () => {}, onData: { subscribe: () => {} } }
  a.attachMeter({ relayProvider: '' }, { iceTransports: [{ connection: conn2 }] })
  await conn2.sendTo(Buffer.alloc(5000))
  assert.deepEqual(a.takeMeterDeltas(), {})
})

test('agent credentials: 12 h lifetime, reuse only while young and never under an hour left', { skip }, () => {
  const a = loadAgent()
  assert.equal(a.RELAY_TTL_S, 12 * 3600)
  const t = 1_800_000_000_000
  const exp = Math.floor(t / 1000) + a.RELAY_TTL_S
  assert.equal(a.relayCredentialPlan({ issuedAtMs: t, expiresAtS: exp, nowMs: t + 1000 }), 'reuse')
  assert.equal(a.relayCredentialPlan({ issuedAtMs: t, expiresAtS: exp, nowMs: t + a.RELAY_REUSE_MS }), 'renew')
  // The worst a viewer can get: issued just before the reuse window closes, still >= 11.5 h.
  const worst = exp * 1000 - (t + a.RELAY_REUSE_MS - 1)
  assert.ok(worst >= 11.5 * 3600 * 1000)
  // Short-lived credentials (e.g. a Worker handing out 90 min) aren't reused near expiry.
  assert.equal(a.relayCredentialPlan({ issuedAtMs: t, expiresAtS: Math.floor(t / 1000) + 3500, nowMs: t + 1000 }), 'renew')
  assert.equal(a.relayCredentialPlan({ issuedAtMs: 0, expiresAtS: exp, nowMs: t }), 'renew')
  assert.equal(a.relayCredentialPlan({ issuedAtMs: t, expiresAtS: exp, nowMs: t - 5000 }), 'renew', 'clock went backwards')
})

test('agent: Beebo Relay credentials from the Worker are shape-checked; refusals become reason codes', { skip }, () => {
  const a = loadAgent()
  const now = 1_800_000_000
  const ok = a.parseBeeboCredentials(200, {
    iceServers: [{ urls: ['turn:relay1.beebo.tv:3478?transport=udp', 'turns:relay1.beebo.tv:443?transport=tcp', 'javascript:alert(1)'], username: `${now + 28800}:b0123456789abcdef01234567`, credential: 'c2VjcmV0' }, { urls: ['turn:x:1'], username: 5, credential: 'x' }],
    expiresAt: now + 28800, ttl: 28800, mode: 'own_first',
  }, now)
  assert.deepEqual(ok.servers, [{ urls: ['turn:relay1.beebo.tv:3478?transport=udp', 'turns:relay1.beebo.tv:443?transport=tcp'], username: `${now + 28800}:b0123456789abcdef01234567`, credential: 'c2VjcmV0' }])
  assert.equal(ok.expiresAt, now + 28800)
  assert.deepEqual(a.parseBeeboCredentials(404, { error: 'not_found' }, now), { error: 'not_offered' })
  assert.deepEqual(a.parseBeeboCredentials(403, { error: 'relay_not_enabled' }, now), { error: 'relay_not_enabled' })
  assert.deepEqual(a.parseBeeboCredentials(402, { error: 'no_active_subscription' }, now), { error: 'no_active_subscription' })
  assert.deepEqual(a.parseBeeboCredentials(429, { error: 'relay_cap_reached' }, now), { error: 'relay_cap_reached' })
  assert.deepEqual(a.parseBeeboCredentials(500, { error: '<script>' }, now), { error: 'http_500' })
  assert.deepEqual(a.parseBeeboCredentials(200, { iceServers: [] }, now), { error: 'relay_not_configured' })
})
