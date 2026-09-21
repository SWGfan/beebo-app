'use strict'
// What the service worker may touch. The decision code is a pure module (electron/pwaPolicy.js) that is also
// pasted into the served /sw.js, so this file tests the very functions the phone runs, then runs the whole
// generated worker inside a fake service-worker scope to prove nothing else ever reaches a cache.
// Run: node --test test/pwa-policy.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const policy = require('../electron/pwaPolicy')
const pwa = require('../electron/pwa')

const ORIGIN = 'http://beebo.test:47811'
const cfg = { ...policy.CONFIG, origin: ORIGIN }
const req = (path, extra = {}) => ({ url: ORIGIN + path, method: 'GET', mode: 'navigate', ...extra })

test('page navigations are the only thing that goes through the worker, and only to the network', () => {
  for (const p of ['/', '/?view=year', '/tvshows', '/tvshows?show=abc', '/login', '/signup', '/get-app', '/appearance', '/music', '/continue', '/surprise', '/admin', '/forgot-password', '/viewing-privacy', '/playlists']) {
    assert.equal(policy.decide(req(p), cfg), 'navigate', p)
  }
  // "/watch" is a folder-like prefix, not a substring: a page that merely starts with the letters is still a page
  assert.equal(policy.decide(req('/watchlist'), cfg), 'navigate')
  assert.equal(policy.decide(req('/filesystem'), cfg), 'navigate')
})

test('the static allowlist is icons and the offline page, exact paths, no query string', () => {
  for (const p of ['/pwa/offline', '/pwa/icon-192.png', '/pwa/icon-432.png', '/pwa/apple-touch-icon.png']) {
    assert.equal(policy.decide(req(p, { mode: 'no-cors' }), cfg), 'static', p)
    assert.equal(policy.decide(req(p), cfg), 'static', p + ' (navigated to directly)')
  }
  assert.equal(policy.decide(req('/pwa/icon-192.png?x=1', { mode: 'no-cors' }), cfg), 'bypass', 'a query string is not the allowlisted URL')
  assert.equal(policy.decide(req('/pwa/other.png', { mode: 'no-cors' }), cfg), 'bypass')
  assert.equal(policy.decide(req('/pwa/icon-192.png/x', { mode: 'no-cors' }), cfg), 'bypass')
  assert.equal(policy.decide(req('/pwa/ICON-192.png', { mode: 'no-cors' }), cfg), 'bypass', 'the allowlist is case-sensitive')
  assert.equal(policy.decide(req('/pwa/icon-192.png', { hasRange: true, mode: 'no-cors' }), cfg), 'bypass', 'ranges are never handled')
})

test('API answers, media, HLS, downloads, uploads and every credential URL are left to the browser', () => {
  const never = [
    '/api', '/api/', '/api/library', '/api/login', '/API/library', '//api/library', '/api//x', '/Api/Music/track/t1/stream',
    '/playback-api/playback/start', '/playback-api', '/music-api/recordings', '/photos-api/list', '/anything-api/x',
    '/hls/abc123/master.m3u8', '/subtitles/file?id=1', '/subtitles/embedded', '/trickplay/thumb?x=1',
    '/watch?id=abc', '/watch', '/tvwatch?id=abc', '/file?id=1', '/tvfile?id=1', '/download/android-app', '/media/poster/1.jpg',
    '/upload', '/progress', '/heartbeat', '/health', '/_rtc/host', '/logout',
    '/verify?token=abc', '/reset-password?token=abc',
    '/sw.js', '/manifest.webmanifest', '/manifest.webmanifest?theme=ember',
    '/music/album.json?id=1', '/music/lyrics.json?id=1', '/anything.json'
  ]
  for (const p of never) {
    assert.equal(policy.decide(req(p), cfg), 'bypass', 'navigation to ' + p)
    assert.equal(policy.decide(req(p, { mode: 'cors' }), cfg), 'bypass', 'subresource ' + p)
  }
})

test('a media token or any credential-style query parameter always bypasses, whatever the path', () => {
  for (const q of ['?mt=abc', '?MT=abc', '?x=1&mt=abc', '?token=t', '?access_token=t', '?ticket=t', '?sig=s', '?signature=s', '?key=k', '?code=c', '?auth=a', '?Token=t']) {
    assert.equal(policy.decide(req('/' + q), cfg), 'bypass', q)
    assert.equal(policy.decide(req('/tvshows' + q), cfg), 'bypass', q)
    assert.equal(policy.decide(req('/login' + q), cfg), 'bypass', q)
    assert.equal(policy.decide(req('/pwa/icon-192.png' + q, { mode: 'no-cors' }), cfg), 'bypass', q)
  }
  assert.equal(policy.decide(req('/?monkey=1'), cfg), 'navigate', 'only exact parameter names count')
})

test('anything that is not a plain same-origin GET is left alone', () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']) assert.equal(policy.decide(req('/login', { method }), cfg), 'bypass', method)
  assert.equal(policy.decide(req('/', { method: 'get' }), cfg), 'navigate', 'method case does not matter')
  assert.equal(policy.decide(req('/', { hasRange: true }), cfg), 'bypass', 'Range')
  assert.equal(policy.decide({ url: 'https://cdn.jsdelivr.net/npm/hls.js', method: 'GET', mode: 'cors' }, cfg), 'bypass', 'another origin')
  assert.equal(policy.decide({ url: 'http://beebo.test:9999/', method: 'GET', mode: 'navigate' }, cfg), 'bypass', 'another port is another origin')
  assert.equal(policy.decide({ url: 'https://beebo.test:47811/', method: 'GET', mode: 'navigate' }, cfg), 'bypass', 'another scheme is another origin')
  for (const mode of ['cors', 'no-cors', 'same-origin', 'websocket', undefined]) assert.equal(policy.decide(req('/anything', { mode }), cfg), 'bypass', String(mode))
  assert.equal(policy.decide(req('/x', { url: 'not a url' }), cfg), 'bypass')
  assert.equal(policy.decide(req('/x', { url: '' }), cfg), 'bypass')
  assert.equal(policy.decide(null, cfg), 'bypass')
  assert.equal(policy.decide(undefined, cfg), 'bypass')
})

test('path tricks cannot turn a protected URL into a cacheable one', () => {
  for (const p of ['/pwa/../api/library', '/pwa/%2e%2e/api/library', '/./api/library', '//playback-api/x', '/pwa/icon-192.png/../../api/x']) {
    const decision = policy.decide(req(p, { mode: 'no-cors' }), cfg)
    assert.notEqual(decision, 'static', p)
  }
  // fuzz: whatever is generated, "static" is only ever an exact allowlisted path
  const pieces = ['/', 'api', 'pwa', 'icon-192.png', 'offline', 'watch', '..', '.', '%2e', 'x', '?mt=1', '?a=b', '#h', '//']
  let seed = 12345
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  for (let i = 0; i < 3000; i++) {
    let p = '/'
    for (let n = Math.floor(rand() * 5); n >= 0; n--) p += pieces[Math.floor(rand() * pieces.length)]
    const d = policy.decide(req(p, { mode: rand() < 0.5 ? 'navigate' : 'no-cors' }), cfg)
    if (d === 'static') assert.ok(cfg.staticPaths.includes(new URL(ORIGIN + p).pathname) && new URL(ORIGIN + p).search === '', p)
  }
})

test('canStore only approves the icons and the offline page, as plain 200 same-origin answers', () => {
  assert.equal(policy.canStore('/pwa/offline', 200, 'basic', 'text/html; charset=utf-8'), true)
  assert.equal(policy.canStore('/pwa/icon-192.png', 200, 'basic', 'image/png'), true)
  assert.equal(policy.canStore('/pwa/apple-touch-icon.png', 200, 'basic', 'IMAGE/PNG'), true)
  assert.equal(policy.canStore('/pwa/icon-192.png', 200, 'basic', 'image/png', 'beebo_session=x'), false, 'never a response that sets a cookie')
  assert.equal(policy.canStore('/pwa/icon-192.png', 404, 'basic', 'image/png'), false)
  assert.equal(policy.canStore('/pwa/icon-192.png', 302, 'basic', 'image/png'), false)
  assert.equal(policy.canStore('/pwa/icon-192.png', 206, 'basic', 'image/png'), false)
  assert.equal(policy.canStore('/pwa/icon-192.png', 200, 'opaque', 'image/png'), false)
  assert.equal(policy.canStore('/pwa/icon-192.png', 200, 'cors', 'image/png'), false)
  assert.equal(policy.canStore('/pwa/icon-192.png', 200, 'basic', 'text/html'), false, 'a login page served in place of an icon')
  assert.equal(policy.canStore('/pwa/offline', 200, 'basic', 'application/json'), false)
  assert.equal(policy.canStore('/pwa/offline', 200, 'basic', ''), false)
  for (const p of ['/', '/login', '/api/library', '/watch', '/hls/x/a.ts', '/music-api/x']) {
    for (const ct of ['text/html', 'application/json', 'image/png', 'video/mp4']) assert.equal(policy.canStore(p, 200, 'basic', ct), false, p + ' ' + ct)
  }
})

// ------------------------------------------------------------------ the generated worker, run for real ----

function fakeWorker({ origin = ORIGIN, network }) {
  const listeners = {}
  const stores = new Map()
  const events = { skipWaiting: 0, claimed: 0, fetches: [] }
  const res = (status, type, contentType, body, extra = {}) => ({
    status, type, body, headers: { get: (k) => (k.toLowerCase() === 'content-type' ? contentType : (extra[k.toLowerCase()] || null)) }, clone() { return this }
  })
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map())
      const m = stores.get(name)
      return { put: async (k, v) => { m.set(String(k), v) }, match: async (k) => m.get(String(k)) }
    },
    async keys() { return [...stores.keys()] },
    async delete(name) { return stores.delete(name) }
  }
  const self = {
    location: { origin },
    addEventListener: (t, f) => { listeners[t] = f },
    skipWaiting: () => { events.skipWaiting++; return Promise.resolve() },
    clients: { claim: () => { events.claimed++; return Promise.resolve() } }
  }
  const fetch = async (input, opts) => {
    const url = typeof input === 'string' ? input : input.url
    events.fetches.push({ url, opts })
    return network(new URL(url, origin).pathname, url, opts)
  }
  const sandbox = { self, caches, fetch, Response: { error: () => ({ error: true }) }, URL, Promise, Error, Array, String }
  vm.runInNewContext(pwa.workerSource(), sandbox)
  const lifecycle = (type) => {
    let settled = Promise.resolve()
    listeners[type]({ waitUntil: (p) => { settled = Promise.resolve(p) } })
    return settled
  }
  const dispatchFetch = (request) => {
    let promise = null
    listeners.fetch({ request: { headers: { has: (h) => !!request.hasRange && h === 'range' }, ...request }, respondWith: (p) => { promise = Promise.resolve(p) } })
    return promise // null when the worker did not answer (the browser handles it)
  }
  return { listeners, stores, events, res, lifecycle, dispatchFetch, self }
}

const okNetwork = (w) => async (p) => {
  if (p === '/pwa/offline') return w.res(200, 'basic', 'text/html; charset=utf-8', 'OFFLINE')
  if (p.endsWith('.png')) return w.res(200, 'basic', 'image/png', 'PNG:' + p)
  return w.res(200, 'basic', 'text/html', 'PAGE:' + p, { 'set-cookie': 'beebo_session=secret' })
}

test('generated worker: install caches only the offline page and one icon, and takes over at once', async () => {
  const w = fakeWorker({ network: (p, u, o) => okNetwork(w)(p, u, o) })
  await w.lifecycle('install')
  assert.equal(w.events.skipWaiting, 1)
  const names = [...w.stores.keys()]
  assert.equal(names.length, 1)
  assert.match(names[0], /^beebo-pwa-static-v\d+-[0-9a-f]{8}$/)
  assert.deepEqual([...w.stores.get(names[0]).keys()].sort(), ['/pwa/icon-192.png', '/pwa/offline'])
  for (const f of w.events.fetches) { assert.equal(f.opts.credentials, 'omit', 'no cookies sent for precache'); assert.equal(f.opts.cache, 'reload') }
})

test('generated worker: an install that cannot fetch a clean offline page fails instead of half-installing', async () => {
  const w = fakeWorker({ network: async () => w.res(200, 'basic', 'text/plain', 'nope') })
  await assert.rejects(w.lifecycle('install'))
  const login = fakeWorker({ network: async () => w.res(200, 'basic', 'text/html', 'a login page', { 'set-cookie': 'x=1' }) })
  await assert.rejects(login.lifecycle('install'), 'a response that sets a cookie is not cacheable, so the install stops')
})

test('generated worker: activation removes older Beebo caches, keeps other apps\' caches, and claims open pages', async () => {
  const w = fakeWorker({ network: (p) => okNetwork(w)(p) })
  await w.lifecycle('install')
  const current = [...w.stores.keys()][0]
  w.stores.set('beebo-pwa-static-v0-deadbeef', new Map())
  w.stores.set('beebo-pwa-old', new Map())
  w.stores.set('someone-elses-cache', new Map())
  await w.lifecycle('activate')
  assert.deepEqual([...w.stores.keys()].sort(), [current, 'someone-elses-cache'].sort())
  assert.equal(w.events.claimed, 1)
})

test('generated worker: leaves API, media, tokens, uploads and cross-origin requests completely alone', async () => {
  const w = fakeWorker({ network: (p) => okNetwork(w)(p) })
  await w.lifecycle('install')
  const before = w.events.fetches.length
  const alone = [
    { url: ORIGIN + '/api/library', method: 'GET', mode: 'cors' },
    { url: ORIGIN + '/api/library', method: 'GET', mode: 'navigate' },
    { url: ORIGIN + '/playback-api/playback/start', method: 'POST', mode: 'cors' },
    { url: ORIGIN + '/hls/s/master.m3u8', method: 'GET', mode: 'cors' },
    { url: ORIGIN + '/file?id=1', method: 'GET', mode: 'no-cors', hasRange: true },
    { url: ORIGIN + '/watch?id=1', method: 'GET', mode: 'navigate' },
    { url: ORIGIN + '/api/music/track/t1/stream?mt=abc', method: 'GET', mode: 'no-cors' },
    { url: ORIGIN + '/login', method: 'POST', mode: 'navigate' },
    { url: ORIGIN + '/media/poster/1.jpg', method: 'GET', mode: 'no-cors' },
    { url: 'https://cdn.jsdelivr.net/npm/hls.js', method: 'GET', mode: 'cors' },
    { url: ORIGIN + '/sw.js', method: 'GET', mode: 'no-cors' },
    { url: ORIGIN + '/manifest.webmanifest', method: 'GET', mode: 'cors' }
  ]
  for (const r of alone) assert.equal(w.dispatchFetch(r), null, r.method + ' ' + r.url)
  assert.equal(w.events.fetches.length, before, 'the worker made no request of its own for any of them')
})

test('generated worker: a page is always fetched from the network, never stored, and never replaced by an old copy', async () => {
  let online = true
  const w = fakeWorker({ network: async (p, u, o) => { if (!online) throw new TypeError('Failed to fetch'); return okNetwork(w)(p, u, o) } })
  await w.lifecycle('install')
  const cache = w.stores.get([...w.stores.keys()][0])
  const keysBefore = [...cache.keys()].sort()
  const first = await w.dispatchFetch({ url: ORIGIN + '/tvshows?show=abc', method: 'GET', mode: 'navigate' })
  assert.equal(first.body, 'PAGE:/tvshows')
  const second = await w.dispatchFetch({ url: ORIGIN + '/', method: 'GET', mode: 'navigate' })
  assert.equal(second.body, 'PAGE:/')
  assert.deepEqual([...cache.keys()].sort(), keysBefore, 'signed-in pages are never written to the cache')
  // the server goes away: the same URLs now get the offline page, and nothing stale
  online = false
  const offline = await w.dispatchFetch({ url: ORIGIN + '/tvshows?show=abc', method: 'GET', mode: 'navigate' })
  assert.equal(offline.body, 'OFFLINE')
  // the server is back: live pages again
  online = true
  assert.equal((await w.dispatchFetch({ url: ORIGIN + '/', method: 'GET', mode: 'navigate' })).body, 'PAGE:/')
  assert.deepEqual([...cache.keys()].sort(), keysBefore)
})

test('generated worker: a server error page is passed through, not hidden behind the offline page', async () => {
  const w = fakeWorker({ network: async (p) => (p === '/pwa/offline' || p.endsWith('.png') ? okNetwork(w)(p) : w.res(500, 'basic', 'text/html', 'BROKEN')) })
  await w.lifecycle('install')
  assert.equal((await w.dispatchFetch({ url: ORIGIN + '/', method: 'GET', mode: 'navigate' })).body, 'BROKEN')
})

test('generated worker: allowlisted files come from the cache, and only good ones are ever added', async () => {
  const w = fakeWorker({ network: (p) => okNetwork(w)(p) })
  await w.lifecycle('install')
  const cache = w.stores.get([...w.stores.keys()][0])
  const fetched = w.events.fetches.length
  const icon = await w.dispatchFetch({ url: ORIGIN + '/pwa/icon-192.png', method: 'GET', mode: 'no-cors' })
  assert.equal(icon.body, 'PNG:/pwa/icon-192.png')
  assert.equal(w.events.fetches.length, fetched, 'served from the cache without touching the network')
  // one that was not precached is fetched, then remembered
  const big = await w.dispatchFetch({ url: ORIGIN + '/pwa/icon-432.png', method: 'GET', mode: 'no-cors' })
  assert.equal(big.body, 'PNG:/pwa/icon-432.png')
  assert.ok(cache.has('/pwa/icon-432.png'))
  // ...but a wrong-type or cookie-setting answer for an allowlisted URL is passed on and not kept
  const bad = fakeWorker({ network: async (p) => (p === '/pwa/offline' ? bad.res(200, 'basic', 'text/html', 'OFFLINE') : p === '/pwa/icon-192.png' ? bad.res(200, 'basic', 'image/png', 'PNG') : bad.res(200, 'basic', 'text/html', 'LOGIN PAGE', { 'set-cookie': 's=1' })) })
  await bad.lifecycle('install')
  const badCache = bad.stores.get([...bad.stores.keys()][0])
  const answer = await bad.dispatchFetch({ url: ORIGIN + '/pwa/apple-touch-icon.png', method: 'GET', mode: 'no-cors' })
  assert.equal(answer.body, 'LOGIN PAGE')
  assert.ok(!badCache.has('/pwa/apple-touch-icon.png'))
})

test('generated worker: after any mix of traffic the cache holds nothing but allowlisted paths', async () => {
  const w = fakeWorker({ network: (p) => okNetwork(w)(p) })
  await w.lifecycle('install')
  const cache = w.stores.get([...w.stores.keys()][0])
  const traffic = ['/', '/login', '/api/x', '/watch?id=1', '/music', '/pwa/icon-432.png', '/pwa/apple-touch-icon.png', '/tvshows?token=t', '/x?mt=1', '/hls/a/b.ts', '/pwa/offline']
  for (const p of traffic) for (const mode of ['navigate', 'no-cors', 'cors']) { const r = w.dispatchFetch({ url: ORIGIN + p, method: 'GET', mode }); if (r) await r }
  for (const key of cache.keys()) assert.ok(policy.CONFIG.staticPaths.includes(key), 'unexpected cache entry ' + key)
})

test('the worker source carries the same decision code that is tested here, and a version in the cache name', () => {
  const src = pwa.workerSource()
  assert.ok(src.includes(policy.decide.toString()))
  assert.ok(src.includes(policy.canStore.toString()))
  assert.ok(src.includes('self.skipWaiting()') && src.includes('self.clients.claim()'))
  assert.match(src, /var CACHE = "beebo-pwa-static-v1-[0-9a-f]{8}"/)
  assert.ok(!/localStorage|indexedDB|PushManager|showNotification|addEventListener\('push'|'sync'|BackgroundFetch/.test(src), 'no push, sync or storage')
  assert.doesNotThrow(() => new vm.Script(src))
})
