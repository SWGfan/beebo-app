const http = require('http')
// HTTPS on the SAME port as HTTP — see the protocol-multiplexing block at the
// bottom of startStreamServer. `net` owns the listening socket and peeks the
// first byte of each connection; `https`/`tls` only ever come into play once
// a certificate has actually loaded.
const https = require('https')
const tls = require('tls')
const net = require('net')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const titleParse = require('./titleParse')
const fileServe = require('./fileServe')
// The shared matcher + the owner's confirmed decisions. Required here so this
// server and the desktop app pick the same TMDB result for the same file —
// they used to run two different algorithms and disagree.
const titleMatch = require('./titleMatch')
const castCredits = require('./castCredits')
const browserChrome = require('./browserChrome')
const { privacyNoticeHtml } = require('./privacyNotice')
const theme = require('./theme') // per-user theme (data-theme + custom overrides), applied while pages render
const pwa = require('./pwa') // installable web app: manifest, service worker, icons, install helper (public files)
const themeWeb = require('./themeWeb') // /appearance page and /api/theme
const routeRegistry = require('./routeRegistry') // small modules that add routes (preferences profile: /api/prefs, /appearance/prefs)
const computerGalleryModule = require('./computerGallery')
const photosApi = require('./photosApi') // Photos library + phone camera backup (/api/photos/*, /photos)
const tripShareApi = require('./tripShareApi') // Private trip links served from this PC (/trip/<token>, /api/trip-shares/*)
const computerGallery = computerGalleryModule.createComputerGallery()
// Loaded defensively: if someone launches the app before running `npm install`
// after this dependency was added, we don't want the ENTIRE app to crash on
// startup just because the website's upload route can't work yet. Everything
// else (desktop app, website browsing/streaming) keeps working; only POST
// /upload on the website is disabled until busboy is actually installed.
let Busboy = null
try {
  Busboy = require('busboy')
} catch {
  Busboy = null
}
const auth = require('./auth')
const userDeletion = require('./userDeletion')
// The library walk (and the worker thread that runs it off the main loop) — see catalog.js.
const catalog = require('./catalog')
const { encodeId } = catalog
// Same walks, same results; answered from the library cache when it is current or the request
// primed it, walked right here otherwise (catalog.js, createLibraryCatalog).
// Unfiltered walks: only for the content gate itself and the owner's own jobs.
const rawScanMoviesMulti = (dirs) => catalog.sharedLibraryCatalog().scanMoviesMulti(dirs)
const rawScanTvShowsMulti = (dirs) => catalog.sharedLibraryCatalog().scanTvShowsMulti(dirs)
// Parental controls and library shares: every list built from these walks is filtered for the
// person asking (electron/contentGate.js). Outside a request (background jobs) nothing is filtered.
const contentGate = require('./contentGate')
const parental = require('./parentalControls')
const libraryShares = require('./libraryShares')
const publicApi = require('./publicApi') // the versioned, read-only /api/v1 contract
const apiKeys = require('./apiKeys') // scoped, revocable personal API keys (only ever accepted by /api/v1)
const viewerExchange = require('./viewerExchange') // POST /api/viewer-session: a Worker viewer token for an API token
const webhooks = require('./webhooks') // signed outbound webhooks (fire-and-forget, owner-visible delivery log)
const webhookFormats = require('./webhookFormats') // ntfy / Discord / Slack / Gotify / Pushover bodies for webhooks
const metrics = require('./metrics') // Prometheus text for /metrics (off until the owner turns it on)
const eventStream = require('./eventStream') // GET /api/v1/events: playback events as Server-Sent Events
const externalIdsModule = require('./externalIds') // TMDB id -> IMDb / TVDB id cache for playback events
const scanMoviesMulti = (dirs) => contentGate.filterForRequest('movies', rawScanMoviesMulti(dirs))
const scanTvShowsMulti = (dirs) => contentGate.filterForRequest('tv', rawScanTvShowsMulti(dirs))
const history = require('./history')
const viewingPrivacy = require('./viewingPrivacy')
const viewingPrivacyWeb = require('./viewingPrivacyWeb')
const apiKeysWeb = require('./apiKeysWeb') // the "My API keys" page: anyone makes and removes their own keys
const twoFactor = require('./twoFactor') // authenticator-app second step at sign-in
const authSessions = require('./authSessions') // the signed-in devices list and per-device revoke
const securityLog = require('./securityLog') // the owner's account-security event log
const resetCodes = require('./resetCodes') // owner-issued one-time password reset codes (no email needed)
const passwordPolicy = require('./passwordPolicy')
const accountSecurityWeb = require('./accountSecurityWeb')
const watchedState = require('./watchedState')
const { episodeGaps } = require('./episodeGaps')
const libraryClear = require('./libraryClear')
const mailer = require('./mailer')
const convert = require('./convert')
// Quality & audio picker: live HLS conversion, track lists, online subtitle search (playbackApi.js).
const playbackApiModule = require('./playbackApi')
const movieVersions = require('./movieVersions') // several files of one film -> one library entry + `versions`
const tracksLib = require('./playbackTracks') // sameLanguage(), for the subtitle sweep below
const subtitleSweep = require('./subtitleSweep') // whole-library "Search online", batched, atop playbackApiModule
const metadataSweep = require('./metadataSweep') // whole-library TMDB catch-up for files still unanswered, batched, atop tmdbLookup
const markerModel = require('./markerModel') // intro/credits guards + viewer-vs-auto precedence
const introDetectJob = require('./introDetectJob') // background auto-detection of intros and credits
const aiSubtitles = require('./aiSubtitles') // "Name.en.ai.srt" naming + the "(AI-generated)" label
// Away-from-home plan -> max quality mapping (pure; see the file for the fail-closed rule).
const awayQualityPolicy = require('./awayQualityPolicy')
const playbackWebUi = require('./playbackWebUi')
const cinemaMode = require('./cinemaMode') // Cinema Mode: pre-show trailers before a film (docs/CINEMA-MODE.md)
const cinemaModeWeb = require('./cinemaModeWeb')
const watchTogetherRooms = require('./watchTogether') // Watch together: rooms of people watching one title in step
const watchTogetherHttp = require('./watchTogetherHttp')
const watchTogetherWeb = require('./watchTogetherWeb')
const movieNightRooms = require('./movieNight') // Movie Night: the TV hub, guests on phones, games made from the cached library
const movieNightHttp = require('./movieNightHttp')
const movieNightWeb = require('./movieNightWeb')
const movieNightLibrary = require('./movieNightLibrary')
const phoneSpeakersServer = require('./phoneSpeakersServer') // Phone speakers: guests' phones play the film's surround channels (phoneSpeakers*.js)
const phoneSpeakersWeb = require('./phoneSpeakersWeb')
const { qrSvg: phoneSpeakersQrSvg } = require('./qrSvg')
const playabilityScan = require('./playabilityScan')
const backup = require('./backup') // admin Backup tab: download / restore
const schoolReport = require('./schoolReport') // BeeboSchool printable report page renderer
const { schoolBody } = require('./schoolPage') // BeeboSchool kid-facing lessons page
// on-disk TMDB cache shared with the desktop app's offline prefetch — lets the
// website itself run with zero internet once that cache is populated. Named
// tmdbFileCache locally to avoid colliding with the in-memory tmdbCache Map below.
const tmdbFileCache = require('./tmdbCache')
const metadataMerge = require('./metadataMerge')
const metadataOverrides = require('./metadataOverrides')
const artworkPicker = require('./artworkPicker')
// on-disk ffprobe-detected resolution cache written by the desktop app
// (getVideoQualityBatch in main.js). The website only ever READS it — no
// ffprobe runs from the web path; files the desktop hasn't probed yet simply
// render without a quality badge.
const videoQuality = require('./videoQuality')
// Franchise grouping (the Sequels view and /api/collections read the same one)
// and the pure half of "Request a title": status, arrival matching, rate limit.
const collections = require('./collections')
const titleRequests = require('./titleRequests')
// The phone's actor page: "Not in your library" (the desktop gap-list ranking),
// ▶ trailers, and the owner's chosen look-it-up site.
const actorGaps = require('./actorGaps')
// Playlists and smart playlists (storage + rules, the library bridge, the HTTP contract).
const playlists = require('./playlists')
const playlistCatalog = require('./playlistCatalog')
const playlistApi = require('./playlistApi')
const playlistWeb = require('./playlistWeb')
const trailers = require('./trailers')
// The owner's server dashboard (Now playing, Activity, Library, Server health, Bandwidth).
const serverDashboardModule = require('./serverDashboard')
const searchSites = require('./searchSites')
// The Music library: songs, albums, artists, lyrics and the /api/music routes (musicApi.js).
const musicLibrary = require('./musicLibrary')
const musicTranscode = require('./musicTranscode')
const musicApi = require('./musicApi')
// Podcasts and Internet radio: services, their /api routes, and the SSRF-guarded client they fetch with.
const outboundFetch = require('./outboundFetch')
const podcastService = require('./podcastService')
const podcastApi = require('./podcastApi')
const radioBrowser = require('./radioBrowser')
const radioService = require('./radioService')
const radioApi = require('./radioApi')
// The Audiobooks library: books, chapters, series, per-person progress and the /api/audiobooks routes.
const audiobookLibrary = require('./audiobookLibrary')
const audiobookProgress = require('./audiobookProgress')
const audiobookMetadata = require('./audiobookMetadata')
const audiobookApi = require('./audiobookApi')
// The Jellyfin-compatible API mode (electron/jellyfin/, off unless the owner turns it on).
const jellyfinCompatModule = require('./jellyfin')
const partyRoom = require('./partyRoom') // car watch-party rooms: CSPRNG codes + join keys, lockout, text hygiene
const httpSecurity = require('./httpSecurity') // Host allowlist, cookie flags, cross-site guard, security headers
const safePath = require('./safePath') // names from other devices -> safe path segments (Windows device names etc.)
const safeFfmpeg = require('./ffmpegArgs') // file: prefix + -protocol_whitelist for ffmpeg/ffprobe inputs
const jsonForScript = httpSecurity.jsonForScript // JSON that is safe inside an inline <script> ('<' etc. escaped)
// Whether automatic background work (intro scan, conversions, rescans, sweeps) should wait: someone watching, battery power, a busy PC.
const backgroundGate = require('./backgroundGate')
const compressJson = require('./compressJson') // gzip for big JSON lists
// One collator for every title sort: localeCompare(a, undefined, options) builds a new one per comparison (same order, several times slower).
const TITLE_COLLATOR = new Intl.Collator(undefined, { sensitivity: 'base' })
const parseMemo = require('./parseMemo') // remembers pure per-file-name parses so a 40,000-episode list is not re-parsed on every request
// Live TV and DVR on the owner's own HDHomeRun tuner (electron/liveTv/); every route is behind login and off until set up.
const liveTvModule = require('./liveTv')
let liveTvNavVisible = false
const corsPolicyModule = require('./corsPolicy')

// Best-effort client IP — this server isn't behind a reverse proxy (it's
// reached directly, e.g. over a VPN or on the same network), so the raw socket address is the
// real one; no need to trust forwarded-for headers (which a client could set
// arbitrarily anyway). Strips the "::ffff:" prefix Node adds for IPv4 addresses
// seen over a dual-stack socket, so "::ffff:100.x.x.x" reads as "100.x.x.x".
// The one exception: away-from-home requests all arrive from the host agent on
// 127.0.0.1, and it vouches for the real viewer with a secret only it was given
// (startStreamServer's agentSecret). See viewerIdentity.js.
const viewerIdentity = require('./viewerIdentity')
let AGENT_SECRET = ''
function getClientIp(req) {
  return viewerIdentity.clientIp(req, AGENT_SECRET)
}

const MIME = {
  mp4: 'video/mp4',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  wmv: 'video/x-ms-wmv',
  m4v: 'video/mp4'
}
const PORT = 47811
// The port actually bound, which the owner may change in Settings. PORT stays
// the default so every existing install keeps the address its phones already
// know. Set once, in startStreamServer, before anything reads it.
let ACTIVE_PORT = PORT
// Where the listening socket binds. Every interface unless the headless server
// (headless/main.js) is told to bind one address via BEEBO_BIND_ADDRESS.
const BIND_ADDRESS = process.env.BEEBO_BIND_ADDRESS || '0.0.0.0'
// Functions run at the very top of every request, before any route: return
// true after taking over the response. Registered by the headless server for
// its first-run setup page; the desktop app registers none.
const preRequestHooks = []
function addPreRequestHook(fn) {
  if (typeof fn === 'function') preRequestHooks.push(fn)
}
const SESSION_COOKIE = 'beebo_session'

// in-memory cache of fileName -> TMDB result (or null if no match)
const tmdbCache = new Map()
// in-memory cache of TMDB movie id -> top cast names
const creditsCache = new Map()
// in-memory cache of show key -> TMDB tv result (or null if no match)
const tvCache = new Map()

function decodeId(id) {
  return Buffer.from(id, 'base64url').toString('utf8')
}

// Builds the address to put in an email link (verify, password reset) from what
// this server is CONFIGURED as, never from the request. It used to use the Host
// header, so anyone reaching the port directly could post /forgot-password for
// a victim with `Host: evil.example` and have the reset token mailed as a link
// to their own site (security review #20). In order:
//   1. <name>.beebo.tv, once the owner's account name is known;
//   2. the configured domain (DuckDNS etc.) on the server's port — https once a
//      certificate is live, since plain http would only be redirected;
//   3. this PC's LAN address.
function emailLinkOrigin({ publicName, certDomain, tlsActive, port, lanIp } = {}) {
  const name = String(publicName || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30)
  if (name) return `https://${name}.beebo.tv`
  const p = Number(port) || PORT
  const domain = String(certDomain || '').trim().toLowerCase()
  if (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
    const scheme = tlsActive ? 'https' : 'http'
    const defaultPort = tlsActive ? 443 : 80
    return `${scheme}://${domain}${p === defaultPort ? '' : ':' + p}`
  }
  return `http://${lanIp || '127.0.0.1'}:${p}`
}

// This PC's private IPv4 address for LAN links, or ''.
function lanIPv4() {
  try {
    for (const list of Object.values(require('os').networkInterfaces())) {
      for (const a of list || []) {
        if ((a.family === 'IPv4' || a.family === 4) && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) return a.address
      }
    }
  } catch {}
  return ''
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

// The auto-converter writes its output as "<base> (converted).mp4" when a
// different <base>.mp4 already existed, so the converted copy would not clobber
// the original. That " (converted)" suffix is a bookkeeping marker, never part
// of the real title \u2014 strip it before any title/episode parsing so a converted
// episode shows its true name ("House S01E02") instead of "(converted)".
function stripConvertedTag(name) {
  return titleParse.stripConvertedTag(name)
}

function cleanTitle(fileName) {
  return titleParse.cleanTitle(fileName)
}

// Path -> addedAt for anything uploaded/imported in the last 7 days — same
// underlying `recentlyAdded` store key the desktop app's NEW badge reads,
// shared here since both run in the same Electron main process/store.
function getRecentlyAddedMap(store) {
  const threshold = Date.now() - 7 * 24 * 60 * 60 * 1000
  const map = new Map()
  ;(store.get('recentlyAdded') || []).forEach((r) => {
    if (r.addedAt > threshold) map.set(path.resolve(r.path), r.addedAt)
  })
  return map
}

const ALPHABET = ['#', ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split('')]

function alphabetBarTop(availableLetters) {
  return `<div class="beebo-alphabet" role="navigation" aria-label="Jump to title letter" style="position:sticky;top:0;z-index:5;display:flex;flex-wrap:wrap;gap:4px;padding:8px 10px;background:#171a21;border-radius:8px;margin-bottom:16px;box-shadow:0 4px 8px rgba(0,0,0,0.4);">${ALPHABET.map(
    (letter) =>
      availableLetters.has(letter)
        ? `<a href="#letter-${letter}" style="color:#eee;font-size:12px;font-weight:600;padding:3px 6px;border-radius:4px;text-decoration:none;">${letter}</a>`
        : `<span style="color:#4a4f58;font-size:12px;font-weight:600;padding:3px 6px;">${letter}</span>`
  ).join('')}</div>`
}

function alphabetRailSide(availableLetters) {
  return `<div class="beebo-alphabet-rail" style="position:sticky;top:100px;align-self:flex-start;display:flex;flex-direction:column;align-items:center;gap:1px;padding:6px 4px;background:#171a21;border-radius:8px;flex-shrink:0;font-size:11px;font-weight:600;">${ALPHABET.map(
    (letter) =>
      availableLetters.has(letter)
        ? `<a href="#letter-${letter}" style="color:#eee;text-decoration:none;padding:1px 4px;">${letter}</a>`
        : `<span style="color:#4a4f58;padding:1px 4px;">${letter}</span>`
  ).join('')}</div>`
}

// `images` (optional) is a tmdbFileCache.localImageIndex for the current render,
// so a grid of hundreds of cards lists the folder once instead of an existsSync
// per image. Same answer either way.
// TMDB hands back image paths like '/abc123.jpg'. They end up in <img src="...">, so anything that is
// not a plain one-segment file name is dropped rather than trusted (a poisoned cache entry must not
// be able to add attributes to the tag).
function tmdbImageUrl(size, imagePath) {
  const p = String(imagePath == null ? '' : imagePath)
  return /^\/[A-Za-z0-9_.-]{1,100}$/.test(p) ? `https://image.tmdb.org/t/p/${size}${p}` : null
}
function posterUrl(cacheDir, movieId, posterPath, images) {
  const custom = metadataOverrides.customArtUrl(posterPath)
  if (custom) return custom
  if (cacheDir && (images ? images.hasPoster(movieId) : tmdbFileCache.localPosterPath(cacheDir, movieId)) && /^\d{1,12}$/.test(String(movieId))) return `/media/poster/${movieId}.jpg`
  return tmdbImageUrl('w300', posterPath)
}

function actorPhotoUrl(cacheDir, personId, profilePath, images) {
  if (cacheDir && (images ? images.hasActorPhoto(personId) : tmdbFileCache.localActorPhotoPath(cacheDir, personId)) && /^\d{1,12}$/.test(String(personId))) return `/media/actor/${personId}.jpg`
  return tmdbImageUrl('w185', profilePath)
}

// --- Short-lived signed media tokens ---
// A Chromecast / AirPlay TV fetches the video URL itself, without the phone's
// login cookie, so /file and /tvfile accept an `mt` token as an alternative.
// The token is an HMAC over the media id + expiry, signed with a secret that
// is generated once and kept in the settings store.
// Memoized after the first read (same for apiTokenSecret below): these are
// read per movie by movieStreamPath/makeMediaToken and per /api/* request,
// and electron-store re-reads + re-parses config.json on every get(). Neither
// secret is ever rotated in-app — the only thing that can change one under
// us is a whole-store restore (backup.importBackup), which calls
// forgetSecrets() so the next use re-reads.
let mediaTokenSecretMemo = null
function mediaTokenSecret(store) {
  if (mediaTokenSecretMemo) return mediaTokenSecretMemo
  let s = store.get('mediaTokenSecret')
  if (!s) {
    s = crypto.randomBytes(32).toString('hex')
    store.set('mediaTokenSecret', s)
  }
  mediaTokenSecretMemo = s
  return s
}

function forgetSecrets() {
  mediaTokenSecretMemo = null
  apiTokenSecretMemo = null
}

function makeMediaToken(store, id) {
  const exp = Date.now() + 12 * 60 * 60 * 1000 // valid for 12 hours
  // Minted while a limited viewer (a restricted profile, a share guest) is asking: the token
  // is bound to that viewer, so /file re-checks their limits on every request and a copied
  // or guessed id can't be played with it. "exp.sig.scope" - opaque to every client.
  const scope = contentGate.mediaScopeForRequest()
  if (scope) {
    const sig = crypto.createHmac('sha256', mediaTokenSecret(store)).update(`${id}|${exp}|${scope}`).digest('base64url')
    return `${exp}.${sig}.${Buffer.from(scope, 'utf8').toString('base64url')}`
  }
  const sig = crypto.createHmac('sha256', mediaTokenSecret(store)).update(`${id}|${exp}`).digest('base64url')
  return `${exp}.${sig}`
}

// -> { ok: false } | { ok: true, scope: '' | 'u:<userId>' | 's:<shareId>' }
function checkMediaToken(store, id, token) {
  if (!id || !token || typeof token !== 'string') return { ok: false }
  const parts = token.split('.')
  if (parts.length === 2) return { ok: verifyMediaToken(store, id, token), scope: '' }
  if (parts.length !== 3) return { ok: false }
  const exp = parseInt(parts[0], 10)
  if (!Number.isFinite(exp) || String(exp) !== parts[0] || Date.now() > exp) return { ok: false }
  let scope = ''
  try { scope = Buffer.from(parts[2], 'base64url').toString('utf8') } catch { return { ok: false } }
  if (!/^(u:[^|]{1,128}|s:sh_[a-f0-9]{16})$/.test(scope)) return { ok: false }
  const expect = crypto.createHmac('sha256', mediaTokenSecret(store)).update(`${id}|${exp}|${scope}`).digest('base64url')
  const a = Buffer.from(parts[1])
  const b = Buffer.from(expect)
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? { ok: true, scope } : { ok: false }
}

// The phone app can send the media token as this header instead of `mt=` when
// it plays a stream itself, so the token stays out of the URL. Every response
// carries MEDIA_TOKEN_HEADER_CAPABILITY so the app knows this server reads it
// and an older server keeps getting the URL form. Browsers' <video> and Cast
// receivers cannot set headers, so `mt=` in the URL stays fully supported.
const MEDIA_TOKEN_HEADER = 'x-beebo-media-token'
const MEDIA_TOKEN_HEADER_CAPABILITY = 'X-Beebo-Media-Token-Header'

// A URL is what logs, proxies and crash reports write down, and a media token
// in one is a working link for 12 hours. Anything this server logs goes through
// here first (startStreamServer wraps its log callback), so a future log line
// that includes a request URL cannot leak `mt=` or a login token.
const SECRET_QUERY_RE = /([?&](?:mt|token|access_token|api_key|apikey|password|pass|pw|secret|sig|signature|license|licensekey|license_key|code|wt)=)[^&#\s"'<>]*/gi
function redactSecrets(text) {
  return playbackApiModule.redactTickets(String(text).replace(SECRET_QUERY_RE, '$1[redacted]'))
}

function verifyMediaToken(store, id, token) {
  if (!id || !token) return false
  const dot = token.indexOf('.')
  if (dot < 1) return false
  // A viewer-bound token is only ever accepted through checkMediaToken, with its scope.
  if (token.indexOf('.', dot + 1) !== -1) return false
  const exp = parseInt(token.slice(0, dot), 10)
  const sig = token.slice(dot + 1)
  if (!Number.isFinite(exp) || Date.now() > exp) return false
  const expect = crypto.createHmac('sha256', mediaTokenSecret(store)).update(`${id}|${exp}`).digest('base64url')
  const a = Buffer.from(sig)
  const b = Buffer.from(expect)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

// --- Resumable upload ids ---
// Same secret-in-the-settings-store pattern as mediaTokenSecret above, but
// with its own key so the two can be rotated independently.
function uploadIdSecret(store) {
  let s = store.get('uploadIdSecret')
  if (!s) {
    s = crypto.randomBytes(32).toString('hex')
    store.set('uploadIdSecret', s)
  }
  return s
}

// The id for a resumable upload is DERIVED from the file rather than random,
// so the same file dropped again — after a browser reload, a crash, or the
// laptop going to sleep — resolves to the same half-written .part file and
// picks up where it left off instead of starting a second copy. Name + size
// together is what the browser can offer us before a single byte is sent.
// It doubles as the finish-time size check: the assembled file is only
// accepted if hashing its on-disk size back reproduces the same id.
function uploadIdFor(store, name, size) {
  return crypto
    .createHmac('sha256', uploadIdSecret(store))
    .update(`${String(name)}|${Number(size)}`)
    .digest('hex')
    .slice(0, 32)
}

// Anything that reaches the filesystem as "<id>.part" must match this exactly,
// so a crafted uploadId ("../../etc/passwd") can never escape the parts dir.
const UPLOAD_ID_RE = /^[a-f0-9]{16,64}$/

// The resumable endpoints always answer JSON, including for logged-out
// callers — see the guard in the request handler.
const RESUMABLE_UPLOAD_PATHS = new Set([
  '/upload/begin',
  '/upload/status',
  '/upload/chunk',
  '/upload/finish',
  '/upload/cancel'
])

// Routes that read the film / episode lists (directly, or through up-next, markers, history
// rows, surf pools, subtitles...). Each one primes the library cache before it runs so its
// reads never walk the disk on the main thread. A route missing from here still gives the same
// answer: its read walks synchronously, as every read used to, and the server log says so once.
// /file and /tvfile are not here: a seek looks its one file up with library.find*().
// The film and episode lists go stale separately (an episode still being copied in keeps the TV
// list out of date), so the two lists that read only one of them prime only that one.
const API_LIBRARY_ROUTES = new Map([
  ['/api/movies', 'movies'], ['/api/tvshows', 'tv'], ['/api/collections', 'movies'],
  // Watched marks resolve ids against the library (a show key into its episodes).
  ['/api/watched/movie', 'movies'], ['/api/watched/episode', 'tv'], ['/api/watched/season', 'tv'],
  ['/api/watched/show', 'tv'], ['/api/watched', 'both'], ['/api/library-status', 'both'],
  ...['/api/upnext', '/api/credits', '/api/markers', '/api/episode-context', '/api/surf/genres',
    '/api/surf/years', '/api/surf', '/api/flag-quality', '/api/watch-session', '/api/continue',
    '/api/history', '/api/recently-added', '/api/recommended', '/api/subtitles', '/api/favorites',
    '/api/party/state'].map((p) => [p, 'both'])
])
const WEB_LIBRARY_ROUTES = new Set([
  '/', '/tvshows', '/tvwatch', '/watch', '/subtitles/file', '/surprise', '/surprise/play',
  '/flag-unplayable', '/flag-quality', '/markers', '/continue'
])

// --- Long-lived signed API bearer tokens (native phone app) ---
// The Android app can't sensibly juggle a browser cookie jar, so /api/* is
// authenticated with an `Authorization: Bearer <token>` header instead. Same
// shape as the media token above (HMAC over "userId|expiry"), but with its own
// secret — 'apiTokenSecret', generated once and kept in the settings store —
// so revoking one class of token never invalidates the other. Deliberately
// separate from the cookie session (auth.signSession / auth.verifySession),
// which is left exactly as it was.
//
// Token wire format is "userId.expiry.sig" (per the phone-app contract), and
// like verifySession it re-checks live user status on every request: a user
// who has been revoked or deleted stops working immediately, no waiting for
// the 365-day expiry.
const API_TOKEN_DAYS = 365

let apiTokenSecretMemo = null
function apiTokenSecret(store) {
  if (apiTokenSecretMemo) return apiTokenSecretMemo
  let s = store.get('apiTokenSecret')
  if (!s) {
    s = crypto.randomBytes(32).toString('hex')
    store.set('apiTokenSecret', s)
  }
  apiTokenSecretMemo = s
  return s
}

// A token made at sign-in carries a session id after the user id ("userId~sid"), which is what
// lets a person see the phone in their device list and sign it out. Tokens without one (made by
// code that has no request to describe) still verify, and are ended by "sign out everywhere".
const API_SID_RE = /^[A-Za-z0-9_-]{22}$/

function makeApiToken(store, userId, days = API_TOKEN_DAYS, session) {
  if (!userId) return null
  let subject = String(userId)
  if (session && session.track) {
    const made = authSessions.create(store, userId, { ip: session.ip, userAgent: session.userAgent, method: session.method || 'password', kind: 'app', days })
    subject = `${userId}~${made.sid}`
  }
  const exp = Date.now() + days * 24 * 60 * 60 * 1000
  const privacySalt = viewingPrivacy.sessionSalt(store, userId)
  const sig = crypto.createHmac('sha256', apiTokenSecret(store)).update(`${subject}|${exp}` + (privacySalt ? `|${privacySalt}` : '')).digest('base64url')
  return `${subject}.${exp}.${sig}`
}

// The session id inside a token, or null. Does not check the token.
function apiTokenSid(token) {
  const m = /^([^.]+)\.\d+\.[^.]+$/.exec(String(token || ''))
  if (!m) return null
  const t = m[1].lastIndexOf('~')
  return t > 0 && API_SID_RE.test(m[1].slice(t + 1)) ? m[1].slice(t + 1) : null
}

// Returns the userId the token belongs to, or null. Never throws.
function verifyApiToken(store, token) {
  if (!token || typeof token !== 'string') return null
  // Split from the right so a userId containing a dot can never confuse this.
  const lastDot = token.lastIndexOf('.')
  if (lastDot < 1) return null
  const prevDot = token.lastIndexOf('.', lastDot - 1)
  if (prevDot < 1) return null
  const subject = token.slice(0, prevDot)
  const expStr = token.slice(prevDot + 1, lastDot)
  const sig = token.slice(lastDot + 1)
  const exp = parseInt(expStr, 10)
  if (!subject || !sig || !Number.isFinite(exp) || String(exp) !== expStr || Date.now() > exp) return null
  let userId = subject
  let sid = null
  const tilde = subject.lastIndexOf('~')
  if (tilde > 0 && API_SID_RE.test(subject.slice(tilde + 1))) {
    userId = subject.slice(0, tilde)
    sid = subject.slice(tilde + 1)
  }
  const privacySalt = viewingPrivacy.sessionSalt(store, userId)
  const expect = crypto.createHmac('sha256', apiTokenSecret(store)).update(`${subject}|${exp}` + (privacySalt ? `|${privacySalt}` : '')).digest('base64url')
  const a = Buffer.from(sig)
  const b = Buffer.from(expect)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  // Same live-status re-check verifySession does — a revoked/deleted account's
  // token is dead the moment the desktop app revokes it.
  let user = null
  try {
    user = auth.getUsers(store).find((u) => u.id === userId) || null
  } catch {
    user = null
  }
  if (!user || user.status !== 'approved') return null
  // Ended by the person from their device list, or by "sign out everywhere".
  try {
    if (sid) {
      if (!authSessions.check(store, userId, sid)) return null
    } else if (authSessions.issuedBeforeCutoff(store, userId, exp - API_TOKEN_DAYS * 24 * 60 * 60 * 1000)) {
      return null
    }
  } catch {}
  return userId
}

// --- Robust HTTP range-request streaming (used by /file and /tvfile) ---
// Correctly handles every Range form browsers send while seeking:
//   bytes=N-      (seek to position N)
//   bytes=N-M     (explicit window, clamped to the file)
//   bytes=-N      (suffix: last N bytes — Safari/iPhone uses this to read
//                  MP4 metadata stored at the end of the file)
// Streams a file into a response and cleans up after the client — the part a
// bare `fs.createReadStream(f).pipe(res)` gets wrong. pipe() only *unpipes*
// when the response closes; the ReadStream itself stays paused with its fd
// open (autoClose only fires on end/error/destroy). Every seek in a browser
// player aborts the previous open-ended `bytes=N-` request, so that leaked one
// fd + a read buffer per seek for the life of the process — and on Windows an
// open handle keeps the video locked, so the converter's delete/rename of a
// file somebody had scrubbed through could fail with EBUSY/EPERM. Destroying
// the stream on `close` releases the fd; a read error mid-stream (file removed
// or drive gone) tears the response down instead of leaving it hanging.
// `opts` goes straight to createReadStream — video callers pass a 1 MB
// highWaterMark (16x fewer read syscalls / event-loop turns than the 64 KB
// default for a 4K stream); small assets keep the default.
function pipeFileToResponse(res, filePath, opts) {
  const rs = fs.createReadStream(filePath, opts)
  res.on('close', () => rs.destroy())
  rs.on('error', () => { try { res.destroy() } catch (e) {} })
  rs.pipe(res)
  return rs
}

const VIDEO_STREAM_OPTS = { highWaterMark: 1 << 20 }

// Ranges, If-Range/ETag, HEAD and 416 live in fileServe.js so a download can resume safely.
function serveVideoFile(req, res, filePath) {
  fileServe.serveFile(req, res, filePath, {
    mime: MIME[path.extname(filePath).slice(1).toLowerCase()] || 'video/mp4',
    streamOpts: VIDEO_STREAM_OPTS
  })
}

// --- Car watch party: guest tokens + a throttled, party-scoped file server ---
// Guests never receive a link to a library file. They stream through /api/party/stream, which only
// serves whatever the host is playing RIGHT NOW, only while the party is live, and paced so the
// file can't be slurped down in bulk. (No streamed video can be perfectly un-capturable, but this
// stops a guest keeping your files.)
function signGuest(store, code, memberId) {
  const exp = Date.now() + 12 * 60 * 60 * 1000
  const sig = crypto.createHmac('sha256', mediaTokenSecret(store)).update(`${code}|${memberId}|${exp}`).digest('base64url')
  return `${memberId}.${exp}.${sig}`
}
function verifyGuest(store, code, token) {
  if (!code || !token) return false
  const parts = String(token).split('.')
  if (parts.length !== 3) return false
  const memberId = parts[0], exp = parseInt(parts[1], 10), sig = parts[2]
  if (!Number.isFinite(exp) || Date.now() > exp) return false
  const expect = crypto.createHmac('sha256', mediaTokenSecret(store)).update(`${code}|${memberId}|${exp}`).digest('base64url')
  const a = Buffer.from(sig), b = Buffer.from(expect)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}
// One Range header for a small file: { start, end } inside the file, or null when it can't be served (the caller answers 416).
// "bytes=-N" is the last N bytes. (The old inline parsers gave a negative Content-Length for "bytes=99999-" and the FIRST
// bytes for "bytes=-5"; security review 2026-09-21, P-12.)
function parseSingleRange(header, total) {
  const m = /^bytes=(\d{0,15})-(\d{0,15})$/.exec(String(header || '').trim())
  if (!m || (m[1] === '' && m[2] === '') || !(total > 0)) return null
  let start, end
  if (m[1] === '') { const n = parseInt(m[2], 10); if (!(n > 0)) return null; start = Math.max(0, total - n); end = total - 1 }
  else { start = parseInt(m[1], 10); end = m[2] !== '' ? Math.min(parseInt(m[2], 10), total - 1) : total - 1 }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= total) return null
  return { start, end }
}
async function serveVideoFileThrottled(req, res, filePath, bytesPerSec) {
  let stat
  try { stat = fs.statSync(filePath) } catch { res.writeHead(404); res.end('Not found'); return }
  const size = stat.size
  const mime = MIME[path.extname(filePath).slice(1).toLowerCase()] || 'video/mp4'
  const range = req.headers.range
  let start = 0, end = size - 1, status = 200, headers
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim())
    if (m && (m[1] !== '' || m[2] !== '')) {
      if (m[1] === '') { const n = parseInt(m[2], 10); start = Math.max(0, size - n); end = size - 1 }
      else { start = parseInt(m[1], 10); end = m[2] !== '' ? Math.min(parseInt(m[2], 10), size - 1) : size - 1 }
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return
    }
    status = 206
    headers = { 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Type': mime }
  } else {
    headers = { 'Content-Length': size, 'Content-Type': mime, 'Accept-Ranges': 'bytes' }
  }
  res.writeHead(status, headers)
  const rs = fs.createReadStream(filePath, { start, end })
  let closed = false
  res.on('close', () => { closed = true; rs.destroy() })
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  try {
    for await (const chunk of rs) {
      if (closed) break
      if (!res.write(chunk)) await new Promise((r) => res.once('drain', r))
      const ms = (chunk.length / bytesPerSec) * 1000
      if (ms > 0) await sleep(ms)
    }
  } catch (e) { /* client aborted — fine */ }
  if (!closed) { try { res.end() } catch (e) {} }
}

// --- Shared video player page (used by /watch and /tvwatch) ---
// Adds Chromecast (Remote Playback API), AirPlay, Picture-in-Picture, and
// Media Session lock-screen/notification controls on top of the basic player.
// `kind` ('movie' | 'tv') and `mediaId` identify the file for the
// /flag-unplayable report the page sends when the video can't be decoded.
//
// Two OPTIONAL extras, both used only by the "Not Sure What To Watch?" channel
// surfer (/surprise/play) and completely inert — not one byte emitted — for the
// plain /watch and /tvwatch pages:
//   * `startFraction` — 0..1; seek to duration * startFraction once, on the
//     first `loadedmetadata`. 0.5 = drop the viewer in halfway through.
//   * `surf` — { backHref, nextHref, restartHref, pickerHref, position, total,
//     filterLabel } — `filterLabel` ("Comedy · 1990s") is optional and just
//     appended to the "N of M" readout so the active surf filters stay visible.
//     renders a bottom control strip (⏮ Back / ⏭ Next / "N of M" / start from
//     the beginning / back to categories) styled like the top bar and hidden by
//     the very same auto-hide, so it never sits over the film while it plays.
// Seconds -> "1:23:45" / "23:45" — the exact wording the resume prompt and the
// Continue Watching rows both use, so one number never reads two ways.
function formatClock(totalSeconds) {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`
}

function playerPage({ src, title, poster, sessionId, kind, mediaId, startFraction, surf, upNext, resume, seekTo, prevItem, episodesHref, markers }) {
  const safeTitle = escapeHtml(title || '')
  // Only a sane fraction inside the clip counts — anything else is dropped so a
  // bad query param can never park the player past the end of the video.
  const startAt =
    typeof startFraction === 'number' && Number.isFinite(startFraction) && startFraction > 0 && startFraction < 1
      ? startFraction
      : null
  // Surf mode owns its own "what's next" (⏭ Next) and deliberately starts
  // halfway in, so neither the up-next countdown nor the resume prompt applies
  // there — a surfed title must behave exactly as it always has.
  const upNextData = !surf && upNext && typeof upNext === 'object' ? upNext : null
  // An explicit ?t= (the Continue Watching "Resume" link) means the viewer has
  // already answered "resume?" — seek straight there and never ask again.
  const seekToAt =
    typeof seekTo === 'number' && Number.isFinite(seekTo) && seekTo > 0 ? seekTo : null
  const resumeAt =
    !surf && seekToAt === null && resume && Number.isFinite(Number(resume.currentTime)) && Number(resume.currentTime) > 0
      ? Number(resume.currentTime)
      : null
  // ⏮ / ⏭ transport. Suppressed on the surf player, which already has its own
  // ⏮ Back / ⏭ Next meaning "another random pick" — two different Backs in one
  // chrome would be indefensible.
  const prevHref = !surf && prevItem && prevItem.href ? String(prevItem.href) : ''
  const nextHref = upNextData && upNextData.available && upNextData.href ? String(upNextData.href) : ''
  const showTransport = !surf
  const episodesLink = !surf && episodesHref ? String(episodesHref) : ''
  // Viewer-set intro/credits markers. Off entirely in surf mode, which
  // deliberately drops you halfway in and has its own idea of "next".
  const showMarkers = !surf
  // The intro is a WINDOW when its start is known (auto-detected ones always are; a viewer's only if
  // they saved a start): a "Skip intro" button while playback is inside it. With only an end, it
  // behaves as it always has - jump past it once on load, with an undo.
  const introStartAt = !surf && markers ? sanitizeIntroStart(markers.introStartSeconds, null) : null
  const introEndAt =
    !surf && markers
      ? introStartAt !== null
        ? sanitizeIntroEndWithStart(markers.introEndSeconds, introStartAt, null)
        : sanitizeIntroEnd(markers.introEndSeconds, null)
      : null
  const introWindow = introStartAt !== null && introEndAt !== null
  const creditsStartAt = !surf && markers ? sanitizeCreditsStart(markers.creditsStartSeconds, null) : null
  // Where the credits marker came from: an auto-detected one never advances to the next episode on
  // its own (a wrong guess must not throw someone out of the ending), it offers a button instead.
  const creditsAutoSource = !surf && !!markers && markers.creditsSource === 'auto'
  // Never auto-skip over a position the viewer explicitly asked for: an
  // explicit ?t=, or a pending "Resume / Start over" question they haven't
  // answered yet (either answer means "put me exactly there").
  const autoSkipIntro = introEndAt !== null && !introWindow && seekToAt === null && resumeAt === null
  const surfCss = surf
    ? `
  /* sits just above the native control bar so the seek bar stays reachable */
  #surfbar{position:fixed;left:0;right:0;bottom:52px;display:flex;align-items:center;justify-content:center;
    flex-wrap:wrap;gap:10px;padding:10px 12px;color:#fff;font-family:system-ui,sans-serif;z-index:10;
    transition:opacity .3s}
  #surfbar.hidden{opacity:0;pointer-events:none}
  /* "Keep watching" stows the whole strip for the rest of this video */
  #surfbar.stowed{display:none}
  #surfbar .pbtn{display:flex;text-decoration:none}
  #surfbar .pos{font-size:12px;color:#b9bec7;text-shadow:0 1px 3px #000}
  /* tiny chip left behind so surfing can be resumed after stowing */
  #surfrestore{position:fixed;right:12px;bottom:56px;display:none;z-index:10;padding:6px 10px;
    border-radius:999px;background:rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.25);
    color:#fff;font-family:system-ui,sans-serif;font-size:13px;cursor:pointer;transition:opacity .3s}
  #surfrestore.hidden{opacity:0;pointer-events:none}`
    : ''
  const surfBarHtml = surf
    ? `
<div id="surfbar">
  <a class="pbtn" href="${escapeHtml(surf.backHref || '#')}" title="Previous random pick">⏮ Back</a>
  <span class="pos">${escapeHtml(String(surf.position || 1))} of ${escapeHtml(String(surf.total || 1))}${
    surf.filterLabel ? ` · ${escapeHtml(String(surf.filterLabel))}` : ''
  }</span>
  <a class="pbtn" href="${escapeHtml(surf.nextHref || '#')}" title="Another random pick">⏭ Next</a>
  <button type="button" id="surfKeep" class="pbtn" title="Stay on this one and hide the surf controls">✓ Keep watching</button>
  <a class="pbtn" href="${escapeHtml(surf.restartHref || '#')}">▶ Start from the beginning</a>${
    surf.pickerHref ? `\n  <a class="pbtn" href="${escapeHtml(surf.pickerHref)}">🎲 Categories</a>` : ''
  }
  <a class="pbtn" href="/" title="Leave surf and go back to your movie list">🎬 Movies</a>
</div>
<button type="button" id="surfrestore" title="Show the surf controls again">🎲 Surf</button>`
    : ''
  // --- "Up next" countdown card (bottom-right, above the native controls) ---
  const upNextCss = upNextData
    ? `
  #upnext{position:fixed;right:12px;bottom:64px;left:12px;max-width:420px;margin-left:auto;display:none;
    z-index:19;padding:14px 16px;border-radius:12px;background:rgba(20,22,28,.96);
    border:1px solid rgba(255,255,255,.22);color:#fff;font-family:system-ui,sans-serif;
    box-shadow:0 8px 28px rgba(0,0,0,.6)}
  #upnext.show{display:block}
  #upnext .un-label{font-size:12px;color:#8a8f98;letter-spacing:.4px;text-transform:uppercase}
  #upnext .un-title{font-size:16px;font-weight:700;margin:4px 0 2px;line-height:1.3}
  #upnext .un-sub{font-size:13px;color:#b9bec7;line-height:1.45}
  #upnext .un-btns{display:flex;gap:10px;margin-top:12px;flex-wrap:wrap}
  #upnext .un-btn{background:#2a2f3a;border:1px solid rgba(255,255,255,.22);border-radius:8px;color:#fff;
    padding:8px 12px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit}
  #upnext .un-btn.primary{background:#4f9dff;border-color:#4f9dff}`
    : ''
  // --- "Resume from …?" prompt (centered over the picture, before playback) ---
  const resumeCss =
    resumeAt === null
      ? ''
      : `
  #resumeprompt{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;
    gap:14px;padding:30px;text-align:center;color:#fff;font-family:system-ui,sans-serif;z-index:18;
    background:rgba(0,0,0,.78)}
  #resumeprompt.gone{display:none}
  #resumeprompt h2{margin:0;font-size:20px;font-weight:700}
  #resumeprompt .rp-btns{display:flex;gap:12px;flex-wrap:wrap;justify-content:center}
  #resumeprompt .rp-btn{background:#2a2f3a;border:1px solid rgba(255,255,255,.22);border-radius:8px;color:#fff;
    padding:11px 16px;font-size:15px;font-weight:600;cursor:pointer;font-family:inherit}
  #resumeprompt .rp-btn.primary{background:#4f9dff;border-color:#4f9dff}`

  const upNextHtml = upNextData
    ? `
<div id="upnext" role="dialog" aria-live="polite">
  ${
    upNextData.available
      ? `<div class="un-label">Up next</div>
  <div class="un-title">${escapeHtml(String(upNextData.title || ''))}</div>
  <div class="un-sub"><span id="unLead">Playing in</span> <span id="unCountWrap"><span id="unCount">10</span>s…</span></div>
  <div class="un-btns">
    <button type="button" id="unPlay" class="un-btn primary">▶ Play now</button>
    <button type="button" id="unCancel" class="un-btn">✕ Cancel</button>
  </div>`
      : `<div class="un-label">Up next</div>
  <div class="un-sub">Next up is <b>${escapeHtml(String(upNextData.title || ''))}</b> — it isn't in your library yet. Reported to the admin.</div>
  <div class="un-btns">
    <button type="button" id="unCancel" class="un-btn">✕ Cancel</button>
  </div>`
  }
</div>`
    : ''

  const resumeHtml =
    resumeAt === null
      ? ''
      : `
<div id="resumeprompt" role="dialog">
  <h2>Resume from ${escapeHtml(formatClock(resumeAt))}?</h2>
  <div class="rp-btns">
    <button type="button" id="rpResume" class="rp-btn primary">▶ Resume</button>
    <button type="button" id="rpRestart" class="rp-btn">↻ Start over</button>
  </div>
</div>`

  // ---- ⏮ / ⏭ transport rule --------------------------------------------
  // ⏮ : more than 5s in -> restart THIS item; at/near the start -> previous
  //     episode / previous collection part (when there is one).
  // ⏭ : straight to the next episode / next part.
  const transportJs = !showTransport
    ? ''
    : `
  const transportPrevHref = ${jsonForScript(prevHref)}
  const transportNextHref = ${jsonForScript(nextHref)}
  const TRANSPORT_RESTART_WINDOW = 5

  function transportLive() {
    // While the screen is off the <audio> element carries playback, so the
    // clock (and the seek) has to be applied to whichever one is live.
    return (typeof bgActive !== 'undefined' && bgActive && bgAudio) ? bgAudio : v
  }

  function transportPrev() {
    const m = transportLive()
    if ((Number(m.currentTime) || 0) > TRANSPORT_RESTART_WINDOW) {
      // Past the window: back to the start of what's already playing.
      try { m.currentTime = 0 } catch (e) {}
      if (m !== v) { try { v.currentTime = 0 } catch (e2) {} }
      m.play().catch(() => {})
      poke()
      return
    }
    if (transportPrevHref) {
      try { report() } catch (e) {}
      location.href = transportPrevHref
    } else {
      // Nothing before this one — restarting is still the sensible answer.
      try { m.currentTime = 0 } catch (e) {}
      poke()
    }
  }

  function transportNext() {
    if (!transportNextHref) return
    try { report() } catch (e) {}
    location.href = transportNextHref
  }

  const prevBtn = document.getElementById('prevBtn')
  if (prevBtn) prevBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); transportPrev() }
  const nextBtn = document.getElementById('nextBtn')
  if (nextBtn) {
    if (!transportNextHref) nextBtn.style.display = 'none'
    nextBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); transportNext() }
  }
`

  // ---- viewer-set intro / credits markers -------------------------------
  const markersJs = !showMarkers
    ? ''
    : `
  const markerIntroStart = ${jsonForScript(introStartAt)}
  const markerIntroEnd = ${jsonForScript(introEndAt)}
  const markerIntroWindow = ${jsonForScript(introWindow)}
  const markerCreditsStart = ${jsonForScript(creditsStartAt)}
  const markerCreditsAuto = ${jsonForScript(creditsAutoSource)}
  const markerAutoSkipIntro = ${jsonForScript(autoSkipIntro)}
  // Same guards the server applies, re-run here because only the browser knows
  // the real duration. A marker failing them is simply treated as unset.
  const MARKER_MAX_INTRO_SECONDS = 300
  const MARKER_MAX_INTRO_FRACTION = 0.25
  const MARKER_MIN_CREDITS_TAIL_SECONDS = 60
  const MARKER_MIN_CREDITS_FRACTION = 0.5

  function markerIntroOk(val, d) {
    if (typeof val !== 'number' || !isFinite(val) || val <= 0) return null
    if (val > MARKER_MAX_INTRO_SECONDS) return null
    if (isFinite(d) && d > 0 && val > d * MARKER_MAX_INTRO_FRACTION) return null
    return val
  }
  function markerCreditsOk(val, d) {
    if (typeof val !== 'number' || !isFinite(val) || val <= 0) return null
    if (!isFinite(d) || d <= 0) return null
    if (val > d - MARKER_MIN_CREDITS_TAIL_SECONDS) return null
    if (val < d * MARKER_MIN_CREDITS_FRACTION) return null
    return val
  }
  // A known START turns the intro into a window: its length (not its position) is what is capped.
  function markerWindowOk(s, e, d) {
    if (typeof s !== 'number' || typeof e !== 'number' || !isFinite(s) || !isFinite(e) || s < 0 || e <= s) return null
    if (e - s > MARKER_MAX_INTRO_SECONDS) return null
    if (isFinite(d) && d > 0 && (s > d * 0.5 || e > d - MARKER_MIN_CREDITS_TAIL_SECONDS)) return null
    return { start: s, end: e }
  }

  function saveMarker(field, seconds, okMsg) {
    const body = { kind: mediaKind, id: mediaId, durationSeconds: Number(v.duration) || 0 }
    body[field] = Math.max(0, Math.floor(Number(seconds) || 0))
    fetch('/markers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(() => { toast(okMsg) }).catch(() => { toast("Couldn't save that just now — try again in a moment.") })
  }

  const introBtn = document.getElementById('introBtn')
  if (introBtn) introBtn.onclick = (e) => {
    e.preventDefault()
    e.stopPropagation()
    const at = Math.floor(Number(transportLive().currentTime) || 0)
    // Pressing it again simply overwrites — correcting a mis-set marker is the
    // same gesture as setting one.
    saveMarker('introEndSeconds', at, 'Saved: the intro ends at ' + at + 's. Everyone will skip straight past it from now on.')
    poke()
  }

  const creditsBtn = document.getElementById('creditsBtn')
  if (creditsBtn) creditsBtn.onclick = (e) => {
    e.preventDefault()
    e.stopPropagation()
    const at = Math.floor(Number(transportLive().currentTime) || 0)
    saveMarker('creditsStartSeconds', at, 'Saved: the credits start at ' + at + 's. The next one will start there instead of waiting them out.')
    poke()
  }

  // ---- auto-skip the opening titles ----
  const introUndoBtn = document.getElementById('introundo')
  let introUndoTimer = null
  function introSkip() {
    if (!markerAutoSkipIntro) return
    const d = Number(v.duration)
    const at = markerIntroOk(markerIntroEnd, d)
    if (at === null) return
    if ((Number(v.currentTime) || 0) >= at) return
    try { v.currentTime = at } catch (e) { return }
    toast('Skipped intro — ↩ undo')
    if (introUndoBtn) {
      introUndoBtn.style.display = 'block'
      clearTimeout(introUndoTimer)
      introUndoTimer = setTimeout(() => { introUndoBtn.style.display = 'none' }, 8000)
    }
    poke()
  }
  if (introUndoBtn) introUndoBtn.onclick = (e) => {
    e.preventDefault()
    e.stopPropagation()
    try { v.currentTime = 0 } catch (e2) {}
    introUndoBtn.style.display = 'none'
    clearTimeout(introUndoTimer)
    toast('Intro restored — playing from the start.')
    v.play().catch(() => {})
  }
  // ---- "Skip intro" button: only while playback is inside the intro window ----
  const skipIntroBtn = document.getElementById('skipIntro')
  if (skipIntroBtn && markerIntroWindow) {
    const syncSkipIntro = () => {
      const w = markerWindowOk(markerIntroStart, markerIntroEnd, Number(v.duration))
      const t = Number(transportLive().currentTime) || 0
      skipIntroBtn.style.display = w && t >= w.start - 0.5 && t < w.end - 1 ? 'block' : 'none'
    }
    skipIntroBtn.onclick = (e) => {
      e.preventDefault()
      e.stopPropagation()
      const w = markerWindowOk(markerIntroStart, markerIntroEnd, Number(v.duration))
      if (!w) return
      try { transportLive().currentTime = w.end } catch (e2) {}
      if (transportLive() !== v) { try { v.currentTime = w.end } catch (e3) {} }
      skipIntroBtn.style.display = 'none'
      poke()
    }
    v.addEventListener('timeupdate', syncSkipIntro)
    v.addEventListener('seeked', syncSkipIntro)
    v.addEventListener('loadedmetadata', syncSkipIntro)
  }
  if (markerAutoSkipIntro) {
    let didIntroSkip = false
    const runIntroSkip = () => {
      if (didIntroSkip) return
      const d = Number(v.duration)
      if (!isFinite(d) || d <= 0) return
      didIntroSkip = true
      introSkip()
    }
    v.addEventListener('loadedmetadata', runIntroSkip)
    if (v.readyState >= 1) runIntroSkip()
  }
`

  const upNextJs = !upNextData
    ? ''
    : `
  // ---- "Up next" ------------------------------------------------------
  // Appears in the last 20 seconds AND on 'ended'. While the screen-off audio
  // handoff is carrying playback nothing is shown and the countdown is frozen:
  // navigating away there would kill the sound the viewer is listening to.
  const upNextAvailable = ${jsonForScript(!!upNextData.available)}
  const upNextHref = ${jsonForScript(String(upNextData.href || ''))}
  const upNextReport = ${jsonForScript(upNextData.report || null)}
  const upNextEl = document.getElementById('upnext')
  const upNextCountEl = document.getElementById('unCount')
  let upNextCancelled = false
  let upNextShown = false
  let upNextTimer = null
  let upNextLeft = 10
  let upNextReported = false
  let upNextManualShown = false

  function upNextBgBusy() {
    return typeof bgActive !== 'undefined' && bgActive
  }

  function upNextGo() {
    if (upNextCancelled || !upNextAvailable || !upNextHref) return
    clearInterval(upNextTimer)
    upNextTimer = null
    try { report() } catch (e) {}
    location.href = upNextHref
  }

  function upNextTick() {
    // Frozen while the audio handoff owns playback.
    if (upNextBgBusy()) return
    upNextLeft -= 1
    if (upNextCountEl) upNextCountEl.textContent = String(Math.max(0, upNextLeft))
    if (upNextLeft <= 0) upNextGo()
  }

  function upNextReportMissing() {
    if (upNextReported || !upNextReport) return
    upNextReported = true
    try {
      fetch('/missing-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(upNextReport)
      }).catch(() => {})
    } catch (e) {}
  }

  // The grace period defaults to the 10s countdown used when we're only GUESSING the
  // end is near (last 20 seconds / natural end). When a viewer has explicitly
  // marked where the credits start there is nothing to guess, so that path
  // passes a short 5s grace and says "playing now" instead of offering a
  // "▶ Play now" button nobody needs to press.
  function upNextStartCountdown(grace, lead) {
    upNextLeft = typeof grace === 'number' && grace > 0 ? grace : 10
    const leadEl = document.getElementById('unLead')
    if (leadEl && lead) leadEl.textContent = lead
    const wrapEl = document.getElementById('unCountWrap')
    if (wrapEl) wrapEl.style.display = ''
    if (upNextCountEl) upNextCountEl.textContent = String(upNextLeft)
    upNextTimer = setInterval(upNextTick, 1000)
  }

  // manual = credits found by the auto-detector: offer "Play now" but wait for the viewer; the normal
  // countdown only starts if the file really reaches its end without them answering.
  function upNextShow(grace, lead, manual) {
    if (upNextCancelled || !upNextEl) return
    if (upNextShown) {
      if (upNextManualShown && !manual && upNextAvailable) { upNextManualShown = false; upNextStartCountdown(grace, lead) }
      return
    }
    if (upNextBgBusy()) return
    if (manual && !upNextAvailable) return
    upNextShown = true
    upNextEl.classList.add('show')
    // An unanswered "Resume from …?" is moot by the time we're at the credits,
    // and its full-screen backdrop would swallow taps on ✕ Cancel.
    try { if (typeof resumeDismiss === 'function') resumeDismiss() } catch (e) {}
    poke()
    if (upNextAvailable) {
      if (manual) {
        upNextManualShown = true
        const leadEl = document.getElementById('unLead')
        if (leadEl) leadEl.textContent = lead || 'The credits have started.'
        const wrapEl = document.getElementById('unCountWrap')
        if (wrapEl) wrapEl.style.display = 'none'
      } else {
        upNextStartCountdown(grace, lead)
      }
    } else {
      upNextReportMissing()
    }
  }

  function upNextHide() {
    upNextCancelled = true
    if (upNextTimer) { clearInterval(upNextTimer); upNextTimer = null }
    if (upNextEl) upNextEl.classList.remove('show')
  }

  v.addEventListener('timeupdate', () => {
    const d = Number(v.duration)
    if (!isFinite(d) || d <= 0) return
    // A viewer-set "credits start here" wins: it fires earlier and advances
    // after a short grace instead of the 10s guess-the-ending countdown.
    if (typeof markerCreditsOk === 'function') {
      const creditsAt = markerCreditsOk(typeof markerCreditsStart === 'number' ? markerCreditsStart : null, d)
      if (creditsAt !== null && v.currentTime >= creditsAt) {
        if (typeof markerCreditsAuto !== 'undefined' && markerCreditsAuto) upNextShow(0, 'The credits have started.', true)
        else upNextShow(5, 'Credits — playing now in')
        return
      }
    }
    if (d - v.currentTime <= 20) upNextShow()
  })
  v.addEventListener('ended', () => upNextShow())

  const unPlayBtn = document.getElementById('unPlay')
  if (unPlayBtn) unPlayBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); upNextGo() }
  const unCancelBtn = document.getElementById('unCancel')
  if (unCancelBtn) unCancelBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); upNextHide() }
`

  const resumeJs =
    resumeAt === null
      ? ''
      : `
  // ---- "Resume from …?" -------------------------------------------------
  // Never seeks on its own — the viewer picks. Nothing here touches playback
  // until one of the two buttons is pressed.
  const resumeAt = ${jsonForScript(resumeAt)}
  const resumeEl = document.getElementById('resumeprompt')
  function resumeDismiss() { if (resumeEl) resumeEl.classList.add('gone') }
  const rpResume = document.getElementById('rpResume')
  if (rpResume) rpResume.onclick = (e) => {
    e.preventDefault()
    e.stopPropagation()
    try { v.currentTime = resumeAt } catch (e2) {}
    resumeDismiss()
    v.play().catch(() => {})
  }
  const rpRestart = document.getElementById('rpRestart')
  if (rpRestart) rpRestart.onclick = (e) => {
    e.preventDefault()
    e.stopPropagation()
    try { v.currentTime = 0 } catch (e2) {}
    resumeDismiss()
    v.play().catch(() => {})
  }
`

  const seekToJs =
    seekToAt === null
      ? ''
      : `
  // ---- ?t= deep link (Continue Watching's Resume link) ------------------
  const seekToAt = ${jsonForScript(seekToAt)}
  let didSeekTo = false
  function applySeekTo() {
    if (didSeekTo) return
    const d = Number(v.duration)
    if (!isFinite(d) || d <= 0) return
    didSeekTo = true
    try { v.currentTime = Math.min(seekToAt, Math.max(0, d - 1)) } catch (e) {}
  }
  v.addEventListener('loadedmetadata', applySeekTo)
  if (v.readyState >= 1) applySeekTo()
`

  const startFractionJs =
    startAt === null
      ? ''
      : `
  // ---- channel-surf: start halfway through (once, on first metadata) ----
  const startFraction = ${jsonForScript(startAt)}
  let didSeekStart = false
  v.addEventListener('loadedmetadata', () => {
    if (didSeekStart) return
    const d = Number(v.duration)
    if (!isFinite(d) || d <= 0) return
    didSeekStart = true
    try { v.currentTime = d * startFraction } catch (e) {}
  })
`
  const surfJs = surf
    ? `
  // ---- channel-surf strip follows the top bar's show/hide exactly ----
  const surfBar = document.getElementById('surfbar')
  const surfRestore = document.getElementById('surfrestore')
  if (surfBar) {
    const syncSurf = () => {
      const hidden = bar.classList.contains('hidden')
      surfBar.classList.toggle('hidden', hidden)
      if (surfRestore) surfRestore.classList.toggle('hidden', hidden)
    }
    try { new MutationObserver(syncSurf).observe(bar, { attributes: true, attributeFilter: ['class'] }) } catch (e) {}
    syncSurf()

    // "✓ Keep watching" — the viewer has settled on this pick. Stow Back/Next/
    // Start-from-the-beginning WITHOUT touching playback (no seek, no reload),
    // leaving a small chip to bring the surf controls back.
    const keepBtn = document.getElementById('surfKeep')
    if (keepBtn && surfRestore) {
      keepBtn.onclick = (e) => {
        e.preventDefault()
        e.stopPropagation()
        surfBar.classList.add('stowed')
        surfRestore.style.display = 'block'
        poke()
      }
      surfRestore.onclick = (e) => {
        e.preventDefault()
        e.stopPropagation()
        surfBar.classList.remove('stowed')
        surfRestore.style.display = 'none'
        poke()
      }
    }
  }
`
    : ''
  return `<!doctype html><html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${safeTitle}</title>
${pwa.playerHead()}
<style>
  html,body{margin:0;background:#000;height:100%;overflow:hidden}
  /* 100dvh = the *visible* viewport on mobile (100vh includes the space behind
     the browser's address bar, which pushes the native seek bar off-screen) */
  video{width:100%;height:100vh;height:100dvh;background:#000}
  /* wraps onto a second row rather than pushing controls off a phone screen —
     the chrome now carries transport, marker and cast buttons together */
  #bar{position:fixed;top:0;left:0;right:0;display:flex;align-items:center;flex-wrap:wrap;gap:8px 10px;
    padding:10px 12px;background:linear-gradient(rgba(0,0,0,.75),rgba(0,0,0,0));color:#fff;
    font-family:system-ui,sans-serif;z-index:10;transition:opacity .3s}
  #bar .title{flex:1 1 100%}
  #bar.hidden{opacity:0;pointer-events:none}
  #bar .title{flex:1 1 100%;order:-1;text-align:center;font-size:15px;font-weight:600;line-height:1.3;text-shadow:0 1px 3px #000;padding:0 4px;overflow-wrap:anywhere}
  .pbtn{background:rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.25);border-radius:8px;color:#fff;
    padding:7px 10px;font-size:13px;display:none;align-items:center;gap:6px;cursor:pointer}
  .pbtn svg{width:18px;height:18px;fill:currentColor;display:block}
  #err{position:fixed;inset:0;display:none;flex-direction:column;align-items:center;justify-content:center;
    gap:10px;padding:30px;text-align:center;color:#fff;font-family:system-ui,sans-serif;z-index:5;
    background:rgba(0,0,0,.85)}
  #err h2{margin:0;font-size:19px}
  #toast{position:fixed;left:12px;right:12px;bottom:70px;display:none;z-index:20;padding:12px 14px;
    border-radius:10px;background:rgba(20,22,28,.95);border:1px solid rgba(255,255,255,.2);
    color:#fff;font-family:system-ui,sans-serif;font-size:13.5px;line-height:1.45;text-align:center}
  #err p{margin:0;font-size:14px;color:#b9bec7;max-width:420px;line-height:1.5}${
    introWindow
      ? `
  #skipIntro{position:fixed;right:12px;bottom:118px;display:none;z-index:21;
    padding:9px 16px;border-radius:8px;background:rgba(20,22,28,.95);border:1px solid rgba(255,255,255,.35);
    color:#fff;font-family:system-ui,sans-serif;font-size:14px;font-weight:700;cursor:pointer}`
      : ''
  }${
    autoSkipIntro
      ? `
  #introundo{position:fixed;left:50%;transform:translateX(-50%);bottom:118px;display:none;z-index:21;
    padding:8px 14px;border-radius:999px;background:rgba(20,22,28,.95);border:1px solid rgba(255,255,255,.28);
    color:#fff;font-family:system-ui,sans-serif;font-size:13.5px;font-weight:600;cursor:pointer}`
      : ''
  }${surfCss}${upNextCss}${resumeCss}${browserChrome.playerStyles}
</style></head>
<body>
<div id="bar">
  <a class="pbtn" style="display:flex" href="${kind === 'tv' ? '/tvshows' : '/'}" aria-label="Back to library">← Library</a>
  <span class="title">${safeTitle}</span>${
    showTransport
      ? `
  <button id="prevBtn" class="pbtn" style="display:flex" title="Restart this one — press again at the start for the previous ${
    kind === 'tv' ? 'episode' : 'film'
  }">⏮</button>
  <button id="nextBtn" class="pbtn"${nextHref ? ' style="display:flex"' : ''} title="Play the next ${
    kind === 'tv' ? 'episode' : 'film'
  }">⏭</button>`
      : ''
  }${
    episodesLink
      ? `
  <a id="epsBtn" class="pbtn" style="display:flex;text-decoration:none;" href="${escapeHtml(
    episodesLink
  )}" title="See every episode of this show">📺 All episodes</a>`
      : ''
  }
  <button id="castBtn" class="pbtn" title="Cast to TV"><svg viewBox="0 0 24 24"><path d="M1 18v3h3a3 3 0 0 0-3-3Zm0-4v2a5 5 0 0 1 5 5h2a7 7 0 0 0-7-7Zm0-4v2a9 9 0 0 1 9 9h2A11 11 0 0 0 1 10Zm20-7H3a2 2 0 0 0-2 2v3h2V5h18v14h-7v2h7a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2Z"/></svg>Cast</button>
  <button id="airBtn" class="pbtn" title="AirPlay"><svg viewBox="0 0 24 24"><path d="M6 22h12l-6-7-6 7ZM21 3H3a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4v-2H3V5h18v12h-4v2h4a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2Z"/></svg>AirPlay</button>
  <button id="pipBtn" class="pbtn" title="Picture in picture"><svg viewBox="0 0 24 24"><path d="M19 11h-8v6h8v-6Zm4 8.02V4.98A1.98 1.98 0 0 0 21.02 3H2.98A1.98 1.98 0 0 0 1 4.98v14.04C1 20.11 1.89 21 2.98 21h18.04A1.98 1.98 0 0 0 23 19.02ZM21 19.03H3V4.97h18v14.06Z"/></svg>PiP</button>
  <button id="bgBtn" class="pbtn" style="display:flex" title="Keep the sound playing when the screen turns off" aria-pressed="false">🎧 Screen off: Off</button>
  <button id="flagBtn" class="pbtn" style="display:flex" title="Report bad video quality">⚠️ Bad quality</button>${
    showMarkers
      ? `
  <button id="introBtn" class="pbtn" style="display:flex" title="Save this moment as the end of the opening titles — everyone watching ${
    kind === 'tv' ? 'this show' : 'this film'
  } will skip straight past it from now on">⤴ Intro ends here</button>
  <button id="creditsBtn" class="pbtn" style="display:flex" title="Save this moment as the start of the closing credits — the next one will start here instead of waiting them out">⏭ Credits start here</button>`
      : ''
  }
</div>
<video id="v" src="${src}" controls autoplay playsinline x-webkit-airplay="allow"${poster ? ` poster="${poster}"` : ''}></video>${!surf && mediaId ? cinemaModeWeb.cinemaHtml({ kind, mediaId }) : ''}
<div id="err">
  <h2>This video's format can't play on this device</h2>
  <p>The file itself is fine — this phone/browser just doesn't understand its format.
     If a <b>Cast</b> button is showing above, try sending it to your TV: TVs can often
     play formats phones can't. Otherwise this file needs converting to play here.
     This video has been flagged — the server will convert it automatically, check back later.</p>
</div>
<div id="toast"></div>${
  introWindow
    ? `
<button type="button" id="skipIntro" title="Jump to the end of the opening titles">⏭ Skip intro</button>`
    : ''
}${
  autoSkipIntro
    ? `
<button type="button" id="introundo" title="Put the intro back and start from the beginning">↩ Undo skip</button>`
    : ''
}${surfBarHtml}${upNextHtml}${resumeHtml}
<script>
  const v = document.getElementById('v')
  const sessionId = ${jsonForScript(sessionId)}
  const mediaTitle = ${jsonForScript(title || '')}
  const mediaPoster = ${jsonForScript(poster || '')}
  const mediaKind = ${jsonForScript(kind === 'tv' ? 'tv' : 'movie')}
  const mediaId = ${jsonForScript(mediaId || '')}
  // Tracks the Remote Playback (Chromecast) availability result — reported
  // with the unplayable flag so the server knows whether this person at least
  // had a cast button to fall back on.
  let castAvailable = false

  // ---- shared: queue a server-side conversion, and show a brief message ----
  // Used both by the "can't decode" overlay and by a Cast attempt that finds
  // no compatible device. The server decides whether a report is worth acting
  // on (a file already in a cast/browser-friendly format is ignored).
  let flagged = false
  function flagForConversion(reason) {
    if (flagged || !mediaId) return
    flagged = true
    fetch('/flag-unplayable', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: mediaKind, id: mediaId, castAvailable, reason })
    }).catch(() => { flagged = false })
  }
  let toastTimer
  function toast(msg) {
    const t = document.getElementById('toast')
    if (!t) return
    t.textContent = msg
    t.style.display = 'block'
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => { t.style.display = 'none' }, 7000)
  }
${startFractionJs}
  // ---- watch-history progress reporting ----
  // Says whether it is playing, paused or done so integrations (webhooks, the event stream) can tell.
  function report(state) {
    // bgAudio carries playback while the screen is off; use whichever clock is live.
    const live = (typeof bgActive !== 'undefined' && bgActive && bgAudio) ? bgAudio : v
    const said = typeof state === 'string' ? state : (live.paused ? 'paused' : 'playing')
    const body = JSON.stringify({ sessionId, currentTime: live.currentTime || 0, duration: live.duration || v.duration || 0, state: said })
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/progress', new Blob([body], { type: 'application/json' }))
    } else {
      fetch('/progress', { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, keepalive: true })
    }
  }
  setInterval(report, 15000)
  v.addEventListener('pause', () => report())
  v.addEventListener('play', () => report())
  v.addEventListener('ended', () => report('stopped'))
  window.addEventListener('pagehide', () => report('stopped'))

  // ---- lock-screen / notification media controls (background play) ----
  // ---- "Screen off" playback -------------------------------------------
  // Phones deliberately pause <video> the moment the screen locks, and no web
  // API changes that. Audio, however, is allowed to keep going — so when the
  // screen goes off we hand playback to an <audio> element pointed at the SAME
  // file at the SAME position, and hand it back on wake. Sound continues
  // uninterrupted; the picture simply isn't being decoded while nobody can see
  // it (which also saves battery).
  const bgBtn = document.getElementById('bgBtn')
  let bgAudio = null
  let bgActive = false      // audio is currently carrying playback
  let bgEnabled = false
  try { bgEnabled = localStorage.getItem('beebo:screenOff') === '1' } catch (e) {}

  function paintBgBtn() {
    if (!bgBtn) return
    bgBtn.textContent = bgEnabled ? '🎧 Screen off: On' : '🎧 Screen off: Off'
    bgBtn.setAttribute('aria-pressed', bgEnabled ? 'true' : 'false')
    bgBtn.style.borderColor = bgEnabled ? '#4f9dff' : 'rgba(255,255,255,.25)'
    bgBtn.style.color = bgEnabled ? '#8cc4ff' : '#fff'
  }
  paintBgBtn()

  if (bgBtn) {
    bgBtn.onclick = (e) => {
      e.preventDefault()
      e.stopPropagation()
      bgEnabled = !bgEnabled
      try { localStorage.setItem('beebo:screenOff', bgEnabled ? '1' : '0') } catch (e2) {}
      paintBgBtn()
      toast(bgEnabled
        ? 'Sound will keep playing when you turn the screen off. Use the lock-screen controls to pause.'
        : 'Playback will now pause when the screen turns off.')
      if (!bgEnabled && bgActive) handBackToVideo()
      poke()
    }
  }

  function ensureBgAudio() {
    if (bgAudio) return bgAudio
    bgAudio = document.createElement('audio')
    bgAudio.src = v.currentSrc || v.src
    bgAudio.preload = 'auto'
    // Not in the DOM flow — it exists purely to hold the audio session open.
    bgAudio.style.display = 'none'
    document.body.appendChild(bgAudio)
    // Keep the watch-history position accurate while the screen is off.
    bgAudio.addEventListener('timeupdate', () => {
      if (bgActive) v.currentTime = bgAudio.currentTime
    })
    return bgAudio
  }

  function handOffToAudio() {
    if (bgActive || v.paused) return
    const a = ensureBgAudio()
    const at = v.currentTime
    bgActive = true
    v.pause()
    try {
      a.currentTime = at
    } catch (e) {}
    a.play().catch(() => {
      // Autoplay refused (rare — playback was already user-initiated), so give
      // the video back rather than leaving the viewer with silence.
      bgActive = false
      v.play().catch(() => {})
    })
  }

  function handBackToVideo() {
    if (!bgActive) return
    const a = bgAudio
    bgActive = false
    const at = a ? a.currentTime : v.currentTime
    if (a) a.pause()
    try {
      v.currentTime = at
    } catch (e) {}
    v.play().catch(() => {})
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (bgEnabled) handOffToAudio()
    } else {
      handBackToVideo()
    }
  })

  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: mediaTitle,
        artist: 'Beebo',
        artwork: mediaPoster ? [{ src: mediaPoster, sizes: '300x450', type: 'image/jpeg' }] : []
      })
      // While the screen is off the <audio> element is the one making sound, so
      // the lock-screen buttons have to drive that instead of the video.
      const cur = () => (bgActive && bgAudio ? bgAudio : v)
      const acts = {
        play: () => cur().play(),
        pause: () => cur().pause(),
        seekbackward: (d) => { const m = cur(); m.currentTime = Math.max(0, m.currentTime - ((d && d.seekOffset) || 10)) },
        seekforward: (d) => { const m = cur(); m.currentTime = Math.min(m.duration || Infinity, m.currentTime + ((d && d.seekOffset) || 10)) },
        seekto: (d) => { if (d && d.seekTime != null) cur().currentTime = d.seekTime },
        stop: () => cur().pause()${
          showTransport
            ? `,
        // Lock-screen / headset ⏮ ⏭ follow the exact same rule as the on-screen
        // buttons (transportPrev is the 5-second restart-or-go-back one).
        previoustrack: () => transportPrev(),
        nexttrack: () => transportNext()`
            : ''
        }
      }
      for (const k in acts) { try { navigator.mediaSession.setActionHandler(k, acts[k]) } catch (e) {} }
    } catch (e) {}
  }

  // ---- Chromecast / Google TV (Remote Playback API — Chrome on Android & desktop) ----
  // The button stays VISIBLE even when Chrome reports no compatible device.
  // Chrome only advertises availability for containers it can vouch for, so an
  // MKV hides the button even though a Chromecast usually plays it fine — the
  // tap is worth offering. If the picker genuinely finds nothing, say so and
  // queue a conversion to a format that will cast.
  const castBtn = document.getElementById('castBtn')
  if (v.remote && v.remote.prompt) {
    castBtn.style.display = 'flex'
    castBtn.onclick = () => {
      v.remote.prompt().catch(() => {
        if (!castAvailable) {
          toast("No TV found for this file. Some formats (MKV, AVI) cannot be cast directly — it is being converted automatically, try again in a while.")
          flagForConversion('cast_unavailable')
        }
      })
    }
    try {
      v.remote.watchAvailability((ok) => {
        castAvailable = ok
        castBtn.style.opacity = ok ? '1' : '.55'
        castBtn.title = ok
          ? 'Cast to TV'
          : 'No cast device detected for this format — tap to try anyway'
      }).catch(() => {})
    } catch (e) {}
    // A file that can never be cast should get converted without anyone having
    // to ask for it. After a little playback, report it; the server ignores the
    // report for files that are already in a cast-friendly format.
    setTimeout(() => { if (!castAvailable) flagForConversion('cast_unavailable') }, 25000)
  }

  // ---- AirPlay (iPhone / iPad / Mac Safari) ----
  const airBtn = document.getElementById('airBtn')
  if (window.WebKitPlaybackTargetAvailabilityEvent) {
    v.addEventListener('webkitplaybacktargetavailabilitychanged', (e) => {
      airBtn.style.display = e.availability === 'available' ? 'flex' : 'none'
    })
    airBtn.onclick = () => { try { v.webkitShowPlaybackTargetPicker() } catch (e) {} }
  }

  // ---- Picture-in-Picture (mini player while using other apps) ----
  const pipBtn = document.getElementById('pipBtn')
  if (document.pictureInPictureEnabled) {
    pipBtn.style.display = 'flex'
    pipBtn.onclick = () => {
      if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {})
      else v.requestPictureInPicture().catch(() => {})
    }
  }

  // ---- auto-hide the top bar while playing ----
  const bar = document.getElementById('bar')
  let hideTimer
  function poke() {
    bar.classList.remove('hidden')
    clearTimeout(hideTimer)
    hideTimer = setTimeout(() => { if (!v.paused) bar.classList.add('hidden') }, 3500)
  }
  ;['pointermove', 'pointerdown', 'touchstart'].forEach((ev) => document.addEventListener(ev, poke, { passive: true }))
  v.addEventListener('pause', poke)
  // Re-arm the countdown once playback actually begins. Without this, a video
  // that takes a moment to buffer burns its only hide-timer while still paused
  // and the controls never fade until the viewer taps again.
  v.addEventListener('play', poke)
  v.addEventListener('playing', poke)
  v.addEventListener('seeked', poke)
  poke()
${surfJs}
  // ---- "Bad quality" report button (always visible, unlike Cast/PiP) ----
  // POSTs to /flag-quality so the file shows up in the desktop app's Flags
  // tab, where a better copy can be searched for. One report per page load.
  const flagBtn = document.getElementById('flagBtn')
  let qualityFlagged = false
  flagBtn.onclick = () => {
    if (qualityFlagged || !mediaId) return
    qualityFlagged = true
    fetch('/flag-quality', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: mediaKind, id: mediaId })
    }).then(() => {
      flagBtn.textContent = '✓ Reported'
      flagBtn.disabled = true
      flagBtn.style.opacity = '.6'
      flagBtn.style.cursor = 'default'
    }).catch(() => { qualityFlagged = false })
  }

  // ---- friendly message when the browser can't decode this format ----
  // The Cast button stays usable: the TV decodes with its own (more capable)
  // hardware, so some files that fail here still play fine when cast.
  // Also reports the file to /flag-unplayable (once per page load) so the
  // server queues an automatic conversion to a browser-friendly MP4.
  v.addEventListener('error', () => {
    document.getElementById('err').style.display = 'flex'
    bar.classList.remove('hidden')
    clearTimeout(hideTimer)
    flagForConversion('playback_error')
  })
  v.addEventListener('playing', () => {
    document.getElementById('err').style.display = 'none'
  })
${seekToJs}${resumeJs}${transportJs}${markersJs}${upNextJs}</script>
${!surf && mediaId ? playbackWebUi.playbackPanelHtml({ kind, mediaId }) : ''}
${!surf && mediaId ? watchTogetherWeb.watchTogetherHtml({ kind, mediaId, title, nextHref }) : ''}
${!surf && mediaId ? movieNightWeb.reactionOverlayHtml() : ''}
${!surf && mediaId ? phoneSpeakersWeb.phoneSpeakersHtml({ kind, mediaId, title }) : ''}
${surf ? '' : playlistWeb.PLAYER_QUEUE_SCRIPT}
${pwa.playerScript()}
</body></html>`
}

// Parses show/season/episode out of a filename — mirrors the desktop app's parser
// so both sides group the same messy filenames the same way. Handles S01E01,
// 1x01, and "Season 1 Episode 1" styles, strips scene-release numeric ID
// prefixes ("4574334-stranger-things-2016...") and quality tags (1080p etc);
// anything else becomes its own single-item "show" named after the cleaned
// filename.
// Every helper below used to be defined here AND again in main.js, and the two
// copies had quietly drifted apart - only main.js stripped bracketed quality
// tags, only this file stripped the "(converted)" marker, and their
// extractTrailingYear regexes disagreed about "(1995)". That meant the desktop
// app and the web player could ask TMDB two different questions about the same
// file. They all delegate to ./titleParse now. The names stay exactly as they
// were because the TV episode/grouping code below and ~20 call sites in this
// file import them by name.
function cleanText(raw) {
  return titleParse.cleanText(raw)
}

function stripLeadingId(raw) {
  return titleParse.stripLeadingId(raw)
}

// This file's historical variant: a bare trailing year only. main.js uses the
// bracket-tolerant one. Both are still exported rather than unified, because
// each side's TV show grouping keys off its own behaviour and changing that
// would re-group existing shows - out of scope here.
function extractTrailingYear(raw) {
  return titleParse.extractTrailingYear(raw)
}

const QUALITY_TAG = titleParse.QUALITY_TAG
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

// Now also returns imdbId, episode and confidenceHint. Existing callers here
// destructure only { title, year } and are unaffected by the extra fields.
const parseMovieTitleMemo = parseMemo.createParseMemo(titleParse.parseMovieTitle)
function parseMovieTitle(fileName) {
  return parseMovieTitleMemo(fileName)
}

// --- filename-based sequel detection (works with zero TMDB data) ----------
// Turns a movie's clean title into { series, num }: "Home Alone 2" ->
// {series:"home alone", num:2}, "Home Alone" -> {series:"home alone", num:1}.
// Grouping the library by `series` lets the player walk 1 -> 2 -> 3 by filename
// alone, so auto-play-next works before (or entirely without) any TMDB fetch.
const SEQUEL_ROMAN = { i:1, ii:2, iii:3, iv:4, v:5, vi:6, vii:7, viii:8, ix:9, x:10, xi:11, xii:12, xiii:13 }
function normalizeSeriesKey(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}
function titleCaseWords(s) {
  return String(s || '').split(' ').filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}
function movieSeriesInfo(cleanTitle) {
  const t = String(cleanTitle || '').toLowerCase().trim()
  if (!t) return null
  // "part 2" / "part ii" — the strongest, least ambiguous marker.
  let m = t.match(/^(.*?)[\s:._-]+part[\s._-]+(\d{1,2}|[ivx]{1,4})\b/i)
  if (m) {
    const num = /^\d+$/.test(m[2]) ? parseInt(m[2], 10) : (SEQUEL_ROMAN[m[2].toLowerCase()] || null)
    if (num) return { series: normalizeSeriesKey(m[1]), num }
  }
  // A whole-word arabic number 2..20 (sequels start at 2; "1" is normally implicit).
  // Take the LAST one; everything before it is the series name, so a subtitle after
  // the number ("Home Alone 2 Lost in New York") is ignored.
  const re = /(^|[\s:._-])(\d{1,2})(?=$|[\s:._-])/g
  let last = null, mm
  while ((mm = re.exec(t))) {
    const n = parseInt(mm[2], 10)
    if (n >= 2 && n <= 20) last = { at: mm.index + mm[1].length, num: n }
  }
  if (last) return { series: normalizeSeriesKey(t.slice(0, last.at)), num: last.num }
  // A trailing roman numeral (ii..xiii; a lone i / v / x is almost always a real word).
  const rm = t.match(/^(.*?)[\s:._-]+(ii|iii|iv|vi|vii|viii|ix|xi|xii|xiii)\b/i)
  if (rm) {
    const n = SEQUEL_ROMAN[rm[2].toLowerCase()]
    if (n) return { series: normalizeSeriesKey(rm[1]), num: n }
  }
  // No marker at all: this file is part 1 of a series named after itself.
  return { series: normalizeSeriesKey(t), num: 1 }
}


// What a player says about itself in a progress report ({ state: 'playing' | 'paused' | 'stopped' },
// or the older-style { paused: true }); undefined when it says nothing, which is what every
// player did before and is read from how the position moves instead (webhooks.js).
function playerState(body) {
  if (!body || typeof body !== 'object') return undefined
  const s = String(body.state || '').toLowerCase()
  if (s === 'playing' || s === 'paused' || s === 'stopped') return s
  if (body.paused === true) return 'paused'
  return undefined
}

// Lives in ./titleParse now (unchanged) so the Beebo Inbox sorter shares it.
function parseEpisode(fileName) {
  return titleParse.parseEpisode(fileName)
}

// Files nested in a Show/Season/episode.ext structure get grouped by their
// top-level folder name (far more reliable than parsing every messy filename —
// it also naturally merges a show whose episodes were named inconsistently
// across seasons). Flat files sitting directly in the TV Shows root fall back
// to filename parsing entirely.
function groupKeyAndName(relPath, fileName) {
  const parts = relPath.split(/[\\/]/).filter(Boolean)
  if (parts.length > 1) {
    const folderName = parts[0]
    const { rest, year } = extractTrailingYear(stripLeadingId(folderName))
    return { show: cleanText(rest) || folderName.trim(), year }
  }
  const parsed = parseEpisode(fileName)
  return { show: parsed.show, year: parsed.year }
}

async function tvSearchOnce(query, year, key, isV4Token) {
  const yearParam = year ? `&first_air_date_year=${encodeURIComponent(year)}` : ''
  const url = isV4Token
    ? `https://api.themoviedb.org/3/search/tv?query=${encodeURIComponent(query)}${yearParam}`
    : `https://api.themoviedb.org/3/search/tv?api_key=${key}&query=${encodeURIComponent(query)}${yearParam}`
  const res = await fetch(url, {
    headers: isV4Token ? { Authorization: `Bearer ${key}`, accept: 'application/json' } : { accept: 'application/json' }
  })
  if (!res.ok) return { ok: false }
  const data = await res.json()
  return { ok: true, match: data.results?.[0] || null }
}

// Tries a few query variations before giving up — folder names aren't always
// clean enough to match on the first attempt (e.g. a folder literally named
// "Survivor 50" won't match TMDB's "Survivor" until the trailing number is
// stripped).
async function searchTvSmart(query, year, key, isV4Token) {
  const r1 = await tvSearchOnce(query, year, key, isV4Token)
  if (!r1.ok) return r1
  if (r1.match) return r1

  if (year) {
    const r2 = await tvSearchOnce(query, null, key, isV4Token)
    if (!r2.ok) return r2
    if (r2.match) return r2
  }

  const trailingNum = query.match(/^(.*?)\s+\d{1,3}$/)
  if (trailingNum) {
    const r3 = await tvSearchOnce(trailingNum[1], year, key, isV4Token)
    if (r3.ok && r3.match) return r3
  }

  return { ok: true, match: null }
}

// --- tv-manifest.json key compatibility -----------------------------------
// The desktop app and this server historically keyed the SAME tv-manifest.json
// two different ways: the desktop (TVShows.jsx -> tmdb:searchTv) writes each
// show under its plain lowercase name ("house", "12 monkeys"), while the server
// builds base64url showKeys via encodeId(name.toLowerCase()). Neither side
// could see the other's entries, so a cache the desktop had filled in looked
// completely empty to the server — which the website papered over with a live
// TMDB lookup, but which left the cache-only phone API returning poster:null
// for every show. Movies were never affected: both sides key those by filename.
//
// Every TV manifest read now goes through these two helpers, so there is one
// definition of "which keys mean this show" and a third reader can't drift.

// The keys this showKey could be stored under, most specific first.
function tvManifestKeyCandidates(showKey) {
  const raw = String(showKey || '')
  if (!raw) return []
  const out = [raw]
  let decoded = ''
  try {
    decoded = decodeId(raw)
  } catch {
    decoded = ''
  }
  // base64url decoding is lenient, so only trust a result that round-trips —
  // that proves `raw` really is encodeId(decoded) and not a plain name.
  if (decoded && decoded !== raw && encodeId(decoded) === raw) out.push(decoded)
  return out
}

// { value } when the manifest HAS an entry (including a cached null, which is a
// real "TMDB has no match for this" answer), or null when it has none at all.
function tvManifestHit(manifest, showKey) {
  if (!manifest || typeof manifest !== 'object') return null
  for (const k of tvManifestKeyCandidates(showKey)) {
    if (k in manifest) return { key: k, value: manifest[k] }
  }
  return null
}

// Manifest first, then the in-memory lookup cache — both under either key form.
function readTvMetaCached(manifest, showKey) {
  const hit = tvManifestHit(manifest, showKey)
  if (hit) return hit.value || null
  for (const k of tvManifestKeyCandidates(showKey)) {
    if (tvCache.has(k)) return splitTvMatchGenres(tvCache.get(k)) || null
  }
  return null
}

// The key NEW entries are written under. Deliberately the desktop's plain
// lowercase name, NOT the base64 showKey: readers above accept either, so a
// plain entry is visible to both sides, whereas writing base64 (or both) would
// just recreate the split cache this whole helper exists to heal.
function tvManifestWriteKey(showName, showKey) {
  const raw = String(showKey || '')
  let decoded = ''
  try {
    decoded = decodeId(raw)
  } catch {
    decoded = ''
  }
  if (decoded && encodeId(decoded) === raw) return decoded
  return String(showName || '').toLowerCase()
}

// Persists a live TV match into the shared on-disk cache the way the desktop's
// tmdb:searchTv does: the manifest entry under the plain key, plus the poster
// image itself into posters-tv/ so tvPosterUrl() can hand out the
// server-relative /media/poster-tv/<id>.jpg the phone API contract requires.
// Best-effort throughout — a failed write just means looking it up again later.
async function persistTvMatch(cacheDir, showName, showKey, match) {
  if (!cacheDir) return
  try {
    const paths = tmdbFileCache.ensureDirs(cacheDir)
    // Read-modify-write with NO await in between, so concurrent enrichment
    // tasks can't clobber each other's entries in this shared file.
    const manifest = tmdbFileCache.getTvManifest(cacheDir)
    manifest[tvManifestWriteKey(showName, showKey)] = match
    tmdbFileCache.writeJson(paths.tvManifestFile, manifest)
    if (match && match.poster_path && match.id != null) {
      await tmdbFileCache.downloadImage(
        `https://image.tmdb.org/t/p/w300${match.poster_path}`,
        path.join(paths.tvPostersDir, `${match.id}.jpg`)
      )
    }
  } catch {
    // disk full / read-only cache dir must never break a page render
  }
}

async function tmdbLookupTv(showName, showKey, key, cacheDir, year) {
  return metadataMerge.mergeShow(await tmdbLookupTvRaw(showName, showKey, key, cacheDir, year), { cacheDir, showKey })
}

async function tmdbLookupTvRaw(showName, showKey, key, cacheDir, year) {
  if (cacheDir) {
    const hit = tvManifestHit(tmdbFileCache.getTvManifest(cacheDir), showKey)
    if (hit) return hit.value
  }
  for (const k of tvManifestKeyCandidates(showKey)) {
    if (tvCache.has(k)) return splitTvMatchGenres(tvCache.get(k))
  }
  if (!key) return null

  const isV4Token = key.split('.').length === 3

  try {
    const result = await searchTvSmart(showName, year, key, isV4Token)
    const match = result.ok ? splitTvMatchGenres(result.match) : null
    tvCache.set(showKey, match)
    // Write through to the shared cache so the NEXT viewer (and the phone app,
    // and an offline install) gets this without another network call.
    if (result.ok) await persistTvMatch(cacheDir, showName, showKey, match)
    return match
  } catch {
    tvCache.set(showKey, null)
    return null
  }
}

// A backdrop is the CDN address for a TMDB path, or Beebo's own copy when the owner (or a sidecar picture) supplied one.
function backdropUrl(backdropPath) {
  return metadataOverrides.customArtUrl(backdropPath) || tmdbImageUrl('w780', backdropPath)
}

function tvPosterUrl(cacheDir, showId, posterPath, images) {
  const custom = metadataOverrides.customArtUrl(posterPath)
  if (custom) return custom
  if (cacheDir && /^\d{1,12}$/.test(String(showId)) && (images && images.hasTvPoster ? images.hasTvPoster(showId) : tmdbFileCache.localTvPosterPath(cacheDir, showId))) return `/media/poster-tv/${showId}.jpg`
  return tmdbImageUrl('w300', posterPath)
}

// --- Genre categories (ported from the desktop's Movies.jsx / TVShows.jsx) ---
// Genre names live in genres.js (shared with main.js), which also splits TV's combined genres
// ("Action & Adventure") into the film genres wherever TV metadata is loaded.
const { GENRE_NAMES_MOVIE, GENRE_NAMES_TV, splitTvMatchGenres, canonicalTvGenreId } = require('./genres')

// Age-rating badge colors — merged union of the desktop's movie + TV maps, so
// the "is this ok for the kids" color read matches the desktop app.
const CERT_COLOR = {
  G: '#4caf50', 'TV-Y': '#4caf50', 'TV-G': '#4caf50',
  PG: '#8bc34a', 'TV-Y7': '#8bc34a', 'TV-PG': '#8bc34a',
  'PG-13': '#ffb74d', 'TV-14': '#ffb74d',
  R: '#ef5350', 'NC-17': '#e53935', 'TV-MA': '#e53935'
}
function certColor(cert) {
  return CERT_COLOR[cert] || '#9e9e9e'
}

// True when this title's cached TMDB genre_ids include the requested genre id.
function hasGenre(genreIds, genreId) {
  const id = Number(genreId)
  return Number.isFinite(id) && Array.isArray(genreIds) && genreIds.includes(id)
}

// genre id -> how many library titles carry it, from a list of cached TMDB
// match/meta objects (nulls fine — unmatched titles just don't count).
function countGenres(metaList) {
  const counts = new Map()
  for (const meta of metaList || []) {
    if (!meta || !Array.isArray(meta.genre_ids)) continue
    for (const gid of meta.genre_ids) counts.set(gid, (counts.get(gid) || 0) + 1)
  }
  return counts
}

// --- "Not Sure What To Watch?" channel surfing (/surprise) ---
// No server-side session state exists, so a surf session is fully described by
// the URL: kind + genre + year/decade + seed + index. Everything below is deterministic —
// same seed, same library, same order — which is what makes ⏮ Back and ⏭ Next
// reversible without remembering anything between requests.

// mulberry32: a 32-bit seeded PRNG in four lines. Chosen over Math.random()
// because the order has to be reproducible across requests, and over a
// dependency because this file has none.
function mulberry32(seed) {
  let a = seed >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Fisher-Yates driven by the seeded PRNG. The input must already be in a
// stable order (we sort by encoded id) or the "same seed = same title" promise
// breaks the moment the filesystem hands back a different readdir order.
function seededShuffle(list, seed) {
  const arr = list.slice()
  const rand = mulberry32(seed)
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const tmp = arr[i]
    arr[i] = arr[j]
    arr[j] = tmp
  }
  return arr
}

// Coerces ?seed= to a usable uint32; anything junk falls back to a fixed seed
// so a hand-typed URL still plays something instead of 500ing.
function normalizeSeed(raw) {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) >>> 0 : 1
}
function freshSeed() {
  return (Math.floor(Math.random() * 0xffffffff) >>> 0) || 1
}

// Cached-only TMDB meta readers — offline manifest first, then whatever the
// in-memory lookup cache happens to hold. Deliberately NOT tmdbLookup(): the
// surf pages must never make a network call, and an empty cache simply means
// fewer genre chips (🎲 Any category always works).
function cachedMovieMetaReader(cacheDir) {
  let manifest = {}
  try {
    manifest = cacheDir ? tmdbFileCache.getManifest(cacheDir) : {}
  } catch {
    manifest = {}
  }
  return (fileName, dir) => metadataMerge.mergeMovie((fileName in manifest ? manifest[fileName] : tmdbCache.get(fileName)) || null, { cacheDir, fileName, dir })
}
function cachedTvMetaReader(cacheDir) {
  let manifest = {}
  try {
    manifest = cacheDir ? tmdbFileCache.getTvManifest(cacheDir) : {}
  } catch {
    manifest = {}
  }
  // Both key forms, via the shared helper — see tvManifestHit above.
  return (showKey) => metadataMerge.mergeShow(readTvMetaCached(manifest, showKey), { cacheDir, showKey })
}

// --- Several files of one film (movieVersions.js) ---------------------------------------------
// The walk lists every FILE and every file keeps its own id (streams, subtitles, probes, markers).
// A list a person sees shows ONE entry per film - its primary file, whose id old clients already
// know - and hangs the other files off it as `versions`.
const QUALITY_TIER_HEIGHT = { '2160p': 2160, '1080p': 1080, '720p': 720, '480p': 480 }
function movieVersionOptions(cacheDir) {
  const qualityCache = loadQualityCache(cacheDir)
  return {
    metaOf: cachedMovieMetaReader(cacheDir),
    idOf: (m) => m.id || encodeId(m.fileName),
    heightOf: (m) => QUALITY_TIER_HEIGHT[qualityTierFor(qualityCache, path.join(m.dir, m.fileName), m)] || null,
    sizeOf: (m) => fs.statSync(path.join(m.dir, m.fileName)).size
  }
}
const groupMovieList = (movies, cacheDir) => movieVersions.groupMovieFiles(movies, movieVersionOptions(cacheDir))
const collapseMovieVersions = (movies, cacheDir) => movieVersions.primaryFiles(movies, movieVersionOptions(cacheDir))

// Every surfable title as { id, meta } — movies keyed by filename, TV by
// individual episode (an episode's genres come from its show's cached meta,
// exactly like the /tvshows genre chips). Sorted by encoded id so the pool is
// stable before shuffling.
// Every entry also carries its own `kind`, so a mixed ("both") pool can still
// build the right stream URL, title and "start from the beginning" link per
// item without the caller having to remember which half it came from.
function surfCandidates(kind, dirs) {
  // kind='both' — movies AND episodes in one pool. Each half is produced by the
  // very same code path as a single-kind pool, then the union is re-sorted by
  // the stable composite key "kind|id" BEFORE anything shuffles it. That key
  // exists on disk-independent data, so the same seed walks a mixed pool in
  // exactly the same order on every request, on every machine.
  if (kind === 'both') {
    return [...surfCandidates('movie', dirs), ...surfCandidates('tv', dirs)].sort((a, b) => {
      const ka = `${a.kind}|${a.id}`
      const kb = `${b.kind}|${b.id}`
      return ka < kb ? -1 : ka > kb ? 1 : 0
    })
  }
  const { movieDirs, tvDirs, cacheDir } = dirs || {}
  const out = []
  if (kind === 'tv') {
    const metaOf = cachedTvMetaReader(cacheDir)
    for (const f of scanTvShowsMulti(tvDirs)) {
      const { show } = groupKeyAndName(f.relPath, f.fileName)
      out.push({ kind: 'tv', id: encodeId(f.relPath), meta: metaOf(encodeId(String(show || '').toLowerCase())) })
    }
  } else {
    const metaOf = cachedMovieMetaReader(cacheDir)
    for (const m of collapseMovieVersions(scanMoviesMulti(movieDirs), cacheDir)) {
      out.push({ kind: 'movie', id: encodeId(m.fileName), meta: metaOf(m.fileName) })
    }
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

// The kind of ONE pooled candidate. For a single-kind pool the requested kind
// already says it (and is what every pre-existing caller passes); for 'both'
// the answer has to come off the item itself.
function surfKindOf(kind, candidate) {
  if (kind === 'movie' || kind === 'tv') return kind
  return candidate && candidate.kind === 'tv' ? 'tv' : 'movie'
}

// Display title for one surfCandidates() entry, derived from cached data only
// (never a network call). Deliberately produces the same string the website's
// surf player puts in its header: movieWatchProps uses the cached TMDB title
// and falls back to cleanTitle(fileName); tvWatchProps builds "Show — S1E2"
// out of parseEpisode. Kept here rather than in the desktop's IPC layer so
// there is exactly one definition of "what a surfed title is called".
function surfTitle(kind, candidate) {
  const k = surfKindOf(kind, candidate)
  let name = ''
  try {
    name = decodeId((candidate && candidate.id) || '')
  } catch {
    name = ''
  }
  if (k === 'tv') {
    const parsed = name ? parseEpisode(path.basename(name)) : null
    return parsed ? `${parsed.show}${parsed.season !== null ? ` — S${parsed.season}E${parsed.episode}` : ''}` : 'Unknown'
  }
  return (candidate && candidate.meta && candidate.meta.title) || cleanTitle(name || 'Unknown')
}

// --- surf: year / decade filtering --------------------------------------
// Release year for one surfCandidates() entry, cached data only (never a
// network call). Deliberately NOT a third way of working out a year — it is
// the exact derivation the rest of the site already uses:
//   * movies — cached TMDB `release_date` year (what the "By Release Date"
//     view groups by), falling back to parseMovieTitle()'s filename year
//     (the same fallback /api/movies uses).
//   * tv episodes — their show's cached `first_air_date` year (what the TV
//     "By Release Date" view groups by).
// null when nothing cached or parseable knows — such titles are excluded
// while a year/decade filter is on, and counted as `unknownCount` instead.
function surfYear(kind, candidate) {
  const meta = (candidate && candidate.meta) || null
  if (surfKindOf(kind, candidate) === 'tv') {
    const tvYear = Number(String(meta?.first_air_date || '').slice(0, 4))
    return Number.isFinite(tvYear) && tvYear ? tvYear : null
  }
  const tmdbYear = Number(String(meta?.release_date || '').slice(0, 4))
  if (Number.isFinite(tmdbYear) && tmdbYear) return tmdbYear
  let name = ''
  try {
    name = decodeId((candidate && candidate.id) || '')
  } catch {
    name = ''
  }
  const parsedYear = Number(parseMovieTitle(path.basename(name || '')).year)
  return Number.isFinite(parsedYear) && parsedYear ? parsedYear : null
}

// ?year=YYYY / ?decade=YYYY -> a usable number, or null for "no filter".
// Anything junk (empty, a word, 12, 99999) is simply no filter at all, so a
// hand-typed URL degrades to the unfiltered pool instead of an empty one.
function normalizeYearParam(raw) {
  if (raw === null || raw === undefined || raw === '') return null
  const n = Number(raw)
  return Number.isInteger(n) && n >= 1870 && n <= 2999 ? n : null
}
function normalizeDecadeParam(raw) {
  const y = normalizeYearParam(raw)
  return y === null ? null : Math.floor(y / 10) * 10
}

// genre + (year XOR decade) applied to a candidate pool, in that order, so the
// filters compose. Order inside the pool is untouched — filtering a stable
// list keeps it stable, which is what lets the seeded shuffle stay reproducible.
// `year` wins if both are somehow supplied (the contract says pass at most one).
function surfFilterPool(kind, pool, { genre = null, year = null, decade = null } = {}) {
  let out = pool
  if (genre !== null && genre !== '' && Number.isFinite(Number(genre))) {
    out = out.filter((c) => hasGenre(c.meta?.genre_ids, genre))
  }
  if (year !== null) {
    out = out.filter((c) => surfYear(kind, c) === year)
  } else if (decade !== null) {
    out = out.filter((c) => {
      const y = surfYear(kind, c)
      return y !== null && y >= decade && y <= decade + 9
    })
  }
  return out
}

// What years/decades actually exist in a pool, newest first, with counts —
// drives both the year chips on /surprise and GET /api/surf/years.
function surfYearSummary(kind, pool) {
  const years = new Map()
  let unknownCount = 0
  for (const c of pool || []) {
    const y = surfYear(kind, c)
    if (y === null) {
      unknownCount++
      continue
    }
    years.set(y, (years.get(y) || 0) + 1)
  }
  const decades = new Map()
  for (const [y, n] of years) {
    const d = Math.floor(y / 10) * 10
    decades.set(d, (decades.get(d) || 0) + n)
  }
  return {
    decades: Array.from(decades.entries())
      .sort((a, b) => b[0] - a[0])
      .map(([decade, count]) => ({ decade, label: `${decade}s`, count })),
    years: Array.from(years.entries())
      .sort((a, b) => b[0] - a[0])
      .map(([year, count]) => ({ year, count })),
    unknownCount,
    total: (pool || []).length
  }
}

// movie|tv|both from a query param, defaulting to 'movie' exactly as before.
function surfKindParam(raw) {
  return raw === 'tv' ? 'tv' : raw === 'both' ? 'both' : 'movie'
}
// A mixed pool can hold either namespace's genre ids, so 'both' gets the union.
// (The two maps agree on every id they share — 16 Animation, 35 Comedy, …)
const GENRE_NAMES_BOTH = { ...GENRE_NAMES_MOVIE, ...GENRE_NAMES_TV }
function surfGenreNames(kind) {
  return kind === 'both' ? GENRE_NAMES_BOTH : kind === 'tv' ? GENRE_NAMES_TV : GENRE_NAMES_MOVIE
}
function surfKindLabel(kind) {
  return kind === 'both' ? 'Movies & TV' : kind === 'tv' ? 'TV Shows' : 'Movies'
}
function surfKindNoun(kind, n) {
  const one = kind === 'both' ? 'title' : kind === 'tv' ? 'episode' : 'movie'
  return `${one}${n === 1 ? '' : 's'}`
}
// "Comedy · 1990s" — the human-readable version of the active filters, used in
// the surf bar, the step-2 header and the empty-pool page. '' when unfiltered.
function surfFilterLabel(kind, { genre = null, year = null, decade = null } = {}) {
  const bits = []
  const name = genre ? surfGenreNames(kind)[genre] : null
  if (name) bits.push(name)
  if (year !== null) bits.push(String(year))
  else if (decade !== null) bits.push(`${decade}s`)
  return bits.join(' · ')
}

// Row of genre category chips (only genres actually present in the library,
// with counts) plus a "Showing X only · ✕ clear" line when a filter is
// active. Links preserve every other query param so the filter composes with
// existing views.
function genreFilterUi({ genreNames, counts, activeGenre, searchParams, basePath }) {
  const hrefFor = (id) => {
    const params = new URLSearchParams(searchParams)
    if (id) params.set('genre', id)
    else params.delete('genre')
    const qs = params.toString()
    return `${basePath}${qs ? `?${qs}` : ''}`
  }
  const present = Object.entries(genreNames)
    .filter(([id]) => counts.get(Number(id)))
    .sort((a, b) => a[1].localeCompare(b[1]))
  if (!present.length) return ''
  const chip = (href, label, active) =>
    `<a href="${escapeHtml(href)}" class="${active ? 'beebo-genre-active' : ''}" style="font-size:12px;font-weight:600;padding:5px 11px;border-radius:999px;text-decoration:none;white-space:nowrap;${
      active ? 'background:#4f9dff;color:#0f1115;border:1px solid #4f9dff;' : 'background:#171a21;color:#8a8f98;border:1px solid #2a2f3a;'
    }">${escapeHtml(label)}</a>`
  const chips = [
    chip(hrefFor(null), 'All genres', !activeGenre),
    ...present.map(([id, name]) => chip(hrefFor(id), `${name} (${counts.get(Number(id))})`, String(activeGenre) === String(id)))
  ].join('')
  const activeName = activeGenre ? genreNames[activeGenre] : null
  const clearLine = activeName
    ? `<div class="muted" style="margin:0 0 14px;font-size:12px;">Showing ${escapeHtml(activeName)} only · <a href="${escapeHtml(hrefFor(null))}" style="color:#4f9dff;text-decoration:none;">✕ clear</a></div>`
    : ''
  return `<div class="beebo-genres" aria-label="Genres" style="display:flex;flex-wrap:wrap;gap:8px;margin:0 0 14px;">${chips}</div>${clearLine}`
}

// Small certification + up-to-N genre chips block for a card/detail page —
// same data the desktop cards show, rendered from the cached match/meta
// object only. Empty string when there's nothing to show.
function certGenreChipsHtml(meta, genreNames, maxGenres = 2, margin = 'margin-top:4px;') {
  if (!meta) return ''
  const bits = []
  if (meta.certification) {
    bits.push(
      `<span style="font-size:10px;font-weight:700;padding:1px 6px;border-radius:4px;background:${certColor(meta.certification)};color:#111;">${escapeHtml(meta.certification)}</span>`
    )
  }
  for (const gid of (Array.isArray(meta.genre_ids) ? meta.genre_ids : []).slice(0, maxGenres)) {
    const name = genreNames[gid]
    if (name) bits.push(`<span style="font-size:10px;padding:1px 6px;border-radius:4px;background:#22262f;color:#8a8f98;">${escapeHtml(name)}</span>`)
  }
  if (!bits.length) return ''
  return `<div style="display:flex;flex-wrap:wrap;gap:4px;${margin}">${bits.join('')}</div>`
}

// --- Detected-quality badges (read-only view of video-quality-cache.json) ---
// Tier names mirror videoQuality.js / the desktop QUALITY_TIERS: '2160p'→4K,
// '1080p', '720p', '480p'→SD. Unknown/unprobed files get NO badge on the
// website (the desktop shows '?' — deliberately omitted here).
const QUALITY_TIER_LABELS = { '2160p': '4K', '1080p': '1080p', '720p': '720p', '480p': 'SD' }
const QUALITY_TIER_ORDER = { '2160p': 4, '1080p': 3, '720p': 2, '480p': 1 }

// Loaded once and only re-read when the cache file's mtime changes, so every
// page render costs one statSync — the desktop app rewrites the file whenever
// it probes something new.
let qualityCacheState = { file: null, mtimeMs: -1, data: {} }
function loadQualityCache(cacheDir) {
  if (!cacheDir) return {}
  const file = videoQuality.cacheFile(cacheDir)
  try {
    const mtimeMs = fs.statSync(file).mtimeMs
    if (qualityCacheState.file !== file || qualityCacheState.mtimeMs !== mtimeMs) {
      qualityCacheState = { file, mtimeMs, data: JSON.parse(fs.readFileSync(file, 'utf8')) }
    }
  } catch {
    // missing/corrupt cache must never break a page — just render no badges
    qualityCacheState = { file, mtimeMs: -1, data: {} }
  }
  return qualityCacheState.data
}

// Cache entries are keyed `${path}::${mtimeMs}::${size}` (videoQuality.keyFor)
// so a replaced file at the same path never shows a stale tier. statLike with
// {mtimeMs, size} (e.g. from scanMediaDir) avoids a redundant statSync.
function qualityTierFor(qualityCache, filePath, statLike) {
  if (!qualityCache || !filePath) return null
  try {
    const stat = statLike && statLike.mtimeMs != null && statLike.size != null ? statLike : parseMemo.statMemo(filePath)
    const tier = qualityCache[videoQuality.keyFor(filePath, stat)]
    return QUALITY_TIER_LABELS[tier] ? tier : null
  } catch {
    return null
  }
}

// --- Away-from-home quality cap (real, server-side entitlement enforcement) ---
// Both household tiers (beebo-standard / beebo-standard-4k) are otherwise
// identical; only the maximum quality allowed AWAY FROM HOME differs. Home
// playback (localAccess.isHomeRequest) is never touched by any of this.
//
// The cap only ever turns on together with the rest of licensing enforcement
// (license.evaluate().enforced) - exactly like the pre-existing away-access
// gate a little further down in handleRequest. Until the licensing backend
// is switched on for a build, nothing here changes behaviour, matching this
// file's existing "ship dark" philosophy for license.js.
//
// The plan comes from the verified, signed license payload (tamper-resistant:
// a user who hand-edits the electron-store JSON cannot grant themselves 4K)
// rather than from store('license.plan') directly. That store key (written by
// license.js on every accepted token) is kept only as a same-process fallback
// for the rare case evaluate() is enforced but the token payload itself
// somehow lacks a plan - it is never treated as more authoritative than the
// signed payload.
// The connection-type signal (see awayQualityPolicy.js's REMOTE_PATH_HEADER docs): only
// trusted once the request is confirmed to have really come through the local
// remote-host agent (loopback + the per-run agent secret) - exactly like every other
// x-beebo-remote-* header this server reads. A request FROM the agent that lacks the
// header (an old agent build) reads as '', which isFreeRemoteConnection() never treats
// as free. A request that is NOT from the agent and is not a home request never used
// Beebo's relay (that always terminates at the agent), so it is 'direct' = free; see
// awayQualityPolicy.remotePathFor() for the reasoning and the spoofing analysis.
function trustedRemotePath(req, localAccess) {
  try {
    if (!localAccess || typeof localAccess.fromHostAgent !== 'function') return ''
    const fromHostAgent = localAccess.fromHostAgent(req) === true
    return awayQualityPolicy.remotePathFor({
      fromHostAgent,
      isHomeRequest: fromHostAgent || typeof localAccess.isHomeRequest !== 'function' ? undefined : localAccess.isHomeRequest(req),
      header: req && req.headers && req.headers[awayQualityPolicy.REMOTE_PATH_HEADER]
    })
  } catch {
    return ''
  }
}

// A direct or own-relay away connection (see awayQualityPolicy.isFreeRemoteConnection)
// is free at any quality: only a connection that actually used BEEBO'S relay - the one
// case that costs Beebo real money - keeps the plan-based cap below.
function currentAwayQualityCap(license, store, remotePath) {
  try {
    if (awayQualityPolicy.isFreeRemoteConnection(remotePath)) return null
    if (!license || typeof license.evaluate !== 'function') return null
    const ev = license.evaluate()
    if (!ev || !ev.enforced) return null
    let plan = ev.payload && ev.payload.plan
    if (!plan) {
      try { plan = store && typeof store.get === 'function' ? store.get('license.plan') : null } catch { plan = null }
    }
    return awayQualityPolicy.awayQualityCapForPlan(plan || 'beebo-standard')
  } catch {
    return null
  }
}

// Gate for the two direct/"Original" file routes (/tvfile, /file). Returns
// true when it has fully handled the response itself (either redirected the
// viewer into the existing capped HLS transcode pipeline, or refused with an
// explanation) - the caller must not also call serveVideoFile in that case.
// Returns false to mean "proceed as before" (home request, cap not enforced,
// 4K-tier household, or a file this cap has no proof exceeds 1080p yet).
// Everything the request needs (license, store, localAccess, playback, the
// already-loaded quality cache) is passed in explicitly rather than closed
// over, the same way qualityTierFor/loadQualityCache above take their
// dependencies as parameters - this function lives at module scope, outside
// startStreamServer's closure.
async function enforceAwayQualityCap(req, res, { kind, id, filePath, statLike, userId, license, store, localAccess, playback, qualityCache }) {
  try {
    if (localAccess.isHomeRequest(req)) return false
    const cap = currentAwayQualityCap(license, store, trustedRemotePath(req, localAccess))
    if (!cap || cap === '4k') return false
    const tier = qualityTierFor(qualityCache, filePath, statLike)
    if (!awayQualityPolicy.tierExceedsAwayCap(tier, cap)) return false
    // A download saves whatever comes back as the film: a redirect into the HLS pipeline would
    // be stored as a tiny playlist and shown as finished. Say no, plainly, instead.
    if (req.headers['x-beebo-download']) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({
        ok: false,
        error: 'away_quality_capped',
        maxAwayQuality: cap,
        message: 'This household plan limits away-from-home downloads to 1080p. Download this one at home, on Wi-Fi.'
      }))
      return true
    }
    // Refuse to hand over the original above-cap file; redirect into the same
    // transcode pipeline the manual 1080p/720p/480p quality picker already
    // uses (hlsTranscoder.js via playbackApi.js) - nothing new is built here.
    let started = null
    try {
      started = await playback.start({ kind, id, quality: '1080p' }, userId)
    } catch {
      started = null
    }
    if (started && started.status === 200 && started.body && started.body.url) {
      res.writeHead(302, { Location: started.body.url, 'Cache-Control': 'no-store' })
      res.end()
      return true
    }
    const status = (started && started.status) || 503
    const message = (started && started.body && started.body.message) ||
      'This household plan limits away-from-home playback to 1080p, and the PC could not start a capped stream right now.'
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, error: 'away_quality_capped', maxAwayQuality: cap, message }))
    return true
  } catch {
    // A bug here must never turn into a hang or an unexplained 500 on
    // ordinary playback - treat it like "could not prove this needs capping".
    return false
  }
}

// Best known tier across a show's episode files ({path, mtimeMs, size} each) —
// same "best copy wins" read as the desktop's show-level badge.
function bestQualityTier(qualityCache, files) {
  let best = null
  for (const f of files || []) {
    const tier = qualityTierFor(qualityCache, f && f.path, f)
    if (tier && (!best || QUALITY_TIER_ORDER[tier] > QUALITY_TIER_ORDER[best])) best = tier
  }
  return best
}

// Bottom-right of the poster, like the desktop card. `raised` lifts it above
// the full-width NEW banner (desktop's bottom: 22 when recently added).
function qualityBadgeHtml(tier, raised) {
  const label = QUALITY_TIER_LABELS[tier]
  if (!label) return ''
  return `<div style="position:absolute;bottom:${raised ? '22px' : '4px'};right:4px;z-index:1;background:rgba(0,0,0,0.75);border:1px solid rgba(255,255,255,0.25);color:#eee;font-size:10px;font-weight:800;letter-spacing:0.5px;padding:2px 5px;border-radius:4px;">${label}</div>`
}

// ℹ️ toggle button + tap-anywhere-to-close overlay showing title, colored
// certification, genre names, and the cached TMDB overview — a server-rendered
// port of the desktop card's info toggle. The overlay ships hidden; the shared
// delegation script in page() flips it, and preventDefaults so the card link
// underneath never fires. Everything user-visible is escaped.
function infoButtonHtml(meta) {
  return `<button type="button" class="icon-btn info-btn" style="left:4px;" title="${
    meta && meta.overview ? 'Show description' : 'No description available'
  }">ℹ️</button>`
}

// Main-cast strip for the ℹ️ overlay — up to 8 people as small circular
// photos with their name (and character, when the cache has one) underneath,
// in a horizontal scroll strip. STRICTLY cache-only: `cast` comes from
// credits.json / tv-credits.json (or the in-memory maps those feed), and the
// photo falls back to a TMDB CDN URL only when actorPhotoUrl already would.
// No cached cast => this returns '' and the overlay simply has no cast section.
function castStripHtml(cast, { cacheDir = null, actorBase = '', images = null } = {}) {
  const people = (Array.isArray(cast) ? cast : []).filter((c) => c && c.name).slice(0, 8)
  if (!people.length) return ''
  const items = people
    .map((c) => {
      const name = String(c.name)
      const character = c.character || c.role ? String(c.character || c.role) : ''
      const photoSrc = actorPhotoUrl(cacheDir, c.id, c.profilePath || c.profile_path || null, images)
      const photo = photoSrc
        ? `<img class="cast-photo" src="${escapeHtml(photoSrc)}" alt="${escapeHtml(name)}" loading="lazy" decoding="async">`
        : `<span class="cast-photo cast-nophoto">${escapeHtml(name.charAt(0))}</span>`
      // Nested <a> inside the overlay (which itself sits inside the card's <a>)
      // would be invalid HTML, so clickable people are spans the page()-level
      // delegated handler navigates for — exactly how the 🔗 sequel chip works.
      const inner = `${photo}<span class="cast-name">${escapeHtml(name)}</span>${
        character ? `<span class="cast-char">${escapeHtml(character)}</span>` : ''
      }`
      return actorBase
        ? `<span class="cast-item cast-link" role="button" tabindex="0" data-href="${escapeHtml(
            actorBase + encodeURIComponent(name)
          )}" title="${escapeHtml(name)}">${inner}</span>`
        : `<span class="cast-item">${inner}</span>`
    })
    .join('')
  return `<div class="cast-sec">
      <div class="cast-head">Cast</div>
      <div class="cast-strip">${items}</div>
    </div>`
}

function infoOverlayHtml(title, meta, genreNames, cast, castOpts) {
  const genreLine = (meta && Array.isArray(meta.genre_ids) ? meta.genre_ids : [])
    .map((id) => genreNames[id])
    .filter(Boolean)
    .join(', ')
  const cert = meta && meta.certification ? String(meta.certification) : ''
  const certLine =
    cert || genreLine
      ? `<div class="muted" style="margin-bottom:6px;">${
          cert ? `<span style="color:${certColor(cert)};font-weight:700;">${escapeHtml(cert)}</span>` : ''
        }${cert && genreLine ? ' · ' : ''}${escapeHtml(genreLine)}</div>`
      : ''
  return `<div class="info-overlay" hidden>
    <strong style="display:block;margin-bottom:6px;">${escapeHtml(title || '')}</strong>
    ${certLine}
    ${meta && meta.overview ? escapeHtml(meta.overview) : 'No description available for this title yet.'}
    ${castStripHtml(cast, castOpts || {})}
  </div>`
}

// Writes (or clears) one file's entry in the shared on-disk manifest. Pulled out
// because the review page and the lookup path must write it identically; a null
// is a real value here and means "no match recorded".
function writeManifestMatch(cacheDir, fileName, match) {
  if (!cacheDir || !fileName) return
  try {
    const paths = tmdbFileCache.ensureDirs(cacheDir)
    // Read-modify-write with no await in between, so two concurrent writers
    // cannot clobber each other's entries in this shared file.
    const manifest = tmdbFileCache.getManifest(cacheDir)
    manifest[fileName] = match || null
    tmdbFileCache.writeJson(paths.manifestFile, manifest)
  } catch {
    // a read-only or full cache dir must never break a page render
  }
}

// Pulls the top few candidate posters of a queued file onto disk while we still
// have the internet we just used to fetch them. They go into the SAME posters/
// folder at the SAME w300 size as confirmed posters, so /media/poster/<id>.jpg
// serves them with no new route, the review page never talks to image.tmdb.org,
// and confirming one needs no download at all. Top 3 bounds the disk cost.
const REVIEW_POSTER_PREFETCH = 3
async function cacheReviewPosters(cacheDir, candidates) {
  if (!cacheDir) return
  try {
    const paths = tmdbFileCache.ensureDirs(cacheDir)
    for (const c of (candidates || []).slice(0, REVIEW_POSTER_PREFETCH)) {
      if (!c || !c.posterPath || c.kind === 'tv' || c.id == null) continue
      await tmdbFileCache.downloadImage(`https://image.tmdb.org/t/p/w300${c.posterPath}`, path.join(paths.postersDir, `${c.id}.jpg`))
    }
  } catch {
    // a missing thumbnail must never stop a file being queued for review
  }
}

// The settings store as one page render sees it: config.json is read and
// parsed once, on the first get(), and every later get() answers from that
// copy. electron-store has no copy of its own; each store.get() re-reads and
// re-parses the whole file (tens of KB). tmdbLookup reads it three times per
// film (the decision, then shouldLookUp's decision and review-queue checks),
// which on a 500-film library was 1,500 parses and over a second of blocked
// event loop on every load of the movies page.
//
// Scoped to one render on purpose, not memoised for the process: a setting
// changed by anything (the desktop app's settings screen, the review page, a
// backup restore) shows on the very next page load with nothing to invalidate.
// A write through this view (applyVerdict queuing a file mid-render) goes to
// the real store and drops the copy, so the next get() reads what was written.
// Answers match store.get(key, default) exactly: plain keys are looked up the
// way dot-prop does for a one-segment path, anything else goes to the store.
function renderSettings(store) {
  let copy = null
  const plainKey = (key) => typeof key === 'string' && /^[A-Za-z0-9_$-]+$/.test(key) && key !== '__proto__' && key !== 'prototype' && key !== 'constructor'
  // OS-encrypted settings (secretSettings.js) aren't in store.store as plain
  // values, so they must go through store.get, which decrypts them. Without this
  // the home page saw no TMDB key once that key was encrypted. The list covers
  // every encrypted setting: TMDB/email/Cloudflare keys, the session, media,
  // upload-id and API token secrets, and authUsers (its access codes are
  // encrypted fields). Dotted keys such as license.token already go to store.get.
  let secretKeys
  try { secretKeys = new Set(require('./secretSettings').ENCRYPTED_KEY_NAMES || []) } catch { secretKeys = new Set() }
  return {
    get(key, defaultValue) {
      if (!plainKey(key) || secretKeys.has(key)) return store.get(key, defaultValue)
      if (!copy) copy = store.store
      const v = copy[key]
      return v === undefined ? defaultValue : v
    },
    set(...args) {
      copy = null
      return store.set(...args)
    },
    delete(key) {
      copy = null
      return store.delete(key)
    }
  }
}

// This used to run its own, much dumber matcher: one year-FILTERED search, then
// `data.results?.[0]` with no title check at all. So a film whose filename
// carried a typo'd year had no candidates to pick from, and a film whose name
// TMDB could make nothing of got whatever happened to come back first. Worse,
// the desktop app's version of this had a (different) title check, so the two
// halves of the app could attach different films to the same file. Both now go
// through titleMatch.
//
// `store` is threaded in so this can see the owner's confirmed decisions. It is
// optional: without it the function behaves exactly as it always did apart from
// using the better matcher, which keeps every existing caller and test working.
// A page looking up every film passes renderSettings(store) as `store`, and the
// manifest it already read as `manifestForRender`, so no film costs a settings
// parse or a stat of manifest.json. That is the object getManifest() hands out
// (and writeManifestMatch updates in place), so the answers are the same.
async function tmdbLookup(fileName, key, cacheDir, store, manifestForRender) {
  return metadataMerge.mergeMovie(await tmdbLookupRaw(fileName, key, cacheDir, store, manifestForRender), { cacheDir, fileName })
}

async function tmdbLookupRaw(fileName, key, cacheDir, store, manifestForRender) {
  const readManifest = () => manifestForRender || tmdbFileCache.getManifest(cacheDir)
  // A confirmed decision outranks everything, including the cache.
  const decision = store ? titleMatch.getDecision(store, fileName) : null
  if (decision && (decision.notAMovie || decision.kind !== 'movie')) return null
  if (decision) {
    const held = cacheDir ? readManifest()[fileName] : null
    if (held && held.id === decision.tmdbId) return held
    if (tmdbCache.has(fileName)) {
      const mem = tmdbCache.get(fileName)
      if (mem && mem.id === decision.tmdbId) return mem
    }
    // The decision stands but its cached row is missing. Re-fetch that exact id
    // and nothing else — a search here could return a different film and quietly
    // undo an answer a person gave. With no key or no internet this returns
    // null, which shows the file with no poster rather than with a wrong one.
    const repaired = await titleMatch.fetchById(titleMatch.createTmdbApi(key), 'movie', decision.tmdbId)
    if (repaired) {
      tmdbCache.set(fileName, repaired)
      writeManifestMatch(cacheDir, fileName, repaired)
    }
    return repaired
  }

  // On-disk cache first (populated by the desktop app's "Download all TMDB info
  // for offline use" button) — this is what lets the site run with no internet.
  //
  // The `in` test became shouldLookUp() for one reason: a cached `null` used to
  // count as a final answer, which is why 267 files in this library are stuck
  // without a poster. A null now means "unanswered" and is re-evaluated once.
  // Nothing here can make a network call when there is no key, so the offline
  // path is unchanged: no key, or no internet, and this still answers purely
  // from disk.
  const manifest = cacheDir ? readManifest() : null
  const needsLookup = store ? titleMatch.shouldLookUp(store, fileName, manifest, false) : !(manifest && fileName in manifest)
  if (manifest && fileName in manifest && !needsLookup) return manifest[fileName]
  if (tmdbCache.has(fileName)) return tmdbCache.get(fileName)
  if (!key) return manifest && fileName in manifest ? manifest[fileName] : null

  const parsed = metadataMerge.enrichParsed(fileName, parseMovieTitle(fileName))
  const api = titleMatch.createTmdbApi(key)
  try {
    const verdict = await titleMatch.matchParsed(parsed, api)
    const previous = manifest && fileName in manifest ? manifest[fileName] : null
    // Only certain/probable are accepted. Anything unsure goes on the owner's
    // "Titles to check" list instead of being written down as fact — and if the
    // file already had a match, it keeps it.
    const applied = store
      ? titleMatch.applyVerdict(store, fileName, verdict, previous)
      : { accepted: verdict.confidence === 'certain' || verdict.confidence === 'probable', match: verdict.match, queued: false }
    const match = applied.accepted && verdict.match ? verdict.match.raw : applied.match || null
    tmdbCache.set(fileName, match)
    // Write through to the shared on-disk cache so the next viewer, the phone
    // app and an offline install all get this without another network call —
    // same write-through tmdbLookupTv has always done.
    if (cacheDir && applied.accepted && match) {
      writeManifestMatch(cacheDir, fileName, match)
      if (match.poster_path) {
        try {
          const paths = tmdbFileCache.ensureDirs(cacheDir)
          await tmdbFileCache.downloadImage(
            `https://image.tmdb.org/t/p/w300${match.poster_path}`,
            path.join(paths.postersDir, `${match.id}.jpg`)
          )
        } catch {}
      }
    }
    if (cacheDir && applied.queued) await cacheReviewPosters(cacheDir, verdict.candidates)
    return match
  } catch {
    tmdbCache.set(fileName, null)
    return null
  }
}

// `creditsForRender`: credits.json as the calling page already read it (see
// tmdbLookup's manifest), so a grid asking per film costs no stat per film.
async function tmdbCredits(movieId, key, cacheDir, creditsForRender) {
  if (!movieId) return []
  if (cacheDir) {
    const creditsMap = creditsForRender || tmdbFileCache.getCreditsMap(cacheDir)
    // A cast cached before `character` existed is treated as unanswered, not
    // trusted forever — see castCredits.isStaleCast.
    if (movieId in creditsMap && !castCredits.isStaleCast(creditsMap[movieId])) return creditsMap[movieId]
  }
  if (creditsCache.has(movieId) && !castCredits.isStaleCast(creditsCache.get(movieId))) return creditsCache.get(movieId)
  if (!key) return []

  const isV4Token = key.split('.').length === 3
  const url = isV4Token
    ? `https://api.themoviedb.org/3/movie/${movieId}/credits`
    : `https://api.themoviedb.org/3/movie/${movieId}/credits?api_key=${key}`

  try {
    const res = await fetch(url, {
      headers: isV4Token ? { Authorization: `Bearer ${key}`, accept: 'application/json' } : { accept: 'application/json' }
    })
    if (!res.ok) {
      creditsCache.set(movieId, [])
      return []
    }
    const data = await res.json()
    const cast = castCredits.parseCast(data)
    creditsCache.set(movieId, cast)
    return cast
  } catch {
    creditsCache.set(movieId, [])
    return []
  }
}

// --- Franchise (movie collection) + TV season-count lookups ---
// Powers the website's "Sequels" and "Missing Episodes" tabs. Mirrors the
// tmdb:movieCollection / tmdb:tvShowSeasons IPC handlers in main.js (same
// endpoints, same v3-key vs v4-bearer-token handling), but persisted to disk
// in the shared TMDB cache dir (collections.json / tvSeasons.json) so each
// movie/show is looked up over the network at most once ever — after that the
// pages render entirely from cache, internet or not.
const TMDB_LOOKUP_CONCURRENCY = 5 // parallel TMDB fetches per page load
const TMDB_PAGE_LOOKUP_CAP = 40 // max first-time lookups per page load; the rest fill in on later visits

// String(movie tmdb id) -> collection {id,name,parts:[{id,title,release_date,poster_path}]} or null (not in one)
const movieCollectionCache = new Map()
// String(collection id) -> collection — avoids re-fetching a collection two owned parts share
const collectionDetailsCache = new Map()
let movieCollectionDiskLoaded = false
// String(tv tmdb id) -> [{season_number, episode_count, name, air_date}]
const tvSeasonsCache = new Map()
let tvSeasonsDiskLoaded = false

function collectionsCacheFile(cacheDir) {
  return path.join(cacheDir, 'collections.json')
}
function tvSeasonsCacheFile(cacheDir) {
  return path.join(cacheDir, 'tvSeasons.json')
}

function ensureCollectionsLoaded(cacheDir) {
  if (movieCollectionDiskLoaded || !cacheDir) return
  movieCollectionDiskLoaded = true
  const data = tmdbFileCache.readJson(collectionsCacheFile(cacheDir))
  for (const [id, col] of Object.entries(data)) {
    movieCollectionCache.set(id, col)
    if (col && col.id != null) collectionDetailsCache.set(String(col.id), col)
  }
}

function ensureTvSeasonsLoaded(cacheDir) {
  if (tvSeasonsDiskLoaded || !cacheDir) return
  tvSeasonsDiskLoaded = true
  const data = tmdbFileCache.readJson(tvSeasonsCacheFile(cacheDir))
  for (const [id, seasons] of Object.entries(data)) tvSeasonsCache.set(id, seasons)
}

function persistJsonMap(file, map) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    tmdbFileCache.writeJson(file, Object.fromEntries(map))
  } catch {
    // disk write failing (full disk, perms) must never break page rendering —
    // worst case the lookup happens again on a future launch
  }
}

// Runs fn over items with at most `limit` in flight at once. Never rejects —
// fn is expected to catch its own errors (all the fetchers below do).
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++
      try {
        results[i] = await fn(items[i], i)
      } catch {
        results[i] = undefined
      }
    }
  })
  await Promise.all(workers)
  return results
}

// Two TMDB calls the first time a movie is checked: movie details (to learn
// its belongs_to_collection) then the collection itself (to list every part).
// Returns the collection object, null (movie isn't in a collection), or
// undefined (fetch failed — caller should NOT cache that, so it retries later).
async function fetchMovieCollection(movieId, key) {
  const isV4Token = key.split('.').length === 3
  const headers = isV4Token ? { Authorization: `Bearer ${key}`, accept: 'application/json' } : { accept: 'application/json' }
  try {
    const detailsUrl = isV4Token
      ? `https://api.themoviedb.org/3/movie/${movieId}`
      : `https://api.themoviedb.org/3/movie/${movieId}?api_key=${key}`
    const detailsRes = await fetch(detailsUrl, { headers })
    if (!detailsRes.ok) return undefined
    const details = await detailsRes.json()
    const collectionRef = details.belongs_to_collection
    if (!collectionRef) return null

    const cached = collectionDetailsCache.get(String(collectionRef.id))
    if (cached) return cached

    const collectionUrl = isV4Token
      ? `https://api.themoviedb.org/3/collection/${collectionRef.id}`
      : `https://api.themoviedb.org/3/collection/${collectionRef.id}?api_key=${key}`
    const collectionRes = await fetch(collectionUrl, { headers })
    if (!collectionRes.ok) return undefined
    const collectionData = await collectionRes.json()
    const collection = {
      id: collectionData.id,
      name: collectionData.name,
      parts: (collectionData.parts || []).map((p) => ({
        id: p.id,
        title: p.title,
        release_date: p.release_date || null,
        poster_path: p.poster_path || null
      }))
    }
    collectionDetailsCache.set(String(collectionRef.id), collection)
    return collection
  } catch {
    return undefined
  }
}

// One TMDB call per show: /tv/{id} lists every season with its episode_count.
// Returns the seasons array, or undefined on failure (again: don't cache that).
async function fetchTvSeasons(tvId, key) {
  const isV4Token = key.split('.').length === 3
  const headers = isV4Token ? { Authorization: `Bearer ${key}`, accept: 'application/json' } : { accept: 'application/json' }
  const url = isV4Token
    ? `https://api.themoviedb.org/3/tv/${tvId}`
    : `https://api.themoviedb.org/3/tv/${tvId}?api_key=${key}`
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(6000) })
    if (!res.ok) return undefined
    const data = await res.json()
    return (data.seasons || [])
      .filter((s) => s.season_number > 0)
      .map((s) => ({ season_number: s.season_number, episode_count: s.episode_count, name: s.name, air_date: s.air_date || null }))
  } catch {
    return undefined
  }
}

// Given the episode files on disk and TMDB's per-season episode counts,
// returns [{ season, missing: [4, 7], total }] for every season the user owns
// at least one episode of that has holes. Seasons TMDB doesn't know about (or
// with no episode_count) are skipped rather than guessed at.
function computeMissingEpisodes(ownedEpisodes, seasons) {
  const ownedBySeason = new Map()
  for (const ep of ownedEpisodes || []) {
    if (ep.season === null || ep.season === undefined || ep.episode === null || ep.episode === undefined) continue
    if (!ownedBySeason.has(ep.season)) ownedBySeason.set(ep.season, new Set())
    ownedBySeason.get(ep.season).add(ep.episode)
  }
  const gaps = []
  const seasonNums = Array.from(ownedBySeason.keys()).sort((a, b) => a - b)
  for (const seasonNum of seasonNums) {
    const info = (seasons || []).find((s) => s.season_number === seasonNum)
    if (!info || !info.episode_count) continue
    const ownedSet = ownedBySeason.get(seasonNum)
    const missing = []
    for (let n = 1; n <= info.episode_count; n++) {
      if (!ownedSet.has(n)) missing.push(n)
    }
    if (missing.length) gaps.push({ season: seasonNum, missing, total: info.episode_count })
  }
  return gaps
}

// Small note shown when a page still has uncached titles (no API key, fetch
// failures, or the per-page lookup cap was hit) — the pages degrade to
// rendering whatever IS cached instead of erroring.
function uncheckedNote(count, hasKey) {
  if (!count) return ''
  const reason = hasKey
    ? `They'll fill in automatically as this page is revisited (up to ${TMDB_PAGE_LOOKUP_CAP} are checked per visit).`
    : `Add a TMDB key in the app's Settings to check them.`
  return `<p class="muted" style="background:#171a21;border-radius:8px;padding:10px 14px;margin:0 0 16px;">
    ${count} title${count === 1 ? " hasn't" : "s haven't"} been checked yet — ${reason}
  </p>`
}

function sectionNav(active, isAdmin, secure = true) {
  const sections = [
    { key: 'movies', label: '🎬 Movies', href: '/' },
    { key: 'tvshows', label: '📺 TV Shows', href: '/tvshows' },
    { key: 'music', label: '🎵 Music', href: '/music' },
    { key: 'audiobooks', label: '🎧 Audiobooks', href: '/audiobooks' },
    // Not admin-gated on purpose — channel surfing is for everyone in the house.
    { key: 'surprise', label: '🎲 Not Sure What To Watch?', href: '/surprise' },
    // Phone app download — everyone, not just admins.
    { key: 'getapp', label: '📱 Get the Apps', href: '/get-app' },
    // BeeboSchool — kid lessons; open to the whole household like Surprise.
    { key: 'school', label: '🎓 BeeboSchool', href: '/school' },
    // Photos: the page itself says when the owner has not shared Photos with this person.
    { key: 'photos', label: '📷 Photos', href: '/photos' },
    // Everyone gets their own resume list — it only ever shows the viewer's
    // own part-watched titles.
    { key: 'continue', label: '▶ Continue Watching', href: '/continue' },
    // Everyone's own playlists (and the ones the owner shares with the house).
    { key: 'playlists', label: '🎵 Playlists', href: '/playlists' },
    // The suggestion box has always existed and posts to /api/suggestions, but
    // nothing linked to it, so nobody could reach it. Open to the whole house.
    { key: 'privacy', label: 'Viewing privacy', href: '/viewing-privacy' },
    // Keys for one's own tools (Home Assistant, a dashboard): everyone, their own only.
    { key: 'apikeys', label: 'API keys', href: '/my-api-keys' },
    { key: 'suggest', label: '💡 Suggest a Feature', href: '/suggest' },
    // Per-person colour theme (electron/theme.js); open to everyone.
    { key: 'appearance', label: 'Appearance', href: '/appearance' },
    // Two-factor sign-in, password, signed-in devices (electron/accountSecurityWeb.js).
    { key: 'security', label: 'Account security', href: '/account/security' }
  ]
  if (liveTvNavVisible) sections.push({ key: 'livetv', label: '📡 Live TV', href: '/livetv' })
  if (isAdmin) sections.push({ key: 'upload', label: '⬆️ Upload', href: '/upload' })
  // Same pattern as Upload: the entry is only ever BUILT for an admin, so a
  // regular member's HTML contains no mention of /admin at all — there is
  // nothing to notice, not even a disabled link. The nav is only a courtesy
  // though; every /admin* route re-checks isAdmin server-side for itself.
  if (isAdmin && secure) sections.push({ key: 'admin', label: '🛡️ Admin', href: '/admin' })
  return browserChrome.sidebar(sections, active)
}

// --- /surprise step 1: movie or TV show? ---
function surpriseChromeTop(isAdmin) {
  return `<div class="topbar">
      <h2 style="margin:0;">Beebo Entertainment</h2>
      <a href="/logout" class="muted" style="color:#8a8f98;">Log out</a>
    </div>
    ${sectionNav('surprise', isAdmin)}`
}

const SURPRISE_CARD_CSS = `background:#171a21;border:1px solid #2a2f3a;border-radius:16px;color:#eee;
  text-decoration:none;padding:38px 24px;text-align:center;font-size:20px;font-weight:700;line-height:1.5;
  display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;min-height:180px;`

function surpriseKindPage({ isAdmin }) {
  const card = (href, icon, label, sub) =>
    `<a href="${escapeHtml(href)}" style="${SURPRISE_CARD_CSS}">
      <span style="font-size:46px;line-height:1;">${icon}</span>
      <span>${escapeHtml(label)}</span>
      <span class="muted" style="font-size:13px;font-weight:500;">${escapeHtml(sub)}</span>
    </a>`
  return page(`
    ${surpriseChromeTop(isAdmin)}
    <div style="max-width:760px;margin:10px auto 0;">
      <h2 style="font-size:30px;margin:0 0 6px;text-align:center;">🎲 Not Sure What To Watch?</h2>
      <p class="muted" style="text-align:center;margin:0 0 26px;">
        Pick one and we'll drop you into something at random — right in the middle, like flipping channels.
      </p>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px;">
        ${card('/surprise?kind=movie', '🎬', 'Movies', 'Surf the movie library')}
        ${card('/surprise?kind=tv', '📺', 'TV Shows', 'Surf every episode you own')}
        ${card('/surprise?kind=both', '🍿', 'Both', 'Movies + TV mixed together')}
      </div>
    </div>
    ${HEARTBEAT_SCRIPT}
  `)
}

// --- /surprise step 2: which category? ---
// `counts` is a genre-id -> count Map built from the same cached TMDB meta the
// library's genre chips use, so an empty cache just means fewer chips here.
// `counts` is genre-id -> count over the pool AFTER the year/decade filter, and
// `yearSummary` (surfYearSummary) is built over the pool AFTER the genre filter
// — so each chip row always shows what picking it would really give you.
// Refining a filter is a plain stateless link (no seed); only the "Start
// surfing" links mint the seed that fixes the running order for the session.
function surpriseGenrePage({ isAdmin, kind, counts, total, seed, genre = '', year = null, decade = null, yearSummary = null }) {
  const genreNames = surfGenreNames(kind)
  const label = surfKindLabel(kind)
  const activeGenre = genre && genreNames[genre] ? String(genre) : ''
  // A chosen year implies its decade, so the year row stays open on reload.
  const openDecade = year !== null ? Math.floor(year / 10) * 10 : decade

  const paramsFor = (over) => {
    const p = new URLSearchParams()
    p.set('kind', kind)
    const g = 'genre' in over ? over.genre : activeGenre
    const y = 'year' in over ? over.year : year
    const d = 'decade' in over ? over.decade : decade
    if (g) p.set('genre', String(g))
    if (y !== null && y !== undefined && y !== '') p.set('year', String(y))
    else if (d !== null && d !== undefined && d !== '') p.set('decade', String(d))
    return p
  }
  const refineHref = (over) => `/surprise?${paramsFor(over).toString()}`
  const playHref = (over) => {
    const p = paramsFor(over)
    p.set('seed', String(seed))
    p.set('i', '0')
    return `/surprise/play?${p.toString()}`
  }

  const chip = (href, text, active) =>
    `<a href="${escapeHtml(href)}" style="font-size:14px;font-weight:600;padding:11px 18px;border-radius:999px;
      text-decoration:none;white-space:nowrap;${
        active
          ? 'background:#4f9dff;color:#0f1115;border:1px solid #4f9dff;'
          : 'background:#171a21;color:#eee;border:1px solid #2a2f3a;'
      }">${escapeHtml(text)}</a>`

  // --- genres ---
  const present = Object.entries(genreNames)
    .filter(([id]) => counts.get(Number(id)))
    .sort((a, b) => a[1].localeCompare(b[1]))
  const genreChips = [
    chip(refineHref({ genre: '' }), '🎲 Any category', !activeGenre),
    ...present.map(([id, name]) => chip(refineHref({ genre: id }), `${name} (${counts.get(Number(id))})`, activeGenre === String(id)))
  ].join('')
  const noChips = present.length
    ? ''
    : `<p class="muted" style="margin:0 0 12px;">No genre info has been downloaded for these titles yet, so there's
        nothing to narrow by — <b>🎲 Any category</b> works regardless.</p>`

  // --- years: decade row, then the individual years inside the open decade ---
  const summary = yearSummary || { decades: [], years: [], unknownCount: 0 }
  const decadeChips = [
    chip(refineHref({ year: null, decade: null }), '📅 Any year', year === null && decade === null),
    ...summary.decades.map((d) => chip(refineHref({ year: null, decade: d.decade }), `${d.label} (${d.count})`, openDecade === d.decade))
  ].join('')
  const yearsInDecade =
    openDecade === null ? [] : summary.years.filter((y) => y.year >= openDecade && y.year <= openDecade + 9)
  const yearRow = yearsInDecade.length
    ? `<div style="display:flex;flex-wrap:wrap;gap:8px;margin:10px 0 0;padding:12px 0 0;border-top:1px solid #2a2f3a;">
        ${chip(refineHref({ year: null, decade: openDecade }), `All of ${openDecade}s`, year === null)}
        ${yearsInDecade.map((y) => chip(refineHref({ year: y.year, decade: null }), `${y.year} (${y.count})`, year === y.year)).join('')}
      </div>`
    : ''
  const noYears = summary.decades.length
    ? ''
    : `<p class="muted" style="margin:0 0 12px;">No release years are known for these titles yet — <b>📅 Any year</b>
        is the only option until TMDB data has been downloaded.</p>`
  const unknownNote =
    summary.unknownCount && (year !== null || decade !== null)
      ? `<p class="muted" style="margin:10px 0 0;font-size:12px;">${escapeHtml(String(summary.unknownCount))} ${surfKindNoun(
          kind,
          summary.unknownCount
        )} with no known release year ${summary.unknownCount === 1 ? 'is' : 'are'} left out while a year filter is on.</p>`
      : ''

  // --- current selection ---
  const filterLabel = surfFilterLabel(kind, { genre: activeGenre, year, decade })
  const selectionLine = filterLabel
    ? `<p class="muted" style="margin:0 0 18px;font-size:13px;">Surfing: <b style="color:#eee;">${escapeHtml(
        filterLabel
      )}</b> · <a href="${escapeHtml(
        refineHref({ genre: '', year: null, decade: null })
      )}" style="color:#4f9dff;text-decoration:none;">✕ clear</a></p>`
    : ''

  return page(`
    ${surpriseChromeTop(isAdmin)}
    <div style="max-width:760px;margin:10px auto 0;">
      <a href="/surprise" class="muted" style="color:#8a8f98;text-decoration:none;font-size:13px;">← back</a>
      <h2 style="font-size:26px;margin:10px 0 6px;">What kind of ${escapeHtml(label)}?</h2>
      <p class="muted" style="margin:0 0 6px;">${escapeHtml(String(total))} ${escapeHtml(
        surfKindNoun(kind, total)
      )} to surf through.</p>
      ${selectionLine}
      <a href="${escapeHtml(playHref({}))}" style="${SURPRISE_CARD_CSS}min-height:120px;margin:0 0 22px;border-color:#4f9dff;">
        <span style="font-size:38px;line-height:1;">🎲</span>
        <span>Start surfing</span>
        <span class="muted" style="font-size:13px;font-weight:500;">${escapeHtml(
          filterLabel ? `${filterLabel} — surprise me` : 'Surprise me with anything'
        )}</span>
      </a>
      <h3 style="font-size:15px;margin:0 0 10px;color:#8a8f98;text-transform:uppercase;letter-spacing:.05em;">Category</h3>
      ${noChips}
      <div style="display:flex;flex-wrap:wrap;gap:10px;margin:0 0 24px;">${genreChips}</div>
      <h3 style="font-size:15px;margin:0 0 10px;color:#8a8f98;text-transform:uppercase;letter-spacing:.05em;">Year</h3>
      ${noYears}
      <div style="display:flex;flex-wrap:wrap;gap:10px;">${decadeChips}</div>
      ${yearRow}
      ${unknownNote}
    </div>
    ${HEARTBEAT_SCRIPT}
  `)
}

// Nothing matched the chosen category — a dead end has to look like a choice,
// not a broken page.
function surpriseEmptyPage({ isAdmin, kind, genreName, filterLabel = '', backHref = '' }) {
  // genreName is still accepted for callers that only know the genre; a full
  // filterLabel ("Comedy · 1990s") wins when the caller has one.
  const named = filterLabel || genreName || ''
  return page(`
    ${surpriseChromeTop(isAdmin)}
    <div style="max-width:620px;margin:10px auto 0;text-align:center;">
      <div style="font-size:52px;">🍿</div>
      <h2 style="margin:12px 0 8px;">Nothing to surf here yet</h2>
      <p class="muted" style="margin:0 0 22px;">
        There's nothing in your library${named ? ` under <b>${escapeHtml(named)}</b>` : ''} to play right now.
        Try another category or year — <b>🎲 Any category</b> + <b>📅 Any year</b> always has something.
      </p>
      <a class="btn" href="${escapeHtml(backHref || `/surprise?kind=${encodeURIComponent(kind)}`)}">← Pick another category</a>
    </div>
    ${HEARTBEAT_SCRIPT}
  `)
}

// --- 🆕 New: the combined recently-added list --------------------------------
// One list of everything added to EITHER library in the last 7 days, newest
// first — the site's half of "can we have the new tab show both tv shows and
// movies". Both the Movies page (/?view=new) and the TV Shows page
// (/tvshows?view=new, ?tab=new) render it from this same pair of helpers with
// the same inputs, so the two tabs can never show different sets — or
// different counts — again.
//
// Artwork here is STRICTLY cache-only: the two lookups below read the on-disk
// offline manifests (and whatever this process already looked up while
// rendering other views) and never issue a TMDB request, so adding a whole
// second library to each page costs no network calls. A title with nothing
// cached simply renders posterless, exactly as it would in its own section.
function tmdbLookupCached(fileName, cacheDir) {
  let raw = null
  if (cacheDir) {
    const manifest = tmdbFileCache.getManifest(cacheDir)
    if (fileName in manifest) raw = manifest[fileName]
    else raw = tmdbCache.has(fileName) ? tmdbCache.get(fileName) : null
  } else raw = tmdbCache.has(fileName) ? tmdbCache.get(fileName) : null
  return metadataMerge.mergeMovie(raw, { cacheDir, fileName })
}

function tmdbLookupTvCached(showKey, cacheDir) {
  return metadataMerge.mergeShow(readTvMetaCached(cacheDir ? tmdbFileCache.getTvManifest(cacheDir) : {}, showKey), { cacheDir, showKey })
}

// Movies + individual TV episodes added in the last 7 days, newest first.
// Same recentlyAdded map the NEW poster badge already uses on both pages, so
// an item is "new" here exactly when its card is badged NEW in its own section.
function collectNewItems(store, moviesDirs, tvDirs) {
  const recentlyAdded = getRecentlyAddedMap(store)
  const items = []
  for (const m of scanMoviesMulti(moviesDirs)) {
    const filePath = path.join(m.dir, m.fileName)
    const addedAt = recentlyAdded.get(path.resolve(filePath))
    if (addedAt === undefined) continue
    items.push({ kind: 'movie', addedAt, filePath, movie: m })
  }
  for (const f of scanTvShowsMulti(tvDirs)) {
    const filePath = path.join(f.dir, f.relPath)
    const addedAt = recentlyAdded.get(path.resolve(filePath))
    if (addedAt === undefined) continue
    const { show: showName, year } = groupKeyAndName(f.relPath, f.fileName)
    const parsed = parseEpisode(f.fileName)
    items.push({
      kind: 'tv',
      addedAt,
      filePath,
      episode: f,
      showKey: encodeId(showName.toLowerCase()),
      showName,
      showYear: year,
      season: parsed.season,
      episodeNumber: parsed.episode,
      episodeTitle: parsed.episodeTitle
    })
  }
  // Newest first; ties fall back to a stable name order so the two pages emit
  // byte-identical HTML for the same library state.
  items.sort((a, b) => b.addedAt - a.addedAt || a.filePath.localeCompare(b.filePath))
  return items
}

// "S02E07", or just the half that could be parsed out of the filename.
function episodeTag(season, episodeNumber) {
  const s = season === null || season === undefined ? '' : `S${String(season).padStart(2, '0')}`
  const e = episodeNumber === null || episodeNumber === undefined ? '' : `E${String(episodeNumber).padStart(2, '0')}`
  return `${s}${e}`
}

// Top-left chip marking which library a card came from, styled like the
// quality badge on the opposite corner so a mixed grid still reads at a glance.
function kindBadgeHtml(kind) {
  const label = kind === 'tv' ? '📺 TV' : '🎬 Movie'
  return `<div style="position:absolute;top:4px;left:4px;z-index:1;background:rgba(0,0,0,0.75);border:1px solid rgba(255,255,255,0.25);color:#eee;font-size:10px;font-weight:800;letter-spacing:0.5px;padding:2px 5px;border-radius:4px;">${label}</div>`
}

const NEW_BANNER_HTML =
  '<div style="position:absolute;bottom:0;left:0;right:0;background:#4caf50;color:#08210c;font-size:11px;font-weight:800;letter-spacing:0.5px;text-align:center;padding:3px 0;">NEW</div>'

// --- One library layout for Movies ('/') and TV Shows ('/tvshows') ---
// Both pages are built from the helpers below, so the tab row, the toolbar
// (genre chips, search, A-Z bar), the letter sections, the By Release Date
// and By Actor views and the poster cards have one shape. Only the data is
// page-specific: a film card says its year, a show card how many episodes you
// have; films link to the player, shows to their episode list.

// One poster card. Also used by the 🆕 New grid (no ℹ️ overlay, extra kind
// badge). `href` and `posterSrc` are already URL-safe; everything else is
// escaped here.
function posterCardHtml({ href, dataName, anchorId, title, posterSrc, sub, meta, genreNames, qualityTier, isNew, extraButtons = '', extraBadges = '', overlay = null }) {
  const safeTitle = escapeHtml(title || '')
  const poster = posterSrc
    ? `<img src="${posterSrc}" alt="${safeTitle}" loading="lazy" decoding="async">`
    : '<div class="noposter">No poster</div>'
  return `<a class="card"${anchorId ? ` id="${anchorId}"` : ''} style="position:relative;" data-name="${escapeHtml(String(dataName || '').toLowerCase())}" href="${href}">
    ${overlay ? infoButtonHtml(meta) : ''}${extraButtons}
    <div style="position:relative;">${poster}${qualityBadgeHtml(qualityTier, isNew)}${extraBadges}${isNew ? NEW_BANNER_HTML : ''}</div>
    <div class="meta"><div class="title">${safeTitle}</div><div class="sub">${escapeHtml(sub || '')}</div>${certGenreChipsHtml(meta, genreNames)}</div>
    ${overlay ? infoOverlayHtml(title, meta, genreNames, overlay.cast, overlay.castOpts) : ''}
  </a>`
}

// What the search box matches: the shown title and the file/folder name, so a
// title finds its card even when the file on disk is named differently.
function searchNameFor(title, fileName) {
  const a = String(title || '')
  const b = String(fileName || '')
  return !b || a.toLowerCase() === b.toLowerCase() ? a : `${a} | ${b}`
}

function letterOfTitle(title) {
  const ch = String(title || '').charAt(0).toUpperCase()
  return /[A-Z]/.test(ch) ? ch : '#'
}

// `tabs`: [{ key, label, href }]. Both pages list All, By Release Date, By
// Actor and 🆕 New first, in that order, then their own extra tabs.
function libraryTabsHtml(active, tabs) {
  return `<div class="tabs beebo-library-tabs">${tabs
    .map((t) => `<a href="${t.href}" class="tab ${active === t.key ? 'tab-active' : ''}">${t.label}</a>`)
    .join('')}</div>`
}

function librarySearchHtml(placeholder) {
  return `<input id="q" placeholder="${escapeHtml(placeholder)}">`
}

// The All view: genre chips, search, sticky A-Z bar, one section per letter.
// `items` is the whole library (already sorted by title), `list` what the
// genre filter leaves of it.
function libraryBrowseHtml({ items, list, chipsUi, searchPlaceholder, emptyText, emptyGenreText, titleOf, cardFor }) {
  const search = librarySearchHtml(searchPlaceholder)
  if (!items.length) return `${search}<p class="empty">${emptyText}</p>`
  if (!list.length) return `${chipsUi}${search}<p class="empty">${emptyGenreText}</p>`
  const groups = new Map()
  for (const it of list) {
    const letter = letterOfTitle(titleOf(it))
    if (!groups.has(letter)) groups.set(letter, [])
    groups.get(letter).push(it)
  }
  const sections = Array.from(groups.entries())
    .map(
      ([letter, group]) =>
        `<div id="letter-${letter}" style="scroll-margin-top:84px;"><h3 style="margin:20px 0 10px;">${letter}</h3><div class="grid">${group
          .map((it) => cardFor(it))
          .join('')}</div></div>`
    )
    .join('')
  return `${chipsUi}${search}
    ${alphabetBarTop(new Set(groups.keys()))}
    ${sections}`
}

// By Release Date: newest year first, unknown years last, with the side A-Z
// rail jumping to the first title of each letter.
function libraryYearViewHtml({ items, dateOf, titleOf, cardFor, emptyText }) {
  if (!items.length) return `<p class="empty">${emptyText}</p>`
  const sorted = items.slice().sort((a, b) => {
    const diff = (dateOf(b) || '').localeCompare(dateOf(a) || '')
    return diff !== 0 ? diff : titleOf(a).localeCompare(titleOf(b), undefined, { sensitivity: 'base' })
  })
  const groups = new Map()
  for (const it of sorted) {
    const year = (dateOf(it) || '').slice(0, 4) || 'Unknown year'
    if (!groups.has(year)) groups.set(year, [])
    groups.get(year).push(it)
  }
  const seenLetters = new Set()
  const availableLetters = new Set(sorted.map((it) => letterOfTitle(titleOf(it))))
  const sections = Array.from(groups.entries())
    .map(([year, group]) => {
      const cards = group
        .map((it) => {
          const letter = letterOfTitle(titleOf(it))
          let anchorId
          if (!seenLetters.has(letter)) {
            seenLetters.add(letter)
            anchorId = `letter-${letter}`
          }
          return cardFor(it, anchorId)
        })
        .join('')
      return `<h3 style="margin:24px 0 10px;">${escapeHtml(year)}</h3><div class="grid">${cards}</div>`
    })
    .join('')
  return `<div style="display:flex;gap:8px;">
    <div style="flex:1;min-width:0;">${sections}</div>
    ${alphabetRailSide(availableLetters)}
  </div>`
}

// By Actor: the actor index, or one actor's titles. `withCast` is
// [{ item, cast }]; `actorHref` is the view's URL without an actor.
function libraryActorViewHtml({ actorHref, actorParam, withCast, cardFor, cacheDir, images, noneForActorText, noCastText }) {
  if (actorParam) {
    const filtered = withCast.filter((e) => e.cast.some((c) => c && c.name === actorParam)).map((e) => e.item)
    return `
      <a href="${actorHref}" class="muted" style="color:#4f9dff;">← All actors</a>
      <h3 style="margin:14px 0 10px;">${escapeHtml(actorParam)}</h3>
      <div class="grid">${filtered.map((it) => cardFor(it)).join('') || `<p class="empty">${noneForActorText}</p>`}</div>
    `
  }
  const actorMap = new Map()
  withCast.forEach((e) =>
    e.cast.forEach((c) => {
      if (c && c.name && !actorMap.has(c.name)) actorMap.set(c.name, c)
    })
  )
  const actors = Array.from(actorMap.values()).sort((a, b) => a.name.localeCompare(b.name))
  if (!actors.length) return `<p class="empty">${noCastText}</p>`
  const actorCards = actors
    .map((c) => {
      const photoSrc = actorPhotoUrl(cacheDir, c.id, c.profilePath, images)
      const photo = photoSrc
        ? `<img src="${photoSrc}" alt="${escapeHtml(c.name)}" style="width:64px;height:64px;border-radius:50%;object-fit:cover;margin:0 auto 10px;display:block;">`
        : `<div style="width:64px;height:64px;border-radius:50%;background:#2a2f3a;color:#8a8f98;display:flex;align-items:center;justify-content:center;margin:0 auto 10px;font-size:20px;">${escapeHtml(c.name.charAt(0))}</div>`
      return `<a href="${actorHref}&actor=${encodeURIComponent(c.name)}" class="card actor-card" data-name="${escapeHtml(c.name.toLowerCase())}">${photo}${escapeHtml(c.name)}</a>`
    })
    .join('')
  return `${librarySearchHtml('Search actors…')}<div class="grid">${actorCards}</div>`
}

// The New grid. Movie cards link to the player like they do in All Movies;
// episode cards link to their show's page like they do in All Shows.
function newItemsGridHtml(items, { cacheDir, qualityCache }) {
  if (!items.length) return '<p class="empty">Nothing added in the last 7 days.</p>'
  const cards = items
    .map((it) => {
      const tier = qualityTierFor(qualityCache, it.filePath, it.kind === 'tv' ? it.episode : null)
      if (it.kind === 'movie') {
        const t = tmdbLookupCached(it.movie.fileName, cacheDir)
        return posterCardHtml({
          href: `/watch?id=${encodeURIComponent(it.movie.id)}`,
          dataName: searchNameFor(t?.title || it.movie.name, it.movie.name),
          title: t?.title || it.movie.name,
          posterSrc: t ? posterUrl(cacheDir, t.id, t.poster_path) : null,
          sub: t?.release_date?.slice(0, 4) || '',
          meta: t,
          genreNames: GENRE_NAMES_MOVIE,
          qualityTier: tier,
          isNew: true,
          extraBadges: kindBadgeHtml('movie')
        })
      }
      const meta = tmdbLookupTvCached(it.showKey, cacheDir)
      return posterCardHtml({
        href: `/tvshows?show=${encodeURIComponent(it.showKey)}`,
        dataName: searchNameFor(meta?.name || it.showName, it.showName),
        title: meta?.name || it.showName,
        posterSrc: meta ? tvPosterUrl(cacheDir, meta.id, meta.poster_path) : null,
        sub: [episodeTag(it.season, it.episodeNumber), it.episodeTitle].filter(Boolean).join(' · ') || it.episode.fileName,
        meta,
        genreNames: GENRE_NAMES_TV,
        qualityTier: tier,
        isNew: true,
        extraBadges: kindBadgeHtml('tv')
      })
    })
    .join('')
  return `<div class="grid">${cards}</div>`
}

function navTabs(active, newCount) {
  return libraryTabsHtml(active, [
    { key: 'all', label: 'All Movies', href: '/' },
    { key: 'year', label: 'By Release Date', href: '/?view=year' },
    { key: 'actor', label: 'By Actor', href: '/?view=actor' },
    { key: 'new', label: `🆕 New${newCount ? ` (${newCount})` : ''}`, href: '/?view=new' },
    { key: 'sequels', label: '🎞️ Sequels', href: '/?view=sequels' }
  ])
}

function tvNavTabs(active, newCount) {
  return libraryTabsHtml(active, [
    { key: 'all', label: 'All Shows', href: '/tvshows' },
    { key: 'year', label: 'By Release Date', href: '/tvshows?view=year' },
    { key: 'actor', label: 'By Actor', href: '/tvshows?view=actor' },
    { key: 'new', label: `🆕 New${newCount ? ` (${newCount})` : ''}`, href: '/tvshows?view=new' },
    { key: 'missing', label: '🧩 Missing Episodes', href: '/tvshows?tab=missing' },
    { key: 'related', label: '🔗 Related Shows', href: '/tvshows?tab=related' }
  ])
}

function page(body, { narrow } = {}) {
  const navMatch = body.match(/<aside class="beebo-sidebar"[\s\S]*?<\/aside>/)
  const navigation = navMatch ? navMatch[0] : ''
  if (navigation) body = body.replace(navigation, '')
  const active = navigation.match(/data-section="([a-z]+)"/)?.[1]
  const heading = browserChrome.labels[active]
  if (heading) body = body.replace(/(<h2[^>]*>)Beebo Entertainment(<\/h2>)/, '$1' + heading + '$2')
  const themeInfo = theme.requestRenderInfo() // the signed-in person's theme, resolved here so the page never paints in the wrong one
  return `<!doctype html><html lang="en" data-theme="${themeInfo.id}"${themeInfo.attrs || ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="${themeInfo.themeColor}">
  ${pwa.headMarkup(themeInfo)}
  <title>Beebo Entertainment</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { background:#0f1115; color:#eee; font-family:-apple-system,Segoe UI,Roboto,sans-serif; margin:0; padding:20px; }
    h2 { margin:0 0 16px; }
    .wrap { max-width: ${narrow ? '380px' : '100%'}; margin: ${narrow ? '40px auto' : '0'}; }
    input, textarea {
      width:100%; padding:12px 14px; font-size:16px; border-radius:8px; border:1px solid #2a2f3a;
      background:#171a21; color:#eee; margin-bottom:12px; font-family:inherit;
    }
    button, .btn {
      display:inline-block; background:#4f9dff; color:#fff; border:none; text-decoration:none;
      padding:12px 18px; border-radius:8px; font-size:15px; font-weight:600; cursor:pointer;
    }
    .btn-secondary { background:#2a2f3a; }
    .grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap:14px; }
    .card { background:#171a21; border-radius:10px; overflow:hidden; text-decoration:none; color:inherit; display:block; }
    .card img { width:100%; aspect-ratio:2/3; object-fit:cover; display:block; background:#22262f; }
    .noposter { aspect-ratio:2/3; display:flex; align-items:center; justify-content:center; color:#555; font-size:12px; text-align:center; padding:8px; }
    .meta { padding:8px 10px; }
    .title { font-size:13px; font-weight:600; line-height:1.3; }
    .sub { font-size:11px; color:#8a8f98; margin-top:2px; }
    .empty { color:#8a8f98; text-align:center; margin-top:60px; }
    .muted { color:#8a8f98; font-size:13px; }
    .error { background:#3a1f22; border:1px solid #6b2b30; color:#ff9d9d; padding:10px 14px; border-radius:8px; margin-bottom:14px; font-size:14px; }
    .success { background:#1f3a2a; border:1px solid #2b6b45; color:#9dffb8; padding:10px 14px; border-radius:8px; margin-bottom:14px; font-size:14px; }
    .topbar { display:flex; justify-content:space-between; align-items:center; margin-bottom:18px; }
    .tabs { display:flex; gap:18px; margin-bottom:20px; border-bottom:1px solid #2a2f3a; }
    .tab { padding:0 0 10px; color:#8a8f98; text-decoration:none; font-size:14px; font-weight:600; border-bottom:2px solid transparent; }
    .tab-active { color:#fff; border-bottom-color:#4f9dff; }
    .beebo-library-tabs { flex-wrap:wrap; row-gap:10px; }
    .actor-card { padding:16px 10px; text-align:center; font-size:13px; font-weight:600; }
    .icon-btn { position:absolute; top:4px; z-index:2; font-size:11px; line-height:1; padding:3px 5px; border-radius:4px;
      background:rgba(0,0,0,0.55); border:1px solid rgba(255,255,255,0.25); color:#eee; cursor:pointer; opacity:0.9; }
    .info-overlay { position:absolute; inset:0; background:rgba(0,0,0,0.88); color:#eee; font-size:12px; line-height:1.4;
      padding:10px; overflow-y:auto; z-index:3; cursor:pointer; }
    .info-overlay[hidden] { display:none; }
    /* ℹ️ overlay cast strip — small circular photos that scroll sideways */
    .cast-sec { margin-top:10px; border-top:1px solid rgba(255,255,255,0.14); padding-top:8px; }
    .cast-head { font-size:10px; letter-spacing:0.6px; text-transform:uppercase; color:#8a8f98; margin-bottom:6px; }
    .cast-strip { display:flex; gap:8px; overflow-x:auto; padding-bottom:4px; -webkit-overflow-scrolling:touch; }
    .cast-item { flex:0 0 auto; width:56px; text-align:center; display:block; }
    .cast-link { cursor:pointer; }
    .cast-photo { width:42px; height:42px; border-radius:50%; object-fit:cover; display:block; margin:0 auto 4px;
      background:#2a2f3a; }
    .cast-nophoto { display:flex; align-items:center; justify-content:center; color:#8a8f98; font-size:16px; }
    .cast-name { display:block; font-size:10px; font-weight:600; line-height:1.25; color:#eee; }
    .cast-char { display:block; font-size:9px; line-height:1.25; color:#8a8f98; margin-top:1px; }
  ${browserChrome.styles}${themeInfo.css ? '\n' + themeInfo.css : ''}
  </style>
  </head><body class="${narrow ? 'beebo-auth' : navigation ? 'beebo-shell' : ''}">
  <a class="beebo-skip" href="#beebo-content">Skip to content</a>
  ${navigation}${navigation ? browserChrome.mobileHeader(active) : ''}
  <main class="beebo-main" id="beebo-content" tabindex="-1">${narrow ? browserChrome.brand() : ''}${body}</main>
  <script>
    const q = document.getElementById('q')
    if (q) {
      q.setAttribute('aria-label', q.placeholder || 'Search your library')
      q.addEventListener('input', () => {
        const term = q.value.toLowerCase()
        const cards = [...document.querySelectorAll('.card[data-name]')]
        let shown = 0
        cards.forEach(card => {
          const match = card.dataset.name.toLowerCase().includes(term.trim())
          card.style.display = match ? '' : 'none'
          if (match) shown++
        })
        let status = document.getElementById('beebo-search-status')
        if (!status) {
          status = document.createElement('p')
          status.id = 'beebo-search-status'; status.className = 'beebo-search-status'
          status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite')
          q.insertAdjacentElement('afterend', status)
        }
        status.hidden = !term.trim()
        status.textContent = shown ? shown + ' matching ' + (shown === 1 ? 'title' : 'titles') : 'No matching titles. Try another search.'
      })
    }
    // ℹ️ info overlays + 🔗 sequel jumps on poster cards — one delegated
    // listener instead of per-card JS. preventDefault/stopPropagation so taps
    // on the icons or the open overlay never follow the surrounding card link.
    document.addEventListener('click', (e) => {
      if (!e.target || !e.target.closest) return
      const infoBtn = e.target.closest('.info-btn')
      if (infoBtn) {
        e.preventDefault()
        e.stopPropagation()
        const card = infoBtn.closest('.card')
        const overlay = card && card.querySelector('.info-overlay')
        if (overlay) overlay.hidden = !overlay.hidden
        return
      }
      // Checked before the overlay-closes-on-click rule below, so tapping a
      // person inside the overlay navigates instead of just shutting it.
      const castLink = e.target.closest('.cast-link')
      if (castLink && castLink.dataset.href) {
        e.preventDefault()
        e.stopPropagation()
        location.href = castLink.dataset.href
        return
      }
      const overlay = e.target.closest('.info-overlay')
      if (overlay) {
        e.preventDefault()
        e.stopPropagation()
        overlay.hidden = true
        return
      }
      const seq = e.target.closest('.seq-btn')
      if (seq && seq.dataset.href) {
        e.preventDefault()
        e.stopPropagation()
        location.href = seq.dataset.href
      }
    })
    // Pressing a letter key jumps straight to that A-Z section (ignored while typing).
    document.addEventListener('keydown', (e) => {
      const tag = e.target && e.target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key.length !== 1 || !/[a-zA-Z]/.test(e.key)) return
      const el = document.getElementById('letter-' + e.key.toUpperCase())
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  </script>
  ${playlistWeb.LIBRARY_SCRIPT}
  <script>${browserChrome.script}</script>
  ${pwa.bodyMarkup()}
  </body></html>`
}

// Bodies are read into memory, so every reader has a hard cap. Without one, a single unauthenticated
// POST of a few gigabytes to /login or /api/login could exhaust the server's memory (security review
// 2026-09-21, L-1). Past the cap the request is cut off (the socket is closed) and the caller sees an
// error it already handles (an empty body).
const SMALL_BODY_LIMIT = 1024 * 1024
const API_BODY_LIMIT = 8 * 1024 * 1024
async function* cappedBody(req, limit = SMALL_BODY_LIMIT) {
  const declared = Number(req && req.headers && req.headers['content-length'])
  if (Number.isFinite(declared) && declared > limit) {
    try { req.destroy() } catch { /* already gone */ }
    const err = new Error('request body too large')
    err.code = 'body_too_large'
    throw err
  }
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limit) {
      try { req.destroy() } catch { /* already gone */ }
      const err = new Error('request body too large')
      err.code = 'body_too_large'
      throw err
    }
    yield chunk
  }
}

async function readBody(req) {
  const chunks = []
  try {
    for await (const chunk of cappedBody(req)) chunks.push(chunk)
  } catch {
    return {}
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  return Object.fromEntries(new URLSearchParams(raw))
}

// Small-JSON body reader for the resumable upload control endpoints (begin /
// finish / cancel). Falls back to form encoding so the same handlers still
// work from a plain form post or curl. Capped hard because these bodies are
// only ever a filename and a number — the actual video bytes go to
// /upload/chunk, which is streamed to disk and never buffered.
async function readJsonBody(req, limit = 64 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limit) break
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return Object.fromEntries(new URLSearchParams(raw))
  }
}

function formatBytesShort(n) {
  if (!n) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(1)} ${units[i]}`
}

function uploadPage({ history: uploadHistory = [], isAdmin } = {}) {
  if (!isAdmin) {
    return page(`<div class="wrap"><h2>🎬 Beebo Entertainment</h2><p class="error">This page is only available to admin accounts.</p></div>`)
  }
  const historyRows = uploadHistory.length
    ? uploadHistory
        .map(
          (e) => `<div class="card" style="padding:12px 14px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;gap:10px;">
            <div style="min-width:0;">
              <div style="font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(e.fileName)}</div>
              <div class="sub">${e.kind === 'tv' ? `📺 ${escapeHtml(e.showName || 'TV Show')}` : '🎬 Movie'} · by ${escapeHtml(e.uploadedBy)} · ${new Date(e.uploadedAt).toLocaleString()}</div>
            </div>
            <button type="button" data-upload-delete="${escapeHtml(e.id)}" style="background:#3a1f22;color:#ff9d9d;padding:8px 12px;font-size:12px;">🗑 Delete</button>
          </div>`
        )
        .join('')
    : `<p class="empty" style="margin-top:0;">No uploads yet.</p>`

  return page(`
    <div class="topbar">
      <h2 style="margin:0;">Beebo Entertainment</h2>
      <a href="/logout" class="muted" style="color:#8a8f98;">Log out</a>
    </div>
    ${sectionNav('upload', true)}
    <p class="muted" style="margin-top:0;">
      Drag and drop video files below — they're automatically sorted into Movies or TV Shows (matched by
      filename), and get their poster/title the next time the library refreshes. Admins only.
    </p>
    <div id="dropzone" style="border:2px dashed #2a2f3a;border-radius:12px;padding:40px 20px;text-align:center;margin-bottom:20px;cursor:pointer;">
      <div style="font-size:32px;margin-bottom:8px;">⬆️</div>
      <div style="font-weight:600;margin-bottom:4px;">Drop video files here, or click to choose</div>
      <div class="muted">Large files can take a while — they upload one at a time, resume where they left off, and retry themselves. Keep this tab open until it finishes.</div>
      <input id="fileInput" type="file" multiple accept="video/*" style="display:none;">
    </div>
    <div id="uploadStatus"></div>
    <h3 style="font-size:15px;margin:28px 0 10px;">Upload history</h3>
    <div id="historyList">${historyRows}</div>
    <script>
      // Delete is a JSON POST with a custom header, never a plain form: the server refuses a
      // cookie-authenticated delete that is not (security review F6).
      document.addEventListener('click', function (ev) {
        var b = ev.target && ev.target.closest ? ev.target.closest('[data-upload-delete]') : null
        if (!b || !confirm('Delete this uploaded file?')) return
        fetch('/upload/delete', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Beebo-CSRF': '1' }, body: JSON.stringify({ id: b.getAttribute('data-upload-delete') }) })
          .then(function () { location.href = '/upload' }, function () { location.href = '/upload' })
      })
    </script>
    <script>
      // Uploads are chunked and resumable. One file at a time (three 1GB
      // episodes in parallel just split the uplink three ways and made every
      // one of them slower), 8MB at a time, with the server remembering how
      // many bytes it already has so an interrupted upload continues instead
      // of throwing away everything already sent.
      const CHUNK_SIZE = 8 * 1024 * 1024
      const MAX_CHUNK_RETRIES = 5
      const BTN_RED = 'background:#3a1f22;color:#ff9d9d;padding:8px 12px;font-size:12px;'
      const BTN_BLUE = 'background:#1e2a3a;color:#8fc4ff;padding:8px 12px;font-size:12px;'

      const dropzone = document.getElementById('dropzone')
      const fileInput = document.getElementById('fileInput')
      const statusEl = document.getElementById('uploadStatus')

      dropzone.addEventListener('click', () => fileInput.click())
      ;['dragenter', 'dragover'].forEach(evt =>
        dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.style.borderColor = '#4f9dff' })
      )
      ;['dragleave', 'drop'].forEach(evt =>
        dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.style.borderColor = '#2a2f3a' })
      )
      dropzone.addEventListener('drop', (e) => uploadFiles(e.dataTransfer.files))
      fileInput.addEventListener('change', () => { uploadFiles(fileInput.files); fileInput.value = '' })

      const queue = []
      let running = false
      let sawSuccess = false

      // Closing the tab mid-upload no longer loses the transfer (the partial
      // survives on the server), but it does stall it, so still ask.
      window.addEventListener('beforeunload', (e) => {
        if (!running) return
        e.preventDefault()
        e.returnValue = ''
        return ''
      })

      const sleep = (ms) => new Promise(r => setTimeout(r, ms))

      function uploadFiles(fileList) {
        const files = Array.from(fileList || [])
        if (!files.length) return
        const frag = document.createDocumentFragment()
        const items = files.map(f => makeItem(f, frag))
        statusEl.prepend(frag)
        items.forEach(it => queue.push(it))
        pump()
      }

      function makeItem(file, frag) {
        const row = document.createElement('div')
        row.className = 'card'
        row.style = 'padding:12px 14px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;gap:10px;'
        row.innerHTML =
          '<div style="min-width:0;flex:1;">' +
            '<div class="name" style="font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></div>' +
            '<div class="sub">Queued…</div>' +
          '</div>' +
          '<div class="acts" style="display:flex;gap:6px;flex-shrink:0;"></div>'
        // textContent, never innerHTML — a filename is untrusted text.
        row.querySelector('.name').textContent = file.name
        frag.appendChild(row)
        const item = { file, row, sub: row.querySelector('.sub'), acts: row.querySelector('.acts'), xhr: null, cancelled: false, uploadId: null }
        setActions(item, ['cancel'])
        return item
      }

      function button(label, style, onClick) {
        const b = document.createElement('button')
        b.type = 'button'
        b.textContent = label
        b.style.cssText = style
        b.addEventListener('click', onClick)
        return b
      }

      function setActions(item, kinds) {
        item.acts.innerHTML = ''
        if (kinds.indexOf('cancel') !== -1) {
          item.acts.appendChild(button('✕ Cancel', BTN_RED, () => cancelItem(item)))
        }
        if (kinds.indexOf('retry') !== -1) {
          item.acts.appendChild(button('↻ Retry', BTN_BLUE, () => retryItem(item)))
        }
      }

      function setSub(item, text) { item.sub.textContent = text }
      function mark(item, color) { item.row.style.borderLeft = color ? '3px solid ' + color : '' }
      function pct(done, total) { return total > 0 ? Math.round((done / total) * 100) : 0 }

      function failItem(item, message) {
        setSub(item, 'Failed: ' + message)
        mark(item, '#d9534f')
        setActions(item, ['retry'])
      }

      function cancelItem(item) {
        item.cancelled = true
        const idx = queue.indexOf(item)
        if (idx !== -1) queue.splice(idx, 1)
        if (item.xhr) { try { item.xhr.abort() } catch (e) {} }
        if (item.uploadId) {
          fetch('/upload/cancel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uploadId: item.uploadId })
          }).catch(() => {})
        }
        setSub(item, 'Cancelled')
        mark(item, '#8a8f98')
        setActions(item, ['retry'])
      }

      // Resumes from wherever it stopped — /upload/begin hands back the byte
      // count already on disk, so this never restarts from zero.
      function retryItem(item) {
        if (queue.indexOf(item) !== -1) return
        item.cancelled = false
        mark(item, '')
        setSub(item, 'Queued…')
        setActions(item, ['cancel'])
        queue.push(item)
        pump()
      }

      function postJson(path, body) {
        return fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        }).then(r => r.json())
      }

      function getStatus(uploadId) {
        return fetch('/upload/status?uploadId=' + encodeURIComponent(uploadId)).then(r => r.json())
      }

      function sendChunk(item, uploadId, offset, blob, onProgress) {
        return new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest()
          item.xhr = xhr
          xhr.open('POST', '/upload/chunk?uploadId=' + encodeURIComponent(uploadId) + '&offset=' + offset)
          xhr.setRequestHeader('Content-Type', 'application/octet-stream')
          xhr.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable) onProgress(e.loaded)
          })
          xhr.addEventListener('load', () => {
            item.xhr = null
            try { resolve(JSON.parse(xhr.responseText)) }
            catch (e) { reject(new Error('unexpected server response')) }
          })
          xhr.addEventListener('error', () => { item.xhr = null; reject(new Error('network error')) })
          xhr.addEventListener('abort', () => { item.xhr = null; reject(new Error('aborted')) })
          xhr.send(blob)
        })
      }

      function fatal(error) {
        return error === 'admin_only' || error === 'upload_not_configured' ||
               error === 'not_a_video_file' || error === 'no_upload' || error === 'bad_upload_id'
      }

      async function runItem(item) {
        const file = item.file
        setSub(item, 'Uploading… 0%')
        setActions(item, ['cancel'])
        mark(item, '')

        let begun
        try {
          begun = await postJson('/upload/begin', { name: file.name, size: file.size })
        } catch (e) {
          failItem(item, 'network error')
          return false
        }
        if (!begun || !begun.ok) {
          failItem(item, (begun && begun.error) || 'unknown error')
          return false
        }
        const uploadId = begun.uploadId
        item.uploadId = uploadId
        let offset = Math.min(Number(begun.received) || 0, file.size)
        if (offset > 0 && offset < file.size) {
          setSub(item, 'Resuming from ' + pct(offset, file.size) + '%…')
        }

        let attempt = 0
        while (offset < file.size) {
          if (item.cancelled) return false
          const end = Math.min(offset + CHUNK_SIZE, file.size)
          const base = offset
          let res = null
          let err = null
          try {
            res = await sendChunk(item, uploadId, offset, file.slice(offset, end), (sent) => {
              setSub(item, 'Uploading… ' + pct(base + sent, file.size) + '%')
            })
          } catch (e) {
            err = e
          }
          if (item.cancelled) return false

          if (res && res.ok) {
            offset = Number(res.received)
            attempt = 0
            setSub(item, 'Uploading… ' + pct(offset, file.size) + '%')
            continue
          }
          if (res && res.error && fatal(res.error)) {
            failItem(item, res.error)
            return false
          }
          // Recoverable: the server has a different number of bytes than we
          // thought (a chunk that landed but whose reply we never saw).
          // Re-sync to its count and carry on from there.
          if (res && res.error === 'offset_mismatch') {
            attempt++
            if (attempt > MAX_CHUNK_RETRIES) { failItem(item, 'could not sync with the server'); return false }
            offset = Math.min(Number(res.received) || 0, file.size)
            setSub(item, 'Resuming from ' + pct(offset, file.size) + '%…')
            continue
          }

          attempt++
          const reason = err ? err.message : ((res && res.error) || 'unknown error')
          if (attempt > MAX_CHUNK_RETRIES) {
            failItem(item, reason)
            return false
          }
          const wait = 1000 * Math.pow(2, attempt - 1) // 1s, 2s, 4s, 8s, 16s
          setSub(item, 'Retrying in ' + (wait / 1000) + 's… (' + attempt + ' of ' + MAX_CHUNK_RETRIES + ')')
          await sleep(wait)
          if (item.cancelled) return false
          try {
            const st = await getStatus(uploadId)
            if (st && st.ok) offset = Math.min(Number(st.received) || 0, file.size)
          } catch (e) { /* keep the offset we had; the next attempt re-syncs */ }
        }

        setSub(item, 'Finishing…')
        let done
        try {
          done = await postJson('/upload/finish', { uploadId: uploadId, name: file.name })
        } catch (e) {
          failItem(item, 'network error')
          return false
        }
        if (done && done.ok) {
          setSub(item, (done.kind === 'tv' ? '📺 ' + (done.showName || 'TV Show') : '🎬 Movie') + ' — saved ✓')
          mark(item, '#4caf50')
          item.acts.innerHTML = ''
          return true
        }
        failItem(item, (done && done.error) || 'unknown error')
        return false
      }

      // One at a time. The page is NEVER reloaded mid-queue — that would kill
      // every upload still waiting behind this one.
      async function pump() {
        if (running) return
        running = true
        while (queue.length) {
          const item = queue.shift()
          if (item.cancelled) continue
          let ok = false
          try { ok = await runItem(item) }
          catch (e) { failItem(item, 'unexpected error') }
          if (ok) sawSuccess = true
        }
        running = false
        if (sawSuccess) { sawSuccess = false; refreshHistory() }
      }

      // Whole queue is done — refresh the history list in place rather than
      // reloading the page.
      function refreshHistory() {
        fetch('/upload')
          .then(r => r.text())
          .then(html => {
            const fresh = new DOMParser().parseFromString(html, 'text/html').getElementById('historyList')
            const cur = document.getElementById('historyList')
            if (fresh && cur) cur.innerHTML = fresh.innerHTML
          })
          .catch(() => {})
      }
    </script>
  `)
}

// Install instructions for the Android app — linked from the login page and
// the top nav so anyone on a phone can find it without being told how.
// Download-page helpers: show each app's version (from a sibling version.json)
// and when its file was last updated (from the file's mtime on disk), so the
// Get-the-Apps page always reflects exactly what's being served right now. Read
// per request, so dropping a newer APK in updates the page with no restart.
// Owner-alert email recipients: the configured admin address (or the SMTP
// sender account) PLUS any fixed extra inboxes, deduped. Edit ALWAYS_NOTIFY to
// add or change the always-on recipients. Only owner alerts use this — never
// the user-facing verification / reset / access-code emails.
function adminNotifyTo(store) {
  const ALWAYS_NOTIFY = [] // extra fixed inboxes: none in the public source
  const base = store.get('adminNotifyEmail') || store.get('emailUser')
  const all = [base, ...ALWAYS_NOTIFY]
    .filter(Boolean)
    .map((x) => String(x).trim().toLowerCase())
    .filter(Boolean)
  return [...new Set(all)].join(', ')
}

function appDownloadMeta(subdir, fileName) {
  const dir = path.join(__dirname, '..', subdir)
  let version = null
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'version.json'), 'utf8'))
    if (meta && meta.versionName) version = String(meta.versionName)
  } catch {}
  let updated = null
  try {
    const st = fs.statSync(path.join(dir, fileName))
    updated = st.mtime.toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  } catch {}
  return { version, updated }
}

function appMetaLine(subdir, fileName) {
  const { version, updated } = appDownloadMeta(subdir, fileName)
  const bits = []
  if (version) bits.push('Version ' + version)
  if (updated) bits.push('Updated ' + updated)
  if (!bits.length) return ''
  return '<p class="muted" style="margin:0 0 12px;font-size:13px;letter-spacing:.02em;">'
    + bits.join(' &middot; ') + '</p>'
}

function getAppPage() {
  return page(
    `<div class="wrap">
      <h2>Get the Beebo apps</h2>
      <p class="muted" style="line-height:1.6;">
        The website works everywhere, but these open straight to your library in
        their own window and remember who you are.
      </p>

      <div style="margin-top:22px;padding:16px;border:1px solid #2a2f3a;border-radius:10px;background:#171a21;">
        <h3 style="margin:0 0 6px;">📱 Android phones and tablets</h3>
        ${appMetaLine('android-app', 'BeeboEntertainment.apk')}
        <p class="muted" style="margin:0 0 14px;line-height:1.55;">
          Plays formats phones normally refuse (MKV, HEVC, AC-3), has a proper Cast
          button for the TV, and downloads movies and episodes to watch with no internet.
        </p>
        <p style="margin:0 0 14px;">
          <a class="btn" href="/download/android-app" style="font-size:15px;padding:11px 16px;">⬇️ Download for Android</a>
        </p>
        <ol class="muted" style="line-height:1.7;padding-left:20px;margin:0;">
          <li>Tap the button above, then open the downloaded file.</li>
          <li>Android will say installs from this source are blocked — tap <b>Settings</b>,
              turn on <b>Allow from this source</b>, then go back and tap the file again.</li>
          <li>It warns that the developer is unknown (only because it did not come from the
              Play Store) — tap <b>Install anyway</b>.</li>
          <li>Open <b>the app</b>, allow notifications so downloads show progress, and sign in.</li>
        </ol>
      </div>

      <div style="margin-top:16px;padding:16px;border:1px solid #2a2f3a;border-radius:10px;background:#171a21;">
        <h3 style="margin:0 0 6px;">🚗 Android Auto (in the car)</h3>
        ${appMetaLine('auto-app', 'JenkinsAPP-Auto.apk')}
        <p class="muted" style="margin:0 0 14px;line-height:1.55;">
          A second, smaller app that puts the library in your car's own media screen —
          Continue Watching, Movies, TV Shows and search, browsable from the head unit.
          Install it as well as the app above, not instead of it. Android Auto never shows
          video from a media app, so this plays sound only.
        </p>
        <p style="margin:0 0 14px;">
          <a class="btn" href="/download/auto-app" style="font-size:15px;padding:11px 16px;">⬇️ Download Beebo Auto</a>
        </p>
        <ol class="muted" style="line-height:1.7;padding-left:20px;margin:0;">
          <li>Install it the same way as the app above.</li>
          <li>Open <b>Beebo Auto</b>, enter this server's address, and sign in with the
              same name and code.</li>
          <li>Android Auto hides apps it did not get from the Play Store until you say
              otherwise: phone <b>Settings › Apps › Android Auto › Additional settings in
              the app</b>, scroll to <b>About</b>, tap the version line <b>ten times</b>, tap OK.</li>
          <li>Then open the <b>⋮</b> menu › <b>Developer settings</b> › turn on
              <b>Unknown sources</b>. Force-stop Android Auto and reconnect to the car.</li>
        </ol>
      </div>


      <div style="margin-top:16px;padding:16px;border:1px solid #2a2f3a;border-radius:10px;background:#171a21;">
        <h3 style="margin:0 0 6px;">🖥️ Windows PCs and laptops</h3>
        <p class="muted" style="margin:0 0 14px;line-height:1.55;">
          Opens the library in its own window instead of a browser tab, and stays signed in.
          It asks you to log in the first time — what you can see and do depends on your account.
        </p>
        <p style="margin:0;font-size:13px;" class="muted">
          The Windows app is coming soon. In the meantime the website works great
          in any browser on a PC or laptop — just sign in and your library opens right up.
        </p>
      </div>

      ${pwa.getAppCardHtml()}
      <p style="margin-top:16px;"><a href="/" style="color:#4f9dff;">← Back to the library</a></p>
    </div>`,
    { narrow: true }
  )
}

function loginPage({ error, success, allowSignup = true } = {}) {
  return page(
    `<div class="wrap">
      <h2>🎬 Beebo Entertainment</h2>
      ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
      ${success ? `<div class="success">${escapeHtml(success)}</div>` : ''}
      <form method="POST" action="/login">
        <input name="username" placeholder="Username" autocomplete="username" autocapitalize="none" autocorrect="off" required>
        <input name="password" type="password" placeholder="Password (or access code)" autocomplete="current-password" required>
        <button type="submit">Log in</button>
      </form>
      <p class="muted" style="margin-top:18px;">
        ${allowSignup ? `New here? <a href="/signup" style="color:#4f9dff;">Create an account</a><br>
        Have an invite code instead? <a href="/request-access" style="color:#4f9dff;">Request access</a><br>
        ` : ''}Forgot your password? <a href="/forgot-password" style="color:#4f9dff;">Reset it</a><br>
        Still on an access code? <a href="/forgot-code" style="color:#4f9dff;">Get a new one</a>
      </p>
      <p class="muted" style="margin-top:18px;padding-top:14px;border-top:1px solid #2a2f3a;">
        📱 <a href="/get-app" style="color:#4f9dff;font-weight:600;">Get the Beebo apps</a> for Android, Windows, iPhone and iPad —
        they open straight to your library and remember your login.
      </p>

    </div>`,
    { narrow: true }
  )
}

function signupPage({ error, values } = {}) {
  return page(
    `<div class="wrap">
      <h2>Create your account</h2>
      ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
      <form method="POST" action="/signup">
        <input name="username" placeholder="Username" value="${escapeHtml(values?.username || '')}"
          autocomplete="username" autocapitalize="none" autocorrect="off" required maxlength="20">
        <input name="email" type="email" placeholder="Your email" value="${escapeHtml(values?.email || '')}" autocomplete="email" required maxlength="200">
        <input name="password" type="password" placeholder="Password (min 8 characters)" autocomplete="new-password" required minlength="8" maxlength="256">
        ${accountSecurityWeb.strengthMeter({ usernameName: 'username' })}
        <button type="submit">Sign up</button>
      </form>
      <p class="muted" style="margin-top:18px;"><a href="/login" style="color:#4f9dff;">Back to login</a></p>
    </div>`,
    { narrow: true }
  )
}

function signupSentPage({ email } = {}) {
  return page(
    `<div class="wrap">
      <h2>Check your email</h2>
      <div class="success">We sent a verification link to ${escapeHtml(email || 'your inbox')}. Click it to activate your
      account, then come back and log in.</div>
      <a class="btn btn-secondary" href="/login">Back to login</a>
    </div>`,
    { narrow: true }
  )
}

function verifyResultPage({ ok, reason } = {}) {
  if (ok) {
    return page(
      `<div class="wrap">
        <h2>Account verified 🎉</h2>
        <div class="success">Your account is active — you can log in now.</div>
        <a class="btn" href="/login">Log in</a>
      </div>`,
      { narrow: true }
    )
  }
  const msg =
    reason === 'expired'
      ? 'That verification link has expired. Sign up again to get a new one.'
      : 'That verification link is invalid or has already been used.'
  return page(
    `<div class="wrap">
      <h2>Verification failed</h2>
      <div class="error">${escapeHtml(msg)}</div>
      <a class="btn btn-secondary" href="/signup">Back to sign up</a>
    </div>`,
    { narrow: true }
  )
}

function requestAccessPage({ error, submitted, closed } = {}) {
  if (closed) {
    return page(
      `<div class="wrap">
        <h2>Requests are closed</h2>
        <div class="muted">New account requests aren't being accepted right now. Please check back later.</div>
        <p class="muted" style="margin-top:18px;"><a href="/login" style="color:#4f9dff;">Back to login</a></p>
      </div>`,
      { narrow: true }
    )
  }
  if (submitted) {
    return page(
      `<div class="wrap">
        <h2>Request sent</h2>
        <div class="success">Thanks! Your request is waiting for approval. You'll get an email with your code once it's approved.</div>
        <a class="btn btn-secondary" href="/login">Back to login</a>
      </div>`,
      { narrow: true }
    )
  }
  return page(
    `<div class="wrap">
      <h2>Request access</h2>
      ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
      <form method="POST" action="/request-access">
        <input name="name" placeholder="Your name" required maxlength="80">
        <input name="email" type="email" placeholder="Your email" required maxlength="200">
        <textarea name="message" placeholder="Optional message" rows="3" maxlength="300"></textarea>
        <button type="submit">Send request</button>
      </form>
      <p class="muted" style="margin-top:18px;"><a href="/login" style="color:#4f9dff;">Back to login</a></p>
    </div>`,
    { narrow: true }
  )
}

function forgotCodePage({ submitted } = {}) {
  if (submitted) {
    return page(
      `<div class="wrap">
        <h2>Check your email</h2>
        <div class="success">If that email has access, a new code is on its way — your old code stops working once the new one is sent.</div>
        <a class="btn btn-secondary" href="/login">Back to login</a>
      </div>`,
      { narrow: true }
    )
  }
  return page(
    `<div class="wrap">
      <h2>Forgot your code?</h2>
      <p class="muted">Enter the email you signed up with and we'll email you a fresh code.</p>
      <form method="POST" action="/forgot-code">
        <input name="email" type="email" placeholder="Your email" required maxlength="200">
        <button type="submit">Send me a code</button>
      </form>
      <p class="muted" style="margin-top:18px;"><a href="/login" style="color:#4f9dff;">Back to login</a></p>
    </div>`,
    { narrow: true }
  )
}

function forgotPasswordPage({ submitted, mailConfigured = true } = {}) {
  // A home server often has no email set up. Then no link can be sent, and saying "check your email"
  // would leave the person waiting for nothing: point at the owner's one-time reset code instead.
  const ownerCode = `<p class="muted">Ask the person who runs this server for a one-time reset code, then <a href="/reset-with-code" style="color:#4f9dff;">use it here</a>.</p>`
  if (submitted) {
    return page(
      `<div class="wrap">
        <h2>${mailConfigured ? 'Check your email' : 'Ask the owner'}</h2>
        ${mailConfigured
          ? '<div class="success">If that email has an account, a password reset link is on its way. It expires in 1 hour.</div>'
          : '<div class="success">This server cannot send email, so no link was sent.</div>'}
        ${ownerCode}
        <a class="btn btn-secondary" href="/login">Back to login</a>
      </div>`,
      { narrow: true }
    )
  }
  return page(
    `<div class="wrap">
      <h2>Forgot your password?</h2>
      ${mailConfigured
        ? `<p class="muted">Enter the email on your account and we'll email you a link to set a new password.</p>
      <form method="POST" action="/forgot-password">
        <input name="email" type="email" placeholder="Your email" required maxlength="200">
        <button type="submit">Send reset link</button>
      </form>
      <p class="muted" style="margin-top:14px;">No email? Ask the person who runs this server for a one-time reset code, then <a href="/reset-with-code" style="color:#4f9dff;">use it here</a>.</p>`
        : `<p class="muted">This server does not send email, so it cannot mail you a link.</p>${ownerCode}`}
      <p class="muted" style="margin-top:18px;"><a href="/login" style="color:#4f9dff;">Back to login</a></p>
    </div>`,
    { narrow: true }
  )
}

function resetPasswordPage({ token, error } = {}) {
  return page(
    `<div class="wrap">
      <h2>Set a new password</h2>
      ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
      <form method="POST" action="/reset-password">
        <input type="hidden" name="token" value="${escapeHtml(token || '')}">
        <input name="password" type="password" placeholder="New password (min 8 characters)" autocomplete="new-password" required minlength="8" maxlength="256">
        ${accountSecurityWeb.strengthMeter()}
        <button type="submit">Set password</button>
      </form>
      <p class="muted" style="margin-top:18px;"><a href="/login" style="color:#4f9dff;">Back to login</a></p>
    </div>`,
    { narrow: true }
  )
}

function resetPasswordDonePage({ ok, error } = {}) {
  if (ok) {
    return page(
      `<div class="wrap">
        <h2>Password updated 🎉</h2>
        <div class="success">You can log in with your new password now.</div>
        <a class="btn" href="/login">Log in</a>
      </div>`,
      { narrow: true }
    )
  }
  return page(
    `<div class="wrap">
      <h2>Couldn't reset password</h2>
      <div class="error">${escapeHtml(error || 'That reset link is invalid or has expired.')}</div>
      <a class="btn btn-secondary" href="/forgot-password">Request a new link</a>
    </div>`,
    { narrow: true }
  )
}

const HEARTBEAT_SCRIPT = `<script>
  function moviheartbeat() { fetch('/heartbeat', { method: 'POST', keepalive: true }).catch(() => {}) }
  setInterval(moviheartbeat, 20000)
  // With no internet a poster that is not saved on this PC cannot load from TMDB: show a plain film-poster
  // shape instead of a broken-image icon (electron/cloudFetch.js, docs/OFFLINE-FIRST.md).
  document.addEventListener('error', function (e) {
    var t = e.target
    if (!t || t.tagName !== 'IMG' || t.getAttribute('data-offline-fallback') || !/^https:\\/\\/image\\.tmdb\\.org\\//.test(t.src)) return
    t.setAttribute('data-offline-fallback', '1')
    t.removeAttribute('srcset')
    t.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 300"><rect width="200" height="300" fill="#1c212b"/><rect x="70" y="120" width="60" height="60" rx="8" fill="none" stroke="#4a5363" stroke-width="6"/><path d="M92 138l22 12-22 12z" fill="#4a5363"/></svg>')
  }, true)
</script>`

function formatBytes(bytes) {
  if (!bytes) return '0 MB'
  const mb = bytes / (1024 * 1024)
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  return `${mb.toFixed(0)} MB`
}

// Records a "bad quality" report (from the player page's ⚠️ button) in the
// electron-store 'qualityFlags' list the desktop Flags tab reads. Deduped by
// filePath: a second person flagging the same file just joins its flaggedBy
// list (itself deduped by userId — the same person flagging twice is a no-op).
// Kept as a standalone function (and exported) so the dedupe logic is testable
// without spinning up the whole server.
function recordQualityFlag(store, { kind, filePath, fileName, relPath, title, userId, userName }) {
  if (!filePath || !userId) return { ok: false }
  const flags = store.get('qualityFlags') || []
  const now = Date.now()
  const existing = flags.find((f) => f.filePath === filePath)
  if (existing) {
    if ((existing.flaggedBy || []).some((u) => u.userId === userId)) return { ok: true, deduped: true }
    const updated = flags.map((f) =>
      f.filePath === filePath ? { ...f, flaggedBy: [...(f.flaggedBy || []), { userId, userName, at: now }] } : f
    )
    store.set('qualityFlags', updated)
    return { ok: true }
  }
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: kind === 'tv' ? 'tv' : 'movie',
    filePath,
    ...(kind === 'tv' ? { relPath } : { fileName }),
    title,
    flaggedBy: [{ userId, userName, at: now }],
    firstFlaggedAt: now,
    resolved: false
  }
  store.set('qualityFlags', [...flags, entry])
  return { ok: true }
}

// --- "the next thing doesn't exist yet" requests --------------------------
// Written when the player's Up Next card finds a next episode/sequel that TMDB
// knows about but the library doesn't have. Deliberately mirrors
// recordQualityFlag above (same store shape, same dedupe-then-append-requester
// behaviour, same never-throws contract) so the desktop app's Requests tab can
// read it exactly like the Flags tab reads qualityFlags.
//
// Persisted under 'missingRequests' as:
//   { id, kind:'tv'|'movie', title, showName, season, episode, collectionName,
//     tmdbId, year, requestedBy:[{userId,userName,at}], firstSeenAt, resolved }
//
// Dedupe key: TV -> kind+showName+season+episode; movie -> kind+(tmdbId||title).
// A second person asking for the same thing appends to `requestedBy` (itself
// deduped by userId) instead of adding a second row.
//
// "Request a title" (source:'request') writes these same rows, with three
// additions: a whole-show TV row (season and episode both null, keyed on the
// show's TMDB id when there is one, so two shows sharing a name stay apart),
// an optional per-requester `note` inside requestedBy, and a TMDB `poster`.
// Later, `addedAt` (the library now has it) or `dismissedAt` (the owner said
// no) may be set alongside `resolved`.
function missingRequestKey(entry) {
  if (!entry) return ''
  if (entry.kind === 'tv') {
    if (entry.season == null && entry.episode == null && entry.tmdbId != null && entry.tmdbId !== '') return ['tv', `#${entry.tmdbId}`].join('|')
    return ['tv', String(entry.showName || '').trim().toLowerCase(), String(entry.season ?? ''), String(entry.episode ?? '')].join('|')
  }
  const ident = entry.tmdbId != null && entry.tmdbId !== '' ? `#${entry.tmdbId}` : String(entry.title || '').trim().toLowerCase()
  return ['movie', ident].join('|')
}

function recordMissingRequest(store, { kind, title, showName, season, episode, collectionName, tmdbId, year, userId, userName, source, note, poster } = {}) {
  if (!store || !userId) return { ok: false }
  const isTitleRequest = source === 'request'
  const cleanNote = isTitleRequest ? titleRequests.cleanNote(note) : null
  const intOrNull = (v) => {
    const n = Number(v)
    return Number.isFinite(n) ? Math.trunc(n) : null
  }
  const isTv = kind === 'tv'
  const candidate = {
    kind: isTv ? 'tv' : 'movie',
    title: String(title || '').trim().slice(0, 200),
    showName: isTv ? String(showName || '').trim().slice(0, 200) || null : null,
    season: isTv ? intOrNull(season) : null,
    episode: isTv ? intOrNull(episode) : null,
    collectionName: isTv ? null : String(collectionName || '').trim().slice(0, 200) || null,
    tmdbId: intOrNull(tmdbId),
    year: intOrNull(year)
  }
  // Nothing identifiable to record: a TV row needs a show + episode number, a
  // movie row needs a tmdb id or a title. Silently ignored rather than stored
  // as an unactionable blank request. A title request may ask for a whole show.
  if (isTv && isTitleRequest && candidate.episode === null) candidate.season = null
  if (isTv ? !candidate.showName || (candidate.episode === null && !isTitleRequest) : !candidate.tmdbId && !candidate.title) {
    return { ok: false }
  }
  if (isTitleRequest) {
    candidate.source = 'request'
    const posterStr = String(poster || '')
    if (/^https:\/\/image\.tmdb\.org\/t\/p\/w\d+\/[A-Za-z0-9._-]+$/.test(posterStr)) candidate.poster = posterStr
  }
  const requester = cleanNote ? { userId, userName, at: Date.now(), note: cleanNote } : null

  let existingList = []
  try {
    existingList = store.get('missingRequests') || []
  } catch {
    existingList = []
  }
  const requests = Array.isArray(existingList) ? existingList : []
  const now = Date.now()
  const key = missingRequestKey(candidate)
  const existing = requests.find((r) => r && typeof r === 'object' && missingRequestKey(r) === key)
  // The list lives in config.json (rewritten in full on every change): past 5000 rows it is a flood, not a wish list.
  if (!existing && requests.length >= 5000) return { ok: false, error: 'too_many_requests' }

  if (existing) {
    const mine = (existing.requestedBy || []).find((u) => u && u.userId === userId)
    if (mine) {
      // Asking again only ever updates your own note — never a second row,
      // never a second place in the list.
      if (cleanNote && mine.note !== cleanNote) {
        store.set('missingRequests', requests.map((r) =>
          r === existing ? { ...r, requestedBy: r.requestedBy.map((u) => (u === mine ? { ...u, note: cleanNote } : u)) } : r
        ))
      }
      return { ok: true, deduped: true, id: existing.id }
    }
    const updated = requests.map((r) => {
      if (r !== existing) return r
      const next = { ...r, requestedBy: [...(r.requestedBy || []), requester ? { ...requester, at: now } : { userId, userName, at: now }] }
      // Someone new asking for a title the owner turned down puts it back on the list.
      if (isTitleRequest && next.dismissedAt) {
        delete next.dismissedAt
        next.resolved = false
      }
      if (isTitleRequest && !next.poster && candidate.poster) next.poster = candidate.poster
      return next
    })
    store.set('missingRequests', updated)
    webhooks.emitRequestAdded(store, updated.find((r) => r && r.id === existing.id), { userId, userName, note: cleanNote })
    return { ok: true, appended: true, id: existing.id }
  }

  const entry = {
    id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
    ...candidate,
    requestedBy: [requester ? { ...requester, at: now } : { userId, userName, at: now }],
    firstSeenAt: now,
    resolved: false
  }
  store.set('missingRequests', [...requests, entry])
  webhooks.emitRequestAdded(store, entry, { userId, userName, note: cleanNote })
  return { ok: true, created: true, id: entry.id }
}

// --- Viewer-set playback markers ------------------------------------------
// "The credits start here" / "the intro ends here", set by whoever is watching
// and shared with the whole household — set it once on any episode and every
// episode of that show inherits it. Persisted under 'playbackMarkers' as:
//   { id, scope:'show'|'movie', key, introEndSeconds, creditsStartSeconds,
//     setBy:{userId,userName}, setAt, updatedAt }
// One row per (scope,key); setting a field overwrites it, null clears it.
//
// These numbers come from viewers, not from anything authoritative, so every
// read AND write runs them through the guards below. A fat-fingered marker must
// never strand someone at the end of a file or skip half an episode:
//   intro   — must be > 0, at most MARKER_MAX_INTRO_SECONDS (5 min), and when
//             the duration is known at most 25% of it.
//   credits — must be > 0, must leave at least MARKER_MIN_CREDITS_TAIL_SECONDS
//             (60s) of runtime after it, and must be at least 50% through.
//             (Both duration-relative rules are only applied when a duration is
//             actually known — the absolute ones always apply.)
// Anything failing a rule is ignored (treated as "not set"), never clamped into
// a different meaning; the only clamping is to the item's real length.
// The guards themselves (and the "viewer wins over auto-detected" rule) live in markerModel.js so
// the automatic detector (introDetectJob.js) runs the very same ones; auto-detected markers are a
// separate store key ('autoMarkers') and are only ever merged in at READ time (effectiveMarkersFor).
const {
  MARKER_MAX_INTRO_SECONDS,
  MARKER_MAX_INTRO_FRACTION,
  MARKER_MIN_CREDITS_TAIL_SECONDS,
  MARKER_MIN_CREDITS_FRACTION,
  markerNumber,
  markerDuration,
  sanitizeIntroEnd,
  sanitizeCreditsStart,
  sanitizeIntroStart,
  sanitizeIntroEndWithStart
} = markerModel

function getPlaybackMarkers(store) {
  let rows = []
  try {
    rows = store.get('playbackMarkers') || []
  } catch {
    rows = []
  }
  return Array.isArray(rows) ? rows.filter((r) => r && typeof r === 'object') : []
}

// The stored row for one (scope,key), with both numbers re-validated against
// `durationSeconds` on the way out. Always returns the full shape.
function playbackMarkerFor(store, scope, key, durationSeconds) {
  const wantScope = scope === 'show' ? 'show' : 'movie'
  const wantKey = String(key || '')
  const empty = { scope: wantScope, key: wantKey, introStartSeconds: null, introEndSeconds: null, creditsStartSeconds: null, autoSuppress: {} }
  if (!wantKey) return empty
  const row = getPlaybackMarkers(store).find((r) => r.scope === wantScope && String(r.key || '') === wantKey)
  if (!row) return empty
  const introStart = sanitizeIntroStart(row.introStartSeconds, durationSeconds)
  return {
    scope: wantScope,
    key: wantKey,
    introStartSeconds: introStart,
    introEndSeconds: sanitizeIntroEndWithStart(row.introEndSeconds, introStart, durationSeconds),
    creditsStartSeconds: sanitizeCreditsStart(row.creditsStartSeconds, durationSeconds),
    // A viewer who explicitly cleared a part keeps it cleared: auto-detection may not refill it.
    autoSuppress: { intro: !!(row.autoSuppress && row.autoSuppress.intro), credits: !!(row.autoSuppress && row.autoSuppress.credits) }
  }
}

// Mirrors recordQualityFlag / recordMissingRequest: never throws, one row per
// target, and the caller gets {ok, created|updated} back. `introEndSeconds` and
// `creditsStartSeconds` are tri-state — undefined leaves the stored value
// alone, null clears it, a number sets it (subject to the guards above).
function recordPlaybackMarker(store, { scope, key, introStartSeconds, introEndSeconds, creditsStartSeconds, durationSeconds, userId, userName } = {}) {
  if (!store || !userId) return { ok: false }
  const wantScope = scope === 'show' ? 'show' : 'movie'
  const wantKey = String(key || '')
  if (!wantKey) return { ok: false }

  const rows = getPlaybackMarkers(store)
  const existing = rows.find((r) => r.scope === wantScope && String(r.key || '') === wantKey) || null
  const now = Date.now()

  const nextIntroStart =
    introStartSeconds === undefined
      ? existing
        ? sanitizeIntroStart(existing.introStartSeconds, durationSeconds)
        : null
      : introStartSeconds === null
      ? null
      : sanitizeIntroStart(introStartSeconds, durationSeconds)
  const nextIntro =
    introEndSeconds === undefined
      ? existing
        ? sanitizeIntroEndWithStart(existing.introEndSeconds, nextIntroStart, durationSeconds)
        : null
      : introEndSeconds === null
      ? null
      : sanitizeIntroEndWithStart(introEndSeconds, nextIntroStart, durationSeconds)
  const nextCredits =
    creditsStartSeconds === undefined
      ? existing
        ? sanitizeCreditsStart(existing.creditsStartSeconds, durationSeconds)
        : null
      : creditsStartSeconds === null
      ? null
      : sanitizeCreditsStart(creditsStartSeconds, durationSeconds)

  // Explicitly clearing a part (null) is a decision, not an absence: it also stops the automatic
  // detector from filling that part back in. Setting a real value again lifts it.
  const suppress = { ...((existing && existing.autoSuppress) || {}) }
  if (introEndSeconds === null || introStartSeconds === null) suppress.intro = true
  if ((introEndSeconds != null && nextIntro !== null) || (introStartSeconds != null && nextIntroStart !== null)) delete suppress.intro
  if (creditsStartSeconds === null) suppress.credits = true
  if (creditsStartSeconds != null && nextCredits !== null) delete suppress.credits
  const nextSuppress = suppress.intro || suppress.credits ? suppress : null

  // A set request whose value failed every guard and that changes nothing is
  // dropped rather than written as an empty row.
  if (!existing && nextIntroStart === null && nextIntro === null && nextCredits === null && !nextSuppress) return { ok: true, ignored: true }

  const entry = existing
    ? { ...existing, introStartSeconds: nextIntroStart, introEndSeconds: nextIntro, creditsStartSeconds: nextCredits, updatedAt: now }
    : {
        id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
        scope: wantScope,
        key: wantKey,
        introStartSeconds: nextIntroStart,
        introEndSeconds: nextIntro,
        creditsStartSeconds: nextCredits,
        setBy: { userId, userName: userName || 'Unknown' },
        setAt: now,
        updatedAt: now
      }
  // Whoever last touched it owns it, so the Markers list shows who to ask.
  if (existing) entry.setBy = { userId, userName: userName || 'Unknown' }
  if (nextSuppress) entry.autoSuppress = nextSuppress
  else delete entry.autoSuppress

  store.set('playbackMarkers', existing ? rows.map((r) => (r === existing ? entry : r)) : [...rows, entry])
  return { ok: true, created: !existing, updated: !!existing, introStartSeconds: nextIntroStart, introEndSeconds: nextIntro, creditsStartSeconds: nextCredits }
}

// Sidecar subtitle files sitting next to a video (base.srt / base.en.vtt / base.eng.forced.srt …).
// Returns an ordered, de-duplicated list the /api/subtitles listing and the /subtitles/file server
// both derive the same way, so a track's index means the same thing to each.
function resolveSubtitleTracks(kind, id, tvDirs, movieDirs) {
  const out = []
  try {
    const decoded = decodeId(id)
    if (!decoded) return out
    let filePath = null
    if (kind === 'tv') { const m = scanTvShowsMulti(tvDirs).find((f) => f.relPath === decoded); if (m) filePath = path.join(m.dir, m.relPath) }
    else { const m = scanMoviesMulti(movieDirs).find((x) => x.fileName === decoded); if (m) filePath = path.join(m.dir, m.fileName) }
    if (!filePath || !fs.existsSync(filePath)) return out
    const dir = path.dirname(filePath)
    const base = path.basename(filePath, path.extname(filePath))
    const baseLc = base.toLowerCase()
    const LANG = { en:'English', eng:'English', es:'Spanish', spa:'Spanish', fr:'French', fra:'French', fre:'French', de:'German', deu:'German', ger:'German', it:'Italian', ita:'Italian', pt:'Portuguese', por:'Portuguese', ja:'Japanese', jpn:'Japanese', ko:'Korean', kor:'Korean', zh:'Chinese', chi:'Chinese', zho:'Chinese', ru:'Russian', rus:'Russian', nl:'Dutch', dut:'Dutch', pl:'Polish', pol:'Polish', ar:'Arabic', ara:'Arabic', hi:'Hindi', hin:'Hindi', sv:'Swedish', swe:'Swedish', da:'Danish', dan:'Danish', fi:'Finnish', fin:'Finnish', no:'Norwegian', nor:'Norwegian', tr:'Turkish', tur:'Turkish', el:'Greek', he:'Hebrew', th:'Thai', vi:'Vietnamese', id:'Indonesian', cs:'Czech', ro:'Romanian', hu:'Hungarian', uk:'Ukrainian' }
    let names = []
    try { names = fs.readdirSync(dir) } catch { return out }
    for (const name of names) {
      const ext = path.extname(name).toLowerCase()
      if (ext !== '.srt' && ext !== '.vtt') continue
      const stem = path.basename(name, ext)
      const stemLc = stem.toLowerCase()
      if (stemLc !== baseLc && !stemLc.startsWith(baseLc + '.')) continue
      let lang = '', label = 'Subtitles'
      if (stem.length > base.length + 1) {
        const parts = stem.slice(base.length + 1).split('.').filter(Boolean)
        const code = (parts[0] || '').toLowerCase()
        if (code) { lang = code; label = LANG[code] || code.toUpperCase() }
        const q = parts.slice(1).map((x) => x.toLowerCase())
        if (q.includes('forced')) label += ' (Forced)'
        if (q.includes('sdh') || q.includes('cc')) label += ' (SDH)'
        if (q.some(aiSubtitles.isAiQualifier)) label += aiSubtitles.AI_LABEL_SUFFIX // Speech Pack: "Name.en.ai.srt"
        // A second download of the same language is saved as <name>.en.2.srt (openSubtitles.js).
        const copy = q.find((x) => /^\d{1,2}$/.test(x))
        if (copy) label += ' #' + copy
      }
      out.push({ lang, label, absFile: path.join(dir, name), ext: ext.slice(1) })
    }
    out.sort((a, b) => (a.ext === 'vtt' ? 0 : 1) - (b.ext === 'vtt' ? 0 : 1))
    const seen = new Set(); const dedup = []
    for (const t of out) { const k = t.lang + '|' + t.label; if (seen.has(k)) continue; seen.add(k); dedup.push(t) }
    return dedup
  } catch { return out }
}

// UTF-8 text out of a subtitle file, stripping a BOM and reading UTF-16 when tagged.
function decodeSubtitleBuffer(buf) {
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return buf.slice(3).toString('utf8')
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return buf.slice(2).toString('utf16le')
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) return buf.slice(2).swap16().toString('utf16le')
  return buf.toString('utf8')
}

// SubRip -> WebVTT: normalise newlines and turn cue-time commas into dots.
function srtToVtt(srt) {
  const body = String(srt).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
  return 'WEBVTT\n\n' + body.trim() + '\n'
}


// Remote-access HOST PEER page. Loaded by a hidden window on this machine; it
// registers this Beebo with the beebo.tv signaling worker, answers an authorized
// remote viewer's WebRTC offer, and proxies whatever HTTP the viewer requests
// over the data channel to THIS local server. The worker authorizes both sides;
// this page only needs the account's name + the owner token (passed in the URL).
const RTC_HOST_HTML = `<!doctype html><meta charset="utf-8"><title>Beebo remote host</title>
<body style="font-family:system-ui,Segoe UI,Arial,sans-serif;background:#141017;color:#cbb89a;margin:0;padding:14px;font-size:13px">
<div id="s">Beebo remote host starting...</div>
<script>
(function(){
  var qs=new URLSearchParams(location.search);
  var NAME=qs.get('name')||''; var TOKEN=qs.get('token')||'';
  var SIG='https://'+NAME+'.beebo.tv'; var ORIGIN=location.origin;
  var s=document.getElementById('s');
  window.__beeboHost={registered:false,served:0,err:null,ice:null};
  var pcs={};
  function post(path,obj){ return fetch(SIG+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(obj)}).then(function(r){return r.json().catch(function(){return {}})}); }
  // Belt as well as braces on "no video through Cloudflare". The signalling
  // worker is meant to hand back STUN only, but this end refuses a relay even
  // if one ever turns up in that list: a turn:/turns: entry is an offer to
  // carry the film through somebody else's network, and this house does not
  // take it. Dropping them leaves STUN, which only helps the two ends find
  // each other.
  function noRelay(list){
    if(!list||!list.length) return list;
    var keep=[];
    for(var i=0;i<list.length;i++){
      var e=list[i], u=e&&e.urls; var arr=(typeof u==='string')?[u]:(u||[]);
      var clean=arr.filter(function(x){ return !/^turns?:/i.test(String(x)); });
      if(clean.length) keep.push({urls:clean.length===1?clean[0]:clean});
    }
    window.__beeboHost.relaysBlocked=(list.length-keep.length);
    return keep.length?keep:[{urls:'stun:relay1.beebo.tv:3478'}];
  }
  function reg(){ post('/rtc/register',{token:TOKEN}).then(function(j){ var ok=!!(j&&j.ok); window.__beeboHost.registered=ok; if(j&&j.iceServers)window.__beeboHost.ice=noRelay(j.iceServers); s.textContent=ok?('Online as '+NAME+'.beebo.tv - waiting for remote viewers.'):('Register failed: '+(j&&j.error||'?')); }).catch(function(e){ s.textContent='Register error: '+e; }); }
  function wire(dc){
    dc.binaryType='arraybuffer';
    var cancel={};
    function sendChunk(id,u8){
      var idb=new TextEncoder().encode(id);
      var frame=new Uint8Array(2+idb.length+u8.length);
      new DataView(frame.buffer).setUint16(0,idb.length);
      frame.set(idb,2); frame.set(u8,2+idb.length);
      dc.send(frame.buffer);
    }
    dc.onmessage=function(e){
      var req; try{req=JSON.parse(e.data)}catch(_){return}
      if(req.kind==='abort'){ cancel[req.id]=true; return; }
      if(req.kind!=='req')return;
      // Mark every request that arrives over the away-from-home tunnel, so the local
      // server can tell remote traffic from home/LAN traffic (home is always free;
      // only remote requires the owner's active plan when enforcement is on).
      var headers={'X-Beebo-Remote':'1'};
      if(req.range)headers.Range=req.range;
      if(req.ctype)headers['Content-Type']=req.ctype;
      if(req.cookie)headers['Cookie']=req.cookie;
      // Carry arbitrary headers. The browser viewer authenticates with a cookie,
      // but the phone app uses 'Authorization: Bearer <token>' - and this tunnel
      // used to forward nothing but Range, so every authenticated request from a
      // phone arrived anonymous. Hop-by-hop headers are dropped, and
      // X-Beebo-Remote is set by us and cannot be overridden by the caller: the
      // local server trusts it to tell remote traffic from LAN traffic.
      if(req.headers&&typeof req.headers==='object'){
        var BLOCK={'host':1,'connection':1,'content-length':1,'transfer-encoding':1,'upgrade':1,'x-beebo-remote':1};
        Object.keys(req.headers).forEach(function(k){
          if(!BLOCK[String(k).toLowerCase()]) headers[k]=req.headers[k];
        });
      }
      // Request bodies were being dropped entirely: the viewer base64-encodes the
      // body and sends it, and this end threw it away, so every POST arrived
      // empty. /api/login is a POST, which is why signing in over the tunnel
      // could never have worked.
      var body=null;
      if(req.body){
        try{
          var bin=atob(req.body), u8=new Uint8Array(bin.length);
          for(var bi=0;bi<bin.length;bi++) u8[bi]=bin.charCodeAt(bi);
          body=u8;
        }catch(_){ body=null; }
      }
      var init={method:req.method||'GET',headers:headers,redirect:'manual'};
      if(body&&req.method&&req.method!=='GET'&&req.method!=='HEAD') init.body=body;
      fetch(ORIGIN+req.path,init).then(function(r){
        if(cancel[req.id]){ delete cancel[req.id]; return; }
        dc.send(JSON.stringify({kind:'head',id:req.id,status:r.status,ctype:r.headers.get('content-type')||'application/octet-stream',clen:(r.headers.get('content-length')!=null?Number(r.headers.get('content-length')):null),crange:r.headers.get('content-range')||null,location:r.headers.get('location')||null,setcookie:r.headers.get('set-cookie')||null}));
        if(!r.body){ dc.send(JSON.stringify({kind:'end',id:req.id})); window.__beeboHost.served++; return; }
        var reader=r.body.getReader();
        function stop(){ try{reader.cancel()}catch(_){} delete cancel[req.id]; }
        (function pump(){
          if(cancel[req.id]){ stop(); return; }
          reader.read().then(function(res){
            if(cancel[req.id]){ stop(); return; }
            if(res.done){ dc.send(JSON.stringify({kind:'end',id:req.id})); window.__beeboHost.served++; return; }
            var u=res.value,off=0,CH=32*1024;
            (function send(){
              if(cancel[req.id]){ stop(); return; }
              while(off<u.length){
                if(dc.bufferedAmount>(1<<20)){ setTimeout(send,8); return; }
                var end=Math.min(off+CH,u.length);
                sendChunk(req.id,u.subarray(off,end)); off=end;
              }
              pump();
            })();
          }).catch(function(){ try{dc.send(JSON.stringify({kind:'err',id:req.id,status:502}))}catch(_){} });
        })();
      }).catch(function(){ try{dc.send(JSON.stringify({kind:'err',id:req.id,status:502}))}catch(_){} });
    };
  }
  function onOffer(viewerId,sdp){
    var pc=new RTCPeerConnection({iceServers:(window.__beeboHost.ice)||[{urls:'stun:relay1.beebo.tv:3478'}]}); pcs[viewerId]=pc;
    pc.onconnectionstatechange=function(){ var st=pc.connectionState; if(st==='closed'||st==='failed'||st==='disconnected'){ delete pcs[viewerId]; try{pc.close()}catch(_){} } };
    pc.onicecandidate=function(e){ if(e.candidate) post('/rtc/candidate',{to:'viewer',viewerId:viewerId,candidate:e.candidate}); };
    pc.ondatachannel=function(e){ wire(e.channel); };
    pc.setRemoteDescription({type:'offer',sdp:sdp}).then(function(){return pc.createAnswer()})
      .then(function(a){return pc.setLocalDescription(a).then(function(){return a})})
      .then(function(a){return post('/rtc/answer',{viewerId:viewerId,sdp:a.sdp})})
      .catch(function(e){ window.__beeboHost.err=String(e); });
  }
  // ---- How often to ask the signalling worker "anything for me?" ---------
  // This was a flat setInterval(poll,400) - two and a half requests a second,
  // for ever, awake or idle, watched or not. One house sitting doing nothing
  // spent ~29,500 Cloudflare Worker requests a day, 30% of the free daily
  // allowance, entirely on silence. Four customers idling would have crossed
  // it and started a bill for traffic nobody asked for.
  //
  // Nothing here carries video - the film goes straight between the two
  // computers over the data channel, and this is only the handshake. So the
  // rate can follow the situation: quick while somebody is arriving or
  // connected, slow while the house is empty. Worst case a viewer waits one
  // idle tick before their offer is noticed; from then on the exchange runs at
  // the old speed until they are through and gone.
  var HOT_MS=400, IDLE_MS=8000, STAY_HOT_MS=30000;
  var hotUntil=0, pollTimer=null, tickMs=0;
  // Exposed for the status panel, not used to set the rate - see retime().
  function connected(){
    for(var k in pcs){
      var st=pcs[k].connectionState||pcs[k].iceConnectionState;
      if(st!=='closed'&&st!=='failed'&&st!=='disconnected') return true;
    }
    return false;
  }
  function goHot(){ hotUntil=Date.now()+STAY_HOT_MS; }
  function retime(){
    // Deliberately NOT "while a viewer is connected". Once the handshake is
    // done the data channel carries everything and there is nothing left for
    // this poll to fetch, so holding the fast rate through a two-hour film
    // would cost ~13,500 requests for a film that needs about a dozen. Fast
    // for half a minute after the last message, slow again after that; a late
    // candidate arriving on the slow tick is still in time.
    var ms=(Date.now()<hotUntil)?HOT_MS:IDLE_MS;
    if(pollTimer&&tickMs===ms) return;
    if(pollTimer) clearInterval(pollTimer);
    tickMs=ms; pollTimer=setInterval(poll,ms);
    window.__beeboHost.pollMs=ms; window.__beeboHost.live=connected();
  }
  function poll(){
    fetch(SIG+'/rtc/poll?box=host').then(function(r){return r.json()}).then(function(d){
      var msgs=d.msgs||[];
      if(msgs.length) goHot();
      msgs.forEach(function(m){ if(m.type==='offer')onOffer(m.viewerId,m.sdp); else if(m.type==='candidate'&&pcs[m.viewerId])pcs[m.viewerId].addIceCandidate(m.candidate).catch(function(){}); });
      retime();
    }).catch(function(){ retime(); });
  }
  if(!NAME||!TOKEN){ s.textContent='Remote host idle (no account name/token).'; return; }
  reg(); setInterval(reg,60000); goHot(); poll(); retime();
})();
</script>`

function startStreamServer({
  port,
  // (viewer) => (item) => boolean | null, optional: who may see which title in a
  // playlist (parental controls). See playlistAllow().
  playlistItemFilter,
  // The Beebo Inbox controller (electron/inbox.js), optional. With it the admin
  // site gets an Inbox tab, and picking a title for an Inbox file on "Titles to
  // check" files it away.
  inbox,
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
  log,
  // HTTPS, both optional. getCertDir points at the folder certs.js writes
  // cert.pem/key.pem into; getCertDomain is the DuckDNS address, used only to
  // build a redirect when a client sends no Host header. Leave both out (as
  // every existing test does) and the server is plain HTTP, exactly as before.
  getCertDir,
  getCertDomain,
  // () => the owner's <name> for <name>.beebo.tv, or ''. Email links use it
  // (see emailLinkOrigin); optional.
  getPublicName,
  // () => the name the Worker registered for this house (what a viewer token names), or ''.
  // /api/viewer-session compares against it; falls back to getPublicName. Optional.
  getHouseName,
  // The secret main.js gave the host agent it spawns; with it the agent's
  // X-Beebo-Viewer-Ip header is believed for lockouts. Without it, never.
  agentSecret,
  // Optional overrides for the Quality & audio picker (playbackApi.js); tests pass a temp dir,
  // a fake OpenSubtitles address, etc. The app leaves it out.
  playback: playbackOverrides,
  // Optional overrides for Cinema Mode (cinemaMode.js): tests pass a fake TMDB source, clock, etc.
  cinema: cinemaOverrides,
  // Optional overrides for the automatic intro/credits scanner (introDetectJob.js): tests pass fakes
  // for ffmpeg/time. The app leaves it out.
  autoMarkers: autoMarkerOverrides,
  // Optional overrides for the Speech Pack subtitle queue (electron/addons/speechPack): tests pass a fake
  // add-on manager and fake ffmpeg/whisper spawns. The app leaves it out.
  speechPack: speechPackOverrides,
  // Optional overrides for Live TV (electron/liveTv/): tests pass a temp data folder and fakes. The app leaves it out.
  liveTv: liveTvOverrides,
  // ({ ip, ua, remote }) => void, called for every request, optional. The
  // Connection wizard's "Watch at home" test (electron/connectionTest.js) uses
  // it to see a phone on the same Wi-Fi reach this computer. Must be cheap.
  onLanRequest,
  // () => void, optional: a library share was created, changed or revoked here; main.js pushes
  // the share list to beebo.tv (libraryShares.syncShares).
  onSharesChanged,
  // Music, all optional. `music` is a musicLibrary instance the desktop app
  // shares with its Settings screen; without it one is made from the two
  // getters (the tests do that). With neither, /api/music answers "no folder".
  music,
  getAllMusicDirs,
  getMusicCacheDir,
  // Where sing-along recordings are kept (musicRecordings.js); defaults to beside the store file.
  musicRecordingsDir,
  // Podcasts and radio, both optional. Tests pass temp folders and fake fetchers; the app leaves them out.
  //   podcasts: { dir, fetcher, searchFetcher, runFfmpeg, autoStart, now }
  //   radio:    { dir, fetcher, browser, timing, now }
  podcasts: podcastOverrides,
  radio: radioOverrides,
  // Where the migration importer keeps its undo journals (migrationImport.js); defaults to beside the
  // store file. Tests pass a temp dir.
  migrationDir,
  // Audiobooks, all optional, same shape as Music: an audiobookLibrary instance shared with Settings, or
  // the two getters (tests). getAudiobooksLookupEnabled() is the owner's Open Library setting (default off).
  audiobooks,
  getAllAudiobookDirs,
  getAudiobookCacheDir,
  getAudiobooksLookupEnabled,
  // Test hook: replaces the network call of the optional Open Library lookup.
  audiobookFetch
}) {
  const privateVault = require('./privateVault').createPrivateVault({
    store, mailer, getOwnerEmail: () => { try { return license?.evaluate()?.payload?.email || '' } catch { return '' } }
  })
  // Email links (verify / reset): the configured public address, never Host.
  const linkOrigin = () => {
    let publicName = ''
    let certDomain = ''
    try { publicName = typeof getPublicName === 'function' ? getPublicName() || '' : '' } catch {}
    try { certDomain = typeof getCertDomain === 'function' ? getCertDomain() || '' : getCertDomain || '' } catch {}
    return emailLinkOrigin({ publicName, certDomain, tlsActive: !!tlsState.active, port: ACTIVE_PORT, lanIp: lanIPv4() })
  }
  // Which Host values this server answers to (electron/httpSecurity.js): its own names, LAN and
  // loopback addresses, and what the owner configured (settings 'publicBaseUrl' / 'allowedHosts',
  // env BEEBO_PUBLIC_URL / BEEBO_ALLOWED_HOSTS). Used for the https redirect, links handed out to
  // guests, and refusing cookie-session writes that arrive under a foreign name (DNS rebinding).
  const readStoreSetting = (k) => { try { return store.get(k) } catch { return undefined } }
  const hostPolicy = httpSecurity.createHostPolicy({
    getPublicName: () => (typeof getPublicName === 'function' ? getPublicName() : ''),
    getHouseName: () => (typeof getHouseName === 'function' ? getHouseName() : ''),
    getCertDomain: () => (typeof getCertDomain === 'function' ? getCertDomain() : getCertDomain),
    getPublicBaseUrl: () => readStoreSetting('publicBaseUrl'),
    getExtraHosts: () => readStoreSetting('allowedHosts')
  })
  const hostRejectionLogged = new Set()
  const cspReport = httpSecurity.createCspReportHandler({ log: (m) => { try { if (typeof log === 'function') log(m) } catch {} } })
  AGENT_SECRET = typeof agentSecret === 'string' && agentSecret.length >= 32 ? agentSecret : ''
  const localAccess = require('./localAccessPolicy').createLocalAccessPolicy({ agentSecret: AGENT_SECRET })
  // The port to bind. Anything outside 1-65535, or missing, keeps the default
  // so a bad setting can never leave the server unreachable. Ports under 1024
  // are allowed on Windows but usually collide with something, so they are
  // refused here rather than failing later with a cryptic EACCES.
  if (typeof log === 'function') {
    const rawLog = log
    log = (msg) => rawLog(redactSecrets(msg))
  }
  const wanted = Number(port)
  ACTIVE_PORT =(Number.isInteger(wanted) && wanted >= 1024 && wanted <= 65535) ? wanted : PORT
  if (ACTIVE_PORT !== PORT && log) log(`using custom port ${ACTIVE_PORT} (default is ${PORT})`)

  // Falls back to the single primary dir when the caller hasn't wired up the
  // multi-drive getters yet, same defensive style as getTvShowsDir being
  // optional above.
  const allMoviesDirs = () => (getAllMoviesDirs ? getAllMoviesDirs() : [getMoviesDir ? getMoviesDir() : null].filter(Boolean))
  const allTvShowsDirs = () => (getAllTvShowsDirs ? getAllTvShowsDirs() : [getTvShowsDir ? getTvShowsDir() : null].filter(Boolean))
  // The same walks as scanMoviesMulti / scanTvShowsMulti, run on a worker thread (catalog.js).
  // Used where a walk used to hold up every stream: video requests and the heavy admin work.
  const catalogWalker = catalog.sharedCatalogWalker({ log })
  // The cached walk every viewer page, list API and seek reads from. primeLibrary() makes sure it
  // is current (walking on the worker if not) before a route that reads the library runs.
  const library = catalog.sharedLibraryCatalog({ log })
  // --- Quality & audio picker (live conversion, audio/subtitle tracks, online subtitles) ---
  const playback = playbackApiModule.createPlaybackApi({
    store,
    log: (m) => { if (typeof log === 'function') log(m) },
    resolveFile: async (kind, id) => {
      let rel
      try { rel = decodeId(id) } catch { return null }
      if (!rel) return null
      if (kind === 'tv') {
        const m = await library.findTvFile(allTvShowsDirs(), rel)
        return m ? path.join(m.dir, m.relPath) : null
      }
      const m = await library.findMovie(allMoviesDirs(), rel)
      return m ? path.join(m.dir, m.fileName) : null
    },
    listSidecars: (kind, id) => resolveSubtitleTracks(kind, id, allTvShowsDirs(), allMoviesDirs()),
    sign: (id) => makeMediaToken(store, id),
    verify: (id, token) => verifyMediaToken(store, id, token),
    decodeId,
    ffmpegPath: convert.ffmpegPath,
    ffprobePath: convert.ffprobePath,
    mediaTokenHeader: MEDIA_TOKEN_HEADER,
    license,
    // The other files of the same film, for /playback/info's `versions` (movieVersions.js).
    versionsFor: async (kind, id) => {
      if (kind !== 'movie') return null
      let rel
      try { rel = decodeId(id) } catch { return null }
      await primeLibrary('movies')
      const g = groupMovieList(scanMoviesMulti(allMoviesDirs()), getTmdbCacheDir ? getTmdbCacheDir() : null).groupOfFile.get(rel)
      return g && g.versions.length > 1 ? { groupKey: g.key, versions: movieVersions.publicVersions(g) } : null
    },
    // Effective intro/credits markers ride along with the playback info (viewer-set first, then auto).
    markersFor: (kind, id, durationSeconds) => markersFor(kind, id, durationSeconds),
    ...(playbackOverrides || {})
  })

  // "Watched" and "where I left off" are one thing per film, not per file: history.js and
  // watchedState.js ask movieVersions.siblingsOf for the other versions of a file. The grouping is
  // memoised for a few seconds because they ask once per row.
  let siblingMemo = { at: 0, groupOf: null }
  const siblingResolver = (fileName) => {
    const now = Date.now()
    if (!siblingMemo.groupOf || now - siblingMemo.at > 5000) {
      const files = rawScanMoviesMulti(allMoviesDirs())
      siblingMemo = { at: now, groupOf: movieVersions.groupMovieFiles(files, { metaOf: cachedMovieMetaReader(getTmdbCacheDir ? getTmdbCacheDir() : null) }).groupOfFile }
    }
    const g = siblingMemo.groupOf.get(fileName)
    return g && g.files.length > 1 ? g.files.map((f) => f.fileName) : [fileName]
  }
  movieVersions.setSiblingResolver(siblingResolver)

  // --- Whole-library subtitle sweep ("Search online", for every title) ------
  // Every movie + episode file, in exactly the shape /playback/info's kind+id
  // already takes - the same scanMoviesMulti/scanTvShowsMulti walk and the same
  // encodeId() the playlist catalog and titleLibraryIndex() above already use,
  // so this never becomes a second way of walking the library.
  function subtitleSweepCandidates() {
    const items = []
    for (const m of scanMoviesMulti(allMoviesDirs())) items.push({ kind: 'movie', id: encodeId(m.fileName), label: m.fileName })
    for (const f of scanTvShowsMulti(allTvShowsDirs())) items.push({ kind: 'tv', id: encodeId(f.relPath), label: f.relPath })
    return items
  }
  // A synthetic viewer id: playback.info/onlineSearch only use it to look up a per-person
  // quality/subtitle-language preference (harmless miss for an id nobody has) and to sign a
  // media token nothing here ever hands out - never an auth check, so this is safe with no
  // real signed-in user behind it.
  const SWEEP_VIEWER = 'system:subtitle-sweep'
  const subtitleSweepRunner = subtitleSweep.createSweepRunner({
    listCandidates: subtitleSweepCandidates,
    getInfo: (kind, id) => playback.info(kind, id, SWEEP_VIEWER, ''),
    search: (kind, id, language) => playback.onlineSearch(kind, id, language, SWEEP_VIEWER, ''),
    download: (body) => playback.onlineDownload(body),
    configured: () => playback.subtitleClient.configured(),
    testQuota: () => playback.subtitleClient.test(),
    sameLanguage: tracksLib.sameLanguage,
    log
  })
  const subtitleSweepSetting = (k, d) => { try { const v = store.get(k); return v === undefined || v === null || v === '' ? d : v } catch { return d } }
  function runSubtitleSweep(opts = {}) {
    return subtitleSweepRunner.run({
      language: opts.language || subtitleSweepSetting('subtitleSweepLanguage', 'en'),
      batchSize: opts.batchSize != null ? opts.batchSize : subtitleSweepSetting('subtitleSweepBatchSize', subtitleSweep.DEFAULT_BATCH_SIZE),
      minRemaining: opts.minRemaining != null ? opts.minRemaining : subtitleSweepSetting('subtitleSweepMinRemaining', subtitleSweep.DEFAULT_MIN_REMAINING)
    })
  }
  // Automatic run: same "kicked off a while after start, then daily" shape as main.js's
  // certificate check and this file's own 10-minute title-request arrival sweep just above -
  // no new scheduling pattern. subtitleSweepEnabled (default on) lets the owner turn the
  // automatic run off from Settings while keeping the manual "Sweep now" button working; run()
  // itself is always a no-op (no network at all) when no OpenSubtitles key is saved.
  const subtitleSweepFirstRun = setTimeout(() => {
    if (subtitleSweepSetting('subtitleSweepEnabled', true) !== false) backgroundGate.runWhenClear(() => runSubtitleSweep()).catch(() => {})
  }, 2 * 60 * 1000)
  if (subtitleSweepFirstRun.unref) subtitleSweepFirstRun.unref()
  const subtitleSweepDaily = setInterval(() => {
    if (subtitleSweepSetting('subtitleSweepEnabled', true) !== false) backgroundGate.runWhenClear(() => runSubtitleSweep()).catch(() => {})
  }, 24 * 60 * 60 * 1000)
  if (subtitleSweepDaily.unref) subtitleSweepDaily.unref()

  // --- Whole-library metadata catch-up (movies whose TMDB match is still unanswered) ------
  // Before this, a file only ever got looked up again by opening it (tmdbLookup's own lazy
  // path) or by the owner pressing "Re-check all movie matches" by hand. Same reasoning as the
  // subtitle sweep above: a background nibble, on a slower cadence (TMDB metadata for a title
  // that hasn't matched yet doesn't change minute to minute the way subtitle availability can).
  const metadataSweepRunner = metadataSweep.createSweepRunner({
    listCandidates: () => scanMoviesMulti(allMoviesDirs()).map((m) => m.fileName),
    shouldLookUp: (fileName) => titleMatch.shouldLookUp(store, fileName, tmdbFileCache.getManifest(getTmdbCacheDir ? getTmdbCacheDir() : null), false),
    lookupOne: (fileName) => tmdbLookup(fileName, store.get('tmdbApiKey') || process.env.TMDB_API_KEY, getTmdbCacheDir ? getTmdbCacheDir() : null, store),
    log
  })
  const metadataSweepSetting = (k, d) => { try { const v = store.get(k); return v === undefined || v === null || v === '' ? d : v } catch { return d } }
  function runMetadataSweep(opts = {}) {
    return metadataSweepRunner.run({
      batchSize: opts.batchSize != null ? opts.batchSize : metadataSweepSetting('metadataSweepBatchSize', metadataSweep.DEFAULT_BATCH_SIZE)
    })
  }
  // Automatic run: kicked off a few minutes after start (later than the subtitle sweep's 2
  // minutes, so the two never both burst on TMDB/OpenSubtitles at the very moment the app
  // opens), then daily. metadataSweepEnabled (default on) lets the owner turn it off from
  // Settings while the manual endpoint keeps working; run() is a no-op with no API key saved,
  // same as every other TMDB path in this file.
  const metadataSweepFirstRun = setTimeout(() => {
    if (metadataSweepSetting('metadataSweepEnabled', true) !== false) backgroundGate.runWhenClear(() => runMetadataSweep()).catch(() => {})
  }, 5 * 60 * 1000)
  if (metadataSweepFirstRun.unref) metadataSweepFirstRun.unref()
  const metadataSweepDaily = setInterval(() => {
    if (metadataSweepSetting('metadataSweepEnabled', true) !== false) backgroundGate.runWhenClear(() => runMetadataSweep()).catch(() => {})
  }, 24 * 60 * 60 * 1000)
  if (metadataSweepDaily.unref) metadataSweepDaily.unref()

  // --- Automatic intro / credits detection (introDetect.js + introDetectJob.js) ----------------
  // Every library file (episodes grouped by season, films on their own) is analysed by the bundled
  // ffmpeg when the house is quiet. The answers sit under store key 'autoMarkers' and are merged in
  // at read time by markersFor(): a viewer-set marker always wins. Local only - nothing leaves this PC.
  const autoMarkerSetting = (k, d) => { try { const v = store.get(k); return v === undefined || v === null || v === '' ? d : v } catch { return d } }
  const autoMarkersEnabled = () => autoMarkerSetting('autoMarkersEnabled', true) !== false
  function autoMarkerItems() {
    const items = []
    for (const m of scanMoviesMulti(allMoviesDirs())) {
      items.push({ kind: 'movie', id: encodeId(m.fileName), path: path.join(m.dir, m.fileName), label: m.fileName })
    }
    for (const f of scanTvShowsMulti(allTvShowsDirs())) {
      const g = groupKeyAndName(f.relPath, f.fileName)
      const parsed = parseEpisode(path.basename(f.relPath))
      items.push({
        kind: 'tv',
        id: encodeId(f.relPath),
        path: path.join(f.dir, f.relPath),
        showKey: encodeId(String(g.show || '').toLowerCase()),
        showName: g.show || '',
        season: parsed && parsed.season != null ? parsed.season : null,
        episode: parsed && parsed.episode != null ? parsed.episode : null,
        label: f.relPath
      })
    }
    return items
  }
  // Never compete with someone watching: any live viewer session, live conversion, or a converter
  // job in progress holds the background scanners back (between files, not mid-file).
  // Truthy when background work should wait: 'playback' (someone is watching or a conversion runs), or, from backgroundGate.js,
  // 'battery' (the PC is on battery power) or 'busy' (the CPU is already full of something else).
  const houseIsBusy = () => {
    try { if (playback.manager && playback.manager.size() > 0) return 'playback' } catch {}
    try { if (liveTv.busy()) return 'playback' } catch {}
    try { if (serverDashboard.nowPlaying().length > 0) return 'playback' } catch {}
    try { if (convert.list(store).some((c) => c && c.status === 'converting')) return 'playback' } catch {}
    try { const g = backgroundGate.check({ ignore: ['playback'] }); if (g.defer) return g.reason } catch {}
    return false
  }
  const autoMarkerScanner = introDetectJob.createIntroScanner({
    store,
    listItems: autoMarkerItems,
    isBusy: houseIsBusy,
    ffmpegPath: convert.ffmpegPath,
    ffprobePath: convert.ffprobePath,
    cacheDir: () => path.join((playbackOverrides && playbackOverrides.tmpRoot) || require('os').tmpdir(), 'beebo-auto-markers'),
    log: (m) => { if (typeof log === 'function') log(m) },
    settings: {
      enabled: autoMarkersEnabled,
      concurrency: () => autoMarkerSetting('autoMarkersConcurrency', 1),
      fullDecode: () => autoMarkerSetting('autoMarkersFullDecode', false) === true
    },
    ...(autoMarkerOverrides || {})
  })
  autoMarkerScanner.start()
  // --- Optional local AI Speech Pack (electron/addons/speechPack/): subtitles for titles that have none ---
  // Downloaded on request from Settings > Add-ons; idle (and free) until then. Same polite gate as the scanners above.
  const speechPack = require('./addons/speechPack').createSpeechPack({
    store,
    listItems: () => {
      const items = []
      for (const m of scanMoviesMulti(allMoviesDirs())) items.push({ kind: 'movie', id: encodeId(m.fileName), path: path.join(m.dir, m.fileName), label: m.fileName, dir: m.dir })
      for (const f of scanTvShowsMulti(allTvShowsDirs())) items.push({ kind: 'tv', id: encodeId(f.relPath), path: path.join(f.dir, f.relPath), label: f.relPath, dir: f.dir })
      return items
    },
    libraries: () => [...allMoviesDirs().filter(Boolean).map((dir) => ({ dir, kind: 'movies' })), ...allTvShowsDirs().filter(Boolean).map((dir) => ({ dir, kind: 'tv' }))],
    isBusy: houseIsBusy,
    ffmpegPath: convert.ffmpegPath,
    ffprobePath: convert.ffprobePath,
    log: (m) => { if (typeof log === 'function') log(m) },
    ...(speechPackOverrides || {})
  })
  speechPack.queue.start()
  // Who is watching and the owner's settings, for everything that asks backgroundGate whether to wait
  // (the battery probe is main.js's: only the desktop app knows about power).
  backgroundGate.configure({
    playing: () => {
      try { if (playback.manager && playback.manager.size() > 0) return true } catch {}
      try { if (liveTv.busy()) return true } catch {}
      try { if (serverDashboard.nowPlaying().length > 0) return true } catch {}
      return false
    },
    setting: (k, d) => store.get(k, d)
  })
  // Seek-bar previews for the whole library, made the same polite way (playbackApi.js / trickplayJob.js).
  playback.startTrickplaySweep({
    isBusy: houseIsBusy,
    listItems: () => autoMarkerItems().map((i) => ({ path: i.path })),
    ...((playbackOverrides && playbackOverrides.trickplaySweep) || {})
  })
  // --- Live TV + DVR (electron/liveTv/): the owner's own HDHomeRun tuner, watched through the same converter as everything else ---
  const liveTv = liveTvModule.createLiveTv({
    store,
    ffmpegPath: convert.ffmpegPath,
    getEncoder: () => playback.encoder(),
    sign: (id) => makeMediaToken(store, id),
    verify: (id, token) => verifyMediaToken(store, id, token),
    isRestricted: (u) => parental.isRestricted(parental.getPolicy(store, u.id)),
    crossSite: (headers) => backup.isCrossSiteRequest(headers),
    addToLibrary: (dir) => { const list = Array.isArray(store.get('extraTvShowsDirs')) ? store.get('extraTvShowsDirs') : []; if (list.includes(dir)) return false; store.set('extraTvShowsDirs', [...list, dir]); return true },
    log: (m) => { if (typeof log === 'function') log(m) },
    tmpRoot: playbackOverrides && playbackOverrides.tmpRoot ? path.join(playbackOverrides.tmpRoot, 'livetv') : undefined,
    ...(liveTvOverrides || {})
  })
  liveTvNavVisible = liveTv.navVisible()
  liveTv.onNavChange((v) => { liveTvNavVisible = v })
  liveTv.start()

  const musicLib = music || musicLibrary.createMusicLibrary({
    getDirs: typeof getAllMusicDirs === 'function' ? getAllMusicDirs : () => [],
    getCacheDir: typeof getMusicCacheDir === 'function' ? getMusicCacheDir : () => null,
    log,
    shouldDefer: () => backgroundGate.shouldDefer(),
    ffprobePath: musicTranscode.resolveFf('ffprobe'),
    ffmpegPath: musicTranscode.resolveFf('ffmpeg')
  })
  const musicHttp = musicApi.createMusicApi({
    library: musicLib,
    transcoder: musicTranscode.createTranscoder({ getCacheRoot: () => musicLib.cacheRoot(), log }),
    store,
    makeMediaToken,
    verifyMediaToken,
    log,
    recordingsDir: musicRecordingsDir
  })
  // Podcasts and Internet radio. Everything they fetch goes through outboundFetch.js (private and
  // metadata addresses refused, redirects re-checked); "allow my local network" is the owner's switch
  // in podcastSettings / radioSettings, off by default.
  const podcastsSvc = podcastService.createPodcasts({
    store, log, ffmpegPath: musicTranscode.resolveFf('ffmpeg'), autoStart: true,
    ...(podcastOverrides || {})
  })
  const podcastsHttp = podcastApi.createPodcastApi({ service: podcastsSvc, store, makeMediaToken, verifyMediaToken, log })
  const radioBrowserSvc = (radioOverrides && radioOverrides.browser) || radioBrowser.createRadioBrowser({ fetcher: outboundFetch.createFetcher({ allowPrivateNetwork: false }), log })
  const radioSvc = radioService.createRadio({ store, log, ...(radioOverrides || {}), browser: radioBrowserSvc })
  const radioHttp = radioApi.createRadioApi({ service: radioSvc, store, makeMediaToken, verifyMediaToken, log })
  // Account deletion: their subscriptions, favourites, recordings and open streams go with them.
  const purgeAudioData = (id) => {
    podcastsSvc.removeUser(id).catch(() => {})
    radioSvc.removeUser(id).catch(() => {})
  }
  // audiobookMeta needs the library and the library tells it about finished scans, hence the late binding.
  let audiobookMeta = null
  const audiobookLib = audiobooks || audiobookLibrary.createAudiobookLibrary({
    getDirs: typeof getAllAudiobookDirs === 'function' ? getAllAudiobookDirs : () => [],
    getCacheDir: typeof getAudiobookCacheDir === 'function' ? getAudiobookCacheDir : () => null,
    log,
    ffprobePath: musicTranscode.resolveFf('ffprobe'),
    ffmpegPath: musicTranscode.resolveFf('ffmpeg'),
    onScanned: () => { if (audiobookMeta) audiobookMeta.kick() }
  })
  const audiobookLookupOn = () => { try { return typeof getAudiobooksLookupEnabled === 'function' && !!getAudiobooksLookupEnabled() } catch { return false } }
  audiobookMeta = audiobookMetadata.createAudiobookMetadata({
    library: audiobookLib,
    getEnabled: audiobookLookupOn,
    ...(audiobookFetch ? { fetchImpl: audiobookFetch, minIntervalMs: 0 } : {}),
    log
  })
  const audiobookHttp = audiobookApi.createAudiobookApi({
    library: audiobookLib,
    progress: audiobookProgress.createProgress({ store }),
    transcoder: musicTranscode.createTranscoder({ getCacheRoot: () => audiobookLib.cacheRoot(), log }),
    metadata: audiobookMeta,
    store,
    makeMediaToken,
    verifyMediaToken,
    getLookupEnabled: audiobookLookupOn,
    log
  })
  const primeLibrary = (which = 'both') => library.prime(
    which === 'movies' ? { movies: allMoviesDirs() } : which === 'tv' ? { tv: allTvShowsDirs() } : { movies: allMoviesDirs(), tv: allTvShowsDirs() }
  )

  // The owner's server dashboard (serverDashboard.js): Now playing, Activity,
  // Library, Server health and Bandwidth. Video routes report their bytes to it,
  // watch-session / progress requests tell it who is on which session, and log
  // lines that describe a problem are kept for "errors in the last 24 hours".
  const serverDashboard = serverDashboardModule.createServerDashboard({
    store,
    history,
    auth,
    viewerIdentity,
    getAgentSecret: () => AGENT_SECRET,
    scanLibrary: async () => {
      // The movie walk is one folder deep and carries no sizes; the dashboard
      // wants them for "storage per folder", so they are read here (cached a minute).
      const movies = (await catalogWalker.scanMoviesMulti(allMoviesDirs())).map((m) => {
        if (typeof m.size === 'number') return m
        let size = 0
        try { size = fs.statSync(path.join(m.dir, m.fileName)).size } catch {}
        return { ...m, size }
      })
      const tvFiles = (await catalogWalker.scanTvShowsMulti(allTvShowsDirs())).map((f) => {
        const { show } = groupKeyAndName(f.relPath, f.fileName)
        return { ...f, showKey: String(show || '').toLowerCase() }
      })
      return { movies, tvFiles, filmCount: collapseMovieVersions(movies, getTmdbCacheDir ? getTmdbCacheDir() : null).length }
    },
    libraryFolders: () => [
      ...allMoviesDirs().filter(Boolean).map((dir) => ({ kind: 'movies', dir })),
      ...allTvShowsDirs().filter(Boolean).map((dir) => ({ kind: 'tv', dir }))
    ],
    convertList: () => convert.list(store),
    introScanStatus: () => autoMarkerScanner.status(),
    inboxStatus: () => (inbox && typeof inbox.status === 'function' ? inbox.status() : null),
    tlsStatus: () => ({ active: !!tlsState.active, expiresAt: tlsState.expiresAt ? new Date(tlsState.expiresAt).toISOString() : null }),
    recentlyAdded: () =>
      (Array.isArray(store.get('recentlyAdded')) ? store.get('recentlyAdded') : [])
        .filter((r) => r && r.path)
        .slice()
        .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
        .slice(0, 12)
        .map((r) => ({ title: cleanTitle(path.basename(String(r.path))), fileName: path.basename(String(r.path)), addedAt: r.addedAt || null })),
    // Only what is already in the TMDB cache: no lookups are started from here.
    missingPosters: () => {
      const cacheDir = getTmdbCacheDir ? getTmdbCacheDir() : null
      const metaOf = cachedMovieMetaReader(cacheDir)
      const tvMetaOf = cachedTvMetaReader(cacheDir)
      const noPoster = scanMoviesMulti(allMoviesDirs()).filter((m) => {
        const meta = metaOf(m.fileName)
        return !meta || !meta.poster_path
      })
      const shows = new Map()
      for (const f of scanTvShowsMulti(allTvShowsDirs())) {
        const { show } = groupKeyAndName(f.relPath, f.fileName)
        const key = String(show || '').toLowerCase()
        if (!shows.has(key)) shows.set(key, show)
      }
      const noShowPoster = []
      for (const [key, name] of shows) {
        const meta = tvMetaOf(encodeId(key))
        if (!meta || !meta.poster_path) noShowPoster.push(name)
      }
      return {
        movies: noPoster.length,
        shows: noShowPoster.length,
        examples: noPoster.slice(0, 8).map((m) => cleanTitle(m.fileName)).concat(noShowPoster.slice(0, 4))
      }
    }
  })
  {
    const previousLog = log
    log = (msg) => {
      try { serverDashboard.noteLog(msg) } catch {}
      if (typeof previousLog === 'function') previousLog(msg)
    }
  }
  // The dashboard's "Transcode load" tile (playbackApi.js's manager: running / allowed / waiting).
  serverDashboard.setHooks({ getTranscodeLoad: () => playback.transcodeLoad() })
  // --- integrations: what a playback event knows, the live event stream, the transcode list ---
  // The live conversion manager (playbackApi.js) is what "transcode vs direct" means: a session
  // whose viewer is being converted right now is a transcode. Feeds Now playing, /metrics and events.
  serverDashboard.setTranscodeProvider(() => {
    const t = Date.now()
    return ((playback.manager && playback.manager.list()) || [])
      .filter((x) => x && t - (Number(x.lastAccess) || 0) <= 30000)
      .map((x) => ({ owner: x.owner, filePath: x.filePath, quality: x.quality, videoCodec: x.videoCodec || '', audioCodec: x.audioCodec || '', reason: x.quality ? `Converting to ${x.quality}` : 'Converting', label: x.quality ? `Converting to ${x.quality}${x.hardware ? ' (graphics card)' : ''}` : '' }))
  })
  const externalIds = externalIdsModule.createExternalIds({
    getApi: () => titleMatch.createTmdbApi(store.get('tmdbApiKey') || process.env.TMDB_API_KEY),
    getCacheDir: () => (getTmdbCacheDir ? getTmdbCacheDir() : null)
  })
  // Year, show/season/episode and TMDB / IMDb / TVDB ids for one session row (history.js's shape).
  // Synchronous and cache-only: an id that is not known yet is null now and fetched in the
  // background, so the next event for that title has it.
  function playbackMediaInfo(row) {
    const cacheDir = getTmdbCacheDir ? getTmdbCacheDir() : null
    const fileName = String((row && row.fileName) || '')
    const yr = (d) => { const y = Number(String(d || '').slice(0, 4)); return Number.isFinite(y) && y > 0 ? y : null }
    if (row && row.kind === 'tv') {
      const ep = parseEpisode(path.basename(fileName))
      const { show } = groupKeyAndName(fileName, path.basename(fileName))
      const meta = cachedTvMetaReader(cacheDir)(encodeId(String(show || '').toLowerCase()))
      const tmdb = meta && meta.id != null ? Number(meta.id) : null
      const ext = tmdb ? externalIds.peek('tv', tmdb) : null
      if (tmdb && !ext) externalIds.warm('tv', tmdb).catch(() => {})
      return {
        year: yr(meta && meta.first_air_date),
        show: (meta && meta.name) || show || null,
        season: ep && ep.season != null ? ep.season : null,
        episode: ep && ep.episode != null ? ep.episode : null,
        ids: { tmdb, imdb: (ext && ext.imdb) || null, tvdb: (ext && ext.tvdb) || null }
      }
    }
    const meta = cachedMovieMetaReader(cacheDir)(fileName)
    const parsed = parseMovieTitle(fileName) || {}
    const tmdb = meta && meta.id != null ? Number(meta.id) : null
    const ext = tmdb ? externalIds.peek('movie', tmdb) : null
    if (tmdb && !ext) externalIds.warm('movie', tmdb).catch(() => {})
    return { year: (meta && yr(meta.release_date)) || Number(parsed.year) || null, ids: { tmdb, imdb: (ext && ext.imdb) || parsed.imdbId || null, tvdb: null } }
  }
  // The history row behind a session id (a live one, or one parked while a surf session earns its place).
  function sessionRowById(sessionId) {
    if (!sessionId) return null
    const id = String(sessionId)
    try {
      return history.getHistory(store).find((e) => e && e.sessionId === id) || history.getPendingSessions(store).find((e) => e && e.sessionId === id) || null
    } catch {
      return null
    }
  }
  webhooks.setPlaybackContext((row) => {
    let np = null
    try { np = serverDashboard.nowPlaying().find((r) => r.sessionId && r.sessionId === row.sessionId) || null } catch { np = null }
    return {
      device: np ? np.device : null,
      location: np ? np.where : null,
      playback: np ? np.playback : 'direct',
      transcode: np ? np.transcode : null,
      media: playbackMediaInfo(row)
    }
  })
  const liveEvents = eventStream.createEventStream({ webhooks })
  // The tokens a request may use to see who is watching: hide private and limited profiles.
  const hideFromOutsideTools = (id) => !!id && (viewingPrivacy.isPrivate(store, id) || parental.isRestricted(parental.getPolicy(store, id)))
  const nowPlayingJson = () => publicApi.shapeNowPlaying(serverDashboard.nowPlaying(), hideFromOutsideTools, {
    mediaOf: (r) => { const row = sessionRowById(r.sessionId); return row ? playbackMediaInfo(row) : null },
    refOf: (r) => (r.sessionId ? webhooks.sessionRef(r.sessionId) : null)
  })
  // --- parental controls + library shares: the one content gate (electron/contentGate.js) ---
  const parentalUsage = parental.createUsageTracker(store)
  const parentalPinLimiter = parental.createPinLimiter()
  const apiKeyGuard = apiKeys.createGuard()
  const viewerExchangeRoute = viewerExchange.createViewerExchange({
    store, license, localAccess, makeApiToken, log: (m) => { if (typeof log === 'function') log(m) },
    clientIp: (req) => getClientIp(req),
    userShape: (u) => apiUserShape(u),
    getHouseName: () => (typeof getHouseName === 'function' && getHouseName()) || (typeof getPublicName === 'function' && getPublicName()) || ''
  })
  const shareStreamLimiter = libraryShares.createStreamLimiter()
  const libraryRootOf = (dirs, relOrName, isTv) => {
    for (const d of dirs) {
      if (!d) continue
      try { if (fs.existsSync(path.join(d, relOrName))) return d } catch {}
    }
    return null
  }
  const contentGateInstance = contentGate.createContentGate({
    usage: parentalUsage,
    readers: () => {
      const cacheDir = getTmdbCacheDir ? getTmdbCacheDir() : null
      const movieMeta = cachedMovieMetaReader(cacheDir)
      const tvMeta = cachedTvMetaReader(cacheDir)
      ensureCollectionsLoaded(cacheDir)
      return {
        movie(fileName) {
          const m = movieMeta(fileName)
          if (!m) return null
          const col = m.id != null ? movieCollectionCache.get(String(m.id)) : null
          const g = m.gate || { certification: m.certification, genre_ids: m.genre_ids }
          return { tmdbId: m.id, certification: g.certification, genres: g.genre_ids || [], collectionId: col && col.id != null ? col.id : null }
        },
        show(showKey) {
          const m = tvMeta(showKey)
          const g = m && (m.gate || { certification: m.certification, genre_ids: m.genre_ids })
          return m ? { tmdbId: m.id, certification: g.certification, genres: g.genre_ids || [] } : null
        },
        showKeyOf(relPath, fileName) {
          const { show } = groupKeyAndName(relPath, fileName)
          return encodeId(String(show || '').toLowerCase())
        },
        movieDir: (fileName) => libraryRootOf(allMoviesDirs(), fileName),
        tvDir: (relPath) => libraryRootOf(allTvShowsDirs(), relPath),
      }
    },
  })
  // --- Cinema Mode: a pre-show before a film (cinemaMode.js, cinemaModeWeb.js, docs/CINEMA-MODE.md) ---
  // GET /api/playback/preroll (and /playback-api/...) answers with what to play first; /cinema/media/<id>
  // serves the local trailer / intro files by signed token. The gate for a restricted profile lives in
  // cinemaMode.evaluateCandidate (parentalControls.decide, stricter: an unrated trailer is refused).
  const cinemaProber = require('./playbackTracks').createTrackProber({ ffprobePath: convert.ffprobePath })
  const cinemaMeta = (m) => {
    if (!m) return {}
    ensureCollectionsLoaded(getTmdbCacheDir ? getTmdbCacheDir() : null)
    const col = m.id != null ? movieCollectionCache.get(String(m.id)) : null
    const g = m.gate || { certification: m.certification, genre_ids: m.genre_ids }
    const year = /^\d{4}/.test(String(m.release_date || '')) ? Number(String(m.release_date).slice(0, 4)) : null
    return { tmdbId: m.id != null ? m.id : null, title: m.title || '', year, genres: g.genre_ids || [], certification: g.certification || null, collectionId: col && col.id != null ? col.id : null }
  }
  const cinema = cinemaMode.createCinemaService({
    store,
    getMovieDirs: () => allMoviesDirs(),
    getCacheDir: () => (getTmdbCacheDir ? getTmdbCacheDir() : null),
    getApi: () => titleMatch.createTmdbApi(store.get('tmdbApiKey') || process.env.TMDB_API_KEY),
    sign: (id) => makeMediaToken(store, id),
    check: (id, token) => checkMediaToken(store, id, token).ok,
    probeDuration: async (file) => { const t = await cinemaProber.probe(file); return t ? t.durationSec : null },
    resolveFeature: async (kind, id) => {
      let rel
      try { rel = decodeId(id) } catch { return null }
      if (!rel) return null
      await primeLibrary('movies')
      const m = await library.findMovie(allMoviesDirs(), rel)
      if (!m) return null
      return { fileName: m.fileName, dir: m.dir, meta: cinemaMeta(cachedMovieMetaReader(getTmdbCacheDir ? getTmdbCacheDir() : null)(m.fileName, m.dir)) }
    },
    // Every film in the library with this person's watched mark; the cached details are read only for the films
    // the picker actually considers (getMeta). The parental limits are applied by the picker itself, from the
    // same policy the content gate uses.
    listOwned: (userId) => {
      const cacheDir = getTmdbCacheDir ? getTmdbCacheDir() : null
      const metaOf = cachedMovieMetaReader(cacheDir)
      let manifest = {}
      try { manifest = cacheDir ? tmdbFileCache.getManifest(cacheDir) : {} } catch { manifest = {} }
      let files = {}
      try { files = watchedState.userFiles(store, userId) } catch { files = {} }
      const seen = (fileName) => { const r = files[watchedState.fileKey('movie', fileName)]; return !!(r && r.watched) }
      return rawScanMoviesMulti(allMoviesDirs()).map((m) => ({
        id: m.id || encodeId(m.fileName), fileName: m.fileName, dir: m.dir,
        watched: seen(m.fileName) || movieVersions.siblingsOf(m.fileName).some(seen),
        tmdbId: (manifest[m.fileName] && manifest[m.fileName].id) || null,
        getMeta: () => cinemaMeta(metaOf(m.fileName, m.dir))
      }))
    },
    ...(cinemaOverrides || {})
  })

  const shareOwnerLabel = () => {
    try {
      const owner = auth.getUsers(store).find((u) => u && u.isAdmin && u.status === 'approved')
      return owner && owner.name ? `${owner.name}'s library` : 'Shared library'
    } catch {
      return 'Shared library'
    }
  }
  // Who is asking, as the gate needs it. A share id or a user id.
  const viewerForUser = (user) => (user ? { type: 'member', userId: user.id, policy: parental.getPolicy(store, user.id) } : null)
  const viewerForShare = (share) => (share ? { type: 'guest', shareId: share.id, share, policy: share.parental } : null)
  const viewerForMediaScope = (scope) => {
    if (!scope) return null
    if (scope.startsWith('s:')) {
      const share = libraryShares.get(store, scope.slice(2))
      return share ? viewerForShare(share) : { type: 'guest', shareId: scope.slice(2), share: null, policy: null }
    }
    const user = auth.getUsers(store).find((u) => u && u.id === scope.slice(2) && u.status === 'approved')
    // A token bound to someone who is gone plays nothing.
    return user ? viewerForUser(user) : { type: 'guest', shareId: 'none', share: null, policy: null }
  }
  // --- Watch together (watchTogether*.js): rooms of signed-in people watching one title in step ---
  const watchTogether = watchTogetherHttp.createWatchTogetherHttp({
    manager: watchTogetherRooms.createWatchTogether({
      log: (m) => { if (typeof log === 'function') log(m) },
      // May this person watch that title? It must exist, and parental controls / bedtime must allow it.
      canView: async (userId, kind, id) => {
        let rel
        try { rel = decodeId(id) } catch { return { ok: false } }
        if (!rel) return { ok: false }
        const user = auth.getUsers(store).find((u) => u && u.id === userId && u.status === 'approved')
        if (!user) return { ok: false }
        const viewer = viewerForUser(user)
        if (!contentGateInstance.allowId(viewer, kind === 'tv' ? 'tv' : 'movie', id)) return { ok: false }
        if (contentGateInstance.isLimited(viewer) && !contentGateInstance.timeGate(viewer).ok) return { ok: false }
        const found = kind === 'tv' ? await library.findTvFile(allTvShowsDirs(), rel) : await library.findMovie(allMoviesDirs(), rel)
        return found ? { ok: true, title: cleanTitle(path.basename(rel)) } : { ok: false }
      }
    }),
    getUser: (userId) => auth.getUsers(store).find((u) => u && u.id === userId && u.status === 'approved') || null,
    getClientIp: (req) => getClientIp(req),
    getOrigin: () => linkOrigin(),
    log: (m) => { if (typeof log === 'function') log(m) }
  })
  watchTogetherRooms.setActive(watchTogether)
  // --- Movie Night (movieNight*.js): TV hub + up to 12 guests on phones (no account), games built from the cached library ---
  const movieNightPools = movieNightLibrary.createPoolCache()
  const movieNight = movieNightHttp.createMovieNightHttp({
    manager: movieNightRooms.createMovieNight({
      log: (m) => { if (typeof log === 'function') log(m) },
      getSettings: () => store.get('movieNight'),
      // The pool of titles for one room: the host's own parental limits AND the owner's rating cap, cached TMDB data only.
      getPool: ({ userId, settings }) => movieNightPools.get(`${userId || '-'}|${settings.ratingCap}|${settings.includeUnrated}`, async () => {
        await primeLibrary('movies')
        const cacheDir = getTmdbCacheDir ? getTmdbCacheDir() : null
        const user = userId ? auth.getUsers(store).find((u) => u && u.id === userId && u.status === 'approved') : null
        const viewer = viewerForUser(user)
        let credits = {}
        try { credits = cacheDir ? tmdbFileCache.getCreditsMap(cacheDir) : {} } catch { credits = {} }
        const images = tmdbFileCache.localImageIndex(cacheDir)
        const details = movieNightLibrary.readDetails(cacheDir)
        return movieNightLibrary.buildPool({
          movies: collapseMovieVersions(rawScanMoviesMulti(allMoviesDirs()), cacheDir),
          metaOf: cachedMovieMetaReader(cacheDir),
          creditsOf: (tmdbId) => credits[String(tmdbId)] || [],
          detailsOf: (tmdbId) => details.get(String(tmdbId)),
          hasPoster: (tmdbId) => images.hasPoster(tmdbId),
          hasActorPhoto: (personId) => images.hasActorPhoto(personId),
          idOf: (m) => m.id || encodeId(m.fileName),
          allow: (id) => contentGateInstance.allowId(viewer, 'movie', id),
          cap: settings.ratingCap,
          includeUnrated: settings.includeUnrated
        })
      })
    }),
    getSettings: () => movieNightRooms.normalizeSettings(store.get('movieNight')),
    getUser: (userId) => auth.getUsers(store).find((u) => u && u.id === userId && u.status === 'approved') || null,
    userFromRequest: (req) => { try { return auth.verifySession(store, auth.parseCookies(req)[SESSION_COOKIE]) || null } catch { return null } },
    getClientIp: (req) => getClientIp(req),
    isHomeRequest: (req) => localAccess.isHomeRequest(req),
    // The address a phone should open: this server's own address on the home network (works with no internet).
    getJoinBase: (req) => {
      const host = String((req.headers && req.headers.host) || '')
      const tls = !!(req.socket && req.socket.encrypted)
      if (localAccess.isHomeRequest(req)) {
        if (/^(\d{1,3}\.){3}\d{1,3}(:\d+)?$/.test(host) && !hostPolicy.isLoopback(host) && hostPolicy.isKnown(host)) return (tls ? 'https://' : 'http://') + host
        const ip = movieNightHttp.lanAddress() || lanIPv4()
        if (ip) return `http://${ip}:${ACTIVE_PORT}`
      }
      return httpSecurity.trustedOrigin(hostPolicy, req, { tlsActive: !!tlsState.active }) || linkOrigin()
    },
    getLanBase: () => { const ip = movieNightHttp.lanAddress() || lanIPv4(); return ip ? `http://${ip}:${ACTIVE_PORT}` : '' },
    log: (m) => { if (typeof log === 'function') log(m) }
  })
  movieNightRooms.setActive(movieNight)
  // --- Phone speakers (phoneSpeakers*.js): guests' phones (no account) play the film's channels while the screen shows it ---
  const phoneSpeakers = phoneSpeakersServer.createPhoneSpeakersService({
    store,
    log: (m) => { if (typeof log === 'function') log(m) },
    ffmpegPath: convert.ffmpegPath,
    ffprobePath: convert.ffprobePath,
    profile: () => { try { return playback.encoderService.profile() } catch { return null } },
    resolveFile: async (kind, id) => {
      let rel
      try { rel = decodeId(id) } catch { return null }
      if (!rel) return null
      if (kind === 'tv') { const m = await library.findTvFile(allTvShowsDirs(), rel); return m ? path.join(m.dir, m.relPath) : null }
      const m = await library.findMovie(allMoviesDirs(), rel)
      return m ? path.join(m.dir, m.fileName) : null
    },
    // Same rules as watching it: the film must exist and parental controls / bedtime must allow it for this person.
    canView: async (userId, kind, id) => {
      let rel
      try { rel = decodeId(id) } catch { return { ok: false } }
      if (!rel) return { ok: false }
      const user = auth.getUsers(store).find((u) => u && u.id === userId && u.status === 'approved')
      if (!user) return { ok: false }
      const viewer = viewerForUser(user)
      if (!contentGateInstance.allowId(viewer, kind === 'tv' ? 'tv' : 'movie', id)) return { ok: false }
      if (contentGateInstance.isLimited(viewer) && !contentGateInstance.timeGate(viewer).ok) return { ok: false }
      const found = kind === 'tv' ? await library.findTvFile(allTvShowsDirs(), rel) : await library.findMovie(allMoviesDirs(), rel)
      return found ? { ok: true, title: cleanTitle(path.basename(rel)) } : { ok: false }
    },
    getUser: (userId) => auth.getUsers(store).find((u) => u && u.id === userId && u.status === 'approved') || null,
    // real Wi-Fi / Ethernet addresses first, virtual adapters last (phoneSpeakersServer.lanOrigins)
    getJoinOrigins: () => phoneSpeakersServer.lanOrigins(ACTIVE_PORT),
    isHomeRequest: (req) => localAccess.isHomeRequest(req),
    getClientIp: (req) => getClientIp(req),
    qrSvg: (text, o) => phoneSpeakersQrSvg(text, o)
  })
  phoneSpeakersServer.setActive(phoneSpeakers)
  // Ask the host (main.js) to push the share list to beebo.tv, if it gave us a way to.
  const requestShareSync = () => {
    try { if (typeof onSharesChanged === 'function') onSharesChanged() } catch {}
  }
  // Streams to a limited viewer re-check bedtime and the daily limit every minute while they
  // run, and count that minute as watching time. A share's streams-at-once is checked per title.
  function watchLimitedStream(req, res, viewer) {
    if (!contentGateInstance.isLimited(viewer)) return
    contentGateInstance.noteWatching(viewer)
    const timer = setInterval(() => {
      if (res.writableEnded || res.destroyed) { clearInterval(timer); return }
      contentGateInstance.noteWatching(viewer)
      const fresh = viewer.type === 'guest' ? viewerForMediaScope('s:' + viewer.shareId) : viewerForMediaScope('u:' + viewer.userId)
      if (!contentGateInstance.timeGate(fresh).ok) { try { res.destroy() } catch {} clearInterval(timer) }
    }, 60 * 1000)
    if (timer.unref) timer.unref()
    res.once('close', () => clearInterval(timer))
  }
  // -> null when this viewer may stream this title now, else { status, error, message }
  function streamRefusal(viewer, kind, id) {
    if (!contentGateInstance.isLimited(viewer)) return null
    if (!contentGateInstance.allowId(viewer, kind, id)) return { status: 404, error: 'not_found' }
    const t = contentGateInstance.timeGate(viewer)
    if (!t.ok) return { status: 403, error: t.reason, message: t.message }
    if (viewer.type === 'guest' && !shareStreamLimiter.admit(viewer.shareId, kind + ':' + id, viewer.share.maxStreams)) {
      return { status: 429, error: 'too_many_streams', message: 'This shared library is already playing on as many screens as it allows.' }
    }
    return null
  }

  // Startup housekeeping: bin any surf session an earlier build parked (or
  // flagged provisional inside watchHistory) so old channel-surf noise can
  // never promote itself into history after this upgrade.
  try {
    const swept = history.sweepProvisional(store)
    if (swept && log) log(`swept ${swept} never-promoted watch-history row(s)`)
  } catch {}
  // One-time merge of the two old "watched" records into watchedState.js's
  // store (backs libraryFlags up first; history is only read). A no-op after
  // the first run. Every reader also calls it, so a failure here only delays it.
  try {
    watchedState.ensureMigrated(store)
  } catch {}

  // --- shared playerPage inputs for one movie / one episode ---
  // Extracted verbatim from the /watch and /tvwatch handlers so /surprise/play
  // gets an identical watch-history session, poster, media token and
  // kind/mediaId pair — which is what keeps history, quality flagging and the
  // auto-converter working on surfed titles. Both routes below now call these,
  // so there is exactly one copy of the logic.
  // `opts.provisional` — the 🎲 surf player's sessions don't count as viewing
  // until POST /progress says five minutes were actually played (history.js).
  async function movieWatchProps(id, userId, opts) {
    let fileName = ''
    try {
      fileName = decodeId(id)
    } catch {
      fileName = ''
    }

    const users = auth.getUsers(store)
    const user = users.find((u) => u.id === userId)
    const key = store.get('tmdbApiKey') || process.env.TMDB_API_KEY
    const cacheDir = getTmdbCacheDir ? getTmdbCacheDir() : null
    const tmdb = fileName ? await tmdbLookup(fileName, key, cacheDir, store) : null
    const title = tmdb?.title || cleanTitle(fileName || 'Unknown')

    const sessionId = history.startSession(store, {
      userId,
      userName: user?.name || 'Unknown',
      fileName,
      title,
      kind: 'movie',
      provisional: !!(opts && opts.provisional)
    })

    const moviePoster = tmdb ? posterUrl(cacheDir, tmdb.id, tmdb.poster_path) : null

    return {
      src: `/file?id=${encodeURIComponent(id)}&mt=${makeMediaToken(store, id)}`,
      title,
      poster: moviePoster,
      sessionId,
      kind: 'movie',
      mediaId: id
    }
  }

  async function tvWatchProps(id, userId, opts) {
    let relPath = ''
    try {
      relPath = decodeId(id)
    } catch {
      relPath = ''
    }

    const users = auth.getUsers(store)
    const user = users.find((u) => u.id === userId)
    const parsed0 = relPath ? parseEpisode(path.basename(relPath)) : null
    // The show name comes from the same grouping the library uses (the show's
    // folder first), not from the episode's file name: "House/house.s02e11.mkv"
    // used to be logged as "house — S2E11" beside "House — S2E12", so one show
    // showed up under two names. The id (the relPath) is unchanged.
    const parsed = parsed0
      ? { ...parsed0, show: (relPath && groupKeyAndName(relPath, path.basename(relPath)).show) || parsed0.show }
      : null
    // Real episode name (TVmaze, free, cached) appended so the player header matches
    // the desktop app ("House — S1E2 · Paternity"). Best-effort; any failure
    // just leaves the plain "Show — SxEy".
    let epRealName = null
    if (parsed && parsed.show && parsed.season != null && parsed.episode != null) {
      try { const m = await tvmazeEpisodeNames(parsed.show); epRealName = m[parsed.season + '|' + parsed.episode] || null } catch {}
    }
    const title = parsed
      ? `${parsed.show}${parsed.season !== null ? ` — S${parsed.season}E${parsed.episode}` : ''}${epRealName ? ` · ${epRealName}` : ''}`
      : 'Unknown'

    const sessionId = history.startSession(store, {
      userId,
      userName: user?.name || 'Unknown',
      fileName: relPath,
      title,
      kind: 'tv',
      provisional: !!(opts && opts.provisional)
    })

    // Best-effort show poster for the lock-screen artwork (cached lookups only cost a map read)
    let tvPoster = null
    if (parsed?.show) {
      try {
        const tmdbKey = store.get('tmdbApiKey') || process.env.TMDB_API_KEY
        const cacheDir = getTmdbCacheDir ? getTmdbCacheDir() : null
        const meta = await tmdbLookupTv(parsed.show, encodeId(parsed.show.toLowerCase()), tmdbKey, cacheDir, parsed.year || undefined)
        if (meta) tvPoster = tvPosterUrl(cacheDir, meta.id, meta.poster_path)
      } catch {}
    }

    return {
      src: `/tvfile?id=${encodeURIComponent(id)}&mt=${makeMediaToken(store, id)}`,
      title,
      poster: tvPoster,
      sessionId,
      kind: 'tv',
      mediaId: id
    }
  }

  // --- "Up next" resolution ------------------------------------------------
  // Works out what should play after the current title. STRICTLY cache-only:
  // the cached TMDB manifests (cachedMovieMetaReader / cachedTvMetaReader),
  // tvSeasons.json and collections.json — exactly the data the Missing Episodes
  // and Sequels tabs already fill in. Nothing here ever hits the network, so a
  // cabin-with-no-internet install behaves identically.
  //
  // Returns null (nothing sensible to queue up), or:
  //   { available:true,  title, href }                 -> the player counts down and navigates
  //   { available:false, title, report:{...} }         -> the player says so and files a request

  // Films this user has watched — used so "next unwatched part of the
  // collection" skips sequels they've already seen. Read from the one
  // watched-state store, so a film ticked by hand counts exactly like one
  // played to the end, and an unticked one does not.
  function finishedFileNames(userId) {
    const set = new Set()
    try {
      for (const [k, rec] of Object.entries(watchedState.userFiles(store, userId))) {
        if (rec && rec.watched && k.startsWith('movie:')) set.add(k.slice('movie:'.length))
      }
    } catch {
      // a corrupt store must never stop the up-next card from working
    }
    return set
  }

  // ONE traversal per kind answers BOTH directions, so "what's next" and
  // "what's previous" can never disagree and the library is scanned once.
  //   next     -> { available:true, kind, id, showKey?, title, href }
  //               | { available:false, title, report:{...} }   (TMDB knows it, we don't have it)
  //               | null                                        (end of series/collection)
  //   previous -> { available:true, kind, id, showKey?, title, href } | null
  // `previous` deliberately has no "missing" form: it is pure navigation (the
  // ⏮ button), so there is nothing to report and nothing to count down to.
  function tvNeighbours(id) {
    let relPath = ''
    try {
      relPath = decodeId(String(id || ''))
    } catch {
      return null
    }
    if (!relPath) return null
    const baseName = path.basename(relPath)
    const parsed = parseEpisode(baseName)
    if (!parsed || parsed.season === null || parsed.episode === null) return null
    // Same grouping the /tvshows page uses, so "the same show" means the same
    // thing on both pages (folder name wins over messy per-file names).
    const showName = groupKeyAndName(relPath, baseName).show || parsed.show
    const showLc = String(showName).toLowerCase()
    const showKey = encodeId(showLc)

    const eps = []
    for (const f of scanTvShowsMulti(allTvShowsDirs())) {
      if (String(groupKeyAndName(f.relPath, f.fileName).show || '').toLowerCase() !== showLc) continue
      const p = parseEpisode(path.basename(f.relPath))
      if (!p || p.season === null || p.episode === null) continue
      eps.push({ season: p.season, episode: p.episode, relPath: f.relPath })
    }
    const inLib = (s2, e) => eps.find((x) => x.season === s2 && x.episode === e) || null

    const cacheDir = getTmdbCacheDir ? getTmdbCacheDir() : null
    ensureTvSeasonsLoaded(cacheDir)
    const meta = cachedTvMetaReader(cacheDir)(showKey)
    const seasons = meta && meta.id != null ? tvSeasonsCache.get(String(meta.id)) : null
    const hasSeasonData = Array.isArray(seasons) && seasons.length > 0
    const seasonInfo = (n) => (hasSeasonData ? seasons.find((x) => x && x.season_number === n) || null : null)

    const context = { showKey, showName, season: parsed.season, episode: parsed.episode }
    const ownedItem = (target) => {
      const owned = inLib(target.season, target.episode)
      if (!owned) return null
      const encoded = encodeId(owned.relPath)
      return {
        available: true,
        kind: 'tv',
        id: encoded,
        showKey,
        // `id` rides along for GET /api/upnext, which needs the encoded id to
        // build a poster + tokenised stream URL. playerPage only reads href.
        title: `${showName} — S${target.season}E${target.episode}`,
        href: `/tvwatch?id=${encodeURIComponent(encoded)}`
      }
    }

    // ---------------- forward ----------------
    let nextTarget = null
    const nextInSeason = { season: parsed.season, episode: parsed.episode + 1 }
    const curSeason = seasonInfo(parsed.season)
    if (inLib(nextInSeason.season, nextInSeason.episode)) {
      nextTarget = nextInSeason
    } else if (curSeason && Number(curSeason.episode_count) >= nextInSeason.episode) {
      // TMDB says the season runs longer than what's on disk — a real gap.
      nextTarget = nextInSeason
    } else if (hasSeasonData) {
      // Season finished: roll over to episode 1 of the next season TMDB knows
      // about. No later season at all means end of series — nothing to queue.
      const later = seasons
        .filter((x) => x && x.season_number > parsed.season && Number(x.episode_count) > 0)
        .sort((a, b) => a.season_number - b.season_number)
      nextTarget = later.length ? { season: later[0].season_number, episode: 1 } : null
    } else {
      // No cached season data at all — roll over using only what's on disk, and
      // never claim something is "missing" when TMDB hasn't been consulted.
      const later = eps
        .filter((x) => x.season > parsed.season)
        .sort((a, b) => a.season - b.season || a.episode - b.episode)
      nextTarget = later.length ? { season: later[0].season, episode: later[0].episode } : null
    }

    let next = null
    if (nextTarget) {
      next = ownedItem(nextTarget)
      if (!next) {
        const airYear = Number(String(meta?.first_air_date || '').slice(0, 4))
        const label = `${showName} — S${nextTarget.season}E${nextTarget.episode}`
        next = {
          available: false,
          title: label,
          report: {
            kind: 'tv',
            showName,
            season: nextTarget.season,
            episode: nextTarget.episode,
            title: label,
            tmdbId: meta && meta.id != null ? meta.id : null,
            year: Number.isFinite(airYear) && airYear ? airYear : null
          }
        }
      }
    }

    // ---------------- backward ----------------
    // Mirrors the forward walk: one back within the season, and at a season
    // boundary the LAST episode of the previous season. TMDB's episode_count
    // picks that last episode when known; it is then clamped down to the
    // highest episode actually on disk, so "previous" always lands on
    // something playable rather than on a gap.
    let previous = null
    if (parsed.episode > 1) {
      previous = ownedItem({ season: parsed.season, episode: parsed.episode - 1 })
    } else {
      const earlierSeasons = hasSeasonData
        ? seasons
            .filter((x) => x && x.season_number < parsed.season && Number(x.episode_count) > 0)
            .map((x) => ({ season: x.season_number, last: Number(x.episode_count) }))
        : []
      const diskSeasons = Array.from(new Set(eps.filter((x) => x.season < parsed.season).map((x) => x.season)))
        .map((n) => ({ season: n, last: Math.max(...eps.filter((x) => x.season === n).map((x) => x.episode)) }))
      const pool = earlierSeasons.length ? earlierSeasons : diskSeasons
      if (pool.length) {
        const prevSeason = pool.sort((a, b) => b.season - a.season)[0]
        const ownedInSeason = eps.filter((x) => x.season === prevSeason.season && x.episode <= prevSeason.last)
        if (ownedInSeason.length) {
          const lastOwned = ownedInSeason.sort((a, b) => b.episode - a.episode)[0]
          previous = ownedItem({ season: prevSeason.season, episode: lastOwned.episode })
        }
      }
    }

    return { next, previous, context }
  }

  // Filename-only "next in the franchise" — used whenever the TMDB collection path
  // can't answer (no key, no collections.json, or a movie TMDB doesn't group). Same
  // shape movieNeighbours returns for `next`: an available item to auto-play, or an
  // unavailable one carrying a report so the app can flag the missing sequel.
  function filenameMovieNext(fileName, userId) {
    try {
      const cur = movieSeriesInfo(parseMovieTitle(fileName).title)
      if (!cur || !cur.series) return null
      const bySeries = new Map()
      for (const m of scanMoviesMulti(allMoviesDirs())) {
        const k = movieSeriesInfo(parseMovieTitle(m.fileName).title)
        if (!k || !k.series) continue
        let nm = bySeries.get(k.series)
        if (!nm) { nm = new Map(); bySeries.set(k.series, nm) }
        if (!nm.has(k.num)) nm.set(k.num, m) // first file for a given number wins
      }
      const group = bySeries.get(cur.series)
      // Need at least two entries under the same base before trusting it's a franchise
      // (guards against a stray number inside a standalone film's title).
      if (!group || group.size < 2) return null
      const maxNum = Math.max(...group.keys())
      const finished = finishedFileNames(userId)
      for (let n = cur.num + 1; n <= maxNum; n++) {
        const have = group.get(n)
        if (have) {
          if (have.fileName === fileName || finished.has(have.fileName)) continue
          const encoded = encodeId(have.fileName)
          return {
            available: true,
            kind: 'movie',
            id: encoded,
            title: parseMovieTitle(have.fileName).title || titleCaseWords(cur.series),
            href: `/watch?id=${encodeURIComponent(encoded)}`
          }
        }
        // A missing part before one we DO own further along: report it so the owner can
        // locate the file. Stop here (don't skip ahead) — the very next sequel comes first.
        const label = `${titleCaseWords(cur.series)} ${n}`
        return {
          available: false,
          title: label,
          report: { kind: 'movie', title: label, collectionName: titleCaseWords(cur.series), tmdbId: null, year: null }
        }
      }
      return null
    } catch {
      return null
    }
  }

  function movieNeighbours(id, userId) {
    let fileName = ''
    try {
      fileName = decodeId(String(id || ''))
    } catch {
      return null
    }
    if (!fileName) return null
    const cacheDir = getTmdbCacheDir ? getTmdbCacheDir() : null
    const metaOf = cachedMovieMetaReader(cacheDir)
    const meta = metaOf(fileName)
    if (!meta || meta.id == null) return { next: filenameMovieNext(fileName, userId), previous: null, context: null }

    // collections.json — the very same map the Sequels view renders from.
    ensureCollectionsLoaded(cacheDir)
    const collection = movieCollectionCache.get(String(meta.id))
    if (!collection || !Array.isArray(collection.parts) || collection.parts.length < 2) return { next: filenameMovieNext(fileName, userId), previous: null, context: null }
    const parts = collection.parts
      .slice()
      .sort((a, b) => String(a.release_date || '9999').localeCompare(String(b.release_date || '9999')))
    const idx = parts.findIndex((p) => p && String(p.id) === String(meta.id))
    if (idx < 0) return { next: filenameMovieNext(fileName, userId), previous: null, context: null }

    const owned = new Map()
    for (const m of collapseMovieVersions(scanMoviesMulti(allMoviesDirs()), getTmdbCacheDir ? getTmdbCacheDir() : null)) {
      const mm = metaOf(m.fileName)
      if (mm && mm.id != null) owned.set(String(mm.id), m)
    }
    const finished = finishedFileNames(userId)
    const partItem = (p, have) => {
      const encoded = encodeId(have.fileName)
      return {
        available: true,
        kind: 'movie',
        id: encoded,
        title: p.title || collection.name,
        href: `/watch?id=${encodeURIComponent(encoded)}`
      }
    }

    // ---------------- forward ----------------
    let next = null
    for (let i = idx + 1; i < parts.length; i++) {
      const p = parts[i]
      if (!p) continue
      const have = owned.get(String(p.id))
      if (have) {
        // Already seen (or it IS the file playing) — keep walking the franchise.
        if (have.fileName === fileName || finished.has(have.fileName)) continue
        next = partItem(p, have)
        break
      }
      const relYear = Number(String(p.release_date || '').slice(0, 4))
      next = {
        available: false,
        title: p.title || collection.name,
        report: {
          kind: 'movie',
          title: p.title || '',
          collectionName: collection.name || null,
          tmdbId: p.id != null ? p.id : null,
          year: Number.isFinite(relYear) && relYear ? relYear : null
        }
      }
      break
    }

    // ---------------- backward ----------------
    // The preceding part in release order. Parts that aren't in the library are
    // stepped over (unlike forward, there is nothing to report here — ⏮ has to
    // land on something playable or on nothing at all).
    let previous = null
    for (let i = idx - 1; i >= 0; i--) {
      const p = parts[i]
      if (!p) continue
      const have = owned.get(String(p.id))
      if (have && have.fileName !== fileName) {
        previous = partItem(p, have)
        break
      }
    }

    return { next: next || filenameMovieNext(fileName, userId), previous, context: null }
  }

  // Both directions plus the current item's context, in one pass. Never throws.
  function neighboursFor(kind, id, userId) {
    try {
      const out = kind === 'tv' ? tvNeighbours(id) : movieNeighbours(id, userId)
      return out || { next: null, previous: null, context: null }
    } catch {
      // Transport/up-next are conveniences — a failure must never break the player.
      return { next: null, previous: null, context: null }
    }
  }

  // Kept as the name every existing caller uses (the player's Up Next card and
  // GET /api/upnext) — now just the forward half of the shared traversal.
  function nextUpFor(kind, id, userId) {
    return neighboursFor(kind, id, userId).next
  }

  // --- playback markers: which show/movie does this id belong to? ---------
  // Resolving the scope server-side is the whole point: the client just posts
  // the id it is playing and never has to know that TV markers are per-SHOW
  // (so every episode inherits one setting) while movie markers are per-file.
  function markerTargetFor(kind, rawId) {
    let decoded = ''
    try {
      decoded = decodeId(String(rawId || ''))
    } catch {
      return null
    }
    if (!decoded) return null
    // base64url decoding is lenient — it turns junk into junk rather than
    // throwing — so the id has to actually name something in the library
    // before it can key a marker. Same check /api/watch-session uses.
    if (!apiMediaExists(kind === 'tv' ? 'tv' : 'movie', rawId)) return null
    if (kind === 'tv') {
      // Same grouping /tvshows and tvNeighbours use, so a marker set on
      // "Show A/S01E01.mkv" is found again from "Show A/S02E07.mkv".
      const show = groupKeyAndName(decoded, path.basename(decoded)).show
      if (!show) return null
      return { scope: 'show', key: encodeId(String(show).toLowerCase()) }
    }
    // Movies are keyed by file identity — the same string history and
    // qualityFlags use for a movie.
    return { scope: 'movie', key: decoded }
  }

  // The markers the player page should act on, already guarded. `duration` is
  // usually unknown server-side (only the browser knows it), so the absolute
  // guards apply here and the client re-checks against the real duration.
  // Returns the EFFECTIVE markers: viewer-set ones first, auto-detected ones only where the viewers
  // left a gap (see markerModel.effectiveMarkers). `source`/`introSource`/`creditsSource` say which.
  function markersFor(kind, rawId, durationSeconds) {
    const none = () => ({ scope: kind === 'tv' ? 'show' : 'movie', key: '', ...markerModel.EMPTY_EFFECTIVE })
    try {
      const target = markerTargetFor(kind, rawId)
      if (!target) return none()
      const viewer = playbackMarkerFor(store, target.scope, target.key, durationSeconds)
      return { ...effectiveFromViewer(kind, rawId, viewer, durationSeconds), scope: viewer.scope, key: viewer.key }
    } catch {
      return none()
    }
  }

  // Absolute path of a library file from its id (the same walk apiMediaExists does), or null.
  function libraryFileFor(kind, rawId) {
    try {
      const decoded = decodeId(String(rawId || ''))
      if (!decoded) return null
      if (kind === 'tv') {
        const m = scanTvShowsMulti(allTvShowsDirs()).find((f) => f.relPath === decoded)
        return m ? path.join(m.dir, m.relPath) : null
      }
      const m = scanMoviesMulti(allMoviesDirs()).find((x) => x.fileName === decoded)
      return m ? path.join(m.dir, m.fileName) : null
    } catch {
      return null
    }
  }

  function effectiveFromViewer(kind, rawId, viewer, durationSeconds) {
    let auto = null
    if (autoMarkersEnabled()) {
      const file = libraryFileFor(kind, rawId)
      if (file) auto = autoMarkerScanner.lookup(file)
    }
    return markerModel.effectiveMarkers({ viewer, suppress: viewer.autoSuppress, auto, durationSeconds })
  }

  // Shared by POST /markers and POST /api/markers — one definition of what a
  // marker write means. Absent field = leave alone, null = clear, number = set.
  function applyMarkerWrite(body, user) {
    const kind = body && body.kind === 'tv' ? 'tv' : 'movie'
    const target = markerTargetFor(kind, body && body.id)
    if (!target) return { ok: false, error: 'not_found' }
    const has = (k) => body && Object.prototype.hasOwnProperty.call(body, k)
    const result = recordPlaybackMarker(store, {
      scope: target.scope,
      key: target.key,
      introStartSeconds: has('introStartSeconds') ? body.introStartSeconds : undefined,
      introEndSeconds: has('introEndSeconds') ? body.introEndSeconds : undefined,
      creditsStartSeconds: has('creditsStartSeconds') ? body.creditsStartSeconds : undefined,
      durationSeconds: body ? body.durationSeconds : undefined,
      userId: user && user.id,
      userName: (user && user.name) || 'Unknown'
    })
    return { ...result, scope: target.scope, key: target.key }
  }

  // --- Continue Watching / history rows, decorated for rendering ----------
  // Turns history.js rows (which only know fileName/title/kind) into something
  // renderable: encoded id, poster, watch href and stream URL. Cache-only.
  function decorateHistoryRows(rows) {
    const cacheDir = getTmdbCacheDir ? getTmdbCacheDir() : null
    const movieMetaOf = cachedMovieMetaReader(cacheDir)
    const tvMetaOf = cachedTvMetaReader(cacheDir)
    const movieFiles = new Set(scanMoviesMulti(allMoviesDirs()).map((m) => m.fileName))
    const tvFiles = new Set(scanTvShowsMulti(allTvShowsDirs()).map((f) => f.relPath))
    return (rows || []).map((row) => {
      const isTv = row.kind === 'tv'
      const encoded = encodeId(row.fileName)
      let poster = null
      let title = row.title
      if (isTv) {
        const parsedShow = groupKeyAndName(row.fileName, path.basename(row.fileName)).show
        const meta = parsedShow ? tvMetaOf(encodeId(String(parsedShow).toLowerCase())) : null
        if (meta) poster = tvPosterUrl(cacheDir, meta.id, meta.poster_path)
        // Rows logged before the show name came from the folder say "house — S2E11";
        // show them under the library's own name so one show reads as one show.
        const cut = String(title || '').indexOf(' — ')
        const canonical = (meta && meta.name) || parsedShow
        if (cut > 0 && canonical) title = canonical + String(title).slice(cut)
      } else {
        const meta = movieMetaOf(row.fileName)
        if (meta) poster = posterUrl(cacheDir, meta.id, meta.poster_path)
      }
      return {
        ...row,
        title,
        id: encoded,
        poster,
        exists: isTv ? tvFiles.has(row.fileName) : movieFiles.has(row.fileName),
        watchHref: `${isTv ? '/tvwatch' : '/watch'}?id=${encodeURIComponent(encoded)}`,
        stream: `${isTv ? '/tvfile' : '/file'}?id=${encodeURIComponent(encoded)}&mt=${makeMediaToken(store, encoded)}`
      }
    })
  }

  // The Continue list people see: one row per show (history.continueWatchingGrouped),
  // with the show identity and episode order taken from the library itself.
  function continueRowsFor(userId) {
    const cacheDir = getTmdbCacheDir ? getTmdbCacheDir() : null
    const tvMetaOf = cachedTvMetaReader(cacheDir)
    let shows = null
    const showFor = (fileName) => {
      if (!shows) {
        shows = new Map()
        for (const show of apiShowMap().values()) shows.set(history.normaliseShowName(show.name), show)
      }
      const name = groupKeyAndName(fileName, path.basename(fileName)).show
      return name ? shows.get(history.normaliseShowName(name)) || null : null
    }
    return history.continueWatchingGrouped(store, userId, {
      showOf: (row) => {
        const name = groupKeyAndName(row.fileName, path.basename(row.fileName)).show
        const meta = name ? tvMetaOf(encodeId(String(name).toLowerCase())) : null
        return { name, tmdbId: meta && meta.id != null ? meta.id : null }
      },
      episodesOf: (row) => {
        const show = showFor(row.fileName)
        if (!show) return []
        const meta = tvMetaOf(show.key)
        const showName = (meta && meta.name) || show.name
        return show.episodes
          .filter((ep) => ep.season !== null && ep.episode !== null)
          .sort((a, b) => a.season - b.season || a.episode - b.episode)
          .map((ep) => ({ fileName: ep.relPath, title: `${showName} — S${ep.season}E${ep.episode}` }))
      }
    })
  }

  // Shared by POST /history/clear and POST /api/history/clear — one definition
  // of what each scope means. Never throws; an unknown scope removes nothing.
  function applyHistoryClear(userId, body) {
    const scope = String((body && body.scope) || '').toLowerCase()
    try {
      if (scope === 'all') return history.clearAllHistory(store, userId)
      if (scope === 'show') return history.clearHistoryForTitle(store, userId, String((body && body.title) || ''))
      if (scope === 'one') return history.clearHistoryEntry(store, userId, String((body && body.fileName) || ''))
    } catch {
      return 0
    }
    return 0
  }

  // ?t=<seconds> on /watch and /tvwatch — the Continue Watching Resume link.
  function seekParam(raw) {
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? n : null
  }

  // --- one credential path for both front doors ---------------------------
  // Extracted verbatim out of the website's POST /login handler so the phone
  // app's POST /api/login goes through the EXACT same checks: IP lockout,
  // the "admin" username probe alert, failed-login recording + alert email,
  // clearFailedLogin/touchLastSeen on success. There is deliberately no second
  // copy of the credential check anywhere — both callers land here.
  // Returns { ok:true, user } or { ok:false, reason, error, minutesRemaining? }
  // where `error` is the exact message the login page has always shown.
  // One wrong sign-in step (password or second-step code): count it against the per-address,
  // per-username and server-wide limits, and send the "N failed attempts" alert when it is due.
  function noteFailedSignIn(ip, username) {
    const failInfo = auth.recordFailedLogin(store, { ip, username })
    if (failInfo.shouldAlert) {
      const adminEmail = adminNotifyTo(store)
      if (adminEmail) {
        mailer
          .sendMail(store, {
            to: adminEmail,
            subject: `Beebo Entertainment: ${failInfo.alertCount} failed login attempts`,
            text: `Your Beebo Entertainment login page has had ${failInfo.alertCount} failed login attempts since the last alert.\n\nMost recent one was from IP ${ip || 'unknown'} using username "${username || ''}" at ${new Date().toLocaleString()}.\n\nCheck the Admin tab in the app for the full failed-login history and current lockouts.`
          })
          .catch(() => {})
      }
    }
    return failInfo
  }

  const heldLogAt = new Map() // userId -> when "held at two-factor set-up" was last logged
  // The forms anyone can post without signing in (ask for access, "forgot my code", "forgot my password") send
  // mail, rewrite someone's access code or grow config.json. Five an hour per address, and five an hour for one
  // e-mail address, are plenty for a person and stop a stranger rotating someone's code or filling an inbox.
  const anonFormLimiter = titleRequests.createRateLimiter({ limit: 5, windowMs: 60 * 60 * 1000 })
  const MAX_PENDING_ACCESS_REQUESTS = 100
  function anonFormAllowed(ip, kind, email) {
    if (!anonFormLimiter.hit(`${kind}|ip|${ip || 'unknown'}`).ok) return false
    const mail = String(email || '').trim().toLowerCase().slice(0, 200)
    return !mail || anonFormLimiter.hit(`${kind}|mail|${mail}`).ok
  }
  // 60 strength checks a minute per address.
  const strengthHits = new Map()
  function strengthCheckAllowed(ip) {
    const now = Date.now()
    const key = ip || 'unknown'
    const hits = (strengthHits.get(key) || []).filter((t) => now - t < 60000)
    if (hits.length >= 60) { strengthHits.set(key, hits); return false }
    hits.push(now)
    strengthHits.set(key, hits)
    if (strengthHits.size > 2000) for (const [k, v] of strengthHits) if (!v.length || now - v[v.length - 1] > 60000) strengthHits.delete(k)
    return true
  }

  const lockedMessage = (lockout) => {
    const mins = `${lockout.minutesRemaining} minute${lockout.minutesRemaining === 1 ? '' : 's'}`
    return lockout.scope === 'account'
      ? `Too many failed attempts for this username — try again in ${mins}.`
      : lockout.scope === 'global'
        ? `Too many failed sign-in attempts right now — try again in ${mins}.`
        : `Too many failed attempts from this connection — try again in ${mins}.`
  }

  const knownUsername = (username) => {
    const uname = auth.normalizeUsername(username)
    return !!uname && auth.getUsers(store).some((u) => u.username === uname)
  }

  // The second step: a right password for a person with two-factor on earns nothing but the chance
  // to send a code. Checked against the same address / username / server-wide limits as the password
  // (BEFORE the code is looked at), then against that person's own fixed-key second-step lock in
  // twoFactor.js, so guessing six digits is stopped whichever addresses the guesses come from.
  function completeSecondFactor({ ip, user, code, method = 'password' }) {
    const lockout = auth.checkLockout(store, ip, user.username)
    if (lockout.locked) {
      securityLog.record(store, { type: 'login_locked', userId: user.id, username: user.username, known: true, ip, detail: `${lockout.scope} lock, second step` })
      return { ok: false, reason: 'locked', minutesRemaining: lockout.minutesRemaining, error: lockedMessage(lockout) }
    }
    const check = twoFactor.verifyCode(store, user.id, code, { ip })
    if (!check.ok) {
      if (check.error === 'locked') {
        return {
          ok: false, reason: 'locked', minutesRemaining: check.minutesRemaining,
          error: `Too many wrong codes — two-step sign-in is locked for ${check.minutesRemaining} minute${check.minutesRemaining === 1 ? '' : 's'}.`
        }
      }
      const failInfo = noteFailedSignIn(ip, user.username)
      return {
        ok: false,
        reason: failInfo.justLocked || check.justLocked ? 'locked' : 'bad_code',
        error: check.justLocked
          ? `Too many wrong codes — two-step sign-in is locked for ${check.minutesRemaining} minute${check.minutesRemaining === 1 ? '' : 's'}.`
          : check.error === 'code_reused'
            ? 'That code was already used. Wait for your app to show the next one.'
            : 'That code is not right. Try the newest code, or a recovery code.'
      }
    }
    auth.clearFailedLogin(store, ip)
    auth.touchLastSeen(store, user.id, ip)
    securityLog.record(store, { type: 'two_factor_success', userId: user.id, username: user.username, known: true, ip, detail: check.method === 'recovery' ? 'recovery code' : 'authenticator code' })
    securityLog.record(store, { type: 'login_success', userId: user.id, username: user.username, known: true, ip, detail: 'password + second step' })
    return { ok: true, user, method: check.method === 'recovery' ? 'two_factor_recovery' : 'two_factor', recoveryRemaining: check.recoveryRemaining }
  }

  async function attemptLogin({ ip, username, password, code }) {
    // Checked BEFORE the submitted credentials matter — a locked-out IP is
    // rejected outright, so someone mid-brute-force can't keep guessing during
    // their 5-minute timeout.
    // Per IP, per username (guessing from many addresses) and server-wide —
    // see auth.checkLockout.
    const lockout = auth.checkLockout(store, ip, username)
    if (lockout.locked) {
      securityLog.record(store, { type: 'login_locked', username, known: knownUsername(username), ip, detail: `${lockout.scope} lock` })
      return {
        ok: false,
        reason: 'locked',
        minutesRemaining: lockout.minutesRemaining,
        error: lockedMessage(lockout)
      }
    }

    const user = auth.findUserByUsernameAndSecret(store, username, password)

    // Real usernames here are auto-generated (nick, samplehouse86, ryan, …) —
    // nobody legitimately has "admin" as their login. Someone typing it is
    // almost always probing the login page, so this gets logged AND emailed
    // immediately (not just left to show up next time the Users tab is
    // opened), whether or not the login actually succeeded.
    if (typeof username === 'string' && username.trim().toLowerCase() === 'admin') {
      auth.logAdminUsernameAttempt(store, { ip, success: !!user })
      const adminEmail = adminNotifyTo(store)
      if (adminEmail) {
        mailer
          .sendMail(store, {
            to: adminEmail,
            subject: 'Beebo Entertainment: login attempt using username "admin"',
            text: `Someone just tried logging in with the username "admin" from IP ${ip || 'unknown'} at ${new Date().toLocaleString()}.\n\n${
              user
                ? 'This one succeeded — you have a real account using that username, so this may be you or someone you gave access to.'
                : "This one failed (wrong/no code) — most likely someone probing your login page, since real accounts here don't use \"admin\" as a username."
            }\n\nCheck the Users tab in the app for the full history of these attempts.`
          })
          .catch(() => {})
      }
    }

    if (!user) {
      const failInfo = noteFailedSignIn(ip, username)
      securityLog.record(store, { type: 'login_failed', username, known: knownUsername(username), ip })
      if (failInfo.justLocked) securityLog.record(store, { type: 'login_locked', username, known: knownUsername(username), ip, detail: 'address locked' })
      return {
        ok: false,
        reason: failInfo.justLocked ? 'locked' : 'bad_credentials',
        error: failInfo.justLocked
          ? `Too many failed attempts from this connection — locked out for ${failInfo.lockoutDurationMinutes} minute${
              failInfo.lockoutDurationMinutes === 1 ? '' : 's'
            }.`
          : 'That username/password combination is invalid, expired, or has been revoked.'
      }
    }

    // Right password, but this person has two-factor on. The password alone is NOT a sign-in: it
    // only earns a short-lived challenge to send a code back with. The failed-attempt counters are
    // deliberately not cleared here (only a finished sign-in clears them), or an attacker holding the
    // password could reset the per-address count between batches of code guesses.
    if (twoFactor.isEnabled(user)) {
      if (code !== undefined && code !== null && String(code) !== '') return completeSecondFactor({ ip, user, code })
      securityLog.record(store, { type: 'two_factor_required', userId: user.id, username: user.username, known: true, ip })
      return {
        ok: false,
        reason: 'two_factor_required',
        error: 'Enter the 6-digit code from your authenticator app.',
        challenge: twoFactor.issueChallenge(store, user.id),
        user: { id: user.id, username: user.username }
      }
    }

    auth.clearFailedLogin(store, ip)
    auth.touchLastSeen(store, user.id, ip)
    securityLog.record(store, { type: 'login_success', userId: user.id, username: user.username, known: true, ip })
    return { ok: true, user, method: 'password' }
  }

  // The website's and the phone app's sessions are minted here so both are listed and revocable.
  const userAgentOf = (req) => String((req && req.headers && req.headers['user-agent']) || '').slice(0, 300)
  const issueWebSession = (req, userId, method) =>
    auth.signSession(store, userId, { track: true, ip: getClientIp(req), userAgent: userAgentOf(req), method })
  // HttpOnly + SameSite=Lax always; Secure whenever the client is on TLS, directly or through a proxy
  // that says so (httpSecurity.buildCookie). Same cookie name and 365-day life as before: sign-outs are
  // handled by the tracked-session list (authSessions), not by a short cookie.
  const sessionCookieHeader = (req, value) => httpSecurity.buildCookie(req, SESSION_COOKIE, value, { maxAge: 365 * 24 * 60 * 60 })
  const issueApiToken = (req, userId, method) =>
    makeApiToken(store, userId, API_TOKEN_DAYS, { track: true, ip: getClientIp(req), userAgent: userAgentOf(req), method })
  // A person whose owner requires two-factor for admins, and has none yet, cannot use the phone app
  // (it has no set-up screen): they set it up on the website first.
  const setupHeldAnswer = (user) => ({
    ok: false,
    error: 'two_factor_setup_required',
    message: 'The owner of this server requires two-factor for admins. Sign in on the website first and turn it on under Account security.',
    user: { id: user.id, username: user.username }
  })
  const accountSecurity = require('./accountSecurityApi').create({ store })

  // --- shared bad-quality flag target resolution --------------------------
  // Turns a (kind, encoded id) pair into the real file path + display title,
  // exactly the way /file and /tvfile resolve ids. Used by the website's
  // "⚠️ Bad quality" button (POST /flag-quality) and the phone app's
  // POST /api/flag-quality, so both write identical 'qualityFlags' entries.
  async function resolveFlagTarget(kind, rawId) {
    let decoded = ''
    try {
      decoded = decodeId(String(rawId || ''))
    } catch {
      decoded = ''
    }
    let filePath = null
    let title = ''
    if (decoded && kind === 'tv') {
      const files = scanTvShowsMulti(allTvShowsDirs())
      const match = files.find((f) => f.relPath === decoded)
      if (match) filePath = path.join(match.dir, match.relPath)
      // Same best-effort title /tvwatch shows, falling back to the raw path
      const parsed = parseEpisode(path.basename(decoded))
      title = parsed ? `${parsed.show}${parsed.season !== null ? ` — S${parsed.season}E${parsed.episode}` : ''}` : decoded
    } else if (decoded) {
      const movies = scanMoviesMulti(allMoviesDirs())
      const movie = movies.find((m) => m.fileName === decoded)
      if (movie) filePath = path.join(movie.dir, movie.fileName)
      // Same best-effort title /watch shows (cached TMDB lookup, else cleaned filename)
      const key = store.get('tmdbApiKey') || process.env.TMDB_API_KEY
      const cacheDir = getTmdbCacheDir ? getTmdbCacheDir() : null
      let tmdb = null
      try {
        tmdb = await tmdbLookup(decoded, key, cacheDir, store)
      } catch {
        tmdb = null
      }
      title = tmdb?.title || cleanTitle(decoded)
    }
    return { decoded, filePath, title }
  }

  // ==========================================================================
  // JSON API for the native phone app — /api/* (see spec/api-contract.md)
  // ==========================================================================
  // Handled BEFORE the website's cookie session gate so an /api/* request can
  // never be answered with HTML or a 302 to /login (a native client can't
  // follow either). Auth here is an Authorization: Bearer <token> header, not
  // a cookie; the cookie session logic below is untouched.

  function ownsWatchSession(userId, sessionId) {
    if (!userId || typeof sessionId !== 'string') return false
    return [...history.getHistory(store), ...history.getPendingSessions(store)].some(row => row && row.sessionId === sessionId && row.userId === userId)
  }

  function saveViewingPrivacy(req, user, body) {
    if (!user || user.guest) return { status: 403, body: { ok: false, error: 'adult_profile_required' } }
    const ip = getClientIp(req)
    const locked = auth.checkLockout(store, ip, user.username, { trustLastSeenIp: false })
    if (locked.locked) return { status: 429, body: { ok: false, error: 'locked', message: 'Too many attempts. Wait a few minutes before trying again.' } }
    const out = viewingPrivacy.setPreference(store, user.id, body)
    if (!out.ok) {
      if (out.error === 'wrong_password') auth.recordFailedLogin(store, { ip, username: user.username })
      return { status: out.error === 'bad_request' ? 400 : out.error === 'wrong_password' ? 401 : 403, body: out }
    }
    return { status: 200, body: out }
  }

  const API_VERSION = 1

  function apiSend(req, res, status, obj) {
    let payload
    try {
      payload = JSON.stringify(obj)
    } catch {
      payload = '{"ok":false,"error":"server_error"}'
    }
    const buf = Buffer.from(payload, 'utf8')
    // Big lists go out gzipped when the client asks for it (compressJson.js); everyone else gets the same bytes as ever.
    // (Only a real HTTP response is compressed: an in-process caller, like the Jellyfin mode, reads the plain JSON itself.)
    compressJson.gzipIfWorthIt(res instanceof http.ServerResponse ? req : null, buf, (gz) => {
      const body = gz || buf
      if (res.destroyed || res.writableEnded) return
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
        ...(gz ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {})
      })
      // HEAD gets the exact headers a GET would, with no body.
      if ((req.method || 'GET').toUpperCase() === 'HEAD') res.end()
      else res.end(body)
    })
  }

  // Accepts a JSON body (what the contract specifies) and, defensively, a
  // form-encoded one. Never throws — a broken body is simply an empty object,
  // which the individual handlers then reject with a JSON error.
  // Read once: the content gate may look at a body's ids before the route reads it.
  async function apiReadBody(req) {
    if (req && req.__beeboApiBody !== undefined) return req.__beeboApiBody
    const body = await apiReadBodyOnce(req)
    try { req.__beeboApiBody = body } catch {}
    return body
  }
  async function apiReadBodyOnce(req) {
    let raw = ''
    try {
      const chunks = []
      // The owner's migration importer takes an uploaded export inside the JSON body (up to 200 MB, refused
      // on Content-Length before it gets here); everything else is small JSON.
      const limit = /^\/api\/admin\/migration(\/|\?|$)/.test(String(req.url || '')) ? 200 * 1024 * 1024 : API_BODY_LIMIT
      for await (const chunk of cappedBody(req, limit)) chunks.push(chunk)
      raw = Buffer.concat(chunks).toString('utf8')
    } catch {
      return {}
    }
    if (!raw.trim()) return {}
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      // fall through to form-encoded
    }
    try {
      return Object.fromEntries(new URLSearchParams(raw))
    } catch {
      return {}
    }
  }

  // `restricted` (parental controls on) and `guest` (someone else's household, through a share)
  // are only present when true, so older apps see exactly the shape they always did.
  const apiUserShape = (u) => {
    const restricted = !u.guest && parental.isRestricted(parental.getPolicy(store, u.id))
    return {
      id: u.id,
      name: u.name || '',
      isAdmin: !!u.isAdmin && !restricted && !u.guest,
      adult: u.adult === true, viewingHistoryPrivate: u.viewingHistoryPrivate === true,
      ...(restricted ? { restricted: true } : {}),
      ...(u.guest ? { guest: true } : {}),
    }
  }

  // `poster` and `stream` are contractually SERVER-RELATIVE (the app prefixes
  // its own base URL), so a TMDB CDN URL — what posterUrl() falls back to when
  // the on-disk poster cache hasn't got this one — becomes null rather than an
  // absolute URL the app would mangle into "http://host:47811https://…".
  const serverRelative = (p) => (typeof p === 'string' && p.startsWith('/') ? p : null)

  // [{id,name,count}] for the genres actually present in a library, named and
  // ordered exactly like the website's genre chip row.
  function apiGenreList(counts, genreNames) {
    return Object.entries(genreNames)
      .filter(([id]) => counts.get(Number(id)))
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([id, name]) => ({ id: Number(id), name, count: counts.get(Number(id)) }))
  }

  const apiGenreParam = (raw) => {
    const n = Number(raw)
    return raw !== null && raw !== '' && Number.isFinite(n) ? n : null
  }
  const apiSearchParam = (raw) => String(raw || '').trim().toLowerCase()

  const movieStreamPath = (id) => `/file?id=${encodeURIComponent(id)}&mt=${makeMediaToken(store, id)}`
  const tvStreamPath = (id) => `/tvfile?id=${encodeURIComponent(id)}&mt=${makeMediaToken(store, id)}`

  // --- cached cast, shared by /api/credits and the ?actor= list filters ----
  // Reads the SAME maps castStripHtml renders the website's ℹ️ overlay from —
  // credits.json for movies, tv-credits.json for shows — one file read per
  // request, never a TMDB call. Returns a lookup by that title's TMDB id.
  function cachedCreditsReader(kind) {
    const cacheDir = getTmdbCacheDir ? getTmdbCacheDir() : null
    let map = {}
    try {
      map = cacheDir ? (kind === 'tv' ? tmdbFileCache.getTvCreditsMap(cacheDir) : tmdbFileCache.getCreditsMap(cacheDir)) : {}
    } catch {
      map = {}
    }
    return (tmdbId) => {
      if (tmdbId === null || tmdbId === undefined || tmdbId === '') return []
      // Same in-memory fallback the website's movie cards use, so a title
      // looked up this session but not yet written to disk still has cast.
      const found = map[tmdbId] || map[String(tmdbId)] || (kind === 'tv' ? null : creditsCache.get(tmdbId)) || []
      return Array.isArray(found) ? found : []
    }
  }

  // Contract shape for one cast member. `profile` is SERVER-RELATIVE or null —
  // never a TMDB CDN URL (the app prefixes its own base URL onto it).
  function apiCastShape(cast) {
    const cacheDir = getTmdbCacheDir ? getTmdbCacheDir() : null
    return (Array.isArray(cast) ? cast : [])
      .filter((c) => c && c.name)
      .slice(0, 8)
      .map((c) => ({
        id: c.id != null ? c.id : null,
        name: String(c.name),
        character: c.character || c.role ? String(c.character || c.role) : null,
        profile: serverRelative(actorPhotoUrl(cacheDir, c.id, c.profilePath || c.profile_path || null))
      }))
  }

  // ?actor=<tmdb person id> -> a number, or null for "no filter" (so a junk
  // value degrades to the unfiltered list rather than an error).
  const apiActorParam = (raw) => {
    if (raw === null || raw === undefined || raw === '') return null
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  }
  const castHasPerson = (cast, personId) =>
    (Array.isArray(cast) ? cast : []).some((c) => c && Number(c.id) === personId)

  // --- Playlists -------------------------------------------------------------
  // playlists.js (storage, rules, who may do what), playlistCatalog.js (the
  // library as rule-ready items) and playlistApi.js (the one HTTP contract).
  // /api/playlists/* (phone, bearer token) and /playlists/api/* (website, cookie
  // session) both end in playlistHandle(), so they cannot drift apart.
  //
  // The catalog is cached for a minute and rebuilt sooner when the library's
  // shape changes; everything personal (watched, watchlist ...) is read fresh
  // on every request, so a mark made a second ago is already in a smart list.
  let playlistCatalogMemo = { at: 0, sig: '', value: null }
  function playlistLibrary() {
    const movies = scanMoviesMulti(allMoviesDirs())
    const tvFiles = scanTvShowsMulti(allTvShowsDirs())
    const cacheDir = getTmdbCacheDir ? getTmdbCacheDir() : null
    let histLen = 0
    let recent = []
    try { histLen = (store.get('watchHistory') || []).length } catch {}
    try { recent = store.get('recentlyAdded') || [] } catch {}
    const musicStatus = musicLib.status()
    const sig = [movies.length, tvFiles.length, histLen, recent.length, cacheDir || '', musicStatus.trackCount, musicStatus.lastScanAt].join('|')
    const now = Date.now()
    if (playlistCatalogMemo.value && playlistCatalogMemo.sig === sig && now - playlistCatalogMemo.at < 60 * 1000) {
      return playlistCatalogMemo.value
    }
    const movieMetaOf = cachedMovieMetaReader(cacheDir)
    const tvMetaOf = cachedTvMetaReader(cacheDir)
    const qualityCache = loadQualityCache(cacheDir)
    try { ensureCollectionsLoaded(cacheDir) } catch {}
    const addedAt = new Map()
    for (const r of Array.isArray(recent) ? recent : []) {
      if (r && r.path && r.addedAt) addedAt.set(path.resolve(r.path), Number(r.addedAt) || 0)
    }
    const movieCast = cachedCreditsReader('movie')
    const tvCast = cachedCreditsReader('tv')
    const castShape = (list) => (Array.isArray(list) ? list : []).filter((c) => c && c.name).map((c) => ({ id: c.id != null ? c.id : null, name: String(c.name) }))
    let durations = new Map()
    try { durations = playlistCatalog.durationsFromHistory(store.get('watchHistory') || []) } catch {}
    const catalogItems = playlistCatalog.buildCatalog({
      movies: movies.map((m) => ({ id: encodeId(m.fileName), fileName: m.fileName, fullPath: path.join(m.dir, m.fileName), size: m.size, mtimeMs: m.mtimeMs })),
      tvFiles: tvFiles.map((f) => {
        const { show, year } = groupKeyAndName(f.relPath, f.fileName)
        const parsed = parseEpisode(f.fileName)
        return {
          id: encodeId(f.relPath), relPath: f.relPath, fileName: f.fileName, fullPath: path.join(f.dir, f.relPath),
          size: f.size, mtimeMs: f.mtimeMs, showKey: encodeId(String(show || '').toLowerCase()), showName: show, showYear: year,
          season: parsed.season, episode: parsed.episode
        }
      }),
      movieMeta: movieMetaOf,
      tvMeta: tvMetaOf,
      genreNames: { movie: GENRE_NAMES_MOVIE, tv: GENRE_NAMES_TV },
      qualityOf: (full, stat) => qualityTierFor(qualityCache, full, stat),
      addedAtOf: (full) => addedAt.get(path.resolve(full)) || 0,
      collectionOf: (tmdbId) => {
        const col = movieCollectionCache.get(String(tmdbId))
        return col && col.id != null ? { id: col.id, name: col.name } : null
      },
      castOf: (kind, tmdbId) => castShape(kind === 'tv' ? tvCast(tmdbId) : movieCast(tmdbId)),
      durations,
      movieTitle: (fileName, meta) => (meta && meta.title) || cleanTitle(fileName),
      parsedMovieYear: (fileName) => Number(parseMovieTitle(fileName).year) || null,
      tracks: musicLib.trackList()
    })
    const value = { catalog: catalogItems, index: playlistCatalog.indexCatalog(catalogItems), cacheDir }
    playlistCatalogMemo = { at: now, sig, value }
    return value
  }

  function playlistContext(viewer) {
    const userId = viewer.id
    const safe = (fn, fallback) => { try { return fn() } catch { return fallback } }
    return playlistCatalog.buildViewerContext({
      watchedFiles: safe(() => watchedState.userFiles(store, userId), {}),
      resumable: safe(() => history.continueWatching(store, userId), []),
      continueRows: safe(() => continueRowsFor(userId), []),
      viewed: safe(() => history.viewedHistory(store, userId), []),
      watchlist: safe(() => { const a = (store.get('watchlist') || {})[userId]; return Array.isArray(a) ? a : [] }, []),
      flags: safe(() => (store.get('libraryFlags') || {})[userId] || {}, {}),
      now: Date.now()
    })
  }

  // Poster + signed stream for one catalog item. Server-relative, like every /api list.
  function playlistDecorate(item) {
    if (item.type === 'track') {
      // Cover art is addressed by a hash of its own bytes (musicApi.js), so it
      // needs no token; the song itself needs the same signed media token the
      // Music tab's stream links carry.
      return {
        poster: item.coverId ? `/api/music/cover/${item.coverId}` : null,
        stream: `/api/music/track/${encodeURIComponent(item.id)}/stream?mt=${encodeURIComponent(musicHttp.tokenFor(item.id))}`
      }
    }
    const cacheDir = playlistCatalogMemo.value ? playlistCatalogMemo.value.cacheDir : (getTmdbCacheDir ? getTmdbCacheDir() : null)
    let poster = null
    try {
      if (item.tmdbId != null) {
        poster = item.type === 'episode' ? tvPosterUrl(cacheDir, item.tmdbId, item.posterPath) : posterUrl(cacheDir, item.tmdbId, item.posterPath)
      }
    } catch {}
    return {
      poster: serverRelative(poster),
      stream: item.type === 'episode' ? tvStreamPath(item.id) : movieStreamPath(item.id)
    }
  }

  // PARENTAL-CONTROLS SEAM. The one place a playlist asks "may this person see
  // this title?" - smart results, manual playlists and playback all go through
  // it. null means no filtering. A per-person rating filter only has to be
  // passed to startStreamServer as `playlistItemFilter: (viewer) => (item) => boolean`
  // (or replace the body here). Items carry certification, rating, type,
  // genres, showKey and title.
  function playlistAllow(viewer) {
    if (typeof playlistItemFilter !== 'function') return null
    try {
      return playlistItemFilter(viewer) || null
    } catch {
      return null
    }
  }

  function playlistHandle(method, subPath, query, body, user) {
    return playlistApi.handle(
      { method, path: subPath, query, body, viewer: { id: user.id, isAdmin: !!user.isAdmin, name: user.name || '' } },
      {
        store,
        catalog: playlistLibrary,
        context: playlistContext,
        decorate: playlistDecorate,
        allow: playlistAllow,
        userName: (id) => {
          const u = auth.getUsers(store).find((x) => x.id === id)
          return u ? u.name || u.username || null : null
        }
      }
    )
  }

  // --- Migration importer -----------------------------------------------------
  // migrationImport.js reads another product's data (Plex, Jellyfin, Emby, Kodi, Letterboxd), matches
  // it to this library and writes watched marks, resume points, ratings, favourites, watchlist and
  // playlists, with a dry run and an undo. migrationApi.js is the owner-only contract; the desktop
  // window reaches it over IPC (main.js 'migration:call') and an admin token over TLS reaches it at
  // /api/admin/migration/*. The library it matches against is the same flat catalog playlists use.
  const migrationGrants = new Map() // grantId -> { path, expires }; made only by the desktop file dialog
  let migrationImporterMemo = null
  function migrationImporter() {
    if (migrationImporterMemo) return migrationImporterMemo
    migrationImporterMemo = require('./migrationImport').createImporter({
      store,
      journalDir: migrationDir || undefined,
      users: () => auth.getUsers(store),
      library: () => {
        const lib = playlistLibrary()
        // The file names may carry an IMDb id ("Film (1999) [tt0133093].mkv"): give it to the matcher.
        return { catalog: lib.catalog.map((it) => {
          if (it.type !== 'movie') return it
          let imdbId
          try { imdbId = parseMovieTitle(it.fileName).imdbId || undefined } catch {}
          return imdbId ? { ...it, imdbId } : it
        }) }
      },
      libraryRoots: () => [...allMoviesDirs(), ...allTvShowsDirs()],
      resolveGrant: (id) => {
        const g = migrationGrants.get(String(id))
        if (!g) return null
        if (g.expires < Date.now()) { migrationGrants.delete(String(id)); return null }
        return g.path
      },
      tmdbApi: () => titleMatch.createTmdbApi(store.get('tmdbApiKey') || process.env.TMDB_API_KEY),
      log
    })
    return migrationImporterMemo
  }
  async function migrationHandle(method, subPath, query, body, user, transport) {
    await primeLibrary('both')
    return require('./migrationApi').handle(
      { method, path: subPath, query, body, transport, viewer: { id: user.id, isAdmin: !!user.isAdmin, name: user.name || '' } },
      { importer: migrationImporter }
    )
  }

  // One film in the /api/movies contract shape. Shared with /api/collections/<id>,
  // whose owned parts are exactly these items, so a film plays the same way
  // from either list.
  function apiMovieItem(m, meta, collection, { cacheDir, qualityCache, recentlyAdded, images }) {
    const full = path.join(m.dir, m.fileName)
    const tmdbYear = Number(String(meta?.release_date || '').slice(0, 4))
    const parsedYear = Number(parseMovieTitle(m.fileName).year)
    const year = Number.isFinite(tmdbYear) && tmdbYear ? tmdbYear : Number.isFinite(parsedYear) && parsedYear ? parsedYear : null
    const addedAt = recentlyAdded.get(path.resolve(full)) || 0
    return {
      addedAt,
      item: {
        id: m.id,
        title: meta?.title || m.name,
        year,
        poster: serverRelative(meta ? posterUrl(cacheDir, meta.id, meta.poster_path, images) : null),
        // No local caching (unlike the poster): a detail page is the only place this is
        // needed, and it only ever gets used with internet available already (this is a
        // direct TMDB CDN URL, the same tradeoff /api/tvshows and the trailer button make).
        backdrop: backdropUrl(meta?.backdrop_path),
        voteAverage: typeof meta?.vote_average === 'number' ? meta.vote_average : null,
        quality: qualityTierFor(qualityCache, full),
        genres: Array.isArray(meta?.genre_ids) ? meta.genre_ids.slice() : [],
        overview: meta?.overview || null,
        isNew: !!addedAt,
        // Franchise badge, so the app can render it without one request per
        // poster. Both null for a standalone film (or an unlooked-up one).
        collectionName: collection ? collection.name || null : null,
        collectionId: collection ? collection.id : null,
        // TMDB movie id, for the phone's ▶ trailer button. Null when unmatched.
        tmdbId: meta && meta.id != null ? meta.id : null,
        stream: movieStreamPath(m.id)
      }
    }
  }

  // --- GET /api/movies ----------------------------------------------------
  // Cache-only: genres/titles/posters come from the offline TMDB manifest (plus
  // whatever the in-memory lookup cache already holds) and quality from the
  // ffprobe cache. No TMDB network call happens here, so a 2000-title library
  // still answers instantly.
  function apiMovies(url) {
    const cacheDir = getTmdbCacheDir ? getTmdbCacheDir() : null
    const metaOf = cachedMovieMetaReader(cacheDir)
    const qualityCache = loadQualityCache(cacheDir)
    const recentlyAdded = getRecentlyAddedMap(store)
    const images = tmdbFileCache.localImageIndex(cacheDir) // one folder listing instead of an existsSync per poster
    const allMovies = scanMoviesMulti(allMoviesDirs())
    const versionGroups = groupMovieList(allMovies, cacheDir).groupOfFile
    const movies = allMovies.filter((m) => { const g = versionGroups.get(m.fileName); return !g || g.primary === m })
    // Franchise badge data — already-cached collections.json only (the same map
    // the website's Sequels view and the 🔗 poster chip read). No new TMDB
    // calls: a movie whose collection hasn't been looked up yet simply reports
    // null/null instead of holding up the list.
    ensureCollectionsLoaded(cacheDir)
    const collectionOf = (metaId) => {
      if (metaId === null || metaId === undefined) return null
      const col = movieCollectionCache.get(String(metaId))
      return col && col.id != null ? col : null
    }

    const rows = movies.map((m) => {
      const meta = metaOf(m.fileName, m.dir)
      const collection = meta && meta.custom_collection !== undefined ? meta.custom_collection : collectionOf(meta?.id)
      const { item, addedAt } = apiMovieItem(m, meta, collection, { cacheDir, qualityCache, recentlyAdded, images })
      const versions = movieVersions.publicVersions(versionGroups.get(m.fileName))
      if (versions) item.versions = versions
      return {
        meta,
        addedAt,
        fileName: m.fileName,
        collectionId: collection ? collection.id : null,
        item
      }
    })

    // Genre counts describe the WHOLE library (so the app can keep showing every
    // chip while a filter is active), same as the website's chip row.
    const genres = apiGenreList(countGenres(rows.map((r) => r.meta)), GENRE_NAMES_MOVIE)

    const genre = apiGenreParam(url.searchParams.get('genre'))
    const q = apiSearchParam(url.searchParams.get('q'))
    const actor = apiActorParam(url.searchParams.get('actor'))
    let list = rows
    if (genre !== null) list = list.filter((r) => hasGenre(r.meta?.genre_ids, genre))
    if (q) list = list.filter((r) => r.item.title.toLowerCase().includes(q) || r.fileName.toLowerCase().includes(q))
    // Cache-only cast filter — an actor with nothing cached simply narrows to
    // an empty list, exactly like a genre nothing matches.
    if (actor !== null) {
      const castOf = cachedCreditsReader('movie')
      list = list.filter((r) => castHasPerson(castOf(r.meta?.id), actor))
    }
    // ?collection=<tmdb collection id> — tapping the franchise badge. Same
    // "junk value = no filter" rule as ?actor=.
    const collectionFilter = apiActorParam(url.searchParams.get('collection'))
    if (collectionFilter !== null) list = list.filter((r) => r.collectionId === collectionFilter)

    const sortKey = (r) => (r.meta && r.meta.sort_title) || r.item.title
    const byTitle = (a, b) => TITLE_COLLATOR.compare(sortKey(a), sortKey(b))
    const sort = url.searchParams.get('sort') || 'title'
    if (sort === 'year') list = list.slice().sort((a, b) => (b.item.year || 0) - (a.item.year || 0) || byTitle(a, b))
    else if (sort === 'new') list = list.slice().sort((a, b) => b.addedAt - a.addedAt || byTitle(a, b))
    else list = list.slice().sort(byTitle)

    return { ok: true, genres, items: list.map((r) => r.item) }
  }

  // --- GET /api/collections, GET /api/collections/<id> --------------------
  // The phone's Collections screen and one franchise's page. Built from the
  // same cached collections.json the website's Sequels view renders from, and
  // grouped by the same collections.groupFranchises, so both surfaces agree on
  // order and counts. The library side is the primed catalog walk (these
  // routes are in API_LIBRARY_ROUTES), so nothing here walks a folder on the
  // main thread and nothing here waits on TMDB: films nobody has checked for a
  // collection yet are looked up in the background, at most 40 per ten
  // minutes, and appear on a later visit.
  const COLLECTIONS_MEMO_MS = 60 * 1000
  const COLLECTIONS_REFRESH_EVERY_MS = 10 * 60 * 1000
  let collectionsMemo = null
  let collectionsRefreshing = false
  let collectionsRefreshedAt = 0

  // Library films keyed by String(TMDB id) -> { m, meta }; the first file wins
  // when two copies of one film are on disk.
  function ownedMoviesByTmdbId(cacheDir) {
    const metaOf = cachedMovieMetaReader(cacheDir)
    const owned = new Map()
    for (const m of collapseMovieVersions(scanMoviesMulti(allMoviesDirs()), cacheDir)) {
      const meta = metaOf(m.fileName)
      if (!meta || meta.id === null || meta.id === undefined) continue
      const k = String(meta.id)
      if (!owned.has(k)) owned.set(k, { m, meta })
    }
    return owned
  }

  // The grouping, memoised for a minute and thrown away as soon as the owned
  // set or the collection cache changes.
  function collectionsSnapshot() {
    const cacheDir = getTmdbCacheDir ? getTmdbCacheDir() : null
    ensureCollectionsLoaded(cacheDir)
    const owned = ownedMoviesByTmdbId(cacheDir)
    const sig = crypto
      .createHash('sha1')
      .update(`${cacheDir || ''}|${movieCollectionCache.size}|${[...owned.keys()].sort().join(',')}`)
      .digest('hex')
    const now = Date.now()
    if (collectionsMemo && collectionsMemo.sig === sig && now - collectionsMemo.at < COLLECTIONS_MEMO_MS) return collectionsMemo
    const franchises = collections.groupFranchises(owned.keys(), (id) => movieCollectionCache.get(String(id)))
    const unchecked = [...owned.keys()].filter((id) => !movieCollectionCache.has(id)).length
    collectionsMemo = { sig, at: now, cacheDir, owned, franchises, unchecked }
    return collectionsMemo
  }

  function refreshCollectionsInBackground(snap) {
    const key = store.get('tmdbApiKey') || process.env.TMDB_API_KEY
    if (!key || !snap.cacheDir || collectionsRefreshing || !snap.unchecked) return false
    if (Date.now() - collectionsRefreshedAt < COLLECTIONS_REFRESH_EVERY_MS) return false
    collectionsRefreshing = true
    collectionsRefreshedAt = Date.now()
    const ids = [...snap.owned.keys()].filter((id) => !movieCollectionCache.has(id)).slice(0, TMDB_PAGE_LOOKUP_CAP)
    mapWithConcurrency(ids, TMDB_LOOKUP_CONCURRENCY, async (id) => {
      const collection = await fetchMovieCollection(id, key)
      if (collection === undefined) return false // failed: not cached, retried later
      movieCollectionCache.set(String(id), collection)
      return true
    })
      .then((results) => {
        if (results.some(Boolean)) {
          persistJsonMap(collectionsCacheFile(snap.cacheDir), movieCollectionCache)
          collectionsMemo = null
        }
      })
      .catch(() => {})
      .finally(() => {
        collectionsRefreshing = false
      })
    return true
  }

  const yearOfDate = (d) => {
    const y = Number(String(d || '').slice(0, 4))
    return Number.isFinite(y) && y > 0 ? y : null
  }

  // `poster` is server-relative (a cached image) or null; `tmdbPoster` is the
  // TMDB CDN fallback for a film the server has no image of — typically one
  // that isn't in the library.
  function collectionPartArt(cacheDir, part, ownedEntry) {
    const poster = ownedEntry
      ? serverRelative(posterUrl(cacheDir, ownedEntry.meta.id, ownedEntry.meta.poster_path))
      : serverRelative(posterUrl(cacheDir, part.id, part.poster_path))
    const pp = part.poster_path || (ownedEntry && ownedEntry.meta.poster_path) || null
    return { poster, tmdbPoster: pp && !metadataOverrides.customArtUrl(pp) ? tmdbImageUrl('w300', pp) : null }
  }

  function apiCollections() {
    const snap = collectionsSnapshot()
    const refreshing = refreshCollectionsInBackground(snap) || collectionsRefreshing
    const items = snap.franchises.map((f) => {
      const firstOwned = f.parts.find((p) => snap.owned.has(String(p.id)))
      const cover = firstOwned || f.parts[0]
      const art = collectionPartArt(snap.cacheDir, cover, firstOwned ? snap.owned.get(String(firstOwned.id)) : null)
      const years = f.parts.map((p) => yearOfDate(p.release_date)).filter(Boolean)
      return {
        id: f.id,
        name: f.name,
        displayName: collections.collectionDisplayName(f.name),
        poster: art.poster,
        tmdbPoster: art.tmdbPoster,
        ownedCount: f.ownedCount,
        total: f.parts.length,
        complete: f.ownedCount === f.parts.length,
        firstYear: years.length ? Math.min(...years) : null,
        lastYear: years.length ? Math.max(...years) : null
      }
    })
    return { ok: true, items, unchecked: snap.unchecked, refreshing }
  }

  // A limited viewer: only franchises they can watch something from, never a blocked one.
  // (The owned films are already filtered by the library walk.)
  function limitCollectionsFor(viewer, out) {
    if (!contentGateInstance.isLimited(viewer)) return out
    const blocked = new Set(((viewer.policy && viewer.policy.blockedCollections) || []).map(Number))
    out.items = out.items.filter((c) => c.ownedCount > 0 && !blocked.has(Number(c.id)))
    out.unchecked = 0
    return out
  }

  // Every film and show, newest first, as { at, item }. /api/recently-added takes the top 24 of this.
  function recentlyAddedEntries() {
    const cacheDir = getTmdbCacheDir ? getTmdbCacheDir() : null
    const movieMetaOf = cachedMovieMetaReader(cacheDir)
    const tvMetaOf = cachedTvMetaReader(cacheDir)
    const added = getRecentlyAddedMap(store)
    const addedAtOf = parseMemo.createAddedLookup(added, path) // (folder, relPath) -> when it was added, without resolving 40,000 paths
    const images = tmdbFileCache.localImageIndex(cacheDir)
    const out = []
    for (const g of groupMovieList(scanMoviesMulti(allMoviesDirs()), cacheDir).groups) {
      const m = g.primary
      const at = Math.max(...g.files.map((f) => added.get(path.resolve(path.join(f.dir, f.fileName))) || f.mtimeMs || 0))
      const meta = movieMetaOf(m.fileName)
      out.push({ at, item: {
        id: m.id, kind: 'movie', title: (meta && meta.title) || m.name,
        poster: serverRelative(meta ? posterUrl(cacheDir, meta.id, meta.poster_path, images) : null),
        stream: movieStreamPath(m.id), showKey: null,
      } })
    }
    for (const [key, show] of apiShowMap()) {
      let newest = 0
      for (const ep of show.episodes) {
        const at = (ep.dir ? addedAtOf(ep.dir, ep.relPath) : 0) || ep.mtimeMs || 0
        if (at > newest) newest = at
      }
      const meta = tvMetaOf(key)
      out.push({ at: newest, item: {
        id: key, kind: 'tv', title: (meta && meta.name) || show.name,
        poster: serverRelative(meta ? tvPosterUrl(cacheDir, meta.id, meta.poster_path, images) : null),
        stream: null, showKey: key,
      } })
    }
    out.sort((a, b) => b.at - a.at)
    return out
  }

  function apiCollectionDetail(rawId, user) {
    const id = Number(rawId)
    if (!Number.isFinite(id) || id <= 0) return { status: 400, body: { ok: false, error: 'bad_id' } }
    const snap = collectionsSnapshot()
    const grouped = snap.franchises.find((f) => Number(f.id) === id)
    // A franchise nothing is owned from (reached from a stale link) still has
    // a page, as long as it is cached: every part simply shows as not owned.
    const cached = grouped ? null : collectionDetailsCache.get(String(id))
    const collection = grouped || (cached ? { id: cached.id, name: String(cached.name || 'Collection'), parts: collections.sortPartsByRelease(cached.parts), ownedCount: 0 } : null)
    if (!collection) return { status: 404, body: { ok: false, error: 'not_found' } }

    const ctx = { cacheDir: snap.cacheDir, qualityCache: loadQualityCache(snap.cacheDir), recentlyAdded: getRecentlyAddedMap(store) }
    let rows = []
    try {
      rows = store.get('missingRequests') || []
    } catch {
      rows = []
    }
    const parts = collection.parts.map((p) => {
      const own = snap.owned.get(String(p.id)) || null
      const art = collectionPartArt(snap.cacheDir, p, own)
      const row = own ? null : (Array.isArray(rows) ? rows : []).find((r) => r && missingRequestKey(r) === missingRequestKey({ kind: 'movie', tmdbId: p.id }))
      return {
        tmdbId: p.id,
        title: p.title || collection.name,
        year: yearOfDate(p.release_date),
        releaseDate: p.release_date || null,
        owned: !!own,
        poster: art.poster,
        tmdbPoster: art.tmdbPoster,
        movie: own ? apiMovieItem(own.m, own.meta, collection, ctx).item : null,
        request: row
          ? {
              id: row.id,
              status: titleRequests.requestStatus(row),
              mine: (row.requestedBy || []).some((u) => u && user && u.userId === user.id)
            }
          : null
      }
    })
    return {
      status: 200,
      body: {
        ok: true,
        collection: {
          id: collection.id,
          name: collection.name,
          displayName: collections.collectionDisplayName(collection.name),
          ownedCount: collection.ownedCount,
          total: parts.length,
          complete: parts.length > 0 && collection.ownedCount === parts.length,
          parts
        }
      }
    }
  }

  // --- "Request a title": /api/title-search, /api/title-requests ----------
  // Anyone signed in may search and ask; only the owner (an admin) may dismiss.
  // Requests are ordinary 'missingRequests' rows (recordMissingRequest), so
  // they land in the desktop Requests tab and the web admin's Missing tab with
  // no second list to keep in step. Both routes are rate limited per person.
  const TITLE_REQUEST_RATE = { limit: 20, windowMs: 60 * 60 * 1000 }
  const TITLE_SEARCH_RATE = { limit: 30, windowMs: 60 * 1000 }
  const titleRequestLimiter = titleRequests.createRateLimiter(TITLE_REQUEST_RATE)
  const titleSearchLimiter = titleRequests.createRateLimiter(TITLE_SEARCH_RATE)
  const TITLE_SEARCH_MEMO_MS = 10 * 60 * 1000
  const titleSearchMemo = new Map()

  // What the library holds, in the shape titleRequests.buildLibraryIndex takes.
  // Reads the primed walk and the offline manifests only.
  async function titleLibraryIndex() {
    await primeLibrary('both')
    const cacheDir = getTmdbCacheDir ? getTmdbCacheDir() : null
    const metaOf = cachedMovieMetaReader(cacheDir)
    const movies = []
    for (const m of scanMoviesMulti(allMoviesDirs())) {
      const meta = metaOf(m.fileName)
      const parsed = parseMovieTitle(m.fileName) || {}
      const parsedYear = Number(parsed.year) || null
      if (meta) movies.push({ tmdbId: meta.id, title: meta.title, year: yearOfDate(meta.release_date) || parsedYear })
      movies.push({ tmdbId: null, title: parsed.title || m.name, year: parsedYear })
    }
    const tvMetaOf = cachedTvMetaReader(cacheDir)
    const shows = []
    const episodes = []
    for (const s of apiShowMap().values()) {
      const meta = tvMetaOf(s.key)
      const names = [s.name]
      if (meta && meta.name && meta.name !== s.name) names.push(meta.name)
      shows.push({ tmdbId: meta ? meta.id : null, name: s.name, year: s.year })
      if (names.length > 1) shows.push({ tmdbId: null, name: meta.name })
      for (const ep of s.episodes) for (const show of names) episodes.push({ show, season: ep.season, episode: ep.episode })
    }
    return titleRequests.buildLibraryIndex({ movies, shows, episodes })
  }

  // Best-effort email when a request the owner (or a library rescan) just decided on has someone
  // to tell — titleRequests.requestersToNotify() is the pure "did this really just turn into
  // added/dismissed, and who asked for it" decision; this is only the I/O around it (finding
  // their saved email, actually sending). No email on file, or outgoing mail never set up
  // (Settings > Email), and this quietly does nothing — exactly emailCodeIfPossible's rule in
  // main.js for a brand-new account's access code.
  async function notifyTitleRequesters(beforeRow, afterRow) {
    webhooks.emitRequestTransition(store, beforeRow, afterRow)
    let list
    try {
      list = titleRequests.requestersToNotify(beforeRow, afterRow)
    } catch {
      list = []
    }
    if (!list.length) return
    const title = afterRow.title || afterRow.showName || 'your requested title'
    const added = titleRequests.requestStatus(afterRow) === 'added'
    let users = []
    try { users = auth.getUsers(store) } catch { users = [] }
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

  // Marks every open request whose title is now in the library. Called when a
  // requester or the owner looks at the list, and every ten minutes.
  async function markArrivedTitleRequests() {
    const open = (() => {
      try {
        const rows = store.get('missingRequests')
        return Array.isArray(rows) && rows.some((r) => r && !r.resolved && !r.dismissedAt)
      } catch {
        return false
      }
    })()
    if (!open) return 0
    const idx = await titleLibraryIndex()
    // Re-read after the await, so a request filed meanwhile is never lost.
    const before = store.get('missingRequests') || []
    const { rows, changed } = titleRequests.markArrived(before, idx)
    if (changed) {
      store.set('missingRequests', rows)
      const beforeById = new Map(before.map((r) => [r && r.id, r]))
      for (const after of rows) {
        const b = beforeById.get(after && after.id)
        if (b && b !== after) notifyTitleRequesters(b, after).catch(() => {})
      }
    }
    return changed
  }
  const titleRequestSweep = setInterval(() => {
    markArrivedTitleRequests().catch(() => {})
  }, 10 * 60 * 1000)
  if (titleRequestSweep.unref) titleRequestSweep.unref()

  // library.item_added. The library is a folder tree files are copied into by hand, so there is no
  // "file added" moment to hook: every few minutes what is there is compared with what was there
  // last time (a list of short fingerprints) and the difference is announced. The first look only
  // takes the baseline, so turning a webhook on never announces the whole existing library, and a
  // look that finds nothing at all (a drive that is not plugged in) is not taken as one.
  const LIBRARY_SEEN_KEY = 'webhookLibrarySeen'
  const LIBRARY_ANNOUNCE_CAP = 25
  const LIBRARY_SEEN_MAX = 60000
  const libraryFingerprint = (s) => crypto.createHash('sha1').update(s).digest('base64url').slice(0, 10)
  async function announceNewLibraryItems() {
    if (!webhooks.wantsEvent(store, 'library.item_added')) return 0
    await primeLibrary('both')
    const cacheDir = getTmdbCacheDir ? getTmdbCacheDir() : null
    const movieMetaOf = cachedMovieMetaReader(cacheDir)
    const tvMetaOf = cachedTvMetaReader(cacheDir)
    const present = new Map()
    for (const m of scanMoviesMulti(allMoviesDirs())) {
      present.set(libraryFingerprint('m|' + m.fileName), () => {
        const meta = movieMetaOf(m.fileName)
        const parsed = parseMovieTitle(m.fileName) || {}
        return {
          kind: 'movie',
          title: (meta && meta.title) || parsed.title || m.name,
          year: (meta && yearOfDate(meta.release_date)) || Number(parsed.year) || null,
          tmdbId: meta && meta.id != null ? meta.id : null
        }
      })
    }
    for (const show of apiShowMap().values()) {
      for (const ep of show.episodes) {
        present.set(libraryFingerprint('t|' + ep.relPath), () => {
          const meta = tvMetaOf(show.key)
          const showName = (meta && meta.name) || show.name
          const numbered = ep.season !== null && ep.episode !== null
          return { kind: 'episode', show: showName, season: ep.season, episode: ep.episode, title: numbered ? `${showName} — S${ep.season}E${ep.episode}` : showName, tmdbId: meta && meta.id != null ? meta.id : null }
        })
      }
    }
    if (!present.size) return 0
    const prior = store.get(LIBRARY_SEEN_KEY)
    if (!Array.isArray(prior)) {
      store.set(LIBRARY_SEEN_KEY, [...present.keys()])
      return 0
    }
    const seen = new Set(prior)
    const fresh = [...present.keys()].filter((k) => !seen.has(k))
    if (!fresh.length) return 0
    // Kept as a union so a file that goes away and comes back is not announced twice.
    store.set(LIBRARY_SEEN_KEY, prior.length + fresh.length > LIBRARY_SEEN_MAX ? [...present.keys()] : [...prior, ...fresh])
    let sent = 0
    for (const k of fresh.slice(0, LIBRARY_ANNOUNCE_CAP)) sent += webhooks.emitLibraryItem(store, present.get(k)()) ? 1 : 0
    if (fresh.length > LIBRARY_ANNOUNCE_CAP) log(`webhooks: ${fresh.length - LIBRARY_ANNOUNCE_CAP} more new library items were not announced individually`)
    return sent
  }
  const librarySweep = setInterval(() => {
    announceNewLibraryItems().catch(() => {})
  }, 5 * 60 * 1000)
  if (librarySweep.unref) librarySweep.unref()

  const requestRowFor = (kind, tmdbId) => {
    let rows = []
    try {
      rows = store.get('missingRequests') || []
    } catch {
      rows = []
    }
    const key = missingRequestKey({ kind, tmdbId })
    return (Array.isArray(rows) ? rows : []).find((r) => r && missingRequestKey(r) === key) || null
  }

  async function apiTitleSearch(url, user) {
    const q = String(url.searchParams.get('q') || '').replace(/\s+/g, ' ').trim().slice(0, 100)
    const rawKind = url.searchParams.get('kind')
    const kind = rawKind === 'movie' || rawKind === 'tv' ? rawKind : 'all'
    if (q.length < 2) return { status: 400, body: { ok: false, error: 'query_too_short' } }

    const memoKey = `${kind}|${q.toLowerCase()}`
    const memo = titleSearchMemo.get(memoKey)
    let results = memo && Date.now() - memo.at < TITLE_SEARCH_MEMO_MS ? memo.results : null
    if (!results) {
      // Only a search that would reach TMDB counts against the limit.
      const gate = titleSearchLimiter.hit(user.id)
      if (!gate.ok) return { status: 429, body: { ok: false, error: 'rate_limited', retryAfterSeconds: gate.retryAfterSeconds } }
      const api = titleMatch.createTmdbApi(store.get('tmdbApiKey') || process.env.TMDB_API_KEY)
      if (!api) return { status: 200, body: { ok: false, error: 'no_api_key', items: [] } }
      const searchPath = kind === 'movie' ? '/search/movie' : kind === 'tv' ? '/search/tv' : '/search/multi'
      const res = await api.get(searchPath, { query: q, include_adult: 'false', page: 1 })
      if (!res.ok) return { status: 502, body: { ok: false, error: 'tmdb_unreachable' } }
      results = ((res.data && res.data.results) || [])
        .map((r) => {
          const k = kind === 'all' ? r && r.media_type : kind
          if (!r || (k !== 'movie' && k !== 'tv') || !r.id) return null
          const title = String((k === 'tv' ? r.name : r.title) || r.title || r.name || '').trim()
          if (!title) return null
          return {
            kind: k,
            tmdbId: r.id,
            title,
            year: yearOfDate(k === 'tv' ? r.first_air_date : r.release_date),
            overview: r.overview ? String(r.overview).slice(0, 300) : null,
            tmdbPoster: tmdbImageUrl('w185', r.poster_path)
          }
        })
        .filter(Boolean)
        .slice(0, 20)
      titleSearchMemo.set(memoKey, { at: Date.now(), results })
      if (titleSearchMemo.size > 200) titleSearchMemo.delete(titleSearchMemo.keys().next().value)
    }

    const idx = await titleLibraryIndex()
    const items = results.map((r) => {
      const row = requestRowFor(r.kind, r.tmdbId)
      return {
        ...r,
        inLibrary: titleRequests.rowInLibrary({ kind: r.kind, tmdbId: r.tmdbId, title: r.title, showName: r.kind === 'tv' ? r.title : null, year: r.year }, idx),
        request: row
          ? { id: row.id, status: titleRequests.requestStatus(row), mine: (row.requestedBy || []).some((u) => u && u.userId === user.id) }
          : null
      }
    })
    return { status: 200, body: { ok: true, items } }
  }

  async function apiCreateTitleRequest(req, user) {
    const gate = titleRequestLimiter.hit(user.id)
    if (!gate.ok) return { status: 429, body: { ok: false, error: 'rate_limited', retryAfterSeconds: gate.retryAfterSeconds } }
    const body = (await apiReadBody(req)) || {}
    const kind = body.kind === 'tv' ? 'tv' : body.kind === 'movie' ? 'movie' : null
    const title = String(body.title || '').replace(/\s+/g, ' ').trim().slice(0, 200)
    const idNum = Number(body.tmdbId)
    const tmdbId = Number.isInteger(idNum) && idNum > 0 ? idNum : null
    const yearNum = Number(body.year)
    const year = Number.isInteger(yearNum) && yearNum > 1800 && yearNum < 3000 ? yearNum : null
    if (!kind || !title) return { status: 400, body: { ok: false, error: 'bad_request' } }

    const idx = await titleLibraryIndex()
    if (titleRequests.rowInLibrary({ kind, tmdbId, title, year, showName: kind === 'tv' ? title : null }, idx)) {
      return { status: 409, body: { ok: false, error: 'already_in_library' } }
    }
    const out = recordMissingRequest(store, {
      kind,
      title,
      showName: kind === 'tv' ? title : undefined,
      tmdbId,
      year,
      userId: user.id,
      userName: user.name || 'Unknown',
      source: 'request',
      note: body.note,
      poster: body.poster
    })
    if (!out || !out.ok) return { status: 400, body: { ok: false, error: 'bad_request' } }
    const row = (store.get('missingRequests') || []).find((r) => r && r.id === out.id)
    return {
      status: 200,
      body: {
        ok: true,
        created: !!out.created,
        deduped: !!out.deduped,
        appended: !!out.appended,
        request: row ? titleRequests.requestsForUser([row], user)[0] || null : null
      }
    }
  }

  async function apiListTitleRequests(user) {
    try {
      await markArrivedTitleRequests()
    } catch {}
    let rows = []
    try {
      rows = store.get('missingRequests') || []
    } catch {
      rows = []
    }
    return { ok: true, canDismiss: !!user.isAdmin, items: titleRequests.requestsForUser(rows, user) }
  }

  async function apiDismissTitleRequest(req, user) {
    if (!user.isAdmin) return { status: 403, body: { ok: false, error: 'owner_only' } }
    const body = (await apiReadBody(req)) || {}
    const id = String(body.id || '').trim()
    const rows = Array.isArray(store.get('missingRequests')) ? store.get('missingRequests') : []
    const row = id ? rows.find((r) => r && r.id === id) : null
    if (!row) return { status: 404, body: { ok: false, error: 'not_found' } }
    const updated = titleRequests.dismissRow(row)
    if (updated !== row) {
      store.set('missingRequests', rows.map((r) => (r === row ? updated : r)))
      notifyTitleRequesters(row, updated).catch(() => {})
    }
    return { status: 200, body: { ok: true, request: titleRequests.requestsForUser([updated], user)[0] || null } }
  }

  // --- GET /api/actor/<personId>/missing ------------------------------------
  // "Not in your library" on the phone's actor page: the person's films and
  // shows the library doesn't have, ranked exactly like the desktop's By Actor
  // gap list (electron/actorGaps.js). One TMDB call per person, ever: the
  // trimmed combined_credits are kept in personCredits.json, the same file the
  // desktop writes. No key, offline, or TMDB down is never an error: ok:true
  // with no items and a `reason`, so the phone just shows nothing extra.
  const TMDB_PHONE_RATE = { limit: 120, windowMs: 60 * 1000 }
  const tmdbPhoneLimiter = titleRequests.createRateLimiter(TMDB_PHONE_RATE)
  const personCreditsMem = new Map() // String(person id) -> trimmed credits
  const personCreditsInFlight = new Map()

  async function personCreditsFor(personId, user) {
    const id = String(personId)
    if (personCreditsMem.has(id)) return { credits: personCreditsMem.get(id) }
    const cacheDir = getTmdbCacheDir ? getTmdbCacheDir() : null
    const onDisk = actorGaps.readCachedPersonCredits(cacheDir, id)
    if (onDisk) {
      personCreditsMem.set(id, onDisk)
      return { credits: onDisk }
    }
    const api = titleMatch.createTmdbApi(store.get('tmdbApiKey') || process.env.TMDB_API_KEY)
    if (!api) return { credits: null, reason: 'no_api_key' }
    if (personCreditsInFlight.has(id)) return personCreditsInFlight.get(id)
    if (!tmdbPhoneLimiter.hit(user.id).ok) return { credits: null, reason: 'rate_limited' }
    const job = (async () => {
      const res = await api.get(`/person/${encodeURIComponent(id)}/combined_credits`, {})
      // Failures are not cached: offline now must not mean "no other work" forever.
      if (!res.ok) return { credits: null, reason: res.status === 404 ? 'unknown_person' : 'tmdb_unreachable' }
      const credits = actorGaps.trimPersonCredits(res.data)
      personCreditsMem.set(id, credits)
      if (personCreditsMem.size > 500) personCreditsMem.delete(personCreditsMem.keys().next().value)
      actorGaps.savePersonCredits(cacheDir, id, credits)
      return { credits }
    })()
    personCreditsInFlight.set(id, job)
    try {
      return await job
    } finally {
      personCreditsInFlight.delete(id)
    }
  }

  // The person's name from the cast lists already cached for the library.
  function cachedPersonName(personId) {
    const cacheDir = getTmdbCacheDir ? getTmdbCacheDir() : null
    const maps = []
    try {
      if (cacheDir) maps.push(tmdbFileCache.getCreditsMap(cacheDir), tmdbFileCache.getTvCreditsMap(cacheDir))
    } catch {}
    maps.push(Object.fromEntries(creditsCache))
    for (const map of maps) {
      for (const cast of Object.values(map || {})) {
        const hit = Array.isArray(cast) ? cast.find((c) => c && Number(c.id) === personId && c.name) : null
        if (hit) return String(hit.name)
      }
    }
    return null
  }

  async function apiActorMissing(rawId, user) {
    const personId = Number(rawId)
    if (!Number.isInteger(personId) || personId <= 0) return { status: 400, body: { ok: false, error: 'bad_person' } }
    const person = { id: personId, name: cachedPersonName(personId) }
    const { credits, reason } = await personCreditsFor(personId, user)
    if (!credits) return { status: 200, body: { ok: true, person, items: [], reason } }

    await primeLibrary('both')
    const cacheDir = getTmdbCacheDir ? getTmdbCacheDir() : null
    const metaOf = cachedMovieMetaReader(cacheDir)
    const ownedMovieIds = new Set()
    const unmatchedMovieKeys = new Set()
    for (const m of scanMoviesMulti(allMoviesDirs())) {
      const meta = metaOf(m.fileName)
      if (meta && meta.id != null) ownedMovieIds.add(Number(meta.id))
      else unmatchedMovieKeys.add(actorGaps.looseTitleKey((parseMovieTitle(m.fileName) || {}).title || m.name))
    }
    const tvMetaOf = cachedTvMetaReader(cacheDir)
    const ownedTvIds = new Set()
    const unmatchedTvKeys = new Set()
    for (const s of apiShowMap().values()) {
      const meta = tvMetaOf(s.key)
      if (meta && meta.id != null) ownedTvIds.add(Number(meta.id))
      else unmatchedTvKeys.add(actorGaps.looseTitleKey(s.name))
    }
    unmatchedMovieKeys.delete('')
    unmatchedTvKeys.delete('')

    const items = actorGaps
      .missingForPhone(credits, { ownedMovieIds, ownedTvIds, unmatchedMovieKeys, unmatchedTvKeys })
      .map((it) => {
        const row = requestRowFor(it.kind, it.tmdbId)
        return {
          ...it,
          request: row
            ? { id: row.id, status: titleRequests.requestStatus(row), mine: (row.requestedBy || []).some((u) => u && u.userId === user.id) }
            : null
        }
      })
    return { status: 200, body: { ok: true, person, items } }
  }

  // --- GET /api/trailer?kind=movie|tv&tmdbId=N --------------------------------
  // { ok, youtubeKey, name } — youtubeKey null when there is no trailer (or no
  // key / no internet, with a `reason`). Answers are cached (trailers.js).
  const trailerCache = trailers.createTrailerCache({ getCacheDir: () => (getTmdbCacheDir ? getTmdbCacheDir() : null) })
  const trailerInFlight = new Map()

  async function apiTrailer(url, user) {
    const kind = url.searchParams.get('kind')
    const id = Number(url.searchParams.get('tmdbId'))
    if ((kind !== 'movie' && kind !== 'tv') || !Number.isInteger(id) || id <= 0) {
      return { status: 400, body: { ok: false, error: 'bad_request' } }
    }
    const answer = (picked, extra = {}) => ({
      status: 200,
      body: { ok: true, youtubeKey: picked ? picked.youtubeKey : null, name: picked ? picked.name : null, ...extra }
    })
    const cached = trailerCache.get(kind, id)
    if (cached !== undefined) return answer(cached)
    const api = titleMatch.createTmdbApi(store.get('tmdbApiKey') || process.env.TMDB_API_KEY)
    if (!api) return answer(null, { reason: 'no_api_key' })
    const k = `${kind}:${id}`
    let job = trailerInFlight.get(k)
    if (!job) {
      if (!tmdbPhoneLimiter.hit(user.id).ok) return answer(null, { reason: 'rate_limited' })
      job = trailers.fetchTrailer(api, kind, id)
      trailerInFlight.set(k, job)
    }
    let picked
    try {
      picked = await job
    } finally {
      trailerInFlight.delete(k)
    }
    if (picked === undefined) return answer(null, { reason: 'tmdb_unreachable' })
    trailerCache.set(kind, id, picked)
    return answer(picked)
  }

  // Groups every episode file into shows exactly the way /tvshows does
  // (folder-name first, filename parsing for flat files).
  function apiShowMap() {
    return buildShowMap(scanTvShowsMulti(allTvShowsDirs()))
  }
  // The same map, with the walk done off the main thread.
  async function apiShowMapAsync() {
    return buildShowMap(contentGate.filterForRequest('tv', await catalogWalker.scanTvShowsMulti(allTvShowsDirs())))
  }
  // The show name, year and episode numbers of a file are a pure function of its path and name, so they are worked out
  // once and remembered (parseMemo.js): a 40,000-episode library was re-parsed with regexes on every list request.
  const showInfoMemo = parseMemo.createKeyedMemo(150000)
  function showInfoFor(f) {
    return showInfoMemo(f.relPath + '\u0000' + f.fileName, () => {
      const { show, year } = groupKeyAndName(f.relPath, f.fileName)
      const parsed = parseEpisode(f.fileName)
      return { show, year, key: encodeId(show.toLowerCase()), season: parsed.season, episode: parsed.episode, episodeTitle: parsed.episodeTitle }
    })
  }
  // path.join(dir, relPath) for a walked episode without a join call each (parseMemo.createJoiner: same string, one prefix per folder).
  const joinUnder = parseMemo.createJoiner(path)
  function buildShowMap(tvFiles) {
    const showMap = new Map()
    for (const f of tvFiles) {
      const info = showInfoFor(f)
      const showName = info.show
      const year = info.year
      const parsed = info
      const showKey = info.key
      if (!showMap.has(showKey)) showMap.set(showKey, { key: showKey, name: showName, year, episodes: [] })
      showMap.get(showKey).episodes.push({
        season: parsed.season,
        episode: parsed.episode,
        episodeTitle: parsed.episodeTitle,
        relPath: f.relPath,
        fileName: f.fileName,
        dir: f.dir,
        size: f.size,
        mtimeMs: f.mtimeMs
      })
    }
    return showMap
  }

  // Fills in TMDB metadata (and the poster IMAGE) for shows nothing has looked
  // up yet, on view — the same "it just appears when you open the page"
  // behaviour the website's movie list has always had, which is what the phone
  // app was missing. Bounded exactly like the Sequels / Missing Episodes code:
  // TMDB_LOOKUP_CONCURRENCY (5) in flight, TMDB_PAGE_LOOKUP_CAP (40) first-time
  // lookups per request. Anything past the cap simply renders without a poster
  // and fills in on a later view. Already-cached shows cost zero network calls.
  async function enrichUncachedShows(shows) {
    const cacheDir = getTmdbCacheDir ? getTmdbCacheDir() : null
    const key = store.get('tmdbApiKey') || process.env.TMDB_API_KEY
    if (!key || !cacheDir || !shows || !shows.length) return
    let manifest = {}
    try {
      manifest = tmdbFileCache.getTvManifest(cacheDir)
    } catch {
      manifest = {}
    }
    const missing = shows.filter(
      (s) => s && s.key && !tvManifestHit(manifest, s.key) && !tvManifestKeyCandidates(s.key).some((k) => tvCache.has(k))
    )
    if (!missing.length) return
    // tmdbLookupTv write-throughs the manifest entry AND downloads the poster.
    await mapWithConcurrency(missing.slice(0, TMDB_PAGE_LOOKUP_CAP), TMDB_LOOKUP_CONCURRENCY, async (s) => {
      try {
        await tmdbLookupTv(s.name, s.key, key, cacheDir, s.year)
      } catch {
        // one show failing must never fail the whole list
      }
    })
  }

  // --- GET /api/tvshows ---------------------------------------------------
  async function apiTvShows(url) {
    const cacheDir = getTmdbCacheDir ? getTmdbCacheDir() : null
    const qualityCache = loadQualityCache(cacheDir)
    // Same 7-day `recentlyAdded` window the website's 🆕 badge uses; a show is
    // new when ANY of its episode files is.
    const recentlyAdded = getRecentlyAddedMap(store)
    const images = tmdbFileCache.localImageIndex(cacheDir)
    const noQualityData = !parseMemo.hasEntries(qualityCache) // nothing probed yet: no episode can have a badge
    const addedAtOf = parseMemo.createAddedLookup(recentlyAdded, path)
    const shows = Array.from(apiShowMap().values()).sort((a, b) =>
      TITLE_COLLATOR.compare(a.name, b.name)
    )
    // Look up anything nothing has seen before, THEN read the cache — so a
    // freshly matched show gets its poster on this very response.
    await enrichUncachedShows(shows)
    // Read the manifest AFTER enrichment, so a show matched a moment ago is
    // already in this response rather than the next one.
    const metaOf = cachedTvMetaReader(cacheDir)

    const rows = shows.map((s) => {
      const meta = metaOf(s.key)
      const tmdbYear = Number(String(meta?.first_air_date || '').slice(0, 4))
      const year = Number.isFinite(tmdbYear) && tmdbYear ? tmdbYear : Number.isFinite(Number(s.year)) && s.year ? Number(s.year) : null
      return {
        meta,
        item: {
          key: s.key,
          name: meta?.name || s.name,
          year,
          poster: serverRelative(meta ? tvPosterUrl(cacheDir, meta.id, meta.poster_path, images) : null),
          backdrop: backdropUrl(meta?.backdrop_path),
          voteAverage: typeof meta?.vote_average === 'number' ? meta.vote_average : null,
          episodeCount: s.episodes.length,
          isNew: recentlyAdded.size > 0 && s.episodes.some((ep) => ep.dir && addedAtOf(ep.dir, ep.relPath) > 0),
          quality: noQualityData ? null : bestQualityTier(
            qualityCache,
            s.episodes.filter((ep) => ep.dir).map((ep) => ({ path: joinUnder(ep.dir, ep.relPath), mtimeMs: ep.mtimeMs, size: ep.size }))
          ),
          genres: Array.isArray(meta?.genre_ids) ? meta.genre_ids.slice() : [],
          // TMDB tv id, for the phone's ▶ trailer button. Null when unmatched.
          tmdbId: meta && meta.id != null ? meta.id : null
        }
      }
    })

    const genres = apiGenreList(countGenres(rows.map((r) => r.meta)), GENRE_NAMES_TV)

    const genre = apiGenreParam(url.searchParams.get('genre'))
    const q = apiSearchParam(url.searchParams.get('q'))
    const actor = apiActorParam(url.searchParams.get('actor'))
    let list = rows
    if (genre !== null) list = list.filter((r) => hasGenre(r.meta?.genre_ids, genre))
    if (q) list = list.filter((r) => r.item.name.toLowerCase().includes(q))
    if (actor !== null) {
      const castOf = cachedCreditsReader('tv')
      list = list.filter((r) => castHasPerson(castOf(r.meta?.id), actor))
    }

    return { ok: true, genres, items: list.map((r) => r.item) }
  }

  // --- GET /api/tvshows/<showKey>/episodes --------------------------------
  // Real episode NAMES from TVmaze (free, no API key). Best-effort + heavily
  // cached; any failure leaves the plain "Show — SxxEyy" title untouched, so
  // the episode list can never break because a lookup was slow or offline.
  const tvmazeMemo = new Map() // lower-cased show name -> { 'season|number': name }
  async function tvmazeEpisodeNames(showName) {
    const raw = String(showName || '').trim()
    if (!raw) return {}
    const key = raw.toLowerCase()
    if (tvmazeMemo.has(key)) return tvmazeMemo.get(key)
    let diskFile = null
    try {
      const cd = getTmdbCacheDir ? getTmdbCacheDir() : null
      const dir = path.join(cd || require('os').tmpdir(), 'tvmaze')
      fs.mkdirSync(dir, { recursive: true })
      diskFile = path.join(dir, key.replace(/[^a-z0-9]+/g, '_').slice(0, 60) + '.json')
      const cached = JSON.parse(fs.readFileSync(diskFile, 'utf8'))
      if (cached && cached.map && Object.keys(cached.map).length) { tvmazeMemo.set(key, cached.map); return cached.map }
    } catch {}
    const map = {}
    try {
      const ac = new AbortController()
      const timer = setTimeout(() => { try { ac.abort() } catch {} }, 6000)
      try {
        const sr = await fetch('https://api.tvmaze.com/singlesearch/shows?q=' + encodeURIComponent(raw), { signal: ac.signal })
        if (sr && sr.ok) {
          const showObj = await sr.json()
          const id = showObj && showObj.id
          if (id) {
            const er = await fetch('https://api.tvmaze.com/shows/' + id + '/episodes', { signal: ac.signal })
            if (er && er.ok) {
              const eps = await er.json()
              for (const e of (Array.isArray(eps) ? eps : [])) {
                if (e && e.season != null && e.number != null && e.name) map[e.season + '|' + e.number] = String(e.name)
              }
            }
          }
        }
      } finally { clearTimeout(timer) }
    } catch {}
    // Only cache a real result; a transient failure should retry next time.
    if (Object.keys(map).length) {
      tvmazeMemo.set(key, map)
      if (diskFile) { try { fs.writeFileSync(diskFile, JSON.stringify({ at: Date.now(), map })) } catch {} }
    }
    return map
  }

  // --- Watched state over the library ---------------------------------------
  // watchedState.js stores files. These turn films, episodes, seasons and
  // shows (which the app addresses by encoded id / show key) into the file
  // lists it wants, and back.

  // Old whole-show flags become episode records once the show's files are known.
  function resolveLegacyShowWatched(userId, show) {
    if (!userId || !show) return
    try {
      watchedState.resolveLegacyShow(store, userId, show.key, show.episodes.map((e) => e.relPath))
    } catch {}
  }

  // What the episode list says about one episode, for old apps and new.
  //   seen      the newest history row ({at, pct}) or null
  //   record    the watched-state record or null
  //   resumable whether that file is in this user's Continue Watching
  function episodeWatchView(seen, record, resumable) {
    if (record && record.watched) {
      return { watched: true, watchedAt: (seen && seen.at) || record.at || null, watchedPercent: 100 }
    }
    if (seen && resumable) return { watched: false, watchedAt: seen.at, watchedPercent: Math.min(seen.pct, 94) }
    // Played to the end once but since unticked, or its resume point was
    // cleared by a mark: show nothing rather than a stale "Watched" line.
    if (seen && (seen.pct >= 95 || record)) return { watched: false, watchedAt: null, watchedPercent: 0 }
    if (seen) return { watched: false, watchedAt: seen.at, watchedPercent: seen.pct }
    return { watched: false, watchedAt: null, watchedPercent: 0 }
  }

  function tvFileExists(relPath) {
    return !!relPath && scanTvShowsMulti(allTvShowsDirs()).some((f) => f.relPath === relPath)
  }

  function movieFileExists(fileName) {
    return !!fileName && scanMoviesMulti(allMoviesDirs()).some((m) => m.fileName === fileName)
  }

  function safeDecodeId(id) {
    try {
      return decodeId(String(id || ''))
    } catch {
      return ''
    }
  }

  // Resolve a mark request into the files it covers.
  //   scope  'movie' | 'episode' | 'season' | 'show'
  // -> { items:[{kind,fileName,id}] } or { status, error }
  // `lenient` (the old /api/watched only) records ids that are not in the
  // library, exactly as that route always has.
  function watchedTargets(userId, scope, body, lenient) {
    if (scope === 'movie') {
      const fileName = safeDecodeId(body.id)
      if (!fileName) return { status: 400, error: 'bad_item' }
      if (!lenient && !movieFileExists(fileName)) return { status: 404, error: 'not_found' }
      return { items: [{ kind: 'movie', fileName, id: encodeId(fileName) }] }
    }
    if (scope === 'episode') {
      const relPath = safeDecodeId(body.id)
      if (!relPath) return { status: 400, error: 'bad_item' }
      if (!lenient && !tvFileExists(relPath)) return { status: 404, error: 'not_found' }
      return { items: [{ kind: 'tv', fileName: relPath, id: encodeId(relPath) }] }
    }
    if (scope === 'season' || scope === 'show') {
      const showKey = String(body.showKey || '')
      if (!showKey) return { status: 400, error: 'bad_item' }
      let season
      if (scope === 'season') {
        if (!('season' in body)) return { status: 400, error: 'missing_season' }
        season = body.season === null ? null : Number(body.season)
        if (season !== null && !Number.isInteger(season)) return { status: 400, error: 'bad_season' }
      }
      const show = apiShowMap().get(showKey)
      if (!show) return { status: 404, error: 'not_found' }
      resolveLegacyShowWatched(userId, show)
      const eps = scope === 'season' ? show.episodes.filter((ep) => ep.season === season) : show.episodes
      if (!eps.length) return { status: 404, error: 'not_found' }
      return { items: eps.map((ep) => ({ kind: 'tv', fileName: ep.relPath, id: encodeId(ep.relPath) })) }
    }
    return { status: 400, error: 'bad_scope' }
  }

  // Apply a mark. Marking watched stamps clearedAt, which is what takes each
  // file out of Continue Watching and drops its resume point; unmarking
  // restores neither.
  function applyWatched(userId, items, watched) {
    // What is about to flip, for the outbound webhooks; worked out before the write and only when someone listens.
    const flipped = watched === true && webhooks.wantsEvent(store, 'playback.watched')
      ? items.filter((it) => it && it.fileName && !watchedState.isWatched(store, userId, it.kind, it.fileName))
      : []
    const changed = watchedState.setWatched(store, userId, items, watched === true)
    if (flipped.length) {
      webhooks.emitManualWatched(store, userId, flipped.map((it) => {
        const base = path.basename(String(it.fileName))
        const ep = it.kind === 'tv' ? parseEpisode(base) : null
        const show = ep ? (groupKeyAndName(String(it.fileName), base).show || ep.show) : null
        return { kind: it.kind, title: ep ? `${show}${ep.season !== null ? ` — S${ep.season}E${ep.episode}` : ''}` : (parseMovieTitle(base) || {}).title || cleanTitle(base) }
      }))
    }
    return { watched: watched === true, count: items.length, changed, ids: items.map((it) => it.id) }
  }

  // The watched answer for one title the app addresses by (kind, id). A tv id
  // is either an episode id or a show key; a show is watched when every
  // episode it has is.
  function watchedFor(userId, kind, id) {
    if (kind === 'tv') {
      const show = apiShowMap().get(id)
      if (show) {
        resolveLegacyShowWatched(userId, show)
        const files = watchedState.userFiles(store, userId)
        return show.episodes.length > 0 && show.episodes.every((ep) => files[watchedState.fileKey('tv', ep.relPath)]?.watched === true)
      }
      const relPath = safeDecodeId(id)
      if (!relPath) return false
      // An old flag on an episode id the migration could not tell from a show name.
      if (tvFileExists(relPath)) {
        try { watchedState.resolveLegacyShow(store, userId, id, [relPath]) } catch {}
      }
      return watchedState.isWatched(store, userId, 'tv', relPath)
    }
    const fileName = safeDecodeId(id)
    return !!fileName && watchedState.isWatched(store, userId, 'movie', fileName)
  }

  async function apiEpisodes(showKey, userId) {
    const show = apiShowMap().get(showKey)
    if (!show) return { status: 404, body: { ok: false, error: 'not_found' } }
    // What has this viewer already seen? History rows key on the TV relPath,
    // which is exactly what encodeId() turns into an episode id, so one pass
    // over the user's own rows is enough. Never throws - an unreadable history
    // just means nothing is marked watched.
    const watchedById = new Map()
    try {
      for (const row of history.viewedHistory(store, userId) || []) {
        if (!row || row.kind !== 'tv' || !row.fileName) continue
        watchedById.set(encodeId(row.fileName), {
          at: Number(row.updatedAt) || null,
          pct: Number(row.percent) || 0
        })
      }
    } catch {}
    // Watched ticks come from the watched-state store, not from percentages.
    // An old whole-show flag is expanded into episode records on first sight.
    resolveLegacyShowWatched(userId, show)
    let resumableByFile = new Set()
    let watchedFilesMap = {}
    try {
      watchedFilesMap = watchedState.userFiles(store, userId)
      resumableByFile = new Set((history.continueWatching(store, userId) || []).map((r) => r.fileName))
    } catch {}
    const cacheDir = getTmdbCacheDir ? getTmdbCacheDir() : null
    // Same on-view fill-in as the list above, for the one show being opened.
    await enrichUncachedShows([show])
    const meta = cachedTvMetaReader(cacheDir)(show.key)
    // Metadata is best-effort. Missing entries never become playable file rows.
    ensureTvSeasonsLoaded(cacheDir)
    const [epNames, knownSeasons] = await Promise.all([
      tvmazeEpisodeNames(meta?.name || show.name),
      (async () => {
        if (!meta?.id) return undefined
        const id = String(meta.id)
        if (tvSeasonsCache.has(id)) return tvSeasonsCache.get(id)
        const key = store.get('tmdbApiKey') || process.env.TMDB_API_KEY
        if (!key) return undefined
        const value = await fetchTvSeasons(meta.id, key)
        if (value !== undefined) {
          tvSeasonsCache.set(id, value)
          if (cacheDir) persistJsonMap(tvSeasonsCacheFile(cacheDir), tvSeasonsCache)
        }
        return value
      })()
    ])
    const gaps = episodeGaps(show.episodes, knownSeasons, epNames)
    const qualityCache = loadQualityCache(cacheDir)

    // Same grouping/ordering the website's show page uses: numbered seasons
    // ascending, then episodes by number, with un-parseable files last.
    const seasons = new Map()
    for (const ep of show.episodes) {
      const k = ep.season === null ? null : ep.season
      if (!seasons.has(k)) seasons.set(k, [])
      seasons.get(k).push(ep)
    }
    const orderedKeys = Array.from(seasons.keys()).sort((a, b) => {
      if (a === null) return 1
      if (b === null) return -1
      return a - b
    })

    return {
      status: 200,
      body: {
        ok: true,
        show: {
          key: show.key,
          name: meta?.name || show.name,
          poster: serverRelative(meta ? tvPosterUrl(cacheDir, meta.id, meta.poster_path) : null),
          overview: meta?.overview || null,
          tmdbId: meta?.id || null
        },
        missingEpisodesSupported: true,
        seasons: orderedKeys.map((seasonKey) => ({
          season: seasonKey,
          missingChecked: gaps.get(seasonKey)?.checked || false,
          missingEpisodes: gaps.get(seasonKey)?.items || [],
          episodes: seasons
            .get(seasonKey)
            .slice()
            .sort((a, b) => (a.episode ?? 999) - (b.episode ?? 999))
            .map((ep) => {
              const id = encodeId(ep.relPath)
              const parsed = parseEpisode(ep.fileName)
              const epName = (ep.season != null && ep.episode != null) ? epNames[ep.season + '|' + ep.episode] : null
              const view = episodeWatchView(
                watchedById.get(id) || null,
                watchedFilesMap[watchedState.fileKey('tv', ep.relPath)] || null,
                resumableByFile.has(ep.relPath)
              )
              return {
                id,
                season: ep.season,
                episode: ep.episode,
                // The one answer to "has this person watched it" (watchedState.js).
                watched: view.watched,
                // When this viewer last played it (epoch ms) and how far they got.
                // null / 0 means never opened. Derived from `watched`, so apps that
                // only read these two (1.18/1.19 tick at >= 95) agree with it.
                watchedAt: view.watchedAt,
                watchedPercent: view.watchedPercent,
                // Real episode name when TVmaze has one ("S1E19 · Mob Rules"), else the
                // plain identical string /tvwatch and surfTitle produce.
                title: epName
                  ? `S${parsed.season}E${parsed.episode} · ${epName}`
                  : `${parsed.show}${parsed.season !== null ? ` — S${parsed.season}E${parsed.episode}` : ''}`,
                episodeName: epName || null,
                quality: ep.dir ? qualityTierFor(qualityCache, path.join(ep.dir, ep.relPath), ep) : null,
                stream: tvStreamPath(id)
              }
            })
        }))
      }
    }
  }

  // --- Surf ---------------------------------------------------------------
  // Both surf endpoints run on the SAME engine the website's /surprise pages
  // use — surfCandidates / countGenres / hasGenre / seededShuffle /
  // normalizeSeed / freshSeed / surfTitle — so a phone and a browser given the
  // same seed walk the library in exactly the same order.
  // kind is movie|tv|both; `filters` is { genre, year, decade } already
  // normalized. `all` is the unfiltered pool, `pool` the filtered one.
  function apiSurfPool(kind, filters) {
    const cacheDir = getTmdbCacheDir ? getTmdbCacheDir() : null
    const all = surfCandidates(kind, { movieDirs: allMoviesDirs(), tvDirs: allTvShowsDirs(), cacheDir })
    return { cacheDir, all, pool: surfFilterPool(kind, all, filters || {}) }
  }

  // ?kind=&genre=&year=&decade= -> the normalized filter triple every surf
  // endpoint shares. year wins over decade (the contract says pass one).
  function apiSurfFilters(url) {
    const kind = surfKindParam(url.searchParams.get('kind'))
    const genre = apiGenreParam(url.searchParams.get('genre'))
    const year = normalizeYearParam(url.searchParams.get('year'))
    const decade = year === null ? normalizeDecadeParam(url.searchParams.get('decade')) : null
    return { kind, genre, year, decade }
  }

  function apiSurfGenres(url) {
    const { kind, year, decade } = apiSurfFilters(url)
    // Counts describe the pool under the ACTIVE year filter (and nothing else),
    // so a phone showing chips after picking 1990s sees real 1990s counts.
    const { pool } = apiSurfPool(kind, { year, decade })
    return {
      ok: true,
      genres: apiGenreList(countGenres(pool.map((c) => c.meta)), surfGenreNames(kind)),
      total: pool.length,
      seed: freshSeed()
    }
  }

  // --- GET /api/surf/years -------------------------------------------------
  // Mirror image of /api/surf/genres: the years present in the pool under the
  // ACTIVE genre filter, as decades and individual years, plus how many titles
  // have no determinable year at all (those are what a year filter drops).
  function apiSurfYears(url) {
    const { kind, genre } = apiSurfFilters(url)
    const { pool } = apiSurfPool(kind, { genre })
    const summary = surfYearSummary(kind, pool)
    return {
      ok: true,
      decades: summary.decades,
      years: summary.years,
      unknownCount: summary.unknownCount,
      total: summary.total
    }
  }

  function apiSurf(url) {
    const { kind, genre, year, decade } = apiSurfFilters(url)
    const seedRaw = url.searchParams.get('seed')
    const seed = seedRaw === null || seedRaw === '' ? freshSeed() : normalizeSeed(seedRaw)
    const { cacheDir, pool } = apiSurfPool(kind, { genre, year, decade })

    if (!pool.length) return { ok: true, seed, index: 0, total: 0, startFraction: 0.5, item: null }

    const shuffled = seededShuffle(pool, seed)
    const total = shuffled.length
    const iRaw = Number(url.searchParams.get('i'))
    const i = (((Number.isFinite(iRaw) ? Math.floor(iRaw) : 0) % total) + total) % total
    const pick = shuffled[i]
    // In a mixed pool each item names its own kind, which is what picks the
    // poster namespace and the /file vs /tvfile stream URL below.
    const pickKind = surfKindOf(kind, pick)
    const meta = pick.meta
    const poster = meta
      ? serverRelative(
          pickKind === 'tv' ? tvPosterUrl(cacheDir, meta.id, meta.poster_path) : posterUrl(cacheDir, meta.id, meta.poster_path)
        )
      : null

    return {
      ok: true,
      seed,
      index: i,
      total,
      // The website drops the viewer in halfway through; the app does the same.
      startFraction: 0.5,
      item: {
        id: pick.id,
        kind: pickKind,
        title: surfTitle(kind, pick),
        poster,
        stream: pickKind === 'tv' ? tvStreamPath(pick.id) : movieStreamPath(pick.id)
      }
    }
  }

  // Resolves a (kind, encoded id) to an on-disk file the way /file and /tvfile
  // do, so the action endpoints reject ids that don't name a real title.
  // --- id -> cached TMDB meta, for /api/credits and /api/upnext -----------
  // Accepts every id shape the app already holds: a movie file id, a TV episode
  // id, or a TV showKey (what /api/tvshows returns as `key`). Cache-only.
  function apiMetaFor(kind, rawId) {
    const cacheDir = getTmdbCacheDir ? getTmdbCacheDir() : null
    const id = String(rawId || '')
    if (!id) return null
    if (kind === 'tv') {
      const tvMetaOf = cachedTvMetaReader(cacheDir)
      // A showKey is already exactly the manifest key, so try that first.
      if (apiShowMap().has(id)) return tvMetaOf(id)
      let decoded = ''
      try {
        decoded = decodeId(id)
      } catch {
        decoded = ''
      }
      if (!decoded) return null
      const show = groupKeyAndName(decoded, path.basename(decoded)).show
      return show ? tvMetaOf(encodeId(String(show).toLowerCase())) : null
    }
    let decoded = ''
    try {
      decoded = decodeId(id)
    } catch {
      decoded = ''
    }
    return decoded ? cachedMovieMetaReader(cacheDir)(decoded) : null
  }

  // --- GET /api/credits?kind=&id= -----------------------------------------
  // The ℹ️ overlay's cast for the phone app, out of the very same cached maps
  // castStripHtml renders the website's overlay from. Nothing cached -> [].
  function apiCredits(url) {
    try {
      const kind = url.searchParams.get('kind') === 'tv' ? 'tv' : 'movie'
      const meta = apiMetaFor(kind, url.searchParams.get('id'))
      const cast = meta && meta.id != null ? cachedCreditsReader(kind)(meta.id) : []
      return { ok: true, cast: apiCastShape(cast) }
    } catch {
      return { ok: true, cast: [] }
    }
  }

  // --- GET /api/upnext?kind=&id= ------------------------------------------
  // The single source of truth for "what plays next" — literally the same
  // nextUpFor() the website's player countdown uses, so the app can never
  // disagree with the website. `missing` is deliberately the exact body
  // POST /api/missing-request accepts, so the app can post it straight back.
  // One item ({kind,id,showKey,title,poster,stream}) out of a traversal result.
  // `poster` is server-relative or null — never a TMDB CDN URL — and `stream`
  // carries a media token, exactly like /api/continue.
  function apiNeighbourShape(result) {
    if (!result || !result.available || !result.id) return null
    const itemKind = result.kind === 'tv' ? 'tv' : 'movie'
    const cacheDir = getTmdbCacheDir ? getTmdbCacheDir() : null
    const meta = apiMetaFor(itemKind, result.id)
    const poster = meta
      ? itemKind === 'tv'
        ? tvPosterUrl(cacheDir, meta.id, meta.poster_path)
        : posterUrl(cacheDir, meta.id, meta.poster_path)
      : null
    return {
      kind: itemKind,
      id: result.id,
      // The owning show, so the app can offer "see all episodes" straight off a
      // transport target. Always null for movies.
      showKey: itemKind === 'tv' && result.showKey ? result.showKey : null,
      title: result.title || '',
      poster: serverRelative(poster),
      stream: itemKind === 'tv' ? tvStreamPath(result.id) : movieStreamPath(result.id)
    }
  }

  function apiMissingShape(result) {
    if (!result || result.available) return null
    const r = result.report || {}
    return {
      kind: r.kind === 'tv' ? 'tv' : 'movie',
      title: r.title || '',
      showName: r.showName != null ? r.showName : null,
      season: r.season != null ? r.season : null,
      episode: r.episode != null ? r.episode : null,
      collectionName: r.collectionName != null ? r.collectionName : null,
      tmdbId: r.tmdbId != null ? r.tmdbId : null,
      year: r.year != null ? r.year : null
    }
  }

  function apiUpNext(url, userId) {
    try {
      const kind = url.searchParams.get('kind') === 'tv' ? 'tv' : 'movie'
      const { next, previous } = neighboursFor(kind, String(url.searchParams.get('id') || ''), userId)
      return {
        ok: true,
        next: apiNeighbourShape(next),
        previous: apiNeighbourShape(previous),
        missing: apiMissingShape(next)
      }
    } catch {
      // Transport info is a convenience — a failure answers "nothing", not 500.
      return { ok: true, next: null, previous: null, missing: null }
    }
  }

  // --- GET /api/episode-context?kind=tv&id= -------------------------------
  // "Which show is this, and where in it am I" — what the app needs to offer
  // the owner's "go into the TV show and see all the episodes" jump. `showKey`
  // is the exact key GET /api/tvshows/<showKey>/episodes takes.
  async function apiEpisodeContext(url) {
    try {
      if (url.searchParams.get('kind') !== 'tv') {
        return { status: 400, body: { ok: false, error: 'tv_only' } }
      }
      const ctx = (tvNeighbours(String(url.searchParams.get('id') || '')) || {}).context
      if (!ctx) return { status: 404, body: { ok: false, error: 'not_found' } }
      // The real episode name (e.g. "Three Stories") when TVmaze has one; best-effort so a
      // slow/offline lookup just leaves it null and the app keeps its plain "Show — SxEy" title.
      let episodeName = null
      try {
        if (ctx.season != null && ctx.episode != null) {
          const epNames = await tvmazeEpisodeNames(ctx.showName)
          episodeName = epNames[ctx.season + '|' + ctx.episode] || null
        }
      } catch {}
      return {
        status: 200,
        body: {
          ok: true,
          showKey: ctx.showKey,
          showName: ctx.showName,
          season: ctx.season != null ? ctx.season : null,
          episode: ctx.episode != null ? ctx.episode : null,
          episodeName
        }
      }
    } catch {
      return { status: 404, body: { ok: false, error: 'not_found' } }
    }
  }

  function apiMediaExists(kind, encoded) {
    let decoded = ''
    try {
      decoded = decodeId(String(encoded || ''))
    } catch {
      return false
    }
    if (!decoded) return false
    if (kind === 'tv') return scanTvShowsMulti(allTvShowsDirs()).some((f) => f.relPath === decoded)
    return scanMoviesMulti(allMoviesDirs()).some((m) => m.fileName === decoded)
  }

  // ==========================================================================
  // Admin JSON API — /api/admin/* (see spec/api-contract.md, "Admin API")
  // ==========================================================================
  // Until now EVERY administrative action lived behind the desktop Electron
  // app's IPC and was deliberately never reachable over HTTP, because the
  // connection was plaintext — shipping the household's user list, access
  // PINs and folder layout in the clear was not a trade worth making. That
  // single reason is now gone: the shared port terminates a real certificate
  // and the plain side 308s everything to https. So administration is exposed
  // to the phone, but only behind two gates that are both checked BEFORE any
  // admin work happens and before anything is read out of the store:
  //
  //   1. TRANSPORT. The request must have arrived on the TLS side of the
  //      shared port. `req.socket.encrypted` is the ONLY thing trusted for
  //      this. publicOrigin() above also honours `x-forwarded-proto` because
  //      guessing wrong there only costs an email link a redirect; here that
  //      header is client-supplied and would let a hand-crafted plain-HTTP
  //      request declare itself secure, so it is ignored. There is no reverse
  //      proxy in front of this server — the socket flag is the truth.
  //      A real client never sees this refusal (it got 308'd to https), but a
  //      crafted request must not slip admin data out in the clear, and this
  //      also holds the line if the certificate ever fails to load, which
  //      turns the 308 off and would otherwise silently serve /api/admin/*
  //      over plaintext.
  //
  //   2. IDENTITY. A valid bearer token (already enforced by the caller — no
  //      token is 401 unauthorized) whose user has `isAdmin`.
  //
  // A non-admin gets 403 admin_only, never 404: a 404 would be a lie any
  // household member could disprove by watching for it, it would make the
  // Android app unable to tell "you aren't an admin" from "this server is
  // too old", and hiding a route is not a security boundary — the token
  // check is. Never HTML, never a redirect: a native client can follow
  // neither. Every handler answers JSON and never throws.

  // The transport gate. Deliberately not `publicOrigin`-style.
  // The second way in is the away-from-home tunnel: a request the host agent
  // vouches for with its per-run secret, from this machine's loopback, came
  // over the WebRTC data channel, which is DTLS-encrypted from the phone to the
  // agent. A LAN device or a crafted request can't produce that secret, so a
  // plaintext client still gets https_required.
  const adminRequestIsSecure = (req) => !!(req && req.socket && req.socket.encrypted) ||
    viewerIdentity.fromHostAgent(req, AGENT_SECRET)

  // A user row carries the household's PLAINTEXT access PIN (`code`, kept in
  // clear on purpose so the owner can look it up again), its hash, a password
  // hash and, for an unverified signup, a live verification token. This is a
  // WHITELIST rather than a delete-list so a field added to auth.js later
  // cannot silently start leaking through the API.
  function adminSafeUser(u, lastSeenMap) {
    const seen = (lastSeenMap && lastSeenMap[u.id]) || null
    return {
      id: u.id,
      name: u.name || '',
      username: u.username || '',
      email: u.email || '',
      status: u.status || 'approved',
      isAdmin: !!u.isAdmin,
      adult: u.adult === true, viewingHistoryPrivate: u.viewingHistoryPrivate === true,
      createdAt: u.createdAt || null,
      // Booleans only — never the credential itself.
      hasPassword: !!u.passwordHash,
      hasCode: !!u.codeHash,
      twoFactor: twoFactor.isEnabled(u),
      lastSeenAt: seen && typeof seen === 'object' ? seen.time || null : null,
      lastSeenIp: seen && typeof seen === 'object' ? seen.ip || null : null
    }
  }

  const adminApprovedAdmins = (users) => (users || []).filter((u) => u && u.isAdmin && u.status === 'approved')

  // "Don't let the phone lock the phone out." Revoking or demoting the only
  // remaining approved admin would leave nobody able to administer the server
  // from anywhere — including the desktop app, whose Users tab is gated the
  // same way. Refused with last_admin rather than silently ignored.
  function adminIsLastAdmin(userId) {
    let admins = []
    try {
      admins = adminApprovedAdmins(auth.getUsers(store))
    } catch {
      admins = []
    }
    return admins.length <= 1 && admins.some((u) => u.id === userId)
  }

  // --- conversion file guardrails -----------------------------------------
  // REIMPLEMENTED, not reused. The originals live in main.js as the
  // 'convert:deleteOriginal' / 'convert:deleteConverted' ipcMain handlers and
  // its `isInManagedFolders` helper. streamServer.js cannot require main.js
  // (main.js requires streamServer.js — it would be a cycle, and main.js pulls
  // in `electron`, which is not loadable in a plain node process or in the
  // tests). The rules below are a line-for-line restatement of that handler,
  // against the SAME roots: main.js builds them from getAllMoviesDirs() /
  // getAllTvShowsDirs(), which are exactly the getters it passes into this
  // module as allMoviesDirs() / allTvShowsDirs().
  //
  // The rules, in main.js's order:
  //   * an original is deletable only when status === 'done' and it has not
  //     already been deleted
  //   * the converted copy must exist and be > 1MB — a truncated or failed
  //     output must never cost the owner their only copy
  //   * originalPath and outputPath must not resolve to the same file
  //   * the path must sit inside a managed Movies/TV Shows folder
  // Deleting the converted copy goes through convert.rejectConversion, which
  // marks the row 'rejected' so the website's auto-flagging does not
  // immediately redo the work that was just thrown away.
  // Neither direction can ever delete both copies.
  const ADMIN_MIN_CONVERTED_BYTES = 1024 * 1024
  const adminManagedRoots = () => {
    let roots = []
    try {
      roots = [...allMoviesDirs(), ...allTvShowsDirs()]
    } catch {
      roots = []
    }
    return roots.filter(Boolean).map((d) => path.resolve(d))
  }
  const adminInManagedFolders = (filePath) => {
    if (typeof filePath !== 'string' || !filePath) return false
    const resolved = path.resolve(filePath)
    return adminManagedRoots().some((root) => resolved === root || resolved.startsWith(root + path.sep))
  }

  // --- settings ------------------------------------------------------------
  // Read-mostly on purpose. What comes back is folder layout, domain, HTTPS
  // state and the conversion pipeline's fixed encoder settings; what a secret
  // is, is reported as a boolean and never as a value.
  //
  // Writes are a strict ALLOWLIST of folder paths. The TMDB key and the email
  // app password are refused (`not_remotely_settable`) rather than accepted,
  // and the line is drawn there for one reason: those two are the only
  // settings that are bearer credentials for a THIRD-PARTY account. A folder
  // path only ever aims this server at a different directory on a machine the
  // admin already controls; a stolen phone token that could WRITE the Gmail
  // app password could point the server's outbound mail at an attacker's
  // mailbox, and one that could write the TMDB key could swap in a key whose
  // usage they observe. Neither is readable back over this API, so allowing
  // the write would create a way to inject a credential that can never be
  // audited from the same surface. They stay where they have always been:
  // typed once, on the desktop app, in front of the machine.
  // 'newFilesDir' is the old "New files drop folder", merged into the Beebo
  // Inbox. It stays accepted (and reported) only for phone apps that still send
  // it, and writes the Inbox folder; the website shows the one Inbox control.
  const ADMIN_SETTABLE_DIR_KEYS = ['moviesDir', 'tvShowsDir', 'inboxDir', 'newFilesDir', 'viewerAppDir', 'tmdbCacheDir', 'spaceSaverDir']
  const adminInboxDir = () => {
    try { return inbox ? inbox.status().dir || '' : adminStoreGet('inboxDir', '') } catch { return adminStoreGet('inboxDir', '') }
  }
  const ADMIN_SETTABLE_DIR_LIST_KEYS = ['extraMoviesDirs', 'extraTvShowsDirs']
  // Plain on/off settings the phone and admin site can toggle remotely.
  const ADMIN_SETTABLE_BOOL_KEYS = ['allowNewAccounts', 'allowViewerExchange', 'allowViewerExchangeAway']
  // Integer settings (none currently — the car-screen testing toggle was
  // removed along with Beebo Mirror, which is now a separate project).
  const ADMIN_SETTABLE_INT_KEYS = {}
  // Named only so the refusal can be specific; the allowlist above is what
  // actually protects them.
  const ADMIN_SECRET_SETTING_KEYS = new Set([
    'tmdbApiKey',
    'emailAppPassword',
    'emailUser',
    'adminNotifyEmail',
    'otherCredentials',
    'duckdnsToken',
    'apiTokenSecret',
    'sessionSecret',
    'mediaTokenSecret',
    'uploadIdSecret'
  ])

  const adminStoreGet = (key, fallback) => {
    try {
      const v = store.get(key)
      return v === undefined || v === null ? fallback : v
    } catch {
      return fallback
    }
  }

  const adminIsRealDir = (p) => {
    try {
      return fs.statSync(p).isDirectory()
    } catch {
      return false
    }
  }

  function adminTlsSnapshot() {
    try {
      const exp = tlsState.expiresAt || null
      return {
        active: !!tlsState.active,
        reason: tlsState.reason || '',
        expiresAt: exp ? new Date(exp).toISOString() : null,
        daysRemaining: exp ? Math.max(0, Math.round((exp - Date.now()) / 86400000)) : null
      }
    } catch {
      return { active: false, reason: 'unknown', expiresAt: null, daysRemaining: null }
    }
  }

  // GET /api/admin/summary — the badge counts the phone polls for.
  async function adminSummary() {
    const users = (() => {
      try {
        return auth.getUsers(store)
      } catch {
        return []
      }
    })()
    const flags = adminStoreGet('qualityFlags', [])
    const missing = adminStoreGet('missingRequests', [])
    const conversions = (() => {
      try {
        return convert.list(store)
      } catch {
        return []
      }
    })()
    const arr = (v) => (Array.isArray(v) ? v : [])
    const countStatus = (s) => arr(conversions).filter((c) => c && c.status === s).length

    // One directory walk per library — the same walk every website page render
    // already does, and no TMDB or network traffic at all, which is what makes
    // this cheap enough for the phone to poll. Walked on the worker thread, so
    // the poll never holds up a stream.
    let movies = 0
    let shows = 0
    let episodes = 0
    try {
      movies = collapseMovieVersions(await catalogWalker.scanMoviesMulti(allMoviesDirs()), getTmdbCacheDir ? getTmdbCacheDir() : null).length
    } catch {
      movies = 0
    }
    try {
      const tvFiles = await catalogWalker.scanTvShowsMulti(allTvShowsDirs())
      episodes = tvFiles.length
      const keys = new Set()
      for (const f of tvFiles) {
        const { show } = groupKeyAndName(f.relPath, f.fileName)
        keys.add(String(show || '').toLowerCase())
      }
      shows = keys.size
    } catch {
      episodes = 0
      shows = 0
    }

    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
    // Bytes actually sitting on disk from the conversion pipeline: a converted
    // copy that was rejected/deleted, and an original that was deleted after
    // conversion, are both excluded.
    const convertedBytes = arr(conversions)
      .filter((c) => c && c.status === 'done' && !c.convertedDeletedAt)
      .reduce((t, c) => t + num(c.convertedBytes), 0)
    const originalBytes = arr(conversions)
      .filter((c) => c && !c.originalDeleted)
      .reduce((t, c) => t + num(c.originalBytes), 0)

    const tls = adminTlsSnapshot()
    return {
      ok: true,
      users: {
        total: users.length,
        pending: users.filter((u) => u && u.status === 'pending_verification').length,
        revoked: users.filter((u) => u && u.status === 'revoked').length
      },
      requests: { pending: arr(adminStoreGet('accessRequests', [])).filter((r) => r && r.status === 'pending').length },
      flags: { unresolved: arr(flags).filter((f) => f && !f.resolved).length },
      missing: { unresolved: arr(missing).filter((m) => m && !m.resolved).length },
      conversions: {
        queued: countStatus('queued'),
        converting: countStatus('converting'),
        done: countStatus('done'),
        error: countStatus('error')
      },
      library: { movies, shows, episodes },
      storage: { convertedBytes, originalBytes },
      https: { active: tls.active, daysRemaining: tls.daysRemaining }
    }
  }

  // Sorted newest-first exactly like the desktop Flags / Requests tabs.
  const adminFlagList = () =>
    (Array.isArray(adminStoreGet('qualityFlags', [])) ? adminStoreGet('qualityFlags', []) : [])
      .slice()
      .sort((a, b) => (b?.firstFlaggedAt || 0) - (a?.firstFlaggedAt || 0))
  const adminMissingList = () =>
    (Array.isArray(adminStoreGet('missingRequests', [])) ? adminStoreGet('missingRequests', []) : [])
      .slice()
      .sort((a, b) => (b?.firstSeenAt || 0) - (a?.firstSeenAt || 0))

  // --- the background "files that will not play" scan (conversions) ----------
  // One scanner per server, made on first use. Its probe cache sits next to the
  // quality cache in the TMDB cache folder; with no such folder it lives in memory.
  let unplayableScannerInstance = null
  function unplayableScanner() {
    if (unplayableScannerInstance) return unplayableScannerInstance
    let cacheDir = ''
    try { cacheDir = (typeof getTmdbCacheDir === 'function' && getTmdbCacheDir()) || '' } catch { cacheDir = '' }
    unplayableScannerInstance = playabilityScan.createUnplayableScanner({
      probe: convert.probeStreams,
      decide: (pr, ext) => convert.decideFor(pr, ext),
      cache: playabilityScan.createProbeCache({ file: cacheDir ? path.join(cacheDir, 'playability-probe-cache.json') : null }),
      log: (m) => { try { if (typeof log === 'function') log(m) } catch {} }
    })
    return unplayableScannerInstance
  }

  // The whole /api/admin/* surface. Returns nothing; always answers via send.
  // `p` is the trailing-slash-normalised pathname the caller already computed.
  //
  // `presetBody` exists for ONE caller: the server-rendered /admin website
  // pages below. A browser form posts application/x-www-form-urlencoded and
  // the page layer has to read that body itself (it needs `tab` and
  // `confirmed` before it can dispatch), and a request body can only be read
  // once. Passing the already-parsed object in is what lets those pages run
  // the real handler instead of a second copy of every admin rule.
  async function handleAdminRequest(req, res, url, p, method, apiUser, send, presetBody) {
    // --- gate 1: transport ---------------------------------------------
    // Checked FIRST, before isAdmin, so a plaintext probe learns nothing at
    // all about who is or is not an admin on this server.
    if (!adminRequestIsSecure(req)) {
      send(403, { ok: false, error: 'https_required' })
      return
    }
    // --- gate 2: identity ----------------------------------------------
    if (!apiUser || !apiUser.isAdmin) {
      send(403, { ok: false, error: 'admin_only' })
      return
    }

    // Migration importer (migrationApi.js): owner-only, so it sits behind the two gates above. The
    // body can be an uploaded export, so an oversized one is refused before it is read.
    if (p === '/api/admin/migration' || p.startsWith('/api/admin/migration/')) {
      if (Number(req.headers['content-length'] || 0) > 200 * 1024 * 1024) { send(413, { ok: false, error: 'too_big' }); return }
      const migBody = method === 'POST' ? (presetBody && typeof presetBody === 'object' ? presetBody : await apiReadBody(req)) : {}
      const out = await migrationHandle(method, p.slice('/api/admin/migration'.length), url.searchParams, migBody, apiUser, 'http')
      send(out.status, out.body)
      return
    }

    const post = () => {
      if (method === 'POST') return true
      send(405, { ok: false, error: 'method_not_allowed' })
      return false
    }
    const body = method === 'POST' ? (presetBody && typeof presetBody === 'object' ? presetBody : await apiReadBody(req)) : {}
    const str = (v) => (v === null || v === undefined ? '' : String(v)).trim()
    // Defensive boolean: JSON true, the string "true"/"1", or the number 1.
    const bool = (v) => v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true'
    const findUser = (id) => {
      try {
        return auth.getUsers(store).find((u) => u.id === id) || null
      } catch {
        return null
      }
    }
    const usersOut = () => {
      let list = []
      let seen = {}
      try {
        list = auth.getUsers(store)
      } catch {
        list = []
      }
      try {
        seen = auth.getLastSeenMap(store) || {}
      } catch {
        seen = {}
      }
      return list.map((u) => adminSafeUser(u, seen))
    }

    // ------------------------------------------------------ parental controls
    //   GET  /api/admin/parental                       -> { options, pinSet, users: [{ id, name, username, isAdmin, policy }] }
    //   POST /api/admin/parental/set { userId, preset, extra? } | { userId, policy }
    //   POST /api/admin/parental/pin { pin, currentPin? } | { clear: true, currentPin }
    if (p === '/api/admin/parental') {
      const users = auth.getUsers(store).filter((u) => u && u.status === 'approved').map((u) => ({
        id: u.id, name: u.name || '', username: u.username || '', isAdmin: !!u.isAdmin,
        policy: parental.getPolicy(store, u.id), adult: u.adult === true, viewingHistoryPrivate: u.viewingHistoryPrivate === true,
      }))
      send(200, { ok: true, options: parental.editorOptions(), pinSet: !!store.get('parentalPin'), users })
      return
    }
    if (p === '/api/admin/parental/set') {
      if (!post()) return
      const target = findUser(str(body.userId))
      if (!target) { send(404, { ok: false, error: 'not_found' }); return }
      const next = typeof body.preset === 'string' && body.preset !== 'custom'
        ? parental.presetPolicy(body.preset, body.extra && typeof body.extra === 'object' ? body.extra : {})
        : body.policy
      // An admin runs the server; limiting their own profile would lock the owner out of Admin.
      if (target.isAdmin && parental.normalizePolicy(next).enabled) { send(409, { ok: false, error: 'admin_profile', message: 'Turn off admin for this person first.' }); return }
      const saved = parental.setPolicy(store, target.id, next)
      send(200, { ok: true, userId: target.id, policy: saved })
      return
    }
    if (p === '/api/admin/parental/pin') {
      if (!post()) return
      const rec = store.get('parentalPin')
      if (rec && rec.hash) {
        const key = 'pin:' + apiUser.id
        const wait = parentalPinLimiter.locked(key)
        if (wait) { send(429, { ok: false, error: 'locked', minutesRemaining: wait }); return }
        if (!parental.pinMatches(rec, str(body.currentPin))) { parentalPinLimiter.fail(key); send(401, { ok: false, error: 'wrong_pin' }); return }
        parentalPinLimiter.clear(key)
      }
      if (bool(body.clear)) { store.delete('parentalPin'); send(200, { ok: true, pinSet: false }); return }
      if (!parental.PIN_RE.test(str(body.pin))) { send(400, { ok: false, error: 'bad_pin', message: 'Use 4 to 8 digits.' }); return }
      store.set('parentalPin', parental.hashPin(str(body.pin)))
      send(200, { ok: true, pinSet: true })
      return
    }

    // ---------------------------------------------------------- library shares
    //   GET  /api/admin/shares                         -> { termsVersion, statement, maxShares, shares }
    //   POST /api/admin/shares/create { guestEmail, guestLabel?, consent: { accepted, termsVersion },
    //                                   libraries?, folders?, collections?, expiresAt?, maxStreams?,
    //                                   downloads?, parentalPreset? | parental? }
    //   POST /api/admin/shares/update { id, ...same scope fields }
    //   POST /api/admin/shares/revoke { id }
    if (p === '/api/admin/shares') {
      libraryShares.prune(store)
      send(200, {
        ok: true,
        termsVersion: libraryShares.SHARE_TERMS_VERSION,
        statement: libraryShares.SHARE_CONSENT_STATEMENT,
        maxShares: libraryShares.MAX_ACTIVE_SHARES,
        libraryFolders: { movies: allMoviesDirs(), tv: allTvShowsDirs() },
        shares: libraryShares.list(store).map(libraryShares.ownerShape),
      })
      return
    }
    if (p === '/api/admin/shares/create') {
      if (!post()) return
      const out = libraryShares.create(store, {
        guestEmail: body.guestEmail,
        guestLabel: body.guestLabel,
        ownerUserId: apiUser.id,
        consent: body.consent && typeof body.consent === 'object' ? { accepted: bool(body.consent.accepted), termsVersion: str(body.consent.termsVersion) } : null,
        scope: body,
      })
      if (!out.ok) { send(400, out); return }
      log(`library shared with a guest from another household (${out.share.id})`)
      requestShareSync()
      send(200, { ok: true, share: libraryShares.ownerShape(out.share) })
      return
    }
    if (p === '/api/admin/shares/update') {
      if (!post()) return
      const out = libraryShares.update(store, str(body.id), body)
      if (!out.ok) { send(out.error === 'not_found' ? 404 : 400, out); return }
      requestShareSync()
      send(200, { ok: true, share: libraryShares.ownerShape(out.share) })
      return
    }
    if (p === '/api/admin/shares/revoke') {
      if (!post()) return
      const out = libraryShares.revoke(store, str(body.id))
      if (!out.ok) { send(404, out); return }
      libraryShares.purgeGuestData(store, out.share.id, history)
      log(`library share ${out.share.id} revoked`)
      requestShareSync()
      send(200, { ok: true, share: libraryShares.ownerShape(out.share) })
      return
    }

    // ---------------------------------------------------------------- API keys
    // Personal keys for outside tools; they only ever open /api/v1 (publicApi.js). The owner sees and
    // can remove everyone's; each person makes and removes their own with /api/me/api-keys.
    //   GET  /api/admin/api-keys                       -> { scopes, maxKeys, defaultRatePerMinute, metrics, keys }
    //   POST /api/admin/api-keys/create { name, scopes?, ratePerMinute? } -> { key, token }
    //        `token` is the only time the secret exists in plaintext: only its hash is kept.
    //   POST /api/admin/api-keys/revoke { id }         -> { key }; the key stops working at once
    //   POST /api/admin/metrics { enabled }            -> { metrics: { enabled } }  (Prometheus /metrics, off by default)
    if (p === '/api/admin/api-keys') {
      const names = new Map(auth.getUsers(store).map((u) => [u && u.id, (u && (u.name || u.username)) || '']))
      send(200, {
        ok: true,
        scopes: publicApi.SCOPES,
        maxKeys: apiKeys.MAX_KEYS,
        defaultRatePerMinute: apiKeys.DEFAULT_RATE_PER_MINUTE,
        metrics: { enabled: metrics.isEnabled(store) },
        keys: apiKeys.list(store).map((k) => ({ ...k, ownerName: names.get(k.ownerUserId) || null })),
      })
      return
    }
    if (p === '/api/admin/metrics') {
      if (method === 'GET') { send(200, { ok: true, metrics: { enabled: metrics.isEnabled(store) } }); return }
      if (!post()) return
      const on = metrics.setEnabled(store, bool(body.enabled))
      log(`Prometheus metrics turned ${on ? 'on' : 'off'}`)
      send(200, { ok: true, metrics: { enabled: on } })
      return
    }
    if (p === '/api/admin/api-keys/create') {
      if (!post()) return
      const out = apiKeys.create(store, {
        name: body.name,
        scopes: Array.isArray(body.scopes) ? body.scopes : undefined,
        ratePerMinute: body.ratePerMinute,
        ownerUserId: apiUser.id,
        allowedScopes: apiKeys.scopesFor(apiUser),
      })
      if (!out.ok) { send(400, out); return }
      log(`API key "${out.key.name}" created`)
      send(200, { ok: true, key: out.key, token: out.token })
      return
    }
    if (p === '/api/admin/api-keys/revoke') {
      if (!post()) return
      const out = apiKeys.revoke(store, str(body.id))
      if (!out.ok) { send(404, out); return }
      log(`API key "${out.key.name}" revoked`)
      send(200, { ok: true, key: out.key })
      return
    }

    // ---------------------------------------------------------------- webhooks
    // Signed outbound POSTs to the owner's own tools (electron/webhooks.js).
    //   GET  /api/admin/webhooks                        -> { events, formats, maxHooks, hooks, log }
    //   POST /api/admin/webhooks/create { name, url, events[], allowPrivateNetwork?, format?, credentials?,
    //                                     titleTemplate?, messageTemplate? } -> { hook, secret }
    //        `secret` is shown once; a target on a private/LAN address is refused unless
    //        allowPrivateNetwork is true, and link-local / metadata addresses are always refused.
    //        `format` is json (default) | ntfy | discord | slack | gotify | pushover; credentials are
    //        stored encrypted and never listed (only their names come back).
    //   POST /api/admin/webhooks/update { id, name?, url?, events?, enabled?, allowPrivateNetwork?, format?, credentials?, titleTemplate?, messageTemplate? }
    //   POST /api/admin/webhooks/rotate-secret { id }   -> { secret } (the old one stops verifying)
    //   POST /api/admin/webhooks/test { id }            -> { delivery: { ok, status, error, ms } }  (sent in the webhook's own format)
    //   POST /api/admin/webhooks/delete { id }
    //   POST /api/admin/webhooks/clear-log
    if (p === '/api/admin/webhooks') {
      send(200, { ok: true, events: webhooks.EVENTS, formats: webhookFormats.FORMATS, maxHooks: webhooks.MAX_HOOKS, hooks: webhooks.list(store), log: webhooks.getLog(store) })
      return
    }
    if (p === '/api/admin/webhooks/create') {
      if (!post()) return
      const out = await webhooks.create(store, {
        name: body.name,
        url: body.url,
        events: Array.isArray(body.events) ? body.events : undefined,
        allowPrivateNetwork: bool(body.allowPrivateNetwork),
        format: body.format,
        credentials: body.credentials,
        titleTemplate: body.titleTemplate,
        messageTemplate: body.messageTemplate,
      })
      if (!out.ok) { send(400, out); return }
      log(`webhook "${out.hook.name}" created`)
      announceNewLibraryItems().catch(() => {})
      send(200, { ok: true, hook: out.hook, secret: out.secret })
      return
    }
    if (p === '/api/admin/webhooks/update') {
      if (!post()) return
      const patch = {}
      for (const k of ['name', 'url', 'events', 'format', 'credentials', 'titleTemplate', 'messageTemplate']) if (body[k] !== undefined) patch[k] = body[k]
      for (const k of ['enabled', 'allowPrivateNetwork']) if (body[k] !== undefined) patch[k] = bool(body[k])
      const out = await webhooks.update(store, str(body.id), patch)
      if (!out.ok) { send(out.error === 'not_found' ? 404 : 400, out); return }
      announceNewLibraryItems().catch(() => {})
      send(200, { ok: true, hook: out.hook })
      return
    }
    if (p === '/api/admin/webhooks/rotate-secret') {
      if (!post()) return
      const out = webhooks.rotateSecret(store, str(body.id))
      if (!out.ok) { send(404, out); return }
      send(200, { ok: true, hook: out.hook, secret: out.secret })
      return
    }
    if (p === '/api/admin/webhooks/test') {
      if (!post()) return
      const out = await webhooks.sendTest(store, str(body.id))
      if (!out.ok) { send(404, out); return }
      send(200, { ok: true, delivery: out.delivery })
      return
    }
    if (p === '/api/admin/webhooks/delete') {
      if (!post()) return
      const out = webhooks.remove(store, str(body.id))
      if (!out.ok) { send(404, out); return }
      log(`webhook "${out.hook.name}" removed`)
      send(200, { ok: true, hook: out.hook })
      return
    }
    if (p === '/api/admin/webhooks/clear-log') {
      if (!post()) return
      webhooks.clearLog(store)
      send(200, { ok: true })
      return
    }

    // ---------------------------------------------------------------- summary
    // -------------------------------------------------------------- dashboard
    // GET ?sections=now,bandwidth,health,activity,library&days=7|30. The phone
    // polls the cheap sections every few seconds while the screen is open.
    if (p === '/api/admin/dashboard') {
      const sections = String(url.searchParams.get('sections') || '').split(',').map((s) => s.trim()).filter(Boolean)
      const days = Number(url.searchParams.get('days')) === 30 ? 30 : 7
      try {
        send(200, await serverDashboard.snapshot({ sections, days, viewer: apiUser }))
      } catch (e) {
        send(200, { ok: false, error: 'dashboard_failed' })
      }
      return
    }
    // POST { streamId }. Owner only: another admin can watch the dashboard but
    // not cut a member off.
    if (p === '/api/admin/dashboard/stop') {
      if (!post()) return
      if (!serverDashboard.canStopStreams(apiUser)) {
        send(403, { ok: false, error: 'owner_only' })
        return
      }
      const result = serverDashboard.stopStream(str(body.streamId))
      if (result.ok && typeof log === 'function') log(`owner stopped a stream (${str(body.streamId)})`)
      send(result.ok ? 200 : 404, result)
      return
    }

    // Speech Pack (electron/addons/speechPack): the AI subtitle queue. OWNER only - it uses this PC's CPU and
    // writes files into the library. GET status | POST /enqueue { kind, id, language?, translate? } | POST /cancel { id }.
    if (p === '/api/admin/ai-subtitles' || p.startsWith('/api/admin/ai-subtitles/')) {
      if (!serverDashboard.canStopStreams(apiUser)) { send(403, { ok: false, error: 'owner_only' }); return }
      const out = await speechPack.adminApi(method, p.slice('/api/admin/ai-subtitles'.length), body)
      send(out.status, out.body)
      return
    }

    if (p === '/api/admin/summary') {
      send(200, await adminSummary())
      return
    }

    // ------------------------------------------------------------ suggestions
    if (p === '/api/admin/suggestions') {
      send(200, { ok: true, suggestions: (store.get('featureSuggestions') || []) })
      return
    }
    if (p === '/api/admin/suggestions/resolve' || p === '/api/admin/suggestions/delete') {
      if (!post()) return
      const id = str(body.id)
      let list = store.get('featureSuggestions') || []
      if (p === '/api/admin/suggestions/delete') {
        list = list.filter((s) => s && s.id !== id)
      } else {
        list = list.map((s) => (s && s.id === id ? Object.assign({}, s, { status: 'done' }) : s))
      }
      store.set('featureSuggestions', list)
      send(200, { ok: true, suggestions: list })
      return
    }

    // ----------------------------------------------------------------- inbox
    // The Beebo Inbox (electron/inbox.js): status and the owner's buttons. Every
    // move it makes is undoable, and none of these routes can delete anything.
    if (p === '/api/admin/inbox') {
      send(200, { ok: true, available: !!inbox, inbox: inbox ? inbox.status() : null })
      return
    }
    if (p.startsWith('/api/admin/inbox/')) {
      if (!post()) return
      if (!inbox) { send(503, { ok: false, error: 'inbox_not_running' }); return }
      const action = p.slice('/api/admin/inbox/'.length)
      let out = null
      if (action === 'sort-now') out = { ok: true, inbox: await inbox.sortNow() }
      else if (action === 'pause') out = { ok: true, inbox: inbox.setPaused(bool(body.paused)) }
      else if (action === 'enabled') out = { ok: true, inbox: inbox.setEnabled(bool(body.enabled)) }
      else if (action === 'undo-last') out = await inbox.undoLast()
      else if (action === 'put-back') out = await inbox.putBack(str(body.undoId))
      else if (action === 'retry') out = await inbox.retry(str(body.id))
      else if (action === 'open-folder') out = inbox.openFolder ? await inbox.openFolder() : { ok: false, error: 'inbox_not_running' }
      else if (action === 'file-as') {
        const choice = {}
        if (str(body.tmdbId)) choice.tmdbId = Number(str(body.tmdbId))
        else {
          choice.kind = str(body.kind)
          for (const k of ['title', 'year', 'show', 'season', 'episode']) if (str(body[k])) choice[k] = str(body[k])
        }
        out = await inbox.fileAs(str(body.id), choice)
      } else { send(404, { ok: false, error: 'not_found' }); return }
      if (out && out.ok === false && !out.error) out.error = 'server_error'
      send(out && out.ok === false ? 400 : 200, out || { ok: false, error: 'server_error' })
      return
    }

    // ---------------------------------------------------------------- titles
    // The "Titles to check" list: every file the matcher refused to guess at.
    // Reads come straight out of electron-store and the on-disk poster cache —
    // NO network call renders this page, which is the point. Only the
    // "search again" write below ever touches TMDB.
    if (p === '/api/admin/titles') {
      const cacheDir = getTmdbCacheDir ? getTmdbCacheDir() : null
      const queue = titleMatch.getReviewQueue(store)
      const decisions = titleMatch.getDecisions(store)
      const titles = Object.values(queue)
        .filter((e) => e && e.fileName && !decisions[e.fileName])
        .sort((a, b) => (b.queuedAt || 0) - (a.queuedAt || 0))
        .map((e) => Object.assign({}, e, {
          candidates: (e.candidates || []).map((c) =>
            Object.assign({}, c, {
              // Whether the page can draw a real thumbnail, decided from disk.
              hasLocalPoster: !!(cacheDir && c && c.id != null && tmdbFileCache.localPosterPath(cacheDir, c.id))
            })
          )
        }))
      let decided = 0
      let notAFilm = 0
      for (const d of Object.values(decisions)) {
        if (!d) continue
        if (d.notAMovie || d.kind === 'none') notAFilm += 1
        else decided += 1
      }
      send(200, { ok: true, titles, decided, notAFilm })
      return
    }
    if (p === '/api/admin/titles/pick' || p === '/api/admin/titles/not-a-film' || p === '/api/admin/titles/search') {
      if (!post()) return
      const fileName = str(body.fileName)
      if (!fileName) { send(400, { ok: false, error: 'missing_fileName' }); return }
      const queue = titleMatch.getReviewQueue(store)
      const entry = queue[fileName]
      const cacheDir = getTmdbCacheDir ? getTmdbCacheDir() : null

      if (p === '/api/admin/titles/not-a-film') {
        // Why this exists: the Movies folder holds trance mixes, a wedding video
        // and a handful of clips that are not in TMDB and never will be. Without
        // a way to say so they are re-queried on every re-check for ever and
        // come straight back to the top of this list.
        titleMatch.markNotAMovie(store, fileName, (apiUser && apiUser.name) || null)
        titleMatch.dequeueReview(store, fileName)
        writeManifestMatch(cacheDir, fileName, null)
        send(200, { ok: true, fileName })
        return
      }

      if (p === '/api/admin/titles/search') {
        const q = str(body.query)
        if (!q) { send(400, { ok: false, error: 'missing_query' }); return }
        const key = store.get('tmdbApiKey') || process.env.TMDB_API_KEY
        const api = titleMatch.createTmdbApi(key)
        // The ONLY route on this page that needs the internet. It fails with a
        // plain message rather than half-writing anything.
        if (!api) { send(400, { ok: false, error: 'no_api_key' }); return }
        const parsed = { title: q, year: null, imdbId: null, episode: entry && entry.kind === 'tv' ? { season: 1, episode: 1 } : null }
        const verdict = await titleMatch.matchParsed(parsed, api)
        if (verdict.reason === 'network_error') { send(502, { ok: false, error: 'tmdb_unreachable' }); return }
        // Deliberately does NOT auto-accept a certain/probable verdict: the owner
        // asked a question and is owed the answers, not a silent write.
        titleMatch.queueForReview(store, fileName, Object.assign({}, verdict, { reason: 'searched_again', confidence: 'unsure' }),
          Object.assign({}, entry ? { currentMatch: entry.currentMatch || null } : {}, entry && entry.inbox ? { inbox: entry.inbox } : {}, { searchedFor: q }))
        await cacheReviewPosters(cacheDir, verdict.candidates)
        send(200, { ok: true, fileName, found: (verdict.candidates || []).length })
        return
      }

      // pick
      const tmdbId = Number(str(body.tmdbId))
      if (!Number.isFinite(tmdbId) || !tmdbId) { send(400, { ok: false, error: 'missing_tmdbId' }); return }
      const chosen = ((entry && entry.candidates) || []).find((c) => c && Number(c.id) === tmdbId)
      if (!chosen) { send(404, { ok: false, error: 'not_found' }); return }
      // A file waiting in the Beebo Inbox's "_Needs a look": the answer files it
      // (renamed, into Movies or TV Shows), which writes its poster itself.
      if (inbox && inbox.isInboxReviewEntry(entry)) {
        const filed = await inbox.fileAs(entry.inbox.id, { tmdbId, candidate: chosen })
        if (!filed.ok) { send(400, { ok: false, error: filed.error || 'server_error' }); return }
        send(200, { ok: true, fileName, tmdbId, filed: true, to: filed.to || null })
        return
      }
      titleMatch.confirmMatch(store, fileName, chosen, (apiUser && apiUser.name) || null)
      titleMatch.dequeueReview(store, fileName)
      // The candidate carries the whole TMDB row it came from, so the manifest
      // gets exactly what a search would have written — no second lookup, and
      // this works with the internet off.
      if (chosen.kind === 'tv') {
        // A TV episode filed among the movies. Its show goes in the TV manifest
        // (movie ids and tv ids are separate namespaces and share no poster
        // folder); the movie manifest entry stays empty, because the file is not
        // a film. The decision is what stops it being asked about again.
        writeManifestMatch(cacheDir, fileName, null)
        await persistTvMatch(cacheDir, chosen.title, encodeId(String(chosen.title || '').toLowerCase()), chosen.raw || null)
      } else {
        writeManifestMatch(cacheDir, fileName, chosen.raw || null)
        if (cacheDir && chosen.posterPath) {
          try {
            const paths = tmdbFileCache.ensureDirs(cacheDir)
            await tmdbFileCache.downloadImage(`https://image.tmdb.org/t/p/w300${chosen.posterPath}`, path.join(paths.postersDir, `${chosen.id}.jpg`))
          } catch {}
        }
      }
      // The in-memory lookup cache would otherwise keep serving the old answer
      // for the life of this process.
      tmdbCache.delete(fileName)
      send(200, { ok: true, fileName, tmdbId })
      return
    }

    // ------------------------------------------------------------------ users
    if (p === '/api/admin/users/adult') {
      if (!post()) return
      const adult = body.adult === true || body.adult === 'true' ? true : body.adult === false || body.adult === 'false' ? false : null
      const out = viewingPrivacy.setAdult(store, str(body.userId), adult)
      send(out.ok ? 200 : out.error === 'not_found' ? 404 : 409, out)
      return
    }
    if (p === '/api/admin/users') {
      send(200, { ok: true, users: usersOut() })
      return
    }

    if (
      p === '/api/admin/users/approve' ||
      p === '/api/admin/users/reactivate' ||
      p === '/api/admin/users/revoke' ||
      p === '/api/admin/users/set-admin' ||
      p === '/api/admin/users/regenerate-code' ||
      p === '/api/admin/users/delete'
    ) {
      if (!post()) return
      const userId = str(body.userId)
      if (!userId) {
        send(400, { ok: false, error: 'missing_userId' })
        return
      }
      const target = findUser(userId)
      if (!target) {
        send(404, { ok: false, error: 'not_found' })
        return
      }

      // approve (a pending signup) and reactivate (a revoked account) are the
      // same store transition — auth.js offers exactly one, reactivateUser —
      // and both are kept because they are the two words the phone's UI needs.
      // Idempotent: already-approved answers ok with unchanged:true.
      if (p === '/api/admin/users/approve' || p === '/api/admin/users/reactivate') {
        if (target.status === 'approved') {
          send(200, { ok: true, unchanged: true, user: adminSafeUser(target, auth.getLastSeenMap(store)) })
          return
        }
        const result = auth.reactivateUser(store, userId)
        if (!result.ok) { send(result.error === 'household_full' ? 409 : 404, result); return }
        send(200, { ok: true, user: adminSafeUser(findUser(userId) || target, auth.getLastSeenMap(store)) })
        return
      }

      if (p === '/api/admin/users/revoke') {
        if (adminIsLastAdmin(userId)) {
          send(200, { ok: false, error: 'last_admin' })
          return
        }
        auth.revokeUser(store, userId)
        send(200, { ok: true, user: adminSafeUser(findUser(userId) || target, auth.getLastSeenMap(store)) })
        return
      }

      // Removes the person and their personal data on this server (electron/userDeletion.js).
      // The library is untouched. Never the last admin, and never yourself from here: an
      // admin removing themselves uses Settings > Delete my account, which asks for the password.
      if (p === '/api/admin/users/delete') {
        if (adminIsLastAdmin(userId)) {
          send(200, { ok: false, error: 'last_admin' })
          return
        }
        if (userId === apiUser.id) {
          send(200, { ok: false, error: 'use_delete_my_account' })
          return
        }
        const out = userDeletion.purgeUserData(store, userId, { musicRecordingsDir })
        if (out.removed) purgeAudioData(userId)
        send(200, { ok: !!out.removed, deleted: !!out.removed })
        return
      }

      if (p === '/api/admin/users/set-admin') {
        const wantAdmin = bool(body.isAdmin)
        if (!wantAdmin && adminIsLastAdmin(userId)) {
          send(200, { ok: false, error: 'last_admin' })
          return
        }
        auth.setUserAdmin(store, userId, wantAdmin)
        send(200, { ok: true, user: adminSafeUser(findUser(userId) || target, auth.getLastSeenMap(store)) })
        return
      }

      // The one place the API ever returns a credential, and only the one it
      // just minted. It is NOT in GET /api/admin/users, so an admin who loses
      // it regenerates again rather than reading it back.
      if (viewingPrivacy.isPrivate(store, userId)) { send(403, { ok: false, error: 'private_profile_self_recovery', message: viewingPrivacy.RECOVERY_MESSAGE }); return }
      const code = auth.regenerateCode(store, userId)
      send(200, { ok: true, code, user: adminSafeUser(findUser(userId) || target, auth.getLastSeenMap(store)) })
      return
    }

    // --------------------------------------------------------------- requests
    if (p === '/api/admin/requests') {
      const wanted = String(url.searchParams.get('status') || 'pending').toLowerCase()
      let reqs = []
      try {
        reqs = auth.getRequests(store) || []
      } catch {
        reqs = []
      }
      const list = (Array.isArray(reqs) ? reqs : [])
        .filter((r) => r && typeof r === 'object')
        .filter((r) => wanted === 'all' || (r.status || 'pending') === wanted)
        .slice()
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      send(200, {
        ok: true,
        requests: list.map((r) => ({
          id: r.id,
          name: r.name || '',
          email: r.email || '',
          message: r.message || '',
          status: r.status || 'pending',
          createdAt: r.createdAt || null
        }))
      })
      return
    }

    if (p === '/api/admin/requests/approve' || p === '/api/admin/requests/deny') {
      if (!post()) return
      const requestId = str(body.requestId)
      if (!requestId) {
        send(400, { ok: false, error: 'missing_requestId' })
        return
      }
      let reqs = []
      try {
        reqs = auth.getRequests(store) || []
      } catch {
        reqs = []
      }
      if (!(Array.isArray(reqs) ? reqs : []).some((r) => r && r.id === requestId)) {
        send(404, { ok: false, error: 'not_found' })
        return
      }
      if (p === '/api/admin/requests/deny') {
        auth.denyRequest(store, requestId)
        send(200, { ok: true })
        return
      }
      // auth.approveRequest creates the account AND mints its access code —
      // same call the desktop Users tab makes. The code comes back once, for
      // the admin to pass on.
      const result = auth.approveRequest(store, requestId)
      if (result && result.error) { send(409, result); return }
      if (!result || !result.user) {
        send(404, { ok: false, error: 'not_found' })
        return
      }
      send(200, { ok: true, code: result.code, user: adminSafeUser(result.user, auth.getLastSeenMap(store)) })
      return
    }

    // ------------------------------------------------------------------ flags
    if (p === '/api/admin/flags') {
      send(200, { ok: true, flags: adminFlagList() })
      return
    }

    if (p === '/api/admin/flags/resolve' || p === '/api/admin/flags/remove') {
      if (!post()) return
      const id = str(body.id)
      const current = Array.isArray(adminStoreGet('qualityFlags', [])) ? adminStoreGet('qualityFlags', []) : []
      if (!id || !current.some((f) => f && f.id === id)) {
        send(404, { ok: false, error: 'not_found' })
        return
      }
      // Same two store operations the desktop Flags tab performs.
      const next =
        p === '/api/admin/flags/resolve'
          ? current.map((f) => (f && f.id === id ? { ...f, resolved: true } : f))
          : current.filter((f) => !f || f.id !== id)
      store.set('qualityFlags', next)
      send(200, { ok: true, flags: adminFlagList() })
      return
    }

    // ---------------------------------------------------------------- missing
    if (p === '/api/admin/missing') {
      // A requested title that has since been added shows as added, not open.
      try {
        await markArrivedTitleRequests()
      } catch {}
      send(200, { ok: true, missing: adminMissingList() })
      return
    }

    if (p === '/api/admin/missing/resolve' || p === '/api/admin/missing/remove') {
      if (!post()) return
      const id = str(body.id)
      const current = Array.isArray(adminStoreGet('missingRequests', [])) ? adminStoreGet('missingRequests', []) : []
      if (!id || !current.some((r) => r && r.id === id)) {
        send(404, { ok: false, error: 'not_found' })
        return
      }
      const next =
        p === '/api/admin/missing/resolve'
          ? current.map((r) => (r && r.id === id ? { ...r, resolved: true } : r))
          : current.filter((r) => !r || r.id !== id)
      store.set('missingRequests', next)
      if (p === '/api/admin/missing/resolve') {
        webhooks.emitRequestTransition(store, current.find((r) => r && r.id === id), next.find((r) => r && r.id === id))
      }
      send(200, { ok: true, missing: adminMissingList() })
      return
    }

    // ------------------------------------------------------------ conversions
    if (p === '/api/admin/conversions') {
      let list = []
      try {
        list = convert.list(store)
      } catch {
        list = []
      }
      send(200, { ok: true, conversions: list, autoDeleteOriginals: !!store.get('autoDeleteOriginals'), paused: !!store.get('conversionsPaused'), windowStart: (typeof store.get('conversionWindowStart') === 'number' ? store.get('conversionWindowStart') : null), windowEnd: (typeof store.get('conversionWindowEnd') === 'number' ? store.get('conversionWindowEnd') : null), lowDisk: !!store.get('conversionsLowDisk'), scan: unplayableScanner().status(), rulesSummary: store.get(convert.RULES_SUMMARY_KEY) || null })
      return
    }

    // Hide the one-time "Removed N files that play fine as they are" note.
    if (p === '/api/admin/conversions/dismiss-summary') {
      if (!post()) return
      try { convert.dismissRulesSummary(store) } catch {}
      send(200, { ok: true, conversions: convert.list(store) })
      return
    }

    // Toggle "delete originals as they convert". When on, the converter removes each original the
    // moment its converted copy is written, so a big batch never needs double the disk.
    if (p === '/api/admin/conversions/auto-delete') {
      if (!post()) return
      const enabled = !!(body && body.enabled)
      store.set('autoDeleteOriginals', enabled)
      let list = []
      try { list = convert.list(store) } catch { list = [] }
      send(200, { ok: true, autoDeleteOriginals: enabled, conversions: list })
      return
    }

    // Pause / resume ALL conversions. A job already running finishes; nothing new starts while
    // paused. Resuming re-kicks the worker so queued files pick up immediately.
    if (p === '/api/admin/conversions/pause') {
      if (!post()) return
      const paused = !!(body && body.paused)
      store.set('conversionsPaused', paused)
      if (!paused) { try { convert.kick(store) } catch {} }
      let list = []
      try { list = convert.list(store) } catch { list = [] }
      send(200, { ok: true, paused, conversions: list })
      return
    }

    // Set or clear an overnight-only window (hours 0-23). Equal start/end, or anything out of
    // range, clears the window (convert any time). Re-kicks so a change applies right away.
    if (p === '/api/admin/conversions/schedule') {
      if (!post()) return
      const clamp = (v) => (typeof v === 'number' && v >= 0 && v <= 23) ? Math.floor(v) : null
      const s = clamp(body && body.windowStart)
      const e = clamp(body && body.windowEnd)
      if (s === null || e === null || s === e) {
        store.set('conversionWindowStart', null)
        store.set('conversionWindowEnd', null)
      } else {
        store.set('conversionWindowStart', s)
        store.set('conversionWindowEnd', e)
      }
      try { convert.kick(store) } catch {}
      let list = []
      try { list = convert.list(store) } catch { list = [] }
      const ws = store.get('conversionWindowStart'); const we = store.get('conversionWindowEnd')
      send(200, { ok: true, windowStart: (typeof ws === 'number' ? ws : null), windowEnd: (typeof we === 'number' ? we : null), conversions: list })
      return
    }

    // Bulk "fix everything that won't play": scan the whole library and queue every file that truly
    // needs work under playbackRules.decide (the streams decide, never the extension alone), unless
    // watch history shows it already played fine on a device. Parked files ("Don't convert",
    // "not needed") are left parked.
    //
    // It now runs in the background (playabilityScan.js): several ffprobes at once, a probe cache
    // keyed by path + size + mtime so a rescan only probes new or changed files, and files queued
    // in the same order as the old one-at-a-time loop. This answers at once with the job's status;
    // scan-status polls it and scan-cancel stops it (anything already decided is still queued).
    if (p === '/api/admin/conversions/scan-unplayable') {
      if (!post()) return
      const scanner = unplayableScanner()
      const r = scanner.start({
        listFiles: async () => {
          const files = []
          try {
            for (const m of await catalogWalker.scanMoviesMulti(allMoviesDirs())) files.push({ path: path.join(m.dir, m.fileName), kind: 'movie' })
            for (const f of await catalogWalker.scanTvShowsMulti(allTvShowsDirs())) files.push({ path: path.join(f.dir, f.relPath), kind: 'tv' })
          } catch {}
          return files
        },
        onNeeds: (f, decision) => {
          if (!convert.shouldAutoQueue(decision, convert.knownGood(store, f.path))) return false
          const q = convert.enqueue(store, { path: f.path, kind: f.kind, castAvailable: false, decision })
          return !!(q && q.ok && !q.deduped)
        }
      })
      const s = r.scan
      send(200, { ok: true, started: r.started, alreadyRunning: !r.started, scan: s, scanned: s.checked || 0, enqueued: s.enqueued || 0 })
      return
    }
    if (p === '/api/admin/conversions/scan-status') {
      const s = unplayableScanner().status()
      send(200, { ok: true, scan: s, scanned: s.checked || 0, enqueued: s.enqueued || 0 })
      return
    }
    if (p === '/api/admin/conversions/scan-cancel') {
      if (!post()) return
      const r = unplayableScanner().cancel()
      send(200, { ok: true, cancelled: r.cancelled, scan: r.scan })
      return
    }

    // Convert an ENTIRE show now: queue every unplayable episode of one show and jump it to the
    // front of the queue so you don't have to wait for the rest of the library. Files already in a
    // good format are skipped; converting/done/rejected ones are left alone.
    if (p === '/api/admin/conversions/convert-show') {
      if (!post()) return
      const showKey = str(body.showKey)
      if (!showKey) { send(400, { ok: false, error: 'missing_showKey' }); return }
      let scanned = 0, enqueued = 0, prioritized = 0, notNeeded = 0
      const toFront = []
      try {
        const show = (await apiShowMapAsync()).get(showKey)
        const eps = (show && Array.isArray(show.episodes)) ? show.episodes.slice() : []
        eps.sort((a, b) => String(a.relPath).localeCompare(String(b.relPath)))
        for (const ep of eps) {
          const filePath = path.join(ep.dir, ep.relPath)
          scanned++
          const ext = path.extname(filePath).toLowerCase()
          // Same verdict as the bulk scan: only episodes that truly need work and have not
          // already played fine on a device.
          let decision = null
          try {
            decision = convert.decideFor(await convert.probeStreams(filePath), ext)
          } catch { decision = null }
          if (!convert.shouldAutoQueue(decision, convert.knownGood(store, filePath))) { notNeeded++; continue }
          const r = convert.enqueue(store, { path: filePath, kind: 'tv', castAvailable: false, decision })
          if (!r || !r.ok || r.notNeeded) { notNeeded++; continue }
          if (!r.deduped) enqueued++
          toFront.push(filePath)
        }
        // Jump these episodes to the front, in episode order. This used to overwrite queuedAt with
        // 1, 2, 3..., which the conversions pages then showed as "queued 1 Jan 1970".
        try { prioritized = convert.prioritize(store, toFront) } catch {}
        try { convert.kick(store) } catch {}
      } catch (err) { log('convert-show failed: ' + err) }
      send(200, { ok: true, scanned, enqueued, prioritized, notNeeded, conversions: convert.list(store) })
      return
    }

    // Bulk "accept all conversions": for every finished ('done') conversion whose original is still
    // on disk, keep the converted copy and delete the original to reclaim the space. Same per-file
    // safety checks as the single delete-original (converted file exists and is a sane size, the
    // paths differ, and the original sits inside a managed media folder); anything that fails a
    // check is left untouched and counted as skipped.
    if (p === '/api/admin/conversions/accept-all') {
      if (!post()) return
      let all = []
      try { all = convert.list(store) } catch { all = [] }
      const done = (Array.isArray(all) ? all : []).filter((e) => e && e.status === 'done' && !e.originalDeleted)
      let accepted = 0, skipped = 0
      for (const entry of done) {
        try {
          const outStat = fs.statSync(entry.outputPath)
          if (!outStat.isFile() || outStat.size <= ADMIN_MIN_CONVERTED_BYTES) { skipped++; continue }
        } catch { skipped++; continue }
        const resolved = path.resolve(entry.originalPath || '')
        if (!entry.originalPath || resolved === path.resolve(entry.outputPath || '')) { skipped++; continue }
        if (!adminInManagedFolders(resolved)) { skipped++; continue }
        try {
          await fs.promises.rm(resolved, { force: true })
        } catch { skipped++; continue }
        const cur = Array.isArray(adminStoreGet('conversions', [])) ? adminStoreGet('conversions', []) : []
        store.set('conversions', cur.map((e) => (e && e.id === entry.id ? { ...e, originalDeleted: true } : e)))
        accepted++
        log(`admin api accept-all deleted original: ${resolved}`)
      }
      send(200, { ok: true, accepted, skipped, conversions: convert.list(store) })
      return
    }

    if (
      p === '/api/admin/conversions/retry' ||
      p === '/api/admin/conversions/dont-convert' ||
      p === '/api/admin/conversions/convert-anyway' ||
      p === '/api/admin/conversions/delete-original' ||
      p === '/api/admin/conversions/delete-converted' ||
      p === '/api/admin/conversions/forget'
    ) {
      if (!post()) return
      const id = str(body.id)
      let list = []
      try {
        list = convert.list(store)
      } catch {
        list = []
      }
      const entry = (Array.isArray(list) ? list : []).find((e) => e && e.id === id) || null
      if (!id || !entry) {
        send(404, { ok: false, error: 'not_found' })
        return
      }

      if (p === '/api/admin/conversions/retry') {
        send(200, { ok: true, conversions: convert.retry(store, id) })
        return
      }

      // Per-file overrides. Neither touches a file on disk.
      if (p === '/api/admin/conversions/dont-convert') {
        send(200, convert.dontConvert(store, id))
        return
      }
      if (p === '/api/admin/conversions/convert-anyway') {
        send(200, convert.convertAnyway(store, id))
        return
      }

      // Never touches a file — just drops the row.
      if (p === '/api/admin/conversions/forget') {
        send(200, { ok: true, conversions: convert.forgetEntry(store, id) })
        return
      }

      if (p === '/api/admin/conversions/delete-original') {
        // main.js's 'convert:deleteOriginal', rule for rule (see the comment
        // block above for why it is restated here rather than required).
        if (entry.status !== 'done' || entry.originalDeleted) {
          send(200, { ok: false, error: 'not_deletable', conversions: convert.list(store) })
          return
        }
        try {
          const outStat = fs.statSync(entry.outputPath)
          if (!outStat.isFile() || outStat.size <= ADMIN_MIN_CONVERTED_BYTES) {
            send(200, { ok: false, error: 'converted_file_too_small', conversions: convert.list(store) })
            return
          }
        } catch {
          send(200, { ok: false, error: 'converted_file_missing', conversions: convert.list(store) })
          return
        }
        const resolved = path.resolve(entry.originalPath || '')
        if (!entry.originalPath || resolved === path.resolve(entry.outputPath || '')) {
          send(200, { ok: false, error: 'invalid_path', conversions: convert.list(store) })
          return
        }
        if (!adminInManagedFolders(resolved)) {
          send(200, { ok: false, error: 'outside_managed_folders', conversions: convert.list(store) })
          return
        }
        try {
          await fs.promises.rm(resolved, { force: true })
        } catch (err) {
          send(200, { ok: false, error: String(err), conversions: convert.list(store) })
          return
        }
        const updated = (Array.isArray(adminStoreGet('conversions', [])) ? adminStoreGet('conversions', []) : []).map(
          (e) => (e && e.id === id ? { ...e, originalDeleted: true } : e)
        )
        store.set('conversions', updated)
        log(`admin api deleted original after conversion: ${resolved}`)
        send(200, { ok: true, conversions: convert.list(store) })
        return
      }

      // delete-converted — main.js's 'convert:deleteConverted', rule for rule.
      // Never let the last copy go: once the original has been deleted, the converted file is the
      // only one left, so refuse (the UI also hides the button, this is the belt-and-braces guard).
      if (entry.originalDeleted) {
        send(200, { ok: false, error: 'only_copy', conversions: convert.list(store) })
        return
      }
      if (!entry.outputPath) {
        send(200, { ok: false, error: 'no_output_path', conversions: convert.list(store) })
        return
      }
      if (path.resolve(entry.outputPath) === path.resolve(entry.originalPath || '')) {
        send(200, { ok: false, error: 'invalid_path', conversions: convert.list(store) })
        return
      }
      if (!adminInManagedFolders(entry.outputPath)) {
        send(200, { ok: false, error: 'outside_managed_folders', conversions: convert.list(store) })
        return
      }
      // Marks the row 'rejected' as well as deleting the file, which is what
      // stops the website re-queueing the same original straight away.
      send(200, convert.rejectConversion(store, id))
      return
    }

    // ---------------------------------------------------------------- markers
    if (p === '/api/admin/markers') {
      send(200, { ok: true, markers: getPlaybackMarkers(store) })
      return
    }

    if (p === '/api/admin/markers/clear') {
      if (!post()) return
      const scope = body.scope === 'show' ? 'show' : 'movie'
      const key = str(body.key)
      if (!key) {
        send(400, { ok: false, error: 'missing_key' })
        return
      }
      const rows = getPlaybackMarkers(store)
      const next = rows.filter((r) => !(r.scope === scope && String(r.key || '') === key))
      if (next.length === rows.length) {
        send(404, { ok: false, error: 'not_found' })
        return
      }
      // Clearing REMOVES the row rather than nulling both numbers through
      // recordPlaybackMarker, which would leave a row behind and re-stamp
      // `setBy` with the admin who cleared it — misleading in the Markers list.
      store.set('playbackMarkers', next)
      send(200, { ok: true, markers: getPlaybackMarkers(store) })
      return
    }

    // ------------------------------------------- automatic intro/credits markers
    if (p === '/api/admin/markers/auto') {
      send(200, { ok: true, enabled: autoMarkersEnabled(), status: autoMarkerScanner.status(), shows: autoMarkerScanner.summary() })
      return
    }

    if (p === '/api/admin/markers/auto/rescan' || p === '/api/admin/markers/auto/clear') {
      if (!post()) return
      const scope = body.scope === 'show' ? 'show' : 'movie'
      const key = str(body.key)
      if (!key) {
        send(400, { ok: false, error: 'missing_key' })
        return
      }
      const rescan = p.endsWith('/rescan')
      if (scope === 'show') {
        send(200, { ok: true, ...(rescan ? autoMarkerScanner.rescanShow(key) : autoMarkerScanner.clearShow(key)) })
        return
      }
      const file = libraryFileFor('movie', encodeId(key))
      if (!file) {
        send(404, { ok: false, error: 'not_found' })
        return
      }
      send(200, { ok: true, ...(rescan ? autoMarkerScanner.rescanFile(file) : autoMarkerScanner.clearFile(file)) })
      return
    }

    // ---------------------------------------------------------------- history
    if (p === '/api/admin/history') {
      let rows = []
      try {
        rows = viewingPrivacy.publicHistory(store, history.getHistory(store))
      } catch {
        rows = []
      }
      // Newest first, same as the desktop History tab (which reverses the
      // append-ordered store list).
      send(200, {
        ok: true,
        items: (Array.isArray(rows) ? rows : [])
          .slice()
          .reverse()
          .map((r) => ({
            sessionId: r.sessionId,
            userId: r.userId,
            userName: r.userName || '',
            kind: r.kind === 'tv' ? 'tv' : 'movie',
            fileName: r.fileName,
            title: r.title,
            startedAt: r.startedAt || null,
            lastUpdate: r.lastUpdate || null,
            currentTime: Number(r.currentTime) || 0,
            duration: Number(r.duration) || 0
          }))
      })
      return
    }

    if (p === '/api/admin/history/clear') {
      if (!post()) return
      const userId = str(body.userId)
      const scope = String(body.scope || '').toLowerCase()
      if (!userId) {
        send(400, { ok: false, error: 'missing_userId' })
        return
      }
      if (!['one', 'show', 'all'].includes(scope)) {
        send(400, { ok: false, error: 'bad_scope' })
        return
      }
      // Exactly the helper POST /history/clear and POST /api/history/clear
      // use — history.clearAllHistory / clearHistoryForTitle /
      // clearHistoryEntry — just with an admin-supplied userId instead of the
      // caller's own. There is still only one definition of what each scope
      // means.
      if (viewingPrivacy.isPrivate(store, userId)) { send(403, { ok: false, error: 'private_history' }); return }
      const removed = applyHistoryClear(userId, { scope, title: body.title, fileName: body.fileName })
      send(200, { ok: true, removed: Number(removed) || 0 })
      return
    }

    // --------------------------------------------------------------- settings
    if (p === '/api/admin/settings') {
      if (method === 'POST') {
        const entries = Object.entries(body || {})
        if (!entries.length) {
          send(400, { ok: false, error: 'nothing_to_set' })
          return
        }
        const updates = []
        for (const [key, value] of entries) {
          if (ADMIN_SECRET_SETTING_KEYS.has(key)) {
            send(200, { ok: false, error: 'not_remotely_settable', field: key })
            return
          }
          if (ADMIN_SETTABLE_DIR_KEYS.includes(key)) {
            const dir = str(value)
            if (!dir) {
              send(400, { ok: false, error: 'bad_value', field: key })
              return
            }
            // The desktop equivalent is a folder picker, which can only ever
            // return a directory that exists — so does this.
            if (!adminIsRealDir(dir)) {
              send(200, { ok: false, error: 'not_a_directory', field: key })
              return
            }
            updates.push([key === 'newFilesDir' ? 'inboxDir' : key, dir])
            continue
          }
          if (ADMIN_SETTABLE_DIR_LIST_KEYS.includes(key)) {
            if (!Array.isArray(value)) {
              send(400, { ok: false, error: 'bad_value', field: key })
              return
            }
            const dirs = []
            for (const raw of value) {
              const dir = str(raw)
              if (!dir || !adminIsRealDir(dir)) {
                send(200, { ok: false, error: 'not_a_directory', field: key, value: dir })
                return
              }
              if (!dirs.includes(dir)) dirs.push(dir)
            }
            updates.push([key, dirs])
            continue
          }
          if (ADMIN_SETTABLE_BOOL_KEYS.includes(key)) {
            if (typeof value !== 'boolean') {
              send(400, { ok: false, error: 'bad_value', field: key })
              return
            }
            updates.push([key, value])
            continue
          }
          if (Object.prototype.hasOwnProperty.call(ADMIN_SETTABLE_INT_KEYS, key)) {
            const spec = ADMIN_SETTABLE_INT_KEYS[key]
            const num = Math.round(Number(value))
            if (!Number.isFinite(num) || num < spec.min || num > spec.max) {
              send(400, { ok: false, error: 'bad_value', field: key })
              return
            }
            updates.push([key, num])
            continue
          }
          // Anything else is simply not part of the remote surface. Reported
          // distinctly from a secret so the app can tell "refused on purpose"
          // from "this build doesn't know that field".
          send(200, { ok: false, error: 'not_settable', field: key })
          return
        }
        // Applied only once EVERY field validated — a request that names one
        // good folder and one bad one changes nothing.
        for (const [key, value] of updates) store.set(key, value)
        // The Inbox watches its folder, and its default spot follows Movies.
        if (inbox && updates.some(([k]) => k === 'inboxDir' || k === 'moviesDir' || k === 'tvShowsDir')) {
          try { inbox.reconfigure() } catch {}
        }
        log(`admin api updated settings: ${updates.map(([k]) => k).join(', ')}`)
        send(200, { ok: true, changed: updates.map(([k]) => k), settings: adminSettingsView() })
        return
      }
      send(200, { ok: true, settings: adminSettingsView() })
      return
    }

    // Unknown /api/admin/* path. Reached only by an authenticated admin over
    // TLS, so it can say so plainly.
    send(404, { ok: false, error: 'not_found' })
  }

  // The safe subset. Secrets appear ONLY as booleans; there is no query
  // parameter, header or debug flag that turns them back into values.
  function adminSettingsView() {
    const callGetter = (fn, key, fallback) => {
      try {
        if (typeof fn === 'function') return fn() || adminStoreGet(key, fallback)
      } catch {}
      return adminStoreGet(key, fallback)
    }
    const tls = adminTlsSnapshot()
    const tmdbKey = adminStoreGet('tmdbApiKey', '') || process.env.TMDB_API_KEY || ''
    let emailConfigured = false
    try {
      emailConfigured = !!mailer.isConfigured(store)
    } catch {
      emailConfigured = false
    }
    return {
      folders: {
        moviesDir: callGetter(getMoviesDir, 'moviesDir', ''),
        tvShowsDir: callGetter(getTvShowsDir, 'tvShowsDir', ''),
        inboxDir: adminInboxDir(),
        // Same folder, under the old name, for phone apps that still ask for it.
        newFilesDir: adminInboxDir(),
        spaceSaverDir: adminStoreGet('spaceSaverDir', ''),
        viewerAppDir: callGetter(getViewerAppDir, 'viewerAppDir', ''),
        tmdbCacheDir: callGetter(getTmdbCacheDir, 'tmdbCacheDir', ''),
        extraMoviesDirs: Array.isArray(adminStoreGet('extraMoviesDirs', [])) ? adminStoreGet('extraMoviesDirs', []) : [],
        extraTvShowsDirs: Array.isArray(adminStoreGet('extraTvShowsDirs', [])) ? adminStoreGet('extraTvShowsDirs', []) : []
      },
      domain: (() => {
        try {
          return certDomainFor() || adminStoreGet('certDomain', '')
        } catch {
          return adminStoreGet('certDomain', '')
        }
      })(),
      port: ACTIVE_PORT,
      // Booleans, never values — see ADMIN_SECRET_SETTING_KEYS.
      secrets: {
        tmdbApiKeyConfigured: !!String(tmdbKey || '').trim(),
        emailPasswordConfigured: !!String(adminStoreGet('emailAppPassword', '') || '').trim(),
        emailConfigured,
        duckdnsTokenConfigured: !!String(adminStoreGet('duckdnsToken', '') || '').trim()
      },
      https: tls,
      // The conversion pipeline has no user-configurable settings today: the
      // ffmpeg arguments are fixed in convert.js. Reported so the phone can
      // show what it will do, and deliberately absent from the POST allowlist
      // because there is nothing there to set.
      conversion: {
        configurable: false,
        videoCodec: 'libx264',
        preset: 'veryfast',
        crf: 20,
        audioCodec: 'aac',
        audioBitrate: '192k',
        minConvertedBytesBeforeOriginalDeletable: ADMIN_MIN_CONVERTED_BYTES
      },
      login: {
        lockoutThreshold: (() => {
          try {
            return auth.getLockoutThreshold(store)
          } catch {
            return null
          }
        })(),
        lockoutDurationMinutes: (() => {
          try {
            return auth.getLockoutDurationMinutes(store)
          } catch {
            return null
          }
        })(),
        alertThreshold: (() => {
          try {
            return auth.getAlertThreshold(store)
          } catch {
            return null
          }
        })()
      },
      // New account requests: when false the public /request-access page is closed.
      allowNewAccounts: adminStoreGet('allowNewAccounts', true) !== false,
      // TV sign-in from a phone-approved token (POST /api/viewer-session): on at home and away unless switched off.
      allowViewerExchange: adminStoreGet('allowViewerExchange', true) !== false,
      allowViewerExchangeAway: adminStoreGet('allowViewerExchangeAway', true) !== false,
      settableFields: [...ADMIN_SETTABLE_DIR_KEYS, ...ADMIN_SETTABLE_DIR_LIST_KEYS, ...ADMIN_SETTABLE_BOOL_KEYS, ...Object.keys(ADMIN_SETTABLE_INT_KEYS)]
    }
  }


  // ==========================================================================
  // Admin website — server-rendered /admin pages
  // ==========================================================================
  // The owner asked for "a computer app that shows an admin all the same stuff
  // our admin app shows". The Windows app (apps/viewer) is a thin Electron
  // window around THIS website, so building the admin section into the site
  // hands it to the Windows app, to any browser, and to the PC itself from one
  // implementation — rather than a second Electron UI that would then have to
  // be kept in step with this one forever.
  //
  // Nothing below re-implements an admin rule. Every read and every write goes
  // through handleAdminRequest() — the same function /api/admin/* calls — via
  // adminCall(), with a `send` that captures the JSON instead of writing it to
  // the socket. So the last-admin guard, the conversion delete guardrails, the
  // settings allowlist and the user-field whitelist all have exactly one
  // definition, and these pages cannot drift from the phone app's API.
  //
  // The three gates, in the order they run:
  //   1. SESSION. /admin sits below the site's session check, so a logged-out
  //      visitor is already 302'd to /login before any of this is reached.
  //   2. IDENTITY. A non-admin gets the site's ordinary 404 — byte for byte
  //      the same "Not found" any nonexistent path returns. Unlike the JSON
  //      API (which answers 403 admin_only so a native client can tell "not an
  //      admin" from "server too old"), a browser has no such need, and the
  //      owner asked for the section to leave no trace for a regular member.
  //      The nav entry is likewise only ever BUILT for an admin.
  //   3. TRANSPORT. The same https_required rule the JSON API enforces, not
  //      weakened: without TLS the tools are not rendered at all, and an
  //      explanation is shown instead. Identity is checked before transport
  //      here (the API does the reverse) for one reason: a plaintext probe
  //      must not be able to learn that /admin exists by getting a different
  //      answer than it would for /nonsense. No administrative data is read
  //      to decide gate 2 — only the already-loaded session user's isAdmin.
  const ADMIN_TABS = [
    { key: 'overview', label: 'Overview' },
    { key: 'users', label: 'Users' },
    { key: 'requests', label: 'Requests' },
    { key: 'flags', label: 'Flags' },
    { key: 'missing', label: 'Missing' },
    { key: 'suggestions', label: 'Suggestions' },
    { key: 'inbox', label: 'Inbox' },
    { key: 'titles', label: 'Titles to check' },
    { key: 'conversions', label: 'Conversions' },
    { key: 'history', label: 'History' },
    { key: 'markers', label: 'Markers' },
    { key: 'apikeys', label: 'API keys' },
    { key: 'webhooks', label: 'Webhooks' },
    { key: 'backup', label: 'Backup' },
    { key: 'settings', label: 'Settings' }
  ]
  const ADMIN_TAB_KEYS = new Set(ADMIN_TABS.map((t) => t.key))
  const adminTab = (raw) => (ADMIN_TAB_KEYS.has(String(raw || '')) ? String(raw) : 'overview')

  // Deliberately identical to the generic 404 at the bottom of requestHandler.
  const adminNotFound = (res) => {
    res.writeHead(404)
    res.end('Not found')
  }

  // Run one /api/admin/* route in-process and keep its JSON. `apiPath` is the
  // real API path, so the route matching, the gates and the handler body are
  // all the ones the phone app hits.
  async function adminCall(req, res, apiUser, method, apiPath, { body, query } = {}) {
    let captured = { status: 500, body: { ok: false, error: 'server_error' } }
    const send = (status, obj) => {
      captured = { status, body: obj && typeof obj === 'object' ? obj : {} }
    }
    const fakeUrl = new URL(apiPath, 'http://localhost')
    if (query) for (const [k, v] of Object.entries(query)) fakeUrl.searchParams.set(k, String(v))
    try {
      await handleAdminRequest(req, res, fakeUrl, apiPath, method, apiUser, send, body || (method === 'POST' ? {} : undefined))
    } catch (err) {
      captured = { status: 500, body: { ok: false, error: String(err) } }
    }
    return captured
  }

  // --- one-shot flash messages --------------------------------------------
  // Actions are POST-then-redirect so a refresh never re-runs a delete. The
  // message (and, for the two routes that mint one, the access code) is parked
  // here under an opaque id rather than put in the query string — a credential
  // does not belong in a URL, a browser history entry or a server log. Reading
  // it CONSUMES it, which is what makes "this can't be shown again" true.
  const adminFlashes = new Map()
  const ADMIN_FLASH_TTL_MS = 10 * 60 * 1000
  function adminPutFlash(payload) {
    const now = Date.now()
    for (const [k, v] of adminFlashes) if (now - v.at > ADMIN_FLASH_TTL_MS) adminFlashes.delete(k)
    while (adminFlashes.size >= 64) adminFlashes.delete(adminFlashes.keys().next().value)
    const id = crypto.randomBytes(9).toString('hex')
    adminFlashes.set(id, { ...payload, at: now })
    return id
  }
  function adminTakeFlash(id) {
    if (!id) return null
    const v = adminFlashes.get(id)
    if (!v) return null
    adminFlashes.delete(id)
    return Date.now() - v.at > ADMIN_FLASH_TTL_MS ? null : v
  }

  // --- error codes as sentences -------------------------------------------
  // The JSON API answers a machine token; a person reading a web page is owed
  // a sentence that says what happened and what to do about it.
  const ADMIN_ERROR_SENTENCES = {
    inbox_not_running: 'The Beebo Inbox is not running on this computer right now.',
    nothing_to_undo: 'There is nothing from the last 30 days left to undo.',
    already_put_back: 'That one has already been put back.',
    file_missing: 'That file is not where Beebo left it any more, so nothing was moved.',
    original_spot_taken: 'Something else is now where that file came from, so it was left where it is.',
    too_old: 'That move is more than 30 days old, so it can no longer be put back from here.',
    bad_choice: 'Choose a title, or fill in the name first.',
    last_admin:
      'Nothing was changed — this is the only admin account left. Make somebody else an admin first, otherwise there would be nobody able to administer this server from anywhere, including the app on the PC.',
    not_deletable:
      'Nothing was deleted — an original can only be removed once its conversion has finished successfully, and this one has not (or its original is already gone).',
    converted_file_missing:
      'Nothing was deleted — the converted copy is not on disk, so removing the original would leave you with no copy of this at all.',
    converted_file_too_small:
      'Nothing was deleted — the converted copy is 1 MB or smaller, which almost always means the conversion was cut short. A truncated file must never cost you your only copy.',
    no_output_path: 'Nothing was deleted — this entry has no converted file recorded, so there is nothing to remove.',
    invalid_path:
      'Nothing was deleted — the original and the converted file are the same file on disk, so deleting it would take both copies at once.',
    outside_managed_folders:
      'Nothing was deleted — that file is not inside one of the Movies or TV Shows folders this server manages, and this page will not delete anything outside them.',
    not_found: 'That item is not there any more — somebody may have already dealt with it.',
    not_remotely_settable:
      'That setting is a password or an API key. It can only be typed on the PC that runs the server, in front of the machine.',
    not_settable: 'That is not a setting this page is allowed to change.',
    not_a_directory:
      'Nothing was saved — that folder does not exist on the server. Every folder is checked before any of them are saved, so the rest were left alone too.',
    bad_value: 'Nothing was saved — that value was the wrong shape.',
    nothing_to_set: 'Nothing was changed.',
    missing_userId: 'No account was named, so nothing happened.',
    missing_fileName: 'No file was named, so nothing happened.',
    missing_tmdbId: 'No title was chosen, so nothing happened.',
    missing_query: 'Nothing was typed to search for, so nothing happened.',
    no_api_key:
      'Searching again needs the TMDB key, and none is set on this server. Everything else on this page still works — the choices below were saved when the library was last checked and need no internet.',
    tmdb_unreachable:
      'TMDB could not be reached, so nothing was searched. Nothing was changed. The choices already on this page still work without the internet.',
    missing_requestId: 'No request was named, so nothing happened.',
    bad_name: 'Give it a name (up to 60 characters) so you can tell it apart later.',
    bad_key_scope: 'Tick at least one thing this key may read.',
    bad_rate: 'That request limit is not a whole number in the allowed range.',
    too_many_keys: 'That is the most keys this server holds. Remove one you no longer use first.',
    bad_url: 'That is not a web address this can post to. Use a full http:// or https:// address, without a username or password in it.',
    bad_events: 'Tick at least one event to send.',
    bad_format: 'That is not one of the ways a webhook can send.',
    bad_credentials: 'That service needs a token or key that is missing, or has a space or odd character in it. Paste it exactly as the service shows it.',
    bad_template: 'The wording is too long (500 characters at most).',
    scope_not_allowed: 'Your account cannot put that on a key.',
    blocked_private:
      'That address is on this computer or your home network. Nothing was saved. If that is really where it should go, tick “Allow a target on my home network” and try again.',
    blocked_address: 'That address is one Beebo never posts to (a link-local or cloud-metadata address), whatever is ticked.',
    too_many_hooks: 'That is the most webhooks this server holds. Remove one you no longer use first.',
    missing_key: 'No marker was named, so nothing happened.',
    missing_showKey: 'No show was named, so nothing happened.',
    bad_scope: 'That is not something this page knows how to clear.',
    method_not_allowed: 'That action has to be sent as a form.',
    admin_only: 'Admin accounts only.',
    https_required: 'Admin tools need a secure connection.',
    server_error: 'Something went wrong on the server and nothing was changed.'
  }
  function adminErrorSentence(body) {
    const code = String((body && body.error) || 'server_error')
    const base = ADMIN_ERROR_SENTENCES[code] || `The server refused this with “${code}”.`
    const field = body && body.field ? ` (${body.field})` : ''
    return base + field
  }

  // --- small render helpers -------------------------------------------------
  const ADMIN_BTN = 'padding:7px 11px;font-size:12px;'
  const ADMIN_BTN_GREY = 'background:#2a2f3a;color:#dfe3ea;padding:7px 11px;font-size:12px;'
  const ADMIN_BTN_BLUE = 'background:#1e2a3a;color:#8fc4ff;padding:7px 11px;font-size:12px;'
  const ADMIN_BTN_RED = 'background:#3a1f22;color:#ff9d9d;padding:7px 11px;font-size:12px;'
  // Anything before 2000 is a missing or damaged time, not a date anyone should be shown.
  const adminWhen = (ts) => (Number(ts) >= Date.UTC(2000, 0, 1) ? escapeHtml(new Date(Number(ts)).toLocaleString()) : '—')
  const adminRow = (inner) => `<div class="card" style="padding:14px 16px;margin-bottom:10px;">${inner}</div>`
  const adminEmpty = (text) => `<p class="empty" style="margin-top:30px;">${escapeHtml(text)}</p>`
  const adminActions = (inner) => `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;">${inner}</div>`
  const adminDefinition = (label, value) =>
    `<div style="display:flex;gap:10px;padding:6px 0;border-bottom:1px solid #22262f;">
      <div class="muted" style="flex:0 0 190px;">${escapeHtml(label)}</div>
      <div style="min-width:0;word-break:break-word;">${value}</div>
    </div>`

  // Every action button is a real form post — the whole section works with
  // JavaScript switched off, which is also what makes the confirm step below
  // a server-rendered page rather than a window.confirm().
  function adminForm(action, tab, fields, label, style) {
    const hidden = Object.entries(fields || {})
      .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v === null || v === undefined ? '' : v)}">`)
      .join('')
    return `<form method="POST" action="/admin/${escapeHtml(action)}" style="display:inline;margin:0;">
      <input type="hidden" name="tab" value="${escapeHtml(tab)}">${hidden}
      <button type="submit" style="${style || ADMIN_BTN}">${escapeHtml(label)}</button>
    </form>`
  }

  function adminTabRow(active) {
    return `<div class="tabs" style="margin-bottom:16px;flex-wrap:wrap;">${ADMIN_TABS.map(
      (t) =>
        `<a href="/admin?tab=${encodeURIComponent(t.key)}" class="tab ${active === t.key ? 'tab-active' : ''}">${escapeHtml(t.label)}</a>`
    ).join('')}</div>`
  }

  function adminFlashHtml(flash) {
    if (!flash) return ''
    if (flash.code) {
      // The one place any surface ever shows a credential, and only the one
      // just minted. It is not stored anywhere readable and this message is
      // consumed on display — regenerating is the only way back to a code.
      return `<div class="success" style="padding:16px 18px;">
        <div style="font-weight:700;margin-bottom:6px;">${escapeHtml(flash.text || 'New access code')}</div>
        <div style="font-size:30px;font-weight:800;letter-spacing:4px;font-family:ui-monospace,Consolas,monospace;margin:10px 0;">${escapeHtml(flash.code)}</div>
        <div>Write this down now — it can't be shown again. It isn't stored anywhere you can read it back, so if it's lost the only way forward is to generate another one, which stops this one working.</div>
      </div>`
    }
    if (flash.secret) {
      // Same rule as the access code above: only the one just minted, consumed on display.
      return `<div class="success" style="padding:16px 18px;">
        <div style="font-weight:700;margin-bottom:6px;">${escapeHtml(flash.text || 'New secret')}</div>
        <div style="font-size:14px;font-weight:700;font-family:ui-monospace,Consolas,monospace;margin:10px 0;word-break:break-all;user-select:all;">${escapeHtml(flash.secret)}</div>
        <div>Copy this now — it can't be shown again. Only a scrambled fingerprint of it is kept here, so if it is lost the only way forward is to make a new one and remove this one.</div>
      </div>`
    }
    const cls = flash.kind === 'error' ? 'error' : 'success'
    return `<div class="${cls}">${escapeHtml(flash.text || '')}</div>`
  }

  function adminShell({ tab, flash, body }) {
    return page(`
      <div class="topbar">
        <h2 style="margin:0;">Beebo Entertainment</h2>
        <a href="/logout" class="muted" style="color:#8a8f98;">Log out</a>
      </div>
      ${sectionNav('admin', true)}
      <h3 style="margin:0 0 12px;">🛡️ Admin</h3>
      ${adminTabRow(tab)}
      ${adminFlashHtml(flash)}
      ${body}
      ${HEARTBEAT_SCRIPT}
    `)
  }

  // Shown instead of the tools when the request did not arrive over TLS. Says
  // plainly why, and deliberately does NOT include the certificate's failure
  // reason or any path — this response is the one travelling in the clear.
  function adminInsecurePage() {
    return page(`
      <div class="topbar">
        <h2 style="margin:0;">Beebo Entertainment</h2>
        <a href="/logout" class="muted" style="color:#8a8f98;">Log out</a>
      </div>
      ${sectionNav('admin', true)}
      <div style="max-width:680px;">
        <h3 style="margin:0 0 12px;">🔒 Admin tools need a secure connection</h3>
        <div class="error" style="font-size:15px;line-height:1.55;">
          This page arrived over plain HTTP, so the certificate isn't active for it right now — and the
          admin tools aren't shown over an unencrypted connection.
        </div>
        <p class="muted" style="font-size:14px;line-height:1.6;">
          This isn't a nag that can be clicked past. The admin section lists every household account,
          hands out access codes and deletes files; sending any of that in the clear would put it in
          reach of anyone on the same network or anywhere along the way. The phone app's admin API
          refuses plain HTTP for exactly the same reason, and this page is held to the same rule.
        </p>
        <p class="muted" style="font-size:14px;line-height:1.6;">
          Reach this site at its <strong>https://</strong> address on the server's domain name and the
          tools appear. If https isn't working at all, the certificate needs attention on the PC that
          runs the server — the app's own window shows its status. Everything else on the site keeps
          working in the meantime.
        </p>
        <p><a class="btn btn-secondary" href="/">← Back to the library</a></p>
      </div>
      ${HEARTBEAT_SCRIPT}
    `)
  }

  // ---------------------------------------------------------------- overview
  function adminOverviewBody(summary, settings) {
    const tile = (label, value, sub) =>
      `<div class="card" style="padding:14px 16px;">
        <div class="muted" style="font-size:12px;text-transform:uppercase;letter-spacing:0.6px;">${escapeHtml(label)}</div>
        <div style="font-size:28px;font-weight:800;margin:4px 0 2px;">${escapeHtml(value)}</div>
        <div class="sub">${escapeHtml(sub || '')}</div>
      </div>`
    const s = summary || {}
    const u = s.users || {}
    const c = s.conversions || {}
    const lib = s.library || {}
    const st = s.storage || {}
    const https = s.https || {}
    const httpsLine = https.active
      ? `Certificate active${https.daysRemaining === null || https.daysRemaining === undefined ? '' : ` · ${https.daysRemaining} day${https.daysRemaining === 1 ? '' : 's'} left`}`
      : 'No certificate'
    return `
      <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(190px,1fr));margin-bottom:22px;">
        ${tile('Accounts', String(u.total || 0), `${u.pending || 0} awaiting email · ${u.revoked || 0} revoked`)}
        ${tile('Access requests', String((s.requests || {}).pending || 0), 'waiting for a decision')}
        ${tile('Quality reports', String((s.flags || {}).unresolved || 0), 'unresolved')}
        ${tile('Missing requests', String((s.missing || {}).unresolved || 0), 'unresolved')}
        ${tile('Conversions', `${c.queued || 0} / ${c.converting || 0}`, `queued / running · ${c.done || 0} done · ${c.error || 0} failed`)}
        ${tile('Library', String(lib.movies || 0), `movies · ${lib.shows || 0} shows · ${lib.episodes || 0} episodes`)}
        ${tile('Converted on disk', formatBytesShort(st.convertedBytes || 0), 'from the conversion queue')}
        ${tile('Originals on disk', formatBytesShort(st.originalBytes || 0), 'not yet deleted')}
        ${tile('Secure connection', https.active ? 'On' : 'Off', httpsLine)}
      </div>
      <div class="card" style="padding:16px 18px;">
        <h4 style="margin:0 0 10px;font-size:14px;">This server</h4>
        ${adminDefinition('Domain', escapeHtml((settings && settings.domain) || 'not set'))}
        ${adminDefinition('Port', escapeHtml(String((settings && settings.port) || '')))}
        ${adminDefinition('Movies folder', escapeHtml(((settings && settings.folders) || {}).moviesDir || 'not set'))}
        ${adminDefinition('TV Shows folder', escapeHtml(((settings && settings.folders) || {}).tvShowsDir || 'not set'))}
      </div>
      <p class="muted" style="margin-top:16px;line-height:1.6;">
        These are the same numbers the app on the PC shows, read from the same place — this page is the
        website's view of it, so it looks identical in the Windows app, in a browser and on the PC itself.
      </p>`
  }

  // ------------------------------------------------------------------- users
  const ADMIN_STATUS_WORDS = {
    approved: 'Approved',
    revoked: 'Revoked',
    pending_verification: 'Waiting on their email link'
  }
  function adminUsersBody(users) {
    if (!users.length) return adminEmpty('No accounts yet.')
    const rows = users
      .map((u) => {
        const status = ADMIN_STATUS_WORDS[u.status] || u.status || 'unknown'
        const badges = [
          u.isAdmin ? '<span style="background:#1e2a3a;color:#8fc4ff;border-radius:99px;padding:2px 9px;font-size:11px;font-weight:700;">ADMIN</span>' : '',
          `<span class="muted" style="font-size:12px;">${escapeHtml(status)}</span>`
        ]
          .filter(Boolean)
          .join(' ')
        const actions = []
        if (u.status === 'pending_verification') actions.push(adminForm('users/approve', 'users', { userId: u.id }, '✓ Approve now', ADMIN_BTN))
        if (u.status === 'revoked') actions.push(adminForm('users/reactivate', 'users', { userId: u.id }, '✓ Let back in', ADMIN_BTN))
        if (u.status === 'approved') actions.push(adminForm('users/revoke', 'users', { userId: u.id }, '⛔ Revoke access', ADMIN_BTN_RED))
        actions.push(
          u.isAdmin
            ? adminForm('users/set-admin', 'users', { userId: u.id, isAdmin: 'false' }, '↓ Remove admin', ADMIN_BTN_RED)
            : adminForm('users/set-admin', 'users', { userId: u.id, isAdmin: 'true' }, '↑ Make admin', ADMIN_BTN_GREY)
        )
        if (!u.viewingHistoryPrivate) actions.push(adminForm('users/regenerate-code', 'users', { userId: u.id }, '🔑 New access code', ADMIN_BTN_BLUE))
        if (!u.viewingHistoryPrivate) actions.push(adminForm('users/adult', 'users', { userId: u.id, adult: u.adult ? 'false' : 'true' }, u.adult ? 'Remove adult label' : 'Label as adult (18+)', ADMIN_BTN_GREY))
        return adminRow(`
          <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:baseline;">
            <div style="min-width:0;">
              <div style="font-weight:700;font-size:15px;word-break:break-word;">${escapeHtml(u.name || '(no name)')}</div>
              <div class="sub">${escapeHtml(u.username || '—')} · ${escapeHtml(u.email || 'no email')}</div>
            </div>
            <div>${badges}</div>
          </div>
          <div class="sub" style="margin-top:8px;">
            Joined ${adminWhen(u.createdAt)} ·
            Last seen ${adminWhen(u.lastSeenAt)}${u.lastSeenIp ? ` from ${escapeHtml(u.lastSeenIp)}` : ''} ·
            ${u.hasPassword ? 'has a password' : 'no password set'} ·
            ${u.hasCode ? 'has an access code' : 'no access code'} · ${u.adult ? 'Adult profile' : 'Standard profile'}${u.viewingHistoryPrivate ? ' · Viewing history private' : ''}
          </div>
          ${adminActions(actions.join(''))}
        `)
      })
      .join('')
    return `<p class="muted" style="margin-top:0;line-height:1.6;">
        Access codes and passwords are never shown here — only whether one exists. A code can only ever be
        read at the moment it's created, which is what “New access code” does.
      </p>${rows}`
  }

  // ---------------------------------------------------------------- requests
  function adminRequestsBody(requests, statusFilter) {
    const chips = ['pending', 'approved', 'denied', 'all']
      .map(
        (s) =>
          `<a href="/admin?tab=requests&status=${encodeURIComponent(s)}" class="tab ${statusFilter === s ? 'tab-active' : ''}" style="font-size:13px;">${escapeHtml(s)}</a>`
      )
      .join('')
    const rows = requests.length
      ? requests
          .map((r) =>
            adminRow(`
              <div style="font-weight:700;font-size:15px;word-break:break-word;">${escapeHtml(r.name || '(no name)')}</div>
              <div class="sub">${escapeHtml(r.email || 'no email')} · asked ${adminWhen(r.createdAt)} · ${escapeHtml(r.status || 'pending')}</div>
              ${r.message ? `<div style="margin-top:8px;background:#0f1115;border-radius:8px;padding:10px 12px;font-size:14px;line-height:1.5;word-break:break-word;">${escapeHtml(r.message)}</div>` : ''}
              ${
                (r.status || 'pending') === 'pending'
                  ? adminActions(
                      adminForm('requests/approve', 'requests', { requestId: r.id }, '✓ Approve and create the account', ADMIN_BTN) +
                        adminForm('requests/deny', 'requests', { requestId: r.id }, '✕ Deny', ADMIN_BTN_RED)
                    )
                  : ''
              }
            `)
          )
          .join('')
      : adminEmpty('Nothing in this queue.')
    return `<div class="tabs" style="margin-bottom:14px;">${chips}</div>
      <p class="muted" style="margin-top:0;line-height:1.6;">
        Approving creates the account and mints its access code. The code is shown once, right here, and
        can't be read back afterwards — so have somewhere to write it down before you approve.
      </p>${rows}`
  }

  // ------------------------------------------------------------------- flags
  function adminFlagsBody(flags) {
    if (!flags.length) return adminEmpty('Nobody has reported a bad-quality file.')
    return flags
      .map((f) => {
        const who = Array.isArray(f.flaggedBy) ? f.flaggedBy : []
        const names = who.map((w) => escapeHtml(w && w.userName ? w.userName : 'someone')).join(', ')
        return adminRow(`
          <div style="font-weight:700;font-size:15px;word-break:break-word;">${f.kind === 'tv' ? '📺' : '🎬'} ${escapeHtml(f.title || f.fileName || f.relPath || 'Untitled')}</div>
          <div class="sub" style="word-break:break-all;">${escapeHtml(f.relPath || f.fileName || f.filePath || '')}</div>
          <div class="sub" style="margin-top:6px;">
            Reported by ${names || 'nobody recorded'} · first ${adminWhen(f.firstFlaggedAt)} ·
            ${f.resolved ? 'marked sorted' : 'still open'}
          </div>
          ${adminActions(
            (f.resolved ? '' : adminForm('flags/resolve', 'flags', { id: f.id }, '✓ Mark sorted', ADMIN_BTN)) +
              adminForm('flags/remove', 'flags', { id: f.id }, '🗑 Delete this report', ADMIN_BTN_RED)
          )}
        `)
      })
      .join('')
  }

  // ----------------------------------------------------------------- missing
  function adminMissingBody(missing) {
    if (!missing.length) return adminEmpty('Nobody has asked for anything that isn’t here.')
    return missing
      .map((m) => {
        const who = Array.isArray(m.requestedBy) ? m.requestedBy : []
        const names = who.map((w) => escapeHtml(w && w.userName ? w.userName : 'someone')).join(', ')
        const ep =
          m.season !== null && m.season !== undefined && m.episode !== null && m.episode !== undefined
            ? ` · Season ${escapeHtml(String(m.season))}, Episode ${escapeHtml(String(m.episode))}`
            : ''
        // Notes left with "Request a title" on the phone.
        const notes = who
          .filter((w) => w && w.note)
          .map((w) => `<div class="sub" style="margin-top:4px;">“${escapeHtml(w.note)}” — ${escapeHtml(w.userName || 'someone')}</div>`)
          .join('')
        const state = m.dismissedAt ? 'dismissed' : m.addedAt ? 'added to the library' : m.resolved ? 'marked sorted' : 'still open'
        const sub = m.source === 'request' ? `Requested from the app${m.year ? ` · ${escapeHtml(String(m.year))}` : ''}` : escapeHtml(m.showName || '') + ep
        return adminRow(`
          <div style="font-weight:700;font-size:15px;word-break:break-word;">${m.kind === 'tv' ? '📺' : '🎬'} ${escapeHtml(m.title || m.showName || 'Untitled')}</div>
          <div class="sub">${sub}</div>
          ${notes}
          <div class="sub" style="margin-top:6px;">
            Asked for by ${names || 'nobody recorded'} · first ${adminWhen(m.firstSeenAt)} ·
            ${state}
          </div>
          ${adminActions(
            (m.resolved ? '' : adminForm('missing/resolve', 'missing', { id: m.id }, '✓ Mark sorted', ADMIN_BTN)) +
              adminForm('missing/remove', 'missing', { id: m.id }, '🗑 Delete this request', ADMIN_BTN_RED)
          )}
        `)
      })
      .join('')
  }

  // ------------------------------------------------------------- suggestions
  // /suggest has been linked in the site nav all along and posts to
  // /api/suggestions, so real submissions may already have been piling up on
  // disk with nothing anywhere able to show them. A stored record is
  // { id, text, userId, userName, createdAt, status } - userId is '' when
  // nobody was signed in, and userName falls back to 'Someone'.
  function adminSuggestionsBody(suggestions) {
    if (!suggestions.length) return adminEmpty('Nobody has left a suggestion yet.')
    return suggestions
      .slice()
      // The route stores newest-first already (it unshifts), but sorting here means
      // an older store, or one that has been hand-edited, still reads right.
      .sort((a, b) => (Number(b && b.createdAt) || 0) - (Number(a && a.createdAt) || 0))
      .map((sg) => {
        const done = String(sg.status || '') === 'done'
        return adminRow(`
          <div style="font-size:15px;line-height:1.6;white-space:pre-wrap;word-break:break-word;">${escapeHtml(String(sg.text || '(empty)'))}</div>
          <div class="sub" style="margin-top:8px;">
            From ${escapeHtml(String(sg.userName || 'Someone'))} ${sg.userId ? '(signed in)' : '(not signed in)'} ·
            ${sg.createdAt ? adminWhen(sg.createdAt) : 'no date recorded'} ·
            ${done ? 'marked done' : 'still open'}
          </div>
          ${adminActions(
            (done ? '' : adminForm('suggestions/resolve', 'suggestions', { id: sg.id }, '✓ Mark done', ADMIN_BTN)) +
              adminForm('suggestions/delete', 'suggestions', { id: sg.id }, '🗑 Delete this suggestion', ADMIN_BTN_RED)
          )}
        `)
      })
      .join('')
  }

  // ---------------------------------------------------------------- API keys
  const API_KEY_SCOPE_LABELS = {
    library: ['Library', 'Movies, TV shows, collections and what was added recently.'],
    history: ['History', 'Continue Watching and the viewing history of your own account (the one making this key).'],
    'now-playing': ['Now playing', 'Who is watching what right now, and the live event stream. Profiles with private history or parental limits are never listed.'],
    metrics: ['Metrics', 'The Prometheus scrape (/metrics): counts of streams, conversions, library size, bandwidth and errors. Only works while metrics are switched on below.']
  }
  function adminApiKeysBody(data) {
    const scopes = (data && data.scopes) || []
    const keys = (data && data.keys) || []
    const intro = `<p class="sub" style="margin:0 0 14px;line-height:1.6;">
      An API key lets another program on your network (a dashboard, Home Assistant, a script) read parts of this
      server, and nothing else: keys can never sign in, change anything, or open this Admin section. A key acts as
      <strong>the person who made it</strong>, and never has more than that person may have: if an admin's rights are
      removed, their keys drop to what any member may read. Everyone can make keys for their own tools (library and their
      own history); the list below is <strong>everyone's</strong>, so you can remove any of them. Each key is its own row, so you can
      remove one without touching the others. Details: <code>docs/PUBLIC-API.md</code>.
    </p>`
    const metricsOn = !!(data && data.metrics && data.metrics.enabled)
    const metricsBox = adminRow(`
      <h4 style="margin:0 0 8px;font-size:14px;">Prometheus metrics: ${metricsOn ? '<span style="color:#7dd87d;">on</span>' : 'off'}</h4>
      <div class="sub" style="line-height:1.6;">A scraper (Prometheus, Grafana Agent) can read counts of streams, conversions, library size, bandwidth and errors
        from <code>/metrics</code>, using a key that ticks <strong>Metrics</strong>. Only numbers: no titles, people, files or addresses.
        While this is off the address does not exist at all.</div>
      ${adminActions(adminForm('metrics/set', 'apikeys', { enabled: metricsOn ? '0' : '1' }, metricsOn ? 'Turn metrics off' : 'Turn metrics on', metricsOn ? ADMIN_BTN_GREY : ADMIN_BTN_BLUE))}`)
    const boxes = scopes
      .map((s) => {
        const [label, blurb] = API_KEY_SCOPE_LABELS[s] || [s, '']
        return `<label style="display:flex;gap:10px;align-items:flex-start;margin:0 0 8px;">
          <input type="checkbox" name="scope_${escapeHtml(s)}" value="1" ${s === 'library' ? 'checked' : ''} style="margin-top:3px;width:auto;">
          <span><strong>${escapeHtml(label)}</strong><span class="muted" style="display:block;font-size:12px;">${escapeHtml(blurb)}</span></span>
        </label>`
      })
      .join('')
    const create = adminRow(`
      <h4 style="margin:0 0 10px;font-size:14px;">Make a new key</h4>
      <form method="POST" action="/admin/api-keys/create">
        <input type="hidden" name="tab" value="apikeys">
        <label style="margin:0 0 12px;display:block;">
          <div class="muted" style="margin-bottom:6px;">Name (what it is for)</div>
          <input type="text" name="name" maxlength="60" required placeholder="Home Assistant" style="max-width:340px;margin-bottom:0;">
        </label>
        <div class="muted" style="margin-bottom:6px;">It may read</div>
        ${boxes}
        <label style="margin:12px 0;display:block;">
          <div class="muted" style="margin-bottom:6px;">Requests per minute (leave empty for ${escapeHtml(String((data && data.defaultRatePerMinute) || 120))})</div>
          <input type="number" name="ratePerMinute" min="${apiKeys.RATE_MIN}" max="${apiKeys.RATE_MAX}" step="1" style="width:140px;margin-bottom:0;">
        </label>
        <button type="submit" style="${ADMIN_BTN_BLUE}">Make the key</button>
      </form>
      <div class="sub" style="margin-top:10px;">The key is shown once, right after this. Up to ${escapeHtml(String((data && data.maxKeys) || 25))} keys.</div>`)
    const rows = keys
      .map((k) =>
        adminRow(`
          <div style="display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap;">
            <div style="flex:1 1 240px;min-width:0;">
              <div style="font-weight:700;word-break:break-word;">${escapeHtml(k.name)}</div>
              <div class="muted" style="font-family:ui-monospace,Consolas,monospace;font-size:12px;">${escapeHtml(k.hint)}</div>
              <div class="sub" style="margin-top:6px;">Reads: ${escapeHtml((k.scopes || []).map((s) => (API_KEY_SCOPE_LABELS[s] || [s])[0]).join(', ') || 'nothing')} · up to ${escapeHtml(String(k.ratePerMinute))} requests a minute</div>
              <div class="sub">Made ${adminWhen(k.createdAt)}${k.ownerName ? ` by ${escapeHtml(k.ownerName)}` : ''} · last used ${k.lastUsedAt ? adminWhen(k.lastUsedAt) : 'never'}</div>
            </div>
            ${adminForm('api-keys/revoke', 'apikeys', { id: k.id }, 'Remove key', ADMIN_BTN_RED)}
          </div>`)
      )
      .join('')
    return intro + metricsBox + create + `<h4 style="margin:18px 0 8px;">Everyone's keys (${keys.length})</h4>` + (rows || adminEmpty('No API keys yet.'))
  }

  // ---------------------------------------------------------------- webhooks
  function adminWebhooksBody(data) {
    const events = (data && data.events) || []
    const hooks = (data && data.hooks) || []
    const log = (data && data.log) || []
    const labelOf = new Map(events.map((e) => [e.id, e.label]))
    const formatList = (data && data.formats) || webhookFormats.FORMATS
    const formatLabel = new Map(formatList.map((x) => [x.id, x.label]))
    const intro = `<p class="sub" style="margin:0 0 14px;line-height:1.6;">
      A webhook tells another program (Home Assistant, n8n, a script) or a notification app (ntfy, Discord, Slack, Gotify, Pushover)
      that something just happened here, by sending it a small signed message. Each message is signed with the webhook's secret so the other end can tell it really came from this server.
      Nothing waits on the other end: a failed delivery is retried twice, then dropped and noted in the log below. Messages never
      contain passwords, file locations or e-mail addresses, and nothing about what someone with private viewing history or
      parental limits watches is ever sent. Details and code for checking the signature: <code>docs/PUBLIC-API.md</code>.
    </p>`
    const boxes = events
      .map(
        (e) => `<label style="display:flex;gap:10px;align-items:flex-start;margin:0 0 8px;">
          <input type="checkbox" name="event_${escapeHtml(e.id)}" value="1" style="margin-top:3px;width:auto;">
          <span><strong>${escapeHtml(e.label)}</strong> <span class="muted" style="font-family:ui-monospace,Consolas,monospace;font-size:12px;">${escapeHtml(e.id)}</span><span class="muted" style="display:block;font-size:12px;">${escapeHtml(e.blurb)}</span></span>
        </label>`
      )
      .join('')
    const create = adminRow(`
      <h4 style="margin:0 0 10px;font-size:14px;">Add a webhook</h4>
      <form method="POST" action="/admin/webhooks/create">
        <input type="hidden" name="tab" value="webhooks">
        <label style="margin:0 0 12px;display:block;">
          <div class="muted" style="margin-bottom:6px;">Name</div>
          <input type="text" name="name" maxlength="60" required placeholder="Home Assistant" style="max-width:340px;margin-bottom:0;">
        </label>
        <label style="margin:0 0 12px;display:block;">
          <div class="muted" style="margin-bottom:6px;">Send it as</div>
          <select name="format" style="max-width:340px;margin-bottom:0;">${formatList.map((x) => `<option value="${escapeHtml(x.id)}">${escapeHtml(x.label)}</option>`).join('')}</select>
          <div class="sub" style="margin-top:6px;">${formatList.map((x) => `<strong>${escapeHtml(x.label)}:</strong> ${escapeHtml(x.blurb)}`).join('<br>')}</div>
        </label>
        <label style="margin:0 0 12px;display:block;">
          <div class="muted" style="margin-bottom:6px;">Send to (http:// or https:// address; not needed for Pushover)</div>
          <input type="url" name="url" maxlength="2000" placeholder="https://example.com/beebo-hook" style="max-width:520px;margin-bottom:0;">
        </label>
        <div class="muted" style="margin-bottom:6px;">Only for the service you picked (stored encrypted, never shown again)</div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin:0 0 12px;">
          <input type="password" name="credential_token" maxlength="200" autocomplete="off" placeholder="Gotify app token / ntfy access token" style="max-width:280px;margin-bottom:0;">
          <input type="password" name="credential_appToken" maxlength="200" autocomplete="off" placeholder="Pushover application token" style="max-width:280px;margin-bottom:0;">
          <input type="password" name="credential_userKey" maxlength="200" autocomplete="off" placeholder="Pushover user key" style="max-width:280px;margin-bottom:0;">
        </div>
        <div class="muted" style="margin-bottom:6px;">Reword the notification (optional; not for Generic JSON). Fill-ins: <code>{{user.name}}</code> <code>{{media.title}}</code> <code>{{session.device}}</code> <code>{{percent}}</code> <code>{{title}}</code> <code>{{message}}</code></div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin:0 0 12px;">
          <input type="text" name="titleTemplate" maxlength="500" placeholder="{{user.name}} is watching {{media.title}}" style="max-width:340px;margin-bottom:0;">
          <input type="text" name="messageTemplate" maxlength="500" placeholder="{{message}}" style="max-width:340px;margin-bottom:0;">
        </div>
        <div class="muted" style="margin-bottom:6px;">Send these events</div>
        ${boxes}
        <label style="display:flex;gap:10px;align-items:flex-start;margin:14px 0;padding:10px 12px;border:1px solid #5a4a1f;border-radius:8px;background:#221d10;">
          <input type="checkbox" name="allowPrivateNetwork" value="1" style="margin-top:3px;width:auto;">
          <span><strong>Allow a target on my home network</strong>
            <span class="muted" style="display:block;font-size:12px;line-height:1.5;">Off by default. Beebo refuses to send to this computer or to addresses like 192.168.x.x and 10.x.x.x, so a mistyped or tampered address cannot make this server poke at other devices on your network. Tick this only if the program you are sending to (Home Assistant, say) really lives on your own network. Addresses that are never legitimate targets stay refused either way.</span></span>
        </label>
        <button type="submit" style="${ADMIN_BTN_BLUE}">Add the webhook</button>
      </form>
      <div class="sub" style="margin-top:10px;">The signing secret is shown once, right after this. Up to ${escapeHtml(String((data && data.maxHooks) || 10))} webhooks.</div>`)
    const rows = hooks
      .map((h) =>
        adminRow(`
          <div style="display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap;">
            <div style="flex:1 1 260px;min-width:0;">
              <div style="font-weight:700;word-break:break-word;">${escapeHtml(h.name)} ${h.enabled ? '' : '<span class="muted">(turned off)</span>'}</div>
              <div class="muted" style="font-family:ui-monospace,Consolas,monospace;font-size:12px;word-break:break-all;">${escapeHtml(h.url)}</div>
              <div class="sub" style="margin-top:6px;">${escapeHtml(formatLabel.get(h.format) || 'Generic JSON (signed)')}${h.credentialsSet && h.credentialsSet.length ? ' · credentials saved' : ''} · ${escapeHtml(h.events.map((e) => labelOf.get(e) || e).join(', '))}</div>
              ${h.allowPrivateNetwork ? '<div class="sub" style="color:#e2c16a;">May send to your home network.</div>' : ''}
            </div>
          </div>
          ${adminActions(
            adminForm('webhooks/test', 'webhooks', { id: h.id }, 'Send a test event', ADMIN_BTN_BLUE) +
              adminForm('webhooks/toggle', 'webhooks', { id: h.id, enabled: h.enabled ? '0' : '1' }, h.enabled ? 'Turn off' : 'Turn on', ADMIN_BTN_GREY) +
              adminForm('webhooks/rotate-secret', 'webhooks', { id: h.id }, 'New secret', ADMIN_BTN_GREY) +
              adminForm('webhooks/delete', 'webhooks', { id: h.id }, 'Remove', ADMIN_BTN_RED)
          )}`)
      )
      .join('')
    const logRows = log
      .slice(0, 50)
      .map(
        (e) => `<div style="display:flex;gap:10px;align-items:baseline;padding:7px 0;border-bottom:1px solid #22262f;flex-wrap:wrap;">
          <div class="muted" style="flex:0 0 150px;font-size:12px;">${adminWhen(e.time)}</div>
          <div style="flex:1 1 200px;min-width:0;word-break:break-word;"><strong>${escapeHtml(e.hookName || '')}</strong> <span class="muted" style="font-family:ui-monospace,Consolas,monospace;font-size:12px;">${escapeHtml(e.event || '')}</span></div>
          <div style="flex:1 1 200px;min-width:0;word-break:break-word;${e.ok ? '' : 'color:#ff9d9d;'}">${e.ok ? `Delivered${e.status ? ` (HTTP ${escapeHtml(String(e.status))})` : ''}` : `Failed: ${escapeHtml(e.error || 'no answer')}`}${e.attempts > 1 ? ` · ${escapeHtml(String(e.attempts))} attempts` : ''}</div>
        </div>`
      )
      .join('')
    return (
      intro +
      create +
      `<h4 style="margin:18px 0 8px;">Your webhooks (${hooks.length})</h4>` +
      (rows || adminEmpty('No webhooks yet.')) +
      `<h4 style="margin:18px 0 8px;">Delivery log</h4>` +
      (logRows ? adminRow(logRows) + adminActions(adminForm('webhooks/clear-log', 'webhooks', {}, 'Clear the log', ADMIN_BTN_GREY)) : adminEmpty('Nothing has been sent yet.'))
    )
  }

  // ------------------------------------------------------------ beebo inbox
  function adminInboxBody(data) {
    const st = data && data.inbox
    if (!data || !data.available || !st) {
      return adminEmpty('The Beebo Inbox runs inside the Beebo app on your computer, and it is not running right now.')
    }
    const c = st.counts || {}
    const state = !st.enabled ? 'Off' : st.paused ? 'Paused' : st.working ? `Sorting “${st.working}”…` : 'Watching'
    const intro = `<p class="sub" style="margin:0 0 14px;">Drop videos (or whole folders) into this folder on the computer running Beebo. Once a file has finished copying, Beebo works out what it is and moves it into Movies or TV Shows with a tidy name. Anything it isn't sure about waits under “_Needs a look”. Nothing is ever deleted, and any move can be put back for 30 days.</p>`
    const problem = st.problem ? `<div class="error">${escapeHtml(st.problem.text || '')}</div>` : ''
    const stat = (n, label) => `<div style="flex:1 1 120px;background:#14171d;border:1px solid #22262f;border-radius:8px;padding:10px 12px;">
        <div style="font-size:22px;font-weight:800;">${Number(n) || 0}</div><div class="muted" style="font-size:12px;">${escapeHtml(label)}</div></div>`
    const header = adminRow(`
      <div style="font-weight:700;">${escapeHtml(state)}: <span style="font-family:ui-monospace,Consolas,monospace;word-break:break-all;">${escapeHtml(st.dir || 'no folder set')}</span></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;">
        ${stat(c.sortedToday, 'sorted today')}${stat(c.waitingForCopy, 'waiting for copy to finish')}${stat(c.needsLook, 'need a look')}${stat(c.duplicates, 'duplicates set aside')}
      </div>
      ${adminActions(
        adminForm('inbox/sort-now', 'inbox', {}, '📥 Sort now', ADMIN_BTN_BLUE) +
          adminForm('inbox/open-folder', 'inbox', {}, '📂 Open Inbox', ADMIN_BTN_GREY) +
          adminForm('inbox/pause', 'inbox', { paused: st.paused ? 'false' : 'true' }, st.paused ? '▶ Resume' : '⏸ Pause', ADMIN_BTN_GREY) +
          adminForm('inbox/enabled', 'inbox', { enabled: st.enabled ? 'false' : 'true' }, st.enabled ? 'Turn the Inbox off' : 'Turn the Inbox on', ADMIN_BTN_GREY) +
          adminForm('inbox/undo-last', 'inbox', {}, '↩ Undo last sort', ADMIN_BTN_RED)
      )}
      ${c.held ? `<div class="sub" style="margin-top:8px;">${Number(c.held)} file${Number(c.held) === 1 ? ' you put back is' : 's you put back are'} being left alone until you press “Sort now”.</div>` : ''}
    `)
    const looks = (st.needsLook || []).map((n) => {
      if (n.type === 'clash') {
        return adminRow(`
          <div style="font-weight:700;word-break:break-all;">${escapeHtml(n.fileName || '')}</div>
          <div class="sub" style="margin-top:4px;">${escapeHtml(n.reasonText || '')}. The one already there: <span style="word-break:break-all;">${escapeHtml(n.clashWith || '')}</span></div>
          ${adminActions(adminForm('inbox/file-as', 'inbox', { id: n.id, kind: 'keep' }, 'OK, keep both', ADMIN_BTN_BLUE) + (n.undoId ? adminForm('inbox/put-back', 'inbox', { undoId: n.undoId }, 'Put it back in the Inbox', ADMIN_BTN_GREY) : ''))}
        `)
      }
      const choices = (n.candidates || [])
        .map((cand) => adminForm('inbox/file-as', 'inbox', { id: n.id, tmdbId: cand.id }, `This is: ${cand.title || 'Untitled'}${cand.year ? ` (${cand.year})` : ''}${cand.kind === 'tv' ? ' · TV show' : ''}`, ADMIN_BTN_BLUE))
        .join('')
      return adminRow(`
        <div style="font-weight:700;word-break:break-all;font-family:ui-monospace,Consolas,monospace;">${escapeHtml(n.fileName || '')}</div>
        <div class="sub" style="margin-top:4px;">Needs a look because ${escapeHtml(n.reasonText || '')}.</div>
        ${choices ? adminActions(choices) : ''}
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;align-items:flex-start;">
          <form method="POST" action="/admin/inbox/file-as" style="margin:0;display:flex;gap:6px;flex-wrap:wrap;">
            <input type="hidden" name="tab" value="inbox"><input type="hidden" name="id" value="${escapeHtml(n.id)}"><input type="hidden" name="kind" value="film">
            <input type="text" name="title" placeholder="Film title" style="padding:7px 9px;font-size:12px;min-width:180px;">
            <input type="text" name="year" placeholder="Year" inputmode="numeric" style="padding:7px 9px;font-size:12px;width:70px;">
            <button type="submit" style="${ADMIN_BTN_GREY}">It's this film</button>
          </form>
          <form method="POST" action="/admin/inbox/file-as" style="margin:0;display:flex;gap:6px;flex-wrap:wrap;">
            <input type="hidden" name="tab" value="inbox"><input type="hidden" name="id" value="${escapeHtml(n.id)}"><input type="hidden" name="kind" value="episode">
            <input type="text" name="show" placeholder="Show name" value="${escapeHtml((n.parsed && n.parsed.parsedShow) || '')}" style="padding:7px 9px;font-size:12px;min-width:150px;">
            <input type="text" name="season" placeholder="Season" inputmode="numeric" value="${escapeHtml(n.parsed && n.parsed.season != null ? String(n.parsed.season) : '')}" style="padding:7px 9px;font-size:12px;width:64px;">
            <input type="text" name="episode" placeholder="Episode" inputmode="numeric" value="${escapeHtml(n.parsed && n.parsed.episode != null ? String(n.parsed.episode) : '')}" style="padding:7px 9px;font-size:12px;width:70px;">
            <button type="submit" style="${ADMIN_BTN_GREY}">It's this episode</button>
          </form>
        </div>
        ${adminActions(adminForm('inbox/file-as', 'inbox', { id: n.id, kind: 'asis' }, 'Put it in Movies as it is', ADMIN_BTN_GREY) + adminForm('inbox/retry', 'inbox', { id: n.id }, '🔎 Look again', ADMIN_BTN_GREY))}
      `)
    }).join('')
    const recent = (st.recent || []).map((r) => `<div style="display:flex;gap:10px;align-items:center;padding:7px 0;border-bottom:1px solid #22262f;">
        <div class="muted" style="flex:0 0 150px;font-size:12px;">${adminWhen(r.time)}</div>
        <div style="flex:1;min-width:0;word-break:break-word;${r.undone ? 'text-decoration:line-through;opacity:.6;' : ''}">${escapeHtml(r.text || '')}</div>
        ${r.undoId && !r.undone ? adminForm('inbox/put-back', 'inbox', { undoId: r.undoId }, 'Put it back', ADMIN_BTN_GREY) : ''}
      </div>`).join('')
    return intro + problem + header +
      `<h4 style="margin:18px 0 8px;">Needs a look (${(st.needsLook || []).length})</h4>` + (looks || adminEmpty('Nothing is waiting for you.')) +
      `<h4 style="margin:18px 0 8px;">Recent activity</h4>` + (recent ? adminRow(recent) : adminEmpty('Nothing has been sorted yet.'))
  }

  // ------------------------------------------------------- titles to check
  // The queue of files the matcher would not guess at. Everything on this page
  // is drawn from electron-store and from posters already on disk: no request
  // is made to TMDB and none to image.tmdb.org, so it renders in full with the
  // internet off, which is the state this whole app is designed around. The one
  // control that does need the internet (search again) says so when it fails.
  const TITLES_PER_PAGE = 20
  const TITLE_REASONS = {
    weak_title: 'nothing matched the name closely enough to be sure',
    no_clear_winner: 'two or more titles matched about equally well',
    no_results: 'TMDB returned nothing for this name',
    empty_query: 'there was no usable title left after reading the file name',
    no_api_key: 'there was no TMDB key set when this was checked',
    network_error: 'TMDB could not be reached when this was checked',
    searched_again: 'you searched this one again'
  }

  function adminTitleThumb(c) {
    if (c.hasLocalPoster) {
      return `<img src="/media/poster/${encodeURIComponent(String(c.id))}.jpg" alt="" width="80" height="120"
        style="width:80px;height:120px;object-fit:cover;border-radius:6px;display:block;background:#14171d;">`
    }
    // No poster on disk. A grey box, never a remote <img>: a broken-image icon
    // would be worse than an honest blank, and pointing at image.tmdb.org would
    // make this page need the internet.
    return `<div style="width:80px;height:120px;border-radius:6px;background:#14171d;border:1px solid #22262f;
      display:flex;align-items:center;justify-content:center;text-align:center;font-size:10px;color:#6b7280;padding:4px;">no image saved</div>`
  }

  function adminTitleCandidate(fileName, c, pageNum) {
    // One form per candidate, so picking works with JavaScript switched off.
    return `<form method="POST" action="/admin/titles/pick" style="margin:0;">
      <input type="hidden" name="tab" value="titles">
      <input type="hidden" name="fileName" value="${escapeHtml(fileName)}">
      <input type="hidden" name="tmdbId" value="${escapeHtml(String(c.id))}">
      <input type="hidden" name="page" value="${escapeHtml(String(pageNum || 1))}">
      <div style="width:80px;">
        ${adminTitleThumb(c)}
        <div style="font-size:12px;font-weight:600;margin-top:6px;line-height:1.3;word-break:break-word;">${escapeHtml(c.title || 'Untitled')}</div>
        <div class="muted" style="font-size:11px;">${escapeHtml(c.year ? String(c.year) : 'no year')}</div>
        <button type="submit" style="${ADMIN_BTN_BLUE}margin-top:6px;width:100%;">This one</button>
      </div>
    </form>`
  }

  function adminTitlesBody(data, pageNum) {
    const titles = Array.isArray(data && data.titles) ? data.titles : []
    const decided = Number(data && data.decided) || 0
    const notAFilm = Number(data && data.notAFilm) || 0
    const summary = `<p class="sub" style="margin:0 0 14px;">
      ${titles.length} title${titles.length === 1 ? '' : 's'} waiting ·
      ${decided} confirmed by hand · ${notAFilm} marked “not a film”.
      For files already in your library, nothing on this page renames or moves a single file — it only decides which poster and title a file is shown with. Files waiting in the Beebo Inbox are filed away once you choose.
    </p>`
    if (!titles.length) {
      return summary + adminEmpty('Nothing is waiting. Every file either matched confidently or has already been answered.')
    }
    const pages = Math.max(1, Math.ceil(titles.length / TITLES_PER_PAGE))
    const current = Math.min(Math.max(1, Number(pageNum) || 1), pages)
    const slice = titles.slice((current - 1) * TITLES_PER_PAGE, current * TITLES_PER_PAGE)

    const rows = slice
      .map((t) => {
        const fileName = String(t.fileName || '')
        const cands = Array.isArray(t.candidates) ? t.candidates : []
        const reason = TITLE_REASONS[String(t.reason || '')] || 'this one was not clear enough to decide on its own'
        const searched = t.searchedFor ? ` · you searched for “${escapeHtml(String(t.searchedFor))}”` : ''
        const current_ = t.inbox
          ? '<div class="sub" style="margin-top:6px;">📥 Waiting in your Beebo Inbox under “_Needs a look”. Choosing a title below renames it and files it into Movies or TV Shows (you can put it back from the Inbox tab).</div>'
          : t.currentMatch
          ? `<div class="sub" style="margin-top:6px;">Showing as <strong>${escapeHtml(t.currentMatch.title || '')}</strong>${
              t.currentMatch.year ? ` (${escapeHtml(String(t.currentMatch.year))})` : ''
            } at the moment, and it keeps that until you choose something here.</div>`
          : '<div class="sub" style="margin-top:6px;">No poster or title is being shown for this file at the moment.</div>'
        const grid = cands.length
          ? `<div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:12px;">${cands.map((c) => adminTitleCandidate(fileName, c, current)).join('')}</div>`
          : '<div class="sub" style="margin-top:10px;">TMDB offered nothing at all for this name. Type a different title below, or mark it as not a film.</div>'
        return adminRow(`
          <div style="font-weight:700;font-size:14px;word-break:break-all;font-family:ui-monospace,Consolas,monospace;">${escapeHtml(fileName)}</div>
          <div class="sub" style="margin-top:4px;">
            ${t.kind === 'tv' ? '📺 searched TV shows' : '🎬 searched films'} for
            “${escapeHtml(String(t.query || ''))}”${t.year ? ` (${escapeHtml(String(t.year))})` : ' (no year in the name)'} —
            ${escapeHtml(reason)}${searched}
          </div>
          ${current_}
          ${grid}
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px;align-items:flex-start;">
            <form method="POST" action="/admin/titles/search" style="margin:0;display:flex;gap:6px;flex-wrap:wrap;">
              <input type="hidden" name="tab" value="titles">
              <input type="hidden" name="fileName" value="${escapeHtml(fileName)}">
              <input type="hidden" name="page" value="${escapeHtml(String(current))}">
              <input type="text" name="query" placeholder="Search for a different title" value=""
                style="padding:7px 9px;font-size:12px;min-width:220px;">
              <button type="submit" style="${ADMIN_BTN_GREY}">🔎 Search again</button>
            </form>
            ${adminForm('titles/not-a-film', 'titles', { fileName, page: current }, '🚫 Not a film', ADMIN_BTN_RED)}
          </div>
        `)
      })
      .join('')

    const pager =
      pages > 1
        ? `<div class="tabs" style="margin-top:14px;flex-wrap:wrap;">${Array.from({ length: pages }, (_, i) => i + 1)
            .map(
              (n) =>
                `<a href="/admin?tab=titles&page=${n}" class="tab ${n === current ? 'tab-active' : ''}" style="font-size:13px;">${n}</a>`
            )
            .join('')}</div>`
        : ''
    return summary + rows + pager
  }

  // ------------------------------------------------------------- conversions
  // The "convert a whole show" control needs the very show keys convert-show
  // matches on, and there is no admin route that lists shows - so the list is
  // read from apiShowMap(), the same map that handler looks the key up in.
  // That costs one TV directory walk per render of this tab, the same walk the
  // Overview tab's summary already does - on the worker thread.
  async function adminShowChoices() {
    try {
      return Array.from((await apiShowMapAsync()).values())
        .map((sh) => ({ key: sh.key, name: sh.name, episodes: (sh.episodes || []).length }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    } catch {
      return []
    }
  }

  const ADMIN_CONV_WORDS = {
    queued: 'Waiting its turn',
    converting: 'Converting now',
    done: 'Converted',
    error: 'Failed',
    skipped: 'Skipped',
    rejected: 'Converted copy deleted',
    'not-needed': 'Plays as it is',
    'dont-convert': 'Not converting (your choice)'
  }
  // Takes the WHOLE /api/admin/conversions body, not just its list: that route
  // already reports paused / autoDeleteOriginals / windowStart / windowEnd /
  // lowDisk, and a pause button that cannot tell you whether it is paused is a
  // trap. Nothing here asks the server for anything it was not already saying.
  // The library scan's progress. Works with JavaScript off (a Refresh link); with it on, the numbers
  // update themselves from /admin/conversions/scan-status every second and a half while it runs.
  function adminScanLine(x) {
    const n = (v) => Number(v) || 0
    x = x && typeof x === 'object' ? x : {}
    const secs = (n(x.elapsedMs) / 1000).toFixed(1)
    if (x.state === 'listing') return 'Scan running — listing the library folders…'
    if (x.state === 'scanning') return `Scan running — checked ${n(x.checked)} of ${n(x.total)} files (${n(x.fromCache)} unchanged since last time), ${n(x.enqueued)} queued so far.`
    if (x.state === 'done') return `Last scan: checked ${n(x.checked)} file${n(x.checked) === 1 ? '' : 's'} in ${secs}s (${n(x.probed)} examined, ${n(x.fromCache)} unchanged since last time) and queued ${n(x.enqueued)} to convert.`
    if (x.state === 'cancelled') return `Last scan was stopped after ${n(x.checked)} of ${n(x.total)} files. The ${n(x.enqueued)} it had already found were queued.`
    if (x.state === 'error') return 'The last scan stopped with an error. Nothing it had not finished was queued.'
    return ''
  }
  function adminScanPanel(scan) {
    const s = scan && typeof scan === 'object' ? scan : { state: 'idle' }
    const live = s.state === 'listing' || s.state === 'scanning'
    const pct = live && Number(s.total) ? Math.floor((Number(s.checked) / Number(s.total)) * 100) : 0
    const line = adminScanLine
    return `
      <div id="scan-panel" data-live="${live ? '1' : '0'}">
        <p id="scan-line" class="muted" style="margin:0 0 8px;${line(s) ? '' : 'display:none;'}">${escapeHtml(line(s))}</p>
        <div id="scan-bar-wrap" style="height:8px;background:#22262f;border-radius:4px;overflow:hidden;margin:0 0 10px;${live ? '' : 'display:none;'}">
          <div id="scan-bar" style="height:100%;width:${pct}%;background:#4f8cff;transition:width .3s;"></div>
        </div>
        ${adminActions(
          live
            ? adminForm('conversions/scan-cancel', 'conversions', {}, '■ Stop the scan', ADMIN_BTN_RED) + `<a href="/admin?tab=conversions" style="${ADMIN_BTN_GREY}border-radius:8px;text-decoration:none;">↻ Refresh</a>`
            : adminForm('conversions/scan-unplayable', 'conversions', {}, '🔎 Scan the whole library for files that will not play', ADMIN_BTN_BLUE)
        )}
      </div>
      ${live ? `<script>
      (function () {
        function tick() {
          fetch('/admin/conversions/scan-status', { credentials: 'same-origin' }).then(function (r) { return r.json() }).then(function (b) {
            var s = (b && b.scan) || {};
            var el = document.getElementById('scan-line'); if (el && b && b.text) { el.textContent = b.text; el.style.display = '' }
            var bar = document.getElementById('scan-bar');
            if (bar && s.total) bar.style.width = Math.floor((s.checked / s.total) * 100) + '%';
            if (s.state === 'listing' || s.state === 'scanning') setTimeout(tick, 1500);
            else setTimeout(function () { location.href = '/admin?tab=conversions' }, 800);
          }).catch(function () { setTimeout(tick, 4000) });
        }
        setTimeout(tick, 1500);
      })();
      </script>` : ''}`
  }

  function adminConversionsBody(view, shows) {
    const conversions = Array.isArray(view && view.conversions) ? view.conversions : []
    const paused = !!(view && view.paused)
    const autoDelete = !!(view && view.autoDeleteOriginals)
    const lowDisk = !!(view && view.lowDisk)
    const ws = view && typeof view.windowStart === 'number' ? view.windowStart : null
    const we = view && typeof view.windowEnd === 'number' ? view.windowEnd : null
    // The route treats an equal start and end as "no window", exactly as the converter does.
    const windowOn = ws !== null && we !== null && ws !== we
    const hhmm = (h) => `${String(h).padStart(2, '0')}:00`
    // The same two conditions accept-all itself filters on, so the count shown is the count it will act on.
    const acceptable = conversions.filter((c) => c && c.status === 'done' && !c.originalDeleted)
    const acceptableBytes = acceptable.reduce((t, c) => t + (Number(c.originalBytes) || 0), 0)
    const showList = Array.isArray(shows) ? shows : []
    const showOptions = showList
      .map(
        (sh) =>
          `<option value="${escapeHtml(sh.key)}">${escapeHtml(sh.name)}${sh.episodes ? ` (${sh.episodes} episode${sh.episodes === 1 ? '' : 's'})` : ''}</option>`
      )
      .join('')

    const panel = `
      <div class="card" style="padding:16px 18px;margin-bottom:16px;">
        <h4 style="margin:0 0 4px;font-size:14px;">The converter right now</h4>
        <p class="muted" style="margin:0 0 12px;line-height:1.6;">
          ${escapeHtml(paused ? 'Paused — anything already running finishes, but nothing new starts.' : 'Running — queued files convert one at a time in the background.')}
          ${escapeHtml(windowOn ? `It may only start a job between ${hhmm(ws)} and ${hhmm(we)}.` : 'There is no overnight window, so it may start a job at any hour.')}
          ${escapeHtml(autoDelete ? 'Originals are being DELETED as each conversion finishes.' : 'Originals are kept after converting.')}
          ${lowDisk ? escapeHtml('The output drive is low on free space, so the converter is holding off until there is room.') : ''}
        </p>
        ${adminActions(
          adminForm(
            'conversions/pause',
            'conversions',
            { paused: paused ? '' : '1' },
            paused ? '▶ Resume all conversions' : '⏸ Pause all conversions',
            paused ? ADMIN_BTN : ADMIN_BTN_GREY
          )
        )}
      </div>

      <div class="card" style="padding:16px 18px;margin-bottom:16px;">
        <h4 style="margin:0 0 4px;font-size:14px;">Overnight-only window</h4>
        <p class="muted" style="margin:0 0 12px;line-height:1.6;">
          Whole hours on a 24-hour clock, 0 to 23. An end hour smaller than the start wraps past midnight, so
          1 and 6 means 01:00 until 06:00, and 23 and 6 means 23:00 until 06:00. Setting both to the same hour
          turns the window off. A job already running is never interrupted — the window only decides whether
          the next one may start.
        </p>
        <p class="muted" style="margin:0 0 12px;">
          Currently: <strong>${escapeHtml(windowOn ? `${hhmm(ws)} until ${hhmm(we)}` : 'off — conversions may start at any hour')}</strong>
        </p>
        <form method="POST" action="/admin/conversions/schedule" style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;">
          <input type="hidden" name="tab" value="conversions">
          <label style="margin:0;">
            <div class="muted" style="margin-bottom:6px;">Start hour</div>
            <input type="number" name="windowStart" min="0" max="23" step="1" value="${windowOn ? escapeHtml(String(ws)) : ''}" style="width:120px;margin-bottom:0;">
          </label>
          <label style="margin:0;">
            <div class="muted" style="margin-bottom:6px;">End hour</div>
            <input type="number" name="windowEnd" min="0" max="23" step="1" value="${windowOn ? escapeHtml(String(we)) : ''}" style="width:120px;margin-bottom:0;">
          </label>
          <button type="submit" style="${ADMIN_BTN}">Save the window</button>
        </form>
        ${adminActions(
          adminForm('conversions/schedule', 'conversions', { windowStart: '', windowEnd: '' }, '✕ Turn the window off', ADMIN_BTN_GREY)
        )}
      </div>

      <div class="card" style="padding:16px 18px;margin-bottom:16px;">
        <h4 style="margin:0 0 4px;font-size:14px;">Queue up work</h4>
        <p class="muted" style="margin:0 0 12px;line-height:1.6;">
          Both of these only ADD to the queue. No file is deleted or replaced, and anything already queued,
          converting, finished or rejected is left alone. The library scan runs in the background and checks
          several files at once; files it has already checked and that have not changed since are not
          checked again. You can leave this page, or stop the scan, at any time.
        </p>
        ${adminScanPanel(view && view.scan)}
        ${
          showOptions
            ? `<form method="POST" action="/admin/conversions/convert-show" style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-top:16px;">
                 <input type="hidden" name="tab" value="conversions">
                 <label style="margin:0;flex:1 1 280px;min-width:0;">
                   <div class="muted" style="margin-bottom:6px;">Convert an entire show now — its episodes jump the queue</div>
                   <select name="showKey" style="width:100%;">${showOptions}</select>
                 </label>
                 <button type="submit" style="${ADMIN_BTN_BLUE}">▶ Convert this show next</button>
               </form>`
            : `<p class="muted" style="margin:16px 0 0;">No TV shows were found in the TV Shows folders, so there is nothing to convert a whole show of.</p>`
        }
      </div>

      <div class="card" style="padding:16px 18px;margin-bottom:16px;border:1px solid #6b2b30;">
        <h4 style="margin:0 0 4px;font-size:14px;">⚠ Delete originals as they convert</h4>
        <p class="muted" style="margin:0 0 12px;line-height:1.6;">
          While this is on, every conversion that finishes from then on deletes its own original file the moment
          the converted copy is written. There is no undo and nothing goes to the Recycle Bin. It is meant for a
          big batch on a drive without room for two copies of everything. Turning it on asks you to confirm on a
          page of its own first; turning it off deletes nothing and needs no confirming.
        </p>
        <p class="muted" style="margin:0 0 12px;">
          Currently:
          <strong style="color:${autoDelete ? '#ff9d9d' : '#9dffb8'};">${escapeHtml(autoDelete ? 'ON — originals are being deleted' : 'off — originals are kept')}</strong>
        </p>
        ${adminActions(
          autoDelete
            ? adminForm('conversions/auto-delete', 'conversions', { enabled: '' }, '✓ Stop deleting originals', ADMIN_BTN)
            : adminForm('conversions/auto-delete', 'conversions', { enabled: '1' }, '⚠ Start deleting originals as they convert', ADMIN_BTN_RED)
        )}
      </div>

      <div class="card" style="padding:16px 18px;margin-bottom:16px;border:1px solid #6b2b30;">
        <h4 style="margin:0 0 4px;font-size:14px;">⚠ Keep every converted copy and delete the originals</h4>
        <p class="muted" style="margin:0 0 12px;line-height:1.6;">
          One pass over every finished conversion whose original is still on disk: the converted copy is kept and
          the original is deleted for good. There is no undo and nothing goes to the Recycle Bin. Each file gets
          the same checks as the single “Delete the original file” button — the converted copy has to exist and be
          bigger than ${escapeHtml(formatBytesShort(ADMIN_MIN_CONVERTED_BYTES))}, it has to sit at a different path,
          and the original has to be inside a Movies or TV Shows folder this server manages. Anything that fails a
          check is skipped and left exactly as it is.
        </p>
        <p class="muted" style="margin:0 0 12px;">
          Ready to accept: <strong>${acceptable.length} file${acceptable.length === 1 ? '' : 's'}</strong>${
            acceptable.length ? ` · about ${escapeHtml(formatBytesShort(acceptableBytes))} of originals would be deleted` : ''
          }
        </p>
        ${
          acceptable.length
            ? adminActions(adminForm('conversions/accept-all', 'conversions', {}, '⚠ Accept all and delete those originals', ADMIN_BTN_RED))
            : `<p class="muted" style="margin:0;">Nothing to accept — no finished conversion still has its original on disk.</p>`
        }
      </div>`

    // One-time note after the rules changed and the waiting queue was re-checked.
    const rs = view && view.rulesSummary && typeof view.rulesSummary === 'object' ? view.rulesSummary : null
    const summaryCard = rs && !rs.dismissed && (Number(rs.removed) || 0) > 0
      ? `<div class="card" style="padding:16px 18px;margin-bottom:16px;border:1px solid #2b6b3a;">
          <h4 style="margin:0 0 4px;font-size:14px;">Removed ${escapeHtml(String(rs.removed))} file${Number(rs.removed) === 1 ? '' : 's'} that play fine as they are</h4>
          <p class="muted" style="margin:0 0 12px;line-height:1.6;">
            The converter now looks at what is inside each file instead of going by its extension, so ordinary
            MKV files with H.264 or HEVC video and AAC or Dolby audio are no longer queued.${Number(rs.playedFine) ? ` ${escapeHtml(String(rs.playedFine))} of them had already played fine on a phone or TV.` : ''}
            ${Number(rs.kept) ? `${escapeHtml(String(rs.kept))} still need work and stay in the queue.` : 'Nothing else needed converting.'}
            No file was touched. They are listed under “Plays as it is”, each with a “Convert anyway” button.
          </p>
          ${adminActions(adminForm('conversions/dismiss-summary', 'conversions', {}, '✓ Got it', ADMIN_BTN_GREY))}
        </div>`
      : ''
    const PARKED_STATUSES = ['not-needed', 'dont-convert']
    const active = conversions.filter((c) => c && !PARKED_STATUSES.includes(c.status))
    const parked = conversions.filter((c) => c && PARKED_STATUSES.includes(c.status))
    const planLine = (c) => {
      const pl = c && c.plan && typeof c.plan === 'object' ? c.plan : null
      const bits = []
      if (c.deviceFailure) bits.push('A device reported it could not play this file, so it goes first')
      if (c.force && !c.deviceFailure) bits.push('You chose “Convert anyway”')
      if (pl && pl.reason && ['queued', 'converting'].includes(c.status)) bits.push(pl.reason)
      if (c.status === 'skipped' && c.notNeededReason) bits.push(`Skipped: ${c.notNeededReason}`)
      return bits.length ? `<div class="sub" style="margin-top:6px;">${escapeHtml(bits.join('. '))}</div>` : ''
    }
    const PARKED_SHOWN = 300
    const parkedRows = parked
      .slice(0, PARKED_SHOWN)
      .map((c) => adminRow(`
          <div style="font-weight:700;font-size:14px;word-break:break-all;">${escapeHtml(path.basename(c.originalPath || 'unknown'))}</div>
          <div class="sub" style="margin-top:4px;">${escapeHtml(
            c.status === 'dont-convert'
              ? 'You chose not to convert this'
              : c.notNeededReason || (c.plan && c.plan.reason) || 'Plays as it is'
          )}</div>
          ${adminActions(
            adminForm('conversions/convert-anyway', 'conversions', { id: c.id }, '↻ Convert anyway', ADMIN_BTN) +
            adminForm('conversions/forget', 'conversions', { id: c.id }, '✕ Remove from this list', ADMIN_BTN_GREY)
          )}`))
      .join('')
    const parkedSection = parked.length
      ? `<details class="card" style="padding:16px 18px;margin-top:16px;">
           <summary style="cursor:pointer;font-weight:700;">Plays as it is, or you chose not to convert (${parked.length})</summary>
           <p class="muted" style="margin:10px 0;">These files are not converted. Nothing automatic queues them again unless a device reports it cannot play one.${parked.length > PARKED_SHOWN ? ` Showing the first ${PARKED_SHOWN}.` : ''}</p>
           ${parkedRows}
         </details>`
      : ''

    const rows = active
      .map((c) => {
        const actions = []
        if (['error', 'skipped', 'rejected'].includes(c.status)) actions.push(adminForm('conversions/retry', 'conversions', { id: c.id }, '↻ Convert again', ADMIN_BTN))
        if (['queued', 'error', 'skipped'].includes(c.status)) actions.push(adminForm('conversions/dont-convert', 'conversions', { id: c.id }, '⊘ Don’t convert', ADMIN_BTN_GREY))
        if (c.status === 'done' && !c.originalDeleted)
          actions.push(adminForm('conversions/delete-original', 'conversions', { id: c.id }, '🗑 Delete the original file', ADMIN_BTN_RED))
        if (c.status === 'done' && !c.originalDeleted)
          actions.push(adminForm('conversions/delete-converted', 'conversions', { id: c.id }, '🗑 Delete the converted file', ADMIN_BTN_RED))
        actions.push(adminForm('conversions/forget', 'conversions', { id: c.id }, '✕ Remove from this list', ADMIN_BTN_GREY))
        const pct = Number(c.progressPct) || 0
        return adminRow(`
          <div style="font-weight:700;font-size:15px;word-break:break-all;">${escapeHtml(path.basename(c.originalPath || c.outputPath || 'unknown'))}</div>
          <div class="sub" style="margin-top:4px;">
            ${escapeHtml(ADMIN_CONV_WORDS[c.status] || c.status || 'unknown')} ·
            ${c.kind === 'tv' ? 'TV' : 'Movie'} · queued ${adminWhen(c.queuedAt)}${c.finishedAt ? ` · finished ${adminWhen(c.finishedAt)}` : ''}
          </div>
          ${planLine(c)}
          ${
            c.status === 'converting'
              ? `<div style="height:6px;border-radius:99px;background:#2a2f3a;margin:10px 0 4px;overflow:hidden;">
                   <div style="height:100%;width:${Math.max(0, Math.min(100, pct))}%;background:#4f9dff;"></div>
                 </div><div class="sub">${escapeHtml(String(Math.round(pct)))}%</div>`
              : ''
          }
          ${c.error ? `<div class="error" style="margin-top:10px;word-break:break-word;">ffmpeg reported: ${escapeHtml(String(c.error))}</div>` : ''}
          <div class="sub" style="margin-top:8px;word-break:break-all;">
            Original: ${escapeHtml(c.originalPath || '—')} (${formatBytesShort(Number(c.originalBytes) || 0)})${c.originalDeleted ? ' — deleted' : ''}
          </div>
          <div class="sub" style="word-break:break-all;">
            Converted: ${escapeHtml(c.outputPath || '—')}${c.convertedBytes ? ` (${formatBytesShort(Number(c.convertedBytes))})` : ''}${c.convertedDeletedAt ? ' — deleted' : ''}
          </div>
          ${adminActions(actions.join(''))}
        `)
      })
      .join('')
    return summaryCard + panel + (rows || adminEmpty('Nothing is waiting to be converted.')) + parkedSection
  }

  // ----------------------------------------------------------------- history
  function adminHistoryBody(items) {
    if (!items.length) return adminEmpty('Nobody has watched anything yet.')
    const byUser = new Map()
    for (const it of items) {
      const key = it.userId || ''
      if (!byUser.has(key)) byUser.set(key, { name: it.userName || '(unknown)', rows: [] })
      byUser.get(key).rows.push(it)
    }
    return Array.from(byUser.entries())
      .map(([userId, group]) => {
        const rows = group.rows
          .map((r) => {
            const dur = Number(r.duration) || 0
            const cur = Number(r.currentTime) || 0
            const pct = dur > 0 ? Math.min(100, Math.round((cur / dur) * 100)) : 0
            return `<div style="padding:10px 0;border-bottom:1px solid #22262f;">
              <div style="font-weight:600;font-size:14px;word-break:break-word;">${r.kind === 'tv' ? '📺' : '🎬'} ${escapeHtml(r.title || r.fileName || 'Untitled')}</div>
              <div class="sub" style="word-break:break-all;">${escapeHtml(r.fileName || '')} · ${escapeHtml(formatClock(cur))} of ${escapeHtml(formatClock(dur))} (${pct}%) · ${adminWhen(r.lastUpdate)}</div>
              ${adminActions(
                adminForm('history/clear', 'history', { userId, scope: 'one', fileName: r.fileName || '', title: r.title || '' }, '✕ Remove this row', ADMIN_BTN_GREY) +
                  adminForm('history/clear', 'history', { userId, scope: 'show', title: r.title || '', fileName: r.fileName || '' }, '🗑 Remove every row for this title', ADMIN_BTN_RED)
              )}
            </div>`
          })
          .join('')
        return adminRow(`
          <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center;">
            <div style="font-weight:700;font-size:15px;word-break:break-word;">${escapeHtml(group.name)}</div>
            ${adminForm('history/clear', 'history', { userId, scope: 'all' }, '🗑 Clear this person’s entire history', ADMIN_BTN_RED)}
          </div>
          ${rows}
        `)
      })
      .join('')
  }

  // ----------------------------------------------------------------- markers
  // The automatically detected part of the Markers tab: what the background scanner has found, with a
  // per-show "Re-scan" (forget and look again) and "Clear" (forget and stop guessing until a re-scan).
  function adminAutoMarkersBody(auto) {
    if (!auto) return ''
    const st = auto.status || {}
    const line = !auto.enabled
      ? 'Automatic detection is switched off (Settings on the computer running Beebo).'
      : st.paused === 'playback'
        ? 'Waiting: it only works while nobody is watching.'
        : st.paused === 'no_ffmpeg'
          ? 'Unavailable: the converter (ffmpeg) is not installed on the computer running Beebo.'
          : `Looked at ${Number(st.itemsDone) || 0} of ${Number(st.itemsTotal) || 0} files${st.running && st.current ? ` — now: ${escapeHtml(String(st.current))}` : ''}.`
    const rows = (Array.isArray(auto.shows) ? auto.shows : [])
      .map((s) => {
        const counts = s.scope === 'movies' ? `credits found in ${Number(s.credits) || 0} of ${Number(s.episodes) || 0} films` : `intro found in ${Number(s.intro) || 0} and credits in ${Number(s.credits) || 0} of ${Number(s.episodes) || 0} episodes`
        const buttons = s.scope === 'show'
          ? adminForm('markers/auto-rescan', 'markers', { scope: 'show', key: s.key }, '↻ Re-scan intro/credits', ADMIN_BTN_GREY) +
            adminForm('markers/auto-clear', 'markers', { scope: 'show', key: s.key }, '🗑 Clear auto markers', ADMIN_BTN_GREY)
          : ''
        return adminRow(`
          <div style="font-weight:700;font-size:15px;word-break:break-word;">${s.scope === 'show' ? '📺' : '🎬'} ${escapeHtml(String(s.name || s.key))}</div>
          <div class="sub" style="margin-top:4px;">${escapeHtml(counts)}</div>
          ${buttons ? adminActions(buttons) : ''}
        `)
      })
      .join('')
    return `
      <div class="card" style="padding:16px 18px;margin:0 0 16px;">
        <h4 style="margin:0 0 4px;font-size:14px;">Found automatically</h4>
        <p class="muted" style="margin:0 0 6px;line-height:1.6;">
          Beebo listens for each show's opening titles and looks for the end credits by itself, on this computer only.
          A marker somebody set by hand always wins over what Beebo found.
        </p>
        <p class="sub" style="margin:0;">${line}</p>
      </div>
      ${rows}
    `
  }

  function adminMarkersBody(markers, auto) {
    const autoHtml = adminAutoMarkersBody(auto)
    if (!markers.length) return autoHtml + adminEmpty('No intro or credits markers have been saved by hand.')
    return autoHtml + markers
      .map((m) => {
        const setBy = m.setBy && m.setBy.userName ? m.setBy.userName : ''
        return adminRow(`
          <div style="font-weight:700;font-size:15px;word-break:break-word;">${m.scope === 'show' ? '📺' : '🎬'} ${escapeHtml(String(m.key || '(no key)'))}</div>
          <div class="sub" style="margin-top:4px;">
            Intro ends at ${m.introEndSeconds === null || m.introEndSeconds === undefined ? 'not set' : escapeHtml(formatClock(Number(m.introEndSeconds)))} ·
            Credits start at ${m.creditsStartSeconds === null || m.creditsStartSeconds === undefined ? 'not set' : escapeHtml(formatClock(Number(m.creditsStartSeconds)))}
          </div>
          <div class="sub">Set by ${escapeHtml(setBy || 'unknown')} · ${adminWhen(m.updatedAt || m.setAt)}</div>
          ${adminActions(adminForm('markers/clear', 'markers', { scope: m.scope === 'show' ? 'show' : 'movie', key: m.key || '' }, '🗑 Forget these markers', ADMIN_BTN_RED))}
        `)
      })
      .join('')
  }

  // ---------------------------------------------------------------- settings
  const ADMIN_FOLDER_LABELS = {
    moviesDir: 'Movies folder',
    tvShowsDir: 'TV Shows folder',
    inboxDir: 'Beebo Inbox (drop videos here and Beebo sorts them)',
    spaceSaverDir: 'Space Saver backup folder (where phone backups are saved)',
    viewerAppDir: 'Windows viewer app folder',
    tmdbCacheDir: 'Poster/details cache folder',
    extraMoviesDirs: 'Extra Movies folders (one per line)',
    extraTvShowsDirs: 'Extra TV Shows folders (one per line)'
  }
  function adminSettingsBody(settings) {
    const folders = settings.folders || {}
    const settable = Array.isArray(settings.settableFields) ? settings.settableFields : []
    const fields = settable
      // Only real folder settings render as text boxes here; on/off settings
      // (e.g. allowNewAccounts) get their own card below.
      .filter((key) => key in ADMIN_FOLDER_LABELS)
      .map((key) => {
        const label = ADMIN_FOLDER_LABELS[key] || key
        if (ADMIN_SETTABLE_DIR_LIST_KEYS.includes(key)) {
          const value = Array.isArray(folders[key]) ? folders[key].join('\n') : ''
          return `<label style="display:block;margin-bottom:14px;">
            <div class="muted" style="margin-bottom:6px;">${escapeHtml(label)}</div>
            <textarea name="${escapeHtml(key)}" rows="3" spellcheck="false">${escapeHtml(value)}</textarea>
          </label>`
        }
        return `<label style="display:block;margin-bottom:14px;">
          <div class="muted" style="margin-bottom:6px;">${escapeHtml(label)}</div>
          <input type="text" name="${escapeHtml(key)}" value="${escapeHtml(folders[key] || '')}" spellcheck="false">
        </label>`
      })
      .join('')
    const secrets = settings.secrets || {}
    const secretLine = (label, on, note) =>
      adminDefinition(
        label,
        `<strong style="color:${on ? '#9dffb8' : '#ff9d9d'};">${on ? 'Configured' : 'Not set'}</strong>
         <div class="muted" style="margin-top:3px;line-height:1.5;">${escapeHtml(note)}</div>`
      )
    const https = settings.https || {}
    const conv = settings.conversion || {}
    const login = settings.login || {}
    const accountsOpen = settings.allowNewAccounts !== false
    const accountsCard = settable.includes('allowNewAccounts')
      ? `
      <div class="card" style="padding:16px 18px;margin-bottom:16px;">
        <h4 style="margin:0 0 4px;font-size:14px;">Accounts</h4>
        <p class="muted" style="margin:0 0 12px;line-height:1.6;">
          When this is on, people can open the request-access page and ask for an account. Turn it off to
          close that page — new requests are turned away. People who already have an account are unaffected.
        </p>
        <form method="POST" action="/admin/settings">
          <input type="hidden" name="tab" value="settings">
          <input type="hidden" name="accountsForm" value="1">
          <label style="display:flex;align-items:center;gap:10px;cursor:pointer;">
            <input type="checkbox" name="allowNewAccounts" value="1"${accountsOpen ? ' checked' : ''} onchange="this.form.submit()" style="width:18px;height:18px;">
            <span style="font-size:14px;">Allow new account requests</span>
          </label>
          <button type="submit" style="margin-top:12px;">Save</button>
        </form>
      </div>`
      : ''
    return `
      ${accountsCard}
      <div class="card" style="padding:16px 18px;margin-bottom:16px;">
        <h4 style="margin:0 0 4px;font-size:14px;">Folders</h4>
        <p class="muted" style="margin:0 0 14px;line-height:1.6;">
          These are the only settings this page can change, and each one is checked to be a real folder on
          the server before anything is saved. If one of them is wrong, none of them are saved.
        </p>
        <form method="POST" action="/admin/settings">
          <input type="hidden" name="tab" value="settings">
          ${fields}
          <button type="submit">Save folders</button>
        </form>
      </div>

      <div class="card" style="padding:16px 18px;margin-bottom:16px;">
        <h4 style="margin:0 0 10px;font-size:14px;">Keys and passwords</h4>
        ${secretLine(
          'TMDB API key',
          !!secrets.tmdbApiKeyConfigured,
          'Fetches posters, titles and cast. It can only be typed on the PC that runs the server, in the app’s own Settings — not from here, and not from the phone.'
        )}
        ${secretLine(
          'Email app password',
          !!secrets.emailPasswordConfigured,
          'Sends password resets, sign-up links and lockout alerts. Also PC-only, for the same reason.'
        )}
        ${secretLine('Outgoing email', !!secrets.emailConfigured, 'Whether the server has everything it needs to send mail.')}
        ${secretLine('DuckDNS token', !!secrets.duckdnsTokenConfigured, 'Keeps the domain name pointed at this house. PC-only.')}
        <p class="muted" style="margin:14px 0 0;line-height:1.6;">
          Both of the first two are logins to somebody else’s service. A folder path only ever aims this
          server at another directory on a machine you already control; a stolen phone or a stolen browser
          session that could write the email password could quietly redirect every password-reset email.
          Neither can be read back here either — this page only ever knows whether one is set.
        </p>
      </div>

      <div class="card" style="padding:16px 18px;margin-bottom:16px;">
        <h4 style="margin:0 0 10px;font-size:14px;">Connection</h4>
        ${adminDefinition('Domain', escapeHtml(settings.domain || 'not set'))}
        ${adminDefinition('Port', escapeHtml(String(settings.port || '')))}
        ${adminDefinition('Secure connection', https.active ? 'Active' : 'Not active')}
        ${adminDefinition('Certificate expires', https.expiresAt ? `${adminWhen(Date.parse(https.expiresAt))}${https.daysRemaining === null || https.daysRemaining === undefined ? '' : ` (${https.daysRemaining} days)`}` : '—')}
      </div>

      <div class="card" style="padding:16px 18px;margin-bottom:16px;">
        <h4 style="margin:0 0 10px;font-size:14px;">Conversion</h4>
        <p class="muted" style="margin:0 0 10px;line-height:1.6;">
          Fixed in the server — there is nothing here to change, shown so you know what it will do.
        </p>
        ${adminDefinition('Video', `${escapeHtml(String(conv.videoCodec || ''))} · preset ${escapeHtml(String(conv.preset || ''))} · crf ${escapeHtml(String(conv.crf || ''))}`)}
        ${adminDefinition('Audio', `${escapeHtml(String(conv.audioCodec || ''))} · ${escapeHtml(String(conv.audioBitrate || ''))}`)}
        ${adminDefinition('Smallest converted file before an original may be deleted', formatBytesShort(Number(conv.minConvertedBytesBeforeOriginalDeletable) || 0))}
      </div>

      <div class="card" style="padding:16px 18px;">
        <h4 style="margin:0 0 10px;font-size:14px;">Login protection</h4>
        ${adminDefinition('Wrong attempts before lockout', escapeHtml(String(login.lockoutThreshold === null || login.lockoutThreshold === undefined ? '—' : login.lockoutThreshold)))}
        ${adminDefinition('Lockout lasts', escapeHtml(String(login.lockoutDurationMinutes === null || login.lockoutDurationMinutes === undefined ? '—' : `${login.lockoutDurationMinutes} minutes`)))}
        ${adminDefinition('Attempts before an alert email', escapeHtml(String(login.alertThreshold === null || login.alertThreshold === undefined ? '—' : login.alertThreshold)))}
      </div>`
  }

  // --- the confirm step -----------------------------------------------------
  // Destructive actions are shown as a page that names exactly what is about to
  // happen, to exactly which file or person, before it happens. Deliberately a
  // server-rendered interstitial and not an onsubmit confirm(): these pages have
  // to work with JavaScript off, and a confirm() that silently does nothing when
  // scripting is blocked would be worse than none at all.
  const ADMIN_NEEDS_CONFIRM = new Set([
    'users/revoke',
    'users/regenerate-code',
    'requests/deny',
    'flags/remove',
    'missing/remove',
    'conversions/forget',
    'conversions/delete-original',
    'conversions/delete-converted',
    'conversions/accept-all',
    'markers/clear',
    'history/clear'
  ])
  const adminNeedsConfirm = (action, form) => {
    // Promoting somebody is not destructive; taking admin away is.
    if (action === 'users/set-admin') return String(form.isAdmin || '').toLowerCase() !== 'true' && String(form.isAdmin) !== '1'
    // Arming "delete originals as they convert" signs away every original from here on, so it is
    // gated like a delete. Turning it off deletes nothing, so that direction goes straight through.
    if (action === 'conversions/auto-delete') return String(form.enabled || '') === '1'
    return ADMIN_NEEDS_CONFIRM.has(action)
  }

  async function adminConfirmDetails(req, res, apiUser, action, form) {
    const named = (label, value) => `<div class="sub" style="margin-top:6px;word-break:break-all;">${escapeHtml(label)}: ${escapeHtml(value || '—')}</div>`
    const findIn = async (apiPath, key, match) => {
      const out = await adminCall(req, res, apiUser, 'GET', apiPath)
      const list = (out.body && out.body[key]) || []
      return (Array.isArray(list) ? list : []).find(match) || null
    }
    if (action === 'users/revoke' || action === 'users/set-admin' || action === 'users/regenerate-code') {
      const u = await findIn('/api/admin/users', 'users', (x) => x.id === form.userId)
      const who = `${(u && u.name) || 'this account'}${u && u.username ? ` (${u.username})` : ''}`
      if (action === 'users/revoke') {
        return {
          heading: 'Revoke this person’s access?',
          lines: [
            `${who} loses access on their very next request — on the website, in the Windows app and in the phone app alike.`,
            'Their account and their watch history are kept. You can let them back in from this page at any time, and their access code still works when you do.'
          ],
          detail: named('Account', who),
          button: 'Yes, revoke access'
        }
      }
      if (action === 'users/set-admin') {
        return {
          heading: 'Take admin away from this person?',
          lines: [
            `${who} keeps their account and can still watch everything.`,
            'They lose the Admin section, the Upload page and every admin action, everywhere — website, Windows app and phone.'
          ],
          detail: named('Account', who),
          button: 'Yes, remove admin'
        }
      }
      return {
        heading: 'Give this person a brand new access code?',
        lines: [
          `${who}’s current access code stops working the moment you do this.`,
          'The new code is shown once on the next screen and can never be read back — so be ready to write it down and pass it on.'
        ],
        detail: named('Account', who),
        button: 'Yes, generate a new code'
      }
    }
    if (action === 'requests/deny') {
      const r = await findIn('/api/admin/requests', 'requests', (x) => x.id === form.requestId)
      return {
        heading: 'Deny this request to join?',
        lines: ['No account is created and no access code is minted. The request is marked denied and stays in the “denied” list.'],
        detail: named('From', r ? `${r.name || '(no name)'} · ${r.email || 'no email'}` : ''),
        button: 'Yes, deny it'
      }
    }
    if (action === 'flags/remove') {
      const f = await findIn('/api/admin/flags', 'flags', (x) => x.id === form.id)
      return {
        heading: 'Delete this bad-quality report?',
        lines: ['Only the report goes. No file on disk is touched, and the file stays exactly where it is in the library.'],
        detail: named('Report about', f ? f.title || f.fileName || f.relPath || '' : ''),
        button: 'Yes, delete the report'
      }
    }
    if (action === 'missing/remove') {
      const m = await findIn('/api/admin/missing', 'missing', (x) => x.id === form.id)
      return {
        heading: 'Delete this request for something missing?',
        lines: ['Only the request goes. Nothing is downloaded, deleted or changed in the library.'],
        detail: named('Request for', m ? m.title || m.showName || '' : ''),
        button: 'Yes, delete the request'
      }
    }
    // The two bulk conversion actions have no single entry to name, so they answer before the
    // per-entry branch below — which matches on form.id and would find nothing for either of them.
    if (action === 'conversions/accept-all') {
      const out = await adminCall(req, res, apiUser, 'GET', '/api/admin/conversions')
      const all = (out.body && out.body.conversions) || []
      const ready = (Array.isArray(all) ? all : []).filter((x) => x && x.status === 'done' && !x.originalDeleted)
      const bytes = ready.reduce((t, x) => t + (Number(x.originalBytes) || 0), 0)
      return {
        heading: 'Delete the original of every finished conversion?',
        lines: [
          `${ready.length} original file${ready.length === 1 ? '' : 's'} would be deleted from the disk for good. There is no undo and they do not go to the Recycle Bin.`,
          'The converted copy of each one is kept, and becomes the only copy you have of it.',
          'Any file that fails the server’s checks — converted copy missing, 1 MB or smaller, the same file as the original, or outside your Movies and TV Shows folders — is skipped and left untouched.'
        ],
        detail: named('Originals to delete', String(ready.length)) + named('Space this frees', formatBytesShort(bytes)),
        button: 'Yes, delete those originals'
      }
    }
    if (action === 'conversions/auto-delete') {
      return {
        heading: 'Start deleting originals as they convert?',
        lines: [
          'From now until you turn this off, every conversion that finishes deletes its own original file the moment the converted copy is written. There is no undo and nothing goes to the Recycle Bin.',
          'Files that have already been converted are not touched by this — it only applies to conversions that finish from here on. Use “Accept all” for the ones already done.',
          'The converter still refuses to delete an original when the converted copy is 1 MB or smaller, or when it would be the same file on disk.'
        ],
        detail: named('Setting', 'Delete originals as they convert'),
        button: 'Yes, delete originals as they convert'
      }
    }
    if (action.startsWith('conversions/')) {
      const c = await findIn('/api/admin/conversions', 'conversions', (x) => x.id === form.id)
      const orig = (c && c.originalPath) || ''
      const out = (c && c.outputPath) || ''
      if (action === 'conversions/forget') {
        return {
          heading: 'Remove this conversion from the list?',
          lines: ['This only drops the record. Neither the original nor the converted file is touched — both stay exactly where they are on disk.'],
          detail: named('Original', orig) + named('Converted', out),
          button: 'Yes, remove the record'
        }
      }
      if (action === 'conversions/delete-original') {
        return {
          heading: 'Permanently delete the ORIGINAL file?',
          lines: [
            `This deletes ${orig || 'the original file'} from the disk for good. There is no undo and it does not go to the Recycle Bin.`,
            `The converted copy${out ? ` — ${out}` : ''} stays, and that becomes the only copy you have of this.`,
            'The server will refuse if the conversion has not finished, if the converted copy is missing, if it is 1 MB or smaller, or if the file is outside your Movies and TV Shows folders.'
          ],
          detail:
            named('Deleting', orig) +
            named('Keeping', out) +
            named('Original size', formatBytesShort(Number(c && c.originalBytes) || 0)),
          button: 'Yes, delete the original'
        }
      }
      return {
        heading: 'Permanently delete the CONVERTED file?',
        lines: [
          `This deletes ${out || 'the converted copy'} from the disk for good. There is no undo and it does not go to the Recycle Bin.`,
          `The original${orig ? ` — ${orig}` : ''} stays, and that becomes the only copy you have of this.`,
          'The entry is also marked rejected, which is what stops the server immediately converting the same file all over again. "Convert again" undoes that when you want it back.'
        ],
        detail: named('Deleting', out) + named('Keeping', orig),
        button: 'Yes, delete the converted copy'
      }
    }
    if (action === 'markers/clear') {
      const scope = form.scope === 'show' ? 'show' : 'movie'
      const m = await findIn('/api/admin/markers', 'markers', (x) => x.scope === scope && String(x.key || '') === String(form.key || ''))
      return {
        heading: 'Forget the intro and credits markers?',
        lines: [
          'Both the intro-end and credits-start times for this title are removed together — the whole row goes, not just one number.',
          'Skip-intro and the next-episode prompt stop working for it until somebody watching sets them again.'
        ],
        detail:
          named(scope === 'show' ? 'Show' : 'Movie', String(form.key || '')) +
          named(
            'Currently',
            m
              ? `intro ends ${m.introEndSeconds === null || m.introEndSeconds === undefined ? 'not set' : formatClock(Number(m.introEndSeconds))}, credits start ${m.creditsStartSeconds === null || m.creditsStartSeconds === undefined ? 'not set' : formatClock(Number(m.creditsStartSeconds))}`
              : 'no marker found'
          ),
        button: 'Yes, forget them'
      }
    }
    if (action === 'history/clear') {
      const u = await findIn('/api/admin/users', 'users', (x) => x.id === form.userId)
      const who = (u && u.name) || 'this person'
      const scope = String(form.scope || '').toLowerCase()
      if (scope === 'all') {
        return {
          heading: `Clear ${who}’s entire viewing history?`,
          lines: [
            `Every row of ${who}’s history goes — every film, every episode, finished and part-watched alike.`,
            'Their Continue Watching list empties, and anything they were halfway through starts from the beginning next time. Nobody else’s history is affected. There is no undo.'
          ],
          detail: named('Person', who),
          button: 'Yes, clear everything'
        }
      }
      if (scope === 'show') {
        return {
          heading: 'Remove every row for this title?',
          lines: [
            `Every episode of this title disappears from ${who}’s history and from their Continue Watching list.`,
            'No file is touched. There is no undo.'
          ],
          detail: named('Title', String(form.title || '')) + named('Person', who),
          button: 'Yes, remove them all'
        }
      }
      return {
        heading: 'Remove this one row?',
        lines: [`This single row leaves ${who}’s history, so it stops offering to resume. No file is touched.`],
        detail: named('File', String(form.fileName || '')) + named('Person', who),
        button: 'Yes, remove it'
      }
    }
    return null
  }

  function adminConfirmPage({ action, form, details, tab }) {
    const hidden = Object.entries(form || {})
      .filter(([k]) => k !== 'confirmed')
      .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v === null || v === undefined ? '' : v)}">`)
      .join('')
    return adminShell({
      tab,
      flash: null,
      body: `<div class="card" style="padding:20px 22px;max-width:760px;border:1px solid #6b2b30;">
        <h3 style="margin:0 0 12px;">${escapeHtml(details.heading)}</h3>
        ${details.lines.map((l) => `<p style="margin:0 0 10px;line-height:1.6;font-size:15px;">${escapeHtml(l)}</p>`).join('')}
        ${details.detail || ''}
        <form method="POST" action="/admin/${escapeHtml(action)}" style="margin-top:18px;display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
          ${hidden}
          <input type="hidden" name="confirmed" value="yes">
          <button type="submit" style="background:#3a1f22;color:#ff9d9d;">${escapeHtml(details.button)}</button>
          <a class="btn btn-secondary" href="/admin?tab=${encodeURIComponent(tab)}">No, take me back</a>
        </form>
      </div>`
    })
  }

  // An empty box, or anything that is not a whole hour 0-23, becomes null — which is exactly what
  // the schedule route reads as "clear the window". Number('') is 0, so the empty case is caught
  // before the conversion, otherwise clearing the window would quietly set midnight instead.
  const adminHourOrNull = (v) => {
    const text = String(v === null || v === undefined ? '' : v).trim()
    if (!text) return null
    const n = Number(text)
    return Number.isFinite(n) && n >= 0 && n <= 23 ? Math.floor(n) : null
  }

  // --- the write routes -----------------------------------------------------
  // action -> [api path, how to describe having done it]. Each one is dispatched
  // straight into handleAdminRequest, so the rule that decides whether it is
  // allowed lives in exactly one place.
  const ADMIN_ACTIONS = {
    'users/approve': { api: '/api/admin/users/approve', ok: 'Account approved — they can sign in now.' },
    'users/reactivate': { api: '/api/admin/users/reactivate', ok: 'Account reactivated — they can sign in again.' },
    'users/revoke': { api: '/api/admin/users/revoke', ok: 'Access revoked. Their next request is refused, everywhere.' },
    'users/set-admin': { api: '/api/admin/users/set-admin', ok: 'Admin rights updated.' },
    'users/regenerate-code': { api: '/api/admin/users/regenerate-code', ok: 'New access code' },
    'users/adult': { api: '/api/admin/users/adult', ok: 'Adult profile label updated.' },
    'requests/approve': { api: '/api/admin/requests/approve', ok: 'Approved — the account is created. Here is its access code' },
    'requests/deny': { api: '/api/admin/requests/deny', ok: 'Request denied. No account was created.' },
    'api-keys/create': {
      api: '/api/admin/api-keys/create',
      ok: 'New API key. Copy it now',
      showSecret: 'token',
      coerce: (f) => ({
        name: f.name,
        scopes: publicApi.SCOPES.filter((s) => f['scope_' + s] === '1'),
        ...(String(f.ratePerMinute || '').trim() ? { ratePerMinute: Number(f.ratePerMinute) } : {})
      })
    },
    'api-keys/revoke': { api: '/api/admin/api-keys/revoke', ok: 'Key removed. It stopped working the moment you pressed the button.' },
    'metrics/set': {
      api: '/api/admin/metrics',
      ok: 'Metrics updated.',
      coerce: (f) => ({ enabled: f.enabled === '1' }),
      done: (b) => (b.metrics && b.metrics.enabled ? 'Metrics are on. A key that ticks Metrics can read /metrics now.' : 'Metrics are off. /metrics no longer exists.')
    },
    'webhooks/create': {
      api: '/api/admin/webhooks/create',
      ok: 'Webhook added. Its signing secret',
      showSecret: 'secret',
      coerce: (f) => ({
        name: f.name,
        url: f.url,
        events: webhooks.EVENTS.map((e) => e.id).filter((id) => f['event_' + id] === '1'),
        allowPrivateNetwork: f.allowPrivateNetwork === '1',
        format: f.format || 'json',
        // Only the boxes that were filled in: an empty one is "not set", not an empty credential.
        credentials: Object.fromEntries(['token', 'appToken', 'userKey'].filter((k) => String(f['credential_' + k] || '').trim()).map((k) => [k, f['credential_' + k]])),
        titleTemplate: f.titleTemplate || '',
        messageTemplate: f.messageTemplate || ''
      })
    },
    'webhooks/toggle': {
      api: '/api/admin/webhooks/update',
      ok: 'Webhook updated.',
      coerce: (f) => ({ id: f.id, enabled: f.enabled === '1' }),
      done: (b) => (b.hook && b.hook.enabled ? 'Webhook turned on.' : 'Webhook turned off. Nothing is sent to it until you turn it back on.')
    },
    'webhooks/rotate-secret': { api: '/api/admin/webhooks/rotate-secret', ok: 'New signing secret. The old one no longer verifies', showSecret: 'secret' },
    'webhooks/test': {
      api: '/api/admin/webhooks/test',
      ok: 'Test sent.',
      done: (b) => {
        const d = b.delivery || {}
        return d.ok ? `Test delivered: the other end answered HTTP ${d.status} in ${d.ms} ms.` : `Test not delivered: ${d.error || 'no answer'}.`
      }
    },
    'webhooks/delete': { api: '/api/admin/webhooks/delete', ok: 'Webhook removed.' },
    'webhooks/clear-log': { api: '/api/admin/webhooks/clear-log', ok: 'Delivery log cleared.' },
    'flags/resolve': { api: '/api/admin/flags/resolve', ok: 'Marked as sorted.' },
    'flags/remove': { api: '/api/admin/flags/remove', ok: 'Report deleted. No file was touched.' },
    'missing/resolve': { api: '/api/admin/missing/resolve', ok: 'Marked as sorted.' },
    'missing/remove': { api: '/api/admin/missing/remove', ok: 'Request deleted. No file was touched.' },
    'conversions/retry': { api: '/api/admin/conversions/retry', ok: 'Queued to convert again.' },
    'conversions/dont-convert': { api: '/api/admin/conversions/dont-convert', ok: 'This file will not be converted. Nothing automatic will queue it again; use “Convert anyway” if you change your mind.' },
    'conversions/convert-anyway': { api: '/api/admin/conversions/convert-anyway', ok: 'Queued. It will be converted to the format every phone and TV plays, even though it looked fine.' },
    'conversions/dismiss-summary': { api: '/api/admin/conversions/dismiss-summary', ok: 'Hidden.' },
    'conversions/forget': { api: '/api/admin/conversions/forget', ok: 'Removed from the list. Neither file was touched.' },
    'conversions/delete-original': { api: '/api/admin/conversions/delete-original', ok: 'The original file was deleted. The converted copy is now the only one.' },
    'conversions/delete-converted': { api: '/api/admin/conversions/delete-converted', ok: 'The converted file was deleted and this entry is marked rejected, so it will not be converted again on its own. The original is now the only copy.' },
    // The six below are the converter's control panel. Two things they need that the older actions
    // did not:
    //   coerce() — readBody() hands every field back as a STRING, and these routes read their body
    //     with checks a string cannot pass: schedule's clamp() insists on typeof 'number' (so a
    //     posted "3" would silently CLEAR the window), and pause/auto-delete take !!body.x, which
    //     reads the string "false" as true. The body is given its proper shape here, in the website
    //     layer, exactly as adminSaveSettings already reshapes its own form. No route is changed.
    //   done()  — these answer with counts (scanned/enqueued/accepted/skipped) or with the state they
    //     landed on, and a person who has just queued a hundred conversions is owed the number.
    'conversions/pause': {
      api: '/api/admin/conversions/pause',
      ok: 'Conversions updated.',
      coerce: (f) => ({ paused: f.paused === '1' }),
      done: (b) =>
        b.paused
          ? 'Conversions are paused. Anything already running finishes; nothing new starts until you resume.'
          : 'Conversions have resumed — the queue picks up again now.'
    },
    'conversions/schedule': {
      api: '/api/admin/conversions/schedule',
      ok: 'Conversion window updated.',
      coerce: (f) => ({ windowStart: adminHourOrNull(f.windowStart), windowEnd: adminHourOrNull(f.windowEnd) }),
      done: (b) =>
        typeof b.windowStart === 'number' && typeof b.windowEnd === 'number'
          ? `Conversions may now only start between ${String(b.windowStart).padStart(2, '0')}:00 and ${String(b.windowEnd).padStart(2, '0')}:00.`
          : 'The overnight window is off — conversions may start at any hour.'
    },
    'conversions/auto-delete': {
      api: '/api/admin/conversions/auto-delete',
      ok: 'Setting updated.',
      coerce: (f) => ({ enabled: f.enabled === '1' }),
      done: (b) =>
        b.autoDeleteOriginals
          ? 'Originals will now be deleted as each conversion finishes. Nothing was deleted just now.'
          : 'Originals will be kept from now on. Nothing was deleted.'
    },
    'conversions/scan-unplayable': {
      api: '/api/admin/conversions/scan-unplayable',
      ok: 'The library scan has started.',
      done: (b) =>
        b.alreadyRunning
          ? 'A scan was already running, so another was not started. Its progress is below.'
          : 'The library scan has started in the background. Its progress is below; files that already play, and files already on the list, are left alone.'
    },
    'conversions/scan-cancel': {
      api: '/api/admin/conversions/scan-cancel',
      ok: 'The scan was stopped.',
      done: (b) =>
        b.cancelled
          ? 'The scan is stopping. Files it had already found are queued; nothing else was.'
          : 'No scan was running, so there was nothing to stop.'
    },
    'conversions/convert-show': {
      api: '/api/admin/conversions/convert-show',
      ok: 'The show was queued.',
      done: (b) =>
        `Looked at ${Number(b.scanned) || 0} episode${(Number(b.scanned) || 0) === 1 ? '' : 's'}, queued ${Number(b.enqueued) || 0} to convert and moved ${Number(b.prioritized) || 0} to the front of the queue.${Number(b.notNeeded) ? ` ${Number(b.notNeeded)} already play fine as they are and were left alone.` : ''}`
    },
    'conversions/accept-all': {
      api: '/api/admin/conversions/accept-all',
      ok: 'Conversions accepted.',
      done: (b) =>
        `${Number(b.accepted) || 0} original${(Number(b.accepted) || 0) === 1 ? '' : 's'} deleted for good. ${Number(b.skipped) || 0} skipped because they did not pass the safety checks, and those files were left exactly as they were.`
    },
    // The "Titles to check" controls. None of them touches a file on disk — they
    // only decide which TMDB entry a file is shown as.
    'titles/pick': {
      api: '/api/admin/titles/pick',
      ok: 'Saved. That is what this file is from now on, and it will not be guessed at again — not even by “Re-check all movie matches”.'
    },
    'titles/not-a-film': {
      api: '/api/admin/titles/not-a-film',
      ok: 'Marked as not a film. It stays exactly where it is on disk; it just stops being looked up and stops coming back to this list.'
    },
    'titles/search': {
      api: '/api/admin/titles/search',
      ok: 'Searched.',
      done: (b) =>
        Number(b.found) > 0
          ? `Found ${Number(b.found)} possible title${Number(b.found) === 1 ? '' : 's'} — they are on the card below. Nothing has been chosen yet.`
          : 'That search came back with nothing. Try a different wording, or mark it as not a film.'
    },
    // The Beebo Inbox. Every move is undoable; none of these deletes anything.
    'inbox/sort-now': { api: '/api/admin/inbox/sort-now', ok: 'Sorted everything that was ready.' },
    'inbox/pause': { api: '/api/admin/inbox/pause', ok: 'Saved.' },
    'inbox/enabled': { api: '/api/admin/inbox/enabled', ok: 'Saved.' },
    'inbox/open-folder': { api: '/api/admin/inbox/open-folder', ok: 'Opened the Inbox folder on the computer running Beebo.' },
    'inbox/undo-last': {
      api: '/api/admin/inbox/undo-last',
      ok: 'Put back.',
      done: (b) => `Put ${Number(b.putBack) || 0} file${Number(b.putBack) === 1 ? '' : 's'} back where ${Number(b.putBack) === 1 ? 'it was' : 'they were'}. They stay in the Inbox until you press “Sort now”.`
    },
    'inbox/put-back': { api: '/api/admin/inbox/put-back', ok: 'Put back where it was. It stays there until you press “Sort now”.' },
    'inbox/file-as': { api: '/api/admin/inbox/file-as', ok: 'Filed.', done: (b) => (b.kept ? 'OK, both files are kept.' : b.duplicate ? 'That turned out to be a copy of something already in your library, so it went to _Duplicates.' : 'Filed away.') },
    'inbox/retry': { api: '/api/admin/inbox/retry', ok: 'Looked again.', done: (b) => (b.sorted ? 'Got it this time, and filed it away.' : 'Still not sure about this one. Choose what it is below.') },
    'suggestions/resolve': { api: '/api/admin/suggestions/resolve', ok: 'Marked as done. The suggestion stays on the list.' },
    'suggestions/delete': { api: '/api/admin/suggestions/delete', ok: 'Suggestion deleted.' },
    'markers/clear': { api: '/api/admin/markers/clear', ok: 'Markers forgotten.' },
    'markers/auto-rescan': { api: '/api/admin/markers/auto/rescan', ok: 'Re-scan started. It runs in the background whenever nobody is watching.' },
    'markers/auto-clear': { api: '/api/admin/markers/auto/clear', ok: 'Automatic markers cleared. They stay cleared until you re-scan.' },
    'history/clear': { api: '/api/admin/history/clear', ok: 'History cleared.' }
  }

  // The website's own settings write. It cannot just forward the form as-is:
  // the two "extra folders" fields are arrays in the API, and submitting every
  // folder unchanged would make one bad path elsewhere fail the whole save. So
  // the diff is worked out here and the ALLOWLIST, the directory check and the
  // all-or-nothing rule are still the API's, untouched.
  async function adminSaveSettings(req, res, apiUser, form) {
    const view = await adminCall(req, res, apiUser, 'GET', '/api/admin/settings')
    const settings = (view.body && view.body.settings) || {}
    const folders = settings.folders || {}
    const settable = Array.isArray(settings.settableFields) ? settings.settableFields : []
    const payload = {}
    for (const key of settable) {
      if (!(key in form)) continue
      if (ADMIN_SETTABLE_DIR_LIST_KEYS.includes(key)) {
        const next = String(form[key] || '')
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean)
        const cur = Array.isArray(folders[key]) ? folders[key] : []
        if (next.length !== cur.length || next.some((v, i) => v !== cur[i])) payload[key] = next
        continue
      }
      const next = String(form[key] || '').trim()
      if (next && next !== String(folders[key] || '')) payload[key] = next
    }
    // On/off toggle: a checkbox posts nothing when unchecked, so the form sends
    // an explicit marker and we read the desired state from it.
    if (settable.includes('allowNewAccounts') && form.accountsForm) {
      const want = form.allowNewAccounts === '1' || form.allowNewAccounts === 'on' || form.allowNewAccounts === 'true'
      const cur = settings.allowNewAccounts !== false
      if (want !== cur) payload.allowNewAccounts = want
    }
    if (!Object.keys(payload).length) return { kind: 'ok', text: 'Nothing was different, so nothing was saved.' }
    const out = await adminCall(req, res, apiUser, 'POST', '/api/admin/settings', { body: payload })
    if (out.body && out.body.ok) {
      return { kind: 'ok', text: `Saved: ${(out.body.changed || []).map((k) => ADMIN_FOLDER_LABELS[k] || ({ allowNewAccounts: 'New account requests' }[k] || k)).join(', ')}.` }
    }
    return { kind: 'error', text: adminErrorSentence(out.body) }
  }

  // ==========================================================================
  // --- Backup tab: download a backup, restore one ---------------------------
  // ==========================================================================
  // All the format, secret-handling and restore rules live in backup.js; this
  // is only the web page around them. On top of the admin section's own gates
  // (admin session, TLS), every POST here must:
  //   * not be cross-site (Sec-Fetch-Site / Origin), and
  //   * carry a CSRF token bound to the signed-in session,
  // because these two forms move every password and key on the server.
  // A restore is two steps: upload (validated, decrypted, summarised, held in
  // memory for 15 minutes for the admin who uploaded it), then confirm (a
  // safety copy of the current settings is written first, then it is applied).
  const backupCsrfSecret = crypto.randomBytes(32).toString('hex')
  const backupStaged = new Map() // stageId -> { userId, opened, summary, fileName, at }
  const BACKUP_STAGE_TTL_MS = 15 * 60 * 1000
  let backupAppVersion = ''
  try { backupAppVersion = String(require('../package.json').version || '') } catch { backupAppVersion = '' }

  const backupSessionValue = (req) => {
    try { return auth.parseCookies(req)[SESSION_COOKIE] || '' } catch { return '' }
  }
  const backupCsrfFor = (req) => backup.makeCsrfToken(backupCsrfSecret, backupSessionValue(req))
  const backupCacheDir = () => {
    try { return (typeof getTmdbCacheDir === 'function' && getTmdbCacheDir()) || '' } catch { return '' }
  }
  // Safety copies sit next to the settings file (config.json) when the store knows where that is.
  const backupSafetyDir = () => {
    if (store && typeof store.path === 'string' && store.path) return path.join(path.dirname(store.path), 'safety-backups')
    const c = backupCacheDir()
    return c ? path.join(c, 'safety-backups') : ''
  }
  const backupPrune = () => {
    const now = Date.now()
    for (const [k, v] of backupStaged) if (now - v.at > BACKUP_STAGE_TTL_MS) backupStaged.delete(k)
    while (backupStaged.size >= 4) backupStaged.delete(backupStaged.keys().next().value)
  }
  const backupSize = (n) => formatBytesShort(Number(n) || 0)

  function adminBackupBody(req) {
    const csrf = escapeHtml(backupCsrfFor(req))
    const safety = backup.listSafetyBackups(backupSafetyDir()).slice(0, 5)
    const safetyRows = safety.length
      ? safety.map((f) => `
          <form method="POST" action="/admin/backup/restore-safety" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:6px 0;">
            <input type="hidden" name="csrf" value="${csrf}">
            <input type="hidden" name="name" value="${escapeHtml(f.name)}">
            <span class="muted" style="flex:1 1 260px;min-width:0;word-break:break-all;">${escapeHtml(f.name)} · ${escapeHtml(backupSize(f.bytes))}</span>
            <button type="submit" style="${ADMIN_BTN_GREY}">Review putting this back…</button>
          </form>`).join('')
      : '<p class="muted" style="margin:0;">None yet. One is saved automatically every time a backup is restored.</p>'
    return `
      <div class="card" style="padding:16px 18px;margin-bottom:16px;">
        <h4 style="margin:0 0 4px;font-size:14px;">Download a backup</h4>
        <p class="muted" style="margin:0 0 12px;line-height:1.6;">
          Private members’ viewing history, personal lists and sign-in credentials are excluded. Existing private profiles stay protected during restore. One file with this server's settings and folders, users and household passes, shared watched and progress history,
          favourites and watchlist, poster and title decisions, quality cache and relay settings. No movie or TV files.
          Without the tick below it holds no passwords, passes or keys.
        </p>
        <form method="POST" action="/admin/backup/download" style="display:flex;flex-direction:column;gap:10px;max-width:520px;">
          <input type="hidden" name="csrf" value="${csrf}">
          <label style="display:flex;gap:8px;align-items:flex-start;margin:0;">
            <input type="checkbox" name="includeSecrets" value="1" style="width:auto;margin:3px 0 0;">
            <span>Include passwords and keys (sign-in passwords, household passes, TMDB key, email app password, relay secret, signing keys) — encrypted with a passphrase you type below</span>
          </label>
          <input type="password" name="passphrase" autocomplete="new-password" placeholder="Passphrase (at least ${backup.MIN_PASSPHRASE_LENGTH} characters)" style="margin:0;">
          <input type="password" name="passphrase2" autocomplete="new-password" placeholder="Type the passphrase again" style="margin:0;">
          <p class="muted" style="margin:0;">The passphrase is only used when the box is ticked. It is not stored anywhere; without it those passwords and keys cannot be read back.</p>
          <div><button type="submit" style="${ADMIN_BTN_BLUE}">⬇ Download backup</button></div>
        </form>
      </div>

      <div class="card" style="padding:16px 18px;margin-bottom:16px;">
        <h4 style="margin:0 0 4px;font-size:14px;">Restore a backup</h4>
        <p class="muted" style="margin:0 0 12px;line-height:1.6;">
          Choose a backup file. Nothing changes yet: the next page shows what the restore would change and asks you to confirm.
          Before anything is written, a safety copy of the current settings is saved on the PC. Movie and TV files are never touched.
          Largest file accepted: ${escapeHtml(backupSize(backup.MAX_BACKUP_BYTES))}.
        </p>
        <form method="POST" action="/admin/backup/restore-preview" enctype="multipart/form-data" style="display:flex;flex-direction:column;gap:10px;max-width:520px;">
          <input type="hidden" name="csrf" value="${csrf}">
          <input type="password" name="passphrase" autocomplete="off" placeholder="Passphrase, if the backup includes passwords and keys" style="margin:0;">
          <label style="display:flex;gap:8px;align-items:flex-start;margin:0;">
            <input type="checkbox" name="skipSecrets" value="1" style="width:auto;margin:3px 0 0;">
            <span>Restore without passwords and keys (everyone keeps the password or pass they have on this server now)</span>
          </label>
          <input type="file" name="backup" accept="application/json,.json" required style="margin:0;">
          <div><button type="submit" style="${ADMIN_BTN_BLUE}">Check this backup…</button></div>
        </form>
      </div>

      <div class="card" style="padding:16px 18px;margin-bottom:16px;">
        <h4 style="margin:0 0 4px;font-size:14px;">Safety copies</h4>
        <p class="muted" style="margin:0 0 10px;line-height:1.6;">Saved on the PC before each restore${backupSafetyDir() ? ` in <code>${escapeHtml(backupSafetyDir())}</code>` : ''}. The newest ten are kept.</p>
        ${safetyRows}
      </div>`
  }

  function adminBackupSummaryHtml(summary, stageId, csrf) {
    const s = summary || {}
    const list = (names) => names.slice(0, 12).map((n) => escapeHtml(n)).join(', ') + (names.length > 12 ? ` and ${names.length - 12} more` : '')
    const rows = (s.sections || []).map((sec) => {
      const bits = []
      if (sec.changed.length) bits.push(`${sec.changed.length} replaced`)
      if (sec.added.length) bits.push(`${sec.added.length} added`)
      if (sec.unchanged.length) bits.push(`${sec.unchanged.length} already the same`)
      const keys = [...sec.changed, ...sec.added].map((r) => r.key).slice(0, 8).join(', ')
      return adminDefinition(sec.label, `${escapeHtml(bits.join(' · '))}${keys ? `<div class="muted" style="font-size:12px;margin-top:2px;">${escapeHtml(keys)}</div>` : ''}`)
    }).join('')
    const u = s.users || {}
    const sec = s.secrets || {}
    const secretsLine = s.kind === 'safety'
      ? 'This is a safety copy made on this PC: everything in it, including passwords and keys, goes back exactly as it was.'
      : sec.included
        ? `Included and unlocked: ${sec.keys.length} key${sec.keys.length === 1 ? '' : 's'}${sec.userCredentials === 'embedded' ? ', users’ passwords and passes' : sec.userCredentials ? `, passwords/passes for ${sec.userCredentials} user${sec.userCredentials === 1 ? '' : 's'}` : ''}${sec.relaySecret ? ', the relay secret' : ''}. Everyone, including you, may need to sign in again.`
        : sec.skipped
          ? 'In the file but left out, as you asked. Every password, pass and key on this server stays as it is.'
          : 'Not in this backup. Every password, pass and key on this server stays as it is.'
    return `
      <div class="card" style="padding:16px 18px;margin-bottom:16px;">
        <h4 style="margin:0 0 8px;font-size:14px;">This is what the restore would change</h4>
        ${adminDefinition('Backup made', escapeHtml(s.exportedAt ? new Date(s.exportedAt).toLocaleString() : 'unknown') + (s.appVersion ? ` · app ${escapeHtml(s.appVersion)}` : ''))}
        ${rows || adminDefinition('Settings', 'Nothing')}
        ${adminDefinition('Users', `${Number(u.inBackup) || 0} in the backup${u.added && u.added.length ? ` · new here: ${list(u.added)}` : ''}${u.updated && u.updated.length ? ` · updated: ${list(u.updated)}` : ''}${u.keptOnlyHere ? ` · ${u.keptOnlyHere} only on this server, kept` : ''}`)}
        ${u.needNewPass && u.needNewPass.length ? adminDefinition('Will need a new pass', `${list(u.needNewPass)} — their password or pass is not in this backup, so give them a new one afterwards.`) : ''}
        ${adminDefinition('Watch history', `${Number((s.history || {}).inBackup) || 0} entries in the backup replace the ${Number((s.history || {}).current) || 0} here`)}
        ${adminDefinition('Quality cache', `${Number(s.qualityCacheEntries) || 0} entries merged in`)}
        ${adminDefinition('Passwords and keys', escapeHtml(secretsLine))}
        <p class="muted" style="margin:12px 0 0;line-height:1.6;">${escapeHtml(s.untouched || '')} A safety copy of the current settings is saved first. Restart the Beebo app on the PC afterwards so folders and relay settings take effect everywhere.</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px;">
          <form method="POST" action="/admin/backup/restore-apply" style="display:inline;margin:0;">
            <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
            <input type="hidden" name="stage" value="${escapeHtml(stageId)}">
            <button type="submit" style="${ADMIN_BTN_RED}">Restore it now</button>
          </form>
          <a href="/admin?tab=backup" style="${ADMIN_BTN_GREY}border-radius:8px;text-decoration:none;">Cancel — change nothing</a>
        </div>
      </div>`
  }

  // Reads an urlencoded form with a hard cap. null = too big.
  async function backupReadSmallForm(req, limit = 16 * 1024) {
    const chunks = []
    let total = 0
    for await (const chunk of req) {
      total += chunk.length
      if (total > limit) return null
      chunks.push(chunk)
    }
    return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')))
  }

  // One multipart upload: the fields and at most one file, capped at MAX_BACKUP_BYTES.
  function backupReadUpload(req) {
    return new Promise((resolve) => {
      if (!Busboy) { resolve({ error: 'busboy_not_installed' }); return }
      const fields = {}
      let file = null
      let tooLarge = false
      let bb
      try {
        bb = Busboy({ headers: req.headers, limits: { files: 1, fields: 10, fieldSize: 4096, fileSize: backup.MAX_BACKUP_BYTES } })
      } catch {
        req.resume()
        resolve({ error: 'not_multipart' })
        return
      }
      bb.on('field', (name, val) => { fields[name] = val })
      bb.on('file', (name, stream, info) => {
        const chunks = []
        stream.on('data', (c) => chunks.push(c))
        stream.on('limit', () => { tooLarge = true })
        stream.on('end', () => { file = { name: (info && info.filename) || '', data: Buffer.concat(chunks) } })
      })
      bb.on('error', () => resolve({ error: 'bad_upload' }))
      bb.on('close', () => resolve({ fields, file, tooLarge }))
      req.pipe(bb)
    })
  }

  async function adminBackupPost(req, res, p, currentUser) {
    const backToTab = (kind, text) => {
      res.writeHead(303, { Location: `/admin?tab=backup&f=${encodeURIComponent(adminPutFlash({ kind, text }))}` })
      res.end()
    }
    const refuse = (text) => {
      req.resume()
      backToTab('error', text)
    }
    if (backup.isCrossSiteRequest(req.headers)) {
      req.resume()
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Refused: this form can only be sent from this server’s own admin page.')
      return
    }
    const session = backupSessionValue(req)
    const csrfOk = (form) => backup.checkCsrfToken(backupCsrfSecret, session, form && form.csrf)
    const CSRF_TEXT = 'That form had expired or did not come from this admin page, so nothing was done. Try again from this page.'

    if (p === '/admin/backup/download') {
      const form = await backupReadSmallForm(req)
      if (!form || !csrfOk(form)) { if (form) backToTab('error', CSRF_TEXT); else refuse('That request was too large.'); return }
      const includeSecrets = form.includeSecrets === '1' || form.includeSecrets === 'on'
      if (includeSecrets && String(form.passphrase || '') !== String(form.passphrase2 || '')) {
        backToTab('error', backup.errorText({ code: 'passphrase_mismatch' }))
        return
      }
      let data
      try {
        data = backup.createBackup(store, { includeSecrets, passphrase: includeSecrets ? String(form.passphrase || '') : '', cacheDir: backupCacheDir(), appVersion: backupAppVersion })
        // "Last backup" on the server dashboard.
        try { store.set('lastBackupAt', Date.now()) } catch {}
      } catch (err) {
        backToTab('error', backup.errorText(err))
        return
      }
      const text = backup.serializeBackup(data)
      if (log) log(`[backup] downloaded by ${currentUser && currentUser.username ? currentUser.username : 'an admin'}${includeSecrets ? ' (with passwords and keys, passphrase-encrypted)' : ''}`)
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${backup.backupFileName()}"`,
        'Content-Length': Buffer.byteLength(text),
        'Cache-Control': 'no-store'
      })
      res.end(text)
      return
    }

    if (p === '/admin/backup/restore-preview' || p === '/admin/backup/restore-safety') {
      let fields, fileData, fileName
      if (p === '/admin/backup/restore-preview') {
        const declared = Number(req.headers['content-length'])
        if (Number.isFinite(declared) && declared > backup.MAX_BACKUP_BYTES + 64 * 1024) {
          res.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' })
          res.end(backup.errorText({ code: 'too_large' }), () => { try { req.destroy() } catch {} })
          return
        }
        const up = await backupReadUpload(req)
        fields = up.fields || {}
        if (!csrfOk(fields)) { backToTab('error', CSRF_TEXT); return }
        if (up.error) { backToTab('error', 'That upload could not be read. Nothing was changed.'); return }
        if (up.tooLarge) { backToTab('error', backup.errorText({ code: 'too_large' })); return }
        if (!up.file) { backToTab('error', 'No file was chosen, so nothing was changed.'); return }
        fileData = up.file.data
        fileName = up.file.name
      } else {
        fields = await backupReadSmallForm(req)
        if (!fields || !csrfOk(fields)) { if (fields) backToTab('error', CSRF_TEXT); else refuse('That request was too large.'); return }
        const pick = backup.listSafetyBackups(backupSafetyDir()).find((f) => f.name === String(fields.name || ''))
        if (!pick) { backToTab('error', 'That safety copy is no longer there. Nothing was changed.'); return }
        try { fileData = fs.readFileSync(pick.path) } catch { backToTab('error', 'That safety copy could not be read. Nothing was changed.'); return }
        fileName = pick.name
      }
      let opened, summary
      try {
        const parsed = backup.parseBackupText(fileData)
        opened = backup.openBackup(parsed, { passphrase: String(fields.passphrase || ''), skipSecrets: fields.skipSecrets === '1' || fields.skipSecrets === 'on' })
        summary = backup.summarizeRestore(store, opened)
      } catch (err) {
        backToTab('error', backup.errorText(err) + (err && err.code ? '' : ' Nothing was changed.'))
        return
      }
      backupPrune()
      const stageId = crypto.randomBytes(18).toString('hex')
      backupStaged.set(stageId, { userId: currentUser && currentUser.id, opened, summary, fileName, at: Date.now() })
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(adminShell({ tab: 'backup', flash: { kind: 'ok', text: `Checked ${fileName || 'the backup'}. Nothing has been changed yet.` }, body: adminBackupSummaryHtml(summary, stageId, backupCsrfFor(req)) }))
      return
    }

    if (p === '/admin/backup/restore-apply') {
      const form = await backupReadSmallForm(req)
      if (!form || !csrfOk(form)) { if (form) backToTab('error', CSRF_TEXT); else refuse('That request was too large.'); return }
      backupPrune()
      const stageId = String(form.stage || '')
      const staged = backupStaged.get(stageId)
      if (!staged || staged.userId !== (currentUser && currentUser.id)) {
        backToTab('error', 'That restore had expired (they last 15 minutes). Nothing was changed — choose the file again.')
        return
      }
      backupStaged.delete(stageId)
      let result
      try {
        result = backup.applyRestore(store, staged.opened, { safetyDir: backupSafetyDir(), cacheDir: backupCacheDir() })
      } catch (err) {
        backToTab('error', backup.errorText(err))
        return
      }
      if (log) log(`[backup] restored ${staged.fileName || 'a backup'} (${result.written.length} settings); safety copy ${result.safetyFile}`)
      backToTab('ok', `Restored ${staged.fileName || 'the backup'}: ${result.written.length} setting${result.written.length === 1 ? '' : 's'} written${result.qualityMerged ? `, ${result.qualityMerged} quality cache entries merged` : ''}. The settings as they were are saved in ${result.safetyFile}. No media files were touched. Restart the Beebo app on the PC so every part picks up the restored settings.`)
      return
    }

    req.resume()
    adminNotFound(res)
  }

  // --- the router -----------------------------------------------------------
  async function handleAdminPage(req, res, url, currentUser, isAdmin) {
    // gate 2 — identity. Answered exactly as any unknown path is.
    if (!isAdmin || !currentUser) {
      req.resume()
      adminNotFound(res)
      return
    }
    // gate 3 — transport. Same rule as the JSON API, not weakened.
    if (!adminRequestIsSecure(req)) {
      req.resume()
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(adminInsecurePage())
      return
    }

    const method = (req.method || 'GET').toUpperCase()
    const p = url.pathname.replace(/\/+$/, '') || '/admin'

    if (p === '/admin' && (method === 'GET' || method === 'HEAD')) {
      const tab = adminTab(url.searchParams.get('tab'))
      const flash = adminTakeFlash(url.searchParams.get('f'))
      let body = ''
      if (tab === 'overview') {
        const [summary, settings] = await Promise.all([
          adminCall(req, res, currentUser, 'GET', '/api/admin/summary'),
          adminCall(req, res, currentUser, 'GET', '/api/admin/settings')
        ])
        body = adminOverviewBody(summary.body, (settings.body || {}).settings)
      } else if (tab === 'users') {
        const out = await adminCall(req, res, currentUser, 'GET', '/api/admin/users')
        body = adminUsersBody((out.body && out.body.users) || [])
      } else if (tab === 'requests') {
        const wanted = ['pending', 'approved', 'denied', 'all'].includes(String(url.searchParams.get('status') || ''))
          ? String(url.searchParams.get('status'))
          : 'pending'
        const out = await adminCall(req, res, currentUser, 'GET', '/api/admin/requests', { query: { status: wanted } })
        body = adminRequestsBody((out.body && out.body.requests) || [], wanted)
      } else if (tab === 'flags') {
        const out = await adminCall(req, res, currentUser, 'GET', '/api/admin/flags')
        body = adminFlagsBody((out.body && out.body.flags) || [])
      } else if (tab === 'missing') {
        const out = await adminCall(req, res, currentUser, 'GET', '/api/admin/missing')
        body = adminMissingBody((out.body && out.body.missing) || [])
      } else if (tab === 'suggestions') {
        const out = await adminCall(req, res, currentUser, 'GET', '/api/admin/suggestions')
        body = adminSuggestionsBody((out.body && out.body.suggestions) || [])
      } else if (tab === 'inbox') {
        const out = await adminCall(req, res, currentUser, 'GET', '/api/admin/inbox')
        body = adminInboxBody(out.body || {})
      } else if (tab === 'titles') {
        const out = await adminCall(req, res, currentUser, 'GET', '/api/admin/titles')
        body = adminTitlesBody(out.body || {}, Number(url.searchParams.get('page')) || 1)
      } else if (tab === 'conversions') {
        const out = await adminCall(req, res, currentUser, 'GET', '/api/admin/conversions')
        body = adminConversionsBody(out.body || {}, await adminShowChoices())
      } else if (tab === 'history') {
        const out = await adminCall(req, res, currentUser, 'GET', '/api/admin/history')
        body = adminHistoryBody((out.body && out.body.items) || [])
      } else if (tab === 'markers') {
        const out = await adminCall(req, res, currentUser, 'GET', '/api/admin/markers')
        const autoOut = await adminCall(req, res, currentUser, 'GET', '/api/admin/markers/auto')
        body = adminMarkersBody((out.body && out.body.markers) || [], autoOut.body && autoOut.body.ok ? autoOut.body : null)
      } else if (tab === 'apikeys') {
        const out = await adminCall(req, res, currentUser, 'GET', '/api/admin/api-keys')
        body = adminApiKeysBody(out.body || {})
      } else if (tab === 'webhooks') {
        const out = await adminCall(req, res, currentUser, 'GET', '/api/admin/webhooks')
        body = adminWebhooksBody(out.body || {})
      } else if (tab === 'backup') {
        body = adminBackupBody(req)
      } else {
        const out = await adminCall(req, res, currentUser, 'GET', '/api/admin/settings')
        body = adminSettingsBody((out.body && out.body.settings) || {})
      }
      const html = adminShell({ tab, flash, body })
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(method === 'HEAD' ? undefined : html)
      return
    }

    // The conversions tab's scan progress, polled by that page's script. Same gates as every /admin page.
    if (p === '/admin/conversions/scan-status' && (method === 'GET' || method === 'HEAD')) {
      const out = await adminCall(req, res, currentUser, 'GET', '/api/admin/conversions/scan-status')
      const b = out.body || {}
      res.writeHead(out.status || 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(method === 'HEAD' ? undefined : JSON.stringify({ ok: !!b.ok, scan: b.scan || null, text: adminScanLine(b.scan) }))
      return
    }

    // Backup and restore read their own bodies (a restore is a file upload), so they are routed
    // before the generic form reader below.
    if (method === 'POST' && p.startsWith('/admin/backup/')) {
      await adminBackupPost(req, res, p, currentUser)
      return
    }

    if (method === 'POST' && p.startsWith('/admin/')) {
      // A sibling origin can carry SameSite cookies. Refuse foreign form posts
      // before reading their fields or applying any administrative action.
      if (backup.isCrossSiteRequest(req.headers)) {
        req.resume()
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end('Use the admin form on this Beebo server to make changes.')
        return
      }
      const action = p.slice('/admin/'.length)
      const form = await readBody(req)
      const tab = adminTab(form.tab)
      // `page` is carried back only because the Titles list can be hundreds of
      // cards long and losing your place after every single answer would make it
      // unusable. Any other tab simply never posts one.
      const backPage = /^[0-9]{1,4}$/.test(String(form.page || '')) ? `&page=${encodeURIComponent(String(form.page))}` : ''
      const backTo = (flashId) => {
        res.writeHead(303, { Location: `/admin?tab=${encodeURIComponent(tab)}${backPage}${flashId ? `&f=${encodeURIComponent(flashId)}` : ''}` })
        res.end()
      }

      if (action === 'settings') {
        const result = await adminSaveSettings(req, res, currentUser, form)
        backTo(adminPutFlash(result))
        return
      }

      const spec = ADMIN_ACTIONS[action]
      if (!spec) {
        adminNotFound(res)
        return
      }

      if (adminNeedsConfirm(action, form) && String(form.confirmed || '') !== 'yes') {
        const details = await adminConfirmDetails(req, res, currentUser, action, form)
        if (details) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(adminConfirmPage({ action, form, details, tab }))
          return
        }
      }

      // Most actions post their form straight through. The handful whose route needs real numbers or
      // real booleans declare a coerce() — see ADMIN_ACTIONS for why a form post cannot supply either.
      const out = await adminCall(req, res, currentUser, 'POST', spec.api, { body: spec.coerce ? spec.coerce(form) : form })
      const body = out.body || {}
      if (!body.ok) {
        backTo(adminPutFlash({ kind: 'error', text: adminErrorSentence(body) }))
        return
      }
      // The two routes that mint a credential are the only ones whose flash
      // carries a value rather than a sentence.
      if (body.code) {
        backTo(adminPutFlash({ kind: 'ok', text: spec.ok, code: String(body.code) }))
        return
      }
      if (spec.showSecret && body[spec.showSecret]) {
        backTo(adminPutFlash({ kind: 'ok', text: spec.ok, secret: String(body[spec.showSecret]) }))
        return
      }
      // An action that reports numbers back (how many were queued, how many deleted) says so itself
      // through done(); everything else keeps the fixed sentence it has always had.
      const text = typeof spec.done === 'function' ? spec.done(body, form) : body.unchanged ? 'That was already the case — nothing changed.' : spec.ok
      backTo(adminPutFlash({ kind: 'ok', text }))
      return
    }

    // Any other shape of /admin request — including a GET at /admin/anything —
    // is treated as the unknown path it is.
    req.resume()
    adminNotFound(res)
  }

  // --- Space Saver: back up a phone's picked folders to a folder on THIS PC ---
  // Files land under <base>/<user>/<relative path the app sends>. The base is a
  // configurable folder the owner controls (store key 'spaceSaverDir'); with
  // none set it sits next to the "new files" drop, or beside the app.
  // Each segment is vetted by electron/safePath.js: no '..', no characters Windows refuses, no
  // trailing dots/spaces, and no reserved device names (CON, NUL, COM1, ...) (security review F8).
  const ssSafeRel = safePath.safeRel
  function ssBaseDir() {
    const configured = store.get('spaceSaverDir')
    if (configured && String(configured).trim()) return String(configured)
    // Next to the Beebo Inbox (which took over the old drop folder's setting).
    const nf = store.get('inboxDir') || store.get('newFilesDir')
    if (nf && String(nf).trim()) return path.join(path.dirname(String(nf)), 'BeeboSpaceSaver')
    return path.join(path.parse(__dirname).root, 'BeeboSpaceSaver')
  }
  function ssTargetPath(userFolder, relPath) {
    const safeUser = ssSafeRel(userFolder) || 'user'
    const safeRel = ssSafeRel(relPath)
    if (!safeRel) return null
    const root = path.resolve(ssBaseDir(), safeUser)
    const full = path.resolve(root, safeRel)
    if (full !== root && !full.startsWith(root + path.sep)) return null
    return full
  }

  // ---- Car watch party (home-server hosted; no external hub) ----------------
  // Rooms live in memory (electron/partyRoom.js): an 8-character CSPRNG code -> room, plus a join
  // key that only the host's link/QR carries. The owner (an already-signed-in app user) starts one
  // with POST /api/party/start using their normal login — no separate account. Passengers scan the
  // QR, land on the guest page, type a name and join with POST /api/party/guest (no account at all).
  // Wrong code/key attempts lock the client address out (partyRoom.createParty).
  const party = partyRoom.createParty()
  const cowriterJobs = new Map()   // jobId -> { status, slug, error, progress, at }
  // A guest token (?g=) proves membership of ONE live room; the member must still be in it.
  // -> { room, memberId } or null. The token is an HMAC over code|member|expiry, so it cannot be
  // guessed: misses here are not counted against the address (a phone whose party ended keeps
  // polling for a moment, and it must not lock out the other passengers sharing its hotspot).
  function partyGuestFor(req, code, token) {
    const c = partyRoom.normalizeCode(code)
    const t = String(token || '')
    if (c && verifyGuest(store, c, t)) {
      const memberId = t.split('.')[0]
      const room = party.get(c)
      if (room && room.members.has(memberId)) { room.lastSeen = Date.now(); return { room, memberId } }
    }
    return null
  }
  // The base of a link handed to the host for guests to open: the address the host itself used
  // when that is one of this server's own names, else the configured address. Never a raw
  // Host / X-Forwarded-Host (security review F11).
  function partyPublicBase(req) {
    return httpSecurity.trustedOrigin(hostPolicy, req, { tlsActive: !!tlsState.active }) || linkOrigin()
  }
  function partyRosterView(room) {
    return {
      ok: true,
      hostName: room.hostName,
      count: room.members.size,
      members: [...room.members.values()]
        .sort((a, b) => a.joinedAt - b.joinedAt)
        .map((m) => ({ name: m.name, host: !!m.host }))
    }
  }
  const partyEsc = partyRoom.escapeHtml
  // `code` and `key` are re-validated here (alphabet-only), so nothing from the URL can reach the
  // page as markup or script. Every value the page later shows from the server (host name, guest
  // names, the title) is written with textContent, never innerHTML.
  function partyJoinPage(code, key) {
    const safe = partyRoom.normalizeCode(code)
    const safeKey = partyRoom.normalizeKey(key)
    return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<title>Watch party</title><style>' +
      ':root{--bg:#faf7fd;--card:#fff;--ink:#241b33;--muted:#6a6076;--accent:#6b4bd6;--line:#e7e0f2}' +
      '@media(prefers-color-scheme:dark){:root{--bg:#120f19;--card:#1d1729;--ink:#f2ecfb;--muted:#a99fbb;--accent:#b7a2ff;--line:#2c2440}}' +
      '*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);' +
      'font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:flex;justify-content:center;padding:18px}' +
      '.wrap{width:100%;max-width:520px}.card{background:var(--card);border:1px solid var(--line);' +
      'border-radius:18px;padding:20px;box-shadow:0 8px 30px rgba(60,40,110,.08)}' +
      'h1{font-size:1.3rem;margin:.1rem 0 .2rem}.sub{color:var(--muted);margin:0 0 16px}' +
      '.code{font-weight:700;color:var(--accent);letter-spacing:.08em}' +
      'label{display:block;font-size:.85rem;color:var(--muted);margin:0 0 6px}' +
      'input[type=text],input:not([type]){width:100%;padding:13px 14px;font-size:1.05rem;border:1px solid var(--line);border-radius:12px;background:transparent;color:var(--ink)}' +
      'button{width:100%;margin-top:14px;padding:14px;font-size:1.05rem;font-weight:600;border:0;border-radius:12px;background:var(--accent);color:#fff}button:disabled{opacity:.5}' +
      '.msg{margin-top:12px;color:var(--accent);min-height:1.2em;font-size:.95rem}' +
      '.status{font-weight:600;margin:2px 0 10px}.dim{color:var(--muted);font-weight:400}' +
      'video{width:100%;border-radius:12px;background:#000;display:none}' +
      '.play{display:none;margin-top:6px;background:var(--accent)}' +
      '.tools{display:none;margin-top:14px;padding:14px;border:1px solid var(--line);border-radius:14px}' +
      '.tools h3{margin:0 0 2px;font-size:.95rem}.tools p{margin:0 0 10px;font-size:.8rem;color:var(--muted)}' +
      '.rowb{display:flex;align-items:center;gap:10px}.rowb span{font-size:.78rem;color:var(--muted);white-space:nowrap;text-align:center}' +
      'input[type=range]{-webkit-appearance:none;appearance:none;flex:1;height:26px;background:transparent}' +
      'input[type=range]::-webkit-slider-runnable-track{height:6px;border-radius:3px;background:var(--line)}' +
      'input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;margin-top:-8px;width:22px;height:22px;border-radius:50%;background:var(--accent)}' +
      '.fine{display:flex;align-items:center;gap:12px;margin-top:12px;justify-content:center}' +
      '.fine button{width:auto;margin:0;padding:12px 16px;min-width:92px;background:transparent;color:var(--accent);border:1px solid var(--line);font-size:1.05rem}' +
      '.fine button:active{background:var(--accent);color:#fff}' +
      '.nudge{margin:0;min-width:96px;text-align:center;font-weight:700;font-variant-numeric:tabular-nums}' +
      '.auto{text-align:center;font-size:.72rem;color:var(--muted);margin-top:8px;min-height:1em}' +
      '.mini{margin-top:12px;background:transparent;color:var(--accent);border:1px solid var(--line);padding:10px}' +
      '.roster{margin-top:14px}.roster h2{font-size:.75rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 4px}' +
      '.who{display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid var(--line)}' +
      '.dot{width:9px;height:9px;border-radius:50%;background:var(--accent)}.tag{margin-left:auto;font-size:.72rem;color:var(--muted)}' +
      '</style></head><body><div class="wrap"><div class="card">' +
      '<div id="form"><h1>Join the watch party</h1><p class="sub">Party <span class="code">#' + partyEsc(safe) + '</span> · pick a name to join</p>' +
      '<label for="n">Your name</label><input id="n" type="text" autocomplete="off" maxlength="32" placeholder="e.g. Sam" />' +
      '<button id="go">Join the party</button><div class="msg" id="msg"></div></div>' +
      '<div id="stage" style="display:none">' +
      '<div class="status" id="status">Waiting for the host…</div>' +
      '<video id="v" playsinline webkit-playsinline controls></video>' +
      '<button class="play" id="play">Tap to start watching</button>' +
      '<div class="tools" id="tools"><h3>Sync my video</h3>' +
      '<p>It auto-syncs on its own. If your picture is still off, slide for a big change or tap to inch it. Each phone keeps its own setting.</p>' +
      '<div class="rowb"><span>picture<br>earlier</span>' +
      '<input type="range" id="off" min="-6000" max="6000" step="50" value="0" />' +
      '<span>picture<br>later</span></div>' +
      '<div class="fine"><button id="minus">&minus;0.10s</button><div class="nudge" id="nudge">0.00 s</div><button id="plus">+0.10s</button></div>' +
      '<div class="auto" id="auto"></div>' +
      '<button class="mini" id="mute">Mute my video (use room audio)</button></div>' +
      '<div class="roster"><h2>In the party</h2><div id="list"></div></div></div>' +
      '</div></div><script>' +
      'var CODE=' + JSON.stringify(safe) + ',KEY=' + JSON.stringify(safeKey) + ';var v=document.getElementById("v");var curSrc=null;var needTap=false;var STEP=100,LIM=6000;var G="";' +
      'var n=document.getElementById("n"),go=document.getElementById("go"),msg=document.getElementById("msg");' +
      'var statusEl=document.getElementById("status"),playBtn=document.getElementById("play");' +
      'var tools=document.getElementById("tools"),off=document.getElementById("off"),nudge=document.getElementById("nudge");' +
      'var muteBtn=document.getElementById("mute"),minus=document.getElementById("minus"),plus=document.getElementById("plus"),autoEl=document.getElementById("auto");' +
      'var OFF=0;try{OFF=parseInt(localStorage.getItem("beeboPartyOffset"+CODE)||"0",10)||0}catch(e){}' +
      'var anchorPos=0,anchorTs=0,playing=false;' +
      'function fmt(ms){var s=(ms/1000);return (s>0?"+":"")+s.toFixed(2)+" s"}' +
      'function localTarget(){return anchorPos+(playing?(Date.now()-anchorTs)/1000:0)+OFF/1000}' +
      'function reseek(){if(curSrc){try{v.currentTime=Math.max(0,localTarget())}catch(e){}}}' +
      'function setOff(x){OFF=Math.max(-LIM,Math.min(LIM,Math.round(x)));off.value=OFF;nudge.textContent=fmt(OFF);' +
      'try{localStorage.setItem("beeboPartyOffset"+CODE,String(OFF))}catch(e){}reseek()}' +
      'setOff(OFF);' +
      'off.addEventListener("input",function(){setOff(parseInt(off.value,10)||0)});' +
      'minus.onclick=function(){setOff(OFF-STEP)};plus.onclick=function(){setOff(OFF+STEP)};' +
      'muteBtn.onclick=function(){v.muted=!v.muted;muteBtn.textContent=v.muted?"Unmute my video":"Mute my video (use room audio)";if(v.muted&&needTap){needTap=false;playBtn.style.display="none";v.play().catch(function(){})}};' +
      'playBtn.onclick=function(){needTap=false;playBtn.style.display="none";v.play().catch(function(){})};' +
      'function renderRoster(m){var l=document.getElementById("list");l.textContent="";(m||[]).forEach(function(x){' +
      'var r=document.createElement("div");r.className="who";var d=document.createElement("span");d.className="dot";' +
      'var nm=document.createElement("span");nm.textContent=x.name;r.appendChild(d);r.appendChild(nm);' +
      'if(x.host){var t=document.createElement("span");t.className="tag";t.textContent="HOST";r.appendChild(t)}l.appendChild(r)})}' +
      'function apply(d,rtt){renderRoster(d.members);' +
      'if(!d.streamPath){statusEl.textContent="Waiting for the host to start something…";v.style.display="none";tools.style.display="none";return}' +
      'playing=!!d.playing;' +
      'anchorPos=((typeof d.position==="number")?d.position:0)+(playing?(rtt||0)/2000:0);anchorTs=Date.now();' +
      'statusEl.textContent=(playing?"Now playing: ":"Paused: ");var ti=document.createElement("span");ti.className="dim";ti.textContent=String(d.title||"");statusEl.appendChild(ti);' +
      'v.style.display="block";tools.style.display="block";' +
      'if(curSrc!==d.streamPath){curSrc=d.streamPath;v.src=d.streamPath+(G?("&g="+encodeURIComponent(G)):"");v.load();' +
      'v.addEventListener("loadedmetadata",function(){v.playbackRate=1;reseek();' +
      'if(playing){var p=v.play();if(p&&p.catch)p.catch(function(){needTap=true;playBtn.style.display="block"})}},{once:true})}}' +
      // Fast local corrector: hard-jump only for big gaps, otherwise nudge speed to glide into sync.
      'setInterval(function(){if(!curSrc)return;' +
      'if(playing&&v.paused&&!needTap){var q=v.play();if(q&&q.catch)q.catch(function(){needTap=true;playBtn.style.display="block"})}' +
      'if(!playing){if(!v.paused)v.pause();v.playbackRate=1;autoEl.textContent="";return}' +
      'if(v.readyState<2){autoEl.textContent="buffering…";return}' +
      'var drift=v.currentTime-localTarget();var ad=Math.abs(drift);' +
      'if(ad>1.0){try{v.currentTime=Math.max(0,localTarget())}catch(e){}v.playbackRate=1;autoEl.textContent="re-syncing…"}' +
      'else if(ad>0.10){var r=1-drift*0.6;if(r<0.9)r=0.9;if(r>1.1)r=1.1;v.playbackRate=r;autoEl.textContent=(drift>0?"easing back":"catching up")+" ("+drift.toFixed(2)+"s)"}' +
      'else{v.playbackRate=1;autoEl.textContent="in sync"}},100);' +
      'var ended=false;function poll(){if(ended)return;var t0=Date.now();fetch("/api/party/state?code="+encodeURIComponent(CODE)+"&g="+encodeURIComponent(G)).then(function(r){return r.json()}).then(function(d){if(d.ok)apply(d,Date.now()-t0);else if(d.error==="not_found"||d.error==="not_a_member"){ended=true;statusEl.textContent="This party has ended.";tools.style.display="none";try{v.pause()}catch(e){}}}).catch(function(){})}' +
      'go.onclick=function(){var name=(n.value||"").trim();if(!name){msg.textContent="Enter a name first.";return}' +
      'go.disabled=true;msg.textContent="Joining…";' +
      'fetch("/api/party/guest",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code:CODE,key:KEY,name:name})})' +
      '.then(function(r){return r.json()}).then(function(d){if(!d.ok){msg.textContent=d.error||"Could not join.";go.disabled=false;return}' +
      'document.getElementById("form").style.display="none";document.getElementById("stage").style.display="block";' +
      'if(d.g)G=d.g;apply(d,0);poll();setInterval(poll,2500)}).catch(function(){msg.textContent="Network error. Try again.";go.disabled=false})};' +
      'n.addEventListener("keydown",function(e){if(e.key==="Enter")go.click()});' +
      '</script></body></html>'
  }

  // ===================== BeeboSchool =====================================
  // Children's learning records. They live ONLY here, on the family's own PC —
  // never sent to any hub/company. No location, camera, mic or analytics.
  function schoolRoot() {
    const configured = store.get('beeboSchoolDir')
    if (configured && String(configured).trim()) return String(configured)
    try { return path.join(path.dirname(ssBaseDir()), 'BeeboSchool') } catch {}
    return path.join(path.parse(__dirname).root, 'BeeboSchool')
  }
  function schoolChildrenFile() { return path.join(schoolRoot(), 'children.json') }
  function schoolReadChildren() {
    try { const d = JSON.parse(fs.readFileSync(schoolChildrenFile(), 'utf8')); return Array.isArray(d) ? d : [] } catch { return [] }
  }
  function schoolWriteChildren(list) {
    try { fs.mkdirSync(schoolRoot(), { recursive: true }); fs.writeFileSync(schoolChildrenFile(), JSON.stringify(list, null, 2)) } catch {}
  }
  function schoolSessionsFile(childId) {
    const safe = ssSafeRel(childId).replace(/\//g, '_') || 'child'
    return path.join(schoolRoot(), 'sessions', safe + '.jsonl')
  }
  function schoolReadSessions(childId) {
    try {
      return fs.readFileSync(schoolSessionsFile(childId), 'utf8').split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    } catch { return [] }
  }
  // Append-only + dedupe on (profileId, at). Immutable records; no merge.
  function schoolAppendSessions(childId, sessions) {
    try {
      fs.mkdirSync(path.join(schoolRoot(), 'sessions'), { recursive: true })
      const have = new Set(schoolReadSessions(childId).map((s) => s.profileId + '|' + s.at))
      const lines = []
      for (const s of sessions) {
        const key = s.profileId + '|' + s.at
        if (have.has(key)) continue
        have.add(key); lines.push(JSON.stringify(s))
      }
      if (lines.length) fs.appendFileSync(schoolSessionsFile(childId), lines.join('\n') + '\n')
      return lines.length
    } catch { return 0 }
  }
  const SCHOOL_LABELS = { letters: 'Letters & sounds', phonics: 'Letters & sounds', counting: 'Counting', numbers: 'Numbers', addition: 'Adding', subtraction: 'Taking away', shapes: 'Shapes', colors: 'Colours', listening: 'Listening' }
  function schoolLabel(k) { return SCHOOL_LABELS[k] || (k ? String(k) : 'Lesson') }
  // Compute the parent report with the confidence + motion + age gates applied.
  // Thresholds are INVENTED until calibrated against real children — say so.
  function schoolBuildReport(childId) {
    const child = schoolReadChildren().find((c) => c.id === childId) || null
    const sessions = schoolReadSessions(childId).slice().sort((a, b) => (a.at || 0) - (b.at || 0))
    const age = child ? child.age : null
    const scored = age != null && age >= 4          // age gate: below 4, record but don't measure
    const NEED_SESSIONS = 2, NEED_ITEMS = 10
    let parked = 0, moving = 0
    const allTasks = []
    for (const s of sessions) {
      if (s.motion === 'still') parked++; else moving++
      for (const t of (s.tasks || [])) allTasks.push(Object.assign({ lesson: s.lesson }, t))
    }
    const usable = allTasks.filter((t) => t.motion === 'still')   // measured items only
    const unmeasured = allTasks.some((t) => t.motion !== 'still')
    const byType = {}
    for (const t of allTasks) { const k = t.type || t.lesson || 'lesson'; (byType[k] = byType[k] || []).push(t) }
    const atGlance = Object.keys(byType).map((k) => {
      const items = byType[k]
      const use = items.filter((t) => t.motion === 'still')
      const answered = use.filter((t) => t.correct != null || t.ok != null)
      const right = answered.filter((t) => t.correct === true || t.ok === true).length
      const rate = answered.length ? Math.round(100 * right / answered.length) : 0
      const enough = scored && sessions.length >= NEED_SESSIONS && use.length >= NEED_ITEMS
      const level = enough ? (rate >= 75 ? 'Secure' : rate >= 40 ? 'Developing' : 'Beginning') : 'Not enough yet'
      const measure = enough ? ('got ' + right + ' of ' + answered.length + ' right when the car was still') : (use.length + ' measured so far')
      return { lesson: k, label: schoolLabel(k), count: items.length, measure, level }
    })
    const did = sessions.map((s) => ({ lesson: s.lesson, label: schoolLabel(s.lesson || (s.tasks && s.tasks[0] && s.tasks[0].type)), items: (s.tasks || []).length, date: s.at }))
    const firsts = usable.map((t) => t.first).filter((x) => x != null).sort((a, b) => a - b)
    const howPauseMs = firsts.length ? firsts[Math.floor(firsts.length / 2)] : null
    const hintRate = usable.length ? usable.filter((t) => t.hint).length / usable.length : null
    const sug = []
    if (byType.letters || byType.phonics) sug.push('Spot letters together on signs, packets and doors — "what does that one say?"')
    if (byType.counting || byType.numbers) sug.push('Count real things out loud together — steps, apples, buttons.')
    if (byType.addition || byType.subtraction) sug.push('Play "one more / one less" with toys or snacks at the table.')
    if (byType.shapes) sug.push('Hunt for shapes around the house — circles, squares, triangles.')
    // Books this child has read (from reading pings), newest kept per book, oldest first.
    let booksRead = []
    try {
      const rf = path.join(schoolRoot(), 'reading', (ssSafeRel(childId).replace(/\//g, '_') || 'child') + '.jsonl')
      const seen = {}
      fs.readFileSync(rf, 'utf8').split('\n').filter(Boolean).forEach((l) => {
        try { const r = JSON.parse(l); if (r && r.slug) seen[r.slug] = { title: r.title || r.slug, slug: r.slug, date: r.at || 0 } } catch {}
      })
      booksRead = Object.values(seen).sort((a, b) => (a.date || 0) - (b.date || 0))
    } catch {}
    // Gentle "where to explore next" — the skills sitting at Beginning / Not enough yet. Framed as
    // things to explore together, NEVER as a deficit or a diagnosis.
    const focusAreas = atGlance
      .filter((r) => r.level === 'Beginning' || r.level === 'Not enough yet')
      .slice(0, 3)
      .map((r) => ({
        label: r.label,
        note: r.level === 'Not enough yet'
          ? 'A little more play here will start to show how it is going.'
          : 'A lovely one to explore together next time.',
      }))
    return {
      childName: child ? child.name : '', childAge: age,
      fromMs: sessions.length ? sessions[0].at : 0, toMs: sessions.length ? sessions[sessions.length - 1].at : 0,
      sessionCount: sessions.length, totalMs: sessions.reduce((s, x) => s + (x.ms || 0), 0),
      parkedCount: parked, movingCount: moving, unmeasured,
      did, atGlance, howPauseMs, hintRate, suggestions: sug.slice(0, 2),
      booksRead, focusAreas
    }
  }
  function schoolPinSet() { return !!store.get('schoolPinHash') }
  function schoolPinVerify(pin) {
    const h = store.get('schoolPinHash'), salt = store.get('schoolPinSalt') || ''
    if (!h) return false
    return httpSecurity.safeEqual(crypto.createHash('sha256').update(salt + '|' + String(pin)).digest('hex'), h)
  }
  function schoolPinStore(pin) {
    const salt = crypto.randomBytes(8).toString('hex')
    store.set('schoolPinSalt', salt)
    store.set('schoolPinHash', crypto.createHash('sha256').update(salt + '|' + String(pin)).digest('hex'))
  }

  // --- Report-card PIN: signed unlock cookie + gate/manage UI (parent-only) ---
  const SCHOOL_REPORT_COOKIE = 'beebo_report_ok'
  function schoolReportCookie() {
    const exp = Date.now() + 30 * 60 * 1000
    const sig = crypto.createHmac('sha256', apiTokenSecret(store)).update('report|' + exp).digest('base64url')
    return exp + '.' + sig
  }
  function schoolReportUnlocked(cookies) {
    const v = (cookies && cookies[SCHOOL_REPORT_COOKIE]) || ''
    const dot = v.indexOf('.')
    if (dot < 0) return false
    const exp = Number(v.slice(0, dot)), sig = v.slice(dot + 1)
    if (!exp || Date.now() > exp) return false
    const good = crypto.createHmac('sha256', apiTokenSecret(store)).update('report|' + exp).digest('base64url')
    return httpSecurity.safeEqual(sig, good)
  }
  function schoolPinGatePage(opts) {
    const q = opts.reportBase.indexOf('?') >= 0 ? ('?' + opts.reportBase.split('?')[1]) : ''
    return '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Beebo — Report PIN</title>' +
      '<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;min-height:100vh;background:#0f1115;color:#eaeef5;margin:0">' +
      '<div style="max-width:400px;margin:0 auto;padding:12vh 22px 0">' +
      '<div style="text-align:center;font-size:44px">\U0001f512</div>' +
      '<h1 style="font-size:22px;text-align:center;margin:.3em 0">Parents\' report card</h1>' +
      '<p style="color:#9aa2b1;text-align:center;margin:0 0 18px">Enter your report PIN to see progress.</p>' +
      (opts.bad ? '<p style="color:#ff9d9d;text-align:center;margin:0 0 12px">That PIN wasn\'t right — try again.</p>' : '') +
      '<form method="POST" action="/school/report/unlock' + q + '" style="display:flex;flex-direction:column;gap:12px">' +
      '<input name="pin" type="password" inputmode="numeric" autocomplete="off" placeholder="PIN" style="padding:14px;border-radius:10px;border:1px solid #2a2f3a;background:#12151b;color:#eaeef5;font-size:18px;text-align:center" />' +
      '<button type="submit" style="padding:14px;border:none;border-radius:10px;background:#4f9dff;color:#fff;font-size:16px;font-weight:700;cursor:pointer">Unlock</button>' +
      '</form>' +
      '<form method="POST" action="/school/report/reset-pin' + q + '" style="margin-top:14px;text-align:center">' +
      '<button type="submit" style="background:none;border:none;color:#8a8f98;text-decoration:underline;cursor:pointer;font-size:14px">Forgot your PIN? Reset it</button>' +
      '</form>' +
      '<p style="color:#6a7180;font-size:12px;text-align:center;margin-top:8px">You can reset it because you\'re signed in as the account owner.</p>' +
      '</div></div>'
  }
  function schoolPinManageBar(opts) {
    const q = opts.reportBase.indexOf('?') >= 0 ? ('?' + opts.reportBase.split('?')[1]) : ''
    let msg = ''
    if (opts.flag === 'set') msg = '<p style="color:#7ee2a8;margin:0 0 8px">PIN cleared — set a new one below.</p>'
    else if (opts.flag === 'wrongcur') msg = '<p style="color:#ff9d9d;margin:0 0 8px">Current PIN was wrong.</p>'
    else if (opts.flag === 'badnew') msg = '<p style="color:#ff9d9d;margin:0 0 8px">PIN must be 4–8 digits.</p>'
    return '<div style="max-width:640px;margin:20px auto 40px;padding:0 16px;font-family:system-ui,Segoe UI,Arial,sans-serif">' +
      '<details style="background:#12151b;border:1px solid #2a2f3a;border-radius:10px;padding:12px 14px;color:#cbd2df">' +
      '<summary style="cursor:pointer;font-weight:600">\U0001f512 Report PIN — ' + (opts.pinSet ? 'change or reset' : 'protect this report') + '</summary>' +
      '<div style="margin-top:10px">' + msg +
      '<form method="POST" action="/school/report/set-pin' + q + '" style="display:flex;flex-direction:column;gap:8px;max-width:280px">' +
      (opts.pinSet ? '<input name="current" type="password" inputmode="numeric" placeholder="Current PIN" style="padding:10px;border-radius:8px;border:1px solid #2a2f3a;background:#0f1115;color:#eaeef5" />' : '') +
      '<input name="next" type="password" inputmode="numeric" placeholder="New PIN (4–8 digits)" style="padding:10px;border-radius:8px;border:1px solid #2a2f3a;background:#0f1115;color:#eaeef5" />' +
      '<button type="submit" style="padding:10px;border:none;border-radius:8px;background:#4f9dff;color:#fff;font-weight:700;cursor:pointer">' + (opts.pinSet ? 'Change PIN' : 'Set PIN') + '</button>' +
      '</form>' +
      (opts.pinSet ? '<form method="POST" action="/school/report/reset-pin' + q + '" style="margin-top:8px"><button type="submit" style="background:none;border:none;color:#8a8f98;text-decoration:underline;cursor:pointer">Forgot the PIN? Reset it (you\'re the signed-in owner)</button></form>' : '') +
      '</div></details></div>'
  }


  // Shared with the PC window (main.js asks photosApi.photoServices for the same store).
  function photosCtx(req, res) {
    return {
      store, log, services: photosApi.photoServices(store, { log }),
      send: (status, obj) => apiSend(req, res, status, obj),
      makeMediaToken, verifyMediaToken, users: () => auth.getUsers(store)
    }
  }
  // Trip links (electron/tripShareApi.js). The address in a link comes from what this server is
  // configured as (linkOrigin), never from the request's Host header.
  function tripShareCtx(req, res) {
    return {
      log, services: tripShareApi.tripShareServices(store, { log }),
      send: (status, obj) => apiSend(req, res, status, obj),
      clientIp: getClientIp,
      linkOrigin,
      canShare: (user) => !!user && !user.guest && photosApi.photoServices(store, { log }).library.access(user).backup === true
    }
  }
  // ==========================================================================
  // Parental controls, profile switching and library-share guests, for /api/*
  // ==========================================================================
  // Runs right after the bearer token is checked, before any other route. Answers the
  // /api/parental/*, /api/profiles* and /api/share/* routes itself, refuses what a limited
  // viewer may not use, and refuses a title id the viewer may not see (the lists are already
  // filtered by the library walks; this covers routes that take one id). Returns 'handled'
  // when it answered.
  const PIN_UNLOCK_MS = 10 * 60 * 1000
  // Everything a guest from another household may call. Anything else: 403.
  const GUEST_API_ROUTES = new Set([
    '/api/me', '/api/share/info', '/api/parental/status', '/api/movies', '/api/tvshows', '/api/upnext', '/api/credits',
    '/api/markers', '/api/episode-context', '/api/surf', '/api/surf/genres', '/api/surf/years', '/api/watch-session',
    '/api/progress', '/api/continue', '/api/history', '/api/history/clear', '/api/library/clear', '/api/collections',
    '/api/recently-added', '/api/recommended', '/api/subtitles', '/api/watchlist', '/api/library-status', '/api/watched',
    '/api/favorite', '/api/favorites',
  ])
  const GUEST_API_PATTERNS = [/^\/api\/tvshows\/[^/]+\/episodes$/, /^\/api\/collections\/[^/]+$/, /^\/api\/watched\/(movie|episode|season|show)$/]
  // A restricted profile can't ask for titles, see trailers or look-it-up links, or use admin.
  const RESTRICTED_API_BLOCKED = [/^\/api\/admin(\/|$)/, /^\/api\/title-search$/, /^\/api\/title-requests(\/|$)/, /^\/api\/trailer$/,
    /^\/api\/search-sites$/, /^\/api\/actor\/[^/]+\/missing$/, /^\/api\/missing-request$/, /^\/api\/suggestions$/,
    /^\/api\/space-saver\//, /^\/api\/computer-gallery\//, /^\/api\/private-vault(\/|$)/,
    // Online subtitle search spends the household's daily OpenSubtitles allowance (and reaches
    // outside this house), so a limited profile can't use it. Subtitle files already on the
    // computer, and the ones inside a video, still work.
    /^\/api\/subtitles\/online(\/|$)/]
  // Routes whose POST body names one title.
  const BODY_ID_ROUTES = new Set(['/api/watch-session', '/api/flag-quality', '/api/markers', '/api/watchlist', '/api/watched',
    '/api/favorite', '/api/queue', '/api/party/state'])

  const pinRecord = () => {
    const rec = store.get('parentalPin')
    return rec && rec.salt && rec.hash ? rec : null
  }
  const makePinUnlock = (userId) => {
    const exp = Date.now() + PIN_UNLOCK_MS
    const sig = crypto.createHmac('sha256', apiTokenSecret(store)).update(`pin-unlock|${userId}|${exp}`).digest('base64url')
    return `${exp}.${sig}`
  }
  const pinUnlockOk = (userId, token) => {
    const m = /^(\d{10,16})\.([A-Za-z0-9_-]{20,100})$/.exec(String(token || ''))
    if (!m || Number(m[1]) <= Date.now()) return false
    const want = crypto.createHmac('sha256', apiTokenSecret(store)).update(`pin-unlock|${userId}|${m[1]}`).digest('base64url')
    const a = Buffer.from(m[2])
    const b = Buffer.from(want)
    return a.length === b.length && crypto.timingSafeEqual(a, b)
  }
  // -> { ok: true } | { ok: false, status, error, minutesRemaining? }. Wrong PINs lock per person.
  const checkOwnerPin = (who, body, ip) => {
    const rec = pinRecord()
    if (!rec) return { ok: false, status: 409, error: 'pin_not_set' }
    if (body && body.unlock && pinUnlockOk(who, body.unlock)) return { ok: true }
    if (!body || body.pin === undefined || body.pin === null || body.pin === '') return { ok: false, status: 401, error: 'pin_required' }
    const key = 'pin:' + who
    const wait = parentalPinLimiter.locked(key) || parentalPinLimiter.locked('pin-ip:' + ip)
    if (wait) return { ok: false, status: 429, error: 'locked', minutesRemaining: wait }
    if (!parental.pinMatches(rec, body && body.pin)) {
      parentalPinLimiter.fail(key)
      parentalPinLimiter.fail('pin-ip:' + ip)
      return { ok: false, status: 401, error: 'wrong_pin' }
    }
    parentalPinLimiter.clear(key)
    return { ok: true }
  }

  // The id(s) a request names, as { kind, id } pairs, for the content gate.
  function requestTitleRefs(url, p, body) {
    const refs = []
    const q = url.searchParams
    const kindParam = q.get('kind')
    const qKind = kindParam === 'tv' || kindParam === 'show' || kindParam === 'episode' ? 'tv' : 'movie'
    if (q.get('id')) refs.push({ kind: p === '/api/episode-context' ? 'tv' : qKind, id: q.get('id') })
    if (q.get('showKey')) refs.push({ kind: 'tv', id: q.get('showKey') })
    const ep = /^\/api\/tvshows\/([^/]+)\/episodes$/.exec(p)
    if (ep) {
      try { refs.push({ kind: 'tv', id: decodeURIComponent(ep[1]) }) } catch { refs.push({ kind: 'tv', id: '' }) }
    }
    if (body && typeof body === 'object') {
      const bk = body.kind === 'tv' || body.kind === 'show' || body.kind === 'episode' ? 'tv' : 'movie'
      if (typeof body.id === 'string' && body.id) refs.push({ kind: bk, id: body.id })
      if (typeof body.showKey === 'string' && body.showKey) refs.push({ kind: 'tv', id: body.showKey })
      for (const k of ['streamPath', 'stream']) {
        const ref = typeof body[k] === 'string' ? contentGateInstance.itemRef({ stream: body[k] }) : null
        if (ref) refs.push(ref)
      }
    }
    return refs
  }

  async function parentalApiGate(req, url, p, method, apiUser, viewer, send) {
    const limited = contentGateInstance.isLimited(viewer)
    const isGuest = !!apiUser.guest
    const ip = getClientIp(req)

    // ---- what a guest may reach at all ----
    if (isGuest && !GUEST_API_ROUTES.has(p) && !GUEST_API_PATTERNS.some((re) => re.test(p))) {
      send(403, { ok: false, error: 'not_available_to_guests' })
      return 'handled'
    }
    if (isGuest && p === '/api/markers' && method !== 'GET') {
      send(403, { ok: false, error: 'not_available_to_guests' })
      return 'handled'
    }

    // ---- GET /api/share/info: the share a guest is using ----
    if (p === '/api/share/info') {
      if (!isGuest) { send(404, { ok: false, error: 'not_a_guest' }); return 'handled' }
      send(200, { ok: true, share: libraryShares.guestShape(viewer.share, shareOwnerLabel()) })
      return 'handled'
    }

    // ---- GET /api/parental/status: this profile's limits and whether it may watch now ----
    if (p === '/api/parental/status') {
      const t = contentGateInstance.timeGate(viewer)
      const policy = viewer ? viewer.policy : null
      send(200, {
        ok: true,
        restricted: limited,
        guest: isGuest,
        pinSet: !!pinRecord(),
        policy: parental.isRestricted(policy) ? policy : null,
        usedMinutesToday: limited ? parentalUsage.used(contentGateInstance.usageKey(viewer)) : 0,
        canWatchNow: t.ok,
        ...(t.ok ? {} : { reason: t.reason, message: t.message }),
      })
      return 'handled'
    }

    // ---- POST /api/parental/unlock { pin }: the owner PIN on a shared device, for 10 minutes ----
    if (p === '/api/parental/unlock') {
      if (method !== 'POST') { send(405, { ok: false, error: 'method_not_allowed' }); return 'handled' }
      if (isGuest) { send(403, { ok: false, error: 'not_available_to_guests' }); return 'handled' }
      const body = await apiReadBody(req)
      const c = checkOwnerPin(apiUser.id, { pin: body && body.pin }, ip)
      if (!c.ok) { send(c.status, { ok: false, error: c.error, ...(c.minutesRemaining ? { minutesRemaining: c.minutesRemaining } : {}) }); return 'handled' }
      send(200, { ok: true, unlock: makePinUnlock(apiUser.id), expiresInSeconds: PIN_UNLOCK_MS / 1000 })
      return 'handled'
    }

    // ---- POST /api/parental/profile { pin|unlock, preset | policy }: change THIS profile's limits ----
    if (p === '/api/parental/profile') {
      if (method !== 'POST') { send(405, { ok: false, error: 'method_not_allowed' }); return 'handled' }
      if (isGuest) { send(403, { ok: false, error: 'not_available_to_guests' }); return 'handled' }
      const body = (await apiReadBody(req)) || {}
      const c = checkOwnerPin(apiUser.id, body, ip)
      if (!c.ok) { send(c.status, { ok: false, error: c.error, ...(c.minutesRemaining ? { minutesRemaining: c.minutesRemaining } : {}) }); return 'handled' }
      if (apiUser.isAdmin) { send(409, { ok: false, error: 'admin_profile' }); return 'handled' }
      const next = typeof body.preset === 'string' ? parental.presetPolicy(body.preset, body.extra || {}) : body.policy
      const saved = parental.setPolicy(store, apiUser.id, next)
      log(`parental controls changed on a profile with the owner PIN`)
      send(200, { ok: true, policy: saved.enabled ? saved : null })
      return 'handled'
    }

    // ---- GET /api/profiles: the household's profiles, for a shared device's switcher ----
    if (p === '/api/profiles' && method === 'GET') {
      if (isGuest) { send(403, { ok: false, error: 'not_available_to_guests' }); return 'handled' }
      const profiles = auth.getUsers(store)
        .filter((u) => u && u.status === 'approved')
        .map((u) => apiUserShape(u))
      send(200, { ok: true, current: apiUser.id, pinSet: !!pinRecord(), profiles })
      return 'handled'
    }

    // ---- POST /api/profiles/switch { userId, pin?|unlock? } ----
    // Leaving a restricted profile, or moving to a profile with more access than this one,
    // needs the owner PIN. Moving to a restricted profile doesn't.
    if (p === '/api/profiles/switch') {
      if (method !== 'POST') { send(405, { ok: false, error: 'method_not_allowed' }); return 'handled' }
      if (isGuest) { send(403, { ok: false, error: 'not_available_to_guests' }); return 'handled' }
      const body = (await apiReadBody(req)) || {}
      const target = auth.getUsers(store).find((u) => u && u.id === String(body.userId || '') && u.status === 'approved')
      if (!target) { send(404, { ok: false, error: 'not_found' }); return 'handled' }
      if (target.id !== apiUser.id && viewingPrivacy.isPrivate(store, target.id)) { send(403, { ok: false, error: 'private_profile_sign_in', message: 'Sign out and sign in with this person’s own username and password.' }); return 'handled' }
      if (target.id !== apiUser.id && twoFactor.isEnabled(target)) { send(403, { ok: false, error: 'two_factor_profile_sign_in', message: 'This profile uses two-factor. Sign out and sign in with this person’s own username, password and code.' }); return 'handled' }
      const targetRestricted = parental.isRestricted(parental.getPolicy(store, target.id))
      const needsPin = limited || (!targetRestricted && target.id !== apiUser.id && !apiUser.isAdmin)
      if (needsPin) {
        const c = checkOwnerPin(apiUser.id, body, ip)
        if (!c.ok) { send(c.status, { ok: false, error: c.error, ...(c.minutesRemaining ? { minutesRemaining: c.minutesRemaining } : {}) }); return 'handled' }
      }
      auth.touchLastSeen(store, target.id, ip)
      send(200, { ok: true, token: makeApiToken(store, target.id), user: apiUserShape(target) })
      return 'handled'
    }

    if (!limited) return null

    // ---- a restricted profile: what it can't use at all ----
    if (!isGuest && RESTRICTED_API_BLOCKED.some((re) => re.test(p))) {
      send(403, { ok: false, error: 'restricted_profile', message: 'This profile has parental controls on. Ask the person who runs Beebo.' })
      return 'handled'
    }

    // ---- one title named in the request: refused like a title that doesn't exist ----
    let body = null
    if (method === 'POST' && BODY_ID_ROUTES.has(p)) body = await apiReadBody(req)
    else if (method === 'POST' && /^\/api\/watched\/(movie|episode|season|show)$/.test(p)) body = await apiReadBody(req)
    for (const ref of requestTitleRefs(url, p, body)) {
      if (!contentGateInstance.allowId(viewer, ref.kind, ref.id)) {
        send(404, { ok: false, error: 'not_found' })
        return 'handled'
      }
    }
    const colMatch = /^\/api\/collections\/([^/]+)$/.exec(p)
    if (colMatch) {
      const policy = viewer.policy || {}
      const cid = Number(decodeURIComponent(colMatch[1]))
      const guestCols = isGuest && Array.isArray(viewer.share.collections) ? viewer.share.collections.map(Number) : []
      if ((Array.isArray(policy.blockedCollections) && policy.blockedCollections.includes(cid)) ||
          (guestCols.length && !guestCols.includes(cid))) {
        send(404, { ok: false, error: 'not_found' })
        return 'handled'
      }
    }

    // ---- bedtime, the daily limit, a share that ended ----
    if (p === '/api/watch-session') {
      const t = contentGateInstance.timeGate(viewer)
      if (!t.ok) { send(403, { ok: false, error: t.reason, message: t.message }); return 'handled' }
    }
    if (p === '/api/progress' && method === 'POST') contentGateInstance.noteWatching(viewer)
    return null
  }

  // ==========================================================================
  // /api/v1/* - the public, read-only, versioned API for outside tools
  // ==========================================================================
  // Owns its own JSON shapes (electron/publicApi.js) and calls the same internal functions the
  // unversioned /api/* routes call. Reachable only through the ROUTES allowlist there, and only
  // by GET/HEAD: the credential is checked first, so a probe learns nothing about which paths exist.
  function resolvePublicPrincipal(req) {
    const bearer = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(String(req.headers.authorization || ''))
    if (bearer && apiKeys.looksLikeKey(bearer[1])) {
      const ip = getClientIp(req)
      // A locked address (too many wrong keys here, or already locked by failed sign-ins) tries nothing.
      const wait = apiKeyGuard.lockedMinutes(ip) || (() => { const l = auth.checkLockout(store, ip); return l.locked ? l.minutesRemaining : 0 })()
      if (wait) {
        return { ok: false, status: 429, body: { ok: false, error: 'locked', minutesRemaining: wait }, headers: { 'Retry-After': String(wait * 60) } }
      }
      const checked = apiKeys.verify(store, bearer[1])
      if (!checked.ok) {
        apiKeyGuard.noteFailure(ip)
        return { ok: false, status: 401, body: { ok: false, error: 'unauthorized' } }
      }
      const key = checked.key
      // A key acts as the person who made it, only while that account is approved (and not under
      // parental limits), and with at most what that person may hold today: an admin's key can carry
      // now-playing and metrics, anyone else's is library and history only, even if it was made when they were an admin.
      const owner = auth.getUsers(store).find((u) => u && u.id === key.ownerUserId) || null
      if (!owner || owner.status !== 'approved') return { ok: false, status: 401, body: { ok: false, error: 'unauthorized' } }
      if (!owner.isAdmin && parental.isRestricted(parental.getPolicy(store, owner.id))) return { ok: false, status: 401, body: { ok: false, error: 'unauthorized' } }
      const allowed = apiKeys.scopesFor(owner)
      const scopes = key.scopes.filter((s) => allowed.includes(s))
      if (!scopes.length) return { ok: false, status: 401, body: { ok: false, error: 'unauthorized' } }
      const budget = apiKeyGuard.hit(key)
      if (!budget.ok) {
        return { ok: false, status: 429, body: { ok: false, error: 'rate_limited', retryAfterSeconds: budget.retryAfterSeconds }, headers: { 'Retry-After': String(budget.retryAfterSeconds) } }
      }
      apiKeys.touch(store, key.id)
      return { ok: true, principal: { type: 'api_key', user: owner, scopes, keyName: key.name, keyId: key.id } }
    }
    const userId = bearer ? verifyApiToken(store, bearer[1]) : null
    const user = userId ? auth.getUsers(store).find((u) => u && u.id === userId) || null : null
    if (!user) return { ok: false, status: 401, body: { ok: false, error: 'unauthorized' } }
    // An admin the owner is holding for two-factor set-up may not use the public API either.
    if (twoFactor.setupRequired(store, user)) return { ok: false, status: 403, body: setupHeldAnswer(user) }
    auth.touchLastSeen(store, user.id, getClientIp(req))
    // The account token has every scope its person may hold: an admin all of them, anyone else library and history.
    return { ok: true, principal: { type: 'account', user, scopes: apiKeys.scopesFor(user), keyName: null } }
  }

  async function handlePublicApiRequest(req, res, url, p, method) {
    const reply = (status, obj, headers) => {
      if (headers) for (const [k, v] of Object.entries(headers)) res.setHeader(k, v)
      apiSend(req, res, status, obj)
    }
    const who = resolvePublicPrincipal(req)
    if (!who.ok) { reply(who.status, who.body, who.headers); return }
    const { principal } = who
    const user = principal.user

    const route = publicApi.routeFor(p)
    if (!route) { reply(404, { ok: false, error: 'not_found' }); return }
    if (method !== 'GET' && method !== 'HEAD') { reply(405, { ok: false, error: 'read_only' }, { Allow: 'GET, HEAD' }); return }
    if (route.scope && !principal.scopes.includes(route.scope)) {
      reply(403, { ok: false, error: 'insufficient_scope', scope: route.scope })
      return
    }

    const viewer = viewerForUser(user)
    contentGate.setRequestViewer(viewer)
    const limited = contentGateInstance.isLimited(viewer)
    const send = (status, obj) => reply(status, limited ? contentGateInstance.scrubJson(viewer, obj) : obj)
    const page = publicApi.pageOf(url.searchParams)

    if (route.id === 'index') { send(200, publicApi.shapeIndex(principal)); return }

    if (route.id === 'now-playing') {
      // The owner's dashboard data: never a member's or a limited profile's.
      if (!user.isAdmin || limited) { send(403, { ok: false, error: 'admin_only' }); return }
      send(200, nowPlayingJson())
      return
    }

    if (route.id === 'events') {
      // The same data as now-playing, pushed: Server-Sent Events (electron/eventStream.js).
      if (!user.isAdmin || limited) { send(403, { ok: false, error: 'admin_only' }); return }
      if (method === 'HEAD') { reply(405, { ok: false, error: 'read_only' }, { Allow: 'GET' }); return }
      const streamKey = principal.keyId ? 'k:' + principal.keyId : 'u:' + user.id
      const out = liveEvents.attach(req, res, {
        key: streamKey,
        snapshot: nowPlayingJson,
        // Ends by itself when the key is removed, loses the scope, or its owner stops being an admin.
        isValid: () => {
          const owner = auth.getUsers(store).find((u) => u && u.id === user.id)
          if (!owner || owner.status !== 'approved' || owner.isAdmin !== true) return false
          if (!principal.keyId) return true
          const row = apiKeys.list(store).find((k) => k.id === principal.keyId)
          return !!row && row.scopes.includes('now-playing')
        }
      })
      if (!out.ok) reply(out.status, { ok: false, error: out.error }, { 'Retry-After': '10' })
      return
    }

    if (route.id === 'metrics') {
      // Off until the owner turns it on; the owner's numbers, so never a member's or a limited profile's.
      if (!metrics.isEnabled(store)) { reply(404, { ok: false, error: 'not_found' }); return }
      if (!user.isAdmin || limited) { send(403, { ok: false, error: 'admin_only' }); return }
      const users = auth.getUsers(store)
      const snapshot = await metrics.collect({
        dashboard: serverDashboard,
        transcodes: () => (playback.manager ? playback.manager.list() : []),
        transcodeMax: () => (playback.manager ? playback.manager.maxConcurrent() : 0),
        webhookStats: webhooks.getStats(),
        webhooksConfigured: webhooks.list(store).length,
        apiKeyCount: apiKeys.list(store).length,
        apiAuthFailures: apiKeyGuard.failureCount(),
        users: { approved: users.filter((u) => u && u.status === 'approved').length, pending: users.filter((u) => u && u.status === 'pending').length }
      })
      const text = metrics.render(snapshot)
      res.writeHead(200, { 'Content-Type': metrics.CONTENT_TYPE, 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store' })
      if (method === 'HEAD') res.end()
      else res.end(text)
      return
    }

    if (route.id === 'history' || route.id === 'continue') {
      if (viewingPrivacy.isPrivate(store, user.id)) { send(403, { ok: false, error: 'history_private' }); return }
    }

    if (route.library) await primeLibrary(route.library)

    if (route.id === 'movies') { send(200, publicApi.shapeMovies(apiMovies(url), page)); return }
    if (route.id === 'tvshows') { send(200, publicApi.shapeTvShows(await apiTvShows(url), page)); return }
    if (route.id === 'collections') { send(200, publicApi.shapeCollections(limitCollectionsFor(viewer, apiCollections()), page)); return }
    if (route.id === 'recently-added') { send(200, publicApi.shapeRecentlyAdded(recentlyAddedEntries(), page)); return }
    if (route.id === 'history' || route.id === 'continue') {
      const rows = decorateHistoryRows(route.id === 'continue' ? continueRowsFor(user.id) : history.viewedHistory(store, user.id))
      send(200, publicApi.shapeHistory(rows, page))
      return
    }
    send(404, { ok: false, error: 'not_found' })
  }

  async function handleApiRequest(req, res, url) {
    // A limited viewer's answers pass the content gate's last safety net (contentGate.scrubJson).
    const send = (status, obj) => {
      const viewer = contentGate.requestViewer()
      apiSend(req, res, status, contentGateInstance.isLimited(viewer) ? contentGateInstance.scrubJson(viewer, obj) : obj)
    }
    const method = (req.method || 'GET').toUpperCase()

    try {
      if (method === 'OPTIONS') {
        res.writeHead(204, { Allow: 'GET, HEAD, POST, OPTIONS', 'Content-Length': 0 })
        res.end()
        return
      }

      // tolerate a trailing slash on any /api path
      const p = url.pathname.replace(/\/+$/, '') || '/api'

      // --- unauthenticated: server discovery + login ---
      if (p === '/api/ping') {
        // Identity handshake. One name, the real one.
        send(200, { ok: true, app: 'beeboentertainment', apiVersion: API_VERSION })
        return
      }

      // What the newest published Beebo Auto build is. Unauthenticated on
      // purpose: the phone should be able to discover it is out of date even
      // when its token has expired. Reads a version.json written next to the
      // APK; with no file there it reports versionCode 0, which every
      // installed build compares as "already current".
      if (p === '/api/auto-version') {
        const metaCandidates = [
          store.get('autoApkVersionPath'),
          path.join(__dirname, '..', 'auto-app', 'version.json'),
          path.join(__dirname, '..', '..', '..', 'auto-app', 'version.json')
        ].filter(Boolean)
        let meta = null
        for (const f of metaCandidates) {
          try {
            meta = JSON.parse(fs.readFileSync(f, 'utf8'))
            break
          } catch {
            meta = null
          }
        }
        send(200, {
          ok: true,
          versionCode: Number(meta && meta.versionCode) || 0,
          versionName: (meta && meta.versionName) || null,
          notes: (meta && meta.notes) || null,
          downloadUrl: '/download/auto-app'
        })
        return
      }

      // The newest published Beebo (movie) app build — same idea as
      // /api/auto-version, for the main phone app's in-app updater. Reads a
      // version.json next to the APK; no file → versionCode 0 (always current).
      if (p === '/api/movie-version') {
        const metaCandidates = [
          store.get('androidApkVersionPath'),
          path.join(__dirname, '..', 'android-app', 'version.json'),
          path.join(__dirname, '..', '..', '..', 'android-app', 'version.json')
        ].filter(Boolean)
        let meta = null
        for (const f of metaCandidates) {
          try {
            meta = JSON.parse(fs.readFileSync(f, 'utf8'))
            break
          } catch {
            meta = null
          }
        }
        send(200, {
          ok: true,
          versionCode: Number(meta && meta.versionCode) || 0,
          versionName: (meta && meta.versionName) || null,
          notes: (meta && meta.notes) || null,
          sha256: (meta && meta.sha256) || null,
          downloadUrl: '/download/android-app'
        })
        return
      }

      // The public API does its own authentication (account token now, personal API keys next),
      // so it is matched before the bearer gate below and never falls through to it.
      if (p === '/api/v1' || p.startsWith('/api/v1/')) {
        await handlePublicApiRequest(req, res, url, p, method)
        return
      }
      // A personal API key is good for /api/v1 and nothing else: not admin, sign-in, parental, the
      // private vault or any write. Said plainly here so a misconfigured tool finds out why.
      {
        const stray = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(String(req.headers.authorization || ''))
        if (stray && apiKeys.looksLikeKey(stray[1])) {
          send(403, { ok: false, error: 'api_key_scope', message: 'API keys only work on /api/v1.' })
          return
        }
      }

      // ---- BeeboBook (read-along storybooks) ----------------------------------
      // Helpers only. The routes themselves are matched BELOW the bearer-token
      // gate, so reading the shelf, rendering narration and fetching generated
      // audio all require a signed-in account like the rest of /api.
      // Story text + narration live under apps/desktop/storybooks/.
      const storybookRuntime = require(path.join(__dirname, 'storybookRuntime'))
      const voiceSamples = require(path.join(__dirname, 'voiceSamples'))
      const storybooksRoot = () => {
        const candidates = [
          store.get('storybooksPath'),
          path.join(__dirname, '..', 'storybooks'),
          path.join(__dirname, '..', '..', '..', 'storybooks'),
        ].filter(Boolean)
        return candidates.find((d) => {
          try { return fs.statSync(d).isDirectory() } catch { return false }
        }) || null
      }
      // Page art (scene stills, looping anim) ships INSIDE the installer and is identical for
      // every reader, so it is served from wherever it is found rather than copied into each
      // user's writable library. The writable library is searched FIRST, so art a user drops in
      // beside their own book still wins, and replacing the art in a desktop update takes effect
      // immediately instead of being frozen by a one-time copy.
      const storybookAssetDirs = () => {
        const seen = new Set()
        return [
          store.get('storybooksPath'),
          process.resourcesPath ? path.join(process.resourcesPath, 'storybooks') : null,
          path.join(__dirname, '..', 'storybooks'),
          path.join(__dirname, '..', '..', '..', 'storybooks'),
        ].filter((d) => {
          if (!d || seen.has(d)) return false
          seen.add(d)
          try { return fs.statSync(d).isDirectory() } catch { return false }
        })
      }
      // Serve one static story asset. Returns false when nothing matched so the caller can 404
      // in its own voice. The art never changes without a desktop update, so it carries a strong
      // ETag from size and mtime plus a day of caching: a phone reading a 12-page book away from
      // home should fetch each picture once, not once per page turn.
      const sbSendAsset = (slug, folder, file, ctype) => {
        for (const dir of storybookAssetDirs()) {
          const fp = path.join(dir, slug, folder, file)
          let st
          try { st = fs.statSync(fp) } catch { continue }
          if (!st.isFile()) continue
          const etag = '"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"'
          const cache = 'public, max-age=86400'
          if (req.headers['if-none-match'] === etag) {
            res.writeHead(304, { ETag: etag, 'Cache-Control': cache }); res.end(); return true
          }
          res.writeHead(200, {
            'Content-Type': ctype, 'Content-Length': st.size, ETag: etag, 'Cache-Control': cache,
          })
          pipeFileToResponse(res, fp)
          return true
        }
        return false
      }
      const sbSafeSeg = (s) => storybookRuntime.safeSegment(s)
      // Resolve a name set the SAME way the app and the Python generator do:
      // provided value (trimmed) if non-blank, else the character's default.
      const sbResolveNames = (tpl, provided) => {
        const out = {}
        for (const c of (tpl.characters || [])) {
          const supplied = String((provided && provided[c.token]) || '').trim()
          out[c.token] = supplied || (c.default || '')
        }
        return out
      }
      // 16-hex id of a resolved name set. Tokens sorted so every side agrees.
      const sbSetHash = (resolved, narrator, charVoices) => {
        let canonical = Object.keys(resolved).sort()
          .map((k) => `${k}=${resolved[k]}`).join('\n')
        // Fold the NARRATOR voice in only when it isn't the default, so a book
        // already voiced in the default voice keeps its id (nothing re-renders).
        // Then one `_v:TOKEN=voice` line per real per-character override, sorted
        // by token, AFTER the narrator line — byte-for-byte with app + generator.
        const parts = []
        if (narrator && narrator !== 'af_heart') parts.push(`_voice=${narrator}`)
        const cv = charVoices || {}
        for (const tok of Object.keys(cv).sort()) {
          const v = cv[tok]
          if (v && v !== narrator) parts.push(`_v:${tok}=${v}`)
        }
        if (parts.length) canonical += '\n' + parts.join('\n')
        return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16)
      }
      // Draft a storybook with the local AI, validate it, save it so it appears on
      // the shelf, then flip the job to done. Kid-friendly by construction.
      async function cowriterRun(jobId, payload) {
        const setJob = (o) => cowriterJobs.set(jobId, Object.assign({ at: Date.now() }, o))
        const OLLAMA = process.env.BEEBO_OLLAMA || 'http://127.0.0.1:11434'
        // Is Ollama reachable at all?
        let model = String(store.get('cowriterModel') || '').trim()
        try {
          const tagsR = await fetch(OLLAMA + '/api/tags', { method: 'GET' })
          if (!tagsR.ok) throw new Error('tags')
          const tags = await tagsR.json()
          const models = Array.isArray(tags.models) ? tags.models.map((m) => m && m.name).filter(Boolean) : []
          if (!model) model = models.find((m) => /llama3|llama-3|qwen|mistral|phi/i.test(m)) || models[0]
          if (!model) { setJob({ status: 'unavailable' }); return }
        } catch (e) {
          setJob({ status: 'unavailable' })
          return
        }
        setJob({ status: 'pending', progress: 'The AI is writing your story…' })
        // Build the character token table ourselves so the template is always valid;
        // the model only writes the title + pages using those tokens.
        const characters = payload.characters.map((c, i) => ({
          token: `{{NAME_${i + 1}}}`, role: c.what || 'a character', default: c.name,
        }))
        const tokenList = characters.map((c) => `${c.token} (${c.default}, ${c.role})`).join('; ')
        const sys = 'You are a warm children\'s author. You write gentle, wholesome, age-appropriate interactive branching storybooks for young kids. Never anything scary, violent, sad-ending, or unsafe. Keep language simple and kind.'
        const instru = [
          'Write a short branching "choose your path" storybook as STRICT JSON only (no prose, no markdown).',
          'Use EXACTLY these character tokens verbatim inside the page text where a character is mentioned: ' + tokenList + '.',
          'The story idea: ' + payload.prompt,
          payload.title ? ('Preferred title: ' + payload.title) : '',
          'JSON shape: {"title": string, "pages": [ {"id": number, "text": string, "choices": [ {"text": string, "target": number} ], "isEnding": boolean, "endingTitle": string } ] }.',
          'Rules: 7 to 10 pages. Page ids are unique positive integers; the first page has id 1. Non-ending pages have 2 choices whose target is another page id. Ending pages have "isEnding": true, no choices, and a short cheerful "endingTitle". At least 2 different ending pages. Every target must reference an existing page id. 2-4 sentences per page. Keep it happy and safe.',
        ].filter(Boolean).join('\n')
        let template = null
        for (let attempt = 0; attempt < 2 && !template; attempt++) {
          try {
            const r = await fetch(OLLAMA + '/api/generate', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ model, prompt: sys + '\n\n' + instru, stream: false, format: 'json', options: { temperature: 0.8 } }),
            })
            if (!r.ok) throw new Error('gen ' + r.status)
            const data = await r.json()
            const parsed = JSON.parse(String(data.response || '{}'))
            template = cowriterValidate(parsed, characters, payload)
          } catch (e) { template = null }
        }
        if (!template) { setJob({ status: 'error', error: 'The story came out muddled. Please try again — maybe reword your idea.' }); return }
        setJob({ status: 'pending', progress: 'Saving your new book…' })
        const root = storybooksRoot()
        if (!root) { setJob({ status: 'error', error: 'No storybooks folder is set up on this computer.' }); return }
        const slug = 'cowrite-' + Date.now().toString(36)
        try {
          fs.mkdirSync(path.join(root, slug), { recursive: true })
          fs.writeFileSync(path.join(root, slug, 'template.json'), JSON.stringify(template, null, 2))
          // Add it to the shelf index (read-modify-write, defensive).
          const idxPath = path.join(root, 'index.json')
          let idx = { ok: true, books: [] }
          // A damaged index is set aside and the last good copy used, instead of being replaced by a one-book shelf.
          idx = require('./safeJson').readJsonSafe(idxPath, idx).data
          const books = Array.isArray(idx.books) ? idx.books : (Array.isArray(idx) ? idx : [])
          const entry = {
            slug, title: template.title || 'My Story', ageRange: 'All ages', startPage: 1,
            totalPages: template.pages.length, endingCount: template.pages.filter((p2) => p2.isEnding).length,
            characters, blurb: (payload.prompt || '').slice(0, 140), custom: true,
          }
          books.push(entry)
          if (Array.isArray(idx.books)) idx.books = books; else idx = { ok: true, books }
          require('./safeJson').writeJsonAtomic(idxPath, idx)
          // Bake scenes + moving backgrounds for the new book on THIS PC (free/offline,
          // no cloud, no Claude) in the background — the book is readable immediately and the
          // art fills in as it renders.
          try {
            const { spawn: spawnBake } = require('child_process')
            const isWinB = process.platform === 'win32'
            let pcB = isWinB ? 'py' : 'python3'; let paB = isWinB ? ['-3'] : []
            try { const cfgB = JSON.parse(fs.readFileSync(path.join(root, 'python-cmd.json'), 'utf8')); if (cfgB && cfgB.cmd) { pcB = cfgB.cmd; paB = Array.isArray(cfgB.args) ? cfgB.args : [] } } catch {}
            spawnBake(pcB, [...paB, path.join(__dirname, 'beebobook', 'bake_book.py'), path.join(root, slug)], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
          } catch {}
          setJob({ status: 'done', slug })
        } catch (e) {
          setJob({ status: 'error', error: 'Could not save the new book.' })
        }
      }
      // Structurally validate + sanitize the model's book so a bad draft can never
      // reach the shelf. Returns a clean template, or null if unusable.
      function cowriterValidate(obj, characters, payload) {
        if (!obj || typeof obj !== 'object') return null
        let pages = Array.isArray(obj.pages) ? obj.pages : null
        if (!pages || pages.length < 4 || pages.length > 14) return null
        const ids = new Set()
        for (const pg of pages) { if (!pg || typeof pg.id !== 'number' || ids.has(pg.id)) return null; ids.add(pg.id) }
        if (!ids.has(1)) return null
        let endings = 0
        const clean = []
        for (const pg of pages) {
          const text = String(pg.text || '').trim()
          if (!text) return null
          const isEnding = !!pg.isEnding || !Array.isArray(pg.choices) || pg.choices.length === 0
          if (isEnding) {
            endings++
            clean.push({ id: pg.id, text, isEnding: true, endingTitle: String(pg.endingTitle || 'The End').slice(0, 60), endingType: 'happy' })
          } else {
            const choices = pg.choices.slice(0, 3)
              .map((c) => ({ text: String((c && c.text) || '').trim().slice(0, 80), target: Number(c && c.target) }))
              .filter((c) => c.text && ids.has(c.target))
            if (choices.length < 1) return null
            clean.push({ id: pg.id, text, choices, isEnding: false })
          }
        }
        if (endings < 1) return null
        const title = String(obj.title || payload.title || 'My Story').trim().slice(0, 80) || 'My Story'
        return { title, startPage: 1, characters, pages: clean }
      }

      const sbReadTemplate = (root, slug) => {
        try { return JSON.parse(fs.readFileSync(path.join(root, slug, 'template.json'), 'utf8')) }
        catch { return null }
      }


      if (p === '/api/viewer-session') {
        await viewerExchangeRoute.handle(req, res, send)
        return
      }

      if (p === '/api/login') {
        if (method !== 'POST') {
          send(405, { ok: false, error: 'method_not_allowed' })
          return
        }
        const body = await apiReadBody(req)
        // Same function the website's login form calls — IP lockout, failed
        // login recording and admin alerts all still apply, and it accepts a
        // real password or a legacy access code exactly as the form does.
        // A `code` (authenticator or recovery code) may ride along for someone with two-factor on;
        // without it they get { error: 'two_factor_required', challenge } and finish at /api/login/2fa.
        const result = await attemptLogin({ ip: getClientIp(req), username: body.username, password: body.password, code: body.code })
        if (!result.ok && result.reason === 'two_factor_required') {
          send(401, { ok: false, error: 'two_factor_required', challenge: result.challenge, message: result.error })
          return
        }
        if (!result.ok) {
          send(
            401,
            result.reason === 'locked'
              ? { ok: false, error: 'bad_credentials', locked: true, minutesRemaining: result.minutesRemaining ?? null }
              : result.reason === 'bad_code'
                ? { ok: false, error: 'invalid_code', message: result.error }
                : { ok: false, error: 'bad_credentials' }
          )
          return
        }
        if (twoFactor.setupRequired(store, result.user)) { send(403, setupHeldAnswer(result.user)); return }
        send(200, { ok: true, token: issueApiToken(req, result.user.id, result.method), user: apiUserShape(result.user) })
        return
      }

      // Step two for the phone app: the challenge from /api/login (or /api/remote-session) plus a code.
      if (p === '/api/login/2fa') {
        if (method !== 'POST') { send(405, { ok: false, error: 'method_not_allowed' }); return }
        const body = await apiReadBody(req)
        const ch = twoFactor.readChallenge(store, body.challenge)
        const person = ch.ok && ch.purpose === 'login' ? auth.getUsers(store).find((u) => u.id === ch.userId && u.status === 'approved') : null
        if (!person || !twoFactor.isEnabled(person)) { send(401, { ok: false, error: 'challenge_expired', message: 'That sign-in timed out. Sign in again.' }); return }
        const result = completeSecondFactor({ ip: getClientIp(req), user: person, code: body.code })
        if (!result.ok) {
          const dead = twoFactor.challengeFailed(ch.nonce, ch.exp)
          send(401, result.reason === 'locked'
            ? { ok: false, error: 'locked', locked: true, minutesRemaining: result.minutesRemaining ?? null, message: result.error }
            : { ok: false, error: dead ? 'challenge_expired' : 'invalid_code', message: dead ? 'Too many wrong codes. Sign in again.' : result.error })
          return
        }
        twoFactor.consumeChallenge(ch.nonce, ch.exp)
        if (twoFactor.setupRequired(store, result.user)) { send(403, setupHeldAnswer(result.user)); return }
        send(200, { ok: true, token: issueApiToken(req, result.user.id, result.method), user: apiUserShape(result.user) })
        return
      }

      // Away from home, the phone app signs in ONCE, at name.beebo.tv (its own username and
      // password, checked by the Worker). The host agent verifies the Worker's signed viewer
      // token and vouches for who that is (viewerIdentity.remoteViewer), so this answers
      // exactly like /api/login without asking for the password a second time.
      //   member    -> that approved user, if they still have away-from-home access
      //   owner     -> the Beebo account owner: this server's first approved admin
      //   household -> refused (household_pass): the shared pass is not a person, and a
      //                session here is always one person's (history, watchlist, admin).
      if (p === '/api/remote-session') {
        if (method !== 'POST') { send(405, { ok: false, error: 'method_not_allowed' }); return }
        const who = viewerIdentity.remoteViewer(req, AGENT_SECRET)
        if (!who) { send(401, { ok: false, error: 'not_remote' }); return }
        if (who.via === 'household') { send(403, { ok: false, error: 'household_pass' }); return }
        // Someone from another household, through a library share. beebo.tv only signs this in
        // for the invited account once they accepted, and the agent checked that signature.
        // Here: the share still exists, isn't revoked or expired, and is for that same person.
        if (who.via === 'guest') {
          const share = libraryShares.get(store, who.share)
          if (!share || !libraryShares.isLive(share) || share.guestEmail !== who.guest) {
            send(403, { ok: false, error: 'share_ended', message: 'This library is no longer shared with you.' })
            return
          }
          libraryShares.markAccepted(store, share.id)
          const fresh = libraryShares.get(store, share.id)
          send(200, {
            ok: true,
            token: libraryShares.makeShareToken(apiTokenSecret(store), fresh),
            user: { id: 'share:' + fresh.id, name: fresh.guestLabel || 'Guest', isAdmin: false, guest: true },
            share: libraryShares.guestShape(fresh, shareOwnerLabel()),
          })
          return
        }
        const approved = auth.getUsers(store).filter((u) => u && u.status === 'approved')
        const user = who.via === 'member'
          ? approved.find((u) => u.username === who.member && auth.hasRemoteAccess(u))
          : approved.find((u) => u.isAdmin)
        if (!user) { send(403, { ok: false, error: 'no_remote_access' }); return }
        if (viewingPrivacy.isPrivate(store, user.id)) { send(403, { ok: false, error: 'private_profile_sign_in', message: 'Use your own Beebo username and password to open this private profile.' }); return }
        // Two-factor on here means the away-from-home sign-in is not enough either: send the same challenge.
        if (twoFactor.isEnabled(user)) {
          securityLog.record(store, { type: 'two_factor_required', userId: user.id, username: user.username, known: true, ip: getClientIp(req), detail: 'away from home' })
          send(401, { ok: false, error: 'two_factor_required', challenge: twoFactor.issueChallenge(store, user.id), message: 'Enter the 6-digit code from your authenticator app.' })
          return
        }
        auth.touchLastSeen(store, user.id, getClientIp(req))
        if (twoFactor.setupRequired(store, user)) { send(403, setupHeldAnswer(user)); return }
        securityLog.record(store, { type: 'login_success', userId: user.id, username: user.username, known: true, ip: getClientIp(req), detail: 'away from home' })
        send(200, { ok: true, token: issueApiToken(req, user.id, 'away'), user: apiUserShape(user) })
        return
      }

      // --- car watch party: guest join + roster + join page (no account) ---
      if (p === '/api/party/guest') {
        if (method !== 'POST') { send(405, { ok: false, error: 'method_not_allowed' }); return }
        const body = await apiReadBody(req)
        const ip = getClientIp(req)
        // Joining needs the room code AND the join key from the host's link/QR. A wrong pair
        // counts against this address; enough misses lock it out for a while (429). The answer
        // is the same for "no such room" and "wrong key", so it can't be used to find rooms.
        if (party.locked(ip)) { send(429, { ok: false, error: 'locked', message: 'Too many wrong tries. Wait a few minutes.' }); return }
        const code = partyRoom.normalizeCode(body && body.code)
        const name = partyRoom.cleanText(body && body.name, 32) || 'Guest'
        const room = code ? party.get(code) : null
        if (!room || !partyRoom.keyMatches(room, body && body.key)) {
          party.fail(ip)
          send(404, { ok: false, error: 'No party with that link. Ask the host to show the QR code again.' })
          return
        }
        const memberId = party.addGuest(room, name)
        if (!memberId) { send(409, { ok: false, error: 'party_full' }); return }
        send(200, Object.assign({ memberId, g: signGuest(store, code, memberId) }, partyRosterView(room)))
        return
      }
      if (p === '/api/party/roster') {
        // Members only (a guest token), so the roster no longer leaks to anyone who guesses a code.
        const got = partyGuestFor(req, url.searchParams.get('code'), url.searchParams.get('g'))
        if (!got) { send(404, { ok: false, error: 'not_found' }); return }
        send(200, partyRosterView(got.room))
        return
      }
      if (p === '/api/party/join') {
        const html = partyJoinPage(url.searchParams.get('c'), url.searchParams.get('k'))
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html),
          // The key is in this page's URL: keep it out of Referer headers and caches.
          'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer'
        })
        res.end(html)
        return
      }

      if (p === '/api/party/state' && method === 'GET') {
        const got = partyGuestFor(req, url.searchParams.get('code'), url.searchParams.get('g'))
        if (!got) { send(404, { ok: false, error: 'not_found' }); return }
        const room = got.room
        const code = room.code
        const np = room.nowPlaying || null
        let position = 0, playing = false, title = null, streamPath = null
        if (np && np.filePath) {
          playing = !!np.playing
          title = np.title || null
          position = (np.position || 0) + (playing ? (Date.now() - np.ts) / 1000 : 0)
          streamPath = '/api/party/stream?code=' + code + '&s=' + np.npId
        }
        send(200, Object.assign({ playing, title, streamPath, position }, partyRosterView(room)))
        return
      }
      // Guest video: only the host's current show, only while the party is live, throttled.
      if (p === '/api/party/stream') {
        const got = partyGuestFor(req, url.searchParams.get('code'), url.searchParams.get('g'))
        if (!got) { send(403, { ok: false, error: 'not_a_member' }); return }
        const room = got.room
        if (!room.nowPlaying || !room.nowPlaying.filePath) { send(404, { ok: false, error: 'nothing_playing' }); return }
        await serveVideoFileThrottled(req, res, room.nowPlaying.filePath, 5000000)
        return
      }

      // Photos seen on a TV (Cast) or in a browser <img>: a short-lived media token stands in for
      // the sign-in. Matched before the bearer gate; photosApi checks the token itself.
      if (p.startsWith('/api/photos/media/')) {
        if (await photosApi.handleMedia(photosCtx(req, res), req, res, url, p)) return
      }

      // The owner's "admins must use two-factor" hold also covers the audio libraries below. They are matched
      // ABOVE the bearer gate (their streams take a media token too), so the hold there never ran for them: an
      // admin who had not set two-factor up could still change radio / podcast settings with an older token.
      if (p === '/api/music' || p.startsWith('/api/music/') || p === '/api/audiobooks' || p.startsWith('/api/audiobooks/') ||
          p === '/api/podcasts' || p.startsWith('/api/podcasts/') || p === '/api/radio' || p.startsWith('/api/radio/')) {
        const holdBearer = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(String(req.headers.authorization || ''))
        const holdId = holdBearer ? verifyApiToken(store, holdBearer[1]) : null
        const holdUser = holdId ? auth.getUsers(store).find((u) => u.id === holdId) : null
        if (holdUser && twoFactor.setupRequired(store, holdUser)) { send(403, setupHeldAnswer(holdUser)); return }
      }

      // --- Music (musicApi.js) ---
      // Ahead of the bearer gate below because two of its routes take other credentials: a song's
      // stream also accepts a media token (a browser <audio> or the car's player), and cover art is
      // addressed by its content hash. Every other /api/music route checks the bearer token itself.
      if (p === '/api/music' || p.startsWith('/api/music/')) {
        const musicBearer = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(String(req.headers.authorization || ''))
        let musicUserId
        // Bedtime and the daily limit cover music too: a profile that may not watch may not
        // listen either. Only playing a song is stopped; browsing the library still answers.
        if (p.startsWith('/api/music/track/') && p.endsWith('/stream') && musicBearer) {
          const listenerId = verifyApiToken(store, musicBearer[1])
          const listener = listenerId ? auth.getUsers(store).find((u) => u.id === listenerId) : null
          const t = listener ? contentGateInstance.timeGate(viewerForUser(listener)) : { ok: true }
          if (!t.ok) {
            send(403, { ok: false, error: t.reason, message: t.message })
            return
          }
        }
        const handled = await musicHttp.handleApi(req, res, url, p, method, {
          send,
          userId: () => {
            if (musicUserId === undefined) {
              musicUserId = musicBearer ? verifyApiToken(store, musicBearer[1]) : null
              if (musicUserId) auth.touchLastSeen(store, musicUserId, getClientIp(req))
            }
            return musicUserId
          },
          isAdmin: (id) => !!(auth.getUsers(store).find((u) => u.id === id) || {}).isAdmin
        })
        if (handled) return
      }

      // --- Audiobooks (audiobookApi.js) ---
      // Same shape as Music above: the audio also takes a media token and cover art is a content-hash
      // capability URL; every other /api/audiobooks route checks the bearer token itself.
      if (p === '/api/audiobooks' || p.startsWith('/api/audiobooks/')) {
        const abBearer = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(String(req.headers.authorization || ''))
        let abUserId
        // Bedtime and the daily limit cover audiobooks too; only playing is stopped, browsing still answers.
        if (/^\/api\/audiobooks\/book\/[^/]+\/stream(\/\d+)?$/.test(p) && abBearer) {
          const listenerId = verifyApiToken(store, abBearer[1])
          const listener = listenerId ? auth.getUsers(store).find((u) => u.id === listenerId) : null
          const t = listener ? contentGateInstance.timeGate(viewerForUser(listener)) : { ok: true }
          if (!t.ok) {
            send(403, { ok: false, error: t.reason, message: t.message })
            return
          }
        }
        const handled = await audiobookHttp.handleApi(req, res, url, p, method, {
          send,
          userId: () => {
            if (abUserId === undefined) {
              abUserId = abBearer ? verifyApiToken(store, abBearer[1]) : null
              if (abUserId) auth.touchLastSeen(store, abUserId, getClientIp(req))
            }
            return abUserId
          },
          isAdmin: (id) => !!(auth.getUsers(store).find((u) => u.id === id) || {}).isAdmin
        })
        if (handled) return
      }

      // --- Podcasts and Internet radio (podcastApi.js, radioApi.js) ---
      // Ahead of the bearer gate because the audio streams also take a media token (a browser <audio> or
      // a cast receiver). Every other route checks the bearer token itself. Bedtime and the daily limit
      // stop listening here exactly as they do for Music.
      if (p === '/api/podcasts' || p.startsWith('/api/podcasts/') || p === '/api/radio' || p.startsWith('/api/radio/')) {
        const audioBearer = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(String(req.headers.authorization || ''))
        let audioUserId
        const audioCtx = {
          send,
          userId: () => {
            if (audioUserId === undefined) {
              audioUserId = audioBearer ? verifyApiToken(store, audioBearer[1]) : null
              if (audioUserId) auth.touchLastSeen(store, audioUserId, getClientIp(req))
            }
            return audioUserId
          },
          isAdmin: (id) => !!(auth.getUsers(store).find((u) => u.id === id) || {}).isAdmin
        }
        if (p.endsWith('/stream') && audioBearer) {
          const listenerId = verifyApiToken(store, audioBearer[1])
          const listener = listenerId ? auth.getUsers(store).find((u) => u.id === listenerId) : null
          const t = listener ? contentGateInstance.timeGate(viewerForUser(listener)) : { ok: true }
          if (!t.ok) {
            send(403, { ok: false, error: t.reason, message: t.message })
            return
          }
        }
        const handledAudio = p.startsWith('/api/podcasts')
          ? await podcastsHttp.handleApi(req, res, url, p, method, audioCtx)
          : await radioHttp.handleApi(req, res, url, p, method, audioCtx)
        if (handledAudio) return
      }

      // --- everything else needs a bearer token ---
      const bearer = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(String(req.headers.authorization || ''))
      // A guest from another household holds a share token instead of an account token.
      const guestShareId = bearer ? libraryShares.verifyShareToken(apiTokenSecret(store), bearer[1]) : null
      const guestShare = guestShareId ? libraryShares.get(store, guestShareId) : null
      if (guestShareId && !libraryShares.isLive(guestShare)) {
        send(401, { ok: false, error: 'share_ended', message: 'This library is no longer shared with you.' })
        return
      }
      const apiUserId = guestShare ? 'share:' + guestShare.id : bearer ? verifyApiToken(store, bearer[1]) : null
      if (!apiUserId) {
        send(401, { ok: false, error: 'unauthorized' })
        return
      }
      const apiUser = guestShare
        ? { id: apiUserId, name: guestShare.guestLabel || 'Guest', isAdmin: false, status: 'approved', guest: true }
        : auth.getUsers(store).find((u) => u.id === apiUserId) || null
      if (!apiUser) {
        send(401, { ok: false, error: 'unauthorized' })
        return
      }
      req.beeboUserId = apiUserId
      if (!guestShare) auth.touchLastSeen(store, apiUserId, getClientIp(req))
      const bearerSid = guestShare ? null : apiTokenSid(bearer[1])
      if (bearerSid) authSessions.noteIp(store, bearerSid, getClientIp(req))
      // Owner policy: an admin without two-factor can only use the account-security calls (and sign out).
      if (!guestShare && twoFactor.setupRequired(store, apiUser) && !p.startsWith('/api/account/security')) {
        send(403, setupHeldAnswer(apiUser))
        return
      }
      const apiViewer = guestShare ? viewerForShare(guestShare) : viewerForUser(apiUser)
      contentGate.setRequestViewer(apiViewer)
      const gateOut = await parentalApiGate(req, url, p, method, apiUser, apiViewer, send)
      if (gateOut === 'handled') return

      // --- admin surface -------------------------------------------------
      // Matched before every other authenticated route so an /api/admin/*
      // path can never fall through to another handler or to the generic 404
      // at the bottom, and so the TLS + isAdmin gates inside run before any
      // administrative data is touched.
      if (p === '/api/admin' || p.startsWith('/api/admin/')) {
        await handleAdminRequest(req, res, url, p, method, apiUser, send)
        return
      }

      // Registered route modules (electron/routeRegistry.js), e.g. the per-user preferences profile at /api/prefs.
      {
        const hit = await routeRegistry.dispatchApi({ p, method, url, user: apiUser, store, headers: req.headers, crossSite: backup.isCrossSiteRequest, readBody: () => apiReadBody(req) })
        if (hit) { send(hit.status, hit.body); return }
      }

      // Per-person colour theme for the browser site (electron/theme.js). GET reads it, POST changes it.
      if (p === '/api/theme') {
        const out = await themeWeb.handleApi({ method, user: apiUser, store, headers: req.headers, crossSite: backup.isCrossSiteRequest, readBody: () => apiReadBody(req) })
        send(out.status, out.body)
        return
      }

      if (p === '/api/viewing-privacy') {
        if (apiUser.guest) { send(403, { ok: false, error: 'adult_profile_required' }); return }
        if (method === 'GET') { send(200, viewingPrivacy.status(store, apiUserId)); return }
        if (method !== 'POST') { send(405, { ok: false, error: 'method_not_allowed' }); return }
        if (!/^application\/json\b/i.test(String(req.headers['content-type'] || '')) || backup.isCrossSiteRequest(req.headers)) {
          send(415, { ok: false, error: 'json_only' }); return
        }
        const result = saveViewingPrivacy(req, apiUser, await apiReadBody(req))
        if (result.body.ok) {
          result.body.token = makeApiToken(store, apiUserId)
          result.body.user = apiUserShape(auth.getUsers(store).find(u => u.id === apiUserId))
        }
        send(result.status, result.body)
        return
      }

      // The signed-in person's own security settings; the twin of /account/security/api/*.
      if (p === '/api/account/security' || p.startsWith('/api/account/security/')) {
        let body = {}
        if (method === 'POST') {
          if (!/^application\/json\b/i.test(String(req.headers['content-type'] || '')) || backup.isCrossSiteRequest(req.headers)) { send(415, { ok: false, error: 'json_only' }); return }
          body = await apiReadBody(req)
        }
        const out = accountSecurity.handle({
          method, sub: p.slice('/api/account/security'.length), body, user: apiUser, ip: getClientIp(req), currentSid: bearerSid,
          reissue: () => { const token = issueApiToken(req, apiUserId, 'password'); return { token, sid: apiTokenSid(token) } }
        })
        if (out.session && out.session.token) out.body.token = out.session.token
        send(out.status, out.body)
        return
      }

      if (p === '/api/private-vault' || p.startsWith('/api/private-vault/')) {
        await privateVault.handle(req, res, url, apiUser, send)
        return
      }

      // --- Trip sharing: send a finished trip here, manage its private links (electron/tripShareApi.js) ---
      if (p === '/api/trip-shares' || p.startsWith('/api/trip-shares/')) {
        await tripShareApi.handle(tripShareCtx(req, res), req, res, url, p, method, apiUser)
        return
      }

      // --- Photos library + phone camera backup (electron/photosApi.js) ---
      if (p === '/api/photos' || p.startsWith('/api/photos/')) {
        await photosApi.handle(photosCtx(req, res), req, res, url, p, method, apiUser)
        return
      }

      // Quality & audio picker (playbackApi.js).
      if (liveTv.claimsApi(p)) { await liveTv.handleApi(req, res, url, { id: apiUserId, isAdmin: !!apiUser.isAdmin, guest: !!apiUser.guest }); return }
      if (p.startsWith('/api/playback/') || p.startsWith('/api/subtitles/online')) {
        if (cinema.claims(p.slice(4)) && await cinema.handle(req, res, p.slice(4), url, { userId: apiUserId, send, isGuest: !!apiUser.guest })) return
        if (await playback.handle(req, res, p.slice(4), url, { userId: apiUserId, send })) return
      }
      // Watch together (watchTogetherHttp.js) for the apps; members only, never a shared-library guest.
      if (p.startsWith('/api/watch-together/') && !apiUser.guest) {
        if (await watchTogether.handle(req, res, url, p.slice('/api/watch-together'.length), { userId: apiUserId, send })) return
      }
      // Movie Night (movieNightHttp.js) for the TV apps: a signed-in TV starts a room as that person.
      if (p.startsWith('/api/movie-night/') && !apiUser.guest) {
        if (await movieNight.handleAuthed(req, res, url, p.slice('/api/movie-night'.length), { userId: apiUserId, send })) return
      }

      // The routes below that list or look up library files read the cached walk; make sure it
      // is current first, off the main thread.
      if (API_LIBRARY_ROUTES.has(p)) await primeLibrary(API_LIBRARY_ROUTES.get(p))
      else if (/^\/api\/tvshows\/[^/]+\/episodes$/.test(p)) await primeLibrary('tv')
      else if (/^\/api\/collections\/[^/]+$/.test(p)) await primeLibrary('movies')

      // --- BeeboBook (read-along storybooks) routes ----------------------
      // These sit HERE, below the bearer-token gate above, so a story request
      // is authenticated exactly like every other /api route. The phone app
      // already sends 'Authorization: Bearer <token>' on every story call
      // (StoryBookClient.request + the MediaPlayer headers), so a signed-in
      // reader sees no change; an anonymous caller now gets 401 instead of
      // the family's story list, narration and generated audio.
      if (p === '/api/storybooks') {
        const root = storybooksRoot()
        if (!root) { send(200, { ok: true, books: [] }); return }
        try {
          send(200, JSON.parse(fs.readFileSync(path.join(root, 'index.json'), 'utf8')))
        } catch { send(200, { ok: true, books: [] }) }
        return
      }

      if (p === '/api/storybook-template') {
        const root = storybooksRoot()
        const slug = sbSafeSeg(url.searchParams.get('slug'))
        const tpl = root && slug ? sbReadTemplate(root, slug) : null
        if (!tpl) { send(404, { ok: false, error: 'not_found' }); return }
        send(200, { ok: true, slug, template: tpl })
        return
      }

      // Ask for narration for a name set. Returns immediately with the setHash and
      // a status: 'ready' (audio exists), 'pending' (being generated on this PC),
      // or 'unavailable' (the voice engine isn't set up — app falls back to a
      // silent read-along). Kicks off generation when it's missing.
      // Every narration this book already holds, so a reader can find one again.
      //
      // A set is filed under an id derived from the names and voices that made it
      // (sbSetHash), and nothing on disk records those in readable form except the
      // values.json and charvoices.json the render writes beside the audio. The
      // NARRATOR is never written down - but it is one of a known twenty-eight, and
      // the folder's name IS the hash it produced, so re-deriving the hash for each
      // candidate recovers it exactly. That is what lets this list a set's whole cast
      // rather than an opaque id.
      //
      // Without this a second set made with different voices was unreachable. The app
      // could only ask "is THIS one ready?", never "what have I already made?", so
      // finished narration sat on the disk with nothing in the app pointing at it -
      // which is exactly what happened to four completed sets across two books.
      if (p === '/api/storybook-narrations') {
        const root = storybooksRoot()
        const slug = sbSafeSeg(url.searchParams.get('slug'))
        const tpl = root && slug ? sbReadTemplate(root, slug) : null
        if (!tpl) { send(404, { ok: false, error: 'not_found' }); return }
        const total = Number(tpl.totalPages) || 0
        const audioRoot = path.join(root, slug, 'audio')
        let dirs = []
        try {
          dirs = fs.readdirSync(audioRoot, { withFileTypes: true })
            .filter((d) => d.isDirectory()).map((d) => d.name)
        } catch {}
        const sets = []
        for (const setHash of dirs) {
          // "_cache" belongs to the generator, not to a reader. Anything underscored
          // is housekeeping and must never be offered as something to play.
          if (setHash.startsWith('_')) continue
          const dir = path.join(audioRoot, setHash)
          let names = null
          let charVoices = {}
          try { names = JSON.parse(fs.readFileSync(path.join(dir, 'values.json'), 'utf8')) } catch {}
          try { charVoices = JSON.parse(fs.readFileSync(path.join(dir, 'charvoices.json'), 'utf8')) } catch {}
          let narrator = null
          if (names && typeof names === 'object') {
            for (const candidate of storybookRuntime.ENGLISH_VOICES) {
              if (sbSetHash(names, candidate, charVoices) === setHash) { narrator = candidate; break }
            }
          }
          let pages = 0
          try { pages = fs.readdirSync(dir).filter((f) => /^page_\d+\.mp3$/.test(f)).length } catch {}
          const ready = fs.existsSync(path.join(dir, '.ready'))
          const failed = fs.existsSync(path.join(dir, '.error'))
          const running = storybookRuntime.active(path.join(dir, '.pending'))
          let madeAt = 0
          try { madeAt = fs.statSync(path.join(dir, ready ? '.ready' : '.')).mtimeMs } catch {}
          sets.push({
            setHash,
            names: names && typeof names === 'object' ? names : {},
            narrator,
            characterVoices: charVoices && typeof charVoices === 'object' ? charVoices : {},
            status: ready ? 'ready' : running ? 'pending' : failed ? 'error' : 'partial',
            pages,
            total,
            madeAt: Math.round(madeAt) || 0,
            // A set whose names were never written down cannot be offered for reuse:
            // the app would have to guess them, and a guess is a different set.
            reusable: !!(names && narrator),
          })
        }
        sets.sort((a, b) => b.madeAt - a.madeAt)
        send(200, { ok: true, slug, sets })
        return
      }

      if (p === '/api/storybook-render') {
        if (method !== 'POST') { send(405, { ok: false, error: 'method_not_allowed' }); return }
        const root = storybooksRoot()
        const body = await apiReadBody(req)
        const slug = sbSafeSeg(body.slug)
        const tpl = root && slug ? sbReadTemplate(root, slug) : null
        if (!tpl) { send(404, { ok: false, error: 'not_found' }); return }
        const provided = (body.values && typeof body.values === 'object') ? body.values : {}
        const resolved = sbResolveNames(tpl, provided)
        // Optional voice pick (a Kokoro voice id like "am_adam"); defaults to af_heart.
        const voice = storybookRuntime.ENGLISH_VOICES.has(body.voice) ? body.voice : 'af_heart'
        const narrator = voice
        // Optional per-character voice overrides { "{{TOKEN}}": "am_adam", ... }.
        // Keep only real voice ids for known tokens that differ from the narrator.
        const rawCV = (body.characterVoices && typeof body.characterVoices === 'object') ? body.characterVoices : {}
        const charVoices = {}
        for (const tok of Object.keys(rawCV)) {
          const v = String(rawCV[tok] || '')
          if (storybookRuntime.ENGLISH_VOICES.has(v) && v !== narrator && resolved[tok] !== undefined) charVoices[tok] = v
        }
        const setHash = sbSetHash(resolved, narrator, charVoices)
        const audioDir = path.join(root, slug, 'audio', setHash)
        if (fs.existsSync(path.join(audioDir, '.ready'))) {
          send(200, { ok: true, slug, setHash, status: 'ready' }); return
        }
        if (storybookRuntime.active(path.join(audioDir, '.pending'))) {
          send(200, { ok: true, slug, setHash, status: 'pending' }); return
        }
        // A PROBE only asks "does narration for this name+voice set already exist?"
        // It never creates the audio folder and never spawns a Python worker, so the
        // app can show a Play button for a set it already made without starting a
        // generation as a side effect. It answers on the same setHash the real render
        // uses, so 'ready' here means exactly the audio a reader would get.
        if (body.probe === true) {
          let done = 0
          let total = 0
          try { done = fs.readdirSync(audioDir).filter((f) => /^page_\d+\.mp3$/.test(f)).length } catch {}
          try { total = Number(JSON.parse(fs.readFileSync(path.join(root, slug, 'template.json'), 'utf8')).totalPages) || 0 } catch {}
          const failed = fs.existsSync(path.join(audioDir, '.error'))
          send(200, { ok: true, slug, setHash, status: failed ? 'error' : 'missing', done, total })
          return
        }
        try {
          fs.mkdirSync(audioDir, { recursive: true })
          const valuesFile = path.join(audioDir, 'values.json')
          fs.writeFileSync(valuesFile, JSON.stringify(resolved))
          const genArgs = [path.join(root, slug, 'template.json'), path.join(root, slug, 'audio'), '--values', valuesFile, '--voice', voice]
          if (Object.keys(charVoices).length) {
            const cvFile = path.join(audioDir, 'charvoices.json')
            fs.writeFileSync(cvFile, JSON.stringify(charVoices))
            genArgs.push('--charvoices', cvFile)
          }
          storybookRuntime.launch({ root, name: 'generate_storybook.py', args: genArgs,
            marker: path.join(audioDir, '.pending'), errorFile: path.join(audioDir, '.error'),
            readyFile: path.join(audioDir, '.ready'), logFile: path.join(audioDir, 'voice.log') })
          send(200, { ok: true, slug, setHash, status: 'pending' })
        } catch (e) {
          try { fs.unlinkSync(path.join(audioDir, '.pending')) } catch {}
          send(200, { ok: true, slug, setHash, status: 'unavailable', message: e.message || 'Check the computer voice setup.' })
        }
        return
      }

      // Poll narration status for a set; when ready, returns per-page audio URLs.
      // On-demand voice: speak one short phrase in a Kokoro voice (the same warm voices the
      // storybooks use), cached by (voice, text). Powers the human lesson voice and the voice
      // sampler ("Hi, I'm Heart"). Tiny + best-effort; generates in the background and answers 202
      // until the clip is ready, so the app can fall back to its on-device voice that one time.
      if (p === '/api/say') {
        const root = storybooksRoot()
        const rawText = String(url.searchParams.get('text') || '').trim().slice(0, 300)
        const requestedVoice = String(url.searchParams.get('voice') || 'af_heart')
        const voice = storybookRuntime.ENGLISH_VOICES.has(requestedVoice) ? requestedVoice : 'af_heart'
        if (!root || !rawText) { send(404, { ok: false, error: 'not_found' }); return }
        const crypto = require('crypto')
        const hash = crypto.createHash('sha256').update(voice + '|' + rawText).digest('hex').slice(0, 24)
        const dir = path.join(root, '_tts', voice)
        const fp = path.join(dir, hash + '.mp3')
        let stSay = null
        try { stSay = fs.statSync(fp) } catch {}
        if (stSay && stSay.size > 0) {
          res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': stSay.size, 'Cache-Control': 'public, max-age=31536000' })
          pipeFileToResponse(res, fp)
          return
        }
        // Not ready: kick off generation once (a .gen marker keeps duplicate requests from each
        // spawning their own Python), then tell the app to try again shortly.
        try {
          fs.mkdirSync(dir, { recursive: true })
          const genMarker = fp + '.gen'
          if (!storybookRuntime.active(genMarker)) {
            storybookRuntime.launch({ root, name: 'say.py', args: ['--text', rawText, '--out', fp, '--voice', voice],
              marker: genMarker, errorFile: fp + '.error', readyFile: fp, logFile: fp + '.log' })
          }
        } catch (e) { send(503, { ok: false, status: 'unavailable', message: e.message }); return }
        send(202, { ok: false, status: 'pending' })
        return
      }

      // A voice picker's "Hi, I'm Heart." sample: a small MP3 baked at build time
      // (tools/make-voice-samples.py) and shipped in resources/voice-samples, so it plays
      // instantly with no Python on this PC. Only ids in the storybook voice allowlist are
      // served; the file name is built from the id, never from the request.
      if (p.startsWith('/api/storybook-voice-sample/')) {
        if (method !== 'GET' && method !== 'HEAD') { send(405, { ok: false, error: 'method_not_allowed' }); return }
        const voiceId = voiceSamples.voiceIdFromPath(p)
        const fp = voiceId && voiceSamples.sampleFile(voiceId)
        let st = null
        try { st = fp && fs.statSync(fp) } catch {}
        if (!st) { send(404, { ok: false, error: 'not_found' }); return }
        const etag = '"vs-' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"'
        const cache = 'private, max-age=604800'
        if (req.headers['if-none-match'] === etag) {
          res.writeHead(304, { ETag: etag, 'Cache-Control': cache }); res.end(); return
        }
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': st.size, ETag: etag, 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' })
        if (method === 'HEAD') { res.end(); return }
        pipeFileToResponse(res, fp)
        return
      }

      if (p === '/api/storybook-audio') {
        const root = storybooksRoot()
        const slug = sbSafeSeg(url.searchParams.get('slug'))
        const setHash = sbSafeSeg(url.searchParams.get('set'))
        if (!root || !slug || !setHash) { send(404, { ok: false, error: 'not_found' }); return }
        const audioDir = path.join(root, slug, 'audio', setHash)
        if (!fs.existsSync(path.join(audioDir, '.ready'))) {
          let status = 'missing'
          try {
            const st = fs.statSync(path.join(audioDir, '.pending'))
            // A pending marker older than 5 min means generation died; report error.
            status = storybookRuntime.active(path.join(audioDir, '.pending')) ? 'pending' : 'error'
          } catch {}
          if (fs.existsSync(path.join(audioDir, '.error'))) status = 'error'
          // Progress so the app can show "x of N pages" and estimate the wait.
          let done = 0, total = 0
          try { done = fs.readdirSync(audioDir).filter((f) => /^page_\d+\.mp3$/.test(f)).length } catch {}
          try { total = Number(JSON.parse(fs.readFileSync(path.join(root, slug, 'template.json'), 'utf8')).totalPages) || 0 } catch {}
          send(200, { ok: true, slug, setHash, status, done, total }); return
        }
        let manifest = {}
        try { manifest = JSON.parse(fs.readFileSync(path.join(audioDir, 'manifest.json'), 'utf8')) } catch {}
        const pages = {}
        for (const [pid, meta] of Object.entries(manifest)) {
          pages[pid] = {
            url: `/api/storybook-media/${slug}/${setHash}/page_${pid}.mp3`,
            durationSec: meta && meta.durationSec,
            // A short clip of the two options in the SAME narrator voice, played by the
            // app after it reveals the buttons. Absent (older sets / ending pages) -> the
            // app just shows the options with no extra voice.
            choicesUrl: (meta && meta.choicesFile)
              ? `/api/storybook-media/${slug}/${setHash}/${meta.choicesFile}`
              : undefined,
          }
        }
        send(200, {
          ok: true, slug, setHash, status: 'ready', pages,
          timingsUrl: `/api/storybook-media/${slug}/${setHash}/timings.json`,
        })
        return
      }

      // Serve a narration MP3 (with Range support so the player can seek).
// Serve a per-page scene illustration (static PNG, the same for every
      // reader — scenes depend on the page, not on the chosen names).
      if (p.startsWith('/api/storybook-scene/')) {
        const parts = p.split('/').filter(Boolean) // api, storybook-scene, slug, file
        const slug = sbSafeSeg(parts[2])
        const file = parts[3]
        if (!slug || !file || !/^page_\d+\.png$/.test(file) ||
            !sbSendAsset(slug, 'scenes', file, 'image/png')) {
          send(404, { ok: false, error: 'not_found' })
        }
        return
      }

      // Serve a per-page ANIMATED scene (a gently-looping GIF) when the home PC
      // has one under the book's anim/ folder. Same for every reader; the app layers
      // it over the static PNG and falls back to the still image when this 404s.
      if (p.startsWith('/api/storybook-scene-anim/')) {
        const parts = p.split('/').filter(Boolean) // api, storybook-scene-anim, slug, file
        const slug = sbSafeSeg(parts[2])
        const file = parts[3]
        if (!slug || !file || !/^page_\d+\.gif$/.test(file) ||
            !sbSendAsset(slug, 'anim', file, 'image/gif')) {
          send(404, { ok: false, error: 'not_found' })
        }
        return
      }

            if (p.startsWith('/api/storybook-media/')) {
        const root = storybooksRoot()
        const parts = p.split('/').filter(Boolean) // api, storybook-media, slug, set, file
        const slug = sbSafeSeg(parts[2])
        const setHash = sbSafeSeg(parts[3])
        const file = parts[4]
        const isTimings = file === 'timings.json'
        if (!root || !slug || !setHash || !file || !(isTimings || /^page_\d+(_choices)?\.mp3$/.test(file))) {
          send(404, { ok: false, error: 'not_found' }); return
        }
        const fp = path.join(root, slug, 'audio', setHash, file)
        let st
        try { st = fs.statSync(fp) } catch { send(404, { ok: false, error: 'not_found' }); return }
        if (isTimings) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': st.size })
          pipeFileToResponse(res, fp)
          return
        }
        const total = st.size
        const range = req.headers['range']
        if (range && /^bytes=/.test(range)) {
          const rg = parseSingleRange(range, total)
          if (!rg) { res.writeHead(416, { 'Content-Range': `bytes */${total}` }); res.end(); return }
          const { start, end } = rg
          res.writeHead(206, {
            'Content-Type': 'audio/mpeg',
            'Accept-Ranges': 'bytes',
            'Content-Range': `bytes ${start}-${end}/${total}`,
            'Content-Length': end - start + 1,
          })
          pipeFileToResponse(res, fp, { start, end })
        } else {
          res.writeHead(200, {
            'Content-Type': 'audio/mpeg',
            'Accept-Ranges': 'bytes',
            'Content-Length': total,
          })
          pipeFileToResponse(res, fp)
        }
        return
      }
      // --- car watch party: the owner starts one with their normal login ---
      if (p === '/api/party/start') {
        if (method !== 'POST') { send(405, { ok: false, error: 'method_not_allowed' }); return }
        const body = await apiReadBody(req)
        const hostName = partyRoom.cleanText((body && body.hostName) || apiUser.name || 'Host', 32) || 'Host'
        const started = party.startFor(apiUserId, hostName)
        if (!started) { send(503, { ok: false, error: 'Could not start a party right now. Try again.' }); return }
        const room = started.room
        const base = partyPublicBase(req)
        // The key rides in the link/QR only; the 8-character code is what people read out loud.
        const joinUrl = (base ? base : '') + '/api/party/join?c=' + room.code + '&k=' + room.joinKey
        send(200, Object.assign({ code: room.code, joinKey: room.joinKey, joinUrl }, partyRosterView(room)))
        return
      }
      // The host ends the party now: the room, its guest tokens and the stream stop working.
      if (p === '/api/party/stop') {
        if (method !== 'POST') { send(405, { ok: false, error: 'method_not_allowed' }); return }
        send(200, { ok: true, closed: party.closeForOwner(apiUserId) })
        return
      }

      // --- car watch party: the owner reports what is playing so guests follow ---
      if (p === '/api/party/state') {
        if (method !== 'POST') { send(405, { ok: false, error: 'method_not_allowed' }); return }
        const body = await apiReadBody(req)
        const room = party.get(partyRoom.normalizeCode(body && body.code))
        if (!room) { send(404, { ok: false, error: 'not_found' }); return }
        if (room.ownerId !== apiUserId) { send(403, { ok: false, error: 'not_host' }); return }
        room.hostSeen = Date.now() // the room lives while its host keeps reporting
        const sp = String((body && body.streamPath) || '').trim()
        let np = null
        if (sp && sp.startsWith('/')) {
          try {
            const u = new URL('http://x' + sp)
            const isTv = u.pathname === '/tvfile'
            const isMovie = u.pathname === '/file'
            const id = u.searchParams.get('id') || ''
            if ((isTv || isMovie) && id) {
              const rel = decodeId(id)
              let abs = null
              if (isMovie) { const mm = scanMoviesMulti(allMoviesDirs()).find((x) => x.fileName === rel); if (mm) abs = path.join(mm.dir, mm.fileName) }
              else { const ff = scanTvShowsMulti(allTvShowsDirs()).find((x) => x.relPath === rel); if (ff) abs = path.join(ff.dir, ff.relPath) }
              if (abs) {
                const sameFile = room.nowPlaying && room.nowPlaying.filePath === abs
                np = {
                  filePath: abs,
                  title: partyRoom.cleanText(body && body.title, 200),
                  position: Number(body && body.position) || 0,
                  playing: !!(body && body.playing),
                  ts: Date.now(),
                  npId: sameFile ? room.nowPlaying.npId : partyRoom.newStreamId()
                }
              }
            }
          } catch (e) { np = null }
        }
        room.nowPlaying = np
        room.lastSeen = Date.now()
        send(200, { ok: true })
        return
      }


      if (p === '/api/me') {
        send(200, { ok: true, user: apiUserShape(apiUser) })
        return
      }

      // Personal API keys for one's own tools (docs/PUBLIC-API.md). Anyone with an account can make,
      // list and remove THEIR OWN keys; the owner sees and removes everyone's under /api/admin/api-keys.
      // What a key may hold depends on who made it: library and history for a member, everything for
      // an admin. A limited (parental) profile and a guest from another household get none. The secret
      // is shown once, so the connection has to be a secure one (the same rule Admin uses).
      //   GET  /api/me/api-keys                          -> { scopes, maxKeys, defaultRatePerMinute, keys }
      //   POST /api/me/api-keys/create { name, scopes?, ratePerMinute? } -> { key, token }
      //   POST /api/me/api-keys/revoke { id }            -> { key }   (only one of your own)
      if (p === '/api/me/api-keys' || p === '/api/me/api-keys/create' || p === '/api/me/api-keys/revoke') {
        if (apiUser.guest || parental.isRestricted(parental.getPolicy(store, apiUser.id))) { send(403, { ok: false, error: 'not_available' }); return }
        if (!adminRequestIsSecure(req)) { send(403, { ok: false, error: 'https_required' }); return }
        const allowedScopes = apiKeys.scopesFor(apiUser)
        if (p === '/api/me/api-keys') {
          if (method !== 'GET') { send(405, { ok: false, error: 'method_not_allowed' }); return }
          send(200, {
            ok: true,
            scopes: allowedScopes,
            maxKeys: apiUser.isAdmin ? apiKeys.MAX_KEYS : apiKeys.MAX_KEYS_MEMBER,
            defaultRatePerMinute: apiKeys.DEFAULT_RATE_PER_MINUTE,
            keys: apiKeys.list(store, { ownerUserId: apiUser.id })
          })
          return
        }
        if (method !== 'POST') { send(405, { ok: false, error: 'method_not_allowed' }); return }
        const body = await apiReadBody(req)
        if (p === '/api/me/api-keys/create') {
          const out = apiKeys.create(store, {
            name: body.name,
            scopes: Array.isArray(body.scopes) ? body.scopes : undefined,
            ratePerMinute: body.ratePerMinute,
            ownerUserId: apiUser.id,
            allowedScopes,
            maxForOwner: apiUser.isAdmin ? apiKeys.MAX_KEYS : apiKeys.MAX_KEYS_MEMBER
          })
          if (!out.ok) { send(400, out); return }
          log(`API key "${out.key.name}" created by ${apiUser.name || apiUser.username || 'a member'}`)
          send(200, { ok: true, key: out.key, token: out.token })
          return
        }
        const out = apiKeys.revoke(store, String(body.id === undefined || body.id === null ? '' : body.id).trim(), { ownerUserId: apiUser.id })
        if (!out.ok) { send(404, out); return }
        log(`API key "${out.key.name}" removed by its owner`)
        send(200, { ok: true, key: out.key })
        return
      }

      // "Delete my account" from the phone app (Google Play account deletion). The person
      // confirms with their own password or code; lockouts count like /api/login. Removes
      // them and their personal data on THIS server only (electron/userDeletion.js); the
      // owner's library stays. The server's last admin can't remove themselves: that would
      // leave nobody able to run it (the owner removes Beebo from the computer instead).
      if (p === '/api/me/delete') {
        if (method !== 'POST') { send(405, { ok: false, error: 'method_not_allowed' }); return }
        const body = await apiReadBody(req)
        const ip = getClientIp(req)
        // With the username, so the per-account and server-wide limits apply here too,
        // not only the per-address one (security review #18). The session's own requests
        // keep refreshing its last-seen address, so that exemption is off here.
        const lockout = auth.checkLockout(store, ip, apiUser.username, { trustLastSeenIp: false })
        if (lockout.locked) { send(429, { ok: false, error: 'locked', minutesRemaining: lockout.minutesRemaining ?? null }); return }
        const password = body && typeof body.password === 'string' ? body.password : ''
        if (!password) { send(400, { ok: false, error: 'missing_password' }); return }
        const ok = auth.findUserByUsernameAndSecret(store, apiUser.username, password)
        if (!ok || ok.id !== apiUser.id) {
          auth.recordFailedLogin(store, { ip, username: apiUser.username })
          send(401, { ok: false, error: 'bad_credentials' })
          return
        }
        if (twoFactor.isEnabled(ok)) {
          const second = twoFactor.verifyCode(store, ok.id, body && body.code, { ip })
          if (!second.ok) {
            if (second.error !== 'locked') auth.recordFailedLogin(store, { ip, username: apiUser.username })
            send(second.error === 'locked' ? 429 : 401, { ok: false, error: second.error === 'locked' ? 'locked' : 'invalid_code' })
            return
          }
        }
        if (adminIsLastAdmin(apiUser.id)) { send(409, { ok: false, error: 'last_admin' }); return }
        const out = userDeletion.purgeUserData(store, apiUser.id, { musicRecordingsDir })
        if (out.removed) purgeAudioData(apiUser.id)
        log(`a member deleted their own account on this server`)
        send(200, { ok: !!out.removed, deleted: !!out.removed })
        return
      }

      // --- Space Saver ----------------------------------------------------
      // Which of these files does the server already hold (matched by relative
      // path + size)? Lets the app skip re-uploading and know what is safe to
      // delete from the phone.
      if (p === '/api/space-saver/check') {
        if (method !== 'POST') { send(405, { ok: false, error: 'method_not_allowed' }); return }
        const body = await apiReadBody(req)
        const items = Array.isArray(body.items) ? body.items.slice(0, 5000) : []
        const userFolder = apiUser.name || apiUserId
        const results = items.map((it) => {
          const target = ssTargetPath(userFolder, it && it.path)
          let have = false
          if (target) {
            try {
              const st = fs.statSync(target)
              have = st.isFile() && (it.size == null || Number(st.size) === Number(it.size))
            } catch {}
          }
          return { path: it && it.path, have }
        })
        send(200, { ok: true, results })
        return
      }

      // Receive one file (multipart) and save it under the user's Space Saver
      // folder. ?path= is the relative path to keep; ?size= lets us verify the
      // whole file arrived before we call it saved.
      if (p === '/api/space-saver/upload') {
        if (method !== 'POST') { send(405, { ok: false, error: 'method_not_allowed' }); return }
        if (!Busboy) { send(500, { ok: false, error: 'busboy_not_installed' }); return }
        const relPath = url.searchParams.get('path') || ''
        const declaredSize = Number(url.searchParams.get('size') || '0')
        const target = ssTargetPath(apiUser.name || apiUserId, relPath)
        if (!target) { send(400, { ok: false, error: 'bad_path' }); return }
        try {
          const st = fs.statSync(target)
          if (st.isFile() && (!declaredSize || st.size === declaredSize)) {
            req.resume()
            send(200, { ok: true, status: 'already', size: st.size })
            return
          }
        } catch {}
        try { fs.mkdirSync(path.dirname(target), { recursive: true }) } catch {}
        // Keep half a gigabyte free on the drive, and never take more than the size the phone declared (or 64 GB):
        // a member's backup must not be able to fill the owner's disk (security review 2026-09-21, P-8).
        try { const sf = fs.statfsSync(path.dirname(target)); if (sf.bavail * sf.bsize < (declaredSize || 0) + 512 * 1024 * 1024) { req.resume(); send(507, { ok: false, error: 'pc_disk_full' }); return } } catch {}
        const ssLimit = declaredSize > 0 ? Math.min(declaredSize, 64 * 1024 ** 3) : 64 * 1024 ** 3
        const tmp = target + '.uploading'
        let responded = false
        const respond = (status, obj) => { if (!responded) { responded = true; send(status, obj) } }
        try {
          const bb = Busboy({ headers: req.headers, limits: { files: 1, fileSize: ssLimit } })
          let gotFile = false
          bb.on('file', (_n, fileStream) => {
            gotFile = true
            const ws = fs.createWriteStream(tmp)
            fileStream.on('limit', () => { ws.destroy(); ws.once('close', () => { try { fs.unlinkSync(tmp) } catch {} }); respond(413, { ok: false, error: 'too_large' }) })
            ws.on('error', (e) => { try { fs.unlinkSync(tmp) } catch {} respond(500, { ok: false, error: String(e) }) })
            ws.on('finish', () => {
              try {
                const sz = fs.statSync(tmp).size
                if (declaredSize && sz !== declaredSize) {
                  try { fs.unlinkSync(tmp) } catch {}
                  respond(200, { ok: false, error: 'size_mismatch', received: sz })
                  return
                }
                fs.renameSync(tmp, target)
                respond(200, { ok: true, status: 'saved', size: sz })
              } catch (e) { try { fs.unlinkSync(tmp) } catch {} respond(500, { ok: false, error: String(e) }) }
            })
            fileStream.pipe(ws)
          })
          bb.on('error', (e) => { try { fs.unlinkSync(tmp) } catch {} respond(500, { ok: false, error: String(e) }) })
          bb.on('close', () => { if (!gotFile) respond(400, { ok: false, error: 'no_file' }) })
          req.pipe(bb)
        } catch (e) {
          respond(500, { ok: false, error: String(e) })
        }
        return
      }

      // Computer drives are an explicit read-only admin feature. Every request checks the
      // current server-side role, including images, videos and search continuation cursors.
      const computerBrowse = p.startsWith('/api/computer-gallery/')
      let computerFile = null
      if (computerBrowse) {
        const status = computerGalleryModule.accessStatus(apiUser, method)
        if (status !== 200) { send(status, { ok: false, error: status === 403 ? 'admin_only' : 'method_not_allowed' }); return }
        res.setHeader('Cache-Control', 'private, no-store')
        res.setHeader('X-Content-Type-Options', 'nosniff')
        try {
          if (p === '/api/computer-gallery/library') {
            send(200, await computerGallery.library(apiUserId, url.searchParams)); return
          }
          if (p !== '/api/computer-gallery/file' && p !== '/api/computer-gallery/thumb') {
            send(404, { ok: false, error: 'not_found' }); return
          }
          computerFile = (await computerGallery.resolve(url.searchParams.get('rel'), true)).full
        } catch (e) {
          const status = e.status || (e.code === 'EACCES' || e.code === 'EPERM' ? 403 : e.code === 'ENOENT' ? 404 : 500)
          send(status, { ok: false, error: e.status ? e.message : 'This folder or file is unavailable.' }); return
        }
      }

      // --- Space Saver: browse what's already backed up -------------------
      // The user's backups live under ssBaseDir()/<userFolder>. These read-only
      // routes let the app show them off (a gallery for friends). Photos/videos
      // only; hidden files, temp uploads and thumbnail caches are never listed.
      {
        const SS_PHOTO = new Set(['jpg','jpeg','png','gif','webp','heic','heif','bmp'])
        const SS_VIDEO = new Set(['mp4','mov','m4v','webm','mkv','avi','3gp'])
        const ssUserRoot = () => path.resolve(ssBaseDir(), ssSafeRel(apiUser.name || apiUserId) || 'user')
        const ssKind = (name) => {
          const ext = String(name.split('.').pop() || '').toLowerCase()
          if (SS_PHOTO.has(ext)) return 'photo'
          if (SS_VIDEO.has(ext)) return 'video'
          return null
        }
        // Resolve a browse-relative path to an absolute path strictly inside the user's root.
        const ssResolve = (rel) => {
          const safe = ssSafeRel(rel)
          const root = ssUserRoot()
          const full = safe ? path.resolve(root, safe) : root
          if (full !== root && !full.startsWith(root + path.sep)) return null
          return full
        }
        // Best-effort ffmpeg for thumbnails / video posters (cached to a temp dir).
        // Falls back gracefully (photos serve the original; videos 404 -> app shows a tile).
        let SS_FF = null, SS_FF_DONE = false
        const ssFfmpeg = () => {
          if (SS_FF_DONE) return SS_FF
          SS_FF_DONE = true
          const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
          const cands = [
            process.env.BEEBO_FFMPEG,
            process.resourcesPath ? path.join(process.resourcesPath, 'ffmpeg', exe) : null,
            path.join(__dirname, '..', 'resources', 'ffmpeg', exe),
            path.join(__dirname, 'resources', 'ffmpeg', exe),
          ]
          for (const c of cands) { try { if (c && fs.existsSync(c)) { SS_FF = c; break } } catch {} }
          if (!SS_FF) SS_FF = exe // last resort: rely on PATH; spawn failure is caught
          return SS_FF
        }
        const ssThumbDir = () => {
          const d = path.join(require('os').tmpdir(), 'beebo-ss-thumbs')
          try { fs.mkdirSync(d, { recursive: true }) } catch {}
          return d
        }

        if (p === '/api/space-saver/library') {
         try {
          const rel = url.searchParams.get('dir') || ''
          const dir = ssResolve(rel)
          if (!dir) { send(400, { ok: false, error: 'bad_path' }); return }
          let names = []
          try { names = fs.readdirSync(dir) } catch { send(200, { ok: true, dir: ssSafeRel(rel), parent: null, folders: [], items: [] }); return }
          const folders = [], items = []
          // The sort timestamp. A backed-up photo's filesystem mtime is often the COPY time, so
          // "Newest" would order by when it synced, not when it was taken. Camera/screenshot files
          // carry the real date in the name (Screenshot_20260904-…, IMG_20260904_…, PXL_2026…),
          // so parse that when present; otherwise fall back to the EARLIEST filesystem time (a copy
          // only ever moves times later, so the earliest is closest to the original).
          const ssCaptureTime = (nm, st) => {
            try {
              const m = String(nm).match(/(20\d{2})[._-]?(\d{2})[._-]?(\d{2})[T._ -]?(\d{2})?(\d{2})?(\d{2})?/)
              if (m) {
                const y = +m[1], mo = +m[2], d = +m[3]
                if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
                  const t = Date.UTC(y, mo - 1, d, +(m[4] || 0), +(m[5] || 0), +(m[6] || 0))
                  if (Number.isFinite(t) && t > 0 && t <= Date.now() + 2 * 86400000) return t
                }
              }
            } catch {}
            const c = [st.mtimeMs, st.birthtimeMs, st.ctimeMs].filter((x) => typeof x === 'number' && x > 0)
            return c.length ? Math.floor(Math.min(...c)) : Math.floor(st.mtimeMs || 0)
          }
          for (const name of names) {
            if (!name || name.startsWith('.')) continue
            if (name.endsWith('.uploading')) continue
            let st
            try { st = fs.statSync(path.join(dir, name)) } catch { continue }
            const childRel = (ssSafeRel(rel) ? ssSafeRel(rel) + '/' : '') + name
            if (st.isDirectory()) {
              let count = 0
              try { count = fs.readdirSync(path.join(dir, name)).filter((n) => n && !n.startsWith('.') && !n.endsWith('.uploading')).length } catch {}
              folders.push({ name, rel: childRel, itemCount: count })
            } else if (st.isFile()) {
              const kind = ssKind(name)
              if (!kind) continue
              items.push({ name, rel: childRel, type: kind, size: st.size, mtime: ssCaptureTime(name, st) })
            }
          }
          folders.sort((a, b) => a.name.localeCompare(b.name))
          items.sort((a, b) => b.mtime - a.mtime)
          const safeRel = ssSafeRel(rel)
          const parent = safeRel ? (safeRel.includes('/') ? safeRel.slice(0, safeRel.lastIndexOf('/')) : '') : null
          if (items.length > 1500) items.length = 1500
          if (folders.length > 1500) folders.length = 1500
          send(200, { ok: true, dir: safeRel, parent, folders, items })
          return
         } catch (e) { send(200, { ok: true, dir: '', parent: null, folders: [], items: [] }); return }
        }

        if (computerFile || p === '/api/space-saver/file' || p === '/api/space-saver/thumb') {
          const rel = url.searchParams.get('rel') || ''
          const full = computerFile || ssResolve(rel)
          if (!full) { send(400, { ok: false, error: 'bad_path' }); return }
          let st
          try { st = fs.statSync(full) } catch { send(404, { ok: false, error: 'not_found' }); return }
          if (!st.isFile()) { send(404, { ok: false, error: 'not_found' }); return }
          const kind = ssKind(path.basename(full))
          const ctFor = (name) => {
            const e = String(name.split('.').pop() || '').toLowerCase()
            const m = { jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', gif:'image/gif', webp:'image/webp', heic:'image/heic', heif:'image/heif', bmp:'image/bmp', mp4:'video/mp4', mov:'video/quicktime', m4v:'video/x-m4v', webm:'video/webm', mkv:'video/x-matroska', avi:'video/x-msvideo', '3gp':'video/3gpp' }
            return m[e] || 'application/octet-stream'
          }
          // THUMBNAIL: a cached, downscaled JPEG via ffmpeg when possible.
          if (p === '/api/space-saver/thumb' || p === '/api/computer-gallery/thumb') {
            const w = Math.max(96, Math.min(720, Number(url.searchParams.get('w') || '360') || 360))
            const key = require('crypto').createHash('sha1').update(full + '|' + st.mtimeMs + '|' + w).digest('hex')
            const cache = path.join(ssThumbDir(), key + '.jpg')
            const serveJpg = (fp) => {
              try {
                const s2 = fs.statSync(fp)
                res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': s2.size, 'Cache-Control': computerBrowse ? 'private, no-store' : 'max-age=86400' })
                pipeFileToResponse(res, fp)
                return true
              } catch { return false }
            }
            if (fs.existsSync(cache)) { if (serveJpg(cache)) return }
            const ff = ssFfmpeg()
            const { spawn } = require('child_process')
            const args = kind === 'video'
              ? ['-y', '-ss', '1', ...safeFfmpeg.inputArgs(full), '-frames:v', '1', '-vf', `scale='min(${w},iw)':-2`, cache]
              : ['-y', ...safeFfmpeg.inputArgs(full), '-frames:v', '1', '-vf', `scale='min(${w},iw)':-2`, cache]
            let done = false
            const finish = () => {
              if (done) return; done = true
              if (fs.existsSync(cache) && serveJpg(cache)) return
              // ffmpeg unavailable/failed: photos fall back to the original bytes; videos 404.
              if (kind === 'photo') {
                try {
                  res.writeHead(200, { 'Content-Type': ctFor(full), 'Content-Length': st.size, 'Cache-Control': computerBrowse ? 'private, no-store' : 'max-age=86400' })
                  pipeFileToResponse(res, full)
                } catch { send(404, { ok: false, error: 'not_found' }) }
              } else {
                send(404, { ok: false, error: 'no_thumb' })
              }
            }
            try {
              const child = spawn(ff, args, { stdio: 'ignore', windowsHide: true })
              const killer = setTimeout(() => { try { child.kill() } catch {} }, 15000)
              child.on('error', () => { clearTimeout(killer); finish() })
              child.on('close', () => { clearTimeout(killer); finish() })
            } catch { finish() }
            return
          }
          // FULL FILE: stream with Range support (for full-size photos + video playback).
          const total = st.size
          const range = req.headers['range']
          const ct = ctFor(full)
          if (range && /^bytes=/.test(range)) {
            const mm = /^bytes=(\d*)-(\d*)$/.exec(range)
            const suffix = mm && !mm[1] && mm[2] ? Number(mm[2]) : null
            let start = suffix !== null ? Math.max(0, total - suffix) : mm && mm[1] ? Number(mm[1]) : 0
            let end = suffix !== null ? total - 1 : mm && mm[2] ? Math.min(Number(mm[2]), total - 1) : total - 1
            if (!mm || (!mm[1] && !mm[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || suffix === 0 || start > end || start >= total) {
              res.writeHead(416, { 'Content-Range': `bytes */${total}` }); res.end(); return
            }
            res.writeHead(206, {
              'Content-Type': ct,
              'Content-Range': `bytes ${start}-${end}/${total}`,
              'Accept-Ranges': 'bytes',
              'Content-Length': end - start + 1,
            })
            pipeFileToResponse(res, full, { start, end, ...VIDEO_STREAM_OPTS })
          } else {
            res.writeHead(200, { 'Content-Type': ct, 'Content-Length': total, 'Accept-Ranges': 'bytes' })
            pipeFileToResponse(res, full, VIDEO_STREAM_OPTS)
          }
          return
        }
      }

      // --- AI co-writer: draft a custom storybook with the local AI (Ollama) ----
      // POST /api/cowriter/generate {title?, prompt, characters:[{name,what}]}
      //   -> {ok, jobId, status:'pending'} ; poll /api/cowriter/status?job=<id>.
      // Needs a local Ollama (http://127.0.0.1:11434). If it isn't running/installed
      // the job resolves 'unavailable' and the app shows a friendly set-up message.
      if (p === '/api/cowriter/generate') {
        if (method !== 'POST') { send(405, { ok: false, error: 'method_not_allowed' }); return }
        const body = await apiReadBody(req)
        const rawChars = Array.isArray(body.characters) ? body.characters.slice(0, 4) : []
        const chars = rawChars
          .map((c) => ({ name: String((c && c.name) || '').trim().slice(0, 40), what: String((c && c.what) || '').trim().slice(0, 120) }))
          .filter((c) => c.name)
        const prompt = String(body.prompt || '').trim().slice(0, 800)
        const title = String(body.title || '').trim().slice(0, 80)
        if (!chars.length || !prompt) { send(400, { ok: false, error: 'need_prompt_and_character' }); return }
        // One draft at a time, and finished jobs are forgotten after an hour: each job writes a book to disk and
        // starts a bake process (security review 2026-09-21, P-10).
        for (const [k, j] of cowriterJobs) if (Date.now() - (j.at || 0) > 3600000) cowriterJobs.delete(k)
        if ([...cowriterJobs.values()].some((j) => j.status === 'pending') || cowriterJobs.size >= 50) { send(429, { ok: false, error: 'busy' }); return }
        const jobId = require('crypto').randomBytes(8).toString('hex')
        cowriterJobs.set(jobId, { status: 'pending', progress: 'Warming up the story writer…', at: Date.now() })
        // Fire and forget; the app polls status.
        cowriterRun(jobId, { title, prompt, characters: chars }).catch((e) => {
          cowriterJobs.set(jobId, { status: 'error', error: 'The story writer had trouble. Please try again.', at: Date.now() })
        })
        send(200, { ok: true, jobId, status: 'pending' })
        return
      }
      if (p === '/api/cowriter/status') {
        const job = cowriterJobs.get(String(url.searchParams.get('job') || ''))
        if (!job) { send(404, { ok: false, status: 'error', error: 'unknown_job' }); return }
        send(200, { ok: true, status: job.status, slug: job.slug || null, error: job.error || null, progress: job.progress || null })
        return
      }

      // --- BeeboSchool: child profiles, session sync, report, parent PIN ----
      if (p === '/api/school/children') {
        if (method === 'POST') {
          const body = await apiReadBody(req)
          const name = String(body.name || '').trim().slice(0, 40)
          const age = (body.age == null || body.age === '') ? null : (parseInt(body.age, 10) || null)
          if (!name) { send(400, { ok: false, error: 'need_name' }); return }
          const list = schoolReadChildren()
          const child = { id: crypto.randomBytes(6).toString('hex'), name, age, createdAt: Date.now() }
          list.push(child); schoolWriteChildren(list)
          send(200, { ok: true, child }); return
        }
        if (method === 'DELETE') {
          const id = String(url.searchParams.get('id') || '')
          schoolWriteChildren(schoolReadChildren().filter((c) => c.id !== id))
          try { fs.unlinkSync(schoolSessionsFile(id)) } catch {}
          send(200, { ok: true }); return
        }
        send(200, { ok: true, children: schoolReadChildren() }); return
      }
      if (p === '/api/school/sessions') {
        if (method !== 'POST') { send(405, { ok: false, error: 'method_not_allowed' }); return }
        const body = await apiReadBody(req)
        const sessions = (Array.isArray(body.sessions) ? body.sessions : []).slice(0, 200).filter((x) => { try { return JSON.stringify(x).length <= 4096 } catch { return false } })
        const byChild = {}
        for (const s of sessions) { const id = String((s && s.profileId) || ''); if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) continue; (byChild[id] = byChild[id] || []).push(s) }
        let accepted = 0
        for (const id of Object.keys(byChild)) accepted += schoolAppendSessions(id, byChild[id])
        send(200, { ok: true, accepted }); return
      }
      if (p === '/api/school/report') {
        const id = String(url.searchParams.get('child') || '')
        send(200, { ok: true, report: schoolBuildReport(id) }); return
      }
      if (p === '/api/school/pin-status') { send(200, { ok: true, isSet: schoolPinSet() }); return }
      if (p === '/api/school/pin/set') {
        if (method !== 'POST') { send(405, { ok: false }); return }
        const body = await apiReadBody(req)
        const pin = String(body.pin || '')
        if (!/^\d{4,8}$/.test(pin)) { send(400, { ok: false, error: 'bad_pin' }); return }
        const pinWho = 'school:' + apiUserId, pinIp = 'school-ip:' + getClientIp(req)
        if (schoolPinSet()) {
          if (parentalPinLimiter.locked(pinWho) || parentalPinLimiter.locked(pinIp)) { send(429, { ok: false, error: 'too_many_attempts' }); return }
          if (!schoolPinVerify(String(body.current || ''))) { parentalPinLimiter.fail(pinWho); parentalPinLimiter.fail(pinIp); send(200, { ok: false, error: 'wrong_current' }); return }
        }
        schoolPinStore(pin); send(200, { ok: true }); return
      }
      if (p === '/api/school/pin/verify') {
        const body = await apiReadBody(req)
        // Wrong PINs are counted like the report page's (security review 2026-09-21, P-11): a 4-8 digit PIN with no
        // limit is guessed in minutes by any signed-in person.
        const pinWho = 'school:' + apiUserId, pinIp = 'school-ip:' + getClientIp(req)
        if (parentalPinLimiter.locked(pinWho) || parentalPinLimiter.locked(pinIp)) { send(429, { ok: false, error: 'too_many_attempts' }); return }
        const valid = schoolPinVerify(String(body.pin || ''))
        if (valid) parentalPinLimiter.clear(pinWho); else { parentalPinLimiter.fail(pinWho); parentalPinLimiter.fail(pinIp) }
        send(200, { ok: true, valid }); return
      }

      // --- BeeboSchool rewards + pet -------------------------------------
      function schoolProfileFile(id) { return path.join(schoolRoot(), 'profiles', (ssSafeRel(id).replace(/\//g, '_') || 'child') + '.json') }
      function schoolReadProfile(id) {
        try { const d = JSON.parse(fs.readFileSync(schoolProfileFile(id), 'utf8')); return { points: d.points || 0, pet: d.pet || null, unlocked: Array.isArray(d.unlocked) ? d.unlocked : [] } }
        catch { return { points: 0, pet: null, unlocked: [] } }
      }
      function schoolWriteProfile(id, p) { try { fs.mkdirSync(path.join(schoolRoot(), 'profiles'), { recursive: true }); fs.writeFileSync(schoolProfileFile(id), JSON.stringify(p)) } catch {} }
      if (p === '/api/school/profile') {
        if (method === 'POST') {
          const body = await apiReadBody(req)
          const id = String(body.child || '')
          if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) { send(400, { ok: false, error: 'bad_child' }); return }
          const prof = schoolReadProfile(id)
          if (typeof body.addPoints === 'number' && Number.isFinite(body.addPoints)) prof.points = Math.max(0, (prof.points || 0) + Math.max(-1000, Math.min(1000, body.addPoints)))
          if (body.pet && typeof body.pet === 'object' && JSON.stringify(body.pet).length <= 8192) prof.pet = body.pet
          if (Array.isArray(body.unlockedAdd)) for (const u of body.unlockedAdd.slice(0, 50)) if (u && prof.unlocked.length < 500 && !prof.unlocked.includes(String(u).slice(0, 64))) prof.unlocked.push(String(u).slice(0, 64))
          schoolWriteProfile(id, prof)
          send(200, { ok: true, profile: prof }); return
        }
        const gid = String(url.searchParams.get('child') || '')
        send(200, { ok: true, profile: schoolReadProfile(gid) }); return
      }
      if (p === '/api/school/pet-drawing') {
        const id = String(url.searchParams.get('child') || '')
        const fp = path.join(schoolRoot(), 'pet', (ssSafeRel(id).replace(/\//g, '_') || 'child') + '.png')
        if (method === 'POST') {
          if (!Busboy) { send(500, { ok: false, error: 'busboy_not_installed' }); return }
          try { fs.mkdirSync(path.dirname(fp), { recursive: true }) } catch {}
          const tmp = fp + '.up'; let responded = false
          const done = (s, o) => { if (!responded) { responded = true; send(s, o) } }
          try {
            const bb = Busboy({ headers: req.headers, limits: { files: 1 } }); let got = false
            bb.on('file', (_n, fs2) => { got = true; const ws = fs.createWriteStream(tmp); ws.on('finish', () => { try { fs.renameSync(tmp, fp); done(200, { ok: true }) } catch (e) { done(500, { ok: false }) } }); ws.on('error', () => done(500, { ok: false })); fs2.pipe(ws) })
            bb.on('close', () => { if (!got) done(400, { ok: false, error: 'no_file' }) })
            bb.on('error', () => done(500, { ok: false })); req.pipe(bb)
          } catch { done(500, { ok: false }) }
          return
        }
        let st; try { st = fs.statSync(fp) } catch { send(404, { ok: false }); return }
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': st.size, 'Cache-Control': 'no-cache' })
        pipeFileToResponse(res, fp); return
      }
      // --- BeeboSchool: child's own voice recordings (device + this PC only) ----
      if (p === '/api/school/voice' || p === '/api/school/voice-list') {
        const id = ssSafeRel(url.searchParams.get('child') || '').replace(/\//g, '_') || 'child'
        const slug = sbSafeSeg(url.searchParams.get('slug'))
        if (p === '/api/school/voice-list') {
          const dir = path.join(schoolRoot(), 'voice', id, slug || '_')
          let pages = []
          try { pages = fs.readdirSync(dir).map((n) => (/^page_(\d+)\.m4a$/.exec(n) || [])[1]).filter(Boolean).map(Number) } catch {}
          send(200, { ok: true, pages }); return
        }
        const page = String(url.searchParams.get('page') || '').replace(/[^0-9]/g, '')
        if (!slug || !page) { send(400, { ok: false, error: 'bad_args' }); return }
        const fp = path.join(schoolRoot(), 'voice', id, slug, 'page_' + page + '.m4a')
        if (method === 'POST') {
          if (!Busboy) { send(500, { ok: false, error: 'busboy_not_installed' }); return }
          try { fs.mkdirSync(path.dirname(fp), { recursive: true }) } catch {}
          const tmp = fp + '.up'; let responded = false
          const done = (s, o) => { if (!responded) { responded = true; send(s, o) } }
          try {
            const bb = Busboy({ headers: req.headers, limits: { files: 1 } }); let got = false
            bb.on('file', (_n, fs2) => { got = true; const ws = fs.createWriteStream(tmp); ws.on('finish', () => { try { fs.renameSync(tmp, fp); done(200, { ok: true }) } catch { done(500, { ok: false }) } }); ws.on('error', () => done(500, { ok: false })); fs2.pipe(ws) })
            bb.on('close', () => { if (!got) done(400, { ok: false, error: 'no_file' }) })
            bb.on('error', () => done(500, { ok: false })); req.pipe(bb)
          } catch { done(500, { ok: false }) }
          return
        }
        let st; try { st = fs.statSync(fp) } catch { send(404, { ok: false }); return }
        const total = st.size, range = req.headers['range']
        if (range && /^bytes=/.test(range)) {
          const rg = parseSingleRange(range, total)
          if (!rg) { res.writeHead(416, { 'Content-Range': `bytes */${total}` }); res.end(); return }
          const s = rg.start, e = rg.end
          res.writeHead(206, { 'Content-Type': 'audio/mp4', 'Content-Range': `bytes ${s}-${e}/${total}`, 'Accept-Ranges': 'bytes', 'Content-Length': e - s + 1 })
          pipeFileToResponse(res, fp, { start: s, end: e })
        } else {
          res.writeHead(200, { 'Content-Type': 'audio/mp4', 'Content-Length': total, 'Accept-Ranges': 'bytes' })
          pipeFileToResponse(res, fp)
        }
        return
      }
      // --- BeeboSchool: a book was read (feeds the report's "Books read") ----
      if (p === '/api/school/reading') {
        if (method !== 'POST') { send(405, { ok: false }); return }
        const body = await apiReadBody(req)
        const id = ssSafeRel(String(body.child || '')).replace(/\//g, '_') || 'child'
        const slug = String(body.slug || '').slice(0, 80)
        if (!slug) { send(400, { ok: false }); return }
        try {
          const dir = path.join(schoolRoot(), 'reading'); fs.mkdirSync(dir, { recursive: true })
          fs.appendFileSync(path.join(dir, id + '.jsonl'), JSON.stringify({ slug, title: String(body.title || slug).slice(0, 120), at: Number(body.at) || Date.now() }) + '\n')
        } catch {}
        send(200, { ok: true }); return
      }

      // ---- Shared "Up Next" watch queue -------------------------------------
      // A simple ordered list the owner sees in the player; guests add to it (via the phone hotspot
      // proxy, which calls these as the owner, or later the party page). Auto-add: a POST just
      // appends. Stored in electron-store so it survives restarts.
      const queueGet = () => { const q = store.get('watchQueue'); return Array.isArray(q) ? q : [] }
      const queueSet = (arr) => { try { store.set('watchQueue', arr.slice(0, 200)) } catch {} }
      const queueAdd = (entry, byName) => {
        const kind = (entry && (entry.kind === 'tv' || entry.kind === 'show')) ? entry.kind : 'movie'
        const e = {
          entryId: 'q_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          id: entry && entry.id ? String(entry.id) : '',
          kind,
          title: String((entry && entry.title) || 'Untitled').slice(0, 200),
          poster: entry && entry.poster ? String(entry.poster) : null,
          stream: entry && entry.stream ? String(entry.stream) : null,
          showKey: entry && entry.showKey ? String(entry.showKey) : null,
          by: String(byName || (entry && entry.by) || 'Guest').slice(0, 40),
          at: Date.now(),
        }
        if (!e.id && !e.showKey) return null
        queueSet([...queueGet(), e])
        return e
      }
      if (p === '/api/queue' && method === 'GET') { send(200, { ok: true, items: queueGet() }); return }
      if (p === '/api/queue' && method === 'POST') {
        const body = await apiReadBody(req)
        const e = queueAdd(body, (body && body.by) || apiUser.name || 'You')
        if (!e) { send(400, { ok: false, error: 'bad_item' }); return }
        send(200, { ok: true, entry: e }); return
      }
      if (p === '/api/queue' && method === 'DELETE') {
        const entry = String(url.searchParams.get('entry') || '')
        queueSet(queueGet().filter((x) => x.entryId !== entry))
        send(200, { ok: true }); return
      }
      if (p === '/api/queue/clear' && method === 'POST') { queueSet([]); send(200, { ok: true }); return }

      if (p === '/api/movies') {
        send(200, apiMovies(url))
        return
      }

      if (p === '/api/tvshows') {
        send(200, await apiTvShows(url))
        return
      }

      const epMatch = /^\/api\/tvshows\/([^/]+)\/episodes$/.exec(p)
      if (epMatch) {
        const out = await apiEpisodes(decodeURIComponent(epMatch[1]), apiUserId)
        send(out.status, out.body)
        return
      }

      if (p === '/api/upnext') {
        send(200, apiUpNext(url, apiUserId))
        return
      }

      if (p === '/api/credits') {
        send(200, apiCredits(url))
        return
      }

      if (p === '/api/markers') {
        if (method === 'POST') {
          const body = await apiReadBody(req)
          const out = applyMarkerWrite(body, { id: apiUserId, name: apiUser.name || 'Unknown' })
          if (!out.ok) {
            send(404, { ok: false, error: 'not_found' })
            return
          }
          send(200, { ok: true })
          return
        }
        // GET — what the app should act on for this item, already guarded.
        const kind = url.searchParams.get('kind') === 'tv' ? 'tv' : 'movie'
        const target = markerTargetFor(kind, url.searchParams.get('id'))
        if (!target) {
          send(404, { ok: false, error: 'not_found' })
          return
        }
        const m = playbackMarkerFor(store, target.scope, target.key, url.searchParams.get('duration'))
        // The top-level numbers stay exactly what viewers set: an older app treats introEndSeconds as
        // "skip everything from 0 to here", which would jump over a cold open if it were an auto
        // value. Everything the newer players need (auto included) is in `effective`.
        send(200, {
          ok: true,
          introStartSeconds: m.introStartSeconds,
          introEndSeconds: m.introEndSeconds,
          creditsStartSeconds: m.creditsStartSeconds,
          scope: m.scope,
          key: m.key,
          effective: effectiveFromViewer(kind, url.searchParams.get('id'), m, url.searchParams.get('duration'))
        })
        return
      }

      if (p === '/api/episode-context') {
        const out = await apiEpisodeContext(url)
        send(out.status, out.body)
        return
      }

      if (p === '/api/surf/genres') {
        send(200, apiSurfGenres(url))
        return
      }

      if (p === '/api/surf/years') {
        send(200, apiSurfYears(url))
        return
      }

      if (p === '/api/surf') {
        send(200, apiSurf(url))
        return
      }

      if (p === '/api/flag-quality') {
        if (method !== 'POST') {
          send(405, { ok: false, error: 'method_not_allowed' })
          return
        }
        const body = await apiReadBody(req)
        const kind = body.kind === 'tv' ? 'tv' : 'movie'
        const { decoded, filePath, title } = await resolveFlagTarget(kind, body.id)
        if (!filePath) {
          send(404, { ok: false, error: 'not_found' })
          return
        }
        const result = recordQualityFlag(store, {
          kind,
          filePath,
          fileName: decoded,
          relPath: decoded,
          title,
          userId: apiUserId,
          userName: apiUser.name || 'Unknown'
        })
        if (result.ok && !result.deduped) log(`flagged bad quality (${kind}) by ${apiUser.name || apiUserId}: ${filePath}`)
        send(200, { ok: true })
        return
      }

      if (p === '/api/watch-session') {
        if (method !== 'POST') {
          send(405, { ok: false, error: 'method_not_allowed' })
          return
        }
        const body = await apiReadBody(req)
        const kind = body.kind === 'tv' ? 'tv' : 'movie'
        const id = String(body.id || '')
        if (!id || !apiMediaExists(kind, id)) {
          send(404, { ok: false, error: 'not_found' })
          return
        }
        // Same helpers /watch, /tvwatch and /surprise/play use, so an app
        // session is indistinguishable from a website one in watch history.
        // `surf:true` marks it provisional exactly like /surprise/play does.
        const opts = { provisional: body.surf === true }
        const props = kind === 'tv' ? await tvWatchProps(id, apiUserId, opts) : await movieWatchProps(id, apiUserId, opts)
        try { serverDashboard.noteSession(req, props.sessionId) } catch {}
        send(200, { ok: true, sessionId: props.sessionId })
        return
      }

      if (p === '/api/progress') {
        if (method !== 'POST') {
          send(405, { ok: false, error: 'method_not_allowed' })
          return
        }
        const body = await apiReadBody(req)
        const sessionId = String(body.sessionId || '')
        if (!sessionId) {
          send(400, { ok: false, error: 'missing_sessionId' })
          return
        }
        // Identical call the player page's periodic POST /progress makes.
        if (!ownsWatchSession(apiUserId, sessionId)) { send(404, { ok: false, error: 'session_not_found' }); return }
        try { serverDashboard.noteSession(req, sessionId) } catch {}
        history.updateSession(store, sessionId, {
          currentTime: Number(body.currentTime),
          duration: Number(body.duration),
          state: playerState(body)
        })
        send(200, { ok: true })
        return
      }

      // Same rows the website's ▶ Continue Watching page renders, in the
      // shape the phone app wants (encoded id + tokenised stream URL).
      if (p === '/api/continue' || p === '/api/history') {
        // Continue is one row per show (an old app simply gets fewer, better rows);
        // History stays one row per file.
        const rows = decorateHistoryRows(
          p === '/api/continue' ? continueRowsFor(apiUserId) : history.viewedHistory(store, apiUserId)
        )
        send(200, {
          ok: true,
          items: rows.map((r) => ({
            id: r.id,
            kind: r.kind,
            title: r.title,
            poster: serverRelative(r.poster),
            stream: r.stream,
            currentTime: r.currentTime,
            duration: r.duration,
            percent: r.percent,
            watched: !!r.watched,
            // true: the show's next episode, offered because the last one was finished.
            ...(r.upNext ? { upNext: true } : {})
          }))
        })
        return
      }

      // My Library's separate clear actions, for the signed-in user only.
      //   GET  -> { ok, counts: { history, favourites, watchlist, watched } }
      //   POST { what: history|favourites|watchlist|watched } -> { ok, what, removed, counts }
      if (p === '/api/library/clear') {
        if (method === 'GET') {
          send(200, { ok: true, counts: libraryClear.counts(store, apiUserId) })
          return
        }
        if (method !== 'POST') {
          send(405, { ok: false, error: 'method_not_allowed' })
          return
        }
        const body = (await apiReadBody(req)) || {}
        const what = String(body.what || '')
        if (!libraryClear.KINDS.includes(what)) {
          send(400, { ok: false, error: 'bad_what' })
          return
        }
        const removed = libraryClear.clear(store, apiUserId, what)
        send(200, { ok: true, what, removed, counts: libraryClear.counts(store, apiUserId) })
        return
      }

      if (p === '/api/history/clear') {
        if (method !== 'POST') {
          send(405, { ok: false, error: 'method_not_allowed' })
          return
        }
        applyHistoryClear(apiUserId, await apiReadBody(req))
        send(200, { ok: true })
        return
      }

      // API twin of the website's POST /missing-request.
      if (p === '/api/missing-request') {
        if (method !== 'POST') {
          send(405, { ok: false, error: 'method_not_allowed' })
          return
        }
        const body = await apiReadBody(req)
        recordMissingRequest(store, {
          kind: body.kind === 'tv' ? 'tv' : 'movie',
          showName: body.showName,
          season: body.season,
          episode: body.episode,
          title: body.title,
          tmdbId: body.tmdbId,
          year: body.year,
          collectionName: body.collectionName,
          userId: apiUserId,
          userName: apiUser.name || 'Unknown'
        })
        send(200, { ok: true })
        return
      }

      // ---- Collections (movie franchises) -----------------------------------
      if (p === '/api/collections') {
        send(200, limitCollectionsFor(apiViewer, apiCollections()))
        return
      }
      const collectionMatch = /^\/api\/collections\/([^/]+)$/.exec(p)
      if (collectionMatch) {
        const out = apiCollectionDetail(decodeURIComponent(collectionMatch[1]), apiUser)
        // A limited viewer sees the parts they can play, not the rest of the franchise (whose
        // ratings aren't known, and whose "request it" button they can't use anyway).
        if (contentGateInstance.isLimited(apiViewer) && out.body && out.body.collection) {
          const parts = out.body.collection.parts.filter((part) => part.owned && part.movie)
          if (!parts.length) { send(404, { ok: false, error: 'not_found' }); return }
          out.body.collection = { ...out.body.collection, parts, total: parts.length, ownedCount: parts.length, complete: true }
        }
        send(out.status, out.body)
        return
      }

      // ---- Request a title ---------------------------------------------------
      if (p === '/api/title-search') {
        const out = await apiTitleSearch(url, apiUser)
        send(out.status, out.body)
        return
      }
      if (p === '/api/title-requests') {
        if (method === 'GET') {
          send(200, await apiListTitleRequests(apiUser))
          return
        }
        if (method === 'POST') {
          const out = await apiCreateTitleRequest(req, apiUser)
          send(out.status, out.body)
          return
        }
        send(405, { ok: false, error: 'method_not_allowed' })
        return
      }
      if (p === '/api/title-requests/dismiss') {
        if (method !== 'POST') {
          send(405, { ok: false, error: 'method_not_allowed' })
          return
        }
        const out = await apiDismissTitleRequest(req, apiUser)
        send(out.status, out.body)
        return
      }

      // ---- Actor page: not in your library, trailers, look-it-up sites ------
      const actorMissingMatch = /^\/api\/actor\/([^/]+)\/missing$/.exec(p)
      if (actorMissingMatch) {
        const out = await apiActorMissing(decodeURIComponent(actorMissingMatch[1]), apiUser)
        send(out.status, out.body)
        return
      }
      if (p === '/api/trailer') {
        const out = await apiTrailer(url, apiUser)
        send(out.status, out.body)
        return
      }
      if (p === '/api/search-sites') {
        // Any signed-in viewer: site names and URL templates only, nothing else.
        send(200, { ok: true, ...searchSites.resolveSearchSites(store) })
        return
      }

      // ---- Home discovery shelves: Recently Added + Because-you-watched -----
      if (p === '/api/recently-added') {
        try {
          send(200, { ok: true, items: recentlyAddedEntries().slice(0, 24).map((x) => x.item) })
        } catch { send(200, { ok: true, items: [] }) }
        return
      }
      if (p === '/api/recommended') {
        try {
          const cacheDir = getTmdbCacheDir ? getTmdbCacheDir() : null
          const movieMetaOf = cachedMovieMetaReader(cacheDir)
          const tvMetaOf = cachedTvMetaReader(cacheDir)
          const hist = history.viewedHistory(store, apiUserId) || []
          const genreScore = new Map()
          const watchedShowKeys = new Set()
          const watchedMovieIds = new Set()
          let seedName = ''
          for (const row of hist.slice(0, 20)) {
            if (row.kind === 'tv') {
              const gk = groupKeyAndName(row.fileName, path.basename(row.fileName))
              const key = encodeId(String(gk.show || '').toLowerCase())
              watchedShowKeys.add(key)
              const meta = tvMetaOf(key)
              if (!seedName && ((meta && meta.name) || gk.show)) seedName = (meta && meta.name) || gk.show
              for (const g of ((meta && meta.genre_ids) || [])) genreScore.set(g, (genreScore.get(g) || 0) + 1)
            } else {
              const meta = movieMetaOf(row.fileName)
              for (const n of movieVersions.siblingsOf(row.fileName)) watchedMovieIds.add(encodeId(n))
              if (!seedName && meta && meta.title) seedName = meta.title
              for (const g of ((meta && meta.genre_ids) || [])) genreScore.set(g, (genreScore.get(g) || 0) + 1)
            }
          }
          const topGenres = [...genreScore.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map((e) => e[0])
          const items = []
          if (topGenres.length) {
            const gset = new Set(topGenres)
            for (const m of collapseMovieVersions(scanMoviesMulti(allMoviesDirs()), cacheDir)) {
              if (items.length >= 24) break
              if (watchedMovieIds.has(m.id)) continue
              const meta = movieMetaOf(m.fileName)
              const gids = (meta && meta.genre_ids) || []
              if (!gids.some((g) => gset.has(g))) continue
              items.push({
                id: m.id, kind: 'movie', title: (meta && meta.title) || m.name,
                poster: serverRelative(meta ? posterUrl(cacheDir, meta.id, meta.poster_path) : null),
                stream: movieStreamPath(m.id), showKey: null,
              })
            }
            for (const [key, show] of apiShowMap()) {
              if (items.length >= 24) break
              if (watchedShowKeys.has(key)) continue
              const meta = tvMetaOf(key)
              const gids = (meta && meta.genre_ids) || []
              if (!gids.some((g) => gset.has(g))) continue
              items.push({
                id: key, kind: 'tv', title: (meta && meta.name) || show.name,
                poster: serverRelative(meta ? tvPosterUrl(cacheDir, meta.id, meta.poster_path) : null),
                stream: null, showKey: key,
              })
            }
          }
          send(200, { ok: true, reason: seedName ? ('Because you watched ' + seedName) : '', items: items.slice(0, 24) })
        } catch { send(200, { ok: true, reason: '', items: [] }) }
        return
      }

      // ---- Subtitles: sidecar .srt/.vtt tracks next to the video --------------
      if (p === '/api/subtitles') {
        const kind = url.searchParams.get('kind') === 'tv' ? 'tv' : 'movie'
        const id = String(url.searchParams.get('id') || '')
        let tracks = []
        try {
          tracks = resolveSubtitleTracks(kind, id, allTvShowsDirs(), allMoviesDirs()).map((t, i) => ({
            lang: t.lang,
            label: t.label,
            url: '/subtitles/file?kind=' + kind + '&id=' + encodeURIComponent(id) + '&i=' + i + '&mt=' + makeMediaToken(store, id),
            format: 'vtt',
          }))
        } catch { tracks = [] }
        send(200, { ok: true, tracks })
        return
      }

      // ---- Playlists + smart playlists (playlistApi.js has the contract) ----
      if (p === '/api/playlists' || p.startsWith('/api/playlists/')) {
        await primeLibrary('both')
        const body = method === 'POST' || method === 'DELETE' ? (await apiReadBody(req)) || {} : {}
        const out = playlistHandle(method, p.slice('/api/playlists'.length), url.searchParams, body, apiUser)
        send(out.status, out.body)
        return
      }

      // ---- Watchlist (personal "watch later"), per signed-in user ----------
      const wlGet = () => { try { const m = store.get('watchlist') || {}; const a = m[apiUserId]; return Array.isArray(a) ? a : [] } catch { return [] } }
      const wlSet = (arr) => { try { const m = store.get('watchlist') || {}; m[apiUserId] = arr.slice(0, 500); store.set('watchlist', m) } catch {} }
      if (p === '/api/watchlist' && method === 'GET') {
        send(200, { ok: true, items: wlGet().slice().sort((a, b) => (b.at || 0) - (a.at || 0)) }); return
      }
      if (p === '/api/watchlist' && method === 'POST') {
        const body = await apiReadBody(req)
        const kind = (body && (body.kind === 'tv' || body.kind === 'show')) ? body.kind : 'movie'
        const id = body && body.id ? String(body.id) : ''
        const showKey = body && body.showKey ? String(body.showKey) : null
        if (!id && !showKey) { send(400, { ok: false, error: 'bad_item' }); return }
        // Every stored string is clipped: these rows live in config.json, which is rewritten in full on each change
        // (security review 2026-09-21, P-4).
        if (id.length > 1200 || (showKey && showKey.length > 300)) { send(400, { ok: false, error: 'bad_item' }); return }
        const entry = {
          id, kind,
          title: String((body && body.title) || 'Untitled').slice(0, 300),
          poster: body && body.poster ? String(body.poster).slice(0, 500) : null,
          stream: body && body.stream ? String(body.stream).slice(0, 2000) : null,
          showKey, at: Date.now(),
        }
        const cur = wlGet().filter((x) => !(x.kind === kind && String(x.id) === id && String(x.showKey || '') === String(showKey || '')))
        wlSet([entry, ...cur])
        send(200, { ok: true, entry }); return
      }
      if (p === '/api/watchlist' && method === 'DELETE') {
        const id = String(url.searchParams.get('id') || '')
        const kind = String(url.searchParams.get('kind') || '')
        wlSet(wlGet().filter((x) => !(String(x.id) === id && x.kind === kind)))
        send(200, { ok: true }); return
      }

      // ---- Watched + favorite flags, per signed-in user --------------------
      const lfAll = () => { try { const m = store.get('libraryFlags'); return (m && typeof m === 'object') ? m : {} } catch { return {} } }
      const lfKey = (kind, id) => (kind === 'tv' ? 'tv' : 'movie') + ':' + id
      const lfUserGet = () => { const u = lfAll()[apiUserId]; return (u && typeof u === 'object') ? u : {} }
      const lfUserSet = (obj) => { try { const m = lfAll(); m[apiUserId] = obj; store.set('libraryFlags', m) } catch {} }
      if (p === '/api/library-status') {
        const kind = url.searchParams.get('kind') === 'tv' ? 'tv' : 'movie'
        const id = String(url.searchParams.get('id') || '')
        const f = lfUserGet()[lfKey(kind, id)] || {}
        // Favourite still lives in libraryFlags; watched comes from the one
        // watched-state store (for a show: every episode it has).
        let watched = false
        try { watched = watchedFor(apiUserId, kind, id) } catch {}
        send(200, { ok: true, watched, favorite: !!f.favorite }); return
      }
      // The old route, kept for 1.18/1.19. It no longer deletes history: the
      // mark goes through the same code as the scoped routes below, so an
      // episode keeps its "Watched" line and a whole show really does leave
      // Continue Watching. A tv id is a show key or an episode id.
      if (p === '/api/watched' && method === 'POST') {
        const body = await apiReadBody(req)
        const kind = body && body.kind === 'tv' ? 'tv' : 'movie'
        const id = body && body.id ? String(body.id) : ''
        if (!id || id.length > 800) { send(400, { ok: false, error: 'bad_item' }); return }
        const scope = kind === 'movie' ? 'movie' : apiShowMap().has(id) ? 'show' : 'episode'
        const t = watchedTargets(apiUserId, scope, { id, showKey: id }, true)
        if (t.error) { send(t.status, { ok: false, error: t.error }); return }
        applyWatched(apiUserId, t.items, body.watched === true)
        send(200, { ok: true }); return
      }
      // POST /api/watched/{movie|episode|season|show}
      //   movie, episode: { id, watched }
      //   season:         { showKey, season (a number, or null for Unsorted), watched }
      //   show:           { showKey, watched }
      // -> { ok, watched, count, changed, ids } - ids is every film/episode id the
      //    mark covered, so the app can drop each from its local caches.
      const watchedScope = /^\/api\/watched\/(movie|episode|season|show)$/.exec(p)
      if (watchedScope) {
        if (method !== 'POST') { send(405, { ok: false, error: 'method_not_allowed' }); return }
        const body = (await apiReadBody(req)) || {}
        if (typeof body.watched !== 'boolean') { send(400, { ok: false, error: 'missing_watched' }); return }
        const t = watchedTargets(apiUserId, watchedScope[1], body, false)
        if (t.error) { send(t.status, { ok: false, error: t.error }); return }
        send(200, { ok: true, ...applyWatched(apiUserId, t.items, body.watched) }); return
      }
      if (p === '/api/favorite' && method === 'POST') {
        const body = await apiReadBody(req)
        const kind = body && body.kind === 'tv' ? 'tv' : 'movie'
        const id = body && body.id ? String(body.id) : ''
        if (!id || id.length > 1200) { send(400, { ok: false, error: 'bad_item' }); return }
        const u = lfUserGet(); const k = lfKey(kind, id)
        const cur = u[k] || {}
        cur.favorite = body.favorite === true
        cur.at = Date.now()
        if (!cur.watched && !cur.favorite) delete u[k]
        else {
          // A person's favourites are a list a human keeps; past 5000 it is a way to fill the settings file.
          if (!u[k] && Object.keys(u).length >= 5000) { send(409, { ok: false, error: 'too_many_favorites' }); return }
          u[k] = cur
        }
        lfUserSet(u)
        send(200, { ok: true }); return
      }
      if (p === '/api/favorites' && method === 'GET') {
        const u = lfUserGet()
        const favs = Object.keys(u)
          .filter((k) => u[k] && u[k].favorite)
          .map((k) => { const i = k.indexOf(':'); return { kind: k.slice(0, i), id: k.slice(i + 1), at: u[k].at || 0 } })
          .sort((a, b) => b.at - a.at)
        const syn = favs.map((fav) => {
          try {
            const fileName = decodeId(fav.id)
            if (!fileName) return null
            let title
            if (fav.kind === 'tv') {
              const pe = parseEpisode(path.basename(fileName))
              title = (pe && pe.show) ? (pe.show + (pe.season !== null ? ' — S' + pe.season + 'E' + pe.episode : '')) : cleanTitle(fileName)
            } else {
              title = cleanTitle(fileName)
            }
            return { fileName, kind: fav.kind, title, currentTime: 0, duration: 0, percent: 0 }
          } catch { return null }
        }).filter(Boolean)
        const rows = decorateHistoryRows(syn)
        send(200, {
          ok: true,
          items: rows.map((r) => ({
            id: r.id, kind: r.kind, title: r.title,
            poster: serverRelative(r.poster), stream: r.stream,
            currentTime: r.currentTime || 0, duration: r.duration || 0, percent: r.percent || 0,
          })),
        }); return
      }

      send(404, { ok: false, error: 'not_found' })
    } catch (err) {
      // A thrown handler must still produce JSON — never an HTML error page.
      try {
        log(`api error on ${url.pathname}: ${err}`)
      } catch {}
      if (!res.headersSent) send(500, { ok: false, error: 'server_error' })
      else
        try {
          res.end()
        } catch {}
    }
  }

  // --- upload plumbing shared by the legacy multipart route and the
  // --- resumable chunked route ---------------------------------------------

  // The post-upload step, lifted verbatim out of the old POST /upload handler
  // so there is exactly one copy of it: choose the destination (Movies vs TV
  // Shows, show-name cleanup, unique destination filename), hand that path to
  // `deliver` to actually put the bytes there, then write the upload-history
  // entry. Returns the JSON body both routes answer with, so the Upload page
  // sees an identical response shape whichever way the file arrived.
  async function completeUploadedFile({ fileName, uploadedBy, deliver, onPlanFailed }) {
    if (!planUploadDest || !recordUploadEntry) {
      return { status: 500, body: { ok: false, error: 'upload_not_configured' } }
    }
    const plan = planUploadDest(fileName)
    if (!plan.ok) {
      if (onPlanFailed) onPlanFailed()
      return { status: 200, body: { ok: false, error: plan.error } }
    }
    try {
      await deliver(plan.destPath)
    } catch (err) {
      return { status: 500, body: { ok: false, error: String(err) } }
    }
    recordUploadEntry({
      fileName,
      kind: plan.kind,
      showName: plan.showName,
      destPath: plan.destPath,
      uploadedBy
    })
    return { status: 200, body: { ok: true, fileName, kind: plan.kind, showName: plan.showName } }
  }

  // Partial uploads live in a hidden folder on the SAME VOLUME as the library
  // they're headed for, so finishing a 40GB file is an instant rename rather
  // than a second full copy across drives.
  const UPLOAD_PARTS_DIRNAME = '.beebo-uploads'

  function uploadPartsDirPath() {
    const dirs = allMoviesDirs()
    const base = dirs[0] || (getMoviesDir ? getMoviesDir() : null)
    return base ? path.join(base, UPLOAD_PARTS_DIRNAME) : null
  }

  // Created lazily — the folder only appears once someone actually uploads.
  function ensureUploadPartsDir() {
    const dir = uploadPartsDirPath()
    if (!dir) return null
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  function partPathFor(uploadId, { create = false } = {}) {
    if (!UPLOAD_ID_RE.test(String(uploadId || ''))) return null
    const dir = create ? ensureUploadPartsDir() : uploadPartsDirPath()
    if (!dir) return null
    return path.join(dir, `${uploadId}.part`)
  }

  function partSize(uploadId) {
    const p = partPathFor(uploadId)
    if (!p) return 0
    try {
      return fs.statSync(p).size
    } catch {
      return 0
    }
  }

  // Abandoned partials would otherwise sit on the drive forever; anything
  // untouched for a week is never going to be resumed.
  function sweepStaleUploadParts() {
    try {
      const dir = uploadPartsDirPath()
      if (!dir || !fs.existsSync(dir)) return
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.part')) continue
        const p = path.join(dir, name)
        try {
          if (fs.statSync(p).mtimeMs < cutoff) {
            fs.unlinkSync(p)
            log(`swept stale upload partial ${name}`)
          }
        } catch {
          // a partial that vanished under us needs no sweeping
        }
      }
    } catch (err) {
      log(`upload partial sweep failed: ${err}`)
    }
  }

  const sendUploadJson = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  // Handles POST /upload/begin|chunk|finish|cancel and GET /upload/status.
  // Always answers JSON — the browser's upload queue can't make sense of an
  // HTML page or a redirect coming back mid-transfer.
  async function handleResumableUpload(req, res, url, currentUser) {
    const p = url.pathname

    if (p === '/upload/begin' && req.method === 'POST') {
      const body = await readJsonBody(req)
      const name = String(body.name || '')
      const size = Number(body.size)
      if (!name || !Number.isFinite(size) || size <= 0) {
        sendUploadJson(res, 400, { ok: false, error: 'bad_request' })
        return
      }
      if (!planUploadDest || !recordUploadEntry) {
        sendUploadJson(res, 500, { ok: false, error: 'upload_not_configured' })
        return
      }
      const uploadId = uploadIdFor(store, name, size)
      const partPath = partPathFor(uploadId, { create: true })
      if (!partPath) {
        sendUploadJson(res, 500, { ok: false, error: 'upload_not_configured' })
        return
      }
      const received = Math.min(partSize(uploadId), size)
      sendUploadJson(res, 200, { ok: true, uploadId, received })
      return
    }

    if (p === '/upload/status' && req.method === 'GET') {
      const uploadId = url.searchParams.get('uploadId') || ''
      if (!UPLOAD_ID_RE.test(uploadId)) {
        sendUploadJson(res, 400, { ok: false, error: 'bad_upload_id' })
        return
      }
      sendUploadJson(res, 200, { ok: true, received: partSize(uploadId) })
      return
    }

    if (p === '/upload/chunk' && req.method === 'POST') {
      const uploadId = url.searchParams.get('uploadId') || ''
      const offset = Number(url.searchParams.get('offset'))
      if (!UPLOAD_ID_RE.test(uploadId)) {
        req.resume()
        sendUploadJson(res, 400, { ok: false, error: 'bad_upload_id' })
        return
      }
      if (!Number.isFinite(offset) || offset < 0) {
        req.resume()
        sendUploadJson(res, 400, { ok: false, error: 'bad_offset' })
        return
      }
      const partPath = partPathFor(uploadId, { create: true })
      if (!partPath) {
        req.resume()
        sendUploadJson(res, 500, { ok: false, error: 'upload_not_configured' })
        return
      }
      const received = partSize(uploadId)
      if (offset !== received) {
        // Drain the body first so the client gets a clean reply on this
        // connection instead of a reset it would read as a network failure.
        req.resume()
        req.on('end', () => sendUploadJson(res, 200, { ok: false, error: 'offset_mismatch', received }))
        req.on('error', () => {})
        return
      }
      // Straight from the socket to the end of the .part file — a chunk is
      // never held in memory beyond the stream's own buffer.
      await new Promise((resolve) => {
        const ws = fs.createWriteStream(partPath, { flags: 'a' })
        let settled = false
        const done = (err) => {
          if (settled) return
          settled = true
          if (err) sendUploadJson(res, 500, { ok: false, error: String(err), received: partSize(uploadId) })
          else sendUploadJson(res, 200, { ok: true, received: partSize(uploadId) })
          resolve()
        }
        ws.on('finish', () => done(null))
        ws.on('error', (err) => done(err))
        req.on('error', (err) => {
          try {
            ws.destroy()
          } catch {}
          done(err)
        })
        req.pipe(ws)
      })
      return
    }

    if (p === '/upload/finish' && req.method === 'POST') {
      const body = await readJsonBody(req)
      const uploadId = String(body.uploadId || '')
      const name = String(body.name || '')
      if (!UPLOAD_ID_RE.test(uploadId)) {
        sendUploadJson(res, 400, { ok: false, error: 'bad_upload_id' })
        return
      }
      const partPath = partPathFor(uploadId)
      if (!name || !partPath || !fs.existsSync(partPath)) {
        sendUploadJson(res, 200, { ok: false, error: 'no_upload' })
        return
      }
      // Size check: the id is an HMAC of "name|size", so re-deriving it from
      // what's actually on disk only matches if every byte arrived.
      const onDisk = fs.statSync(partPath).size
      if (uploadIdFor(store, name, onDisk) !== uploadId) {
        sendUploadJson(res, 200, { ok: false, error: 'size_mismatch', received: onDisk })
        return
      }
      const result = await completeUploadedFile({
        fileName: name,
        uploadedBy: currentUser?.name || 'Website admin',
        deliver: async (destPath) => {
          try {
            fs.renameSync(partPath, destPath)
          } catch (err) {
            // Different filesystem (a TV Shows drive separate from Movies):
            // fall back to a copy, then drop the partial.
            if (err && err.code === 'EXDEV') {
              fs.copyFileSync(partPath, destPath)
              fs.unlinkSync(partPath)
            } else {
              throw err
            }
          }
        }
      })
      if (!result.body.ok) {
        try {
          if (fs.existsSync(partPath)) fs.unlinkSync(partPath)
        } catch {
          // nothing else to do; the weekly sweep will get it
        }
      }
      sendUploadJson(res, result.status, result.body)
      return
    }

    if (p === '/upload/cancel' && req.method === 'POST') {
      const body = await readJsonBody(req)
      const uploadId = String(body.uploadId || '')
      if (!UPLOAD_ID_RE.test(uploadId)) {
        sendUploadJson(res, 400, { ok: false, error: 'bad_upload_id' })
        return
      }
      const partPath = partPathFor(uploadId)
      try {
        if (partPath && fs.existsSync(partPath)) fs.unlinkSync(partPath)
      } catch {
        // already gone
      }
      sendUploadJson(res, 200, { ok: true, received: 0 })
      return
    }

    sendUploadJson(res, 404, { ok: false, error: 'not_found' })
  }

  // The one request handler behind BOTH protocols. It used to be passed
  // straight to http.createServer; it is now a named function so the plain
  // http.Server and the https.Server built further down can share it
  // verbatim — there is exactly one copy of every route, and TLS changes
  // nothing about how any of them behave.
  // (requestHandler, just below it, runs each request as its own unit for the library cache.)
  const jellyfinCompat = jellyfinCompatModule.create({
    store, log: (m) => { try { log(m) } catch {} }, dispatch: (rq, rs) => handleRequest(rq, rs), makeApiToken, verifyApiToken, attemptLogin,
    getUser: (id) => auth.getUsers(store).find((u) => u && u.id === id) || null, clientIp: getClientIp,
    ffmpegPath: (playbackOverrides && playbackOverrides.ffmpegPath) || convert.ffmpegPath, localPort: () => ACTIVE_PORT,
    serverName: () => { try { return (typeof getPublicName === 'function' && getPublicName()) || '' } catch { return '' } }
  })

  // Opt-in CORS for packaged TV apps (file:// pages): the `tvAppCors` setting, default off. See electron/corsPolicy.js.
  const tvAppCors = corsPolicyModule.create({ isEnabled: () => { try { return store.get('tvAppCors') === true } catch { return false } } })

  const handleRequest = async (req, res) => {
    let url
    try {
      url = new URL(req.url, 'http://localhost')
    } catch {
      res.writeHead(400)
      res.end()
      return
    }
    res.setHeader(MEDIA_TOKEN_HEADER_CAPABILITY, '1')
    httpSecurity.applySecurityHeaders(res) // nosniff, Referrer-Policy, frame-ancestors, CSP (report-only)
    if (cspReport(req, res, url.pathname)) return
    for (const hook of preRequestHooks) {
      let handled = false
      try { handled = hook(req, res, url) === true } catch { handled = false }
      if (handled) return
    }
    if (tvAppCors.intercept(req, res, url)) return // TV-app CORS preflight (answered before the license gate)
    if (typeof onLanRequest === 'function') {
      try {
        onLanRequest({
          ip: (req.socket && req.socket.remoteAddress) || '',
          ua: (req.headers && req.headers['user-agent']) || '',
          remote: !!(req.headers && req.headers['x-beebo-remote'])
        })
      } catch { /* a test hook never breaks a request */ }
    }

    // Internal remote-access host peer page, loaded by a hidden window on this
    // machine (localhost only). Served before the license gate so the peer can
    // run; the worker still authorizes the registration and every viewer.
    if (url.pathname === '/_rtc/host') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(RTC_HOST_HTML)
      return
    }

    // --- license gate: HOME IS ALWAYS FREE; only a BEEBO-RELAY away connection needs the
    //     owner's plan ---
    // Home traffic is identified by the real socket and local interface subnets.
    // A direct P2P connection or one carried by the household's OWN relay (own Cloudflare
    // account or own TURN server) costs Beebo nothing extra, so it is free at any quality
    // with no subscription needed - see awayQualityPolicy.isFreeRemoteConnection() and the
    // design note there. A direct HTTPS connection to this server's own socket (not via the
    // agent, not from home) is free too: Beebo Relay traffic always terminates at the agent.
    // Only a connection that actually fell through to Beebo's own relay
    // (or one this PC's agent can't prove is free) still needs an active plan, and only
    // when enforcement is switched on. Enforcement is off by default, so this whole
    // block is a no-op until the owner turns on paid remote with a real license key.
    if (license && typeof license.evaluate === 'function') {
      const isRemoteReq = !localAccess.isHomeRequest(req)
      const freeRemoteConnection = isRemoteReq && awayQualityPolicy.isFreeRemoteConnection(trustedRemotePath(req, localAccess))
      const lic = license.evaluate()
      if (isRemoteReq && !freeRemoteConnection && lic.enforced && !lic.serve) {
        const allow = url.pathname === '/health' || url.pathname === '/api/license/status'
        if (!allow) {
          if (url.pathname.startsWith('/api/')) {
            res.writeHead(402, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: 'remote_requires_plan', state: lic.state }))
          } else {
            res.writeHead(402, { 'Content-Type': 'text/html; charset=utf-8' })
            res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
              + '<title>Beebo \u2014 away-from-home needs a plan</title>'
              + '<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:520px;margin:14vh auto;padding:0 22px;text-align:center;color:#1b1b1f">'
              + '<div style="font-size:44px">\ud83d\udc30</div>'
              + '<h1 style="font-size:22px;margin:.4em 0">Watching away from home needs an active plan</h1>'
              + '<p style="color:#555;line-height:1.5">Streaming <b>at home</b> on the same Wi-Fi is always free. To watch <b>away from home</b>, the person who runs this Beebo server needs an active plan \u2014 they can open <b>Beebo</b> on the server computer and subscribe. Then everyone can watch from anywhere again.</p>'
              + '</div>')
          }
          return
        }
      }
    }

    // Jellyfin-compatible API (paths of the Jellyfin client protocol only; answers 404 while the setting is off).
    if (jellyfinCompat.claims(url.pathname) && await jellyfinCompat.handle(req, res, url)) return

    // Tunnel health probe: always answer 200 so remote-access self-heal can tell a
    // LIVE tunnel (reaches us -> 200) from a DEAD one (Cloudflare edge 404 / no route).
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end('{"ok":true}')
      return
    }

    // Installable web app (manifest, service worker, offline page, icons): public, no cookie, no library data.
    if (pwa.handle(req, res, url)) return

    // Private trip links: /trip/<token> and its media, and robots.txt (Disallow all). No sign-in; the
    // unguessable token in the address is the credential. See tripShareApi.handlePublic.
    if (tripShareApi.claimsPublic(url.pathname)) {
      await tripShareApi.handlePublic(tripShareCtx(req, res), req, res, url)
      return
    }
    // Movie Night (movieNightHttp.js): the TV screen and the phone page. Guests have no account, so this sits before the sign-in gate;
    // it answers only on the home network unless the owner says otherwise, and every action needs a room ticket.
    if (movieNight.claimsPublic(url.pathname) && await movieNight.handlePublic(req, res, url)) return

    // Phone speakers: guests' phones join with a QR code and no account (the room code is the key); see phoneSpeakersHttp.js.
    if (phoneSpeakers.claims(url.pathname)) {
      await phoneSpeakers.handle(req, res, url)
      return
    }

    // --- native phone app JSON API ---
    // Branches off FIRST, before the cookie session gate below, so an /api/*
    // request is always answered with JSON — never an HTML page and never a
    // 302 to /login, neither of which a native client can follow. Nothing
    // under /api/* existed before, so no website route changes behaviour.
    // Quality & audio: HLS playlists/pieces (signed ticket in the path) and embedded subtitle
    // tracks (media token). No login cookie - players, Cast receivers and the tunnel fetch these.
    if (liveTv.claimsPublic(url.pathname) && await liveTv.handlePublic(req, res, url)) return
    if (url.pathname.startsWith('/hls/') || url.pathname === '/subtitles/embedded' || url.pathname === '/trickplay/thumb') {
      if (await playback.handlePublic(req, res, url)) return
    }
    if (url.pathname.startsWith('/cinema/media/') && cinema.handlePublic(req, res, url)) return // pre-show trailer / intro files, by signed token

    // The Prometheus scrape address: the same handler as /api/v1/metrics, under the name scrapers
    // expect. Until the owner turns metrics on it is a plain 404, credential or not.
    if (url.pathname === '/metrics' || url.pathname === '/metrics/') {
      if (!metrics.isEnabled(store)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('Not found')
        return
      }
      await handlePublicApiRequest(req, res, url, '/api/v1/metrics', (req.method || 'GET').toUpperCase())
      return
    }

    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      await handleApiRequest(req, res, url)
      return
    }

    const cookies = auth.parseCookies(req)
    const userId = auth.verifySession(store, cookies[SESSION_COOKIE])

    // DNS-rebinding guard: a state-changing request that carries a session cookie must arrive under
    // one of this server's own names (httpSecurity.hostRejection). Sign-in and other cookie-less
    // posts are unaffected, and so is everything under /api (Bearer tokens).
    if (cookies[SESSION_COOKIE] && !process.env.BEEBO_ALLOW_ANY_HOST && !readStoreSetting('allowAnyHost')) {
      const rej = httpSecurity.hostRejection(hostPolicy, req)
      if (rej) {
        const hn = httpSecurity.hostnameOf(req.headers && req.headers.host)
        if (hn && !hostRejectionLogged.has(hn) && hostRejectionLogged.size < 20) { hostRejectionLogged.add(hn); logLine(`refused a ${req.method} under the unknown host name "${hn}". If this is your own domain, add it to the 'allowedHosts' setting or set BEEBO_ALLOWED_HOSTS.`) }
        res.writeHead(rej.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(rej.body))
        return
      }
    }

    // Cross-site guard for EVERY state-changing request the session cookie authenticates: one place
    // instead of one check per route (httpSecurity.cookieWriteRejection). Routes the site's own
    // scripts fetch() must also send JSON/binary or the X-Beebo-CSRF header; plain forms only get the
    // cross-site check. Sign-in and other cookie-less posts are not affected.
    if (userId) {
      const mode = httpSecurity.classifyCookieWrite(req.method, url.pathname)
      const rej = mode && httpSecurity.cookieWriteRejection(req, { strict: mode === 'strict', policy: hostPolicy })
      if (rej) {
        req.resume()
        res.writeHead(rej.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify({ ok: false, error: rej.error }))
        return
      }
    }

    // --- public, unauthenticated routes ---

    // --- BeeboSchool report card (parent-only; gated by the home-server login) ---
    if (url.pathname === '/school/report' || url.pathname === '/school/report/export' || url.pathname === '/school/report/clear' || url.pathname === '/school/report/unlock' || url.pathname === '/school/report/set-pin' || url.pathname === '/school/report/reset-pin') {
      if (!userId) { res.writeHead(302, { Location: '/login' }); res.end(); return }
      const children = schoolReadChildren()
      const pick = String(url.searchParams.get('child') || '') || (children[0] && children[0].id) || ''
      const reportBase = '/school/report' + (pick ? ('?child=' + encodeURIComponent(pick)) : '')
      const reportSep = pick ? '&' : '?'
      // Set / change / reset the report PIN. The person is the signed-in account owner,
      // so 'reset' clears it without the old PIN (secure recovery, no emailing secrets).
      // Wrong PINs are counted (per signed-in person and per address) and lock, like the parental PIN:
      // a 4-8 digit PIN with no limit is guessed in minutes by anyone signed in (security review 2026-09-21, L-4).
      const schoolPinWait = (who) => parentalPinLimiter.locked('school:' + who) || parentalPinLimiter.locked('school-ip:' + getClientIp(req))
      const schoolPinFail = (who) => { parentalPinLimiter.fail('school:' + who); parentalPinLimiter.fail('school-ip:' + getClientIp(req)) }
      if (url.pathname === '/school/report/unlock' && req.method === 'POST') {
        const body = await readBody(req)
        if (schoolPinWait(userId)) { res.writeHead(302, { Location: reportBase + reportSep + 'pin=bad' }); res.end(); return }
        if (schoolPinVerify(String(body.pin || ''))) {
          parentalPinLimiter.clear('school:' + userId)
          res.writeHead(302, { Location: reportBase, 'Set-Cookie': httpSecurity.buildCookie(req, SCHOOL_REPORT_COOKIE, schoolReportCookie(), { path: '/school/report', maxAge: 1800 }) })
        } else { schoolPinFail(userId); res.writeHead(302, { Location: reportBase + reportSep + 'pin=bad' }) }
        res.end(); return
      }
      if (url.pathname === '/school/report/reset-pin' && req.method === 'POST') {
        // Recovery without the old PIN is for the person who runs this server. Any other signed-in
        // household member (a child's profile included) could otherwise remove the parents' PIN.
        const resetBy = auth.getUsers(store).find((u) => u && u.id === userId)
        if (!resetBy || !resetBy.isAdmin) { res.writeHead(302, { Location: reportBase + reportSep + 'pin=wrongcur' }); res.end(); return }
        try { store.delete('schoolPinHash'); store.delete('schoolPinSalt') } catch (e) {}
        res.writeHead(302, { Location: reportBase + reportSep + 'pin=set' }); res.end(); return
      }
      if (url.pathname === '/school/report/set-pin' && req.method === 'POST') {
        const body = await readBody(req)
        const next = String(body.next || '').trim()
        if (!/^[0-9]{4,8}$/.test(next)) { res.writeHead(302, { Location: reportBase + reportSep + 'pin=badnew' }); res.end(); return }
        if (schoolPinSet()) {
          if (schoolPinWait(userId)) { res.writeHead(302, { Location: reportBase + reportSep + 'pin=wrongcur' }); res.end(); return }
          if (!schoolPinVerify(String(body.current || ''))) { schoolPinFail(userId); res.writeHead(302, { Location: reportBase + reportSep + 'pin=wrongcur' }); res.end(); return }
        }
        schoolPinStore(next)
        res.writeHead(302, { Location: reportBase, 'Set-Cookie': httpSecurity.buildCookie(req, SCHOOL_REPORT_COOKIE, schoolReportCookie(), { path: '/school/report', maxAge: 1800 }) })
        res.end(); return
      }
      // If a PIN is set and this browser hasn't unlocked recently, ask for it.
      if (schoolPinSet() && !schoolReportUnlocked(cookies)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(schoolPinGatePage({ reportBase: reportBase, bad: url.searchParams.get('pin') === 'bad' }))
        return
      }
      // A state change is a POST (the report page's "Clear" button is a form): a link on another site could
      // otherwise send a signed-in owner here and wipe a child's saved sessions (security review 2026-09-21, X-06).
      if (url.pathname === '/school/report/clear' && req.method === 'POST') {
        try { fs.unlinkSync(schoolSessionsFile(pick)) } catch (e) {}
        res.writeHead(302, { Location: reportBase }); res.end(); return
      }
      if (url.pathname === '/school/report/export') {
        const data = { child: children.find((c) => c.id === pick) || null, sessions: schoolReadSessions(pick) }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="beeboschool-' + (String(pick || 'child').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 60)) + '.json"' })
        res.end(JSON.stringify(data, null, 2)); return
      }
      const report = pick ? schoolBuildReport(pick) : {}
      let html
      try {
        html = schoolReport.renderReportPage(report, {
          childrenNav: children.map((c) => ({ id: c.id, name: c.name })),
          selectedId: pick,
          exportHref: '/school/report/export?child=' + encodeURIComponent(pick),
          clearHref: '/school/report/clear?child=' + encodeURIComponent(pick)
        })
      } catch (e) { html = '<h1>Report unavailable</h1>' }
      try { html = html.replace('</body>', schoolPinManageBar({ reportBase: reportBase, pinSet: schoolPinSet(), flag: url.searchParams.get('pin') || '' }) + '</body>') } catch (e) {}
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); return
    }


    if (url.pathname === '/download/windows-server') {
      // The Windows home-server installer (Beebo Entertainment Setup .exe). It's large, so it is
      // served from disk here and the marketing website links to this URL. Configurable via the
      // 'windowsInstallerPath' setting; otherwise the standard build/staging location is used.
      const configured = store.get('windowsInstallerPath')
      const candidates = [
        configured,
        path.join(__dirname, '..', 'windows-app', 'BeeboEntertainmentSetup.exe'),
        path.join(__dirname, '..', '..', '..', '..', 'windows-app', 'BeeboEntertainmentSetup.exe')
      ].filter(Boolean)
      const exe = candidates.find((f) => { try { return fs.statSync(f).isFile() } catch { return false } })
      if (!exe) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end('The Windows server installer isn\'t available for download yet.')
        return
      }
      // Ranges + ETag, so a browser can resume a dropped installer download.
      fileServe.serveFile(req, res, exe, {
        mime: 'application/octet-stream',
        streamOpts: VIDEO_STREAM_OPTS,
        headers: { 'Content-Disposition': 'attachment; filename="Beebo Entertainment Setup.exe"' }
      })
      return
    }

    if (url.pathname === '/download/android-app') {
      // The Android app APK, dropped next to the app source at
      // apps/desktop/android-app/BeeboEntertainment.apk (or wherever 'androidApkPath'
      // in settings points). Public like the Windows viewer download so a
      // family member can install it before they have an account.
      const configured = store.get('androidApkPath')
      const candidates = [
        configured,
        path.join(__dirname, '..', 'android-app', 'BeeboEntertainment.apk'),
        path.join(__dirname, '..', '..', '..', 'android-app', 'BeeboEntertainment.apk'),
        // Installs that predate the rename still have the old filename on disk.
        path.join(__dirname, '..', 'android-app', 'MovieAPP.apk'),
        path.join(__dirname, '..', '..', '..', 'android-app', 'MovieAPP.apk')
      ].filter(Boolean)
      const apk = candidates.find((f) => {
        try {
          return fs.statSync(f).isFile()
        } catch {
          return false
        }
      })
      if (!apk) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end('The Android app isn\'t available for download yet.')
        return
      }
      fileServe.serveFile(req, res, apk, {
        // The Android-specific type makes Chrome on a phone offer to install
        // it rather than treating it as an unknown blob.
        mime: 'application/vnd.android.package-archive',
        streamOpts: VIDEO_STREAM_OPTS,
        headers: { 'Content-Disposition': 'attachment; filename="Beebo Entertainment.apk"' }
      })
      return
    }

    if (url.pathname === '/download/auto-app') {
      // Beebo Auto — the companion app that puts the library in Android
      // Auto's own media screen. Separate package from the main phone app
      // (com.beeboentertainment.auto), installs alongside it, and is downloaded
      // the same public way so it can be installed before signing in.
      const configured = store.get('autoApkPath')
      const candidates = [
        configured,
        path.join(__dirname, '..', 'auto-app', 'JenkinsAPP-Auto.apk'),
        path.join(__dirname, '..', '..', '..', 'auto-app', 'JenkinsAPP-Auto.apk')
      ].filter(Boolean)
      const apk = candidates.find((f) => {
        try {
          return fs.statSync(f).isFile()
        } catch {
          return false
        }
      })
      if (!apk) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end('Beebo Auto isn\'t available for download yet.')
        return
      }
      fileServe.serveFile(req, res, apk, {
        mime: 'application/vnd.android.package-archive',
        streamOpts: VIDEO_STREAM_OPTS,
        headers: { 'Content-Disposition': 'attachment; filename="Beebo Auto.apk"' }
      })
      return
    }

    if (url.pathname === '/privacy') {
      // Public privacy policy for Beebo Mirror's Google Play listing. Served
      // from mirror-app/privacy-policy.html, before the login gate so Google and
      // anyone else can read it without an account.
      const candidates = [
        path.join(__dirname, '..', 'mirror-app', 'privacy-policy.html'),
        path.join(__dirname, '..', '..', '..', 'mirror-app', 'privacy-policy.html')
      ].filter(Boolean)
      const f = candidates.find((cf) => {
        try {
          return fs.statSync(cf).isFile()
        } catch {
          return false
        }
      })
      // No policy file in this copy of the app (it is not in the public source): serve the built-in
      // generic notice, which points at the website's full policy, rather than a dead end.
      const html = f ? fs.readFileSync(f) : Buffer.from(privacyNoticeHtml(), 'utf8')
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': html.length,
        'Cache-Control': 'public, max-age=3600'
      })
      res.end(html)
      return
    }

    if (url.pathname === '/download/windows-app') {
      // The portable Windows viewer, built by tools\build-windows-app.bat on
      // the machine that runs the server. Public like the Android download so
      // a family member can install it before they have an account.
      const configuredWin = store.get('windowsAppPath')
      const winCandidates = [
        configuredWin,
        path.join(__dirname, '..', '..', 'viewer', 'dist', 'Beebo-Entertainment-Viewer-Windows.zip'),
        path.join(__dirname, '..', 'viewer', 'dist', 'Beebo-Entertainment-Viewer-Windows.zip')
      ].filter(Boolean)
      const winZip = winCandidates.find((f) => {
        try {
          return fs.statSync(f).isFile()
        } catch {
          return false
        }
      })
      if (!winZip) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(
          'The Windows app hasn\'t been built yet. On the computer running Beebo Entertainment, ' +
            'run tools\\build-windows-app.bat once and it will appear here.'
        )
        return
      }
      fileServe.serveFile(req, res, winZip, {
        mime: 'application/zip',
        streamOpts: VIDEO_STREAM_OPTS,
        headers: { 'Content-Disposition': 'attachment; filename="Beebo Entertainment-Viewer-Windows.zip"' }
      })
      return
    }

    if (url.pathname === '/get-app') {
      // Friendly landing page explaining how to install the APK on a phone.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(getAppPage())
      return
    }

    if (url.pathname.startsWith('/media/artwork/')) {
      const cacheDir = getTmdbCacheDir ? getTmdbCacheDir() : null
      const name = url.pathname.slice('/media/artwork/'.length)
      const file = cacheDir ? artworkPicker.artworkFile(cacheDir, name) : null
      if (!file) {
        res.writeHead(404)
        res.end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' })
      pipeFileToResponse(res, file)
      return
    }

    if (
      url.pathname.startsWith('/media/poster/') ||
      url.pathname.startsWith('/media/actor/') ||
      url.pathname.startsWith('/media/poster-tv/')
    ) {
      const cacheDir = getTmdbCacheDir ? getTmdbCacheDir() : null
      const isActor = url.pathname.startsWith('/media/actor/')
      const isTv = url.pathname.startsWith('/media/poster-tv/')
      const idPart = path.basename(url.pathname).replace(/\.jpg$/, '')
      // TMDB ids are 1-12 digits. Anything else (dots, separators, Windows device names such as
      // CON) is a plain 404 before it gets near path.join.
      const file = cacheDir && /^\d{1,12}$/.test(idPart) && /^\/media\/(poster|actor|poster-tv)\/\d{1,12}\.jpg$/.test(url.pathname)
        ? isActor
          ? tmdbFileCache.localActorPhotoPath(cacheDir, idPart)
          : isTv
          ? tmdbFileCache.localTvPosterPath(cacheDir, idPart)
          : tmdbFileCache.localPosterPath(cacheDir, idPart)
        : null
      if (!file) {
        res.writeHead(404)
        res.end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=604800' })
      pipeFileToResponse(res, file)
      return
    }

    if (url.pathname === '/login' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(loginPage({ allowSignup: store.get('allowNewAccounts') !== false }))
      return
    }

    if (url.pathname === '/login' && req.method === 'POST') {
      // The whole credential path (IP lockout, the "admin" username probe
      // alert, failed-login recording/alerts, clearFailedLogin + touchLastSeen)
      // lives in attemptLogin() above, shared verbatim with POST /api/login so
      // the phone app can never bypass this page's brute-force protection.
      // This route just renders the same messages it always has.
      const { username, password } = await readBody(req)
      const result = await attemptLogin({ ip: getClientIp(req), username, password })
      if (!result.ok && result.reason === 'two_factor_required') {
        // Right password, two-factor on: ask for the code. No session yet.
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(page(accountSecurityWeb.twoFactorLoginBody({ challenge: result.challenge }), { narrow: true }))
        return
      }
      if (!result.ok) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(loginPage({ error: result.error, allowSignup: store.get('allowNewAccounts') !== false }))
        return
      }
      res.writeHead(302, { Location: '/', 'Set-Cookie': sessionCookieHeader(req, issueWebSession(req, result.user.id, result.method)) })
      res.end()
      return
    }

    // Step two of a sign-in for someone with two-factor on: the challenge from the password step
    // plus an authenticator code (or a recovery code). See twoFactor.js / completeSecondFactor().
    if (url.pathname === '/login/2fa') {
      if (req.method !== 'POST') { res.writeHead(302, { Location: '/login' }); res.end(); return }
      const { challenge, code } = await readBody(req)
      const again = (error) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(loginPage({ error, allowSignup: store.get('allowNewAccounts') !== false }))
      }
      const ch = twoFactor.readChallenge(store, challenge)
      if (!ch.ok || ch.purpose !== 'login') { again(ch.exhausted ? 'Too many wrong codes. Sign in again.' : 'That sign-in timed out. Enter your username and password again.'); return }
      const person = auth.getUsers(store).find((u) => u.id === ch.userId && u.status === 'approved')
      if (!person || !twoFactor.isEnabled(person)) { again('That sign-in timed out. Enter your username and password again.'); return }
      const result = completeSecondFactor({ ip: getClientIp(req), user: person, code })
      if (!result.ok) {
        const dead = twoFactor.challengeFailed(ch.nonce, ch.exp)
        if (dead || result.reason === 'locked') { again(result.error || 'Too many wrong codes. Sign in again.'); return }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(page(accountSecurityWeb.twoFactorLoginBody({ challenge, error: result.error }), { narrow: true }))
        return
      }
      twoFactor.consumeChallenge(ch.nonce, ch.exp)
      res.writeHead(302, { Location: '/', 'Set-Cookie': sessionCookieHeader(req, issueWebSession(req, result.user.id, result.method)) })
      res.end()
      return
    }

    // A one-time reset code from the owner (works with no email server). See resetCodes.js.
    if (url.pathname === '/reset-with-code') {
      const wrap = (body) => page(body, { narrow: true })
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(wrap(accountSecurityWeb.resetWithCodeBody({ username: url.searchParams.get('u') || '' })))
        return
      }
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
      const { username, code, password } = await readBody(req)
      const ip = getClientIp(req)
      // The same address / username / server-wide limits as the sign-in page, before the code is looked at.
      const lockout = auth.checkLockout(store, ip, username)
      if (lockout.locked) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(wrap(accountSecurityWeb.resetWithCodeBody({ username, error: lockedMessage(lockout) })))
        return
      }
      const out = resetCodes.redeem(store, { username, code, newPassword: password, ip })
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      if (out.ok) { res.end(wrap(accountSecurityWeb.resetWithCodeBody({ done: true }))); return }
      if (out.error === 'invalid') noteFailedSignIn(ip, username)
      res.end(wrap(accountSecurityWeb.resetWithCodeBody({ username, error: out.message })))
      return
    }

    // Password strength for the meter on the sign-up / reset pages. Reads nothing, changes nothing,
    // and never leaves this server; a small per-address cap keeps it from being used as a guessing aid.
    if (url.pathname === '/account/password-check' && req.method === 'POST') {
      const ip = getClientIp(req)
      if (!strengthCheckAllowed(ip)) { res.writeHead(429, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'slow_down' })); return }
      const body = await readJsonBody(req, 4096)
      const check = passwordPolicy.checkPassword(typeof body.password === 'string' ? body.password : '', { username: typeof body.username === 'string' ? body.username : '' })
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ ok: check.ok, score: check.score, label: check.label, issues: check.issues, suggestions: check.suggestions }))
      return
    }

    if (url.pathname === '/signup' && req.method === 'GET') {
      if (store.get('allowNewAccounts') === false) {
        res.writeHead(302, { Location: '/login' })
        res.end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(signupPage())
      return
    }

    if (url.pathname === '/signup' && req.method === 'POST') {
      const { username, email, password } = await readBody(req)
      if (store.get('allowNewAccounts') === false) {
        res.writeHead(302, { Location: '/login' })
        res.end()
        return
      }
      const result = auth.createSignup(store, { username, email, password })
      if (result.error) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(signupPage({ error: result.message || result.error, values: { username, email } }))
        return
      }
      const link = `${linkOrigin()}/verify?token=${result.token}`
      mailer
        .sendMail(store, {
          to: result.user.email,
          subject: 'Verify your Beebo Entertainment account',
          text: `Hi ${result.user.name},\n\nClick the link below to verify your email and activate your Beebo Entertainment account:\n\n${link}\n\nThis link expires in 24 hours. If you didn't sign up for this, you can ignore this email.`
        })
        .catch(() => {})
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(signupSentPage({ email: result.user.email }))
      return
    }

    if (url.pathname === '/verify' && req.method === 'GET') {
      const token = url.searchParams.get('token')
      const result = auth.verifySignupToken(store, token)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(verifyResultPage(result))
      return
    }

    if (url.pathname === '/logout') {
      // Signing out ends this device's session for real (a copied cookie stops working too).
      const ending = userId ? auth.parseSessionCookie(cookies[SESSION_COOKIE]) : null
      if (ending && ending.sid) { try { authSessions.revoke(store, userId, authSessions.hashSid(ending.sid).slice(0, 12)) } catch {} }
      res.writeHead(302, { Location: '/login', 'Set-Cookie': httpSecurity.buildCookie(req, SESSION_COOKIE, '', { maxAge: 0 }) })
      res.end()
      return
    }

    if (url.pathname === '/request-access' && req.method === 'GET') {
      if (store.get('allowNewAccounts') === false) {
        res.writeHead(302, { Location: '/login' })
        res.end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(requestAccessPage())
      return
    }

    if (url.pathname === '/request-access' && req.method === 'POST') {
      const { name, email, message } = await readBody(req)
      if (store.get('allowNewAccounts') === false) {
        res.writeHead(302, { Location: '/login' })
        res.end()
        return
      }
      if (!name || !name.trim() || !email || !email.trim()) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(requestAccessPage({ error: 'Please enter your name and email.' }))
        return
      }
      // Over the limit (or the pending list is full) the person still sees "submitted"; nothing is stored or mailed.
      const requestOk = anonFormAllowed(getClientIp(req), 'request-access', email) &&
        auth.getRequests(store).filter((r) => !r.status || r.status === 'pending').length < MAX_PENDING_ACCESS_REQUESTS
      if (requestOk) auth.submitAccessRequest(store, name, email, message)

      const adminEmail = requestOk ? adminNotifyTo(store) : null
      if (adminEmail) {
        mailer
          .sendMail(store, {
            to: adminEmail,
            subject: `Beebo Entertainment: access request from ${name}`,
            text: `${name} (${email}) is asking for access to your Beebo Entertainment library.\n\n${
              message ? `Message: ${message}\n\n` : ''
            }Open the app's Users tab to approve or deny.`
          })
          .catch(() => {})
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(requestAccessPage({ submitted: true }))
      return
    }

    if (url.pathname === '/forgot-code' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(forgotCodePage())
      return
    }

    if (url.pathname === '/forgot-code' && req.method === 'POST') {
      const { email } = await readBody(req)
      const user = anonFormAllowed(getClientIp(req), 'forgot-code', email) ? auth.findApprovedUserByEmail(store, email) : null
      if (user && !viewingPrivacy.isPrivate(store, user.id)) {
        const code = auth.regenerateCode(store, user.id)
        mailer
          .sendMail(store, {
            to: user.email,
            subject: 'Your Beebo Entertainment access code',
            text: `Hi ${user.name},\n\nYour Beebo Entertainment username: ${user.username}\nYour new access code: ${code}\n\nYour old code no longer works. Log in at the site's "Watch Now" link and enter both.`
          })
          .catch(() => {})
      }
      // same response either way, so we don't reveal whether an email has access
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(forgotCodePage({ submitted: true }))
      return
    }

    if (url.pathname === '/forgot-password' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(forgotPasswordPage({ mailConfigured: mailer.isConfigured(store) }))
      return
    }

    if (url.pathname === '/forgot-password' && req.method === 'POST') {
      const { email } = await readBody(req)
      const result = anonFormAllowed(getClientIp(req), 'forgot-password', email) ? auth.createPasswordResetToken(store, email, { ip: getClientIp(req) }) : null
      if (result) {
        const link = `${linkOrigin()}/reset-password?token=${result.token}`
        mailer
          .sendMail(store, {
            to: result.user.email,
            subject: 'Reset your Beebo Entertainment password',
            text: `Hi ${result.user.name},\n\nClick the link below to set a new password for your Beebo Entertainment account:\n\n${link}\n\nThis link expires in 1 hour. If you didn't request this, you can ignore this email — your password won't change.`
          })
          .catch(() => {})
      }
      // same response either way, so we don't reveal whether an email has an account
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(forgotPasswordPage({ submitted: true, mailConfigured: mailer.isConfigured(store) }))
      return
    }

    if (url.pathname === '/reset-password' && req.method === 'GET') {
      const token = url.searchParams.get('token')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(resetPasswordPage({ token }))
      return
    }

    if (url.pathname === '/reset-password' && req.method === 'POST') {
      const { token, password } = await readBody(req)
      const result = auth.resetPasswordWithToken(store, token, password, { ip: getClientIp(req) })
      if (!result.ok) {
        const isValidationMsg = result.reason && result.reason !== 'invalid' && result.reason !== 'expired'
        const error = isValidationMsg
          ? result.reason
          : result.reason === 'expired'
          ? 'That reset link has expired. Request a new one.'
          : 'That reset link is invalid or has already been used.'
        // Validation errors (e.g. password too short) should let them retry with
        // the same token still in the form; expired/invalid tokens send them to
        // request a fresh link instead.
        if (isValidationMsg) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(resetPasswordPage({ token, error }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(resetPasswordDonePage({ ok: false, error }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(resetPasswordDonePage({ ok: true }))
      return
    }

    // --- everything below requires a valid session ---
    // Exception: /file and /tvfile with a valid short-lived media token (`mt`).
    // A Chromecast or AirPlay TV pulls the video stream itself and has no login
    // cookie, so the player page bakes a signed token into the video URL.
    // The phone's own player may send it as a header instead (MEDIA_TOKEN_HEADER).
    const mediaToken =
      (url.pathname === '/file' || url.pathname === '/tvfile' || url.pathname === '/subtitles/file')
        ? checkMediaToken(store, url.searchParams.get('id') || '',
          url.searchParams.get('mt') || String(req.headers[MEDIA_TOKEN_HEADER] || ''))
        : { ok: false }
    const mediaTokenOk = mediaToken.ok

    // The resumable upload endpoints are answered with JSON even when there
    // is no session at all: an XHR mid-chunk cannot follow a 302 to an HTML
    // login page, it would just look like a corrupt response. Only these five
    // paths are affected — every other route still redirects as before.
    if (!userId && RESUMABLE_UPLOAD_PATHS.has(url.pathname)) {
      req.resume()
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'admin_only' }))
      return
    }

    if (!userId && !mediaTokenOk) {
      res.writeHead(302, { Location: '/login' })
      res.end()
      return
    }

    if (userId) auth.touchLastSeen(store, userId, getClientIp(req))
    const currentUser = auth.getUsers(store).find((u) => u.id === userId) || null
    const isAdmin = !!currentUser?.isAdmin
    const navSecure = !!(req && req.socket && req.socket.encrypted)

    // --- account security: this device's session, the owner's "admins need two-factor" hold, and the
    // person's own Account security page (two-factor, password, signed-in devices) ---
    const sessionMeta = userId ? auth.parseSessionCookie(cookies[SESSION_COOKIE]) : null
    if (userId && sessionMeta && sessionMeta.sid) authSessions.noteIp(store, sessionMeta.sid, getClientIp(req))
    const securityPath = url.pathname === '/account/security' || url.pathname.startsWith('/account/security/')
    // Owner policy: an admin without two-factor can only reach the page that sets it up (plus sign-out).
    // The desktop app's own windows (desktop cookies) are the owner at their own PC and are exempt.
    if (currentUser && !(sessionMeta && sessionMeta.desktop) && twoFactor.setupRequired(store, currentUser) &&
        !securityPath && url.pathname !== '/logout' && url.pathname !== '/heartbeat') {
      // One log line per person per ten minutes, not one per redirected request.
      const heldAt = heldLogAt.get(currentUser.id) || 0
      if (Date.now() - heldAt > 10 * 60 * 1000) {
        heldLogAt.set(currentUser.id, Date.now())
        securityLog.record(store, { type: 'two_factor_setup_required', userId: currentUser.id, username: currentUser.username, known: true, ip: getClientIp(req) })
      }
      if (req.method === 'GET' || req.method === 'HEAD') { res.writeHead(302, { Location: '/account/security?required=1' }); res.end(); return }
      req.resume()
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'two_factor_setup_required' }))
      return
    }
    if (securityPath && currentUser) {
      const sub = url.pathname.slice('/account/security'.length).replace(/^\/+/, '')
      if (sub === 'api' || sub.startsWith('api/')) {
        const apiSub = sub.slice(3)
        const method = String(req.method || 'GET').toUpperCase()
        let body = {}
        if (method === 'POST') {
          // JSON only: a cross-site form cannot send this without a CORS preflight, which this server never answers.
          if (!/^application\/json\b/i.test(String(req.headers['content-type'] || '')) || backup.isCrossSiteRequest(req.headers)) {
            req.resume(); res.writeHead(415, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'json_only' })); return
          }
          body = await readJsonBody(req, 16 * 1024)
        }
        const out = accountSecurity.handle({
          method, sub: apiSub, body, user: currentUser, ip: getClientIp(req),
          currentSid: sessionMeta && sessionMeta.sid,
          reissue: () => { const cookie = issueWebSession(req, currentUser.id, 'password'); return { cookie, sid: (auth.parseSessionCookie(cookie) || {}).sid } }
        })
        const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
        if (out.session && out.session.cookie) headers['Set-Cookie'] = sessionCookieHeader(req, out.session.cookie)
        else if (out.clearSession) headers['Set-Cookie'] = httpSecurity.buildCookie(req, SESSION_COOKIE, '', { maxAge: 0 })
        res.writeHead(out.status, headers)
        res.end(JSON.stringify(out.body))
        return
      }
      if (sub === '' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(page(`${sectionNav('security', isAdmin, navSecure)}${accountSecurityWeb.securityBody({ info: accountSecurity.overview(currentUser, sessionMeta && sessionMeta.sid), apiBase: '/account/security/api', required: twoFactor.setupRequired(store, currentUser) })}`))
        return
      }
    }

    // --- parental controls / share scope on the website and the streams ---
    // Who is watching: a media token bound to a viewer (a Cast device has no cookie), else the
    // signed-in person. Lists are filtered by the library walks; the routes that take one title
    // are checked here.
    const webViewer = mediaToken.ok && mediaToken.scope ? viewerForMediaScope(mediaToken.scope) : viewerForUser(currentUser)
    req.beeboUserId = webViewer && webViewer.type === 'member' ? webViewer.userId : userId || null
    theme.setRequestUser(store, req.beeboUserId)
    contentGate.setRequestViewer(webViewer)
    if (contentGateInstance.isLimited(webViewer)) {
      const pn = url.pathname
      const idParam = url.searchParams.get('id') || ''
      const isStream = pn === '/file' || pn === '/tvfile'
      const titleKind = pn === '/file' || pn === '/watch' ? 'movie'
        : pn === '/tvfile' || pn === '/tvwatch' ? 'tv'
        : pn === '/subtitles/file' ? (url.searchParams.get('kind') === 'tv' ? 'tv' : 'movie') : null
      const refuse = (status, message) => {
        if (isStream || pn === '/subtitles/file') {
          // The reason travels as text so a phone download can show it instead of "link expired".
          res.writeHead(status, isStream ? { 'Content-Type': 'text/plain; charset=utf-8' } : undefined)
          res.end(isStream ? message : undefined)
          return
        }
        const html = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Beebo</title>' +
          '<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:520px;margin:14vh auto;padding:0 22px;text-align:center">' +
          '<h1 style="font-size:22px">' + escapeHtml(message) + '</h1><p><a href="/">Back to the library</a></p></div>'
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(html)
      }
      // A share with downloads off: the phone app marks a download's requests (X-Beebo-Download).
      if (isStream && webViewer.type === 'guest' && webViewer.share && !webViewer.share.downloads && req.headers['x-beebo-download']) {
        refuse(403, 'Downloads are off for this shared library.')
        return
      }
      if (titleKind) {
        const why = isStream ? streamRefusal(webViewer, titleKind, idParam)
          : !contentGateInstance.allowId(webViewer, titleKind, idParam) ? { status: 404, message: 'Not found' } : null
        if (why) { refuse(why.status, why.message || 'Not found'); return }
        if (pn === '/watch' || pn === '/tvwatch') {
          const t = contentGateInstance.timeGate(webViewer)
          if (!t.ok) { refuse(403, t.message); return }
        }
      }
      if (pn === '/tvshows' && url.searchParams.get('show') && !contentGateInstance.allowId(webViewer, 'tv', url.searchParams.get('show'))) {
        refuse(404, 'Not found')
        return
      }
      if (pn === '/surprise/play') {
        const t = contentGateInstance.timeGate(webViewer)
        if (!t.ok) { refuse(403, t.message); return }
      }
      // A restricted profile can't ask the owner for titles from the website either.
      if ((pn === '/missing-request' || pn === '/suggest') && req.method === 'POST') {
        refuse(403, 'This profile has parental controls on. Ask the person who runs Beebo.')
        return
      }
      if (pn === '/progress' && req.method === 'POST') contentGateInstance.noteWatching(webViewer)
      if (isStream) watchLimitedStream(req, res, webViewer)
    }
    // The web viewer's Quality & audio picker: the same routes as the app's /api/playback/*,
    // signed in with the website's login cookie instead of a bearer token.
    if (userId && liveTv.claimsWeb(url.pathname)) {
      if (await liveTv.handleWeb(req, res, url, { user: currentUser ? { id: currentUser.id, isAdmin: !!currentUser.isAdmin } : null, renderPage: (body) => page(body), nav: sectionNav('livetv', isAdmin, navSecure) })) return
    }
    if (userId && url.pathname.startsWith('/playback-api/')) {
      const sendJson = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)) }
      if (cinema.claims(url.pathname.slice('/playback-api'.length)) && await cinema.handle(req, res, url.pathname.slice('/playback-api'.length), url, { userId, send: sendJson, isGuest: !!(webViewer && webViewer.type === 'guest') })) return
      if (await playback.handle(req, res, url.pathname.slice('/playback-api'.length), url, { userId, send: sendJson })) return
      sendJson(404, { ok: false, error: 'not_found' })
      return
    }
    // Watch together: the player's calls (signed in with the login cookie) and the invite link people open.
    if (userId && url.pathname.startsWith('/watch-together-api/')) {
      const sendJson = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)) }
      if (await watchTogether.handle(req, res, url, url.pathname.slice('/watch-together-api'.length), { userId, send: sendJson })) return
      sendJson(404, { ok: false, error: 'not_found' })
      return
    }
    if (userId && url.pathname === '/watch-together/join' && req.method === 'GET') {
      await watchTogether.landing(req, res, url, { userId })
      return
    }
    // Phone speakers: the signed-in person starts a room for a film (phoneSpeakersHttp.handleOwner).
    if (userId && url.pathname.startsWith('/phone-speakers-api/')) {
      const sendJson = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)) }
      if (await phoneSpeakers.handleOwner(req, res, url, url.pathname.slice('/phone-speakers-api'.length), { userId, send: sendJson })) return
      sendJson(404, { ok: false, error: 'not_found' })
      return
    }

    if (url.pathname === '/upload' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(uploadPage({ history: store.get('uploadHistory') || [], isAdmin }))
      return
    }

    // --- the admin section of the website ---
    // Matched here, below the session gate (so a logged-out visitor has already
    // been sent to /login) and above every library route, so no /admin* path can
    // fall through to another handler. Its own isAdmin and TLS gates are inside.
    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
      await handleAdminPage(req, res, url, currentUser, isAdmin)
      return
    }

    // --- the Music page's recordings (musicApi.js handleRecordings), signed in with the login cookie ---
    if (userId && (url.pathname === '/music-api/recordings' || url.pathname.startsWith('/music-api/recordings/'))) {
      const sendJson = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)) }
      // A cookie rides along on a request another site starts, so only this page's own requests may change anything.
      if (req.method !== 'GET' && req.method !== 'HEAD' && backup.isCrossSiteRequest(req.headers)) {
        req.resume()
        sendJson(403, { ok: false, error: 'cross_site' })
        return
      }
      const apiPath = '/api/music' + url.pathname.slice('/music-api'.length)
      const handled = await musicHttp.handleApi(req, res, url, apiPath, req.method, { send: sendJson, userId: () => userId, isAdmin: () => false })
      if (!handled) sendJson(404, { ok: false, error: 'not_found' })
      return
    }

    // --- the Audiobooks page's data (audiobookApi.js), signed in with the login cookie ---
    if (userId && (url.pathname === '/audiobooks-api' || url.pathname.startsWith('/audiobooks-api/'))) {
      const sendJson = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)) }
      // A cookie rides along on a request another site starts, so only this page's own requests may change anything.
      if (req.method !== 'GET' && req.method !== 'HEAD' && backup.isCrossSiteRequest(req.headers)) {
        req.resume()
        sendJson(403, { ok: false, error: 'cross_site' })
        return
      }
      const apiPath = '/api/audiobooks' + url.pathname.slice('/audiobooks-api'.length)
      const handled = await audiobookHttp.handleApi(req, res, url, apiPath, req.method, { send: sendJson, userId: () => userId, isAdmin: () => false })
      if (!handled) sendJson(404, { ok: false, error: 'not_found' })
      return
    }

    // --- the Audiobooks page (audiobookApi.js handleWeb) ---
    if (userId && url.pathname === '/audiobooks') {
      const nav = sectionNav('audiobooks', isAdmin, navSecure)
      if (audiobookHttp.handleWeb(req, res, url, { renderPage: (body) => page(body), nav })) return
    }

    // --- the Music page (musicApi.js handleWeb) ---
    if (userId && (url.pathname === '/music' || url.pathname === '/music/album.json' || url.pathname === '/music/lyrics.json')) {
      const nav = sectionNav('music', isAdmin, navSecure)
      if (musicHttp.handleWeb(req, res, url, { renderPage: (body) => page(body), nav })) return
    }

    // Library pages read the cached walk; make sure it is current first, off the main thread.
    if (WEB_LIBRARY_ROUTES.has(url.pathname)) await primeLibrary('both')

    // --- resumable chunked upload (the Upload page's queue) ---
    // Sits ahead of the legacy multipart POST /upload below, which is left
    // exactly as it was for anything still posting a whole file in one go.
    if (RESUMABLE_UPLOAD_PATHS.has(url.pathname)) {
      if (!isAdmin) {
        req.resume()
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'admin_only' }))
        return
      }
      try {
        await handleResumableUpload(req, res, url, currentUser)
      } catch (err) {
        log(`resumable upload error on ${url.pathname}: ${err}`)
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'server_error' }))
        } else {
          try {
            res.end()
          } catch {}
        }
      }
      return
    }

    if (url.pathname === '/upload' && req.method === 'POST') {
      if (!isAdmin) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'admin_only' }))
        return
      }
      if (!planUploadDest || !recordUploadEntry) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'upload_not_configured' }))
        return
      }
      if (!Busboy) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'busboy_not_installed' }))
        return
      }
      try {
        const bb = Busboy({ headers: req.headers })
        let responded = false
        const respond = (status, body) => {
          if (responded) return
          responded = true
          res.writeHead(status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(body))
        }
        bb.on('file', (_name, fileStream, info) => {
          // Same destination/history logic the resumable route uses — the
          // only difference is how the bytes get to destPath.
          completeUploadedFile({
            fileName: info.filename,
            uploadedBy: currentUser?.name || 'Website admin',
            onPlanFailed: () => fileStream.resume(), // drain so the request can finish
            deliver: (destPath) =>
              new Promise((resolve, reject) => {
                const writeStream = fs.createWriteStream(destPath)
                writeStream.on('finish', resolve)
                writeStream.on('error', reject)
                fileStream.pipe(writeStream)
              })
          }).then((result) => respond(result.status, result.body))
        })
        bb.on('error', (err) => respond(500, { ok: false, error: String(err) }))
        req.pipe(bb)
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: String(err) }))
      }
      return
    }

    if (url.pathname === '/upload/delete' && req.method === 'POST') {
      if (!isAdmin) {
        res.writeHead(302, { Location: '/upload' })
        res.end()
        return
      }
      const { id } = await readJsonBody(req)
      const uploadHistory = store.get('uploadHistory') || []
      const entry = uploadHistory.find((e) => e.id === id)
      if (entry) {
        try {
          if (fs.existsSync(entry.destPath)) fs.unlinkSync(entry.destPath)
        } catch {
          // if the file's already gone, still drop the history row below
        }
        store.set('uploadHistory', uploadHistory.filter((e) => e.id !== id))
      }
      res.writeHead(302, { Location: '/upload' })
      res.end()
      return
    }

    if (url.pathname === '/heartbeat' && req.method === 'POST') {
      // touchLastSeen above already recorded this; this route just exists so the
      // browser has something to ping every ~20s while a tab stays open, so
      // "online" reflects an open tab and not just the last page load.
      res.writeHead(204)
      res.end()
      return
    }

    if (url.pathname === '/') {
      // Everything below asks per film, so the settings, the manifest and the
      // image folders are each read once for this render (see renderSettings,
      // tmdbLookup and localImageIndex) rather than once per film.
      const settings = renderSettings(store)
      const key = settings.get('tmdbApiKey') || process.env.TMDB_API_KEY
      const cacheDir = getTmdbCacheDir ? getTmdbCacheDir() : null
      const movies = collapseMovieVersions(scanMoviesMulti(allMoviesDirs()), cacheDir)
      const manifestForRender = cacheDir ? tmdbFileCache.getManifest(cacheDir) : undefined
      const enrichedRaw = await Promise.all(
        movies.map(async (m) => ({ ...m, tmdb: await tmdbLookup(m.fileName, key, cacheDir, settings, manifestForRender) }))
      )
      const images = tmdbFileCache.localImageIndex(cacheDir)
      const titleOf = (m) => m.tmdb?.title || m.name
      const enriched = enrichedRaw
        .slice()
        .sort((a, b) => titleOf(a).localeCompare(titleOf(b), undefined, { sensitivity: 'base' }))

      const view = url.searchParams.get('view') || 'all'
      const actorParam = url.searchParams.get('actor') || ''
      // Genre category filter (?genre=<tmdb id>) — only ids we can name count
      const genreParamRaw = url.searchParams.get('genre') || ''
      const genreParam = GENRE_NAMES_MOVIE[genreParamRaw] ? genreParamRaw : ''
      const qualityCache = loadQualityCache(cacheDir)
      // A quality badge needs the film's size and mtime, and the movies list
      // (one readdir) has neither. Stat them here without blocking, instead of
      // one statSync per card; a film this could not stat is stat'ed by
      // qualityTierFor as before. An empty (or unusable) quality cache can give
      // no film a badge, so then nothing is stat'ed at all.
      const qualityHasEntries = !!qualityCache && typeof qualityCache === 'object' && Object.keys(qualityCache).length > 0
      const movieStats = new Map()
      if (qualityHasEntries) {
        await Promise.all(movies.map(async (m) => {
          const p = path.join(m.dir, m.fileName)
          try { movieStats.set(p, await fs.promises.stat(p)) } catch {}
        }))
      }
      // Cast for the ℹ️ overlay comes strictly from the on-disk credits cache
      // (credits.json, written by the desktop app's offline prefetch) — one map
      // read per page render, never a network call. Uncached titles just get an
      // overlay with no cast section.
      let movieCreditsMap = {}
      let creditsForRender // the same map, for tmdbCredits; left unset when it could not be read
      try {
        movieCreditsMap = cacheDir ? tmdbFileCache.getCreditsMap(cacheDir) : {}
        if (cacheDir) creditsForRender = movieCreditsMap
      } catch {
        movieCreditsMap = {}
      }
      const castForMovie = (t) => {
        if (!t || t.id == null) return []
        const found = movieCreditsMap[t.id] || movieCreditsMap[String(t.id)] || creditsCache.get(t.id) || []
        return Array.isArray(found) ? found : []
      }
      // Already-cached collections only (collections.json) — powers the 🔗
      // sequels icon on cards without any new lookups; uncached movies simply
      // don't get the icon until the Sequels tab has been visited.
      ensureCollectionsLoaded(cacheDir)
      const recentlyAdded = getRecentlyAddedMap(store)
      const isRecent = (m) => recentlyAdded.has(path.resolve(path.join(m.dir, m.fileName)))
      // 🆕 New is a combined movies-and-TV list now, shared with /tvshows. The
      // tab's count badge is this array's length, so the number on the tab and
      // the cards behind it are the same thing — they used to be counted two
      // different ways, which is how "New (5)" could open onto an empty grid.
      const newItems = collectNewItems(store, allMoviesDirs(), allTvShowsDirs())

      // Same card, toolbar and views as /tvshows (posterCardHtml and the
      // library*Html helpers) — only the subtitle (year) and the 🔗 sequels
      // icon are film-only.
      const movieCard = (m, anchorId) => {
        const t = m.tmdb
        const recent = isRecent(m)
        const qualityPath = path.join(m.dir, m.fileName)
        const collection = t?.id ? movieCollectionCache.get(String(t.id)) : null
        const seqBtn =
          collection && (collection.parts || []).length > 1
            ? `<span class="icon-btn seq-btn" role="button" tabindex="0" style="left:27px;" title="Part of ${escapeHtml(collection.name)} — view all ${collection.parts.length} movies" data-href="/?view=sequels#col-${encodeURIComponent(collection.id)}">🔗</span>`
            : ''
        return posterCardHtml({
          href: `/watch?id=${encodeURIComponent(m.id)}`,
          anchorId,
          dataName: searchNameFor(titleOf(m), m.name),
          title: titleOf(m),
          posterSrc: t ? posterUrl(cacheDir, t.id, t.poster_path, images) : null,
          sub: t?.release_date?.slice(0, 4) || '',
          meta: t,
          genreNames: GENRE_NAMES_MOVIE,
          qualityTier: qualityHasEntries ? qualityTierFor(qualityCache, qualityPath, movieStats.get(qualityPath)) : null,
          isNew: recent,
          extraButtons: seqBtn,
          overlay: { cast: castForMovie(t), castOpts: { cacheDir, actorBase: '/?view=actor&actor=', images } }
        })
      }

      let body = ''

      if (view === 'year') {
        body = libraryYearViewHtml({
          items: enriched,
          dateOf: (m) => m.tmdb?.release_date,
          titleOf,
          cardFor: movieCard,
          emptyText: 'No movies found.'
        })
      } else if (view === 'actor') {
        if (!key) {
          body = '<p class="empty">Add a TMDB key in Settings to browse by actor.</p>'
        } else {
          const withCast = await Promise.all(
            enriched.map(async (m) => ({ item: m, cast: m.tmdb ? await tmdbCredits(m.tmdb.id, key, cacheDir, creditsForRender) : [] }))
          )
          body = libraryActorViewHtml({
            actorHref: '/?view=actor',
            actorParam,
            withCast,
            cardFor: movieCard,
            cacheDir,
            images,
            noneForActorText: 'No movies found.',
            noCastText: 'No cast info found for your library.'
          })
        }
      } else if (view === 'sequels') {
        // Groups the library by TMDB collection (franchise) — every owned part
        // renders as a normal card, and parts NOT in the library render as
        // dimmed "Missing" cards, so gaps in a series are obvious at a glance.
        ensureCollectionsLoaded(cacheDir)
        const matched = enriched.filter((m) => m.tmdb?.id)
        const ownedIds = new Set(matched.map((m) => String(m.tmdb.id)))
        const movieByTmdbId = new Map(matched.map((m) => [String(m.tmdb.id), m]))

        const uncached = matched.filter((m) => !movieCollectionCache.has(String(m.tmdb.id)))
        if (key && uncached.length) {
          const toFetch = uncached.slice(0, TMDB_PAGE_LOOKUP_CAP)
          let fetchedAny = false
          await mapWithConcurrency(toFetch, TMDB_LOOKUP_CONCURRENCY, async (m) => {
            const collection = await fetchMovieCollection(m.tmdb.id, key)
            if (collection !== undefined) {
              // null is a real answer ("not part of any collection") and gets
              // cached too; undefined (fetch failed) is NOT cached so it
              // retries on a later visit.
              movieCollectionCache.set(String(m.tmdb.id), collection)
              fetchedAny = true
            }
          })
          if (fetchedAny && cacheDir) persistJsonMap(collectionsCacheFile(cacheDir), movieCollectionCache)
        }
        const uncheckedCount = matched.filter((m) => !movieCollectionCache.has(String(m.tmdb.id))).length

        // Same grouping and release order as the phone's /api/collections.
        // Only franchises you actually own part of.
        const franchises = collections.groupFranchises(ownedIds, (id) => movieCollectionCache.get(String(id)))

        const missingCard = (p) => {
          const year = p.release_date ? p.release_date.slice(0, 4) : ''
          const posterSrc = posterUrl(cacheDir, p.id, p.poster_path, images)
          const poster = posterSrc
            ? `<img src="${posterSrc}" alt="${escapeHtml(p.title)}" loading="lazy" decoding="async" style="opacity:0.35;filter:grayscale(60%);">`
            : `<div class="noposter">Not in library</div>`
          return `<div class="card" data-name="${escapeHtml(String(p.title || '').toLowerCase())}" style="border:1px dashed #6b2b30;">
            <div style="position:relative;">${poster}
              <div style="position:absolute;top:6px;right:6px;background:#3a1f22;border:1px solid #6b2b30;color:#ff9d9d;font-size:10px;font-weight:800;letter-spacing:0.5px;padding:3px 7px;border-radius:6px;">MISSING</div>
            </div>
            <div class="meta"><div class="title" style="color:#ff9d9d;">${escapeHtml(p.title)}</div><div class="sub">${escapeHtml(year)}</div></div>
          </div>`
        }

        const sections = franchises
          .map((f) => {
            const complete = f.ownedCount === f.parts.length
            const cards = f.parts
              .map((p) => {
                const owned = movieByTmdbId.get(String(p.id))
                return owned ? movieCard(owned) : missingCard(p)
              })
              .join('')
            return `<h3 id="col-${escapeHtml(String(f.id))}" style="margin:24px 0 10px;">${escapeHtml(f.name)}
              <span class="muted" style="font-weight:400;font-size:13px;"> — ${f.ownedCount} / ${f.parts.length} movies${
                complete ? ' · <span style="color:#4caf50;">Complete ✓</span>' : ''
              }</span></h3>
              <div class="grid">${cards}</div>`
          })
          .join('')

        if (!franchises.length) {
          body = `${uncheckedNote(uncheckedCount, !!key)}<p class="empty">${
            uncheckedCount
              ? 'No franchises found yet — check back after more of the library has been looked up.'
              : 'No franchises found — none of your matched movies belong to a TMDB collection.'
          }</p>`
        } else {
          body = `${uncheckedNote(uncheckedCount, !!key)}${sections}`
        }
      } else if (view === 'new') {
        body = newItemsGridHtml(newItems, { cacheDir, qualityCache })
      } else {
        // Genre category chips — only genres actually in the library, with
        // counts, driven by ?genre= (same filter the desktop's genre
        // dropdown applies, rendered as chips under the tab row).
        body = libraryBrowseHtml({
          items: enriched,
          list: genreParam ? enriched.filter((m) => hasGenre(m.tmdb?.genre_ids, genreParam)) : enriched,
          chipsUi: enriched.length
            ? genreFilterUi({
                genreNames: GENRE_NAMES_MOVIE,
                counts: countGenres(enriched.map((m) => m.tmdb)),
                activeGenre: genreParam,
                searchParams: url.searchParams,
                basePath: '/'
              })
            : '',
          searchPlaceholder: 'Search your movies…',
          emptyText: 'No movies found.',
          emptyGenreText: 'No movies found in this genre.',
          titleOf,
          cardFor: movieCard
        })
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(
        page(`
        <div class="topbar">
          <h2 style="margin:0;">Beebo Entertainment</h2>
          <a href="/logout" class="muted" style="color:#8a8f98;">Log out</a>
        </div>
        ${sectionNav('movies', isAdmin, navSecure)}
        ${navTabs(view, newItems.length)}
        ${body}
        ${HEARTBEAT_SCRIPT}
      `)
      )
      return
    }

    if (url.pathname === '/games') {
      // Old games links redirect back to the library.
      res.writeHead(302, { Location: '/' }); res.end(); return
    }

    // BeeboSchool — kid-facing lessons. Reuses the existing /api/school/* backend via a
    // minted API token baked into the page (no backend/auth changes).
    // Photos: timeline, albums and a viewer. The page calls /api/photos/* with a minted token,
    // and every route checks the person's Photos access itself.
    if (url.pathname === '/photos') {
      if (!userId) { res.writeHead(302, { Location: '/login' }); res.end(); return }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' })
      res.end(page(`
        <div class="topbar">
          <h2 style="margin:0;">Beebo Entertainment</h2>
          <a href="/logout" class="muted" style="color:#8a8f98;">Log out</a>
        </div>
        ${sectionNav('photos', isAdmin, navSecure)}
        ${photosApi.photosPageBody({ token: makeApiToken(store, userId) })}
        ${HEARTBEAT_SCRIPT}
      `))
      return
    }

    if (url.pathname === '/school') {
      if (!userId) { res.writeHead(302, { Location: '/login' }); res.end(); return }
      const schoolTok = makeApiToken(store, userId)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(page(`
        <div class="topbar">
          <h2 style="margin:0;">Beebo Entertainment</h2>
          <a href="/logout" class="muted" style="color:#8a8f98;">Log out</a>
        </div>
        ${sectionNav('school', isAdmin, navSecure)}
        ${schoolBody(schoolTok, isAdmin)}
        ${HEARTBEAT_SCRIPT}
      `))
      return
    }

    if (url.pathname === '/tvshows') {
      const tvDirs = allTvShowsDirs()
      const key = store.get('tmdbApiKey') || process.env.TMDB_API_KEY
      const cacheDir = getTmdbCacheDir ? getTmdbCacheDir() : null
      const files = scanTvShowsMulti(tvDirs)

      const showMap = new Map()
      files.forEach((f) => {
        const { show: showName, year } = groupKeyAndName(f.relPath, f.fileName)
        const parsed = parseEpisode(f.fileName)
        const showKey = encodeId(showName.toLowerCase())
        if (!showMap.has(showKey)) showMap.set(showKey, { key: showKey, name: showName, year, episodes: [] })
        showMap
          .get(showKey)
          .episodes.push({ season: parsed.season, episode: parsed.episode, episodeTitle: parsed.episodeTitle, relPath: f.relPath, fileName: f.fileName, dir: f.dir, size: f.size, mtimeMs: f.mtimeMs })
      })

      const showParam = url.searchParams.get('show') || ''
      // `tab` is the documented param for the newer tabs (?tab=missing /
      // ?tab=related); `view` keeps working for the pre-existing ?view=new links.
      const tvView = url.searchParams.get('view') || url.searchParams.get('tab') || 'all'
      // Genre category filter (?genre=<tmdb tv genre id>) — All Shows view only
      // canonicalTvGenreId: an old bookmarked ?genre=10759 (Action & Adventure) now opens Action.
      const genreParamRaw = canonicalTvGenreId(url.searchParams.get('genre') || '')
      const genreParam = GENRE_NAMES_TV[genreParamRaw] ? genreParamRaw : ''
      const qualityCache = loadQualityCache(cacheDir)
      // Cast for the ℹ️ overlay AND the By Actor view, both strictly from the
      // on-disk tv-credits cache (tv-credits.json) — no network fetches for
      // cast from the web path. Read once per render for the whole page.
      let tvCreditsMap = {}
      try {
        tvCreditsMap = cacheDir ? tmdbFileCache.getTvCreditsMap(cacheDir) : {}
      } catch {
        tvCreditsMap = {}
      }
      const castForShow = (meta) => {
        if (!meta || meta.id == null) return []
        const found = tvCreditsMap[meta.id] || tvCreditsMap[String(meta.id)] || []
        return Array.isArray(found) ? found : []
      }
      const recentlyAdded = getRecentlyAddedMap(store)
      const isRecentEp = (ep) => ep.dir && recentlyAdded.has(path.resolve(path.join(ep.dir, ep.relPath)))

      if (showParam && showMap.has(showParam)) {
        const show = showMap.get(showParam)
        const meta = await tmdbLookupTv(show.name, showParam, key, cacheDir, show.year)
        // Real episode NAMES (free, TVmaze) so the web list matches the desktop app
        // ("Ep 2 · Paternity") instead of showing the raw filename. Best-effort/cached.
        let ssrEpNames = {}
        try { ssrEpNames = await tvmazeEpisodeNames(meta?.name || show.name) } catch { ssrEpNames = {} }

        const seasons = new Map()
        show.episodes.forEach((ep) => {
          const seasonKey = ep.season === null ? 'Unsorted' : `Season ${String(ep.season).padStart(2, '0')}`
          if (!seasons.has(seasonKey)) seasons.set(seasonKey, [])
          seasons.get(seasonKey).push(ep)
        })
        const sortedSeasonKeys = Array.from(seasons.keys()).sort((a, b) => {
          if (a === 'Unsorted') return 1
          if (b === 'Unsorted') return -1
          return a.localeCompare(b)
        })
        sortedSeasonKeys.forEach((k) => seasons.get(k).sort((a, b) => (a.episode ?? 999) - (b.episode ?? 999)))

        // The same watched ticks the phone's episode list shows (watchedState.js).
        resolveLegacyShowWatched(userId, show)
        let webWatched = {}
        try { webWatched = watchedState.userFiles(store, userId) } catch {}
        const seasonSections = sortedSeasonKeys
          .map((seasonKey) => {
            const rows = seasons
              .get(seasonKey)
              .map((ep) => {
                // Prefer the real episode name (TVmaze), then any name parsed from the
                // filename, then a cleaned-up filename \u2014 never the raw "...(converted).mp4".
                const epRealName = (ep.season != null && ep.episode != null) ? ssrEpNames[ep.season + "|" + ep.episode] : null
                const epLabel = epRealName || ep.episodeTitle || cleanTitle(ep.fileName)
                // Detected-quality tag for this episode file (omitted when unknown)
                const epTier = ep.dir ? qualityTierFor(qualityCache, path.join(ep.dir, ep.relPath), ep) : null
                const epQuality = epTier
                  ? `<span style="margin-left:10px;flex-shrink:0;font-size:10px;font-weight:800;letter-spacing:0.5px;color:#cfe4ff;background:#22262f;border:1px solid #2a2f3a;padding:2px 6px;border-radius:5px;">${QUALITY_TIER_LABELS[epTier]}</span>`
                  : ''
                return `<a class="card" style="display:flex;align-items:center;padding:10px 14px;text-decoration:none;color:inherit;margin-bottom:6px;"
                  href="/tvwatch?id=${encodeURIComponent(encodeId(ep.relPath))}">
                  <span class="sub" style="min-width:60px;">${ep.episode !== null ? `Ep ${ep.episode}` : '—'}</span>
                  <span class="title" style="flex:1;min-width:0;">${escapeHtml(epLabel)}</span>
                  ${webWatched[watchedState.fileKey('tv', ep.relPath)]?.watched === true ? '<span class="ep-watched" title="Watched" style="margin-left:10px;flex-shrink:0;font-size:12px;font-weight:700;color:#4f9dff;">✓ Watched</span>' : ''}
                  ${epQuality}
                </a>`
              })
              .join('')
            return `<h4 style="font-size:14px;margin:0 0 10px;color:#8a8f98;">${escapeHtml(seasonKey)}</h4>
              <div style="display:flex;flex-direction:column;">${rows}</div>`
          })
          .join('<div style="height:20px;"></div>')

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(
          page(`
          <div class="topbar">
            <h2 style="margin:0;">Beebo Entertainment</h2>
            <a href="/logout" class="muted" style="color:#8a8f98;">Log out</a>
          </div>
          ${sectionNav('tvshows', isAdmin, navSecure)}
          <a href="/tvshows" class="muted" style="color:#4f9dff;">← All shows</a>
          <h3 style="margin:14px 0 4px;">${escapeHtml(meta?.name || show.name)}</h3>
          ${certGenreChipsHtml(meta, GENRE_NAMES_TV, Infinity, 'margin:0 0 10px;')}
          ${meta?.overview ? `<p class="muted" style="max-width:640px;line-height:1.5;margin:0 0 16px;">${escapeHtml(meta.overview)}</p>` : ''}
          ${seasonSections}
          ${HEARTBEAT_SCRIPT}
        `)
        )
        return
      }

      const shows = Array.from(showMap.values()).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
      const images = tmdbFileCache.localImageIndex(cacheDir)

      // Every show with its TMDB meta, sorted by the title the card shows —
      // the same order (and A-Z letters) the Movies page uses for films.
      // Looked up once per render, and only by the views that show cards.
      let showsWithMetaMemo = null
      const titleOfShow = (e) => e.meta?.name || e.name
      const showsWithMeta = async () => {
        if (!showsWithMetaMemo) {
          const list = await Promise.all(shows.map(async (s) => ({ ...s, meta: await tmdbLookupTv(s.name, s.key, key, cacheDir, s.year) })))
          showsWithMetaMemo = list.sort((a, b) => titleOfShow(a).localeCompare(titleOfShow(b), undefined, { sensitivity: 'base' }))
        }
        return showsWithMetaMemo
      }

      // Same card as the Movies page (posterCardHtml); the subtitle counts the
      // episodes you have instead of just the year.
      const showCard = (e, anchorId) => {
        const meta = e.meta
        const year = meta?.first_air_date?.slice(0, 4) || ''
        return posterCardHtml({
          href: `/tvshows?show=${encodeURIComponent(e.key)}`,
          anchorId,
          dataName: searchNameFor(titleOfShow(e), e.name),
          title: titleOfShow(e),
          posterSrc: meta ? tvPosterUrl(cacheDir, meta.id, meta.poster_path) : null,
          sub: `${e.episodes.length} episode${e.episodes.length === 1 ? '' : 's'}${year ? ` · ${year}` : ''}`,
          meta,
          genreNames: GENRE_NAMES_TV,
          // Best detected tier across owned episodes (desktop's "best copy
          // wins" badge); episodes already carry size+mtime from the scan.
          qualityTier: bestQualityTier(
            qualityCache,
            e.episodes.filter((ep) => ep.dir).map((ep) => ({ path: path.join(ep.dir, ep.relPath), mtimeMs: ep.mtimeMs, size: ep.size }))
          ),
          isNew: e.episodes.some(isRecentEp),
          overlay: { cast: castForShow(meta), castOpts: { cacheDir, actorBase: '/tvshows?view=actor&actor=', images } }
        })
      }

      // Identical combined movies-and-TV list to the one the Movies page's New
      // tab renders — same helper, same inputs, same order — so the two New
      // tabs agree on both the cards and the count.
      const newItems = collectNewItems(store, allMoviesDirs(), tvDirs)
      const tabRow = tvNavTabs(tvView, newItems.length)

      let body
      if (tvView === 'year') {
        // Mirrors the movie "By Release Date" view — groups shows by TMDB
        // first_air_date year (cached meta), newest first, unknowns last.
        body = libraryYearViewHtml({
          items: await showsWithMeta(),
          dateOf: (e) => e.meta?.first_air_date,
          titleOf: titleOfShow,
          cardFor: showCard,
          emptyText: 'No TV shows found.'
        })
      } else if (tvView === 'actor') {
        // Mirrors the movie "By Actor" view, but cast comes strictly from the
        // on-disk tv-credits cache (tv-credits.json, written by the desktop
        // app) — no network fetches for cast from the web path.
        body = libraryActorViewHtml({
          actorHref: '/tvshows?view=actor',
          actorParam: url.searchParams.get('actor') || '',
          withCast: (await showsWithMeta()).map((e) => ({ item: e, cast: castForShow(e.meta) })),
          cardFor: showCard,
          cacheDir,
          images,
          noneForActorText: 'No shows found.',
          noCastText: 'No cached cast info for your TV shows yet — browsing shows in the desktop app builds the cast cache this page reads.'
        })
      } else if (tvView === 'new') {
        body = newItemsGridHtml(newItems, { cacheDir, qualityCache })
      } else if (tvView === 'missing') {
        // Compares the episode files on disk against TMDB's per-season episode
        // counts and lists the gaps ("Season 2: missing episodes 4, 7"). Only
        // seasons the user owns at least one episode of are checked.
        ensureTvSeasonsLoaded(cacheDir)
        const withMeta = []
        for (const s of shows) {
          withMeta.push({ s, meta: await tmdbLookupTv(s.name, s.key, key, cacheDir, s.year) })
        }

        const uncachedIds = []
        const seenIds = new Set()
        for (const { meta } of withMeta) {
          if (!meta?.id) continue
          const idKey = String(meta.id)
          if (seenIds.has(idKey)) continue
          seenIds.add(idKey)
          if (!tvSeasonsCache.has(idKey)) uncachedIds.push(meta.id)
        }
        if (key && uncachedIds.length) {
          const toFetch = uncachedIds.slice(0, TMDB_PAGE_LOOKUP_CAP)
          let fetchedAny = false
          await mapWithConcurrency(toFetch, TMDB_LOOKUP_CONCURRENCY, async (tvId) => {
            const seasons = await fetchTvSeasons(tvId, key)
            if (seasons !== undefined) {
              tvSeasonsCache.set(String(tvId), seasons)
              fetchedAny = true
            }
          })
          if (fetchedAny && cacheDir) persistJsonMap(tvSeasonsCacheFile(cacheDir), tvSeasonsCache)
        }

        const gapShows = []
        const completeShows = []
        let uncheckedCount = 0
        let unnumberedCount = 0
        for (const { s, meta } of withMeta) {
          const displayName = meta?.name || s.name
          const seasons = meta?.id ? tvSeasonsCache.get(String(meta.id)) : undefined
          if (!seasons) {
            uncheckedCount++
            continue
          }
          const hasNumbered = s.episodes.some((ep) => ep.season !== null && ep.episode !== null)
          if (!hasNumbered) {
            // no S/E numbers parseable from any filename — nothing to compare
            unnumberedCount++
            continue
          }
          const gaps = computeMissingEpisodes(s.episodes, seasons)
          if (gaps.length) gapShows.push({ s, displayName, gaps })
          else completeShows.push({ s, displayName })
        }
        gapShows.sort((a, b) => a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }))
        completeShows.sort((a, b) => a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }))

        const gapCards = gapShows
          .map(({ s, displayName, gaps }) => {
            const lines = gaps
              .map(
                (g) => `<div style="color:#ff9d9d;">Season ${g.season}: missing episode${g.missing.length === 1 ? '' : 's'} ${g.missing.join(', ')}
                  <span class="muted" style="color:#8a8f98;">(${g.total - g.missing.length} of ${g.total} on hand)</span></div>`
              )
              .join('')
            return `<a class="card" data-name="${escapeHtml(displayName.toLowerCase())}" href="/tvshows?show=${encodeURIComponent(s.key)}" style="padding:14px;margin-bottom:10px;">
              <div class="title" style="font-size:14px;">📺 ${escapeHtml(displayName)}</div>
              <div class="sub" style="margin-top:8px;line-height:1.7;font-size:12px;">${lines}</div>
            </a>`
          })
          .join('')

        const completeSection = completeShows.length
          ? `<h3 style="margin:28px 0 10px;color:#4caf50;">Complete ✓</h3>
            <p class="muted" style="margin:0 0 10px;">Every episode of every owned season is on hand for these shows:</p>
            <div class="card" style="padding:14px;line-height:1.8;font-size:13px;">${completeShows
              .map(({ s, displayName }) => `<a href="/tvshows?show=${encodeURIComponent(s.key)}" style="color:#eee;text-decoration:none;display:inline-block;margin-right:16px;">${escapeHtml(displayName)}</a>`)
              .join('')}</div>`
          : ''

        const notes = []
        if (uncheckedCount) notes.push(uncheckedNote(uncheckedCount, !!key))
        if (unnumberedCount)
          notes.push(
            `<p class="muted" style="margin:0 0 16px;">${unnumberedCount} show${unnumberedCount === 1 ? '' : 's'} skipped — no season/episode numbers in the filenames to compare.</p>`
          )

        body = `${notes.join('')}${
          gapShows.length
            ? `<h3 style="margin:0 0 10px;">Shows with missing episodes</h3><div style="display:flex;flex-direction:column;">${gapCards}</div>`
            : `<p class="empty" style="margin-top:20px;">No gaps found${uncheckedCount ? ' in the shows checked so far' : ''} — nice and tidy.</p>`
        }${completeSection}`
      } else if (tvView === 'related') {
        // Same heuristic as the desktop app's "Related Shows" tab: shows whose
        // titles share a base before a colon or spaced dash get grouped ("Law &
        // Order" / "Law & Order: SVU"). Deliberately not splitting on a bare
        // hyphen so "X-Men"-style titles never get sliced in half.
        const withTitles = (await showsWithMeta()).map((e) => ({ s: e, title: titleOfShow(e) }))
        const byBase = new Map()
        for (const { s, title } of withTitles) {
          const base = title.split(/:|(?:\s[-–]\s)/)[0].trim()
          if (base.length < 3) continue
          const baseKey = base.toLowerCase()
          if (!byBase.has(baseKey)) byBase.set(baseKey, { base, shows: [], titles: new Map() })
          const g = byBase.get(baseKey)
          g.shows.push(s)
          g.titles.set(s.key, title)
        }
        const groups = []
        byBase.forEach((g) => {
          if (g.shows.length < 2) return
          groups.push({
            base: g.base,
            shows: g.shows
              .slice()
              .sort((a, b) => (g.titles.get(a.key) || a.name).localeCompare(g.titles.get(b.key) || b.name, undefined, { sensitivity: 'base' }))
          })
        })
        groups.sort((a, b) => a.base.localeCompare(b.base, undefined, { sensitivity: 'base' }))

        if (groups.length) {
          body = groups
            .map(
              (g) => `<h3 style="margin:24px 0 10px;">🔗 ${escapeHtml(g.base)}
                <span class="muted" style="font-weight:400;font-size:13px;"> — ${g.shows.length} related shows</span></h3>
              <div class="grid">${g.shows.map((e) => showCard(e)).join('')}</div>`
            )
            .join('')
        } else {
          body = '<p class="empty">No related shows found — nothing in the library shares a base title (like "Law & Order" / "Law & Order: SVU").</p>'
        }
      } else {
        // Genre category chips, counted from the same TMDB meta the cards
        // use — exactly how the Movies page counts films.
        const all = shows.length ? await showsWithMeta() : []
        body = libraryBrowseHtml({
          items: all,
          list: genreParam ? all.filter((e) => hasGenre(e.meta?.genre_ids, genreParam)) : all,
          chipsUi: all.length
            ? genreFilterUi({
                genreNames: GENRE_NAMES_TV,
                counts: countGenres(all.map((e) => e.meta)),
                activeGenre: genreParam,
                searchParams: url.searchParams,
                basePath: '/tvshows'
              })
            : '',
          searchPlaceholder: 'Search your TV shows…',
          emptyText: 'No TV shows found.',
          emptyGenreText: 'No TV shows found in this genre.',
          titleOf: titleOfShow,
          cardFor: showCard
        })
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(
        page(`
        <div class="topbar">
          <h2 style="margin:0;">Beebo Entertainment</h2>
          <a href="/logout" class="muted" style="color:#8a8f98;">Log out</a>
        </div>
        ${sectionNav('tvshows', isAdmin, navSecure)}
        ${tabRow}
        ${body}
        ${HEARTBEAT_SCRIPT}
      `)
      )
      return
    }

    if (url.pathname === '/tvwatch') {
      const id = url.searchParams.get('id') || ''
      // Read BEFORE tvWatchProps — that call opens a brand-new session at 0s,
      // and "where you left off" must come from the previous one.
      let resumeRel = ''
      try {
        resumeRel = decodeId(id)
      } catch {
        resumeRel = ''
      }
      const resume = resumeRel ? history.resumeFor(store, userId, resumeRel) : null
      const seekTo = seekParam(url.searchParams.get('t'))
      const props = await tvWatchProps(id, userId)
      // ONE traversal feeds the ⏮ button, the ⏭ button and the Up Next card.
      const { next, previous, context } = neighboursFor('tv', id, userId)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(
        playerPage({
          ...props,
          resume,
          seekTo,
          upNext: next,
          prevItem: previous,
          episodesHref: context && context.showKey ? `/tvshows?show=${encodeURIComponent(context.showKey)}` : '',
          // Handed to the page directly — the player never needs a second
          // round trip just to know where the intro/credits are.
          markers: markersFor('tv', id)
        })
      )
      return
    }

    if (url.pathname === '/tvfile') {
      const id = url.searchParams.get('id') || ''
      let relPath
      try {
        relPath = decodeId(id)
      } catch {
        res.writeHead(400)
        res.end()
        return
      }
      // Every range request - every seek - used to walk the whole TV library right here, on the
      // thread that pumps every other stream. It is now looked up in the library cache (checked
      // against the disk for that one file); only an id the cache does not know, or a file that
      // has gone, waits for a fresh walk on the catalog worker.
      let hungUp = false
      res.once('close', () => { hungUp = true })
      const match = await library.findTvFile(allTvShowsDirs(), relPath)
      // A seek abandons the request it replaces; opening the file for a response that is already
      // gone would hold its handle open.
      if (hungUp) return
      if (!match) {
        res.writeHead(404)
        res.end('Not found')
        return
      }
      if (!serverDashboard.trackStream(req, res, { filePath: path.join(match.dir, match.relPath), kind: 'tv', fileName: match.fileName, relPath: match.relPath, sizeBytes: match.size })) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('The owner stopped this stream.')
        return
      }
      const tvFilePath = path.join(match.dir, match.relPath)
      if (await enforceAwayQualityCap(req, res, {
        kind: 'tv', id, filePath: tvFilePath, statLike: { mtimeMs: match.mtimeMs, size: match.size }, userId,
        license, store, localAccess, playback, qualityCache: loadQualityCache(typeof getTmdbCacheDir === 'function' ? getTmdbCacheDir() : null)
      })) return
      serveVideoFile(req, res, tvFilePath)
      return
    }

    // Serve one sidecar subtitle track as WebVTT. Reached with a media token in the URL (no login
    // cookie) exactly like /tvfile, because ExoPlayer fetches it with no auth header.
    if (url.pathname === '/subtitles/file') {
      const kind = url.searchParams.get('kind') === 'tv' ? 'tv' : 'movie'
      const id = url.searchParams.get('id') || ''
      const i = parseInt(url.searchParams.get('i') || '0', 10) || 0
      const tracks = resolveSubtitleTracks(kind, id, allTvShowsDirs(), allMoviesDirs())
      const t = tracks[i]
      if (!t) { res.writeHead(404); res.end('Not found'); return }
      let text
      try { text = decodeSubtitleBuffer(fs.readFileSync(t.absFile)) } catch { res.writeHead(404); res.end('Not found'); return }
      if (t.ext === 'srt') text = srtToVtt(text)
      else if (!/^\uFEFF?WEBVTT/.test(text)) text = 'WEBVTT\n\n' + text
      const outBuf = Buffer.from(text, 'utf8')
      res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Content-Length': outBuf.length, 'Cache-Control': 'public, max-age=3600' })
      res.end(outBuf)
      return
    }

    // --- "Not Sure What To Watch?" — step 1 (movie or TV) and step 2 (category) ---
    // Zero network calls: the genre counts come only from what's already cached
    // on disk / in memory, so this page is instant and works fully offline.
    if (url.pathname === '/surprise') {
      const kindRaw = url.searchParams.get('kind') || ''
      const kind = kindRaw === 'movie' || kindRaw === 'tv' || kindRaw === 'both' ? kindRaw : ''
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      if (!kind) {
        res.end(surpriseKindPage({ isAdmin }))
        return
      }
      const cacheDir = getTmdbCacheDir ? getTmdbCacheDir() : null
      const genreNames = surfGenreNames(kind)
      const genreRaw = url.searchParams.get('genre') || ''
      const genre = genreNames[genreRaw] ? genreRaw : ''
      const year = normalizeYearParam(url.searchParams.get('year'))
      const decade = year === null ? normalizeDecadeParam(url.searchParams.get('decade')) : null
      const all = surfCandidates(kind, { movieDirs: allMoviesDirs(), tvDirs: allTvShowsDirs(), cacheDir })
      // Each chip row counts the pool WITHOUT its own filter applied, so the
      // genre counts respect the chosen year and the year counts respect the
      // chosen genre — the number on a chip is what clicking it really gives.
      const forGenres = surfFilterPool(kind, all, { year, decade })
      const forYears = surfFilterPool(kind, all, { genre })
      const selected = surfFilterPool(kind, all, { genre, year, decade })
      res.end(
        surpriseGenrePage({
          isAdmin,
          kind,
          genre,
          year,
          decade,
          counts: countGenres(forGenres.map((c) => c.meta)),
          yearSummary: surfYearSummary(kind, forYears),
          total: selected.length,
          // One seed per category pick, carried in the link — that's what makes
          // the whole Back/Next surf session keep a consistent running order.
          // Minted here but only ever spent by the "Start surfing" links; the
          // filter-refining links stay seedless and stateless.
          seed: freshSeed()
        })
      )
      return
    }

    // --- step 3: play a random pick, halfway in ---
    if (url.pathname === '/surprise/play') {
      const kindRaw = url.searchParams.get('kind') || ''
      const kind = surfKindParam(kindRaw)
      const genreNames = surfGenreNames(kind)
      const genreRaw = url.searchParams.get('genre') || ''
      const genre = genreNames[genreRaw] ? genreRaw : ''
      const year = normalizeYearParam(url.searchParams.get('year'))
      const decade = year === null ? normalizeDecadeParam(url.searchParams.get('decade')) : null
      const seed = normalizeSeed(url.searchParams.get('seed'))
      const cacheDir = getTmdbCacheDir ? getTmdbCacheDir() : null
      const filterLabel = surfFilterLabel(kind, { genre, year, decade })
      // Filters ride along in every surf link so ⏮/⏭/🎲 stay inside the pool
      // the viewer picked; the picker link deliberately drops the seed so
      // going back to the chips mints a fresh running order.
      const filterParams = () => {
        const p = new URLSearchParams()
        p.set('kind', kind)
        p.set('genre', genre)
        if (year !== null) p.set('year', String(year))
        else if (decade !== null) p.set('decade', String(decade))
        return p
      }
      const pickerParams = new URLSearchParams(filterParams())
      if (!genre) pickerParams.delete('genre')

      const all = surfCandidates(kind, { movieDirs: allMoviesDirs(), tvDirs: allTvShowsDirs(), cacheDir })
      const pool = surfFilterPool(kind, all, { genre, year, decade })

      if (!pool.length) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(
          surpriseEmptyPage({
            isAdmin,
            kind,
            genreName: genre ? genreNames[genre] : '',
            filterLabel,
            backHref: `/surprise?${pickerParams.toString()}`
          })
        )
        return
      }

      // Stable order in, seeded shuffle, then index — so ⏮/⏭ are just i±1 and
      // the same seed+i always lands on the same title, with no state kept here.
      const shuffled = seededShuffle(pool, seed)
      const total = shuffled.length
      const iRaw = Number(url.searchParams.get('i'))
      const i = ((Number.isFinite(iRaw) ? Math.floor(iRaw) : 0) % total + total) % total
      const pick = shuffled[i]

      const surfHref = (idx) => {
        const p = filterParams()
        p.set('seed', String(seed))
        p.set('i', String(((idx % total) + total) % total))
        return `/surprise/play?${p.toString()}`
      }
      // In a mixed pool the item itself decides which watch props / restart
      // link it gets — that's the whole point of tagging candidates with kind.
      const pickKind = surfKindOf(kind, pick)
      // Provisional: scrolling past a pick must leave NO history row. Only
      // ▶ Start from the beginning (a plain /watch|/tvwatch open below) or
      // >5 minutes of real playback turns this into a logged session.
      const props =
        pickKind === 'tv'
          ? await tvWatchProps(pick.id, userId, { provisional: true })
          : await movieWatchProps(pick.id, userId, { provisional: true })

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(
        playerPage({
          ...props,
          startFraction: 0.5,
          surf: {
            backHref: surfHref(i - 1),
            nextHref: surfHref(i + 1),
            restartHref: `${pickKind === 'tv' ? '/tvwatch' : '/watch'}?id=${encodeURIComponent(pick.id)}`,
            pickerHref: `/surprise?${pickerParams.toString()}`,
            position: i + 1,
            total,
            filterLabel
          }
        })
      )
      return
    }

    if (url.pathname === '/watch') {
      const id = url.searchParams.get('id') || ''
      // Same ordering as /tvwatch: resume position first, new session second.
      let resumeName = ''
      try {
        resumeName = decodeId(id)
      } catch {
        resumeName = ''
      }
      const resume = resumeName ? history.resumeFor(store, userId, resumeName) : null
      const seekTo = seekParam(url.searchParams.get('t'))
      const props = await movieWatchProps(id, userId)
      const { next, previous } = neighboursFor('movie', id, userId)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(playerPage({ ...props, resume, seekTo, upNext: next, prevItem: previous, markers: markersFor('movie', id) }))
      return
    }

    if (url.pathname === '/flag-unplayable' && req.method === 'POST') {
      // Sent by the player page when the <video> element errors (browser
      // can't decode the format). Resolves the id to the real file path the
      // same way /file and /tvfile do, then queues an automatic conversion.
      // Always answers 204 — a malformed/unknown flag is just dropped, this
      // must never crash or leak anything back to the page.
      let body = {}
      try {
        const chunks = []
        for await (const chunk of cappedBody(req)) chunks.push(chunk)
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      } catch {
        body = {}
      }
      try {
        const kind = body.kind === 'tv' ? 'tv' : 'movie'
        let decoded = ''
        try {
          decoded = decodeId(String(body.id || ''))
        } catch {
          decoded = ''
        }
        let filePath = null
        if (decoded && kind === 'tv') {
          const files = scanTvShowsMulti(allTvShowsDirs())
          const match = files.find((f) => f.relPath === decoded)
          if (match) filePath = path.join(match.dir, match.relPath)
        } else if (decoded) {
          const movies = scanMoviesMulti(allMoviesDirs())
          const movie = movies.find((m) => m.fileName === decoded)
          if (movie) filePath = path.join(movie.dir, movie.fileName)
        }
        if (filePath) {
          // Two kinds of report arrive here. A 'playback_error' means the
          // browser genuinely couldn't decode the file — always worth
          // converting. A 'cast_unavailable' report fires whenever no cast
          // device was offered, which also happens when nobody's near a TV, so
          // it only counts for containers that can't be cast in the first
          // place; an .mp4 that simply had no TV around is ignored.
          //
          // A 'playback_error' is real evidence: it is queued at the front with the strict
          // (every-device) target. A 'cast_unavailable' is not evidence of anything, so it only
          // queues a file the rules say needs work and that has not already played fine.
          const reason = body.reason === 'cast_unavailable' ? 'cast_unavailable' : 'playback_error'
          const ext = path.extname(filePath).toLowerCase()
          if (reason === 'cast_unavailable') {
            const decision = convert.decideFor(await convert.probeStreams(filePath), ext)
            if (convert.shouldAutoQueue(decision, convert.knownGood(store, filePath))) {
              const result = convert.enqueue(store, { path: filePath, kind, castAvailable: body.castAvailable === true, decision })
              if (result.ok && !result.deduped) log(`flagged for conversion (${kind}, reason=${reason}): ${filePath}`)
            }
          } else {
            const decision = convert.decideFor(await convert.probeStreams(filePath), ext, { strict: true })
            const result = convert.enqueue(store, { path: filePath, kind, castAvailable: body.castAvailable === true, deviceFailure: true, decision })
            if (result.ok && !result.deduped) log(`flagged for conversion (${kind}, reason=${reason}, castAvailable=${body.castAvailable === true}): ${filePath}`)
          }
        }
      } catch (err) {
        log(`flag-unplayable failed: ${err}`)
      }
      res.writeHead(204)
      res.end()
      return
    }

    if (url.pathname === '/flag-quality' && req.method === 'POST') {
      // Sent by the player page's "⚠️ Bad quality" button. Resolves the id to
      // the real file path the same way /file and /tvfile do, then records it
      // in the 'qualityFlags' list the desktop Flags tab shows. Always answers
      // 204 — a malformed/unknown flag is just dropped, this must never crash
      // or leak anything back to the page.
      let body = {}
      try {
        const chunks = []
        for await (const chunk of cappedBody(req)) chunks.push(chunk)
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      } catch {
        body = {}
      }
      try {
        const kind = body.kind === 'tv' ? 'tv' : 'movie'
        // id -> real file path + display title, shared verbatim with the phone
        // app's POST /api/flag-quality so both write identical flag entries.
        const { decoded, filePath, title } = await resolveFlagTarget(kind, body.id)
        if (filePath) {
          const result = recordQualityFlag(store, {
            kind,
            filePath,
            fileName: decoded,
            relPath: decoded,
            title,
            userId,
            userName: currentUser?.name || 'Unknown'
          })
          if (result.ok && !result.deduped) log(`flagged bad quality (${kind}) by ${currentUser?.name || userId}: ${filePath}`)
        }
      } catch (err) {
        log(`flag-quality failed: ${err}`)
      }
      res.writeHead(204)
      res.end()
      return
    }

    // --- feature suggestions: users tell the owner what they wish Beebo had --
    // Accepts {text, name?}. Attributes to the signed-in user when known.
    // Always answers JSON; never throws.
    if (url.pathname === '/api/suggestions' && req.method === 'POST') {
      let body = {}
      try {
        const chunks = []
        for await (const chunk of cappedBody(req)) chunks.push(chunk)
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      } catch { body = {} }
      let id = ''
      try {
        const text = String(body.text || '').trim().slice(0, 2000)
        if (text) {
          id = 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
          const list = store.get('featureSuggestions') || []
          list.unshift({
            id,
            text,
            userId: (typeof userId !== 'undefined' && userId) ? userId : '',
            userName: (currentUser && currentUser.name) || String(body.name || '').trim().slice(0, 80) || 'Someone',
            createdAt: Date.now(),
            status: 'new'
          })
          store.set('featureSuggestions', list.slice(0, 500)) // keep newest 500
          log(`feature suggestion from ${(currentUser && currentUser.name) || 'someone'}`)
        }
      } catch (err) { log(`suggestion save failed: ${err}`) }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: !!id, id }))
      return
    }

    // A tiny standalone page so people can leave a suggestion from a browser.
    if (url.pathname === '/suggest' && req.method === 'GET') {
      const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Suggest a feature</title>
<style>
:root{color-scheme:dark}
body{font-family:system-ui,"Segoe UI",Roboto,sans-serif;background:#1c1710;color:#f3e8d4;margin:0;padding:32px;display:flex;justify-content:center}
main{max-width:560px;width:100%}
.bee{font-size:44px}
h1{font-size:1.5rem;margin:.2em 0}
p{color:#c9bfa8;line-height:1.5}
input,textarea{width:100%;border-radius:12px;border:1px solid #4a3f2a;background:#26201a;color:#f3e8d4;padding:12px;font-size:16px;box-sizing:border-box}
input{margin-bottom:10px}
textarea{min-height:150px;resize:vertical}
button{margin-top:14px;background:#f2a900;color:#241700;border:0;border-radius:22px;padding:13px 24px;font-size:16px;font-weight:700;cursor:pointer}
.ok{color:#8bc06a;font-weight:600;margin-top:16px}
.err{color:#e98a80;margin-top:16px}
</style></head><body><main>
<div class="bee">🐝</div>
<h1>Tell us what you wish Beebo had</h1>
<p>Got an idea for a feature or something you wish worked differently? Type it below — the grown-up who runs Beebo will see it.</p>
<input id="name" placeholder="Your name (optional)" maxlength="80">
<textarea id="text" placeholder="I wish Beebo could…" maxlength="2000"></textarea>
<button id="go">Send my idea</button>
<div id="msg"></div>
<script>
document.getElementById('go').addEventListener('click',function(){
  var t=document.getElementById('text').value.trim();
  var m=document.getElementById('msg');
  if(!t){m.className='err';m.textContent='Please type an idea first.';return}
  var n=document.getElementById('name').value.trim();
  fetch('/api/suggestions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:t,name:n})})
   .then(function(r){return r.json()})
   .then(function(d){if(d&&d.ok){m.className='ok';m.textContent='Thank you! Your idea was sent. 💛';document.getElementById('text').value=''}else{m.className='err';m.textContent='Hmm, that did not send. Please try again.'}})
   .catch(function(){m.className='err';m.textContent='Something went wrong — please try again.'});
});
</script>
</main></body></html>`
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(html)
      return
    }

    // --- missing-file request (the player's Up Next card) -------------------
    // Sent when Up Next finds a next episode / next collection part that TMDB
    // knows about but the library hasn't got. Mirrors /flag-quality exactly:
    // always 204, never throws, nothing leaked back to the page.
    if (url.pathname === '/missing-request' && req.method === 'POST') {
      let body = {}
      try {
        const chunks = []
        for await (const chunk of cappedBody(req)) chunks.push(chunk)
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      } catch {
        body = {}
      }
      try {
        recordMissingRequest(store, {
          kind: body.kind === 'tv' ? 'tv' : 'movie',
          showName: body.showName,
          season: body.season,
          episode: body.episode,
          title: body.title,
          tmdbId: body.tmdbId,
          year: body.year,
          collectionName: body.collectionName,
          userId,
          userName: currentUser?.name || 'Unknown'
        })
      } catch (err) {
        log(`missing-request failed: ${err}`)
      }
      res.writeHead(204)
      res.end()
      return
    }

    // --- viewer-set playback markers ("credits start here" / "intro ends here")
    // Same always-204, never-throws contract as /flag-quality and
    // /missing-request. The id is resolved to a show/movie key server-side.
    if (url.pathname === '/markers' && req.method === 'POST') {
      let body = {}
      try {
        const chunks = []
        for await (const chunk of cappedBody(req)) chunks.push(chunk)
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      } catch {
        body = {}
      }
      try {
        applyMarkerWrite(body, currentUser ? { id: userId, name: currentUser.name } : { id: userId, name: 'Unknown' })
      } catch (err) {
        log(`marker write failed: ${err}`)
      }
      res.writeHead(204)
      res.end()
      return
    }

    // --- history removal (Continue Watching's ✕ / 🗑 / Clear all) -----------
    if (url.pathname === '/history/clear' && req.method === 'POST') {
      let body = {}
      try {
        const chunks = []
        for await (const chunk of cappedBody(req)) chunks.push(chunk)
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      } catch {
        body = {}
      }
      try {
        applyHistoryClear(userId, body)
      } catch (err) {
        log(`history clear failed: ${err}`)
      }
      res.writeHead(204)
      res.end()
      return
    }

    // The website twin of POST /api/library/clear (cookie session, own data only).
    if (url.pathname === '/library/clear' && req.method === 'POST') {
      // JSON only: a cross-site form cannot send this content type without a
      // CORS preflight, which this server never answers.
      if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) {
        res.writeHead(415)
        res.end()
        return
      }
      let body = {}
      try {
        const chunks = []
        for await (const chunk of cappedBody(req)) chunks.push(chunk)
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      } catch {
        body = {}
      }
      let removed = 0
      try {
        removed = libraryClear.clear(store, userId, String((body && body.what) || ''))
      } catch (err) {
        log(`library clear failed: ${err}`)
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, removed }))
      return
    }

    // --- 🎵 Playlists ----------------------------------------------------------
    // The page, and /playlists/api/* - the cookie-session twin of /api/playlists/*.
    // Writes must be JSON: a cross-site form cannot send that without a CORS
    // preflight, which this server never answers.
    // Registered route modules, cookie-session side (/appearance/prefs...).
    if (await routeRegistry.dispatchWeb({ req, res, url, store, userId, currentUser, readBody: readJsonBody, crossSite: backup.isCrossSiteRequest })) return

    // Appearance: this person's theme (electron/theme.js, electron/themeWeb.js). Cookie-session twin of /api/theme.
    if (url.pathname === '/appearance' || url.pathname === '/appearance/reset') {
      if (await themeWeb.handleWeb({ req, res, url, store, userId, currentUser, page, nav: () => sectionNav('appearance', isAdmin, navSecure), readBody: readJsonBody, crossSite: backup.isCrossSiteRequest })) return
    }

    if (url.pathname === '/viewing-privacy') {
      if (!currentUser) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, message: 'Sign in to your own profile first.' })); return }
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(page(`${sectionNav('privacy', isAdmin, navSecure)}${viewingPrivacyWeb.pageBody(viewingPrivacy.status(store, userId))}`))
        return
      }
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
      if (!/^application\/json\b/i.test(String(req.headers['content-type'] || '')) || backup.isCrossSiteRequest(req.headers)) {
        req.resume(); res.writeHead(415, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, message: 'Use the privacy form in Beebo.' })); return
      }
      const out = saveViewingPrivacy(req, currentUser, await readJsonBody(req, 8192))
      const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
      if (out.body.ok) headers['Set-Cookie'] = sessionCookieHeader(req, auth.signSession(store, userId))
      res.writeHead(out.status, headers); res.end(JSON.stringify(out.body)); return
    }

    // "My API keys": anyone signed in makes and removes their own keys (electron/apiKeysWeb.js).
    // The same rules as /api/me/api-keys/*, so the two can never disagree about what a person may hold.
    if (url.pathname === '/my-api-keys') {
      if (!currentUser) { res.writeHead(302, { Location: '/login' }); res.end(); return }
      const restricted = parental.isRestricted(parental.getPolicy(store, userId))
      const secure = adminRequestIsSecure(req)
      const cap = currentUser.isAdmin ? apiKeys.MAX_KEYS : apiKeys.MAX_KEYS_MEMBER
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(page(`${sectionNav('apikeys', isAdmin, navSecure)}${apiKeysWeb.pageBody({
          keys: restricted ? [] : apiKeys.list(store, { ownerUserId: userId }),
          scopes: apiKeys.scopesFor(currentUser),
          maxKeys: cap,
          defaultRatePerMinute: apiKeys.DEFAULT_RATE_PER_MINUTE,
          rateMin: apiKeys.RATE_MIN,
          rateMax: apiKeys.RATE_MAX,
          secure,
          restricted
        })}`))
        return
      }
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
      const reply = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)) }
      if (!/^application\/json\b/i.test(String(req.headers['content-type'] || '')) || backup.isCrossSiteRequest(req.headers)) {
        req.resume(); reply(415, { ok: false, message: 'Use the form on the API keys page.' }); return
      }
      if (restricted) { req.resume(); reply(403, { ok: false, error: 'not_available', message: apiKeysWeb.MESSAGES.not_available }); return }
      if (!secure) { req.resume(); reply(403, { ok: false, error: 'https_required', message: apiKeysWeb.MESSAGES.https_required }); return }
      const body = await readJsonBody(req, 8192)
      const fail = (out) => reply(out.error === 'not_found' ? 404 : 400, { ok: false, error: out.error, message: apiKeysWeb.MESSAGES[out.error] || 'That did not work.' })
      if (body && body.action === 'create') {
        const out = apiKeys.create(store, {
          name: body.name,
          scopes: Array.isArray(body.scopes) ? body.scopes : undefined,
          ratePerMinute: body.ratePerMinute,
          ownerUserId: userId,
          allowedScopes: apiKeys.scopesFor(currentUser),
          maxForOwner: cap
        })
        if (!out.ok) { fail(out); return }
        log(`API key "${out.key.name}" created by ${currentUser.name || currentUser.username || 'a member'}`)
        reply(200, { ok: true, key: out.key, token: out.token })
        return
      }
      if (body && body.action === 'revoke') {
        const out = apiKeys.revoke(store, String(body.id === undefined || body.id === null ? '' : body.id).trim(), { ownerUserId: userId })
        if (!out.ok) { fail(out); return }
        log(`API key "${out.key.name}" removed by its owner`)
        reply(200, { ok: true, key: out.key })
        return
      }
      reply(400, { ok: false, error: 'bad_request', message: 'That did not work.' })
      return
    }

    if (url.pathname === '/playlists' && req.method === 'GET') {
      // Signed in only: every list on this page is one person's own.
      if (!currentUser) { res.writeHead(302, { Location: '/login' }); res.end(); return }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(page(`${sectionNav('playlists', isAdmin, navSecure)}${playlistWeb.pageBody()}${HEARTBEAT_SCRIPT}`))
      return
    }
    if (url.pathname === '/playlists/api' || url.pathname.startsWith('/playlists/api/')) {
      const method = String(req.method || 'GET').toUpperCase()
      let body = {}
      if (method === 'POST' || method === 'DELETE') {
        if (!/^application\/json\b/i.test(String(req.headers['content-type'] || '')) || backup.isCrossSiteRequest(req.headers)) {
          req.resume()
          res.writeHead(415, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'json_only' }))
          return
        }
        body = await readJsonBody(req, 256 * 1024)
      }
      if (!currentUser) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'unauthorized' }))
        return
      }
      await primeLibrary('both')
      const sub = url.pathname.replace(/\/+$/, '').slice('/playlists/api'.length)
      const out = playlistHandle(method, sub, url.searchParams, body, currentUser)
      res.writeHead(out.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(out.body))
      return
    }

    // --- ▶ Continue Watching -------------------------------------------------
    if (url.pathname === '/continue') {
      const rows = decorateHistoryRows(continueRowsFor(userId))
      const clearCounts = libraryClear.counts(store, userId)
      const cards = rows
        .map((r) => {
          const posterHtml = r.poster
            ? `<img src="${escapeHtml(r.poster)}" alt="${escapeHtml(r.title)}" loading="lazy" decoding="async"
                 style="width:64px;height:96px;object-fit:cover;border-radius:6px;background:#22262f;flex-shrink:0;">`
            : `<div style="width:64px;height:96px;border-radius:6px;background:#22262f;color:#555;font-size:10px;
                 display:flex;align-items:center;justify-content:center;text-align:center;flex-shrink:0;">No poster</div>`
          const leftSeconds = Math.max(0, r.duration - r.currentTime)
          const leftMinutes = Math.max(1, Math.round(leftSeconds / 60))
          const groupTitle = r.kind === 'tv' ? r.title.split(' — ')[0] : r.title
          const resumeHref = `${r.watchHref}&t=${encodeURIComponent(Math.floor(r.currentTime))}`
          return `<div class="card cw-row" style="display:flex;gap:12px;align-items:center;padding:12px;margin-bottom:10px;">
            ${posterHtml}
            <div style="flex:1;min-width:0;">
              <div class="title" style="font-size:15px;">${escapeHtml(r.title)}</div>
              ${r.upNext && !(r.currentTime > 0)
                ? '<div class="sub" style="margin-top:6px;">Up next</div>'
                : `<div style="height:6px;border-radius:99px;background:#2a2f3a;margin:8px 0 6px;overflow:hidden;">
                <div style="height:100%;width:${r.percent}%;background:#4f9dff;"></div>
              </div>
              <div class="sub">${r.percent}% · ${leftMinutes} min left</div>`}
              <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px;">
                <a class="btn" style="padding:7px 12px;font-size:13px;" href="${escapeHtml(r.upNext && !(r.currentTime > 0) ? r.watchHref : resumeHref)}">▶ ${r.upNext && !(r.currentTime > 0) ? 'Play' : 'Resume'}</a>
                <button type="button" class="btn btn-secondary hist-clear" style="padding:7px 12px;font-size:13px;"
                  data-scope="one" data-file="${escapeHtml(r.fileName)}">✕ Remove</button>
                <button type="button" class="btn btn-secondary hist-clear" style="padding:7px 12px;font-size:13px;"
                  data-scope="show" data-title="${escapeHtml(groupTitle)}">🗑 Remove all for this ${r.kind === 'tv' ? 'show' : 'title'}</button>
              </div>
            </div>
          </div>`
        })
        .join('')

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(
        page(`
        <div class="topbar">
          <h2 style="margin:0;">Beebo Entertainment</h2>
          <a href="/logout" class="muted" style="color:#8a8f98;">Log out</a>
        </div>
        ${sectionNav('continue', isAdmin, navSecure)}
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:16px;">
          <h3 style="margin:0;">▶ Continue Watching</h3>
        </div>
        ${rows.length ? cards : '<p class="empty">Nothing part-watched yet — anything you stop partway through shows up here.</p>'}
        <div class="card" style="padding:12px;margin-top:18px;">
          <div class="title" style="font-size:14px;margin-bottom:8px;">Clear my library</div>
          <div style="display:flex;gap:10px;flex-wrap:wrap;">
            ${[
              ['history', 'Clear watch history', clearCounts.history, 'title', 'from your watch history (resume points go too; favourites, watchlist and watched marks stay)'],
              ['favourites', 'Clear favourites', clearCounts.favourites, 'favourite', 'from your favourites'],
              ['watchlist', 'Clear watchlist', clearCounts.watchlist, 'title', 'from your watchlist'],
              ['watched', 'Clear watched marks', clearCounts.watched, 'watched mark', '(your watch history stays)']
            ].map(([what, label, n, noun, tail]) => `<button type="button" class="btn btn-secondary lib-clear" data-what="${what}"
              data-confirm="${escapeHtml(`Remove ${n} ${noun}${n === 1 ? '' : 's'} ${tail}? This can't be undone.`)}"
              style="padding:7px 12px;font-size:13px;" ${n ? '' : 'disabled'}>${label} (${n})</button>`).join('')}
          </div>
        </div>
        <script>
          document.addEventListener('click', (e) => {
            const btn = e.target && e.target.closest ? e.target.closest('.lib-clear') : null
            if (!btn) return
            e.preventDefault()
            if (!confirm(btn.dataset.confirm)) return
            btn.disabled = true
            fetch('/library/clear', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ what: btn.dataset.what })
            }).then(() => { location.reload() }).catch(() => { btn.disabled = false })
          })
          // One delegated handler for ✕ Remove / 🗑 Remove all
          document.addEventListener('click', (e) => {
            const btn = e.target && e.target.closest ? e.target.closest('.hist-clear') : null
            if (!btn) return
            e.preventDefault()
            const scope = btn.dataset.scope
            if (scope === 'all' && !confirm('Clear your entire viewing history?')) return
            btn.disabled = true
            fetch('/history/clear', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ scope: scope, fileName: btn.dataset.file || '', title: btn.dataset.title || '' })
            }).then(() => { location.reload() }).catch(() => { btn.disabled = false })
          })
        </script>
        ${HEARTBEAT_SCRIPT}
      `)
      )
      return
    }

    if (url.pathname === '/progress' && req.method === 'POST') {
      let body = {}
      try {
        const chunks = []
        for await (const chunk of cappedBody(req)) chunks.push(chunk)
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      } catch {
        body = {}
      }
      if (!ownsWatchSession(userId, body.sessionId)) { res.writeHead(404); res.end(); return }
      try { if (body && body.sessionId) serverDashboard.noteSession(req, String(body.sessionId)) } catch {}
      history.updateSession(store, body.sessionId, { currentTime: body.currentTime, duration: body.duration, state: playerState(body) })
      res.writeHead(204)
      res.end()
      return
    }

    if (url.pathname === '/file') {
      const id = url.searchParams.get('id') || ''
      let fileName
      try {
        fileName = decodeId(id)
      } catch {
        res.writeHead(400)
        res.end()
        return
      }
      // Same as /tvfile: looked up in the library cache, never walked on the streaming thread.
      let hungUp = false
      res.once('close', () => { hungUp = true })
      const movie = await library.findMovie(allMoviesDirs(), fileName)
      if (hungUp) return
      if (!movie) {
        res.writeHead(404)
        res.end('Not found')
        return
      }
      // The dashboard counts the bytes; a stream the owner stopped is refused for a few minutes.
      if (!serverDashboard.trackStream(req, res, { filePath: path.join(movie.dir, movie.fileName), kind: 'movie', fileName: movie.fileName, sizeBytes: movie.size })) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('The owner stopped this stream.')
        return
      }
      const movieFilePath = path.join(movie.dir, movie.fileName)
      if (await enforceAwayQualityCap(req, res, {
        kind: 'movie', id, filePath: movieFilePath, statLike: { mtimeMs: movie.mtimeMs, size: movie.size }, userId,
        license, store, localAccess, playback, qualityCache: loadQualityCache(typeof getTmdbCacheDir === 'function' ? getTmdbCacheDir() : null)
      })) return
      serveVideoFile(req, res, movieFilePath)
      return
    }

    res.writeHead(404)
    res.end('Not found')
  }
  const requestHandler = (req, res) => library.run(String(req.url || '').split('?')[0].slice(0, 120),
    () => contentGate.runWithScope(contentGateInstance, () => theme.runWithScope(() => handleRequest(req, res))))

  // --- timeouts ---
  // A large upload is ONE http request that legitimately stays open for
  // hours: a 40GB remux over a home uplink is not a stalled connection, it is
  // a working one. Node's default server.requestTimeout is 5 minutes, so it
  // was destroying the socket mid-body and the browser reported it as
  // "network error" — which is exactly what killed the 1GB episodes at ~40%.
  // Both of these only bound how long a request may TAKE; every route still
  // writes its response and closes normally, and streaming reads (/file,
  // /tvfile range requests) can only benefit from not being cut off. The
  // headers timeout deliberately stays finite, so a client that opens a
  // socket and never finishes sending its request line is still dropped.
  function applyTimeouts(srv) {
    srv.requestTimeout = 0 // no cap on how long a request body may take
    srv.timeout = 0 // no per-socket inactivity kill
    srv.headersTimeout = 120000 // but headers must arrive within 2 minutes
  }

  // =====================================================================
  // ONE PORT, BOTH PROTOCOLS
  // =====================================================================
  //
  // Port 47811 has been plain HTTP since day one. It is baked into router
  // port-forwards, browser bookmarks, the DuckDNS link, the Windows viewer,
  // the Chromecast's media URLs, and — worst of all to change — the base URL
  // the Android app has already saved on every family member's phone. Moving
  // HTTPS to a second port (or swapping this one over to HTTPS outright)
  // would break all of that at once.
  //
  // So we don't choose. We accept the raw TCP connection ourselves, look at
  // its very first byte, and hand the socket to whichever server it wanted:
  //
  //   0x16  = the TLS ContentType for "handshake" -> the https.Server
  //   'G','P','H'… (anything else) -> the plain http.Server
  //
  // The byte is pushed back onto the stream first, so the server that gets
  // the socket sees an untouched connection and behaves exactly as if it had
  // accepted it directly. Range requests, chunked uploads, media-token URLs
  // and the Chromecast path are all just ordinary requests to whichever
  // server ends up holding the socket, so they work identically over both.
  //
  // SAFETY: `tlsState.active` is the single switch. It is only ever true when
  // an https.Server exists AND its secure context was built without throwing.
  // Every path that could fail — no cert, unreadable cert, garbage PEM,
  // mismatched key, setSecureContext throwing — leaves it false, which means
  // the plain http.Server serves every request exactly as it does today.
  const tlsState = {
    active: false,
    server: null,
    reason: 'no certificate yet',
    expiresAt: null
  }

  const logLine = typeof log === 'function' ? log : () => {}

  const certDirFor = () => {
    try {
      if (typeof getCertDir === 'function') return getCertDir() || ''
      return getCertDir || ''
    } catch {
      return ''
    }
  }

  // Loaded defensively, same as busboy above: a missing/broken certs.js must
  // cost us HTTPS, never the server.
  let certs = null
  try {
    certs = require('./certs')
  } catch (err) {
    tlsState.reason = `certificate module unavailable: ${err.message}`
  }

  const httpServer = http.createServer((req, res) => {
    // --- the plain-HTTP side ---
    // With a certificate live, every plain request is bounced to the exact
    // same URL over https. 308 and not 301/302 on purpose: 301/302 let a
    // client turn a POST into a GET and drop the body, which would silently
    // break the Android app's POSTs, the website's uploads and /progress
    // reports — a redirect that "works" in a browser and quietly corrupts
    // everything else. 308 says "same method, same body, new address".
    //
    // With no certificate this branch is skipped entirely and the request is
    // served normally, which is the behaviour every existing client has
    // always seen.
    if (tlsState.active) {
      try {
        // Host carries the port already (e.g. "example-house.duckdns.org:47811"),
        // which is what we want — same port, different scheme. An HTTP/1.0
        // client with no Host header falls back to the configured domain, and
        // if there isn't one either we simply serve the request.
        const fallbackDomain = certDomainFor()
        const host = req.headers.host || (fallbackDomain ? `${fallbackDomain}:${PORT}` : '')
        // Loopback requests (the desktop app fetching its own posters / media / video
        // over http://localhost or http://127.0.0.1) must NOT be bounced to https: the
        // certificate is for the public domain, so https://localhost fails to validate
        // and the image or stream never loads. Same-machine traffic is served over plain
        // http instead. Admin still requires TLS via its own req.socket.encrypted gate,
        // so this never exposes admin data over http.
        const hostname = (host.split(':')[0] || '').toLowerCase()
        const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'
        // Nor bounce private-LAN clients: the certificate is for the public domain, so https to a
        // bare LAN IP (192.168.x, 10.x, 172.16-31.x, 169.254.x) can never validate — the phone would
        // hit a dead TLS port and fail with "unable to parse TLS packet header". LAN clients that
        // reach the server by IP are served over plain http; only real domain-name requests are
        // redirected to https. Admin still requires TLS via its own req.socket.encrypted gate.
        // Tailscale addresses (100.64.0.0/10) are in the same position: no public certificate can
        // name them, and the tunnel is already encrypted.
        const isPrivateLan = /^10\./.test(hostname) || /^192\.168\./.test(hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) || /^169\.254\./.test(hostname) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(hostname)
        // A reverse proxy (Cloudflare tunnel / Caddy) that already terminated TLS tells us so with
        // X-Forwarded-Proto: https. Don't 308 those to https: the client's leg to the proxy is already
        // secure, and redirecting would bounce the request back through the proxy forever (a loop).
        const fwdProtoHttps = String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https'
        // The target host comes from OUR names, never blindly from the request: a forged Host
        // would otherwise turn this redirect into one that sends the browser to any site
        // (httpSecurity.redirectHost; unknown Host -> the configured certificate domain).
        const target = host && !isLoopback && !isPrivateLan && !fwdProtoHttps
          ? httpSecurity.redirectHost(hostPolicy, host, fallbackDomain, ACTIVE_PORT) : ''
        if (target) {
          // Same host, same port (that's the point of multiplexing), same
          // path and query — only the scheme changes.
          res.writeHead(308, {
            Location: `https://${target}${httpSecurity.safeRequestPath(req.url)}`,
            'Content-Length': '0',
            'Cache-Control': 'no-store'
          })
          res.end()
          return
        }
      } catch (err) {
        // A request with no Host header and no configured domain, or anything
        // else unexpected: fall through and just serve the page. Never fail.
        logLine(`could not build an https redirect (${err.message}) — serving over http instead`)
      }
    }
    requestHandler(req, res)
  })
  applyTimeouts(httpServer)
  httpServer.on('upgrade', (req, socket, head) => { if (!jellyfinCompat.handleUpgrade(req, socket, head)) socket.destroy() }) // Jellyfin-style /socket only
  httpServer.on('clientError', (err, socket) => {
    // Default Node behaviour, but explicit so a malformed request line can
    // never surface as an uncaught exception.
    try {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      else socket.destroy()
    } catch {}
  })

  const certDomainFor = () => {
    try {
      if (typeof getCertDomain === 'function') return getCertDomain() || ''
      return getCertDomain || ''
    } catch {
      return ''
    }
  }

  // Installs a certificate into the running server, or swaps a renewed one in
  // without the port so much as blinking. Returns { ok, reason } and never
  // throws — a bad certificate leaves whatever was working before untouched.
  function applyCertificate(input) {
    try {
      if (!input || !input.cert || !input.key) {
        const reason = (input && input.reason) || 'no certificate available'
        if (!tlsState.active) tlsState.reason = reason
        return { ok: false, reason }
      }

      const secureOptions = {
        cert: input.cert,
        key: input.key,
        minVersion: 'TLSv1.2'
      }

      // Build the context FIRST, in this try/catch. A malformed PEM, a key
      // that doesn't match the cert, a truncated file — all of them throw
      // right here, before anything about the live server has changed.
      tls.createSecureContext(secureOptions)

      if (tlsState.server) {
        // Renewal. setSecureContext replaces the certificate on the existing
        // server object; the listening socket is ours (the multiplexer's) and
        // is never touched, so not one connection is dropped.
        tlsState.server.setSecureContext(secureOptions)
        tlsState.active = true
        tlsState.reason = 'certificate installed'
        tlsState.expiresAt = input.expiresAt || null
        logLine('renewed certificate swapped in — no restart, no dropped connections')
        return { ok: true, reason: 'certificate renewed', swapped: true }
      }

      const httpsServer = https.createServer(secureOptions, (req, res) => requestHandler(req, res))
      applyTimeouts(httpsServer)
      httpsServer.on('upgrade', (req, socket, head) => { if (!jellyfinCompat.handleUpgrade(req, socket, head)) socket.destroy() })
      httpsServer.on('clientError', (err, socket) => {
        try {
          if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
          else socket.destroy()
        } catch {}
      })
      // A client that speaks TLS badly (old device, wrong SNI, someone
      // port-scanning) must not become an uncaught exception.
      httpsServer.on('tlsClientError', () => {})
      httpsServer.on('error', (err) => logLine(`https server error: ${err.message}`))

      tlsState.server = httpsServer
      tlsState.active = true
      tlsState.reason = 'certificate installed'
      tlsState.expiresAt = input.expiresAt || null
      logLine('HTTPS is live on the same port — plain http requests now redirect (308) to https')
      return { ok: true, reason: 'certificate installed' }
    } catch (err) {
      // The SAFETY RULE in one place. Whatever went wrong, if HTTPS was
      // already working it keeps working with the old certificate; if it
      // wasn't, we stay on plain HTTP. Nothing stops serving.
      const reason = `certificate rejected: ${err.message}`
      if (!tlsState.active) tlsState.reason = reason
      logLine(`${reason} — ${tlsState.active ? 'keeping the previous certificate' : 'serving over plain http'}`)
      return { ok: false, reason }
    }
  }

  // Try whatever is already on disk, right now, synchronously — so a restart
  // brings HTTPS straight back up instead of waiting for the background
  // renewal check. A corrupt file here is a log line, nothing more.
  try {
    const dir = certDirFor()
    if (certs && dir) {
      const loaded = certs.readCertificate(dir)
      if (loaded.ok && !loaded.expired) {
        applyCertificate(loaded)
      } else {
        tlsState.reason = loaded.ok ? 'certificate on disk has expired' : loaded.reason
        logLine(`starting without HTTPS: ${tlsState.reason}`)
      }
    } else if (!dir) {
      tlsState.reason = 'no certificate folder configured'
    }
  } catch (err) {
    tlsState.reason = `certificate load failed: ${err.message}`
    logLine(`starting without HTTPS: ${tlsState.reason}`)
  }

  // The listener that actually owns port 47811.
  // Every accepted socket, so close() can end the ones already handed to the
  // http/https servers - mux.close() alone leaves keep-alive connections open.
  const openSockets = new Set()
  const mux = net.createServer((socket) => {
    let dispatched = false
    openSockets.add(socket)
    socket.once('close', () => openSockets.delete(socket))

    const onEarlyError = () => {
      // A connection that dies before it says anything is nobody's problem
      // but ours — swallow it so it can't reach the process as an uncaught
      // 'error' event.
      try {
        socket.destroy()
      } catch {}
    }
    socket.on('error', onEarlyError)

    // A client that opens a socket and never sends a byte would otherwise sit
    // here forever, since neither server has been given the socket yet.
    // Matches the 2-minute headersTimeout above.
    const peekTimer = setTimeout(() => {
      if (!dispatched) {
        try {
          socket.destroy()
        } catch {}
      }
    }, 120000)
    if (peekTimer.unref) peekTimer.unref()

    socket.once('data', (chunk) => {
      dispatched = true
      clearTimeout(peekTimer)
      try {
        // Put the byte(s) back and hand over a socket that looks untouched.
        socket.pause()
        socket.unshift(chunk)
        socket.removeListener('error', onEarlyError)

        const looksLikeTls = chunk.length > 0 && chunk[0] === 0x16
        const target = looksLikeTls && tlsState.active && tlsState.server ? tlsState.server : httpServer
        // Emitting 'connection' is how both http.Server and https.Server take
        // ownership of an already-accepted socket; from here on they behave
        // exactly as if they had been listening themselves.
        target.emit('connection', socket)
        process.nextTick(() => {
          try {
            socket.resume()
          } catch {}
        })
      } catch (err) {
        logLine(`could not hand off a connection: ${err.message}`)
        try {
          socket.destroy()
        } catch {}
      }
    })
  })

  mux.on('error', (err) => {
    // Previously an EADDRINUSE here was an uncaught 'error' event and took
    // the whole app down. Now it's a log line and a few retries — the usual
    // cause is a previous copy of the app still shutting down.
    logLine(`could not listen on ${PORT}: ${err.message}`)
    if (err.code === 'EADDRINUSE' && listenAttempts < 5) {
      listenAttempts += 1
      const retry = setTimeout(() => {
        try {
          mux.listen(ACTIVE_PORT, BIND_ADDRESS)
        } catch (e) {
          logLine(`retry ${listenAttempts} failed: ${e.message}`)
        }
      }, 5000)
      if (retry.unref) retry.unref()
    }
  })

  let listenAttempts = 0
  mux.listen(ACTIVE_PORT, BIND_ADDRESS, () => {
    logLine(
      tlsState.active
        ? `Stream server listening on ${BIND_ADDRESS}:${ACTIVE_PORT} (https + http, http redirects to https)`
        : `Stream server listening on ${BIND_ADDRESS}:${ACTIVE_PORT} (http only — ${tlsState.reason})`
    )
    sweepStaleUploadParts()
  })

  return {
    port: ACTIVE_PORT,
    // The desktop app's Podcasts and Radio pages (main.js 'podcasts:call' / 'radio:call'): the same
    // contracts as /api/podcasts/* and /api/radio/*, for one signed-in person.
    podcasts: (method, subPath, query, body, user) => (user && user.id
      ? podcastsHttp.handle({ method, path: subPath || '/status', query: new URLSearchParams(query || {}), body: body || {}, viewer: { id: user.id, isAdmin: !!user.isAdmin } })
      : { status: 401, body: { ok: false, error: 'unauthorized' } }),
    radio: (method, subPath, query, body, user) => (user && user.id
      ? radioHttp.handle({ method, path: subPath || '/status', query: new URLSearchParams(query || {}), body: body || {}, viewer: { id: user.id, isAdmin: !!user.isAdmin } })
      : { status: 401, body: { ok: false, error: 'unauthorized' } }),
    podcastsService: podcastsSvc,
    radioService: radioSvc,
    // The optional Open Library lookup (audiobookMetadata.js): main.js kicks it after a scan and Settings shows its status.
    audiobookLookup: audiobookMeta,
    // The desktop app's Audiobooks tab (main.js 'audiobooks:call'): the same JSON contract as
    // /api/audiobooks/*, run for one signed-in person (the owner). Audio itself is fetched over HTTP with
    // the media tokens that ?tokens=1 puts in the stream URLs.
    audiobooks: (method, subPath, query, body, user) => {
      if (!user || !user.id) return { status: 401, body: { ok: false, error: 'unauthorized' } }
      const sub = String(subPath || '').replace(/^\/+/, '')
      const out = audiobookHttp.handleJson({
        method: String(method || 'GET').toUpperCase(),
        p: '/api/audiobooks' + (sub ? '/' + sub : ''),
        q: new URLSearchParams(query || {}),
        body: body && typeof body === 'object' ? body : {},
        userId: user.id,
        isAdmin: !!user.isAdmin
      })
      return out || { status: 404, body: { ok: false, error: 'not_found' } }
    },
    // The desktop app's Playlists tab (main.js 'playlists:call'): the same
    // contract as /api/playlists/*, for one signed-in person.
    playlists: async (method, subPath, query, body, user) => {
      if (!user || !user.id) return { status: 401, body: { ok: false, error: 'unauthorized' } }
      await primeLibrary('both')
      return playlistHandle(method, subPath, new URLSearchParams(query || {}), body || {}, user)
    },
    // The desktop app's "Switch to Beebo" wizard (main.js 'migration:call'): the same contract as
    // /api/admin/migration/*, for the owner. grantFolder() records a folder the desktop file dialog
    // returned and hands back an id the wizard can name it by (a path is never accepted directly).
    migration: {
      call: async (method, subPath, query, body, user) => {
        if (!user || !user.id) return { status: 401, body: { ok: false, error: 'unauthorized' } }
        return migrationHandle(method, subPath, new URLSearchParams(query || {}), body || {}, user, 'ipc')
      },
      grantFolder: (folder) => {
        const id = 'g_' + crypto.randomBytes(9).toString('base64url')
        migrationGrants.set(id, { path: String(folder), expires: Date.now() + 15 * 60 * 1000 })
        for (const [k, g] of migrationGrants) if (g.expires < Date.now()) migrationGrants.delete(k)
        return id
      }
    },
    // Called by main.js whenever the background certificate routine comes
    // back with something. Safe to call as often as you like.
    applyCertificate,
    tlsStatus: () => ({
      active: tlsState.active,
      reason: tlsState.reason,
      expiresAt: tlsState.expiresAt ? new Date(tlsState.expiresAt).toISOString() : null
    }),
    // The server dashboard: the desktop app reads it over IPC and main.js fills
    // in what only Electron knows (dashboard.setHooks).
    dashboard: serverDashboard,
    // Live conversion (playbackApi.js): the cached encoder capabilities + the current load, for
    // Settings > Playback > Hardware acceleration (main.js -> playbackSettingsIpc.js).
    transcode: { service: playback.encoderService, load: playback.transcodeLoad },
    // The desktop app's Live TV tab and Settings > Live TV (main.js 'livetv:call'): the same contract as /api/livetv/*, as the owner.
    liveTv,
    // The library.item_added check, for tests and for anything that just changed the library.
    webhooks: { announceLibrary: announceNewLibraryItems },
    // The desktop app's Settings > Quality & subtitles "Sweep now" button and
    // its progress panel (main.js 'subtitles:sweepNow' / 'subtitles:sweepStatus').
    subtitleSweep: {
      run: (opts) => runSubtitleSweep(opts || {}),
      status: () => ({ running: subtitleSweepRunner.isRunning(), last: subtitleSweepRunner.lastResult() })
    },
    // Same shape as subtitleSweep above, for the whole-library TMDB catch-up. No Settings UI
    // panel for this yet (it just runs on its own schedule) - exposed here so a "Look up now"
    // button/status panel can be added later without touching this file again.
    metadataSweep: {
      run: (opts) => runMetadataSweep(opts || {}),
      status: () => ({ running: metadataSweepRunner.isRunning(), last: metadataSweepRunner.lastResult() })
    },
    // The automatic intro/credits scanner: status for the desktop Dashboard, and the same actions the
    // admin site offers (main.js may expose them over IPC).
    autoMarkers: {
      status: () => autoMarkerScanner.status(),
      summary: () => autoMarkerScanner.summary(),
      kick: () => autoMarkerScanner.kick(),
      rescanShow: (key) => autoMarkerScanner.rescanShow(key),
      clearShow: (key) => autoMarkerScanner.clearShow(key)
    },
    // The Speech Pack subtitle queue: main.js's Settings > Add-ons IPC calls speechPack.api(name, args).
    speechPack,
    // Watch together rooms: the desktop app's details page starts one over IPC (watchTogetherIpc.js).
    watchTogether,
    // Settings > Jellyfin apps (jellyfinIpc.js): Quick Connect approval, app sessions, app passwords, self-check.
    jellyfin: jellyfinCompat.admin,
    // Movie Night rooms: the desktop app's "Start Movie Night" button starts one over IPC (movieNightIpc.js).
    movieNight,
    // Phone speakers: the details page's button starts a room over IPC (phoneSpeakersIpc.js).
    phoneSpeakers,
    // Used by the tests; the app itself just exits.
    close: (cb) => {
      try { jellyfinCompat.close() } catch {}
      try { autoMarkerScanner.stop() } catch {}
      try { speechPack.queue.stop() } catch {}
      try { liveEvents.closeAll() } catch {}
      try {
        mux.close(cb || (() => {}))
      } catch {
        if (cb) cb()
      }
      for (const socket of openSockets) {
        try {
          socket.destroy()
        } catch {}
      }
      // Stop watching the library folders. On Windows a recursive fs.watch keeps
      // the process alive even with persistent:false. The catalog is shared, so
      // anything still using it afterwards simply walks on every call.
      try {
        library.close()
      } catch {}
      clearInterval(titleRequestSweep)
      clearTimeout(subtitleSweepFirstRun)
      clearInterval(subtitleSweepDaily)
      try { playback.close() } catch {}
      try { watchTogether.close(); if (watchTogetherRooms.getActive() === watchTogether) watchTogetherRooms.setActive(null) } catch {}
      try { movieNight.close(); if (movieNightRooms.getActive() === movieNight) movieNightRooms.setActive(null) } catch {}
      try { phoneSpeakers.close(); if (phoneSpeakersServer.getActive() === phoneSpeakers) phoneSpeakersServer.setActive(null) } catch {}
      try { podcastsSvc.stop() } catch {}
      try { radioSvc.close() } catch {}
      movieVersions.setSiblingResolver(null)
      try { liveTv.stop() } catch {}
    }
  }
}

module.exports = {
  startStreamServer,
  addPreRequestHook,
  parseSingleRange, // exported for the Range regression test
  // exported for unit tests — how verify/reset email links are addressed
  emailLinkOrigin,
  PORT,
  recordQualityFlag,
  // exported so the desktop app's missing-file Requests tab writes the exact
  // same 'missingRequests' rows (and the same dedupe) the website's Up Next
  // card does — there is only one definition of that shape.
  recordMissingRequest,
  // exported so the desktop app (and any other surface) writes the exact same
  // 'playbackMarkers' rows — and runs the same sanity guards — the player does.
  recordPlaybackMarker,
  // exported for unit tests — the tv-manifest.json dual-key compatibility layer
  // (the desktop keys by plain lowercase name, this server by base64 showKey)
  tvManifestKeyCandidates,
  tvManifestHit,
  readTvMetaCached,
  tvManifestWriteKey,
  playbackMarkerFor,
  sanitizeIntroEnd,
  sanitizeCreditsStart,
  // exported for unit tests — pure helpers behind the genre chips and
  // detected-quality badges on the website
  GENRE_NAMES_MOVIE,
  GENRE_NAMES_TV,
  hasGenre,
  countGenres,
  // exported for unit tests — the seeded shuffle behind /surprise channel surfing
  mulberry32,
  seededShuffle,
  normalizeSeed,
  // exported so the desktop app's 🎲 Not Sure What To Watch? tab drives its
  // in-app player off THIS surf engine instead of a second copy of it: same
  // candidate pool, same seeded order, same titles, same signed media tokens
  // the website's /file and /tvfile already accept.
  freshSeed,
  surfCandidates,
  surfTitle,
  // exported for unit tests — the year/decade surf filters
  surfKindOf,
  surfYear,
  surfFilterPool,
  surfYearSummary,
  normalizeYearParam,
  normalizeDecadeParam,
  encodeId,
  decodeId,
  makeMediaToken,
  checkMediaToken,
  verifyMediaToken,
  redactSecrets,
  // exported for unit tests — the phone app's bearer-token auth (/api/*)
  makeApiToken,
  apiTokenSid,
  verifyApiToken,
  // called by backup.importBackup — a restore can swap the signing secrets
  forgetSecrets,
  genreFilterUi,
  certGenreChipsHtml,
  loadQualityCache,
  qualityTierFor,
  bestQualityTier,
  qualityBadgeHtml,
  infoButtonHtml,
  infoOverlayHtml,
  // exported for unit tests — the ℹ️ overlay's cast strip and the shared
  // "1:23:45" clock formatting used by the resume prompt
  castStripHtml,
  formatClock,
  // exported for unit tests — the away-from-home plan quality cap
  currentAwayQualityCap,
  enforceAwayQualityCap
}
