'use strict'
// Phone camera backup: the PC side.
//
// A phone sends each photo or video in small chunks (they have to fit through the away-from-home
// tunnel), so a transfer survives Wi-Fi drops, app restarts and the PC sleeping:
//
//   POST /api/photos/backup/check   { device, items:[{sha256,size}] }        -> which the PC has
//   POST /api/photos/backup/begin   { device, name, size, sha256, takenAt }   -> { uploadId, offset } or { status:'done' }
//   PUT  /api/photos/backup/chunk?uploadId=&offset=   raw bytes, X-Chunk-Sha256 -> { offset }
//   GET  /api/photos/backup/status?uploadId=                                   -> { offset }
//   POST /api/photos/backup/finish  { uploadId }                               -> { status:'saved', path }
//
// Guarantees:
//  - De-duplication by SHA-256 of the whole file, across devices and reinstalls: a picture the PC
//    already has is never stored twice.
//  - Every chunk may carry its own SHA-256; a corrupted chunk is refused and not written. The
//    finished file is hashed again and must match what the phone declared, or it is discarded.
//  - Chunks are only accepted at the exact current end of the partial file, so a retried or
//    out-of-order chunk can never leave a hole or a doubled block.
//  - Saved as <Photos folder>/Phone backups/<device>/YYYY/MM/<original name>; a different picture
//    with the same name gets "name (2).jpg". Nothing already on the PC is overwritten, and nothing
//    is ever deleted on the phone (the phone app has no code that could).
const fsp = require('node:fs/promises')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { kindOf, INCOMING_FOLDER } = require('./photoLibrary')
const { isReservedDeviceName } = require('./safePath')

const MAX_CHUNK = 4 * 1024 * 1024
const MAX_FILE = 64 * 1024 * 1024 * 1024
const STALE_PART_MS = 30 * 86400000
const DISK_RESERVE = 512 * 1024 * 1024
const MAX_INCOMPLETE_UPLOADS = 500 // half-sent uploads at once (a .json + a .part each)
const error = (status, code, extra) => Object.assign(new Error(code), { status, code, extra })

/** A device or file name that is safe as one Windows path segment. */
function safeSegment(input, fallback, max = 120) {
  let s = String(input == null ? '' : input).normalize('NFC')
    .replace(/[\x00-\x1f<>:"/\\|?*]/g, '_')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, max)
    .replace(/[\s.]+$/g, '')
  if (isReservedDeviceName(s)) s = '_' + s // CON, NUL, COM0-9, COM¹²³, LPT..., CONIN$ (electron/safePath.js), with or without an extension
  return s || fallback
}

/** "name.jpg" -> "name (2).jpg" for n = 2. */
function numbered(name, n) {
  const ext = path.extname(name)
  const base = ext ? name.slice(0, -ext.length) : name
  return `${base} (${n})${ext}`
}

async function hashFile(file) {
  const h = crypto.createHash('sha256')
  await new Promise((resolve, reject) => {
    const rs = fs.createReadStream(file, { highWaterMark: 1 << 20 })
    rs.on('data', (b) => h.update(b))
    rs.on('error', reject)
    rs.on('end', resolve)
  })
  return h.digest('hex')
}

function createPhotoBackup({ library, dataDir, now = Date.now, log = () => {}, freeSpace, maxIncompleteUploads = MAX_INCOMPLETE_UPLOADS } = {}) {
  const indexFile = path.join(dataDir, 'photo-backup-index.json')
  let idx = null
  const locks = new Map()

  /* ------------------------------ index ------------------------------ */

  function load() {
    if (idx) return idx
    idx = { v: 1, hashes: {}, devices: {} }
    try {
      const raw = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
      if (raw && raw.v === 1) idx = { v: 1, hashes: raw.hashes || {}, devices: raw.devices || {} }
    } catch {}
    return idx
  }
  async function save() {
    await fsp.mkdir(dataDir, { recursive: true })
    const tmp = indexFile + '.' + process.pid + '.tmp'
    await fsp.writeFile(tmp, JSON.stringify(idx))
    await fsp.rename(tmp, indexFile)
  }

  /** Whether the PC still holds the file recorded for [sha]; forgets entries whose file is gone. */
  async function have(sha, size) {
    const e = load().hashes[sha]
    if (!e) return null
    try {
      const full = path.join(library.backupRoot(), e.path)
      const st = await fsp.stat(full)
      if (st.isFile() && (size == null || st.size === Number(size))) return { ...e, full }
    } catch {}
    delete idx.hashes[sha]
    return null
  }

  async function withLock(key, fn) {
    while (locks.has(key)) await locks.get(key).catch(() => {})
    let done
    const p = new Promise((r) => { done = r })
    locks.set(key, p)
    try { return await fn() } finally { locks.delete(key); done() }
  }

  /* ----------------------------- helpers ----------------------------- */

  const deviceKey = (user, device) => user.id + '|' + device
  const isSha = (s) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s)
  const incomingDir = () => path.join(library.backupRoot(), INCOMING_FOLDER)
  const partPath = (id) => path.join(incomingDir(), id + '.part')
  const metaPath = (id) => path.join(incomingDir(), id + '.json')

  function requireBackup(user) {
    const acc = library.access(user)
    if (!acc.backup) throw error(403, 'backup_not_allowed')
    return acc
  }

  function cleanDevice(body) {
    return safeSegment(body && body.device, 'Phone', 60)
  }

  async function readMeta(user, uploadId) {
    if (typeof uploadId !== 'string' || !/^[a-f0-9]{40}$/.test(uploadId)) throw error(400, 'bad_upload_id')
    let m
    try { m = JSON.parse(await fsp.readFile(metaPath(uploadId), 'utf8')) } catch { throw error(404, 'upload_not_found') }
    if (m.userId !== user.id) throw error(404, 'upload_not_found')
    return m
  }
  async function partSize(uploadId) {
    try { return (await fsp.stat(partPath(uploadId))).size } catch { return 0 }
  }

  async function sweepStale() {
    try {
      const dir = incomingDir()
      for (const name of await fsp.readdir(dir)) {
        const full = path.join(dir, name)
        const st = await fsp.stat(full).catch(() => null)
        if (st && now() - st.mtimeMs > STALE_PART_MS) await fsp.rm(full, { force: true })
      }
    } catch {}
  }

  /* ------------------------------ routes ------------------------------ */

  async function check(user, body) {
    requireBackup(user)
    const items = Array.isArray(body && body.items) ? body.items.slice(0, 1000) : []
    const results = []
    for (const it of items) {
      const sha = String((it && it.sha256) || '').toLowerCase()
      results.push({ sha256: sha, have: isSha(sha) && !!(await have(sha, it.size)) })
    }
    return { ok: true, results }
  }

  /** Throws pc_disk_full unless [bytes] more can be written to [root] and the PC keeps its reserve. */
  async function assertDiskRoom(root, bytes) {
    if (typeof freeSpace === 'function') {
      const free = await freeSpace(root).catch(() => null)
      if (free != null && free < bytes + DISK_RESERVE) throw error(507, 'pc_disk_full')
    } else if (fsp.statfs) {
      try {
        const s = await fsp.statfs(root)
        if (s.bavail * s.bsize < bytes + DISK_RESERVE) throw error(507, 'pc_disk_full')
      } catch (e) { if (e.status) throw e }
    }
  }

  async function begin(user, body) {
    requireBackup(user)
    const device = cleanDevice(body)
    const sha = String((body && body.sha256) || '').toLowerCase()
    const size = Number(body && body.size)
    if (!isSha(sha)) throw error(400, 'bad_checksum')
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_FILE) throw error(400, 'bad_size')
    const name = safeSegment(path.basename(String((body && body.name) || '').replace(/\\/g, '/')), '', 180)
    if (!name || !kindOf(name)) throw error(415, 'not_a_photo_or_video')
    const takenAt = Number(body && body.takenAt)
    const existing = await have(sha, size)
    if (existing) {
      await touchDevice(user, device, 0, 0)
      return { ok: true, status: 'done', duplicate: true, path: existing.path }
    }
    const root = library.backupRoot()
    await fsp.mkdir(incomingDir(), { recursive: true })
    await assertDiskRoom(root, size)
    // Stable across app reinstalls: the same person sending the same bytes from the same phone
    // resumes the same partial file.
    const uploadId = crypto.createHash('sha1').update(user.id + '|' + device + '|' + sha + '|' + size).digest('hex')
    return withLock(uploadId, async () => {
      let m = null
      try { m = JSON.parse(await fsp.readFile(metaPath(uploadId), 'utf8')) } catch {}
      if (!m) {
        let pending = 0
        try { pending = (await fsp.readdir(incomingDir())).filter((n) => n.endsWith('.json')).length } catch {}
        if (pending >= maxIncompleteUploads) throw error(429, 'too_many_uploads')
        m = { uploadId, userId: user.id, device, name, size, sha256: sha, takenAt: Number.isFinite(takenAt) && takenAt > 0 ? takenAt : null, startedAt: now() }
        await fsp.writeFile(metaPath(uploadId), JSON.stringify(m))
        await fsp.writeFile(partPath(uploadId), Buffer.alloc(0), { flag: 'a' })
        if (Math.random() < 0.05) sweepStale()
      }
      const offset = await partSize(uploadId)
      return { ok: true, status: offset > 0 ? 'resume' : 'new', uploadId, offset, chunkSize: 512 * 1024, maxChunk: MAX_CHUNK }
    })
  }

  async function status(user, uploadId) {
    requireBackup(user)
    const m = await readMeta(user, uploadId)
    return { ok: true, uploadId, offset: await partSize(uploadId), size: m.size }
  }

  /** Read a request body of at most MAX_CHUNK bytes. */
  async function readChunk(req) {
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > MAX_CHUNK) { req.resume(); throw error(413, 'chunk_too_large') }
    const parts = []
    let total = 0
    for await (const c of req) {
      total += c.length
      if (total > MAX_CHUNK) throw error(413, 'chunk_too_large')
      parts.push(c)
    }
    return Buffer.concat(parts)
  }

  async function chunk(user, req, params) {
    requireBackup(user)
    const uploadId = params.get('uploadId') || ''
    const offset = Number(params.get('offset'))
    const m = await readMeta(user, uploadId).catch((e) => { req.resume(); throw e })
    const data = await readChunk(req)
    return withLock(uploadId, async () => {
      const at = await partSize(uploadId)
      if (!Number.isSafeInteger(offset) || offset !== at) throw error(409, 'offset_mismatch', { offset: at })
      if (!data.length) throw error(400, 'empty_chunk')
      if (at + data.length > m.size) throw error(400, 'too_much_data', { offset: at })
      const declared = String(req.headers['x-chunk-sha256'] || '').toLowerCase()
      if (declared) {
        const actual = crypto.createHash('sha256').update(data).digest('hex')
        if (actual !== declared) throw error(422, 'chunk_checksum_mismatch', { offset: at })
      }
      // begin() checked the disk once per upload, before any bytes existed; many uploads (or one PC drive filling
      // for other reasons) can pass it. Every chunk keeps the reserve.
      await assertDiskRoom(library.backupRoot(), data.length)
      const fh = await fsp.open(partPath(uploadId), 'r+')
      try { await fh.write(data, 0, data.length, at) } finally { await fh.close() }
      return { ok: true, uploadId, offset: at + data.length, size: m.size }
    })
  }

  async function finish(user, body) {
    requireBackup(user)
    const uploadId = String((body && body.uploadId) || '')
    const m = await readMeta(user, uploadId)
    return withLock(uploadId, async () => {
      const part = partPath(uploadId)
      const at = await partSize(uploadId)
      if (at !== m.size) throw error(409, 'incomplete', { offset: at })
      const actual = await hashFile(part)
      if (actual !== m.sha256) {
        await fsp.rm(part, { force: true })
        await fsp.rm(metaPath(uploadId), { force: true })
        throw error(422, 'checksum_mismatch', { offset: 0 })
      }
      return withLock('sha:' + m.sha256, async () => {
        const dup = await have(m.sha256, m.size)
        if (dup) {
          await fsp.rm(part, { force: true })
          await fsp.rm(metaPath(uploadId), { force: true })
          return { ok: true, status: 'done', duplicate: true, path: dup.path }
        }
        const when = new Date(m.takenAt || now())
        const rel = [m.device, String(when.getFullYear()), String(when.getMonth() + 1).padStart(2, '0')]
        const root = library.backupRoot()
        const dir = path.join(root, ...rel)
        await fsp.mkdir(dir, { recursive: true })
        let target = null
        for (let n = 1; n < 10000; n++) {
          const candidate = path.join(dir, n === 1 ? m.name : numbered(m.name, n))
          try {
            const st = await fsp.stat(candidate)
            // The same picture already sitting there (copied in by hand, or an index that was lost):
            // keep the one on disk, record it, and drop the upload.
            if (st.size === m.size && await hashFile(candidate) === m.sha256) {
              await fsp.rm(part, { force: true })
              await fsp.rm(metaPath(uploadId), { force: true })
              const relPath = path.relative(root, candidate)
              load().hashes[m.sha256] = { path: relPath, size: m.size, device: m.device, userId: user.id, at: now() }
              await touchDevice(user, m.device, 1, m.size)
              return { ok: true, status: 'done', duplicate: true, path: relPath.split(path.sep).join('/') }
            }
          } catch (e) {
            if (e.code === 'ENOENT') { target = candidate; break }
            throw e
          }
        }
        if (!target) throw error(409, 'name_collision')
        // No overwrite, even if something appeared since the stat above.
        await fsp.link(part, target).then(() => fsp.rm(part, { force: true })).catch(async (e) => {
          if (e.code === 'EEXIST') throw error(409, 'name_collision')
          await fsp.rename(part, target)
        })
        await fsp.rm(metaPath(uploadId), { force: true })
        if (m.takenAt) {
          const t = new Date(m.takenAt)
          await fsp.utimes(target, t, t).catch(() => {})
        }
        const relPath = path.relative(root, target)
        load().hashes[m.sha256] = { path: relPath, size: m.size, device: m.device, userId: user.id, at: now() }
        await touchDevice(user, m.device, 1, m.size)
        library.noteAdded(target)
        log(`photos: backed up ${m.name} from ${m.device}`)
        return { ok: true, status: 'saved', path: relPath.split(path.sep).join('/') }
      })
    })
  }

  async function touchDevice(user, device, files, bytes) {
    const d = load().devices
    const k = deviceKey(user, device)
    const e = d[k] || { userId: user.id, device, files: 0, bytes: 0, lastBackupAt: null }
    e.files += files
    e.bytes += bytes
    e.lastBackupAt = now()
    d[k] = e
    await save()
  }

  async function summary(user, params) {
    const acc = requireBackup(user)
    const device = params.get('device')
    const list = Object.values(load().devices).filter((e) => acc.owner || e.userId === user.id)
    const mine = device ? list.find((e) => e.userId === user.id && e.device === safeSegment(device, 'Phone', 60)) || null : null
    return {
      ok: true,
      device: mine,
      devices: list.map((e) => ({ device: e.device, files: e.files, bytes: e.bytes, lastBackupAt: e.lastBackupAt, mine: e.userId === user.id })),
      folder: acc.owner ? library.backupRoot() : undefined,
      chunkSize: 512 * 1024
    }
  }

  return { check, begin, status, chunk, finish, summary, _index: () => load() }
}

module.exports = { createPhotoBackup, safeSegment, numbered, hashFile, MAX_CHUNK }
