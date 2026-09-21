'use strict'
// Letterboxd adapter: the account data export (a .zip, or its .csv files one by one).
//
//   watched.csv           Date,Name,Year,Letterboxd URI          -> watched
//   diary.csv             Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date
//                                                                -> watched (on Watched Date), rating
//   ratings.csv           Date,Name,Year,Letterboxd URI,Rating   -> rating (0.5-5 stars = 1-10 here)
//   watchlist.csv         Date,Name,Year,Letterboxd URI          -> watchlist
//   likes/films.csv       Date,Name,Year,Letterboxd URI          -> favourite (the heart)
//   lists/<name>.csv      list header, then Position,Name,Year,URL,Description -> a playlist
//
// Letterboxd carries no TMDB or IMDb ids in the export, so every item matches by title and year.
// Reviews, comments and follow lists are not read.

const path = require('path')
const { parseCsv, parseCsvObjects } = require('./csv')
const { readZip, looksLikeZip, safeEntryName } = require('./zip')
const M = require('./model')

const USER_KEY = 'letterboxd'

const bytesOf = (f) => (Buffer.isBuffer(f.data) ? f.data : typeof f.text === 'string' ? Buffer.from(f.text, 'utf8') : Buffer.alloc(0))

/** Which kind of export file this is, from its name (and its folder inside the zip). */
function classify(name) {
  const n = String(name || '').replace(/\\/g, '/').toLowerCase()
  const base = n.split('/').pop()
  if (!base.endsWith('.csv')) return null
  if (/(^|\/)lists\/[^/]+\.csv$/.test(n)) return 'list'
  if (/(^|\/)likes\/films\.csv$/.test(n)) return 'likes'
  if (base === 'watched.csv') return 'watched'
  if (base === 'ratings.csv') return 'ratings'
  if (base === 'watchlist.csv') return 'watchlist'
  if (base === 'diary.csv') return 'diary'
  // A lone file the person picked, named anything: treated as a list of films (Name, Year).
  return /^list|\blist\b/.test(base) ? 'list' : null
}

/** Expands zips and returns [{ name, kind, text }] for every export file worth reading. */
function collectFiles(files) {
  const out = []
  const warnings = []
  for (const f of files || []) {
    const name = String(f && f.name || '')
    const buf = bytesOf(f)
    if (looksLikeZip(buf) || /\.zip$/i.test(name)) {
      let zip
      try {
        zip = readZip(buf, { wanted: (n) => !!classify(n) })
      } catch (err) {
        warnings.push('"' + path.basename(name).slice(0, 80) + '" is not a readable zip file.')
        continue
      }
      for (const s of zip.skipped) warnings.push('Skipped "' + s.name.slice(0, 60) + '" in the zip (' + s.reason.replace(/_/g, ' ') + ').')
      for (const e of zip.entries) out.push({ name: e.name, kind: classify(e.name), text: e.data.toString('utf8') })
    } else {
      // A loose csv: use the name as given, but only its base name so a path in it means nothing.
      const safe = safeEntryName(name.replace(/\\/g, '/')) || path.basename(name)
      const text = buf.toString('utf8')
      // A csv with a name we do not know is still taken as a list of films if it has a Name column.
      const kind = classify(safe) || (/\.csv$/i.test(safe) && looksLikeFilmCsv(text) ? 'list' : null)
      if (kind) out.push({ name: safe, kind, text })
      else warnings.push('"' + path.basename(name).slice(0, 80) + '" was not recognised as a Letterboxd export file.')
    }
  }
  return { files: out, warnings }
}

function looksLikeFilmCsv(text) {
  const { rows } = parseCsv(text.slice(0, 4000), { maxRows: 30 })
  return rows.some((r) => r.some((c) => /^(name|title|film)$/i.test(c.trim())))
}

const titleOf = (rec) => M.str(rec.name || rec.title || rec['film name'] || rec.film, 300)

function filmKey(rec) {
  const uri = M.str(rec['letterboxd uri'] || rec.url || rec.uri, 200).toLowerCase()
  if (uri) return 'u:' + uri
  return 't:' + titleOf(rec).toLowerCase() + '|' + (M.year(rec.year) || '')
}

/**
 * @param {{name?: string, data?: Buffer, text?: string}[]} files  the zip and/or loose csv files
 */
function parseExport(files) {
  const { files: parts, warnings } = collectFiles(files)
  const films = new Map() // filmKey -> { title, year, state }
  const lists = []
  let truncated = false

  const film = (rec) => {
    const title = titleOf(rec)
    if (!title) return null
    const key = filmKey(rec)
    let f = films.get(key)
    if (!f) { f = { title, year: M.year(rec.year), state: {} }; films.set(key, f) }
    return f
  }

  for (const part of parts) {
    if (part.kind === 'list') {
      const l = parseListCsv(part.text, part.name)
      if (l) {
        truncated = truncated || l.truncated
        const refs = []
        for (const rec of l.records) {
          const f = film(rec)
          if (f) refs.push(f)
        }
        if (refs.length) lists.push({ name: l.name, films: refs })
      }
      continue
    }
    const parsed = parseCsvObjects(part.text)
    truncated = truncated || parsed.truncated
    for (const rec of parsed.records) {
      const f = film(rec)
      if (!f) continue
      const date = M.toMs(rec.date)
      if (part.kind === 'watched') {
        f.state.watched = true
        if (date) f.state.lastPlayedAt = Math.max(f.state.lastPlayedAt || 0, date)
      } else if (part.kind === 'diary') {
        f.state.watched = true
        const wd = M.toMs(rec['watched date']) || date
        if (wd) f.state.lastPlayedAt = Math.max(f.state.lastPlayedAt || 0, wd)
        f.state.playCount = (f.state.playCount || 0) + 1
        const r = M.rating10(rec.rating, 5)
        if (r) f.state.rating = r
      } else if (part.kind === 'ratings') {
        const r = M.rating10(rec.rating, 5)
        if (r) f.state.rating = r
      } else if (part.kind === 'watchlist') {
        f.state.watchlist = true
      } else if (part.kind === 'likes') {
        f.state.favorite = true
      }
    }
  }
  if (truncated) warnings.push('A file was very long; only its first rows were read.')

  // A film on the watchlist that is ALSO watched is not on the watchlist any more (Letterboxd
  // removes it there; the export can lag).
  const items = []
  const ref = new Map()
  for (const f of films.values()) {
    if (f.state.watched && f.state.watchlist) delete f.state.watchlist
    const r = 'lb' + items.length
    ref.set(f, r)
    items.push({ ref: r, type: 'movie', title: f.title, year: f.year, ids: {}, state: { [USER_KEY]: f.state } })
  }
  const outLists = lists.map((l) => ({ userKey: USER_KEY, name: l.name, refs: l.films.map((f) => ref.get(f)) }))
  if (!items.length) warnings.push('No films were found. Use the zip from Letterboxd > Settings > Import & Export > Export your data.')
  return M.finishBundle({ source: 'letterboxd', label: 'Letterboxd export', users: [{ key: USER_KEY, name: 'Letterboxd' }], items, lists: outLists, warnings })
}

/** A Letterboxd list export: metadata block, a blank line, then "Position,Name,Year,URL,Description". */
function parseListCsv(text, fileName) {
  const { rows, truncated } = parseCsv(text)
  if (!rows.length) return null
  let name = ''
  let headerRow = -1
  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i].map((c) => c.trim().toLowerCase())
    if (cells[0] === 'position' && cells.includes('name')) { headerRow = i; break }
    if (cells[0] === 'date' && cells.includes('name') && rows[i + 1]) {
      // The metadata row: Date,Name,Tags,URL,Description -> the list's name is on the next row.
      name = M.str(rows[i + 1][cells.indexOf('name')], 100)
    }
  }
  let records = []
  if (headerRow >= 0) {
    const head = rows[headerRow].map((c) => c.trim().toLowerCase())
    for (let i = headerRow + 1; i < rows.length; i++) {
      const rec = {}
      head.forEach((h, c) => { if (h && rows[i][c] !== undefined) rec[h] = rows[i][c].trim() })
      records.push(rec)
    }
  } else {
    // A plain csv with Name and Year columns.
    const plain = parseCsvObjects(text)
    if (!plain.headers.includes('name') && !plain.headers.includes('title')) return null
    records = plain.records
  }
  const fallback = path.basename(String(fileName || 'list'), '.csv').replace(/[-_]+/g, ' ').trim()
  return { name: name || M.str(fallback, 100) || 'Letterboxd list', records, truncated }
}

module.exports = { USER_KEY, classify, collectFiles, parseExport, parseListCsv }
