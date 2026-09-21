#!/usr/bin/env node
'use strict'
// Server benchmark for docs/PERFORMANCE.md. One real stream server over a synthetic library
// (test/perf/gen-synthetic-library.js), a REAL conf/electron-store settings file (so every
// store.get re-reads and re-parses config.json exactly like the packaged app), and real HTTP.
//
//   node test/perf/bench-server.js --lib <dir made by the generator> [--config typical|heavy]
//        [--reps 5] [--samples 30] [--only movies,tv,music,photos] [--idle-seconds 20] [--json out.json]
//
// The parent process runs the child (--child) `--reps` times and prints the median of each number,
// so a number is "median of 5 fresh processes". Every child starts cold (new process, new temp
// settings folder) but the OS file cache is warm after the first run: the first rep is reported
// separately as "cold" (first rep of the library after the generator wrote it is mostly cached
// too; a truly cold disk needs a reboot, which is not attempted).
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')

const APP = path.join(__dirname, '..', '..')

function argv() {
  const o = {}
  const a = process.argv.slice(2)
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith('--')) continue
    const k = a[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    if (a[i + 1] === undefined || a[i + 1].startsWith('--')) o[k] = true
    else o[k] = a[++i]
  }
  return o
}

const median = (xs) => { const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null }
const pct = (xs, p) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] : null }
const round = (x, d = 2) => (typeof x === 'number' ? Math.round(x * 10 ** d) / 10 ** d : x)

// ---- seeded settings (a realistic config.json) ------------------------------------------------
function seedConfig(kind, lib) {
  const users = ['owner', 'member', 'kid'].map((id, i) => ({ id, name: id, username: id, status: 'approved', isAdmin: i === 0, adult: i < 2, passwordHash: 'x'.repeat(96) }))
  const now = Date.now()
  const rows = (n) => Array.from({ length: n }, (_, i) => ({ userId: users[i % 3].id, kind: i % 4 ? 'movie' : 'tv', name: `History Title ${i} (2001).mp4`, title: `History Title ${i}`, currentTime: 1200 + i, duration: 6000, percent: 0.2, at: now - i * 3600 * 1000, sessionId: 's' + i }))
  const base = {
    authUsers: users, watchHistory: rows(300), recentlyAdded: rows(23).map((r) => ({ path: 'x', at: r.at })),
    uploadHistory: rows(23), conversions: rows(11), emailLog: rows(13), failedLoginLog: rows(22), watchedState: {},
    playlists: {}, customSearchSites: [], streamPort: 0, welcomeSampleSeeded: true, storageDefaultsVersion: 1,
    relayPricingCache: { plans: Array.from({ length: 12 }, (_, i) => ({ id: 'p' + i, name: 'Plan ' + i, price: i * 100, blurb: 'x'.repeat(200) })) }
  }
  // "typical" = the size of a real owner's config.json (~200 KB); "heavy" = a 1,300-show library's review queue on top (~1 MB).
  base.titleReviewQueue = Object.fromEntries(Array.from({ length: kind === 'heavy' ? 2400 : 220 }, (_, i) => ['review-' + i, { name: 'Some Show Name ' + i + ' S01E01.mp4', candidates: Array.from({ length: 3 }, (_, k) => ({ id: i * 10 + k, title: 'Candidate ' + k, year: 1990 + k, overview: 'y'.repeat(120) })), at: now }]))
  return base
}

// ---- http helper -----------------------------------------------------------------------------
function makeClient(port, gzip) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 4 })
  return function get(pathname, headers = {}) {
    return new Promise((resolve, reject) => {
      const t0 = process.hrtime.bigint()
      const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET', agent, headers: { 'Accept-Encoding': gzip ? 'gzip' : 'identity', ...headers } }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const wire = Buffer.concat(chunks)
          const ms = Number(process.hrtime.bigint() - t0) / 1e6
          // Sizes are what crossed the wire; the body handed back is always the plain JSON.
          const body = res.headers['content-encoding'] === 'gzip' ? require('node:zlib').gunzipSync(wire) : wire
          resolve({ status: res.statusCode, ms, bytes: wire.length, headers: res.headers, body })
        })
      })
      req.on('error', reject)
      req.end()
    })
  }
}

// ---- the child: one server, all measurements ---------------------------------------------------
async function child(opts) {
  const lib = path.resolve(opts.lib)
  const only = new Set(String(opts.only || 'movies,tv,music,photos').split(','))
  const samples = Number(opts.samples || 30)
  const out = { pid: process.pid }
  const tStart = process.hrtime.bigint()
  const since = () => Number(process.hrtime.bigint() - tStart) / 1e6

  const userData = opts.userdata ? path.resolve(opts.userdata) : fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-bench-ud-'))
  fs.mkdirSync(userData, { recursive: true })
  const reuse = !!opts.userdata && fs.existsSync(path.join(userData, 'config.json'))
  const Conf = require('conf')
  class Store extends Conf { constructor() { super({ cwd: userData, configName: 'config', fileExtension: 'json' }) } }
  const { openStore } = require('../../electron/configStore')
  const opened = openStore({ Store, userDataDir: userData })
  const store = opened.store
  const seed = seedConfig(opts.config || 'typical', lib)
  const dirs = { movies: path.join(lib, 'Movies'), tv: path.join(lib, 'TV Shows'), music: path.join(lib, 'Music'), photos: path.join(lib, 'Photos'), tmdb: path.join(lib, 'tmdb') }
  Object.assign(seed, { moviesDir: dirs.movies, tvShowsDir: dirs.tv, musicDir: dirs.music, photosDirs: [dirs.photos], tmdbCacheDir: dirs.tmdb })
  if (!reuse) for (const [k, v] of Object.entries(seed)) store.set(k, v)
  // secretSettings around the store exactly like main.js (fake OS encryption: reversible base64).
  const fakeSafe = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(String(s)).reverse(), decryptString: (b) => Buffer.from(b).reverse().toString() }
  const { createSecretSettings, APP_SECRET_KEYS } = require('../../electron/secretSettings')
  createSecretSettings({ store, safeStorage: fakeSafe, keys: APP_SECRET_KEYS, log: () => {} }).install()
  const config = { bytes: fs.statSync(path.join(userData, 'config.json')).size, kind: opts.config || 'typical' }

  // Count and time every store.get made by the server, keyed by the request being served.
  const counters = { current: null, byRoute: new Map(), setsByRoute: new Map(), total: 0, totalMs: 0 }
  const realGet = store.get
  store.get = function countingGet(...args) {
    const t0 = process.hrtime.bigint()
    try { return realGet.apply(this, args) } finally {
      const dt = Number(process.hrtime.bigint() - t0) / 1e6
      counters.total++; counters.totalMs += dt
      if (counters.current) { const r = counters.byRoute.get(counters.current) || { calls: 0, ms: 0 }; r.calls++; r.ms += dt; counters.byRoute.set(counters.current, r) }
    }
  }

  const realSet = store.set
  counters.sets = 0; counters.setMs = 0
  store.set = function countingSet(...args) {
    const t0 = process.hrtime.bigint()
    try { return realSet.apply(this, args) } finally { counters.sets++; counters.setMs += Number(process.hrtime.bigint() - t0) / 1e6; if (counters.current) { const r = counters.setsByRoute.get(counters.current) || 0; counters.setsByRoute.set(counters.current, r + 1) } }
  }

  const t0req = since()
  const server = require('../../electron/streamServer')
  const auth = require('../../electron/auth')
  out.requireMs = round(since() - t0req)
  const crypto = require('node:crypto')
  const agentSecret = crypto.randomBytes(32).toString('hex')
  const port = 46000 + (process.pid % 3000)
  const tBoot = since()
  const info = server.startStreamServer({
    port, store, agentSecret, log: () => {},
    getMoviesDir: () => dirs.movies, getTvShowsDir: () => dirs.tv,
    getAllMoviesDirs: () => [dirs.movies], getAllTvShowsDirs: () => [dirs.tv],
    getTmdbCacheDir: () => dirs.tmdb, getAllMusicDirs: () => [dirs.music], getMusicCacheDir: () => dirs.tmdb
  })
  const get = makeClient(info.port, !!opts.gzip)
  for (let i = 0; i < 200; i++) { try { await get('/api/ping'); break } catch { await new Promise((r) => setTimeout(r, 10)) } }
  out.bootToListeningMs = round(since() - tBoot)
  out.requireToListeningMs = round(since() - t0req)
  const bearer = { Authorization: 'Bearer ' + server.makeApiToken(store, 'owner') }
  const cookie = { Cookie: 'beebo_session=' + auth.signSession(store, 'owner') }
  const route = async (label, p, headers = bearer) => { counters.current = label; try { return await get(p, headers) } finally { counters.current = null } }

  out.config = config
  out.routes = {}
  const sample = async (label, p, n = samples, headers = bearer) => {
    const first = await route(label, p, headers)
    const ms = []
    for (let i = 0; i < n; i++) ms.push((await route(label, p, headers)).ms)
    const calls = counters.byRoute.get(label) || { calls: 0, ms: 0 }
    out.routes[label] = { status: first.status, bytes: first.bytes, firstMs: round(first.ms), p50: round(pct(ms, 0.5)), p95: round(pct(ms, 0.95)), max: round(Math.max(...ms)), storeGetsPerRequest: round(calls.calls / (n + 1), 1), storeGetMsPerRequest: round(calls.ms / (n + 1)), storeSetsPerRequest: round((counters.setsByRoute.get(label) || 0) / (n + 1), 1) }
    return first
  }

  const first = await sample('GET /api/ping', '/api/ping', 30, {})
  out.pingP50 = out.routes['GET /api/ping'].p50
  let movies
  if (only.has('movies')) {
    movies = await sample('GET /api/movies', '/api/movies')
    await sample('GET /api/movies?sort=year', '/api/movies?sort=year', 10)
    await sample('GET /api/movies?q=the', '/api/movies?q=the', 10)
    await sample('GET /api/recently-added', '/api/recently-added', 10)
    await sample('GET /api/continue', '/api/continue', 10)
    await sample('GET /api/recommended', '/api/recommended', 10)
    await sample('GET /api/library-status', '/api/library-status', 10)
    try {
      const m = JSON.parse(movies.body.toString('utf8')).items[3]
      if (m) { await sample('GET /watch?id= (movie player page)', '/watch?id=' + encodeURIComponent(m.id), 20, cookie) }
    } catch { /* leave it out */ }
  }
  let shows
  if (only.has('tv')) {
    shows = await sample('GET /api/tvshows', '/api/tvshows')
    try {
      const s = JSON.parse(shows.body.toString('utf8'))
      const list = s.items || s.shows || []
      const big = list[Math.min(5, list.length - 1)]
      if (big) {
        const rr = await sample('GET /api/tvshows/<id>/episodes', '/api/tvshows/' + encodeURIComponent(big.id) + '/episodes', 15)
        out.routes['GET /api/tvshows'].shows = list.length
        void rr
      }
    } catch { /* leave it out */ }
  }
  if (only.has('music')) {
    const t = process.hrtime.bigint()
    const admin = { ...bearer, 'X-Beebo-Agent-Key': agentSecret }
    await new Promise((resolve, reject) => {
      const rq = http.request({ host: '127.0.0.1', port: info.port, path: '/api/music/rescan', method: 'POST', headers: admin }, (r) => { r.resume(); r.on('end', resolve) })
      rq.on('error', reject); rq.end()
    })
    for (let i = 0; i < 4000; i++) {
      const r = JSON.parse((await route('GET /api/music/status', '/api/music/status')).body.toString('utf8'))
      if (r && r.scanning === false && r.trackCount > 0) { out.musicTracks = r.trackCount; break }
      await new Promise((rr) => setTimeout(rr, 500))
    }
    out.musicScanToReadyMs = round(Number(process.hrtime.bigint() - t) / 1e6)
    await sample('GET /api/music/tracks?limit=200', '/api/music/tracks?limit=200', 10)
    await sample('GET /api/music/tracks (all)', '/api/music/tracks', 3)
    await sample('GET /api/music/albums', '/api/music/albums', 10)
    await sample('GET /api/music/artists', '/api/music/artists', 10)
    await sample('GET /api/music/search?q=neon', '/api/music/search?q=neon', 10)
  }
  if (only.has('photos')) {
    const t = process.hrtime.bigint()
    const f = await route('GET /api/photos/timeline (first)', '/api/photos/timeline?limit=200')
    out.photosFirstTimelineMs = round(Number(process.hrtime.bigint() - t) / 1e6)
    out.photosFirstTimelineBytes = f.bytes
    await sample('GET /api/photos/timeline?limit=200', '/api/photos/timeline?limit=200', 10)
    await sample('GET /api/photos/timeline?limit=200&tokens=1', '/api/photos/timeline?limit=200&tokens=1', 10)
  }

  // Memory and idle CPU after everything has been touched.
  if (global.gc) global.gc()
  const mem = process.memoryUsage()
  out.memory = { rssMB: round(mem.rss / 1048576, 1), heapUsedMB: round(mem.heapUsed / 1048576, 1), externalMB: round(mem.external / 1048576, 1) }
  const idleMs = Number(opts.idleSeconds || 15) * 1000
  // Let anything the last requests started in the background (a library re-walk on the worker) finish first, so the
  // idle window measures a server nobody is talking to.
  await new Promise((r) => setTimeout(r, Number(opts.settleSeconds || 10) * 1000))
  const c0 = process.cpuUsage()
  const w0 = process.hrtime.bigint()
  const { monitorEventLoopDelay } = require('node:perf_hooks')
  const h = monitorEventLoopDelay({ resolution: 10 }); h.enable()
  await new Promise((r) => setTimeout(r, idleMs))
  h.disable()
  const cu = process.cpuUsage(c0)
  const wall = Number(process.hrtime.bigint() - w0) / 1e6
  out.idle = { seconds: idleMs / 1000, cpuPercentOfOneCore: round(((cu.user + cu.system) / 1000 / wall) * 100), eventLoopP99Ms: round(h.percentile(99) / 1e6) }
  out.storeGets = { total: counters.total, totalMs: round(counters.totalMs), perCallMs: round(counters.totalMs / Math.max(1, counters.total), 4) }
  out.storeSets = { total: counters.sets, totalMs: round(counters.setMs), perCallMs: round(counters.setMs / Math.max(1, counters.sets), 4) }
  await new Promise((r) => info.close(r))
  if (!opts.userdata) { try { fs.rmSync(userData, { recursive: true, force: true }) } catch { /* temp */ } }
  process.stdout.write('\n@@RESULT@@' + JSON.stringify(out) + '\n')
  setTimeout(() => process.exit(0), 50).unref()
}

// ---- the parent ---------------------------------------------------------------------------------
function runChild(opts) {
  return new Promise((resolve, reject) => {
    const args = ['--expose-gc', ...(opts.nodeArgs ? String(opts.nodeArgs).split(' ') : []), __filename, '--child', ...Object.entries(opts).filter(([k]) => !['child', 'reps', 'json', 'nodeArgs'].includes(k)).flatMap(([k, v]) => ['--' + k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()), String(v)])]
    const p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let so = ''; let se = ''
    p.stdout.on('data', (d) => { so += d })
    p.stderr.on('data', (d) => { se += d })
    p.on('close', (code) => {
      const m = /@@RESULT@@(.*)/.exec(so)
      if (!m) return reject(new Error('child failed (' + code + '): ' + (se || so).slice(-800)))
      resolve(JSON.parse(m[1]))
    })
  })
}

function merge(results) {
  // Median of every numeric leaf.
  const walk = (vals) => {
    const v0 = vals.find((v) => v !== undefined && v !== null)
    if (typeof v0 === 'number') return round(median(vals.filter((v) => typeof v === 'number')))
    if (v0 && typeof v0 === 'object' && !Array.isArray(v0)) {
      const keys = new Set(vals.flatMap((v) => (v && typeof v === 'object' ? Object.keys(v) : [])))
      return Object.fromEntries([...keys].map((k) => [k, walk(vals.map((v) => (v && typeof v === 'object' ? v[k] : undefined)))]))
    }
    return v0
  }
  return walk(results)
}

async function main() {
  const o = argv()
  if (o.child) return child(o)
  if (!o.lib) { console.error('usage: node bench-server.js --lib DIR [--config typical|heavy] [--reps 5] [--only movies,tv,music,photos] [--json out.json]'); process.exit(2) }
  const reps = Number(o.reps || 5)
  const results = []
  for (let i = 0; i < reps; i++) {
    const r = await runChild(o)
    results.push(r)
    console.error(`rep ${i + 1}/${reps}: boot ${r.bootToListeningMs} ms, require ${r.requireMs} ms, rss ${r.memory.rssMB} MB`)
  }
  const merged = merge(results)
  merged.reps = reps
  merged.machine = { cpu: os.cpus()[0].model, cores: os.cpus().length, totalMemGB: round(os.totalmem() / 2 ** 30, 1), loadavg: os.loadavg(), platform: process.platform + ' ' + os.release(), node: process.version }
  merged.first = results[0]
  const text = JSON.stringify(merged, null, 2)
  if (o.json) fs.writeFileSync(o.json, text)
  console.log(text)
}

main().catch((e) => { console.error(e); process.exit(1) })
