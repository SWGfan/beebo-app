'use strict'
// Working out an audiobook's author, series and title from the things people actually have:
// tags first (handled by the caller), then the book's name and the folders it sits in.
// Pure functions, no file access; test/audiobook-library.test.js covers them.
//
// Folder conventions understood (relative to the Audiobooks folder):
//   Author/Title                      Author/Title.m4b
//   Author/Series/Title               Author/Series/01 - Title.m4b
//   Title                             Title.m4b
// A name that starts with a number and a separator ("03 - Title", "Book 3 - Title", "#3. Title")
// gives the book's place in its series.

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

const MARKER = '(?:#|no\\.?|book|bk\\.?|vol(?:ume)?\\.?)'

/**
 * "The Stormlight Archive #1" -> { name: 'The Stormlight Archive', index: 1 }
 * "Discworld, Book 5" -> { name: 'Discworld', index: 5 }; "Mistborn" -> { name: 'Mistborn', index: null }.
 * A bare trailing number without a marker is NOT an index ("Catch 22" is a title, not book 22).
 */
function parseSeriesString(s) {
  const text = String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
  if (!text) return null
  const m = new RegExp('^(.*?)[\\s,;:\\-\\u2013\\u2014]*' + MARKER + '\\s*(\\d+(?:\\.\\d+)?)\\s*$', 'i').exec(text)
  if (m && m[1].trim()) return { name: m[1].trim().replace(/[\s,;:\-]+$/, ''), index: num(m[2]) }
  return { name: text, index: null }
}

/**
 * A book title that carries its series: "The Way of Kings (The Stormlight Archive #1)" or
 * "Mistborn, Book 1: The Final Empire". Returns { title, series, index } or null.
 */
function seriesFromTitle(title) {
  const t = String(title == null ? '' : title).replace(/\s+/g, ' ').trim()
  let m = new RegExp('^(.+?)\\s*[\\(\\[]\\s*(.+?)[,\\s]*' + MARKER + '\\s*(\\d+(?:\\.\\d+)?)\\s*[\\)\\]]\\s*$', 'i').exec(t)
  if (m) return { title: m[1].trim(), series: m[2].trim().replace(/[\s,;:\-]+$/, ''), index: num(m[3]) }
  m = new RegExp('^(.+?)[,:\\s\\-]+' + MARKER + '\\s*(\\d+(?:\\.\\d+)?)\\s*[:\\-\\u2013\\u2014]\\s*(.+)$', 'i').exec(t)
  if (m) return { title: m[3].trim(), series: m[1].trim().replace(/[\s,;:\-]+$/, ''), index: num(m[2]) }
  return null
}

/** "03 - The Title" / "Book 3 - The Title" / "#3. The Title" -> { index: 3, rest: 'The Title' }, else null. */
function leadingIndex(name) {
  const m = new RegExp('^(?:' + MARKER + ')?\\s*0*(\\d{1,3}(?:\\.\\d+)?)\\s*[-._):\\u2013\\u2014]\\s*(.+)$', 'i').exec(String(name == null ? '' : name).trim())
  return m ? { index: num(m[1]), rest: m[2].trim() } : null
}

/** A file or folder name as a title: no extension, underscores as spaces, no leading track number. */
function cleanName(name, { stripIndex = true } = {}) {
  let s = String(name == null ? '' : name).replace(/\.[a-z0-9]{2,4}$/i, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim()
  if (stripIndex) {
    const lead = leadingIndex(s)
    if (lead) s = lead.rest
    else s = s.replace(/^(?:track|part|chapter|ch\.?|cd|disc)\s*\d{1,3}\s*[-._):]*\s*/i, '').replace(/^\d{1,3}\s*[-._)]+\s*/, '')
  }
  s = s.trim()
  // "Track 05" is all number: keep it rather than return nothing.
  return s || String(name == null ? '' : name).replace(/\.[a-z0-9]{2,4}$/i, '').replace(/_/g, ' ').trim()
}

const fold = (s) => String(s || '').normalize('NFD').replace(/\p{Mn}+/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

/**
 * Author / series / title / series index from the folders a book sits in.
 * `segs` are the folder names between the Audiobooks folder and the book (the book's own folder last
 * for a folder book; for a single file, the folders that contain the file). `stem` is the file name
 * without extension for a single-file book, or null for a folder book.
 */
function inferFromPath(segs, stem = null) {
  let dirs = (Array.isArray(segs) ? segs : []).map((s) => String(s)).filter(Boolean)
  let title = ''
  let index = null
  if (stem) {
    // Author/Title/Title.m4b: the folder carries the same name as the file, so it is the book's folder.
    const last = dirs[dirs.length - 1]
    if (last && (fold(last) === fold(stem) || fold(stem).startsWith(fold(last)) || fold(last).startsWith(fold(stem)))) dirs = dirs.slice(0, -1)
    const lead = leadingIndex(stem)
    index = lead ? lead.index : null
    title = cleanName(stem)
  } else {
    const last = dirs[dirs.length - 1] || ''
    const lead = leadingIndex(last)
    index = lead ? lead.index : null
    title = cleanName(last)
    dirs = dirs.slice(0, -1)
  }
  // dirs now holds only the folders above the book: [author] or [author, series] (or a deeper tree).
  let author = ''
  let series = ''
  if (dirs.length >= 2) { author = dirs[0]; series = dirs[dirs.length - 1] }
  else if (dirs.length === 1) author = dirs[0]
  const seriesLead = series ? leadingIndex(series) : null
  if (seriesLead) series = seriesLead.rest
  return { author: cleanName(author, { stripIndex: false }), series: cleanName(series, { stripIndex: false }), title, index }
}

/**
 * "Last, First" -> "First Last" for a single author (the way library tools write sort names).
 * Only a one-word family name before the comma is swapped, so two authors written in full
 * ("Neil Gaiman, Terry Pratchett"), "A & B" and anything with a second comma are left alone.
 */
function displayAuthor(name) {
  const s = String(name == null ? '' : name).replace(/\s+/g, ' ').trim()
  const m = /^([^,&]+),\s*([^,&]+)$/.exec(s)
  if (m && !/\band\b/i.test(s) && m[1].trim().split(' ').length === 1 && m[2].trim().split(' ').length <= 3 && !/^(jr|sr|ii|iii|iv|phd|md)\.?$/i.test(m[2].trim())) return `${m[2].trim()} ${m[1].trim()}`
  return s
}

module.exports = { parseSeriesString, seriesFromTitle, leadingIndex, cleanName, inferFromPath, displayAuthor, fold }
