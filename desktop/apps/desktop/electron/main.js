const { app, BrowserWindow, ipcMain: rawIpcMain, shell, dialog, Tray, Menu, nativeImage, safeStorage, Notification, clipboard, session: electronSession } = require('electron')
// First, before anything else can fail: the rolling log (userData/logs/main.log) and the crash
// handlers, so a failure while loading the rest of this file is recorded and explained.
const reliability = require('./reliability').early({ app, dialog, clipboard, shell })
const {
  checkForDesktopUpdate,
  fetchUpdateStatus,
  lastUpdateStatus,
  bindPrefStore,
  readAutoUpdatePref,
  writeAutoUpdatePref,
  registerUpdateIpc,
  isBusy: updaterIsBusy,
  handleStartup: handleUpdateStartup
} = require('./desktopUpdater')
const path = require('path')
const titleParse = require('./titleParse')
// Everything that happens AFTER the filename is parsed: which TMDB result a
// file actually is, how sure we are, and the owner's own confirmed answers.
// Shared verbatim with streamServer.js so the desktop and the website can no
// longer disagree about what a file matched.
const titleMatch = require('./titleMatch')
const castCredits = require('./castCredits')
const fs = require('fs')
const os = require('os')
const { spawn, execFile } = require('child_process')
const Store = require('electron-store')
// ---- Electron hardening (electron/mainSecurity.js; security review section 3) ----
// One policy for "which page is the app's own". Every ipcMain handler (here and in the modules
// that are handed `ipcMain`) refuses a message that does not come from the top frame of that page;
// every window denies window.open / navigation away from its own origin / <webview>, and the
// session denies every permission the app does not use.
const mainSecurity = require('./mainSecurity')
const appPolicy = mainSecurity.createPolicy({
  distIndex: path.join(__dirname, '..', 'dist', 'index.html'),
  devUrl: process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173',
  getIsPackaged: () => app.isPackaged,
  getLocalOrigin: () => 'http://127.0.0.1:' + ((typeof streamServerInfo !== 'undefined' && streamServerInfo && streamServerInfo.port) || 47811)
})
let deniedIpcLogged = 0
const ipcMain = mainSecurity.wrapIpcMain(rawIpcMain, (event) => appPolicy.isTrustedSender(event), (channel) => {
  if (deniedIpcLogged++ < 20) console.warn('[security] refused an IPC message on "' + String(channel).slice(0, 60) + '" from a page that is not the Beebo window')
})
app.on('web-contents-created', (_event, contents) => {
  let hasPreload = false
  try { hasPreload = !!(contents.getLastWebPreferences && contents.getLastWebPreferences().preload) } catch (e) { hasPreload = false }
  mainSecurity.guardWebContents(contents, { kind: hasPreload ? 'app' : 'local', policy: appPolicy, shell, log: (m) => console.warn('[security] ' + m) })
  contents.on('console-message', (_e, _level, message) => {
    const line = mainSecurity.cspViolationLine(message)
    if (line) console.warn('[security] ' + line)
  })
})
const {
  startStreamServer,
  PORT: STREAM_PORT,
  // The website's /surprise channel-surfing engine, reused verbatim by the
  // desktop's 🎲 tab (see the surf:* IPC handlers near the bottom of this file).
  surfCandidates,
  surfTitle,
  // The mixed-pool + year/decade half of the same engine: surfKindOf answers
  // "is THIS pooled item a movie or an episode?" (the only sane question once
  // kind='both' exists), surfFilterPool applies genre+year/decade in the one
  // canonical order, and surfYearSummary is what /api/surf/years is built out
  // of. Imported rather than reimplemented so the desktop can never drift.
  surfKindOf,
  surfFilterPool,
  surfYearSummary,
  normalizeYearParam,
  normalizeDecadeParam,
  seededShuffle,
  normalizeSeed,
  freshSeed,
  makeMediaToken,
  countGenres,
  GENRE_NAMES_MOVIE,
  GENRE_NAMES_TV
} = require('./streamServer')
// Music: the library (shared by the stream server and Settings) and its folder settings.
const musicIpc = require('./musicIpc')
const musicLibraryModule = require('./musicLibrary')
const musicTranscodeModule = require('./musicTranscode')
// Background work (intro scan, conversions, music rescans, sweeps) waits while someone is watching, on battery
// or with the CPU full (backgroundGate.js). Only the desktop app knows about power; the stream server supplies
// who is watching.
const backgroundGate = require('./backgroundGate')
backgroundGate.configure({
  battery: () => { try { return require('electron').powerMonitor.isOnBatteryPower() === true } catch (e) { return false } }
})
const musicLib = musicLibraryModule.createMusicLibrary({
  getDirs: () => musicIpc.getAllMusicDirs(store),
  getCacheDir: () => musicIpc.getMusicCacheDir(store, app),
  log: (msg) => console.log('[music]', msg),
  shouldDefer: () => backgroundGate.shouldDefer(),
  ffprobePath: musicTranscodeModule.resolveFf('ffprobe'),
  ffmpegPath: musicTranscodeModule.resolveFf('ffmpeg')
})
// Audiobooks: the library (shared by the stream server and Settings) and its folder settings.
const audiobooksIpc = require('./audiobooksIpc')
const audiobookLibraryModule = require('./audiobookLibrary')
const audiobookLib = audiobookLibraryModule.createAudiobookLibrary({
  getDirs: () => audiobooksIpc.getAllAudiobookDirs(store),
  getCacheDir: () => musicIpc.getMusicCacheDir(store, app),
  log: (msg) => console.log('[audiobooks]', msg),
  ffprobePath: musicTranscodeModule.resolveFf('ffprobe'),
  ffmpegPath: musicTranscodeModule.resolveFf('ffmpeg'),
  // A finished scan quietly looks up anything new when (and only when) the owner turned the Open Library lookup on.
  onScanned: () => { try { if (streamServerInfo && streamServerInfo.audiobookLookup) streamServerInfo.audiobookLookup.kick() } catch (e) {} }
})
const { splitTvMatchGenres } = require('./genres')
const auth = require('./auth')
const history = require('./history')
const viewingPrivacy = require('./viewingPrivacy')
const desktopSettingsPolicy = require('./desktopSettingsPolicy')
const uiPrefs = require('./uiPrefs')
const mailer = require('./mailer')
const titleRequests = require('./titleRequests')
const tmdbCache = require('./tmdbCache')
const videoQuality = require('./videoQuality')
const movieVersions = require('./movieVersions')
const movieVersionsDesktop = require('./movieVersionsDesktop')
const backup = require('./backup')
const convert = require('./convert')
const metadataMerge = require('./metadataMerge')
const metadataOverrides = require('./metadataOverrides')
const metadataLocale = require('./metadataLocale')
const artworkPicker = require('./artworkPicker')
const catalog = require('./catalog')
const { createGameHost } = require('./gameHostIpc')
const { createGameJoin } = require('./gameJoinIpc')

// A damaged config.json is set aside and the newest daily copy restored instead of the app
// failing to open (configStore.js).
const store = reliability.openStore(Store)
const storageDefaults = require('./storageDefaults')
storageDefaults.initialize(store)
// The TMDB key, the email app password, the optional Cloudflare analytics token,
// the session / media-token / upload-id / API-token secrets, the licence token
// and the access codes in authUsers are encrypted at rest with the OS
// (safeStorage), like the relay secret. Every store.get of them still works.
const { APP_SECRET_KEYS } = require('./secretSettings')
const secretSettings = require('./secretSettings').createSecretSettings({
  store, safeStorage, keys: APP_SECRET_KEYS,
  log: (m) => { try { console.log(m) } catch (e) {} }
}).install()
// Licensing (feature-flagged; disabled until licenseConfig enables it in the store).
const { createLicense } = require('./license')
const { createRemoteHost } = require('./remoteHostAgent')
const { createHomeAddress } = require('./homeAddress')
const { createPortMapper } = require('./portMapper')
const license = createLicense({ store, config: Object.assign({
  // Enforcement is ON only in the packaged installer customers download; the
  // owner's own dev server (npm run dev, app.isPackaged=false) stays unrestricted.
  enabled: app.isPackaged,
  publicKey: '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAq9BmDwiIr7GmE29BirIyGGw9ghJ/Du1bPH0/vnFEQKo=\n-----END PUBLIC KEY-----\n',
  // Beebo's own server. No fallback address is listed in the public source (an official
  // build can add one through the licenseConfig store setting).
  backendUrl: 'https://login.beebo.tv',
  fallbackUrls: [],
}, store.get('licenseConfig') || {}) })
let streamServerInfo = null

const VIDEO_EXTS = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.m4v', '.webm']

function defaultDir(key, fallback) {
  return store.get(key) || fallback
}

// Default library folders carry the Beebo name now. The old MovieAPP paths are
// still honoured when they actually exist on disk, so an install that predates
// the rename keeps finding its own files instead of quietly pointing at an
// empty folder. Nothing is moved or renamed on the user's disk.
function brandedDefault(preferred, legacy) {
  try { if (!fs.existsSync(preferred) && fs.existsSync(legacy)) return legacy } catch (e) {}
  return preferred
}

// The port the media server listens on, and the port the OUTSIDE world uses to
// reach it. They are normally the same. Two reasons to separate them: some
// providers block particular ports inbound, and some households already have a
// forward set up on a number they'd rather keep. Both default to 47811, so an
// install that never touches Settings behaves exactly as it always has - which
// matters, because changing this changes the address every paired phone uses.
function getStreamPort() {
  const v = Number(store.get('streamPort'))
  return (Number.isInteger(v) && v >= 1024 && v <= 65535) ? v : STREAM_PORT
}

function getExternalPort() {
  const v = Number(store.get('externalPort'))
  return (Number.isInteger(v) && v >= 1 && v <= 65535) ? v : getStreamPort()
}

// The UDP ports the away-from-home host agent answers WebRTC on, one per viewer
// at a time, and that the router is asked to forward. Store key 'rtcUdpPorts'
// ("47820-47829", or "0" for the old random ports). Must match the agent's
// parsePortRange: 1024-65535, at most 200 ports.
const DEFAULT_RTC_UDP_PORTS = '47820-47829'
function getRtcUdpRange() {
  const raw = String(store.get('rtcUdpPorts') || DEFAULT_RTC_UDP_PORTS).trim()
  if (raw === '0' || /^(off|random)$/i.test(raw)) return null
  const m = /^(\d{1,5})(?:\s*-\s*(\d{1,5}))?$/.exec(raw)
  const min = m ? Number(m[1]) : 0
  const max = m ? Number(m[2] || m[1]) : 0
  if (!m || min < 1024 || max > 65535 || max < min || max - min > 199) return { min: 47820, max: 47829, text: DEFAULT_RTC_UDP_PORTS }
  return { min, max, text: min === max ? String(min) : min + '-' + max }
}

function getMoviesDir() {
  return defaultDir('moviesDir', process.env.MOVIES_DIR || brandedDefault('C:\\Beebo\\Movies', 'C:\\MovieAPP\\Movies'))
}

function getViewerAppDir() {
  return store.get('viewerAppDir') || ''
}

function getTmdbCacheDir() {
  return store.get('tmdbCacheDir') || ''
}

function getTvShowsDir() {
  return defaultDir('tvShowsDir', process.env.TVSHOWS_DIR || brandedDefault('D:\\Beebo\\TVShows', 'D:\\MovieAPP\\TVShows'))
}

// (The old "New files drop folder", getNewFilesDir, is now the Beebo Inbox:
// see getInboxDir and inbox.migrateLegacyDropFolder.)

// Additional Movies/TV Shows folders — e.g. a second hard drive added once the
// primary one filled up. Uploads always land in the single primary folder
// above; these only widen what gets scanned/served, not where new files go.
function getExtraMoviesDirs() {
  return store.get('extraMoviesDirs') || []
}

function getExtraTvShowsDirs() {
  return store.get('extraTvShowsDirs') || []
}

function getAllMoviesDirs() {
  return [getMoviesDir(), ...getExtraMoviesDirs()].filter(Boolean)
}

// First run: drop a small bundled "Welcome to Beebo" sample clip into the movies
// folder so a brand-new user has something to press Play on right away (confirms
// streaming works before they've added their own library). Runs once; the user
// can delete it any time.
function seedWelcomeSample() {
  try {
    if (store.get('welcomeSampleSeeded')) return
    const dir = getMoviesDir()
    try { fs.mkdirSync(dir, { recursive: true }) } catch (e) {}
    const dest = path.join(dir, 'Welcome to Beebo (sample).mp4')
    if (fs.existsSync(dest)) { store.set('welcomeSampleSeeded', true); return }
    const candidates = [
      path.join(process.resourcesPath || '', 'welcome-to-beebo.mp4'),
      path.join(__dirname, '..', 'resources', 'welcome-to-beebo.mp4')
    ]
    const src = candidates.find((p) => { try { return fs.existsSync(p) } catch (e) { return false } })
    if (!src) return
    fs.copyFileSync(src, dest)
    store.set('welcomeSampleSeeded', true)
  } catch (e) {}
}

function getAllTvShowsDirs() {
  return [getTvShowsDir(), ...getExtraTvShowsDirs()].filter(Boolean)
}

// =======================================================================
// HTTPS (see electron/certs.js and the multiplexer in streamServer.js)
// =======================================================================
//
// Everything here is best-effort by design. If any of it fails — no token
// file, no domain, Let's Encrypt down, no internet — the stream server keeps
// serving over plain HTTP exactly as it always has. Nothing below is allowed
// to block window creation or throw into the app.

// Loaded defensively: certs.js lazily requires acme-client, but if the file
// itself is missing from a build we still want the app to start.
let certs = null
try {
  certs = require('./certs')
} catch (err) {
  console.log('[certs] certificate module unavailable:', err.message)
}

// Where cert.pem / key.pem / account.key live. Kept in userData (not next to
// the code) so an app update can never wipe them and so a private key isn't
// sitting in Program Files.
function getCertDir() {
  const configured = store.get('certDir')
  if (configured) return configured
  try {
    return path.join(app.getPath('userData'), 'certs')
  } catch {
    // app.getPath throws before 'ready'; fall back to next to the app files
    return path.join(__dirname, '..', 'certs')
  }
}

// Candidate locations for the DuckDNS updater's token file, in the order the
// task description gives them. The token is deliberately NOT committed (it's
// in .gitignore), so this is a search rather than a constant.
function duckdnsFileCandidates(fileName) {
  const out = []
  const push = (p) => {
    if (p && !out.includes(p)) out.push(p)
  }
  push(path.join(__dirname, '..', 'tools', fileName)) // apps/desktop/tools/
  push(path.join(__dirname, '..', '..', '..', 'tools', fileName)) // <repo>/tools/
  try {
    if (process.resourcesPath) push(path.join(process.resourcesPath, 'tools', fileName))
  } catch {}
  try {
    push(path.join(path.dirname(app.getPath('exe')), 'tools', fileName))
  } catch {}
  return out
}

function readDuckdnsToken() {
  const fromStore = (store.get('duckdnsToken') || '').trim()
  if (fromStore) return fromStore
  for (const candidate of duckdnsFileCandidates('duckdns-token.txt')) {
    try {
      const text = fs.readFileSync(candidate, 'utf8').trim()
      if (text) return text.split(/\r?\n/)[0].trim()
    } catch {
      // not there / not readable — try the next one
    }
  }
  return ''
}

// The domain is a setting, but it defaults to whatever duckdns-update.bat is
// already configured to keep updated — the owner has typed it once, and it
// would be silly to make them type it again (or to hardcode it here).
function detectDuckdnsDomain() {
  for (const candidate of duckdnsFileCandidates('duckdns-update.bat')) {
    try {
      const text = fs.readFileSync(candidate, 'utf8')
      const m = /domains=([A-Za-z0-9-]+)/.exec(text)
      if (m) return `${m[1].toLowerCase()}.duckdns.org`
    } catch {
      // next candidate
    }
  }
  return ''
}

// Which address the certificate is for: the one typed in Settings, else a
// DuckDNS updater found on this PC (the older setup, kept until the owner
// switches), else this PC's own <name>.home.beebo.tv once beebo.tv has
// confirmed it (homeAddress.js). Waiting for that confirmation means a PC whose
// Worker can't publish home addresses yet never asks Let's Encrypt for a
// certificate that could not validate.
function getCertDomain() {
  const configured = (store.get('certDomain') || '').trim()
  if (configured) return certs ? certs.normalizeDomain(configured) : configured
  const detected = detectDuckdnsDomain()
  if (detected) return detected
  try {
    const home = homeAddress ? homeAddress.status() : null
    if (home && home.goodHostname) return home.goodHostname
  } catch {}
  return ''
}
function getLicenceTokenSafe() {
  try { return license.getToken() || '' } catch { return '' }
}

// The last background/manual attempt, kept only so the Settings panel can say
// "Last attempt failed: …" instead of an unexplained "Not set up".
function recordCertAttempt(result) {
  try {
    store.set('certLastAttempt', {
      at: new Date().toISOString(),
      ok: !!(result && result.ok),
      reason: (result && result.reason) || ''
    })
  } catch {
    // a store write failing is not worth taking anything down for
  }
}

let certRunInFlight = null

// The one entry point for "go and make sure we have a certificate". Called on
// a timer after startup, once a day after that, and by the Settings button.
// Resolves to { ok, reason } and never rejects.
async function runCertificateCheck({ force = false, manual = false } = {}) {
  if (certRunInFlight) return certRunInFlight
  certRunInFlight = (async () => {
    try {
      if (!certs) return { ok: false, reason: 'certificate module unavailable' }
      const domain = getCertDomain()
      const token = readDuckdnsToken()
      const result = await certs.ensureCertificate({
        domain,
        token,
        // *.home.beebo.tv: the Worker sets the TXT record for this licence's name.
        licenceToken: getLicenceTokenSafe(),
        certDir: getCertDir(),
        force,
        staging: !!store.get('certStaging'),
        log: (msg) => console.log('[certs]', msg)
      })
      recordCertAttempt(result)
      if (result.ok && streamServerInfo && typeof streamServerInfo.applyCertificate === 'function') {
        // Hot-swaps into the already-listening server; the port never drops.
        const applied = streamServerInfo.applyCertificate(result)
        if (!applied.ok) {
          recordCertAttempt(applied)
          return applied
        }
      }
      return result
    } catch (err) {
      // ensureCertificate promises never to throw, but this is the layer that
      // must be true regardless of what any dependency does.
      const failure = { ok: false, reason: `certificate check failed: ${err.message}` }
      recordCertAttempt(failure)
      console.log('[certs]', failure.reason)
      return failure
    } finally {
      certRunInFlight = null
    }
  })()
  return certRunInFlight
}

// Kicked off well after the window is up, then repeated daily. A 90-day
// certificate renewed at 30 days out gets ~30 daily attempts before anything
// could possibly break, which is why nothing here needs to retry harder.
function scheduleCertificateWork() {
  const first = setTimeout(() => {
    runCertificateCheck().catch(() => {})
  }, 20000)
  if (first.unref) first.unref()
  const daily = setInterval(() => {
    runCertificateCheck().catch(() => {})
  }, 24 * 60 * 60 * 1000)
  if (daily.unref) daily.unref()
}

// Every video file under the given folders (name, fileName, relPath, path, ext, size, mtimeMs),
// walked on the catalog worker thread instead of here. This process also runs the stream
// server, and a walk done inline paused every video being watched.
async function scanVideoDirsOffThread(dirs) {
  const files = await catalog.sharedCatalogWalker({ log: (m) => console.log('[catalog]', m) }).scanVideoFilesMulti(dirs)
  return files.map((f) => ({
    name: f.name,
    fileName: f.fileName,
    relPath: f.relPath,
    path: path.join(f.dir, f.relPath),
    ext: path.extname(f.fileName).toLowerCase(),
    size: f.size,
    mtimeMs: f.mtimeMs
  }))
}

// --- Remote access (watch away from home) -----------------------------------
// The account's public subdomain name: a stored override, else a slug of the
// signed-in account email (e.g. sam@x.com -> "nick"). Empty when signed out.
function slugifyRemoteName(x) {
  return String(x || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '').slice(0, 30)
}
function getRemoteName() {
  try {
    const override = store.get('remoteName')
    if (override) return slugifyRemoteName(override)
    const ev = license.evaluate()
    const email = ev && ev.payload && ev.payload.email
    if (email) { const base = slugifyRemoteName(String(email).split('@')[0]); if (base) return base }
  } catch (e) {}
  return ''
}
// The remote host agent registers this Beebo's <name>.beebo.tv and answers
// authorized remote viewers, streaming the local library PEER-TO-PEER so the
// video never passes through Cloudflare. It runs the proven werift host as a
// child process bundled inside the app. No-op when signed out. See
// remoteHostAgent.js.
let remoteHost = null
// Keeps <name>.home.beebo.tv pointed at this house (homeAddress.js).
let homeAddress = null

// Asks the router to open TCP 47811 on its own (NAT-PMP first, then UPnP), so a
// phone away from home can reach this machine DIRECTLY - no port forwarding for
// the user to configure, and no Cloudflare in the video path. Purely additive:
// if the router refuses, everything carries on exactly as before over the
// existing paths. See portMapper.js.
let portMapper = null
// The same, for the host agent's fixed WebRTC UDP range (getRtcUdpRange). When
// it works the agent tells viewers the public side; when it doesn't, Settings
// says which ports to forward by hand.
let rtcPortMapper = null
// Shared, per run, between this process's media server and the host agent it
// spawns: with it the agent vouches for the real away-from-home viewer address,
// so lockouts stop lumping every remote viewer in as 127.0.0.1. Never stored.
const RTC_AGENT_SECRET = require('crypto').randomBytes(32).toString('hex')

// --- The owner's OWN relay (optional; default off) ---
// Beebo offers no relay. An owner may enter one of their own (Cloudflare Realtime
// TURN key, or a TURN server's static auth secret) and pay that provider for what
// it relays. The secret is encrypted at rest with the OS (Electron safeStorage,
// DPAPI on Windows), decrypted only to hand to the host agent over IPC, and never
// sent to Beebo's servers: the agent derives short-lived credentials from it.
// Store key 'rtcRelay': { kind, keyId?, urls?, secretEnc }.
function relayEncryptionAvailable() {
  try { return !!(safeStorage && safeStorage.isEncryptionAvailable()) } catch (e) { return false }
}
function getRelayConfig() {
  try {
    const r = store.get('rtcRelay')
    if (!r || !r.secretEnc || !relayEncryptionAvailable()) return null
    const secret = safeStorage.decryptString(Buffer.from(String(r.secretEnc), 'base64'))
    if (r.kind === 'cloudflare') return { kind: 'cloudflare', keyId: String(r.keyId || ''), apiToken: secret }
    if (r.kind === 'turn') return { kind: 'turn', urls: Array.isArray(r.urls) ? r.urls.map(String) : [], secret }
  } catch (e) { console.warn('[relay] could not read the saved relay settings') }
  return null
}
const RELAY_URL_OK = /^turns?:[A-Za-z0-9.\-[\]:]{3,200}(\?transport=(udp|tcp))?$/i
function relayPublicInfo() {
  const r = store.get('rtcRelay') || {}
  let st = { kind: '', state: 'off', detail: '' }
  try { if (remoteHost && typeof remoteHost.status === 'function') st = remoteHost.status().relay || st } catch (e) {}
  return {
    kind: r.kind === 'cloudflare' || r.kind === 'turn' ? r.kind : 'off',
    keyId: r.kind === 'cloudflare' ? String(r.keyId || '') : '',
    urls: r.kind === 'turn' && Array.isArray(r.urls) ? r.urls : [],
    hasSecret: !!r.secretEnc,
    encryptionAvailable: relayEncryptionAvailable(),
    state: st.state || 'off',
    detail: st.detail || ''
  }
}
function saveRelayConfig(arg) {
  const kind = arg && arg.kind
  if (kind !== 'cloudflare' && kind !== 'turn') {
    store.delete('rtcRelay')
    return { ok: true }
  }
  if (!relayEncryptionAvailable()) return { ok: false, error: 'This computer cannot encrypt the relay secret, so it was not saved.' }
  const prev = store.get('rtcRelay') || {}
  const secretIn = String((arg && (kind === 'cloudflare' ? arg.apiToken : arg.secret)) || '').trim()
  // A blank secret keeps the saved one, if the relay kind is unchanged.
  const secretEnc = secretIn ? safeStorage.encryptString(secretIn).toString('base64') : (prev.kind === kind ? prev.secretEnc : '')
  if (!secretEnc) return { ok: false, error: kind === 'cloudflare' ? 'Enter the API token.' : 'Enter the shared secret.' }
  if (secretIn && (secretIn.length > 1024 || (kind === 'turn' && secretIn.length < 8))) return { ok: false, error: 'That secret does not look right.' }
  if (kind === 'cloudflare') {
    const keyId = String((arg && arg.keyId) || '').trim()
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(keyId)) return { ok: false, error: 'Enter the TURN key ID from your Cloudflare dashboard.' }
    store.set('rtcRelay', { kind, keyId, secretEnc })
  } else {
    const urls = String((arg && arg.urls) || '').split(/[\s,]+/).map((u) => u.trim()).filter(Boolean)
    if (!urls.length || urls.length > 6 || !urls.every((u) => RELAY_URL_OK.test(u))) {
      return { ok: false, error: 'Enter one to six addresses like turn:relay.example.com:3478 or turns:relay.example.com:443?transport=tcp.' }
    }
    store.set('rtcRelay', { kind, urls, secretEnc })
  }
  return { ok: true }
}
function pushRelayToAgent() {
  try { if (remoteHost && typeof remoteHost.setRelay === 'function') remoteHost.setRelay(getRelayConfig()) } catch (e) {}
}
ipcMain.handle('remote:getRelay', () => { try { return relayPublicInfo() } catch (e) { return { kind: 'off', state: 'off' } } })
ipcMain.handle('remote:setRelay', (_e, arg) => {
  try {
    const r = saveRelayConfig(arg)
    if (r.ok) pushRelayToAgent()
    if (r.ok && relayController) { try { relayController.evaluate() } catch (e) {} }
    return Object.assign({}, r, { relay: relayPublicInfo() })
  } catch (e) { return { ok: false, error: 'Could not save the relay settings.' } }
})

// --- Relay modes, usage and the switch to Beebo Relay (relayController.js) ---
// Off / my own relay / my Cloudflare then Beebo Relay / Beebo Relay only; this
// month's relayed GB per provider, estimated cost from relay-pricing.json, and
// the switch notices. Nothing here returns a secret.
let relayController = null
// The Beebo Relay prepaid wallet (walletClient.js): fills relayPolicy's
// beeboRelayAllowed() hook from GET /wallet/me, notifies at 25% / 10% / $0.
let walletClient = null
function relayNotify({ title, body }) {
  try { if (Notification && Notification.isSupported()) new Notification({ title, body }).show() } catch (e) {}
}
function ownRelayKind() {
  const r = store.get('rtcRelay')
  return r && r.secretEnc && (r.kind === 'cloudflare' || r.kind === 'turn') ? { kind: r.kind, keyId: r.kind === 'cloudflare' ? String(r.keyId || '') : '' } : null
}
const relayModelOrOff = () => { try { return relayController ? relayController.getModel() : null } catch (e) { return null } }
ipcMain.handle('remote:getRelayModel', () => relayModelOrOff())
ipcMain.handle('remote:setRelayMode', async (_e, mode) => {
  if (!relayController) return { ok: false, error: 'Not ready yet.' }
  const m = String(mode || '')
  // Cloudflare only (own relay): switch this PC, then turn Beebo Relay off for the
  // account so viewers' devices aren't given Beebo Relay either (connectionTest.js).
  if (m === 'own') {
    const r = await connectionTest.chooseCloudflareOnly()
    try { relayController.evaluate() } catch (e) {}
    return r.ok || r.error === 'signed_out'
      ? { ok: true, model: relayModelOrOff() }
      : { ok: true, warning: 'This computer now uses only your own relay, but Beebo Relay couldn’t be turned off for your account just now. Try again when you’re online.', model: relayModelOrOff() }
  }
  return Object.assign(relayController.setMode(m), { model: relayModelOrOff() })
})
ipcMain.handle('remote:setRelayResetDay', (_e, day) => {
  if (!relayController) return { ok: false, error: 'Not ready yet.' }
  return Object.assign(relayController.setResetDay(day), { model: relayModelOrOff() })
})
ipcMain.handle('wallet:topUp', async (_e, amount) => {
  if (!walletClient) return { ok: false, error: 'Not ready yet.' }
  const r = await walletClient.topUp(amount)
  if (r.ok) { try { const safeUrl = mainSecurity.isSafeExternalUrl(r.url); if (safeUrl) shell.openExternal(safeUrl) } catch (e) {} ; setTimeout(() => { try { walletClient.refresh() } catch (e) {} }, 60000) }
  return { ok: r.ok, error: r.error || '' }
})
ipcMain.handle('wallet:setChoice', async (_e, arg) => {
  if (!walletClient) return { ok: false, error: 'Not ready yet.' }
  const r = await walletClient.setChoice(arg && arg.choice, !!(arg && arg.remember))
  return Object.assign(r, { model: relayModelOrOff() })
})
ipcMain.handle('wallet:refresh', async () => {
  if (!walletClient) return relayModelOrOff()
  try { await walletClient.refresh() } catch (e) {}
  return relayModelOrOff()
})
// --- Connection wizard + Settings > Connection (connectionTest.js) ---
// Watch at home / away from home tests, the owner's choice, and Beebo Relay
// turned on or off for the account (POST /relay/opt-in, /relay/opt-out).
const connectionTest = require('./connectionTest').createConnectionTest({
  store,
  getToken: () => { try { return license.getToken() } catch (e) { return '' } },
  backendUrl: () => license.backendUrl(),
  getOwnAddresses: () => { try { return getNetworkAddresses().map((a) => a.address) } catch (e) { return [] } },
  getRelayController: () => relayController
})
// What the connection wizard and the Connection Doctor both read about away-from-home.
function connectionRemote() {
  let remote = { hostname: '', online: false, problem: '', udp: { enabled: false } }
  try {
    const st = safeRemoteStatus()
    const name = st.registeredName || getRemoteName() || ''
    remote = { hostname: name ? name + '.beebo.tv' : '', online: !!st.online, problem: st.problem || '', connection: st.connection || '', udp: rtcUdpStatus() }
  } catch (e) {}
  return remote
}
ipcMain.handle('connection:state', () => {
  const snap = connectionTest.snapshot()
  let addresses = []
  try { const port = (streamServerInfo && streamServerInfo.port) || STREAM_PORT; addresses = getNetworkAddresses().map((a) => a.address + ':' + port) } catch (e) {}
  const remote = connectionRemote()
  let relayMode = ''
  try { const m = relayController ? relayController.getModel() : null; relayMode = (m && m.mode) || store.get('relayMode') || '' } catch (e) {}
  return Object.assign(snap, { addresses, remote, relayMode })
})
ipcMain.handle('connection:startTest', (_e, kind) => connectionTest.start(String(kind || '')))
ipcMain.handle('connection:save', (_e, partial) => { try { return { ok: true, setup: connectionTest.saveSetup(partial || {}) } } catch (e) { return { ok: false } } })
ipcMain.handle('connection:relayOptIn', async (_e, termsVersion) => {
  const r = await connectionTest.relayOptIn(termsVersion)
  if (r.ok) { try { if (relayController) relayController.evaluate() } catch (e) {} }
  return r
})
ipcMain.handle('connection:choose', async (_e, choice) => {
  const r = await connectionTest.choose(String(choice || ''))
  if (r.ok) { try { if (relayController) relayController.evaluate() } catch (e) {} }
  return r
})
ipcMain.handle('connection:relayInfo', () => connectionTest.relayInfo())
// "Help us plan Beebo Relay" (optional survey): answer, send, not now (30 days).
ipcMain.handle('connection:survey', () => connectionTest.survey())
ipcMain.handle('connection:surveySend', (_e, arg) => connectionTest.surveySend(String((arg && arg.choice) || ''), typeof (arg && arg.comment) === 'string' ? arg.comment : ''))
ipcMain.handle('connection:surveyLater', () => connectionTest.surveyLater())
// "Test again" after changing router settings: ask the router once more, now.
ipcMain.handle('connection:retryRouter', async () => {
  const tries = [rtcPortMapper, portMapper].filter(Boolean).map((m) => Promise.resolve().then(() => m.refresh()).catch(() => {}))
  await Promise.race([Promise.all(tries), new Promise((r) => setTimeout(r, 15000))])
  return { ok: true, udp: rtcUdpStatus() }
})

ipcMain.handle('remote:setRelayAnalytics', (_e, arg) => {
  if (!relayController) return { ok: false, error: 'Not ready yet.' }
  return Object.assign(relayController.setAnalytics(arg || {}), { model: relayModelOrOff() })
})

// Open a visible window onto the local web viewer (BeeboSchool lessons or the
// report card), already signed in as the owner, so the desktop app's sidebar
// BeeboSchool tab can launch these without anyone re-typing a login.
async function openSchoolWindow(pathname) {
  try {
    const users = auth.getUsers(store)
    const owner = users.find((u) => u && u.isAdmin && u.status === 'approved') || users[0]
    if (!owner) return { ok: false, error: 'no-owner' }
    const sessionValue = auth.signSession(store, owner.id, { desktop: true })
    const port = (streamServerInfo && streamServerInfo.port) || STREAM_PORT
    const isReport = pathname.indexOf('report') !== -1
    const win = new BrowserWindow({
      width: 1100,
      height: 780,
      backgroundColor: '#0f1115',
      title: isReport ? 'BeeboSchool \u2014 Report Card' : 'BeeboSchool',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
    })
    await win.webContents.session.cookies.set({
      url: 'http://127.0.0.1:' + port,
      name: 'beebo_session',
      value: sessionValue,
      httpOnly: true,
      sameSite: 'lax',
      expirationDate: Math.floor(Date.now() / 1000) + 30 * 24 * 3600
    })
    await win.loadURL('http://127.0.0.1:' + port + pathname)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}
ipcMain.handle('school:openLessons', () => openSchoolWindow('/school'))
ipcMain.handle('school:openReport', () => openSchoolWindow('/school/report'))

// Started by the watchdog at logon with --hidden: Beebo is a server, so it
// should come back after a reboot already running, without a window stealing
// focus. The tray icon is what tells you it's alive and how to reach it.
// (macOS cannot pass arguments to a login item; there the OS reports "opened at login" instead -
// platformPolicy.startedHiddenAtLogin.)
const platformPolicy = require('./platformPolicy')
const START_HIDDEN = (() => {
  try {
    return platformPolicy.startedHiddenAtLogin({
      platform: process.platform,
      argv: process.argv,
      settings: process.platform === 'darwin' ? app.getLoginItemSettings() : null
    })
  } catch (e) { return process.argv.includes('--hidden') }
})()
let mainWindow = null
let tray = null
let isQuitting = false

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: !START_HIDDEN,
    backgroundColor: '#0f1115',
    title: 'Beebo Entertainment',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true // explicit (the default since Electron 20); the preload only uses contextBridge + ipcRenderer
    }
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else if (!app.isPackaged) {
    win.loadURL('http://localhost:5173')
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }

  // Closing the window used to quit the app outright, which killed the media
  // server mid-stream for anyone watching. Hide to the tray instead; quitting
  // for real is a deliberate choice from the tray menu.
  win.on('close', (e) => {
    if (isQuitting) return
    e.preventDefault()
    win.hide()
  })

  mainWindow = win
  return win
}

function showMainWindow() {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createWindow()
  win.show()
  if (win.isMinimized()) win.restore()
  win.focus()
}

/**
 * The tray icon: proof Beebo is running, and the way to reach or stop it.
 *
 * Without this, a server started hidden at logon is invisible - no taskbar
 * button, no window, no way in short of Task Manager - even though it is
 * happily streaming.
 */

// A small rolling log of the away-from-home agent, at <user data>/remote-host.log.
// Capped at 512 KB: when it fills, the newest half is kept, so it never grows
// without bound and never needs tidying by hand.
const REMOTE_HOST_LOG_MAX = 512 * 1024
const NEWLINE = String.fromCharCode(10)
let remoteHostLogPath = null
function appendRemoteHostLog(msg) {
  if (!remoteHostLogPath) {
    try { remoteHostLogPath = path.join(app.getPath('userData'), 'remote-host.log') } catch (e) { return }
  }
  try {
    fs.appendFileSync(remoteHostLogPath, new Date().toISOString() + ' ' + String(msg) + NEWLINE)
    const st = fs.statSync(remoteHostLogPath)
    if (st.size > REMOTE_HOST_LOG_MAX) {
      const kept = fs.readFileSync(remoteHostLogPath, 'utf8').slice(-Math.floor(REMOTE_HOST_LOG_MAX / 2))
      fs.writeFileSync(remoteHostLogPath, kept.slice(kept.indexOf(NEWLINE) + 1))
    }
  } catch (e) { /* logging must never break the app */ }
}


function createTray() {
  if (tray) return tray
  try {
    // Windows reads the .ico; macOS (menu bar) and Linux cannot, so they use a PNG.
    const iconPath = path.join(__dirname, platformPolicy.trayIconFile(process.platform))
    let img = nativeImage.createFromPath(iconPath)
    if (img.isEmpty()) {
      console.warn('[tray] icon missing or unreadable at', iconPath)
    } else {
      const px = platformPolicy.trayIconSize(process.platform)
      img = img.resize({ width: px, height: px })
    }
    tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img)
    tray.setToolTip('Beebo Entertainment - your server is running')
    const menu = Menu.buildFromTemplate([
      { label: 'Beebo Entertainment', enabled: false },
      { type: 'separator' },
      { label: 'Open Beebo', click: () => showMainWindow() },
      { label: 'Check for updates', click: () => { checkForDesktopUpdate({ manual: true }).catch(() => {}) } },
      { label: 'Can’t connect? Fix it for me', click: () => { showMainWindow(); try { mainWindow.webContents.send('doctor:open') } catch (e) {} } },
      ...reliability.trayItems(),
      { type: 'separator' },
      {
        label: 'Quit Beebo completely',
        click: () => {
          isQuitting = true
          try { if (tray) { tray.destroy(); tray = null } } catch (e) {}
          app.quit()
        }
      }
    ])
    tray.setContextMenu(menu)
    tray.on('double-click', () => showMainWindow())
  } catch (e) {
    console.warn('[tray] could not create tray icon:', (e && e.message) || e)
  }
  return tray
}

app.whenReady().then(() => {
  // OS encryption is only usable once the app is ready. Encrypt any secret still
  // in plain text; the plain copy goes only after the encrypted one reads back.
  try { secretSettings.migrate() } catch (e) { console.warn('[secrets] migration skipped') }
  // Before the window loads, so it can show "Updated to 0.1.xx" straight away.
  bindPrefStore(store)
  try { handleUpdateStartup() } catch (e) { console.warn('[updater] startup bookkeeping skipped') }
  // Deny every permission request the app does not use, and send a report-only CSP with the app's
  // own page (before the first window loads).
  try { mainSecurity.installSessionPolicy(electronSession.defaultSession, { policy: appPolicy, log: (m) => console.warn('[security] ' + m) }) } catch (e) { console.warn('[security] session policy not installed: ' + (e && e.message)) }
  createWindow()
  createTray()
  // Quiet check for a newer installed build a few seconds after launch.
  // Let the updater read/write the same settings store the rest of the app uses.
  bindPrefStore(store)
  setTimeout(() => {
    // Work out what's available first, tell the window (for the out-of-date
    // badge), and only then decide whether to prompt. When the owner has opted
    // into automatic installs this goes straight through with no dialog, so a
    // PC that rebooted while they were away comes back up to date instead of
    // waiting on a modal nobody is there to click.
    fetchUpdateStatus()
      .then((st) => {
        try {
          const w = BrowserWindow.getAllWindows()[0]
          if (w && !w.isDestroyed()) w.webContents.send('updates:status', st)
        } catch (e) {}
        if (st && st.available) return checkForDesktopUpdate().catch(() => {})
      })
      .catch(() => {})
  }, 4000)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    // macOS: the window is hidden (not closed) while Beebo serves from the menu bar, so clicking
    // the Dock icon has to bring it back.
    else if (platformPolicy.dockActivateShowsWindow(process.platform)) showMainWindow()
  })

  try {
    require('./storybookRuntime').ensureLibrary({ store, userData: app.getPath('userData') })
  } catch (e) { console.warn('[stories] Could not prepare the story library:', e.message) }

  // The Beebo Inbox (inbox.js). Created before the server so the web admin's
  // Inbox tab and "Titles to check" can act on it; started a few seconds later
  // so a big drop waiting from last time never competes with startup.
  try { beeboInbox = createBeeboInbox() } catch (e) { console.warn('[inbox] could not start:', e.message) }
  if (beeboInbox) {
    setTimeout(() => { try { beeboInbox.start() } catch (e) {} }, 6000)
    app.on('before-quit', () => { try { beeboInbox.stop() } catch (e) {} })
  }

  streamServerInfo = startStreamServer({
    port: getStreamPort(),
    inbox: beeboInbox,
    getMoviesDir,
    getTvShowsDir,
    getAllMoviesDirs,
    getAllTvShowsDirs,
    getViewerAppDir,
    getTmdbCacheDir,
    store,
    license,
    planUploadDest,
    recordUploadEntry,
    log: (msg) => console.log('[stream]', msg),
    // If a certificate is already sitting in this folder from a previous run,
    // the server picks it up synchronously and HTTPS is live immediately.
    // If it isn't (or it's corrupt), the server starts as plain HTTP and the
    // background check below fills it in later.
    getCertDir,
    getCertDomain,
    // Verify/reset email links use <name>.beebo.tv, never the request's Host.
    getPublicName: getRemoteName,
    // The name the Worker actually registered (viewer tokens name it), else the wanted one.
    getHouseName: () => { try { return (remoteHost && remoteHost.status().registeredName) || getRemoteName() } catch (e) { return getRemoteName() } },
    agentSecret: RTC_AGENT_SECRET,
    // The Connection wizard's "Watch at home" test.
    onLanRequest: (info) => { try { if (connectionTest) connectionTest.onLanRequest(info) } catch (e) {} },
    // A library share changed from the phone's admin screens: tell beebo.tv.
    onSharesChanged: () => { pushLibraryShares().catch(() => {}) },
    // The Music library (musicLibrary.js), shared with Settings' Music folder section.
    music: musicLib,
    // The Audiobooks library (audiobookLibrary.js), shared with Settings' Audiobooks section.
    audiobooks: audiobookLib,
    getAudiobooksLookupEnabled: () => audiobooksIpc.isLookupEnabled(store)
  })
  installDashboardHooks()
  // Loads the saved index at once; the first rescan waits a few seconds so startup stays quick.
  try { musicLib.start() } catch (e) { console.warn('[music] could not start:', e.message) }
  app.on('before-quit', () => { try { musicLib.close() } catch (e) {} })
  try { audiobookLib.start() } catch (e) { console.warn('[audiobooks] could not start:', e.message) }
  app.on('before-quit', () => { try { audiobookLib.close() } catch (e) {} })

  // Bring this Beebo online for its username.beebo.tv address a few seconds
  // after boot, once the local server is listening and the token is loaded.
  remoteHost = createRemoteHost({
    app,
    getName: getRemoteName,
    getToken: () => { try { return license.getToken() } catch (e) { return null } },
    getLocalPort: () => (streamServerInfo && streamServerInfo.port) || STREAM_PORT,
    getLicense: () => license,
    getIcePorts: () => { const r = getRtcUdpRange(); return r ? r.text : '0' },
    agentSecret: RTC_AGENT_SECRET,
    // Also kept in a small rolling file, because the packaged app has no visible
    // console and these lines are the only way to see why a phone away from home
    // could not connect (after a real failure here, 2026-09-17).
    log: (m) => { try { console.log(m) } catch (e) {} ; try { appendRemoteHostLog(m) } catch (e) {} },
    // The Worker only accepts a member list from the owner of a name it has
    // already seen register, so the first push has to wait for this moment.
    // Before, members were pushed only when the owner toggled someone, which
    // could be before the name ever existed, or for a name since changed.
    onRegistered: () => { lastMemberPush = ''; lastMemberPushAt = 0; schedulePushRemoteMembers(500); try { if (homeAddress) homeAddress.kick() } catch (e) {} },
    onProblem: (code) => { pickFreeRemoteName(code).catch(() => {}) },
    // Relay usage and Beebo Relay status, for metering and the switch-over.
    onAgentMessage: (m) => { try { if (relayController) relayController.onAgentMessage(m) } catch (e) {} },
    // The Connection wizard's "Watch away from home" test.
    onConnection: (m) => { try { if (connectionTest) connectionTest.onConnection(m) } catch (e) {} }
  })
  // The direct address <name>.home.beebo.tv, checked at start and every 5 minutes
  // while signed in with a registered name. The router's own idea of the public
  // IPv4 is passed as a hint, for when this PC reaches beebo.tv over IPv6.
  homeAddress = createHomeAddress({
    getName: () => { try { return (remoteHost && remoteHost.status().registeredName) || '' } catch (e) { return '' } },
    getToken: () => { try { return license.getToken() } catch (e) { return null } },
    getPublicIp: () => { try { const s = portMapper ? portMapper.status() : null; return (s && s.reachable && s.externalIp) || '' } catch (e) { return '' } },
    log: (m) => { try { console.log(m) } catch (e) {} }
  })
  homeAddress.start()
  walletClient = require('./walletClient').createWalletClient({
    store,
    getToken: () => { try { return license.getToken() } catch (e) { return null } },
    backendUrl: () => license.backendUrl(),
    notify: relayNotify,
    onChange: () => { try { if (relayController) relayController.evaluate() } catch (e) {} },
    log: (m) => { try { console.log(m) } catch (e) {} }
  })
  require('./relayPolicy').setBeeboRelayAllowedHook(() => walletClient.allowed())
  relayController = require('./relayController').createRelayController({
    store,
    pricing: require('./relayPricing').createPricingSource({ store }),
    getOwnRelay: ownRelayKind,
    getRemoteHost: () => remoteHost,
    notify: relayNotify,
    wallet: walletClient,
    log: (m) => { try { console.log(m) } catch (e) {} }
  })
  // Decides the relay plan before the agent starts (it's handed over on spawn).
  relayController.start()
  walletClient.start()
  // The owner's own relay, if they set one up (off by default).
  pushRelayToAgent()
  app.on('before-quit', () => { try { if (homeAddress) homeAddress.stop() } catch (e) {} ; try { if (remoteHost) remoteHost.stop() } catch (e) {} ; try { if (walletClient) walletClient.stop() } catch (e) {} })
  // Revoking, deleting or re-approving a person (from this app OR the browser
  // admin) must reach the Worker too, or they keep their away-from-home pass.
  try { store.onDidChange('authUsers', () => schedulePushRemoteMembers(2000)) } catch (e) {}
  // Bring <name>.beebo.tv online a few seconds after boot, once the local
  // server is listening and the token is loaded.
  setTimeout(() => { try { remoteHost.start() } catch (e) {} }, 6000)

  // Ask the router to open our port. Deliberately last and unhurried: nothing
  // else waits on it, and the library is fully usable on the LAN whether it
  // succeeds or not.
  portMapper = createPortMapper({
    port: (streamServerInfo && streamServerInfo.port) || STREAM_PORT,
    // What the router should listen on outside. Same as above unless the owner
    // has set a different one because their provider blocks ours.
    externalPort: getExternalPort(),
    description: 'Beebo Media',
    log: (m) => { try { console.log(m) } catch (e) {} }
  })
  setTimeout(() => { try { portMapper.start() } catch (e) {} }, 9000)

  // And the host agent's UDP range. A range keeps its own numbers (the agent
  // binds exactly these), so a port some other device already forwards is
  // skipped rather than swapped for a random one. Refusal is quiet: it only
  // changes what Settings shows, and the agent still connects the way it did.
  const rtcRange = getRtcUdpRange()
  if (rtcRange) {
    rtcPortMapper = createPortMapper({
      port: rtcRange.min,
      count: rtcRange.max - rtcRange.min + 1,
      protocol: 'UDP',
      description: 'Beebo Remote',
      log: (m) => { try { console.log(m) } catch (e) {} },
      onChange: (st) => {
        try {
          if (remoteHost && typeof remoteHost.setPortMap === 'function') {
            remoteHost.setPortMap(st && st.active && st.reachable ? { externalIp: st.externalIp, localIp: st.localIp, mappings: st.mappings } : null)
          }
        } catch (e) {}
      }
    })
    setTimeout(() => { try { rtcPortMapper.start() } catch (e) {} }, 12000)
  }

  // Remove the mapping on the way out.
  //
  // This matters more than it looks. Plenty of routers only support PERMANENT
  // forwards, and portMapper falls back to those - a permanent mapping survives
  // this process dying, the machine rebooting, and the app being uninstalled.
  // Leaving one behind means leaving a hole open in someone's router forever.
  // So we hold the quit briefly to let the deletes land, with a hard cap so
  // cleanup can never trap the user in an app that won't close. 3s rather than
  // 1.5s now that up to ten UDP forwards go too; a router answers each in well
  // under a tenth of a second, and a finite lease expires by itself anyway.
  let portMapQuitting = false
  app.on('before-quit', (e) => {
    if (portMapQuitting || (!portMapper && !rtcPortMapper)) return
    portMapQuitting = true
    e.preventDefault()
    let finished = false
    const finish = () => { if (finished) return; finished = true; try { app.quit() } catch (_) {} }
    const cap = setTimeout(finish, 3000)
    const stopOne = (m) => (m ? Promise.resolve().then(() => m.stop()).catch(() => {}) : Promise.resolve())
    Promise.all([stopOne(portMapper), stopOne(rtcPortMapper)])
      .then(() => { clearTimeout(cap); finish() })
  })

  // Seed the welcome sample clip once, shortly after the library is ready.
  setTimeout(() => { try { seedWelcomeSample() } catch (e) {} }, 2500)

  // License re-validation: refresh the signed token so a renewed, canceled,
  // or revoked subscription is reflected within a day. No-op while disabled.
  if (license.config.enabled) {
    const revalidateNow = () => { try { license.revalidate().catch(() => {}) } catch (_) {} }
    setTimeout(revalidateNow, 8000)
    setInterval(revalidateNow, 12 * 60 * 60 * 1000)
  }

  // Certificates are strictly background work: the window is already up, the
  // server is already listening, and nothing here can change either of those.
  scheduleCertificateWork()

  // (Files waiting in the Beebo Inbox from last time are picked up when the
  // Inbox starts, a few seconds after the server.)

  // Resume any queued/interrupted format conversions from a previous run —
  // the queue lives in the store, so a restart mid-transcode just picks the
  // job back up from the start of that file.
  convert.ensureWorker(store, (msg) => console.log('[convert]', msg))

  // Always-on plumbing, crash visibility and the diagnostics report (reliability.js). Last, so
  // everything it looks at exists; it also marks startup as finished for the crash handler.
  reliability.start({
    ipcMain, store, license,
    getServerInfo: () => streamServerInfo,
    getServerPort: () => (streamServerInfo && streamServerInfo.port) || STREAM_PORT,
    getRemoteHost: () => remoteHost,
    getPortMapper: () => portMapper,
    getRtcPortMapper: () => rtcPortMapper,
    getHomeAddress: () => homeAddress,
    getWalletClient: () => walletClient,
    isSignedIn: () => { try { return !!license.getToken() } catch (e) { return false } },
    hasOwner: () => { try { return auth.hasOwner(store) } catch (e) { return false } },
    getNetworkAddresses: () => getNetworkAddresses(),
    getConnectionRemote: connectionRemote,
    getBackendUrl: () => { try { return license.backendUrl() } catch (e) { return '' } },
    getRemoteHostStatus: () => (remoteHost ? remoteHost.status() : null),
    getPortMapStatus: () => (portMapper ? portMapper.status() : null),
    getRtcPortMapStatus: () => (rtcPortMapper ? rtcPortMapper.status() : null),
    getHomeAddressStatus: () => (homeAddress ? homeAddress.status() : null),
    getUpdateStatus: lastUpdateStatus,
    isUpdating: updaterIsBusy,
    isConverting: () => convert.list(store).some((e) => e && e.status === 'converting'),
    getLibraries: () => [
      ...getAllMoviesDirs().map((dir, i) => ({ label: i ? 'Movies (extra ' + i + ')' : 'Movies', dir })),
      ...getAllTvShowsDirs().map((dir, i) => ({ label: i ? 'TV Shows (extra ' + i + ')' : 'TV Shows', dir }))
    ],
    getLibraryDirs: () => [
      ...getAllMoviesDirs(), ...getAllTvShowsDirs(),
      ...(musicIpc.getAllMusicDirs(store) || []), ...(audiobooksIpc.getAllAudiobookDirs(store) || []), ...(store.get('photosDirs') || []),
      getInboxDir(), store.get('spaceSaverDir'), store.get('privateVaultDir'), getViewerAppDir(), getTmdbCacheDir()
    ].filter((d) => typeof d === 'string' && d)
  })
}).catch((err) => reliability.fatalStartup(err))

// Best-effort default-gateway discovery. Real LAN adapters have a default route; isolated
// host-only adapters (VirtualBox/VMware/Hyper-V/Docker) do not, which is the surest way to
// tell them apart when the adapter's *name* has been renamed to something unrecognisable.
// Returns a Set of local IPv4 addresses that carry a default route. Never throws — an empty
// Set just means "gateway unknown", and getNetworkAddresses() falls back to name/subnet rules.
function getGatewayInterfaces() {
  const out = new Set()
  try {
    const { execFileSync } = require('child_process')
    if (process.platform === 'win32') {
      // `route print -4`: the 0.0.0.0 / 0.0.0.0 rows are default routes; column 4 is the local
      // interface IP that owns the route (isolated host-only adapters never appear here).
      const txt = execFileSync('route', ['print', '-4'], { encoding: 'utf8', timeout: 4000, windowsHide: true })
      for (const line of txt.split(/\r?\n/)) {
        const p = line.trim().split(/\s+/)
        if (p.length >= 5 && p[0] === '0.0.0.0' && p[1] === '0.0.0.0' && /^\d+\.\d+\.\d+\.\d+$/.test(p[3])) {
          out.add(p[3])
        }
      }
    } else {
      // macOS / Linux: find the interface(s) named on a default route, then map to their IPv4s.
      const txt = execFileSync('netstat', ['-rn'], { encoding: 'utf8', timeout: 4000 })
      const ifaces = new Set()
      for (const line of txt.split(/\r?\n/)) {
        const p = line.trim().split(/\s+/)
        if ((p[0] === 'default' || p[0] === '0.0.0.0') && p.length >= 4) ifaces.add(p[p.length - 1])
      }
      const nets = os.networkInterfaces()
      for (const nm of ifaces) {
        for (const a of nets[nm] || []) {
          if (a.family === 'IPv4' && !a.internal) out.add(a.address)
        }
      }
    }
  } catch { /* gateway detection unavailable — fall back to name/subnet heuristics */ }
  return out
}

function getNetworkAddresses() {
  // Only real LAN adapters — hide VirtualBox/VMware/Hyper-V/WSL/Docker/VPN virtual adapters (whose
  // addresses, e.g. 192.168.56.x, a phone on the real Wi-Fi can never reach) and APIPA (169.254.x).
  //
  // An adapter's NAME isn't enough: a customer's Windows box can rename the VirtualBox host-only
  // adapter to anything, so 192.168.56.1 once leaked through and was shown to phones that could
  // never reach it. We defend three ways, strongest first — a real default gateway (host-only
  // adapters have none), then known virtual subnets, then the adapter-name regex — and always
  // fall back to "show everything" so the address list is never empty.
  const nets = os.networkInterfaces()
  const virtualName = /virtualbox|vmware|hyper-?v|vethernet|\bwsl\b|loopback|bluetooth|host-?only|docker|zerotier|tailscale|npcap|tap-|tunnel|\bvpn\b/i
  const gatewayIps = getGatewayInterfaces()
  // Known virtual/host-only default subnets a phone on the real Wi-Fi can never reach.
  const inVirtualSubnet = (ip) => (
    ip.startsWith('192.168.56.') || // VirtualBox default host-only
    ip.startsWith('192.168.99.') || // VMware default host-only
    ip.startsWith('172.')           // Docker (172.17.x) + Hyper-V Default Switch (172.x /12)
  )
  const all = []
  for (const [name, addrs] of Object.entries(nets)) {
    for (const addr of addrs || []) {
      if (addr.family === 'IPv4' && !addr.internal && !String(addr.address).startsWith('169.254.')) {
        const ip = String(addr.address)
        const hasGateway = gatewayIps.has(ip)
        // A real default gateway overrides the name/subnet heuristics — those only flag an address
        // as virtual when it ISN'T the machine's route to the outside world.
        const virtual = !hasGateway && (virtualName.test(name) || inVirtualSubnet(ip))
        all.push({ interface: name, address: ip, hasGateway, virtual })
      }
    }
  }
  // Pick the strongest non-empty tier so a real LAN address wins but the list is never blank.
  const tiers = [
    all.filter((a) => a.hasGateway && !a.virtual),
    all.filter((a) => !a.virtual),
    all.filter((a) => a.hasGateway),
    all,
  ]
  const list = tiers.find((t) => t.length > 0) || []
  const score = (ip) => ip.startsWith('192.168.') ? 0 : (ip.startsWith('10.') ? 1 : 2)
  list.sort((a, b) => score(a.address) - score(b.address))
  return list.map((a) => ({ interface: a.interface, address: a.address }))
}

app.on('window-all-closed', () => {
  // Beebo keeps serving with no window open - that is the whole point of a home
  // media server. While the tray icon is there, closing the window is "put it
  // away", not "stop". Quit is an explicit choice from the tray menu.
  if (tray) return
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  isQuitting = true
  // Failed-login counters are kept in memory and flushed every few seconds.
  try { auth.flushLoginState(store) } catch (e) {}
})

// Second launch (double-clicking the desktop shortcut while it's already
// running hidden) should surface the existing window rather than do nothing.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => showMainWindow())
}

// --- IPC handlers ---

ipcMain.handle('settings:get', () => ({
  moviesDir: getMoviesDir(),
  tvShowsDir: getTvShowsDir(),
  inboxDir: getInboxDir(),
  musicDir: musicIpc.getMusicDir(store),
  photosDirs: store.get('photosDirs') || [],
  spaceSaverDir: store.get('spaceSaverDir') || '',
  privateVaultDir: store.get('privateVaultDir') || storageDefaults.defaults().privateVaultDir,
  extraMoviesDirs: getExtraMoviesDirs(),
  extraTvShowsDirs: getExtraTvShowsDirs(),
  viewerAppDir: getViewerAppDir(),
  tmdbCacheDir: getTmdbCacheDir(),
  tmdbApiKey: store.get('tmdbApiKey') || process.env.TMDB_API_KEY || '',
  metadataLanguage: store.get('metadataLanguage') || '',
  metadataRegion: store.get('metadataRegion') || '',
  nfoImport: store.get('nfoImport') !== false,
  emailUser: store.get('emailUser') || '',
  emailAppPassword: store.get('emailAppPassword') || '',
  adminNotifyEmail: store.get('adminNotifyEmail') || '',
  emailConfigured: mailer.isConfigured(store),
  // Free-form notes for anything not already captured as a structured
  // setting — DuckDNS login, router admin page, etc — so it's included in a
  // full backup even though nothing else in the app reads it.
  otherCredentials: store.get('otherCredentials') || '',
  // Login-security thresholds shown/editable on the Admin tab — resolved
  // through auth.js's getters so a not-yet-set value still shows the real
  // default (5 / 30) instead of a blank box.
  loginLockoutThreshold: auth.getLockoutThreshold(store),
  loginAlertThreshold: auth.getAlertThreshold(store),
  loginLockoutDurationMinutes: auth.getLockoutDurationMinutes(store),
  missingSearchEngine: store.get('missingSearchEngine') || 'imdb',
  customSearchSites: store.get('customSearchSites') || [],
  // Separate remembered search-site choice per section, so TV Shows and
  // Movies can each stick to their own default (e.g. different trackers) —
  // empty until the user picks one in that section.
  tvShowsSearchEngine: store.get('tvShowsSearchEngine') || '',
  moviesSearchEngine: store.get('moviesSearchEngine') || '',
  // Manual per-file title corrections — used when a filename is too far off
  // from TMDB's actual title for search to find it on its own (e.g. a file
  // named "...Whitecastle" when TMDB has it as "...White Castle"). Set via
  // the 🔄 retry button on a movie card when the automatic re-check still
  // finds nothing.
  movieTitleOverrides: store.get('movieTitleOverrides') || {},
  jellyfinCompat: store.get('jellyfinCompat') === true,
  tvAppCors: store.get('tvAppCors') === true
}))

ipcMain.handle('settings:set', (_e, partial) => {
  desktopSettingsPolicy.writeSettings(store, partial)
  try { if (beeboInbox && Object.keys(partial || {}).some((k) => /^(moviesDir|tvShowsDir|inboxDir|inboxEnabled)$/.test(k))) beeboInbox.reconfigure() } catch (e) {}
  return true
})

ipcMain.handle('uiPrefs:get', () => uiPrefs.read(store))
ipcMain.handle('uiPrefs:set', (_e, partial) => uiPrefs.write(store, partial))
require('./prefsIpc').register({ ipcMain, dialog, store, getMainWindow: () => mainWindow }) // per-user layout/theme/accessibility profile (Settings > Appearance)
ipcMain.handle('app:systemLanguages', () => { try { return app.getPreferredSystemLanguages().slice(0, 12) } catch { return [] } })

// Optional read-only discovery and explicitly reviewed copy/move jobs.
const mediaOrganizer = require('./mediaOrganizerIpc').registerMediaOrganizerIpc({
  ipcMain, dialog, shell, store, app, getMainWindow: () => mainWindow,
  onOrganized: ({ kind, mediaType }) => { if (kind === 'video') notifyLibraryChanged(mediaType === 'tv' ? 'episode' : 'movie') }
})
app.on('before-quit', () => mediaOrganizer.cancel())

// Default-off metadata pilot. No connector, playback routes or startup scans.
const householdCatalogPilot = require('./householdCatalogIpc').registerHouseholdCatalogIpc({
  ipcMain, dialog, store, app, getMainWindow: () => mainWindow
})
app.on('before-quit', () => { try { householdCatalogPilot.cancelScan() } catch (_) {} })

// The local game server itself has no router, firewall or video-relay
// privileges of its own — it only ever binds to 127.0.0.1. "Away Play"
// (household members and friends joining from anywhere) is provided entirely
// by the SAME proven WebRTC host agent that already serves Beebo video away
// from home (remoteHostAgent.js / beebo-rtc-host.js's "mc" data channel):
// this only tells that agent whether to bridge to this Minecraft server, and
// under what name, never by opening anything new on the router.
const homeGameHost = createGameHost({
  ipcMain, dialog, store, app, getMainWindow: () => mainWindow,
  getRemoteHost: () => remoteHost,
  getRemoteName: () => { try { return (remoteHost && remoteHost.status().registeredName) || '' } catch (e) { return '' } },
})
app.on('before-quit', () => { try { homeGameHost.stop() } catch (_) {} })

// The joining side of Away Play: on ANY computer (a household member's, or an
// invited friend's own copy of Beebo), reuses the proven video WebRTC path to
// reach someone else's Home Game Server. See gameJoinIpc.js / beebo-game-client.js.
const gameJoin = createGameJoin({ app, ipcMain, getMainWindow: () => mainWindow })
app.on('before-quit', () => { try { gameJoin.stop() } catch (_) {} })

const SETUP_FOLDER_KEYS = ['moviesDir', 'tvShowsDir', 'musicDir', 'photosDirs', 'spaceSaverDir', 'privateVaultDir', 'inboxDir', 'tmdbCacheDir']
ipcMain.handle('setup:pickFolder', async (_e, key) => {
  if (!SETUP_FOLDER_KEYS.includes(key)) return { ok: false, error: 'Choose a library section.' }
  const result = await dialog.showOpenDialog({ title: 'Choose a Beebo folder', properties: ['openDirectory', 'createDirectory'] })
  if (result.canceled || !result.filePaths[0]) return { ok: true, canceled: true }
  return applySetupFolder(key, result.filePaths[0])
})

async function applySetupFolder(key, chosen) {
  try {
    fs.accessSync(chosen, fs.constants.R_OK | fs.constants.W_OK)
    if (key === 'privateVaultDir') {
      const old = store.get(key)
      if (old && path.resolve(old) !== path.resolve(chosen) && fs.existsSync(old) && fs.readdirSync(old).length)
        return { ok: false, error: 'Private folders already exist here. Keep this location until their encrypted files have been migrated.' }
    }
    if (key === 'photosDirs') {
      await require('./photosApi').photoServices(store).library.setFolders([chosen, ...(store.get(key) || []).slice(1)])
    } else store.set(key, chosen)
    if (key === 'musicDir') { musicLib.refreshWatch(); musicLib.scan() }
    if (beeboInbox) beeboInbox.reconfigure()
    return { ok: true }
  } catch (error) { return { ok: false, error: error.message || 'Cannot use this folder. Choose a writable folder.' } }
}

// First-run folder suggestions, the live "found N" count and the TMDB key step (electron/firstRunIpc.js).
require('./firstRunIpc').register({
  ipcMain, store,
  getMoviesDirs: getAllMoviesDirs,
  getTvDirs: getAllTvShowsDirs,
  applyFolder: applySetupFolder,
  getDefaultDirs: () => { const d = require('./storageDefaults').defaults(); return [d.moviesDir, d.tvShowsDir, ...getAllMoviesDirs(), ...getAllTvShowsDirs()] }
})

ipcMain.handle('dialog:pickFolder', async (_e, key) => {
  desktopSettingsPolicy.assertFolderKey(key)
  const res = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  if (res.canceled || !res.filePaths[0]) return null
  store.set(key, res.filePaths[0])
  // The Inbox's default spot follows the Movies folder.
  try { if (beeboInbox) beeboInbox.reconfigure() } catch (e) {}
  return res.filePaths[0]
})

// Adds a second (or third, etc) Movies/TV Shows folder — e.g. a new hard
// drive brought in once the primary one filled up. New uploads still always
// go to the primary folder; these just widen what gets scanned/served.
async function addExtraDir(storeKey) {
  const res = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  if (res.canceled || !res.filePaths[0]) return store.get(storeKey) || []
  const chosen = res.filePaths[0]
  const list = store.get(storeKey) || []
  if (!list.includes(chosen)) list.push(chosen)
  store.set(storeKey, list)
  return list
}

function removeExtraDir(storeKey, dirToRemove) {
  const list = store.get(storeKey) || []
  const updated = list.filter((d) => d !== dirToRemove)
  store.set(storeKey, updated)
  return updated
}

// Photos screen (electron/photosIpc.js): library folders, who can use Photos, the timeline.
require('./photosIpc').register({
  ipcMain, dialog, shell, store, auth, makeMediaToken,
  getPort: () => (streamServerInfo && streamServerInfo.port) || getStreamPort(),
  log: (msg) => console.log('[photos]', msg)
})

// Trip links card in Photos settings (electron/tripSharesIpc.js): links made from a phone, storage used, revoke.
require('./tripSharesIpc').register({
  ipcMain, store, auth,
  log: (msg) => console.log('[trip-shares]', msg)
})

// Trailers screen (electron/trailersBrowse.js): TMDB discover/videos from here so the key stays out of the window.
// The desktop is the owner's console and has no signed-in household profile, so no viewer policy is set;
// getViewerPolicy is where a profile-aware desktop would hand in the restrictions to honour.
const trailersBrowseIpc = require('./trailersBrowseIpc').register({
  ipcMain, shell,
  getApiKey: () => store.get('tmdbApiKey') || process.env.TMDB_API_KEY || '',
  getLanguage: () => resolveMetadataLocale().language,
  getCacheDir: () => path.join(app.getPath('userData'), 'trailers'),
  getLibrarySources: async () => {
    const cacheDir = getTmdbCacheDir()
    return {
      movieFiles: await scanVideoDirsOffThread(getAllMoviesDirs()),
      movieManifest: tmdbCache.getManifest(cacheDir),
      movieCredits: tmdbCache.getCreditsMap(cacheDir),
      tvManifest: tmdbCache.getTvManifest(cacheDir),
      tvCredits: tmdbCache.getTvCreditsMap(cacheDir)
    }
  },
  posterFor: (media, id) => {
    const cacheDir = getTmdbCacheDir()
    const tv = media === 'tv'
    const local = tv ? tmdbCache.localTvPosterPath(cacheDir, id) : tmdbCache.localPosterPath(cacheDir, id)
    const port = (streamServerInfo && streamServerInfo.port) || STREAM_PORT
    return local ? 'http://localhost:' + port + '/media/' + (tv ? 'poster-tv' : 'poster') + '/' + id + '.jpg' : null
  },
  log: (msg) => console.log(msg)
})

ipcMain.handle('settings:addExtraMoviesDir', () => addExtraDir('extraMoviesDirs'))
ipcMain.handle('settings:removeExtraMoviesDir', (_e, dir) => removeExtraDir('extraMoviesDirs', dir))
ipcMain.handle('settings:addExtraTvShowsDir', () => addExtraDir('extraTvShowsDirs'))
ipcMain.handle('settings:removeExtraTvShowsDir', (_e, dir) => removeExtraDir('extraTvShowsDirs', dir))
musicIpc.registerMusicIpc({ ipcMain, dialog, store, app, library: musicLib })
audiobooksIpc.registerAudiobooksIpc({ ipcMain, dialog, store, library: audiobookLib, getLookup: () => (streamServerInfo && streamServerInfo.audiobookLookup) || null })

// Both library rescans nudge the Beebo Inbox to look for new files (without
// waiting on it; see importNewFiles).
ipcMain.handle('movies:scan', async () => {
  await importNewFiles()
  // One record per file, plus `version` on the files of a film that has several (movieVersionsDesktop.js).
  return movieVersionsDesktop.annotate(await scanVideoDirsOffThread(getAllMoviesDirs()), {
    store, auth, cacheDir: getTmdbCacheDir(), tmdbCache, videoQuality, encodeId: catalog.encodeId
  })
})
ipcMain.handle('movies:setVersionChoice', (_e, group, fileName) =>
  movieVersionsDesktop.setChoice(group, fileName, { store, auth, encodeId: catalog.encodeId }))

ipcMain.handle('movies:play', (_e, filePath) => {
  shell.openPath(filePath)
  return true
})

ipcMain.handle('tvshows:scan', async () => {
  await importNewFiles()
  return scanVideoDirsOffThread(getAllTvShowsDirs())
})

// Real video-resolution detection via ffprobe, replacing the old
// filename-regex quality guess — the owner's file-cleanup pass strips resolution
// tags out of filenames ("Title (Year).ext"), so guessing from the name alone
// left almost everything showing "?". ffprobe only reads the file's header
// metadata (not the whole file), so this stays fast even on large files, but
// a corrupt/unusual file could still hang — hence the timeout.
//
// Tier boundaries/labels below intentionally match QUALITY_TIERS in
// Movies.jsx / TVShows.jsx exactly, so the existing badge UI and "By Quality"
// filter need zero changes — only the detection source changes.
// The app bundles ffprobe under resources/ffmpeg (convert.js resolves it); the npm package is only a last resort and is not a dependency.
const FFPROBE_PKG_PATH = (() => {
  try {
    return require('@ffprobe-installer/ffprobe').path
  } catch {
    return null
  }
})()
const ffprobeBinary = () => convert.ffprobePath() || musicTranscodeModule.resolveFf('ffprobe') || FFPROBE_PKG_PATH

function tierForResolution(width, height) {
  const h = height || 0
  if (h >= 2000) return '2160p'
  if (h >= 1000) return '1080p'
  if (h >= 700) return '720p'
  if (h >= 400) return '480p'
  return 'unknown'
}

function detectVideoResolution(filePath) {
  return new Promise((resolve) => {
    const ffprobe = ffprobeBinary()
    if (!ffprobe) { resolve(null); return }
    execFile(
      ffprobe,
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', ...require('./ffmpegArgs').inputArgs(filePath)],
      // windowsHide stops a black cmd window flashing up for every probed file
      { timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) { resolve(null); return }
        try {
          const parsed = JSON.parse(stdout)
          const stream = (parsed.streams || [])[0]
          if (!stream || !stream.width || !stream.height) { resolve(null); return }
          resolve({ width: stream.width, height: stream.height })
        } catch {
          resolve(null)
        }
      }
    )
  })
}

// Probes (with on-disk caching, keyed by path+mtime+size) every file path
// not already cached, and returns a map of path -> quality tier for the
// whole requested list. Simple blocking-but-cached approach: the first scan
// of a big library is slower (one ffprobe call per uncached file, run
// sequentially), but every launch after that is instant since results are
// cached to disk and only re-probed if the file at that path actually
// changes (different mtime/size).
async function getVideoQualityBatch(filePaths) {
  const cacheDir = getTmdbCacheDir()
  const cache = videoQuality.readCache(cacheDir)
  const result = {}
  let cacheDirty = false

  for (const filePath of filePaths || []) {
    let stat
    try {
      stat = fs.statSync(filePath)
    } catch {
      result[filePath] = 'unknown'
      continue
    }
    const key = videoQuality.keyFor(filePath, stat)
    if (cache[key]) {
      result[filePath] = cache[key]
      continue
    }
    // eslint-disable-next-line no-await-in-loop
    const res = await detectVideoResolution(filePath)
    const tier = res ? tierForResolution(res.width, res.height) : 'unknown'
    result[filePath] = tier
    cache[key] = tier
    cacheDirty = true
  }

  if (cacheDirty) videoQuality.writeCache(cacheDir, cache)
  return result
}

ipcMain.handle('library:getVideoQuality', (_e, filePath) => getVideoQualityBatch([filePath]).then((m) => m[filePath]))
ipcMain.handle('library:getVideoQualityBatch', (_e, filePaths) => getVideoQualityBatch(filePaths))

// Movies / TV Shows Table view: saved layout + lazy, cached, bounded reading of what is inside
// each video file (libraryTableIpc.js). ffprobe is looked up on each use so a late-installed
// build is picked up without a restart.
const libraryTable = require('./libraryTableIpc').register({
  ipcMain,
  store,
  ffprobePath: ffprobeBinary,
  getLibraryRoots: () => [...getAllMoviesDirs(), ...getAllTvShowsDirs()],
  auth,
  watchedState: require('./watchedState'),
  history,
  viewingPrivacy,
  cacheFile: store.path ? path.join(path.dirname(store.path), 'library-table-info.json') : null,
  log: (msg) => console.log('[library-table]', msg)
})
app.on('before-quit', () => { try { libraryTable.saveSync() } catch (_) {} })

// Opens a URL in the user's default browser (not an in-app window) — used for
// "look this up on IMDb" links on missing episodes/sequels.
// --- "last updated" stamp for the sidebar -------------------------------
// Answers the question "am I actually running the newest files?" by reporting
// the newest modification time across the app's own source. Compared against
// when this process started, it can also tell the user a restart is needed —
// edits to the Electron side (electron/*.js) only take effect on relaunch,
// unlike the React side which Vite hot-reloads.
const APP_STARTED_AT = Date.now()

function newestSourceMtime() {
  // Two roots, tagged by whether they're the Electron (main-process) side.
  const roots = [
    { dir: path.join(__dirname), electron: true },
    { dir: path.join(__dirname, '..', 'src'), electron: false },
  ]
  let newest = 0        // newest of ANY tracked file — drives the "Last updated" stamp
  let newestRestart = 0 // newest Electron main-process .js — the only thing a relaunch changes
  let count = 0
  const walk = (dir, depth, electron) => {
    if (depth > 4) return
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full, depth + 1, electron)
        continue
      }
      // Tracked for the "Last updated" stamp: the app's own code plus the
      // storybook narration generator (.py), so the stamp moves whenever any of
      // it changes — not just the React/Electron source.
      if (!/\.(js|jsx|css|html|py)$/i.test(entry.name)) continue
      try {
        const st = fs.statSync(full)
        count += 1
        if (st.mtimeMs > newest) newest = st.mtimeMs
        // Only the Electron main-process JS actually needs a relaunch to take
        // effect. The React side hot-reloads, and the Python generator is
        // re-read from disk every time a book is prepared — neither needs one.
        if (electron && /\.js$/i.test(entry.name) && st.mtimeMs > newestRestart) {
          newestRestart = st.mtimeMs
        }
      } catch {
        /* a file that vanished mid-walk just doesn't count */
      }
    }
  }
  for (const root of roots) walk(root.dir, 0, root.electron)
  return { newest, newestRestart, count }
}

// Storybook voice samples for the desktop picker. The renderer gets the clip as a
// data: URL (each is ~20 KB), so it plays from the packaged file with no server,
// no file:// access and no network. Unknown ids get null (allowlist in voiceSamples).
ipcMain.handle('storybook:voices', () => {
  try { return require('./voiceSamples').listVoices() } catch (e) { return [] }
})
ipcMain.handle('storybook:voiceSample', (_e, id) => {
  try {
    const fp = require('./voiceSamples').sampleFile(String(id || ''))
    if (!fp) return null
    return 'data:audio/mpeg;base64,' + fs.readFileSync(fp).toString('base64')
  } catch (e) { return null }
})

ipcMain.handle('app:buildInfo', () => {
  const { newest, newestRestart, count } = newestSourceMtime()
  return {
    lastUpdated: newest || null,
    startedAt: APP_STARTED_AT,
    version: app.getVersion(),
    fileCount: count,
    // Only an Electron-side change written after launch actually needs a restart.
    needsRestart: !!newestRestart && newestRestart > APP_STARTED_AT
  }
})

// --- server dashboard (serverDashboard.js) ---------------------------------
// The desktop app is the owner at the PC, so it always may stop a stream.
// What only Electron knows is handed to the dashboard here: every Beebo
// process's CPU and memory, the away-from-home status, the update check and
// problems logged by the main process.
function installDashboardHooks() {
  const dash = streamServerInfo && streamServerInfo.dashboard
  if (!dash) return
  dash.setHooks({
    getAppVersion: () => app.getVersion(),
    getProcessMetrics: () => {
      const list = app.getAppMetrics() || []
      const cores = Math.max(1, require('os').cpus().length)
      const cpu = list.reduce((n, m) => n + ((m.cpu && m.cpu.percentCPUUsage) || 0), 0)
      const kb = list.reduce((n, m) => n + ((m.memory && m.memory.workingSetSize) || 0), 0)
      return { cpuPercent: Math.round((cpu / cores) * 10) / 10, memoryBytes: kb * 1024 }
    },
    getAwayStatus: () => ({ ...safeRemoteStatus(), homeAddress: safeHomeAddressStatus() }),
    getUpdateStatus: () => lastUpdateStatus()
  })
  // Main-process warnings and errors count toward "errors in the last 24 hours".
  for (const level of ['warn', 'error']) {
    const original = console[level]
    console[level] = (...args) => {
      try { dash.noteLog(args.map((a) => (a && a.message) || String(a)).join(' ')) } catch (e) {}
      return original.apply(console, args)
    }
  }
}
ipcMain.handle('dashboard:get', async (_e, opts) => {
  const dash = streamServerInfo && streamServerInfo.dashboard
  if (!dash) return { ok: false, error: 'not_ready' }
  const o = opts && typeof opts === 'object' ? opts : {}
  return dash.snapshot({ sections: Array.isArray(o.sections) ? o.sections.map(String) : undefined, days: Number(o.days) === 30 ? 30 : 7 })
})
ipcMain.handle('dashboard:stop', (_e, streamId) => {
  const dash = streamServerInfo && streamServerInfo.dashboard
  if (!dash) return { ok: false, error: 'not_ready' }
  const r = dash.stopStream(String(streamId || ''))
  if (r.ok) console.log('[dashboard] owner stopped a stream from the desktop app')
  return r
})

ipcMain.handle('app:checkForUpdates', () => checkForDesktopUpdate({ manual: true }))
// --- update status + the "install automatically" preference ---------------
// The renderer uses these for the out-of-date badge in the corner and its own
// countdown prompt, so neither depends on a native modal being answered.
ipcMain.handle('updates:status', async (_e, opts) => {
  if (opts && opts.refresh) return await fetchUpdateStatus()
  const cached = lastUpdateStatus()
  if (cached && cached.checkedAt) return cached
  return await fetchUpdateStatus()
})
ipcMain.handle('updates:getAuto', () => readAutoUpdatePref())
ipcMain.handle('updates:setAuto', (_e, on) => { writeAutoUpdatePref(!!on); return readAutoUpdatePref() })
// Download + verify + install now, with no prompt of its own - the renderer
// has already asked.
ipcMain.handle('updates:installNow', () => checkForDesktopUpdate({ auto: true }))
// Download progress, pause/resume, install now / when idle / tonight, and the
// "Updated to" card after a relaunch (desktopUpdater.js).
registerUpdateIpc(ipcMain)

// --- licensing: the owner activation UI in Settings talks to these ---
ipcMain.handle('license:status', () => {
  const ev = license.accessStatus()
  return {
    enforced: !!ev.enforced,
    serve: !!ev.serve,
    homeAllowed: ev.homeAllowed,
    awayAllowed: ev.awayAllowed,
    state: ev.state,
    type: ev.payload && ev.payload.type,
    plan: (ev.payload && ev.payload.plan) || license.config.plan,
    expiresAt: (ev.payload && ev.payload.expiresAt) || null,
    deviceId: license.getDeviceId(),
    configured: !!(license.config.enabled && license.config.publicKey && license.config.backendUrl),
    // A beebo.tv address and away-from-home viewing need an email account.
    hasEmail: !!(ev.payload && ev.payload.email),
  }
})
// 'license:startTrial' (the device-only trial with no email) is retired: every
// trial is 'license:registerTrial', the email sign-in trial.
ipcMain.handle('license:activate', async (_e, key) => { const r = await license.activate(key); try { if (remoteHost) remoteHost.restart() } catch (e) {} ; reliability.signedIn(r); return r })
ipcMain.handle('license:login', async (_e, arg) => { const r = await license.login((arg && arg.email) || '', (arg && arg.password) || ''); try { if (remoteHost) remoteHost.restart() } catch (e) {} ; reliability.signedIn(r); return r })
ipcMain.handle('license:registerTrial', async (_e, arg) => { const r = await license.registerTrial((arg && arg.email) || '', (arg && arg.password) || ''); try { if (remoteHost) remoteHost.restart() } catch (e) {} ; reliability.signedIn(r); return r })
ipcMain.handle('license:signOut', () => {
  license.clearToken()
  try { if (remoteHost) remoteHost.stop() } catch (e) { console.warn('[sign-out] remote host stop failed:', e.message) }
  return { ok: true }
})
ipcMain.handle('license:refresh', async () => { const r = await license.revalidate(); try { if (remoteHost) remoteHost.start() } catch (e) {} ; return r })

// Settings > Quality & subtitles: live conversion switches + the owner's OpenSubtitles account.
try { require('./playbackSettingsIpc').register({ ipcMain, store, getTranscode: () => (streamServerInfo && streamServerInfo.transcode) || null }) } catch (e) { console.log('[playback] settings unavailable:', e && e.message) }
// Settings > Add-ons (optional downloads such as the local AI Speech Pack): electron/addonsIpc.js, docs/ADDONS.md.
try { require('./addonsIpc').register({ ipcMain, getMainWindow: () => mainWindow, getSpeechPack: () => (streamServerInfo && streamServerInfo.speechPack) || null, log: (m) => console.log('[addons]', m) }) } catch (e) { console.log('[addons] unavailable:', e && e.message) }

ipcMain.handle('app:openExternal', (_e, url) => {
  // Parsed, not prefix-matched: https only, no credentials, a real DNS name (mainSecurity.isSafeExternalUrl).
  const safe = mainSecurity.isSafeExternalUrl(url)
  if (!safe) return false
  shell.openExternal(safe)
  return true
})

// Metadata: the language and region TMDB answers in, the translation layer, the artwork picker and
// the merge point every reader goes through (metadataMerge.js; documented there). "Edit info" and
// the pickers are desktop-only channels (metadataIpc.js).
const tmdbKeyNow = () => store.get('tmdbApiKey') || process.env.TMDB_API_KEY
const systemLocaleTag = () => { try { return (app.getLocale && app.getLocale()) || process.env.LANG || '' } catch { return '' } }
const resolveMetadataLocale = () => metadataLocale.resolve(store.get('metadataLanguage'), store.get('metadataRegion'), systemLocaleTag())
const metadataLocalizer = metadataLocale.createLocalizer({
  getApiKey: tmdbKeyNow,
  getLocale: resolveMetadataLocale,
  createApi: (k) => titleMatch.createTmdbApi(k),
  log: (m) => console.log(m)
})
const artworkService = artworkPicker.createArtwork({
  getApi: () => titleMatch.createTmdbApi(tmdbKeyNow()),
  getLocale: resolveMetadataLocale,
  getCacheDir: getTmdbCacheDir,
  sidecars: metadataMerge.state.sidecars,
  reencode: artworkPicker.ffmpegReencoder(() => convert.ffmpegPath()),
  log: (m) => console.log(m)
})
metadataMerge.configure({
  localizer: metadataLocalizer,
  artwork: artworkService,
  getMovieDirs: getAllMoviesDirs,
  getTvDirs: getAllTvShowsDirs,
  nfoEnabled: () => store.get('nfoImport') !== false
})
try {
  const { readTvMetaCached } = require('./streamServer')
  const watchedStateModule = require('./watchedState')
  require('./metadataIpc').register({
    ipcMain, dialog, BrowserWindow, store,
    artwork: artworkService,
    localizer: metadataLocalizer,
    getCacheDir: getTmdbCacheDir,
    getMovieDirs: getAllMoviesDirs,
    getTvDirs: getAllTvShowsDirs,
    scanMovies: () => scanVideoDirsOffThread(getAllMoviesDirs()),
    rawMovie: (fileName) => tmdbCache.getManifest(getTmdbCacheDir())[fileName] || null,
    rawShow: (showKey) => readTvMetaCached(tmdbCache.getTvManifest(getTmdbCacheDir()), showKey),
    decorateMovie: withLocalPoster,
    decorateShow: withLocalTvPoster,
    getPort: () => (streamServerInfo && streamServerInfo.port) || getStreamPort(),
    resolveLocale: resolveMetadataLocale,
    tmdbLibrary: async () => {
      const dir = getTmdbCacheDir()
      const ids = (map, kind) => Object.values(map || {}).filter((e) => e && Number.isSafeInteger(e.id) && e.id > 0).map((e) => ({ kind, id: e.id }))
      return [...ids(tmdbCache.getManifest(dir), 'movie'), ...ids(tmdbCache.getTvManifest(dir), 'tv')]
    },
    markWatched: (fileNames) => {
      const users = auth.getUsers(store) || []
      const me = users.find((u) => u && u.isAdmin && u.status === 'approved') || users.find((u) => u && u.isAdmin)
      if (!me) return 0
      const fresh = fileNames.filter((f) => !watchedStateModule.isWatched(store, me.id, 'movie', f))
      if (fresh.length) watchedStateModule.setWatched(store, me.id, fresh.map((fileName) => ({ kind: 'movie', fileName })), true)
      return fresh.length
    },
    log: (m) => console.log(m)
  })
} catch (e) { console.log('[metadata] unavailable:', e && e.message) }

// Movie / show details pages: TMDB detail lookups, the file's audio + subtitle tracks, play with a
// track choice, the trailer button. All of it lives in detailsIpc.js; nothing here holds the TMDB key
// beyond handing it to the request layer.
try {
  const tmdbKey = tmdbKeyNow
  require('./detailsIpc').register({
    ipcMain, shell, BrowserWindow, store, auth, history, tmdbCache,
    watchedState: require('./watchedState'),
    trailersService: trailersBrowseIpc.service,
    details: require('./tmdbDetails').createTmdbDetails({ getApi: () => titleMatch.createTmdbApi(tmdbKey()), getCacheDir: getTmdbCacheDir, getLocale: resolveMetadataLocale }),
    mergeDetails: (kind, data, ctx) => metadataMerge.mergeDetails(kind, data, { cacheDir: getTmdbCacheDir(), ...ctx }),
    mediaInfo: require('./mediaInfo').createMediaInfo({ ffprobePath: ffprobeBinary, getCacheDir: getTmdbCacheDir }),
    getCacheDir: getTmdbCacheDir,
    getStreamPort: () => (streamServerInfo && streamServerInfo.port) || getStreamPort(),
    getMoviesDirs: getAllMoviesDirs,
    getTvDirs: getAllTvShowsDirs,
    scanMovies: () => scanVideoDirsOffThread(getAllMoviesDirs()),
    scanTv: () => scanVideoDirsOffThread(getAllTvShowsDirs()),
    log: (m) => console.log(m)
  })
} catch (e) { console.log('[details] unavailable:', e && e.message) }

// Watch together: the details page's button that starts a room and copies the invite (watchTogetherIpc.js).
try {
  require('./watchTogetherIpc').register({ ipcMain, BrowserWindow, clipboard, store, auth, getStreamPort: () => (streamServerInfo && streamServerInfo.port) || getStreamPort(), log: (m) => console.log(m) })
} catch (e) { console.log('[watch-together] unavailable:', e && e.message) }

// Used for the "🗑 Delete this copy" action on duplicate episodes/movies —
// only allows deleting a file that's actually inside one of the app's own
// managed folders (Movies/TV Shows), as a guardrail against deleting
// anything else on the user's machine.
ipcMain.handle('file:delete', (_e, filePath) => {
  if (typeof filePath !== 'string' || !filePath) return { ok: false, error: 'invalid_path' }
  const resolved = path.resolve(filePath)
  const allowedRoots = [...getAllMoviesDirs(), ...getAllTvShowsDirs()].filter(Boolean).map((d) => path.resolve(d))
  const isAllowed = allowedRoots.some((root) => resolved === root || resolved.startsWith(root + path.sep))
  if (!isAllowed) return { ok: false, error: 'outside_managed_folders' }
  try {
    fs.unlinkSync(resolved)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
})

// --- Source-folder cleanup: sort-usb-media.ps1 (the USB import script) logs
// every file it copies as "Kind: <source> -> <dest>" in sort-usb-media-log.txt
// (a sibling of the Movies/TV Shows folders). We reuse that log — instead of
// building a separate tracking system — to answer "which files in my library
// came from this same source folder on the USB drive?" so items like a phone's
// camera-roll dump (which land in Movies with no real title/poster, since
// they're not actual movies) can be found and bulk-removed together, and that
// source folder can be excluded from future USB imports.
function getUsbSortLogPath() {
  return path.join(path.dirname(getMoviesDir()), 'sort-usb-media-log.txt')
}

function getExcludedFoldersFilePath() {
  return path.join(path.dirname(getMoviesDir()), 'excluded-source-folders.json')
}

let _sortLogCache = null // { mtimeMs, byDest: Map<resolvedDestPath, sourceFolder> }
function getSourceFolderMap() {
  const logPath = getUsbSortLogPath()
  let stat
  try {
    stat = fs.statSync(logPath)
  } catch {
    return new Map()
  }
  if (_sortLogCache && _sortLogCache.mtimeMs === stat.mtimeMs && _sortLogCache.logPath === logPath) {
    return _sortLogCache.byDest
  }
  const byDest = new Map()
  let text = ''
  try {
    text = fs.readFileSync(logPath, 'utf8')
  } catch {
    return byDest
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^(Movie|TV): (.+) -> (.+)$/)
    if (!m) continue
    const [, , source, dest] = m
    byDest.set(path.resolve(dest.trim()), path.dirname(source.trim()))
  }
  _sortLogCache = { mtimeMs: stat.mtimeMs, logPath, byDest }
  return byDest
}

function writeExcludedFoldersFile(list) {
  try {
    fs.writeFileSync(getExcludedFoldersFilePath(), JSON.stringify(list, null, 2), 'utf8')
  } catch {
    /* best effort — the app's own excludedSourceFolders store value is the source of truth */
  }
}

// Returns { [absoluteDestPath]: sourceFolder } for every file the USB import
// script has ever copied — the renderer filters this down to whatever's on
// screen rather than us needing a per-file lookup call.
ipcMain.handle('library:allSourceFolders', () => Object.fromEntries(getSourceFolderMap()))

ipcMain.handle('library:filesInSourceFolder', (_e, folderPath) => {
  if (typeof folderPath !== 'string' || !folderPath) return []
  const map = getSourceFolderMap()
  const out = []
  for (const [dest, folder] of map.entries()) {
    if (folder !== folderPath) continue
    if (!fs.existsSync(dest)) continue
    let size = 0
    try {
      size = fs.statSync(dest).size
    } catch {
      /* ignore */
    }
    out.push({ path: dest, fileName: path.basename(dest), size })
  }
  return out.sort((a, b) => a.fileName.localeCompare(b.fileName))
})

// Deletes an explicit list of files (used by the source-folder review dialog,
// where the user can uncheck anything they want to keep before deleting the
// rest) — same managed-folders guardrail as the regular file:delete handler.
// Optionally also remembers the source folder so the next USB import skips it.
ipcMain.handle('library:deleteFiles', async (event, { paths, excludeFolder }) => {
  const allowedRoots = [...getAllMoviesDirs(), ...getAllTvShowsDirs()].filter(Boolean).map((d) => path.resolve(d))
  const list = Array.isArray(paths) ? paths : []
  const total = list.length
  let deleted = 0
  const failed = []
  // fs.unlinkSync in a big loop blocks the main process's event loop — on
  // Windows that also stalls the window's own message pump, which is why
  // deleting a large batch (e.g. a whole phone camera-roll folder) could
  // make the app show "Not Responding" until the loop finished. Using the
  // async fs.promises version yields between each delete so the app (and
  // the "Deleting…" button label) stays responsive throughout. Also reports
  // per-file progress back to the renderer (same pattern as the TMDB
  // prefetch progress bar) so the review dialog can show a live "deleting
  // X of Y — <filename>" line instead of leaving the button as a static
  // "Deleting…" with no sign of life.
  for (let i = 0; i < list.length; i++) {
    const p = list[i]
    if (typeof p !== 'string' || !p) continue
    const resolved = path.resolve(p)
    const isAllowed = allowedRoots.some((root) => resolved === root || resolved.startsWith(root + path.sep))
    if (!isAllowed) {
      failed.push({ path: p, error: 'outside_managed_folders' })
      event.sender.send('library:deleteProgress', { current: i + 1, total, fileName: path.basename(p), ok: false })
      continue
    }
    try {
      await fs.promises.unlink(resolved)
      deleted++
      event.sender.send('library:deleteProgress', { current: i + 1, total, fileName: path.basename(resolved), ok: true })
    } catch (err) {
      failed.push({ path: p, error: String(err) })
      event.sender.send('library:deleteProgress', { current: i + 1, total, fileName: path.basename(resolved), ok: false })
    }
  }
  if (excludeFolder && typeof excludeFolder === 'string') {
    const excluded = new Set(store.get('excludedSourceFolders') || [])
    excluded.add(excludeFolder)
    const list = Array.from(excluded)
    store.set('excludedSourceFolders', list)
    writeExcludedFoldersFile(list)
  }
  return { ok: true, deleted, failed }
})

ipcMain.handle('library:excludedFolders', () => store.get('excludedSourceFolders') || [])

// --- Upload feature: drag-and-drop (or website admin upload) a video file,
// auto-classify it as a movie or TV episode, and copy it straight into the
// right library folder. Posters/titles are NOT fetched here — the existing
// scan+enrich flow already in Movies.jsx/TVShows.jsx does that automatically
// for any file it finds on the next scan, so a freshly-imported file just
// needs to land in the right place and it picks up a poster on its own.

// Mirrors the episode-detection regex used in TVShows.jsx's parseEpisode —
// duplicated here (not imported) since this runs in the main process, not
// the renderer, following this project's convention of duplicating small
// helpers per-file rather than sharing a module across process boundaries.
const UPLOAD_EPISODE_RE = /^(.*?)[.\s_-]+S(\d{1,2})[.\s_-]?E(\d{1,3})/i
const UPLOAD_NXNN_RE = /^(.*?)[.\s_-]+(\d{1,2})x(\d{1,3})/i
const UPLOAD_SEASON_WORD_RE = /^(.*?)[.\s_-]+[Ss]eason[.\s_-]?\d{1,2}[.\s_-]+[Ee]pisode[.\s_-]?\d{1,3}/i
// Catches TV releases that skip S/E letters entirely and just use a 3-4
// digit season+episode code — "Hells.Kitchen.US.1018.pdtv-lol" (season 10,
// episode 18), "Homeland.311.720p.x264-kyr" (season 3, episode 11). The
// "not a real year" + "immediately followed by a broadcast/scene tag" combo
// is what tells this apart from an ordinary movie filename with a year in
// it — see the long comment on detectTvEpisodeCode below for the reasoning.
const UPLOAD_CODE_BROADCAST_RE = /^(.*?)[.\s_-]+(\d{3,4})[.\s_-]+(?:pdtv|hdtv|dsr|dvdrip)\b/i
const UPLOAD_CODE_SCENE_RE = /^(.*?)[.\s_-]+(\d{3,4})[.\s_-]+(?:480p|720p|1080p|2160p|x264|x265|hevc|xvid|divx|bluray|webrip|web-?dl|dvdrip)\b/i
// Looser fallback for releases like "arrow.102._-lol" — a bare season+episode
// code followed by nothing but a short release-group tag (no recognizable
// broadcast/quality word at all). This is deliberately narrower than it looks:
// the trailing part must be a SINGLE token with no further separators inside
// it (so "Movie.2001.A.Space.Odyssey" style titles, which have more words
// after the number, never match), and callers only accept it when the prefix
// has real letters in it and either matches a show folder that already exists
// under TV Shows, or is otherwise plausible — see detectTvEpisodeCode.
const UPLOAD_CODE_GROUP_RE = /^(.*?)[.\s_-]+(\d{3,4})[.\s_-]+[A-Za-z0-9]{1,20}$/i
// Last-resort fallback for releases with NOTHING after the code at all —
// "blue bloods 402.mkv", "Blue.Bloods.403" — just a show-name-looking prefix,
// a separator, a 3-4 digit season+episode code, and end of string (only
// trailing separator chars allowed before the extension, which is already
// stripped by the time this runs). This is the least specific tier of all
// four — there's no tag of any kind confirming it's an episode marker, so a
// movie literally titled with a trailing number ("Apollo 13", "Ocean's 11",
// "Se7en", "300") could in principle match the shape. Two things make it
// safe: the code must be 3-4 digits (rules out "13", "11" — two digits) and
// not look like a year (rules out "2001", "1917"), and callers below require
// `knownShow` — an existing TV Shows folder matching the guessed prefix — to
// be true before ever accepting a match from this tier, unlike the other
// tiers which can also fall back on the tag-based safety net alone.
const UPLOAD_CODE_BARE_END_RE = /^(.*?)[.\s_-]+(\d{3,4})[.\s_-]*$/i
const UPLOAD_LEADING_ID_RE = /^\d{4,}[\s._-]+/

// Reads the TV Shows folder(s) just for their top-level subfolder names
// (the show names) — used as a cheap, high-confidence signal in
// detectTvEpisodeCode's loose fallback: "arrow.102._-lol" is almost
// certainly Arrow S01E02 if "Arrow" is already a show folder on disk.
function getExistingTvShowNames() {
  const names = new Set()
  for (const dir of getAllTvShowsDirs()) {
    if (!dir) continue
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory()) names.add(entry.name.trim().toLowerCase())
    }
  }
  return names
}

// Shared by classifyUpload (new uploads) and the "find misplaced TV
// episodes" scan (existing files already sitting in the wrong folder) — one
// place that knows every episode-naming style this app recognizes, so a fix
// to one applies to both instead of drifting apart.
// `existingShowNames` (a Set of lowercased TV Shows folder names, from
// getExistingTvShowNames) is optional — pass it when scanning a batch of
// files so callers only need to read the TV Shows folder once instead of
// once per file.
function detectTvEpisodeCode(nameNoExt, existingShowNames) {
  let m = nameNoExt.match(UPLOAD_CODE_BROADCAST_RE) || nameNoExt.match(UPLOAD_CODE_SCENE_RE)
  let knownShow = false
  if (!m) {
    // Nothing with a recognizable broadcast/quality tag matched — try the
    // looser "bare code + single trailing token" pattern, but only trust it
    // when the guardrails below hold, so ordinary movie titles that happen to
    // contain a 3-4 digit number ("2012", "1917", "300", "2001: A Space
    // Odyssey", "Se7en", "2 Fast 2 Furious") don't get misclassified as TV.
    const gm = nameNoExt.match(UPLOAD_CODE_GROUP_RE)
    if (gm) {
      const prefix = gm[1]
      const code = gm[2]
      const isYearlike = /^(19|20)\d{2}$/.test(code)
      const hasLetters = /[a-z]/i.test(prefix)
      if (!isYearlike && hasLetters) {
        const showGuess = upload_cleanTitle(prefix)
        const names = existingShowNames || getExistingTvShowNames()
        // Strongest signal: the guessed show name already has a folder under
        // TV Shows — accept this loose match with high confidence. Otherwise
        // fall back to accepting it anyway (it already passed the letters +
        // separator + not-a-year guardrails above), just flagged as a weaker,
        // secondary signal via `knownShow: false` for callers that want it.
        knownShow = !!(showGuess && names.has(showGuess.toLowerCase()))
        m = gm
      }
    }
  }
  if (!m) {
    // Nothing at all after the code, not even a release-group tag — only
    // trust this if the prefix already matches a real TV Shows folder (see
    // the long comment on UPLOAD_CODE_BARE_END_RE above). No fallback
    // acceptance here the way UPLOAD_CODE_GROUP_RE has one; knownShow is
    // mandatory for this tier.
    const bm = nameNoExt.match(UPLOAD_CODE_BARE_END_RE)
    if (bm) {
      const prefix = bm[1]
      const code = bm[2]
      const isYearlike = /^(19|20)\d{2}$/.test(code)
      const hasLetters = /[a-z]/i.test(prefix)
      if (!isYearlike && hasLetters) {
        const showGuess = upload_cleanTitle(prefix)
        const names = existingShowNames || getExistingTvShowNames()
        if (showGuess && names.has(showGuess.toLowerCase())) {
          knownShow = true
          m = bm
        }
      }
    }
  }
  if (!m) return null
  const code = m[2]
  if (/^(19|20)\d{2}$/.test(code)) return null // a real year, not a season+episode code — leave it alone
  const season = code.length === 4 ? parseInt(code.slice(0, 2), 10) : parseInt(code.slice(0, 1), 10)
  const episode = code.length === 4 ? parseInt(code.slice(2), 10) : parseInt(code.slice(1), 10)
  return { showName: upload_cleanTitle(m[1]) || null, season, episode, code, knownShow }
}

function upload_cleanTitle(raw) {
  let t = raw.replace(/[._]/g, ' ')
  t = t.replace(/\s+/g, ' ').trim().replace(/[-\s]+$/, '')
  return t
}

// Classifies one dropped/uploaded file by its original filename: TV episode
// (with a guessed show name) or a movie. Doesn't touch the filesystem.
function classifyUpload(originalName) {
  const ext = path.extname(originalName).toLowerCase()
  const noExt = path.basename(originalName, ext)
  const stem = noExt.replace(UPLOAD_LEADING_ID_RE, '')

  let m = stem.match(UPLOAD_EPISODE_RE)
  if (m) return { kind: 'tv', showName: upload_cleanTitle(m[1]) || 'Unsorted', ext }
  m = stem.match(UPLOAD_NXNN_RE)
  if (m) return { kind: 'tv', showName: upload_cleanTitle(m[1]) || 'Unsorted', ext }
  m = stem.match(UPLOAD_SEASON_WORD_RE)
  if (m) return { kind: 'tv', showName: upload_cleanTitle(m[1]) || 'Unsorted', ext }
  const codeMatch = detectTvEpisodeCode(stem)
  if (codeMatch) return { kind: 'tv', showName: codeMatch.showName || 'Unsorted', ext }
  return { kind: 'movie', ext }
}

// Finds files sitting in the Movies folder that actually look like TV
// episodes — the same detection classifyUpload now uses for new uploads,
// just run backwards over what's already on disk. Needed because a batch
// import (e.g. the USB sort script) can land files in the wrong folder if
// they were never actually TV-shaped by its own rules; this is what a
// "Find misplaced TV episodes" scan in the Movies tab calls. Read-only —
// doesn't touch the filesystem, just reports what it found so the user can
// review before anything moves.
ipcMain.handle('library:scanMisplacedTv', async () => {
  const files = await scanVideoDirsOffThread(getAllMoviesDirs())
  // Read the TV Shows folder names once for the whole batch, not once per
  // file — detectTvEpisodeCode's loose fallback uses it as a cross-check.
  const existingShowNames = getExistingTvShowNames()
  const found = []
  for (const f of files) {
    const stem = f.name.replace(UPLOAD_LEADING_ID_RE, '')
    let m = stem.match(UPLOAD_EPISODE_RE)
    let showName = m ? upload_cleanTitle(m[1]) : null
    if (!showName) {
      m = stem.match(UPLOAD_NXNN_RE)
      showName = m ? upload_cleanTitle(m[1]) : null
    }
    if (!showName) {
      m = stem.match(UPLOAD_SEASON_WORD_RE)
      showName = m ? upload_cleanTitle(m[1]) : null
    }
    let code = null
    if (!showName) {
      const codeMatch = detectTvEpisodeCode(stem, existingShowNames)
      if (codeMatch) {
        showName = codeMatch.showName
        code = codeMatch.code
      }
    }
    if (showName) found.push({ path: f.path, fileName: f.fileName, guessedShow: showName || 'Unsorted', code })
  }
  return found
})

// Moves a batch of files out of the Movies folder into
// TvShowsDir/<showName>/<original filename> — the actual fix once the user's
// reviewed the "Find misplaced TV episodes" results and confirmed the
// guessed show names (editable in the UI before this is called). Uses
// fs.renameSync since both folders are expected to live on the same drive;
// falls back to copy+delete for the rare cross-device case (e.g. Movies and
// TV Shows configured on different drives), same as any normal "move file"
// operation has to.
ipcMain.handle('library:moveToTvShows', (_e, items) => {
  const moviesRoot = path.resolve(getMoviesDir())
  const tvRoot = getTvShowsDir()
  const list = Array.isArray(items) ? items : []
  const moved = []
  const failed = []
  for (const item of list) {
    const srcPath = item?.path
    const showName = (item?.showName || '').trim()
    if (typeof srcPath !== 'string' || !srcPath || !showName) {
      failed.push({ path: srcPath, error: 'invalid_item' })
      continue
    }
    const resolvedSrc = path.resolve(srcPath)
    if (resolvedSrc !== moviesRoot && !resolvedSrc.startsWith(moviesRoot + path.sep)) {
      failed.push({ path: srcPath, error: 'outside_movies_folder' })
      continue
    }
    try {
      const destDir = path.join(tvRoot, showName)
      fs.mkdirSync(destDir, { recursive: true })
      const destPath = uniqueDestPath(destDir, path.basename(resolvedSrc))
      try {
        fs.renameSync(resolvedSrc, destPath)
      } catch {
        fs.copyFileSync(resolvedSrc, destPath)
        fs.unlinkSync(resolvedSrc)
      }
      moved.push({ path: srcPath, destPath })
    } catch (err) {
      failed.push({ path: srcPath, error: String(err) })
    }
  }
  return { ok: true, moved, failed }
})

// Picks a destination path that won't clobber an existing file — appends
// " (uploaded <date>)" if something's already there with that exact name,
// rather than ever overwriting.
function uniqueDestPath(destDir, fileName) {
  const ext = path.extname(fileName)
  const base = path.basename(fileName, ext)
  let candidate = path.join(destDir, fileName)
  if (!fs.existsSync(candidate)) return candidate
  const stamp = new Date().toISOString().slice(0, 10)
  candidate = path.join(destDir, `${base} (uploaded ${stamp})${ext}`)
  let n = 2
  while (fs.existsSync(candidate)) {
    candidate = path.join(destDir, `${base} (uploaded ${stamp} ${n})${ext}`)
    n++
  }
  return candidate
}

// Works out where a file should land (creating the folder if needed) without
// touching the file itself — split out from importUploadedFile so the
// website's upload route can stream a large video straight to its final
// destination path instead of writing a temp copy first and copying it
// again (doubling disk I/O and temp-space usage for multi-GB files).
// Same idea as uniqueDestPath (used when moving/uploading files into a new
// folder) but for renaming a file in place: picks a destination filename in
// the SAME folder that won't clobber anything else already there, without
// the "(uploaded <date>)" wording (which doesn't make sense for a rename).
// `excludePath`, when given, lets the candidate equal the file's own current
// path without being treated as a collision (e.g. a no-op or case-only rename).
function uniqueRenamePath(destDir, fileName, excludePath) {
  const ext = path.extname(fileName)
  const base = path.basename(fileName, ext)
  const resolvedExclude = excludePath ? path.resolve(excludePath) : null
  let candidate = path.join(destDir, fileName)
  if (!fs.existsSync(candidate) || path.resolve(candidate) === resolvedExclude) return candidate
  let n = 2
  while (fs.existsSync(candidate) && path.resolve(candidate) !== resolvedExclude) {
    candidate = path.join(destDir, `${base} (${n})${ext}`)
    n++
  }
  return candidate
}

// Strips characters that are invalid in Windows filenames (\/:*?"<>|),
// collapses whitespace, and trims trailing dots/spaces (also invalid at the
// end of a Windows filename) — used by both the clean-names preview (so the
// suggested name is already safe to show) and apply (defense in depth, since
// the preview can be hand-edited by the user before it's sent back).
function sanitizeFileNamePart(str) {
  return String(str || '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.\s]+$/, '')
}

// Read-only preview for the "Clean up file names" feature — for every file in
// the Movies folder, works out the best on-disk name it can without touching
// anything: a confirmed TMDB match (if this file's already been looked up)
// wins over the filename parser's best guess, which wins over leaving the
// file out entirely (nothing reasonable to propose). The renderer shows this
// list for review — each row individually editable/includable — and only
// library:applyCleanNames actually renames anything, once the user confirms.
ipcMain.handle('library:previewCleanNames', async () => {
  const cacheDir = getTmdbCacheDir()
  const manifest = tmdbCache.getManifest(cacheDir)
  const files = await scanVideoDirsOffThread(getAllMoviesDirs())
  const out = []
  for (const f of files) {
    let proposedBase = null
    let source = null
    // A decision the owner confirmed on the "Titles to check" page is the best
    // name we have for this file, better than the manifest and better than the
    // parser — so it feeds the SUGGESTION here. Nothing about WHEN a rename
    // happens changes: this handler still only previews, and
    // library:applyCleanNames still only runs on an explicit click, per row.
    // A file marked "not a film" is dropped from the suggestions entirely —
    // there is no sensible film name to propose for a trance mix, and proposing
    // one is how a wrong rename gets clicked through by accident.
    const decision = titleMatch.getDecision(store, f.fileName)
    if (decision && (decision.notAMovie || decision.kind === 'none')) continue
    const cached = manifest[f.fileName]
    if (decision && decision.kind === 'movie' && decision.title) {
      proposedBase = decision.year ? `${decision.title} (${decision.year})` : decision.title
      source = 'confirmed'
    } else if (cached && cached.title) {
      const year = (cached.release_date || '').slice(0, 4)
      proposedBase = year ? `${cached.title} (${year})` : cached.title
      source = 'tmdb'
    } else {
      const { title, year } = parseMovieName(f.name)
      if (title && title.trim()) {
        proposedBase = year ? `${title} (${year})` : title
        source = 'parsed'
      }
    }
    if (!proposedBase) continue
    const cleanBase = sanitizeFileNamePart(proposedBase)
    if (!cleanBase) continue
    const proposedName = `${cleanBase}${f.ext}`
    if (proposedName === f.fileName) continue // already clean — nothing to suggest
    out.push({ path: f.path, oldName: f.fileName, proposedName, source })
  }
  return out
})

// Actually performs the renames the user confirmed (and possibly hand-edited)
// in the "Clean up file names" review dialog. Same managed-folders guardrail
// as every other file-mutating handler, plus its own filename sanitizing
// (defense in depth against whatever the user typed into the review box) and
// the same rename+cross-device-fallback pattern used by library:moveToTvShows.
ipcMain.handle('library:applyCleanNames', (_e, items) => {
  const allowedRoots = [...getAllMoviesDirs(), ...getAllTvShowsDirs()].filter(Boolean).map((d) => path.resolve(d))
  const list = Array.isArray(items) ? items : []
  const renamed = []
  const failed = []
  for (const item of list) {
    const oldPath = item?.oldPath
    const newNameRaw = typeof item?.newName === 'string' ? item.newName : ''
    if (typeof oldPath !== 'string' || !oldPath || !newNameRaw.trim()) {
      failed.push({ path: oldPath, error: 'invalid_item' })
      continue
    }
    const resolvedOld = path.resolve(oldPath)
    const isAllowed = allowedRoots.some((root) => resolvedOld === root || resolvedOld.startsWith(root + path.sep))
    if (!isAllowed) {
      failed.push({ path: oldPath, error: 'outside_managed_folders' })
      continue
    }
    if (!fs.existsSync(resolvedOld)) {
      failed.push({ path: oldPath, error: 'source_missing' })
      continue
    }
    const ext = path.extname(resolvedOld)
    // Ignore whatever extension (if any) the user typed in the review box —
    // always keep the file's real extension, so editing the name field can
    // never accidentally change a .mkv into a ".mkv.mp4" or strip it entirely.
    const typedExt = path.extname(newNameRaw)
    const typedBase = typedExt ? path.basename(newNameRaw, typedExt) : newNameRaw
    const cleanBase = sanitizeFileNamePart(typedBase)
    if (!cleanBase) {
      failed.push({ path: oldPath, error: 'invalid_name' })
      continue
    }
    const finalName = `${cleanBase}${ext}`
    const destDir = path.dirname(resolvedOld)
    try {
      const destPath = uniqueRenamePath(destDir, finalName, resolvedOld)
      if (path.resolve(destPath) === resolvedOld) {
        renamed.push({ oldPath, newPath: resolvedOld }) // name already matches — nothing to do
        continue
      }
      try {
        fs.renameSync(resolvedOld, destPath)
      } catch {
        fs.copyFileSync(resolvedOld, destPath)
        fs.unlinkSync(resolvedOld)
      }
      renamed.push({ oldPath, newPath: destPath })
    } catch (err) {
      failed.push({ path: oldPath, error: String(err) })
    }
  }
  return { ok: true, renamed, failed }
})

// Confident per-file season/episode extraction for the TV "Clean up file
// names" preview — mirrors parseEpisode in TVShows.jsx (duplicated here the
// same way parseMovieName/detectTvEpisodeCode are), but only the season/
// episode piece: the show name for a rename comes from the confirmed TMDB
// match (or groupKeyAndName's folder/filename guess) instead, since that's
// more reliable than re-deriving it per file.
function parseEpisodeNumberFromFileName(fileName) {
  const noExt = fileName.replace(/\.[^./\\]+$/, '')
  let m = noExt.match(/^(.*?)[.\s_-]+[Ss](\d{1,2})[.\s_-]*[Ee](\d{1,3})(.*)$/)
  if (!m) m = noExt.match(/^(.*?)[.\s_-]+(\d{1,2})x(\d{1,3})(.*)$/)
  if (!m) m = noExt.match(/^(.*?)[.\s_-]+[Ss]eason[.\s_-]?(\d{1,2})[.\s_-]+[Ee]pisode[.\s_-]?(\d{1,3})(.*)$/i)
  if (!m) return { season: null, episode: null }
  return { season: parseInt(m[2], 10), episode: parseInt(m[3], 10) }
}

// Read-only preview for the TV Shows "Clean up file names" feature — same
// review-before-rename pattern as library:previewCleanNames (Movies), just
// proposing "{Show Name} S{season}E{episode}.{ext}" instead of "{Title}
// ({Year}).{ext}". The show name prefers the confirmed TMDB match for that
// show (same manifest tmdb:searchTv/tmdbConfirmMatchTv writes to) over the
// folder/filename guess, same "confirmed match wins" idea as the Movies
// version. Only proposes a rename when the season/episode number can be
// worked out with real confidence — the strict SxxExx/NxNN/"Season X Episode
// Y" filename patterns, or (for filenames using a bare scene-release code
// like "1018") detectTvEpisodeCode's loose match, but ONLY when it already
// matched an existing TV Shows folder (`knownShow`) — anything less certain
// is left alone rather than risk renaming a file to the wrong episode.
ipcMain.handle('library:previewCleanTvNames', async () => {
  const cacheDir = getTmdbCacheDir()
  const manifest = tmdbCache.getTvManifest(cacheDir)
  const files = await scanVideoDirsOffThread(getAllTvShowsDirs())
  const existingShowNames = getExistingTvShowNames()
  const out = []
  for (const f of files) {
    const relPath = f.relPath || f.fileName
    const { show: fallbackShow } = groupKeyAndName(relPath, f.fileName)
    const showKey = fallbackShow.toLowerCase()
    const confirmedName = manifest[showKey]?.name
    const showName = confirmedName || fallbackShow
    const source = confirmedName ? 'tmdb' : 'parsed'

    let { season, episode } = parseEpisodeNumberFromFileName(f.fileName)
    if (season === null || episode === null) {
      const stem = f.fileName.replace(UPLOAD_LEADING_ID_RE, '').replace(/\.[^./\\]+$/, '')
      const codeMatch = detectTvEpisodeCode(stem, existingShowNames)
      if (codeMatch && codeMatch.knownShow) {
        season = codeMatch.season
        episode = codeMatch.episode
      }
    }
    if (season === null || episode === null) continue // not confident enough to rename

    const cleanShow = sanitizeFileNamePart(showName)
    if (!cleanShow) continue
    const epCode = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
    const proposedName = `${cleanShow} ${epCode}${f.ext}`
    if (proposedName === f.fileName) continue // already clean — nothing to suggest
    out.push({ path: f.path, oldName: f.fileName, proposedName, source })
  }
  return out
})

// Bare (non-bracketed) resolution tag in a filename, ranked so a plain number
// comparison tells you which of two copies is the better quality — 2160p/4k
// beats 1080p beats 720p beats 480p beats "no tag found at all" (0).
const DUP_RESOLUTION_RANKS = { '2160p': 4, '4k': 4, '1080p': 3, '720p': 2, '480p': 1 }
function detectResolutionRank(name) {
  const m = name.match(/(2160p|4k|1080p|720p|480p)/i)
  if (!m) return { rank: 0, label: null }
  const tag = m[1].toLowerCase()
  return { rank: DUP_RESOLUTION_RANKS[tag] || 0, label: tag }
}

function normalizeGroupTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

// Read-only scan for the "Find duplicate movies" feature — groups files in
// the Movies folder by the same movie (preferring the confirmed TMDB id when
// a file's already been matched, since that's the most reliable signal;
// falling back to normalized parsed-title+year for anything not yet looked
// up), then scores each copy in a group so the UI can show which one to keep.
// Quality score is resolution first (2160p > 1080p > 720p > 480p > unknown),
// then file size as the tiebreaker within the same resolution, with a small
// bump for REMUX/BluRay releases — deliberately simple, this covers the
// common case without trying to model every possible quality signal.
ipcMain.handle('library:findDuplicateMovies', async () => {
  const cacheDir = getTmdbCacheDir()
  const manifest = tmdbCache.getManifest(cacheDir)
  const files = await scanVideoDirsOffThread(getAllMoviesDirs())
  const groups = new Map() // key -> { title, year, files: [] }
  const qualityCache = videoQuality.readCache(cacheDir)
  const TIER_HEIGHT = { '2160p': 2160, '1080p': 1080, '720p': 720, '480p': 480 }
  const probedHeight = (f) => TIER_HEIGHT[qualityCache[videoQuality.keyFor(f.path, { mtimeMs: f.mtimeMs, size: f.size })]] || 0
  for (const f of files) {
    const cached = manifest[f.fileName]
    let key
    let title
    let year
    if (cached && cached.id) {
      key = `tmdb:${cached.id}`
      title = cached.title
      year = (cached.release_date || '').slice(0, 4) || null
    } else {
      const parsed = parseMovieName(f.name)
      key = `parsed:${normalizeGroupTitle(parsed.title)}:${parsed.year || ''}`
      title = parsed.title
      year = parsed.year || null
    }
    if (!groups.has(key)) groups.set(key, { key, title, year, files: [] })
    const { rank, label } = detectResolutionRank(f.name)
    const hasQualitySource = /remux|blu-?ray/i.test(f.name)
    // Resolution dominates (each tier is 1e15 apart — far more than any real
    // file size), size breaks ties within the same resolution, and the
    // source bump only matters when both are otherwise identical.
    const qualityScore = rank * 1e15 + f.size + (hasQualitySource ? 1 : 0)
    groups.get(key).files.push({
      path: f.path,
      fileName: f.fileName,
      size: f.size,
      mtimeMs: f.mtimeMs,
      resolution: label,
      qualityScore
    })
  }
  const dupGroups = []
  for (const g of groups.values()) {
    if (g.files.length < 2) continue
    // Several files of one film are usually versions (4K next to 1080p, a Director's Cut), not
    // duplicates: only files with the same edition AND the same resolution class are.
    movieVersions.trueDuplicateSets(g.files, { heightOf: probedHeight }).forEach((set, i) => {
      const sorted = [...set].sort((a, b) => b.qualityScore - a.qualityScore)
      const withRecommendation = sorted.map(({ mtimeMs, ...f }, n) => ({ ...f, recommended: n === 0 ? 'keep' : 'delete' }))
      dupGroups.push({ key: i ? `${g.key}#${i}` : g.key, title: g.title, year: g.year, files: withRecommendation })
    })
  }
  dupGroups.sort((a, b) => b.files.length - a.files.length)
  return dupGroups
})

function planUploadDest(originalName) {
  const ext = path.extname(originalName).toLowerCase()
  if (!VIDEO_EXTS.includes(ext)) return { ok: false, error: 'not_a_video_file' }
  const classified = classifyUpload(originalName)
  // The show folder name comes from an uploaded file's name: one safe path segment only
  // (electron/safePath.js: no '..', no Windows device names) — security review F8.
  const showSegment = classified.kind === 'tv' ? (require('./safePath').safeSegment(classified.showName) || 'Unsorted') : ''
  const destDir = classified.kind === 'tv' ? path.join(getTvShowsDir(), showSegment) : getMoviesDir()
  fs.mkdirSync(destDir, { recursive: true })
  const destPath = uniqueDestPath(destDir, path.basename(originalName))
  return { ok: true, kind: classified.kind, showName: classified.showName || null, destPath }
}

// Records a completed upload (file already written to destPath) in the
// upload history + recently-added list.
function recordUploadEntry({ fileName, kind, showName, destPath, uploadedBy }) {
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    fileName,
    kind,
    showName: showName || null,
    destPath,
    uploadedBy: uploadedBy || 'Unknown',
    uploadedAt: Date.now()
  }
  const uploadHistory = store.get('uploadHistory') || []
  uploadHistory.unshift(entry)
  store.set('uploadHistory', uploadHistory)

  // "Recently added" list — powers the NEW badge and the New tab. Pruned to
  // the last 30 days on every write so it can't grow forever; the UI itself
  // only treats entries under 7 days old as "new".
  const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000
  const recentlyAdded = (store.get('recentlyAdded') || []).filter((r) => Date.now() - r.addedAt < THIRTY_DAYS)
  recentlyAdded.push({ path: destPath, addedAt: Date.now() })
  store.set('recentlyAdded', recentlyAdded)

  return entry
}

// Copies one already-on-disk source file (a dropped local file picked in the
// desktop app) into the right library folder, and records it. Never
// deletes/moves the source.
function importUploadedFile(srcPath, originalName, uploadedBy) {
  const plan = planUploadDest(originalName)
  if (!plan.ok) return { ok: false, fileName: originalName, error: plan.error }
  try {
    fs.copyFileSync(srcPath, plan.destPath)
    recordUploadEntry({ fileName: originalName, kind: plan.kind, showName: plan.showName, destPath: plan.destPath, uploadedBy })
    return { ok: true, fileName: originalName, kind: plan.kind, showName: plan.showName, destPath: plan.destPath }
  } catch (err) {
    return { ok: false, fileName: originalName, error: String(err) }
  }
}

ipcMain.handle('upload:importFiles', (_e, files, uploadedBy) => {
  if (!Array.isArray(files)) return []
  return files.map((f) => importUploadedFile(f.path, f.name, uploadedBy))
})

// --- The old "New files drop folder" ----------------------------------------
// Merged into the Beebo Inbox below: one folder, watched all the time. A drop
// folder someone had already set is adopted as the Inbox once
// (inbox.migrateLegacyDropFolder). What is left here keeps the old entry points
// working: every library rescan nudges the Inbox to look (without waiting on
// it, so a rescan never waits on a TMDB lookup), and the "import now" IPC is
// the Inbox's "Sort now".
function importNewFiles() {
  try { if (beeboInbox) beeboInbox.scanOnce().catch(() => {}) } catch (e) {}
  return Promise.resolve({ ok: true, imported: [], skipped: [] })
}

ipcMain.handle('library:importNewFiles', async () => {
  if (!beeboInbox) return { ok: false, error: 'inbox_not_running', imported: [], skipped: [] }
  const inbox = await beeboInbox.sortNow()
  return { ok: true, imported: [], skipped: [], inbox }
})

// --- The Beebo Inbox (electron/inbox.js) ----------------------------------------
// "A folder we put our videos in, and Beebo sorts them into their correct
// folders." It replaced the older "New files drop folder": it is watched all the time, waits for copies to finish,
// identifies each video with the shared parser + TMDB matcher, renames it
// tidily, and sends anything it is not sure about to "Titles to check".
let beeboInbox = null
const INBOX_FOLDER_NAME = 'Beebo Inbox'

// Default: "Beebo Inbox" next to the first Movies folder, on the same drive,
// so a move into the library is an instant rename rather than a copy.
function getInboxDir() {
  const chosen = store.get('inboxDir')
  if (chosen) return chosen
  const movies = getMoviesDir()
  if (!movies) return ''
  return path.join(path.dirname(path.resolve(movies)), INBOX_FOLDER_NAME)
}

let inboxTvManifest = { at: 0, cacheDir: '', data: null }
function inboxTvIdOfShow(display, folderName) {
  const cacheDir = getTmdbCacheDir()
  if (!cacheDir) return null
  if (inboxTvManifest.cacheDir !== cacheDir || Date.now() - inboxTvManifest.at > 30000) {
    let data = null
    try { data = tmdbCache.getTvManifest(cacheDir) } catch (e) {}
    inboxTvManifest = { at: Date.now(), cacheDir, data }
  }
  const m = inboxTvManifest.data
  if (!m) return null
  for (const name of [display, folderName]) {
    const lc = String(name || '').toLowerCase()
    if (!lc) continue
    for (const key of [lc, catalog.encodeId(lc)]) {
      const row = m[key]
      if (row && row.id) return row.id
    }
  }
  return null
}

// After a file is filed: its NEW badge, and for a film matched through TMDB the
// manifest row + poster, so it shows with artwork straight away (the same
// write-through a search does). TV posters come from the usual show lookup.
// Tells open Movies / TV Shows screens that the Inbox just filed something, so they re-read the
// library instead of waiting for Rescan. Coalesced: a batch of 20 files is one refresh, 2.5s after
// the last move (Owner, 2026-09-16: House episodes sorted in while TV Shows was open never showed).
let libraryChangedTimer = null
function notifyLibraryChanged(kind) {
  if (libraryChangedTimer) clearTimeout(libraryChangedTimer)
  const kinds = (notifyLibraryChanged.kinds = notifyLibraryChanged.kinds || new Set())
  kinds.add(kind === 'episode' ? 'tv' : 'movies')
  libraryChangedTimer = setTimeout(() => {
    libraryChangedTimer = null
    const payload = { kinds: Array.from(kinds) }
    kinds.clear()
    try {
      for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('library:changed', payload)
    } catch (e) {}
  }, 2500)
}

async function inboxAfterSort(info) {
  notifyLibraryChanged(info && info.kind)
  try {
    recordUploadEntry({
      fileName: info.fileName,
      kind: info.kind === 'episode' ? 'tv' : 'movie',
      showName: info.showName || null,
      destPath: info.path,
      uploadedBy: 'Beebo Inbox'
    })
  } catch (e) {}
  const cacheDir = getTmdbCacheDir()
  if (!cacheDir || info.kind !== 'film' || !info.tmdb || info.tmdbKind !== 'movie') return
  try {
    const paths = tmdbCache.ensureDirs(cacheDir)
    const manifest = tmdbCache.getManifest(cacheDir)
    manifest[info.fileName] = info.tmdb
    tmdbCache.writeJson(paths.manifestFile, manifest)
    if (info.tmdb.poster_path) {
      const posterFile = path.join(paths.postersDir, `${info.tmdb.id}.jpg`)
      if (!fs.existsSync(posterFile)) await tmdbCache.downloadImage(`https://image.tmdb.org/t/p/w300${info.tmdb.poster_path}`, posterFile)
    }
  } catch (e) {
    console.warn('[inbox] poster step skipped:', e.message)
  }
}

function createBeeboInbox() {
  const inboxModule = require('./inbox')
  // Someone who already had the old drop folder set keeps using it, as the Inbox.
  try {
    const moved = inboxModule.migrateLegacyDropFolder(store, {
      legacyDefaults: [process.env.NEW_FILES_DIR, 'D:\\Beebo\\NewFiles', 'D:\\MovieAPP\\NewFiles'].filter(Boolean)
    })
    if (moved.migrated) console.log('[inbox] using the old drop folder as the Beebo Inbox:', moved.dir)
  } catch (e) {}
  return inboxModule.createInbox({
    store,
    getInboxDir,
    getMoviesDir,
    getTvShowsDir,
    getAllMoviesDirs,
    getAllTvShowsDirs,
    getTmdbApi: () => titleMatch.createTmdbApi(store.get('tmdbApiKey') || process.env.TMDB_API_KEY),
    tvIdOfShow: inboxTvIdOfShow,
    undoLogPath: path.join(app.getPath('userData'), 'beebo-inbox-undo.jsonl'),
    // Only make the default folder once the owner actually has a Movies folder.
    createFolderIf: () => { try { return !!store.get('inboxDir') || fs.existsSync(getMoviesDir()) } catch (e) { return false } },
    onSorted: inboxAfterSort,
    openFolder: async (dir) => {
      if (!dir) return { ok: false, error: 'No Inbox folder is set.' }
      try { fs.mkdirSync(dir, { recursive: true }) } catch (e) {}
      const err = await shell.openPath(dir)
      return err ? { ok: false, error: err } : { ok: true }
    },
    notify: ({ title, body }) => {
      try { if (Notification && Notification.isSupported()) new Notification({ title, body }).show() } catch (e) {}
    },
    onChange: () => {
      try {
        for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('inbox:changed')
      } catch (e) {}
    },
    log: (m) => console.log('[inbox]', m)
  })
}

const inboxOr = (fn) => async (...args) => {
  if (!beeboInbox) return { ok: false, error: 'Inbox is not running yet.' }
  try { return await fn(...args) } catch (e) { return { ok: false, error: String(e && e.message) } }
}
ipcMain.handle('inbox:status', inboxOr(() => beeboInbox.status()))
ipcMain.handle('inbox:sortNow', inboxOr(() => beeboInbox.sortNow()))
ipcMain.handle('inbox:setPaused', inboxOr((_e, paused) => beeboInbox.setPaused(!!paused)))
ipcMain.handle('inbox:setEnabled', inboxOr((_e, enabled) => beeboInbox.setEnabled(!!enabled)))
ipcMain.handle('inbox:undoLast', inboxOr(() => beeboInbox.undoLast()))
ipcMain.handle('inbox:putBack', inboxOr((_e, undoId) => beeboInbox.putBack(String(undoId || ''))))
ipcMain.handle('inbox:fileAs', inboxOr((_e, id, choice) => beeboInbox.fileAs(String(id || ''), choice || {})))
ipcMain.handle('inbox:retry', inboxOr((_e, id) => beeboInbox.retry(String(id || ''))))
ipcMain.handle('inbox:openFolder', inboxOr(() => beeboInbox.openFolder()))
ipcMain.handle('inbox:pickFolder', inboxOr(async () => {
  const res = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
  if (res.canceled || !res.filePaths[0]) return beeboInbox.status()
  store.set('inboxDir', res.filePaths[0])
  beeboInbox.reconfigure()
  return beeboInbox.status()
}))

ipcMain.handle('upload:history', () => store.get('uploadHistory') || [])
ipcMain.handle('upload:clearHistory', (_e, ids) => require('./uploadHistory').clearUploadHistory(store, ids))

ipcMain.handle('upload:deleteEntry', (_e, id) => {
  const uploadHistory = store.get('uploadHistory') || []
  const entry = uploadHistory.find((e) => e.id === id)
  if (!entry) return { ok: false, error: 'not_found' }
  // Same managed-folders guardrail as the regular file:delete handler.
  const resolved = path.resolve(entry.destPath)
  const allowedRoots = [...getAllMoviesDirs(), ...getAllTvShowsDirs()].filter(Boolean).map((d) => path.resolve(d))
  const isAllowed = allowedRoots.some((root) => resolved === root || resolved.startsWith(root + path.sep))
  if (isAllowed) {
    try {
      if (fs.existsSync(resolved)) fs.unlinkSync(resolved)
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  }
  store.set('uploadHistory', uploadHistory.filter((e) => e.id !== id))
  return { ok: true }
})

// Returns paths added within the last 7 days — used by Movies.jsx/TVShows.jsx
// to show the NEW badge. Self-expiring: nothing needs to actively delete old
// entries, they just fall out of this filtered result after a week.
ipcMain.handle('upload:recentlyAdded', () => {
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000
  const recentlyAdded = store.get('recentlyAdded') || []
  return recentlyAdded.filter((r) => Date.now() - r.addedAt < SEVEN_DAYS)
})

// TMDB issues two kinds of credentials that both work for read endpoints:
//  - v3 "API Key": a short alphanumeric string -> passed as ?api_key=
//  - v4 "Read Access Token": a long JWT (three dot-separated segments) -> passed as a Bearer header
function tmdbAuth(key) {
  const isV4Token = key.split('.').length === 3
  return {
    isV4Token,
    headers: isV4Token ? { Authorization: `Bearer ${key}`, accept: 'application/json' } : { accept: 'application/json' }
  }
}

// Beebo's own copy of a chosen poster / backdrop (an override or a sidecar picture), as an address the window can load.
function customArtAddress(pathValue) {
  const url = metadataOverrides.customArtUrl(pathValue)
  return url ? `http://localhost:${STREAM_PORT}${url}` : null
}

function withLocalPoster(result) {
  if (!result) return result
  const cacheDir = getTmdbCacheDir()
  const local = tmdbCache.localPosterPath(cacheDir, result.id)
  // Served over the local stream server, not a file:// link — Chromium blocks
  // file:// image loads from a page whose own origin is http:// (which this
  // renderer is, both in dev at localhost:5173 and once packaged), so a
  // file:// src here would just silently fail to load.
  return {
    ...result,
    localPosterPath: customArtAddress(result.poster_path) || (local ? `http://localhost:${STREAM_PORT}/media/poster/${result.id}.jpg` : null),
    localBackdropPath: customArtAddress(result.backdrop_path)
  }
}

// The desktop grid and the show page read TMDB answers through these channels; the merge point
// (metadataMerge.js: translation, .nfo, sidecar pictures, the owner's edits) is applied on the way out.
function mergeMovieResult(entry, fileName) {
  if (!fileName) return entry
  return withLocalPoster(metadataMerge.mergeMovie(entry || null, { cacheDir: getTmdbCacheDir(), fileName }))
}
function mergeShowResult(entry, showKey) {
  if (!showKey) return entry
  return withLocalTvPoster(metadataMerge.mergeShow(entry || null, { cacheDir: getTmdbCacheDir(), showKey }))
}
function handleMerged(channel, mergeFn, handler) {
  ipcMain.handle(channel, async (event, args) => mergeFn(await handler(event, args || {}), args || {}))
}
const mergeMovieSearch = (res, args) => {
  if (!res || !Array.isArray(res.results) || !args.fileName) return res
  const first = mergeMovieResult(res.results[0] || null, args.fileName)
  return { ...res, results: first ? [first, ...res.results.slice(1)] : res.results }
}
const mergeMovieConfirm = (res, args) => (res && res.result ? { ...res, result: mergeMovieResult(res.result, args.fileName) } : res)
const mergeShowSearch = (res, args) => (res && 'result' in res && !res.error && args.showKey ? { ...res, result: mergeShowResult(res.result, args.showKey) } : res)
const mergeShowConfirm = (res, args) => (res && res.result ? { ...res, result: mergeShowResult(res.result, args.showKey) } : res)

// Fetches the US content rating/certification for a movie or TV show — TMDB's
// search results don't include this, it's always a separate lookup. Result
// gets attached onto the cached manifest entry (as `certification`) so it's
// only ever fetched once per title, same as the poster.
async function fetchMovieCertification(movieId, key, headers, isV4Token) {
  try {
    const url = isV4Token
      ? `https://api.themoviedb.org/3/movie/${movieId}/release_dates`
      : `https://api.themoviedb.org/3/movie/${movieId}/release_dates?api_key=${key}`
    const res = await fetch(url, { headers })
    if (!res.ok) return null
    const data = await res.json()
    const us = (data.results || []).find((r) => r.iso_3166_1 === 'US')
    const withCert = (us?.release_dates || []).find((rd) => rd.certification)
    return withCert?.certification || null
  } catch {
    return null
  }
}

async function fetchTvCertification(tvId, key, headers, isV4Token) {
  try {
    const url = isV4Token
      ? `https://api.themoviedb.org/3/tv/${tvId}/content_ratings`
      : `https://api.themoviedb.org/3/tv/${tvId}/content_ratings?api_key=${key}`
    const res = await fetch(url, { headers })
    if (!res.ok) return null
    const data = await res.json()
    const us = (data.results || []).find((r) => r.iso_3166_1 === 'US')
    return us?.rating || null
  } catch {
    return null
  }
}

async function movieSearchOnce(query, year, headers, isV4Token, key) {
  const yearParam = year ? `&year=${encodeURIComponent(year)}` : ''
  const url = isV4Token
    ? `https://api.themoviedb.org/3/search/movie?query=${encodeURIComponent(query)}${yearParam}`
    : `https://api.themoviedb.org/3/search/movie?api_key=${key}&query=${encodeURIComponent(query)}${yearParam}`
  const res = await fetch(url, { headers })
  if (!res.ok) return { ok: false, status: res.status }
  const data = await res.json()
  return { ok: true, results: data.results || [] }
}

// Tries with the year first (disambiguates short/common titles — otherwise a
// query like "blade" can come back as "Blade II" instead of "Blade"), then
// falls back to the plain title if that comes up empty.
async function searchMovieSmart(query, year, key, headers, isV4Token) {
  if (year) {
    const r1 = await movieSearchOnce(query, year, headers, isV4Token, key)
    if (!r1.ok) return r1
    if (r1.results.length) return r1
  }
  return movieSearchOnce(query, null, headers, isV4Token, key)
}

const ROMAN_NUMERALS = { i: '1', ii: '2', iii: '3', iv: '4', v: '5', vi: '6', vii: '7', viii: '8', ix: '9', x: '10' }

// Normalizes for comparison only (not for the actual TMDB query) — lowercase,
// punctuation collapsed to spaces, and small roman numerals converted to
// digits, so "Jurassic Park III" and "Jurassic Park 3" are recognized as the
// same title even though TMDB's search wouldn't otherwise treat them as one.
function normalizeTitle(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => ROMAN_NUMERALS[w] || w)
    .join(' ')
}

// TMDB's search endpoint sorts by popularity, not by how well a result actually
// matches the query. This used to be "exact normalised title || results[0]",
// and the `|| results[0]` is what put a 2026 animated short with zero votes on
// a file whose name TMDB could make nothing of.
//
// It now delegates to the shared scorer, but keeps its old signature and its old
// promise (return the best result, or null) for the handful of callers that just
// want an ordering. Anything that WRITES a match must go through
// titleMatch.matchParsed/applyVerdict instead, so that "we are not sure" is
// carried to the caller rather than collapsed into a result.
function pickBestMatch(query, results, year) {
  if (!results || !results.length) return null
  const ranked = titleMatch.rankCandidates(query, year || null, titleMatch.toCandidates(results, 'movie'))
  if (!ranked.length) return null
  return ranked[0].raw
}

handleMerged('tmdb:search', mergeMovieSearch, async (_e, { query, fileName, year, forceRefresh } = {}) => {
  const cacheDir = getTmdbCacheDir()

  // A decision the owner made by hand outranks the cache, the scorer and the
  // force flag alike. "Not a film" is an answer too: it means stop asking.
  const decision = fileName ? titleMatch.getDecision(store, fileName) : null
  if (decision) {
    if (decision.notAMovie || decision.kind === 'none' || decision.kind === 'tv') return { results: [] }
    const manifest = tmdbCache.getManifest(cacheDir)
    const held = manifest[fileName]
    if (held && held.id === decision.tmdbId) return { results: [withLocalPoster(held)] }
    // The decision stands but its cached row has gone (cache folder moved,
    // cleared, or copied in from another machine). Re-fetch the exact id the
    // owner chose. It must NOT fall through to a search: a search could return a
    // different film and would silently undo his answer. If the re-fetch fails
    // — no key, no internet — this answers with nothing rather than a guess.
    const repairKey = store.get('tmdbApiKey') || process.env.TMDB_API_KEY
    const repaired = await titleMatch.fetchById(titleMatch.createTmdbApi(repairKey), 'movie', decision.tmdbId)
    if (repaired && cacheDir) {
      const paths = tmdbCache.ensureDirs(cacheDir)
      manifest[fileName] = repaired
      tmdbCache.writeJson(paths.manifestFile, manifest)
      if (repaired.poster_path) {
        await tmdbCache.downloadImage(`https://image.tmdb.org/t/p/w300${repaired.poster_path}`, path.join(paths.postersDir, `${repaired.id}.jpg`))
      }
    }
    return { results: repaired ? [withLocalPoster(repaired)] : [] }
  }

  // Cached first — this is what makes offline mode work: once a fileName has been
  // looked up, we never touch the network for it again.
  //
  // `shouldLookUp` replaces the old `fileName in manifest` test for one reason:
  // a cached `null` used to count as an answer, so 267 of this library's files
  // were permanently stuck on "no match". A null now means "nobody has answered
  // this yet" and is re-evaluated once; whatever that re-run produces (a match,
  // or a review-queue entry) is then a state this skips, so it cannot loop.
  if (fileName && !forceRefresh) {
    const manifest = tmdbCache.getManifest(cacheDir)
    if (!titleMatch.shouldLookUp(store, fileName, manifest, false) && fileName in manifest) {
      let cached = manifest[fileName]
      // Older cache entries (saved before certification lookups existed) won't
      // have this field yet — backfill it once, then persist so it's free
      // from here on, same as a fresh entry.
      if (cached && cached.certification === undefined) {
        const key = store.get('tmdbApiKey') || process.env.TMDB_API_KEY
        if (key) {
          const { headers, isV4Token } = tmdbAuth(key)
          cached = { ...cached, certification: await fetchMovieCertification(cached.id, key, headers, isV4Token) }
          manifest[fileName] = cached
          tmdbCache.writeJson(tmdbCache.paths(cacheDir).manifestFile, manifest)
        }
      }
      return { results: cached ? [withLocalPoster(cached)] : [] }
    }
  }

  const key = store.get('tmdbApiKey') || process.env.TMDB_API_KEY
  if (!key) return { error: 'no_api_key' }

  const { headers, isV4Token } = tmdbAuth(key)

  try {
    // The shared matcher, not a bare search: it uses an IMDb id in the filename
    // when there is one, sends a TV search for an episode file, and ranks the
    // year instead of filtering on it.
    const api = titleMatch.createTmdbApi(key)
    const parsed = fileName ? metadataMerge.enrichParsed(fileName, titleParse.parseMovieTitle(fileName)) : { title: query, year: year || null, imdbId: null, episode: null }
    if (query) parsed.title = query // an explicit query (a manual override, a re-search) wins over the parse
    if (year) parsed.year = year
    const verdict = await titleMatch.matchParsed(parsed, api)

    const manifest = fileName && cacheDir ? tmdbCache.getManifest(cacheDir) : {}
    const previous = fileName ? manifest[fileName] || null : null
    // Only `certain` and `probable` are written. Anything `unsure`, and anything
    // TMDB had no answer for at all, goes on the review list instead — an
    // unsure match looks finished and is therefore never noticed, which is worse
    // than a file that plainly has no poster yet.
    const applied = fileName ? titleMatch.applyVerdict(store, fileName, verdict, previous) : { accepted: !!verdict.match, match: verdict.match }
    let match = applied.accepted && verdict.match ? verdict.match.raw : applied.match || null
    if (match && applied.accepted) match = { ...match, certification: await fetchMovieCertification(match.id, key, headers, isV4Token) }

    const rawCandidates = (verdict.candidates || []).map((c) => c.raw)
    // Put the picked match first so callers that just read results[0] (the
    // common case) still get the right one even when it wasn't TMDB's top hit.
    const results = (match ? [match, ...rawCandidates.filter((r) => r.id !== match.id)] : rawCandidates).map(withLocalPoster)

    // Write straight into the offline cache as soon as this movie is looked
    // up — not just when "Download all TMDB info" is run — so a newly added
    // movie's poster is already saved to disk the first time it's scanned,
    // and every scan after that is free (no repeat network call).
    if (fileName && cacheDir) {
      const paths = tmdbCache.ensureDirs(cacheDir)
      manifest[fileName] = match || null
      tmdbCache.writeJson(paths.manifestFile, manifest)
      if (match?.poster_path) {
        const posterFile = path.join(paths.postersDir, `${match.id}.jpg`)
        await tmdbCache.downloadImage(`https://image.tmdb.org/t/p/w300${match.poster_path}`, posterFile)
      }
      if (applied.queued) await cacheReviewPosters(paths, verdict.candidates)
    }

    return { results }
  } catch (err) {
    return { error: String(err) }
  }
})

// Pulls the posters for the top few candidates of a queued file down to disk at
// the moment the file is queued — which is a moment we demonstrably have
// internet, because we just called TMDB.
//
// WHY NOT JUST POINT THE ADMIN PAGE AT image.tmdb.org: the whole app is built to
// run with no internet from this cache (the "it's going in a cabin" case), and a
// review page whose thumbnails are remote would be a blank grid of broken images
// exactly when the owner is sitting down to fix his library. It would also mean
// every admin browser talking to TMDB directly, which tells TMDB the contents of
// his library from every device he reviews on. They go into the SAME posters/
// folder at the SAME w300 size the confirmed posters use, so the existing
// /media/poster/<id>.jpg route serves them with no new route and no new cache,
// and confirming a candidate needs no download at all — the poster is already
// there. Top 3 only, to bound the disk cost.
const REVIEW_POSTER_PREFETCH = 3
async function cacheReviewPosters(paths, candidates) {
  for (const c of (candidates || []).slice(0, REVIEW_POSTER_PREFETCH)) {
    if (!c || !c.posterPath || c.kind === 'tv') continue
    try {
      await tmdbCache.downloadImage(`https://image.tmdb.org/t/p/w300${c.posterPath}`, path.join(paths.postersDir, `${c.id}.jpg`))
    } catch {
      // a missing thumbnail must never stop a file being queued for review
    }
  }
}

// Commits a specific TMDB movie a person picked by hand (from the "which
// movie did you mean?" picker) straight into the cache — no search involved,
// since the picking already happened client-side.
handleMerged('tmdb:confirmMatch', mergeMovieConfirm, async (_e, { fileName, movie } = {}) => {
  const cacheDir = getTmdbCacheDir()
  if (!fileName || !movie) return { ok: false }
  // Record it as a decision as well as a cache entry. Writing only the manifest
  // (which is what this did) meant the next "Re-check all movie matches" could
  // quietly overwrite a match the owner had picked by hand — and this library
  // contains several that could only have come from a person, such as the file
  // named "4nch0rm4niiwb72G" sitting on Anchorman. A decision is never re-guessed.
  titleMatch.confirmMatch(store, fileName, {
    kind: 'movie',
    id: movie.id,
    title: movie.title || movie.original_title || '',
    year: Number(String(movie.release_date || '').slice(0, 4)) || null
  }, 'desktop')
  titleMatch.dequeueReview(store, fileName)
  let full = movie
  const key = store.get('tmdbApiKey') || process.env.TMDB_API_KEY
  if (key) {
    const { headers, isV4Token } = tmdbAuth(key)
    full = { ...movie, certification: await fetchMovieCertification(movie.id, key, headers, isV4Token) }
  }
  if (cacheDir) {
    const paths = tmdbCache.ensureDirs(cacheDir)
    const manifest = tmdbCache.getManifest(cacheDir)
    manifest[fileName] = full
    tmdbCache.writeJson(paths.manifestFile, manifest)
    if (full.poster_path) {
      const posterFile = path.join(paths.postersDir, `${full.id}.jpg`)
      await tmdbCache.downloadImage(`https://image.tmdb.org/t/p/w300${full.poster_path}`, posterFile)
    }
  }
  return { ok: true, result: withLocalPoster(full) }
})

// Mirrors the grouping logic in TVShows.jsx / streamServer.js — needed here so
// the offline prefetch can figure out unique show names from scanned files
// the same way the TV Shows tab does (folder-name-first, filename fallback).
// These used to be defined here and again in streamServer.js, with small
// unintended differences between the copies. They delegate to ./titleParse now
// so the offline prefetch, the live search and the web player all agree on what
// a file is called. Names are unchanged - the TV grouping helpers below and the
// library/rename IPC handlers call them by name.
function cleanText(raw) {
  return titleParse.cleanText(raw)
}

function stripLeadingId(raw) {
  return titleParse.stripLeadingId(raw)
}

// main.js's historical variant tolerates the year being wrapped in
// parens/brackets at the very end ("Show Name (2026)"); streamServer.js's does
// not. Both are exported from the module and each caller keeps the one it had,
// because each side's TV show grouping keys off its own behaviour.
function extractTrailingYear(raw) {
  return titleParse.extractTrailingYearLoose(raw)
}

function stripQualityTags(raw) {
  return titleParse.stripQualityTags(raw)
}

const SCENE_TAGS = titleParse.SCENE_TAGS

function stripSceneTags(raw) {
  return titleParse.stripSceneTags(raw)
}

const EDITION_TAGS = titleParse.EDITION_TAGS

function stripEditionTags(raw) {
  return titleParse.stripEditionTags(raw)
}

function cutAtYear(raw) {
  return titleParse.cutAtYear(raw)
}

// Accepts a name with or without its extension. Callers here pass an
// already-extension-stripped name; the module peels any remaining ones itself,
// which is what finally handles "Independence Day (1996) mkv.mkv".
function parseMovieName(fileNameNoExt) {
  return titleParse.parseMovieName(fileNameNoExt)
}

function parseShowFromFileName(fileName) {
  const noExt = fileName.replace(/\.[^./\\]+$/, '')
  let m = noExt.match(/^(.*?)[.\s_-]+[Ss]\d{1,2}[.\s_-]*[Ee]\d{1,3}(.*)$/)
  if (!m) m = noExt.match(/^(.*?)[.\s_-]+\d{1,2}x\d{1,3}(.*)$/)
  if (!m) m = noExt.match(/^(.*?)[.\s_-]+[Ss]eason[.\s_-]?\d{1,2}[.\s_-]+[Ee]pisode[.\s_-]?\d{1,3}(.*)$/i)
  const rawShow = stripLeadingId(stripSceneTags(m ? m[1] : noExt))
  const { rest, year } = extractTrailingYear(rawShow)
  return { show: cleanText(rest) || rawShow || noExt, year }
}

function groupKeyAndName(relPath, fileName) {
  const parts = relPath.split(/[\\/]/).filter(Boolean)
  if (parts.length > 1) {
    const folderName = parts[0]
    const { rest, year } = extractTrailingYear(stripLeadingId(folderName))
    return { show: cleanText(rest) || folderName.trim(), year }
  }
  return parseShowFromFileName(fileName)
}

function withLocalTvPoster(result) {
  if (!result) return result
  const cacheDir = getTmdbCacheDir()
  const local = tmdbCache.localTvPosterPath(cacheDir, result.id)
  // Every TV match the Shows screen receives passes through here: split combined genres too.
  return {
    ...splitTvMatchGenres(result),
    localPosterPath: customArtAddress(result.poster_path) || (local ? `http://localhost:${STREAM_PORT}/media/poster-tv/${result.id}.jpg` : null),
    localBackdropPath: customArtAddress(result.backdrop_path)
  }
}

async function tvSearchOnce(query, year, headers, isV4Token, key) {
  const yearParam = year ? `&first_air_date_year=${encodeURIComponent(year)}` : ''
  const url = isV4Token
    ? `https://api.themoviedb.org/3/search/tv?query=${encodeURIComponent(query)}${yearParam}`
    : `https://api.themoviedb.org/3/search/tv?api_key=${key}&query=${encodeURIComponent(query)}${yearParam}`
  const res = await fetch(url, { headers })
  if (!res.ok) return { ok: false, status: res.status }
  const data = await res.json()
  return { ok: true, match: data.results?.[0] || null, results: data.results || [] }
}

// Tries a few query variations before giving up — folder/filenames aren't always
// clean enough to match on the first attempt (e.g. a folder literally named
// "Survivor 50" won't match TMDB's "Survivor" until the trailing number is
// stripped). Order: name+year, name alone, name with a trailing season-like
// number removed.
async function searchTvSmart(query, year, key, headers, isV4Token) {
  const r1 = await tvSearchOnce(query, year, headers, isV4Token, key)
  if (!r1.ok) return r1
  if (r1.match) return r1

  if (year) {
    const r2 = await tvSearchOnce(query, null, headers, isV4Token, key)
    if (!r2.ok) return r2
    if (r2.match) return r2
  }

  const trailingNum = query.match(/^(.*?)\s+\d{1,3}$/)
  if (trailingNum) {
    const r3 = await tvSearchOnce(trailingNum[1], year, headers, isV4Token, key)
    if (r3.ok && r3.match) return r3
  }

  return { ok: true, match: null }
}

// TV show lookup, keyed by cleaned show name (not per-episode) — one lookup per
// show, cached to disk the first time so re-scans and offline use don't re-hit
// TMDB. Note: unlike movies, this isn't yet wired into the "Download all TMDB
// info" offline prefetch button — it caches lazily as shows are browsed instead.
handleMerged('tmdb:searchTv', mergeShowSearch, async (_e, { query, showKey, year, altQuery, forceRefresh } = {}) => {
  const cacheDir = getTmdbCacheDir()

  if (showKey && !forceRefresh) {
    const manifest = tmdbCache.getTvManifest(cacheDir)
    if (showKey in manifest) {
      let cached = manifest[showKey]
      if (cached && cached.certification === undefined) {
        const key = store.get('tmdbApiKey') || process.env.TMDB_API_KEY
        if (key) {
          const { headers, isV4Token } = tmdbAuth(key)
          cached = { ...cached, certification: await fetchTvCertification(cached.id, key, headers, isV4Token) }
          manifest[showKey] = cached
          tmdbCache.writeJson(tmdbCache.paths(cacheDir).tvManifestFile, manifest)
        }
      }
      return { result: cached ? withLocalTvPoster(cached) : null }
    }
  }

  const key = store.get('tmdbApiKey') || process.env.TMDB_API_KEY
  if (!key) return { error: 'no_api_key' }

  const { headers, isV4Token } = tmdbAuth(key)

  try {
    let result = await searchTvSmart(query, year, key, headers, isV4Token)
    if (!result.ok) return { error: `tmdb_http_${result.status}` }
    // Folder names aren't always the real title (typos, worded slightly
    // differently than TMDB, etc) — if the primary query came up empty, try
    // the filename-derived title before giving up.
    if (!result.match && altQuery) {
      const altResult = await searchTvSmart(altQuery, year, key, headers, isV4Token)
      if (altResult.ok && altResult.match) result = altResult
    }
    let match = result.match
    if (match) match = { ...match, certification: await fetchTvCertification(match.id, key, headers, isV4Token) }

    if (showKey && cacheDir) {
      const paths = tmdbCache.ensureDirs(cacheDir)
      const manifest = tmdbCache.getTvManifest(cacheDir)
      manifest[showKey] = match
      tmdbCache.writeJson(paths.tvManifestFile, manifest)
      if (match?.poster_path) {
        const posterFile = path.join(paths.tvPostersDir, `${match.id}.jpg`)
        await tmdbCache.downloadImage(`https://image.tmdb.org/t/p/w300${match.poster_path}`, posterFile)
      }
    }

    return { result: match ? withLocalTvPoster(match) : null }
  } catch (err) {
    return { error: String(err) }
  }
})

// Plain multi-result TV search for the "which show did you mean?" picker —
// unlike tmdb:searchTv above, this doesn't touch the cache or try to guess a
// single best match; it just hands back candidates (with posters) for a
// person to choose from directly.
ipcMain.handle('tmdb:searchTvMulti', async (_e, { query, year } = {}) => {
  const key = store.get('tmdbApiKey') || process.env.TMDB_API_KEY
  if (!key) return { error: 'no_api_key' }
  const { headers, isV4Token } = tmdbAuth(key)
  try {
    const result = await tvSearchOnce(query, year, headers, isV4Token, key)
    if (!result.ok) return { error: `tmdb_http_${result.status}` }
    return { results: (result.results || []).map(withLocalTvPoster) }
  } catch (err) {
    return { error: String(err) }
  }
})

// Commits a specific TMDB show a person picked by hand (from the "which show
// did you mean?" picker) straight into the cache — no search involved, since
// the picking already happened client-side.
handleMerged('tmdb:confirmMatchTv', mergeShowConfirm, async (_e, { showKey, show } = {}) => {
  const cacheDir = getTmdbCacheDir()
  if (!showKey || !show) return { ok: false }
  let full = show
  const key = store.get('tmdbApiKey') || process.env.TMDB_API_KEY
  if (key) {
    const { headers, isV4Token } = tmdbAuth(key)
    full = { ...show, certification: await fetchTvCertification(show.id, key, headers, isV4Token) }
  }
  if (cacheDir) {
    const paths = tmdbCache.ensureDirs(cacheDir)
    const manifest = tmdbCache.getTvManifest(cacheDir)
    manifest[showKey] = full
    tmdbCache.writeJson(paths.tvManifestFile, manifest)
    if (full.poster_path) {
      const posterFile = path.join(paths.tvPostersDir, `${full.id}.jpg`)
      await tmdbCache.downloadImage(`https://image.tmdb.org/t/p/w300${full.poster_path}`, posterFile)
    }
  }
  return { ok: true, result: withLocalTvPoster(full) }
})

// Season episode counts, for the "show missing episodes" checkbox — lets us tell
// the difference between "you have every episode you own" and "you have every
// episode that exists." In-memory only (needs live internet to check anyway, so
// there's no offline case to support here).
const seasonInfoCache = new Map()

ipcMain.handle('tmdb:tvSeasonInfo', async (_e, { tvId, season } = {}) => {
  if (!tvId || season === null || season === undefined) return { episodes: [] }
  const cacheKey = `${tvId}-${season}`
  if (seasonInfoCache.has(cacheKey)) return { episodes: seasonInfoCache.get(cacheKey) }

  const key = store.get('tmdbApiKey') || process.env.TMDB_API_KEY
  if (!key) return { episodes: [], error: 'no_api_key' }

  const { headers, isV4Token } = tmdbAuth(key)
  const url = isV4Token
    ? `https://api.themoviedb.org/3/tv/${tvId}/season/${season}`
    : `https://api.themoviedb.org/3/tv/${tvId}/season/${season}?api_key=${key}`

  try {
    const res = await fetch(url, { headers })
    if (!res.ok) { seasonInfoCache.set(cacheKey, []); return { episodes: [] } }
    const data = await res.json()
    const episodes = (data.episodes || []).map((e) => ({ episode_number: e.episode_number, name: e.name }))
    seasonInfoCache.set(cacheKey, episodes)
    return { episodes }
  } catch (err) {
    return { episodes: [], error: String(err) }
  }
})

// Full season list for a show (season numbers + episode counts), used to
// detect seasons the user owns zero episodes of (e.g. Season 4 when only 3
// and 5 are on disk) — the per-season episode endpoint alone can't tell us
// that a season exists at all if we never ask about it.
const tvShowSeasonsCache = new Map()

ipcMain.handle('tmdb:tvShowSeasons', async (_e, tvId) => {
  if (!tvId) return { seasons: [] }
  if (tvShowSeasonsCache.has(tvId)) return { seasons: tvShowSeasonsCache.get(tvId) }

  const key = store.get('tmdbApiKey') || process.env.TMDB_API_KEY
  if (!key) return { seasons: [], error: 'no_api_key' }

  const { headers, isV4Token } = tmdbAuth(key)
  const url = isV4Token
    ? `https://api.themoviedb.org/3/tv/${tvId}`
    : `https://api.themoviedb.org/3/tv/${tvId}?api_key=${key}`

  try {
    const res = await fetch(url, { headers })
    if (!res.ok) { tvShowSeasonsCache.set(tvId, []); return { seasons: [] } }
    const data = await res.json()
    const seasons = (data.seasons || [])
      .filter((s) => s.season_number > 0)
      .map((s) => ({ season_number: s.season_number, episode_count: s.episode_count, name: s.name, air_date: s.air_date }))
    tvShowSeasonsCache.set(tvId, seasons)
    return { seasons }
  } catch (err) {
    return { seasons: [], error: String(err) }
  }
})

// Movie collection lookups, for the "check for missing sequels" checkbox. Two
// TMDB calls per new movie the first time it's checked: movie details (to learn
// its belongs_to_collection) then the collection itself (to list every part).
// Both cached in-memory for the app session so re-toggling the checkbox is free.
const movieCollectionCache = new Map()
const collectionDetailsCache = new Map()
// The film's main production company, from the same /movie/{id} details that name its collection. It
// feeds the Movies screen's "Group by studio" view, so it rides along on this reply (in memory only).
const movieStudioCache = new Map()

ipcMain.handle('tmdb:movieCollection', async (_e, movieId) => {
  if (!movieId) return { collection: null }
  if (movieCollectionCache.has(movieId)) return { collection: movieCollectionCache.get(movieId), studio: movieStudioCache.get(movieId) || '' }

  const key = store.get('tmdbApiKey') || process.env.TMDB_API_KEY
  if (!key) return { collection: null, error: 'no_api_key' }

  const { headers, isV4Token } = tmdbAuth(key)

  try {
    const detailsUrl = isV4Token
      ? `https://api.themoviedb.org/3/movie/${movieId}`
      : `https://api.themoviedb.org/3/movie/${movieId}?api_key=${key}`
    const detailsRes = await fetch(detailsUrl, { headers })
    if (!detailsRes.ok) { movieCollectionCache.set(movieId, null); return { collection: null, studio: '' } }
    const details = await detailsRes.json()
    const studio = String((details.production_companies || []).find((c) => c && c.name)?.name || '').slice(0, 80)
    movieStudioCache.set(movieId, studio)
    const collectionRef = details.belongs_to_collection
    if (!collectionRef) { movieCollectionCache.set(movieId, null); return { collection: null, studio } }

    if (collectionDetailsCache.has(collectionRef.id)) {
      const cached = collectionDetailsCache.get(collectionRef.id)
      movieCollectionCache.set(movieId, cached)
      return { collection: cached, studio }
    }

    const collectionUrl = isV4Token
      ? `https://api.themoviedb.org/3/collection/${collectionRef.id}`
      : `https://api.themoviedb.org/3/collection/${collectionRef.id}?api_key=${key}`
    const collectionRes = await fetch(collectionUrl, { headers })
    if (!collectionRes.ok) { movieCollectionCache.set(movieId, null); return { collection: null } }
    const collectionData = await collectionRes.json()
    const collection = {
      id: collectionData.id,
      name: collectionData.name,
      parts: (collectionData.parts || []).map((p) => ({ id: p.id, title: p.title, release_date: p.release_date || null }))
    }
    collectionDetailsCache.set(collectionRef.id, collection)
    movieCollectionCache.set(movieId, collection)
    return { collection, studio }
  } catch (err) {
    return { collection: null, error: String(err) }
  }
})

// "What else has this person been in?" — powers the missing-credits section in
// the By Actor views on both the Movies and TV Shows screens. TMDB's
// combined_credits is a single call per person covering movies and TV together,
// so an actor costs exactly one request the first time they're opened and
// nothing ever again: cached in memory for the session AND mirrored into
// personCredits.json in the shared TMDB cache dir, the same write-through idea
// the website uses for collections.json. That's what makes the section work on
// a cold launch with no internet at all.
const personCreditsCache = new Map() // String(person id) -> trimmed credits array
let personCreditsDiskLoaded = false

function personCreditsCacheFile(cacheDir) {
  return path.join(cacheDir, 'personCredits.json')
}

function ensurePersonCreditsLoaded(cacheDir) {
  if (personCreditsDiskLoaded || !cacheDir) return
  personCreditsDiskLoaded = true
  const data = tmdbCache.readJson(personCreditsCacheFile(cacheDir))
  for (const [id, credits] of Object.entries(data)) {
    if (Array.isArray(credits)) personCreditsCache.set(id, credits)
  }
}

function persistPersonCredits(cacheDir) {
  try {
    fs.mkdirSync(cacheDir, { recursive: true })
    // The stream server (phone actor page, electron/actorGaps.js) adds people to
    // this same file; merge over what is on disk so neither side drops the other's.
    const onDisk = tmdbCache.readJson(personCreditsCacheFile(cacheDir))
    tmdbCache.writeJson(personCreditsCacheFile(cacheDir), { ...onDisk, ...Object.fromEntries(personCreditsCache) })
  } catch {
    // A failed disk write (full disk, perms, cache dir on an unplugged drive)
    // must never break the view — worst case this person is looked up again on
    // a future launch.
  }
}

ipcMain.handle('tmdb:personCredits', async (_e, personId) => {
  if (!personId) return { credits: null, error: 'no_person' }
  const id = String(personId)

  const cacheDir = getTmdbCacheDir()
  ensurePersonCreditsLoaded(cacheDir)
  if (personCreditsCache.has(id)) return { credits: personCreditsCache.get(id), cached: true }
  // Looked up from a phone since this app loaded the file.
  const fromServer = require('./actorGaps').readCachedPersonCredits(cacheDir, id)
  if (fromServer) {
    personCreditsCache.set(id, fromServer)
    return { credits: fromServer, cached: true }
  }

  const key = store.get('tmdbApiKey') || process.env.TMDB_API_KEY
  if (!key) return { credits: null, error: 'no_api_key' }

  const { headers, isV4Token } = tmdbAuth(key)
  const url = isV4Token
    ? `https://api.themoviedb.org/3/person/${id}/combined_credits`
    : `https://api.themoviedb.org/3/person/${id}/combined_credits?api_key=${key}`

  try {
    const res = await fetch(url, { headers })
    // Deliberately NOT cached on failure (unlike tmdb:movieCollection, which
    // caches null for "this movie has no franchise" — a real answer). A person
    // looked up while offline must be retried the next time there's internet,
    // not remembered as "has no other work".
    if (!res.ok) return { credits: null, error: `http_${res.status}` }
    const data = await res.json()
    // Trimmed to the fields the renderer filters/ranks/draws with — the raw
    // payload for a working actor is a few hundred KB of mostly unused fields,
    // and this file is kept forever.
    // (One trim for both writers of personCredits.json: see electron/actorGaps.js.)
    const credits = require('./actorGaps').trimPersonCredits(data)
    personCreditsCache.set(id, credits)
    if (cacheDir) persistPersonCredits(cacheDir)
    return { credits, cached: false }
  } catch (err) {
    // Offline throws here (DNS/connect failure). Same rule: don't cache it.
    return { credits: null, error: String(err) }
  }
})

const creditsCache = new Map()

ipcMain.handle('tmdb:credits', async (_e, movieId) => {
  if (!movieId) return { cast: [] }

  const cacheDir = getTmdbCacheDir()
  const creditsMap = tmdbCache.getCreditsMap(cacheDir)
  const withLocalPhotos = (cast) =>
    cast.map((c) => {
      const local = tmdbCache.localActorPhotoPath(cacheDir, c.id)
      return { ...c, localPhotoPath: local ? `http://localhost:${STREAM_PORT}/media/actor/${c.id}.jpg` : null }
    })

  if (creditsMap[movieId] && !castCredits.isStaleCast(creditsMap[movieId])) return { cast: withLocalPhotos(creditsMap[movieId]) }
  if (creditsCache.has(movieId) && !castCredits.isStaleCast(creditsCache.get(movieId))) return { cast: withLocalPhotos(creditsCache.get(movieId)) }

  const key = store.get('tmdbApiKey') || process.env.TMDB_API_KEY
  if (!key) return { cast: [] }
  const { headers, isV4Token } = tmdbAuth(key)
  const url = isV4Token
    ? `https://api.themoviedb.org/3/movie/${movieId}/credits`
    : `https://api.themoviedb.org/3/movie/${movieId}/credits?api_key=${key}`

  try {
    const res = await fetch(url, { headers })
    if (!res.ok) {
      creditsCache.set(movieId, [])
      return { cast: [] }
    }
    const data = await res.json()
    const cast = castCredits.parseCast(data)
    creditsCache.set(movieId, cast)

    // Same write-through-cache idea as tmdb:search/tmdb:searchTv — save cast +
    // actor photos to disk the moment they're looked up, not just during a
    // full "Download all" run.
    if (cacheDir) {
      const paths = tmdbCache.ensureDirs(cacheDir)
      const diskCreditsMap = tmdbCache.getCreditsMap(cacheDir)
      diskCreditsMap[movieId] = cast
      tmdbCache.writeJson(paths.creditsFile, diskCreditsMap)
      for (const c of cast) {
        if (!c.profilePath) continue
        const photoFile = path.join(paths.actorsDir, `${c.id}.jpg`)
        await tmdbCache.downloadImage(`https://image.tmdb.org/t/p/w185${c.profilePath}`, photoFile)
      }
    }

    return { cast: withLocalPhotos(cast) }
  } catch (err) {
    creditsCache.set(movieId, [])
    return { cast: [], error: String(err) }
  }
})

const tvCreditsCache = new Map()

ipcMain.handle('tmdb:tvCredits', async (_e, tvId) => {
  if (!tvId) return { cast: [] }

  const cacheDir = getTmdbCacheDir()
  const tvCreditsMap = tmdbCache.getTvCreditsMap(cacheDir)
  // Actor photos are shared with the Movies cast cache (actorsDir keyed by
  // TMDB person id, which is a global namespace) rather than duplicated per-show.
  const withLocalPhotos = (cast) =>
    cast.map((c) => {
      const local = tmdbCache.localActorPhotoPath(cacheDir, c.id)
      return { ...c, localPhotoPath: local ? `http://localhost:${STREAM_PORT}/media/actor/${c.id}.jpg` : null }
    })

  if (tvCreditsMap[tvId] && !castCredits.isStaleCast(tvCreditsMap[tvId])) return { cast: withLocalPhotos(tvCreditsMap[tvId]) }
  if (tvCreditsCache.has(tvId) && !castCredits.isStaleCast(tvCreditsCache.get(tvId))) return { cast: withLocalPhotos(tvCreditsCache.get(tvId)) }

  const key = store.get('tmdbApiKey') || process.env.TMDB_API_KEY
  if (!key) return { cast: [] }
  const { headers, isV4Token } = tmdbAuth(key)
  const url = isV4Token
    ? `https://api.themoviedb.org/3/tv/${tvId}/credits`
    : `https://api.themoviedb.org/3/tv/${tvId}/credits?api_key=${key}`

  try {
    const res = await fetch(url, { headers })
    if (!res.ok) {
      tvCreditsCache.set(tvId, [])
      return { cast: [] }
    }
    const data = await res.json()
    const cast = castCredits.parseCast(data)
    tvCreditsCache.set(tvId, cast)

    if (cacheDir) {
      const paths = tmdbCache.ensureDirs(cacheDir)
      const diskCreditsMap = tmdbCache.getTvCreditsMap(cacheDir)
      diskCreditsMap[tvId] = cast
      tmdbCache.writeJson(paths.tvCreditsFile, diskCreditsMap)
      for (const c of cast) {
        if (!c.profilePath) continue
        const photoFile = path.join(paths.actorsDir, `${c.id}.jpg`)
        await tmdbCache.downloadImage(`https://image.tmdb.org/t/p/w185${c.profilePath}`, photoFile)
      }
    }

    return { cast: withLocalPhotos(cast) }
  } catch (err) {
    tvCreditsCache.set(tvId, [])
    return { cast: [], error: String(err) }
  }
})

// --- Offline prefetch: downloads every movie's TMDB match, poster, cast, and cast
// photos to disk once, so the app can run with zero internet access afterward
// (e.g. at a cabin with no connectivity). ---

let prefetchRunning = false

ipcMain.handle('tmdb:prefetchAll', async (event, { force } = {}) => {
  if (prefetchRunning) return { ok: false, error: 'already_running' }
  const cacheDir = getTmdbCacheDir()
  if (!cacheDir) return { ok: false, error: 'no_cache_dir' }
  const key = store.get('tmdbApiKey') || process.env.TMDB_API_KEY
  if (!key) return { ok: false, error: 'no_api_key' }

  prefetchRunning = true
  try {
    const paths = tmdbCache.ensureDirs(cacheDir)
    const manifest = tmdbCache.getManifest(cacheDir)
    const creditsMap = tmdbCache.getCreditsMap(cacheDir)
    const { headers, isV4Token } = tmdbAuth(key)

    const files = await scanVideoDirsOffThread(getAllMoviesDirs())
    const total = files.length
    let done = 0
    let posterCount = 0
    let actorCount = 0

    const send = (title) => {
      done += 1
      event.sender.send('tmdb:prefetchProgress', { current: done, total, title })
    }

    const api = titleMatch.createTmdbApi(key)

    for (const f of files) {
      const override = store.get('movieTitleOverrides')?.[f.fileName]
      const parsed = titleParse.parseMovieTitle(f.fileName)
      if (override) {
        parsed.title = override
        parsed.year = null
      }
      const cleanName = parsed.title

      // A decision the owner made by hand is final — including under `force`.
      // `force` is the "Re-check all movie matches" button, and its job is to
      // re-run the MATCHER after a logic change; it has no business undoing an
      // answer a person gave. A "not a film" decision (the trance mixes, the
      // wedding video) means this file is never looked up again at all.
      const decision = titleMatch.getDecision(store, f.fileName)
      let match
      if (decision) {
        match = decision.notAMovie || decision.kind !== 'movie' ? null : manifest[f.fileName] || null
      } else if (!titleMatch.shouldLookUp(store, f.fileName, manifest, force)) {
        // Already answered, or already waiting on the owner in the review list.
        // Note what this NO LONGER skips: a cached `null`. A null used to count
        // as "no such film" and was skipped for good, which is why 267 files in
        // this library have been stuck without a poster. It now means "nobody
        // has answered this yet" and is re-evaluated on this run — once, because
        // the run then either matches it or queues it.
        match = manifest[f.fileName]
      } else {
        let verdict
        try {
          verdict = await titleMatch.matchParsed(parsed, api)
        } catch {
          verdict = { confidence: 'none', match: null, candidates: [], query: cleanName, year: parsed.year, kind: parsed.episode ? 'tv' : 'movie', reason: 'error' }
        }
        // Only certain/probable are written. Anything else keeps whatever poster
        // it already had (so a re-check can never leave the owner with LESS than
        // he started with) and goes on the "Titles to check" list.
        const applied = titleMatch.applyVerdict(store, f.fileName, verdict, manifest[f.fileName] || null)
        match = applied.accepted && verdict.match ? verdict.match.raw : applied.match || null
        manifest[f.fileName] = match
        tmdbCache.writeJson(paths.manifestFile, manifest)
        if (applied.queued) await cacheReviewPosters(paths, verdict.candidates)
      }

      if (match?.poster_path) {
        const posterFile = path.join(paths.postersDir, `${match.id}.jpg`)
        const ok = await tmdbCache.downloadImage(`https://image.tmdb.org/t/p/w300${match.poster_path}`, posterFile)
        if (ok) posterCount += 1
      }

      if (match?.id && (!creditsMap[match.id] || castCredits.isStaleCast(creditsMap[match.id]))) {
        const creditsUrl = isV4Token
          ? `https://api.themoviedb.org/3/movie/${match.id}/credits`
          : `https://api.themoviedb.org/3/movie/${match.id}/credits?api_key=${key}`
        try {
          const res = await fetch(creditsUrl, { headers })
          if (res.ok) {
            const data = await res.json()
            const cast = castCredits.parseCast(data)
            creditsMap[match.id] = cast
            tmdbCache.writeJson(paths.creditsFile, creditsMap)

            for (const c of cast) {
              if (!c.profilePath) continue
              const photoFile = path.join(paths.actorsDir, `${c.id}.jpg`)
              const ok = await tmdbCache.downloadImage(`https://image.tmdb.org/t/p/w185${c.profilePath}`, photoFile)
              if (ok) actorCount += 1
            }
          }
        } catch {
          // leave uncached — a normal run later (with internet) will retry it
        }
      }

      send(match?.title || f.name)
    }

    return { ok: true, movies: total, posters: posterCount, actorPhotos: actorCount }
  } catch (err) {
    return { ok: false, error: String(err) }
  } finally {
    prefetchRunning = false
  }
})

// Same idea as tmdb:prefetchAll above, but for TV Shows — groups scanned
// episode files into unique shows (same folder-name-first logic the TV Shows
// tab uses), looks up each show once, and downloads its poster to disk.
let prefetchTvRunning = false

ipcMain.handle('tmdb:prefetchAllTv', async (event, { force } = {}) => {
  if (prefetchTvRunning) return { ok: false, error: 'already_running' }
  const cacheDir = getTmdbCacheDir()
  if (!cacheDir) return { ok: false, error: 'no_cache_dir' }
  const key = store.get('tmdbApiKey') || process.env.TMDB_API_KEY
  if (!key) return { ok: false, error: 'no_api_key' }

  prefetchTvRunning = true
  try {
    const paths = tmdbCache.ensureDirs(cacheDir)
    const manifest = tmdbCache.getTvManifest(cacheDir)
    const { headers, isV4Token } = tmdbAuth(key)

    const files = await scanVideoDirsOffThread(getAllTvShowsDirs())
    const shows = new Map()
    files.forEach((f) => {
      const { show, year } = groupKeyAndName(f.relPath || f.fileName, f.fileName)
      const showKey = show.toLowerCase()
      if (!shows.has(showKey)) shows.set(showKey, { name: show, year })
    })

    const total = shows.size
    let done = 0
    let posterCount = 0

    const send = (title) => {
      done += 1
      event.sender.send('tmdb:prefetchTvProgress', { current: done, total, title })
    }

    for (const [showKey, { name, year }] of shows) {
      // `in` check, not truthiness — a show already cached as "no TMDB match"
      // (null) must stay skipped, or every prefetch run re-queries it forever.
      // `force` (the "Re-check all TV Show matches" button) bypasses this
      // entirely, mirroring the movie prefetch above — needed after a
      // matching-logic improvement, or the old failed result just stays stuck.
      let match = !force && showKey in manifest ? manifest[showKey] : undefined
      if (match === undefined) {
        try {
          const result = await searchTvSmart(name, year, key, headers, isV4Token)
          match = result.ok ? result.match : null
        } catch {
          match = null
        }
        manifest[showKey] = match
        tmdbCache.writeJson(paths.tvManifestFile, manifest)
      }

      if (match?.poster_path) {
        const posterFile = path.join(paths.tvPostersDir, `${match.id}.jpg`)
        const ok = await tmdbCache.downloadImage(`https://image.tmdb.org/t/p/w300${match.poster_path}`, posterFile)
        if (ok) posterCount += 1
      }

      send(match?.name || name)
    }

    return { ok: true, shows: total, posters: posterCount }
  } catch (err) {
    return { ok: false, error: String(err) }
  } finally {
    prefetchTvRunning = false
  }
})

ipcMain.handle('remote:getAccessInfo', () => {
  const addresses = getNetworkAddresses()
  const port = streamServerInfo?.port || STREAM_PORT
  const links = addresses.map((a) => ({
    ...a,
    url: `http://${a.address}:${port}/login`
  }))
  return { links, port }
})

// The account's free, permanent public address: <name>.beebo.tv. The name is
// derived automatically from the signed-in account (see getRemoteName), or set
// by the user; the bundled host agent brings it online a few seconds after boot.
// What Settings says about the router forward for the agent's UDP range: done
// automatically, or which ports to forward by hand, to which address.
function rtcUdpStatus() {
  try {
    const r = getRtcUdpRange()
    if (!r) return { enabled: false }
    const s = rtcPortMapper ? rtcPortMapper.status() : null
    return {
      enabled: true,
      ports: r.min === r.max ? String(r.min) : r.min + '–' + r.max,
      wanted: r.max - r.min + 1,
      tried: !!(s && s.lastAttempt),
      mapped: !!(s && s.active && s.reachable),
      mappedCount: s && s.active ? s.mappings.length : 0,
      method: (s && s.method) || '',
      externalIp: (s && s.active && s.externalIp) || '',
      localIp: (s && s.localIp) || '',
      kind: (s && s.kind) || '',
      reason: (s && !s.reachable && s.reason) || ''
    }
  } catch (e) { return { enabled: false } }
}

function safeRemoteStatus() {
  try {
    if (remoteHost && typeof remoteHost.status === 'function') {
      const s = remoteHost.status() || {}
      return {
        running: !!s.running,
        online: !!s.online,
        registeredName: s.registeredName || '',
        name: s.name || '',
        hostname: s.hostname || '',
        problem: s.problem || '',
        connection: s.connection || ''
      }
    }
  } catch (e) {}
  return { running: false, online: false, registeredName: '', name: '', hostname: '', problem: '' }
}
ipcMain.handle('remote:setName', (e, raw) => {
  try {
    const slug = slugifyRemoteName(raw)
    if (!slug || slug.length < 3) {
      return { ok: false, error: 'Please choose at least 3 letters or numbers.' }
    }
    store.set('remoteName', slug)
    try { store.set('remoteNameConfirmed', true) } catch (_) {}
    try { if (remoteHost && typeof remoteHost.restart === 'function') remoteHost.restart() } catch (_) {}
    const st = safeRemoteStatus()
    return { ok: true, ...st, name: slug, hostname: slug + '.beebo.tv' }
  } catch (err) {
    return { ok: false, error: (err && err.message) || 'Could not set your address.' }
  }
})
// The direct address line in Settings: <name>.home.beebo.tv, up to date or why not.
function safeHomeAddressStatus() {
  try {
    if (!homeAddress) return null
    const h = homeAddress.status()
    return { state: h.state, hostname: h.hostname, ip: h.ip, ipv4: h.ipv4, ipv6: h.ipv6, reason: h.reason, error: h.error, checkedAt: h.checkedAt, updatedAt: h.updatedAt }
  } catch (e) { return null }
}
ipcMain.handle('remote:getName', () => {
  try {
    const derived = getRemoteName()
    const st = safeRemoteStatus()
    const name = st.registeredName || derived || ''
    return {
      name,
      hostname: name ? name + '.beebo.tv' : '',
      online: st.online,
      running: st.running,
      registeredName: st.registeredName || '',
      requestedName: derived || '',
      problem: st.problem || '',
      connection: st.connection || '',
      udp: rtcUdpStatus(),
      homeAddress: safeHomeAddressStatus()
    }
  } catch (e) {
    return { name: '', hostname: '', online: false, running: false, registeredName: '', requestedName: '', problem: '' }
  }
})

// --- 🔒 Secure connection (HTTPS) ---
// Everything below is read-only or best-effort; none of it can stop the
// server serving. See electron/certs.js for the certificate itself and the
// protocol multiplexer at the bottom of streamServer.js for how one port
// answers both http:// and https://.

ipcMain.handle('certs:status', () => {
  try {
    const domain = getCertDomain()
    const status = certs ? certs.certificateStatus(getCertDir()) : { hasCert: false, reason: 'certificate module unavailable' }
    const live = streamServerInfo && typeof streamServerInfo.tlsStatus === 'function' ? streamServerInfo.tlsStatus() : { active: false, reason: 'server not started' }
    return {
      ...status,
      // The configured domain wins over whatever the certificate says, since
      // that's what the owner is aiming at; the cert's own name is still in
      // `status.domain` if they differ.
      domain: domain || status.domain || '',
      detectedDomain: detectDuckdnsDomain(),
      // 'duckdns' or 'beebo' (<name>.home.beebo.tv); hasToken is that provider's
      // credential: the DuckDNS token file, or this PC's Beebo sign-in.
      provider: certs && domain ? certs.certProvider(domain) : '',
      hasToken: certs && domain && certs.certProvider(domain) === 'beebo' ? !!getLicenceTokenSafe() : !!readDuckdnsToken(),
      homeDomain: (() => { try { return (homeAddress && homeAddress.status().goodHostname) || '' } catch { return '' } })(),
      certDir: getCertDir(),
      // Is HTTPS actually serving right now, as opposed to merely having a
      // file on disk? These come apart when a certificate is unreadable.
      httpsActive: !!live.active,
      httpsReason: live.reason || '',
      lastAttempt: store.get('certLastAttempt') || null,
      port: streamServerInfo?.port || STREAM_PORT
    }
  } catch (err) {
    return { hasCert: false, httpsActive: false, reason: `status check failed: ${err.message}` }
  }
})

// "Set up HTTPS now" — the same routine the daily timer runs, forced so it
// doesn't just say "your certificate is still fine" when the owner is trying
// to fix something.
ipcMain.handle('certs:setup', async () => {
  try {
    const domain = getCertDomain()
    if (!domain) return { ok: false, reason: 'Enter your web address above first (yourname.home.beebo.tv or yourname.duckdns.org).' }
    const provider = certs ? certs.certProvider(domain) : ''
    if (provider === 'beebo' && !getLicenceTokenSafe()) {
      return { ok: false, reason: 'Sign in to Beebo first: home.beebo.tv certificates are set up through your Beebo account.' }
    }
    if (provider !== 'beebo' && !readDuckdnsToken()) {
      return {
        ok: false,
        reason: 'No DuckDNS token found. Create tools\\duckdns-token.txt (next to duckdns-update.bat) containing just your token.'
      }
    }
    return await runCertificateCheck({ force: false, manual: true })
  } catch (err) {
    return { ok: false, reason: `Setup failed: ${err.message}` }
  }
})

// Get (no argument) or set (with one) the DuckDNS address the certificate is
// for. Kept as its own channel so the domain is never hardcoded anywhere.
ipcMain.handle('certs:domain', (_e, domain) => {
  try {
    if (typeof domain === 'string') {
      const cleaned = certs ? certs.normalizeDomain(domain) : domain.trim().toLowerCase()
      store.set('certDomain', cleaned)
      return { ok: true, domain: cleaned }
    }
    return { ok: true, domain: getCertDomain() }
  } catch (err) {
    return { ok: false, domain: '', reason: err.message }
  }
})

// --- Users / admin (never exposed over HTTP — only reachable from this app) ---

ipcMain.handle('auth:list', () => ({
  users: auth.getUsers(store).map(viewingPrivacy.desktopUser),
  household: require('./householdPlan').capacity(store),
  remoteAccessDefault: store.get('remoteAccessDefault') === true,
  // People still on a short (pre-8-character) code: Users recommends new codes.
  weakCodes: auth.weakCodeUsers(store),
  requests: auth.getRequests(store).filter((r) => r.status === 'pending'),
  lastSeen: auth.getLastSeenMap(store)
}))

// Login attempts using the literal username "admin" — logged (and emailed,
// if a notify address is set) the moment they happen in streamServer.js; this
// just lets the Admin tab show the running history without checking email.
ipcMain.handle('auth:adminAttempts', () => auth.getAdminUsernameAttempts(store))

// Failed-login history and currently-locked-out IPs — both driven by the
// 5-attempts/5-minutes lockout in streamServer.js's /login handler. Surfaced
// in the Admin tab so this is visible without digging through email alerts.
ipcMain.handle('auth:failedLoginLog', () => auth.getFailedLoginLog(store))
ipcMain.handle('auth:activeLockouts', () => auth.getActiveLockouts(store))

// Manually clears a lockout (and that IP's failed-attempt count) from the
// Admin tab's "Currently locked out" list — e.g. if you accidentally lock
// yourself out testing something, or want to give a family member another
// shot right away instead of waiting out the timer.
// Every email the app has attempted to send (alerts, access-request
// notifications, login codes, etc), including ones that failed because no
// sender account is set up yet — see mailer.js's logEmail for why.
ipcMain.handle('mailer:log', () => mailer.getEmailLog(store))

ipcMain.handle('auth:clearLockout', (_e, ip) => {
  if (typeof ip !== 'string' || !ip) return { ok: false, error: 'invalid_ip' }
  auth.clearFailedLogin(store, ip)
  return { ok: true }
})

// Wipes the "Recent failed attempts" / "admin username watch" history lists
// in the Admin tab — leaves any currently-active lockout alone.
ipcMain.handle('auth:clearFailedLoginLog', () => {
  auth.clearFailedLoginLog(store)
  return { ok: true }
})

ipcMain.handle('auth:clearAdminUsernameAttempts', () => {
  auth.clearAdminUsernameAttempts(store)
  return { ok: true }
})

async function emailCodeIfPossible(user, code) {
  if (!user.email || !mailer.isConfigured(store)) return false
  const result = await mailer.sendMail(store, {
    to: user.email,
    subject: 'Your Beebo Entertainment access code',
    text: `Hi ${user.name},\n\nYour Beebo Entertainment username: ${user.username}\nYour access code: ${code}\n\nGo to the site's "Watch Now" link and enter both to log in.`
  })
  return result.ok
}

ipcMain.handle('auth:createUser', async (_e, { name, email } = {}) => {
  const result = auth.createUser(store, name, email)
  if (result.error) return result
  const emailed = await emailCodeIfPossible(result.user, result.code)
  return { ...result, emailed }
})

ipcMain.handle('email:sendTest', async () => {
  const to = store.get('adminNotifyEmail') || store.get('emailUser')
  if (!to) return { ok: false, error: 'no_recipient' }
  return mailer.sendMail(store, {
    to,
    subject: 'Beebo Entertainment test email',
    text: 'If you got this, email notifications are working.'
  })
})

ipcMain.handle('auth:approveRequest', async (_e, requestId) => {
  const result = auth.approveRequest(store, requestId)
  if (!result || result.error) return result
  const emailed = await emailCodeIfPossible(result.user, result.code)
  return { ...result, emailed }
})

ipcMain.handle('auth:denyRequest', (_e, requestId) => {
  auth.denyRequest(store, requestId)
  return true
})

ipcMain.handle('auth:revokeUser', (_e, userId) => {
  auth.revokeUser(store, userId)
  return true
})

ipcMain.handle('auth:reactivateUser', (_e, userId) => {
  return desktopSettingsPolicy.reactivateUser(store, userId, auth)
})

ipcMain.handle('auth:regenerateCode', async (_e, userId) => {
  const code = auth.regenerateCode(store, userId)
  const user = auth.getUsers(store).find((u) => u.id === userId)
  const emailed = user ? await emailCodeIfPossible(user, code) : false
  return { code, emailed }
})

ipcMain.handle('auth:deleteUser', (_e, userId) => {
  // The person and their personal data here (history, watchlist, flags), not just the record.
  require('./userDeletion').purgeUserData(store, userId)
  return true
})

ipcMain.handle('auth:setUserAdmin', (_e, { userId, isAdmin } = {}) => {
  auth.setUserAdmin(store, userId, isAdmin)
  return true
})

// --- away-from-home access, per person -------------------------------------
// The pass is shown to the owner ONCE and never stored in the clear, so it can
// never be read back — only replaced. Pushing the list to the Worker is what
// makes a revoke take effect away from home, and it is deliberately best-effort:
// if the push fails the local change still stands and the next one catches up.
// Debounced, and skipped when the list the Worker would receive hasn't changed:
// authUsers also changes for things that don't matter here (last-seen times).
// It is also re-pushed every six hours when nothing changed, so the copy the
// Worker holds is regularly overwritten with this machine's truth.
let lastMemberPush = ''
let lastMemberPushAt = 0
let memberPushTimer = null
let memberRepushInterval = null
function schedulePushRemoteMembers(delayMs) {
  if (memberPushTimer) clearTimeout(memberPushTimer)
  memberPushTimer = setTimeout(() => {
    memberPushTimer = null
    try {
      const rm = require('./remoteMembers')
      const sig = getRemoteName() + '|' + JSON.stringify(rm.buildMemberList(auth.getUsers(store)))
      if (!rm.memberPushDue({ sig, lastSig: lastMemberPush, lastAt: lastMemberPushAt, now: Date.now() })) return
      pushRemoteMembers().then((r) => { if (r && r.ok) { lastMemberPush = sig; lastMemberPushAt = Date.now() } }).catch(() => {})
      pushLibraryShares().catch(() => {})
    } catch (e) {}
  }, delayMs || 0)
  // First call (at registration, shortly after start) arms the periodic check.
  if (!memberRepushInterval) {
    try {
      memberRepushInterval = setInterval(() => schedulePushRemoteMembers(0), require('./remoteMembers').REMOTE_MEMBERS_CHECK_MS)
      if (memberRepushInterval && memberRepushInterval.unref) memberRepushInterval.unref()
    } catch (e) {}
  }
}

// A name picked automatically from the account email can collide with another
// customer's, be reserved, or be too short. The host used to retry that name for
// ever while Settings showed "Connecting...". If the owner never chose the name
// themselves, ask the Worker for a free one and switch to it. A name the owner
// typed is left alone; Settings explains the problem instead.
let autoRenameAttempts = 0
async function pickFreeRemoteName(code) {
  if (!['name_taken', 'name_reserved', 'name_invalid'].includes(code)) return
  if (store.get('remoteNameConfirmed')) return
  if (autoRenameAttempts >= 3) return
  autoRenameAttempts++
  const current = getRemoteName()
  const ask = current.length < 3 ? current + 'beebo' : current
  const base = String(license.backendUrl() || '').replace(/\/$/, '')
  if (!base || typeof fetch !== 'function') return
  const res = await fetch(base + '/remote/check-name?name=' + encodeURIComponent(ask), { signal: AbortSignal.timeout(15000) })
  const j = await res.json().catch(() => ({}))
  const next = slugifyRemoteName((j && j.ok) ? j.name : (j && j.suggestion))
  if (!next || next === current || next.length < 3) return
  console.log('[remote-host] ' + current + '.beebo.tv unavailable (' + code + '); switching to ' + next + '.beebo.tv')
  store.set('remoteName', next)
  try { if (remoteHost) remoteHost.restart() } catch (e) {}
}

// Library shares with other households (electron/libraryShares.js): pushed to beebo.tv like the
// member list, on every change and with the member re-push, so an acceptance, a guest leaving
// and the invite code (when no email could be sent) come back here.
function pushLibraryShares() {
  try {
    const ls = require('./libraryShares')
    if (!ls.list(store).length) return Promise.resolve({ ok: true, skipped: true })
    const owner = auth.getUsers(store).find((u) => u && u.isAdmin && u.status === 'approved')
    return ls.syncShares({
      store,
      getName: getRemoteName,
      getToken: () => { try { return license.getToken() } catch (e) { return null } },
      ownerLabel: owner && owner.name ? owner.name + "'s library" : 'Shared library',
      log: (m) => { try { console.log(m) } catch (e) {} },
    })
  } catch (e) {
    return Promise.resolve({ ok: false, reason: 'error' })
  }
}
require('./sharingIpc').registerSharingIpc({
  ipcMain, store, auth, history, pushLibraryShares,
  getLibraryFolders: () => ({ movies: getAllMoviesDirs(), tv: getAllTvShowsDirs() }),
})

// Account security (electron/accountSecurityIpc.js): the owner's controls over two-factor policy, reset
// codes, other people's sessions and the security event log. Owner-only, never over HTTP.
require('./accountSecurityIpc').register({
  ipcMain, store, mailer,
  getServerUrls: () => {
    const port = (streamServerInfo && streamServerInfo.port) || STREAM_PORT
    return getNetworkAddresses().map((a) => 'http://' + a.address + ':' + port)
  },
})

function pushRemoteMembers() {
  try {
    const rm = require('./remoteMembers')
    return rm.syncMembers({
      getName: getRemoteName,
      getToken: () => { try { return license.getToken() } catch (e) { return null } },
      getUsers: () => { try { return auth.getUsers(store) } catch (e) { return [] } },
      log: (m) => { try { console.log(m) } catch (e) {} },
    })
  } catch (e) {
    try { console.log('[remote-members] not pushed: ' + (e && e.message)) } catch (_e) {}
    return Promise.resolve({ ok: false, reason: 'error' })
  }
}

ipcMain.handle('auth:enableAllRemoteAccess', async () => {
  const result = auth.enableAllRemoteAccess(store)
  const sync = await pushRemoteMembers()
  return { ...result, synced: !!sync?.ok }
})
ipcMain.handle('auth:setRemoteAccessDefault', (_e, enabled) => {
  if (typeof enabled !== 'boolean') throw new Error('Invalid away-access preference')
  store.set('remoteAccessDefault', enabled)
  return { ok: true }
})

ipcMain.handle('auth:enableRemoteAccess', async (_e, { userId } = {}) => {
  const pass = auth.setUserRemoteAccess(store, userId)
  const sync = await pushRemoteMembers()
  return { pass, synced: !!(sync && sync.ok), reason: sync && sync.reason }
})

ipcMain.handle('auth:disableRemoteAccess', async (_e, { userId } = {}) => {
  auth.clearUserRemoteAccess(store, userId)
  const sync = await pushRemoteMembers()
  return { synced: !!(sync && sync.ok), reason: sync && sync.reason }
})

// Re-push on demand, e.g. after the address or licence changes.
ipcMain.handle('auth:syncRemoteAccess', async () => {
  const sync = await pushRemoteMembers()
  return { synced: !!(sync && sync.ok), reason: sync && sync.reason }
})

ipcMain.handle('auth:renameUser', (_e, { userId, name } = {}) => {
  auth.renameUser(store, userId, name)
  return true
})

ipcMain.handle('auth:setUserEmail', (_e, { userId, email } = {}) => {
  auth.setUserEmail(store, userId, email)
  return true
})

ipcMain.handle('auth:setUserCode', async (_e, { userId, code } = {}) => {
  const newCode = auth.setUserCode(store, userId, code)
  if (!newCode) return { ok: false, error: 'empty_code' }
  const user = auth.getUsers(store).find((u) => u.id === userId)
  const emailed = user ? await emailCodeIfPossible(user, newCode) : false
  return { ok: true, code: newCode, emailed }
})

// Migrates an existing (still on the old generated-code system) account onto
// a real password, chosen here by the admin — used for the manual per-user
// migration off codes now that self-service signup uses real passwords.
// Clears the account's code as part of the switch, same as setUserCode does
// the reverse.
// --- first-run setup (the Get Started wizard) ---
// Report what still needs doing on a fresh install, and the LAN address to type on the phone.
ipcMain.handle('setup:status', () => {
  let moviesDir = ''
  try { moviesDir = getMoviesDir() } catch {}
  let hasMovies = false
  try { hasMovies = !!moviesDir && fs.existsSync(moviesDir) } catch {}
  const port = (streamServerInfo && streamServerInfo.port) || STREAM_PORT
  let addresses = []
  try { addresses = getNetworkAddresses().map((a) => ({ ...a, hostport: a.address + ':' + port })) } catch {}
  let hasOwner = false
  try { hasOwner = auth.hasOwner(store) } catch {}
  return { hasOwner, hasMovies, moviesDir, addresses, port }
})

// The Cloudflare "quick tunnel" remote-access button lived here. It is gone on
// purpose: a tunnel carries every byte of video through Cloudflare, and Beebo
// promises video never passes through anyone else's servers. Away from home is
// <name>.beebo.tv, peer-to-peer (remoteHostAgent.js).

// Create the FIRST owner account (username + password). Only works on a fresh server.
ipcMain.handle('auth:createOwner', (_e, { username, password } = {}) => {
  try { const r = auth.createOwner(store, { username, password }); reliability.ownerCreated(r); return r }
  catch (err) { return { error: String(err && err.message || err) } }
})

ipcMain.handle('auth:setUserPassword', (_e, { userId, password } = {}) => {
  return auth.setUserPassword(store, userId, password)
})

ipcMain.handle('auth:setAdult', (_e, { userId, adult } = {}) => viewingPrivacy.setAdult(store, userId, adult))

ipcMain.handle('history:list', () => {
  return viewingPrivacy.publicHistory(store, history.getHistory(store)).slice().reverse()
})

// --- History tab removal (✕ Remove / 🗑 Remove all / Clear all history) ----
// This tab is the ADMIN's view of EVERYONE's viewing, but history.js's helpers
// are deliberately per-user (a household member can never touch another's rows
// from the website). So:
//   scope 'one' / 'show' -> act as the row's own user, passed up from the
//     renderer, so removing a row only ever affects the person who watched it.
//   scope 'all'          -> the admin means "wipe the board": run the same
//     per-user helper once for every user that has rows (real or parked),
//     which keeps all the clearing logic in history.js.
// Always answers with the refreshed list in the same shape as history:list.
ipcMain.handle('history:clear', (_e, { scope, fileName, title, userId } = {}) => {
  try {
    if (scope === 'all') {
      const ids = new Set()
      for (const row of history.getHistory(store) || []) if (row && row.userId) ids.add(row.userId)
      for (const row of history.getPendingSessions(store) || []) if (row && row.userId) ids.add(row.userId)
      for (const id of ids) if (!viewingPrivacy.isPrivate(store, id)) history.clearAllHistory(store, id)
    } else if (scope === 'show' && !viewingPrivacy.isPrivate(store, userId)) {
      history.clearHistoryForTitle(store, userId, title)
    } else if (scope === 'one' && !viewingPrivacy.isPrivate(store, userId)) {
      history.clearHistoryEntry(store, userId, fileName)
    }
  } catch (err) {
    console.log('[history]', `clear failed: ${err}`)
  }
  return viewingPrivacy.publicHistory(store, history.getHistory(store)).slice().reverse()
})

// --- Format conversions (sidebar Converted tab) ---
// The queue itself is fed by streamServer.js's /flag-unplayable route (a
// video failing to play in someone's browser); these handlers just expose it
// to the Converted tab for tracking/retrying/playing, plus the two deliberate
// destructive actions: deleting an original AFTER its converted copy exists,
// and deleting a converted copy the owner judged worse than the original.

// Every conversion path — original or converted — has to sit inside one of
// the app's own managed folders before we'll delete it or hand it to the OS
// player. Same guardrail (and same roots) as the regular file:delete handler.
const isInManagedFolders = (filePath) => {
  if (typeof filePath !== 'string' || !filePath) return false
  const resolved = path.resolve(filePath)
  const allowedRoots = [...getAllMoviesDirs(), ...getAllTvShowsDirs()].filter(Boolean).map((d) => path.resolve(d))
  return allowedRoots.some((root) => resolved === root || resolved.startsWith(root + path.sep))
}

ipcMain.handle('convert:list', () => convert.list(store))

ipcMain.handle('convert:retry', (_e, id) => convert.retry(store, id))
// Per-file overrides: park a file for good, or convert it even though the rules say it plays.
ipcMain.handle('convert:dontConvert', (_e, id) => convert.dontConvert(store, id))
ipcMain.handle('convert:convertAnyway', (_e, id) => convert.convertAnyway(store, id))
ipcMain.handle('convert:rulesSummary', () => store.get(convert.RULES_SUMMARY_KEY) || null)
ipcMain.handle('convert:dismissRulesSummary', () => { convert.dismissRulesSummary(store); return { ok: true } })

ipcMain.handle('convert:deleteOriginal', async (_e, id) => {
  const entry = convert.list(store).find((e) => e.id === id)
  if (!entry) return { ok: false, error: 'not_found', conversions: convert.list(store) }
  if (entry.status !== 'done' || entry.originalDeleted) return { ok: false, error: 'not_deletable', conversions: convert.list(store) }
  // Only ever the ORIGINAL is deletable, and only once the converted copy is
  // verifiably real (exists and is >1MB — a truncated/failed output must
  // never cost the user their only copy). Same managed-folders guardrail as
  // every other file-deleting handler.
  try {
    const outStat = fs.statSync(entry.outputPath)
    if (!outStat.isFile() || outStat.size <= 1024 * 1024) return { ok: false, error: 'converted_file_too_small', conversions: convert.list(store) }
  } catch {
    return { ok: false, error: 'converted_file_missing', conversions: convert.list(store) }
  }
  const resolved = path.resolve(entry.originalPath)
  if (resolved === path.resolve(entry.outputPath)) return { ok: false, error: 'invalid_path', conversions: convert.list(store) }
  const allowedRoots = [...getAllMoviesDirs(), ...getAllTvShowsDirs()].filter(Boolean).map((d) => path.resolve(d))
  const isAllowed = allowedRoots.some((root) => resolved === root || resolved.startsWith(root + path.sep))
  if (!isAllowed) return { ok: false, error: 'outside_managed_folders', conversions: convert.list(store) }
  try {
    await fs.promises.rm(resolved, { force: true })
  } catch (err) {
    return { ok: false, error: String(err), conversions: convert.list(store) }
  }
  const conversions = (store.get('conversions') || []).map((e) => (e.id === id ? { ...e, originalDeleted: true } : e))
  store.set('conversions', conversions)
  return { ok: true, conversions: convert.list(store) }
})

// The other direction: the owner compared both files and the CONVERTED copy
// looks worse, so that copy goes and the original stays. Marks the entry
// 'rejected', which also stops the website's auto-flagging from immediately
// re-converting the same original.
ipcMain.handle('convert:deleteConverted', (_e, id) => {
  const entry = convert.list(store).find((c) => c.id === id)
  if (!entry) return { ok: false, error: 'not_found', conversions: convert.list(store) }
  if (!entry.outputPath) return { ok: false, error: 'no_output_path', conversions: convert.list(store) }
  if (path.resolve(entry.outputPath) === path.resolve(entry.originalPath)) {
    return { ok: false, error: 'invalid_path', conversions: convert.list(store) }
  }
  if (!isInManagedFolders(entry.outputPath)) {
    return { ok: false, error: 'outside_managed_folders', conversions: convert.list(store) }
  }
  return convert.rejectConversion(store, id)
})

// Removes a row from the list only — never touches a file on disk.
ipcMain.handle('convert:forget', (_e, id) => convert.forgetEntry(store, id))

// Opens either side of a conversion in the user's default video player so the
// two can be watched and compared. Same shell.openPath as movies:play, but
// restricted to the managed folders since the path comes from a stored entry.
ipcMain.handle('convert:playFile', (_e, filePath) => {
  if (!isInManagedFolders(filePath)) return { ok: false, error: 'outside_managed_folders' }
  const resolved = path.resolve(filePath)
  if (!fs.existsSync(resolved)) return { ok: false, error: 'file_missing' }
  shell.openPath(resolved)
  return { ok: true }
})

// --- Bad-quality flags (sidebar Flags tab) ---
// Entries are created by streamServer.js's /flag-quality route (a viewer
// tapping "⚠️ Bad quality" in the player page); these are thin store
// operations so the Flags tab can list them and mark them handled. Always
// returned newest-first, same as history:list.
const listQualityFlags = () =>
  (store.get('qualityFlags') || []).slice().sort((a, b) => (b.firstFlaggedAt || 0) - (a.firstFlaggedAt || 0))

ipcMain.handle('flags:list', () => listQualityFlags())

ipcMain.handle('flags:resolve', (_e, id) => {
  const flags = (store.get('qualityFlags') || []).map((f) => (f.id === id ? { ...f, resolved: true } : f))
  store.set('qualityFlags', flags)
  return listQualityFlags()
})

ipcMain.handle('flags:remove', (_e, id) => {
  const flags = (store.get('qualityFlags') || []).filter((f) => f.id !== id)
  store.set('qualityFlags', flags)
  return listQualityFlags()
})

// --- Missing files (sidebar 📭 Missing Files tab) ---
// Rows are created by streamServer.js's recordMissingRequest (the player's
// "Up Next" card finding a next episode / next film in a series that TMDB
// knows about but the library hasn't got). Exactly the same thin store
// operations as the flags:* handlers above — this side never writes a row,
// only lists, resolves and removes them — and newest-first like the rest.
const listMissingRequests = () =>
  (store.get('missingRequests') || []).slice().sort((a, b) => (b.firstSeenAt || 0) - (a.firstSeenAt || 0))

ipcMain.handle('requests:list', () => listMissingRequests())

// Best-effort email to whoever asked for it, once the owner has actually decided something —
// same rule as streamServer.js's own notifyTitleRequesters (the same 'missingRequests' rows, so
// a request the owner resolves or declines here is announced exactly like one a library rescan
// or the phone app's owner-side dismiss settles): no email on file, or outgoing mail never set
// up in Settings, and this quietly does nothing. mailer.sendMail already no-ops (and logs) when
// unconfigured, so there is nothing extra to check here.
function notifyTitleRequesters(beforeRow, afterRow) {
  try { require('./webhooks').emitRequestTransition(store, beforeRow, afterRow) } catch {}
  let list
  try { list = titleRequests.requestersToNotify(beforeRow, afterRow) } catch { list = [] }
  if (!list.length) return
  const title = afterRow.title || afterRow.showName || 'your requested title'
  const added = titleRequests.requestStatus(afterRow) === 'added'
  const users = auth.getUsers(store)
  for (const entry of list) {
    const u = users.find((x) => x && x.id === entry.userId)
    if (!u || !u.email) continue
    const subject = added ? `"${title}" is ready on Beebo` : `About your Beebo request for "${title}"`
    const text = added
      ? `Hi ${u.name || ''},\n\nGood news — "${title}" is now in the library. Open Beebo to watch it.`
      : `Hi ${u.name || ''},\n\nThe owner looked at your request for "${title}" and it won't be added.`
    mailer.sendMail(store, { to: u.email, subject, text }).catch(() => {})
  }
}

// Owner decisions on the queue — mark fulfilled (found it) or deny (decline). Both keep the row
// (with its requesters and notes) rather than deleting it, so "Remove" below stays a distinct,
// separate action for actually clearing the reminder away.
ipcMain.handle('requests:resolve', (_e, id) => {
  const requests = store.get('missingRequests') || []
  const before = requests.find((r) => r && r.id === id)
  const after = before ? titleRequests.resolveRow(before) : null
  if (after && after !== before) {
    store.set('missingRequests', requests.map((r) => (r === before ? after : r)))
    notifyTitleRequesters(before, after)
  }
  return listMissingRequests()
})

ipcMain.handle('requests:dismiss', (_e, id) => {
  const requests = store.get('missingRequests') || []
  const before = requests.find((r) => r && r.id === id)
  const after = before ? titleRequests.dismissRow(before) : null
  if (after && after !== before) {
    store.set('missingRequests', requests.map((r) => (r === before ? after : r)))
    notifyTitleRequesters(before, after)
  }
  return listMissingRequests()
})

ipcMain.handle('requests:remove', (_e, id) => {
  const requests = (store.get('missingRequests') || []).filter((r) => r.id !== id)
  store.set('missingRequests', requests)
  return listMissingRequests()
})

// --- 🎲 Not Sure What To Watch? (sidebar Surprise tab) ---
// Deliberately thin wrappers: every one of these calls straight into
// streamServer.js's surf engine — the exact same functions the website's
// /surprise and /surprise/play routes use — so a given kind+genre+year+seed+index
// lands on the same title in the desktop's in-app player as it does in a
// browser. Nothing here re-implements the candidate pool, the seeded shuffle,
// the genre/year filters, the year summary or the title rule. Cache-only: no
// network call ever.
const surfDirs = () => ({ movieDirs: getAllMoviesDirs(), tvDirs: getAllTvShowsDirs(), cacheDir: getTmdbCacheDir() })
// movie | tv | both — the pool-level kind, matching streamServer's surfKindParam.
const surfKind = (kind) => (kind === 'tv' ? 'tv' : kind === 'both' ? 'both' : 'movie')
// One POOLED ITEM is only ever concretely a movie or an episode; 'both' is a
// pool-level notion. surf:mediaUrl is item-level, so it uses this.
const surfItemKind = (kind) => (kind === 'tv' ? 'tv' : 'movie')
// A mixed pool can hold either namespace's genre ids, so 'both' gets the union
// — same rule (and same commentary) as streamServer's GENRE_NAMES_BOTH, which
// isn't exported. The two maps agree on every id they share.
const GENRE_NAMES_BOTH = { ...GENRE_NAMES_MOVIE, ...GENRE_NAMES_TV }
const surfGenreNames = (kind) => (kind === 'both' ? GENRE_NAMES_BOTH : kind === 'tv' ? GENRE_NAMES_TV : GENRE_NAMES_MOVIE)

// The normalized { genre, year, decade } triple every surf handler shares —
// the IPC twin of streamServer's apiSurfFilters. `year` wins over `decade`
// (the contract is "pass at most one"), a junk/absent year or decade is simply
// no filter at all, and a genre id this kind's map doesn't know degrades to ''
// exactly as it always has, so a stale renderer can't produce an empty pool.
const surfFilterArgs = (kind, { genre, year, decade } = {}) => {
  const names = surfGenreNames(kind)
  const g = names[genre] ? String(genre) : ''
  const y = normalizeYearParam(year === undefined ? null : year)
  const d = y === null ? normalizeDecadeParam(decade === undefined ? null : decade) : null
  return { genre: g, year: y, decade: d }
}

// "Comedy · 1990s" — the same human-readable filter string the website puts in
// its surf bar (streamServer's surfFilterLabel, which isn't exported). Handed
// to the renderer so the player chrome and the empty-pool screen can name the
// filters without rebuilding them from chip state.
const surfFilterLabel = (kind, { genre = '', year = null, decade = null } = {}) => {
  const bits = []
  const name = genre ? surfGenreNames(kind)[genre] : null
  if (name) bits.push(name)
  if (year !== null) bits.push(String(year))
  else if (decade !== null) bits.push(`${decade}s`)
  return bits.join(' · ')
}

// surfCandidates reads the film and episode lists. Make sure the library cache is current first,
// walking on the catalog worker if it is not (catalog.js, createLibraryCatalog), so a surf pick
// never walks the library on this thread, which also serves every stream.
function withLibraryPrimed(label, fn) {
  const library = catalog.sharedLibraryCatalog()
  return library.run(label, async () => {
    await library.prime({ movies: getAllMoviesDirs(), tv: getAllTvShowsDirs() })
    return fn()
  })
}

// Genre chips for step 2, only the genres actually present in the library,
// with counts — same filter+sort the website's surpriseGenrePage does. Counts
// describe the pool under the ACTIVE year/decade filter and nothing else, so a
// chip picked after choosing 1990s shows a real 1990s count (identical rule to
// GET /api/surf/genres). `seed` comes along so the renderer can lock one
// running order in at "Start surfing" time, exactly like the seed baked into
// the website's play links.
ipcMain.handle('surf:genres', (_e, { kind, year, decade } = {}) => withLibraryPrimed('surf:genres', () => {
  try {
    const k = surfKind(kind)
    const names = surfGenreNames(k)
    const { year: y, decade: d } = surfFilterArgs(k, { year, decade })
    const pool = surfFilterPool(k, surfCandidates(k, surfDirs()), { year: y, decade: d })
    const counts = countGenres(pool.map((c) => c.meta))
    const genres = Object.entries(names)
      .filter(([id]) => counts.get(Number(id)))
      .map(([id, name]) => ({ id: Number(id), name, count: counts.get(Number(id)) }))
      .sort((a, b) => a.name.localeCompare(b.name))
    return { ok: true, kind: k, genres, total: pool.length, year: y, decade: d, seed: freshSeed() }
  } catch (err) {
    return { ok: false, error: String(err), genres: [], total: 0 }
  }
}))

// Mirror image of surf:genres, and the IPC twin of GET /api/surf/years: which
// years exist in the pool under the ACTIVE genre filter, as decades and as the
// individual years inside them, plus how many titles have no determinable year
// at all (those are exactly what a year filter drops). Shape is deliberately
// identical to the JSON API's — { ok, decades, years, unknownCount, total } —
// and comes straight out of surfYearSummary rather than being rebuilt here.
ipcMain.handle('surf:years', (_e, { kind, genre } = {}) => withLibraryPrimed('surf:years', () => {
  try {
    const k = surfKind(kind)
    const { genre: g } = surfFilterArgs(k, { genre })
    const pool = surfFilterPool(k, surfCandidates(k, surfDirs()), { genre: g })
    const summary = surfYearSummary(k, pool)
    return {
      ok: true,
      kind: k,
      genre: g,
      decades: summary.decades,
      years: summary.years,
      unknownCount: summary.unknownCount,
      total: summary.total
    }
  } catch (err) {
    return { ok: false, error: String(err), decades: [], years: [], unknownCount: 0, total: 0 }
  }
}))

// The whole shuffled running order for one kind+genre+year/decade+seed, as the
// lightest thing the renderer can page through: { id, title, kind }. ⏮/⏭ are
// then just index ±1 on the client with no further main-process round trips,
// and the order is reproducible for the same seed just like the website's URLs.
// Each item carries its OWN kind (surfKindOf) rather than the pool's, which is
// what lets a kind='both' running order hand surf:mediaUrl the right /file vs
// /tvfile route per pick. The pool is NOT re-sorted here: surfCandidates has
// already put a mixed pool in stable `kind|id` order, and re-sorting or
// re-shuffling would break the same-seed-same-title promise.
ipcMain.handle('surf:pool', (_e, { kind, genre, seed, year, decade } = {}) => withLibraryPrimed('surf:pool', () => {
  try {
    const k = surfKind(kind)
    const f = surfFilterArgs(k, { genre, year, decade })
    const filtered = surfFilterPool(k, surfCandidates(k, surfDirs()), f)
    const usedSeed = normalizeSeed(seed)
    const items = seededShuffle(filtered, usedSeed).map((c) => ({
      id: c.id,
      title: surfTitle(k, c),
      kind: surfKindOf(k, c)
    }))
    return {
      ok: true,
      kind: k,
      genre: f.genre,
      year: f.year,
      decade: f.decade,
      filterLabel: surfFilterLabel(k, f),
      seed: usedSeed,
      items,
      total: items.length
    }
  } catch (err) {
    return { ok: false, error: String(err), items: [], total: 0 }
  }
}))

// A seekable, range-supporting URL for one pool entry, served by the local
// stream server's existing /file and /tvfile routes. The signed 12h media
// token is what lets the renderer's <video> fetch it with no login cookie —
// the same mechanism a Chromecast uses. `kind` here is the ITEM's own kind
// (surf:pool puts it on every entry), never 'both'.
ipcMain.handle('surf:mediaUrl', (_e, { kind, id } = {}) => {
  try {
    if (!id || typeof id !== 'string') return { ok: false, error: 'missing_id' }
    const k = surfItemKind(kind)
    const route = k === 'tv' ? '/tvfile' : '/file'
    const mt = makeMediaToken(store, id)
    return {
      ok: true,
      kind: k,
      id,
      url: `http://127.0.0.1:${STREAM_PORT}${route}?id=${encodeURIComponent(id)}&mt=${encodeURIComponent(mt)}`
    }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
})

// --- Playlists: the desktop app acts as the owner ---------------------------
// Everything goes through the stream server's playlist contract (playlistApi.js),
// so the desktop, the website and the phone apps share one set of rules.
// Streams come back as local URLs the in-app <video> can play directly.
// --- Live TV (electron/liveTv/): Settings > Live TV and the Live TV tab. The same JSON contract as /api/livetv/*, run as the owner. ---
// Watching returns a local address the in-app <video> plays; the tuner's own address never leaves the server.
ipcMain.handle('livetv:call', async (_e, { method = 'GET', path: subPath = '', query = {}, body = {} } = {}) => {
  try {
    if (!streamServerInfo || !streamServerInfo.liveTv) return { ok: false, error: 'server_not_running' }
    const owner = auth.getUsers(store).find((u) => u && u.isAdmin && u.status === 'approved') || auth.getUsers(store).find((u) => u && u.isAdmin)
    if (!owner) return { ok: false, error: 'no_owner', message: 'Create the owner account first (Get Started).' }
    const out = await streamServerInfo.liveTv.call(String(method).toUpperCase(), String(subPath || ''), query || {}, body || {}, { id: owner.id, isAdmin: true })
    const res = out.body || {}
    if (typeof res.url === 'string' && res.url.startsWith('/')) res.url = `http://127.0.0.1:${streamServerInfo.port || STREAM_PORT}${res.url}`
    return res
  } catch (err) {
    return { ok: false, error: 'failed', message: String(err && err.message || err) }
  }
})
ipcMain.handle('livetv:pickFolder', async () => {
  const res = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
  return res.canceled || !res.filePaths[0] ? '' : res.filePaths[0]
})
ipcMain.handle('livetv:pickGuideFile', async () => {
  const res = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Guide (XMLTV)', extensions: ['xml', 'xmltv', 'gz'] }] })
  return res.canceled || !res.filePaths[0] ? '' : res.filePaths[0]
})

ipcMain.handle('playlists:call', async (_e, { method = 'GET', path: subPath = '', query = {}, body = {} } = {}) => {
  try {
    if (!streamServerInfo || typeof streamServerInfo.playlists !== 'function') return { ok: false, error: 'server_not_running' }
    const owner = auth.getUsers(store).find((u) => u && u.isAdmin && u.status === 'approved') || auth.getUsers(store).find((u) => u && u.isAdmin)
    if (!owner) return { ok: false, error: 'no_owner' }
    const out = await streamServerInfo.playlists(String(method).toUpperCase(), String(subPath || ''), query || {}, body || {}, owner)
    const res = out.body || {}
    const local = (u) => (typeof u === 'string' && u.startsWith('/') ? `http://127.0.0.1:${streamServerInfo.port || STREAM_PORT}${u}` : u)
    if (Array.isArray(res.items)) res.items = res.items.map((it) => ({ ...it, stream: local(it.stream), poster: local(it.poster) }))
    return res
  } catch (err) {
    return { ok: false, error: String(err) }
  }
})

// --- Podcasts and Internet radio: the desktop app acts as the owner ----------
// The same /api/podcasts and /api/radio contracts the phone uses (podcastApi.js, radioApi.js), run
// in-process for the owner. Audio comes back as local, signed URLs the in-app <audio> can play.
function localizeAudioUrls(node, base, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return node
  if (Array.isArray(node)) { node.forEach((n) => localizeAudioUrls(n, base, depth + 1)); return node }
  if (typeof node.stream === 'string' && node.stream.startsWith('/api/')) node.stream = base + node.stream
  for (const k of Object.keys(node)) if (node[k] && typeof node[k] === 'object') localizeAudioUrls(node[k], base, depth + 1)
  return node
}
async function callAudioApi(key, method, subPath, query, body) {
  if (!streamServerInfo || typeof streamServerInfo[key] !== 'function') return { ok: false, error: 'server_not_running' }
  const owner = auth.getUsers(store).find((u) => u && u.isAdmin && u.status === 'approved') || auth.getUsers(store).find((u) => u && u.isAdmin)
  if (!owner) return { ok: false, error: 'no_owner' }
  const sub = '/' + String(subPath || '').replace(/^\/+/, '')
  const out = await streamServerInfo[key](String(method || 'GET').toUpperCase(), sub === '/' ? '/status' : sub, { ...(query || {}), tokens: '1' }, body || {}, owner)
  return localizeAudioUrls(out.body || {}, `http://127.0.0.1:${streamServerInfo.port || STREAM_PORT}`)
}
for (const [channel, key] of [['podcasts:call', 'podcasts'], ['radio:call', 'radio']]) {
  ipcMain.handle(channel, async (_e, { method = 'GET', path: subPath = '', query = {}, body = {} } = {}) => {
    try { return await callAudioApi(key, method, subPath, query, body) } catch (err) { return { ok: false, error: String(err) } }
  })
}
// OPML: pick a file to import from, or a place to save the export. The file is read here and handed to the
// same /api/podcasts/opml route (size-capped, parsed by xmlLite.js, which refuses DTDs and entities).
ipcMain.handle('podcasts:importOpml', async () => {
  try {
    const res = await dialog.showOpenDialog({ title: 'Import podcasts (OPML)', filters: [{ name: 'OPML', extensions: ['opml', 'xml'] }], properties: ['openFile'] })
    if (res.canceled || !res.filePaths[0]) return { ok: false, error: 'canceled' }
    if (fs.statSync(res.filePaths[0]).size > 4 * 1024 * 1024) return { ok: false, error: 'too_large' }
    const text = require('./xmlLite').decodeXmlBytes(fs.readFileSync(res.filePaths[0]))
    return await callAudioApi('podcasts', 'POST', '/opml', {}, { opml: text })
  } catch (err) { return { ok: false, error: String(err) } }
})
ipcMain.handle('podcasts:exportOpml', async () => {
  try {
    const out = await callAudioApi('podcasts', 'GET', '/opml', {}, {})
    if (!out || !out.ok) return out || { ok: false, error: 'export_failed' }
    const res = await dialog.showSaveDialog({ title: 'Export podcasts (OPML)', defaultPath: 'beebo-podcasts.opml', filters: [{ name: 'OPML', extensions: ['opml'] }] })
    if (res.canceled || !res.filePath) return { ok: false, error: 'canceled' }
    fs.writeFileSync(res.filePath, out.opml, 'utf8')
    return { ok: true, path: res.filePath }
  } catch (err) { return { ok: false, error: String(err) } }
})

// --- Switch to Beebo: the migration importer (Plex, Jellyfin, Emby, Kodi, Letterboxd) ---
// Same contract as /api/admin/migration/* (electron/migrationApi.js), as the owner. Only the owner may
// import, so the person is the first approved admin (like playlists above). API keys and tokens the
// wizard sends are used for that one request by the importer and are never stored or logged here.
ipcMain.handle('migration:call', async (_e, { method = 'GET', path: subPath = '', query = {}, body = {} } = {}) => {
  try {
    if (!streamServerInfo || !streamServerInfo.migration) return { ok: false, error: 'server_not_running' }
    const users = auth.getUsers(store)
    const owner = users.find((u) => u && u.isAdmin && u.status === 'approved') || users.find((u) => u && u.isAdmin)
    if (!owner) return { ok: false, error: 'no_owner' }
    const out = await streamServerInfo.migration.call(String(method).toUpperCase(), String(subPath || ''), query || {}, body || {}, owner)
    return out.body || { ok: false, error: 'server_error' }
  } catch (err) {
    return { ok: false, error: 'server_error' }
  }
})

// "Choose the Kodi folder": the dialog is ours, and what comes back is a short-lived grant id, never
// a path the page could send us. The importer reads only the folder a grant names.
ipcMain.handle('migration:pickFolder', async () => {
  if (!streamServerInfo || !streamServerInfo.migration) return { ok: false, error: 'server_not_running' }
  const res = await dialog.showOpenDialog({ title: 'Choose the folder with your Kodi .nfo files', properties: ['openDirectory'] })
  if (res.canceled || !res.filePaths[0]) return { ok: false, error: 'cancelled' }
  return { ok: true, grantId: streamServerInfo.migration.grantFolder(res.filePaths[0]), name: path.basename(res.filePaths[0]) }
})

// --- Audiobooks: the desktop app acts as the owner ----------------------------
// Everything goes through the stream server's /api/audiobooks contract (audiobookApi.js handleJson), so the
// desktop, the website and the phone apps share one set of rules. Stream and cover links come back as local
// URLs the in-app <audio> can play directly (ask with tokens: '1' for the media tokens the audio needs).
ipcMain.handle('audiobooks:call', async (_e, { method = 'GET', path: subPath = '', query = {}, body = {} } = {}) => {
  try {
    if (!streamServerInfo || typeof streamServerInfo.audiobooks !== 'function') return { ok: false, error: 'server_not_running' }
    const owner = auth.getUsers(store).find((u) => u && u.isAdmin && u.status === 'approved') || auth.getUsers(store).find((u) => u && u.isAdmin)
    if (!owner) return { ok: false, error: 'no_owner' }
    const out = streamServerInfo.audiobooks(String(method).toUpperCase(), String(subPath || ''), query || {}, body || {}, owner)
    const base = `http://127.0.0.1:${streamServerInfo.port || STREAM_PORT}`
    const local = (v) => {
      if (typeof v === 'string') return v.startsWith('/api/audiobooks/') ? base + v : v
      if (Array.isArray(v)) return v.map(local)
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, local(x)]))
      return v
    }
    return local(out.body || {})
  } catch (err) {
    return { ok: false, error: String(err) }
  }
})

// --- Whole-library subtitle sweep: Settings > Quality & subtitles "Sweep now" ---
// Both handlers just forward into the running stream server's subtitleSweep
// bridge (streamServer.js), which drives playbackApi.js's onlineSearch /
// onlineDownload - the exact same OpenSubtitles code the single-title
// "Search online" button in the player uses. Nothing here talks to
// OpenSubtitles, walks the library, or tracks a quota number itself.
ipcMain.handle('subtitles:sweepNow', async (_e, opts) => {
  if (!streamServerInfo || !streamServerInfo.subtitleSweep) return { ok: false, error: 'server_not_running' }
  try {
    return await streamServerInfo.subtitleSweep.run(opts || {})
  } catch (err) {
    return { ok: false, error: String(err) }
  }
})

ipcMain.handle('subtitles:sweepStatus', () => {
  if (!streamServerInfo || !streamServerInfo.subtitleSweep) return { running: false, last: null }
  try {
    return streamServerInfo.subtitleSweep.status()
  } catch {
    return { running: false, last: null }
  }
})

// --- Backup / restore: everything electron-store holds (users, admins, TMDB
// key, email app password, DuckDNS/other notes, folder paths, etc) saved to
// one file that can be dropped on a USB drive and re-imported into a fresh
// install after a Windows reinstall. Optional passphrase encrypts the file
// (AES-256-GCM) since it contains password hashes and other secrets.
// The format, what counts as a secret and the restore rules are all in
// backup.js (shared with the website's admin Backup tab). Passwords and keys
// go into the file only when the owner ticks the box, encrypted with their
// passphrase. A restore is preview (validate + summary), then apply (safety
// copy of the current settings first, never touches media files).
const BACKUP_SAFETY_DIR = () => path.join(app.getPath('userData'), 'safety-backups')
const backupPreviews = new Map() // previewId -> { opened, filePath, at }

ipcMain.handle('backup:export', async (_e, { includeSecrets = false, passphrase = '' } = {}) => {
  // Refuse a bad passphrase before asking where to save.
  try {
    backup.checkExportPassphrase({ includeSecrets, passphrase })
  } catch (err) {
    return { ok: false, error: backup.errorText(err) }
  }
  const res = await dialog.showSaveDialog({
    title: 'Save Beebo Entertainment backup',
    defaultPath: backup.backupFileName(),
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (res.canceled || !res.filePath) return { ok: false, error: 'canceled' }
  try {
    const data = backup.createBackup(store, { includeSecrets: !!includeSecrets, passphrase, cacheDir: getTmdbCacheDir(), safeStorage, appVersion: app.getVersion() })
    fs.writeFileSync(res.filePath, backup.serializeBackup(data), 'utf8')
    // "Last backup" on the server dashboard.
    try { store.set('lastBackupAt', Date.now()) } catch (e) {}
    return { ok: true, path: res.filePath, includesSecrets: !!includeSecrets }
  } catch (err) {
    return { ok: false, error: backup.errorText(err) }
  }
})

// Pick (or re-use) a file, validate it and summarise what a restore would change. Writes nothing.
ipcMain.handle('backup:preview', async (_e, { filePath = '', passphrase = '', skipSecrets = false } = {}) => {
  let chosen = String(filePath || '')
  if (!chosen) {
    const res = await dialog.showOpenDialog({
      title: 'Choose a Beebo Entertainment backup file to restore',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (res.canceled || !res.filePaths[0]) return { ok: false, error: 'canceled' }
    chosen = res.filePaths[0]
  }
  try {
    if (fs.statSync(chosen).size > backup.MAX_BACKUP_BYTES) return { ok: false, filePath: chosen, error: backup.errorText({ code: 'too_large' }) }
    const parsed = backup.parseBackupText(fs.readFileSync(chosen))
    let opened
    try {
      opened = backup.openBackup(parsed, { passphrase, skipSecrets: !!skipSecrets })
    } catch (err) {
      if (err && (err.code === 'passphrase_required' || err.code === 'wrong_passphrase')) {
        return { ok: false, filePath: chosen, needsPassphrase: true, canSkipSecrets: parsed.kind === 'v2', error: backup.errorText(err) }
      }
      throw err
    }
    const now = Date.now()
    for (const [k, v] of backupPreviews) if (now - v.at > 15 * 60 * 1000) backupPreviews.delete(k)
    const previewId = require('crypto').randomBytes(16).toString('hex')
    backupPreviews.clear()
    backupPreviews.set(previewId, { opened, filePath: chosen, at: now })
    return { ok: true, filePath: chosen, previewId, summary: backup.summarizeRestore(store, opened) }
  } catch (err) {
    return { ok: false, filePath: chosen, error: backup.errorText(err) }
  }
})

ipcMain.handle('backup:apply', async (_e, { previewId = '' } = {}) => {
  const staged = backupPreviews.get(String(previewId))
  if (!staged) return { ok: false, error: 'That restore had expired. Choose the file again; nothing was changed.' }
  backupPreviews.delete(String(previewId))
  try {
    const result = backup.applyRestore(store, staged.opened, { safetyDir: BACKUP_SAFETY_DIR(), cacheDir: getTmdbCacheDir(), safeStorage })
    // Renderer state (users list, settings fields, etc) was loaded from the
    // old store before this import happened, so it's now stale — reloading
    // is the simplest reliable way to get every screen showing the restored
    // data instead of trying to hand-refresh every piece of renderer state.
    const _win = BrowserWindow.getAllWindows()[0]
    if (_win && !_win.isDestroyed()) setTimeout(() => { try { _win.webContents.reload() } catch (_) {} }, 1500)
    return { ok: true, safetyFile: result.safetyFile, written: result.written.length }
  } catch (err) {
    return { ok: false, error: backup.errorText(err) }
  }
})
