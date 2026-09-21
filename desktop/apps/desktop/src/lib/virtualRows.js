// virtualRows.js — windowing math for the Table view: which rows of a long, fixed-height
// list are on screen. Pure, so node --test checks it (test/library-table.test.js).
//
// Rows are y = index * rowHeight from the top of the list body. `scrollTop` is how far the
// list body has been scrolled and `viewportHeight` is the height of the strip of it that
// shows rows (a sticky header, if any, is not part of it).

const int = (v, fallback = 0) => (Number.isFinite(v) ? Math.floor(v) : fallback)

/**
 * The rows to render: [start, end) plus the pixel offset of `start`.
 * `overscan` extra rows on each side keep a fast scroll from flashing blank.
 */
export function computeWindow({ count, rowHeight, scrollTop, viewportHeight, overscan = 6 }) {
  const n = Math.max(0, int(count))
  if (n === 0 || !(rowHeight > 0)) return { start: 0, end: 0, offset: 0, firstVisible: 0, lastVisible: -1 }
  const maxTop = Math.max(0, n * rowHeight - Math.max(0, viewportHeight))
  const top = Math.min(Math.max(0, Number.isFinite(scrollTop) ? scrollTop : 0), maxTop)
  const first = Math.min(n - 1, Math.floor(top / rowHeight))
  const last = Math.min(n - 1, Math.max(first, Math.ceil((top + Math.max(0, viewportHeight)) / rowHeight) - 1))
  const pad = Math.max(0, int(overscan))
  const start = Math.max(0, first - pad)
  const end = Math.min(n, last + 1 + pad)
  return { start, end, offset: start * rowHeight, firstVisible: first, lastVisible: last }
}

/** The scrollTop that brings row `index` fully into view with the least movement. */
export function scrollTopToReveal({ index, rowHeight, scrollTop, viewportHeight }) {
  const top = index * rowHeight
  const bottom = top + rowHeight
  if (top < scrollTop) return top
  if (bottom > scrollTop + viewportHeight) return Math.max(0, bottom - viewportHeight)
  return scrollTop
}

/** The scrollTop that puts row `index` at the top of the strip, clamped so the list never over-scrolls. */
export function scrollTopForIndex({ index, count, rowHeight, viewportHeight }) {
  const maxTop = Math.max(0, count * rowHeight - viewportHeight)
  return Math.min(maxTop, Math.max(0, index * rowHeight))
}

/** Clamp a keyboard move: current index + delta, kept inside the list. A first move from "none" lands on row 0. */
export function moveIndex(current, delta, count) {
  if (count <= 0) return -1
  if (current < 0) return delta < 0 ? count - 1 : 0
  return Math.min(count - 1, Math.max(0, current + delta))
}
