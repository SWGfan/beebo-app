'use strict'
// Photo and video metadata for the Photos library: when a picture was taken, which way up it is,
// and whether it carries a location. Pure Node (no native modules), so it runs in tests and in the
// packaged app alike. Everything is defensive: a truncated or hostile file yields null, never throws.
//
// Formats covered:
//  - JPEG: APP1 "Exif" segment.
//  - HEIC/HEIF, WebP, PNG (eXIf), TIFF/DNG: the TIFF block found by its "Exif\0\0" prefix or its
//    own header. HEIC stores Exif as an item whose data starts with a 4-byte offset and then
//    "Exif\0\0", so a bounded scan of the first part of the file finds it without an ISOBMFF parser.
//  - MP4/MOV/3GP/M4V: the movie header box (moov/mvhd) creation time.
const fs = require('node:fs/promises')

const HEAD_BYTES = 512 * 1024
// Nearly every camera puts the Exif block (at most 64 KB) right after the JPEG's first bytes, so reading 96 KB is enough and
// a 100,000-photo library is not 50 GB of reads on the first scan. A file that shows nothing in that much is read again in
// full, exactly as before, so no answer changes.
const FIRST_READ_BYTES = 96 * 1024
const MAC_EPOCH_OFFSET = 2082844800 // seconds from 1904-01-01 to 1970-01-01

/**
 * "YYYY:MM:DD HH:MM:SS" (EXIF) to epoch milliseconds. With an EXIF offset ("+02:00") the result is
 * the exact instant; without one it is read as local wall-clock time on this PC, which is what a
 * timeline grouped by day wants. Returns null for blanks, zeros and impossible dates.
 */
function parseExifDate(value, offset, { now = Date.now() } = {}) {
  if (typeof value !== 'string') return null
  const m = /^\s*(\d{4})[:\-](\d{2})[:\-](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(value)
  if (!m) return null
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] || '0'].map(Number)
  if (y < 1900 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60) return null
  let t
  const off = typeof offset === 'string' ? /^\s*([+-])(\d{2}):?(\d{2})\s*$/.exec(offset) : null
  if (off) {
    const mins = (Number(off[2]) * 60 + Number(off[3])) * (off[1] === '-' ? -1 : 1)
    t = Date.UTC(y, mo - 1, d, h, mi, s) - mins * 60000
    const check = new Date(Date.UTC(y, mo - 1, d))
    if (check.getUTCDate() !== d) return null
  } else {
    const local = new Date(y, mo - 1, d, h, mi, s)
    if (local.getDate() !== d || local.getMonth() !== mo - 1) return null
    t = local.getTime()
  }
  if (!Number.isFinite(t) || t > now + 2 * 86400000) return null
  return t
}

/** Where the TIFF header of an Exif block starts inside [buf], or -1. */
function findTiff(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return -1
  // JPEG: walk the segments up to the image data.
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    while (i + 4 <= buf.length) {
      if (buf[i] !== 0xff) return -1
      const marker = buf[i + 1]
      if (marker === 0xd9 || marker === 0xda) return -1
      if (marker === 0xff) { i++; continue }
      const len = buf.readUInt16BE(i + 2)
      if (len < 2) return -1
      if (marker === 0xe1 && buf.toString('latin1', i + 4, i + 10) === 'Exif\0\0') return i + 10
      i += 2 + len
    }
    return -1
  }
  // TIFF-based raw files (DNG etc.) are an Exif block themselves.
  if (isTiffHeader(buf, 0)) return 0
  // HEIC / WebP / anything else carrying "Exif\0\0" + TIFF header.
  let from = 0
  for (;;) {
    const at = buf.indexOf('Exif\0\0', from, 'latin1')
    if (at < 0) break
    if (isTiffHeader(buf, at + 6)) return at + 6
    from = at + 1
  }
  // PNG eXIf chunk and WebP EXIF chunk store the TIFF block with no prefix.
  for (const tag of ['eXIf', 'EXIF']) {
    const at = buf.indexOf(tag, 0, 'latin1')
    if (at >= 0) {
      const start = tag === 'eXIf' ? at + 4 : at + 8
      if (isTiffHeader(buf, start)) return start
    }
  }
  return -1
}

function isTiffHeader(buf, i) {
  if (i < 0 || i + 8 > buf.length) return false
  const a = buf.toString('latin1', i, i + 2)
  if (a === 'II') return buf.readUInt16LE(i + 2) === 42
  if (a === 'MM') return buf.readUInt16BE(i + 2) === 42
  return false
}

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 }

/** Parse the tags Beebo uses out of the TIFF block at [start]. Never throws. */
function parseTiff(buf, start) {
  const out = {}
  try {
    const le = buf.toString('latin1', start, start + 2) === 'II'
    const u16 = (o) => (le ? buf.readUInt16LE(start + o) : buf.readUInt16BE(start + o))
    const u32 = (o) => (le ? buf.readUInt32LE(start + o) : buf.readUInt32BE(start + o))
    const inRange = (o, n) => o >= 0 && start + o + n <= buf.length
    const readIfd = (offset, seen) => {
      const tags = new Map()
      if (!offset || seen.has(offset) || !inRange(offset, 2)) return tags
      seen.add(offset)
      const count = Math.min(u16(offset), 512)
      for (let k = 0; k < count; k++) {
        const e = offset + 2 + k * 12
        if (!inRange(e, 12)) break
        const tag = u16(e), type = u16(e + 2), n = u32(e + 4)
        const size = (TYPE_SIZE[type] || 0) * n
        if (!size || size > 65536) continue
        const valueAt = size <= 4 ? e + 8 : u32(e + 8)
        if (!inRange(valueAt, size)) continue
        tags.set(tag, { type, n, at: valueAt })
      }
      return tags
    }
    const ascii = (t) => t && t.type === 2 ? buf.toString('latin1', start + t.at, start + t.at + t.n).replace(/\0+$/, '').trim() : null
    const short = (t) => t && t.type === 3 ? u16(t.at) : t && t.type === 4 ? u32(t.at) : null
    const long = (t) => t && (t.type === 4 || t.type === 13) ? u32(t.at) : short(t)
    const rationals = (t) => {
      if (!t || t.type !== 5) return null
      const vals = []
      for (let i = 0; i < t.n && i < 3; i++) {
        const num = u32(t.at + i * 8), den = u32(t.at + i * 8 + 4)
        vals.push(den ? num / den : 0)
      }
      return vals
    }
    const seen = new Set()
    const ifd0 = readIfd(u32(4), seen)
    const make = ascii(ifd0.get(0x010f)), model = ascii(ifd0.get(0x0110))
    if (make) out.make = make.slice(0, 64)
    if (model) out.model = model.slice(0, 64)
    const orientation = short(ifd0.get(0x0112))
    if (orientation >= 1 && orientation <= 8) out.orientation = orientation
    const dateTime = ascii(ifd0.get(0x0132))
    const exifIfd = ifd0.has(0x8769) ? readIfd(long(ifd0.get(0x8769)), seen) : new Map()
    const original = ascii(exifIfd.get(0x9003)) || ascii(exifIfd.get(0x9004))
    const offset = ascii(exifIfd.get(0x9011)) || ascii(exifIfd.get(0x9010))
    out.takenAt = parseExifDate(original, offset) || parseExifDate(dateTime, offset) || null
    if (ifd0.has(0x8825)) {
      const gps = readIfd(long(ifd0.get(0x8825)), seen)
      const lat = rationals(gps.get(2)), lon = rationals(gps.get(4))
      const latRef = ascii(gps.get(1)), lonRef = ascii(gps.get(3))
      if (lat && lon && lat.length === 3 && lon.length === 3) {
        let la = lat[0] + lat[1] / 60 + lat[2] / 3600
        let lo = lon[0] + lon[1] / 60 + lon[2] / 3600
        if (latRef === 'S') la = -la
        if (lonRef === 'W') lo = -lo
        if (Number.isFinite(la) && Number.isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180 && (la || lo)) {
          out.location = { lat: Math.round(la * 1e6) / 1e6, lon: Math.round(lo * 1e6) / 1e6 }
        }
      }
    }
  } catch { /* truncated or malformed: keep whatever was read */ }
  return out
}

/** Exif facts from a buffer holding the start of a photo file. */
function exifFromBuffer(buf) {
  const at = findTiff(buf)
  return at < 0 ? {} : parseTiff(buf, at)
}

/** Movie header creation time from an ISO base media file (MP4/MOV/3GP). */
async function videoCreatedAt(handle, fileSize) {
  const header = Buffer.alloc(16)
  const readAt = async (buf, pos, len = buf.length) => (await handle.read(buf, 0, len, pos)).bytesRead
  const walk = async (from, to, depth) => {
    let pos = from
    let guard = 0
    while (pos + 8 <= to && guard++ < 4096) {
      if (await readAt(header, pos, 16) < 8) return null
      let size = header.readUInt32BE(0)
      const type = header.toString('latin1', 4, 8)
      let headerLen = 8
      if (size === 1) { size = Number(header.readBigUInt64BE(8)); headerLen = 16 }
      else if (size === 0) size = to - pos
      if (size < headerLen || pos + size > to + 8) return null
      if (type === 'moov' && depth === 0) return walk(pos + headerLen, Math.min(pos + size, to), 1)
      if (type === 'mvhd' && depth === 1) {
        const box = Buffer.alloc(20)
        if (await readAt(box, pos + headerLen, 20) < 20) return null
        const version = box[0]
        const secs = version === 1 ? Number(box.readBigUInt64BE(4)) : box.readUInt32BE(4)
        if (!secs || secs <= MAC_EPOCH_OFFSET) return null
        const t = (secs - MAC_EPOCH_OFFSET) * 1000
        return t > Date.now() + 2 * 86400000 ? null : t
      }
      pos += size
    }
    return null
  }
  return walk(0, fileSize, 0)
}

/** Capture time from a camera-style filename (IMG_20260904_101500.jpg, PXL_20260904..., Screenshot_2026-09-04-...). */
function dateFromName(name, { now = Date.now() } = {}) {
  const m = String(name || '').match(/(?:^|[^\d])(20\d{2}|19\d{2})[-_.]?(\d{2})[-_.]?(\d{2})(?:[T_ .-]?(\d{2})[-_.:]?(\d{2})[-_.:]?(\d{2}))?(?!\d)/)
  if (!m) return null
  const y = +m[1], mo = +m[2], d = +m[3], h = +(m[4] || 12), mi = +(m[5] || 0), s = +(m[6] || 0)
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null
  const t = new Date(y, mo - 1, d, h, mi, s)
  if (t.getDate() !== d) return null
  const ms = t.getTime()
  return ms > now + 2 * 86400000 ? null : ms
}

const VIDEO_BOX = new Set(['.mp4', '.mov', '.m4v', '.3gp', '.3g2'])

/**
 * Everything the library records about one media file: { takenAt, takenFrom, orientation?,
 * location?, make?, model? }. takenFrom says which source won: exif, video, name or file.
 */
async function readMediaInfo(filePath, stat, { now = Date.now() } = {}) {
  const ext = require('node:path').extname(filePath).toLowerCase()
  const info = { takenAt: null, takenFrom: 'file' }
  let handle
  try {
    handle = await fs.open(filePath, 'r')
    if (VIDEO_BOX.has(ext)) {
      const t = await videoCreatedAt(handle, stat.size)
      if (t) { info.takenAt = t; info.takenFrom = 'video' }
    } else {
      let buf = Buffer.alloc(Math.min(FIRST_READ_BYTES, stat.size))
      let { bytesRead } = await handle.read(buf, 0, buf.length, 0)
      let exif = exifFromBuffer(buf.subarray(0, bytesRead))
      if (!exif.takenAt && stat.size > buf.length) {
        buf = Buffer.alloc(Math.min(HEAD_BYTES, stat.size))
        ;({ bytesRead } = await handle.read(buf, 0, buf.length, 0))
        exif = exifFromBuffer(buf.subarray(0, bytesRead))
      }
      if (exif.takenAt) { info.takenAt = exif.takenAt; info.takenFrom = 'exif' }
      for (const k of ['orientation', 'location', 'make', 'model']) if (exif[k] !== undefined) info[k] = exif[k]
    }
  } catch { /* unreadable: fall through to name/file time */ } finally {
    if (handle) await handle.close().catch(() => {})
  }
  if (!info.takenAt) {
    const fromName = dateFromName(require('node:path').basename(filePath), { now })
    if (fromName) { info.takenAt = fromName; info.takenFrom = 'name' }
  }
  if (!info.takenAt) {
    // A copy only ever moves file times later, so the earliest is closest to the original.
    const times = [stat.mtimeMs, stat.birthtimeMs].filter((x) => typeof x === 'number' && x > 0)
    info.takenAt = times.length ? Math.floor(Math.min(...times)) : 0
  }
  return info
}

/**
 * A JPEG with every metadata segment removed (APP1..APP15 and COM), keeping APP0 (JFIF) and the
 * image. Used on every thumbnail and viewing copy that leaves the PC, so no Exif - camera serial,
 * location, owner name - travels with a shared picture. Non-JPEG input is returned unchanged.
 */
function stripJpegMetadata(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return buf
  const parts = [buf.subarray(0, 2)]
  let i = 2
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return buf
    const marker = buf[i + 1]
    if (marker === 0xda) { parts.push(buf.subarray(i)); return Buffer.concat(parts) }
    if (marker === 0xd9) { parts.push(buf.subarray(i)); return Buffer.concat(parts) }
    if (marker === 0xff) { i++; continue }
    const len = buf.readUInt16BE(i + 2)
    if (len < 2 || i + 2 + len > buf.length) return buf
    const drop = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe
    if (!drop) parts.push(buf.subarray(i, i + 2 + len))
    i += 2 + len
  }
  return buf
}

module.exports = { parseExifDate, findTiff, parseTiff, exifFromBuffer, videoCreatedAt, dateFromName, readMediaInfo, stripJpegMetadata }
