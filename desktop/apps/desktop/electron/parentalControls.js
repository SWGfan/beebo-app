'use strict'
/*
 * Parental controls: the rules for one household member's profile.
 *
 * This file is the pure half (no server, no store writes except the helpers
 * that are handed a store). The one place that APPLIES these rules to the
 * library is electron/contentGate.js; read that file first if you want to
 * filter something.
 *
 * Audience note (Google Play): these are tools for the adult who runs the home
 * server to limit what a household profile can watch. The app stays 18+; the
 * wording here is plain and adult-facing ("Young children", not cartoons).
 *
 * A policy, as stored under store key 'parentalControls' -> { [userId]: policy }:
 *   enabled            false = no limits at all (the default for everyone)
 *   preset             'young' | 'kids' | 'teens' | 'custom' | 'off' (label only)
 *   ratingSystem       'US' | 'CA'  which scale movieMax is written in
 *   movieMax           'G' 'PG' 'PG-13' 'R' 'NC-17'  (US)  or  'G' 'PG' '14A' '18A' 'R' (CA); null = no film limit
 *   tvMax              'TV-Y' 'TV-Y7' 'TV-G' 'TV-PG' 'TV-14' 'TV-MA'; null = no TV limit
 *   blockUnrated       true = a title with no rating we can read is hidden
 *   blockedGenres      [TMDB genre id]
 *   blockedTitles      [{ kind: 'movie'|'tv', tmdbId?, id?, title? }]
 *   blockedCollections [TMDB collection id]
 *   allowListOnly      true = ONLY allowedTitles / allowedCollections are visible
 *   allowedTitles      [{ kind, tmdbId?, id?, title? }]
 *   allowedCollections [TMDB collection id]
 *   dailyLimitMinutes  null or 1..1440
 *   bedtime            null or { start: 'HH:MM', end: 'HH:MM' }  (may cross midnight)
 */

const crypto = require('crypto')

// Numeric levels, low = suitable for younger viewers.
const US_MOVIE = { G: 0, PG: 1, 'PG-13': 2, R: 3, 'NC-17': 4 }
const CA_MOVIE = { G: 0, PG: 1, '14A': 2, '18A': 3, R: 4 }
const TV = { 'TV-Y': 0, 'TV-Y7': 1, 'TV-G': 2, 'TV-PG': 3, 'TV-14': 4, 'TV-MA': 5 }
// A TV rating on a film (or a film rating on a show) is translated, never ignored.
const TV_AS_MOVIE = { 'TV-Y': 0, 'TV-Y7': 1, 'TV-G': 0, 'TV-PG': 1, 'TV-14': 2, 'TV-MA': 3 }
const MOVIE_AS_TV = [2, 3, 4, 5, 5] // G, PG, PG-13, R, NC-17 -> TV-G, TV-PG, TV-14, TV-MA, TV-MA

const MOVIE_RATINGS = { US: Object.keys(US_MOVIE), CA: Object.keys(CA_MOVIE) }
const TV_RATINGS = Object.keys(TV)

// Horror, Thriller, Crime, War (TV genres are split into these ids by genres.js).
const PRESETS = {
  young: {
    label: 'Young children (under 7)',
    policy: { movieMax: 'G', tvMax: 'TV-Y', blockUnrated: true, blockedGenres: [27, 53, 80, 10752] },
  },
  kids: {
    label: 'Ages 7 to 12',
    policy: { movieMax: 'PG', tvMax: 'TV-PG', blockUnrated: true, blockedGenres: [27] },
  },
  teens: {
    label: 'Teens (13 to 17)',
    policy: { movieMax: 'PG-13', tvMax: 'TV-14', blockUnrated: false, blockedGenres: [] },
  },
  off: { label: 'Off (no limits)', policy: null },
}

const OFF = Object.freeze({
  enabled: false, preset: 'off', ratingSystem: 'US', movieMax: null, tvMax: null, blockUnrated: false,
  blockedGenres: [], blockedTitles: [], blockedCollections: [], allowListOnly: false,
  allowedTitles: [], allowedCollections: [], dailyLimitMinutes: null, bedtime: null,
})

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/

function cleanTitleRefs(list) {
  const out = []
  for (const t of Array.isArray(list) ? list.slice(0, 500) : []) {
    if (!t || typeof t !== 'object') continue
    const kind = t.kind === 'tv' || t.kind === 'show' ? 'tv' : t.kind === 'movie' ? 'movie' : null
    if (!kind) continue
    const tmdbId = Number(t.tmdbId)
    const id = typeof t.id === 'string' && t.id.length <= 1024 ? t.id : null
    if (!(Number.isFinite(tmdbId) && tmdbId > 0) && !id) continue
    out.push({
      kind,
      ...(Number.isFinite(tmdbId) && tmdbId > 0 ? { tmdbId } : {}),
      ...(id ? { id } : {}),
      ...(t.title ? { title: String(t.title).slice(0, 200) } : {}),
    })
  }
  return out
}

function cleanIds(list) {
  return [...new Set((Array.isArray(list) ? list : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 500)
}

/** Any input (a saved record, an admin's POST body) -> a complete, safe policy. Never throws. */
function normalizePolicy(raw) {
  if (!raw || typeof raw !== 'object') return { ...OFF }
  const presetName = typeof raw.preset === 'string' && PRESETS[raw.preset] ? raw.preset : 'custom'
  if (raw.enabled === false || presetName === 'off') return { ...OFF }
  const ratingSystem = raw.ratingSystem === 'CA' ? 'CA' : 'US'
  const movieScale = ratingSystem === 'CA' ? CA_MOVIE : US_MOVIE
  const movieMax = typeof raw.movieMax === 'string' && raw.movieMax in movieScale ? raw.movieMax : null
  const tvMax = typeof raw.tvMax === 'string' && raw.tvMax in TV ? raw.tvMax : null
  const limit = Number(raw.dailyLimitMinutes)
  let bedtime = null
  if (raw.bedtime && HHMM.test(String(raw.bedtime.start || '')) && HHMM.test(String(raw.bedtime.end || '')) &&
      raw.bedtime.start !== raw.bedtime.end) {
    bedtime = { start: raw.bedtime.start, end: raw.bedtime.end }
  }
  return {
    enabled: true,
    preset: presetName,
    ratingSystem,
    movieMax,
    tvMax,
    blockUnrated: raw.blockUnrated === true,
    blockedGenres: cleanIds(raw.blockedGenres),
    blockedTitles: cleanTitleRefs(raw.blockedTitles),
    blockedCollections: cleanIds(raw.blockedCollections),
    allowListOnly: raw.allowListOnly === true,
    allowedTitles: cleanTitleRefs(raw.allowedTitles),
    allowedCollections: cleanIds(raw.allowedCollections),
    dailyLimitMinutes: Number.isFinite(limit) && limit >= 1 ? Math.min(1440, Math.floor(limit)) : null,
    bedtime,
  }
}

/** A preset's policy, with any extra fields (bedtime, limit) layered on. */
function presetPolicy(name, extra = {}) {
  const p = PRESETS[name]
  if (!p || !p.policy) return { ...OFF }
  return normalizePolicy({ ...p.policy, ...extra, preset: name, enabled: true })
}

/** Does this policy limit anything at all? (An enabled policy with no rules still counts.) */
function isRestricted(policy) {
  return !!(policy && policy.enabled)
}

function certString(c) {
  return String(c || '').trim().toUpperCase().replace(/\s+/g, '-')
}

/**
 * The item's level on the scale the limit is written in, or null when unrated / unreadable.
 * kind is the item's kind; the certification may be either scale.
 */
function levelOf(kind, cert, ratingSystem) {
  const c = certString(cert)
  if (!c || c === 'NR' || c === 'UNRATED' || c === 'NOT-RATED' || c === 'UR') return null
  if (kind === 'tv') {
    if (c in TV) return TV[c]
    const m = c in US_MOVIE ? US_MOVIE[c] : null
    return m === null ? null : MOVIE_AS_TV[m]
  }
  if (c in TV) return TV_AS_MOVIE[c]
  // Film certifications come from TMDB's US release dates. A Canadian-only code (14A, 18A)
  // is read on the Canadian scale. "R" is ambiguous; TMDB's is American, so it is 3.
  if (c === '14A' || c === '18A') return CA_MOVIE[c]
  if (c in US_MOVIE) return US_MOVIE[c]
  return null
}

function limitLevel(kind, policy) {
  if (kind === 'tv') return policy.tvMax ? TV[policy.tvMax] : null
  if (!policy.movieMax) return null
  const scale = policy.ratingSystem === 'CA' ? CA_MOVIE : US_MOVIE
  // Canadian 18A sits with US R; Canadian R (adults only) with NC-17. Same numbers.
  return scale[policy.movieMax]
}

function refMatches(ref, info) {
  if (!ref || ref.kind !== info.kind) return false
  if (ref.tmdbId && info.tmdbId && Number(ref.tmdbId) === Number(info.tmdbId)) return true
  if (ref.id && (ref.id === info.id || (info.showKey && ref.id === info.showKey))) return true
  return false
}

/**
 * The decision for one title. info:
 *   { kind: 'movie'|'tv', id, showKey?, tmdbId?, certification?, genres: [ids], collectionId? }
 * -> { allowed: true } | { allowed: false, reason }
 */
function decide(policy, info) {
  if (!isRestricted(policy)) return { allowed: true }
  if (!info || (info.kind !== 'movie' && info.kind !== 'tv')) return { allowed: false, reason: 'unknown' }
  const collectionId = info.collectionId != null ? Number(info.collectionId) : null
  if (policy.allowListOnly) {
    const inTitles = policy.allowedTitles.some((r) => refMatches(r, info))
    const inCollections = collectionId !== null && policy.allowedCollections.includes(collectionId)
    // The allow list is the whole truth: nothing else is visible, whatever its rating.
    if (!inTitles && !inCollections) return { allowed: false, reason: 'not_on_allow_list' }
  }
  if (policy.blockedTitles.some((r) => refMatches(r, info))) return { allowed: false, reason: 'blocked_title' }
  if (collectionId !== null && policy.blockedCollections.includes(collectionId)) return { allowed: false, reason: 'blocked_collection' }
  const genres = Array.isArray(info.genres) ? info.genres.map(Number) : []
  if (policy.blockedGenres.length && genres.some((g) => policy.blockedGenres.includes(g))) return { allowed: false, reason: 'blocked_genre' }
  const max = limitLevel(info.kind, policy)
  const level = levelOf(info.kind, info.certification, policy.ratingSystem)
  if (level === null) {
    // An allow-listed title was chosen by name, so its missing rating doesn't hide it.
    if (policy.blockUnrated && !policy.allowListOnly) return { allowed: false, reason: 'unrated' }
    return { allowed: true }
  }
  if (max !== null && level > max) return { allowed: false, reason: 'rating' }
  return { allowed: true }
}

// ---- time: bedtime and a daily limit --------------------------------------

function minutesOfDay(d) {
  return d.getHours() * 60 + d.getMinutes()
}
function parseHHMM(s) {
  const m = HHMM.exec(String(s || ''))
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

/** Local day key, e.g. '2026-09-17'. */
function dayKey(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function inBedtime(bedtime, now) {
  if (!bedtime) return false
  const s = parseHHMM(bedtime.start)
  const e = parseHHMM(bedtime.end)
  if (s === null || e === null || s === e) return false
  const m = minutesOfDay(now)
  return s < e ? m >= s && m < e : m >= s || m < e
}

/**
 * May this profile start or keep watching right now?
 * usedMinutes: minutes already watched today (see createUsageTracker).
 * -> { ok: true } | { ok: false, reason: 'bedtime'|'daily_limit', message, until }
 */
function timeGate(policy, now = new Date(), usedMinutes = 0) {
  if (!isRestricted(policy)) return { ok: true }
  if (policy.bedtime && inBedtime(policy.bedtime, now)) {
    return {
      ok: false,
      reason: 'bedtime',
      until: policy.bedtime.end,
      message: `It's past bedtime on this profile. Watching opens again at ${policy.bedtime.end}.`,
    }
  }
  if (policy.dailyLimitMinutes && usedMinutes >= policy.dailyLimitMinutes) {
    return {
      ok: false,
      reason: 'daily_limit',
      until: '00:00',
      message: `That's all the watching time for today on this profile (${policy.dailyLimitMinutes} minutes). It starts again tomorrow.`,
    }
  }
  return { ok: true }
}

/**
 * Screen time, counted in whole minutes during which a restricted profile was streaming
 * or its player reported progress. Idempotent per minute, so parallel range requests and a
 * progress heartbeat in the same minute count once. Persisted under 'parentalUsage'.
 */
function createUsageTracker(store, { now = () => new Date() } = {}) {
  const read = () => {
    try {
      const v = store.get('parentalUsage')
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
    } catch {
      return {}
    }
  }
  function entryFor(all, key, day) {
    const e = all[key]
    return e && e.day === day && Array.isArray(e.minutes) ? e : { day, minutes: [] }
  }
  return {
    mark(key) {
      if (!key) return 0
      const d = now()
      const day = dayKey(d)
      const minute = minutesOfDay(d)
      const all = read()
      const e = entryFor(all, key, day)
      if (!e.minutes.includes(minute)) {
        e.minutes = [...e.minutes, minute].slice(-1440)
        try { store.set('parentalUsage', { ...all, [key]: e }) } catch {}
      }
      return e.minutes.length
    },
    used(key) {
      if (!key) return 0
      return entryFor(read(), key, dayKey(now())).minutes.length
    },
    forget(key) {
      const all = read()
      if (!(key in all)) return
      const next = { ...all }
      delete next[key]
      try { store.set('parentalUsage', next) } catch {}
    },
  }
}

// ---- the owner PIN ---------------------------------------------------------

const PIN_RE = /^\d{4,8}$/

function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(String(pin), Buffer.from(salt, 'hex'), 32).toString('hex')
  return { salt, hash }
}

function pinMatches(rec, pin) {
  if (!rec || !rec.salt || !rec.hash || !PIN_RE.test(String(pin || ''))) return false
  const got = crypto.scryptSync(String(pin), Buffer.from(rec.salt, 'hex'), 32)
  const want = Buffer.from(String(rec.hash), 'hex')
  return got.length === want.length && crypto.timingSafeEqual(got, want)
}

/** Wrong-PIN lockout: 5 misses in 15 minutes locks that key for 15 minutes. In memory. */
function createPinLimiter({ max = 5, windowMs = 15 * 60 * 1000, now = () => Date.now() } = {}) {
  const fails = new Map()
  return {
    locked(key) {
      const f = fails.get(key)
      if (!f) return 0
      const t = now()
      if (f.until && f.until > t) return Math.ceil((f.until - t) / 60000)
      if (t - f.first > windowMs) fails.delete(key)
      return 0
    },
    fail(key) {
      const t = now()
      let f = fails.get(key)
      if (!f || t - f.first > windowMs) f = { first: t, count: 0, until: 0 }
      f.count++
      if (f.count >= max) f.until = t + windowMs
      fails.set(key, f)
    },
    clear(key) {
      fails.delete(key)
    },
  }
}

/** Store helpers. Policies live apart from the user records so auth.js stays untouched. */
function getPolicy(store, userId) {
  try {
    const all = store.get('parentalControls')
    return normalizePolicy(all && typeof all === 'object' ? all[userId] : null)
  } catch {
    return { ...OFF }
  }
}

function setPolicy(store, userId, policy) {
  const all = (() => {
    try {
      const v = store.get('parentalControls')
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
    } catch {
      return {}
    }
  })()
  const clean = normalizePolicy(policy)
  const next = { ...all }
  if (clean.enabled) next[userId] = { ...clean, updatedAt: Date.now() }
  else delete next[userId]
  store.set('parentalControls', next)
  return clean
}

/** What the phone and the PC screens need to draw the editor. */
function editorOptions() {
  return {
    presets: Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label, policy: p.policy ? normalizePolicy({ ...p.policy, preset: id }) : { ...OFF } })),
    movieRatings: MOVIE_RATINGS,
    tvRatings: TV_RATINGS,
  }
}

module.exports = {
  PRESETS,
  OFF,
  MOVIE_RATINGS,
  TV_RATINGS,
  PIN_RE,
  normalizePolicy,
  presetPolicy,
  isRestricted,
  decide,
  levelOf,
  timeGate,
  inBedtime,
  dayKey,
  createUsageTracker,
  hashPin,
  pinMatches,
  createPinLimiter,
  getPolicy,
  setPolicy,
  editorOptions,
}
