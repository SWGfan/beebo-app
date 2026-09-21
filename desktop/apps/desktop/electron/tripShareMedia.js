'use strict'
// Trip sharing: what a file really is, and taking location out of it.
//
// A trip link serves photos, clips and (only when the sender adds one) a song from the sender's own
// PC. Two rules live here so they can be tested without a server:
//
//  1. The type comes from the file's own first bytes, never from the name or from what the phone
//     claims. Only JPEG and PNG photos, MP4 video and a handful of audio formats are accepted.
//  2. Location never leaves unless the sender ticked "include location" for that link. JPEG and PNG
//     have every metadata segment dropped when a link without location serves them (and the phone
//     already redraws photos from pixels, so its files carry none). MP4 location atoms are blanked in
//     place on arrival, always: a clip's position is never shown on a page.
//
// Everything is defensive: hostile or truncated bytes make a function return null or throw
// 'unsupported_location_metadata', never leak the position by "failing open".
const fs = require('node:fs/promises')
const { stripJpegMetadata } = require('./photoExif')

const MP4_VIDEO_BRANDS = new Set(['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'MSNV', 'dash', '3gp4', '3gp5', '3gp6', '3gp7', '3g2a'])
const MAX_MOOV_BYTES = 64 * 1024 * 1024

/**
 * What [buf] (the first bytes of a file, at least 12) is: { kind: 'photo'|'video'|'audio', mime, ext }
 * or null. Kind decides where the file may be used; mime is what the page serves it as.
 */
function sniff(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { kind: 'photo', mime: 'image/jpeg', ext: 'jpg' }
  if (buf.toString('latin1', 0, 8) === '\x89PNG\r\n\x1a\n') return { kind: 'photo', mime: 'image/png', ext: 'png' }
  if (buf.toString('latin1', 4, 8) === 'ftyp') {
    const brand = buf.toString('latin1', 8, 12)
    if (brand === 'M4A ' || brand === 'M4B ') return { kind: 'audio', mime: 'audio/mp4', ext: 'm4a' }
    if (MP4_VIDEO_BRANDS.has(brand)) return { kind: 'video', mime: 'video/mp4', ext: 'mp4' }
    return null
  }
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WAVE') return { kind: 'audio', mime: 'audio/wav', ext: 'wav' }
  if (buf.toString('latin1', 0, 4) === 'OggS') return { kind: 'audio', mime: 'audio/ogg', ext: 'ogg' }
  if (buf.toString('latin1', 0, 4) === 'fLaC') return { kind: 'audio', mime: 'audio/flac', ext: 'flac' }
  if (buf.toString('latin1', 0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return { kind: 'audio', mime: 'audio/mpeg', ext: 'mp3' }
  return null
}

/** Whether [buf] still carries something that looks like an Exif or XMP block. */
function looksLikeMetadata(buf) {
  return buf.includes('Exif\0\0', 0, 'latin1') || buf.includes('http://ns.adobe.com/xap', 0, 'latin1')
}

/**
 * The JPEG with every APP1..APP15 and comment segment removed (Exif, XMP, GPS, maker notes).
 * Returns null when the file is malformed in a way that leaves metadata behind, so a caller serves
 * nothing rather than a picture that might still carry a position.
 */
function cleanJpeg(buf) {
  const out = stripJpegMetadata(buf)
  if (!Buffer.isBuffer(out) || out.length < 4 || out[0] !== 0xff || out[1] !== 0xd8) return null
  return looksLikeMetadata(out) ? null : out
}

const PNG_SIG = Buffer.from('\x89PNG\r\n\x1a\n', 'latin1')
// Chunks that can carry a position or free text. IDAT, palette, transparency and gamma are kept.
const PNG_DROP = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME'])

/** The PNG without eXIf and text chunks, or null when the chunk structure is broken. */
function cleanPng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 20 || !buf.subarray(0, 8).equals(PNG_SIG)) return null
  const parts = [buf.subarray(0, 8)]
  let i = 8
  let sawEnd = false
  while (i + 12 <= buf.length) {
    const len = buf.readUInt32BE(i)
    const type = buf.toString('latin1', i + 4, i + 8)
    const total = 12 + len
    if (len > 0x7fffffff || i + total > buf.length) return null
    if (!PNG_DROP.has(type)) parts.push(buf.subarray(i, i + total))
    i += total
    if (type === 'IEND') { sawEnd = true; break }
  }
  if (!sawEnd) return null
  const out = Buffer.concat(parts)
  return looksLikeMetadata(out) ? null : out
}

/** A photo as a viewer without location permission may see it, or null (serve nothing). */
function cleanPhoto(buf, mime) {
  if (mime === 'image/jpeg') return cleanJpeg(buf)
  if (mime === 'image/png') return cleanPng(buf)
  return null
}

/* ------------------------------ MP4 location atoms ------------------------------ */

// "©xyz" is the Android / QuickTime GPS atom, "loci" the 3GPP location atom.
const LOCATION_ATOMS = new Set(['©xyz', 'loci'])
const CONTAINERS = new Set(['moov', 'udta', 'trak', 'mdia', 'minf', 'stbl'])

function readBox(buf, at, end) {
  if (at + 8 > end) return null
  let size = buf.readUInt32BE(at)
  const type = buf.toString('latin1', at + 4, at + 8)
  let header = 8
  if (size === 1) {
    if (at + 16 > end) return null
    const big = buf.readBigUInt64BE(at + 8)
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null
    size = Number(big)
    header = 16
  } else if (size === 0) size = end - at
  if (size < header || at + size > end) return null
  return { type, size, header }
}

/**
 * Blank every location atom inside a moov box held in [buf] (same size, renamed "free"), and refuse
 * the clip if it carries iPhone-style keyed location metadata that cannot be safely blanked here.
 * Returns how many atoms were blanked.
 */
function blankLocationAtoms(buf, start, end, depth = 0) {
  let found = 0
  let at = start
  while (at + 8 <= end) {
    const box = readBox(buf, at, end)
    if (!box) break
    if (LOCATION_ATOMS.has(box.type)) {
      buf.write('free', at + 4, 'latin1')
      buf.fill(0, at + box.header, at + box.size)
      found++
    } else if (box.type === 'meta' || box.type === 'keys' || box.type === 'ilst') {
      const body = buf.subarray(at + box.header, at + box.size)
      if (body.includes('location.ISO6709', 0, 'latin1') || body.includes('©xyz', 0, 'latin1')) {
        throw Object.assign(new Error('unsupported_location_metadata'), { status: 415, code: 'unsupported_location_metadata' })
      }
    } else if (CONTAINERS.has(box.type) && depth < 6) {
      found += blankLocationAtoms(buf, at + box.header, at + box.size, depth + 1)
    }
    at += box.size
  }
  return found
}

/**
 * Take the position out of a finished MP4 on disk, rewriting only the bytes of the movie box
 * (no re-mux, same length). Returns how many location atoms were blanked. Throws
 * 'unsupported_location_metadata' for clips whose location cannot be removed this way.
 */
async function stripMp4Location(file) {
  const fh = await fs.open(file, 'r+')
  try {
    const { size: fileSize } = await fh.stat()
    let at = 0
    let blanked = 0
    while (at + 8 <= fileSize) {
      const head = Buffer.alloc(16)
      const { bytesRead } = await fh.read(head, 0, 16, at)
      if (bytesRead < 8) break
      let size = head.readUInt32BE(0)
      const type = head.toString('latin1', 4, 8)
      let header = 8
      if (size === 1) {
        if (bytesRead < 16) break
        const big = head.readBigUInt64BE(8)
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) break
        size = Number(big)
        header = 16
      } else if (size === 0) size = fileSize - at
      if (size < header || at + size > fileSize) break
      if (type === 'moov') {
        if (size > MAX_MOOV_BYTES) throw Object.assign(new Error('video_too_complex'), { status: 415, code: 'video_too_complex' })
        const moov = Buffer.alloc(size)
        await fh.read(moov, 0, size, at)
        const n = blankLocationAtoms(moov, header, size)
        if (n > 0) { await fh.write(moov, 0, size, at); blanked += n }
      }
      at += size
    }
    return blanked
  } finally {
    await fh.close()
  }
}

module.exports = { sniff, cleanJpeg, cleanPng, cleanPhoto, stripMp4Location, blankLocationAtoms, looksLikeMetadata }
