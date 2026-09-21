'use strict'
// ============================================================================
// artworkPicker.js - choosing a poster and a backdrop.
// ----------------------------------------------------------------------------
// Three places an image can come from:
//   1. TMDB's list of images for the title (/movie/{id}/images, /tv/{id}/images), kept for 14 days
//      like the details pages, asked in the owner's language plus English plus language-less art;
//   2. a picture that sits next to the video / in the show's folder with a name other media
//      servers use (<name>-poster.jpg, poster.jpg, folder.jpg, fanart.jpg ...);
//   3. a picture the owner picks with the system file dialog.
//
// Whatever the source, the result is a NEW jpeg made here: the bytes are checked to be a real
// JPEG / PNG / WebP of sane size, re-encoded and scaled (ffmpeg when there is one, a metadata-
// stripped copy for a JPEG otherwise), and saved as <cache folder>/artwork/<hash>.jpg. Only that
// name is ever stored and served (/media/artwork/<32 hex>.jpg); the original file is never
// served, a path never comes from the window, and nothing is written next to the media.
// ============================================================================

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { spawn } = require('child_process')
const { readJsonSafe, writeJsonAtomic } = require('./safeJson')
const { createTtlStore } = require('./tmdbDetails')
const { stripJpegMetadata } = require('./photoExif')
const mo = require('./metadataOverrides')

const MAX_INPUT_BYTES = 12 * 1024 * 1024
const MAX_OUTPUT_BYTES = 6 * 1024 * 1024
const MAX_PIXELS = 60 * 1000 * 1000
const MAX_SIDE = 12000
const MIN_SIDE = 80
const SIZES = { poster: { maxWidth: 1000, maxHeight: 1500 }, backdrop: { maxWidth: 1920, maxHeight: 1080 } }
const TMDB_IMAGE_SIZE = { poster: 'w500', backdrop: 'w1280' }
const IMAGE_LIST_TTL_MS = 14 * 24 * 60 * 60 * 1000
const MAX_LISTED = 30
const TMDB_PATH_RE = /^\/[A-Za-z0-9._-]{1,120}$/
const SIDECAR_MAP_MAX = 5000
const PRUNE_GRACE_MS = 10 * 60 * 1000
const FETCH_TIMEOUT_MS = 20000

// ---------------------------------------------------------------- reading an image's header

function jpegSize(buf) {
  let i = 2
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue }
    const marker = buf[i + 1]
    if (marker === 0xff) { i++; continue }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue }
    const len = buf.readUInt16BE(i + 2)
    if (len < 2) return null
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) }
    i += 2 + len
  }
  return null
}

function pngSize(buf) {
  if (buf.length < 24 || buf.toString('latin1', 12, 16) !== 'IHDR') return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

function webpSize(buf) {
  if (buf.length < 30) return null
  const kind = buf.toString('latin1', 12, 16)
  if (kind === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
  if (kind === 'VP8L') {
    if (buf[20] !== 0x2f) return null
    const b = buf.readUInt32LE(21)
    return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }
  }
  if (kind === 'VP8X') return { width: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)), height: 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16)) }
  return null
}

/** { type, width, height } for a JPEG, PNG or WebP, judged by its bytes and not its name; null for anything else. */
function imageInfo(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null
  let type = null
  let size = null
  try {
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) { type = 'jpeg'; size = jpegSize(buf) }
    else if (buf.toString('latin1', 0, 8) === '\x89PNG\r\n\x1a\n') { type = 'png'; size = pngSize(buf) }
    else if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') { type = 'webp'; size = webpSize(buf) }
  } catch {
    return null
  }
  return type && size && size.width > 0 && size.height > 0 ? { type, ...size } : null
}

/** null when the picture is acceptable, else a short reason the window can show. */
function rejectReason(buf, role) {
  if (!Buffer.isBuffer(buf) || !buf.length) return 'That file is empty.'
  if (buf.length > MAX_INPUT_BYTES) return 'That image is larger than 12 MB.'
  const info = imageInfo(buf)
  if (!info) return 'That is not a JPEG, PNG or WebP picture.'
  if (info.width < MIN_SIDE || info.height < MIN_SIDE) return 'That image is too small to use.'
  if (info.width > MAX_SIDE || info.height > MAX_SIDE || info.width * info.height > MAX_PIXELS) return 'That image has too many pixels.'
  const ratio = info.width / info.height
  if (ratio < 0.2 || ratio > 5) return 'That image is too narrow or too wide to use as a ' + (role === 'backdrop' ? 'backdrop.' : 'poster.')
  return null
}

// ---------------------------------------------------------------- re-encoding

/** A re-encoder that pipes the picture through ffmpeg (no file names, no shell): (buf, { maxWidth, maxHeight }) -> jpeg Buffer | null. */
function ffmpegReencoder(getFfmpeg, { timeoutMs = 25000 } = {}) {
  return (input, { maxWidth, maxHeight }) => new Promise((resolve) => {
    let exe = null
    try { exe = typeof getFfmpeg === 'function' ? getFfmpeg() : getFfmpeg } catch { exe = null }
    if (!exe) return resolve(null)
    const scale = `scale='min(${maxWidth},iw)':'min(${maxHeight},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`
    let child
    try {
      child = spawn(exe, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-frames:v', '1', '-vf', scale, '-map_metadata', '-1', '-q:v', '3', '-f', 'mjpeg', 'pipe:1'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    } catch { return resolve(null) }
    const out = []
    let outBytes = 0
    let done = false
    const finish = (value) => { if (done) return; done = true; clearTimeout(timer); resolve(value) }
    const timer = setTimeout(() => { try { child.kill() } catch { /* already gone */ } finish(null) }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      outBytes += chunk.length
      if (outBytes > MAX_OUTPUT_BYTES) { try { child.kill() } catch { /* already gone */ } finish(null); return }
      out.push(chunk)
    })
    child.on('error', () => finish(null))
    child.on('close', (code) => finish(code === 0 && outBytes ? Buffer.concat(out) : null))
    child.stdin.on('error', () => { /* ffmpeg may close its input early; the exit code says what happened */ })
    child.stdin.end(input)
  })
}

/**
 * Bytes in -> a JPEG Buffer (scaled, metadata-free) or { error }. `reencode` is the ffmpeg piper above;
 * without it (or when it fails) a JPEG is kept but stripped of its metadata segments, and a PNG or
 * WebP is refused, because passing those on untouched is exactly what this file exists to avoid.
 */
async function normalise(buf, role, reencode) {
  const bad = rejectReason(buf, role)
  if (bad) return { error: bad }
  const target = SIZES[role] || SIZES.poster
  let out = null
  if (reencode) {
    try { out = await reencode(buf, target) } catch { out = null }
  }
  const info = out ? imageInfo(out) : null
  if (out && info && info.type === 'jpeg' && out.length <= MAX_OUTPUT_BYTES && info.width <= target.maxWidth && info.height <= target.maxHeight) return { bytes: out }
  const original = imageInfo(buf)
  if (original.type === 'jpeg') {
    const stripped = stripJpegMetadata(buf)
    if (stripped.length <= MAX_OUTPUT_BYTES) return { bytes: stripped }
    return { error: 'That image is too large to use without ffmpeg to shrink it.' }
  }
  return { error: 'Beebo needs ffmpeg to use a PNG or WebP picture. Choose a JPEG, or install ffmpeg.' }
}

// ---------------------------------------------------------------- the artwork folder

const artworkDir = (cacheDir) => path.join(cacheDir, 'artwork')

/** The path of a prepared picture by its stored name, or null for anything that is not exactly <32 hex>.jpg that exists. */
function artworkFile(cacheDir, name) {
  if (!cacheDir || typeof name !== 'string' || !mo.ART_FILE_RE.test(name)) return null
  const file = path.join(artworkDir(cacheDir), name)
  try { return fs.statSync(file).isFile() ? file : null } catch { return null }
}

function saveBytes(cacheDir, bytes) {
  const hex = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 32)
  const dir = artworkDir(cacheDir)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${hex}.jpg`)
  if (!fs.existsSync(file)) {
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, bytes)
    fs.renameSync(tmp, file)
  }
  return `${hex}.jpg`
}

/** Deletes prepared pictures that no edit and no sidecar import refers to (a grace period keeps ones just made). */
function prune(cacheDir, inUse, { now = Date.now(), extraInUse = new Set() } = {}) {
  let removed = 0
  let names = []
  try { names = fs.readdirSync(artworkDir(cacheDir)) } catch { return 0 }
  for (const name of names) {
    if (!mo.ART_FILE_RE.test(name) || inUse.has(name) || extraInUse.has(name)) continue
    const file = path.join(artworkDir(cacheDir), name)
    try {
      if (now - fs.statSync(file).mtimeMs < PRUNE_GRACE_MS) continue
      fs.unlinkSync(file)
      removed++
    } catch { /* a locked file is tried again next time */ }
  }
  return removed
}

// ---------------------------------------------------------------- downloading a TMDB image

async function defaultFetchImage(url) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: 'error' })
    if (!res.ok) return null
    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > MAX_INPUT_BYTES) return null
    const chunks = []
    let total = 0
    for await (const chunk of res.body) {
      total += chunk.length
      if (total > MAX_INPUT_BYTES) return null
      chunks.push(Buffer.from(chunk))
    }
    return Buffer.concat(chunks)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------- the service

const str = (v) => (typeof v === 'string' ? v : '')
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }

function listOf(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r && TMDB_PATH_RE.test(str(r.file_path)))
    .map((r) => ({ path: r.file_path, width: Math.round(num(r.width)), height: Math.round(num(r.height)), lang: /^[a-z]{2}$/.test(str(r.iso_639_1)) ? r.iso_639_1 : null, votes: Math.round(num(r.vote_count)), score: Math.round(num(r.vote_average) * 10) / 10 }))
    .sort((a, b) => b.score - a.score || b.votes - a.votes || b.width - a.width)
    .slice(0, MAX_LISTED)
}

function createArtwork({ getApi, getLocale, getCacheDir, sidecars, reencode, fetchImage = defaultFetchImage, now = () => Date.now(), fsImpl = fs, log = () => {} } = {}) {
  const cacheDirNow = () => { try { return getCacheDir ? getCacheDir() : '' } catch { return '' } }
  const listStore = createTtlStore({ getFile: () => (cacheDirNow() ? path.join(cacheDirNow(), 'details', 'images.json') : null), ttlMs: IMAGE_LIST_TTL_MS, maxEntries: 3000, now, fsImpl })
  const inFlight = new Map()

  const kindPath = (kind) => (kind === 'show' ? 'tv' : 'movie')
  const language = () => { try { return (getLocale ? getLocale().language : 'en-US').slice(0, 2) } catch { return 'en' } }

  /** { ok, posters, backdrops } from TMDB (cached 14 days, stale copy used when offline). Only the id leaves the machine. */
  async function listTmdb(kind, tmdbId) {
    const id = Number(tmdbId)
    if (!Number.isSafeInteger(id) || id <= 0) return { ok: false, error: 'bad_id' }
    const lang = language()
    const key = `${kindPath(kind)}:${id}:${lang}`
    const hit = listStore.get(key)
    if (hit && hit.fresh) return { ok: true, ...hit.value, cached: true }
    if (inFlight.has(key)) return inFlight.get(key)
    const job = (async () => {
      const api = getApi ? getApi() : null
      if (!api) return hit ? { ok: true, ...hit.value, cached: true, stale: true } : { ok: false, error: 'no_api_key' }
      const res = await api.get(`/${kindPath(kind)}/${id}/images`, { include_image_language: [...new Set([lang, 'en', 'null'])].join(',') })
      if (!res || !res.ok) return hit ? { ok: true, ...hit.value, cached: true, stale: true } : { ok: false, error: res && res.status === 404 ? 'not_found' : 'offline' }
      const value = { posters: listOf(res.data && res.data.posters), backdrops: listOf(res.data && res.data.backdrops) }
      listStore.set(key, value)
      return { ok: true, ...value, cached: false }
    })().finally(() => inFlight.delete(key))
    inFlight.set(key, job)
    return job
  }

  async function finish(role, buf, source, forTmdbId) {
    const dir = cacheDirNow()
    if (!dir) return { ok: false, error: 'no_cache_folder' }
    const made = await normalise(buf, role, reencode)
    if (made.error) return { ok: false, error: 'bad_image', message: made.error }
    try {
      return { ok: true, art: { file: saveBytes(dir, made.bytes), source, forTmdbId: forTmdbId || null } }
    } catch (err) {
      log(`[artwork] could not save a picture: ${err && err.code}`)
      return { ok: false, error: 'save_failed' }
    }
  }

  /** Downloads one of the pictures TMDB listed for this title (a path it did not list is refused). */
  async function chooseTmdb(kind, tmdbId, role, filePath) {
    if (role !== 'poster' && role !== 'backdrop') return { ok: false, error: 'bad_role' }
    const listed = await listTmdb(kind, tmdbId)
    if (!listed.ok) return listed
    const rows = role === 'poster' ? listed.posters : listed.backdrops
    if (!TMDB_PATH_RE.test(str(filePath)) || !rows.some((r) => r.path === filePath)) return { ok: false, error: 'not_listed' }
    const buf = await fetchImage(`https://image.tmdb.org/t/p/${TMDB_IMAGE_SIZE[role]}${filePath}`)
    if (!buf) return { ok: false, error: 'download_failed' }
    return finish(role, buf, 'tmdb', Number(tmdbId))
  }

  /** Reads a picture the OWNER chose in the system file dialog (main.js passes the dialog's path; the window never does). */
  async function chooseFile(role, filePath) {
    if (role !== 'poster' && role !== 'backdrop') return { ok: false, error: 'bad_role' }
    if (typeof filePath !== 'string' || !filePath || filePath.length > 4096 || filePath.includes('\0')) return { ok: false, error: 'bad_path' }
    let buf
    try {
      const st = fsImpl.statSync(filePath)
      if (!st.isFile()) return { ok: false, error: 'bad_path' }
      if (st.size > MAX_INPUT_BYTES) return { ok: false, error: 'bad_image', message: 'That image is larger than 12 MB.' }
      buf = fsImpl.readFileSync(filePath)
    } catch {
      return { ok: false, error: 'unreadable' }
    }
    return finish(role, buf, 'upload', null)
  }

  /** The sidecar picture this title has (from the folder index), by role, for the dialog to offer. */
  function sidecarFor(kind, { dir, fileName, showName }) {
    if (!sidecars) return { poster: null, backdrop: null }
    return kind === 'show' ? sidecars.showArt(dir, showName) : sidecars.movieArt(dir, fileName)
  }

  async function chooseSidecar(kind, ctx, role) {
    if (role !== 'poster' && role !== 'backdrop') return { ok: false, error: 'bad_role' }
    const found = sidecarFor(kind, ctx)[role]
    if (!found) return { ok: false, error: 'no_sidecar' }
    const res = await chooseFile(role, found)
    return res.ok ? { ok: true, art: { ...res.art, source: 'sidecar' } } : res
  }

  // Sidecar pictures found while listing a library are imported once, in the background, one at a time.
  const importQueue = []
  const importing = new Set()
  let importRunning = false
  let mapState = null
  const mapFile = (dir) => path.join(artworkDir(dir), 'sidecar-map.json')
  function sidecarMap(dir) {
    if (!mapState || mapState.dir !== dir) {
      const raw = readJsonSafe(mapFile(dir), {}).data
      const entries = raw && typeof raw.entries === 'object' && raw.entries ? Object.entries(raw.entries) : []
      mapState = { dir, map: new Map(entries.filter(([, v]) => typeof v === 'string' && mo.ART_FILE_RE.test(v) || v === null)), timer: null }
    }
    return mapState
  }
  function persistMap(state) {
    if (state.timer) return
    state.timer = setTimeout(() => {
      state.timer = null
      try { writeJsonAtomic(mapFile(state.dir), { v: 1, entries: Object.fromEntries(state.map) }, { indent: 0 }) } catch { /* imported again next start */ }
    }, 1500)
    if (state.timer.unref) state.timer.unref()
  }
  async function pumpImports() {
    if (importRunning) return
    importRunning = true
    try {
      while (importQueue.length) {
        const job = importQueue.shift()
        const dir = cacheDirNow()
        if (!dir || dir !== job.dir) { importing.delete(job.id); continue }
        const state = sidecarMap(dir)
        const res = await chooseFile(job.role, job.file).catch(() => ({ ok: false }))
        if (state.map.size >= SIDECAR_MAP_MAX) state.map.delete(state.map.keys().next().value)
        state.map.set(job.id, res.ok ? res.art.file : null)
        persistMap(state)
        importing.delete(job.id)
      }
    } finally {
      importRunning = false
    }
  }

  /**
   * The prepared copy of a sidecar picture, or null while it is not ready yet (the import is queued and
   * the next read finds it). Keyed by path, size and change time, so an edited picture is imported again.
   */
  function autoSidecar(role, file) {
    const dir = cacheDirNow()
    if (!dir || !file) return null
    let st
    try { st = fsImpl.statSync(file) } catch { return null }
    if (!st.isFile() || st.size <= 0 || st.size > MAX_INPUT_BYTES) return null
    const id = `${role}|${file}|${st.size}|${Math.floor(st.mtimeMs)}`
    const state = sidecarMap(dir)
    if (state.map.has(id)) {
      const name = state.map.get(id)
      return name && artworkFile(dir, name) ? name : null
    }
    if (!importing.has(id) && importQueue.length < 500) {
      importing.add(id)
      importQueue.push({ id, role, file, dir })
      pumpImports().catch(() => {})
    }
    return null
  }

  function sidecarNamesInUse() {
    const dir = cacheDirNow()
    if (!dir) return new Set()
    return new Set([...sidecarMap(dir).map.values()].filter(Boolean))
  }

  return { listTmdb, chooseTmdb, chooseFile, chooseSidecar, sidecarFor, autoSidecar, sidecarNamesInUse, whenImported: async () => { while (importRunning || importQueue.length) await new Promise((r) => setTimeout(r, 10)) } }
}

module.exports = {
  MAX_INPUT_BYTES,
  imageInfo,
  rejectReason,
  normalise,
  ffmpegReencoder,
  artworkFile,
  artworkDir,
  saveBytes,
  prune,
  listOf,
  createArtwork,
  TMDB_PATH_RE
}
