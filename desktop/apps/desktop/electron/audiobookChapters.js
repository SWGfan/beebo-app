'use strict'
// Chapters for audiobooks, from every place a book can keep them.
//
//   - MP4 / M4B "chpl" atom (the Nero chapter list that ffmpeg, mp4v2 and most audiobook
//     tools write): readMp4Chapters() reads it straight from the file, no ffmpeg needed.
//   - MP4 chapter TRACKS (QuickTime text track) and ID3v2 CHAP frames: what music-metadata
//     reports (fromMusicMetadata()).
//   - ffprobe -show_chapters (fromFfprobe()): the catch-all when neither of the above works.
//   - A .cue sheet beside the book (parseCue() / chaptersFromCue()), single file or one FILE
//     line per part.
//   - Folder books with no chapters of their own: one chapter per file (chaptersFromParts()).
//
// Everything is normalised the same way (normalizeChapters): seconds as numbers, sorted,
// clamped to the book, an end time on every chapter, a title on every chapter, a hard cap
// on how many. Nothing here touches the network.

const fsp = require('fs/promises')
const { decodeText } = require('./musicLyrics')

const MAX_CHAPTERS = 5000
const MAX_MOOV_BYTES = 64 * 1024 * 1024
const MAX_TITLE = 200
const MAX_CUE_BYTES = 2 * 1024 * 1024

const num = (v) => (typeof v === 'number' ? v : Number(v))

function cleanTitle(v) {
  if (v == null) return ''
  return String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE)
}

/**
 * Sorted, deduplicated, clamped chapters with an `end` on each: [{ title, start, end }] in seconds.
 * `duration` (seconds, optional) bounds the last chapter and drops chapters that start after the end.
 * A chapter with no title becomes "Chapter N".
 */
function normalizeChapters(list, duration) {
  const total = Number.isFinite(duration) && duration > 0 ? duration : null
  const rows = []
  for (const c of Array.isArray(list) ? list : []) {
    if (!c) continue
    const start = num(c.start)
    if (!Number.isFinite(start) || start < 0) continue
    if (total !== null && start >= total - 0.05) continue
    rows.push({ title: cleanTitle(c.title), start: Math.round(start * 1000) / 1000 })
  }
  rows.sort((a, b) => a.start - b.start)
  const out = []
  for (const r of rows) {
    const prev = out[out.length - 1]
    // Two chapters that start within a quarter second are one chapter (a marker written twice).
    if (prev && r.start - prev.start < 0.25) continue
    out.push(r)
    if (out.length >= MAX_CHAPTERS) break
  }
  for (let i = 0; i < out.length; i++) {
    const nextStart = i + 1 < out.length ? out[i + 1].start : total
    out[i].end = Math.round((nextStart !== null && nextStart > out[i].start ? nextStart : out[i].start) * 1000) / 1000
    if (!out[i].title) out[i].title = `Chapter ${i + 1}`
  }
  // The last chapter of a book whose length is unknown has no end; keep it equal to its start.
  return out
}

// ---- MP4 "chpl" -------------------------------------------------------------------------

/**
 * Chapters from the bytes of a "chpl" box PAYLOAD (everything after the 8-byte box header).
 * version(1) flags(3) [reserved(4) when version is 1] count(1)
 * then per chapter: start (uint64, 100-nanosecond units), title length (1), title (UTF-8).
 */
function parseChplPayload(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 5) return []
  const version = buf[0]
  let off = 4
  if (version === 1) off += 4
  if (off >= buf.length) return []
  const count = buf[off]
  off += 1
  const out = []
  for (let i = 0; i < count; i++) {
    if (off + 9 > buf.length) break
    const ticks = Number(buf.readBigUInt64BE(off))
    off += 8
    const len = buf[off]
    off += 1
    if (off + len > buf.length) break
    out.push({ start: ticks / 1e7, title: buf.toString('utf8', off, off + len) })
    off += len
  }
  return out
}

// Finds the first box of `type` among the boxes packed in buf[from, to). Returns { start, end } of its
// PAYLOAD, or null. Sizes: 32-bit; 1 means a 64-bit size follows; 0 means "to the end".
function findBox(buf, type, from = 0, to = buf.length) {
  let off = from
  while (off + 8 <= to) {
    let size = buf.readUInt32BE(off)
    const kind = buf.toString('latin1', off + 4, off + 8)
    let header = 8
    if (size === 1) {
      if (off + 16 > to) return null
      size = Number(buf.readBigUInt64BE(off + 8))
      header = 16
    } else if (size === 0) {
      size = to - off
    }
    if (size < header || off + size > to) return null
    if (kind === type) return { start: off + header, end: off + size }
    off += size
  }
  return null
}

/** Chapters from a whole moov payload: moov > udta > chpl. */
function chaptersFromMoov(moov) {
  const udta = findBox(moov, 'udta')
  if (!udta) return []
  const chpl = findBox(moov, 'chpl', udta.start, udta.end)
  if (!chpl) return []
  return parseChplPayload(moov.subarray(chpl.start, chpl.end))
}

/**
 * Reads the chpl chapter list out of an .m4b/.m4a/.mp4 file: walks the top-level boxes with small
 * reads (a book's moov can sit after gigabytes of audio) and loads only the moov box.
 * Returns [{ title, start }] in seconds, or [] when there is no chpl atom or the file is not MP4.
 */
async function readMp4Chapters(file) {
  let fh
  try {
    fh = await fsp.open(file, 'r')
    const { size } = await fh.stat()
    const head = Buffer.alloc(16)
    let off = 0
    let hops = 0
    while (off + 8 <= size && hops++ < 64) {
      const { bytesRead } = await fh.read(head, 0, 16, off)
      if (bytesRead < 8) break
      let boxSize = head.readUInt32BE(0)
      const kind = head.toString('latin1', 4, 8)
      let header = 8
      if (boxSize === 1) {
        if (bytesRead < 16) break
        boxSize = Number(head.readBigUInt64BE(8))
        header = 16
      } else if (boxSize === 0) {
        boxSize = size - off
      }
      if (boxSize < header || off + boxSize > size) break
      if (kind === 'moov') {
        const len = boxSize - header
        if (len > MAX_MOOV_BYTES) return []
        const body = Buffer.alloc(len)
        const r = await fh.read(body, 0, len, off + header)
        if (r.bytesRead < len) return []
        return chaptersFromMoov(body)
      }
      off += boxSize
    }
    return []
  } catch {
    return []
  } finally {
    if (fh) { try { await fh.close() } catch {} }
  }
}

// ---- music-metadata / ffprobe -------------------------------------------------------------

/**
 * music-metadata's view of a file: format.chapters (MP4 chapter tracks; start/timeScale seconds) and
 * ID3v2 CHAP frames (start in milliseconds) under meta.native. Returns [{ title, start }] or [].
 */
function fromMusicMetadata(meta) {
  const out = []
  const fmt = (meta && meta.format && meta.format.chapters) || []
  for (const c of fmt) {
    if (!c) continue
    const scale = num(c.timeScale) > 0 ? num(c.timeScale) : 1000
    const start = num(c.start) / scale
    if (Number.isFinite(start)) out.push({ title: c.title, start })
  }
  if (out.length) return out
  for (const [key, list] of Object.entries((meta && meta.native) || {})) {
    if (!/^ID3v2/i.test(key) || !Array.isArray(list)) continue
    for (const t of list) {
      if (!t || t.id !== 'CHAP' || !t.value || !t.value.info) continue
      const ms = num(t.value.info.startTime)
      if (!Number.isFinite(ms)) continue
      let title = t.value.label
      const frames = t.value.frames
      const tit2 = frames && typeof frames.get === 'function' ? frames.get('TIT2') : null
      if (typeof tit2 === 'string' && tit2.trim()) title = tit2
      else if (tit2 && typeof tit2 === 'object' && tit2.text) title = tit2.text
      out.push({ title, start: ms / 1000 })
    }
  }
  return out
}

/** ffprobe -print_format json -show_chapters output (already parsed) -> [{ title, start }]. */
function fromFfprobe(info) {
  const out = []
  for (const c of (info && info.chapters) || []) {
    if (!c) continue
    let start = num(c.start_time)
    if (!Number.isFinite(start)) {
      const [n, d] = String(c.time_base || '').split('/').map(Number)
      start = d > 0 ? num(c.start) * (n / d) : NaN
    }
    if (!Number.isFinite(start)) continue
    const tags = c.tags || {}
    const title = tags.title || tags.TITLE || tags.Title || ''
    out.push({ title, start })
  }
  return out
}

// ---- CUE sheets ---------------------------------------------------------------------------

function unquote(s) {
  const t = String(s).trim()
  const m = /^"(.*)"/.exec(t)
  return m ? m[1] : t.split(/\s+/)[0] || ''
}

/**
 * A .cue sheet's text -> { title, performer, tracks: [{ file, number, title, performer, start }] }.
 * `start` is INDEX 01 in seconds (frames are 1/75 s) within that track's FILE; a track with no INDEX 01
 * is skipped. Unknown commands are ignored.
 */
function parseCue(text) {
  const out = { title: '', performer: '', tracks: [] }
  let file = ''
  let track = null
  const flush = () => {
    if (track && Number.isFinite(track.start)) out.tracks.push(track)
    track = null
  }
  for (const raw of String(text || '').replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const m = /^(\w+)\s*(.*)$/.exec(line)
    if (!m) continue
    const cmd = m[1].toUpperCase()
    const rest = m[2]
    if (cmd === 'FILE') { flush(); file = unquote(rest) }
    else if (cmd === 'TRACK') { flush(); const n = /^(\d+)/.exec(rest); track = { file, number: n ? Number(n[1]) : out.tracks.length + 1, title: '', performer: '', start: NaN } }
    else if (cmd === 'TITLE') { if (track) track.title = unquote(rest); else out.title = unquote(rest) }
    else if (cmd === 'PERFORMER') { if (track) track.performer = unquote(rest); else out.performer = unquote(rest) }
    else if (cmd === 'INDEX') {
      const t = /^(\d+)\s+(\d+):(\d{1,2}):(\d{1,2})/.exec(rest)
      if (t && track && Number(t[1]) === 1) track.start = Number(t[2]) * 60 + Number(t[3]) + Number(t[4]) / 75
    }
  }
  flush()
  return out
}

/** Reads and parses a cue file (UTF-8, UTF-16 with BOM, or Latin-1). Null when unreadable or too big. */
async function readCueFile(file) {
  try {
    const st = await fsp.stat(file)
    if (!st.isFile() || st.size > MAX_CUE_BYTES) return null
    return parseCue(decodeText(await fsp.readFile(file)))
  } catch {
    return null
  }
}

const baseName = (p) => String(p || '').split(/[\\/]/).pop().toLowerCase()

/**
 * Chapters (book seconds) from a parsed cue and the book's parts [{ path, start, duration }] where `start`
 * is where the part begins in the whole book. A cue with one FILE line and a one-part book applies to that
 * part whatever the FILE is called (people rename files); a cue that names several files needs them to match
 * the parts' file names, and tracks pointing at unknown files are skipped.
 */
function chaptersFromCue(cue, parts) {
  if (!cue || !Array.isArray(cue.tracks) || !cue.tracks.length || !Array.isArray(parts) || !parts.length) return []
  const files = new Set(cue.tracks.map((t) => baseName(t.file)))
  const out = []
  for (const t of cue.tracks) {
    let part = null
    if (parts.length === 1 && files.size <= 1) part = parts[0]
    else part = parts.find((p) => baseName(p.path) === baseName(t.file)) || null
    if (!part) continue
    out.push({ title: t.title, start: part.start + t.start })
  }
  return out
}

/** One chapter per part, for folder books whose files carry no chapters of their own. */
function chaptersFromParts(parts) {
  return (parts || []).map((p, i) => ({ title: p.title || `Part ${i + 1}`, start: p.start }))
}

module.exports = {
  MAX_CHAPTERS,
  normalizeChapters,
  parseChplPayload,
  findBox,
  chaptersFromMoov,
  readMp4Chapters,
  fromMusicMetadata,
  fromFfprobe,
  parseCue,
  readCueFile,
  chaptersFromCue,
  chaptersFromParts,
  cleanTitle
}
