'use strict'
// A household that IS signed in for away-from-home viewing, with the internet down: home still works at once, the signed
// plan is kept, and the renewal is retried in minutes instead of hours. Nothing is locked, wiped or extended.
// Run: node --test test/offline-signed-in.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { signToken } = require('../electron/licenseToken')
const { startOfflineHarness } = require('./helpers/offlineHarness')
const { FAST_MS, ALLOWED_OUTBOUND, BOOT_TIMERS_MS, wait } = require('./helpers/offlineScenario')

test('signed in with a valid plan and the internet down: home works at once, the plan is kept, and the renewal is retried soon', { timeout: 420000 }, async (t) => {
  const pair = crypto.generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } })
  const now = Math.floor(Date.now() / 1000)
  const token = signToken({ type: 'subscription', plan: 'beebo-standard', email: 'kim@example.test', deviceId: 'dev_offline_e2e', issuedAt: now - 35 * 86400, expiresAt: now + 9 * 86400 }, pair.privateKey)
  const h = await startOfflineHarness(t, {
    mode: 'unreachable',
    seedConfig: { licenseConfig: { publicKey: pair.publicKey }, license: { deviceId: 'dev_offline_e2e', token } }
  })
  const slow = []
  const pings = []
  for (let i = 0; i < 5; i++) pings.push((await h.get('/api/ping')).ms)
  pings.sort((a, b) => a - b)
  const stretch = Math.min(4, Math.max(1, pings[2] / 30)) // a busy PC is slower for every reason, not only the internet
  const timed = async (label, p, o) => { const r = await h.get(p, o); if (r.ms > FAST_MS * stretch) slow.push(`${label}: ${r.ms} ms`); assert.equal(r.status, 200, label); return r }
  await h.setupOwner()
  await timed('/api/movies', '/api/movies')
  await timed('page /', '/')
  await timed('/music', '/music')
  await wait(BOOT_TIMERS_MS + 4000) // the licence check runs 8 s after launch, the address update 15 s
  await timed('page / after the background jobs', '/')
  assert.deepEqual(slow, [])
  // The renewal could not get out; nothing was locked or wiped, and a retry is scheduled in minutes rather than hours.
  assert.match(h.output(), /renewal could not reach the service; trying again in 2 min\. Nothing is locked meanwhile\./)
  const saved = JSON.parse(fs.readFileSync(path.join(h.fixture.dataDir, 'config.json'), 'utf8'))
  // The server encrypts secret settings as it starts, so the token is either still plain or in the encrypted map.
  const kept = (saved.license && saved.license.token) || (saved.encryptedSettings && saved.encryptedSettings['license.token'])
  assert.ok(kept, 'the signed plan is still on disk after a failed renewal')
  const allowed = new Set([...ALLOWED_OUTBOUND, 'login.beebo.tv', 'beebo-licensing.samplehouse.workers.dev', 'kim.beebo.tv', 'kim.home.beebo.tv', 'relay1.beebo.tv'])
  const surprises = h.publicAttempts().filter((a) => !allowed.has(a.target.replace(/:\d+$/, '')))
  assert.deepEqual(surprises, [], 'signed-in extras may only talk to Beebo’s own service: ' + JSON.stringify(surprises))
  assert.ok(h.publicAttempts().some((a) => /login\.beebo\.tv/.test(a.target)), 'the renewal really was attempted (and refused)')
  assert.doesNotMatch(h.output(), /uncaught exception|unhandled rejection/i)
})
