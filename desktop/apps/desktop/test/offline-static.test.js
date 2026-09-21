'use strict'
// Static guards for "Beebo keeps working when your internet is down" (docs/OFFLINE-FIRST.md):
//   - no page, script or style loads a font, library or analytics from another site,
//   - the internet addresses named anywhere in the server and app code are all on a short, reviewed list,
//     so a new outside dependency shows up here first instead of surprising someone with no internet.
// Run: node --test test/offline-static.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const appRoot = path.resolve(__dirname, '..')

function walk(dir, exts, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'vendor' || e.name === 'dist' || e.name.startsWith('.')) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, exts, out)
    else if (exts.includes(path.extname(e.name))) out.push(full)
  }
  return out
}
const rel = (f) => path.relative(appRoot, f).replace(/\\/g, '/')

const BAD_HOSTS = /fonts\.googleapis\.com|fonts\.gstatic\.com|cdnjs\.cloudflare\.com|unpkg\.com|cdn\.jsdelivr\.net|code\.jquery\.com|stackpath\.bootstrapcdn|use\.fontawesome|kit\.fontawesome|googletagmanager|google-analytics|analytics\.google|segment\.io|mixpanel|amplitude|sentry\.io|hotjar|bugsnag|datadoghq|posthog|plausible\.io|fullstory/i

test('the desktop app and every page the server sends load no font, library or analytics from another site', () => {
  const files = [
    path.join(appRoot, 'index.html'),
    ...walk(path.join(appRoot, 'src'), ['.js', '.jsx', '.css', '.html']),
    ...walk(path.join(appRoot, 'electron'), ['.js', '.css', '.html']),
    ...walk(path.join(appRoot, 'headless'), ['.js'])
  ]
  const hits = []
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8')
    const m = text.match(BAD_HOSTS)
    if (m) hits.push(`${rel(f)}: ${m[0]}`)
  }
  assert.deepEqual(hits, [], 'third-party fonts, CDNs or analytics found')
})

test('hls.js and the QR code library are shipped inside the app, not loaded from the internet', () => {
  assert.ok(fs.existsSync(path.join(appRoot, 'electron', 'vendor', 'hls.min.js')))
  assert.ok(fs.existsSync(path.join(appRoot, 'electron', 'vendor', 'qrcode-generator.js')))
  const ui = fs.readFileSync(path.join(appRoot, 'electron', 'playbackWebUi.js'), 'utf8')
  assert.match(ui, /\/hls\/hls\.min\.js/)
  assert.doesNotMatch(ui, /https?:\/\/[^'"\s]*hls/i)
})

// Every internet host the server and app code may reach, with the reason. Adding a line here is a decision: it must
// also appear in the table in docs/OFFLINE-FIRST.md, and it must have a wait limit and a fallback (electron/cloudFetch.js
// covers plain fetch; a module that opens its own connection needs its own timeout).
const CONTACTED = {
  'login.beebo.tv': 'sign-in, licence renewal, wallet, away-from-home (only when signed in)',
  'beebo-licensing.samplehouse.workers.dev': 'the old address of the same service, tried second',
  'www.beeboentertainment.com': 'update feed, Relay price list, help pages',
  'beeboentertainment.com': 'update feed',
  'beebo.tv': 'Connection Doctor address check, connection test',
  'name.beebo.tv': 'the house name check (placeholder in a comment)',
  'api.themoviedb.org': 'titles, cast and posters (owner’s own TMDB key)',
  'image.tmdb.org': 'poster and cast photos, saved to this PC the first time',
  'api.tvmaze.com': 'episode titles',
  'api.opensubtitles.com': 'subtitle search (owner’s own key)',
  'openlibrary.org': 'audiobook details (opt-in)',
  'covers.openlibrary.org': 'audiobook covers (opt-in)',
  'itunes.apple.com': 'podcast directory search',
  'all.api.radio-browser.info': 'internet radio directory',
  'api.radio-browser.info': 'internet radio directory',
  'www.duckdns.org': 'the older DuckDNS address update',
  'api.papermc.io': 'game server download (opt-in)',
  'api.cloudflare.com': 'the owner’s own Cloudflare relay usage (opt-in)',
  'api.pushover.net': 'notification webhook the owner sets up',
  'ntfy.sh': 'notification webhook the owner sets up',
  'www.youtube.com': 'trailer links opened in the browser',
  'www.youtube-nocookie.com': 'Cinema Mode plays official trailers in the YouTube embedded player only; offline the pre-show skips them and the film starts',
  'i.ytimg.com': 'trailer thumbnails',
  'img.youtube.com': 'trailer thumbnails',
  'tile.openstreetmap.org': 'photo map tiles',
  'plex.tv': 'migration importer: the owner’s own Plex account',
  'discover.provider.plex.tv': 'migration importer',
  'github.com': 'add-on files the owner chooses to download (Speech Pack)',
  'huggingface.co': 'add-on model files the owner chooses to download (Speech Pack)',
  'relay1.beebo.tv': 'Beebo STUN/relay for away-from-home connections (stun: address, not a page)'
}
// Addresses that are only links a person may click, text in a comment or a document, or an XML namespace: nothing
// connects to them by itself.
const TEXT_ONLY = /^(?:www\.w3\.org|schemas\.xmlsoap\.org|purl\.org|ns\.adobe\.com|www\.itunes\.com|search\.yahoo\.com|podlove\.org|podcastindex\.org|rssboard\.org|www\.apple\.com|www\.themoviedb\.org|www\.opensubtitles\.com|opensubtitles\.stoplight\.io|www\.google\.com|www\.bing\.com|duckduckgo\.com|www\.imdb\.com|letterboxd\.com|www\.openstreetmap\.org|myaccount\.google\.com|developer\.android\.com|developers\.google\.com|developers\.cloudflare\.com|www\.d-project\.com|www\.denso-wave\.com|www\.opensource\.org|stackoverflow\.com|aomedia\.org|(?:.+\.)?example\.(?:com|org|test)|www\.radio-browser\.info|ollama\.com|www\.ovhcloud\.com|localhost|.*\.invalid)$/i

test('every internet address named in the server and app code is on the reviewed list', () => {
  const files = [...walk(path.join(appRoot, 'electron'), ['.js']), ...walk(path.join(appRoot, 'src'), ['.js', '.jsx'])]
  const found = new Map()
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8')
    for (const m of text.matchAll(/https?:\/\/([a-z0-9][a-z0-9.-]*\.[a-z]{2,})(?::\d+)?/gi)) {
      const host = m[1].toLowerCase()
      if (TEXT_ONLY.test(host) || CONTACTED[host]) continue
      if (!found.has(host)) found.set(host, new Set())
      found.get(host).add(rel(f))
    }
  }
  const unknown = [...found].map(([h, fs2]) => `${h}  (${[...fs2].join(', ')})`)
  assert.deepEqual(unknown, [], 'a new internet address appeared. Add it to CONTACTED (or TEXT_ONLY if it is only a link) and to the table in docs/OFFLINE-FIRST.md, and give it a wait limit and a fallback')
})

test('the desktop app never asks a person to sign in to a Beebo account before the home library opens', () => {
  const gate = fs.readFileSync(path.join(appRoot, 'src', 'components', 'SignInGate.jsx'), 'utf8')
  assert.match(gate, /never stands in the way of\s+\/\/ the app|never stands in the way of the app/)
  assert.match(gate, /home library opens straight away/)
  const main = fs.readFileSync(path.join(appRoot, 'src', 'main.jsx'), 'utf8')
  assert.match(main, /<SignInGate>/)
})

test('start-up work that touches the internet is deferred behind timers, never awaited before the server listens', () => {
  const src = fs.readFileSync(path.join(appRoot, 'electron', 'main.js'), 'utf8')
  const ready = src.slice(src.indexOf('app.whenReady().then(() => {'))
  const serverAt = ready.indexOf('streamServerInfo = startStreamServer(')
  assert.ok(serverAt > 0)
  // Nothing before the server starts may be an awaited network call.
  const before = ready.slice(0, serverAt)
  assert.doesNotMatch(before, /await\s+(?:fetch|license\.|remoteHost|homeAddress|walletClient|certs\.)/)
  // The internet-facing jobs are all scheduled, not inline.
  for (const job of ['remoteHost.start()', 'portMapper.start()', 'rtcPortMapper.start()']) {
    const at = ready.indexOf(job)
    assert.ok(at > 0, job)
    assert.match(ready.slice(Math.max(0, at - 120), at), /setTimeout\(/, `${job} runs from a timer`)
  }
  assert.match(ready, /createRevalidateSchedule\(/)
  assert.match(ready, /scheduleCertificateWork\(\)/)
})
