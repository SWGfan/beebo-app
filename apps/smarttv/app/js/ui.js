// Reusable view pieces. All text goes in via textContent (dom.h `text`), all images via images.lazy.

import { h, focusable, clear } from './dom.js'
import { lazy } from './images.js'
import { assetUrl } from './util/urls.js'
import { formatYear } from './util/escape.js'
import { layoutFor, applyKey } from './nav/keyboardLayout.js'

/**
 * Poster tile. item: { title, poster, year, isNew } ; opts: { origin, sub, progress (0-100), badge, onSelect, cls }
 */
export function posterTile(item, opts) {
  var o = opts || {}
  var poster = h('div', { cls: 'poster' })
  var img = h('img', { attrs: { alt: '' } })
  lazy(img, assetUrl(o.origin || '', item.poster))
  poster.appendChild(img)
  poster.appendChild(h('div', { cls: 'ph', text: item.title }))
  var badge = o.badge || (item.isNew ? 'NEW' : '')
  if (badge) poster.appendChild(h('div', { cls: 'badge', text: badge }))
  if (typeof o.progress === 'number' && o.progress > 0) {
    var bar = h('i')
    bar.style.width = Math.min(100, Math.max(0, o.progress)) + '%'
    poster.appendChild(h('div', { cls: 'progress' }, [bar]))
  }
  var sub = o.sub !== undefined ? o.sub : formatYear(item.year)
  var cap = h('div', { cls: 'cap' }, [h('span', { cls: 'clip1', text: item.title })])
  if (sub) cap.appendChild(h('span', { cls: 'sub clip1', text: sub }))
  var tile = h('div', { cls: 'tile' + (o.cls ? ' ' + o.cls : '') }, [poster, cap])
  return focusable(tile, o.onSelect)
}

export function button(label, onSelect, cls) {
  return focusable(h('div', { cls: 'btn' + (cls ? ' ' + cls : ''), text: label }), onSelect)
}

/** Full-screen state: spinner, title, message and action buttons. */
export function stateBox(opts) {
  var box = h('div', { cls: 'statebox' })
  if (opts.spinner) box.appendChild(h('div', { cls: 'spinner' }))
  if (opts.title) box.appendChild(h('div', { cls: 'title', text: opts.title, css: opts.spinner ? { marginTop: '28px' } : {} }))
  if (opts.message) box.appendChild(h('div', { cls: 'msg', text: opts.message }))
  var acts = opts.actions || []
  if (acts.length) {
    var row = h('div')
    for (var i = 0; i < acts.length; i++) row.appendChild(button(acts[i].label, acts[i].onSelect, i === 0 ? 'primary' : ''))
    box.appendChild(row)
  }
  return box
}

/** Small inline state used inside a rail. */
export function railState(text, actionLabel, onAction) {
  var d = h('div', { cls: 'state', text: text })
  if (actionLabel) {
    d.appendChild(h('span', { text: '   ' }))
    d.appendChild(button(actionLabel, onAction, 'small'))
  }
  return d
}

export var TABS = [
  { id: 'home', label: 'Home' },
  { id: 'movies', label: 'Movies' },
  { id: 'tv', label: 'TV Shows' },
  { id: 'search', label: 'Search' },
  { id: 'settings', label: 'Settings' }
]

/** Brand + tab strip. `onTab(id)` runs on OK. */
export function topbar(current, onTab) {
  var bar = h('div', { cls: 'topbar' }, [h('span', { cls: 'brand', text: 'Beebo' })])
  var tabs = {}
  TABS.forEach(function (t) {
    var el = focusable(h('div', { cls: 'tab' + (t.id === current ? ' current' : ''), text: t.label }), function () { onTab(t.id) })
    tabs[t.id] = el
    bar.appendChild(el)
  })
  bar.tabs = tabs
  return bar
}

/**
 * On-screen keyboard. opts: { mode, value, maxLen, mask, onChange(value), onDone(value) (optional Done key), placeholder }
 * Returns { el (the key grid), field (the value display), getValue(), setValue(v), firstKey() }.
 */
export function createKeyboard(opts) {
  var value = opts.value || ''
  var state = { shift: false, symbols: false }
  var field = h('div', { cls: 'field' })
  var grid = h('div', { cls: 'kb' })

  function renderField() {
    clear(field)
    if (value.length === 0 && opts.placeholder) {
      field.appendChild(h('span', { cls: 'placeholder', text: opts.placeholder }))
    } else {
      var shown = opts.mask ? new Array(value.length + 1).join('•') : value
      field.appendChild(h('span', { text: shown }))
    }
    field.appendChild(h('span', { cls: 'caret' }))
  }

  function press(k, posId) {
    var r = applyKey(value, k, state, opts.maxLen)
    var changedLayout = r.shift !== state.shift || r.symbols !== state.symbols
    value = r.value
    state.shift = r.shift
    state.symbols = r.symbols
    renderField()
    if (opts.onChange) opts.onChange(value)
    if (changedLayout) renderKeys(posId)
  }

  // Keys are re-rendered when shift / the symbols page changes; the key that was pressed keeps focus
  // (identified by its row:column position, which survives a case change).
  function renderKeys(refocusPos) {
    clear(grid)
    var rows = layoutFor(opts.mode || 'search', state)
    var focusEl = null
    rows.forEach(function (row, ri) {
      var r = h('div', { cls: 'kb-row' })
      row.forEach(function (k, ci) {
        var cls = 'key' + (k.wide === 2 ? ' wide' : k.wide === 3 ? ' xwide' : '') + (k.action === 'shift' && state.shift ? ' on' : '')
        var pos = ri + ':' + ci
        var el = focusable(h('div', { cls: cls, text: k.label }), function () { press(k, pos) })
        el.setAttribute('data-kb', pos)
        if (refocusPos && pos === refocusPos) focusEl = el
        r.appendChild(el)
      })
      grid.appendChild(r)
    })
    if (!focusEl && refocusPos) focusEl = grid.querySelector('[data-f]')
    if (focusEl && opts.focus) opts.focus.focus(focusEl)
  }

  renderField()
  renderKeys(null)
  return {
    el: grid,
    field: field,
    getValue: function () { return value },
    setValue: function (v) { value = String(v || ''); renderField() },
    /** Physical keyboard support (dev / USB keyboards): printable characters and Backspace. */
    typeRaw: function (ev) {
      if (ev.ctrlKey || ev.altKey || ev.metaKey) return false
      if (ev.key && ev.key.length === 1) { press({ value: ev.key }, null); return true }
      return false
    },
    backspace: function () { press({ action: 'backspace' }, null) },
    firstKey: function () { return grid.querySelector('[data-f]') }
  }
}
