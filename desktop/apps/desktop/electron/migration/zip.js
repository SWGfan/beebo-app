'use strict'
// Reads a ZIP (a Letterboxd export is one) entirely in memory, from an untrusted source.
//
//   - Nothing is ever written to disk, so a hostile entry name ("../../x", "C:\x", a name with a
//     NUL) cannot reach the file system (no zip-slip). Such entries are reported and skipped, and
//     the caller only ever asks for entries by their normalised, safe name.
//   - Limits on the entry count, each entry's size, the total size and the compression ratio stop a
//     zip bomb. Declared sizes are checked before inflating AND the inflated size is capped again,
//     because the header can lie.
//   - Encrypted entries, ZIP64 and unknown compression methods are skipped with a reason.
//   - Only entries `wanted(name)` accepts are inflated at all.

const zlib = require('zlib')

const MAX_ENTRIES = 2000
const MAX_ENTRY_BYTES = 32 * 1024 * 1024
const MAX_TOTAL_BYTES = 96 * 1024 * 1024
const MAX_RATIO = 200 // uncompressed / compressed, for entries over 1 MB

let crcTable = null
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c
    }
  }
  let c = -1
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

/** A safe forward-slash relative name, or null when the entry name could escape a folder. */
function safeEntryName(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > 400 || raw.includes('\0')) return null
  const n = raw.replace(/\\/g, '/')
  if (n.startsWith('/') || /^[A-Za-z]:/.test(n)) return null
  const parts = n.split('/')
  for (const p of parts) if (p === '..') return null
  return parts.filter((p) => p && p !== '.').join('/') || null
}

class ZipError extends Error {
  constructor(code) { super(code); this.code = code }
}

function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 65535)
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i
  }
  return -1
}

/**
 * @param {Buffer} buf
 * @param {{ wanted?: (name: string) => boolean, maxEntries?, maxEntryBytes?, maxTotalBytes? }} opts
 * @returns {{ entries: {name: string, data: Buffer}[], skipped: {name: string, reason: string}[] }}
 */
function readZip(buf, opts = {}) {
  const wanted = opts.wanted || (() => true)
  const maxEntries = opts.maxEntries || MAX_ENTRIES
  const maxEntryBytes = opts.maxEntryBytes || MAX_ENTRY_BYTES
  const maxTotal = opts.maxTotalBytes || MAX_TOTAL_BYTES
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new ZipError('not_a_zip')
  const eocd = findEocd(buf)
  if (eocd < 0) throw new ZipError('not_a_zip')
  const total = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (total === 0xffff || cdOffset === 0xffffffff) throw new ZipError('zip64_unsupported')
  if (total > maxEntries) throw new ZipError('too_many_entries')
  if (cdOffset + cdSize > buf.length) throw new ZipError('corrupt')

  const entries = []
  const skipped = []
  let inflatedTotal = 0
  let p = cdOffset
  for (let e = 0; e < total; e++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new ZipError('corrupt')
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const csize = buf.readUInt32LE(p + 20)
    const usize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    if (p + 46 + nameLen > buf.length) throw new ZipError('corrupt')
    const rawName = buf.slice(p + 46, p + 46 + nameLen).toString(flags & 0x800 ? 'utf8' : 'latin1')
    p += 46 + nameLen + extraLen + commentLen
    if (rawName.endsWith('/')) continue // a folder
    const name = safeEntryName(rawName)
    if (!name) { skipped.push({ name: rawName.slice(0, 100).replace(/[^\x20-\x7e]/g, '?'), reason: 'unsafe_path' }); continue }
    if (!wanted(name)) continue
    if (flags & 1) { skipped.push({ name, reason: 'encrypted' }); continue }
    if (method !== 0 && method !== 8) { skipped.push({ name, reason: 'unsupported_method' }); continue }
    if (csize === 0xffffffff || usize === 0xffffffff || localOffset === 0xffffffff) { skipped.push({ name, reason: 'zip64_unsupported' }); continue }
    if (usize > maxEntryBytes) { skipped.push({ name, reason: 'too_big' }); continue }
    if (usize > 1024 * 1024 && csize > 0 && usize / csize > MAX_RATIO) { skipped.push({ name, reason: 'suspicious_ratio' }); continue }
    if (inflatedTotal + usize > maxTotal) { skipped.push({ name, reason: 'total_too_big' }); continue }
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) { skipped.push({ name, reason: 'corrupt' }); continue }
    const lNameLen = buf.readUInt16LE(localOffset + 26)
    const lExtraLen = buf.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + lNameLen + lExtraLen
    if (start + csize > buf.length) { skipped.push({ name, reason: 'corrupt' }); continue }
    const raw = buf.slice(start, start + csize)
    let data
    try {
      data = method === 0 ? raw : zlib.inflateRawSync(raw, { maxOutputLength: maxEntryBytes })
    } catch (err) {
      skipped.push({ name, reason: err && err.code === 'ERR_BUFFER_TOO_LARGE' ? 'too_big' : 'corrupt' })
      continue
    }
    if (data.length > maxEntryBytes) { skipped.push({ name, reason: 'too_big' }); continue }
    if (crc32(data) !== crc) { skipped.push({ name, reason: 'bad_crc' }); continue }
    inflatedTotal += data.length
    entries.push({ name, data })
  }
  return { entries, skipped }
}

/** True when the bytes start like a zip file ("PK\x03\x04", or an empty archive's "PK\x05\x06"). */
function looksLikeZip(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 3 || buf[2] === 5)
}

module.exports = { readZip, looksLikeZip, safeEntryName, crc32, ZipError, MAX_ENTRIES, MAX_ENTRY_BYTES, MAX_TOTAL_BYTES }
