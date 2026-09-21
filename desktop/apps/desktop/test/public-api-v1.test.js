'use strict'
// /api/v1: the public, read-only, versioned API. Real server over a fixture library.
// Run: node --test test/public-api-v1.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const history = require('../electron/history')
const publicApi = require('../electron/publicApi')
const { createFixture } = require('./helpers/publicApiFixture')

test('unauthenticated and bad credentials are refused, and /api/ping still carries the version', async (t) => {
  const f = await createFixture(t)
  assert.equal((await f.call(null, '/api/v1')).status, 401)
  assert.equal((await f.call(null, '/api/v1/library/movies')).status, 401)
  assert.equal((await f.call('not-a-token', '/api/v1/library/movies')).status, 401)
  // The route list is only shown to someone signed in: a bad credential learns nothing about it.
  assert.equal((await f.call(null, '/api/v1/definitely-not-a-route')).status, 401)
  const ping = await f.call(null, '/api/ping')
  assert.equal(ping.status, 200)
  assert.equal(ping.body.apiVersion, 1)
})

test('index says who is asking and lists the endpoints they may use', async (t) => {
  const f = await createFixture(t)
  const r = await f.call('owner', '/api/v1')
  assert.equal(r.status, 200)
  assert.equal(r.body.apiVersion, 1)
  assert.equal(r.body.auth.type, 'account')
  assert.deepEqual(r.body.auth.scopes, ['library', 'history', 'now-playing', 'metrics'], 'an admin\'s account token has every scope')
  const member = await f.call('member', '/api/v1')
  assert.deepEqual(member.body.auth.scopes, ['library', 'history'], 'anyone else\'s has library and history')
  assert.ok(member.body.endpoints.every((e) => ['library', 'history'].includes(e.scope)), 'and is only told about what it can call')
  assert.deepEqual(r.body.endpoints.map((e) => e.path).sort(), publicApi.endpointList().map((e) => e.path).sort())
  assert.equal((await f.call('owner', '/api/v1/')).status, 200, 'trailing slash tolerated')
})

test('movies: own stable shape, no stream token, genre names, paging and filters', async (t) => {
  const f = await createFixture(t)
  const r = await f.call('owner', '/api/v1/library/movies')
  assert.equal(r.status, 200)
  assert.equal(r.body.apiVersion, 1)
  assert.equal(r.body.total, 3)
  assert.deepEqual(r.body.items.map((m) => m.title), ['Alien', 'Aliens', 'Heat'])
  const alien = r.body.items[0]
  assert.deepEqual(Object.keys(alien).sort(), ['backdrop', 'collection', 'genres', 'id', 'isNew', 'overview', 'poster', 'quality', 'title', 'tmdbId', 'voteAverage', 'year'])
  assert.equal(alien.year, 1979)
  assert.equal(alien.tmdbId, 348)
  assert.equal(alien.voteAverage, 8.1)
  assert.deepEqual(alien.genres.map((g) => g.name), ['Horror', 'Science Fiction'])
  assert.equal(alien.poster, '/media/poster/348.jpg')
  assert.deepEqual(alien.collection, { id: 8091, name: 'Alien Collection' })
  assert.equal(r.body.items[2].collection, null)
  assert.doesNotMatch(r.text, /mt=|\/file\?|"stream"/, 'the media token and stream URL stay internal')
  assert.doesNotMatch(r.text, /\.mp4|\.mkv/, 'no file names')

  const paged = await f.call('owner', '/api/v1/library/movies?limit=1&offset=1')
  assert.equal(paged.body.total, 3)
  assert.equal(paged.body.limit, 1)
  assert.equal(paged.body.offset, 1)
  assert.deepEqual(paged.body.items.map((m) => m.title), ['Aliens'])
  const search = await f.call('owner', '/api/v1/library/movies?q=heat')
  assert.deepEqual(search.body.items.map((m) => m.title), ['Heat'])
  const huge = await f.call('owner', '/api/v1/library/movies?limit=999999')
  assert.equal(huge.body.limit, publicApi.PAGE_MAX)
})

test('tv shows, collections and recently-added', async (t) => {
  const f = await createFixture(t)
  const shows = await f.call('owner', '/api/v1/library/tvshows')
  assert.equal(shows.status, 200)
  assert.equal(shows.body.total, 1)
  assert.equal(shows.body.items[0].title.toLowerCase(), 'severance')
  assert.equal(shows.body.items[0].episodeCount, 2)
  assert.doesNotMatch(shows.text, /\.mkv|Season 1|mt=/)

  const cols = await f.call('owner', '/api/v1/library/collections')
  assert.equal(cols.status, 200)
  assert.deepEqual(cols.body.items.map((c) => [c.id, c.name, c.ownedCount, c.total, c.complete]), [[8091, 'Alien Collection', 2, 2, true]])
  assert.equal(cols.body.items[0].poster, '/media/poster/348.jpg')

  const recent = await f.call('owner', '/api/v1/library/recently-added')
  assert.equal(recent.status, 200)
  assert.equal(recent.body.total, 4)
  assert.deepEqual(new Set(recent.body.items.map((i) => i.kind)), new Set(['movie', 'tv']))
  assert.ok(recent.body.items.every((i) => i.addedAt === null || typeof i.addedAt === 'number'))
  assert.doesNotMatch(recent.text, /mt=|"stream"|showKey/)
})

test('history and continue: own rows only, with no stream URL, file name or user id', async (t) => {
  const f = await createFixture(t)
  const sid = history.startSession(f.store, { userId: 'owner', userName: 'Owner', title: 'Heat', fileName: 'Heat (1995).mp4', kind: 'movie' })
  history.updateSession(f.store, sid, { currentTime: 600, duration: 6000 })
  const other = history.startSession(f.store, { userId: 'member', userName: 'Member', title: 'Alien', fileName: 'Alien (1979).mp4', kind: 'movie' })
  history.updateSession(f.store, other, { currentTime: 900, duration: 6000 })

  for (const route of ['/api/v1/history', '/api/v1/continue']) {
    const r = await f.call('owner', route)
    assert.equal(r.status, 200, route)
    assert.equal(r.body.total, 1, route)
    const item = r.body.items[0]
    assert.equal(item.title, 'Heat')
    assert.equal(item.positionSeconds, 600)
    assert.equal(item.durationSeconds, 6000)
    assert.equal(item.percent, 10)
    assert.deepEqual(Object.keys(item).sort(), ['durationSeconds', 'id', 'kind', 'percent', 'positionSeconds', 'poster', 'title', 'upNext', 'updatedAt', 'watched'])
    assert.doesNotMatch(r.text, /mt=|\/file\?|Heat \(1995\)|"owner"|"userId"/, route)
    assert.doesNotMatch(r.text, /Alien/, 'another member\'s history never appears')
  }
})

test('a profile with private viewing history gets nothing from history or continue', async (t) => {
  const f = await createFixture(t)
  const sid = history.startSession(f.store, { userId: 'hidden', userName: 'Hidden', title: 'Heat', fileName: 'Heat (1995).mp4', kind: 'movie' })
  history.updateSession(f.store, sid, { currentTime: 600, duration: 6000 })
  const tok = f.tokens.hidden
  for (const route of ['/api/v1/history', '/api/v1/continue']) {
    const r = await f.call(tok, route)
    assert.equal(r.status, 403, route)
    assert.equal(r.body.error, 'history_private')
    assert.doesNotMatch(r.text, /Heat/)
  }
})

test('now-playing: the dashboard live list in its own shape, owner only, nobody private or limited, no address', async (t) => {
  const f = await createFixture(t)
  const play = (userId, userName, title, fileName) => {
    const sid = history.startSession(f.store, { userId, userName, title, fileName, kind: 'movie' })
    history.updateSession(f.store, sid, { currentTime: 300, duration: 6000 })
    f.info.dashboard.noteSession({ headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/120', 'x-forwarded-for': '203.0.113.9' }, socket: { remoteAddress: '192.168.1.44' }, beeboUserId: userId }, sid)
  }
  play('member', 'Member', 'Alien', 'Alien (1979).mp4')
  play('kid', 'Kid', 'Heat', 'Heat (1995).mp4')
  play('hidden', 'Hidden', 'Aliens', 'Aliens (1986).mkv')

  const r = await f.call('owner', '/api/v1/now-playing')
  assert.equal(r.status, 200)
  assert.equal(r.body.count, 1)
  const item = r.body.items[0]
  assert.equal(item.title, 'Alien')
  assert.deepEqual(item.user, { id: 'member', name: 'Member' })
  assert.equal(item.playback, 'direct')
  assert.equal(item.positionSeconds, 300)
  assert.doesNotMatch(r.text, /192\.168|203\.0\.113|"ip"|Heat|Aliens|Hidden|Kid/, 'no addresses, and neither a private nor a limited profile is listed')

  assert.equal((await f.call('member', '/api/v1/now-playing')).status, 403, 'members do not see the owner dashboard')
  assert.equal((await f.call('kid', '/api/v1/now-playing')).status, 403, 'a limited profile does not either')
})

test('shapeNowPlaying drops private rows outright and masks nothing into a leak', () => {
  const rows = [
    { userId: 'a', user: 'A', title: 'Public', kind: 'movie', where: 'home', playback: 'direct', positionSeconds: 10.4, durationSeconds: 100, progress: 0.1, startedAt: 5, ip: '10.0.0.5', filePath: 'C:\\secret\\x.mkv' },
    { userId: 'p', user: 'P', title: 'Private viewing', historyPrivate: true },
    { userId: 'k', user: 'K', title: 'Kid film', kind: 'movie' }
  ]
  const out = publicApi.shapeNowPlaying(rows, (id) => id === 'k')
  assert.equal(out.count, 1)
  assert.doesNotMatch(JSON.stringify(out), /10\.0\.0\.5|secret|Kid|Private/)
})

test('the route list is an allowlist: unknown and admin paths 404, writes 405, and /api/* is untouched', async (t) => {
  const f = await createFixture(t)
  for (const route of ['/api/v1/admin/users', '/api/v1/admin', '/api/v1/login', '/api/v1/parental/status', '/api/v1/private-vault', '/api/v1/library/movies/extra', '/api/v1/watchlist', '/api/v1/nope']) {
    const r = await f.call('owner', route)
    assert.equal(r.status, 404, route)
    assert.equal(r.body.error, 'not_found')
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const r = await f.call('owner', '/api/v1/library/movies', { method, body: {} })
    assert.equal(r.status, 405, method)
    assert.equal(r.body.error, 'read_only')
  }
  // The unversioned surface the apps use is exactly as it was: still carries the stream token.
  const legacy = await f.call('owner', '/api/movies')
  assert.equal(legacy.status, 200)
  assert.match(legacy.body.items[0].stream, /^\/file\?id=.+&mt=/)
  const recent = await f.call('owner', '/api/recently-added')
  assert.equal(recent.status, 200)
  assert.equal(recent.body.items.length, 4)
  assert.ok(recent.body.items.every((i) => 'showKey' in i))
  assert.equal((await f.call('owner', '/api/collections')).body.items.length, 1)
})

test('a limited profile\'s account token keeps its content gate on /api/v1/library', async (t) => {
  const f = await createFixture(t)
  const r = await f.call('kid', '/api/v1/library/movies')
  assert.equal(r.status, 200)
  const full = await f.call('owner', '/api/v1/library/movies')
  assert.ok(r.body.items.length <= full.body.items.length)
})
