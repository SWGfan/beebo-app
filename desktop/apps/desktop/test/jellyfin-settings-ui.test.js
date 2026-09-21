// Settings > Jellyfin apps: the pure model, that the component compiles and renders, that the preload bridge / IPC handlers / main.js
// are wired to each other, and the IPC doorway working against a real server (approve, sessions, revoke, app passwords, self-check).
// Run: node --test test/jellyfin-settings-ui.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { fixture } = require('./jellyfin-fixture')

const appRoot = path.resolve(__dirname, '..')
const read = (...p) => fs.readFileSync(path.join(appRoot, ...p), 'utf8')
const loadModel = () => import(pathToFileURL(path.join(appRoot, 'src', 'lib', 'jellyfinPanelModel.js')).href)

test('model: codes, times, errors, sessions and check marks read as plain words', async () => {
  const M = await loadModel()
  assert.equal(M.cleanCode('123 456'), '123456')
  assert.equal(M.cleanCode('12-34-56-78'), '123456', 'only six digits are kept')
  assert.equal(M.cleanCode('ab'), '')
  assert.equal(M.isCompleteCode('123456'), true)
  assert.equal(M.isCompleteCode('12345'), false)
  const now = 1_000_000_000_000
  assert.equal(M.ago(0, now), 'never')
  assert.equal(M.ago(now - 5000, now), 'just now')
  assert.equal(M.ago(now - 5 * 60000, now), '5 minutes ago')
  assert.equal(M.ago(now - 60 * 60000, now), '1 hour ago')
  assert.equal(M.ago(now - 3 * 86400000, now), '3 days ago')
  for (const code of ['server_not_running', 'off', 'bad_code', 'unknown_code', 'too_many_wrong', 'no_person', 'no_such_person', 'name_required', 'too_many', 'too_many_for_person', 'not_found']) {
    const t = M.errorText({ ok: false, error: code })
    assert.ok(t && !t.includes(code) && /[a-z]/.test(t), code + ' -> ' + t)
  }
  assert.match(M.errorText({ ok: false, error: 'weird_new_error' }), /Something went wrong/)
  assert.equal(M.sessionTitle({ app: 'Findroid', device: 'Pixel 8' }), 'Findroid on Pixel 8')
  assert.equal(M.sessionTitle({ app: 'Swiftfin', device: 'Swiftfin' }), 'Swiftfin')
  assert.equal(M.checkMark('pass').mark, '✓')
  assert.equal(M.checkMark('fail').tone, 'bad')
  assert.equal(M.checkMark('skip').label, 'Skipped')
  assert.deepEqual(M.serverAddresses({ links: [{ address: '192.168.1.20' }], port: 47811, hostname: 'nick.beebo.tv' }), [
    { label: 'On your home network', url: 'http://192.168.1.20:47811' }, { label: 'From anywhere', url: 'https://nick.beebo.tv' }])
  assert.deepEqual(M.serverAddresses({ links: [], port: 0, hostname: '' }), [])
})

test('the component compiles; switched off it shows only the switch, switched on it shows every part', async () => {
  const esbuild = require('esbuild')
  const React = require('react')
  const { renderToString } = require('react-dom/server')
  const built = esbuild.buildSync({
    entryPoints: [path.join(appRoot, 'src', 'components', 'JellyfinCompatSettings.jsx')],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'transform',
    external: ['react', 'react-dom'], loader: { '.js': 'js', '.jsx': 'jsx' }, logLevel: 'silent'
  })
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', built.outputFiles[0].text)(mod, mod.exports, require)
  // renderToString does not run effects, so the panel shows its first state; that must not throw and must not show the "on" parts.
  globalThis.window = { beeboentertainment: { getSettings: async () => ({ jellyfinCompat: false }) } }
  try {
    const html = renderToString(React.createElement(mod.exports.default))
    assert.equal(html, '', 'nothing is drawn until the setting has been read')
  } finally { delete globalThis.window }
  // The view, drawn switched off and switched on with a busy server's worth of state.
  const View = mod.exports.JellyfinPanelView
  const noop = () => {}
  const base = { on: false, busy: false, urls: [], status: null, people: [], sessions: [], pending: [], passwords: [], copied: '', copy: noop, code: '', setCode: noop, approveFor: '', setApproveFor: noop, qcMessage: null, pwFor: '', setPwFor: noop, pwLabel: '', setPwLabel: noop, pwMessage: null, newSecret: null, setNewSecret: noop, confirming: '', setConfirming: noop, checking: false, report: null, toggle: noop, approve: noop, signOut: noop, makePassword: noop, removePassword: noop, runCheck: noop }
  const off = renderToString(React.createElement(View, base))
  assert.match(off, /Jellyfin-compatible API/)
  for (const part of ['Server address', 'Quick Connect', 'Apps signed in', 'App passwords', 'Check that it works']) assert.ok(!off.includes(part), 'off: ' + part)
  const onHtml = renderToString(React.createElement(View, {
    ...base, on: true,
    urls: [{ label: 'On your home network', url: 'http://192.168.1.20:47811' }],
    status: { liveSockets: 2 },
    people: [{ id: 'u1', name: 'Nick', username: 'nick', isAdmin: true, twoFactor: false }, { id: 'u2', name: 'Robin', username: 'robin', twoFactor: true }],
    approveFor: 'u1', pwFor: 'u2',
    pending: [{ code: '482913', app: 'Swiftfin', device: 'Living room Apple TV', secondsLeft: 240 }],
    sessions: [{ id: 'abc', userId: 'u1', userName: 'Nick', app: 'Findroid', device: 'Pixel 8', signedInWith: 'Quick Connect', createdAt: 1, lastSeenAt: Date.now() - 120000 }],
    passwords: [{ id: 'p1', userId: 'u2', userName: 'Robin', label: 'Bedroom TV', createdAt: 1, lastUsedAt: 0 }],
    newSecret: { secret: 'ABCD-EFGH-JKLM-NPQR', label: 'Kitchen', person: 'Robin' },
    qcMessage: { text: 'Approved: Swiftfin is signing in.' },
    report: { ok: false, summary: '1 of 3 checks failed: Posters load.', checks: [{ id: 'a', label: 'Apps can find the server', state: 'pass' }, { id: 'b', label: 'Posters load', state: 'fail', detail: 'HTTP 404', hint: 'Refresh the library so posters download.' }, { id: 'c', label: 'Search finds titles', state: 'skip' }] }
  }))
  for (const part of ['http://192.168.1.20:47811', '482913', 'Swiftfin on Living room Apple TV', 'Findroid on Pixel 8', 'Quick Connect', 'Bedroom TV', 'ABCD-EFGH-JKLM-NPQR', 'shown only this once', '1 of 3 checks failed', 'Refresh the library so posters download.', '2 connected live now', 'Robin (two-factor)']) assert.ok(onHtml.includes(part), 'on: ' + part)
  const src = read('src', 'components', 'JellyfinCompatSettings.jsx')
  for (const part of ['Server address', 'Quick Connect', 'Apps signed in', 'App passwords', 'Check that it works', 'Copy', 'Sign out', 'Approve', 'Run the check']) assert.ok(src.includes(part), part)
  for (const banned of ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie', 'console.', 'window.open', 'XMLHttpRequest', 'fetch(']) assert.ok(!src.includes(banned), 'uses ' + banned)
  // The new app password is held only in component state, cleared by "Done".
  assert.match(src, /setNewSecret\(null\)/)
})

test('wiring: every jellyfin: channel the preload exposes has a handler, main.js registers them, and the window gets no secret it should not', () => {
  const handlers = {}
  require('../electron/jellyfinIpc').register({ ipcMain: { handle: (name, fn) => { handlers[name] = fn } }, getServerInfo: () => null })
  const preload = read('electron', 'preload.js')
  const used = [...preload.matchAll(/ipcRenderer\.invoke\('(jellyfin:[A-Za-z0-9]+)'/g)].map((m) => m[1]).sort()
  assert.deepEqual(used, Object.keys(handlers).sort())
  assert.match(read('electron', 'main.js'), /require\('\.\/jellyfinIpc'\)\.register\(\{ ipcMain, getServerInfo: \(\) => streamServerInfo \}\)/)
  assert.match(read('electron', 'streamServer.js'), /jellyfin: jellyfinCompat\.admin/)
})

test('doorway: with no server running every channel answers server_not_running instead of throwing', async () => {
  const handlers = {}
  require('../electron/jellyfinIpc').register({ ipcMain: { handle: (name, fn) => { handlers[name] = fn } }, getServerInfo: () => null })
  for (const [name, fn] of Object.entries(handlers)) {
    const r = await fn({}, {})
    assert.deepEqual(r, { ok: false, error: 'server_not_running' }, name)
  }
})

test('doorway: approve, sessions, sign-out, app passwords and the check work through IPC against a real server', async () => {
  const f = await fixture()
  try {
    const handlers = {}
    require('../electron/jellyfinIpc').register({ ipcMain: { handle: (name, fn) => { handlers[name] = fn } }, getServerInfo: () => f.info })
    const call = (name, arg) => handlers[name]({}, arg)
    const st = await call('jellyfin:status')
    assert.equal(st.ok, true)
    assert.equal(st.enabled, true)
    assert.match(st.version, /^12\.\d+\.\d+$/)
    const users = (await call('jellyfin:users')).users
    assert.deepEqual(users.map((u) => u.username).sort(), ['nick', 'robin', 'sam'])
    assert.ok(users.every((u) => !('passwordHash' in u) && !('twoFactor' in u && typeof u.twoFactor === 'object')))

    // Quick Connect through the desktop: the pending list, then the approval.
    const init = (await f.jf('POST', '/QuickConnect/Initiate', { token: '' })).json
    const pending = (await call('jellyfin:quickConnectPending')).pending
    assert.equal(pending[0].code, init.Code)
    assert.deepEqual((await call('jellyfin:quickConnectApprove', { code: 'abc' })), { ok: false, error: 'bad_code' })
    assert.equal((await call('jellyfin:quickConnectApprove', { code: init.Code, userId: 'u-adult' })).ok, true)
    assert.equal((await f.jf('POST', '/Users/AuthenticateWithQuickConnect', { token: null, body: { Secret: init.Secret } })).json.User.Name, 'Robin')

    // The signed-in app shows up and can be signed out.
    const sessions = (await call('jellyfin:sessions')).sessions
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0].userName, 'Robin')
    assert.equal((await call('jellyfin:revokeSession', { userId: sessions[0].userId, id: sessions[0].id })).ok, true)
    assert.equal((await call('jellyfin:sessions')).sessions.length, 0)
    assert.equal((await call('jellyfin:revokeSession', { userId: 'u-adult', id: 'not-a-handle' })).ok, false)

    // App passwords: the secret crosses the bridge once, never again.
    assert.equal((await call('jellyfin:createAppPassword', { userId: 'u-kid', label: '' })).error, 'name_required')
    assert.equal((await call('jellyfin:createAppPassword', { userId: 'nobody', label: 'x' })).error, 'no_person')
    const made = await call('jellyfin:createAppPassword', { userId: 'u-kid', label: 'Kitchen tablet' })
    assert.equal(made.ok, true)
    const listed = await call('jellyfin:appPasswords')
    assert.equal(listed.items[0].label, 'Kitchen tablet')
    assert.equal(listed.items[0].userName, 'Sam')
    assert.ok(!JSON.stringify(listed).includes(made.secret.replace(/-/g, '')) && !JSON.stringify(listed).includes('hash'))
    assert.equal((await call('jellyfin:removeAppPassword', { id: made.item.id })).ok, true)
    assert.equal((await call('jellyfin:appPasswords')).items.length, 0)

    const report = await call('jellyfin:selfTest', {})
    assert.equal(report.ok, true, JSON.stringify(report.checks.filter((c) => c.state === 'fail')))
    assert.match(report.summary, /checks passed/)
  } finally { await f.close() }
})
