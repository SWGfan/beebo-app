'use strict'
// A person's own recordings of themselves singing along to a song (the Music page's
// Record button). Every recording belongs to one account and is only ever listed,
// played or deleted by that account; another person's recording id answers exactly
// like an id that does not exist.
//
// Same pattern as the rest of the per-user data: the metadata lives in the app store
// keyed by user id (store 'musicRecordings' = { [userId]: [ Recording ] }) and
// userDeletion.js drops it with the account; the media files sit beside the store's
// file in music-recordings/<hash of user id>/<recording id>.<ext>.

const fs = require('fs')
const fsp = require('fs/promises')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { Transform } = require('stream')
const { pipeline } = require('stream/promises')

const STORE_KEY = 'musicRecordings'
const ID_RE = /^[a-f0-9]{20}$/
const MAX_BYTES = 512 * 1024 * 1024
const MAX_PER_USER = 200
const MAX_DURATION_MS = 6 * 60 * 60 * 1000

// What MediaRecorder produces in Chrome, Firefox and Safari. Anything else is refused,
// so the extension on disk and the type we serve back are always ones we chose.
const TYPES = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'video/webm': 'webm',
  'video/mp4': 'mp4'
}

// "audio/webm;codecs=opus" -> { mime: 'audio/webm', ext: 'webm', kind: 'audio' }, or null.
function parseRecordingMime(header) {
  const mime = String(header == null ? '' : header).split(';')[0].trim().toLowerCase()
  const ext = TYPES[mime]
  if (!ext) return null
  return { mime, ext, kind: mime.startsWith('video/') ? 'video' : 'audio' }
}

function defaultRecordingsDir(store) {
  return store && store.path ? path.join(path.dirname(store.path), 'music-recordings') : path.join(os.tmpdir(), 'beebo-music-recordings')
}

const userFolder = (dir, userId) => path.join(dir, crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 32))

const fail = (status, code) => Object.assign(new Error(code), { status, code })

function createRecordings({ store, dir, now = Date.now, maxBytes = MAX_BYTES } = {}) {
  const root = dir || defaultRecordingsDir(store)

  const read = () => {
    const v = store.get(STORE_KEY)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  }
  const rowsOf = (userId) => {
    const rows = read()[userId]
    return Array.isArray(rows) ? rows : []
  }
  const write = (userId, rows) => {
    const next = Object.assign({}, read())
    if (rows.length) next[userId] = rows
    else delete next[userId]
    store.set(STORE_KEY, next)
  }
  const fileOf = (userId, row) => path.join(userFolder(root, userId), `${row.id}.${row.ext}`)
  const shape = (row) => ({
    id: row.id,
    kind: row.kind,
    mime: row.mime,
    size: row.size,
    createdAt: row.createdAt,
    trackId: row.trackId || null,
    trackTitle: row.trackTitle || '',
    trackArtist: row.trackArtist || '',
    mixed: !!row.mixed,
    durationMs: row.durationMs || 0
  })

  // Newest first. A row whose file has gone (a restored backup carries the rows, not the files) is left out.
  function list(userId) {
    if (!userId) return []
    return rowsOf(userId)
      .filter((row) => { try { return fs.statSync(fileOf(userId, row)).isFile() } catch { return false } })
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(shape)
  }

  // { recording, path, mime } for one of THIS person's recordings, else null.
  function find(userId, id) {
    if (!userId || !ID_RE.test(String(id))) return null
    const row = rowsOf(userId).find((r) => r.id === id)
    if (!row) return null
    return { recording: shape(row), path: fileOf(userId, row), mime: row.mime }
  }

  // Writes the request body to disk as it arrives; refuses anything over the size cap.
  async function save(userId, body, { type, trackId, trackTitle, trackArtist, mixed, durationMs } = {}) {
    if (!userId) throw fail(401, 'unauthorized')
    const info = parseRecordingMime(type)
    if (!info) throw fail(415, 'unsupported_type')
    if (rowsOf(userId).length >= MAX_PER_USER) throw fail(409, 'too_many_recordings')
    const id = crypto.randomBytes(10).toString('hex')
    const folder = userFolder(root, userId)
    await fsp.mkdir(folder, { recursive: true })
    const finalPath = path.join(folder, `${id}.${info.ext}`)
    const partPath = finalPath + '.part'
    let size = 0
    const limiter = new Transform({
      transform(chunk, _enc, cb) {
        size += chunk.length
        if (size > maxBytes) cb(fail(413, 'too_large'))
        else cb(null, chunk)
      }
    })
    try {
      await pipeline(body, limiter, fs.createWriteStream(partPath, { flags: 'wx' }))
      if (size === 0) throw fail(400, 'empty')
      await fsp.rename(partPath, finalPath)
    } catch (err) {
      await fsp.rm(partPath, { force: true }).catch(() => {})
      throw err
    }
    const dur = Math.round(Number(durationMs))
    const row = {
      id,
      kind: info.kind,
      mime: info.mime,
      ext: info.ext,
      size,
      createdAt: now(),
      trackId: trackId || null,
      trackTitle: String(trackTitle || '').slice(0, 300),
      trackArtist: String(trackArtist || '').slice(0, 300),
      mixed: !!mixed,
      durationMs: Number.isFinite(dur) ? Math.min(Math.max(dur, 0), MAX_DURATION_MS) : 0
    }
    write(userId, rowsOf(userId).concat(row))
    return shape(row)
  }

  async function remove(userId, id) {
    const hit = userId && ID_RE.test(String(id)) ? rowsOf(userId).find((r) => r.id === id) : null
    if (!hit) return false
    write(userId, rowsOf(userId).filter((r) => r.id !== id))
    await fsp.rm(fileOf(userId, hit), { force: true }).catch(() => {})
    return true
  }

  return { list, find, save, remove, root }
}

// Account deletion: the rows and the person's whole folder.
function removeUserData(store, userId, dir) {
  if (!userId) return
  const v = store.get(STORE_KEY)
  if (v && typeof v === 'object' && !Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, userId)) {
    const next = Object.assign({}, v)
    delete next[userId]
    store.set(STORE_KEY, next)
  }
  try { fs.rmSync(userFolder(dir || defaultRecordingsDir(store), userId), { recursive: true, force: true }) } catch {}
}

module.exports = { createRecordings, parseRecordingMime, removeUserData, defaultRecordingsDir, MAX_BYTES, MAX_PER_USER }
