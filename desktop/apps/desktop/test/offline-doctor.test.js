'use strict'
// Connection Doctor and the Offline status chip when the internet is gone.
// The doctor must say "no internet, but home viewing works" (not "problem found"), stay quiet about away-only
// checks it cannot run, and tell someone at home how phones connect with no internet at all.
// Run: node --test test/offline-doctor.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const appRoot = path.resolve(__dirname, '..')
const doc = require(path.join(appRoot, 'electron', 'connectionDoctorIpc.js'))
const { buildOfflineStatus, WORKS_OFFLINE, NEEDS_INTERNET } = require(path.join(appRoot, 'electron', 'offlineStatus.js'))
const { createConnectivity } = require(path.join(appRoot, 'electron', 'connectivityIpc.js'))
const cloudFetch = require(path.join(appRoot, 'electron', 'cloudFetch.js'))
const load = () => import(pathToFileURL(path.join(appRoot, 'src', 'lib', 'connectionDoctor.js')).href)

const ALLOW = { enabled: true, direction: 'In', action: 'Allow', protocol: 'TCP', localPort: '47811', profiles: 'Domain,Private,Public' }
const homeFacts = (over = {}) => ({
  platform: 'win32',
  server: { port: 47811, listening: true },
  firewall: { applicable: true, present: true, rules: [ALLOW] },
  network: { addresses: ['192.168.1.20'] },
  router: { server: null, rtc: null },
  remote: null,
  cloud: { signedIn: false, reachable: null },
  address: null,
  sleep: { known: true, acMinutes: 0 },
  ...over
})
const by = (checks, id) => checks.find((c) => c.id === id)

test('someone who never signed in, with the internet down: "No internet right now, but watching at home works."', async () => {
  const m = await load()
  const checks = m.evaluate(homeFacts({ internet: { online: false } }))
  const net = by(checks, 'internet')
  assert.equal(net.status, 'warn', 'a note, not a failure')
  assert.equal(net.offline, true)
  assert.match(net.title, /offline/i)
  assert.match(net.summary, /Everything on your home network still works/)
  assert.match(net.detail, /192\.168\.1\.20:47811/, 'the numbers a phone types, with no internet')
  assert.match(net.detail, /No internet is needed/)
  const s = m.summarize(checks)
  assert.equal(s.onlyOffline, true)
  assert.equal(s.headline, 'No internet right now, but watching at home works.')
  assert.doesNotMatch(s.headline, /problem/i)
  // The home checks stay green: this computer's own server, firewall and address are fine.
  for (const id of ['server', 'firewall', 'lan']) assert.equal(by(checks, id).status, 'pass', id)
  assert.match(m.phoneAdvice(checks).join('\n'), /internet is down, but phones on the same Wi-Fi can still connect.*192\.168\.1\.20:47811/s)
})

test('signed in, internet down: away-only checks wait instead of failing, and the headline is still the calm one', async () => {
  const m = await load()
  const checks = m.evaluate(homeFacts({
    cloud: { signedIn: true, reachable: false, error: 'dns' },
    router: { server: { active: false }, rtc: null },
    remote: { hostname: 'smiths.beebo.tv', online: false, udp: { enabled: false } },
    address: { state: 'error', reason: 'no route' }
  }))
  assert.equal(by(checks, 'internet').offline, true)
  for (const id of ['router', 'nat', 'address']) assert.equal(by(checks, id).status, 'skip', id)
  assert.equal(m.summarize(checks).headline, 'No internet right now, but watching at home works.')
})

test('a real home problem alongside no internet is still reported first', async () => {
  const m = await load()
  const checks = m.evaluate(homeFacts({ internet: { online: false }, server: { port: 47811, listening: false } }))
  const s = m.summarize(checks)
  assert.equal(s.onlyOffline, false)
  assert.match(s.headline, /Beebo is not answering/)
})

test('the internet being fine, or not measured, does not invent an offline note', async () => {
  const m = await load()
  assert.equal(by(m.evaluate(homeFacts({ internet: { online: true } })), 'internet').status, 'pass')
  assert.equal(by(m.evaluate(homeFacts({ internet: null })), 'internet').status, 'skip')
  assert.equal(by(m.evaluate(homeFacts()), 'internet').offline, undefined)
})

test('collectFacts: the doctor asks its own "is the internet up" question for someone who never signed in, and never a request', async () => {
  let asked = 0
  let requests = 0
  const d = doc.createConnectionDoctor({
    platform: 'linux', execFile: (f, a, o, cb) => cb(null, ''),
    connect: () => { const { EventEmitter } = require('node:events'); const s = new EventEmitter(); s.setTimeout = () => {}; s.destroy = () => {}; setImmediate(() => s.emit('connect')); return s },
    getServerPort: () => 47811, getNetworkAddresses: () => ['192.168.1.20'],
    isSignedIn: () => false,
    fetchImpl: async () => { requests++; return { status: 200 } },
    probeInternet: async () => { asked++; return { online: false } }
  })
  const facts = await d.collectFacts()
  assert.equal(asked, 1)
  assert.equal(requests, 0, 'signed-out: nothing is sent to Beebo')
  assert.deepEqual(facts.internet, { online: false })
  assert.equal(facts.cloud.signedIn, false)
  const noProbe = await doc.createConnectionDoctor({ platform: 'linux', execFile: (f, a, o, cb) => cb(null, ''), getServerPort: () => 0, isSignedIn: () => false }).collectFacts()
  assert.equal(noProbe.internet, null, 'no way to check means unknown, not offline')
})

// ---- the chip ---------------------------------------------------------------------------------------------------
test('status chip: offline says home viewing still works; unknown says it works without internet; online says online', () => {
  const offline = buildOfflineStatus({ cloud: { state: 'offline', lastInternetFailAt: 5 }, addresses: [{ address: '192.168.1.20' }], port: 47811, license: { signedIn: false } })
  assert.equal(offline.chip.tone, 'offline')
  assert.match(offline.chip.label, /home viewing still works/)
  assert.match(offline.headline, /offline.*Everything on your home network still works/)
  assert.deepEqual(offline.home, { works: true, urls: ['http://192.168.1.20:47811'] })
  assert.match(offline.homeWifi.message, /does not need the internet/)
  const unknown = buildOfflineStatus({ cloud: { state: 'unknown' }, addresses: [], port: 47811 })
  assert.equal(unknown.chip.tone, 'idle')
  assert.match(unknown.chip.label, /without internet/)
  const online = buildOfflineStatus({ cloud: { state: 'online' }, addresses: [] })
  assert.equal(online.chip.label, 'Online')
  assert.ok(WORKS_OFFLINE.length >= 4 && NEEDS_INTERNET.length >= 4)
  assert.ok(WORKS_OFFLINE.every((l) => !/away from home/i.test(l)), 'away-from-home is never listed as working offline')
  assert.ok(NEEDS_INTERNET.some((l) => /away from home/i.test(l)))
})

test('status chip: a signed-in household is told how long its plan holds without the internet, and never that home is affected', () => {
  const now = 1_800_000_000
  const on = buildOfflineStatus({ cloud: { state: 'offline' }, now, license: { signedIn: true, state: 'grace', expiresAt: now + 9 * 86400 + 100 } })
  assert.equal(on.license.state, 'valid_offline')
  assert.equal(on.license.daysLeft, 9)
  assert.match(on.license.message, /9 more days without the internet/)
  const one = buildOfflineStatus({ cloud: { state: 'offline' }, now, license: { signedIn: true, state: 'active', expiresAt: now + 86400 + 5 } })
  assert.match(one.license.message, /1 more day without/)
  const expired = buildOfflineStatus({ cloud: { state: 'offline' }, now, license: { signedIn: true, state: 'expired', expiresAt: now - 10 } })
  assert.equal(expired.license.state, 'expired')
  assert.match(expired.license.message, /Watching at home is not affected/)
  assert.equal(buildOfflineStatus({ cloud: { state: 'online' }, now, license: { signedIn: true, state: 'active', expiresAt: now + 5 * 86400 } }).license.message, '')
  assert.equal(buildOfflineStatus({ cloud: { state: 'offline' }, now, license: { signedIn: false } }).license, null)
})

test('connectivity service: reads what cloudFetch has seen, and "Check now" opens one connection and sends no request', async () => {
  const { EventEmitter } = require('node:events')
  const attempts = []
  const cf = cloudFetch.createCloudFetch({ fetchImpl: async () => ({ status: 200 }) })
  const probe = cloudFetch.createInternetProbe({
    cloud: cf, getHosts: () => [],
    connect: (o) => { attempts.push(o); const s = new EventEmitter(); s.destroy = () => {}; setImmediate(() => s.emit('error', Object.assign(new Error('x'), { code: 'ENETUNREACH' }))); return s }
  })
  cf.probe = probe
  const svc = createConnectivity({
    getCloud: () => cf, license: { getToken: () => '', accessStatus: () => ({}) },
    getNetworkAddresses: () => [{ address: '10.0.0.5' }], getServerPort: () => 47811
  })
  assert.equal(svc.status().state, 'unknown')
  const after = await svc.check()
  assert.deepEqual(attempts, [{ host: 'www.beeboentertainment.com', port: 443 }])
  assert.equal(after.state, 'offline')
  assert.deepEqual(after.home.urls, ['http://10.0.0.5:47811'])
})
