// Watched state: one store, the migration from the two old records, the
// Continue Watching effect, the 95% rule, the scoped endpoints and the old
// /api/watched route that 1.18/1.19 still call.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))
const watchedState = localRequire('./electron/watchedState')
const history = localRequire('./electron/history')

const enc = (s) => Buffer.from(s, 'utf8').toString('base64url')
const memStore = (seed = {}) => {
  const data = JSON.parse(JSON.stringify(seed))
  return { data, get: (k) => data[k], set: (k, v) => { data[k] = JSON.parse(JSON.stringify(v)) }, delete: (k) => { delete data[k] } }
}
const row = (o) => ({ sessionId: Math.random().toString(36).slice(2), userName: 'x', title: o.fileName, ...o })

// --- fixtures of both old formats -------------------------------------------
const T0 = 1_700_000_000_000
const OLD_HISTORY = [
  // finished film, never flagged
  row({ userId: 'u1', fileName: 'Finished (2001).mp4', kind: 'movie', currentTime: 5800, duration: 6000, startedAt: T0, lastUpdate: T0 + 100 }),
  // part-watched film - its resume point must survive
  row({ userId: 'u1', fileName: 'Half (2002).mp4', kind: 'movie', currentTime: 1200, duration: 6000, startedAt: T0, lastUpdate: T0 + 200 }),
  // finished episode (old row, no kind field)
  row({ userId: 'u1', fileName: 'Show/Season 1/Show S01E01.mkv', title: 'Show — S1E1', currentTime: 2000, duration: 2050, startedAt: T0, lastUpdate: T0 + 300 }),
  // finished, then unticked later (flag below is newer)
  row({ userId: 'u1', fileName: 'Unticked (2003).mp4', kind: 'movie', currentTime: 5990, duration: 6000, startedAt: T0, lastUpdate: T0 + 400 }),
  // unticked BEFORE a later full watch - the watch wins
  row({ userId: 'u1', fileName: 'Rewatched (2004).mp4', kind: 'movie', currentTime: 5990, duration: 6000, startedAt: T0 + 5000, lastUpdate: T0 + 9000 }),
  // someone else's finished film
  row({ userId: 'u2', fileName: 'Finished (2001).mp4', kind: 'movie', currentTime: 10, duration: 6000, startedAt: T0, lastUpdate: T0 }),
  // part-watched episode of a show flagged watched as a whole
  row({ userId: 'u1', fileName: 'Other Show/Other Show S01E02.mp4', kind: 'tv', currentTime: 300, duration: 2000, startedAt: T0, lastUpdate: T0 + 50 }),
  null, 'garbage'
]
const OLD_FLAGS = {
  u1: {
    // flagged by the old chip; old /api/watched deleted its history row
    ['movie:' + enc('Flagged (2005).mp4')]: { watched: true, at: T0 + 10 },
    // "Mark as watched" on a Continue row for an episode (old ContinueScreen)
    ['tv:' + enc('Show/Season 1/Show S01E02.mkv')]: { watched: true, at: T0 + 20 },
    // whole show by show key (lowercase name)
    ['tv:' + enc('other show')]: { watched: true, at: T0 + 30 },
    // watched:false survives only beside a favourite
    ['movie:' + enc('Unticked (2003).mp4')]: { watched: false, favorite: true, at: T0 + 999 },
    ['movie:' + enc('Rewatched (2004).mp4')]: { watched: false, favorite: true, at: T0 + 1000 },
    ['movie:' + enc('Fav only (2006).mp4')]: { favorite: true, at: T0 }
  },
  u2: 'not an object'
}

test('thresholds: finished and part-watched are exact complements', () => {
  assert.equal(watchedState.FINISHED_FRACTION, history.RESUME_MAX_FRACTION)
})

test('migration merges both old records: watched if either says so, unless a later explicit unwatched', () => {
  const s = watchedState.buildMigratedState(OLD_HISTORY, OLD_FLAGS, T0 + 50_000)
  const f = s.users.u1.files
  assert.equal(f['movie:Finished (2001).mp4'].watched, true)
  assert.equal(f['movie:Finished (2001).mp4'].source, 'migrated-history')
  assert.equal(f['movie:Flagged (2005).mp4'].watched, true)
  assert.equal(f['tv:Show/Season 1/Show S01E01.mkv'].watched, true)
  assert.equal(f['tv:Show/Season 1/Show S01E02.mkv'].watched, true)
  assert.equal(f['movie:Unticked (2003).mp4'].watched, false, 'newer explicit unwatched wins')
  assert.equal(f['movie:Rewatched (2004).mp4'].watched, true, 'a later full watch beats an older untick')
  assert.equal(f['movie:Half (2002).mp4'], undefined, 'part-watched is not watched')
  assert.equal(f['movie:Fav only (2006).mp4'], undefined)
  assert.deepEqual(s.users.u1.legacyShows, { [enc('other show')]: { watched: true, at: T0 + 30 } })
  for (const rec of Object.values(f)) assert.equal(rec.clearedAt, 0, 'migration never hides a resume point')
  assert.equal(s.users.u2, undefined, 'u2 has nothing finished and a malformed flag map')
})

test('ensureMigrated backs up libraryFlags, strips only `watched`, never touches history, runs once', () => {
  const store = memStore({ watchHistory: OLD_HISTORY, libraryFlags: OLD_FLAGS })
  const historyBefore = JSON.stringify(store.data.watchHistory)
  const continueBefore = history.continueWatching(memStore({ watchHistory: OLD_HISTORY }), 'u1')

  watchedState.ensureMigrated(store, T0 + 60_000)

  assert.equal(JSON.stringify(store.data.watchHistory), historyBefore, 'history untouched')
  const backups = store.data[watchedState.BACKUP_KEY]
  assert.equal(backups.length, 1)
  assert.deepEqual(backups[0].libraryFlags, OLD_FLAGS)
  const u1 = store.data.libraryFlags.u1
  assert.deepEqual(Object.keys(u1).sort(), ['movie:' + enc('Fav only (2006).mp4'), 'movie:' + enc('Rewatched (2004).mp4'), 'movie:' + enc('Unticked (2003).mp4')].sort())
  for (const f of Object.values(u1)) assert.equal('watched' in f, false)
  assert.equal(store.data.watchedState.schema, 1)

  // Every resume position that existed before is still offered.
  assert.deepEqual(history.continueWatching(store, 'u1').map((r) => r.fileName), continueBefore.map((r) => r.fileName))
  assert.ok(history.resumeFor(store, 'u1', 'Half (2002).mp4'))

  // Second run: nothing new.
  watchedState.ensureMigrated(store, T0 + 70_000)
  assert.equal(store.data[watchedState.BACKUP_KEY].length, 1)

  // A restore that brings back an old config re-runs it and KEEPS the first backup.
  delete store.data.watchedState
  store.data.libraryFlags = OLD_FLAGS
  watchedState.ensureMigrated(store, T0 + 80_000)
  assert.equal(store.data[watchedState.BACKUP_KEY].length, 2)
})

test('integration: restoring a backup from before watched state rebuilds it from the restored records', () => {
  const backup = localRequire('./electron/backup')
  const store = memStore({ watchHistory: [], libraryFlags: {} })
  watchedState.ensureMigrated(store, T0)
  watchedState.setWatched(store, 'u1', [{ kind: 'movie', fileName: 'Not in the backup (2010).mp4' }], true, { now: T0 + 1 })
  assert.equal(watchedState.isWatched(store, 'u1', 'movie', 'Not in the backup (2010).mp4'), true)
  const opened = backup.openBackup(backup.parseBackupText(JSON.stringify({ version: 1, exportedAt: new Date(T0).toISOString(), store: { watchHistory: OLD_HISTORY, libraryFlags: OLD_FLAGS } })))
  backup.applyRestore(store, opened, { skipSafety: true })
  assert.equal(watchedState.isWatched(store, 'u1', 'movie', 'Not in the backup (2010).mp4'), false)
  assert.equal(watchedState.isWatched(store, 'u1', 'movie', 'Flagged (2005).mp4'), true)
})

test('legacy whole-show flag expands into its episodes once the library is known', () => {
  const store = memStore({ watchHistory: OLD_HISTORY, libraryFlags: OLD_FLAGS })
  const key = enc('other show')
  assert.equal(watchedState.resolveLegacyShow(store, 'u1', key, []), false, 'an empty scan keeps the flag')
  assert.equal(watchedState.resolveLegacyShow(store, 'u1', key, ['Other Show/Other Show S01E01.mp4', 'Other Show/Other Show S01E02.mp4']), true)
  assert.equal(watchedState.isWatched(store, 'u1', 'tv', 'Other Show/Other Show S01E01.mp4'), true)
  assert.equal(watchedState.resolveLegacyShow(store, 'u1', key, ['x']), false, 'idempotent')
  // Not cleared: the part-watched episode is still resumable after migration.
  assert.ok(history.resumeFor(store, 'u1', 'Other Show/Other Show S01E02.mp4'))
})

test('marking watched clears Continue Watching and the resume point; unmarking restores nothing; a rewatch comes back', () => {
  const store = memStore({ authUsers: [] })
  const sid = history.startSession(store, { userId: 'u1', userName: 'A', fileName: 'Film.mp4', title: 'Film', kind: 'movie' })
  history.updateSession(store, sid, { currentTime: 600, duration: 6000 })
  assert.equal(history.continueWatching(store, 'u1').length, 1)

  watchedState.setWatched(store, 'u1', [{ kind: 'movie', fileName: 'Film.mp4' }], true)
  assert.equal(history.continueWatching(store, 'u1').length, 0)
  assert.equal(history.resumeFor(store, 'u1', 'Film.mp4'), null)
  const h = history.viewedHistory(store, 'u1')
  assert.equal(h.length, 1, 'the history row is kept')
  assert.equal(h[0].watched, true)

  // A late progress report from the same (old) session does not resurrect it.
  history.updateSession(store, sid, { currentTime: 700, duration: 6000 })
  assert.equal(history.continueWatching(store, 'u1').length, 0)

  watchedState.setWatched(store, 'u1', [{ kind: 'movie', fileName: 'Film.mp4' }], false)
  assert.equal(watchedState.isWatched(store, 'u1', 'movie', 'Film.mp4'), false)
  assert.equal(history.continueWatching(store, 'u1').length, 0, 'unmarking restores nothing')

  // Start it again later: that new session is resumable.
  const realNow = Date.now
  try {
    Date.now = () => realNow() + 5000
    const sid2 = history.startSession(store, { userId: 'u1', userName: 'A', fileName: 'Film.mp4', title: 'Film', kind: 'movie' })
    history.updateSession(store, sid2, { currentTime: 900, duration: 6000 })
  } finally {
    Date.now = realNow
  }
  assert.equal(history.continueWatching(store, 'u1').length, 1)
  assert.equal(history.continueWatching(store, 'u2').length, 0, 'per user')
})

test('95% rule: crossing the line marks watched; sitting past it does not re-tick an untick', () => {
  const store = memStore()
  const sid = history.startSession(store, { userId: 'u1', userName: 'A', fileName: 'S/E1.mkv', title: 'S — S1E1', kind: 'tv' })
  history.updateSession(store, sid, { currentTime: 1000, duration: 2000 })
  assert.equal(watchedState.isWatched(store, 'u1', 'tv', 'S/E1.mkv'), false)
  history.updateSession(store, sid, { currentTime: 1880, duration: 2000 }) // 94%
  assert.equal(watchedState.isWatched(store, 'u1', 'tv', 'S/E1.mkv'), false)
  history.updateSession(store, sid, { currentTime: 1900, duration: 2000 }) // 95%
  assert.equal(watchedState.isWatched(store, 'u1', 'tv', 'S/E1.mkv'), true)
  assert.equal(watchedState.recordFor(store, 'u1', 'tv', 'S/E1.mkv').source, 'playback')

  watchedState.setWatched(store, 'u1', [{ kind: 'tv', fileName: 'S/E1.mkv' }], false)
  history.updateSession(store, sid, { currentTime: 1960, duration: 2000 })
  assert.equal(watchedState.isWatched(store, 'u1', 'tv', 'S/E1.mkv'), false)

  // A surfed session promoted already past the line counts too.
  const surf = history.startSession(store, { userId: 'u1', userName: 'A', fileName: 'Surf.mp4', title: 'Surf', kind: 'movie', provisional: true })
  let t = 5400
  history.updateSession(store, surf, { currentTime: t, duration: 6000 })
  for (let i = 0; i < 4; i++) { t += 100; history.updateSession(store, surf, { currentTime: t, duration: 6000 }) }
  assert.equal(history.getHistory(store).some((r) => r.fileName === 'Surf.mp4'), true, 'promoted')
  assert.equal(watchedState.isWatched(store, 'u1', 'movie', 'Surf.mp4'), true)
})

// --- the real server ---------------------------------------------------------

test('server: scoped endpoints, Continue Watching, episode ticks, old-route compatibility, migration on start', async () => {
  const server = localRequire('./electron/streamServer')
  const auth = localRequire('./electron/auth')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'beebo-watched-test-'))
  const movies = path.join(root, 'Movies')
  const tv = path.join(root, 'TV')
  let info
  try {
    await fs.mkdir(movies, { recursive: true })
    await fs.mkdir(path.join(tv, 'Test Show', 'Season 1'), { recursive: true })
    await fs.mkdir(path.join(tv, 'Test Show', 'Season 2'), { recursive: true })
    await fs.mkdir(path.join(tv, 'Old Show'), { recursive: true })
    for (const f of ['Alpha (2020).mp4', 'Beta (2021).mp4', 'Legacy (2019).mp4']) await fs.writeFile(path.join(movies, f), '0123456789')
    const epFiles = [
      ['Test Show', 'Season 1', 'Test Show S01E01.mp4'],
      ['Test Show', 'Season 1', 'Test Show S01E02.mp4'],
      ['Test Show', 'Season 2', 'Test Show S02E01.mp4'],
      ['Old Show', 'Old Show S01E01.mp4'],
      ['Old Show', 'Old Show S01E02.mp4']
    ]
    for (const parts of epFiles) await fs.writeFile(path.join(tv, ...parts), '0123456789')

    // Seeded in the OLD formats: the server must migrate them on start.
    const store = memStore({
      authUsers: [
        { id: 'u1', username: 'one', name: 'One', isAdmin: true, status: 'approved' },
        { id: 'u2', username: 'two', name: 'Two', isAdmin: false, status: 'approved' }
      ],
      libraryFlags: {
        u1: {
          ['movie:' + enc('Legacy (2019).mp4')]: { watched: true, favorite: true, at: T0 },
          ['tv:' + enc('old show')]: { watched: true, at: T0 }
        }
      }
    })
    const port = 47000 + Math.floor(Math.random() * 900) + 50
    info = server.startStreamServer({
      port, store, getMoviesDir: () => movies, getTvShowsDir: () => tv,
      getAllMoviesDirs: () => [movies], getAllTvShowsDirs: () => [tv],
      log: () => {}
    })
    const base = 'http://127.0.0.1:' + info.port
    for (let i = 0; i < 50; i++) {
      try { await (await fetch(base + '/login', { redirect: 'manual' })).arrayBuffer(); break } catch { await new Promise((r) => setTimeout(r, 100)) }
    }
    assert.equal(store.data.watchedState.schema, 1, 'migrated at startup')
    assert.equal(store.data.libraryFlags.u1['movie:' + enc('Legacy (2019).mp4')].favorite, true)
    assert.equal('watched' in store.data.libraryFlags.u1['movie:' + enc('Legacy (2019).mp4')], false)

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
      return { status: res.status, json, text }
    }

    const shows = (await call('GET', '/api/tvshows')).json.items
    const testShow = shows.find((s) => /test show/i.test(s.name))
    const oldShow = shows.find((s) => /old show/i.test(s.name))
    assert.ok(testShow && oldShow, 'both shows listed')
    const episodes = async (key, tok) => (await call('GET', '/api/tvshows/' + encodeURIComponent(key) + '/episodes', null, tok)).json.seasons.flatMap((s) => s.episodes)
    let eps = await episodes(testShow.key)
    const e11 = eps.find((e) => e.season === 1 && e.episode === 1)
    const e12 = eps.find((e) => e.season === 1 && e.episode === 2)
    const e21 = eps.find((e) => e.season === 2 && e.episode === 1)
    const alpha = server.encodeId('Alpha (2020).mp4')
    const beta = server.encodeId('Beta (2021).mp4')

    // Old formats read through the new store.
    assert.equal((await call('GET', '/api/library-status?kind=movie&id=' + enc('Legacy (2019).mp4'))).json.watched, true)
    assert.deepEqual((await call('GET', '/api/library-status?kind=movie&id=' + enc('Legacy (2019).mp4'))).json, { ok: true, watched: true, favorite: true })
    assert.equal((await call('GET', '/api/library-status?kind=tv&id=' + oldShow.key)).json.watched, true, 'legacy show flag')
    assert.ok((await episodes(oldShow.key)).every((e) => e.watched === true && e.watchedPercent === 100))

    // Part-watch an episode and a film.
    const play = async (kind, id, currentTime, duration) => {
      const s = (await call('POST', '/api/watch-session', { kind, id })).json
      assert.equal(s.ok, true)
      assert.equal((await call('POST', '/api/progress', { sessionId: s.sessionId, currentTime, duration })).json.ok, true)
      return s.sessionId
    }
    await play('tv', e11.id, 600, 2000)
    await play('tv', e21.id, 600, 2000)
    await play('movie', alpha, 900, 6000)
    const continueIds = async (tok) => (await call('GET', '/api/continue', null, tok)).json.items.map((i) => i.id)
    // One row per show: S02E01 was played after S01E01, so it stands for Test Show.
    assert.deepEqual((await continueIds()).sort(), [e21.id, alpha].sort())
    eps = await episodes(testShow.key)
    assert.equal(eps.find((e) => e.id === e11.id).watched, false)
    assert.equal(eps.find((e) => e.id === e11.id).watchedPercent, 30)

    // Validation.
    assert.equal((await call('POST', '/api/watched/episode', { id: e11.id })).status, 400, 'watched must be a boolean')
    assert.equal((await call('POST', '/api/watched/movie', { id: enc('Nope.mp4'), watched: true })).status, 404)
    assert.equal((await call('POST', '/api/watched/season', { showKey: testShow.key, watched: true })).status, 400, 'season required')
    assert.equal((await call('POST', '/api/watched/season', { showKey: testShow.key, season: 9, watched: true })).status, 404)
    assert.equal((await call('GET', '/api/watched/show')).status, 405)

    // Single episode.
    let r = await call('POST', '/api/watched/episode', { id: e11.id, watched: true })
    assert.deepEqual(r.json, { ok: true, watched: true, count: 1, changed: 1, ids: [e11.id] })
    assert.equal((await continueIds()).includes(e11.id), false, 'left Continue Watching')
    eps = await episodes(testShow.key)
    assert.equal(eps.find((e) => e.id === e11.id).watched, true)
    assert.equal(eps.find((e) => e.id === e11.id).watchedPercent, 100, 'old apps tick at >= 95')
    assert.ok(eps.find((e) => e.id === e11.id).watchedAt, '"Watched today" line kept')
    const hist = (await call('GET', '/api/history')).json.items
    assert.equal(hist.find((i) => i.id === e11.id).watched, true, 'history row kept, marked watched')

    // Unmark: nothing comes back.
    r = await call('POST', '/api/watched/episode', { id: e11.id, watched: false })
    assert.equal(r.json.watched, false)
    assert.equal((await continueIds()).includes(e11.id), false)
    eps = await episodes(testShow.key)
    assert.equal(eps.find((e) => e.id === e11.id).watched, false)
    assert.equal(eps.find((e) => e.id === e11.id).watchedAt, null, 'no stale watched line')

    // Season.
    r = await call('POST', '/api/watched/season', { showKey: testShow.key, season: 1, watched: true })
    assert.equal(r.json.count, 2)
    assert.deepEqual(r.json.ids.sort(), [e11.id, e12.id].sort())
    assert.equal((await call('GET', '/api/library-status?kind=tv&id=' + testShow.key)).json.watched, false, 'season 2 still unwatched')
    assert.equal((await continueIds()).includes(e21.id), true)

    // Whole show (the old bug: it must clear Continue Watching).
    r = await call('POST', '/api/watched/show', { showKey: testShow.key, watched: true })
    assert.equal(r.json.count, 3)
    assert.equal((await continueIds()).includes(e21.id), false)
    assert.equal((await call('GET', '/api/library-status?kind=tv&id=' + testShow.key)).json.watched, true)
    r = await call('POST', '/api/watched/show', { showKey: testShow.key, watched: false })
    assert.equal(r.json.changed, 3)
    assert.ok((await episodes(testShow.key)).every((e) => e.watched === false))

    // Film.
    r = await call('POST', '/api/watched/movie', { id: alpha, watched: true })
    assert.equal(r.json.ids[0], alpha)
    assert.equal((await continueIds()).includes(alpha), false)
    assert.equal((await call('GET', '/api/library-status?kind=movie&id=' + alpha)).json.watched, true)

    // Old route, as 1.18/1.19 call it.
    await play('movie', beta, 900, 6000)
    await play('tv', e12.id, 600, 2000)
    r = await call('POST', '/api/watched', { kind: 'movie', id: beta, watched: true })
    assert.deepEqual(r.json, { ok: true })
    assert.equal((await continueIds()).includes(beta), false)
    assert.ok((await call('GET', '/api/history')).json.items.some((i) => i.id === beta), 'old route no longer deletes history')
    r = await call('POST', '/api/watched', { kind: 'tv', id: testShow.key, watched: true })
    assert.deepEqual(r.json, { ok: true })
    assert.equal((await continueIds()).includes(e12.id), false, 'whole show via the old route clears Continue now')
    assert.ok((await episodes(testShow.key)).every((e) => e.watched === true))
    r = await call('POST', '/api/watched', { kind: 'tv', id: e12.id, watched: false })
    assert.equal((await call('GET', '/api/library-status?kind=tv&id=' + e12.id)).json.watched, false)
    assert.equal((await call('GET', '/api/library-status?kind=tv&id=' + testShow.key)).json.watched, false)
    assert.equal((await call('POST', '/api/watched', { kind: 'movie', watched: true })).status, 400)

    // Favourite keeps working beside it, in its own store.
    assert.equal((await call('POST', '/api/favorite', { kind: 'movie', id: beta, favorite: true })).json.ok, true)
    assert.deepEqual((await call('GET', '/api/library-status?kind=movie&id=' + beta)).json, { ok: true, watched: true, favorite: true })

    // 95% through the real /api/progress.
    const sid = await play('tv', e11.id, 100, 2000)
    await call('POST', '/api/watched/episode', { id: e11.id, watched: false })
    assert.equal((await call('POST', '/api/progress', { sessionId: sid, currentTime: 1950, duration: 2000 })).json.ok, true)
    assert.equal((await episodes(testShow.key)).find((e) => e.id === e11.id).watched, true)

    // Nobody else's state moved.
    assert.ok((await episodes(testShow.key, tok2)).every((e) => e.watched === false))
    assert.equal((await call('GET', '/api/library-status?kind=movie&id=' + alpha, null, tok2)).json.watched, false)
    assert.deepEqual(await continueIds(tok2), [])

    // The website's show page shows the same ticks.
    const cookie = 'beebo_session=' + auth.signSession(store, 'u1')
    const page = await (await fetch(base + '/tvshows?show=' + encodeURIComponent(testShow.key), { headers: { cookie }, redirect: 'manual' })).text()
    assert.equal((page.match(/class="ep-watched"/g) || []).length, 2, 'S01E01 (played to 97%) and S02E01 (show mark); S01E02 was unticked')
  } finally {
    if (info) await new Promise((r) => info.close(r))
    await fs.rm(root, { recursive: true, force: true })
  }
})
