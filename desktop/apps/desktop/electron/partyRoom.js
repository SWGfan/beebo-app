'use strict'
// Car watch-party helpers (security review F1, F2, F7).
//
// A party room is a short-lived, in-memory room the owner starts with their normal login. Guests
// have no account, so everything that stands between the internet and "stream what the host is
// playing" lives here:
//   - the room CODE is 8 characters from an unambiguous alphabet, drawn from the CSPRNG (it used to
//     be 4 digits from Math.random: 9000 guesses to get in);
//   - every room also has a JOIN KEY that only the host's link/QR carries, so the code alone
//     (which people read aloud in a car) is not enough to join;
//   - failed joins are counted per client address and lock that address out for a while;
//   - member ids and stream ids come from the CSPRNG too;
//   - free text (host name, guest names, the "now playing" title) is stripped of control characters,
//     capped, and HTML-escaped wherever it is echoed by the server.
const crypto = require('crypto')

// 31 characters: no 0/O, 1/I/L, no vowels-that-spell-words. 31^8 is about 8.5e11 codes.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
const CODE_LENGTH = 8
const KEY_LENGTH = 16 // base64url characters, 96 bits
const PARTY_IDLE_HOST_MS = 15 * 60 * 1000 // the host stopped reporting: the room closes
const PARTY_MAX_AGE_MS = 12 * 60 * 60 * 1000
const MAX_ROOMS = 200
const MAX_MEMBERS = 24
const JOIN_FAIL_MAX = 10
const JOIN_FAIL_WINDOW_MS = 15 * 60 * 1000

const hex = (n) => '\\u' + n.toString(16).padStart(4, '0')
const CONTROL_RE = new RegExp('[' + [[0, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2066, 0x2069], [0xfeff, 0xfeff]].map(([a, b]) => (a === b ? hex(a) : hex(a) + '-' + hex(b))).join('') + ']', 'g')

function randomChars(alphabet, length) {
  let out = ''
  for (let i = 0; i < length; i++) out += alphabet[crypto.randomInt(alphabet.length)]
  return out
}

/** A fresh room code that no live room has (or null after many collisions). */
function newCode(isTaken) {
  for (let i = 0; i < 60; i++) {
    const c = randomChars(CODE_ALPHABET, CODE_LENGTH)
    if (!isTaken || !isTaken(c)) return c
  }
  return null
}

function newJoinKey() {
  return crypto.randomBytes(12).toString('base64url') // 16 chars
}

function newMemberId() {
  return 'm_' + crypto.randomBytes(9).toString('base64url')
}

function newStreamId() {
  return 'np_' + crypto.randomBytes(6).toString('base64url')
}

/** What a typed/linked code becomes: upper-case, only alphabet characters, exactly CODE_LENGTH or ''. */
function normalizeCode(raw) {
  const s = String(raw == null ? '' : raw).toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (s.length !== CODE_LENGTH) return ''
  for (const ch of s) if (CODE_ALPHABET.indexOf(ch) === -1) return ''
  return s
}

function normalizeKey(raw) {
  const s = String(raw == null ? '' : raw)
  return /^[A-Za-z0-9_-]{16}$/.test(s) ? s : ''
}

/** Constant-time compare of the room's join key with what the guest sent. */
function keyMatches(room, given) {
  const k = normalizeKey(given)
  if (!room || !room.joinKey || !k) return false
  const a = crypto.createHash('sha256').update(String(room.joinKey)).digest()
  const b = crypto.createHash('sha256').update(k).digest()
  return crypto.timingSafeEqual(a, b)
}

/**
 * Free text from a person (host name, guest name, video title): control characters and the
 * Unicode line/paragraph separators removed, whitespace collapsed, capped at `max` characters.
 * Not HTML-escaped: escape at the point of output (escapeHtml) or use textContent.
 */
function cleanText(raw, max) {
  // `<` and `>` are dropped as well (nobody's name or a film title needs them), so even a client
  // that ignores the rule and writes these values into innerHTML gets no tag out of them.
  const s = String(raw == null ? '' : raw)
    .replace(/[<>]/g, '')
    // C0/C1 controls, DEL, bidi overrides/isolates, zero-width joiners, U+2028/2029, BOM
    .replace(CONTROL_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return Array.from(s).slice(0, Math.max(0, max | 0)).join('')
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]))
}

/** Room lifetime: closes when the host has gone quiet or the hard cap is reached. */
function isExpired(room, now = Date.now()) {
  if (!room) return true
  const hostSeen = room.hostSeen || room.createdAt || 0
  if (now - hostSeen > PARTY_IDLE_HOST_MS) return true
  if (now - (room.createdAt || 0) > PARTY_MAX_AGE_MS) return true
  return false
}

/**
 * The room registry: code -> room, one live room per owner, plus the join-failure limiter.
 * `pinLimiter` is parentalControls.createPinLimiter (same shape the API-key limiter uses).
 */
function createParty({ pinLimiter, now = () => Date.now() } = {}) {
  const rooms = new Map()
  const byOwner = new Map()
  const limiter = pinLimiter || require('./parentalControls').createPinLimiter({ max: JOIN_FAIL_MAX, windowMs: JOIN_FAIL_WINDOW_MS, now })

  function close(code) {
    const room = rooms.get(code)
    if (!room) return false
    rooms.delete(code)
    if (byOwner.get(room.ownerId) === code) byOwner.delete(room.ownerId)
    return true
  }
  function prune() {
    const t = now()
    for (const [code, room] of rooms) if (isExpired(room, t)) close(code)
  }
  function get(code) {
    prune()
    return rooms.get(code) || null
  }
  /** The owner's live room, or a new one. Returns { room, created } or null when full/unlucky. */
  function startFor(ownerId, hostName) {
    prune()
    const existing = byOwner.get(ownerId)
    let room = existing ? rooms.get(existing) : null
    if (room) {
      room.hostName = hostName
      for (const m of room.members.values()) if (m.host) m.name = hostName
      room.hostSeen = now()
      return { room, created: false }
    }
    if (rooms.size >= MAX_ROOMS) return null
    const code = newCode((c) => rooms.has(c))
    if (!code) return null
    const t = now()
    room = { code, joinKey: newJoinKey(), ownerId, hostName, members: new Map(), createdAt: t, lastSeen: t, hostSeen: t }
    room.members.set('h_' + ownerId, { name: hostName, host: true, joinedAt: t })
    rooms.set(code, room)
    byOwner.set(ownerId, code)
    return { room, created: true }
  }
  function addGuest(room, name) {
    if (room.members.size >= MAX_MEMBERS) return null
    const memberId = newMemberId()
    room.members.set(memberId, { name, host: false, joinedAt: now() })
    room.lastSeen = now()
    return memberId
  }
  return {
    rooms, byOwner, limiter, get, close, prune, startFor, addGuest,
    closeForOwner(ownerId) { const c = byOwner.get(ownerId); return c ? close(c) : false },
    /** minutes remaining if this client is locked out, else 0 */
    locked(ip) { return limiter.locked('party:' + ip) },
    // A success deliberately does NOT clear the count: otherwise 9 guesses + one join of the
    // attacker's own room would reset the lockout forever.
    fail(ip) { limiter.fail('party:' + ip) }
  }
}

module.exports = {
  CODE_ALPHABET, CODE_LENGTH, KEY_LENGTH, MAX_MEMBERS, MAX_ROOMS, PARTY_IDLE_HOST_MS, PARTY_MAX_AGE_MS,
  newCode, newJoinKey, newMemberId, newStreamId, normalizeCode, normalizeKey, keyMatches,
  cleanText, escapeHtml, isExpired, createParty
}
