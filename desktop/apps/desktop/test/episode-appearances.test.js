// Which episodes each actor is in (src/lib/episodeAppearances.js): the compact
// "Season 2: eps 3, 5–8" text and the actor -> season -> episodes map built from
// TMDB's series cast plus per-episode credits (guest stars included).
// No network: the inputs are hand-made TMDB-shaped rows.
// Run: node --test test/episode-appearances.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const appRoot = path.resolve(__dirname, '..')
const load = () => import(pathToFileURL(path.join(appRoot, 'src', 'lib', 'episodeAppearances.js')).href)

test('compactRanges folds runs, sorts, de-duplicates and drops junk', async () => {
  const A = await load()
  assert.deepEqual(A.compactRanges([8, 3, 5, 6, 7, 5]), [[3, 3], [5, 8]])
  assert.deepEqual(A.compactRanges([1, 2]), [[1, 2]])
  assert.deepEqual(A.compactRanges([0, -1, 2.5, NaN, null, 'x', 4]), [[4, 4]])
  assert.deepEqual(A.compactRanges([]), [])
  assert.deepEqual(A.compactRanges(undefined), [])
})

test('formatRanges reads like a person would say it', async () => {
  const A = await load()
  assert.equal(A.formatRanges([3, 5, 6, 7, 8]), '3, 5–8')
  assert.equal(A.formatRanges([1]), '1')
  assert.equal(A.formatRanges([1, 2, 3, 10]), '1–3, 10')
  assert.equal(A.formatRanges([]), '')
})

test('formatSeasonLine uses "ep" for one episode and "eps" otherwise', async () => {
  const A = await load()
  assert.equal(A.formatSeasonLine(2, [3, 5, 6, 7, 8]), 'Season 2: eps 3, 5–8')
  assert.equal(A.formatSeasonLine(4, [1]), 'Season 4: ep 1')
  assert.equal(A.formatSeasonLine(0, [2]), 'Specials: ep 2')
  assert.equal(A.formatSeasonLine(3, []), '')
})

test('formatAppearances joins seasons in order, whatever order they arrive in', async () => {
  const A = await load()
  const list = [
    { season: 4, episode: 1 },
    { season: 2, episode: 8 }, { season: 2, episode: 3 }, { season: 2, episode: 5 }, { season: 2, episode: 6 }, { season: 2, episode: 7 },
    { season: 2, episode: 3 },
    { season: 0, episode: 1 },
    { season: 'x', episode: 1 }, { season: 1 }, null
  ]
  assert.equal(A.formatAppearances(list), 'Specials: ep 1; Season 2: eps 3, 5–8; Season 4: ep 1')
  assert.equal(A.formatAppearances([]), '')
  assert.equal(A.formatAppearances(undefined), '')
})

const owned = (season, eps) => eps.map((episode) => ({ season, episode }))
const person = (id, name, character, extra = {}) => ({ id, name, character, profilePath: `/p${id}.jpg`, ...extra })

test('buildAppearanceMap: a regular seen across seasons keeps every owned episode, in order', async () => {
  const A = await load()
  const rows = A.buildAppearanceMap({
    aggregateCast: [{ id: 1, name: 'Hugh', profilePath: '/h.jpg', characters: ['House'], episodeCount: 177, order: 0 }],
    records: [
      { season: 4, episode: 1, cast: [person(1, 'Hugh', 'House')] },
      { season: 2, episode: 5, cast: [person(1, 'Hugh', 'House')] },
      { season: 2, episode: 3, cast: [person(1, 'Hugh', 'House')] }
    ],
    owned: [...owned(2, [3, 5]), ...owned(4, [1])]
  })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].kind, 'series')
  assert.deepEqual(rows[0].owned, [{ season: 2, episode: 3 }, { season: 2, episode: 5 }, { season: 4, episode: 1 }])
  assert.equal(A.formatAppearances(rows[0].owned), 'Season 2: eps 3, 5; Season 4: ep 1')
  assert.deepEqual(rows[0].notOwned, [])
  assert.deepEqual(rows[0].characters, ['House'])
})

test('buildAppearanceMap: guest stars count, and are not mistaken for the series cast', async () => {
  const A = await load()
  const rows = A.buildAppearanceMap({
    aggregateCast: [{ id: 1, name: 'Lead', characters: ['Lead'], episodeCount: 20, order: 0 }],
    records: [
      { season: 1, episode: 2, cast: [person(1, 'Lead', 'Lead')], guests: [person(9, 'Guest Person', 'The Patient')] },
      { season: 3, episode: 4, guests: [person(9, 'Guest Person', 'The Patient')] },
      { season: 3, episode: 5, guests: [person(9, 'Guest Person', 'Old Patient')] }
    ],
    owned: [...owned(1, [2]), ...owned(3, [4, 5])]
  })
  const guest = rows.find((r) => r.id === 9)
  assert.equal(guest.kind, 'guest')
  assert.equal(A.formatAppearances(guest.owned), 'Season 1: ep 2; Season 3: eps 4–5')
  assert.deepEqual(guest.characters, ['The Patient', 'Old Patient'])
  assert.equal(rows[0].id, 1, 'series cast is listed before guests')
})

test('buildAppearanceMap: episodes we do not own go to notOwned, never to owned', async () => {
  const A = await load()
  const rows = A.buildAppearanceMap({
    records: [
      { season: 2, episode: 1, guests: [person(7, 'Visitor', 'Dr. Who')] },
      { season: 2, episode: 2, guests: [person(7, 'Visitor', 'Dr. Who')] },
      { season: 2, episode: 3, guests: [person(7, 'Visitor', 'Dr. Who')] }
    ],
    owned: owned(2, [2])
  })
  assert.deepEqual(rows[0].owned, [{ season: 2, episode: 2 }])
  assert.deepEqual(rows[0].notOwned, [{ season: 2, episode: 1 }, { season: 2, episode: 3 }])
  assert.equal(A.formatAppearances(rows[0].notOwned), 'Season 2: eps 1, 3')
})

test('buildAppearanceMap: a person with no owned episode yet still lists (series cast), with nothing owned', async () => {
  const A = await load()
  const rows = A.buildAppearanceMap({
    aggregateCast: [{ id: 5, name: 'Regular', characters: ['R'], episodeCount: 50, order: 1 }],
    records: [],
    owned: owned(1, [1])
  })
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0].owned, [])
})

test('buildAppearanceMap: series cast follows billing order; guests follow, most-seen first, then by name', async () => {
  const A = await load()
  const rows = A.buildAppearanceMap({
    aggregateCast: [
      { id: 2, name: 'Second', order: 1 },
      { id: 1, name: 'First', order: 0 }
    ],
    records: [
      { season: 1, episode: 1, guests: [person(30, 'Zed', 'z'), person(31, 'Amy', 'a'), person(32, 'Bob', 'b')] },
      { season: 1, episode: 2, guests: [person(32, 'Bob', 'b')] }
    ],
    owned: owned(1, [1, 2])
  })
  assert.deepEqual(rows.map((r) => r.name), ['First', 'Second', 'Bob', 'Amy', 'Zed'])
})

test('buildAppearanceMap ignores rows without a usable id or episode', async () => {
  const A = await load()
  const rows = A.buildAppearanceMap({
    records: [
      { season: 1, episode: 1, guests: [{ name: 'No id' }, person(0, 'Zero', 'z'), person(4, 'Fine', 'f')] },
      { season: 1, episode: 0, guests: [person(8, 'Bad episode', 'b')] },
      null
    ],
    owned: owned(1, [1])
  })
  assert.deepEqual(rows.map((r) => r.id), [4])
  assert.deepEqual(A.buildAppearanceMap(), [])
})

test('buildAppearanceMap: the same person twice in one episode (cast and guest lists) counts once', async () => {
  const A = await load()
  const rows = A.buildAppearanceMap({
    records: [{ season: 1, episode: 1, cast: [person(4, 'Dup', 'a')], guests: [person(4, 'Dup', 'a')] }],
    owned: owned(1, [1])
  })
  assert.equal(rows[0].owned.length, 1)
})

test('coverage counts owned episodes that have credits so far', async () => {
  const A = await load()
  const o = owned(1, [1, 2, 3])
  assert.deepEqual(A.coverage({ records: [], owned: o }), { covered: 0, total: 3 })
  assert.deepEqual(
    A.coverage({ records: [{ season: 1, episode: 1, cast: [] }, { season: 1, episode: 3, guests: [] }, { season: 9, episode: 9, cast: [] }], owned: o }),
    { covered: 2, total: 3 }
  )
})

test('appearancesFor returns one person\'s owned and not-owned lists, or empty ones', async () => {
  const A = await load()
  const rows = A.buildAppearanceMap({
    records: [{ season: 1, episode: 1, guests: [person(4, 'X', 'x')] }, { season: 1, episode: 2, guests: [person(4, 'X', 'x')] }],
    owned: owned(1, [1])
  })
  assert.deepEqual(A.appearancesFor(rows, 4), { owned: [{ season: 1, episode: 1 }], notOwned: [{ season: 1, episode: 2 }] })
  assert.deepEqual(A.appearancesFor(rows, 999), { owned: [], notOwned: [] })
})
