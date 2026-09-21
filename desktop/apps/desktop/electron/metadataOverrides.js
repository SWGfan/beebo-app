'use strict'
// ============================================================================
// metadataOverrides.js - the owner's manual edits to a title's information.
// ----------------------------------------------------------------------------
// TMDB answers land in the shared cache (manifest.json / tv-manifest.json) and are
// rewritten whenever a title is matched or refreshed. Edits made by hand therefore
// live in their OWN file next to them, <cache folder>/metadata-overrides.json, and are
// laid over the TMDB answer when it is read (metadataMerge.js is the one place that
// does this). A refresh, a re-match of another film or a rescan can never touch them,
// and "Reset to automatic" is just deleting the record.
//
// Keys are the ones the manifests already use: a movie's file name, a show's
// lower-case name. Nothing here renames or writes to a media file.
//
// Every value is cleaned on the way in (sanitiseFields): they end up in HTML pages,
// JSON answers to phones and third-party apps, and desktop windows, so control
// characters and direction overrides are removed and every length is capped.
//
// Per field there is a lock. A locked field always shows the owner's value. An
// unlocked one is only a fallback: it is used when TMDB has nothing for that field.
// ============================================================================

const fs = require('fs')
const path = require('path')
const { readJsonSafe, writeJsonAtomic } = require('./safeJson')
const { GENRE_NAMES_MOVIE, GENRE_NAMES_TV } = require('./genres')

const FILE_NAME = 'metadata-overrides.json'
const VERSION = 1
const MAX_RECORDS = 20000
const MAX_RECORD_BYTES = 16 * 1024
const LIMITS = { title: 200, sortTitle: 200, overview: 4000, tagline: 300, collection: 120, certification: 12, genres: 12 }
const TEXT_FIELDS = ['title', 'sortTitle', 'overview', 'tagline', 'collection']
const FIELD_NAMES = ['title', 'sortTitle', 'year', 'overview', 'tagline', 'genres', 'certification', 'rating', 'collection']
const CUSTOM_ART_RE = /^\/_beebo_([a-f0-9]{32})\.jpg$/
const ART_FILE_RE = /^([a-f0-9]{32})\.jpg$/
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const CERT_RE = /^[A-Za-z0-9][A-Za-z0-9+\-./ ]{0,11}$/
const SYNTHETIC_COLLECTION_BASE = 900000000

const GENRE_IDS = new Map()
const ALL_GENRES = {}
for (const dict of [GENRE_NAMES_TV, GENRE_NAMES_MOVIE]) {
  for (const [id, name] of Object.entries(dict)) {
    ALL_GENRES[id] = name
    GENRE_IDS.set(name.toLowerCase(), Number(id))
  }
}
const GENRE_ALIASES = {
  'sci-fi': 878, 'sci fi': 878, scifi: 878, 'science-fiction': 878, 'sci-fi & fantasy': 878,
  'action & adventure': 28, musical: 10402, 'tv movie': 10770
}

// A removed-from-the-page control character can hide text or change its direction.
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B\uFEFF\u202A-\u202E\u2066-\u2069]/g
const LINE_SEP_RE = /[\u2028\u2029]/g

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function truncateCodePoints(text, max) {
  const chars = Array.from(text)
  return chars.length > max ? chars.slice(0, max).join('') : text
}

/** Cleans one text value: string, no control or direction-override characters, capped. */
function cleanText(value, max, { multiline = false } = {}) {
  if (value === null || value === undefined) return ''
  if (typeof value !== 'string' && typeof value !== 'number') return ''
  let text = String(value)
  try { text = text.normalize('NFC') } catch { /* keep as is */ }
  text = text.replace(/\r\n?/g, '\n').replace(LINE_SEP_RE, '\n').replace(CONTROL_RE, '')
  // Lone surrogates are not valid text and break JSON consumers that re-encode.
  text = text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
  if (multiline) {
    text = text.split('\n').map((line) => line.replace(/[ \t]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n')
  } else {
    text = text.replace(/\s+/g, ' ')
  }
  return truncateCodePoints(text.trim(), max)
}

function genreId(value) {
  if (Number.isInteger(value) && ALL_GENRES[value]) return value
  if (typeof value === 'string' && /^\d{1,6}$/.test(value.trim()) && ALL_GENRES[Number(value)]) return Number(value)
  const name = cleanText(value, 40).toLowerCase()
  if (!name) return null
  return GENRE_IDS.get(name) || GENRE_ALIASES[name] || null
}

/** Genre names or ids -> a de-duplicated list of the genre ids Beebo knows. Names it does not know are dropped. */
function cleanGenres(list) {
  const out = []
  for (const g of Array.isArray(list) ? list : []) {
    const id = genreId(g)
    if (id && !out.includes(id)) out.push(id)
    if (out.length >= LIMITS.genres) break
  }
  return out
}

function cleanYear(value) {
  if (value === '' || value === null || value === undefined) return ''
  const n = Number(String(value).trim())
  const max = new Date().getUTCFullYear() + 10
  return Number.isInteger(n) && n >= 1870 && n <= max ? String(n) : null
}

function cleanRating(value) {
  if (value === '' || value === null || value === undefined) return null
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0 || n > 10) return undefined
  return Math.round(n * 10) / 10
}

function cleanCertification(value) {
  if (value === '' || value === null || value === undefined) return ''
  if (typeof value !== 'string' && typeof value !== 'number') return null
  if (String(value).trim().length > LIMITS.certification) return null
  const text = cleanText(value, LIMITS.certification)
  return CERT_RE.test(text) ? text : null
}

/**
 * The editor's answer -> what is stored. `input` is { fields: { title: { value, locked }, ... } }
 * (a bare value is taken as locked). Returns { ok, fields, errors }: a bad value is reported by
 * field name and never stored; a field that is absent or null keeps meaning "automatic".
 */
function sanitiseFields(input) {
  const errors = {}
  const fields = {}
  const source = isPlainObject(input) ? input : {}
  for (const name of FIELD_NAMES) {
    if (!Object.prototype.hasOwnProperty.call(source, name)) continue
    const raw = source[name]
    if (raw === null || raw === undefined) continue
    const entry = isPlainObject(raw) && 'value' in raw ? raw : { value: raw, locked: true }
    const locked = entry.locked !== false
    let value
    if (TEXT_FIELDS.includes(name)) {
      value = cleanText(entry.value, LIMITS[name], { multiline: name === 'overview' })
      if (name === 'title' && !value) { errors.title = 'The title cannot be empty. Use Reset to automatic to go back to the TMDB title.'; continue }
    } else if (name === 'year') {
      value = cleanYear(entry.value)
      if (value === null) { errors.year = 'Enter a four-digit year, or leave it empty.'; continue }
    } else if (name === 'genres') {
      value = cleanGenres(entry.value)
      if (Array.isArray(entry.value) && entry.value.length && !value.length) { errors.genres = 'None of those genres are ones Beebo knows.'; continue }
    } else if (name === 'certification') {
      value = cleanCertification(entry.value)
      if (value === null) { errors.certification = 'Use a short age rating such as PG-13, TV-MA or 14A.'; continue }
    } else {
      value = cleanRating(entry.value)
      if (value === undefined) { errors.rating = 'Enter a rating between 0 and 10.'; continue }
      if (value === null) continue
    }
    fields[name] = { value, locked }
  }
  return { ok: !Object.keys(errors).length, fields, errors }
}

function cleanArtRef(value, kind) {
  if (!isPlainObject(value) || typeof value.file !== 'string' || !ART_FILE_RE.test(value.file)) return null
  const source = value.source === 'tmdb' || value.source === 'sidecar' || value.source === 'upload' ? value.source : 'upload'
  const forTmdbId = Number.isSafeInteger(value.forTmdbId) && value.forTmdbId > 0 ? value.forTmdbId : null
  return { file: value.file, source, forTmdbId, kind }
}

// ---------------------------------------------------------------- keys

function movieKey(fileName) {
  const key = typeof fileName === 'string' ? fileName : ''
  if (!key || key.length > 500 || /[\u0000-\u001F]/.test(key) || FORBIDDEN_KEYS.has(key)) return null
  return key
}

/** A show is keyed like tv-manifest.json: the lower-case name, whichever spelling (plain or base64url) the caller holds. */
function showKey(value) {
  const raw = typeof value === 'string' ? value : ''
  if (!raw || raw.length > 500) return null
  let decoded = ''
  try { decoded = Buffer.from(raw, 'base64url').toString('utf8') } catch { decoded = '' }
  const plain = decoded && Buffer.from(decoded, 'utf8').toString('base64url') === raw ? decoded : raw
  const key = plain.toLowerCase()
  return !key || /[\u0000-\u001F]/.test(key) || FORBIDDEN_KEYS.has(key) ? null : key
}

// ---------------------------------------------------------------- the merge (pure)

/** A collection typed by hand has no TMDB id, so it gets a stable one from its name that cannot collide with TMDB's. */
function syntheticCollectionId(name) {
  let h = 2166136261
  for (const ch of String(name).toLowerCase()) {
    h ^= ch.codePointAt(0)
    h = Math.imul(h, 16777619) >>> 0
  }
  return SYNTHETIC_COLLECTION_BASE + (h % 99999999)
}

function customArtPath(hex) {
  return `/_beebo_${hex}.jpg`
}
function customArtFile(value) {
  const m = typeof value === 'string' ? CUSTOM_ART_RE.exec(value) : null
  return m ? `${m[1]}.jpg` : null
}
/** Server-relative address of a custom artwork path (a merged poster_path / backdrop_path), or null for a TMDB path. */
function customArtUrl(value) {
  const file = customArtFile(value)
  return file ? `/media/artwork/${file}` : null
}

function isBlank(v) {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)
}

function useField(field, automatic) {
  if (!field) return false
  return field.locked !== false || isBlank(automatic)
}

function withYear(date, year) {
  const tail = /^\d{4}(-\d{2}-\d{2})$/.exec(String(date || ''))
  return `${year}${tail ? tail[1] : '-01-01'}`
}

/**
 * The TMDB-shaped entry with the owner's record laid over it: same field names the rest of the app
 * already reads (title / name, release_date / first_air_date, overview, genre_ids, certification,
 * vote_average, poster_path, backdrop_path) plus sort_title, tagline, custom_collection and
 * metadata_edited (which fields came from the owner). Returns the same object when nothing applies.
 * `entry` may be null: a film TMDB has not matched can still have hand-typed information.
 */
function applyRecord(kind, entry, record) {
  if (!record) return entry
  const tv = kind === 'show'
  const out = entry ? { ...entry } : { id: null }
  const edited = []
  const f = record.fields || {}
  const titleKey = tv ? 'name' : 'title'
  const dateKey = tv ? 'first_air_date' : 'release_date'
  const set = (name, apply, automatic) => {
    if (!useField(f[name], automatic)) return
    apply(f[name].value)
    edited.push(name)
  }
  set('title', (v) => { out[titleKey] = v }, out[titleKey])
  set('sortTitle', (v) => { out.sort_title = v }, out.sort_title)
  set('year', (v) => { out[dateKey] = v ? withYear(out[dateKey], v) : '' }, String(out[dateKey] || '').slice(0, 4))
  set('overview', (v) => { out.overview = v }, out.overview)
  set('tagline', (v) => { out.tagline = v }, out.tagline)
  set('genres', (v) => { out.genre_ids = v.slice() }, out.genre_ids)
  set('certification', (v) => { out.certification = v || null }, out.certification)
  set('rating', (v) => { out.vote_average = v }, out.vote_average)
  set('collection', (v) => { out.custom_collection = v ? { id: syntheticCollectionId(v), name: v } : null }, out.custom_collection)
  for (const role of ['poster', 'backdrop']) {
    const art = record[role]
    if (!art || !ART_FILE_RE.test(art.file || '')) continue
    if (art.source === 'tmdb' && art.forTmdbId && out.id && art.forTmdbId !== out.id) continue
    out[`${role}_path`] = customArtPath(art.file.slice(0, -4))
    edited.push(role)
  }
  if (!edited.length) return entry
  out.metadata_edited = edited
  return out
}

// ---------------------------------------------------------------- the store

function emptyState() {
  return { movies: new Map(), shows: new Map() }
}

function loadState(file) {
  const result = readJsonSafe(file, {})
  const raw = isPlainObject(result.data) ? result.data : {}
  const state = emptyState()
  for (const [group, map] of [['movies', state.movies], ['shows', state.shows]]) {
    const entries = isPlainObject(raw[group]) ? Object.entries(raw[group]) : []
    for (const [key, rec] of entries) {
      if (FORBIDDEN_KEYS.has(key) || !isPlainObject(rec) || map.size >= MAX_RECORDS) continue
      map.set(key, cleanRecord(rec))
    }
  }
  return { state, transient: result.source === 'error' }
}

function cleanRecord(rec) {
  const { fields } = sanitiseFields(rec.fields)
  return {
    fields,
    poster: cleanArtRef(rec.poster, 'poster'),
    backdrop: cleanArtRef(rec.backdrop, 'backdrop'),
    tmdbId: Number.isSafeInteger(rec.tmdbId) && rec.tmdbId > 0 ? rec.tmdbId : null,
    updatedAt: Number.isFinite(rec.updatedAt) ? rec.updatedAt : 0
  }
}

function isEmptyRecord(rec) {
  return !rec || (!Object.keys(rec.fields).length && !rec.poster && !rec.backdrop)
}

function createStore({ file, now = () => Date.now(), recheckMs = 0 }) {
  let state = null
  let mtimeMs = -1
  let size = -1
  let checkedAt = 0

  function stamp() {
    try {
      const st = fs.statSync(file)
      return { m: st.mtimeMs, s: st.size }
    } catch { return { m: -1, s: -1 } }
  }
  function current() {
    // A page that asks about every title in a library must not stat the file once per title.
    if (state && recheckMs > 0 && now() - checkedAt < recheckMs) return state
    checkedAt = now()
    const s = stamp()
    if (state && s.m === mtimeMs && s.s === size) return state
    const loaded = loadState(file)
    if (loaded.transient && state) return state
    state = loaded.state
    const after = stamp()
    mtimeMs = after.m
    size = after.s
    return state
  }
  function groupOf(kind) {
    return kind === 'show' ? current().shows : current().movies
  }
  function keyOf(kind, value) {
    return kind === 'show' ? showKey(value) : movieKey(value)
  }
  function persist() {
    const out = { v: VERSION, movies: {}, shows: {} }
    for (const [k, rec] of current().movies) out.movies[k] = rec
    for (const [k, rec] of current().shows) out.shows[k] = rec
    writeJsonAtomic(file, out, { indent: 1 })
    const after = stamp()
    mtimeMs = after.m
    size = after.s
  }

  return {
    file,
    get(kind, value) {
      const key = keyOf(kind, value)
      return key ? groupOf(kind).get(key) || null : null
    },
    has(kind, value) {
      const key = keyOf(kind, value)
      return !!key && groupOf(kind).has(key)
    },
    /** Replaces the record for one title. `record` must already be sanitised (see edit()). */
    put(kind, value, record) {
      const key = keyOf(kind, value)
      if (!key) return { ok: false, error: 'bad_key' }
      const group = groupOf(kind)
      if (isEmptyRecord(record)) {
        if (group.delete(key)) persist()
        return { ok: true, removed: true }
      }
      if (!group.has(key) && group.size >= MAX_RECORDS) return { ok: false, error: 'too_many' }
      if (Buffer.byteLength(JSON.stringify(record)) > MAX_RECORD_BYTES) return { ok: false, error: 'too_large' }
      group.set(key, { ...record, updatedAt: now() })
      persist()
      return { ok: true }
    },
    remove(kind, value) {
      const key = keyOf(kind, value)
      if (!key) return false
      const removed = groupOf(kind).delete(key)
      if (removed) persist()
      return removed
    },
    /** Every artwork file some record still uses (so the rest can be deleted). */
    artworkInUse() {
      const used = new Set()
      for (const map of [current().movies, current().shows]) {
        for (const rec of map.values()) for (const role of ['poster', 'backdrop']) if (rec[role]) used.add(rec[role].file)
      }
      return used
    },
    size() {
      return current().movies.size + current().shows.size
    },
    snapshot() {
      const s = current()
      return { movies: Object.fromEntries(s.movies), shows: Object.fromEntries(s.shows) }
    },
    /** Adds records from a backup (each one cleaned like a stored one), replacing same-key records; one save. */
    importRecords(data, { keepArt = () => true } = {}) {
      const s = current()
      let count = 0
      for (const [group, map] of [['movies', s.movies], ['shows', s.shows]]) {
        const entries = data && isPlainObject(data[group]) ? Object.entries(data[group]) : []
        for (const [key, rec] of entries) {
          if (FORBIDDEN_KEYS.has(key) || !isPlainObject(rec) || (!map.has(key) && map.size >= MAX_RECORDS)) continue
          const clean = cleanRecord(rec)
          for (const role of ['poster', 'backdrop']) if (clean[role] && !keepArt(clean[role].file)) clean[role] = null
          if (isEmptyRecord(clean)) continue
          map.set(key, clean)
          count++
        }
      }
      if (count) persist()
      return count
    }
  }
}

const stores = new Map()
/** The store for one cache folder (one instance per folder, so every reader sees the same edits). */
function forDir(cacheDir) {
  if (!cacheDir || typeof cacheDir !== 'string') return null
  const file = path.join(cacheDir, FILE_NAME)
  if (!stores.has(file)) {
    if (stores.size > 8) stores.delete(stores.keys().next().value)
    stores.set(file, createStore({ file, recheckMs: 750 }))
  }
  return stores.get(file)
}

/**
 * Applies an editor submission to the stored record and saves it.
 *   patch: { fields: { title: { value, locked }, ... }, clear: ['tagline'], poster: <art ref|null>, backdrop: <art ref|null>, tmdbId }
 * Fields not mentioned keep their current setting; `clear` (or a null field) puts a field back to automatic.
 */
function edit(store, kind, value, patch) {
  if (!store) return { ok: false, error: 'no_cache_folder' }
  const before = store.get(kind, value)
  const base = before || { fields: {}, poster: null, backdrop: null, tmdbId: null, updatedAt: 0 }
  const next = { ...base, fields: { ...base.fields } }
  const p = isPlainObject(patch) ? patch : {}
  const cleaned = sanitiseFields(p.fields)
  if (!cleaned.ok) return { ok: false, error: 'invalid', errors: cleaned.errors }
  Object.assign(next.fields, cleaned.fields)
  for (const name of Array.isArray(p.clear) ? p.clear : []) if (FIELD_NAMES.includes(name)) delete next.fields[name]
  for (const role of ['poster', 'backdrop']) {
    if (!(role in p)) continue
    next[role] = p[role] === null ? null : cleanArtRef(p[role], role)
    if (p[role] !== null && !next[role]) return { ok: false, error: 'invalid', errors: { [role]: 'That image is not one Beebo has prepared.' } }
  }
  if (Number.isSafeInteger(p.tmdbId) && p.tmdbId > 0) next.tmdbId = p.tmdbId
  const saved = store.put(kind, value, next)
  return saved.ok ? { ok: true, record: store.get(kind, value), removed: !!saved.removed } : saved
}

/** "Reset to automatic": drops the whole record (artworkPicker.prune then removes image files nothing uses any more). */
function reset(store, kind, value) {
  if (!store) return { ok: false, error: 'no_cache_folder' }
  const before = store.get(kind, value)
  store.remove(kind, value)
  return { ok: true, hadRecord: !!before }
}

/** What the editor form needs to show: the stored record as plain values plus which fields are locked. */
function describe(record) {
  const fields = {}
  for (const [name, f] of Object.entries((record && record.fields) || {})) fields[name] = { value: f.value, locked: f.locked !== false }
  return {
    fields,
    poster: record && record.poster ? { file: record.poster.file, source: record.poster.source } : null,
    backdrop: record && record.backdrop ? { file: record.backdrop.file, source: record.backdrop.source } : null
  }
}

/** The owner's edits for a backup file (null when there are none). Prepared pictures are not included; the text is. */
function exportForBackup(cacheDir) {
  const store = forDir(cacheDir)
  return store && store.size() ? store.snapshot() : null
}

/** Puts backed-up edits back; a chosen picture whose file is not in this cache folder is dropped, the text kept. */
function importFromBackup(cacheDir, data) {
  const store = forDir(cacheDir)
  if (!store || !isPlainObject(data)) return 0
  return store.importRecords(data, { keepArt: (file) => fs.existsSync(path.join(cacheDir, 'artwork', file)) })
}

module.exports = {
  exportForBackup,
  importFromBackup,
  FILE_NAME,
  LIMITS,
  FIELD_NAMES,
  ALL_GENRES,
  cleanText,
  cleanGenres,
  cleanYear,
  cleanRating,
  cleanCertification,
  sanitiseFields,
  movieKey,
  showKey,
  syntheticCollectionId,
  customArtPath,
  customArtFile,
  customArtUrl,
  applyRecord,
  createStore,
  forDir,
  edit,
  reset,
  describe,
  ART_FILE_RE
}
