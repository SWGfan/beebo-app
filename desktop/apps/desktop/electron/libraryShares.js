'use strict'
/*
 * Sharing this library with another household (the home server's half).
 *
 * Guardrails, in the order a share goes through them (docs/LIBRARY-SHARING-POLICY.md):
 *   - Invite only, to one named person (an email address). No links anyone can open, no
 *     directory, no search: nobody can find a library that wasn't shared with them.
 *   - The owner confirms, per share, that they own or have the rights to share the media
 *     with that person. The statement, its terms version, who confirmed and when are kept
 *     on the share (the consent record).
 *   - Scope: which libraries (films, TV), optionally which folders and which collections;
 *     parental limits; an optional expiry; how many streams at once; downloads on or off.
 *   - Revoke takes effect on this computer at once (every request re-reads the share), and
 *     is pushed to beebo.tv so the guest can't sign in to the door either.
 *
 * Stored under 'libraryShares' -> [share]. The guest never gets an account on this computer:
 * they get a share token (sh1.<shareId>.<exp>.<sig>) that only opens this share.
 *
 * The Worker's half is worker/shares.js. The filter that applies a share's scope to every
 * route is electron/contentGate.js.
 */

const crypto = require('crypto')
const parental = require('./parentalControls')

const SHARE_TERMS_VERSION = '2026-09-17'
const SHARE_CONSENT_STATEMENT = 'I own or have the rights to share this media with the people I invite, and I will not share it publicly or for money.'
const MAX_ACTIVE_SHARES = 20
const MAX_STREAMS_CAP = 5
const SHARE_TOKEN_DAYS = 30
const SHARE_ID_RE = /^sh_[a-f0-9]{16}$/
const EMAIL_RE = /^[^\s@,;<>"]{1,64}@[^\s@,;<>"]{1,190}\.[a-z]{2,24}$/i

function normEmail(e) {
  return String(e || '').trim().toLowerCase()
}

function readAll(store) {
  try {
    const v = store.get('libraryShares')
    return Array.isArray(v) ? v.filter((s) => s && SHARE_ID_RE.test(String(s.id || ''))) : []
  } catch {
    return []
  }
}

function writeAll(store, list) {
  store.set('libraryShares', list)
}

function list(store) {
  return readAll(store)
}

function get(store, id) {
  return readAll(store).find((s) => s.id === id) || null
}

function isLive(share, nowMs = Date.now()) {
  if (!share) return false
  if (share.status !== 'active' && share.status !== 'pending') return false
  return !(share.expiresAt && Number(share.expiresAt) <= nowMs)
}

/** Validates the owner's form. -> { ok: true, scope } | { ok: false, error } */
function cleanScope(input = {}) {
  const libs = Array.isArray(input.libraries) ? input.libraries.filter((l) => l === 'movies' || l === 'tv') : ['movies', 'tv']
  if (!libs.length) return { ok: false, error: 'no_libraries' }
  const folders = (Array.isArray(input.folders) ? input.folders : []).map(String).filter((f) => f && f.length < 1024).slice(0, 50)
  const collections = [...new Set((Array.isArray(input.collections) ? input.collections : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 200)
  let expiresAt = null
  if (input.expiresAt !== undefined && input.expiresAt !== null && input.expiresAt !== '') {
    const t = typeof input.expiresAt === 'number' ? input.expiresAt : Date.parse(String(input.expiresAt))
    if (!Number.isFinite(t)) return { ok: false, error: 'bad_expiry' }
    expiresAt = t
  }
  const ms = Number(input.maxStreams)
  const maxStreams = Number.isInteger(ms) && ms >= 1 ? Math.min(MAX_STREAMS_CAP, ms) : 1
  const parentalInput = input.parental && typeof input.parental === 'object'
    ? input.parental
    : typeof input.parentalPreset === 'string' ? parental.presetPolicy(input.parentalPreset) : null
  return {
    ok: true,
    scope: {
      libraries: libs,
      folders,
      collections,
      expiresAt,
      maxStreams,
      downloads: input.downloads === true,
      parental: parental.normalizePolicy(parentalInput),
    },
  }
}

/**
 * Create a share. The consent must be given explicitly for the current terms version.
 * -> { ok: true, share } | { ok: false, error }
 */
function create(store, { guestEmail, guestLabel, ownerUserId, consent, scope: scopeInput, now = Date.now() } = {}) {
  const email = normEmail(guestEmail)
  if (!EMAIL_RE.test(email)) return { ok: false, error: 'bad_email' }
  if (!consent || consent.accepted !== true) return { ok: false, error: 'consent_required' }
  if (consent.termsVersion !== SHARE_TERMS_VERSION) return { ok: false, error: 'terms_changed', termsVersion: SHARE_TERMS_VERSION }
  const cleaned = cleanScope(scopeInput || {})
  if (!cleaned.ok) return cleaned
  if (cleaned.scope.expiresAt && cleaned.scope.expiresAt <= now) return { ok: false, error: 'bad_expiry' }
  const all = readAll(store)
  if (all.filter((s) => isLive(s, now)).length >= MAX_ACTIVE_SHARES) return { ok: false, error: 'too_many_shares', max: MAX_ACTIVE_SHARES }
  if (all.some((s) => isLive(s, now) && s.guestEmail === email)) return { ok: false, error: 'already_shared' }
  const share = {
    id: 'sh_' + crypto.randomBytes(8).toString('hex'),
    guestEmail: email,
    guestLabel: String(guestLabel || '').trim().slice(0, 60) || email.split('@')[0],
    status: 'pending',
    createdAt: now,
    acceptedAt: null,
    revokedAt: null,
    ...cleaned.scope,
    consent: {
      statement: SHARE_CONSENT_STATEMENT,
      termsVersion: SHARE_TERMS_VERSION,
      acceptedAt: now,
      ownerUserId: String(ownerUserId || ''),
    },
  }
  writeAll(store, [...all, share])
  return { ok: true, share }
}

/** Change what an existing share covers (not who, and not the consent record). */
function update(store, id, scopeInput) {
  const all = readAll(store)
  const i = all.findIndex((s) => s.id === id)
  if (i < 0) return { ok: false, error: 'not_found' }
  if (!isLive(all[i])) return { ok: false, error: 'share_ended' }
  const base = { ...all[i] }
  // A preset named in the change replaces the saved parental policy.
  if (scopeInput && typeof scopeInput.parentalPreset === 'string' && !(scopeInput.parental && typeof scopeInput.parental === 'object')) delete base.parental
  const cleaned = cleanScope({ ...base, ...scopeInput })
  if (!cleaned.ok) return cleaned
  const next = { ...all[i], ...cleaned.scope, updatedAt: Date.now() }
  all[i] = next
  writeAll(store, all)
  return { ok: true, share: next }
}

/** Immediate on this computer. The guest's viewing history here goes with it. */
function revoke(store, id, { now = Date.now(), by = 'owner' } = {}) {
  const all = readAll(store)
  const i = all.findIndex((s) => s.id === id)
  if (i < 0) return { ok: false, error: 'not_found' }
  all[i] = { ...all[i], status: by === 'guest' ? 'left' : 'revoked', revokedAt: now, inviteCode: null }
  writeAll(store, all)
  return { ok: true, share: all[i] }
}

/** The guest's personal rows on this computer (history, watchlist, flags, usage). */
function purgeGuestData(store, id, history) {
  const key = 'share:' + id
  try { if (history && history.clearAllHistory) history.clearAllHistory(store, key) } catch {}
  for (const k of ['watchlist', 'libraryFlags', 'parentalUsage']) {
    try {
      const m = store.get(k)
      if (m && typeof m === 'object' && !Array.isArray(m) && key in m) {
        const next = { ...m }
        delete next[key]
        store.set(k, next)
      }
    } catch {}
  }
}

/** Remove ended shares (revoked, left, expired) older than 30 days. The consent record goes too. */
function prune(store, { now = Date.now(), keepMs = 30 * 86400 * 1000 } = {}) {
  const all = readAll(store)
  const keep = all.filter((s) => isLive(s, now) || (Number(s.revokedAt || s.expiresAt || s.createdAt) || 0) > now - keepMs)
  if (keep.length !== all.length) writeAll(store, keep)
  return all.length - keep.length
}

/** The guest's first sign-in through beebo.tv proves they accepted: pending becomes active. */
function markAccepted(store, id, now = Date.now()) {
  const all = readAll(store)
  const i = all.findIndex((s) => s.id === id)
  if (i < 0 || all[i].status !== 'pending') return
  all[i] = { ...all[i], status: 'active', acceptedAt: now, inviteCode: null }
  writeAll(store, all)
}

// ---- share tokens -----------------------------------------------------------

function makeShareToken(secret, share, nowMs = Date.now()) {
  let exp = nowMs + SHARE_TOKEN_DAYS * 86400 * 1000
  if (share.expiresAt) exp = Math.min(exp, Number(share.expiresAt))
  const sig = crypto.createHmac('sha256', secret).update(`share|${share.id}|${exp}`).digest('base64url')
  return `sh1.${share.id}.${exp}.${sig}`
}

/** -> shareId or null. The caller still checks the share is live (revoke is immediate). */
function verifyShareToken(secret, token, nowMs = Date.now()) {
  const m = /^sh1\.(sh_[a-f0-9]{16})\.(\d{10,16})\.([A-Za-z0-9_-]{20,100})$/.exec(String(token || ''))
  if (!m) return null
  const exp = Number(m[2])
  if (!Number.isFinite(exp) || exp <= nowMs) return null
  const want = crypto.createHmac('sha256', secret).update(`share|${m[1]}|${exp}`).digest('base64url')
  const a = Buffer.from(m[3])
  const b = Buffer.from(want)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  return m[1]
}

// ---- streams at once ----------------------------------------------------------

/**
 * Counts distinct titles a share is streaming. A player opens several range requests for one
 * title, so it is titles (media ids) that count, each alive for `idleMs` after its last request.
 */
function createStreamLimiter({ idleMs = 45000, now = () => Date.now() } = {}) {
  const active = new Map() // shareId -> Map(mediaId -> lastAt)
  return {
    admit(shareId, mediaId, max) {
      const t = now()
      const m = active.get(shareId) || new Map()
      for (const [k, at] of m) if (t - at > idleMs) m.delete(k)
      if (!m.has(mediaId) && m.size >= Math.max(1, Number(max) || 1)) {
        active.set(shareId, m)
        return false
      }
      m.set(mediaId, t)
      active.set(shareId, m)
      return true
    },
    count(shareId) {
      const m = active.get(shareId)
      if (!m) return 0
      const t = now()
      return [...m.values()].filter((at) => t - at <= idleMs).length
    },
  }
}

// ---- beebo.tv sync ----------------------------------------------------------

/** What the Worker needs: who, which house, status, expiry and the consent record. No scope, no titles. */
function workerView(share) {
  return {
    shareId: share.id,
    guestEmail: share.guestEmail,
    status: share.status === 'active' || share.status === 'pending' ? share.status : 'revoked',
    expiresAt: share.expiresAt ? Math.floor(Number(share.expiresAt) / 1000) : 0,
    termsVersion: share.consent && share.consent.termsVersion,
    consentAt: share.consent ? Math.floor(Number(share.consent.acceptedAt) / 1000) : 0,
    ownerLabel: String(share.ownerLabel || '').slice(0, 60),
  }
}

/**
 * Push every share to <name>.beebo.tv/remote/shares (licence token, like the member list) and
 * apply what comes back: a guest who left, an acceptance, an invite code to pass on when no
 * email could be sent. Never throws. -> { ok, reason?, changed }
 */
async function syncShares({ store, getName, getToken, ownerLabel, fetchImpl, log } = {}) {
  const note = typeof log === 'function' ? log : () => {}
  try {
    const name = typeof getName === 'function' ? getName() : null
    const token = typeof getToken === 'function' ? getToken() : null
    if (!name || !token) return { ok: false, reason: 'not-ready' }
    const doFetch = fetchImpl || globalThis.fetch
    const shares = readAll(store).map((s) => ({ ...workerView(s), ownerLabel: String(ownerLabel || '').slice(0, 60) }))
    const res = await doFetch(`https://${name}.beebo.tv/remote/shares`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, shares }),
    })
    let body = {}
    try { body = await res.json() } catch { body = {} }
    if (res.status !== 200 || !body.ok) {
      note(`[library-shares] push refused: ${res.status} ${body && body.error ? body.error : ''}`)
      return { ok: false, reason: body.error || `http_${res.status}` }
    }
    let changed = 0
    const all = readAll(store)
    for (const r of Array.isArray(body.shares) ? body.shares : []) {
      const i = all.findIndex((s) => s.id === r.shareId)
      if (i < 0) continue
      const s = { ...all[i] }
      if ((r.status === 'left' || r.status === 'declined') && isLive(s)) { s.status = r.status; s.revokedAt = Date.now(); s.inviteCode = null }
      else if (r.status === 'accepted' && s.status === 'pending') { s.status = 'active'; s.acceptedAt = (Number(r.acceptedAt) || 0) * 1000 || Date.now(); s.inviteCode = null }
      if (typeof r.code === 'string' && s.status === 'pending' && !r.emailed) s.inviteCode = r.code
      if (r.emailed) s.emailed = true
      if (JSON.stringify(s) !== JSON.stringify(all[i])) { all[i] = s; changed++ }
    }
    if (changed) writeAll(store, all)
    note(`[library-shares] pushed ${shares.length} share(s)`)
    return { ok: true, changed }
  } catch (e) {
    note(`[library-shares] push failed: ${e && e.message}`)
    return { ok: false, reason: 'error' }
  }
}

/** The owner-facing shape (the invite code only while it is still needed). */
function ownerShape(share) {
  return {
    id: share.id,
    guestEmail: share.guestEmail,
    guestLabel: share.guestLabel,
    status: isLive(share) ? share.status : share.status === 'pending' || share.status === 'active' ? 'expired' : share.status,
    createdAt: share.createdAt,
    acceptedAt: share.acceptedAt,
    revokedAt: share.revokedAt,
    libraries: share.libraries,
    folders: share.folders,
    collections: share.collections,
    expiresAt: share.expiresAt,
    maxStreams: share.maxStreams,
    downloads: !!share.downloads,
    parental: share.parental,
    consent: share.consent,
    inviteCode: share.inviteCode || null,
    emailed: !!share.emailed,
  }
}

/** What the guest may know about the share they are using. */
function guestShape(share, ownerLabel) {
  return {
    id: share.id,
    ownerLabel: ownerLabel || 'Shared library',
    libraries: share.libraries,
    expiresAt: share.expiresAt,
    maxStreams: share.maxStreams,
    downloads: !!share.downloads,
    restricted: parental.isRestricted(share.parental),
  }
}

module.exports = {
  SHARE_TERMS_VERSION,
  SHARE_CONSENT_STATEMENT,
  MAX_ACTIVE_SHARES,
  MAX_STREAMS_CAP,
  SHARE_ID_RE,
  list,
  get,
  isLive,
  cleanScope,
  create,
  update,
  revoke,
  purgeGuestData,
  prune,
  markAccepted,
  makeShareToken,
  verifyShareToken,
  createStreamLimiter,
  workerView,
  syncShares,
  ownerShape,
  guestShape,
}
