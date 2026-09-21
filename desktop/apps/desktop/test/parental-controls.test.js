// Parental controls: the rules (parentalControls.js), the one content gate (contentGate.js),
// and a real server over a fixture library proving a restricted profile never sees or streams
// an over-limit title through ANY route family: lists, search, details, episodes, credits,
// stream URL guessing, cast (media-token URLs), downloads, queue/playlist, favourites and
// watchlist, surf, recommended, recently added, collections, the actor filter and the website.
// Run: node --test test/parental-controls.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))
const parental = localRequire('./electron/parentalControls')
const contentGate = localRequire('./electron/contentGate')

const enc = (s) => Buffer.from(s, 'utf8').toString('base64url')

test('ratings: US and Canadian film scales, TV scale, cross-scale, unrated', () => {
  const kids = parental.presetPolicy('kids')
  const info = (kind, certification, extra = {}) => ({ kind, id: 'x', certification, genres: [], ...extra })
  assert.equal(parental.decide(kids, info('movie', 'G')).allowed, true)
  assert.equal(parental.decide(kids, info('movie', 'PG')).allowed, true)
  assert.deepEqual(parental.decide(kids, info('movie', 'PG-13')), { allowed: false, reason: 'rating' })
  assert.equal(parental.decide(kids, info('movie', 'R')).allowed, false)
  assert.equal(parental.decide(kids, info('movie', 'NC-17')).allowed, false)
  assert.equal(parental.decide(kids, info('tv', 'TV-PG')).allowed, true)
  assert.equal(parental.decide(kids, info('tv', 'TV-14')).allowed, false)
  assert.equal(parental.decide(kids, info('tv', 'TV-MA')).allowed, false)
  // A film carrying a TV rating, a show carrying a film rating.
  assert.equal(parental.decide(kids, info('movie', 'TV-MA')).allowed, false)
  assert.equal(parental.decide(kids, info('tv', 'R')).allowed, false)
  assert.equal(parental.decide(kids, info('tv', 'G')).allowed, true)
  // Unrated: hidden by the kids preset (blockUnrated), shown by teens.
  assert.deepEqual(parental.decide(kids, info('movie', '')), { allowed: false, reason: 'unrated' })
  assert.equal(parental.decide(kids, info('movie', 'NR')).allowed, false)
  assert.equal(parental.decide(parental.presetPolicy('teens'), info('movie', null)).allowed, true)

  const ca = parental.normalizePolicy({ enabled: true, ratingSystem: 'CA', movieMax: '14A' })
  assert.equal(parental.decide(ca, info('movie', 'PG-13')).allowed, true)
  assert.equal(parental.decide(ca, info('movie', 'R')).allowed, false, 'US R is above Canadian 14A')
  assert.equal(parental.decide(ca, info('movie', '18A')).allowed, false)
  const ca18 = parental.normalizePolicy({ enabled: true, ratingSystem: 'CA', movieMax: '18A' })
  assert.equal(parental.decide(ca18, info('movie', 'R')).allowed, true)
  assert.equal(parental.decide(ca18, info('movie', 'NC-17')).allowed, false)
  // A limit from the wrong scale is dropped, not misread.
  assert.equal(parental.normalizePolicy({ enabled: true, ratingSystem: 'US', movieMax: '14A' }).movieMax, null)
})

test('genres, blocked titles and collections, allow-list mode, off', () => {
  const p = parental.normalizePolicy({
    enabled: true, movieMax: 'R', blockedGenres: [27], blockedTitles: [{ kind: 'movie', tmdbId: 11 }, { kind: 'tv', id: 'showkey' }],
    blockedCollections: [8091],
  })
  const m = (extra) => ({ kind: 'movie', id: 'a', certification: 'PG', genres: [], ...extra })
  assert.equal(parental.decide(p, m({ genres: [27, 35] })).reason, 'blocked_genre')
  assert.equal(parental.decide(p, m({ tmdbId: 11 })).reason, 'blocked_title')
  assert.equal(parental.decide(p, { kind: 'tv', id: 'showkey', showKey: 'showkey', certification: 'TV-G' }).reason, 'blocked_title')
  assert.equal(parental.decide(p, m({ collectionId: 8091 })).reason, 'blocked_collection')
  assert.equal(parental.decide(p, m({ tmdbId: 12 })).allowed, true)

  const allow = parental.normalizePolicy({ enabled: true, allowListOnly: true, allowedTitles: [{ kind: 'movie', tmdbId: 5 }], allowedCollections: [10194], movieMax: 'G' })
  assert.equal(parental.decide(allow, m({ tmdbId: 6 })).reason, 'not_on_allow_list')
  assert.equal(parental.decide(allow, m({ tmdbId: 5, certification: '' })).allowed, true, 'chosen by name: no rating needed')
  assert.equal(parental.decide(allow, m({ tmdbId: 7, collectionId: 10194, certification: 'G' })).allowed, true)
  assert.equal(parental.decide(allow, m({ tmdbId: 5, certification: 'R' })).allowed, false, 'still under the rating limit')

  const off = parental.normalizePolicy({ preset: 'off', movieMax: 'G' })
  assert.equal(off.enabled, false)
  assert.equal(parental.decide(off, m({ certification: 'NC-17' })).allowed, true)
  assert.equal(parental.presetPolicy('young').tvMax, 'TV-Y')
  assert.deepEqual(parental.editorOptions().presets.map((x) => x.id), ['young', 'kids', 'teens', 'off'])
  // Nothing in the editor reads as child-directed marketing: plain adult labels only.
  for (const pr of parental.editorOptions().presets) assert.doesNotMatch(pr.label, /kiddo|fun|cartoon|!/i)
})

test('bedtime (across midnight), the daily limit and the usage tracker', () => {
  const p = parental.normalizePolicy({ enabled: true, bedtime: { start: '21:00', end: '07:00' }, dailyLimitMinutes: 90 })
  const at = (h, m) => new Date(2026, 8, 17, h, m)
  assert.equal(parental.timeGate(p, at(20, 59), 0).ok, true)
  const late = parental.timeGate(p, at(21, 0), 0)
  assert.equal(late.ok, false)
  assert.equal(late.reason, 'bedtime')
  assert.match(late.message, /07:00/)
  assert.equal(parental.timeGate(p, at(3, 30), 0).reason, 'bedtime')
  assert.equal(parental.timeGate(p, at(7, 0), 0).ok, true)
  assert.equal(parental.timeGate(p, at(12, 0), 89).ok, true)
  const done = parental.timeGate(p, at(12, 0), 90)
  assert.equal(done.reason, 'daily_limit')
  assert.match(done.message, /tomorrow/)
  const day = parental.normalizePolicy({ enabled: true, bedtime: { start: '13:00', end: '15:00' } })
  assert.equal(parental.timeGate(day, at(14, 0)).reason, 'bedtime')
  assert.equal(parental.timeGate(day, at(15, 0)).ok, true)
  assert.equal(parental.normalizePolicy({ enabled: true, bedtime: { start: '25:00', end: '07:00' } }).bedtime, null)

  const data = {}
  const store = { get: (k) => data[k], set: (k, v) => { data[k] = v } }
  let clock = at(10, 0)
  const usage = parental.createUsageTracker(store, { now: () => clock })
  usage.mark('kid'); usage.mark('kid') // same minute counts once
  clock = at(10, 1); usage.mark('kid')
  assert.equal(usage.used('kid'), 2)
  clock = new Date(2026, 8, 18, 10, 0)
  assert.equal(usage.used('kid'), 0, 'a new day starts from zero')
})

test('the owner PIN: hashed, checked in constant time, locked after 5 misses', () => {
  const rec = parental.hashPin('4821')
  assert.notEqual(rec.hash, '4821')
  assert.equal(parental.pinMatches(rec, '4821'), true)
  assert.equal(parental.pinMatches(rec, '4822'), false)
  assert.equal(parental.pinMatches(rec, 'abcd'), false)
  assert.equal(parental.pinMatches(null, '4821'), false)
  let t = 0
  const lim = parental.createPinLimiter({ now: () => t })
  for (let i = 0; i < 4; i++) lim.fail('k')
  assert.equal(lim.locked('k'), 0)
  lim.fail('k')
  assert.ok(lim.locked('k') > 0)
  t += 16 * 60 * 1000
  assert.equal(lim.locked('k'), 0)
})

test('contentGate: filterItems, scrubJson, and outside a request nothing is filtered', () => {
  const infos = {
    'Toy.mp4': { certification: 'G', genres: [16], tmdbId: 862 },
    'Heat.mp4': { certification: 'R', genres: [80], tmdbId: 949 },
  }
  const gate = contentGate.createContentGate({
    readers: () => ({
      movie: (f) => infos[f] || null,
      show: (k) => (k === enc('bluey') ? { certification: 'TV-Y' } : { certification: 'TV-MA' }),
      showKeyOf: (rel) => enc(rel.split('/')[0].toLowerCase()),
    }),
  })
  const kid = { type: 'member', userId: 'k', policy: parental.presetPolicy('kids') }
  const adult = { type: 'member', userId: 'a', policy: parental.normalizePolicy(null) }
  const items = [
    { kind: 'movie', id: enc('Toy.mp4') },
    { stream: '/file?id=' + enc('Heat.mp4') + '&mt=1.x' },
    { showKey: enc('bluey') },
    { kind: 'tv', id: enc('breaking bad/Breaking Bad S01E01.mp4') },
    { note: 'not a title' },
  ]
  assert.equal(gate.filterItems(kid, items).length, 3)
  assert.equal(gate.filterItems(adult, items).length, 5)
  const scrubbed = gate.scrubJson(kid, { ok: true, items, nowPlaying: { kind: 'movie', id: enc('Heat.mp4') }, next: { showKey: enc('bluey') } })
  assert.equal(scrubbed.items.length, 3)
  assert.equal(scrubbed.nowPlaying, null)
  assert.ok(scrubbed.next)
  assert.equal(gate.allowId(kid, 'movie', 'not base64 !!'), false, 'an unreadable id is refused')
  // No request scope: the hook passes everything (background jobs).
  assert.equal(contentGate.filterItemsForRequest(items).length, 5)
  assert.equal(contentGate.mediaScopeForRequest(), '')
  contentGate.runWithScope(gate, () => {
    contentGate.setRequestViewer(kid)
    assert.equal(contentGate.filterItemsForRequest(items).length, 3)
    assert.equal(contentGate.allowIdForRequest('movie', enc('Heat.mp4')), false)
    assert.equal(contentGate.mediaScopeForRequest(), 'u:k')
  })
})

// ---------------------------------------------------------------------------------------------
// A real server
// ---------------------------------------------------------------------------------------------

const SECRET = 'agent-secret-for-tests-0123456789'
let portSeq = 0

async function fixture() {
  const server = localRequire('./electron/streamServer')
  const auth = localRequire('./electron/auth')
  delete process.env.TMDB_API_KEY
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'beebo-parental-'))
  const moviesDir = path.join(root, 'Movies')
  const tvDir = path.join(root, 'TV')
  const cacheDir = path.join(root, 'tmdb')
  await fs.mkdir(moviesDir, { recursive: true })
  await fs.mkdir(path.join(tvDir, 'Bluey'), { recursive: true })
  await fs.mkdir(path.join(tvDir, 'Breaking Bad'), { recursive: true })
  await fs.mkdir(cacheDir, { recursive: true })
  const bytes = Buffer.alloc(4096, 7)
  const films = ['Toy Story (1995).mp4', 'Heat (1995).mp4', 'Alien (1979).mp4', 'Mystery Reel (2001).mp4', 'Paddington (2014).mp4']
  for (const f of films) await fs.writeFile(path.join(moviesDir, f), bytes)
  await fs.writeFile(path.join(tvDir, 'Bluey', 'Bluey S01E01.mp4'), bytes)
  await fs.writeFile(path.join(tvDir, 'Breaking Bad', 'Breaking Bad S01E01.mp4'), bytes)
  await fs.writeFile(path.join(cacheDir, 'manifest.json'), JSON.stringify({
    'Toy Story (1995).mp4': { id: 862, title: 'Toy Story', release_date: '1995-11-22', genre_ids: [16, 35], certification: 'G' },
    'Heat (1995).mp4': { id: 949, title: 'Heat', release_date: '1995-12-15', genre_ids: [80, 16], certification: 'R' },
    'Alien (1979).mp4': { id: 348, title: 'Alien', release_date: '1979-05-25', genre_ids: [27], certification: 'R' },
    'Mystery Reel (2001).mp4': { id: 5001, title: 'Mystery Reel', release_date: '2001-01-01', genre_ids: [16] },
    'Paddington (2014).mp4': { id: 116149, title: 'Paddington', release_date: '2014-11-28', genre_ids: [16, 35], certification: 'PG' },
  }))
  await fs.writeFile(path.join(cacheDir, 'tv-manifest.json'), JSON.stringify({
    bluey: { id: 82728, name: 'Bluey', genre_ids: [16], certification: 'TV-Y' },
    'breaking bad': { id: 1396, name: 'Breaking Bad', genre_ids: [80, 16], certification: 'TV-MA' },
  }))
  await fs.writeFile(path.join(cacheDir, 'credits.json'), JSON.stringify({
    862: [{ id: 31, name: 'Tom Hanks' }], 949: [{ id: 1158, name: 'Al Pacino' }, { id: 31, name: 'Tom Hanks' }],
  }))
  await fs.writeFile(path.join(cacheDir, 'collections.json'), JSON.stringify({
    348: { id: 8091, name: 'Alien Collection', parts: [{ id: 348, title: 'Alien', release_date: '1979-05-25' }, { id: 679, title: 'Aliens', release_date: '1986-07-18' }] },
    862: { id: 10194, name: 'Toy Story Collection', parts: [{ id: 862, title: 'Toy Story', release_date: '1995-11-22' }, { id: 863, title: 'Toy Story 2', release_date: '1999-11-24' }] },
  }))

  const data = {
    authUsers: [
      { id: 'u-owner', name: 'Sam', username: 'nick', status: 'approved', isAdmin: true },
      { id: 'u-kid', name: 'Sam', username: 'sam', status: 'approved' },
      { id: 'u-adult', name: 'Robin', username: 'robin', status: 'approved' },
    ],
  }
  const store = { get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] }, onDidChange: () => () => {} }
  parental.setPolicy(store, 'u-kid', parental.presetPolicy('kids'))
  let shareSyncs = 0
  // A fresh port per server: a pooled keep-alive connection must never reach an earlier one.
  const port = 47100 + (process.pid % 400) + 13 * (++portSeq)
  const info = server.startStreamServer({
    port, store, getMoviesDir: () => moviesDir, getTvShowsDir: () => tvDir,
    getAllMoviesDirs: () => [moviesDir], getAllTvShowsDirs: () => [tvDir],
    getTmdbCacheDir: () => cacheDir, log: () => {}, agentSecret: SECRET,
    onSharesChanged: () => { shareSyncs++ },
  })
  const base = 'http://127.0.0.1:' + info.port
  for (let i = 0; i < 50; i++) {
    try { await (await fetch(base + '/api/ping')).arrayBuffer(); break } catch { await new Promise((r) => setTimeout(r, 100)) }
  }
  const tokens = {
    owner: server.makeApiToken(store, 'u-owner'),
    kid: server.makeApiToken(store, 'u-kid'),
    adult: server.makeApiToken(store, 'u-adult'),
  }
  const api = async (who, u, opts = {}) => {
    const headers = { 'content-type': 'application/json', ...(opts.headers || {}) }
    if (who) headers.authorization = 'Bearer ' + (tokens[who] || who)
    if (opts.agent) Object.assign(headers, { 'x-beebo-agent-key': SECRET })
    const res = await fetch(base + u, { method: opts.method || (opts.body ? 'POST' : 'GET'), headers, body: opts.body ? JSON.stringify(opts.body) : undefined, redirect: 'manual' })
    const text = await res.text()
    let body = null
    try { body = JSON.parse(text) } catch { body = null }
    return { status: res.status, body, text }
  }
  const raw = async (u, headers = {}) => {
    const res = await fetch(base + u, { headers, redirect: 'manual' })
    const buf = Buffer.from(await res.arrayBuffer())
    return { status: res.status, text: buf.toString('utf8'), headers: res.headers }
  }
  const ids = {
    toy: enc('Toy Story (1995).mp4'), heat: enc('Heat (1995).mp4'), alien: enc('Alien (1979).mp4'),
    mystery: enc('Mystery Reel (2001).mp4'), paddington: enc('Paddington (2014).mp4'),
    bluey: enc('bluey'), bb: enc('breaking bad'),
    blueyEp: enc(path.join('Bluey', 'Bluey S01E01.mp4')), bbEp: enc(path.join('Breaking Bad', 'Breaking Bad S01E01.mp4')),
  }
  const close = async () => {
    await new Promise((r) => info.close(r))
    await fs.rm(root, { recursive: true, force: true })
  }
  return { server, auth, store, data, base, api, raw, ids, tokens, close, syncs: () => shareSyncs, moviesDir }
}

test('a restricted profile never sees or streams an over-limit title, through any route family', async () => {
  const f = await fixture()
  const { api, raw, ids } = f
  try {
    // --- lists and search ---
    let r = await api('kid', '/api/movies')
    assert.equal(r.status, 200)
    assert.deepEqual(r.body.items.map((i) => i.id).sort(), [ids.paddington, ids.toy].sort(), 'no R, no unrated')
    r = await api('adult', '/api/movies')
    assert.equal(r.body.items.length, 5, 'an unrestricted member sees everything')
    r = await api('kid', '/api/movies?q=heat')
    assert.deepEqual(r.body.items, [])
    r = await api('kid', '/api/movies?genre=80')
    assert.deepEqual(r.body.items, [], 'the genre filter')
    r = await api('kid', '/api/movies?actor=1158')
    assert.deepEqual(r.body.items, [], 'the actor filter')
    r = await api('kid', '/api/movies?actor=31')
    assert.deepEqual(r.body.items.map((i) => i.id), [ids.toy])
    r = await api('kid', '/api/tvshows')
    assert.equal(r.status, 200)
    const shows = JSON.stringify(r.body)
    assert.ok(shows.includes(ids.bluey))
    assert.ok(!shows.includes(ids.bb), 'no TV-MA show')

    // --- details, episodes, credits, markers, subtitles, library status, up next ---
    r = await api('kid', '/api/tvshows/' + encodeURIComponent(ids.bb) + '/episodes')
    assert.equal(r.status, 404)
    r = await api('kid', '/api/tvshows/' + encodeURIComponent(ids.bluey) + '/episodes')
    assert.equal(r.status, 200)
    for (const u of [
      '/api/credits?kind=movie&id=' + ids.heat, '/api/markers?kind=movie&id=' + ids.heat, '/api/subtitles?kind=movie&id=' + ids.heat,
      '/api/library-status?kind=movie&id=' + ids.heat, '/api/upnext?kind=tv&id=' + ids.bbEp, '/api/episode-context?kind=tv&id=' + ids.bbEp,
      '/api/credits?kind=tv&id=' + ids.bb, '/api/credits?id=' + ids.mystery,
    ]) {
      r = await api('kid', u)
      assert.equal(r.status, 404, u)
    }
    r = await api('adult', '/api/credits?kind=movie&id=' + ids.heat)
    assert.equal(r.status, 200)

    // --- starting a watch session, watched/favourite/watchlist marks, flags ---
    for (const [u, body] of [
      ['/api/watch-session', { kind: 'movie', id: ids.heat }],
      ['/api/watch-session', { kind: 'tv', id: ids.bbEp }],
      ['/api/watchlist', { kind: 'movie', id: ids.alien, title: 'Alien' }],
      ['/api/favorite', { kind: 'movie', id: ids.heat, favorite: true }],
      ['/api/watched/movie', { id: ids.heat, watched: true }],
      ['/api/watched/show', { showKey: ids.bb, watched: true }],
      ['/api/flag-quality', { kind: 'movie', id: ids.heat }],
    ]) {
      r = await api('kid', u, { body })
      assert.equal(r.status, 404, u)
    }
    r = await api('kid', '/api/watch-session', { body: { kind: 'movie', id: ids.toy } })
    assert.equal(r.status, 200)

    // --- lists that store ids from before a limit: watchlist, favourites, the shared queue (a playlist) ---
    f.data.watchlist = { 'u-kid': [{ id: ids.heat, kind: 'movie', title: 'Heat', at: 2 }, { id: ids.toy, kind: 'movie', title: 'Toy Story', at: 1 }] }
    f.data.libraryFlags = { 'u-kid': { ['movie:' + ids.heat]: { favorite: true, at: 2 }, ['movie:' + ids.toy]: { favorite: true, at: 1 } } }
    r = await api('kid', '/api/watchlist')
    assert.deepEqual(r.body.items.map((i) => i.id), [ids.toy])
    r = await api('kid', '/api/favorites')
    assert.deepEqual(r.body.items.map((i) => i.id), [ids.toy])
    r = await api('owner', '/api/queue', { body: { kind: 'movie', id: ids.heat, title: 'Heat' } })
    assert.equal(r.status, 200)
    r = await api('owner', '/api/queue', { body: { kind: 'movie', id: ids.toy, title: 'Toy Story' } })
    r = await api('kid', '/api/queue')
    assert.deepEqual(r.body.items.map((i) => i.id), [ids.toy])
    r = await api('kid', '/api/queue', { body: { kind: 'movie', id: ids.heat, title: 'Heat' } })
    assert.equal(r.status, 404)

    // --- surf / Surprise, recommended ("because you watched"), recently added ---
    for (let i = 0; i < 6; i++) {
      r = await api('kid', '/api/surf?kind=both&seed=7&i=' + i)
      assert.equal(r.body.total, 3, 'Toy Story, Paddington, Bluey')
      assert.ok(![ids.heat, ids.alien, ids.mystery, ids.bbEp].includes(r.body.item.id))
    }
    r = await api('kid', '/api/surf/genres?kind=movie')
    assert.ok(!JSON.stringify(r.body).includes('"id":80'), 'no genre only an R film carries')
    r = await api('kid', '/api/recently-added')
    assert.deepEqual(r.body.items.map((i) => i.id).sort(), [ids.bluey, ids.paddington, ids.toy].sort())
    r = await api('kid', '/api/recommended')
    assert.ok(!JSON.stringify(r.body).includes(ids.heat))

    // --- collections ---
    r = await api('kid', '/api/collections')
    assert.deepEqual(r.body.items.map((c) => c.id), [10194])
    r = await api('kid', '/api/collections/8091')
    assert.equal(r.status, 404)
    r = await api('kid', '/api/collections/10194')
    assert.equal(r.status, 200)
    assert.deepEqual(r.body.collection.parts.map((p) => p.tmdbId), [862], 'no unowned (unrated) sequels')

    // --- what a restricted profile can't use at all ---
    for (const u of ['/api/trailer?kind=movie&tmdbId=949', '/api/search-sites', '/api/title-search?q=heat', '/api/title-requests', '/api/actor/1158/missing', '/api/admin/summary']) {
      r = await api('kid', u)
      assert.equal(r.status, 403, u)
    }
    // Asking the owner for a title it hasn't got, from the app or the website.
    r = await api('kid', '/api/missing-request', { body: { kind: 'movie', title: 'Heat 2' } })
    assert.equal(r.status, 403)
    r = await api('kid', '/api/suggestions', { body: { text: 'add more films' } })
    assert.equal(r.status, 403)
    r = await api('kid', '/api/me')
    assert.equal(r.body.user.restricted, true)
    assert.equal(r.body.user.isAdmin, false)
    r = await api('adult', '/api/me')
    assert.equal(r.body.user.restricted, undefined, 'older apps see the shape they always did')

    // --- streams: guessed ids, cast/download URLs, a token bound to the profile ---
    r = await api('kid', '/api/movies')
    const toyStream = r.body.items.find((i) => i.id === ids.toy).stream
    assert.match(toyStream, /^\/file\?id=.+&mt=\d+\.[^.]+\.[A-Za-z0-9_-]+$/, 'a viewer-bound media token')
    let s = await raw(toyStream, { range: 'bytes=0-9' })
    assert.equal(s.status, 206, 'a Cast device / download with the URL alone plays an allowed title')
    // Swapping the id in the kid's URL: the token doesn't match.
    s = await raw(toyStream.replace(ids.toy, ids.heat))
    assert.equal(s.status, 302)
    // Guessing with a cookie session: refused like a missing file.
    const kidCookie = 'beebo_session=' + f.auth.signSession(f.store, 'u-kid')
    s = await raw('/file?id=' + ids.heat, { cookie: kidCookie, range: 'bytes=0-9' })
    assert.equal(s.status, 404)
    s = await raw('/tvfile?id=' + ids.bbEp, { cookie: kidCookie })
    assert.equal(s.status, 404)
    s = await raw('/subtitles/file?kind=movie&i=0&id=' + ids.heat, { cookie: kidCookie })
    assert.equal(s.status, 404)
    s = await raw('/file?id=' + ids.toy, { cookie: kidCookie, range: 'bytes=0-9' })
    assert.equal(s.status, 206)
    // A token scoped to the kid can't be relabelled as unscoped.
    const scoped = /mt=([^&]+)/.exec(toyStream)[1]
    const [exp, sig] = decodeURIComponent(scoped).split('.')
    s = await raw('/file?id=' + ids.toy + '&mt=' + exp + '.' + sig)
    assert.equal(s.status, 302)

    // --- the website ---
    s = await raw('/', { cookie: kidCookie })
    assert.equal(s.status, 200)
    assert.ok(!s.text.includes(ids.heat) && !s.text.includes(ids.alien), 'home page lists no R film')
    assert.ok(s.text.includes(ids.toy))
    s = await raw('/watch?id=' + ids.heat, { cookie: kidCookie })
    assert.equal(s.status, 404)
    s = await raw('/tvwatch?id=' + ids.bbEp, { cookie: kidCookie })
    assert.equal(s.status, 404)
    s = await raw('/tvshows?show=' + encodeURIComponent(ids.bb), { cookie: kidCookie })
    assert.equal(s.status, 404)
    {
      const res = await fetch(f.base + '/missing-request', { method: 'POST', headers: { cookie: kidCookie, 'content-type': 'application/x-www-form-urlencoded' }, body: 'title=Heat+2', redirect: 'manual' })
      assert.equal(res.status, 403, 'no asking for titles from the website either')
      await res.arrayBuffer()
    }
    for (let i = 0; i < 5; i++) {
      s = await raw('/surprise/play?kind=movie&seed=3&i=' + i, { cookie: kidCookie })
      assert.equal(s.status, 200)
      assert.ok(!s.text.includes(ids.heat) && !s.text.includes(ids.alien) && !s.text.includes(ids.mystery), 'surf never picks an R film')
    }
    const adultCookie = 'beebo_session=' + f.auth.signSession(f.store, 'u-adult')
    s = await raw('/', { cookie: adultCookie })
    assert.ok(s.text.includes(ids.heat), 'the website is unchanged for everyone else')
  } finally {
    await f.close()
  }
})

test('owner PIN, profile switching, changing a profile with the PIN, bedtime and the daily limit', async () => {
  const f = await fixture()
  const { api, raw, ids } = f
  try {
    // Only an admin sets the PIN (and admin calls need the agent or TLS).
    let r = await api('kid', '/api/admin/parental/pin', { body: { pin: '1234' }, agent: true })
    assert.equal(r.status, 403)
    r = await api('owner', '/api/admin/parental/pin', { body: { pin: '12' }, agent: true })
    assert.equal(r.body.error, 'bad_pin')
    r = await api('owner', '/api/admin/parental/pin', { body: { pin: '4821' }, agent: true })
    assert.equal(r.body.pinSet, true)
    assert.ok(!JSON.stringify(f.data.parentalPin).includes('4821'), 'only a hash is stored')
    r = await api('owner', '/api/admin/parental/pin', { body: { pin: '1111' }, agent: true })
    assert.equal(r.status, 401, 'changing it needs the current PIN')

    // A parent changes the restricted profile right on the shared device, with the PIN.
    r = await api('kid', '/api/parental/profile', { body: { preset: 'teens' } })
    assert.equal(r.body.error, 'pin_required')
    r = await api('kid', '/api/parental/profile', { body: { preset: 'teens', pin: '4821' } })
    assert.equal(r.status, 200)
    assert.equal(f.data.parentalControls['u-kid'].preset, 'teens')
    r = await api('kid', '/api/parental/unlock', { body: { pin: '4821' } })
    r = await api('kid', '/api/parental/profile', { body: { preset: 'kids', unlock: r.body.unlock } })
    assert.equal(r.status, 200, 'an unlock from the PIN works for ten minutes')
    assert.equal(f.data.parentalControls['u-kid'].preset, 'kids')

    // The admin editor.
    r = await api('owner', '/api/admin/parental', { agent: true })
    assert.equal(r.body.users.find((u) => u.id === 'u-kid').policy.preset, 'kids')
    r = await api('owner', '/api/admin/parental/set', { body: { userId: 'u-owner', preset: 'kids' }, agent: true })
    assert.equal(r.status, 409, 'an admin profile cannot be restricted')

    // Switching away from the restricted profile needs the PIN.
    r = await api('kid', '/api/profiles')
    assert.deepEqual(r.body.profiles.map((p) => p.id), ['u-owner', 'u-kid', 'u-adult'])
    r = await api('kid', '/api/profiles/switch', { body: { userId: 'u-owner' } })
    assert.equal(r.status, 401)
    for (let i = 0; i < 4; i++) await api('kid', '/api/profiles/switch', { body: { userId: 'u-owner', pin: '0000' } })
    r = await api('kid', '/api/profiles/switch', { body: { userId: 'u-owner', pin: '4821' } })
    assert.equal(r.status, 200, 'four misses, then right')
    assert.equal(r.body.user.id, 'u-owner')
    r = await api(r.body.token, '/api/me')
    assert.equal(r.body.user.isAdmin, true)
    // An unrestricted, non-admin profile moving down to the restricted one needs nothing.
    r = await api('adult', '/api/profiles/switch', { body: { userId: 'u-kid' } })
    assert.equal(r.status, 200)
    r = await api('adult', '/api/profiles/switch', { body: { userId: 'u-owner' } })
    assert.equal(r.status, 401, 'moving up needs the PIN')
    // Lockout after five wrong PINs.
    for (let i = 0; i < 5; i++) await api('kid', '/api/parental/unlock', { body: { pin: '9999' } })
    r = await api('kid', '/api/parental/unlock', { body: { pin: '4821' } })
    assert.equal(r.status, 429)

    // The lock is per device address too, so hopping profiles doesn't buy more guesses.
    r = await api('adult', '/api/parental/unlock', { body: { pin: '4821' } })
    assert.equal(r.status, 429)
    r = await api('kid', '/api/parental/profile', { body: { preset: 'teens', pin: '4821' } })
    assert.equal(r.status, 429, 'still locked')
    f.data.parentalControls['u-kid'] = parental.presetPolicy('teens')
    r = await api('kid', '/api/movies')
    assert.deepEqual(r.body.items.map((i) => i.id).sort(), [ids.mystery, ids.paddington, ids.toy].sort(), 'teens: PG-13 and unrated')

    // Bedtime now.
    const now = new Date()
    const hhmm = (d) => String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
    f.data.parentalControls['u-kid'] = parental.presetPolicy('kids', {
      bedtime: { start: hhmm(new Date(now.getTime() - 60 * 60000)), end: hhmm(new Date(now.getTime() + 60 * 60000)) },
    })
    r = await api('kid', '/api/parental/status')
    assert.equal(r.body.restricted, true)
    assert.equal(r.body.canWatchNow, false)
    assert.equal(r.body.reason, 'bedtime')
    r = await api('kid', '/api/watch-session', { body: { kind: 'movie', id: ids.toy } })
    assert.equal(r.status, 403)
    assert.equal(r.body.error, 'bedtime')
    assert.match(r.body.message, /bedtime/)
    const kidCookie = 'beebo_session=' + f.auth.signSession(f.store, 'u-kid')
    let s = await raw('/file?id=' + ids.toy, { cookie: kidCookie, range: 'bytes=0-9' })
    assert.equal(s.status, 403, 'streams stop at bedtime too')
    s = await raw('/watch?id=' + ids.toy, { cookie: kidCookie })
    assert.equal(s.status, 403)
    assert.match(s.text, /bedtime/)

    // The daily limit.
    f.data.parentalControls['u-kid'] = parental.presetPolicy('kids', { dailyLimitMinutes: 2 })
    const today = parental.dayKey(new Date())
    f.data.parentalUsage = { 'u-kid': { day: today, minutes: [1, 2] } }
    r = await api('kid', '/api/watch-session', { body: { kind: 'movie', id: ids.toy } })
    assert.equal(r.body.error, 'daily_limit')
    f.data.parentalUsage = { 'u-kid': { day: today, minutes: [] } }
    s = await raw('/file?id=' + ids.toy, { cookie: kidCookie, range: 'bytes=0-9' })
    assert.equal(s.status, 206)
    assert.equal(f.data.parentalUsage['u-kid'].minutes.length, 1, 'streaming counts as watching time')
  } finally {
    await f.close()
  }
})

test('library shares: consent record, scope on every route, streams at once, downloads off, revoke, expiry', async () => {
  const f = await fixture()
  const { api, raw, ids } = f
  const libraryShares = localRequire('./electron/libraryShares')
  try {
    const shareBody = {
      guestEmail: 'Friend@Example.com', guestLabel: 'Jo', libraries: ['movies'], maxStreams: 1, downloads: false,
      consent: { accepted: true, termsVersion: libraryShares.SHARE_TERMS_VERSION },
    }
    let r = await api('owner', '/api/admin/shares/create', { body: { ...shareBody, consent: undefined }, agent: true })
    assert.equal(r.body.error, 'consent_required')
    r = await api('owner', '/api/admin/shares/create', { body: { ...shareBody, consent: { accepted: true, termsVersion: '2020-01-01' } }, agent: true })
    assert.equal(r.body.error, 'terms_changed')
    r = await api('adult', '/api/admin/shares/create', { body: shareBody, agent: true })
    assert.equal(r.status, 403, 'owner/admin only')
    const before = Date.now()
    r = await api('owner', '/api/admin/shares/create', { body: shareBody, agent: true })
    assert.equal(r.status, 200)
    const share = r.body.share
    assert.equal(share.guestEmail, 'friend@example.com')
    assert.equal(share.status, 'pending')
    assert.equal(share.consent.termsVersion, libraryShares.SHARE_TERMS_VERSION)
    assert.ok(share.consent.acceptedAt >= before, 'consent timestamp')
    assert.equal(share.consent.ownerUserId, 'u-owner')
    assert.match(share.consent.statement, /own or have the rights/)
    assert.equal(f.syncs(), 1, 'pushed to beebo.tv')
    r = await api('owner', '/api/admin/shares/create', { body: shareBody, agent: true })
    assert.equal(r.body.error, 'already_shared')

    // The guest arrives through the agent (beebo.tv checked they accepted).
    const rs = (headers) => api(null, '/api/remote-session', { method: 'POST', headers: { 'x-beebo-agent-key': SECRET, 'x-beebo-remote': '1', ...headers } })
    r = await rs({ 'x-beebo-remote-via': 'guest', 'x-beebo-remote-share': share.id, 'x-beebo-remote-guest': 'someone@else.com' })
    assert.equal(r.status, 403, 'the share is for one named person')
    r = await api(null, '/api/remote-session', { method: 'POST', headers: { 'x-beebo-remote-via': 'guest', 'x-beebo-remote-share': share.id, 'x-beebo-remote-guest': 'friend@example.com' } })
    assert.equal(r.status, 401, 'not from the agent')
    r = await rs({ 'x-beebo-remote-via': 'guest', 'x-beebo-remote-share': share.id, 'x-beebo-remote-guest': 'friend@example.com' })
    assert.equal(r.status, 200)
    assert.equal(r.body.user.guest, true)
    assert.equal(r.body.share.downloads, false)
    assert.equal(r.body.share.ownerLabel, "Sam's library")
    const guest = r.body.token
    assert.equal(libraryShares.get(f.store, share.id).status, 'active')

    // Scope: films only, no TV, no admin, no requests.
    r = await api(guest, '/api/movies')
    assert.equal(r.body.items.length, 5)
    r = await api(guest, '/api/tvshows')
    assert.ok(!JSON.stringify(r.body).includes(ids.bluey))
    r = await api(guest, '/api/tvshows/' + encodeURIComponent(ids.bluey) + '/episodes')
    assert.equal(r.status, 404)
    for (const u of ['/api/admin/summary', '/api/title-search?q=x', '/api/queue', '/api/profiles', '/api/space-saver/library', '/api/trailer?tmdbId=1']) {
      r = await api(guest, u)
      assert.equal(r.status, 403, u)
    }
    r = await api(guest, '/api/share/info')
    assert.equal(r.body.share.id, share.id)

    // Folder and parental scope on an existing share.
    r = await api('owner', '/api/admin/shares/update', { body: { id: share.id, parentalPreset: 'kids' }, agent: true })
    assert.equal(r.status, 200)
    r = await api(guest, '/api/movies')
    assert.deepEqual(r.body.items.map((i) => i.id).sort(), [ids.paddington, ids.toy].sort())
    r = await api(guest, '/api/watch-session', { body: { kind: 'movie', id: ids.heat } })
    assert.equal(r.status, 404)
    r = await api('owner', '/api/admin/shares/update', { body: { id: share.id, parental: null, folders: [path.join(f.moviesDir, 'nope')] }, agent: true })
    r = await api(guest, '/api/movies')
    assert.deepEqual(r.body.items, [], 'a folder outside the share')
    r = await api('owner', '/api/admin/shares/update', { body: { id: share.id, folders: [] }, agent: true })

    // Streams: bound to the share, one title at a time, downloads refused.
    r = await api(guest, '/api/movies')
    const toy = r.body.items.find((i) => i.id === ids.toy).stream
    const pad = r.body.items.find((i) => i.id === ids.paddington).stream
    assert.match(decodeURIComponent(/mt=([^&]+)/.exec(toy)[1]), /^\d+\.[^.]+\.[A-Za-z0-9_-]+$/)
    let s = await raw(toy, { range: 'bytes=0-9' })
    assert.equal(s.status, 206)
    s = await raw(pad, { range: 'bytes=0-9' })
    assert.equal(s.status, 429, 'max one stream at once')
    s = await raw(toy, { range: 'bytes=10-19', 'x-beebo-download': '1' })
    assert.equal(s.status, 403, 'downloads are off')
    s = await raw(toy.replace(ids.toy, ids.heat))
    assert.equal(s.status, 302, 'no guessing with a share token')

    // Revoke: immediate, for the API and the stream URL already handed out.
    f.data.watchlist = { ['share:' + share.id]: [{ id: ids.toy, kind: 'movie', title: 'Toy Story', at: 1 }] }
    r = await api('owner', '/api/admin/shares/revoke', { body: { id: share.id }, agent: true })
    assert.equal(r.body.share.status, 'revoked')
    assert.equal(f.data.watchlist['share:' + share.id], undefined, "the guest's rows on this computer go")
    r = await api(guest, '/api/movies')
    assert.equal(r.status, 401)
    assert.equal(r.body.error, 'share_ended')
    s = await raw(toy, { range: 'bytes=0-9' })
    assert.equal(s.status, 404)
    r = await rs({ 'x-beebo-remote-via': 'guest', 'x-beebo-remote-share': share.id, 'x-beebo-remote-guest': 'friend@example.com' })
    assert.equal(r.status, 403)

    // Expiry.
    r = await api('owner', '/api/admin/shares/create', { body: { ...shareBody, guestEmail: 'later@example.com', expiresAt: Date.now() + 1500 }, agent: true })
    assert.equal(r.status, 200)
    const short = r.body.share
    r = await rs({ 'x-beebo-remote-via': 'guest', 'x-beebo-remote-share': short.id, 'x-beebo-remote-guest': 'later@example.com' })
    const t2 = r.body.token
    assert.equal((await api(t2, '/api/movies')).status, 200)
    await new Promise((res) => setTimeout(res, 1700))
    assert.equal((await api(t2, '/api/movies')).status, 401, 'expired')
    r = await api('owner', '/api/admin/shares', { agent: true })
    assert.equal(r.body.shares.find((x) => x.id === short.id).status, 'expired')
    assert.equal(r.body.termsVersion, libraryShares.SHARE_TERMS_VERSION)
  } finally {
    await f.close()
  }
})

test('a share guest vouched by the agent: parsed only from the agent, only in the right shape', () => {
  const vi = localRequire('./electron/viewerIdentity')
  const req = (ip, headers) => ({ socket: { remoteAddress: ip }, headers })
  const key = { 'x-beebo-agent-key': SECRET }
  const g = { 'x-beebo-remote-via': 'guest', 'x-beebo-remote-share': 'sh_0123456789abcdef', 'x-beebo-remote-guest': 'Jo@Example.com' }
  assert.deepEqual(vi.remoteViewer(req('127.0.0.1', { ...key, ...g }), SECRET), { via: 'guest', share: 'sh_0123456789abcdef', guest: 'jo@example.com' })
  assert.equal(vi.remoteViewer(req('192.168.1.9', { ...key, ...g }), SECRET), null)
  assert.equal(vi.remoteViewer(req('127.0.0.1', g), SECRET), null)
  assert.equal(vi.remoteViewer(req('127.0.0.1', { ...key, ...g, 'x-beebo-remote-share': '../x' }), SECRET), null)
  assert.equal(vi.remoteViewer(req('127.0.0.1', { ...key, ...g, 'x-beebo-remote-guest': 'nope' }), SECRET), null)
  // The agent needs werift to load, so its token check is lifted out of the source and run alone.
  const src = require('node:fs').readFileSync(path.join(appRoot, 'resources', 'beebo-rtc-host', 'beebo-rtc-host.js'), 'utf8')
  const start = src.indexOf('function verifyViewerToken(')
  const end = src.indexOf('\n}', start) + 2
  const agent = new Function('require', 'registeredName', 'CFG', 'LICENSE_PUBLIC_KEY', src.slice(start, end) + '\nreturn { verifyViewerToken }')(require, '', {}, '')
  const crypto = require('node:crypto')
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const sign = (p) => {
    const bytes = Buffer.from(JSON.stringify(p))
    return bytes.toString('base64url') + '.' + crypto.sign(null, bytes, privateKey).toString('base64url')
  }
  const now = Math.floor(Date.now() / 1000)
  const opts = { publicKey: publicKey.export({ type: 'spki', format: 'pem' }), name: 'nick' }
  assert.deepEqual(agent.verifyViewerToken(sign({ typ: 'viewer', name: 'nick', via: 'guest', share: 'sh_0123456789abcdef', guest: 'jo@example.com', exp: now + 60 }), opts),
    { via: 'guest', share: 'sh_0123456789abcdef', guest: 'jo@example.com' })
  assert.equal(agent.verifyViewerToken(sign({ typ: 'viewer', name: 'nick', via: 'guest', share: 'bad', guest: 'jo@example.com', exp: now + 60 }), opts), null)
  assert.equal(agent.verifyViewerToken(sign({ typ: 'viewer', name: 'other', via: 'guest', share: 'sh_0123456789abcdef', guest: 'jo@example.com', exp: now + 60 }), opts), null)
})

test('share tokens and the stream limiter', () => {
  const libraryShares = localRequire('./electron/libraryShares')
  const share = { id: 'sh_0123456789abcdef', expiresAt: null }
  const tok = libraryShares.makeShareToken('secret', share)
  assert.equal(libraryShares.verifyShareToken('secret', tok), share.id)
  assert.equal(libraryShares.verifyShareToken('other', tok), null)
  assert.equal(libraryShares.verifyShareToken('secret', tok.replace('sh_0', 'sh_1')), null)
  const soon = libraryShares.makeShareToken('secret', { ...share, expiresAt: Date.now() + 1000 })
  assert.equal(libraryShares.verifyShareToken('secret', soon, Date.now() + 2000), null)
  let t = 0
  const lim = libraryShares.createStreamLimiter({ now: () => t, idleMs: 1000 })
  assert.equal(lim.admit('s', 'a', 1), true)
  assert.equal(lim.admit('s', 'a', 1), true, 'more requests for the same title')
  assert.equal(lim.admit('s', 'b', 1), false)
  t = 2000
  assert.equal(lim.admit('s', 'b', 1), true, 'after the first went idle')
  // What goes to beebo.tv: no titles, folders or parental settings.
  const view = libraryShares.workerView({ id: share.id, guestEmail: 'a@b.co', status: 'active', folders: ['C:\\x'], parental: { enabled: true }, consent: { termsVersion: 'v', acceptedAt: 5000 } })
  assert.deepEqual(Object.keys(view).sort(), ['consentAt', 'expiresAt', 'guestEmail', 'ownerLabel', 'shareId', 'status', 'termsVersion'])
})
