// Screen stack. A screen is a factory (ctx, params) -> { el, onShow?, onHide?, destroy?, onKey?, onRawKey? }.
//
// Memory hygiene: a screen that is covered by another one is hidden (display:none) and told to
// drop its heavy stuff (onHide -> images.unload); when it is uncovered again onShow reloads what
// is near the viewport. A screen that is popped is destroyed: destroy() must clear timers, abort
// in-flight work, and free media; then its DOM subtree is removed.
//
// Focus scopes: showing a screen pushes one scope; overlays a screen opens push more on top. When a
// screen is hidden or destroyed every scope it (or its overlays) pushed is unwound first.

export function createRouter(container, focus, factories, ctx) {
  var stack = [] // { name, screen, el, lastFocus, depth }

  function top() { return stack.length ? stack[stack.length - 1] : null }

  function unwind(entry) {
    while (focus.scopeDepth() >= entry.depth && focus.scopeDepth() > 0) focus.popScope()
  }

  function hide(entry) {
    entry.lastFocus = focus.current()
    try { if (entry.screen.onHide) entry.screen.onHide() } catch (e) { /* a screen bug must not break navigation */ }
    unwind(entry)
    entry.el.classList.add('is-hidden')
  }

  function show(entry) {
    entry.el.classList.remove('is-hidden')
    focus.pushScope(entry.el, entry.lastFocus && entry.el.contains(entry.lastFocus) ? entry.lastFocus : null)
    entry.depth = focus.scopeDepth()
    try { if (entry.screen.onShow) entry.screen.onShow() } catch (e) { /* ignore */ }
  }

  function destroy(entry) {
    if (!entry.el.classList.contains('is-hidden')) unwind(entry)
    try { if (entry.screen.destroy) entry.screen.destroy() } catch (e) { /* ignore */ }
    if (entry.el.parentNode) entry.el.parentNode.removeChild(entry.el)
  }

  function mount(name, params) {
    var screen = factories[name](ctx, params || {})
    container.appendChild(screen.el)
    return { name: name, screen: screen, el: screen.el, lastFocus: null, depth: 0 }
  }

  return {
    push: function (name, params) {
      var prev = top()
      if (prev) hide(prev)
      var entry = mount(name, params)
      stack.push(entry)
      show(entry)
    },
    /** Replace the current screen (its history entry is dropped). */
    replace: function (name, params) {
      var prev = stack.pop()
      if (prev) destroy(prev)
      var entry = mount(name, params)
      stack.push(entry)
      show(entry)
    },
    /** Clear the whole stack and start again (sign-out, first run). */
    reset: function (name, params) {
      while (stack.length) destroy(stack.pop())
      var entry = mount(name, params)
      stack.push(entry)
      show(entry)
    },
    /** Pop one screen. Returns false when there is nothing to go back to (root). */
    back: function () {
      if (stack.length <= 1) return false
      destroy(stack.pop())
      show(top())
      return true
    },
    depth: function () { return stack.length },
    currentName: function () { var t = top(); return t ? t.name : '' },
    currentScreen: function () { var t = top(); return t ? t.screen : null }
  }
}
