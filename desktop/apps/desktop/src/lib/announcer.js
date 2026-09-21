// announcer.js - tells screen readers about things that change without moving focus: a page
// finished loading, a scan progressed, a setting saved, a language changed.
//
// Two hidden live regions are made on first use: a polite one (waits for the reader to finish
// speaking; use for progress and confirmations) and an assertive one (interrupts; only for
// errors that need attention now). Setting the same text twice in a row is not announced by
// screen readers, so the region is emptied first and filled a moment later.
//
// The document and timers are injected so node --test can drive it with plain stubs
// (test/a11y-helpers.test.js).

export const ANNOUNCER_CLASS = 'sr-only'
const FILL_DELAY_MS = 60
const CLEAR_AFTER_MS = 8000

export function createAnnouncer({ document: doc, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const regions = {}
  const timers = { polite: null, assertive: null, clear: {} }

  const region = (kind) => {
    if (regions[kind] && regions[kind].isConnected !== false) return regions[kind]
    if (!doc || !doc.body || typeof doc.createElement !== 'function') return null
    const el = doc.createElement('div')
    el.className = ANNOUNCER_CLASS
    el.setAttribute('role', kind === 'assertive' ? 'alert' : 'status')
    el.setAttribute('aria-live', kind)
    el.setAttribute('aria-atomic', 'true')
    el.setAttribute('data-announcer', kind)
    doc.body.appendChild(el)
    regions[kind] = el
    return el
  }

  function announce(message, { assertive = false } = {}) {
    const text = typeof message === 'string' ? message.trim() : ''
    if (!text) return false
    const kind = assertive ? 'assertive' : 'polite'
    const el = region(kind)
    if (!el) return false
    clearTimer(timers[kind])
    clearTimer(timers.clear[kind])
    el.textContent = ''
    timers[kind] = setTimer(() => {
      el.textContent = text
      // Left in place a while for slow readers, then removed so it is not re-read on a virtual cursor pass.
      timers.clear[kind] = setTimer(() => { el.textContent = '' }, CLEAR_AFTER_MS)
    }, FILL_DELAY_MS)
    return true
  }

  return { announce }
}

let shared = null
/** Announce through the app's one shared pair of live regions. Safe to call anywhere. */
export function announce(message, options) {
  if (typeof document === 'undefined') return false
  if (!shared) shared = createAnnouncer({ document })
  return shared.announce(message, options)
}
