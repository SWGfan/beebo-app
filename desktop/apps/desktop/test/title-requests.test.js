// "Request a title": search TMDB through the server, file a missingRequests
// row, see its status, have it marked added when the title arrives, owner-only
// dismiss, and the per-person rate limits. TMDB is a fixture: fetch is
// intercepted for api.themoviedb.org, so nothing leaves this machine.
// Run: node --test test/title-requests.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))
const tr = localRequire('./electron/titleRequests')

test('normTitle ignores case, punctuation and a leading or trailing "The"', () => {
  assert.equal(tr.normTitle('The Office'), 'office')
  assert.equal(tr.normTitle('Office, The'), 'office')
  assert.equal(tr.normTitle('Amélie'), 'amelie')
  assert.equal(tr.normTitle('Fast & Furious'), 'fast and furious')
})

test('cleanNote trims, collapses and caps; blank is null', () => {
  assert.equal(tr.cleanNote('  hi   there '), 'hi there')
  assert.equal(tr.cleanNote('   '), null)
  assert.equal(tr.cleanNote(undefined), null)
  assert.equal(tr.cleanNote('x'.repeat(500)).length, tr.NOTE_MAX)
})

test('requestStatus', () => {
  assert.equal(tr.requestStatus({ resolved: false }), 'requested')
  assert.equal(tr.requestStatus({ resolved: true }), 'added')
  assert.equal(tr.requestStatus({ resolved: true, addedAt: 1 }), 'added')
  assert.equal(tr.requestStatus({ resolved: true, dismissedAt: 1 }), 'dismissed')
})

test('markArrived matches by TMDB id, by title and year, whole shows and episodes', () => {
  const idx = tr.buildLibraryIndex({
    movies: [{ tmdbId: 438631, title: 'Dune', year: 2021 }, { tmdbId: null, title: 'Heat', year: 1995 }],
    shows: [{ tmdbId: 2316, name: 'The Office', year: null }, { tmdbId: null, name: 'Severance' }],
    episodes: [{ show: 'Severance', season: 1, episode: 2 }]
  })
  const rows = [
    { id: 'a', kind: 'movie', tmdbId: 438631, title: 'Dune', resolved: false },
    { id: 'b', kind: 'movie', tmdbId: null, title: 'Dune', year: 1984, resolved: false },
    { id: 'c', kind: 'movie', tmdbId: null, title: 'heat', year: 1995, resolved: false },
    { id: 'd', kind: 'tv', showName: 'Office, The', season: null, episode: null, resolved: false },
    { id: 'e', kind: 'tv', showName: 'Severance', season: 1, episode: 2, resolved: false },
    { id: 'f', kind: 'tv', showName: 'Severance', season: 1, episode: 3, resolved: false },
    { id: 'g', kind: 'movie', tmdbId: 438631, title: 'Dune', resolved: true, dismissedAt: 5 }
  ]
  const { rows: out, changed } = tr.markArrived(rows, idx, 1234)
  assert.equal(changed, 4)
  const byId = Object.fromEntries(out.map((r) => [r.id, r]))
  assert.equal(byId.a.addedAt, 1234)
  assert.equal(byId.a.resolvedBy, 'library')
  assert.equal(byId.b.resolved, false, 'a different year is a different film')
  assert.equal(byId.c.resolved, true)
  assert.equal(byId.d.resolved, true)
  assert.equal(byId.e.resolved, true)
  assert.equal(byId.f.resolved, false)
  assert.equal(byId.g.addedAt, undefined, "the owner's no stands")
  assert.equal(rows[0].resolved, false, 'input untouched')
})

test('requestsForUser: members see their own, without anyone else\'s notes; the owner sees all', () => {
  const rows = [
    { id: '1', kind: 'movie', title: 'A', firstSeenAt: 1, requestedBy: [{ userId: 'm', userName: 'Mia', note: 'please', at: 1 }] },
    { id: '2', kind: 'movie', title: 'B', firstSeenAt: 2, requestedBy: [{ userId: 'o', userName: 'Owner', note: 'secret', at: 2 }, { userId: 'm', userName: 'Mia', at: 3 }] },
    { id: '3', kind: 'movie', title: 'C', firstSeenAt: 3, requestedBy: [{ userId: 'o', userName: 'Owner', at: 3 }] }
  ]
  const mine = tr.requestsForUser(rows, { id: 'm', isAdmin: false })
  assert.deepEqual(mine.map((r) => r.id), ['2', '1'])
  assert.equal(mine[1].note, 'please')
  assert.equal(mine[0].note, null)
  assert.deepEqual(mine[0].requesters, [])
  assert.equal(mine[0].requesterCount, 2)
  const all = tr.requestsForUser(rows, { id: 'o', isAdmin: true })
  assert.deepEqual(all.map((r) => r.id), ['3', '2', '1'])
  assert.equal(all[1].requesters[0].note, 'secret')
  assert.equal(all[2].mine, false)
})

test('resolveRow / dismissRow: the owner\'s two queue decisions, both idempotent', () => {
  const row = { id: 'a', kind: 'movie', title: 'Dune', resolved: false, requestedBy: [{ userId: 'm', userName: 'Mia' }] }
  const resolved = tr.resolveRow(row, 1000)
  assert.equal(resolved.resolved, true)
  assert.equal(resolved.addedAt, 1000)
  assert.equal(resolved.resolvedBy, 'owner')
  assert.equal(row.resolved, false, 'input untouched')
  assert.equal(tr.resolveRow(resolved, 2000), resolved, 'already resolved: unchanged, same object')

  const dismissed = tr.dismissRow(row, 1500)
  assert.equal(dismissed.resolved, true)
  assert.equal(dismissed.dismissedAt, 1500)
  assert.equal(dismissed.addedAt, undefined)
  assert.equal(tr.dismissRow(dismissed, 3000), dismissed, 'already dismissed: unchanged, same object')
  assert.equal(tr.dismissRow(resolved, 3000), resolved, 'already resolved (found): dismiss no longer applies')
})

test('requestersToNotify: only a real transition into added/dismissed, never a repeat', () => {
  const requestedBy = [{ userId: 'm', userName: 'Mia' }, { userId: 'o', userName: 'Owner' }]
  const before = { id: 'a', title: 'Dune', resolved: false, requestedBy }
  const added = { ...before, resolved: true, addedAt: 1 }
  const dismissed = { ...before, resolved: true, dismissedAt: 1 }

  assert.deepEqual(tr.requestersToNotify(before, added), requestedBy)
  assert.deepEqual(tr.requestersToNotify(before, dismissed), requestedBy)
  assert.deepEqual(tr.requestersToNotify(before, before), [], 'no change')
  assert.deepEqual(tr.requestersToNotify(added, added), [], 'same object: never resent')
  assert.deepEqual(tr.requestersToNotify(null, added), [])
  assert.deepEqual(tr.requestersToNotify(before, null), [])
  // In practice this never arises: resolveRow/dismissRow are themselves idempotent once a row is
  // settled (they return the very same object), and every caller here only notifies when its
  // own before/after actually differ - so a "settled twice" pair like this is never built. Tested
  // directly anyway, since this function takes whatever it is given.
  assert.deepEqual(tr.requestersToNotify(added, dismissed), requestedBy)
})

test('createRateLimiter is a sliding window per key', () => {
  let t = 0
  const lim = tr.createRateLimiter({ limit: 2, windowMs: 1000, now: () => t })
  assert.equal(lim.hit('a').ok, true)
  t = 400
  assert.equal(lim.hit('a').ok, true)
  const refused = lim.hit('a')
  assert.equal(refused.ok, false)
  assert.equal(refused.retryAfterSeconds, 1)
  assert.equal(lim.hit('b').ok, true, 'someone else is unaffected')
  t = 1001
  assert.equal(lim.hit('a').ok, true, 'the first hit has aged out')
})

const TMDB = {
  '/3/search/multi|dune': {
    results: [
      { media_type: 'movie', id: 438631, title: 'Dune', release_date: '2021-09-15', poster_path: '/dune.jpg', overview: 'Spice.' },
      { media_type: 'person', id: 1, name: 'Denis Villeneuve' },
      { media_type: 'tv', id: 90228, name: 'Dune: Prophecy', first_air_date: '2024-11-17', poster_path: null }
    ]
  },
  '/3/search/movie|heat': { results: [{ id: 949, title: 'Heat', release_date: '1995-12-15', poster_path: '/heat.jpg' }] },
  '/3/search/tv|office': { results: [{ id: 2316, name: 'The Office', first_air_date: '2005-03-24', poster_path: '/office.jpg' }] }
}

test('request a title, end to end', async () => {
  const server = localRequire('./electron/streamServer')
  const auth = localRequire('./electron/auth')
  const mailer = localRequire('./electron/mailer')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'beebo-req-test-'))
  const moviesDir = path.join(root, 'Movies')
  const tvDir = path.join(root, 'TV')
  const cacheDir = path.join(root, 'tmdb')
  const realFetch = globalThis.fetch
  const tmdbCalls = []
  globalThis.fetch = async (input, init) => {
    const u = String(input && input.url ? input.url : input)
    if (!u.startsWith('https://api.themoviedb.org/')) return realFetch(input, init)
    const parsed = new URL(u)
    tmdbCalls.push(parsed.pathname + '?' + parsed.searchParams.get('query'))
    const key = parsed.pathname + '|' + String(parsed.searchParams.get('query') || '').toLowerCase()
    const hit = TMDB[key] || (parsed.pathname.startsWith('/3/search/') ? { results: [] } : null)
    return hit ? new Response(JSON.stringify(hit), { status: 200 }) : new Response('{}', { status: 404 })
  }
  const sentEmails = []
  const realSendMail = mailer.sendMail
  mailer.sendMail = async (_store, msg) => { sentEmails.push(msg); return { ok: true } }
  let info
  try {
    await fs.mkdir(moviesDir, { recursive: true })
    await fs.mkdir(path.join(tvDir, 'Severance', 'Season 1'), { recursive: true })
    await fs.mkdir(cacheDir, { recursive: true })
    await fs.writeFile(path.join(moviesDir, 'Heat (1995).mp4'), 'x')
    await fs.writeFile(path.join(tvDir, 'Severance', 'Season 1', 'Severance S01E01.mkv'), 'x')
    const manifest = { 'Heat (1995).mp4': { id: 949, title: 'Heat', release_date: '1995-12-15', genre_ids: [] } }
    await fs.writeFile(path.join(cacheDir, 'manifest.json'), JSON.stringify(manifest))

    const data = { tmdbApiKey: 'fixture-key' }
    const store = { get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] }, onDidChange: () => () => {} }
    const owner = auth.createUser(store, 'Owner', 'owner@example.com').user
    auth.setUserAdmin(store, owner.id, true)
    const member = auth.createUser(store, 'Mia', 'mia@example.com').user
    const spammer = auth.createUser(store, 'Sam', 'sam@example.com').user
    const tok = { owner: server.makeApiToken(store, owner.id), member: server.makeApiToken(store, member.id), spammer: server.makeApiToken(store, spammer.id) }

    const port = 47000 + Math.floor(Math.random() * 900) + 50
    info = server.startStreamServer({
      port, store, getMoviesDir: () => moviesDir, getTvShowsDir: () => tvDir,
      getAllMoviesDirs: () => [moviesDir], getAllTvShowsDirs: () => [tvDir],
      getTmdbCacheDir: () => cacheDir, log: () => {}
    })
    const base = 'http://127.0.0.1:' + info.port
    for (let i = 0; i < 50; i++) {
      try { await (await realFetch(base + '/api/ping')).arrayBuffer(); break } catch { await new Promise((r) => setTimeout(r, 100)) }
    }
    const call = async (who, u, body) => {
      const res = await realFetch(base + u, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: 'Bearer ' + tok[who], 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
      })
      return { status: res.status, body: await res.json() }
    }
    const rows = () => data.missingRequests || []

    // --- search ---
    let r = await call('member', '/api/title-search?q=Dune')
    assert.equal(r.status, 200)
    assert.deepEqual(r.body.items.map((i) => [i.kind, i.tmdbId, i.title, i.year]), [
      ['movie', 438631, 'Dune', 2021],
      ['tv', 90228, 'Dune: Prophecy', 2024]
    ], 'people are left out')
    assert.equal(r.body.items[0].tmdbPoster, 'https://image.tmdb.org/t/p/w185/dune.jpg')
    assert.equal(r.body.items[0].inLibrary, false)
    assert.equal(r.body.items[0].request, null)
    const callsAfterFirst = tmdbCalls.length
    r = await call('member', '/api/title-search?q=dune')
    assert.equal(tmdbCalls.length, callsAfterFirst, 'the same search is answered from the cache')

    r = await call('member', '/api/title-search?q=heat&kind=movie')
    assert.equal(r.body.items[0].inLibrary, true)
    r = await call('member', '/api/title-search?q=a')
    assert.equal(r.status, 400)
    assert.equal(r.body.error, 'query_too_short')

    // --- create ---
    r = await call('member', '/api/title-requests', { kind: 'movie', tmdbId: 438631, title: 'Dune', year: 2021, note: '  the new one  ', poster: 'https://image.tmdb.org/t/p/w185/dune.jpg' })
    assert.equal(r.status, 200)
    assert.equal(r.body.created, true)
    assert.equal(r.body.request.status, 'requested')
    assert.equal(r.body.request.note, 'the new one')
    assert.equal(rows().length, 1)
    const row = rows()[0]
    assert.equal(row.kind, 'movie')
    assert.equal(row.source, 'request')
    assert.equal(row.tmdbId, 438631)
    assert.equal(row.year, 2021)
    assert.equal(row.resolved, false)
    assert.equal(row.poster, 'https://image.tmdb.org/t/p/w185/dune.jpg')
    assert.deepEqual(Object.keys(row.requestedBy[0]).sort(), ['at', 'note', 'userId', 'userName'])
    assert.equal(typeof row.firstSeenAt, 'number')

    // --- dedupe ---
    r = await call('member', '/api/title-requests', { kind: 'movie', tmdbId: 438631, title: 'Dune', year: 2021 })
    assert.equal(r.body.deduped, true)
    assert.equal(rows().length, 1)
    assert.equal(rows()[0].requestedBy[0].note, 'the new one', 'asking again without a note keeps the note')
    r = await call('owner', '/api/title-requests', { kind: 'movie', tmdbId: 438631, title: 'Dune', note: 'me too' })
    assert.equal(r.body.appended, true)
    assert.equal(rows().length, 1)
    assert.equal(rows()[0].requestedBy.length, 2)
    // The player's Up Next "missing" report is the very same row.
    r = await call('owner', '/api/missing-request', { kind: 'movie', tmdbId: 438631, title: 'Dune' })
    assert.equal(rows().length, 1)
    assert.equal(rows()[0].requestedBy.length, 2)

    r = await call('member', '/api/title-search?q=dune')
    assert.equal(r.body.items[0].request.status, 'requested')
    assert.equal(r.body.items[0].request.mine, true)

    // --- refusals ---
    r = await call('member', '/api/title-requests', { kind: 'movie', tmdbId: 949, title: 'Heat', year: 1995 })
    assert.equal(r.status, 409)
    assert.equal(r.body.error, 'already_in_library')
    r = await call('member', '/api/title-requests', { kind: 'tv', title: 'Severance' })
    assert.equal(r.status, 409, 'a show already on disk, by name')
    r = await call('member', '/api/title-requests', { kind: 'book', title: 'Dune' })
    assert.equal(r.status, 400)
    r = await call('member', '/api/title-requests', { kind: 'movie', title: '   ' })
    assert.equal(r.status, 400)

    // --- a whole show ---
    r = await call('member', '/api/title-requests', { kind: 'tv', tmdbId: 2316, title: 'The Office', year: 2005 })
    assert.equal(r.status, 200)
    const show = rows().find((x) => x.kind === 'tv')
    assert.equal(show.showName, 'The Office')
    assert.equal(show.season, null)
    assert.equal(show.episode, null)
    assert.equal(show.tmdbId, 2316)
    r = await call('owner', '/api/title-requests', { kind: 'tv', tmdbId: 2316, title: 'The Office (US)' })
    assert.equal(rows().filter((x) => x.kind === 'tv').length, 1, 'whole shows dedupe on the TMDB id')

    // --- listing ---
    r = await call('owner', '/api/title-requests', { kind: 'movie', tmdbId: 1, title: 'Owner Only Film' })
    r = await call('member', '/api/title-requests')
    assert.equal(r.body.canDismiss, false)
    assert.deepEqual(r.body.items.map((i) => i.title).sort(), ['Dune', 'The Office'])
    const memberDune = r.body.items.find((i) => i.title === 'Dune')
    assert.deepEqual(memberDune.requesters, [], 'a member never sees who else asked, or their notes')
    assert.equal(memberDune.requesterCount, 2)
    r = await call('owner', '/api/title-requests')
    assert.equal(r.body.canDismiss, true)
    assert.equal(r.body.items.length, 3)
    assert.deepEqual(r.body.items.find((i) => i.title === 'Dune').requesters.map((q) => q.note), ['the new one', 'me too'])

    // --- dismiss: owner only ---
    const officeId = show.id
    r = await call('member', '/api/title-requests/dismiss', { id: officeId })
    assert.equal(r.status, 403)
    assert.equal(r.body.error, 'owner_only')
    assert.equal(rows().find((x) => x.id === officeId).resolved, false)
    r = await call('owner', '/api/title-requests/dismiss', { id: 'nope' })
    assert.equal(r.status, 404)
    r = await call('owner', '/api/title-requests/dismiss', { id: officeId })
    assert.equal(r.status, 200)
    assert.equal(r.body.request.status, 'dismissed')
    r = await call('member', '/api/title-requests')
    assert.equal(r.body.items.find((i) => i.id === officeId).status, 'dismissed')
    // Both of the show's requesters (Mia, and the owner who also asked as "The Office (US)" and
    // deduped onto the same row) are emailed once it is declined.
    assert.equal(sentEmails.length, 2, 'every requester on the row is emailed once their request is declined')
    assert.deepEqual(sentEmails.map((m) => m.to).sort(), ['mia@example.com', 'owner@example.com'])
    assert.match(sentEmails[0].subject, /The Office/)
    r = await call('owner', '/api/title-requests/dismiss', { id: officeId })
    assert.equal(r.status, 200, 'dismissing an already-dismissed row is a harmless no-op')
    assert.equal(sentEmails.length, 2, 'and does not email a second time')

    // --- the owner's views: web admin API reads the same rows ---
    // (/api/admin/* needs TLS, which this plain-HTTP test server has not got.)
    r = await call('owner', '/api/admin/missing')
    assert.equal(r.status, 403)
    assert.equal(r.body.error, 'https_required')

    // --- arrives in the library -> added ---
    manifest['Dune (2021).mkv'] = { id: 438631, title: 'Dune', release_date: '2021-09-15', genre_ids: [] }
    await fs.writeFile(path.join(cacheDir, 'manifest.json'), JSON.stringify(manifest))
    await fs.writeFile(path.join(moviesDir, 'Dune (2021).mkv'), 'x')
    let status = null
    for (let i = 0; i < 60 && status !== 'added'; i++) {
      r = await call('member', '/api/title-requests')
      status = r.body.items.find((x) => x.title === 'Dune').status
      if (status !== 'added') await new Promise((res) => setTimeout(res, 250))
    }
    assert.equal(status, 'added')
    const dune = rows().find((x) => x.tmdbId === 438631)
    assert.equal(dune.resolved, true)
    assert.equal(typeof dune.addedAt, 'number')
    assert.equal(rows().find((x) => x.id === officeId).addedAt, undefined, 'the dismissed row was not touched')
    // Both of Dune's requesters (Mia and the owner) get emailed once the library rescan finds it -
    // the exact same requestersToNotify/notifyTitleRequesters path the desktop app's own
    // "Found it" and "Decline" buttons use, just triggered by the 10-minute arrival sweep instead.
    const duneEmails = sentEmails.filter((m) => /Dune/.test(m.subject))
    assert.deepEqual(duneEmails.map((m) => m.to).sort(), ['mia@example.com', 'owner@example.com'])
    assert.match(duneEmails[0].subject, /ready on Beebo/)

    // --- rate limits ---
    for (let i = 0; i < 20; i++) {
      r = await call('spammer', '/api/title-requests', { kind: 'movie', tmdbId: 10000 + i, title: 'Film ' + i })
      assert.equal(r.status, 200, 'request ' + i)
    }
    r = await call('spammer', '/api/title-requests', { kind: 'movie', tmdbId: 20000, title: 'One too many' })
    assert.equal(r.status, 429)
    assert.equal(r.body.error, 'rate_limited')
    assert.ok(r.body.retryAfterSeconds > 0)
    assert.equal(rows().some((x) => x.tmdbId === 20000), false)
    r = await call('member', '/api/title-requests', { kind: 'movie', tmdbId: 20001, title: 'Someone else' })
    assert.equal(r.status, 200, 'the limit is per person')

    for (let i = 0; i < 30; i++) {
      r = await call('spammer', '/api/title-search?q=query' + i)
      assert.equal(r.status, 200, 'search ' + i)
    }
    r = await call('spammer', '/api/title-search?q=query-overflow')
    assert.equal(r.status, 429)
    r = await call('spammer', '/api/title-search?q=query3')
    assert.equal(r.status, 200, 'a cached search costs nothing')

    // No token, no requests.
    const anon = await realFetch(base + '/api/title-requests')
    assert.equal(anon.status, 401)
    await anon.arrayBuffer()
  } finally {
    globalThis.fetch = realFetch
    if (info) await new Promise((r) => info.close(r))
    await fs.rm(root, { recursive: true, force: true })
  }
})
