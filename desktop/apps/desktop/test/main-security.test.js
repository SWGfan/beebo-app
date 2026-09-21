// Electron hardening (security review section 3): sandbox, window-open/navigation guards, permission
// handlers, IPC sender validation, openExternal parsing, report-only CSP. Logic is tested through
// fakes (no Electron needed); the wiring in main.js is checked by a source scan.
// Run: node --test test/main-security.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const ms = require('../electron/mainSecurity')

const DIST = path.resolve(__dirname, '..', 'dist', 'index.html')
const policy = (over = {}) => ms.createPolicy({ distIndex: DIST, devUrl: 'http://localhost:5173', getIsPackaged: () => true, getLocalOrigin: () => 'http://127.0.0.1:47811', ...over })

test('isSafeExternalUrl: parsed https to a real DNS name only', () => {
  const ok = ['https://www.themoviedb.org/signup', 'https://beeboentertainment.com/subscribe.html', 'https://www.google.com/search?q=a%20b%26c', 'https://ollama.com/download#x', 'https://sub.example.co.uk/a/b?c=d']
  for (const u of ok) assert.ok(ms.isSafeExternalUrl(u), u)
  const bad = [
    'http://example.com', 'ftp://example.com', 'file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'data:text/html,<script>1</script>',
    'ms-msdt:/id PCWDiagnostic', 'search-ms:query=x', 'vscode://x', 'steam://run/1', 'mailto:a@b.c', 'https://',
    'https://user:pw@example.com/', 'https://example.com@evil.example/', 'https://127.0.0.1/x', 'https://[::1]/x', 'https://192.168.1.5/x', 'https://localhost/x',
    'https://printer.local/x', 'https://intranet/x', 'https://example.com:8443/x', 'https://exa mple.com', 'https://example.com/a b', 'https://example.com/\n', '',
    'https://' + 'a'.repeat(3000) + '.com', null, undefined, 42, {}, ['https://example.com']
  ]
  for (const u of bad) assert.equal(ms.isSafeExternalUrl(u), null, String(u).slice(0, 40))
  // a bare startsWith('https://') would have accepted several of these
  assert.equal(/^https:\/\//.test('https://127.0.0.1/x'), true)
})

test('policy: the app page is dist/index.html (any hash), the dev server only while unpackaged, the local server by exact origin', () => {
  const p = policy()
  const file = pathToFileURL(DIST).href
  assert.equal(p.isAppPageUrl(file), true)
  assert.equal(p.isAppPageUrl(file + '#/movies?x=1'), true)
  assert.equal(p.isAppPageUrl(pathToFileURL(path.join(path.dirname(DIST), 'other.html')).href), false)
  assert.equal(p.isAppPageUrl(pathToFileURL(path.resolve(__dirname, '..', 'dist', '..', 'index.html')).href), false)
  assert.equal(p.isAppPageUrl('file://evil-host/share/index.html'), false, 'UNC / network file URL')
  assert.equal(p.isAppPageUrl('http://localhost:5173/'), false, 'dev server ignored in a packaged app')
  assert.equal(policy({ getIsPackaged: () => false }).isAppPageUrl('http://localhost:5173/x'), true)
  assert.equal(policy({ getIsPackaged: () => false }).isAppPageUrl('http://localhost:5174/x'), false)
  for (const u of ['http://127.0.0.1:47811/school', 'https://evil.example/', 'about:blank', 'devtools://devtools/x', 'javascript:1', '', null]) assert.equal(p.isAppPageUrl(u), false, String(u))
  assert.equal(p.isLocalServerUrl('http://127.0.0.1:47811/school/report?child=1'), true)
  for (const u of ['http://127.0.0.1:47812/', 'https://127.0.0.1:47811/', 'http://localhost:47811/', 'http://127.0.0.1.evil.example:47811/', 'http://evil.example/']) assert.equal(p.isLocalServerUrl(u), false, u)
  assert.equal(policy({ getLocalOrigin: () => '' }).isLocalServerUrl('http://127.0.0.1:47811/'), false)
})

test('isTrustedSender: only the top frame of the app page', () => {
  const p = policy()
  const file = pathToFileURL(DIST).href
  const main = {}
  const sender = { mainFrame: main, getURL: () => file }
  assert.equal(p.isTrustedSender({ senderFrame: Object.assign(main, { url: file }), sender }), true)
  assert.equal(p.isTrustedSender({ senderFrame: { url: file }, sender }), false, 'a sub-frame of the app page')
  assert.equal(p.isTrustedSender({ senderFrame: { url: 'http://127.0.0.1:47811/school' }, sender: { getURL: () => 'http://127.0.0.1:47811/school' } }), false, 'the media server pages are not the app')
  assert.equal(p.isTrustedSender({ senderFrame: { url: 'https://evil.example/' }, sender: { getURL: () => file } }), false, 'senderFrame wins over the contents URL')
  assert.equal(p.isTrustedSender({ sender: { getURL: () => file } }), true, 'no senderFrame: fall back to the contents URL')
  for (const e of [null, undefined, {}, { senderFrame: null, sender: null }, { senderFrame: { url: 42 }, sender: {} }]) assert.equal(p.isTrustedSender(e), false)
})

test('wrapIpcMain: every handler is guarded, untrusted calls never reach it, chaining and other methods still work', async () => {
  const handlers = new Map()
  const listeners = new Map()
  const raw = {
    handle: (c, f) => handlers.set(c, f), handleOnce: (c, f) => handlers.set(c, f),
    on(c, f) { listeners.set(c, f); return this }, once(c, f) { listeners.set(c, f); return this },
    removeHandler: (c) => handlers.delete(c), marker: 7
  }
  let trusted = true
  const denied = []
  const wrapped = ms.wrapIpcMain(raw, () => trusted, (c) => denied.push(c))
  let ran = 0
  wrapped.handle('a', async (e, x) => { ran++; return x * 2 })
  assert.equal(wrapped.on('b', () => { ran++ }), wrapped, 'chaining returns the wrapped object')
  assert.equal(await handlers.get('a')({}, 21), 42)
  handlers.get('a') && listeners.get('b')({})
  assert.equal(ran, 2)
  trusted = false
  await assert.rejects(async () => handlers.get('a')({}, 1), /did not come from the Beebo window/)
  assert.equal(listeners.get('b')({}), undefined)
  assert.equal(ran, 2, 'untrusted calls never ran the handlers')
  assert.deepEqual(denied, ['a', 'b'])
  assert.equal(wrapped.marker, 7)
  wrapped.removeHandler('a')
  assert.equal(handlers.has('a'), false)
})

function fakeContents() {
  const c = new EventEmitter()
  c.openHandler = null
  c.setWindowOpenHandler = (fn) => { c.openHandler = fn }
  return c
}
function navigate(c, event, url) {
  const ev = { prevented: false, preventDefault() { this.prevented = true } }
  c.emit(event, ev, url)
  return ev.prevented
}

test('guardWebContents: new windows denied, https links go to the browser, navigation stays on the window\'s own origin', () => {
  const opened = []
  const shell = { openExternal: (u) => opened.push(u) }
  const logs = []
  const p = policy()
  const app = fakeContents()
  ms.guardWebContents(app, { kind: 'app', policy: p, shell, log: (m) => logs.push(m) })
  assert.deepEqual(app.openHandler({ url: 'https://www.themoviedb.org/x' }), { action: 'deny' })
  assert.deepEqual(opened, ['https://www.themoviedb.org/x'])
  assert.deepEqual(app.openHandler({ url: 'file:///C:/Windows/notepad.exe' }), { action: 'deny' })
  assert.deepEqual(app.openHandler({ url: 'javascript:alert(1)' }), { action: 'deny' })
  assert.deepEqual(app.openHandler({ url: 'http://127.0.0.1:47811/admin' }), { action: 'deny' })
  assert.equal(opened.length, 1, 'only the https link was opened')
  const file = pathToFileURL(DIST).href
  for (const ev of ['will-navigate', 'will-redirect']) {
    assert.equal(navigate(app, ev, file + '#/settings'), false, 'its own page is fine')
    assert.equal(navigate(app, ev, 'https://evil.example/phish'), true)
    assert.equal(navigate(app, ev, 'http://127.0.0.1:47811/school'), true, 'the app window may not wander onto the media server')
    assert.equal(navigate(app, ev, 'file:///C:/secret.html'), true)
  }
  assert.ok(opened.includes('https://evil.example/phish'), 'a blocked https navigation is offered to the default browser instead')
  assert.equal(navigate(app, 'will-attach-webview'), true, '<webview> is refused')

  const school = fakeContents()
  ms.guardWebContents(school, { kind: 'local', policy: p, shell })
  assert.equal(navigate(school, 'will-navigate', 'http://127.0.0.1:47811/school/report?child=x'), false)
  assert.equal(navigate(school, 'will-navigate', 'http://127.0.0.1:47812/'), true, 'a different port is a different origin')
  assert.equal(navigate(school, 'will-navigate', 'http://localhost:47811/'), true)
  assert.equal(navigate(school, 'will-navigate', 'https://evil.example/'), true)
  assert.equal(navigate(school, 'will-navigate', file), true, 'the app page is not the school window\'s business')
  assert.equal(navigate(school, 'will-navigate', 'devtools://devtools/bundled/x.html'), false, 'DevTools keeps working')
  assert.deepEqual(school.openHandler({ url: 'http://127.0.0.1:47811/x' }), { action: 'deny' })
})

test('installSessionPolicy: deny by default, allow only clipboard write + fullscreen for our own pages, CSP report-only on the app page', () => {
  let request, check, headersHook
  const session = {
    setPermissionRequestHandler: (fn) => { request = fn },
    setPermissionCheckHandler: (fn) => { check = fn },
    webRequest: { onHeadersReceived: (fn) => { headersHook = fn } }
  }
  const logs = []
  ms.installSessionPolicy(session, { policy: policy(), log: (m) => logs.push(m) })
  const file = pathToFileURL(DIST).href
  const ask = (permission, url) => { let granted; request({ getURL: () => url }, permission, (g) => { granted = g }, { requestingUrl: url }); return granted }
  for (const bad of ['media', 'geolocation', 'notifications', 'midi', 'midiSysex', 'display-capture', 'clipboard-read', 'openExternal', 'hid', 'usb', 'serial', 'pointerLock', 'window-management', 'unknown', 'idle-detection', 'fileSystem', 'storage-access']) {
    assert.equal(ask(bad, file), false, bad + ' (app page)')
    assert.equal(ask(bad, 'http://127.0.0.1:47811/school'), false, bad + ' (school page)')
    assert.equal(check({}, bad, file, { requestingUrl: file }), false, bad + ' check')
  }
  for (const good of ['clipboard-sanitized-write', 'fullscreen']) {
    assert.equal(ask(good, file), true, good)
    assert.equal(ask(good, 'http://127.0.0.1:47811/watch?id=x'), true, good + ' on the local player')
    assert.equal(check({}, good, file, { requestingUrl: file }), true)
    assert.equal(ask(good, 'https://evil.example/'), false, good + ' for a stranger')
    assert.equal(check({}, good, 'https://evil.example', { requestingUrl: 'https://evil.example/' }), false)
  }
  assert.ok(logs.some((l) => /"media"/.test(l)), 'a denied permission is logged')
  assert.equal(logs.filter((l) => /"media"/.test(l)).length, 1, 'once')
  // CSP: only the app's own page gets it; other responses pass through untouched
  let out
  headersHook({ url: file, responseHeaders: { 'X-A': ['1'] } }, (r) => { out = r })
  assert.match(out.responseHeaders['Content-Security-Policy-Report-Only'][0], /default-src 'self'.*object-src 'none'.*frame-ancestors 'none'/)
  assert.deepEqual(out.responseHeaders['X-A'], ['1'])
  headersHook({ url: 'https://api.themoviedb.org/3/x', responseHeaders: { 'X-B': ['2'] } }, (r) => { out = r })
  assert.equal(out.responseHeaders['Content-Security-Policy-Report-Only'], undefined)
  assert.ok(!/script-src[^;]*unsafe-inline/.test(ms.CSP_REPORT_ONLY), 'the renderer policy forbids inline script')
})

test('cspViolationLine only keeps CSP refusals, shortened', () => {
  assert.match(ms.cspViolationLine("[Report Only] Refused to load the image 'https://x.example/a.png' because it violates the following Content Security Policy directive: \"img-src 'self'\"."), /^renderer CSP report-only: /)
  assert.equal(ms.cspViolationLine('some other console message'), '')
  assert.ok(ms.cspViolationLine('Content Security Policy Refused to ' + 'x'.repeat(1000)).length < 400)
})

// ------------------------------------------------------------ main.js wiring ----

const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
const detailsSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'detailsIpc.js'), 'utf8')

test('main.js wiring: every BrowserWindow is sandboxed, ipcMain is the wrapped one, openExternal is parsed', () => {
  for (const [name, src] of [['main.js', mainSrc], ['detailsIpc.js', detailsSrc]]) {
    const windows = src.match(/new BrowserWindow\(/g) || []
    const sandboxed = src.match(/sandbox:\s*true/g) || []
    assert.equal(windows.length, sandboxed.length, `${name}: ${windows.length} windows, ${sandboxed.length} sandbox:true`)
    assert.ok(windows.length >= 1)
    assert.equal(/nodeIntegration:\s*true|contextIsolation:\s*false|webSecurity:\s*false|allowRunningInsecureContent|enableRemoteModule|webviewTag:\s*true/.test(src), false, name + ': no weakened web preferences')
  }
  assert.match(mainSrc, /ipcMain: rawIpcMain/, 'the raw ipcMain is renamed')
  assert.match(mainSrc, /const ipcMain = mainSecurity\.wrapIpcMain\(rawIpcMain/)
  assert.equal((mainSrc.match(/rawIpcMain/g) || []).length, 2, 'rawIpcMain is used only to build the wrapper')
  assert.match(mainSrc, /app\.on\('web-contents-created'/)
  assert.match(mainSrc, /mainSecurity\.installSessionPolicy\(electronSession\.defaultSession/)
  assert.doesNotMatch(mainSrc, /\/\^https:\\\/\\\//, 'no bare https prefix test for openExternal')
  assert.match(mainSrc, /mainSecurity\.isSafeExternalUrl\(url\)/)
  assert.equal(/shell\.openExternal\((?!safe)/.test(mainSrc.replace(/safeUrl|safe\)/g, 'safe)')), false, 'every openExternal in main.js takes a vetted URL')
})

test('the preload only needs what a sandboxed preload may require', () => {
  const pre = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8')
  const requires = [...pre.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((m) => m[1])
  assert.deepEqual([...new Set(requires)], ['electron'])
  assert.match(pre, /const \{ contextBridge, ipcRenderer \} = require\('electron'\)/)
})
