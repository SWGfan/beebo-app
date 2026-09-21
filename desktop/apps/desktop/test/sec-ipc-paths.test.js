'use strict'
// Paths that arrive over IPC (security review 2026-09-21, E-1..E-5): the window may not make the main process
// launch an executable, move a file out of the library, copy a private file into it, or probe a network share.
// The pure rules live in electron/ipcPathGuard.js; main.js and detailsIpc.js must use them (checked by a source
// scan for main.js, which cannot be loaded without Electron, and by a real call for detailsIpc.js).
// Run: node --test test/sec-ipc-paths.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const guard = require('../electron/ipcPathGuard')
const detailsIpc = require('../electron/detailsIpc')

const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
const win = process.platform === 'win32'

/** The source of `ipcMain.handle('<channel>', ...` up to the next top-level `ipcMain.handle(` / function. */
function handlerSource(channel) {
  const at = mainSrc.indexOf(`ipcMain.handle('${channel}'`)
  assert.ok(at >= 0, `${channel} handler not found`)
  const rest = mainSrc.slice(at + 10)
  const next = rest.search(/\r?\n(?:ipcMain\.handle\(|function |async function |const [A-Za-z]+ = )/)
  return mainSrc.slice(at, at + 10 + (next < 0 ? 3000 : next))
}

const roots = [path.join(os.tmpdir(), 'lib-a', 'Movies'), path.join(os.tmpdir(), 'lib-a', 'TV Shows')]

test('insideRoots: only paths at or below a root; siblings, dot-dot, NUL, junk are refused', () => {
  assert.equal(guard.insideRoots(path.join(roots[0], 'a.mkv'), roots), path.join(roots[0], 'a.mkv'))
  assert.equal(guard.insideRoots(path.join(roots[1], 'Show', 'S01', 'e.mkv'), roots), path.join(roots[1], 'Show', 'S01', 'e.mkv'))
  assert.equal(guard.insideRoots(roots[0], roots), roots[0])
  assert.equal(guard.insideRoots(path.join(roots[0], '..', 'x.mkv'), roots), null)
  assert.equal(guard.insideRoots(path.join(roots[0], '..', '..', 'Windows', 'notepad.exe'), roots), null)
  assert.equal(guard.insideRoots(roots[0] + '-evil' + path.sep + 'a.mkv', roots), null, 'a folder that merely starts with the same letters')
  assert.equal(guard.insideRoots(path.join(roots[0], 'a\0.mkv'), roots), null)
  for (const bad of ['', null, undefined, 7, {}, ['x'], 'x'.repeat(5000)]) assert.equal(guard.insideRoots(bad, roots), null)
  assert.equal(guard.insideRoots(path.join(roots[0], 'a.mkv'), []), null)
  if (win) {
    assert.ok(guard.insideRoots(path.join(roots[0], 'a.mkv').toUpperCase(), roots), 'Windows paths are not case sensitive')
    assert.equal(guard.insideRoots('\\\\attacker\\share\\a.mkv', roots), null, 'a network share is not a library folder')
  }
})

test('hasPlayableExt: video containers only, never an executable or a data stream', () => {
  for (const ok of ['a.mkv', 'A.MP4', 'x.y.avi', 'a.mov', 'a.webm', 'a.ts', 'a.m2ts']) assert.equal(guard.hasPlayableExt(path.join(roots[0], ok)), true, ok)
  for (const bad of ['a.exe', 'a.lnk', 'a.bat', 'a.cmd', 'a.hta', 'a.ps1', 'a.scr', 'a.msi', 'a.jar', 'a.js', 'a.vbs', 'a', 'a.', 'a.mkv.exe', 'a.mkv ']) {
    assert.equal(guard.hasPlayableExt(path.join(roots[0], bad)), false, bad)
  }
  assert.equal(guard.hasPlayableExt(path.join(roots[0], 'clip.exe:evil.mkv'), { platform: 'win32' }), false, 'alternate data stream')
  assert.equal(guard.hasPlayableExt(path.join(roots[0], 'Movie: The Sequel.mkv'), { platform: 'linux' }), true, 'a colon is an ordinary character off Windows')
  for (const bad of ['', null, undefined, 5, 'a\0.mkv']) assert.equal(guard.hasPlayableExt(bad), false)
})

test('playableVideoPath: inside the library AND a video (this is what "Play" may open)', () => {
  assert.equal(guard.playableVideoPath(path.join(roots[0], 'Film.mkv'), roots), path.join(roots[0], 'Film.mkv'))
  assert.equal(guard.playableVideoPath(path.join(roots[0], 'setup.exe'), roots), null, 'an executable inside the library')
  assert.equal(guard.playableVideoPath(path.join(os.tmpdir(), 'Film.mkv'), roots), null, 'a video outside the library')
  assert.equal(guard.playableVideoPath(win ? 'C:\\Windows\\System32\\calc.exe' : '/bin/sh', roots), null)
})

test('importableVideoSource: an absolute path to a video, nothing else', () => {
  const abs = path.join(os.tmpdir(), 'dropped', 'clip.mp4')
  assert.equal(guard.importableVideoSource(abs), abs)
  assert.equal(guard.importableVideoSource(path.join(os.tmpdir(), 'notes.txt')), null, 'a private file given a video name still has its own extension')
  assert.equal(guard.importableVideoSource(path.join(os.tmpdir(), 'config.json')), null)
  assert.equal(guard.importableVideoSource('clip.mp4'), null, 'relative')
  for (const bad of ['', null, undefined, 3, {}]) assert.equal(guard.importableVideoSource(bad), null)
})

test('showFolderName: one folder name, never a path', () => {
  assert.equal(guard.showFolderName('Arrow'), 'Arrow')
  assert.equal(guard.showFolderName('  The Office (US) '), 'The Office (US)')
  for (const evil of ['..\\..\\Users\\x\\Startup', '../../etc', 'a/b', 'a\\b', 'C:\\Windows', '\\\\host\\share', '..', '.', '...', '   ']) {
    const out = guard.showFolderName(evil)
    assert.ok(!/[\\/]/.test(out), `${evil} -> ${out}`)
    assert.ok(out === '' || (out !== '..' && out !== '.'), `${evil} -> ${out}`)
    assert.ok(!out.includes(':'), `${evil} -> ${out}`)
  }
  assert.equal(guard.showFolderName('..'), '')
  assert.equal(guard.showFolderName('CON'), '_CON', 'a Windows device name')
  assert.equal(guard.showFolderName(null), '')
  assert.ok(guard.showFolderName('x'.repeat(500)).length <= 120)
})

// ---- main.js wiring (the file needs Electron, so it is checked by reading it) ---------------------------------------
test('main.js: movies:play never hands the window\'s path straight to shell.openPath', () => {
  const src = handlerSource('movies:play')
  assert.match(src, /ipcPathGuard\.playableVideoPath\(/, 'the path is checked against the library and the video types')
  assert.ok(!/shell\.openPath\(\s*filePath\s*\)/.test(src), 'no shell.openPath(filePath) on the raw argument')
})

test('main.js: convert:playFile also requires a video file', () => {
  assert.match(handlerSource('convert:playFile'), /ipcPathGuard\.hasPlayableExt\(/)
})

test('main.js: library:moveToTvShows turns the show name into one safe folder name', () => {
  const src = handlerSource('library:moveToTvShows')
  assert.match(src, /ipcPathGuard\.showFolderName\(/)
  assert.ok(!/const showName = \(item\?\.showName/.test(src), 'the raw show name is not used to build the folder')
})

test('main.js: importing dropped files checks the file it copies FROM, not only the name it is given', () => {
  const at = mainSrc.indexOf('function importUploadedFile(')
  assert.ok(at >= 0)
  const src = mainSrc.slice(at, at + 1400)
  assert.match(src, /ipcPathGuard\.importableVideoSource\(/)
  assert.ok(!/copyFileSync\(\s*srcPath\s*,/.test(src), 'no copy from the raw source path')
})

test('main.js: video quality probing stays inside the library folders (no network-share probing)', () => {
  const at = mainSrc.indexOf('async function getVideoQualityBatch(')
  assert.ok(at >= 0)
  assert.match(mainSrc.slice(at, at + 1600), /ipcPathGuard\.insideRoots\(/)
})

test('main.js: the packaged app never loads an address taken from the environment into its privileged window', () => {
  const at = mainSrc.indexOf('function createWindow()')
  assert.ok(at >= 0)
  const src = mainSrc.slice(at, at + 1600)
  assert.match(src, /!app\.isPackaged && process\.env\.VITE_DEV_SERVER_URL/)
  assert.ok(!/if \(process\.env\.VITE_DEV_SERVER_URL\)/.test(src), 'an unconditional dev-server load would be reachable in the installed app')
})

test('every window the app creates outside main.js is sandboxed too (watchTogetherIpc.js, detailsIpc.js)', () => {
  const dir = path.join(__dirname, '..', 'electron')
  const found = []
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.js') && n !== 'streamServer.js' && !n.startsWith('_zz'))) {
    const src = fs.readFileSync(path.join(dir, name), 'utf8')
    const windows = (src.match(/new BrowserWindow\(/g) || []).length
    if (!windows) continue
    found.push(name)
    assert.equal((src.match(/sandbox:\s*true/g) || []).length, windows, `${name}: every BrowserWindow says sandbox: true`)
    assert.equal(/nodeIntegration:\s*true|contextIsolation:\s*false|webSecurity:\s*false/.test(src), false, name)
  }
  assert.ok(found.includes('watchTogetherIpc.js') && found.includes('detailsIpc.js') && found.includes('main.js'), found.join(','))
})

test('main.js: backup:preview re-reads only a file its own dialog returned', () => {
  const src = handlerSource('backup:preview')
  assert.match(src, /backupPickedPaths\.has\(/)
  assert.match(src, /backupPickedPaths\.add\(/)
})

// ---- detailsIpc.js: a real call -------------------------------------------------------------------------------------
function detailsHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-secipc-'))
  const movies = path.join(dir, 'Movies')
  fs.mkdirSync(movies)
  const files = { video: path.join(movies, 'Film (2010).mkv'), exe: path.join(movies, 'setup.exe'), lnk: path.join(movies, 'x.lnk') }
  for (const f of Object.values(files)) fs.writeFileSync(f, 'x')
  const handlers = new Map()
  const opened = []
  const store = { get: () => undefined, set: () => {} }
  detailsIpc.register({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    shell: { openPath: async (p) => { opened.push(p); return '' }, openExternal: () => {} },
    BrowserWindow: class { constructor() { this.webContents = { session: { cookies: { set: async () => {} } } } } async loadURL() {} },
    store,
    auth: { getUsers: () => [{ id: 'owner', isAdmin: true, status: 'approved' }], signSession: () => 's' },
    history: {}, watchedState: {}, details: {}, mediaInfo: {}, trailersService: null, tmdbCache: {},
    getCacheDir: () => path.join(dir, 'cache'), getStreamPort: () => 4321, getMoviesDirs: () => [movies], getTvDirs: () => [],
    scanMovies: async () => [], scanTv: async () => []
  })
  return { handlers, opened, files, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

test('details:play: an executable or shortcut inside the library is never opened', async () => {
  const h = detailsHarness()
  try {
    const play = h.handlers.get('details:play')
    for (const f of [h.files.exe, h.files.lnk]) {
      const r = await play({}, { kind: 'movie', path: f })
      assert.deepEqual(r, { ok: false, error: 'not_a_video_file' }, path.basename(f))
    }
    assert.deepEqual(h.opened, [], 'shell.openPath was never called')
    const ok = await play({}, { kind: 'movie', path: h.files.video })
    assert.deepEqual(ok, { ok: true, via: 'system' })
    assert.deepEqual(h.opened, [h.files.video])
  } finally { h.cleanup() }
})
