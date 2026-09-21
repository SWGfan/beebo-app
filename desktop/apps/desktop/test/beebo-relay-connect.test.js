// Beebo Relay on the home PC: asking for credentials without holding a viewer
// up, falling back to direct, the "Direct connection" / "Through Beebo Relay"
// status line, and following the account when no relay mode was ever picked.
// Run: node --test test/beebo-relay-connect.test.js
// (The agent-side tests need werift: set BEEBO_RTC_NODE_MODULES, as for own-relay.test.js.)
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const Module = require('node:module')

const appRoot = path.resolve(__dirname, '..')
const E = (f) => require(path.join(appRoot, 'electron', f))
const pricingMod = E('relayPricing.js')
const { createRelayController } = E('relayController.js')
const { connectionText } = E('remoteHostAgent.js')

const P = pricingMod.parsePricing(JSON.parse(fs.readFileSync(path.join(appRoot, 'electron', 'relay-pricing.fallback.json'), 'utf8')))
const T0 = Date.UTC(2026, 8, 17, 12, 0, 0)

const NM = [process.env.BEEBO_RTC_NODE_MODULES, path.join(appRoot, 'resources', 'beebo-rtc-host', 'node_modules')]
  .filter(Boolean).find((d) => fs.existsSync(path.join(d, 'werift', 'package.json')))
const skip = NM ? false : 'werift not found (set BEEBO_RTC_NODE_MODULES)'
function loadAgent() {
  process.env.BEEBO_HOST_TOKEN = 'test.token'
  process.env.BEEBO_HOST_URL = 'https://house.beebo.tv'
  process.env.BEEBO_VERBOSE = '0'
  process.env.BEEBO_RELAY_WAIT_MS = '150'
  process.env.NODE_PATH = NM
  Module._initPaths()
  const a = require(path.join(appRoot, 'resources', 'beebo-rtc-host', 'beebo-rtc-host.js'))
  a._resetBeeboForTests()
  return a
}

const NOW_S = () => Math.floor(Date.now() / 1000)
const GOOD = () => ({
  iceServers: [{
    urls: ['turn:relay1.beebo.tv:3478?transport=udp', 'turn:relay1.beebo.tv:3478?transport=tcp', 'turns:relay1.beebo.tv:443?transport=tcp'],
    username: (NOW_S() + 12 * 3600) + ':b0123456789abcdef01234567', credential: 'c2VjcmV0',
  }],
  expiresAt: NOW_S() + 12 * 3600, ttl: 12 * 3600, mode: 'beebo_only', switchAtGB: null,
})
function withFetch(impl, fn) {
  const real = globalThis.fetch
  globalThis.fetch = impl
  return Promise.resolve().then(fn).finally(() => { globalThis.fetch = real })
}
const reply = (status, body) => async () => ({ status, json: async () => body })

test('agent: Beebo Relay credentials are asked for at <name>.beebo.tv with the licence token, and include turns:443', { skip }, async () => {
  const a = loadAgent()
  const seen = []
  await withFetch(async (url, opts) => { seen.push({ url, opts }); return { status: 200, json: async () => GOOD() } }, async () => {
    a.setRelayPlan({ order: ['beebo'] })
    seen.length = 0   // setRelayPlan also looks at this month's usage
    const picked = await a.pickRelay()
    assert.equal(picked.provider, 'beebo')
    assert.deepEqual(picked.servers[0].urls, GOOD().iceServers[0].urls)
    assert.equal(seen.length, 1)
    assert.equal(seen[0].url, 'https://house.beebo.tv/rtc/relay/credentials')
    assert.equal(seen[0].opts.method, 'POST')
    assert.equal(seen[0].opts.headers.authorization, 'Bearer test.token')
    assert.ok(seen[0].opts.signal, 'the call has a deadline')
    // A second connection soon after reuses them: no second call.
    await a.pickRelay()
    assert.equal(seen.length, 1)
  })
})

test('agent: a Worker that never answers costs a viewer at most the short wait, then direct', { skip }, async () => {
  const a = loadAgent()
  assert.equal(a.BEEBO_RELAY_WAIT_MS, 150)
  let calls = 0
  const hang = (url, opts) => new Promise((resolve, reject) => {
    if (String(url).endsWith('/rtc/relay/credentials')) calls++
    else return resolve({ status: 404, json: async () => ({}) })
    opts.signal.addEventListener('abort', () => reject(opts.signal.reason))
  })
  await withFetch(hang, async () => {
    a.setRelayPlan({ order: ['beebo'] })
    const t = Date.now()
    const picked = await a.pickRelay()
    const took = Date.now() - t
    assert.equal(picked, null, 'no relay: the connection goes ahead direct')
    assert.ok(took < 1500, 'gave up in ' + took + ' ms')
    assert.equal(calls, 1)
    // Asked again only after a pause, not on every viewer.
    assert.equal(await a.pickRelay(), null)
    assert.equal(calls, 1)
  })
})

test('agent: switched off (404), refused or unreachable -> direct only, and not asked again straight away', { skip }, async () => {
  for (const [label, impl] of [
    ['404', reply(404, { error: 'not_found' })],
    ['403', reply(403, { error: 'relay_not_enabled' })],
    ['402', reply(402, { error: 'no_active_subscription' })],
    ['429', reply(429, { error: 'relay_cap_reached' })],
    ['network', async () => { throw new TypeError('fetch failed') }],
    ['junk', reply(200, { iceServers: [{ urls: ['javascript:alert(1)'], username: 'x', credential: 'y' }] })],
  ]) {
    const a = loadAgent()
    let calls = 0
    await withFetch(async (url, opts) => { if (String(url).endsWith('/credentials')) calls++; return impl(url, opts) }, async () => {
      a.setRelayPlan({ order: ['beebo'] })
      assert.equal(await a.pickRelay(), null, label)
      assert.equal(await a.pickRelay(), null, label)
      assert.equal(calls, 1, label + ': paused after the first refusal')
    })
  }
})

test('agent: Beebo Relay first, the owner\'s own relay kept as the fallback', { skip }, async () => {
  const a = loadAgent()
  await withFetch(reply(403, { error: 'relay_not_enabled' }), async () => {
    a.setRelayPlan({ order: ['beebo', 'custom'] })
    // No own relay configured: nothing to fall back on -> direct.
    assert.equal(await a.pickRelay(), null)
  })
})

test('agent: the nominated pair says direct or relayed, and whose relay', { skip }, () => {
  const a = loadAgent()
  const pair = (l, r, host = '203.0.113.9') => ({ localCandidate: { type: l }, remoteCandidate: { type: r, host } })
  assert.deepEqual(a.connectionPath(pair('host', 'srflx'), 'beebo', []), { path: 'direct', provider: '' })
  assert.deepEqual(a.connectionPath(pair('relay', 'srflx'), 'beebo', []), { path: 'relay', provider: 'beebo' })
  assert.deepEqual(a.connectionPath(pair('relay', 'relay'), 'cloudflare', []), { path: 'relay', provider: 'cloudflare' })
  assert.deepEqual(a.connectionPath(pair('srflx', 'relay', '203.0.113.8'), '', ['203.0.113.8']), { path: 'relay', provider: 'beebo' })
  assert.deepEqual(a.connectionPath(pair('srflx', 'relay', '198.51.100.1'), '', ['203.0.113.8']), { path: 'relay', provider: '' })
  assert.equal(a.connectionPath(null, 'beebo', []), null)
  assert.deepEqual(a.relayHostsOf(GOOD().iceServers), ['relay1.beebo.tv'])
})

test('status line: plain English for the viewers connected now', () => {
  assert.equal(connectionText([]), '')
  assert.equal(connectionText([{ path: 'direct' }]), 'Direct connection')
  assert.equal(connectionText([{ path: 'relay', provider: 'beebo' }]), 'Through Beebo Relay')
  assert.equal(connectionText([{ path: 'relay', provider: '' }]), 'Through a relay')
  assert.equal(connectionText([{ path: 'direct' }, { path: 'relay', provider: 'beebo' }, { path: 'direct' }]), '3 viewers: 2 direct, 1 through Beebo Relay')
})

function fakeStore(initial = {}) {
  const data = JSON.parse(JSON.stringify(initial))
  return { data, get: (k, d) => (k in data ? JSON.parse(JSON.stringify(data[k])) : d), set: (k, v) => { data[k] = JSON.parse(JSON.stringify(v)) }, delete: (k) => { delete data[k] } }
}
function controller(store, ownRelay = null) {
  const plans = []
  const c = createRelayController({
    store, now: () => T0,
    pricing: { current: () => ({ pricing: P, source: 'bundled' }), refresh: async () => ({}) },
    getOwnRelay: () => ownRelay,
    getRemoteHost: () => ({ setRelayPlan: (p) => plans.push(p.order.join(',')) }),
  })
  return { c, plans }
}

test('controller: no relay mode ever picked -> the agent asks Beebo Relay; Settings says Beebo Relay once the account has it', () => {
  const store = fakeStore({})
  const { c, plans } = controller(store)
  c.evaluate()
  assert.equal(plans.at(-1), 'beebo', 'asks, and the Worker decides')
  assert.equal(c.getModel().mode, 'off', 'nothing to show until Beebo says yes')
  c.onAgentMessage({ type: 'relayStatus', beebo: { available: true, error: '', expiresAt: 0 } })
  assert.equal(plans.at(-1), 'beebo')
  assert.equal(c.getModel().mode, 'beebo_only')
  assert.match(c.getModel().notice, /Beebo Relay/)
  // The account is turned off again: back to showing Off, still asking now and then.
  c.onAgentMessage({ type: 'relayStatus', beebo: { available: false, error: 'relay_not_enabled', expiresAt: 0 } })
  assert.equal(c.getModel().mode, 'off')
  assert.equal(plans.at(-1), 'beebo')
})

test('controller: an explicit Off is respected, and an own relay keeps its old meaning', () => {
  const off = controller(fakeStore({ relayMode: 'off' }))
  off.c.evaluate()
  assert.equal(off.plans.at(-1), '', 'direct only')
  off.c.onAgentMessage({ type: 'relayStatus', beebo: { available: true, error: '' } })
  assert.equal(off.c.getModel().mode, 'off')
  assert.equal(off.plans.at(-1), '')

  const own = controller(fakeStore({}), { kind: 'turn' })
  own.c.evaluate()
  assert.equal(own.plans.at(-1), 'custom')
})

// A session that is waiting on the house but has moved nothing for 20 seconds is
// dead: the viewer's network changed, or the relay's connection died underneath.
// Closing it makes the phone reconnect at once instead of sitting on a spinner.
// (The owner's own phone sat there for a minute moving from mobile data to a
// friend's Wi-Fi, 2026-09-18.)
test('the host closes a session that has stopped moving while the viewer waits', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'resources', 'beebo-rtc-host', 'beebo-rtc-host.js'), 'utf8')
  assert.match(src, /function sweepStalledSessions/, 'there is a sweep for stalled sessions')
  assert.match(src, /setInterval\(sweepStalledSessions/, 'and it runs on a timer')
  // Only sessions the viewer is actually waiting on, so an idle open tab is left alone.
  const fn = src.slice(src.indexOf('function sweepStalledSessions'), src.indexOf('function closeSession'))
  assert.match(fn, /inflight\.size === 0\) continue/, 'an idle session is left alone')
  assert.match(fn, /lastMoveAt/, 'it measures when bytes last moved')
  assert.match(fn, /closeSession\(viewerId\)/, 'and closes the stalled one')
  // Bytes going out and messages coming in both count as movement.
  assert.match(src, /sentBytes \+= buf\.length - headLen;\s*session\.lastMoveAt = Date\.now\(\)/)
  assert.match(src, /function onHttpMessage\(session, channel, data\) \{\s*\r?\n\s*session\.lastMoveAt = Date\.now\(\)/)
})
