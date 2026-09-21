'use strict'
// ============================================================================
// homeTheaterSettings.js - Settings > Playback > "Home theater", with a per-person override.
// ----------------------------------------------------------------------------
// The owner's server-wide choices (store key `homeTheater`) and optional overrides for individual people
// (`homeTheaterUsers[<userId>]`). An override only names what differs: a field that is missing or null
// inherits the server value. Pure functions plus a tiny store wrapper; nothing here starts a process.
//
//   directPlayPreferred  true  Play the file as it is whenever the device can (default).
//                        false Prefer a server-side remux ("direct stream") even when the file would play as
//                              it is; the picture and sound still are not re-encoded when the device can play them.
//   maxBitrateKbps       0 = no limit. A file above it is converted (a copy cannot lower a bitrate).
//   allowPassthrough     true  Count on a client passing Dolby TrueHD / DTS-HD / Atmos to an AV receiver (default).
//                        false Treat "passthrough only" formats as unplayable: the server converts that sound instead.
//   allowDirectStream    true  Remux (copy the picture and sound into fragmented MP4 / HLS) when only the container or
//                              one stream needs work (default). false: convert instead.
//   forceTranscode       false For testing: always run the full conversion, never direct play or direct stream.
// ============================================================================

const KEY = 'homeTheater'
const USERS_KEY = 'homeTheaterUsers'
const MAX_BITRATE_KBPS = 1000000
const MAX_USERS = 500

const DEFAULTS = Object.freeze({
  directPlayPreferred: true,
  maxBitrateKbps: 0,
  allowPassthrough: true,
  allowDirectStream: true,
  forceTranscode: false
})
const FIELDS = Object.keys(DEFAULTS)

const bool = (v, d) => (typeof v === 'boolean' ? v : d)
function kbps(v, d) {
  if (v === null || v === undefined || v === '') return d
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) return d
  return Math.min(MAX_BITRATE_KBPS, Math.round(n))
}

/** Anything -> the complete, valid server-wide settings. */
function normalize(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  return {
    directPlayPreferred: bool(r.directPlayPreferred, DEFAULTS.directPlayPreferred),
    maxBitrateKbps: kbps(r.maxBitrateKbps, DEFAULTS.maxBitrateKbps),
    allowPassthrough: bool(r.allowPassthrough, DEFAULTS.allowPassthrough),
    allowDirectStream: bool(r.allowDirectStream, DEFAULTS.allowDirectStream),
    forceTranscode: bool(r.forceTranscode, DEFAULTS.forceTranscode)
  }
}

/** Anything -> a valid override: only the fields that are set (boolean / number); null and unknown keys dropped. */
function normalizeOverride(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const out = {}
  for (const f of ['directPlayPreferred', 'allowPassthrough', 'allowDirectStream', 'forceTranscode']) if (typeof r[f] === 'boolean') out[f] = r[f]
  if (r.maxBitrateKbps !== null && r.maxBitrateKbps !== undefined && r.maxBitrateKbps !== '' && Number.isFinite(Number(r.maxBitrateKbps)) && Number(r.maxBitrateKbps) >= 0) out.maxBitrateKbps = kbps(r.maxBitrateKbps, 0)
  return out
}

/** The settings that apply to one person: the server values with that person's override laid over them. */
function effective(server, override) {
  const base = normalize(server)
  const o = normalizeOverride(override)
  return { ...base, ...o }
}

/** Which fields a person's override actually changes (for the Settings table). */
function overriddenFields(override) {
  return Object.keys(normalizeOverride(override))
}

function createStore(store) {
  const get = (k, d) => { try { const v = store.get(k); return v === undefined || v === null ? d : v } catch { return d } }
  const readServer = () => normalize(get(KEY, {}))
  const readUsers = () => {
    const raw = get(USERS_KEY, {})
    const out = {}
    if (raw && typeof raw === 'object') {
      for (const [id, o] of Object.entries(raw).slice(0, MAX_USERS)) {
        const n = normalizeOverride(o)
        if (Object.keys(n).length) out[String(id).slice(0, 64)] = n
      }
    }
    return out
  }
  return {
    server: readServer,
    users: readUsers,
    /** Settings for one person (server values + their override). userId may be empty (guest / system). */
    forUser(userId) { return effective(readServer(), userId ? readUsers()[String(userId)] : null) },
    saveServer(patch) {
      const cur = readServer()
      const p = patch && typeof patch === 'object' ? patch : {}
      const next = { ...cur }
      for (const f of ['directPlayPreferred', 'allowPassthrough', 'allowDirectStream', 'forceTranscode']) if (typeof p[f] === 'boolean') next[f] = p[f]
      if (p.maxBitrateKbps !== undefined) next.maxBitrateKbps = kbps(p.maxBitrateKbps, cur.maxBitrateKbps)
      store.set(KEY, next)
      return next
    },
    /** patch: { field: value | null } - null removes that field from the person's override. */
    saveUser(userId, patch) {
      const id = String(userId || '').slice(0, 64)
      if (!id) return null
      const all = readUsers()
      const cur = all[id] || {}
      const p = patch && typeof patch === 'object' ? patch : {}
      const next = { ...cur }
      for (const f of FIELDS) {
        if (!(f in p)) continue
        if (p[f] === null) delete next[f]
        else Object.assign(next, normalizeOverride({ [f]: p[f] }))
      }
      if (Object.keys(next).length) all[id] = next
      else delete all[id]
      store.set(USERS_KEY, all)
      return all[id] || {}
    }
  }
}

module.exports = { KEY, USERS_KEY, DEFAULTS, FIELDS, normalize, normalizeOverride, effective, overriddenFields, createStore }
