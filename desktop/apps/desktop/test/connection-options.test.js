// Connection options: Beebo Relay free at this time (0% markup), Cloudflare only,
// "How to set it up" guides, and the cost comparison of every option.
// Run: node --test test/connection-options.test.js   (no Electron, no network)
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')

const appRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(appRoot, '..', '..', '..')
const E = (f) => require(path.join(appRoot, 'electron', f))
const { createConnectionTest } = E('connectionTest.js')
const pricingMod = E('relayPricing.js')
const policy = E('relayPolicy.js')
const walletModel = E('walletModel.js')
const meter = E('relayMeter.js')
const loadModel = () => import(pathToFileURL(path.join(appRoot, 'src', 'lib', 'connectionModel.js')).href)
const loadCosts = () => import(pathToFileURL(path.join(appRoot, 'src', 'lib', 'connectionCosts.js')).href)
// The website pricing table lives in the private site-pages/ folder; without it use the identical copy bundled with the app.
const SITE = JSON.parse(fs.readFileSync(fs.existsSync(path.join(repoRoot, 'site-pages', 'relay-pricing.json')) ? path.join(repoRoot, 'site-pages', 'relay-pricing.json') : path.join(appRoot, 'electron', 'relay-pricing.fallback.json'), 'utf8'))
const src = (f) => fs.readFileSync(path.join(appRoot, 'src', 'components', f), 'utf8')

function memStore(init = {}) {
  const m = new Map(Object.entries(init))
  return { get: (k) => m.get(k), set: (k, v) => m.set(k, v), delete: (k) => m.delete(k), _m: m }
}
function fakeFetch(routes) {
  const calls = []
  const f = async (url, init) => {
    calls.push({ url, init })
    const r = routes[new URL(url).pathname]
    if (!r) return { status: 404, json: async () => ({ error: 'not_found' }) }
    if (r === 'throw') throw new Error('offline')
    return { status: r.status, json: async () => r.body }
  }
  f.calls = calls
  return f
}

// ---------------------------------------------------------------------------
// Cloudflare only (relay mode 'own'): never Beebo Relay, on any side.

test('Cloudflare only: this PC switches to its own relay first, then Beebo Relay is turned off for the account', async () => {
  const f = fakeFetch({ '/relay/opt-out': { status: 200, body: { ok: true, enabled: false, free: false, usage: { month: '2026-09', usedGB: 3, capGB: 200 } } } })
  const modes = []
  const store = memStore({ relayMode: 'beebo_only', connectionSetup: { choice: 'relay' } })
  const ct = createConnectionTest({ store, getToken: () => 'LIC', backendUrl: 'https://svc.example', fetch: f, getRelayController: () => ({ setMode: (m) => { modes.push(m); store.set('relayMode', m) } }) })
  const r = await ct.choose('cloudflare')
  assert.equal(r.ok, true)
  assert.deepEqual(modes, ['own'])
  assert.equal(f.calls.length, 1)
  assert.equal(new URL(f.calls[0].url).pathname, '/relay/opt-out')
  assert.equal(f.calls[0].init.method, 'POST')
  assert.equal(f.calls[0].init.headers.authorization, 'Bearer LIC')
  assert.equal(r.relay.enabled, false)
  assert.equal(store.get('connectionSetup').choice, 'cloudflare')

  // Opted out even when Beebo Relay wasn't turned on from this computer.
  const f2 = fakeFetch({ '/relay/opt-out': { status: 200, body: { enabled: false } } })
  const store2 = memStore()
  const ct2 = createConnectionTest({ store: store2, getToken: () => 'LIC', backendUrl: 'https://svc.example', fetch: f2 })
  assert.equal((await ct2.choose('cloudflare')).ok, true)
  assert.equal(store2.get('relayMode'), 'own')
  assert.equal(f2.calls.length, 1)

  // Beebo Relay not switched on at Beebo at all (404): fine.
  const store3 = memStore()
  const ct3 = createConnectionTest({ store: store3, getToken: () => 'LIC', backendUrl: 'https://svc.example', fetch: fakeFetch({}) })
  assert.equal((await ct3.choose('cloudflare')).ok, true)
  assert.equal(store3.get('connectionSetup').choice, 'cloudflare')

  // Offline: the PC is already on its own relay (it never asks Beebo), and the failure is reported.
  const store4 = memStore({ relayMode: 'beebo_only' })
  const ct4 = createConnectionTest({ store: store4, getToken: () => 'LIC', backendUrl: 'https://svc.example', fetch: fakeFetch({ '/relay/opt-out': 'throw' }) })
  assert.deepEqual(await ct4.choose('cloudflare'), { ok: false, error: 'unreachable', modeSet: true })
  assert.equal(store4.get('relayMode'), 'own')
  assert.equal(store4.get('connectionSetup'), undefined)

  // Leaving Cloudflare only for home only turns this PC's own relay off again.
  assert.deepEqual(await ct.choose('home_only'), { ok: true })
  assert.equal(store.get('relayMode'), 'off')
})

test('Cloudflare only: the relay plan never includes Beebo Relay, and the chooser names it', () => {
  const pricing = pricingMod.bundled()
  const T = Date.UTC(2026, 8, 15)
  const u = meter.addUsage(undefined, { cloudflare: 2000 * 1e9 }, T, 1)
  for (const kind of ['cloudflare', 'turn', null]) {
    const d = policy.decide({ mode: 'own', ownKind: kind, usage: u, pricing, now: T })
    assert.ok(!d.order.includes('beebo'), String(kind))
  }
  const cf = policy.modeInfo('own', { pricing, ownKind: 'cloudflare' })
  assert.equal(cf.label, 'Cloudflare only (your own Cloudflare account)')
  assert.equal(cf.explain, 'Your video uses your own Cloudflare account when a direct connection isn’t possible. It never passes through Beebo’s servers. Cloudflare’s own pricing applies (first 1,000 GB a month free, then Cloudflare bills you $0.05/GB).')
  assert.equal(policy.modeInfo('own', { pricing, ownKind: null }).label, 'Cloudflare only (your own Cloudflare account)')
  assert.equal(policy.modeInfo('own', { pricing, ownKind: 'turn' }).label, 'Your own relay only')
  assert.equal(SITE.cloudflare.freeGBPerMonth, 1000)
  assert.equal(SITE.cloudflare.pricePerGB, 0.05)
  // A Settings pick of 'own' goes through the same opt-out (main.js).
  const main = fs.readFileSync(path.join(appRoot, 'electron', 'main.js'), 'utf8')
  assert.ok(/if \(m === 'own'\) \{[\s\S]{0,200}await connectionTest\.chooseCloudflareOnly\(\)/.test(main))
  // The wizard's 4 choices, Cloudflare only second.
  const opts = src('ConnectionOptions.jsx')
  const order = ['data-option="relay"', 'data-option="cloudflare"', 'data-option="ports"', 'data-option="home_only"'].map((s) => opts.indexOf(s))
  assert.ok(order.every((i, n) => i > 0 && (n === 0 || i > order[n - 1])), 'Beebo Relay, Cloudflare only, Open ports, Home only')
  assert.ok(opts.includes("pick('cloudflare')") && opts.includes('openOwnRelaySetup()'))
  assert.ok(src('OwnRelay.jsx').includes('id="beebo-own-relay"'))
  assert.ok(fs.readFileSync(path.join(appRoot, 'src', 'App.jsx'), 'utf8').includes("addEventListener('beebo:open-settings'"))
})

// ---------------------------------------------------------------------------
// "How to set it up"

test('every connection option has a guide: a short offline summary and a beeboentertainment.com page', async () => {
  const M = await loadModel()
  const want = {
    direct: 'https://www.beeboentertainment.com/direct-connection.html',
    ports: 'https://www.beeboentertainment.com/open-ports.html',
    relay: 'https://www.beeboentertainment.com/beebo-relay.html',
    cloudflare: 'https://www.beeboentertainment.com/own-relay.html',
    cloudflare_then_beebo: 'https://www.beeboentertainment.com/beebo-relay.html#cloudflare-first',
    home_only: 'https://www.beeboentertainment.com/direct-connection.html#home-only',
  }
  assert.deepEqual(Object.keys(M.GUIDES).sort(), Object.keys(want).sort())
  for (const [k, url] of Object.entries(want)) {
    assert.equal(M.GUIDES[k].url, url, k)
    assert.ok(M.GUIDES[k].title && M.GUIDES[k].steps.length >= 3, k)
    const file = url.replace('https://www.beeboentertainment.com/', '').replace(/#.*/, '')
    if (file === 'own-relay.html') continue // already on the website
    if (!fs.existsSync(path.join(repoRoot, 'site-pages', file))) continue // website pages are private
    const html = fs.readFileSync(path.join(repoRoot, 'site-pages', file), 'utf8')
    const anchor = url.split('#')[1]
    if (anchor) assert.ok(html.includes(`id="${anchor}"`), url)
  }
  assert.ok(M.GUIDES.ports.steps.some((t) => t.includes('UDP') && t.includes('47820–47829')))
  assert.ok(M.GUIDES.ports.steps.some((t) => /never use DMZ/.test(t)))
  assert.ok(M.GUIDES.relay.steps.some((t) => /included/i.test(t)))
  const main = fs.readFileSync(path.join(appRoot, 'electron', 'main.js'), 'utf8')
  assert.ok(main.includes("const DEFAULT_RTC_UDP_PORTS = '47820-47829'"), 'the guide quotes the real default ports')
  const opts = src('ConnectionOptions.jsx')
  for (const k of ['direct', 'relay', 'cloudflare', 'ports', 'home_only']) assert.ok(opts.includes(`<SetupGuide which="${k}"`), k)
  assert.ok(src('OwnRelay.jsx').includes('<SetupGuide which={o.guide}'))
  for (const id of policy.MODES) assert.ok(M.GUIDES[policy.modeInfo(id).guide], id)
  assert.ok(src('ConnectionSettings.jsx').includes('<SetupGuide which={STATUS_GUIDE[status]'))
  assert.ok(src('SetupGuide.jsx').includes('api.openExternal?.(g.url)'), 'opened with the openExternal bridge')
})

test('the site pages keep the privacy and cost facts', { skip: require('./helpers/privateParts').skipIfMissing('site-pages') }, () => {
  const page = (f) => fs.readFileSync(path.join(repoRoot, 'site-pages', f), 'utf8')
  const relay = page('beebo-relay.html')
  for (const s of ['Free at this time', '0% markup', '7 days', 'Beauharnois', 'OVHcloud', 'DTLS', 'id="cloudflare-first"', '950']) assert.ok(relay.includes(s), s)
  const ports = page('open-ports.html')
  for (const s of ['47820', '47829', 'UDP', 'Rogers', 'Bell', 'Telus', 'DMZ']) assert.ok(ports.includes(s), s)
  const direct = page('direct-connection.html')
  for (const s of ['id="home-only"', 'UPnP', 'NAT-PMP']) assert.ok(direct.includes(s), s)
  for (const f of ['beebo-relay.html', 'open-ports.html', 'direct-connection.html']) {
    const h = page(f)
    assert.ok(h.includes('<footer class="pro-footer">') && h.includes('polish.js?v=3'), f)
    assert.ok(!/small fee/i.test(h), f)
  }
})

// ---------------------------------------------------------------------------
// Free at this time

test('pricing: household relay is included with CA$3 monthly away access and no usage billing', () => {
  assert.equal(SITE.version, 4)
  assert.equal(SITE.status, 'free')
  assert.equal(SITE.freeAtThisTime, true)
  assert.equal(SITE.includedWithSubscription, true)
  assert.equal(SITE.subscriptionMonthly, 3)
  assert.equal(SITE.subscriptionCurrency, 'CAD')
  assert.equal(SITE.householdMaxMembers, 6)
  assert.equal(SITE.beeboRelay.costPerGB, 0)
  assert.equal(SITE.beeboRelay.topUp.enabled, false)
  assert.deepEqual(SITE.beeboRelay.topUp.amounts, [])
  assert.equal(SITE.ads.status, 'disabled')
  const bundledJson = JSON.parse(fs.readFileSync(path.join(appRoot, 'electron', 'relay-pricing.fallback.json'), 'utf8'))
  assert.deepEqual(bundledJson, SITE)
  const P = pricingMod.parsePricing(SITE)
  assert.equal(P.free, true)
  assert.equal(P.subscriptionCurrency, 'CAD')
  assert.equal(P.beebo.chargedPricePerGB, 0)
  assert.equal(P.beebo.payAsYouGoPricePerGB, 0)
  assert.equal(pricingMod.parsePricing({ ...SITE, status: 'live', freeAtThisTime: false }).free, true, 'included entitlement wins over compatibility flags')
  const T0 = Date.UTC(2026, 8, 15, 12)
  const u = meter.addUsage(undefined, { beebo: 50 * 1e9 }, T0, 1)
  const m = policy.settingsModel({ mode: 'beebo_only', ownKind: null, usage: u, pricing: P, pricingSource: 'site', status: { code: 'beebo' }, now: T0 })
  assert.equal(m.beebo.chargedCost, 0)
  assert.match(m.example, /included.*no extra relay charge/i)
  assert.equal(m.modes.find(x => x.id === 'beebo_only').badge, 'Included in away plan')
  const w = walletModel.walletSettingsModel({ state: { kind: 'off' }, pricing: P, usage: u, mode: 'beebo_only', ownKind: null, now: T0 })
  assert.equal(w.status, 'free')
  assert.match(w.notice, /CA\$3/)
  assert.deepEqual(w.topUps, [])
  policy.setBeeboRelayAllowedHook(() => ({ allowed: false, reason: 'wallet_empty' }))
  try { assert.equal(policy.beeboRelayAllowed({ pricing: P }).allowed, true) }
  finally { policy.setBeeboRelayAllowedHook(null) }
  assert.ok(src('OwnRelay.jsx').includes('No extra relay charge'))
  assert.ok(src('BeeboWallet.jsx').includes("wallet.status === 'free'"))
})

// ---------------------------------------------------------------------------
// What each option would cost

test('cost comparison separates included household relay from customer-owned Cloudflare charges', async () => {
  const K = await loadCosts()
  const pub = policy.publicPricing(pricingMod.parsePricing(SITE))
  const at = (gb) => Object.fromEntries(K.compareAll(pub, gb).map(o => [o.id, o]))
  assert.deepEqual(K.amountRows(pub, 0).map(r => [r.id, r.gb]), [['film', 6], ['films10', 60], ['gb100', 100], ['gb500', 500], ['gb1500', 1500]])
  for (const gb of [6, 60, 100, 500, 1500]) {
    const o = at(gb)
    for (const id of ['direct', 'ports', 'home_only', 'relay', 'cloudflare_then_beebo']) assert.equal(o[id].charged, 0)
    assert.equal(o.relay.headline, 'Included')
    assert.match(o.relay.note, /CA\$3/)
  }
  assert.equal(at(1500).cloudflare.charged, 25)
  assert.equal(at(1500).cloudflare.billedBy, 'Cloudflare')
  assert.match(at(1500).cloudflare_then_beebo.note, /included with your away-from-home household plan/)
  const foot = K.costFootnotes(pub)
  assert.ok(foot.notes.some(t => /CA\$3/.test(t)))
  assert.ok(foot.notes.some(t => /direct connection first/.test(t)))
  assert.equal(foot.cloudflareSource, 'https://developers.cloudflare.com/realtime/sfu/pricing/')
  const none = Object.fromEntries(K.compareAll(null, 100).map(o => [o.id, o]))
  assert.equal(none.cloudflare.charged, null)
  assert.equal(none.relay.estimate, null)
  for (const f of ['ConnectionOptions.jsx', 'ConnectionSettings.jsx', 'OwnRelay.jsx']) assert.ok(src(f).includes('<CostComparison'), f)
})
