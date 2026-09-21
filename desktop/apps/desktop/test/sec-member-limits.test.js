// Security review 2026-09-21 (P-4..P-12): what one signed-in household member (or a shared-library guest) could
// write into the owner's settings file, disk or CPU without a limit, plus the BeeboSchool PIN and Range fixes.
// Run: node --test test/sec-member-limits.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const { withServer, localRequire } = require('./security-harness')

test('watchlist, favourites and the legacy watched mark refuse absurd ids and clip stored strings', async () => {
  await withServer({}, async ({ api, store, user }) => {
    const big = 'x'.repeat(5000)
    let r = await api('POST', '/api/watchlist', { id: big, kind: 'movie', title: 't' })
    assert.equal(r.status, 400)
    r = await api('POST', '/api/watchlist', { id: 'a', kind: 'movie', title: 't', poster: 'p'.repeat(9000), stream: 's'.repeat(9000) })
    assert.equal(r.status, 200)
    assert.equal(r.json.entry.poster.length, 500)
    assert.equal(r.json.entry.stream.length, 2000)
    r = await api('POST', '/api/favorite', { id: big, kind: 'movie', favorite: true })
    assert.equal(r.status, 400)
    r = await api('POST', '/api/watched', { id: big, kind: 'movie', watched: true })
    assert.equal(r.status, 400)
    assert.ok(JSON.stringify(store.get('libraryFlags') || {}).length < 2000, 'nothing large was stored')
    void user
  })
})

test('a title request stores clipped strings', async () => {
  await withServer({}, async ({ store, user, server }) => {
    const out = server.recordMissingRequest(store, { kind: 'movie', title: 'T'.repeat(5000), userId: user.id, userName: 'Owner', source: 'request' })
    assert.equal(out.ok, true)
    assert.equal(store.get('missingRequests')[0].title.length, 200)
  })
})

test('the BeeboSchool PIN check over the app API locks after five wrong guesses; child ids are plain tokens', async () => {
  await withServer({}, async ({ api, store }) => {
    // BeeboSchool keeps its files beside the drive root by default: point it at a temp folder so the test never
    // touches a real profile folder.
    const schoolDir = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'beebo-school-test-'))
    store.set('beeboSchoolDir', schoolDir)
    let r = await api('POST', '/api/school/pin/set', { pin: '4821' })
    assert.equal(r.status, 200)
    assert.ok(store.get('schoolPinHash'))
    for (let i = 0; i < 5; i++) {
      r = await api('POST', '/api/school/pin/verify', { pin: '000' + i })
      assert.equal(r.json.valid, false)
    }
    r = await api('POST', '/api/school/pin/verify', { pin: '4821' })
    assert.equal(r.status, 429, 'locked even for the right PIN')
    r = await api('POST', '/api/school/profile', { child: '../../evil', addPoints: 1 })
    assert.equal(r.status, 400)
    r = await api('POST', '/api/school/profile', { child: 'kid1', addPoints: 1e9 })
    assert.equal(r.status, 200)
    assert.equal(r.json.profile.points, 1000, 'points are clamped per call')
    require('node:fs').rmSync(schoolDir, { recursive: true, force: true })
  })
})

test('Range parsing for small files: last-N bytes, out-of-range is refused, never a negative length', () => {
  const { parseSingleRange } = localRequire('./electron/streamServer')
  assert.deepEqual(parseSingleRange('bytes=0-9', 100), { start: 0, end: 9 })
  assert.deepEqual(parseSingleRange('bytes=90-', 100), { start: 90, end: 99 })
  assert.deepEqual(parseSingleRange('bytes=-5', 100), { start: 95, end: 99 }, 'the LAST five bytes')
  assert.deepEqual(parseSingleRange('bytes=10-9999', 100), { start: 10, end: 99 })
  for (const bad of ['bytes=99999-', 'bytes=100-', 'bytes=-0', 'bytes=-', 'bytes=5-2', 'bytes=0-1,5-6', 'items=0-1', '', 'bytes=1e3-2']) assert.equal(parseSingleRange(bad, 100), null, bad)
  assert.equal(parseSingleRange('bytes=0-1', 0), null, 'an empty file has no valid range')
})
