// The phone actor page's server side: GET /api/actor/<id>/missing ("Not in your
// library"), GET /api/trailer, GET /api/search-sites, plus the pure helpers
// behind them (electron/actorGaps.js, trailers.js, searchSites.js).
// A real server on a spare port over a fixture library; TMDB is a mocked fetch.
// Run: node --test test/actor-page-api.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const fsSync = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))
const actorGaps = localRequire('./electron/actorGaps')
const trailers = localRequire('./electron/trailers')
const searchSites = localRequire('./electron/searchSites')

const credit = (o) => ({
  mediaType: 'movie', character: 'Lead', order: 0, voteCount: 500, popularity: 10, genreIds: [35], episodeCount: null, posterPath: '/p.jpg', ...o
})

test('buildActorGaps: same filters and ranking as the desktop gap list', () => {
  const credits = [
    credit({ id: 1, title: 'Owned', date: '1994-01-01' }),
    credit({ id: 2, title: 'Big Film', date: '1998-06-05', voteCount: 18000 }),
    credit({ id: 3, title: 'Future', date: '2099-01-01' }),
    credit({ id: 4, title: 'Talk', date: '2001-01-01', character: 'Self' }),
    credit({ id: 5, title: 'Walk-on', date: '2002-01-01', character: 'Man (uncredited)' }),
    credit({ id: 6, title: 'Obscure', date: '2003-01-01', voteCount: 5 }),
    credit({ id: 7, title: 'Making Of', date: '2004-01-01', genreIds: [99], voteCount: 150 }),
    credit({ id: 8, title: 'Billed Low', date: '2005-01-01', order: 30, voteCount: 400 }),
    credit({ id: 9, title: 'Billed Low But Huge', date: '2006-01-01', order: 30, voteCount: 5000 }),
    credit({ id: 10, title: 'Dual Role', date: '2007-01-01', order: 5 }),
    credit({ id: 10, title: 'Dual Role', date: '2007-01-01', order: 2, character: 'Twin' }),
    credit({ id: 11, title: 'A Show', date: '2010-01-01', mediaType: 'tv', order: 40, episodeCount: 12 })
  ]
  const out = actorGaps.buildActorGaps(credits, 'movie', new Set([1]), new Set(), '2026-09-16')
  assert.deepEqual(out.map((c) => c.id), [10, 9, 2], 'newest first after ranking')
  assert.equal(out[0].character, 'Twin', 'better-billed copy of a dual role')
  const tv = actorGaps.buildActorGaps(credits, 'tv', new Set(), new Set(), '2026-09-16')
  assert.deepEqual(tv.map((c) => c.id), [11], 'a recurring TV role counts despite billing')

  // The cap keeps the most notable, not the newest.
  const many = Array.from({ length: 80 }, (_, i) => credit({ id: 100 + i, title: 'T' + i, date: `19${String(i % 100).padStart(2, '0')}-01-01`, voteCount: 100 + i }))
  const capped = actorGaps.buildActorGaps(many, 'movie', new Set(), new Set(), '2026-09-16')
  assert.equal(capped.length, actorGaps.ACTOR_GAP_CAP)
  assert.ok(!capped.some((c) => c.voteCount < 120), 'the 20 least-voted are the ones cut')
})

test('missingForPhone: contract shape, films then shows, maybe-owned left out', () => {
  const credits = [
    credit({ id: 2, title: 'Liar Liar', date: '1997-03-21', voteCount: 5000, overview: 'A lawyer cannot lie.' }),
    credit({ id: 3, title: 'The Truman Show', date: '1998-06-05', voteCount: 18000, posterPath: null }),
    credit({ id: 4, title: 'Kidding', date: '2018-09-09', mediaType: 'tv', episodeCount: 20 })
  ]
  const items = actorGaps.missingForPhone(credits, {
    ownedMovieIds: new Set(),
    ownedTvIds: new Set(),
    unmatchedMovieKeys: new Set([actorGaps.looseTitleKey('Liar, Liar!')]),
    today: '2026-09-16'
  })
  assert.deepEqual(items, [
    { tmdbId: 3, kind: 'movie', title: 'The Truman Show', year: 1998, poster: null, voteCount: 18000, character: 'Lead', overview: null },
    { tmdbId: 4, kind: 'tv', title: 'Kidding', year: 2018, poster: 'https://image.tmdb.org/t/p/w300/p.jpg', voteCount: 500, character: 'Lead', overview: null }
  ])
})

test('trimPersonCredits keeps the shape main.js has always written', () => {
  const rows = actorGaps.trimPersonCredits({
    cast: [{ id: 7, media_type: 'tv', name: 'Show', first_air_date: '2000-01-01', poster_path: '/x.jpg', character: 'Bob', order: 3, vote_count: 9, popularity: 1.5, genre_ids: [18], episode_count: 4, overview: 'x'.repeat(500) }]
  })
  assert.deepEqual(Object.keys(rows[0]), ['id', 'mediaType', 'title', 'date', 'posterPath', 'character', 'order', 'voteCount', 'popularity', 'genreIds', 'episodeCount', 'overview'])
  assert.equal(rows[0].title, 'Show')
  assert.equal(rows[0].overview.length, 300)
  assert.deepEqual(actorGaps.trimPersonCredits(null), [])
})

test('pickTrailer: YouTube trailer, official, English, newest; never a featurette', () => {
  const v = (o) => ({ site: 'YouTube', type: 'Trailer', official: false, iso_639_1: 'en', key: 'aaaaaaaaaaa', name: 'x', published_at: '2020-01-01', ...o })
  assert.equal(trailers.pickTrailer([]), null)
  assert.equal(trailers.pickTrailer([v({ type: 'Featurette' }), v({ type: 'Clip' })]), null)
  assert.equal(trailers.pickTrailer([v({ site: 'Vimeo' })]), null)
  assert.equal(trailers.pickTrailer([v({ key: 'bad key!' })]), null)
  assert.deepEqual(trailers.pickTrailer([v({ type: 'Teaser', key: 'teaser00001', official: true }), v({ key: 'trailer0001', name: 'Trailer' })]), { youtubeKey: 'trailer0001', name: 'Trailer' })
  assert.equal(trailers.pickTrailer([v({ key: 'unofficial1' }), v({ key: 'official001', official: true })]).youtubeKey, 'official001')
  assert.equal(trailers.pickTrailer([v({ key: 'french00001', iso_639_1: 'fr' }), v({ key: 'english0001' })]).youtubeKey, 'english0001')
  assert.equal(trailers.pickTrailer([v({ key: 'older000001' }), v({ key: 'newer000001', published_at: '2023-01-01' })]).youtubeKey, 'newer000001')
})

test('trailer cache: found kept 30 days, none for a day, survives a restart', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'beebo-trailer-cache-'))
  try {
    let t = 1_000_000
    const cache = trailers.createTrailerCache({ getCacheDir: () => dir, now: () => t })
    assert.equal(cache.get('movie', 1), undefined)
    cache.set('movie', 1, { youtubeKey: 'abcdefghijk', name: 'T' })
    cache.set('tv', 2, null)
    assert.deepEqual(cache.get('movie', 1), { youtubeKey: 'abcdefghijk', name: 'T' })
    assert.equal(cache.get('tv', 2), null)
    const reloaded = trailers.createTrailerCache({ getCacheDir: () => dir, now: () => t })
    assert.deepEqual(reloaded.get('movie', 1), { youtubeKey: 'abcdefghijk', name: 'T' })
    t += trailers.NONE_TTL_MS + 1
    assert.equal(reloaded.get('tv', 2), undefined, 'no-trailer answer expires after a day')
    assert.ok(reloaded.get('movie', 1))
    t += trailers.FOUND_TTL_MS
    assert.equal(reloaded.get('movie', 1), undefined)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('search sites: section choice, custom sites, fallbacks', () => {
  const sites = [{ id: 'abc', name: 'My Tracker', urlTemplate: 'https://tracker.example/s?q={query}' }, { id: 'bad', name: 'Bad', urlTemplate: 'javascript:alert({query})' }]
  assert.deepEqual(searchSites.resolveEngine('custom:abc', sites), { engine: 'custom', name: 'My Tracker', urlTemplate: 'https://tracker.example/s?q={query}', appendYear: false })
  assert.equal(searchSites.resolveEngine('custom:bad', sites), null)
  assert.equal(searchSites.resolveEngine('custom:gone', sites), null)
  assert.equal(searchSites.resolveEngine('adhoc', sites), null)
  assert.deepEqual(searchSites.resolveEngine('imdb', sites), { engine: 'imdb', name: 'IMDb', urlTemplate: 'https://www.imdb.com/find/?q={query}&s=tt', appendYear: true })
  const store = (data) => ({ get: (k) => data[k] })
  let out = searchSites.resolveSearchSites(store({ customSearchSites: sites, moviesSearchEngine: 'custom:abc', tvShowsSearchEngine: '' }))
  assert.equal(out.movies.name, 'My Tracker')
  assert.equal(out.tv.engine, 'google', 'nothing chosen: Google')
  assert.equal(out.google.engine, 'google')
  out = searchSites.resolveSearchSites(store({ missingSearchEngine: 'bing', tvShowsSearchEngine: 'duckduckgo' }))
  assert.equal(out.movies.engine, 'bing', 'the older app-wide choice still counts')
  assert.equal(out.tv.engine, 'duckduckgo')
})

test('the actor-page endpoints over a fixture library with a mocked TMDB', async () => {
  const server = localRequire('./electron/streamServer')
  const auth = localRequire('./electron/auth')
  const savedKey = process.env.TMDB_API_KEY
  const realFetch = globalThis.fetch
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'beebo-actor-test-'))
  const moviesDir = path.join(root, 'Movies')
  const tvDir = path.join(root, 'TV')
  const cacheDir = path.join(root, 'tmdb')
  const tmdbCalls = []
  const PERSON = 206
  const CREDITS = {
    cast: [
      { id: 854, media_type: 'movie', title: 'The Mask', release_date: '1994-07-29', character: 'Stanley Ipkiss', order: 0, vote_count: 9000, popularity: 40, genre_ids: [35] },
      { id: 1624, media_type: 'movie', title: 'Liar Liar', release_date: '1997-03-21', character: 'Fletcher Reede', order: 0, vote_count: 5000, popularity: 30, genre_ids: [35] },
      { id: 37165, media_type: 'movie', title: 'The Truman Show', release_date: '1998-06-04', character: 'Truman Burbank', order: 0, vote_count: 18000, popularity: 50, genre_ids: [35, 18], poster_path: '/truman.jpg', overview: 'He does not know.' },
      { id: 9999, media_type: 'tv', name: 'Late Show', first_air_date: '1993-08-30', character: 'Self', vote_count: 900, genre_ids: [10767], episode_count: 12 },
      { id: 80000, media_type: 'tv', name: 'Kidding', first_air_date: '2018-09-09', character: 'Jeff', order: 0, vote_count: 300, popularity: 12, genre_ids: [35], episode_count: 20, poster_path: '/kidding.jpg' },
      { id: 70000, media_type: 'tv', name: 'In Living Color', first_air_date: '1990-04-15', character: 'Various', order: 1, vote_count: 400, popularity: 9, genre_ids: [35], episode_count: 60 },
      { id: 555, media_type: 'movie', title: 'Announced', release_date: '2099-01-01', order: 0, vote_count: 50 }
    ]
  }
  const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
  globalThis.fetch = async (url, opts) => {
    const u = String(url)
    if (!u.startsWith('https://api.themoviedb.org/3/')) return realFetch(url, opts)
    tmdbCalls.push(u)
    const p = new URL(u).pathname.replace('/3', '')
    if (p === `/person/${PERSON}/combined_credits`) return json(200, CREDITS)
    if (p === '/person/1/combined_credits') throw new Error('getaddrinfo ENOTFOUND api.themoviedb.org')
    if (p === '/movie/37165/videos') {
      return json(200, { results: [
        { site: 'YouTube', type: 'Featurette', key: 'feature0001', official: true, iso_639_1: 'en' },
        { site: 'YouTube', type: 'Trailer', key: 'dlnmQbPGuls', name: 'Official Trailer', official: true, iso_639_1: 'en' }
      ] })
    }
    if (p === '/tv/80000/videos') return json(200, { results: [] })
    return json(404, { status_code: 34 })
  }
  let info
  try {
    await fs.mkdir(moviesDir, { recursive: true })
    await fs.mkdir(path.join(tvDir, 'In Living Color'), { recursive: true })
    for (const f of ['The Mask (1994).mp4', 'Liar Liar (1997).mp4']) await fs.writeFile(path.join(moviesDir, f), 'x')
    await fs.writeFile(path.join(tvDir, 'In Living Color', 'In Living Color S01E01.mp4'), 'x')
    await fs.mkdir(path.join(cacheDir, 'posters'), { recursive: true })
    // The Mask is matched; Liar Liar is a file TMDB never matched.
    await fs.writeFile(path.join(cacheDir, 'manifest.json'), JSON.stringify({
      'The Mask (1994).mp4': { id: 854, title: 'The Mask', release_date: '1994-07-29', poster_path: '/mask.jpg', genre_ids: [35] }
    }))
    await fs.writeFile(path.join(cacheDir, 'credits.json'), JSON.stringify({ 854: [{ id: PERSON, name: 'Jim Carrey', character: 'Stanley Ipkiss' }] }))
    // In Living Color is matched under both manifest key styles the server reads.
    const showKey = server.encodeId('in living color')
    const ilc = { id: 70000, name: 'In Living Color', first_air_date: '1990-04-15', poster_path: '/ilc.jpg', genre_ids: [35] }
    await fs.writeFile(path.join(cacheDir, 'tv-manifest.json'), JSON.stringify({ 'in living color': ilc, [showKey]: ilc }))
    // Someone else already has a personCredits.json entry (written by the desktop app).
    await fs.writeFile(path.join(cacheDir, 'personCredits.json'), JSON.stringify({ 31: [{ id: 13, mediaType: 'movie', title: 'Forrest Gump' }] }))

    const data = {
      customSearchSites: [{ id: 'abc', name: 'My Tracker', urlTemplate: 'https://tracker.example/s?q={query}' }],
      moviesSearchEngine: 'custom:abc'
    }
    const store = { get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] }, onDidChange: () => () => {} }
    const { user } = auth.createUser(store, 'Viewer', 'viewer@example.com')
    const token = server.makeApiToken(store, user.id)

    delete process.env.TMDB_API_KEY
    const port = 47000 + Math.floor(Math.random() * 900) + 50
    info = server.startStreamServer({
      port, store, getMoviesDir: () => moviesDir, getTvShowsDir: () => tvDir,
      getAllMoviesDirs: () => [moviesDir], getAllTvShowsDirs: () => [tvDir],
      getTmdbCacheDir: () => cacheDir, log: () => {}
    })
    const base = 'http://127.0.0.1:' + info.port
    for (let i = 0; i < 50; i++) {
      try { await (await fetch(base + '/api/ping')).arrayBuffer(); break } catch { await new Promise((r) => setTimeout(r, 100)) }
    }
    const call = async (u) => {
      const res = await fetch(base + u, { headers: { Authorization: 'Bearer ' + token } })
      return { status: res.status, body: await res.json() }
    }

    let r = await fetch(base + `/api/actor/${PERSON}/missing`)
    assert.equal(r.status, 401, 'signed-in only')
    await r.arrayBuffer()

    // No TMDB key and nothing cached: not an error, just nothing to show.
    r = await call(`/api/actor/${PERSON}/missing`)
    assert.equal(r.status, 200)
    assert.deepEqual(r.body, { ok: true, person: { id: PERSON, name: 'Jim Carrey' }, items: [], reason: 'no_api_key' })
    r = await call('/api/trailer?kind=movie&tmdbId=37165')
    assert.deepEqual(r.body, { ok: true, youtubeKey: null, name: null, reason: 'no_api_key' })
    assert.equal(tmdbCalls.length, 0)

    process.env.TMDB_API_KEY = 'test-key'

    // The owned list now carries TMDB ids for the trailer button.
    r = await call('/api/movies')
    assert.equal(r.body.items.find((m) => m.title === 'The Mask').tmdbId, 854)
    assert.equal(r.body.items.find((m) => m.title !== 'The Mask').tmdbId, null)
    r = await call('/api/tvshows')
    assert.equal(r.body.items[0].tmdbId, 70000)

    r = await call(`/api/actor/${PERSON}/missing`)
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    assert.equal(r.body.reason, undefined)
    assert.deepEqual(r.body.items, [
      { tmdbId: 37165, kind: 'movie', title: 'The Truman Show', year: 1998, poster: 'https://image.tmdb.org/t/p/w300/truman.jpg', voteCount: 18000, character: 'Truman Burbank', overview: 'He does not know.', request: null },
      { tmdbId: 80000, kind: 'tv', title: 'Kidding', year: 2018, poster: 'https://image.tmdb.org/t/p/w300/kidding.jpg', voteCount: 300, character: 'Jeff', overview: null, request: null }
    ], 'owned (The Mask, In Living Color), probably-owned (Liar Liar), talk shows and unreleased are left out')
    const creditsCalls = tmdbCalls.filter((u) => u.includes('/combined_credits')).length
    assert.equal(creditsCalls, 1)
    const onDisk = JSON.parse(fsSync.readFileSync(path.join(cacheDir, 'personCredits.json'), 'utf8'))
    assert.ok(Array.isArray(onDisk[PERSON]), 'saved for next time')
    assert.ok(Array.isArray(onDisk[31]), 'the desktop app\'s entries are kept')

    // A request filed for a missing title shows up on it.
    const post = await fetch(base + '/api/title-requests', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'movie', tmdbId: 37165, title: 'The Truman Show', year: 1998 })
    })
    assert.equal(post.status, 200)
    await post.arrayBuffer()
    r = await call(`/api/actor/${PERSON}/missing`)
    assert.equal(r.body.items[0].request.status, 'requested')
    assert.equal(r.body.items[0].request.mine, true)
    assert.equal(tmdbCalls.filter((u) => u.includes('/combined_credits')).length, 1, 'second visit is served from the cache')

    // Offline for a person never seen: ok, empty, and not remembered.
    r = await call('/api/actor/1/missing')
    assert.deepEqual(r.body, { ok: true, person: { id: 1, name: null }, items: [], reason: 'tmdb_unreachable' })
    assert.equal(JSON.parse(fsSync.readFileSync(path.join(cacheDir, 'personCredits.json'), 'utf8'))[1], undefined)
    r = await call('/api/actor/abc/missing')
    assert.equal(r.status, 400)

    // Trailers.
    r = await call('/api/trailer?kind=movie&tmdbId=37165')
    assert.deepEqual(r.body, { ok: true, youtubeKey: 'dlnmQbPGuls', name: 'Official Trailer' })
    const before = tmdbCalls.length
    r = await call('/api/trailer?kind=movie&tmdbId=37165')
    assert.equal(r.body.youtubeKey, 'dlnmQbPGuls')
    assert.equal(tmdbCalls.length, before, 'cached')
    r = await call('/api/trailer?kind=tv&tmdbId=80000')
    assert.deepEqual(r.body, { ok: true, youtubeKey: null, name: null })
    const afterNone = tmdbCalls.length
    r = await call('/api/trailer?kind=tv&tmdbId=80000')
    assert.equal(tmdbCalls.length, afterNone, 'no-trailer is cached too')
    assert.ok(fsSync.existsSync(path.join(cacheDir, 'trailers.json')))
    r = await call('/api/trailer?kind=book&tmdbId=1')
    assert.equal(r.status, 400)
    r = await call('/api/trailer?kind=movie&tmdbId=-4')
    assert.equal(r.status, 400)

    // Look-it-up sites.
    r = await call('/api/search-sites')
    assert.equal(r.status, 200)
    assert.deepEqual(r.body.movies, { engine: 'custom', name: 'My Tracker', urlTemplate: 'https://tracker.example/s?q={query}', appendYear: false })
    assert.equal(r.body.tv.engine, 'google')
    assert.equal(r.body.google.urlTemplate, 'https://www.google.com/search?q={query}')
  } finally {
    globalThis.fetch = realFetch
    if (savedKey !== undefined) process.env.TMDB_API_KEY = savedKey
    else delete process.env.TMDB_API_KEY
    if (info) await new Promise((r) => info.close(r))
    await fs.rm(root, { recursive: true, force: true })
  }
})
