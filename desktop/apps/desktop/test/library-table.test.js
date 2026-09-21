// The Movies / TV Shows Table view's pure logic: how values are written (libraryFormat), which
// rows are on screen (virtualRows), and the columns, sorting and CSV (libraryColumns).
// Run: node --test test/library-table.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const lib = (f) => import(pathToFileURL(path.resolve(__dirname, '..', 'src', 'lib', f)).href)

// ---------------------------------------------------------------- formatters

test('sizes read like Windows Explorer, and sort by bytes elsewhere', async () => {
  const { formatBytes: b } = await lib('libraryFormat.js')
  assert.equal(b(0), '0 B')
  assert.equal(b(512), '512 B')
  assert.equal(b(2048), '2 KB')
  assert.equal(b(5 * 1024 * 1024), '5.0 MB')
  assert.equal(b(2.5 * 1024 ** 3), '2.50 GB')
  assert.equal(b(3 * 1024 ** 4), '3.00 TB')
  assert.equal(b(null), '')
  assert.equal(b(-1), '')
  assert.equal(b(NaN), '')
})

test('runtime is h:mm rounded to the minute', async () => {
  const { formatRuntime: r } = await lib('libraryFormat.js')
  assert.equal(r(7620), '2:07')
  assert.equal(r(2700), '0:45')
  assert.equal(r(3600), '1:00')
  assert.equal(r(3629), '1:00')
  assert.equal(r(3631), '1:01')
  assert.equal(r(36000), '10:00')
  assert.equal(r(0), '')
  assert.equal(r(null), '')
})

test('bitrate, frame rate, rating, channels and codecs', async () => {
  const f = await lib('libraryFormat.js')
  assert.equal(f.formatBitrate(8400), '8.4 Mb/s')
  assert.equal(f.formatBitrate(640), '640 kb/s')
  assert.equal(f.formatBitrate(0), '')
  assert.equal(f.formatFps(23.976), '23.976')
  assert.equal(f.formatFps(24), '24')
  assert.equal(f.formatFps(29.97), '29.97')
  assert.equal(f.formatRating(7.8449), '7.8')
  assert.equal(f.formatRating(0), '')
  assert.equal(f.formatChannels(6, '5.1(side)'), '5.1')
  assert.equal(f.formatChannels(8, '7.1'), '7.1')
  assert.equal(f.formatChannels(2, 'stereo'), 'Stereo')
  assert.equal(f.formatChannels(1, null), 'Mono')
  assert.equal(f.formatChannels(6, null), '5.1')
  assert.equal(f.formatChannels(3, null), '3ch')
  assert.equal(f.formatChannels(null, null), '')
  assert.equal(f.formatAudio('ac3', null, 6, '5.1(side)'), 'AC-3 5.1')
  assert.equal(f.formatAudio('dts', 'DTS-HD MA', 8, '7.1'), 'DTS-HD MA 7.1')
  assert.equal(f.formatAudio('eac3', null, 6, null), 'E-AC-3 5.1')
  assert.equal(f.formatAudio('aac', 'LC', 2, 'stereo'), 'AAC Stereo')
  assert.equal(f.formatVideoCodec('h264'), 'H.264')
  assert.equal(f.formatVideoCodec('hevc'), 'HEVC')
  assert.equal(f.formatVideoCodec('somethingnew'), 'SOMETHINGNEW')
  assert.equal(f.formatVideoCodec(null), '')
  assert.equal(f.formatContainer('.mkv'), 'MKV')
})

test('lists collapse past four and drop blanks', async () => {
  const { formatList: l } = await lib('libraryFormat.js')
  assert.equal(l(['English', 'French']), 'English, French')
  assert.equal(l(['a', '', 'b', null]), 'a, b')
  assert.equal(l(['a', 'b', 'c', 'd', 'e', 'f']), 'a, b, c, d +2')
  assert.equal(l([]), '')
  assert.equal(l(undefined), '')
})

// ---------------------------------------------------------------- windowing

test('only the rows on screen (plus overscan) are rendered, however long the list', async () => {
  const { computeWindow: w } = await lib('virtualRows.js')
  const a = w({ count: 100000, rowHeight: 34, scrollTop: 0, viewportHeight: 600, overscan: 6 })
  assert.equal(a.start, 0)
  assert.equal(a.firstVisible, 0)
  assert.equal(a.lastVisible, 17)
  assert.equal(a.end, 24)
  assert.equal(a.offset, 0)
  const b = w({ count: 100000, rowHeight: 34, scrollTop: 34 * 5000 + 10, viewportHeight: 600, overscan: 6 })
  assert.equal(b.firstVisible, 5000)
  assert.equal(b.start, 4994)
  assert.equal(b.offset, 4994 * 34)
  assert.ok(b.end - b.start <= 32)
})

test('the window is clamped at both ends and safe for empty or odd input', async () => {
  const { computeWindow: w } = await lib('virtualRows.js')
  const end = w({ count: 100, rowHeight: 34, scrollTop: 1e9, viewportHeight: 600, overscan: 6 })
  assert.equal(end.lastVisible, 99)
  assert.equal(end.end, 100)
  assert.equal(w({ count: 100, rowHeight: 34, scrollTop: -500, viewportHeight: 600 }).start, 0)
  assert.deepEqual(w({ count: 0, rowHeight: 34, scrollTop: 0, viewportHeight: 600 }), { start: 0, end: 0, offset: 0, firstVisible: 0, lastVisible: -1 })
  assert.equal(w({ count: 5, rowHeight: 34, scrollTop: 0, viewportHeight: 600 }).end, 5, 'a short list shows all of it')
  assert.equal(w({ count: 10, rowHeight: 0, scrollTop: 0, viewportHeight: 600 }).end, 0)
  assert.equal(w({ count: 10, rowHeight: 34, scrollTop: NaN, viewportHeight: 100 }).start, 0)
})

test('every row appears exactly once as a scrolling list is walked', async () => {
  const { computeWindow: w } = await lib('virtualRows.js')
  const seen = new Set()
  for (let top = 0; top < 1000 * 34; top += 17) {
    const win = w({ count: 1000, rowHeight: 34, scrollTop: top, viewportHeight: 500, overscan: 2 })
    for (let i = win.firstVisible; i <= win.lastVisible; i++) seen.add(i)
  }
  assert.equal(seen.size, 1000)
})

test('keyboard reveal moves the least, and a jump lands on the row without over-scrolling', async () => {
  const v = await lib('virtualRows.js')
  assert.equal(v.scrollTopToReveal({ index: 5, rowHeight: 34, scrollTop: 0, viewportHeight: 340 }), 0, 'already in view')
  assert.equal(v.scrollTopToReveal({ index: 10, rowHeight: 34, scrollTop: 0, viewportHeight: 340 }), 34, 'just below: scroll down one row')
  assert.equal(v.scrollTopToReveal({ index: 2, rowHeight: 34, scrollTop: 340, viewportHeight: 340 }), 68, 'above: scroll up to it')
  assert.equal(v.scrollTopForIndex({ index: 50, count: 1000, rowHeight: 34, viewportHeight: 340 }), 1700)
  assert.equal(v.scrollTopForIndex({ index: 999, count: 1000, rowHeight: 34, viewportHeight: 340 }), 1000 * 34 - 340, 'the end of the list is clamped')
  assert.equal(v.moveIndex(-1, 1, 10), 0)
  assert.equal(v.moveIndex(0, -1, 10), 0)
  assert.equal(v.moveIndex(9, 1, 10), 9)
  assert.equal(v.moveIndex(3, 5, 10), 8)
  assert.equal(v.moveIndex(3, 50, 10), 9)
  assert.equal(v.moveIndex(0, 1, 0), -1)
})

// ---------------------------------------------------------------- rows and columns

const MOVIE_GENRES = { 28: 'Action', 878: 'Science Fiction' }
const movieFile = (name, over = {}) => ({ name, fileName: `${name}.mkv`, ext: '.mkv', path: `D:\\Movies\\${name}.mkv`, size: 1024 ** 3, mtimeMs: 1700000000000, ...over })
let cols
const movie = (name, meta, over = {}, opts = {}) => cols.buildMovieRow(movieFile(name, over), meta, { genreNames: MOVIE_GENRES, ...opts })
const probedInfo = (over = {}) => ({ probed: true, size: 1, mtimeMs: 1, birthMs: 1, width: 1920, height: 800, videoCodec: 'hevc', hdr: 'HDR10', fps: 23.976, totalKbps: 8400, durationSec: 7620, audio: [{ codec: 'eac3', channels: 6, layout: '5.1(side)', isDefault: true }], audioLangs: ['English', 'French'], subLangs: ['English'], ...over })

test.before(async () => { cols = await lib('libraryColumns.js') })

test('a movie row carries the TMDB details and marks a film with no poster', async () => {
  const meta = { title: 'Alien', release_date: '1979-05-25', vote_average: 8.1, vote_count: 14000, certification: 'R', genre_ids: [878, 28], poster_path: '/a.jpg', original_language: 'en' }
  const r = movie('alien-1979', meta, {}, { tier: '1080p', collection: 'Alien Collection' })
  assert.equal(r.title, 'Alien')
  assert.equal(r.year, 1979)
  assert.equal(r.rating, 8.1)
  assert.deepEqual(r.genres, ['Science Fiction', 'Action'])
  assert.equal(r.collection, 'Alien Collection')
  assert.equal(r.tierLabel, '1080p')
  assert.equal(r.noPoster, false)
  assert.equal(r.letter, 'A')
  assert.equal(r.folder, 'D:\\Movies')
  const bare = movie('9 to 5', null)
  assert.equal(bare.title, '9 to 5', 'falls back to the file name')
  assert.equal(bare.year, null)
  assert.equal(bare.rating, null)
  assert.equal(bare.noPoster, true)
  assert.equal(bare.letter, '#')
  assert.equal(cols.letterKey('éclair'), '#')
  assert.equal(cols.letterKey('zulu'), 'Z')
})

test('the catalog offers every column the data supports, and paths only to the owner', async () => {
  const ids = (kind, o) => cols.catalogFor(kind, o).map((c) => c.id)
  const want = ['title', 'year', 'rating', 'certification', 'runtime', 'resolution', 'resolutionExact', 'size', 'videoCodec', 'audio', 'hdr', 'bitrate', 'container', 'fps', 'subtitleLanguages', 'audioLanguages', 'dateAdded', 'genres', 'collection']
  for (const id of want) assert.ok(ids('movies', { showPaths: false }).includes(id), id)
  assert.ok(!ids('movies', { showPaths: false }).includes('path'), 'no file path for a non-owner')
  assert.ok(!ids('movies', { showPaths: false }).includes('folder'), 'no folder for a non-owner')
  assert.ok(ids('movies', { showPaths: true }).includes('path'))
  assert.ok(ids('movies', { showPaths: true }).includes('folder'))
  assert.ok(!ids('tv', { showPaths: false }).includes('folder'))
  for (const id of ['title', 'seasons', 'episodes', 'size', 'rating', 'resolution', 'resolutionBest']) assert.ok(ids('tv', {}).includes(id), id)
  assert.ok(!ids('tv', {}).includes('runtime'))
  assert.equal(new Set(ids('movies', { showPaths: true })).size, ids('movies', { showPaths: true }).length, 'no duplicate ids')
})

test('the default columns are the six the product asked for', async () => {
  assert.deepEqual(cols.DEFAULT_COLUMNS.movies, ['title', 'year', 'rating', 'runtime', 'resolution', 'size'])
  const resolved = cols.resolveColumns('movies', null).map((c) => c.id)
  assert.deepEqual(resolved, cols.DEFAULT_COLUMNS.movies)
})

test('saved column choices are cleaned: unknown and owner-only ids go, Title stays, catalog order', async () => {
  const ids = (saved, o) => cols.resolveColumns('movies', saved, o).map((c) => c.id)
  assert.deepEqual(ids(['size', 'year', 'nope'], {}), ['title', 'year', 'size'])
  assert.deepEqual(ids(['path', 'year'], { showPaths: false }), ['title', 'year'])
  assert.deepEqual(ids(['path', 'year'], { showPaths: true }), ['title', 'year', 'path'])
  assert.deepEqual(ids([], {}), cols.DEFAULT_COLUMNS.movies, 'nothing valid falls back to the defaults')
  assert.deepEqual(ids(['nope'], {}), cols.DEFAULT_COLUMNS.movies)
  assert.deepEqual(ids('garbage', {}), cols.DEFAULT_COLUMNS.movies)
})

test('a saved sort naming a column that is gone falls back to Title A-Z', async () => {
  const s = (saved, o) => { const r = cols.resolveSort('movies', saved, o); return `${r.col.id} ${r.dir}` }
  assert.equal(s(null), 'title asc')
  assert.equal(s({ id: 'size', dir: 'desc' }), 'size desc')
  assert.equal(s({ id: 'size', dir: 'bogus' }), 'size asc')
  assert.equal(s({ id: 'path', dir: 'desc' }, { showPaths: false }), 'title asc')
  assert.equal(s({ id: 'gone', dir: 'desc' }), 'title asc')
})

test('a header click flips the same column and starts a new one in its natural direction', async () => {
  const col = (id) => cols.catalogFor('movies', {}).find((c) => c.id === id)
  assert.deepEqual(cols.nextSort({ id: 'title', dir: 'asc' }, col('title')), { id: 'title', dir: 'desc' })
  assert.deepEqual(cols.nextSort({ id: 'title', dir: 'desc' }, col('title')), { id: 'title', dir: 'asc' })
  assert.deepEqual(cols.nextSort({ id: 'title', dir: 'asc' }, col('size')), { id: 'size', dir: 'desc' }, 'numbers: biggest first')
  assert.deepEqual(cols.nextSort({ id: 'size', dir: 'desc' }, col('videoCodec')), { id: 'videoCodec', dir: 'asc' })
})

test('cells: what shows, and what is still to be read from the file', async () => {
  const col = (id) => cols.catalogFor('movies', { showPaths: true }).find((c) => c.id === id)
  const r = movie('alien-1979', { title: 'Alien', release_date: '1979-05-25', vote_average: 8.14 }, { size: 3 * 1024 ** 3 }, { tier: '720p' })
  assert.equal(col('title').cell(r).text, 'Alien')
  assert.equal(col('year').cell(r).text, '1979')
  assert.equal(col('rating').cell(r).text, '8.1')
  assert.equal(col('size').cell(r).text, '3.00 GB')
  assert.equal(col('container').cell(r).text, 'MKV')
  assert.equal(col('path').cell(r).text, 'D:\\Movies\\alien-1979.mkv')
  // Not read yet: no runtime, the resolution is the coarse tier until the real size arrives.
  assert.equal(col('runtime').cell(r, undefined).text, '')
  assert.equal(col('resolution').cell(r, undefined).text, '720p')
  const info = probedInfo()
  assert.equal(col('runtime').cell(r, info).text, '2:07')
  assert.equal(col('resolution').cell(r, info).text, '1080p', 'the real 1920x800 is 1080p, over the tier guess')
  assert.equal(col('resolutionExact').cell(r, info).text, '1920x800')
  assert.equal(col('videoCodec').cell(r, info).text, 'HEVC')
  assert.equal(col('hdr').cell(r, info).text, 'HDR10')
  assert.equal(col('audio').cell(r, info).text, 'E-AC-3 5.1')
  assert.equal(col('audioLanguages').cell(r, info).text, 'English, French')
  assert.equal(col('subtitleLanguages').cell(r, info).text, 'English')
  assert.equal(col('bitrate').cell(r, info).text, '8.4 Mb/s')
  assert.equal(col('fps').cell(r, info).text, '23.976')
  // A file that could not be read: probe columns are empty, not "still loading".
  const failed = { probed: true, failed: true, size: 1, mtimeMs: 1, birthMs: 0 }
  assert.equal(col('videoCodec').cell(r, failed).text, '')
  assert.equal(col('resolution').cell(r, failed).text, '720p', 'the tier still answers')
})

test('Date added prefers the creation time and falls back to the modified time', async () => {
  const col = cols.catalogFor('movies', {}).find((c) => c.id === 'dateAdded')
  const r = movie('x', null)
  const created = new Date(2024, 0, 15, 12).getTime()
  const modified = new Date(2020, 5, 1, 12).getTime()
  assert.equal(cols.buildCsv([r], [col], () => ({ birthMs: created, mtimeMs: modified })).split('\r\n')[1], '2024-01-15')
  assert.equal(cols.buildCsv([r], [col], () => ({ birthMs: 0, mtimeMs: modified })).split('\r\n')[1], '2020-06-01')
  assert.equal(col.cell(r, undefined).text, '', 'unknown until the file is looked at')
})

// ---------------------------------------------------------------- sorting

const sortIds = (rows, colId, dir, infoOf, kind = 'movies') => {
  const col = cols.catalogFor(kind, { showPaths: true }).find((c) => c.id === colId)
  return cols.sortRows(rows, col, dir, infoOf).map((r) => r.id)
}
const file = (name, size, over = {}) => movie(name, { title: name }, { size, path: `p/${name}`, ...over })

test('size sorts by real bytes, not by the text "900 MB" vs "2.00 GB"', async () => {
  const rows = [file('a', 900 * 1024 ** 2), file('b', 2 * 1024 ** 3), file('c', 15 * 1024 ** 2), file('d', 1100 * 1024 ** 2)]
  assert.deepEqual(sortIds(rows, 'size', 'asc'), ['p/c', 'p/a', 'p/d', 'p/b'])
  assert.deepEqual(sortIds(rows, 'size', 'desc'), ['p/b', 'p/d', 'p/a', 'p/c'])
})

test('length sorts by seconds and resolution by pixel count, with unread files last both ways', async () => {
  const rows = [file('a', 1), file('b', 1), file('c', 1), file('d', 1)]
  const info = new Map([
    ['p/a', probedInfo({ durationSec: 9000, width: 1920, height: 1040 })],
    ['p/b', probedInfo({ durationSec: 5400, width: 3840, height: 1608 })],
    ['p/c', probedInfo({ durationSec: 7200, width: 1280, height: 544 })]
    // d: not read yet
  ])
  const infoOf = (r) => info.get(r.probePath)
  assert.deepEqual(sortIds(rows, 'runtime', 'asc', infoOf), ['p/b', 'p/c', 'p/a', 'p/d'])
  assert.deepEqual(sortIds(rows, 'runtime', 'desc', infoOf), ['p/a', 'p/c', 'p/b', 'p/d'])
  assert.deepEqual(sortIds(rows, 'resolution', 'desc', infoOf), ['p/b', 'p/a', 'p/c', 'p/d'])
  assert.deepEqual(sortIds(rows, 'resolution', 'asc', infoOf), ['p/c', 'p/a', 'p/b', 'p/d'])
})

test('a movie known only by the app tier sorts among the read ones by its typical size', async () => {
  const rows = [file('a', 1), file('b', 1, {}), file('c', 1)]
  rows[1] = { ...rows[1], tierLabel: '720p', tierPixels: 1280 * 720 }
  const infoOf = (r) => (r.id === 'p/a' ? probedInfo({ width: 1920, height: 1080 }) : r.id === 'p/c' ? probedInfo({ width: 640, height: 360 }) : undefined)
  assert.deepEqual(sortIds(rows, 'resolution', 'desc', infoOf), ['p/a', 'p/b', 'p/c'])
})

test('text sorts naturally (Movie 2 before Movie 10), ignoring case, and ties keep a fixed order', async () => {
  const rows = ['Movie 10', 'movie 2', 'Alien', 'alien 3'].map((t) => file(t, 1))
  assert.deepEqual(sortIds(rows, 'title', 'asc'), ['p/Alien', 'p/alien 3', 'p/movie 2', 'p/Movie 10'])
  assert.deepEqual(sortIds(rows, 'title', 'desc'), ['p/Movie 10', 'p/movie 2', 'p/alien 3', 'p/Alien'])
  const same = [file('b', 5), file('a', 5), file('c', 5)]
  assert.deepEqual(sortIds(same, 'size', 'asc'), ['p/a', 'p/b', 'p/c'], 'equal sizes fall back to title')
  assert.deepEqual(sortIds(same, 'size', 'desc'), ['p/a', 'p/b', 'p/c'], 'and stay in title order whichever way it sorts')
})

test('rows with no rating or year sit last in either direction', async () => {
  const rated = (name, rating, year) => movie(name, rating === null ? null : { title: name, vote_average: rating, release_date: `${year}-01-01` }, { path: `p/${name}` })
  const rows = [rated('a', 6.1, 1999), rated('b', null), rated('c', 9.0, 2010), rated('d', null)]
  assert.deepEqual(sortIds(rows, 'rating', 'desc'), ['p/c', 'p/a', 'p/b', 'p/d'])
  assert.deepEqual(sortIds(rows, 'rating', 'asc'), ['p/a', 'p/c', 'p/b', 'p/d'])
  assert.deepEqual(sortIds(rows, 'year', 'asc'), ['p/a', 'p/c', 'p/b', 'p/d'])
})

test('sorting does not modify the list it was given', async () => {
  const rows = [file('b', 2), file('a', 1)]
  const before = rows.map((r) => r.id)
  sortIds(rows, 'size', 'asc')
  assert.deepEqual(rows.map((r) => r.id), before)
})

// ---------------------------------------------------------------- shows

const ep = (season, episode, over = {}) => ({
  season, episode, fileName: `S${season}E${episode}.mkv`, path: `D:\\TV\\Show One\\Season ${season}\\S${season}E${episode}.mkv`,
  relPath: `Show One\\Season ${season}\\S${season}E${episode}.mkv`, size: 1024 ** 3, mtimeMs: 1000 * (season * 100 + episode), ...over
})

test('a show is summarized from its episode files', async () => {
  const eps = [ep(2, 1), ep(1, 2), ep(1, 1), ep(2, 2, { fileName: 'S2E2.mp4', size: 3 * 1024 ** 3 })]
  const tiers = { 'D:\\TV\\Show One\\Season 1\\S1E1.mkv': '1080p', 'D:\\TV\\Show One\\Season 1\\S1E2.mkv': '1080p', 'D:\\TV\\Show One\\Season 2\\S2E1.mkv': '720p' }
  const sum = cols.summarizeShow({ key: 'show one', name: 'Show One', episodes: eps }, (e) => tiers[e.path] || 'unknown')
  assert.equal(sum.episodes, 4)
  assert.equal(sum.seasons, 2)
  assert.equal(sum.sizeBytes, 6 * 1024 ** 3)
  assert.equal(sum.latestMs, 202000)
  assert.equal(sum.resMode, '1080p')
  assert.equal(sum.resBest, '1080p')
  assert.equal(sum.ext, '.mkv')
  assert.equal(sum.probePath, 'D:\\TV\\Show One\\Season 1\\S1E1.mkv', 'the first episode, in order, is the one read for codecs')
  assert.equal(sum.folder, 'D:\\TV\\Show One')
})

test('loose episode files have no show folder, and unsorted episodes still count', async () => {
  const flat = { season: null, episode: null, fileName: 'Thing.mkv', path: 'D:\\TV\\Thing.mkv', relPath: 'Thing.mkv', size: 10, mtimeMs: 5 }
  const sum = cols.summarizeShow({ key: 'thing', name: 'Thing', episodes: [flat] }, () => 'unknown')
  assert.equal(sum.folder, '', 'no folder to show')
  assert.equal(sum.seasons, 0)
  assert.equal(sum.episodes, 1)
  assert.equal(sum.resMode, null)
  assert.equal(sum.probePath, 'D:\\TV\\Thing.mkv')
})

test('show rows: seasons, episodes, total size and the episode-majority resolution', async () => {
  const sum = cols.summarizeShow({ key: 'show one', name: 'Show One', episodes: [ep(1, 1), ep(1, 2), ep(2, 1)] }, () => '2160p')
  const row = cols.buildShowRow(sum, { name: 'Show One!', first_air_date: '2015-04-12', vote_average: 8.7, genre_ids: [28], poster_path: '/x' }, { genreNames: MOVIE_GENRES })
  const col = (id) => cols.catalogFor('tv', { showPaths: true }).find((c) => c.id === id)
  assert.equal(row.kind, 'tv')
  assert.equal(col('title').cell(row).text, 'Show One!')
  assert.equal(col('year').cell(row).text, '2015')
  assert.equal(col('seasons').cell(row).text, '2')
  assert.equal(col('episodes').cell(row).text, '3')
  assert.equal(col('size').cell(row).text, '3.00 GB')
  assert.equal(col('resolution').cell(row).text, '4K')
  assert.equal(col('resolutionBest').cell(row).text, '4K')
  assert.equal(col('folder').cell(row).text, 'D:\\TV\\Show One')
  assert.equal(col('videoCodec').cell(row, probedInfo()).text, 'HEVC', "read from the first episode's file")
  assert.equal(col('size').label, 'Total size')
  assert.match(col('videoCodec').label, /1st ep/, 'says it is one episode')
})

test('shows sort by episode count numerically and by resolution rank', async () => {
  const mk = (name, n, tier) => {
    const eps = Array.from({ length: n }, (_, i) => ep(1, i + 1, { path: `${name}/${i}`, relPath: `${name}\\${i}` }))
    return cols.buildShowRow(cols.summarizeShow({ key: name, name, episodes: eps }, () => tier), null, {})
  }
  const rows = [mk('a', 9, '720p'), mk('b', 100, '1080p'), mk('c', 20, '2160p')]
  assert.deepEqual(sortIds(rows, 'episodes', 'desc', undefined, 'tv'), ['b', 'c', 'a'], '100 before 20 before 9')
  assert.deepEqual(sortIds(rows, 'resolution', 'desc', undefined, 'tv'), ['c', 'b', 'a'])
})

// ---------------------------------------------------------------- watched / watchlist

test("Watched, Watchlist and Episodes watched: pending, unavailable, and the owner's real marks", async () => {
  const col = (kind, id) => cols.catalogFor(kind, {}).find((c) => c.id === id)
  const a = movie('alien', { title: 'Alien' }, { fileName: 'Alien (1979).mkv', path: 'p/a' })
  const b = movie('heat', { title: 'Heat' }, { fileName: 'Heat (1995).mkv', path: 'p/b' })
  const marks = { watchedMovies: new Set(['Alien (1979).mkv']), watchedEpisodes: new Set(['S\\1.mkv', 'S\\2.mkv']), watchlistMovies: new Set(['Heat (1995).mkv']) }
  const w = col('movies', 'watched')
  const l = col('movies', 'watchlist')
  assert.deepEqual(w.cell(a, undefined, null), { text: '', sort: null, pending: true }, 'not fetched yet: the faint dot')
  assert.deepEqual(w.cell(a, undefined, false), { text: '', sort: null }, 'unavailable (viewing privacy): nothing')
  assert.equal(w.cell(a, undefined, marks).text, 'Yes')
  assert.equal(w.cell(b, undefined, marks).text, 'No')
  assert.equal(l.cell(b, undefined, marks).text, 'Yes')
  assert.equal(l.cell(a, undefined, marks).text, 'No')
  assert.deepEqual(cols.sortRows([b, a], w, 'desc', undefined, marks).map((r) => r.id), ['p/a', 'p/b'], 'watched first')
  const sum = cols.summarizeShow({ key: 's', name: 'S', episodes: [ep(1, 1, { relPath: 'S\\1.mkv' }), ep(1, 2, { relPath: 'S\\2.mkv' }), ep(1, 3, { relPath: 'S\\3.mkv' })] }, () => 'unknown')
  const show = cols.buildShowRow(sum, null, {})
  assert.equal(col('tv', 'episodesWatched').cell(show, undefined, marks).text, '2 / 3')
  assert.ok(Math.abs(col('tv', 'episodesWatched').cell(show, undefined, marks).sort - 2 / 3) < 1e-9)
  assert.equal(col('tv', 'episodesWatched').cell(show, undefined, false).text, '')
  assert.ok(!cols.catalogFor('tv', {}).some((c) => c.id === 'watched'), 'a show is not watched or not: only its episodes are')
  assert.equal(cols.buildCsv([a, b], [col('movies', 'title'), w, l], undefined, marks).split('\r\n').slice(1, 3).join('|'), 'Alien,Yes,No|Heat,No,Yes')
})

// ---------------------------------------------------------------- CSV

test('CSV: header, quoting, formula guard, size in bytes, cells still being read left empty', async () => {
  const c = (id) => cols.catalogFor('movies', { showPaths: true }).find((x) => x.id === id)
  const rows = [
    movie('a', { title: 'He said "hi", twice', release_date: '2001-01-01' }, { size: 1536, path: 'p/a' }),
    movie('b', { title: '=SUM(A1)', release_date: '' }, { size: 10, path: 'p/b' }),
    movie('c', { title: 'Line\nbreak' }, { size: 10, path: 'p/c' })
  ]
  const csv = cols.buildCsv(rows, [c('title'), c('year'), c('size'), c('runtime')], () => undefined)
  const lines = csv.split('\r\n')
  assert.equal(lines[0], 'Title,Year,Size (bytes),Length')
  assert.equal(lines[1], '"He said ""hi"", twice",2001,1536,')
  assert.equal(lines[2], "'=SUM(A1),,10,", 'a spreadsheet would run this as a formula')
  assert.equal(lines[3], '"Line\nbreak",,10,')
  assert.ok(csv.endsWith('\r\n'))
})

test('the count of rows still waiting on file details ignores columns that do not need them', async () => {
  const c = (id) => cols.catalogFor('movies', {}).find((x) => x.id === id)
  const rows = [file('a', 1), file('b', 1), file('c', 1)]
  const info = new Map([['p/a', probedInfo()], ['p/b', { probed: false }]])
  const infoOf = (r) => info.get(r.probePath)
  assert.equal(cols.pendingInfoCount(rows, [c('title'), c('size')], infoOf), 0)
  assert.equal(cols.pendingInfoCount(rows, [c('title'), c('runtime')], infoOf), 2, 'b is queued and c has not been asked for yet')
  assert.equal(cols.pendingInfoCount([], [c('runtime')], infoOf), 0)
  // Date added needs only the stat: a row whose stat is in is done, even though it was never probed.
  assert.equal(cols.pendingInfoCount(rows, [c('title'), c('dateAdded')], infoOf), 1, 'only c has no record at all')
  assert.equal(cols.columnNeedsProbe(c('dateAdded'), 'movies'), false)
  assert.equal(cols.columnNeedsProbe(c('runtime'), 'movies'), true)
  assert.equal(cols.columnNeedsProbe(c('size'), 'movies'), false)
})

test('building and sorting a 1,300-show, 40,000-episode library is quick enough to do on a click', async () => {
  const shows = []
  for (let s = 0; s < 1300; s++) {
    const eps = []
    for (let e = 0; e < 31; e++) eps.push(ep(1 + Math.floor(e / 10), (e % 10) + 1, { path: `D:\\TV\\s${s}\\${e}.mkv`, relPath: `s${s}\\${e}.mkv`, size: 1e9 + e }))
    shows.push({ key: `s${s}`, name: `Show ${(s * 7919) % 1300}`, episodes: eps })
  }
  const t0 = Date.now()
  const rows = shows.map((sh) => cols.buildShowRow(cols.summarizeShow(sh, () => '1080p'), null, {}))
  const col = cols.catalogFor('tv', {}).find((c) => c.id === 'title')
  const sorted = cols.sortRows(rows, col, 'asc', undefined)
  const ms = Date.now() - t0
  assert.equal(sorted.length, 1300)
  assert.ok(ms < 1500, `took ${ms} ms`)
})
