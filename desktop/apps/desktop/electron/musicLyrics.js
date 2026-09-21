// Song lyrics for the Music library: a sidecar .lrc file next to the song
// (synced, one timestamp per line), or lyrics embedded in the file's own tags
// (ID3 USLT / SYLT, Vorbis LYRICS, MP4 ©lyr). Nothing is fetched online.
//
// Pure functions only, so test/music.test.js can check them without a server.

const fs = require('fs')
const path = require('path')

const MAX_LYRICS_BYTES = 256 * 1024

// [mm:ss], [mm:ss.xx], [mm:ss.xxx], [mm:ss:xx] and [h:mm:ss.xx]
const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?::(\d{1,2}))?(?:[.:](\d{1,3}))?\]/g
const META_TAG = /^\[([a-z#]+):(.*)\]\s*$/i

function tagToMs(m) {
  let h = 0
  let mi = parseInt(m[1], 10)
  let s = parseInt(m[2], 10)
  let digits = m[4]
  if (m[3] !== undefined) {
    if (digits !== undefined) {
      // [h:mm:ss.xx]
      h = mi
      mi = s
      s = parseInt(m[3], 10)
    } else {
      // [mm:ss:xx] — the last pair is hundredths, as some writers produce.
      digits = m[3]
    }
  }
  let frac = 0
  if (digits !== undefined) {
    frac = digits.length === 1 ? parseInt(digits, 10) * 100 : digits.length === 2 ? parseInt(digits, 10) * 10 : parseInt(digits.slice(0, 3), 10)
  }
  return ((h * 60 + mi) * 60 + s) * 1000 + frac
}

// Parses LRC text. Lines without a timestamp are ignored when any line has
// one; a file with no timestamps at all is returned as plain unsynced text.
// Enhanced-LRC word stamps (<mm:ss.xx>) are stripped. [offset:+/-ms] is
// applied (positive offset = lyrics shown earlier, per the LRC convention).
function parseLrc(raw) {
  const text = String(raw == null ? '' : raw).replace(/^﻿/, '')
  const meta = {}
  const lines = []
  const plain = []
  let offsetMs = 0
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim()
    if (!line) { plain.push(''); continue }
    TIME_TAG.lastIndex = 0
    const stamps = []
    let m
    let lastEnd = 0
    // Timestamps are only recognised at the start of the line (possibly several in a row).
    while ((m = TIME_TAG.exec(line)) && m.index === lastEnd) {
      stamps.push(tagToMs(m))
      lastEnd = TIME_TAG.lastIndex
    }
    if (stamps.length) {
      const lyric = line.slice(lastEnd).replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '').replace(/\s+/g, ' ').trim()
      for (const t of stamps) lines.push({ timeMs: t, text: lyric })
      continue
    }
    const mm = META_TAG.exec(line)
    if (mm) {
      const key = mm[1].toLowerCase()
      const value = mm[2].trim()
      meta[key] = value
      if (key === 'offset' && /^[+-]?\d+$/.test(value)) offsetMs = parseInt(value, 10)
      continue
    }
    plain.push(line)
  }
  if (!lines.length) {
    const body = plain.join('\n').replace(/^\n+|\n+$/g, '')
    return { synced: false, lines: [], text: body, meta, offsetMs: 0 }
  }
  for (const l of lines) l.timeMs = Math.max(0, l.timeMs - offsetMs)
  // Stable sort by time: several stamps on one line land in their right places.
  lines.sort((a, b) => a.timeMs - b.timeMs)
  return { synced: true, lines, text: lines.map((l) => l.text).join('\n'), meta, offsetMs }
}

// The index of the line being sung at positionMs, or -1 before the first.
function activeLineIndex(lines, positionMs) {
  let lo = 0
  let hi = (lines || []).length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lines[mid].timeMs <= positionMs) { ans = mid; lo = mid + 1 } else hi = mid - 1
  }
  return ans
}

// Sidecar candidates for an audio file: "Song.lrc" beside "Song.flac"
// (case-insensitive on the extension). Returns the path or null.
function sidecarLrcPath(audioPath) {
  const dir = path.dirname(audioPath)
  const base = path.basename(audioPath, path.extname(audioPath))
  for (const ext of ['.lrc', '.LRC', '.Lrc']) {
    const p = path.join(dir, base + ext)
    try {
      const st = fs.statSync(p, { throwIfNoEntry: false })
      if (st && st.isFile()) return p
    } catch {}
  }
  return null
}

function decodeText(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.slice(2).toString('utf16le')
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.slice(2))
    swapped.swap16()
    return swapped.toString('utf16le')
  }
  const utf8 = buf.toString('utf8')
  // Not valid UTF-8 (replacement characters): assume Windows-1252 / Latin-1.
  if (utf8.includes('�')) return buf.toString('latin1')
  return utf8
}

function readSidecarLrc(audioPath) {
  const p = sidecarLrcPath(audioPath)
  if (!p) return null
  try {
    const st = fs.statSync(p)
    if (st.size > MAX_LYRICS_BYTES) return null
    return decodeText(fs.readFileSync(p))
  } catch {
    return null
  }
}

// Embedded lyrics as music-metadata reports them: v11 gives ILyricsTag objects
// ({ text, syncText: [{ text, timestamp }] }), older versions plain strings.
// Returns LRC-ish text (synced when SYLT timestamps exist) or ''.
function embeddedLyricsText(lyrics) {
  if (!lyrics) return ''
  const list = Array.isArray(lyrics) ? lyrics : [lyrics]
  for (const l of list) {
    if (!l) continue
    if (typeof l === 'string') { if (l.trim()) return l; continue }
    if (Array.isArray(l.syncText) && l.syncText.length && l.syncText.some((s) => typeof s.timestamp === 'number')) {
      return l.syncText
        .filter((s) => s && typeof s.timestamp === 'number')
        .map((s) => `[${formatStamp(s.timestamp)}]${String(s.text || '').trim()}`)
        .join('\n')
    }
    if (typeof l.text === 'string' && l.text.trim()) return l.text
  }
  return ''
}

function formatStamp(ms) {
  const total = Math.max(0, Math.round(ms))
  const m = Math.floor(total / 60000)
  const s = Math.floor((total % 60000) / 1000)
  const cs = Math.floor((total % 1000) / 10)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

module.exports = {
  parseLrc,
  activeLineIndex,
  sidecarLrcPath,
  readSidecarLrc,
  embeddedLyricsText,
  formatStamp,
  decodeText,
  MAX_LYRICS_BYTES
}
