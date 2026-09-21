// Text / URL sanitising helpers. DOM-free (runs in Node for tests).
//
// Rule for this whole app: text that came from the server (titles, overviews, user names, error
// messages) is only ever put on screen with textContent - never innerHTML. These helpers are the
// second line of defence: they strip control and bidi-override characters, cap lengths, and refuse
// anything that is not a plain server-relative path or an https image URL.
//
// Old-Chromium rules apply (no ?. / ?? / replaceAll / optional catch binding).
// (Character classes are tested by code point instead of regex escapes on purpose: it keeps this
// file free of invisible characters and easy to review.)

var ELLIPSIS = String.fromCharCode(0x2026)

// Code points that never belong in on-screen text (TAB and LF are kept):
//   C0 controls except TAB/LF, DEL and C1 controls, zero-width + bidi marks (200B-200F), line and
//   paragraph separators, bidi embedding/override (202A-202E), word joiner + invisible operators
//   (2060-2064), bidi isolates and deprecated format characters (2066-206F), and the BOM.
function isUnsafeCode(c) {
  if (c < 32) return c !== 9 && c !== 10
  if (c >= 0x7f && c <= 0x9f) return true
  if (c >= 0x200b && c <= 0x200f) return true
  if (c === 0x2028 || c === 0x2029) return true
  if (c >= 0x202a && c <= 0x202e) return true
  if (c >= 0x2060 && c <= 0x2064) return true
  if (c >= 0x2066 && c <= 0x206f) return true
  return c === 0xfeff
}

function stripUnsafe(s) {
  var out = ''
  var start = 0
  for (var i = 0; i < s.length; i++) {
    if (isUnsafeCode(s.charCodeAt(i))) {
      out += s.slice(start, i)
      start = i + 1
    }
  }
  return start === 0 ? s : out + s.slice(start)
}

/** True when the string contains a control character (any C0 incl. TAB/LF, or DEL). */
export function hasControlChars(s) {
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i)
    if (c < 32 || c === 0x7f) return true
  }
  return false
}

/** Coerce anything to a display-safe string. Never throws. Truncates to maxLen with an ellipsis. */
export function safeText(value, maxLen) {
  if (value === null || value === undefined) return ''
  var s
  if (typeof value === 'string') s = value
  else if (typeof value === 'number' || typeof value === 'boolean') s = String(value)
  else return '' // objects/arrays/functions from a hostile server are never printed
  var cap = typeof maxLen === 'number' && maxLen > 0 ? Math.floor(maxLen) : 2000
  // Cut first (bounded work on a huge hostile string), then strip.
  s = stripUnsafe(s.length > cap * 2 + 16 ? s.slice(0, cap * 2 + 16) : s)
  if (s.length > cap) s = s.slice(0, Math.max(0, cap - 1)) + ELLIPSIS
  return s
}

/** Single-line variant: newlines and runs of whitespace collapse to one space. */
export function safeLine(value, maxLen) {
  var cap = maxLen || 200
  var s = safeText(value, cap * 2).replace(/\s+/g, ' ').trim()
  return s.length > cap ? s.slice(0, cap - 1) + ELLIPSIS : s
}

/**
 * HTML-escape. The app never builds HTML from data, so nothing calls this on the hot path; it is
 * here (and tested) so any future template code has a correct primitive to reach for.
 */
export function escapeHtml(value) {
  return safeText(value, 100000)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/`/g, '&#96;')
}

/** True only for "/path?query" - one leading slash, no scheme, no backslash, no control chars. */
export function isSafeRelPath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > 2048) return false
  if (p.charAt(0) !== '/') return false
  if (p.charAt(1) === '/' || p.charAt(1) === '\\') return false // protocol-relative
  if (hasControlChars(p) || p.indexOf('\\') >= 0) return false
  if (/^\/[a-z][a-z0-9+.-]*:/i.test(p)) return false
  return true
}

/** Server-supplied relative path, or null. */
export function safeRelPath(p) {
  return isSafeRelPath(p) ? p : null
}

// Backdrops are direct TMDB CDN URLs (see streamServer.js apiMovieItem). Nothing else is trusted.
var IMAGE_HOSTS = ['image.tmdb.org']

/** https image URL on an allow-listed host, or null. */
export function safeImageUrl(u) {
  if (typeof u !== 'string' || u.length > 1024) return null
  var m = /^https:\/\/([a-z0-9.-]+)(\/[^\s"'<>\\]*)$/i.exec(u)
  if (!m) return null
  if (IMAGE_HOSTS.indexOf(m[1].toLowerCase()) < 0) return null
  return u
}

/** Finite number in [min,max] or the fallback. */
export function clampNumber(value, min, max, fallback) {
  var n = typeof value === 'number' ? value : parseFloat(value)
  if (!isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

export function safeInt(value, fallback) {
  var n = typeof value === 'number' ? value : parseInt(value, 10)
  return isFinite(n) ? Math.round(n) : fallback
}

/** 3725 -> "1:02:05"; 65 -> "1:05". */
export function formatClock(totalSeconds) {
  var s = Math.max(0, Math.floor(Number(totalSeconds) || 0))
  var h = Math.floor(s / 3600)
  var m = Math.floor((s % 3600) / 60)
  var sec = s % 60
  var pad = function (n) { return n < 10 ? '0' + n : String(n) }
  return h > 0 ? h + ':' + pad(m) + ':' + pad(sec) : m + ':' + pad(sec)
}

/** 6300 -> "1 h 45 min"; 2700 -> "45 min"; 0/unknown -> "". */
export function formatRuntime(totalSeconds) {
  var mins = Math.round((Number(totalSeconds) || 0) / 60)
  if (!(mins > 0)) return ''
  var h = Math.floor(mins / 60)
  var m = mins % 60
  if (h > 0 && m > 0) return h + ' h ' + m + ' min'
  if (h > 0) return h + ' h'
  return m + ' min'
}

/** TMDB vote average (0-10) -> "7.8", or "" when unknown/zero. */
export function formatRating(vote) {
  var n = Number(vote)
  if (!isFinite(n) || n <= 0) return ''
  return n.toFixed(1)
}

/** Minimal-noise year: "" when missing / implausible. */
export function formatYear(y) {
  var n = parseInt(y, 10)
  return n >= 1880 && n <= 2200 ? String(n) : ''
}
