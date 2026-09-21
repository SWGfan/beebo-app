'use strict'
// ============================================================================
// cinemaModeWeb.js - the pre-show controller inside the web player (/watch), and its small
// "Pre-show" settings sheet. The same page runs in browsers, in the desktop app's player window and on
// TV browsers, so this is the ONE client implementation; native TV/phone apps follow the contract in
// docs/CINEMA-MODE.md instead.
//
// How it fits (a two-line change in streamServer.playerPage: cinemaHtml() right after the <video>):
//   1. If the person has Cinema Mode on (a hint remembered in localStorage) or the page was opened with
//      ?preshow=1, the feature is held (paused) at once so nothing of it is heard.
//   2. GET /playback-api/playback/preroll?kind=movie&id=... returns the ordered list
//      [{type:'local'|'youtube', url|videoId, title, durationSec, attribution, key, titleKey, role}].
//   3. Items play one after another on a black layer. LOCAL items play in an ordinary <video>.
//      YOUTUBE items play ONLY in YouTube's own embedded player (an <iframe> on youtube-nocookie.com
//      driven by the official IFrame API); nothing is downloaded, cached, restyled or covered: the
//      Skip buttons sit in their own bar BELOW the player, never on top of it.
//   4. Skip (this one) and Skip all are always on screen; Escape skips everything. Any error, timeout,
//      offline browser or blocked embed just moves on; if anything at all goes wrong the feature plays.
//   5. Each item is reported once it really starts (POST .../preroll/seen) so it is not repeated.
// Everything shown is set with textContent; ids and urls are validated again here before use.
//
// The browser code is an ordinary function (clientMain) whose source is emitted into the page, so it is
// linted, and unit-tested against a small fake DOM, like any other code.
// ============================================================================

const YT_ID = '^[A-Za-z0-9_-]{11}$'

/* eslint-disable no-var */
// This function's SOURCE runs in the browser (ES5 style on purpose: TV browsers).
function clientMain(CFG) {
  var v = document.getElementById('v')
  if (!v || !CFG || !CFG.id || CFG.kind !== 'movie' || !window.fetch) return
  var HINT = 'beebo:cinema'
  var YT_RE = /^[A-Za-z0-9_-]{11}$/
  var LOCAL_RE = /^\/cinema\/media\/[a-f0-9]{20}\?mt=[A-Za-z0-9._%~-]{10,600}$/
  var KEY_RE = /^[a-z]:[A-Za-z0-9_-]{1,80}$/
  var qs = null
  try { qs = new URLSearchParams(location.search) } catch (e) { qs = { get: function () { return null }, has: function () { return false } } }
  var preshow = qs.get('preshow') // '1' with pre-show, '0' without, null = the person's setting
  var hint = false
  try { hint = localStorage.getItem(HINT) === '1' } catch (e) { hint = false }
  var api = function (p, body) {
    var opts = body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin', keepalive: true }
      : { credentials: 'same-origin' }
    return fetch(CFG.api + p, opts).then(function (r) { return r.json().catch(function () { return { ok: false } }) })
  }
  var setHint = function (on) { try { localStorage.setItem(HINT, on ? '1' : '0') } catch (e) { /* private mode */ } }

  // ------------------------------------------------------------------ small DOM helpers (textContent only)
  function el(tag, cls, text) {
    var e = document.createElement(tag)
    if (cls) e.className = cls
    if (text != null) e.textContent = String(text)
    return e
  }
  function button(text, id, onclick) {
    var b = el('button', 'cm-btn', text)
    b.type = 'button'
    if (id) b.id = id
    b.onclick = function (ev) { ev.preventDefault(); ev.stopPropagation(); onclick() }
    return b
  }

  // ------------------------------------------------------------------ holding the feature
  var held = false
  var running = false
  var layer = null
  function holdFeature() {
    if (held) return
    held = true
    try { v.removeAttribute('autoplay') } catch (e) { /* ignore */ }
    try { v.pause() } catch (e) { /* ignore */ }
  }
  function guardPlay() { if (running) { try { v.pause() } catch (e) { /* ignore */ } } }
  v.addEventListener('play', guardPlay)
  function releaseFeature(fromPreshow) {
    running = false
    if (!held && !fromPreshow) return
    held = false
    try { if (!qs.has('t') && (Number(v.currentTime) || 0) < 8) v.currentTime = 0 } catch (e) { /* ignore */ }
    var p = null
    try { p = v.play() } catch (e) { p = null }
    if (p && p.catch) p.catch(function () { /* autoplay refused: the player's own play button works */ })
  }

  // ------------------------------------------------------------------ the layer
  var items = []
  var index = -1
  var current = null // { cleanup }
  var finished = false
  var ytPromise = null

  function styleOnce() {
    if (document.getElementById('cmStyle')) return
    var s = el('style')
    s.id = 'cmStyle'
    s.textContent = [
      '#cmLayer{position:fixed;inset:0;z-index:50;background:#000;display:flex;flex-direction:column;font-family:system-ui,Segoe UI,Arial,sans-serif;color:#fff}',
      '#cmStage{flex:1 1 auto;min-height:200px;position:relative;background:#000}',
      '#cmStage video,#cmStage iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:#000}',
      '#cmBar{flex:0 0 auto;display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;padding:10px 14px;background:#111;border-top:1px solid #333}',
      '#cmBar .cm-what{flex:1 1 220px;min-width:0}',
      '#cmBar .cm-head{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#9ab}',
      '#cmBar .cm-title{font-size:15px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '#cmBar .cm-attr{flex:1 1 100%;font-size:11px;color:#889}',
      '.cm-btn{background:#2a2f3a;color:#fff;border:1px solid rgba(255,255,255,.25);border-radius:8px;padding:9px 14px;font-size:14px;cursor:pointer;font-family:inherit}',
      '.cm-btn:focus{outline:2px solid #7cf}.cm-btn.cm-primary{background:#4f9dff;border-color:#4f9dff}',
      '#cmSheet{position:fixed;inset:0;z-index:60;display:none;align-items:flex-end;justify-content:center;background:rgba(0,0,0,.55);font-family:system-ui,Segoe UI,Arial,sans-serif}',
      '#cmSheet.open{display:flex}',
      '#cmSheet .cm-card{background:#16161c;color:#fff;width:min(560px,100%);max-height:80vh;overflow:auto;border-radius:14px 14px 0 0;padding:14px 16px 20px;box-sizing:border-box}',
      '#cmSheet .cm-row{display:flex;align-items:center;gap:10px;margin:10px 4px;font-size:15px;flex-wrap:wrap}',
      '#cmSheet .cm-note{color:#aab;font-size:12.5px;margin:8px 4px;line-height:1.45}',
      '#cmSheet select{background:#0e0e12;color:#fff;border:1px solid #333;border-radius:6px;padding:5px 8px}',
      '#cmSheet h3{margin:14px 4px 4px;font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:#aab}'
    ].join('\n')
    document.head.appendChild(s)
  }

  function buildLayer() {
    styleOnce()
    layer = el('div')
    layer.id = 'cmLayer'
    layer.setAttribute('role', 'dialog')
    layer.setAttribute('aria-label', 'Pre-show')
    var stage = el('div')
    stage.id = 'cmStage'
    var bar = el('div')
    bar.id = 'cmBar'
    var what = el('div', 'cm-what')
    var head = el('div', 'cm-head', 'Coming attractions')
    head.id = 'cmHead'
    head.setAttribute('aria-live', 'polite')
    var title = el('div', 'cm-title', '')
    title.id = 'cmTitle'
    what.appendChild(head)
    what.appendChild(title)
    var skip = button('Skip', 'cmSkip', skipOne)
    skip.className += ' cm-primary'
    bar.appendChild(what)
    bar.appendChild(skip)
    bar.appendChild(button('Skip all', 'cmSkipAll', finish))
    bar.appendChild(button("Don't show trailers", 'cmNever', neverShow))
    var attr = el('div', 'cm-attr', '')
    attr.id = 'cmAttr'
    bar.appendChild(attr)
    layer.appendChild(stage)
    layer.appendChild(bar)
    document.body.appendChild(layer)
    try { skip.focus() } catch (e) { /* ignore */ }
  }

  function stage() { return document.getElementById('cmStage') }

  function label(item) {
    var trailers = 0
    var at = 0
    for (var i = 0; i < items.length; i++) {
      if (items[i].role === 'trailer') { trailers++; if (i <= index) at = trailers }
    }
    var head = document.getElementById('cmHead')
    if (head) head.textContent = item.role === 'intro' ? 'Feature presentation' : 'Coming attractions' + (trailers > 1 ? ' - ' + at + ' of ' + trailers : '')
    var title = document.getElementById('cmTitle')
    if (title) title.textContent = item.title || ''
    var attr = document.getElementById('cmAttr')
    if (attr) attr.textContent = (item.attribution || '') + (item.type === 'youtube' && CFG.tmdb ? ' ' + CFG.tmdb : '')
  }

  // ------------------------------------------------------------------ item validation
  function validItem(it) {
    if (!it || typeof it !== 'object') return false
    if (it.type === 'local') return typeof it.url === 'string' && LOCAL_RE.test(it.url)
    if (it.type === 'youtube') return typeof it.videoId === 'string' && YT_RE.test(it.videoId)
    return false
  }

  function seen(item) {
    if (item.role !== 'trailer' || !KEY_RE.test(String(item.key || ''))) return
    var entry = { key: item.key }
    if (KEY_RE.test(String(item.titleKey || ''))) entry.titleKey = item.titleKey
    try { api('/playback/preroll/seen', { items: [entry] }).catch(function () { /* best effort */ }) } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------------------ playing one item
  function next() {
    if (finished) return
    if (current) { try { current.cleanup() } catch (e) { /* ignore */ } current = null }
    index++
    while (index < items.length && !validItem(items[index])) index++
    if (index >= items.length) { finish(); return }
    var item = items[index]
    label(item)
    var one = { done: false, timers: [], cleanup: null }
    current = one
    var advance = function () { if (one.done) return; one.done = true; next() }
    var later = function (fn, ms) { var t = setTimeout(function () { if (!one.done) fn() }, ms); one.timers.push(t); return t }
    var started = false
    var markStarted = function () { if (started) return; started = true; seen(item) }
    var maxMs = (item.role === 'intro' ? 90 : (CFG.maxSec || 240)) * 1000
    later(advance, maxMs + 5000)
    try {
      if (item.type === 'local') playLocal(item, one, advance, later, markStarted)
      else playYouTube(item, one, advance, later, markStarted)
    } catch (e) { advance() }
    one.cleanup = (function (inner) {
      return function () {
        one.done = true
        for (var i = 0; i < one.timers.length; i++) clearTimeout(one.timers[i])
        try { if (inner) inner() } catch (e) { /* ignore */ }
        var st = stage()
        if (st) { while (st.firstChild) st.removeChild(st.firstChild) }
      }
    })(one.inner)
  }

  function playLocal(item, one, advance, later, markStarted) {
    var vid = document.createElement('video')
    vid.setAttribute('playsinline', '')
    vid.setAttribute('controls', '')
    vid.setAttribute('disablepictureinpicture', '')
    vid.autoplay = true
    vid.addEventListener('ended', advance)
    vid.addEventListener('error', advance)
    vid.addEventListener('playing', markStarted)
    var meta = later(advance, 15000) // never wait long for a file that does not load
    vid.addEventListener('loadedmetadata', function () { clearTimeout(meta) })
    vid.src = item.url
    stage().appendChild(vid)
    var p = null
    try { p = vid.play() } catch (e) { p = null }
    if (p && p.catch) {
      p.catch(function () {
        // The browser wants a tap before it plays with sound: start muted, the controls unmute.
        try { vid.muted = true; var q = vid.play(); if (q && q.catch) q.catch(function () { /* the viewer can press play or Skip */ }) } catch (e) { /* ignore */ }
      })
    }
    one.inner = function () { try { vid.pause() } catch (e) { /* ignore */ } vid.removeAttribute('src'); try { vid.load() } catch (e) { /* ignore */ } }
  }

  function loadYT() {
    if (window.YT && window.YT.Player) return Promise.resolve()
    if (ytPromise) return ytPromise
    ytPromise = new Promise(function (resolve, reject) {
      var prev = window.onYouTubeIframeAPIReady
      window.onYouTubeIframeAPIReady = function () { if (typeof prev === 'function') { try { prev() } catch (e) { /* ignore */ } } resolve() }
      var s = document.createElement('script')
      s.src = 'https://www.youtube.com/iframe_api'
      s.async = true
      s.onerror = function () { reject(new Error('youtube_unreachable')) }
      document.head.appendChild(s)
      setTimeout(function () { reject(new Error('youtube_timeout')) }, 8000)
    })
    ytPromise.catch(function () { ytPromise = null })
    return ytPromise
  }

  function playYouTube(item, one, advance, later, markStarted) {
    // Offline (or YouTube blocked): move on at once. Nothing is queued for later.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) { advance(); return }
    var player = null
    one.inner = function () { try { if (player && player.destroy) player.destroy() } catch (e) { /* ignore */ } }
    loadYT().then(function () {
      if (one.done) return
      // The embed is a plain iframe on the privacy-enhanced domain; the official IFrame API only
      // ATTACHES to it. The referrer policy lets YouTube see where it is embedded (it refuses to play otherwise).
      var frame = document.createElement('iframe')
      frame.id = 'cmYt'
      frame.title = 'Trailer: ' + (item.title || '')
      frame.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; fullscreen')
      frame.setAttribute('allowfullscreen', '')
      frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin')
      var origin = ''
      try { origin = location.origin } catch (e) { origin = '' }
      frame.src = 'https://www.youtube-nocookie.com/embed/' + item.videoId + '?enablejsapi=1&autoplay=1&playsinline=1&rel=0&origin=' + encodeURIComponent(origin)
      stage().appendChild(frame)
      var startTimer = later(advance, 15000) // never started (autoplay refused, embed blocked): move on
      player = new window.YT.Player(frame, {
        events: {
          onReady: function (e) { try { e.target.playVideo() } catch (err) { /* ignore */ } },
          onStateChange: function (e) {
            if (e.data === 1) { clearTimeout(startTimer); markStarted() } // playing
            else if (e.data === 0) advance() // ended
          },
          onError: advance // embedding disabled, removed, private, not found
        }
      })
    }).catch(function () { advance() })
  }

  // ------------------------------------------------------------------ controls
  function skipOne() { if (current && !current.done) { current.done = true; next() } }
  function finish() {
    if (finished) return
    finished = true
    if (current) { try { current.cleanup() } catch (e) { /* ignore */ } current = null }
    if (layer && layer.parentNode) layer.parentNode.removeChild(layer)
    layer = null
    document.removeEventListener('keydown', onKey, true)
    releaseFeature(true)
  }
  function neverShow() {
    setHint(false)
    try { api('/playback/cinema', { neverShow: true }).catch(function () { /* ignore */ }) } catch (e) { /* ignore */ }
    finish()
  }
  function onKey(e) {
    if (!layer) return
    var k = e.key
    if (k === 'Escape') { e.preventDefault(); finish() } else if (k === 'ArrowRight' || k === 'n' || k === 'N') { e.preventDefault(); skipOne() }
  }

  function start(list, res) {
    items = list
    running = true
    holdFeature()
    buildLayer()
    document.addEventListener('keydown', onKey, true)
    CFG.maxSec = Number(res.maxTrailerSeconds) > 0 ? Number(res.maxTrailerSeconds) : 240
    CFG.tmdb = res.tmdbAttribution || ''
    next()
  }

  // ------------------------------------------------------------------ ask the server
  var gaveUp = false
  var bail = setTimeout(function () { if (!running) { gaveUp = true; if (held) releaseFeature(false) } }, 9000)
  // Runs once the page is parsed, so the "Resume from ...?" prompt (further down the page) can be seen: a film that is
  // being resumed gets no pre-show unless one was asked for.
  function begin() {
    if (preshow === '0') return
    var resuming = qs.has('t') || !!document.getElementById('resumeprompt')
    if (resuming && preshow !== '1') { clearTimeout(bail); releaseFeature(false); return }
    if (preshow === '1' || hint) holdFeature()
    var q = '/playback/preroll?kind=movie&id=' + encodeURIComponent(CFG.id)
    if (preshow) q += '&preshow=' + preshow
    if (resuming) q += '&resume=1'
    api(q).then(function (res) {
      clearTimeout(bail)
      if (res && typeof res.wants === 'boolean') setHint(res.wants)
      if (gaveUp) return
      var list = res && res.ok && res.enabled && Array.isArray(res.items) ? res.items.filter(validItem).slice(0, 7) : []
      if (!list.length) { releaseFeature(false); return }
      start(list, res)
    }).catch(function () { clearTimeout(bail); releaseFeature(false) })
  }
  // Hold the film at once (before the answer arrives) when the person has Cinema Mode on or asked for it, so none of it is heard.
  if (preshow === '1' || (hint && preshow !== '0' && !qs.has('t'))) holdFeature()
  var boot = function () { try { begin() } catch (e) { releaseFeature(false) } }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()

  // ------------------------------------------------------------------ the person's own settings sheet
  var sheet = null
  var state = null
  function openSheet() {
    styleOnce()
    if (!sheet) {
      sheet = el('div')
      sheet.id = 'cmSheet'
      sheet.setAttribute('role', 'dialog')
      sheet.setAttribute('aria-label', 'Pre-show settings')
      sheet.addEventListener('click', function (e) { if (e.target === sheet) sheet.className = '' })
      document.body.appendChild(sheet)
    }
    sheet.className = 'open'
    api('/playback/cinema').then(function (s) { state = s && s.prefs ? s : null; renderSheet() }).catch(function () { renderSheet() })
  }
  function save(patch) {
    return api('/playback/cinema', patch).then(function (s) {
      if (s && s.prefs) { state = s; setHint(!!(s.prefs.enabled && !s.prefs.neverShow)); renderSheet() }
    }).catch(function () { /* ignore */ })
  }
  function toggle(text, on, onChange) {
    var row = el('label', 'cm-row')
    var box = el('input')
    box.type = 'checkbox'
    box.checked = !!on
    box.onchange = function () { onChange(box.checked) }
    row.appendChild(box)
    row.appendChild(el('span', '', text))
    return row
  }
  function choose(text, value, options, onChange) {
    var row = el('label', 'cm-row')
    row.appendChild(el('span', '', text))
    var sel = el('select')
    for (var i = 0; i < options.length; i++) {
      var o = el('option', '', options[i][1])
      o.value = String(options[i][0])
      if (String(options[i][0]) === String(value)) o.selected = true
      sel.appendChild(o)
    }
    sel.onchange = function () { onChange(Number(sel.value)) }
    row.appendChild(sel)
    return row
  }
  function renderSheet() {
    if (!sheet) return
    while (sheet.firstChild) sheet.removeChild(sheet.firstChild)
    var card = el('div', 'cm-card')
    var head = el('div', 'cm-row')
    head.appendChild(el('strong', '', 'Pre-show (Cinema mode)'))
    head.appendChild(button('Close', 'cmSheetClose', function () { sheet.className = '' }))
    card.appendChild(head)
    if (!state) { card.appendChild(el('p', 'cm-note', 'Could not load your pre-show settings.')); sheet.appendChild(card); return }
    var p = state.prefs
    if (!state.available) card.appendChild(el('p', 'cm-note', 'The person who runs this server has switched Cinema mode off.'))
    card.appendChild(toggle('Play a pre-show before films', p.enabled, function (on) { save({ enabled: on }) }))
    card.appendChild(choose('Trailers per film', p.count, [[0, 'None (intro only)'], [1, '1'], [2, '2'], [3, '3'], [4, '4'], [5, '5']], function (n) { save({ count: n }) }))
    if (state.hasIntro) card.appendChild(toggle('Play the intro clip first', p.useIntro, function (on) { save({ useIntro: on }) }))
    card.appendChild(el('h3', '', 'Where trailers come from'))
    card.appendChild(toggle('Trailer files on this server', p.sources.local, function (on) { save({ sources: { local: on } }) }))
    card.appendChild(toggle('Films I own but have not watched', p.sources.owned, function (on) { save({ sources: { owned: on } }) }))
    if (state.onlineAllowed) card.appendChild(toggle('Online trailers of similar films (YouTube)', p.sources.online, function (on) { save({ sources: { online: on } }) }))
    card.appendChild(el('h3', '', 'Repeats'))
    card.appendChild(choose('Do not repeat a trailer for', p.dedupeDays, [[0, 'Never remember'], [7, '7 days'], [14, '14 days'], [30, '30 days'], [90, '90 days']], function (n) { save({ dedupeDays: n }) }))
    card.appendChild(toggle('Only once per movie night (not before every film)', p.oncePerNight, function (on) { save({ oncePerNight: on }) }))
    card.appendChild(toggle('Never show trailers to me', p.neverShow, function (on) { save({ neverShow: on }) }))
    var clear = button('Forget which trailers I have seen', 'cmClear', function () { save({ clearHistory: true }) })
    var clearRow = el('div', 'cm-row')
    clearRow.appendChild(clear)
    card.appendChild(clearRow)
    card.appendChild(el('p', 'cm-note', 'Trailers never play above your rating limit or above the film you are watching. Online trailers play in YouTube\'s own player. Movie information from TMDB.'))
    sheet.appendChild(card)
  }

  var btn = el('button', 'pbtn', '🎬 Pre-show')
  btn.id = 'cmBtn'
  btn.style.display = 'flex'
  btn.title = 'Pre-show (Cinema mode) settings'
  btn.onclick = function (e) { e.preventDefault(); e.stopPropagation(); openSheet() }
  var cast = document.getElementById('castBtn')
  if (cast && cast.parentNode) cast.parentNode.insertBefore(btn, cast)
  else document.body.appendChild(btn)
}
/* eslint-enable no-var */

/** The <script> that goes right after the player's <video>. Nothing is user-controlled except kind/id, JSON-escaped. */
function cinemaHtml({ kind, mediaId } = {}) {
  if (kind === 'tv' || !mediaId) return ''
  const cfg = JSON.stringify({ kind: 'movie', id: String(mediaId), api: '/playback-api' }).replace(/</g, '\\u003c')
  return `\n<script>(${clientMain.toString()})(${cfg});</script>\n`
}

module.exports = { cinemaHtml, clientMain, YT_ID }
