'use strict'
// "Beebo keeps working when your internet is down": a real server (headless/main.js, which runs the same
// electron/main.js as the desktop app) started with every public network address blocked
// (test/helpers/offlineGuard.js), then used the way a household uses it (test/helpers/offlineScenario.js).
//
// This file: the internet is gone the polite way (every lookup and connection fails at once), for someone who never
// signed in to a Beebo account, plus the Connection Doctor against the live server. Its companions:
//   test/offline-blackhole.test.js  the uplink is dead and nothing is ever answered (only timeouts end a wait)
//   test/offline-signed-in.test.js  a household signed in for away-from-home viewing
//
// Every request must answer in under 2 s (video conversion steps excepted), and the run is judged on what the process
// tried to send out: only the hosts listed in ALLOWED_OUTBOUND may even be attempted. See docs/OFFLINE-FIRST.md.
//
//   node --test test/offline-e2e.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { startOfflineHarness } = require('./helpers/offlineHarness')
const guard = require('./helpers/offlineGuard')
const { scenario } = require('./helpers/offlineScenario')

test('internet unreachable (lookups and connections fail at once): the whole home experience works', { timeout: 420000 }, async (t) => {
  const r = await scenario(t, { mode: 'unreachable' })
  assert.deepEqual(r.problems, [], r.problems.join('\n'))
  assert.deepEqual(r.surprises, [], 'the server tried to reach a host it has no business reaching: ' + JSON.stringify(r.surprises))
  assert.doesNotMatch(r.h.output(), /uncaught exception|unhandled rejection/i, 'no crash or unhandled failure while offline')
  // A person who never signed in to Beebo is never contacted on their behalf: no licence check, no wallet, no address update.
  assert.deepEqual(r.attempted.filter((a) => /beebo\.tv|workers\.dev/.test(a.target)), [], 'signed out: nothing is sent to beebo.tv')
})

// ---- Connection Doctor, against a real server on a network with no internet -----------------------------------------
test('Connection Doctor says "No internet right now, but watching at home works." and points phones at the home address', { timeout: 120000 }, async (t) => {
  const g = guard.install({ mode: 'unreachable' }) // this process too: whatever the doctor tries, it cannot get out
  const h = await startOfflineHarness(t, { mode: 'unreachable' })
  await h.setupOwner()
  const doctorIpc = require('../electron/connectionDoctorIpc')
  const cloudFetch = require('../electron/cloudFetch')
  const { createConnectivity } = require('../electron/connectivityIpc')
  const cf = cloudFetch.createCloudFetch({ fetchImpl: globalThis.fetch })
  cf.probe = cloudFetch.createInternetProbe({ cloud: cf, getHosts: () => [] })
  const connectivity = createConnectivity({ getCloud: () => cf, license: { getToken: () => '', accessStatus: () => ({}) }, getNetworkAddresses: () => [{ address: '192.168.1.20' }], getServerPort: () => h.port })
  const doctor = doctorIpc.createConnectionDoctor({
    platform: 'linux', execFile: (f, a, o, cb) => cb(new Error('not used'), ''),
    getServerPort: () => h.port, getNetworkAddresses: () => ['192.168.1.20'], isSignedIn: () => false,
    probeInternet: async () => ({ online: (await connectivity.check()).state !== 'offline' })
  })
  const t0 = Date.now()
  const facts = await doctor.collectFacts()
  assert.ok(Date.now() - t0 < 5000)
  assert.equal(facts.server.listening, true, 'the real server answers on its real port')
  assert.deepEqual(facts.internet, { online: false })

  const lib = await import(require('node:url').pathToFileURL(path.join(__dirname, '..', 'src', 'lib', 'connectionDoctor.js')).href)
  const checks = lib.evaluate(facts)
  const summary = lib.summarize(checks)
  assert.equal(summary.headline, 'No internet right now, but watching at home works.')
  assert.equal(checks.find((c) => c.id === 'server').status, 'pass')
  assert.equal(checks.find((c) => c.id === 'internet').offline, true)
  assert.match(lib.phoneAdvice(checks).join(' '), /192\.168\.1\.20:\d+/)
  assert.ok(g.attempts.some((a) => /beeboentertainment/.test(a.target)), 'the doctor really did try, and was refused')
})
