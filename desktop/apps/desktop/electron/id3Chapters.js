'use strict'
// Chapters stored INSIDE an MP3 (ID3v2 CHAP frames, the "ID3v2 Chapter Frame Addendum"), for
// episodes whose feed has no podcast:chapters address. Reads only the tag at the start of the
// file, never more than MAX_TAG bytes of it, and never trusts a length it has not checked
// against the bytes it actually has.
//
//   readId3Chapters(pathOrBuffer) -> [{ start (seconds), end, title, url, img: '' }] sorted by start

const fsp = require('fs/promises')

const MAX_TAG = 4 * 1024 * 1024
const MAX_CHAPTERS = 500

const synchsafe = (b, o) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f)
const be32 = (b, o) => b.readUInt32BE(o)

// ID3 "unsynchronisation": every FF 00 in the stored bytes stands for a plain FF.
function unsync(buf) {
  const out = []
  for (let i = 0; i < buf.length; i++) {
    out.push(buf[i])
    if (buf[i] === 0xff && buf[i + 1] === 0x00) i++
  }
  return Buffer.from(out)
}

// Text frame payload after the encoding byte -> { text, next } (next = offset just past the terminator).
function readString(buf, offset, enc, untilEnd) {
  const wide = enc === 1 || enc === 2
  let end = offset
  if (untilEnd) end = buf.length
  else if (wide) { while (end + 1 < buf.length && !(buf[end] === 0 && buf[end + 1] === 0)) end += 2; if (end + 1 >= buf.length) end = buf.length }
  else { while (end < buf.length && buf[end] !== 0) end++ }
  const raw = buf.subarray(offset, end)
  let text
  if (enc === 0) text = raw.toString('latin1')
  else if (enc === 3) text = raw.toString('utf8')
  else if (enc === 2) text = Buffer.from(raw).swap16().toString('utf16le')
  else if (raw.length >= 2 && raw[0] === 0xfe && raw[1] === 0xff) text = Buffer.from(raw.subarray(2)).swap16().toString('utf16le')
  else text = raw.subarray(raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe ? 2 : 0).toString('utf16le')
  return { text: text.replace(/\0+$/g, ''), next: Math.min(buf.length, end + (wide ? 2 : 1)) }
}

function frames(body, major, cb) {
  let o = 0
  const hdr = major === 2 ? 6 : 10
  while (o + hdr <= body.length) {
    if (body[o] === 0) break // padding
    const id = body.toString('latin1', o, o + (major === 2 ? 3 : 4))
    const size = major === 4 ? synchsafe(body, o + 4) : major === 3 ? be32(body, o + 4) : (body[o + 3] << 16) | (body[o + 4] << 8) | body[o + 5]
    const flags = major === 2 ? 0 : body.readUInt16BE(o + 8)
    o += hdr
    if (size < 0 || o + size > body.length) break
    let data = body.subarray(o, o + size)
    // v2.4 per-frame flags: 0x0002 unsynchronised, 0x0001 has a data-length indicator (4 bytes to skip).
    if (major === 4) {
      if (flags & 0x0001) data = data.subarray(4)
      if (flags & 0x0002) data = unsync(data)
    }
    cb(id, data)
    o += size
  }
}

function subframeText(data) {
  if (!data.length) return ''
  return readString(data, 1, data[0], true).text.trim()
}

function parseChapFrame(data, major) {
  const id = readString(data, 0, 0, false)
  let o = id.next
  if (o + 16 > data.length) return null
  const startMs = be32(data, o)
  const endMs = be32(data, o + 4)
  o += 16
  const ch = { start: startMs / 1000, end: endMs > startMs && endMs !== 0xffffffff ? endMs / 1000 : null, title: '', url: '', img: '' }
  frames(data.subarray(o), major, (fid, fdata) => {
    if (fid === 'TIT2' || fid === 'TT2') ch.title = subframeText(fdata).slice(0, 200)
    else if ((fid === 'WXXX' || fid === 'WXX') && fdata.length > 2) {
      const desc = readString(fdata, 1, fdata[0], false)
      const url = fdata.toString('latin1', desc.next).replace(/\0+$/g, '').trim()
      if (/^https?:\/\//i.test(url) && url.length <= 2000) ch.url = url
    }
  })
  return ch
}

/** Chapters from an ID3v2 tag held in a Buffer (the first bytes of an MP3), [] when there are none. */
function parseId3Chapters(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 10 || buf.toString('latin1', 0, 3) !== 'ID3') return []
  const major = buf[3]
  if (major < 2 || major > 4) return []
  const flags = buf[5]
  if (buf.subarray(6, 10).some((x) => x & 0x80)) return []
  const size = synchsafe(buf, 6)
  let body = buf.subarray(10, Math.min(buf.length, 10 + size))
  if (major < 4 && flags & 0x80) body = unsync(body)
  if (flags & 0x40 && major >= 3 && body.length >= 4) {
    // Extended header: skip it (v2.4's size includes itself, v2.3's does not).
    const ext = major === 4 ? synchsafe(body, 0) : be32(body, 0) + 4
    if (ext > 0 && ext <= body.length) body = body.subarray(ext)
  }
  const out = []
  frames(body, major, (id, data) => {
    if ((id === 'CHAP' || id === 'CHP') && out.length < MAX_CHAPTERS) {
      try {
        const c = parseChapFrame(data, major)
        if (c) out.push(c)
      } catch { /* one bad chapter frame does not lose the others */ }
    }
  })
  return out.sort((a, b) => a.start - b.start)
}

async function readId3Chapters(file) {
  if (Buffer.isBuffer(file)) return parseId3Chapters(file)
  let fh
  try {
    fh = await fsp.open(file, 'r')
    const head = Buffer.alloc(10)
    const { bytesRead } = await fh.read(head, 0, 10, 0)
    if (bytesRead < 10 || head.toString('latin1', 0, 3) !== 'ID3') return []
    const size = Math.min(synchsafe(head, 6), MAX_TAG)
    const buf = Buffer.alloc(10 + size)
    head.copy(buf, 0)
    const r = await fh.read(buf, 10, size, 10)
    return parseId3Chapters(buf.subarray(0, 10 + r.bytesRead))
  } catch {
    return []
  } finally {
    if (fh) await fh.close().catch(() => {})
  }
}

module.exports = { parseId3Chapters, readId3Chapters }
