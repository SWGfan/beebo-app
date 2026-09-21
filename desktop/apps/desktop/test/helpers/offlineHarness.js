'use strict'
// Harness for the offline-first tests: a real Beebo server (headless/main.js, which runs the same
// electron/main.js as the desktop app) started with every public network address blocked
// (test/helpers/offlineGuard.js), a fixture library with cached metadata, and a small HTTP client that
// times every request.
//
//   const h = await startOfflineHarness(t, { mode: 'unreachable' })
//   await h.setupOwner()                       // first run, local account, no cloud sign-in
//   const r = await h.get('/api/movies')       // { status, ms, text, json, headers }
//   h.publicAttempts()                         // every try to leave the home network, as the guard saw it
//
// Run the whole thing on your own machine with:
//   node --test test/offline-e2e.test.js       (see docs/OFFLINE-FIRST.md)
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const https = require('node:https')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

const APP_DIR = path.join(__dirname, '..', '..')
const GUARD = path.join(__dirname, 'offlineGuard.js')
const SECRET_KEY = 'c'.repeat(64)

// ---- ffmpeg (optional: without it the playback checks that need a real clip are skipped) --------
function findTool(name) {
  const exe = process.platform === 'win32' ? name + '.exe' : name
  const candidates = []
  if (process.env['BEEBO_' + name.toUpperCase()]) candidates.push(process.env['BEEBO_' + name.toUpperCase()])
  candidates.push(path.join(APP_DIR, 'resources', 'ffmpeg', exe))
  // A worktree has no resources/ffmpeg of its own; its node_modules (NODE_PATH) come from the main checkout.
  for (const p of String(process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean)) candidates.push(path.join(p, '..', 'resources', 'ffmpeg', exe))
  for (const c of candidates) { try { if (fs.statSync(c).isFile()) return c } catch { /* next */ } }
  const r = spawnSync(name, ['-version'], { windowsHide: true })
  return r.status === 0 ? name : null
}
const FFMPEG = findTool('ffmpeg')
const FFPROBE = findTool('ffprobe')

// The bundled ffmpeg is an LGPL build (libopenh264, no libx264) and a developer's own may be a full build:
// use whichever H.264 encoder this one has, and fall back to MPEG-4 video, which every ffmpeg has.
let videoEncoder = null
function pickVideoEncoder() {
  if (videoEncoder) return videoEncoder
  const r = FFMPEG ? spawnSync(FFMPEG, ['-hide_banner', '-encoders'], { windowsHide: true, encoding: 'utf8' }) : null
  const list = r && r.stdout ? r.stdout : ''
  videoEncoder = ['libx264', 'libopenh264'].find((e) => list.includes(' ' + e + ' ')) || 'mpeg4'
  return videoEncoder
}

function makeClip(file, { seconds = 3, video = true } = {}) {
  if (!FFMPEG) return false
  const args = ['-v', 'error', '-y']
  if (video) args.push('-f', 'lavfi', '-i', `testsrc=size=320x240:rate=24:duration=${seconds}`)
  args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`)
  if (video) args.push('-c:v', pickVideoEncoder(), '-pix_fmt', 'yuv420p', '-g', '24', '-c:a', 'aac', '-shortest')
  else if (/\.mp3$/i.test(file)) args.push('-c:a', 'libmp3lame')
  else args.push('-c:a', 'aac')
  args.push(file)
  const r = spawnSync(FFMPEG, args, { windowsHide: true })
  return r.status === 0 && fs.existsSync(file)
}

// A 1x1 JPEG: enough for "the poster is served from disk".
const TINY_JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64')

// ---- the fixture library ---------------------------------------------------------------------------
function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-offline-'))
  const dir = (...p) => { const d = path.join(root, ...p); fs.mkdirSync(d, { recursive: true }); return d }
  const f = {
    root,
    dataDir: dir('config'),
    moviesDir: dir('Movies'),
    tvDir: dir('TV Shows'),
    musicDir: dir('Music'),
    audiobooksDir: dir('Audiobooks'),
    cacheDir: dir('tmdb-cache'),
    hasFfmpeg: !!FFMPEG
  }
  const movie = path.join(f.moviesDir, 'Tiny Test Movie (2020).mp4')
  const gotMovie = makeClip(movie)
  if (!gotMovie) fs.writeFileSync(movie, Buffer.alloc(4096, 1))
  fs.writeFileSync(path.join(f.moviesDir, 'Tiny Test Movie (2020).en.srt'), '1\n00:00:00,000 --> 00:00:02,000\nHello from the sidecar file\n\n')
  fs.writeFileSync(path.join(f.moviesDir, 'Missing Poster Movie (2019).mp4'), gotMovie ? fs.readFileSync(movie) : Buffer.alloc(4096, 2))
  // Never looked up (added while the internet was down): with a TMDB key set the server will try, and must not wait for it.
  fs.writeFileSync(path.join(f.moviesDir, 'Brand New Film (2024).mp4'), gotMovie ? fs.readFileSync(movie) : Buffer.alloc(4096, 6))

  const showDir = dir('TV Shows', 'Test Show', 'Season 1')
  const ep = path.join(showDir, 'Test Show S01E01.mp4')
  if (gotMovie) fs.copyFileSync(movie, ep); else fs.writeFileSync(ep, Buffer.alloc(4096, 3))

  const albumDir = dir('Music', 'Test Artist', 'Test Album')
  const song = path.join(albumDir, '01 - Test Song.mp3')
  if (!makeClip(song, { video: false })) fs.writeFileSync(song, Buffer.alloc(4096, 4))

  const bookDir = dir('Audiobooks', 'Test Author', 'Test Book')
  const book = path.join(bookDir, 'Test Book.mp3')
  if (!makeClip(book, { video: false })) fs.writeFileSync(book, Buffer.alloc(4096, 5))

  // The metadata cache the desktop app builds while online ("Download all TMDB info for offline use").
  fs.mkdirSync(path.join(f.cacheDir, 'posters'), { recursive: true })
  fs.mkdirSync(path.join(f.cacheDir, 'actors'), { recursive: true })
  fs.mkdirSync(path.join(f.cacheDir, 'posters-tv'), { recursive: true })
  fs.writeFileSync(path.join(f.cacheDir, 'posters', '900001.jpg'), TINY_JPEG)
  fs.writeFileSync(path.join(f.cacheDir, 'actors', '800001.jpg'), TINY_JPEG)
  fs.writeFileSync(path.join(f.cacheDir, 'posters-tv', '900002.jpg'), TINY_JPEG)
  fs.writeFileSync(path.join(f.cacheDir, 'manifest.json'), JSON.stringify({
    'Tiny Test Movie (2020).mp4': { id: 900001, title: 'Tiny Test Movie', release_date: '2020-05-01', poster_path: '/tinytest.jpg', backdrop_path: '/tinybackdrop.jpg', genre_ids: [35], overview: 'A movie that plays with the internet unplugged.', vote_average: 7.5 },
    // Cached but the poster file never made it to disk: the page must not point the viewer at image.tmdb.org.
    'Missing Poster Movie (2019).mp4': { id: 900003, title: 'Home Video With Missing Poster', release_date: '2019-01-01', poster_path: '/missing.jpg', genre_ids: [99], overview: 'Metadata is cached; the picture is not.' }
  }))
  fs.writeFileSync(path.join(f.cacheDir, 'credits.json'), JSON.stringify({
    900001: [{ id: 800001, name: 'Cached Actor', character: 'Hero', profile_path: '/actor.jpg', order: 0 }]
  }))
  fs.writeFileSync(path.join(f.cacheDir, 'tv-manifest.json'), JSON.stringify({
    'test show': { id: 900002, name: 'Test Show', first_air_date: '2021-01-01', poster_path: '/tvposter.jpg', genre_ids: [18], overview: 'A show that plays offline.' }
  }))
  return f
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
    s.on('error', reject)
  })
}

// ---- HTTP client that measures ---------------------------------------------------------------------
function makeClient(port, jar) {
  function request(method, p, { body, headers = {}, raw = false, timeoutMs = 20000, secure = false } = {}) {
    const started = Date.now()
    return new Promise((resolve, reject) => {
      const data = body === undefined ? null : (typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
      const h = Object.assign({}, headers)
      if (jar.cookie) h.Cookie = jar.cookie
      if (jar.token && !h.Authorization) h.Authorization = 'Bearer ' + jar.token
      if (data !== null) { h['Content-Length'] = Buffer.byteLength(data); if (!h['Content-Type']) h['Content-Type'] = typeof body === 'string' ? 'application/x-www-form-urlencoded' : 'application/json' }
      // Plain http is what a phone on the home Wi-Fi uses (by the computer's address); the admin screens are https only.
      const lib = secure ? https : http
      const req = lib.request({ host: '127.0.0.1', port, method, path: p, headers: h, ...(secure ? { rejectUnauthorized: false } : {}) }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const buf = Buffer.concat(chunks)
          const setCookie = res.headers['set-cookie']
          if (setCookie) jar.cookie = setCookie.map((c) => c.split(';')[0]).join('; ')
          const text = raw ? '' : buf.toString('utf8')
          let json = null
          if (!raw && /json/.test(String(res.headers['content-type']))) { try { json = JSON.parse(text) } catch { /* not json */ } }
          resolve({ status: res.statusCode, ms: Date.now() - started, headers: res.headers, text, json, buf })
        })
      })
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`request to ${p} did not answer within ${timeoutMs} ms`)))
      req.on('error', reject)
      if (data !== null) req.write(data)
      req.end()
    })
  }
  return {
    get: (p, o) => request('GET', p, o),
    post: (p, body, o) => request('POST', p, Object.assign({ body }, o)),
    request
  }
}

// ---- the server -----------------------------------------------------------------------------------
async function startOfflineHarness(t, { mode = 'unreachable', upnp = true, fixture, extraEnv = {}, seedConfig = null } = {}) {
  const fx = fixture || createFixture()
  // Settings the server finds in its config file on first read, e.g. a signed-in household's licence token
  // (secret values written in plain text are encrypted by the server as it starts, as for a real install).
  // Software video encoding: a graphics-card encoder (Intel Quick Sync) is shared with everything else on the
  // machine, which makes a first video segment take anywhere from 0.3 s to minutes on a busy PC. Not an internet matter.
  fs.writeFileSync(path.join(fx.dataDir, 'config.json'), JSON.stringify(Object.assign({ transcodeEncoder: 'software' }, seedConfig || {})))
  const port = await freePort()
  const logFile = path.join(fx.root, 'outbound-attempts.jsonl')
  fs.writeFileSync(logFile, '')
  const env = {}
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('BEEBO_') && k !== 'TMDB_API_KEY' && k !== 'NODE_OPTIONS') env[k] = v
  const preload = `--require ${JSON.stringify(GUARD.replace(/\\/g, '/'))}`
  Object.assign(env, {
    BEEBO_DATA_DIR: fx.dataDir,
    BEEBO_MOVIES_DIRS: fx.moviesDir,
    BEEBO_TV_DIRS: fx.tvDir,
    BEEBO_MUSIC_DIRS: fx.musicDir,
    BEEBO_AUDIOBOOKS_DIRS: fx.audiobooksDir,
    BEEBO_ARTWORK_DIR: fx.cacheDir,
    BEEBO_PORT: String(port),
    BEEBO_UPNP: upnp ? '1' : '0', // the real router-asking code runs; only the WAN side is gone
    BEEBO_SECRET_KEY: SECRET_KEY,
    BEEBO_SELF_SIGNED_TLS: '1', // the admin screens need https; the library routes are also reachable over plain http, as on a home LAN
    BEEBO_SEED_SAMPLE: '0',
    BEEBO_OFFLINE: '1',
    BEEBO_OFFLINE_MODE: mode,
    BEEBO_OFFLINE_LOG: logFile,
    // Inherited by every child process (the remote-host agent, ffmpeg helpers), so none can slip past.
    NODE_OPTIONS: preload
  }, extraEnv)
  const ff = FFMPEG && FFMPEG !== 'ffmpeg' ? { BEEBO_FFMPEG: FFMPEG, BEEBO_FFPROBE: FFPROBE || '' } : {}
  Object.assign(env, ff)
  const child = spawn(process.execPath, [path.join(APP_DIR, 'headless', 'main.js')], { cwd: APP_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { out += d })
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
  const waitFor = (re, ms = 60000) => new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      const m = re.exec(out)
      if (m) return resolve(m)
      if (Date.now() - started > ms) return reject(new Error(`timed out waiting for ${re}; output so far:\n${out}`))
      setTimeout(tick, 100)
    }
    tick()
  })
  const stop = async () => {
    try { child.kill('SIGKILL') } catch { /* gone */ }
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))])
    try { fs.rmSync(fx.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) } catch { /* temp folder, best effort */ }
  }
  if (t && typeof t.after === 'function') t.after(stop)

  const jar = {}
  const client = makeClient(port, jar)
  const startedAt = Date.now()
  const h = Object.assign({ port, fixture: fx, mode, jar, child, output: () => out, waitFor, exited, stop, startedAt }, client)

  const logLines = () => fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  h.attempts = () => logLines().filter((l) => l.kind !== 'hung' && l.kind !== 'released')
  // Calls that vanished into the black hole (blackhole mode) and that no timeout or abort has ended yet.
  // Anything still here after the app has had time to give up is a request that would wait forever.
  h.outstanding = () => {
    const open = new Map()
    for (const l of logLines()) {
      if (l.kind === 'hung') open.set(l.ref, l)
      else if (l.kind === 'released') open.delete(l.ref)
    }
    // A name lookup that never answers is only ever waited on by code with its own timer; the fetches and
    // sockets built on top of it are what must end, and those are listed here.
    return [...open.values()].filter((l) => !/^dns\./.test(l.of || ''))
  }
  // The most calls to one public host that were waiting at the same moment (blackhole mode). Node answers
  // file reads, sign-ins and DNS on four shared threads, so a pile of them is what freezes a local page.
  h.peakConcurrentHung = () => {
    const live = new Map(); let peak = 0; const per = new Map()
    for (const l of logLines()) {
      const host = String(l.target || '').replace(/:\d+$/, '')
      if (l.kind === 'hung' && /^dns\./.test(l.of || '')) continue // a lookup nobody ever answers has no end to measure
      if (l.kind === 'hung') { live.set(l.ref, host); per.set(host, (per.get(host) || 0) + 1); peak = Math.max(peak, per.get(host)) }
      else if (l.kind === 'released' && live.has(l.ref)) { per.set(host, per.get(host) - 1); live.delete(l.ref) }
    }
    return peak
  }
  // Everything the process tried to send to the public internet, one row per distinct host and kind.
  h.publicAttempts = () => {
    const seen = new Map()
    for (const a of h.attempts()) {
      const key = a.kind.replace(/^dns\.(promises\.)?/, 'dns.') + ' ' + a.target.replace(/:\d+$/, '')
      const prev = seen.get(key)
      if (!prev) seen.set(key, Object.assign({ count: 1 }, a)); else prev.count++
    }
    return [...seen.values()]
  }

  // The first look at what this computer's video encoders can do runs real ffmpeg (up to 20 s on a busy PC).
  // It has nothing to do with the internet, so the playback checks wait for it instead of blaming the network.
  h.waitForEncoderCheck = () => waitFor(/encoder check:/, 180000).catch(() => null)

  await waitFor(/Setup code: ([2-9A-Z]{4}-[2-9A-Z]{4}-[2-9A-Z]{4})/)
  h.setupCode = () => /Setup code: ([2-9A-Z]{4}-[2-9A-Z]{4}-[2-9A-Z]{4})/.exec(out)[1]
  h.setupOwner = async (username = 'owner', password = 'correct horse battery') => {
    const created = await h.post('/api/headless/setup', { code: h.setupCode(), username, password }, { secure: true })
    if (created.status !== 200) throw new Error('setup failed: ' + created.status + ' ' + created.text)
    const login = await h.post('/api/login', { username, password }, { secure: true })
    if (login.status !== 200) throw new Error('login failed: ' + login.status + ' ' + login.text)
    jar.token = login.json.token
    // Also a browser-style cookie session, for the website pages.
    const form = await h.post('/login', `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`, { headers: { Authorization: 'Bearer ' + jar.token } })
    return { token: jar.token, user: login.json.user, formStatus: form.status }
  }
  return h
}

module.exports = { startOfflineHarness, createFixture, makeClip, findTool, FFMPEG, FFPROBE, APP_DIR, GUARD, TINY_JPEG }
