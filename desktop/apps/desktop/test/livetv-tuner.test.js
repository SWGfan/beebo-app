// Live TV, tuner side: the SSRF guard, HDHomeRun discovery (incl. hostile packets), the device probe,
// lineup import (DRM channels hidden), channel merging, and tuner slot sharing / release / busy.
// Uses a fake HDHomeRun (test/helpers/fakeHdhr.js). Run: node --test test/livetv-tuner.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const path = require('node:path')
const fake = require('./helpers/fakeHdhr')

const localRequire = createRequire(path.join(path.resolve(__dirname, '..'), 'package.json'))
const guard = localRequire('./electron/liveTv/netGuard')
const hdhr = localRequire('./electron/liveTv/hdhr')
const channels = localRequire('./electron/liveTv/channels')
const { createTunerPool, TunerBusyError } = localRequire('./electron/liveTv/tunerPool')

// ------------------------------------------------------------------ SSRF guard
test('tuner addresses: private LAN and link-local pass, everything else needs an explicit confirm or is refused outright', () => {
  for (const ip of ['192.168.1.50', '10.0.0.7', '172.16.5.5', '172.31.255.1', '169.254.10.20']) assert.equal(guard.validateTunerTarget(ip).ok, true, ip)
  for (const ip of ['8.8.8.8', '172.32.0.1', '127.0.0.1', '100.64.0.1', '1.2.3.4']) {
    const r = guard.validateTunerTarget(ip)
    assert.equal(r.ok, false, ip)
    assert.equal(r.needsConfirm, true, ip)
    assert.equal(guard.validateTunerTarget(ip, { confirmNonLan: true }).ok, true, ip + ' confirmed')
  }
  for (const ip of ['0.0.0.0', '255.255.255.255', '224.0.0.251', '169.254.169.254', '240.0.0.1']) {
    assert.equal(guard.validateTunerTarget(ip, { confirmNonLan: true }).ok, false, ip + ' can never be a tuner')
  }
})

test('tuner addresses: names, tricks and odd number forms are not accepted as addresses', () => {
  for (const bad of ['hdhomerun.local', 'localhost', 'evil.example', '192.168.1.1@evil.example', 'http://192.168.1.5', '192.168.1.5/x', '192.168.1', '192.168.1.256', '0x7f.0.0.1', '010.0.0.1', '2130706433', '::1', '', null, undefined, '192.168.1.5 ', '192.168.1.5\n8.8.8.8', { host: {} }, { host: ['10.0.0.1'] }]) {
    const r = guard.validateTunerTarget(bad, { confirmNonLan: true })
    if (bad === '192.168.1.5 ') assert.equal(r.ok, true, 'trailing space is trimmed')
    else assert.equal(r.ok, false, JSON.stringify(bad))
  }
  assert.equal(guard.validateTunerTarget({ host: '192.168.1.5', port: 99999 }).error, 'bad_port')
  assert.equal(guard.validateTunerTarget({ host: '192.168.1.5', port: 'abc' }).error, 'bad_port')
  assert.equal(guard.validateTunerTarget({ host: '192.168.1.5', port: 80 }).port, 80)
  assert.equal(guard.classifyIp('::ffff:127.0.0.1'), 'loopback')
  assert.equal(guard.classifyIp('fe80::1'), 'linklocal')
  assert.equal(guard.classifyIp('fd00::5'), 'lan')
})

test('getJson: no redirects, size cap, bad JSON, timeout, refuses odd paths', async () => {
  const http = require('node:http')
  const srv = http.createServer((req, res) => {
    if (req.url === '/redir') { res.writeHead(302, { Location: 'http://127.0.0.1:1/' }); res.end(); return }
    if (req.url === '/big') { res.writeHead(200); res.end('[' + '1,'.repeat(3000) + '1]'); return }
    if (req.url === '/junk') { res.writeHead(200); res.end('not json'); return }
    if (req.url === '/hang') return
    if (req.url === '/ok') { res.writeHead(200); res.end('{"a":1}'); return }
    res.writeHead(404); res.end()
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  try {
    assert.deepEqual(await guard.getJson('127.0.0.1', port, '/ok'), { a: 1 })
    await assert.rejects(guard.getJson('127.0.0.1', port, '/redir'), { code: 'redirect' })
    await assert.rejects(guard.getJson('127.0.0.1', port, '/big', { maxBytes: 1000 }), { code: 'too_large' })
    await assert.rejects(guard.getJson('127.0.0.1', port, '/junk'), { code: 'bad_json' })
    await assert.rejects(guard.getJson('127.0.0.1', port, '/hang', { timeoutMs: 150 }), { code: 'timeout' })
    await assert.rejects(guard.getJson('127.0.0.1', port, '/missing'), { code: 'http_404' })
    await assert.rejects(guard.getJson('localhost', port, '/ok'), { code: 'bad_request' })
    await assert.rejects(guard.getJson('127.0.0.1', port, '/a b'), { code: 'bad_request' })
  } finally { srv.closeAllConnections(); srv.close() }
})

test('guide download guard: only http(s), refuses private and metadata addresses unless confirmed, re-checks redirects', async () => {
  await assert.rejects(guard.fetchGuideUrl('ftp://example.com/x.xml'), { code: 'bad_url' })
  await assert.rejects(guard.fetchGuideUrl('http://user:pw@example.com/x.xml'), { code: 'bad_url' })
  await assert.rejects(guard.fetchGuideUrl('http://127.0.0.1:9/x.xml'), { code: 'private_address' })
  await assert.rejects(guard.fetchGuideUrl('http://192.168.1.10/x.xml'), { code: 'private_address' })
  await assert.rejects(guard.fetchGuideUrl('http://169.254.169.254/latest/meta-data'), { code: 'blocked_address' })
  await assert.rejects(guard.fetchGuideUrl('http://[::1]/x.xml'), { code: 'private_address' })
  // Allowed when the owner confirms the LAN address; a redirect to a metadata address is refused even then.
  const http = require('node:http')
  const srv = http.createServer((req, res) => {
    if (req.url === '/redir') { res.writeHead(302, { Location: 'http://169.254.169.254/' }); res.end(); return }
    res.writeHead(200); res.end('<tv/>')
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  try {
    const port = srv.address().port
    assert.equal((await guard.fetchGuideUrl(`http://127.0.0.1:${port}/g.xml`, { allowPrivate: true })).toString(), '<tv/>')
    await assert.rejects(guard.fetchGuideUrl(`http://127.0.0.1:${port}/redir`, { allowPrivate: true }), { code: 'blocked_address' })
  } finally { srv.closeAllConnections(); srv.close() }
})

// ------------------------------------------------------------------ discovery
function buildReply({ type = 0x0003, tags, badCrc = false, truncate = 0 }) {
  const payload = Buffer.concat(tags.map(([tag, val]) => {
    const v = Buffer.isBuffer(val) ? val : Buffer.from(val)
    return Buffer.concat([Buffer.from([tag, v.length]), v])
  }))
  const head = Buffer.alloc(4)
  head.writeUInt16BE(type, 0)
  head.writeUInt16BE(payload.length, 2)
  const body = Buffer.concat([head, payload])
  const crc = Buffer.alloc(4)
  crc.writeUInt32LE((hdhr.crc32(body) ^ (badCrc ? 1 : 0)) >>> 0, 0)
  const out = Buffer.concat([body, crc])
  return truncate ? out.subarray(0, out.length - truncate) : out
}
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b }

test('discover request matches the documented wire format', () => {
  const p = hdhr.buildDiscoverRequest()
  assert.equal(p.readUInt16BE(0), 2)
  assert.equal(p.readUInt16BE(2), 12)
  assert.deepEqual([...p.subarray(4, 16)], [1, 4, 255, 255, 255, 255, 2, 4, 255, 255, 255, 255])
  assert.equal(p.readUInt32LE(16), hdhr.crc32(p.subarray(0, 16)))
  assert.equal(hdhr.crc32(Buffer.from('123456789')), 0xcbf43926)
})

test('discover reply parsing accepts a real-shaped reply and shrugs off hostile ones', () => {
  const good = buildReply({ tags: [[1, u32(1)], [2, u32(0x1a2b3c4d)], [0x10, Buffer.from([4])], [0x2a, 'http://192.168.1.50:80']] })
  assert.deepEqual(hdhr.parseDiscoverReply(good), { deviceType: 1, deviceId: '1A2B3C4D', tunerCount: 4 })
  const hostile = [
    buildReply({ tags: [[1, u32(1)], [2, u32(0x1a2b3c4d)]], badCrc: true }),
    buildReply({ tags: [[1, u32(1)], [2, u32(0x1a2b3c4d)]], truncate: 3 }),
    buildReply({ type: 0x0002, tags: [[1, u32(1)], [2, u32(0x1a2b3c4d)]] }),
    buildReply({ tags: [[1, u32(5)], [2, u32(0x1a2b3c4d)]] }),
    buildReply({ tags: [[1, u32(1)], [2, u32(0xffffffff)]] }),
    buildReply({ tags: [[1, u32(1)], [2, u32(0)]] }),
    buildReply({ tags: [[1, u32(1)]] }),
    Buffer.alloc(0), Buffer.alloc(7), Buffer.alloc(3000, 0x41), Buffer.from('HTTP/1.1 200 OK\r\n\r\n'), null, undefined, 'text',
    Buffer.concat([Buffer.from([0, 3, 0, 20, 1, 0xff, 0xff, 0xff]), Buffer.alloc(16)])
  ]
  for (const h of hostile) assert.equal(hdhr.parseDiscoverReply(h), null)
  // A tag whose length runs past the packet must not read out of bounds.
  const lying = Buffer.concat([Buffer.from([0, 3, 0, 4, 1, 0x7f, 0, 0]), Buffer.alloc(4)])
  lying.writeUInt32LE(hdhr.crc32(lying.subarray(0, 8)), 8)
  assert.equal(hdhr.parseDiscoverReply(lying), null)
  // Random noise never throws.
  for (let i = 0; i < 300; i++) { const b = require('node:crypto').randomBytes(1 + (i % 40)); assert.doesNotThrow(() => hdhr.parseDiscoverReply(b)) }
})

test('UDP discovery: finds a responder, ignores garbage, dedupes by address and honours the timeout', async () => {
  const good = buildReply({ tags: [[1, u32(1)], [2, u32(0x0badf00d)], [0x10, Buffer.from([2])]] })
  const responder = await fake.createFakeDiscoveryResponder({ reply: good })
  const found = await hdhr.discoverDevices({ timeoutMs: 400, port: responder.port, targets: ['127.0.0.1'], allowNonLan: true })
  await responder.close()
  assert.equal(found.length, 1)
  assert.equal(found[0].ip, '127.0.0.1')
  assert.equal(found[0].deviceId, '0BADF00D')
  assert.equal(found[0].tunerCount, 2)
  assert.equal(responder.seen[0].readUInt16BE(0), 2)
  const noisy = await fake.createFakeDiscoveryResponder({ reply: Buffer.from('garbage') })
  assert.deepEqual(await hdhr.discoverDevices({ timeoutMs: 300, port: noisy.port, targets: ['127.0.0.1'], allowNonLan: true }), [])
  await noisy.close()
  // A reply from a non-LAN source is not believed by default (127.0.0.1 is not on the home network).
  const loop = await fake.createFakeDiscoveryResponder({ reply: good })
  assert.deepEqual(await hdhr.discoverDevices({ timeoutMs: 300, port: loop.port, targets: ['127.0.0.1'] }), [])
  await loop.close()
  const t0 = Date.now()
  assert.deepEqual(await hdhr.discoverDevices({ timeoutMs: 250, port: 9, targets: ['127.0.0.1'], allowNonLan: true }), [])
  assert.ok(Date.now() - t0 < 2500)
})

test('broadcast targets: directed broadcast per interface plus the global one', () => {
  const t = hdhr.broadcastTargets(() => ({ eth0: [{ family: 'IPv4', address: '192.168.1.20', netmask: '255.255.255.0', internal: false }], lo: [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true }], v6: [{ family: 'IPv6', address: 'fe80::1', netmask: 'ffff::', internal: false }] }))
  assert.deepEqual(t.sort(), ['192.168.1.255', '255.255.255.255'])
})

// ------------------------------------------------------------ probe + lineup
test('probeDevice validates /discover.json and never trusts URLs the device reports', async (t) => {
  const dev = await fake.createFakeHdhr({ real: false })
  t.after(() => dev.close())
  const ok = await hdhr.probeDevice('127.0.0.1', dev.port)
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.device, { deviceId: '1A2B3C4D', tunerCount: 2, name: 'HDHomeRun TEST', model: 'HDHR5-2US', firmware: '20240101' })
  assert.ok(!JSON.stringify(ok).includes('evil.example'), 'BaseURL/LineupURL are dropped')
  const badDocs = [{}, { DeviceID: 'zz', TunerCount: 2, ModelNumber: 'x' }, { DeviceID: '1A2B3C4D', TunerCount: 99, ModelNumber: 'x' }, { DeviceID: '1A2B3C4D', TunerCount: 'two', ModelNumber: 'x' }, { DeviceID: '1A2B3C4D', TunerCount: 2 }, []]
  for (const doc of badDocs) {
    const r = await hdhr.probeDevice('192.168.1.1', 80, { fetchJson: async () => doc })
    assert.equal(r.ok, false, JSON.stringify(doc))
  }
  const rejected = await hdhr.probeDevice('192.168.1.1', 80, { fetchJson: async () => { throw new guard.GuardError('timeout') } })
  assert.equal(rejected.error, 'timeout')
  const xss = await hdhr.probeDevice('192.168.1.1', 80, { fetchJson: async () => ({ DeviceID: '1a2b3c4d', TunerCount: 2, FriendlyName: '<img src=x onerror=1>HDHR' + 'x'.repeat(500) }) })
  assert.equal(xss.ok, true)
  assert.ok(!/[<>]/.test(xss.device.name) && xss.device.name.length <= 80)
})

test('lineup import: rows are cleaned, DRM is flagged, hostile rows are dropped, per-channel URLs ignored', async (t) => {
  const dev = await fake.createFakeHdhr({ real: false })
  t.after(() => dev.close())
  const rows = await hdhr.fetchLineup('127.0.0.1', dev.port)
  assert.deepEqual(rows.map((r) => [r.guideNumber, r.drm]), [['2.1', false], ['4.1', false], ['7.1', true], ['9.1', false]])
  assert.ok(!JSON.stringify(rows).includes('evil.example'))
  const messy = hdhr.normalizeLineup([null, 5, 'x', { GuideNumber: '../../etc' }, { GuideNumber: '5.1', GuideName: '<b>News</b>' }, { GuideNumber: '5.1', GuideName: 'dup' }, { GuideNumber: '6', DRM: '1', HD: '1' }, { GuideNumber: 'x'.repeat(40) }])
  assert.deepEqual(messy.map((r) => r.guideNumber), ['5.1', '6'])
  assert.equal(messy[0].guideName, 'bNews/b')
  assert.equal(messy[1].drm, true)
  assert.deepEqual(hdhr.normalizeLineup({ not: 'an array' }), [])
  assert.equal(hdhr.normalizeLineup(new Array(5000).fill(0).map((_, i) => ({ GuideNumber: String(i + 1) }))).length, 1000)
  assert.equal(hdhr.streamPath('2.1'), '/auto/v2.1')
  assert.equal(hdhr.streamPath('a b/../c'), '/auto/va%20b%2F..%2Fc')
})

test('channels: DRM ones are hidden and counted, the same channel on two tuners is one channel, overrides renumber and hide', () => {
  const cfg = channels.normalizeConfig({
    enabled: true,
    devices: [
      { id: 'AAAAAAAA', ip: '192.168.1.10', apiPort: 80, streamPort: 5004, tunerCount: 2 },
      { id: 'BBBBBBBB', ip: '192.168.1.11', apiPort: 80, streamPort: 5004, tunerCount: 2 },
      { id: 'CCCCCCCC', ip: '8.8.8.8', apiPort: 80, streamPort: 5004, tunerCount: 2 }
    ],
    lineups: {
      AAAAAAAA: { channels: [{ guideNumber: '2.1', guideName: 'KTST' }, { guideNumber: '7.1', guideName: 'PAID', drm: true }, { guideNumber: '10.1', guideName: 'TEN' }] },
      BBBBBBBB: { channels: [{ guideNumber: '2.1', guideName: 'ktst' }, { guideNumber: '10.1', guideName: 'OTHER' }] }
    },
    overrides: { '2.1': { number: '12', name: 'Home', hidden: false }, '10.1': { hidden: true }, 'bad key!': { hidden: true }, '10.1@BBBBBBBB': { number: 'abc' } }
  })
  assert.deepEqual(cfg.devices.map((d) => d.id), ['AAAAAAAA', 'BBBBBBBB'], 'a public-address device in a file is dropped unless it was confirmed')
  const built = channels.buildChannels(cfg)
  assert.equal(built.drmHidden, 1)
  assert.equal(built.channels.length, 3)
  const byKey = Object.fromEntries(built.channels.map((c) => [c.key, c]))
  assert.deepEqual(byKey['2.1'].devices, ['AAAAAAAA', 'BBBBBBBB'])
  assert.equal(byKey['2.1'].number, '12')
  assert.equal(byKey['2.1'].name, 'Home')
  assert.equal(byKey['10.1'].hidden, true)
  assert.ok(byKey['10.1@BBBBBBBB'], 'same number with a different name stays separate')
  assert.equal(byKey['10.1@BBBBBBBB'].number, '10.1', 'a bad renumber value is ignored')
  assert.ok(!Object.values(byKey).some((c) => c.guideNumber === '7.1'))
  assert.deepEqual(built.channels.map((c) => c.number), ['10.1', '10.1', '12'])
  assert.ok(channels.DRM_NOTE.includes('copy-protected'))
})

test('config normalisation survives garbage', () => {
  for (const junk of [null, undefined, 5, 'x', [], { devices: 'x', settings: 7, guide: [], overrides: 3, lineups: 'y' }]) {
    const c = channels.normalizeConfig(junk)
    assert.equal(c.enabled, false)
    assert.deepEqual(c.devices, [])
    assert.equal(c.settings.timeshiftMinutes, 90)
    assert.equal(c.settings.container, 'mkv')
    assert.equal(c.guide.source.type, 'none')
  }
  assert.equal(channels.normalizeSettings({ timeshiftMinutes: 100000, quality: 'lol', padBeforeSec: -5 }).timeshiftMinutes, 240)
  assert.equal(channels.normalizeSettings({ quality: 'lol' }).quality, '720p')
  assert.deepEqual(channels.normalizePrefs({ users: { u1: { favourites: ['2.1', 'bad key', '2.1', 5] } } }).users.u1.favourites, ['2.1'])
})

// ---------------------------------------------------------------- tuner pool
const chan = (key, devices = ['1A2B3C4D']) => ({ key, guideNumber: key, name: 'Ch ' + key, devices })

test('tuner pool: viewers of one channel share a tuner, a new channel takes the next, a third is refused politely, release frees it', async (t) => {
  const dev = await fake.createFakeHdhr({ real: false, tunerCount: 2 })
  t.after(() => dev.close())
  const pool = createTunerPool({ getDevices: () => [dev.device()] })
  t.after(() => pool.closeAll())
  const a1 = await pool.acquire({ channel: chan('2.1'), purpose: 'live', label: 'KTST' })
  const a2 = await pool.acquire({ channel: chan('2.1'), purpose: 'live', label: 'KTST' })
  assert.equal(a1.feedId, a2.feedId, 'same channel, same feed')
  assert.equal(dev.activeStreams(), 1, 'one tuner for two viewers')
  const b = await pool.acquire({ channel: chan('4.1'), purpose: 'live', label: 'WNEWS' })
  assert.notEqual(b.feedId, a1.feedId)
  assert.equal(dev.activeStreams(), 2)
  await assert.rejects(pool.acquire({ channel: chan('9.1'), purpose: 'live', label: 'KIDS' }), (e) => {
    assert.ok(e instanceof TunerBusyError)
    assert.match(e.message, /All 2 tuners are busy/)
    assert.match(e.message, /watching KTST/)
    assert.match(e.message, /Try again/)
    return true
  })
  a1.release()
  assert.equal(dev.activeStreams(), 2, 'one viewer still on 2.1')
  a2.release()
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(dev.activeStreams(), 1, 'tuner released once the last viewer left')
  const c = await pool.acquire({ channel: chan('9.1'), purpose: 'live', label: 'KIDS' })
  assert.ok(c.isLive())
  assert.equal(pool.status()[0].free, 0)
  b.release(); c.release()
})

test('tuner pool: bytes fan out to every consumer of a feed and stop on release', async (t) => {
  const dev = await fake.createFakeHdhr({ real: false })
  t.after(() => dev.close())
  const pool = createTunerPool({ getDevices: () => [dev.device()] })
  t.after(() => pool.closeAll())
  const l1 = await pool.acquire({ channel: chan('2.1'), purpose: 'live' })
  const l2 = await pool.acquire({ channel: chan('2.1'), purpose: 'record' })
  const got = [0, 0]
  l1.subscribe({ write: (b) => { got[0] += b.length; return true }, end() {} })
  l2.subscribe({ write: (b) => { got[1] += b.length; return true }, end() {} })
  await new Promise((r) => setTimeout(r, 250))
  assert.ok(got[0] > 0 && got[1] > 0 && got[0] === got[1], `both consumers got the same bytes (${got})`)
  l1.release(); l2.release()
})

test('tuner pool: a recording takes over a viewer-only tuner (viewers are told); a viewer never takes over a recording', async (t) => {
  const dev = await fake.createFakeHdhr({ real: false, tunerCount: 1 })
  t.after(() => dev.close())
  const pool = createTunerPool({ getDevices: () => [dev.device()] })
  t.after(() => pool.closeAll())
  let told = ''
  const viewer = await pool.acquire({ channel: chan('2.1'), purpose: 'live', label: 'KTST', onPreempt: (r) => { told = r } })
  const rec = await pool.acquire({ channel: chan('4.1'), purpose: 'record', label: 'News' })
  assert.equal(told, 'needed_for_recording')
  assert.equal(viewer.isLive(), false)
  assert.equal(dev.activeStreams(), 1)
  await assert.rejects(pool.acquire({ channel: chan('2.1'), purpose: 'live' }), TunerBusyError)
  await assert.rejects(pool.acquire({ channel: chan('9.1'), purpose: 'record' }), TunerBusyError, 'a second recording cannot take a recording\'s tuner')
  rec.release()
})

test('tuner pool: a tuner in use by another app (503 from the device) is reported plainly', async (t) => {
  const dev = await fake.createFakeHdhr({ real: false, tunerCount: 2 })
  t.after(() => dev.close())
  const http = require('node:http')
  const held = []
  for (let i = 0; i < 2; i++) await new Promise((resolve) => { const r = http.get({ host: '127.0.0.1', port: dev.port, path: '/auto/v2.1' }, (res) => { held.push(res); resolve() }); r.on('error', () => {}) })
  const pool = createTunerPool({ getDevices: () => [dev.device()] })
  t.after(() => { pool.closeAll(); held.forEach((h) => h.destroy()) })
  await assert.rejects(pool.acquire({ channel: chan('4.1'), purpose: 'live' }), (e) => e instanceof TunerBusyError && /another app/.test(e.message) && e.detail.sawExternal)
})

test('tuner pool: feed ends when the tuner stops, unknown channel / device are clean errors, addresses are re-checked', async (t) => {
  const dev = await fake.createFakeHdhr({ real: false })
  t.after(() => dev.close())
  const deviceInfo = dev.device()
  const pool = createTunerPool({ getDevices: () => [deviceInfo] })
  t.after(() => pool.closeAll())
  await assert.rejects(pool.acquire({ channel: chan('99.9'), purpose: 'live' }), (e) => e.code === 'tuner_refused')
  await assert.rejects(pool.acquire({ channel: chan('2.1', ['ZZZZZZZZ']), purpose: 'live' }), (e) => e.code === 'no_device')
  const lease = await pool.acquire({ channel: chan('2.1'), purpose: 'live' })
  let ended = null
  lease.subscribe({ write: () => true, end: (e) => { ended = e } })
  await new Promise((r) => setTimeout(r, 100))
  await dev.close()
  await new Promise((r) => setTimeout(r, 200))
  assert.ok(ended && ended.code, 'consumers are told when the tuner goes away')
  assert.equal(lease.isLive(), false)
  const evil = { ...deviceInfo, ip: '8.8.8.8', allowNonLan: false }
  const pool2 = createTunerPool({ getDevices: () => [evil] })
  await assert.rejects(pool2.acquire({ channel: chan('2.1'), purpose: 'live' }), (e) => e.code === 'bad_address')
})

test('tuner pool: a feed that stops sending is torn down', async (t) => {
  const http = require('node:http')
  const server = http.createServer((req, res) => { res.writeHead(200); res.write(Buffer.alloc(188 * 4, 0x47)) })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => { server.closeAllConnections(); server.close() })
  const device = { id: '1A2B3C4D', ip: '127.0.0.1', apiPort: server.address().port, streamPort: server.address().port, tunerCount: 1, allowNonLan: true }
  const pool = createTunerPool({ getDevices: () => [device], stallMs: 200, watchEveryMs: 50 })
  t.after(() => pool.closeAll())
  const lease = await pool.acquire({ channel: chan('2.1'), purpose: 'live' })
  let err = null
  lease.subscribe({ write: () => true, end: (e) => { err = e } })
  await new Promise((r) => setTimeout(r, 700))
  assert.ok(err && err.code === 'no_signal')
  assert.equal(pool.size(), 0)
})
