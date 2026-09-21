// posterZoom.js - how big the library posters are, as pure math plus a small
// frame-coalescing store. The size is the grid columns' minimum width in px
// (the --poster-size CSS variable, see styles.css); a wider size means fewer,
// bigger posters. No React and no DOM here, so node --test covers it
// (test/poster-zoom.test.js); the DOM wiring is in posterZoomDom.js.

export const POSTER_MIN = 90
export const POSTER_MAX = 320
// Today's grid: minmax(160px, 1fr). Changing this changes every existing user's layout.
export const POSTER_DEFAULT = 160
export const SLIDER_STEPS = 100

// Multiplicative step for keyboard shortcuts: each press changes the poster width by ~12%,
// which is about one column of difference on a typical window at any size.
const KEY_STEP = 1.12
// Wheel: size *= exp(-delta * WHEEL_RATE). A standard mouse notch (100px) is ~x0.82; the
// small deltas a trackpad pinch sends add up smoothly.
const WHEEL_RATE = 0.002
const LINE_HEIGHT_PX = 16
const PAGE_HEIGHT_PX = 400

const round1 = (n) => Math.round(n * 10) / 10

export function clampPosterSize(value) {
  const n = value === null || value === '' || typeof value === 'boolean' ? NaN : Number(value)
  if (!Number.isFinite(n)) return POSTER_DEFAULT
  return round1(Math.min(POSTER_MAX, Math.max(POSTER_MIN, n)))
}

// The slider is logarithmic: equal slider distances change the column count by equal
// proportions, instead of the top half of a linear slider doing almost nothing.
export function sizeToSlider(size) {
  const ratio = Math.log(clampPosterSize(size) / POSTER_MIN) / Math.log(POSTER_MAX / POSTER_MIN)
  return Math.round(ratio * SLIDER_STEPS)
}

export function sliderToSize(position) {
  const step = Math.min(SLIDER_STEPS, Math.max(0, Number(position) || 0))
  // The default falls between two slider steps; snapping its step to it means dragging the
  // slider can land exactly on the original size, not just the reset button.
  if (step === sizeToSlider(POSTER_DEFAULT)) return POSTER_DEFAULT
  return clampPosterSize(POSTER_MIN * Math.pow(POSTER_MAX / POSTER_MIN, step / SLIDER_STEPS))
}

// direction > 0 is bigger posters. Always moves by at least 1px so it can never stall on rounding,
// and lands exactly on the limits.
export function stepPosterSize(size, direction) {
  const current = clampPosterSize(size)
  const next = direction > 0 ? current * KEY_STEP : current / KEY_STEP
  const moved = direction > 0 ? Math.max(next, current + 1) : Math.min(next, current - 1)
  return clampPosterSize(Math.round(moved))
}

// wheel deltaY > 0 (scroll down / pinch in) is smaller posters, like a browser's ctrl+wheel.
export function wheelPosterSize(size, deltaY, deltaMode = 0) {
  const unit = deltaMode === 1 ? LINE_HEIGHT_PX : deltaMode === 2 ? PAGE_HEIGHT_PX : 1
  const delta = Number(deltaY) * unit
  if (!Number.isFinite(delta) || delta === 0) return clampPosterSize(size)
  return clampPosterSize(clampPosterSize(size) * Math.exp(-delta * WHEEL_RATE))
}

// Alt+wheel is the requested gesture; Ctrl+wheel also covers a trackpad pinch, which browsers
// deliver as ctrl+wheel. Shift is left alone (horizontal scroll), as is a plain wheel.
export function isPosterZoomWheel(event) {
  return !!event && (!!event.ctrlKey || !!event.altKey) && !event.shiftKey && !event.metaKey
}

// Keyboard: Alt + "+" / "-" / "0". Ctrl is deliberately not used: Ctrl +/- and 0 are the app's
// whole-window zoom, which people with low vision rely on.
export function posterZoomKeyAction(event) {
  if (!event || !event.altKey || event.ctrlKey || event.metaKey) return null
  if (event.key === '+' || event.key === '=') return 'bigger'
  if (event.key === '-' || event.key === '_') return 'smaller'
  if (event.key === '0') return 'reset'
  return null
}

// Text and badge density for a poster width. The default (160) is 'full': the look the
// cards had before zoom existed.
export function densityFor(size) {
  const px = clampPosterSize(size)
  if (px < 110) return 'mini'
  if (px < 140) return 'compact'
  if (px >= 240) return 'large'
  return 'full'
}

// Keeps the poster that was near the top of the view where it was: `before`/`after` are that
// poster's distance from the top of the scroller before and after the layout changed.
export function anchoredScrollTop(scrollTop, before, after) {
  if (!Number.isFinite(before) || !Number.isFinite(after)) return scrollTop
  const delta = after - before
  return Math.abs(delta) < 0.5 ? scrollTop : Math.max(0, scrollTop + delta)
}

// Holds the current size, applies it at most once per animation frame (a wheel can fire far
// faster than the grid can re-lay-out) and saves it once the changes stop. `apply` does the
// DOM write; `save` persists.
export function createPosterZoom({
  initial = POSTER_DEFAULT,
  apply = () => {},
  save = () => {},
  raf = (fn) => setTimeout(fn, 16),
  caf = (id) => clearTimeout(id),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  saveDelay = 500
} = {}) {
  let size = clampPosterSize(initial)
  let frame = null
  let saveTimer = null
  const listeners = new Set()

  const flush = () => {
    frame = null
    apply(size)
    for (const listener of [...listeners]) listener()
  }
  const schedule = () => { if (frame === null) frame = raf(flush) }
  const persistSoon = () => {
    if (saveTimer !== null) clearTimer(saveTimer)
    saveTimer = setTimer(() => { saveTimer = null; save(Math.round(size)) }, saveDelay)
  }

  function set(next, { persist = true } = {}) {
    const clamped = clampPosterSize(next)
    if (clamped === size) return size
    size = clamped
    schedule()
    if (persist) persistSoon()
    return size
  }

  return {
    // Immediate: a burst of wheel events compounds on the latest target, not the last painted size.
    getSize: () => size,
    set,
    // From storage: shown, but not written straight back.
    hydrate(next) { return set(next, { persist: false }) },
    reset: () => set(POSTER_DEFAULT),
    bigger: () => set(stepPosterSize(size, 1)),
    smaller: () => set(stepPosterSize(size, -1)),
    wheel: (deltaY, deltaMode) => set(wheelPosterSize(size, deltaY, deltaMode)),
    // Paint the current size right now (first render), without waiting for a frame.
    applyNow() { if (frame !== null) { caf(frame); frame = null } apply(size) },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    dispose() {
      if (frame !== null) caf(frame)
      if (saveTimer !== null) clearTimer(saveTimer)
      frame = null
      saveTimer = null
      listeners.clear()
    }
  }
}
