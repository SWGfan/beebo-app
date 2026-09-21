// Security review 2026-09-21 (outbound fetch and untrusted parsers, findings O-1 .. O-7):
//   O-1  xmlLite / podcast feeds: an attribute run made the reader quadratic (a feed froze the server for minutes)
//   O-2  icy.parsePlaylist: a station's playlist of blank lines took seconds (regex with ^\s* and the m flag)
//   O-3  liveTv/xmltv: tags with no ">", attribute runs, runs of "<" and of "<![CDATA[" made the guide reader quadratic
//   O-4  nfoImport: the same attribute regex, on a sidecar .nfo that arrived with a download
//   O-5  migration/kodi: a bare-address .nfo of "thetvdb.com/" repeated (1 MB: about a minute) froze the scan
//   O-6  migration/plex: a CSV whose user column is "__proto__" wrote onto Object.prototype
//   O-7  netGuard / migration safeFetch: "::ffff:7f00:1" (how a URL parser writes ::ffff:127.0.0.1) counted as public
// Every timing test uses input that took seconds (or minutes) before the fix and milliseconds now.
// Run: node --test test/sec-outbound-parsers.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')

const xmlLite = require('../electron/xmlLite')
const feed = require('../electron/podcastFeed')
const icy = require('../electron/icy')
const xmltv = require('../electron/liveTv/xmltv')
const nfo = require('../electron/nfoImport')
const kodi = require('../electron/migration/kodi')
const plex = require('../electron/migration/plex')
const guard = require('../electron/liveTv/netGuard')
const migrationFetch = require('../electron/migration/safeFetch')
const { embeddedIPv4 } = require('../electron/ipEmbedded')
const webhooks = require('../electron/webhooks')

// Runs fn and returns how long it took, in ms.
const timed = (fn) => { const t = Date.now(); const value = fn(); return { ms: Date.now() - t, value } }
const FAST_MS = 1500

// ---------------------------------------------------------------- O-1 xmlLite / podcast feeds
test('O-1: a feed with a huge attribute run is read in linear time, and attributes still parse', () => {
  const doc = '<rss><channel><title>T</title><item ' + 'a'.repeat(60000) + '><title>x</title></item></channel></rss>'
  const r = timed(() => xmlLite.parseXml(doc))
  assert.ok(r.ms < FAST_MS, `took ${r.ms} ms (the regex took ~5 s for this)`)
  assert.equal(r.value.name, 'rss')

  const ok = xmlLite.parseXml('<a x="1" y=\'two\'  z = "3"  bad w="4"/>')
  assert.deepEqual(ok.attrs, { x: '1', y: 'two', z: '3', w: '4' })
  const ent = xmlLite.parseXml('<a href="a&amp;b"/>')
  assert.equal(ent.attrs.href, 'a&b')
})

test('O-1: the attribute limits still refuse a hostile tag', () => {
  const many = Array.from({ length: 70 }, (_, i) => `a${i}="1"`).join(' ')
  assert.throws(() => xmlLite.parseXml(`<a ${many}/>`), /too_many_attributes/)
  assert.throws(() => xmlLite.parseXml('<a x="' + 'y'.repeat(9000) + '"/>'), /attribute_too_long/)
})

test('O-1: scanAttrs does not read a "name" that has no value, and skips an unterminated quote', () => {
  assert.deepEqual(xmlLite.scanAttrs('lonely a="1" b= c=\'2\' d="unterminated'), [{ name: 'a', raw: '1' }, { name: 'c', raw: '2' }])
  const r = timed(() => xmlLite.scanAttrs('a=" '.repeat(20000) + 'b=\'x\''))
  assert.ok(r.ms < FAST_MS, `took ${r.ms} ms`)
})

test('O-1: parseFeed keeps working on a normal feed', () => {
  const xml = '<?xml version="1.0"?><rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><title>Show</title>' +
    '<itunes:image href="https://example.com/a.jpg"/><item><title>Ep 1</title><guid>g1</guid><enclosure url="https://example.com/1.mp3" type="audio/mpeg" length="10"/></item></channel></rss>'
  const { show, episodes } = feed.parseFeed(Buffer.from(xml))
  assert.equal(show.title, 'Show')
  assert.equal(show.image, 'https://example.com/a.jpg')
  assert.equal(episodes.length, 1)
  assert.equal(episodes[0].audioUrl, 'https://example.com/1.mp3')
})

// ---------------------------------------------------------------- O-2 radio playlists
test('O-2: a playlist of blank lines is read in linear time', () => {
  for (const filler of ['\n', '\r\n', '\n ']) {
    const r = timed(() => icy.parsePlaylist(filler.repeat(Math.floor(65536 / filler.length))))
    assert.ok(r.ms < FAST_MS, `${JSON.stringify(filler)} took ${r.ms} ms (the regex took ~6 s)`)
    assert.deepEqual(r.value, { error: 'empty_playlist' })
  }
})

test('O-2: .pls and .m3u playlists still give their first address', () => {
  assert.deepEqual(icy.parsePlaylist('[playlist]\nnumberofentries=2\nFile1=http://a.example/stream\nTitle1=A\nFile2=http://b.example/x\n'), { url: 'http://a.example/stream' })
  assert.deepEqual(icy.parsePlaylist('#EXTM3U\r\n#EXTINF:-1,Radio\r\nhttps://c.example/live.mp3\r\n'), { url: 'https://c.example/live.mp3' })
  assert.deepEqual(icy.parsePlaylist('file1 = HTTPS://d.example/s\n'), { url: 'HTTPS://d.example/s' })
  assert.deepEqual(icy.parsePlaylist('File1=ftp://nope/x\nhttp://later.example/y\n'), { url: 'http://later.example/y' })
  assert.deepEqual(icy.parsePlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:6\nseg.ts\n'), { error: 'hls_not_supported' })
})

// ---------------------------------------------------------------- O-3 XMLTV guide files
const PROG = '<programme channel="c1" start="20260921180000 +0000" stop="20260921190000 +0000"><title>Show</title>'

test('O-3: a guide file of unterminated tags is read in linear time', () => {
  const doc = '<tv>' + PROG.repeat(6000) // no </programme> anywhere
  const r = timed(() => xmltv.parseXmltv(doc))
  assert.ok(r.ms < FAST_MS, `took ${r.ms} ms`)
  assert.equal(r.value.programmes.length, 0)
  const ch = timed(() => xmltv.parseXmltv('<tv>' + '<channel id="x">'.repeat(15000)))
  assert.ok(ch.ms < FAST_MS, `channels took ${ch.ms} ms`)
})

test('O-3: an attribute run, a tag with no end and a long text of "<" cost only their size', () => {
  const a = timed(() => xmltv.parseXmltv('<tv><programme ' + 'a'.repeat(60000) + '></programme></tv>'))
  assert.ok(a.ms < FAST_MS, `attribute run took ${a.ms} ms`)
  const b = timed(() => xmltv.parseXmltv('<tv>' + '<programme '.repeat(20000)))
  assert.ok(b.ms < FAST_MS, `open tags took ${b.ms} ms`)
  const lt = timed(() => xmltv.parseXmltv('<tv>' + PROG.replace('Show', '<'.repeat(100000)) + '</programme></tv>'))
  assert.ok(lt.ms < FAST_MS, `"<" text took ${lt.ms} ms`)
  const cd = timed(() => xmltv.parseXmltv('<tv>' + PROG.replace('Show', '<![CDATA['.repeat(25000)) + '</programme></tv>'))
  assert.ok(cd.ms < FAST_MS, `CDATA text took ${cd.ms} ms`)
})

test('O-3: a normal guide still parses (channels, times, CDATA, episode numbers, rating, categories)', () => {
  const doc = `<?xml version="1.0"?><tv>
    <channel id="c1"><display-name>Alpha</display-name><display-name lang="en">Alpha HD</display-name></channel>
    <channel id="c2"><display-name>Beta</display-name></channel>
    <programme channel="c1" start="20260921180000 -0400" stop="20260921190000 -0400">
      <title lang="en">Big &amp; Bold</title><sub-title>Pilot</sub-title>
      <desc><![CDATA[Tom & Jerry <b>meet</b>]]></desc>
      <category>Drama</category><category>Crime</category>
      <episode-num system="xmltv_ns">1.4.</episode-num>
      <new/><rating system="MPAA"><value>PG</value></rating>
    </programme>
    <PROGRAMME channel="c2" start="20260921190000" stop="20260921200000"><TITLE>Upper</TITLE><episode-num>S02E10</episode-num></PROGRAMME>
    <programme channel="c2" start="bad" stop="20260921200000"><title>Dropped</title></programme>
  </tv>`
  const r = xmltv.parseXmltv(doc)
  assert.deepEqual(r.channels, [{ id: 'c1', names: ['Alpha', 'Alpha HD'] }, { id: 'c2', names: ['Beta'] }])
  assert.equal(r.programmes.length, 2)
  const p = r.programmes[0]
  assert.equal(p.title, 'Big & Bold')
  assert.equal(p.subTitle, 'Pilot')
  assert.equal(p.desc, 'Tom & Jerry meet')
  assert.deepEqual(p.categories, ['Drama', 'Crime'])
  assert.equal(p.season, 2)
  assert.equal(p.episode, 5)
  assert.equal(p.isNew, true)
  assert.equal(p.rating, 'PG')
  assert.equal(p.start, Date.UTC(2026, 8, 21, 22, 0, 0))
  const q = r.programmes[1]
  assert.equal(q.title, 'Upper')
  assert.deepEqual([q.season, q.episode], [2, 10])
})

// ---------------------------------------------------------------- O-4 .nfo sidecars
test('O-4: an .nfo with a huge attribute run is parsed in linear time, and still reads normal files', () => {
  const r = timed(() => nfo.parseNfo('<movie ' + 'a'.repeat(60000) + '><title>Kept</title></movie>'))
  assert.ok(r.ms < FAST_MS, `took ${r.ms} ms (the regex took ~5 s)`)
  assert.equal(r.value.title, 'Kept')

  const ok = nfo.parseNfo('<?xml version="1.0"?><movie><title>Big Fish</title><year>2003</year><uniqueid type="imdb" default="true">tt0319061</uniqueid></movie>')
  assert.equal(ok.title, 'Big Fish')
  assert.equal(ok.imdbId, 'tt0319061')
  assert.equal(nfo.parseXml('<movie a="1" B=\'2\' __proto__="x" constructor="y"/>').attrs.b, '2')
  assert.deepEqual(Object.keys(nfo.parseXml('<movie a="1" __proto__="x" constructor="y"/>').attrs), ['a'])
})

test('O-4: a .plexmatch line padded with spaces is read in linear time', () => {
  const r = timed(() => nfo.parsePlexMatch('title: Show' + ' '.repeat(16000) + 'x\nTVDbId: 12345\n'))
  assert.ok(r.ms < 200, `took ${r.ms} ms`)
  assert.equal(r.value.tvdbId, 12345)
  assert.equal(nfo.parsePlexMatch('Title: The Show\nYear: 2001\nImdbId: tt1234567\n').title, 'The Show')
})

// ---------------------------------------------------------------- O-5 bare-address .nfo
test('O-5: a bare-address .nfo of a megabyte of "thetvdb.com/" is refused quickly', () => {
  const r = timed(() => kodi.parseNfoText('thetvdb.com/'.repeat(25000), { fileName: 'x.nfo' }))
  assert.ok(r.ms < FAST_MS, `took ${r.ms} ms (about a minute before)`)
  const r2 = timed(() => kodi.parseNfoText('<movie><title>T</title></movie>\n' + 'thetvdb.com/series/'.repeat(16000), { fileName: 'y.nfo' }))
  assert.ok(r2.ms < FAST_MS, `trailer took ${r2.ms} ms`)
})

test('O-5: real bare addresses still give their ids', () => {
  assert.deepEqual(kodi.idsFromUrlOnly('https://www.themoviedb.org/movie/603-the-matrix'), { tmdb: '603' })
  assert.deepEqual(kodi.idsFromUrlOnly('  https://www.imdb.com/title/tt0133093/  '), { imdb: 'tt0133093' })
  assert.deepEqual(kodi.idsFromUrlOnly('https://thetvdb.com/?tab=series&id=78901'), { tvdb: '78901' })
})

// ---------------------------------------------------------------- O-6 CSV prototype pollution
test('O-6: a Plex history CSV with "__proto__" as the user does not touch Object.prototype', (t) => {
  const marks = ['watched', 'playCount', 'rating', 'favorite', 'watchlist', 'lastPlayedAt', 'resumeSeconds', 'durationSeconds']
  t.after(() => { for (const k of marks) delete Object.prototype[k] }) // never leave it polluted for other tests
  for (const user of ['__proto__', 'constructor', '__PROTO__', 'Constructor']) {
    const csv = `title,year,user,watched,rating,favorite,watchlist,view offset\nThe Matrix,1999,${user},1,9,yes,yes,1000\nAlien,1979,${user},0,,,,5000\n`
    const bundle = plex.parseHistoryCsv(csv)
    for (const k of marks) assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, k), false, `Object.prototype.${k} was written (user "${user}")`)
    assert.equal(({}).watched, undefined)
    // The rows were still read: the person is kept, under a safe key, with their name.
    assert.equal(bundle.items.length, 2)
    assert.equal(bundle.users.length, 1)
    assert.equal(bundle.users[0].name.toLowerCase(), user.toLowerCase())
    const matrix = bundle.items.find((i) => i.title === 'The Matrix')
    assert.equal(matrix.state[bundle.users[0].key].watched, true)
    assert.equal(matrix.state[bundle.users[0].key].rating, 9)
  }
})

test('O-6: ordinary users are keyed as before', () => {
  const bundle = plex.parseHistoryCsv('title,year,user,watched\nHeat,1995,Alice,1\nHeat,1995,BOB,1\n')
  assert.deepEqual(bundle.users.map((u) => u.key).sort(), ['alice', 'bob'])
})

// ---------------------------------------------------------------- O-7 IPv4 hidden inside IPv6
test('O-7: embeddedIPv4 finds the IPv4 address in every wrapping', () => {
  const cases = {
    '::ffff:7f00:1': '127.0.0.1', '::ffff:127.0.0.1': '127.0.0.1', '0:0:0:0:0:ffff:a9fe:a9fe': '169.254.169.254',
    '::7f00:1': '127.0.0.1', '::10.1.2.3': '10.1.2.3', '64:ff9b::a9fe:a9fe': '169.254.169.254', '2002:c0a8:101::1': '192.168.1.1',
    '::ffff:0:a9fe:a9fe': '169.254.169.254', '[::ffff:7f00:1]': '127.0.0.1', '::ffff:7f00:1%eth0': '127.0.0.1'
  }
  for (const [ip, want] of Object.entries(cases)) assert.equal(embeddedIPv4(ip), want, ip)
  for (const ip of ['::1', '::', '2001:db8::1', 'fe80::1', '2606:4700::1111', 'nonsense', '1.2.3.4', '::ffff:1.2.3']) assert.equal(embeddedIPv4(ip), null, ip)
})

test('O-7: the Live TV guard judges the IPv4 inside an IPv6 address', () => {
  assert.equal(guard.classifyIp('::ffff:7f00:1'), 'loopback')
  assert.equal(guard.classifyIp('::ffff:127.0.0.1'), 'loopback')
  assert.equal(guard.classifyIp('::7f00:1'), 'loopback')
  assert.equal(guard.classifyIp('::ffff:a9fe:a9fe'), 'blocked') // 169.254.169.254, the cloud metadata address
  assert.equal(guard.classifyIp('64:ff9b::a9fe:a9fe'), 'blocked')
  assert.equal(guard.classifyIp('::ffff:c0a8:101'), 'lan')
  assert.equal(guard.classifyIp('2002:0a00:1::'), 'lan')
  assert.equal(guard.classifyIp('::ffff:0808:0808'), 'public')
  assert.equal(guard.classifyIp('fec0::1'), 'lan')
  // unchanged
  assert.equal(guard.classifyIp('::1'), 'loopback')
  assert.equal(guard.classifyIp('fd12::1'), 'lan')
  assert.equal(guard.classifyIp('fe80::1'), 'linklocal')
  assert.equal(guard.classifyIp('2606:4700::1111'), 'public')
  assert.equal(guard.classifyIp('8.8.8.8'), 'public')
})

test('O-7: the migration fetcher judges the IPv4 inside an IPv6 address', () => {
  assert.equal(migrationFetch.classifyAddress('::ffff:a9fe:a9fe'), 'blocked')
  assert.equal(migrationFetch.classifyAddress('::a9fe:a9fe'), 'blocked')
  assert.equal(migrationFetch.classifyAddress('::ffff:7f00:1'), 'loopback')
  assert.equal(migrationFetch.classifyAddress('::ffff:0a00:1'), 'private')
  assert.equal(migrationFetch.classifyAddress('::ffff:0.0.0.0'), 'blocked')
  assert.equal(migrationFetch.classifyAddress('64:ff9b::a9fe:a9fe'), 'blocked')
  assert.equal(migrationFetch.classifyAddress('fec0::1'), 'private')
  assert.equal(migrationFetch.classifyAddress('2606:4700::1111'), 'public')
  assert.equal(migrationFetch.classifyAddress('::1'), 'loopback')
})

test('O-7: the webhook/outbound classifier also knows the SIIT and site-local forms', () => {
  assert.equal(webhooks.classifyAddress('::ffff:0:a9fe:a9fe'), 'blocked')
  assert.equal(webhooks.classifyAddress('::ffff:a9fe:a9fe'), 'blocked')
  assert.equal(webhooks.classifyAddress('::ffff:7f00:1'), 'lan')
  assert.equal(webhooks.classifyAddress('fec0::1'), 'lan')
  assert.equal(webhooks.classifyAddress('2606:4700::1111'), 'public')
})

test('O-7: a guide address in the IPv4-mapped form cannot reach this computer without the owner\'s say-so', async () => {
  let hits = 0
  const srv = http.createServer((_req, res) => { hits++; res.end('<tv/>') })
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve))
  const port = srv.address().port
  try {
    await assert.rejects(guard.fetchGuideUrl(`http://[::ffff:127.0.0.1]:${port}/g.xml`, { allowPrivate: false, timeoutMs: 3000 }), (e) => e.code === 'private_address')
    await assert.rejects(guard.fetchGuideUrl(`http://[::ffff:a9fe:a9fe]/g.xml`, { allowPrivate: true, timeoutMs: 3000 }), (e) => e.code === 'blocked_address')
    assert.equal(hits, 0, 'the local server must not have been contacted')
    // With the owner's confirmation the local server is reachable, as before.
    const buf = await guard.fetchGuideUrl(`http://[::ffff:127.0.0.1]:${port}/g.xml`, { allowPrivate: true, timeoutMs: 3000 })
    assert.equal(String(buf), '<tv/>')
  } finally {
    srv.close()
  }
})
