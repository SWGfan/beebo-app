'use strict'
// Per-user preferences profile storage and operations. Everything the API, the desktop IPC and the web
// pages do goes through here, so there is exactly one place that validates, versions and isolates.
//
// Storage (in the app's settings store, next to `userThemes`):
//   userPrefs[userId]  = { v, rev, updatedAt, data:{layout?,view?,access?,theme?:{pack}}, themeStamp? }   (sparse: only what the person changed)
//   householdPrefs     = { v, updatedAt, data:{layout?,view?,access?} }                                    (admin-set default layer)
//
// The COLOR choice itself (preset + custom overrides) stays in `userThemes[userId]` (electron/theme.js): that
// key, /api/theme and /appearance keep working untouched, and the profile carries the theme through this
// module. Resolution, per key, lowest to highest: built-in defaults, household layer, the person's layer.
//
// Guarantees (each has a test):
//   * one person can never read or write another's row: every function takes the acting userId, and an
//     invalid id (a guest 'share:...' principal, nothing, `__proto__`) gets defaults + household read-only;
//   * the stored row is re-validated on every read (a hand-edited store cannot inject anything);
//   * a write is all-or-nothing: any invalid part rejects the whole patch and nothing is stored;
//   * optimistic concurrency: `rev` changes on every write; a stale `ifMatch` gets a conflict, not a clobber;
//   * a row is capped (32 KB) and per-file imports are capped (256 KB).

const kit = require('./schemaKit')
const schema = require('./prefsSchema')
const theme = require('./theme')
const packs = require('./packs')
const contrast = require('./themeContrast')
const render = require('./prefsRender')

const KEY = 'userPrefs'
const HOUSEHOLD_KEY = 'householdPrefs'
const LAYERED = ['layout', 'view', 'access']
let rowLimit = schema.LIMITS.maxRowBytes // a variable only so a test can prove the backstop; nothing else changes it
const _setRowLimit = (n) => { rowLimit = n }

const validUserId = (id) => typeof id === 'string' && /^[\w.-]{1,120}$/.test(id) && !kit.FORBIDDEN_KEYS.has(id)
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k)

function readMap(store, key) {
  let map
  try { map = store.get(key) } catch { map = null }
  return kit.isPlainObject(map) ? map : {}
}

// ---- reading ---------------------------------------------------------------------------------------------

function cleanLayers(raw) {
  // Never trust the store: keep only leaves that still validate.
  const layered = {}
  if (kit.isPlainObject(raw)) for (const s of LAYERED) if (own(raw, s)) layered[s] = raw[s]
  return schema.validateLayers(layered, { partial: true, dropInvalid: true }).value
}

function readRow(store, userId) {
  const empty = { rev: 0, data: {}, pack: null, themeStamp: 0, updatedAt: 0 }
  if (!store || !validUserId(userId)) return empty
  const map = readMap(store, KEY)
  const row = own(map, userId) ? map[userId] : null
  if (!kit.isPlainObject(row)) return empty
  let data = kit.isPlainObject(row.data) ? row.data : {}
  if (Number.isInteger(row.v) && row.v < schema.CURRENT_VERSION) {
    const m = schema.migrate(data, row.v)
    data = m.ok ? m.data : {}
  } else if (!Number.isInteger(row.v) || row.v > schema.CURRENT_VERSION) {
    return empty
  }
  const t = kit.isPlainObject(data.theme) ? schema.validateTheme({ pack: data.theme.pack === undefined ? null : data.theme.pack }, { partial: true, dropInvalid: true }).value : {}
  return {
    rev: Number.isInteger(row.rev) && row.rev >= 0 ? row.rev : 0,
    data: cleanLayers(data),
    pack: t.pack || null,
    themeStamp: Number.isFinite(row.themeStamp) ? row.themeStamp : 0,
    updatedAt: Number.isFinite(row.updatedAt) ? row.updatedAt : 0
  }
}

function readHousehold(store) {
  if (!store) return {}
  const row = readMap(store, HOUSEHOLD_KEY)
  return cleanLayers(kit.isPlainObject(row.data) ? row.data : {})
}

function themeRow(store, userId) {
  if (!store || !validUserId(userId)) return { updatedAt: 0 }
  const map = readMap(store, 'userThemes')
  const row = own(map, userId) ? map[userId] : null
  return { updatedAt: kit.isPlainObject(row) && Number.isFinite(row.updatedAt) ? row.updatedAt : 0 }
}

/** The opaque revision a client sends back as If-Match: it moves when the profile OR the theme changes. */
function revOf(store, userId) {
  return `${readRow(store, userId).rev}.${themeRow(store, userId).updatedAt}`
}

/** defaults < household < person, plus the person's theme. */
function resolve(store, userId) {
  const row = readRow(store, userId)
  const household = readHousehold(store)
  const layered = kit.overlay(schema.DEFAULTS, household, row.data)
  const effective = schema.validateLayers(layered, {}).value // full, closed, defaults filled
  const saved = validUserId(userId) ? theme.getUserTheme(store, userId) : { theme: theme.DEFAULT_THEME, custom: {} }
  const stamp = themeRow(store, userId).updatedAt
  // The pack origin only counts while the theme is still what the pack put there.
  const pack = row.pack && row.themeStamp === stamp ? row.pack : null
  effective.theme = { preset: saved.theme, custom: saved.custom, pack }
  return { rev: revOf(store, userId), effective, user: row.data, household, personal: validUserId(userId) }
}

// ---- writing ---------------------------------------------------------------------------------------------

const fail = (status, error, errors) => ({ ok: false, status, error, errors: Array.isArray(errors) ? errors : [errors] })

function writeRow(store, userId, mutate) {
  const map = Object.assign({}, readMap(store, KEY))
  const cur = readRow(store, userId)
  const next = mutate({ data: kit.clone(cur.data), pack: cur.pack, themeStamp: cur.themeStamp })
  const layered = {}
  for (const s of LAYERED) if (next.data[s] !== undefined && Object.keys(next.data[s]).length) layered[s] = next.data[s]
  const stored = { v: schema.CURRENT_VERSION, rev: cur.rev + 1, updatedAt: Date.now(), data: layered }
  if (next.pack) { stored.data.theme = { pack: next.pack }; stored.themeStamp = next.themeStamp }
  if (kit.byteSize(stored) > rowLimit) return fail(413, 'too_large', 'These preferences are too large to save.')
  map[userId] = stored // a row is kept even when empty so `rev` never goes backwards (only removeUser deletes it)
  store.set(KEY, map)
  return { ok: true }
}

function checkIfMatch(store, userId, ifMatch) {
  if (ifMatch === undefined || ifMatch === null || ifMatch === '') return null
  const want = String(ifMatch).replace(/^W\//, '').replace(/^"|"$/g, '')
  return want === revOf(store, userId) ? null : fail(409, 'conflict', 'Your preferences changed on another device. Reload and try again.')
}

function requirePersonal(userId) {
  return validUserId(userId) ? null : fail(403, 'guest_has_no_prefs', 'Sign in with your own profile to save preferences.')
}

/** The theme half of a patch: { preset?, custom?(object|null), pack?(origin|null) } -> validated plan or a failure. */
function planTheme(store, userId, t) {
  if (!kit.isPlainObject(t)) return fail(400, 'invalid', 'theme must be an object')
  for (const k of Object.keys(t)) if (!['preset', 'custom', 'pack'].includes(k)) return fail(400, 'invalid', `theme.${k} is not a known setting`)
  const cur = theme.getUserTheme(store, userId)
  let preset = cur.theme
  let pairs = cur.custom
  if (t.preset !== undefined) {
    if (!theme.hasPreset(t.preset)) return fail(400, 'invalid', `theme.preset must be one of ${theme.PRESET_IDS.join(', ')}`)
    preset = t.preset
  }
  if (t.custom !== undefined) {
    if (t.custom === null) pairs = {}
    else {
      const clean = require('./cssSafe').sanitizeVars(t.custom)
      if (!clean.ok) return fail(400, 'invalid', clean.errors.map((e) => 'theme.custom: ' + e))
      pairs = clean.vars
    }
  }
  const problems = theme.readabilityProblems(preset, pairs)
  if (problems.length) return fail(400, 'unreadable', problems)
  let pack = null
  if (t.pack !== undefined && t.pack !== null) {
    const v = schema.validateTheme({ pack: t.pack }, { partial: true })
    if (!v.ok) return fail(400, 'invalid', v.errors)
    pack = v.value.pack
  }
  return { ok: true, preset, pairs, pack, keepPack: t.pack === undefined && t.custom === undefined && t.preset === undefined }
}

function commitTheme(store, userId, plan) {
  const out = theme.saveUserThemePairs(store, userId, { theme: plan.preset, pairs: plan.pairs })
  if (!out.ok) return fail(400, out.error, out.errors)
  return { ok: true, stamp: themeRow(store, userId).updatedAt }
}

/**
 * JSON merge-patch of the profile. Body: { layout?, view?, access?, theme? }; a section set to null resets it
 * (`theme:null` resets the theme too); a leaf set to null goes back to the household/default value.
 */
function patch(store, userId, body, { ifMatch } = {}) {
  const denied = requirePersonal(userId)
  if (denied) return denied
  if (!kit.isPlainObject(body)) return fail(400, 'invalid', 'Send a JSON object.')
  if (kit.hasForbiddenKey(body) || !kit.withinDepth(body, 8)) return fail(400, 'invalid', 'The request uses a reserved key or is nested too deeply.')
  for (const k of Object.keys(body)) if (!schema.SECTIONS.includes(k)) return fail(400, 'invalid', `${k} is not a known section`)
  if (!Object.keys(body).length) return fail(400, 'nothing_to_change', 'Send at least one section to change.')
  const conflict = checkIfMatch(store, userId, ifMatch)
  if (conflict) return conflict

  const row = readRow(store, userId)
  let layers = kit.clone(row.data)
  for (const s of LAYERED) {
    if (!own(body, s)) continue
    if (body[s] === null) { delete layers[s]; continue }
    layers[s] = kit.mergePatch(layers[s] || {}, body[s])
  }
  const v = schema.validateLayers(layers, { partial: true })
  if (!v.ok) return fail(400, 'invalid', v.errors)

  let plan = null
  let resetTheme = false
  if (own(body, 'theme')) {
    if (body.theme === null) resetTheme = true
    else { plan = planTheme(store, userId, body.theme); if (!plan.ok) return plan }
  }

  const wrote = writeRow(store, userId, (r) => {
    r.data = v.value
    return r
  })
  if (!wrote.ok) return wrote
  if (resetTheme) { theme.resetUserTheme(store, userId); dropPack(store, userId) }
  if (plan) {
    const c = commitTheme(store, userId, plan)
    if (!c.ok) return c
    const nextPack = plan.pack
    setPack(store, userId, nextPack, c.stamp)
  }
  return { ok: true, status: 200, state: describe(store, userId) }
}

function setPack(store, userId, pack, stamp) {
  const map = Object.assign({}, readMap(store, KEY))
  const cur = readRow(store, userId)
  const layered = {}
  for (const s of LAYERED) if (cur.data[s] && Object.keys(cur.data[s]).length) layered[s] = cur.data[s]
  const stored = { v: schema.CURRENT_VERSION, rev: cur.rev, updatedAt: Date.now(), data: layered }
  if (pack) { stored.data.theme = { pack }; stored.themeStamp = stamp }
  map[userId] = stored
  store.set(KEY, map)
}
const dropPack = (store, userId) => setPack(store, userId, null, 0)

/** Reset one section, or everything. */
function reset(store, userId, section = 'all', { ifMatch } = {}) {
  const denied = requirePersonal(userId)
  if (denied) return denied
  if (section !== 'all' && !schema.SECTIONS.includes(section)) return fail(400, 'invalid', 'section must be layout, view, access, theme or all')
  const conflict = checkIfMatch(store, userId, ifMatch)
  if (conflict) return conflict
  const keep = readRow(store, userId).data
  const layers = {}
  if (section !== 'all') for (const s of LAYERED) if (s !== section && keep[s]) layers[s] = keep[s]
  const wrote = writeRow(store, userId, (r) => { r.data = layers; return r })
  if (!wrote.ok) return wrote
  if (section === 'all' || section === 'theme') { theme.resetUserTheme(store, userId); dropPack(store, userId) }
  return { ok: true, status: 200, state: describe(store, userId) }
}

/** Delete everything stored for a person (account deletion). */
function removeUser(store, userId) {
  if (!store || !validUserId(userId)) return
  const map = readMap(store, KEY)
  if (!own(map, userId)) return
  const next = Object.assign({}, map)
  delete next[userId]
  if (Object.keys(next).length) store.set(KEY, next)
  else if (typeof store.delete === 'function') store.delete(KEY)
  else store.set(KEY, {})
}

// ---- household layer -------------------------------------------------------------------------------------

function setHousehold(store, body) {
  if (!kit.isPlainObject(body)) return fail(400, 'invalid', 'Send a JSON object.')
  for (const k of Object.keys(body)) if (!LAYERED.includes(k)) return fail(400, 'invalid', `${k} is not a household setting (only layout, view and access)`)
  const v = schema.validateLayers(Object.fromEntries(Object.entries(body).filter(([, x]) => x !== null)), { partial: true })
  if (!v.ok) return fail(400, 'invalid', v.errors)
  const cur = readHousehold(store)
  const merged = Object.assign({}, cur)
  for (const s of LAYERED) if (own(body, s)) { if (body[s] === null) delete merged[s]; else merged[s] = kit.mergePatch(cur[s] || {}, body[s]) }
  const again = schema.validateLayers(merged, { partial: true })
  if (!again.ok) return fail(400, 'invalid', again.errors)
  if (!Object.keys(again.value).length) { if (typeof store.delete === 'function') store.delete(HOUSEHOLD_KEY); else store.set(HOUSEHOLD_KEY, {}) }
  else store.set(HOUSEHOLD_KEY, { v: schema.CURRENT_VERSION, updatedAt: Date.now(), data: again.value })
  return { ok: true, status: 200, household: readHousehold(store) }
}

// ---- packs ----------------------------------------------------------------------------------------------

/** Apply a validated pack (packs.validatePack().pack) to a person. theme packs may auto-fix contrast. */
function applyPack(store, userId, pack, { autoFix = false, ifMatch } = {}) {
  const denied = requirePersonal(userId)
  if (denied) return denied
  const conflict = checkIfMatch(store, userId, ifMatch)
  if (conflict) return conflict
  const origin = { id: pack.id, ver: pack.version }
  if (pack.kind === 'layout') {
    const value = Object.assign({}, pack.content, { pack: origin })
    const v = schema.validateLayers({ layout: value }, { partial: true })
    if (!v.ok) return fail(400, 'invalid', v.errors)
    const wrote = writeRow(store, userId, (r) => { r.data.layout = v.value.layout; return r })
    if (!wrote.ok) return wrote
    return { ok: true, status: 200, state: describe(store, userId) }
  }
  if (pack.kind === 'theme') {
    const vars = packs.themeVarsFor(pack, { autoFix })
    const out = theme.saveUserThemePairs(store, userId, { theme: packs.baseOf(pack), pairs: vars })
    if (!out.ok) return fail(400, out.error, out.errors)
    setPack(store, userId, origin, themeRow(store, userId).updatedAt)
    return { ok: true, status: 200, state: describe(store, userId), fixed: autoFix }
  }
  return fail(400, 'invalid', 'Unknown pack kind.')
}

/** Apply a bundled pack by id. */
function applyBundled(store, userId, kind, id, opts) {
  const pack = packs.findBundled(kind, id)
  return pack ? applyPack(store, userId, pack, opts) : fail(404, 'unknown_pack', 'That pack is not installed.')
}

// ---- export / import -------------------------------------------------------------------------------------

function exportProfile(store, userId) {
  const { effective } = resolve(store, userId)
  return {
    format: schema.PROFILE_FORMAT, v: schema.CURRENT_VERSION, exportedAt: new Date().toISOString(),
    profile: { layout: effective.layout, view: effective.view, access: effective.access, theme: effective.theme }
  }
}

/**
 * Import a parsed file: a .beebo-profile, or a single pack. Returns { ok, dryRun, kind, diff, warnings }.
 * With dryRun (the default for previews) nothing is written. Never throws.
 */
function importFile(store, userId, file, { dryRun = false, autoFix = false, ifMatch } = {}) {
  const denied = requirePersonal(userId)
  if (denied) return denied
  if (!kit.isPlainObject(file)) return fail(400, 'invalid', 'This is not a Beebo file.')
  if (file.format === schema.PACK_FORMAT) {
    const r = packs.validatePack(file)
    if (!r.ok) return fail(400, 'invalid_pack', r.errors)
    const warnings = r.pack.kind === 'theme' ? packs.previewThemePack(r.pack) : null
    if (dryRun) return { ok: true, status: 200, dryRun: true, kind: r.pack.kind, name: r.pack.name, pack: packs.meta(r.pack), themeCheck: warnings, diff: [] }
    const applied = applyPack(store, userId, r.pack, { autoFix, ifMatch })
    return applied.ok ? Object.assign({ kind: r.pack.kind, name: r.pack.name }, applied) : applied
  }
  if (file.format !== schema.PROFILE_FORMAT) return fail(400, 'invalid', 'This is not a Beebo profile or pack file.')
  if (!Number.isInteger(file.v)) return fail(400, 'invalid', 'This file has no version.')
  if (!kit.withinDepth(file, 8) || kit.hasForbiddenKey(file)) return fail(400, 'invalid', 'This file is nested too deeply or uses a reserved key.')
  for (const k of Object.keys(file)) if (!['format', 'v', 'exportedAt', 'profile'].includes(k)) return fail(400, 'invalid', `${k} is not a known field`)
  const migrated = schema.migrate(file.profile, file.v)
  if (!migrated.ok) return fail(400, 'invalid', migrated.error)
  const v = schema.validateProfile(migrated.data, { partial: true })
  if (!v.ok) return fail(400, 'invalid_profile', v.errors)

  const before = resolve(store, userId).effective
  const proposedLayers = kit.overlay(before, v.value)
  const themePlan = v.value.theme ? planTheme(store, userId, Object.assign({}, v.value.theme, { pack: undefined })) : null
  if (themePlan && !themePlan.ok) return themePlan
  const diff = kit.diffPaths(before, Object.assign({}, proposedLayers, themePlan ? { theme: { preset: themePlan.preset, custom: themePlan.pairs, pack: v.value.theme.pack || null } } : {})).slice(0, 60)
  if (dryRun) return { ok: true, status: 200, dryRun: true, kind: 'profile', diff }
  const conflict = checkIfMatch(store, userId, ifMatch)
  if (conflict) return conflict
  const wrote = writeRow(store, userId, (r) => {
    for (const s of LAYERED) if (v.value[s]) r.data[s] = v.value[s]
    return r
  })
  if (!wrote.ok) return wrote
  if (themePlan) {
    const c = commitTheme(store, userId, themePlan)
    if (!c.ok) return c
    setPack(store, userId, v.value.theme.pack || null, c.stamp)
  }
  return { ok: true, status: 200, dryRun: false, kind: 'profile', diff, state: describe(store, userId) }
}

// ---- views for clients -----------------------------------------------------------------------------------

function schemaInfo() {
  return {
    version: schema.CURRENT_VERSION,
    densities: schema.DENSITIES, cardStyles: schema.CARD_STYLES, posterAspects: schema.POSTER_ASPECTS, sidebarModes: schema.SIDEBAR_MODES,
    libraryModes: schema.LIBRARY_MODES, librarySorts: schema.LIBRARY_SORTS, motion: schema.MOTION,
    navItems: schema.NAV_ITEMS, lockedNav: Array.from(schema.LOCKED_NAV), shelves: schema.SHELF_ITEMS,
    limits: { fontScale: [0.85, 1.6], radius: [0, 28], posterSize: [90, 320], maxFileBytes: schema.LIMITS.maxFileBytes },
    extension: schema.PROFILE_EXTENSION
  }
}

/** Everything a client needs: revision, effective values, the person's own layer, and what can be chosen. */
function describe(store, userId) {
  const r = resolve(store, userId)
  return {
    rev: r.rev, personal: r.personal, effective: r.effective, user: r.user, household: r.household,
    themes: theme.PRESET_IDS.map((id) => ({ id, label: theme.PRESETS[id].label, scheme: theme.PRESETS[id].scheme })),
    packs: packs.catalog(),
    render: render.renderSpec(r.effective),
    schema: schemaInfo()
  }
}

/**
 * What the page would look like with `body` (a patch of layout/view/access) applied, WITHOUT saving: the
 * attributes and CSS a client applies for a live preview. Same validation as patch().
 */
function preview(store, userId, body) {
  if (!kit.isPlainObject(body) || kit.hasForbiddenKey(body) || !kit.withinDepth(body, 8)) return fail(400, 'invalid', 'Send a JSON object.')
  for (const k of Object.keys(body)) if (!LAYERED.includes(k)) return fail(400, 'invalid', `${k} cannot be previewed`)
  const r = resolve(store, userId)
  let layers = kit.clone(r.user)
  for (const sec of LAYERED) {
    if (!own(body, sec)) continue
    if (body[sec] === null) delete layers[sec]
    else layers[sec] = kit.mergePatch(layers[sec] || {}, body[sec])
  }
  const v = schema.validateLayers(layers, { partial: true })
  if (!v.ok) return fail(400, 'invalid', v.errors)
  const effective = schema.validateLayers(kit.overlay(schema.DEFAULTS, r.household, v.value), {}).value
  const spec = render.renderSpec(effective)
  return { ok: true, status: 200, effective, spec, css: render.css(spec), attrs: render.htmlAttrs(spec) }
}

/** Contrast findings and the fix the checker would apply, for a preset + overrides (the editor's live checker). */
function checkTheme(preset, custom) {
  const base = theme.hasPreset(preset) ? preset : theme.DEFAULT_THEME
  const clean = require('./cssSafe').sanitizeVars(custom || {})
  if (!clean.ok) return fail(400, 'invalid', clean.errors)
  const before = contrast.check(base, clean.vars)
  const fix = before.failures.length ? contrast.autoFix(base, clean.vars) : null
  return { ok: true, status: 200, warnings: before.failures, checked: before.checked, fixable: !!fix && !fix.remaining.length, fixes: fix ? fix.changes : [], fixedVars: fix ? fix.vars : clean.vars }
}

module.exports = {
  KEY, HOUSEHOLD_KEY, validUserId,
  readRow, readHousehold, resolve, revOf, describe, schemaInfo,
  _setRowLimit, patch, preview, reset, removeUser, setHousehold, applyPack, applyBundled, exportProfile, importFile, checkTheme
}
