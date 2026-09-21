'use strict'
// ============================================================================
// watchTogetherWeb.js - the "Watch together" button and panel in the web player.
// ----------------------------------------------------------------------------
// Injected into the /watch and /tvwatch page by streamServer.playerPage (one line, next to the
// Quality & audio panel). Everything here is written as a real function (watchTogetherClient)
// and pasted into the page with toString(), so it is syntax-checked with the rest of the code
// and needs no escaping. The timing maths is watchTogetherSync.js, pasted in the same way, so the
// tests exercise exactly what the browser runs.
//
// What the page does
//   * a button in the top bar opens a panel: start a room (or join with a code / link), the invite
//     link, who is here, chat, emoji reactions, and - for the host - who may control, kick, hand over
//   * receives the room over Server-Sent Events (falls back to polling), keeps the <video id="v">
//     on the shared timeline: play / pause / seek happen for everybody, small drift is corrected by
//     nudging the speed (0.95-1.05x), only a big miss (1.5 s+) seeks
//   * reports "ready / buffering" so the room waits ("Waiting for Sam to buffer...") instead of leaving
//     someone behind
//
// SECURITY: names, titles and chat come from other people. The page NEVER builds HTML from them: every
// piece of room data reaches the screen through textContent (or a validated colour), and the code
// below has no innerHTML / insertAdjacentHTML / document.write at all (a test scans for it).
// ============================================================================

const sync = require('./watchTogetherSync')
const { REACTIONS, RATES, normalizeMedia } = require('./watchTogether')

/* eslint-disable no-undef -- runs in the browser: wt* come from watchTogetherSync, pasted ahead of it */
function watchTogetherClient(CFG) {
  var v = document.getElementById('v')
  if (!v || !window.fetch || !CFG || !CFG.id) return
  var API = CFG.api
  var CODE_RE = /^[0-9A-Za-z-]{20,40}$/
  var S = {
    code: '', pid: '', room: null, es: null, esFails: 0, pollTimer: 0, poll: false, lastChatEvent: 0,
    eventSeq: -1, tlSeq: -1, appliedSeq: 0, hush: 0, nudging: false,
    offset: 0, haveOffset: false, rtt: 0, samples: [], pingTimer: 0, tickTimer: 0,
    ignorePlay: 0, ignorePause: 0, ignoreSeek: 0, lastReport: '', lastReportAt: 0, reportTimer: 0,
    unread: 0, open: false, chat: [], notified: 0
  }
  var clk = function () { return (performance.timeOrigin || 0) + performance.now() }
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

  function post(path, body) {
    return fetch(API + path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'bad_reply' } }) })
      .catch(function () { return { ok: false, error: 'network', message: 'Could not reach the server.' } })
  }
  function get(path) {
    return fetch(API + path, { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'bad_reply' } }) })
      .catch(function () { return { ok: false, error: 'network' } })
  }

  // ---------------------------------------------------------------- the button and panel
  var btn = el('button', 'pbtn', '')
  btn.id = 'wtBtn'; btn.type = 'button'; btn.style.display = 'flex'; btn.title = 'Watch together with friends'
  var cast = document.getElementById('castBtn')
  if (cast && cast.parentNode) cast.parentNode.insertBefore(btn, cast); else document.body.appendChild(btn)

  var panel = el('div', '', ''); panel.id = 'wtPanel'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Watch together')
  var head = el('div', 'wt-head', '')
  head.appendChild(el('strong', '', 'Watch together'))
  var closeBtn = el('button', 'wt-x', 'Close'); closeBtn.type = 'button'
  head.appendChild(closeBtn)
  var body = el('div', 'wt-body', '')
  panel.appendChild(head); panel.appendChild(body)
  document.body.appendChild(panel)
  // Typing in the panel must not trigger the player's own keyboard shortcuts (space, arrows, f...).
  panel.addEventListener('keydown', function (e) { e.stopPropagation() })
  panel.addEventListener('keyup', function (e) { e.stopPropagation() })

  var banner = el('div', '', ''); banner.id = 'wtBanner'
  var floats = el('div', '', ''); floats.id = 'wtFloat'
  var tap = el('button', '', 'Tap to join playback'); tap.id = 'wtTap'; tap.type = 'button'
  var toastEl = el('div', '', ''); toastEl.id = 'wtToast'
  document.body.appendChild(banner); document.body.appendChild(floats); document.body.appendChild(tap); document.body.appendChild(toastEl)

  var toastTimer = 0
  function toast(msg) {
    toastEl.textContent = msg; toastEl.style.display = 'block'
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { toastEl.style.display = 'none' }, 4500)
  }
  function setOpen(on) {
    S.open = on; panel.className = on ? 'open' : ''
    if (on) { S.unread = 0; renderButton() }
  }
  btn.onclick = function () { setOpen(!S.open); if (S.open) render() }
  closeBtn.onclick = function () { setOpen(false) }
  tap.onclick = function () { tap.style.display = 'none'; tick() }

  function renderButton() {
    var n = S.room ? S.room.participants.length : 0
    btn.textContent = S.room ? '\uD83D\uDC65 ' + n + (S.unread ? ' \u2022 ' + S.unread : '') : '\uD83D\uDC65 Watch together'
  }

  // ---------------------------------------------------------------- who am I / what may I do
  function me() {
    if (!S.room) return null
    for (var i = 0; i < S.room.participants.length; i++) if (S.room.participants[i].pid === S.pid) return S.room.participants[i]
    return null
  }
  function isHost() { return !!S.room && S.room.hostPid === S.pid }
  function canControl() { return !!S.room && (isHost() || S.room.settings.control === 'everyone') }
  function mediaMatches() { return !!S.room && S.room.media.kind === CFG.kind && S.room.media.id === CFG.id }
  function safeHref(h) { return typeof h === 'string' && /^\/(tvwatch|watch)\?id=[A-Za-z0-9_%.-]{1,1500}$/.test(h) ? h : '' }
  function goToRoomTitle() {
    var h = safeHref(S.room && S.room.media.href)
    if (h) { store('wt.code', S.code); location.href = h + '&wt=' + enc(S.code) }
  }
  function inviteLink() { return location.origin + '/watch-together/join?code=' + enc(S.code) }

  // ---------------------------------------------------------------- joining and leaving
  function codeFromText(t) {
    var s = String(t || '').trim()
    var m = /[?&]code=([0-9A-Za-z-]+)/.exec(s)
    if (m) s = m[1]
    s = s.replace(/[\s]/g, '')
    return CODE_RE.test(s) ? s : ''
  }
  function enter(code, room, pid, chat) {
    S.code = code; S.pid = pid; store('wt.code', code)
    S.chat = (chat || []).slice(-100)
    for (var i = 0; i < S.chat.length; i++) if (S.chat[i].eventId > S.lastChatEvent) S.lastChatEvent = S.chat[i].eventId
    S.appliedSeq = 0; S.tlSeq = -1; S.eventSeq = -1; S.hush = 0
    applyState(room)
    if (!mediaMatches()) { goToRoomTitle(); return }
    connect(); startClock(); startTick()
    setOpen(true); render()
  }
  function joinWith(code, fromLink) {
    return post('/join', { code: code }).then(function (r) {
      if (!r || !r.ok) {
        if (r && (r.error === 'not_found' || r.error === 'locked')) store('wt.code', null)
        toast((r && r.message) || 'Could not join.'); render(); return
      }
      enter(code, r.room, r.pid, r.chat)
    })
  }
  function createRoom() {
    var ctl = document.getElementById('wtControlSel')
    post('/create', { kind: CFG.kind, id: CFG.id, title: CFG.title, settings: { control: ctl && ctl.value === 'everyone' ? 'everyone' : 'host' } }).then(function (r) {
      if (!r || !r.ok) { toast((r && r.message) || 'Could not start a room.'); return }
      enter(r.code, r.room, r.pid, [])
    })
  }
  function leaveLocal(message) {
    if (S.es) { try { S.es.close() } catch (e) {} S.es = null }
    clearInterval(S.pollTimer); clearInterval(S.pingTimer); clearInterval(S.tickTimer)
    S.poll = false; S.room = null; S.code = ''; S.pid = ''; S.chat = []; S.unread = 0; S.nudging = false
    store('wt.code', null)
    try { v.playbackRate = 1 } catch (e) {}
    banner.style.display = 'none'; tap.style.display = 'none'
    renderButton(); render()
    if (message) toast(message)
  }
  function leave() {
    var c = S.code
    leaveLocal('You left the room.')
    if (c) post('/leave', { code: c })
  }

  // ---------------------------------------------------------------- receiving the room
  function applyState(st) {
    if (!st || !st.timeline || !st.participants) return
    if (typeof st.eventSeq === 'number' && st.eventSeq < S.eventSeq) return
    S.eventSeq = st.eventSeq
    S.room = st
    if (st.timeline.seq !== S.tlSeq) { S.tlSeq = st.timeline.seq; S.hush = 0 }
    if (!S.haveOffset && typeof st.serverNow === 'number') S.offset = st.serverNow - clk() // rough, until the pings land
    renderButton(); render(); paintBanner()
    if (S.tickTimer) tick()
  }
  function paintBanner() {
    var h = S.room && S.room.hold
    if (h && h.waitingFor && h.waitingFor.length && mediaMatches()) {
      banner.textContent = 'Waiting for ' + h.waitingFor.slice(0, 3).join(', ') + (h.waitingFor.length > 3 ? ' and others' : '') + (h.reason === 'buffering' ? ' to buffer\u2026' : '\u2026')
      banner.style.display = 'block'
    } else banner.style.display = 'none'
  }
  function onChat(m) {
    if (!m || typeof m.text !== 'string') return
    if (m.eventId && m.eventId <= S.lastChatEvent) return
    if (m.eventId) S.lastChatEvent = m.eventId
    S.chat.push(m); if (S.chat.length > 100) S.chat.shift()
    if (!S.open) { S.unread++; renderButton() }
    renderChat()
  }
  function onReaction(r) {
    if (!r || typeof r.emoji !== 'string' || CFG.reactions.indexOf(r.emoji) < 0) return
    var f = el('div', 'wt-fl', r.emoji)
    f.style.left = (8 + Math.random() * 70) + '%'
    var who = el('small', '', r.name || ''); f.appendChild(who)
    floats.appendChild(f)
    setTimeout(function () { if (f.parentNode) f.parentNode.removeChild(f) }, 3600)
  }
  function connect() {
    if (S.es) { try { S.es.close() } catch (e) {} S.es = null }
    if (!window.EventSource) return startPolling()
    var es = new EventSource(API + '/events?code=' + enc(S.code))
    S.es = es
    var parse = function (e) { try { return JSON.parse(e.data) } catch (x) { return null } }
    es.addEventListener('state', function (e) { S.esFails = 0; var d = parse(e); if (d && d.you) S.pid = d.you; applyState(d) })
    es.addEventListener('chat', function (e) { onChat(parse(e)) })
    es.addEventListener('reaction', function (e) { onReaction(parse(e)) })
    es.addEventListener('media', function () { goToRoomTitle() })
    es.addEventListener('closed', function () { leaveLocal('The room was closed.') })
    es.addEventListener('kicked', function () { leaveLocal('You were removed from the room.') })
    es.onerror = function () {
      S.esFails++
      if (es.readyState === 2 || S.esFails > 5) { try { es.close() } catch (x) {} if (S.es === es) S.es = null; startPolling() }
    }
  }
  function startPolling() {
    if (S.poll) return
    S.poll = true
    var once = function () {
      if (!S.code) return
      get('/poll?code=' + enc(S.code) + '&since=' + S.lastChatEvent).then(function (r) {
        if (!r || !r.ok) { if (r && r.error === 'not_found') leaveLocal('The room has ended.'); return }
        if (r.pid) S.pid = r.pid
        if (S.room && r.room && r.room.media.id !== S.room.media.id) { applyState(r.room); goToRoomTitle(); return }
        applyState(r.room); (r.chat || []).forEach(onChat)
      })
    }
    S.pollTimer = setInterval(once, 1000); once()
  }

  // ---------------------------------------------------------------- the clock
  function ping() {
    var t0 = clk()
    post('/ping', { t0: t0 }).then(function (r) {
      var t3 = clk()
      if (!r || !r.ok) return
      S.samples.push(wtOffsetSample(t0, r.t1, r.t2, t3)); if (S.samples.length > 8) S.samples.shift()
      var best = wtBestOffset(S.samples, S.haveOffset ? S.offset : undefined)
      if (best) { S.offset = best.offset; S.rtt = best.rtt; S.haveOffset = true }
    })
  }
  function startClock() {
    clearInterval(S.pingTimer); S.samples = []
    var n = 0
    S.pingTimer = setInterval(function () { ping(); n++; if (n === 6) { clearInterval(S.pingTimer); S.pingTimer = setInterval(ping, 20000) } }, 250)
  }

  // ---------------------------------------------------------------- keeping <video> on the timeline
  function startTick() { clearInterval(S.tickTimer); S.tickTimer = setInterval(tick, 250) }
  function tick() {
    if (!S.room || !mediaMatches() || clk() < S.hush) return
    var s = { serverNow: clk() + S.offset, cur: v.currentTime || 0, paused: v.paused, rate: v.playbackRate || 1, ready: v.readyState >= 3, seeking: v.seeking, nudging: S.nudging }
    var plan = wtReconcile(S.room.timeline, s)
    S.nudging = plan.nudging
    for (var i = 0; i < plan.actions.length; i++) {
      var a = plan.actions[i]
      try {
        if (a.type === 'pause') { S.ignorePause = clk() + 800; v.pause() }
        else if (a.type === 'play') {
          S.ignorePlay = clk() + 800
          var pr = v.play()
          if (pr && pr.catch) pr.catch(function (e) { if (e && e.name === 'NotAllowedError') tap.style.display = 'block' })
        } else if (a.type === 'seek') { S.ignoreSeek = clk() + 4000; v.currentTime = Math.max(0, a.to) }
        else if (a.type === 'rate') { v.playbackRate = a.rate }
      } catch (e) {}
    }
    if (!v.paused && tap.style.display === 'block') tap.style.display = 'none'
    if (plan.inSync && S.appliedSeq !== S.room.timeline.seq) { S.appliedSeq = S.room.timeline.seq; report(true) }
    if (plan.phase === 'pending') {
      // A start is coming up: wake right at it rather than up to a quarter second late.
      var ms = S.room.timeline.anchorAt - (clk() + S.offset)
      if (ms > 0 && ms < 400) setTimeout(tick, ms)
    }
  }

  // ---------------------------------------------------------------- telling the room how I am
  function report(force) {
    if (!S.room || !S.code) return
    var ready = v.readyState >= 3 && !v.seeking
    if (ready && !S.appliedSeq) return
    var key = (ready ? '1' : '0') + ':' + S.appliedSeq
    var t = clk()
    if (!force && key === S.lastReport && t - S.lastReportAt < 8000) return
    S.lastReport = key; S.lastReportAt = t
    var body = { code: S.code, ready: ready, seq: S.appliedSeq }
    if (isFinite(v.duration) && v.duration > 0) body.duration = Math.round(v.duration)
    post('/ready', body)
  }
  function scheduleReport(ms) { clearTimeout(S.reportTimer); S.reportTimer = setTimeout(function () { report(false) }, ms) }
  ;['canplay', 'playing', 'loadeddata', 'seeked'].forEach(function (n) { v.addEventListener(n, function () { if (S.room) scheduleReport(50) }) })
  ;['waiting', 'seeking', 'stalled'].forEach(function (n) { v.addEventListener(n, function () { if (S.room) scheduleReport(300) }) })
  setInterval(function () { if (S.room) report(false) }, 5000)

  // ---------------------------------------------------------------- what I do to the room
  function command(c) {
    if (!S.room) return
    c.code = S.code
    c.cid = Math.random().toString(36).slice(2, 12)
    S.hush = clk() + 1500 // do not fight my own click while the server thinks about it
    post('/command', c).then(function (r) {
      // The new state arrives on the stream and lifts the hush; only a refusal lifts it here.
      if (!r || !r.ok) { S.hush = 0; toast((r && r.message) || 'That did not work.') }
    })
  }
  function denied() { toast(isHost() ? '' : 'Only the host can control playback in this room.') }
  v.addEventListener('play', function () {
    if (!S.room || !mediaMatches() || clk() < S.ignorePlay) return
    var tl = S.room.timeline
    if (tl.state === 'playing' || S.room.hold) return
    if (canControl()) command({ type: 'play' }); else denied()
  })
  v.addEventListener('pause', function () {
    if (!S.room || !mediaMatches() || clk() < S.ignorePause || v.ended || v.seeking) return
    var tl = S.room.timeline
    if (tl.state !== 'playing' || S.room.hold) return
    if (canControl()) command({ type: 'pause', pos: v.currentTime }); else denied()
  })
  v.addEventListener('seeked', function () {
    if (!S.room || !mediaMatches()) return
    if (clk() < S.ignoreSeek) { S.ignoreSeek = 0; return }
    var tl = S.room.timeline
    var target = wtPositionAt(tl, clk() + S.offset)
    if (Math.abs((v.currentTime || 0) - target) < 1) return
    if (canControl()) command({ type: 'seek', pos: v.currentTime }); else denied()
  })
  v.addEventListener('ended', function () {
    if (S.room && mediaMatches() && canControl() && S.room.timeline.state === 'playing') command({ type: 'pause', pos: v.duration })
  })

  function sendChat(input) {
    var t = input.value.replace(/\s+/g, ' ').trim()
    if (!t || !S.code) return
    input.value = ''
    post('/chat', { code: S.code, text: t }).then(function (r) { if (!r || !r.ok) toast((r && r.message) || 'Message not sent.') })
  }

  // ---------------------------------------------------------------- drawing the panel (textContent only)
  function button(label, onclick, cls) { var b = el('button', cls || 'wt-b', label); b.type = 'button'; b.onclick = onclick; return b }
  function avatar(p) {
    var a = el('span', 'wt-av', p.initial || '?')
    a.style.background = /^#[0-9a-fA-F]{6}$/.test(p.color || '') ? p.color : '#666'
    return a
  }
  var chatBox = null
  function renderChat() {
    if (!chatBox) return
    clear(chatBox)
    S.chat.forEach(function (m) {
      var row = el('div', 'wt-msg', '')
      var who = el('b', '', m.name || '')
      if (/^#[0-9a-fA-F]{6}$/.test(m.color || '')) who.style.color = m.color
      row.appendChild(who); row.appendChild(el('span', '', ' ' + m.text))
      chatBox.appendChild(row)
    })
    chatBox.scrollTop = chatBox.scrollHeight
  }
  function checkbox(label, on, disabled, onchange) {
    var l = el('label', 'wt-chk', ''); var i = el('input', '', ''); i.type = 'checkbox'; i.checked = !!on; i.disabled = !!disabled
    i.onchange = function () { onchange(i.checked) }
    l.appendChild(i); l.appendChild(el('span', '', ' ' + label)); return l
  }
  function setSettings(patch) { post('/settings', { code: S.code, settings: patch }).then(function (r) { if (!r || !r.ok) toast((r && r.message) || 'That did not work.') }) }

  function render() {
    if (!S.open && S.room) return
    clear(body); chatBox = null
    if (!S.room) {
      body.appendChild(el('p', 'wt-note', 'Watch this together with people who have an account on this server, wherever they are. Everyone stays in step: play, pause and seek happen for all of you.'))
      var ctl = el('select', '', ''); ctl.id = 'wtControlSel'
      var o1 = el('option', '', 'Only I control playback'); o1.value = 'host'
      var o2 = el('option', '', 'Everyone can control playback'); o2.value = 'everyone'
      ctl.appendChild(o1); ctl.appendChild(o2)
      body.appendChild(ctl)
      body.appendChild(button('Start a room for this title', createRoom, 'wt-b wt-primary'))
      body.appendChild(el('p', 'wt-note', 'Have a code or link?'))
      var inp = el('input', '', ''); inp.type = 'text'; inp.placeholder = 'Paste the invite link or code'; inp.maxLength = 200; inp.setAttribute('aria-label', 'Invite link or code')
      body.appendChild(inp)
      body.appendChild(button('Join', function () {
        var c = codeFromText(inp.value)
        if (!c) { toast('That does not look like an invite.'); return }
        joinWith(c)
      }))
      return
    }
    var room = S.room
    body.appendChild(el('div', 'wt-title', room.media.title || 'Untitled'))
    if (!mediaMatches()) {
      body.appendChild(el('p', 'wt-note', 'The room is watching something else.'))
      body.appendChild(button('Go to the room\u2019s title', goToRoomTitle, 'wt-b wt-primary'))
    }
    var inv = el('div', 'wt-inv', '')
    inv.appendChild(button('Copy invite link', function () {
      var link = inviteLink()
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(function () { toast('Invite link copied.') }, function () { window.prompt('Copy this invite link', link) })
      else window.prompt('Copy this invite link', link)
    }, 'wt-b wt-primary'))
    inv.appendChild(el('small', '', 'Only people signed in to this server can join.'))
    body.appendChild(inv)

    body.appendChild(el('h4', '', 'Here now (' + room.participants.length + ')'))
    var list = el('div', 'wt-list', '')
    room.participants.forEach(function (p) {
      var row = el('div', 'wt-p', '')
      row.appendChild(avatar(p))
      var name = el('span', 'wt-pn', p.name + (p.pid === S.pid ? ' (you)' : ''))
      row.appendChild(name)
      if (p.role === 'host') row.appendChild(el('em', '', 'host'))
      if (!p.connected) row.appendChild(el('em', '', 'away'))
      else if (p.buffering) row.appendChild(el('em', '', 'buffering'))
      if (isHost() && p.pid !== S.pid) {
        row.appendChild(button('Make host', function () { post('/transfer', { code: S.code, target: p.pid }) }, 'wt-s'))
        row.appendChild(button('Remove', function () { post('/kick', { code: S.code, target: p.pid }) }, 'wt-s'))
      }
      list.appendChild(row)
    })
    body.appendChild(list)

    if (canControl()) {
      var rateRow = el('div', 'wt-row', '')
      rateRow.appendChild(el('span', '', 'Speed '))
      var sel = el('select', '', '')
      CFG.rates.forEach(function (r) { var o = el('option', '', r + 'x'); o.value = String(r); if (r === room.timeline.rate) o.selected = true; sel.appendChild(o) })
      sel.onchange = function () { command({ type: 'rate', rate: Number(sel.value) }) }
      rateRow.appendChild(sel)
      if (CFG.next) rateRow.appendChild(button('Next episode', function () { command({ type: 'next', kind: CFG.next.kind, id: CFG.next.id }) }, 'wt-s'))
      body.appendChild(rateRow)
    }
    if (isHost()) {
      body.appendChild(checkbox('Everyone can control playback', room.settings.control === 'everyone', false, function (on) { setSettings({ control: on ? 'everyone' : 'host' }) }))
      body.appendChild(checkbox('Pause for everyone when someone is buffering', room.settings.waitForBuffering, false, function (on) { setSettings({ waitForBuffering: on }) }))
      body.appendChild(checkbox('Chat', room.settings.chat, false, function (on) { setSettings({ chat: on }) }))
    }

    body.appendChild(el('h4', '', 'Chat'))
    chatBox = el('div', 'wt-chat', ''); body.appendChild(chatBox); renderChat()
    if (room.settings.chat || isHost()) {
      var row2 = el('div', 'wt-row', '')
      var ci = el('input', '', ''); ci.type = 'text'; ci.maxLength = 300; ci.placeholder = 'Say something'; ci.setAttribute('aria-label', 'Chat message')
      ci.addEventListener('keydown', function (e) { e.stopPropagation(); if (e.key === 'Enter') sendChat(ci) })
      ci.addEventListener('keyup', function (e) { e.stopPropagation() })
      row2.appendChild(ci); row2.appendChild(button('Send', function () { sendChat(ci) }, 'wt-s'))
      body.appendChild(row2)
    } else body.appendChild(el('p', 'wt-note', 'Chat is off.'))
    var rx = el('div', 'wt-rx', '')
    CFG.reactions.forEach(function (e) { rx.appendChild(button(e, function () { post('/react', { code: S.code, emoji: e }) }, 'wt-e')) })
    body.appendChild(rx)
    body.appendChild(button(isHost() ? 'End room for everyone' : 'Leave room', function () {
      if (isHost()) { var c = S.code; leaveLocal('You ended the room.'); post('/close', { code: c }) } else leave()
    }, 'wt-b wt-danger'))
  }

  // ---------------------------------------------------------------- start up
  renderButton(); render()
  var fromUrl = ''
  try {
    var sp = new URLSearchParams(location.search)
    fromUrl = sp.get('wt') || ''
    if (fromUrl) { sp.delete('wt'); history.replaceState(null, '', location.pathname + (sp.toString() ? '?' + sp.toString() : '') + location.hash) }
  } catch (e) {}
  var startCode = codeFromText(fromUrl) || codeFromText(stored('wt.code'))
  if (startCode) joinWith(startCode, !!fromUrl)
}
/* eslint-enable no-undef */

const PANEL_CSS = `
#wtPanel{position:fixed;right:12px;bottom:72px;width:min(340px,calc(100vw - 24px));max-height:72vh;overflow:auto;z-index:62;display:none;background:#16161c;color:#fff;border-radius:12px;border:1px solid rgba(255,255,255,.18);box-shadow:0 8px 28px rgba(0,0,0,.6);font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:14px;box-sizing:border-box}
#wtPanel.open{display:block}
#wtPanel .wt-head{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.12)}
#wtPanel .wt-x{background:#2a2a35;color:#fff;border:0;border-radius:8px;padding:6px 10px;cursor:pointer}
#wtPanel .wt-body{padding:10px 12px 14px}
#wtPanel h4{margin:14px 0 6px;font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:#aab}
#wtPanel .wt-note{color:#aab;font-size:13px;margin:8px 0}
#wtPanel .wt-title{font-weight:700;margin:2px 0 8px;word-break:break-word}
#wtPanel .wt-b{background:#2a2f3a;color:#fff;border:1px solid rgba(255,255,255,.22);border-radius:8px;padding:8px 12px;font-size:14px;cursor:pointer;margin:4px 6px 4px 0}
#wtPanel .wt-primary{background:#4f9dff;border-color:#4f9dff}
#wtPanel .wt-danger{margin-top:14px;border-color:#c0504d}
#wtPanel .wt-s{background:#2a2f3a;color:#fff;border:1px solid rgba(255,255,255,.22);border-radius:6px;padding:3px 8px;font-size:12px;cursor:pointer;margin-left:6px}
#wtPanel .wt-inv small{display:block;color:#99a;font-size:12px;margin-top:2px}
#wtPanel input[type=text],#wtPanel select{background:#0e0e12;color:#fff;border:1px solid #333;border-radius:6px;padding:7px 8px;width:100%;box-sizing:border-box;font-size:14px}
#wtPanel .wt-row{display:flex;align-items:center;gap:6px;margin:8px 0}
#wtPanel .wt-row input{flex:1}
#wtPanel .wt-row select{width:auto}
#wtPanel .wt-chk{display:block;margin:6px 0;font-size:13px}
#wtPanel .wt-p{display:flex;align-items:center;gap:8px;padding:4px 0;flex-wrap:wrap}
#wtPanel .wt-pn{flex:1;min-width:80px;word-break:break-word}
#wtPanel .wt-p em{font-style:normal;font-size:11px;color:#9cf;background:#20202a;border-radius:999px;padding:1px 7px}
#wtPanel .wt-av{width:26px;height:26px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;color:#111;flex:none}
#wtPanel .wt-chat{background:#0e0e12;border-radius:8px;padding:8px;height:130px;overflow:auto;font-size:13px;word-break:break-word}
#wtPanel .wt-msg{margin:2px 0}
#wtPanel .wt-rx{display:flex;flex-wrap:wrap;gap:4px;margin-top:8px}
#wtPanel .wt-e{background:#20202a;border:0;border-radius:8px;font-size:20px;padding:4px 8px;cursor:pointer}
#wtBanner{position:fixed;top:64px;left:50%;transform:translateX(-50%);z-index:61;display:none;background:rgba(20,22,28,.92);color:#fff;border:1px solid rgba(255,255,255,.2);border-radius:999px;padding:8px 16px;font:14px system-ui,Segoe UI,Arial,sans-serif;max-width:90vw;text-align:center}
#wtToast{position:fixed;left:50%;bottom:96px;transform:translateX(-50%);z-index:63;display:none;background:rgba(20,22,28,.95);color:#fff;border-radius:8px;padding:8px 14px;font:14px system-ui,Segoe UI,Arial,sans-serif;max-width:90vw}
#wtTap{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:63;display:none;background:#4f9dff;color:#fff;border:0;border-radius:12px;padding:14px 22px;font:600 16px system-ui,Segoe UI,Arial,sans-serif;cursor:pointer}
#wtFloat{position:fixed;left:0;right:0;bottom:80px;height:0;z-index:60;pointer-events:none}
#wtFloat .wt-fl{position:absolute;bottom:0;font-size:34px;animation:wtRise 3.4s ease-out forwards;text-align:center}
#wtFloat .wt-fl small{display:block;font:12px system-ui,Segoe UI,Arial,sans-serif;color:#fff;text-shadow:0 1px 3px #000}
@keyframes wtRise{from{transform:translateY(0);opacity:1}to{transform:translateY(-220px);opacity:0}}
`

/** "/tvwatch?id=abc" -> { kind, id } for the next-episode button, or null. */
function mediaFromHref(href) {
  const m = /^\/(tvwatch|watch)\?id=([^&#]+)/.exec(String(href || ''))
  if (!m) return null
  let id = ''
  try { id = decodeURIComponent(m[2]) } catch { return null }
  return normalizeMedia({ kind: m[1] === 'tvwatch' ? 'tv' : 'movie', id })
}

/** JSON that is safe inside a <script> element. */
function scriptJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .split(String.fromCharCode(0x2028)).join('\\u2028').split(String.fromCharCode(0x2029)).join('\\u2029')
}

/** The block appended to the player page: styles + the script. */
function watchTogetherHtml({ kind, mediaId, title, nextHref } = {}) {
  const cfg = {
    api: '/watch-together-api',
    kind: kind === 'tv' ? 'tv' : 'movie',
    id: String(mediaId || ''),
    title: String(title || '').slice(0, 120),
    next: mediaFromHref(nextHref) ? (({ kind: k, id }) => ({ kind: k, id }))(mediaFromHref(nextHref)) : null,
    reactions: REACTIONS,
    rates: RATES
  }
  return `
<style>${PANEL_CSS}</style>
<script>
(function(){
${sync.clientSource()}
(${watchTogetherClient.toString()})(${scriptJson(cfg)});
})();
</script>`
}

module.exports = { watchTogetherHtml, watchTogetherClient, mediaFromHref, scriptJson, PANEL_CSS }
