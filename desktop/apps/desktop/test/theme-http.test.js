'use strict'
// Themes end to end against a real server: rendered server-side (no flash of the wrong theme), stored per
// person, changed through /appearance (cookie) and /api/theme (bearer), reset from an always-readable box.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const auth = require('../electron/auth')
const server = require('../electron/streamServer')
const theme = require('../electron/theme')
const userDeletion = require('../electron/userDeletion')
const { testPort } = require('./helpers/testPort')

const PASSWORD = 'Theme-test-password-77'
const SECRET = crypto.randomBytes(32).toString('hex')

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'beebo-theme-'))
  const moviesDir = path.join(root, 'movies')
  await fs.mkdir(moviesDir)
  const data = { authUsers: [
    { id: 'ann', name: 'Ann', username: 'ann', status: 'approved', isAdmin: true, passwordHash: auth.hashPassword(PASSWORD) },
    { id: 'bob', name: 'Bob', username: 'bob', status: 'approved', passwordHash: auth.hashPassword(PASSWORD) }
  ] }
  const store = { get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] }, onDidChange: () => () => {} }
  auth.forgetSecrets(); server.forgetSecrets()
  const info = server.startStreamServer({
    port: testPort(),
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
  const tokens = Object.fromEntries(data.authUsers.map((u) => [u.id, server.makeApiToken(store, u.id)]))
  async function web(who, route, body, headers = {}) {
    const isForm = typeof body === 'string'
    const response = await fetch(base + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(who ? { Cookie: 'beebo_session=' + cookies[who] } : {}), ...(body === undefined ? {} : { 'Content-Type': isForm ? 'application/x-www-form-urlencoded' : 'application/json' }), ...headers },
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
      redirect: 'manual'
    })
    const text = await response.text()
    let json = null
    try { json = JSON.parse(text) } catch {}
    return { status: response.status, text, json, headers: response.headers }
  }
  async function api(who, route, body) {
    const response = await fetch(base + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: 'Bearer ' + tokens[who] } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    const text = await response.text()
    let json = null
    try { json = JSON.parse(text) } catch {}
    return { status: response.status, json, text }
  }
  return { data, store, base, web, api }
}

const htmlTag = (text) => /<html lang="en" data-theme="([^"]*)"/.exec(text)?.[1]
const themeColor = (text) => /<meta name="theme-color" content="([^"]*)"/.exec(text)?.[1]

test('default: a page with nothing saved renders the original theme, with no preset css', async (t) => {
  const f = await fixture(t)
  const page = await f.web('ann', '/appearance')
  assert.equal(page.status, 200)
  assert.equal(htmlTag(page.text), 'midnight')
  assert.equal(themeColor(page.text), '#182033')
  assert.ok(page.text.includes(':root{color-scheme:dark;--bg:#080b14;'), 'the stylesheet defaults are inlined')
  assert.ok(!/<head>[\s\S]*?:root\[data-theme="[a-z]+"\]\{color-scheme/.test(page.text.slice(0, page.text.indexOf('<body'))), 'no preset block in <head> for the default')
  assert.ok(!page.text.slice(0, page.text.indexOf('<body')).includes(':root[data-theme]{'), 'no custom block in <head> for the default')
  assert.match(page.text, /href="\/appearance" class="beebo-nav-link" aria-current="page"/, 'Appearance is in the navigation and marked current')
  assert.equal(page.headers.get('cache-control'), 'no-store')
})

test('a signed-out page (login) renders the default theme and carries no one\'s settings', async (t) => {
  const f = await fixture(t)
  await f.web('ann', '/appearance', { theme: 'daylight' }, { Origin: f.base })
  const login = await f.web(null, '/login')
  assert.equal(login.status, 200)
  assert.equal(htmlTag(login.text), 'midnight')
  assert.ok(!login.text.includes('data-theme="daylight"'))
})

test('choosing a theme is stored per person and applied on the very next render, server-side', async (t) => {
  const f = await fixture(t)
  const saved = await f.web('ann', '/appearance', { theme: 'daylight' }, { Origin: f.base })
  assert.equal(saved.status, 200, saved.text)
  assert.equal(saved.json.ok, true)
  assert.equal(saved.json.theme, 'daylight')
  assert.equal(saved.json.scheme, 'light')
  // persistence: one map, keyed by user id, holding only validated values
  assert.deepEqual(Object.keys(f.data.userThemes), ['ann'])
  assert.equal(f.data.userThemes.ann.theme, 'daylight')
  assert.deepEqual(f.data.userThemes.ann.custom, {})
  // Ann's pages: attribute, theme-color and the preset block are all in the HTML before any script runs
  for (const route of ['/appearance', '/viewing-privacy']) {
    const page = await f.web('ann', route)
    assert.equal(page.status, 200, route)
    const head = page.text.slice(0, page.text.indexOf('<body'))
    assert.equal(htmlTag(page.text), 'daylight', route)
    assert.equal(themeColor(page.text), theme.PRESETS.daylight.themeColor)
    assert.ok(head.includes(theme.presetCss('daylight')), route + ' has the daylight block in <head>')
    assert.ok(head.includes('color-scheme:light'))
    assert.ok(!head.includes(':root[data-theme="ember"]'), 'only the chosen preset is inlined')
  }
  // Bob is untouched
  const bob = await f.web('bob', '/viewing-privacy')
  assert.equal(htmlTag(bob.text), 'midnight')
  assert.ok(!bob.text.slice(0, bob.text.indexOf('<body')).includes('data-theme="daylight"'))
  assert.equal(f.data.userThemes.bob, undefined)
})

test('setting persists across server restarts of the store and survives re-reading', async (t) => {
  const f = await fixture(t)
  await f.web('bob', '/appearance', { theme: 'ember', custom: '--purple: #2a9d8f;' }, { Origin: f.base })
  const persisted = JSON.parse(JSON.stringify(f.data.userThemes))
  assert.deepEqual(theme.getUserTheme({ get: () => persisted }, 'bob'), { theme: 'ember', custom: { '--purple': '#2a9d8f' } })
  const again = await f.web('bob', '/viewing-privacy')
  assert.equal(htmlTag(again.text), 'ember')
  assert.ok(again.text.includes(':root[data-theme]{--purple:#2a9d8f;}'))
})

test('custom overrides are validated, stored as pairs, and emitted as a server-built block after the preset', async (t) => {
  const f = await fixture(t)
  const saved = await f.web('ann', '/appearance', { theme: 'graphite', custom: '--accent-grad-1: RGB(1, 2, 3);\n--radius-card: 20px;' }, { Origin: f.base })
  assert.equal(saved.status, 200, saved.text)
  assert.equal(saved.json.customText, '--accent-grad-1: rgb(1,2,3);\n--radius-card: 20px;')
  assert.deepEqual(f.data.userThemes.ann.custom, { '--accent-grad-1': 'rgb(1,2,3)', '--radius-card': '20px' })
  const page = await f.web('ann', '/viewing-privacy')
  const head = page.text.slice(0, page.text.indexOf('<body'))
  const preset = head.indexOf(':root[data-theme="graphite"]')
  const custom = head.indexOf(':root[data-theme]{--accent-grad-1:rgb(1,2,3);--radius-card:20px;}')
  assert.ok(preset > 0 && custom > preset, 'the custom block comes after the preset block')
  assert.ok(!page.text.includes('RGB(1, 2, 3)'), 'the person\'s spelling is never echoed into the stylesheet')
  // the textarea shows the canonical text
  const form = await f.web('ann', '/appearance')
  assert.ok(form.text.includes('--accent-grad-1: rgb(1,2,3);\n--radius-card: 20px;</textarea>'))
})

test('hostile custom text is refused with messages and nothing is stored or rendered', async (t) => {
  const f = await fixture(t)
  await f.web('ann', '/appearance', { theme: 'ember' }, { Origin: f.base })
  const before = JSON.stringify(f.data.userThemes)
  for (const custom of [
    '--bg: red;}body{display:none',
    '--bg: #fff;}body{display:none}',
    '--bg: url(javascript:alert(1));',
    '--bg: \\75rl(x);',
    '@import url(https://evil.example/x.css);',
    '--bg: #fff /* c */;',
    '--evil: #fff;',
    '--bg: #ｆff;',
    '</style><script>alert(1)</script>',
    '--bg: #fff;'.repeat(400) // 4,800 characters: over the 4,000 cap, under the request-body cap
  ]) {
    const out = await f.web('ann', '/appearance', { theme: 'ember', custom }, { Origin: f.base })
    assert.equal(out.status, 400, JSON.stringify(custom).slice(0, 60))
    assert.equal(out.json.ok, false)
    assert.equal(out.json.error, 'invalid_custom')
    assert.ok(Array.isArray(out.json.errors) && out.json.errors.length >= 1)
    assert.equal(JSON.stringify(f.data.userThemes), before, 'nothing changed')
  }
  const page = await f.web('ann', '/viewing-privacy')
  assert.ok(!/body\{display:none|evil\.example|javascript:|<script>alert/i.test(page.text.slice(0, page.text.indexOf('<body'))))
})

test('a custom theme that would make the page unreadable is refused', async (t) => {
  const f = await fixture(t)
  const out = await f.web('ann', '/appearance', { theme: 'midnight', custom: '--text: #080b14;' }, { Origin: f.base })
  assert.equal(out.status, 400)
  assert.equal(out.json.error, 'unreadable')
  assert.match(out.json.errors[0], /--text on --bg/)
  assert.equal(f.data.userThemes, undefined)
  // changing to a light preset while an old dark custom bg is saved is also caught
  await f.web('ann', '/appearance', { theme: 'midnight', custom: '--bg: #000000;' }, { Origin: f.base })
  const clash = await f.web('ann', '/appearance', { theme: 'daylight' }, { Origin: f.base })
  assert.equal(clash.status, 400)
  assert.equal(f.data.userThemes.ann.theme, 'midnight')
})

test('unknown themes and malformed bodies are rejected without touching the store', async (t) => {
  const f = await fixture(t)
  for (const body of [{ theme: 'nope' }, { theme: '__proto__' }, { theme: '"><script>' }, { theme: 5 }, { theme: ['daylight'] }, { custom: 5 }, { custom: { '--bg': '#fff' } }]) {
    const out = await f.web('ann', '/appearance', body, { Origin: f.base })
    assert.equal(out.status, 400, JSON.stringify(body))
  }
  assert.equal(f.data.userThemes, undefined)
})

test('cross-site and non-JSON writes are refused; the reset form refuses cross-site posts too', async (t) => {
  const f = await fixture(t)
  await f.web('ann', '/appearance', { theme: 'ember' }, { Origin: f.base })
  for (const headers of [{ Origin: 'https://evil.example.test' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Content-Type': 'application/x-www-form-urlencoded' }]) {
    const out = await f.web('ann', '/appearance', { theme: 'graphite' }, headers)
    // Refused either by the shared cookie-write guard (403 cross_site) or by the route (415 json_only).
    assert.ok([403, 415].includes(out.status), JSON.stringify(headers) + ' -> ' + out.status)
    if (!headers['Content-Type']) {
      const reset = await f.web('ann', '/appearance/reset', 'x=1', headers)
      assert.equal(reset.status, 403, JSON.stringify(headers))
    }
  }
  // a body over the request cap is not silently "saved" as nothing
  const huge = await f.web('ann', '/appearance', { theme: 'graphite', custom: '--bg: #fff;'.repeat(5000) }, { Origin: f.base })
  assert.equal(huge.status, 400)
  assert.equal(huge.json.error, 'nothing_to_change')
  assert.equal((await f.web('ann', '/appearance', {}, { Origin: f.base })).status, 400)
  assert.equal(f.data.userThemes.ann.theme, 'ember', 'still ember')
  assert.equal((await f.web(null, '/appearance', { theme: 'graphite' }, { Origin: f.base })).status, 302, 'signed out: sent to the sign-in page')
  assert.equal((await f.web(null, '/appearance')).status, 302)
})

test('Reset to default is a plain form post that works, redirects back, and removes the stored entry', async (t) => {
  const f = await fixture(t)
  await f.web('ann', '/appearance', { theme: 'ember', custom: '--purple: #2a9d8f;' }, { Origin: f.base })
  await f.web('bob', '/appearance', { theme: 'graphite' }, { Origin: f.base })
  const reset = await f.web('ann', '/appearance/reset', 'x=1')
  assert.equal(reset.status, 303)
  assert.equal(reset.headers.get('location'), '/appearance')
  assert.deepEqual(Object.keys(f.data.userThemes), ['bob'], 'only Ann\'s entry is gone')
  const page = await f.web('ann', '/viewing-privacy')
  assert.equal(htmlTag(page.text), 'midnight')
  assert.equal((await f.web('ann', '/appearance/reset')).status, 405, 'GET never resets')
  // last entry removed: the whole key goes, leaving a clean store
  await f.web('bob', '/appearance/reset', 'x=1')
  assert.equal(f.data.userThemes, undefined)
})

test('the Reset box is on the page in every state, uses no theme variables, and safe mode ignores the saved theme', async (t) => {
  const f = await fixture(t)
  for (const setup of [null, { theme: 'daylight' }, { theme: 'ember', custom: '--text: #ffffff; --bg: #ffffff;' }]) {
    if (setup && setup.custom) {
      // bypass the readability guard to simulate an unreadable value already sitting in the store
      f.data.userThemes = { ann: { theme: 'ember', custom: { '--text': '#ffffff', '--bg': '#ffffff', '--panel': '#ffffff', '--muted': '#ffffff', '--link': '#ffffff' } } }
    } else if (setup) await f.web('ann', '/appearance', setup, { Origin: f.base })
    const page = await f.web('ann', '/appearance')
    const box = /<div id="appearance-reset"[\s\S]*?<\/form>/.exec(page.text)
    assert.ok(box, 'reset box present')
    assert.ok(box[0].includes('action="/appearance/reset"'))
    assert.ok(!/var\(--|class=/.test(box[0]), 'no theme variable or stylesheet class inside the box')
    assert.match(box[0], /background:#ffffff;color:#000000/)
    assert.ok(page.text.includes('href="/appearance?safe=1"'), 'link to safe mode')
  }
  // ann's saved state is the unreadable one now; safe mode renders default colors and leaves the store alone
  const stored = JSON.stringify(f.data.userThemes)
  const safe = await f.web('ann', '/appearance?safe=1')
  assert.equal(htmlTag(safe.text), 'midnight')
  assert.ok(!safe.text.slice(0, safe.text.indexOf('<body')).includes(':root[data-theme]{'), 'the unreadable custom block is not emitted in safe mode')
  assert.match(safe.text, /Safe mode: this page is showing the default colors/)
  assert.equal(JSON.stringify(f.data.userThemes), stored)
  // and the normal view of that saved state does carry it (so the box is what saves the day)
  const normal = await f.web('ann', '/appearance')
  assert.ok(normal.text.includes(':root[data-theme]{--bg:#ffffff;--panel:#ffffff;'))
})

test('/api/theme: bearer clients read the catalog and choose, customize and reset', async (t) => {
  const f = await fixture(t)
  assert.equal((await f.api(null, '/api/theme')).status, 401)
  const initial = await f.api('bob', '/api/theme')
  assert.equal(initial.status, 200)
  assert.equal(initial.json.theme, 'midnight')
  assert.deepEqual(initial.json.themes.map((x) => x.id), theme.PRESET_IDS)
  assert.equal(initial.json.variables.length, theme.TOKENS.length)
  assert.ok(initial.json.variables.every((v) => v.name.startsWith('--') && v.type && v.default !== undefined))
  const chosen = await f.api('bob', '/api/theme', { theme: 'daylight', custom: '--purple: #123456;' })
  assert.equal(chosen.status, 200, chosen.text)
  assert.equal(chosen.json.theme, 'daylight')
  assert.equal(chosen.json.customText, '--purple: #123456;')
  assert.equal((await f.api('bob', '/api/theme')).json.theme, 'daylight')
  assert.equal((await f.web('bob', '/viewing-privacy')).text.match(/data-theme="([a-z]+)"/)[1], 'daylight', 'the API change shows in the browser too')
  const bad = await f.api('bob', '/api/theme', { theme: 'daylight', custom: 'body{display:none}' })
  assert.equal(bad.status, 400)
  assert.equal(bad.json.error, 'invalid_custom')
  assert.equal((await f.api('bob', '/api/theme')).json.customText, '--purple: #123456;', 'a rejected change leaves the last good one')
  const partial = await f.api('bob', '/api/theme', { theme: 'ember' })
  assert.equal(partial.json.customText, '--purple: #123456;', 'omitted fields are kept')
  const reset = await f.api('bob', '/api/theme', { reset: true })
  assert.equal(reset.status, 200)
  assert.equal(reset.json.theme, 'midnight')
  assert.equal(reset.json.customText, '')
  assert.equal(f.data.userThemes, undefined)
  const wrongType = await fetch(f.base + '/api/theme', { method: 'POST', headers: { Authorization: 'Bearer ' + (await f.api('bob', '/api/theme')) && 'x', 'Content-Type': 'text/plain' }, body: '{}' })
  assert.ok([401, 415].includes(wrongType.status))
  assert.equal((await fetch(f.base + '/api/theme', { method: 'DELETE', headers: { Authorization: 'Bearer ' + server.makeApiToken(f.store, 'bob') } })).status, 405)
})

test('deleting a person removes their theme; other people keep theirs', async (t) => {
  const f = await fixture(t)
  await f.web('ann', '/appearance', { theme: 'ember' }, { Origin: f.base })
  await f.web('bob', '/appearance', { theme: 'graphite' }, { Origin: f.base })
  userDeletion.purgeUserData(f.store, 'bob')
  assert.deepEqual(Object.keys(f.data.userThemes), ['ann'])
})

test('the phone install and Android WebView see the same server-rendered attribute (no client script decides the theme)', async (t) => {
  const f = await fixture(t)
  await f.web('ann', '/appearance', { theme: 'daylight' }, { Origin: f.base })
  const page = await f.web('ann', '/viewing-privacy', undefined, { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebView Beebo' })
  assert.equal(htmlTag(page.text), 'daylight')
  // the head, not a script, carries the theme: the inline scripts never write data-theme on load
  const scripts = [...page.text.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n')
  assert.ok(!/data-theme/.test(scripts.replace(/const original[\s\S]*?\n/, '')), 'no page script sets the theme on load')
})
