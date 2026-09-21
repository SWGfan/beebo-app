// The "Switch to Beebo" wizard: its pure model (src/lib/migrationModel.js), that the component
// compiles and renders, that it never writes a credential anywhere, and that the tab, the preload
// bridge and the IPC handlers are all wired. Run: node --test test/migration-ui.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const appRoot = path.resolve(__dirname, '..')
const read = (...p) => fs.readFileSync(path.join(appRoot, ...p), 'utf8')
const loadModel = () => import(pathToFileURL(path.join(appRoot, 'src', 'lib', 'migrationModel.js')).href)

test('steps: the session decides where the wizard is', async () => {
  const M = await loadModel()
  assert.equal(M.stepOf({}), 'source')
  assert.equal(M.stepOf({ session: { status: 'reading' } }), 'reading')
  assert.equal(M.stepOf({ session: { status: 'matching' } }), 'reading')
  assert.equal(M.stepOf({ session: { status: 'error' } }), 'connect', 'a failed read goes back to the connect screen')
  assert.equal(M.stepOf({ session: { status: 'ready' } }), 'review')
  assert.equal(M.stepOf({ session: { status: 'ready' }, report: { dryRun: false }, imported: true }), 'done')
  assert.deepEqual(M.STEPS, ['source', 'connect', 'reading', 'review', 'import', 'done'])
})

test('errors: every code the API can return has plain words, and the server’s own message wins', async () => {
  const M = await loadModel()
  for (const code of ['owner_only', 'no_owner', 'server_not_running', 'session_not_found', 'unknown_user', 'bad_choice', 'import_failed', 'already_undone', 'cannot_undo', 'import_not_found', 'no_input', 'not_ready', 'bad_key', 'unknown_source', 'unknown_mode', 'too_much', 'server_error']) {
    const t = M.errorText({ ok: false, error: code })
    assert.ok(t && !t.includes(code), code + ' -> ' + t)
  }
  assert.equal(M.errorText({ ok: false, error: 'http_401', message: 'The server refused the key.' }), 'The server refused the key.')
  assert.equal(M.errorText({ ok: false, error: 'weird_thing' }), 'Could not do that (weird_thing).')
  assert.equal(M.errorText(null), 'Could not do that.')
  assert.equal(M.errorText({ ok: false, error: 'cancelled' }), '')
})

test('summary lines: singular and plural, and only what happened', async () => {
  const M = await loadModel()
  assert.deepEqual(M.summaryLines({ watched: 1, resume: 2, ratings: 0, favorites: 1, watchlist: 3, lists: 1, listItems: 4, metadata: 0 }), [
    '1 title marked watched', '2 resume points added', '1 favourite added', '3 watchlist entries added', '1 playlist created (4 titles)'
  ])
  assert.deepEqual(M.summaryLines({}), [])
  assert.equal(M.totalChanges({ watched: 2, ratings: 1, lists: 1 }), 4)
  const lines = M.skippedLines({ alreadyWatched: 3, unmatched: 10, ratingKept: 0, madeUpKey: 5 })
  assert.deepEqual(lines, ['10 ' + M.SKIP_LABELS.unmatched, '3 ' + M.SKIP_LABELS.alreadyWatched])
})

test('uploads: only the files a source can read are handed over, within its limits', async () => {
  const M = await loadModel()
  const f = (name, size = 10) => ({ name, size })
  let sel = M.selectUploads([f('a.nfo'), f('b.NFO'), f('c.jpg'), f('videodb.xml'), f('d.mkv', 5e9)], 'kodi:files')
  assert.deepEqual(sel.use.map((x) => x.name), ['a.nfo', 'b.NFO', 'videodb.xml'])
  assert.equal(sel.left, 2)
  assert.match(M.uploadNotice(sel, 'kodi:files'), /2 files were skipped/)
  sel = M.selectUploads([f('a.jpg')], 'kodi:files')
  assert.deepEqual([sel.use.length, sel.reason], [0, 'none_usable'])
  assert.match(M.uploadNotice(sel, 'kodi:files'), /None of those files can be used/)
  sel = M.selectUploads([f('x.zip', 40 * 1024 * 1024), f('y.csv', 40 * 1024 * 1024)], 'letterboxd:files')
  assert.equal(sel.reason, 'too_big')
  assert.equal(sel.use.length, 1)
  sel = M.selectUploads([f('h.csv'), f('i.csv')], 'plex:csv')
  assert.deepEqual([sel.use.length, sel.reason], [1, 'too_many'])
  assert.deepEqual(M.selectUploads([f('a.csv')], 'nonsense').use, [])
  assert.equal(M.selectUploads([], 'kodi:files').reason, 'none_usable')
  assert.equal(M.selectUploads([f('noextension')], 'kodi:files').use.length, 0)
})

test('requests: the key goes in the one field that names it, and only server sources carry one', async () => {
  const M = await loadModel()
  const form = { baseUrl: ' http://192.168.1.20:8096 ', secret: ' KEY1234567 ', insecureTls: true, userIds: ['u1', 'u2'], includeWatchlist: false }
  assert.deepEqual(M.connectRequest('jellyfin', form), { source: 'jellyfin', baseUrl: 'http://192.168.1.20:8096', insecureTls: true, apiKey: 'KEY1234567' })
  assert.deepEqual(M.connectRequest('plex', form), { source: 'plex', baseUrl: 'http://192.168.1.20:8096', insecureTls: true, token: 'KEY1234567' })
  assert.deepEqual(M.sessionRequest('emby', 'server', form), { source: 'emby', baseUrl: 'http://192.168.1.20:8096', insecureTls: true, apiKey: 'KEY1234567', mode: 'server', userIds: ['u1', 'u2'] })
  assert.deepEqual(M.sessionRequest('plex', 'server', form), { source: 'plex', baseUrl: 'http://192.168.1.20:8096', insecureTls: true, token: 'KEY1234567', mode: 'server', includeWatchlist: false })
  assert.equal(M.canConnect('plex', form), true)
  assert.equal(M.canConnect('plex', { baseUrl: '', secret: 'KEY1234567' }), false)
  assert.equal(M.canConnect('plex', { baseUrl: 'x', secret: 'short' }), false)
})

test('review rows: which need a decision, and how targets read', async () => {
  const M = await loadModel()
  assert.equal(M.rowNeedsChoice({ status: 'ambiguous', reason: 'no_year' }), true)
  assert.equal(M.rowNeedsChoice({ status: 'unmatched', reason: 'different_year' }), true)
  assert.equal(M.rowNeedsChoice({ status: 'unmatched', reason: 'not_in_library' }), false)
  assert.equal(M.rowNeedsChoice({ status: 'matched', reason: '' }), false)
  assert.equal(M.targetLabel({ type: 'movie', title: 'Heat', year: 1995 }), 'Heat (1995)')
  assert.equal(M.targetLabel({ type: 'episode', title: 'Severance S01E02', year: 2022 }), 'Severance S01E02')
  assert.equal(M.targetLabel(null), '')
  assert.equal(M.personLabel({ name: 'Nick', watched: 5, resume: 1, ratings: 2, favorites: 1, watchlist: 0, lists: 2 }), 'Nick — 5 watched, 1 in progress, 2 rated, 1 favourite, 2 lists')
  assert.equal(M.filterCount({ review: 3, matched: 9, notInLibrary: 4, decided: 1, skipped: 2, total: 16 }, 'decided'), 3)
  for (const m of ['tmdb', 'imdb', 'tvdb', 'filename', 'title', 'title-year', 'title-year-close', 'title-only', 'similar-title']) assert.ok(M.METHOD_WORDS[m], m)
  for (const r of ['not_in_library', 'show_not_in_library', 'episode_not_in_library', 'different_year', 'no_year', 'several_files', 'similar', 'show_unsure', 'no_episode_number', 'no_title']) assert.ok(M.REASON_WORDS[r], r)
})

test('every match method and reason the matcher can give has words in the wizard', () => {
  const src = read('electron', 'migration', 'match.js')
  const methods = new Set([...src.matchAll(/res\('(?:matched|ambiguous)', '([a-z-]+)'/g)].map((m) => m[1]))
  const reasons = new Set([...src.matchAll(/res\('(?:unmatched|ambiguous)', [^,]+, [^,]+, [^,]+, '([a-z_]+)'/g)].map((m) => m[1]))
  const model = read('src', 'lib', 'migrationModel.js')
  for (const m of methods) assert.ok(model.includes(m === 'title-year' ? "'title-year'" : m), 'method ' + m)
  for (const r of reasons) assert.ok(model.includes(r), 'reason ' + r)
  assert.ok(methods.size >= 5 && reasons.size >= 5)
})

test('the component compiles and its first screen renders (before anything is chosen)', async () => {
  const esbuild = require('esbuild')
  const React = require('react')
  const { renderToString } = require('react-dom/server')
  const built = esbuild.buildSync({
    entryPoints: [path.join(appRoot, 'src', 'components', 'MigrationWizard.jsx')],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'transform',
    external: ['react', 'react-dom'], loader: { '.css': 'empty', '.js': 'js', '.jsx': 'jsx' }, logLevel: 'silent',
    // src/locales/index.js uses Vite's import.meta.glob; outside Vite there are no locale files, which is fine here
    define: { 'import.meta.glob': 'globalThis.__noViteGlob' }
  })
  globalThis.__noViteGlob = () => ({})
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', built.outputFiles[0].text)(mod, mod.exports, require)
  globalThis.window = { beeboentertainment: { migrationCall: async () => ({ ok: true, sources: [], imports: [] }) } }
  try {
    const html = renderToString(React.createElement(mod.exports.default))
    assert.match(html, /Switch to Beebo/)
    assert.match(html, /Choose where you are coming from/)
    assert.match(html, /aria-label="Progress"/)
    assert.match(html, /Nothing is changed until you choose Import/)
  } finally { delete globalThis.window }
})

test('the wizard never puts a credential anywhere durable: no storage, cookies, console, window.open or address', () => {
  const src = read('src', 'components', 'MigrationWizard.jsx') + read('src', 'lib', 'migrationModel.js')
  for (const banned of ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie', 'console.', 'window.open', 'location.', 'navigator.clipboard', 'fetch(', 'XMLHttpRequest', 'postMessage']) {
    assert.ok(!src.includes(banned), 'uses ' + banned)
  }
  const comp = read('src', 'components', 'MigrationWizard.jsx')
  assert.match(comp, /type="password"[\s\S]{0,200}autoComplete="off"/, 'the key field is a password field that is not autofilled')
  // The secret is dropped from state as soon as a request has carried it.
  const start = comp.slice(comp.indexOf('const start = async'))
  assert.ok(start.indexOf("call('POST', 'sessions'") < start.indexOf("secret: ''"), 'cleared after the request that sent it')
  assert.match(comp, /const checkConnection[\s\S]*?M\.connectRequest\(source, form\)/)
})

test('the tab, the preload bridge and the IPC handlers are wired', () => {
  const app = read('src', 'App.jsx')
  assert.ok(app.includes("import MigrationWizard from './components/MigrationWizard.jsx'") || app.includes("MigrationWizard = React.lazy(() => import('./components/MigrationWizard.jsx'))"))
  assert.match(app, /\{ id: 'migrate', label: 'Switch to Beebo' \}/)
  assert.match(app, /visitedTabs\.has\('migrate'\)[\s\S]*?<MigrationWizard \/>/)
  assert.match(read('src', 'components', 'NavIcon.jsx'), /migrate:/)
  const pre = read('electron', 'preload.js')
  assert.match(pre, /migrationCall: \(method, path, body, query\) => ipcRenderer\.invoke\('migration:call'/)
  assert.match(pre, /migrationPickFolder: \(\) => ipcRenderer\.invoke\('migration:pickFolder'\)/)
  const main = read('electron', 'main.js')
  assert.match(main, /ipcMain\.handle\('migration:call'/)
  assert.match(main, /ipcMain\.handle\('migration:pickFolder'/)
  // The bridge always runs as the owner, never as a name the page supplies.
  const bridge = main.slice(main.indexOf("ipcMain.handle('migration:call'"), main.indexOf("ipcMain.handle('migration:pickFolder'"))
  assert.match(bridge, /u\.isAdmin/)
  assert.doesNotMatch(bridge, /userId|user\.id\s*=\s*arg|_e\.|event\./)
  const server = read('electron', 'streamServer.js')
  assert.match(server, /p === '\/api\/admin\/migration'/)
  assert.match(server, /migration: \{\s*call: async/)
})
