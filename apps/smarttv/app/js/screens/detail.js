// Detail page: backdrop, title, year / length / rating, synopsis, Play / Resume, and for shows the
// season buttons + episode list.

import { h, focusable, clear, setText } from '../dom.js'
import { button } from '../ui.js'
import { lazy, loadNear, unload } from '../images.js'
import { formatClock, formatRuntime, formatRating, formatYear } from '../util/escape.js'
import { resumePosition } from '../util/seek.js'
import { seasonLabel } from '../util/models.js'

function chip(text, cls) { return h('span', { cls: 'chip' + (cls ? ' ' + cls : ''), text: text }) }

function epCode(ep) {
  if (ep.season === null || ep.season === undefined || ep.episode === null || ep.episode === undefined) return ''
  return 'S' + ep.season + 'E' + ep.episode
}

export function detail(ctx, params) {
  var item = params.item
  var isTv = item.kind === 'tv'
  var el = h('div', { cls: 'screen' })
  var dead = false

  var bg = h('div', { cls: 'detail-bg' })
  var bgImg = h('img', { attrs: { alt: '' } })
  bg.appendChild(bgImg)
  bg.appendChild(h('div', { cls: 'fade' }))
  var scroller = h('div', { cls: 'detail-scroll', attrs: { 'data-scroll': 'y', 'data-pad-y': '60' } })
  var bodyEl = h('div', { cls: 'detail-body' })
  scroller.appendChild(bodyEl)
  el.appendChild(bg)
  el.appendChild(scroller)

  var main = h('div', { cls: 'detail-main' })
  var titleEl = h('div', { cls: 'detail-title clip2', text: item.title })
  var metaEl = h('div', { cls: 'meta' })
  var synopsis = h('div', { cls: 'synopsis clip6', text: item.overview || '' })
  var actions = h('div', { cls: 'detail-actions' })
  main.appendChild(titleEl)
  main.appendChild(metaEl)
  main.appendChild(synopsis)
  main.appendChild(actions)
  bodyEl.appendChild(main)
  var seasonsEl = h('div', { cls: 'seasons', attrs: { 'data-scroll': 'x', 'data-pad-x': '60' } })
  var epsEl = h('div', { cls: 'eps' })
  if (isTv) { bodyEl.appendChild(seasonsEl); bodyEl.appendChild(epsEl) }

  var runtime = ''
  var show = null // { seasons: [...], show: {...} }
  var seasonIdx = 0
  var playBtn = null
  var seasonChosen = false

  if (item.backdrop) lazy(bgImg, item.backdrop)
  bgImg.onload = function () { bgImg.className = 'loaded' }

  function renderMeta() {
    clear(metaEl)
    var y = formatYear(item.year)
    if (y) metaEl.appendChild(chip(y))
    if (isTv && item.episodeCount) metaEl.appendChild(chip(item.episodeCount + ' episodes'))
    if (runtime) metaEl.appendChild(chip(runtime))
    var r = formatRating(item.rating)
    if (r) metaEl.appendChild(chip('★ ' + r, 'rate'))
    if (item.quality) metaEl.appendChild(chip(item.quality))
  }

  function play(target, resumeSec) {
    ctx.play({ kind: target.kind, id: target.id, title: target.title, resumeSec: resumeSec || 0, showKey: isTv ? item.key : null, poster: item.poster })
  }

  // ---- movie -------------------------------------------------------------------------------
  function renderMovieActions() {
    clear(actions)
    var cont = ctx.session.resumeFor(item.id)
    var pos = cont ? resumePosition(cont.currentTime, cont.duration) : 0
    if (pos > 0) {
      playBtn = button('Resume from ' + formatClock(pos), function () { play(item, pos) }, 'primary')
      actions.appendChild(playBtn)
      actions.appendChild(button('Start over', function () { play(item, 0) }))
    } else {
      playBtn = button('Play', function () { play(item, 0) }, 'primary')
      actions.appendChild(playBtn)
    }
    actions.appendChild(button('Back', function () { ctx.router.back() }))
    ctx.focus.focus(playBtn)
  }

  function loadMovieExtras() {
    // Best effort: runtime comes from the file probe. Never blocks or breaks the page.
    ctx.api.playbackInfo('movie', item.id).then(function (info) {
      if (dead) return
      var rt = formatRuntime(info.durationSec)
      if (rt) { runtime = rt; renderMeta() }
    }, function () { /* no runtime shown */ })
  }

  function resolvePartialMovie() {
    // Recently-added rows carry only title + poster; fetch the full record by searching its title.
    var p = ctx.session.search('movie', item.title)
    p.loadMore().then(function () {
      if (dead) return
      var full = null
      var list = p.items()
      for (var i = 0; i < list.length; i++) if (list[i].id === item.id) { full = list[i]; break }
      if (full) {
        item = full
        setText(titleEl, item.title)
        setText(synopsis, item.overview || '')
        if (item.backdrop) { lazy(bgImg, item.backdrop); loadNear(bg) }
        renderMeta()
      }
    }, function () { /* keep the partial view */ })
  }

  // ---- show ---------------------------------------------------------------------------------
  function allEpisodes() {
    var out = []
    show.seasons.forEach(function (s) { s.episodes.forEach(function (e) { out.push(e) }) })
    return out
  }

  function pickTarget() {
    var eps = allEpisodes()
    if (!eps.length) return null
    var ids = eps.map(function (e) { return e.id })
    var cont = ctx.session.continueForEpisodes(ids)
    if (cont) {
      for (var i = 0; i < eps.length; i++) {
        if (eps[i].id === cont.id) return { ep: eps[i], resume: cont.upNext ? 0 : resumePosition(cont.currentTime, cont.duration), started: !cont.upNext && resumePosition(cont.currentTime, cont.duration) > 0 }
      }
    }
    for (var j = 0; j < eps.length; j++) if (!eps[j].watched) return { ep: eps[j], resume: 0, started: eps[j].watchedPercent > 0 }
    return { ep: eps[0], resume: 0, started: false }
  }

  function renderShowActions() {
    clear(actions)
    var t = pickTarget()
    if (t) {
      var code = epCode(t.ep)
      var label = (t.resume > 0 ? 'Resume ' : 'Play ') + (code || 'episode')
      playBtn = button(label, function () { play(t.ep, t.resume) }, 'primary')
      actions.appendChild(playBtn)
      // start the season list on the season of the target the first time
      for (var i = 0; i < show.seasons.length; i++) {
        if (show.seasons[i].episodes.indexOf(t.ep) >= 0) { if (!seasonChosen) { seasonIdx = i; seasonChosen = true } break }
      }
    }
    actions.appendChild(button('Back', function () { ctx.router.back() }))
  }

  function renderSeasons() {
    clear(seasonsEl)
    if (show.seasons.length < 2) return
    show.seasons.forEach(function (s, i) {
      var b = focusable(h('div', { cls: 'season-btn' + (i === seasonIdx ? ' current' : ''), text: seasonLabel(s.season) }), function () { seasonIdx = i; renderSeasons(); renderEpisodes(); ctx.focus.focus(seasonsEl.children[i]) })
      seasonsEl.appendChild(b)
    })
  }

  function renderEpisodes() {
    clear(epsEl)
    var s = show.seasons[seasonIdx]
    if (!s) return
    s.episodes.forEach(function (ep) {
      var row = h('div', { cls: 'ep' })
      row.appendChild(h('span', { cls: 'n', text: epCode(ep) || '•' }))
      row.appendChild(h('span', { cls: 't clip1', text: ep.episodeName || ep.title }))
      if (ep.watched) row.appendChild(h('span', { cls: 'w', text: '✓ Watched' }))
      else if (ep.watchedPercent > 0) {
        var fill = h('i')
        fill.style.width = Math.min(100, ep.watchedPercent) + '%'
        row.appendChild(h('div', { cls: 'bar' }, [fill]))
      }
      focusable(row, function () {
        var cont = ctx.session.resumeFor(ep.id)
        play(ep, cont && !cont.upNext ? resumePosition(cont.currentTime, cont.duration) : 0)
      })
      epsEl.appendChild(row)
    })
  }

  function loadShow() {
    clear(actions)
    actions.appendChild(h('span', { cls: 'dim', text: 'Loading episodes…' }))
    ctx.api.episodes(item.key).then(function (r) {
      if (dead) return
      show = r
      if (r.show.overview) setText(synopsis, r.show.overview)
      renderShowActions()
      renderSeasons()
      renderEpisodes()
      if (!allEpisodes().length) { clear(actions); actions.appendChild(button('Back', function () { ctx.router.back() })); setText(synopsis, 'There are no episodes in this show yet.') }
      ctx.focus.focusFirst(playBtn)
    }, function (e) {
      if (dead) return
      clear(actions)
      actions.appendChild(button('Try again', loadShow, 'primary'))
      actions.appendChild(button('Back', function () { ctx.router.back() }))
      setText(synopsis, (e && e.friendly) || 'Couldn’t load the episodes.')
      ctx.focus.focusFirst()
    })
  }

  renderMeta()
  return {
    el: el,
    onShow: function () {
      loadNear(el)
      if (!isTv) {
        renderMovieActions() // re-read the resume position each time we come back
        if (!runtime) loadMovieExtras()
        if (item.partial && !item.__resolved) { item.__resolved = true; resolvePartialMovie() }
      } else if (!show) {
        loadShow()
      } else {
        renderShowActions()
        renderEpisodes()
        ctx.focus.focusFirst(playBtn)
      }
    },
    onHide: function () { unload(el) },
    destroy: function () { dead = true; unload(el) }
  }
}

