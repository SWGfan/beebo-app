'use strict'
// ============================================================================
// movieVersions.js - several files of ONE film ("versions"): 4K and 1080p, the
// Director's Cut next to the theatrical release. Pure: no fs, no ffprobe, no store.
// ----------------------------------------------------------------------------
// The library walk still lists every FILE (each one is scanned, probed, streamed
// and subtitled on its own id). This module only decides which files are one film:
//   - same TMDB id, or
//   - the same cleaned title + year (for files TMDB has not matched yet),
// and gives each file a human label ("4K HDR", "Director's Cut · 1080p") from what
// its name says (and, when the caller knows it, the real probed height).
// One file of each group is the PRIMARY: it keeps its id, so a client that has never
// heard of versions still sees exactly one entry per film, the primary's.
//
// Consumers: streamServer.js (phone list, web list, /playback/info), main.js and
// detailsIpc.js (desktop list), the duplicate finder (trueDuplicateSets), history and
// watched state (siblingsOf: progress is shared across the versions of a film).
// ============================================================================

const titleParse = require('./titleParse')

// ------------------------------------------------------------------ editions
// [canonical label, regex on the name (lower-cased, separators kept)]. First match wins.
// "bare" ones are one word that could be part of a title ("Extended Family"), so they
// only count after the year / a separator (see tagRegion()).
const EDITIONS = [
  ["Director's Cut", /director'?s?[\s._-]*(?:cut|edition|version)/, false],
  ['Final Cut', /final[\s._-]*cut/, false],
  ['Extended', /extended(?:[\s._-]*(?:cut|edition|version))?/, true],
  ['Theatrical', /theatrical(?:[\s._-]*(?:cut|edition|version|release))?/, true],
  ['IMAX', /imax(?:[\s._-]*(?:enhanced|edition|cut|version))?/, true],
  ['Unrated', /unrated(?:[\s._-]*(?:cut|edition|version))?/, true],
  ['Uncut', /uncut(?:[\s._-]*(?:edition|version))?/, true],
  ['Remastered', /(?:4k[\s._-]*)?remastered(?:[\s._-]*(?:edition|version))?/, true],
  ['Restored', /restored(?:[\s._-]*(?:edition|version))?/, true],
  ['Special Edition', /special[\s._-]*(?:edition|version)/, false],
  ['Ultimate Edition', /ultimate[\s._-]*(?:edition|cut|version)/, false],
  ["Collector's Edition", /collector'?s?[\s._-]*(?:edition|cut|version)/, false],
  ['Anniversary Edition', /(?:\d{1,3}(?:st|nd|rd|th)[\s._-]*)?anniversary[\s._-]*(?:edition|cut|version)/, false],
  ['Definitive Edition', /definitive[\s._-]*(?:edition|cut|version)/, false],
  ['Criterion', /criterion(?:[\s._-]*(?:collection|edition))?/, true],
  ['Redux', /redux/, true],
  ['Open Matte', /open[\s._-]*matte/, false],
  ['Black & White', /black[\s._-]*(?:and|&)[\s._-]*white/, false]
]

// Plex's own naming: "Movie (2010) {edition-Director's Cut}.mkv"
const PLEX_EDITION = /[{[]\s*edition[-=:\s]+([^}\]]{1,60}?)\s*[}\]]/i

function canonicalEdition(text, region) {
  const s = String(text || '').toLowerCase()
  for (const [label, re, bare] of EDITIONS) {
    const m = re.exec(s)
    if (!m) continue
    if (bare && region !== 'all') {
      // one bare word: only when it is not the very start of the name
      if (m.index === 0) continue
    }
    return label
  }
  return ''
}

function tidyEditionText(raw) {
  const t = String(raw || '').replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40)
  return t.replace(/(^|\s)([a-z])/g, (m, a, b) => a + b.toUpperCase())
}

// ---------------------------------------------------------------- resolution
const RES_RE = /(?<![a-z0-9])(?:(4320p|8k)|(2160p|2160i|4k|uhd)|(1080p|1080i|fhd)|(720p|720i)|(576p|576i)|(480p|480i|dvd[\s._-]?rip|dvdscr)|(360p))(?![a-z0-9])/i
const DIMS_RE = /(?<![0-9])(\d{3,4})\s?x\s?(\d{3,4})(?![0-9])/i
const HDR_RE = /(?<![a-z0-9])(dolby[\s._-]?vision|dovi|dv|hdr10\+|hdr10plus|hdr10|hdr|hlg)(?![a-z0-9])/i
const SOURCE_RE = /(?<![a-z0-9])(remux|blu[\s._-]?ray|bdrip|brrip|web[\s._-]?dl|webrip|hdtv|dvdrip|dvd)(?![a-z0-9])/i

function heightFromName(name) {
  const m = RES_RE.exec(name)
  if (m) {
    if (m[1]) return 4320
    if (m[2]) return 2160
    if (m[3]) return 1080
    if (m[4]) return 720
    if (m[5]) return 576
    if (m[6]) return 480
    if (m[7]) return 360
  }
  const d = DIMS_RE.exec(name)
  if (d) {
    const w = Number(d[1])
    const h = Number(d[2])
    // "1920x1080" is height 1080; a scope crop ("1920x800") still counts as 1080p by its width
    return heightClassOf(h, w)
  }
  return null
}

/** Nominal height (2160/1080/720/480) for a real frame size; width counts because scope film is cropped. */
function heightClassOf(height, width) {
  const h = Number(height) || 0
  const w = Number(width) || 0
  if (w >= 7000 || h >= 4000) return 4320
  if (w >= 3400 || h >= 1900) return 2160
  if (w >= 1800 || h >= 1000) return 1080
  if (w >= 1200 || h >= 660) return 720
  if (h >= 540) return 576
  if (h > 0 || w > 0) return 480
  return null
}

function hdrLabel(s) {
  const m = HDR_RE.exec(s)
  if (!m) return ''
  const t = m[1].toLowerCase().replace(/[\s._-]/g, '')
  if (t === 'dolbyvision' || t === 'dovi' || t === 'dv') return 'Dolby Vision'
  if (t === 'hdr10+' || t === 'hdr10plus') return 'HDR10+'
  if (t === 'hlg') return 'HLG'
  return 'HDR'
}

function sourceLabel(s) {
  if (/(?<![a-z0-9])remux(?![a-z0-9])/i.test(s)) return 'Remux'
  const m = SOURCE_RE.exec(s)
  if (!m) return ''
  const t = m[1].toLowerCase().replace(/[\s._-]/g, '')
  if (t === 'remux') return 'Remux'
  if (t === 'bluray' || t === 'bdrip' || t === 'brrip') return 'BluRay'
  if (t === 'webdl') return 'WEB-DL'
  if (t === 'webrip') return 'WEBRip'
  if (t === 'hdtv') return 'HDTV'
  return 'DVD'
}

function stem(fileName) {
  const base = String(fileName || '').split(/[\\/]/).pop()
  return base.replace(/\.[a-z0-9]{2,4}$/i, '')
}

// The part of the name after the year, where tags live ("Movie (2010) - Extended"): a bare
// edition word before the year is more likely part of the title.
function tagRegion(name) {
  const re = /(?<![0-9])(?:19|20)\d\d(?![0-9])/g
  let last = -1
  let m
  while ((m = re.exec(name))) last = m.index + 4
  return last >= 0 ? name.slice(last) : name
}

/**
 * What a file name says about this version.
 * { edition: '' | label, height: number|null, hdr: ''|'HDR'|'Dolby Vision'|..., source: ''|'Remux'|... }
 */
function parseVersionTags(fileName) {
  const name = stem(fileName)
  const lower = name.toLowerCase()
  let edition = ''
  const plex = PLEX_EDITION.exec(name)
  if (plex) {
    edition = canonicalEdition(plex[1], 'all') || tidyEditionText(plex[1])
  } else {
    edition = canonicalEdition(tagRegion(lower), 'tail')
  }
  return { edition, height: heightFromName(lower), hdr: hdrLabel(lower), source: sourceLabel(lower) }
}

function resolutionText(height) {
  const h = Number(height) || 0
  if (!h) return ''
  if (h >= 4000) return '8K'
  if (h >= 1900) return '4K'
  if (h >= 1000) return '1080p'
  if (h >= 660) return '720p'
  return 'SD'
}

function formatSize(bytes) {
  const b = Number(bytes) || 0
  if (!b) return ''
  if (b >= 1e9) return `${(b / 1e9).toFixed(b >= 1e10 ? 0 : 1)} GB`
  return `${Math.max(1, Math.round(b / 1e6))} MB`
}

// ------------------------------------------------------------------- grouping
function normTitle(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

const looseMemo = new Map()
/** "the matrix|1999" - the cleaned title + year a file name says. Memoised: parsing is the slow part. */
function looseKeyOf(fileName) {
  const k = String(fileName || '')
  let v = looseMemo.get(k)
  if (v !== undefined) return v
  let parsed = null
  try { parsed = titleParse.parseMovieTitle(k) } catch { parsed = null }
  const t = normTitle(parsed && parsed.title)
  v = t ? `${t}|${(parsed && parsed.year) || ''}` : ''
  if (looseMemo.size > 20000) looseMemo.clear()
  looseMemo.set(k, v)
  return v
}

// Best default for a client that knows nothing: an ordinary edition, then the highest
// resolution a phone / TV can be expected to play (<= 1080p) - a lone 4K file only when
// there is nothing else - then the biggest file. The client-aware choice (a 4K TV that CAN
// play the 4K one) is preferredVersion() below; this is only who keeps the old id.
function defaultRank(v) {
  const special = v.edition && v.edition !== 'Theatrical' ? 1 : 0
  const h = v.height || 0
  const over = h > 1080 ? 1 : 0
  return [special, over, over ? h : -h, -(v.sizeBytes || 0)]
}

function compareRank(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

function pickPrimary(versions) {
  return versions.slice().sort((a, b) => compareRank(defaultRank(a), defaultRank(b)) || (a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0))[0]
}

function orderVersions(versions) {
  return versions.slice().sort((a, b) =>
    ((a.edition ? 1 : 0) - (b.edition ? 1 : 0)) ||
    ((b.height || 0) - (a.height || 0)) ||
    ((b.sizeBytes || 0) - (a.sizeBytes || 0)) ||
    (a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0))
}

/** Unique, readable labels. See the tests for the rules. */
function assignLabels(versions) {
  const editionsDiffer = new Set(versions.map((v) => v.edition || '')).size > 1
  const resDiffers = new Set(versions.map((v) => `${resolutionText(v.height)}|${v.hdr}`)).size > 1
  const labels = versions.map((v) => {
    const parts = []
    if (v.edition) parts.push(v.edition)
    else if (editionsDiffer) parts.push('Standard')
    if (resDiffers || !parts.length) {
      const res = [resolutionText(v.height), v.hdr].filter(Boolean).join(' ')
      if (res) parts.push(res)
    }
    return parts.join(' · ')
  })
  // Still the same words? Tell them apart by release source, then by size, then by number.
  const refine = (pick) => {
    const seen = new Map()
    labels.forEach((l, i) => { if (!seen.has(l)) seen.set(l, []); seen.get(l).push(i) })
    for (const idx of seen.values()) {
      if (idx.length < 2) continue
      const extras = idx.map((i) => pick(versions[i]))
      if (new Set(extras).size < 2) continue
      idx.forEach((i, n) => { if (extras[n]) labels[i] = labels[i] ? `${labels[i]} · ${extras[n]}` : extras[n] })
    }
  }
  refine((v) => v.source)
  refine((v) => formatSize(v.sizeBytes))
  const used = new Map()
  return labels.map((l, i) => {
    const base = l || `Version ${i + 1}`
    const n = (used.get(base) || 0) + 1
    used.set(base, n)
    return n > 1 ? `${base} #${n}` : base
  })
}

/**
 * Group a movie file list into films.
 *   files:   [{ fileName, id?, size?|sizeBytes?, dir?, ... }] (any objects; returned untouched)
 *   options: metaOf(fileName) -> { id } | null    (the cached TMDB match)
 *            heightOf(file) -> real frame height class (2160/1080/...) | null   (probe / quality cache)
 *            hdrOf(file) -> 'HDR' | ... | ''      (probe)
 *            sizeOf(file) -> bytes, asked only for a file with siblings and no size of its own
 *            idOf(file) -> the id the API addresses the file by (default file.id || file.fileName)
 * Returns { groups, groupOfFile } where a group is
 *   { key, files, primary, versions: [{ id, fileName, label, height, hdr, edition, source, sizeBytes, isDefault, file }] }
 * `versions` is ordered best-first for display and always present (length 1 for a lone file).
 * Group order follows the first file of each group in the input, so a sorted list stays sorted.
 */
function groupMovieFiles(files, options = {}) {
  const { metaOf, heightOf, hdrOf, idOf, sizeOf } = options
  const list = Array.isArray(files) ? files : []
  const byKey = new Map()
  const order = []
  const looseToKey = new Map()
  const pending = []
  const infos = new Map()
  const infoOf = (f) => {
    let i = infos.get(f)
    if (!i) { i = { loose: looseKeyOf(f.fileName), tmdb: null }; infos.set(f, i) }
    return i
  }
  const push = (key, f) => {
    let g = byKey.get(key)
    if (!g) { g = { key, files: [] }; byKey.set(key, g); order.push(g) }
    g.files.push(f)
  }
  for (const f of list) {
    if (!f || !f.fileName) continue
    let meta = null
    if (typeof metaOf === 'function') { try { meta = metaOf(f.fileName) } catch { meta = null } }
    const inf = infoOf(f)
    if (meta && meta.id !== null && meta.id !== undefined && meta.id !== '') {
      inf.tmdb = `tmdb:${meta.id}`
      push(inf.tmdb, f)
      if (inf.loose && !looseToKey.has(inf.loose)) looseToKey.set(inf.loose, inf.tmdb)
    } else pending.push(f)
  }
  // Files TMDB has not matched (yet): join a matched film with the same cleaned title + year,
  // else group with each other by that title + year, else stand alone.
  for (const f of pending) {
    const inf = infoOf(f)
    if (!inf.loose) { push(`file:${f.fileName}`, f); continue }
    push(looseToKey.get(inf.loose) || `t:${inf.loose}`, f)
  }
  const groups = order.map((g) => {
    // The probes (a stat, a cache read) are only worth it for a film that really has 2+ files.
    const multi = g.files.length > 1
    const versions = g.files.map((f) => {
      const tags = parseVersionTags(f.fileName)
      let height = tags.height
      if (multi && typeof heightOf === 'function') { try { height = heightOf(f) || height } catch {} }
      let hdr = tags.hdr
      if (multi && typeof hdrOf === 'function') { try { hdr = hdrOf(f) || hdr } catch {} }
      let sizeBytes = Number(f.sizeBytes != null ? f.sizeBytes : f.size) || 0
      if (multi && !sizeBytes && typeof sizeOf === 'function') { try { sizeBytes = Number(sizeOf(f)) || 0 } catch {} }
      const id = typeof idOf === 'function' ? idOf(f) : (f.id != null ? f.id : f.fileName)
      return { id, fileName: f.fileName, label: '', height: height || null, hdr, edition: tags.edition, source: tags.source, sizeBytes, isDefault: false, file: f }
    })
    const primary = pickPrimary(versions)
    const ordered = orderVersions(versions)
    const labels = assignLabels(ordered)
    ordered.forEach((v, i) => { v.label = labels[i]; v.isDefault = v === primary })
    return { key: g.key, files: g.files, primary: primary.file, versions: ordered }
  })
  const groupOfFile = new Map()
  for (const g of groups) for (const f of g.files) groupOfFile.set(f.fileName, g)
  return { groups, groupOfFile }
}

/** The list a person sees: one file per film (the primary), in the input order. */
function primaryFiles(files, options) {
  const { groups } = groupMovieFiles(files, options)
  const keep = new Set(groups.map((g) => g.primary))
  return (Array.isArray(files) ? files : []).filter((f) => keep.has(f))
}

/** The public shape of a group's versions (only when there are 2+), or null. */
function publicVersions(group, { currentId } = {}) {
  if (!group || group.versions.length < 2) return null
  return group.versions.map((v) => {
    const o = { id: v.id, label: v.label, height: v.height, hdr: v.hdr, edition: v.edition, sizeBytes: v.sizeBytes, isDefault: v.isDefault }
    if (currentId !== undefined) o.isCurrent = v.id === currentId
    return o
  })
}

// ----------------------------------------------------------- client-aware pick
/**
 * The version a given client should open first.
 *   versions:  publicVersions() rows (optionally with `direct: { android, browser, cast }`)
 *   remembered: this user's earlier choice (a version id) - wins while it still exists
 *   prefs:     { quality } from /playback/prefs ('auto'|'original'|'1080p'|'720p'|'480p')
 *   capHeight: the household away-from-home cap (or null)
 * Without a remembered choice: stay under the quality cap, prefer a version that plays as it
 * is (no live conversion), then the tallest, then the server's default.
 */
function preferredVersion(versions, { remembered, prefs, capHeight } = {}) {
  if (!Array.isArray(versions) || !versions.length) return null
  if (remembered && versions.some((v) => v.id === remembered)) return remembered
  let cap = 0
  const q = String((prefs && prefs.quality) || '')
  if (/^\d{3,4}p$/.test(q)) cap = parseInt(q, 10)
  if (capHeight && (!cap || capHeight < cap)) cap = capHeight
  let pool = versions
  if (cap) {
    const under = versions.filter((v) => !v.height || v.height <= cap)
    pool = under.length ? under : [versions.slice().sort((a, b) => (a.height || 0) - (b.height || 0))[0]]
  }
  const playable = (v) => !v.direct || v.direct.android !== false
  const ranked = pool.slice().sort((a, b) =>
    ((playable(b) ? 1 : 0) - (playable(a) ? 1 : 0)) ||
    ((b.height || 0) - (a.height || 0)) ||
    ((b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0)))
  return ranked[0].id
}

// ------------------------------------------------------- true duplicate finder
/** 'edition|resolution class' - two files are TRUE duplicates only when this matches. */
function versionClassKey(tags, probedHeight) {
  const h = probedHeight || tags.height || 0
  return `${tags.edition || ''}|${h ? resolutionText(h) : '?'}`
}

/**
 * Splits the files of one film into sets of real duplicates. Only a set of 2+ is returned.
 * `heightOf(file)` gives a probed height when the name carries no resolution tag.
 * A file of unknown resolution is never called a duplicate of a known-resolution one.
 */
function trueDuplicateSets(files, { heightOf } = {}) {
  const sets = new Map()
  for (const f of files || []) {
    const tags = parseVersionTags(f.fileName || f.name || '')
    let probed = 0
    if (typeof heightOf === 'function') { try { probed = heightOf(f) || 0 } catch { probed = 0 } }
    const k = versionClassKey(tags, probed)
    if (!sets.has(k)) sets.set(k, [])
    sets.get(k).push(f)
  }
  return [...sets.values()].filter((s) => s.length > 1)
}

// ----------------------------------------------------- shared progress (siblings)
let siblingResolver = null
/**
 * The server registers how to find the other files of a film; history.js and watchedState.js
 * ask here so "watched" and "where I left off" are one thing per film, not per file.
 * Nothing registered (tests, other callers): a file's only sibling is itself.
 */
function setSiblingResolver(fn) { siblingResolver = typeof fn === 'function' ? fn : null }
function siblingsOf(fileName) {
  const name = String(fileName || '')
  if (!siblingResolver || !name) return [name]
  try {
    const s = siblingResolver(name)
    return Array.isArray(s) && s.length ? s : [name]
  } catch { return [name] }
}

// --------------------------------------------------- remembered per-user choice
const MAX_USERS = 500
const MAX_CHOICES = 300
/** { [userKey]: { [groupKey]: versionId } } -> new object with `choice` stored, bounded. */
function rememberChoice(all, userKey, groupKey, versionId) {
  const next = { ...(all && typeof all === 'object' ? all : {}) }
  const mine = { ...(next[userKey] || {}) }
  delete mine[groupKey] // re-insert last so it counts as the newest
  if (versionId) mine[groupKey] = String(versionId).slice(0, 600)
  const gk = Object.keys(mine)
  if (gk.length > MAX_CHOICES) for (const k of gk.slice(0, gk.length - MAX_CHOICES)) delete mine[k]
  delete next[userKey]
  next[userKey] = mine
  const uk = Object.keys(next)
  if (uk.length > MAX_USERS) for (const k of uk.slice(0, uk.length - MAX_USERS)) delete next[k]
  return next
}

module.exports = {
  parseVersionTags,
  heightClassOf,
  resolutionText,
  groupMovieFiles,
  primaryFiles,
  publicVersions,
  preferredVersion,
  versionClassKey,
  trueDuplicateSets,
  setSiblingResolver,
  siblingsOf,
  rememberChoice,
  looseKeyOf,
  formatSize
}
