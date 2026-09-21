'use strict'
// Beebo as an installable web app: the piece that lets an iPhone, an iPad, or any browser put Beebo on the
// home screen from the server's own web viewer (there is no iOS app yet).
//
//   /manifest.webmanifest      the Web App Manifest: name, colors from the person's theme, icons, shortcuts
//   /sw.js                     a small, safe service worker (scope "/"): see pwaPolicy.js for what it may touch
//   /pwa/offline               the page it shows when the server cannot be reached
//   /pwa/<icon>.png, /apple-touch-icon*.png   the brand icons
//   headMarkup() / bodyMarkup() the tags, styles and script that page() puts on every page (login included)
//   playerHead() / playerScript the same for the video player, which has its own document
//
// All of it is public and needs no cookie: the manifest and worker are fetched by the browser itself, often
// without credentials, so they carry nothing about the library or the person. The person's theme reaches the
// manifest as two validated query values (a preset id and a #rrggbb) written into the link by the server.
//
// HTTPS, service workers and installing
//   Service workers only run in a secure context, which means https, or http on localhost. Beebo's server
//   speaks https on its own port whenever it has a certificate (a Let's Encrypt one for the owner's DuckDNS
//   or <name>.home.beebo.tv address, or the headless server's self-signed one, which a phone will NOT trust).
//   So:
//     * https with a trusted certificate: everything works. On an iPhone, Safari's Share > Add to Home Screen
//       makes a full-screen app with the offline page and icon. Chrome/Edge/Android offer a real Install.
//     * plain http (a LAN address such as http://192.168.1.20:47811, which the server deliberately keeps
//       on http): the worker cannot register, so there is no offline page, but the manifest, the icon and
//       "Add to Home Screen" still work on iOS: it becomes a full-screen bookmark. The page detects this and
//       simply skips the worker; nothing errors.
//   Nothing in here changes what a server does for a client that ignores it.

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const theme = require('./theme')
const policy = require('./pwaPolicy')

const ICON_DIR = path.join(__dirname, 'pwa')
const SHORTCUTS = [
  { name: 'Movies', url: '/' },
  { name: 'TV Shows', url: '/tvshows' },
  { name: 'Music', url: '/music' },
  { name: 'Continue Watching', url: '/continue' }
]
const DEFAULT_BG = '#080b14' // the midnight --bg (themeTokens.js)
const HEX6 = /^[0-9a-f]{6}$/i

// Public file name -> file in electron/pwa/. The Apple names are also served at the site root, where iOS
// looks for one by itself when a page names none.
const ICON_FILES = {
  '/pwa/icon-192.png': 'icon-192.png',
  '/pwa/icon-432.png': 'icon-432.png',
  '/pwa/apple-touch-icon.png': 'apple-touch-icon.png',
  '/pwa/apple-touch-icon-167.png': 'apple-touch-icon-167.png',
  '/pwa/apple-touch-icon-152.png': 'apple-touch-icon-152.png',
  '/apple-touch-icon.png': 'apple-touch-icon.png',
  '/apple-touch-icon-precomposed.png': 'apple-touch-icon.png'
}

const fileCache = new Map()
function readAsset(name) {
  if (!fileCache.has(name)) {
    let bytes = null
    try { bytes = fs.readFileSync(path.join(ICON_DIR, name)) } catch { bytes = null }
    fileCache.set(name, bytes)
  }
  return fileCache.get(name)
}

// ------------------------------------------------------------------------------------ manifest ----------

/** The manifest for a theme id and a background color; anything unrecognised falls back to the default. */
function manifestObject({ themeId, bg } = {}) {
  const id = theme.PRESET_IDS.includes(themeId) ? themeId : theme.DEFAULT_THEME
  const backgroundColor = HEX6.test(String(bg || '').replace('#', '')) ? '#' + String(bg).replace('#', '').toLowerCase() : DEFAULT_BG
  return {
    id: '/',
    name: 'Beebo',
    short_name: 'Beebo',
    description: 'Your own movies, TV shows and music, streamed from your Beebo server.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    lang: 'en',
    dir: 'ltr',
    theme_color: theme.PRESETS[id].themeColor,
    background_color: backgroundColor,
    categories: ['entertainment', 'video', 'music'],
    prefer_related_applications: false,
    // Only sizes that exist: the master artwork is 432 px, so there is no 512 entry (never scaled up).
    icons: [
      { src: '/pwa/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/pwa/icon-432.png', sizes: '432x432', type: 'image/png', purpose: 'any' },
      { src: '/pwa/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/pwa/icon-432.png', sizes: '432x432', type: 'image/png', purpose: 'maskable' }
    ],
    shortcuts: SHORTCUTS.map((s) => ({ name: s.name, url: s.url, icons: [{ src: '/pwa/icon-192.png', sizes: '192x192', type: 'image/png' }] }))
  }
}

/** The manifest link for the page being rendered: carries the person's theme as two validated values. */
function manifestHref(info, bg) {
  const id = info && theme.PRESET_IDS.includes(info.id) ? info.id : theme.DEFAULT_THEME
  const color = HEX6.test(String(bg || '').replace('#', '')) ? String(bg).replace('#', '').toLowerCase() : DEFAULT_BG.slice(1)
  return `/manifest.webmanifest?theme=${id}&bg=${color}`
}

// ------------------------------------------------------------------------------------ head tags --------

/** <link>/<meta> tags for the shared page head. info: theme.requestRenderInfo(). */
function headTags(info, bg) {
  const light = info && info.scheme === 'light'
  return [
    `<link rel="manifest" href="${manifestHref(info, bg).replace(/&/g, '&amp;')}">`,
    '<link rel="icon" type="image/png" sizes="192x192" href="/pwa/icon-192.png">',
    '<link rel="apple-touch-icon" href="/pwa/apple-touch-icon.png">',
    '<link rel="apple-touch-icon" sizes="152x152" href="/pwa/apple-touch-icon-152.png">',
    '<link rel="apple-touch-icon" sizes="167x167" href="/pwa/apple-touch-icon-167.png">',
    '<link rel="apple-touch-icon" sizes="180x180" href="/pwa/apple-touch-icon.png">',
    '<meta name="application-name" content="Beebo">',
    '<meta name="mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-title" content="Beebo">',
    // A light theme cannot sit under iOS's always-white status text, so it keeps the status bar solid.
    `<meta name="apple-mobile-web-app-status-bar-style" content="${light ? 'default' : 'black-translucent'}">`,
    '<meta name="format-detection" content="telephone=no">'
  ].join('\n  ')
}

// ------------------------------------------------------------------------------------ styles -----------

const STYLES = `
/* installable web app: see pwa.js */
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
a,button,input,select,textarea,label,summary{touch-action:manipulation}
/* iOS zooms the page in when a field under 16px is focused; keep every touch-screen field at 16px or more */
@media (hover:none) and (pointer:coarse){input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]):not([type=color]),select,textarea{font-size:max(16px,1em)}}
.beebo-install{display:flex;align-items:center;gap:10px 14px;flex-wrap:wrap;margin:0 0 16px;padding:12px 14px;border:1px solid var(--line,#2c3e5d);border-radius:var(--radius-card,13px);background:var(--panel,#101c32);color:var(--text,#f2f3ff);font-size:14px;line-height:1.5}
.beebo-install[hidden]{display:none}
.beebo-install p{margin:0;flex:1 1 220px;color:inherit}
.beebo-install svg{width:1.15em;height:1.15em;vertical-align:-.2em;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.beebo-install .beebo-install-actions{display:flex;gap:8px;flex:0 0 auto}
.beebo-install button{min-height:44px;padding:8px 16px;border-radius:var(--radius-button,9px);font:inherit;font-weight:600;cursor:pointer;width:auto}
.beebo-install .beebo-install-go{border:1px solid var(--accent-border,#9776cb);background:linear-gradient(115deg,var(--accent-grad-1,#7144c3),var(--accent-grad-2,#355997));color:var(--on-accent,#fff)}
.beebo-install .beebo-install-x{border:1px solid var(--control-border,#405376);background:transparent;color:var(--text,#f2f3ff)}
.beebo-install-card{margin-top:16px;padding:16px;border:1px solid #2a2f3a;border-radius:10px;background:#171a21}
/* opened from the home screen: no browser chrome, so keep the page from rubber-banding and clear the notch */
html.beebo-standalone,html.beebo-standalone body{overscroll-behavior-y:none}
html.beebo-standalone body{-webkit-touch-callout:none}
html.beebo-standalone .beebo-install{display:none}
@media (display-mode:standalone){.beebo-install{display:none}html,body{overscroll-behavior-y:none}}
@media (min-width:861px){
  html.beebo-standalone .beebo-shell .beebo-main{padding-top:calc(34px + env(safe-area-inset-top))}
  html.beebo-standalone .beebo-sidebar{padding-top:calc(28px + env(safe-area-inset-top))}
}
html.beebo-standalone .beebo-main{padding-left:max(14px,env(safe-area-inset-left));padding-right:max(14px,env(safe-area-inset-right))}
`.replace(/\n+/g, '\n').trim()

const PLAYER_STYLES = `
/* installable web app: the player has its own document (pwa.js) */
html,body{overscroll-behavior:none;-webkit-touch-callout:none}
#bar{padding-top:max(10px,env(safe-area-inset-top));padding-left:max(12px,env(safe-area-inset-left));padding-right:max(12px,env(safe-area-inset-right))}
#toast{bottom:calc(70px + env(safe-area-inset-bottom))}
a,button{touch-action:manipulation}
`.trim()

// ------------------------------------------------------------------------------------ client script ----

// Plain ES5 in one IIFE: it runs on every page, so it must never throw and never need anything to exist.
// handlers = whether to register the lock-screen play/pause/seek buttons (the video player registers its
// own, which know about its screen-off audio, so it only gets the state and position reporting).
function clientScript({ handlers, install }) {
  return `(function () {
  'use strict';
  var doc = document, root = doc.documentElement;
  function attempt(fn) { try { return fn(); } catch (e) { return undefined; } }
  var standalone = !!(attempt(function () { return window.matchMedia('(display-mode: standalone)').matches; }) || window.navigator.standalone === true);
  if (standalone) root.classList.add('beebo-standalone');

  // ---- service worker: only where the browser allows one (https, or localhost) ----
  if ('serviceWorker' in navigator && window.isSecureContext) {
    var register = function () { attempt(function () { navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function () {}); }); };
    if (doc.readyState === 'complete') register(); else window.addEventListener('load', register);
  }
${install ? INSTALL_JS : ''}
  // ---- lock-screen and headphone controls (Media Session) ----
  var session = navigator.mediaSession;
  var lastPlayed = null, positionAt = 0, wired = false;
  function isMedia(el) { return !!el && (el.tagName === 'AUDIO' || el.tagName === 'VIDEO') && !el.srcObject; }
  function playingElement() {
    var list = doc.querySelectorAll('audio,video');
    for (var i = 0; i < list.length; i++) { if (isMedia(list[i]) && !list[i].paused && !list[i].ended) return list[i]; }
    return null;
  }
  function currentElement() { return playingElement() || lastPlayed; }
  function reportState() {
    if (!session) return;
    attempt(function () {
      var live = playingElement(), el = live || lastPlayed;
      session.playbackState = live ? 'playing' : (el ? 'paused' : 'none');
      if (el && session.setPositionState && isFinite(el.duration) && el.duration > 0) {
        session.setPositionState({ duration: el.duration, playbackRate: el.playbackRate || 1, position: Math.min(el.currentTime || 0, el.duration) });
      }
    });
  }
  function wire() {
    if (wired) return; wired = true;
    // iOS: without this, audio played through Web Audio follows the silent switch and stops when the screen locks.
    if (navigator.audioSession) attempt(function () { navigator.audioSession.type = 'playback'; });
    if (!session) return;
    attempt(function () {
      if (!session.metadata && window.MediaMetadata) {
        session.metadata = new MediaMetadata({ title: doc.title || 'Beebo', artist: 'Beebo', artwork: [
          { src: '/pwa/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/pwa/icon-432.png', sizes: '432x432', type: 'image/png' }] });
      }
    });
    if (!${handlers ? 'true' : 'false'}) return;
    function on(name, fn) { attempt(function () { session.setActionHandler(name, fn); }); }
    on('play', function () { var el = currentElement(); if (el) el.play().catch(function () {}); });
    on('pause', function () { var list = doc.querySelectorAll('audio,video'); for (var i = 0; i < list.length; i++) { if (isMedia(list[i])) list[i].pause(); } });
    on('stop', function () { var el = currentElement(); if (el) el.pause(); });
    // +-10 s buttons only for video. On music the lock screen should keep previous/next song (the Music page
    // registers those), and a scrubber (seekto) is enough for seeking within a song.
    if (lastPlayed && lastPlayed.tagName === 'VIDEO') {
      on('seekbackward', function (d) { var el = currentElement(); if (el) el.currentTime = Math.max(0, el.currentTime - ((d && d.seekOffset) || 10)); });
      on('seekforward', function (d) { var el = currentElement(); if (el) el.currentTime = Math.min(el.duration || Infinity, el.currentTime + ((d && d.seekOffset) || 10)); });
    }
    on('seekto', function (d) {
      var el = currentElement(); if (!el || !d || d.seekTime == null) return;
      if (d.fastSeek && el.fastSeek) el.fastSeek(d.seekTime); else el.currentTime = d.seekTime;
    });
  }
  // Media events do not bubble, but they can be caught on the way down, so one listener covers the page's own
  // elements, ones created later (gapless next-song, screen-off audio) and ones added after this script ran.
  function onMedia(e) {
    if (!isMedia(e.target)) return;
    if (e.type === 'play' || e.type === 'playing') { lastPlayed = e.target; wire(); }
    if (e.type === 'timeupdate') { var now = Date.now(); if (now - positionAt < 1000) return; positionAt = now; }
    setTimeout(reportState, 0); // after the page's own handlers (a swap pauses one element and plays the next)
  }
  ['play', 'playing', 'pause', 'ended', 'emptied', 'ratechange', 'seeked', 'durationchange', 'loadedmetadata', 'timeupdate'].forEach(function (name) {
    doc.addEventListener(name, onMedia, true);
  });
})();`
}

const INSTALL_JS = `
  // ---- the Install helper: a small banner, dismissible, remembered, nothing sent anywhere ----
  var KEY = 'beebo:pwa:install-dismissed', QUIET_MS = 90 * 24 * 3600 * 1000, banner = null;
  function dismissed() { return !!attempt(function () { var t = Number(localStorage.getItem(KEY)); return t && Date.now() - t < QUIET_MS; }); }
  function remember() { attempt(function () { localStorage.setItem(KEY, String(Date.now())); }); }
  function hide() { if (banner && banner.parentNode) banner.parentNode.removeChild(banner); banner = null; }
  function show(message, primary, onPrimary, dismissLabel) {
    if (banner || standalone || dismissed()) return;
    var host = doc.getElementById('beebo-content') || doc.body;
    if (!host) return;
    banner = doc.createElement('div');
    banner.className = 'beebo-install';
    banner.setAttribute('role', 'region');
    banner.setAttribute('aria-label', 'Install Beebo');
    var text = doc.createElement('p');
    text.innerHTML = message;
    var actions = doc.createElement('div');
    actions.className = 'beebo-install-actions';
    if (primary) {
      var go = doc.createElement('button');
      go.type = 'button'; go.className = 'beebo-install-go'; go.textContent = primary;
      go.addEventListener('click', onPrimary);
      actions.appendChild(go);
    }
    var no = doc.createElement('button');
    no.type = 'button'; no.className = 'beebo-install-x'; no.textContent = dismissLabel;
    no.setAttribute('aria-label', 'Dismiss the install suggestion');
    no.addEventListener('click', function () { remember(); hide(); });
    actions.appendChild(no);
    banner.appendChild(text); banner.appendChild(actions);
    host.insertBefore(banner, host.firstChild);
  }
  // Chrome, Edge, Samsung Internet and Android browsers: the browser hands over its own install prompt.
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    var saved = e;
    show('Install Beebo on this device to open it like an app, full screen, from your home screen or desktop.', 'Install', function () {
      hide();
      attempt(function () { saved.prompt(); return saved.userChoice; });
    }, 'Not now');
  });
  window.addEventListener('appinstalled', function () { remember(); hide(); });
  // iPhone and iPad Safari have no install prompt: say where the button is.
  var ua = navigator.userAgent || '';
  var iOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var iosSafari = iOS && /Safari\\//.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo|GSA\\/|FBAN|FBAV|Instagram/.test(ua);
  if (iosSafari) {
    var hint = function () {
      show('Put Beebo on your home screen: tap the Share button <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M8 7l4-4 4 4M5 12v8h14v-8"/></svg> at the bottom of Safari (top on iPad), then choose <strong>Add to Home Screen</strong>.', '', null, 'Got it');
    };
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', hint); else hint();
  }
`

const PAGE_SCRIPT = clientScript({ handlers: true, install: true })
const PLAYER_SCRIPT = clientScript({ handlers: false, install: false })

// ------------------------------------------------------------------------------------ markup pieces ----

/** Head tags plus styles for the shared page() document. */
function headMarkup(info) {
  let bg = DEFAULT_BG
  try { bg = theme.requestBackgroundColor() } catch { bg = DEFAULT_BG }
  return `${headTags(info, bg)}\n  <style>${STYLES}</style>`
}

/** The install helper, service-worker registration, standalone handling and Media Session, for page(). */
function bodyMarkup() {
  return `<script>${PAGE_SCRIPT}</script>`
}

/** For the video player's own <head>: the same tags and the player's standalone styles. */
function playerHead() {
  let info = null
  let bg = DEFAULT_BG
  try { info = theme.requestRenderInfo(); bg = theme.requestBackgroundColor() } catch { info = null }
  return `${headTags(info, bg)}\n<style>${PLAYER_STYLES}</style>`
}

/** For the end of the video player's <body>: playback state and position for the lock screen. */
function playerScript() {
  return `<script>${PLAYER_SCRIPT}</script>`
}

/** The iPhone and iPad card on /get-app, in the same plain style as the Android and Windows ones. */
function getAppCardHtml() {
  return `<div class="beebo-install-card">
        <h3 style="margin:0 0 6px;">🍎 iPhone and iPad</h3>
        <p class="muted" style="margin:0 0 12px;line-height:1.55;">
          There is no App Store app yet, but Beebo installs from Safari and then opens full screen from
          your home screen, like an app.
        </p>
        <ol class="muted" style="line-height:1.7;padding-left:20px;margin:0;">
          <li>Open this server's address in <b>Safari</b> and sign in.</li>
          <li>Tap the <b>Share</b> button (the square with an arrow, at the bottom of the screen, or the top on an iPad).</li>
          <li>Choose <b>Add to Home Screen</b>, then <b>Add</b>.</li>
          <li>Open <b>Beebo</b> from your home screen. It keeps its own sign-in, so you may need to sign in once there.</li>
        </ol>
        <p class="muted" style="margin:12px 0 0;font-size:13px;line-height:1.55;">
          Works best over the secure (https) address, which also shows a friendly page instead of an error when
          the server can't be reached. Over a plain home Wi-Fi address it still installs, as a full-screen shortcut.
        </p>
      </div>`
}

// ------------------------------------------------------------------------------------ service worker ---

function workerVersion() {
  // The cache name changes whenever the offline page or an icon does, so a stale copy can never outlive a release.
  const h = crypto.createHash('sha1')
  h.update(OFFLINE_HTML)
  for (const p of policy.CONFIG.staticPaths) {
    const file = ICON_FILES[p]
    if (file) { const bytes = readAsset(file); if (bytes) h.update(bytes) }
  }
  return `v${policy.VERSION}-${h.digest('hex').slice(0, 8)}`
}

let workerCache = null
function workerSource() {
  if (workerCache) return workerCache
  const version = workerVersion()
  workerCache = `'use strict';
// Beebo service worker ${version}. Generated by electron/pwa.js; the decision code is electron/pwaPolicy.js.
// It shows one page (the offline page) when the server cannot be reached and caches a few icons.
// It never caches an API answer, a stream, a signed link or a page. See pwaPolicy.js.
var CACHE = ${JSON.stringify(policy.CONFIG.cachePrefix + 'static-' + version)};
var CONFIG = ${JSON.stringify(policy.CONFIG)};
CONFIG.origin = self.location.origin;
var OFFLINE = '/pwa/offline';
${policy.decide.toString()}
${policy.canStore.toString()}
self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(CACHE).then(function (cache) {
    return Promise.all(CONFIG.precache.map(function (path) {
      return fetch(path, { cache: 'reload', credentials: 'omit' }).then(function (res) {
        if (!canStore(path, res.status, res.type, res.headers.get('content-type'), res.headers.get('set-cookie'))) throw new Error('not cacheable: ' + path);
        return cache.put(path, res);
      });
    }));
  }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (names) {
    return Promise.all(names.filter(function (n) { return n.indexOf(CONFIG.cachePrefix) === 0 && n !== CACHE; }).map(function (n) { return caches.delete(n); }));
  }).then(function () { return self.clients.claim(); }));
});
function fromCacheOrNetwork(req) {
  var path = new URL(req.url).pathname;
  return caches.open(CACHE).then(function (cache) {
    return cache.match(path).then(function (hit) {
      if (hit) return hit;
      return fetch(req.url, { credentials: 'omit' }).then(function (res) {
        if (canStore(path, res.status, res.type, res.headers.get('content-type'), res.headers.get('set-cookie'))) cache.put(path, res.clone());
        return res;
      });
    });
  });
}
self.addEventListener('fetch', function (event) {
  var req = event.request;
  var what = decide({ url: req.url, method: req.method, mode: req.mode, hasRange: req.headers.has('range') }, CONFIG);
  if (what === 'bypass') return; // not ours: the browser handles it exactly as it would with no worker
  if (what === 'static') { event.respondWith(fromCacheOrNetwork(req)); return; }
  // A page: always the network. Only when the network itself fails is the offline page shown.
  event.respondWith(fetch(req).catch(function () {
    return caches.open(CACHE).then(function (cache) { return cache.match(OFFLINE); }).then(function (page) { return page || Response.error(); });
  }));
});
`
  return workerCache
}

const OFFLINE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>Can't reach Beebo</title>
<style>
:root{color-scheme:dark light;--bg:#0f1420;--fg:#e9ecf3;--muted:#b9c1d4;--btn:#4f9dff}
@media (prefers-color-scheme:light){:root{--bg:#f5f6fa;--fg:#15181f;--muted:#4b5266;--btn:#2f6fd0}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.55 -apple-system,Segoe UI,Roboto,system-ui,sans-serif;padding:max(24px,env(safe-area-inset-top)) max(24px,env(safe-area-inset-right)) max(24px,env(safe-area-inset-bottom)) max(24px,env(safe-area-inset-left))}
main{max-width:420px;text-align:center}
img{width:96px;height:96px;border-radius:22px;margin:0 auto 18px;display:block}
h1{font-size:22px;margin:0 0 10px}
p{margin:0 0 12px;color:var(--muted)}
button{margin-top:8px;min-height:48px;padding:12px 26px;border:0;border-radius:10px;background:var(--btn);color:#fff;font:inherit;font-weight:600;cursor:pointer}
</style></head><body><main>
<img src="/pwa/icon-192.png" width="96" height="96" alt="">
<h1>Can't reach your Beebo server</h1>
<p>Beebo plays from the computer at home that holds your library. Right now this device can't get through to it.</p>
<p>Check that this device is online, and that the Beebo computer is switched on and awake. If you're away from home, it needs to be connected to the internet too.</p>
<button type="button" id="retry">Try again</button>
</main>
<script>
function retry(){ if (location.pathname === '/pwa/offline') location.href = '/'; else location.reload(); }
document.getElementById('retry').addEventListener('click', retry);
window.addEventListener('online', retry);
</script></body></html>`

// ------------------------------------------------------------------------------------ routes -----------

function send(req, res, status, type, body, cache) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')
  const headers = {
    'Content-Type': type,
    'Content-Length': buf.length,
    'Cache-Control': cache,
    'X-Content-Type-Options': 'nosniff'
  }
  if (status === 405) headers.Allow = 'GET, HEAD'
  res.writeHead(status, headers)
  res.end(req.method === 'HEAD' ? undefined : buf)
}

/** Serves the installable-web-app files. Returns true when the request was answered. */
function handle(req, res, url) {
  const p = url.pathname
  const isIcon = Object.prototype.hasOwnProperty.call(ICON_FILES, p)
  if (p !== '/manifest.webmanifest' && p !== '/sw.js' && p !== '/pwa/offline' && !isIcon) return false
  if (req.method !== 'GET' && req.method !== 'HEAD') { send(req, res, 405, 'text/plain; charset=utf-8', 'Method not allowed', 'no-store'); return true }
  if (p === '/manifest.webmanifest') {
    const body = JSON.stringify(manifestObject({ themeId: url.searchParams.get('theme'), bg: url.searchParams.get('bg') }))
    send(req, res, 200, 'application/manifest+json; charset=utf-8', body, 'public, max-age=300')
    return true
  }
  if (p === '/sw.js') {
    // The worker script must never sit in a shared cache, or a fix could not reach phones. Service-Worker-Allowed
    // is stated even though "/" needs no widening: it documents that the scope is the whole site.
    const buf = Buffer.from(workerSource(), 'utf8')
    res.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Content-Length': buf.length,
      'Cache-Control': 'no-cache',
      'Service-Worker-Allowed': '/',
      'X-Content-Type-Options': 'nosniff'
    })
    res.end(req.method === 'HEAD' ? undefined : buf)
    return true
  }
  if (p === '/pwa/offline') {
    send(req, res, 200, 'text/html; charset=utf-8', OFFLINE_HTML, 'no-cache')
    return true
  }
  const bytes = readAsset(ICON_FILES[p])
  if (!bytes) { send(req, res, 404, 'text/plain; charset=utf-8', 'Not found', 'no-store'); return true }
  send(req, res, 200, 'image/png', bytes, 'public, max-age=86400')
  return true
}

module.exports = {
  handle, manifestObject, manifestHref, headTags, headMarkup, bodyMarkup, playerHead, playerScript, getAppCardHtml,
  workerSource, OFFLINE_HTML, STYLES, PLAYER_STYLES, ICON_FILES, DEFAULT_BG
}
