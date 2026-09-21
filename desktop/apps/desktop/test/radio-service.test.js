// Internet radio sessions against a fake Icecast / Shoutcast server on 127.0.0.1: the relayed
// audio, ICY now-playing, reconnect after a drop, failure reporting, the SSRF guard, listener
// sharing, recording (off by default), favourites / custom stations, and per-account privacy.
// No live network. Run: node --test test/radio-service.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { PassThrough } = require('node:stream')
const { createRequire } = require('node:module')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))
const { createRadio } = localRequire('./electron/radioService')
const { createFetcher } = localRequire('./electron/outboundFetch')

const INTERVAL = 300
const UUID = '960e57c5-0601-11e8-ae97-52543be04c81'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 4000) {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out waiting: ' + fn.toString().slice(0, 100))
    await sleep(10)
  }
}

// ----- a station -----
// Sends `interval` bytes of audio (every byte of block n is (n % 250) + 1), then an ICY metadata block,
// forever, block numbering continuing across connections so a client can check nothing was lost or
// injected at a reconnect.
function stationServer(o = {}) {
  const S = { connections: 0, closed: 0, block: 0, requests: [], live: new Set() }
  const interval = o.interval || INTERVAL
  const server = net.createServer((sock) => {
    S.connections++
    S.live.add(sock)
    let head = ''
    sock.on('error', () => {})
    sock.on('close', () => { S.closed++; S.live.delete(sock) })
    sock.on('data', (d) => {
      if (sock.started) return
      head += d
      if (!head.includes('\r\n\r\n')) return
      sock.started = true
      const p = head.split(' ')[1]
      S.requests.push({ path: p, head })
      respond(sock, p, head)
    })
  })
  function respond(sock, p, head) {
    if (o.refuseAfterFirst && S.connections > 1) { sock.destroy(); return }
    if (p === '/silent') return
    if (p === '/404') { sock.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); return }
    if (p === '/html') { sock.end('HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 13\r\nConnection: close\r\n\r\n<html>hi</html>'); return }
    if (p === '/list.pls') { const body = `[playlist]\nNumberOfEntries=1\nFile1=http://127.0.0.1:${server.address().port}/stream\n`; sock.end(`HTTP/1.1 200 OK\r\nContent-Type: audio/x-scpls\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`); return }
    if (p === '/hls.m3u8') { const body = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nseg.aac\n'; sock.end(`HTTP/1.1 200 OK\r\nContent-Type: application/vnd.apple.mpegurl\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`); return }
    if (p === '/redirect') { sock.end(`HTTP/1.1 302 Found\r\nLocation: /stream\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`); return }
    const wantsMeta = /icy-metadata:\s*1/i.test(head)
    const meta = wantsMeta ? `icy-metaint: ${interval}\r\n` : ''
    if (o.style === 'icy') sock.write(`ICY 200 OK\r\nicy-name:Test FM\r\nicy-br:128\r\nicy-genre:Testing\r\n${meta}Content-Type: audio/mpeg\r\n\r\n`)
    else sock.write(`HTTP/1.1 200 OK\r\nContent-Type: audio/mpeg\r\nicy-name: Test FM\r\nicy-br: 128\r\n${meta}Connection: close\r\n\r\n`)
    let sent = 0
    const tick = () => {
      if (sock.destroyed) return
      const n = S.block++
      sock.write(Buffer.alloc(interval, (n % 250) + 1))
      if (wantsMeta) {
        const t = (o.titles || {})[n]
        if (t === undefined) sock.write(Buffer.from([0]))
        else {
          const text = Buffer.from(`StreamTitle='${t}';StreamUrl='https://example.test/np';`)
          const padded = Buffer.alloc(Math.ceil(text.length / 16) * 16)
          text.copy(padded)
          sock.write(Buffer.concat([Buffer.from([padded.length / 16]), padded]))
        }
      }
      sent++
      if (o.dropAfterBlocks && sent >= o.dropAfterBlocks) { sock.destroy(); return }
      setTimeout(tick, o.every == null ? 4 : o.every)
    }
    tick()
  }
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(Object.assign(S, {
    port: server.address().port,
    url: (p = '/stream') => `http://127.0.0.1:${server.address().port}${p}`,
    close: () => { for (const s of S.live) s.destroy(); return new Promise((r) => server.close(r)) }
  }))))
}

// Every run of equal bytes is exactly INTERVAL long (the first and last may be cut) and the values count up by one:
// audio came through whole, in order, with no metadata bytes and nothing lost across a reconnect.
function assertContiguousAudio(buf, interval = INTERVAL) {
  const runs = []
  for (const b of buf) { if (runs.length && runs[runs.length - 1].v === b) runs[runs.length - 1].n++; else runs.push({ v: b, n: 1 }) }
  assert.ok(runs.length >= 3, 'enough audio to judge: ' + runs.length + ' runs')
  for (let i = 1; i < runs.length - 1; i++) {
    assert.equal(runs[i].n, interval, `run ${i} has ${runs[i].n} bytes`)
    assert.equal(runs[i].v, (runs[i - 1].v % 250) + 1, `run ${i} follows the previous one`)
  }
}

function listener() {
  const res = new PassThrough()
  const L = { res, chunks: [], headers: null, ended: false }
  res.writeHead = (status, headers) => { L.status = status; L.headers = headers }
  res.on('data', (c) => L.chunks.push(c))
  res.on('end', () => { L.ended = true })
  Object.defineProperty(L, 'bytes', { get: () => Buffer.concat(L.chunks) })
  return L
}

const fakeBrowser = (over = {}) => ({
  clicks: [],
  async byUuid(u) { return u === UUID ? { id: 'rb:' + u, name: 'Example FM', url: 'https://stream.example.test/fm', homepage: '', favicon: 'https://example.test/i.png', tags: ['pop'], country: 'Canada', countryCode: 'CA', language: 'english', codec: 'MP3', bitrate: 128, source: 'radio-browser' } : null },
  async click(u) { this.clicks.push(u) },
  async search() { return [] },
  async list() { return [] },
  ...over
})

async function setup(o = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-radio-'))
  const data = {}
  const store = { get: (k) => data[k], set: (k, v) => { data[k] = JSON.parse(JSON.stringify(v)) } }
  if (o.settings) store.set('radioSettings', o.settings)
  const station = o.station === null ? null : await stationServer(o.server || {})
  const browser = o.browser || fakeBrowser()
  const timing = { backoffMs: [15, 15, 15], maxFailures: 3, idleMs: 400, graceMs: 120, connectMs: 1500, ...(o.timing || {}) }
  const mk = () => createRadio({ store, dir, browser, timing, log: () => {}, fetcher: o.strict ? undefined : createFetcher({ allowPrivateNetwork: true }), ...(o.extra || {}) })
  const radio = mk()
  return { dir, store, station, browser, radio, mk, async cleanup() { await radio.close(); if (station) await station.close(); fs.rmSync(dir, { recursive: true, force: true }) } }
}

test('relay: ICY is stripped from the audio, now-playing follows the stream, the request asked for metadata', async () => {
  const t = await setup({ server: { titles: { 5: 'Artist One - Song A', 20: "It's a Trap - Don't Stop" } } })
  try {
    const s = await t.radio.startSession('alice', { url: t.station.url(), name: 'Test' })
    assert.equal(s.state, 'live')
    assert.equal(s.info.name, 'Test FM')
    assert.equal(s.info.bitrate, 128)
    assert.equal(s.info.hasMetadata, true)
    assert.equal(s.info.contentType, 'audio/mpeg')
    assert.match(t.station.requests[0].head, /icy-metadata: 1/i)
    assert.match(t.station.requests[0].head, /user-agent: BeeboEntertainment\/[\d.]+ /i)
    const L = listener()
    t.radio.attach('alice', s.id, { method: 'GET' }, L.res)
    assert.equal(L.status, 200)
    assert.equal(L.headers['Content-Type'], 'audio/mpeg')
    await until(() => (t.radio.getSession('alice', s.id).nowPlaying || {}).title === "Don't Stop")
    const np = t.radio.getSession('alice', s.id)
    assert.deepEqual([np.nowPlaying.artist, np.nowPlaying.title], ["It's a Trap", "Don't Stop"])
    assert.ok(np.history.length >= 1)
    await until(() => L.bytes.length > INTERVAL * 8)
    assertContiguousAudio(L.bytes)
    assert.equal(t.radio.getSession('alice', s.id).listeners, 1)
  } finally { await t.cleanup() }
})

test('relay: an old Shoutcast "ICY 200 OK" server works too', async () => {
  const t = await setup({ server: { style: 'icy', titles: { 3: 'Old School - Track' } } })
  try {
    const s = await t.radio.startSession('alice', { url: t.station.url() })
    assert.equal(s.state, 'live')
    assert.equal(s.info.name, 'Test FM')
    const L = listener()
    t.radio.attach('alice', s.id, { method: 'GET' }, L.res)
    await until(() => (t.radio.getSession('alice', s.id).nowPlaying || {}).title === 'Track')
    await until(() => L.bytes.length > INTERVAL * 6)
    assertContiguousAudio(L.bytes)
  } finally { await t.cleanup() }
})

test('reconnect: the station drops every few blocks; the listener stays connected and hears unbroken audio', async () => {
  const t = await setup({ server: { dropAfterBlocks: 6, titles: { 2: 'A - B' } }, timing: { maxFailures: 6 } })
  try {
    const s = await t.radio.startSession('alice', { url: t.station.url() })
    const L = listener()
    t.radio.attach('alice', s.id, { method: 'GET' }, L.res)
    await until(() => t.radio.getSession('alice', s.id).reconnects >= 2)
    await until(() => L.bytes.length > INTERVAL * 20)
    assert.ok(t.station.connections >= 3, 'connected again after each drop: ' + t.station.connections)
    assert.equal(L.ended, false, 'the listener was never cut off')
    assertContiguousAudio(L.bytes)
    assert.ok(['live', 'reconnecting'].includes(t.radio.getSession('alice', s.id).state))
  } finally { await t.cleanup() }
})

test('reconnect gives up after repeated failures: state failed, listeners released, error named', async () => {
  const t = await setup({ server: { refuseAfterFirst: true, dropAfterBlocks: 3 }, timing: { maxFailures: 2 } })
  try {
    const s = await t.radio.startSession('alice', { url: t.station.url() })
    const L = listener()
    t.radio.attach('alice', s.id, { method: 'GET' }, L.res)
    await until(() => t.radio.getSession('alice', s.id).state === 'failed')
    await until(() => L.ended)
    assert.ok(t.radio.getSession('alice', s.id).error)
    assert.throws(() => t.radio.attach('alice', s.id, { method: 'GET' }, listener().res), { status: 502 })
  } finally { await t.cleanup() }
})

test('a first connection that fails is reported at once with a reason, and leaves nothing running', async () => {
  const t = await setup({ timing: { connectMs: 300 } })
  try {
    await assert.rejects(t.radio.startSession('alice', { url: t.station.url('/html') }), { code: 'not_audio' })
    await assert.rejects(t.radio.startSession('alice', { url: t.station.url('/404') }), { code: 'http_404' })
    await assert.rejects(t.radio.startSession('alice', { url: t.station.url('/hls.m3u8') }), { code: 'hls_not_supported' })
    await assert.rejects(t.radio.startSession('alice', { url: t.station.url('/silent') }), (e) => ['timeout', 'connect_timeout'].includes(e.code))
    await assert.rejects(t.radio.startSession('alice', { url: 'http://127.0.0.1:1/nothing' }), { code: 'connection_refused' })
    await assert.rejects(t.radio.startSession('alice', { url: 'file:///etc/passwd' }), { code: 'bad_url' })
    await assert.rejects(t.radio.startSession('alice', { stationId: 'rb:not-a-real-one' }), { code: 'bad_station' })
    await assert.rejects(t.radio.startSession('alice', {}), { code: 'bad_url' })
    assert.equal(t.radio.listSessions('alice').length, 0)
  } finally { await t.cleanup() }
})

test('playlist addresses (.pls) are followed to the real stream; redirects too', async () => {
  const t = await setup({ server: { titles: { 1: 'X - Y' } } })
  try {
    const a = await t.radio.startSession('alice', { url: t.station.url('/list.pls') })
    assert.equal(a.state, 'live')
    assert.equal(a.info.name, 'Test FM')
    const b = await t.radio.startSession('alice', { url: t.station.url('/redirect') })
    assert.equal(b.state, 'live')
  } finally { await t.cleanup() }
})

test('SSRF: by default a station on the local network or a metadata address is refused; the owner can allow the LAN only', async () => {
  const t = await setup({ strict: true })
  try {
    await assert.rejects(t.radio.startSession('alice', { url: t.station.url() }), { code: 'blocked_private', status: 400 })
    await assert.rejects(t.radio.startSession('alice', { url: 'http://169.254.169.254/latest/meta-data/' }), { code: 'blocked_address', status: 400 })
    await assert.rejects(t.radio.startSession('alice', { url: 'http://192.168.1.1/stream' }), { code: 'blocked_private' })
    t.radio.setSettings({ allowPrivateNetwork: true })
    assert.equal((await t.radio.startSession('alice', { url: t.station.url() })).state, 'live')
    await assert.rejects(t.radio.startSession('alice', { url: 'http://169.254.169.254/latest/meta-data/' }), { code: 'blocked_address' })
  } finally { await t.cleanup() }
})

test('sessions belong to the account that started them; listeners of one session share one upstream connection', async () => {
  const t = await setup()
  try {
    const s = await t.radio.startSession('alice', { url: t.station.url() })
    assert.equal(t.radio.listSessions('bob').length, 0)
    assert.throws(() => t.radio.getSession('bob', s.id), { code: 'not_found' })
    assert.throws(() => t.radio.stopSession('bob', s.id), { code: 'not_found' })
    assert.throws(() => t.radio.attach('bob', s.id, { method: 'GET' }, listener().res), { code: 'not_found' })
    assert.throws(() => t.radio.getSession('alice', '../../x'), { code: 'not_found' })
    const a = listener()
    const b = listener()
    t.radio.attach('alice', s.id, { method: 'GET' }, a.res)
    t.radio.attach(null, s.id, { method: 'GET' }, b.res) // a media-token holder (the HTTP layer verified it)
    await until(() => a.bytes.length > INTERVAL * 4 && b.bytes.length > INTERVAL * 4)
    assert.equal(t.station.connections, 1, 'one upstream connection for two listeners')
    assert.equal(t.radio.getSession('alice', s.id).listeners, 2)
    b.res.destroy()
    await until(() => t.radio.getSession('alice', s.id).listeners === 1)
    t.radio.stopSession('alice', s.id)
    await until(() => a.ended)
    assert.throws(() => t.radio.getSession('alice', s.id), { code: 'not_found' })
  } finally { await t.cleanup() }
})

test('a session nobody listens to is closed after a short grace period, and its upstream connection with it', async () => {
  const t = await setup({ timing: { graceMs: 80 } })
  try {
    const s = await t.radio.startSession('alice', { url: t.station.url() })
    t.radio.reap()
    assert.equal(t.radio.listSessions('alice').length, 1, 'still inside the grace period')
    await sleep(120)
    t.radio.reap()
    assert.equal(t.radio.listSessions('alice').length, 0)
    await until(() => t.station.closed === 1)
    void s
  } finally { await t.cleanup() }
})

test('a person has a limited number of open streams: the oldest gives way', async () => {
  const t = await setup({ settings: { maxSessionsPerUser: 2 } })
  try {
    const a = await t.radio.startSession('alice', { url: t.station.url() })
    const b = await t.radio.startSession('alice', { url: t.station.url() })
    const c = await t.radio.startSession('alice', { url: t.station.url() })
    const ids = t.radio.listSessions('alice').map((x) => x.id)
    assert.deepEqual(ids.sort(), [b.id, c.id].sort())
    void a
  } finally { await t.cleanup() }
})

test('recording is OFF by default; once the owner allows it, it saves the audio without metadata, for that person only', async () => {
  const t = await setup({ server: { titles: { 4: 'Rec Artist - Rec Song' } } })
  try {
    assert.equal(t.radio.getSettings().recordingEnabled, false)
    const s = await t.radio.startSession('alice', { url: t.station.url(), name: 'Test FM' })
    await assert.rejects(t.radio.startRecording('alice', s.id), { code: 'recording_disabled', status: 403 })
    t.radio.setSettings({ recordingEnabled: true })
    await assert.rejects(t.radio.startRecording('bob', s.id), { code: 'not_found' })
    const r = await t.radio.startRecording('alice', s.id)
    assert.match(r.id, /^[a-f0-9]{20}$/)
    assert.equal(t.radio.getSession('alice', s.id).recording.active, true)
    await until(() => t.radio.getSession('alice', s.id).recording.bytes > INTERVAL * 12)
    const row = await t.radio.stopRecording('alice', s.id)
    assert.ok(row.bytes > INTERVAL * 12)
    assert.equal(t.radio.getSession('alice', s.id).recording.active, false)
    const list = t.radio.listRecordings('alice')
    assert.equal(list.length, 1)
    assert.equal(list[0].station, 'Test FM')
    const hit = t.radio.findRecording('alice', list[0].id)
    assert.ok(hit.path.endsWith('.mp3') && hit.mime === 'audio/mpeg')
    assert.equal(fs.statSync(hit.path).size, row.bytes)
    assertContiguousAudio(fs.readFileSync(hit.path))
    assert.equal(t.radio.findRecording('bob', list[0].id), null)
    assert.deepEqual(t.radio.listRecordings('bob'), [])
    assert.equal(t.radio.findRecording('alice', '../../etc/passwd'), null)
    assert.equal(fs.readdirSync(path.dirname(hit.path)).filter((f) => f.endsWith('.part')).length, 0)
    await t.radio.removeRecording('alice', list[0].id)
    assert.ok(!fs.existsSync(hit.path))
    assert.deepEqual(t.radio.listRecordings('alice'), [])
    await assert.rejects(t.radio.removeRecording('alice', list[0].id), { code: 'not_found' })
    // no space allowed for recordings at all
    t.radio.setSettings({ recordingsCapMb: 0 })
    await assert.rejects(t.radio.startRecording('alice', s.id), { code: 'recording_space_full' })
  } finally { await t.cleanup() }
})

test('favourites, custom stations and recents: per account, validated, persistent', async () => {
  const browser = fakeBrowser()
  const t = await setup({ browser, station: null })
  try {
    const r = t.radio
    assert.deepEqual(r.favorites('alice'), [])
    assert.equal((await r.addFavorite('alice', { id: 'rb:' + UUID })).favorites[0].name, 'Example FM')
    assert.equal((await r.addFavorite('alice', { id: 'rb:' + UUID })).favorites.length, 1, 'no duplicates')
    await assert.rejects(r.addFavorite('alice', { id: '../../etc' }), { code: 'bad_station' })
    await assert.rejects(r.addFavorite('alice', { id: 'rb:00000000-0000-0000-0000-000000000000' }), { code: 'station_not_found' })
    // the directory is down: the app's own snapshot is used, but only after every field is re-validated
    const down = fakeBrowser({ byUuid: async () => { throw new Error('down') } })
    const t2 = await setup({ browser: down, station: null })
    try {
      const other = 'rb:cccccccc-0601-11e8-ae97-52543be04c81'
      const fav = (await t2.radio.addFavorite('alice', { id: other, station: { id: other, name: 'Snap\nshot', url: 'https://ok.example.test/s', favicon: 'javascript:alert(1)', homepage: 'ftp://x' } })).favorites[0]
      assert.equal(fav.name, 'Snap shot')
      assert.equal(fav.favicon, '')
      assert.equal(fav.homepage, '')
      const e1 = 'rb:eeeeeeee-0601-11e8-ae97-52543be04c81'
      const e2 = 'rb:ffffffff-0601-11e8-ae97-52543be04c81'
      await assert.rejects(t2.radio.addFavorite('alice', { id: e1, station: { id: e1, name: 'Bad', url: 'file:///etc/passwd' } }), { code: 'station_not_found' })
      await assert.rejects(t2.radio.addFavorite('alice', { id: e2, station: { id: 'rb:dddddddd-0601-11e8-ae97-52543be04c81', name: 'Mismatch', url: 'https://x.test/' } }), { code: 'station_not_found' })
    } finally { await t2.cleanup() }
    // custom
    const c = r.addCustom('alice', { name: 'My Local Jazz', url: 'https://jazz.example.test/stream' })
    assert.match(c.station.id, /^c:[a-f0-9]{12}$/)
    assert.equal(r.addCustom('alice', { name: 'dup', url: 'https://jazz.example.test/stream' }).station.id, c.station.id, 'the same address is one station')
    assert.throws(() => r.addCustom('alice', { name: 'x', url: 'javascript:alert(1)' }), { code: 'bad_url' })
    assert.throws(() => r.addCustom('alice', { name: 'x', url: 'https://u:p@x.test/' }), { code: 'bad_url' })
    assert.equal(r.addCustom('alice', { url: 'https://noname.example.test/live' }).station.name, 'noname.example.test')
    assert.equal(r.updateCustom('alice', c.station.id, { name: 'Renamed' }).station.name, 'Renamed')
    assert.throws(() => r.updateCustom('bob', c.station.id, { name: 'Hijack' }), { code: 'not_found' })
    assert.equal(r.customList('bob').length, 0)
    await r.addFavorite('alice', { id: c.station.id })
    assert.equal(r.favorites('alice')[0].name, 'Renamed')
    assert.equal(r.favorites('bob').length, 0)
    // persistence
    r.saveNow()
    const again = t.mk()
    assert.equal(again.favorites('alice').length, 2)
    assert.equal(again.customList('alice').length, 2)
    await again.close()
    // removing a custom station removes it from favourites too
    r.removeCustom('alice', c.station.id)
    assert.deepEqual(r.favorites('alice').map((f) => f.id), ['rb:' + UUID])
    assert.equal(r.removeFavorite('alice', 'rb:' + UUID).favorites.length, 0)
    // too many
    for (let i = 0; i < 99; i++) r.addCustom('alice', { name: 'n' + i, url: `https://s${i}.example.test/x` })
    assert.throws(() => r.addCustom('alice', { name: 'one more', url: 'https://last.example.test/x' }), { code: 'too_many_custom' })
  } finally { await t.cleanup() }
})

test('playing a saved station works from its id, is remembered as recent, and counts a click with the directory', async () => {
  const browser = fakeBrowser()
  const t = await setup({ browser })
  try {
    const c = t.radio.addCustom('alice', { name: 'Local', url: t.station.url() })
    const s = await t.radio.startSession('alice', { stationId: c.station.id })
    assert.equal(s.station.name, 'Local')
    assert.deepEqual(t.radio.recent('alice').map((x) => x.name), ['Local'])
    await assert.rejects(t.radio.startSession('bob', { stationId: c.station.id }), { code: 'station_not_found' }, "someone else's custom station is not playable")
    // a directory station: the directory is asked for it, the stream address is played, and the click is counted
    const played = fakeBrowser({ byUuid: async (u) => ({ id: 'rb:' + u, name: 'Dir FM', url: t.station.url(), homepage: '', favicon: '', tags: [], country: '', countryCode: '', language: '', codec: '', bitrate: 0, source: 'radio-browser' }) })
    const t2 = await setup({ browser: played, station: null })
    try {
      const s2 = await t2.radio.startSession('alice', { stationId: 'rb:' + UUID })
      assert.equal(s2.state, 'live')
      assert.equal(s2.station.name, 'Dir FM')
      await until(() => played.clicks.length === 1)
      assert.deepEqual(played.clicks, [UUID])
      assert.deepEqual(t2.radio.recent('alice').map((x) => x.id), ['rb:' + UUID])
    } finally { await t2.cleanup() }
  } finally { await t.cleanup() }
})

test('account deletion closes that person\'s streams and removes their radio data and recordings', async () => {
  const t = await setup()
  try {
    t.radio.setSettings({ recordingEnabled: true })
    const s = await t.radio.startSession('alice', { url: t.station.url() })
    t.radio.addCustom('alice', { name: 'x', url: 'https://x.example.test/s' })
    await t.radio.startRecording('alice', s.id)
    await until(() => t.radio.getSession('alice', s.id).recording.bytes > INTERVAL * 3)
    await t.radio.stopRecording('alice', s.id)
    const folder = path.dirname(t.radio.findRecording('alice', t.radio.listRecordings('alice')[0].id).path)
    assert.ok(fs.existsSync(folder))
    await t.radio.removeUser('alice')
    assert.equal(t.radio.listSessions('alice').length, 0)
    assert.deepEqual(t.radio.customList('alice'), [])
    assert.ok(!fs.existsSync(folder))
  } finally { await t.cleanup() }
})
