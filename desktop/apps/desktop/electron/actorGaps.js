// "What else is this person in?" — the ranking behind the By Actor gap list.
//
// The desktop renderer (src/components/Movies.jsx and TVShows.jsx) keeps its
// own copy of buildActorGaps and these constants, because renderer code cannot
// require an electron/ module. THIS file is the server-side twin used by the
// phone API (GET /api/actor/<personId>/missing). If you change a rule here,
// change it in both .jsx files too, so the phone and the desktop app agree
// about what counts as a gap.
//
// Also home to the person-credits disk cache: personCredits.json in the shared
// TMDB cache dir, the same file (and the same trimmed row shape) main.js's
// `tmdb:personCredits` IPC handler writes, so an actor opened on the desktop is
// already cached for the phone and vice versa.

const path = require('path')
const tmdbFileCache = require('./tmdbCache')

// TMDB genre ids whose credits are, for a working actor, almost entirely
// appearances as themselves rather than roles: talk shows, news, reality.
const NOISE_GENRE_IDS = new Set([10767, 10763, 10764])
const DOCUMENTARY_GENRE_ID = 99
// Hard cap on cards (per kind). Ranked before it is cut, never cut by date alone.
const ACTOR_GAP_CAP = 60
// Billing position at or better than which a credit counts as a real part.
const ACTOR_GAP_MAX_ORDER = 12
// FLOOR drops obscurities; MAJOR rescues a big title he is billed low in;
// DOC keeps only notable documentaries (most are making-of featurettes).
const ACTOR_GAP_VOTES_FLOOR = 20
const ACTOR_GAP_VOTES_MAJOR = 1000
const ACTOR_GAP_VOTES_DOC = 200

const OVERVIEW_MAX = 300

// An appearance as themselves (chat show, awards night, archive clip).
function isSelfAppearance(character) {
  const ch = (character || '').trim().toLowerCase()
  if (!ch) return false
  if (/^(self|himself|herself|themself|themselves)\b/.test(ch)) return true
  if (ch.includes('archive footage') || ch.includes('archive sound')) return true
  return false
}

// Loose, punctuation-insensitive title key. Only ever used to spot library
// files TMDB never matched; never used to decide ownership on its own.
function looseTitleKey(t) {
  return (t || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/^(the|a|an) /, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// TMDB /person/{id}/combined_credits -> the trimmed rows kept on disk forever.
// Same shape main.js has always written, plus a short `overview` (additive; the
// desktop renderer ignores it, and rows cached before it existed simply lack it).
function trimPersonCredits(data) {
  return ((data && data.cast) || []).map((c) => ({
    id: c.id,
    mediaType: c.media_type,
    title: c.title || c.name || '',
    date: c.release_date || c.first_air_date || null,
    posterPath: c.poster_path || null,
    character: c.character || '',
    order: typeof c.order === 'number' ? c.order : null,
    voteCount: c.vote_count || 0,
    popularity: c.popularity || 0,
    genreIds: c.genre_ids || [],
    episodeCount: c.episode_count || null,
    overview: c.overview ? String(c.overview).slice(0, OVERVIEW_MAX) : null
  }))
}

// Same rules as the desktop's buildActorGaps (see the long comment there):
// own kind only, released, not "Self"/uncredited, not talk/news/reality, notable
// documentaries only, a real role unless the title is major, a vote floor; then
// ranked by notability, cut to the cap, and ordered newest first.
// `ownedIds` holds numbers; `unmatchedTitleKeys` holds looseTitleKey strings.
function buildActorGaps(credits, mediaType, ownedIds, unmatchedTitleKeys, today) {
  const day = today || new Date().toISOString().slice(0, 10)
  const owned = ownedIds || new Set()
  const unmatched = unmatchedTitleKeys || new Set()
  const best = new Map()
  for (const c of credits || []) {
    if (!c || c.mediaType !== mediaType || !c.id) continue
    if (!c.date || c.date > day) continue
    if (owned.has(c.id)) continue
    const character = c.character || ''
    if (isSelfAppearance(character)) continue
    if (character.toLowerCase().includes('uncredited')) continue
    const genres = c.genreIds || []
    if (genres.some((g) => NOISE_GENRE_IDS.has(g))) continue
    const votes = c.voteCount || 0
    if (genres.includes(DOCUMENTARY_GENRE_ID) && votes < ACTOR_GAP_VOTES_DOC) continue
    if (votes < ACTOR_GAP_VOTES_FLOOR) continue
    const order = typeof c.order === 'number' ? c.order : 99
    const realRole = order <= ACTOR_GAP_MAX_ORDER || (mediaType === 'tv' && (c.episodeCount || 0) >= 2)
    if (!realRole && votes < ACTOR_GAP_VOTES_MAJOR) continue
    const prev = best.get(c.id)
    if (!prev || order < (typeof prev.order === 'number' ? prev.order : 99)) best.set(c.id, c)
  }
  const ranked = Array.from(best.values()).map((c) => ({
    ...c,
    maybeOwned: unmatched.has(looseTitleKey(c.title)),
    score:
      (c.voteCount || 0) +
      (c.popularity || 0) * 10 +
      Math.max(0, 20 - (typeof c.order === 'number' ? c.order : 20)) * 50
  }))
  ranked.sort((a, b) => b.score - a.score)
  return ranked.slice(0, ACTOR_GAP_CAP).sort((a, b) => (b.date || '').localeCompare(a.date || ''))
}

// One gap row in the phone contract shape.
function phoneItem(c, kind) {
  const year = Number(String(c.date || '').slice(0, 4))
  return {
    tmdbId: c.id,
    kind,
    title: c.title || '',
    year: Number.isFinite(year) && year > 0 ? year : null,
    poster: c.posterPath ? `https://image.tmdb.org/t/p/w300${c.posterPath}` : null,
    voteCount: c.voteCount || 0,
    character: c.character || null,
    overview: c.overview || null
  }
}

// Films then shows, each ranked by buildActorGaps. A title that only loosely
// matches an unmatched library file (maybeOwned) is left out: the phone list is
// "what to get next", and suggesting something probably already on disk is worse
// than missing one suggestion.
function missingForPhone(credits, { ownedMovieIds, ownedTvIds, unmatchedMovieKeys, unmatchedTvKeys, today } = {}) {
  const movies = buildActorGaps(credits, 'movie', ownedMovieIds, unmatchedMovieKeys, today)
    .filter((c) => !c.maybeOwned)
    .map((c) => phoneItem(c, 'movie'))
  const tv = buildActorGaps(credits, 'tv', ownedTvIds, unmatchedTvKeys, today)
    .filter((c) => !c.maybeOwned)
    .map((c) => phoneItem(c, 'tv'))
  return movies.concat(tv)
}

// --- personCredits.json -------------------------------------------------------
function personCreditsFile(cacheDir) {
  return path.join(cacheDir, 'personCredits.json')
}

// Cached credits for one person, or null. Reads through tmdbCache's mtime-gated
// JSON cache, so a warm lookup costs one stat.
function readCachedPersonCredits(cacheDir, personId) {
  if (!cacheDir) return null
  const data = tmdbFileCache.readJsonCached
    ? tmdbFileCache.readJsonCached(personCreditsFile(cacheDir))
    : tmdbFileCache.readJson(personCreditsFile(cacheDir))
  const hit = data && data[String(personId)]
  return Array.isArray(hit) ? hit : null
}

// Adds one person to the file WITHOUT dropping anyone the desktop app (or an
// earlier call) wrote: re-read, merge, write.
function savePersonCredits(cacheDir, personId, credits) {
  if (!cacheDir || !Array.isArray(credits)) return false
  try {
    require('fs').mkdirSync(cacheDir, { recursive: true })
    const file = personCreditsFile(cacheDir)
    const data = { ...tmdbFileCache.readJson(file) }
    data[String(personId)] = credits
    tmdbFileCache.writeJson(file, data)
    return true
  } catch {
    return false
  }
}

module.exports = {
  NOISE_GENRE_IDS,
  DOCUMENTARY_GENRE_ID,
  ACTOR_GAP_CAP,
  ACTOR_GAP_MAX_ORDER,
  ACTOR_GAP_VOTES_FLOOR,
  ACTOR_GAP_VOTES_MAJOR,
  ACTOR_GAP_VOTES_DOC,
  isSelfAppearance,
  looseTitleKey,
  trimPersonCredits,
  buildActorGaps,
  missingForPhone,
  personCreditsFile,
  readCachedPersonCredits,
  savePersonCredits
}
