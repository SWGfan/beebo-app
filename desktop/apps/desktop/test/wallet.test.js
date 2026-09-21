// Beebo Relay prepaid wallet on the PC: beeboRelayAllowed() from /wallet/me,
// fail-safe when Beebo can't be reached, notifications once per crossing, the
// $0 fallback in the relay plan, and the Settings model's cost comparison.
// Run: node --test test/wallet.test.js   (no Electron, no network)
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')

const appRoot = path.resolve(__dirname, '..')
const E = (f) => require(path.join(appRoot, 'electron', f))
const { createWalletClient, decideAllowed, notificationFor, CACHE_TRUST_MS } = E('walletClient.js')
const { walletSettingsModel, compareChoices, projectedMonthlyGB } = E('walletModel.js')
const policy = E('relayPolicy.js')
const meter = E('relayMeter.js')
const pricingMod = E('relayPricing.js')
const { createRelayController } = E('relayController.js')

const GB = 1e9
// The bundled file says Beebo Relay is free at this time (no balance needed; see
// connection-options.test.js). The wallet tests exercise what happens once fees
// start, so they use the same file with fees on and a markup.
const PAID = JSON.parse(fs.readFileSync(path.join(appRoot, 'electron', 'relay-pricing.fallback.json'), 'utf8'))
Object.assign(PAID, { status: 'live', freeAtThisTime: false, includedWithSubscription: false })
Object.assign(PAID.beeboRelay, { costPerGB: 0.011, payAsYouGoMarkupPercent: 20, prepaidMarkupPercent: 10, topUp: { amounts: [10, 25, 50], bonusTiers: [{ minAmount: 25, bonusPercent: 5 }, { minAmount: 50, bonusPercent: 10 }] }, lowBalanceWarnPercents: [25, 10] })
const P = pricingMod.parsePricing(PAID)
const T0 = Date.UTC(2026, 8, 15, 12, 0, 0)

function fakeStore(initial = {}) {
  const data = JSON.parse(JSON.stringify(initial))
  return { data, get: (k, d) => (k in data ? JSON.parse(JSON.stringify(data[k])) : d), set: (k, v) => { data[k] = JSON.parse(JSON.stringify(v)) }, delete: (k) => { delete data[k] } }
}
const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body })

function me({ amount = 20, allowed = true, reason = '', paying = 'prepaid', level = 'ok', seq = 0, uses = true, role = 'owner', choice = null, remember = false } = {}) {
  return {
    enabled: true, role,
    balance: { micros: Math.round(amount * 1e6), amount },
    lastTopUpCredit: 25,
    warning: { level, seq, percentLeft: Math.round((amount / 25) * 100) },
    estimate: { hoursHDLeft: Math.floor(amount / (3 * 0.0121)) },
    relay: { usesBeeboRelay: uses, allowed, reason, paying, mode: 'beebo_only' },
    pricing: { payAsYouGoPricePerGB: 0.0132, prepaidPricePerGB: 0.0121, lowBalanceWarnPercents: [25, 10], topUps: [{ amount: 10 }, { amount: 25 }, { amount: 50 }], balancePolicy: 'Never expires. Refundable on request.' },
    choice: { choice, remember, needed: level === 'empty' || level === 'low10' },
    payg: { active: choice === 'payg', unbilled: 0 },
    ledger: [{ id: 2, at: T0 / 1000, kind: 'usage', amount: -1.21, balanceAfter: amount, gb: 100 }, { id: 1, at: T0 / 1000 - 10, kind: 'topup', amount: 26.25, paid: 25, bonus: 1.25 }],
  }
}

function client({ store = fakeStore(), responses = [], now = () => T0, token = 'tok' } = {}) {
  const calls = []
  const notes = []
  const changes = []
  const c = createWalletClient({
    store,
    getToken: () => token,
    backendUrl: 'https://worker.example/',
    now,
    fetch: async (url, init) => {
      calls.push({ url, init })
      const r = responses.length > 1 ? responses.shift() : responses[0]
      if (r instanceof Error) throw r
      return typeof r === 'function' ? r(url, init) : r
    },
    notify: (n) => notes.push(n),
    onChange: (d) => changes.push(d),
  })
  return { c, calls, notes, changes, store }
}

// --- beeboRelayAllowed() --------------------------------------------------------

test('allowed: follows /wallet/me; 404 (wallet not switched on) keeps Beebo Relay as before', async () => {
  let t = client({ responses: [reply(200, me({ amount: 12 }))] })
  await t.c.refresh()
  assert.deepEqual(t.c.allowed(), { allowed: true, reason: '' })
  assert.equal(t.calls[0].url, 'https://worker.example/wallet/me')
  assert.equal(t.calls[0].init.headers.authorization, 'Bearer tok')

  t = client({ responses: [reply(200, me({ amount: 0, allowed: false, reason: 'wallet_empty', paying: '', level: 'empty', seq: 1 }))] })
  await t.c.refresh()
  assert.deepEqual(t.c.allowed(), { allowed: false, reason: 'wallet_empty' })

  t = client({ responses: [reply(200, me({ amount: 0, allowed: true, paying: 'payg', level: 'empty', choice: 'payg' }))] })
  await t.c.refresh()
  assert.equal(t.c.allowed().allowed, true, 'the owner agreed to pay as you go')

  t = client({ responses: [reply(404, { error: 'not_found' })] })
  await t.c.refresh()
  assert.deepEqual(t.c.allowed(), { allowed: true, reason: '' })
})

test('fail-safe: unreachable never assumes consent; only a fresh prepaid answer carries over', async () => {
  // Never heard from the wallet at all (first start, offline): paused.
  let t = client({ responses: [new Error('ENOTFOUND')] })
  assert.deepEqual(t.c.allowed(), { allowed: false, reason: 'wallet_unreachable' }, 'before the first answer')
  await t.c.refresh()
  assert.deepEqual(t.c.allowed(), { allowed: false, reason: 'wallet_unreachable' })

  // Last answer: pay as you go, then Beebo goes unreachable -> paused, not charged on a stale consent.
  let now = T0
  const store = fakeStore()
  t = client({ store, now: () => now, responses: [reply(200, me({ amount: 0, paying: 'payg', choice: 'payg', level: 'empty' })), new Error('timeout')] })
  await t.c.refresh()
  assert.equal(t.c.allowed().allowed, true)
  await t.c.refresh()
  assert.deepEqual(t.c.allowed(), { allowed: false, reason: 'wallet_unreachable' })

  // Last answer: a prepaid balance, under an hour old -> still allowed; older -> paused.
  now = T0
  const store2 = fakeStore()
  t = client({ store: store2, now: () => now, responses: [reply(200, me({ amount: 9 })), reply(503, { error: 'x' })] })
  await t.c.refresh()
  now = T0 + 10 * 60 * 1000
  await t.c.refresh()
  assert.equal(t.c.allowed().allowed, true, 'prepaid balance seen 10 minutes ago')
  now = T0 + CACHE_TRUST_MS + 1
  assert.deepEqual(t.c.allowed(), { allowed: false, reason: 'wallet_unreachable' })
  // The cache survives a restart (it lives in the store), under the same rule.
  now = T0 + 5 * 60 * 1000
  const restarted = client({ store: store2, now: () => now, responses: [new Error('offline')] })
  assert.equal(restarted.c.allowed().allowed, true)

  // Signed out: not allowed, and says why.
  t = client({ token: '', responses: [reply(200, me())] })
  await t.c.refresh()
  assert.deepEqual(t.c.allowed(), { allowed: false, reason: 'unauthorized' })
  assert.equal(t.calls.length, 0, 'no request without a token')

  // A junk 200 is an error, not a yes.
  t = client({ responses: [reply(200, { hello: 'world' })] })
  await t.c.refresh()
  assert.equal(t.c.allowed().allowed, false)
  assert.equal(decideAllowed(null, null, T0).allowed, false)
})

test('the hook: relayPolicy.beeboRelayAllowed() uses the wallet, and a throwing hook is a no', async () => {
  const t = client({ responses: [reply(200, me({ amount: 0, allowed: false, reason: 'wallet_cloudflare_only', paying: '', level: 'empty' }))] })
  await t.c.refresh()
  policy.setBeeboRelayAllowedHook(() => t.c.allowed())
  try {
    assert.deepEqual(policy.beeboRelayAllowed({}), { allowed: false, reason: 'wallet_cloudflare_only' })
    policy.setBeeboRelayAllowedHook(() => { throw new Error('boom') })
    assert.deepEqual(policy.beeboRelayAllowed({}), { allowed: false, reason: 'check_failed' })
  } finally { policy.setBeeboRelayAllowedHook(null) }
  assert.equal(t.changes.length, 1)
})

test('$0 with no choice: Beebo Relay pauses -> own Cloudflare if set up, otherwise direct only', () => {
  const usage = meter.freshState(T0, 1)
  const refused = { allowed: false, reason: 'wallet_empty' }
  let d = policy.decide({ mode: 'beebo_only', ownKind: 'cloudflare', usage, pricing: P, allowed: refused, now: T0 })
  assert.deepEqual(d.order, ['cloudflare'])
  assert.equal(d.status.code, 'wallet_cloudflare')
  d = policy.decide({ mode: 'beebo_only', ownKind: null, usage, pricing: P, allowed: refused, now: T0 })
  assert.deepEqual(d.order, [])
  d = policy.decide({ mode: 'beebo_only', ownKind: 'turn', usage, pricing: P, allowed: { allowed: false, reason: 'wallet_unreachable' }, now: T0 })
  assert.deepEqual(d.order, [], 'a custom TURN server is not the Cloudflare fallback')
  // A non-wallet refusal in Beebo-only mode is unchanged: no Cloudflare.
  d = policy.decide({ mode: 'beebo_only', ownKind: 'cloudflare', usage, pricing: P, allowed: { allowed: false, reason: 'relay_suspended' }, now: T0 })
  assert.deepEqual(d.order, [])
  // Cloudflare first, past the switch: stays on Cloudflare.
  const past = meter.addUsage(usage, { cloudflare: 960 * GB }, T0, 1)
  d = policy.decide({ mode: 'cloudflare_then_beebo', ownKind: 'cloudflare', usage: past, pricing: P, allowed: refused, now: T0 })
  assert.deepEqual(d.order, ['cloudflare'])
  // Settings says so in plain words.
  const m = policy.settingsModel({ mode: 'beebo_only', ownKind: 'cloudflare', usage, pricing: P, pricingSource: 'bundled', status: { code: 'wallet_cloudflare', beeboBlocked: 'wallet_empty' }, now: T0 })
  assert.equal(m.notice, 'Your Beebo Relay balance is used up, so relayed connections use your own Cloudflare for now.')
})

// --- notifications ---------------------------------------------------------------

test('notifications: once per crossing, again only for a new crossing', async () => {
  const store = fakeStore()
  const answers = [
    me({ amount: 20 }),
    me({ amount: 6, level: 'low25', seq: 1 }),
    me({ amount: 5.5, level: 'low25', seq: 1 }),
    me({ amount: 5.5, level: 'low25', seq: 1 }),
    me({ amount: 2, level: 'low10', seq: 2 }),
    me({ amount: 0, level: 'empty', seq: 3, allowed: false, reason: 'wallet_empty', paying: '' }),
    me({ amount: 0, level: 'empty', seq: 3, allowed: false, reason: 'wallet_empty', paying: '' }),
    me({ amount: 26, level: 'ok', seq: 3 }), // topped up
    me({ amount: 6, level: 'low25', seq: 4 }), // crossed again
  ].map((b) => reply(200, b))
  const t = client({ store, responses: answers.concat([answers[answers.length - 1]]) })
  for (let i = 0; i < answers.length; i++) await t.c.refresh()
  assert.deepEqual(t.notes.map((n) => n.title), [
    'Beebo Relay balance low',
    'Beebo Relay: about 55 hours of HD left',
    'Beebo Relay paused',
    'Beebo Relay balance low',
  ])
  assert.match(t.notes[0].body, /\$6\.00 left, about 165 hours of HD/)
  assert.match(t.notes[2].body, /nothing is charged/)
  // A restart doesn't repeat the last one (kept in the store).
  const again = client({ store, responses: [answers[answers.length - 1]] })
  await again.c.refresh()
  assert.equal(again.notes.length, 0)
  // Members, and accounts that don't relay through Beebo, get none.
  assert.equal(notificationFor(me({ level: 'low25', seq: 1, role: 'member' })), null)
  assert.equal(notificationFor(me({ level: 'low25', seq: 1, uses: false })), null)
  assert.match(notificationFor(me({ amount: 0, level: 'empty', seq: 5, paying: 'payg', choice: 'payg' })).body, /\$0\.0132\/GB on your monthly bill/)
})

test('top up and choice: Stripe URL only, errors in plain words', async () => {
  let t = client({ responses: [reply(200, { url: 'https://checkout.stripe.com/c/pay/cs_1' })] })
  assert.deepEqual(await t.c.topUp(25), { ok: true, url: 'https://checkout.stripe.com/c/pay/cs_1' })
  assert.equal(JSON.parse(t.calls[0].init.body).amount, 25)
  assert.equal(t.calls[0].init.method, 'POST')
  t = client({ responses: [reply(200, { url: 'https://evil.example/pay' })] })
  assert.equal((await t.c.topUp(25)).ok, false, 'never opens anything but Stripe Checkout')
  t = client({ responses: [new Error('offline')] })
  assert.equal((await t.c.topUp(10)).ok, false)
  t = client({ responses: [reply(200, { ok: true, state: me({ amount: 0, paying: 'payg', choice: 'payg', remember: true, level: 'empty' }) })] })
  assert.deepEqual(await t.c.setChoice('payg', true), { ok: true })
  assert.deepEqual(JSON.parse(t.calls[0].init.body), { choice: 'payg', remember: true })
  assert.equal(t.c.allowed().allowed, true)
  t = client({ responses: [reply(409, { error: 'payg_needs_subscription' })] })
  assert.match((await t.c.setChoice('payg', false)).error, /subscription/)
})

// --- Settings model -------------------------------------------------------------

test('comparison from relay-pricing.json and the PC meter; Cloudflare only as an alternative in Beebo-only mode', () => {
  // 10 days into the month, 400 GB relayed -> about 1,200 GB a month.
  const usage = meter.addUsage(meter.freshState(Date.UTC(2026, 8, 1), 1), { beebo: 300 * GB, cloudflare: 100 * GB }, Date.UTC(2026, 8, 1), 1)
  const now = Date.UTC(2026, 8, 11)
  const proj = projectedMonthlyGB(usage, now)
  assert.equal(Math.round(proj.monthlyGB), 1200)

  const c = compareChoices({ pricing: P, monthlyGB: 1200, mode: 'beebo_only', ownKind: null })
  const by = Object.fromEntries(c.options.map((o) => [o.id, o]))
  assert.equal(by.topup.monthly, 14.52) // 1200 x 0.0121
  assert.equal(by.payg.monthly, 15.84) // 1200 x 0.0132
  assert.equal(by.cloudflare_only.monthly, 10) // (1200 - 1000) x 0.05
  assert.equal(by.cloudflare_only.alternative, true)
  assert.equal(by.cloudflare_only.needsSetup, true)
  assert.equal(c.cheapest, 'topup', 'an option that needs setting up is not called the cheapest')
  assert.match(by.topup.detail, /Top up \$50 and get 10% extra, about \$13\.20 a month/)

  const cf = compareChoices({ pricing: P, monthlyGB: 1200, mode: 'cloudflare_then_beebo', ownKind: 'cloudflare' })
  const cby = Object.fromEntries(cf.options.map((o) => [o.id, o]))
  assert.equal(cf.beeboGB, 250, 'only what is past the 950 GB switch goes through Beebo')
  assert.equal(cby.topup.monthly, 3.03)
  assert.equal(cby.cloudflare_only.alternative, false)
  assert.equal(cf.cheapest, 'topup')

  const low10 = walletSettingsModel({
    state: { kind: 'ok', me: me({ amount: 2, level: 'low10', seq: 2 }) },
    pricing: P, usage, mode: 'beebo_only', ownKind: null, now,
  })
  assert.equal(low10.show, true)
  assert.equal(low10.balanceText, '$2.00')
  assert.equal(low10.hoursHDLeft, 55)
  assert.match(low10.banner.text, /^Beebo Relay balance: \$2\.00, about 55 hours of HD left \(about 4 days at your recent use\)\.$/)
  assert.equal(low10.banner.urgent, true)
  assert.deepEqual(low10.topUps.map((q) => [q.amount, q.bonus, q.credit]), [[10, 0, 10], [25, 1.25, 26.25], [50, 5, 55]])
  assert.ok(low10.choiceScreen)
  assert.match(low10.choiceScreen.basedOn, /400 GB relayed so far, about 1,200 GB a month/)
  assert.match(low10.choiceScreen.fallback, /viewers connect directly only/)
  assert.equal(low10.ledger[1].text, 'Top-up $25.00 + $1.25 bonus')

  const ok = walletSettingsModel({ state: { kind: 'ok', me: me({ amount: 20 }) }, pricing: P, usage, mode: 'beebo_only', ownKind: 'cloudflare', now })
  assert.equal(ok.banner, null)
  assert.equal(ok.choiceScreen, null)
  assert.equal(walletSettingsModel({ state: { kind: 'ok', me: me() }, pricing: P, usage, mode: 'own', ownKind: 'cloudflare', now }).show, false, 'no wallet in own-relay mode')
  const down = walletSettingsModel({ state: { kind: 'error', error: 'unreachable' }, pricing: P, usage, mode: 'beebo_only', ownKind: null, now })
  assert.equal(down.status, 'unreachable')
  assert.match(down.notice, /paused until it can, so nothing is charged by surprise/)
  assert.equal(walletSettingsModel({ state: { kind: 'off' }, pricing: P, usage, mode: 'beebo_only', ownKind: null, now }).status, 'off')
})

test('controller: getModel carries the wallet; a wallet refusal from the agent triggers a re-check', async () => {
  const store = fakeStore({ relayMode: 'beebo_only' })
  let soon = 0
  const wallet = {
    getState: () => ({ kind: 'ok', me: me({ amount: 1, level: 'low10', seq: 2 }) }),
    refreshSoon: () => { soon++ },
  }
  const ctl = createRelayController({ store, pricing: { current: () => ({ pricing: P, source: 'bundled' }), refresh: async () => {} }, getOwnRelay: () => null, getRemoteHost: () => null, wallet, now: () => T0 })
  const m = ctl.getModel()
  assert.equal(m.wallet.show, true)
  assert.equal(m.wallet.level, 'low10')
  ctl.onAgentMessage({ type: 'relayStatus', beebo: { available: false, error: 'wallet_empty' } })
  ctl.onAgentMessage({ type: 'relayStatus', beebo: { available: false, error: 'relay_cap_reached' } })
  assert.equal(soon, 1)
  ctl.stop()
})
