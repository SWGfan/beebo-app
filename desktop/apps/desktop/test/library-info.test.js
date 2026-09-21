// What the Table view reads from video files (electron/libraryInfo.js) and how the desktop window
// reaches it (electron/libraryTableIpc.js): bounded ffprobe concurrency, a cache keyed by
// path | size | modified time, latest-request-wins, and only files inside the library folders.
// Run: node --test test/library-info.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const info = require('../electron/libraryInfo')
const ipc = require('../electron/libraryTableIpc')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-libinfo-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms = 3000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timed out'); await sleep(5) } }

// ---------------------------------------------------------------- parsing

const stream = (o) => ({ disposition: {}, tags: {}, ...o })
const FILM = {
  streams: [
    stream({ index: 0, codec_type: 'video', codec_name: 'hevc', profile: 'Main 10', width: 3840, height: 1608, avg_frame_rate: '24000/1001', r_frame_rate: '24000/1001', color_transfer: 'smpte2084', bit_rate: '45000000', codec_tag_string: '[0][0][0][0]' }),
    stream({ index: 1, codec_type: 'audio', codec_name: 'truehd', channels: 8, channel_layout: '7.1', tags: { language: 'eng' }, disposition: { default: 1 } }),
    stream({ index: 2, codec_type: 'audio', codec_name: 'ac3', channels: 6, channel_layout: '5.1(side)', tags: { language: 'fra' } }),
    stream({ index: 3, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'eng' } }),
    stream({ index: 4, codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle', tags: { language: 'spa' } }),
    stream({ index: 5, codec_type: 'subtitle', codec_name: 'subrip', tags: {} })
  ],
  format: { format_name: 'matroska,webm', duration: '7620.5', bit_rate: '46000000' }
}

test('a 4K HDR10 film with three subtitle tracks is read into one compact record', () => {
  const r = info.parseProbe(FILM, 40e9)
  assert.equal(r.width, 3840)
  assert.equal(r.height, 1608)
  assert.equal(r.videoCodec, 'hevc')
  assert.equal(r.fps, 23.976)
  assert.equal(r.hdr, 'HDR10')
  assert.equal(r.videoKbps, 45000)
  assert.equal(r.totalKbps, 46000)
  assert.equal(r.durationSec, 7620.5)
  assert.deepEqual(r.audio.map((a) => [a.codec, a.channels, a.layout, a.isDefault]), [['truehd', 8, '7.1', true], ['ac3', 6, '5.1(side)', false]])
  assert.deepEqual(r.audioLangs, ['English', 'French'])
  assert.deepEqual(r.subLangs, ['English', 'Spanish', 'Unknown'], 'a track with no language is counted, not hidden')
  assert.equal(r.subCount, 3)
})

test('HDR type: Dolby Vision from side data or the codec tag, HDR10, HLG, else SDR', () => {
  const v = (o) => info.hdrOf(stream({ codec_type: 'video', ...o }))
  assert.equal(v({ color_transfer: 'smpte2084', side_data_list: [{ side_data_type: 'DOVI configuration record' }] }), 'Dolby Vision')
  assert.equal(v({ color_transfer: 'smpte2084', codec_tag_string: 'dvh1' }), 'Dolby Vision')
  assert.equal(v({ codec_tag_string: 'dvhe' }), 'Dolby Vision')
  assert.equal(v({ color_transfer: 'smpte2084' }), 'HDR10')
  assert.equal(v({ color_transfer: 'arib-std-b67' }), 'HLG')
  assert.equal(v({ color_transfer: 'bt709' }), 'SDR')
  assert.equal(v({}), 'SDR')
})

test('cover art is not the video, a missing bitrate is worked out from size and length, junk is refused', () => {
  const art = info.parseProbe({
    streams: [stream({ codec_type: 'video', codec_name: 'mjpeg', width: 600, height: 600, disposition: { attached_pic: 1 } }), stream({ codec_type: 'audio', codec_name: 'mp3', channels: 2 })],
    format: { duration: '100' }
  }, 1_000_000)
  assert.equal(art.width, null, 'an audio file with cover art has no video size')
  assert.equal(art.videoCodec, null)
  assert.equal(art.totalKbps, 80)
  assert.equal(info.parseProbe({ streams: [], format: {} }, 1), null)
  assert.equal(info.parseProbe(null, 1), null)
  assert.equal(info.parseProbe('nope', 1), null)
  const noDur = info.parseProbe({ streams: [stream({ codec_type: 'video', codec_name: 'h264', width: 640, height: 360 })], format: {} }, 1000)
  assert.equal(noDur.totalKbps, null)
  assert.equal(noDur.durationSec, 0)
})

test('the cache key is path | size | modified time, and the path comes back out of it', () => {
  const key = info.keyFor('D:\\Movies\\A | B.mkv', { size: 10, mtimeMs: 5.9 })
  assert.equal(key, 'D:\\Movies\\A | B.mkv|10|5')
  assert.equal(info.pathOfKey(key), 'D:\\Movies\\A | B.mkv')
})

// ---------------------------------------------------------------- the service

// A fake library: path -> { size, mtimeMs }; a fake ffprobe that answers from the file name and can be held.
function rig(files, { concurrency = 3, cacheFile = null, exe = 'ffprobe', failOn = () => false, hold = false } = {}) {
  const fake = { files: new Map(Object.entries(files)), execs: [], running: 0, peak: 0, gate: null }
  if (hold) { let open; fake.gate = new Promise((r) => { open = r }); fake.release = () => open() }
  const service = info.createLibraryInfo({
    ffprobePath: () => exe,
    cacheFile,
    concurrency,
    flushMs: 10,
    saveMs: 20,
    setPriority: () => {},
    statFn: async (p) => {
      const f = fake.files.get(p)
      if (!f) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return { size: f.size, mtimeMs: f.mtimeMs, birthtimeMs: f.birthMs || 0 }
    },
    execFileFn: (bin, args, opts, cb) => {
      const file = String(args[args.indexOf('-i') + 1]).replace(/^file:/, '') // inputs are file:-prefixed (electron/ffmpegArgs.js)
      fake.execs.push(file)
      fake.running++
      fake.peak = Math.max(fake.peak, fake.running)
      const done = () => {
        fake.running--
        if (failOn(file)) return cb(new Error('boom'))
        cb(null, JSON.stringify({ streams: [stream({ codec_type: 'video', codec_name: 'h264', width: 1920, height: 800 }), stream({ codec_type: 'audio', codec_name: 'aac', channels: 2 })], format: { duration: '3600', format_name: 'matroska,webm' } }))
      }
      Promise.resolve(fake.gate).then(() => sleep(5)).then(done)
      return { pid: undefined }
    }
  })
  return { service, fake }
}
const many = (n, prefix = 'D:\\Movies\\m') => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}${i}.mkv`, { size: 1000 + i, mtimeMs: 1e12 + i, birthMs: 1e12 - i }]))

test('opening the table reads at most three files at a time, however many rows want details', async () => {
  const files = many(40)
  const { service, fake } = rig(files)
  const got = {}
  const res = await service.request('movies', Object.keys(files), (b) => Object.assign(got, b.info))
  assert.equal(Object.keys(res.info).length, 40, 'every path is answered at once with what a stat gives')
  assert.ok(Object.values(res.info).every((r) => r.probed === false && r.size > 0 && r.birthMs > 0), 'size and creation time are known before any probe')
  await until(() => Object.keys(got).length === 40)
  assert.ok(fake.peak <= 3, `peak concurrency ${fake.peak}`)
  assert.equal(fake.execs.length, 40)
  assert.ok(Object.values(got).every((r) => r.probed && !r.failed && r.width === 1920 && r.height === 800 && r.videoCodec === 'h264'))
})

test('results are remembered on disk: a restart answers from the cache without one probe', async () => {
  const dir = tmp()
  const cacheFile = path.join(dir, 'lib.json')
  const files = many(6)
  const a = rig(files, { cacheFile })
  const got = {}
  await a.service.request('movies', Object.keys(files), (b) => Object.assign(got, b.info))
  await until(() => Object.keys(got).length === 6)
  await a.service.saveNow()
  assert.ok(fs.existsSync(cacheFile))
  const b = rig(files, { cacheFile })
  const res = await b.service.request('movies', Object.keys(files), () => {})
  assert.ok(Object.values(res.info).every((r) => r.probed && r.width === 1920), 'all served from the saved cache')
  assert.equal(res.remaining, 0)
  assert.equal(b.fake.execs.length, 0, 'no ffprobe was started')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a file replaced at the same path (new size or modified time) is read again', async () => {
  const dir = tmp()
  const cacheFile = path.join(dir, 'lib.json')
  const p = 'D:\\Movies\\x.mkv'
  const a = rig({ [p]: { size: 100, mtimeMs: 1e12 } }, { cacheFile })
  let got = {}
  await a.service.request('m', [p], (b) => Object.assign(got, b.info))
  await until(() => got[p])
  a.service.saveSync()
  const b = rig({ [p]: { size: 100, mtimeMs: 1e12 + 60000 } }, { cacheFile })
  got = {}
  const res = await b.service.request('m', [p], (x) => Object.assign(got, x.info))
  assert.equal(res.info[p].probed, false, 'stale: same path, newer modified time')
  await until(() => got[p])
  assert.equal(b.fake.execs.length, 1)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a file ffprobe cannot read shows as failed, is not retried this run, and is retried next launch', async () => {
  const dir = tmp()
  const cacheFile = path.join(dir, 'lib.json')
  const files = many(2)
  const bad = Object.keys(files)[0]
  const a = rig(files, { cacheFile, failOn: (f) => f === bad })
  const got = {}
  await a.service.request('m', Object.keys(files), (b) => Object.assign(got, b.info))
  await until(() => Object.keys(got).length === 2)
  assert.equal(got[bad].failed, true)
  assert.equal(got[bad].probed, true)
  const again = await a.service.request('m', [bad], () => {})
  assert.equal(again.info[bad].failed, true)
  assert.equal(a.fake.execs.filter((f) => f === bad).length, 1, 'not probed a second time this run')
  a.service.saveSync()
  const b = rig(files, { cacheFile })
  const res = await b.service.request('m', [bad], () => {})
  assert.equal(res.info[bad].probed, false, 'the failure was not saved')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('asking again replaces what was still waiting: scrolling fast leaves no backlog', async () => {
  const files = many(60)
  const { service, fake } = rig(files, { hold: true })
  const paths = Object.keys(files)
  await service.request('movies', paths.slice(0, 30), () => {})
  const started = fake.execs.length
  assert.equal(started, 3, 'three running, the rest queued')
  const second = await service.request('movies', paths.slice(50, 55), () => {})
  assert.equal(second.remaining, 3 + 5, 'the old queue of 27 is gone; 3 still running plus the 5 asked for')
  fake.release()
  await until(() => fake.execs.length >= 8 && fake.running === 0)
  await sleep(30)
  assert.equal(fake.execs.length, 8, 'only the ones running plus the new five were ever read')
  for (const p of paths.slice(50, 55)) assert.ok(fake.execs.includes(p), p)
  assert.ok(!fake.execs.includes(paths[29]), 'a row that scrolled away was never read')
})

test('a stat-only request (Date added) reads no file and does not disturb what is queued', async () => {
  const files = many(30)
  const { service, fake } = rig(files, { hold: true })
  const paths = Object.keys(files)
  await service.request('movies', paths.slice(0, 10), () => {})
  const stat = await service.request('movies', paths, () => {}, { statOnly: true })
  assert.equal(Object.keys(stat.info).length, 30)
  assert.ok(Object.values(stat.info).every((r) => r.birthMs > 0 && r.probed === false))
  assert.equal(stat.remaining, 10, 'the earlier queue of 10 is still there (3 running, 7 waiting)')
  fake.release()
  await until(() => fake.execs.length === 10 && fake.running === 0)
  await sleep(30)
  assert.equal(fake.execs.length, 10, 'only the ten asked for with a real request were ever read')
})

test('two screens share the probe slots fairly', async () => {
  const movies = many(30, 'D:\\Movies\\m')
  const tv = many(30, 'D:\\TV\\t')
  const { service, fake } = rig({ ...movies, ...tv }, { hold: true, concurrency: 2 })
  await service.request('movies', Object.keys(movies), () => {})
  await service.request('tv', Object.keys(tv), () => {})
  fake.release()
  await until(() => fake.execs.length >= 8)
  const firstEight = fake.execs.slice(0, 8)
  assert.ok(firstEight.some((f) => f.includes('\\TV\\')), 'the second screen is not starved by the first')
  service.cancel('movies')
  service.cancel('tv')
})

test('a path that has gone is reported gone and dropped from the cache', async () => {
  const dir = tmp()
  const cacheFile = path.join(dir, 'lib.json')
  const p = 'D:\\Movies\\y.mkv'
  const a = rig({ [p]: { size: 5, mtimeMs: 1e12 } }, { cacheFile })
  const got = {}
  await a.service.request('m', [p], (b) => Object.assign(got, b.info))
  await until(() => got[p])
  a.fake.files.delete(p)
  const res = await a.service.request('m', [p], () => {})
  assert.deepEqual(res.info[p], { gone: true })
  fs.rmSync(dir, { recursive: true, force: true })
})

test('with no ffprobe installed nothing is spawned, the screen is told, and rows fail quietly', async () => {
  const files = many(3)
  const { service, fake } = rig(files, { exe: null })
  const got = {}
  const res = await service.request('m', Object.keys(files), (b) => Object.assign(got, b.info))
  assert.equal(res.probeAvailable, false)
  await until(() => Object.keys(got).length === 3)
  assert.equal(fake.execs.length, 0)
  assert.ok(Object.values(got).every((r) => r.failed && r.probed))
})

test('the same path twice, blank paths and non-strings are ignored', async () => {
  const files = many(2)
  const { service } = rig(files)
  const p = Object.keys(files)[0]
  const res = await service.request('m', [p, p, '', null, 42, undefined], () => {})
  assert.deepEqual(Object.keys(res.info), [p])
  service.cancel('m')
})

test('a saved cache is loaded at start', async () => {
  const dir = tmp()
  const cacheFile = path.join(dir, 'big.json')
  fs.writeFileSync(cacheFile, JSON.stringify({ v: info.CACHE_VERSION, entries: { 'a|1|1': { width: 1 } } }))
  const { service } = rig({}, { cacheFile })
  await service.request('m', [], () => {})
  assert.equal(service.status().cached, 1)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a cache written before HDR10+ / Dolby Vision / Atmos were read is ignored (files are read again)', async () => {
  const dir = tmp()
  const cacheFile = path.join(dir, 'old.json')
  fs.writeFileSync(cacheFile, JSON.stringify({ v: 1, entries: { 'a|1|1': { width: 1 } } }))
  const { service } = rig({}, { cacheFile })
  await service.request('m', [], () => {})
  assert.equal(service.status().cached, 0)
  fs.rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------- the IPC layer

function fakeIpc() {
  const handlers = new Map()
  return { handle: (name, fn) => handlers.set(name, fn), call: (name, ...args) => handlers.get(name)(...args) }
}
const fakeStore = () => { const m = new Map(); return { get: (k) => m.get(k), set: (k, v) => m.set(k, v) } }

test('only files inside the Movies / TV Shows folders may be read', () => {
  const roots = ['D:\\Movies', 'D:\\TV Shows']
  const ok = (p) => ipc.pathAllowed(roots, p)
  assert.ok(ok(path.join('D:\\Movies', 'a.mkv')))
  assert.ok(ok(path.join('D:\\TV Shows', 'Show', 'S1', 'e.mkv')))
  assert.ok(!ok(path.join('D:\\Movies2', 'a.mkv')), 'a sibling folder that merely starts with the same letters')
  assert.ok(!ok(path.join('D:\\Movies', '..', 'Secrets', 'a.txt')), 'a path that climbs out')
  assert.ok(!ok('C:\\Windows\\system32\\config\\SAM'))
  assert.ok(!ok('D:\\Movies'), 'the folder itself is not a file')
  assert.ok(!ok(''))
  assert.ok(!ok(undefined))
  if (process.platform === 'win32') assert.ok(ok('d:\\movies\\A.MKV'), 'Windows paths ignore case')
})

test('the info channel drops paths outside the library before reading anything', async () => {
  const seen = []
  const ipcMain = fakeIpc()
  const reg = ipc.register({ ipcMain, store: fakeStore(), ffprobePath: () => null, getLibraryRoots: () => [os.tmpdir()], cacheFile: null })
  const real = path.join(os.tmpdir(), 'beebo-libinfo-none.mkv')
  const sender = { id: 7, isDestroyed: () => false, send: (ch, payload) => seen.push([ch, payload]) }
  const res = await ipcMain.call('libraryTable:info', { sender }, 'movies', [real, 'C:\\Windows\\win.ini', '\\\\server\\share\\x.mkv'])
  assert.deepEqual(Object.keys(res.info), [real], 'only the path inside the roots is looked at')
  assert.deepEqual(res.info[real], { gone: true })
  reg.service.cancel('7:movies')
})

test('saved choices: per screen, cleaned, merged field by field, and reset with null', () => {
  const ipcMain = fakeIpc()
  const store = fakeStore()
  ipc.register({ ipcMain, store, ffprobePath: () => null, getLibraryRoots: () => [], cacheFile: null })
  const get = () => ipcMain.call('libraryTable:getPrefs')
  assert.deepEqual(get().movies, { mode: 'posters', columns: null, widths: {}, sort: null }, 'the default is the poster grid')
  ipcMain.call('libraryTable:setPrefs', {}, 'movies', { mode: 'table' })
  assert.equal(get().movies.mode, 'table')
  assert.equal(get().tv.mode, 'posters', 'the other screen is untouched')
  ipcMain.call('libraryTable:setPrefs', {}, 'movies', { columns: ['title', 'size', 'title', 'bad id!', 5], sort: { id: 'size', dir: 'desc' } })
  const m = get().movies
  assert.equal(m.mode, 'table', 'a later change keeps the earlier one')
  assert.deepEqual(m.columns, ['title', 'size'])
  assert.deepEqual(m.sort, { id: 'size', dir: 'desc' })
  ipcMain.call('libraryTable:setPrefs', {}, 'movies', { widths: { title: 5000, size: 10, junk: 'x', 'a b': 3 } })
  assert.deepEqual(get().movies.widths, { title: 900, size: 48 }, 'widths are clamped, junk is dropped')
  ipcMain.call('libraryTable:setPrefs', {}, 'movies', { columns: null })
  assert.equal(get().movies.columns, null, 'null goes back to the default columns')
  ipcMain.call('libraryTable:setPrefs', {}, 'movies', { mode: 'evil' })
  assert.equal(get().movies.mode, 'posters')
  const before = JSON.stringify(store.get('libraryTablePrefs'))
  ipcMain.call('libraryTable:setPrefs', {}, '__proto__', { mode: 'table' })
  ipcMain.call('libraryTable:setPrefs', {}, 'photos', { mode: 'table' })
  ipcMain.call('libraryTable:setPrefs', {}, 'movies', null)
  assert.equal(JSON.stringify(store.get('libraryTablePrefs')), before, 'unknown screens and bad input write nothing')
})

// ---- the owner's own marks (Watched / Watchlist columns)

test("the owner's watched marks and watchlist come back, and a person with viewing privacy on gets nothing", () => {
  const watchedState = require('../electron/watchedState')
  const auth = require('../electron/auth')
  const viewingPrivacy = require('../electron/viewingPrivacy')
  const mk = (over = {}) => {
    const state = { authUsers: [{ id: 'kid', username: 'kid', status: 'approved' }, { id: 'me', username: 'me', isAdmin: true, status: 'approved', ...over }] }
    return { get: (k) => state[k], set: (k, v) => { state[k] = v }, delete: (k) => { delete state[k] } }
  }
  const enc = (n) => Buffer.from(n, 'utf8').toString('base64url')
  const store = mk()
  watchedState.setWatched(store, 'me', [{ kind: 'movie', fileName: 'Alien (1979).mkv' }, { kind: 'tv', fileName: 'Show One\\Season 1\\S1E1.mkv' }], true)
  watchedState.setWatched(store, 'kid', [{ kind: 'movie', fileName: 'Kid Movie.mkv' }], true)
  store.set('watchlist', {
    me: [{ id: enc('Heat (1995).mkv'), kind: 'movie' }, { id: enc('x'), kind: 'tv', showKey: 'x' }],
    kid: [{ id: enc('Kid Movie.mkv'), kind: 'movie' }]
  })
  const r = ipc.ownersMarks({ store, auth, watchedState, viewingPrivacy })
  assert.equal(r.ok, true)
  assert.deepEqual(r.watchedMovies, ['Alien (1979).mkv'], "only the owner's marks, not the kid's")
  assert.deepEqual(r.watchedEpisodes, ['Show One\\Season 1\\S1E1.mkv'])
  assert.deepEqual(r.watchlistMovies, ['Heat (1995).mkv'])

  const priv = mk({ viewingHistoryPrivate: true })
  watchedState.setWatched(priv, 'me', [{ kind: 'movie', fileName: 'Secret.mkv' }], true)
  const hidden = ipc.ownersMarks({ store: priv, auth, watchedState, viewingPrivacy })
  assert.deepEqual(hidden, { ok: false, private: true }, 'nothing about a private viewer leaves the main process')
  assert.ok(!JSON.stringify(hidden).includes('Secret'))

  const nobody = { get: (k) => (k === 'authUsers' ? [{ id: 'u', username: 'u', status: 'approved' }] : undefined), set() {}, delete() {} }
  assert.deepEqual(ipc.ownersMarks({ store: nobody, auth, watchedState, viewingPrivacy }), { ok: false }, 'no admin, no marks')
})

test('the marks channel answers { ok: false } when it was not given the pieces to read them', async () => {
  const ipcMain = fakeIpc()
  ipc.register({ ipcMain, store: fakeStore(), ffprobePath: () => null, getLibraryRoots: () => [], cacheFile: null })
  assert.deepEqual(await ipcMain.call('libraryTable:marks'), { ok: false })
})

// ---------------------------------------------------------------- real ffprobe (when the machine has one)

const hasFf = ['ffprobe', 'ffmpeg'].every((b) => { try { return spawnSync(b, ['-version']).status === 0 } catch { return false } })

test('against a real ffprobe: a generated 1920x800 file reads back as such', { skip: !hasFf && 'ffmpeg/ffprobe not installed' }, async () => {
  const dir = tmp()
  const file = path.join(dir, 'scope.mkv')
  const made = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=1920x800:rate=24:duration=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'ac3', '-ac', '6', '-metadata:s:a:0', 'language=eng', file])
  assert.equal(made.status, 0, String(made.stderr))
  const service = info.createLibraryInfo({ ffprobePath: 'ffprobe', cacheFile: null, flushMs: 10 })
  const got = {}
  await service.request('t', [file], (b) => Object.assign(got, b.info))
  await until(() => got[file], 10000)
  const r = got[file]
  assert.equal(r.failed, undefined, JSON.stringify(r))
  assert.equal(r.width, 1920)
  assert.equal(r.height, 800)
  assert.equal(r.videoCodec, 'h264')
  assert.equal(r.hdr, 'SDR')
  assert.equal(r.fps, 24)
  assert.ok(r.durationSec > 0.9 && r.durationSec < 1.2)
  assert.deepEqual(r.audioLangs, ['English'])
  assert.equal(r.audio[0].codec, 'ac3')
  assert.equal(r.audio[0].channels, 6)
  assert.ok(r.birthMs > 0)
  fs.rmSync(dir, { recursive: true, force: true })
})
