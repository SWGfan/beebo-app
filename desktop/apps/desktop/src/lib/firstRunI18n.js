// firstRunI18n.js - the live "found N movies" wording of Get Started, in the person's language.
// Twins of moviesFoundText / showsFoundText / suggestionCountText in firstRun.js (which stay as the
// English originals, covered by test/first-run.test.js); these take the translator `t` and let
// the language's own plural rules and number formats do the work. counter = the same
// electron/libraryDetect.js createLiveCounter().status() object.

export function moviesFound(c, t) {
  if (!c) return t('firstrun.movies.looking')
  const g = c.movies || { count: 0, done: true }
  if (!g.done && !g.count) return t('firstrun.movies.looking')
  if (!g.done) return t('firstrun.movies.soFar', { count: g.count })
  if (!g.count) return t('firstrun.movies.none')
  return t(c && c.truncated ? 'firstrun.movies.foundMore' : 'firstrun.movies.found', { count: g.count })
}

export function showsFound(c, t) {
  if (!c) return t('firstrun.tv.looking')
  const g = c.tv || { count: 0, shows: 0, done: true }
  if (!g.done && !g.count) return t('firstrun.tv.looking')
  if (!g.count) return t('firstrun.tv.none')
  const from = g.shows ? ' ' + t('firstrun.tv.fromShows', { count: g.shows }) : ''
  return t(g.done ? 'firstrun.tv.found' : 'firstrun.tv.soFar', { count: g.count }) + from
}

// "1,204 videos" on a suggestion; a truncated sample says "at least".
export function suggestionCount(s, t) {
  const count = Number(s && s.videos) || 0
  return t(s && s.truncated ? 'firstrun.videosAtLeast' : 'firstrun.videos', { count })
}
