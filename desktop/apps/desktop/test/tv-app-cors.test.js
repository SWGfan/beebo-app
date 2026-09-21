'use strict'
// Opt-in CORS for packaged TV apps (file:// pages send `Origin: null`). See electron/corsPolicy.js
// and docs/TV-APP-CORS.md. Setting `tvAppCors`, default OFF.
//
// Run: node --test test/tv-app-cors.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const crypto = require('node:crypto')
const server = require('../electron/streamServer')
const auth = require('../electron/auth')
const cors = require('../electron/corsPolicy')
const desktopSettingsPolicy = require('../electron/desktopSettingsPolicy')

const PASSWORD = 'Tv-app-cors-test-password-9'
const AGENT_SECRET = crypto.randomBytes(32).toString('hex')
let seq = 0

// Each of these is a route the TV app calls (or may call); the second column is a concrete path.
const ALLOWED = [
  '/api/ping', '/api/login', '/api/viewer-session', '/api/v1', '/api/v1/library/movies', '/api/continue',
  '/api/recently-added', '/api/tvshows', '/api/tvshows/abc', '/api/movies', '/api/movies/x/y',
  '/api/playlists', '/api/playlists/p1', '/api/playback/info', '/api/playback/start', '/api/watch-session',
  '/api/progress', '/api/markers', '/api/me', '/api/upnext', '/api/episode-context', '/api/ping/'
]
const DISALLOWED = [
  '/api/admin/summary', '/api/admin/settings', '/api/admin/users/approve', '/api/admin', '/api/me/delete',
  '/api/private-vault', '/api/parental/unlock', '/api/school/report', '/api/remote-session', '/api/movie-version',
  '/api/moviesX', '/api/movies%2F..%2Fadmin', '/api/license/status', '/api/history', '/api/favorites',
  '/api/profiles/switch', '/api/photos', '/api/music', '/api/party/start', '/api/viewing-privacy', '/api/tvshowsX',
  '/api', '/', '/admin', '/login', '/file', '/tvfile', '/health'
]
const ORIGINS = ['null', 'https://tv.example.test', 'file://', 'http://192.168.1.50:8080']

function users() {
  const base = { status: 'approved', adult: true, passwordHash: auth.hashPassword(PASSWORD) }
  return [
    { id: 'owner', name: 'Owner', username: 'owner', isAdmin: true, ...base },
    { id: 'robin', name: 'Robin', username: 'robin', ...base }
  ]
}

async function boot(t, { tvAppCors, license } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-tv-cors-'))
  const data = { authUsers: users(), ...(tvAppCors === undefined ? {} : { tvAppCors }) }
  const store = { data, get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] }, onDidChange: () => () => {} }
  auth.forgetSecrets(); server.forgetSecrets()
  const info = server.startStreamServer({
    port: 45400 + (process.pid % 900) + ++seq, store, getMoviesDir: () => root, getTvShowsDir: () => root,
    getAllMoviesDirs: () => [root], getAllTvShowsDirs: () => [], log: () => {},
    agentSecret: AGENT_SECRET, ...(license ? { license } : {})
  })
  t.after(async () => { await new Promise((r) => info.close(r)); fs.rmSync(root, { recursive: true, force: true }) })
  const port = info.port
  for (let i = 0; i < 60; i++) {
    try { await raw(port, 'GET', '/api/ping'); break } catch { await new Promise((r) => setTimeout(r, 100)) }
  }
  const token = server.makeApiToken(store, 'owner')
  const cookie = 'beebo_session=' + auth.signSession(store, 'owner')
  return { port, store, token, cookie, req: (method, p, headers, body) => raw(port, method, p, headers, body) }
}

// node:http, so Origin / Cookie / OPTIONS are sent exactly as given.
function raw(port, method, p, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { ...headers, ...(body !== undefined ? { 'content-length': Buffer.byteLength(body) } : {}) } }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try { json = JSON.parse(text) } catch { json = null }
        resolve({ status: res.statusCode, headers: res.headers, text, json })
      })
    })
    r.on('error', reject)
    if (body !== undefined) r.write(body)
    r.end()
  })
}

const corsHeaderNames = (h) => Object.keys(h).filter((k) => k.startsWith('access-control-'))
const bearer = (s) => ({ authorization: 'Bearer ' + s.token })

// ------------------------------------------------------------------ setting OFF (the default)

test('setting off (default): no CORS headers on any route, and OPTIONS behaves as it always did', async (t) => {
  for (const setting of [undefined, false]) {
    const s = await boot(t, { tvAppCors: setting })
    for (const p of [...ALLOWED, ...DISALLOWED]) {
      for (const origin of ['null', 'https://tv.example.test']) {
        const r = await s.req('GET', p, { origin, ...bearer(s) })
        assert.deepEqual(corsHeaderNames(r.headers), [], `GET ${p} (${origin}) must carry no CORS headers`)
        assert.ok(!/origin/i.test(String(r.headers.vary || '')), `GET ${p}: no Vary: Origin`)
      }
      const pre = await s.req('OPTIONS', p, { origin: 'null', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization' })
      assert.deepEqual(corsHeaderNames(pre.headers), [], `OPTIONS ${p} must carry no CORS headers`)
      if (p.startsWith('/api')) assert.equal(pre.status, 204, `OPTIONS ${p} keeps today's plain 204 (Allow: ...)`)
    }
    const plain = await s.req('OPTIONS', '/api/ping', {})
    assert.equal(plain.status, 204)
    assert.equal(plain.headers.allow, 'GET, HEAD, POST, OPTIONS')
  }
})

test('the setting is a whitelisted boolean; anything else is refused', () => {
  const store = { data: {}, set(k, v) { this.data[k] = v } }
  assert.equal(desktopSettingsPolicy.writeSettings(store, { tvAppCors: true }), true)
  assert.equal(store.data.tvAppCors, true)
  for (const bad of ['yes', 1, null, {}, 'true']) {
    assert.throws(() => desktopSettingsPolicy.writeSettings(store, { tvAppCors: bad }), /dedicated Beebo controls/)
  }
})

// ------------------------------------------------------------------ setting ON: the allow-list

test('setting on: allowed routes echo the Origin (including null) with Vary: Origin and never Allow-Credentials', async (t) => {
  const s = await boot(t, { tvAppCors: true })
  for (const p of ALLOWED) {
    for (const origin of ORIGINS) {
      const r = await s.req('GET', p, { origin, ...bearer(s) })
      assert.equal(r.headers['access-control-allow-origin'], origin, `GET ${p} (${origin})`)
      assert.match(String(r.headers.vary || ''), /\bOrigin\b/i, `GET ${p}: Vary: Origin`)
      assert.equal(r.headers['access-control-allow-credentials'], undefined, `GET ${p}: never Allow-Credentials`)
      assert.notEqual(r.headers['access-control-allow-origin'], '*')
    }
  }
})

test('setting on: an error answer is readable too (401 without a token, 405), so a TV app can show why', async (t) => {
  const s = await boot(t, { tvAppCors: true })
  const noToken = await s.req('GET', '/api/me', { origin: 'null' })
  assert.equal(noToken.status, 401)
  assert.equal(noToken.headers['access-control-allow-origin'], 'null')
  const wrongMethod = await s.req('GET', '/api/login', { origin: 'null' })
  assert.equal(wrongMethod.status, 405)
  assert.equal(wrongMethod.headers['access-control-allow-origin'], 'null')
})

test('setting on: every route that is not on the list gets no CORS headers, admin routes above all', async (t) => {
  const s = await boot(t, { tvAppCors: true })
  for (const p of DISALLOWED) {
    for (const origin of ['null', 'https://tv.example.test']) {
      const r = await s.req('GET', p, { origin, ...bearer(s) })
      assert.deepEqual(corsHeaderNames(r.headers), [], `GET ${p} (${origin}) must not get CORS headers`)
    }
  }
  // The admin API answers an admin's Bearer token normally; it just never gets CORS.
  const admin = await s.req('GET', '/api/admin/summary', { origin: 'null', ...bearer(s) })
  assert.notEqual(admin.status, 404)
  assert.equal(admin.headers['access-control-allow-origin'], undefined)
})

test('setting on: no Origin header means no CORS headers (an ordinary non-browser client)', async (t) => {
  const s = await boot(t, { tvAppCors: true })
  for (const p of ALLOWED) {
    const r = await s.req('GET', p, { ...bearer(s) })
    assert.deepEqual(corsHeaderNames(r.headers), [], p)
  }
})

test('setting on: a request that carries the session COOKIE without a Bearer token gets no CORS headers', async (t) => {
  const s = await boot(t, { tvAppCors: true })
  for (const p of ALLOWED) {
    const r = await s.req('GET', p, { origin: 'https://evil.example.test', cookie: s.cookie })
    assert.deepEqual(corsHeaderNames(r.headers), [], `cookie-only ${p} must not be readable cross-origin`)
    const nullOrigin = await s.req('GET', p, { origin: 'null', cookie: s.cookie })
    assert.deepEqual(corsHeaderNames(nullOrigin.headers), [], `cookie-only ${p} from a null origin`)
  }
  // A cookie next to a real Bearer token is a TV app that also happens to hold a cookie: no credentials
  // header is ever sent, so a browser will not use the cookie cross-origin anyway.
  const both = await s.req('GET', '/api/me', { origin: 'null', cookie: s.cookie, ...bearer(s) })
  assert.equal(both.headers['access-control-allow-origin'], 'null')
  assert.equal(both.headers['access-control-allow-credentials'], undefined)
  // A cookie header that is empty is not a cookie.
  const empty = await s.req('GET', '/api/ping', { origin: 'null', cookie: '' })
  assert.equal(empty.headers['access-control-allow-origin'], 'null')
})

test('setting on: an Origin that is not an origin is never echoed', async (t) => {
  const s = await boot(t, { tvAppCors: true })
  for (const origin of ['*', 'javascript:alert(1)//x y', 'https://a.example, https://b.example', 'https://ok.example/path', 'not an origin', 'NULL ']) {
    const r = await s.req('GET', '/api/ping', { origin })
    if (origin === 'NULL ') assert.equal(r.headers['access-control-allow-origin'], 'NULL', 'trimmed and echoed as sent')
    else assert.equal(r.headers['access-control-allow-origin'], undefined, JSON.stringify(origin))
  }
})

// ------------------------------------------------------------------ preflight

test('setting on: preflight answers 204 with exactly the right headers for allowed routes', async (t) => {
  const s = await boot(t, { tvAppCors: true })
  for (const p of ALLOWED) {
    for (const origin of ORIGINS) {
      const r = await s.req('OPTIONS', p, { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type' })
      assert.equal(r.status, 204, `${p} (${origin})`)
      assert.equal(r.headers['access-control-allow-origin'], origin)
      assert.equal(r.headers['access-control-allow-headers'], 'authorization, content-type, x-beebo-client, x-beebo-download')
      assert.equal(r.headers['access-control-allow-methods'], 'GET, POST, OPTIONS')
      assert.equal(r.headers['access-control-max-age'], '600')
      assert.match(String(r.headers.vary), /\bOrigin\b/i)
      assert.equal(r.headers['access-control-allow-credentials'], undefined, 'never credentials')
      assert.equal(r.text, '')
    }
  }
})

test('setting on: preflight for a route that is not allowed is 404 with no CORS headers; admin routes never', async (t) => {
  const s = await boot(t, { tvAppCors: true })
  for (const p of DISALLOWED.filter((x) => x.startsWith('/api'))) {
    const r = await s.req('OPTIONS', p, { origin: 'null', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization' })
    assert.equal(r.status, 404, p)
    assert.deepEqual(corsHeaderNames(r.headers), [], p)
  }
  // Outside /api a preflight is not ours to answer: it falls through to the normal server, still without CORS.
  for (const p of ['/', '/file', '/tvfile']) {
    const r = await s.req('OPTIONS', p, { origin: 'null', 'access-control-request-method': 'GET' })
    assert.equal(r.headers['access-control-allow-origin'], undefined, p)
  }
})

test('setting on: a plain OPTIONS with no Origin, or a preflight carrying a cookie, is not treated as CORS', async (t) => {
  const s = await boot(t, { tvAppCors: true })
  const plain = await s.req('OPTIONS', '/api/ping', {})
  assert.equal(plain.status, 204)
  assert.equal(plain.headers.allow, 'GET, HEAD, POST, OPTIONS')
  assert.deepEqual(corsHeaderNames(plain.headers), [])
  const withCookie = await s.req('OPTIONS', '/api/ping', { origin: 'null', cookie: s.cookie, 'access-control-request-method': 'GET' })
  assert.deepEqual(corsHeaderNames(withCookie.headers), [])
})

test('setting on: the preflight is answered before the license gate, and a gated answer still carries CORS so the TV can explain it', async (t) => {
  const lapsed = { evaluate: () => ({ enforced: true, serve: false, state: 'expired', payload: {} }) }
  const s = await boot(t, { tvAppCors: true, license: lapsed })
  const pre = await s.req('OPTIONS', '/api/login', { origin: 'null', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' })
  assert.equal(pre.status, 204)
  assert.equal(pre.headers['access-control-allow-origin'], 'null')
  // Through Beebo's own relay (the agent, path relay-beebo) a lapsed plan is a 402; the answer must be readable.
  const gated = await s.req('GET', '/api/me', { origin: 'null', ...bearer(s), 'x-beebo-agent-key': AGENT_SECRET, 'x-beebo-remote-path': 'relay-beebo' })
  assert.equal(gated.status, 402)
  assert.equal(gated.json.error, 'remote_requires_plan')
  assert.equal(gated.headers['access-control-allow-origin'], 'null')
})

// ------------------------------------------------------------------ login from a file:// page

test('POST /api/login from origin null: a JSON body signs in as today, the token is readable, wrong passwords are readable 401s', async (t) => {
  const s = await boot(t, { tvAppCors: true })
  const pre = await s.req('OPTIONS', '/api/login', { origin: 'null', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' })
  assert.equal(pre.status, 204)
  const ok = await s.req('POST', '/api/login', { origin: 'null', 'content-type': 'application/json' }, JSON.stringify({ username: 'robin', password: PASSWORD }))
  assert.equal(ok.status, 200, ok.text)
  assert.equal(ok.headers['access-control-allow-origin'], 'null')
  assert.equal(ok.headers['access-control-allow-credentials'], undefined)
  assert.equal(ok.json.ok, true)
  assert.equal(ok.json.user.id, 'robin')
  assert.equal(ok.headers['set-cookie'], undefined, 'the API login sets no cookie: only the Bearer token is usable cross-origin')
  const me = await s.req('GET', '/api/me', { origin: 'null', authorization: 'Bearer ' + ok.json.token })
  assert.equal(me.status, 200)
  assert.equal(me.headers['access-control-allow-origin'], 'null')

  const bad = await s.req('POST', '/api/login', { origin: 'null', 'content-type': 'application/json' }, JSON.stringify({ username: 'robin', password: 'wrong' }))
  assert.equal(bad.status, 401)
  assert.equal(bad.json.error, 'bad_credentials')
  assert.equal(bad.headers['access-control-allow-origin'], 'null')
  // Not a JSON object, or no credentials: nothing signs in, exactly as today.
  for (const body of ['not json at all', '[]', '{}', '']) {
    const r = await s.req('POST', '/api/login', { origin: 'null', 'content-type': 'application/json' }, body)
    assert.equal(r.status, 401, JSON.stringify(body))
  }
})

test('setting off: the very same file:// login still works for a client that does not care about CORS, with no CORS headers', async (t) => {
  const s = await boot(t, { tvAppCors: false })
  const ok = await s.req('POST', '/api/login', { origin: 'null', 'content-type': 'application/json' }, JSON.stringify({ username: 'robin', password: PASSWORD }))
  assert.equal(ok.status, 200)
  assert.deepEqual(corsHeaderNames(ok.headers), [], 'a browser would refuse to hand this answer to the page')
})

test('the setting takes effect on the next request without a restart, and turning it off removes every header', async (t) => {
  const s = await boot(t, { tvAppCors: false })
  assert.equal((await s.req('GET', '/api/ping', { origin: 'null' })).headers['access-control-allow-origin'], undefined)
  s.store.set('tvAppCors', true)
  assert.equal((await s.req('GET', '/api/ping', { origin: 'null' })).headers['access-control-allow-origin'], 'null')
  s.store.set('tvAppCors', 'true') // only the real boolean counts
  assert.equal((await s.req('GET', '/api/ping', { origin: 'null' })).headers['access-control-allow-origin'], undefined)
  s.store.set('tvAppCors', false)
  const r = await s.req('OPTIONS', '/api/ping', { origin: 'null', 'access-control-request-method': 'GET' })
  assert.deepEqual(corsHeaderNames(r.headers), [])
})

test('media routes (/hls/...) authenticate with a ticket in the URL and carry their own wildcard CORS, unchanged by the setting', async (t) => {
  for (const setting of [false, true]) {
    const s = await boot(t, { tvAppCors: setting })
    const pre = await s.req('OPTIONS', '/hls/AAAAAAAAAAAA/index.m3u8', { origin: 'null', 'access-control-request-method': 'GET' })
    assert.equal(pre.status, 204)
    assert.equal(pre.headers['access-control-allow-origin'], '*')
    assert.equal(pre.headers['access-control-allow-credentials'], undefined)
    const bad = await s.req('GET', '/hls/AAAAAAAAAAAA/index.m3u8', { origin: 'null', cookie: s.cookie })
    assert.equal(bad.status, 403, 'a cookie is no ticket')
    assert.equal(bad.headers['access-control-allow-origin'], '*')
  }
})

// ------------------------------------------------------------------ the pure policy

test('corsPolicy: route allow-list matches whole path segments only', () => {
  for (const p of ALLOWED) assert.equal(cors.routeAllowed(p), true, p)
  for (const p of DISALLOWED) assert.equal(cors.routeAllowed(p), false, p)
  assert.equal(cors.routeAllowed('/api/v10'), false)
  assert.equal(cors.routeAllowed('/API/ping'), false, 'paths are case-sensitive, like the server')
})

test('corsPolicy: cleanOrigin accepts only origins', () => {
  for (const ok of ['null', 'file://', 'https://a.example', 'http://10.0.0.5:47811', 'app://tv']) assert.equal(cors.cleanOrigin(ok), ok)
  for (const bad of ['', '*', ' ', 'a b', 'https://a.example/x', 'https://a.example?x=1', 'https://a\\b', 'x'.repeat(400), undefined, null, 5]) assert.equal(cors.cleanOrigin(bad), '', String(bad))
})

test('corsPolicy: a route that sets its own Vary through writeHead cannot drop Vary: Origin', () => {
  const written = []
  const headers = {}
  const res = {
    setHeader: (k, v) => { headers[k.toLowerCase()] = v },
    getHeader: (k) => headers[k.toLowerCase()],
    writeHead(status, ...rest) { written.push({ status, rest }) }
  }
  const policy = cors.create({ isEnabled: () => true })
  const req = { method: 'GET', headers: { origin: 'null' } }
  assert.equal(policy.intercept(req, res, new URL('http://x/api/movies')), false)
  assert.equal(headers['access-control-allow-origin'], 'null')
  const shared = { Vary: 'Accept-Encoding', 'Content-Type': 'application/json' }
  res.writeHead(200, shared)
  assert.equal(written[0].rest[0].Vary, 'Accept-Encoding, Origin')
  assert.equal(shared.Vary, 'Accept-Encoding', 'the route\'s own (shared) header object is not mutated')
  assert.equal(policy.intercept({ method: 'GET', headers: {} }, res, new URL('http://x/api/movies')), false)
})

test('corsPolicy: off means off, and a throwing setting reader means off', () => {
  const res = { setHeader() { throw new Error('must not be touched') }, writeHead() { throw new Error('must not be touched') } }
  const req = { method: 'OPTIONS', headers: { origin: 'null', 'access-control-request-method': 'POST' } }
  for (const isEnabled of [undefined, () => false, () => 'yes', () => { throw new Error('boom') }]) {
    assert.equal(cors.create({ isEnabled }).intercept(req, res, new URL('http://x/api/login')), false)
  }
})
