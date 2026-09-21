// libraryViews.js - the ways the Movies / TV Shows screens can show the library, and the "views" a
// person saves: a named bundle of (how it is shown, how it is grouped and sorted, which filters).
// This is the per-person state that survives a restart (electron/uiPrefs.js stores it, per user),
// and the shape a shared preset carries. Pure, so node --test checks it (test/library-views.test.js).
//
// Everything that arrives from outside (the store, a pasted preset) goes through normalize*() first,
// so nothing downstream ever has to defend against a wrong type.

import { filtersEqual, normalizeFilters } from './libraryFilters.js'
import { DEFAULT_GROUP_BY, normalizeGroupBy } from './libraryGrouping.js'

export const KINDS = ['movies', 'tv']

export const VIEW_MODES = [
  { id: 'posters', label: 'Posters', hint: 'Poster grid, A-Z' },
  { id: 'table', label: 'Table', hint: 'One line per title, choose the columns' },
  { id: 'detailed', label: 'Detailed list', hint: 'Poster, plot and technical badges' },
  { id: 'shelves', label: 'Shelves', hint: 'Rows like Continue watching and Top rated' },
  { id: 'backdrops', label: 'Backdrops', hint: 'Wide fan-art cards' },
  { id: 'grouped', label: 'Grouped', hint: 'Sections by year, genre, studio and more' },
  { id: 'folders', label: 'Folders', hint: 'Browse the real folders' }
]
export const DEFAULT_MODE = 'posters'
const MODE_IDS = VIEW_MODES.map((m) => m.id)

export const normalizeMode = (raw) => (MODE_IDS.includes(raw) ? raw : DEFAULT_MODE)

/** The mode after `dir` (+1 / -1) steps around the switcher, wrapping. */
export function stepMode(current, dir) {
  const i = Math.max(0, MODE_IDS.indexOf(normalizeMode(current)))
  return MODE_IDS[(i + (dir < 0 ? -1 : 1) + MODE_IDS.length) % MODE_IDS.length]
}

// Which modes ignore the shared sort and grouping controls (they have their own order).
export const MODES_WITH_SORT = ['detailed', 'backdrops', 'grouped']

// ------------------------------------------------------------------ sorting for the non-table views

export const SORTS = [
  { id: 'title', label: 'Title', defaultDir: 'asc' },
  { id: 'year', label: 'Release year', defaultDir: 'desc' },
  { id: 'rating', label: 'Rating', defaultDir: 'desc' },
  { id: 'added', label: 'Recently added', defaultDir: 'desc' },
  { id: 'size', label: 'File size', defaultDir: 'desc' }
]
export const DEFAULT_SORT = { id: 'title', dir: 'asc' }

export function normalizeSort(raw) {
  const s = raw && typeof raw === 'object' ? raw : {}
  const def = SORTS.find((x) => x.id === s.id)
  if (!def) return { ...DEFAULT_SORT }
  return { id: def.id, dir: s.dir === 'asc' || s.dir === 'desc' ? s.dir : def.defaultDir }
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** A new array of `rows` in the chosen order. Rows with no value sit last either way; ties fall back to title. */
export function sortForView(rows, sort) {
  const s = normalizeSort(sort)
  const sign = s.dir === 'desc' ? -1 : 1
  const key = {
    title: (r) => r.title,
    year: (r) => (r.year ? r.year : null),
    rating: (r) => (r.rating > 0 ? r.rating : null),
    added: (r) => (r.mtimeMs > 0 ? r.mtimeMs : null),
    size: (r) => (r.sizeBytes >= 0 && r.sizeBytes !== null ? r.sizeBytes : null)
  }[s.id]
  const keys = rows.map(key)
  const order = rows.map((_, i) => i)
  order.sort((a, b) => {
    const ka = keys[a]
    const kb = keys[b]
    if ((ka === null) !== (kb === null)) return ka === null ? 1 : -1
    if (ka !== null && ka !== kb) {
      const c = s.id === 'title' ? collator.compare(ka, kb) : ka - kb
      if (c !== 0) return c * sign
    }
    return collator.compare(rows[a].title, rows[b].title) || (rows[a].id < rows[b].id ? -1 : rows[a].id > rows[b].id ? 1 : 0)
  })
  return order.map((i) => rows[i])
}

// ------------------------------------------------------------------ per-person state

export const MAX_SAVED_VIEWS = 40
export const MAX_NAME = 60

const cleanName = (raw) => (typeof raw === 'string' ? raw.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME) : '')

const cleanId = (raw) => (typeof raw === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(raw) ? raw : '')

/** One saved view, cleaned, or null when it has no name or no id. */
export function normalizeSavedView(raw, kind = 'movies') {
  const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null
  if (!s) return null
  const id = cleanId(s.id)
  const name = cleanName(s.name)
  if (!id || !name) return null
  return {
    id,
    name,
    mode: normalizeMode(s.mode),
    groupBy: normalizeGroupBy(s.groupBy, kind),
    sort: normalizeSort(s.sort),
    filters: normalizeFilters(s.filters)
  }
}

const blankKind = (kind) => ({
  mode: DEFAULT_MODE,
  groupBy: DEFAULT_GROUP_BY,
  sort: { ...DEFAULT_SORT },
  filters: normalizeFilters(null),
  active: null, // id of the saved view these settings came from, while they still match it
  saved: []
})

/** The complete state for one person: one block per screen (movies, tv). */
export function emptyUserViews() {
  return { movies: blankKind('movies'), tv: blankKind('tv') }
}

/** Any input -> a complete, safe per-person state. */
export function normalizeUserViews(raw) {
  const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const out = {}
  for (const kind of KINDS) {
    const b = s[kind] && typeof s[kind] === 'object' && !Array.isArray(s[kind]) ? s[kind] : {}
    const seen = new Set()
    const saved = []
    for (const v of Array.isArray(b.saved) ? b.saved : []) {
      const n = normalizeSavedView(v, kind)
      if (!n || seen.has(n.id)) continue
      seen.add(n.id)
      saved.push(n)
      if (saved.length >= MAX_SAVED_VIEWS) break
    }
    out[kind] = {
      mode: normalizeMode(b.mode),
      groupBy: normalizeGroupBy(b.groupBy, kind),
      sort: normalizeSort(b.sort),
      filters: normalizeFilters(b.filters),
      active: saved.some((v) => v.id === b.active) ? b.active : null,
      saved
    }
  }
  return out
}

/** What a saved view stores, taken from a screen's current settings. */
export function snapshotView(block, kind) {
  return {
    mode: normalizeMode(block.mode),
    groupBy: normalizeGroupBy(block.groupBy, kind),
    sort: normalizeSort(block.sort),
    filters: normalizeFilters(block.filters)
  }
}

const sameSnapshot = (a, b) =>
  a.mode === b.mode && a.groupBy === b.groupBy && a.sort.id === b.sort.id && a.sort.dir === b.sort.dir && filtersEqual(a.filters, b.filters)

/** True when a saved view is active and the screen's settings have since been changed from it. */
export function isViewModified(block, kind) {
  const v = block.saved.find((x) => x.id === block.active)
  if (!v) return false
  return !sameSnapshot(snapshotView(block, kind), snapshotView(v, kind))
}

const newId = (existing, seed) => {
  const base = (Number.isFinite(seed) ? Math.floor(seed) : Date.now()).toString(36)
  let id = `v${base}`
  let n = 1
  while (existing.some((v) => v.id === id)) id = `v${base}${(n++).toString(36)}`
  return id
}

/**
 * Save the current settings as a new named view (or, with the same name, update that one) and make it
 * the active one. Returns the new per-person state; the same state when the name is empty or the list
 * is full.
 */
export function saveCurrentAsView(state, kind, name, now = Date.now()) {
  const label = cleanName(name)
  const block = state[kind]
  if (!label) return state
  const snap = snapshotView(block, kind)
  const existing = block.saved.find((v) => v.name.toLowerCase() === label.toLowerCase())
  let saved
  let id
  if (existing) {
    id = existing.id
    saved = block.saved.map((v) => (v.id === id ? { ...v, name: label, ...snap } : v))
  } else {
    if (block.saved.length >= MAX_SAVED_VIEWS) return state
    id = newId(block.saved, now)
    saved = [...block.saved, { id, name: label, ...snap }]
  }
  return { ...state, [kind]: { ...block, saved, active: id } }
}

/** Update the active saved view to the current settings. */
export function updateActiveView(state, kind) {
  const block = state[kind]
  if (!block.active) return state
  const snap = snapshotView(block, kind)
  return { ...state, [kind]: { ...block, saved: block.saved.map((v) => (v.id === block.active ? { ...v, ...snap } : v)) } }
}

/** Make a saved view the current settings. */
export function applySavedView(state, kind, id) {
  const block = state[kind]
  const v = block.saved.find((x) => x.id === id)
  if (!v) return state
  return { ...state, [kind]: { ...block, mode: v.mode, groupBy: normalizeGroupBy(v.groupBy, kind), sort: v.sort, filters: v.filters, active: v.id } }
}

export function renameSavedView(state, kind, id, name) {
  const label = cleanName(name)
  const block = state[kind]
  if (!label || !block.saved.some((v) => v.id === id)) return state
  if (block.saved.some((v) => v.id !== id && v.name.toLowerCase() === label.toLowerCase())) return state
  return { ...state, [kind]: { ...block, saved: block.saved.map((v) => (v.id === id ? { ...v, name: label } : v)) } }
}

export function deleteSavedView(state, kind, id) {
  const block = state[kind]
  if (!block.saved.some((v) => v.id === id)) return state
  return { ...state, [kind]: { ...block, saved: block.saved.filter((v) => v.id !== id), active: block.active === id ? null : block.active } }
}

/** Change settings on the current screen. A change that leaves the saved view behind keeps it "active" (shown as modified). */
export function patchCurrent(state, kind, patch) {
  const block = state[kind]
  const next = { ...block }
  if ('mode' in patch) next.mode = normalizeMode(patch.mode)
  if ('groupBy' in patch) next.groupBy = normalizeGroupBy(patch.groupBy, kind)
  if ('sort' in patch) next.sort = normalizeSort(patch.sort)
  if ('filters' in patch) next.filters = normalizeFilters(patch.filters)
  return { ...state, [kind]: next }
}

/** Clear the filters and detach from any saved view. */
export function resetFilters(state, kind) {
  return { ...state, [kind]: { ...state[kind], filters: normalizeFilters(null), active: null } }
}

// ------------------------------------------------------------------ shareable presets

export const PRESET_TAG = 'beebo-library-view'
export const PRESET_VERSION = 1
const MAX_PRESET_CHARS = 8000

/**
 * A saved view as text a person can paste to someone else: one line of JSON with a tag and a
 * version. It carries only the view (name, how it is shown, filters) - nothing about the person or
 * the library.
 */
export function serializePreset(view, kind = 'movies') {
  const v = normalizeSavedView({ ...view, id: view && view.id ? view.id : 'x' }, kind)
  if (!v) return ''
  return JSON.stringify({ [PRESET_TAG]: PRESET_VERSION, name: v.name, kind, mode: v.mode, groupBy: v.groupBy, sort: v.sort, filters: v.filters })
}

/**
 * Pasted text -> { ok: true, view: { name, mode, groupBy, sort, filters }, kind } or
 * { ok: false, error }. Tolerant of surrounding whitespace; strict about the tag, version and size, and
 * every value is cleaned, so a preset cannot carry anything the screen would not accept itself.
 */
export function parsePreset(text, kind = 'movies') {
  const raw = String(text == null ? '' : text).trim()
  if (!raw) return { ok: false, error: 'Nothing to import.' }
  if (raw.length > MAX_PRESET_CHARS) return { ok: false, error: 'That is too long to be a saved view.' }
  let data
  try { data = JSON.parse(raw) } catch { return { ok: false, error: 'That does not look like a shared view.' } }
  if (!data || typeof data !== 'object' || Array.isArray(data) || !(PRESET_TAG in data)) return { ok: false, error: 'That does not look like a shared view.' }
  if (Number(data[PRESET_TAG]) !== PRESET_VERSION) return { ok: false, error: 'That view was made by a different version of the app.' }
  const name = cleanName(data.name)
  if (!name) return { ok: false, error: 'The shared view has no name.' }
  const presetKind = KINDS.includes(data.kind) ? data.kind : kind
  return {
    ok: true,
    kind: presetKind,
    view: {
      name,
      mode: normalizeMode(data.mode),
      groupBy: normalizeGroupBy(data.groupBy, kind),
      sort: normalizeSort(data.sort),
      filters: normalizeFilters(data.filters)
    }
  }
}

/** Add a parsed preset to a screen as a new saved view (a name already in use is updated in place). */
export function importPreset(state, kind, view, now = Date.now()) {
  return saveCurrentAsView(patchCurrent(state, kind, view), kind, view.name, now)
}
