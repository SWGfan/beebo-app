'use strict'
// The preferences profile end to end against a real server: one door for every client (/api/prefs with a bearer
// token, /appearance/prefs with the cookie session), synced across a person's devices, applied server-side on
// the very next page (nothing flashes), isolated per person, and safe against hostile input.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const auth = require('../electron/auth')
const server = require('../electron/streamServer')
const { testPort } = require('./helpers/testPort')

const PASSWORD = 'Prefs-test-password-77'
const SECRET = crypto.randomBytes(32).toString('hex')

async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'beebo-prefs-'))
  const moviesDir = path.join(root, 'movies')
  await fsp.mkdir(moviesDir)
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
    await fsp.rm(root, { recursive: true, force: true })
  })
  const base = 'http://127.0.0.1:' + info.port
  let ready = false
  for (let i = 0; i < 50; i++) {
    try { await (await fetch(base + '/api/ping')).arrayBuffer(); ready = true; break } catch { await new Promise((r) => setTimeout(r, 50)) }
  }
  assert.equal(ready, true, 'fixture server started')
  const cookies = Object.fromEntries(data.authUsers.map((u) => [u.id, auth.signSession(store, u.id)]))
  const tokens = Object.fromEntries(data.authUsers.map((u) => [u.id, server.makeApiToken(store, u.id)]))
  async function send(headers, method, route, body) {
    const response = await fetch(base + route, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' })
    const text = await response.text()
    let json = null
    try { json = JSON.parse(text) } catch {}
    return { status: response.status, text, json, headers: response.headers }
  }
  // a phone / TV app: bearer token
  const api = (who, method, route, body, extra = {}) => send({ ...(who ? { Authorization: 'Bearer ' + tokens[who] } : {}), ...extra }, method, route, body)
  // the website in a browser: session cookie (same-origin JSON only)
  const web = (who, method, route, body, extra = {}) => send({ ...(who ? { Cookie: 'beebo_session=' + cookies[who] } : {}), Origin: base, ...extra }, method, route, body)
  const page = (who, route) => send(who ? { Cookie: 'beebo_session=' + cookies[who] } : {}, 'GET', route)
  return { data, store, base, api, web, page }
}

const htmlTag = (text) => /<html lang="en"([^>]*)>/.exec(text)?.[1] || ''
const head = (text) => text.slice(0, text.indexOf('<body'))

test('a person with nothing saved gets the original page: no extra attributes, no extra CSS', async (t) => {
  const f = await fixture(t)
  const page = await f.page('ann', '/appearance')
  assert.equal(page.status, 200)
  assert.equal(htmlTag(page.text), ' data-theme="midnight"')
  assert.ok(!/data-(density|card-style|poster-aspect|radius|font-scale|large-text|reduce-motion)/.test(head(page.text)))
  assert.ok(!head(page.text).includes('--ui-font-scale'))
})

test('GET /api/prefs: effective values, the schema and the packs, for a signed-in person; nothing without a token', async (t) => {
  const f = await fixture(t)
  const r = await f.api('ann', 'GET', '/api/prefs')
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
  assert.equal(r.json.personal, true)
  assert.equal(r.json.effective.layout.density, 'comfortable')
  assert.equal(r.json.packs.theme.length, 4)
  assert.equal(r.json.packs.layout.length, 3)
  assert.ok(r.json.schema.navItems.length > 10)
  assert.deepEqual(r.json.render, { attrs: {}, vars: {} })
  assert.equal((await f.api(null, 'GET', '/api/prefs')).status, 401)
  assert.ok([302, 401].includes((await f.web(null, 'GET', '/appearance/prefs')).status), 'signed out: redirected to sign in or refused')
})

test('sync: a change made from the phone (bearer) is on the very next web page for that person only, and vice versa', async (t) => {
  const f = await fixture(t)
  const saved = await f.api('ann', 'PATCH', '/api/prefs', { layout: { density: 'compact', cardStyle: 'flat', fontScale: 1.2 }, access: { reduceMotion: 'on' } })
  assert.equal(saved.status, 200, saved.text)
  assert.equal(saved.json.effective.layout.density, 'compact')
  assert.deepEqual(saved.json.render.attrs['data-density'], 'compact')
  // another device: the browser, cookie session
  const page = await f.page('ann', '/appearance')
  const tag = htmlTag(page.text)
  assert.match(tag, /data-density="compact"/)
  assert.match(tag, /data-card-style="flat"/)
  assert.match(tag, /data-font-scale="custom"/)
  assert.match(tag, /data-reduce-motion="1"/)
  assert.ok(head(page.text).includes(':root[data-density=compact] .beebo-main .grid{gap:10px!important}'))
  assert.ok(head(page.text).includes('--ui-font-scale:1.2;'))
  assert.ok(head(page.text).includes('animation:none!important'), 'reduce motion is wired into the stylesheet')
  // Bob never sees it
  const bob = await f.page('bob', '/appearance')
  assert.equal(htmlTag(bob.text), ' data-theme="midnight"')
  assert.equal((await f.api('bob', 'GET', '/api/prefs')).json.effective.layout.density, 'comfortable')
  // and the browser can change it too; the phone sees that
  const fromWeb = await f.web('ann', 'PATCH', '/appearance/prefs', { layout: { density: 'spacious' } })
  assert.equal(fromWeb.status, 200, fromWeb.text)
  assert.equal((await f.api('ann', 'GET', '/api/prefs')).json.effective.layout.density, 'spacious')
})

test('optimistic concurrency over HTTP: a stale If-Match is a 409 that changes nothing', async (t) => {
  const f = await fixture(t)
  const first = await f.api('ann', 'PATCH', '/api/prefs', { layout: { density: 'compact' } })
  const rev = first.json.rev
  const ok = await f.api('ann', 'PATCH', '/api/prefs', { layout: { density: 'spacious' } }, { 'If-Match': rev })
  assert.equal(ok.status, 200)
  const stale = await f.api('ann', 'PATCH', '/api/prefs', { layout: { density: 'compact' } }, { 'If-Match': rev })
  assert.equal(stale.status, 409)
  assert.equal(stale.json.error, 'conflict')
  assert.equal((await f.api('ann', 'GET', '/api/prefs')).json.effective.layout.density, 'spacious')
  const viaBody = await f.api('ann', 'POST', '/api/prefs', { layout: { density: 'compact' }, ifMatch: rev })
  assert.equal(viaBody.status, 409, 'POST with ifMatch in the body behaves the same')
})

test('invalid input is a 400 with reasons, and nothing is stored', async (t) => {
  const f = await fixture(t)
  for (const body of [{ layout: { density: 'huge' } }, { layout: { evil: 1 } }, { nope: {} }, { theme: { custom: { '--bg': 'url(https://x)' } } }, {}, { layout: { sidebar: { order: ['movies', 'movies'] } } }]) {
    const r = await f.api('ann', 'PATCH', '/api/prefs', body)
    assert.equal(r.status, 400, JSON.stringify(body))
    assert.equal(r.json.ok, false)
    assert.ok(r.json.errors.length >= 1)
  }
  assert.equal(f.data.userPrefs, undefined)
  const notJson = await fetch(f.base + '/api/prefs', { method: 'PATCH', headers: { Authorization: 'Bearer ' + server.makeApiToken(f.store, 'ann'), 'Content-Type': 'text/plain' }, body: '{"layout":{"density":"compact"}}' })
  assert.equal(notJson.status, 415, 'writes must be JSON')
})

test('cookie twin is same-origin JSON only: a cross-site request or a form post is refused', async (t) => {
  const f = await fixture(t)
  const evil = await f.web('ann', 'PATCH', '/appearance/prefs', { layout: { density: 'compact' } }, { Origin: 'https://evil.example' })
  assert.ok([403, 415].includes(evil.status), 'refused: ' + evil.status)
  const site = await f.web('ann', 'PATCH', '/appearance/prefs', { layout: { density: 'compact' } }, { 'Sec-Fetch-Site': 'cross-site' })
  assert.ok([403, 415].includes(site.status), 'refused: ' + site.status)
  const form = await fetch(f.base + '/appearance/prefs', { method: 'POST', headers: { Cookie: 'beebo_session=' + auth.signSession(f.store, 'ann'), Origin: f.base, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'layout=compact' })
  assert.ok([403, 415].includes(form.status), 'refused: ' + form.status)
  assert.equal(f.data.userPrefs, undefined)
})

test('nav: the person\'s hidden items and order are applied to their sidebar server-side; Appearance can never be hidden; others are unaffected', async (t) => {
  const f = await fixture(t)
  const before = await f.page('ann', '/appearance')
  assert.ok(before.text.includes('href="/get-app"'))
  assert.ok(before.text.includes('href="/suggest"'))
  const set = await f.api('ann', 'PATCH', '/api/prefs', { layout: { sidebar: { order: ['tvshows', 'movies'], hidden: ['getapp', 'suggest', 'appearance', 'admin'] } } })
  assert.equal(set.status, 200, set.text)
  const after = await f.page('ann', '/appearance')
  const nav = /<aside class="beebo-sidebar"[\s\S]*?<\/aside>/.exec(after.text)[0]
  assert.ok(!nav.includes('href="/get-app"'), 'hidden')
  assert.ok(!nav.includes('href="/suggest"'), 'hidden')
  assert.ok(nav.includes('href="/appearance"'), 'the locked item stays so the way back always exists')
  assert.ok(nav.indexOf('href="/tvshows"') < nav.indexOf('href="/" class="beebo-nav-link"'), 'order applied: TV Shows before Movies')
  assert.ok(nav.indexOf('href="/" class="beebo-nav-link"') < nav.indexOf('href="/music"'), 'the rest follow in default order')
  // hiding an item is cosmetic: the admin page is still gated by the server, not by the menu
  const adminAsBob = await f.page('bob', '/admin')
  assert.notEqual(adminAsBob.status, 200)
  const bob = await f.page('bob', '/appearance')
  assert.ok(bob.text.includes('href="/get-app"'), 'Bob\'s sidebar is untouched')
})

test('safe mode (?safe=1) shows the page with none of the layout changes, so nothing can hide the way out', async (t) => {
  const f = await fixture(t)
  await f.api('ann', 'PATCH', '/api/prefs', { layout: { density: 'spacious', sidebar: { hidden: ['getapp'] } }, access: { largeText: true } })
  const safe = await f.page('ann', '/appearance?safe=1')
  assert.equal(htmlTag(safe.text), ' data-theme="midnight"')
  assert.ok(safe.text.includes('href="/get-app"'))
  assert.ok(safe.text.includes('id="appearance-reset"'), 'the fixed-color reset box is still there')
  const normal = await f.page('ann', '/appearance')
  assert.match(htmlTag(normal.text), /data-large-text="1"/)
})

test('reset over HTTP: one section or everything, DELETE or POST /reset', async (t) => {
  const f = await fixture(t)
  await f.api('ann', 'PATCH', '/api/prefs', { layout: { density: 'compact' }, access: { largeText: true } })
  const one = await f.api('ann', 'DELETE', '/api/prefs?section=layout')
  assert.equal(one.status, 200, one.text)
  const s = (await f.api('ann', 'GET', '/api/prefs')).json.effective
  assert.equal(s.layout.density, 'comfortable')
  assert.equal(s.access.largeText, true)
  const all = await f.web('ann', 'POST', '/appearance/prefs/reset', { section: 'all' })
  assert.equal(all.status, 200)
  assert.equal((await f.api('ann', 'GET', '/api/prefs')).json.effective.access.largeText, false)
  assert.equal((await f.api('ann', 'DELETE', '/api/prefs?section=bogus')).status, 400)
})

test('export -> import between two accounts over HTTP: preview first (a diff), then apply; identical result', async (t) => {
  const f = await fixture(t)
  await f.api('ann', 'PATCH', '/api/prefs', { layout: { density: 'spacious', radius: 20, home: { shelves: [{ id: 'trailers', on: true }, { id: 'recent', on: false }] } }, access: { largeText: true }, theme: { preset: 'ember', custom: { '--purple': '#2a9d8f' } } })
  const exported = await f.api('ann', 'GET', '/api/prefs/export')
  assert.equal(exported.status, 200)
  assert.equal(exported.json.filename, 'beebo.beebo-profile')
  assert.equal(exported.json.file.format, 'beebo-profile')
  const text = JSON.stringify(exported.json.file)
  assert.ok(!/"ann"|token|password/i.test(text))
  const dry = await f.api('bob', 'POST', '/api/prefs/import', { file: JSON.parse(text), dryRun: true })
  assert.equal(dry.status, 200, dry.text)
  assert.equal(dry.json.dryRun, true)
  assert.ok(dry.json.diff.length > 3)
  assert.equal(f.data.userPrefs?.bob, undefined, 'the preview stored nothing')
  const applied = await f.api('bob', 'POST', '/api/prefs/import', { file: JSON.parse(text) })
  assert.equal(applied.status, 200, applied.text)
  const bob = (await f.api('bob', 'GET', '/api/prefs')).json.effective
  const ann = (await f.api('ann', 'GET', '/api/prefs')).json.effective
  assert.deepEqual(bob, ann)
  // the raw file is also accepted as the body (no wrapper)
  const raw = await f.web('bob', 'POST', '/appearance/prefs/import?dryRun=1', JSON.parse(text))
  assert.equal(raw.status, 200, raw.text)
  assert.equal(raw.json.dryRun, true)
})

test('hostile files over HTTP are refused with 400 and change nothing (both doors)', async (t) => {
  const f = await fixture(t)
  const dir = path.join(__dirname, 'fixtures', 'packs', 'malicious')
  for (const file of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const body = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
    for (const door of [() => f.api('ann', 'POST', '/api/prefs/import', body), () => f.web('ann', 'POST', '/appearance/prefs/import', { file: body })]) {
      const r = await door()
      assert.equal(r.status, 400, file + ' ' + r.text.slice(0, 120))
      assert.equal(r.json.ok, false)
    }
  }
  const huge = await f.api('ann', 'POST', '/api/prefs/import', { format: 'beebo-profile', v: 1, profile: { junk: 'x'.repeat(300 * 1024) } })
  assert.equal(huge.status, 413)
  assert.equal(f.data.userPrefs, undefined)
  assert.equal(f.data.userThemes, undefined)
})

test('bundled packs apply over HTTP: layout and theme; a theme pack changes the phone browser bar color too', async (t) => {
  const f = await fixture(t)
  const layout = await f.api('bob', 'POST', '/api/prefs/pack', { kind: 'layout', id: 'beebo.cinematic-shelves' })
  assert.equal(layout.status, 200, layout.text)
  assert.equal(layout.json.effective.layout.density, 'spacious')
  const themed = await f.web('bob', 'POST', '/appearance/prefs/pack', { kind: 'theme', id: 'beebo.oled-black' })
  assert.equal(themed.status, 200, themed.text)
  const page = await f.page('bob', '/appearance')
  assert.match(page.text, /<meta name="theme-color" content="#000000">/)
  assert.ok(head(page.text).includes('--bg:#000000;'))
  assert.match(htmlTag(page.text), /data-card-style="floating"/)
  assert.equal((await f.api('bob', 'POST', '/api/prefs/pack', { kind: 'theme', id: 'nope' })).status, 404)
  assert.equal((await f.api('bob', 'POST', '/api/prefs/pack', { kind: 'script', id: 'x' })).status, 400)
})

test('preview and the contrast checker answer without saving anything', async (t) => {
  const f = await fixture(t)
  const p = await f.api('ann', 'POST', '/api/prefs/preview', { layout: { density: 'compact' }, access: { largeText: true } })
  assert.equal(p.status, 200, p.text)
  assert.match(p.json.attrs, /data-density="compact"/)
  assert.match(p.json.css, /--ui-font-scale:1\.25;/)
  assert.equal(f.data.userPrefs, undefined)
  const c = await f.api('ann', 'POST', '/api/prefs/theme-check', { preset: 'graphite', custom: { '--text': '#6b6c72' } })
  assert.equal(c.status, 200, c.text)
  assert.ok(c.json.warnings.length >= 1)
  assert.equal(c.json.fixable, true)
  assert.equal((await f.api('ann', 'POST', '/api/prefs/theme-check', { preset: 'graphite', custom: { '--text': 'url(x)' } })).status, 400)
})

test('household defaults: only an admin sets them; they reach people who have not chosen', async (t) => {
  const f = await fixture(t)
  assert.equal((await f.api('bob', 'PUT', '/api/prefs/household', { layout: { density: 'spacious' } })).status, 403)
  const set = await f.api('ann', 'PUT', '/api/prefs/household', { layout: { density: 'spacious' } })
  assert.equal(set.status, 200, set.text)
  const bob = await f.page('bob', '/appearance')
  assert.match(htmlTag(bob.text), /data-density="spacious"/)
  await f.api('bob', 'PATCH', '/api/prefs', { layout: { density: 'compact' } })
  assert.match(htmlTag((await f.page('bob', '/appearance')).text), /data-density="compact"/, 'his own choice wins')
  assert.equal((await f.api('bob', 'GET', '/api/prefs/household')).json.household.layout.density, 'spacious')
})

test('the /appearance page carries the Layout and accessibility section with the pack buttons and a preview hook', async (t) => {
  const f = await fixture(t)
  const page = await f.page('ann', '/appearance')
  assert.ok(page.text.includes('id="prefs-section"'))
  for (const name of ['Classic', 'Cinematic shelves', 'Compact library', 'High contrast', 'OLED black']) assert.ok(page.text.includes('>' + name + '<'), name)
  assert.ok(page.text.includes('name="reduceMotion"') && page.text.includes('name="largeText"'))
  assert.ok(page.text.includes('/appearance/prefs'))
  assert.ok(page.text.includes('id="appearance-reset"'), 'the reset box is still present after the new section')
})

test('the inline script on the Appearance page is syntactically valid and uses only textContent for messages', () => {
  const { CLIENT } = require('../electron/prefsWeb')
  assert.doesNotThrow(() => new Function(CLIENT))
  assert.ok(!/innerHTML|outerHTML|document\.write|eval\(/.test(CLIENT), 'no HTML injection path in the page script')
  assert.ok(CLIENT.includes('textContent'))
})

test('preferences are not part of the public /api/v1 contract', async (t) => {
  const f = await fixture(t)
  await f.api('ann', 'PATCH', '/api/prefs', { layout: { density: 'compact' } })
  const r = await f.api('ann', 'GET', '/api/v1/prefs')
  assert.ok([401, 403, 404].includes(r.status))
  assert.ok(!r.text.includes('compact'))
})

test('deleting an account purges its preferences', async (t) => {
  const f = await fixture(t)
  await f.api('bob', 'PATCH', '/api/prefs', { layout: { density: 'compact' } })
  await f.api('ann', 'PATCH', '/api/prefs', { layout: { density: 'spacious' } })
  assert.deepEqual(Object.keys(f.data.userPrefs).sort(), ['ann', 'bob'])
  require('../electron/userDeletion').purgeUserData(f.store, 'bob')
  assert.deepEqual(Object.keys(f.data.userPrefs), ['ann'])
})
