// The details page's text formatters (src/lib/movieFormat.js).
// Run: node --test test/movie-format.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const appRoot = path.resolve(__dirname, '..')
const load = () => import(pathToFileURL(path.join(appRoot, 'src', 'lib', 'movieFormat.js')).href)

test('formatRuntime: hours and minutes, either alone, or nothing', async () => {
  const F = await load()
  assert.equal(F.formatRuntime(112), '1hr 52min')
  assert.equal(F.formatRuntime(45), '45min')
  assert.equal(F.formatRuntime(120), '2hr')
  assert.equal(F.formatRuntime(59.6), '1hr')
  assert.equal(F.formatRuntime('148'), '2hr 28min')
  for (const bad of [0, -5, NaN, null, undefined, 'abc']) assert.equal(F.formatRuntime(bad), '')
})

test('formatClock: m:ss under an hour, h:mm:ss over', async () => {
  const F = await load()
  assert.equal(F.formatClock(125), '2:05')
  assert.equal(F.formatClock(4930), '1:22:10')
  assert.equal(F.formatClock(0), '0:00')
  assert.equal(F.formatClock(59.9), '0:59')
  assert.equal(F.formatClock(-1), '')
  assert.equal(F.formatClock('x'), '')
})

test('formatDirectedBy: one, two, three names, none', async () => {
  const F = await load()
  assert.equal(F.formatDirectedBy(['Nolan']), 'Directed by Nolan')
  assert.equal(F.formatDirectedBy(['A', 'B']), 'Directed by A and B')
  assert.equal(F.formatDirectedBy(['A', 'B', 'C']), 'Directed by A, B and C')
  assert.equal(F.formatDirectedBy(['', null, ' ']), '')
  assert.equal(F.formatDirectedBy(), '')
})

test('formatFactsLine joins whatever facts exist', async () => {
  const F = await load()
  assert.equal(F.formatFactsLine({ year: '2010', runtime: 148, certification: 'PG-13' }), '2010 · 2hr 28min · PG-13')
  assert.equal(F.formatFactsLine({ year: 1999 }), '1999')
  assert.equal(F.formatFactsLine({ runtime: 90, certification: 'R' }), '1hr 30min · R')
  assert.equal(F.formatFactsLine({}), '')
  assert.equal(F.formatFactsLine(), '')
})

test('formatRating: score from TMDB\'s vote average, nothing when there are no votes', async () => {
  const F = await load()
  assert.deepEqual(F.formatRating(7.84, 1200), { score: '7.8', halfStars: 8, votes: 1200 })
  assert.deepEqual(F.formatRating(10, 5), { score: '10.0', halfStars: 10, votes: 5 })
  assert.equal(F.formatRating(0, 0), null)
  assert.equal(F.formatRating(7.5, 0), null)
  assert.equal(F.formatRating(null, 10), null)
  assert.equal(F.formatRating(undefined), null)
  assert.equal(F.formatRating(12, 3).score, '10.0', 'never above ten')
})

test('tmdbImageUrl only builds addresses for plain TMDB image paths', async () => {
  const F = await load()
  assert.equal(F.tmdbImageUrl('/abc123.jpg', 'w185'), 'https://image.tmdb.org/t/p/w185/abc123.jpg')
  assert.equal(F.tmdbImageUrl('/abc123.jpg'), 'https://image.tmdb.org/t/p/w300/abc123.jpg')
  assert.equal(F.tmdbImageUrl('/abc123.jpg', 'evil/../size'), 'https://image.tmdb.org/t/p/w300/abc123.jpg')
  for (const bad of ['https://evil.example/x.jpg', '//evil.example/x.jpg', '/a/b.jpg', '/../x.jpg', 'abc.jpg', '', null, undefined, 5, '/a b.jpg']) assert.equal(F.tmdbImageUrl(bad), null, String(bad))
})

test('initialsOf', async () => {
  const F = await load()
  assert.equal(F.initialsOf('Leonardo DiCaprio'), 'LD')
  assert.equal(F.initialsOf('Cher'), 'C')
  assert.equal(F.initialsOf('  mary jane watson  '), 'MW')
  assert.equal(F.initialsOf(''), '?')
  assert.equal(F.initialsOf(null), '?')
})

test('starSlots: five slots, half steps', async () => {
  const F = await load()
  assert.deepEqual(F.starSlots(7), ['full', 'full', 'full', 'half', 'empty'])
  assert.deepEqual(F.starSlots(10), ['full', 'full', 'full', 'full', 'full'])
  assert.deepEqual(F.starSlots(0), ['empty', 'empty', 'empty', 'empty', 'empty'])
  assert.deepEqual(F.starSlots(99), ['full', 'full', 'full', 'full', 'full'])
  assert.deepEqual(F.starSlots('x'), ['empty', 'empty', 'empty', 'empty', 'empty'])
})
