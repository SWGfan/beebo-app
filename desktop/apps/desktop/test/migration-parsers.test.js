// The migration importer's readers, on fixture files: CSV, XML (.nfo), ZIP, and the Kodi, Letterboxd
// and Plex-history adapters. Everything here is untrusted input, so the hostile cases matter as much
// as the good ones. Run: node --test test/migration-parsers.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')
const { parseCsv, parseCsvObjects } = require('../electron/migration/csv')
const { parseXml, XmlError } = require('../electron/migration/xml')
const { readZip, safeEntryName, looksLikeZip } = require('../electron/migration/zip')
const M = require('../electron/migration/model')
const kodi = require('../electron/migration/kodi')
const letterboxd = require('../electron/migration/letterboxd')
const plex = require('../electron/migration/plex')
const fx = require('./helpers/migrationFixtures')

// ---- model --------------------------------------------------------------------------------------
test('model: ids are validated, and a malformed id is dropped rather than guessed', () => {
  assert.deepEqual(M.cleanIds({ tmdb: '603', imdb: 'TT0133093', tvdb: 169 }), { tmdb: '603', imdb: 'tt0133093', tvdb: '169' })
  assert.deepEqual(M.cleanIds({ tmdb: '0', imdb: 'tt12', tvdb: 'abc' }), {})
  assert.deepEqual(M.cleanIds({ tmdb: '12; DROP TABLE', imdb: '../x' }), {})
  assert.deepEqual(M.idsFromGuid('tmdb://603'), { tmdb: '603' })
  assert.deepEqual(M.idsFromGuid('imdb://tt0133093'), { imdb: 'tt0133093' })
  assert.deepEqual(M.idsFromGuid('com.plexapp.agents.imdb://tt0133093?lang=en'), { imdb: 'tt0133093' })
  assert.deepEqual(M.idsFromGuid('https://www.themoviedb.org/movie/603-the-matrix'), { tmdb: '603' })
  assert.deepEqual(M.idsFromGuid('plex://movie/5d776b59ad5437001f79c6f8'), {})
})

test('model: dates, ratings and seconds are bounded', () => {
  assert.equal(M.toMs('2021-03-01'), Date.UTC(2021, 2, 1))
  assert.equal(M.toMs('2022-05-14 21:30:00'), Date.parse('2022-05-14T21:30:00'))
  assert.equal(M.toMs(1682971200), 1682971200000)
  assert.equal(M.toMs(1682971200000), 1682971200000)
  assert.equal(M.toMs('1970-01-01'), 0, 'nothing before 1990 is a real "last watched"')
  assert.equal(M.toMs(Date.now() + 10 * 86400000), 0, 'nor is the far future')
  assert.equal(M.toMs('garbage'), 0)
  assert.equal(M.rating10(4.5, 5), 9)
  assert.equal(M.rating10(0.5, 5), 1)
  assert.equal(M.rating10(7.3), 7.5, 'half steps')
  assert.equal(M.rating10(11), null)
  assert.equal(M.rating10(0), null)
  assert.equal(M.rating10('x'), null)
  assert.equal(M.seconds(-4), null)
  assert.equal(M.seconds(1e9), null)
})

test('model: finishBundle numbers items, drops nameless ones and keeps lists pointing at real items', () => {
  const b = M.finishBundle({
    source: 'plex', users: [{ key: 'a', name: 'A' }, { key: 'a', name: 'dupe' }],
    items: [
      { ref: 'x', type: 'movie', title: 'One', state: { a: { watched: true, rating: 8 } } },
      { type: 'movie', title: '', ids: {} },
      { type: 'nonsense', title: 'Bad' },
      { ref: 'y', type: 'movie', title: 'Two', state: { b: { favorite: true } } }
    ],
    lists: [{ userKey: 'a', name: 'L', refs: ['x', 'missing', 'y'] }, { userKey: 'a', name: 'Empty', refs: ['missing'] }]
  })
  assert.deepEqual(b.items.map((i) => i.ref), ['i0', 'i1'])
  assert.equal(b.users.length, 2, 'a person an item mentions is added, a duplicate is not')
  assert.deepEqual(b.lists, [{ userKey: 'a', name: 'L', refs: ['i0', 'i1'] }])
  assert.match(b.warnings.join(' '), /2 entries had no title or id/)
})

// ---- csv ----------------------------------------------------------------------------------------
test('csv: quotes, doubled quotes, embedded commas and newlines, CRLF and a BOM', () => {
  const { rows } = parseCsv('\uFEFFa,b,c\r\n1,"x, y","say ""hi"""\r\n2,"line1\nline2",\r\n\r\n3,,\r\n')
  assert.deepEqual(rows, [['a', 'b', 'c'], ['1', 'x, y', 'say "hi"'], ['2', 'line1\nline2', ''], ['3', '', '']])
})

test('csv: headers fold case and separators; an unclosed quote is capped, not unbounded', () => {
  const { records } = parseCsvObjects('Watched Date,Letterboxd_URI\n2020-01-01,u\n')
  assert.deepEqual(records, [{ 'watched date': '2020-01-01', 'letterboxd uri': 'u' }])
  const evil = 'a,b\n"' + 'x'.repeat(200000)
  const out = parseCsv(evil)
  assert.ok(out.rows.every((r) => r.every((c) => c.length <= 20001)))
  const big = parseCsv('h\n' + 'row\n'.repeat(50), { maxRows: 10 })
  assert.equal(big.rows.length, 10)
  assert.equal(big.truncated, true)
})

// ---- xml ----------------------------------------------------------------------------------------
test('xml: reads a normal .nfo, decodes the five entities and numeric references, keeps CDATA', () => {
  const root = parseXml('<?xml version="1.0"?><!-- c --><movie a="1 &amp; 2"><title>A &amp; B &#233; &#x41;</title><plot><![CDATA[<b>raw</b>]]></plot><e/></movie>')
  assert.equal(root.name, 'movie')
  assert.equal(root.attrs.a, '1 & 2')
  assert.equal(root.children[0].text, 'A & B é A')
  assert.equal(root.children[1].text, '<b>raw</b>')
})

test('xml: a DOCTYPE / ENTITY document is refused outright (billion laughs and XXE)', () => {
  for (const f of ['billion-laughs.nfo', 'xxe.nfo']) {
    assert.throws(() => parseXml(fx.fixtureText('kodi', 'movies', 'hostile', f)), (e) => e instanceof XmlError && e.code === 'doctype_refused', f)
  }
})

test('xml: size, depth and node caps hold, and malformed input is an error, not a crash', () => {
  assert.throws(() => parseXml('<a>' + 'x'.repeat(3 * 1024 * 1024) + '</a>'), (e) => e.code === 'too_big')
  assert.throws(() => parseXml('<a>'.repeat(60) + '</a>'.repeat(60)), (e) => e.code === 'too_deep')
  assert.throws(() => parseXml('<a>' + '<b/>'.repeat(70000) + '</a>'), (e) => e.code === 'too_many_nodes')
  for (const bad of ['', '<a>', '<a></b>', '<a b=1/>', 'not xml', '<a><![CDATA[x</a>', '<a><!-- x</a>']) {
    assert.throws(() => parseXml(bad), XmlError, JSON.stringify(bad))
  }
  assert.equal(parseXml('<a>&unknown; &#0; &#xD800;</a>').text, '&unknown;', 'unknown entities stay text, invalid references vanish')
})

// ---- zip ----------------------------------------------------------------------------------------
test('zip: reads stored and deflated entries and checks their CRC', () => {
  const zip = fx.makeZip([{ name: 'a.csv', data: 'hello' }, { name: 'dir/b.csv', data: 'x'.repeat(1000), method: 0 }])
  assert.ok(looksLikeZip(zip))
  const { entries, skipped } = readZip(zip)
  assert.deepEqual(entries.map((e) => e.name), ['a.csv', 'dir/b.csv'])
  assert.equal(entries[0].data.toString(), 'hello')
  assert.equal(skipped.length, 0)
  const bad = readZip(fx.makeZip([{ name: 'a.csv', data: 'hello', crc: 1234 }]))
  assert.deepEqual(bad.skipped, [{ name: 'a.csv', reason: 'bad_crc' }])
})

test('zip: names that could escape a folder are skipped and never returned (zip-slip)', () => {
  for (const n of ['../evil.csv', 'a/../../evil.csv', '/etc/passwd', 'C:\\Windows\\x.csv', '..\\..\\x.csv', 'ok\0.csv']) assert.equal(safeEntryName(n), null, n)
  assert.equal(safeEntryName('lists\\a.csv'), 'lists/a.csv')
  assert.equal(safeEntryName('./x/./y.csv'), 'x/y.csv')
  const zip = fx.makeZip([{ name: '../../evil.csv', data: 'x' }, { name: 'C:\\evil2.csv', data: 'x' }, { name: 'fine.csv', data: 'y' }])
  const { entries, skipped } = readZip(zip)
  assert.deepEqual(entries.map((e) => e.name), ['fine.csv'])
  assert.deepEqual(skipped.map((s) => s.reason), ['unsafe_path', 'unsafe_path'])
})

test('zip: a zip bomb, a lying size header, encrypted and unsupported entries are refused', () => {
  const bomb = fx.makeZip([{ name: 'big.csv', data: Buffer.alloc(3 * 1024 * 1024, 65) }])
  assert.deepEqual(readZip(bomb, { maxEntryBytes: 1024 * 1024 }).skipped.map((s) => s.reason), ['too_big'], 'over the per-entry cap by its declared size')
  assert.deepEqual(readZip(bomb, { maxEntryBytes: 4 * 1024 * 1024 }).skipped.map((s) => s.reason), ['suspicious_ratio'], 'under the cap but compressed far too well')
  // The header says 10 bytes; the data inflates to far more.
  const liar = fx.makeZip([{ name: 'l.csv', data: Buffer.alloc(2 * 1024 * 1024, 66), lieAboutSize: 10 }])
  assert.equal(readZip(liar, { maxEntryBytes: 1024 * 1024 }).entries.length, 0)
  assert.equal(readZip(fx.makeZip([{ name: 'e.csv', data: 'x', flags: 1 }])).skipped[0].reason, 'encrypted')
  assert.throws(() => readZip(Buffer.from('not a zip at all, just text')), (e) => e.code === 'not_a_zip')
  assert.throws(() => readZip(Buffer.concat([fx.makeZip([{ name: 'a', data: 'b' }]).slice(0, 30), Buffer.alloc(40)])), (e) => e.code === 'not_a_zip' || e.code === 'corrupt')
  const many = fx.makeZip(Array.from({ length: 30 }, (_, i) => ({ name: 'f' + i + '.csv', data: 'x' })))
  assert.throws(() => readZip(many, { maxEntries: 10 }), (e) => e.code === 'too_many_entries')
  const total = fx.makeZip([{ name: 'a.csv', data: Buffer.alloc(600, 1) }, { name: 'b.csv', data: Buffer.alloc(600, 2) }])
  const t = readZip(total, { maxTotalBytes: 1000 })
  assert.equal(t.entries.length, 1)
  assert.equal(t.skipped[0].reason, 'total_too_big')
  const nameBomb = fx.makeZip([{ name: 'x'.repeat(500) + '.csv', data: 'x' }])
  assert.equal(readZip(nameBomb).entries.length, 0)
})

test('zip: only entries the caller asks for are inflated at all', () => {
  const zip = fx.makeZip([{ name: 'keep.csv', data: 'k' }, { name: 'skip.bin', data: Buffer.alloc(1000) }])
  const { entries, skipped } = readZip(zip, { wanted: (n) => n.endsWith('.csv') })
  assert.deepEqual(entries.map((e) => e.name), ['keep.csv'])
  assert.equal(skipped.length, 0)
  assert.ok(zlib.inflateRawSync)
})

// ---- kodi ---------------------------------------------------------------------------------------
test('kodi: a movie .nfo gives ids, own state, rating and details; artwork is only ever safe text', () => {
  const r = kodi.parseNfoText(fx.fixtureText('kodi', 'movies', 'The Matrix (1999)', 'movie.nfo'), { fileName: 'movie.nfo' })
  assert.equal(r.items.length, 1)
  const it = r.items[0]
  assert.equal(it.type, 'movie')
  assert.equal(it.title, 'The Matrix')
  assert.equal(it.year, 1999)
  assert.deepEqual(it.ids, { imdb: 'tt0133093', tmdb: '603' })
  const st = it.state.kodi
  assert.equal(st.watched, true)
  assert.equal(st.playCount, 2)
  assert.equal(st.rating, 9, 'the person\u2019s own <userrating>')
  assert.equal(st.lastPlayedAt, Date.parse('2022-05-14T21:30:00'))
  assert.equal(it.meta.plot.startsWith('A computer hacker learns'), true)
  assert.match(it.meta.plot, /reality & his role/, 'entities decoded')
  assert.deepEqual(it.meta.ratings.map((x) => [x.name, x.value]), [['imdb', 8.7], ['themoviedb', 8.2]], 'crowd scores stay in the details, not the person\u2019s rating')
  assert.deepEqual(it.meta.actors.map((a) => [a.name, a.role]), [['Keanu Reeves', 'Neo'], ['Carrie-Anne Moss', 'Trinity']])
  assert.equal(it.meta.actors[1].thumb, null, 'a path that climbs out of the folder is dropped')
  assert.equal(it.meta.artwork.poster, 'https://image.tmdb.org/t/p/original/poster.jpg')
  assert.equal(it.meta.artwork.banner, 'banner.jpg')
  assert.equal(it.meta.artwork.fanart, 'https://image.tmdb.org/t/p/original/fanart.jpg')
  assert.deepEqual(it.meta.genres, ['Action', 'Science Fiction'])
  assert.equal(it.meta.collection, 'The Matrix Collection')
})

test('kodi: artwork values are urls or relative paths only', () => {
  const ok = ['https://x.test/a.jpg', 'art/a.jpg', 'a.jpg', './b/c.png']
  const bad = ['/etc/passwd', 'C:\\x\\a.jpg', '..\\..\\a.jpg', 'a/../../b.jpg', 'file:///etc/passwd', 'smb://host/share/a.jpg', 'javascript:alert(1)', 'special://home/a.jpg', '']
  for (const v of ok) assert.ok(kodi.cleanArtwork(v), v)
  for (const v of bad) assert.equal(kodi.cleanArtwork(v), null, v)
  const heat = kodi.parseNfoText(fx.fixtureText('kodi', 'movies', 'Heat (1995)', 'movie.nfo')).items[0]
  assert.deepEqual(heat.meta.artwork, { landscape: 'art/heat-landscape.jpg' })
})

test('kodi: legacy <id>, a resume point, and no watched flag when nothing was played', () => {
  const heat = kodi.parseNfoText(fx.fixtureText('kodi', 'movies', 'Heat (1995)', 'movie.nfo')).items[0]
  assert.deepEqual(heat.ids, { imdb: 'tt0113277' })
  assert.equal(heat.state.kodi.watched, undefined)
  assert.equal(heat.state.kodi.resumeSeconds, 2712.5)
  assert.equal(heat.state.kodi.durationSeconds, 10200)
})

test('kodi: an .nfo that is only an address gives an id and nothing else', () => {
  const r = kodi.parseNfoText(fx.fixtureText('kodi', 'movies', 'Url Only (2001)', 'movie.nfo'), { fileName: 'Url Only (2001).nfo' })
  assert.equal(r.urlOnly, true)
  assert.deepEqual(r.items[0].ids, { tmdb: '1234' })
  assert.equal(r.items[0].title, 'Url Only (2001)')
  assert.deepEqual(kodi.parseNfoText('just some words').error, 'not_nfo')
  assert.equal(kodi.parseNfoText('   ').error, 'empty')
})

test('kodi: hostile documents are refused with a reason, not read', () => {
  for (const f of ['billion-laughs.nfo', 'xxe.nfo']) assert.equal(kodi.parseNfoText(fx.fixtureText('kodi', 'movies', 'hostile', f)).error, 'doctype_refused', f)
  assert.equal(kodi.parseNfoText('<movie><title>x</movie>').error, 'malformed')
  assert.equal(kodi.parseNfoText('<other><title>x</title></other>').error, 'not_nfo')
})

test('kodi: an episode takes its show from the show .nfo; its own ids are the episode\u2019s, not the show\u2019s', () => {
  const show = kodi.parseNfoText(fx.fixtureText('kodi', 'tv', 'Severance', 'tvshow.nfo')).items[0]
  assert.equal(show.type, 'show')
  assert.deepEqual(show.ids, { tvdb: '371980', imdb: 'tt11280740', tmdb: '95396' })
  const ep = kodi.parseNfoText(fx.fixtureText('kodi', 'tv', 'Severance', 'Season 1', 'Severance S01E01.nfo'), { showFor: () => ({ title: show.title, year: show.year, ids: show.ids }) }).items[0]
  assert.equal(ep.type, 'episode')
  assert.equal(ep.season, 1)
  assert.equal(ep.episode, 1)
  assert.deepEqual(ep.show, { title: 'Severance', year: 2022, ids: { tvdb: '371980', imdb: 'tt11280740', tmdb: '95396' } })
  assert.deepEqual(ep.ids, {})
  assert.equal(ep.state.kodi.rating, 8)
  assert.equal(kodi.parseNfoText('<episodedetails><season>1</season><episode>2</episode></episodedetails>').items, undefined, 'an episode with no show is unusable')
})

test('kodi: a videodb.xml export yields movies, shows and their episodes', () => {
  const r = kodi.parseNfoText(fx.fixtureText('kodi', 'videodb.xml'), { fileName: 'videodb.xml', big: true })
  assert.deepEqual(r.items.map((i) => i.type + ':' + i.title), ['movie:Alien', 'show:Chernobyl', 'episode:1:23:45'])
  assert.equal(r.items[2].show.title, 'Chernobyl')
  assert.deepEqual(r.items[2].show.ids, { tvdb: '360893' })
})

test('kodi: reading a folder finds every .nfo, inherits the show, and refuses the hostile ones', async () => {
  const read = await kodi.readFolder(fx.fixturePath('kodi'))
  const titles = read.items.map((i) => i.type + ':' + i.title).sort()
  assert.ok(titles.includes('movie:The Matrix'))
  assert.ok(titles.includes('movie:Heat'))
  assert.ok(titles.includes('show:Severance'))
  assert.ok(titles.includes('movie:Alien'), 'the videodb.xml in the same folder')
  assert.equal(read.items.filter((i) => i.type === 'episode' && i.show.title === 'Severance').length, 2)
  assert.equal(read.skipped.refused, 2, 'the two hostile files')
  assert.match(read.warnings.join(' '), /refused for safety/)
  assert.ok(!read.items.some((i) => /lol/.test(i.title)))
  await assert.rejects(() => kodi.readFolder(path.join(fx.fixturePath('kodi'), 'no-such-folder')), /folder_not_found/)
})

test('kodi: a folder walk does not follow links out of the folder', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-kodi-link-'))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-kodi-out-'))
  try {
    fs.writeFileSync(path.join(outside, 'secret.nfo'), '<movie><title>Outside</title></movie>')
    fs.writeFileSync(path.join(root, 'a.nfo'), '<movie><title>Inside</title></movie>')
    try { fs.symlinkSync(outside, path.join(root, 'link'), 'junction') } catch { return t.skip('cannot create links here') }
    const read = await kodi.readFolder(root)
    assert.deepEqual(read.items.map((i) => i.title), ['Inside'])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  }
})

test('kodi: uploaded files are read the same way, tvshow.nfo first', () => {
  const files = [
    { name: 'Severance S01E01.nfo', text: fx.fixtureText('kodi', 'tv', 'Severance', 'Season 1', 'Severance S01E01.nfo') },
    { name: 'tvshow.nfo', text: fx.fixtureText('kodi', 'tv', 'Severance', 'tvshow.nfo') },
    { name: 'evil.nfo', text: fx.fixtureText('kodi', 'movies', 'hostile', 'xxe.nfo') }
  ]
  const r = kodi.readFiles(files)
  assert.equal(r.items.length, 2)
  assert.equal(r.items.find((i) => i.type === 'episode').show.ids.tvdb, '371980')
  assert.equal(r.skipped.refused, 1)
  const b = kodi.bundleOf(r)
  assert.equal(b.source, 'kodi')
  assert.deepEqual(b.users, [{ key: 'kodi', name: 'Kodi' }])
})

// ---- letterboxd ---------------------------------------------------------------------------------
test('letterboxd: the export zip gives watched, diary, ratings, likes, watchlist and lists', () => {
  const b = letterboxd.parseExport([{ name: 'letterboxd-nick-2024.zip', data: fx.letterboxdZip() }])
  assert.equal(b.source, 'letterboxd')
  const byTitle = (t, y) => b.items.find((i) => i.title === t && i.year === y)
  const matrix = byTitle('The Matrix', 1999).state.letterboxd
  assert.equal(matrix.watched, true)
  assert.equal(matrix.rating, 9, 'ratings.csv (4.5 stars) wins as the latest value in file order: 4.5 -> 9')
  assert.equal(matrix.favorite, true, 'a like is a favourite')
  assert.equal(matrix.playCount, 2, 'two diary entries')
  assert.equal(matrix.lastPlayedAt, Date.UTC(2022, 4, 14), 'the newest Watched Date')
  const heat = byTitle('Heat', 1995).state.letterboxd
  assert.equal(heat.rating, 10)
  assert.equal(heat.watchlist, undefined, 'a watched film is not also on the watchlist')
  const alien = byTitle('Alien', 1979).state.letterboxd
  assert.equal(alien.watchlist, true)
  assert.equal(alien.watched, undefined)
  assert.equal(byTitle('Amélie', 2001).state.letterboxd.rating, 1, 'half a star is 1 out of 10')
  assert.ok(byTitle('Some Obscure Film, The: A "Story"', 2011), 'quotes and commas in a title')
  assert.equal(b.items.filter((i) => i.title === 'Dune').length, 2, 'same title, different years, two films')
  assert.deepEqual(b.lists.map((l) => [l.name, l.refs.length]), [['Road Trip Night', 3]])
  const order = b.lists[0].refs.map((r) => b.items.find((i) => i.ref === r).title)
  assert.deepEqual(order, ['Heat', 'The Matrix', 'Alien'], 'list order is kept')
})

test('letterboxd: loose csv files work, and unknown files are reported', () => {
  const b = letterboxd.parseExport([
    { name: 'watched.csv', text: fx.fixtureText('letterboxd', 'watched.csv') },
    { name: 'whatever.csv', text: 'a,b\n1,2\n' }
  ])
  assert.equal(b.items.length, 7)
  assert.match(b.warnings.join(' '), /was not recognised/)
  const none = letterboxd.parseExport([{ name: 'x.txt', text: 'hello' }])
  assert.equal(none.items.length, 0)
  assert.match(none.warnings.join(' '), /No films were found/)
})

test('letterboxd: a hostile zip cannot write anywhere and is reported', () => {
  const zip = fx.makeZip([{ name: '../../watched.csv', data: 'Date,Name,Year\n2020-01-01,Evil,2000\n' }, { name: 'watched.csv', data: 'Date,Name,Year\n2020-01-01,Fine,2001\n' }])
  const b = letterboxd.parseExport([{ name: 'x.zip', data: zip }])
  assert.deepEqual(b.items.map((i) => i.title), ['Fine'])
  assert.match(b.warnings.join(' '), /unsafe path/)
  const junk = letterboxd.parseExport([{ name: 'x.zip', data: Buffer.from('PK\x03\x04garbage') }])
  assert.match(junk.warnings.join(' '), /not a readable zip/)
})

// ---- plex history csv ---------------------------------------------------------------------------
test('plex csv: a Tautulli export merges plays per person and item, with resume and ids', () => {
  const b = plex.parseHistoryCsv(fx.fixtureText('plex', 'tautulli-history.csv'))
  assert.deepEqual(b.users.map((u) => u.key).sort(), ['nick', 'sam'])
  const matrix = b.items.find((i) => i.title === 'The Matrix')
  assert.deepEqual(matrix.ids, { imdb: 'tt0133093' })
  assert.equal(matrix.state.nick.watched, true)
  assert.equal(matrix.state.nick.playCount, 2, 'two rows = two plays')
  assert.equal(matrix.state.nick.lastPlayedAt, Date.UTC(2023, 4, 8))
  const heat = b.items.find((i) => i.title === 'Heat')
  assert.equal(heat.state.nick.watched, undefined)
  assert.equal(heat.state.nick.resumeSeconds, 2713, 'whole seconds')
  assert.equal(heat.state.nick.durationSeconds, 10200)
  const ep = b.items.find((i) => i.type === 'episode' && i.episode === 1)
  assert.deepEqual([ep.show.title, ep.season, ep.episode], ['Severance', 1, 1])
  const half = b.items.find((i) => i.type === 'episode' && i.episode === 2)
  assert.equal(half.state.sam.resumeSeconds, 601)
  const alien = b.items.find((i) => i.title === 'Alien')
  assert.deepEqual(alien.ids, { tmdb: '348' })
  assert.equal(alien.state.sam.watched, true)
})

test('plex csv: a plain spreadsheet with rating and watchlist columns', () => {
  const b = plex.parseHistoryCsv(fx.fixtureText('plex', 'simple-history.csv'))
  assert.equal(b.items.length, 3)
  const by = (t) => b.items.find((i) => i.title === t).state.plex
  assert.deepEqual(by('The Matrix'), { watched: true, playCount: 1, lastPlayedAt: Date.UTC(2023, 4, 1), rating: 9 })
  assert.deepEqual(by('Heat'), { rating: 7.5 })
  assert.deepEqual(by('Alien'), { watchlist: true })
  const empty = plex.parseHistoryCsv('foo,bar\n1,2\n')
  assert.equal(empty.items.length, 0)
  assert.match(empty.warnings.join(' '), /No rows with a title or id/)
})
