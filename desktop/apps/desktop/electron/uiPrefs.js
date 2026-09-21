'use strict'

// Look-and-feel choices the renderer remembers across restarts (sidebar mode, poster
// size and the two poster display toggles). Deliberately its own channel instead of the
// generic settings:set, whose allow-list guards credentials and account data; nothing
// here is sensitive, and every value is validated so a bad write can never wedge the
// layout. Keep the limits in step with src/lib/posterZoom.js and src/lib/sidebarMode.js.
const STORE_KEY = 'uiPrefs'
const SIDEBAR_MODES = new Set(['pinned', 'hover', 'hidden'])
const POSTER_MIN = 90
const POSTER_MAX = 320
const POSTER_DEFAULT = 160
const BOOLEAN_KEYS = ['showPosterIcons', 'showPosterTitles']

function invalid(message) {
  const error = new Error(message)
  error.code = 'ui_pref_invalid'
  return error
}

function clampSize(value) {
  const size = Number(value)
  return Number.isFinite(size) ? Math.min(POSTER_MAX, Math.max(POSTER_MIN, size)) : POSTER_DEFAULT
}

function clean(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const out = {
    sidebarMode: SIDEBAR_MODES.has(source.sidebarMode) ? source.sidebarMode : 'pinned',
    posterSize: clampSize(source.posterSize === undefined ? POSTER_DEFAULT : source.posterSize)
  }
  for (const key of BOOLEAN_KEYS) out[key] = source[key] !== false
  return out
}

function read(store) {
  return clean(store.get(STORE_KEY))
}

// Only the known keys are accepted, and a partial update keeps the rest.
function write(store, partial) {
  if (!partial || typeof partial !== 'object' || Array.isArray(partial)) throw invalid('Invalid interface preferences.')
  const next = read(store)
  if (partial.sidebarMode !== undefined) {
    if (!SIDEBAR_MODES.has(partial.sidebarMode)) throw invalid('Unknown sidebar mode.')
    next.sidebarMode = partial.sidebarMode
  }
  if (partial.posterSize !== undefined) {
    if (!Number.isFinite(Number(partial.posterSize))) throw invalid('Poster size must be a number.')
    next.posterSize = clampSize(partial.posterSize)
  }
  for (const key of BOOLEAN_KEYS) {
    if (partial[key] === undefined) continue
    if (typeof partial[key] !== 'boolean') throw invalid(key + ' must be true or false.')
    next[key] = partial[key]
  }
  store.set(STORE_KEY, next)
  return next
}

// --- Library views (Movies / TV Shows): per person ---------------------------------------
// How each library screen is shown (Posters, Table, Detailed list, Shelves...), its grouping and
// sort, the filters last used, and the person's named saved views. Kept apart from the plain prefs
// above (its own store key) and keyed by the person, so one member's saved views never show up on
// another's screen. The renderer (src/lib/libraryViews.js) owns the meaning of every field; this
// side only guarantees the stored value is plain JSON of a sane size and shape, so a bad write can
// never bloat or wedge the settings file: unknown keys are fine (the renderer ignores them), but
// depth, counts, string lengths and the total size are capped, and only the two known screens are kept.
const LIBRARY_VIEWS_KEY = 'uiPrefsLibraryViews'
const LIBRARY_KINDS = ['movies', 'tv']
const MAX_USERS = 50
const MAX_SAVED = 40
const MAX_DEPTH = 6
const MAX_ENTRIES = 60
const MAX_STRING = 200
const MAX_BYTES = 96 * 1024
const KEY_RE = /^[A-Za-z0-9_-]{1,40}$/
const USER_RE = /^[A-Za-z0-9_.@-]{1,80}$/

function cleanTree(value, depth) {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') return value.slice(0, MAX_STRING)
  if (depth >= MAX_DEPTH) return null
  if (Array.isArray(value)) return value.slice(0, MAX_ENTRIES).map((v) => cleanTree(v, depth + 1))
  if (typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value).slice(0, MAX_ENTRIES)) {
      if (KEY_RE.test(k) && k !== '__proto__') out[k] = cleanTree(v, depth + 1)
    }
    return out
  }
  return null
}

// One person's block: { movies: {...}, tv: {...} }, each screen's saved list capped.
function cleanUserViews(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const out = {}
  for (const kind of LIBRARY_KINDS) {
    if (!source[kind] || typeof source[kind] !== 'object' || Array.isArray(source[kind])) continue
    const block = cleanTree(source[kind], 0)
    if (Array.isArray(block.saved)) block.saved = block.saved.slice(0, MAX_SAVED)
    out[kind] = block
  }
  if (Buffer.byteLength(JSON.stringify(out)) > MAX_BYTES) throw invalid('Saved views are too large.')
  return out
}

function readLibraryViews(store, userId) {
  const all = store.get(LIBRARY_VIEWS_KEY)
  const users = all && typeof all === 'object' && !Array.isArray(all) ? all : {}
  const mine = Object.prototype.hasOwnProperty.call(users, userId) ? users[userId] : null
  try { return cleanUserViews(mine) } catch { return {} }
}

// Replaces the person's block with the (cleaned) value the renderer sends. The renderer always sends
// its whole per-person state, so there is nothing to merge; other people's blocks are left alone.
function writeLibraryViews(store, userId, value) {
  if (typeof userId !== 'string' || !USER_RE.test(userId)) throw invalid('Unknown person.')
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('Invalid library view settings.')
  const cleaned = cleanUserViews(value)
  const all = store.get(LIBRARY_VIEWS_KEY)
  const users = all && typeof all === 'object' && !Array.isArray(all) ? { ...all } : {}
  delete users[userId]
  users[userId] = cleaned // newest last
  const ids = Object.keys(users)
  // Bounded: past MAX_USERS the oldest-inserted people are dropped (the one just written is last).
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX_USERS))) if (id !== userId) delete users[id]
  store.set(LIBRARY_VIEWS_KEY, users)
  return cleaned
}

module.exports = { read, write, STORE_KEY, LIBRARY_VIEWS_KEY, readLibraryViews, writeLibraryViews }
