// Live TV player: the owner's own tuner through the home server (docs LIVE-TV.md). The server makes an ordinary live HLS
// playlist (H.264 / AAC in MPEG-TS pieces) that the TV plays natively; hls.js takes it on Xbox when the web view cannot.
//
//   POST /api/livetv/watch {channel}  -> { url:"/livetv/hls/<ticket>/index.m3u8", ticket, channel, now }
//   <video src = origin + url>        the signed ticket is in the path: no headers needed
//   POST /api/livetv/stop {ticket}    when leaving or changing channel (frees the tuner for someone else)
// Keys: Up / Down = next / previous channel, Left / Right = back / forward 30 s inside the rewind buffer, OK = pause,
// Back = leave. A busy tuner is said in plain words.

import { h, clear, setText } from '../dom.js'
import { button } from '../ui.js'
import { assetUrl } from '../util/urls.js'
import { explainLiveFailure } from '../util/extras.js'

var OSD_HIDE_MS = 5000
var FLIP_DELAY_MS = 600 // pressing Up / Down quickly moves through channels without tuning each one

export function liveplayer(ctx, params) {
  var channels = params.channels || []
  var index = params.index >= 0 && params.index < channels.length ? params.index : 0
  var el = h('div', { cls: 'screen transparent' })
  var layer = document.getElementById('video-layer')
  var video = document.createElement('video')
  video.setAttribute('playsinline', '')
  video.preload = 'auto'

  var osd = h('div', { cls: 'osd' })
  var osdTitle = h('div', { cls: 'osd-title clip1', text: '' })
  var osdSub = h('div', { cls: 'osd-sub', text: '' })
  var hint = h('div', { cls: 'hintline', text: 'Up/Down: change channel   Left/Right: 30 s' })
  ;[osdTitle, osdSub, hint].forEach(function (n) { osd.appendChild(n) })
  var center = h('div', { cls: 'pl-center' })
  el.appendChild(osd)
  el.appendChild(center)

  var dead = false
  var ticket = ''
  var seq = 0
  var flipTimer = null
  var osdTimer = null
  var errorOpen = false
  var origin = ctx.origin()

  function channel() { return channels[index] }

  function label(ch) { return (ch.number ? ch.number + '  ' : '') + ch.name }
  function nowLine(ch) {
    if (ch.now && ch.now.title) return 'Now: ' + ch.now.title + (ch.next && ch.next.title ? '   ·   Next: ' + ch.next.title : '')
    return ''
  }

  function showOsd() {
    var ch = channel()
    setText(osdTitle, ch ? label(ch) : '')
    setText(osdSub, ch ? nowLine(ch) : '')
    osd.classList.add('on')
    clearTimeout(osdTimer)
    osdTimer = setTimeout(function () { osd.classList.remove('on') }, OSD_HIDE_MS)
  }

  function showSpinner(text) {
    clear(center)
    center.appendChild(h('div', { cls: 'spinner' }))
    if (text) center.appendChild(h('div', { cls: 'msg', text: text }))
    center.style.display = ''
  }
  function hideCenter() { clear(center); center.style.display = 'none' }

  function showError(message) {
    errorOpen = true
    clear(center)
    center.style.pointerEvents = 'auto'
    center.appendChild(h('div', { cls: 'title', text: 'Can’t play this channel' }))
    center.appendChild(h('div', { cls: 'msg', text: message, css: { maxWidth: '1200px', margin: '16px auto 40px auto' } }))
    var row = h('div')
    row.appendChild(button('Try again', function () { clearError(); tune(index) }, 'primary'))
    row.appendChild(button('Back', exit))
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

  function stopTicket() {
    if (ticket) { ctx.api.liveStop(ticket); ticket = '' }
  }

  function tune(i) {
    if (dead || !channels.length) return
    index = ((i % channels.length) + channels.length) % channels.length
    var mine = ++seq
    stopTicket()
    try { video.pause() } catch (e) { /* ignore */ }
    showOsd()
    showSpinner('Tuning…')
    ctx.api.liveWatch(channel().key).then(function (w) {
      if (dead || mine !== seq) { ctx.api.liveStop(w.ticket); return }
      ticket = w.ticket
      var url = assetUrl(origin, w.url)
      if (!(ctx.platform.attachSource && ctx.platform.attachSource(video, url))) video.src = url
      var p = video.play()
      if (p && typeof p.then === 'function') p.then(null, function () { /* a real failure arrives as the video's error event */ })
    }, function (e) {
      if (dead || mine !== seq) return
      showError(explainLiveFailure(e))
    })
  }

  function flip(delta) {
    if (!channels.length) return
    index = ((index + delta) % channels.length + channels.length) % channels.length
    showOsd()
    clearTimeout(flipTimer)
    flipTimer = setTimeout(function () { tune(index) }, FLIP_DELAY_MS)
  }

  function skip(seconds) {
    try {
      var t = (video.currentTime || 0) + seconds
      var r = video.seekable
      if (r && r.length) t = Math.min(Math.max(t, r.start(0)), r.end(r.length - 1))
      video.currentTime = t
    } catch (e) { /* not seekable yet */ }
    showOsd()
  }

  function exit() { ctx.router.back() }

  function onPlaying() { hideCenter(); showOsd() }
  function onWaiting() { if (!dead && !video.paused && !errorOpen) showSpinner('') }
  function onError() {
    if (dead || errorOpen) return
    showError('This TV could not play the channel.')
  }
  video.addEventListener('playing', onPlaying)
  video.addEventListener('waiting', onWaiting)
  video.addEventListener('error', onError)

  return {
    el: el,
    onShow: function () {
      layer.appendChild(video)
      layer.classList.add('on')
      hideCenter()
      center.style.pointerEvents = 'none'
      tune(index)
    },
    onKey: function (action) {
      if (errorOpen) { if (action === 'back') { exit(); return true } return false }
      switch (action) {
        case 'up': case 'next': flip(1); return true
        case 'down': case 'prev': flip(-1); return true
        case 'left': case 'rw': skip(-30); return true
        case 'right': case 'ff': skip(30); return true
        case 'enter': case 'playpause':
          if (video.paused) { var p = video.play(); if (p && p.then) p.then(null, function () {}) } else video.pause()
          showOsd()
          return true
        case 'play': { var p2 = video.play(); if (p2 && p2.then) p2.then(null, function () {}); return true }
        case 'pause': video.pause(); return true
        case 'info': showOsd(); return true
        case 'stop': case 'back': exit(); return true
        default: return true
      }
    },
    destroy: function () {
      dead = true
      seq++
      clearTimeout(flipTimer)
      clearTimeout(osdTimer)
      stopTicket()
      video.removeEventListener('playing', onPlaying)
      video.removeEventListener('waiting', onWaiting)
      video.removeEventListener('error', onError)
      try { video.pause() } catch (e) { /* ignore */ }
      if (ctx.platform.detachSource) ctx.platform.detachSource(video)
      video.removeAttribute('src')
      try { video.load() } catch (e2) { /* releases the decoder */ }
      if (video.parentNode) video.parentNode.removeChild(video)
      layer.classList.remove('on')
    }
  }
}
