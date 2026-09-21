// DOM side of D-pad navigation: which element has focus, moving it, scrolling it into view.
// The geometry decision itself lives in spatial.js (pure, unit-tested).
//
// Focusable elements carry data-f="1" and (optionally) el.onSelect / el.onFocus functions.
// We never use DOM focus() - key events are handled on document - so there is no browser focus
// ring, no scroll-on-focus surprise, and nothing to fight the TV's own UI.
//
// Scrollers: any ancestor with data-scroll="x|y|xy" (overflow:hidden) is moved by setting
// scrollLeft/scrollTop so the focused element is fully visible. data-pad-x / data-pad-y (px, in
// design pixels) keep a margin so neighbours peek in.
//
// Custom navigators: an element (or any ancestor of the focused one) may define
// el.navHandler = function (dir) -> boolean. It is asked first; true means "handled" (used by the
// virtual grid, which re-renders rows instead of relying on offscreen DOM).

import { nextFocus, initialFocus, closestTo } from './spatial.js'

export function createFocus() {
  var scopes = [] // stack of { root, last }
  var current = null

  function scope() { return scopes.length ? scopes[scopes.length - 1] : null }

  function visible(el) {
    if (!el.offsetParent && el.style.position !== 'fixed') {
      // offsetParent is null for display:none (and for the root); treat both as not focusable
      var r0 = el.getBoundingClientRect()
      if (r0.width === 0 && r0.height === 0) return false
    }
    return true
  }

  function collect(root) {
    var list = root.querySelectorAll('[data-f]')
    var out = []
    for (var i = 0; i < list.length; i++) {
      var el = list[i]
      if (!visible(el)) continue
      var r = el.getBoundingClientRect()
      if (r.width <= 0 || r.height <= 0) continue
      out.push({ id: i, el: el, x: r.left, y: r.top, w: r.width, h: r.height })
    }
    return out
  }

  function paint(el) {
    if (current && current !== el) current.classList.remove('is-focused')
    current = el
    if (el) el.classList.add('is-focused')
  }

  function scrollAxis(sc, el, axis) {
    var s = sc.getBoundingClientRect()
    var r = el.getBoundingClientRect()
    var k = sc.offsetWidth ? s.width / sc.offsetWidth : 1 // current canvas scale
    if (!k) k = 1
    if (axis === 'x') {
      var padX = (parseInt(sc.getAttribute('data-pad-x'), 10) || 40) * k
      if (r.left < s.left + padX) sc.scrollLeft -= (s.left + padX - r.left) / k
      else if (r.right > s.right - padX) sc.scrollLeft += (r.right - (s.right - padX)) / k
    } else {
      var padY = (parseInt(sc.getAttribute('data-pad-y'), 10) || 40) * k
      if (r.top < s.top + padY) sc.scrollTop -= (s.top + padY - r.top) / k
      else if (r.bottom > s.bottom - padY) sc.scrollTop += (r.bottom - (s.bottom - padY)) / k
    }
  }

  function ensureVisible(el) {
    var p = el.parentNode
    var guard = 0
    while (p && p.nodeType === 1 && guard++ < 12) {
      var mode = p.getAttribute('data-scroll')
      if (mode) {
        if (mode.indexOf('x') >= 0) scrollAxis(p, el, 'x')
        if (mode.indexOf('y') >= 0) scrollAxis(p, el, 'y')
      }
      p = p.parentNode
    }
  }

  var api = {
    /** Give focus to an element (must be inside the active scope). */
    focus: function (el, noScroll) {
      if (!el) return
      paint(el)
      var sc = scope()
      if (sc) sc.last = el
      if (!noScroll) ensureVisible(el)
      if (typeof el.onFocus === 'function') el.onFocus(el)
    },
    current: function () { return current },

    /** Activate a screen/overlay: only its focusables take part. Remembers what to restore on pop. */
    pushScope: function (root, initial) {
      var prev = current
      scopes.push({ root: root, last: null, restore: prev })
      api.focusFirst(initial)
    },
    popScope: function () {
      var s = scopes.pop()
      if (!s) return
      var back = scope()
      var target = s.restore && back && back.root.contains(s.restore) ? s.restore : back && back.last && back.root.contains(back.last) ? back.last : null
      if (target) api.focus(target)
      else if (back) api.focusFirst()
      else { paint(null) }
    },
    /** Replace the top scope's root (screen swapped its content). */
    setScopeRoot: function (root) { if (scope()) scope().root = root },
    scopeDepth: function () { return scopes.length },

    /** Focus `initial` (an element) or else the top-left focusable in scope. */
    focusFirst: function (initial) {
      var sc = scope()
      if (!sc) return
      if (initial && sc.root.contains(initial)) { api.focus(initial); return }
      var rects = collect(sc.root)
      var id = initialFocus(rects)
      var pick = null
      for (var i = 0; i < rects.length; i++) if (rects[i].id === id) pick = rects[i].el
      if (pick) api.focus(pick)
      else paint(null)
    },

    /** Arrow key. Returns true if focus moved / was handled. */
    move: function (dir) {
      var sc = scope()
      if (!sc) return false
      // 1. custom navigators, innermost first
      var n = current
      var guard = 0
      while (n && n !== sc.root.parentNode && guard++ < 12) {
        if (typeof n.navHandler === 'function' && n.navHandler(dir) === true) return true
        n = n.parentNode
      }
      // 2. geometry
      var rects = collect(sc.root)
      var curId = -1
      for (var i = 0; i < rects.length; i++) if (rects[i].el === current) { curId = rects[i].id; break }
      if (curId < 0) {
        // Focus was lost (element removed/hidden): re-anchor to the nearest thing to where it was, else first.
        api.focusFirst()
        return true
      }
      var nextId = nextFocus(rects, curId, dir)
      if (nextId === null) return false
      for (var j = 0; j < rects.length; j++) if (rects[j].id === nextId) { api.focus(rects[j].el); return true }
      return false
    },

    /** OK / Enter on the focused element. */
    activate: function () {
      if (current && typeof current.onSelect === 'function') { current.onSelect(current); return true }
      return false
    },

    /** Re-check that focus still points at a live element in scope; if not, pick a new one. */
    ensureFocus: function () {
      var sc = scope()
      if (!sc) return
      if (current && sc.root.contains(current) && visible(current)) return
      api.focusFirst()
    },

    collect: function () { var sc = scope(); return sc ? collect(sc.root) : [] },
    closestTo: closestTo,
    ensureVisible: ensureVisible
  }
  return api
}
