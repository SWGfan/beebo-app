const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))
const genres = localRequire('./electron/genres')
const tmdbCache = localRequire('./electron/tmdbCache')

test('combined TV genres split into the film genres, idempotently', () => {
  assert.deepEqual(genres.splitTvGenreIds([10759, 35]), [28, 12, 35])
  assert.deepEqual(genres.splitTvGenreIds([10765, 10768]), [878, 14, 10752, 10768])
  assert.deepEqual(genres.splitTvGenreIds([28, 10759]), [28, 12])
  const once = genres.splitTvGenreIds([10768, 10759])
  assert.deepEqual(genres.splitTvGenreIds(once), once)
})

test('split names match the film names and nothing combined is left', () => {
  for (const id of [28, 12, 878, 14, 10752]) assert.equal(genres.GENRE_NAMES_TV[id], genres.GENRE_NAMES_MOVIE[id])
  assert.equal(genres.GENRE_NAMES_TV[10768], 'Politics')
  assert.ok(Object.values(genres.GENRE_NAMES_TV).every((n) => !n.includes('&')))
  // every id a split can produce has a name
  for (const parts of Object.values(genres.TV_COMBINED_GENRES)) for (const id of parts) assert.ok(genres.GENRE_NAMES_TV[id])
})

test('a match is copied only when its genres change', () => {
  const plain = { id: 1, genre_ids: [35, 18] }
  assert.equal(genres.splitTvMatchGenres(plain), plain)
  const already = { id: 3, genre_ids: [10752, 10768] }
  assert.equal(genres.splitTvMatchGenres(already), already)
  const combined = { id: 2, name: 'Show', genre_ids: [10759] }
  const out = genres.splitTvMatchGenres(combined)
  assert.notEqual(out, combined)
  assert.deepEqual(out.genre_ids, [28, 12])
  assert.deepEqual(combined.genre_ids, [10759])
  assert.equal(genres.splitTvMatchGenres(null), null)
})

test('old bookmarked combined genre links open the first split genre', () => {
  assert.equal(genres.canonicalTvGenreId('10759'), '28')
  assert.equal(genres.canonicalTvGenreId('35'), '35')
  assert.equal(genres.canonicalTvGenreId(''), '')
})

test('the TV manifest is split when it is loaded from disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-genres-'))
  const paths = tmdbCache.ensureDirs(dir)
  fs.writeFileSync(paths.tvManifestFile, JSON.stringify({
    'the expanse': { id: 63639, name: 'The Expanse', genre_ids: [10765, 18] },
    '30 rock': { id: 4608, name: '30 Rock', genre_ids: [35] },
    'unmatched': null
  }))
  const m = tmdbCache.getTvManifest(dir)
  assert.deepEqual(m['the expanse'].genre_ids, [878, 14, 18])
  assert.deepEqual(m['30 rock'].genre_ids, [35])
  assert.equal(m.unmatched, null)
})
