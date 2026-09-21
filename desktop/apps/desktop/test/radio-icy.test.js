// Internet radio wire formats and the Radio Browser directory client, on fixtures, no network:
// ICY metadata stripping across any chunking, playlist formats, and the directory's server
// discovery / failover / result shaping.
// Run: node --test test/radio-icy.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))
const icy = localRequire('./electron/icy')
const rb = localRequire('./electron/radioBrowser')
const { FetchError } = localRequire('./electron/outboundFetch')

const fx = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', 'radio', name))

// A stream as a station sends it: `interval` bytes of "audio", then a metadata block, repeated.
function makeIcyStream(interval, titles, blocksOfAudio) {
  const audio = []
  const parts = []
  for (let b = 0; b < blocksOfAudio; b++) {
    const a = Buffer.alloc(interval, (b % 250) + 1)
    audio.push(a)
    parts.push(a)
    const title = titles[b]
    if (title === undefined) { parts.push(Buffer.from([0])); continue }
    const text = Buffer.from(`StreamTitle='${title}';StreamUrl='https://example.test/np';`, 'utf8')
    const padded = Buffer.alloc(Math.ceil(text.length / 16) * 16)
    text.copy(padded)
    parts.push(Buffer.from([padded.length / 16]), padded)
  }
  return { wire: Buffer.concat(parts), audio: Buffer.concat(audio) }
}
function strip(interval, wire, chunkSizes) {
  const titles = []
  const s = icy.createIcyStripper(interval, (m) => titles.push(m.title))
  const out = []
  s.on('data', (c) => out.push(c))
  let i = 0
  let k = 0
  while (i < wire.length) { const n = chunkSizes[k++ % chunkSizes.length]; s.write(wire.subarray(i, i + n)); i += n }
  s.end()
  return new Promise((resolve) => s.on('end', () => resolve({ audio: Buffer.concat(out), titles })))
}

test('ICY stripper: the audio comes out exactly, the titles come out in order, whatever the chunking', async () => {
  const { wire, audio } = makeIcyStream(256, ['Artist One - Song A', undefined, "It's a Trap - Don't Stop", 'Ünïcode Band - Sóng'], 6)
  for (const sizes of [[wire.length], [1], [7], [255, 1, 300], [17, 4096, 3], [256, 257, 258]]) {
    const r = await strip(256, wire, sizes)
    assert.ok(r.audio.equals(audio), 'audio identical for chunking ' + sizes.join(','))
    assert.deepEqual(r.titles, ['Artist One - Song A', "It's a Trap - Don't Stop", 'Ünïcode Band - Sóng'])
  }
})

test('ICY stripper: no metadata interval means a plain pass-through; hostile intervals are ignored', async () => {
  const data = Buffer.from('just audio bytes, no metadata at all'.repeat(50))
  assert.ok((await strip(0, data, [10])).audio.equals(data))
  assert.ok((await strip(NaN, data, [10])).audio.equals(data))
  assert.ok((await strip(-5, data, [10])).audio.equals(data))
  assert.ok((await strip(2 ** 31, data, [10])).audio.equals(data))
})

test('ICY metadata text: titles with quotes, empty, missing, control characters, latin-1 bytes', () => {
  assert.deepEqual(icy.parseIcyMetadata("StreamTitle='A - B';StreamUrl='https://x.test/a';"), { title: 'A - B', url: 'https://x.test/a' })
  assert.equal(icy.parseIcyMetadata("StreamTitle='O'Brien - It's';").title, "O'Brien - It's")
  assert.equal(icy.parseIcyMetadata("StreamTitle='';StreamUrl='';").title, '')
  assert.equal(icy.parseIcyMetadata("StreamTitle='no terminator").title, '')
  assert.equal(icy.parseIcyMetadata("StreamUrl='javascript:alert(1)';").url, '')
  assert.equal(icy.parseIcyMetadata("StreamTitle='a\x01\x02b\nc';").title, 'a b c')
  assert.equal(icy.parseIcyMetadata("StreamTitle='" + 'x'.repeat(1000) + "';").title.length, 300)
  assert.equal(icy.decodeMeta(Buffer.from("StreamTitle='Caf\xe9';", 'latin1')), "StreamTitle='Café';")
  assert.equal(icy.decodeMeta(Buffer.concat([Buffer.from("StreamTitle='Caf"), Buffer.from('c3a9', 'hex'), Buffer.from("';\0\0\0")])), "StreamTitle='Café';")
  assert.deepEqual(icy.splitArtistTitle('Daft Punk - One More Time'), { artist: 'Daft Punk', title: 'One More Time' })
  assert.deepEqual(icy.splitArtistTitle('Just a title'), { artist: '', title: 'Just a title' })
  assert.deepEqual(icy.splitArtistTitle(' - leading dash'), { artist: '', title: '- leading dash' })
  assert.deepEqual(icy.splitArtistTitle('A - B - C'), { artist: 'A', title: 'B - C' })
})

test('ICY response headers, both Icecast and Shoutcast spellings', () => {
  const h = icy.icyHeaders({ 'icy-name': 'Test FM', 'icy-genre': 'Pop', 'icy-br': '128', 'icy-metaint': '16000', 'icy-url': 'https://test.example/fm', 'content-type': 'Audio/MPEG; charset=x' })
  assert.deepEqual(h, { name: 'Test FM', genre: 'Pop', description: '', url: 'https://test.example/fm', bitrate: 128, metaint: 16000, contentType: 'audio/mpeg' })
  assert.equal(icy.icyHeaders({ 'icy-br': '64,64' }).bitrate, 64)
  assert.equal(icy.icyHeaders({ 'icy-metaint': '99999999' }).metaint, 0, 'absurd interval ignored')
  assert.equal(icy.icyHeaders({ 'icy-metaint': 'abc' }).metaint, 0)
  assert.equal(icy.icyHeaders({ 'icy-url': 'javascript:alert(1)' }).url, '')
  assert.equal(icy.icyHeaders({ 'x-audiocast-name': 'Old Style' }).name, 'Old Style')
  assert.equal(icy.icyHeaders({}).name, '')
})

test('playlists: .pls and .m3u give the first stream; HLS segment playlists are refused', () => {
  assert.deepEqual(icy.parsePlaylist(fx('stream.pls').toString()), { url: 'http://stream.example.test:8000/live' })
  assert.deepEqual(icy.parsePlaylist(fx('stream.m3u').toString()), { url: 'http://stream.example.test:8000/live.mp3' })
  assert.deepEqual(icy.parsePlaylist(fx('hls.m3u8').toString()), { error: 'hls_not_supported' })
  assert.deepEqual(icy.parsePlaylist('#EXTM3U\n#comment only\n'), { error: 'empty_playlist' })
  assert.deepEqual(icy.parsePlaylist('File1=file:///etc/passwd\n'), { error: 'empty_playlist' })
  assert.equal(icy.isPlaylistType('audio/x-scpls; charset=utf-8'), true)
  assert.equal(icy.isPlaylistType('audio/mpeg'), false)
  assert.equal(icy.isPlaylistUrl('http://x.test/a/list.PLS?x=1'), true)
  assert.equal(icy.isPlaylistUrl('http://x.test/live.mp3'), false)
})

test('what can be relayed: audio types yes, web pages and unknown junk no', () => {
  assert.deepEqual(icy.audioKind('audio/mpeg'), { ok: true, ext: 'mp3', mime: 'audio/mpeg' })
  assert.equal(icy.audioKind('audio/aacp').ext, 'aac')
  assert.equal(icy.audioKind('application/ogg').ext, 'ogg')
  assert.equal(icy.audioKind('').ok, true)
  assert.equal(icy.audioKind('application/octet-stream').guessed, true)
  for (const bad of ['text/html', 'application/json', 'image/png', 'video/mp4', 'text/plain']) assert.equal(icy.audioKind(bad).ok, false, bad)
})

// ---- the directory ----

function fakeDirectory(handler) {
  const calls = []
  return {
    calls,
    async get(url, o) {
      calls.push({ url, headers: o && o.headers, allowHosts: o && o.allowHosts })
      const r = await handler(url, calls.length)
      return { status: r.status || 200, headers: {}, body: Buffer.from(typeof r.body === 'string' || Buffer.isBuffer(r.body) ? r.body : JSON.stringify(r.body)), url }
    }
  }
}

test('directory: station rows are shaped, HLS / bad addresses / bad ids dropped, text cleaned', () => {
  const list = JSON.parse(fx('stations.json').toString()).map(rb.shapeStation).filter(Boolean)
  assert.deepEqual(list.map((s) => s.name), ['Example FM', 'Jazz Night'])
  const [a, b] = list
  assert.equal(a.id, 'rb:960e57c5-0601-11e8-ae97-52543be04c81')
  assert.equal(a.url, 'https://stream.example.test:8443/fm.mp3', 'the resolved address is preferred')
  assert.deepEqual(a.tags, ['pop', 'rock', '80s'])
  assert.equal(a.countryCode, 'CA')
  assert.equal(a.bitrate, 128)
  assert.equal(b.url, 'http://jazz.example.test/stream')
  assert.equal(b.homepage, '')
  assert.equal(b.favicon, '', 'a data: icon is not a web address')
  assert.deepEqual(b.tags, ['jazz', 'smooth jazz'])
  assert.equal(b.countryCode, '')
  assert.equal(b.bitrate, 64)
})

test('directory: server discovery keeps only real mirrors, picks one at random, sends a User-Agent-capable client', async () => {
  const net = fakeDirectory((url) => {
    if (url === rb.DISCOVERY_URL) return { body: fx('servers.json') }
    return { body: fx('stations.json') }
  })
  const dir = rb.createRadioBrowser({ fetcher: net, random: () => 0 })
  const stations = await dir.search({ name: 'example', countryCode: 'ca', order: 'votes', limit: 500 })
  assert.equal(stations.length, 2)
  const hosts = net.calls.slice(1).map((c) => new URL(c.url).hostname)
  assert.ok(hosts.every((h) => /^(de1|fi1)\.api\.radio-browser\.info$/.test(h)), 'evil and localhost "mirrors" were not accepted: ' + hosts)
  const q = new URL(net.calls[1].url)
  assert.equal(q.pathname, '/json/stations/search')
  assert.equal(q.searchParams.get('name'), 'example')
  assert.equal(q.searchParams.get('countrycode'), 'CA')
  assert.equal(q.searchParams.get('hidebroken'), 'true')
  assert.equal(q.searchParams.get('limit'), '100', 'limit is capped')
  assert.equal(q.searchParams.get('order'), 'votes')
  assert.equal(net.calls[1].headers.Accept, 'application/json')
  assert.deepEqual(net.calls[1].allowHosts, ['all.api.radio-browser.info', '.api.radio-browser.info'], 'only the directory hosts may be contacted')
  // cached: the same search again does not touch the network
  const n = net.calls.length
  await dir.search({ name: 'example', countryCode: 'ca', order: 'votes', limit: 500 })
  assert.equal(net.calls.length, n)
})

test('directory: a mirror that fails is skipped and the next tried; discovery failing falls back to the built-in list', async () => {
  let t = 0
  // random() => 0 makes the shuffle try the LAST mirror first, so that is the one that is down.
  const failing = new Set(['de2.api.radio-browser.info'])
  const net = fakeDirectory((url) => {
    const host = new URL(url).hostname
    if (url === rb.DISCOVERY_URL) throw new FetchError('timeout')
    if (failing.has(host)) throw new FetchError('connection_refused')
    return { body: fx('stations.json') }
  })
  const dir = rb.createRadioBrowser({ fetcher: net, now: () => t, random: () => 0, fallbackServers: ['de1.api.radio-browser.info', 'de2.api.radio-browser.info'] })
  const list = await dir.search({ tag: 'jazz' })
  assert.equal(list.length, 2)
  const hostsTried = net.calls.map((c) => new URL(c.url).hostname)
  assert.ok(hostsTried.includes('de1.api.radio-browser.info') && hostsTried.includes('de2.api.radio-browser.info'), 'tried the first, then the second: ' + hostsTried)
  // the failed mirror is skipped for a while
  net.calls.length = 0
  t += 61000
  await dir.search({ tag: 'rock' })
  assert.ok(net.calls.every((c) => !c.url.startsWith('https://de2.')), 'the failed mirror is being avoided')
  // everything down: a clear error, not a hang
  failing.add('de1.api.radio-browser.info')
  t += 61000
  await assert.rejects(dir.search({ tag: 'blues' }), { code: 'directory_unavailable' })
})

test('directory: lists (countries / languages / tags), by-uuid lookup, click counting, and request-rate protection', async () => {
  const net = fakeDirectory((url) => {
    if (url === rb.DISCOVERY_URL) return { body: fx('servers.json') }
    if (url.includes('/json/countries')) return { body: [{ name: 'Canada', iso_3166_1: 'CA', stationcount: 900 }, { name: 'Nowhere', iso_3166_1: 'zzz', stationcount: 1 }, { name: '' }] }
    if (url.includes('/json/stations/byuuid/')) return { body: [JSON.parse(fx('stations.json').toString())[0]] }
    if (url.includes('/json/url/')) return { body: { ok: true } }
    return { body: fx('stations.json') }
  })
  const dir = rb.createRadioBrowser({ fetcher: net, random: () => 0 })
  assert.deepEqual(await dir.list('countries'), [{ name: 'Canada', code: 'CA', count: 900 }, { name: 'Nowhere', code: '', count: 1 }])
  await assert.rejects(dir.list('../../etc'), { code: 'bad_list' })
  assert.equal((await dir.byUuid('960E57C5-0601-11E8-AE97-52543BE04C81')).name, 'Example FM')
  assert.equal(await dir.byUuid('../../x'), null)
  await dir.click('960e57c5-0601-11e8-ae97-52543be04c81')
  assert.ok(net.calls.some((c) => c.url.includes('/json/url/960e57c5-0601-11e8-ae97-52543be04c81')))
  const before = net.calls.length
  await dir.click('nope')
  assert.equal(net.calls.length, before, 'a bad id is never sent to the directory')
  // the household as a whole is held to a modest rate
  let limited = 0
  for (let i = 0; i < 60; i++) { try { await dir.search({ name: 'q' + i }) } catch (e) { if (e.code === 'rate_limited') limited++ } }
  assert.ok(limited > 0)
})
