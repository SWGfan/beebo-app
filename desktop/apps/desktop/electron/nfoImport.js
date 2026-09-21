'use strict'
// ============================================================================
// nfoImport.js - read-only import of information other media servers left next to files.
// ----------------------------------------------------------------------------
// Kodi, Jellyfin and Emby write <video name>.nfo (movies) and tvshow.nfo (in a show's folder);
// Plex users often keep a .plexmatch file. Moving a library from one of them to Beebo should not
// mean losing hand-fixed titles and ids, so they are read here. Nothing is ever written or
// renamed, and a bad file only means "no information".
//
// Priority (metadataMerge.js): an owner's edit in Beebo beats what an .nfo says, which beats
// what TMDB says for a match made from the file name.
//
// The XML reader is deliberately tiny and cannot be talked into anything:
//   - a DOCTYPE, its internal subset and every entity declaration inside are skipped, never
//     expanded; only &lt; &gt; &amp; &quot; &apos; and numeric references are decoded, so a
//     "billion laughs" file is just a few kilobytes of ignored text;
//   - no external entity, no network, no file access, no script;
//   - the file is capped at MAX_BYTES, depth at MAX_DEPTH and the element count at MAX_NODES;
//   - every value that comes out goes through the same cleaning as a hand-typed edit.
// ============================================================================

const fs = require('fs')
const path = require('path')
const titleParse = require('./titleParse')
const mo = require('./metadataOverrides')
const { scanAttrs } = require('./xmlLite')

const MAX_BYTES = 512 * 1024
const MAX_DEPTH = 24
const MAX_NODES = 5000
const MAX_ATTRS = 16
const PLEXMATCH_MAX_BYTES = 16 * 1024
const DIR_TTL_MS = 30 * 1000
const MAX_DIRS = 64
const MAX_PARSED = 4000
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp']
const VIDEO_EXT_RE = /\.(mp4|mkv|avi|mov|wmv|m4v|webm)$/i
const MOVIE_POSTER_SUFFIXES = ['-poster', '-cover', '-folder', '']
const MOVIE_BACKDROP_SUFFIXES = ['-fanart', '-backdrop', '-background', '-landscape']
const SHOW_POSTER_NAMES = ['poster', 'folder', 'cover', 'default', 'show']
const SHOW_BACKDROP_NAMES = ['fanart', 'backdrop', 'background', 'art', 'landscape']

// ---------------------------------------------------------------- decoding

/** File bytes -> text. Understands UTF-8 (with or without a BOM), UTF-16 with a BOM and the Latin-1 family an old Kodi wrote. */
function decodeBytes(buf) {
  if (!Buffer.isBuffer(buf)) return ''
  try {
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2))
    if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2))
    const start = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0
    const head = buf.subarray(start, start + 200).toString('latin1')
    const declared = /^\s*<\?xml[^>]*encoding\s*=\s*["']([A-Za-z0-9_-]+)["']/i.exec(head)
    const enc = declared ? declared[1].toLowerCase() : 'utf-8'
    if (/^(iso-8859-1|latin1|latin-1|windows-1252|cp1252|iso-8859-15)$/.test(enc)) return new TextDecoder('windows-1252').decode(buf.subarray(start))
    return new TextDecoder('utf-8').decode(buf.subarray(start))
  } catch {
    return ''
  }
}

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

/** Decodes the five predefined entities and numeric references. Any other &name; stays as typed: nothing is expanded. */
function decodeEntities(text) {
  if (text.indexOf('&') === -1) return text
  return text.replace(/&(#x[0-9A-Fa-f]{1,6}|#[0-9]{1,7}|[A-Za-z]{2,6});/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      const control = code < 32 && code !== 9 && code !== 10 && code !== 13
      if (!Number.isInteger(code) || control || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return ''
      return String.fromCodePoint(code)
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, body) ? ENTITIES[body] : whole
  })
}

// ---------------------------------------------------------------- the parser

function skipDoctype(text, from) {
  // <!DOCTYPE name [ ...internal subset with <!ENTITY ...> declarations... ]>: skip to the matching '>'.
  let i = from + 9
  let depth = 0
  let quote = ''
  while (i < text.length) {
    const c = text[i]
    if (quote) {
      if (c === quote) quote = ''
    } else if (c === '"' || c === "'") quote = c
    else if (c === '[') depth++
    else if (c === ']') depth = Math.max(0, depth - 1)
    else if (c === '>' && depth === 0) return i + 1
    i++
  }
  return text.length
}

function parseAttrs(source) {
  const attrs = {}
  let n = 0
  // xmlLite.scanAttrs is one pass with no backtracking: the regex that used to sit here was quadratic on a
  // tag holding a long run of name characters, and a sidecar .nfo that arrived with a download can hold one.
  for (const a of scanAttrs(source, { strict: true })) {
    if (n >= MAX_ATTRS) break
    const name = a.name.toLowerCase()
    if (name === '__proto__' || name === 'constructor') continue
    attrs[name] = decodeEntities(a.raw).slice(0, 200)
    n++
  }
  return attrs
}

/**
 * Text -> { name, attrs, children, text } for the first element found, or null. Lenient about the
 * things real .nfo files get wrong (an unescaped &, a stray close tag, text before the root) and
 * strict about limits. `leading` is whatever text came before the root (Kodi allows a bare URL).
 */
function parseXml(input) {
  if (typeof input !== 'string' || !input) return null
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input
  const rootStart = text.indexOf('<')
  if (rootStart === -1) return null
  const stack = []
  let root = null
  let nodes = 0
  let i = rootStart
  const len = text.length
  while (i < len) {
    const lt = text.indexOf('<', i)
    if (lt === -1) {
      if (stack.length) stack[stack.length - 1].text += decodeEntities(text.slice(i))
      break
    }
    if (lt > i && stack.length) stack[stack.length - 1].text += decodeEntities(text.slice(i, lt))
    i = lt
    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4)
      i = end === -1 ? len : end + 3
    } else if (text.startsWith('<![CDATA[', i)) {
      const end = text.indexOf(']]>', i + 9)
      const body = end === -1 ? text.slice(i + 9) : text.slice(i + 9, end)
      if (stack.length) stack[stack.length - 1].text += body
      i = end === -1 ? len : end + 3
    } else if (text.startsWith('<?', i)) {
      const end = text.indexOf('?>', i + 2)
      i = end === -1 ? len : end + 2
    } else if (text.startsWith('<!', i)) {
      i = /^<!doctype/i.test(text.slice(i, i + 9)) ? skipDoctype(text, i) : (text.indexOf('>', i) + 1 || len)
    } else if (text[i + 1] === '/') {
      const end = text.indexOf('>', i)
      const name = text.slice(i + 2, end === -1 ? len : end).trim().toLowerCase()
      const at = stack.map((n) => n.name).lastIndexOf(name)
      if (at !== -1) stack.length = at
      i = end === -1 ? len : end + 1
      if (!stack.length && root) break
    } else {
      const end = findTagEnd(text, i)
      if (end === -1) break
      const body = text.slice(i + 1, end)
      const selfClosing = body.endsWith('/')
      const m = /^([A-Za-z_][\w:.-]*)([\s\S]*)$/.exec(selfClosing ? body.slice(0, -1) : body)
      i = end + 1
      if (!m) continue
      if (++nodes > MAX_NODES || stack.length >= MAX_DEPTH) return root
      const node = { name: m[1].toLowerCase(), attrs: parseAttrs(m[2]), children: [], text: '' }
      if (stack.length) stack[stack.length - 1].children.push(node)
      else if (!root) root = node
      else break
      if (!selfClosing) stack.push(node)
    }
  }
  return root
}

function findTagEnd(text, from) {
  let quote = ''
  for (let i = from + 1; i < text.length; i++) {
    const c = text[i]
    if (quote) { if (c === quote) quote = '' } else if (c === '"' || c === "'") quote = c
    else if (c === '>') return i
  }
  return -1
}

// ---------------------------------------------------------------- reading a Kodi/Jellyfin/Emby .nfo

const child = (node, name) => (node ? node.children.find((c) => c.name === name) || null : null)
const kids = (node, name) => (node ? node.children.filter((c) => c.name === name) : [])
const own = (node) => (node ? node.text.trim() : '')

function firstText(node, names) {
  for (const n of names) {
    const v = own(child(node, n))
    if (v) return v
  }
  return ''
}

function certificationFrom(text) {
  let s = String(text || '').trim()
  if (!s) return null
  s = s.split(/[|,;]/)[0].trim().replace(/^rated\s+/i, '').replace(/^[A-Za-z][A-Za-z ]{1,20}:\s*/, '')
  const cert = mo.cleanCertification(s)
  return cert || null
}

function ratingFrom(node) {
  const ratings = child(node, 'ratings')
  const list = ratings ? kids(ratings, 'rating') : []
  const pick = list.find((r) => (r.attrs.default || '').toLowerCase() === 'true') || list[0]
  const raw = pick ? own(child(pick, 'value')) || own(pick) : own(child(node, 'rating'))
  const max = pick ? Number(pick.attrs.max) : 10
  const n = Number(String(raw).replace(',', '.'))
  if (!Number.isFinite(n) || n <= 0) return null
  const scaled = max > 0 && max !== 10 ? (n / max) * 10 : n
  const clean = mo.cleanRating(scaled)
  return typeof clean === 'number' ? clean : null
}

const IMDB_RE = /\btt\d{6,10}\b/
const POS_INT = (v) => (/^\d{1,9}$/.test(String(v).trim()) && Number(v) > 0 ? Number(v) : null)

function idsFrom(node, leading) {
  const ids = { tmdbId: null, imdbId: null, tvdbId: null }
  const uniq = kids(node, 'uniqueid')
  const byType = (t) => {
    const hit = uniq.find((u) => (u.attrs.type || '').toLowerCase() === t)
    return hit ? own(hit) : ''
  }
  ids.tmdbId = POS_INT(own(child(node, 'tmdbid')) || byType('tmdb'))
  ids.tvdbId = POS_INT(own(child(node, 'tvdbid')) || byType('tvdb'))
  const imdb = own(child(node, 'imdbid')) || byType('imdb') || own(child(node, 'imdb_id')) || own(child(node, 'id'))
  const im = IMDB_RE.exec(imdb)
  ids.imdbId = im ? im[0] : null
  const idText = own(child(node, 'id'))
  if (!ids.tmdbId && !ids.tvdbId && POS_INT(idText) && node.name === 'tvshow') ids.tvdbId = POS_INT(idText)
  for (const url of String(leading || '').match(/https?:\/\/[^\s<>"']{1,200}/g) || []) {
    const t = /themoviedb\.org\/(?:movie|tv)\/(\d{1,9})/.exec(url)
    if (t && !ids.tmdbId) ids.tmdbId = Number(t[1])
    const i = IMDB_RE.exec(url)
    if (i && !ids.imdbId) ids.imdbId = i[0]
  }
  return ids
}

function yearFrom(node) {
  for (const raw of [own(child(node, 'year')), own(child(node, 'premiered')), own(child(node, 'releasedate')), own(child(node, 'aired')), own(child(node, 'firstaired'))]) {
    const m = /^(\d{4})/.exec(raw)
    if (m) {
      const y = mo.cleanYear(m[1])
      if (y) return y
    }
  }
  return ''
}

function genresFrom(node) {
  const names = []
  for (const g of kids(node, 'genre')) for (const part of own(g).split(/\s+\/\s+|[|;]/)) if (part.trim()) names.push(part.trim())
  return names
}

function collectionFrom(node) {
  const set = child(node, 'set')
  const name = set ? own(child(set, 'name')) || (set.children.length ? '' : own(set)) : ''
  return name ? mo.cleanText(name, mo.LIMITS.collection) : ''
}

function truthy(v) {
  return /^(true|yes|1)$/i.test(String(v || '').trim())
}

/**
 * The text of an .nfo -> { kind, title, ... } or null when it is not one. Every field is cleaned like a
 * hand-typed edit and left out when it is empty or invalid; nothing here throws.
 */
function parseNfo(input) {
  try {
    const text = Buffer.isBuffer(input) ? decodeBytes(input.subarray(0, MAX_BYTES)) : typeof input === 'string' ? input.slice(0, MAX_BYTES) : ''
    if (!text) return null
    const root = parseXml(text)
    if (!root || !['movie', 'tvshow', 'episodedetails'].includes(root.name)) return null
    const leading = text.slice(0, Math.max(0, text.indexOf('<')))
    const hint = { kind: root.name === 'movie' ? 'movie' : root.name === 'tvshow' ? 'show' : 'episode' }
    const put = (name, value) => { if (value !== '' && value !== null && value !== undefined) hint[name] = value }
    put('title', mo.cleanText(firstText(root, ['title']), mo.LIMITS.title))
    put('originalTitle', mo.cleanText(firstText(root, ['originaltitle']), mo.LIMITS.title))
    put('sortTitle', mo.cleanText(firstText(root, ['sorttitle']), mo.LIMITS.sortTitle))
    put('year', yearFrom(root))
    put('overview', mo.cleanText(firstText(root, ['plot', 'outline', 'overview']), mo.LIMITS.overview, { multiline: true }))
    put('tagline', mo.cleanText(firstText(root, ['tagline']), mo.LIMITS.tagline))
    const genres = mo.cleanGenres(genresFrom(root))
    if (genres.length) hint.genres = genres
    put('certification', certificationFrom(firstText(root, ['certification', 'mpaa'])))
    put('rating', ratingFrom(root))
    put('collection', collectionFrom(root))
    Object.assign(hint, Object.fromEntries(Object.entries(idsFrom(root, leading)).filter(([, v]) => v)))
    const watched = own(child(root, 'watched'))
    const playText = own(child(root, 'playcount'))
    const playCount = playText ? Number(playText) : NaN
    if (watched) hint.watched = truthy(watched)
    else if (Number.isFinite(playCount)) hint.watched = playCount > 0
    if (Number.isFinite(playCount) && playCount > 0) hint.playCount = Math.min(playCount, 1000)
    return hint
  } catch {
    return null
  }
}

/** A Plex .plexmatch file (Key: Value lines, # comments) -> ids, title and year for the show it sits in. */
function parsePlexMatch(input) {
  try {
    const text = Buffer.isBuffer(input) ? decodeBytes(input.subarray(0, PLEXMATCH_MAX_BYTES)) : String(input || '').slice(0, PLEXMATCH_MAX_BYTES)
    const hint = { kind: 'show' }
    for (const line of text.split(/\r?\n/)) {
      // The value is trimmed with trim(), not a lazy group followed by \s*$ (that one was quadratic on a long padded line).
      const m = /^\s*([A-Za-z]+)\s*:(.*)$/.exec(line)
      const value = m ? m[2].trim() : ''
      if (!value) continue
      const key = m[1].toLowerCase()
      if (key === 'title') hint.title = mo.cleanText(value, mo.LIMITS.title)
      else if (key === 'year' && mo.cleanYear(value)) hint.year = mo.cleanYear(value)
      else if (key === 'tmdbid' && POS_INT(value)) hint.tmdbId = Number(value)
      else if (key === 'tvdbid' && POS_INT(value)) hint.tvdbId = Number(value)
      else if (key === 'imdbid' && IMDB_RE.test(value)) hint.imdbId = IMDB_RE.exec(value)[0]
    }
    return Object.keys(hint).length > 1 ? hint : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- using a hint

const HINT_FIELDS = ['title', 'sortTitle', 'year', 'overview', 'tagline', 'genres', 'certification', 'rating', 'collection']

/** The hint as an override-shaped record (locked: an .nfo is a statement, not a guess). */
function hintRecord(hint) {
  const fields = {}
  for (const name of HINT_FIELDS) if (hint && hint[name] !== undefined) fields[name] = { value: hint[name], locked: true }
  return { fields }
}

/**
 * The entry with an .nfo's information laid over it. Same shape as metadataOverrides.applyRecord;
 * the fields it changed are listed in nfo_fields (not metadata_edited, which means "the owner edited it").
 */
function applyHint(kind, entry, hint) {
  if (!hint || (hint.kind === 'movie' && kind === 'show') || (hint.kind === 'show' && kind === 'movie')) return entry
  const record = hintRecord(hint)
  if (!Object.keys(record.fields).length) return entry
  const out = mo.applyRecord(kind, entry, record)
  if (out === entry) return entry
  const { metadata_edited: fields, ...rest } = out
  return { ...rest, nfo_fields: fields }
}

// ---------------------------------------------------------------- finding the files

function showNameOfFolder(folder) {
  const { rest } = titleParse.extractTrailingYear(titleParse.stripLeadingId(folder))
  return (titleParse.cleanText(rest) || String(folder).trim()).toLowerCase()
}

function baseNameOf(fileName) {
  return path.basename(fileName, path.extname(fileName))
}

/**
 * Finds sidecar files with a short-lived directory listing (one readdir per folder per 30 seconds, not
 * one stat per title), and parses each .nfo once per change of the file.
 */
function createSidecarIndex({ fsImpl = fs, now = () => Date.now() } = {}) {
  const listings = new Map()
  const parsed = new Map()

  function list(dir) {
    const hit = listings.get(dir)
    if (hit && now() - hit.at < DIR_TTL_MS) return hit
    let entries = []
    try { entries = fsImpl.readdirSync(dir, { withFileTypes: true }) } catch { entries = [] }
    const names = new Map()
    const dirs = []
    let videoCount = 0
    for (const e of entries) {
      names.set(e.name.toLowerCase(), e.name)
      if (e.isDirectory && e.isDirectory()) dirs.push(e.name)
      else if (VIDEO_EXT_RE.test(e.name)) videoCount++
    }
    const showFolders = new Map()
    for (const d of dirs) {
      const key = showNameOfFolder(d)
      if (!showFolders.has(key)) showFolders.set(key, d)
    }
    const entry = { at: now(), names, showFolders, videoCount }
    if (listings.size >= MAX_DIRS) listings.delete(listings.keys().next().value)
    listings.set(dir, entry)
    return entry
  }

  function readParsed(file, parse, maxBytes) {
    let st
    try { st = fsImpl.statSync(file) } catch { return null }
    if (!st.isFile() || st.size <= 0 || st.size > maxBytes) return null
    const hit = parsed.get(file)
    if (hit && hit.m === st.mtimeMs && hit.s === st.size) return hit.hint
    let hint = null
    try { hint = parse(fsImpl.readFileSync(file)) } catch { hint = null }
    if (parsed.size >= MAX_PARSED) parsed.delete(parsed.keys().next().value)
    parsed.set(file, { m: st.mtimeMs, s: st.size, hint })
    return hint
  }

  function pickImage(listing, folder, bases) {
    for (const base of bases) {
      for (const ext of IMAGE_EXTS) {
        const real = listing.names.get((base + ext).toLowerCase())
        if (real) return path.join(folder, real)
      }
    }
    return null
  }

  return {
    /** <name>.nfo beside a movie file, parsed, or null. */
    movieHint(dir, fileName) {
      if (!dir || !fileName) return null
      const real = list(dir).names.get(`${baseNameOf(fileName)}.nfo`.toLowerCase())
      const hint = real ? readParsed(path.join(dir, real), parseNfo, MAX_BYTES) : null
      return hint && hint.kind === 'movie' ? hint : null
    },
    /** tvshow.nfo (else .plexmatch) in the show's folder inside one TV library folder, or null. */
    showHint(dir, showName) {
      const folder = dir && showName ? list(dir).showFolders.get(String(showName).toLowerCase()) : null
      if (!folder) return null
      const inner = list(path.join(dir, folder))
      const nfo = inner.names.get('tvshow.nfo')
      const fromNfo = nfo ? readParsed(path.join(dir, folder, nfo), parseNfo, MAX_BYTES) : null
      if (fromNfo && fromNfo.kind === 'show') return fromNfo
      const plex = inner.names.get('.plexmatch')
      return plex ? readParsed(path.join(dir, folder, plex), parsePlexMatch, PLEXMATCH_MAX_BYTES) : null
    },
    /** Poster and backdrop files named for one movie file (Kodi/Emby/Jellyfin "<name>-poster.jpg" style). */
    movieArt(dir, fileName) {
      if (!dir || !fileName) return { poster: null, backdrop: null }
      const listing = list(dir)
      const base = baseNameOf(fileName)
      // poster.jpg / folder.jpg / fanart.jpg mean "this folder's film" only when the folder holds one video.
      const solo = listing.videoCount === 1
      return {
        poster: pickImage(listing, dir, [...MOVIE_POSTER_SUFFIXES.map((s) => base + s), ...(solo ? SHOW_POSTER_NAMES.slice(0, 3) : [])]),
        backdrop: pickImage(listing, dir, [...MOVIE_BACKDROP_SUFFIXES.map((s) => base + s), ...(solo ? SHOW_BACKDROP_NAMES.slice(0, 3) : [])])
      }
    },
    /** poster.jpg / folder.jpg / fanart.jpg ... inside a show's folder. */
    showArt(dir, showName) {
      const folder = dir && showName ? list(dir).showFolders.get(String(showName).toLowerCase()) : null
      if (!folder) return { poster: null, backdrop: null }
      const inner = list(path.join(dir, folder))
      const at = path.join(dir, folder)
      return { poster: pickImage(inner, at, SHOW_POSTER_NAMES), backdrop: pickImage(inner, at, SHOW_BACKDROP_NAMES) }
    },
    /** Movies in `dir` whose .nfo says watched, as file names. */
    watchedMovies(dir, fileNames) {
      const out = []
      for (const f of fileNames || []) {
        const hint = this.movieHint(dir, f)
        if (hint && hint.watched === true) out.push(f)
      }
      return out
    },
    clear() {
      listings.clear()
      parsed.clear()
    }
  }
}

module.exports = {
  MAX_BYTES,
  decodeBytes,
  decodeEntities,
  parseXml,
  parseNfo,
  parsePlexMatch,
  hintRecord,
  applyHint,
  createSidecarIndex,
  showNameOfFolder,
  certificationFrom
}
