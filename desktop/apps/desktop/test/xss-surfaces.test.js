// Security review F2: stored XSS. Hostile strings (titles, names, notes, key names, requests...) are
// planted through the real write paths, then every server-rendered page that can show them is
// fetched as the owner and must contain none of them as live markup. Client-side renderers (the
// pages' own innerHTML code) are checked by running their escape helpers and by a source scan.
// Run: node --test test/xss-surfaces.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { withServer, localRequire } = require('./security-harness')
const hs = localRequire('./electron/httpSecurity')
const partyRoom = localRequire('./electron/partyRoom')

const LS = String.fromCharCode(0x2028)
const HOSTILE = {
  img: '<img src=x onerror=alert(1)>',
  script: '"><script>alert(2)</script>',
  quote: '" onmouseover="alert(3)',
  close: '</script><script>alert(4)</script>',
  svg: '<svg/onload=alert(5)>',
  ls: 'line' + LS + 'break'
}
// Any of these appearing in a page means a hostile string reached the browser as markup.
const LIVE = [/<img src=x onerror/i, /<script>alert\(/i, /<\/script><script>alert/i, /"\s*onmouseover="alert/i, /<svg\/onload/i, /">\s*<script>/i]
const combined = Object.values(HOSTILE).join(' ')

function assertInert(name, body) {
  for (const re of LIVE) assert.doesNotMatch(body, re, `${name}: hostile markup is live (${re})`)
  // (A raw U+2028 in HTML text is harmless; inside inline script data jsonForScript escapes it, tested above.)
  for (const m of body.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) assert.equal(m[1].includes(LS), false, `${name}: raw U+2028 inside an inline script`)
}

test('jsonForScript keeps data inside its <script> block', () => {
  for (const v of [HOSTILE.close, HOSTILE.img, HOSTILE.ls, combined, { title: HOSTILE.close, list: [HOSTILE.svg] }, 'plain', 42, null, undefined, true]) {
    const out = hs.jsonForScript(v)
    assert.doesNotMatch(out, /[<>&]/)
    assert.equal(out.includes(LS), false)
    if (v !== undefined) assert.deepEqual(JSON.parse(out), v)
  }
  const page = '<script>var t = ' + hs.jsonForScript(HOSTILE.close) + '</script>'
  assert.equal((page.match(/<\/script>/g) || []).length, 1, 'only the page\'s own closing tag')
})

test('cleanText + escapeHtml make every hostile string inert', () => {
  for (const h of Object.values(HOSTILE)) {
    assert.doesNotMatch(partyRoom.cleanText(h, 200), /[<>]/)
    assert.doesNotMatch(partyRoom.escapeHtml(h), /[<>"]/)
  }
})

// -------------------------------------------------- the pages, over HTTP ----

let bodies = {}
async function seedAndCrawl({ extraSeed } = {}) {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-xss-tmdb-'))
  const seen = {}
  bodies = {}
  try {
    fs.mkdirSync(path.join(cacheDir, 'posters'), { recursive: true })
    const manifest = {
      'Clip (2020).mp4': { id: 4242, title: HOSTILE.close + HOSTILE.img, release_date: '2020-01-01', poster_path: '/' + HOSTILE.quote, genre_ids: [28], overview: HOSTILE.script + HOSTILE.svg, vote_average: 7 }
    }
    fs.writeFileSync(path.join(cacheDir, 'manifest.json'), JSON.stringify(manifest))
    fs.writeFileSync(path.join(cacheDir, 'credits.json'), JSON.stringify({ 4242: [{ id: 1, name: HOSTILE.img, character: HOSTILE.script, profile_path: '/' + HOSTILE.quote }] }))
    await withServer({ agentSecret: 'a'.repeat(40), getTmdbCacheDir: () => cacheDir }, async (ctx) => {
      const { raw, api, store, auth, server, cookie } = ctx
      const admin = { cookie, 'x-beebo-agent-key': 'a'.repeat(40) }
      // ---- plant hostile data through the real write paths
      for (const [i, h] of Object.values(HOSTILE).entries()) {
        auth.createUser(store, h + i, `p${i}@example.com`)
        await api('POST', '/api/missing-request', { kind: 'movie', title: h, year: h, showName: h, collectionName: h, note: h })
        await api('POST', '/api/admin/api-keys/create', { name: h.slice(0, 40) }, { 'x-beebo-agent-key': 'a'.repeat(40) })
        await raw({ method: 'POST', pathname: '/request-access', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ name: h, email: `r${i}@example.com`, note: h }).toString() })
      }
      store.set('uploadHistory', Object.values(HOSTILE).map((h, i) => ({ id: 'up' + i + h, fileName: h + '.mp4', kind: 'tv', showName: h, uploadedBy: h, uploadedAt: Date.now(), destPath: path.join(os.tmpdir(), 'nope' + i) })))
      if (extraSeed) await extraSeed(ctx)
      // ---- crawl
      const id = server.encodeId('Clip (2020).mp4')
      const pages = ['/', '/tvshows', '/upload', '/music', '/photos', '/playlists', '/continue', '/surprise?kind=both', '/appearance', '/get-app', '/login', '/signup', '/request-access',
        '/watch?id=' + encodeURIComponent(id), '/subtitles', '/school/report']
      for (const tab of ['overview', 'users', 'requests', 'flags', 'missing', 'suggestions', 'inbox', 'titles', 'conversions', 'history', 'markers', 'apikeys', 'webhooks', 'backup', 'settings']) pages.push('/admin?tab=' + tab)
      for (const p of pages) {
        const r = await raw({ pathname: p, headers: admin })
        seen[p] = r.status
        bodies[p] = r.text
        assertInert(p, r.text)
      }
      // ---- JSON API answers are data, but must not be sniffable as HTML
      for (const p of ['/api/admin/missing', '/api/admin/users', '/api/admin/api-keys']) {
        const r = await api('GET', p, undefined, { 'x-beebo-agent-key': 'a'.repeat(40) })
        assert.match(String(r.headers['content-type']), /application\/json/, p)
        assert.equal(r.headers['x-content-type-options'], 'nosniff', p)
      }
    })
  } finally { fs.rmSync(cacheDir, { recursive: true, force: true }) }
  return seen
}

test('hostile data planted through requests, keys, users, uploads and TMDB metadata never renders as live markup', async () => {
  const seen = await seedAndCrawl()
  // The crawl must really have reached the pages (not just 404s): the admin tabs and the site pages answer.
  const ok = Object.entries(seen).filter(([, s]) => s === 200).map(([p]) => p)
  for (const must of ['/', '/upload', '/admin?tab=users', '/admin?tab=missing', '/admin?tab=requests', '/admin?tab=apikeys', '/login']) assert.ok(ok.includes(must), `${must} answered 200 (got ${seen[must]})`)
  // Not vacuous: the hostile text really is on those pages, as escaped text.
  for (const p of ['/', '/upload', '/admin?tab=users', '/admin?tab=missing', '/admin?tab=requests', '/admin?tab=apikeys']) {
    assert.match(bodies[p], /&lt;img src=x onerror=alert\(1\)&gt;|&lt;\/script&gt;&lt;img/, `${p} shows the planted text, escaped`)
  }
})

// --------------------------------------------- the pages' own client code ----

function extractEsc(source, re) {
  const m = re.exec(source)
  assert.ok(m, 'escape helper found: ' + re)
  return m[0]
}

test('every client-side escape helper escapes & < > " and \'', () => {
  const dir = path.join(__dirname, '..', 'electron')
  const cases = [
    ['playlistWeb.js', /var esc = function \(s\) \{ return String\(s == null \? '' : s\)\.replace\(\/\[&<>"'\]\/g, function \(c\) \{ return \{[^}]*\}\[c\] \}\) \}/],
    ['musicApi.js', /function esc\(s\)\{return String\(s==null\?'':s\)\.replace\(\/\[&<>"'\]\/g,function\(c\)\{return \{[^}]*\}\[c\]\}\)\}/],
    ['photosApi.js', /function esc\(s\)\{ return String\(s == null \? '' : s\)\.replace\(\/\[&<>"'\]\/g, function\(c\)\{ return '&#' \+ c\.charCodeAt\(0\) \+ ';' \}\) \}/]
  ]
  for (const [file, re] of cases) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8')
    const code = extractEsc(src, re)
    const esc = vm.runInNewContext('(function(){ ' + code.replace(/^var esc = /, 'var esc = ') + '; return esc })()'.replace('return esc', 'return typeof esc === "function" ? esc : null'))
    assert.equal(typeof esc, 'function', file)
    for (const h of Object.values(HOSTILE)) assert.doesNotMatch(esc(h), /[<>"]/, `${file}: ${h}`)
    assert.doesNotMatch(esc("a'b"), /'/, file + ' single quote')
    assert.equal(esc(null), '', file)
  }
  // playbackWebUi's helper leaves ' alone, so it must only ever be used inside double-quoted attributes.
  const pb = fs.readFileSync(path.join(dir, 'playbackWebUi.js'), 'utf8')
  assert.equal(/=\s*'[^"]*'\s*\+\s*esc\(/.test(pb.replace(/"[^"]*"/g, '"x"')), false, "no single-quoted attribute takes esc() output")
})

test('every innerHTML/insertAdjacentHTML site in the page scripts is a reviewed one (a new one fails until reviewed)', () => {
  const dir = path.join(__dirname, '..', 'electron')
  const counts = {}
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const n = (fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\/.*$/gm, '').match(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/g) || []).length
    if (n) counts[f] = n
  }
  // Reviewed 2026-09-21: each assignment either writes constants or passes every dynamic value
  // through the file's esc() / textContent (see the per-file esc test above).
  assert.deepEqual(counts, {
    'accountSecurityWeb.js': 1 /* server-generated QR SVG (qrSvg.js): no user text */, 'audiobookWeb.js': 12 /* every dynamic value through esc() */,
    'browserChrome.js': 3, 'musicApi.js': 5, 'photosApi.js': 8, 'playbackWebUi.js': 4, 'playlistWeb.js': 7, 'pwa.js': 1 /* constant install-banner text only */, 'streamServer.js': 5
  })
})

test('inline JSON in page scripts goes through jsonForScript (no raw JSON.stringify inside a script template)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'electron', 'streamServer.js'), 'utf8')
  assert.equal(/\$\{JSON\.stringify\(/.test(src), false)
})
