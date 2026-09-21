'use strict'
// A small RFC 4180 CSV reader for exports from other products (Letterboxd, Tautulli ...).
// Handles a UTF-8 byte-order mark, CRLF or LF, quoted fields with commas, doubled quotes and line
// breaks inside quotes. The input is untrusted: size, row count and field length are all capped, and
// a file that hits a cap is cut there (with `truncated: true`) rather than read without limit.

const MAX_CHARS = 32 * 1024 * 1024
const MAX_ROWS = 400000
const MAX_FIELD = 20000

/**
 * @returns {{ rows: string[][], truncated: boolean }}
 */
function parseCsv(input, { maxRows = MAX_ROWS, maxChars = MAX_CHARS } = {}) {
  let text = typeof input === 'string' ? input : Buffer.isBuffer(input) ? input.toString('utf8') : ''
  let truncated = false
  if (text.length > maxChars) { text = text.slice(0, maxChars); truncated = true }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  let sawAny = false
  const endField = () => {
    row.push(field.length > MAX_FIELD ? field.slice(0, MAX_FIELD) : field)
    field = ''
  }
  const endRow = () => {
    endField()
    // A completely empty line is a separator, not a one-cell row.
    if (!(row.length === 1 && row[0] === '')) rows.push(row)
    row = []
    sawAny = false
  }
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (inQuotes) {
      if (c === 34) {
        if (text.charCodeAt(i + 1) === 34) { field += '"'; i++ } else inQuotes = false
      } else {
        // Cap while reading so a quote that never closes cannot build one giant string.
        if (field.length <= MAX_FIELD) field += text[i]
      }
      continue
    }
    if (c === 34 && field === '' ) { inQuotes = true; sawAny = true; continue }
    if (c === 44) { endField(); sawAny = true; continue }
    if (c === 13) { if (text.charCodeAt(i + 1) === 10) i++; endRow(); if (rows.length >= maxRows) { truncated = true; break } continue }
    if (c === 10) { endRow(); if (rows.length >= maxRows) { truncated = true; break } continue }
    if (field.length <= MAX_FIELD) field += text[i]
    sawAny = true
  }
  if (rows.length < maxRows && (sawAny || field !== '' || row.length)) endRow()
  return { rows, truncated }
}

const normHeader = (h) => String(h || '').trim().toLowerCase().replace(/[\s_-]+/g, ' ')

/**
 * The first row is the header. Rows come back as objects keyed by the lower-cased header text
 * (runs of space, "_" and "-" folded to one space), so "Watched Date" and "watched_date" agree.
 */
function parseCsvObjects(input, opts) {
  const { rows, truncated } = parseCsv(input, opts)
  if (!rows.length) return { headers: [], records: [], truncated }
  const headers = rows[0].map(normHeader)
  const records = []
  for (let r = 1; r < rows.length; r++) {
    const rec = {}
    for (let c = 0; c < headers.length; c++) {
      if (headers[c] && rows[r][c] !== undefined && !(headers[c] in rec)) rec[headers[c]] = rows[r][c].trim()
    }
    records.push(rec)
  }
  return { headers, records, truncated }
}

module.exports = { parseCsv, parseCsvObjects, normHeader, MAX_CHARS, MAX_ROWS }
