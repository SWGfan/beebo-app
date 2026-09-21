// libraryFilters.js - the filter engine behind the Movies / TV Shows filter bar. Pure (no React,
// no IPC), so node --test checks it (test/library-filters.test.js).
//
// A "filter set" is one small plain object (see EMPTY_FILTERS). It is what a saved view stores and
// what a shared preset carries, so it is always passed through normalizeFilters() on the way in:
// a hand-edited file, an old version or a pasted preset can never put a wrong type in the engine.
//
// Rows are the objects libraryColumns.js builds (buildMovieRow / buildShowRow). Some criteria are
// known the moment the library is scanned (genre, year, rating, size, added date). Others need
// what the app reads from the video files in the background (HDR, codec, subtitles, runtime) or
// the owner's watched marks, and those arrive later. Until they do, a row that has not been read
// is PENDING rather than "no match": evaluateRow answers 1 (match), 0 (no match) or -1 (pending),
// applyFilters keeps only the matches and reports how many are still pending so the screen can say
// "reading file details..." and refresh as they arrive.

import { classifyResolution } from './videoResolution.js'

export const RESOLUTION_BUCKETS = ['4K', '1080p', '720p', 'SD']

export const CODEC_OPTIONS = [
  { key: 'h264', label: 'H.264' },
  { key: 'hevc', label: 'HEVC (H.265)' },
  { key: 'av1', label: 'AV1' },
  { key: 'vp9', label: 'VP9' },
  { key: 'mpeg4', label: 'MPEG-4 / DivX' },
  { key: 'mpeg2', label: 'MPEG-2' },
  { key: 'other', label: 'Other' }
]
const CODEC_KEYS = new Set(CODEC_OPTIONS.map((c) => c.key))

export const ADDED_OPTIONS = [
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 3 months' },
  { days: 365, label: 'Last year' }
]

const DAY_MS = 86400000
const GIB = 1024 ** 3

export const EMPTY_FILTERS = Object.freeze({
  genres: Object.freeze([]), // any of these genre names
  yearMin: null,
  yearMax: null,
  ratingMin: null, // TMDB rating out of 10
  resolutions: Object.freeze([]), // any of RESOLUTION_BUCKETS
  hdr: 'any', // 'any' | 'hdr' | 'sdr'
  codecs: Object.freeze([]), // any of CODEC_OPTIONS keys
  watched: 'any', // 'any' | 'watched' | 'unwatched'
  inProgress: false,
  subtitles: 'any', // 'any' | 'yes' | 'no'   (subtitle tracks inside the file)
  sizeMinGB: null,
  sizeMaxGB: null,
  runtimeMin: null, // minutes
  runtimeMax: null,
  person: '', // an actor's (or director's) name, or part of it
  addedDays: null // added within this many days
})

// ------------------------------------------------------------------ cleaning

const finiteIn = (v, min, max) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n >= min && n <= max ? n : null
}

const stringList = (raw, { max = 40, len = 60, allowed = null } = {}) => {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const s = item.trim().slice(0, len)
    if (!s || (allowed && !allowed.has(s))) continue
    if (!out.includes(s)) out.push(s)
    if (out.length >= max) break
  }
  return out
}

const oneOf = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback)

/** Any input -> a complete, safe filter set. Unknown keys are dropped; bad values become "off". */
export function normalizeFilters(raw) {
  const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  let yearMin = finiteIn(s.yearMin, 1800, 2200)
  let yearMax = finiteIn(s.yearMax, 1800, 2200)
  if (yearMin !== null) yearMin = Math.round(yearMin)
  if (yearMax !== null) yearMax = Math.round(yearMax)
  if (yearMin !== null && yearMax !== null && yearMin > yearMax) [yearMin, yearMax] = [yearMax, yearMin]
  let sizeMinGB = finiteIn(s.sizeMinGB, 0, 100000)
  let sizeMaxGB = finiteIn(s.sizeMaxGB, 0, 100000)
  if (sizeMinGB !== null && sizeMaxGB !== null && sizeMinGB > sizeMaxGB) [sizeMinGB, sizeMaxGB] = [sizeMaxGB, sizeMinGB]
  let runtimeMin = finiteIn(s.runtimeMin, 0, 100000)
  let runtimeMax = finiteIn(s.runtimeMax, 0, 100000)
  if (runtimeMin !== null && runtimeMax !== null && runtimeMin > runtimeMax) [runtimeMin, runtimeMax] = [runtimeMax, runtimeMin]
  const addedDays = finiteIn(s.addedDays, 1, 36500)
  return {
    genres: stringList(s.genres),
    yearMin,
    yearMax,
    ratingMin: finiteIn(s.ratingMin, 0, 10),
    resolutions: stringList(s.resolutions, { allowed: new Set(RESOLUTION_BUCKETS) }),
    hdr: oneOf(s.hdr, ['any', 'hdr', 'sdr'], 'any'),
    codecs: stringList(s.codecs, { allowed: CODEC_KEYS }),
    watched: oneOf(s.watched, ['any', 'watched', 'unwatched'], 'any'),
    inProgress: s.inProgress === true,
    subtitles: oneOf(s.subtitles, ['any', 'yes', 'no'], 'any'),
    sizeMinGB,
    sizeMaxGB,
    runtimeMin,
    runtimeMax,
    person: typeof s.person === 'string' ? s.person.trim().slice(0, 80) : '',
    addedDays: addedDays === null ? null : Math.round(addedDays)
  }
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/** How many separate criteria are switched on (the badge on the Filters button). */
export function activeFilterCount(filters) {
  const f = normalizeFilters(filters)
  let n = 0
  if (f.genres.length) n++
  if (f.yearMin !== null || f.yearMax !== null) n++
  if (f.ratingMin !== null) n++
  if (f.resolutions.length) n++
  if (f.hdr !== 'any') n++
  if (f.codecs.length) n++
  if (f.watched !== 'any') n++
  if (f.inProgress) n++
  if (f.subtitles !== 'any') n++
  if (f.sizeMinGB !== null || f.sizeMaxGB !== null) n++
  if (f.runtimeMin !== null || f.runtimeMax !== null) n++
  if (f.person) n++
  if (f.addedDays !== null) n++
  return n
}

export const isFiltersEmpty = (filters) => activeFilterCount(filters) === 0

/** Same criteria (whatever the key order or the input's cleanliness). */
export const filtersEqual = (a, b) => same(normalizeFilters(a), normalizeFilters(b))

// ------------------------------------------------------------------ what a filter set needs loaded

/**
 * What the screen has to fetch before the filter can be answered for every row:
 *   probe  - the video files have to be read (HDR, codec, subtitles, runtime)
 *   marks  - the owner's watched marks and progress
 *   people - the cast lists
 */
export function filterNeeds(filters) {
  const f = normalizeFilters(filters)
  return {
    probe: f.hdr !== 'any' || f.codecs.length > 0 || f.subtitles !== 'any' || f.runtimeMin !== null || f.runtimeMax !== null,
    marks: f.watched !== 'any' || f.inProgress,
    people: f.person !== ''
  }
}

// ------------------------------------------------------------------ small readers

/** 8K/4K -> '4K', 1440p/1080p -> '1080p', 720p -> '720p', 480p/SD -> 'SD'; null when it is not a resolution. */
export function resolutionBucket(label) {
  switch (label) {
    case '8K':
    case '4K': return '4K'
    case '1440p':
    case '1080p': return '1080p'
    case '720p': return '720p'
    case '480p':
    case 'SD': return 'SD'
    default: return null
  }
}

/** ffprobe's codec name -> one of CODEC_OPTIONS keys ('' when unknown). */
export function codecKey(name) {
  const c = String(name || '').toLowerCase()
  if (!c) return ''
  if (c === 'h264' || c === 'avc1' || c === 'avc') return 'h264'
  if (c === 'hevc' || c === 'h265' || c === 'hev1') return 'hevc'
  if (c === 'av1') return 'av1'
  if (c === 'vp9') return 'vp9'
  if (c === 'mpeg4' || c === 'msmpeg4v3' || c === 'msmpeg4v2' || c === 'msmpeg4v1') return 'mpeg4'
  if (c === 'mpeg2video') return 'mpeg2'
  return 'other'
}

const probed = (info) => !!(info && info.probed && !info.failed)

// A probe result for a row the file of which cannot be read is a firm "unknown", not pending.
const infoState = (row, info) => {
  if (probed(info)) return 'ok'
  if (!row.probePath) return 'none'
  if (info && info.probed) return 'none' // read, but failed
  return 'pending'
}

/** The resolution class of a row for filtering: its own file when read, else the app's quality tier. */
export function rowResolution(row, info) {
  if (row.kind === 'tv') return row.tierBest || row.tierLabel || (probed(info) ? classifyResolution(info.width, info.height) : null)
  if (probed(info)) {
    const c = classifyResolution(info.width, info.height)
    if (c && c !== 'Other') return c
  }
  return row.tierLabel || null
}

const foldName = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()

// ------------------------------------------------------------------ evaluating

// Each check returns true / false / null (null = cannot tell yet).
function resolutionCheck(f, row, info) {
  const label = rowResolution(row, info)
  const bucket = resolutionBucket(label)
  if (bucket) return f.resolutions.includes(bucket)
  // Nothing known yet: the file may still be read, or the tier still loading.
  return infoState(row, info) === 'pending' ? null : false
}

function watchedOf(row, marks) {
  if (row.kind === 'tv') {
    const keys = row.epKeys || []
    if (!keys.length) return { all: false, some: false }
    let n = 0
    for (const k of keys) if (marks.watchedEpisodes.has(k)) n++
    return { all: n === keys.length, some: n > 0 }
  }
  const on = marks.watchedMovies.has(row.fileName)
  return { all: on, some: on }
}

/**
 * The row's progress for "in progress": a number 1-99 while part-watched, else 0.
 * A show also counts as in progress when some (not all) of its episodes are watched.
 */
export function rowProgress(row, marks, progressOf) {
  if (!marks) return 0
  const p = progressOf ? Number(progressOf(row)) : 0
  if (p > 0) return p
  if (row.kind === 'tv') {
    const w = watchedOf(row, marks)
    if (w.some && !w.all) return 50
  }
  return 0
}

/**
 * 1 = the row matches every switched-on criterion, 0 = it fails one, -1 = nothing failed yet but
 * some answer is still being read. `ctx`:
 *   infoOf(row)      the row's file details record, or undefined
 *   marks            null = not loaded yet, false = not available (viewing privacy), else { watchedMovies, watchedEpisodes, watchlistMovies } Sets
 *   progressOf(row)  percent 0-100 of a part-watched row (or 0)
 *   peopleOf(row)    names of the row's cast (and director), or undefined while not loaded
 *   addedOf(row)     epoch ms the row was added (default: its file date)
 *   now              epoch ms
 */
export function evaluateRow(row, filters, ctx = {}) {
  const f = filters
  const info = ctx.infoOf ? ctx.infoOf(row) : undefined
  let pending = false
  const need = (answer) => {
    if (answer === null) { pending = true; return true }
    return answer
  }

  if (f.genres.length) {
    const have = (row.genres || []).map(foldName)
    if (!f.genres.some((g) => have.includes(foldName(g)))) return 0
  }
  if (f.yearMin !== null || f.yearMax !== null) {
    if (row.year === null || row.year === undefined) return 0
    if (f.yearMin !== null && row.year < f.yearMin) return 0
    if (f.yearMax !== null && row.year > f.yearMax) return 0
  }
  if (f.ratingMin !== null) {
    if (!(Number(row.rating) >= f.ratingMin)) return 0
  }
  if (f.sizeMinGB !== null || f.sizeMaxGB !== null) {
    if (row.sizeBytes === null || row.sizeBytes === undefined) return 0
    if (f.sizeMinGB !== null && row.sizeBytes < f.sizeMinGB * GIB) return 0
    if (f.sizeMaxGB !== null && row.sizeBytes > f.sizeMaxGB * GIB) return 0
  }
  if (f.addedDays !== null) {
    const added = ctx.addedOf ? ctx.addedOf(row) : row.mtimeMs
    const now = Number.isFinite(ctx.now) ? ctx.now : Date.now()
    if (!(added > 0) || now - added > f.addedDays * DAY_MS) return 0
  }
  if (f.resolutions.length && !need(resolutionCheck(f, row, info))) return 0

  if (f.hdr !== 'any') {
    const st = infoState(row, info)
    if (st === 'ok') {
      const isHdr = !!info.hdr && info.hdr !== 'SDR'
      if (f.hdr === 'hdr' ? !isHdr : isHdr) return 0
    } else if (!need(st === 'pending' ? null : false)) return 0
  }
  if (f.codecs.length) {
    const st = infoState(row, info)
    if (st === 'ok') {
      if (!f.codecs.includes(codecKey(info.videoCodec) || 'other')) return 0
    } else if (!need(st === 'pending' ? null : false)) return 0
  }
  if (f.subtitles !== 'any') {
    const st = infoState(row, info)
    if (st === 'ok') {
      const has = Number(info.subCount) > 0 || (info.subLangs || []).length > 0
      if (f.subtitles === 'yes' ? !has : has) return 0
    } else if (!need(st === 'pending' ? null : false)) return 0
  }
  if (f.runtimeMin !== null || f.runtimeMax !== null) {
    const st = infoState(row, info)
    if (st === 'ok') {
      const minutes = Number(info.durationSec) / 60
      if (!(minutes > 0)) return 0
      if (f.runtimeMin !== null && minutes < f.runtimeMin) return 0
      if (f.runtimeMax !== null && minutes > f.runtimeMax) return 0
    } else if (!need(st === 'pending' ? null : false)) return 0
  }

  // The owner's marks: `false` (unavailable) switches these criteria off rather than emptying the view.
  const marks = ctx.marks
  if (f.watched !== 'any' && marks !== false) {
    if (marks === null || marks === undefined) pending = true
    else {
      const w = watchedOf(row, marks)
      if (f.watched === 'watched' ? !w.all : w.some) return 0
    }
  }
  if (f.inProgress && marks !== false) {
    if (marks === null || marks === undefined) pending = true
    else if (!(rowProgress(row, marks, ctx.progressOf) > 0)) return 0
  }

  if (f.person) {
    const names = ctx.peopleOf ? ctx.peopleOf(row) : undefined
    if (names === undefined) pending = true
    else {
      const q = foldName(f.person)
      if (!names.some((n) => foldName(n).includes(q))) return 0
    }
  }
  return pending ? -1 : 1
}

/**
 * The rows that pass, in their original order, and how many are still undecided:
 * { rows, pending, active }. With nothing switched on the very same array comes back
 * (no copy, no per-row work).
 */
export function applyFilters(rows, filters, ctx = {}) {
  const f = normalizeFilters(filters)
  if (activeFilterCount(f) === 0) return { rows, pending: 0, active: false }
  const out = []
  let pending = 0
  for (const row of rows) {
    const v = evaluateRow(row, f, ctx)
    if (v === 1) out.push(row)
    else if (v === -1) pending++
  }
  return { rows: out, pending, active: true }
}

// ------------------------------------------------------------------ describing (chips)

const fmtNum = (n) => String(Math.round(n * 100) / 100)

/**
 * One chip per switched-on criterion: [{ key, label }]. `key` is the field group to reset with
 * clearFilterKey(); labels are plain words, ready to show.
 */
export function describeFilters(filters) {
  const f = normalizeFilters(filters)
  const chips = []
  if (f.genres.length) chips.push({ key: 'genres', label: f.genres.join(' / ') })
  if (f.yearMin !== null || f.yearMax !== null) {
    const label = f.yearMin !== null && f.yearMax !== null ? (f.yearMin === f.yearMax ? `${f.yearMin}` : `${f.yearMin}-${f.yearMax}`) : f.yearMin !== null ? `${f.yearMin} or later` : `${f.yearMax} or earlier`
    chips.push({ key: 'year', label })
  }
  if (f.ratingMin !== null) chips.push({ key: 'ratingMin', label: `Rated ${fmtNum(f.ratingMin)}+` })
  if (f.resolutions.length) chips.push({ key: 'resolutions', label: f.resolutions.join(' / ') })
  if (f.hdr !== 'any') chips.push({ key: 'hdr', label: f.hdr === 'hdr' ? 'HDR' : 'SDR only' })
  if (f.codecs.length) chips.push({ key: 'codecs', label: f.codecs.map((k) => (CODEC_OPTIONS.find((c) => c.key === k) || { label: k }).label).join(' / ') })
  if (f.watched !== 'any') chips.push({ key: 'watched', label: f.watched === 'watched' ? 'Watched' : 'Unwatched' })
  if (f.inProgress) chips.push({ key: 'inProgress', label: 'In progress' })
  if (f.subtitles !== 'any') chips.push({ key: 'subtitles', label: f.subtitles === 'yes' ? 'Has subtitles' : 'No subtitles' })
  if (f.sizeMinGB !== null || f.sizeMaxGB !== null) {
    const label = f.sizeMinGB !== null && f.sizeMaxGB !== null ? `${fmtNum(f.sizeMinGB)}-${fmtNum(f.sizeMaxGB)} GB` : f.sizeMinGB !== null ? `Over ${fmtNum(f.sizeMinGB)} GB` : `Under ${fmtNum(f.sizeMaxGB)} GB`
    chips.push({ key: 'size', label })
  }
  if (f.runtimeMin !== null || f.runtimeMax !== null) {
    const label = f.runtimeMin !== null && f.runtimeMax !== null ? `${fmtNum(f.runtimeMin)}-${fmtNum(f.runtimeMax)} min` : f.runtimeMin !== null ? `Over ${fmtNum(f.runtimeMin)} min` : `Under ${fmtNum(f.runtimeMax)} min`
    chips.push({ key: 'runtime', label })
  }
  if (f.person) chips.push({ key: 'person', label: `With ${f.person}` })
  if (f.addedDays !== null) {
    const opt = ADDED_OPTIONS.find((o) => o.days === f.addedDays)
    chips.push({ key: 'added', label: `Added: ${opt ? opt.label.toLowerCase() : `last ${f.addedDays} days`}` })
  }
  return chips
}

/** The filter set with one chip's criterion switched off. */
export function clearFilterKey(filters, key) {
  const f = normalizeFilters(filters)
  const blank = normalizeFilters(null)
  switch (key) {
    case 'year': return { ...f, yearMin: null, yearMax: null }
    case 'size': return { ...f, sizeMinGB: null, sizeMaxGB: null }
    case 'runtime': return { ...f, runtimeMin: null, runtimeMax: null }
    case 'added': return { ...f, addedDays: null }
    default: return key in blank ? { ...f, [key]: blank[key] } : f
  }
}

// ------------------------------------------------------------------ options for the panel

/** Genre names present in `rows` with how many rows carry each, most common first. */
export function genreCountsOf(rows) {
  const counts = new Map()
  for (const row of rows) for (const g of new Set(row.genres || [])) counts.set(g, (counts.get(g) || 0) + 1)
  return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

/** The lowest and highest release year in `rows`; null when none has one. */
export function yearSpanOf(rows) {
  let lo = null
  let hi = null
  for (const row of rows) {
    if (row.year === null || row.year === undefined) continue
    if (lo === null || row.year < lo) lo = row.year
    if (hi === null || row.year > hi) hi = row.year
  }
  return lo === null ? null : { min: lo, max: hi }
}
