'use strict'
// Personal API keys for outside tools (Tautulli-style dashboards, Home Assistant, scripts).
//
// A key is `beebo_pat_<id>_<secret>`. The store keeps the id (a lookup handle, not a secret) and a
// SHA-256 of the secret; the plaintext is returned once, by create(), and never again. The secret is
// 256 random bits, so a fast hash is enough: there is no low-entropy input to slow-hash.
//
// Unlike the account bearer token (streamServer.js makeApiToken, one HMAC secret for everyone),
// each key is its own row: it carries its own scopes, can be deleted on its own, and has its own
// request budget. A key only ever authenticates /api/v1/* (publicApi.js); nothing here grants a
// route, it only says who is asking and for what.

const crypto = require('crypto')
const publicApi = require('./publicApi')
const parental = require('./parentalControls')
const titleRequests = require('./titleRequests')

const PREFIX = 'beebo_pat_'
const STORE_KEY = 'apiKeys'
const TOKEN_RE = /^beebo_pat_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/

// Per person: an admin may hold 25, anyone else 10. MAX_KEYS_TOTAL bounds the whole server.
const MAX_KEYS = 25
const MAX_KEYS_MEMBER = 10
const MAX_KEYS_TOTAL = 500
const NAME_MAX = 60
// Read-only by default: a new key sees the library and nothing about who watches what.
const DEFAULT_SCOPES = Object.freeze(['library'])
// What a person who is not an admin may put on their own key: their library and their own history.
// Who is watching what, and the server's metrics, are the owner's.
const MEMBER_SCOPES = Object.freeze(['library', 'history'])
const DEFAULT_RATE_PER_MINUTE = 120
const RATE_MIN = 10
const RATE_MAX = 1200

// Failed key attempts per address: the same shape as the parental PIN limiter (locks after N misses
// in a window, ages out by itself), and an address auth.checkLockout already locked is refused too.
const FAIL_MAX = 10
const FAIL_WINDOW_MS = 15 * 60 * 1000
const TOUCH_EVERY_MS = 60 * 1000

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex')

function rows(store) {
  try {
    const all = store.get(STORE_KEY)
    return Array.isArray(all) ? all.filter((r) => r && typeof r === 'object' && r.id && r.hash) : []
  } catch {
    return []
  }
}

// Everything a screen or a response may show about a key. Never the hash, never the secret.
function shape(row) {
  return {
    id: row.id,
    name: row.name,
    hint: `${PREFIX}${row.id}_…`,
    scopes: Array.isArray(row.scopes) ? row.scopes.slice() : [],
    ratePerMinute: row.ratePerMinute || DEFAULT_RATE_PER_MINUTE,
    ownerUserId: row.ownerUserId || null,
    createdAt: row.createdAt || null,
    lastUsedAt: row.lastUsedAt || null
  }
}

function looksLikeKey(token) {
  return typeof token === 'string' && token.startsWith(PREFIX)
}

function parse(token) {
  const m = typeof token === 'string' ? TOKEN_RE.exec(token) : null
  return m ? { id: m[1], secret: m[2] } : null
}

// `allowed` is what the person making the key may grant (scopesFor). A scope outside it, even a real
// one, is refused rather than quietly dropped, so nobody ends up holding a key that is weaker than
// they were told.
function cleanScopes(raw, allowed = publicApi.SCOPES) {
  if (raw === undefined || raw === null) return { ok: true, scopes: DEFAULT_SCOPES.filter((s) => allowed.includes(s)) }
  if (!Array.isArray(raw)) return { ok: false, error: 'bad_key_scope' }
  const want = new Set(raw.map((s) => String(s)))
  for (const s of want) if (!publicApi.SCOPES.includes(s)) return { ok: false, error: 'bad_key_scope' }
  for (const s of want) if (!allowed.includes(s)) return { ok: false, error: 'scope_not_allowed', scope: s }
  const scopes = publicApi.SCOPES.filter((s) => want.has(s))
  return scopes.length ? { ok: true, scopes } : { ok: false, error: 'bad_key_scope' }
}

// What a person may hold on a key today: an approved admin gets every scope, anyone else the member
// list. Checked again on every request, so a key never outlives the rights of the person who made it.
function scopesFor(user) {
  return user && user.isAdmin === true ? publicApi.SCOPES.slice() : MEMBER_SCOPES.slice()
}

function create(store, { name, scopes, ratePerMinute, ownerUserId, allowedScopes, maxForOwner, now = Date.now() } = {}) {
  const label = String(name === undefined || name === null ? '' : name).replace(/\s+/g, ' ').trim()
  if (!label || label.length > NAME_MAX) return { ok: false, error: 'bad_name' }
  const s = cleanScopes(scopes, Array.isArray(allowedScopes) ? allowedScopes : publicApi.SCOPES)
  if (!s.ok) return { ok: false, error: s.error, ...(s.scope ? { scope: s.scope } : {}) }
  let rate = DEFAULT_RATE_PER_MINUTE
  if (ratePerMinute !== undefined && ratePerMinute !== null && ratePerMinute !== '') {
    rate = Number(ratePerMinute)
    if (!Number.isInteger(rate) || rate < RATE_MIN || rate > RATE_MAX) return { ok: false, error: 'bad_rate' }
  }
  if (!ownerUserId) return { ok: false, error: 'bad_owner' }
  const existing = rows(store)
  const cap = Number.isInteger(maxForOwner) && maxForOwner > 0 ? maxForOwner : MAX_KEYS
  if (existing.length >= MAX_KEYS_TOTAL || existing.filter((r) => r.ownerUserId === ownerUserId).length >= cap) return { ok: false, error: 'too_many_keys' }
  const id = crypto.randomBytes(6).toString('hex')
  const secret = crypto.randomBytes(32).toString('base64url')
  const row = { id, name: label, hash: sha256(secret), scopes: s.scopes, ratePerMinute: rate, ownerUserId, createdAt: now, lastUsedAt: null }
  store.set(STORE_KEY, [...existing, row])
  return { ok: true, key: shape(row), token: `${PREFIX}${id}_${secret}` }
}

// Everyone's keys (the owner's view), or just one person's.
function list(store, { ownerUserId } = {}) {
  return rows(store)
    .filter((r) => !ownerUserId || r.ownerUserId === ownerUserId)
    .map(shape)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
}

// Deleting the row is the revocation: the next request finds nothing to match. With `ownerUserId`
// only that person's own keys can be removed; someone else's is "not found", not "forbidden", so a
// member cannot even learn which key ids exist.
function revoke(store, id, { ownerUserId } = {}) {
  const all = rows(store)
  const hit = all.find((r) => r.id === String(id || '') && (!ownerUserId || r.ownerUserId === ownerUserId))
  if (!hit) return { ok: false, error: 'not_found' }
  store.set(STORE_KEY, all.filter((r) => r !== hit))
  return { ok: true, key: shape(hit) }
}

function removeOwnedBy(store, userId) {
  const all = rows(store)
  const keep = all.filter((r) => r.ownerUserId !== userId)
  if (keep.length !== all.length) store.set(STORE_KEY, keep)
  return all.length - keep.length
}

const DUMMY_HASH = sha256('beebo-dummy-key-so-a-miss-costs-what-a-hit-does')

// { ok: true, key } for a live key, else { ok: false, reason }. The reason is for the caller's
// bookkeeping only; every failure is the same 401 on the wire.
function verify(store, token) {
  const parsed = parse(token)
  if (!parsed) return { ok: false, reason: 'malformed' }
  const row = rows(store).find((r) => r.id === parsed.id) || null
  const want = Buffer.from(row ? row.hash : DUMMY_HASH, 'hex')
  const got = Buffer.from(sha256(parsed.secret), 'hex')
  const same = want.length === got.length && crypto.timingSafeEqual(want, got)
  if (!row) return { ok: false, reason: 'unknown' }
  if (!same) return { ok: false, reason: 'bad_secret' }
  return { ok: true, key: row }
}

// The only thing recorded about a key's use: when it was last seen. Written at most once a minute
// so a busy dashboard does not rewrite the settings file on every poll.
const lastTouched = new Map()
function touch(store, id, now = Date.now()) {
  if (now - (lastTouched.get(id) || 0) < TOUCH_EVERY_MS) return false
  lastTouched.set(id, now)
  if (lastTouched.size > 500) lastTouched.delete(lastTouched.keys().next().value)
  const all = rows(store)
  if (!all.some((r) => r.id === id)) return false
  store.set(STORE_KEY, all.map((r) => (r.id === id ? { ...r, lastUsedAt: now } : r)))
  return true
}

// In-memory, per server: a restart forgives everyone, which is fine for a rate limit.
function createGuard({ now = () => Date.now() } = {}) {
  const budgets = new Map()
  let failureCount = 0
  const failures = parental.createPinLimiter({ max: FAIL_MAX, windowMs: FAIL_WINDOW_MS, now })
  const budgetFor = (perMinute) => {
    let limiter = budgets.get(perMinute)
    if (!limiter) {
      limiter = titleRequests.createRateLimiter({ limit: perMinute, windowMs: 60 * 1000, now })
      budgets.set(perMinute, limiter)
    }
    return limiter
  }
  return {
    // Minutes left on this address's lock, 0 when it is free to try.
    lockedMinutes: (ip) => failures.locked('key-ip:' + (ip || 'unknown')),
    noteFailure: (ip) => { failureCount++; return failures.fail('key-ip:' + (ip || 'unknown')) },
    // Wrong-key attempts since the server started (for /metrics).
    failureCount: () => failureCount,
    // A key's own request budget: { ok } or { ok: false, retryAfterSeconds }.
    hit: (key) => budgetFor(key.ratePerMinute || DEFAULT_RATE_PER_MINUTE).hit(key.id),
    reset: () => { budgets.clear() }
  }
}

module.exports = {
  PREFIX,
  MAX_KEYS,
  MAX_KEYS_MEMBER,
  MAX_KEYS_TOTAL,
  DEFAULT_SCOPES,
  MEMBER_SCOPES,
  scopesFor,
  DEFAULT_RATE_PER_MINUTE,
  RATE_MIN,
  RATE_MAX,
  FAIL_MAX,
  looksLikeKey,
  parse,
  create,
  list,
  revoke,
  removeOwnedBy,
  verify,
  touch,
  createGuard
}
