// movieFormat.js - the small text formatters the details page uses. Pure, no
// React / IPC, checked by test/movie-format.test.js.

// TMDB's terms ask for this wherever their data is shown.
export const TMDB_ATTRIBUTION = 'This product uses the TMDB API but is not endorsed or certified by TMDB.'

/** 112 -> "1hr 52min", 45 -> "45min", 120 -> "2hr". Anything unusable -> "". */
export function formatRuntime(minutes) {
  const total = Math.round(Number(minutes))
  if (!Number.isFinite(total) || total <= 0) return ''
  const h = Math.floor(total / 60)
  const m = total % 60
  if (!h) return `${m}min`
  return m ? `${h}hr ${m}min` : `${h}hr`
}

/** 4930 -> "1:22:10", 125 -> "2:05". For "Resume from ..." */
export function formatClock(seconds) {
  const s = Math.floor(Number(seconds))
  if (!Number.isFinite(s) || s < 0) return ''
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const two = (n) => String(n).padStart(2, '0')
  return h ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`
}

/** "Directed by A" / "A and B" / "A, B and C". */
export function formatDirectedBy(names) {
  const list = (Array.isArray(names) ? names : []).map((n) => String(n || '').trim()).filter(Boolean)
  if (!list.length) return ''
  const body = list.length === 1 ? list[0] : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`
  return `Directed by ${body}`
}

/** { year: "2010", runtime: 148, certification: "PG-13" } -> "2010 · 2hr 28min · PG-13". */
export function formatFactsLine({ year, runtime, certification } = {}) {
  return [year ? String(year) : '', formatRuntime(runtime), certification || ''].filter(Boolean).join(' · ')
}

/**
 * TMDB's vote average (0-10) as a five-star fill in half steps plus the number.
 * Returns null when there are no votes to speak of, so the page shows nothing
 * rather than "0.0".
 */
export function formatRating(voteAverage, voteCount) {
  const v = Number(voteAverage)
  const n = Number(voteCount)
  if (!Number.isFinite(v) || v <= 0) return null
  if (Number.isFinite(n) && n <= 0) return null
  const clamped = Math.min(10, v)
  return { score: clamped.toFixed(1), halfStars: Math.round(clamped), votes: Number.isFinite(n) ? n : null }
}

const IMAGE_PATH_RE = /^\/[A-Za-z0-9._-]{1,120}$/
const IMAGE_SIZES = new Set(['w92', 'w154', 'w185', 'w300', 'w342', 'w500', 'w780', 'w1280', 'h632', 'original'])

/** A TMDB image address for a "/abc.jpg" path, or null for anything else (never builds a URL from odd input). */
export function tmdbImageUrl(imagePath, size = 'w300') {
  if (typeof imagePath !== 'string' || !IMAGE_PATH_RE.test(imagePath)) return null
  return `https://image.tmdb.org/t/p/${IMAGE_SIZES.has(size) ? size : 'w300'}${imagePath}`
}

/** Initials for the round photo placeholder: "Leonardo DiCaprio" -> "LD". */
export function initialsOf(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean)
  if (!words.length) return '?'
  return (words[0][0] + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase()
}

/** 0-10 half-star count -> ['full','full','half','empty','empty']. */
export function starSlots(halfStars) {
  const h = Math.max(0, Math.min(10, Math.round(Number(halfStars) || 0)))
  return [0, 1, 2, 3, 4].map((i) => (h >= (i + 1) * 2 ? 'full' : h === i * 2 + 1 ? 'half' : 'empty'))
}
