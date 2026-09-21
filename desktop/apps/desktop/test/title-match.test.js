const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { createRequire } = require('node:module')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))
const titleMatch = localRequire('./electron/titleMatch')
const titleParse = localRequire('./electron/titleParse')

// A stand-in for electron-store, and a stand-in for TMDB that records every
// endpoint it is asked for — several of these tests are about which call is
// made (or not made) rather than what comes back.
function fakeStore() {
  const m = new Map()
  return { get: (k) => m.get(k), set: (k, v) => m.set(k, v) }
}
const movie = (id, title, year, popularity = 10, voteCount = 500) => ({
  id, title, original_title: title, release_date: year ? `${year}-01-01` : '',
  popularity, vote_count: voteCount, poster_path: `/p${id}.jpg`
})
const show = (id, name, year) => ({
  id, name, original_name: name, first_air_date: year ? `${year}-01-01` : '',
  popularity: 20, vote_count: 900, poster_path: `/t${id}.jpg`
})
function fakeApi(routes) {
  const calls = []
  return {
    calls,
    get: async (p, params) => {
      calls.push(p)
      return { ok: true, data: routes(p, params || {}) || { results: [] } }
    }
  }
}

test('An IMDb id in the filename is an answer, not a search', async () => {
  const api = fakeApi((p) => (p.startsWith('/find') ? { movie_results: [movie(1, 'Big', 1988)], tv_results: [] } : null))
  const verdict = await titleMatch.matchParsed(titleParse.parseMovieTitle('Big.(1988).tt0094737.mkv.mp4'), api)
  assert.equal(verdict.confidence, 'certain')
  assert.equal(verdict.reason, 'imdb_id')
  assert.ok(api.calls.every((c) => c.startsWith('/find')), `no search should have run: ${api.calls}`)
})

test('A file with an episode code is searched against TV, never against films', async () => {
  const api = fakeApi((p) => (p === '/search/tv' ? { results: [show(50, 'Blue Bloods', 2010)] } : null))
  const verdict = await titleMatch.matchParsed(titleParse.parseMovieTitle('blue.bloods.401.mp4'), api)
  assert.equal(verdict.kind, 'tv')
  assert.ok(api.calls.includes('/search/tv'))
  assert.ok(!api.calls.includes('/search/movie'))
})

test('The year ranks a candidate down; it never removes one', async () => {
  // This is the real file "Best-Movies.info_Blade.Runner.Final.Cut.1997...", a
  // 1982 film labelled 1997. TMDB's year filter answers with nothing at all for
  // 1997 — which is why the old code left this file with no poster for good.
  const api = fakeApi((p, q) => {
    if (p !== '/search/movie') return null
    if (q.year) return { results: [] }
    return { results: [movie(78, 'Blade Runner', 1982, 60), movie(335984, 'Blade Runner 2049', 2017, 70)] }
  })
  const verdict = await titleMatch.matchParsed(
    titleParse.parseMovieTitle('Best-Movies.info_Blade.Runner.Final.Cut.1997.720p.x264.YIFY.mp4'),
    api
  )
  assert.equal(verdict.match && verdict.match.id, 78)
  assert.equal(verdict.confidence, 'probable')
})

test('An unsure verdict hands the caller nothing it could write down', () => {
  const pool = titleMatch.toCandidates([movie(1, "Ocean's Eleven", 1960, 20), movie(2, "Ocean's Eleven", 2001, 80)], 'movie')
  const ambiguous = titleMatch.classify('Oceans Eleven 11', null, pool, {})
  assert.equal(ambiguous.confidence, 'unsure')
  assert.equal(ambiguous.match, null)
  // The same pair with a year in the filename is not ambiguous at all.
  const decided = titleMatch.classify("Ocean's Eleven", 2001, pool, {})
  assert.equal(decided.confidence, 'certain')
  assert.equal(decided.match.id, 2)
})

test('A near-empty TMDB row is never accepted for a mangled name', () => {
  // Taken from the owner's manifest: the file "0b..." is currently matched to a
  // 2026 animated short with zero votes, purely because it was results[0].
  const pool = titleMatch.toCandidates(
    [{ id: 1737652, title: 'Journey #11_0B19', original_title: 'Journey #11_0B19', release_date: '2026-08-06', popularity: 0.29, vote_count: 0, poster_path: null }],
    'movie'
  )
  const verdict = titleMatch.classify('0b', 2013, pool, {})
  assert.equal(verdict.confidence, 'unsure')
  assert.equal(verdict.match, null)
})

test('Re-checking an unsure file queues it and leaves the poster it already had', () => {
  const store = fakeStore()
  const previous = movie(99, 'Something Wrong', 2020)
  const out = titleMatch.applyVerdict(
    store, 'x.mkv',
    { confidence: 'unsure', match: null, candidates: [], query: 'x', year: null, kind: 'movie', reason: 'weak_title' },
    previous
  )
  assert.equal(out.accepted, false)
  assert.equal(out.queued, true)
  assert.equal(out.match.id, 99)
  assert.equal(titleMatch.getReviewQueue(store)['x.mkv'].currentMatch.id, 99)
})

test('Accepting a match clears the file off the review list', () => {
  const store = fakeStore()
  titleMatch.queueForReview(store, 'y.mkv', { query: 'y', candidates: [] })
  const best = titleMatch.rankCandidates('Jaws', 1975, titleMatch.toCandidates([movie(578, 'Jaws', 1975)], 'movie'))[0]
  const out = titleMatch.applyVerdict(store, 'y.mkv', { confidence: 'certain', match: best }, null)
  assert.equal(out.accepted, true)
  assert.equal(titleMatch.isQueued(store, 'y.mkv'), false)
})

test("A person's answer outranks the matcher, including the Re-check all button", () => {
  const store = fakeStore()
  titleMatch.confirmMatch(store, 'a.mkv', { kind: 'movie', id: 7, title: 'Anchorman', year: 2004 }, 'nick')
  assert.equal(titleMatch.shouldLookUp(store, 'a.mkv', { 'a.mkv': null }, true), false)
  assert.equal(titleMatch.getDecision(store, 'a.mkv').tmdbId, 7)

  titleMatch.markNotAMovie(store, 'trance-mix.mp4', 'nick')
  assert.equal(titleMatch.shouldLookUp(store, 'trance-mix.mp4', {}, true), false)
  assert.equal(titleMatch.getDecision(store, 'trance-mix.mp4').notAMovie, true)
})

test('A cached null is re-evaluated once, and only once', () => {
  const store = fakeStore()
  const manifest = { 'stuck.mkv': null }
  assert.equal(titleMatch.shouldLookUp(store, 'stuck.mkv', manifest, false), true)
  titleMatch.applyVerdict(store, 'stuck.mkv', { confidence: 'unsure', match: null, candidates: [], query: 'stuck' }, null)
  assert.equal(titleMatch.shouldLookUp(store, 'stuck.mkv', manifest, false), false)
})

test('A file that already matched is left alone unless the owner forces a re-check', () => {
  const store = fakeStore()
  const manifest = { 'ok.mkv': movie(1, 'X', 2000) }
  assert.equal(titleMatch.shouldLookUp(store, 'ok.mkv', manifest, false), false)
  assert.equal(titleMatch.shouldLookUp(store, 'ok.mkv', manifest, true), true)
})

// ---------------------------------------------------------------------------
// createTmdbApi: retry/backoff on a 429. A whole-library sweep (subtitleSweep.js's
// model for the worst case) can burst past TMDB's rate limit; before this, a
// single 429 fell straight through as 'tmdb_http_429' and landed the file on the
// owner's manual review list — indistinguishable from a genuinely ambiguous
// title, for a problem that usually clears itself within a second or two.
function fakeResponse(status, body, retryAfter) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => (h === 'Retry-After' && retryAfter != null ? String(retryAfter) : null) },
    json: async () => body
  }
}

test('createTmdbApi: a 429 is retried using Retry-After, then succeeds', async () => {
  const calls = []
  const sleeps = []
  const fetchImpl = async (url) => {
    calls.push(url)
    return calls.length === 1 ? fakeResponse(429, null, 2) : fakeResponse(200, { results: [] })
  }
  const api = titleMatch.createTmdbApi('testkey', fetchImpl, { sleep: async (ms) => sleeps.push(ms) })
  const res = await api.get('/search/movie', { query: 'x' })
  assert.equal(res.ok, true)
  assert.equal(calls.length, 2)
  assert.deepEqual(sleeps, [2000])
})

test('createTmdbApi: falls back to exponential backoff when Retry-After is missing', async () => {
  const sleeps = []
  let n = 0
  const fetchImpl = async () => { n++; return n < 3 ? fakeResponse(429, null) : fakeResponse(200, { results: [] }) }
  const api = titleMatch.createTmdbApi('testkey', fetchImpl, { sleep: async (ms) => sleeps.push(ms) })
  const res = await api.get('/search/movie', { query: 'x' })
  assert.equal(res.ok, true)
  assert.equal(n, 3)
  assert.deepEqual(sleeps, [300, 600])
})

test('createTmdbApi: gives up after a bounded number of attempts and reports the last status', async () => {
  let n = 0
  const fetchImpl = async () => { n++; return fakeResponse(429, null) }
  const api = titleMatch.createTmdbApi('testkey', fetchImpl, { sleep: async () => {} })
  const res = await api.get('/search/movie', { query: 'x' })
  assert.equal(res.ok, false)
  assert.equal(res.status, 429)
  assert.equal(n, 3, 'bounded, not an infinite retry loop')
})

test('createTmdbApi: a non-429 error is never retried', async () => {
  let n = 0
  const fetchImpl = async () => { n++; return fakeResponse(500, null) }
  const api = titleMatch.createTmdbApi('testkey', fetchImpl, {
    sleep: async () => { throw new Error('must not sleep/retry on a non-429') }
  })
  const res = await api.get('/search/movie', { query: 'x' })
  assert.equal(res.ok, false)
  assert.equal(res.status, 500)
  assert.equal(n, 1)
})

test('createTmdbApi: a hostile or broken Retry-After value is capped, not trusted outright', async () => {
  const sleeps = []
  let n = 0
  const fetchImpl = async () => { n++; return n === 1 ? fakeResponse(429, null, 9999) : fakeResponse(200, { results: [] }) }
  const api = titleMatch.createTmdbApi('testkey', fetchImpl, { sleep: async (ms) => sleeps.push(ms) })
  await api.get('/search/movie', { query: 'x' })
  assert.ok(sleeps[0] <= 5000, `expected a capped delay, got ${sleeps[0]}ms`)
})

test('matchParsed: a 429 that survives retries still reads as tmdb_http_429, not a silent permanent no-match', async () => {
  const fetchImpl = async () => fakeResponse(429, null)
  const api = titleMatch.createTmdbApi('testkey', fetchImpl, { sleep: async () => {} })
  const verdict = await titleMatch.matchParsed(titleParse.parseMovieTitle('Some.Movie.2020.mp4'), api)
  assert.equal(verdict.confidence, 'none')
  assert.equal(verdict.reason, 'tmdb_http_429')
})
