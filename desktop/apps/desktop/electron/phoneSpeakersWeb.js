'use strict'
// ============================================================================
// phoneSpeakersWeb.js - the "Phone speakers" button, panel and TV overlay in the web player (the TV / PC page).
// ----------------------------------------------------------------------------
// Injected into the /watch and /tvwatch page by streamServer.playerPage (one line, next to the Watch together panel).
// Everything here is written as a real function (phoneSpeakersPanel) and pasted into the page with toString(), like
// watchTogetherWeb.js, so it is syntax-checked with the rest of the code and needs no escaping. It uses the same
// browser library the guests' phones run (/speakers/client.js: clock sync, link, audio engine), so what the tests
// exercise is what runs here.
//
// What the page does
//   * "Phone speakers" opens a panel: start a room for THIS film (the person must be signed in and allowed to watch it), the
//     QR code and link for guests, the presets (surround / stereo pair / everyone), the seating chart, per-phone timing and
//     volume, the beep test, "TV fills in missing channels", the picture delay, close the room
//   * the film's <video> is MUTED while phones play the sound (its own sound comes back the moment no phone is here, or the
//     speed is not 1x). The <video> is the timeline master: its play / pause / seek / speed move the shared timeline, and
//     every second it tells the room where the picture really is, so the phones follow the PICTURE
//   * after a seek the video waits (the room "holds") until every phone has its sound loaded, then starts again together
//   * a small overlay says who is connected and whether each phone is in sync; the TV plays any channel no phone covers
//     itself, through the same audio engine the phones use
//
// SECURITY: names and titles come from other people. The page NEVER builds HTML from them: every piece of room data
// reaches the screen through textContent (the QR code is an SVG made by this server, parsed as XML, never a string of
// markup), and the code below never sets markup from a string at all (a test scans for it).
// ============================================================================

const { scriptJson } = require('./watchTogetherWeb')

/* eslint-disable no-undef -- runs in the browser: BeeboSpeakers comes from /speakers/client.js */
function phoneSpeakersPanel(CFG) {
  var v = document.getElementById('v')
  var B = window.BeeboSpeakers
  if (!v || !window.fetch || !B || !CFG || !CFG.id) return
  var OWNER = CFG.owner
  var API = '/speakers/api'
  var S = {
    open: false, code: '', token: '', joinUrl: '', qrSvg: '', snap: null, link: null, engine: null, ctx: null, mediaOk: true,
    appliedSeq: 0, ignorePlay: 0, ignorePause: 0, ignoreSeek: 0, userMuted: v.muted, forcedMute: false, startTimer: 0, startLat: 60,
    lastSync: 0, frame: null, lastReport: '', lastReportAt: 0, overlayUntil: 0, error: '', tickTimer: 0, connecting: false, lastSeq: -1
  }
  var clk = function () { return performance.now() }
  var enc = encodeURIComponent

  function el(tag, cls, text) {
    var e = document.createElement(tag)
    if (cls) e.className = cls
    if (text !== undefined && text !== null) e.textContent = String(text)
    return e
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild) }
  function store(k, val) { try { if (val === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, val) } catch (e) {} }
  function stored(k) { try { return sessionStorage.getItem(k) || '' } catch (e) { return '' } }
  function ownerPost(path, body) {
    return fetch(OWNER + path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'bad_reply' } }) })
      .catch(function () { return { ok: false, error: 'network', message: 'Could not reach the server.' } })
  }
  function hostPost(path, body) { return S.link ? S.link.post('/host' + path, body) : Promise.resolve({ ok: false }) }

  // ---------------------------------------------------------------- the button, panel, overlay
  var btn = el('button', 'pbtn', '')
  btn.id = 'spkBtn'; btn.type = 'button'; btn.style.display = 'flex'; btn.title = 'Use phones as speakers for this film'
  var cast = document.getElementById('castBtn')
  if (cast && cast.parentNode) cast.parentNode.insertBefore(btn, cast); else document.body.appendChild(btn)

  var panel = el('div', '', ''); panel.id = 'spkPanel'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Phone speakers')
  var head = el('div', 'spk-head', ''); head.appendChild(el('strong', '', 'Phone speakers'))
  var closeX = el('button', 'spk-x', 'Close'); closeX.type = 'button'; head.appendChild(closeX)
  var body = el('div', 'spk-body', '')
  panel.appendChild(head); panel.appendChild(body)
  document.body.appendChild(panel)
  panel.addEventListener('keydown', function (e) { e.stopPropagation() })
  panel.addEventListener('keyup', function (e) { e.stopPropagation() })

  var overlay = el('div', '', ''); overlay.id = 'spkOverlay'
  var banner = el('div', '', ''); banner.id = 'spkBanner'
  var tap = el('button', '', 'Tap to turn on the TV\'s share of the sound'); tap.id = 'spkTap'; tap.type = 'button'
  var toastEl = el('div', '', ''); toastEl.id = 'spkToast'
  document.body.appendChild(overlay); document.body.appendChild(banner); document.body.appendChild(tap); document.body.appendChild(toastEl)
  var toastTimer = 0
  function toast(msg) { toastEl.textContent = msg; toastEl.style.display = 'block'; clearTimeout(toastTimer); toastTimer = setTimeout(function () { toastEl.style.display = 'none' }, 4500) }
  function setOpen(on) { S.open = on; panel.className = on ? 'open' : ''; if (on) render(); paintOverlay() }
  btn.onclick = function () { setOpen(!S.open) }
  closeX.onclick = function () { setOpen(false) }
  tap.onclick = function () { tap.style.display = 'none'; if (S.engine) S.engine.unlock().then(tick) }

  function renderButton() {
    var n = S.snap ? S.snap.room.presentCount : 0
    btn.textContent = S.snap ? '\uD83D\uDCF1 ' + n + ' phone' + (n === 1 ? '' : 's') : '\uD83D\uDCF1 Phone speakers'
  }

  // ---------------------------------------------------------------- starting and stopping
  function makeContext() {
    if (S.ctx) return S.ctx
    var AC = window.AudioContext || window.webkitAudioContext
    try { S.ctx = AC ? new AC({ latencyHint: 'playback' }) : null } catch (e) { try { S.ctx = new AC() } catch (x) { S.ctx = null } }
    return S.ctx
  }
  function begin(res) {
    S.code = res.code; S.token = res.token; S.joinUrl = res.joinUrl || ''; S.qrSvg = res.qrSvg || ''; S.otherUrls = Array.isArray(res.otherUrls) ? res.otherUrls.slice(0, 3) : []
    store('spk.code', S.code)
    var ctx = makeContext()
    S.link = B.createLink({
      fetch: function (u, o) { return fetch(u, o) }, base: API, getToken: function () { return S.token }, perfNow: clk,
      setTimeout: function (f, ms) { return setTimeout(f, ms) }, clearTimeout: function (t) { clearTimeout(t) }, TextDecoder: window.TextDecoder, AbortController: window.AbortController
    })
    S.engine = ctx ? B.createEngine({
      ctx: ctx, perfNow: clk, clock: S.link.clock,
      fetchPiece: function (feed, n, seq, signal) {
        return fetch('/speakers/audio/' + enc(feed) + '/' + n + '.wav', { headers: { 'X-Speaker-Token': S.token, 'X-Speaker-Seq': String(seq) }, cache: 'no-store', credentials: 'omit', signal: signal })
          .then(function (r) { if (r.status === 409) { var e = new Error('stale'); e.stale = true; throw e } if (!r.ok) { var f = new Error('HTTP ' + r.status); f.status = r.status; throw f } return r.arrayBuffer() })
      }
    }) : null
    S.link.onSnapshot = onSnapshot
    S.link.onTimeline = onTimeline
    S.link.onClock = function () { tick(); report(true) }
    S.link.onClosed = function () { ended('The phone speakers were closed.') }
    S.link.onKicked = function () { ended('Another screen took over this room.') }
    S.link.onAuthLost = function () { ended('The room is gone. Start it again.') }
    S.link.onState = function () { render(); paintOverlay() }
    if (S.engine) S.engine.onChange = function () { report(false) }
    S.link.connect()
    clearInterval(S.tickTimer); S.tickTimer = setInterval(tick, 250)
    if (ctx && ctx.state !== 'running') { if (S.engine) S.engine.unlock().then(function () { if (ctx.state !== 'running') tap.style.display = 'block' }) }
    setOpen(true)
  }
  function ended(msg) {
    clearInterval(S.tickTimer); clearTimeout(S.startTimer)
    if (S.link) { try { S.link.close() } catch (e) {} }
    if (S.engine) { try { S.engine.stop() } catch (e) {} }
    S.link = null; S.engine = null; S.snap = null; S.token = ''; S.code = ''
    store('spk.code', null)
    restoreSound(); banner.style.display = 'none'; tap.style.display = 'none'
    renderButton(); render(); paintOverlay()
    if (msg) toast(msg)
  }
  function startRoom() {
    if (S.connecting) return
    S.connecting = true; render()
    makeContext() // this click is the "gesture" the browser wants before the TV may play any sound
    ownerPost('/create', { kind: CFG.kind, id: CFG.id, title: CFG.title }).then(function (r) {
      S.connecting = false
      if (!r || !r.ok) { S.error = (r && r.message) || 'Could not start phone speakers.'; render(); return }
      S.error = ''
      begin(r)
    })
  }
  function resume(code) {
    S.connecting = true
    ownerPost('/resume', { code: code }).then(function (r) {
      S.connecting = false
      if (!r || !r.ok) { store('spk.code', null); render(); return }
      begin(r)
    })
  }
  function closeRoom() { var t = S.link; hostPost('/close', {}); if (t) ended('You ended the phone speakers.') }

  // ---------------------------------------------------------------- receiving the room
  var snapSeq = -1
  function onSnapshot(d) {
    if (!d || !d.room || !d.you) return
    if (typeof d.eventSeq === 'number' && d.eventSeq < snapSeq) return
    snapSeq = d.eventSeq
    S.snap = d
    var tl = d.room.timeline
    if (tl.seq !== S.lastSeq) { S.lastSeq = tl.seq; S.appliedSeq = tl.seq; S.ignoreSync = clk() + 1500 }
    feedEngine()
    if (d.room.beep && S.engine) S.engine.scheduleBeep(d.room.beep, 'tv')
    renderButton(); paintBanner(); paintOverlay(); if (S.open) render()
    tick()
  }
  function onTimeline(d) {
    if (!S.snap || !d || !d.timeline) return
    if (d.timeline.seq !== S.lastSeq) { S.lastSeq = d.timeline.seq; S.appliedSeq = d.timeline.seq; S.ignoreSync = clk() + 1500 }
    S.snap.room.timeline = d.timeline; S.snap.room.hold = d.hold
    feedEngine(); paintBanner(); tick()
  }
  function feedEngine() {
    if (!S.engine || !S.snap) return
    var d = S.snap
    var vol = v.volume > 0 ? 20 * Math.log10(v.volume) : -24
    S.engine.setPlan({
      timeline: d.room.timeline, hold: !!d.room.hold, segSec: d.room.segSec, duration: d.room.duration, layers: d.you.layers,
      hp: 0, lp: 0, gainDb: Math.max(-24, Math.min(12, vol)), trimMs: d.you.trimMs, avOffsetMs: d.room.avOffsetMs, muted: S.userMuted, stereo: true
    })
  }

  // ---------------------------------------------------------------- keeping <video> on the timeline
  function serverNow() { return S.link.clock.hostNow() }
  function tvSoundNeeded() {
    // the film's own sound plays when no phone is here, or the speed is not 1x (phones stay quiet then)
    if (!S.snap) return true
    return S.snap.host.tv.native || S.snap.room.timeline.rate !== 1
  }
  function restoreSound() { if (S.forcedMute) { v.muted = S.userMuted; S.forcedMute = false } }
  function applySound() {
    var need = tvSoundNeeded()
    if (need) restoreSound()
    else { if (!S.forcedMute) { S.userMuted = v.muted; S.forcedMute = true } v.muted = true }
  }
  function tick() {
    if (!S.snap || !S.link || !S.mediaOk) return
    if (S.engine) S.engine.tick()
    applySound()
    if (!S.link.clock.ready()) return
    var tl = S.snap.room.timeline, hold = S.snap.room.hold
    var now = serverNow()
    var running = tl.state === 'playing' && now >= tl.anchorAt && !hold
    if (running) {
      clearTimeout(S.startTimer); S.startTimer = 0
      var expected = B.positionAt(tl, now)
      if (v.paused) {
        S.ignorePlay = clk() + 900
        if (Math.abs(v.currentTime - expected) > 0.4) { S.ignoreSeek = clk() + 3000; try { v.currentTime = expected + 0.15 } catch (e) {} }
        var pr = v.play(); if (pr && pr.catch) pr.catch(function (e) { if (e && e.name === 'NotAllowedError') toast('Press play on the film to start it.') })
      } else if (S.alignSeq !== tl.seq) {
        S.alignSeq = tl.seq
        if (Math.abs(v.currentTime - expected) > 0.25) { S.ignoreSeek = clk() + 3000; try { v.currentTime = expected + 0.15 } catch (e) {} }
      }
      if (v.playbackRate !== tl.rate) { try { v.playbackRate = tl.rate } catch (e) {} }
      measure()
    } else {
      if (!v.paused) { S.ignorePause = clk() + 900; v.pause() }
      if (tl.state === 'playing' && !hold && tl.anchorAt > now) {
        // a synchronised start is coming: sit on the first frame, and press play a moment early (video needs a moment to start)
        var wait = tl.anchorAt - now - S.startLat
        if (!S.startTimer && wait > 0 && wait < 3000) S.startTimer = setTimeout(function () { S.startTimer = 0; tick() }, wait)
        else if (wait <= 0 && !S.startTimer) { S.startTimer = 0; var pr2 = null; S.ignorePlay = clk() + 900; pr2 = v.play(); if (pr2 && pr2.catch) pr2.catch(function () {}) }
      }
      var target = tl.anchorPos
      if (!v.seeking && Math.abs(v.currentTime - target) > 0.15) { S.ignoreSeek = clk() + 3000; try { v.currentTime = target } catch (e) {} }
      if (v.playbackRate !== tl.rate) { try { v.playbackRate = tl.rate } catch (e) {} }
    }
    report(false)
    paintOverlay()
  }

  // ---------------------------------------------------------------- telling the room where the picture is
  var hasFrames = typeof v.requestVideoFrameCallback === 'function'
  function watchFrames() {
    if (!hasFrames) return
    var cb = function (nowMs, meta) {
      S.frame = { media: meta.mediaTime, at: meta.expectedDisplayTime || nowMs }
      v.requestVideoFrameCallback(cb)
    }
    v.requestVideoFrameCallback(cb)
  }
  watchFrames()
  function measure() {
    var t = clk()
    if (t - S.lastSync < 1000 || t < S.ignoreSync || v.paused || v.seeking || v.readyState < 3) return
    S.lastSync = t
    var pos, at
    if (S.frame && t - S.frame.at < 400 && t - S.frame.at > -100) { pos = S.frame.media; at = S.frame.at + S.link.clock.offsetMs() }
    else { pos = v.currentTime; at = t + S.link.clock.offsetMs() }
    hostPost('/sync', { seq: S.appliedSeq, pos: pos, at: at })
  }
  function report(force) {
    if (!S.link || !S.snap) return
    var tl = S.snap.room.timeline
    var target = tl.anchorPos
    var atPlace = tl.state === 'playing' && !S.snap.room.hold ? true : Math.abs(v.currentTime - target) < 0.4
    var ready = v.readyState >= 3 && !v.seeking && atPlace && (!S.engine || S.engine.ready)
    var st = S.engine ? S.engine.status(S.link.lastRtt) : { errMs: -1, driftMs: 0, rttMs: 0, outLatencyMs: -1 }
    var body = { state: v.paused ? 'paused' : 'playing', unlocked: true, ready: ready, seq: S.appliedSeq, errMs: st.errMs, driftMs: st.driftMs, rttMs: st.rttMs, outLatencyMs: st.outLatencyMs }
    var key = (ready ? '1' : '0') + ':' + S.appliedSeq + ':' + body.state
    var t = clk()
    if (!force && key === S.lastReport && t - S.lastReportAt < 4000) return
    S.lastReport = key; S.lastReportAt = t
    S.link.post('/status', { status: body })
  }
  ;['canplay', 'playing', 'loadeddata', 'seeked'].forEach(function (n) { v.addEventListener(n, function () { if (S.link) setTimeout(function () { report(true) }, 40) }) })
  ;['waiting', 'seeking', 'stalled'].forEach(function (n) { v.addEventListener(n, function () { if (S.link) setTimeout(function () { report(true) }, 250) }) })
  v.addEventListener('playing', function () {
    if (S.link && S.startPlannedAt) { S.startLat = Math.max(0, Math.min(400, S.startLat * 0.5 + (clk() - S.startPlannedAt) * 0.5)); S.startPlannedAt = 0 }
  })
  v.addEventListener('volumechange', function () {
    if (!S.link) return
    if (!S.forcedMute) S.userMuted = v.muted
    feedEngine()
  })

  // ---------------------------------------------------------------- what the person does to the film becomes commands
  function command(c) { c.cid = Math.random().toString(36).slice(2, 12); return hostPost('/command', c).then(function (r) { if (r && r.ok === false && r.message) toast(r.message) }) }
  v.addEventListener('play', function () {
    if (!S.snap || !S.link || clk() < S.ignorePlay) return
    var tl = S.snap.room.timeline
    if (tl.state === 'playing' || S.snap.room.hold) return
    S.startPlannedAt = 0
    command({ type: 'play' })
    // the room starts it a moment from now, together with the phones: hold the picture on its frame until then
    S.ignorePause = clk() + 900; v.pause()
  })
  v.addEventListener('pause', function () {
    if (!S.snap || !S.link || clk() < S.ignorePause || v.ended || v.seeking) return
    var tl = S.snap.room.timeline
    if (tl.state !== 'playing' || S.snap.room.hold) return
    command({ type: 'pause', pos: v.currentTime })
  })
  v.addEventListener('seeked', function () {
    if (!S.snap || !S.link) return
    if (clk() < S.ignoreSeek) { S.ignoreSeek = 0; return }
    var tl = S.snap.room.timeline
    var target = B.positionAt(tl, serverNow())
    if (Math.abs((v.currentTime || 0) - target) < 0.6 && tl.state !== 'playing') return
    command({ type: 'seek', pos: v.currentTime })
  })
  v.addEventListener('ratechange', function () {
    if (!S.snap || !S.link) return
    var r = Math.round(v.playbackRate * 100) / 100
    if (r !== S.snap.room.timeline.rate && [0.5, 0.75, 1, 1.25, 1.5, 2].indexOf(r) >= 0) command({ type: 'rate', rate: r })
  })
  v.addEventListener('ended', function () { if (S.snap && S.link && S.snap.room.timeline.state === 'playing') command({ type: 'pause', pos: v.duration }) })
  var stallTimer = 0
  v.addEventListener('waiting', function () {
    if (!S.snap || !S.link) return
    clearTimeout(stallTimer)
    // the picture froze while the film was running: stop the room here, wait until the picture is back, then start together
    stallTimer = setTimeout(function () {
      if (S.snap && v.readyState < 3 && S.snap.room.timeline.state === 'playing' && !S.snap.room.hold) command({ type: 'seek', pos: v.currentTime })
    }, 500)
  })

  // ---------------------------------------------------------------- drawing
  function button(label, onclick, cls) { var b = el('button', cls || 'spk-b', label); b.type = 'button'; b.onclick = onclick; return b }
  function levelDot(level) { var d = el('span', 'spk-dot', ''); d.setAttribute('data-level', /^(good|warn|bad|away|locked|syncing)$/.test(level) ? level : 'away'); return d }
  var LEVEL_TEXT = { good: 'in sync', warn: 'adjusting', bad: 'out of sync', away: 'away', locked: 'needs a tap', syncing: 'syncing' }
  function svgNode(text) {
    try {
      var doc = new DOMParser().parseFromString(text, 'image/svg+xml')
      var root = doc.documentElement
      if (!root || root.nodeName !== 'svg' || doc.getElementsByTagName('script').length) return null
      return document.importNode(root, true)
    } catch (e) { return null }
  }

  function paintBanner() {
    var h = S.snap && S.snap.room.hold
    if (h && h.waitingFor && h.waitingFor.length) {
      banner.textContent = 'Waiting for ' + h.waitingFor.slice(0, 3).join(', ') + (h.waitingFor.length > 3 ? ' and others' : '') + '...'
      banner.style.display = 'block'
    } else banner.style.display = 'none'
  }
  function paintOverlay() {
    clear(overlay)
    if (!S.snap || !S.link) { overlay.style.display = 'none'; return }
    var g = S.snap.host.guests
    var problem = g.some(function (x) { return x.connected && (x.level === 'bad' || x.level === 'warn' || x.level === 'locked') })
    var show = S.open || !g.length || problem || clk() < S.overlayUntil
    overlay.style.display = show ? 'block' : 'none'
    overlay.style.opacity = S.open ? '1' : '.92'
    var head2 = el('div', 'spk-ov-h', '')
    head2.appendChild(el('span', '', '\uD83D\uDCF1 ' + S.snap.room.presentCount + ' phone speaker' + (S.snap.room.presentCount === 1 ? '' : 's')))
    if (S.link.state !== 'open') head2.appendChild(el('em', '', ' - reconnecting'))
    overlay.appendChild(head2)
    if (!g.length) {
      overlay.appendChild(el('div', 'spk-ov-n', 'Open the Phone speakers panel and scan the QR code with a phone.'))
      return
    }
    g.forEach(function (x) {
      var row = el('div', 'spk-ov-r', '')
      row.appendChild(levelDot(x.connected ? x.level : 'away'))
      row.appendChild(el('span', 'spk-ov-name', x.name))
      row.appendChild(el('small', '', x.seatLabel + (x.connected ? ' - ' + (LEVEL_TEXT[x.level] || '') + (x.estMs !== null && x.estMs !== undefined ? ' +/-' + Math.round(x.estMs) + ' ms' : '') : ' - away')))
      overlay.appendChild(row)
    })
    var t = S.snap.host.tv
    if (t.layers.length) overlay.appendChild(el('div', 'spk-ov-n', 'The TV is playing: ' + t.layers.map(function (l) { return l.feed }).join(', ')))
    else if (t.native) overlay.appendChild(el('div', 'spk-ov-n', 'No phone is playing yet, so the TV keeps its own sound.'))
  }

  function seatOptions(g, sel) {
    var seats = S.snap.host.seats
    seats.forEach(function (s) { var o = el('option', '', s.label); o.value = s.seat; if (g.seat === s.seat) o.selected = true; sel.appendChild(o) })
    if (S.snap.room.mode === 'everyone' || g.seat === 'DM') { var m = el('option', '', 'Everything (mix)'); m.value = 'DM'; if (g.seat === 'DM') m.selected = true; sel.appendChild(m) }
    var sp = el('option', '', 'Spare (no channel)'); sp.value = 'off'; if (g.seat === 'off') sp.selected = true; sel.appendChild(sp)
  }
  var MODE_LABEL = { surround: 'Surround', stereo: 'Stereo pair', everyone: 'Everyone (music-style)' }
  var MODE_HELP = { surround: 'Each phone plays one speaker of the film\'s surround sound.', stereo: 'Phones alternate left / right; more phones just add volume to a side.', everyone: 'Every phone plays the whole sound, like a group of speakers.' }

  function diagram(host) {
    var wrap = el('div', 'spk-map', '')
    var seats = host.seats.map(function (s) { return s.seat })
    var layout = seats.indexOf('FL') >= 0 ? [['FL', 'FC', 'FR'], ['SL', 'LFE', 'SR'], ['BL', '', 'BR']] : [['DL', '', 'DR']]
    layout.forEach(function (row) {
      row.forEach(function (seat) {
        var cell = el('div', 'spk-cell', '')
        if (!seat || seats.indexOf(seat) < 0) { cell.className += ' empty'; wrap.appendChild(cell); return }
        var lab = host.seats.filter(function (s) { return s.seat === seat })[0]
        cell.appendChild(el('small', '', lab.short))
        var who = host.guests.filter(function (g) { return g.seat === seat })
        if (who.length) { who.forEach(function (g) { var line = el('div', 'spk-who', ''); line.appendChild(levelDot(g.connected ? g.level : 'away')); line.appendChild(el('span', '', g.name)); cell.appendChild(line) }) }
        else cell.appendChild(el('div', 'spk-free', S.snap.host.tv.layers.some(function (l) { return l.feed === seat }) ? 'the TV' : 'free'))
        wrap.appendChild(cell)
      })
    })
    return wrap
  }

  function render() {
    clear(body)
    if (!S.link || !S.snap) {
      body.appendChild(el('p', 'spk-note', 'Turn your guests\' phones into surround speakers. The screen plays the picture, and each phone plays one channel of the film\'s sound, in sync. Everyone joins with a QR code: no account needed, and it works on your home Wi-Fi with no internet.'))
      if (S.error) body.appendChild(el('p', 'spk-err', S.error))
      var start = button(S.connecting ? 'Starting...' : 'Start phone speakers for this film', startRoom, 'spk-b spk-primary')
      start.disabled = S.connecting
      body.appendChild(start)
      body.appendChild(el('p', 'spk-note', 'Phones only need to be on the same Wi-Fi. Nothing is recorded or sent anywhere.'))
      return
    }
    var d = S.snap, host = d.host
    body.appendChild(el('div', 'spk-title', d.room.title || 'Untitled'))
    body.appendChild(el('div', 'spk-note', MODE_LABEL[d.room.mode] + ' - this film has ' + d.room.source))
    if (!S.engine || (S.ctx && S.ctx.state !== 'running')) {
      var enable = button('Turn on the TV\'s share of the sound', function () { if (S.engine) S.engine.unlock().then(function () { render() }) }, 'spk-b spk-warn')
      body.appendChild(enable)
    }

    // ---- the QR code
    var qr = el('div', 'spk-qr', '')
    var node = S.qrSvg ? svgNode(S.qrSvg) : null
    if (node) { node.setAttribute('width', '190'); node.setAttribute('height', '190'); qr.appendChild(node) }
    var linkBox = el('div', 'spk-link', '')
    linkBox.appendChild(el('div', '', 'Scan with a phone camera, or open:'))
    var url = el('input', 'spk-url', ''); url.type = 'text'; url.readOnly = true; url.value = S.joinUrl; url.setAttribute('aria-label', 'Address for phones to open')
    url.onfocus = function () { url.select() }
    linkBox.appendChild(url)
    linkBox.appendChild(button('Copy link', function () {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(S.joinUrl).then(function () { toast('Link copied.') }, function () { url.select() })
      else url.select()
    }, 'spk-s'))
    linkBox.appendChild(el('small', '', 'Anyone with this link can join this one room while it is open. It stops working when you close the room.'))
    if (S.otherUrls && S.otherUrls.length) linkBox.appendChild(el('small', '', 'QR code not working? This computer is also at: ' + S.otherUrls.map(function (u) { return u.replace(/\/speakers\/join.*$/, '') }).join(', ')))
    qr.appendChild(linkBox)
    body.appendChild(qr)
    var lock = el('label', 'spk-chk', ''); var lb = el('input'); lb.type = 'checkbox'; lb.checked = !!d.room.locked
    lb.onchange = function () { hostPost('/settings', { settings: { locked: lb.checked } }) }
    lock.appendChild(lb); lock.appendChild(el('span', '', ' No new phones can join (everyone already here stays)'))
    body.appendChild(lock)

    // ---- presets
    body.appendChild(el('h4', '', 'Layout'))
    var modes = el('div', 'spk-modes', '')
    ;['surround', 'stereo', 'everyone'].forEach(function (m) {
      var b = button(MODE_LABEL[m], function () { hostPost('/settings', { settings: { mode: m } }) }, 'spk-b' + (d.room.mode === m ? ' spk-on' : ''))
      b.setAttribute('aria-pressed', d.room.mode === m ? 'true' : 'false'); modes.appendChild(b)
    })
    body.appendChild(modes)
    body.appendChild(el('div', 'spk-note', MODE_HELP[d.room.mode]))
    body.appendChild(diagram(host))

    // ---- seating chart
    body.appendChild(el('h4', '', 'Phones here (' + host.guests.length + ')'))
    if (!host.guests.length) body.appendChild(el('div', 'spk-note', 'Nobody yet. Phones get a seat in the order they join: front left, front right, centre, then the surrounds and the bass.'))
    host.guests.forEach(function (g) {
      var row = el('div', 'spk-g', '')
      var top = el('div', 'spk-g-top', '')
      top.appendChild(levelDot(g.connected ? g.level : 'away'))
      top.appendChild(el('span', 'spk-g-name', g.name))
      top.appendChild(el('small', '', (g.connected ? (LEVEL_TEXT[g.level] || '') + (g.estMs !== null && g.estMs !== undefined ? ' +/-' + Math.round(g.estMs) + ' ms' : '') : 'away')))
      var sel = el('select', 'spk-sel', ''); sel.setAttribute('aria-label', 'Channel for ' + g.name); seatOptions(g, sel)
      sel.onchange = function () { hostPost('/seat', { gid: g.gid, seat: sel.value }) }
      top.appendChild(sel)
      row.appendChild(top)
      var ctl = el('div', 'spk-g-ctl', '')
      ctl.appendChild(el('small', '', 'Timing'))
      ctl.appendChild(button('-', function () { S.link.post('/tune', { target: g.gid, patch: { trimMs: g.trimMs - 5 } }) }, 'spk-s'))
      ctl.appendChild(el('span', 'spk-trim', (g.trimMs > 0 ? '+' : '') + g.trimMs + ' ms'))
      ctl.appendChild(button('+', function () { S.link.post('/tune', { target: g.gid, patch: { trimMs: g.trimMs + 5 } }) }, 'spk-s'))
      ctl.appendChild(button(g.muted ? 'Unmute' : 'Mute', function () { S.link.post('/tune', { target: g.gid, patch: { muted: !g.muted } }) }, 'spk-s'))
      ctl.appendChild(button('Remove', function () { hostPost('/kick', { gid: g.gid }) }, 'spk-s'))
      row.appendChild(ctl)
      var extras = []
      if (g.btLikely) extras.push('Bluetooth speaker? ' + (g.outLatencyMs >= 0 ? 'It reports about ' + g.outLatencyMs + ' ms of delay. ' : '') + 'Use the beep test and the timing buttons.')
      if (!g.unlocked && g.connected) extras.push('This phone has not tapped "Enable audio" yet.')
      if (g.layers.length > 1) extras.push('Also playing: ' + g.layers.slice(1).map(function (l) { return l.feed }).join(', ') + ' (a phone that left).')
      extras.forEach(function (t) { row.appendChild(el('div', 'spk-warnline', t)) })
      body.appendChild(row)
    })
    body.appendChild(button('Seat everyone in join order again', function () { hostPost('/autoseat', {}) }, 'spk-s'))

    // ---- missing channels
    body.appendChild(el('h4', '', 'When a phone leaves'))
    var fill = el('select', 'spk-sel', '')
    ;[['tv', 'The TV plays the missing channel'], ['neighbour', 'The nearest phone plays it too'], ['off', 'Leave it silent']].forEach(function (o) { var op = el('option', '', o[1]); op.value = o[0]; if (d.room.fillIn === o[0]) op.selected = true; fill.appendChild(op) })
    fill.onchange = function () { hostPost('/settings', { settings: { fillIn: fill.value } }) }
    body.appendChild(fill)
    if (d.room.missing.length) body.appendChild(el('div', 'spk-note', 'No phone on: ' + d.room.missing.join(', ') + (d.room.tvFills.length ? ' (the TV is playing them)' : d.room.dropped.length ? ' (silent)' : '')))
    body.appendChild(el('div', 'spk-note', 'With no phone at all, the TV plays the film\'s own sound.'))

    // ---- calibration
    body.appendChild(el('h4', '', 'Line them up'))
    var bp = el('div', 'spk-modes', '')
    bp.appendChild(button('Beep in turn', function () { hostPost('/beep', { action: 'start', pattern: 'turns' }) }, 'spk-b'))
    bp.appendChild(button('Beep together', function () { hostPost('/beep', { action: 'start', pattern: 'together' }) }, 'spk-b'))
    bp.appendChild(button('Stop', function () { hostPost('/beep', { action: 'stop' }) }, 'spk-b'))
    body.appendChild(bp)
    body.appendChild(el('div', 'spk-note', 'Every speaker beeps at its own time. If one is late or early, change its timing with the buttons above. "Together" should sound like one click.'))
    var avRow = el('div', 'spk-row', '')
    avRow.appendChild(el('span', '', 'Picture delay'))
    var av = el('input', 'spk-range'); av.type = 'range'; av.min = '-300'; av.max = '300'; av.step = '10'; av.value = String(d.room.avOffsetMs); av.setAttribute('aria-label', 'Picture delay in milliseconds')
    var avVal = el('span', 'spk-trim', d.room.avOffsetMs + ' ms')
    av.oninput = function () { avVal.textContent = av.value + ' ms' }
    av.onchange = function () { hostPost('/settings', { settings: { avOffsetMs: Number(av.value) } }) }
    avRow.appendChild(av); avRow.appendChild(avVal)
    body.appendChild(avRow)
    body.appendChild(el('div', 'spk-note', 'If the picture is a little later than the sound (some TVs do that), move this to the right.'))
    body.appendChild(button('End phone speakers', closeRoom, 'spk-b spk-danger'))
  }

  // ---------------------------------------------------------------- start up
  renderButton(); render()
  var fromUrl = ''
  try {
    var sp = new URLSearchParams(location.search)
    fromUrl = sp.get('spk') || ''
    if (fromUrl) { sp.delete('spk'); history.replaceState(null, '', location.pathname + (sp.toString() ? '?' + sp.toString() : '') + location.hash) }
  } catch (e) {}
  var startCode = fromUrl || stored('spk.code')
  if (startCode && /^[0-9A-Za-z-]{20,40}$/.test(startCode)) resume(startCode)
  window.addEventListener('pagehide', function () { clearInterval(S.tickTimer) })
  document.addEventListener('mousemove', function () { S.overlayUntil = clk() + 5000; if (S.link) paintOverlay() })
  setInterval(function () { if (S.link && S.snap && clk() > S.overlayUntil) paintOverlay() }, 1500)
}
/* eslint-enable no-undef */

const PANEL_CSS = `
#spkPanel{position:fixed;right:12px;bottom:72px;width:min(380px,calc(100vw - 24px));max-height:78vh;overflow:auto;z-index:64;display:none;background:#16161c;color:#fff;border-radius:12px;border:1px solid rgba(255,255,255,.18);box-shadow:0 8px 28px rgba(0,0,0,.6);font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:14px;box-sizing:border-box}
#spkPanel.open{display:block}
#spkPanel .spk-head{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.12)}
#spkPanel .spk-x{background:#2a2a35;color:#fff;border:0;border-radius:8px;padding:6px 10px;cursor:pointer}
#spkPanel .spk-body{padding:10px 12px 14px}
#spkPanel h4{margin:14px 0 6px;font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:#aab}
#spkPanel .spk-note{color:#aab;font-size:13px;margin:6px 0}#spkPanel .spk-err{color:#ffb3ba}
#spkPanel .spk-title{font-weight:700;margin:2px 0 4px;word-break:break-word;font-size:16px}
#spkPanel .spk-b{background:#2a2f3a;color:#fff;border:1px solid rgba(255,255,255,.22);border-radius:8px;padding:8px 12px;font-size:14px;cursor:pointer;margin:4px 6px 4px 0}
#spkPanel .spk-primary{background:#4f9dff;border-color:#4f9dff;width:100%}#spkPanel .spk-warn{background:#f0b429;color:#241a00;border-color:#f0b429;width:100%}
#spkPanel .spk-on{background:#4f9dff;border-color:#4f9dff}#spkPanel .spk-danger{margin-top:14px;border-color:#c0504d}
#spkPanel .spk-s{background:#2a2f3a;color:#fff;border:1px solid rgba(255,255,255,.22);border-radius:6px;padding:3px 9px;font-size:13px;cursor:pointer;margin:2px 4px 2px 0}
#spkPanel .spk-sel,#spkPanel .spk-url{background:#0e0e12;color:#fff;border:1px solid #333;border-radius:6px;padding:6px 8px;width:100%;box-sizing:border-box;font-size:13px}
#spkPanel .spk-qr{display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap;margin:8px 0}#spkPanel .spk-qr svg{border-radius:8px;background:#fff;flex:none}
#spkPanel .spk-link{flex:1;min-width:150px;font-size:13px}#spkPanel .spk-link small{display:block;color:#99a;margin-top:6px}
#spkPanel .spk-chk{display:block;margin:6px 0;font-size:13px}
#spkPanel .spk-modes{display:flex;flex-wrap:wrap}
#spkPanel .spk-map{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin:8px 0}
#spkPanel .spk-cell{background:#0e0e12;border-radius:8px;padding:6px;min-height:52px;text-align:center;font-size:12px}#spkPanel .spk-cell.empty{background:transparent}
#spkPanel .spk-cell small{color:#9cf;display:block}#spkPanel .spk-who{display:flex;gap:5px;align-items:center;justify-content:center;word-break:break-word}#spkPanel .spk-free{color:#778}
#spkPanel .spk-g{background:#1d1d26;border-radius:8px;padding:8px;margin:6px 0}
#spkPanel .spk-g-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap}#spkPanel .spk-g-top .spk-sel{width:auto;flex:1;min-width:130px}
#spkPanel .spk-g-name{font-weight:600;word-break:break-word}#spkPanel .spk-g-top small{color:#99a}
#spkPanel .spk-g-ctl{display:flex;align-items:center;gap:4px;flex-wrap:wrap;margin-top:6px}#spkPanel .spk-g-ctl small{color:#99a;margin-right:4px}
#spkPanel .spk-trim{min-width:58px;text-align:center;font-variant-numeric:tabular-nums}
#spkPanel .spk-warnline{color:#f0d080;font-size:12px;margin-top:4px}
#spkPanel .spk-row{display:flex;align-items:center;gap:8px;margin:8px 0}#spkPanel .spk-range{flex:1}
.spk-dot{width:11px;height:11px;border-radius:50%;background:#666;display:inline-block;flex:none}
.spk-dot[data-level=good]{background:#3ecf7a}.spk-dot[data-level=warn],.spk-dot[data-level=locked]{background:#f0b429}.spk-dot[data-level=bad]{background:#f0616d}.spk-dot[data-level=syncing]{background:#5aa9ff}
#spkOverlay{position:fixed;top:64px;right:12px;z-index:60;display:none;background:rgba(18,20,26,.9);color:#fff;border:1px solid rgba(255,255,255,.18);border-radius:12px;padding:8px 12px;font:14px system-ui,Segoe UI,Arial,sans-serif;max-width:min(340px,80vw);pointer-events:none}
#spkOverlay .spk-ov-h{font-weight:700;margin-bottom:4px}#spkOverlay .spk-ov-r{display:flex;gap:7px;align-items:center;padding:2px 0}#spkOverlay .spk-ov-r small{color:#aab}
#spkOverlay .spk-ov-name{font-weight:600}#spkOverlay .spk-ov-n{color:#aab;font-size:12px;margin-top:4px}
#spkBanner{position:fixed;top:64px;left:50%;transform:translateX(-50%);z-index:61;display:none;background:rgba(20,22,28,.92);color:#fff;border:1px solid rgba(255,255,255,.2);border-radius:999px;padding:8px 16px;font:14px system-ui,Segoe UI,Arial,sans-serif;max-width:90vw;text-align:center}
#spkToast{position:fixed;left:50%;bottom:96px;transform:translateX(-50%);z-index:65;display:none;background:rgba(20,22,28,.95);color:#fff;border-radius:8px;padding:8px 14px;font:14px system-ui,Segoe UI,Arial,sans-serif;max-width:90vw}
#spkTap{position:fixed;left:50%;top:60%;transform:translate(-50%,-50%);z-index:65;display:none;background:#f0b429;color:#241a00;border:0;border-radius:12px;padding:14px 22px;font:600 16px system-ui,Segoe UI,Arial,sans-serif;cursor:pointer}
`

/** The block appended to the player page: styles + the shared script + the panel. */
function phoneSpeakersHtml({ kind, mediaId, title } = {}) {
  const cfg = { owner: '/phone-speakers-api', kind: kind === 'tv' ? 'tv' : 'movie', id: String(mediaId || ''), title: String(title || '').slice(0, 120) }
  return `
<style>${PANEL_CSS}</style>
<script src="/speakers/client.js"></script>
<script>
(function(){
(${phoneSpeakersPanel.toString()})(${scriptJson(cfg)});
})();
</script>`
}

module.exports = { phoneSpeakersHtml, phoneSpeakersPanel, PANEL_CSS }
