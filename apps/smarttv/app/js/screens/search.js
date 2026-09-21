// Search: on-screen keyboard on the left, results on the right. Server-side filtering (?q=), first
// page of each kind only (a TV is for browsing, not for scrolling 500 matches).

import { h, clear, setText } from '../dom.js'
import { posterTile, topbar, createKeyboard } from '../ui.js'
import { loadNear, unload, nearLoader } from '../images.js'

var RESULTS_PER_KIND = 24
var DEBOUNCE_MS = 550

export function search(ctx) {
  var el = h('div', { cls: 'screen' })
  var dead = false
  var bar = topbar('search', function (id) { ctx.goTab(id) })
  var left = h('div', { cls: 'search-left' })
  var right = h('div', { cls: 'search-right', attrs: { 'data-scroll': 'y', 'data-pad-y': '30' } })
  var results = h('div')
  right.appendChild(results)
  var timer = null
  var seq = 0
  var near = nearLoader(right, 60)

  var kb = createKeyboard({ mode: 'search', value: '', maxLen: 60, placeholder: 'Type a title', focus: ctx.focus, onChange: onChange })
  left.appendChild(kb.field)
  left.appendChild(kb.el)
  el.appendChild(bar)
  el.appendChild(left)
  el.appendChild(right)

  function note(text) {
    clear(results)
    results.appendChild(h('div', { cls: 'results-note', text: text }))
  }

  function onChange(value) {
    if (timer) clearTimeout(timer)
    var q = value.trim()
    if (q.length < 2) { seq++; note(q.length ? 'Keep typing…' : 'Use the keyboard to search your movies and shows.'); return }
    note('Searching…')
    timer = setTimeout(function () { run(q) }, DEBOUNCE_MS)
  }

  function section(title, items, total) {
    var wrap = h('div')
    wrap.appendChild(h('div', { cls: 'results-head', text: title }))
    var line = h('div', { css: { whiteSpace: 'normal' } })
    items.forEach(function (it) {
      var t = posterTile(it, { origin: ctx.origin(), onSelect: function () { ctx.openDetail(it) } })
      t.onFocus = near
      line.appendChild(t)
    })
    wrap.appendChild(line)
    if (total > items.length) wrap.appendChild(h('div', { cls: 'results-note', text: 'Showing the first ' + items.length + ' of ' + total + '. Type more to narrow it down.' }))
    return wrap
  }

  function run(q) {
    var mine = ++seq
    var mp = ctx.session.search('movie', q)
    var sp = ctx.session.search('tv', q)
    var both = [
      mp.loadMore().then(function () { return { items: mp.items().slice(0, RESULTS_PER_KIND), total: mp.total() || mp.items().length } }),
      sp.loadMore().then(function () { return { items: sp.items().slice(0, RESULTS_PER_KIND), total: sp.total() || sp.items().length } })
    ]
    Promise.all(both).then(function (r) {
      if (dead || mine !== seq) return // a newer query is already running
      clear(results)
      if (!r[0].items.length && !r[1].items.length) { note('No matches for “' + q + '”.'); return }
      if (r[0].items.length) results.appendChild(section('Movies', r[0].items, r[0].total))
      if (r[1].items.length) results.appendChild(section('TV Shows', r[1].items, r[1].total))
      right.scrollTop = 0
      loadNear(right)
    }, function (e) {
      if (dead || mine !== seq) return
      note((e && e.friendly) || 'Search failed.')
    })
  }

  note('Use the keyboard to search your movies and shows.')
  var shown = false

  return {
    el: el,
    onShow: function () {
      if (!shown) { shown = true; ctx.focus.focus(kb.firstKey()) } else ctx.focus.ensureFocus()
      loadNear(right)
    },
    onHide: function () { unload(el) },
    onRawKey: function (ev) { return kb.typeRaw(ev) },
    onKey: function (action) {
      var cur = ctx.focus.current()
      if (action === 'back' && cur && cur.classList.contains('key') && kb.getValue().length > 0) { kb.backspace(); return true }
      return false
    },
    destroy: function () { dead = true; seq++; if (timer) clearTimeout(timer); unload(el); clear(results) }
  }
}
