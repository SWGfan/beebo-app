'use strict'
// Removes anything that looks like a credential before text reaches a log file or a
// diagnostics report. It errs on the side of hiding too much: a log line that lost a
// harmless word is a small cost, a token in a file people paste into a forum is not.
//
// Every pattern is linear-time on purpose (no nested quantifiers, no unbounded prefix
// scans), because this runs over every line the main process logs.

const MAX_LINE = 8192
const R = '[redacted]'

// A value after `name=` / `name: ` / `"name":`. Already-redacted text is skipped so a
// second pass changes nothing.
const VALUE = '(?!\\[redacted)(?:"(?:[^"\\\\\\r\\n]|\\\\.)*"|\'(?:[^\'\\\\\\r\\n]|\\\\.)*\'|[^\\s,;&"\'}\\])]+)'
// Gmail-style app passwords are shown as four groups of four letters with spaces.
const SPACED_APP_PASSWORD = '(?:[A-Za-z]{4} ){3}[A-Za-z]{4}\\b'

const SECRET_NAME_PARTS = [
  'password', 'passwd', 'passphrase', 'secret', 'token', 'apikey', 'api[_-]key',
  'licen[cs]e[_-]?key', 'activation[_-]?key', 'app[_-]?pass', 'credential', 'private[_-]?key'
].join('|')
// Short names that are only secrets as a whole word.
const SHORT_NAMES = 'mt|pw|pwd|pass|pat|sig|sid|auth|session|cookie|otp|pin|challenge|unlock'
// Names that are secrets in a URL query string but ordinary words elsewhere ("exit code=0").
// wt = a Watch together room code, k = a car-party join key, g = a car-party guest token.
const QUERY_ONLY_NAMES = 'key|code|signature|jwt|assertion|invite|ticket|pair|pairing|wt|k|g'

const RULES = [
  // Authorization / Cookie headers: the whole value, scheme included.
  { re: /(\bauthorization["']?\s*[:=]\s*["']?)(?!\[redacted)(?:(?:bearer|basic|token|digest|negotiate)\s+)?[^\s"',;}]+/gi, to: '$1' + R },
  { re: /(\b(?:set-)?cookie["']?\s*[:=]\s*["']?)(?!\[redacted)[^\r\n]*/gi, to: '$1' + R },
  { re: /(\bbearer\s+)(?!\[redacted)[A-Za-z0-9\-._~+/]{8,}=*/gi, to: '$1' + R },
  // Beebo's own token shapes.
  { re: /\b(?:beebo_)?pat_[A-Za-z0-9_-]{6,}/g, to: 'pat_' + R },
  { re: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{0,}/g, to: R },
  { re: /\bbeebo_[a-z_]*(?:session|token|media)[a-z_]*=[^\s;,"']+/gi, to: 'beebo_session=' + R },
  // A secret that lives in the PATH: a private trip link (/trip/<43 chars>) and an HLS ticket (/hls/<ticket>/...).
  { re: /(\/trip\/)[A-Za-z0-9_-]{20,}/g, to: '$1' + R },
  { re: /(\/hls\/)(?!\[redacted)[A-Za-z0-9_.-]{10,}(?=\/)/g, to: '$1' + R },
  // https://user:password@host
  { re: /(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, to: '$1' + R + '@' },
  // Query strings and form bodies: ?token=..&mt=..
  { re: new RegExp('([?&;](?:[A-Za-z0-9_.-]{0,40}?(?:' + SECRET_NAME_PARTS + ')[A-Za-z0-9_.-]{0,20}|(?:' + SHORT_NAMES + '|' + QUERY_ONLY_NAMES + '))=)[^&\\s"\'#<>]*', 'gi'), to: '$1' + R },
  // Spaced app passwords right after a password-ish name.
  { re: new RegExp('((?:password|passwd|passphrase|app[_-]?pass)[A-Za-z0-9_-]{0,20}["\']?\\s*[:=]\\s*)' + SPACED_APP_PASSWORD, 'gi'), to: '$1' + R },
  // name=value, name: value, "name":"value", name: 'value'
  { re: new RegExp('((?:' + SECRET_NAME_PARTS + ')[A-Za-z0-9_-]{0,30}["\']?\\s*[:=]\\s*)' + VALUE, 'gi'), to: '$1' + R },
  { re: new RegExp('(\\b(?:' + SHORT_NAMES + ')["\']?\\s*[:=]\\s*)' + VALUE, 'gi'), to: '$1' + R },
  // Anything long and opaque: 32+ hex (TMDB and similar keys), or 40+ URL-safe characters
  // that mix letters and digits (base64url tokens, HMACs, licence keys).
  { re: /\b[0-9a-fA-F]{32,}\b/g, to: R },
  { re: /\b(?=[A-Za-z0-9_-]{40,}\b)(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{40,}\b/g, to: R },
  // A licence-key-shaped group string: XXXX-XXXX-XXXX-XXXX with digits somewhere.
  { re: /\b(?=[A-Z0-9-]*\d)(?=[A-Z0-9-]*[A-Z])[A-Z0-9]{4,6}(?:-[A-Z0-9]{4,6}){3,5}\b/g, to: R },
  { re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, to: '<email>' }
]

// RFC 1918, loopback, link-local and CGNAT stay: they identify the household's own
// network, which is what a support person needs, and are not another person's address.
function isPrivateV4(a, b) {
  return a === 10 || a === 127 || a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
}

function redactIps(text) {
  let out = text.replace(/(?<![\w.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\w])(?!\.\d)/g, (m, a, b, c, d) => {
    const n = [a, b, c, d].map(Number)
    if (n.some((x) => x > 255)) return m
    return isPrivateV4(n[0], n[1]) ? m : '<ip>'
  })
  // Global IPv6 only: full form, or compressed with "::" between hex groups.
  out = out.replace(/(?<![\w:])(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}(?![\w:])|(?<![\w:])(?:[0-9a-f]{1,4}:){1,6}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,5})?(?![\w:])/gi, (m) => {
    const low = m.toLowerCase()
    if (/^(fe80|fc|fd|::1$)/.test(low)) return m
    return '<ip>'
  })
  return out
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

// The user's own name in a path is personal, and so is the machine name.
function redactUserPaths(text, literals) {
  let out = text
    .replace(/([A-Za-z]:[\\/]+Users[\\/]+)(?!<user>)[^\\/\s"'<>|:*?]+/gi, '$1<user>')
    .replace(/(\/(?:Users|home)\/)(?!<user>)[^/\s"'<>|:*?]+/g, '$1<user>')
  for (const lit of literals || []) {
    const s = String(lit || '')
    if (s.length >= 3) out = out.replace(new RegExp(escapeRe(s), 'gi'), '<user>')
  }
  return out
}

const MEDIA_EXT = 'mkv|mp4|avi|mov|wmv|m4v|webm|ts|m2ts|iso|mp3|flac|m4a|aac|ogg|opus|wav|jpg|jpeg|png|gif|heic|srt|vtt|ass|sub|nfo'
const PATHISH_QUERY = 'file|filename|path|dir|folder|name|title|q|query|show|movie|src|url|library'

// Library file names and folders: for diagnostics that leave the machine. Folder names
// have spaces ("Some Film (1999)"), so a path under a library root is removed up to the
// closing quote when it was quoted, and otherwise to the end of the line. A media file name
// takes up to eight words in front of it too, for the same reason.
function redactLibrary(text, roots) {
  let out = text
  for (const root of (roots || []).map((r) => String(r || '').trim()).filter((r) => r.length >= 3)) {
    const variants = new Set([root, root.replace(/\\/g, '/'), root.replace(/\//g, '\\')])
    for (const v of variants) {
      const re = escapeRe(v.replace(/[\\/]+$/, ''))
      out = out.replace(new RegExp('([\'"])' + re + '[^\'"\\r\\n]*', 'gi'), '$1<library-path>')
      out = out.replace(new RegExp(re + '[^\\r\\n]*', 'gi'), '<library-path>')
    }
  }
  out = out.replace(new RegExp('([?&](?:' + PATHISH_QUERY + ')=)[^&\\s"\'#<>]*', 'gi'), '$1' + R)
  out = out.replace(new RegExp('(?:[^\\s"\'\\\\/<>|:*?]+ ){0,8}[^\\s"\'\\\\/<>|:*?]+\\.(?:' + MEDIA_EXT + ')\\b', 'gi'), '<file>')
  return out
}

/**
 * @param {string} input
 * @param {{ ips?: boolean, literals?: string[], libraryRoots?: string[], files?: boolean, maxLine?: number }} [opts]
 *   ips: hide other people's (public) IP addresses. Default true.
 *   literals: exact strings to hide (user name, computer name).
 *   libraryRoots + files: also hide the user's library paths and media file names.
 */
function redact(input, opts) {
  const o = opts || {}
  let text = typeof input === 'string' ? input : String(input == null ? '' : input)
  const max = o.maxLine === undefined ? MAX_LINE : o.maxLine
  if (max && text.length > max) {
    text = text.split('\n').map((l) => (l.length > max ? l.slice(0, max) + ' ...[line truncated]' : l)).join('\n')
  }
  for (const rule of RULES) text = text.replace(rule.re, rule.to)
  if (o.ips !== false) text = redactIps(text)
  // Library roots first: they are matched as configured, which may include the user's name.
  if (o.libraryRoots || o.files) text = redactLibrary(text, o.libraryRoots)
  text = redactUserPaths(text, o.literals)
  return text
}

module.exports = { redact, redactIps, redactUserPaths, redactLibrary, MAX_LINE }
