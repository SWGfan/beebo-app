'use strict'
// Turning names that came from another device into paths on this PC (security review F8).
// A name is one path segment: no separators, no characters Windows refuses, no trailing dots or
// spaces (Windows drops them, so "CON." would still be the console), and no reserved device name
// (CON, PRN, AUX, NUL, COM1-9, LPT1-9), with or without an extension ("nul.txt" is still NUL).

const RESERVED_DEVICE_RE = new RegExp('^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin[$]|conout[$])(\\..*)?$', 'i')
const BAD_CHARS_RE = new RegExp('[<>:"|?*' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + ']', 'g')

function isReservedDeviceName(segment) {
  return RESERVED_DEVICE_RE.test(String(segment || '').trim().replace(/[. ]+$/, ''))
}

/** One segment cleaned for use as a Windows/POSIX path component; '' when nothing usable is left. */
function safeSegment(input, { max = 200 } = {}) {
  let s = String(input == null ? '' : input).normalize('NFC').replace(BAD_CHARS_RE, '_').trim()
  if (s === '.' || s === '..') return ''
  s = s.replace(/[. ]+$/, '') // Windows silently drops trailing dots and spaces
  if (!s) return ''
  if (isReservedDeviceName(s)) s = '_' + s
  return s.slice(0, max)
}

/** 'a\\b/../c' -> 'a/b/c': separators normalised, empty / dot / dot-dot segments dropped, each segment safe. */
function safeRel(relPath) {
  return String(relPath || '')
    .replace(/\\/g, '/')
    .split('/')
    .map((x) => safeSegment(x))
    .filter(Boolean)
    .join('/')
}

module.exports = { safeRel, safeSegment, isReservedDeviceName }
