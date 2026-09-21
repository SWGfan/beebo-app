'use strict'
// ============================================================================
// addons/archive.js - unpack a downloaded .zip / .tar.gz safely, with no external tool.
// ----------------------------------------------------------------------------
// Runs only on an archive whose SHA-256 already matched the manifest. Even so it is written
// as if the archive were hostile:
//   * Only entries whose BASE NAME matches the manifest's `extract` patterns are kept, and
//     they are written FLAT into the destination folder. The path inside the archive is never
//     used to build an output path, so "../../x" and absolute paths cannot escape (they are
//     rejected loudly anyway).
//   * Hard caps: entry count, per-file and total unpacked bytes (the manifest's unpackedMaxBytes).
//     Inflation is bounded (maxOutputLength) so a zip bomb stops early.
//   * zip: stored + deflate only, no encryption, no zip64; CRC-32 checked.
//   * tar.gz: regular files only. A symlink to another file in the same archive is copied as a
//     real file (Linux builds ship libfoo.so -> libfoo.so.1 -> libfoo.so.1.2.3); any other
//     link, device or directory entry is ignored.
//   * Files are created owner-only (0o700 for the executable, 0o600 for the rest).
// Returns [{ name, size, sha256 }] of what was written.
// ============================================================================

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const crypto = require('crypto')
const { AddonError } = require('./download')

const MAX_ENTRIES = 5000

let CRC_TABLE = null
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
      CRC_TABLE[n] = c >>> 0
    }
  }
  let c = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

/** '*' wildcard match on a base name, case-insensitive, whole-string. */
function matchesAny(name, patterns) {
  const n = String(name).toLowerCase()
  return patterns.some((p) => {
    const re = new RegExp('^' + String(p).toLowerCase().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
    return re.test(n)
  })
}

function badEntryName(name) {
  const n = String(name)
  return !n || n.includes('\0') || n.startsWith('/') || n.startsWith('\\') || /^[A-Za-z]:/.test(n) || n.split(/[\\/]+/).some((seg) => seg === '..')
}

function leaf(name) {
  const parts = String(name).split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] || ''
}

function safeLeaf(l) {
  return /^[A-Za-z0-9][A-Za-z0-9._+-]{0,120}$/.test(l)
}

function writeOut(destDir, name, data, executableName) {
  const target = path.join(destDir, name)
  const isExe = name === executableName
  fs.writeFileSync(target, data, { mode: isExe ? 0o700 : 0o600 })
  return { name, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') }
}

// -------------------------------------------------------------------- zip
function readZipEntries(buf) {
  const eocdSig = 0x06054b50
  let e = -1
  const from = Math.max(0, buf.length - 65557)
  for (let i = buf.length - 22; i >= from; i--) if (buf.readUInt32LE(i) === eocdSig) { e = i; break }
  if (e < 0) throw new AddonError('extract_failed', 'The download is not a valid zip file.')
  const count = buf.readUInt16LE(e + 10)
  const cdSize = buf.readUInt32LE(e + 12)
  const cdOff = buf.readUInt32LE(e + 16)
  if (count === 0xFFFF || cdSize === 0xFFFFFFFF || cdOff === 0xFFFFFFFF) throw new AddonError('extract_failed', 'Zip64 archives are not supported.')
  if (count > MAX_ENTRIES) throw new AddonError('extract_failed', 'The archive has too many files.')
  if (cdOff + cdSize > buf.length) throw new AddonError('extract_failed', 'The zip directory is damaged.')
  const entries = []
  let p = cdOff
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new AddonError('extract_failed', 'The zip directory is damaged.')
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const csize = buf.readUInt32LE(p + 20)
    const usize = buf.readUInt32LE(p + 24)
    const nlen = buf.readUInt16LE(p + 28)
    const elen = buf.readUInt16LE(p + 30)
    const clen = buf.readUInt16LE(p + 32)
    const lho = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nlen)
    entries.push({ name, flags, method, crc, csize, usize, lho })
    p += 46 + nlen + elen + clen
  }
  return entries
}

function extractZip(buf, { patterns, executable, destDir, unpackedMaxBytes }) {
  const written = []
  const seen = new Set()
  let total = 0
  for (const ent of readZipEntries(buf)) {
    if (badEntryName(ent.name)) throw new AddonError('extract_failed', 'The archive contains an unsafe path.')
    if (ent.name.endsWith('/')) continue
    const name = leaf(ent.name)
    if (!matchesAny(name, patterns) || !safeLeaf(name)) continue
    if (seen.has(name.toLowerCase())) continue
    if (ent.flags & 1) throw new AddonError('extract_failed', 'Encrypted archives are not supported.')
    if (ent.method !== 0 && ent.method !== 8) throw new AddonError('extract_failed', 'The archive uses an unsupported compression method.')
    if (ent.csize === 0xFFFFFFFF || ent.usize === 0xFFFFFFFF) throw new AddonError('extract_failed', 'Zip64 archives are not supported.')
    total += ent.usize
    if (total > unpackedMaxBytes) throw new AddonError('extract_failed', 'The archive would unpack to more than expected.')
    if (ent.lho + 30 > buf.length || buf.readUInt32LE(ent.lho) !== 0x04034b50) throw new AddonError('extract_failed', 'The zip entry is damaged.')
    const dataStart = ent.lho + 30 + buf.readUInt16LE(ent.lho + 26) + buf.readUInt16LE(ent.lho + 28)
    if (dataStart + ent.csize > buf.length) throw new AddonError('extract_failed', 'The zip entry is damaged.')
    const raw = buf.subarray(dataStart, dataStart + ent.csize)
    let data
    try {
      data = ent.method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, ent.usize) })
    } catch {
      throw new AddonError('extract_failed', 'A file in the archive could not be unpacked.')
    }
    if (data.length !== ent.usize || crc32(data) !== ent.crc) throw new AddonError('extract_failed', 'A file in the archive is damaged.')
    seen.add(name.toLowerCase())
    written.push(writeOut(destDir, name, data, executable))
  }
  return written
}

// ------------------------------------------------------------------- tar
function tarString(buf, start, len) {
  const slice = buf.subarray(start, start + len)
  const z = slice.indexOf(0)
  return slice.toString('utf8', 0, z < 0 ? slice.length : z)
}

function tarOctal(buf, start, len) {
  const s = tarString(buf, start, len).trim()
  if (!s) return 0
  if (!/^[0-7]+$/.test(s)) throw new AddonError('extract_failed', 'The tar header is damaged.')
  return parseInt(s, 8)
}

function readTarEntries(tar) {
  const entries = []
  let off = 0
  let longName = null
  let paxPath = null
  while (off + 512 <= tar.length) {
    if (tar.readUInt32LE(off) === 0 && tar.subarray(off, off + 512).every((b) => b === 0)) break
    const size = tarOctal(tar, off + 124, 12)
    const type = String.fromCharCode(tar[off + 156] || 48)
    let name = tarString(tar, off + 0, 100)
    const prefix = tarString(tar, off + 345, 155)
    if (prefix && tarString(tar, off + 257, 5) === 'ustar') name = prefix + '/' + name
    const link = tarString(tar, off + 157, 100)
    const dataStart = off + 512
    const dataEnd = dataStart + size
    if (dataEnd > tar.length) throw new AddonError('extract_failed', 'The tar file is truncated.')
    if (type === 'L') { longName = tarString(tar, dataStart, size); off = dataStart + Math.ceil(size / 512) * 512; continue }
    if (type === 'x') {
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(tar.toString('utf8', dataStart, dataEnd))
      paxPath = m ? m[1] : null
      off = dataStart + Math.ceil(size / 512) * 512
      continue
    }
    if (type === 'g') { off = dataStart + Math.ceil(size / 512) * 512; continue }
    if (longName) { name = longName; longName = null }
    if (paxPath) { name = paxPath; paxPath = null }
    entries.push({ name, type, link, data: type === '0' || type === '\0' || type === '7' ? tar.subarray(dataStart, dataEnd) : null })
    if (entries.length > MAX_ENTRIES) throw new AddonError('extract_failed', 'The archive has too many files.')
    off = dataStart + Math.ceil(size / 512) * 512
  }
  return entries
}

function extractTarGz(buf, { patterns, executable, destDir, unpackedMaxBytes }) {
  let tar
  try { tar = zlib.gunzipSync(buf, { maxOutputLength: unpackedMaxBytes * 2 + 1024 * 1024 }) } catch {
    throw new AddonError('extract_failed', 'The download is not a valid .tar.gz file.')
  }
  const entries = readTarEntries(tar)
  const files = new Map() // leaf name -> data
  const links = new Map() // leaf name -> leaf target
  for (const ent of entries) {
    if (badEntryName(ent.name)) throw new AddonError('extract_failed', 'The archive contains an unsafe path.')
    const name = leaf(ent.name)
    if (!name) continue
    if (ent.data) { if (!files.has(name)) files.set(name, ent.data) } else if (ent.type === '2') links.set(name, leaf(ent.link))
  }
  const resolve = (name) => {
    let cur = name
    for (let i = 0; i < 8; i++) {
      if (files.has(cur)) return files.get(cur)
      if (!links.has(cur)) return null
      cur = links.get(cur)
    }
    return null
  }
  const written = []
  let total = 0
  for (const name of new Set([...files.keys(), ...links.keys()])) {
    if (!matchesAny(name, patterns) || !safeLeaf(name)) continue
    const data = resolve(name)
    if (!data) continue
    total += data.length
    if (total > unpackedMaxBytes) throw new AddonError('extract_failed', 'The archive would unpack to more than expected.')
    written.push(writeOut(destDir, name, Buffer.from(data), executable))
  }
  return written
}

/**
 * extractArchive({ file, format, patterns, executable, destDir, unpackedMaxBytes })
 * Throws AddonError('extract_failed') on anything odd, including a missing executable.
 */
function extractArchive({ file, format, patterns, executable, destDir, unpackedMaxBytes }) {
  const st = fs.statSync(file)
  // Bounded read: the archive size was pinned and verified before we got here.
  if (st.size > 2 * 1024 * 1024 * 1024) throw new AddonError('extract_failed', 'The archive is too large to unpack safely.')
  const buf = fs.readFileSync(file)
  fs.mkdirSync(destDir, { recursive: true, mode: 0o700 })
  const opts = { patterns, executable, destDir, unpackedMaxBytes }
  const written = format === 'zip' ? extractZip(buf, opts) : format === 'tar.gz' ? extractTarGz(buf, opts) : null
  if (!written) throw new AddonError('extract_failed', 'Unknown archive format.')
  if (!written.some((w) => w.name === executable)) throw new AddonError('extract_failed', `The archive does not contain ${executable}.`)
  return written
}

module.exports = { extractArchive, crc32, matchesAny }
