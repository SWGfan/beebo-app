// Connection wizard + Settings > Connection: result classification, which words
// are shown, the PC-side test recorder, and Beebo Relay opt-in / opt-out calls.
// Run: node --test test/connection-wizard.test.js   (no Electron, no network)
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')

const appRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(appRoot, '..', '..', '..')
const { createConnectionTest, isPrivateLan, deviceWord, relayErrorCode } = require(path.join(appRoot, 'electron', 'connectionTest.js'))
const loadModel = () => import(pathToFileURL(path.join(appRoot, 'src', 'lib', 'connectionModel.js')).href)

function memStore(init = {}) {
  const m = new Map(Object.entries(init))
  return { get: (k) => m.get(k), set: (k, v) => m.set(k, v), delete: (k) => m.delete(k), _m: m }
}

// ---------------------------------------------------------------------------
// Pure model (src/lib/connectionModel.js)

test('away result: latest successful route is reported; only events since the test started count', async () => {
  const M = await loadModel()
  assert.deepEqual(M.awayResult([], 100), { state: 'waiting' })
  assert.equal(M.awayResult([{ at: 50, state: 'open', path: 'direct' }], 100).state, 'waiting')
  assert.equal(M.awayResult([{ at: 150, state: 'failed' }], 100).state, 'failed')
  const relay = M.awayResult([{ at: 150, state: 'failed' }, { at: 160, state: 'open', path: 'relay', provider: 'beebo' }], 100)
  assert.deepEqual(relay, { state: 'relay', at: 160, provider: 'beebo' })
  assert.equal(M.awayResult([{ at: 170, state: 'open', path: 'relay', provider: 'beebo' }, { at: 160, state: 'open', path: 'direct' }], 100).state, 'relay')
})

test('automatic check: honest hints from the router state', async () => {
  const M = await loadModel()
  assert.equal(M.autoCheck(null).state, 'no_address')
  assert.equal(M.autoCheck({ hostname: 'x.beebo.tv', problem: 'name_taken' }).state, 'address_problem')
  assert.equal(M.autoCheck({ hostname: 'x.beebo.tv', online: false }).state, 'starting')
  assert.equal(M.autoCheck({ hostname: 'x.beebo.tv', online: true, udp: { enabled: true, kind: 'cgnat' } }).state, 'direct_unlikely')
  assert.equal(M.autoCheck({ hostname: 'x.beebo.tv', online: true, udp: { enabled: true, kind: 'double-nat' } }).state, 'direct_unlikely')
  assert.equal(M.autoCheck({ hostname: 'x.beebo.tv', online: true, udp: { enabled: true, mapped: true } }).state, 'direct_likely')
  assert.equal(M.autoCheck({ hostname: 'x.beebo.tv', online: true, udp: { enabled: true, tried: false } }).state, 'checking')
  assert.equal(M.autoCheck({ hostname: 'x.beebo.tv', online: true, udp: { enabled: true, tried: true } }).state, 'unknown')
  assert.equal(M.autoCheck({ hostname: 'x.beebo.tv', online: true, udp: { enabled: false } }).state, 'unknown')
})

test('overall outcome: a real phone result always wins over the automatic hint', async () => {
  const M = await loadModel()
  const o = (away, auto) => M.overallOutcome({ away: { state: away }, auto: { state: auto } })
  assert.equal(o('direct', 'direct_unlikely'), 'direct_ok')
  assert.equal(o('relay', 'direct_likely'), 'relay_ok')
  assert.equal(o('failed', 'direct_likely'), 'blocked')
  assert.equal(o('waiting', 'direct_unlikely'), 'blocked')
  assert.equal(o('waiting', 'direct_likely'), 'direct_likely')
  assert.equal(o('waiting', 'unknown'), 'unknown')
  assert.equal(M.overallOutcome({}), 'unknown')
  for (const x of ['direct_ok', 'relay_ok', 'blocked']) assert.equal(M.isFinalOutcome(x), true)
  for (const x of ['direct_likely', 'unknown']) assert.equal(M.isFinalOutcome(x), false)
})

test('result words: direct is accurate about what passes through Beebo; options only when needed', async () => {
  const M = await loadModel()
  const d = M.RESULT_TEXT.direct_ok
  assert.equal(d.title, 'You’re all set')
  assert.ok(d.body.join(' ').includes('straight from your computer to your phone or browser'))
  assert.ok(d.body.join(' ').includes('never passes through Beebo’s servers'))
  assert.ok(/find your computer and sign you in/.test(d.body.join(' ')), 'says the introduction goes through Beebo')
  assert.equal(d.showOptions, false)
  const b = M.RESULT_TEXT.blocked
  assert.equal(b.showOptions, true)
  assert.ok(b.body.join(' ').includes('change your modem or router settings, or use Beebo Relay'))
  for (const k of Object.keys(M.RESULT_TEXT)) assert.ok(M.RESULT_TEXT[k].title && M.RESULT_TEXT[k].body.length)
})

test('options: relay is recommended, free at this time, 0% markup with notice before any fee; ports warn; home only is changeable', async () => {
  const M = await loadModel()
  const r = M.OPTION_TEXT.relay
  assert.match(r.badge, /Recommended/)
  assert.equal(r.freeBadge, 'Included in away plan')
  assert.ok(r.lines.includes('Included in your away-from-home household plan. No extra relay charge.'))
  assert.ok(r.lines.some((t) => /CA\$3/.test(t) && /6 people/.test(t)))
  assert.ok(!r.lines.some((t) => /small fee/.test(t)), 'no "small fee" wording')
  assert.ok(r.lines.some((t) => /direct connection first/.test(t)))
  // Cloudflare only: the 4th way, own account, not Beebo's servers.
  const cf = M.OPTION_TEXT.cloudflare
  assert.equal(cf.title, 'Cloudflare only')
  assert.equal(cf.badge, 'Advanced · your own Cloudflare account')
  assert.ok(cf.lines.some((t) => /your own Cloudflare account/.test(t) && /not through Beebo’s servers/.test(t) && /encrypted from end to end/.test(t)))
  assert.deepEqual(M.CHOICES, ['relay', 'cloudflare', 'ports', 'home_only'])
  assert.equal(M.normalizeSetup({ choice: 'cloudflare' }).choice, 'cloudflare')
  // The relay explanation no longer promises a "small fee".
  assert.match(M.RELAY_EXPLAINER.note, /CA\$3/)
  assert.match(M.OPTION_TEXT.ports.badge, /Advanced/)
  assert.match(M.OPTION_TEXT.home_only.lines[0], /Settings › Connection/)
  const g = M.portGuide({ ports: '47820–47829', localIp: '192.168.1.20' })
  assert.ok(g.steps.some((t) => t.includes('UDP, ports 47820–47829') && t.includes('192.168.1.20')))
  assert.ok(g.warning.some((t) => /reachable from the internet/.test(t)))
  assert.ok(g.warning.some((t) => /internet providers block/.test(t)))
  assert.ok(M.portGuide(null).steps.length === 4)
})

test('current status for Settings > Connection', async () => {
  const M = await loadModel()
  const st = (setup, relayEnabled) => M.currentStatus({ setup, relayEnabled })
  assert.equal(st({}), 'not_tested')
  assert.equal(st({ choice: 'home_only', lastResult: { outcome: 'direct_ok', at: 1 } }), 'home_only')
  assert.equal(st({ lastResult: { outcome: 'direct_ok', at: 1 } }, true), 'direct')
  assert.equal(st({ choice: 'relay' }), 'relay')
  assert.equal(st({}, true), 'relay')
  assert.equal(st({ lastResult: { outcome: 'relay_ok', at: 1 } }), 'relay')
  assert.equal(st({ choice: 'ports', lastResult: { outcome: 'blocked', at: 1 } }), 'ports')
  assert.equal(st({ lastResult: { outcome: 'blocked', at: 1 } }), 'blocked')
  for (const k of ['direct', 'relay', 'cloudflare', 'home_only', 'ports', 'blocked', 'not_tested']) assert.ok(M.STATUS_TEXT[k].label)
  // Cloudflare only: from the choice, from the PC's relay mode, or from a relayed result through Cloudflare.
  assert.equal(st({ choice: 'cloudflare' }), 'cloudflare')
  assert.equal(M.currentStatus({ setup: {}, relayMode: 'own' }), 'cloudflare')
  assert.equal(st({ lastResult: { outcome: 'relay_ok', at: 1, provider: 'cloudflare' } }), 'cloudflare')
  assert.equal(st({ lastResult: { outcome: 'relay_ok', at: 1, provider: 'beebo' } }), 'relay')
  assert.equal(M.currentStatus({ setup: { lastResult: { outcome: 'direct_ok', at: 1 } }, relayMode: 'own' }), 'direct')
  assert.equal(M.STATUS_TEXT.cloudflare.label, 'Through your Cloudflare relay')
  assert.match(M.STATUS_TEXT.cloudflare.detail, /not Beebo’s servers/)
  assert.equal(M.awayText({ state: 'relay', provider: 'cloudflare' }).text, 'Your phone connected. Through your Cloudflare relay.')
  assert.equal(M.resultText('relay_ok', 'cloudflare').title, 'It works through your own relay')
  assert.equal(M.resultText('relay_ok', 'beebo').title, 'It works through Beebo Relay')
  assert.equal(M.resultText('nonsense').title, M.RESULT_TEXT.unknown.title)
  assert.equal(M.STATUS_TEXT.direct.label, 'Direct connection')
  assert.equal(M.STATUS_TEXT.relay.label, 'Beebo Relay enabled')
  assert.equal(M.STATUS_TEXT.home_only.label, 'Home only')
})

test('setup state: normalised, and the wizard is pending until finished or skipped', async () => {
  const M = await loadModel()
  assert.deepEqual(M.normalizeSetup(null), { state: 'new', step: 'home', choice: null, homeOk: false, lastResult: null, relayAcceptedAt: 0, relayTermsVersion: '' })
  assert.equal(M.normalizeSetup({ state: 'bogus', step: 'nope', choice: 'x' }).state, 'new')
  assert.equal(M.wizardPending(undefined), true)
  assert.equal(M.wizardPending({ state: 'in_progress' }), true)
  assert.equal(M.wizardPending({ state: 'skipped' }), false)
  assert.equal(M.wizardPending({ state: 'done' }), false)
})

test('live texts for each test state', async () => {
  const M = await loadModel()
  assert.equal(M.homeResult(null).state, 'idle')
  assert.equal(M.homeResult({ since: 10, seenAt: 0 }).state, 'waiting')
  assert.deepEqual(M.homeResult({ since: 10, seenAt: 12, device: 'phone' }), { state: 'connected', device: 'phone' })
  assert.equal(M.homeText({ state: 'connected', device: 'phone' }).text, 'Your phone connected. Watching at home works.')
  assert.equal(M.awayText({ state: 'direct' }).text, 'Your phone connected. Direct connection.')
  assert.equal(M.awayText({ state: 'relay', provider: 'beebo' }).text, 'Your phone connected. Through Beebo Relay.')
  assert.equal(M.awayText({ state: 'failed' }).tone, 'bad')
  for (const s of ['no_address', 'address_problem', 'starting', 'checking', 'direct_likely', 'direct_unlikely', 'unknown']) {
    assert.ok(M.autoText({ state: s }).text.length > 10, s)
  }
  assert.match(M.autoText({ state: 'direct_unlikely', kind: 'cgnat' }).text, /shares one internet address/)
})

test('relay usage line and error words', async () => {
  const M = await loadModel()
  assert.deepEqual(M.relayUsageText({ enabled: true, free: true, gb: 2.345, capGB: 200 }), { text: '2.35 GB used this month of your 200 GB monthly limit. No extra relay charge.', free: 'Included in away plan' })
  assert.equal(M.relayUsageText({ enabled: true, free: false, gb: 2.345, capGB: 200 }).text, '2.35 GB used this month of your 200 GB monthly limit.')
  assert.equal(M.relayUsageText({ enabled: false, free: true, gb: 0 }).text, 'Beebo Relay is off.')
  assert.equal(M.relayUsageText({ unavailable: true }).text, 'Beebo Relay isn’t available yet.')
  assert.equal(M.relayUsageText({ enabled: true, free: false, gb: 150 }).free, '')
  assert.equal(M.relayUsageText({ enabled: true, suspended: true }).text, 'Beebo Relay is paused on your account. Please contact Beebo support.')
  for (const c of ['not_available', 'no_active_subscription', 'relay_suspended', 'terms_changed', 'unauthorized', 'signed_out', 'unreachable', 'whatever']) {
    assert.ok(M.relayErrorText(c).endsWith('.'), c)
  }
})

test('the relay explanation matches the relay setup and the Worker', async () => {
  const M = await loadModel()
  const T = M.RELAY_EXPLAINER
  const all = [...T.points, ...T.keep, T.where, T.note].join(' ')
  assert.ok(all.includes('encrypted from end to end (WebRTC DTLS)'))
  assert.ok(all.includes('We don’t harvest or sell your data.'))
  assert.ok(all.includes('up to 7 days'))
  assert.ok(all.includes('Beauharnois (BHS), Canada'))
  assert.equal(T.ovhUrl, 'https://www.ovhcloud.com/')
  assert.deepEqual(T.path, ['Your computer', 'Your modem', 'Beebo Relay', 'Your phone or browser'])
  assert.match(T.note, /^Beebo is made by a family man, not a data company\./)
  if (require('./helpers/privateParts').skipIfMissing('relay', 'worker/relay.js', 'worker/regions.js')) return // private files absent
  // Facts checked against the repo, so the words can't drift from the truth.
  const bootstrap = fs.readFileSync(path.join(repoRoot, 'relay', 'setup', 'bootstrap.sh'), 'utf8')
  assert.ok(bootstrap.includes('Log retention (7 days)'))
  const hookup = fs.readFileSync(path.join(repoRoot, 'relay', 'HOOKUP.md'), 'utf8')
  assert.ok(hookup.includes('Beauharnois'))
  const relayJs = fs.readFileSync(path.join(repoRoot, 'worker', 'relay.js'), 'utf8')
  const m = /RELAY_TERMS = Object\.freeze\(\{ version: '([^']+)', free: (true|false) \}\)/.exec(relayJs)
  assert.ok(m, 'RELAY_TERMS found in worker/relay.js')
  assert.equal(M.RELAY_TERMS_VERSION, m[1], 'the app shows the terms version the Worker expects')
  assert.equal(m[2], 'true', 'the app says "Free at this time", so the Worker terms must be free')
  const regions = fs.readFileSync(path.join(repoRoot, 'worker', 'regions.js'), 'utf8')
  const schema = /REGION_SCHEMA =\s*'([^']+)'/.exec(regions)[1]
  assert.ok(!/\bip\b|email|customer/i.test(schema), 'country counts hold no address or account')
})

// ---------------------------------------------------------------------------
// PC side (electron/connectionTest.js)

test('home test: only another device on the local network counts, and no address is kept', () => {
  let t = 1000
  const store = memStore()
  const ct = createConnectionTest({ store, getToken: () => '', backendUrl: '', getOwnAddresses: () => ['192.168.1.20'], now: () => t })
  assert.equal(ct.onLanRequest({ ip: '192.168.1.50', ua: 'x' }), false, 'no test running')
  ct.start('home')
  t = 2000
  assert.equal(ct.onLanRequest({ ip: '127.0.0.1', ua: 'x' }), false)
  assert.equal(ct.onLanRequest({ ip: '192.168.1.20', ua: 'x' }), false, 'this computer itself')
  assert.equal(ct.onLanRequest({ ip: '8.8.8.8', ua: 'x' }), false)
  assert.equal(ct.onLanRequest({ ip: '192.168.1.50', ua: 'x', remote: true }), false)
  assert.equal(ct.onLanRequest({ ip: '::ffff:192.168.1.50', ua: 'Mozilla/5.0 (Linux; Android 14; Pixel) Mobile' }), true)
  const snap = ct.snapshot()
  assert.deepEqual(snap.home, { since: 1000, seenAt: 2000, device: 'phone' })
  assert.equal(snap.setup.homeOk, true)
  assert.equal(snap.setup.state, 'in_progress')
  assert.ok(!JSON.stringify([snap, [...store._m.entries()]]).includes('192.168.1.50'))
})

test('away test: connection events are kept without viewer ids, newest first, capped', () => {
  let t = 5000
  const ct = createConnectionTest({ store: memStore(), getToken: () => '', backendUrl: '', now: () => t++ })
  ct.start('away')
  ct.onConnection({ state: 'closed' })
  ct.onConnection({ state: 'failed', viewerId: 'v1' })
  ct.onConnection({ state: 'open', path: 'relay', provider: 'beebo', viewerId: 'v2' })
  const s = ct.snapshot()
  assert.equal(s.away.events.length, 2)
  assert.deepEqual(Object.keys(s.away.events[0]).sort(), ['at', 'path', 'provider', 'state'])
  assert.equal(s.away.events[0].provider, 'beebo')
  for (let i = 0; i < 30; i++) ct.onConnection({ state: 'open', path: 'direct' })
  assert.equal(ct.snapshot().away.events.length, 20)
})

test('saved setup only takes known fields', () => {
  const store = memStore()
  const ct = createConnectionTest({ store, getToken: () => '', backendUrl: '' })
  ct.saveSetup({ state: 'done', step: 'result', lastResult: { outcome: 'direct_ok', at: 7, provider: 'Beebo!' }, choice: 'relay', evil: 1 })
  assert.deepEqual(store.get('connectionSetup'), { state: 'done', step: 'result', lastResult: { outcome: 'direct_ok', at: 7, provider: 'eebo' } })
  ct.saveSetup({ lastResult: { outcome: 'made_up' }, state: 'weird' })
  assert.equal(store.get('connectionSetup').lastResult.outcome, 'direct_ok')
})

function fakeFetch(routes) {
  const calls = []
  const f = async (url, init) => {
    calls.push({ url, init })
    const u = new URL(url)
    const r = routes[u.pathname]
    if (!r) return { status: 404, json: async () => ({ error: 'not_found' }) }
    if (r === 'throw') throw new Error('offline')
    return { status: r.status, json: async () => r.body }
  }
  f.calls = calls
  return f
}

test('Beebo Relay opt-in: calls the Worker with the licence token and terms, then switches the local mode on', async () => {
  const store = memStore()
  const modes = []
  const f = fakeFetch({ '/relay/opt-in': { status: 200, body: { ok: true, enabled: true, free: true, optIn: { termsVersion: '2026-09-17', acceptedAt: 1758100000 }, usage: { month: '2026-09', usedGB: 0, capGB: 200 } } } })
  const ct = createConnectionTest({ store, getToken: () => 'LIC', backendUrl: () => 'https://svc.example/', fetch: f, getRelayController: () => ({ setMode: (m) => { modes.push(m); store.set('relayMode', m) } }) })
  const r = await ct.relayOptIn('2026-09-17')
  assert.equal(r.ok, true)
  assert.deepEqual(r.relay, { enabled: true, suspended: false, free: true, month: '2026-09', gb: 0, capGB: 200, optIn: { termsVersion: '2026-09-17', acceptedAt: 1758100000 } })
  assert.equal(f.calls[0].url, 'https://svc.example/relay/opt-in')
  assert.equal(f.calls[0].init.method, 'POST')
  assert.equal(f.calls[0].init.headers.authorization, 'Bearer LIC')
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { termsVersion: '2026-09-17' })
  assert.deepEqual(modes, ['beebo_only'])
  const s = store.get('connectionSetup')
  assert.equal(s.choice, 'relay')
  assert.equal(s.relayAcceptedAt, 1758100000)
  assert.equal(s.relayTermsVersion, '2026-09-17')

  // "My Cloudflare first, then Beebo Relay" already includes Beebo Relay: left alone.
  const store2 = memStore({ relayMode: 'cloudflare_then_beebo' })
  const modes2 = []
  const ct2 = createConnectionTest({ store: store2, getToken: () => 'LIC', backendUrl: 'https://svc.example', fetch: f, getRelayController: () => ({ setMode: (m) => modes2.push(m) }) })
  assert.equal((await ct2.relayOptIn('2026-09-17')).ok, true)
  assert.deepEqual(modes2, [])
})

test('Beebo Relay opt-in failures become short codes, and nothing changes locally', async () => {
  const cases = [
    [{ '/relay/opt-in': { status: 404, body: {} } }, 'not_available'],
    [{ '/relay/opt-in': { status: 402, body: {} } }, 'no_active_subscription'],
    [{ '/relay/opt-in': { status: 403, body: { error: 'relay_suspended' } } }, 'relay_suspended'],
    [{ '/relay/opt-in': { status: 409, body: { error: 'terms_changed' } } }, 'terms_changed'],
    [{ '/relay/opt-in': 'throw' }, 'unreachable'],
  ]
  for (const [routes, code] of cases) {
    const store = memStore()
    const ct = createConnectionTest({ store, getToken: () => 'LIC', backendUrl: 'https://svc.example', fetch: fakeFetch(routes) })
    const r = await ct.relayOptIn('2026-09-17')
    assert.deepEqual(r, { ok: false, error: code })
    assert.equal(store.get('relayMode'), undefined)
    assert.equal(store.get('connectionSetup'), undefined)
  }
  const signedOut = createConnectionTest({ store: memStore(), getToken: () => '', backendUrl: 'https://svc.example', fetch: fakeFetch({}) })
  assert.deepEqual(await signedOut.relayOptIn('x'), { ok: false, error: 'signed_out' })
  assert.equal(relayErrorCode(500, null), 'http_500')
})

test('choosing ports or home only turns Beebo Relay off only when it was turned on here', async () => {
  const f = fakeFetch({ '/relay/opt-out': { status: 200, body: { ok: true, enabled: false } } })
  const store = memStore({ relayMode: 'beebo_only', connectionSetup: { choice: 'relay' } })
  const ct = createConnectionTest({ store, getToken: () => 'LIC', backendUrl: 'https://svc.example', fetch: f })
  assert.deepEqual(await ct.choose('home_only'), { ok: true })
  assert.equal(f.calls.length, 1)
  assert.equal(new URL(f.calls[0].url).pathname, '/relay/opt-out')
  assert.equal(store.get('relayMode'), 'off')
  assert.equal(store.get('connectionSetup').choice, 'home_only')

  // Now not 'relay' any more: switching to ports calls nothing.
  assert.deepEqual(await ct.choose('ports'), { ok: true })
  assert.equal(f.calls.length, 1)
  assert.equal(store.get('connectionSetup').choice, 'ports')

  // A relay the owner set up some other way (e.g. their own Cloudflare) is left alone.
  const store2 = memStore({ relayMode: 'own' })
  const ct2 = createConnectionTest({ store: store2, getToken: () => 'LIC', backendUrl: 'https://svc.example', fetch: f })
  assert.deepEqual(await ct2.choose('home_only'), { ok: true })
  assert.equal(store2.get('relayMode'), 'own')
  assert.deepEqual(await ct2.choose('nonsense'), { ok: false, error: 'bad_choice' })
})

test('relay info: usage/me mapped; switched off answers unavailable', async () => {
  const on = createConnectionTest({ store: memStore(), getToken: () => 'LIC', backendUrl: 'https://svc.example', fetch: fakeFetch({ '/relay/usage/me': { status: 200, body: { month: '2026-09', enabled: true, free: true, gb: 1.5, capGB: 200, optIn: null } } }) })
  assert.deepEqual(await on.relayInfo(), { enabled: true, suspended: false, free: true, month: '2026-09', gb: 1.5, capGB: 200, optIn: null })
  const off = createConnectionTest({ store: memStore(), getToken: () => 'LIC', backendUrl: 'https://svc.example', fetch: fakeFetch({}) })
  assert.deepEqual(await off.relayInfo(), { unavailable: true })
})

test('helpers: private LAN ranges and device words', () => {
  for (const ip of ['10.0.0.5', '172.16.1.1', '172.31.255.1', '192.168.0.9', '169.254.3.3', '100.64.0.1', 'fd12:3456::1', 'fe80::1', '::ffff:10.1.1.1']) assert.equal(isPrivateLan(ip), true, ip)
  for (const ip of ['8.8.8.8', '172.32.0.1', '127.0.0.1', '::1', '2001:db8::1', '', null]) assert.equal(isPrivateLan(ip), false, String(ip))
  assert.equal(deviceWord('okhttp/4.12.0'), 'phone')
  assert.equal(deviceWord('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'), 'iPhone')
  assert.equal(deviceWord('Mozilla/5.0 (Linux; Android 13; SM-X200)'), 'tablet')
  assert.equal(deviceWord('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'computer')
  assert.equal(deviceWord(''), '')
})

test('the host agent reports a viewer that never got through, and the app passes it on without the id', () => {
  const host = fs.readFileSync(path.join(appRoot, 'resources', 'beebo-rtc-host', 'beebo-rtc-host.js'), 'utf8')
  assert.ok(/state === 'failed' && !session\.everConnected[\s\S]{0,80}report\(\{ type: 'connection', viewerId, state: 'failed' \}\)/.test(host))
  const agent = fs.readFileSync(path.join(appRoot, 'electron', 'remoteHostAgent.js'), 'utf8')
  assert.ok(/onConnection\(\{ state: m\.state, path:/.test(agent))
  const server = fs.readFileSync(path.join(appRoot, 'electron', 'streamServer.js'), 'utf8')
  assert.ok(server.includes("if (typeof onLanRequest === 'function')"))
})
