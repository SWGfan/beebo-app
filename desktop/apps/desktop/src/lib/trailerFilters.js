// Pure helpers for the Trailers screen (src/components/Trailers.jsx): the genre lists,
// reading the year box, the filter object sent to the main process, and the wording of
// outcomes. No React and no IPC, so node --test checks it (test/trailers-ui-model.test.js).
// The genre ids mirror electron/genres.js; that test fails if the two drift apart.

const MOVIE = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime',
  99: 'Documentary', 18: 'Drama', 10751: 'Family', 14: 'Fantasy', 36: 'History',
  27: 'Horror', 10402: 'Music', 9648: 'Mystery', 10749: 'Romance',
  878: 'Science Fiction', 10770: 'TV Movie', 53: 'Thriller', 10752: 'War', 37: 'Western'
}

const TV = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime',
  99: 'Documentary', 18: 'Drama', 10751: 'Family', 14: 'Fantasy', 10762: 'Kids',
  9648: 'Mystery', 10763: 'News', 10768: 'Politics', 10764: 'Reality',
  878: 'Science Fiction', 10766: 'Soap', 10767: 'Talk', 10752: 'War', 37: 'Western'
}

const byName = (table) =>
  Object.entries(table)
    .map(([id, name]) => ({ id: Number(id), name }))
    .sort((a, b) => a.name.localeCompare(b.name))

export const GENRES = { movie: byName(MOVIE), tv: byName(TV) }

export const MIN_YEAR = 1880

/**
 * "1999", "1990-1999", "1990 to 1999" -> { ok: true, yearFrom, yearTo }. An empty box is
 * "any year". A reversed range is put the right way round. Anything else is { ok: false }.
 */
export function parseYearInput(text, now = new Date()) {
  const s = String(text == null ? '' : text).trim()
  if (!s) return { ok: true, yearFrom: null, yearTo: null }
  const m = /^(\d{4})(?:\s*(?:-|–|—|to)\s*(\d{4}))?$/i.exec(s)
  if (!m) return { ok: false, message: 'Type one year (1999) or a range (1990-1999).' }
  const maxYear = now.getFullYear() + 3
  const a = Number(m[1])
  const b = m[2] ? Number(m[2]) : a
  for (const y of [a, b]) {
    if (y < MIN_YEAR || y > maxYear) return { ok: false, message: 'Years run from ' + MIN_YEAR + ' to ' + maxYear + '.' }
  }
  return { ok: true, yearFrom: Math.min(a, b), yearTo: Math.max(a, b) }
}

/** What the screen sends the main process. Only ids and short text; nothing about the viewer. */
export function buildFilters({ media, genres, years, person, text, sort }) {
  return {
    media: media === 'tv' ? 'tv' : 'movie',
    genres: (genres || []).map(Number),
    yearFrom: years && years.ok ? years.yearFrom : null,
    yearTo: years && years.ok ? years.yearTo : null,
    personId: person && Number.isInteger(person.id) ? person.id : null,
    text: String(text || '').trim().slice(0, 100),
    sort: sort === 'rating' ? 'rating' : 'popular'
  }
}

export function filtersKey(f) {
  return JSON.stringify([f.media, [...f.genres].sort((a, b) => a - b), f.yearFrom, f.yearTo, f.personId, f.text, f.sort])
}

export function hasFilters(f) {
  return !!(f.genres.length || f.yearFrom !== null || f.personId !== null || f.text)
}

/** Genre ids that only exist for films are dropped when the screen switches to TV. */
export function keepGenresFor(media, ids) {
  const table = media === 'tv' ? TV : MOVIE
  return (ids || []).filter((id) => Object.prototype.hasOwnProperty.call(table, id))
}

const ERRORS = {
  no_api_key: 'Add a TMDB key in Settings to see suggestions and trailers.',
  bad_api_key: 'TMDB did not accept the key in Settings. Check it there.',
  offline: "Can't reach TMDB right now. Check the internet connection and try again.",
  rate_limited: 'TMDB is busy. Try again in a minute.',
  tmdb_error: 'TMDB had a problem. Try again in a moment.',
  not_found: 'TMDB has nothing for that title.',
  open_failed: "Couldn't open your browser.",
  restricted_profile: 'Trailers are turned off for this profile.',
  bad_request: 'Something went wrong. Try again.',
  internal: 'Something went wrong. Try again.'
}

export function friendlyError(code) {
  return ERRORS[code] || ERRORS.internal
}

/** The line shown after "Watch trailer" is pressed. */
export function watchMessage(res, title) {
  if (!res || !res.ok) return friendlyError(res && res.error)
  if (res.opened === 'search') return 'TMDB has no trailer for ' + title + '. Opened a YouTube search for it in your browser instead.'
  return 'Opened the trailer for ' + title + ' in your browser.'
}

const BASIS = {
  filters: 'Matching your filters',
  library: 'Picked from titles in your library',
  popular: 'Popular right now'
}

export function basisLabel(basis) {
  return BASIS[basis] || ''
}
