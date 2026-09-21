'use strict'
// ============================================================================
// chapterModel.js - the chapters a video file carries, made safe to hand to a player.
// ----------------------------------------------------------------------------
// ffprobe's `-show_chapters` gives one entry per chapter with a free-text title that came from
// whoever authored (or ripped) the file, so it is UNTRUSTED text: it can hold markup, control or
// bidi-override characters, or be megabytes long. Everything a client shows is cleaned here, and
// clients still escape it again when they put it in a page.
// Chapters are metadata only: they are never muxed into the HLS conversion (hlsTranscoder.js keeps
// `-map_chapters -1`), so segment names, cache keys and tickets are untouched.
// ============================================================================

const MAX_CHAPTERS = 500
const MAX_TITLE_CHARS = 120
// C0/C1 controls, line/paragraph separators, bidi embeddings/overrides/isolates, zero-width and BOM.
// Built from code points so the source file itself holds no invisible characters.
const cp = (hex) => String.fromCharCode(parseInt(hex, 16))
const UNSAFE_RANGES = ['2028-2029', '200b-200f', '202a-202e', '2060-2064', '2066-2069', 'feff']
const UNSAFE_CHARS = new RegExp('[\\x00-\\x1f\\x7f-\\x9f' + UNSAFE_RANGES.map((r) => r.split('-').map(cp).join('-')).join('') + ']', 'g')
const ELLIPSIS = cp('2026')

function cleanTitle(raw) {
  if (raw == null) return ''
  let s = String(raw).replace(UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim()
  const chars = Array.from(s)
  if (chars.length > MAX_TITLE_CHARS) s = chars.slice(0, MAX_TITLE_CHARS - 1).join('').trimEnd() + ELLIPSIS
  return s
}

const round3 = (n) => Math.round(n * 1000) / 1000

/**
 * ffprobe's `chapters` array -> [{ index, startSec, endSec, title }], sorted, clamped to the film's
 * length, with zero-length and duplicate chapters dropped. Fewer than two chapters is not a chapter
 * list worth showing, so it comes back empty.
 */
function fromProbe(rawChapters, durationSec) {
  if (!Array.isArray(rawChapters)) return []
  const duration = Number(durationSec) > 0 ? Number(durationSec) : Infinity
  const rows = []
  for (const c of rawChapters.slice(0, MAX_CHAPTERS * 2)) {
    if (!c || typeof c !== 'object') continue
    const start = Number(c.start_time)
    if (!Number.isFinite(start) || start < 0 || start >= duration) continue
    const end = Number(c.end_time)
    rows.push({ start, end: Number.isFinite(end) ? end : NaN, title: cleanTitle(c.tags && (c.tags.title || c.tags.TITLE)) })
  }
  rows.sort((a, b) => a.start - b.start)
  const kept = []
  for (const r of rows) {
    const prev = kept[kept.length - 1]
    if (prev && r.start - prev.start < 0.5) continue
    kept.push(r)
    if (kept.length >= MAX_CHAPTERS) break
  }
  if (kept.length < 2) return []
  return kept.map((r, i) => {
    const next = kept[i + 1]
    let end = Number.isFinite(r.end) && r.end > r.start ? r.end : next ? next.start : duration
    if (next && end > next.start) end = next.start
    if (end > duration) end = duration
    if (!Number.isFinite(end) || end <= r.start) end = next ? next.start : r.start
    return { index: i, startSec: round3(r.start), endSec: round3(end), title: r.title }
  })
}

module.exports = { fromProbe, cleanTitle, MAX_CHAPTERS, MAX_TITLE_CHARS, ELLIPSIS }
