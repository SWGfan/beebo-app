// Security review F5 (cookie flags + lifetime), F6 (cross-site guard on cookie writes), F7 (constant
// time compares, hashed reset/verify tokens), F11 (Host allowlist) and the response-header wrapper.
// Run: node --test test/http-security.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { withServer, localRequire } = require('./security-harness')
const hs = localRequire('./electron/httpSecurity')
const auth = localRequire('./electron/auth')

const DAY = 86400000

// ---------------------------------------------------------------- Host (F11) ----

test('hostnameOf normalises and rejects junk', () => {
  assert.equal(hs.hostnameOf('Foo.Example:47811'), 'foo.example')
  assert.equal(hs.hostnameOf('[::1]:80'), '::1')
  assert.equal(hs.hostnameOf('192.168.1.5:47811'), '192.168.1.5')
  assert.equal(hs.hostnameOf('evil.com/path'), '')
  assert.equal(hs.hostnameOf('a b'), '')
  assert.equal(hs.hostnameOf('x.example:abc'), '')
  assert.equal(hs.hostnameOf(''), '')
  assert.equal(hs.hostnameOf('a.example, b.example'), 'a.example', 'a list keeps only the first')
})

test('host policy: our names, LAN and loopback pass; unknown public names do not', () => {
  const settings = {}
  const policy = hs.createHostPolicy({
    getPublicName: () => 'Nick', getCertDomain: () => 'nickhome.duckdns.org', getMachineName: () => 'NICK-PC',
    getPublicBaseUrl: () => settings.base, getExtraHosts: () => settings.extra, env: {}
  })
  const ok = ['127.0.0.1:47811', 'localhost:47811', '[::1]:47811', '192.168.1.20:47811', '10.0.0.4', '100.101.102.103:47811',
    'nick.beebo.tv', 'nick.home.beebo.tv:443', 'NICK.beebo.tv', 'nickhome.duckdns.org:47811', 'nick-pc:47811', 'nick-pc.local', 'mypc', 'box.ts.net', '']
  for (const h of ok) assert.equal(policy.isKnown(h), true, h)
  const bad = ['evil.example', 'evil.example:47811', 'other.beebo.tv', 'nick.beebo.tv.evil.example', 'beebo.tv.evil.com', 'a b', 'x.example/y']
  for (const h of bad) assert.equal(policy.isKnown(h), false, h)
  settings.base = 'https://media.example.com'
  assert.equal(policy.isKnown('media.example.com'), true, 'configured public base')
  assert.equal(policy.configuredBase().origin, 'https://media.example.com')
  settings.extra = ['plex.myhouse.net']
  assert.equal(policy.isKnown('plex.myhouse.net:8443'), true, 'allowedHosts')
  // With no registered name yet, the service domain is accepted rather than locking the owner out.
  const fresh = hs.createHostPolicy({ getMachineName: () => 'x', env: {} })
  assert.equal(fresh.isKnown('someone.beebo.tv'), true)
  assert.equal(fresh.isKnown('evil.example'), false)
  assert.equal(hs.createHostPolicy({ getMachineName: () => 'x', env: { BEEBO_ALLOWED_HOSTS: 'a.example, b.example' } }).isKnown('b.example'), true)
})

test('trustedOrigin / redirectHost / safeRequestPath never echo a foreign Host', () => {
  const policy = hs.createHostPolicy({ getPublicName: () => 'nick', getCertDomain: () => 'nickhome.duckdns.org', getMachineName: () => 'x', env: {} })
  const req = (host, extra = {}) => ({ headers: { host, ...extra }, socket: {} })
  assert.equal(hs.trustedOrigin(policy, req('192.168.1.20:47811')), 'http://192.168.1.20:47811')
  assert.equal(hs.trustedOrigin(policy, req('nick.beebo.tv', { 'x-forwarded-proto': 'https' })), 'https://nick.beebo.tv')
  assert.equal(hs.trustedOrigin(policy, req('evil.example', { 'x-forwarded-host': 'evil.example' })), '')
  assert.equal(hs.trustedOrigin(policy, req('127.0.0.1:47811')), '', 'a loopback link is no use to another device')
  assert.equal(hs.redirectHost(policy, 'nickhome.duckdns.org:47811', 'nickhome.duckdns.org', 47811), 'nickhome.duckdns.org:47811')
  assert.equal(hs.redirectHost(policy, 'evil.example:47811', 'nickhome.duckdns.org', 47811), 'nickhome.duckdns.org:47811')
  assert.equal(hs.redirectHost(policy, 'evil.example', '', 47811), '', 'no configured domain: no redirect at all')
  assert.equal(hs.safeRequestPath('/a/b?c=1'), '/a/b?c=1')
  for (const bad of ['//evil.example/x', 'http://evil.example/', '\\\\evil', '/x\r\nSet-Cookie: a=b']) assert.equal(hs.safeRequestPath(bad), '/', bad)
})

// --------------------------------------------------------------- cookies (F5) ----

test('cookie flags: HttpOnly + SameSite=Lax always, Secure whenever the client is on TLS', () => {
  const plain = { headers: {}, socket: {} }
  const tls = { headers: {}, socket: { encrypted: true } }
  const proxied = { headers: { 'x-forwarded-proto': 'https' }, socket: {} }
  const c = hs.buildCookie(plain, 'beebo_session', 'v', { maxAge: 90 * 86400 })
  assert.equal(c, 'beebo_session=v; Path=/; Max-Age=7776000; HttpOnly; SameSite=Lax')
  assert.match(hs.buildCookie(tls, 'beebo_session', 'v'), /; HttpOnly; SameSite=Lax; Secure$/)
  assert.match(hs.buildCookie(proxied, 'beebo_session', 'v'), /; Secure$/)
  assert.match(hs.buildCookie(tls, 'x', '', { maxAge: 0 }), /Max-Age=0/)
})

test('login and logout Set-Cookie headers over the wire: HttpOnly, SameSite=Lax, Secure behind TLS, 365-day name contract unchanged', async () => {
  await withServer({}, async ({ raw, store, auth: a }) => {
    // A real password sign-in (the harness owner has only a legacy code): signup -> verify -> login.
    const made = a.createSignup(store, { username: 'cookieperson', email: 'cookie@example.com', password: 'a-long-test-passphrase-1' })
    assert.ok(made.token, JSON.stringify(made))
    assert.equal(a.verifySignupToken(store, made.token).ok, true)
    const login = (headers = {}) => raw({ method: 'POST', pathname: '/login', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: 'username=cookieperson&password=a-long-test-passphrase-1' })
    let r = await login()
    assert.equal(r.status, 302)
    let sc = [].concat(r.headers['set-cookie'] || []).find((c) => c.startsWith('beebo_session='))
    assert.ok(sc, 'session cookie set')
    assert.match(sc, /^beebo_session=[^;]+; Path=\/; Max-Age=31536000; HttpOnly; SameSite=Lax$/, 'plain http: no Secure flag, so LAN logins keep working')
    r = await login({ 'x-forwarded-proto': 'https' })
    sc = [].concat(r.headers['set-cookie'] || []).find((c) => c.startsWith('beebo_session='))
    assert.match(sc, /; HttpOnly; SameSite=Lax; Secure$/, 'behind a TLS proxy the cookie is Secure')

    r = await raw({ pathname: '/logout' })
    assert.equal(r.status, 302)
    assert.match(r.headers['set-cookie'][0], /^beebo_session=; Path=\/; Max-Age=0; HttpOnly; SameSite=Lax$/)
    r = await raw({ pathname: '/logout', headers: { 'x-forwarded-proto': 'https' } })
    assert.match(r.headers['set-cookie'][0], /; Secure$/)
  })
})

// ------------------------------------------------------------- tokens (F7) ----

test('reset and verify tokens: only a hash is stored, matching is constant-time, legacy raw tokens still work', () => {
  const data = {}
  const store = { get: (k) => data[k], set: (k, v) => { data[k] = v } }
  const { user } = auth.createUser(store, 'Owner', 'owner@example.com')
  const reset = auth.createPasswordResetToken(store, 'owner@example.com')
  assert.match(reset.token, /^[0-9a-f]{48}$/)
  assert.equal(JSON.stringify(store.get('authUsers')).includes(reset.token), false, 'the raw reset token is not in the store')
  const flip = (t) => t.replace(/.$/, (c) => (c === '0' ? '1' : '0'))
  assert.equal(auth.resetPasswordWithToken(store, flip(reset.token), 'a-long-test-passphrase-1').ok, false)
  assert.equal(auth.resetPasswordWithToken(store, auth.hashResetToken(reset.token), 'a-long-test-passphrase-1').ok, false, 'the stored hash is not itself a token')
  assert.equal(auth.resetPasswordWithToken(store, reset.token, 'a-long-test-passphrase-1').ok, true)
  assert.equal(auth.resetPasswordWithToken(store, reset.token, 'another-long-passphrase-2').ok, false, 'single use')

  const signup = auth.createSignup(store, { username: 'newperson', email: 'n@example.com', password: 'a-long-test-passphrase-1' })
  const u2 = store.get('authUsers').find((u) => u.username === 'newperson')
  assert.notEqual(u2.verifyToken, signup.token, 'the verify token is stored hashed')
  assert.equal(JSON.stringify(store.get('authUsers')).includes(signup.token), false, 'the raw verify token is not in the store')
  assert.equal(auth.verifySignupToken(store, flip(signup.token)).ok, false)
  assert.equal(auth.verifySignupToken(store, signup.token).ok, true)
  // A verify token stored raw by an older build keeps working until used.
  const legacyToken = 'ab'.repeat(24)
  const s3 = auth.createSignup(store, { username: 'legacyperson', email: 'l@example.com', password: 'a-long-test-passphrase-1' })
  store.set('authUsers', store.get('authUsers').map((u) => (u.username === 'legacyperson' ? { ...u, verifyToken: legacyToken } : u)))
  assert.equal(auth.verifySignupToken(store, legacyToken).ok, true)
  void s3; void user
  assert.equal(hs.safeEqual('abc', 'abc'), true)
  assert.equal(hs.safeEqual('abc', 'abd'), false)
  assert.equal(hs.safeEqual('abc', 'abcd'), false)
  assert.equal(hs.safeEqual(undefined, ''), true)
})

test('no plain === on secrets in the report-PIN paths', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'electron', 'streamServer.js'), 'utf8')
  assert.equal(/sig === good/.test(src), false)
  assert.equal(/digest\('hex'\) === h\b/.test(src), false)
})

// --------------------------------------------- cookie writes (F6) + Host (F11) ----

const streamSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'streamServer.js'), 'utf8')
// Every "url.pathname === '/x' && req.method === 'POST'" route in the cookie section of the server.
const discoveredPosts = [...new Set([...streamSrc.matchAll(/url\.pathname === '(\/[^']*)' && req\.method === 'POST'/g)].map((m) => m[1]).filter((p) => !p.startsWith('/api/')))] // /api/* is Bearer-token auth, not the cookie
const KNOWN_POSTS = ['/history/clear', '/library/clear', '/upload/delete', '/upload/begin', '/upload/chunk', '/upload/finish', '/upload/cancel', '/upload',
  '/flag-unplayable', '/flag-quality', '/markers', '/progress', '/missing-request', '/heartbeat', '/school/report/clear', '/playlists/api/x/progress',
  '/playback-api/playback/x', '/music-api/recordings']
const STRICT = new Set(['/history/clear', '/library/clear', '/upload/delete', '/upload/begin', '/upload/chunk', '/upload/finish', '/upload/cancel',
  '/flag-unplayable', '/flag-quality', '/markers', '/progress', '/playlists/api/x/progress', '/playback-api/playback/x', '/music-api/recordings'])

test('the route scan found the cookie POST routes it should', () => {
  for (const p of ['/history/clear', '/upload/delete', '/flag-quality', '/markers', '/progress', '/heartbeat', '/library/clear', '/school/report/reset-pin']) {
    assert.ok(discoveredPosts.includes(p), 'discovered ' + p)
  }
})

test('every cookie-authenticated POST refuses cross-site requests; strict ones also refuse a plain form post', async () => {
  await withServer({}, async ({ raw, cookie }) => {
    const all = [...new Set([...KNOWN_POSTS, ...discoveredPosts])]
    for (const p of all) {
      const post = (headers, body = '{}') => raw({ method: 'POST', pathname: p, body, headers: { cookie, ...headers } })
      for (const h of [{ 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }, { origin: 'https://evil.example' }, { origin: 'null' }]) {
        const r = await post({ 'content-type': 'application/json', ...h })
        assert.equal(r.status, 403, `${p} with ${JSON.stringify(h)} -> ${r.status}`)
      }
      if (STRICT.has(p) || p.startsWith('/upload/')) {
        const r = await post({ 'content-type': 'text/plain', 'sec-fetch-site': 'same-origin' })
        assert.equal(r.status, 415, `${p} as a plain text/form post -> ${r.status}`)
        const ok = await post({ 'content-type': p.startsWith('/music-api') ? 'audio/webm' : 'application/json', 'sec-fetch-site': 'same-origin' })
        assert.ok(![403, 415, 421].includes(ok.status), `${p} same-origin JSON must get through the guard, got ${ok.status}`)
        if (!['/library/clear', '/playlists/api/x/progress', '/music-api/recordings'].includes(p)) { // these have always had their own content-type rules
          const withHeader = await post({ 'content-type': 'text/plain', 'x-beebo-csrf': '1', 'sec-fetch-site': 'same-origin' })
          assert.ok(![403, 415].includes(withHeader.status), `${p} with the custom header, got ${withHeader.status}`)
        }
      }
    }
    // A cookie-less request is not a cookie write: the guard does not interfere with sign-in.
    const login = await raw({ method: 'POST', pathname: '/login', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' }, body: 'username=a&password=b' })
    assert.notEqual(login.status, 403)
  })
})

test('upload delete needs JSON or the custom header, and works with them', async () => {
  await withServer({}, async ({ raw, cookie, store }) => {
    store.set('uploadHistory', [{ id: 'up1', destPath: path.join(require('node:os').tmpdir(), 'beebo-nonexistent-xyz.mp4'), fileName: 'x.mp4' }])
    let r = await raw({ method: 'POST', pathname: '/upload/delete', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' }, body: 'id=up1' })
    assert.equal(r.status, 415)
    assert.equal(store.get('uploadHistory').length, 1, 'nothing was deleted')
    r = await raw({ method: 'POST', pathname: '/upload/delete', headers: { cookie, 'content-type': 'application/json', 'x-beebo-csrf': '1', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ id: 'up1' }) })
    assert.equal(r.status, 302)
    assert.equal(store.get('uploadHistory').length, 0)
  })
})

test('an unknown Host cannot make a cookie-session write (DNS rebinding); reads, sign-in and known names still work', async () => {
  await withServer({ getPublicName: () => 'nick' }, async ({ raw, cookie, store, logged }) => {
    const write = (host, extra = {}) => raw({ method: 'POST', pathname: '/history/clear', body: '{}', headers: { cookie, host, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...extra } })
    let r = await write('evil.example:47811')
    assert.equal(r.status, 421)
    assert.equal(r.json.error, 'unknown_host')
    assert.ok(logged.some((l) => /evil\.example/.test(l)), 'the owner can see why in the log')
    for (const host of ['127.0.0.1:47811', 'localhost:47811', '192.168.1.20:47811', 'nick.beebo.tv', 'nick.home.beebo.tv']) {
      assert.equal((await write(host)).status, 204, host)
    }
    // Forged forwarded headers do not help.
    assert.equal((await write('evil.example', { 'x-forwarded-host': 'nick.beebo.tv', 'x-forwarded-proto': 'https' })).status, 421)
    // GET pages and cookie-less sign-in are not gated.
    r = await raw({ pathname: '/login', headers: { host: 'evil.example' } })
    assert.equal(r.status, 200)
    r = await raw({ method: 'POST', pathname: '/login', headers: { host: 'evil.example', 'content-type': 'application/x-www-form-urlencoded' }, body: 'username=a&password=b' })
    assert.notEqual(r.status, 421)
    // The owner can allow a domain of their own.
    store.set('allowedHosts', ['media.example.com'])
    assert.equal((await write('media.example.com')).status, 204)
    store.delete('allowedHosts')
    store.set('publicBaseUrl', 'https://media2.example.com')
    assert.equal((await write('media2.example.com')).status, 204)
    assert.equal((await write('evil.example')).status, 421)
  })
})

// ------------------------------------------------------------------ headers ----

test('every response carries nosniff, Referrer-Policy, frame-ancestors and a report-only CSP; reports reach the redacted log', async () => {
  await withServer({}, async ({ raw, logged }) => {
    for (const p of ['/login', '/health', '/nope', '/api/ping']) {
      const r = await raw({ pathname: p })
      assert.equal(r.headers['x-content-type-options'], 'nosniff', p)
      assert.equal(r.headers['referrer-policy'], 'same-origin', p)
      assert.equal(r.headers['x-frame-options'], 'SAMEORIGIN', p)
      assert.equal(r.headers['content-security-policy'], "frame-ancestors 'self'", p)
      const ro = r.headers['content-security-policy-report-only']
      assert.match(ro, /default-src 'self'/)
      assert.match(ro, /object-src 'none'/)
      assert.match(ro, /frame-ancestors 'self'/)
      assert.match(ro, /report-uri \/__csp-report/)
    }
    const rep = await raw({ method: 'POST', pathname: '/__csp-report', headers: { 'content-type': 'application/csp-report' },
      body: JSON.stringify({ 'csp-report': { 'violated-directive': 'img-src', 'blocked-uri': 'https://cdn.example/p.png?token=SECRET123', 'document-uri': 'http://127.0.0.1:47811/x?mt=SECRET456' } }) })
    assert.equal(rep.status, 204)
    const line = logged.find((l) => l.startsWith('CSP report-only violation'))
    assert.ok(line, 'logged')
    assert.match(line, /img-src/)
    assert.match(line, /https:\/\/cdn\.example/)
    assert.doesNotMatch(line, /SECRET/, 'no query strings in the log')
    assert.equal((await raw({ pathname: '/__csp-report' })).status, 405)
  })
})
