// libraryGrouping.js - the Grouped view: which ways rows can be grouped (year, decade, genre,
// collection, studio, resolution, first letter), how they are ordered, and how a set of groups is
// laid out as a flat list of lines (a header line, then rows of cards) so a long library can be
// windowed instead of drawn all at once. Pure, so node --test checks it (test/library-views.test.js).

import { resolutionBucket, rowResolution } from './libraryFilters.js'

export const GROUP_BYS = [
  { id: 'year', label: 'Year', kinds: ['movies', 'tv'] },
  { id: 'decade', label: 'Decade', kinds: ['movies', 'tv'] },
  { id: 'genre', label: 'Genre', kinds: ['movies', 'tv'] },
  { id: 'collection', label: 'Collection', kinds: ['movies'] },
  { id: 'studio', label: 'Studio', kinds: ['movies'] },
  { id: 'resolution', label: 'Resolution', kinds: ['movies', 'tv'] },
  { id: 'letter', label: 'First letter', kinds: ['movies', 'tv'] }
]

export const DEFAULT_GROUP_BY = 'year'

export function groupOptionsFor(kind) {
  return GROUP_BYS.filter((g) => g.kinds.includes(kind === 'tv' ? 'tv' : 'movies'))
}

/** A saved group-by that this screen does not offer (or garbage) becomes the default. */
export function normalizeGroupBy(raw, kind = 'movies') {
  return groupOptionsFor(kind).some((g) => g.id === raw) ? raw : DEFAULT_GROUP_BY
}

const UNKNOWN_LAST = 1e9
const RES_ORDER = { '4K': 0, '1080p': 1, '720p': 2, SD: 3 }

/**
 * The groups one row belongs to: [{ key, label, order }]. `order` sorts groups (lower first, ties by
 * label); rows with no value all share one "unknown" group that always sorts last. A row can be in
 * several groups (each of its genres).
 */
export function groupKeysOf(row, by, ctx = {}) {
  switch (by) {
    case 'year':
      return row.year ? [{ key: `y${row.year}`, label: String(row.year), order: -row.year }] : [{ key: 'unknown', label: 'Unknown year', order: UNKNOWN_LAST }]
    case 'decade': {
      if (!row.year) return [{ key: 'unknown', label: 'Unknown year', order: UNKNOWN_LAST }]
      const d = Math.floor(row.year / 10) * 10
      return [{ key: `d${d}`, label: `${d}s`, order: -d }]
    }
    case 'genre': {
      const list = (row.genres || []).filter(Boolean)
      return list.length ? list.map((g) => ({ key: `g:${g}`, label: g, order: 0 })) : [{ key: 'unknown', label: 'No genre', order: UNKNOWN_LAST }]
    }
    case 'collection':
      return row.collection ? [{ key: `c:${row.collection}`, label: row.collection, order: 0 }] : [{ key: 'unknown', label: 'Not in a collection', order: UNKNOWN_LAST }]
    case 'studio':
      return row.studio ? [{ key: `s:${row.studio}`, label: row.studio, order: 0 }] : [{ key: 'unknown', label: 'Unknown studio', order: UNKNOWN_LAST }]
    case 'resolution': {
      const info = ctx.infoOf ? ctx.infoOf(row) : undefined
      const bucket = resolutionBucket(rowResolution(row, info))
      return bucket ? [{ key: `r:${bucket}`, label: bucket, order: RES_ORDER[bucket] }] : [{ key: 'unknown', label: 'Unknown resolution', order: UNKNOWN_LAST }]
    }
    case 'letter': {
      const ch = String(row.letter || String(row.title || '').charAt(0)).toUpperCase()
      const l = /^[A-Z]$/.test(ch) ? ch : '#'
      return [{ key: `l:${l}`, label: l, order: l === '#' ? -1 : l.charCodeAt(0) }]
    }
    default:
      return [{ key: 'all', label: 'All', order: 0 }]
  }
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/**
 * Rows split into groups: [{ key, label, rows }], groups in their natural order, rows in the order
 * they came in (sort them first). Empty input gives no groups.
 */
export function groupRows(rows, by, ctx = {}) {
  const groups = new Map()
  for (const row of rows) {
    for (const g of groupKeysOf(row, by, ctx)) {
      let entry = groups.get(g.key)
      if (!entry) groups.set(g.key, (entry = { key: g.key, label: g.label, order: g.order, rows: [] }))
      entry.rows.push(row)
    }
  }
  return [...groups.values()]
    .sort((a, b) => a.order - b.order || collator.compare(a.label, b.label))
    .map(({ key, label, rows: list }) => ({ key, label, rows: list }))
}

// ------------------------------------------------------------------ layout (for windowing)

/**
 * Lay groups out as lines of cards. Every line has a fixed height, so which lines are on screen is
 * arithmetic. Returns { lines, total, items, columns }:
 *   lines  [{ type: 'header', top, height, group, label, count, index }
 *          | { type: 'cells', top, height, first, count, group }]   `first` = flat index of the line's first card
 *   items  every row in on-screen order (a row in two groups appears twice, once per group)
 *   total  total height in px
 * `headers: false` draws a single group with no header (the Backdrops grid).
 */
export function layoutCardLines(groups, { columns, headerH = 40, rowH, gap = 0, headers = true, pad = 0 }) {
  const cols = Math.max(1, Math.floor(columns) || 1)
  const lines = []
  const items = []
  let top = pad
  groups.forEach((g, gi) => {
    if (headers) {
      lines.push({ type: 'header', top, height: headerH, group: gi, label: g.label, count: g.rows.length, key: g.key })
      top += headerH
    }
    for (let i = 0; i < g.rows.length; i += cols) {
      const count = Math.min(cols, g.rows.length - i)
      lines.push({ type: 'cells', top, height: rowH + gap, first: items.length, count, group: gi })
      for (let c = 0; c < count; c++) items.push(g.rows[i + c])
      top += rowH + gap
    }
  })
  return { lines, total: top + pad, items, columns: cols }
}

/** How many equal-width columns of at least `min` px fit in `width`, with `gap` between and `pad` on each side. */
export function columnsFor(width, min, gap = 0, pad = 0) {
  const usable = Number(width) - pad * 2
  if (!(usable > 0) || !(min > 0)) return 1
  return Math.max(1, Math.floor((usable + gap) / (min + gap)))
}

/** The card width when `columns` share `width`. */
export function cardWidthFor(width, columns, gap = 0, pad = 0) {
  const cols = Math.max(1, columns)
  return Math.max(1, (Number(width) - pad * 2 - gap * (cols - 1)) / cols)
}

/** Index of the last line whose top is at or above `y` (binary search); -1 when there are no lines. */
export function lineAt(lines, y) {
  if (lines.length === 0) return -1
  let lo = 0
  let hi = lines.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (lines[mid].top <= y) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** The lines to draw: [start, end) covering the viewport plus `overscanPx` above and below. */
export function linesWindow(lines, scrollTop, viewportHeight, overscanPx = 400) {
  if (lines.length === 0) return { start: 0, end: 0 }
  const y0 = Math.max(0, scrollTop - overscanPx)
  const y1 = scrollTop + Math.max(0, viewportHeight) + overscanPx
  const start = Math.max(0, lineAt(lines, y0))
  let end = start
  while (end < lines.length && lines[end].top < y1) end++
  return { start, end }
}

/**
 * The header that should stay pinned at the top when the list is scrolled to `scrollTop`: the last
 * header at or above it. Returns the index into `lines`, or -1 when none (before the first header).
 */
export function stickyHeaderAt(lines, scrollTop) {
  const i = lineAt(lines, scrollTop)
  for (let n = i; n >= 0; n--) if (lines[n].type === 'header') return n
  return -1
}

/** Flat item index -> { line, col } within `lines`. */
export function positionOfItem(lines, index) {
  let lo = 0
  let hi = lines.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const ln = lines[mid]
    if (ln.type === 'header') {
      // a header sits between cell lines; step toward the cell line by looking at the next one
      const next = lines[mid + 1]
      if (next && next.type === 'cells' && next.first <= index) lo = mid + 1
      else hi = mid - 1
      continue
    }
    if (index < ln.first) hi = mid - 1
    else if (index >= ln.first + ln.count) lo = mid + 1
    else { found = mid; break }
  }
  return found < 0 ? null : { line: found, col: index - lines[found].first }
}

/**
 * Keyboard move through grouped lines. `index` is the flat item index (-1 = none yet).
 * Left/Right step one card (across group boundaries), Up/Down keep the column in the neighbouring
 * card line (clamped to a shorter last line), PageUp/PageDown move `page` card lines, Home/End
 * jump to the ends. Returns the new index, or `index` when the key does nothing.
 */
export function navigateLines(lines, itemCount, index, key, page = 3) {
  if (itemCount <= 0) return -1
  if (index < 0 || index >= itemCount) return key === 'End' || key === 'ArrowUp' || key === 'ArrowLeft' ? itemCount - 1 : 0
  switch (key) {
    case 'ArrowRight': return Math.min(itemCount - 1, index + 1)
    case 'ArrowLeft': return Math.max(0, index - 1)
    case 'Home': return 0
    case 'End': return itemCount - 1
    case 'ArrowDown':
    case 'ArrowUp':
    case 'PageDown':
    case 'PageUp': {
      const pos = positionOfItem(lines, index)
      if (!pos) return index
      const dir = key === 'ArrowDown' || key === 'PageDown' ? 1 : -1
      let steps = key === 'PageDown' || key === 'PageUp' ? Math.max(1, page) : 1
      let li = pos.line
      let target = -1
      while (steps > 0) {
        let next = li + dir
        while (next >= 0 && next < lines.length && lines[next].type !== 'cells') next += dir
        if (next < 0 || next >= lines.length) break
        li = next
        target = li
        steps--
      }
      if (target < 0) return index
      const ln = lines[target]
      return ln.first + Math.min(pos.col, ln.count - 1)
    }
    default: return index
  }
}

/**
 * The scrollTop that brings card line `line` fully into view under a pinned header of `stickyH` px
 * (the header covers the top of the viewport). Least movement; unchanged when already visible.
 */
export function scrollTopToRevealLine(lines, line, scrollTop, viewportHeight, stickyH = 0) {
  const ln = lines[line]
  if (!ln) return scrollTop
  if (ln.top - stickyH < scrollTop) return Math.max(0, ln.top - stickyH)
  if (ln.top + ln.height > scrollTop + viewportHeight) return Math.max(0, ln.top + ln.height - viewportHeight)
  return scrollTop
}
