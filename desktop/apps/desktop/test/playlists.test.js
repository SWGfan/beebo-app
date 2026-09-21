// Playlists and smart playlists: the rule engine, storage + authorization, the
// shared HTTP contract, migration, and surviving a backup + restore.
// Run: node --test test/playlists.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { createRequire } = require('node:module')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))
const playlists = localRequire('./electron/playlists')
const playlistCatalog = localRequire('./electron/playlistCatalog')
const playlistApi = localRequire('./electron/playlistApi')
const backup = localRequire('./electron/backup')

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000

function memStore(seed = {}) {
  const data = JSON.parse(JSON.stringify(seed))
  return {
    data,
    get: (k, d) => (k in data ? data[k] : d),
    set: (k, v) => { data[k] = JSON.parse(JSON.stringify(v)) },
    has: (k) => k in data,
    delete: (k) => { delete data[k] },
    get store() { return JSON.parse(JSON.stringify(data)) }
  }
}

const enc = (s) => Buffer.from(s, 'utf8').toString('base64url')

// --- a small library, built the way the server builds it ---------------------
const MOVIES = [
  { name: 'Die Hard (1988).mkv', meta: { id: 562, title: 'Die Hard', release_date: '1988-07-15', genre_ids: [28, 53], vote_average: 7.8, certification: 'R' }, added: NOW - 60 * DAY, q: '1080p' },
  { name: 'Speed (1994).mkv', meta: { id: 1637, title: 'Speed', release_date: '1994-06-10', genre_ids: [28, 12], vote_average: 7.2, certification: 'R', runtime: 116 }, added: NOW - 3 * DAY, q: '2160p' },
  { name: 'Toy Story (1995).mp4', meta: { id: 862, title: 'Toy Story', release_date: '1995-11-22', genre_ids: [16, 35], vote_average: 8.0, certification: 'G', runtime: 81 }, added: NOW - 10 * DAY, q: '720p' },
  { name: 'Heat (1995).mkv', meta: { id: 949, title: 'Heat', release_date: '1995-12-15', genre_ids: [28, 80], vote_average: 7.9, certification: 'R' }, added: NOW - 1 * DAY, q: '480p' },
  { name: 'Mystery Home Video.mp4', meta: null, added: 0, q: null, mtime: NOW - 400 * DAY }
]
const TV = [
  ['Office/Season 1/Office S01E01.mkv', 1, 1, 1320], ['Office/Season 1/Office S01E02.mkv', 1, 2, 1330],
  ['Office/Season 2/Office S02E01.mkv', 2, 1, 1300], ['Lost/Season 1/Lost S01E01.mkv', 1, 1, 2600],
  ['Lost/Season 1/Lost S01E02.mkv', 1, 2, 2550]
]
const TV_META = {
  [enc('office')]: { id: 2316, name: 'The Office', first_air_date: '2005-03-24', genre_ids: [35], vote_average: 8.6 },
  [enc('lost')]: { id: 4607, name: 'Lost', first_air_date: '2004-09-22', genre_ids: [18, 9648], vote_average: 7.9, episode_run_time: [42] }
}

// The movie/TV half of buildCatalog's input, shared by every fixture below so
// a test that adds tracks is still working from the exact same films and
// episodes as one that does not.
function screenCatalogInput() {
  const durations = new Map(TV.map(([rel, , , d]) => ['tv:' + rel, d]))
  durations.set('movie:Die Hard (1988).mkv', 7920)
  return {
    movies: MOVIES.map((m) => ({ id: enc(m.name), fileName: m.name, fullPath: 'M:/' + m.name, size: 1, mtimeMs: m.mtime || NOW - 500 * DAY })),
    tvFiles: TV.map(([rel, s, e]) => {
      const show = rel.split('/')[0]
      return { id: enc(rel), relPath: rel, fileName: path.basename(rel), fullPath: 'T:/' + rel, showKey: enc(show.toLowerCase()), showName: show, season: s, episode: e, size: 1, mtimeMs: NOW - 20 * DAY }
    }),
    movieMeta: (f) => MOVIES.find((m) => m.name === f).meta,
    tvMeta: (k) => TV_META[k] || null,
    genreNames: { movie: { 28: 'Action', 53: 'Thriller', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime' }, tv: { 35: 'Comedy', 18: 'Drama', 9648: 'Mystery' } },
    qualityOf: (full) => (MOVIES.find((m) => 'M:/' + m.name === full) || {}).q || null,
    addedAtOf: (full) => (MOVIES.find((m) => 'M:/' + m.name === full) || {}).added || 0,
    collectionOf: (id) => (id === 562 ? { id: 1570, name: 'Die Hard Collection' } : null),
    castOf: (kind, id) => (id === 1637 ? [{ id: 2963, name: 'Keanu Reeves' }, { id: 1, name: 'Sandra Bullock' }] : id === 2316 ? [{ id: 9, name: 'Steve Carell' }] : []),
    durations,
    movieTitle: (f, meta) => (meta && meta.title) || f.replace(/\.\w+$/, '')
  }
}

function library(extra = {}) {
  const catalog = playlistCatalog.buildCatalog({ ...screenCatalogInput(), ...extra })
  return { catalog, index: playlistCatalog.indexCatalog(catalog) }
}

// A handful of songs shaped exactly like musicLibrary.js's track records
// (library.trackList()): the tags the scanner actually reads, plus the
// albumId/artistId/albumArtistName rebuild() adds once tracks are grouped.
const TRACKS = [
  { id: 'trk_paranoid', title: 'Paranoid Android', artist: 'Radiohead', albumArtist: 'Radiohead', albumArtistName: 'Radiohead', album: 'OK Computer', albumId: 'alb_okcomputer', artistId: 'art_radiohead', trackNo: 2, discNo: 1, year: 1997, genre: 'Alternative Rock', duration: 383.5, lossless: false, coverId: 'cov_okcomputer', addedAt: NOW - 5 * DAY },
  { id: 'trk_karma', title: 'Karma Police', artist: 'Radiohead', albumArtist: 'Radiohead', albumArtistName: 'Radiohead', album: 'OK Computer', albumId: 'alb_okcomputer', artistId: 'art_radiohead', trackNo: 6, discNo: 1, year: 1997, genre: 'Alternative Rock', duration: 261, lossless: true, coverId: 'cov_okcomputer', addedAt: NOW - 40 * DAY },
  { id: 'trk_getlucky', title: 'Get Lucky', artist: 'Daft Punk', albumArtist: 'Daft Punk', albumArtistName: 'Daft Punk', album: 'Random Access Memories', albumId: 'alb_ram', artistId: 'art_daftpunk', trackNo: 8, discNo: 1, year: 2013, genre: 'Disco', duration: 369, lossless: true, coverId: 'cov_ram', addedAt: NOW - 2 * DAY },
  { id: 'trk_instant', title: 'Instant Crush', artist: 'Daft Punk', albumArtist: 'Daft Punk', albumArtistName: 'Daft Punk', album: 'Random Access Memories', albumId: 'alb_ram', artistId: 'art_daftpunk', trackNo: 5, discNo: 1, year: 2013, genre: 'Disco', duration: 337, lossless: false, coverId: 'cov_ram', addedAt: NOW - 100 * DAY }
]

const LIB = library()
const MUSIC = library({ tracks: TRACKS })
const byTitle = (items) => items.map((i) => i.title)
const movieId = (name) => enc(name)
const ctxFor = (over = {}) => playlistCatalog.buildViewerContext({
  now: NOW,
  watchedFiles: { 'movie:Die Hard (1988).mkv': { watched: true }, 'tv:Office/Season 1/Office S01E01.mkv': { watched: true } },
  resumable: [{ fileName: 'Speed (1994).mkv', kind: 'movie', percent: 40, currentTime: 2800, updatedAt: NOW - DAY }],
  continueRows: [{ fileName: 'Office/Season 1/Office S01E02.mkv', kind: 'tv', updatedAt: NOW - 2 * DAY }, { fileName: 'Lost/Season 1/Lost S01E02.mkv', kind: 'tv', updatedAt: NOW - 1000 }],
  viewed: [{ fileName: 'Office/Season 1/Office S01E01.mkv', kind: 'tv', updatedAt: NOW - 2 * DAY }],
  watchlist: [{ kind: 'movie', id: movieId('Heat (1995).mkv') }, { kind: 'tv', id: enc('lost'), showKey: enc('lost') }],
  flags: { ['movie:' + movieId('Toy Story (1995).mp4')]: { favorite: true } },
  ...over
})
const run = (rules, ctx = ctxFor(), opts) => playlists.evaluateRules(rules, LIB.catalog, ctx, opts)
const runMusic = (rules, ctx = ctxFor(), opts) => playlists.evaluateRules(rules, MUSIC.catalog, ctx, opts)
const cond = (field, op, value) => ({ match: 'all', conditions: [{ field, op, value }], sort: { by: 'title', dir: 'asc' } })

// ============================================================================
// Rules, one at a time
// ============================================================================
test('rule: media type', () => {
  assert.equal(run(cond('mediaType', 'is', 'movie')).length, 5)
  assert.equal(run(cond('mediaType', 'is', 'episode')).length, 5)
  assert.equal(run(cond('mediaType', 'isNot', 'movie')).length, 5)
})

test('rule: genre by name (any case) and by id, and is not', () => {
  assert.deepEqual(byTitle(run(cond('genre', 'is', 'action'))), ['Die Hard', 'Heat', 'Speed'])
  assert.deepEqual(byTitle(run(cond('genre', 'is', 35))), ['Office — S1E1', 'Office — S1E2', 'Office — S2E1', 'Toy Story'].map((t) => t.replace('Office', 'The Office')))
  // a title with no known genres is "not Action"
  assert.ok(byTitle(run(cond('genre', 'isNot', 'Action'))).includes('Mystery Home Video'))
})

test('rule: year is / range / between, and unknown years', () => {
  assert.deepEqual(byTitle(run(cond('year', 'is', 1995))), ['Heat', 'Toy Story'])
  assert.deepEqual(byTitle(run({ ...cond('year', 'between', [1994, 1988]), conditions: [{ field: 'year', op: 'between', value: [1994, 1988] }, { field: 'mediaType', op: 'is', value: 'movie' }] })), ['Die Hard', 'Speed'])
  assert.deepEqual(byTitle(run({ match: 'all', conditions: [{ field: 'year', op: 'lte', value: 1990 }] })), ['Die Hard'])
  assert.ok(!byTitle(run(cond('year', 'gte', 1900))).includes('Mystery Home Video'))
  assert.ok(byTitle(run(cond('year', 'isNot', 1995))).includes('Mystery Home Video'))
})

test('rule: decade', () => {
  assert.deepEqual(byTitle(run({ match: 'all', conditions: [{ field: 'decade', op: 'is', value: 1990 }, { field: 'mediaType', op: 'is', value: 'movie' }] })), ['Heat', 'Speed', 'Toy Story'])
  // any year inside the decade normalises to it
  assert.deepEqual(playlists.validateRules(cond('decade', 'is', 1997)).conditions[0].value, 1990)
})

test('rule: rating and certification', () => {
  assert.deepEqual(byTitle(run({ match: 'all', conditions: [{ field: 'rating', op: 'gte', value: 7.9 }, { field: 'mediaType', op: 'is', value: 'movie' }] })), ['Heat', 'Toy Story'])
  assert.deepEqual(byTitle(run(cond('certification', 'is', 'g'))), ['Toy Story'])
  assert.equal(run(cond('certification', 'isNot', 'R')).filter((i) => i.type === 'movie').length, 2)
})

test('rule: added in the last N days (falls back to the file date)', () => {
  assert.deepEqual(byTitle(run({ match: 'all', conditions: [{ field: 'addedDays', op: 'inLast', value: 7 }] })), ['Heat', 'Speed'])
  assert.ok(byTitle(run(cond('addedDays', 'notInLast', 365))).includes('Mystery Home Video'))
  assert.ok(byTitle(run(cond('addedDays', 'inLast', 30))).includes('The Office — S1E1'))
})

test('rule: watched / unwatched / in progress are per viewer', () => {
  assert.deepEqual(byTitle(run(cond('watchState', 'is', 'watched'))), ['Die Hard', 'The Office — S1E1'])
  assert.deepEqual(byTitle(run(cond('watchState', 'is', 'inProgress'))), ['Speed'])
  assert.equal(run(cond('watchState', 'is', 'unwatched')).length, 7)
  // someone else, who has watched nothing
  const other = playlistCatalog.buildViewerContext({ now: NOW })
  assert.equal(run(cond('watchState', 'is', 'unwatched'), other).length, 10)
})

test('rule: quality classes and at least', () => {
  assert.deepEqual(byTitle(run(cond('quality', 'is', '4K'))), ['Speed'])
  assert.deepEqual(byTitle(run(cond('quality', 'is', 'HD'))), ['Die Hard', 'Toy Story'])
  assert.deepEqual(byTitle(run(cond('quality', 'atLeast', 'HD'))), ['Die Hard', 'Speed', 'Toy Story'])
  assert.deepEqual(byTitle(run(cond('quality', 'is', 'SD'))), ['Heat'])
})

test('rule: duration uses real play lengths, then TMDB runtime; unknown never matches', () => {
  assert.deepEqual(byTitle(run(cond('durationMinutes', 'lte', 30))), ['The Office — S1E1', 'The Office — S1E2', 'The Office — S2E1'])
  assert.deepEqual(byTitle(run(cond('durationMinutes', 'gte', 110))), ['Die Hard', 'Speed'])
  assert.deepEqual(byTitle(run(cond('durationMinutes', 'between', [80, 90]))), ['Toy Story'])
  assert.ok(!byTitle(run(cond('durationMinutes', 'gte', 0))).includes('Heat'))
})

test('rule: actor by id or name, collection, show', () => {
  assert.deepEqual(byTitle(run(cond('actor', 'is', 2963))), ['Speed'])
  assert.deepEqual(byTitle(run(cond('actor', 'is', 'steve carell'))), ['The Office — S1E1', 'The Office — S1E2', 'The Office — S2E1'])
  assert.deepEqual(byTitle(run(cond('collection', 'is', 1570))), ['Die Hard'])
  assert.deepEqual(byTitle(run(cond('collection', 'is', 'die hard collection'))), ['Die Hard'])
  assert.equal(run(cond('show', 'is', enc('lost'))).length, 2)
  assert.equal(run(cond('show', 'is', 'Lost')).length, 2)
  assert.equal(run(cond('show', 'isNot', 'Lost')).length, 8)
})

test('rule: title contains, watchlist, favourites, continue watching', () => {
  assert.deepEqual(byTitle(run(cond('title', 'contains', 'ha'))), ['Die Hard'])
  assert.deepEqual(byTitle(run(cond('inWatchlist', 'is', true))), ['Heat', 'Lost — S1E1', 'Lost — S1E2'])
  assert.deepEqual(byTitle(run(cond('favorite', 'is', true))), ['Toy Story'])
  assert.deepEqual(byTitle(run(cond('onDeck', 'is', true))), ['Lost — S1E2', 'The Office — S1E2'])
})

// ============================================================================
// Music: smart playlists over tracks (musicLibrary.js), same rule engine
// ============================================================================
const trackCond = (field, op, value) => ({
  match: 'all',
  conditions: [{ field: 'mediaType', op: 'is', value: 'track' }, { field, op, value }],
  sort: { by: 'title', dir: 'asc' }
})

test('rule: media type "track" only matches songs, and counts alongside movies/episodes', () => {
  assert.equal(runMusic(cond('mediaType', 'is', 'track')).length, 4)
  assert.equal(runMusic(cond('mediaType', 'is', 'movie')).length, 5)
  assert.equal(runMusic(cond('mediaType', 'is', 'episode')).length, 5)
  assert.equal(runMusic({ match: 'all', conditions: [] }).length, 14)
})

test('rule: genre matches a track\'s tag the same way it matches a film\'s', () => {
  assert.deepEqual(byTitle(runMusic(trackCond('genre', 'is', 'alternative rock'))), ['Karma Police', 'Paranoid Android'])
  assert.deepEqual(byTitle(runMusic(trackCond('genre', 'is', 'Disco'))), ['Get Lucky', 'Instant Crush'])
  assert.equal(runMusic(trackCond('genre', 'isNot', 'Disco')).length, 2)
})

test('rule: artist by name or id, and album by name or id', () => {
  assert.deepEqual(byTitle(runMusic(trackCond('artist', 'is', 'Radiohead'))), ['Karma Police', 'Paranoid Android'])
  assert.deepEqual(byTitle(runMusic(trackCond('artist', 'is', 'art_daftpunk'))), ['Get Lucky', 'Instant Crush'])
  assert.deepEqual(byTitle(runMusic(trackCond('artist', 'isNot', 'Radiohead'))), ['Get Lucky', 'Instant Crush'])
  assert.deepEqual(byTitle(runMusic(trackCond('album', 'is', 'Random Access Memories'))), ['Get Lucky', 'Instant Crush'])
  assert.deepEqual(byTitle(runMusic(trackCond('album', 'is', 'alb_okcomputer'))), ['Karma Police', 'Paranoid Android'])
})

test('rule: lossless audio, and duration works in minutes like it does for video', () => {
  assert.deepEqual(byTitle(runMusic(trackCond('lossless', 'is', true))), ['Get Lucky', 'Karma Police'])
  assert.deepEqual(byTitle(runMusic(trackCond('lossless', 'is', false))), ['Instant Crush', 'Paranoid Android'])
  assert.deepEqual(byTitle(runMusic(trackCond('durationMinutes', 'lte', 5))), ['Karma Police'])
})

test('rule: added in the last N days works for tracks exactly like it does for movies', () => {
  assert.deepEqual(byTitle(runMusic(trackCond('addedDays', 'inLast', 7))), ['Get Lucky', 'Paranoid Android'])
  assert.deepEqual(byTitle(runMusic(trackCond('addedDays', 'notInLast', 30))), ['Instant Crush', 'Karma Police'])
})

test('rule: year/decade and title-contains are generic, so they already work for tracks', () => {
  assert.deepEqual(byTitle(runMusic(trackCond('year', 'is', 1997))), ['Karma Police', 'Paranoid Android'])
  assert.deepEqual(byTitle(runMusic(trackCond('decade', 'is', 2010))), ['Get Lucky', 'Instant Crush'])
  assert.deepEqual(byTitle(runMusic(trackCond('title', 'contains', 'lucky'))), ['Get Lucky'])
})

test('sort: artist and album group songs the way "show" groups episodes', () => {
  const tracks = (sort) => byTitle(runMusic({ match: 'all', conditions: [{ field: 'mediaType', op: 'is', value: 'track' }], sort }))
  assert.deepEqual(tracks({ by: 'artist' }), ['Get Lucky', 'Instant Crush', 'Karma Police', 'Paranoid Android'])
  assert.deepEqual(tracks({ by: 'artist', dir: 'desc' }), ['Karma Police', 'Paranoid Android', 'Get Lucky', 'Instant Crush'])
  assert.deepEqual(tracks({ by: 'album' }), ['Karma Police', 'Paranoid Android', 'Get Lucky', 'Instant Crush'])
})

test('rules with fields no track has (rating, actor, watch state...) never match, they do not crash', () => {
  assert.deepEqual(runMusic(trackCond('rating', 'gte', 0)), [])
  // watchState defaults to 'unwatched' for anything with no history, tracks included -
  // 'watched'/'inProgress' are the ones that genuinely need per-track history nobody keeps yet.
  assert.deepEqual(runMusic(trackCond('watchState', 'is', 'watched')), [])
  assert.deepEqual(runMusic(trackCond('watchState', 'is', 'inProgress')), [])
  assert.deepEqual(runMusic(trackCond('favorite', 'is', true)), [])
})

test('no regression: a catalog that also has tracks still gives movie/episode smart playlists the exact same answer', () => {
  const movieOnly = (catalog) => byTitle(playlists.evaluateRules(playlists.templateById('90s-action').rules, catalog, ctxFor()))
  assert.deepEqual(movieOnly(MUSIC.catalog), movieOnly(LIB.catalog))
  const unwatched = (catalog) => byTitle(playlists.evaluateRules(playlists.templateById('unwatched-this-month').rules, catalog, ctxFor()))
  assert.deepEqual(unwatched(MUSIC.catalog), unwatched(LIB.catalog))
  const shows = (catalog) => byTitle(playlists.evaluateRules({ match: 'all', conditions: [{ field: 'mediaType', op: 'is', value: 'episode' }], sort: { by: 'show' } }, catalog, ctxFor()))
  assert.deepEqual(shows(MUSIC.catalog), shows(LIB.catalog))
})

// ============================================================================
// Combinations, sort, limit
// ============================================================================
test('combos: all / any / nested groups', () => {
  const anyRules = { match: 'any', conditions: [{ field: 'certification', op: 'is', value: 'G' }, { field: 'quality', op: 'is', value: '4K' }], sort: { by: 'title', dir: 'asc' } }
  assert.deepEqual(byTitle(run(anyRules)), ['Speed', 'Toy Story'])
  const nested = {
    match: 'all',
    conditions: [
      { match: 'any', conditions: [{ field: 'genre', op: 'is', value: 'Animation' }, { field: 'genre', op: 'is', value: 'Crime' }] },
      { field: 'decade', op: 'is', value: 1990 }
    ],
    sort: { by: 'title', dir: 'asc' }
  }
  assert.deepEqual(byTitle(run(nested)), ['Heat', 'Toy Story'])
  // no conditions = the whole library
  assert.equal(run({ match: 'all', conditions: [] }).length, 10)
})

test('sort: added, title, year, rating, duration, last watched; unknowns last', () => {
  const movies = (sort) => byTitle(run({ match: 'all', conditions: [{ field: 'mediaType', op: 'is', value: 'movie' }], sort }))
  assert.deepEqual(movies({ by: 'added', dir: 'desc' }), ['Heat', 'Speed', 'Toy Story', 'Die Hard', 'Mystery Home Video'])
  assert.deepEqual(movies({ by: 'title', dir: 'asc' }), ['Die Hard', 'Heat', 'Mystery Home Video', 'Speed', 'Toy Story'])
  assert.deepEqual(movies({ by: 'title', dir: 'desc' }), ['Toy Story', 'Speed', 'Mystery Home Video', 'Heat', 'Die Hard'])
  assert.deepEqual(movies({ by: 'year', dir: 'asc' }), ['Die Hard', 'Speed', 'Heat', 'Toy Story', 'Mystery Home Video'])
  assert.deepEqual(movies({ by: 'rating', dir: 'desc' }), ['Toy Story', 'Heat', 'Die Hard', 'Speed', 'Mystery Home Video'])
  assert.deepEqual(movies({ by: 'duration', dir: 'desc' }), ['Die Hard', 'Speed', 'Toy Story', 'Heat', 'Mystery Home Video'])
  const eps = byTitle(run({ match: 'all', conditions: [{ field: 'onDeck', op: 'is', value: true }], sort: { by: 'lastWatched', dir: 'desc' } }))
  assert.deepEqual(eps, ['Lost — S1E2', 'The Office — S1E2'])
  const show = byTitle(run({ match: 'all', conditions: [{ field: 'mediaType', op: 'is', value: 'episode' }], sort: { by: 'show' } }))
  assert.deepEqual(show, ['Lost — S1E1', 'Lost — S1E2', 'The Office — S1E1', 'The Office — S1E2', 'The Office — S2E1'])
})

test('limit keeps the first N after sorting', () => {
  const r = run({ match: 'all', conditions: [], sort: { by: 'added', dir: 'desc' }, limit: 2 })
  assert.deepEqual(byTitle(r), ['Heat', 'Speed'])
})

test('random sort is stable for a seed (one session) and differs across seeds', () => {
  const rules = { match: 'all', conditions: [], sort: { by: 'random' } }
  const a = byTitle(run(rules, ctxFor(), { seed: 42 }))
  const b = byTitle(run(rules, ctxFor(), { seed: 42 }))
  assert.deepEqual(a, b)
  const orders = new Set([1, 2, 3, 4, 5, 6].map((s) => byTitle(run(rules, ctxFor(), { seed: s })).join('|')))
  assert.ok(orders.size > 1)
  // a string session id works as a seed too
  assert.deepEqual(byTitle(run(rules, ctxFor(), { seed: 'session-abc' })), byTitle(run(rules, ctxFor(), { seed: 'session-abc' })))
  // limit + random picks the same items for the same seed
  const lim = { ...rules, limit: 3 }
  assert.deepEqual(byTitle(run(lim, ctxFor(), { seed: 7 })), byTitle(run(lim, ctxFor(), { seed: 7 })))
})

test('the allow seam hides items (parental controls)', () => {
  const allow = (it) => it.certification !== 'R'
  assert.ok(run({ match: 'all', conditions: [] }, ctxFor(), { allow }).every((i) => i.certification !== 'R'))
})

test('validation rejects bad rules', () => {
  const bad = [
    null, { conditions: 'x' }, cond('nope', 'is', 1), cond('year', 'contains', 1990), cond('year', 'is', 'soon'),
    cond('rating', 'gte', 11), cond('addedDays', 'inLast', 0), cond('inWatchlist', 'is', 'yes'),
    cond('quality', 'is', '8K'), cond('year', 'between', [1990]), { match: 'all', conditions: [], limit: -1 },
    { match: 'all', conditions: Array.from({ length: 31 }, () => ({ field: 'mediaType', op: 'is', value: 'movie' })) },
    { match: 'all', conditions: [{ match: 'any', conditions: [{ match: 'any', conditions: [{ match: 'all', conditions: [] }] }] }] }
  ]
  for (const r of bad) assert.throws(() => playlists.validateRules(r), (e) => e instanceof playlists.PlaylistError && e.code.startsWith('bad_rules'), JSON.stringify(r))
  // defaults
  const clean = playlists.validateRules({ conditions: [{ field: 'mediaType', value: 'movie', junk: 1 }] })
  assert.deepEqual(clean, { match: 'all', conditions: [{ field: 'mediaType', op: 'is', value: 'movie' }], sort: { by: 'added', dir: 'desc' }, limit: null })
})

test('templates are valid and do what they say', () => {
  for (const t of playlists.TEMPLATES) playlists.validateRules(t.rules)
  const tpl = (id) => byTitle(run(playlists.templateById(id).rules))
  assert.deepEqual(tpl('unwatched-this-month'), ['Heat', 'Speed', 'Toy Story'])
  assert.deepEqual(tpl('90s-action'), ['Speed', 'Heat'])
  assert.equal(tpl('short-episodes').length, 2) // S1E1 is watched
  assert.deepEqual(tpl('continue-my-shows'), ['Lost — S1E2', 'The Office — S1E2'])
})

// ============================================================================
// CRUD + authorization
// ============================================================================
const OWNER = { id: 'owner', isAdmin: true, name: 'Nick' }
const KID = { id: 'kid', isAdmin: false, name: 'Sam' }
const GUEST = { id: 'guest', isAdmin: false, name: 'Guest' }

test('create, rename, add, reorder, remove, delete', () => {
  const store = memStore()
  const p = playlists.create(store, KID, { name: '  Movie   night ' }, { now: NOW })
  assert.equal(p.name, 'Movie night')
  assert.equal(p.kind, 'manual')
  const items = playlistCatalog.expandAdd([{ type: 'movie', id: movieId('Speed (1994).mkv') }, { type: 'season', showKey: enc('office'), season: 1 }], LIB.index)
  assert.equal(items.length, 3)
  let out = playlists.addItems(store, KID, p.id, items)
  assert.equal(out.added, 3)
  // adding again is deduped
  assert.equal(playlists.addItems(store, KID, p.id, items.slice(0, 1)).added, 0)
  // a whole show expands in watching order
  out = playlists.addItems(store, KID, p.id, playlistCatalog.expandAdd({ type: 'show', showKey: enc('office') }, LIB.index))
  assert.equal(out.added, 1)
  let cur = playlists.get(store, KID, p.id)
  assert.deepEqual(cur.items.map((i) => i.title), ['Speed', 'The Office — S1E1', 'The Office — S1E2', 'The Office — S2E1'])
  // move the last to the front
  cur = playlists.moveItems(store, KID, p.id, { entryId: cur.items[3].entryId, toIndex: 0 })
  assert.equal(cur.items[0].title, 'The Office — S2E1')
  // full order
  const rev = cur.items.map((i) => i.entryId).reverse()
  cur = playlists.moveItems(store, KID, p.id, { order: rev })
  assert.deepEqual(cur.items.map((i) => i.entryId), rev)
  // insert at a position ("play next" style)
  cur = playlists.addItems(store, KID, p.id, [{ type: 'movie', id: movieId('Heat (1995).mkv'), title: 'Heat' }], { position: 1 }).playlist
  assert.equal(cur.items[1].title, 'Heat')
  cur = playlists.removeItems(store, KID, p.id, [cur.items[1].entryId]).playlist
  assert.equal(cur.items.length, 4)
  playlists.update(store, KID, p.id, { name: 'Renamed' })
  assert.equal(playlists.get(store, KID, p.id).name, 'Renamed')
  assert.throws(() => playlists.update(store, KID, p.id, { name: '   ' }), /missing_name/)
  assert.throws(() => playlists.update(store, KID, p.id, { name: 'x'.repeat(101) }), /name_too_long/)
  playlists.remove(store, KID, p.id)
  assert.throws(() => playlists.get(store, KID, p.id), /not_found/)
})

test('expandAdd refuses what the library does not have, keeps future types', () => {
  assert.throws(() => playlistCatalog.expandAdd({ type: 'movie', id: 'nope' }, LIB.index), /not_found/)
  assert.throws(() => playlistCatalog.expandAdd({ type: 'show', showKey: 'nope' }, LIB.index), /not_found/)
  assert.throws(() => playlistCatalog.expandAdd({ type: 'season', showKey: enc('lost'), season: 9 }, LIB.index), /not_found/)
  assert.throws(() => playlistCatalog.expandAdd({ type: 'Bad Type!', id: 'x' }, LIB.index), /bad_item/)
  assert.deepEqual(playlistCatalog.expandAdd({ type: 'track', id: 'trk_1', title: 'Song' }, LIB.index), [{ type: 'track', id: 'trk_1', title: 'Song' }])
})

test('authorization: private to the person, shared read-only, only the owner shares', () => {
  const store = memStore()
  const mine = playlists.create(store, KID, { name: 'Mine' })
  // another member cannot see, edit or learn it exists
  assert.throws(() => playlists.get(store, GUEST, mine.id), (e) => e.code === 'not_found' && e.status === 404)
  assert.throws(() => playlists.update(store, GUEST, mine.id, { name: 'x' }), (e) => e.code === 'not_found')
  assert.throws(() => playlists.remove(store, GUEST, mine.id), (e) => e.code === 'not_found')
  assert.throws(() => playlists.addItems(store, GUEST, mine.id, [{ type: 'movie', id: 'a' }]), (e) => e.code === 'not_found')
  assert.deepEqual(playlists.listFor(store, GUEST), [])
  // a member cannot share
  assert.throws(() => playlists.create(store, KID, { name: 'Family', shared: true }), (e) => e.code === 'only_owner_can_share' && e.status === 403)
  assert.throws(() => playlists.update(store, KID, mine.id, { shared: true }), /only_owner_can_share/)
  // even the owner cannot edit someone's private list
  assert.throws(() => playlists.update(store, OWNER, mine.id, { name: 'x' }), /not_found/)
  // the owner shares one: everybody sees it, nobody else edits it
  const fam = playlists.create(store, OWNER, { name: 'Family night', shared: true })
  assert.equal(playlists.get(store, GUEST, fam.id).name, 'Family night')
  assert.throws(() => playlists.update(store, GUEST, fam.id, { name: 'hacked' }), (e) => e.code === 'forbidden' && e.status === 403)
  assert.throws(() => playlists.addItems(store, KID, fam.id, [{ type: 'movie', id: 'a' }]), /forbidden/)
  assert.throws(() => playlists.remove(store, KID, fam.id), /forbidden/)
  // the list: own first
  assert.deepEqual(playlists.listFor(store, KID).map((p) => p.name), ['Mine', 'Family night'])
  // unsharing hides it again
  playlists.update(store, OWNER, fam.id, { shared: false })
  assert.deepEqual(playlists.listFor(store, KID).map((p) => p.name), ['Mine'])
  // no viewer at all
  assert.throws(() => playlists.create(store, null, { name: 'x' }), /unauthorized/)
})

test('smart playlists: created from a template, rules editable, items automatic', () => {
  const store = memStore()
  const p = playlists.create(store, KID, { template: '90s-action' })
  assert.equal(p.kind, 'smart')
  assert.equal(p.name, '90s action')
  assert.throws(() => playlists.addItems(store, KID, p.id, [{ type: 'movie', id: 'x' }]), /smart_playlist_is_automatic/)
  playlists.update(store, KID, p.id, { rules: cond('genre', 'is', 'Comedy') })
  assert.equal(playlists.get(store, KID, p.id).rules.conditions[0].value, 'Comedy')
  assert.throws(() => playlists.update(store, KID, p.id, { rules: cond('genre', 'bogus', 1) }), /bad_rules/)
  const manual = playlists.create(store, KID, { name: 'plain' })
  assert.throws(() => playlists.update(store, KID, manual.id, { rules: cond('genre', 'is', 'Comedy') }), /not_smart/)
  assert.throws(() => playlists.create(store, KID, { template: 'nope' }), /unknown_template/)
})

test('limits: playlists per person and items per playlist', () => {
  const store = memStore()
  for (let i = 0; i < playlists.MAX_PLAYLISTS_PER_USER; i++) playlists.create(store, KID, { name: 'p' + i })
  assert.throws(() => playlists.create(store, KID, { name: 'one more' }), /too_many_playlists/)
  // someone else is not affected
  playlists.create(store, GUEST, { name: 'fine' })
  const big = playlists.create(store, GUEST, { name: 'big' })
  const many = Array.from({ length: playlists.MAX_ITEMS }, (_, i) => ({ type: 'movie', id: 'm' + i }))
  playlists.addItems(store, GUEST, big.id, many)
  assert.throws(() => playlists.addItems(store, GUEST, big.id, [{ type: 'movie', id: 'extra' }]), /playlist_full/)
})

test('deleting a person removes their playlists and progress only', () => {
  const store = memStore()
  const a = playlists.create(store, KID, { name: 'a' })
  playlists.create(store, OWNER, { name: 'b', shared: true })
  playlists.recordProgress(store, KID, a.id, { entryId: 'e_x', index: 2 })
  assert.equal(playlists.removeUserData(store, KID.id), 1)
  assert.equal(playlists.countFor(store, OWNER.id), 1)
  assert.equal(store.data.playlists.progress.kid, undefined)
})

// ============================================================================
// Playback order + resume
// ============================================================================
test('play order: in order, shuffled by seed, resume finds the saved entry', () => {
  const entries = ['a', 'b', 'c', 'd', 'e', 'f'].map((x) => ({ entryId: x }))
  assert.deepEqual(playlists.playOrder(entries).map((e) => e.entryId), ['a', 'b', 'c', 'd', 'e', 'f'])
  const s1 = playlists.playOrder(entries, { shuffle: true, seed: 99 }).map((e) => e.entryId)
  assert.deepEqual(playlists.playOrder(entries, { shuffle: true, seed: 99 }).map((e) => e.entryId), s1)
  assert.deepEqual([...s1].sort(), ['a', 'b', 'c', 'd', 'e', 'f'])
  assert.equal(playlists.resumeIndex(entries, { entryId: 'd', index: 0 }), 3)
  // the entry was removed since: fall back to the index, clamped
  assert.equal(playlists.resumeIndex(entries, { entryId: 'gone', index: 4 }), 4)
  assert.equal(playlists.resumeIndex(entries, { entryId: 'gone', index: 40 }), 5)
  assert.equal(playlists.resumeIndex(entries, null), 0)
})

// ============================================================================
// The shared HTTP contract
// ============================================================================
function apiDeps(store, over = {}) {
  return {
    store,
    catalog: () => LIB,
    context: () => ctxFor(),
    decorate: (it) => ({ poster: '/poster/' + it.id, stream: (it.type === 'episode' ? '/tvfile?id=' : it.type === 'movie' ? '/file?id=' : '/track?id=') + it.id }),
    allow: () => null,
    userName: (id) => (id === 'owner' ? 'Nick' : id),
    ...over
  }
}
const call = (store, viewer, method, p, body, query = '', over) =>
  playlistApi.handle({ method, path: p, body, viewer, query: new URLSearchParams(query) }, apiDeps(store, over))

test('api: create with items, detail, play in order + shuffled, resume', () => {
  const store = memStore()
  const music = { catalog: () => MUSIC } // a server whose music library has scanned trk_karma
  let r = call(store, KID, 'POST', '', { name: 'Sunday', add: [{ type: 'show', showKey: enc('lost') }, { type: 'movie', id: movieId('Toy Story (1995).mp4') }, { type: 'track', id: 'trk_karma' }] }, '', music)
  assert.equal(r.status, 200)
  const id = r.body.playlist.id
  assert.deepEqual(byTitle(r.body.items), ['Lost — S1E1', 'Lost — S1E2', 'Toy Story', 'Karma Police'])
  assert.equal(r.body.skipped, 0) // a track resolves against the music library, same as a movie against the film one
  assert.equal(r.body.items[0].stream, '/tvfile?id=' + enc('Lost/Season 1/Lost S01E01.mkv'))
  assert.equal(r.body.items[3].stream, '/track?id=trk_karma')
  assert.equal(store.data.playlists.lists[0].items.length, 4)

  r = call(store, KID, 'GET', id + '/play', null, '', music)
  assert.deepEqual(byTitle(r.body.items), ['Lost — S1E1', 'Lost — S1E2', 'Toy Story', 'Karma Police'])
  assert.equal(r.body.startIndex, 0)

  const sh = call(store, KID, 'GET', id + '/play', null, 'shuffle=1&seed=1234', music)
  assert.equal(sh.body.shuffle, true)
  assert.deepEqual(byTitle(call(store, KID, 'GET', id + '/play', null, 'shuffle=1&seed=1234', music).body.items), byTitle(sh.body.items))

  // progress on the 2nd shuffled item, then resume without a seed: same order, same place
  assert.equal(call(store, KID, 'POST', id + '/progress', { entryId: sh.body.items[1].entryId, index: 1, shuffle: true, seed: sh.body.seed }, '', music).status, 200)
  const resumed = call(store, KID, 'GET', id + '/play', null, 'shuffle=1&resume=1', music)
  assert.deepEqual(byTitle(resumed.body.items), byTitle(sh.body.items))
  assert.equal(resumed.body.startIndex, 1)
})

test('api: a track missing from the music library shows up unavailable, like a deleted movie', () => {
  const store = memStore()
  const id = call(store, KID, 'POST', '', { name: 'x', add: [{ type: 'movie', id: movieId('Heat (1995).mkv') }, { type: 'track', id: 'trk_not_scanned' }] }).body.playlist.id
  const r = call(store, KID, 'GET', id) // default apiDeps: catalog has no music at all
  assert.deepEqual(r.body.items.map((i) => [i.title, i.available]), [['Heat', true], ['No longer in the library', false]])
  assert.equal(r.body.skipped, 0)
})

test('api: items add/remove/move, errors are JSON with the right status', () => {
  const store = memStore()
  const id = call(store, KID, 'POST', '', { name: 'x' }).body.playlist.id
  let r = call(store, KID, 'POST', id + '/items', { items: [{ type: 'movie', id: movieId('Heat (1995).mkv') }, { type: 'movie', id: movieId('Speed (1994).mkv') }] })
  assert.equal(r.body.added, 2)
  r = call(store, KID, 'POST', id + '/items/move', { entryId: r.body.items[1].entryId, toIndex: 0 })
  assert.deepEqual(byTitle(r.body.items), ['Speed', 'Heat'])
  r = call(store, KID, 'POST', id + '/items/remove', { entryIds: [r.body.items[0].entryId] })
  assert.equal(r.body.removed, 1)
  assert.deepEqual(byTitle(r.body.items), ['Heat'])
  // a single-item body works too (Add to playlist from a poster)
  assert.equal(call(store, KID, 'POST', id + '/items', { type: 'episode', id: enc('Lost/Season 1/Lost S01E01.mkv') }).body.added, 1)

  assert.equal(call(store, GUEST, 'POST', id + '/items', { type: 'movie', id: movieId('Heat (1995).mkv') }).status, 404)
  assert.equal(call(store, GUEST, 'GET', id).status, 404)
  assert.equal(call(store, KID, 'POST', id + '/items', { type: 'movie', id: 'missing' }).status, 404)
  assert.equal(call(store, KID, 'POST', '', { name: '' }).body.error, 'missing_name')
  assert.equal(call(store, KID, 'POST', '', { name: 'shared', shared: true }).status, 403)
  assert.equal(call(store, null, 'GET', '').status, 401)
  assert.equal(call(store, KID, 'GET', id + '/nope').status, 404)
  assert.equal(call(store, KID, 'POST', id + '/delete').status, 200)
  assert.equal(call(store, KID, 'GET', id).status, 404)
})

test('api: list counts smart playlists per viewer; preview counts live', () => {
  const store = memStore()
  call(store, OWNER, 'POST', '', { template: 'unwatched-this-month', shared: true })
  const list = call(store, KID, 'GET', '')
  assert.equal(list.body.playlists.length, 1)
  assert.equal(list.body.playlists[0].itemCount, 3)
  assert.equal(list.body.playlists[0].canEdit, false)
  assert.equal(list.body.playlists[0].ownerName, 'Nick')
  assert.equal(list.body.canShare, false)
  assert.ok(list.body.templates.some((t) => t.id === 'continue-my-shows'))
  // the same shared smart list, evaluated for a viewer who has watched Heat
  const heatWatched = () => playlistCatalog.buildViewerContext({ now: NOW, watchedFiles: { 'movie:Heat (1995).mkv': { watched: true } } })
  assert.equal(call(store, GUEST, 'GET', '', null, '', { context: heatWatched }).body.playlists[0].itemCount, 2)

  const prev = call(store, KID, 'POST', 'preview', { rules: cond('durationMinutes', 'lte', 30) })
  assert.equal(prev.body.count, 3)
  assert.equal(call(store, KID, 'POST', 'preview', { rules: cond('bogus', 'is', 1) }).status, 400)
  assert.ok(call(store, KID, 'GET', 'fields').body.fields.genre)
  // the parental-controls seam applies to smart results
  const noR = call(store, KID, 'POST', 'preview', { rules: cond('mediaType', 'is', 'movie') }, '', { allow: () => (it) => it.certification !== 'R' })
  assert.equal(noR.body.count, 2)
})

test('api: a manual playlist hides items the viewer may not see, flags missing ones', () => {
  const store = memStore()
  const id = call(store, KID, 'POST', '', { name: 'x', add: [{ type: 'movie', id: movieId('Heat (1995).mkv') }, { type: 'movie', id: movieId('Toy Story (1995).mp4') }] }).body.playlist.id
  // Heat leaves the library
  const smaller = { catalog: LIB.catalog.filter((i) => i.title !== 'Heat') }
  smaller.index = playlistCatalog.indexCatalog(smaller.catalog)
  const r = call(store, KID, 'GET', id, null, '', { catalog: () => smaller })
  assert.deepEqual(r.body.items.map((i) => [i.title, i.available]), [['Heat', false], ['Toy Story', true]])
  assert.deepEqual(byTitle(call(store, KID, 'GET', id + '/play', null, '', { catalog: () => smaller }).body.items), ['Toy Story'])
  const hidden = call(store, KID, 'GET', id, null, '', { allow: () => (it) => it.certification !== 'G' })
  assert.deepEqual(byTitle(hidden.body.items), ['Heat'])
})

// ============================================================================
// Migration + backup
// ============================================================================
test('migration: legacy shapes become schema 1, junk is dropped', () => {
  const legacy = {
    u1: [{ name: 'Old list', items: [{ kind: 'movie', id: 'abc', title: 'A' }, { kind: 'tv', id: 'def' }, null, { kind: 'movie' }] }, { name: '' }],
    u2: 'garbage'
  }
  const store = memStore({ playlists: legacy })
  const lists = playlists.listFor(store, { id: 'u1' })
  assert.equal(lists.length, 1)
  assert.deepEqual(lists[0].items.map((i) => [i.type, i.id]), [['movie', 'abc'], ['episode', 'def']])
  assert.equal(store.data.playlists.schema, 1)
  // a bare array
  const arr = playlists.migrate([{ ownerId: 'u3', name: 'Arr', kind: 'smart', rules: cond('genre', 'is', 'Drama') }, { ownerId: 'u3', name: 'bad', kind: 'smart', rules: cond('x', 'is', 1) }])
  assert.equal(arr.lists.length, 1)
  assert.equal(arr.lists[0].kind, 'smart')
  // an unknown future item type survives a load/save
  const future = playlists.migrate({ schema: 1, lists: [{ id: 'pl_abcdef', ownerId: 'u', name: 'n', kind: 'manual', items: [{ entryId: 'e_abcdef', type: 'podcast', id: 'p1' }] }] })
  assert.equal(future.lists[0].items[0].type, 'podcast')
})

test('backup: playlists are exported under lists, and a restore brings them back', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-pl-'))
  try {
    const store = memStore({ authUsers: [{ id: 'kid', username: 'sam' }] })
    const p = playlists.create(store, KID, { name: 'Keep me' })
    playlists.addItems(store, KID, p.id, [{ type: 'movie', id: 'm1', title: 'M1' }, { type: 'track', id: 't1' }])
    playlists.create(store, OWNER, { template: 'continue-my-shows', shared: true })
    playlists.recordProgress(store, KID, p.id, { entryId: 'e_abcdef', index: 1 })

    const file = backup.createBackup(store)
    assert.ok(file.sections.lists.playlists, 'playlists live in the Favourites/watchlist section')
    const text = backup.serializeBackup(file)

    // a fresh install
    const fresh = memStore()
    const opened = backup.openBackup(backup.parseBackupText(text))
    const summary = backup.summarizeRestore(fresh, opened)
    assert.ok(summary.sections.find((s) => s.id === 'lists').added.some((r) => r.key === 'playlists'))
    backup.applyRestore(fresh, opened, { safetyDir: dir })
    const back = playlists.listFor(fresh, KID)
    assert.deepEqual(back.map((x) => x.name), ['Keep me', 'Continue my shows'])
    assert.deepEqual(back[0].items.map((i) => i.type), ['movie', 'track'])
    assert.equal(back[0].id, p.id)
    assert.equal(playlists.progressFor(fresh, KID, p.id).index, 1)

    // restoring a backup made before playlists existed leaves today's alone
    const old = backup.openBackup(backup.parseBackupText(backup.serializeBackup(backup.createBackup(memStore({ watchlist: {} })))))
    backup.applyRestore(fresh, old, { safetyDir: dir })
    assert.equal(playlists.listFor(fresh, KID).length, 2)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
