'use strict'
// docs/PUBLIC-API.md is part of the contract: every route and event is in it, and the signature
// sample it prints verifies a real signed delivery. Run: node --test test/public-api-docs.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const publicApi = require('../electron/publicApi')
const webhooks = require('../electron/webhooks')

const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'PUBLIC-API.md'), 'utf8').replace(/\r\n/g, '\n')

test('every /api/v1 route and every webhook event is documented', () => {
  for (const [route] of publicApi.ROUTES) assert.ok(doc.includes('`GET ' + route + '`') || doc.includes('`GET ' + route + '` '), 'route ' + route)
  assert.ok(doc.includes('`GET /api/v1/continue` and `GET /api/v1/history`'))
  for (const e of webhooks.EVENTS) assert.ok(doc.includes('`' + e.id + '`'), 'event ' + e.id)
  assert.ok(doc.includes('`' + webhooks.TEST_EVENT + '`'))
  for (const s of publicApi.SCOPES) assert.ok(doc.includes('`' + s + '`'), 'scope ' + s)
})

test('the Node verification sample in the docs accepts a real signature and rejects a forged one', () => {
  const m = /```js\n(const crypto = require\('crypto'\)[\s\S]*?)```/.exec(doc)
  assert.ok(m, 'the Node sample is in the docs')
  const mod = { exports: {} }
  new Function('require', 'module', 'exports', m[1])(require, mod, mod.exports)
  const verify = mod.exports
  const secret = 'beebo_whsec_documented-sample-secret'
  const body = JSON.stringify({ event: 'request.added', timestamp: new Date().toISOString(), data: { request: { title: 'Dune' } } })
  const t = Math.floor(Date.now() / 1000)
  const header = webhooks.sign(secret, t, body)
  assert.equal(verify(secret, header, body), true)
  assert.equal(verify(secret, header, body + ' '), false, 'a changed body')
  assert.equal(verify('other-secret', header, body), false, 'the wrong secret')
  assert.equal(verify(secret, webhooks.sign(secret, t - 3600, body), body), false, 'an old timestamp')
  assert.equal(verify(secret, '', body), false)
  assert.equal(verify(secret, 'nonsense', body), false)
})

test('the Python sample computes the same thing the Node sample and the server do', () => {
  const m = /```python\n([\s\S]*?)```/.exec(doc)
  assert.ok(m, 'the Python sample is in the docs')
  // Not run here (no Python on every machine): its signing line must match the documented algorithm.
  assert.match(m[1], /hmac\.new\(secret\.encode\(\), str\(t\)\.encode\(\) \+ b"\." \+ raw_body, hashlib\.sha256\)/)
  assert.match(m[1], /hmac\.compare_digest/)
})

test('every webhook format, every metric, the per-user key routes and the event stream are documented', () => {
  const formats = require('../electron/webhookFormats')
  const metrics = require('../electron/metrics')
  for (const f of formats.FORMATS) assert.ok(doc.includes('`' + f.id + '`'), 'format ' + f.id)
  for (const c of formats.FORMATS.flatMap((f) => f.credentials)) assert.ok(doc.includes(c.id), 'credential field ' + c.id)
  for (const route of ['GET /api/me/api-keys', 'POST /api/me/api-keys/create', 'POST /api/me/api-keys/revoke', 'GET /metrics', 'Last-Event-ID', 'text/event-stream', 'scope_not_allowed', 'too_many_streams']) {
    assert.ok(doc.includes(route), route)
  }
  // Every metric a full scrape exposes is in the table.
  const text = metrics.render({
    version: '1', uptimeSeconds: 1, streams: { direct: 0, transcode: 0, paused: 0 }, transcodes: { active: 0, max: 1 },
    library: { movies: 0, shows: 0, episodes: 0, extra: [], bytes: { movies: 0, tv: 0 }, disks: [{ disk: 'C:\\', freeBytes: 1, totalBytes: 2 }] },
    bandwidth: { bytesPerSecond: 0, peakTodayBytesPerSecond: 0, sentTodayBytes: 0, sentTotalBytes: 0, relayBytes: { beebo: 0, cloudflare: 0, custom: 0 } },
    errors24h: 0, users: { approved: 1, pending: 0 }, webhooks: { delivered: 0, failed: 0, queued: 0, configured: 0 },
    apiKeys: { total: 0, authFailures: 0 }, process: { cpuPercent: 1, memoryBytes: 1 }
  })
  const names = [...new Set([...text.matchAll(/^# TYPE (\S+) /gm)].map((m) => m[1]))]
  assert.ok(names.length >= 20)
  for (const name of names) assert.ok(doc.includes(name), 'metric ' + name)
})

test('the example files exist, parse, and point at things that are real', () => {
  const dir = path.join(__dirname, '..', 'examples')
  const dash = JSON.parse(fs.readFileSync(path.join(dir, 'grafana-beebo-dashboard.json'), 'utf8'))
  assert.ok(Array.isArray(dash.panels) && dash.panels.length >= 8)
  const metrics = require('../electron/metrics')
  const known = new Set([...metrics.render({
    version: '1', uptimeSeconds: 1, streams: { direct: 0, transcode: 0, paused: 0 }, transcodes: { active: 0, max: 1 },
    library: { movies: 0, shows: 0, episodes: 0, extra: [], bytes: { movies: 0, tv: 0 }, disks: [{ disk: 'C:\\', freeBytes: 1, totalBytes: 2 }] },
    bandwidth: { bytesPerSecond: 0, peakTodayBytesPerSecond: 0, sentTodayBytes: 0, sentTotalBytes: 0, relayBytes: { beebo: 0, cloudflare: 0, custom: 0 } },
    errors24h: 0, users: { approved: 1 }, webhooks: { delivered: 0, failed: 0, queued: 0, configured: 0 }, apiKeys: { total: 0, authFailures: 0 }, process: { cpuPercent: 1, memoryBytes: 1 }
  }).matchAll(/^# TYPE (\S+) /gm)].map((m) => m[1]))
  const used = new Set([...JSON.stringify(dash).matchAll(/\bbeebo_[a-z0-9_]+/g)].map((m) => m[0]))
  assert.ok(used.size >= 6)
  for (const name of used) assert.ok(known.has(name), 'the dashboard queries ' + name + ', which Beebo does not expose')
  for (const file of ['home-assistant.yaml', 'tautulli-notifications.md']) assert.ok(fs.statSync(path.join(dir, file)).size > 500, file)
  const ha = fs.readFileSync(path.join(dir, 'home-assistant.yaml'), 'utf8')
  for (const route of ['/api/v1/now-playing', '/api/v1/library/movies']) assert.ok(ha.includes(route), route)
  assert.ok(!/beebo_pat_[0-9a-f]{12}_[A-Za-z0-9_-]{43}/.test(ha + JSON.stringify(dash)), 'no real key in a sample')
})
