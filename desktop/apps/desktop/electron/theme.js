'use strict'
// Per-user themes for the browser site.
//
//   - a preset (data-theme="midnight|graphite|daylight|ember"), and
//   - an optional "Custom" overlay: a handful of `--variable: value;` overrides, validated here.
//
// Design rules this file keeps:
//   * A stylesheet is never built from user text. The custom slot is parsed into (name, value) pairs; the
//     name must be in the registry (themeTokens.js) and the value must match that variable's grammar
//     (color / gradient / small size). What reaches the page is re-serialised from the parsed value, so
//     a byte the grammar does not produce cannot appear in the CSS.
//   * Anything unusual is rejected, not repaired: braces, semicolon injection, comments, backslash
//     escapes (CSS's "\75rl(" spelling), url()/expression()/@import, non-ASCII look-alikes, huge input.
//   * The theme is applied while the page is rendered, as an attribute on <html> and a <style> block in
//     <head>, so a page never paints in the wrong theme first.
//   * Stored per person (`userThemes[userId]`), so one member's taste never changes another's screen.

const { AsyncLocalStorage } = require('async_hooks')
const { TOKENS, BY_NAME, GROUPS } = require('./themeTokens')
const { PRESETS, PRESET_IDS, DEFAULT_THEME } = require('./themePresets')

const STORE_KEY = 'userThemes'
const LIMITS = Object.freeze({
  maxTextLength: 4000, // the whole custom textarea
  maxValueLength: 300, // one value
  maxStops: 8, // gradient color stops
  maxLayers: 3, // comma-separated background layers
  maxRadiusPx: 64,
  maxRadiusEm: 4
})

// ---------------------------------------------------------------- value grammar ----------------------

const ALPHA = /^(\d{1,3}(?:\.\d{1,3})?|\.\d{1,3})(%)?$/
const ANGLE = /^(\d{1,3}(?:\.\d{1,2})?)deg$/
const POS = /^(?:0|\d{1,3}(?:\.\d{1,2})?%|\d{1,4}px)$/
const RADIAL_POS = /^(?:0|\d{1,3}(?:\.\d{1,2})?%|left|right|top|bottom|center)$/
const SIDES = new Set(['top', 'bottom', 'left', 'right'])

function num(text) { return Number(text) }
function fmt(n) { return String(Math.round(n * 1000) / 1000) }

function parseAlpha(text) {
  const m = ALPHA.exec(text)
  if (!m) return null
  let a = num(m[1])
  if (m[2]) a /= 100
  return a >= 0 && a <= 1 ? a : null
}

/** A color -> its canonical text, or null. Only hex, rgb()/rgba(), hsl()/hsla() and `transparent`. */
function parseColorValue(raw) {
  if (typeof raw !== 'string') return null
  const s = raw.trim().toLowerCase()
  if (s === 'transparent') return s
  if (/^#[0-9a-f]+$/.test(s)) return /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(s) ? s : null
  let m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([0-9.]{1,6}%?)\s*)?\)$/.exec(s)
  if (m) {
    const [r, g, b] = [num(m[1]), num(m[2]), num(m[3])]
    if (r > 255 || g > 255 || b > 255) return null
    if (m[4] === undefined) return `rgb(${r},${g},${b})`
    const a = parseAlpha(m[4])
    return a === null ? null : `rgba(${r},${g},${b},${fmt(a)})`
  }
  m = /^hsla?\(\s*(\d{1,3}(?:\.\d{1,2})?)(?:deg)?\s*,\s*(\d{1,3}(?:\.\d{1,2})?)%\s*,\s*(\d{1,3}(?:\.\d{1,2})?)%\s*(?:,\s*([0-9.]{1,6}%?)\s*)?\)$/.exec(s)
  if (m) {
    const [h, sat, l] = [num(m[1]), num(m[2]), num(m[3])]
    if (h > 360 || sat > 100 || l > 100) return null
    if (m[4] === undefined) return `hsl(${fmt(h)},${fmt(sat)}%,${fmt(l)}%)`
    const a = parseAlpha(m[4])
    return a === null ? null : `hsla(${fmt(h)},${fmt(sat)}%,${fmt(l)}%,${fmt(a)})`
  }
  return null
}

/** Split on commas that are not inside parentheses. null when parentheses are unbalanced or nest deeper than one level. */
function splitTopLevel(str) {
  const parts = []
  let depth = 0
  let cur = ''
  for (const ch of str) {
    if (ch === '(') { depth++; if (depth > 2) return null }
    else if (ch === ')') { depth--; if (depth < 0) return null }
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = '' } else cur += ch
  }
  if (depth !== 0) return null
  parts.push(cur.trim())
  return parts
}

function parseStopPosition(text) {
  if (!POS.test(text)) return null
  if (text === '0') return '0'
  if (text.endsWith('%')) { const n = num(text.slice(0, -1)); return n <= 100 ? fmt(n) + '%' : null }
  const n = num(text.slice(0, -2))
  return n <= 4096 ? fmt(n) + 'px' : null
}

function parseColorStop(part) {
  const plain = parseColorValue(part)
  if (plain) return plain
  const at = part.lastIndexOf(' ')
  if (at < 1) return null
  const color = parseColorValue(part.slice(0, at))
  const pos = parseStopPosition(part.slice(at + 1))
  return color && pos ? `${color} ${pos}` : null
}

function parseGradient(value) {
  const m = /^(linear|radial)-gradient\((.*)\)$/.exec(value)
  if (!m) return null
  const parts = splitTopLevel(m[2])
  if (!parts || parts.some((p) => p === '')) return null
  let head = null
  if (m[1] === 'linear') {
    const angle = ANGLE.exec(parts[0])
    if (angle) {
      const deg = num(angle[1])
      if (deg > 360) return null
      head = fmt(deg) + 'deg'
    } else if (/^to (?:top|bottom|left|right)(?: (?:top|bottom|left|right))?$/.test(parts[0])) {
      const sides = parts[0].slice(3).split(' ')
      const vertical = sides.filter((s) => s === 'top' || s === 'bottom').length
      if (sides.length === 2 && (vertical !== 1 || sides.some((s) => !SIDES.has(s)))) return null
      head = parts[0]
    }
  } else {
    const shape = /^(?:(circle|ellipse)(?: |$))?(?:at (\S+) (\S+))?$/.exec(parts[0])
    if (shape && parts[0] !== '') {
      const at = shape[2] !== undefined
      if (at) {
        for (const p of [shape[2], shape[3]]) {
          if (!RADIAL_POS.test(p) || (p.endsWith('%') && num(p.slice(0, -1)) > 100)) return null
        }
      }
      // Rebuilt from the validated pieces, never copied from the input.
      head = [shape[1], at ? `at ${shape[2]} ${shape[3]}` : null].filter(Boolean).join(' ')
    }
  }
  const stopParts = head === null ? parts : parts.slice(1)
  if (stopParts.length < 2 || stopParts.length > LIMITS.maxStops) return null
  const stops = []
  for (const part of stopParts) {
    const stop = parseColorStop(part)
    if (!stop) return null
    stops.push(stop)
  }
  return `${m[1]}-gradient(${[head, ...stops].filter((x) => x !== null).join(',')})`
}

function parsePaint(value, type) {
  const layers = splitTopLevel(value)
  if (!layers || layers.length < 1 || layers.length > LIMITS.maxLayers) return null
  const out = []
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i]
    if (layer === 'none') { out.push('none'); continue }
    const gradient = parseGradient(layer)
    if (gradient) { out.push(gradient); continue }
    // A bare color is only a valid CSS background as the final layer.
    const color = type === 'paint' && i === layers.length - 1 ? parseColorValue(layer) : null
    if (!color) return null
    out.push(color)
  }
  return out.join(',')
}

function parseSize(value) {
  const m = /^(\d{1,2}(?:\.\d{1,2})?)(px|rem|em)?$/.exec(value)
  if (!m) return null
  const n = num(m[1])
  if (!m[2]) return n === 0 ? '0px' : null
  if (m[2] === 'px' ? n > LIMITS.maxRadiusPx : n > LIMITS.maxRadiusEm) return null
  return fmt(n) + m[2]
}

const TYPE_HELP = {
  color: 'a color: #rrggbb, #rgb, rgb(r,g,b), rgba(r,g,b,a), hsl(h,s%,l%) or transparent',
  paint: 'a color, none, or a linear-gradient()/radial-gradient() of colors',
  layer: 'none, or a linear-gradient()/radial-gradient() of colors',
  size: `a size such as 12px (up to ${LIMITS.maxRadiusPx}px or ${LIMITS.maxRadiusEm}rem)`
}

/** One value for one variable type -> { ok, value } (canonical) or { ok:false, error }. */
function parseValue(type, raw) {
  if (typeof raw !== 'string') return { ok: false, error: 'is not text.' }
  const value = raw.trim().replace(/\s+/g, ' ')
  if (!value) return { ok: false, error: 'has no value.' }
  if (value.length > LIMITS.maxValueLength) return { ok: false, error: `is longer than ${LIMITS.maxValueLength} characters.` }
  let out = null
  if (type === 'color') out = parseColorValue(value)
  else if (type === 'paint' || type === 'layer') out = parsePaint(value, type)
  else if (type === 'size') out = parseSize(value.toLowerCase())
  if (out === null) return { ok: false, error: `must be ${TYPE_HELP[type] || 'a supported value'}.` }
  return { ok: true, value: out }
}

// ---------------------------------------------------------------- the custom slot ---------------------

// Nothing outside plain printable ASCII (plus tab / newline): rules out look-alike Unicode (fullwidth
// "ｕｒｌ(", RTL overrides, zero-width joiners), NUL and other control characters in one check.
const ASCII_ONLY = /^[\x20-\x7e\t\r\n]*$/
// Characters and words that mean "this is CSS, not a value", rejected before any parsing so the error is
// the same whichever way they were spelled. The value grammar would refuse all of these anyway; this is
// the second wall.
const FORBIDDEN = [
  [/[{}]/, 'braces'], [/\\/, 'backslash escapes'], [/\/\*|\*\//, 'comments'], [/[<>]/, 'angle brackets'],
  [/@/, 'at-rules'], [/["'`]/, 'quotes'], [/!/, '!important'], [/&/, 'ampersands'],
  [/url\s*\(|image-set|image\s*\(|src\s*\(|element\s*\(|paint\s*\(/i, 'url() or image functions'],
  [/expression|javascript|vbscript|behavior|binding|@import|import/i, 'script or import keywords'],
  [/\bvar\s*\(|\benv\s*\(|\battr\s*\(|\bcalc\s*\(|\bmin\s*\(|\bmax\s*\(|\bclamp\s*\(/i, 'var(), env(), attr() or calc()'],
  [/data:|https?:|\/\//i, 'links']
]

function safeName(name) { return /^--[a-z0-9-]{1,40}$/.test(name) ? name : 'a variable name' }

/**
 * Parse the Custom textarea. Accepts only `--variable: value;` declarations.
 * Returns { ok:true, pairs } with canonical values, or { ok:false, errors:[text] } (nothing is applied).
 */
function parseCustomTheme(input) {
  const errors = []
  const fail = (msg) => { if (errors.length < 20) errors.push(msg) }
  if (input === undefined || input === null || input === '') return { ok: true, pairs: {}, errors }
  if (typeof input !== 'string') return { ok: false, pairs: {}, errors: ['Custom theme must be text.'] }
  if (input.length > LIMITS.maxTextLength) {
    return { ok: false, pairs: {}, errors: [`Custom theme is longer than ${LIMITS.maxTextLength} characters.`] }
  }
  if (!ASCII_ONLY.test(input)) {
    return { ok: false, pairs: {}, errors: ['Use plain keyboard characters only (no accents, symbols from other scripts, or hidden characters).'] }
  }
  for (const [re, label] of FORBIDDEN) {
    if (re.test(input)) return { ok: false, pairs: {}, errors: [`Not allowed in a custom theme: ${label}. Only lines like --bg: #101418; are accepted.`] }
  }
  const segments = input.split(';')
  if (segments.length && segments[segments.length - 1].trim() === '') segments.pop()
  if (segments.length > TOKENS.length) return { ok: false, pairs: {}, errors: [`Too many declarations (the most that can apply is ${TOKENS.length}).`] }
  const pairs = {}
  for (const segment of segments) {
    const text = segment.trim()
    if (!text) { fail('An empty declaration was found; remove the extra semicolon.'); continue }
    const colon = text.indexOf(':')
    if (colon < 0) { fail('Each line must look like --name: value;'); continue }
    const name = text.slice(0, colon).trim()
    const rawValue = text.slice(colon + 1)
    if (!/^--[a-z0-9-]{1,40}$/.test(name)) { fail('Each line must start with a variable name like --bg.'); continue }
    const token = BY_NAME.get(name)
    if (!token) { fail(`${safeName(name)} is not a theme variable. See the list of variables below.`); continue }
    if (Object.prototype.hasOwnProperty.call(pairs, name)) { fail(`${name} is set more than once.`); continue }
    const parsed = parseValue(token.type, rawValue)
    if (!parsed.ok) { fail(`${name} ${parsed.error}`); continue }
    pairs[name] = parsed.value
  }
  return errors.length ? { ok: false, pairs: {}, errors } : { ok: true, pairs, errors }
}

/** Canonical stored pairs -> the text shown in the textarea (registry order). */
function customText(pairs) {
  return TOKENS.filter((tok) => pairs && Object.prototype.hasOwnProperty.call(pairs, tok.name))
    .map((tok) => `${tok.name}: ${pairs[tok.name]};`).join('\n')
}

/** Drop anything from a stored object that does not re-validate. Never trust the store. */
function sanitizePairs(obj) {
  const out = {}
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out
  for (const name of Object.keys(obj)) {
    const token = BY_NAME.get(name)
    if (!token) continue
    const parsed = parseValue(token.type, obj[name])
    if (parsed.ok) out[name] = parsed.value
  }
  return out
}

// ---------------------------------------------------------------- CSS synthesis -----------------------

const DECL_SAFE = /^(?:--[a-z0-9-]+:[#a-z0-9%.,()\s-]+;)+$/
const hasPreset = (id) => typeof id === 'string' && Object.prototype.hasOwnProperty.call(PRESETS, id)
const scheme = (id) => (hasPreset(id) && PRESETS[id].scheme === 'light' ? 'light' : 'dark')

/** `:root[data-theme="id"]{...}` for a preset. midnight has no block: it is the stylesheet default. */
function presetCss(id) {
  const preset = hasPreset(id) ? PRESETS[id] : null
  if (!preset || !preset.vars) return ''
  const body = TOKENS.filter((tok) => Object.prototype.hasOwnProperty.call(preset.vars, tok.name))
    .map((tok) => `${tok.name}:${preset.vars[tok.name]};`).join('')
  return `:root[data-theme="${id}"]{color-scheme:${scheme(id)};${body}}`
}

/** Every preset's block, for the Appearance page's live preview. */
function allPresetsCss() {
  return PRESET_IDS.map(presetCss).filter(Boolean).join('\n')
}

/**
 * The custom overrides as a CSS rule, rebuilt from validated pairs. Same specificity as a preset rule and
 * placed after it, so it wins; `color-scheme` is deliberately not settable here.
 */
function customCss(pairs) {
  const clean = sanitizePairs(pairs)
  const body = TOKENS.filter((tok) => Object.prototype.hasOwnProperty.call(clean, tok.name))
    .map((tok) => `${tok.name}:${clean[tok.name]};`).join('')
  if (!body || !DECL_SAFE.test(body)) return ''
  return `:root[data-theme]{${body}}`
}

// ---------------------------------------------------------------- contrast ---------------------------

function toRgb(color) {
  const c = parseColorValue(color)
  if (!c || c === 'transparent') return null
  if (c[0] === '#') {
    let h = c.slice(1, c.length <= 5 ? 4 : 7)
    if (h.length === 3) h = h.split('').map((x) => x + x).join('')
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
  }
  let m = /^rgba?\((\d+),(\d+),(\d+)/.exec(c)
  if (m) return [num(m[1]), num(m[2]), num(m[3])]
  m = /^hsla?\(([\d.]+),([\d.]+)%,([\d.]+)%/.exec(c)
  if (m) {
    const h = num(m[1]) / 360
    const s = num(m[2]) / 100
    const l = num(m[3]) / 100
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s
    const p = 2 * l - q
    const f = (t0) => {
      let t = t0
      if (t < 0) t += 1
      if (t > 1) t -= 1
      if (t < 1 / 6) return p + (q - p) * 6 * t
      if (t < 1 / 2) return q
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
      return p
    }
    return [f(h + 1 / 3), f(h), f(h - 1 / 3)].map((x) => Math.round(x * 255))
  }
  return null
}

function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4) })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio of two color strings (alpha ignored); null when either is not a plain color. */
function contrastRatio(a, b) {
  const x = toRgb(a)
  const y = toRgb(b)
  if (!x || !y) return null
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p)
  return (hi + 0.05) / (lo + 0.05)
}

// The pairs that make a page unreadable when they collide. Enforced on save so a custom theme can never
// produce a screen whose own controls cannot be read (and the Reset control never depends on them anyway).
const READABILITY = [['--text', '--bg', 3], ['--text', '--panel', 3], ['--muted', '--bg', 3], ['--link', '--bg', 3]]

function effectiveValue(themeId, pairs, name) {
  if (Object.prototype.hasOwnProperty.call(pairs, name)) return pairs[name]
  const preset = hasPreset(themeId) ? PRESETS[themeId] : null
  if (preset && preset.vars && Object.prototype.hasOwnProperty.call(preset.vars, name)) return preset.vars[name]
  const token = BY_NAME.get(name)
  return token ? token.default : null
}

function readabilityProblems(themeId, pairs) {
  const problems = []
  for (const [fg, bg, min] of READABILITY) {
    const ratio = contrastRatio(effectiveValue(themeId, pairs, fg), effectiveValue(themeId, pairs, bg))
    if (ratio !== null && ratio < min) {
      problems.push(`${fg} on ${bg} would be hard to read (contrast ${ratio.toFixed(1)}:1, at least ${min}:1 needed).`)
    }
  }
  return problems
}

// ---------------------------------------------------------------- per-user storage --------------------

const validUserId = (id) => typeof id === 'string' && /^[\w.-]{1,120}$/.test(id) && id !== '__proto__'

function readMap(store) {
  let map
  try { map = store.get(STORE_KEY) } catch { map = null }
  return map && typeof map === 'object' && !Array.isArray(map) ? map : {}
}

/** What is saved for one person, re-validated: { theme, custom }. */
function getUserTheme(store, userId) {
  const empty = { theme: DEFAULT_THEME, custom: {} }
  if (!store || !validUserId(userId)) return empty
  const map = readMap(store)
  const row = Object.prototype.hasOwnProperty.call(map, userId) ? map[userId] : null
  if (!row || typeof row !== 'object') return empty
  return {
    theme: hasPreset(row.theme) ? row.theme : DEFAULT_THEME,
    custom: sanitizePairs(row.custom)
  }
}

/**
 * Save part or all of one person's theme. `changes` may hold `theme` (a preset id) and/or `custom` (the
 * textarea text; '' clears it). Anything omitted is kept. Nothing is stored unless everything validates.
 */
function saveUserTheme(store, userId, changes) {
  if (!store || !validUserId(userId)) return { ok: false, error: 'unauthorized', errors: ['Sign in to change your theme.'] }
  const body = changes && typeof changes === 'object' ? changes : {}
  const current = getUserTheme(store, userId)
  let theme = current.theme
  let custom = current.custom
  if (body.theme !== undefined) {
    if (!hasPreset(body.theme)) {
      return { ok: false, error: 'unknown_theme', errors: [`Choose one of: ${PRESET_IDS.join(', ')}.`] }
    }
    theme = body.theme
  }
  if (body.custom !== undefined) {
    const parsed = parseCustomTheme(body.custom)
    if (!parsed.ok) return { ok: false, error: 'invalid_custom', errors: parsed.errors }
    custom = parsed.pairs
  }
  const problems = readabilityProblems(theme, custom)
  if (problems.length) return { ok: false, error: 'unreadable', errors: problems }
  writeUserTheme(store, userId, theme, custom)
  return { ok: true, state: describe(theme, custom) }
}

/**
 * Save an already-parsed set of overrides (a pack's variables), bypassing the textarea's 4,000-character
 * limit: `pairs` is re-validated here exactly as stored pairs are on every read, and the readability floor
 * still applies. Used by theme packs (electron/packs.js).
 */
function saveUserThemePairs(store, userId, { theme: id, pairs }) {
  if (!store || !validUserId(userId)) return { ok: false, error: 'unauthorized', errors: ['Sign in to change your theme.'] }
  if (!hasPreset(id)) return { ok: false, error: 'unknown_theme', errors: [`Choose one of: ${PRESET_IDS.join(', ')}.`] }
  const custom = sanitizePairs(pairs)
  const problems = readabilityProblems(id, custom)
  if (problems.length) return { ok: false, error: 'unreadable', errors: problems }
  writeUserTheme(store, userId, id, custom)
  return { ok: true, state: describe(id, custom) }
}

function writeUserTheme(store, userId, theme, custom) {
  const map = Object.assign({}, readMap(store))
  if (theme === DEFAULT_THEME && !Object.keys(custom).length) delete map[userId]
  else map[userId] = { theme, custom, updatedAt: Date.now() }
  if (Object.keys(map).length) store.set(STORE_KEY, map)
  else if (typeof store.delete === 'function') store.delete(STORE_KEY)
  else store.set(STORE_KEY, {})
}

function resetUserTheme(store, userId) {
  if (!store || !validUserId(userId)) return { ok: false, error: 'unauthorized', errors: ['Sign in to change your theme.'] }
  writeUserTheme(store, userId, DEFAULT_THEME, {})
  return { ok: true, state: describe(DEFAULT_THEME, {}) }
}

function describe(theme, custom) {
  return { theme, custom, customText: customText(custom), scheme: scheme(theme) }
}

/** The public settings shape: current choice plus what can be chosen. */
function settingsFor(store, userId) {
  const saved = getUserTheme(store, userId)
  return {
    ...describe(saved.theme, saved.custom),
    themes: PRESET_IDS.map((id) => ({ id, label: PRESETS[id].label, description: PRESETS[id].description, scheme: PRESETS[id].scheme })),
    variables: TOKENS.map(({ name, type, default: def, group, desc }) => ({ name, type, default: def, group, description: desc })),
    limits: { maxTextLength: LIMITS.maxTextLength }
  }
}

// ---------------------------------------------------------------- per-request application -------------

/** What one page render needs: the <html> attribute, the theme-color meta, and the extra CSS. */
function renderInfo(saved, { safe = false } = {}) {
  const chosen = safe ? { theme: DEFAULT_THEME, custom: {} } : saved
  const id = hasPreset(chosen.theme) ? chosen.theme : DEFAULT_THEME
  const preset = PRESETS[id]
  const css = [presetCss(id), customCss(chosen.custom)].filter(Boolean).join('\n')
  // A theme pack that sets --bg colors the phone browser bar to match; otherwise the preset's own bar color.
  const bg = chosen.custom && Object.prototype.hasOwnProperty.call(chosen.custom, '--bg') ? toRgb(sanitizePairs(chosen.custom)['--bg']) : null
  const themeColor = bg ? '#' + bg.map((n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0')).join('') : preset.themeColor
  return { id, scheme: preset.scheme, themeColor, css }
}

const scope = new AsyncLocalStorage()

/** Run one request with an empty holder; the signed-in person is filled in once known (as contentGate does). */
function runWithScope(fn) { return scope.run({ store: null, userId: null, safe: false, info: null }, fn) }
function setRequestUser(store, userId) {
  const s = scope.getStore()
  if (s) { s.store = store; s.userId = userId || null; s.info = null; s.prefs = null }
}
/** Render this request in the default theme regardless of what is saved (the Appearance page's safe mode). */
function useDefaultForRequest() {
  const s = scope.getStore()
  if (s) { s.safe = true; s.info = null; s.prefs = null }
}
/** The theme for the page being rendered now. Outside a request, or with nobody signed in: the default. */
function requestRenderInfo() {
  const s = scope.getStore()
  if (!s) return renderInfo({ theme: DEFAULT_THEME, custom: {} })
  if (!s.info) {
    let saved = { theme: DEFAULT_THEME, custom: {} }
    try { if (s.store && s.userId) saved = getUserTheme(s.store, s.userId) } catch { /* a settings read never breaks a page */ }
    s.info = renderInfo(saved, { safe: s.safe })
    // Layout / accessibility choices from the person's profile (electron/prefsRender.js): extra <html> attributes and CSS.
    try { require('./prefsRender').augment(s.info, s) } catch { /* never breaks a page */ }
  }
  return s.info
}

/** The holder of the request being rendered ({ store, userId, safe, prefs }); prefsRender caches on it. Null outside a request. */
function requestScope() {
  return scope.getStore() || null
}

/** The page background (--bg: the preset's, or the person's override) as #rrggbb, for the web app manifest. */
function requestBackgroundColor() {
  const s = scope.getStore()
  let saved = { theme: DEFAULT_THEME, custom: {} }
  try { if (s && s.store && s.userId && !s.safe) saved = getUserTheme(s.store, s.userId) } catch { /* a settings read never breaks a page */ }
  const id = hasPreset(saved.theme) ? saved.theme : DEFAULT_THEME
  const rgb = toRgb(effectiveValue(id, sanitizePairs(saved.custom), '--bg'))
  return rgb ? '#' + rgb.map((n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0')).join('') : '#080b14'
}

module.exports = {
  requestBackgroundColor,
  STORE_KEY, LIMITS, TOKENS, GROUPS, PRESETS, PRESET_IDS, DEFAULT_THEME,
  parseValue, parseColorValue, parseCustomTheme, customText, sanitizePairs,
  presetCss, allPresetsCss, customCss, contrastRatio, readabilityProblems,
  getUserTheme, saveUserTheme, saveUserThemePairs, resetUserTheme, settingsFor, renderInfo,
  toRgb, luminance, effectiveValue, hasPreset, requestScope,
  runWithScope, setRequestUser, useDefaultForRequest, requestRenderInfo
}
