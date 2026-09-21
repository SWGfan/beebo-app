// Continue Watching is one row per show (the latest part-watched episode, or
// the next one once that is finished), films are one row each, and My
// Library's separate clear actions only ever touch the caller's own data.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const { testPort } = require('./helpers/testPort')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))
const history = localRequire('./electron/history')
const watchedState = localRequire('./electron/watchedState')
const libraryClear = localRequire('./electron/libraryClear')

const memStore = (seed = {}) => {
  const data = JSON.parse(JSON.stringify(seed))
  return { data, get: (k) => data[k], set: (k, v) => { data[k] = JSON.parse(JSON.stringify(v)) }, delete: (k) => { delete data[k] } }
}
const T0 = 1_700_000_000_000
let n = 0
const session = (userId, fileName, title, kind, currentTime, duration, at) => ({
  sessionId: 's' + ++n, userId, userName: userId, fileName, title, kind, currentTime, duration, startedAt: at - 1000, lastUpdate: at
})

// The owner's screenshot: five House episodes part-watched, one logged as "house".
const native = (p) => p.split('/').join(path.sep)
const HOUSE = (ep) => `House/Season 2/House S02E${String(ep).padStart(2, '0')}.mkv`
const houseRows = (userId) => [
  session(userId, 'House/Season 2/house.s02e11.mkv', 'house — S2E11', 'tv', 600, 2600, T0 + 11),
  session(userId, HOUSE(12), 'House — S2E12 · Distractions', 'tv', 80, 2600, T0 + 12),
  session(userId, HOUSE(13), 'House — S2E13 · Skin Deep', 'tv', 80, 2600, T0 + 13),
  session(userId, HOUSE(14), 'House — S2E14 · Sex Kills', 'tv', 800, 2600, T0 + 14),
  session(userId, HOUSE(15), 'House — S2E15 · Clueless', 'tv', 1220, 2600, T0 + 15),
  session(userId, HOUSE(16), 'House — S2E16 · Safe', 'tv', 240, 2600, T0 + 16)
]
const EPISODES = [
  { fileName: 'House/Season 2/house.s02e11.mkv', title: 'House — S2E11' },
  ...[12, 13, 14, 15, 16, 17, 18].map((e) => ({ fileName: HOUSE(e), title: 'House — S2E' + e }))
]
// Fake library: the show is the folder name; episode order as above.
const opts = {
  showOf: (row) => ({ name: row.fileName.split('/')[0], tmdbId: null }),
  episodesOf: (row) => (row.fileName.startsWith('House/') ? EPISODES : [])
}

test('several part-watched episodes of one show are ONE row: the latest', () => {
  const store = memStore({ watchHistory: [...houseRows('u1'), session('u1', 'Film (2001).mp4', 'Film', 'movie', 900, 6000, T0 + 5)] })
  const rows = history.continueWatchingGrouped(store, 'u1', opts)
  assert.deepEqual(rows.map((r) => r.fileName), [HOUSE(16), 'Film (2001).mp4'])
  assert.equal(rows[0].percent, 9)
  // The per-file list the episode screen and resume prompts use is unchanged.
  assert.equal(history.continueWatching(store, 'u1').length, 7)
})

test('grouping ignores case, spacing and punctuation in the show name (no library help)', () => {
  const store = memStore({
    watchHistory: [
      session('u1', 'house.s02e11.mkv', 'house — S2E11', 'tv', 600, 2600, T0 + 20),
      session('u1', 'House S02E12.mkv', 'House — S2E12', 'tv', 600, 2600, T0 + 10),
      session('u1', 'Greys.Anatomy.S01E01.mkv', "Grey's Anatomy — S1E1", 'tv', 600, 2600, T0 + 5),
      session('u1', 'Greys Anatomy S01E02.mkv', '  GREYS  anatomy — S1E2', 'tv', 600, 2600, T0 + 6)
    ]
  })
  const rows = history.continueWatchingGrouped(store, 'u1')
  assert.deepEqual(rows.map((r) => r.fileName), ['house.s02e11.mkv', 'Greys Anatomy S01E02.mkv'])
  assert.equal(history.normaliseShowName(' House '), history.normaliseShowName('house'))
  assert.equal(history.normaliseShowName('Law & Order'), history.normaliseShowName('law and order'))
})

test('a TMDB id joins two differently spelled names of the same show', () => {
  const store = memStore({
    watchHistory: [
      session('u1', 'The Office US/S01E01.mkv', 'The Office US — S1E1', 'tv', 600, 2600, T0 + 1),
      session('u1', 'The Office (US)/S01E02.mkv', 'The Office (US) — S1E2', 'tv', 600, 2600, T0 + 2)
    ]
  })
  const rows = history.continueWatchingGrouped(store, 'u1', { showOf: () => ({ name: 'x', tmdbId: 2316 }) })
  assert.equal(rows.length, 1)
})

test('latest episode finished (95%) -> the next unwatched episode, and nothing once the show is done', () => {
  const store = memStore({ watchHistory: houseRows('u1') })
  const sid = store.data.watchHistory[5].sessionId
  history.updateSession(store, sid, { currentTime: 2500, duration: 2600 }) // S2E16 to 96%: marks it watched
  assert.equal(watchedState.isWatched(store, 'u1', 'tv', HOUSE(16)), true)
  let rows = history.continueWatchingGrouped(store, 'u1', opts)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].fileName, HOUSE(17))
  assert.equal(rows[0].upNext, true)
  assert.equal(rows[0].percent, 0)

  // Marked watched rather than played out: same result, and a watched next one is skipped.
  watchedState.setWatched(store, 'u1', [{ kind: 'tv', fileName: HOUSE(17) }], true)
  rows = history.continueWatchingGrouped(store, 'u1', opts)
  assert.equal(rows[0].fileName, HOUSE(18))

  watchedState.setWatched(store, 'u1', [{ kind: 'tv', fileName: HOUSE(18) }], true)
  assert.deepEqual(history.continueWatchingGrouped(store, 'u1', opts), [], 'last episode done: no row')
})

test('the next episode keeps its own resume point when it has one', () => {
  const store = memStore({
    watchHistory: [
      session('u1', HOUSE(17), 'House — S2E17', 'tv', 700, 2600, T0 + 1),
      session('u1', HOUSE(16), 'House — S2E16', 'tv', 2590, 2600, T0 + 2)
    ]
  })
  const rows = history.continueWatchingGrouped(store, 'u1', opts)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].fileName, HOUSE(17))
  assert.equal(rows[0].currentTime, 700)
})

test('films are unaffected: each part-watched film is its own row, finished films leave', () => {
  const store = memStore({
    watchHistory: [
      session('u1', 'A (2001).mp4', 'A', 'movie', 900, 6000, T0 + 1),
      session('u1', 'B (2002).mp4', 'B', 'movie', 900, 6000, T0 + 2),
      session('u1', 'C (2003).mp4', 'C', 'movie', 5990, 6000, T0 + 3),
      session('u2', 'D (2004).mp4', 'D', 'movie', 900, 6000, T0 + 4)
    ]
  })
  assert.deepEqual(history.continueWatchingGrouped(store, 'u1', opts).map((r) => r.fileName), ['B (2002).mp4', 'A (2001).mp4'])
})

test('clear actions: counts, each clears only its own kind, per user', () => {
  const store = memStore({
    watchHistory: [...houseRows('u1'), ...houseRows('u2')],
    libraryFlags: { u1: { 'movie:a': { favorite: true, at: 1 }, 'movie:b': { favorite: true, at: 2 } }, u2: { 'movie:a': { favorite: true, at: 1 } } },
    watchlist: { u1: [{ id: 'x', kind: 'movie' }], u2: [{ id: 'y', kind: 'movie' }] }
  })
  watchedState.setWatched(store, 'u1', [{ kind: 'movie', fileName: 'W1.mp4' }, { kind: 'movie', fileName: 'W2.mp4' }], true)
  watchedState.setWatched(store, 'u2', [{ kind: 'movie', fileName: 'W1.mp4' }], true)
  const u2Before = libraryClear.counts(store, 'u2')
  assert.deepEqual(libraryClear.counts(store, 'u1'), { history: 6, favourites: 2, watchlist: 1, watched: 2 })

  assert.equal(libraryClear.clear(store, 'u1', 'watched'), 2)
  assert.deepEqual(libraryClear.counts(store, 'u1'), { history: 6, favourites: 2, watchlist: 1, watched: 0 })
  assert.equal(history.continueWatching(store, 'u1').length, 6, 'history untouched by clearing marks')

  assert.equal(libraryClear.clear(store, 'u1', 'favourites'), 2)
  assert.equal(libraryClear.clear(store, 'u1', 'watchlist'), 1)
  assert.equal(libraryClear.clear(store, 'u1', 'history'), 6)
  assert.equal(libraryClear.clear(store, 'u1', 'nonsense'), 0)
  assert.deepEqual(libraryClear.counts(store, 'u1'), { history: 0, favourites: 0, watchlist: 0, watched: 0 })
  assert.deepEqual(libraryClear.counts(store, 'u2'), u2Before, "another user's data is untouched")
})

// --- the real server ---------------------------------------------------------

test('server: /api/continue groups (lowercase duplicate included), titles use the library name, clear endpoints are per user', async () => {
  const server = localRequire('./electron/streamServer')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'beebo-continue-test-'))
  const movies = path.join(root, 'Movies')
  const tv = path.join(root, 'TV')
  let info
  try {
    await fs.mkdir(movies, { recursive: true })
    await fs.mkdir(path.join(tv, 'House', 'Season 2'), { recursive: true })
    await fs.writeFile(path.join(movies, 'Alpha (2020).mp4'), '0123456789')
    await fs.writeFile(path.join(tv, 'House', 'Season 2', 'house.s02e11.mkv'), '0123456789')
    for (const e of [12, 13, 14, 15, 16, 17]) await fs.writeFile(path.join(tv, ...HOUSE(e).split('/')), '0123456789')

    const store = memStore({
      authUsers: [
        { id: 'u1', username: 'one', name: 'One', isAdmin: true, status: 'approved' },
        { id: 'u2', username: 'two', name: 'Two', isAdmin: false, status: 'approved' }
      ],
      // Library relPaths use the platform's separator.
      watchHistory: [...houseRows('u1'), ...houseRows('u2')].map((r) => ({ ...r, fileName: native(r.fileName) })).concat(session('u1', 'Alpha (2020).mp4', 'Alpha', 'movie', 900, 6000, T0 + 1)),
      libraryFlags: { u1: {}, u2: {} }
    })
    const port = testPort()
    info = server.startStreamServer({
      port, store, getMoviesDir: () => movies, getTvShowsDir: () => tv,
      getAllMoviesDirs: () => [movies], getAllTvShowsDirs: () => [tv],
      log: () => {}
    })
    const base = 'http://127.0.0.1:' + info.port
    for (let i = 0; i < 50; i++) {
      try { await (await fetch(base + '/login', { redirect: 'manual' })).arrayBuffer(); break } catch { await new Promise((r) => setTimeout(r, 100)) }
    }
    const tok1 = server.makeApiToken(store, 'u1')
    const tok2 = server.makeApiToken(store, 'u2')
    const call = async (method, p, body, tok = tok1) => {
      const res = await fetch(base + p, {
        method,
        headers: { Authorization: 'Bearer ' + tok, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined
      })
      const text = await res.text()
      let json = null
      try { json = JSON.parse(text) } catch {}
      return { status: res.status, json }
    }

    let items = (await call('GET', '/api/continue')).json.items
    assert.deepEqual(items.map((i) => i.title.split(' — ')[0]), ['House', 'Alpha'], 'one House row, then the film')
    assert.equal(items[0].id, server.encodeId(native(HOUSE(16))))
    assert.equal(items[0].upNext, undefined)

    // The history keeps every episode, and the old lowercase row now reads "House".
    const hist = (await call('GET', '/api/history')).json.items
    assert.equal(hist.length, 7)
    const e11 = hist.find((i) => i.id === server.encodeId(native('House/Season 2/house.s02e11.mkv')))
    assert.match(e11.title, /^House — S2E11/)

    // A new session for the lowercase-named file is logged under the folder's name.
    const ws = (await call('POST', '/api/watch-session', { kind: 'tv', id: server.encodeId(native('House/Season 2/house.s02e11.mkv')) })).json
    assert.equal(ws.ok, true)
    assert.match(store.data.watchHistory.find((r) => r.sessionId === ws.sessionId).title, /^House — S2E11/)
    store.data.watchHistory = store.data.watchHistory.filter((r) => r.sessionId !== ws.sessionId)

    // Finish S2E16 through /api/progress -> the row moves on to S2E17.
    const s16 = store.data.watchHistory.find((r) => r.userId === 'u1' && r.fileName === native(HOUSE(16))).sessionId
    await call('POST', '/api/progress', { sessionId: s16, currentTime: 2550, duration: 2600 })
    items = (await call('GET', '/api/continue')).json.items
    assert.equal(items[0].id, server.encodeId(native(HOUSE(17))))
    assert.equal(items[0].upNext, true)
    assert.equal(items[0].title, 'House — S2E17')
    assert.equal(items.filter((i) => i.kind === 'tv').length, 1)
    assert.equal((await call('GET', '/api/continue', null, tok2)).json.items[0].id, server.encodeId(native(HOUSE(16))), 'u2 unaffected')

    // The website's Continue page groups the same way and offers the separate clear buttons.
    const auth = localRequire('./electron/auth')
    const cookie = 'beebo_session=' + auth.signSession(store, 'u1')
    const pageHtml = await (await fetch(base + '/continue', { headers: { cookie }, redirect: 'manual' })).text()
    assert.equal((pageHtml.match(/class="card cw-row"/g) || []).length, 2)
    for (const label of ['Clear watch history', 'Clear favourites', 'Clear watchlist', 'Clear watched marks']) assert.ok(pageHtml.includes(label), label)
    assert.ok(!pageHtml.includes('Clear all history'))

    // Clear endpoints.
    await call('POST', '/api/favorite', { kind: 'movie', id: server.encodeId('Alpha (2020).mp4'), favorite: true })
    await call('POST', '/api/favorite', { kind: 'movie', id: server.encodeId('Alpha (2020).mp4'), favorite: true }, tok2)
    await call('POST', '/api/watchlist', { kind: 'movie', id: 'x', title: 'X' })
    await call('POST', '/api/watchlist', { kind: 'movie', id: 'x', title: 'X' }, tok2)
    await call('POST', '/api/watched/movie', { id: server.encodeId('Alpha (2020).mp4'), watched: true }, tok2)
    let r = await call('GET', '/api/library/clear')
    assert.deepEqual(r.json, { ok: true, counts: { history: 7, favourites: 1, watchlist: 1, watched: 1 } })
    const u2Before = (await call('GET', '/api/library/clear', null, tok2)).json.counts
    assert.equal((await call('POST', '/api/library/clear', { what: 'everything' })).status, 400)
    assert.equal((await call('PUT', '/api/library/clear')).status, 405)
    r = await call('POST', '/api/library/clear', { what: 'watched' })
    assert.equal(r.json.removed, 1)
    assert.equal(r.json.counts.history, 7, 'history stays')
    r = await call('POST', '/api/library/clear', { what: 'favourites' })
    assert.equal(r.json.removed, 1)
    r = await call('POST', '/api/library/clear', { what: 'watchlist' })
    assert.equal(r.json.removed, 1)
    r = await call('POST', '/api/library/clear', { what: 'history' })
    assert.equal(r.json.removed, 7)
    assert.deepEqual(r.json.counts, { history: 0, favourites: 0, watchlist: 0, watched: 0 })
    assert.deepEqual((await call('GET', '/api/continue')).json.items, [])
    assert.deepEqual((await call('GET', '/api/library/clear', null, tok2)).json.counts, u2Before, 'u2 untouched')
    // The old route still works.
    assert.equal((await call('POST', '/api/history/clear', { scope: 'all' }, tok2)).json.ok, true)
    assert.equal((await call('GET', '/api/library/clear', null, tok2)).json.counts.history, 0)
    // The website route wants JSON.
    assert.equal((await fetch(base + '/library/clear', { method: 'POST', headers: { cookie, 'Content-Type': 'text/plain' }, body: '{"what":"history"}', redirect: 'manual' })).status, 415)
  } finally {
    if (info) await new Promise((r) => info.close(r))
    await fs.rm(root, { recursive: true, force: true })
  }
})
