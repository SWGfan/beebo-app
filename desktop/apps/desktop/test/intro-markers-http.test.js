// Auto-detected intro/credits markers through the real HTTP server: how they are merged with
// viewer-set markers (viewer always wins, an explicit clear stays cleared), what the phone-app
// endpoint and playback info expose, the web player's Skip Intro window, and the admin controls.
// The detector itself is exercised in intro-detect*.test.js; here the results are seeded straight
// into the 'autoMarkers' store key, exactly as the scanner writes them.
// Run: node --test test/intro-markers-http.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const crypto = require('node:crypto')
const auth = require('../electron/auth')
const server = require('../electron/streamServer')
const M = require('../electron/markerModel')
const { testPort } = require('./helpers/testPort')

const SECRET = crypto.randomBytes(32).toString('hex')
const DURATION = 1500

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'beebo-intro-markers-'))
  const moviesDir = path.join(root, 'movies')
  const tvDir = path.join(root, 'tv')
  await fs.mkdir(moviesDir)
  await fs.mkdir(path.join(tvDir, 'The Show'), { recursive: true })
  await fs.writeFile(path.join(moviesDir, 'Big Film (2019).mp4'), Buffer.alloc(4096, 1))
  const episodes = []
  for (const n of [1, 2, 3]) {
    const rel = path.join("The Show", `The.Show.S01E0${n}.mp4`)
    await fs.writeFile(path.join(tvDir, rel), Buffer.alloc(4096, n))
    episodes.push({ rel, abs: path.join(tvDir, rel), id: server.encodeId(rel) })
  }
  const data = {
    authUsers: [
      { id: 'owner', name: 'Owner', username: 'owner', status: 'approved', isAdmin: true, passwordHash: auth.hashPassword('Owner-password-1') },
      { id: 'kid', name: 'Member', username: 'member', status: 'approved', adult: true, passwordHash: auth.hashPassword('Member-password-1') }
    ]
  }
  const store = { get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] }, onDidChange: () => () => {} }
  auth.forgetSecrets(); server.forgetSecrets()
  const info = server.startStreamServer({
    port: testPort(),
    store, getMoviesDir: () => moviesDir, getTvShowsDir: () => tvDir,
    getAllMoviesDirs: () => [moviesDir], getAllTvShowsDirs: () => [tvDir],
    agentSecret: SECRET, log: () => {},
    autoMarkers: { startDelayMs: 3600 * 1000, intervalMs: 3600 * 1000 }
  })
  t.after(async () => {
    await new Promise((resolve) => info.close(resolve))
    await fs.rm(root, { recursive: true, force: true })
  })
  const base = 'http://127.0.0.1:' + info.port
  let ready = false
  for (let i = 0; i < 50; i++) {
    try { await (await fetch(base + '/api/ping')).arrayBuffer(); ready = true; break } catch { await new Promise((r) => setTimeout(r, 50)) }
  }
  assert.equal(ready, true, 'server started')
  const tokens = { owner: server.makeApiToken(store, 'owner'), kid: server.makeApiToken(store, 'kid') }
  async function api(who, route, body, headers = {}) {
    const response = await fetch(base + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokens[who], ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    const text = await response.text()
    let json = null
    try { json = JSON.parse(text) } catch {}
    return { status: response.status, body: json, text }
  }
  const admin = (route, body) => api('owner', route, body, { 'X-Beebo-Agent-Key': SECRET })
  // A real client has browsed the library before it ever asks about markers; that is what fills the
  // shared library cache the marker lookups read.
  await api('kid', '/api/tvshows')
  await api('kid', '/api/movies')
  const page = async (route) => {
    const r = await fetch(base + route, { headers: { Cookie: 'beebo_session=' + auth.signSession(store, 'owner') }, redirect: 'manual' })
    return { status: r.status, text: await r.text() }
  }
  // What the scanner would have written for this file (see introDetectJob.js).
  async function seed(file, fields) {
    const st = await fs.stat(file)
    const identity = M.fileIdentity(file, st)
    const all = { ...(data.autoMarkers || {}) }
    all[identity] = { identity, version: 1, durationSec: DURATION, showKey: server.encodeId('the show'), showName: 'The Show', kind: 'tv', seenAt: Date.now(), ...fields }
    data.autoMarkers = all
  }
  const auto = { introStart: 40, introEnd: 100, introConfidence: 0.85, creditsStart: 1380, creditsConfidence: 0.8 }
  return { data, store, base, api, admin, page, seed, episodes, moviesDir, auto }
}

const markers = (f, ep, extra = '') => f.api('kid', `/api/markers?kind=tv&id=${encodeURIComponent(ep.id)}&duration=${DURATION}${extra}`)

test('auto-detected markers appear under `effective` as source "auto" while the legacy fields stay viewer-only', async (t) => {
  const f = await fixture(t)
  await f.seed(f.episodes[0].abs, f.auto)
  const r = await markers(f, f.episodes[0])
  assert.equal(r.status, 200, r.text)
  assert.equal(r.body.introEndSeconds, null, 'an older app would skip from 0 to introEnd - it must never receive an auto value there')
  assert.equal(r.body.introStartSeconds, null)
  assert.equal(r.body.creditsStartSeconds, null)
  assert.deepEqual(
    { s: r.body.effective.introStartSeconds, e: r.body.effective.introEndSeconds, c: r.body.effective.creditsStartSeconds },
    { s: 40, e: 100, c: 1380 }
  )
  assert.equal(r.body.effective.source, 'auto')
  assert.equal(r.body.effective.introSource, 'auto')
  assert.equal(r.body.effective.creditsSource, 'auto')
  assert.equal(r.body.effective.confidence, 0.8)
  // The neighbouring episode has no auto record of its own: nothing is invented for it.
  const other = await markers(f, f.episodes[1])
  assert.equal(other.body.effective.source, null)
})

test('a viewer-set marker always wins, per part; auto only fills the gap', async (t) => {
  const f = await fixture(t)
  await f.seed(f.episodes[0].abs, f.auto)
  const set = await f.api('kid', '/api/markers', { kind: 'tv', id: f.episodes[0].id, introEndSeconds: 55, durationSeconds: DURATION })
  assert.equal(set.status, 200)
  const r = await markers(f, f.episodes[0])
  assert.equal(r.body.introEndSeconds, 55)
  assert.equal(r.body.effective.introEndSeconds, 55)
  assert.equal(r.body.effective.introStartSeconds, null, 'auto does not lend a start to a viewer-set end')
  assert.equal(r.body.effective.introSource, 'viewer')
  assert.equal(r.body.effective.creditsStartSeconds, 1380)
  assert.equal(r.body.effective.creditsSource, 'auto')
  assert.equal(r.body.effective.source, 'viewer')

  await f.api('kid', '/api/markers', { kind: 'tv', id: f.episodes[0].id, creditsStartSeconds: 1400, durationSeconds: DURATION })
  const both = await markers(f, f.episodes[0])
  assert.equal(both.body.effective.creditsStartSeconds, 1400)
  assert.equal(both.body.effective.creditsSource, 'viewer')
})

test('a show-wide viewer marker is inherited by every episode; each episode keeps its own auto credits', async (t) => {
  const f = await fixture(t)
  await f.seed(f.episodes[0].abs, f.auto)
  await f.seed(f.episodes[1].abs, { ...f.auto, creditsStart: 1350 })
  await f.api('kid', '/api/markers', { kind: 'tv', id: f.episodes[2].id, introEndSeconds: 61, durationSeconds: DURATION })
  const a = await markers(f, f.episodes[0])
  const b = await markers(f, f.episodes[1])
  assert.equal(a.body.effective.introEndSeconds, 61)
  assert.equal(b.body.effective.introEndSeconds, 61)
  assert.equal(a.body.effective.creditsStartSeconds, 1380)
  assert.equal(b.body.effective.creditsStartSeconds, 1350)
})

test('a viewer clearing a part keeps it cleared; setting a real value lifts that; the admin can drop the whole row', async (t) => {
  const f = await fixture(t)
  await f.seed(f.episodes[0].abs, f.auto)
  const cleared = await f.api('kid', '/api/markers', { kind: 'tv', id: f.episodes[0].id, creditsStartSeconds: null })
  assert.equal(cleared.status, 200)
  let r = await markers(f, f.episodes[0])
  assert.equal(r.body.effective.creditsStartSeconds, null)
  assert.equal(r.body.effective.creditsSource, null)
  assert.equal(r.body.effective.introSource, 'auto', 'only the cleared part is suppressed')
  const row = data(f).playbackMarkers.find((x) => x.scope === 'show')
  assert.deepEqual(row.autoSuppress, { credits: true })

  await f.api('kid', '/api/markers', { kind: 'tv', id: f.episodes[0].id, creditsStartSeconds: 1390, durationSeconds: DURATION })
  r = await markers(f, f.episodes[0])
  assert.equal(r.body.effective.creditsStartSeconds, 1390)
  assert.equal(data(f).playbackMarkers.find((x) => x.scope === 'show').autoSuppress, undefined)

  await f.api('kid', '/api/markers', { kind: 'tv', id: f.episodes[0].id, introEndSeconds: null })
  r = await markers(f, f.episodes[0])
  assert.equal(r.body.effective.introEndSeconds, null)
  assert.equal(r.body.effective.introSource, null)

  const key = server.encodeId('the show')
  const cleared2 = await f.admin('/api/admin/markers/clear', { scope: 'show', key })
  assert.equal(cleared2.status, 200, cleared2.text)
  r = await markers(f, f.episodes[0])
  assert.equal(r.body.effective.introSource, 'auto', 'removing the viewer row returns to what was detected')
})
const data = (f) => f.data

test('an explicit clear works even when no viewer marker existed before (there is only an auto one)', async (t) => {
  const f = await fixture(t)
  await f.seed(f.episodes[0].abs, f.auto)
  await f.api('kid', '/api/markers', { kind: 'tv', id: f.episodes[0].id, introEndSeconds: null, introStartSeconds: null })
  const r = await markers(f, f.episodes[0])
  assert.equal(r.body.effective.introEndSeconds, null)
  assert.equal(r.body.effective.creditsSource, 'auto')
})

test('auto markers pass the same guards: a nonsense record and a low-confidence one expose nothing', async (t) => {
  const f = await fixture(t)
  await f.seed(f.episodes[0].abs, { introStart: 40, introEnd: 100, introConfidence: 0.4, creditsStart: 1380, creditsConfidence: 0.59 })
  await f.seed(f.episodes[1].abs, { introStart: 40, introEnd: 900, introConfidence: 0.9, creditsStart: 100, creditsConfidence: 0.9 })
  for (const ep of [f.episodes[0], f.episodes[1]]) {
    const r = await markers(f, ep)
    assert.equal(r.body.effective.source, null, JSON.stringify(r.body.effective))
  }
})

test('the settings switch turns auto markers off everywhere', async (t) => {
  const f = await fixture(t)
  await f.seed(f.episodes[0].abs, f.auto)
  f.data.autoMarkersEnabled = false
  const r = await markers(f, f.episodes[0])
  assert.equal(r.body.effective.source, null)
  f.data.autoMarkersEnabled = true
  assert.equal((await markers(f, f.episodes[0])).body.effective.source, 'auto')
})

test('films get auto credits, keyed by their own file', async (t) => {
  const f = await fixture(t)
  await f.seed(path.join(f.moviesDir, 'Big Film (2019).mp4'), { kind: 'movie', showKey: null, creditsStart: 1400, creditsConfidence: 0.9 })
  const id = server.encodeId('Big Film (2019).mp4')
  const r = await f.api('kid', `/api/markers?kind=movie&id=${encodeURIComponent(id)}&duration=${DURATION}`)
  assert.equal(r.body.effective.creditsStartSeconds, 1400)
  assert.equal(r.body.effective.creditsSource, 'auto')
})

test('a replaced file (different size) never inherits the old file\'s auto markers', async (t) => {
  const f = await fixture(t)
  await f.seed(f.episodes[0].abs, f.auto)
  await fs.writeFile(f.episodes[0].abs, Buffer.alloc(9000, 9))
  const r = await markers(f, f.episodes[0])
  assert.equal(r.body.effective.source, null)
})

test('the web player page carries the auto window and its Skip intro button; the script is valid JavaScript', async (t) => {
  const f = await fixture(t)
  await f.seed(f.episodes[0].abs, f.auto)
  const p = await f.page(`/tvwatch?id=${encodeURIComponent(f.episodes[0].id)}`)
  assert.equal(p.status, 200)
  assert.match(p.text, /id="skipIntro"/)
  assert.match(p.text, /const markerIntroStart = 40\b/)
  assert.match(p.text, /const markerIntroEnd = 100\b/)
  assert.match(p.text, /const markerIntroWindow = true/)
  assert.match(p.text, /const markerCreditsAuto = true/)
  assert.match(p.text, /const markerAutoSkipIntro = false/, 'an auto intro never jumps on its own')
  for (const m of p.text.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new vm.Script(m[1]), 'inline player script parses')
})

test('a viewer-set intro END on its own behaves as before: auto-skip on load, no button', async (t) => {
  const f = await fixture(t)
  await f.api('kid', '/api/markers', { kind: 'tv', id: f.episodes[1].id, introEndSeconds: 45, durationSeconds: DURATION })
  const p = await f.page(`/tvwatch?id=${encodeURIComponent(f.episodes[1].id)}`)
  assert.doesNotMatch(p.text, /id="skipIntro"/)
  assert.match(p.text, /const markerIntroEnd = 45\b/)
  assert.match(p.text, /const markerAutoSkipIntro = true/)
  assert.match(p.text, /const markerCreditsAuto = false/)
  for (const m of p.text.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new vm.Script(m[1]))
})

test('an episode with no markers at all renders exactly the old page (no skip button)', async (t) => {
  const f = await fixture(t)
  const p = await f.page(`/tvwatch?id=${encodeURIComponent(f.episodes[2].id)}`)
  assert.equal(p.status, 200)
  assert.doesNotMatch(p.text, /id="skipIntro"/)
  assert.match(p.text, /const markerIntroWindow = false/)
})

test('admin: list, re-scan and clear the auto markers of a show', async (t) => {
  const f = await fixture(t)
  for (const ep of f.episodes) await f.seed(ep.abs, f.auto)
  const listed = await f.admin('/api/admin/markers/auto')
  assert.equal(listed.status, 200, listed.text)
  assert.equal(listed.body.enabled, true)
  assert.equal(listed.body.status.enabled, true)

  const key = server.encodeId('the show')
  const denied = await f.api('kid', '/api/admin/markers/auto/clear', { scope: 'show', key })
  assert.notEqual(denied.status, 200, 'not for ordinary members')

  const bad = await f.admin('/api/admin/markers/auto/clear', { scope: 'show' })
  assert.equal(bad.status, 400)

  const cleared = await f.admin('/api/admin/markers/auto/clear', { scope: 'show', key })
  assert.equal(cleared.status, 200, cleared.text)
  assert.equal(cleared.body.cleared, 3)
  for (const ep of f.episodes) assert.equal((await markers(f, ep)).body.effective.source, null)

  const rescan = await f.admin('/api/admin/markers/auto/rescan', { scope: 'show', key })
  assert.equal(rescan.status, 200, rescan.text)
  assert.equal(rescan.body.reset, 3)
  assert.equal((await markers(f, f.episodes[0])).body.effective.source, null, 'the records are gone until the scanner runs again')

  const film = await f.admin('/api/admin/markers/auto/rescan', { scope: 'movie', key: 'Big Film (2019).mp4' })
  assert.equal(film.status, 200, film.text)
  const missing = await f.admin('/api/admin/markers/auto/rescan', { scope: 'movie', key: 'Nope.mp4' })
  assert.equal(missing.status, 404)
})

test('the dashboard library section carries a progress line for the scanner', async (t) => {
  const f = await fixture(t)
  const r = await f.admin('/api/admin/dashboard?sections=library')
  assert.equal(r.status, 200, r.text)
  assert.ok(r.body.library, r.text)
  assert.ok(r.body.library.introScan, 'introScan present')
  assert.equal(typeof r.body.library.introScan.itemsTotal, 'number')
  assert.equal(r.body.library.introScan.enabled, true)
  assert.equal(r.body.library.introScan.paused === 'no_ffmpeg' || r.body.library.introScan.paused === '', true)
})

test('playback info carries the effective markers next to the existing fields', async (t) => {
  const f = await fixture(t)
  await f.seed(f.episodes[0].abs, f.auto)
  const r = await f.api('kid', `/api/playback/info?kind=tv&id=${encodeURIComponent(f.episodes[0].id)}`)
  assert.equal(r.status, 200, r.text)
  assert.equal(r.body.ok, true)
  assert.ok('subtitles' in r.body && 'qualities' in r.body, 'the existing fields are still there')
  assert.equal(r.body.markers.source, 'auto')
  assert.equal(r.body.markers.introStartSeconds, 40)
  assert.equal(r.body.markers.introEndSeconds, 100)
  assert.equal(r.body.markers.creditsStartSeconds, 1380)
  const none = await f.api('kid', `/api/playback/info?kind=tv&id=${encodeURIComponent(f.episodes[1].id)}`)
  assert.equal(none.body.markers.source, null)
})
