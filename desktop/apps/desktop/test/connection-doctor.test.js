'use strict'
// Connection Doctor: what each fact means (src/lib/connectionDoctor.js) and how the main process
// gathers facts and applies fixes (electron/connectionDoctorIpc.js), all with fakes.
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const appRoot = path.resolve(__dirname, '..')
const doc = require(path.join(appRoot, 'electron', 'connectionDoctorIpc.js'))
const load = () => import(pathToFileURL(path.join(appRoot, 'src', 'lib', 'connectionDoctor.js')).href)

const ALLOW = { enabled: true, direction: 'In', action: 'Allow', protocol: 'TCP', localPort: '47811', profiles: 'Domain,Private,Public' }
const BLOCK = { enabled: true, direction: 'In', action: 'Block', protocol: 'Any', localPort: 'Any', profiles: 'Public' }

// A healthy, away-enabled computer; each test breaks one thing.
const healthy = () => ({
  platform: 'win32',
  server: { port: 47811, listening: true },
  firewall: { applicable: true, present: true, rules: [{ ...ALLOW }] },
  network: { addresses: ['192.168.1.20'] },
  router: { server: { active: true, reachable: true, method: 'upnp', externalIp: '203.0.113.9', kind: '' }, rtc: null },
  remote: { hostname: 'smiths.beebo.tv', online: true, problem: '', udp: { enabled: true, mapped: true, tried: true, kind: '' } },
  cloud: { signedIn: true, reachable: true, ms: 84 },
  address: { state: 'ok', hostname: 'smiths.home.beebo.tv', ipv4: '203.0.113.9', dnsIpv4: ['203.0.113.9'] },
  sleep: { known: true, acMinutes: 0 },
})
const by = (checks, id) => checks.find((c) => c.id === id)

test('a healthy computer: every check appears, in the fixed order, all passing', async () => {
  const m = await load()
  const checks = m.evaluate(healthy())
  assert.deepEqual(checks.map((c) => c.id), m.CHECK_ORDER)
  assert.deepEqual(m.CHECK_ORDER, ['server', 'firewall', 'lan', 'internet', 'router', 'nat', 'address', 'sleep'])
  assert.ok(checks.every((c) => c.status === 'pass'), checks.map((c) => c.id + ':' + c.status).join(' '))
  const s = m.summarize(checks)
  assert.equal(s.worst, 'pass')
  assert.match(s.headline, /looks good/)
  assert.deepEqual(s.fixable, [])
})

test('the server not answering is the first problem and offers a restart', async () => {
  const m = await load()
  const f = healthy(); f.server.listening = false
  const c = m.evaluate(f)
  assert.equal(by(c, 'server').status, 'fail')
  assert.equal(by(c, 'server').fix.id, 'restart')
  assert.equal(m.summarize(c).first.id, 'server')
  assert.match(m.summarize(c).headline, /Found a problem: Beebo is not answering/)
  f.server.listening = null
  assert.equal(by(m.evaluate(f), 'server').status, 'warn')
})

test('firewall: missing rule, a Block rule that overrides Allow, disabled rule, wrong port, public-only profile, unreadable, not applicable', async () => {
  const m = await load()
  const fw = (over) => { const f = healthy(); f.firewall = { applicable: true, present: true, rules: [], ...over }; return by(m.evaluate(f), 'firewall') }
  const missing = fw({ present: false })
  assert.equal(missing.status, 'fail')
  assert.equal(missing.fix.id, 'firewall')
  assert.equal(missing.fix.needsAdmin, true)
  assert.match(missing.fix.explain, /administrator/)

  const dup = fw({ rules: [ALLOW, BLOCK] })
  assert.equal(dup.status, 'fail', 'a Block rule wins over the Allow rule')
  assert.match(dup.title, /Block rule/)
  assert.equal(dup.fix.id, 'firewall')

  assert.equal(fw({ rules: [{ ...ALLOW, enabled: false }] }).status, 'fail')
  assert.equal(fw({ rules: [{ ...ALLOW, localPort: '8080' }] }).status, 'fail')
  assert.match(fw({ rules: [{ ...ALLOW, localPort: '8080' }] }).title, /different port/)
  assert.equal(fw({ rules: [{ ...ALLOW, localPort: '47000-48000' }] }).status, 'pass')
  assert.equal(fw({ rules: [{ ...ALLOW, localPort: 'Any' }] }).status, 'pass')
  assert.equal(fw({ rules: [{ ...ALLOW, profiles: 'Public' }] }).status, 'warn')
  assert.equal(fw({ rules: [{ ...ALLOW, enabled: true }, { ...BLOCK, enabled: false }] }).status, 'pass', 'a disabled Block rule does not count')
  assert.equal(fw({ rules: [{ ...BLOCK, direction: 'Out' }, ALLOW] }).status, 'pass', 'an outbound Block rule is unrelated')
  assert.equal(fw({ present: null }).status, 'warn')
  assert.equal(fw({ applicable: false }).status, 'pass')
})

test('portCovered understands single ports, ranges, lists and Any', async () => {
  const m = await load()
  assert.equal(m.portCovered('47811', 47811), true)
  assert.equal(m.portCovered('47811', 47812), false)
  assert.equal(m.portCovered('80, 47800-47900', 47811), true)
  assert.equal(m.portCovered('Any', 1), true)
  assert.equal(m.portCovered('', 1), true)
  assert.equal(m.portCovered('abc', 1), false)
})

test('address: none, link-local only, several networks (guest Wi-Fi hint), one', async () => {
  const m = await load()
  const lan = (addresses) => { const f = healthy(); f.network = { addresses }; return by(m.evaluate(f), 'lan') }
  assert.equal(lan([]).status, 'fail')
  assert.equal(lan(['169.254.4.4']).status, 'fail')
  const two = lan(['192.168.1.20', '10.0.0.5'])
  assert.equal(two.status, 'warn')
  assert.match(two.detail, /guest/i)
  const one = lan([{ address: '192.168.1.20' }])
  assert.equal(one.status, 'pass')
  assert.match(one.summary, /192\.168\.1\.20/)
  assert.match(one.detail, /same Wi-Fi/)
})

test('away checks are skipped, not failed, on a computer that never turned away-from-home on', async () => {
  const m = await load()
  const f = healthy(); f.cloud = { signedIn: false, reachable: null }; f.router.server = { active: false }
  const c = m.evaluate(f)
  for (const id of ['internet', 'router', 'nat', 'address']) assert.equal(by(c, id).status, 'skip', id)
  assert.equal(by(c, 'internet').fix.id, 'openSignin')
  assert.equal(m.summarize(c).worst, 'pass')
  assert.equal(by(c, 'sleep').scope, 'both')
})

test('beebo.tv unreachable: each cause has its own words, and the address check waits', async () => {
  const m = await load()
  const f = healthy()
  const titles = {}
  for (const error of ['dns', 'timeout', 'tls', 'http_5xx', 'network']) {
    f.cloud = { signedIn: true, reachable: false, error }
    const c = m.evaluate(f)
    assert.equal(by(c, 'internet').status, 'fail')
    titles[error] = by(c, 'internet').title
    assert.equal(by(c, 'address').status, 'skip', 'no point comparing addresses while offline')
  }
  assert.equal(new Set(Object.values(titles)).size, 5)
  assert.match(titles.tls, /Secure connection/)
  f.cloud = { signedIn: true, reachable: null }
  assert.equal(by(m.evaluate(f), 'internet').status, 'warn')
})

test('router: not tried, refused (with a retry), accepted but unreachable', async () => {
  const m = await load()
  const r = (server) => { const f = healthy(); f.router = { server, rtc: null }; return by(m.evaluate(f), 'router') }
  assert.equal(r(null).fix.id, 'retryRouter')
  const refused = r({ active: false, kind: 'no-mapping' })
  assert.equal(refused.status, 'warn')
  assert.equal(refused.fix.id, 'retryRouter')
  assert.match(refused.detail, /Relay/)
  assert.equal(r({ active: true, reachable: false, reason: 'x' }).status, 'warn')
  assert.match(r({ active: true, reachable: true, method: 'nat-pmp' }).summary, /NAT-PMP/)
})

test('CGNAT and double NAT come from the same autoCheck the connection test uses, and from the router when it knows better', async () => {
  const m = await load()
  const f = healthy(); f.remote.udp = { enabled: true, mapped: false, tried: true, kind: 'cgnat' }
  assert.match(by(m.evaluate(f), 'nat').title, /shares one address/)
  f.remote.udp.kind = 'double-nat'
  assert.match(by(m.evaluate(f), 'nat').title, /Two routers/)
  const g = healthy(); g.remote.udp = { enabled: true, mapped: false, tried: true, kind: '' }; g.router.server = { active: true, reachable: false, kind: 'cgnat' }
  assert.equal(by(m.evaluate(g), 'nat').status, 'warn', 'the router said CGNAT even though the UDP range said nothing')
  const h = healthy(); h.remote.problem = 'Name is taken'
  assert.equal(by(m.evaluate(h), 'nat').status, 'fail')
  const i = healthy(); i.remote.online = false
  assert.equal(by(m.evaluate(i), 'nat').status, 'warn')
  const j = healthy(); j.remote = { hostname: '', online: false, problem: '', udp: { enabled: false } }
  assert.equal(by(m.evaluate(j), 'nat').status, 'skip')
})

test('own-address record: error, not set yet, router says the home address changed, DNS lags behind', async () => {
  const m = await load()
  const a = (address, router) => { const f = healthy(); f.address = { ...f.address, ...address }; if (router) f.router.server = { ...f.router.server, ...router }; return by(m.evaluate(f), 'address') }
  const err = a({ state: 'error', reason: 'beebo.tv couldn’t update its DNS right now' })
  assert.equal(err.status, 'fail'); assert.equal(err.fix.id, 'updateAddress')
  assert.equal(a({ state: 'waiting' }).status, 'warn')
  const moved = a({}, { externalIp: '198.51.100.7' })
  assert.equal(moved.status, 'warn'); assert.match(moved.title, /changed/)
  const stale = a({ dnsIpv4: ['198.51.100.1'] })
  assert.equal(stale.status, 'warn'); assert.match(stale.title, /out of date/)
  assert.equal(a({ dnsIpv4: null }).status, 'pass', 'an unanswered DNS lookup is not evidence of a problem')
  assert.equal(a({ dnsIpv4: [] }).status, 'pass')
})

test('sleep: never / N minutes / hours / unknown', async () => {
  const m = await load()
  const s = (sleep) => { const f = healthy(); f.sleep = sleep; return by(m.evaluate(f), 'sleep') }
  assert.equal(s({ known: true, acMinutes: 0 }).status, 'pass')
  const w = s({ known: true, acMinutes: 30 })
  assert.equal(w.status, 'warn'); assert.match(w.summary, /30 minutes/); assert.equal(w.fix.id, 'sleepSettings')
  assert.match(s({ known: true, acMinutes: 180 }).summary, /3 hours/)
  assert.match(s({ known: true, acMinutes: 90 }).summary, /1 hour 30 minutes/)
  assert.equal(s({ known: false, acMinutes: null }).status, 'skip')
})

test('one broken check never stops the rest, and empty facts still produce all eight', async () => {
  const m = await load()
  const c = m.evaluate({ network: { addresses: [{ address: null }, 5] } })
  assert.equal(c.length, 8)
  assert.deepEqual(m.evaluate(null).map((x) => x.id), m.CHECK_ORDER)
})

test('summary picks the first failure, counts, phone advice and the report carry no addresses', async () => {
  const m = await load()
  const f = healthy(); f.firewall.present = false; f.sleep.acMinutes = 15; f.network.addresses = ['192.168.1.20']
  const c = m.evaluate(f)
  const s = m.summarize(c)
  assert.equal(s.first.id, 'firewall')
  assert.deepEqual(s.fixable, ['firewall', 'sleep'])
  assert.equal(s.worst, 'fail')
  const advice = m.phoneAdvice(c)
  assert.ok(advice.some((a) => /Fix the firewall/.test(a)) && advice.some((a) => /asleep|gone to sleep/.test(a)))
  assert.match(advice[advice.length - 1], /Can’t connect/)
  const text = m.reportText(c)
  assert.match(text, /^\[OK\] server: /m)
  assert.match(text, /\[PROBLEM\] firewall: /)
  assert.match(text, /\[WARNING\] sleep: /)
  assert.ok(!/192\.168|203\.0\.113/.test(text))
  const two = healthy(); two.server.listening = false; two.firewall.present = false
  assert.match(m.summarize(m.evaluate(two)).headline, /Found 2 problems\. Start with: Beebo is not answering/)
})

// ---- main-process half --------------------------------------------------------------------------
test('powercfg output is read the same in any language: the second-to-last hex value is plugged-in sleep', () => {
  const en = ['  Power Setting GUID: 29f6c1db-86da-48c5-9fdb-f2b67b1f44da  (Sleep after)', '    Current AC Power Setting Index: 0x00000708', '    Current DC Power Setting Index: 0x00000384'].join('\r\n')
  const fr = ['  GUID du paramètre : 29f6c1db (Mise en veille après)', '    Index de paramètre d’alimentation secteur actuel : 0x00000e10', '    Index de paramètre d’alimentation sur batterie actuel : 0x00000258'].join('\r\n')
  assert.equal(doc.parseStandbyMinutes(en), 30)
  assert.equal(doc.parseStandbyMinutes(fr), 60)
  assert.equal(doc.parseStandbyMinutes('0x00000000\n0x00000384'), 0)
  assert.equal(doc.parseStandbyMinutes('nothing here'), null)
  assert.equal(doc.parseStandbyMinutes('0x00000708'), null)
  assert.equal(doc.parseStandbyMinutes(''), null)
})

test('readSleepMinutes: Windows only, and a failing powercfg is "unknown", not an error', async () => {
  assert.equal(await doc.readSleepMinutes({ platform: 'linux' }), null)
  const ok = await doc.readSleepMinutes({ platform: 'win32', run: (f, a, o, cb) => { assert.equal(f, 'powercfg'); cb(null, '0x00000e10\n0x00000000') } })
  assert.equal(ok, 60)
  assert.equal(await doc.readSleepMinutes({ platform: 'win32', run: (f, a, o, cb) => cb(new Error('nope'), '') }), null)
  assert.equal(await doc.readSleepMinutes({ platform: 'win32', run: () => { throw new Error('spawn') } }), null)
})

test('probeBeebo tells DNS, timeout, certificate, server-error and network failures apart', async () => {
  const ok = (status) => async () => ({ status })
  assert.deepEqual(await doc.probeBeebo({ lookup: async () => ({}), fetchImpl: ok(404), now: (() => { let t = 0; return () => (t += 40) })() }), { reachable: true, ms: 40 })
  assert.equal((await doc.probeBeebo({ lookup: async () => { throw new Error('ENOTFOUND') }, fetchImpl: ok(200) })).error, 'dns')
  assert.equal((await doc.probeBeebo({ lookup: () => new Promise(() => {}), fetchImpl: ok(200), timeoutMs: 20 })).error, 'timeout')
  assert.equal((await doc.probeBeebo({ lookup: async () => ({}), fetchImpl: ok(503) })).error, 'http_5xx')
  assert.equal((await doc.probeBeebo({ lookup: async () => ({}), fetchImpl: () => new Promise(() => {}), timeoutMs: 20 })).error, 'timeout')
  const cert = Object.assign(new Error('fetch failed'), { cause: { code: 'CERT_HAS_EXPIRED' } })
  assert.equal((await doc.probeBeebo({ lookup: async () => ({}), fetchImpl: async () => { throw cert } })).error, 'tls')
  assert.equal((await doc.probeBeebo({ lookup: async () => ({}), fetchImpl: async () => { throw new Error('ECONNRESET') } })).error, 'network')
  const seen = []
  await doc.probeBeebo({ url: 'http://evil.example/', lookup: async (h) => { seen.push(h) }, fetchImpl: async (u) => { seen.push(u); return { status: 200 } } })
  assert.deepEqual(seen, ['beebo.tv', 'https://beebo.tv/'], 'only https addresses are used')
})

test('firewall repair uses the installer’s commands, in order: delete every rule with the name, then add one Allow rule', () => {
  const [del, add] = doc.firewallCommands(47811)
  assert.deepEqual(del, ['advfirewall', 'firewall', 'delete', 'rule', 'name=Beebo Entertainment'])
  assert.deepEqual(add, ['advfirewall', 'firewall', 'add', 'rule', 'name=Beebo Entertainment', 'dir=in', 'action=allow', 'protocol=TCP', 'localport=47811', 'profile=any'])
  for (const bad of [0, -1, 70000, 1.5, '47811', NaN, null, undefined]) assert.throws(() => doc.firewallCommands(bad), /bad port/)
  const fs = require('node:fs')
  const nsh = fs.readFileSync(path.join(appRoot, 'installer', 'beebo-installer.nsh'), 'utf8')
  assert.ok(nsh.includes('netsh advfirewall firewall delete rule name="Beebo Entertainment"'))
  assert.ok(nsh.includes('netsh advfirewall firewall add rule name="Beebo Entertainment" dir=in action=allow protocol=TCP localport=47811 profile=any'), 'same call as the installer')
})

test('the elevated command is one permission prompt, contains only fixed text and a checked number', () => {
  const inv = doc.elevatedFirewallInvocation(47811)
  assert.equal(inv.file, 'powershell.exe')
  assert.equal(inv.inner, 'netsh advfirewall firewall delete rule name="Beebo Entertainment" & netsh advfirewall firewall add rule name="Beebo Entertainment" dir=in action=allow protocol=TCP localport=47811 profile=any')
  const script = inv.args[inv.args.length - 1]
  assert.match(script, /^Start-Process -FilePath 'cmd\.exe' -ArgumentList '\/c','netsh /)
  assert.match(script, /-Verb RunAs -Wait/)
  assert.ok(inv.args.includes('-NonInteractive'))
  assert.throws(() => doc.elevatedFirewallInvocation('47811; calc'), /bad port/)
})

function fakeRun(script) {
  const calls = []
  const run = (file, args, opts, cb) => {
    calls.push([file, ...args])
    const r = script(file, args, calls.length)
    if (r && r.err) cb(r.err, r.out || '', '')
    else cb(null, (r && r.out) || 'Ok.', '')
  }
  run.calls = calls
  return run
}

test('firewall repair: as an administrator it needs no prompt; otherwise it explains nothing itself and asks Windows once', async () => {
  const admin = fakeRun(() => ({}))
  const r1 = await doc.repairFirewall({ port: 47811, platform: 'win32', run: admin })
  assert.deepEqual([r1.ok, r1.elevated, r1.code], [true, false, 'fixed'])
  assert.deepEqual(admin.calls.map((c) => c[0] + ' ' + c[3]), ['netsh delete', 'netsh add'])

  const user = fakeRun((file) => (file === 'netsh' ? { err: new Error('exit 1'), out: 'The requested operation requires elevation (Run as administrator).' } : {}))
  const r2 = await doc.repairFirewall({ port: 47811, platform: 'win32', run: user })
  assert.deepEqual([r2.ok, r2.elevated, r2.code], [true, true, 'fixed'])
  assert.deepEqual(user.calls.map((c) => c[0]), ['netsh', 'powershell.exe'], 'one failed try, then one elevated call')

  const declined = fakeRun((file) => (file === 'netsh' ? { err: new Error('x'), out: 'requires elevation' } : { err: new Error('The operation was canceled by the user.') }))
  const r3 = await doc.repairFirewall({ port: 47811, platform: 'win32', run: declined })
  assert.deepEqual([r3.ok, r3.code], [false, 'declined'])
  assert.match(r3.message, /nothing was changed/)

  const other = fakeRun((file) => (file === 'netsh' ? { err: new Error('x'), out: 'requires elevation' } : { err: new Error('boom') }))
  assert.equal((await doc.repairFirewall({ port: 47811, platform: 'win32', run: other })).code, 'failed')
})

test('firewall repair: nothing to delete is fine; a failed add is reported; other systems and bad ports are refused without running anything', async () => {
  const none = fakeRun((f, a) => (a[2] === 'delete' ? { err: new Error('exit 1'), out: 'No rules match the specified criteria.' } : {}))
  assert.equal((await doc.repairFirewall({ port: 47811, platform: 'win32', run: none })).ok, true)
  const addFails = fakeRun((f, a) => (a[2] === 'add' ? { err: new Error('exit 1'), out: 'Failed' } : {}))
  const r = await doc.repairFirewall({ port: 47811, platform: 'win32', run: addFails })
  assert.deepEqual([r.ok, r.code], [false, 'failed'])
  const never = fakeRun(() => { throw new Error('should not run') })
  assert.equal((await doc.repairFirewall({ port: 47811, platform: 'linux', run: never })).code, 'not-windows')
  assert.equal((await doc.repairFirewall({ port: 0, platform: 'win32', run: never })).code, 'bad-port')
  assert.equal(never.calls.length, 0)
})

test('collectFacts: gathers everything, never throws, and skips the internet test when away-from-home is off', async () => {
  let probed = 0
  const netsh = '\r\nRule Name:                            Beebo Entertainment\r\n-----\r\nEnabled:                              Yes\r\nDirection:                            In\r\nProfiles:                             Domain,Private,Public\r\nProtocol:                             TCP\r\nLocalPort:                            47811\r\nAction:                               Allow\r\nOk.'
  const execFile = (file, args, opts, cb) => { if (file === 'netsh') cb(null, netsh); else cb(null, '0x00000e10\n0x00000000') }
  const base = {
    platform: 'win32', execFile,
    connect: () => { const { EventEmitter } = require('node:events'); const s = new EventEmitter(); s.setTimeout = () => {}; s.destroy = () => {}; setImmediate(() => s.emit('connect')); return s },
    getServerPort: () => 47811,
    getNetworkAddresses: () => [{ address: '192.168.1.20', name: 'Wi-Fi' }],
    getPortMapStatus: () => ({ active: true, reachable: true }), getRtcPortMapStatus: () => null,
    getConnectionRemote: () => ({ hostname: 'smiths.beebo.tv', online: true, udp: { enabled: false } }),
    getHomeAddressStatus: () => ({ state: 'ok', hostname: 'smiths.home.beebo.tv', ipv4: '203.0.113.9', reason: '' }),
    getBackendUrl: () => 'https://beebo.tv', resolve4: async () => ['203.0.113.9'],
    fetchImpl: async () => { probed++; return { status: 200 } },
  }
  const signedOut = await doc.createConnectionDoctor({ ...base, isSignedIn: () => false }).collectFacts()
  assert.equal(probed, 0)
  assert.equal(signedOut.cloud.signedIn, false)
  assert.equal(signedOut.server.listening, true)
  assert.equal(signedOut.firewall.present, true)
  assert.deepEqual(signedOut.network.addresses, ['192.168.1.20'])
  assert.equal(signedOut.sleep.acMinutes, 60)
  const signedIn = await doc.createConnectionDoctor({ ...base, isSignedIn: () => true }).collectFacts()
  assert.equal(probed, 1)
  assert.equal(signedIn.cloud.reachable, true)
  assert.deepEqual(signedIn.address.dnsIpv4, ['203.0.113.9'])

  const m = await load()
  const flow = m.evaluate(signedIn)
  assert.deepEqual(flow.filter((c) => c.status !== 'pass').map((c) => c.id + ':' + c.status), ['sleep:warn'], 'real facts flow straight into the checks; only the 60-minute sleep timer is flagged')

  const broken = await doc.createConnectionDoctor({ getServerPort: () => { throw new Error('x') }, getNetworkAddresses: () => { throw new Error('x') }, execFile: () => { throw new Error('x') }, platform: 'win32' }).collectFacts()
  assert.equal(broken.server.listening, null)
  assert.equal(broken.firewall.present, null)
  assert.deepEqual(broken.network.addresses, [])
  assert.equal(broken.sleep.known, false)
})

test('fixes: only the fixed list is accepted; each does exactly its own job', async () => {
  const calls = []
  const mapper = (n) => ({ refresh: async () => { calls.push('refresh:' + n) } })
  const d = doc.createConnectionDoctor({
    getServerPort: () => 47811, platform: 'linux',
    getPortMapper: () => mapper('server'), getRtcPortMapper: () => mapper('rtc'),
    getHomeAddress: () => ({ runOnce: async () => { calls.push('address'); return { ok: true } } }),
    openExternal: async (u) => { calls.push('open:' + u) },
    relaunch: () => calls.push('relaunch'),
  })
  for (const bad of ['', 'calc', 'firewall; calc', '../x', 'openSignin', 'constructor']) assert.equal((await d.applyFix(bad)).ok, false, bad)
  assert.equal((await d.applyFix('retryRouter')).ok, true)
  assert.deepEqual(calls.sort(), ['refresh:rtc', 'refresh:server'])
  calls.length = 0
  assert.equal((await d.applyFix('updateAddress')).ok, true)
  assert.equal((await d.applyFix('sleepSettings')).ok, true)
  assert.deepEqual(calls, ['address', 'open:ms-settings:powersleep'])
  calls.length = 0
  assert.equal((await d.applyFix('restart')).ok, true)
  assert.deepEqual(calls, [], 'the restart waits a moment so the answer reaches the window first')
  await new Promise((r) => setTimeout(r, 600))
  assert.deepEqual(calls, ['relaunch'])
  assert.equal((await d.applyFix('firewall')).code, 'not-windows')
  const none = doc.createConnectionDoctor({ getHomeAddress: () => null })
  assert.equal((await none.applyFix('updateAddress')).ok, false)
})

test('the shared report is the redacted diagnostics plus the doctor’s verdicts, capped, with secrets hidden', async () => {
  const d = doc.createConnectionDoctor({ diagnosticsText: async () => '== Beebo diagnostics ==\nBeebo version: 1' })
  assert.equal(await d.buildReport(''), '== Beebo diagnostics ==\nBeebo version: 1')
  const text = await d.buildReport('[PROBLEM] firewall: Windows Firewall is blocking phones\ntoken=' + 'Zx9-Qm2_LkP7vT4nR8sW1yU6cE3bH5jA0dGfIoXhNqM')
  assert.match(text, /== Connection doctor ==/)
  assert.match(text, /\[PROBLEM\] firewall/)
  assert.ok(!text.includes('Zx9-Qm2_LkP7vT4nR8sW1yU6cE3bH5jA0dGfIoXhNqM'), 'anything credential-shaped is hidden')
  const big = await d.buildReport('x'.repeat(50000))
  assert.ok(big.length < 7000)
  assert.equal(await d.buildReport({ not: 'a string' }), '== Beebo diagnostics ==\nBeebo version: 1')
})

test('register wires exactly four channels and copies the report to the clipboard', async () => {
  const handlers = {}
  let copied = ''
  doc.register({
    ipcMain: { handle: (name, fn) => { handlers[name] = fn } },
    clipboard: { writeText: (t) => { copied = t } },
    diagnosticsText: async () => 'REPORT', getServerPort: () => 0,
  })
  assert.deepEqual(Object.keys(handlers).sort(), ['doctor:copyReport', 'doctor:facts', 'doctor:fix', 'doctor:report'])
  assert.deepEqual(await handlers['doctor:copyReport']({}, '[OK] server: fine'), { ok: true, chars: copied.length })
  assert.match(copied, /^REPORT\n== Connection doctor ==/)
  assert.equal((await handlers['doctor:fix']({}, 'rm -rf')).ok, false)
})
