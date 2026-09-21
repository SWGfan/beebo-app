// The Trailers screen's main-process half (electron/trailersBrowse.js and
// electron/trailersBrowseIpc.js): the trailer picker, key and URL safety, the disk cache,
// library exclusion, filters -> TMDB params, restricted profiles, and the IPC handlers.
// TMDB is a fake fetch; nothing here touches the network or a real library.
// Run: node --test test/trailers-browse.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const appRoot = path.resolve(__dirname, '..')
const T = require(path.join(appRoot, 'electron', 'trailersBrowse.js'))
const ipcModule = require(path.join(appRoot, 'electron', 'trailersBrowseIpc.js'))
const parental = require(path.join(appRoot, 'electron', 'parentalControls.js'))

const KEY_A = 'aaaaaaaaaaa'
const KEY_B = 'bbbbbbbbbbb'
const KEY_C = 'ccccccccccc'
const KEY_D = 'ddddddddddd'

const vid = (over) => ({ site: 'YouTube', type: 'Trailer', official: true, iso_639_1: 'en', published_at: '2024-01-01T00:00:00.000Z', key: KEY_A, name: 'Official Trailer', ...over })

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-trailers-'))
}

// ---------------------------------------------------------------------------
// Picker

test('picker: a Trailer beats a Teaser even when the teaser is official and newer', () => {
  const pick = T.pickTrailer([
    vid({ key: KEY_A, type: 'Teaser', official: true, published_at: '2025-01-01T00:00:00Z' }),
    vid({ key: KEY_B, type: 'Trailer', official: false, published_at: '2020-01-01T00:00:00Z' })
  ])
  assert.equal(pick.key, KEY_B)
})

test('picker: within a type, official beats unofficial even when the unofficial one is in the app language', () => {
  const pick = T.pickTrailer(
    [vid({ key: KEY_A, official: false, iso_639_1: 'fr' }), vid({ key: KEY_B, official: true, iso_639_1: 'en' })],
    { language: 'fr' }
  )
  assert.equal(pick.key, KEY_B)
})

test('picker: app language, then English, then anything else', () => {
  const rows = [vid({ key: KEY_A, iso_639_1: 'de' }), vid({ key: KEY_B, iso_639_1: 'en' }), vid({ key: KEY_C, iso_639_1: 'fr' })]
  assert.equal(T.pickTrailer(rows, { language: 'fr' }).key, KEY_C)
  assert.equal(T.pickTrailer(rows, { language: 'es' }).key, KEY_B, 'no Spanish: English')
  assert.equal(T.pickTrailer(rows.filter((r) => r.key !== KEY_B), { language: 'es' }).key, KEY_A, 'no Spanish or English: the newest of the rest, then key')
  assert.equal(T.pickTrailer([vid({ key: KEY_A, iso_639_1: null }), vid({ key: KEY_B, iso_639_1: 'en' })]).key, KEY_B, 'a language-less video ranks below English')
})

test('picker: newest published_at breaks a tie; an unreadable date ranks last', () => {
  const pick = T.pickTrailer([
    vid({ key: KEY_A, published_at: '2021-03-01T00:00:00Z' }),
    vid({ key: KEY_B, published_at: '2023-03-01T00:00:00Z' }),
    vid({ key: KEY_C, published_at: 'not a date' }),
    vid({ key: KEY_D, published_at: undefined })
  ])
  assert.equal(pick.key, KEY_B)
  assert.equal(T.pickTrailer([vid({ key: KEY_A, published_at: 'junk' }), vid({ key: KEY_B, published_at: '1999-01-01T00:00:00Z' })]).key, KEY_B)
})

test('picker: the answer does not depend on the order TMDB listed the videos in', () => {
  const rows = [
    vid({ key: KEY_A, published_at: '2022-01-01T00:00:00Z' }),
    vid({ key: KEY_B, published_at: '2022-01-01T00:00:00Z' }),
    vid({ key: KEY_C, type: 'Teaser' }),
    vid({ key: KEY_D, official: false })
  ]
  const permutations = (arr) => (arr.length <= 1 ? [arr] : arr.flatMap((x, i) => permutations([...arr.slice(0, i), ...arr.slice(i + 1)]).map((p) => [x, ...p])))
  const answers = new Set(permutations(rows).map((p) => T.pickTrailer(p).key))
  assert.deepEqual([...answers], [KEY_A], 'identical everything else: the smaller key wins, every time')
})

test('picker: no videos, junk input, and non-YouTube-only lists give null', () => {
  assert.equal(T.pickTrailer([]), null)
  assert.equal(T.pickTrailer(undefined), null)
  assert.equal(T.pickTrailer(null), null)
  assert.equal(T.pickTrailer('nope'), null)
  assert.equal(T.pickTrailer([null, 5, 'x', {}]), null)
  assert.equal(T.pickTrailer([vid({ site: 'Vimeo' }), vid({ site: 'Dailymotion', key: KEY_B })]), null)
  assert.equal(T.pickTrailer([vid({ site: undefined })]), null)
})

test('picker: clips and featurettes are never picked, and a bad key is skipped for a good one', () => {
  assert.equal(T.pickTrailer([vid({ type: 'Clip' }), vid({ type: 'Featurette', key: KEY_B }), vid({ type: 'Behind the Scenes', key: KEY_C })]), null)
  const pick = T.pickTrailer([vid({ key: 'abc"><script>' }), vid({ key: 'short' }), vid({ key: KEY_B, official: false })])
  assert.equal(pick.key, KEY_B)
})

test('picker: the site name is matched case-insensitively and the name is cleaned', () => {
  const pick = T.pickTrailer([vid({ site: 'YOUTUBE', name: '  Big\u0007 Trailer \n ' })])
  assert.equal(pick.key, KEY_A)
  assert.equal(pick.name, 'Big Trailer')
})

// ---------------------------------------------------------------------------
// Key validation and URL construction

test('YouTube keys: exactly 11 of A-Z a-z 0-9 _ -', () => {
  for (const ok of ['dQw4w9WgXcQ', 'abcDEF_-123', '___________', '-----------', KEY_A]) assert.equal(T.isValidYouTubeKey(ok), true, ok)
  const hostile = [
    'abc"><script>',
    'abcdefghij', // 10
    'abcdefghijkl', // 12
    '',
    ' abcdefghij',
    'abcdefghij\n', // 11 characters but one is a newline
    'abcdefghijk\n',
    'abcde fghij',
    'abcdefghi/.',
    '../../etc/x',
    'a'.repeat(11) + '&x=1',
    'é'.repeat(11),
    '日本語日本語日本語日本',
    '\u0000'.repeat(11),
    'abcdefghij%',
    'javascript:1',
    null,
    undefined,
    12345678901,
    ['abcdefghijk'],
    { toString: () => 'abcdefghijk' }
  ]
  for (const bad of hostile) {
    assert.equal(T.isValidYouTubeKey(bad), false, JSON.stringify(bad))
    assert.equal(T.youtubeWatchUrl(bad), null, JSON.stringify(bad))
  }
})

test('the watch URL is built from the key and nothing else', () => {
  assert.equal(T.youtubeWatchUrl('dQw4w9WgXcQ'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')
  const u = new URL(T.youtubeWatchUrl(KEY_A))
  assert.equal(u.origin, 'https://www.youtube.com')
  assert.equal(u.pathname, '/watch')
  assert.deepEqual([...u.searchParams.keys()], ['v'])
})

test('the fallback search URL is a YouTube results page with the title, year and "trailer" encoded', () => {
  const url = T.youtubeSearchUrl('Amélie & Co "x"?', 2001)
  const u = new URL(url)
  assert.equal(u.origin, 'https://www.youtube.com')
  assert.equal(u.pathname, '/results')
  assert.equal(u.searchParams.get('search_query'), 'Amélie & Co "x"? 2001 trailer')
  assert.deepEqual([...u.searchParams.keys()], ['search_query'], 'the title cannot add another parameter')
  assert.ok(!/["<>& ]/.test(url.split('search_query=')[1]), 'nothing raw survives in the query')
  assert.equal(new URL(T.youtubeSearchUrl('X', null)).searchParams.get('search_query'), 'X trailer')
  assert.equal(T.youtubeSearchUrl('', 2001), null)
  assert.equal(T.youtubeSearchUrl('  \n\u0001 ', 2001), null)
  assert.equal(new URL(T.youtubeSearchUrl('a\nb\u0000c', 1)).searchParams.get('search_query'), 'a b c 1 trailer')
  assert.ok(new URL(T.youtubeSearchUrl('x'.repeat(5000), 1)).searchParams.get('search_query').length < 140)
})

// ---------------------------------------------------------------------------
// Disk cache

test('cache: an entry lives for its TTL and no longer', () => {
  const clock = { t: 1000 }
  const c = T.createDiskCache({ file: null, now: () => clock.t })
  c.set('videos', { a: 1 }, T.TTL.videos)
  c.set('list', { b: 2 }, T.TTL.list)
  assert.deepEqual(c.get('videos'), { a: 1 })
  clock.t += T.TTL.list - 1
  assert.deepEqual(c.get('list'), { b: 2 })
  clock.t += 2
  assert.equal(c.get('list'), undefined, 'discover/recommendations expire after 12 hours')
  assert.deepEqual(c.get('videos'), { a: 1 })
  clock.t += T.TTL.videos
  assert.equal(c.get('videos'), undefined, 'videos expire after 7 days')
  assert.equal(c.size(), 0)
})

test('cache: the documented TTLs', () => {
  const H = 3600 * 1000
  assert.equal(T.TTL.videos, 7 * 24 * H)
  assert.equal(T.TTL.list, 12 * H)
  assert.ok(T.TTL.person < T.TTL.list, 'person search is the shortest')
  assert.ok(T.TTL.videosNone <= 24 * H, 'a title with no trailer yet is asked again within a day')
})

test('cache: bounded by entry count, oldest out first', () => {
  const c = T.createDiskCache({ file: null, maxEntries: 3 })
  for (const k of ['a', 'b', 'c', 'd', 'e']) c.set(k, k, 1e9)
  assert.equal(c.size(), 3)
  assert.equal(c.get('a'), undefined)
  assert.equal(c.get('b'), undefined)
  assert.equal(c.get('e'), 'e')
  c.set('c', 'c2', 1e9) // a rewrite makes it the newest
  c.set('f', 'f', 1e9)
  assert.equal(c.get('c'), 'c2')
  assert.equal(c.get('d'), undefined)
})

test('cache: bounded by total size, and one oversized answer is not stored at all', () => {
  const c = T.createDiskCache({ file: null, maxBytes: 2000, maxEntryBytes: 900 })
  for (let i = 0; i < 20; i++) c.set('k' + i, 'x'.repeat(300), 1e9)
  assert.ok(c.bytes() <= 2000, 'stays under the byte bound: ' + c.bytes())
  assert.ok(c.size() < 20)
  assert.equal(c.get('k19'), 'x'.repeat(300), 'the newest survives')
  c.set('huge', 'y'.repeat(5000), 1e9)
  assert.equal(c.get('huge'), undefined)
})

test('cache: survives a restart, drops what expired meanwhile, and shrugs off a damaged file', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'sub', 'trailers-cache.json')
  const clock = { t: 5000 }
  const first = T.createDiskCache({ file, now: () => clock.t })
  first.set('short', { v: 1 }, 100)
  first.set('long', { v: 2 }, 100000)
  first.flush()
  assert.ok(fs.existsSync(file))
  clock.t += 1000
  const second = T.createDiskCache({ file, now: () => clock.t })
  assert.equal(second.get('short'), undefined)
  assert.deepEqual(second.get('long'), { v: 2 })
  fs.writeFileSync(file, '{ not json')
  const third = T.createDiskCache({ file, now: () => clock.t })
  assert.equal(third.get('long'), undefined)
  third.set('x', 1, 1000)
  third.flush()
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).entries.x.v, 1)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('cache: a file that holds more than the bounds allow is trimmed on load', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'c.json')
  const entries = {}
  for (let i = 0; i < 50; i++) entries['k' + i] = { at: i, exp: 1e15, v: i }
  fs.writeFileSync(file, JSON.stringify({ v: 1, entries }))
  const c = T.createDiskCache({ file, maxEntries: 10 })
  assert.equal(c.size(), 10)
  assert.equal(c.get('k49'), 49)
  assert.equal(c.get('k0'), undefined)
  fs.rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Limiter

test('limiter: never more than the limit at once, and everything still finishes', async () => {
  const lim = T.createLimiter(3)
  let running = 0
  let peak = 0
  const jobs = Array.from({ length: 12 }, (_, i) =>
    lim.run(async () => {
      running++
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 5))
      running--
      return i
    })
  )
  assert.deepEqual(await Promise.all(jobs), Array.from({ length: 12 }, (_, i) => i))
  assert.equal(peak, 3)
  assert.equal(lim.stats().peak, 3)
  await assert.rejects(() => lim.run(async () => { throw new Error('boom') }), /boom/)
  assert.equal(await lim.run(async () => 'still works'), 'still works')
})

// ---------------------------------------------------------------------------
// Filters and TMDB parameters

const NOW = () => Date.UTC(2026, 8, 21)
const norm = (raw) => T.normalizeFilters(raw, { now: NOW })

test('filters: whatever the renderer sends becomes a safe, complete filter object', () => {
  assert.deepEqual(norm(undefined), { media: 'movie', genres: [], yearFrom: null, yearTo: null, personId: null, text: '', sort: 'popular' })
  assert.deepEqual(norm('nope'), norm(undefined))
  assert.deepEqual(norm({ media: 'tv', genres: ['18', 35, 35, 'x', -1, 1e12, {}, 27], yearFrom: '1990', yearTo: 1999, personId: '287', text: '  hello\n\u0000world  ', sort: 'rating' }), {
    media: 'tv', genres: [18, 35], yearFrom: 1990, yearTo: 1999, personId: 287, text: 'hello world', sort: 'rating'
  })
})

test('filters: genres must exist for the media type, and at most six are kept', () => {
  assert.deepEqual(norm({ media: 'movie', genres: [27, 53, 10749] }).genres, [27, 53, 10749])
  assert.deepEqual(norm({ media: 'tv', genres: [27, 53, 10749, 10762] }).genres, [10762], 'horror, thriller and romance are film-only')
  assert.equal(norm({ genres: [28, 12, 16, 35, 80, 99, 18, 10751] }).genres.length, 6)
})

test('filters: one year, a range, a reversed range, and years that make no sense', () => {
  assert.deepEqual([norm({ yearFrom: 1999 }).yearFrom, norm({ yearFrom: 1999 }).yearTo], [1999, 1999])
  assert.deepEqual([norm({ yearTo: 2001 }).yearFrom, norm({ yearTo: 2001 }).yearTo], [2001, 2001])
  const r = norm({ yearFrom: 2005, yearTo: 1995 })
  assert.deepEqual([r.yearFrom, r.yearTo], [1995, 2005])
  for (const bad of [1500, 3000, 'abc', 0, -5, 19.5, null, {}]) {
    const f = norm({ yearFrom: bad, yearTo: bad })
    assert.deepEqual([f.yearFrom, f.yearTo], [null, null], String(bad))
  }
  assert.equal(norm({ text: 'x'.repeat(500) }).text.length, 100)
})

test('plan: a movie search by genre, years and actor is one discover call, always without adult titles', () => {
  const f = norm({ media: 'movie', genres: [28, 878], yearFrom: 1990, yearTo: 1999, personId: 287 })
  const plan = T.buildQueryPlan(f, { language: 'en-US' })
  assert.equal(plan.source, 'discover')
  assert.equal(plan.path, '/discover/movie')
  assert.deepEqual(plan.params, {
    include_adult: 'false',
    language: 'en-US',
    sort_by: 'popularity.desc',
    'vote_count.gte': T.MIN_VOTES.person,
    with_genres: '28,878',
    'primary_release_date.gte': '1990-01-01',
    'primary_release_date.lte': '1999-12-31',
    with_cast: 287
  })
  assert.equal(plan.pages, 2)
})

test('plan: popularity and rating sorts use a vote floor that keeps unrated junk out', () => {
  const popular = T.buildQueryPlan(norm({ genres: [35] }))
  const rated = T.buildQueryPlan(norm({ genres: [35], sort: 'rating' }))
  assert.equal(popular.params.sort_by, 'popularity.desc')
  assert.equal(rated.params.sort_by, 'vote_average.desc')
  assert.equal(popular.params['vote_count.gte'], T.MIN_VOTES.movie.popular)
  assert.equal(rated.params['vote_count.gte'], T.MIN_VOTES.movie.rating)
  assert.ok(rated.params['vote_count.gte'] > popular.params['vote_count.gte'], 'sorting by rating needs more votes behind each score')
  assert.equal(rated.minVotes, T.MIN_VOTES.movie.rating, 'and it is enforced locally too')
})

test('plan: TV discover uses TV genre ids and first_air_date', () => {
  const plan = T.buildQueryPlan(norm({ media: 'tv', genres: [28, 12, 878, 14, 10752, 35], yearFrom: 2010, yearTo: 2012 }))
  assert.equal(plan.path, '/discover/tv')
  assert.equal(plan.params.with_genres, '35,10759,10765,10768', 'action+adventure share TV id 10759; sci-fi+fantasy share 10765')
  assert.equal(plan.params['first_air_date.gte'], '2010-01-01')
  assert.equal(plan.params['first_air_date.lte'], '2012-12-31')
  assert.equal(plan.params.include_adult, 'false')
  assert.ok(!('primary_release_date.gte' in plan.params))
  assert.equal(plan.params.with_cast, undefined)
})

test('plan: a title search goes to /search, with the other filters applied afterwards', () => {
  const plan = T.buildQueryPlan(norm({ media: 'movie', text: 'heat', genres: [80], yearFrom: 1995, yearTo: 1995, personId: 1158 }))
  assert.equal(plan.source, 'search')
  assert.equal(plan.path, '/search/movie')
  assert.equal(plan.params.query, 'heat')
  assert.equal(plan.params.include_adult, 'false')
  assert.equal(plan.params.primary_release_year, 1995)
  assert.deepEqual(plan.local.genres, [80])
  assert.equal(plan.local.creditsOf, 1158)
  const tv = T.buildQueryPlan(norm({ media: 'tv', text: 'wire', yearFrom: 2002, yearTo: 2002 }))
  assert.equal(tv.path, '/search/tv')
  assert.equal(tv.params.first_air_date_year, 2002)
  const range = T.buildQueryPlan(norm({ text: 'x', yearFrom: 1990, yearTo: 1999 }))
  assert.ok(!('primary_release_year' in range.params), 'a range is filtered afterwards, not sent as one year')
})

test('plan: TV has no discover-by-actor, so an actor on TV reads that person\'s TV credits', () => {
  const plan = T.buildQueryPlan(norm({ media: 'tv', personId: 17, genres: [18] }))
  assert.equal(plan.source, 'credits')
  assert.equal(plan.path, '/person/17/tv_credits')
  assert.deepEqual(plan.local.genres, [18])
})

// ---------------------------------------------------------------------------
// Library and exclusion

const SOURCES = () => ({
  movieFiles: [
    { fileName: 'Heat (1995).mkv', path: 'D:\\Movies\\Heat (1995).mkv' },
    { fileName: 'Alien.mkv', path: 'D:\\Movies\\Alien.mkv' },
    { fileName: 'Alien (copy).mkv', path: 'D:\\Movies\\Alien (copy).mkv' },
    { fileName: 'Unmatched Thing (2010).mkv', path: 'D:\\Movies\\Unmatched Thing (2010).mkv' },
    { fileName: 'Ronin.mp4', path: 'D:\\Movies\\Ronin.mp4' }
  ],
  movieManifest: {
    'Heat (1995).mkv': { id: 949, title: 'Heat', original_title: 'Heat', release_date: '1995-12-15', genre_ids: [28, 80, 18, 53], vote_average: 7.9, overview: 'A crew and a cop.', poster_path: '/heat.jpg', certification: 'R' },
    'Alien.mkv': { id: 348, title: 'Alien', release_date: '1979-05-25', genre_ids: [27, 878], vote_average: 8.1, poster_path: '/alien.jpg' },
    'Alien (copy).mkv': { id: 348, title: 'Alien', release_date: '1979-05-25', genre_ids: [27, 878], vote_average: 8.1 },
    'Ronin.mp4': null
  },
  movieCredits: { 949: [{ id: 1158, name: 'Al Pacino' }, { id: 380, name: 'Robert De Niro' }], 348: [{ id: 10205, name: 'Sigourney Weaver' }] },
  tvManifest: {
    'the wire': { id: 1438, name: 'The Wire', original_name: 'The Wire', first_air_date: '2002-06-02', genre_ids: [80, 18], vote_average: 8.5, poster_path: '/wire.jpg' },
    'mystery show': null,
    'sci show': { id: 77, name: 'Sci Show', first_air_date: '2015-01-01', genre_ids: [10765], vote_average: 7 }
  },
  tvCredits: { 1438: [{ id: 17, name: 'Dominic West' }] }
})

test('library: built from the indexes the app already has, one item per TMDB title', () => {
  const lib = T.buildLibrary(SOURCES(), { posterFor: (media, id) => (media === 'movie' && id === 949 ? 'http://localhost:1/media/poster/949.jpg' : null) })
  const movies = lib.items.filter((i) => i.mediaType === 'movie')
  assert.deepEqual(movies.map((m) => m.title).sort(), ['Alien', 'Heat'], 'two Alien files are one title; unmatched files are not listed')
  const heat = movies.find((m) => m.tmdbId === 949)
  assert.equal(heat.year, 1995)
  assert.equal(heat.rating, 7.9)
  assert.equal(heat.certification, 'R')
  assert.equal(heat.path, 'D:\\Movies\\Heat (1995).mkv')
  assert.equal(heat.posterUrl, 'http://localhost:1/media/poster/949.jpg')
  assert.deepEqual(heat.castIds, [1158, 380])
  assert.equal(movies.find((m) => m.tmdbId === 348).posterUrl, 'https://image.tmdb.org/t/p/w342/alien.jpg')
  const shows = lib.items.filter((i) => i.mediaType === 'tv')
  assert.deepEqual(shows.map((s) => s.title).sort(), ['Sci Show', 'The Wire'])
  assert.deepEqual(shows.find((s) => s.tmdbId === 77).genreIds, [878, 14], 'combined TV genres are split into film genres, as everywhere else')
  assert.equal(T.buildLibrary(undefined).items.length, 0)
})

test('exclusion: by TMDB id first', () => {
  const { index } = T.buildLibrary(SOURCES())
  assert.equal(T.isInLibrary(index, { mediaType: 'movie', tmdbId: 949, title: 'Some Other Title', year: 2030 }), true)
  assert.equal(T.isInLibrary(index, { mediaType: 'tv', tmdbId: 1438, title: 'Nope', year: 1 }), true)
  assert.equal(T.isInLibrary(index, { mediaType: 'movie', tmdbId: 1438, title: 'Nope', year: 1 }), false, 'a TV id is not a movie id')
  assert.equal(T.isInLibrary(index, { mediaType: 'movie', tmdbId: 5, title: 'Brand New', year: 2025 }), false)
})

test('exclusion: falls back to title and year, for files TMDB never matched', () => {
  const { index } = T.buildLibrary(SOURCES())
  const cand = (title, year, mediaType = 'movie', tmdbId = 99999) => T.isInLibrary(index, { mediaType, tmdbId, title, year })
  assert.equal(cand('Unmatched Thing', 2010), true, 'title and year from the file name')
  assert.equal(cand('Unmatched Thing', 2011), true, 'a file name year is often one off')
  assert.equal(cand('Unmatched Thing', 2013), false, 'a different film with the same title')
  assert.equal(cand('Unmatched Thing', null), true, 'no year on the candidate: the title alone decides')
  assert.equal(cand('Ronin', 1998), true, 'a file with no year in its name still counts as owned')
  assert.equal(cand('unmatched   THING!', 2010), true, 'case and punctuation do not matter')
  assert.equal(cand('The Wire', 2002, 'tv'), true)
  assert.equal(cand('Mystery Show', 2020, 'tv'), true, 'an unmatched TV folder counts by its name')
  assert.equal(cand('Ronin', 1998, 'tv'), false, 'a movie title does not exclude a show')
  assert.equal(cand('Heat', 2013, 'movie', 12345), false, 'a different Heat, ten years later, is a different film')
})

test('exclusion: the original-language title of a library film matches too', () => {
  const { index } = T.buildLibrary({ movieFiles: [{ fileName: 'a.mkv', path: 'a' }], movieManifest: { 'a.mkv': { id: 1, title: 'Amelie', original_title: 'Le Fabuleux Destin d\'Amélie Poulain', release_date: '2001-04-25' } } })
  assert.equal(T.isInLibrary(index, { mediaType: 'movie', tmdbId: 2, title: "Le Fabuleux Destin d'Amélie Poulain", year: 2001 }), true)
  assert.equal(T.isInLibrary(index, { mediaType: 'movie', tmdbId: 2, title: 'Amelie', year: 2001 }), true)
})

test('library matching: every filter must hold (AND)', () => {
  const { items } = T.buildLibrary(SOURCES())
  const m = (raw) => T.matchLibrary(items, norm(raw)).map((i) => i.title)
  assert.deepEqual(m({}), ['Alien', 'Heat'])
  assert.deepEqual(m({ text: 'hea' }), ['Heat'])
  assert.deepEqual(m({ text: 'the heat' }), [], 'every word has to appear')
  assert.deepEqual(m({ genres: [28] }), ['Heat'])
  assert.deepEqual(m({ genres: [28, 80] }), ['Heat'])
  assert.deepEqual(m({ genres: [28, 27] }), [], 'no title is both')
  assert.deepEqual(m({ genres: [878] }), ['Alien'])
  assert.deepEqual(m({ yearFrom: 1990, yearTo: 1999 }), ['Heat'])
  assert.deepEqual(m({ yearFrom: 1979 }), ['Alien'])
  assert.deepEqual(m({ personId: 1158 }), ['Heat'])
  assert.deepEqual(m({ personId: 1158, genres: [27] }), [])
  assert.deepEqual(m({ personId: 1158, genres: [80], yearFrom: 1995, text: 'heat' }), ['Heat'])
  assert.deepEqual(m({ media: 'tv' }), ['Sci Show', 'The Wire'])
  assert.deepEqual(m({ media: 'tv', genres: [14] }), ['Sci Show'], 'a lumped TV genre answers to each film genre it stands for')
  assert.deepEqual(m({ media: 'tv', personId: 17 }), ['The Wire'])
})

// ---------------------------------------------------------------------------
// Restricted profiles

test('restricted profiles: no policy or an "off" policy is allowed; any active policy is refused', () => {
  assert.equal(T.viewerAccess(null).allowed, true)
  assert.equal(T.viewerAccess(undefined).allowed, true)
  assert.equal(T.viewerAccess(parental.OFF).allowed, true)
  for (const preset of ['young', 'kids', 'teens']) {
    const access = T.viewerAccess(parental.presetPolicy(preset))
    assert.deepEqual(access, { allowed: false, reason: 'restricted_profile' }, preset)
  }
  assert.equal(T.viewerAccess({ enabled: true }).allowed, false, 'switched on with no rules still counts')
  assert.equal(T.viewerAccess({ enabled: true, movieMax: 'R', tvMax: 'TV-MA' }).allowed, false, 'even a generous ceiling: certification is not known for suggestions')
  assert.equal(T.viewerAccess({ enabled: false, movieMax: 'G' }).allowed, true)
})

// ---------------------------------------------------------------------------
// Service, against a fake TMDB

function fakeTmdb(handler) {
  const calls = []
  const fetchImpl = async (url) => {
    const u = new URL(url)
    const params = Object.fromEntries(u.searchParams)
    const p = u.pathname.replace(/^\/3/, '')
    calls.push({ url, path: p, params })
    const out = await handler(p, params, calls.length)
    if (out && out.throw) throw new Error(out.throw)
    const status = out && out.status ? out.status : 200
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (h) => (out && out.retryAfter !== undefined && /retry-after/i.test(h) ? String(out.retryAfter) : null) },
      json: async () => (out && 'body' in out ? out.body : out)
    }
  }
  return { fetchImpl, calls }
}

function makeService(handler, over = {}) {
  const tmdb = fakeTmdb(handler)
  const opened = []
  const clock = { t: Date.UTC(2026, 8, 21, 12) }
  const svc = T.createTrailersService({
    getApiKey: () => 'test-key',
    getLanguage: () => 'en-US',
    getLibrarySources: async () => SOURCES(),
    openExternal: async (u) => { opened.push(u) },
    fetchImpl: tmdb.fetchImpl,
    sleep: async () => {},
    now: () => clock.t,
    ...over
  })
  return { svc, calls: tmdb.calls, opened, clock }
}

test('watch: opens the YouTube trailer TMDB lists, in the default browser only', async () => {
  const { svc, calls, opened } = makeService((p) => {
    assert.equal(p, '/movie/949/videos')
    return { results: [vid({ key: KEY_A, type: 'Teaser' }), vid({ key: 'dQw4w9WgXcQ', name: 'Official Trailer' }), vid({ site: 'Vimeo', key: KEY_C })] }
  })
  const res = await svc.watchTrailer({ tmdbId: 949, mediaType: 'movie' })
  assert.deepEqual(res, { ok: true, opened: 'trailer', name: 'Official Trailer' })
  assert.deepEqual(opened, ['https://www.youtube.com/watch?v=dQw4w9WgXcQ'])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].params.language, 'en-US')
  assert.ok(calls[0].params.include_video_language.split(',').includes('en'))
  assert.ok(!('api_key' in calls[0].params) || calls[0].params.api_key === 'test-key', 'the key goes to TMDB and nowhere else')
})

test('watch: the app language is asked for and preferred', async () => {
  const { svc, opened, calls } = makeService(() => ({ results: [vid({ key: KEY_A, iso_639_1: 'en' }), vid({ key: KEY_B, iso_639_1: 'fr' })] }), { getLanguage: () => 'fr-CA' })
  await svc.watchTrailer({ tmdbId: 5, mediaType: 'tv' })
  assert.equal(calls[0].path, '/tv/5/videos')
  assert.equal(calls[0].params.language, 'fr-CA')
  assert.equal(calls[0].params.include_video_language, 'fr,en,null')
  assert.deepEqual(opened, ['https://www.youtube.com/watch?v=' + KEY_B])
})

test('watch: a hostile key or link in TMDB\'s answer is never opened', async () => {
  const { svc, opened } = makeService((p) => {
    if (p.endsWith('/videos')) return { results: [vid({ key: 'abc"><script>', url: 'https://evil.example/x', link: 'javascript:alert(1)' }), vid({ key: 'x'.repeat(40) })] }
    return { title: 'Heat', release_date: '1995-12-15' }
  })
  const res = await svc.watchTrailer({ tmdbId: 949, mediaType: 'movie' })
  assert.deepEqual(res, { ok: true, opened: 'search', title: 'Heat' })
  assert.equal(opened.length, 1)
  assert.match(opened[0], /^https:\/\/www\.youtube\.com\/results\?search_query=Heat%201995%20trailer$/)
})

test('watch: with no trailer on TMDB, a labelled YouTube search for "<title> <year> trailer" opens instead', async () => {
  const { svc, opened } = makeService((p) => (p.endsWith('/videos') ? { results: [] } : { name: 'Fringe Show & Co', first_air_date: '2011-09-01' }))
  const res = await svc.watchTrailer({ tmdbId: 3, mediaType: 'tv' })
  assert.deepEqual(res, { ok: true, opened: 'search', title: 'Fringe Show & Co' })
  assert.equal(new URL(opened[0]).searchParams.get('search_query'), 'Fringe Show & Co 2011 trailer')
})

test('watch: videos are cached for a week, and "none yet" for a day', async () => {
  const { svc, calls, clock } = makeService((p) => (p === '/movie/1/videos' ? { results: [vid({ key: KEY_A })] } : p === '/movie/2/videos' ? { results: [] } : { title: 'Two', release_date: '2000-01-01' }))
  await svc.watchTrailer({ tmdbId: 1, mediaType: 'movie' })
  await svc.watchTrailer({ tmdbId: 1, mediaType: 'movie' })
  assert.equal(calls.length, 1)
  clock.t += T.TTL.videos - 1000
  await svc.watchTrailer({ tmdbId: 1, mediaType: 'movie' })
  assert.equal(calls.length, 1, 'still fresh just under 7 days')
  clock.t += 2000
  await svc.watchTrailer({ tmdbId: 1, mediaType: 'movie' })
  assert.equal(calls.length, 2, 'asked again after 7 days')

  await svc.watchTrailer({ tmdbId: 2, mediaType: 'movie' })
  const before = calls.length
  await svc.watchTrailer({ tmdbId: 2, mediaType: 'movie' })
  assert.equal(calls.length, before, 'the empty answer and the title are both cached')
  clock.t += T.TTL.videosNone + 1000
  await svc.watchTrailer({ tmdbId: 2, mediaType: 'movie' })
  assert.ok(calls.length > before, 'a title with no trailer is re-asked after a day')
})

test('watch: a tampered cache file cannot smuggle in a URL', async () => {
  const dir = tmpDir()
  const file = path.join(dir, 'trailers-cache.json')
  const tmdb = fakeTmdb(() => ({ results: [vid({ key: KEY_A })] }))
  const now = () => Date.UTC(2026, 8, 21)
  const cached = '/movie/7/videos?include_video_language=en,null&language=en-US'
  fs.writeFileSync(file, JSON.stringify({ v: 1, entries: { [cached]: { at: now(), exp: now() + 1e9, v: { trailer: { key: '"><script>alert(1)</script>', name: 'x' } } } } }))
  const opened = []
  const svc = T.createTrailersService({ getApiKey: () => 'k', cacheFile: file, fetchImpl: tmdb.fetchImpl, openExternal: async (u) => { opened.push(u) }, now })
  const res = await svc.watchTrailer({ tmdbId: 7, mediaType: 'movie' })
  assert.deepEqual(res, { ok: true, opened: 'trailer', name: 'Official Trailer' })
  assert.deepEqual(opened, ['https://www.youtube.com/watch?v=' + KEY_A], 'the damaged entry was ignored and TMDB asked again')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('watch: offline, rate limits, a bad key, no key and a browser that will not open are all plain errors', async () => {
  const offline = makeService(() => ({ throw: 'getaddrinfo ENOTFOUND' }))
  assert.deepEqual(await offline.svc.watchTrailer({ tmdbId: 1, mediaType: 'movie' }), { ok: false, error: 'offline' })
  assert.equal(offline.opened.length, 0)

  const serverError = makeService(() => ({ status: 503, body: {} }))
  assert.deepEqual(await serverError.svc.watchTrailer({ tmdbId: 1, mediaType: 'movie' }), { ok: false, error: 'tmdb_error' })

  const badKey = makeService(() => ({ status: 401, body: {} }))
  assert.deepEqual(await badKey.svc.watchTrailer({ tmdbId: 1, mediaType: 'movie' }), { ok: false, error: 'bad_api_key' })

  const missing = makeService(() => ({ status: 404, body: {} }))
  assert.deepEqual(await missing.svc.watchTrailer({ tmdbId: 1, mediaType: 'movie' }), { ok: false, error: 'not_found' })

  const noKey = makeService(() => ({ results: [] }), { getApiKey: () => '' })
  assert.deepEqual(await noKey.svc.watchTrailer({ tmdbId: 1, mediaType: 'movie' }), { ok: false, error: 'no_api_key' })
  assert.equal(noKey.calls.length, 0)

  const broken = makeService(() => ({ results: [vid()] }), { openExternal: async () => { throw new Error('no browser') } })
  assert.deepEqual(await broken.svc.watchTrailer({ tmdbId: 1, mediaType: 'movie' }), { ok: false, error: 'open_failed' })
})

test('rate limits: a 429 is retried after Retry-After, and a lasting one pauses further calls', async () => {
  let n = 0
  const waits = []
  const { svc, calls, clock } = makeService(() => (++n === 1 ? { status: 429, retryAfter: 2, body: {} } : { results: [vid({ key: KEY_A })] }), { sleep: async (ms) => { waits.push(ms) } })
  const res = await svc.watchTrailer({ tmdbId: 1, mediaType: 'movie' })
  assert.equal(res.ok, true)
  assert.deepEqual(waits, [2000], 'waited as long as TMDB asked')
  assert.equal(calls.length, 2)

  const busy = makeService(() => ({ status: 429, body: {} }))
  assert.deepEqual(await busy.svc.watchTrailer({ tmdbId: 1, mediaType: 'movie' }), { ok: false, error: 'rate_limited' })
  const after = busy.calls.length
  assert.deepEqual(await busy.svc.watchTrailer({ tmdbId: 2, mediaType: 'movie' }), { ok: false, error: 'rate_limited' })
  assert.equal(busy.calls.length, after, 'no more requests while cooling down')
  busy.clock.t += T.RATE_LIMIT_COOLDOWN_MS + 1
  await busy.svc.watchTrailer({ tmdbId: 3, mediaType: 'movie' })
  assert.ok(busy.calls.length > after, 'asks again once the pause is over')
  assert.ok(clock.t > 0)
})

test('requests to TMDB never run more than three at once', async () => {
  let running = 0
  let peak = 0
  const tmdb = fakeTmdb(async () => {
    running++
    peak = Math.max(peak, running)
    await new Promise((r) => setTimeout(r, 5))
    running--
    return { results: [] }
  })
  const svc = T.createTrailersService({ getApiKey: () => 'k', fetchImpl: tmdb.fetchImpl, sleep: async () => {}, openExternal: async () => {}, getLibrarySources: async () => ({}) })
  await Promise.all(Array.from({ length: 15 }, (_, i) => svc.watchTrailer({ tmdbId: i + 1, mediaType: 'movie' })))
  assert.ok(peak <= 3, 'peak ' + peak)
  assert.ok(peak >= 2, 'but they do overlap')
})

test('identical requests at the same moment share one TMDB call', async () => {
  const { svc, calls } = makeService(async () => {
    await new Promise((r) => setTimeout(r, 5))
    return { results: [vid()] }
  })
  await Promise.all([1, 2, 3, 4].map(() => svc.watchTrailer({ tmdbId: 9, mediaType: 'movie' })))
  assert.equal(calls.length, 1)
})

// ---------------------------------------------------------------------------
// Suggestions

const movieRow = (id, title, year, over) => ({ id, title, release_date: year + '-06-01', vote_average: 7.4, vote_count: 900, popularity: 50, poster_path: '/p' + id + '.jpg', overview: 'About ' + title + '.', genre_ids: [28], ...over })
const tvRow = (id, name, year, over) => ({ id, name, first_air_date: year + '-06-01', vote_average: 7.4, vote_count: 500, popularity: 50, poster_path: '/t' + id + '.jpg', overview: 'About ' + name + '.', genre_ids: [18], ...over })

test('suggestions with filters: discover, minus the library, minus junk', async () => {
  const { svc, calls } = makeService((p, params) => {
    assert.equal(p, '/discover/movie')
    assert.equal(params.include_adult, 'false')
    return {
      results: [
        movieRow(949, 'Heat', 1995), // in the library, by id
        movieRow(31000, 'Unmatched Thing', 2010), // in the library, by file name
        movieRow(500, 'Fresh One', 1996, { popularity: 90 }),
        movieRow(501, 'No Poster', 1996, { poster_path: null }),
        movieRow(502, 'Barely Rated', 1996, { vote_count: 3 }),
        movieRow(503, 'Fresh Two', 1997, { popularity: 10, vote_average: 8.8 }),
        { id: 504, title: 'Adult Thing', adult: true, poster_path: '/a.jpg', vote_count: 999, release_date: '1996-01-01' }
      ]
    }
  })
  const res = await svc.suggestions({ media: 'movie', genres: [28], yearFrom: 1990, yearTo: 1999 })
  assert.equal(res.basis, 'filters')
  assert.deepEqual(res.items.map((i) => i.title), ['Fresh One', 'Fresh Two'])
  const one = res.items[0]
  assert.deepEqual(Object.keys(one).sort(), ['mediaType', 'overview', 'posterUrl', 'rating', 'title', 'tmdbId', 'year'])
  assert.equal(one.posterUrl, 'https://image.tmdb.org/t/p/w342/p500.jpg')
  assert.equal(one.year, 1996)
  assert.equal(one.rating, 7.4)
  assert.equal(calls.length, 2, 'two discover pages')
  assert.deepEqual(calls.map((c) => c.params.page), ['1', '2'])
  assert.equal(calls[0].params.with_genres, '28')
  assert.equal(calls[0].params['primary_release_date.gte'], '1990-01-01')
})

test('suggestions: sorted by rating when asked', async () => {
  const { svc } = makeService(() => ({ results: [movieRow(1, 'A', 2000, { vote_average: 6.5, popularity: 99 }), movieRow(2, 'B', 2000, { vote_average: 8.9, popularity: 1 })] }))
  assert.deepEqual((await svc.suggestions({ genres: [28], sort: 'rating' })).items.map((i) => i.title), ['B', 'A'])
  assert.deepEqual((await svc.suggestions({ genres: [18] })).items.map((i) => i.title), ['A', 'B'])
})

test('suggestions with a title: /search then the other filters', async () => {
  const { svc, calls } = makeService((p, params) => {
    if (p === '/search/movie') return { results: [movieRow(600, 'Heat Wave', 1995, { genre_ids: [80] }), movieRow(601, 'Heat Rays', 2010, { genre_ids: [80] }), movieRow(602, 'Heat Storm', 1995, { genre_ids: [35] }), movieRow(949, 'Heat', 1995, { genre_ids: [80] })] }
    if (p === '/person/1158/movie_credits') return { cast: [{ id: 600 }, { id: 602 }, { id: 949 }] }
    throw new Error('unexpected ' + p)
  })
  const res = await svc.suggestions({ text: 'heat', genres: [80], yearFrom: 1995, yearTo: 1995, personId: 1158 })
  assert.deepEqual(res.items.map((i) => i.title), ['Heat Wave'], 'genre, year and actor all applied; Heat itself is owned')
  assert.ok(calls.some((c) => c.path === '/search/movie' && c.params.query === 'heat' && c.params.include_adult === 'false'))
})

test('suggestions for TV with an actor read that person\'s TV credits', async () => {
  const { svc, calls } = makeService((p) => {
    assert.equal(p, '/person/17/tv_credits')
    return { cast: [tvRow(2000, 'Fresh Show', 2010, { genre_ids: [18] }), tvRow(2000, 'Fresh Show', 2010), tvRow(1438, 'The Wire', 2002), tvRow(2001, 'Other Genre', 2010, { genre_ids: [35] })] }
  })
  const res = await svc.suggestions({ media: 'tv', personId: 17, genres: [18] })
  assert.deepEqual(res.items.map((i) => i.title), ['Fresh Show'])
  assert.equal(res.items[0].mediaType, 'tv')
  assert.equal(calls.length, 1)
})

test('suggestions with no filters: TMDB recommendations seeded from library ids, and only ids', async () => {
  const sources = SOURCES()
  const { svc, calls } = makeService((p, params) => {
    const m = /^\/movie\/(\d+)\/recommendations$/.exec(p)
    assert.ok(m, 'only recommendation calls, got ' + p)
    assert.equal(params.include_adult, 'false')
    return m[1] === '949'
      ? { results: [movieRow(700, 'Both Like', 2020), movieRow(701, 'Only Heat', 2019, { vote_average: 9 }), movieRow(348, 'Alien', 1979)] }
      : { results: [movieRow(700, 'Both Like', 2020), movieRow(702, 'Only Alien', 2018, { vote_average: 6.6 }), movieRow(31000, 'Unmatched Thing', 2010)] }
  }, { getLibrarySources: async () => sources })
  const res = await svc.suggestions({})
  assert.equal(res.basis, 'library')
  assert.deepEqual(res.items.map((i) => i.title), ['Both Like', 'Only Heat', 'Only Alien'], 'recommended by more of your titles first; owned titles left out')
  assert.deepEqual(calls.map((c) => c.path).sort(), ['/movie/348/recommendations', '/movie/949/recommendations'])
  const sent = calls.map((c) => c.url).join('\n')
  for (const private_ of ['Heat (1995)', 'Alien.mkv', 'D:', 'Movies', 'Pacino', 'Unmatched', 'the wire', 'R']) {
    if (private_ === 'R') continue
    assert.ok(!sent.includes(encodeURIComponent(private_)) && !sent.includes(private_), 'nothing about the library but ids leaves the app: ' + private_)
  }
  for (const c of calls) assert.deepEqual(Object.keys(c.params).sort(), ['api_key', 'include_adult', 'language', 'page'].filter((k) => k in c.params).sort())
})

test('suggestions with no filters use at most five library titles, the same five all day', async () => {
  const many = { movieFiles: [], movieManifest: {} }
  for (let i = 1; i <= 40; i++) {
    many.movieFiles.push({ fileName: 'm' + i + '.mkv', path: 'p' + i })
    many.movieManifest['m' + i + '.mkv'] = { id: 1000 + i, title: 'M' + i, release_date: '2000-01-01', vote_average: 7, genre_ids: [] }
  }
  const { svc, calls, clock } = makeService(() => ({ results: [] }), { getLibrarySources: async () => many })
  await svc.suggestions({})
  const first = calls.map((c) => c.path).sort()
  assert.equal(first.length, 5)
  await svc.suggestions({})
  assert.equal(calls.length, 5, 'cached for 12 hours')
  const svc2 = makeService(() => ({ results: [] }), { getLibrarySources: async () => many })
  await svc2.svc.suggestions({})
  assert.deepEqual(svc2.calls.map((c) => c.path).sort(), first, 'same day, same seeds')
  const tomorrow = makeService(() => ({ results: [] }), { getLibrarySources: async () => many })
  tomorrow.clock.t += 86400000
  await tomorrow.svc.suggestions({})
  assert.notDeepEqual(tomorrow.calls.map((c) => c.path).sort(), first, 'the next day it picks others')
  assert.ok(clock.t)
})

test('suggestions: results are cached for 12 hours, then asked again', async () => {
  const { svc, calls, clock } = makeService(() => ({ results: [movieRow(1, 'One', 2000)] }))
  await svc.suggestions({ genres: [35] })
  const n = calls.length
  await svc.suggestions({ genres: [35] })
  assert.equal(calls.length, n)
  clock.t += T.TTL.list + 1000
  await svc.suggestions({ genres: [35] })
  assert.equal(calls.length, n * 2)
})

test('suggestions with no filters and an empty library fall back to popular titles', async () => {
  const { svc, calls } = makeService(() => ({ results: [movieRow(1, 'Popular One', 2022)] }), { getLibrarySources: async () => ({ movieFiles: [], movieManifest: {} }) })
  const res = await svc.suggestions({})
  assert.equal(res.basis, 'popular')
  assert.equal(calls[0].path, '/discover/movie')
  assert.deepEqual(res.items.map((i) => i.title), ['Popular One'])
})

test('suggestions: a failed page two does not lose page one; a failed page one is a plain error', async () => {
  let n = 0
  const partial = makeService((p, params) => (params.page === '2' ? { status: 500, body: {} } : { results: [movieRow(++n, 'T' + n, 2000)] }))
  assert.equal((await partial.svc.suggestions({ genres: [28] })).items.length, 1)
  const failed = makeService(() => ({ throw: 'offline' }))
  await assert.rejects(() => failed.svc.suggestions({ genres: [28] }), (e) => e instanceof T.TrailersError && e.code === 'offline')
})

// ---------------------------------------------------------------------------
// People typeahead

test('person search: short input asks nothing; results are trimmed, adult entries dropped, and cached for the short TTL', async () => {
  const { svc, calls, clock } = makeService((p, params) => {
    assert.equal(p, '/search/person')
    assert.equal(params.include_adult, 'false')
    return { results: [
      { id: 1158, name: 'Al Pacino', known_for_department: 'Acting', popularity: 40, known_for: [{ title: 'Heat' }, { name: 'Show' }, { title: 'Third' }] },
      { id: 9, name: 'Adult Person', adult: true },
      { id: 'x', name: 'Bad id' },
      ...Array.from({ length: 12 }, (_, i) => ({ id: 2000 + i, name: 'Person ' + i, known_for: [] }))
    ] }
  })
  assert.deepEqual(await svc.searchPeople(''), [])
  assert.deepEqual(await svc.searchPeople('a'), [])
  assert.equal(calls.length, 0)
  const people = await svc.searchPeople('pacino')
  assert.equal(people.length, 8)
  assert.deepEqual(people[0], { id: 1158, name: 'Al Pacino', department: 'Acting', knownFor: ['Heat', 'Show'] })
  await svc.searchPeople('pacino')
  assert.equal(calls.length, 1)
  clock.t += T.TTL.person + 1000
  await svc.searchPeople('pacino')
  assert.equal(calls.length, 2, 'asked again after an hour')
})

// ---------------------------------------------------------------------------
// IPC

function fakeIpc() {
  const handlers = new Map()
  return { handlers, ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, call: (ch, payload) => handlers.get(ch)({}, payload) }
}

function registerIpc(handler, over = {}) {
  const ipc = fakeIpc()
  const tmdb = fakeTmdb(handler)
  const opened = []
  const dir = tmpDir()
  const { service } = ipcModule.register({
    ipcMain: ipc.ipcMain,
    shell: { openExternal: async (u) => { opened.push(u) } },
    getApiKey: () => 'secret-tmdb-key',
    getLanguage: () => 'en-US',
    getCacheDir: () => dir,
    getLibrarySources: async () => SOURCES(),
    fetchImpl: tmdb.fetchImpl,
    sleep: async () => {},
    ...over
  })
  return { ...ipc, tmdb, opened, dir, service, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

test('ipc: every channel is registered', () => {
  const t = registerIpc(() => ({ results: [] }))
  assert.deepEqual([...t.handlers.keys()].sort(), ['trailers:library', 'trailers:person', 'trailers:status', 'trailers:suggestions', 'trailers:watch'])
  t.cleanup()
})

test('ipc: watch takes a TMDB id and a media type, and refuses anything else, above all a URL', async () => {
  const t = registerIpc(() => ({ results: [vid({ key: KEY_A })] }))
  const refused = [
    { url: 'https://evil.example/phish' },
    { tmdbId: 1, mediaType: 'movie', url: 'https://evil.example/phish' },
    { tmdbId: 1, mediaType: 'movie', youtubeKey: KEY_A },
    { tmdbId: 1, mediaType: 'movie', extra: 1 },
    { tmdbId: 'https://evil.example', mediaType: 'movie' },
    { tmdbId: '1', mediaType: 'movie' },
    { tmdbId: 1.5, mediaType: 'movie' },
    { tmdbId: -1, mediaType: 'movie' },
    { tmdbId: 0, mediaType: 'movie' },
    { tmdbId: 1e20, mediaType: 'movie' },
    { tmdbId: NaN, mediaType: 'movie' },
    { tmdbId: 1, mediaType: 'person' },
    { tmdbId: 1, mediaType: 'https://evil.example' },
    { tmdbId: 1 },
    { mediaType: 'movie' },
    'https://evil.example',
    'watch?v=' + KEY_A,
    [1, 'movie'],
    null,
    undefined,
    42
  ]
  for (const bad of refused) {
    assert.deepEqual(await t.call('trailers:watch', bad), { ok: false, error: 'bad_request' }, JSON.stringify(bad))
  }
  assert.equal(t.tmdb.calls.length, 0, 'nothing was even looked up')
  assert.equal(t.opened.length, 0, 'and nothing was opened')
  assert.deepEqual(await t.call('trailers:watch', { tmdbId: 1, mediaType: 'movie' }), { ok: true, opened: 'trailer', name: 'Official Trailer' })
  assert.deepEqual(t.opened, ['https://www.youtube.com/watch?v=' + KEY_A])
  t.cleanup()
})

test('ipc: the TMDB key is never in an answer and the handlers never throw', async () => {
  const t = registerIpc((p) => (p === '/search/person' ? { throw: 'network down' } : { results: [movieRow(1, 'X', 2000)] }))
  const answers = [
    await t.call('trailers:status'),
    await t.call('trailers:person', 'pacino'),
    await t.call('trailers:library', {}),
    await t.call('trailers:suggestions', { genres: [28] }),
    await t.call('trailers:watch', { tmdbId: 5, mediaType: 'movie' })
  ]
  for (const a of answers) assert.ok(!JSON.stringify(a).includes('secret-tmdb-key'))
  assert.deepEqual(answers[0], { ok: true, allowed: true, hasKey: true })
  assert.deepEqual(answers[1], { ok: false, error: 'offline' })
  assert.equal(answers[3].ok, true)
  assert.deepEqual(await t.call('trailers:person', { not: 'a string' }), { ok: true, people: [] })
  t.cleanup()
})

test('ipc: library answers come from the app\'s index without touching TMDB', async () => {
  const t = registerIpc(() => { throw new Error('the library must not call TMDB') })
  const res = await t.call('trailers:library', { media: 'movie', genres: [80] })
  assert.equal(res.ok, true)
  assert.deepEqual(res.items.map((i) => i.title), ['Heat'])
  assert.equal(res.items[0].path, 'D:\\Movies\\Heat (1995).mkv')
  assert.ok(!('castIds' in res.items[0]))
  assert.equal(res.total, 1)
  assert.equal(t.tmdb.calls.length, 0)
  t.cleanup()
})

test('ipc: a restricted profile gets nothing, and TMDB and the browser are never touched', async () => {
  const t = registerIpc(() => ({ results: [vid()] }), { getViewerPolicy: () => parental.presetPolicy('kids') })
  assert.deepEqual(await t.call('trailers:status'), { ok: true, allowed: false, hasKey: true })
  for (const [ch, payload] of [['trailers:person', 'pacino'], ['trailers:library', {}], ['trailers:suggestions', {}], ['trailers:watch', { tmdbId: 1, mediaType: 'movie' }]]) {
    assert.deepEqual(await t.call(ch, payload), { ok: false, error: 'restricted_profile' }, ch)
  }
  assert.equal(t.tmdb.calls.length, 0)
  assert.equal(t.opened.length, 0)
  t.cleanup()
})

test('ipc: if the profile cannot be read the answer is no (fails closed)', async () => {
  const t = registerIpc(() => ({ results: [vid()] }), { getViewerPolicy: () => { throw new Error('store unreadable') } })
  assert.deepEqual(await t.call('trailers:watch', { tmdbId: 1, mediaType: 'movie' }), { ok: false, error: 'restricted_profile' })
  assert.equal((await t.call('trailers:status')).allowed, false)
  assert.equal(t.opened.length, 0)
  t.cleanup()
})

test('ipc: an owner (no policy) is allowed, and the cache lands in the folder the app names', async () => {
  const t = registerIpc(() => ({ results: [vid({ key: KEY_A })] }))
  await t.call('trailers:watch', { tmdbId: 11, mediaType: 'movie' })
  t.service.flush()
  const file = path.join(t.dir, 'trailers-cache.json')
  assert.ok(fs.existsSync(file))
  assert.ok(!fs.readFileSync(file, 'utf8').includes('secret-tmdb-key'), 'the key is not written to the cache')
  t.cleanup()
})

// ---------------------------------------------------------------------------
// Wiring: what the window can reach

test('the window cannot open URLs or see the key through the Trailers bridge', () => {
  const preload = fs.readFileSync(path.join(appRoot, 'electron', 'preload.js'), 'utf8')
  const bridge = /trailers: \{([\s\S]*?)\n  \},/.exec(preload)
  assert.ok(bridge, 'preload exposes trailers')
  assert.match(bridge[1], /ipcRenderer\.invoke\('trailers:watch', \{ tmdbId, mediaType \}\)/)
  assert.doesNotMatch(bridge[1], /openExternal|url|apiKey/i)
  const component = fs.readFileSync(path.join(appRoot, 'src', 'components', 'Trailers.jsx'), 'utf8')
  assert.doesNotMatch(component, /openExternal|window\.open|<iframe|youtube\.com|api\.themoviedb|tmdbApiKey/i, 'the screen never builds a URL or holds a key')
  const main = fs.readFileSync(path.join(appRoot, 'electron', 'main.js'), 'utf8')
  assert.match(main, /require\('\.\/trailersBrowseIpc'\)\.register\(/)
})
