// sidebarMode.js - the left navigation panel's three display modes and the
// open/close state machine behind them. No React, no DOM, no real timers: the
// timer functions are injected so node --test drives it with a fake clock
// (test/sidebar-mode.test.js).
//
//   pinned  Always shown: a normal column beside the content.
//   hover   Slides over the content when the pointer touches the left edge, and
//           away again after the pointer (and keyboard focus) has left.
//   hidden  Closed until the hamburger is pressed.
//
// In hover and hidden the panel is an overlay. It is opened either by hovering
// ("transient": closes itself again) or by pressing the hamburger ("explicit":
// stays until Escape, a click outside, picking a page or the hamburger again -
// the only way a touch screen, which cannot hover, ever gets it back).

export const SIDEBAR_MODES = Object.freeze(['pinned', 'hover', 'hidden'])
export const DEFAULT_SIDEBAR_MODE = 'pinned'
export const SIDEBAR_MODE_LABELS = Object.freeze({
  pinned: 'Always shown',
  hover: 'Show on hover',
  hidden: 'Hidden until I press the icon'
})

// The pointer is "at the edge" this many pixels from the window's left side.
export const EDGE_WIDTH_PX = 10
// Open only after the pointer has rested at the edge this long (ignores a mouse just passing by).
export const OPEN_DELAY_MS = 120
// Stay open this long after the pointer leaves, so a slightly wobbly exit does not flicker it shut.
export const CLOSE_DELAY_MS = 350

export function normalizeSidebarMode(value) {
  return SIDEBAR_MODES.includes(value) ? value : DEFAULT_SIDEBAR_MODE
}

function snapshotOf(mode, open, explicit, menuOpen) {
  return Object.freeze({ mode, open, explicit, menuOpen, visible: mode === 'pinned' || open })
}

export function createSidebarController({
  mode = DEFAULT_SIDEBAR_MODE,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  openDelay = OPEN_DELAY_MS,
  closeDelay = CLOSE_DELAY_MS,
  edgeWidth = EDGE_WIDTH_PX
} = {}) {
  let state = snapshotOf(normalizeSidebarMode(mode), false, false, false)
  // Pointer position is tracked geometrically (x only: the panel is full height) instead of
  // through enter/leave events, because a panel that slides in under a stationary pointer
  // does not reliably fire them.
  let pointerX = null
  let panelWidth = 0
  let focusIn = false
  // After a deliberate close the pointer may still be resting on the edge; it has to leave
  // the edge once before it can open the panel again.
  let armed = true
  let openTimer = null
  let closeTimer = null
  const listeners = new Set()

  const clearOpenTimer = () => { if (openTimer !== null) { clearTimer(openTimer); openTimer = null } }
  const clearCloseTimer = () => { if (closeTimer !== null) { clearTimer(closeTimer); closeTimer = null } }
  const near = () => pointerX !== null && pointerX <= (state.open ? panelWidth : edgeWidth)
  const held = () => near() || focusIn || state.menuOpen

  function commit(next) {
    if (next.mode === state.mode && next.open === state.open && next.explicit === state.explicit && next.menuOpen === state.menuOpen) return
    state = next
    for (const listener of [...listeners]) listener()
  }

  function evaluate() {
    if (state.mode === 'pinned' || (state.open && state.explicit)) {
      clearOpenTimer()
      clearCloseTimer()
      return
    }
    if (!state.open) {
      clearCloseTimer()
      if (state.mode === 'hover' && armed && near()) {
        if (openTimer === null) {
          openTimer = setTimer(() => {
            openTimer = null
            if (state.mode === 'hover' && !state.open && armed && near()) setOpen(true, false)
          }, openDelay)
        }
      } else {
        clearOpenTimer()
      }
      return
    }
    clearOpenTimer()
    if (held()) {
      clearCloseTimer()
    } else if (closeTimer === null) {
      closeTimer = setTimer(() => {
        closeTimer = null
        if (state.open && !state.explicit && !held()) setOpen(false, false)
      }, closeDelay)
    }
  }

  function setOpen(open, explicit) {
    if (!open) {
      focusIn = false
      clearOpenTimer()
      clearCloseTimer()
    }
    commit(snapshotOf(state.mode, open, open && explicit, open ? state.menuOpen : false))
    evaluate()
  }

  function closeDeliberately() {
    armed = pointerX === null || pointerX > edgeWidth
    setOpen(false, false)
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    // x is the pointer's distance from the window's left edge; width is the panel's current width.
    pointerMoved(x, width) {
      pointerX = Number.isFinite(x) ? x : null
      if (Number.isFinite(width)) panelWidth = width
      if (pointerX !== null && pointerX > edgeWidth) armed = true
      evaluate()
    },
    // Pointer left the window (or the window lost focus): nothing is being pointed at any more.
    pointerLeft() {
      pointerX = null
      armed = true
      evaluate()
    },
    setFocusWithin(value) {
      focusIn = !!value && state.open
      evaluate()
    },
    setMenuOpen(value) {
      const available = state.mode === 'pinned' || state.open
      commit(snapshotOf(state.mode, state.open, state.explicit, available && !!value))
      evaluate()
    },
    // The hamburger. Returns what it did so the UI knows whether to open the mode menu instead.
    toggle() {
      if (state.mode === 'pinned') return 'none'
      if (state.open) { closeDeliberately(); return 'closed' }
      setOpen(true, true)
      return 'opened'
    },
    // Escape or a click outside the panel.
    dismiss() {
      if (state.mode === 'pinned' || !state.open) return false
      closeDeliberately()
      return true
    },
    // A page was chosen from the panel. A hover-opened panel a mouse user is still pointing at
    // stays (they may click through several pages); one opened with the hamburger, or driven
    // from the keyboard, has done its job.
    pageSelected() {
      if (state.mode === 'pinned' || !state.open) return false
      if (state.explicit || focusIn) { closeDeliberately(); return true }
      return false
    },
    setMode(next) {
      const target = normalizeSidebarMode(next)
      if (target === state.mode) return
      const wasVisible = state.visible
      clearOpenTimer()
      clearCloseTimer()
      // Choosing "Show on hover" from a visible panel leaves it open, and it then closes by itself
      // as soon as the pointer leaves - so the change is visible immediately. The other two
      // modes close it at once (pinned no longer needs the overlay flag; hidden must hide).
      const open = target === 'hover' && wasVisible
      if (!open) focusIn = false
      // The display choice lives inside the panel: a closed overlay must not keep it "open".
      commit(snapshotOf(target, open, false, open || target === 'pinned' ? state.menuOpen : false))
      evaluate()
    },
    dispose() {
      clearOpenTimer()
      clearCloseTimer()
    }
  }
}
