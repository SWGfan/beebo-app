'use strict'
// Prometheus metrics: the exposition format, the off-by-default gate, who may scrape, and that the
// numbers are counts only (no titles, users, files or addresses). Real server over a fixture library.
// Run: node --test test/integrations-metrics.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const metrics = require('../electron/metrics')
const history = require('../electron/history')
const webhooks = require('../electron/webhooks')
const serverDashboard = require('../electron/serverDashboard')
const { createFixture } = require('./helpers/publicApiFixture')

test.beforeEach(() => {
  webhooks._reset()
  webhooks.configure({ retryDelaysMs: [5, 5], timeoutMs: 2000 })
})

// One sample line: name, optional {labels}, a plain number. Nothing else is allowed in the body.
const SAMPLE = /^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[a-zA-Z_][a-zA-Z0-9_]*="(?:[^"\\\n]|\\.)*"(,[a-zA-Z_][a-zA-Z0-9_]*="(?:[^"\\\n]|\\.)*")*\})? -?\d+(\.\d+)?$/

function assertPrometheusText(text) {
  assert.ok(text.endsWith('\n'), 'ends with a newline')
  const seenTypes = new Map()
  let lastHelp = null
  for (const line of text.trimEnd().split('\n')) {
    if (line.startsWith('# HELP ')) { lastHelp = line.split(' ')[2]; continue }
    if (line.startsWith('# TYPE ')) {
      const [, , name, type] = line.split(' ')
      assert.equal(name, lastHelp, 'TYPE follows its HELP')
      assert.ok(['gauge', 'counter'].includes(type), line)
      if (type === 'counter') assert.match(name, /_total$/, 'a counter is named *_total')
      assert.ok(!seenTypes.has(name), 'a family appears once: ' + name)
      seenTypes.set(name, type)
      continue
    }
    assert.match(line, SAMPLE, 'a valid sample line')
    const name = line.split(/[{ ]/)[0]
    assert.ok(seenTypes.has(name), 'sample ' + name + ' has a TYPE above it')
  }
  return seenTypes
}

test('render: exposition format, escaping, counters end in _total, nothing that is not a number', () => {
  const text = metrics.render({
    version: '1.2.3',
    uptimeSeconds: 42,
    streams: { direct: 2, transcode: 1, paused: 1 },
    transcodes: { active: 1, max: 2 },
    library: { movies: 10, shows: 3, episodes: 40, extra: [{ kind: 'music', count: 500 }, { kind: 'bad kind!', count: 9 }], bytes: { movies: 1e9, tv: 5e8 }, disks: [{ disk: 'C:\\', freeBytes: 100, totalBytes: 1000 }] },
    bandwidth: { bytesPerSecond: 2500000, peakTodayBytesPerSecond: 9000000, sentTodayBytes: 123456789, sentTotalBytes: 987654321, relayBytes: { beebo: 1, cloudflare: 2, custom: 0 } },
    errors24h: 3,
    users: { approved: 4, pending: 1 },
    webhooks: { delivered: 7, failed: 2, queued: 0, configured: 3 },
    apiKeys: { total: 5, authFailures: 11 },
    process: { cpuPercent: 12.5, memoryBytes: 300000000 }
  })
  const types = assertPrometheusText(text)
  assert.equal(types.get('beebo_streams_active'), 'gauge')
  assert.equal(types.get('beebo_bytes_sent_total'), 'counter')
  assert.equal(types.get('beebo_webhook_deliveries_total'), 'counter')
  assert.equal(types.get('beebo_api_auth_failures_total'), 'counter')
  assert.match(text, /^beebo_info\{version="1\.2\.3"\} 1$/m)
  assert.match(text, /^beebo_streams_active\{playback="direct"\} 2$/m)
  assert.match(text, /^beebo_streams_active\{playback="transcode"\} 1$/m)
  assert.match(text, /^beebo_streams_paused 1$/m)
  assert.match(text, /^beebo_transcodes_active 1$/m)
  assert.match(text, /^beebo_transcode_slots 2$/m)
  assert.match(text, /^beebo_library_items\{kind="movies"\} 10$/m)
  assert.match(text, /^beebo_library_items\{kind="episodes"\} 40$/m)
  assert.match(text, /^beebo_library_items\{kind="music"\} 500$/m)
  assert.doesNotMatch(text, /bad kind/, 'a label value is only taken from a safe word')
  assert.match(text, /^beebo_library_bytes\{kind="movies"\} 1000000000$/m)
  assert.match(text, /^beebo_disk_free_bytes\{disk="C:\\\\"\} 100$/m, 'a backslash in a label is escaped')
  assert.match(text, /^beebo_bytes_sent_total 987654321$/m)
  assert.match(text, /^beebo_bandwidth_bytes_per_second 2500000$/m)
  assert.match(text, /^beebo_webhook_deliveries_total\{result="failed"\} 2$/m)
  assert.match(text, /^beebo_process_cpu_percent 12\.5$/m)
  assert.doesNotMatch(text, /NaN|Infinity|undefined|null/)
})

test('render: escaping of quotes and newlines, refusal of a bad metric or label name, and a lone version still renders', () => {
  const out = metrics.renderFamilies([{ name: 'x_total', help: 'line one\nline two \\ back', type: 'counter', samples: [{ labels: { a: 'say "hi"\nnow' }, value: 1.5 }] }])
  assert.equal(out, '# HELP x_total line one\\nline two \\\\ back\n# TYPE x_total counter\nx_total{a="say \\"hi\\"\\nnow"} 1.5\n')
  assert.throws(() => metrics.renderFamilies([{ name: '9bad', help: 'h', type: 'gauge', samples: [] }]))
  assert.throws(() => metrics.renderFamilies([{ name: 'ok', help: 'h', type: 'counter', samples: [] }]), /_total/)
  assert.throws(() => metrics.renderFamilies([{ name: 'ok', help: 'h', type: 'gauge', samples: [{ labels: { 'bad-label': 'x' }, value: 1 }] }]))
  assertPrometheusText(metrics.render({}))
  assert.match(metrics.render({}), /beebo_info\{version="unknown"\} 1/)
})

test('collect: parts that fail or are missing drop out instead of failing the scrape; idle conversions do not count', async () => {
  const now = 1_000_000
  const dash = {
    nowPlaying: () => [{ playback: 'direct', paused: false }, { playback: 'transcode', paused: true }, { playback: 'transcode', paused: false }],
    bandwidth: () => ({ currentBytesPerSec: 10, peakTodayBytesPerSec: 20, sentTodayBytes: 30, sentTotalBytes: 40 }),
    health: () => { throw new Error('nope') },
    library: async () => { throw new Error('no scan yet') }
  }
  const snap = await metrics.collect({
    dashboard: dash,
    transcodes: () => [{ lastAccess: now - 1000 }, { lastAccess: now - 5 * 60 * 1000 }, null],
    transcodeMax: () => 2,
    webhookStats: { delivered: 1, failed: 2, queued: 3 },
    webhooksConfigured: 2,
    apiKeyCount: 4,
    apiAuthFailures: 5,
    users: { approved: 1 },
    now: () => now
  })
  assert.deepEqual(snap.streams, { direct: 1, transcode: 2, paused: 1 })
  assert.deepEqual(snap.transcodes, { active: 1, max: 2 }, 'the idle conversion gave its slot back')
  assert.equal(snap.library, undefined)
  const text = metrics.render(snap)
  assertPrometheusText(text)
  assert.match(text, /^beebo_bytes_sent_total 40$/m)
  assert.doesNotMatch(text, /beebo_library_items/)
})

test('a live conversion is found by who is converting which file, so its session reads as a transcode', () => {
  const NOW = new Date(2026, 8, 17, 12, 0, 0).getTime()
  const file = path.join(os.tmpdir(), 'Movies', 'Heat (1995).mp4')
  const data = { authUsers: [{ id: 'u1', name: 'Sam', status: 'approved' }], watchHistory: [{ sessionId: 's1', userId: 'u1', userName: 'Sam', kind: 'movie', fileName: 'Heat (1995).mp4', title: 'Heat', startedAt: NOW - 60000, lastUpdate: NOW - 1000, currentTime: 300, duration: 6000 }] }
  const store = { get: (k) => data[k] }
  const dash = serverDashboard.createServerDashboard({ store, history: { getHistory: () => data.watchHistory }, auth: { getUsers: () => data.authUsers }, now: () => NOW })
  assert.equal(dash.nowPlaying()[0].playback, 'direct', 'no provider: everything is direct')
  dash.setTranscodeProvider(() => [{ owner: 'someone-else', filePath: file, quality: '720p', videoCodec: 'hevc', reason: 'Converting to 720p' }])
  assert.equal(dash.nowPlaying()[0].playback, 'direct', 'another person\'s conversion of the same file is not theirs')
  dash.setTranscodeProvider(() => [{ owner: 'u1', filePath: file, quality: '720p', videoCodec: 'hevc', audioCodec: 'eac3', reason: 'Converting to 720p' }])
  const row = dash.nowPlaying()[0]
  assert.equal(row.playback, 'transcode')
  assert.equal(row.transcode.quality, '720p')
  assert.equal(row.transcode.videoCodec, 'hevc')
  dash.setTranscodeProvider(() => [{ owner: 'u1', filePath: path.join(os.tmpdir(), 'Movies', 'Other.mp4'), quality: '720p' }])
  assert.equal(dash.nowPlaying()[0].playback, 'direct', 'a different file is not this session')
})

async function key(f, body) {
  const r = await f.admin('/api/admin/api-keys/create', body)
  assert.equal(r.status, 200, r.text)
  return r.body.token
}

test('/metrics is a plain 404 until the owner turns it on, credential or not', async (t) => {
  const f = await createFixture(t)
  const token = await key(f, { name: 'Prometheus', scopes: ['metrics'] })
  for (const route of ['/metrics', '/metrics/', '/api/v1/metrics']) {
    assert.equal((await f.call(null, route)).status, route === '/api/v1/metrics' ? 401 : 404, route + ' without a credential')
    assert.equal((await f.call(token, route)).status, 404, route + ' with a valid key while off')
    assert.equal((await f.call('owner', route)).status, 404, route + ' with the owner\'s token while off')
  }
  assert.equal((await f.admin('/api/admin/api-keys')).body.metrics.enabled, false, 'off by default')
  assert.equal(f.data.metricsEnabled, undefined)
})

test('turning it on: only an admin, and only with a token that holds the metrics scope', async (t) => {
  const f = await createFixture(t)
  assert.equal((await f.admin('/api/admin/metrics', { enabled: true }, 'member')).status, 403, 'a member cannot turn it on')
  assert.equal(f.data.metricsEnabled, undefined)
  const on = await f.admin('/api/admin/metrics', { enabled: true })
  assert.equal(on.status, 200)
  assert.deepEqual(on.body.metrics, { enabled: true })
  assert.equal(f.data.metricsEnabled, true)

  const scoped = await key(f, { name: 'Prometheus', scopes: ['metrics'] })
  const other = await key(f, { name: 'Just library', scopes: ['library', 'now-playing'] })
  assert.equal((await f.call(null, '/metrics')).status, 401, 'a scrape with no token is refused')
  assert.equal((await f.call('beebo_pat_' + '0'.repeat(12) + '_' + 'A'.repeat(43), '/metrics')).status, 401, 'and so is a wrong key')
  const wrongScope = await f.call(other, '/metrics')
  assert.equal(wrongScope.status, 403)
  assert.equal(wrongScope.body.error, 'insufficient_scope')
  assert.equal(wrongScope.body.scope, 'metrics')
  const member = await f.call('member', '/metrics')
  assert.equal(member.status, 403, 'a member\'s account token is not the owner\'s')
  assert.equal((await f.call('kid', '/metrics')).status, 403)
  assert.equal((await f.call(scoped, '/metrics', { method: 'POST', body: {} })).status, 405, 'read only')

  assert.equal((await f.call(scoped, '/metrics')).status, 200)
  assert.equal((await f.call(scoped, '/api/v1/metrics')).status, 200, 'the same thing under /api/v1')
  assert.equal((await f.call('owner', '/metrics')).status, 200, 'and the admin\'s own token')

  await f.admin('/api/admin/metrics', { enabled: false })
  assert.equal((await f.call(scoped, '/metrics')).status, 404, 'off again')
})

test('the scrape: Prometheus text, counts only, no titles or people or files', async (t) => {
  const f = await createFixture(t)
  await f.admin('/api/admin/metrics', { enabled: true })
  const token = await key(f, { name: 'Prometheus', scopes: ['metrics'] })

  const sid = history.startSession(f.store, { userId: 'member', userName: 'Member', title: 'Heat', fileName: 'Heat (1995).mp4', kind: 'movie' })
  history.updateSession(f.store, sid, { currentTime: 300, duration: 6000 })
  const hidden = history.startSession(f.store, { userId: 'hidden', userName: 'Hidden', title: 'Private film', fileName: 'Aliens (1986).mkv', kind: 'movie' })
  history.updateSession(f.store, hidden, { currentTime: 30, duration: 6000 })

  const r = await f.call(token, '/metrics')
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('content-type'), metrics.CONTENT_TYPE)
  assert.equal(r.headers.get('cache-control'), 'no-store')
  const types = assertPrometheusText(r.text)
  for (const name of ['beebo_info', 'beebo_streams_active', 'beebo_library_items', 'beebo_bandwidth_bytes_per_second', 'beebo_bytes_sent_total', 'beebo_errors_24h', 'beebo_webhook_deliveries_total', 'beebo_api_keys', 'beebo_users', 'beebo_process_memory_bytes', 'beebo_uptime_seconds']) {
    assert.ok(types.has(name), name + ' is exposed')
  }
  assert.match(r.text, /^beebo_library_items\{kind="movies"\} 3$/m)
  assert.match(r.text, /^beebo_library_items\{kind="shows"\} 1$/m)
  assert.match(r.text, /^beebo_library_items\{kind="episodes"\} 2$/m)
  assert.match(r.text, /^beebo_streams_active\{playback="direct"\} 2$/m, 'both streams are counted, including the one with private history')
  assert.match(r.text, /^beebo_streams_active\{playback="transcode"\} 0$/m)
  assert.match(r.text, /^beebo_users\{state="approved"\} 5$/m)
  assert.match(r.text, /^beebo_api_keys 1$/m)
  assert.match(r.text, /^beebo_library_bytes\{kind="movies"\} 6144$/m)
  assert.doesNotMatch(r.text, /Heat|Alien|Severance|Private film|Member|Hidden|127\.0\.0\.1|\.mp4|\.mkv|beebo_pat_|userId|sessionId/i, 'no title, person, file, address or credential')

  const head = await fetch(f.base + '/metrics', { method: 'HEAD', headers: { Authorization: 'Bearer ' + token } })
  assert.equal(head.status, 200)
  assert.equal(await head.text(), '', 'HEAD has no body')
})

test('the counters move: wrong-key attempts and finished webhook deliveries', async (t) => {
  const f = await createFixture(t)
  await f.admin('/api/admin/metrics', { enabled: true })
  const token = await key(f, { name: 'Prometheus', scopes: ['metrics'] })
  const read = async (name, labels) => {
    const r = await f.call(token, '/metrics')
    const m = new RegExp('^' + name + (labels ? labels.replace(/[{}"]/g, '\\$&') : '') + ' (\\d+)$', 'm').exec(r.text)
    return m ? Number(m[1]) : null
  }
  assert.equal(await read('beebo_api_auth_failures_total'), 0)
  await f.call('beebo_pat_' + '1'.repeat(12) + '_' + 'B'.repeat(43), '/api/v1')
  await f.call('beebo_pat_' + '2'.repeat(12) + '_' + 'B'.repeat(43), '/api/v1')
  assert.equal(await read('beebo_api_auth_failures_total'), 2)

  const rx = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200); res.end('ok') }) })
  await new Promise((resolve) => rx.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => { rx.closeAllConnections?.(); rx.close(resolve) }))
  const made = await f.admin('/api/admin/webhooks/create', { name: 'Recv', url: `http://127.0.0.1:${rx.address().port}/h`, events: ['request.added'], allowPrivateNetwork: true })
  assert.equal(made.status, 200, made.text)
  assert.equal((await f.admin('/api/admin/webhooks/test', { id: made.body.hook.id })).body.delivery.ok, true)
  assert.equal(await read('beebo_webhook_deliveries_total', '{result="delivered"}'), 1)
  assert.equal(await read('beebo_webhooks_configured'), 1)
})

test('web admin: the API keys tab shows the metrics switch and the Metrics scope, and the switch works', async (t) => {
  const { webAdmin } = require('./helpers/publicApiFixture')
  const f = await createFixture(t)
  const web = webAdmin(f)
  if (!web) { t.skip('openssl not available'); return }
  const page = await web('GET', '/admin?tab=apikeys')
  assert.equal(page.status, 200)
  assert.match(page.body, /Prometheus metrics: off/)
  assert.match(page.body, /name="scope_metrics"/)
  assert.match(page.body, /Turn metrics on/)
  const on = await web('POST', '/admin/metrics/set', { tab: 'apikeys', enabled: '1' })
  assert.equal(on.status, 303)
  assert.equal(f.data.metricsEnabled, true)
  const after = await web('GET', '/admin?tab=apikeys')
  assert.match(after.body, /Prometheus metrics: <span[^>]*>on<\/span>/)
  assert.match(after.body, /Turn metrics off/)
  await web('POST', '/admin/metrics/set', { tab: 'apikeys', enabled: '0' })
  assert.equal(f.data.metricsEnabled, false)
})
