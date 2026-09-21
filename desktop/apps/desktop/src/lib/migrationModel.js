// migrationModel.js - the "Switch to Beebo" wizard as pure functions: which step a session is on,
// which words to show, what a file picker may hand over, and what a request carries. No React, no
// IPC, no DOM, so node --test can check it (test/migration-ui.test.js).
//
// The one rule that shapes this file: an API key or Plex token is typed into a field, sent once in
// the request that reads the server, and is then gone. Nothing here (or in the component) writes one
// to storage, the console or the address bar
// (the test in test/migration-ui.test.js reads this file and the component to make sure of it).

export const STEPS = ['source', 'connect', 'reading', 'review', 'import', 'done']

export const STEP_LABELS = {
  source: 'Choose where you are coming from',
  connect: 'Connect or choose your files',
  reading: 'Reading your data',
  review: 'Check the matches',
  import: 'Import',
  done: 'Done'
}

// What each way in accepts from a file picker.
export const UPLOAD_RULES = {
  'kodi:files': { accept: '.nfo,.xml', extensions: ['nfo', 'xml'], maxFiles: 20000, maxBytes: 96 * 1024 * 1024, label: '.nfo files (or a Kodi videodb.xml export)' },
  'letterboxd:files': { accept: '.zip,.csv', extensions: ['zip', 'csv'], maxFiles: 60, maxBytes: 64 * 1024 * 1024, label: 'the Letterboxd export (.zip, or its .csv files)' },
  'plex:csv': { accept: '.csv', extensions: ['csv'], maxFiles: 1, maxBytes: 32 * 1024 * 1024, label: 'a watch-history .csv' }
}

export const ownerMessage = 'Only the owner of this Beebo server can import. Sign in as the owner.'

const ERRORS = {
  owner_only: ownerMessage,
  no_owner: 'Create the owner account first (Get Started).',
  server_not_running: 'The Beebo server is not running yet.',
  session_not_found: 'That import expired. Start again.',
  unknown_user: 'Choose one of the people on this Beebo server.',
  bad_choice: 'That title cannot be used for this item.',
  import_failed: 'The import could not finish, so nothing was changed.',
  already_undone: 'That import was already undone.',
  cannot_undo: 'That import cannot be undone (it did not finish).',
  import_not_found: 'That import could not be found.',
  no_input: 'Choose a file first.',
  not_ready: 'Wait until the reading has finished.',
  bad_key: 'That key or token does not look right. Copy it again without spaces.',
  unknown_source: 'That source is not supported.',
  unknown_mode: 'That way in is not available here.',
  no_undo_folder: 'There is nowhere to keep the undo information, so nothing was imported.',
  too_much: 'That is more data than can be read at once.',
  too_big: 'That is larger than can be read.',
  server_error: 'Something went wrong. Nothing was changed.',
  cancelled: ''
}

/** A sentence for an error code (or the server's own message, which never holds a credential). */
export function errorText(result) {
  const code = result && typeof result.error === 'string' ? result.error : result && result.error && typeof result.error.code === 'string' ? result.error.code : ''
  if (result && typeof result.message === 'string' && result.message) return result.message
  return ERRORS[code] !== undefined ? ERRORS[code] : code ? 'Could not do that (' + code + ').' : 'Could not do that.'
}

export const SKIP_LABELS = {
  unmatched: 'not found in your library (or left for you to choose)',
  ambiguous: 'matched more than one title and were not chosen',
  alreadyWatched: 'already marked watched here',
  ratingKept: 'already had a rating here (kept)',
  alreadyFavorite: 'already favourites here',
  alreadyOnWatchlist: 'already on the watchlist here',
  resumeNoDuration: 'resume points skipped (the length of the video is not known)',
  resumeTooShortOrFinished: 'resume points skipped (under 30 seconds in, or nearly finished)',
  resumeAlreadyHave: 'resume points skipped (you already have your own progress)',
  historyFull: 'resume points skipped (watch history is full)',
  watchlistFull: 'watchlist entries skipped (the watchlist is full)',
  showFavorite: 'favourite shows skipped (favourites are for single films and episodes)',
  unmappedPerson: 'entries skipped because that person was not mapped',
  listsTooMany: 'lists skipped (too many playlists)',
  noLongerInLibrary: 'titles skipped because they were removed from your library'
}

/** The plain-language lines for what an import did or would do. */
export function summaryLines(counts) {
  const c = counts || {}
  const line = (n, one, many) => (n ? n + ' ' + (n === 1 ? one : many) : null)
  return [
    line(c.watched, 'title marked watched', 'titles marked watched'),
    line(c.resume, 'resume point added', 'resume points added'),
    line(c.ratings, 'rating imported', 'ratings imported'),
    line(c.favorites, 'favourite added', 'favourites added'),
    line(c.watchlist, 'watchlist entry added', 'watchlist entries added'),
    line(c.lists, 'playlist created' + (c.listItems ? ' (' + c.listItems + ' titles)' : ''), 'playlists created' + (c.listItems ? ' (' + c.listItems + ' titles)' : '')),
    line(c.metadata, 'title’s details kept', 'titles’ details kept')
  ].filter(Boolean)
}

/** Skipped counts as sentences, biggest first; zero counts are left out. */
export function skippedLines(skipped) {
  return Object.entries(skipped || {})
    .filter(([k, n]) => n > 0 && SKIP_LABELS[k])
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => n + ' ' + SKIP_LABELS[k])
}

export function totalChanges(counts) {
  const c = counts || {}
  return (c.watched || 0) + (c.resume || 0) + (c.ratings || 0) + (c.favorites || 0) + (c.watchlist || 0) + (c.lists || 0) + (c.metadata || 0)
}

/** Which step a session is on, from what the server says. */
export function stepOf({ session, report, imported } = {}) {
  if (!session) return 'source'
  if (session.status === 'error') return 'connect'
  if (session.status === 'reading' || session.status === 'matching') return 'reading'
  if (imported && report && !report.dryRun) return 'done'
  return 'review'
}

export const FILTERS = [
  { id: 'review', label: 'Needs a look' },
  { id: 'matched', label: 'Matched' },
  { id: 'notInLibrary', label: 'Not in your library' },
  { id: 'decided', label: 'Your choices' },
  { id: 'all', label: 'Everything' }
]

export function filterCount(counts, id) {
  const c = counts || {}
  return { review: c.review, matched: c.matched, notInLibrary: c.notInLibrary, decided: (c.decided || 0) + (c.skipped || 0), all: c.total }[id] || 0
}

export const STATUS_WORDS = { matched: 'Matched', ambiguous: 'Pick one', unmatched: 'Not found' }

export const METHOD_WORDS = {
  tmdb: 'by TMDB id', imdb: 'by IMDb id', tvdb: 'by TheTVDB id', filename: 'by file name', title: 'by title',
  'title-year': 'by title and year', 'title-year-close': 'by title, year within one', 'title-only': 'title only (no year)', 'similar-title': 'similar title'
}

export const REASON_WORDS = {
  not_in_library: 'This is not in your library.',
  show_not_in_library: 'This show is not in your library.',
  episode_not_in_library: 'That episode is not in your library.',
  different_year: 'A title with this name exists, but from a different year.',
  no_year: 'The year is missing, so it cannot be told apart.',
  several_files: 'More than one file fits.',
  similar: 'Something similar is in your library.',
  show_unsure: 'It could be more than one show.',
  no_episode_number: 'The season and episode number are missing.',
  no_title: 'It has no title.'
}

// ---- files -------------------------------------------------------------------------------------
const extOf = (name) => (/\.([A-Za-z0-9]{1,8})$/.exec(String(name || '')) || [])[1]?.toLowerCase() || ''

/**
 * Which of the picked files the source can use, and why any were left out.
 * `files` is anything with { name, size }.
 */
export function selectUploads(files, ruleId) {
  const rule = UPLOAD_RULES[ruleId]
  const list = Array.from(files || [])
  if (!rule) return { use: [], left: list.length, reason: 'not_supported' }
  const okExt = list.filter((f) => rule.extensions.includes(extOf(f.name)))
  const left = list.length - okExt.length
  if (!okExt.length) return { use: [], left, reason: 'none_usable' }
  const use = []
  let total = 0
  for (const f of okExt.slice(0, rule.maxFiles)) {
    total += Number(f.size) || 0
    if (total > rule.maxBytes) return { use, left: left + (okExt.length - use.length), reason: 'too_big' }
    use.push(f)
  }
  return { use, left: left + (okExt.length - use.length), reason: okExt.length > rule.maxFiles ? 'too_many' : '' }
}

export function uploadNotice(sel, ruleId) {
  const rule = UPLOAD_RULES[ruleId]
  if (!rule) return ''
  if (sel.reason === 'none_usable') return 'None of those files can be used. Choose ' + rule.label + '.'
  if (sel.reason === 'too_many') return 'Only the first ' + rule.maxFiles + ' files will be read.'
  if (sel.reason === 'too_big') return 'That is more than can be read at once. Choose fewer files.'
  if (sel.left > 0) return sel.left + ' file' + (sel.left === 1 ? ' was' : 's were') + ' skipped (not ' + rule.label + ').'
  return ''
}

// ---- requests ----------------------------------------------------------------------------------
/** What "Check the connection" sends. The secret is the field's value, used for this one call. */
export function connectRequest(source, form) {
  const f = form || {}
  const base = { source, baseUrl: String(f.baseUrl || '').trim(), insecureTls: f.insecureTls === true }
  return source === 'plex' ? { ...base, token: String(f.secret || '').trim() } : { ...base, apiKey: String(f.secret || '').trim() }
}

/** What "Read my data" sends for a server source. */
export function sessionRequest(source, mode, form) {
  const f = form || {}
  const req = connectRequest(source, f)
  req.mode = mode
  if (source === 'jellyfin' || source === 'emby') req.userIds = Array.isArray(f.userIds) ? f.userIds.slice(0, 64) : []
  if (source === 'plex') req.includeWatchlist = f.includeWatchlist !== false
  return req
}

export function canConnect(source, form) {
  const f = form || {}
  return !!String(f.baseUrl || '').trim() && String(f.secret || '').trim().length >= 8
}

// ---- review rows -------------------------------------------------------------------------------
export function rowNeedsChoice(row) {
  return !!row && (row.status === 'ambiguous' || (row.status === 'unmatched' && row.reason !== 'not_in_library' && row.reason !== 'show_not_in_library' && row.reason !== 'episode_not_in_library'))
}

/** "The Matrix (1999)" / "Severance S01E02" for a target. */
export function targetLabel(t) {
  if (!t) return ''
  return t.type === 'movie' && t.year ? t.title + ' (' + t.year + ')' : t.title
}

export function personLabel(u) {
  if (!u) return ''
  const parts = []
  if (u.watched) parts.push(u.watched + ' watched')
  if (u.resume) parts.push(u.resume + ' in progress')
  if (u.ratings) parts.push(u.ratings + ' rated')
  if (u.favorites) parts.push(u.favorites + ' favourite' + (u.favorites === 1 ? '' : 's'))
  if (u.watchlist) parts.push(u.watchlist + ' on watchlist')
  if (u.lists) parts.push(u.lists + ' list' + (u.lists === 1 ? '' : 's'))
  return u.name + (parts.length ? ' — ' + parts.join(', ') : '')
}

export function importStatusWord(status) {
  return { applied: 'Imported', undone: 'Undone', failed: 'Did not finish', interrupted: 'Interrupted' }[status] || status
}
