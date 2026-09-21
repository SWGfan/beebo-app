// Audio player for Audiobooks, Podcasts and Internet radio (docs AUDIOBOOKS.md, PODCASTS-AND-RADIO.md).
//
//   audiobook  GET /api/audiobooks/book/<id>?tokens=1 -> parts with signed stream addresses; resumes at the saved position
//              (whole-book seconds; a book of several files is played part by part); POST .../progress every 15 s.
//   podcast    the episode's own stream address (from ?tokens=1); POST /api/podcasts/episode/<key>/progress every 15 s.
//   radio      POST /api/radio/play?tokens=1 -> a relayed live stream; the "now playing" line is read every 20 s.
// The audio element plays a signed address, so it needs no headers. Keys: OK = play / pause, Left / Right = back 15 s /
// forward 30 s (not on radio), Next / Prev = next / previous chapter (books), Back = leave (progress is saved first).

import { h, setText } from '../dom.js'
import { formatClock } from '../util/escape.js'
import { assetUrl } from '../util/urls.js'
import { fraction } from '../util/seek.js'
import { locatePart } from '../util/extras.js'
import { lazy, loadNear } from '../images.js'

var PROGRESS_MS = 15000
var NOW_MS = 20000
var BACK_S = 15
var FORWARD_S = 30

export function audioplayer(ctx, params) {
  var item = params.item || {}
  var kind = item.kind === 'podcast' ? 'podcast' : item.kind === 'radio' ? 'radio' : 'book'
  var el = h('div', { cls: 'screen' })
  var origin = ctx.origin()

  var coverBox = h('div', { cls: 'poster', css: { width: '420px', height: '420px', position: 'absolute', left: 'calc(var(--safe-x) + 40px)', top: '220px' } })
  var img = h('img', { attrs: { alt: '' } })
  if (kind === 'book' && item.cover) lazy(img, assetUrl(origin, item.cover))
  coverBox.appendChild(img)
  coverBox.appendChild(h('div', { cls: 'ph', text: item.title || '' }))
  var col = h('div', { css: { position: 'absolute', left: '600px', right: 'var(--safe-x)', top: '220px' } })
  var titleEl = h('div', { cls: 'title clip2', text: item.title || '' })
  var subEl = h('div', { cls: 'dim clip1', text: kind === 'book' ? item.author || '' : kind === 'podcast' ? item.show || '' : item.sub || '' })
  var chapterEl = h('div', { cls: 'small dim clip1', css: { marginTop: '10px' }, text: '' })
  var stateEl = h('div', { cls: 'small', css: { marginTop: '36px' }, text: 'Starting…' })
  var fill = h('div', { cls: 'fill' })
  var bar = h('div', { cls: 'seekbar', css: { position: 'relative', left: '0', right: '0', bottom: '0', marginTop: '28px' } }, [fill])
  var tCur = h('span', { text: '0:00' })
  var tEnd = h('span', { cls: 'r', text: '' })
  var times = h('div', { cls: 'times', css: { position: 'relative', left: '0', right: '0', bottom: '0', marginTop: '14px' } }, [tCur, tEnd])
  var hint = h('div', { cls: 'faint small', css: { marginTop: '40px' }, text: kind === 'radio' ? 'OK: pause   Back: leave' : 'OK: play / pause   Left / Right: skip   Back: leave' })
  ;[titleEl, subEl, chapterEl, stateEl, bar, times, hint].forEach(function (n) { col.appendChild(n) })
  el.appendChild(coverBox)
  el.appendChild(col)

  var audio = document.createElement('audio')
  audio.preload = 'auto'
  var dead = false
  var detail = null // audiobook: { book, parts, chapters, position, speed }
  var partIndex = 0
  var pendingOffset = 0
  var session = null // radio
  var tick = null
  var lastSaveAt = 0
  var lastNowAt = 0
  var finished = false

  function say(t) { setText(stateEl, t) }

  // ---- position arithmetic (whole-book seconds for books) -----------------------------------------------------------------------
  function bookPosition() {
    var p = detail ? detail.parts[partIndex] : null
    return (p ? p.start : 0) + (audio.currentTime || 0)
  }
  function position() { return kind === 'book' && detail ? bookPosition() : audio.currentTime || 0 }
  function total() {
    if (kind === 'book') return detail ? detail.book.duration : item.duration || 0
    if (kind === 'podcast') return isFinite(audio.duration) && audio.duration > 0 ? audio.duration : item.durationSec || 0
    return 0
  }

  function save() {
    lastSaveAt = Date.now()
    var pos = position()
    if (kind === 'book' && detail && pos > 0) ctx.api.saveBookProgress(item.id, finished ? total() : pos)
    else if (kind === 'podcast' && pos > 0) ctx.api.savePodcastProgress(item.key, finished ? total() : pos, total())
  }

  function chapterAt(pos) {
    if (!detail || !detail.chapters.length) return null
    var c = null
    for (var i = 0; i < detail.chapters.length; i++) if (pos >= detail.chapters[i].start) c = detail.chapters[i]
    return c
  }

  function refresh() {
    var pos = position()
    var d = total()
    if (kind === 'radio') { setText(tCur, formatClock(audio.currentTime || 0)); setText(tEnd, 'LIVE'); fill.style.width = '100%'; return }
    fill.style.width = (fraction(pos, d) * 100) + '%'
    setText(tCur, formatClock(pos))
    setText(tEnd, d > 0 ? formatClock(d) : '')
    var ch = chapterAt(pos)
    if (ch) setText(chapterEl, ch.title)
  }

  function playing() { return !audio.paused && !audio.ended }
  function toggle() {
    if (audio.paused) { var p = audio.play(); if (p && p.then) p.then(null, function () {}) } else audio.pause()
  }

  function seekBy(delta) {
    if (kind === 'radio') return
    if (kind === 'book' && detail) { seekBook(bookPosition() + delta); return }
    var t = (audio.currentTime || 0) + delta
    try { audio.currentTime = Math.max(0, isFinite(audio.duration) && audio.duration > 0 ? Math.min(t, audio.duration - 1) : t) } catch (e) { /* not seekable yet */ }
    refresh()
  }

  // A whole-book position -> the right part file and the offset inside it.
  function seekBook(pos) {
    var d = detail.book.duration
    var want = Math.max(0, d > 0 ? Math.min(pos, d - 1) : pos)
    var loc = locatePart(detail.parts, want)
    if (loc.index === partIndex && audio.readyState >= 1) {
      try { audio.currentTime = loc.offset } catch (e) { /* ignore */ }
    } else {
      loadPart(loc.index, loc.offset, true)
    }
    refresh()
  }

  function jumpChapter(dir) {
    if (kind !== 'book' || !detail || !detail.chapters.length) return
    var pos = bookPosition()
    var target = null
    var i
    if (dir > 0) {
      for (i = 0; i < detail.chapters.length; i++) if (detail.chapters[i].start > pos + 1) { target = detail.chapters[i]; break }
    } else {
      for (i = detail.chapters.length - 1; i >= 0; i--) if (detail.chapters[i].start < pos - 5) { target = detail.chapters[i]; break }
      if (!target) target = detail.chapters[0]
    }
    if (target) seekBook(target.start)
  }

  function loadPart(index, offset, autoplay) {
    partIndex = index
    pendingOffset = offset > 0 ? offset : 0
    audio.src = assetUrl(origin, detail.parts[index].stream)
    if (autoplay) { var p = audio.play(); if (p && p.then) p.then(null, function () {}) }
  }

  // ---- events -----------------------------------------------------------------------------------------------------------------------
  audio.addEventListener('loadedmetadata', function () {
    if (pendingOffset > 0) { try { audio.currentTime = pendingOffset } catch (e) { /* ignore */ } pendingOffset = 0 }
    if (kind === 'book' && detail && detail.speed && detail.speed !== 1) audio.playbackRate = detail.speed
  })
  audio.addEventListener('playing', function () { say(kind === 'radio' ? 'Playing live' : 'Playing') })
  audio.addEventListener('pause', function () { if (!dead && !audio.ended) { say('Paused'); save() } })
  audio.addEventListener('waiting', function () { if (!dead && !audio.paused) say('Loading…') })
  audio.addEventListener('error', function () {
    if (dead) return
    say(kind === 'radio' ? 'The station stopped. Press Back and try again.' : 'This TV could not play the audio. Press Back and try again.')
  })
  audio.addEventListener('ended', function () {
    if (kind === 'book' && detail && partIndex + 1 < detail.parts.length) { loadPart(partIndex + 1, 0, true); return }
    finished = true
    save()
    say('Finished')
    if (kind !== 'radio') ctx.router.back()
  })

  function start() {
    if (kind === 'book') {
      ctx.api.bookDetail(item.id).then(function (d) {
        if (dead) return
        detail = d
        setText(titleEl, d.book.title)
        var resume = d.position > 0 && d.position < d.book.duration - 30 ? d.position : 0
        var loc = locatePart(d.parts, resume)
        loadPart(loc.index, loc.offset, true)
      }, function (e) { if (!dead) say((e && e.friendly) || 'This book could not be opened.') })
    } else if (kind === 'podcast') {
      audio.src = assetUrl(origin, item.stream)
      if (item.position > 5 && !item.played && (!item.durationSec || item.position < item.durationSec - 20)) pendingOffset = item.position
      var p = audio.play()
      if (p && p.then) p.then(null, function () {})
    } else {
      ctx.api.radioPlay(item.id).then(function (s) {
        if (dead) return
        session = s
        setText(titleEl, s.name)
        if (s.nowPlaying) setText(chapterEl, s.nowPlaying)
        audio.src = assetUrl(origin, s.stream)
        var q = audio.play()
        if (q && q.then) q.then(null, function () {})
      }, function (e) { if (!dead) say(e && e.serverMessage ? e.serverMessage : 'The station could not be started.') })
    }
  }

  function loop() {
    if (dead) return
    var now = Date.now()
    refresh()
    if (playing() && kind !== 'radio' && now - lastSaveAt >= PROGRESS_MS) save()
    if (kind === 'radio' && session && now - lastNowAt >= NOW_MS) {
      lastNowAt = now
      ctx.api.radioNow(session.id).then(function (line) { if (!dead && line) setText(chapterEl, line) })
    }
  }

  return {
    el: el,
    onShow: function () {
      loadNear(el)
      tick = setInterval(loop, 500)
      start()
    },
    onKey: function (action) {
      switch (action) {
        case 'enter': case 'playpause': toggle(); return true
        case 'play': if (audio.paused) toggle(); return true
        case 'pause': audio.pause(); return true
        case 'left': case 'rw': seekBy(-BACK_S); return true
        case 'right': case 'ff': seekBy(FORWARD_S); return true
        case 'next': jumpChapter(1); return true
        case 'prev': jumpChapter(-1); return true
        case 'stop': case 'back': ctx.router.back(); return true
        default: return true
      }
    },
    destroy: function () {
      dead = true
      clearInterval(tick)
      if (!finished) save()
      try { audio.pause() } catch (e) { /* ignore */ }
      audio.removeAttribute('src')
      try { audio.load() } catch (e2) { /* drops the connection: a radio session then ends */ }
    }
  }
}
