'use strict'
// Turns a raw TMDB /credits response into the cast shape this app stores and
// serves. Used by main.js's tmdb:credits/tmdb:tvCredits IPC handlers AND
// streamServer.js's tmdbCredits() — three call sites used to each carry their
// own copy of this exact one-liner (movie in main.js, movie in streamServer.js,
// TV in main.js), which is exactly the kind of divergence PLEX-PARITY-PLAN.md
// warned collections logic could fall into if a shared extraction didn't
// actually happen. One place now, so a future change (or bug fix) can't land
// in only one or two of the three.

const DEFAULT_CAST_LIMIT = 15

/** Raw TMDB /credits `data` -> our cast array shape. Pure; no I/O, no cache. */
function parseCast(data, limit = DEFAULT_CAST_LIMIT) {
  const raw = (data && Array.isArray(data.cast)) ? data.cast : []
  return raw.slice(0, limit).map((c) => ({
    id: c.id,
    name: c.name,
    character: c.character || null,
    profilePath: c.profile_path || null
  }))
}

/**
 * A cast array cached before `character` existed (bare {id,name,profilePath}
 * rows) reads back as a cache hit forever unless something notices the old
 * shape - the exact "stuck null" bug class titleMatch.js's shouldLookUp()
 * already guards against for matches, just for a different cache. An empty
 * array is NOT stale (it is a real "TMDB had nothing" answer, same as a
 * confirmed no-match) - only a populated array missing the new field is.
 */
function isStaleCast(cached) {
  return Array.isArray(cached) && cached.length > 0 && !('character' in cached[0])
}

module.exports = {
  DEFAULT_CAST_LIMIT,
  parseCast,
  isStaleCast
}
