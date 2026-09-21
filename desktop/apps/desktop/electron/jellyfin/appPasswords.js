'use strict'
// Per-app passwords for the Jellyfin-compatible mode.
//
// A person with two-factor on cannot use the Jellyfin-style "username + password" sign-in: those apps have no
// place to type a second code, and Beebo will not let a password alone be a sign-in. What they can do instead is
// have the owner make an "app password" for one app (label: "Living room Apple TV"). It is:
//   - 16 random characters in four groups (80 bits), shown ONCE when it is made; only a SHA-256 is kept;
//   - good for signing in through the Jellyfin-compatible routes ONLY (never Beebo's website or /api);
//   - one per app, so it can be deleted on its own, and every sign-in it makes is a normal tracked session
//     (listed and revocable like any other);
//   - throttled per address and per person, and an address Beebo already locked out is refused too.
// It is never accepted in place of the real password anywhere else.

const crypto = require('crypto')

const STORE_KEY = 'jellyfinAppPasswords'
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no 0/O/1/I
const PATTERN = /^[A-HJ-NP-Z2-9]{4}(-?[A-HJ-NP-Z2-9]{4}){3}$/i
const MAX_PER_USER = 20
const MAX_TOTAL = 400
const LABEL_MAX = 60
const FAIL_MAX = 8
const FAIL_WINDOW_MS = 15 * 60 * 1000
const TOUCH_EVERY_MS = 60 * 1000

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex')
const canon = (secret) => String(secret || '').toUpperCase().replace(/[^A-Z0-9]/g, '')

function looksLikeAppPassword(pw) {
  return typeof pw === 'string' && PATTERN.test(pw.trim())
}

function makeSecret() {
  let raw = ''
  for (let i = 0; i < 16; i++) raw += ALPHABET[crypto.randomInt(0, ALPHABET.length)]
  return raw.match(/.{4}/g).join('-')
}

function createAppPasswords({ store, now = Date.now }) {
  const failsByIp = new Map()
  const failsByUser = new Map()
  let lastTouchWrite = 0

  function rows() {
    try {
      const all = store.get(STORE_KEY)
      return Array.isArray(all) ? all.filter((r) => r && typeof r === 'object' && r.id && r.hash && r.userId) : []
    } catch { return [] }
  }
  const save = (list) => store.set(STORE_KEY, list)

  const shape = (r) => ({ id: r.id, userId: r.userId, label: r.label, createdAt: r.createdAt, lastUsedAt: r.lastUsedAt || 0 })

  function list(userId) {
    return rows().filter((r) => !userId || r.userId === userId).map(shape).sort((a, b) => b.createdAt - a.createdAt)
  }

  function create(userId, label) {
    const name = String(label || '').replace(/\p{Cc}/gu, ' ').trim().slice(0, LABEL_MAX)
    if (!userId) return { ok: false, error: 'no_user' }
    if (!name) return { ok: false, error: 'name_required' }
    const all = rows()
    if (all.length >= MAX_TOTAL) return { ok: false, error: 'too_many' }
    if (all.filter((r) => r.userId === userId).length >= MAX_PER_USER) return { ok: false, error: 'too_many_for_person' }
    const secret = makeSecret()
    const row = { id: crypto.randomBytes(6).toString('hex'), userId, label: name, hash: sha256(canon(secret)), createdAt: now(), lastUsedAt: 0 }
    all.push(row)
    save(all)
    return { ok: true, secret, item: shape(row) }
  }

  function remove(id) {
    const all = rows()
    const next = all.filter((r) => r.id !== String(id))
    if (next.length === all.length) return { ok: false, error: 'not_found' }
    save(next)
    return { ok: true }
  }

  function removeForUser(userId) {
    const all = rows()
    const next = all.filter((r) => r.userId !== userId)
    if (next.length !== all.length) save(next)
    return all.length - next.length
  }

  const recent = (map, key) => {
    const t = now()
    const hits = (map.get(key) || []).filter((x) => t - x < FAIL_WINDOW_MS)
    map.set(key, hits)
    if (map.size > 2000) map.delete(map.keys().next().value)
    return hits
  }
  const limited = (ip, username) => recent(failsByIp, ip || '?').length >= FAIL_MAX || recent(failsByUser, String(username || '').toLowerCase()).length >= FAIL_MAX

  // Check `secret` against this person's app passwords. Never says which part was wrong.
  // Returns { ok: true, row } | { ok: false, limited?: true }
  function verify({ userId, username, ip, secret }) {
    if (limited(ip, username)) return { ok: false, limited: true }
    const want = sha256(canon(secret))
    const expected = Buffer.from(want)
    let hit = null
    for (const r of rows()) {
      if (r.userId !== userId) continue
      const a = Buffer.from(r.hash)
      if (a.length === expected.length && crypto.timingSafeEqual(a, expected)) hit = r
    }
    if (!hit) {
      recent(failsByIp, ip || '?').push(now())
      recent(failsByUser, String(username || '').toLowerCase()).push(now())
      return { ok: false }
    }
    const t = now()
    if (t - lastTouchWrite > TOUCH_EVERY_MS || !hit.lastUsedAt || t - hit.lastUsedAt > TOUCH_EVERY_MS) {
      lastTouchWrite = t
      try { save(rows().map((r) => (r.id === hit.id ? { ...r, lastUsedAt: t } : r))) } catch {}
    }
    return { ok: true, row: hit }
  }

  return { list, create, remove, removeForUser, verify, looksLikeAppPassword, count: () => rows().length }
}

module.exports = { createAppPasswords, looksLikeAppPassword, makeSecret, PATTERN }
