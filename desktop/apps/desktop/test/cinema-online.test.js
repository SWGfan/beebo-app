// Cinema Mode's TMDB source: only OFFICIAL YouTube trailers with exact 11-character ids, adult titles
// dropped, everything trimmed to small records, failures quiet and never cached, information cards with
// no playable field. No network: a fake TMDB client.
// Run: node --test test/cinema-online.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const online = require('../electron/cinemaOnline')

const video = (o) => ({ site: 'YouTube', type: 'Trailer', official: true, key: 'AbCdEfGhI01', iso_639_1: 'en', published_at: '2024-01-01T00:00:00.000Z', name: 'Official Trailer', ...o })

function api(routes, log = []) {
  return {
    get: async (p, params) => {
      log.push({ p, params })
      const r = routes[p]
      if (r === undefined) return { ok: false, status: 404 }
      if (typeof r === 'function') return r(p, params)
      return r
    }
  }
}
const okData = (data) => ({ ok: true, data })

test('officialTrailerKey: official YouTube trailers/teasers only, strict 11-character ids', () => {
  assert.equal(online.officialTrailerKey([video({})]), 'AbCdEfGhI01')
  assert.equal(online.officialTrailerKey([video({ official: false })]), null, 'unofficial uploads are not used')
  assert.equal(online.officialTrailerKey([video({ site: 'Vimeo' })]), null)
  assert.equal(online.officialTrailerKey([video({ type: 'Clip' }), video({ type: 'Featurette' }), video({ type: 'Behind the Scenes' })]), null)
  for (const key of ['short', 'AbCdEfGhI012', 'AbCdEfGhI0/', '"><script>', '', null, undefined, 12345678901]) {
    assert.equal(online.officialTrailerKey([video({ key })]), null, String(key))
  }
  assert.equal(online.officialTrailerKey([video({ type: 'Teaser', key: 'TeaserKey01' }), video({ key: 'TrailerKey1' })]), 'TrailerKey1', 'a Trailer beats a Teaser')
  assert.equal(online.officialTrailerKey(undefined), null)
})

test('shapeDetails: small record, US certification, genre ids, adult titles dropped', () => {
  const rec = online.shapeDetails({
    id: 5, title: '  A\u0000  Film  ', release_date: '2021-03-04', adult: false, genres: [{ id: 28, name: 'Action' }, { id: 'x' }, { id: 12 }],
    belongs_to_collection: { id: 77, name: 'Saga' },
    release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ certification: 'PG-13', type: 3 }] }] },
    videos: { results: [video({})] }, overview: 'never kept', poster_path: '/x.jpg'
  })
  assert.deepEqual(rec, { tmdbId: 5, title: 'A Film', year: 2021, genres: [28, 12], certification: 'PG-13', collectionId: 77, youtubeKey: 'AbCdEfGhI01' })
  assert.equal(online.shapeDetails({ id: 6, adult: true, title: 'x' }), null)
  assert.equal(online.shapeDetails({ id: 'nope' }), null)
  assert.equal(online.shapeDetails(null), null)
})

test('details: one call with videos + release dates, cached, and no cache for a failed lookup', async () => {
  const log = []
  let up = true
  const a = { get: async (p, params) => { log.push({ p, params }); return up ? okData({ id: 9, title: 'Nine', release_date: '2020-01-01', genres: [], release_dates: { results: [] }, videos: { results: [video({})] } }) : { ok: false, status: 0 } } }
  let t = 1000
  const src = online.createOnlineSource({ getApi: () => a, now: () => t })
  const first = await src.details(9)
  assert.equal(first.youtubeKey, 'AbCdEfGhI01')
  assert.equal(log.length, 1)
  assert.equal(log[0].p, '/movie/9')
  assert.equal(log[0].params.append_to_response, 'videos,release_dates')
  assert.equal(log[0].params.include_video_language, 'en,null')
  await src.details(9)
  assert.equal(log.length, 1, 'answered from memory')
  t += 8 * 24 * 3600_000
  up = false
  const stale = await src.details(9)
  assert.equal(stale.youtubeKey, 'AbCdEfGhI01', 'stale beats nothing when TMDB is unreachable')
  assert.equal(src.isReachable(), false)
  const miss = await src.details(10)
  assert.equal(miss, null)
  up = true
  await src.details(10)
  assert.equal(log.filter((l) => l.p === '/movie/10').length, 2, 'a failure is not cached: the next play asks again')
  assert.equal(src.isReachable(), true)
  assert.equal(await src.details('abc'), null)
  assert.equal(await src.details(-4), null)
})

test('no key, a timeout or a throwing client all give nothing and never throw', async () => {
  const none = online.createOnlineSource({ getApi: () => null })
  assert.equal(none.hasKey(), false)
  assert.equal(await none.details(1), null)
  assert.deepEqual(await none.related(1), [])
  assert.deepEqual(await none.popular(), [])
  assert.deepEqual(await none.comingSoon(), { upcoming: [], nowPlaying: [] })
  const boom = online.createOnlineSource({ getApi: () => ({ get: async () => { throw new Error('socket') } }) })
  assert.equal(await boom.details(1), null)
  assert.equal(boom.isReachable(), false)
  const slow = online.createOnlineSource({ getApi: () => ({ get: () => new Promise(() => {}) }), timeoutMs: 20 })
  assert.equal(await slow.details(1), null)
  assert.equal(slow.isReachable(), false)
  const throwsKey = online.createOnlineSource({ getApi: () => { throw new Error('store') } })
  assert.equal(throwsKey.hasKey(), false)
  assert.equal(await throwsKey.details(1), null)
})

test('related: recommendations then similar, deduped, adult and self dropped, capped', async () => {
  const rows = (ids) => okData({ results: ids.map((id) => ({ id, title: 'T' + id, release_date: '2020-02-02', popularity: id, adult: id === 4 })) })
  const src = online.createOnlineSource({ getApi: () => api({ '/movie/1/recommendations': rows([2, 3, 4, 1]), '/movie/1/similar': rows([3, 5, ...Array.from({ length: 40 }, (_, i) => 100 + i)]) }) })
  const list = await src.related(1)
  assert.equal(list.length, 20)
  assert.deepEqual(list.slice(0, 3).map((r) => r.tmdbId), [2, 3, 5])
  assert.ok(!list.some((r) => r.tmdbId === 4 || r.tmdbId === 1))
  assert.equal(new Set(list.map((r) => r.tmdbId)).size, list.length)
  assert.deepEqual(await src.related('x'), [])
})

test('coming soon cards: text, a date and a poster path - nothing playable, nothing linked', async () => {
  const results = [
    { id: 1, title: 'Soon <b>One</b>', release_date: '2027-05-05', overview: 'A '.repeat(300), poster_path: '/abc123.jpg', video: true, adult: false, backdrop_path: '/b.jpg' },
    { id: 2, title: 'Bad poster', release_date: 'someday', poster_path: 'https://evil.example/x.jpg' },
    { id: 3, title: 'Adult', adult: true },
    { id: 4, title: '   ' }
  ]
  const src = online.createOnlineSource({ getApi: () => api({ '/movie/upcoming': okData({ results }), '/movie/now_playing': okData({ results: [results[0]] }) }) })
  const shelf = await src.comingSoon()
  assert.equal(shelf.upcoming.length, 2)
  assert.deepEqual(Object.keys(shelf.upcoming[0]).sort(), ['overview', 'posterPath', 'releaseDate', 'title', 'tmdbId'])
  assert.equal(shelf.upcoming[0].title, 'Soon <b>One</b>', 'kept as text; the UI shows it as text')
  assert.ok(shelf.upcoming[0].overview.length <= 240)
  assert.equal(shelf.upcoming[0].posterPath, '/abc123.jpg')
  assert.equal(shelf.upcoming[1].posterPath, null, 'only a TMDB image path is kept')
  assert.equal(shelf.upcoming[1].releaseDate, '')
  assert.equal(shelf.nowPlaying.length, 1)
  assert.match(online.TMDB_ATTRIBUTION, /not endorsed or certified by TMDB/)
})
