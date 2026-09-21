// posterViewDom.js - wires the poster display choices (size, icons, titles) to the page.
// Everything is a CSS variable or an attribute on <html> (see styles.css), so one change
// restyles every poster grid at once with no React re-render of the libraries: --poster-size
// drives the grid's column width, data-poster-density / -icons / -titles drive what a card
// shows. The pure rules live in posterZoom.js; this file only touches the DOM.
import { useSyncExternalStore } from 'react'
import {
  createPosterZoom,
  densityFor,
  anchoredScrollTop,
  isPosterZoomWheel,
  posterZoomKeyAction
} from './posterZoom.js'
import { getUiPrefs } from './uiPrefs.js'

const rootElement = () => (typeof document !== 'undefined' ? document.documentElement : null)

// The card just under the sticky toolbar is the one to keep still while sizes change: a size
// or caption change reflows every row above it, and without this the view jumps to somewhere
// else in a long library. elementFromPoint is one hit-test, not a walk over every card.
function findAnchor(main) {
  const rect = main.getBoundingClientRect()
  const bars = main.querySelectorAll('.sticky-bar')
  let top = rect.top
  for (const bar of bars) if (bar.offsetParent !== null) top = Math.max(top, bar.getBoundingClientRect().bottom)
  const xs = [rect.left + 40, rect.left + rect.width * 0.5, rect.right - 60]
  for (const dy of [8, 32, 64]) {
    for (const x of xs) {
      const hit = document.elementFromPoint(x, top + dy)
      const card = hit && hit.closest ? hit.closest('.grid .card') : null
      if (card && main.contains(card)) return card
    }
  }
  return null
}

function withScrollAnchor(change) {
  const main = typeof document !== 'undefined' ? document.querySelector('.main') : null
  const anchor = main && main.scrollTop > 2 ? findAnchor(main) : null
  const before = anchor ? anchor.getBoundingClientRect().top : null
  change()
  if (!anchor || !anchor.isConnected) return
  const next = anchoredScrollTop(main.scrollTop, before, anchor.getBoundingClientRect().top)
  if (next !== main.scrollTop) main.scrollTop = next
}

function paintSize(size) {
  const root = rootElement()
  if (!root) return
  root.style.setProperty('--poster-size', `${size}px`)
  root.dataset.posterDensity = densityFor(size)
}

let zoom = null
export function getPosterZoom() {
  if (!zoom) {
    const prefs = getUiPrefs()
    zoom = createPosterZoom({
      initial: prefs.cached().posterSize,
      apply: (size) => withScrollAnchor(() => paintSize(size)),
      save: (size) => { prefs.save({ posterSize: size }) },
      raf: (fn) => requestAnimationFrame(fn),
      caf: (id) => cancelAnimationFrame(id)
    })
    paintSize(zoom.getSize())
  }
  return zoom
}

let viewOptions = null
const viewListeners = new Set()
function paintViewOptions(options) {
  const root = rootElement()
  if (!root) return
  root.dataset.posterIcons = options.showIcons ? 'on' : 'off'
  root.dataset.posterTitles = options.showTitles ? 'on' : 'off'
}
export function getViewOptions() {
  if (!viewOptions) {
    const cached = getUiPrefs().cached()
    viewOptions = { showIcons: cached.showPosterIcons, showTitles: cached.showPosterTitles }
    paintViewOptions(viewOptions)
  }
  return viewOptions
}
export function setViewOptions(partial) {
  const next = { ...getViewOptions(), ...partial }
  if (next.showIcons === viewOptions.showIcons && next.showTitles === viewOptions.showTitles) return
  viewOptions = next
  withScrollAnchor(() => paintViewOptions(next))
  getUiPrefs().save({ showPosterIcons: next.showIcons, showPosterTitles: next.showTitles })
  for (const listener of [...viewListeners]) listener()
}
function subscribeViewOptions(listener) {
  viewListeners.add(listener)
  return () => viewListeners.delete(listener)
}

// Cards read these to add a keyboard/tooltip fallback when their visible text is hidden.
export function useViewOptions() {
  return useSyncExternalStore(subscribeViewOptions, getViewOptions, getViewOptions)
}
export function usePosterSize() {
  const z = getPosterZoom()
  return useSyncExternalStore(z.subscribe, z.getSize, z.getSize)
}

const visibleGrid = () => Array.from(document.querySelectorAll('.main .grid')).some((grid) => grid.offsetParent !== null)

let inputInstalled = false
function installInput() {
  if (inputInstalled || typeof window === 'undefined') return
  inputInstalled = true
  // Not passive, and only cancelled when the gesture is ours: a plain wheel keeps scrolling,
  // and Ctrl+wheel anywhere else (or a pinch outside the posters) is left to the browser.
  window.addEventListener('wheel', (event) => {
    if (!isPosterZoomWheel(event)) return
    const target = event.target
    if (!(target instanceof Element) || !target.closest('.main .grid')) return
    event.preventDefault()
    getPosterZoom().wheel(event.deltaY, event.deltaMode)
  }, { passive: false, capture: true })
  window.addEventListener('keydown', (event) => {
    const action = posterZoomKeyAction(event)
    if (!action || !visibleGrid()) return
    event.preventDefault()
    const z = getPosterZoom()
    if (action === 'reset') z.reset()
    else if (action === 'bigger') z.bigger()
    else z.smaller()
  })
}

// First paint from the synchronous cache, then the stored values once the main process answers.
export function bootPosterView() {
  getPosterZoom()
  getViewOptions()
  installInput()
}

let hydrated = false
export function hydratePosterView() {
  if (hydrated) return
  hydrated = true
  getUiPrefs().load().then((prefs) => {
    getPosterZoom().hydrate(prefs.posterSize)
    const current = getViewOptions()
    if (current.showIcons !== prefs.showPosterIcons || current.showTitles !== prefs.showPosterTitles) {
      viewOptions = { showIcons: prefs.showPosterIcons, showTitles: prefs.showPosterTitles }
      paintViewOptions(viewOptions)
      for (const listener of [...viewListeners]) listener()
    }
  })
}
