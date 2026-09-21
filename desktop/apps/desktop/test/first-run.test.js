'use strict'
// First-run: folder suggestions, the live "found N" count, the TMDB key step, the steps model
// and the pairing link. No Electron, no network, no real drives.
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const appRoot = path.resolve(__dirname, '..')
const { detectLibraryFolders, createLiveCounter, sampleFolder, isSkipped } = require(path.join(appRoot, 'electron', 'libraryDetect.js'))
const tmdb = require(path.join(appRoot, 'electron', 'tmdbKeySetup.js'))
const { createFirstRun } = require(path.join(appRoot, 'electron', 'firstRunIpc.js'))
const load = (f) => import(pathToFileURL(path.join(appRoot, 'src', 'lib', f)).href)

// A fake disk: list the files, the folders follow. `reads` counts directory listings so a test
// can prove a search stayed shallow.
function fakeFs(files, p) {
  const dirs = new Map()
  const ensure = (d) => { if (!dirs.has(d)) dirs.set(d, new Map()) }
  for (const f of files) {
    let child = f
    let parent = p.dirname(child)
    ensure(parent)
    dirs.get(parent).set(p.basename(child), false)
    while (parent !== p.dirname(parent)) {
      child = parent
      parent = p.dirname(child)
      ensure(parent)
      dirs.get(parent).set(p.basename(child) || child, true)
    }
  }
  const key = (d) => (p === path.win32 ? String(d).replace(/\//g, '\\') : d)
  const fsx = {
    reads: [],
    promises: {
      readdir: async (d) => {
        fsx.reads.push(d)
        const m = dirs.get(key(d))
        if (!m) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        return [...m].map(([name, isDir]) => ({ name, isDirectory: () => isDir, isFile: () => !isDir }))
      },
      stat: async (d) => {
        if (dirs.has(key(d))) return { isDirectory: () => true }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
    }
  }
  return fsx
}
const many = (dir, p, n, name = (i) => 'Film ' + i + '.mkv') => Array.from({ length: n }, (_, i) => p.join(dir, name(i)))

test('suggests Movies and TV folders from the Videos folder and from other drives, most videos first', async () => {
  const w = path.win32
  const files = [
    ...many('C:\\Users\\Nick\\Videos\\Movies', w, 12),
    ...many('C:\\Users\\Nick\\Videos\\TV Shows\\Bluey\\Season 1', w, 6, (i) => 'Bluey S01E0' + i + '.mkv'),
    ...many('D:\\Movies', w, 40),
    ...many('E:\\Media\\Films', w, 3),
    ...many('E:\\Media\\Series\\Severance\\Season 2', w, 5, (i) => 'Severance S02E0' + i + '.mkv'),
    'C:\\Windows\\System32\\clip.mp4',
    'C:\\Program Files\\App\\movie.mkv',
    'C:\\$Recycle.Bin\\old.mkv'
  ]
  const fsx = fakeFs(files, w)
  const r = await detectLibraryFolders({ fs: fsx, platform: 'win32', homedir: 'C:\\Users\\Nick' })
  assert.deepEqual(r.movies.map((m) => m.path), ['D:\\Movies', 'C:\\Users\\Nick\\Videos\\Movies', 'E:\\Media\\Films'])
  assert.equal(r.movies[0].videos, 40)
  assert.deepEqual(r.tv.map((m) => m.path).sort(), ['C:\\Users\\Nick\\Videos\\TV Shows', 'E:\\Media\\Series'].sort())
  const walked = fsx.reads.join('\n')
  assert.ok(!/Windows|Program Files|Recycle/i.test(walked), 'system folders are never listed')
})

test('the search is a bounded listing, not a drive walk: depth, entries and time are capped', async () => {
  const p = path.posix
  const deep = []
  for (let i = 0; i < 30; i++) deep.push('/mnt/big/Movies/a/b/c/d/e/f/g/h/i/j/k/file' + i + '.mkv')
  for (let i = 0; i < 900; i++) deep.push('/mnt/big/Movies/f' + i + '.mkv')
  const fsx = fakeFs(deep, p)
  const r = await detectLibraryFolders({ fs: fsx, platform: 'linux', homedir: '/home/nick' })
  assert.equal(r.movies.length, 1)
  assert.equal(r.movies[0].path, '/mnt/big/Movies')
  assert.ok(r.movies[0].videos <= 500, 'a sample, never the whole tree: ' + r.movies[0].videos)
  assert.equal(r.movies[0].truncated, true)
  assert.ok(!fsx.reads.some((d) => /\/k$/.test(d)), 'never descended past the depth limit')

  let t = 0
  const slow = await detectLibraryFolders({ fs: fakeFs(['/media/x/Movies/a.mkv'], p), platform: 'linux', homedir: '/h', now: () => (t += 5000), maxMs: 1000 })
  assert.equal(slow.timedOut, true)
})

test('a folder that only looks like a container is classified by what is inside', async () => {
  const p = path.posix
  const files = [
    ...many('/home/nick/Videos/Season 1', p, 4, (i) => 'Show S01E0' + i + '.mkv'),
    '/home/nick/Videos/Season 1/../x'
  ].filter((f) => !f.includes('..'))
  const r = await detectLibraryFolders({ fs: fakeFs(files, p), platform: 'linux', homedir: '/home/nick' })
  assert.equal(r.movies.length, 0)
  assert.equal(r.tv[0].path, '/home/nick/Videos')
})

test('folders Beebo already uses are not suggested again, and empty folders are dropped', async () => {
  const p = path.posix
  const fsx = fakeFs([...many('/mnt/a/Movies', p, 3), '/mnt/b/Movies/readme.txt'], p)
  const r = await detectLibraryFolders({ fs: fsx, platform: 'linux', homedir: '/h', exclude: ['/MNT/A/movies'] })
  assert.deepEqual(r.movies, [])
})

test('a hung or missing disk cannot break detection', async () => {
  const boom = { promises: { readdir: async () => { throw new Error('offline') }, stat: () => new Promise(() => {}) } }
  const r = await detectLibraryFolders({ fs: boom, platform: 'win32', homedir: 'C:\\Users\\N' })
  assert.deepEqual([r.movies, r.tv], [[], []])
})

test('sampleFolder counts video, season folders and episode-style names', async () => {
  const p = path.posix
  const s = await sampleFolder(fakeFs([...many('/x/Show/Season 1', p, 3, (i) => 'S01E0' + i + '.mkv'), '/x/notes.txt'], p), '/x', { pathMod: p })
  assert.deepEqual([s.videos, s.seasonDirs, s.episodeNames], [3, 1, 3])
  assert.equal(isSkipped('$RECYCLE.BIN'), true)
  assert.equal(isSkipped('Movies'), false)
})

test('the live counter climbs while it walks, counts shows, and a new start cancels the old walk', async () => {
  const p = path.posix
  const files = [...many('/lib/movies', p, 4), ...many('/lib/tv/Bluey/Season 1', p, 3), ...many('/lib/tv/Severance/Season 1', p, 2)]
  const c = createLiveCounter({ fs: fakeFs(files, p), path: p })
  c.start({ movies: ['/lib/movies'], tv: ['/lib/tv'] })
  assert.equal(c.status().running, true)
  for (let i = 0; i < 50 && c.status().running; i++) await new Promise((r) => setTimeout(r, 5))
  const s = c.status()
  assert.equal(s.running, false)
  assert.equal(s.movies.count, 4)
  assert.equal(s.tv.count, 5)
  assert.equal(s.tv.shows, 2)
  assert.equal(s.movies.done && s.tv.done, true)
  c.start({ movies: ['/lib/tv'] })
  c.start({ movies: [] })
  assert.equal(c.status().movies.count, 0)
})

test('the live counter stops at its entry limit and says so', async () => {
  const p = path.posix
  const c = createLiveCounter({ fs: fakeFs(many('/m', p, 50), p), path: p, limits: { maxEntries: 10 } })
  c.start({ movies: ['/m'] })
  for (let i = 0; i < 50 && c.status().running; i++) await new Promise((r) => setTimeout(r, 5))
  assert.equal(c.status().truncated, true)
  assert.ok(c.status().movies.count <= 10)
})

// ---- TMDB key -----------------------------------------------------------------------------
const V3 = '0123456789abcdef0123456789abcdef'
const V4 = 'eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJhYmMifQ.c2lnbmF0dXJlLXZhbHVl'

test('key format: v3, v4, pasted "Bearer", stray quotes and spaces; junk is rejected without a network call', async () => {
  assert.deepEqual(tmdb.classifyKey(' ' + V3 + ' \n'), { ok: true, kind: 'v3', key: V3 })
  assert.equal(tmdb.classifyKey('Bearer ' + V4).kind, 'v4')
  assert.equal(tmdb.classifyKey('"' + V3 + '"').key, V3)
  for (const bad of ['', '   ', 'abc', V3 + 'z', 'x'.repeat(2000), 'a.b.c', null, undefined, {}]) assert.equal(tmdb.classifyKey(bad).ok, false)
  let calls = 0
  const r = await tmdb.validateTmdbKey('nope', { fetchImpl: async () => { calls++ } })
  assert.deepEqual([r.ok, r.reason, calls], [false, 'format', 0])
})

test('validating a key: the test call, every failure named, and the key never leaves in a header for v3', async () => {
  const seen = []
  const fetchImpl = (status) => async (url, init) => { seen.push({ url, init }); return { status, ok: status >= 200 && status < 300 } }
  assert.deepEqual(await tmdb.validateTmdbKey(V3, { fetchImpl: fetchImpl(200) }), { ok: true, kind: 'v3', reason: 'valid' })
  assert.match(seen[0].url, /^https:\/\/api\.themoviedb\.org\/3\/configuration\?api_key=/)
  assert.equal(seen[0].init.headers.Authorization, undefined)
  assert.equal((await tmdb.validateTmdbKey(V4, { fetchImpl: fetchImpl(200) })).kind, 'v4')
  assert.equal(seen[1].init.headers.Authorization, 'Bearer ' + V4)
  assert.ok(!/eyJ/.test(seen[1].url))
  assert.equal((await tmdb.validateTmdbKey(V3, { fetchImpl: fetchImpl(401) })).reason, 'invalid')
  assert.equal((await tmdb.validateTmdbKey(V3, { fetchImpl: fetchImpl(429) })).reason, 'rate')
  assert.equal((await tmdb.validateTmdbKey(V3, { fetchImpl: fetchImpl(503) })).reason, 'unavailable')
  assert.equal((await tmdb.validateTmdbKey(V3, { fetchImpl: async () => { throw new Error('ENOTFOUND') } })).reason, 'network')
  const hung = await tmdb.validateTmdbKey(V3, { fetchImpl: () => new Promise(() => {}), timeoutMs: 20 })
  assert.equal(hung.reason, 'timeout')
})

test('the hosted-metadata seam: today the screen offers the own-key source; a hosted one takes over once flagged available', () => {
  assert.equal(tmdb.defaultSource().id, 'own-key')
  assert.deepEqual(tmdb.availableSources().map((s) => s.id), ['own-key'])
  const hosted = tmdb.METADATA_SOURCES.find((s) => s.id === 'beebo-hosted')
  assert.equal(hosted.needsKey, false)
  hosted.available = true
  try { assert.equal(tmdb.defaultSource().id, 'beebo-hosted') } finally { hosted.available = false }
})

function memStore(init = {}) { const m = new Map(Object.entries(init)); return { get: (k) => m.get(k), set: (k, v) => m.set(k, v), _m: m } }

test('firstRun service: suggestions can be applied, nothing else can; the key is saved only when it checks out', async () => {
  const store = memStore()
  const applied = []
  const svc = createFirstRun({
    store,
    getMoviesDirs: () => ['/m'], getTvDirs: () => ['/t'],
    applyFolder: async (k, d) => { applied.push([k, d]); return { ok: true } },
    getDefaultDirs: () => ['C:\\Beebo\\Movies'],
    detect: async ({ exclude }) => { assert.deepEqual(exclude, ['C:\\Beebo\\Movies']); return { movies: [{ path: path.resolve('/mnt/Movies'), videos: 3 }], tv: [], timedOut: false } },
    counter: { start: (a) => a, status: () => ({ running: false }) },
    validate: async (k) => (k.trim() === V3 ? { ok: true, reason: 'valid' } : { ok: false, reason: 'invalid' })
  })
  assert.equal((await svc.useFolder('moviesDir', path.resolve('/mnt/Movies'))).ok, false, 'not offered yet')
  await svc.detectFolders()
  assert.equal((await svc.useFolder('musicDir', path.resolve('/mnt/Movies'))).ok, false, 'only Movies and TV')
  assert.equal((await svc.useFolder('moviesDir', path.resolve('/etc'))).ok, false, 'only what was suggested')
  assert.equal((await svc.useFolder('moviesDir', path.resolve('/mnt/Movies'))).ok, true)
  assert.deepEqual(applied, [['moviesDir', path.resolve('/mnt/Movies')]])
  assert.deepEqual(svc.countStart(), { movies: ['/m'], tv: ['/t'] })

  assert.equal(svc.tmdbState().hasKey, false)
  const bad = await svc.tmdbSave('wrong')
  assert.deepEqual([bad.ok, store.get('tmdbApiKey')], [false, undefined])
  assert.match(bad.message, /did not accept/)
  const good = await svc.tmdbSave(' ' + V3 + ' ')
  assert.deepEqual([good.ok, store.get('tmdbApiKey')], [true, V3])
  assert.ok(!JSON.stringify(good).includes(V3), 'the key is never echoed back')
  assert.equal(svc.tmdbState().hasKey, true)

  assert.deepEqual(svc.setFlag('postersSkipped', true), { postersSkipped: true, awayDismissed: false })
  assert.deepEqual(svc.setFlag('tmdbApiKey', true), { postersSkipped: true, awayDismissed: false }, 'only known flags')
  assert.equal(store.get('firstRun.tmdbApiKey'), undefined)
})

// ---- steps model and words ------------------------------------------------------------------
test('steps: one list drives the bar and the badges; optional steps never block; the phone step follows homeOk', async () => {
  const m = await load('firstRun.js')
  let steps = m.firstRunSteps({})
  assert.deepEqual(steps.map((s) => s.id), ['folders', 'posters', 'account', 'phone', 'away'])
  assert.equal(m.nextStep(steps), 'folders')
  steps = m.firstRunSteps({ hasMovies: true, hasOwner: true })
  assert.equal(m.nextStep(steps), 'phone', 'posters is optional so it does not hold the phone back')
  steps = m.firstRunSteps({ hasMovies: true, hasOwner: true, phoneOk: true })
  assert.equal(m.nextStep(steps), null)
  assert.equal(m.stepById(steps, 'phone').done, true, 'the badge and the bar read the same value')
  assert.equal(m.stepById(steps, 'posters').optional, true)
})

test('found-count wording: climbing, done, empty, singular, and truncated', async () => {
  const m = await load('firstRun.js')
  assert.equal(m.moviesFoundText({ movies: { count: 0, done: false } }), 'Looking for movies…')
  assert.equal(m.moviesFoundText({ movies: { count: 412, done: false } }), 'Found 412 movies so far…')
  assert.equal(m.moviesFoundText({ movies: { count: 412, done: true } }), 'Found 412 movies')
  assert.equal(m.moviesFoundText({ movies: { count: 1, done: true } }), 'Found 1 movie')
  assert.equal(m.moviesFoundText({ movies: { count: 1500, done: true }, truncated: true }), 'Found 1,500 movies (and counting)')
  assert.match(m.moviesFoundText({ movies: { count: 0, done: true } }), /No movies found/)
  assert.equal(m.showsFoundText({ tv: { count: 1204, shows: 37, done: true } }), 'Found 1,204 episodes from 37 shows')
  assert.equal(m.suggestionCountText({ videos: 1, truncated: false }), '1 video')
  assert.equal(m.suggestionCountText({ videos: 500, truncated: true }), 'at least 500 videos')
  assert.ok(m.shortPath('C:\\Users\\Nick\\Videos\\Movies\\Family\\Holidays\\2019').length <= 46)
})

// ---- the pairing link -----------------------------------------------------------------------
test('the pairing link: exact format, the name is optional, junk yields no link', async () => {
  const m = await load('pairLink.js')
  assert.equal(m.buildPairLink({ server: '192.168.1.20:47811', name: 'thesmiths' }), 'beebo://pair?server=192.168.1.20:47811&name=thesmiths')
  assert.equal(m.buildPairLink({ server: 'http://192.168.1.20:47811/' }), 'beebo://pair?server=192.168.1.20:47811')
  assert.equal(m.buildPairLink({ server: 'PC-1.local:47811', name: 'Smiths.beebo.tv' }), 'beebo://pair?server=PC-1.local:47811&name=smiths')
  assert.equal(m.buildPairLink({ server: '[fe80::1]:47811' }), 'beebo://pair?server=%5Bfe80::1%5D:47811')
  for (const bad of ['', '192.168.1.20', '192.168.1.20:0', '192.168.1.20:70000', 'a b:1', '1.2.3.4:5&x=1', 'javascript:alert(1)', '1.2.3.4:5/../x', null, undefined]) assert.equal(m.buildPairLink({ server: bad }), '', String(bad))
  assert.equal(m.buildPairLink({ server: '1.2.3.4:5', name: 'bad name&x=1' }), 'beebo://pair?server=1.2.3.4:5', 'a bad name is dropped, not encoded in')
  assert.equal(m.plainAddress('192.168.1.20:47811'), 'http://192.168.1.20:47811')
})

test('away account: the reset link, no wall on the home library, every failure has plain words', async () => {
  const m = await load('awayAccount.js')
  assert.match(m.RESET_PASSWORD_URL, /^https:\/\/www\.beeboentertainment\.com\/reset-password\.html$/)
  assert.match(m.humanError({ reason: 'invalid_credentials' }), /Forgot password/)
  assert.match(m.humanError({ reason: 'network_timeout' }), /internet connection/)
  assert.match(m.humanError(null), /Something went wrong/)
  assert.match(m.humanError({ error: 'weird_code' }), /weird_code/)
  assert.match(m.gateNotice({ state: 'email_required' }), /home library stays free/)
  assert.equal(m.gateNotice({ state: 'none' }), '')
  assert.equal(m.gateNotice(null), '')
})

test('nothing about the first run waits for the cloud sign-in: the card is opt-in and the owner account turns on start-with-Windows', () => {
  const fs = require('node:fs')
  const gate = fs.readFileSync(path.join(appRoot, 'src', 'components', 'SignInGate.jsx'), 'utf8')
  assert.ok(/\{children\}/.test(gate) && !/phase/.test(gate), 'children render with no phase that can withhold them')
  assert.ok(gate.includes("'beebo:open-signin'"), 'opened only on request')
  const main = fs.readFileSync(path.join(appRoot, 'electron', 'main.js'), 'utf8')
  assert.ok(main.includes('reliability.ownerCreated('), 'the first owner account defaults start-with-Windows on')
  const rel = fs.readFileSync(path.join(appRoot, 'electron', 'reliability.js'), 'utf8')
  assert.ok(/hasSignedIn: \(\) => signedIn\(\) \|\| /.test(rel), 'an owner counts as "set up" without a cloud account')
})

test('pairFromAddress upgrades a plain LAN address and leaves everything else alone', async () => {
  const m = await load('pairLink.js')
  assert.equal(m.pairFromAddress('http://192.168.1.20:47811'), 'beebo://pair?server=192.168.1.20:47811')
  assert.equal(m.pairFromAddress('http://192.168.1.20:47811/', 'thesmiths'), 'beebo://pair?server=192.168.1.20:47811&name=thesmiths')
  assert.equal(m.pairFromAddress('https://thesmiths.beebo.tv'), 'https://thesmiths.beebo.tv')
  assert.equal(m.pairFromAddress('http://192.168.1.20:47811/admin'), 'http://192.168.1.20:47811/admin')
})

test('folders step: done when the person chose a folder or real video was found, not by the starting folder existing', async () => {
  const m = await load('firstRun.js')
  assert.equal(m.foldersDone({ moviesDir: 'C:\\Beebo\\Movies', tvDir: 'C:\\Beebo\\TV Shows', found: 0 }), false)
  assert.equal(m.foldersDone({ moviesDir: 'C:\\BEEBO\\movies\\', tvDir: '', found: 1 }), false, 'only the welcome clip')
  assert.equal(m.foldersDone({ moviesDir: 'C:\\Beebo\\Movies', tvDir: '', found: 250 }), true)
  assert.equal(m.foldersDone({ moviesDir: 'D:\\Films', tvDir: '', found: 0 }), true)
  assert.equal(m.foldersDone({ moviesDir: 'C:\\Beebo\\Movies', tvDir: 'E:\\Shows' }), true)
})
