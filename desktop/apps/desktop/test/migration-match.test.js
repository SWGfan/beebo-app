// Matching imported items to the library: ids first, then file name, then title + year, and the
// rules that keep a wrong title from ever being matched silently. Run: node --test test/migration-match.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const match = require('../electron/migration/match')
const fx = require('./helpers/migrationFixtures')

const movie = (title, year, ids = {}, extra = {}) => ({ type: 'movie', title, year, ids, ...extra })
const ep = (show, season, episode, ids = {}, year = null, extra = {}) => ({ type: 'episode', title: 'x', ids: {}, show: { title: show, year, ids }, season, episode, ...extra })

const idx = () => match.buildLibraryIndex([
  ...fx.fixtureCatalog(),
  fx.movie('Heat (1995) 4K.mkv', 'Heat', 1995, 949), // a second copy of the same film
  fx.movie('Ocean’s Eleven (2001).mkv', 'Ocean’s Eleven', 2001, 161),
  fx.movie('Ocean’s Eleven (1960).mkv', 'Ocean’s Eleven', 1960, 163),
  fx.movie('Robocop (1987).mkv', 'RoboCop', 1987, 5548, { imdbId: 'tt0093870' }),
  fx.movie('Unknown Thing.mkv', 'Unknown Thing', null, null),
  fx.episode('The Office', 1, 1, 2316, 'The Office (US)/Season 1', { showYear: 2005 }),
  fx.episode('The Office', 1, 1, 2996, 'The Office (UK)/Season 1', { showYear: 2001, showName: 'The Office' }),
  { ...fx.episode('Fringe', 1, 1, 1705, null, { showYear: 2008 }), title: 'Fringe' }
])

test('ids win: tmdb, then imdb, and a second copy of a film is noted, not a reason to ask', () => {
  const i = idx()
  let m = match.matchItem(movie('Whatever it is called', 1999, { tmdb: '603' }), i)
  assert.equal(m.status, 'matched')
  assert.equal(m.method, 'tmdb')
  assert.equal(m.target.key, 'movie:The Matrix (1999).mkv')
  m = match.matchItem(movie('RoboCop 1987', 1987, { imdb: 'tt0093870' }), i)
  assert.deepEqual([m.status, m.method, m.target.title], ['matched', 'imdb', 'RoboCop'])
  m = match.matchItem(movie('Heat', 1995, { tmdb: '949' }), i)
  assert.equal(m.status, 'matched')
  assert.equal(m.alsoMatches, 1, 'two files for one film: one target, and the count is kept')
  assert.equal(m.target.key, 'movie:Heat (1995) 4K.mkv', 'the first by file name is the target')
})

test('an id conflict beats a matching name: a remake is not the original', () => {
  const i = idx()
  let m = match.matchItem(movie('Dune', 2021, { tmdb: '999999' }), i)
  assert.equal(m.status, 'unmatched', 'the tmdb id says a different film')
  m = match.matchItem(movie('RoboCop', 1987, { imdb: 'tt9999999' }), i)
  assert.equal(m.status, 'unmatched', 'an IMDb id that differs from a library film’s own')
  m = match.matchItem(movie('Dune', 2021, { tmdb: '438631' }), i)
  assert.equal(m.status, 'matched')
  assert.equal(m.target.key, 'movie:Dune (2021).mkv')
})

test('the source’s file name matches a library file name (a copied library) when nothing else is known', () => {
  const i = idx()
  const m = match.matchItem(movie('Heat', 1995, {}, { fileHint: 'Alien (1979).mkv' }), i)
  assert.deepEqual([m.status, m.method, m.target.key], ['matched', 'filename', 'movie:Alien (1979).mkv'])
  const e = match.matchItem(ep('Whatever', 9, 9, {}, null, { fileHint: 'Severance S01E02.mkv' }), i)
  assert.deepEqual([e.status, e.method, e.target.key], ['matched', 'filename', 'tv:Severance/Season 1/Severance S01E02.mkv'])
})

test('title + year: one library film is matched, same-named films are told apart by year', () => {
  const i = idx()
  let m = match.matchItem(movie('The Matrix', 1999), i)
  assert.deepEqual([m.status, m.method], ['matched', 'title-year'])
  m = match.matchItem(movie('Dune', 2021), i)
  assert.deepEqual([m.status, m.target.key], ['matched', 'movie:Dune (2021).mkv'])
  m = match.matchItem(movie('Dune', 1984), i)
  assert.deepEqual([m.status, m.target.key], ['matched', 'movie:Dune (1984).mkv'])
  m = match.matchItem(movie('Amelie', 2001), i)
  assert.equal(m.status, 'matched', 'accents are folded')
  m = match.matchItem(movie('Oceans Eleven', 2001), i)
  assert.equal(m.target.key, 'movie:Ocean’s Eleven (2001).mkv', 'an apostrophe is not a word break')
  m = match.matchItem(movie('THE MATRIX!', 1999), i)
  assert.equal(m.status, 'matched', 'case, punctuation and a leading "The"')
})

test('a year one out is still matched (release dates differ by source), two out is not', () => {
  const i = idx()
  let m = match.matchItem(movie('The Matrix', 2000), i)
  assert.deepEqual([m.status, m.method], ['matched', 'title-year-close'])
  m = match.matchItem(movie('The Matrix', 2003), i)
  assert.equal(m.status, 'unmatched')
  assert.equal(m.reason, 'different_year')
  assert.equal(m.candidates[0].key, 'movie:The Matrix (1999).mkv', 'but the same-named film is offered')
})

test('a title with no year, or several files that fit, goes to review instead of being guessed', () => {
  const i = idx()
  let m = match.matchItem(movie('Dune', null), i)
  assert.equal(m.status, 'ambiguous')
  assert.equal(m.method, 'title-only')
  assert.deepEqual(m.candidates.map((c) => c.year).sort(), [1984, 2021])
  m = match.matchItem(movie('Unknown Thing', 2005), i)
  assert.equal(m.status, 'ambiguous', 'the library film has no year to compare')
  const dup = match.buildLibraryIndex([fx.movie('A (2000).mkv', 'A', 2000, null), fx.movie('A (2000) alt.mkv', 'A', 2000, null)])
  m = match.matchItem(movie('A', 2000), dup)
  assert.deepEqual([m.status, m.candidates.length], ['ambiguous', 2])
})

test('a close but different title is offered, never applied', () => {
  const i = idx()
  const m = match.matchItem(movie('Everything Everywhere All at Once!!', 2022, {}), i)
  assert.equal(m.status, 'matched', 'punctuation only')
  const near = match.matchItem(movie('Everything Everywhere All at Onc', 2022), i)
  assert.equal(near.status, 'ambiguous', 'a one-letter slip is offered for review')
  const similar = match.matchItem(movie('Everything Everywhere at Once', 2022), i)
  assert.equal(similar.status, 'ambiguous')
  assert.equal(similar.method, 'similar-title')
  assert.equal(similar.candidates[0].title, 'Everything Everywhere All at Once')
  const far = match.matchItem(movie('Completely Different Film', 1980), i)
  assert.deepEqual([far.status, far.reason], ['unmatched', 'not_in_library'])
  assert.equal(match.matchItem(movie('', 1999), i).reason, 'no_title')
})

test('episodes: the show by id or by name, then season and episode', () => {
  const i = idx()
  let m = match.matchItem(ep('Severance', 1, 2, { tmdb: '95396' }), i)
  assert.deepEqual([m.status, m.method, m.target.key], ['matched', 'tmdb', 'tv:Severance/Season 1/Severance S01E02.mkv'])
  assert.equal(m.target.showTitle, 'Severance')
  assert.equal(m.target.season, 1)
  m = match.matchItem(ep('severance', 1, 3, {}, 2022), i)
  assert.deepEqual([m.status, m.method], ['matched', 'title'])
  m = match.matchItem(ep('Severance', 1, 9, { tmdb: '95396' }), i)
  assert.deepEqual([m.status, m.reason], ['unmatched', 'episode_not_in_library'])
  m = match.matchItem(ep('Severance', 1, null, { tmdb: '95396' }), i)
  assert.equal(m.reason, 'no_episode_number')
  m = match.matchItem(ep('Breaking Bad', 1, 1, { tmdb: '1396' }), i)
  assert.equal(m.reason, 'show_not_in_library')
  m = match.matchItem(ep('Severance', 1, 1, { tmdb: '11111' }), i)
  assert.equal(m.status, 'unmatched', 'a different tmdb id is a different show even with the same name')
})

test('episodes: two shows with one name are told apart by year, or asked about', () => {
  // (Beebo keys a show by its lower-cased name, so these come from a library where the keys differ.)
  const us = { ...fx.episode('The Office', 1, 1, 2316, 'US/Season 1', { showYear: 2005 }), showKey: 'k-us' }
  const uk = { ...fx.episode('The Office', 1, 1, 2996, 'UK/Season 1', { showYear: 2001 }), showKey: 'k-uk' }
  const i = match.buildLibraryIndex([us, uk])
  let m = match.matchItem(ep('The Office', 1, 1, {}, 2005), i)
  assert.deepEqual([m.status, m.target.key], ['matched', us.key])
  m = match.matchItem(ep('The Office', 1, 1, {}, 2001), i)
  assert.deepEqual([m.status, m.target.key], ['matched', uk.key])
  m = match.matchItem(ep('The Office', 1, 1, {}, null), i)
  assert.equal(m.status, 'ambiguous')
  assert.equal(m.candidates.length, 2)
  m = match.matchItem(ep('The Office', 1, 1, { tmdb: '2996' }, null), i)
  assert.deepEqual([m.status, m.method, m.target.key], ['matched', 'tmdb', uk.key], 'an id settles it')
})

test('whole-show items (ratings, watchlist) match a show, not an episode', () => {
  const i = idx()
  let m = match.matchItem({ type: 'show', title: 'Chernobyl', year: 2019, ids: { tvdb: '360893' } }, i)
  assert.deepEqual([m.status, m.method], ['matched', 'title'], 'the library does not know the tvdb id, so the name and year decide')
  m = match.matchItem({ type: 'show', title: 'Chernobyl', year: 2010, ids: {} }, i)
  assert.equal(m.status, 'ambiguous', 'a show’s year that disagrees is not silently accepted')
  m = match.matchItem({ type: 'show', title: 'Chernobyl', year: 2019, ids: { tmdb: '87108' } }, i)
  assert.deepEqual([m.status, m.target.type, m.target.title], ['matched', 'show', 'Chernobyl'])
  m = match.matchItem({ type: 'show', title: 'Fringe', year: 2008, ids: {} }, i)
  assert.equal(m.status, 'matched')
  assert.equal(m.target.key, 'show:' + fx.b64('fringe'))
})

test('searching the library for the review screen, and listing a show’s episodes', () => {
  const i = idx()
  const found = match.searchLibrary(i, 'sever', 'show')
  assert.ok(!found.length || found[0].type === 'show')
  const both = match.searchLibrary(i, 'severance')
  assert.equal(both[0].title, 'Severance')
  const films = match.searchLibrary(i, 'matrix', 'movie')
  assert.deepEqual(films.map((f) => f.title), ['The Matrix'])
  assert.deepEqual(match.searchLibrary(i, '', 'movie'), [])
  const eps = match.episodesOfShow(i, fx.b64('severance'))
  assert.deepEqual(eps.map((e) => e.title), ['Severance S01E01', 'Severance S01E02', 'Severance S01E03'])
  assert.deepEqual(match.episodesOfShow(i, 'nope'), [])
})

test('a huge library is matched without checking every title against every other', () => {
  const big = []
  for (let n = 0; n < 6000; n++) big.push(fx.movie('Film Number ' + n + ' (2000).mkv', 'Film Number ' + n, 2000, 100000 + n))
  const i = match.buildLibraryIndex(big)
  const t0 = Date.now()
  for (let n = 0; n < 3000; n++) match.matchItem(movie('Film Number ' + (n + 9000), 2000), i)
  assert.ok(Date.now() - t0 < 3000, 'took ' + (Date.now() - t0) + ' ms')
})
