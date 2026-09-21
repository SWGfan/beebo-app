// libraryShelves.js - the Shelves view: Netflix-style horizontal rows (Continue watching, Recently
// added, Top rated, Unwatched 4K, one per genre...). Pure: given rows and what is known about
// them it returns the shelves; drawing them (lazily, one shelf at a time as it scrolls near) is
// LibraryShelves.jsx. Checked by test/library-views.test.js.

import { resolutionBucket, rowProgress, rowResolution } from './libraryFilters.js'

export const SHELF_CAP = 40 // most cards one shelf holds (a shelf is a taste of the library, not a copy of it)
export const GENRE_SHELVES = 8 // how many "by genre" shelves at most
const MIN_GENRE_ROWS = 4
const RECENT_DAYS = 90
const DAY_MS = 86400000

const byRatingThenTitle = (a, b) => (Number(b.rating) || 0) - (Number(a.rating) || 0) || String(a.title).localeCompare(String(b.title), undefined, { sensitivity: 'base' })
const byAddedDesc = (ctx) => (a, b) => (ctx.addedOf(b) || 0) - (ctx.addedOf(a) || 0) || String(a.title).localeCompare(String(b.title), undefined, { sensitivity: 'base' })

/**
 * The shelves for `rows`, in display order, empty ones left out. `ctx`:
 *   marks         null / false / owner's marks (see libraryFilters.evaluateRow). Without them the
 *                 watched-based shelves are left out (or, for "Unwatched 4K", widened to "4K").
 *   progressOf    (row) -> percent 1-99 while part-watched
 *   progressAtOf  (row) -> epoch ms of the latest viewing, to order Continue watching
 *   infoOf        (row) -> file details record
 *   addedOf       (row) -> epoch ms the row was added (default: file date)
 *   now           epoch ms
 * Each shelf: { id, title, rows (at most SHELF_CAP), total }.
 */
export function buildShelves(rows, ctx = {}) {
  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now()
  const marks = ctx.marks || null // null and false both mean "no watched data"
  const c = { ...ctx, addedOf: ctx.addedOf || ((r) => r.mtimeMs || 0) }
  const shelves = []
  const add = (id, title, list) => {
    if (!list.length) return
    shelves.push({ id, title, rows: list.slice(0, SHELF_CAP), total: list.length })
  }
  const watched = (row) => {
    if (!marks) return null
    if (row.kind === 'tv') {
      const keys = row.epKeys || []
      return keys.length > 0 && keys.every((k) => marks.watchedEpisodes.has(k))
    }
    return marks.watchedMovies.has(row.fileName)
  }
  const partWatched = (row) => rowProgress(row, marks, ctx.progressOf) > 0

  // 1. Continue watching: part-watched, most recently watched first.
  if (marks) {
    const at = ctx.progressAtOf || (() => 0)
    add('continue', 'Continue watching', rows.filter(partWatched).sort((a, b) => (at(b) || 0) - (at(a) || 0)))
  }

  // 2. Recently added: the newest files, and only those from the last three months if there are any
  //    (an old library still gets a shelf of its newest).
  const newest = rows.filter((r) => c.addedOf(r) > 0).sort(byAddedDesc(c))
  const recent = newest.filter((r) => now - c.addedOf(r) <= RECENT_DAYS * DAY_MS)
  add('recent', 'Recently added', recent.length ? recent : newest.slice(0, 20))

  // 3. New releases: this year and last.
  const thisYear = new Date(now).getFullYear()
  add('new-releases', 'New releases', rows.filter((r) => r.year && r.year >= thisYear - 1).sort((a, b) => b.year - a.year || byRatingThenTitle(a, b)))

  // 4. Top rated: well rated and (when the vote count is known) by enough people.
  add('top-rated', 'Top rated', rows.filter((r) => Number(r.rating) >= 7.5 && (r.votes === null || r.votes === undefined || r.votes >= 100)).sort(byRatingThenTitle))

  // 5. Unwatched 4K (plain 4K when watched marks are not available).
  const is4k = (r) => resolutionBucket(rowResolution(r, ctx.infoOf ? ctx.infoOf(r) : undefined)) === '4K'
  if (marks) add('unwatched-4k', 'Unwatched 4K', rows.filter((r) => is4k(r) && watched(r) === false).sort(byAddedDesc(c)))
  else add('4k', '4K', rows.filter(is4k).sort(byRatingThenTitle))

  // 6. Not watched yet, best rated first.
  if (marks) add('unwatched', 'Not watched yet', rows.filter((r) => watched(r) === false && !partWatched(r)).sort(byRatingThenTitle))

  // 7. One shelf per common genre.
  const counts = new Map()
  for (const r of rows) for (const g of new Set(r.genres || [])) counts.set(g, (counts.get(g) || 0) + 1)
  const genres = [...counts.entries()].filter(([, n]) => n >= MIN_GENRE_ROWS).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, GENRE_SHELVES)
  for (const [g] of genres) add(`genre:${g}`, g, rows.filter((r) => (r.genres || []).includes(g)).sort(byRatingThenTitle))

  return shelves
}

// ------------------------------------------------------------------ horizontal windowing

/**
 * Which cards of a shelf to draw for a horizontal scroll position: [start, end) with `overscan`
 * extra on each side. `step` is a card's width plus the gap. Same idea as virtualRows.computeWindow
 * but along x.
 */
export function shelfWindow({ count, step, scrollLeft, viewportWidth, overscan = 3 }) {
  const n = Math.max(0, Math.floor(count) || 0)
  if (n === 0 || !(step > 0)) return { start: 0, end: 0 }
  const first = Math.min(n - 1, Math.max(0, Math.floor((Number(scrollLeft) || 0) / step)))
  const last = Math.min(n - 1, Math.max(first, Math.ceil(((Number(scrollLeft) || 0) + Math.max(0, viewportWidth)) / step) - 1))
  return { start: Math.max(0, first - overscan), end: Math.min(n, last + 1 + overscan) }
}

/** scrollLeft that brings card `index` fully into view with the least movement. */
export function scrollLeftToReveal({ index, step, cardWidth, scrollLeft, viewportWidth }) {
  const left = index * step
  const right = left + cardWidth
  if (left < scrollLeft) return Math.max(0, left)
  if (right > scrollLeft + viewportWidth) return Math.max(0, right - viewportWidth)
  return scrollLeft
}

/**
 * Keyboard move over shelves as a grid of unequal rows: `pos` = { shelf, index }.
 * Left/Right move within the shelf, Up/Down change shelf keeping the column (clamped), Home/End
 * go to the shelf's ends. Returns the new pos, or the same object when nothing moves.
 */
export function navigateShelves(shelves, pos, key) {
  if (shelves.length === 0) return null
  if (!pos || !shelves[pos.shelf]) return { shelf: 0, index: 0 }
  const len = (s) => shelves[s].rows.length
  switch (key) {
    case 'ArrowRight': return pos.index + 1 < len(pos.shelf) ? { shelf: pos.shelf, index: pos.index + 1 } : pos
    case 'ArrowLeft': return pos.index > 0 ? { shelf: pos.shelf, index: pos.index - 1 } : pos
    case 'Home': return { shelf: pos.shelf, index: 0 }
    case 'End': return { shelf: pos.shelf, index: len(pos.shelf) - 1 }
    case 'ArrowDown': return pos.shelf + 1 < shelves.length ? { shelf: pos.shelf + 1, index: Math.min(pos.index, len(pos.shelf + 1) - 1) } : pos
    case 'ArrowUp': return pos.shelf > 0 ? { shelf: pos.shelf - 1, index: Math.min(pos.index, len(pos.shelf - 1) - 1) } : pos
    default: return pos
  }
}
