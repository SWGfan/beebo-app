// The banner on each season poster card (src/lib/seasonBanner.js): green
// "All Episodes" only when TMDB's list is known and fully covered, amber
// "X of Y missing", a greyed card when nothing is owned, and a neutral count when
// there is nothing to check against.
// Run: node --test test/season-banner.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const appRoot = path.resolve(__dirname, '..')
const load = () => import(pathToFileURL(path.join(appRoot, 'src', 'lib', 'seasonBanner.js')).href)

const tmdb = (n) => Array.from({ length: n }, (_, i) => ({ episode_number: i + 1, name: `E${i + 1}` }))
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i)

test('every TMDB episode owned -> complete, "All Episodes"', async () => {
  const B = await load()
  const b = B.seasonBanner({ ownedEpisodes: range(1, 12), tmdbEpisodes: tmdb(12) })
  assert.equal(b.variant, 'complete')
  assert.equal(b.text, 'All Episodes')
  assert.equal(b.missing, 0)
})

test('some missing -> partial, "X of Y missing" with X = missing, Y = total', async () => {
  const B = await load()
  const b = B.seasonBanner({ ownedEpisodes: [1, 2, 3, 4, 5, 6, 7, 8, 9], tmdbEpisodes: tmdb(12) })
  assert.equal(b.variant, 'partial')
  assert.equal(b.text, '3 of 12 missing')
  assert.deepEqual([b.owned, b.total, b.missing], [9, 12, 3])
})

test('a gap in the middle counts as missing too', async () => {
  const B = await load()
  const b = B.seasonBanner({ ownedEpisodes: [1, 2, 4, 5], tmdbEpisodes: tmdb(5) })
  assert.equal(b.text, '1 of 5 missing')
})

test('none owned -> empty variant, "Y of Y missing" (the card greys out)', async () => {
  const B = await load()
  const b = B.seasonBanner({ ownedEpisodes: [], tmdbEpisodes: tmdb(10) })
  assert.equal(b.variant, 'empty')
  assert.equal(b.text, '10 of 10 missing')
  assert.equal(B.seasonBanner({ ownedEpisodes: [], tmdbCount: 8 }).text, '8 of 8 missing')
})

test('no TMDB data -> neutral count, never "All Episodes"', async () => {
  const B = await load()
  assert.deepEqual(
    (({ variant, text }) => ({ variant, text }))(B.seasonBanner({ ownedEpisodes: [1, 2, 3, 4, 5, 6, 7, 8] })),
    { variant: 'unknown', text: '8 episodes' }
  )
  assert.equal(B.seasonBanner({ ownedEpisodes: [1] }).text, '1 episode')
  assert.equal(B.seasonBanner({ ownedEpisodes: [], tmdbEpisodes: [], tmdbCount: 0 }).variant, 'unknown')
  assert.equal(B.seasonBanner({}).variant, 'unknown')
})

test('files with no parsed episode number count toward the neutral count only', async () => {
  const B = await load()
  assert.equal(B.seasonBanner({ ownedEpisodes: [null, null, null] }).text, '3 episodes')
  const b = B.seasonBanner({ ownedEpisodes: [null, 1], tmdbEpisodes: tmdb(2) })
  assert.equal(b.text, '1 of 2 missing', 'an unnumbered file proves nothing about episode 2')
})

test('duplicate files for one episode do not hide a missing one', async () => {
  const B = await load()
  const b = B.seasonBanner({ ownedEpisodes: [1, 1, 1], tmdbEpisodes: tmdb(3) })
  assert.equal(b.text, '2 of 3 missing')
})

test('season count without the episode list: complete only when 1..N are all owned', async () => {
  const B = await load()
  assert.equal(B.seasonBanner({ ownedEpisodes: range(1, 8), tmdbCount: 8 }).text, 'All Episodes')
  assert.equal(B.seasonBanner({ ownedEpisodes: [1, 2, 3, 4, 5, 6, 7, 9], tmdbCount: 8 }).text, '1 of 8 missing')
})

test('episodes TMDB has not numbered (unaired placeholders) are not counted as missing', async () => {
  const B = await load()
  const list = [...tmdb(3), { episode_number: null, name: 'TBA' }, { name: 'TBA 2' }]
  assert.equal(B.seasonBanner({ ownedEpisodes: [1, 2, 3], tmdbEpisodes: list }).text, 'All Episodes')
})

test('season 0 (Specials) behaves like any other season, and is labelled Specials', async () => {
  const B = await load()
  assert.equal(B.seasonLabel(0), 'Specials')
  assert.equal(B.seasonLabel(3), 'Season 3')
  assert.equal(B.seasonLabel('Unsorted'), 'Unsorted')
  assert.equal(B.seasonBanner({ ownedEpisodes: [1, 2], tmdbEpisodes: tmdb(2) }).text, 'All Episodes')
  assert.equal(B.seasonBanner({ ownedEpisodes: [], tmdbCount: 3 }).variant, 'empty')
})

test('missingEpisodeNumbers is what the "Show missing episodes" rows use', async () => {
  const B = await load()
  assert.deepEqual(B.missingEpisodeNumbers([1, 3], tmdb(4)), [2, 4])
  assert.deepEqual(B.missingEpisodeNumbers([], tmdb(2)), [1, 2])
  assert.deepEqual(B.missingEpisodeNumbers([1, 2], null), [])
  assert.deepEqual(B.missingEpisodeNumbers(undefined, undefined), [])
})
