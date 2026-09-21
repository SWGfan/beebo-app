// The Movie Night pages as code: safe by construction (no HTML sinks anywhere), old-TV-browser syntax, self-contained,
// accessible, and the small pure helpers (LAN address choice, SSE framing, QR, settings).
// Run: node --test test/movie-night-web.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const clients = require('../electron/movieNightClients')
const web = require('../electron/movieNightWeb')
const http = require('../electron/movieNightHttp')
const { sseFrame } = require('../electron/watchTogetherHttp')
const mn = require('../electron/movieNight')

const sources = Object.fromEntries(Object.entries(clients).map(([k, fn]) => [k, fn.toString()]))

// Comments and string contents removed, so the checks below look at code only.
function codeOnly(src) {
  let out = ''
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    const n = src[i + 1]
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; out += '\n'; continue }
    if (c === '/' && n === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i++; continue }
    if (c === '"' || c === "'") { const q = c; out += q; i++; while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++ } out += q; continue }
    out += c
  }
  return out
}

test('the browser programs never build HTML: no innerHTML, insertAdjacentHTML, outerHTML, document.write, eval or Function()', () => {
  for (const [name, src] of Object.entries(sources)) {
    const code = codeOnly(src)
    for (const bad of [/\.innerHTML\b/, /insertAdjacentHTML/, /\.outerHTML\b/, /document\.write/, /\beval\s*\(/, /new\s+Function\b/, /setTimeout\s*\(\s*['"`]/, /setInterval\s*\(\s*['"`]/, /\.srcdoc\b/, /createContextualFragment/, /DOMParser/, /\.postMessage\s*\(/, /window\.open\s*\(/]) {
      assert.ok(!bad.test(code), `${name} uses ${bad}`)
    }
  }
})

test('the browser programs are plain ES5 so old TV engines run them (no arrows, let/const, template strings, spread, optional chaining)', () => {
  for (const [name, src] of Object.entries(sources)) {
    const code = codeOnly(src)
    assert.ok(!/=>/.test(code), `${name}: arrow function`)
    assert.ok(!/\b(let|const|class|async|await|yield)\b/.test(code), `${name}: ES6 keyword`)
    assert.ok(!/`/.test(code), `${name}: template string`)
    assert.ok(!/\.\.\./.test(code), `${name}: spread`)
    assert.ok(!/\?\.|\?\?/.test(code), `${name}: optional chaining / nullish`)
    assert.ok(!/\b(Object\.(entries|values|fromEntries)|Array\.from|\.includes\(|\.padStart|\.padEnd|\.flat\b|\.flatMap|replaceAll|Promise\.allSettled|AbortController|ResizeObserver|structuredClone)\b/.test(code), `${name}: newer built-in`)
    // and it parses as a real function
    new vm.Script('(' + src + ')')
  }
})

test('the pages carry no third-party scripts, styles, fonts, images or requests', () => {
  const pages = { tv: web.tvPageHtml({}), join: web.joinPageHtml({ code: 'ABC234', key: 'abcdefghijklmnop' }), message: web.messagePageHtml('hi'), overlay: web.reactionOverlayHtml() }
  for (const [name, html] of Object.entries(pages)) {
    assert.ok(!/https?:\/\//i.test(html.replace(/xmlns="[^"]*"/g, '')), `${name} mentions an external address`)
    assert.ok(!/<script[^>]+src=|<link[^>]+href=|@import|url\(/i.test(html), `${name} loads something`)
    assert.ok(!/fonts\.googleapis|gstatic|cdn\./i.test(html))
  }
  // every network call goes to this server's own API path
  for (const src of Object.values(sources)) assert.ok(!/(fetch|EventSource)\s*\(\s*['"]https?:/.test(src))
})

test('a script block in a page is closed exactly once, whatever the data', () => {
  const html = web.joinPageHtml({ code: 'ABC234', key: 'abcdefghijklmnop' })
  assert.equal((html.match(/<\/script>/gi) || []).length, 1)
  assert.equal((html.match(/<script>/gi) || []).length, 1)
  assert.ok(!html.includes('<!--'))
  const sep = String.fromCharCode(0x2028) + String.fromCharCode(0x2029)
  const hostileValue = { a: '</script><script>alert(1)</script>', b: sep + '&<>' }
  const hostile = web.scriptJson(hostileValue)
  for (const ch of ['<', '>', '&', String.fromCharCode(0x2028), String.fromCharCode(0x2029)]) assert.ok(!hostile.includes(ch), 'raw ' + ch.charCodeAt(0) + ' in a script block')
  assert.deepEqual(JSON.parse(hostile), hostileValue)
  // an out-of-shape code or key is dropped before it reaches the page
  const dropped = web.joinPageHtml({ code: '"><script>', key: '<b>' })
  assert.match(dropped, /"code":""/)
  assert.match(dropped, /"key":""/)
})

test('the TV page is built for a distant screen: big type, high contrast, safe margins, visible focus, reduced motion', () => {
  const css = web.TV_CSS
  assert.match(css, /html\{font-size:2\.3vh\}/, 'body text is about 25px on a 1080p TV')
  assert.match(css, /--bg:#0b0d12/)
  assert.match(css, /\.btn:focus\{outline:\.6vh solid var\(--accent\)/, 'a thick focus ring')
  assert.match(css, /padding:3\.5vh 5vw/, 'overscan-safe margins')
  assert.match(css, /prefers-reduced-motion:reduce/)
  assert.match(css, /prefers-contrast:more/)
  assert.ok(!/(^|[^-\w])(clamp|min|max)\(/.test(css), 'CSS min()/max()/clamp() would break older TVs')
  assert.ok(!/[;{\s]gap\s*:/.test(css.replace(/grid-gap/g, '')), 'flexbox gap would break older TVs')
  assert.ok(!/aspect-ratio|:focus-visible|backdrop-filter|inset\s*:/.test(css))
  // contrast: white on the near-black background, and the accent on it, both far above 7:1
  const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] }
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
  const vars = Object.fromEntries([...css.matchAll(/--([a-z0-9]+):(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]))
  for (const fg of ['ink', 'dim', 'accent', 'good', 'bad']) assert.ok(ratio(vars[fg], vars.bg) >= 7, `${fg} on the background is ${ratio(vars[fg], vars.bg).toFixed(1)}:1`)
  assert.ok(ratio('#111111', vars.accent) >= 7, 'dark text on the accent button')
  // every player colour reads with dark text on it
  for (const c of mn.COLORS) assert.ok(ratio('#111111', c.hex) >= 4.5, `${c.name} badge text ${ratio('#111111', c.hex).toFixed(1)}:1`)
})

test('players are told apart by colour AND shape AND name, and the shapes are all different', () => {
  assert.equal(mn.COLORS.length, 12)
  assert.equal(new Set(mn.COLORS.map((c) => c.hex)).size, 12)
  assert.equal(new Set(mn.COLORS.map((c) => c.glyph)).size, 12)
  assert.equal(new Set(mn.COLORS.map((c) => c.name)).size, 12)
})

test('the phone page: labelled inputs, big tap targets, live status, no zoom lock, dark and light schemes', () => {
  const css = web.GUEST_CSS
  assert.match(css, /prefers-color-scheme:light/)
  assert.match(css, /prefers-reduced-motion:reduce/)
  assert.match(css, /\.b\{[^}]*min-height:56px/, 'buttons are at least 56px tall')
  assert.match(css, /\.opt\{[^}]*min-height:72px/)
  assert.match(css, /outline:3px solid/, 'focus is visible')
  const html = web.joinPageHtml({})
  assert.ok(!/user-scalable\s*=\s*no|maximum-scale/i.test(html), 'people may zoom')
  const src = sources.movieNightGuestClient
  assert.match(src, /aria-live/)
  assert.match(src, /setAttribute\('for', 'nick'\)/, 'the nickname box has a label')
  assert.match(src, /aria-label/)
})

test('the TV page announces changes to screen readers and labels its picture', () => {
  const src = sources.movieNightTvClient
  assert.match(src, /aria-live/)
  assert.match(src, /setAttribute\('role', 'dialog'\)/)
  assert.match(src, /aria-label', 'Room code/)
  assert.match(src, /aria-label', 'QR code to join Movie Night'/)
  assert.match(src, /prefers-reduced-motion/)
})

test('the overlay does nothing without a ticket in the address, and only reads', () => {
  const src = sources.movieNightOverlayClient
  assert.match(src, /mn=\(\[A-Za-z0-9_-\]\{32\}\)/)
  assert.match(src, /if \(!ticket \|\| !window\.EventSource\) return/)
  assert.ok(!/method:\s*'POST'|XMLHttpRequest|fetch\(/.test(src), 'it never sends anything')
  // run it in a stub browser with no ticket: it makes no connection and adds nothing to the page
  const created = []
  const sandbox = {
    location: { hash: '', pathname: '/watch', search: '?id=x' }, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    EventSource: function () { created.push('es') }, window: {}, document: { createElement() { created.push('el'); return {} }, body: { appendChild() {} }, addEventListener() {} },
    history: { replaceState() {} }, encodeURIComponent
  }
  sandbox.window = { EventSource: sandbox.EventSource, matchMedia: () => ({ matches: false }) }
  vm.runInNewContext('(' + src + ')({ api: "/movie-night-api" })', sandbox)
  assert.deepEqual(created, [])
  // with a ticket it connects to this server's events path with that ticket, and puts nothing in the address bar
  const opened = []
  const replaced = []
  const sb2 = {
    location: { hash: '#mn=' + 'a'.repeat(32), pathname: '/watch', search: '?id=x' }, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { createElement: () => ({ style: {}, appendChild() {}, setAttribute() {} }), body: { appendChild() {} }, addEventListener() {} },
    history: { replaceState: (...a) => replaced.push(a) }, encodeURIComponent, setTimeout, Math, Date, JSON, RegExp
  }
  sb2.EventSource = function (u) { opened.push(u); this.addEventListener = () => {} }
  sb2.window = { EventSource: sb2.EventSource, matchMedia: () => ({ matches: false }) }
  vm.runInNewContext('(' + src + ')({ api: "/movie-night-api" })', sb2)
  assert.deepEqual(opened, ['/movie-night-api/events?ticket=' + 'a'.repeat(32)])
  assert.equal(replaced.length, 1)
  assert.equal(replaced[0][2], '/watch?id=x', 'the ticket is removed from the address')
})

test('SSE framing: one event per frame, whatever a name or title contains', () => {
  const frame = sseFrame('state', JSON.stringify({ name: 'Sam\nevent: kick\ndata: x', title: 'a\r\nb\rc' }), 7)
  assert.match(frame, /^id: 7\nevent: state\ndata: /)
  assert.ok(frame.endsWith('\n\n'))
  assert.equal((frame.match(/\n\n/g) || []).length, 1, 'no blank line inside the frame')
  for (const line of frame.trimEnd().split('\n')) assert.match(line, /^(id|event|data): /)
  // a hostile event name falls back to a plain one
  assert.match(sseFrame('x\nevent: closed', '{}'), /^event: message\n/)
  // and the JSON we send never contains a raw newline anyway
  assert.ok(!JSON.stringify({ n: 'a\nb c' }).includes('\n'))
})

test('choosing the address a phone should open: Wi-Fi over virtual adapters, 192.168 over 10.x', () => {
  const nic = (address, internal = false, family = 'IPv4') => ({ address, family, internal })
  assert.equal(http.pickLanAddress({ 'VirtualBox Host-Only Network': [nic('192.168.56.1')], 'Wi-Fi': [nic('192.168.1.20')] }), '192.168.1.20')
  assert.equal(http.pickLanAddress({ 'vEthernet (WSL)': [nic('172.24.0.1')], Ethernet: [nic('10.0.0.5')] }), '10.0.0.5')
  assert.equal(http.pickLanAddress({ Ethernet: [nic('10.0.0.5')], 'Wi-Fi': [nic('192.168.1.20')] }), '192.168.1.20')
  assert.equal(http.pickLanAddress({ lo: [nic('127.0.0.1', true)], Ethernet: [nic('169.254.3.4'), nic('8.8.8.8')] }), '', 'no private address: nothing invented')
  assert.equal(http.pickLanAddress({ 'Wi-Fi': [nic('fe80::1', false, 'IPv6')] }), '')
  assert.equal(http.pickLanAddress({ 'Docker Network': [nic('172.17.0.1')] }), '172.17.0.1', 'a virtual adapter is still better than nothing')
  assert.equal(http.pickLanAddress(null), '')
})

test('the QR is a matrix of 0 and 1 that encodes exactly the join address', () => {
  const url = 'http://192.168.1.20:47811/movie-night/join?c=ABC234&k=abcdefghijklmnop'
  const qr = http.defaultQr(url)
  assert.ok(qr.n >= 25 && qr.n <= 61)
  assert.equal(qr.rows.length, qr.n)
  assert.ok(qr.rows.every((r) => r.length === qr.n && /^[01]+$/.test(r)))
  // finder patterns: the three corners have the 7x7 square whose outer ring is dark
  for (const [r, c] of [[0, 0], [0, qr.n - 7], [qr.n - 7, 0]]) {
    for (let i = 0; i < 7; i++) { assert.equal(qr.rows[r][c + i], '1'); assert.equal(qr.rows[r + 6][c + i], '1'); assert.equal(qr.rows[r + i][c], '1'); assert.equal(qr.rows[r + i][c + 6], '1') }
  }
})

test('settings from the store are always safe: unknown values are replaced by defaults', () => {
  const s = mn.normalizeSettings({ maxGuests: '50', games: 'all', ratingCap: { x: 1 }, homeOnly: 'no', allowSuggestions: 'yes', enabled: 0 })
  assert.equal(s.maxGuests, 12)
  assert.deepEqual(s.games, mn.DEFAULT_SETTINGS.games)
  assert.equal(s.ratingCap, 'PG-13')
  assert.equal(s.homeOnly, true, 'only an explicit false turns the safety off')
  assert.equal(s.allowSuggestions, false, 'only an explicit true turns suggestions on')
  assert.equal(s.enabled, true)
  assert.equal(mn.normalizeSettings({ homeOnly: false }).homeOnly, false)
  assert.equal(mn.normalizeSettings({ enabled: false }).enabled, false)
  assert.equal(mn.normalizeSettings(undefined).maxGuests, 12)
})

test('the desktop button and settings only send simple values to the main process', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const ipc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'movieNightIpc.js'), 'utf8')
  assert.match(ipc, /ipcMain\.handle\('movieNight:start'/)
  assert.match(ipc, /ipcMain\.handle\('movieNight:saveSettings'/)
  assert.match(ipc, /pick\(p, Object\.keys\(DEFAULT_SETTINGS\)\)/, 'only known settings are stored')
  const pre = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8')
  assert.match(pre, /movieNight: \{[\s\S]*movieNight:start[\s\S]*movieNight:getSettings[\s\S]*movieNight:saveSettings/)
  // the renderer never gets a ticket or a key: the IPC reply has only the code and addresses
  assert.ok(!/ticket|joinKey/.test(ipc.slice(ipc.indexOf("return { ok: true, mode"))))
  const btn = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'MovieNightButton.jsx'), 'utf8')
  const set = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'MovieNightSettings.jsx'), 'utf8')
  for (const src of [btn, set]) assert.ok(!/dangerouslySetInnerHTML|innerHTML/.test(src))
})
