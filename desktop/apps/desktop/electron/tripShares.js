'use strict'
// Trip sharing, the PC side: private links to a finished trip, served from the owner's own PC.
//
// Beebo hosts nothing. The phone sends a trip's photos and clips here (the same resumable, hashed,
// chunked transfer phone photo backup uses), then asks for a link. The link is a capability: 32 random
// bytes in the URL, stored only as a SHA-256 hash, so a copy of this data folder cannot be turned back
// into working links.
//
//   POST /api/trip-shares/check                 { tripId, items:[{sha256,size}] }            -> which files the PC has
//   POST /api/trip-shares/media/begin           { tripId, kind, sha256, size, w?, h? }        -> { uploadId, offset } | { status:'done' }
//   PUT  /api/trip-shares/media/chunk?uploadId=&offset=   raw bytes, X-Chunk-Sha256           -> { offset }
//   POST /api/trip-shares/media/finish          { uploadId }                                  -> { status:'saved' }
//   POST /api/trip-shares                       { tripId, manifest, options }                 -> { token, path, share }
//   GET  /api/trip-shares   POST .../revoke  .../extend  .../delete   POST /api/trip-shares/trip/delete
//
// Rules enforced here (each has a test in test/trip-shares.test.js):
//  - Links are >= 256 bits, expire (default 30 days, the sender chooses, the owner caps it), can be
//    revoked at any time, and are re-checked on every request. Unknown, expired and revoked look identical.
//  - Every file is type-checked from its own bytes and matched to its SHA-256; video location atoms are
//    blanked on arrival; photo metadata is stripped when a link is served without location.
//  - Storage is capped by the owner; a link's media is deleted when the link is revoked, expires or is
//    deleted (unless another live link for the same trip still needs it).
//  - A song is served only for a link created with "include song" and the sender's rights confirmation.
const fsp = require('node:fs/promises')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { sniff, stripMp4Location } = require('./tripShareMedia')
const { sanitizeManifest } = require('./tripSharePage')

const GiB = 1024 * 1024 * 1024
const MiB = 1024 * 1024
const HOUR = 3600 * 1000

const MAX_CHUNK = 4 * MiB
const CHUNK_SIZE = 512 * 1024
const MAX_PAGE_BYTES = 512 * 1024
const EXPIRED_KEEP_MS = 30 * 24 * HOUR
const STALE_UPLOAD_MS = 3 * 24 * HOUR
const UNUSED_MEDIA_MS = 24 * HOUR
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

const DEFAULT_SETTINGS = {
  enabled: true,
  maxStorageBytes: 10 * GiB,
  maxPhotoBytes: 25 * MiB,
  maxVideoBytes: 500 * MiB,
  maxSongBytes: 40 * MiB,
  defaultExpiryHours: 30 * 24,
  maxExpiryHours: 90 * 24,
  maxLiveShares: 50,
  maxMediaPerTrip: 400
}
// What the owner's own settings may never exceed or fall below.
const SETTING_BOUNDS = {
  maxStorageBytes: [100 * MiB, 2048 * GiB],
  maxPhotoBytes: [1 * MiB, 200 * MiB],
  maxVideoBytes: [10 * MiB, 4 * GiB],
  maxSongBytes: [1 * MiB, 200 * MiB],
  defaultExpiryHours: [1, 365 * 24],
  maxExpiryHours: [1, 365 * 24],
  maxLiveShares: [1, 500],
  maxMediaPerTrip: [1, 2000]
}

const error = (status, code, extra) => Object.assign(new Error(code), { status, code, extra })
const isSha = (s) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s)
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex')

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

/** A trip id from the phone: short, plain characters only (it is only ever hashed into folder names). */
function cleanTripId(value) {
  const s = String(value == null ? '' : value)
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(s)) throw error(400, 'bad_trip_id')
  return s
}

function createTripShares({ dataDir, now = Date.now, log = () => {}, freeSpace, randomBytes = crypto.randomBytes, autoSweep = false } = {}) {
  if (!dataDir) throw new Error('dataDir required')
  const indexFile = path.join(dataDir, 'index.json')
  const mediaRoot = path.join(dataDir, 'media')
  const incomingDir = path.join(dataDir, 'incoming')
  const sharesDir = path.join(dataDir, 'shares')
  let idx = null
  let byToken = new Map()
  let saveChain = Promise.resolve()
  let viewTimer = null
  const locks = new Map()
  const shareCache = new Map()

  /* ------------------------------ index ------------------------------ */

  function load() {
    if (idx) return idx
    idx = { v: 1, settings: { ...DEFAULT_SETTINGS }, packages: {}, shares: {} }
    try {
      const raw = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
      if (raw && raw.v === 1) {
        idx.settings = cleanSettings({ ...DEFAULT_SETTINGS, ...(raw.settings || {}) })
        idx.packages = raw.packages && typeof raw.packages === 'object' ? raw.packages : {}
        idx.shares = raw.shares && typeof raw.shares === 'object' ? raw.shares : {}
      }
    } catch {}
    byToken = new Map()
    for (const s of Object.values(idx.shares)) if (s.tokenHash && !s.revokedAt) byToken.set(s.tokenHash, s.id)
    return idx
  }

  function save() {
    saveChain = saveChain.then(async () => {
      await fsp.mkdir(dataDir, { recursive: true })
      const tmp = indexFile + '.' + process.pid + '.tmp'
      await fsp.writeFile(tmp, JSON.stringify(idx))
      await fsp.rename(tmp, indexFile)
    }).catch((e) => log('trip shares: could not save the index: ' + e.message))
    return saveChain
  }

  async function withLock(key, fn) {
    while (locks.has(key)) await locks.get(key).catch(() => {})
    let done
    const p = new Promise((r) => { done = r })
    locks.set(key, p)
    try { return await fn() } finally { locks.delete(key); done() }
  }

  /* ------------------------------ settings ------------------------------ */

  function cleanSettings(input) {
    const out = { ...DEFAULT_SETTINGS }
    out.enabled = input.enabled !== false
    for (const [k, [lo, hi]] of Object.entries(SETTING_BOUNDS)) {
      const n = Number(input[k])
      out[k] = Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.floor(n))) : DEFAULT_SETTINGS[k]
    }
    if (out.defaultExpiryHours > out.maxExpiryHours) out.defaultExpiryHours = out.maxExpiryHours
    return out
  }

  const settings = () => ({ ...load().settings })

  function setSettings(patch) {
    const i = load()
    const merged = { ...i.settings }
    for (const k of Object.keys(DEFAULT_SETTINGS)) if (patch && patch[k] !== undefined) merged[k] = patch[k]
    i.settings = cleanSettings(merged)
    save()
    return { ...i.settings }
  }

  /* ------------------------------ helpers ------------------------------ */

  const pkgKey = (userId, tripId) => sha256(String(userId) + '|' + tripId).slice(0, 24)
  const mediaPath = (pkg, sha) => path.join(mediaRoot, pkg, sha)
  const partPath = (id) => path.join(incomingDir, id + '.part')
  const metaPath = (id) => path.join(incomingDir, id + '.json')
  const sharePath = (id) => path.join(sharesDir, id + '.json')
  const canManage = (user, rec) => !!user && (user.isAdmin === true || rec.userId === user.id)
  const isLive = (s) => !s.revokedAt && s.expiresAt > now()

  function statusOf(s) {
    if (s.revokedAt) return 'revoked'
    return s.expiresAt <= now() ? 'expired' : 'live'
  }

  function publicShare(s) {
    const pkg = load().packages[s.pkg]
    return {
      id: s.id, tripId: pkg ? pkg.tripId : '', pkg: s.pkg, userId: s.userId, title: s.title, status: statusOf(s),
      createdAt: s.createdAt, expiresAt: s.expiresAt, revokedAt: s.revokedAt || null,
      options: { includeLocation: !!s.options.includeLocation, includeSong: !!s.options.includeSong, viewOnly: true },
      views: s.views || 0, lastViewedAt: s.lastViewedAt || null, mediaCount: s.mediaCount || 0
    }
  }

  function bytesOf(pkg) {
    return Object.values(pkg.media || {}).reduce((sum, m) => sum + (m.size || 0), 0)
  }

  async function incomingBytes() {
    let total = 0
    try {
      for (const name of await fsp.readdir(incomingDir)) {
        if (!name.endsWith('.part')) continue
        const st = await fsp.stat(path.join(incomingDir, name)).catch(() => null)
        if (st) total += st.size
      }
    } catch {}
    return total
  }

  async function usage() {
    const i = load()
    const used = Object.values(i.packages).reduce((sum, p) => sum + bytesOf(p), 0)
    return { used, incoming: await incomingBytes(), cap: i.settings.maxStorageBytes }
  }

  const hasMedia = async (pkg, sha, size) => {
    const rec = pkg && pkg.media && pkg.media[sha]
    if (!rec) return null
    try {
      const st = await fsp.stat(mediaPath(pkg.id, sha))
      if (st.isFile() && (size == null || Number(size) === rec.size)) return rec
    } catch {}
    delete pkg.media[sha]
    return null
  }

  /* --------------------------- garbage collection --------------------------- */

  /** Delete media of [pkg] that no live link needs (an upload waiting for its link gets a day). */
  async function gc(pkg) {
    if (!pkg) return 0
    const wanted = new Set()
    for (const s of Object.values(load().shares)) if (s.pkg === pkg.id && isLive(s)) for (const r of s.refs || []) wanted.add(r)
    let removed = 0
    for (const [sha, rec] of Object.entries(pkg.media || {})) {
      if (wanted.has(sha)) continue
      if (!rec.used && now() - rec.addedAt < UNUSED_MEDIA_MS) continue
      await fsp.rm(mediaPath(pkg.id, sha), { force: true })
      delete pkg.media[sha]
      removed++
    }
    if (removed) await save()
    return removed
  }

  async function dropShareRecord(s) {
    const i = load()
    delete i.shares[s.id]
    if (s.tokenHash) byToken.delete(s.tokenHash)
    shareCache.delete(s.id)
    await fsp.rm(sharePath(s.id), { force: true })
  }

  /* ------------------------------ uploads ------------------------------ */

  const limitFor = (kind) => {
    const st = load().settings
    return kind === 'photo' ? st.maxPhotoBytes : kind === 'video' ? st.maxVideoBytes : st.maxSongBytes
  }

  async function check(user, body) {
    const tripId = cleanTripId(body && body.tripId)
    const pkg = load().packages[pkgKey(user.id, tripId)]
    const items = Array.isArray(body && body.items) ? body.items.slice(0, 1000) : []
    const results = []
    for (const it of items) {
      const sha = String((it && it.sha256) || '').toLowerCase()
      results.push({ sha256: sha, have: isSha(sha) && !!(await hasMedia(pkg, sha, it.size)) })
    }
    return { ok: true, results }
  }

  async function begin(user, body) {
    const i = load()
    if (!i.settings.enabled) throw error(403, 'trip_sharing_off')
    const tripId = cleanTripId(body && body.tripId)
    const kind = String((body && body.kind) || '')
    if (!['photo', 'video', 'audio'].includes(kind)) throw error(400, 'bad_kind')
    const sha = String((body && body.sha256) || '').toLowerCase()
    const size = Number(body && body.size)
    if (!isSha(sha)) throw error(400, 'bad_checksum')
    if (!Number.isSafeInteger(size) || size <= 0) throw error(400, 'bad_size')
    if (size > limitFor(kind)) throw error(413, 'file_too_large', { limit: limitFor(kind) })
    const key = pkgKey(user.id, tripId)
    let pkg = i.packages[key]
    if (pkg) {
      const existing = await hasMedia(pkg, sha, size)
      if (existing) return { ok: true, status: 'done', duplicate: true }
      if (Object.keys(pkg.media).length >= i.settings.maxMediaPerTrip) throw error(400, 'too_many_files')
    }
    const u = await usage()
    if (u.used + u.incoming + size > u.cap) throw error(507, 'trip_storage_full', { used: u.used, cap: u.cap })
    await fsp.mkdir(incomingDir, { recursive: true })
    if (typeof freeSpace === 'function') {
      const free = await freeSpace(dataDir).catch(() => null)
      if (free != null && free < size + 512 * MiB) throw error(507, 'pc_disk_full')
    } else if (fsp.statfs) {
      try {
        const s = await fsp.statfs(dataDir)
        if (s.bavail * s.bsize < size + 512 * MiB) throw error(507, 'pc_disk_full')
      } catch (e) { if (e.status) throw e }
    }
    const uploadId = crypto.createHash('sha1').update(user.id + '|' + tripId + '|' + sha + '|' + size).digest('hex')
    return withLock(uploadId, async () => {
      let m = null
      try { m = JSON.parse(await fsp.readFile(metaPath(uploadId), 'utf8')) } catch {}
      if (!m) {
        m = { uploadId, userId: user.id, tripId, kind, sha256: sha, size, w: Number(body.w) || 0, h: Number(body.h) || 0, startedAt: now() }
        await fsp.writeFile(metaPath(uploadId), JSON.stringify(m))
        await fsp.writeFile(partPath(uploadId), Buffer.alloc(0), { flag: 'a' })
      }
      const offset = await partSize(uploadId)
      return { ok: true, status: offset > 0 ? 'resume' : 'new', uploadId, offset, chunkSize: CHUNK_SIZE, maxChunk: MAX_CHUNK }
    })
  }

  async function partSize(uploadId) {
    try { return (await fsp.stat(partPath(uploadId))).size } catch { return 0 }
  }

  async function readMeta(user, uploadId) {
    if (typeof uploadId !== 'string' || !/^[a-f0-9]{40}$/.test(uploadId)) throw error(400, 'bad_upload_id')
    let m
    try { m = JSON.parse(await fsp.readFile(metaPath(uploadId), 'utf8')) } catch { throw error(404, 'upload_not_found') }
    if (m.userId !== user.id) throw error(404, 'upload_not_found')
    return m
  }

  async function status(user, uploadId) {
    const m = await readMeta(user, uploadId)
    return { ok: true, uploadId, offset: await partSize(uploadId), size: m.size }
  }

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
      if (declared && sha256(data) !== declared) throw error(422, 'chunk_checksum_mismatch', { offset: at })
      const fh = await fsp.open(partPath(uploadId), 'r+')
      try { await fh.write(data, 0, data.length, at) } finally { await fh.close() }
      return { ok: true, uploadId, offset: at + data.length, size: m.size }
    })
  }

  async function discard(uploadId) {
    await fsp.rm(partPath(uploadId), { force: true })
    await fsp.rm(metaPath(uploadId), { force: true })
  }

  async function finish(user, body) {
    const uploadId = String((body && body.uploadId) || '')
    const m = await readMeta(user, uploadId)
    return withLock(uploadId, async () => {
      const part = partPath(uploadId)
      const at = await partSize(uploadId)
      if (at !== m.size) throw error(409, 'incomplete', { offset: at })
      if (await hashFile(part) !== m.sha256) {
        await discard(uploadId)
        throw error(422, 'checksum_mismatch', { offset: 0 })
      }
      const fh = await fsp.open(part, 'r')
      const head = Buffer.alloc(16)
      let read
      try { read = (await fh.read(head, 0, 16, 0)).bytesRead } finally { await fh.close() }
      const type = sniff(head.subarray(0, read))
      if (!type || type.kind !== m.kind) {
        await discard(uploadId)
        throw error(415, 'wrong_file_type')
      }
      if (type.kind === 'video') {
        try { await stripMp4Location(part) } catch (e) { await discard(uploadId); throw e }
      }
      const i = load()
      const key = pkgKey(user.id, m.tripId)
      let pkg = i.packages[key]
      if (!pkg) pkg = i.packages[key] = { id: key, userId: user.id, tripId: m.tripId, name: '', createdAt: now(), media: {} }
      pkg.updatedAt = now()
      await fsp.mkdir(path.join(mediaRoot, key), { recursive: true })
      await fsp.rename(part, mediaPath(key, m.sha256)).catch(async () => {
        await fsp.copyFile(part, mediaPath(key, m.sha256))
        await fsp.rm(part, { force: true })
      })
      await fsp.rm(metaPath(uploadId), { force: true })
      pkg.media[m.sha256] = { size: m.size, kind: type.kind, mime: type.mime, ext: type.ext, w: m.w || 0, h: m.h || 0, addedAt: now(), used: false }
      await save()
      log(`trip shares: stored a ${type.kind} for trip ${m.tripId}`)
      return { ok: true, status: 'saved' }
    })
  }

  /* ------------------------------ shares ------------------------------ */

  function shaRefsIn(raw) {
    const out = []
    const src = raw && typeof raw === 'object' ? raw : {}
    const add = (sha, kinds) => { if (typeof sha === 'string') out.push({ sha: sha.toLowerCase(), kinds }) }
    const walk = (items) => {
      for (const it of Array.isArray(items) ? items : []) {
        if (it && (it.kind === 'photo' || it.kind === 'video') && it.media) add(it.media.sha, [it.kind])
      }
    }
    for (const d of Array.isArray(src.days) ? src.days : []) walk(d && d.items)
    walk(src.undated)
    if (src.song && typeof src.song === 'object') add(src.song.sha, ['audio'])
    return out
  }

  async function createShare(user, body) {
    const i = load()
    if (!i.settings.enabled) throw error(403, 'trip_sharing_off')
    const tripId = cleanTripId(body && body.tripId)
    const opts = (body && body.options && typeof body.options === 'object') ? body.options : {}
    const includeLocation = opts.includeLocation === true
    const includeSong = opts.includeSong === true
    if (includeSong && opts.rightsAck !== true) throw error(400, 'rights_ack_required')

    const mine = Object.values(i.shares).filter((s) => s.userId === user.id && isLive(s))
    if (mine.length >= i.settings.maxLiveShares) throw error(429, 'too_many_links', { limit: i.settings.maxLiveShares })

    const key = pkgKey(user.id, tripId)
    let pkg = i.packages[key]
    if (!pkg) pkg = i.packages[key] = { id: key, userId: user.id, tripId, name: '', createdAt: now(), media: {} }

    // Every file the manifest points at must already be on this PC, with the kind the page will use it as.
    const missing = []
    for (const r of shaRefsIn(body && body.manifest)) {
      const rec = isSha(r.sha) ? await hasMedia(pkg, r.sha, null) : null
      if (!rec || !r.kinds.includes(rec.kind)) missing.push(r.sha)
    }
    if (missing.length) throw error(409, 'media_missing', { missing: missing.slice(0, 20) })

    const { page, mediaRefs } = sanitizeManifest(body && body.manifest, {
      lookup: (sha) => { const r = pkg.media[sha]; return r ? { kind: r.kind, mime: r.mime } : null },
      includeLocation, includeSong
    })
    if (includeSong && !page.song) throw error(400, 'song_missing')

    let hours = Number(opts.expiresInHours)
    if (!Number.isFinite(hours) || hours <= 0) hours = includeSong ? 48 : i.settings.defaultExpiryHours
    hours = Math.min(Math.max(1, Math.floor(hours)), i.settings.maxExpiryHours)

    const data = JSON.stringify({ page, mediaRefs })
    if (Buffer.byteLength(data) > MAX_PAGE_BYTES) throw error(413, 'trip_too_large')

    const token = randomBytes(32).toString('base64url')
    const id = randomBytes(8).toString('hex')
    const share = {
      id, pkg: key, userId: user.id, tokenHash: sha256(token), title: page.title, createdAt: now(), expiresAt: now() + hours * HOUR,
      revokedAt: null, options: { includeLocation, includeSong, viewOnly: true }, rightsAckAt: includeSong ? now() : null,
      views: 0, lastViewedAt: null, mediaCount: mediaRefs.length, refs: mediaRefs.map((r) => r.sha)
    }
    if (body && typeof body.name === 'string') pkg.name = String(body.name).slice(0, 120)
    else if (!pkg.name) pkg.name = page.title
    await fsp.mkdir(sharesDir, { recursive: true })
    await fsp.writeFile(sharePath(id), data)
    i.shares[id] = share
    byToken.set(share.tokenHash, id)
    for (const r of mediaRefs) if (pkg.media[r.sha]) pkg.media[r.sha].used = true
    pkg.updatedAt = now()
    await save()
    log(`trip shares: new link ${id} for "${page.title}" (expires in ${hours} h)`)
    return { ok: true, token, path: '/trip/' + token, share: publicShare(share) }
  }

  function list(user, { all = false } = {}) {
    const i = load()
    const out = Object.values(i.shares)
      .filter((s) => (all && user.isAdmin === true) || s.userId === user.id)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(publicShare)
    return out
  }

  async function packages(user, { all = false } = {}) {
    const i = load()
    return Object.values(i.packages)
      .filter((p) => (all && user.isAdmin === true) || p.userId === user.id)
      .map((p) => ({
        id: p.id, tripId: p.tripId, userId: p.userId, name: p.name || p.tripId, createdAt: p.createdAt, updatedAt: p.updatedAt || p.createdAt,
        mediaCount: Object.keys(p.media).length, bytes: bytesOf(p),
        liveShares: Object.values(i.shares).filter((s) => s.pkg === p.id && isLive(s)).length
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  function shareFor(user, id) {
    const s = load().shares[String(id || '')]
    if (!s || !canManage(user, s)) throw error(404, 'link_not_found')
    return s
  }

  async function revoke(user, id) {
    const s = shareFor(user, id)
    if (!s.revokedAt) {
      s.revokedAt = now()
      byToken.delete(s.tokenHash)
      await save()
    }
    await gc(load().packages[s.pkg])
    return { ok: true, share: publicShare(s) }
  }

  async function extend(user, id, hours) {
    const s = shareFor(user, id)
    if (s.revokedAt) throw error(409, 'link_revoked')
    if (s.expiresAt <= now()) throw error(409, 'link_expired')
    const i = load()
    const h = Math.min(Math.max(1, Math.floor(Number(hours) || i.settings.defaultExpiryHours)), i.settings.maxExpiryHours)
    s.expiresAt = now() + h * HOUR
    await save()
    return { ok: true, share: publicShare(s) }
  }

  async function removeShare(user, id) {
    const s = shareFor(user, id)
    await dropShareRecord(s)
    await save()
    await gc(load().packages[s.pkg])
    return { ok: true }
  }

  /** Delete a whole trip from this PC: every link to it and every file. [ref] is { tripId } or { pkg }. */
  async function deleteTrip(user, ref) {
    const i = load()
    const key = ref && ref.pkg ? String(ref.pkg) : pkgKey(user.id, cleanTripId(ref && ref.tripId))
    const pkg = i.packages[key]
    if (!pkg || !canManage(user, pkg)) throw error(404, 'trip_not_found')
    for (const s of Object.values(i.shares)) if (s.pkg === key) await dropShareRecord(s)
    delete i.packages[key]
    await fsp.rm(path.join(mediaRoot, key), { recursive: true, force: true })
    // Half-sent uploads for this trip go too.
    try {
      for (const name of await fsp.readdir(incomingDir)) {
        if (!name.endsWith('.json')) continue
        const m = JSON.parse(await fsp.readFile(path.join(incomingDir, name), 'utf8').catch(() => 'null'))
        if (m && m.userId === pkg.userId && m.tripId === pkg.tripId) await discard(m.uploadId)
      }
    } catch {}
    await save()
    log(`trip shares: deleted trip ${pkg.tripId} and its links`)
    return { ok: true }
  }

  /* ------------------------------ serving ------------------------------ */

  /** The live share behind a link token, or null (unknown, expired and revoked are indistinguishable). */
  function resolve(token) {
    const i = load()
    if (!i.settings.enabled || typeof token !== 'string' || !TOKEN_RE.test(token)) return null
    const id = byToken.get(sha256(token))
    const s = id && i.shares[id]
    if (!s || !isLive(s)) return null
    return s
  }

  async function shareData(s) {
    if (shareCache.has(s.id)) return shareCache.get(s.id)
    let data
    try { data = JSON.parse(await fsp.readFile(sharePath(s.id), 'utf8')) } catch { return null }
    if (!data || !data.page) return null
    if (shareCache.size > 20) shareCache.delete(shareCache.keys().next().value)
    shareCache.set(s.id, data)
    return data
  }

  /** The file behind media reference [index] of a live share, addressed only through the share's own list. */
  async function mediaFile(s, index) {
    const data = await shareData(s)
    if (!data || !Number.isInteger(index) || index < 0) return null
    const ref = (data.mediaRefs || [])[index]
    if (!ref || !isSha(ref.sha)) return null
    if (ref.kind === 'audio' && !s.options.includeSong) return null
    const pkg = load().packages[s.pkg]
    const rec = pkg && pkg.media[ref.sha]
    if (!rec) return null
    const full = mediaPath(s.pkg, ref.sha)
    try {
      const st = await fsp.stat(full)
      if (!st.isFile()) return null
      return { full, size: st.size, mime: rec.mime, kind: rec.kind }
    } catch { return null }
  }

  function noteView(s) {
    s.views = (s.views || 0) + 1
    s.lastViewedAt = now()
    if (!viewTimer) {
      viewTimer = setTimeout(() => { viewTimer = null; save() }, 5000)
      if (viewTimer.unref) viewTimer.unref()
    }
  }

  async function flush() {
    if (viewTimer) { clearTimeout(viewTimer); viewTimer = null }
    await save()
  }

  /* ------------------------------ upkeep ------------------------------ */

  async function sweep() {
    const i = load()
    for (const s of Object.values(i.shares)) {
      const ended = s.revokedAt || (s.expiresAt <= now() ? s.expiresAt : 0)
      if (ended && now() - ended > EXPIRED_KEEP_MS) await dropShareRecord(s)
    }
    for (const pkg of Object.values(i.packages)) {
      await gc(pkg)
      const hasShares = Object.values(i.shares).some((s) => s.pkg === pkg.id)
      if (!hasShares && !Object.keys(pkg.media).length && now() - (pkg.updatedAt || pkg.createdAt) > UNUSED_MEDIA_MS) delete i.packages[pkg.id]
    }
    try {
      for (const name of await fsp.readdir(incomingDir)) {
        const full = path.join(incomingDir, name)
        const st = await fsp.stat(full).catch(() => null)
        if (st && now() - st.mtimeMs > STALE_UPLOAD_MS) await fsp.rm(full, { force: true })
      }
    } catch {}
    await save()
  }

  if (autoSweep) {
    setTimeout(() => sweep().catch(() => {}), 30 * 1000).unref()
    setInterval(() => sweep().catch(() => {}), HOUR).unref()
  }

  return {
    settings, setSettings, usage, check, begin, status, chunk, finish,
    createShare, list, packages, revoke, extend, removeShare, deleteTrip,
    resolve, shareData, mediaFile, noteView, flush, sweep,
    _index: () => load()
  }
}

module.exports = { createTripShares, DEFAULT_SETTINGS, SETTING_BOUNDS, TOKEN_RE, MAX_CHUNK, CHUNK_SIZE }
