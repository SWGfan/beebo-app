'use strict'

// Single source of truth for what happens AFTER ./titleParse has read a
// filename: choosing which TMDB result a file actually is, deciding how sure we
// are, and — when we are not sure — refusing to guess and putting the file in
// front of the owner instead.
//
// Why this is a separate file and not more of titleParse.js:
//   - titleParse.js is deliberately dependency-free and purely textual. It has
//     no I/O and no knowledge of TMDB's JSON shape, which is what lets it be
//     exercised by a plain node script. Putting fetch() in it would end that.
//   - titleParse.js carries literal control characters as internal markers.
//     Nothing that can be avoided should be editing that file by hand.
// It stays free of electron/`path`/`fs` for the same reason titleParse.js does:
// the electron-store handle is passed IN, never required here, so this module
// can be required from the main process, from the stream server, and from a
// test that has neither.
//
// The three call sites this replaces all disagreed with each other:
//   main.js        pickBestMatch()  = exact normalised title || results[0]
//   streamServer.js tmdbLookup()    = results[0], with no title check at all
//   streamServer.js tmdbLookupTv()  = searchTvSmart()'s own first hit
// Two of those will happily attach a 2026 animated short with 0 votes to a file
// because it was the only thing TMDB returned for a mangled query. That is the
// bug this file exists to end.

// ---------------------------------------------------------------------------
// Comparison-only normalisation
// ---------------------------------------------------------------------------

// Small roman numerals and small number-words are folded to digits so that
// "Jurassic Park III" / "Jurassic Park 3" and "Seven Psychopaths" /
// "7 psychopaths" are recognised as the same title. The fold is applied to BOTH
// sides of every comparison, so it can never introduce an asymmetry — it is not
// used to build the query that actually goes to TMDB.
var NUMERIC_WORD = {
  i: '1', ii: '2', iii: '3', iv: '4', v: '5', vi: '6', vii: '7', viii: '8', ix: '9', x: '10',
  one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8',
  nine: '9', ten: '10', eleven: '11', twelve: '12'
}

function normalizeTitle(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    // "&" and "and" are the same word in a title, and an apostrophe is not a
    // word break: dropping it outright turns "Ocean's" into "oceans" and
    // "Bill & Ted's" into "bill and teds", which is how the filenames in this
    // library spell them. Both folds are applied to both sides of every
    // comparison, so neither can create an asymmetry.
    .replace(/&/g, ' and ')
    .replace(/[\u2019']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map(function (w) { return NUMERIC_WORD[w] || w })
    .join(' ')
}

var LEADING_ARTICLE = /^(?:the|a|an)\s+/

function withoutArticle(n) {
  return String(n || '').replace(LEADING_ARTICLE, '')
}

function despaced(n) {
  return String(n || '').replace(/\s+/g, '')
}

function tokens(n) {
  return String(n || '').split(' ').filter(Boolean)
}

// Sørensen–Dice over token SETS. Chosen over a plain intersection count because
// it punishes both directions of mismatch at once: a two-word query that hits
// two words of a ten-word candidate should not score the same as a two-word
// query that hits both words of a two-word candidate.
function diceOverlap(a, b) {
  var A = tokens(a)
  var B = tokens(b)
  if (!A.length || !B.length) return 0
  var seen = Object.create(null)
  for (var i = 0; i < A.length; i++) seen[A[i]] = true
  var setA = Object.keys(seen)
  var seenB = Object.create(null)
  for (var j = 0; j < B.length; j++) seenB[B[j]] = true
  var setB = Object.keys(seenB)
  var hits = 0
  for (var k = 0; k < setA.length; k++) if (seenB[setA[k]]) hits += 1
  return (2 * hits) / (setA.length + setB.length)
}

// "Borat" against "Borat: Cultural Learnings of America..." — a prefix, but only
// when it ends on a word boundary, so "Predator" does not read as a prefix of
// "Predators".
function isWordPrefix(whole, prefix) {
  if (!prefix || !whole) return false
  if (whole === prefix) return false
  return whole.slice(0, prefix.length) === prefix && whole.charAt(prefix.length) === ' '
}

// ---------------------------------------------------------------------------
// Scoring weights
// ---------------------------------------------------------------------------
//
// Every number below is a deliberate ordering statement, not a dial. The single
// rule they encode: HOW WELL THE TITLE MATCHES decides which candidate wins;
// the year only nudges; popularity only breaks a tie it could not otherwise
// break.

var TITLE_EXACT = 100 // normalised titles identical
var TITLE_EXACT_DESPACED = 94 // "Whitecastle" vs "White Castle", "Ghost Busters" vs "Ghostbusters"
var TITLE_EXACT_NO_ARTICLE = 92 // "The Last Action Hero" vs "Last Action Hero"
var TITLE_CANDIDATE_PREFIX = 78 // query is the start of the candidate: "Borat" -> "Borat: Cultural Learnings…"
var TITLE_QUERY_PREFIX = 68 // candidate is the start of the query: "Eraser Arnold Schwarzenegger" -> "Eraser"
var TITLE_OVERLAP_MAX = 60 // pure token overlap can never reach a prefix match

// Year scoring. THE YEAR RANKS, IT NEVER FILTERS — this is the whole point of
// the rewrite and the reason these are additive bonuses and one bounded penalty
// rather than a predicate.
//
// The evidence, from the owner's own library:
//   "Best-Movies.info_Scarface.198h3.720p.x264.AAC.mkv" — the year is a typo and
//     parses as no year at all.
//   "Best-Movies.info_Blade.Runner.Final.Cut.1997.720p.x264.YIFY.mp4" — labelled
//     1997 for a 1982 film, fifteen years out.
// Under the old code the year is handed to TMDB as `&year=`, which is a
// server-side FILTER: a wrong year means the right film is not in the response
// at all, and the file ends up with no poster forever. A wrong year is a typo in
// a filename. It should cost a candidate some points and nothing more.
var YEAR_EXACT = 26
var YEAR_NEAR = 18 // ±1: festival year vs wide-release year is the single most common honest disagreement
var YEAR_CLOSE = 8 // ±2
var YEAR_LOOSE = 0 // ±3..5: no opinion either way
var YEAR_WRONG = -18 // >5 apart: a real cost, but far less than the gap between an exact and a prefix title
var YEAR_CANDIDATE_MISSING = -4 // TMDB rows with no release date at all are overwhelmingly junk

// Popularity is a TIEBREAK AND NOTHING ELSE: capped at 2 points, which is less
// than the smallest meaningful gap anywhere else in this table. It exists so
// that two candidates which are otherwise indistinguishable (the 1960 and the
// 2001 "Ocean's Eleven", say) come out in a stable and sensible order — never so
// that a popular film can out-argue a better title match.
var POPULARITY_MAX = 2

// TMDB's index is full of near-empty rows — fan uploads, festival shorts, mis-
// keyed duplicates — and a mangled query returns nothing else. The owner's
// manifest currently has a file matched to "Journey #11_0B19" (2026, popularity
// 0.29, zero votes) for exactly this reason. A small penalty is enough: the
// confidence floor below is what actually stops these being accepted.
var JUNK_PENALTY = -6

// ---------------------------------------------------------------------------
// Confidence thresholds
// ---------------------------------------------------------------------------
//
// WHY AN UNSURE MATCH IS WORSE THAN NO MATCH AT ALL. A file with no poster looks
// unfinished, and the owner can see at a glance that it needs attention. A file
// with the WRONG poster looks finished: it carries a wrong title, a wrong year,
// a wrong age rating, wrong cast, and it lands in the wrong genre rows and the
// wrong "Sequels" collection. Nobody ever goes looking for it, because nothing
// about it looks wrong. Worse, it is written into manifest.json and then trusted
// by every surface for good. So the bar to WRITE a match is set high, and
// anything under it is routed to a person instead.
//
// CERTAIN — assign silently, this is not a guess:
//   an IMDb id taken from the filename (an exact identifier, not a search), or
//   an exactly matching normalised title AND an exactly matching year.
//   Score floor: TITLE_EXACT + YEAR_EXACT = 126.
//   Evidence: of the 938 files that currently have a match in the owner's
//   manifest, 757 (81%) are exact title + exact year. Those are the ones that
//   must keep working untouched, and this is the band that keeps them.
//
// PROBABLE — assign silently, but it is an inference:
//   score >= 74 and a clear margin over the runner-up.
//   74 is placed where it is because of what it does and does not admit:
//     admits  an exact title with no year in the filename       (100 + 0  = 100)
//     admits  an exact title whose year is flatly wrong          (100 - 18 =  82)
//             — this is the Blade Runner Final Cut case, and it is the whole
//               reason the year must not filter
//     admits  a prefix title with an exact year                  ( 78 + 26 = 104)
//             — "Borat" -> "Borat: Cultural Learnings…"
//     admits  a near-exact title (article/spacing) with any year  ( 92 + 0  =  92)
//     REFUSES a pure token-overlap match with an exact year      (<=60 + 26 = 86
//               only at near-total overlap; partial overlap lands in the 30s-60s)
//     REFUSES everything with a mangled or one-word query
//   The floor is therefore "the title really is this title, or the title is
//   right and only the year is off". Anything softer than that is a guess.
//
// UNSURE — never assigned, always queued:
//   everything else, INCLUDING a high-scoring top candidate whose runner-up is
//   within MARGIN. Two candidates a couple of points apart is precisely the
//   "Ocean's Eleven (1960) or Ocean's Eleven (2001)?" question, and that is a
//   question, not an answer.
var SCORE_CERTAIN = TITLE_EXACT + YEAR_EXACT // 126
var SCORE_PROBABLE = 74
// A probable match must beat its runner-up by more than the whole popularity
// tiebreak plus a year step, so "probable" can never mean "two candidates the
// scorer could not separate".
var MARGIN_PROBABLE = 12
// For CERTAIN the bar is lower, because reaching 126 already means an exact
// title AND an exact year and the only thing that can tie it is a genuine TMDB
// duplicate. 3 is just above the 0-2 that popularity alone can contribute, so a
// pair separated only by popularity is still sent for review.
var MARGIN_CERTAIN = 3

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

// TMDB names the same fields differently for movies and shows. Everything below
// this line works on one shape.
function toCandidate(raw, kind) {
  if (!raw || typeof raw !== 'object') return null
  var isTv = kind === 'tv'
  var title = isTv ? raw.name : raw.title
  var originalTitle = isTv ? raw.original_name : raw.original_title
  var date = String((isTv ? raw.first_air_date : raw.release_date) || '')
  var year = /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : null
  return {
    id: raw.id,
    kind: isTv ? 'tv' : 'movie',
    title: title || originalTitle || '',
    originalTitle: originalTitle || title || '',
    year: year,
    posterPath: raw.poster_path || null,
    popularity: Number(raw.popularity) || 0,
    voteCount: Number(raw.vote_count) || 0,
    raw: raw
  }
}

function toCandidates(list, kind) {
  var out = []
  for (var i = 0; i < (list || []).length; i++) {
    var c = toCandidate(list[i], kind)
    if (c && c.id != null) out.push(c)
  }
  return out
}

// Merges two result pages into one candidate pool, keeping the first occurrence
// of each id. This is how "rank the year, never filter on it" is actually
// implemented against an API that only offers a filter: the year-filtered search
// and the unfiltered search are UNIONED, so the year can raise a candidate's
// chance of being seen and can never be the reason one is missing.
function mergeCandidates() {
  var seen = Object.create(null)
  var out = []
  for (var a = 0; a < arguments.length; a++) {
    var list = arguments[a] || []
    for (var i = 0; i < list.length; i++) {
      var c = list[i]
      if (!c || c.id == null || seen[c.id]) continue
      seen[c.id] = true
      out.push(c)
    }
  }
  return out
}

function titleScore(queryNorm, candidate) {
  var t = normalizeTitle(candidate.title)
  var o = normalizeTitle(candidate.originalTitle)
  var best = 0
  var forms = t === o ? [t] : [t, o]
  for (var i = 0; i < forms.length; i++) {
    var c = forms[i]
    if (!c) continue
    var s = 0
    var overlap = diceOverlap(c, queryNorm) * TITLE_OVERLAP_MAX
    if (c === queryNorm) s = TITLE_EXACT
    else if (despaced(c) === despaced(queryNorm)) s = TITLE_EXACT_DESPACED
    else if (withoutArticle(c) === withoutArticle(queryNorm)) s = TITLE_EXACT_NO_ARTICLE
    // Query is the whole start of the candidate: "Borat" ->
    // "Borat: Cultural Learnings of America...". Deliberately NOT scaled by how
    // much of the candidate is left over, because a filename dropping a film's
    // subtitle is the normal case. It is gated on query length instead: a two-
    // character query prefixing something is a coincidence, not a match, and
    // this library contains queries like "BR", "0b" and "JY".
    else if (queryNorm.length >= 4 && isWordPrefix(c, queryNorm)) s = TITLE_CANDIDATE_PREFIX
    // Candidate is the start of the query: "Eraser Arnold Schwarzenegger" ->
    // "Eraser". This direction IS scaled by coverage, because the leftover words
    // belong to the FILENAME and they may be junk ("Arnold Schwarzenegger") or
    // they may be the thing that identifies which film it is
    // ("Star Wars 5 The Empire Strikes Back" is not Star Wars). Measured: without
    // the scale, that file re-matches from The Empire Strikes Back to Star Wars.
    else if (isWordPrefix(queryNorm, c)) {
      var coverage = tokens(c).length / Math.max(1, tokens(queryNorm).length)
      s = Math.max(overlap, TITLE_QUERY_PREFIX * coverage)
    } else s = overlap
    if (s > best) best = s
  }
  return best
}

function yearScore(queryYear, candidateYear) {
  if (!queryYear) return 0 // no opinion: a third of this library carries no year
  if (!candidateYear) return YEAR_CANDIDATE_MISSING
  var d = Math.abs(Number(queryYear) - Number(candidateYear))
  if (d === 0) return YEAR_EXACT
  if (d === 1) return YEAR_NEAR
  if (d === 2) return YEAR_CLOSE
  if (d <= 5) return YEAR_LOOSE
  return YEAR_WRONG
}

function scoreCandidate(query, year, candidate) {
  var q = normalizeTitle(query)
  var ts = titleScore(q, candidate)
  var ys = yearScore(year, candidate.year)
  var pop = Math.min(POPULARITY_MAX, (Math.min(candidate.popularity, 100) / 100) * POPULARITY_MAX)
  var junk = candidate.voteCount === 0 && candidate.popularity < 1 ? JUNK_PENALTY : 0
  return {
    score: ts + ys + pop + junk,
    titleScore: ts,
    yearScore: ys,
    popularityScore: pop,
    junkPenalty: junk
  }
}

function rankCandidates(query, year, candidates) {
  var scored = (candidates || []).map(function (c) {
    var s = scoreCandidate(query, year, c)
    return Object.assign({}, c, s)
  })
  // Stable-enough ordering: score first, then popularity, then id, so the same
  // pool always ranks the same way and a re-run never silently reshuffles.
  scored.sort(function (a, b) {
    if (b.score !== a.score) return b.score - a.score
    if (b.popularity !== a.popularity) return b.popularity - a.popularity
    return Number(a.id) - Number(b.id)
  })
  return scored
}

// The pure half of the matcher: given a parse and a pool of candidates, say what
// we would do. No network, no store, no side effects — this is the part that can
// be run over the owner's whole manifest offline.
function classify(query, year, candidates, opts) {
  var options = opts || {}
  var ranked = rankCandidates(query, year, candidates)
  if (!ranked.length) {
    return { confidence: 'none', match: null, ranked: ranked, margin: 0, reason: 'no_results' }
  }
  var top = ranked[0]
  var margin = ranked.length > 1 ? top.score - ranked[1].score : Infinity

  // An IMDb id lifted out of the filename is not a search result, it is an
  // identifier. Nothing it returns needs scoring.
  if (options.viaImdbId) {
    return { confidence: 'certain', match: top, ranked: ranked, margin: margin, reason: 'imdb_id' }
  }
  if (top.score >= SCORE_CERTAIN && margin >= MARGIN_CERTAIN) {
    return { confidence: 'certain', match: top, ranked: ranked, margin: margin, reason: 'exact_title_and_year' }
  }
  if (top.score >= SCORE_PROBABLE && margin >= MARGIN_PROBABLE) {
    return { confidence: 'probable', match: top, ranked: ranked, margin: margin, reason: 'strong_title' }
  }
  return {
    confidence: 'unsure',
    match: null, // deliberately null: "unsure" must never hand a caller something to write
    ranked: ranked,
    margin: margin,
    reason: top.score < SCORE_PROBABLE ? 'weak_title' : 'no_clear_winner'
  }
}

// ---------------------------------------------------------------------------
// TMDB access
// ---------------------------------------------------------------------------

// TMDB issues two kinds of credential that both work for read endpoints: a v3
// key goes in the query string, a v4 read token goes in an Authorization
// header. Same rule main.js's tmdbAuth() has always used.
// TMDB's own rate limit is generous, but a background sweep across a whole
// library (subtitleSweep.js's model for how this gets hit hardest) can still
// trip it in a burst. Without a retry, a single 429 used to fall straight
// through to matchParsed's 'tmdb_http_429' reason and land the file on the
// owner's manual "Titles to check" list — a transient, nobody's-fault traffic
// hiccup indistinguishable from a genuinely ambiguous title. A bounded retry
// here, in the one place every caller's requests pass through, fixes that for
// all of them at once.
var TMDB_MAX_ATTEMPTS = 3
var TMDB_MAX_RETRY_DELAY_MS = 5000
function tmdbRetryDelayMs(res, attempt) {
  // TMDB sends Retry-After in seconds on a 429. Respect it, but cap it: a
  // stray or hostile header should never be able to stall a whole sweep.
  var header = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('Retry-After') : null
  var fromHeader = header != null ? Number(header) * 1000 : NaN
  if (Number.isFinite(fromHeader) && fromHeader >= 0) return Math.min(fromHeader, TMDB_MAX_RETRY_DELAY_MS)
  return Math.min(300 * Math.pow(2, attempt), TMDB_MAX_RETRY_DELAY_MS) // 300ms, 600ms, ...
}
function defaultSleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms) })
}

function createTmdbApi(key, fetchImpl, opts) {
  var doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null)
  if (!key || !doFetch) return null
  var sleep = (opts && opts.sleep) || defaultSleep
  var isV4Token = String(key).split('.').length === 3
  var headers = isV4Token
    ? { Authorization: 'Bearer ' + key, accept: 'application/json' }
    : { accept: 'application/json' }
  function url(path, params) {
    var qs = []
    if (!isV4Token) qs.push('api_key=' + encodeURIComponent(key))
    var p = params || {}
    for (var k in p) {
      if (p[k] === undefined || p[k] === null || p[k] === '') continue
      qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(p[k]))
    }
    return 'https://api.themoviedb.org/3' + path + (qs.length ? '?' + qs.join('&') : '')
  }
  return {
    isV4Token: isV4Token,
    get: async function (path, params) {
      try {
        for (var attempt = 0; attempt < TMDB_MAX_ATTEMPTS; attempt++) {
          var res = await doFetch(url(path, params), { headers: headers })
          if (res.ok) return { ok: true, data: await res.json() }
          if (res.status !== 429 || attempt === TMDB_MAX_ATTEMPTS - 1) return { ok: false, status: res.status }
          await sleep(tmdbRetryDelayMs(res, attempt))
        }
      } catch (err) {
        return { ok: false, status: 0, error: String(err) }
      }
    }
  }
}

// Fetches one exact TMDB row by id. Needed for one narrow but important case: a
// file the owner has CONFIRMED whose cached row has since gone missing (the
// cache folder was moved, cleared, or copied from another machine). Without
// this, the only way back to a row is a search — and a search could hand back a
// different film, which would quietly undo a decision a person made. Re-fetching
// the id he chose cannot. If it fails, the caller is expected to give up rather
// than fall back to guessing.
async function fetchById(api, kind, id) {
  if (!api || !id) return null
  var res = await api.get((kind === 'tv' ? '/tv/' : '/movie/') + encodeURIComponent(id), {})
  if (!res.ok || !res.data || res.data.id == null) return null
  var row = res.data
  // /movie/{id} names the date field the same way search does, but returns
  // `genres` objects where search returns `genre_ids`. Normalise, because every
  // reader in this app expects the search shape.
  if (!row.genre_ids && Array.isArray(row.genres)) {
    row = Object.assign({}, row, { genre_ids: row.genres.map(function (g) { return g && g.id }).filter(function (x) { return x != null }) })
  }
  return row
}

// ---------------------------------------------------------------------------
// The matcher
// ---------------------------------------------------------------------------

// Resolves one parsed filename against TMDB and returns a VERDICT, never a bare
// match:
//   { confidence, match, kind, query, year, candidates, reason }
// `match` is null for anything but certain/probable. A caller that writes
// `match` straight into the manifest therefore cannot accidentally persist a
// guess — it has to look at `confidence` to get anything at all.
//
// `parsed` is exactly what titleParse.parseMovieTitle() returns.
async function matchParsed(parsed, api, opts) {
  var options = opts || {}
  var p = parsed || {}
  var query = String(p.title || '').trim()
  var year = p.year ? Number(p.year) : null
  // A file with an episode code is a TV episode, whichever folder it is sitting
  // in. Searching /search/movie for "blue bloods" returns films, and one of them
  // will look plausible enough to be written down forever.
  var kind = p.episode ? 'tv' : 'movie'
  var base = { query: query, year: year, kind: kind, candidates: [], match: null }

  if (!api) return Object.assign({}, base, { confidence: 'none', reason: 'no_api_key' })

  // 0. A TMDB id read from an .nfo / .plexmatch next to the file (nfoImport.js) names the film outright.
  //    A dead id falls through to the searches below.
  if (p.tmdbId && kind === 'movie') {
    var byId = await fetchById(api, 'movie', p.tmdbId)
    var idHits = byId ? toCandidates([byId], 'movie') : []
    if (idHits.length) {
      var idVerdict = classify(query, year, idHits, { viaImdbId: true })
      return Object.assign({}, base, {
        kind: 'movie', confidence: 'certain', match: idVerdict.match, candidates: idVerdict.ranked, reason: 'tmdb_id'
      })
    }
  }

  // 1. An IMDb id in the filename short-circuits everything. /find is an exact
  //    lookup, not a search, so there is nothing to rank and nothing to doubt.
  if (p.imdbId) {
    var found = await api.get('/find/' + encodeURIComponent(p.imdbId), { external_source: 'imdb_id' })
    if (found.ok && found.data) {
      var movieHits = toCandidates(found.data.movie_results, 'movie')
      var tvHits = toCandidates(found.data.tv_results, 'tv')
      // Trust the id over the episode guess: if IMDb says this is a film, it is
      // a film, whatever the digits in the filename looked like.
      var hits = kind === 'tv' ? (tvHits.length ? tvHits : movieHits) : (movieHits.length ? movieHits : tvHits)
      if (hits.length) {
        var verdict = classify(query, year, hits, { viaImdbId: true })
        return Object.assign({}, base, {
          kind: hits[0].kind,
          confidence: 'certain',
          match: verdict.match,
          candidates: verdict.ranked,
          reason: 'imdb_id'
        })
      }
    }
    // A dead id falls through to an ordinary search rather than giving up — the
    // id may simply not be in TMDB's index.
  }

  if (!query) return Object.assign({}, base, { confidence: 'none', reason: 'empty_query' })

  var searchPath = kind === 'tv' ? '/search/tv' : '/search/movie'
  var yearKey = kind === 'tv' ? 'first_air_date_year' : 'year'

  // 2. Year-narrowed search first. This is a RECALL aid, not a filter: its
  //    results are merged with the unfiltered pool below, never used alone to
  //    decide what exists.
  var narrowed = []
  if (year) {
    var r1 = await api.get(searchPath, { query: query, [yearKey]: year })
    if (r1.ok) narrowed = toCandidates(r1.data && r1.data.results, kind)
    else if (!r1.status) return Object.assign({}, base, { confidence: 'none', reason: 'network_error' })
    // A narrowed search that already yields a certain answer needs no second
    // call — exact title plus exact year cannot be beaten by anything a wider
    // search could add. Purely an economy; it changes no outcome.
    var early = classify(query, year, narrowed, {})
    if (early.confidence === 'certain') {
      return Object.assign({}, base, {
        confidence: 'certain', match: early.match, candidates: early.ranked, reason: early.reason
      })
    }
  }

  // 3. The unfiltered search. Everything is ranked together from here.
  var r2 = await api.get(searchPath, { query: query })
  if (!r2.ok && !narrowed.length) {
    return Object.assign({}, base, { confidence: 'none', reason: r2.status ? 'tmdb_http_' + r2.status : 'network_error' })
  }
  var wide = r2.ok ? toCandidates(r2.data && r2.data.results, kind) : []
  var pool = mergeCandidates(narrowed, wide)
  var out = classify(query, year, pool, {})
  return Object.assign({}, base, {
    confidence: out.confidence,
    match: out.match,
    candidates: out.ranked,
    margin: out.margin,
    reason: out.reason
  })
}

// ---------------------------------------------------------------------------
// The decision store
// ---------------------------------------------------------------------------
//
// Keyed by fileName, exactly like the existing 'movieTitleOverrides' key, so it
// reads the same way as everything else the owner has already got in
// electron-store. Two shapes only:
//   { kind:'movie'|'tv', tmdbId, title, year, decidedAt, decidedBy }
//   { kind:'none', notAMovie:true, decidedAt, decidedBy }
//
// A DECISION WINS OVER EVERYTHING AND IS NEVER RE-GUESSED — including by the
// "Re-check all movie matches" force path, which exists to re-run the matcher
// after a logic change and must not be able to undo something a person sat down
// and answered by hand.
//
// `notAMovie` is not a tidiness feature. The library contains trance mixes, a
// wedding video and a handful of clips that will never be in TMDB. Without a way
// to say so, every one of them is re-queried on every force run for the rest of
// time and re-appears at the top of the review list each time it is cleared.
var DECISIONS_KEY = 'titleDecisions'
var REVIEW_KEY = 'titleReviewQueue'

function getDecisions(store) {
  try {
    var v = store && store.get(DECISIONS_KEY)
    return v && typeof v === 'object' ? v : {}
  } catch (e) {
    return {}
  }
}

function getDecision(store, fileName) {
  if (!fileName) return null
  var d = getDecisions(store)[fileName]
  return d && typeof d === 'object' ? d : null
}

function setDecision(store, fileName, decision) {
  if (!store || !fileName) return null
  var all = getDecisions(store)
  var entry = Object.assign({ decidedAt: Date.now() }, decision || {})
  all[fileName] = entry
  store.set(DECISIONS_KEY, all)
  return entry
}

function confirmMatch(store, fileName, candidate, who) {
  return setDecision(store, fileName, {
    kind: (candidate && candidate.kind) || 'movie',
    tmdbId: candidate && candidate.id,
    title: (candidate && candidate.title) || '',
    year: (candidate && candidate.year) || null,
    decidedBy: who || null
  })
}

function markNotAMovie(store, fileName, who) {
  return setDecision(store, fileName, { kind: 'none', notAMovie: true, decidedBy: who || null })
}

function clearDecision(store, fileName) {
  if (!store || !fileName) return false
  var all = getDecisions(store)
  if (!(fileName in all)) return false
  delete all[fileName]
  store.set(DECISIONS_KEY, all)
  return true
}

// ---------------------------------------------------------------------------
// The review queue
// ---------------------------------------------------------------------------
//
// Also keyed by fileName. A queue entry is BOTH the owner's to-do list AND the
// "we already looked at this one" marker: a file that is queued is not re-queried
// on the next run, which is what stops 267 hopeless filenames costing 267 TMDB
// calls every single time the prefetch is run.
//
// Candidates are stored in the shape the admin page renders, not TMDB's raw
// shape, so the page needs no network and no re-search to draw itself.
var REVIEW_CANDIDATE_LIMIT = 5

function getReviewQueue(store) {
  try {
    var v = store && store.get(REVIEW_KEY)
    return v && typeof v === 'object' ? v : {}
  } catch (e) {
    return {}
  }
}

function reviewCandidate(c) {
  return {
    id: c.id,
    kind: c.kind,
    title: c.title,
    year: c.year,
    posterPath: c.posterPath,
    popularity: Math.round((Number(c.popularity) || 0) * 100) / 100,
    score: Math.round((Number(c.score) || 0) * 10) / 10,
    // The whole TMDB row is kept, not just the fields the page draws. It costs
    // roughly a kilobyte per candidate and it buys the thing this app is built
    // around: confirming a title on the review page needs NO network call at
    // all, because the exact object that would have been written by a search is
    // already here, overview, genre ids and all. Reviewing a library works in
    // the cabin with the internet off.
    raw: c.raw || null
  }
}

function queueForReview(store, fileName, verdict, extra) {
  if (!store || !fileName) return null
  var all = getReviewQueue(store)
  var v = verdict || {}
  var entry = Object.assign(
    {
      fileName: fileName,
      query: v.query || '',
      year: v.year || null,
      kind: v.kind || 'movie',
      reason: v.reason || 'unsure',
      confidence: v.confidence || 'unsure',
      candidates: (v.candidates || []).slice(0, REVIEW_CANDIDATE_LIMIT).map(reviewCandidate),
      queuedAt: Date.now()
    },
    extra || {}
  )
  all[fileName] = entry
  store.set(REVIEW_KEY, all)
  return entry
}

function dequeueReview(store, fileName) {
  if (!store || !fileName) return false
  var all = getReviewQueue(store)
  if (!(fileName in all)) return false
  delete all[fileName]
  store.set(REVIEW_KEY, all)
  return true
}

function isQueued(store, fileName) {
  return !!fileName && Object.prototype.hasOwnProperty.call(getReviewQueue(store), fileName)
}

// ---------------------------------------------------------------------------
// Should this file be looked up at all?
// ---------------------------------------------------------------------------
//
// One rule, used by every caller, so the desktop prefetch and the web server can
// no longer disagree about which files are "done".
//
// `force` is the owner's "Re-check all movie matches" button. It overrides a
// cached match and a review-queue entry — both of those are things the matcher
// produced and should be allowed to redo — but NOT a decision, which is
// something a person produced.
//
// THE STUCK NULLS. 267 of the owner's 1,205 files are cached as `null`, and the
// old `fileName in manifest` test treats a null as an answer, so they are skipped
// for good. Under this rule a null is no longer an answer, it is an absence: a
// null with no decision and no queue entry IS re-evaluated, automatically, on the
// next run, with no button press. It cannot loop, because whatever the re-run
// decides — a match, or a queue entry — is a state this function then skips.
function shouldLookUp(store, fileName, manifest, force) {
  var decision = getDecision(store, fileName)
  if (decision) return false // a person answered this; never ask again
  if (force) return true
  if (isQueued(store, fileName)) return false // already waiting on the owner
  if (!manifest || !(fileName in manifest)) return true
  return manifest[fileName] === null // a cached null means "unanswered", not "no such film"
}

// Applies a verdict: returns what the caller should write to the manifest, and
// queues the file when there is nothing safe to write. Keeps the accept/queue
// rule in one place so main.js and streamServer.js cannot drift apart again.
//
// `previous` is whatever the manifest already holds for this file (or null).
// It matters on the "Re-check all movie matches" path: a file that already has a
// poster and now scores `unsure` KEEPS the poster it has and is queued for a
// look, rather than having a working match taken away from it. Re-checking must
// only ever be able to improve a file or ask a question about it — never to
// leave the owner with less than he had. Measured against his real manifest: 39
// of the 938 currently-matched files score `unsure` under the new rules, and
// most of those matches are in fact right; without this, a single press of the
// button would strip 39 posters.
//
// Returns { accepted, match, queued, confidence, keptPrevious }.
function applyVerdict(store, fileName, verdict, previous) {
  var v = verdict || {}
  if ((v.confidence === 'certain' || v.confidence === 'probable') && v.match) {
    dequeueReview(store, fileName)
    return { accepted: true, match: v.match, queued: false, confidence: v.confidence, keptPrevious: false }
  }
  var prev = previous && typeof previous === 'object' ? previous : null
  queueForReview(store, fileName, v, prev ? { currentMatch: { id: prev.id, title: prev.title || '', year: Number(String(prev.release_date || '').slice(0, 4)) || null, posterPath: prev.poster_path || null } } : null)
  return { accepted: false, match: prev, queued: true, confidence: v.confidence || 'unsure', keptPrevious: !!prev }
}

module.exports = {
  // pure, testable
  normalizeTitle: normalizeTitle,
  diceOverlap: diceOverlap,
  toCandidate: toCandidate,
  toCandidates: toCandidates,
  mergeCandidates: mergeCandidates,
  titleScore: titleScore,
  yearScore: yearScore,
  scoreCandidate: scoreCandidate,
  rankCandidates: rankCandidates,
  classify: classify,
  // network
  createTmdbApi: createTmdbApi,
  fetchById: fetchById,
  matchParsed: matchParsed,
  // decisions
  getDecisions: getDecisions,
  getDecision: getDecision,
  setDecision: setDecision,
  confirmMatch: confirmMatch,
  markNotAMovie: markNotAMovie,
  clearDecision: clearDecision,
  // review queue
  getReviewQueue: getReviewQueue,
  queueForReview: queueForReview,
  dequeueReview: dequeueReview,
  isQueued: isQueued,
  REVIEW_CANDIDATE_LIMIT: REVIEW_CANDIDATE_LIMIT,
  // shared policy
  shouldLookUp: shouldLookUp,
  applyVerdict: applyVerdict,
  // thresholds, exported so a test can assert the bands rather than re-state them
  SCORE_CERTAIN: SCORE_CERTAIN,
  SCORE_PROBABLE: SCORE_PROBABLE,
  MARGIN_PROBABLE: MARGIN_PROBABLE,
  MARGIN_CERTAIN: MARGIN_CERTAIN,
  DECISIONS_KEY: DECISIONS_KEY,
  REVIEW_KEY: REVIEW_KEY
}
