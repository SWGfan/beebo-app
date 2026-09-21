'use strict'
// Matching imported items to the Beebo library.
//
// Order of trust, strongest first:
//   1. provider ids (tmdb, then imdb, then tvdb)     -> matched
//   2. the source's own file name equals a library file name (a copied library)  -> matched
//   3. title + year                                    -> matched when exactly one library title
//                                                         fits, "ambiguous" when several do
//   4. title alone (no year on one side), or a close but inexact title            -> ambiguous
//   5. otherwise                                       -> unmatched (most often: not in this library)
//
// Two safety rules keep a wrong title from ever being matched silently:
//   - an id conflict beats a name match: if both sides carry a tmdb id and they differ, the titles
//     are different films no matter how alike the names are (remakes share names);
//   - only "matched" is applied without a person looking at it. Ambiguous and unmatched items are
//     shown in the review screen and skipped unless the person picks one.
//
// The library comes in as the same flat item list playlists use (playlistCatalog.buildCatalog):
//   movie:   { type:'movie', id, key:'movie:<fileName>', fileName, title, year, tmdbId, imdbId?, tvdbId? }
//   episode: { type:'episode', id, key:'tv:<relPath>', fileName (relPath), showKey, showName, year,
//              season, episode, tmdbId (the show's), imdbId?, tvdbId? }

const titleMatch = require('../titleMatch')

const TOKEN_BUCKET_MAX = 300
const FUZZY_POOL_MAX = 600
const FUZZY_MIN = 0.78

// Accents are folded first ("Amélie" and "Amelie" are the same title); titleMatch then lowers the
// case, drops punctuation and reads roman / spelled numbers, and a leading article is dropped.
const fold = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '')
const norm = (s) => titleMatch.normalizeTitle(fold(s)).replace(/^(?:the|a|an)\s+/, '')
const baseName = (s) => String(s || '').replace(/\\/g, '/').split('/').pop().replace(/\.[A-Za-z0-9]{2,4}$/, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const tokensOf = (n) => n.split(' ').filter((t) => t.length > 1)
const strId = (v) => (v === null || v === undefined || v === '' ? '' : String(v))

function pushMap(map, key, value) {
  if (!key) return
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

/** Builds the lookups once per import. `catalog` may include tracks; they are ignored. */
function buildLibraryIndex(catalog) {
  const idx = {
    movies: [],
    byTmdb: new Map(), byImdb: new Map(), byTvdb: new Map(), byTitle: new Map(), byFile: new Map(), tokens: new Map(),
    shows: new Map(), showByTmdb: new Map(), showByImdb: new Map(), showByTvdb: new Map(), showByTitle: new Map(), showTokens: new Map(),
    episodeByFile: new Map(),
    byKey: new Map()
  }
  for (const it of Array.isArray(catalog) ? catalog : []) {
    if (!it || !it.key) continue
    if (it.type === 'movie') {
      const e = {
        type: 'movie', key: it.key, id: it.id, fileName: it.fileName, title: it.title || it.fileName, year: it.year || null,
        tmdb: strId(it.tmdbId), imdb: strId(it.imdbId).toLowerCase(), tvdb: strId(it.tvdbId), norm: norm(it.title || ''), durationSeconds: it.durationSeconds || null
      }
      idx.movies.push(e)
      idx.byKey.set(e.key, e)
      pushMap(idx.byTmdb, e.tmdb, e)
      pushMap(idx.byImdb, e.imdb, e)
      pushMap(idx.byTvdb, e.tvdb, e)
      pushMap(idx.byTitle, e.norm, e)
      pushMap(idx.byFile, baseName(it.fileName), e)
      for (const t of tokensOf(e.norm)) pushMap(idx.tokens, t, e)
    } else if (it.type === 'episode') {
      const sk = it.showKey || norm(it.showName || '')
      if (!sk) continue
      let show = idx.shows.get(sk)
      if (!show) {
        show = {
          type: 'show', showKey: sk, title: it.showName || 'Show', year: it.year || null,
          tmdb: strId(it.tmdbId), imdb: strId(it.imdbId).toLowerCase(), tvdb: strId(it.tvdbId), norm: norm(it.showName || ''), episodes: new Map(), count: 0
        }
        idx.shows.set(sk, show)
        pushMap(idx.showByTmdb, show.tmdb, show)
        pushMap(idx.showByImdb, show.imdb, show)
        pushMap(idx.showByTvdb, show.tvdb, show)
        pushMap(idx.showByTitle, show.norm, show)
        for (const t of tokensOf(show.norm)) pushMap(idx.showTokens, t, show)
      }
      const ep = {
        type: 'episode', key: it.key, id: it.id, fileName: it.fileName, title: it.title, showKey: sk, showTitle: show.title,
        season: it.season, episode: it.episode, year: show.year, durationSeconds: it.durationSeconds || null
      }
      show.count++
      idx.byKey.set(ep.key, ep)
      if (Number.isInteger(ep.season) && Number.isInteger(ep.episode)) {
        const k = ep.season + 'x' + ep.episode
        // Two files for one episode (a duplicate copy): the first by name stays the target.
        if (!show.episodes.has(k) || String(ep.fileName) < String(show.episodes.get(k).fileName)) show.episodes.set(k, ep)
      }
      pushMap(idx.episodeByFile, baseName(it.fileName), ep)
    }
  }
  return idx
}

// ---- targets (what the review screen and the apply step see) -----------------------------------
const targetOfMovie = (e) => ({ type: 'movie', key: e.key, id: e.id, fileName: e.fileName, title: e.title, year: e.year, durationSeconds: e.durationSeconds })
const targetOfEpisode = (e) => ({
  type: 'episode', key: e.key, id: e.id, fileName: e.fileName, showKey: e.showKey, title: e.showTitle + (Number.isInteger(e.season) ? ' S' + String(e.season).padStart(2, '0') + 'E' + String(e.episode).padStart(2, '0') : ''),
  showTitle: e.showTitle, season: e.season, episode: e.episode, year: e.year, durationSeconds: e.durationSeconds
})
const targetOfShow = (s) => ({ type: 'show', key: 'show:' + s.showKey, showKey: s.showKey, title: s.title, year: s.year })

const res = (status, method, target, candidates, reason) => ({ status, method, target: target || null, candidates: candidates || [], reason: reason || '' })

const yearsCompatible = (a, b) => !a || !b || Math.abs(a - b) <= 1

function idConflict(item, e) {
  const t = item.ids || {}
  if (t.tmdb && e.tmdb && t.tmdb !== e.tmdb) return true
  if (t.imdb && e.imdb && t.imdb !== e.imdb) return true
  return false
}

const byName = (a, b) => (String(a.fileName || a.title) < String(b.fileName || b.title) ? -1 : 1)

// ---- movies ------------------------------------------------------------------------------------
function matchMovie(item, idx) {
  const ids = item.ids || {}
  for (const [name, map] of [['tmdb', idx.byTmdb], ['imdb', idx.byImdb], ['tvdb', idx.byTvdb]]) {
    const hits = ids[name] ? map.get(ids[name]) : null
    if (hits && hits.length) {
      const sorted = hits.slice().sort(byName)
      const r = res('matched', name, targetOfMovie(sorted[0]))
      if (sorted.length > 1) r.alsoMatches = sorted.length - 1
      return r
    }
  }
  if (item.fileHint) {
    const hits = idx.byFile.get(baseName(item.fileHint))
    const ok = hits && hits.filter((e) => !idConflict(item, e))
    if (ok && ok.length === 1) return res('matched', 'filename', targetOfMovie(ok[0]))
  }
  const n = norm(item.title)
  if (!n) return res('unmatched', '', null, [], 'no_title')
  const exact = (idx.byTitle.get(n) || []).filter((e) => !idConflict(item, e))
  if (exact.length) {
    const sameYear = item.year ? exact.filter((e) => e.year === item.year) : []
    if (sameYear.length === 1) return res('matched', 'title-year', targetOfMovie(sameYear[0]))
    if (sameYear.length > 1) return res('ambiguous', 'title-year', null, sameYear.sort(byName).slice(0, 6).map(targetOfMovie), 'several_files')
    const close = item.year ? exact.filter((e) => yearsCompatible(item.year, e.year) && e.year) : []
    if (close.length === 1) return res('matched', 'title-year-close', targetOfMovie(close[0]))
    if (close.length > 1) return res('ambiguous', 'title-year-close', null, close.sort(byName).slice(0, 6).map(targetOfMovie), 'several_files')
    // Same name, but the years disagree by more than a year (or one side has none).
    const unknownYear = exact.filter((e) => !item.year || !e.year)
    if (unknownYear.length) return res('ambiguous', 'title-only', null, unknownYear.sort(byName).slice(0, 6).map(targetOfMovie), 'no_year')
    return res('unmatched', '', null, exact.sort(byName).slice(0, 3).map(targetOfMovie), 'different_year')
  }
  const fuzzy = fuzzyMovies(n, item, idx)
  if (fuzzy.length) return res('ambiguous', 'similar-title', null, fuzzy.map(targetOfMovie), 'similar')
  return res('unmatched', '', null, [], 'not_in_library')
}

function fuzzyPool(n, tokenMap, limit) {
  const pool = new Set()
  for (const t of tokensOf(n)) {
    const bucket = tokenMap.get(t)
    if (!bucket || bucket.length > TOKEN_BUCKET_MAX) continue
    for (const e of bucket) {
      pool.add(e)
      if (pool.size >= limit) return pool
    }
  }
  return pool
}

function fuzzyMovies(n, item, idx) {
  const out = []
  for (const e of fuzzyPool(n, idx.tokens, FUZZY_POOL_MAX)) {
    if (idConflict(item, e) || !yearsCompatible(item.year, e.year)) continue
    const score = titleMatch.diceOverlap(n, e.norm)
    if (score >= FUZZY_MIN) out.push({ e, score })
  }
  return out.sort((a, b) => b.score - a.score || byName(a.e, b.e)).slice(0, 5).map((x) => x.e)
}

// ---- shows and episodes ------------------------------------------------------------------------
function findShows(show, idx) {
  const ids = (show && show.ids) || {}
  for (const [name, map] of [['tmdb', idx.showByTmdb], ['imdb', idx.showByImdb], ['tvdb', idx.showByTvdb]]) {
    const hits = ids[name] ? map.get(ids[name]) : null
    if (hits && hits.length) return { method: name, shows: hits.slice(), certain: true }
  }
  const n = norm(show && show.title)
  if (!n) return { method: '', shows: [], certain: false }
  const exact = (idx.showByTitle.get(n) || []).filter((s) => !idConflict({ ids }, s))
  if (exact.length) {
    const withYear = show.year ? exact.filter((s) => !s.year || Math.abs(s.year - show.year) <= 1) : exact
    const use = withYear.length ? withYear : exact
    return { method: 'title', shows: use, certain: use.length === 1 && (!show.year || !use[0].year || Math.abs(use[0].year - show.year) <= 1) }
  }
  const fuzzy = []
  for (const s of fuzzyPool(n, idx.showTokens, FUZZY_POOL_MAX)) {
    if (idConflict({ ids }, s) || !yearsCompatible(show.year, s.year)) continue
    const score = titleMatch.diceOverlap(n, s.norm)
    if (score >= 0.85) fuzzy.push({ s, score })
  }
  fuzzy.sort((a, b) => b.score - a.score)
  return { method: 'similar-title', shows: fuzzy.slice(0, 4).map((x) => x.s), certain: false }
}

function matchEpisode(item, idx) {
  if (item.fileHint) {
    const hits = idx.episodeByFile.get(baseName(item.fileHint))
    if (hits && hits.length === 1) return res('matched', 'filename', targetOfEpisode(hits[0]))
  }
  const found = findShows(item.show, idx)
  if (!found.shows.length) return res('unmatched', '', null, [], 'show_not_in_library')
  const hasNumbers = Number.isInteger(item.season) && Number.isInteger(item.episode)
  if (!hasNumbers) return res('unmatched', '', null, [], 'no_episode_number')
  const k = item.season + 'x' + item.episode
  const eps = found.shows.map((s) => s.episodes.get(k)).filter(Boolean)
  if (found.certain && found.shows.length === 1) {
    return eps.length ? res('matched', found.method, targetOfEpisode(eps[0])) : res('unmatched', '', null, [], 'episode_not_in_library')
  }
  if (!eps.length) return res('unmatched', '', null, [], 'episode_not_in_library')
  return res('ambiguous', found.method, null, eps.slice(0, 6).map(targetOfEpisode), 'show_unsure')
}

function matchShow(item, idx) {
  const found = findShows({ title: item.title, year: item.year, ids: item.ids }, idx)
  if (!found.shows.length) return res('unmatched', '', null, [], 'not_in_library')
  if (found.certain && found.shows.length === 1) return res('matched', found.method, targetOfShow(found.shows[0]))
  return res('ambiguous', found.method, null, found.shows.slice(0, 6).map(targetOfShow), 'show_unsure')
}

function matchItem(item, idx) {
  if (item.type === 'episode') return matchEpisode(item, idx)
  if (item.type === 'show') return matchShow(item, idx)
  return matchMovie(item, idx)
}

/** Free-text search of the library, for the review screen's "pick the right title". */
function searchLibrary(idx, query, type, limit = 12) {
  const n = norm(query)
  if (!n) return []
  const scored = []
  const consider = (e, t) => {
    const s = e.norm === n ? 2 : e.norm.includes(n) || n.includes(e.norm) ? 1 + titleMatch.diceOverlap(n, e.norm) : titleMatch.diceOverlap(n, e.norm)
    if (s >= 0.5) scored.push({ s, e, t })
  }
  if (type === 'movie' || !type) for (const e of fuzzyPool(n, idx.tokens, 2000)) consider(e, targetOfMovie)
  if (type === 'show' || type === 'episode' || !type) for (const e of fuzzyPool(n, idx.showTokens, 2000)) consider(e, targetOfShow)
  return scored.sort((a, b) => b.s - a.s).slice(0, limit).map((x) => x.t(x.e))
}

/** Every episode of a show as targets, so a person can pick the exact one after choosing a show. */
function episodesOfShow(idx, showKey, limit = 400) {
  const show = idx.shows.get(showKey)
  if (!show) return []
  return [...show.episodes.values()]
    .sort((a, b) => a.season - b.season || a.episode - b.episode)
    .slice(0, limit)
    .map(targetOfEpisode)
}

module.exports = { buildLibraryIndex, matchItem, matchMovie, matchEpisode, matchShow, searchLibrary, episodesOfShow, targetOfMovie, targetOfEpisode, targetOfShow, norm }
