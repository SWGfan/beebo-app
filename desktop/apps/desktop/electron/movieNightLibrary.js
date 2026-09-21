'use strict'
// ============================================================================
// movieNightLibrary.js - turns the owner's library + CACHED TMDB data into the "pool" the games use.
// ----------------------------------------------------------------------------
// Offline by construction: it only reads what is already on disk (the TMDB manifest, the cast file,
// the poster / actor-photo folders and the details-page cache). It never calls the network.
//
// Parental controls: a pool is built for one HOST profile. A title appears only when
//   1. that profile's own limits allow it (the caller passes `allow(id)` = contentGate.allowId), AND
//   2. it is inside the room's rating cap (settings.ratingCap: none | G | PG | PG-13 | R).
// With a cap set, a title whose rating is not known is left out unless the owner ticked "include
// titles with no rating saved". The pool never carries a file path: `key` is the library's opaque id.
//
// Text from the library (titles, taglines, actor names) is data: control / bidi characters are removed
// and lengths capped here; the pages only ever write it with textContent.
// ============================================================================

const fs = require('fs')
const path = require('path')
const parental = require('./parentalControls')

const CAPS = Object.freeze(['none', 'G', 'PG', 'PG-13', 'R'])
const MAX_POOL = 2500
const MAX_CAST = 12
const INVISIBLE_RE = new RegExp('[\\u0000-\\u001F\\u007F-\\u009F\\u00AD\\u061C\\u180E\\u200B-\\u200F\\u2028-\\u202E\\u2060-\\u206F\\uFEFF\\uFFF9-\\uFFFB]', 'g')

function cleanText(v, max) {
  let s = typeof v === 'string' ? v : v == null ? '' : String(v)
  s = s.replace(INVISIBLE_RE, ' ').replace(/\s+/g, ' ').trim()
  const cps = Array.from(s)
  return cps.length > max ? cps.slice(0, max).join('').trim() : s
}

/** 'PG-13' -> 2 ... 'none' / anything else -> null (no cap). */
function capLevel(cap) {
  if (!CAPS.includes(cap) || cap === 'none') return null
  return parental.levelOf('movie', cap, 'US')
}

const yearFrom = (date) => {
  const m = /^(\d{4})/.exec(String(date || ''))
  return m ? Number(m[1]) : null
}

// ---- the details-page cache: taglines and ratings for films whose page was opened while online -------------
let detailsMemo = { file: '', sig: '', map: null }
function readDetails(cacheDir) {
  const empty = new Map()
  if (!cacheDir) return empty
  // English keeps movies.json; another metadata language keeps movies.<language>_<region>.json (tmdbDetails.js).
  let name = 'movies.json'
  try {
    if (!fs.existsSync(path.join(cacheDir, 'details', name))) {
      const other = fs.readdirSync(path.join(cacheDir, 'details')).filter((n) => /^movies\.[A-Za-z_-]+\.json$/.test(n)).sort()[0]
      if (other) name = other
    }
  } catch { return empty }
  const file = path.join(cacheDir, 'details', name)
  let sig = ''
  try { const st = fs.statSync(file); sig = st.mtimeMs + ':' + st.size } catch { return empty }
  if (detailsMemo.file === file && detailsMemo.sig === sig && detailsMemo.map) return detailsMemo.map
  const map = new Map()
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    for (const [id, e] of Object.entries((data && data.entries) || {})) {
      const v = e && e.v
      if (v && typeof v === 'object') map.set(String(id), { tagline: cleanText(v.tagline, 160), certification: v.certification ? String(v.certification) : null })
    }
  } catch { /* a damaged cache is just an empty one */ }
  detailsMemo = { file, sig, map }
  return map
}

/**
 * movies      [{ fileName, dir }]  (already one entry per film)
 * metaOf      (fileName, dir) -> the cached TMDB summary { id, title, release_date, poster_path, certification, gate?, tagline? } | null
 * creditsOf   (tmdbId) -> [{ id, name, character, profilePath }]
 * detailsOf   (tmdbId) -> { tagline, certification } | undefined
 * hasPoster / hasActorPhoto  (id) -> boolean       idOf (movie) -> the library's id
 * allow       (id) -> boolean                       the host profile's own parental limits
 * cap         'none' | 'G' | 'PG' | 'PG-13' | 'R'   includeUnrated  boolean
 */
function buildPool({ movies, metaOf, creditsOf, detailsOf, hasPoster, hasActorPhoto, idOf, allow, cap = 'none', includeUnrated = false, limit = MAX_POOL }) {
  const max = capLevel(cap)
  const out = []
  const seenTmdb = new Set()
  const stats = { considered: 0, noMeta: 0, blocked: 0, capped: 0, unrated: 0 }
  for (const m of Array.isArray(movies) ? movies : []) {
    if (out.length >= limit) break
    stats.considered++
    let meta = null
    try { meta = metaOf(m.fileName, m.dir) } catch { meta = null }
    const title = meta && cleanText(meta.title, 120)
    const tmdbId = meta && Number.isInteger(Number(meta.id)) && Number(meta.id) > 0 ? Number(meta.id) : null
    if (!title || !tmdbId || seenTmdb.has(tmdbId)) { if (!title || !tmdbId) stats.noMeta++; continue }
    const id = idOf(m)
    if (typeof allow === 'function' && !allow(id)) { stats.blocked++; continue }
    const det = (detailsOf && detailsOf(String(tmdbId))) || {}
    const rating = (meta.certification || (meta.gate && meta.gate.certification) || det.certification || null)
    if (max !== null) {
      const level = parental.levelOf('movie', rating, 'US')
      if (level === null) { if (!includeUnrated) { stats.unrated++; continue } } else if (level > max) { stats.capped++; continue }
    }
    seenTmdb.add(tmdbId)
    let cast = []
    try {
      cast = (creditsOf(tmdbId) || []).slice(0, MAX_CAST).map((c) => ({
        id: Number(c.id) || 0,
        name: cleanText(c.name, 60),
        character: cleanText(c.character, 60),
        photo: c.id && hasActorPhoto && hasActorPhoto(c.id) ? `/media/actor/${Number(c.id)}.jpg` : null
      })).filter((c) => c.name)
    } catch { cast = [] }
    out.push({
      key: id,
      tmdbId,
      title,
      year: yearFrom(meta.release_date),
      tagline: cleanText(meta.tagline || det.tagline || '', 160),
      cast,
      poster: hasPoster && hasPoster(tmdbId) ? `/media/poster/${tmdbId}.jpg` : null,
      rating: rating ? cleanText(rating, 10) : null,
      playHref: `/watch?id=${encodeURIComponent(id)}`
    })
  }
  return { items: out, stats }
}

/** Search for the "suggest a movie" box: title contains the text. Returns at most `limit` public rows. */
function searchPool(pool, q, limit = 8) {
  const needle = cleanText(q, 40).toLowerCase()
  if (needle.length < 2) return []
  const rows = []
  for (const m of pool) {
    const t = m.title.toLowerCase()
    const at = t.indexOf(needle)
    if (at < 0) continue
    rows.push({ at, m })
  }
  rows.sort((a, b) => a.at - b.at || a.m.title.length - b.m.title.length)
  return rows.slice(0, limit).map(({ m }) => ({ key: m.key, title: m.title, year: m.year }))
}

/** A small time-limited cache so a room does not re-read the library for every question. */
function createPoolCache({ ttlMs = 60000, now = Date.now, max = 20 } = {}) {
  const cache = new Map()
  return {
    /** cacheKey identifies who and what (host profile + cap); `build` is only called on a miss. */
    async get(cacheKey, build) {
      const hit = cache.get(cacheKey)
      if (hit && now() - hit.at < ttlMs) return hit.value
      const value = await build()
      cache.set(cacheKey, { at: now(), value })
      if (cache.size > max) cache.delete(cache.keys().next().value)
      return value
    },
    clear() { cache.clear() }
  }
}

module.exports = { CAPS, capLevel, cleanText, readDetails, buildPool, searchPool, createPoolCache, MAX_POOL }
