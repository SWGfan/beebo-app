// Cinema Mode through the real HTTP server: the GET /api/playback/preroll contract (what TV and phone
// clients rely on), per-person settings, signed local trailer files (ranges, bad tokens), the parental
// gate for a restricted profile, the cookie routes' CSRF rule, the player page wiring and the CSP header.
// Run: node --test test/cinema-mode-http.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const auth = require('../electron/auth')
const server = require('../electron/streamServer')
const parental = require('../electron/parentalControls')

const SECRET = crypto.randomBytes(32).toString('hex')
const http = require('node:http')
const { testPort } = require('./helpers/testPort')
const rawGet = (base, rawPath) => new Promise((resolve) => {
  const u = new URL(base)
  const req = http.request({ host: u.hostname, port: u.port, path: rawPath, method: 'GET' }, (res) => { const parts = []; res.on('data', (c) => parts.push(c)); res.on('end', () => resolve(Buffer.concat(parts).toString('latin1'))) })
  req.on('error', () => resolve(''))
  req.end()
})
const YT = (n) => 'AbCdEfGhI' + String(n).padStart(2, '0')

const MOVIES = {
  'Kid Feature (2021).mp4': { id: 1001, title: 'Kid Feature', release_date: '2021-05-01', genre_ids: [16], certification: 'PG' },
  'Feature (2020).mp4': { id: 1000, title: 'Feature', release_date: '2020-05-01', genre_ids: [28], certification: 'PG-13' },
  'Alpha (2019).mp4': { id: 1, title: 'Alpha', release_date: '2019-01-01', genre_ids: [28], certification: 'PG' },
  'Grown (2018).mp4': { id: 2, title: 'Grown', release_date: '2018-01-01', genre_ids: [28], certification: 'R' },
  'Owned Only (2017).mp4': { id: 3, title: 'Owned Only', release_date: '2017-01-01', genre_ids: [28], certification: 'PG' },
  'Seen It (2016).mp4': { id: 4, title: 'Seen It', release_date: '2016-01-01', genre_ids: [28], certification: 'PG' }
}

async function fixture(t, { online } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'beebo-cinema-http-'))
  const moviesDir = path.join(root, 'movies')
  const tvDir = path.join(root, 'tv')
  const cacheDir = path.join(root, 'tmdb')
  const cinemaDir = path.join(root, 'Cinema')
  for (const d of [moviesDir, tvDir, cacheDir, path.join(cinemaDir, 'Trailers')]) await fs.mkdir(d, { recursive: true })
  for (const name of Object.keys(MOVIES)) await fs.writeFile(path.join(moviesDir, name), Buffer.alloc(2048, 7))
  await fs.writeFile(path.join(moviesDir, 'Alpha (2019)-trailer.mp4'), Buffer.from('ALPHA-TRAILER-BYTES-0123456789'))
  await fs.writeFile(path.join(moviesDir, 'Grown (2018)-trailer.mp4'), Buffer.from('GROWN-TRAILER-BYTES'))
  await fs.writeFile(path.join(moviesDir, 'Seen It (2016)-trailer.mp4'), Buffer.from('SEEN-TRAILER-BYTES'))
  await fs.writeFile(path.join(cinemaDir, 'Feature Presentation.mp4'), Buffer.from('INTRO-BYTES'))
  await fs.writeFile(path.join(root, 'secret.mp4'), Buffer.from('OUTSIDE'))
  await fs.writeFile(path.join(cacheDir, 'manifest.json'), JSON.stringify(MOVIES))
  const data = {
    authUsers: [
      { id: 'owner', name: 'Owner', username: 'owner', status: 'approved', isAdmin: true, passwordHash: auth.hashPassword('Owner-password-1') },
      { id: 'member', name: 'Member', username: 'member', status: 'approved', adult: true, passwordHash: auth.hashPassword('Member-password-1') },
      { id: 'kid', name: 'Kid', username: 'kid', status: 'approved', passwordHash: auth.hashPassword('Kid-password-12') }
    ],
    parentalControls: { kid: parental.normalizePolicy({ enabled: true, preset: 'custom', movieMax: 'PG', tvMax: 'TV-PG' }) },
    cinemaConfig: { introFile: 'Feature Presentation.mp4', folder: cinemaDir },
    watchedState: undefined
  }
  const store = { get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] }, onDidChange: () => () => {} }
  auth.forgetSecrets(); server.forgetSecrets()
  const info = server.startStreamServer({
    port: testPort(),
    store, getMoviesDir: () => moviesDir, getTvShowsDir: () => tvDir,
    getAllMoviesDirs: () => [moviesDir], getAllTvShowsDirs: () => [tvDir], getTmdbCacheDir: () => cacheDir,
    agentSecret: SECRET, log: () => {},
    autoMarkers: { startDelayMs: 3600 * 1000, intervalMs: 3600 * 1000 },
    cinema: online ? { online } : undefined
  })
  t.after(async () => { await new Promise((resolve) => info.close(resolve)); await fs.rm(root, { recursive: true, force: true }) })
  const base = 'http://127.0.0.1:' + info.port
  let ready = false
  for (let i = 0; i < 50; i++) { try { await (await fetch(base + '/api/ping')).arrayBuffer(); ready = true; break } catch { await new Promise((r) => setTimeout(r, 50)) } }
  assert.equal(ready, true, 'server started')
  const tokens = { owner: server.makeApiToken(store, 'owner'), member: server.makeApiToken(store, 'member'), kid: server.makeApiToken(store, 'kid') }
  async function api(who, route, body, extra = {}) {
    const headers = { 'Content-Type': 'application/json', ...(who ? { Authorization: 'Bearer ' + tokens[who] } : {}), ...extra }
    const r = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await r.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* not json */ }
    return { status: r.status, body: json, text, headers: r.headers }
  }
  const cookie = (who) => 'beebo_session=' + auth.signSession(store, who)
  return { base, store, api, cookie, root, id: server.encodeId('Feature (2020).mp4'), kidId: server.encodeId('Kid Feature (2021).mp4'), moviesDir }
}

function fakeOnline() {
  const details = { 11: { tmdbId: 11, title: 'Online Eleven', year: 2021, genres: [28], certification: 'PG', collectionId: null, youtubeKey: YT(11) },
    12: { tmdbId: 12, title: 'Online Twelve', year: 2021, genres: [28], certification: 'R', collectionId: null, youtubeKey: YT(12) },
    3: { tmdbId: 3, title: 'Owned Only', year: 2017, genres: [28], certification: 'PG', collectionId: null, youtubeKey: YT(3) } }
  return {
    hasKey: () => true, isReachable: () => true,
    details: async (id) => details[id] || null,
    related: async () => [{ tmdbId: 11, title: 'Online Eleven', year: 2021, popularity: 3 }, { tmdbId: 12, title: 'Online Twelve', year: 2021, popularity: 2 }],
    popular: async () => [], comingSoon: async () => ({ upcoming: [{ tmdbId: 90, title: 'Soon', releaseDate: '2027-01-01', overview: '', posterPath: null }], nowPlaying: [] })
  }
}

test('preroll: needs a signed-in person, and is OFF by default with an empty list', async (t) => {
  const f = await fixture(t)
  assert.equal((await f.api(null, '/api/playback/preroll?kind=movie&id=' + f.id)).status, 401)
  const r = await f.api('owner', '/api/playback/preroll?kind=movie&id=' + f.id)
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.enabled, false)
  assert.equal(r.body.reason, 'disabled')
  assert.deepEqual(r.body.items, [])
  assert.equal((await f.api('owner', '/api/playback/preroll?kind=movie')).status, 400, 'an id is required')
})

test('preroll contract: ordered items {type, url|videoId, title, durationSec, attribution}, intro first', async (t) => {
  const f = await fixture(t, { online: fakeOnline() })
  const set = await f.api('owner', '/api/playback/cinema', { enabled: true, count: 3 })
  assert.equal(set.status, 200)
  assert.equal(set.body.prefs.enabled, true)
  const r = await f.api('owner', '/api/playback/preroll?kind=movie&id=' + f.id)
  assert.equal(r.body.enabled, true)
  assert.equal(r.body.wants, true)
  assert.equal(r.body.skipAllowed, true)
  assert.ok(r.body.maxTrailerSeconds >= 30)
  assert.match(r.body.tmdbAttribution, /TMDB/)
  const items = r.body.items
  assert.equal(items[0].role, 'intro')
  assert.equal(items[0].type, 'local')
  assert.equal(items[0].title, 'Feature Presentation')
  const trailers = items.slice(1)
  assert.equal(trailers.length, 3)
  for (const it of items) {
    assert.ok(['local', 'youtube'].includes(it.type))
    assert.equal(typeof it.title, 'string')
    assert.equal(typeof it.attribution, 'string')
    assert.ok('durationSec' in it)
    if (it.type === 'local') assert.match(it.url, /^\/cinema\/media\/[a-f0-9]{20}\?mt=[^&\s]+$/)
    else { assert.match(it.videoId, /^[A-Za-z0-9_-]{11}$/); assert.ok(!('url' in it)) }
  }
  assert.ok(trailers.some((i) => i.type === 'local'), 'a local trailer file next to a library film')
  assert.ok(trailers.some((i) => i.type === 'youtube'), 'an online / owned-film trailer as a video id')
  assert.ok(!trailers.some((i) => i.title === 'Grown' || i.title === 'Online Twelve'), 'nothing rated R before a PG-13 film')
  assert.ok(!trailers.some((i) => i.title === 'Feature'), 'never the feature itself')
  assert.ok(!JSON.stringify(r.body).includes(f.moviesDir), 'no file path is exposed')
})

test('local files: served by signed token with ranges; a wrong token, id or path is refused', async (t) => {
  const f = await fixture(t)
  await f.api('owner', '/api/playback/cinema', { enabled: true, count: 5, sources: { online: false, owned: false } })
  const r = await f.api('owner', '/api/playback/preroll?kind=movie&id=' + f.id)
  const local = r.body.items.find((i) => i.role === 'trailer')
  assert.ok(local)
  const ok = await fetch(f.base + local.url)
  assert.equal(ok.status, 200)
  assert.match(ok.headers.get('content-type'), /^video\/mp4/)
  assert.match(await ok.text(), /TRAILER-BYTES/)
  const part = await fetch(f.base + local.url, { headers: { Range: 'bytes=0-4' } })
  assert.equal(part.status, 206)
  assert.equal((await part.text()).length, 5)
  const [pathOnly, token] = local.url.split('?mt=')
  assert.equal((await fetch(f.base + pathOnly)).status, 404, 'no token')
  assert.equal((await fetch(f.base + pathOnly + '?mt=' + token.slice(0, -2) + 'xx')).status, 404, 'tampered token')
  const other = r.body.items.find((i) => i !== local && i.type === 'local')
  if (other) assert.equal((await fetch(f.base + other.url.split('?mt=')[0] + '?mt=' + token)).status, 404, 'a token is bound to its own file')
  assert.equal((await fetch(f.base + '/cinema/media/' + 'a'.repeat(20) + '?mt=' + token)).status, 404, 'an id the server never issued')
  // raw (un-normalised) paths, as an attacker would send them
  for (const evil of ['/cinema/media/../../secret.mp4?mt=' + token, '/cinema/media/%2e%2e%2fsecret.mp4?mt=' + token, '/cinema/media/..%5c..%5csecret.mp4?mt=' + token]) {
    const body = await rawGet(f.base, evil)
    assert.ok(!body.includes('OUTSIDE'), 'no traversal: ' + evil)
  }
  assert.equal((await fetch(f.base + pathOnly + '?mt=' + token, { method: 'POST' })).status, 405)
})

test('PARENTAL GATE over HTTP: a restricted profile never gets a trailer above its limit', async (t) => {
  const f = await fixture(t, { online: fakeOnline() })
  await f.api('kid', '/api/playback/cinema', { enabled: true, count: 5 })
  await f.api('member', '/api/playback/cinema', { enabled: true, count: 5 })
  const refused = await f.api('kid', '/api/playback/preroll?kind=movie&id=' + f.id)
  assert.equal(refused.status, 404, 'the PG-13 feature itself is above this profile: the existing gate refuses it')
  const kid = await f.api('kid', '/api/playback/preroll?kind=movie&id=' + f.kidId)
  assert.equal(kid.body.enabled, true)
  const titles = kid.body.items.filter((i) => i.role === 'trailer').map((i) => i.title)
  assert.ok(titles.length >= 1, 'PG trailers are fine: ' + JSON.stringify(titles))
  for (const bad of ['Grown', 'Online Twelve', 'Feature']) assert.ok(!titles.includes(bad), bad + ' is above PG')
  assert.ok(!JSON.stringify(kid.body.items.filter((i) => i.type === 'local').map((i) => i.title)).includes('Grown'))
  const member = await f.api('member', '/api/playback/preroll?kind=movie&id=' + f.id)
  assert.ok(!member.body.items.some((i) => i.title === 'Grown'), 'even an unrestricted viewer gets nothing above the PG-13 feature')
})

test('no repeats: what the player reports as seen is not offered again', async (t) => {
  const f = await fixture(t)
  await f.api('owner', '/api/playback/cinema', { enabled: true, count: 5, sources: { online: false, owned: false }, useIntro: false })
  const first = await f.api('owner', '/api/playback/preroll?kind=movie&id=' + f.id)
  const before = first.body.items.map((i) => i.title)
  assert.ok(before.length >= 2, JSON.stringify(before))
  const gone = first.body.items[0]
  const seen = await f.api('owner', '/api/playback/preroll/seen', { items: [{ key: gone.key, titleKey: gone.titleKey }] })
  assert.equal(seen.status, 200)
  assert.equal(seen.body.ok, true)
  const second = await f.api('owner', '/api/playback/preroll?kind=movie&id=' + f.id)
  assert.ok(!second.body.items.some((i) => i.title === gone.title), gone.title + ' was just shown')
  assert.equal((await f.api('owner', '/api/playback/preroll/seen', { items: [{ key: '<img src=x onerror=alert(1)>' }] })).body.recorded, 0, 'a junk key is not stored')
  assert.equal((await f.api('owner', '/api/playback/preroll/seen', { nope: 1 })).status, 400)
  const clear = await f.api('owner', '/api/playback/cinema', { clearHistory: true })
  assert.equal(clear.status, 200)
  const third = await f.api('owner', '/api/playback/preroll?kind=movie&id=' + f.id)
  assert.ok(third.body.items.some((i) => i.title === gone.title), 'history cleared')
})

test('per-person settings: default OFF, never-show wins over "Play with pre-show", one-off ?preshow=1 works', async (t) => {
  const f = await fixture(t)
  const def = await f.api('member', '/api/playback/cinema')
  assert.equal(def.body.prefs.enabled, false)
  assert.equal(def.body.prefs.count, 2)
  const asked = await f.api('member', '/api/playback/preroll?kind=movie&preshow=1&id=' + f.id)
  assert.equal(asked.body.enabled, true, 'the Movie page toggle')
  assert.equal(asked.body.reason, 'asked')
  assert.equal((await f.api('member', '/api/playback/preroll?kind=movie&preshow=0&id=' + f.id)).body.enabled, false)
  await f.api('member', '/api/playback/cinema', { neverShow: true })
  const never = await f.api('member', '/api/playback/preroll?kind=movie&preshow=1&id=' + f.id)
  assert.equal(never.body.enabled, false)
  assert.equal(never.body.reason, 'never')
  assert.equal((await f.api('owner', '/api/playback/cinema')).body.prefs.neverShow, false, "one person's choice is not another's")
  await f.api('owner', '/api/playback/cinema', { enabled: true })
  assert.equal((await f.api('owner', '/api/playback/preroll?kind=movie&resume=1&id=' + f.id)).body.reason, 'resuming')
  const bad = await f.api('owner', '/api/playback/cinema', { count: 999, dedupeDays: -4, sources: 'x' })
  assert.equal(bad.body.prefs.count, 5)
  assert.equal(bad.body.prefs.dedupeDays, 0)
})

test('settings JSON and ids are validated: bad ids, non-JSON bodies, oversized bodies', async (t) => {
  const f = await fixture(t)
  await f.api('owner', '/api/playback/cinema', { enabled: true })
  assert.equal((await f.api('owner', '/api/playback/preroll?kind=movie&id=' + encodeURIComponent('<script>alert(1)</script>'))).body.reason, 'bad_id')
  assert.equal((await f.api('owner', '/api/playback/preroll?kind=movie&id=' + encodeURIComponent('../../etc/passwd'))).body.reason, 'bad_id')
  assert.equal((await f.api('owner', '/api/playback/preroll?kind=movie&id=' + 'A'.repeat(3000))).body.reason, 'bad_id')
  assert.equal((await f.api('owner', '/api/playback/preroll?kind=movie&id=Zm9vLm1wNA')).body.reason, 'not_found')
  const raw = await fetch(f.base + '/api/playback/cinema', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + server.makeApiToken(f.store, 'owner') }, body: '{not json' })
  assert.equal(raw.status, 400)
  const big = await f.api('owner', '/api/playback/cinema', { junk: 'x'.repeat(40000) })
  assert.equal(big.status, 400, 'an oversized body is refused')
})

test('the web routes: cookie sign-in works, and a cross-site or non-JSON POST is refused', async (t) => {
  const f = await fixture(t)
  const get = await fetch(f.base + '/playback-api/playback/preroll?kind=movie&id=' + f.id, { headers: { Cookie: f.cookie('owner') } })
  assert.equal(get.status, 200)
  assert.equal((await get.json()).reason, 'disabled')
  const ok = await fetch(f.base + '/playback-api/playback/cinema', { method: 'POST', headers: { Cookie: f.cookie('owner'), 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) })
  assert.equal(ok.status, 200)
  const plain = await fetch(f.base + '/playback-api/playback/cinema', { method: 'POST', headers: { Cookie: f.cookie('owner'), 'Content-Type': 'text/plain' }, body: JSON.stringify({ neverShow: true }) })
  assert.equal(plain.status, 415, 'a plain cross-site form cannot change the setting')
  const cross = await fetch(f.base + '/playback-api/playback/cinema', { method: 'POST', headers: { Cookie: f.cookie('owner'), 'Content-Type': 'application/json', Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' }, body: JSON.stringify({ neverShow: true }) })
  assert.equal(cross.status, 403)
  const check = await f.api('owner', '/api/playback/cinema')
  assert.equal(check.body.prefs.neverShow, false)
  const anon = await fetch(f.base + '/playback-api/playback/preroll?kind=movie&id=' + f.id, { redirect: 'manual' })
  assert.ok(anon.status === 401 || anon.status === 302 || anon.status === 403)
})

test('coming soon shelf: information only, none for a restricted profile', async (t) => {
  const f = await fixture(t, { online: fakeOnline() })
  const owner = await f.api('owner', '/api/playback/cinema/coming-soon')
  assert.equal(owner.status, 200)
  assert.equal(owner.body.upcoming[0].title, 'Soon')
  assert.ok(!('videoId' in owner.body.upcoming[0]) && !('url' in owner.body.upcoming[0]), 'no playback')
  assert.match(owner.body.attribution, /TMDB/)
  const kid = await f.api('kid', '/api/playback/cinema/coming-soon')
  assert.equal(kid.body.restricted, true)
  assert.deepEqual(kid.body.upcoming, [])
})

test('the player page carries the controller, the CSP allows only the YouTube embed, and TV pages are untouched', async (t) => {
  const f = await fixture(t)
  const page = await fetch(f.base + '/watch?id=' + f.id, { headers: { Cookie: f.cookie('owner') } })
  assert.equal(page.status, 200)
  const html = await page.text()
  assert.match(html, /\/playback\/preroll\?kind=movie/)
  assert.match(html, /youtube-nocookie\.com\/embed\//)
  assert.match(html, /"id":"[A-Za-z0-9_-]+"/)
  assert.ok(html.indexOf('id="v"') < html.indexOf('/playback/preroll?kind=movie'), 'the controller runs after the <video> exists')
  const csp = page.headers.get('content-security-policy-report-only') || ''
  assert.match(csp, /frame-src https:\/\/www\.youtube-nocookie\.com(;|$)/)
  assert.match(csp, /script-src [^;]*https:\/\/www\.youtube\.com/)
  assert.ok(!/frame-src[^;]*\*/.test(csp), 'no wildcard frames')
  assert.match(page.headers.get('content-security-policy') || '', /frame-ancestors 'self'/)
  const surf = await fetch(f.base + '/surprise/play?kind=movie', { headers: { Cookie: f.cookie('owner') }, redirect: 'manual' })
  if (surf.status === 200) assert.ok(!(await surf.text()).includes('/playback/preroll?kind=movie'), 'surf mode has no pre-show')
})

test('films the person has watched are not advertised (their own watched marks, not anyone else\'s)', async (t) => {
  const f = await fixture(t)
  await f.api('owner', '/api/playback/cinema', { enabled: true, count: 5, sources: { online: false, owned: false }, useIntro: false })
  await f.api('member', '/api/playback/cinema', { enabled: true, count: 5, sources: { online: false, owned: false }, useIntro: false })
  const before = await f.api('owner', '/api/playback/preroll?kind=movie&id=' + f.id)
  assert.ok(before.body.items.some((i) => i.title === 'Seen It'), JSON.stringify(before.body.items.map((i) => i.title)))
  const mark = await f.api('owner', '/api/watched/movie', { id: server.encodeId('Seen It (2016).mp4'), watched: true })
  assert.equal(mark.status, 200)
  const after = await f.api('owner', '/api/playback/preroll?kind=movie&id=' + f.id)
  assert.ok(!after.body.items.some((i) => i.title === 'Seen It'), 'watched by the owner: not offered to the owner')
  const other = await f.api('member', '/api/playback/preroll?kind=movie&id=' + f.id)
  assert.ok(other.body.items.some((i) => i.title === 'Seen It'), 'still offered to someone who has not watched it')
})

test('the cookie route gives a restricted profile nothing for a film above its limit', async (t) => {
  const f = await fixture(t, { online: fakeOnline() })
  await f.api('kid', '/api/playback/cinema', { enabled: true, count: 5 })
  const r = await fetch(f.base + '/playback-api/playback/preroll?kind=movie&id=' + f.id, { headers: { Cookie: f.cookie('kid') } })
  const body = await r.json()
  assert.equal(body.enabled, false)
  assert.equal(body.reason, 'not_found')
  assert.deepEqual(body.items, [])
  const own = await fetch(f.base + '/playback-api/playback/preroll?kind=movie&id=' + f.kidId, { headers: { Cookie: f.cookie('kid') } })
  assert.equal((await own.json()).enabled, true, 'a PG film is fine')
})
