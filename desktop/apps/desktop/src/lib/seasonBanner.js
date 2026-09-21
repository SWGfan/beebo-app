// seasonBanner.js - what each season poster card says about how complete the
// season is in the library. Pure, checked by test/season-banner.test.js.
//
// The same TMDB episode list drives the "Show missing episodes" rows on the
// show page, so both call missingEpisodeNumbers rather than each working it out.

const isEpNumber = (n) => Number.isInteger(n) && n > 0

/** Episode numbers TMDB lists for the season (entries without a number, e.g. unaired placeholders, are skipped). */
export function tmdbEpisodeNumbers(tmdbEpisodes) {
  return (Array.isArray(tmdbEpisodes) ? tmdbEpisodes : []).map((e) => e && e.episode_number).filter(isEpNumber)
}

/** Episodes TMDB lists that the library does not have: the "Missing" rows. */
export function missingEpisodeNumbers(ownedEpisodes, tmdbEpisodes) {
  const have = new Set((Array.isArray(ownedEpisodes) ? ownedEpisodes : []).filter(isEpNumber))
  return tmdbEpisodeNumbers(tmdbEpisodes).filter((n) => !have.has(n))
}

export function seasonLabel(season) {
  if (season === 0) return 'Specials'
  if (season === 'Unsorted' || season === null || season === undefined) return 'Unsorted'
  return `Season ${season}`
}

/**
 * How complete one season is.
 *   ownedEpisodes  episode numbers the library has (null entries = files with no parsed number)
 *   tmdbEpisodes   TMDB's episode list for the season, or null when not loaded
 *   tmdbCount      TMDB's episode_count for the season (from the show), used when the list is not loaded
 * -> { owned, total, missing, verified }
 * `verified` is true only when TMDB's list (or count) is known, i.e. when "complete" is a claim we can back.
 */
export function seasonCompleteness({ ownedEpisodes, tmdbEpisodes, tmdbCount } = {}) {
  const ownedList = Array.isArray(ownedEpisodes) ? ownedEpisodes : []
  const numbered = Array.from(new Set(ownedList.filter(isEpNumber)))
  const listed = tmdbEpisodeNumbers(tmdbEpisodes)
  if (listed.length) {
    const missing = missingEpisodeNumbers(numbered, tmdbEpisodes).length
    return { owned: listed.length - missing, total: listed.length, missing, verified: true }
  }
  const count = Number(tmdbCount)
  if (Number.isInteger(count) && count > 0) {
    const present = numbered.filter((n) => n <= count).length
    return { owned: present, total: count, missing: count - present, verified: true }
  }
  return { owned: ownedList.length, total: 0, missing: 0, verified: false }
}

/**
 * The banner across the bottom of a season poster.
 *   complete  every TMDB episode is in the library        "All Episodes"
 *   partial   some are missing                            "3 of 12 missing"
 *   empty     none are in the library (card is greyed)    "12 of 12 missing"
 *   unknown   no TMDB data to check against               "8 episodes"
 */
export function seasonBanner(input) {
  const c = seasonCompleteness(input)
  if (!c.verified) {
    return { variant: 'unknown', text: `${c.owned} episode${c.owned === 1 ? '' : 's'}`, ...c }
  }
  if (c.owned === 0) return { variant: 'empty', text: `${c.total} of ${c.total} missing`, ...c }
  if (c.missing === 0) return { variant: 'complete', text: 'All Episodes', ...c }
  return { variant: 'partial', text: `${c.missing} of ${c.total} missing`, ...c }
}
