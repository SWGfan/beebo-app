// The Movies / TV Shows filter engine (src/lib/libraryFilters.js): cleaning of a saved or pasted
// filter set, every criterion, the "still being read" state, and the chips that describe a filter.
// Run: node --test test/library-filters.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const lib = (f) => import(pathToFileURL(path.resolve(__dirname, '..', 'src', 'lib', f)).href)

const GB = 1024 ** 3
const NOW = Date.UTC(2026, 8, 21)
const DAY = 86400000

const movie = (over = {}) => ({
  id: 'm1', kind: 'movies', title: 'Alien', year: 1979, rating: 8.4, votes: 9000,
  genres: ['Horror', 'Science Fiction'], tierLabel: '1080p', sizeBytes: 8 * GB, mtimeMs: NOW - 3 * DAY,
  fileName: 'Alien (1979).mkv', probePath: 'D:\\Movies\\Alien (1979).mkv', ...over
})
const show = (over = {}) => ({
  id: 's1', kind: 'tv', title: 'Severance', year: 2022, rating: 8.7, votes: 3000, genres: ['Drama', 'Mystery'],
  tierLabel: '1080p', tierBest: '4K', sizeBytes: 40 * GB, mtimeMs: NOW - 400 * DAY, epKeys: ['Severance\\S01E01.mkv', 'Severance\\S01E02.mkv'],
  probePath: 'D:\\TV\\Severance\\S01E01.mkv', ...over
})
const probedInfo = (over = {}) => ({ probed: true, width: 1920, height: 800, videoCodec: 'hevc', hdr: 'HDR10', subCount: 2, subLangs: ['English', 'French'], durationSec: 7020, ...over })
const marksOf = (over = {}) => ({ watchedMovies: new Set(), watchedEpisodes: new Set(), watchlistMovies: new Set(), ...over })

test('normalizeFilters accepts nothing wrong: unknown keys, wrong types and swapped ranges are repaired', async () => {
  const { normalizeFilters, EMPTY_FILTERS } = await lib('libraryFilters.js')
  assert.deepEqual(normalizeFilters(null), EMPTY_FILTERS)
  assert.deepEqual(normalizeFilters('nope'), EMPTY_FILTERS)
  assert.deepEqual(normalizeFilters([1, 2]), EMPTY_FILTERS)
  const f = normalizeFilters({
    genres: ['Action', 5, '', 'Action', ' Drama '], yearMin: '2010', yearMax: 1990, ratingMin: 99, resolutions: ['4K', '999p', 'SD'],
    hdr: 'maybe', codecs: ['hevc', 'bogus'], watched: 'watched', inProgress: 'yes', subtitles: 'yes', sizeMinGB: 9, sizeMaxGB: 2,
    runtimeMin: -5, person: '  Sigourney  ', addedDays: 30.4, evil: '<script>', __proto__: { x: 1 }
  })
  assert.deepEqual(f.genres, ['Action', 'Drama'])
  assert.equal(f.yearMin, 1990, 'a swapped year range is put right')
  assert.equal(f.yearMax, 2010)
  assert.equal(f.ratingMin, null, 'a rating outside 0-10 is off')
  assert.deepEqual(f.resolutions, ['4K', 'SD'])
  assert.equal(f.hdr, 'any')
  assert.deepEqual(f.codecs, ['hevc'])
  assert.equal(f.watched, 'watched')
  assert.equal(f.inProgress, false, 'only a real true switches it on')
  assert.equal(f.subtitles, 'yes')
  assert.equal(f.sizeMinGB, 2)
  assert.equal(f.sizeMaxGB, 9)
  assert.equal(f.runtimeMin, null)
  assert.equal(f.person, 'Sigourney')
  assert.equal(f.addedDays, 30)
  assert.ok(!('evil' in f))
  assert.deepEqual(normalizeFilters(f), f, 'cleaning is idempotent')
})

test('a huge or hostile list is bounded', async () => {
  const { normalizeFilters } = await lib('libraryFilters.js')
  const f = normalizeFilters({ genres: Array.from({ length: 500 }, (_, i) => `G${i}`), person: 'x'.repeat(5000) })
  assert.equal(f.genres.length, 40)
  assert.equal(f.person.length, 80)
  assert.ok(f.genres.every((g) => g.length <= 60))
})

test('counting and comparing active criteria', async () => {
  const { activeFilterCount, isFiltersEmpty, filtersEqual } = await lib('libraryFilters.js')
  assert.equal(activeFilterCount(null), 0)
  assert.equal(isFiltersEmpty({}), true)
  assert.equal(activeFilterCount({ yearMin: 1990, yearMax: 1999, genres: ['A', 'B'], watched: 'unwatched' }), 3, 'a range or a list is one criterion')
  assert.equal(filtersEqual({ genres: ['A'] }, { genres: ['A'], junk: 1 }), true)
  assert.equal(filtersEqual({ genres: ['A'] }, { genres: ['B'] }), false)
})

test('no active filter hands back the very same array (no work per row)', async () => {
  const { applyFilters } = await lib('libraryFilters.js')
  const rows = [movie(), movie({ id: 'm2' })]
  const r = applyFilters(rows, {})
  assert.equal(r.rows, rows)
  assert.equal(r.active, false)
  assert.equal(r.pending, 0)
})

test('genre, year range, rating and size use what the scan already knows', async () => {
  const { applyFilters } = await lib('libraryFilters.js')
  const rows = [
    movie({ id: 'a', genres: ['Horror'], year: 1979, rating: 8.4, sizeBytes: 8 * GB }),
    movie({ id: 'b', genres: ['Comedy'], year: 2005, rating: 6.1, sizeBytes: 2 * GB }),
    movie({ id: 'c', genres: ['comedy', 'Drama'], year: null, rating: null, sizeBytes: null })
  ]
  const ids = (f) => applyFilters(rows, f, { now: NOW }).rows.map((r) => r.id)
  assert.deepEqual(ids({ genres: ['Comedy'] }), ['b', 'c'], 'any of the chosen genres, ignoring case')
  assert.deepEqual(ids({ genres: ['Horror', 'Drama'] }), ['a', 'c'])
  assert.deepEqual(ids({ yearMin: 1970, yearMax: 1990 }), ['a'])
  assert.deepEqual(ids({ yearMin: 2000 }), ['b'], 'a row with no year never matches a year filter')
  assert.deepEqual(ids({ ratingMin: 7 }), ['a'])
  assert.deepEqual(ids({ sizeMaxGB: 4 }), ['b'])
  assert.deepEqual(ids({ sizeMinGB: 4 }), ['a'])
  assert.deepEqual(ids({ genres: ['Comedy'], ratingMin: 6, yearMin: 2000 }), ['b'], 'every switched-on criterion has to pass')
})

test('added recently reads the file date (or the screen\'s own added date)', async () => {
  const { applyFilters } = await lib('libraryFilters.js')
  const rows = [movie({ id: 'new', mtimeMs: NOW - 2 * DAY }), movie({ id: 'old', mtimeMs: NOW - 200 * DAY }), movie({ id: 'none', mtimeMs: null })]
  assert.deepEqual(applyFilters(rows, { addedDays: 7 }, { now: NOW }).rows.map((r) => r.id), ['new'])
  assert.deepEqual(applyFilters(rows, { addedDays: 365 }, { now: NOW }).rows.map((r) => r.id), ['new', 'old'])
  const addedOf = (r) => (r.id === 'old' ? NOW - DAY : 0)
  assert.deepEqual(applyFilters(rows, { addedDays: 7 }, { now: NOW, addedOf }).rows.map((r) => r.id), ['old'])
})

test('resolution buckets: 4K, 1080p, 720p and SD, from the real file when read, else the quality tier', async () => {
  const { applyFilters, resolutionBucket, rowResolution } = await lib('libraryFilters.js')
  assert.equal(resolutionBucket('8K'), '4K')
  assert.equal(resolutionBucket('1440p'), '1080p')
  assert.equal(resolutionBucket('480p'), 'SD')
  assert.equal(resolutionBucket('Other'), null)
  const uhd = movie({ id: 'uhd', tierLabel: '4K' })
  const hd = movie({ id: 'hd', tierLabel: '1080p' })
  const sd = movie({ id: 'sd', tierLabel: '480p' })
  const unknown = movie({ id: 'unk', tierLabel: null, probePath: '' })
  const rows = [uhd, hd, sd, unknown]
  const ids = (f, ctx) => applyFilters(rows, f, ctx).rows.map((r) => r.id)
  assert.deepEqual(ids({ resolutions: ['4K'] }), ['uhd'])
  assert.deepEqual(ids({ resolutions: ['1080p', 'SD'] }), ['hd', 'sd'])
  // a scope 1920x800 file is 1080p even when the tier said otherwise
  const infoOf = (r) => (r.id === 'sd' ? probedInfo({ width: 1920, height: 800 }) : undefined)
  assert.equal(rowResolution(sd, infoOf(sd)), '1080p')
  assert.deepEqual(ids({ resolutions: ['1080p'] }, { infoOf }), ['hd', 'sd'])
  // a show counts by its sharpest episode
  assert.equal(rowResolution(show(), undefined), '4K')
})

test('HDR, codec, subtitles and runtime need the file read: unread rows are pending, not "no"', async () => {
  const { applyFilters } = await lib('libraryFilters.js')
  const a = movie({ id: 'a' })
  const b = movie({ id: 'b' })
  const c = movie({ id: 'c' })
  const d = movie({ id: 'd', probePath: '' }) // no file to read at all
  const infos = {
    a: probedInfo({ hdr: 'Dolby Vision', videoCodec: 'hevc', subCount: 1, durationSec: 3 * 3600 }),
    b: probedInfo({ hdr: 'SDR', videoCodec: 'h264', subCount: 0, subLangs: [], durationSec: 90 * 60 })
  }
  const infoOf = (r) => infos[r.id]
  const run = (f) => applyFilters([a, b, c, d], f, { infoOf })
  let r = run({ hdr: 'hdr' })
  assert.deepEqual(r.rows.map((x) => x.id), ['a'])
  assert.equal(r.pending, 1, 'c has not been read yet; d can never be read, so it is simply not a match')
  assert.deepEqual(run({ hdr: 'sdr' }).rows.map((x) => x.id), ['b'])
  assert.deepEqual(run({ codecs: ['hevc'] }).rows.map((x) => x.id), ['a'])
  assert.deepEqual(run({ codecs: ['h264', 'av1'] }).rows.map((x) => x.id), ['b'])
  assert.deepEqual(run({ subtitles: 'yes' }).rows.map((x) => x.id), ['a'])
  assert.deepEqual(run({ subtitles: 'no' }).rows.map((x) => x.id), ['b'])
  r = run({ runtimeMin: 120 })
  assert.deepEqual(r.rows.map((x) => x.id), ['a'])
  assert.deepEqual(run({ runtimeMax: 100 }).rows.map((x) => x.id), ['b'])
  assert.equal(run({ runtimeMin: 100, runtimeMax: 200 }).rows.length, 1)
  // once c is read it stops being pending
  infos.c = probedInfo({ hdr: 'HDR10' })
  r = run({ hdr: 'hdr' })
  assert.deepEqual(r.rows.map((x) => x.id), ['a', 'c'])
  assert.equal(r.pending, 0)
  // a file ffprobe could not read is a firm no
  infos.c = { probed: true, failed: true }
  assert.deepEqual(run({ hdr: 'hdr' }).rows.map((x) => x.id), ['a'])
  assert.equal(run({ hdr: 'hdr' }).pending, 0)
})

test('a definite failure beats pending: a row that already fails on genre is not held waiting for its file', async () => {
  const { applyFilters } = await lib('libraryFilters.js')
  const rows = [movie({ id: 'x', genres: ['Comedy'] })]
  const r = applyFilters(rows, { genres: ['Horror'], hdr: 'hdr' }, { infoOf: () => undefined })
  assert.deepEqual(r.rows, [])
  assert.equal(r.pending, 0)
})

test('watched / unwatched / in progress use the owner\'s marks, for films and for shows', async () => {
  const { applyFilters } = await lib('libraryFilters.js')
  const seen = movie({ id: 'seen', fileName: 'seen.mkv' })
  const fresh = movie({ id: 'fresh', fileName: 'fresh.mkv' })
  const half = movie({ id: 'half', fileName: 'half.mkv' })
  const allEps = show({ id: 'all', epKeys: ['a1', 'a2'] })
  const someEps = show({ id: 'some', epKeys: ['b1', 'b2'] })
  const noEps = show({ id: 'none', epKeys: ['c1', 'c2'] })
  const marks = marksOf({ watchedMovies: new Set(['seen.mkv']), watchedEpisodes: new Set(['a1', 'a2', 'b1']) })
  const progressOf = (r) => (r.id === 'half' ? 40 : 0)
  const run = (rows, f) => applyFilters(rows, f, { marks, progressOf }).rows.map((r) => r.id)
  const films = [seen, fresh, half]
  assert.deepEqual(run(films, { watched: 'watched' }), ['seen'])
  assert.deepEqual(run(films, { watched: 'unwatched' }), ['fresh', 'half'])
  assert.deepEqual(run(films, { inProgress: true }), ['half'])
  const shows = [allEps, someEps, noEps]
  assert.deepEqual(run(shows, { watched: 'watched' }), ['all'], 'a show is watched when every episode is')
  assert.deepEqual(run(shows, { watched: 'unwatched' }), ['none'], 'a show with any episode watched is not "unwatched"')
  assert.deepEqual(run(shows, { inProgress: true }), ['some'], 'some but not all episodes watched counts as in progress')
})

test('marks still loading hold rows pending; marks unavailable (viewing privacy) switch those criteria off', async () => {
  const { applyFilters } = await lib('libraryFilters.js')
  const rows = [movie({ id: 'a' }), movie({ id: 'b' })]
  const loading = applyFilters(rows, { watched: 'watched' }, { marks: null })
  assert.deepEqual(loading.rows, [])
  assert.equal(loading.pending, 2)
  const off = applyFilters(rows, { watched: 'watched', inProgress: true }, { marks: false })
  assert.equal(off.rows.length, 2, 'unavailable marks never empty the screen')
  assert.equal(off.pending, 0)
})

test('actor search matches part of a name, ignoring case and accents, and waits for the cast list', async () => {
  const { applyFilters } = await lib('libraryFilters.js')
  const rows = [movie({ id: 'a' }), movie({ id: 'b' }), movie({ id: 'c' })]
  const cast = { a: ['Sigourney Weaver', 'Tom Skerritt'], b: ['Renée Zellweger'] }
  const peopleOf = (r) => cast[r.id]
  const run = (person) => applyFilters(rows, { person }, { peopleOf })
  assert.deepEqual(run('weaver').rows.map((r) => r.id), ['a'])
  assert.deepEqual(run('renee').rows.map((r) => r.id), ['b'], 'accents fold')
  const r = run('tom')
  assert.deepEqual(r.rows.map((x) => x.id), ['a'])
  assert.equal(r.pending, 1, 'c has no cast list yet')
})

test('filterNeeds says what to load, so nothing is fetched for a filter that is not used', async () => {
  const { filterNeeds } = await lib('libraryFilters.js')
  assert.deepEqual(filterNeeds({}), { probe: false, marks: false, people: false })
  assert.deepEqual(filterNeeds({ genres: ['A'], yearMin: 2000, resolutions: ['4K'], ratingMin: 5 }), { probe: false, marks: false, people: false })
  assert.equal(filterNeeds({ hdr: 'hdr' }).probe, true)
  assert.equal(filterNeeds({ codecs: ['av1'] }).probe, true)
  assert.equal(filterNeeds({ subtitles: 'no' }).probe, true)
  assert.equal(filterNeeds({ runtimeMax: 90 }).probe, true)
  assert.equal(filterNeeds({ watched: 'unwatched' }).marks, true)
  assert.equal(filterNeeds({ inProgress: true }).marks, true)
  assert.equal(filterNeeds({ person: 'x' }).people, true)
})

test('codec names collapse to a few families', async () => {
  const { codecKey } = await lib('libraryFilters.js')
  assert.equal(codecKey('h264'), 'h264')
  assert.equal(codecKey('HEVC'), 'hevc')
  assert.equal(codecKey('h265'), 'hevc')
  assert.equal(codecKey('mpeg4'), 'mpeg4')
  assert.equal(codecKey('msmpeg4v3'), 'mpeg4')
  assert.equal(codecKey('mpeg2video'), 'mpeg2')
  assert.equal(codecKey('wmv3'), 'other')
  assert.equal(codecKey(''), '')
})

test('chips describe each switched-on criterion, and clearing one leaves the rest', async () => {
  const { describeFilters, clearFilterKey, normalizeFilters } = await lib('libraryFilters.js')
  const f = normalizeFilters({ genres: ['Action', 'Drama'], yearMin: 1990, yearMax: 1999, ratingMin: 7.5, resolutions: ['4K'], hdr: 'hdr', watched: 'unwatched', sizeMaxGB: 5, addedDays: 30, person: 'Weaver' })
  const chips = describeFilters(f)
  assert.deepEqual(chips.map((c) => c.key), ['genres', 'year', 'ratingMin', 'resolutions', 'hdr', 'watched', 'size', 'person', 'added'])
  assert.equal(chips.find((c) => c.key === 'year').label, '1990-1999')
  assert.equal(chips.find((c) => c.key === 'ratingMin').label, 'Rated 7.5+')
  assert.equal(chips.find((c) => c.key === 'size').label, 'Under 5 GB')
  assert.equal(chips.find((c) => c.key === 'added').label, 'Added: last 30 days')
  const cleared = clearFilterKey(f, 'year')
  assert.equal(cleared.yearMin, null)
  assert.equal(cleared.yearMax, null)
  assert.deepEqual(cleared.genres, ['Action', 'Drama'])
  assert.equal(clearFilterKey(f, 'watched').watched, 'any')
  assert.deepEqual(clearFilterKey(f, 'genres').genres, [])
  assert.equal(describeFilters({}).length, 0)
})

test('panel helpers: genre counts and the year span of the library', async () => {
  const { genreCountsOf, yearSpanOf } = await lib('libraryFilters.js')
  const rows = [movie({ genres: ['A', 'B'], year: 1990 }), movie({ genres: ['A'], year: 2020 }), movie({ genres: [], year: null })]
  assert.deepEqual(genreCountsOf(rows), [{ name: 'A', count: 2 }, { name: 'B', count: 1 }])
  assert.deepEqual(yearSpanOf(rows), { min: 1990, max: 2020 })
  assert.equal(yearSpanOf([movie({ year: null })]), null)
})

test('filtering a 5,000-row library is one quick pass', async () => {
  const { applyFilters } = await lib('libraryFilters.js')
  const rows = Array.from({ length: 5000 }, (_, i) => movie({ id: `m${i}`, year: 1950 + (i % 75), genres: i % 3 ? ['Drama'] : ['Comedy'], rating: (i % 100) / 10 }))
  const t = process.hrtime.bigint()
  const r = applyFilters(rows, { genres: ['Comedy'], yearMin: 1980, ratingMin: 5 }, { now: NOW })
  const ms = Number(process.hrtime.bigint() - t) / 1e6
  assert.ok(r.rows.length > 0)
  assert.ok(ms < 250, `took ${ms.toFixed(1)} ms`)
})
