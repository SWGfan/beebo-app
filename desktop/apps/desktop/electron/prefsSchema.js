'use strict'
// The per-user preferences PROFILE: schema, registries and migrations. No storage, no HTTP, no DOM.
//
// A profile has four sections:
//   layout  how the app is laid out       (a layout pack fills exactly this section)
//   view    how the library is shown       (poster size, titles, icons, default mode/sort)
//   access  accessibility switches         (reduce motion, large text) - never touched by a pack
//   theme   colors: { preset, custom, pack }  - stored by theme.js; the profile only carries it
//
// The schema is CLOSED (unknown keys are rejected, never repaired) and VERSIONED: `v` is the schema version
// of a stored row or an exported file, and MIGRATIONS turn an older shape into the current one one step at
// a time. A file from a NEWER version is refused, not guessed at.
//
// The registries below (NAV_ITEMS, SHELVES, ...) are the closed lists ids must come from. A layout pack can
// reorder and hide things; it can never invent a nav item or a home row, so a pack cannot conjure a link.

const kit = require('./schemaKit')
const { PRESET_IDS } = require('./themePresets')
const theme = require('./theme')

const CURRENT_VERSION = 1
const PROFILE_FORMAT = 'beebo-profile'
const PROFILE_EXTENSION = '.beebo-profile'
const PACK_FORMAT = 'beebo-pack'

// ---- registries -----------------------------------------------------------------------------------------

// Sidebar entries. `surfaces`: which clients have the entry (a client ignores ids it does not have and keeps
// the ones a profile does not mention in their own default order). `locked`: cannot be hidden, because it is
// the way back (Appearance on the web, Settings in the desktop app).
const NAV_ITEMS = Object.freeze([
  { id: 'getstarted', label: 'Get Started', surfaces: ['desktop'] },
  { id: 'movies', label: 'Movies', surfaces: ['web', 'desktop'] },
  { id: 'tvshows', label: 'TV Shows', surfaces: ['web', 'desktop'] },
  { id: 'music', label: 'Music', surfaces: ['web'] },
  { id: 'trailers', label: 'Trailers', surfaces: ['desktop'] },
  { id: 'audiobooks', label: 'Audiobooks', surfaces: ['web', 'desktop'] },
  { id: 'podcasts', label: 'Podcasts', surfaces: ['desktop'] },
  { id: 'radio', label: 'Internet Radio', surfaces: ['desktop'] },
  { id: 'photos', label: 'Phone Backups', surfaces: ['desktop'] },
  { id: 'playlists', label: 'Playlists', surfaces: ['web', 'desktop'] },
  { id: 'livetv', label: 'Live TV', surfaces: ['web', 'desktop'] },
  { id: 'continue', label: 'Continue Watching', surfaces: ['web'] },
  { id: 'surprise', label: 'Discover', surfaces: ['web', 'desktop'] },
  { id: 'upload', label: 'Upload', surfaces: ['web', 'desktop'] },
  { id: 'migrate', label: 'Switch to Beebo', surfaces: ['desktop'] },
  { id: 'dashboard', label: 'Dashboard', surfaces: ['desktop'] },
  { id: 'admin', label: 'Admin', surfaces: ['web', 'desktop'] },
  { id: 'users', label: 'Users', surfaces: ['desktop'] },
  { id: 'history', label: 'Watch History', surfaces: ['desktop'] },
  { id: 'flags', label: 'Flags', surfaces: ['desktop'] },
  { id: 'converted', label: 'Converted', surfaces: ['desktop'] },
  { id: 'requests', label: 'Missing Files', surfaces: ['desktop'] },
  { id: 'school', label: 'BeeboSchool', surfaces: ['web', 'desktop'] },
  { id: 'getapp', label: 'Get the Apps', surfaces: ['web'] },
  { id: 'suggest', label: 'Suggestions', surfaces: ['web'] },
  { id: 'apikeys', label: 'API keys', surfaces: ['web'] },
  { id: 'appearance', label: 'Appearance', surfaces: ['web'], locked: true },
  { id: 'security', label: 'Account security', surfaces: ['web'] },
  { id: 'gamehost', label: 'Home Game Server', surfaces: ['desktop'] },
  { id: 'settings', label: 'Settings', surfaces: ['desktop'], locked: true }
])
const NAV_IDS = NAV_ITEMS.map((n) => n.id)
const LOCKED_NAV = new Set(NAV_ITEMS.filter((n) => n.locked).map((n) => n.id))

// Home-screen shelves (rows). Native apps have them today; the web gets them in a later phase.
const SHELF_ITEMS = Object.freeze([
  { id: 'continue', label: 'Continue watching' },
  { id: 'recent', label: 'Recently added' },
  { id: 'watchlist', label: 'My list' },
  { id: 'recommended', label: 'Because you watched' },
  { id: 'collections', label: 'Collections' },
  { id: 'trailers', label: 'Trailers' }
])
const SHELF_IDS = SHELF_ITEMS.map((s) => s.id)

const DENSITIES = ['compact', 'comfortable', 'spacious']
const CARD_STYLES = ['classic', 'flat', 'outlined', 'floating']
const POSTER_ASPECTS = ['2:3', '3:4', '1:1', '16:9']
const SIDEBAR_MODES = ['pinned', 'hover', 'hidden']
const LIBRARY_MODES = ['posters', 'table']
const LIBRARY_SORTS = ['title', 'year', 'added']
const MOTION = ['system', 'on', 'off']

const ORIGIN_ID = /^[a-z0-9][a-z0-9._-]{1,63}$/
const ORIGIN_VER = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/
const origin = kit.custom((v) => {
  if (!kit.isPlainObject(v) || Object.keys(v).some((k) => k !== 'id' && k !== 'ver')) return { ok: false, error: 'must be { id, ver }' }
  if (typeof v.id !== 'string' || !ORIGIN_ID.test(v.id)) return { ok: false, error: 'has an invalid pack id' }
  if (typeof v.ver !== 'string' || !ORIGIN_VER.test(v.ver)) return { ok: false, error: 'has an invalid pack version' }
  return { ok: true, value: { id: v.id, ver: v.ver } }
}, null)

const DEFAULT_SHELVES = SHELF_IDS.map((id) => ({ id, on: true }))

// ---- the layered schema (layout, view, access) ---------------------------------------------------------
// Stored SPARSE per layer (a user layer holds only what the person changed); resolved against defaults.
const LAYOUT = {
  pack: kit.nullable(origin),
  density: kit.enumOf(DENSITIES, 'comfortable'),
  cardStyle: kit.enumOf(CARD_STYLES, 'classic'),
  radius: kit.nullable(kit.intOf(0, 28, 12)), // px; null = whatever the theme says
  posterAspect: kit.enumOf(POSTER_ASPECTS, '2:3'),
  fontScale: kit.numOf(0.85, 1.6, 1, 0.05),
  sidebar: {
    mode: kit.enumOf(SIDEBAR_MODES, 'pinned'),
    order: kit.idListOf(NAV_IDS, NAV_IDS.length, []), // ids not listed keep their default order after these
    hidden: kit.idListOf(NAV_IDS, NAV_IDS.length, []) // locked ids are ignored here (they cannot be hidden)
  },
  home: {
    shelves: kit.rowListOf(SHELF_IDS, SHELF_IDS.length, DEFAULT_SHELVES)
  }
}
const VIEW = {
  posterSize: kit.intOf(90, 320, 160),
  showTitles: kit.boolOf(true),
  showIcons: kit.boolOf(true),
  library: {
    mode: kit.enumOf(LIBRARY_MODES, 'posters'),
    sort: kit.enumOf(LIBRARY_SORTS, 'title')
  }
}
const ACCESS = {
  reduceMotion: kit.enumOf(MOTION, 'system'),
  largeText: kit.boolOf(false)
}
const SCHEMA = Object.freeze({ layout: LAYOUT, view: VIEW, access: ACCESS })
const SECTIONS = Object.freeze(['layout', 'view', 'access', 'theme'])

// ---- the theme section (stored by theme.js, carried by the profile) ------------------------------------
const themePairs = kit.custom((v) => {
  if (!kit.isPlainObject(v)) return { ok: false, error: 'must be an object of --name: value pairs' }
  const clean = require('./cssSafe').sanitizeVars(v)
  return clean.ok ? { ok: true, value: clean.vars } : { ok: false, error: clean.errors[0] }
}, {})
const THEME_SCHEMA = Object.freeze({
  preset: kit.enumOf(PRESET_IDS, theme.DEFAULT_THEME),
  custom: themePairs,
  pack: kit.nullable(origin)
})

const DEFAULTS = Object.freeze({
  layout: kit.defaultsOf(LAYOUT),
  view: kit.defaultsOf(VIEW),
  access: kit.defaultsOf(ACCESS)
})

const LIMITS = Object.freeze({
  maxRowBytes: 32 * 1024, // one person's stored layer
  maxFileBytes: 256 * 1024 // an imported .beebo-profile or pack file
})

// ---- migrations ------------------------------------------------------------------------------------------
// MIGRATIONS[n] turns a version-n object into version n+1. Version 0 is "no `v` at all": the two shapes that
// existed before profiles (the desktop app's flat uiPrefs, and a userThemes row).
const isObj = kit.isPlainObject
const MIGRATIONS = {
  0: (d) => {
    const out = { layout: {}, view: {}, access: {} }
    if (!isObj(d)) return out
    if (typeof d.sidebarMode === 'string') out.layout.sidebar = { mode: d.sidebarMode }
    if (d.posterSize !== undefined) out.view.posterSize = Math.round(Number(d.posterSize))
    if (typeof d.showPosterTitles === 'boolean') out.view.showTitles = d.showPosterTitles
    if (typeof d.showPosterIcons === 'boolean') out.view.showIcons = d.showPosterIcons
    if (typeof d.theme === 'string' || isObj(d.custom)) {
      out.theme = {}
      if (typeof d.theme === 'string') out.theme.preset = d.theme
      if (isObj(d.custom)) out.theme.custom = d.custom
    }
    return out
  }
}

/**
 * Bring `data` (a profile-shaped object of version `from`) up to `target`. `steps` is injectable so tests can
 * prove the chain with fake future steps. Returns { ok, data, from, to } or { ok:false, error }.
 */
function migrate(data, from, { steps = MIGRATIONS, target = CURRENT_VERSION } = {}) {
  if (!Number.isInteger(from) || from < 0) return { ok: false, error: 'This profile has no valid version.' }
  if (from > target) return { ok: false, error: 'This profile was made by a newer version of Beebo. Update Beebo to use it.' }
  let current = data
  for (let v = from; v < target; v++) {
    const step = steps[v]
    if (typeof step !== 'function') return { ok: false, error: `No migration from version ${v}.` }
    try { current = step(current) } catch { return { ok: false, error: `Migration from version ${v} failed.` } }
  }
  return { ok: true, data: current, from, to: target }
}

// ---- validation entry points -----------------------------------------------------------------------------

/** Validate the layered sections. options as schemaKit.validate. */
function validateLayers(input, options = {}) {
  return kit.validate(SCHEMA, input, options)
}

/** Validate the theme section (no defaults filled in unless full). */
function validateTheme(input, options = {}) {
  return kit.validate(THEME_SCHEMA, input, options)
}

/** Validate a whole profile { layout, view, access, theme } (any subset with partial). */
function validateProfile(input, options = {}) {
  if (!kit.isPlainObject(input)) return { ok: false, value: {}, errors: ['profile must be an object'] }
  if (!options.dropInvalid && !kit.withinDepth(input, 8) ) return { ok: false, value: {}, errors: ['profile is nested too deeply'] }
  if (kit.hasForbiddenKey(input)) return { ok: false, value: {}, errors: ['profile uses a reserved key'] }
  const { theme: themeInput, ...layered } = input
  const layers = validateLayers(layered, options)
  const errors = layers.errors.slice()
  const value = layers.value
  if (themeInput !== undefined) {
    const t = validateTheme(themeInput, Object.assign({}, options, { path: 'theme' }))
    if (!t.ok && !options.dropInvalid) errors.push(...t.errors.map((e) => 'theme.' + e))
    value.theme = t.value
  }
  return { ok: errors.length === 0, value, errors }
}

/** Sidebar order the way clients use it: ids for `surface`, in profile order, locked ids never hidden. */
function resolveNav(sidebar, surface, defaultOrder) {
  const known = Array.isArray(defaultOrder) ? defaultOrder.slice() : NAV_ITEMS.filter((n) => n.surfaces.includes(surface)).map((n) => n.id)
  const order = ((sidebar && sidebar.order) || []).filter((id) => known.includes(id))
  const rest = known.filter((id) => !order.includes(id))
  const hidden = new Set(((sidebar && sidebar.hidden) || []).filter((id) => !LOCKED_NAV.has(id)))
  return order.concat(rest).filter((id) => !hidden.has(id))
}

/** The home shelves that are on, in profile order; shelves the profile omits keep default order at the end (on). */
function resolveShelves(home) {
  const rows = (home && Array.isArray(home.shelves)) ? home.shelves : []
  const seen = new Set(rows.map((r) => r.id))
  const all = rows.concat(SHELF_IDS.filter((id) => !seen.has(id)).map((id) => ({ id, on: true })))
  return all.filter((r) => r.on).map((r) => r.id)
}

module.exports = {
  CURRENT_VERSION, PROFILE_FORMAT, PROFILE_EXTENSION, PACK_FORMAT,
  NAV_ITEMS, NAV_IDS, LOCKED_NAV, SHELF_ITEMS, SHELF_IDS,
  DENSITIES, CARD_STYLES, POSTER_ASPECTS, SIDEBAR_MODES, LIBRARY_MODES, LIBRARY_SORTS, MOTION,
  SCHEMA, LAYOUT, VIEW, ACCESS, THEME_SCHEMA, SECTIONS, DEFAULTS, LIMITS, MIGRATIONS, DEFAULT_SHELVES,
  migrate, validateLayers, validateTheme, validateProfile, resolveNav, resolveShelves
}
