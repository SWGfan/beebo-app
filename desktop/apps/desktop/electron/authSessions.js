'use strict'
// ============================================================================
// authSessions.js - the list of signed-in devices, and the power to end them.
// ----------------------------------------------------------------------------
// Cookies and app tokens are still signed with the server secret and need no lookup
// to be believed (auth.signSession / streamServer.makeApiToken). What this adds is a
// record per sign-in, so a person can see "Chrome on Windows, last seen 3 minutes ago",
// end one of them, or end everything:
//
//   - a new cookie/token carries a random session id (sid). The server keeps only a
//     SHA-256 of it, plus when, where from, what device and how they signed in.
//     A sid whose record was removed no longer works, even though its signature is fine.
//   - "sign out everywhere" also sets a per-person cut-off time. Cookies and tokens made
//     BEFORE the previous format (no sid) and tokens issued without a record fall on the
//     wrong side of it and stop working too, so nothing minted earlier can outlive it.
//   - sessions the desktop app mints for its own windows (method 'desktop') are trusted
//     local windows and are neither listed nor revoked; they are made fresh on demand.
//
// Only the last IP is kept, with the final part masked (see securityLog.maskIp), and a
// short device label taken from the User-Agent rather than the raw header.
// ============================================================================
const crypto = require('crypto')
const { maskIp } = require('./securityLog')

const KEY = 'authSessions'
const EPOCH_KEY = 'authSessionEpochs'
const MAX_PER_USER = 50
const PERSIST_TOUCH_MS = 5 * 60 * 1000
const TOUCH_MS = 30 * 1000
const DAY = 24 * 60 * 60 * 1000

let generation = 0
const states = new WeakMap()

function hashSid(sid) {
  return crypto.createHash('sha256').update(String(sid)).digest('hex')
}

function stateFor(store) {
  let st = states.get(store)
  if (st && st.gen === generation) return st
  const records = new Map()
  let epochs = {}
  try {
    const saved = store.get(KEY)
    if (Array.isArray(saved)) for (const r of saved) if (r && typeof r.h === 'string' && r.userId) records.set(r.h, { ...r })
    const e = store.get(EPOCH_KEY)
    if (e && typeof e === 'object') epochs = { ...e }
  } catch {}
  st = { gen: generation, records, epochs, persistedAt: 0 }
  states.set(store, st)
  return st
}

// Forget everything held in memory; the next call re-reads the store (after a restore).
function reset() {
  generation += 1
}

function persist(store, st) {
  const now = Date.now()
  for (const [h, r] of st.records) if (r.expiresAt && r.expiresAt < now) st.records.delete(h)
  store.set(KEY, [...st.records.values()])
  store.set(EPOCH_KEY, st.epochs)
  st.persistedAt = now
}

function newSid() {
  return crypto.randomBytes(16).toString('base64url')
}

// "Chrome on Windows" from a User-Agent. Deliberately coarse; the raw header is not kept.
function deviceLabel(userAgent) {
  const ua = String(userAgent || '').slice(0, 400)
  if (!ua) return 'Unknown device'
  if (/BeeboApp|okhttp|Dalvik/i.test(ua)) return /iPhone|iPad|iOS/i.test(ua) ? 'Beebo app on iOS' : 'Beebo app on Android'
  let browser = 'Browser'
  if (/Edg(?:e|A|iOS)?\//.test(ua)) browser = 'Edge'
  else if (/OPR\/|Opera/.test(ua)) browser = 'Opera'
  else if (/Firefox\/|FxiOS/.test(ua)) browser = 'Firefox'
  else if (/Chrome\/|CriOS/.test(ua)) browser = 'Chrome'
  else if (/Safari\//.test(ua)) browser = 'Safari'
  else if (/curl|node|python|axios|fetch|undici/i.test(ua)) browser = 'Script'
  let os = ''
  if (/Windows/.test(ua)) os = 'Windows'
  else if (/Android/.test(ua)) os = 'Android'
  else if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS'
  else if (/Mac OS X|Macintosh/.test(ua)) os = 'macOS'
  else if (/CrOS/.test(ua)) os = 'ChromeOS'
  else if (/Linux|X11/.test(ua)) os = 'Linux'
  return os ? `${browser} on ${os}` : browser
}

/**
 * Make a record and return the session id the cookie/token must carry.
 * opts: { ip, userAgent, method, kind ('web' | 'app'), days }
 */
function create(store, userId, { ip, userAgent, method = 'password', kind = 'web', days = 365, now = Date.now() } = {}) {
  const st = stateFor(store)
  const sid = newSid()
  const h = hashSid(sid)
  st.records.set(h, {
    h,
    userId: String(userId),
    createdAt: now,
    lastSeenAt: now,
    expiresAt: now + days * DAY,
    ip: maskIp(ip),
    device: deviceLabel(userAgent),
    method: String(method).slice(0, 20),
    kind: kind === 'app' ? 'app' : 'web'
  })
  // Keep each person to their newest MAX_PER_USER sessions.
  const mine = [...st.records.values()].filter((r) => r.userId === String(userId)).sort((a, b) => a.createdAt - b.createdAt)
  while (mine.length > MAX_PER_USER) st.records.delete(mine.shift().h)
  persist(store, st)
  return { sid, handle: h.slice(0, 12) }
}

/** Is this sid a live session for this person? Refreshes last-seen (throttled, in memory). */
function check(store, userId, sid, now = Date.now()) {
  if (!sid || typeof sid !== 'string') return false
  const st = stateFor(store)
  const r = st.records.get(hashSid(sid))
  if (!r || r.userId !== String(userId)) return false
  if (r.expiresAt && now > r.expiresAt) return false
  if (now - r.lastSeenAt >= TOUCH_MS) {
    r.lastSeenAt = now
    if (now - st.persistedAt >= PERSIST_TOUCH_MS) {
      try { persist(store, st) } catch {}
    }
  }
  return true
}

/** Note the address a session is currently using (only writes memory; persisted with the next change). */
function noteIp(store, sid, ip) {
  if (!sid) return
  const r = stateFor(store).records.get(hashSid(sid))
  if (r) {
    const masked = maskIp(ip)
    if (masked) r.ip = masked
  }
}

/** Signed before this person's cut-off? (cookies and tokens without a session record) */
function issuedBeforeCutoff(store, userId, issuedAt) {
  const cut = Number(stateFor(store).epochs[userId]) || 0
  return cut > 0 && issuedAt < cut
}

/** The person's sessions, newest activity first. currentSid marks "this device". */
function list(store, userId, { currentSid } = {}) {
  const st = stateFor(store)
  const now = Date.now()
  const currentHash = currentSid ? hashSid(currentSid) : null
  return [...st.records.values()]
    .filter((r) => r.userId === String(userId) && (!r.expiresAt || r.expiresAt > now))
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .map((r) => ({
      id: r.h.slice(0, 12),
      device: r.device,
      kind: r.kind,
      method: r.method,
      ip: r.ip,
      createdAt: r.createdAt,
      lastSeenAt: r.lastSeenAt,
      expiresAt: r.expiresAt,
      current: r.h === currentHash
    }))
}

/** End one session by the id list() gave out. Only that person's own records can match. */
function revoke(store, userId, handle) {
  const st = stateFor(store)
  const prefix = String(handle || '')
  if (!/^[0-9a-f]{12}$/.test(prefix)) return { ok: false, error: 'not_found' }
  const hit = [...st.records.values()].find((r) => r.userId === String(userId) && r.h.startsWith(prefix))
  if (!hit) return { ok: false, error: 'not_found' }
  st.records.delete(hit.h)
  persist(store, st)
  return { ok: true, device: hit.device }
}

/**
 * Sign the person out everywhere: every record goes (except exceptSid), and anything minted
 * without a record before this moment stops working. Returns how many listed devices ended.
 */
function revokeAll(store, userId, { exceptSid, now = Date.now() } = {}) {
  const st = stateFor(store)
  const keep = exceptSid ? hashSid(exceptSid) : null
  let ended = 0
  for (const [h, r] of st.records) {
    if (r.userId !== String(userId) || h === keep) continue
    st.records.delete(h)
    ended += 1
  }
  st.epochs[userId] = now
  persist(store, st)
  return { ok: true, ended }
}

/** Drop everything held for a person who no longer exists. */
function forgetUser(store, userId) {
  const st = stateFor(store)
  for (const [h, r] of st.records) if (r.userId === String(userId)) st.records.delete(h)
  delete st.epochs[userId]
  persist(store, st)
}

function flush(store) {
  const st = states.get(store)
  if (st && st.gen === generation) {
    try { persist(store, st) } catch {}
  }
}

module.exports = { create, check, noteIp, issuedBeforeCutoff, list, revoke, revokeAll, forgetUser, flush, reset, deviceLabel, hashSid, MAX_PER_USER }
