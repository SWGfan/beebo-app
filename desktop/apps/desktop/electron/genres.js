// TMDB genre names, shared by the stream server, the Electron main process and (copied) the
// desktop components, so every screen names genres identically.
//
// TV listings lump some genres together that films keep apart ("Action & Adventure"). Beebo
// splits them into the FILM genres (2026-09-16, the owner: "split up the Action and Adventure in to
// their own categories"), so "Action" means the same thing for a film and a show and a show
// tagged "Action & Adventure" appears under both Action and Adventure. The split is applied
// where TV metadata is loaded (tmdbCache.getTvManifest, and each fresh TMDB match), so every
// reader downstream - genre chips, filters, counts, the phone API, Surprise - just sees film ids.

const GENRE_NAMES_MOVIE = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime',
  99: 'Documentary', 18: 'Drama', 10751: 'Family', 14: 'Fantasy', 36: 'History',
  27: 'Horror', 10402: 'Music', 9648: 'Mystery', 10749: 'Romance',
  878: 'Science Fiction', 10770: 'TV Movie', 53: 'Thriller', 10752: 'War', 37: 'Western'
}

// Combined TMDB TV genre id -> the ids it is split into. 10768 has no film counterpart for
// "Politics", so it keeps its own id and now means just Politics.
const TV_COMBINED_GENRES = {
  10759: [28, 12], // Action & Adventure -> Action, Adventure
  10765: [878, 14], // Sci-Fi & Fantasy -> Science Fiction, Fantasy
  10768: [10752, 10768] // War & Politics -> War, Politics
}

const GENRE_NAMES_TV = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime',
  99: 'Documentary', 18: 'Drama', 10751: 'Family', 14: 'Fantasy', 10762: 'Kids',
  9648: 'Mystery', 10763: 'News', 10768: 'Politics', 10764: 'Reality',
  878: 'Science Fiction', 10766: 'Soap', 10767: 'Talk', 10752: 'War', 37: 'Western'
}

// A show's genre ids with combined genres split, order kept, no duplicates. Idempotent.
function splitTvGenreIds(ids) {
  if (!Array.isArray(ids)) return ids
  const out = []
  for (const id of ids) {
    for (const part of TV_COMBINED_GENRES[id] || [id]) if (!out.includes(part)) out.push(part)
  }
  return out
}

function needsSplit(ids) {
  return Array.isArray(ids) && splitTvGenreIds(ids).join() !== ids.join()
}

// A TV match/meta object with split genre ids: the same object when nothing changes, else a copy.
function splitTvMatchGenres(match) {
  if (!match || typeof match !== 'object' || !needsSplit(match.genre_ids)) return match
  return { ...match, genre_ids: splitTvGenreIds(match.genre_ids) }
}

// Splits every entry of a TV manifest object IN PLACE (it is the shared parsed cache).
function splitTvManifestGenres(manifest) {
  if (!manifest || typeof manifest !== 'object') return manifest
  for (const k of Object.keys(manifest)) {
    const v = manifest[k]
    if (v && typeof v === 'object' && needsSplit(v.genre_ids)) v.genre_ids = splitTvGenreIds(v.genre_ids)
  }
  return manifest
}

// An old combined id in a bookmarked ?genre= link -> the first genre it now splits into.
function canonicalTvGenreId(id) {
  const parts = TV_COMBINED_GENRES[Number(id)]
  return parts ? String(parts[0]) : id
}

module.exports = {
  GENRE_NAMES_MOVIE,
  GENRE_NAMES_TV,
  TV_COMBINED_GENRES,
  splitTvGenreIds,
  splitTvMatchGenres,
  splitTvManifestGenres,
  canonicalTvGenreId
}
