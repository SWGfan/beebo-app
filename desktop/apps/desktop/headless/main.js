'use strict'
// Beebo media server without the desktop window: `node headless/main.js`.
// It runs the same electron/main.js as the desktop app, with an `electron`
// stand-in (headless/electronShim.js) and the folder/port settings taken from
// the environment or a JSON file instead of the Settings screen.
const fs = require('fs')
const os = require('os')
const path = require('path')

const appDir = path.join(__dirname, '..')

function exitWith(code, message) {
  process.stderr.write(message + '\n')
  process.exit(code)
}

function findOnPath(name, env = process.env, platform = process.platform) {
  const exts = platform === 'win32' ? ['.exe', '.cmd', ''] : ['']
  for (const dir of String(env.PATH || env.Path || '').split(path.delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext)
      try {
        if (fs.statSync(candidate).isFile()) return candidate
      } catch { /* not in this folder */ }
    }
  }
  return ''
}

function resolveFfmpegEnv(env = process.env) {
  const found = {}
  for (const name of ['ffmpeg', 'ffprobe']) {
    const key = 'BEEBO_' + name.toUpperCase()
    if (env[key] && fs.existsSync(env[key])) {
      found[name] = env[key]
      continue
    }
    const exe = process.platform === 'win32' ? name + '.exe' : name
    const bundled = path.join(appDir, 'resources', 'ffmpeg', exe)
    const located = fs.existsSync(bundled) ? bundled : findOnPath(name, env)
    if (located) {
      env[key] = located
      found[name] = located
    }
  }
  return found
}

function lanUrls(port, scheme = 'http') {
  const urls = []
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal && !String(a.address).startsWith('169.254.')) urls.push(`${scheme}://${a.address}:${port}`)
    }
  }
  urls.push(`${scheme}://localhost:${port}`)
  return urls
}

function seedStore(store, cfg) {
  const first = (list, fallbackName) => list[0] || path.join(cfg.dataDir, 'library', fallbackName)
  const values = {
    moviesDir: first(cfg.moviesDirs, 'movies'),
    extraMoviesDirs: cfg.moviesDirs.slice(1),
    tvShowsDir: first(cfg.tvDirs, 'tv'),
    extraTvShowsDirs: cfg.tvDirs.slice(1),
    musicDir: first(cfg.musicDirs, 'music'),
    extraMusicDirs: cfg.musicDirs.slice(1),
    audiobooksDir: first(cfg.audiobooksDirs, 'audiobooks'),
    extraAudiobooksDirs: cfg.audiobooksDirs.slice(1),
    photosDirs: cfg.photosDirs.length ? cfg.photosDirs : [path.join(cfg.dataDir, 'library', 'photos')],
    inboxDir: cfg.inboxDir,
    spaceSaverDir: cfg.phoneBackupDir,
    privateVaultDir: cfg.privateDir,
    tmdbCacheDir: cfg.artworkDir,
    certDir: cfg.certDir,
    streamPort: cfg.port,
    storageDefaultsVersion: 1
  }
  for (const [key, value] of Object.entries(values)) store.set(key, value)
  if (!cfg.seedSample && !store.get('welcomeSampleSeeded')) store.set('welcomeSampleSeeded', true)
}

function ensureDirs(cfg, log) {
  for (const dir of [cfg.dataDir, cfg.inboxDir, cfg.phoneBackupDir, cfg.privateDir, cfg.artworkDir]) {
    try { fs.mkdirSync(dir, { recursive: true, mode: dir === cfg.dataDir ? 0o700 : 0o755 }) } catch (err) { log(`[headless] cannot create ${dir}: ${err.code || err.message}`) }
  }
  for (const dir of [cfg.moviesDirs[0], cfg.tvDirs[0]]) {
    if (dir) try { fs.mkdirSync(dir, { recursive: true }) } catch { /* reported below if it is still missing */ }
  }
  for (const dir of [...cfg.moviesDirs, ...cfg.tvDirs, ...cfg.musicDirs, ...cfg.audiobooksDirs, ...cfg.photosDirs]) {
    let ok = false
    try { ok = fs.statSync(dir).isDirectory() } catch { ok = false }
    if (!ok) log(`[headless] media folder ${dir} does not exist or is not a folder; nothing will be found there until it is mounted`)
  }
  try {
    fs.accessSync(cfg.dataDir, fs.constants.W_OK)
  } catch {
    exitWith(78, `[headless] the data folder ${cfg.dataDir} is not writable by this user (uid ${typeof process.getuid === 'function' ? process.getuid() : 'n/a'}). Fix the folder's owner or run the container with the matching user (see docker/README.md).`)
  }
}

async function boot(env = process.env) {
  const { loadConfig, ConfigError } = require('./config')
  const { installConsoleRedaction } = require('./logRedact')
  const secretBox = require('./secretBox')

  let cfg
  try {
    cfg = loadConfig(env)
  } catch (err) {
    if (err instanceof ConfigError) exitWith(78, '[headless] ' + err.message)
    throw err
  }

  installConsoleRedaction({ timestamps: cfg.logTimestamps })
  const log = (msg) => console.log(msg)
  const pkg = require('../package.json')
  ensureDirs(cfg, log)

  let master
  let safeStorage
  try {
    master = secretBox.resolveMasterKey({ env, dataDir: cfg.dataDir })
    safeStorage = secretBox.createSafeStorage(master.key)
    secretBox.verifyKeyMatchesData(cfg.dataDir, safeStorage)
  } catch (err) {
    if (err instanceof secretBox.SecretKeyError) exitWith(78, '[headless] ' + err.message)
    throw err
  }
  if (master.plaintext) {
    console.warn('[headless] WARNING: BEEBO_ALLOW_PLAINTEXT_SECRETS is set. Passwords, API keys and sign-in secrets are stored UNENCRYPTED in ' + path.join(cfg.dataDir, 'config.json'))
  } else {
    log(`[headless] secrets are encrypted at rest (key from ${master.source})`)
  }

  const ff = resolveFfmpegEnv(env)
  log(`[headless] ffmpeg: ${ff.ffmpeg || 'NOT FOUND (set BEEBO_FFMPEG or put ffmpeg on PATH; transcoding is disabled)'}`)
  log(`[headless] ffprobe: ${ff.ffprobe || 'NOT FOUND (set BEEBO_FFPROBE; media details and quality badges are limited)'}`)

  if (cfg.transcodeDir) {
    try { fs.mkdirSync(cfg.transcodeDir, { recursive: true }) } catch (err) { log(`[headless] cannot create ${cfg.transcodeDir}: ${err.code || err.message}`) }
    env.TMPDIR = cfg.transcodeDir
    env.TEMP = cfg.transcodeDir
    env.TMP = cfg.transcodeDir
  }
  if (!process.resourcesPath) process.resourcesPath = path.join(appDir, 'resources')
  env.BEEBO_BIND_ADDRESS = cfg.bind

  const { createElectronShim } = require('./electronShim')
  const { createShutdown } = require('./shutdown')
  const { installOverrides } = require('./installOverrides')
  const { createSetupFlow } = require('./setupFlow')

  const state = { streamInfo: null, store: null }
  let shutdown = null
  const shim = createElectronShim({
    dataDir: cfg.dataDir,
    appDir,
    version: pkg.version,
    safeStorage,
    log,
    onQuit: (code) => shutdown.finish(code),
    env
  })
  shutdown = createShutdown({
    requestQuit: () => shim.app.quit(),
    closeServer: (done) => {
      if (state.streamInfo && typeof state.streamInfo.close === 'function') state.streamInfo.close(done)
      else done()
    },
    exit: (code) => process.exit(code),
    log: (m) => log('[headless] ' + m),
    hardTimeoutMs: 8000
  })
  installOverrides({ shim, appDir, upnp: cfg.upnp })

  const Store = require('electron-store')
  seedStore(new Store(), cfg)

  if (cfg.selfSignedTls) {
    try {
      await require('./selfSigned').ensureSelfSignedCertificate({ certDir: cfg.certDir, log: (m) => log('[headless] ' + m) })
    } catch (err) {
      console.warn('[headless] could not create a self-signed HTTPS certificate; the web admin needs HTTPS and will not open:', err.message)
    }
  }

  const streamServer = require('../electron/streamServer')
  const auth = require('../electron/auth')
  const realStart = streamServer.startStreamServer
  streamServer.startStreamServer = function headlessStartStreamServer(deps) {
    const flow = createSetupFlow({ store: deps.store, auth, getUrls: () => lanUrls(cfg.port, fs.existsSync(path.join(cfg.certDir, 'cert.pem')) ? 'https' : 'http') })
    streamServer.addPreRequestHook(flow.hook)
    if (cfg.tmdbApiKey && deps.store.get('tmdbApiKey') !== cfg.tmdbApiKey) deps.store.set('tmdbApiKey', cfg.tmdbApiKey)
    let announced = false
    const wrapped = Object.assign({}, deps, {
      log: (msg) => {
        deps.log(msg)
        if (!announced && /listening on/.test(String(msg))) {
          announced = true
          log(`[headless] Beebo server ${pkg.version} is up on ${cfg.bind}:${cfg.port}`)
          flow.announce()
        }
      }
    })
    state.store = deps.store
    state.streamInfo = realStart(wrapped)
    return state.streamInfo
  }

  process.on('uncaughtException', (err) => console.error('[headless] uncaught exception:', (err && err.stack) || err))
  process.on('unhandledRejection', (err) => console.error('[headless] unhandled rejection:', (err && err.stack) || err))
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGBREAK']) {
    try { process.on(signal, () => shutdown.trigger(signal)) } catch { /* signal not available on this platform */ }
  }

  log(`[headless] Beebo Entertainment ${pkg.version} headless server starting (data ${cfg.dataDir})`)
  require('../electron/main.js')
  return { config: cfg, shim, shutdown, state }
}

if (require.main === module) boot().catch((err) => exitWith(1, '[headless] failed to start: ' + ((err && err.stack) || err)))

module.exports = { boot, findOnPath, resolveFfmpegEnv, seedStore, lanUrls }
