// Podcast parsing on fixture data, no network: RSS/Atom feeds, OPML in and out, Podcasting 2.0
// chapters, the iTunes Search shape, ID3 CHAP chapters, and the safety of the XML reader and the
// show-notes sanitizer against hostile input.
// Run: node --test test/podcast-feed.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))
const feedLib = localRequire('./electron/podcastFeed')
const xml = localRequire('./electron/xmlLite')
const html = localRequire('./electron/htmlSanitize')
const id3 = localRequire('./electron/id3Chapters')

const fx = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', 'podcasts', name))

test('RSS: show details, episodes, itunes and podcast namespaces under any prefix', () => {
  const { show, episodes } = feedLib.parseFeed(fx('feed-basic.xml'))
  assert.equal(show.title, 'The Example Show')
  assert.equal(show.author, 'Example Media')
  assert.equal(show.image, 'https://example.test/art.jpg')
  assert.deepEqual(show.categories, ['Technology', 'Podcasting'])
  assert.equal(show.explicit, false)
  assert.equal(show.description, 'A show & tell about examples.', 'show blurb is plain text, script gone')
  // no-audio, file:// enclosure and the duplicate guid are not episodes; newest first
  assert.deepEqual(episodes.map((e) => e.title), ['Episode 3: Chapters', 'Episode 2', 'Episode 1 (bonus)'])
  const [e3, e2, e1] = episodes
  assert.equal(e3.audioUrl, 'https://cdn.example.test/ep3.mp3')
  assert.equal(e3.durationSec, 3723)
  assert.equal(e3.season, 2)
  assert.equal(e3.episode, 3)
  assert.equal(e3.sizeBytes, 1234567)
  assert.equal(e3.chaptersUrl, 'https://example.test/ep3.chapters.json', 'podcast:chapters found although the feed calls the namespace "pc"')
  assert.equal(e3.transcripts[0].url, 'https://example.test/ep3.vtt')
  assert.equal(e2.durationSec, 1800)
  assert.equal(e2.audioType, 'audio/x-m4a')
  assert.equal(e2.guid, 'ep-2')
  assert.equal(e1.episodeType, 'bonus')
  assert.equal(e1.explicit, true)
  assert.ok(e3.publishedAt > e2.publishedAt && e2.publishedAt > e1.publishedAt)
  assert.match(e3.id, /^[a-f0-9]{16}$/)
  assert.equal(e3.id, feedLib.episodeIdFor('ep-3'), 'episode ids come from the guid, so they survive a feed move')
})

test('show notes are sanitized: no script, iframe, handlers or javascript: links', () => {
  const { episodes } = feedLib.parseFeed(fx('feed-basic.xml'))
  const h = episodes[0].notesHtml
  assert.match(h, /<a href="https:\/\/example\.test\/x\?a=1&amp;b=2" rel="noopener noreferrer nofollow" target="_blank">link<\/a>/)
  assert.doesNotMatch(h, /onclick|onerror|javascript:|<iframe|<img|<script/i)
  assert.match(h, /bad link/, 'the text of a refused link stays')
  // plain-text notes become paragraphs
  assert.equal(episodes[1].notesHtml, '<p>Plain text notes.</p><p>Second paragraph &amp; more.</p>')
  assert.equal(episodes[1].summary.startsWith('Plain text notes.'), true)
})

test('sanitizer: hostile markup, entity tricks, unclosed and deeply nested tags', () => {
  const S = html.sanitizeHtml
  assert.equal(S('<script>alert(1)</script>after'), 'after')
  assert.equal(S('<style>body{}</style><b>x</b>'), '<b>x</b>')
  assert.equal(S('<SCRIPT >alert(1)</SCRIPT>ok'), 'ok')
  assert.doesNotMatch(S('<scr<script>ipt>alert(1)</scr</script>ipt>'), /<script/i)
  assert.equal(S('<a href="jav&#x09;ascript:alert(1)">x</a>'), 'x')
  assert.equal(S('<a href="  JaVaScRiPt:alert(1)">x</a>'), 'x')
  assert.equal(S('<a href="data:text/html;base64,AAAA">x</a>'), 'x')
  assert.equal(S('<a href="//evil.test/x">x</a>'), 'x', 'scheme-relative is not a web address here')
  assert.equal(S('<a href="mailto:me@example.test">m</a>'), '<a href="mailto:me@example.test" rel="noopener noreferrer nofollow" target="_blank">m</a>')
  assert.equal(S('<p onmouseover="x()" style="a:b" class="c">t</p>'), '<p>t</p>')
  assert.equal(S('<img src=x onerror=alert(1)>text'), 'text')
  assert.equal(S('1 < 2 and 3 > 2'), '1 &lt; 2 and 3 &gt; 2')
  assert.equal(S('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>', 'escaped text stays text')
  assert.equal(S('<!-- <script> --><p>c</p>'), '<p>c</p>')
  assert.equal(S('<p>open <b>tags'), '<p>open <b>tags</b></p>')
  assert.equal(S('<h1>Big</h1>'), '<h4>Big</h4>')
  const deep = S('<div>'.repeat(200) + 'x')
  assert.ok((deep.match(/<div>/g) || []).length <= 16)
  const big = S('<p>' + 'a'.repeat(500000) + '</p>')
  assert.ok(big.length < 45000)
  // linear-time on adversarial input: 20k unclosed script tags
  const t0 = Date.now()
  html.sanitizeHtml('<script>'.repeat(20000))
  html.htmlToText('<<<<<<'.repeat(20000))
  assert.ok(Date.now() - t0 < 2000, 'no quadratic behaviour')
  assert.equal(html.htmlToText('<p>One &amp; two</p><p>Three<br>four</p>'), 'One & two\n\nThree\nfour')
})

test('XML reader refuses entity declarations and external identifiers (XXE, billion laughs)', () => {
  assert.throws(() => feedLib.parseFeed(fx('feed-xxe.xml')), (e) => e.code === 'not_a_podcast_feed' || e instanceof xml.XmlError)
  const bomb = '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]><r>&lol2;</r>'
  assert.throws(() => xml.parseXml(bomb), { code: 'doctype_not_allowed' })
  assert.throws(() => xml.parseXml('<!DOCTYPE r SYSTEM "http://169.254.169.254/x.dtd"><r/>'), { code: 'doctype_not_allowed' })
  assert.throws(() => xml.parseXml('<!DOCTYPE r PUBLIC "-//x//y" "file:///etc/passwd"><r/>'), { code: 'doctype_not_allowed' })
  // a bare doctype is harmless
  assert.equal(xml.parseXml('<!DOCTYPE rss><rss>hi</rss>').text, 'hi')
  // only predefined + numeric entities are decoded; an unknown name stays literal, not expanded
  assert.equal(xml.parseXml('<r>&amp;&lt;&#65;&#x42;&unknown;&#0;</r>').text, '&<AB&unknown;' + String.fromCharCode(0xfffd))
})

test('XML reader limits: size, elements, depth, attributes; and it copes with sloppy feeds', () => {
  assert.throws(() => xml.parseXml('<r>' + 'x'.repeat(200) + '</r>', { maxBytes: 100 }), { code: 'too_large' })
  assert.throws(() => xml.parseXml('<r>' + '<i/>'.repeat(50) + '</r>', { maxElements: 10 }), { code: 'too_many_elements' })
  assert.throws(() => xml.parseXml('<a>'.repeat(100) + '</a>'.repeat(100), { maxDepth: 20 }), { code: 'too_deep' })
  const attrs = Array.from({ length: 100 }, (_, i) => `a${i}="1"`).join(' ')
  assert.throws(() => xml.parseXml(`<r ${attrs}/>`), { code: 'too_many_attributes' })
  assert.throws(() => xml.parseXml('<r><!-- never closed'), { code: 'unterminated_comment' })
  assert.throws(() => xml.parseXml(''), { code: 'no_root_element' })
  // a stray end tag and unclosed elements are tolerated
  const t = xml.parseXml('<r><a>1</b><c>2</r>')
  assert.equal(t.children[0].text, '1')
  assert.equal(xml.kid(xml.kid(t, 'a'), 'c').text, '2')
  // attributes with > inside quotes
  assert.equal(xml.parseXml('<r a="x>y"/>').attrs.a, 'x>y')
  // encodings: declared latin-1 and UTF-16 with a BOM
  const latin = Buffer.concat([Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><r>caf'), Buffer.from([0xe9]), Buffer.from('</r>')])
  assert.equal(xml.parseXml(latin).text, 'café')
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<r>hi</r>', 'utf16le')])
  assert.equal(xml.parseXml(utf16).text, 'hi')
})

test('a hostile feed is not a podcast; an Atom feed with enclosures is', () => {
  assert.throws(() => feedLib.parseFeed(Buffer.from('<html><body>Not a feed</body></html>')), { code: 'not_a_podcast_feed' })
  assert.throws(() => feedLib.parseFeed(Buffer.from('<rss version="2.0"></rss>')), { code: 'not_a_podcast_feed' })
  const { show, episodes } = feedLib.parseFeed(fx('feed-atom.xml'))
  assert.equal(show.title, 'Atom Cast')
  assert.equal(show.author, 'Atom Author')
  assert.equal(episodes.length, 1)
  assert.equal(episodes[0].audioUrl, 'https://cdn.example.test/atom1.mp3')
  assert.equal(episodes[0].link, 'https://example.test/atom/1')
  assert.equal(episodes[0].sizeBytes, 5000)
  assert.equal(episodes[0].notesHtml, 'Summary <b>text</b>')
})

test('a feed with thousands of items keeps only the newest 500', () => {
  const items = Array.from({ length: 1500 }, (_, i) => `<item><title>E${i}</title><guid>g${i}</guid><pubDate>${new Date(Date.UTC(2020, 0, 1) + i * 86400000).toUTCString()}</pubDate><enclosure url="https://cdn.example.test/${i}.mp3" type="audio/mpeg"/></item>`).join('')
  const { episodes } = feedLib.parseFeed(`<rss><channel><title>Big</title>${items}</channel></rss>`)
  assert.equal(episodes.length, 500)
  assert.equal(episodes[0].title, 'E1499')
})

test('durations: HH:MM:SS, MM:SS, seconds, junk', () => {
  const d = feedLib.parseDuration
  assert.equal(d('1:02:03'), 3723)
  assert.equal(d('62:03'), 3723)
  assert.equal(d('3723'), 3723)
  assert.equal(d('00:00:10.6'), 11)
  for (const bad of ['', 'abc', '1:2:3:4', '-5', '1e9', null, undefined]) assert.equal(d(bad), 0, String(bad))
  assert.equal(d('99999999'), 48 * 3600, 'absurd values are capped')
})

test('feed addresses: one show has one id however the address was typed; only plain web addresses', () => {
  const n = feedLib.normalizeFeedUrl
  assert.equal(n('HTTPS://Example.TEST/feed.xml#top'), 'https://example.test/feed.xml')
  assert.equal(n('https://example.test'), 'https://example.test/')
  assert.equal(feedLib.feedIdFor('https://Example.test/feed.xml'), feedLib.feedIdFor('https://example.test/feed.xml#x'))
  for (const bad of ['', 'javascript:alert(1)', 'file:///etc/passwd', 'ftp://x.test/a', 'https://u:p@example.test/a', 'not a url', 'data:text/plain,hi']) assert.equal(n(bad), '', bad)
})

test('OPML import reads nested outlines, drops bad and duplicate addresses; export round-trips', () => {
  const list = feedLib.parseOpml(fx('subscriptions.opml'))
  assert.deepEqual(list.map((x) => x.xmlUrl), ['https://example.test/feed.xml', 'https://example.test/atom.xml'])
  assert.equal(list[0].title, 'The Example Show')
  assert.equal(list[0].htmlUrl, 'https://example.test/show')
  assert.throws(() => feedLib.parseOpml(Buffer.from('<rss><channel/></rss>')), { code: 'not_opml' })
  assert.throws(() => feedLib.parseOpml(Buffer.from('<!DOCTYPE opml [<!ENTITY x "y">]><opml><body/></opml>')), { code: 'doctype_not_allowed' })
  const out = feedLib.buildOpml([{ title: 'A & B "quoted" <x>', url: 'https://example.test/a?x=1&y=2', link: 'https://example.test/' }], { now: new Date(0) })
  assert.match(out, /^<\?xml version="1\.0" encoding="UTF-8"\?>/)
  assert.match(out, /A &amp; B &quot;quoted&quot; &lt;x&gt;/)
  const back = feedLib.parseOpml(Buffer.from(out))
  assert.deepEqual(back.map((x) => [x.title, x.xmlUrl]), [['A & B "quoted" <x>', 'https://example.test/a?x=1&y=2']])
})

test('Podcasting 2.0 chapters JSON: sorted, validated, hidden ones flagged, bad urls dropped', () => {
  const list = feedLib.parseChaptersJson(fx('chapters.json'))
  assert.deepEqual(list.map((c) => c.title), ['Intro', 'Hidden ad break', 'Second', 'Bad urls'])
  assert.equal(list[0].end, 60)
  assert.equal(list[1].hidden, true)
  assert.equal(list[2].start, 605.5)
  assert.equal(list[2].img, 'https://example.test/c2.jpg')
  assert.equal(list[3].img, '')
  assert.equal(list[3].url, '')
  assert.deepEqual(feedLib.parseChaptersJson(Buffer.from('not json')), [])
  assert.deepEqual(feedLib.parseChaptersJson(Buffer.from('{"chapters":"nope"}')), [])
})

test('Podlove inline chapters in the feed are read too', () => {
  const rss = `<rss xmlns:psc="http://podlove.org/simple-chapters"><channel><title>P</title><item><title>E</title><guid>g</guid>
    <enclosure url="https://cdn.example.test/a.mp3" type="audio/mpeg"/>
    <psc:chapters><psc:chapter start="00:01:30.000" title="Later"/><psc:chapter start="00:00:00" title="Start"/></psc:chapters></item></channel></rss>`
  const { episodes } = feedLib.parseFeed(rss)
  assert.deepEqual(episodes[0].chapters.map((c) => [c.start, c.title]), [[0, 'Start'], [90, 'Later']])
})

test('iTunes Search results: only shows with a real feed address, artwork and names kept', () => {
  const list = feedLib.parseItunesSearch(JSON.parse(fx('itunes-search.json')))
  assert.deepEqual(list.map((x) => x.feedUrl), ['https://example.test/feed.xml', 'http://example.test/other.rss'])
  assert.equal(list[0].artwork, 'https://is1.example.test/600.jpg')
  assert.equal(list[0].episodeCount, 120)
  assert.equal(list[1].title, 'Track name fallback')
  assert.deepEqual(feedLib.parseItunesSearch(null), [])
  assert.deepEqual(feedLib.parseItunesSearch({ results: 'x' }), [])
})

// ---- ID3 chapters: a tag built here, byte by byte ----

const synch = (n) => Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f])
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b }
function frame(id, data, major) {
  const size = major === 4 ? synch(data.length) : u32(data.length)
  return Buffer.concat([Buffer.from(id, 'latin1'), size, Buffer.from([0, 0]), data])
}
const textFrame = (id, text, major) => frame(id, Buffer.concat([Buffer.from([3]), Buffer.from(text, 'utf8')]), major)
function chap(elementId, startMs, endMs, title, url, major) {
  const subs = [textFrame('TIT2', title, major)]
  if (url) subs.push(frame('WXXX', Buffer.concat([Buffer.from([0]), Buffer.from('\0'), Buffer.from(url, 'latin1')]), major))
  return frame('CHAP', Buffer.concat([Buffer.from(elementId + '\0', 'latin1'), u32(startMs), u32(endMs), u32(0xffffffff), u32(0xffffffff), ...subs]), major)
}
function tag(major, frames, { padding = 20 } = {}) {
  const body = Buffer.concat([...frames, Buffer.alloc(padding)])
  return Buffer.concat([Buffer.from('ID3'), Buffer.from([major, 0, 0]), synch(body.length), body, Buffer.from('audio bytes follow')])
}

test('ID3v2.3 and v2.4 CHAP frames: titles, times, links, sorted, and bad input is survivable', () => {
  for (const major of [3, 4]) {
    const buf = tag(major, [
      textFrame('TIT2', 'Episode', major),
      chap('chp1', 65000, 130000, 'Second chapter', 'https://example.test/two', major),
      chap('chp0', 0, 65000, 'First é chapter', '', major)
    ])
    const list = id3.parseId3Chapters(buf)
    assert.deepEqual(list.map((c) => [c.start, c.end, c.title]), [[0, 65, 'First é chapter'], [65, 130, 'Second chapter']], 'v2.' + major)
    assert.equal(list[1].url, 'https://example.test/two')
  }
  assert.deepEqual(id3.parseId3Chapters(Buffer.from('not an id3 tag at all')), [])
  assert.deepEqual(id3.parseId3Chapters(Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x10')), [])
  // a frame that claims to be longer than the tag is where reading stops, not a crash
  const lying = Buffer.concat([Buffer.from('ID3'), Buffer.from([3, 0, 0]), synch(30), Buffer.from('CHAP'), u32(0x7fffffff), Buffer.from([0, 0]), Buffer.alloc(20)])
  assert.deepEqual(id3.parseId3Chapters(lying), [])
})

test('ID3 chapters are read from the start of a file on disk', async () => {
  const os = require('node:os')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-id3-'))
  try {
    const f = path.join(dir, 'ep.mp3')
    fs.writeFileSync(f, tag(3, [chap('a', 1000, 2000, 'Only', '', 3)]))
    assert.deepEqual((await id3.readId3Chapters(f)).map((c) => c.title), ['Only'])
    assert.deepEqual(await id3.readId3Chapters(path.join(dir, 'missing.mp3')), [])
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
