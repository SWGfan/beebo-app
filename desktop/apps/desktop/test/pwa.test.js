'use strict'
// Beebo as an installable web app, against a real server: the manifest (shape, per-person theme colors), the
// service worker and offline page (public, correct types, no cookies, no library data), the icons, the head
// tags on every kind of page, and the in-page scripts (Install helper, service-worker registration,
// Media Session) run against a fake browser.
// Run: node --test test/pwa.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const crypto = require('node:crypto')
const auth = require('../electron/auth')
const server = require('../electron/streamServer')
const theme = require('../electron/theme')
const pwa = require('../electron/pwa')

const PASSWORD = 'Pwa-test-password-77'
const SECRET = crypto.randomBytes(32).toString('hex')
const MOVIE = 'Zebra Quartz Secret Film (2019).mp4'
let portSequence = 0

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'beebo-pwa-'))
  const moviesDir = path.join(root, 'movies')
  await fs.mkdir(moviesDir)
  await fs.writeFile(path.join(moviesDir, MOVIE), Buffer.alloc(64))
  const data = { authUsers: [
    { id: 'ann', name: 'Ann Zebrowski', username: 'annz', status: 'approved', isAdmin: true, passwordHash: auth.hashPassword(PASSWORD) },
    { id: 'bob', name: 'Bob', username: 'bob', status: 'approved', passwordHash: auth.hashPassword(PASSWORD) }
  ] }
  const store = { get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] }, onDidChange: () => () => {} }
  auth.forgetSecrets(); server.forgetSecrets()
  const info = server.startStreamServer({
    port: 46500 + (process.pid % 1000) + ++portSequence,
    store, getMoviesDir: () => moviesDir, getTvShowsDir: () => root,
    getAllMoviesDirs: () => [moviesDir], getAllTvShowsDirs: () => [],
    agentSecret: SECRET, log: () => {}
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
  assert.equal(ready, true, 'fixture server started')
  const cookies = Object.fromEntries(data.authUsers.map((u) => [u.id, auth.signSession(store, u.id)]))
  async function get(who, route, { method = 'GET', body, headers = {} } = {}) {
    const response = await fetch(base + route, {
      method,
      headers: { ...(who ? { Cookie: 'beebo_session=' + cookies[who] } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual'
    })
    const bytes = Buffer.from(await response.arrayBuffer())
    return { status: response.status, headers: response.headers, bytes, text: bytes.toString('utf8') }
  }
  const setTheme = (who, changes) => get(who, '/appearance', { method: 'POST', body: changes, headers: { Origin: base } })
  return { data, store, base, get, setTheme }
}

const pngSize = (bytes) => ({ w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20) })
const isPng = (bytes) => bytes.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
const headOf = (html) => html.slice(0, html.indexOf('<body'))
const manifestHrefOf = (html) => /<link rel="manifest" href="([^"]+)"/.exec(html)?.[1].replace(/&amp;/g, '&')
const themeColorOf = (html) => /<meta name="theme-color" content="([^"]*)"/.exec(html)?.[1]

// ------------------------------------------------------------------------------------ the manifest ------

test('manifest: public, no cookie, right type, valid JSON, and the fields an installer needs', async (t) => {
  const f = await fixture(t)
  const r = await f.get(null, '/manifest.webmanifest')
  assert.equal(r.status, 200)
  assert.match(r.headers.get('content-type'), /^application\/manifest\+json/)
  assert.equal(r.headers.get('set-cookie'), null, 'no cookie is ever set')
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff')
  assert.ok(r.headers.get('cache-control'))
  const m = JSON.parse(r.text)
  assert.equal(m.name, 'Beebo')
  assert.equal(m.short_name, 'Beebo')
  assert.equal(m.display, 'standalone')
  assert.equal(m.start_url, '/')
  assert.equal(m.scope, '/')
  assert.equal(m.id, '/')
  assert.equal(m.lang, 'en')
  assert.match(m.theme_color, /^#[0-9a-f]{6}$/)
  assert.match(m.background_color, /^#[0-9a-f]{6}$/)
  assert.ok(Array.isArray(m.icons) && m.icons.length >= 2)
  assert.ok(m.icons.some((i) => i.sizes === '192x192' && i.purpose === 'any'))
  assert.ok(m.icons.some((i) => /maskable/.test(i.purpose)))
  assert.ok(m.shortcuts.length >= 1 && m.shortcuts.every((s) => s.url.startsWith('/') && s.name))
})

test('manifest: every icon it lists exists, is a PNG, and is really the size it says (nothing is scaled up)', async (t) => {
  const f = await fixture(t)
  const m = JSON.parse((await f.get(null, '/manifest.webmanifest')).text)
  const master = pngSize((await f.get(null, '/pwa/icon-432.png')).bytes)
  assert.deepEqual(master, { w: 432, h: 432 }, 'the largest icon is the native 432 px artwork')
  for (const icon of m.icons) {
    const r = await f.get(null, icon.src)
    assert.equal(r.status, 200, icon.src)
    assert.equal(r.headers.get('content-type'), 'image/png')
    assert.ok(isPng(r.bytes), icon.src)
    const [w, h] = icon.sizes.split('x').map(Number)
    assert.deepEqual(pngSize(r.bytes), { w, h }, icon.src + ' is ' + icon.sizes)
    assert.ok(w <= master.w, 'no icon is larger than the source artwork')
    assert.equal(r.headers.get('set-cookie'), null)
  }
  assert.ok(!m.icons.some((i) => i.sizes === '512x512'), 'no 512 is claimed until there is a 512 master')
})

test('icons: the Apple touch icons are 180, 167 and 152 px, opaque-looking PNGs, also served at the site root', async (t) => {
  const f = await fixture(t)
  for (const [route, size] of [['/pwa/apple-touch-icon.png', 180], ['/pwa/apple-touch-icon-167.png', 167], ['/pwa/apple-touch-icon-152.png', 152], ['/apple-touch-icon.png', 180], ['/apple-touch-icon-precomposed.png', 180]]) {
    const r = await f.get(null, route)
    assert.equal(r.status, 200, route)
    assert.deepEqual(pngSize(r.bytes), { w: size, h: size }, route)
    assert.equal(r.bytes[25], 2, route + ' is 24-bit RGB with no alpha channel (iOS paints transparency black)')
  }
  const head = await f.get(null, '/pwa/icon-192.png', { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(head.bytes.length, 0)
  assert.equal(head.headers.get('content-type'), 'image/png')
  assert.notEqual((await f.get(null, '/pwa/does-not-exist.png')).headers.get('content-type'), 'image/png')
})

test('manifest colors follow each person\'s theme, and match the theme-color meta on their pages', async (t) => {
  const f = await fixture(t)
  await f.setTheme('ann', { theme: 'daylight' })
  await f.setTheme('bob', { theme: 'ember' })
  const expected = {
    ann: { themeColor: theme.PRESETS.daylight.themeColor, background: '#f5f6fa', bar: 'default' },
    bob: { themeColor: theme.PRESETS.ember.themeColor, background: '#120e0b', bar: 'black-translucent' },
    anon: { themeColor: theme.PRESETS.midnight.themeColor, background: '#080b14', bar: 'black-translucent' }
  }
  for (const [who, want] of Object.entries(expected)) {
    const page = await f.get(who === 'anon' ? null : who, who === 'anon' ? '/login' : '/appearance')
    assert.equal(page.status, 200, who)
    const href = manifestHrefOf(page.text)
    assert.ok(href && href.startsWith('/manifest.webmanifest?'), who + ' has a manifest link')
    assert.equal(themeColorOf(page.text), want.themeColor, who + ' meta theme-color')
    assert.match(page.text, new RegExp(`<meta name="apple-mobile-web-app-status-bar-style" content="${want.bar}">`), who + ' status bar')
    const manifest = JSON.parse((await f.get(null, href)).text) // fetched with NO cookie: the link carries the theme
    assert.equal(manifest.theme_color, want.themeColor, who + ' manifest theme_color')
    assert.equal(manifest.background_color, want.background, who + ' manifest background_color')
    assert.equal(manifest.theme_color, themeColorOf(page.text), who + ': manifest and meta agree')
  }
})

test('manifest background follows a custom --bg override, validated', async (t) => {
  const f = await fixture(t)
  const saved = await f.setTheme('ann', { theme: 'midnight', custom: '--bg: rgb(17, 34, 51);' })
  assert.equal(saved.status, 200, saved.text)
  const page = await f.get('ann', '/appearance')
  assert.match(manifestHrefOf(page.text), /bg=112233$/)
  assert.equal(JSON.parse((await f.get(null, manifestHrefOf(page.text))).text).background_color, '#112233')
  // a signed-out page and safe mode ignore the saved override
  assert.match(manifestHrefOf((await f.get(null, '/login')).text), /theme=midnight&bg=080b14$/)
  assert.match(manifestHrefOf((await f.get('ann', '/appearance?safe=1')).text), /theme=midnight&bg=080b14$/)
})

test('manifest: hostile or malformed query values fall back to the defaults and never reach the JSON', async (t) => {
  const f = await fixture(t)
  for (const q of ['?theme=%22%3E%3Cscript%3E&bg=red', '?theme=__proto__&bg=%23zzzzzz', '?theme[]=ember&bg[]=1', '?bg=' + 'a'.repeat(5000), '?theme=constructor', '?theme=ember%00&bg=12345', '?theme=ember&bg=1234567', '']) {
    const r = await f.get(null, '/manifest.webmanifest' + q)
    assert.equal(r.status, 200, q)
    const m = JSON.parse(r.text)
    assert.ok(/^#[0-9a-f]{6}$/.test(m.background_color), q)
    assert.ok(theme.PRESET_IDS.some((id) => theme.PRESETS[id].themeColor === m.theme_color), q)
    assert.ok(!/<script|__proto__|constructor|zzzz|red/i.test(r.text.replace(/"description":"[^"]*"/, "")), q)
  }
  assert.equal(JSON.parse((await f.get(null, '/manifest.webmanifest?theme=ember&bg=%23ABCDEF')).text).background_color, '#abcdef')
})

// ------------------------------------------------------------------------------------ the worker --------

test('/sw.js: public, JavaScript, scope-wide, never cached by the browser, no cookies, valid script', async (t) => {
  const f = await fixture(t)
  const r = await f.get(null, '/sw.js')
  assert.equal(r.status, 200)
  assert.match(r.headers.get('content-type'), /^text\/javascript/)
  assert.equal(r.headers.get('service-worker-allowed'), '/')
  assert.equal(r.headers.get('cache-control'), 'no-cache')
  assert.equal(r.headers.get('set-cookie'), null)
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff')
  assert.doesNotThrow(() => new vm.Script(r.text))
  assert.match(r.text, /beebo-pwa-static-v1-[0-9a-f]{8}/)
  assert.equal(r.text, pwa.workerSource())
  // a signed-in request gets the very same bytes: it is not personalised
  assert.equal((await f.get('ann', '/sw.js')).text, r.text)
  // HEAD carries headers only; other methods are refused
  const head = await f.get(null, '/sw.js', { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(head.bytes.length, 0)
  assert.equal(head.headers.get('service-worker-allowed'), '/')
  assert.equal((await f.get(null, '/sw.js', { method: 'POST', body: {} })).status, 405)
  assert.equal((await f.get(null, '/manifest.webmanifest', { method: 'DELETE' })).status, 405)
})

test('the offline page: public, static, explains the problem, offers Retry, and holds no library or person data', async (t) => {
  const f = await fixture(t)
  await f.setTheme('ann', { theme: 'ember' })
  const anon = await f.get(null, '/pwa/offline')
  assert.equal(anon.status, 200)
  assert.match(anon.headers.get('content-type'), /^text\/html/)
  assert.equal(anon.headers.get('set-cookie'), null)
  assert.match(anon.text, /Can't reach your Beebo server/)
  assert.match(anon.text, /Try again/)
  assert.equal(anon.text, pwa.OFFLINE_HTML, 'the served page is the constant, so nothing is interpolated into it')
  const signedIn = await f.get('ann', '/pwa/offline')
  assert.equal(signedIn.text, anon.text, 'identical for everyone, signed in or not')
  for (const forbidden of ['Zebra', 'Quartz', 'Secret Film', 'Zebrowski', 'annz', 'bob', 'ember', 'beebo_session', '/api/', 'fetch(', 'XMLHttpRequest', '<script src']) {
    assert.ok(!anon.text.includes(forbidden), 'no ' + forbidden)
  }
  assert.ok(!/https?:\/\//.test(anon.text.replace(/<meta[^>]*>/g, '')), 'no external addresses')
})

test('the public files never mention the library, the people, or the movie the fixture holds', async (t) => {
  const f = await fixture(t)
  for (const route of ['/manifest.webmanifest', '/sw.js', '/pwa/offline']) {
    for (const who of [null, 'ann']) {
      const r = await f.get(who, route)
      assert.ok(!/Zebra|Quartz|Secret Film|Zebrowski|annz/.test(r.text), route)
    }
  }
})

// ------------------------------------------------------------------------------------ head tags ----------

test('head tags: manifest, icons, iOS web-app meta, viewport-fit and theme-color on the login page and every signed-in page', async (t) => {
  const f = await fixture(t)
  const pages = [[null, '/login'], [null, '/signup'], [null, '/get-app'], ['ann', '/'], ['ann', '/appearance'], ['ann', '/viewing-privacy'], ['ann', '/tvshows'], ['ann', '/get-app']]
  for (const [who, route] of pages) {
    const r = await f.get(who, route)
    assert.equal(r.status, 200, route)
    const head = headOf(r.text)
    assert.match(head, /<link rel="manifest" href="\/manifest\.webmanifest\?theme=[a-z]+&amp;bg=[0-9a-f]{6}">/, route)
    assert.match(head, /<link rel="apple-touch-icon" href="\/pwa\/apple-touch-icon\.png">/, route)
    assert.match(head, /<link rel="apple-touch-icon" sizes="152x152"/, route)
    assert.match(head, /<link rel="apple-touch-icon" sizes="167x167"/, route)
    assert.match(head, /<link rel="icon" type="image\/png" sizes="192x192" href="\/pwa\/icon-192\.png">/, route)
    assert.match(head, /<meta name="apple-mobile-web-app-capable" content="yes">/, route)
    assert.match(head, /<meta name="mobile-web-app-capable" content="yes">/, route)
    assert.match(head, /<meta name="apple-mobile-web-app-title" content="Beebo">/, route)
    assert.match(head, /<meta name="apple-mobile-web-app-status-bar-style" content="(black-translucent|default)">/, route)
    assert.match(head, /<meta name="viewport" content="[^"]*viewport-fit=cover/, route)
    assert.match(head, /<meta name="theme-color" content="#[0-9a-f]{6}">/, route)
    assert.equal((head.match(/<link rel="manifest"/g) || []).length, 1, route + ' has exactly one manifest link')
    assert.ok(r.text.includes('class="beebo-install"') === false, 'the banner is built by script, not shipped in the HTML')
    assert.match(r.text, /navigator\.serviceWorker\.register\('\/sw\.js'/, route + ' registers the worker')
  }
})

test('the video player page carries the same tags, viewport-fit and its own standalone rules', async (t) => {
  const f = await fixture(t)
  await f.setTheme('ann', { theme: 'daylight' })
  const list = await f.get('ann', '/')
  const href = /href="(\/watch\?id=[^"]+)"/.exec(list.text)?.[1]
  assert.ok(href, 'the fixture library lists the film')
  const r = await f.get('ann', href.replace(/&amp;/g, '&'))
  assert.equal(r.status, 200)
  const html = r.text
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">/)
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest\?theme=daylight&amp;bg=f5f6fa">/, 'the person\'s theme reaches the player page too')
  assert.match(html, /<link rel="apple-touch-icon"/)
  assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes">/)
  assert.match(html, /<meta name="apple-mobile-web-app-status-bar-style" content="default">/)
  assert.match(html, /overscroll-behavior:none/)
  assert.match(html, /env\(safe-area-inset-top\)/)
  assert.ok(!html.includes('beebo-install'), 'no install banner over the video')
  assert.ok(html.includes("navigator.mediaSession.setActionHandler(k, acts[k])"), 'the player keeps its own lock-screen buttons')
})

test('/get-app now tells iPhone and iPad people what to do, in plain words', async (t) => {
  const f = await fixture(t)
  const r = await f.get(null, '/get-app')
  assert.match(r.text, /iPhone and iPad/)
  assert.match(r.text, /Add to Home Screen/)
  assert.match(r.text, /<b>Share<\/b>/)
  assert.ok(!r.text.includes("aren't supported yet"))
  assert.match((await f.get(null, '/login')).text, /Android, Windows, iPhone and iPad/)
})

test('the sign-in and other pages still work: nothing about the new routes changed the login flow', async (t) => {
  const f = await fixture(t)
  assert.equal((await f.get(null, '/')).status, 302)
  assert.equal((await f.get(null, '/')).headers.get('location'), '/login')
  const ok = await f.get('ann', '/')
  assert.equal(ok.status, 200)
  assert.equal((await f.get(null, '/api/ping')).status, 200)
})

// ------------------------------------------------------------------------------------ client scripts ----

class FakeEl {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.listeners = {}; this.className = ''; this.textContent = ''; this.innerHTML = ''; this.parentNode = null }
  setAttribute(k, v) { this.attrs[k] = String(v) }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn) }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c }
  insertBefore(c, ref) { c.parentNode = this; const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c }
  get firstChild() { return this.children[0] || null }
  click() { for (const fn of this.listeners.click || []) fn({ preventDefault() {} }) }
  find(className) { return this.children.find((c) => c.className === className) || this.children.map((c) => c.find && c.find(className)).find(Boolean) || null }
}

const IOS_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'
const IOS_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/123.0 Mobile/15E148 Safari/604.1'
const IPAD_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15'
const DESKTOP_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36'

function browser({ script = pwa.bodyMarkup().replace(/^<script>/, '').replace(/<\/script>$/, ''), ua = DESKTOP_CHROME, platform = 'Win32', maxTouchPoints = 0, standalone = false, navStandalone, secure = true, serviceWorker = true, storage = {}, storageThrows = false, readyState = 'complete', session = true, audioSession = true, mediaMetadata = true, existingMetadata = null, mediaEls = [], registerRejects = false } = {}) {
  const docL = {}
  const winL = {}
  const calls = { register: [], prompts: 0, positions: [], setHandlers: {} }
  const main = new FakeEl('main')
  const body = new FakeEl('body')
  const html = { classList: { set: new Set(), add(c) { this.set.add(c) }, contains(c) { return this.set.has(c) } } }
  const doc = {
    readyState, documentElement: html, body, title: 'Music',
    getElementById: (id) => (id === 'beebo-content' ? main : null),
    createElement: (tag) => new FakeEl(tag),
    addEventListener: (t, fn) => { (docL[t] = docL[t] || []).push(fn) },
    querySelectorAll: () => mediaEls
  }
  const nav = {
    userAgent: ua, platform, maxTouchPoints,
    serviceWorker: serviceWorker ? { register: (url, opts) => { calls.register.push({ url, opts }); return registerRejects ? Promise.reject(new Error('blocked')) : Promise.resolve({}) } } : undefined
  }
  if (navStandalone !== undefined) nav.standalone = navStandalone
  const ms = {
    metadata: existingMetadata, playbackState: 'none',
    setActionHandler(name, fn) { calls.setHandlers[name] = fn },
    setPositionState(state) { calls.positions.push(state) }
  }
  if (session) nav.mediaSession = ms
  if (audioSession) nav.audioSession = { type: 'auto' }
  const sandbox = {
    document: doc, navigator: nav, Date, Number, isFinite, Math, Infinity, setTimeout,
    localStorage: { getItem: (k) => (k in storage ? storage[k] : null), setItem: (k, v) => { storage[k] = String(v) } }
  }
  if (storageThrows) Object.defineProperty(sandbox, 'localStorage', { get() { throw new Error('storage denied') } })
  sandbox.window = sandbox
  sandbox.isSecureContext = secure
  sandbox.matchMedia = (q) => ({ matches: standalone && /standalone/.test(q) })
  sandbox.addEventListener = (t, fn) => { (winL[t] = winL[t] || []).push(fn) }
  if (mediaMetadata) sandbox.MediaMetadata = class { constructor(init) { Object.assign(this, init) } }
  vm.runInNewContext(script, sandbox)
  const fire = (target, type, extra = {}) => { for (const fn of (target === doc ? docL : winL)[type] || []) fn({ type, ...extra }) }
  const media = async (type, el) => { for (const fn of docL[type] || []) fn({ type, target: el }); await new Promise((r) => setTimeout(r, 5)) }
  return { doc, nav, ms, main, body, html, calls, storage, fire, media, winL, docL, sandbox }
}

const audioEl = (o = {}) => ({ tagName: 'AUDIO', paused: true, ended: false, duration: 200, currentTime: 10, playbackRate: 1, srcObject: null, played: 0, play() { this.paused = false; this.played++; return Promise.resolve() }, pause() { this.paused = true }, ...o })
const videoEl = (o = {}) => audioEl({ tagName: 'VIDEO', ...o })

test('client: the worker registers over a secure connection and is skipped, quietly, everywhere else', async () => {
  const secure = browser({})
  assert.deepEqual(JSON.parse(JSON.stringify(secure.calls.register)), [{ url: '/sw.js', opts: { scope: '/' } }])
  // plain http on a LAN address: not a secure context, so no attempt (and no error)
  assert.equal(browser({ secure: false }).calls.register.length, 0)
  // an old browser with no service worker support
  assert.doesNotThrow(() => browser({ serviceWorker: false }))
  // registered when the page finishes loading if it is still loading now
  const loading = browser({ readyState: 'loading' })
  assert.equal(loading.calls.register.length, 0)
  loading.fire(loading.sandbox, 'load')
  assert.equal(loading.calls.register.length, 1)
  // a refused registration (bad certificate, private mode) is swallowed
  const refused = browser({ registerRejects: true })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(refused.calls.register.length, 1)
})

test('client: iPhone Safari gets a plain-language Share > Add to Home Screen hint, dismissible and remembered', () => {
  const storage = {}
  const b = browser({ ua: IOS_SAFARI, platform: 'iPhone', maxTouchPoints: 5, storage })
  const banner = b.main.children[0]
  assert.ok(banner && banner.className === 'beebo-install', 'the hint is the first thing in the page content')
  assert.match(banner.children[0].innerHTML, /Share/)
  assert.match(banner.children[0].innerHTML, /Add to Home Screen/)
  assert.equal(banner.children[1].children.length, 1, 'just a dismiss button: there is no Install button to press on iOS')
  banner.children[1].children[0].click()
  assert.equal(b.main.children.length, 0, 'dismissed')
  assert.ok(Number(storage['beebo:pwa:install-dismissed']) > 0, 'and remembered')
  assert.equal(browser({ ua: IOS_SAFARI, platform: 'iPhone', maxTouchPoints: 5, storage }).main.children.length, 0, 'not shown again')
  // after ninety quiet days it may ask once more
  const old = { 'beebo:pwa:install-dismissed': String(Date.now() - 91 * 24 * 3600 * 1000) }
  assert.equal(browser({ ua: IOS_SAFARI, platform: 'iPhone', maxTouchPoints: 5, storage: old }).main.children.length, 1)
})

test('client: iPadOS Safari (which says "Macintosh") gets the hint; iOS Chrome, desktop and installed copies do not', () => {
  assert.equal(browser({ ua: IPAD_SAFARI, platform: 'MacIntel', maxTouchPoints: 5 }).main.children.length, 1)
  assert.equal(browser({ ua: IPAD_SAFARI, platform: 'MacIntel', maxTouchPoints: 0 }).main.children.length, 0, 'a real Mac is not an iPad')
  assert.equal(browser({ ua: IOS_CHROME, platform: 'iPhone', maxTouchPoints: 5 }).main.children.length, 0)
  assert.equal(browser({ ua: DESKTOP_CHROME }).main.children.length, 0)
  const installed = browser({ ua: IOS_SAFARI, platform: 'iPhone', maxTouchPoints: 5, navStandalone: true })
  assert.equal(installed.main.children.length, 0, 'already running from the home screen')
  assert.ok(installed.html.classList.contains('beebo-standalone'))
  const display = browser({ ua: DESKTOP_CHROME, standalone: true })
  assert.ok(display.html.classList.contains('beebo-standalone'), 'display-mode: standalone is honoured too')
  assert.equal(browser({ ua: DESKTOP_CHROME }).html.classList.contains('beebo-standalone'), false)
})

test('client: Chrome-style browsers get a real Install button that uses the browser\'s own prompt', () => {
  const b = browser({})
  let prevented = 0
  const event = { preventDefault() { prevented++ }, prompt() { b.calls.prompts++; return Promise.resolve() }, userChoice: Promise.resolve({ outcome: 'accepted' }) }
  b.fire(b.sandbox, 'beforeinstallprompt', event)
  assert.equal(prevented, 1, 'the browser\'s mini-infobar is replaced by our banner')
  const banner = b.main.children[0]
  assert.equal(banner.className, 'beebo-install')
  const [go, no] = banner.children[1].children
  assert.equal(go.textContent, 'Install')
  go.click()
  assert.equal(b.calls.prompts, 1)
  assert.equal(b.main.children.length, 0, 'the banner gets out of the way when the prompt opens')
  // dismiss path
  const c = browser({})
  c.fire(c.sandbox, 'beforeinstallprompt', { preventDefault() {}, prompt() {}, userChoice: Promise.resolve() })
  c.main.children[0].children[1].children[1].click()
  assert.equal(c.main.children.length, 0)
  assert.ok(c.storage['beebo:pwa:install-dismissed'])
  // once dismissed, a later prompt event shows nothing
  const d = browser({ storage: c.storage })
  d.fire(d.sandbox, 'beforeinstallprompt', { preventDefault() {}, prompt() {} })
  assert.equal(d.main.children.length, 0)
  // an app that is already installed hides the banner and remembers
  const e = browser({})
  e.fire(e.sandbox, 'beforeinstallprompt', { preventDefault() {}, prompt() {} })
  e.fire(e.sandbox, 'appinstalled')
  assert.equal(e.main.children.length, 0)
  assert.ok(e.storage['beebo:pwa:install-dismissed'])
})

test('client: blocked storage never breaks the page or the helper', () => {
  const b = browser({ ua: IOS_SAFARI, platform: 'iPhone', maxTouchPoints: 5, storageThrows: true })
  assert.equal(b.main.children.length, 1, 'still shown when nothing can be remembered')
  assert.doesNotThrow(() => b.main.children[0].children[1].children[0].click())
  assert.equal(b.main.children.length, 0)
})

test('client: lock-screen controls follow whatever is playing: state, position, and play/pause/seek buttons', async () => {
  const a = audioEl()
  const b = browser({ mediaEls: [a] })
  assert.equal(b.nav.audioSession.type, 'auto', 'nothing happens until something plays')
  a.paused = false
  await b.media('play', a)
  assert.equal(b.nav.audioSession.type, 'playback', 'iOS: keeps playing when locked and ignores the silent switch')
  assert.equal(b.ms.playbackState, 'playing')
  assert.equal(b.ms.metadata.title, 'Music', 'a fallback title when the page set none')
  assert.equal(b.ms.metadata.artwork[0].src, '/pwa/icon-192.png')
  await b.media('timeupdate', a)
  assert.deepEqual(JSON.parse(JSON.stringify(b.calls.positions.at(-1))), { duration: 200, playbackRate: 1, position: 10 })
  for (const name of ['play', 'pause', 'stop', 'seekto']) assert.equal(typeof b.calls.setHandlers[name], 'function', name)
  assert.equal(b.calls.setHandlers.seekbackward, undefined, 'music keeps previous/next song on the lock screen, not +-10 s')
  // the lock-screen buttons drive the element that is playing
  b.calls.setHandlers.pause()
  assert.equal(a.paused, true)
  await b.media('pause', a)
  assert.equal(b.ms.playbackState, 'paused')
  b.calls.setHandlers.play()
  assert.equal(a.paused, false)
  assert.equal(a.played, 1)
  b.calls.setHandlers.seekto({ seekTime: 42 })
  assert.equal(a.currentTime, 42)
  // song-to-song handover: the old element pauses, the spare plays: the state ends as playing
  const spare = audioEl({ paused: false })
  a.paused = true
  b.doc.querySelectorAll = () => [spare]
  await b.media('pause', a)
  await b.media('play', spare)
  assert.equal(b.ms.playbackState, 'playing')
  b.calls.setHandlers.seekto({ seekTime: 7 })
  assert.equal(spare.currentTime, 7, 'the buttons now drive the spare')
})

test('client: video gets the +-10 s buttons, unknown durations are never reported, camera previews are ignored', async () => {
  const v = videoEl({ paused: false })
  const b = browser({ mediaEls: [v] })
  await b.media('play', v)
  assert.equal(typeof b.calls.setHandlers.seekbackward, 'function')
  assert.equal(typeof b.calls.setHandlers.seekforward, 'function')
  b.calls.setHandlers.seekforward({ seekOffset: 30 })
  assert.equal(v.currentTime, 40)
  b.calls.setHandlers.seekbackward({})
  assert.equal(v.currentTime, 30)
  b.calls.setHandlers.seekto({ seekTime: 5, fastSeek: true })
  assert.equal(v.currentTime, 5)
  const live = videoEl({ paused: false, duration: Infinity })
  const c = browser({ mediaEls: [live] })
  await c.media('play', live)
  await c.media('timeupdate', live)
  assert.equal(c.calls.positions.length, 0, 'an endless stream has no position to show')
  const camera = videoEl({ paused: false, srcObject: {} })
  const d = browser({ mediaEls: [camera] })
  await d.media('play', camera)
  assert.equal(d.nav.audioSession.type, 'auto', 'a webcam preview is not media the lock screen should control')
  assert.equal(Object.keys(d.calls.setHandlers).length, 0)
})

test('client: a page that already set its own metadata keeps it, and missing APIs never throw', async () => {
  const a = audioEl({ paused: false })
  const own = { title: 'Song', artist: 'Artist' }
  const b = browser({ mediaEls: [a], existingMetadata: own })
  await b.media('play', a)
  assert.equal(b.ms.metadata, own)
  const bare = browser({ mediaEls: [a], session: false, audioSession: false, mediaMetadata: false })
  await assert.doesNotReject(bare.media('play', a))
  const noMeta = browser({ mediaEls: [a], mediaMetadata: false })
  await assert.doesNotReject(noMeta.media('play', a))
})

test('client: the video player script only reports state and position, and leaves its own lock-screen buttons alone', async () => {
  const v = videoEl({ paused: false })
  const script = pwa.playerScript().replace(/^<script>/, '').replace(/<\/script>$/, '')
  const own = { title: 'A Film' }
  const b = browser({ script, mediaEls: [v], existingMetadata: own })
  await b.media('play', v)
  assert.equal(b.ms.playbackState, 'playing')
  await b.media('timeupdate', v)
  assert.equal(b.calls.positions.at(-1).duration, 200)
  assert.equal(Object.keys(b.calls.setHandlers).length, 0, 'no handlers: the player registers its own')
  assert.equal(b.ms.metadata, own)
  assert.equal(b.main.children.length, 0, 'no install banner over a video')
  // screen-off: the video pauses and a separate audio element carries on: still reported as playing
  const bg = audioEl({ paused: false })
  v.paused = true
  b.doc.querySelectorAll = () => [v, bg]
  await b.media('pause', v)
  await b.media('play', bg)
  assert.equal(b.ms.playbackState, 'playing')
})

test('client scripts are plain scripts: no external addresses, no tracking, no network calls of their own', () => {
  for (const source of [pwa.bodyMarkup(), pwa.playerScript()]) {
    assert.ok(!/https?:\/\/|fetch\(|XMLHttpRequest|sendBeacon|WebSocket|document\.cookie|eval\(|new Function|import\(/.test(source), 'nothing that talks to anyone')
  }
})
