// The migration importer end to end on a fake store: read -> match -> review -> dry run -> import ->
// undo, for Letterboxd, Jellyfin, Emby, Kodi and Plex, plus the safety rules (merge never overwrites,
// only matched titles are applied, undo only reverts what is still the import's, a failed write rolls
// back, credentials never persist). Run: node --test test/migration-import.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const watchedState = require('../electron/watchedState')
const userRatings = require('../electron/userRatings')
const playlists = require('../electron/playlists')
const history = require('../electron/history')
const { ImportError } = require('../electron/migrationImport')
const fx = require('./helpers/migrationFixtures')

const { owner, sam, b64 } = fx
const KEY = 'abcdef0123456789ABCDEF'

const letterboxdInput = () => ({ source: 'letterboxd', files: [{ name: 'letterboxd-nick.zip', data: fx.letterboxdZip() }] })
async function ready(h, viewer, input) {
  const s = h.importer.start(viewer, input)
  const snap = await fx.waitReady(h.importer, viewer, s)
  assert.equal(snap.status, 'ready', JSON.stringify(snap.error))
  return { s, snap }
}
const movieKey = (name) => 'movie:' + name
const files = (store, uid) => watchedState.userFiles(store, uid)
const flagsOf = (store, uid) => (store.get('libraryFlags') || {})[uid] || {}
const listsOf = (store, uid) => playlists.load(store).lists.filter((p) => p.ownerId === uid)
const cleanup = (h) => fs.rmSync(h.journalDir, { recursive: true, force: true })

test('letterboxd: read, match and review numbers, with a sensible default person', async () => {
  const h = fx.makeImporter()
  try {
    const { snap } = await ready(h, owner, letterboxdInput())
    assert.equal(snap.source, 'letterboxd')
    assert.equal(snap.counts.total, 9)
    assert.equal(snap.counts.matched, 7)
    assert.equal(snap.counts.unmatched, 2)
    assert.equal(snap.counts.notInLibrary, 2, 'both are simply not in this library')
    assert.equal(snap.counts.review, 0, 'so nothing needs a decision')
    assert.deepEqual(snap.config.userMap, { letterboxd: 'u-owner' }, 'one person in the source means the person doing the import')
    assert.deepEqual(snap.users[0], { key: 'letterboxd', name: 'Letterboxd', items: 9, watched: 7, resume: 0, ratings: 4, favorites: 2, watchlist: 2, lists: 1 })
    assert.deepEqual(snap.beeboUsers.map((u) => u.id), ['u-owner', 'u-sam'])
    assert.equal(snap.config.options.metadata, false)
    assert.deepEqual(snap.lists, [{ userKey: 'letterboxd', name: 'Road Trip Night', count: 3 }])
    const notIn = h.importer.preview(h.importer.getSession(owner, snap.id), { filter: 'notInLibrary' })
    assert.deepEqual(notIn.items.map((i) => i.title).sort(), ['Blade Runner 2049', 'Some Obscure Film, The: A "Story"'])
    const matched = h.importer.preview(h.importer.getSession(owner, snap.id), { filter: 'matched', limit: 3, offset: 2 })
    assert.equal(matched.total, 7)
    assert.equal(matched.items.length, 3)
    assert.ok(matched.items.every((i) => i.status === 'matched' && i.target && i.target.key.startsWith('movie:')))
  } finally { cleanup(h) }
})

test('dry run: reports exactly what an import would do and writes nothing', async () => {
  const h = fx.makeImporter()
  try {
    watchedState.ensureMigrated(h.store) // the one-time state migration is not part of an import
    const { s } = await ready(h, owner, letterboxdInput())
    const before = JSON.stringify(h.store.data)
    const report = h.importer.run(s, { dryRun: true })
    assert.equal(report.dryRun, true)
    assert.deepEqual(report.counts, { watched: 6, resume: 0, ratings: 4, favorites: 2, watchlist: 1, lists: 1, listItems: 3, metadata: 0 })
    assert.equal(report.skipped.unmatched, 2)
    assert.deepEqual(report.samples.favorites.sort(), ['Amélie', 'The Matrix'])
    assert.equal(report.perUser['u-owner'].name, 'Nick')
    assert.equal(JSON.stringify(h.store.data), before, 'the store is byte-for-byte what it was')
    assert.deepEqual(h.importer.listJournals(), [], 'and no undo journal was made')
    assert.equal(fs.readdirSync(h.journalDir).length, 0)
  } finally { cleanup(h) }
})

test('import then undo: everything lands per person, and undo puts it all back', async () => {
  const h = fx.makeImporter()
  try {
    const { s } = await ready(h, owner, letterboxdInput())
    const report = h.importer.run(s, { dryRun: false })
    assert.equal(report.dryRun, false)
    assert.match(report.importId, /^imp_[a-z0-9]+$/)
    assert.equal(s.status, 'done')

    const w = files(h.store, 'u-owner')
    assert.equal(Object.values(w).filter((r) => r.watched).length, 6)
    assert.deepEqual(w[movieKey('The Matrix (1999).mkv')], { watched: true, at: Date.UTC(2022, 4, 14), clearedAt: Date.UTC(2022, 4, 14), source: 'import:letterboxd' }, 'watched on the day it was really watched')
    assert.equal(w[movieKey('Alien (1979).mkv')], undefined, 'on the watchlist only')
    assert.ok(watchedState.isWatched(h.store, 'u-owner', 'movie', 'Heat (1995).mkv'))
    assert.equal(Object.keys(files(h.store, 'u-sam')).length, 0, 'nobody else was touched')

    const r = userRatings.forUser(h.store, 'u-owner')
    assert.equal(r[movieKey('The Matrix (1999).mkv')].rating, 9)
    assert.equal(r[movieKey('Heat (1995).mkv')].rating, 10)
    assert.equal(r[movieKey('Amelie (2001).mkv')].rating, 1)
    assert.equal(r[movieKey('Amelie (2001).mkv')].source, 'import:letterboxd')

    const flags = flagsOf(h.store, 'u-owner')
    assert.deepEqual(Object.keys(flags).sort(), ['movie:' + b64('Amelie (2001).mkv'), 'movie:' + b64('The Matrix (1999).mkv')].sort())
    assert.equal(flags['movie:' + b64('The Matrix (1999).mkv')].favorite, true)

    const wl = h.store.get('watchlist')['u-owner']
    assert.deepEqual(wl.map((e) => [e.kind, e.id]), [['movie', b64('Alien (1979).mkv')]])
    assert.equal(wl[0].title, 'Alien')

    const lists = listsOf(h.store, 'u-owner')
    assert.equal(lists.length, 1)
    assert.equal(lists[0].name, 'Road Trip Night')
    assert.deepEqual(lists[0].items.map((i) => [i.type, i.id]), [['movie', b64('Heat (1995).mkv')], ['movie', b64('The Matrix (1999).mkv')], ['movie', b64('Alien (1979).mkv')]])
    assert.equal(lists[0].shared, false)

    // The journal is on disk, with every value it needs to go back.
    const journals = h.importer.listJournals()
    assert.equal(journals.length, 1)
    assert.equal(journals[0].status, 'applied')
    assert.equal(journals[0].id, report.importId)
    const raw = JSON.parse(fs.readFileSync(path.join(h.journalDir, report.importId + '.json'), 'utf8'))
    assert.equal(raw.snapshot, null)
    assert.equal(Object.keys(raw.changes.watched['u-owner']).length, 6)

    const result = h.importer.undo(report.importId)
    assert.equal(result.changedSince, 0)
    assert.ok(result.reverted >= 6 + 4 + 2 + 1 + 1)
    assert.equal(Object.values(files(h.store, 'u-owner')).filter((x) => x.watched).length, 0)
    assert.deepEqual(userRatings.forUser(h.store, 'u-owner'), {})
    assert.deepEqual(flagsOf(h.store, 'u-owner'), {})
    assert.deepEqual(h.store.get('watchlist')['u-owner'], [])
    assert.equal(listsOf(h.store, 'u-owner').length, 0)
    assert.equal(h.importer.listJournals()[0].status, 'undone')
    assert.throws(() => h.importer.undo(report.importId), (e) => e instanceof ImportError && e.code === 'already_undone')
  } finally { cleanup(h) }
})

test('merge, never overwrite: what a person already has here is left exactly as it is', async () => {
  const h = fx.makeImporter()
  try {
    watchedState.ensureMigrated(h.store)
    watchedState.setWatched(h.store, 'u-owner', [{ kind: 'movie', fileName: 'The Matrix (1999).mkv' }], true, { now: 5000, source: 'playback' })
    userRatings.setMany(h.store, 'u-owner', [{ key: movieKey('The Matrix (1999).mkv'), rating: 3, at: 1 }], { source: 'manual' })
    h.store.set('libraryFlags', { 'u-owner': { ['movie:' + b64('Amelie (2001).mkv')]: { favorite: true, at: 7 } } })
    h.store.set('watchlist', { 'u-owner': [{ id: b64('Alien (1979).mkv'), kind: 'movie', title: 'Alien', at: 9 }] })
    const { s } = await ready(h, owner, letterboxdInput())
    const report = h.importer.run(s, { dryRun: false })
    assert.equal(report.skipped.alreadyWatched, 1)
    assert.equal(report.skipped.ratingKept, 1)
    assert.equal(report.skipped.alreadyFavorite, 1)
    assert.equal(report.skipped.alreadyOnWatchlist, 1)
    assert.equal(report.counts.watched, 5)
    assert.equal(report.counts.ratings, 3)
    assert.equal(report.counts.favorites, 1)
    assert.equal(report.counts.watchlist, 0)
    const m = files(h.store, 'u-owner')[movieKey('The Matrix (1999).mkv')]
    assert.deepEqual([m.at, m.source], [5000, 'playback'])
    assert.equal(userRatings.get(h.store, 'u-owner', movieKey('The Matrix (1999).mkv')).rating, 3)
    assert.equal(flagsOf(h.store, 'u-owner')['movie:' + b64('Amelie (2001).mkv')].at, 7)
    assert.equal(h.store.get('watchlist')['u-owner'].length, 1)
    // Undo leaves all of that alone too.
    h.importer.undo(report.importId)
    assert.equal(files(h.store, 'u-owner')[movieKey('The Matrix (1999).mkv')].source, 'playback')
    assert.equal(userRatings.get(h.store, 'u-owner', movieKey('The Matrix (1999).mkv')).rating, 3)
  } finally { cleanup(h) }
})

test('ratings can be told to overwrite, and undo brings the old rating back', async () => {
  const h = fx.makeImporter()
  try {
    userRatings.setMany(h.store, 'u-owner', [{ key: movieKey('The Matrix (1999).mkv'), rating: 3, at: 1 }], { source: 'manual' })
    const { s } = await ready(h, owner, letterboxdInput())
    h.importer.configure(s, { options: { overwriteRatings: true } })
    const report = h.importer.run(s, { dryRun: false })
    assert.equal(userRatings.get(h.store, 'u-owner', movieKey('The Matrix (1999).mkv')).rating, 9)
    assert.equal(report.counts.ratings, 4)
    h.importer.undo(report.importId)
    const back = userRatings.get(h.store, 'u-owner', movieKey('The Matrix (1999).mkv'))
    assert.deepEqual([back.rating, back.source], [3, 'manual'])
  } finally { cleanup(h) }
})

test('undo only reverts what is still the import’s: later changes are left alone and counted', async () => {
  const h = fx.makeImporter()
  try {
    const { s } = await ready(h, owner, letterboxdInput())
    const report = h.importer.run(s, { dryRun: false })
    // The person unmarks Heat, changes a rating, un-favourites Amélie, renames the imported list.
    watchedState.setWatched(h.store, 'u-owner', [{ kind: 'movie', fileName: 'Heat (1995).mkv' }], false, { now: Date.now() + 1000 })
    userRatings.setMany(h.store, 'u-owner', [{ key: movieKey('Alien (1979).mkv'), rating: 6, at: 1 }], { source: 'manual' })
    userRatings.setMany(h.store, 'u-owner', [{ key: movieKey('The Matrix (1999).mkv'), rating: 5 }], { source: 'manual' })
    h.store.set('libraryFlags', { 'u-owner': { ...flagsOf(h.store, 'u-owner'), ['movie:' + b64('Amelie (2001).mkv')]: { favorite: false } } })
    playlists.update(h.store, { id: 'u-owner', isAdmin: false }, listsOf(h.store, 'u-owner')[0].id, { name: 'My renamed list' })
    const result = h.importer.undo(report.importId)
    assert.equal(result.changedSince, 4)
    assert.equal(watchedState.isWatched(h.store, 'u-owner', 'movie', 'Heat (1995).mkv'), false, 'the person’s choice stands')
    assert.equal(userRatings.get(h.store, 'u-owner', movieKey('The Matrix (1999).mkv')).rating, 5)
    assert.equal(listsOf(h.store, 'u-owner')[0].name, 'My renamed list')
    assert.equal(watchedState.isWatched(h.store, 'u-owner', 'movie', 'The Matrix (1999).mkv'), false, 'but what they did not touch is reverted')
    assert.equal(userRatings.get(h.store, 'u-owner', movieKey('Heat (1995).mkv')), null)
  } finally { cleanup(h) }
})

test('jellyfin: two people are mapped to two Beebo people; resume points become Continue Watching', async () => {
  const srv = await fx.startMockServer(fx.jellyfinHandler(KEY))
  const h = fx.makeImporter()
  try {
    const input = { source: 'jellyfin', baseUrl: srv.url, apiKey: KEY }
    const s = h.importer.start(owner, input)
    assert.equal(input.apiKey, '', 'the caller’s copy of the key is wiped')
    const snap = await fx.waitReady(h.importer, owner, s)
    assert.equal(snap.status, 'ready', JSON.stringify(snap.error))
    assert.deepEqual(snap.config.userMap, { '11111111-aaaa-bbbb-cccc-000000000001': 'u-owner', '11111111-aaaa-bbbb-cccc-000000000002': 'u-sam' }, 'people are matched by name')
    assert.ok(!JSON.stringify(snap).includes(KEY))
    assert.equal(snap.counts.unmatched, 1, 'the playlist-only film is not in this library')
    const report = h.importer.run(s, { dryRun: false })
    assert.deepEqual(report.perUser['u-sam'], { name: 'Sam', watched: 1, resume: 0, ratings: 0, favorites: 0, watchlist: 0 })

    // Nick
    const nick = files(h.store, 'u-owner')
    assert.equal(nick[movieKey('The Matrix (1999).mkv')].at, Date.UTC(2023, 3, 1, 20))
    assert.ok(nick['tv:Severance/Season 1/Severance S01E01.mkv'].watched)
    assert.equal(nick[movieKey('Heat (1995).mkv')], undefined, 'resume, not watched')
    assert.ok(flagsOf(h.store, 'u-owner')['movie:' + b64('The Matrix (1999).mkv')].favorite)
    assert.equal(userRatings.get(h.store, 'u-owner', movieKey('Alien (1979).mkv')).rating, 8)
    assert.equal(userRatings.get(h.store, 'u-owner', 'show:' + b64('chernobyl')).rating, 9.5, 'a show rating is kept against the show')
    // Resume points are normal watch-history rows.
    const resume = history.resumeFor(h.store, 'u-owner', 'Heat (1995).mkv')
    assert.deepEqual([resume.currentTime, resume.duration], [2713, 10200])
    const cont = history.continueWatching(h.store, 'u-owner')
    assert.deepEqual(cont.map((r) => r.fileName).sort(), ['Heat (1995).mkv', 'Severance/Season 1/Severance S01E02.mkv'])
    const epRow = cont.find((r) => r.kind === 'tv')
    assert.deepEqual([epRow.title, epRow.currentTime, epRow.duration], ['Severance — S1E2', 601, 3000])
    const raw = h.store.get('watchHistory').find((r) => r.fileName === 'Heat (1995).mkv')
    assert.deepEqual([raw.userId, raw.userName, raw.kind, raw.startedAt, raw.importedFrom], ['u-owner', 'Nick', 'movie', Date.UTC(2023, 0, 2, 20), 'jellyfin'])
    // Sam's playlist: the film that is not in this library is left out, order kept.
    const pl = listsOf(h.store, 'u-owner')[0]
    assert.equal(pl.name, 'Movie Night')
    assert.deepEqual(pl.items.map((i) => i.title), ['Heat', 'The Matrix'])
    // Sam
    assert.ok(watchedState.isWatched(h.store, 'u-sam', 'movie', 'Alien (1979).mkv'))
    assert.equal(watchedState.isWatched(h.store, 'u-sam', 'movie', 'The Matrix (1999).mkv'), false)
    assert.equal(userRatings.count(h.store, 'u-sam'), 0)
    // The key is nowhere: not in the store, the journal or the log.
    const everything = JSON.stringify(h.store.data) + fs.readFileSync(path.join(h.journalDir, report.importId + '.json'), 'utf8') + h.logs.join('\n')
    assert.ok(!everything.includes(KEY))

    // Undo removes the history rows too.
    h.importer.undo(report.importId)
    assert.deepEqual(h.store.get('watchHistory'), [])
    assert.equal(history.resumeFor(h.store, 'u-owner', 'Heat (1995).mkv'), null)
  } finally { await srv.close(); cleanup(h) }
})

test('a full history is never trimmed to make room: the import takes only what fits, newest first', async () => {
  const srv = await fx.startMockServer(fx.jellyfinHandler(KEY))
  const rows = Array.from({ length: 299 }, (_, i) => ({ sessionId: 's' + i, userId: 'u-sam', fileName: 'x' + i + '.mkv', title: 'x', kind: 'movie', startedAt: 1000 + i, lastUpdate: 1000 + i, currentTime: 100, duration: 1000 }))
  const h = fx.makeImporter({ store: fx.fakeStore({ watchHistory: rows }) })
  try {
    const s = h.importer.start(owner, { source: 'jellyfin', baseUrl: srv.url, apiKey: KEY, userIds: ['11111111-aaaa-bbbb-cccc-000000000001'] })
    await fx.waitReady(h.importer, owner, s)
    const report = h.importer.run(s, { dryRun: false })
    assert.equal(report.counts.resume, 1)
    assert.equal(report.skipped.historyFull, 1)
    const hist = h.store.get('watchHistory')
    assert.equal(hist.length, 300)
    assert.deepEqual(hist.slice(1).map((r) => r.sessionId), rows.map((r) => r.sessionId), 'every existing row survives, and stays after the imported one')
  } finally { await srv.close(); cleanup(h) }
})

test('emby: the same reader, labelled for Emby', async () => {
  const srv = await fx.startMockServer(fx.jellyfinHandler(KEY))
  const h = fx.makeImporter()
  try {
    const s = h.importer.start(owner, { source: 'emby', baseUrl: srv.url, apiKey: KEY, userIds: ['11111111-aaaa-bbbb-cccc-000000000001'] })
    const snap = await fx.waitReady(h.importer, owner, s)
    assert.match(snap.label, /^Emby server/)
    assert.equal(snap.users.length, 1)
    assert.deepEqual(snap.config.userMap, { '11111111-aaaa-bbbb-cccc-000000000001': 'u-owner' })
  } finally { await srv.close(); cleanup(h) }
})

test('plex server: the account state and Watchlist come across for the mapped person', async () => {
  const srv = await fx.startMockServer(fx.plexHandler('plex-Token_0123456789'))
  const data = fx.fixtureJson('plex', 'server.json')
  const h = fx.makeImporter({
    deps: {
      // plex.tv and the discovery host are public-only, so a test answers them itself.
      getJson: (base, p, opts) => {
        const origin = base instanceof URL ? base.origin : String(base)
        if (origin === 'https://plex.tv') return Promise.resolve(data.user)
        if (origin === 'https://discover.provider.plex.tv') return Promise.resolve(data.watchlist)
        return require('../electron/migration/safeFetch').getJson(base, p, opts)
      }
    }
  })
  try {
    const s = h.importer.start(owner, { source: 'plex', mode: 'server', baseUrl: srv.url, token: 'plex-Token_0123456789' })
    const snap = await fx.waitReady(h.importer, owner, s)
    assert.equal(snap.status, 'ready', JSON.stringify(snap.error))
    assert.deepEqual(snap.users.map((u) => u.name), ['nickplex'])
    const report = h.importer.run(s, { dryRun: false })
    assert.ok(watchedState.isWatched(h.store, 'u-owner', 'movie', 'The Matrix (1999).mkv'))
    assert.equal(userRatings.get(h.store, 'u-owner', movieKey('The Matrix (1999).mkv')).rating, 9)
    assert.equal(userRatings.get(h.store, 'u-owner', 'show:' + b64('severance')).rating, 10)
    assert.equal(history.resumeFor(h.store, 'u-owner', 'Heat (1995).mkv').currentTime, 2713)
    assert.equal(history.resumeFor(h.store, 'u-owner', 'Severance/Season 1/Severance S01E02.mkv').currentTime, 601)
    // The Watchlist: Blade Runner is not in this library; Chernobyl (a show) is, and goes on as a show.
    assert.deepEqual(h.store.get('watchlist')['u-owner'].map((e) => [e.kind, e.id, e.showKey]), [['show', b64('chernobyl'), b64('chernobyl')]])
    assert.equal(report.counts.watchlist, 1)
    assert.deepEqual(listsOf(h.store, 'u-owner').map((l) => [l.name, l.items.length]), [['Plex Marathon', 2]])
    assert.ok(!(JSON.stringify(h.store.data) + h.logs.join('')).includes('plex-Token_0123456789'))
  } finally { await srv.close(); cleanup(h) }
})

test('plex history file: matched by ids and titles, per person', async () => {
  const h = fx.makeImporter()
  try {
    const s = h.importer.start(owner, { source: 'plex', mode: 'csv', files: [{ name: 'history.csv', text: fx.fixtureText('plex', 'tautulli-history.csv') }] })
    const snap = await fx.waitReady(h.importer, owner, s)
    assert.deepEqual(snap.users.map((u) => u.key).sort(), ['nick', 'sam'])
    assert.deepEqual(snap.config.userMap, { nick: 'u-owner', sam: 'u-sam' }, 'people are matched by name, ignoring case')
    assert.equal(snap.counts.matched, 5, 'the Matrix (imdb id in the file, title in the library), Heat, Severance E1 and E2, Alien (tmdb id)')
    const report = h.importer.run(s, { dryRun: false })
    assert.equal(files(h.store, 'u-owner')[movieKey('The Matrix (1999).mkv')].at, Date.UTC(2023, 4, 8), 'the newest of two plays')
    assert.equal(history.resumeFor(h.store, 'u-owner', 'Heat (1995).mkv').currentTime, 2713)
    assert.ok(watchedState.isWatched(h.store, 'u-owner', 'tv', 'Severance/Season 1/Severance S01E01.mkv'))
    assert.equal(history.resumeFor(h.store, 'u-sam', 'Severance/Season 1/Severance S01E02.mkv').currentTime, 601, 'Sam’s own resume point')
    assert.equal(history.resumeFor(h.store, 'u-owner', 'Severance/Season 1/Severance S01E02.mkv'), null)
    assert.ok(watchedState.isWatched(h.store, 'u-sam', 'movie', 'Alien (1979).mkv'))
    assert.equal(report.perUser['u-sam'].watched, 1)
  } finally { cleanup(h) }
})

test('kodi: a folder grant, the library mode and uploaded files all read .nfo; details are kept and undone', async () => {
  const kodiDir = fx.fixturePath('kodi')
  for (const [mode, extra, deps] of [
    ['folder', { grantId: 'g_test' }, { resolveGrant: (id) => (id === 'g_test' ? kodiDir : null) }],
    ['library', {}, { libraryRoots: () => [kodiDir] }]
  ]) {
    const h = fx.makeImporter({ deps })
    try {
      const s = h.importer.start(owner, { source: 'kodi', mode, ...extra })
      const snap = await fx.waitReady(h.importer, owner, s)
      assert.equal(snap.status, 'ready', mode + ' ' + JSON.stringify(snap.error))
      assert.match(snap.warnings.join(' '), /refused for safety/, 'the two hostile files')
      assert.equal(snap.config.options.metadata, true, 'Kodi carries details worth keeping')
      const report = h.importer.run(s, { dryRun: false })
      assert.ok(watchedState.isWatched(h.store, 'u-owner', 'movie', 'The Matrix (1999).mkv'), mode)
      assert.equal(userRatings.get(h.store, 'u-owner', movieKey('The Matrix (1999).mkv')).rating, 9)
      assert.equal(history.resumeFor(h.store, 'u-owner', 'Heat (1995).mkv').currentTime, 2713)
      assert.ok(watchedState.isWatched(h.store, 'u-owner', 'tv', 'Severance/Season 1/Severance S01E01.mkv'))
      assert.equal(userRatings.get(h.store, 'u-owner', 'tv:Severance/Season 1/Severance S01E01.mkv').rating, 8)
      assert.equal(history.resumeFor(h.store, 'u-owner', 'Severance/Season 1/Severance S01E02.mkv').currentTime, 601)
      assert.ok(watchedState.isWatched(h.store, 'u-owner', 'movie', 'Alien (1979).mkv'), 'from the videodb.xml export')
      assert.ok(watchedState.isWatched(h.store, 'u-owner', 'tv', 'Chernobyl/Season 1/Chernobyl S01E01.mkv'), 'an episode of a show matched by name and year')
      const meta = h.store.get('importedMetadata')
      const m = meta[movieKey('The Matrix (1999).mkv')]
      assert.equal(m.source, 'import:kodi')
      assert.match(m.plot, /computer hacker/)
      assert.deepEqual(m.ids, { imdb: 'tt0133093', tmdb: '603' })
      assert.equal(m.actors[0].name, 'Keanu Reeves')
      assert.equal(m.artwork.poster, 'https://image.tmdb.org/t/p/original/poster.jpg')
      assert.ok(report.counts.metadata >= 3)
      h.importer.undo(report.importId)
      assert.deepEqual(h.store.get('importedMetadata'), {})
      assert.equal(history.continueWatching(h.store, 'u-owner').length, 0)
    } finally { cleanup(h) }
  }
  const h = fx.makeImporter()
  try {
    const nfo = (name) => ({ name, text: fs.readFileSync(fx.fixturePath('kodi', 'movies', name.split('|')[0], 'movie.nfo'), 'utf8') })
    const s = h.importer.start(owner, { source: 'kodi', mode: 'files', files: [nfo('The Matrix (1999)'), nfo('Heat (1995)')] })
    const snap = await fx.waitReady(h.importer, owner, s)
    assert.equal(snap.counts.matched, 2)
  } finally { cleanup(h) }
})

test('review: ambiguous titles wait for a choice; a choice applies, "skip" and no choice do not', async () => {
  const h = fx.makeImporter()
  try {
    const csv = 'Date,Name,Year\n2020-01-01,Dune,\n2020-01-02,Alien,1979\n2020-01-03,Blade Runner,1982\n'
    const s = h.importer.start(owner, { source: 'letterboxd', files: [{ name: 'watched.csv', text: csv }] })
    const snap = await fx.waitReady(h.importer, owner, s)
    assert.deepEqual([snap.counts.matched, snap.counts.ambiguous, snap.counts.unmatched, snap.counts.review], [1, 1, 1, 1])
    const view = h.importer.preview(s, { filter: 'review' })
    assert.equal(view.total, 1)
    const dune = view.items[0]
    assert.equal(dune.title, 'Dune')
    assert.equal(dune.status, 'ambiguous')
    assert.deepEqual(dune.candidates.map((c) => c.year).sort(), [1984, 2021])
    assert.deepEqual(dune.states.letterboxd, ['watched'])

    // Without a choice, only the matched one is written.
    let report = h.importer.run(s, { dryRun: true })
    assert.equal(report.counts.watched, 1)
    assert.equal(report.skipped.ambiguous, 1)
    assert.equal(report.skipped.unmatched, 1)

    // A bad choice is refused: a film for a film only, and only titles the library has.
    assert.throws(() => h.importer.configure(s, { decisions: { [dune.ref]: { targetKey: 'tv:Severance/Season 1/Severance S01E01.mkv' } } }), (e) => e.code === 'bad_choice')
    assert.throws(() => h.importer.configure(s, { decisions: { [dune.ref]: { targetKey: 'movie:Nope.mkv' } } }), (e) => e.code === 'bad_choice')
    assert.throws(() => h.importer.configure(s, { decisions: { [dune.ref]: 'yes please' } }), (e) => e.code === 'bad_choice')

    h.importer.configure(s, { decisions: { [dune.ref]: { targetKey: 'movie:Dune (1984).mkv' } } })
    assert.equal(h.importer.preview(s, { filter: 'decided' }).items[0].decision.target.year, 1984)
    report = h.importer.run(s, { dryRun: true })
    assert.equal(report.counts.watched, 2)
    assert.equal(report.skipped.ambiguous, 0)

    h.importer.configure(s, { decisions: { [dune.ref]: 'skip' } })
    assert.equal(h.importer.run(s, { dryRun: true }).counts.watched, 1)
    h.importer.configure(s, { decisions: { [dune.ref]: null } })
    assert.equal(h.importer.run(s, { dryRun: true }).counts.watched, 1, 'a cleared choice goes back to waiting')

    // Pick a title for the unmatched one by searching the library.
    const bladeRef = h.importer.preview(s, { filter: 'notInLibrary' }).items[0].ref
    const found = h.importer.search(s, { q: 'dune' })
    assert.ok(found.results.some((r) => r.key === 'movie:Dune (2021).mkv'))
    h.importer.configure(s, { decisions: { [bladeRef]: { targetKey: 'movie:Dune (2021).mkv' } } })
    report = h.importer.run(s, { dryRun: false })
    assert.ok(watchedState.isWatched(h.store, 'u-owner', 'movie', 'Dune (2021).mkv'))
    assert.equal(watchedState.isWatched(h.store, 'u-owner', 'movie', 'Dune (1984).mkv'), false)
  } finally { cleanup(h) }
})

test('an episode the review picks: search a show, list its episodes, choose one', async () => {
  const h = fx.makeImporter()
  try {
    const csv = 'title,show,season,episode,watched\nPilot,Sevrance,1,2,yes\n'
    const s = h.importer.start(owner, { source: 'plex', mode: 'csv', files: [{ name: 'h.csv', text: csv }] })
    await fx.waitReady(h.importer, owner, s)
    const item = h.importer.preview(s, { filter: 'all' }).items[0]
    assert.equal(item.type, 'episode')
    assert.equal(item.status, 'unmatched', 'a misspelt show')
    const shows = h.importer.search(s, { q: 'severance', type: 'show' }).results
    assert.equal(shows[0].type, 'show')
    const eps = h.importer.search(s, { showKey: shows[0].showKey }).results
    assert.equal(eps.length, 3)
    assert.throws(() => h.importer.configure(s, { decisions: { [item.ref]: { targetKey: shows[0].key } } }), (e) => e.code === 'bad_choice', 'a show is not an episode')
    h.importer.configure(s, { decisions: { [item.ref]: { targetKey: eps[1].key } }, userMap: { plex: 'u-owner' } })
    h.importer.run(s, { dryRun: false })
    assert.ok(watchedState.isWatched(h.store, 'u-owner', 'tv', 'Severance/Season 1/Severance S01E02.mkv'))
  } finally { cleanup(h) }
})

test('people: unmapped people are skipped, a bad target is refused, and the choice can be changed', async () => {
  const srv = await fx.startMockServer(fx.jellyfinHandler(KEY))
  const h = fx.makeImporter()
  try {
    const s = h.importer.start(owner, { source: 'jellyfin', baseUrl: srv.url, apiKey: KEY })
    const snap = await fx.waitReady(h.importer, owner, s)
    const [nickKey, samKey] = snap.users.map((u) => u.key)
    assert.throws(() => h.importer.configure(s, { userMap: { [nickKey]: 'u-nobody' } }), (e) => e.code === 'unknown_user')
    h.importer.configure(s, { userMap: { [nickKey]: null, [samKey]: 'u-owner' } })
    const report = h.importer.run(s, { dryRun: true })
    assert.deepEqual(Object.keys(report.perUser), ['u-owner'], 'Nick was left out; Sam’s data goes to the owner')
    assert.ok(report.skipped.unmappedPerson > 0)
    assert.equal(report.perUser['u-owner'].watched, 1)
    // Options turn categories off.
    h.importer.configure(s, { userMap: { [nickKey]: 'u-owner', [samKey]: 'u-sam' }, options: { watched: false, resume: false, ratings: false, lists: false } })
    const r2 = h.importer.run(s, { dryRun: true })
    assert.deepEqual([r2.counts.watched, r2.counts.resume, r2.counts.ratings, r2.counts.lists], [0, 0, 0, 0])
    assert.equal(r2.counts.favorites, 1)
    // Two source people to one Beebo person is allowed (their marks merge).
    h.importer.configure(s, { userMap: { [nickKey]: 'u-owner', [samKey]: 'u-owner' } })
    assert.deepEqual(Object.keys(h.importer.run(s, { dryRun: true }).perUser), ['u-owner'])
  } finally { await srv.close(); cleanup(h) }
})

test('credentials: a wrong key fails with a code, and neither the session, the store, the journal nor the log ever held it', async () => {
  const srv = await fx.startMockServer(fx.jellyfinHandler(KEY))
  const h = fx.makeImporter()
  try {
    const bad = 'wrongWRONG0123456789'
    const s = h.importer.start(owner, { source: 'jellyfin', baseUrl: srv.url, apiKey: bad })
    const snap = await fx.waitReady(h.importer, owner, s)
    assert.equal(snap.status, 'error')
    assert.equal(snap.error.code, 'http_401')
    assert.match(snap.error.message, /refused the key/)
    assert.ok(!JSON.stringify(snap).includes(bad))
    assert.ok(!h.logs.join('\n').includes(bad))
    assert.ok(!JSON.stringify(s, (k, v) => (v instanceof Map ? [...v] : v)).includes(bad), 'not even on the session object')
    for (const [src, extra] of [['jellyfin', { apiKey: 'no' }], ['plex', { token: 'no' }]]) {
      const s2 = h.importer.start(owner, { source: src, baseUrl: srv.url, ...extra })
      const sn = await fx.waitReady(h.importer, owner, s2)
      assert.equal(sn.error.code, 'bad_key')
    }
    const s3 = h.importer.start(owner, { source: 'jellyfin', baseUrl: 'http://169.254.169.254', apiKey: KEY })
    assert.equal((await fx.waitReady(h.importer, owner, s3)).error.code, 'blocked_address')
    // The probe wipes its input too.
    const input = { source: 'jellyfin', baseUrl: srv.url, apiKey: KEY }
    const probed = await h.importer.probe(input)
    assert.equal(input.apiKey, '')
    assert.equal(probed.serverName, 'Den Jellyfin')
    assert.ok(!JSON.stringify(probed).includes(KEY))
    await assert.rejects(() => h.importer.probe({ source: 'jellyfin', baseUrl: srv.url, apiKey: bad }), (e) => e.code === 'http_401' && !e.message.includes(bad))
    await assert.rejects(() => h.importer.probe({ source: 'kodi' }), (e) => e.code === 'unknown_source')
  } finally { await srv.close(); cleanup(h) }
})

test('sessions belong to the person who started them, expire, and are limited in number', async () => {
  let clock = 1_000_000
  const h = fx.makeImporter({ deps: { now: () => clock } })
  try {
    const first = await ready(h, owner, letterboxdInput())
    assert.throws(() => h.importer.getSession(sam, first.s.id), (e) => e.code === 'session_not_found')
    assert.throws(() => h.importer.getSession(owner, 'ms_doesnotexist12345'), (e) => e.code === 'session_not_found')
    assert.throws(() => h.importer.getSession(owner, '../../etc'), (e) => e.code === 'session_not_found')
    for (let i = 0; i < 4; i++) h.importer.start(owner, letterboxdInput())
    assert.throws(() => h.importer.getSession(owner, first.s.id), (e) => e.code === 'session_not_found', 'only four at once; the oldest is dropped')
    const s = [...[1]].map(() => h.importer.start(owner, letterboxdInput()))[0]
    await fx.waitReady(h.importer, owner, s)
    clock += 3 * 60 * 60 * 1000
    assert.throws(() => h.importer.getSession(owner, s.id), (e) => e.code === 'session_not_found', 'gone after two idle hours')
    const again = h.importer.start(owner, letterboxdInput())
    h.importer.discard(owner, again.id)
    assert.throws(() => h.importer.getSession(owner, again.id), (e) => e.code === 'session_not_found')
    assert.throws(() => h.importer.start(owner, { source: 'myspace' }), (e) => e.code === 'unknown_source')
    assert.throws(() => h.importer.start(owner, { source: 'plex', mode: 'telepathy' }), (e) => e.code === 'unknown_mode')
    const empty = h.importer.start(owner, { source: 'letterboxd', files: [] })
    assert.equal((await fx.waitReady(h.importer, owner, empty)).error.code, 'no_input')
  } finally { cleanup(h) }
})

test('a write that fails part-way is rolled back, and the journal says so', async () => {
  const store = fx.fakeStore()
  let failPlaylists = false
  const realSet = store.set
  store.set = (k, v) => { if (failPlaylists && k === 'playlists') throw new Error('disk full'); return realSet(k, v) }
  const h = fx.makeImporter({ store })
  try {
    const { s } = await ready(h, owner, letterboxdInput())
    failPlaylists = true
    assert.throws(() => h.importer.run(s, { dryRun: false }), (e) => e instanceof ImportError && e.code === 'import_failed')
    failPlaylists = false
    assert.equal(Object.values(files(store, 'u-owner')).filter((r) => r.watched).length, 0, 'watched marks written before the failure were taken back')
    assert.deepEqual(userRatings.forUser(store, 'u-owner'), {})
    assert.deepEqual(flagsOf(store, 'u-owner'), {})
    assert.deepEqual(store.get('watchlist')['u-owner'], [])
    const j = h.importer.listJournals()
    assert.equal(j.length, 1)
    assert.equal(j[0].status, 'failed')
    assert.throws(() => h.importer.undo(j[0].id), (e) => e.code === 'cannot_undo')
  } finally { cleanup(h) }
})

test('if the library changed after the review, a title that is gone is not written to', async () => {
  const h = fx.makeImporter()
  try {
    const { s } = await ready(h, owner, letterboxdInput())
    const i = h.catalog.findIndex((c) => c.fileName === 'The Matrix (1999).mkv')
    h.catalog.splice(i, 1)
    const report = h.importer.run(s, { dryRun: false })
    assert.equal(report.skipped.noLongerInLibrary, 1)
    assert.equal(watchedState.isWatched(h.store, 'u-owner', 'movie', 'The Matrix (1999).mkv'), false)
    assert.ok(watchedState.isWatched(h.store, 'u-owner', 'movie', 'Heat (1995).mkv'))
  } finally { cleanup(h) }
})

test('nothing to import is said plainly and leaves no journal', async () => {
  const h = fx.makeImporter({ catalog: [] })
  try {
    const { s } = await ready(h, owner, letterboxdInput())
    const report = h.importer.run(s, { dryRun: false })
    assert.equal(report.nothing, true)
    assert.equal(h.importer.listJournals().length, 0)
  } finally { cleanup(h) }
})

test('journals: only well-formed ids are read (no path tricks), an interrupted one cannot be undone, old ones are pruned', async () => {
  const h = fx.makeImporter()
  try {
    for (const id of ['../../etc/passwd', '..\\x', 'imp_', 'IMP_ABCDEF', 'imp_abc/def', '', null, {}]) {
      assert.throws(() => h.importer.undo(id), (e) => e.code === 'import_not_found', JSON.stringify(id))
    }
    fs.writeFileSync(path.join(h.journalDir, 'imp_interrupted1.json'), JSON.stringify({ schema: 1, id: 'imp_interrupted1', source: 'plex', createdAt: 5, status: 'pending', counts: {}, snapshot: {}, changes: null }))
    assert.equal(h.importer.listJournals()[0].status, 'interrupted')
    assert.throws(() => h.importer.undo('imp_interrupted1'), (e) => e.code === 'cannot_undo')
    fs.writeFileSync(path.join(h.journalDir, 'imp_wrongid1234.json'), JSON.stringify({ id: 'imp_other0000000', status: 'applied' }))
    fs.writeFileSync(path.join(h.journalDir, 'notes.txt'), 'hello')
    assert.equal(h.importer.listJournals().length, 1, 'a file that does not name itself, and stray files, are ignored')
    fs.rmSync(path.join(h.journalDir, 'imp_interrupted1.json'))
    const many = fx.makeImporter({ catalog: Array.from({ length: 25 }, (_, i) => fx.movie('F' + i + ' (2000).mkv', 'F' + i, 2000, i + 1)) })
    try {
      for (let n = 0; n < 23; n++) {
        const s = many.importer.start(owner, { source: 'letterboxd', files: [{ name: 'watched.csv', text: 'Date,Name,Year\n2020-01-01,F' + n + ',2000\n' }] })
        await fx.waitReady(many.importer, owner, s)
        many.importer.run(s, { dryRun: false })
        many.importer.discard(owner, s.id)
      }
      assert.equal(many.importer.listJournals().length, 20, 'the newest twenty are kept')
    } finally { cleanup(many) }
  } finally { cleanup(h) }
})

test('a title with an IMDb id but no TMDB id is looked up on TMDB once, and only when it did not match', async () => {
  const calls = []
  const api = { get: async (p, params) => { calls.push([p, params.external_source]); return { ok: true, data: { movie_results: [{ id: 949 }], tv_results: [] } } } }
  const h = fx.makeImporter({ deps: { tmdbApi: () => api } })
  try {
    const csv = 'title,year,imdb,watched\nLa Chaleur,1995,tt0113277,yes\nLa Chaleur bis,1995,tt0113277,yes\nThe Matrix,1999,tt0133093,yes\n'
    const s = h.importer.start(owner, { source: 'plex', mode: 'csv', files: [{ name: 'h.csv', text: csv }] })
    const snap = await fx.waitReady(h.importer, owner, s)
    assert.equal(snap.counts.matched, 3)
    assert.equal(calls.length, 1, 'one lookup for the same id, and none for the film that matched by name')
    assert.deepEqual(calls[0], ['/find/tt0113277', 'imdb_id'])
    const view = h.importer.preview(s, { filter: 'matched' })
    assert.equal(view.items.find((i) => i.title === 'La Chaleur').method, 'tmdb')
  } finally { cleanup(h) }
  const h2 = fx.makeImporter({ deps: { tmdbApi: () => ({ get: async () => ({ ok: false, status: 404 }) }) } })
  try {
    const s = h2.importer.start(owner, { source: 'plex', mode: 'csv', files: [{ name: 'h.csv', text: 'title,year,imdb,watched\nUnknown,1995,tt0000001,yes\n' }] })
    assert.equal((await fx.waitReady(h2.importer, owner, s)).counts.unmatched, 1, 'a failed lookup leaves it unmatched')
  } finally { cleanup(h2) }
})

test('sources list only the ways in this app can offer', () => {
  const plain = fx.makeImporter()
  try {
    const modes = (imp) => Object.fromEntries(imp.sources().map((s) => [s.id, s.modes.map((m) => m.id)]))
    assert.deepEqual(modes(plain.importer), { plex: ['server', 'csv'], jellyfin: ['server'], emby: ['server'], kodi: ['files'], letterboxd: ['files'] })
    const desktop = fx.makeImporter({ deps: { resolveGrant: () => null, libraryRoots: () => [] } })
    assert.deepEqual(modes(desktop.importer).kodi, ['folder', 'files', 'library'])
    cleanup(desktop)
  } finally { cleanup(plain) }
})
