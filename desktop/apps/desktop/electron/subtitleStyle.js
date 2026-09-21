'use strict'
// ============================================================================
// subtitleStyle.js - how a viewer wants text subtitles to LOOK, saved per user with the other
// playback prefs (`playbackPrefs[user].subtitleStyle`, see playbackApi.js). Pure and dependency-free.
// ----------------------------------------------------------------------------
// Stored as small validated values, never as CSS or free text, so a client can only ever get back
// numbers, a #RRGGBB colour or a word from a fixed list. Each player turns them into its own
// styling: ::cue / an overlay on the web, CaptionStyleCompat on Android. Fonts are NAMES for the
// player's own system font families (sans, serif, mono, ...), never files or URLs.
// Picture subtitles (burnt into a conversion) are not affected by any of this.
// ============================================================================

const EDGES = ['none', 'outline', 'shadow', 'raised', 'depressed']
const FONTS = ['default', 'sans', 'serif', 'mono', 'casual', 'cursive', 'smallcaps']
const SIZE_MIN = 50
const SIZE_MAX = 200
const POSITION_MAX = 40

const DEFAULTS = Object.freeze({ size: 100, color: '#FFFFFF', bg: '#000000', bgOpacity: 0, edge: 'shadow', position: 8, font: 'default' })

const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)))

/** '#fff' / '#FFFFFF' / 'ffffff' -> '#FFFFFF'; anything else -> null. */
function normalizeColor(v) {
  if (typeof v !== 'string') return null
  const m = /^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/.exec(v.trim())
  if (!m) return null
  let h = m[1]
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  return '#' + h.toUpperCase()
}

function validField(key, v) {
  switch (key) {
    case 'size': return typeof v === 'number' && Number.isFinite(v) ? clampInt(v, SIZE_MIN, SIZE_MAX) : undefined
    case 'bgOpacity': return typeof v === 'number' && Number.isFinite(v) ? clampInt(v, 0, 100) : undefined
    case 'position': return typeof v === 'number' && Number.isFinite(v) ? clampInt(v, 0, POSITION_MAX) : undefined
    case 'color':
    case 'bg': { const c = normalizeColor(v); return c === null ? undefined : c }
    case 'edge': return typeof v === 'string' && EDGES.includes(v) ? v : undefined
    case 'font': return typeof v === 'string' && FONTS.includes(v) ? v : undefined
    default: return undefined
  }
}

/** A complete, valid style from whatever was stored: bad or missing fields fall back to the default. */
function read(stored) {
  const p = stored && typeof stored === 'object' ? stored : {}
  const out = {}
  for (const k of Object.keys(DEFAULTS)) {
    const v = validField(k, p[k])
    out[k] = v === undefined ? DEFAULTS[k] : v
  }
  return out
}

/**
 * The new stored style after applying a patch to the current one: only fields that are present and
 * valid change (an invalid one is dropped, never repaired); `null` or `{ reset: true }` returns the
 * defaults.
 */
function patch(current, incoming) {
  if (incoming === null || (incoming && typeof incoming === 'object' && incoming.reset === true)) return { ...DEFAULTS }
  const base = read(current)
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return base
  for (const k of Object.keys(DEFAULTS)) {
    if (!(k in incoming)) continue
    const v = validField(k, incoming[k])
    if (v !== undefined) base[k] = v
  }
  return base
}

module.exports = { DEFAULTS, EDGES, FONTS, SIZE_MIN, SIZE_MAX, POSITION_MAX, normalizeColor, read, patch }
