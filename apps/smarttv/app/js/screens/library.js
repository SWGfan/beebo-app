// Full-library grid (Movies / TV Shows) - a VIRTUAL grid: only the rows around the focused item exist
// in the DOM (see pagination.windowRange), so 1300+ shows cost the same as 40. Items arrive in pages
// (createPagedList) as focus nears the end of what is loaded.

import { h, clear, setText } from '../dom.js'
import { posterTile, topbar, stateBox } from '../ui.js'
import { loadNear, unload, nearLoader } from '../images.js'
import { windowRange, gridMove } from '../util/pagination.js'

function cssPx(name, fallback) {
  try {
    var v = parseInt(getComputedStyle(document.documentElement).getPropertyValue(name), 10)
    return isFinite(v) && v > 0 ? v : fallback
  } catch (e) { return fallback }
}

export function library(ctx, params) {
  var kind = params.kind === 'tv' ? 'tv' : 'movie'
  var el = h('div', { cls: 'screen' })
  var dead = false
  var bar = topbar(kind === 'tv' ? 'tv' : 'movies', function (id) { ctx.goTab(id) })
  var head = h('div', { cls: 'vgrid-head heading', text: kind === 'tv' ? 'TV Shows' : 'Movies' })
  var grid = h('div', { cls: 'vgrid', attrs: { 'data-scroll': 'y', 'data-pad-y': '30' } })
  var inner = h('div', { cls: 'vgrid-inner' })
  var more = h('div', { cls: 'vgrid-more' })
  grid.appendChild(inner)
  el.appendChild(bar)
  el.appendChild(head)
  el.appendChild(grid)
  el.appendChild(more)
  var body = h('div') // holds error/empty states
  el.appendChild(body)

  var cols = cssPx('--grid-cols', 8)
  var tileW = cssPx('--grid-poster-w', 190)
  var posterH = cssPx('--grid-poster-h', 285)
  var gap = cssPx('--tile-gap', 26)
  var pitchX = tileW + gap
  var rowH = posterH + 58 + 10 + gap

  var pager = ctx.session.library(kind)
  var tiles = {} // index -> element
  var focusIndex = 0
  var near = nearLoader(grid, 60)
  var started = false

  function totalKnown() { return Math.max(pager.size(), pager.total() || 0) }

  function updateHead() {
    var t = pager.total()
    var base = kind === 'tv' ? 'TV Shows' : 'Movies'
    setText(head, t ? base + '  ·  ' + t : base)
  }

  function makeTile(i) {
    var it = pager.items()[i]
    var t = posterTile(it, { origin: ctx.origin(), onSelect: function () { ctx.openDetail(it) } })
    var col = i % cols
    var row = Math.floor(i / cols)
    t.style.left = col * pitchX + 'px'
    t.style.top = row * rowH + 'px'
    t._index = i
    t.onFocus = function () {
      focusIndex = i
      updateWindow()
      if (pager.shouldPrefetch(i, cols * 2)) loadMore()
      near()
    }
    return t
  }

  function updateWindow() {
    var rows = Math.ceil(totalKnown() / cols)
    inner.style.height = rows * rowH + 'px'
    inner.style.width = cols * pitchX + 'px'
    var w = windowRange({ total: pager.size(), columns: cols, focusIndex: focusIndex, rowsBefore: 2, rowsAfter: 4 })
    // drop tiles outside the window (their <img> elements go with them: bitmaps freed)
    for (var k in tiles) {
      var idx = +k
      if (idx < w.startIndex || idx >= w.endIndex) {
        if (tiles[k] === ctx.focus.current()) continue
        inner.removeChild(tiles[k])
        delete tiles[k]
      }
    }
    for (var i = w.startIndex; i < w.endIndex; i++) {
      if (!tiles[i]) { tiles[i] = makeTile(i); inner.appendChild(tiles[i]) }
    }
    setText(more, pager.isComplete() ? '' : (pager.isLoading() ? 'Loading more…' : ''))
  }

  function loadMore() {
    if (dead || pager.isComplete() || pager.isLoading()) return
    setText(more, 'Loading more…')
    pager.loadMore().then(function () {
      if (dead) return
      updateHead()
      updateWindow()
      near()
    }, function () {
      if (dead) return
      setText(more, 'Couldn’t load more. Press OK on the last poster to try again.')
    })
  }

  function focusTile(i) {
    focusIndex = i
    updateWindow()
    var t = tiles[i]
    if (t) ctx.focus.focus(t)
    return !!t
  }

  // Arrow keys inside the grid: index maths, not DOM geometry (rows outside the window do not exist).
  grid.navHandler = function (dir) {
    var cur = ctx.focus.current()
    if (!cur || cur._index === undefined) return false
    var idx = cur._index
    var target = gridMove(idx, dir, cols, pager.size())
    if (target === -1) return false // up from the first row: leave the grid (tab bar)
    if (target === idx) {
      if (dir === 'down' && !pager.isComplete()) loadMore()
      return true
    }
    focusTile(target)
    return true
  }

  function showError(e) {
    clear(body)
    body.appendChild(stateBox({
      title: 'Couldn’t load your ' + (kind === 'tv' ? 'TV shows' : 'movies'),
      message: (e && e.friendly) || 'Something went wrong.',
      actions: [{ label: 'Try again', onSelect: function () { pager.reset(); start() } }, { label: 'Back', onSelect: function () { ctx.router.back() } }]
    }))
    grid.style.display = 'none'
    ctx.focus.focusFirst()
  }

  function start() {
    clear(body)
    grid.style.display = ''
    setText(more, 'Loading…')
    pager.ensure(0).then(function () {
      if (dead) return
      updateHead()
      if (pager.size() === 0) {
        setText(more, '')
        body.appendChild(stateBox({
          title: kind === 'tv' ? 'No TV shows yet' : 'No movies yet',
          message: 'Add some to the Beebo library on your computer and they will show up here.',
          actions: [{ label: 'Back', onSelect: function () { ctx.router.back() } }]
        }))
        ctx.focus.focusFirst()
        return
      }
      updateWindow()
      loadNear(grid)
      var first = tiles[0]
      if (first) ctx.focus.focus(first)
    }, function (e) { if (!dead) { setText(more, ''); showError(e) } })
  }

  return {
    el: el,
    onShow: function () {
      if (!started) { started = true; start() } else {
        updateWindow()
        loadNear(grid)
        ctx.focus.ensureFocus()
      }
    },
    onHide: function () { unload(el) },
    destroy: function () { dead = true; for (var k in tiles) delete tiles[k]; clear(inner); unload(el) }
  }
}
