'use strict'
/**
 * A person's own star ratings.
 *
 *   store 'userRatings' = { [userId]: { [key]: { rating, at, source } } }
 *
 *   key      'movie:<fileName>' | 'tv:<relPath>' | 'show:<showKey>'  (the same file keys watchedState uses)
 *   rating   0.5 - 10 in half steps (a 5-star system shows it halved)
 *   source   'manual' or 'import:<product>'
 *
 * Only the migration importer writes these today; the value is kept so a rating a person made
 * in Plex, Jellyfin, Emby, Kodi or Letterboxd is not lost and can be shown by the app later.
 */

const STORE_KEY = 'userRatings'
const MAX_PER_USER = 50000
const KEY_RE = /^(movie|tv|show):.{1,1000}$/

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

function cleanRating(v) {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n) || n < 0.5 || n > 10) return null
  return Math.round(n * 2) / 2
}

function all(store) {
  let raw
  try { raw = store.get(STORE_KEY) } catch { raw = undefined }
  return isObj(raw) ? raw : {}
}

/** One person's ratings as { key: { rating, at, source } }. */
function forUser(store, userId) {
  const u = all(store)[userId]
  return isObj(u) ? u : {}
}

function get(store, userId, key) {
  const r = forUser(store, userId)[key]
  return isObj(r) && cleanRating(r.rating) ? r : null
}

/**
 * Writes many ratings for one person with a single save.
 * `entries` is [{ key, rating, at? }]; existing ratings are kept unless `overwrite`.
 * Returns the records written as [{ key, before, after }] (before null when new).
 */
function setMany(store, userId, entries, { source = 'manual', overwrite = true, now = Date.now() } = {}) {
  if (!userId || !Array.isArray(entries) || !entries.length) return []
  const everyone = { ...all(store) }
  const mine = { ...(isObj(everyone[userId]) ? everyone[userId] : {}) }
  const written = []
  for (const e of entries) {
    if (!e || !KEY_RE.test(String(e.key))) continue
    const rating = cleanRating(e.rating)
    if (!rating) continue
    const before = isObj(mine[e.key]) ? { ...mine[e.key] } : null
    if (before && !overwrite) continue
    if (!before && Object.keys(mine).length >= MAX_PER_USER) continue
    const after = { rating, at: Number(e.at) > 0 ? Number(e.at) : now, source }
    mine[e.key] = after
    written.push({ key: e.key, before, after: { ...after } })
  }
  if (written.length) {
    everyone[userId] = mine
    store.set(STORE_KEY, everyone)
  }
  return written
}

/**
 * The undo of setMany: a rating goes back only while it still equals what was written.
 * Returns { reverted, changedSince }.
 */
function restore(store, userId, list) {
  const out = { reverted: 0, changedSince: 0 }
  if (!userId || !Array.isArray(list) || !list.length) return out
  const everyone = { ...all(store) }
  const mine = { ...(isObj(everyone[userId]) ? everyone[userId] : {}) }
  for (const ch of list) {
    const cur = mine[ch.key]
    if (!isObj(cur) || cur.rating !== ch.after.rating || cur.at !== ch.after.at || cur.source !== ch.after.source) { out.changedSince++; continue }
    if (ch.before) mine[ch.key] = ch.before
    else delete mine[ch.key]
    out.reverted++
  }
  if (out.reverted) {
    everyone[userId] = mine
    store.set(STORE_KEY, everyone)
  }
  return out
}

/** How many ratings one person has. */
function count(store, userId) {
  return Object.keys(forUser(store, userId)).length
}

module.exports = { STORE_KEY, cleanRating, forUser, get, setMany, restore, count }
