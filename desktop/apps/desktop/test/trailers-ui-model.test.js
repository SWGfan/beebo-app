// The Trailers screen's pure helpers (src/lib/trailerFilters.js): the genre lists, the year
// box, the filter object sent to the main process, and the wording of outcomes.
// Run: node --test test/trailers-ui-model.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const appRoot = path.resolve(__dirname, '..')
const load = () => import(pathToFileURL(path.join(appRoot, 'src', 'lib', 'trailerFilters.js')).href)
const genres = require(path.join(appRoot, 'electron', 'genres.js'))
const T = require(path.join(appRoot, 'electron', 'trailersBrowse.js'))

const NOW = new Date(2026, 8, 21)

test('the genre lists match the ones the rest of the app uses', async () => {
  const M = await load()
  const asTable = (list) => Object.fromEntries(list.map((g) => [g.id, g.name]))
  assert.deepEqual(asTable(M.GENRES.movie), genres.GENRE_NAMES_MOVIE)
  assert.deepEqual(asTable(M.GENRES.tv), genres.GENRE_NAMES_TV)
  const names = M.GENRES.movie.map((g) => g.name)
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)), 'listed alphabetically')
})

test('every genre the screen offers survives the main-process check', async () => {
  const M = await load()
  for (const media of ['movie', 'tv']) {
    const ids = M.GENRES[media].map((g) => g.id)
    const kept = T.normalizeFilters({ media, genres: ids.slice(0, 6) }).genres
    assert.deepEqual(kept, ids.slice(0, 6).sort((a, b) => a - b), media)
  }
})

test('year box: one year, a range, any dash or "to", a reversed range, and an empty box', async () => {
  const M = await load()
  assert.deepEqual(M.parseYearInput('', NOW), { ok: true, yearFrom: null, yearTo: null })
  assert.deepEqual(M.parseYearInput('   ', NOW), { ok: true, yearFrom: null, yearTo: null })
  assert.deepEqual(M.parseYearInput('1999', NOW), { ok: true, yearFrom: 1999, yearTo: 1999 })
  assert.deepEqual(M.parseYearInput(' 1990-1999 ', NOW), { ok: true, yearFrom: 1990, yearTo: 1999 })
  assert.deepEqual(M.parseYearInput('1990 - 1999', NOW), { ok: true, yearFrom: 1990, yearTo: 1999 })
  assert.deepEqual(M.parseYearInput('1990–1999', NOW), { ok: true, yearFrom: 1990, yearTo: 1999 })
  assert.deepEqual(M.parseYearInput('1990 to 1999', NOW), { ok: true, yearFrom: 1990, yearTo: 1999 })
  assert.deepEqual(M.parseYearInput('2005-1995', NOW), { ok: true, yearFrom: 1995, yearTo: 2005 })
  for (const bad of ['99', '19999', 'abc', '1990-', '-1999', '1990-1999-2001', '1990,1999', '1500', '3000', '1990 1999']) {
    assert.equal(M.parseYearInput(bad, NOW).ok, false, bad)
    assert.ok(M.parseYearInput(bad, NOW).message)
  }
})

test('the filter object carries only ids, years and short text, and agrees with the main-process normaliser', async () => {
  const M = await load()
  const years = M.parseYearInput('1990-1999', NOW)
  const f = M.buildFilters({ media: 'tv', genres: ['18', 35], years, person: { id: 17, name: 'Dominic West' }, text: '  the wire  ', sort: 'rating' })
  assert.deepEqual(f, { media: 'tv', genres: [18, 35], yearFrom: 1990, yearTo: 1999, personId: 17, text: 'the wire', sort: 'rating' })
  assert.deepEqual(T.normalizeFilters(f), { ...f, genres: [18, 35] }, 'nothing the screen sends is changed on the other side')
  const empty = M.buildFilters({ media: 'x', genres: null, years: { ok: false }, person: { name: 'no id' }, text: null, sort: 'nope' })
  assert.deepEqual(empty, { media: 'movie', genres: [], yearFrom: null, yearTo: null, personId: null, text: '', sort: 'popular' })
  assert.ok(!('name' in f) && !JSON.stringify(f).includes('Dominic'), 'an actor is sent as an id')
})

test('filter keys change with any filter and not with the order genres were picked in', async () => {
  const M = await load()
  const base = M.buildFilters({ media: 'movie', genres: [28, 35], years: { ok: true, yearFrom: null, yearTo: null }, person: null, text: '', sort: 'popular' })
  assert.equal(M.filtersKey(base), M.filtersKey({ ...base, genres: [35, 28] }))
  for (const change of [{ media: 'tv' }, { genres: [28] }, { yearFrom: 1990, yearTo: 1990 }, { personId: 5 }, { text: 'x' }, { sort: 'rating' }]) {
    assert.notEqual(M.filtersKey(base), M.filtersKey({ ...base, ...change }), JSON.stringify(change))
  }
  assert.equal(M.hasFilters(base), true)
  assert.equal(M.hasFilters({ ...base, genres: [] }), false)
  assert.equal(M.hasFilters({ ...base, genres: [], text: 'a' }), true)
})

test('switching to TV drops genres TV does not have', async () => {
  const M = await load()
  assert.deepEqual(M.keepGenresFor('tv', [27, 53, 18, 10762]), [18, 10762])
  assert.deepEqual(M.keepGenresFor('movie', [27, 10762, 18]), [27, 18])
  assert.deepEqual(M.keepGenresFor('tv', null), [])
})

test('every error the main process can return has friendly words, never a raw code', async () => {
  const M = await load()
  const codes = ['no_api_key', 'bad_api_key', 'offline', 'rate_limited', 'tmdb_error', 'not_found', 'open_failed', 'restricted_profile', 'bad_request', 'internal']
  for (const c of codes) {
    const msg = M.friendlyError(c)
    assert.ok(msg && msg.length > 10 && !msg.includes('_'), c)
  }
  assert.equal(M.friendlyError('something_new'), M.friendlyError('internal'))
  assert.equal(M.friendlyError(undefined), M.friendlyError('internal'))
})

test('the message after "Watch trailer" says plainly whether it was a trailer or a search', async () => {
  const M = await load()
  assert.match(M.watchMessage({ ok: true, opened: 'trailer' }, 'Heat'), /Opened the trailer for Heat/)
  const search = M.watchMessage({ ok: true, opened: 'search' }, 'Heat')
  assert.match(search, /no trailer/i)
  assert.match(search, /YouTube search/)
  assert.equal(M.watchMessage({ ok: false, error: 'offline' }, 'Heat'), M.friendlyError('offline'))
  assert.equal(M.watchMessage(null, 'Heat'), M.friendlyError('internal'))
  assert.equal(M.basisLabel('library'), 'Picked from titles in your library')
  assert.equal(M.basisLabel('zzz'), '')
})
