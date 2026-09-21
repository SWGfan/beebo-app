// libraryColumns.js — what the Movies / TV Shows Table view can show: the row shape built
// from what the screens already hold, the column catalog (labels, formatters, sort keys),
// the saved-choice cleanup, sorting and the CSV. Pure, so node --test checks it
// (test/library-table.test.js).
//
// A "row" is one movie or one show. Some columns come from the row itself (title, year,
// size: known the moment the library is scanned). Others come from an `info` record read
// from the video file in the background (resolution, codecs, runtime...): the table asks
// for `info` lazily and a cell without it is "pending", drawn as a faint dot, not as blank.

import {
  bestLabel,
  classFromTier,
  classifyResolution,
  formatDimensions,
  modeLabel,
  pixelCount,
  pixelsFromTier,
  resolutionRank
} from './videoResolution.js'
import {
  formatAudio,
  formatBitrate,
  formatBytes,
  formatContainer,
  formatDate,
  formatFps,
  formatList,
  formatRating,
  formatRuntime,
  formatVideoCodec,
  isoDate
} from './libraryFormat.js'

// ------------------------------------------------------------------ rows

const dirOf = (p) => {
  const s = String(p || '')
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'))
  return i > 0 ? s.slice(0, i) : ''
}

const yearOf = (date) => {
  const y = parseInt(String(date || '').slice(0, 4), 10)
  return y >= 1800 && y <= 2200 ? y : null
}

// The library folder a file was found under: its absolute path minus its path below that folder.
// Older scans without relPath fall back to the file's own folder.
const rootOf = (abs, rel) => {
  const a = String(abs || '')
  const r = String(rel || '')
  return r && a.endsWith(r) ? a.slice(0, a.length - r.length).replace(/[\\/]+$/, '') : dirOf(a)
}

const TMDB_IMG = 'https://image.tmdb.org/t/p'
/** The poster the cards use: the locally cached copy, else TMDB's small size. */
export const posterUrlOf = (meta) => (meta && (meta.localPosterPath || (meta.poster_path ? `${TMDB_IMG}/w300${meta.poster_path}` : ''))) || ''
/** The fan-art backdrop, or '' when TMDB has none. */
export const backdropUrlOf = (meta) => (meta && meta.backdrop_path ? `${TMDB_IMG}/w780${meta.backdrop_path}` : '')

/** The A-Z section key the letter bar uses: first letter, or '#'. */
export function letterKey(title) {
  const ch = String(title || '').charAt(0).toUpperCase()
  return /[A-Z]/.test(ch) ? ch : '#'
}

/**
 * One movie. `m` is a scanMovies() file; `meta` its TMDB match (or null/undefined);
 * `tier` the app's ffprobe quality tier for it ('2160p' ... 'unknown'); `genreNames`
 * the TMDB genre id -> name map; `collection` its franchise name when known.
 */
export function buildMovieRow(m, meta, { tier, genreNames, collection, studio } = {}) {
  const title = (meta && meta.title) || m.name
  return {
    id: m.path,
    kind: 'movies',
    title,
    year: yearOf(meta && meta.release_date),
    rating: meta && Number(meta.vote_average) > 0 ? Number(meta.vote_average) : null,
    votes: meta && Number(meta.vote_count) > 0 ? Number(meta.vote_count) : null,
    certification: (meta && meta.certification) || '',
    genres: ((meta && meta.genre_ids) || []).map((id) => (genreNames || {})[id]).filter(Boolean),
    collection: collection || '',
    studio: studio || '',
    overview: (meta && meta.overview) || '',
    poster: posterUrlOf(meta),
    backdrop: backdropUrlOf(meta),
    root: rootOf(m.path, m.relPath),
    rel: m.relPath || String(m.path || '').split(/[\\/]/).pop() || '',
    language: (meta && meta.original_language) || '',
    sizeBytes: Number(m.size) >= 0 ? Number(m.size) : null,
    mtimeMs: Number(m.mtimeMs) || null,
    ext: m.ext || '',
    fileName: m.fileName || '',
    path: m.path,
    folder: dirOf(m.path),
    tierLabel: classFromTier(tier),
    tierPixels: pixelsFromTier(tier),
    probePath: m.path,
    letter: letterKey(title),
    noPoster: !(meta && (meta.localPosterPath || meta.poster_path))
  }
}

// The folder a show lives in, from one episode's absolute path and its path relative to the
// library root. '' for loose files dropped straight into the root (there is no show folder).
function showFolder(ep) {
  const rel = String(ep.relPath || '')
  const parts = rel.split(/[\\/]/).filter(Boolean)
  const abs = String(ep.path || '')
  if (parts.length < 2 || !abs.endsWith(rel)) return ''
  return abs.slice(0, abs.length - rel.length) + parts[0]
}

// The show's folder below the library folder ('' for a loose file dropped straight into it).
function showRel(ep) {
  const parts = String(ep.relPath || '').split(/[\\/]/).filter(Boolean)
  return parts.length >= 2 ? parts[0] : ''
}

const epOrder = (a, b) => {
  const sa = a.season === null || a.season === undefined ? Infinity : a.season
  const sb = b.season === null || b.season === undefined ? Infinity : b.season
  if (sa !== sb) return sa - sb
  const ea = a.episode === null || a.episode === undefined ? Infinity : a.episode
  const eb = b.episode === null || b.episode === undefined ? Infinity : b.episode
  return ea - eb
}

/**
 * What the Table needs from a show's episode files, worked out once per scan (not per
 * render): counts, total size, the tiers, the folder, and the one episode whose file is
 * read for the codec/audio/HDR columns (the first, in season/episode order).
 * `tierOf(ep)` is the screen's own quality lookup.
 */
export function summarizeShow(show, tierOf) {
  const eps = show.episodes || []
  const seasons = new Set()
  let size = 0
  let latest = 0
  const labels = []
  const exts = new Map()
  let first = null
  for (const ep of eps) {
    if (ep.season !== null && ep.season !== undefined) seasons.add(ep.season)
    size += Number(ep.size) || 0
    if (Number(ep.mtimeMs) > latest) latest = Number(ep.mtimeMs)
    labels.push(classFromTier(tierOf(ep)))
    const x = String(ep.fileName || '').split('.').pop().toLowerCase()
    if (x) exts.set(x, (exts.get(x) || 0) + 1)
    if (!first || epOrder(ep, first) < 0) first = ep
  }
  let ext = ''
  let extCount = 0
  for (const [x, n] of exts) if (n > extCount) { ext = x; extCount = n }
  return {
    key: show.key,
    name: show.name,
    episodes: eps.length,
    seasons: seasons.size,
    sizeBytes: size,
    latestMs: latest || null,
    resMode: modeLabel(labels),
    resBest: bestLabel(labels),
    ext: ext ? `.${ext}` : '',
    epKeys: eps.map((ep) => ep.relPath || ep.fileName),
    probePath: first ? first.path : '',
    folder: first ? showFolder(first) : '',
    root: first ? rootOf(first.path, first.relPath) : '',
    rel: first ? showRel(first) : ''
  }
}

/** One show, from its summary and its TMDB match. */
export function buildShowRow(summary, meta, { genreNames } = {}) {
  const title = (meta && meta.name) || summary.name
  return {
    id: summary.key,
    kind: 'tv',
    title,
    year: yearOf(meta && meta.first_air_date),
    rating: meta && Number(meta.vote_average) > 0 ? Number(meta.vote_average) : null,
    votes: meta && Number(meta.vote_count) > 0 ? Number(meta.vote_count) : null,
    certification: (meta && meta.certification) || '',
    genres: ((meta && meta.genre_ids) || []).map((id) => (genreNames || {})[id]).filter(Boolean),
    collection: '',
    studio: '',
    overview: (meta && meta.overview) || '',
    poster: posterUrlOf(meta),
    backdrop: backdropUrlOf(meta),
    root: summary.root || '',
    rel: summary.rel || '',
    language: (meta && meta.original_language) || '',
    seasons: summary.seasons,
    episodes: summary.episodes,
    sizeBytes: summary.sizeBytes,
    mtimeMs: summary.latestMs,
    ext: summary.ext,
    epKeys: summary.epKeys,
    fileName: '',
    path: '',
    folder: summary.folder,
    tierLabel: summary.resMode,
    tierBest: summary.resBest,
    probePath: summary.probePath,
    letter: letterKey(title),
    noPoster: !(meta && (meta.localPosterPath || meta.poster_path))
  }
}

// ------------------------------------------------------------------ columns

const NONE = { text: '', sort: null }
// Marks not fetched yet (the table draws the faint dot); `marks` is null until then, false when unavailable.
const PENDING = { text: '', sort: null, pending: true }
const yesNo = (on) => (on ? { text: 'Yes', sort: 1 } : { text: 'No', sort: 0 })
const txt = (text) => (text ? { text: String(text), sort: String(text) } : NONE)
const num = (value, text) => (value === null || value === undefined || value === '' ? NONE : { text: String(text), sort: Number(value) })

const probed = (info) => !!(info && info.probed && !info.failed)

const languageName = (code) => {
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(String(code))
    return name && name !== code ? name : String(code).toUpperCase()
  } catch {
    return String(code).toUpperCase()
  }
}

// A movie is described by its own file when that has been read, else by the app's coarser
// quality tier. A show is described by the tier of most of its episodes (what the poster
// badge is built from); the first episode's file only fills in when no tier is known.
function resolutionCell(row, info) {
  const fromFile = probed(info) ? classifyResolution(info.width, info.height) : null
  const tv = row.kind === 'tv'
  if (tv && row.tierLabel) return { text: row.tierLabel, sort: resolutionRank(row.tierLabel) }
  if (fromFile) return { text: fromFile, sort: tv ? resolutionRank(fromFile) : pixelCount(info.width, info.height) }
  if (row.tierLabel) return { text: row.tierLabel, sort: row.tierPixels }
  return NONE
}

// The column catalog. `kinds` says which screens list it. `needsInfo` columns wait for the
// background read of the file; `ownerOnly` columns exist only when the caller says the
// person may see file locations. `cell(row, info)` -> { text, sort }: text is what is
// shown ('' = no value), sort is what the header click orders by (null sorts last).
const ALL = [
  { id: 'title', label: 'Title', group: 'Basics', width: 300, type: 'text', kinds: ['movies', 'tv'], cell: (r) => txt(r.title) },
  {
    id: 'year', label: 'Year', labels: { tv: 'First aired' }, group: 'Basics', width: 84, align: 'right', type: 'number', kinds: ['movies', 'tv'],
    cell: (r) => num(r.year, r.year)
  },
  {
    id: 'seasons', label: 'Seasons', group: 'Basics', width: 84, align: 'right', type: 'number', kinds: ['tv'],
    title: 'Seasons you have at least one episode of',
    cell: (r) => (r.seasons ? num(r.seasons, r.seasons) : NONE)
  },
  { id: 'episodes', label: 'Episodes', group: 'Basics', width: 92, align: 'right', type: 'number', kinds: ['tv'], cell: (r) => num(r.episodes, r.episodes) },
  {
    id: 'rating', label: 'Rating', group: 'Basics', width: 84, align: 'right', type: 'number', kinds: ['movies', 'tv'],
    title: 'TMDB rating out of 10',
    cell: (r) => num(r.rating, formatRating(r.rating))
  },
  { id: 'votes', label: 'Votes', group: 'Basics', width: 84, align: 'right', type: 'number', kinds: ['movies', 'tv'], title: 'TMDB vote count', cell: (r) => num(r.votes, r.votes) },
  { id: 'certification', label: 'Age rating', group: 'Basics', width: 100, type: 'text', kinds: ['movies', 'tv'], cell: (r) => txt(r.certification) },
  {
    id: 'runtime', label: 'Length', group: 'Basics', width: 84, align: 'right', type: 'number', kinds: ['movies'], needsInfo: true,
    title: 'Running time, hours:minutes, read from the video file',
    cell: (r, i) => (probed(i) && i.durationSec > 0 ? num(i.durationSec, formatRuntime(i.durationSec)) : NONE)
  },
  {
    id: 'resolution', label: 'Resolution', labels: { tv: 'Resolution (most eps)' }, group: 'Video & audio', width: 110, type: 'number', kinds: ['movies', 'tv'], needsInfo: true,
    title: 'Sharpness class from the real video size, so a 1920x800 film is 1080p',
    cell: (r, i) => resolutionCell(r, i)
  },
  {
    id: 'resolutionBest', label: 'Best resolution', group: 'Video & audio', width: 116, type: 'number', kinds: ['tv'],
    title: 'The sharpest episode you have',
    cell: (r) => (r.tierBest ? { text: r.tierBest, sort: resolutionRank(r.tierBest) } : NONE)
  },
  {
    id: 'resolutionExact', label: 'Dimensions', labels: { tv: 'Dimensions (1st ep)' }, group: 'Video & audio', width: 116, type: 'number', kinds: ['movies', 'tv'], needsInfo: true,
    title: 'Exact video width x height in pixels',
    cell: (r, i) => (probed(i) && formatDimensions(i.width, i.height) ? { text: formatDimensions(i.width, i.height), sort: pixelCount(i.width, i.height) } : NONE)
  },
  {
    id: 'videoCodec', label: 'Video codec', labels: { tv: 'Video codec (1st ep)' }, group: 'Video & audio', width: 124, type: 'text', kinds: ['movies', 'tv'], needsInfo: true,
    cell: (r, i) => (probed(i) ? txt(formatVideoCodec(i.videoCodec)) : NONE)
  },
  {
    id: 'hdr', label: 'HDR', labels: { tv: 'HDR (1st ep)' }, group: 'Video & audio', width: 116, type: 'text', kinds: ['movies', 'tv'], needsInfo: true,
    title: 'Dolby Vision, HDR10+, HDR10, HLG or SDR, from the video stream',
    cell: (r, i) => (probed(i) ? txt(i.hdr) : NONE)
  },
  {
    id: 'formats', label: 'Home theater', labels: { tv: 'Home theater (1st ep)' }, group: 'Video & audio', width: 230, type: 'text', kinds: ['movies', 'tv'], needsInfo: true,
    title: 'What the file offers a big screen and an AV receiver: 4K, Dolby Vision, HDR10+, Atmos, DTS:X, 7.1 ...',
    cell: (r, i) => (probed(i) && Array.isArray(i.badges) && i.badges.length ? txt(i.badges.join(' \u2022 ')) : NONE)
  },
  {
    id: 'audio', label: 'Audio', labels: { tv: 'Audio (1st ep)' }, group: 'Video & audio', width: 132, type: 'text', kinds: ['movies', 'tv'], needsInfo: true,
    title: 'Codec and channel layout of the main audio track',
    cell: (r, i) => {
      if (!probed(i)) return NONE
      const a = (i.audio || []).find((t) => t.isDefault) || (i.audio || [])[0]
      return a ? txt(formatAudio(a.codec, a.profile, a.channels, a.layout)) : NONE
    }
  },
  {
    id: 'audioLanguages', label: 'Audio languages', labels: { tv: 'Audio languages (1st ep)' }, group: 'Video & audio', width: 170, type: 'text', kinds: ['movies', 'tv'], needsInfo: true,
    cell: (r, i) => (probed(i) ? txt(formatList(i.audioLangs)) : NONE)
  },
  {
    id: 'subtitleLanguages', label: 'Subtitles', labels: { tv: 'Subtitles (1st ep)' }, group: 'Video & audio', width: 170, type: 'text', kinds: ['movies', 'tv'], needsInfo: true,
    title: 'Languages of subtitle tracks inside the file (not separate .srt files)',
    cell: (r, i) => (probed(i) ? txt(formatList(i.subLangs)) : NONE)
  },
  {
    id: 'bitrate', label: 'Bitrate', labels: { tv: 'Bitrate (1st ep)' }, group: 'Video & audio', width: 100, align: 'right', type: 'number', kinds: ['movies', 'tv'], needsInfo: true,
    title: 'Overall bitrate of the file',
    cell: (r, i) => (probed(i) && i.totalKbps > 0 ? num(i.totalKbps, formatBitrate(i.totalKbps)) : NONE)
  },
  {
    id: 'fps', label: 'Frame rate', labels: { tv: 'Frame rate (1st ep)' }, group: 'Video & audio', width: 96, align: 'right', type: 'number', kinds: ['movies', 'tv'], needsInfo: true,
    cell: (r, i) => (probed(i) && i.fps > 0 ? num(i.fps, formatFps(i.fps)) : NONE)
  },
  {
    id: 'size', label: 'Size', labels: { tv: 'Total size' }, group: 'File', width: 92, align: 'right', type: 'number', kinds: ['movies', 'tv'],
    csvLabel: 'Size (bytes)',
    csv: (r) => (r.sizeBytes === null || r.sizeBytes === undefined ? '' : String(r.sizeBytes)),
    cell: (r) => (r.sizeBytes === null || r.sizeBytes === undefined ? NONE : { text: formatBytes(r.sizeBytes), sort: r.sizeBytes })
  },
  {
    id: 'container', label: 'Container', group: 'File', width: 96, type: 'text', kinds: ['movies', 'tv'],
    title: 'File type',
    cell: (r) => txt(formatContainer(r.ext))
  },
  {
    id: 'dateAdded', label: 'Date added', labels: { tv: 'Latest file date' }, group: 'File', width: 116, type: 'date', kinds: ['movies', 'tv'], needsInfo: 'movies', statOnly: true,
    title: 'When the file was created on this computer (falls back to its modified date)',
    csv: (r, i) => {
      const ms = r.kind === 'tv' ? r.mtimeMs : i && (i.birthMs || i.mtimeMs)
      return ms ? isoDate(ms) : ''
    },
    cell: (r, i) => {
      if (r.kind === 'tv') return r.mtimeMs ? { text: formatDate(r.mtimeMs), sort: r.mtimeMs } : NONE
      const ms = i && (i.birthMs || i.mtimeMs)
      return ms ? { text: formatDate(ms), sort: ms } : NONE
    }
  },
  {
    id: 'watched', label: 'Watched', group: 'Library', width: 96, type: 'number', kinds: ['movies'], needsMarks: true,
    title: 'Whether you (the owner) have watched it. Not shown if viewing privacy is on.',
    cell: (r, i, marks) => (marks === null ? PENDING : marks === false ? NONE : yesNo(marks.watchedMovies.has(r.fileName)))
  },
  {
    id: 'watchlist', label: 'Watchlist', group: 'Library', width: 96, type: 'number', kinds: ['movies'], needsMarks: true,
    title: 'Whether it is on your (the owner) watchlist. Not shown if viewing privacy is on.',
    cell: (r, i, marks) => (marks === null ? PENDING : marks === false ? NONE : yesNo(marks.watchlistMovies.has(r.fileName)))
  },
  {
    id: 'episodesWatched', label: 'Episodes watched', group: 'Library', width: 140, align: 'right', type: 'number', kinds: ['tv'], needsMarks: true,
    title: 'How many of the episodes you have that you (the owner) have watched. Not shown if viewing privacy is on.',
    cell: (r, i, marks) => {
      if (marks === null) return PENDING
      if (marks === false || !r.epKeys || r.epKeys.length === 0) return NONE
      let n = 0
      for (const k of r.epKeys) if (marks.watchedEpisodes.has(k)) n++
      return { text: `${n} / ${r.epKeys.length}`, sort: n / r.epKeys.length }
    }
  },
  { id: 'fileName', label: 'File name', group: 'File', width: 260, type: 'text', kinds: ['movies'], cell: (r) => txt(r.fileName) },
  {
    id: 'genres', label: 'Genres', group: 'Library', width: 200, type: 'text', kinds: ['movies', 'tv'],
    cell: (r) => txt(formatList(r.genres, 3))
  },
  { id: 'collection', label: 'Collection', group: 'Library', width: 200, type: 'text', kinds: ['movies'], title: 'The film series it belongs to', cell: (r) => txt(r.collection) },
  {
    id: 'language', label: 'Original language', group: 'Library', width: 140, type: 'text', kinds: ['movies', 'tv'],
    cell: (r) => txt(r.language ? languageName(r.language) : '')
  },
  { id: 'folder', label: 'Folder', group: 'Owner only', width: 320, type: 'text', kinds: ['movies', 'tv'], ownerOnly: true, cell: (r) => txt(r.folder) },
  { id: 'path', label: 'File path', group: 'Owner only', width: 420, type: 'text', kinds: ['movies'], ownerOnly: true, cell: (r) => txt(r.path) }
]

const forKind = (kind) =>
  ALL.filter((c) => c.kinds.includes(kind)).map((c) => ({ ...c, label: (c.labels && c.labels[kind]) || c.label }))

export const MOVIE_COLUMNS = forKind('movies')
export const TV_COLUMNS = forKind('tv')

export const DEFAULT_COLUMNS = {
  movies: ['title', 'year', 'rating', 'runtime', 'resolution', 'size'],
  tv: ['title', 'year', 'seasons', 'episodes', 'rating', 'resolution', 'size']
}

export const DEFAULT_SORT = { id: 'title', dir: 'asc' }

/** Columns this person may see, in catalog order. */
export function catalogFor(kind, { showPaths = false } = {}) {
  return (kind === 'tv' ? TV_COLUMNS : MOVIE_COLUMNS).filter((c) => showPaths || !c.ownerOnly)
}

/** The saved column ids turned into columns: unknown or not-allowed ids dropped, Title always kept, catalog order. */
export function resolveColumns(kind, savedIds, { showPaths = false } = {}) {
  const catalog = catalogFor(kind, { showPaths })
  const want = new Set(Array.isArray(savedIds) ? savedIds : DEFAULT_COLUMNS[kind])
  want.add('title')
  const picked = catalog.filter((c) => want.has(c.id))
  return picked.length > 1 ? picked : catalog.filter((c) => DEFAULT_COLUMNS[kind].includes(c.id))
}

/** The saved sort turned into { col, dir }; falls back to Title A-Z when it names a column that is gone. */
export function resolveSort(kind, saved, { showPaths = false } = {}) {
  const catalog = catalogFor(kind, { showPaths })
  const match = saved && catalog.find((c) => c.id === saved.id)
  if (!match) return { col: catalog.find((c) => c.id === DEFAULT_SORT.id), dir: DEFAULT_SORT.dir }
  return { col: match, dir: saved.dir === 'desc' ? 'desc' : 'asc' }
}

/** Header click: same column flips direction, a new column starts ascending (text) or descending (numbers, dates). */
export function nextSort(current, col) {
  if (current && current.id === col.id) return { id: col.id, dir: current.dir === 'asc' ? 'desc' : 'asc' }
  return { id: col.id, dir: col.type === 'text' ? 'asc' : 'desc' }
}

// ------------------------------------------------------------------ sorting

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/**
 * A new array of `rows` ordered by `col`. Rows with no value always sit last, whichever
 * way it sorts. Ties fall back to Title, then id, so the order never shuffles.
 * `infoOf(row)` returns the row's info record or undefined.
 */
export function sortRows(rows, col, dir, infoOf, marks = null) {
  const sign = dir === 'desc' ? -1 : 1
  const keys = new Array(rows.length)
  for (let i = 0; i < rows.length; i++) keys[i] = col.cell(rows[i], infoOf ? infoOf(rows[i]) : undefined, marks).sort
  const order = new Array(rows.length)
  for (let i = 0; i < order.length; i++) order[i] = i
  const numeric = col.type !== 'text'
  order.sort((a, b) => {
    const ka = keys[a]
    const kb = keys[b]
    const aNone = ka === null || ka === undefined || (numeric && Number.isNaN(ka))
    const bNone = kb === null || kb === undefined || (numeric && Number.isNaN(kb))
    if (aNone !== bNone) return aNone ? 1 : -1
    if (!aNone) {
      const c = numeric ? ka - kb : collator.compare(ka, kb)
      if (c !== 0) return c * sign
    }
    return collator.compare(rows[a].title, rows[b].title) || (rows[a].id < rows[b].id ? -1 : rows[a].id > rows[b].id ? 1 : 0)
  })
  return order.map((i) => rows[i])
}

// ------------------------------------------------------------------ CSV

const csvCell = (value) => {
  let s = String(value === null || value === undefined ? '' : value)
  // A spreadsheet runs a cell that starts with these as a formula, and file names come from anywhere.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** RFC 4180 CSV of `rows` (already filtered and sorted) x `cols`. Cells still being read are left empty. */
export function buildCsv(rows, cols, infoOf, marks = null) {
  const lines = [cols.map((c) => csvCell(c.csvLabel || c.label)).join(',')]
  for (const row of rows) {
    const info = infoOf ? infoOf(row) : undefined
    lines.push(cols.map((c) => csvCell(c.csv ? c.csv(row, info) : c.cell(row, info, marks).text)).join(','))
  }
  return lines.join('\r\n') + '\r\n'
}

/** Does this column wait on the background read of the file, on this kind of screen? */
export function columnNeedsInfo(col, kind) {
  return col.needsInfo === true || col.needsInfo === kind
}

/** Does it need the file actually read (ffprobe), not just stat'ed (size, dates)? */
export function columnNeedsProbe(col, kind) {
  return columnNeedsInfo(col, kind) && col.statOnly !== true
}

/** How many of `rows` still lack the file details the shown `cols` want (for the "reading details" note). */
export function pendingInfoCount(rows, cols, infoOf) {
  if (rows.length === 0 || !cols.some((c) => columnNeedsInfo(c, rows[0].kind))) return 0
  const probe = cols.some((c) => columnNeedsProbe(c, rows[0].kind))
  let n = 0
  for (const row of rows) {
    if (!row.probePath) continue
    const info = infoOf(row)
    if (!info || (probe && !info.probed)) n++
  }
  return n
}
