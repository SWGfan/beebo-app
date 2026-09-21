// Player: HTML5 <video> playing the server's transcoded HLS (H.264/AAC), remote-friendly OSD,
// scrubbing, subtitle / audio / quality panel, progress reporting and resume, up-next.
//
// Flow (same calls the Android app makes - see streamServer.js / playbackApi.js):
//   GET  /api/playback/info?kind&id          tracks, duration, qualities (+ a `homeTheater` block on a newer server)
//   POST /api/watch-session {kind,id}        -> sessionId (so history/continue-watching work)
//   POST /api/playback/negotiate {kind,id,client,deviceProfile,quality,audio?}   newer server (docs/HOME-THEATER.md):
//        -> { method: DirectPlay | DirectStream | Transcode, url }  the server picks from this TV's declared profile
//   POST /api/playback/start {kind,id,quality,audio?} -> { url:"/hls/<ticket>/index.m3u8", ticket }
//        older server, and the fallback whenever a direct play / direct stream cannot be played by this TV
//   <video src = origin + url>               (tickets are in the path: no headers needed)
//   POST /api/progress {sessionId,currentTime,duration}   every 15 s + on pause/exit
//   POST /api/playback/stop {ticket}         when leaving / switching audio or quality
// Subtitles are fetched as WebVTT text and drawn by us (no cross-origin <track>).

import { h, clear, setText, focusable } from '../dom.js'
import { button } from '../ui.js'
import { formatClock } from '../util/escape.js'
import { fraction, createSeeker } from '../util/seek.js'
import { parseVtt, cueAt } from '../util/vtt.js'
import { assetUrl } from '../util/urls.js'
import { prepareWaitSec, describePlan, MAX_PREPARE_TRIES } from '../util/playback.js'

var OSD_HIDE_MS = 5000
var PROGRESS_MS = 15000
var START_TIMEOUT_MS = 45000
var NEXT_COUNTDOWN_S = 8
var PREROLL_START_MS = 15000 // a pre-show item that has not started by then is skipped

export function player(ctx, params) {
  var kind = params.kind === 'tv' ? 'tv' : 'movie'
  var id = params.id
  var title = params.title || ''
  var pendingSeek = params.resumeSec > 0 ? params.resumeSec : 0

  var el = h('div', { cls: 'screen transparent' })
  var layer = document.getElementById('video-layer')
  var video = document.createElement('video')
  video.setAttribute('playsinline', '')
  video.preload = 'auto'

  // --- overlay DOM ---------------------------------------------------------------------------
  var subsEl = h('div', { cls: 'subs' })
  var center = h('div', { cls: 'pl-center' })
  var osd = h('div', { cls: 'osd' })
  var osdTitle = h('div', { cls: 'osd-title clip1', text: title })
  var osdSub = h('div', { cls: 'osd-sub' })
  var hint = h('div', { cls: 'hintline', text: 'Up/Down: subtitles, audio, quality' })
  var fill = h('div', { cls: 'fill' })
  var knob = h('div', { cls: 'knob' })
  var bar = h('div', { cls: 'seekbar' }, [fill, knob])
  var tCur = h('span', { text: '0:00' })
  var tEnd = h('span', { cls: 'r', text: '' })
  var times = h('div', { cls: 'times' }, [tCur, tEnd])
  ;[osdTitle, osdSub, hint, bar, times].forEach(function (n) { osd.appendChild(n) })
  var preBar = h('div', { cls: 'hintline', css: { display: 'none', bottom: '60px' } })
  el.appendChild(subsEl)
  el.appendChild(osd)
  el.appendChild(center)
  el.appendChild(preBar)

  // --- state ---------------------------------------------------------------------------------
  var dead = false
  var info = null
  var ticket = ''
  var sessionId = ''
  var audioIdx = null
  var quality = ctx.store.getQuality()
  var original = ctx.store.getPlayOriginal() // ask the server to play the file as it is when this TV can (newer servers)
  var useNegotiate = false // set from info.homeTheater: the server has POST /api/playback/negotiate
  var forceLegacy = false // a direct play / direct stream failed on this TV: use the plain conversion from now on
  var streamPlan = null // the negotiated plan of the stream now playing (null: /playback/start)
  var prepareTimer = null
  var pre = null // the Cinema Mode pre-show in progress: { items, i, done, timer, reported }
  var cues = []
  var cueHint = 0
  var subKey = null
  var seeker = createSeeker({ commitDelayMs: 600 })
  var osdHideAt = 0
  var lastProgressAt = 0
  var tickTimer = null
  var startTimer = null
  var waitTimer = null
  var nextItem = null
  var nextCard = null
  var nextCountdown = 0
  var nextTimer = null
  var panel = null
  var errorOpen = false
  var ended = false
  var origin = ctx.origin()

  function duration() {
    var d = video.duration
    if (isFinite(d) && d > 0) return d
    return info && info.durationSec > 0 ? info.durationSec : 0
  }

  // --- OSD -------------------------------------------------------------------------------------
  function osdOn() { return osd.classList.contains('on') }
  function showOsd(sticky) {
    osd.classList.add('on')
    subsEl.classList.add('raised')
    osdHideAt = sticky ? 0 : Date.now() + OSD_HIDE_MS
    updateOsd()
  }
  function hideOsd() {
    osd.classList.remove('on')
    subsEl.classList.remove('raised')
    osdHideAt = 0
  }
  function updateOsd() {
    var d = duration()
    var t = seeker.displayTime(video.currentTime || 0)
    var f = fraction(t, d)
    fill.style.width = (f * 100) + '%'
    knob.style.left = (f * 100) + '%'
    setText(tCur, formatClock(t))
    setText(tEnd, d > 0 ? formatClock(d) : '')
    var parts = []
    if (streamPlan) parts.push(describePlan(streamPlan))
    else if (quality) parts.push(quality)
    if (info && info.badges && info.badges.length) parts.push(info.badges.join(' '))
    if (subKey && info) { for (var i = 0; i < info.subtitles.length; i++) if (info.subtitles[i].key === subKey) parts.push('Subtitles: ' + info.subtitles[i].label) }
    if (video.paused && !seeker.pending() && !ended) parts.push('Paused')
    setText(osdSub, parts.join('  ·  '))
  }

  // --- centre message (spinner / errors) -----------------------------------------------------------
  function showSpinner(text) {
    clear(center)
    center.appendChild(h('div', { cls: 'spinner' }))
    if (text) center.appendChild(h('div', { cls: 'msg', text: text }))
    center.style.display = ''
  }
  function hideCenter() { clear(center); center.style.display = 'none' }

  function showError(message, actions) {
    errorOpen = true
    hideOsd()
    clear(center)
    center.style.pointerEvents = 'auto'
    center.appendChild(h('div', { cls: 'title', text: 'Can’t play this right now' }))
    center.appendChild(h('div', { cls: 'msg', text: message, css: { maxWidth: '1200px', margin: '16px auto 40px auto' } }))
    var row = h('div')
    actions.forEach(function (a, i) { row.appendChild(button(a.label, a.onSelect, i === 0 ? 'primary' : '')) })
    center.appendChild(row)
    center.style.display = ''
    ctx.focus.pushScope(center)
  }
  function clearError() {
    if (!errorOpen) return
    errorOpen = false
    ctx.focus.popScope()
    center.style.pointerEvents = 'none'
    hideCenter()
  }

  function friendlyStartError(e) {
    var status = e && e.status
    var msg = e && e.serverMessage
    if (status === 409 || status === 422 || status === 503) return msg || 'The computer could not convert this video for the TV right now.'
    if (status === 404) return 'This video could not be found on your server any more.'
    return (e && e.friendly) || 'Something went wrong starting the video.'
  }

  // --- start / stop the HLS stream ------------------------------------------------------------------------
  function stopTicket() {
    if (ticket) { ctx.api.playbackStop(ticket); ticket = '' }
  }

  function startStream(atSec) {
    if (dead) return
    clearError()
    ended = false
    showSpinner('Starting…')
    pendingSeek = atSec > 0 ? atSec : 0
    clearTimeout(startTimer)
    startTimer = setTimeout(function () {
      if (!dead && video.readyState < 1) {
        showError('The video is taking too long to start.', [
          { label: 'Try again', onSelect: function () { startStream(atSec) } },
          { label: 'Back', onSelect: exit }
        ])
      }
    }, START_TIMEOUT_MS)
    clearTimeout(prepareTimer)
    if (useNegotiate && !forceLegacy) startNegotiated(atSec, 0)
    else startLegacy(atSec)
  }

  // Puts a stream (from /playback/start or /playback/negotiate) on the <video>.
  function applyStream(s, plan) {
    if (dead) { if (s.ticket) ctx.api.playbackStop(s.ticket); return }
    stopTicket()
    ticket = s.ticket || ''
    streamPlan = plan || null
    var streamUrl = assetUrl(origin, s.url)
    // Xbox only: when its web view cannot play HLS itself, hls.js takes the stream (attachSource returns true).
    // A direct-play file (/file?...) is never handed to hls.js: attachSource only takes .m3u8 addresses.
    var isHls = /\.m3u8(\?|$)/.test(s.url)
    if (!(isHls && ctx.platform.attachSource && ctx.platform.attachSource(video, streamUrl))) {
      if (!isHls && ctx.platform.detachSource) ctx.platform.detachSource(video)
      video.src = streamUrl
    }
    var p = video.play()
    if (p && typeof p.then === 'function') {
      p.then(null, function (err) {
        // Autoplay refused: show the paused OSD. Any real failure is reported by the video's error event.
        if (dead || errorOpen) return
        if (err && err.name === 'NotAllowedError') { hideCenter(); showOsd(true) }
      })
    }
  }

  function startError(e, atSec) {
    if (dead) return
    clearTimeout(startTimer)
    showError(friendlyStartError(e), [
      { label: 'Try again', onSelect: function () { startStream(atSec) } },
      quality !== '480p' ? { label: 'Try lower quality', onSelect: function () { lowerQuality(); startStream(atSec) } } : null,
      { label: 'Back', onSelect: exit }
    ].filter(Boolean))
  }

  function lowerQuality() {
    quality = quality === '1080p' ? '720p' : '480p'
    original = false
    ctx.store.setQuality(quality)
    ctx.store.setPlayOriginal(false)
  }

  // The plain conversion (older servers, and the fallback): H.264 / AAC HLS at the chosen quality.
  function startLegacy(atSec) {
    ctx.api.playbackStart(kind, id, quality, audioIdx).then(function (s) { applyStream(s, null) }, function (e) { startError(e, atSec) })
  }

  // Newer servers: this TV's declared profile goes with the request and the server answers with the way to play the file
  // (as it is, repackaged, or converted). "preparing" (a big film is being read once) is asked again a few times.
  function startNegotiated(atSec, tries) {
    ctx.api.playbackNegotiate(kind, id, { quality: original ? 'original' : quality, audio: audioIdx }).then(function (p) {
      if (dead) { if (p.ticket) ctx.api.playbackStop(p.ticket); return }
      // A direct play cannot choose an audio track on every TV engine: when the person picked a track that is not the
      // file's default one, let the server convert it with that track instead.
      if (p.method === 'DirectPlay' && audioIdx !== null && !isDefaultAudio(audioIdx)) { startLegacy(atSec); return }
      applyStream(p, p)
    }, function (e) {
      if (dead) return
      var wait = prepareWaitSec(e)
      if (wait && tries < MAX_PREPARE_TRIES) {
        showSpinner('Getting this ready…')
        prepareTimer = setTimeout(function () { if (!dead) startNegotiated(atSec, tries + 1) }, wait * 1000)
        return
      }
      // An answer this app cannot follow: the proven conversion still works.
      if (e && e.kind === 'bad_response') { startLegacy(atSec); return }
      startError(e, atSec)
    })
  }

  function isDefaultAudio(streamIndex) {
    if (!info || !info.audio) return true
    for (var i = 0; i < info.audio.length; i++) if (info.audio[i].streamIndex === streamIndex) return info.audio[i].isDefault === true
    return true
  }

  // --- subtitles -------------------------------------------------------------------------------------------
  function setSubtitle(key) {
    subKey = key
    cues = []
    cueHint = 0
    setText(subsEl, '')
    ctx.store.setSubtitlesOn(!!key)
    if (!key || !info) { updateOsd(); return }
    var track = null
    for (var i = 0; i < info.subtitles.length; i++) if (info.subtitles[i].key === key) track = info.subtitles[i]
    if (!track) return
    ctx.api.getText(track.url).then(function (text) {
      if (dead || subKey !== key) return
      cues = parseVtt(text)
      if (!cues.length) ctx.toast('No subtitle lines found in that track.')
      updateSubs()
      updateOsd()
    }, function () { if (!dead) ctx.toast('Couldn’t load those subtitles.') })
  }

  function pickDefaultSubtitle() {
    if (!info || !info.subtitles.length || !ctx.store.getSubtitlesOn()) return null
    var best = null
    for (var i = 0; i < info.subtitles.length; i++) {
      var t = info.subtitles[i]
      if (!t.forced && /^en/i.test(t.language)) { best = t; break }
    }
    return (best || info.subtitles[0]).key
  }

  function updateSubs() {
    if (pre || !cues.length) return
    var r = cueAt(cues, video.currentTime || 0, cueHint)
    cueHint = r.index
    if (subsEl.textContent !== r.text) setText(subsEl, r.text)
  }

  // --- progress ------------------------------------------------------------------------------------------
  function report() {
    var t = video.currentTime || 0
    if (pre || !sessionId || t < 1) return // never report a trailer's time as the film's
    ctx.api.progress(sessionId, Math.floor(t), Math.floor(duration()))
    lastProgressAt = Date.now()
  }

  // --- options panel ---------------------------------------------------------------------------------------
  function closePanel() {
    if (!panel) return
    ctx.focus.popScope()
    el.removeChild(panel)
    panel = null
    showOsd()
  }

  function openPanel() {
    if (panel || errorOpen || !info) return
    hideOsd()
    panel = h('div', { cls: 'pl-panel' })
    var firstOpt = null // focus starts on the selected subtitle option (or the first option)
    var inSubs = true
    function group(label) { panel.appendChild(h('div', { cls: 'grp', text: label })) }
    function opt(label, selected, onSelect) {
      var o = focusable(h('div', { cls: 'opt' + (selected ? ' sel' : ''), text: (selected ? '✓ ' : '') + label }), function () { onSelect(); closePanel() })
      panel.appendChild(o)
      if (!firstOpt) firstOpt = o
      if (inSubs && selected) firstOpt = o
      return o
    }
    group('Subtitles')
    opt('Off', !subKey, function () { setSubtitle(null) })
    info.subtitles.forEach(function (t) { opt(t.label, subKey === t.key, function () { setSubtitle(t.key) }) })
    if (!info.subtitles.length) panel.appendChild(h('div', { cls: 'faint small', text: 'No subtitle tracks for this video.', css: { marginBottom: '8px' } }))
    inSubs = false
    if (info.audio.length > 1) {
      group('Audio')
      info.audio.forEach(function (a) {
        var sel = audioIdx === a.streamIndex || (audioIdx === null && a.isDefault)
        opt(a.label + (a.channels > 2 ? ' (' + a.channels + ' ch)' : ''), sel, function () { switchAudio(a.streamIndex) })
      })
    }
    group('Quality')
    // "Original" (newer servers): the file is played as it is, or repackaged, when this TV can; otherwise converted.
    if (useNegotiate && !forceLegacy) opt('Original', original, function () { switchQuality('original') })
    ;['1080p', '720p', '480p'].forEach(function (q) { opt(q, (!original || !useNegotiate || forceLegacy) && quality === q, function () { switchQuality(q) }) })
    el.appendChild(panel)
    ctx.focus.pushScope(panel, firstOpt)
  }

  function switchAudio(streamIndex) {
    if (audioIdx === streamIndex) return
    audioIdx = streamIndex
    report()
    startStream(video.currentTime || 0)
  }
  function switchQuality(q) {
    if (q === 'original') {
      if (original) return
      original = true
      ctx.store.setPlayOriginal(true)
    } else {
      if (quality === q && !original) return
      quality = q
      original = false
      ctx.store.setQuality(q)
      ctx.store.setPlayOriginal(false)
    }
    report()
    startStream(video.currentTime || 0)
  }

  // --- up next --------------------------------------------------------------------------------------------------
  function closeNextCard() {
    if (nextTimer) { clearInterval(nextTimer); nextTimer = null }
    if (nextCard) { ctx.focus.popScope(); el.removeChild(nextCard); nextCard = null }
  }

  function offerNext() {
    if (!nextItem) { exit(); return }
    nextCountdown = NEXT_COUNTDOWN_S
    var count = h('div', { cls: 'small dim', text: 'Playing in ' + nextCountdown + ' s' })
    nextCard = h('div', { cls: 'pl-next' }, [
      h('div', { cls: 'nt', text: 'UP NEXT' }),
      h('div', { cls: 'ntitle clip2', text: nextItem.title }),
      count
    ])
    var row = h('div', { css: { marginTop: '16px' } })
    row.appendChild(button('Play now', playNext, 'primary'))
    row.appendChild(button('Close', exit))
    nextCard.appendChild(row)
    el.appendChild(nextCard)
    ctx.focus.pushScope(nextCard)
    nextTimer = setInterval(function () {
      nextCountdown--
      if (nextCountdown <= 0) { playNext(); return }
      setText(count, 'Playing in ' + nextCountdown + ' s')
    }, 1000)
  }

  function playNext() {
    if (!nextItem) return
    var n = nextItem
    closeNextCard()
    closePanel()
    report()
    stopTicket()
    id = n.id
    kind = n.kind
    title = n.title
    nextItem = null
    sessionId = ''
    audioIdx = null
    streamPlan = null
    forceLegacy = false // a new file gets its own chance to be played as it is
    cues = []
    subKey = null
    setText(subsEl, '')
    setText(osdTitle, title)
    begin(0)
  }

  function loadNext() {
    nextItem = null
    if (kind !== 'tv') return
    ctx.api.upNext(kind, id).then(function (n) { if (!dead) nextItem = n })
  }

  // --- begin: info + session + stream ------------------------------------------------------------------------------
  function begin(atSec) {
    showSpinner('Starting…')
    var myId = id
    Promise.all([
      ctx.api.playbackInfo(kind, id).then(null, function () { return null }),
      ctx.api.watchSession(kind, id).then(null, function () { return '' })
    ]).then(function (r) {
      if (dead || myId !== id) return
      info = r[0] || { durationSec: 0, audio: [], subtitles: [], qualities: [], height: 0 }
      // Feature test: only a newer server has the `homeTheater` block (and POST /api/playback/negotiate).
      useNegotiate = info.homeTheater === true
      sessionId = r[1]
      var def = pickDefaultSubtitle()
      if (def) setSubtitle(def)
      loadNext()
      // Cinema Mode: films only, and not when resuming part-way. The server decides (the person turns it on for themselves).
      if (kind === 'movie' && useNegotiate && !(atSec > 0)) runPreroll(function () { startStream(atSec) })
      else startStream(atSec)
    })
  }

  // --- pre-show (Cinema Mode, docs CINEMA-MODE.md) -----------------------------------------------------------------------------
  // The owner's own intro / trailer files play first, in the same <video>. YouTube trailers are left out (only YouTube's own
  // embedded player may play those). OK skips one, Back skips all; anything that fails is skipped and the film starts.
  function runPreroll(done) {
    ctx.api.preroll(id).then(function (items) {
      if (dead) return
      if (!items.length) { done(); return }
      pre = { items: items, i: -1, done: done, timer: null, reported: false }
      nextPreroll()
    })
  }
  function endPreroll() {
    if (!pre) return
    var done = pre.done
    clearTimeout(pre.timer)
    pre = null
    preBar.style.display = 'none'
    done()
  }
  function nextPreroll() {
    if (dead || !pre) return
    clearTimeout(pre.timer)
    pre.i++
    pre.reported = false
    if (pre.i >= pre.items.length) { endPreroll(); return }
    var it = pre.items[pre.i]
    showSpinner('')
    setText(preBar, it.title + '   (' + (pre.i + 1) + ' of ' + pre.items.length + ')   OK: skip   Back: skip all')
    video.src = assetUrl(origin, it.url)
    pre.timer = setTimeout(nextPreroll, PREROLL_START_MS)
    var p = video.play()
    if (p && typeof p.then === 'function') p.then(null, function () { /* a real failure arrives as the error event */ })
  }

  // --- video events -------------------------------------------------------------------------------------------------
  function onMeta() {
    clearTimeout(startTimer)
    if (pendingSeek > 0) { try { video.currentTime = pendingSeek } catch (e) { /* ignore */ } pendingSeek = 0 }
  }
  function onPlaying() {
    if (pre) {
      clearTimeout(pre.timer)
      hideCenter()
      preBar.style.display = ''
      if (!pre.reported) { pre.reported = true; ctx.api.prerollSeen(pre.items[pre.i]) }
      return
    }
    clearTimeout(waitTimer)
    clearTimeout(startTimer)
    hideCenter()
    showOsd()
  }
  function onWaiting() {
    clearTimeout(waitTimer)
    waitTimer = setTimeout(function () { if (!dead && !video.paused && !errorOpen) showSpinner('') }, 600)
  }
  function onPause() { if (!ended && !pre) { report(); showOsd(true) } }
  function onEnded() {
    if (pre) { nextPreroll(); return }
    ended = true
    report()
    hideOsd()
    if (kind === 'tv') offerNext()
    else exit()
  }
  function onError() {
    if (dead || errorOpen) return
    if (pre) { nextPreroll(); return }
    // The TV refused a file or a repackaged stream that the server thought it could play (a declared codec, container or
    // HDR mode that the panel does not really handle): once, go back to the proven conversion and carry on from here.
    if (streamPlan && streamPlan.method !== 'Transcode' && !forceLegacy) {
      forceLegacy = true
      ctx.toast('This TV could not play the original, so it is being converted.')
      startStream(video.currentTime || pendingSeek || 0)
      return
    }
    var code = video.error ? video.error.code : 0
    var msg = code === 4 ? 'This TV could not play the stream. Trying a lower quality sometimes helps.' : 'The video stopped because of a playback error.'
    showError(msg, [
      { label: 'Try again', onSelect: function () { startStream(video.currentTime || pendingSeek || 0) } },
      quality !== '480p' ? { label: 'Try lower quality', onSelect: function () { lowerQuality(); startStream(video.currentTime || pendingSeek || 0) } } : null,
      { label: 'Back', onSelect: exit }
    ].filter(Boolean))
  }
  function onVisibility() { if (document.hidden && !dead) { try { video.pause() } catch (e) { /* ignore */ } } }

  video.addEventListener('loadedmetadata', onMeta)
  video.addEventListener('playing', onPlaying)
  video.addEventListener('waiting', onWaiting)
  video.addEventListener('pause', onPause)
  video.addEventListener('ended', onEnded)
  video.addEventListener('error', onError)
  video.addEventListener('timeupdate', updateSubs)
  document.addEventListener('visibilitychange', onVisibility)

  function exit() { ctx.router.back() }

  function seekPress(dir) {
    seeker.press(dir, video.currentTime || 0, duration(), Date.now())
    showOsd()
  }

  function tick() {
    if (dead) return
    var now = Date.now()
    if (seeker.due(now)) {
      var t = seeker.commit()
      if (t !== null) {
        try { video.currentTime = t } catch (e) { /* ignore */ }
        if (video.paused) { var p = video.play(); if (p && p.then) p.then(null, function () {}) }
      }
    }
    if (osdOn()) {
      updateOsd()
      if (osdHideAt && now >= osdHideAt && !video.paused && !seeker.pending() && !panel) hideOsd()
    }
    if (!video.paused && !ended && now - lastProgressAt >= PROGRESS_MS) report()
  }

  return {
    el: el,
    onShow: function () {
      layer.appendChild(video)
      layer.classList.add('on')
      hideCenter()
      center.style.pointerEvents = 'none'
      tickTimer = setInterval(tick, 250)
      begin(pendingSeek)
    },
    onKey: function (action) {
      if (pre) {
        if (action === 'enter' || action === 'right' || action === 'ff' || action === 'next') nextPreroll()
        else if (action === 'back' || action === 'stop') endPreroll()
        return true
      }
      if (nextCard) {
        if (action === 'back') { exit(); return true }
        return false // Play now / Close buttons via the focus manager
      }
      if (errorOpen) { if (action === 'back') { exit(); return true } return false }
      if (panel) { if (action === 'back' || action === 'menu') { closePanel(); return true } return false }
      switch (action) {
        case 'left': case 'rw': seekPress(-1); return true
        case 'right': case 'ff': seekPress(1); return true
        case 'enter': case 'playpause':
          if (video.paused) { var p = video.play(); if (p && p.then) p.then(null, function () {}) } else video.pause()
          showOsd(video.paused)
          return true
        case 'play': { var p2 = video.play(); if (p2 && p2.then) p2.then(null, function () {}); showOsd(); return true }
        case 'pause': video.pause(); return true
        case 'up': case 'down': case 'menu': openPanel(); return true
        case 'info': showOsd(); return true
        case 'next': if (nextItem) playNext(); return true
        case 'stop': case 'back': exit(); return true
        default: return true // swallow other keys (colour keys etc.) while playing
      }
    },
    destroy: function () {
      dead = true
      clearInterval(tickTimer)
      clearTimeout(startTimer)
      clearTimeout(waitTimer)
      clearTimeout(prepareTimer)
      if (pre) { clearTimeout(pre.timer); pre = null }
      closeNextCard()
      document.removeEventListener('visibilitychange', onVisibility)
      report()
      stopTicket()
      try { video.pause() } catch (e) { /* ignore */ }
      video.removeEventListener('ended', onEnded)
      video.removeEventListener('error', onError)
      if (ctx.platform.detachSource) ctx.platform.detachSource(video)
      video.removeAttribute('src')
      try { video.load() } catch (e) { /* ignore */ } // releases the decoder and buffers
      if (video.parentNode) video.parentNode.removeChild(video)
      layer.classList.remove('on')
      cues = []
      if (ctx.refreshContinue) ctx.refreshContinue()
    }
  }
}
