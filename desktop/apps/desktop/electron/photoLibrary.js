'use strict'
// The Photos library: the owner's picture folders on this PC, as a timeline (newest first, by the
// date each photo was taken), albums (one per folder) and privacy-safe thumbnails.
//
// Privacy rules kept here, not in the routes:
//  - Only files inside a configured Photos folder are ever resolved (no traversal, no links out).
//  - Thumbnails and viewing copies are re-encoded JPEGs with all metadata removed.
//  - Location is recorded for the owner's own use but only returned when the owner turns
//    "Show where photos were taken" on (off by default), and never to anyone else.
const fsp = require('node:fs/promises')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const exif = require('./photoExif')
const ffmpegArgs = require('./ffmpegArgs') // file: prefix + -protocol_whitelist for every library input

const PHOTO_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.bmp', '.avif', '.dng'])
const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.3gp', '.3g2'])
const BACKUP_FOLDER = 'Phone backups'
const INCOMING_FOLDER = '.beebo-incoming'
const THUMB_SIZES = { thumb: 360, view: 1920 }
const MAX_ITEMS = 300000
const MAX_DEPTH = 16

const kindOf = (name) => {
  const ext = path.extname(String(name)).toLowerCase()
  return PHOTO_EXT.has(ext) ? 'photo' : VIDEO_EXT.has(ext) ? 'video' : null
}
const idFor = (full) => crypto.createHash('sha1').update(path.resolve(full).toLowerCase()).digest('hex').slice(0, 24)
const error = (status, message) => Object.assign(new Error(message), { status })

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
  '.heic': 'image/heic', '.heif': 'image/heif', '.bmp': 'image/bmp', '.avif': 'image/avif', '.dng': 'image/x-adobe-dng',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo', '.3gp': 'video/3gpp', '.3g2': 'video/3gpp2'
}

/** True when [full] is [root] or strictly inside it (case-insensitive on Windows). */
function isInside(root, full) {
  const rel = path.relative(root, full)
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel))
}

/** Validate a folder the owner typed or picked: an existing, absolute, local directory. */
async function validateFolder(input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 1024 || /[\x00-\x1f]/.test(input)) throw error(400, 'Choose a folder.')
  const p = input.trim()
  if (p.startsWith('\\\\') || p.startsWith('//')) throw error(400, 'Network folders are not supported. Choose a folder on this PC.')
  if (!path.isAbsolute(p) || (process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(p))) throw error(400, 'Choose a folder on this PC.')
  const full = path.resolve(p)
  let st
  try { st = await fsp.stat(full) } catch { throw error(404, 'That folder does not exist.') }
  if (!st.isDirectory()) throw error(400, 'Choose a folder, not a file.')
  return full
}

function defaultFfmpeg() {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const cands = [
    process.env.BEEBO_FFMPEG,
    process.resourcesPath ? path.join(process.resourcesPath, 'ffmpeg', exe) : null,
    path.join(__dirname, '..', 'resources', 'ffmpeg', exe)
  ]
  for (const c of cands) { try { if (c && fs.existsSync(c)) return c } catch {} }
  return null
}

function createPhotoLibrary({ store, dataDir, ffmpeg = defaultFfmpeg, now = Date.now, log = () => {}, defaultFolders } = {}) {
  const cacheDir = dataDir || path.join(os.tmpdir(), 'beebo-photos')
  const thumbsDir = path.join(cacheDir, 'photo-thumbs')
  const metaFile = path.join(cacheDir, 'photo-meta.json')
  let meta = null // key "path|size|mtime" -> info
  let metaDirty = false
  let index = null // { at, items, byId }
  let scanning = null
  let dirty = true
  const thumbJobs = new Map()
  let thumbRunning = 0
  const thumbWaiters = []

  /* ----------------------------- settings ----------------------------- */

  function folders() {
    const saved = store && store.get('photosDirs')
    if (Array.isArray(saved) && saved.length) return saved.filter((x) => typeof x === 'string' && x).map((x) => path.resolve(x))
    const defaults = typeof defaultFolders === 'function' ? defaultFolders() : [path.join(os.homedir(), 'Pictures')]
    return defaults.map((x) => path.resolve(x))
  }
  async function setFolders(list) {
    if (!Array.isArray(list) || list.length > 20) throw error(400, 'Choose up to 20 folders.')
    const out = []
    for (const f of list) {
      const full = await validateFolder(f)
      if (!out.some((o) => o.toLowerCase() === full.toLowerCase())) out.push(full)
    }
    store.set('photosDirs', out)
    invalidate()
    return out
  }
  const showLocation = () => store ? store.get('photosShowLocation') === true : false
  const setShowLocation = (on) => { store.set('photosShowLocation', !!on) }

  /** The folder phone backups go into: <first Photos folder>/Phone backups. */
  function backupRoot() {
    const first = folders()[0]
    if (!first) throw error(409, 'Choose a Photos folder on the PC first.')
    return path.join(first, BACKUP_FOLDER)
  }

  /* ------------------------------ access ------------------------------ */

  /**
   * What [user] may do. The owner (a PC administrator) can do everything; anyone else only what the
   * owner switched on for them in Photos > Who can use Photos. Read live from the store on every
   * request, so switching someone off takes effect at once.
   */
  function access(user) {
    if (!user || user.status === 'revoked') return { view: false, backup: false, owner: false }
    if (user.isAdmin === true) return { view: true, backup: true, owner: true }
    const map = (store && store.get('photoAccess')) || {}
    const a = map[user.id] || {}
    return { view: a.view === true || a.backup === true, backup: a.backup === true, owner: false }
  }
  function setAccess(userId, { view, backup }) {
    if (typeof userId !== 'string' || !userId) throw error(400, 'Choose a person.')
    const map = { ...((store.get('photoAccess')) || {}) }
    map[userId] = { view: !!view || !!backup, backup: !!backup }
    store.set('photoAccess', map)
    return map[userId]
  }

  /* ----------------------------- metadata ----------------------------- */

  function loadMeta() {
    if (meta) return meta
    meta = new Map()
    try {
      const raw = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
      if (raw && raw.v === 1 && raw.entries && typeof raw.entries === 'object') for (const [k, v] of Object.entries(raw.entries)) meta.set(k, v)
    } catch {}
    return meta
  }
  let saveTimer = null
  function saveMetaSoon() {
    metaDirty = true
    if (saveTimer) return
    saveTimer = setTimeout(async () => {
      saveTimer = null
      if (!metaDirty) return
      metaDirty = false
      try {
        await fsp.mkdir(cacheDir, { recursive: true })
        const tmp = metaFile + '.tmp'
        await fsp.writeFile(tmp, JSON.stringify({ v: 1, entries: Object.fromEntries(meta) }))
        await fsp.rename(tmp, metaFile)
      } catch (e) { log('photos: could not save metadata cache: ' + e.message) }
    }, 2000)
    if (saveTimer.unref) saveTimer.unref()
  }

  async function infoFor(full, st, seen) {
    const m = loadMeta()
    const key = full + '|' + st.size + '|' + Math.floor(st.mtimeMs)
    if (seen) seen.add(key)
    let info = m.get(key)
    if (!info) {
      info = await exif.readMediaInfo(full, st, { now: now() })
      m.set(key, info)
      saveMetaSoon()
    }
    return info
  }

  /* ------------------------------ scanning ------------------------------ */

  function invalidate() { dirty = true }

  async function scan() {
    const roots = folders()
    const items = []
    const byId = new Map()
    const seenRoots = []
    const seenKeys = new Set()
    for (const root of roots) {
      let rootReal
      try { rootReal = await fsp.realpath(root) } catch { continue }
      // A Photos folder inside another one is already covered (ids also de-duplicate).
      if (seenRoots.some((r) => isInside(r, rootReal))) continue
      seenRoots.push(rootReal)
      const stack = [{ dir: rootReal, depth: 0 }]
      const pending = []
      while (stack.length && items.length + pending.length < MAX_ITEMS) {
        const { dir, depth } = stack.pop()
        let entries
        try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { continue }
        for (const ent of entries) {
          const name = ent.name
          if (!name || name.startsWith('.') || name.startsWith('$') || name === 'Thumbs.db') continue
          const full = path.join(dir, name)
          if (ent.isSymbolicLink()) continue
          if (ent.isDirectory()) { if (depth < MAX_DEPTH) stack.push({ dir: full, depth: depth + 1 }); continue }
          if (!ent.isFile()) continue
          const type = kindOf(name)
          if (!type) continue
          pending.push({ full, name, type, root: rootReal })
        }
      }
      // Stat + metadata with a little concurrency; cached entries cost one stat.
      let next = 0
      const worker = async () => {
        while (next < pending.length) {
          const p = pending[next++]
          let st
          try { st = await fsp.stat(p.full) } catch { continue }
          const info = await infoFor(p.full, st, seenKeys)
          const albumRel = path.relative(p.root, path.dirname(p.full))
          const item = {
            id: idFor(p.full), name: p.name, type: p.type, size: st.size, mtime: Math.floor(st.mtimeMs),
            takenAt: info.takenAt || 0, takenFrom: info.takenFrom, orientation: info.orientation || 1,
            album: albumId(path.dirname(p.full)), albumPath: albumRel.split(path.sep).join('/'),
            rootName: path.basename(p.root) || p.root,
            full: p.full, root: p.root, location: info.location || null,
            camera: [info.make, info.model].filter(Boolean).join(' ') || null
          }
          if (byId.has(item.id)) continue
          byId.set(item.id, item)
          items.push(item)
        }
      }
      await Promise.all(Array.from({ length: 8 }, worker))
    }
    items.sort((a, b) => (b.takenAt - a.takenAt) || (a.name < b.name ? -1 : 1))
    // Forget metadata for files that were moved, edited or deleted, so the cache cannot grow forever.
    const m = loadMeta()
    if (items.length < MAX_ITEMS) for (const k of [...m.keys()]) if (!seenKeys.has(k)) { m.delete(k); metaDirty = true }
    if (metaDirty) saveMetaSoon()
    return { at: now(), items, byId }
  }

  const albumId = (dir) => crypto.createHash('sha1').update(path.resolve(dir).toLowerCase()).digest('hex').slice(0, 16)

  /**
   * The current index, rescanning when something changed (a backup, an upload, a delete, a folder change all mark it
   * dirty at once) or it is over five minutes old. It used to be one minute: with 100,000 photos every rescan is
   * 100,000 stats, so browsing kept re-walking the library. An unknown id or the owner's refresh still rescans now.
   */
  async function current({ fresh = false } = {}) {
    if (index && !dirty && !fresh && now() - index.at < 5 * 60 * 1000) return index
    if (!scanning) {
      dirty = false
      scanning = scan().then((ix) => { index = ix; return ix }).finally(() => { scanning = null })
    }
    if (index && !fresh) return index // serve the previous one while the rescan runs
    return scanning
  }

  /* ------------------------------- views ------------------------------- */

  function publicItem(item, acc) {
    const out = {
      id: item.id, name: item.name, type: item.type, size: item.size, takenAt: item.takenAt,
      takenFrom: item.takenFrom, album: item.album, albumName: albumName(item), orientation: item.orientation
    }
    if (acc && acc.owner) {
      out.camera = item.camera
      if (showLocation() && item.location) out.location = item.location
    }
    return out
  }
  function albumName(item) {
    return item.albumPath ? item.albumPath.split('/').slice(-1)[0] : item.rootName
  }

  const clampInt = (v, lo, hi, dflt) => {
    const n = Number.parseInt(v, 10)
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt
  }

  /**
   * One page of the timeline, newest first. Filters: album id, type (photo/video). `months` lists
   * every month that has something (for the scrubber), counted over the whole filtered set.
   */
  async function timeline(params, acc) {
    const ix = await current()
    const album = params.get('album') || ''
    const type = params.get('type') || ''
    const offset = clampInt(params.get('offset'), 0, MAX_ITEMS, 0)
    const limit = clampInt(params.get('limit'), 1, 500, 200)
    let list = ix.items
    if (album) list = list.filter((x) => x.album === album)
    if (type === 'photo' || type === 'video') list = list.filter((x) => x.type === type)
    const months = []
    for (const it of list) {
      const d = new Date(it.takenAt || 0)
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
      const last = months[months.length - 1]
      if (last && last.key === key) last.count++
      else months.push({ key, count: 1 })
    }
    const page = list.slice(offset, offset + limit).map((x) => publicItem(x, acc))
    return { ok: true, total: list.length, offset, items: page, nextOffset: offset + page.length < list.length ? offset + page.length : null, months, scanning: !!scanning }
  }

  /**
   * Every item that carries a location, for the Map view. Same privacy rule as publicItem:
   * only the owner, and only when they turned "Show where photos were taken" on.
   */
  async function mapPoints(acc) {
    const enabled = !!(acc && acc.owner && showLocation())
    if (!enabled) return { ok: true, enabled: false, items: [] }
    const ix = await current()
    const items = ix.items.filter((x) => x.location).map((x) => ({
      id: x.id, type: x.type, name: x.name, takenAt: x.takenAt,
      lat: x.location.lat, lon: x.location.lon,
      album: x.album, albumName: albumName(x)
    }))
    return { ok: true, enabled: true, items }
  }

  async function albums(acc) {
    const ix = await current()
    const map = new Map()
    for (const it of ix.items) {
      let a = map.get(it.album)
      if (!a) {
        a = { id: it.album, name: albumName(it), path: [it.rootName, it.albumPath].filter(Boolean).join('/'), count: 0, photos: 0, videos: 0, coverId: it.id, latest: it.takenAt, earliest: it.takenAt }
        map.set(it.album, a)
      }
      a.count++
      if (it.type === 'video') a.videos++; else a.photos++
      if (it.takenAt > a.latest) { a.latest = it.takenAt; a.coverId = it.id }
      if (it.takenAt < a.earliest) a.earliest = it.takenAt
    }
    const list = [...map.values()].sort((x, y) => y.latest - x.latest)
    return { ok: true, albums: list, folders: acc && acc.owner ? folders() : undefined }
  }

  /**
   * Resolve an item id to its file, re-checking on disk that it is still a regular media file
   * inside a configured Photos folder with no link on the way (the index could be stale).
   */
  async function resolveItem(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{24}$/.test(id)) throw error(400, 'Invalid photo.')
    let ix = await current()
    let item = ix.byId.get(id)
    if (!item) { ix = await current({ fresh: true }); item = ix.byId.get(id) }
    if (!item) throw error(404, 'That photo is no longer in your library.')
    await assertSafePath(item.full)
    return item
  }

  async function assertSafePath(full) {
    const resolved = path.resolve(full)
    const roots = []
    for (const r of folders()) { try { roots.push(await fsp.realpath(r)) } catch {} }
    const root = roots.find((r) => isInside(r, resolved))
    if (!root) throw error(403, 'That file is outside your Photos folders.')
    let cur = root
    for (const part of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
      if (part === '..') throw error(403, 'That file is outside your Photos folders.')
      cur = path.join(cur, part)
      const st = await fsp.lstat(cur)
      if (st.isSymbolicLink()) throw error(403, 'Linked folders cannot be opened here.')
    }
    const real = await fsp.realpath(resolved)
    if (!isInside(root, real)) throw error(403, 'That file is outside your Photos folders.')
    const st = await fsp.stat(real)
    if (!st.isFile() || !kindOf(real)) throw error(403, 'Only photos and videos can be opened here.')
    return { full: real, st }
  }

  /* ----------------------------- thumbnails ----------------------------- */

  function runFfmpeg(args) {
    return new Promise((resolve) => {
      const exe = typeof ffmpeg === 'function' ? ffmpeg() : ffmpeg
      if (!exe) return resolve(false)
      let child
      try { child = spawn(exe, args, { stdio: 'ignore', windowsHide: true }) } catch { return resolve(false) }
      const killer = setTimeout(() => { try { child.kill() } catch {} }, 30000)
      child.on('error', () => { clearTimeout(killer); resolve(false) })
      child.on('close', (code) => { clearTimeout(killer); resolve(code === 0) })
    })
  }
  async function slot() {
    if (thumbRunning < 2) { thumbRunning++; return }
    await new Promise((r) => thumbWaiters.push(r))
    thumbRunning++
  }
  function release() { thumbRunning--; const w = thumbWaiters.shift(); if (w) w() }

  /**
   * A metadata-free JPEG of [item] at [size] ('thumb' or 'view'), from the cache when possible.
   * Returns { path } or { fallback: true } when no rendition could be made (no ffmpeg / unreadable).
   */
  async function rendition(item, size) {
    const w = THUMB_SIZES[size] || THUMB_SIZES.thumb
    const key = crypto.createHash('sha1').update(item.full + '|' + item.size + '|' + item.mtime + '|' + w).digest('hex')
    const out = path.join(thumbsDir, key.slice(0, 2), key + '.jpg')
    try { if ((await fsp.stat(out)).size > 0) return { path: out } } catch {}
    if (thumbJobs.has(out)) return thumbJobs.get(out)
    const job = (async () => {
      await slot()
      try {
        await fsp.mkdir(path.dirname(out), { recursive: true })
        const tmp = out + '.' + process.pid + '.tmp.jpg'
        const scale = `scale='min(${w},iw)':'min(${w},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1`
        const common = ['-hide_banner', '-loglevel', 'error', '-y']
        const tail = ['-frames:v', '1', '-vf', scale, '-map_metadata', '-1', '-q:v', size === 'view' ? '3' : '5', tmp]
        let ok
        if (item.type === 'video') {
          ok = await runFfmpeg([...common, '-ss', '1', ...ffmpegArgs.inputArgs(item.full), ...tail])
          if (!ok) ok = await runFfmpeg([...common, ...ffmpegArgs.inputArgs(item.full), ...tail])
        } else {
          ok = await runFfmpeg([...common, ...ffmpegArgs.inputArgs(item.full), ...tail])
        }
        if (!ok) { await fsp.rm(tmp, { force: true }); return { fallback: true } }
        // Belt and braces: whatever the encoder wrote, no metadata segment leaves the PC.
        const bytes = exif.stripJpegMetadata(await fsp.readFile(tmp))
        await fsp.writeFile(tmp, bytes)
        await fsp.rename(tmp, out)
        return { path: out }
      } catch (e) {
        log('photos: thumbnail failed: ' + e.message)
        return { fallback: true }
      } finally { release() }
    })()
    thumbJobs.set(out, job)
    try { return await job } finally { thumbJobs.delete(out) }
  }

  /** A freshly saved phone backup: make it show up without waiting for the next rescan. */
  function noteAdded() { invalidate() }

  return {
    folders, setFolders, backupRoot, showLocation, setShowLocation, access, setAccess,
    timeline, albums, mapPoints, resolveItem, assertSafePath, rendition, noteAdded, invalidate, current,
    publicItem, mimeFor: (p) => MIME[path.extname(p).toLowerCase()] || 'application/octet-stream'
  }
}

module.exports = { createPhotoLibrary, kindOf, isInside, validateFolder, BACKUP_FOLDER, INCOMING_FOLDER, PHOTO_EXT, VIDEO_EXT }
