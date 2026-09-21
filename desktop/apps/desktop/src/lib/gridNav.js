// gridNav.js - keyboard navigation for the poster grids and the small toolbars around them.
//
//   Poster grids  One card is in the Tab order at a time (a "roving tabindex"), so a library of
//                 a thousand posters is one Tab stop, not a thousand. Arrow keys move between
//                 cards by where they are on screen (so it works across the A-Z sections and at
//                 any poster size), Home/End go to the ends of a row, Ctrl+Home/End to the
//                 first and last card, PageUp/PageDown a screenful of rows.
//   Toolbars      A container marked data-rove ("view tabs", genre chips, the A-Z bar) whose
//                 buttons carry data-rove-item works the same way in one dimension:
//                 Left/Right (and Up/Down), Home, End.
//
// pickNeighbor() is pure (test/a11y-helpers.test.js). installGridNav() is the small DOM layer,
// delegated from the document, so the screens do not each need to wire keyboards themselves: a
// card is any .poster-card (see posterCardProps in components/LibraryControls.jsx).

/** rect: { left, top, width, height }. Same row when the tops are within half a card height. */
const sameRow = (a, b) => Math.abs(a.top - b.top) < Math.max(4, Math.min(a.height, b.height) / 2)
const centerX = (r) => r.left + r.width / 2

function verticalStep(rects, from, direction) {
  const here = rects[from]
  let rowTop = null
  for (let i = 0; i < rects.length; i += 1) {
    const r = rects[i]
    if (sameRow(here, r)) continue
    const beyond = direction > 0 ? r.top > here.top : r.top < here.top
    if (!beyond) continue
    if (rowTop === null || (direction > 0 ? r.top < rowTop.top : r.top > rowTop.top)) rowTop = r
  }
  if (!rowTop) return -1
  let best = -1
  let bestGap = Infinity
  for (let i = 0; i < rects.length; i += 1) {
    if (!sameRow(rowTop, rects[i])) continue
    const gap = Math.abs(centerX(rects[i]) - centerX(here))
    if (gap < bestGap) { best = i; bestGap = gap }
  }
  return best
}

/**
 * Where a key moves the focus. `rects` are the cards in reading order; `from` the focused one.
 * Returns the index to focus, or -1 to stay (the edge of the grid, or a key that is not ours).
 */
export function pickNeighbor(rects, from, key, { ctrl = false, pageRows = 3 } = {}) {
  const count = Array.isArray(rects) ? rects.length : 0
  if (!count || from < 0 || from >= count) return -1
  switch (key) {
    case 'ArrowRight': return from + 1 < count ? from + 1 : -1
    case 'ArrowLeft': return from > 0 ? from - 1 : -1
    case 'ArrowDown': return verticalStep(rects, from, 1)
    case 'ArrowUp': return verticalStep(rects, from, -1)
    case 'Home':
    case 'End': {
      if (ctrl) return key === 'Home' ? 0 : count - 1
      let edge = from
      for (let i = 0; i < count; i += 1) {
        if (!sameRow(rects[from], rects[i])) continue
        if (key === 'Home' ? i < edge : i > edge) edge = i
      }
      return edge === from ? -1 : edge
    }
    case 'PageDown':
    case 'PageUp': {
      const dir = key === 'PageDown' ? 1 : -1
      let at = from
      for (let step = 0; step < Math.max(1, pageRows); step += 1) {
        const next = verticalStep(rects, at, dir)
        if (next < 0) break
        at = next
      }
      return at === from ? -1 : at
    }
    default: return -1
  }
}

/** Index a one-dimensional group moves to. Wraps around, as toolbars do. */
export function pickLinear(count, from, key) {
  if (!count || from < 0) return -1
  switch (key) {
    case 'ArrowRight': case 'ArrowDown': return (from + 1) % count
    case 'ArrowLeft': case 'ArrowUp': return (from - 1 + count) % count
    case 'Home': return 0
    case 'End': return count - 1
    default: return -1
  }
}

/** The one item that stays in the Tab order: the remembered one if still usable, else the current
 *  choice (aria-pressed / aria-current / active), else the first. `items` are { usable, current }. */
export function chooseRover(items, remembered) {
  if (Array.isArray(items) && remembered >= 0 && remembered < items.length && items[remembered] && items[remembered].usable) return remembered
  const current = (items || []).findIndex((it) => it && it.usable && it.current)
  if (current >= 0) return current
  return (items || []).findIndex((it) => it && it.usable)
}

// ---------------------------------------------------------------- the DOM layer

const CARD = '.poster-card'
const GROUP = '[data-rove]'
const NAV_KEYS = new Set(['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End', 'PageUp', 'PageDown'])
const isShown = (el) => !!el && el.offsetParent !== null

// A tab pane: the direct child of .main that holds the card. Each pane keeps its own Tab stop.
function paneOf(el) {
  let node = el
  while (node && node.parentElement) {
    if (node.parentElement.classList && node.parentElement.classList.contains('main')) return node
    node = node.parentElement
  }
  return el.ownerDocument.body
}

const remembered = new WeakMap()
const setTab = (el, index) => { if (el.getAttribute('tabindex') !== String(index)) el.setAttribute('tabindex', String(index)) }

function normalizeCards(doc) {
  const panes = new Map()
  for (const card of doc.querySelectorAll(CARD)) {
    if (!isShown(card)) continue
    const pane = paneOf(card)
    if (!panes.has(pane)) panes.set(pane, [])
    panes.get(pane).push(card)
  }
  for (const [pane, cards] of panes) {
    const items = cards.map((card) => ({ usable: true, current: false, card }))
    const memo = remembered.get(pane)
    const rover = chooseRover(items, memo && cards.includes(memo) ? cards.indexOf(memo) : -1)
    cards.forEach((card, i) => {
      setTab(card, i === rover ? 0 : -1)
      // The little buttons on a poster follow their card: reachable only from the current one.
      for (const inner of card.querySelectorAll('button, a[href], input, select')) {
        if (i === rover) { if (inner.dataset.roved) { inner.removeAttribute('tabindex'); delete inner.dataset.roved } }
        else if (inner.getAttribute('tabindex') !== '-1') { inner.setAttribute('tabindex', '-1'); inner.dataset.roved = '1' }
      }
    })
    if (rover >= 0) remembered.set(pane, cards[rover])
  }
}

// Only elements marked data-rove-item take part; other buttons in the same container (menus, the
// view options) keep their own keys and stay ordinary Tab stops.
const groupItems = (group) => Array.from(group.querySelectorAll('[data-rove-item]')).filter((el) => el.closest(GROUP) === group)
const usableItem = (el) => !el.disabled && el.getAttribute('aria-disabled') !== 'true' && isShown(el)
const isCurrent = (el) => el.getAttribute('aria-pressed') === 'true' || el.getAttribute('aria-current') === 'true' || el.getAttribute('aria-selected') === 'true' || el.classList.contains('active')

function normalizeGroups(doc) {
  for (const group of doc.querySelectorAll(GROUP)) {
    if (!isShown(group)) continue
    const els = groupItems(group)
    const items = els.map((el) => ({ usable: usableItem(el), current: isCurrent(el) }))
    const memo = remembered.get(group)
    const rover = chooseRover(items, memo ? els.indexOf(memo) : -1)
    els.forEach((el, i) => setTab(el, i === rover ? 0 : -1))
    if (rover >= 0) remembered.set(group, els[rover])
  }
}

// Keeps a card that is being focused inside the visible part of the scroller, below the pinned toolbar.
function keepInView(card) {
  const main = card.closest('.main')
  if (!main) return
  const box = main.getBoundingClientRect()
  let top = box.top
  for (const bar of main.querySelectorAll('.sticky-bar')) if (isShown(bar)) top = Math.max(top, bar.getBoundingClientRect().bottom)
  const r = card.getBoundingClientRect()
  const gap = 12
  if (r.top < top + gap) main.scrollTop += r.top - top - gap
  else if (r.bottom > box.bottom - gap) main.scrollTop += r.bottom - box.bottom + gap
}

function onCardKey(event, doc) {
  const card = event.target instanceof Element && event.target.matches(CARD) ? event.target : null
  if (!card || event.altKey || event.metaKey || !NAV_KEYS.has(event.key)) return false
  const pane = paneOf(card)
  const cards = Array.from(pane.querySelectorAll(CARD)).filter(isShown)
  const from = cards.indexOf(card)
  if (from < 0) return false
  const rects = cards.map((c) => { const r = c.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height } })
  const main = card.closest('.main')
  const pageRows = Math.max(1, Math.floor((main ? main.clientHeight : 600) / Math.max(1, rects[from].height + 20)) - 1)
  const to = pickNeighbor(rects, from, event.key, { ctrl: event.ctrlKey, pageRows })
  event.preventDefault()
  if (to < 0) return true
  remembered.set(pane, cards[to])
  normalizeCards(doc)
  cards[to].focus({ preventScroll: true })
  keepInView(cards[to])
  return true
}

function onGroupKey(event) {
  const target = event.target
  if (!(target instanceof Element) || event.altKey || event.ctrlKey || event.metaKey) return false
  const group = target.closest(GROUP)
  if (!group || !NAV_KEYS.has(event.key) || event.key === 'PageUp' || event.key === 'PageDown') return false
  // Text fields keep their own arrow keys.
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return false
  const els = groupItems(group).filter(usableItem)
  const from = els.indexOf(target)
  if (from < 0) return false // not one of the group's items: a menu or field inside it keeps its own keys
  const orientation = group.getAttribute('data-rove')
  if (orientation === 'horizontal' && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) return false
  const to = pickLinear(els.length, from, event.key)
  event.preventDefault()
  if (to < 0 || to === from) return true
  remembered.set(group, els[to])
  els[to].focus()
  normalizeGroups(group.ownerDocument)
  return true
}

let installed = false
/** Once, at start. Returns a function that undoes it (used by tests and hot reload). */
export function installGridNav(doc = typeof document !== 'undefined' ? document : null, win = typeof window !== 'undefined' ? window : null) {
  if (installed || !doc || !win) return () => {}
  installed = true
  let frame = 0
  const schedule = () => {
    if (frame) return
    frame = win.requestAnimationFrame(() => { frame = 0; try { normalizeCards(doc); normalizeGroups(doc) } catch { /* never break the page over tab order */ } })
  }
  const onKeyDown = (event) => {
    try { if (onCardKey(event, doc) || onGroupKey(event)) event.stopPropagation() } catch { /* leave the key to the browser */ }
  }
  const onFocusIn = (event) => {
    const el = event.target
    if (!(el instanceof Element)) return
    schedule() // a pane that was hidden while its cards mounted is fixed up the first time focus reaches it
    const card = el.closest(CARD)
    if (card) { remembered.set(paneOf(card), card); schedule() }
    const group = el.closest(GROUP)
    if (group && groupItems(group).includes(el)) { remembered.set(group, el); schedule() }
  }
  win.addEventListener('keydown', onKeyDown, true)
  doc.addEventListener('focusin', onFocusIn)
  win.addEventListener('beebo:pane-shown', schedule)
  const observer = new win.MutationObserver(schedule)
  observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'aria-pressed', 'aria-current', 'hidden'] })
  schedule()
  return () => {
    installed = false
    win.removeEventListener('keydown', onKeyDown, true)
    doc.removeEventListener('focusin', onFocusIn)
    win.removeEventListener('beebo:pane-shown', schedule)
    observer.disconnect()
  }
}
