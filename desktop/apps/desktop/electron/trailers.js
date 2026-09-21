// YouTube trailers for the phone's ▶ poster button (GET /api/trailer).
//
// TMDB /movie/{id}/videos and /tv/{id}/videos list trailers, teasers, clips and
// featurettes on several sites. pickTrailer chooses one YouTube video; the
// cache keeps answers in trailers.json in the shared TMDB cache dir: a found
// trailer for 30 days, "no trailer" for one day (new titles get trailers late),
// and a failed lookup (offline, TMDB down) not at all.

const path = require('path')
const tmdbFileCache = require('./tmdbCache')

const FOUND_TTL_MS = 30 * 24 * 60 * 60 * 1000
const NONE_TTL_MS = 24 * 60 * 60 * 1000
const MAX_ENTRIES = 5000
// YouTube video ids are 11 characters today; allow a little slack, nothing else.
const YOUTUBE_KEY_RE = /^[A-Za-z0-9_-]{6,20}$/

const TYPE_RANK = { Trailer: 0, Teaser: 1 }
const OTHER_LANGUAGES = 'es,fr,de,it,pt,ja,ko,zh,hi,ru,nl,sv,da,no,fi,pl,tr,th,id,ta,te,ml,ar,he,cs,hu,el,uk,null'

// Best YouTube Trailer, then Teaser. Within a type: official first, English
// first, then the newest. Anything that is not a trailer or teaser (clips,
// featurettes, behind the scenes) is never picked.
function pickTrailer(results) {
  const rows = (Array.isArray(results) ? results : []).filter(
    (v) =>
      v &&
      String(v.site || '').toLowerCase() === 'youtube' &&
      Object.prototype.hasOwnProperty.call(TYPE_RANK, v.type) &&
      YOUTUBE_KEY_RE.test(String(v.key || ''))
  )
  if (!rows.length) return null
  rows.sort((a, b) => {
    const t = TYPE_RANK[a.type] - TYPE_RANK[b.type]
    if (t) return t
    const o = (b.official ? 1 : 0) - (a.official ? 1 : 0)
    if (o) return o
    const l = (b.iso_639_1 === 'en' ? 1 : 0) - (a.iso_639_1 === 'en' ? 1 : 0)
    if (l) return l
    return String(b.published_at || '').localeCompare(String(a.published_at || ''))
  })
  return { youtubeKey: String(rows[0].key), name: rows[0].name ? String(rows[0].name) : null }
}

function trailersFile(cacheDir) {
  return path.join(cacheDir, 'trailers.json')
}

// kind 'movie' | 'tv', id a positive integer.
function createTrailerCache({ getCacheDir, now = () => Date.now() } = {}) {
  const mem = new Map() // 'movie:123' -> { key, name, at }
  let loadedFrom = null

  function load() {
    const dir = getCacheDir ? getCacheDir() : null
    if (!dir || loadedFrom === dir) return dir
    loadedFrom = dir
    const data = tmdbFileCache.readJson(trailersFile(dir))
    for (const [k, v] of Object.entries(data || {})) {
      if (v && typeof v.at === 'number' && !mem.has(k)) mem.set(k, v)
    }
    return dir
  }

  function get(kind, id) {
    load()
    const k = `${kind}:${id}`
    const hit = mem.get(k)
    if (!hit) return undefined
    const ttl = hit.key ? FOUND_TTL_MS : NONE_TTL_MS
    if (now() - hit.at > ttl) {
      mem.delete(k)
      return undefined
    }
    return hit.key ? { youtubeKey: hit.key, name: hit.name || null } : null
  }

  function set(kind, id, picked) {
    const dir = load()
    const k = `${kind}:${id}`
    mem.delete(k)
    mem.set(k, { key: picked ? picked.youtubeKey : null, name: picked ? picked.name : null, at: now() })
    while (mem.size > MAX_ENTRIES) mem.delete(mem.keys().next().value)
    if (!dir) return
    try {
      require('fs').mkdirSync(dir, { recursive: true })
      tmdbFileCache.writeJson(trailersFile(dir), Object.fromEntries(mem))
    } catch {
      // a failed write only means a repeat lookup later
    }
  }

  return { get, set }
}

// Looks one title up. `api` is titleMatch.createTmdbApi(key).
// Returns { youtubeKey, name } | null (TMDB has none) | undefined (lookup failed).
async function fetchTrailer(api, kind, id) {
  if (!api) return undefined
  const base = (kind === 'tv' ? '/tv/' : '/movie/') + encodeURIComponent(id) + '/videos'
  // English (and language-less) videos first — what nearly every viewer wants.
  const first = await api.get(base, { language: 'en-US', include_video_language: 'en,null' })
  if (!first.ok) return first.status === 404 ? null : undefined
  const picked = pickTrailer(first.data && first.data.results)
  if (picked) return picked
  // Nothing in English: take a trailer in another language rather than none.
  // TMDB has no "every language" switch, so name the common ones.
  const any = await api.get(base, { include_video_language: OTHER_LANGUAGES })
  if (!any.ok) return null
  return pickTrailer(any.data && any.data.results)
}

module.exports = { pickTrailer, createTrailerCache, fetchTrailer, trailersFile, FOUND_TTL_MS, NONE_TTL_MS, YOUTUBE_KEY_RE }
