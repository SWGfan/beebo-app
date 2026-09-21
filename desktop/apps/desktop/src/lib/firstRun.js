// firstRun.js: the Get Started screen's steps and wording as pure functions (test/first-run.test.js).
// One list drives the progress bar AND every step's badge, so the two can never disagree.

// The order a family does things in. `optional` steps never hold up "you're all set".
export const STEP_DEFS = [
  { id: 'folders', label: 'Your videos' },
  { id: 'posters', label: 'Posters and info', optional: true },
  { id: 'account', label: 'Family sign-in' },
  { id: 'phone', label: 'Connect your phone' },
  { id: 'away', label: 'Watch away from home', optional: true },
]

export function firstRunSteps({ hasMovies, postersDone, hasOwner, phoneOk, awayDone } = {}) {
  const done = { folders: !!hasMovies, posters: !!postersDone, account: !!hasOwner, phone: !!phoneOk, away: !!awayDone }
  return STEP_DEFS.map((d, i) => ({ id: d.id, n: i + 1, label: d.label, optional: !!d.optional, done: done[d.id] }))
}

export const stepById = (steps, id) => steps.find((s) => s.id === id) || { id, n: 0, done: false }

// The first required step still open, or null when only optional ones are left.
export function nextStep(steps) {
  const open = steps.find((s) => !s.done && !s.optional)
  return open ? open.id : null
}

const fmt = (n) => Number(n || 0).toLocaleString('en-US')
const plural = (n, one, many) => (Number(n) === 1 ? one : many)

// counter = electron/libraryDetect.js createLiveCounter().status()
export function moviesFoundText(c) {
  if (!c) return 'Looking for movies…'
  const g = c.movies || { count: 0, done: true }
  if (!g.done && !g.count) return 'Looking for movies…'
  const n = fmt(g.count)
  if (!g.done) return 'Found ' + n + ' ' + plural(g.count, 'movie', 'movies') + ' so far…'
  if (!g.count) return 'No movies found in this folder yet.'
  return 'Found ' + n + ' ' + plural(g.count, 'movie', 'movies') + (c && c.truncated ? ' (and counting)' : '')
}

export function showsFoundText(c) {
  if (!c) return 'Looking for TV shows…'
  const g = c.tv || { count: 0, shows: 0, done: true }
  if (!g.done && !g.count) return 'Looking for TV shows…'
  const eps = fmt(g.count)
  const shows = g.shows ? ' from ' + fmt(g.shows) + ' ' + plural(g.shows, 'show', 'shows') : ''
  if (!g.done) return 'Found ' + eps + ' ' + plural(g.count, 'episode', 'episodes') + shows + ' so far…'
  if (!g.count) return 'No TV episodes found in this folder yet.'
  return 'Found ' + eps + ' ' + plural(g.count, 'episode', 'episodes') + shows
}

// "1,204 videos" style label on a suggestion; a truncated sample says "at least".
export function suggestionCountText(s) {
  const n = Number(s && s.videos) || 0
  return (s && s.truncated ? 'at least ' : '') + fmt(n) + ' ' + plural(n, 'video', 'videos')
}

// A person-friendly folder path: keeps the end, never a wall of text.
export function shortPath(p, max = 46) {
  const s = String(p || '')
  if (s.length <= max) return s
  const head = s.slice(0, 3)
  return head + '…' + s.slice(s.length - (max - 4))
}

// A folder still on Beebo's own starting spot has not been chosen by the person. Compared without
// case or trailing slashes, because Windows does the same.
const norm = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase()
export const STARTING_FOLDERS = [
  'C:\\Beebo\\Movies', 'C:\\MovieAPP\\Movies', 'C:\\Beebo\\TV Shows', 'D:\\Beebo\\TVShows', 'D:\\MovieAPP\\TVShows',
].map(norm)

export const isStartingFolder = (p) => !p || STARTING_FOLDERS.includes(norm(p))

// Done once the person picked a folder of their own, or Beebo has found real video (more than
// the one welcome clip it seeds into a new Movies folder).
export function foldersDone({ moviesDir, tvDir, found } = {}) {
  return !isStartingFolder(moviesDir) || !isStartingFolder(tvDir) || Number(found) > 1
}
