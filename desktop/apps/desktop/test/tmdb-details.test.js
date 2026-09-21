// The details pages' TMDB layer (electron/tmdbDetails.js): shaping raw TMDB
// answers, caching with TTLs, offline fallback and bounded concurrency. TMDB is
// faked; no network, no key.
// Run: node --test test/tmdb-details.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const D = require('../electron/tmdbDetails')

const RAW_MOVIE = {
  id: 27205, title: 'Inception', tagline: 'Your mind is the scene of the crime.', overview: 'A thief who steals secrets.',
  release_date: '2010-07-15', runtime: 148, vote_average: 8.369, vote_count: 35000, adult: false,
  backdrop_path: '/backdrop.jpg', poster_path: '/poster.jpg',
  genres: [{ id: 28, name: 'Action' }, { id: 878, name: 'Science Fiction' }],
  belongs_to_collection: null,
  release_dates: { results: [
    { iso_3166_1: 'GB', release_dates: [{ certification: '12A', type: 3 }] },
    { iso_3166_1: 'US', release_dates: [{ certification: '', type: 1 }, { certification: 'PG-13', type: 3 }, { certification: 'R', type: 5 }] }
  ] },
  credits: {
    cast: [
      { id: 6193, name: 'Leonardo DiCaprio', character: 'Cobb', profile_path: '/leo.jpg', order: 0 },
      { id: 24045, name: 'Joseph Gordon-Levitt', character: 'Arthur', profile_path: null, order: 1 },
      { id: 1, name: 'Bad Path', character: '', profile_path: 'http://evil.example/x.jpg', order: 2 },
      { name: 'No id' }
    ],
    crew: [
      { id: 525, name: 'Christopher Nolan', job: 'Director', profile_path: '/nolan.jpg' },
      { id: 525, name: 'Christopher Nolan', job: 'Writer', profile_path: '/nolan.jpg' },
      { id: 525, name: 'Christopher Nolan', job: 'Screenplay', profile_path: '/nolan.jpg' },
      { id: 9, name: 'Some Producer', job: 'Producer' }
    ]
  },
  recommendations: { results: [
    { id: 155, title: 'The Dark Knight', release_date: '2008-07-16', poster_path: '/dk.jpg', vote_average: 8.5, adult: false },
    { id: 666, title: 'Adult Thing', release_date: '2001-01-01', poster_path: '/a.jpg', vote_average: 5, adult: true }
  ] }
}

test('normalizeMovie: facts, US theatrical certification, director and writers from the crew', () => {
  const m = D.normalizeMovie(RAW_MOVIE)
  assert.equal(m.id, 27205)
  assert.equal(m.year, '2010')
  assert.equal(m.runtime, 148)
  assert.deepEqual(m.genres, ['Action', 'Science Fiction'])
  assert.equal(m.certification, 'PG-13')
  assert.equal(m.voteAverage, 8.369)
  assert.deepEqual(m.directors.map((d) => d.name), ['Christopher Nolan'])
  assert.equal(m.writers.length, 1, 'one person, two writing credits, shown once')
  assert.equal(m.writers[0].job, 'Writer, Screenplay')
  assert.equal(m.backdropPath, '/backdrop.jpg')
})

test('normalizeMovie: cast keeps billing and characters; junk rows and untrusted image paths are dropped', () => {
  const m = D.normalizeMovie(RAW_MOVIE)
  assert.deepEqual(m.cast.map((c) => c.name), ['Leonardo DiCaprio', 'Joseph Gordon-Levitt', 'Bad Path'])
  assert.equal(m.cast[0].character, 'Cobb')
  assert.equal(m.cast[1].profilePath, null)
  assert.equal(m.cast[2].profilePath, null, 'only "/name.ext" TMDB paths are accepted, never a URL')
  assert.equal(m.cast[2].character, null)
})

test('normalizeMovie: adult recommendations are never surfaced', () => {
  const m = D.normalizeMovie(RAW_MOVIE)
  assert.deepEqual(m.recommendations.map((r) => r.title), ['The Dark Knight'])
  assert.equal(m.recommendations[0].year, '2008')
})

test('normalizeMovie: sparse answers do not throw', () => {
  const m = D.normalizeMovie({ id: 5 })
  assert.equal(m.title, '')
  assert.equal(m.certification, null)
  assert.deepEqual(m.cast, [])
  assert.deepEqual(m.directors, [])
  assert.equal(m.runtime, null)
  assert.equal(D.normalizeMovie(null), null)
  assert.equal(D.normalizeMovie({}), null)
})

test('normalizeMovie: cast is capped', () => {
  const cast = Array.from({ length: 80 }, (_, i) => ({ id: i + 1, name: `A${i}`, order: i }))
  assert.equal(D.normalizeMovie({ id: 1, credits: { cast } }).cast.length, 24)
})

const RAW_TV = {
  id: 1408, name: 'House', overview: 'Diagnostics.', first_air_date: '2004-11-16', status: 'Ended',
  vote_average: 8.6, vote_count: 6000, backdrop_path: '/hb.jpg', poster_path: '/hp.jpg',
  genres: [{ id: 18, name: 'Drama' }],
  created_by: [{ id: 77, name: 'David Shore', profile_path: null }],
  content_ratings: { results: [{ iso_3166_1: 'CA', rating: '14+' }, { iso_3166_1: 'US', rating: 'TV-14' }] },
  seasons: [
    { season_number: 0, name: 'Specials', episode_count: 4, poster_path: '/s0.jpg', air_date: '2005-01-01' },
    { season_number: 1, name: 'Season 1', episode_count: 22, poster_path: '/s1.jpg', air_date: '2004-11-16' },
    { season_number: 2, name: 'Season 2', episode_count: 24, poster_path: null, air_date: '2005-09-13' }
  ],
  aggregate_credits: {
    cast: [
      { id: 2, name: 'Second', profile_path: '/b.jpg', roles: [{ character: 'Wilson', episode_count: 100 }], total_episode_count: 100, order: 1 },
      { id: 1, name: 'Hugh Laurie', profile_path: '/a.jpg', roles: [{ character: 'Gregory House', episode_count: 177 }, { character: 'Other', episode_count: 1 }], total_episode_count: 177, order: 0 }
    ],
    crew: [
      { id: 50, name: 'Greg Yaitanes', jobs: [{ job: 'Director', episode_count: 20 }], profile_path: null },
      { id: 51, name: 'A Writer', jobs: [{ job: 'Writer', episode_count: 12 }, { job: 'Story', episode_count: 3 }] },
      { id: 52, name: 'A Grip', jobs: [{ job: 'Grip', episode_count: 100 }] }
    ]
  }
}

test('normalizeTv: series cast in billing order with characters and episode counts, Specials kept', () => {
  const t = D.normalizeTv(RAW_TV)
  assert.equal(t.certification, 'TV-14')
  assert.deepEqual(t.cast.map((c) => c.name), ['Hugh Laurie', 'Second'])
  assert.deepEqual(t.cast[0].characters, ['Gregory House', 'Other'])
  assert.equal(t.cast[0].episodeCount, 177)
  assert.deepEqual(t.seasons.map((s) => s.seasonNumber), [0, 1, 2])
  assert.equal(t.seasons[0].posterPath, '/s0.jpg')
  assert.equal(t.seasons[2].posterPath, null)
  assert.equal(t.seasons[1].episodeCount, 22)
  assert.deepEqual(t.creators.map((c) => c.name), ['David Shore'])
})

test('normalizeTv: directors and writers come from the crew jobs, other crew ignored', () => {
  const t = D.normalizeTv(RAW_TV)
  assert.deepEqual(t.directors.map((d) => d.name), ['Greg Yaitanes'])
  assert.deepEqual(t.writers.map((d) => d.name), ['A Writer'])
  assert.equal(t.writers[0].episodeCount, 15)
})

test('normalizeSeason: guest stars per episode, unnumbered episodes skipped', () => {
  const s = D.normalizeSeason({
    season_number: 2,
    episodes: [
      { episode_number: 1, name: 'Pilot', guest_stars: [{ id: 9, name: 'Guest', character: 'Patient', profile_path: '/g.jpg' }, { name: 'no id' }] },
      { episode_number: 2, name: 'Two' },
      { name: 'TBA' }
    ]
  }, 2)
  assert.equal(s.season, 2)
  assert.deepEqual(s.episodes.map((e) => e.episode), [1, 2])
  assert.deepEqual(s.episodes[0].guests, [{ id: 9, name: 'Guest', profilePath: '/g.jpg', character: 'Patient' }])
  assert.deepEqual(s.episodes[1].guests, [])
  assert.equal(D.normalizeSeason({}, 1), null)
})

test('normalizeEpisodeCredits: cast and guest stars', () => {
  const e = D.normalizeEpisodeCredits({ cast: [{ id: 1, name: 'A', character: 'a' }], guest_stars: [{ id: 2, name: 'B', character: 'b' }], crew: [{ id: 3 }] })
  assert.deepEqual(e.cast.map((c) => c.id), [1])
  assert.deepEqual(e.guests.map((c) => c.id), [2])
  assert.deepEqual(D.normalizeEpisodeCredits({}), { cast: [], guests: [] })
  assert.equal(D.normalizeEpisodeCredits(null), null)
})

test('normalizePerson: header fields, long biographies trimmed', () => {
  const p = D.normalizePerson({ id: 6193, name: 'Leo', biography: 'x'.repeat(9000), birthday: '1974-11-11', place_of_birth: 'LA', profile_path: '/l.jpg', known_for_department: 'Acting' })
  assert.equal(p.biography.length, 6000)
  assert.equal(p.knownFor, 'Acting')
  assert.equal(D.normalizePerson({}), null)
})

// ---- the service: cache, TTL, offline, concurrency ---------------------------------------------------
function fakeApi(responses, log = []) {
  return {
    get: async (apiPath, params) => {
      log.push({ apiPath, params })
      const r = typeof responses === 'function' ? responses(apiPath, params) : responses[apiPath]
      await new Promise((resolve) => setImmediate(resolve))
      if (!r) return { ok: false, status: 404 }
      if (r.fail) return r.fail
      return { ok: true, data: r }
    }
  }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-details-'))

test('a movie lookup asks TMDB once (with adult content off), then answers from cache', async () => {
  const log = []
  let t = 1000
  const svc = D.createTmdbDetails({ getApi: () => fakeApi({ '/movie/27205': RAW_MOVIE }, log), getCacheDir: () => null, now: () => t })
  const a = await svc.movie(27205)
  assert.equal(a.ok, true)
  assert.equal(a.cached, false)
  assert.equal(a.data.title, 'Inception')
  const b = await svc.movie('27205')
  assert.equal(b.cached, true)
  assert.equal(log.length, 1)
  assert.equal(log[0].params.include_adult, 'false')
  assert.equal(log[0].params.append_to_response, 'credits,release_dates,recommendations')
  assert.equal(log[0].params.language, 'en-US')
})

test('answers expire per kind: a movie after 14 days, an episode\'s credits much later', async () => {
  const log = []
  let t = 0
  const svc = D.createTmdbDetails({
    getApi: () => fakeApi((p) => (p.includes('/episode/') ? { cast: [], guest_stars: [] } : RAW_MOVIE), log),
    getCacheDir: () => null, now: () => t
  })
  await svc.movie(1)
  await svc.tvEpisode(5, 1, 1)
  assert.equal(log.length, 2)
  t = 13 * 24 * 3600 * 1000
  await svc.movie(1); await svc.tvEpisode(5, 1, 1)
  assert.equal(log.length, 2, 'still fresh')
  t = 15 * 24 * 3600 * 1000
  await svc.movie(1); await svc.tvEpisode(5, 1, 1)
  assert.equal(log.length, 3, 'the movie was fetched again, the episode credits were not')
  assert.equal(D.TTL.episode > D.TTL.movie, true)
})

test('offline after expiry: the old answer is served, marked stale', async () => {
  let t = 0
  let online = true
  const svc = D.createTmdbDetails({
    getApi: () => fakeApi(() => (online ? RAW_MOVIE : { fail: { ok: false, status: 0, error: 'offline' } })),
    getCacheDir: () => null, now: () => t
  })
  await svc.movie(1)
  online = false
  t = 30 * 24 * 3600 * 1000
  const r = await svc.movie(1)
  assert.equal(r.ok, true)
  assert.equal(r.stale, true)
  assert.equal(r.data.title, 'Inception')
})

test('a failed lookup is reported and NOT cached', async () => {
  let up = false
  const log = []
  const svc = D.createTmdbDetails({ getApi: () => fakeApi(() => (up ? RAW_MOVIE : { fail: { ok: false, status: 500 } }), log), getCacheDir: () => null })
  assert.deepEqual(await svc.movie(1), { ok: false, error: 'http_500' })
  up = true
  assert.equal((await svc.movie(1)).ok, true)
  assert.equal(log.length, 2)
})

test('offline with nothing cached, not-found, and no API key each have their own error', async () => {
  const offline = D.createTmdbDetails({ getApi: () => fakeApi(() => ({ fail: { ok: false, status: 0, error: 'x' } })), getCacheDir: () => null })
  assert.equal((await offline.movie(1)).error, 'offline')
  const missing = D.createTmdbDetails({ getApi: () => fakeApi({}), getCacheDir: () => null })
  assert.equal((await missing.movie(1)).error, 'not_found')
  const noKey = D.createTmdbDetails({ getApi: () => null, getCacheDir: () => null })
  assert.equal((await noKey.movie(1)).error, 'no_api_key')
})

test('bad ids never reach TMDB', async () => {
  const log = []
  const svc = D.createTmdbDetails({ getApi: () => fakeApi(() => RAW_MOVIE, log), getCacheDir: () => null })
  for (const bad of [0, -1, 1.5, 'abc', null, undefined, '1; DROP', '../x']) {
    assert.equal((await svc.movie(bad)).error, 'bad_id')
    assert.equal((await svc.tv(bad)).error, 'bad_id')
    assert.equal((await svc.person(bad)).error, 'bad_id')
  }
  assert.equal((await svc.tvSeason(5, -1)).error, 'bad_id')
  assert.equal((await svc.tvSeason(5, 'x')).error, 'bad_id')
  assert.equal((await svc.tvEpisode(5, 1, 0)).error, 'bad_id')
  assert.equal(log.length, 0)
})

test('season 0 (Specials) is a valid season to ask for', async () => {
  const log = []
  const svc = D.createTmdbDetails({ getApi: () => fakeApi(() => ({ season_number: 0, episodes: [{ episode_number: 1, name: 'x' }] }), log), getCacheDir: () => null })
  const r = await svc.tvSeason(5, 0)
  assert.equal(r.ok, true)
  assert.equal(log[0].apiPath, '/tv/5/season/0')
})

test('two simultaneous asks for the same thing make one request', async () => {
  const log = []
  const svc = D.createTmdbDetails({ getApi: () => fakeApi(() => RAW_MOVIE, log), getCacheDir: () => null })
  await Promise.all([svc.movie(9), svc.movie(9), svc.movie(9)])
  assert.equal(log.length, 1)
})

test('never more than four TMDB requests in flight, however many are asked for', async () => {
  let active = 0
  let peak = 0
  const api = {
    get: async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 5))
      active--
      return { ok: true, data: { cast: [], guest_stars: [] } }
    }
  }
  const svc = D.createTmdbDetails({ getApi: () => api, getCacheDir: () => null })
  const results = await Promise.all(Array.from({ length: 30 }, (_, i) => svc.tvEpisode(7, 1, i + 1)))
  assert.ok(results.every((r) => r.ok))
  assert.equal(peak, D.MAX_CONCURRENT)
  assert.equal(D.MAX_CONCURRENT, 4)
})

test('answers are written to the cache folder and read back by a new process', async () => {
  const dir = tmp()
  try {
    const log = []
    const one = D.createTmdbDetails({ getApi: () => fakeApi(() => RAW_MOVIE, log), getCacheDir: () => dir })
    await one.movie(27205)
    await one.tvEpisode(1, 2, 3)
    one.flush()
    assert.ok(fs.existsSync(path.join(dir, 'details', 'movies.json')))
    assert.ok(fs.existsSync(path.join(dir, 'details', 'episodes-1.json')))
    const two = D.createTmdbDetails({ getApi: () => null, getCacheDir: () => dir })
    const r = await two.movie(27205)
    assert.equal(r.ok, true, 'served from disk with no key and no network')
    assert.equal(r.data.title, 'Inception')
    assert.equal(r.cached, true)
    const ep = await two.tvEpisode(1, 2, 3)
    assert.equal(ep.ok, true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a damaged cache file is ignored', async () => {
  const dir = tmp()
  try {
    fs.mkdirSync(path.join(dir, 'details'))
    fs.writeFileSync(path.join(dir, 'details', 'movies.json'), '{{{')
    const svc = D.createTmdbDetails({ getApi: () => fakeApi(() => RAW_MOVIE), getCacheDir: () => dir })
    assert.equal((await svc.movie(1)).ok, true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the store keeps only its newest maxEntries', () => {
  const store = D.createTtlStore({ getFile: () => null, ttlMs: 1000, maxEntries: 3 })
  for (let i = 0; i < 6; i++) store.set(`k${i}`, i)
  assert.equal(store.size(), 3)
  assert.equal(store.get('k0'), undefined)
  assert.equal(store.get('k5').value, 5)
})

test('nothing in a returned record can carry the API key', async () => {
  const svc = D.createTmdbDetails({ getApi: () => fakeApi(() => RAW_MOVIE), getCacheDir: () => null })
  const r = await svc.movie(27205)
  assert.doesNotMatch(JSON.stringify(r), /api_key|Bearer/i)
})
