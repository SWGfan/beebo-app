// Home: top bar + rails (Continue Watching, Recently Added, Movies, TV Shows). Back exits the app.

import { h, focusable, clear } from '../dom.js'
import { posterTile, topbar, railState, stateBox } from '../ui.js'
import { loadNear, unload, nearLoader } from '../images.js'
import { railSlice } from '../util/pagination.js'
import { formatClock } from '../util/escape.js'

var RAIL_ITEMS = 20

export function home(ctx) {
  var el = h('div', { cls: 'screen' })
  var dead = false
  var bar = topbar('home', function (id) { ctx.goTab(id) })
  var scroller = h('div', { cls: 'page-scroll', attrs: { 'data-scroll': 'y', 'data-pad-y': '30' } })
  var body = h('div')
  scroller.appendChild(body)
  el.appendChild(bar)
  el.appendChild(scroller)
  var near = nearLoader(scroller, 60)
  var rails = {} // id -> { block, inner, wrap }

  // Vertical page scroll + horizontal rail scroll both change what is near the viewport.
  function afterFocus() { near() }

  function makeRail(id, title) {
    var block = h('div', { cls: 'rail-block' })
    block.appendChild(h('div', { cls: 'rail-title', text: title }))
    var wrap = h('div', { cls: 'rail', attrs: { 'data-scroll': 'x', 'data-pad-x': '120' } })
    var inner = h('div', { cls: 'rail-inner' })
    wrap.appendChild(inner)
    block.appendChild(wrap)
    body.appendChild(block)
    rails[id] = { block: block, inner: inner, wrap: wrap }
    return rails[id]
  }

  function fillRail(id, items, build, opts) {
    var r = rails[id]
    if (!r || dead) return
    clear(r.inner)
    if (!items.length) {
      if (opts && opts.hideWhenEmpty) { r.block.style.display = 'none'; return }
      r.inner.appendChild(railState(opts && opts.empty ? opts.empty : 'Nothing here yet.'))
      return
    }
    r.block.style.display = ''
    var s = railSlice(items, RAIL_ITEMS)
    for (var i = 0; i < s.items.length; i++) r.inner.appendChild(build(s.items[i], i))
    if (s.more && opts && opts.seeAll) r.inner.appendChild(seeAllTile(opts.seeAll))
    hookFocus(r.inner)
    near()
    if (autoFocus && ctx.focus.current() === bar.tabs.home) {
      var firstTile = body.querySelector('.tile')
      if (firstTile) ctx.focus.focus(firstTile)
    }
  }

  function seeAllTile(onSelect) {
    var t = h('div', { cls: 'tile seeall' }, [
      h('div', { cls: 'poster' }, [h('div', { cls: 'ph', text: 'See all' })]),
      h('div', { cls: 'cap' })
    ])
    return focusable(t, onSelect)
  }

  function railError(id, retry, e) {
    var r = rails[id]
    if (!r || dead) return
    clear(r.inner)
    r.inner.appendChild(railState((e && e.friendly) || 'Couldn’t load this row.', 'Try again', retry))
    ctx.focus.ensureFocus()
  }

  function hookFocus(inner) {
    var tiles = inner.querySelectorAll('[data-f]')
    for (var i = 0; i < tiles.length; i++) tiles[i].onFocus = afterFocus
  }

  // ---- data ----------------------------------------------------------------------------------
  function loadContinue() {
    ctx.api.continueWatching().then(function (items) {
      if (dead) return
      ctx.session.setContinue(items)
      fillRail('continue', items, function (it) {
        var sub = it.duration > 0 ? formatClock(it.currentTime) + ' / ' + formatClock(it.duration) : ''
        if (it.upNext) sub = 'Up next'
        return posterTile(it, { origin: ctx.origin(), progress: it.upNext ? 0 : it.percent, sub: sub, badge: '', onSelect: function () { ctx.playItem(it) } })
      }, { hideWhenEmpty: true })
      ctx.focus.ensureFocus()
    }, function (e) { if (e && e.kind !== 'unauthorized') railError('continue', loadContinue, e) })
  }

  function loadRecent() {
    ctx.api.recentlyAdded().then(function (items) {
      if (dead) return
      fillRail('recent', items, function (it) {
        return posterTile(it, { origin: ctx.origin(), sub: it.kind === 'tv' ? 'TV show' : 'Movie', badge: '', onSelect: function () { ctx.openDetail(it) } })
      }, { hideWhenEmpty: true })
    }, function (e) { if (e && e.kind !== 'unauthorized') railError('recent', loadRecent, e) })
  }

  function loadLibrary(kind, id) {
    var pager = ctx.session.library(kind)
    pager.ensure(0).then(function () {
      if (dead) return
      var seeAll = function () { ctx.goTab(kind === 'tv' ? 'tv' : 'movies') }
      fillRail(id, pager.items(), function (it) {
        return posterTile(it, { origin: ctx.origin(), onSelect: function () { ctx.openDetail(it) } })
      }, { seeAll: seeAll, empty: kind === 'tv' ? 'No TV shows found yet.' : 'No movies found yet.' })
      ctx.focus.ensureFocus()
    }, function (e) { if (e && e.kind !== 'unauthorized') railError(id, function () { pager.reset(); loadLibrary(kind, id) }, e) })
  }

  function loading(id) {
    var r = rails[id]
    if (r) { clear(r.inner); r.inner.appendChild(railState('Loading…')) }
  }

  function build() {
    makeRail('continue', 'Continue Watching')
    makeRail('recent', 'Recently Added')
    makeRail('movies', 'Movies')
    makeRail('tv', 'TV Shows')
    ;['continue', 'recent', 'movies', 'tv'].forEach(loading)
    loadContinue()
    loadRecent()
    loadLibrary('movie', 'movies')
    // The TV list can be slow on a big library; start it after the first rows are on their way.
    setTimeout(function () { if (!dead) loadLibrary('tv', 'tv') }, 250)
  }

  var built = false
  var autoFocus = true // until the person presses a key, move focus onto the first poster once rows arrive
  return {
    el: el,
    onShow: function () {
      if (!built) { built = true; build() } else {
        // Coming back from a detail/player: refresh Continue Watching (progress changed) and reload images.
        loadContinue()
        near()
      }
      loadNear(scroller)
      // Start on the first poster if there is one, else on the tab bar.
      var first = body.querySelector('[data-f]')
      ctx.focus.focus(ctx.focus.current() && el.contains(ctx.focus.current()) ? ctx.focus.current() : (first || bar.tabs.home))
    },
    onHide: function () { unload(el) },
    destroy: function () { dead = true; unload(el) },
    onKey: function (action) {
      autoFocus = false
      if (action === 'back') { ctx.platform.exit(); return true }
      // Up from the first rail lands on the tab bar via geometry; nothing else to do.
      return false
    }
  }
}
