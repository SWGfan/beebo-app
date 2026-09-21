import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TV_PATH, movieNightRoutes, normalizeStatus, tvUrlFromReply, isMovieNightUrl, explainFailure } from '../app/js/util/movienight.js'
import { createClient } from '../app/js/api.js'
import { createPlatform } from '../app/js/platform/platform.js'

// The Movie Night tile and contract (docs/MOVIE-NIGHT.md): the TV app asks the server for a room and opens the
// server's own page. Everything the server says is checked before the TV navigates.

const ORIGIN = 'http://192.168.1.20:47811'
const TICKET = 'aB3_dE6-gH9jK2mN5pQ8rS1tU4vW7xYz'
const good = { ok: true, code: 'K7M2QX', ticket: TICKET, tvPath: '/movie-night/tv', hash: 'k=' + TICKET, poolCount: 12 }

test('routes are the two Movie Night API calls, both under /api/movie-night', () => {
  assert.equal(movieNightRoutes.status().path, '/api/movie-night/status')
  assert.equal(movieNightRoutes.create().path, '/api/movie-night/tv/create')
  assert.equal(TV_PATH, '/movie-night/tv')
})

test('a good reply becomes the server’s own TV address with the ticket in the fragment', () => {
  const r = tvUrlFromReply(ORIGIN, good)
  assert.equal(r.ok, true)
  assert.equal(r.url, `${ORIGIN}/movie-night/tv#k=${TICKET}`)
  assert.equal(r.code, 'K7M2QX')
  // The ticket is in the fragment: the browser never sends it to the server or to a log.
  assert.ok(!r.url.includes('?'))
  assert.equal(tvUrlFromReply('https://nick.home.beebo.tv:47811', good).url, `https://nick.home.beebo.tv:47811/movie-night/tv#k=${TICKET}`)
})

test('a wrong or hostile reply never yields an address', () => {
  const bad = [
    null, undefined, 5, 'str', [], {}, { ok: false },
    { ...good, ok: 'yes' },
    { ...good, tvPath: '//evil.example/x' },
    { ...good, tvPath: 'https://evil.example/movie-night/tv' },
    { ...good, tvPath: '/movie-night/tv/../../login' },
    { ...good, tvPath: '/other' },
    { ...good, ticket: 'short' },
    { ...good, ticket: TICKET + 'x' },
    { ...good, ticket: TICKET.slice(0, 31) + '/' },
    { ...good, ticket: TICKET.slice(0, 31) + '#' },
    { ...good, hash: 'k=' + TICKET.replace('a', 'b') },
    { ...good, hash: 'k=' + TICKET + '&x=1' },
    { ...good, ticket: undefined }
  ]
  for (const b of bad) assert.equal(tvUrlFromReply(ORIGIN, b).ok, false, JSON.stringify(b))
  for (const o of ['', null, undefined, 'javascript:alert(1)', 'http://h/path', 'http://user:pw@h', 'ftp://h', 'h:47811', 'http://h?x=1']) {
    assert.equal(tvUrlFromReply(o, good).ok, false, String(o))
  }
  // a code that does not look like a code is dropped, not shown
  assert.equal(tvUrlFromReply(ORIGIN, { ...good, code: '<script>' }).code, '')
})

test('isMovieNightUrl only accepts that page on that server', () => {
  const ok = [`${ORIGIN}/movie-night/tv`, `${ORIGIN}/movie-night/tv#k=${TICKET}`]
  for (const u of ok) assert.equal(isMovieNightUrl(ORIGIN, u), true, u)
  const no = [
    'https://evil.example/movie-night/tv', `${ORIGIN}.evil.example/movie-night/tv`, `${ORIGIN}@evil.example/movie-night/tv`, `${ORIGIN}/movie-night/tv/`, `${ORIGIN}/movie-night/tv?x=1`,
    `${ORIGIN}/movie-night/tvx`, `${ORIGIN}/movie-night/tv#k=short`, `${ORIGIN}/movie-night/tv#k=${TICKET}&x`, `${ORIGIN}/login`, 'javascript:alert(1)', 'file:///x', '', null, undefined, 5
  ]
  for (const u of no) assert.equal(isMovieNightUrl(ORIGIN, u), false, String(u))
  assert.equal(isMovieNightUrl(null, `${ORIGIN}/movie-night/tv`), false)
})

test('status replies are shown safely', () => {
  assert.deepEqual(normalizeStatus({ ok: true, available: true }), { available: true, reason: '', message: '' })
  const s = normalizeStatus({ available: false, reason: 'home_only', message: 'Movie Night works on the home Wi-Fi.‮<b>' })
  assert.equal(s.available, false)
  assert.equal(s.reason, 'home_only')
  assert.ok(!s.message.includes('‮'))
  assert.equal(normalizeStatus(null).available, false)
  assert.equal(normalizeStatus({ available: 'true' }).available, false, 'only a real true counts')
  assert.ok(normalizeStatus({ message: 'x'.repeat(999) }).message.length <= 200)
})

test('failures are explained in plain words', () => {
  assert.match(explainFailure({ status: 401 }), /signed in/)
  assert.match(explainFailure({ status: 403 }), /Wi-Fi/)
  assert.match(explainFailure({ status: 404 }), /not available/)
  assert.match(explainFailure({ status: 429 }), /Wait/)
  assert.equal(explainFailure({ status: 403, body: { message: 'The owner turned it off.' } }), 'The owner turned it off.')
  assert.equal(explainFailure({ friendly: 'Offline!' }), 'Offline!')
  assert.equal(explainFailure(null), 'Could not start Movie Night.')
})

function fakeXHR(handler) {
  const seen = []
  class X {
    constructor() { this.headers = {}; this.status = 0; this.responseText = '' }
    open(method, url) { this.method = method; this.url = url }
    setRequestHeader(k, v) { this.headers[k] = v }
    send(body) {
      seen.push(this); this.body = body
      const r = handler(this)
      setTimeout(() => { this.status = r.status; this.responseText = JSON.stringify(r.body); this.onload() }, 0)
    }
  }
  X.seen = seen
  return X
}
const mk = (handler) => {
  const XHR = fakeXHR(handler)
  return { XHR, client: createClient({ XHR, getOrigin: () => ORIGIN, getToken: () => 'SECRET-TOKEN' }) }
}

test('the client starts a room with the bearer token in the header, and returns the address', async () => {
  const { client, XHR } = mk(() => ({ status: 200, body: good }))
  const r = await client.movieNightStart()
  assert.equal(r.url, `${ORIGIN}/movie-night/tv#k=${TICKET}`)
  const x = XHR.seen[0]
  assert.equal(x.method, 'POST')
  assert.equal(x.url, `${ORIGIN}/api/movie-night/tv/create`)
  assert.equal(x.headers.Authorization, 'Bearer SECRET-TOKEN')
  assert.ok(!x.url.includes('SECRET-TOKEN'))
  assert.deepEqual(JSON.parse(x.body), {})
})

test('the client refuses a reply that would take the TV anywhere else', async () => {
  const { client } = mk(() => ({ status: 200, body: { ...good, tvPath: 'https://evil.example/x' } }))
  await assert.rejects(client.movieNightStart(), (e) => e.kind === 'bad_response')
})

test('errors keep the server’s status and message so the screen can explain them', async () => {
  const off = mk(() => ({ status: 404, body: { ok: false, error: 'disabled', message: 'Movie Night is turned off on this server.' } }))
  await assert.rejects(off.client.movieNightStart(), (e) => e.status === 404 && explainFailure(e) === 'Movie Night is turned off on this server.')
  const away = mk(() => ({ status: 403, body: { ok: false, error: 'home_only' } }))
  await assert.rejects(away.client.movieNightStart(), (e) => e.status === 403)
  const st = mk(() => ({ status: 200, body: { ok: true, enabled: true, available: false, reason: 'home_only', message: 'Home Wi-Fi only.' } }))
  assert.deepEqual(await st.client.movieNightStatus(), { available: false, reason: 'home_only', message: 'Home Wi-Fi only.' })
})

test('the platform opens only Movie Night’s page on the chosen server', async () => {
  const opened = []
  globalThis.window = { location: { assign: (u) => opened.push(u) } }
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120' }, configurable: true, writable: true })
  try {
    const p = createPlatform()
    assert.equal(p.openMovieNight(ORIGIN, `${ORIGIN}/movie-night/tv#k=${TICKET}`), true)
    assert.equal(p.openMovieNight(ORIGIN, 'https://evil.example/movie-night/tv'), false)
    assert.equal(p.openMovieNight(ORIGIN, `${ORIGIN}/login`), false)
    assert.equal(p.openMovieNight(ORIGIN, 'javascript:alert(1)'), false)
    assert.deepEqual(opened, [`${ORIGIN}/movie-night/tv#k=${TICKET}`])
  } finally { delete globalThis.window; delete globalThis.navigator }
})

test('the only navigation in the app is that one guarded call', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'app', 'js')
  const hits = []
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) { const s = fs.readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''); if (/location\.(assign|replace)\s*\(/.test(s)) hits.push(path.relative(root, p).replace(/\\/g, '/')) } } }
  walk(root)
  assert.deepEqual(hits, ['platform/platform.js'])
  const src = fs.readFileSync(path.join(root, 'platform', 'platform.js'), 'utf8')
  assert.match(src, /if \(!isMovieNightUrl\(origin, url\)\) return false\s*\n\s*try \{ window\.location\.assign\(url\)/, 'the navigation sits directly behind the check')
})

test('the Home screen has the tile and the router has the screen', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'app', 'js')
  const home = fs.readFileSync(path.join(root, 'screens', 'home.js'), 'utf8')
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
  assert.match(home, /makeRail\('party', 'Movie Night'\)/)
  assert.match(home, /ctx\.router\.push\('movienight'\)/)
  assert.match(main, /movienight: movienight/)
})
