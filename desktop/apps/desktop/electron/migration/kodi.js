'use strict'
// Kodi adapter: .nfo sidecar files (movie, tvshow, episodedetails) and Kodi's single-file library
// export (videodb.xml, a <videodb> holding the same records).
//
// What an .nfo can say, and where it goes:
//   ids       <uniqueid type="tmdb|imdb|tvdb">, the older <id>, <imdbid>, <tmdbid>, <tvdbid>, or a
//             bare themoviedb / imdb / thetvdb address as the file's only content -> used to MATCH
//   title, year, plot, ratings, actors, artwork paths, genres, tags -> kept as `meta`
//   playcount, watched, lastplayed, <resume>, <userrating> -> the person's own watched state,
//             resume point and rating (the plain <rating> is a crowd score, so it stays in `meta`)
//
// Everything in an .nfo is untrusted text. Artwork values are only ever stored as text (a
// web address, or a relative path with no "..", never an absolute path, never opened), and the
// folder walk does not follow symbolic links, so a link inside the folder cannot lead the scan
// somewhere else on the disk.

const fs = require('fs')
const path = require('path')
const { parseXml, kids, first, textOf, XmlError } = require('./xml')
const M = require('./model')

const USER_KEY = 'kodi'
const MAX_DEPTH = 14
const MAX_ENTRIES_VISITED = 250000
const MAX_NFO_FILES = 60000
const MAX_NFO_BYTES = 1024 * 1024
const MAX_TOTAL_BYTES = 768 * 1024 * 1024
const MAX_VIDEODB_BYTES = 96 * 1024 * 1024

const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve))

// ---- artwork ---------------------------------------------------------------------------------
/** A web address or a safe relative path, as text; anything else is dropped. */
function cleanArtwork(v) {
  const s = M.str(v, 500)
  if (!s) return null
  if (/^https?:\/\/[^\s<>"']+$/i.test(s)) return s
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return null // file:, smb:, nfs:, special: ...
  const norm = s.replace(/\\/g, '/')
  if (norm.startsWith('/') || /^[A-Za-z]:/.test(norm)) return null
  if (norm.split('/').some((p) => p === '..')) return null
  return norm.replace(/^\.\//, '')
}

function artworkOf(root) {
  const art = {}
  const put = (kind, value) => {
    const v = cleanArtwork(value)
    if (v && !art[kind]) art[kind] = v
  }
  for (const t of kids(root, 'thumb')) put(t.attrs.aspect === 'banner' ? 'banner' : t.attrs.aspect === 'landscape' ? 'landscape' : t.attrs.aspect === 'clearlogo' ? 'clearlogo' : 'poster', t.text)
  const fan = first(root, 'fanart')
  if (fan) for (const t of kids(fan, 'thumb')) put('fanart', t.text)
  const a = first(root, 'art')
  if (a) for (const c of a.children) if (/^[a-z]{3,20}$/.test(c.name)) put(c.name === 'thumb' ? 'poster' : c.name, c.text)
  return art
}

// ---- ids ---------------------------------------------------------------------------------------
function idsOf(root) {
  const ids = {}
  const set = (type, value) => {
    const t = String(type || '').toLowerCase()
    if (t === 'tmdb' || t === 'themoviedb') ids.tmdb = ids.tmdb || M.tmdbId(value)
    else if (t === 'imdb') ids.imdb = ids.imdb || M.imdbId(value)
    else if (t === 'tvdb' || t === 'thetvdb') ids.tvdb = ids.tvdb || M.tvdbId(value)
  }
  for (const u of kids(root, 'uniqueid')) set(u.attrs.type, u.text)
  // The old single <id>: "tt1234567" is IMDb, a plain number is TheTVDB (tvshow) or TMDB (movie).
  const legacy = textOf(root, 'id')
  if (legacy) {
    if (M.imdbId(legacy)) ids.imdb = ids.imdb || M.imdbId(legacy)
    else if (/^\d+$/.test(legacy)) {
      if (root.name === 'tvshow') ids.tvdb = ids.tvdb || M.tvdbId(legacy)
      else if (root.name === 'movie') ids.tmdb = ids.tmdb || M.tmdbId(legacy)
    }
  }
  set('imdb', textOf(root, 'imdbid'))
  set('imdb', textOf(root, 'imdb'))
  set('tmdb', textOf(root, 'tmdbid'))
  set('tvdb', textOf(root, 'tvdbid'))
  for (const k of Object.keys(ids)) if (!ids[k]) delete ids[k]
  return ids
}

/** A bare address as the whole content of an .nfo: "https://www.themoviedb.org/movie/603". */
function idsFromUrlOnly(text) {
  const ids = {}
  // An address is short. The thetvdb patterns below are lazy scans that restart at every "thetvdb.com/", so on a
  // megabyte of them they were quadratic (about a minute); nothing real needs more than the first 2000 characters.
  const s = String(text || '').trim().slice(0, 2000)
  let m = /themoviedb\.org\/(?:movie|tv)\/(\d{1,9})/i.exec(s)
  if (m) ids.tmdb = String(Number(m[1]))
  m = /imdb\.com\/title\/(tt\d{6,10})/i.exec(s)
  if (m) ids.imdb = m[1].toLowerCase()
  m = /thetvdb\.com\/[^\s]*?[?&]id=(\d{1,9})/i.exec(s) || /thetvdb\.com\/(?:series|movies)\/[^\s]*?(\d{4,9})\b/i.exec(s)
  if (m) ids.tvdb = String(Number(m[1]))
  return ids
}

// ---- ratings, people ---------------------------------------------------------------------------
function ratingsOf(root) {
  const out = []
  const box = first(root, 'ratings')
  if (box) {
    for (const r of kids(box, 'rating')) {
      const max = M.num(r.attrs.max) || 10
      const v = M.num(textOf(r, 'value'))
      if (v === null || v < 0 || v > max) continue
      out.push({ name: M.str(r.attrs.name || 'default', 30).toLowerCase(), value: Math.round((v / max) * 100) / 10, votes: M.posInt(textOf(r, 'votes')) || 0 })
    }
  }
  if (!out.length) {
    const v = M.num(textOf(root, 'rating'))
    if (v !== null && v > 0 && v <= 10) out.push({ name: 'default', value: v, votes: M.posInt(textOf(root, 'votes')) || 0 })
  }
  return out.slice(0, 10)
}

function actorsOf(root) {
  const out = []
  for (const a of kids(root, 'actor')) {
    const name = M.str(textOf(a, 'name'), 120)
    if (!name) continue
    out.push({ name, role: M.str(textOf(a, 'role'), 200), order: M.posInt(textOf(a, 'order')), thumb: cleanArtwork(textOf(a, 'thumb')) })
    if (out.length >= 60) break
  }
  return out
}

const listOf = (root, name, max = 30) => kids(root, name).map((n) => M.str(n.text, 100)).filter(Boolean).slice(0, max)

// ---- one record --------------------------------------------------------------------------------
function stateOf(root) {
  const playcount = M.posInt(textOf(root, 'playcount'))
  const watchedTag = /^(true|1|yes)$/i.test(textOf(root, 'watched'))
  const state = {}
  if ((playcount || 0) > 0 || watchedTag) { state.watched = true; state.playCount = playcount || 1 }
  const last = M.toMs(textOf(root, 'lastplayed'))
  if (last) state.lastPlayedAt = last
  const resume = first(root, 'resume')
  if (resume) {
    const pos = M.num(textOf(resume, 'position'))
    const total = M.num(textOf(resume, 'total'))
    if (pos !== null && pos > 0) { state.resumeSeconds = pos; if (total) state.durationSeconds = total }
  }
  const ur = M.rating10(textOf(root, 'userrating'))
  if (ur) state.rating = ur
  return state
}

function metaOf(root) {
  const meta = {}
  const plot = M.str(textOf(root, 'plot') || textOf(root, 'outline'), 4000)
  if (plot) meta.plot = plot
  const ratings = ratingsOf(root)
  if (ratings.length) meta.ratings = ratings
  const actors = actorsOf(root)
  if (actors.length) meta.actors = actors
  const art = artworkOf(root)
  if (Object.keys(art).length) meta.artwork = art
  const genres = listOf(root, 'genre')
  if (genres.length) meta.genres = genres
  const tags = listOf(root, 'tag')
  if (tags.length) meta.tags = tags
  const tagline = M.str(textOf(root, 'tagline'), 300)
  if (tagline) meta.tagline = tagline
  const mpaa = M.str(textOf(root, 'mpaa'), 30)
  if (mpaa) meta.certification = mpaa
  const runtime = M.posInt(textOf(root, 'runtime'))
  if (runtime) meta.runtimeMinutes = runtime
  const set = first(root, 'set')
  const setName = set ? M.str(textOf(set, 'name') || set.text, 120) : ''
  if (setName) meta.collection = setName
  const original = M.str(textOf(root, 'originaltitle'), 300)
  if (original) meta.originalTitle = original
  return meta
}

const yearFromDate = (v) => M.year(String(v || '').slice(0, 4))

/**
 * One parsed <movie> / <tvshow> / <episodedetails> element as an ImportItem (or null).
 * `showFor` supplies the show an episode belongs to when the element does not carry it.
 */
function itemFromNode(root, { fileHint = '', showFor = null } = {}) {
  const type = root.name === 'movie' ? 'movie' : root.name === 'tvshow' ? 'show' : root.name === 'episodedetails' ? 'episode' : null
  if (!type) return null
  const title = M.str(textOf(root, 'title'), 300) || M.str(textOf(root, 'originaltitle'), 300)
  const yr = M.year(textOf(root, 'year')) || yearFromDate(textOf(root, 'premiered') || textOf(root, 'releasedate') || textOf(root, 'aired'))
  const ids = idsOf(root)
  const item = { type, title, year: yr, ids, fileHint, state: { [USER_KEY]: stateOf(root) }, meta: metaOf(root) }
  if (type === 'episode') {
    item.season = M.posInt(textOf(root, 'season'))
    item.episode = M.posInt(textOf(root, 'episode'))
    const showTitle = M.str(textOf(root, 'showtitle'), 300)
    const inherited = showFor ? showFor() : null
    item.show = { title: showTitle || (inherited && inherited.title) || '', year: (inherited && inherited.year) || null, ids: (inherited && inherited.ids) || {} }
    // An episode's own <uniqueid> is the EPISODE's id, not the show's; matching an episode is by
    // show + season + episode number, so the episode's ids are not used to find the show.
    item.ids = {}
    if (!item.show.title && !Object.keys(item.show.ids).length) return null
  }
  if (type === 'movie' || type === 'show') {
    if (!item.title && !Object.keys(item.ids).length && !fileHint) return null
    if (!item.title) item.title = fileHint.replace(/\.[^.]+$/, '')
  }
  return item
}

/**
 * Parse one file's text. Returns { items: ImportItem[] } or { error }. `videodb` documents
 * (Kodi's single-file export) yield many items.
 */
function parseNfoText(text, { fileName = '', showFor = null, big = false } = {}) {
  const trimmed = String(text || '').replace(/^﻿/, '').trim()
  if (!trimmed) return { error: 'empty' }
  const base = path.basename(fileName || '', path.extname(fileName || ''))
  if (!trimmed.startsWith('<')) {
    // A bare address: only an id to match by.
    const ids = idsFromUrlOnly(trimmed)
    return Object.keys(ids).length ? { items: [{ type: 'movie', title: base, ids, fileHint: base, state: { [USER_KEY]: {} }, meta: null }], urlOnly: true } : { error: 'not_nfo' }
  }
  let root
  try {
    root = big ? parseXml(trimmed, { maxBytes: MAX_VIDEODB_BYTES, maxNodes: 3000000 }) : parseXml(trimmed)
  } catch (err) {
    return { error: err instanceof XmlError ? err.code : 'malformed' }
  }
  if (root.name === 'videodb') {
    const items = []
    for (const c of root.children) {
      if (c.name === 'movie') {
        const it = itemFromNode(c, { fileHint: '' })
        if (it) items.push(it)
      } else if (c.name === 'tvshow') {
        const show = itemFromNode(c, {})
        if (show) items.push(show)
        const showInfo = show ? { title: show.title, year: show.year, ids: show.ids } : null
        for (const e of kids(c, 'episodedetails')) {
          const it = itemFromNode(e, { showFor: () => showInfo })
          if (it) items.push(it)
        }
      } else if (c.name === 'episodedetails') {
        const it = itemFromNode(c, {})
        if (it) items.push(it)
      }
    }
    return { items }
  }
  const it = itemFromNode(root, { fileHint: base, showFor })
  if (!it) return { error: 'not_nfo' }
  // A trailing address after the XML (Kodi's "movie.nfo" with both) adds ids the XML lacked.
  if (it.type !== 'episode') {
    const rest = trimmed.slice(trimmed.lastIndexOf('>') + 1)
    const extra = idsFromUrlOnly(rest)
    for (const [k, v] of Object.entries(extra)) if (!it.ids[k]) it.ids[k] = v
  }
  return { items: [it] }
}

// ---- folder scan -------------------------------------------------------------------------------
/**
 * Reads every .nfo under `dir` (and any Kodi videodb export .xml). Does not follow symbolic
 * links. Returns { items, skipped: {..counts}, warnings }.
 *
 * @param {string} dir
 * @param {{ onProgress?: (p) => void, fsImpl? }} opts
 */
async function readFolder(dir, opts = {}) {
  const fsp = (opts.fsImpl || fs).promises
  const root = path.resolve(String(dir || ''))
  const items = []
  const skipped = { unreadable: 0, tooBig: 0, notNfo: 0, refused: 0 }
  const warnings = []
  let visited = 0
  let nfoCount = 0
  let totalBytes = 0
  let stopped = ''

  // Depth-first, files of a directory before its sub-directories, so a show's tvshow.nfo is known
  // before its season folders are read.
  const walk = async (d, depth, parentShow) => {
    if (stopped) return
    let entries
    try { entries = await fsp.readdir(d, { withFileTypes: true }) } catch { skipped.unreadable++; return }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    const files = []
    const dirs = []
    for (const e of entries) {
      if (++visited > MAX_ENTRIES_VISITED) { stopped = 'The folder is very large; only part of it was read.'; return }
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) dirs.push(e)
      else if (e.isFile() && /\.(nfo|xml)$/i.test(e.name)) files.push(e)
    }
    // tvshow.nfo first.
    files.sort((a, b) => (/^tvshow\.nfo$/i.test(b.name) ? 1 : 0) - (/^tvshow\.nfo$/i.test(a.name) ? 1 : 0))
    let showHere = parentShow
    for (const f of files) {
      if (stopped) return
      const full = path.join(d, f.name)
      const isXml = /\.xml$/i.test(f.name)
      let st
      try { st = await fsp.stat(full) } catch { skipped.unreadable++; continue }
      if (st.size > (isXml ? MAX_VIDEODB_BYTES : MAX_NFO_BYTES)) { skipped.tooBig++; continue }
      if (isXml && !/^videodb|library|export/i.test(f.name)) continue // some other .xml
      if (!isXml && ++nfoCount > MAX_NFO_FILES) { stopped = 'Only the first ' + MAX_NFO_FILES + ' .nfo files were read.'; return }
      totalBytes += st.size
      if (totalBytes > MAX_TOTAL_BYTES) { stopped = 'The .nfo files add up to more than can be read at once.'; return }
      let text
      try { text = await fsp.readFile(full, 'utf8') } catch { skipped.unreadable++; continue }
      const parsed = isXml ? parseNfoText(text, { fileName: f.name, big: true }) : parseNfoText(text, { fileName: f.name, showFor: () => showHere })
      if (parsed.error) {
        if (isXml && parsed.error !== 'doctype_refused' && parsed.error !== 'too_big') continue
        if (parsed.error === 'doctype_refused' || parsed.error === 'too_big') skipped.refused++
        else skipped.notNfo++
        continue
      }
      for (const it of parsed.items) {
        if (it.type === 'show' && /^tvshow\.nfo$/i.test(f.name)) showHere = { title: it.title, year: it.year, ids: it.ids }
        items.push(it)
      }
      if (items.length && items.length % 250 === 0) {
        if (opts.onProgress) opts.onProgress({ phase: 'reading', done: items.length })
        await yieldToLoop()
      }
    }
    if (depth < MAX_DEPTH) for (const sub of dirs) await walk(path.join(d, sub.name), depth + 1, showHere)
  }

  let st
  try { st = await fsp.stat(root) } catch { throw new Error('folder_not_found') }
  if (!st.isDirectory()) throw new Error('folder_not_found')
  await walk(root, 0, null)
  if (stopped) warnings.push(stopped)
  if (skipped.tooBig) warnings.push(skipped.tooBig + ' file(s) were too large and were skipped.')
  if (skipped.refused) warnings.push(skipped.refused + ' file(s) were refused for safety (they declare entities or are oversized).')
  return { items, skipped, warnings }
}

/**
 * Turns already-read files ([{name, text}]) into a bundle, for uploads and for the phone/website
 * route, which cannot point at a folder.
 */
function readFiles(files) {
  const items = []
  const skipped = { unreadable: 0, tooBig: 0, notNfo: 0, refused: 0 }
  const warnings = []
  let showHere = null
  const sorted = [...(files || [])].sort((a, b) => String(a.name).localeCompare(String(b.name)))
  sorted.sort((a, b) => (/(^|[\\/])tvshow\.nfo$/i.test(b.name) ? 1 : 0) - (/(^|[\\/])tvshow\.nfo$/i.test(a.name) ? 1 : 0))
  for (const f of sorted) {
    const text = typeof f.text === 'string' ? f.text : ''
    if (text.length > MAX_VIDEODB_BYTES) { skipped.tooBig++; continue }
    const isXml = /\.xml$/i.test(String(f.name))
    if (!isXml && text.length > MAX_NFO_BYTES) { skipped.tooBig++; continue }
    const parsed = parseNfoText(text, { fileName: path.basename(String(f.name || '')), showFor: () => showHere, big: isXml })
    if (parsed.error) {
      if (isXml && parsed.error !== 'doctype_refused') continue
      if (parsed.error === 'doctype_refused' || parsed.error === 'too_big') skipped.refused++
      else skipped.notNfo++
      continue
    }
    for (const it of parsed.items) {
      if (it.type === 'show' && /(^|[\\/])tvshow\.nfo$/i.test(f.name)) showHere = { title: it.title, year: it.year, ids: it.ids }
      items.push(it)
    }
  }
  if (skipped.refused) warnings.push(skipped.refused + ' file(s) were refused for safety.')
  return { items, skipped, warnings }
}

function bundleOf(read, label) {
  const warnings = [...read.warnings]
  if (!read.items.length) warnings.push('No usable .nfo files were found.')
  return M.finishBundle({
    source: 'kodi',
    label: label || 'Kodi .nfo files',
    users: [{ key: USER_KEY, name: 'Kodi' }],
    items: read.items,
    lists: [],
    warnings
  })
}

module.exports = { USER_KEY, parseNfoText, itemFromNode, readFolder, readFiles, bundleOf, cleanArtwork, idsFromUrlOnly }
