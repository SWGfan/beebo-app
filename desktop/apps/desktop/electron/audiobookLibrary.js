'use strict'
// The Audiobooks library: every book under the owner's Audiobooks folders, with its author,
// narrator, series, chapters and cover, the way Audiobookshelf and Plexamp-style apps show them.
//
// What counts as a book
//   - An .m4b file is one book (so are lone .m4a / .mp3 / .flac files in a folder of their own).
//   - A folder of .mp3 / .flac / .m4a / .ogg / .opus / .wav / .aac files is ONE book made of parts
//     (CD1 / Disc 2 sub-folders are folded into the book above them).
//   - Audible's copy-protected .aax / .aaxc / .aa files are NOT read and NOT decrypted: they are listed
//     under "skipped" so the owner is told why they are missing. Beebo only plays files the owner can
//     already play without a licence check.
//
// Where the details come from (nothing here talks to the internet; audiobookMetadata.js does the
// optional Open Library lookup and hands its answer to applyEnrichment)
//   1. the files' own tags (music-metadata, with ffprobe as the fallback): album = title, artist =
//      author, composer or a NARRATOR tag = narrator, MVNM/MVIN or SERIES / SERIES-PART = series;
//   2. the book's name and the folders above it (audiobookNaming.js);
//   3. the optional Open Library answer, only for fields still empty.
//
// Chapters (audiobookChapters.js): the m4b chapter atom, MP4 chapter tracks, ID3 CHAP frames, a .cue
// sheet, or one chapter per file for a folder of files.
//
// The result is kept in <cache>/audiobooks/library.json (written with safeJson), a rescan only
// re-reads files whose size or modified time changed, and cover pictures go to
// <cache>/audiobooks/covers/<content hash>.<ext>.
//
// Ids (all lower-case hex, checked before any lookup)
//   book   = sha1 of the book's absolute path (16 chars): stable for as long as the book stays put
//   series = sha1 of author + series name (16), author = sha1 of the lower-cased name (16)
//   cover  = sha256 of the image bytes (32), the same capability-URL idea as the music covers
// A book's audio is only ever served if it is still under one of the configured folders.

const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const crypto = require('crypto')
const { spawn } = require('child_process')
const music = require('./musicLibrary')
const ffmpegArgs = require('./ffmpegArgs') // file: prefix + -protocol_whitelist for every library input
const chapterLib = require('./audiobookChapters')
const naming = require('./audiobookNaming')
const safeJson = require('./safeJson')

const AUDIO_EXTS = ['.m4b', '.m4a', '.mp3', '.flac', '.ogg', '.oga', '.opus', '.wav', '.aac']
// Audible's protected formats. Recognised only so they can be reported as skipped.
const DRM_EXTS = ['.aax', '.aaxc', '.aa']
const INDEX_VERSION = 1
const BOOK_ID_RE = /^[a-f0-9]{16}$/
const GROUP_ID_RE = /^[a-f0-9]{16}$/
const COVER_ID_RE = /^[a-f0-9]{32}$/
const IMAGE_RE = /\.(jpe?g|png|webp)$/i
const FOLDER_ART_RE = /^(cover|folder|front|album|poster|book|art|artwork)\.(jpe?g|png|webp)$/i
const DISC_DIR_RE = /^(cd|disc|disk)\s*[-_ ]?(\d{1,2})$/i
const SKIP_DIRS = new Set(['$recycle.bin', 'system volume information', '@eadir', '.ds_store'])
const MAX_COVER_BYTES = 12 * 1024 * 1024
const MAX_DEPTH = 12
const MAX_PARTS = 5000

const sha = (algo, s, n) => crypto.createHash(algo).update(s).digest('hex').slice(0, n)
const normPath = (p) => {
  const r = path.resolve(String(p))
  return process.platform === 'win32' ? r.toLowerCase() : r
}
const bookIdFor = (absPath) => sha('sha1', 'b|' + normPath(absPath), 16)
const authorIdFor = (name) => sha('sha1', 'r|' + naming.fold(name), 16)
const seriesIdFor = (author, series) => sha('sha1', 's|' + naming.fold(author) + '|' + naming.fold(series), 16)
const natural = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
const sortKey = music.sortKey

function cleanStr(v, max = 300) {
  if (v == null) return ''
  if (Array.isArray(v)) v = v.filter(Boolean).join(', ')
  if (typeof v === 'object') v = v.text || ''
  return String(v).replace(/\u0000/g, '').replace(/\s+/g, ' ').trim().slice(0, max)
}
const posInt = (v) => {
  const n = typeof v === 'number' ? v : parseInt(String(v || ''), 10)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}
const posNum = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v || ''))
  return Number.isFinite(n) && n > 0 ? n : null
}
const yearOf = (v) => {
  const m = /(\d{4})/.exec(String(v || ''))
  const y = m ? parseInt(m[1], 10) : null
  return y && y > 1000 && y < 3000 ? y : null
}

function mimeFor(ext, codec) {
  return String(ext).toLowerCase() === '.m4b' ? 'audio/mp4' : music.mimeFor(ext, codec)
}

// ---------------------------------------------------------------------------
// Tag readers
// ---------------------------------------------------------------------------

let mmPromise = null
function loadMusicMetadata() {
  if (!mmPromise) mmPromise = import('music-metadata').catch(() => null)
  return mmPromise
}

function pickPicture(pictures) {
  if (!Array.isArray(pictures) || !pictures.length) return null
  const front = pictures.find((p) => /front|cover/i.test(String(p.type || ''))) || pictures[0]
  if (!front || !front.data) return null
  const data = Buffer.from(front.data)
  if (!data.length || data.length > MAX_COVER_BYTES) return null
  const b = data
  let ext = null
  if (b.length > 3 && b[0] === 0x89 && b[1] === 0x50) ext = 'png'
  else if (b.length > 2 && b[0] === 0xff && b[1] === 0xd8) ext = 'jpg'
  else if (b.length > 11 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') ext = 'webp'
  if (!ext) return null
  return { data, ext }
}

// First text value of a native tag whose id is one of `ids` (upper-case), whichever container it lives in:
// "----:com.apple.iTunes:NARRATOR" (MP4 freeform), "TXXX:NARRATOR" (ID3), "NARRATOR" (Vorbis).
function nativeText(native, ids) {
  for (const list of Object.values(native || {})) {
    if (!Array.isArray(list)) continue
    for (const t of list) {
      const key = String((t && t.id) || '').toUpperCase()
      if (!ids.some((id) => key === id || key.endsWith(':' + id))) continue
      const v = t.value
      const s = cleanStr(Array.isArray(v) ? v[0] : v)
      if (s) return s
    }
  }
  return ''
}

const MP4_EXTS = new Set(['.m4b', '.m4a', '.mp4'])

async function readTagsWithMusicMetadata(mm, file, { ffprobePath } = {}) {
  const opts = { duration: false, skipCovers: false, includeChapters: true }
  let meta = await mm.parseFile(file, opts)
  if (!(meta.format && meta.format.duration > 0)) {
    // No duration in the header (an mp3 without a Xing frame): count frames.
    try { meta = await mm.parseFile(file, { ...opts, duration: true }) } catch {}
  }
  const c = meta.common || {}
  const f = meta.format || {}
  const native = meta.native || {}
  const ext = path.extname(file).toLowerCase()
  const artist = cleanStr(c.artist || (Array.isArray(c.artists) ? c.artists.join(', ') : ''))
  const albumArtist = cleanStr(c.albumartist)
  let narrator = nativeText(native, ['NARRATOR', 'NARRATEDBY', 'READER', '©NRT']) || cleanStr(c.composer)
  if (!narrator && albumArtist && artist && naming.fold(albumArtist) !== naming.fold(artist)) narrator = albumArtist
  const seriesTag = cleanStr(c.movement) || nativeText(native, ['SERIES', 'MVNM', 'SERIES-NAME'])
  const seriesPart = (c.movementIndex && c.movementIndex.no) || nativeText(native, ['SERIES-PART', 'SERIESPART', 'SERIES_PART', 'MVIN'])
  let chapters = []
  if (MP4_EXTS.has(ext)) chapters = await chapterLib.readMp4Chapters(file)
  if (chapters.length < 2) chapters = chapterLib.fromMusicMetadata(meta)
  if (chapters.length < 2 && ffprobePath && MP4_EXTS.has(ext)) chapters = await chaptersWithFfprobe(file, ffprobePath)
  return {
    title: cleanStr(c.title),
    artist: artist || albumArtist,
    albumArtist,
    album: cleanStr(c.album),
    narrator,
    series: seriesTag,
    seriesPart,
    grouping: cleanStr(c.grouping),
    description: cleanStr(c.description || c.comment, 4000),
    publisher: cleanStr(c.label),
    language: cleanStr(c.language, 20),
    trackNo: c.track && c.track.no,
    discNo: c.disk && c.disk.no,
    year: c.year || yearOf(c.date || c.originaldate),
    genre: Array.isArray(c.genre) ? c.genre[0] : c.genre,
    duration: f.duration,
    codec: f.codec,
    container: f.container,
    lossless: f.lossless,
    bitrate: f.bitrate,
    sampleRate: f.sampleRate,
    channels: f.numberOfChannels,
    picture: pickPicture(c.picture),
    chapters
  }
}

function runProcess(exe, args, { maxBytes = 32 * 1024 * 1024, timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      resolve(null)
      return
    }
    const chunks = []
    let size = 0
    const timer = setTimeout(() => { try { child.kill() } catch {} }, timeoutMs)
    child.stdout.on('data', (d) => {
      size += d.length
      if (size > maxBytes) { try { child.kill() } catch {} return }
      chunks.push(d)
    })
    child.on('error', () => { clearTimeout(timer); resolve(null) })
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0 ? Buffer.concat(chunks) : null) })
  })
}

async function chaptersWithFfprobe(file, ffprobePath) {
  const out = await runProcess(ffprobePath, ['-v', 'error', '-print_format', 'json', '-show_chapters', ...ffmpegArgs.inputArgs(file)])
  if (!out) return []
  try { return chapterLib.fromFfprobe(JSON.parse(out.toString('utf8'))) } catch { return [] }
}

// The fallback reader: ffprobe for tags, stream info and chapters, ffmpeg for the attached picture.
async function readTagsWithFfprobe(file, { ffprobePath, ffmpegPath }) {
  if (!ffprobePath) throw new Error('no tag reader available')
  const out = await runProcess(ffprobePath, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters', ...ffmpegArgs.inputArgs(file)])
  if (!out) throw new Error('ffprobe could not read the file')
  const info = JSON.parse(out.toString('utf8'))
  const tags = {}
  const addTags = (t) => { for (const [k, v] of Object.entries(t || {})) tags[k.toLowerCase()] = v }
  const audio = (info.streams || []).find((s) => s.codec_type === 'audio') || {}
  addTags(audio.tags)
  addTags(info.format && info.format.tags)
  const [trackNo] = String(tags.track || '').split('/')
  const [discNo] = String(tags.disc || '').split('/')
  let picture = null
  const art = (info.streams || []).find((s) => s.codec_type === 'video' && s.disposition && s.disposition.attached_pic)
  if (art && ffmpegPath) {
    const img = await runProcess(ffmpegPath, ['-v', 'error', ...ffmpegArgs.inputArgs(file), '-map', `0:${art.index}`, '-c', 'copy', '-f', 'image2pipe', '-'], { maxBytes: MAX_COVER_BYTES })
    if (img && img.length) picture = pickPicture([{ data: img }])
  }
  const fmt = info.format || {}
  const artist = cleanStr(tags.artist)
  const albumArtist = cleanStr(tags.album_artist || tags.albumartist)
  let chapters = chapterLib.fromFfprobe(info)
  if (chapters.length < 2 && MP4_EXTS.has(path.extname(file).toLowerCase())) chapters = await chapterLib.readMp4Chapters(file)
  return {
    title: cleanStr(tags.title),
    artist: artist || albumArtist,
    albumArtist,
    album: cleanStr(tags.album),
    narrator: cleanStr(tags.narrator || tags.composer),
    series: cleanStr(tags.series || tags.mvnm || tags['series-name']),
    seriesPart: tags['series-part'] || tags.series_part || tags.seriespart || tags.mvin,
    grouping: cleanStr(tags.grouping),
    description: cleanStr(tags.description || tags.comment || tags.synopsis, 4000),
    publisher: cleanStr(tags.publisher || tags.label),
    language: cleanStr(tags.language, 20),
    trackNo, discNo,
    year: yearOf(tags.date || tags.year || tags.originaldate),
    genre: tags.genre,
    duration: parseFloat(audio.duration || fmt.duration),
    codec: audio.codec_name,
    container: fmt.format_name,
    lossless: /flac|alac|pcm|wav/.test(String(audio.codec_name || '')),
    bitrate: parseInt(audio.bit_rate || fmt.bit_rate, 10),
    sampleRate: parseInt(audio.sample_rate, 10),
    channels: audio.channels,
    picture,
    chapters
  }
}

function defaultTagReader({ ffprobePath, ffmpegPath } = {}) {
  return async (file) => {
    const mm = await loadMusicMetadata()
    if (mm) {
      try {
        return await readTagsWithMusicMetadata(mm, file, { ffprobePath })
      } catch (err) {
        if (!ffprobePath) throw err
      }
    }
    return readTagsWithFfprobe(file, { ffprobePath, ffmpegPath })
  }
}

// ---------------------------------------------------------------------------
// Planning: which files make which book (pure; takes what the walk found)
// ---------------------------------------------------------------------------

/**
 * entries: [{ dir, root, audio: [abs], drm: [abs], cues: [abs], images: [abs] }], one per folder that
 * holds audio, cue sheets or pictures. Returns { groups, skipped } where each group is
 * { key, kind: 'single' | 'folder', path, root, files: [{ path, disc }], images: [abs], cues: [abs] }
 * and `skipped` lists the DRM files: [{ path, reason: 'drm' }].
 */
function planBooks(entries) {
  const byDir = new Map()
  for (const e of entries) byDir.set(normPath(e.dir), { ...e, audio: [...e.audio], images: [...e.images], cues: [...e.cues], drm: [...(e.drm || [])], discs: [] })
  // CD1 / Disc 2 folders belong to the folder above them.
  for (const [key, e] of Array.from(byDir)) {
    const m = DISC_DIR_RE.exec(path.basename(e.dir))
    if (!m || normPath(e.dir) === normPath(e.root)) continue
    const parentDir = path.dirname(e.dir)
    const pk = normPath(parentDir)
    let parent = byDir.get(pk)
    if (!parent) {
      parent = { dir: parentDir, root: e.root, audio: [], images: [], cues: [], drm: [], discs: [] }
      byDir.set(pk, parent)
    }
    parent.discs.push({ disc: parseInt(m[2], 10), audio: e.audio })
    parent.images.push(...e.images)
    parent.cues.push(...e.cues)
    parent.drm.push(...e.drm)
    byDir.delete(key)
  }
  const groups = []
  const skipped = []
  for (const e of byDir.values()) {
    for (const d of e.drm) skipped.push({ path: d, reason: 'drm' })
    const isRoot = normPath(e.dir) === normPath(e.root)
    const loose = e.audio.slice().sort(natural)
    const discFiles = e.discs.flatMap((d) => d.audio.map((p) => ({ path: p, disc: d.disc })))
    const total = loose.length + discFiles.length
    if (!total) continue
    const stemOf = (p) => path.basename(p, path.extname(p)).toLowerCase()
    const genericArt = e.images.filter((p) => FOLDER_ART_RE.test(path.basename(p)))
    const made = []
    const single = (file) => {
      const stem = stemOf(file)
      const sameStem = e.images.filter((p) => stemOf(p) === stem)
      const cues = e.cues.filter((p) => stemOf(p) === stem)
      made.push({ key: normPath(file), kind: 'single', path: file, root: e.root, files: [{ path: file, disc: 1 }], images: sameStem, cues, generic: true })
    }
    if (isRoot) {
      // Loose files straight in the Audiobooks folder are never one book together.
      for (const f of loose) single(f)
    } else {
      const m4b = loose.filter((p) => path.extname(p).toLowerCase() === '.m4b')
      const rest = loose.filter((p) => path.extname(p).toLowerCase() !== '.m4b')
      for (const f of m4b) single(f)
      if (discFiles.length || rest.length >= 2) {
        const files = [...rest.map((p) => ({ path: p, disc: 1 })), ...discFiles]
        files.sort((a, b) => a.disc - b.disc || natural(path.basename(a.path), path.basename(b.path)))
        made.push({ key: normPath(e.dir), kind: 'folder', path: e.dir, root: e.root, files, images: genericArt, cues: e.cues, generic: false })
      } else if (rest.length === 1) {
        single(rest[0])
      }
    }
    // One book in the folder: the folder's own picture and lone cue sheet are its.
    if (made.length === 1) {
      const g = made[0]
      if (g.kind === 'single') {
        g.images = [...g.images, ...genericArt]
        if (!g.cues.length && e.cues.length === 1) g.cues = e.cues.slice()
      }
    }
    for (const g of made) { delete g.generic; groups.push(g) }
  }
  groups.sort((a, b) => natural(a.path, b.path))
  return { groups, skipped }
}

// ---------------------------------------------------------------------------
// Assembling one book from its parts (pure)
// ---------------------------------------------------------------------------

function partTitleOf(part, index, sameTitles) {
  const t = part.tags || {}
  if (t.title && !sameTitles) return t.title
  return naming.cleanName(path.basename(part.path)) || `Part ${index + 1}`
}

/**
 * Turns a plan group + its read parts into the book record.
 *   group  a planBooks group
 *   parts  [{ path, disc, size, mtimeMs, duration, codec, container, bitrate, sampleRate, channels, coverId, tags, chapters }]
 *   cues   parsed .cue sheets ([{ tracks }]) for this book
 *   opts   { root, rootDirs }   (root = the Audiobooks folder this book sits under)
 */
function assembleBook(group, parts, cues = []) {
  const list = parts.slice()
  const tagged = list.every((p) => posInt(p.tags && p.tags.trackNo))
  const trackKeys = new Set(list.map((p) => (p.disc || 1) + ':' + (p.tags && p.tags.trackNo)))
  if (group.kind === 'folder' && tagged && trackKeys.size === list.length) {
    list.sort((a, b) => (a.disc || 1) - (b.disc || 1) || posInt(a.tags.trackNo) - posInt(b.tags.trackNo))
  }
  let start = 0
  const out = list.map((p, i) => {
    const duration = posNum(p.duration) || 0
    const rec = { index: i, path: p.path, disc: p.disc || 1, size: p.size, mtimeMs: p.mtimeMs, duration, start, codec: p.codec, container: p.container, bitrate: p.bitrate || null, sampleRate: p.sampleRate || null, channels: p.channels || null, title: '', chapters: p.chapters || [], coverId: p.coverId || null, tags: p.tags || {}, unreadable: p.unreadable }
    start += duration
    return rec
  })
  const total = Math.round(start * 1000) / 1000
  const first = out[0] || { tags: {} }
  const tally = (key) => {
    const counts = new Map()
    for (const p of out) {
      const v = cleanStr(p.tags && p.tags[key])
      if (v) counts.set(v, (counts.get(v) || 0) + 1)
    }
    return counts.size ? Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0][0] : ''
  }

  // --- title, author, series: tags win, then the name and folders ---
  const segs = group.segs || []
  const hint = naming.inferFromPath(segs, group.kind === 'single' ? path.basename(group.path, path.extname(group.path)) : null)
  let title = tally('album') || (group.kind === 'single' ? cleanStr(first.tags.title) : '') || hint.title
  let author = tally('artist') || tally('albumArtist') || hint.author
  const narrator = tally('narrator')
  let series = ''
  let seriesIndex = null
  const fromTag = tally('series')
  const groupingTag = tally('grouping')
  const partTag = posNum(tally('seriesPart'))
  if (fromTag) {
    const s = naming.parseSeriesString(fromTag)
    series = s.name
    seriesIndex = partTag !== null ? partTag : s.index
  } else if (groupingTag) {
    const s = naming.parseSeriesString(groupingTag)
    series = s.name
    seriesIndex = partTag !== null ? partTag : s.index
  }
  if (!series) {
    const t = naming.seriesFromTitle(title)
    if (t) { title = t.title; series = t.series; seriesIndex = t.index }
  }
  if (!series && hint.series) { series = hint.series; if (seriesIndex === null) seriesIndex = hint.index }
  if (seriesIndex === null && series && hint.index !== null) seriesIndex = hint.index
  if (title.toLowerCase() === series.toLowerCase() && hint.title) title = hint.title
  author = naming.displayAuthor(author || 'Unknown Author')

  // --- chapters ---
  const sameTitles = out.length > 1 && new Set(out.map((p) => p.tags && p.tags.title)).size === 1
  for (const p of out) p.title = partTitleOf(p, p.index, sameTitles)
  let chapters = []
  let chaptersSource = 'none'
  if (out.length === 1) {
    const emb = chapterLib.normalizeChapters(out[0].chapters, total)
    if (emb.length > 1) { chapters = emb; chaptersSource = 'embedded' }
    else {
      for (const cue of cues) {
        const c = chapterLib.normalizeChapters(chapterLib.chaptersFromCue(cue, out), total)
        if (c.length > 1) { chapters = c; chaptersSource = 'cue'; break }
      }
    }
  } else if (out.length > 1) {
    let fromCue = []
    for (const cue of cues) {
      const c = chapterLib.normalizeChapters(chapterLib.chaptersFromCue(cue, out), total)
      if (c.length > 1) { fromCue = c; break }
    }
    if (fromCue.length) { chapters = fromCue; chaptersSource = 'cue' }
    else if (out.some((p) => (p.chapters || []).length > 1)) {
      const rows = []
      for (const p of out) {
        if ((p.chapters || []).length > 1) for (const c of p.chapters) rows.push({ title: c.title, start: p.start + c.start })
        else rows.push({ title: p.title, start: p.start })
      }
      chapters = chapterLib.normalizeChapters(rows, total)
      chaptersSource = 'embedded'
    } else {
      chapters = chapterLib.normalizeChapters(chapterLib.chaptersFromParts(out), total)
      chaptersSource = 'files'
    }
  }

  const years = out.map((p) => posInt(p.tags && p.tags.year)).filter(Boolean)
  const cover = out.find((p) => p.coverId)
  const unreadable = out.length > 0 && out.every((p) => p.unreadable)
  return {
    id: bookIdFor(group.path),
    kind: group.kind,
    path: group.path,
    root: group.root,
    title: title || 'Untitled',
    author,
    narrator: narrator || null,
    series: series || null,
    seriesIndex,
    year: years.length ? Math.min(...years) : null,
    genre: cleanStr(tally('genre'), 80) || null,
    description: tally('description') || null,
    publisher: tally('publisher') || null,
    language: tally('language') || null,
    duration: total,
    partCount: out.length,
    parts: out,
    chapters,
    chaptersSource,
    coverId: cover ? cover.coverId : null,
    unreadable: unreadable || undefined
  }
}

// ---------------------------------------------------------------------------
// The library
// ---------------------------------------------------------------------------

function createAudiobookLibrary({
  getDirs,
  getCacheDir,
  log,
  readTags,
  ffprobePath = null,
  ffmpegPath = null,
  concurrency = 3,
  onScanned = null,
  now = () => Date.now()
} = {}) {
  const say = typeof log === 'function' ? log : () => {}
  const reader = readTags || defaultTagReader({ ffprobePath, ffmpegPath })
  const dirsNow = () => {
    try {
      return (typeof getDirs === 'function' ? getDirs() : []).filter(Boolean).map((d) => path.resolve(String(d)))
    } catch {
      return []
    }
  }
  const cacheRoot = () => {
    try {
      const d = typeof getCacheDir === 'function' ? getCacheDir() : null
      return d ? path.join(String(d), 'audiobooks') : null
    } catch {
      return null
    }
  }

  let books = new Map() // id -> stored book record (with absolute paths)
  let enrich = {} // id -> optional online details (audiobookMetadata.js)
  let skipped = []
  let loaded = false
  let view = emptyView()
  let scanning = null
  let rescanWanted = false
  let progress = { done: 0, total: 0 }
  let lastScanAt = 0
  let lastError = null
  let watchers = []
  let watchedKey = ''
  let debounce = null
  let periodic = null
  let watching = false
  let closed = false

  function emptyView() {
    return { list: [], byId: new Map(), series: [], seriesById: new Map(), seriesBooks: new Map(), authors: [], authorById: new Map(), authorBooks: new Map() }
  }
  const indexFile = () => {
    const root = cacheRoot()
    return root ? path.join(root, 'library.json') : null
  }

  function ensureLoaded() {
    if (loaded) return
    loaded = true
    const file = indexFile()
    if (!file) return
    try {
      const { data, source } = safeJson.readJsonSafe(file, null)
      if (source !== 'missing' && data && data.version === INDEX_VERSION && Array.isArray(data.books)) {
        for (const b of data.books) if (b && BOOK_ID_RE.test(b.id) && b.path && Array.isArray(b.parts)) books.set(b.id, b)
        enrich = data.enrich && typeof data.enrich === 'object' ? data.enrich : {}
        skipped = Array.isArray(data.skipped) ? data.skipped : []
        lastScanAt = Number(data.savedAt) || 0
      }
    } catch {
      // no index yet, or a bad one: the next scan rebuilds it
    }
    rebuild()
  }

  function persist() {
    const file = indexFile()
    if (!file) return
    try {
      safeJson.writeJsonAtomic(file, { version: INDEX_VERSION, savedAt: now(), books: Array.from(books.values()), enrich, skipped }, { indent: 0 })
    } catch (err) {
      say(`audiobooks: could not save the library index: ${err && err.message}`)
    }
  }

  // --- grouping into series and authors ---

  const readingOrder = (a, b) =>
    (a.seriesIndex === null || a.seriesIndex === undefined ? Infinity : a.seriesIndex) - (b.seriesIndex === null || b.seriesIndex === undefined ? Infinity : b.seriesIndex) ||
    (a.year || 9999) - (b.year || 9999) ||
    sortKey(a.title).localeCompare(sortKey(b.title))

  function rebuild() {
    const v = emptyView()
    for (const raw of books.values()) {
      const extra = enrich[raw.id] || {}
      const b = {
        ...raw,
        year: raw.year || extra.year || null,
        description: raw.description || extra.description || null,
        genre: raw.genre || extra.genre || null,
        coverId: raw.coverId || extra.coverId || null,
        publisher: raw.publisher || extra.publisher || null,
        onlineMatch: extra.key ? { source: 'openlibrary', key: extra.key } : null
      }
      b.authorId = authorIdFor(b.author)
      b.seriesId = b.series ? seriesIdFor(b.author, b.series) : null
      v.list.push(b)
      v.byId.set(b.id, b)
    }
    v.list.sort((a, b) => sortKey(a.title).localeCompare(sortKey(b.title)) || sortKey(a.author).localeCompare(sortKey(b.author)))
    for (const b of v.list) {
      let a = v.authorById.get(b.authorId)
      if (!a) {
        a = { id: b.authorId, name: b.author, bookCount: 0, seriesIds: new Set(), duration: 0, coverId: null }
        v.authorById.set(b.authorId, a)
        v.authors.push(a)
        v.authorBooks.set(b.authorId, [])
      }
      a.bookCount++
      a.duration += b.duration || 0
      if (b.seriesId) a.seriesIds.add(b.seriesId)
      if (!a.coverId && b.coverId) a.coverId = b.coverId
      v.authorBooks.get(b.authorId).push(b)
      if (b.seriesId) {
        let s = v.seriesById.get(b.seriesId)
        if (!s) {
          s = { id: b.seriesId, name: b.series, author: b.author, authorId: b.authorId, bookCount: 0, duration: 0, coverId: null }
          v.seriesById.set(b.seriesId, s)
          v.series.push(s)
          v.seriesBooks.set(b.seriesId, [])
        }
        s.bookCount++
        s.duration += b.duration || 0
        v.seriesBooks.get(b.seriesId).push(b)
      }
    }
    for (const list of v.seriesBooks.values()) list.sort(readingOrder)
    for (const [id, list] of v.seriesBooks) {
      const s = v.seriesById.get(id)
      const withCover = list.find((b) => b.coverId)
      s.coverId = withCover ? withCover.coverId : null
    }
    for (const list of v.authorBooks.values()) {
      list.sort((a, b) => sortKey(a.series || '~').localeCompare(sortKey(b.series || '~')) || readingOrder(a, b))
    }
    for (const a of v.authors) { a.seriesCount = a.seriesIds.size; delete a.seriesIds }
    v.authors.sort((a, b) => sortKey(a.name).localeCompare(sortKey(b.name)))
    v.series.sort((a, b) => sortKey(a.name).localeCompare(sortKey(b.name)))
    view = v
  }

  // --- scanning ---

  async function walk(root, entries) {
    const stack = [{ dir: root, depth: 0 }]
    while (stack.length) {
      const { dir, depth } = stack.pop()
      if (closed) return
      let list
      try {
        list = await fsp.readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      const entry = { dir, root, audio: [], drm: [], cues: [], images: [] }
      for (const e of list) {
        if (e.name.startsWith('.')) continue
        const full = path.join(dir, e.name)
        if (e.isDirectory()) {
          if (depth < MAX_DEPTH && !SKIP_DIRS.has(e.name.toLowerCase())) stack.push({ dir: full, depth: depth + 1 })
        } else if (e.isFile()) {
          const ext = path.extname(e.name).toLowerCase()
          if (AUDIO_EXTS.includes(ext)) entry.audio.push(full)
          else if (DRM_EXTS.includes(ext)) entry.drm.push(full)
          else if (ext === '.cue') entry.cues.push(full)
          else if (IMAGE_RE.test(e.name)) entry.images.push(full)
        }
      }
      if (entry.audio.length || entry.drm.length) entries.push(entry)
      else if (entry.images.length || entry.cues.length) entries.push(entry) // a disc folder's cover, kept for planBooks
    }
  }

  async function storeCover(data, ext) {
    const root = cacheRoot()
    if (!root || !data || !data.length) return null
    const id = crypto.createHash('sha256').update(data).digest('hex').slice(0, 32)
    const file = path.join(root, 'covers', `${id}.${ext === 'png' || ext === 'webp' ? ext : 'jpg'}`)
    try {
      if (!fs.existsSync(file)) {
        await fsp.mkdir(path.dirname(file), { recursive: true })
        await fsp.writeFile(file, data)
      }
      return id
    } catch {
      return null
    }
  }

  const folderArtIds = new Map()
  async function folderCover(p) {
    try {
      const st = await fsp.stat(p)
      if (st.size > MAX_COVER_BYTES) return null
      const key = p + '|' + st.mtimeMs + '|' + st.size
      if (folderArtIds.has(key)) return folderArtIds.get(key)
      const data = await fsp.readFile(p)
      const pic = pickPicture([{ data }])
      const id = pic ? await storeCover(pic.data, pic.ext) : null
      folderArtIds.set(key, id)
      return id
    } catch {
      return null
    }
  }
  const artRank = (p) => {
    const n = path.basename(p).toLowerCase()
    return n.startsWith('cover') ? 0 : n.startsWith('folder') ? 1 : n.startsWith('front') ? 2 : 3
  }

  async function readPart(filePath, disc, st, prev) {
    let tags = {}
    let failed = false
    try {
      tags = (await reader(filePath)) || {}
    } catch (err) {
      failed = true
      say(`audiobooks: could not read tags from ${path.basename(filePath)}: ${err && err.message}`)
    }
    let coverId = null
    if (tags.picture && tags.picture.data) coverId = await storeCover(Buffer.from(tags.picture.data), tags.picture.ext)
    const ext = path.extname(filePath).toLowerCase()
    return {
      path: filePath,
      disc,
      size: st.size,
      mtimeMs: st.mtimeMs,
      duration: Number.isFinite(tags.duration) && tags.duration > 0 ? Math.round(tags.duration * 1000) / 1000 : 0,
      codec: music.normalizeCodec(tags.codec, tags.container, ext),
      container: cleanStr(tags.container, 40) || ext.slice(1),
      bitrate: Number.isFinite(tags.bitrate) && tags.bitrate > 0 ? Math.round(tags.bitrate) : null,
      sampleRate: posInt(tags.sampleRate),
      channels: posInt(tags.channels),
      coverId,
      chapters: Array.isArray(tags.chapters) ? tags.chapters.filter((c) => c && Number.isFinite(Number(c.start))).map((c) => ({ title: chapterLib.cleanTitle(c.title), start: Number(c.start) })).slice(0, chapterLib.MAX_CHAPTERS) : [],
      tags: {
        title: cleanStr(tags.title),
        artist: cleanStr(tags.artist),
        albumArtist: cleanStr(tags.albumArtist),
        album: cleanStr(tags.album),
        narrator: cleanStr(tags.narrator),
        series: cleanStr(tags.series),
        seriesPart: tags.seriesPart == null ? '' : String(tags.seriesPart),
        grouping: cleanStr(tags.grouping),
        description: cleanStr(tags.description, 2000),
        publisher: cleanStr(tags.publisher),
        language: cleanStr(tags.language, 20),
        genre: cleanStr(Array.isArray(tags.genre) ? tags.genre[0] : tags.genre, 80),
        year: posInt(tags.year),
        trackNo: posInt(tags.trackNo),
        discNo: posInt(tags.discNo)
      },
      unreadable: failed || undefined
    }
  }

  async function doScan() {
    ensureLoaded()
    const dirs = dirsNow()
    const started = now()
    const entries = []
    for (const d of dirs) {
      try {
        const st = await fsp.stat(d)
        if (!st.isDirectory()) continue
      } catch {
        continue
      }
      await walk(d, entries)
    }
    // Two folders that overlap list the same folder once.
    const seenDirs = new Set()
    const unique = entries.filter((e) => {
      const k = normPath(e.dir)
      if (seenDirs.has(k)) return false
      seenDirs.add(k)
      return true
    })
    const plan = planBooks(unique)
    for (const g of plan.groups) {
      // The folders between the Audiobooks folder and the book: what naming.inferFromPath reads.
      const base = g.kind === 'single' ? path.dirname(g.path) : g.path
      const rel = path.relative(g.root, base)
      g.segs = rel && !rel.startsWith('..') ? rel.split(path.sep).filter(Boolean) : []
    }
    // Two overlapping roots must not produce the same book twice.
    const seenBooks = new Set()
    const groups = plan.groups.filter((g) => {
      const id = bookIdFor(g.path)
      if (seenBooks.has(id)) return false
      seenBooks.add(id)
      return true
    })
    skipped = plan.skipped.filter((s, i, a) => a.findIndex((x) => normPath(x.path) === normPath(s.path)) === i)

    const prevParts = new Map()
    for (const b of books.values()) for (const p of b.parts) prevParts.set(normPath(p.path), p)
    const tasks = []
    for (const g of groups) for (const f of g.files.slice(0, MAX_PARTS)) tasks.push({ group: g, file: f })
    progress = { done: 0, total: tasks.length }
    const read = new Map() // normPath -> part record
    let changed = false
    let i = 0
    const work = async () => {
      while (i < tasks.length && !closed) {
        const { file } = tasks[i++]
        const key = normPath(file.path)
        if (read.has(key)) { progress.done++; continue }
        let st
        try {
          st = await fsp.stat(file.path)
        } catch {
          progress.done++
          continue
        }
        const prev = prevParts.get(key)
        if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs && prev.path === file.path && prev.tags) {
          read.set(key, { ...prev, disc: file.disc })
        } else {
          read.set(key, await readPart(file.path, file.disc, st, prev))
          changed = true
        }
        progress.done++
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, work))
    if (closed) return summary()

    const next = new Map()
    for (const g of groups) {
      const parts = g.files.slice(0, MAX_PARTS).map((f) => read.get(normPath(f.path))).filter(Boolean)
      if (!parts.length) continue
      const cues = []
      for (const c of g.cues || []) {
        const parsed = await chapterLib.readCueFile(c)
        if (parsed) cues.push(parsed)
      }
      const book = assembleBook(g, parts, cues)
      if (!book.coverId && g.images && g.images.length) {
        const art = g.images.slice().sort((a, b) => artRank(a) - artRank(b))[0]
        book.coverId = await folderCover(art)
      }
      const prev = books.get(book.id)
      book.addedAt = (prev && prev.addedAt) || now()
      next.set(book.id, book)
    }
    for (const id of books.keys()) if (!next.has(id)) changed = true
    // Details that differ from last time (a cue sheet dropped in, a folder cover added) count as a change too.
    if (!changed) for (const [id, b] of next) if (JSON.stringify({ ...books.get(id), addedAt: 0 }) !== JSON.stringify({ ...b, addedAt: 0 })) { changed = true; break }
    books = next
    for (const id of Object.keys(enrich)) if (!books.has(id)) delete enrich[id]
    rebuild()
    lastScanAt = now()
    lastError = null
    folderArtIds.clear()
    const file = indexFile()
    if (changed || (file && !fs.existsSync(file))) persist()
    say(`audiobooks: scanned ${books.size} book(s) from ${tasks.length} file(s) in ${dirs.length} folder(s) in ${Math.round((now() - started) / 100) / 10}s`)
    if (typeof onScanned === 'function') { try { onScanned() } catch {} }
    return summary()
  }

  function scan() {
    if (scanning) {
      rescanWanted = true
      return scanning
    }
    scanning = (async () => {
      try {
        let out
        do {
          rescanWanted = false
          out = await doScan()
        } while (rescanWanted && !closed)
        return out
      } catch (err) {
        lastError = String((err && err.message) || err)
        say(`audiobooks: scan failed: ${lastError}`)
        return summary()
      } finally {
        scanning = null
      }
    })()
    return scanning
  }

  function scheduleScan(delayMs = 15000) {
    if (closed) return
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => { debounce = null; scan() }, delayMs)
    if (debounce.unref) debounce.unref()
  }

  function refreshWatch() {
    if (closed || !watching) return
    const dirs = dirsNow()
    const key = JSON.stringify(dirs)
    if (key === watchedKey) return
    for (const w of watchers) { try { w.close() } catch {} }
    watchers = []
    watchedKey = key
    for (const d of dirs) {
      try {
        const w = fs.watch(d, { recursive: true, persistent: false }, () => scheduleScan(20000))
        w.on('error', () => {
          try { w.close() } catch {}
          watchers = watchers.filter((x) => x !== w)
          watchedKey = ''
        })
        watchers.push(w)
      } catch {
        // an unplugged drive or a share that cannot be watched: the periodic rescan covers it
      }
    }
  }

  function start({ initialDelayMs = 10000, periodMs = 6 * 60 * 60 * 1000 } = {}) {
    ensureLoaded()
    watching = true
    refreshWatch()
    scheduleScan(initialDelayMs)
    if (!periodic && periodMs > 0) {
      periodic = setInterval(() => { refreshWatch(); scan() }, periodMs)
      if (periodic.unref) periodic.unref()
    }
  }

  function close() {
    closed = true
    if (debounce) clearTimeout(debounce)
    if (periodic) clearInterval(periodic)
    for (const w of watchers) { try { w.close() } catch {} }
    watchers = []
  }

  function summary() {
    return {
      configured: dirsNow().length > 0,
      folders: dirsNow().length,
      scanning: !!scanning,
      progress: { ...progress },
      bookCount: books.size,
      seriesCount: view.series.length,
      authorCount: view.authors.length,
      totalDuration: Math.round(view.list.reduce((s, b) => s + (b.duration || 0), 0)),
      skippedCount: skipped.length,
      lastScanAt: lastScanAt || null,
      error: lastError
    }
  }

  // --- queries ---

  function status() {
    ensureLoaded()
    refreshWatch()
    return summary()
  }
  /** Files that were seen but not read (copy-protected Audible files), as [{ name, reason }]. Names only, no folders. */
  function skippedFiles() {
    ensureLoaded()
    return skipped.map((s) => ({ name: path.basename(s.path), reason: s.reason }))
  }

  function books_({ authorId, seriesId, sort } = {}) {
    ensureLoaded()
    let list = view.list
    if (authorId) list = GROUP_ID_RE.test(String(authorId)) ? view.authorBooks.get(authorId) || [] : []
    if (seriesId) list = GROUP_ID_RE.test(String(seriesId)) ? view.seriesBooks.get(seriesId) || [] : []
    if (sort === 'added') list = list.slice().sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
    else if (sort === 'author') list = list.slice().sort((a, b) => sortKey(a.author).localeCompare(sortKey(b.author)) || readingOrder(a, b))
    else if (sort === 'year') list = list.slice().sort((a, b) => (b.year || 0) - (a.year || 0))
    else if (sort === 'duration') list = list.slice().sort((a, b) => (b.duration || 0) - (a.duration || 0))
    return list
  }
  function book(id) {
    ensureLoaded()
    return BOOK_ID_RE.test(String(id)) ? view.byId.get(id) || null : null
  }
  function series() {
    ensureLoaded()
    return view.series
  }
  /** One series and its books in reading order. */
  function seriesDetail(id) {
    ensureLoaded()
    if (!GROUP_ID_RE.test(String(id))) return null
    const s = view.seriesById.get(id)
    return s ? { series: s, books: view.seriesBooks.get(id) || [] } : null
  }
  function authors() {
    ensureLoaded()
    return view.authors
  }
  function author(id) {
    ensureLoaded()
    if (!GROUP_ID_RE.test(String(id))) return null
    const a = view.authorById.get(id)
    if (!a) return null
    const list = view.authorBooks.get(id) || []
    const seriesList = Array.from(new Set(list.map((b) => b.seriesId).filter(Boolean))).map((sid) => view.seriesById.get(sid)).filter(Boolean)
    return { author: a, books: list, series: seriesList }
  }
  /** The book that follows this one in its series, or null (standalone, or the last one). */
  function nextInSeries(id) {
    const b = book(id)
    if (!b || !b.seriesId) return null
    const list = view.seriesBooks.get(b.seriesId) || []
    const at = list.findIndex((x) => x.id === b.id)
    return at >= 0 && at + 1 < list.length ? list[at + 1] : null
  }

  function search(q, limit = 50) {
    ensureLoaded()
    const query = naming.fold(q)
    if (!query) return { books: [], series: [], authors: [] }
    const rank = (s) => {
      const t = naming.fold(s)
      if (!t) return null
      if (t === query) return 0
      if (t.startsWith(query) || sortKey(s).startsWith(query)) return 1
      if (t.split(' ').some((w) => w.startsWith(query))) return 2
      if (t.includes(query)) return 3
      return null
    }
    const best = (list, fn) => list.map((x) => [fn(x), x]).filter(([r]) => r !== null).sort((a, b) => a[0] - b[0]).slice(0, limit).map(([, x]) => x)
    const min = (...vals) => { const ok = vals.filter((v) => v !== null); return ok.length ? Math.min(...ok) : null }
    const plus = (r, n) => (r === null ? null : r + n)
    return {
      books: best(view.list, (b) => min(rank(b.title), plus(rank(b.author), 1), plus(rank(b.series), 1), plus(rank(b.narrator), 2))),
      series: best(view.series, (s) => rank(s.name)),
      authors: best(view.authors, (a) => rank(a.name))
    }
  }

  /** The audio file for one part of a book, only if it still exists under a configured folder. */
  function bookFile(id, partIndex = 0) {
    const b = book(id)
    if (!b) return null
    const idx = Number(partIndex)
    if (!Number.isInteger(idx) || idx < 0 || idx >= b.parts.length) return null
    const part = b.parts[idx]
    const abs = path.resolve(part.path)
    const roots = dirsNow()
    const inside = roots.some((r) => {
      const rel = path.relative(r, abs)
      return rel && !rel.startsWith('..') && !path.isAbsolute(rel)
    })
    if (!inside) return null
    try {
      const st = fs.statSync(abs, { throwIfNoEntry: false })
      if (!st || !st.isFile()) return null
    } catch {
      return null
    }
    // `track` is what musicTranscode.decide / ensure read: an id for the cache name, the codec and size.
    const track = { id: `${b.id}p${idx}`, codec: part.codec, lossless: /flac|alac|pcm/.test(String(part.codec)), bitrate: part.bitrate, size: part.size, mtimeMs: part.mtimeMs }
    return { book: b, part, track, path: abs, mime: mimeFor(path.extname(abs), part.codec) }
  }

  function coverFile(coverId) {
    const root = cacheRoot()
    if (!root || !COVER_ID_RE.test(String(coverId))) return null
    for (const [ext, mime] of [['jpg', 'image/jpeg'], ['png', 'image/png'], ['webp', 'image/webp']]) {
      const p = path.join(root, 'covers', `${coverId}.${ext}`)
      if (fs.existsSync(p)) return { path: p, mime }
    }
    return null
  }

  /** Online details for a book (audiobookMetadata.js). Only fills what the files did not have. */
  function applyEnrichment(id, patch) {
    ensureLoaded()
    if (!BOOK_ID_RE.test(String(id)) || !books.has(id)) return false
    enrich[id] = { ...(enrich[id] || {}), ...patch, at: now() }
    rebuild()
    persist()
    return true
  }
  const enrichmentOf = (id) => (enrich[id] ? { ...enrich[id] } : null)

  return {
    start, scan, scheduleScan, refreshWatch, close, status, skippedFiles,
    books: books_, book, series, seriesDetail, authors, author, nextInSeries, search,
    bookFile, coverFile, applyEnrichment, enrichmentOf, cacheRoot,
    coverStore: storeCover,
    _books: () => books
  }
}

module.exports = {
  AUDIO_EXTS,
  DRM_EXTS,
  BOOK_ID_RE,
  GROUP_ID_RE,
  COVER_ID_RE,
  INDEX_VERSION,
  createAudiobookLibrary,
  defaultTagReader,
  readTagsWithFfprobe,
  planBooks,
  assembleBook,
  mimeFor,
  bookIdFor,
  authorIdFor,
  seriesIdFor
}
