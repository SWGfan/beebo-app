'use strict'
// ============================================================================
// movieNightGames.js - the games of Movie Night, as pure logic. No I/O, no clock, no HTTP.
// ----------------------------------------------------------------------------
// Every question is generated FROM THE OWNER'S OWN LIBRARY: a "pool" of items the library
// module (movieNightLibrary.js) built from cached TMDB metadata. Nothing here reaches the
// network, so a movie night works on a home network with no internet.
//
// POOL ITEM   { key, title, year|null, tagline, cast: [{ id, name, character, photo|null }],
//               poster|null, rating|null, playHref }
//
// GAMES
//   name-that-movie  a poster on the TV that starts almost unreadable and clears in four
//                    stages (tagline at stage 1, cast at 2, year at 3); pick the title.
//                    The sooner, the more points (1000 / 700 / 400 / 200).
//   cast-match       "Which of these actors was in <film>?" (one billed actor, three who were
//                    not in that film's cast list).
//   year-guess       a year slider. Points fall 40 for every year off (600 for an exact year),
//                    and whoever is closest gets +400 (a tie shares it).
//   before-after     two posters, "which came out first?".
//   trivia-night     a mixed round of all of the above plus tagline and "who played" questions.
//   intermission     three quick trivia questions between features (about the film that just
//                    played first, when the room knows it).
//   pick-tonight     not a quiz: a fair group vote (approvals + one veto each, ties settled
//                    by a fair random draw). See the VOTE section.
//
// SCORING (multiple choice): 600 for a right answer + up to 400 for speed
// (400 * time left / time allowed). A wrong or missing answer scores 0.
// Team score = the members' average, so a team with one more person is not favoured.
//
// Answers are DATA from strangers: they are validated against the question (an option id or
// an integer in range) and nothing else is ever read from them.
// ============================================================================

const MC_BASE = 600
const MC_SPEED = 400
const NAME_STAGE_POINTS = Object.freeze([1000, 700, 400, 200])
const NAME_STAGE_AT = Object.freeze([0, 0.35, 0.6, 0.8]) // fractions of the time allowed
const YEAR_EXACT = 600
const YEAR_PER_OFF = 40
const YEAR_CLOSEST_BONUS = 400

const DEFAULT_TIMING = Object.freeze({
  'name-that-movie': 30000,
  'cast-match': 20000,
  'year-guess': 25000,
  'before-after': 15000,
  tagline: 20000,
  'who-plays': 20000,
  revealMs: 6000,
  intermissionMs: 15000
})

const GAME_INFO = Object.freeze({
  'name-that-movie': { id: 'name-that-movie', title: 'Name That Movie', blurb: 'A blurry poster clears up. Guess it early for more points.', quiz: true, defaultRounds: 6 },
  'cast-match': { id: 'cast-match', title: 'Cast Match', blurb: 'Which actor was in this film?', quiz: true, defaultRounds: 8 },
  'year-guess': { id: 'year-guess', title: 'Year Guess', blurb: 'What year did it come out? Closest wins.', quiz: true, defaultRounds: 6 },
  'before-after': { id: 'before-after', title: 'Before or After', blurb: 'Which of these two came out first?', quiz: true, defaultRounds: 8 },
  'trivia-night': { id: 'trivia-night', title: 'Trivia Night', blurb: 'A mix of everything, with speed bonuses.', quiz: true, defaultRounds: 10 },
  'pick-tonight': { id: 'pick-tonight', title: 'Pick Tonight’s Movie', blurb: 'A fair group vote. Then press play.', quiz: false, defaultRounds: 1 },
  intermission: { id: 'intermission', title: 'Intermission Quiz', blurb: 'Three quick questions between features.', quiz: true, defaultRounds: 3, hidden: true }
})
const GAME_IDS = Object.freeze(Object.keys(GAME_INFO))
const ROUND_CHOICES = Object.freeze([3, 5, 6, 8, 10, 12, 15])

// ---- randomness ------------------------------------------------------------------------------------

/** A deterministic generator for tests (mulberry32). */
function seededRng(seed) {
  let a = (Number(seed) >>> 0) || 1
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return { next, int: (n) => Math.floor(next() * n) }
}

/** The real thing: the operating system's secure generator. Unbiased for any n up to 2^48. */
function cryptoRng(cryptoImpl) {
  const c = cryptoImpl || require('crypto')
  return { next: () => c.randomInt(0, 2 ** 30) / 2 ** 30, int: (n) => (n <= 1 ? 0 : c.randomInt(0, n)) }
}

function shuffle(list, rng) {
  const a = list.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.int(i + 1)
    const t = a[i]; a[i] = a[j]; a[j] = t
  }
  return a
}
const sample = (list, n, rng) => shuffle(list, rng).slice(0, n)

const norm = (s) => String(s == null ? '' : s).toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

// ---- pool helpers ----------------------------------------------------------------------------------

const yearOk = (y) => Number.isInteger(y) && y >= 1880 && y <= 2100
const withYear = (pool) => pool.filter((m) => yearOk(m.year))
const withTagline = (pool) => pool.filter((m) => m.tagline && m.tagline.length >= 8 && norm(m.tagline) !== norm(m.title))
const withCast = (pool) => pool.filter((m) => m.cast && m.cast.length >= 1)
const distinctActors = (pool) => new Set(pool.flatMap((m) => (m.cast || []).map((c) => norm(c.name)))).size

/** How many distinct titles are usable, for the menu ("needs a few more films with cast information"). */
function availability(pool) {
  const p = Array.isArray(pool) ? pool : []
  const nameable = p.filter((m) => m.poster || (m.tagline && m.tagline.length >= 8) || (m.cast && m.cast.length >= 2))
  const has = {
    'name-that-movie': nameable.length >= 4,
    'cast-match': withCast(p).length >= 1 && distinctActors(p) >= 5,
    'year-guess': withYear(p).length >= 3,
    'before-after': withYear(p).length >= 2 && new Set(withYear(p).map((m) => m.year)).size >= 2,
    'pick-tonight': p.length >= 3
  }
  has['trivia-night'] = p.length >= 4 && (has['name-that-movie'] || has['cast-match'] || has['year-guess'])
  has.intermission = has['trivia-night']
  const need = {
    'name-that-movie': 'at least 4 films with a poster, tagline or cast saved',
    'cast-match': 'a few films with cast information saved',
    'year-guess': 'at least 3 films with a release year',
    'before-after': 'two films from different years',
    'pick-tonight': 'at least 3 films',
    'trivia-night': 'at least 4 films with details saved',
    intermission: 'at least 4 films with details saved'
  }
  return Object.fromEntries(GAME_IDS.map((id) => [id, { ready: !!has[id], why: has[id] ? '' : need[id] }]))
}

/** Title options that look plausible next to the right one: near it in year, shuffled. */
function decoyTitles(pool, subject, n, rng) {
  const seen = new Set([norm(subject.title)])
  const others = pool.filter((m) => m.key !== subject.key && !seen.has(norm(m.title)))
  const scored = others.map((m) => ({ m, d: Math.abs((m.year || subject.year || 0) - (subject.year || m.year || 0)) + rng.next() * 6 })).sort((a, b) => a.d - b.d)
  const out = []
  const taken = new Set(seen)
  for (const { m } of shuffle(scored.slice(0, Math.max(n * 3, 8)), rng)) {
    const k = norm(m.title)
    if (taken.has(k)) continue
    taken.add(k)
    out.push(m)
    if (out.length >= n) break
  }
  return out
}

const LETTERS = ['a', 'b', 'c', 'd', 'e', 'f']

function makeOptions(correct, decoys, rng) {
  const all = shuffle([{ ...correct, correct: true }, ...decoys.map((d) => ({ ...d, correct: false }))], rng)
  const options = all.map((o, i) => {
    const out = { id: LETTERS[i], text: o.text }
    if (o.poster) out.poster = o.poster
    if (o.photo) out.photo = o.photo
    return out
  })
  return { options, correctId: LETTERS[all.findIndex((o) => o.correct)] }
}

// ---- question builders -----------------------------------------------------------------------------

const asTitle = (m) => ({ text: m.title, poster: m.poster || null })

function qName(pool, rng, timing, avoid) {
  const cands = pool.filter((m) => !avoid.has(m.key) && (m.poster || (m.tagline && m.tagline.length >= 8) || (m.cast && m.cast.length >= 2)))
  if (!cands.length) return null
  const m = cands[rng.int(cands.length)]
  const decoys = decoyTitles(pool, m, 3, rng)
  if (decoys.length < 3) return null
  const { options, correctId } = makeOptions(asTitle(m), decoys.map(asTitle), rng)
  const clues = []
  if (m.tagline && m.tagline.length >= 8) clues.push({ stage: 1, kind: 'tagline', text: m.tagline })
  const actors = (m.cast || []).slice(0, 3).map((c) => c.name).filter(Boolean)
  if (actors.length >= 2) clues.push({ stage: 2, kind: 'cast', text: actors.join(', ') })
  if (yearOk(m.year)) clues.push({ stage: 3, kind: 'year', text: String(m.year) })
  return { type: 'name-that-movie', prompt: 'Name that movie!', subject: m.key, title: m.title, year: m.year || null, poster: m.poster || null, clues, options, correctId, timeMs: timing['name-that-movie'] }
}

function qCast(pool, rng, timing, avoid) {
  const cands = withCast(pool).filter((m) => !avoid.has(m.key))
  if (!cands.length) return null
  const m = cands[rng.int(cands.length)]
  const inFilm = new Set(m.cast.map((c) => norm(c.name)))
  const right = m.cast.slice(0, 8)[rng.int(Math.min(8, m.cast.length))]
  const others = []
  const seen = new Set()
  for (const o of pool) {
    if (o.key === m.key) continue
    for (const c of o.cast || []) {
      const k = norm(c.name)
      if (!k || inFilm.has(k) || seen.has(k)) continue
      seen.add(k)
      others.push(c)
    }
  }
  if (others.length < 3) return null
  const decoys = sample(others, 3, rng)
  const { options, correctId } = makeOptions({ text: right.name, photo: right.photo || null }, decoys.map((c) => ({ text: c.name, photo: c.photo || null })), rng)
  return { type: 'cast-match', prompt: `Which of these actors was in “${m.title}”?`, subject: m.key, title: m.title, year: m.year || null, poster: m.poster || null, clues: [], options, correctId, timeMs: timing['cast-match'] }
}

function qYear(pool, rng, timing, avoid) {
  const cands = withYear(pool).filter((m) => !avoid.has(m.key))
  if (!cands.length) return null
  const m = cands[rng.int(cands.length)]
  const years = withYear(pool).map((x) => x.year)
  let min = Math.max(1880, Math.min(...years) - 3)
  let max = Math.min(2100, Math.max(...years) + 3)
  if (max - min < 20) { min = Math.max(1880, min - 10); max = Math.min(2100, max + 10) }
  return { type: 'year-guess', prompt: `What year was “${m.title}” released?`, subject: m.key, title: m.title, year: m.year, poster: m.poster || null, clues: [], min, max, correctYear: m.year, timeMs: timing['year-guess'] }
}

function qBeforeAfter(pool, rng, timing, avoid) {
  const cands = withYear(pool).filter((m) => !avoid.has(m.key))
  if (cands.length < 1) return null
  const a = cands[rng.int(cands.length)]
  const others = withYear(pool).filter((m) => m.key !== a.key && m.year !== a.year && norm(m.title) !== norm(a.title))
  if (!others.length) return null
  // Prefer a pair at least two years apart so a one-year gap is not the whole question.
  const wide = others.filter((m) => Math.abs(m.year - a.year) >= 2)
  const pickFrom = wide.length ? wide : others
  const b = pickFrom[rng.int(pickFrom.length)]
  const pair = shuffle([a, b], rng)
  const options = pair.map((m, i) => ({ id: LETTERS[i], text: m.title, ...(m.poster ? { poster: m.poster } : {}) }))
  const first = pair[0].year < pair[1].year ? 0 : 1
  return {
    type: 'before-after', prompt: 'Which one came out first?', subject: a.key, title: a.title, year: null, poster: null, clues: [], options, correctId: LETTERS[first],
    years: { [LETTERS[0]]: pair[0].year, [LETTERS[1]]: pair[1].year }, timeMs: timing['before-after']
  }
}

function qTagline(pool, rng, timing, avoid) {
  const cands = withTagline(pool).filter((m) => !avoid.has(m.key))
  if (!cands.length) return null
  const m = cands[rng.int(cands.length)]
  const decoys = decoyTitles(pool, m, 3, rng)
  if (decoys.length < 3) return null
  const { options, correctId } = makeOptions({ text: m.title }, decoys.map((d) => ({ text: d.title })), rng)
  return { type: 'tagline', prompt: `Which film had the tagline “${m.tagline}”?`, subject: m.key, title: m.title, year: m.year || null, poster: m.poster || null, clues: [], options, correctId, timeMs: timing.tagline }
}

function qWhoPlays(pool, rng, timing, avoid) {
  const cands = pool.filter((m) => !avoid.has(m.key) && (m.cast || []).some((c) => c.character && c.character.length <= 40 && c.name))
  if (!cands.length) return null
  const m = cands[rng.int(cands.length)]
  const roles = m.cast.slice(0, 8).filter((c) => c.character && c.character.length <= 40 && c.name)
  const right = roles[rng.int(roles.length)]
  const inFilm = new Set(m.cast.map((c) => norm(c.name)))
  const others = []
  const seen = new Set()
  for (const o of pool) {
    if (o.key === m.key) continue
    for (const c of o.cast || []) {
      const k = norm(c.name)
      if (!k || inFilm.has(k) || seen.has(k)) continue
      seen.add(k)
      others.push(c)
    }
  }
  if (others.length < 3) return null
  const { options, correctId } = makeOptions({ text: right.name, photo: right.photo || null }, sample(others, 3, rng).map((c) => ({ text: c.name, photo: c.photo || null })), rng)
  return { type: 'who-plays', prompt: `Who played “${right.character}” in “${m.title}”?`, subject: m.key, title: m.title, year: m.year || null, poster: m.poster || null, clues: [], options, correctId, timeMs: timing['who-plays'] }
}

const BUILDERS = { 'name-that-movie': qName, 'cast-match': qCast, 'year-guess': qYear, 'before-after': qBeforeAfter, tagline: qTagline, 'who-plays': qWhoPlays }
const MIX = ['cast-match', 'tagline', 'year-guess', 'before-after', 'name-that-movie', 'who-plays']

/** Questions about one particular film first (an intermission right after the feature). */
function aboutFeatured(featured, pool, rng, timing) {
  const m = featured ? pool.find((x) => x.key === featured.key) : null
  if (!m) return []
  const others = new Set(pool.filter((x) => x.key !== m.key).map((x) => x.key)) // avoiding every other film = picking this one
  return [qCast(pool, rng, timing, others), qYear(pool, rng, timing, others)].filter(Boolean)
}

/**
 * -> { ok: true, type, title, questions } | { ok: false, error }
 * opts: { rounds, rng, timing, featured: { key } }
 */
function buildGame(type, pool, opts = {}) {
  const info = GAME_INFO[type]
  if (!info || !info.quiz) return { ok: false, error: 'unknown_game' }
  const rng = opts.rng || cryptoRng()
  const timing = { ...DEFAULT_TIMING, ...(opts.timing || {}) }
  const items = Array.isArray(pool) ? pool : []
  const avail = availability(items)
  if (!avail[type] || !avail[type].ready) return { ok: false, error: 'not_enough_titles', need: avail[type] ? avail[type].why : '' }
  const rounds = Math.max(1, Math.min(20, Number.isInteger(opts.rounds) ? opts.rounds : info.defaultRounds))
  const questions = []
  const avoid = new Set()
  const push = (q) => { if (q) { questions.push(q); avoid.add(q.subject) } return !!q }

  if (type === 'intermission') {
    for (const q of aboutFeatured(opts.featured, items, rng, { ...timing, 'cast-match': timing.intermissionMs, 'year-guess': timing.intermissionMs })) { if (questions.length < rounds) push(q) }
  }
  const single = ['name-that-movie', 'cast-match', 'year-guess', 'before-after'].includes(type)
  const kinds = single ? [type] : MIX.filter((k) => avail[k === 'tagline' || k === 'who-plays' ? 'trivia-night' : k].ready && (k !== 'tagline' || withTagline(items).length) && (k !== 'who-plays' || items.some((m) => (m.cast || []).some((c) => c.character))))
  let order = shuffle(kinds, rng)
  let guard = 0
  let idx = 0
  while (questions.length < rounds && guard++ < rounds * 12 && order.length) {
    if (idx >= order.length) { order = shuffle(kinds, rng); idx = 0 }
    const kind = order[idx++]
    const useTiming = type === 'intermission' ? { ...timing, [kind]: timing.intermissionMs } : timing
    let q = BUILDERS[kind](items, rng, useTiming, avoid)
    if (!q && avoid.size >= items.length) q = BUILDERS[kind](items, rng, useTiming, new Set()) // pool smaller than the round count: allow repeats late
    push(q)
  }
  if (!questions.length) return { ok: false, error: 'not_enough_titles', need: avail[type].why }
  questions.forEach((q, i) => { q.id = 'q' + (i + 1) })
  return { ok: true, type, title: info.title, questions }
}

// ---- answers and scoring ---------------------------------------------------------------------------

/** The stage a Name That Movie question is in after `elapsedMs` (0..3). */
function stageAt(q, elapsedMs) {
  if (!q || q.type !== 'name-that-movie') return 0
  const f = q.timeMs > 0 ? elapsedMs / q.timeMs : 1
  let s = 0
  for (let i = 0; i < NAME_STAGE_AT.length; i++) if (f >= NAME_STAGE_AT[i]) s = i
  return s
}

/** A guest's raw answer -> the normalised value, or null when it is not a valid answer to this question. */
function validateAnswer(q, raw) {
  if (!q) return null
  if (q.type === 'year-guess') {
    const n = typeof raw === 'string' && /^\d{1,4}$/.test(raw) ? Number(raw) : raw
    return Number.isInteger(n) && n >= q.min && n <= q.max ? n : null
  }
  return typeof raw === 'string' && (q.options || []).some((o) => o.id === raw) ? raw : null
}

const speedFraction = (elapsedMs, limitMs) => (limitMs > 0 ? Math.max(0, Math.min(1, 1 - elapsedMs / limitMs)) : 0)

/**
 * answers: [{ id, value, elapsedMs }] (each guest at most once).
 * -> [{ id, points, correct, detail? }] for the same guests, in the same order.
 */
function scoreRound(q, answers) {
  const list = Array.isArray(answers) ? answers : []
  if (q.type === 'year-guess') {
    const diffs = list.map((a) => Math.abs(a.value - q.correctYear))
    const best = diffs.length ? Math.min(...diffs) : null
    return list.map((a, i) => {
      const diff = diffs[i]
      const base = Math.max(0, YEAR_EXACT - YEAR_PER_OFF * diff)
      const winner = best !== null && diff === best
      return { id: a.id, points: base + (winner ? YEAR_CLOSEST_BONUS : 0), correct: diff === 0, detail: { diff, closest: winner } }
    })
  }
  return list.map((a) => {
    const correct = a.value === q.correctId
    if (!correct) return { id: a.id, points: 0, correct: false }
    if (q.type === 'name-that-movie') return { id: a.id, points: NAME_STAGE_POINTS[stageAt(q, a.elapsedMs)], correct: true, detail: { stage: stageAt(q, a.elapsedMs) } }
    return { id: a.id, points: MC_BASE + Math.round(MC_SPEED * speedFraction(a.elapsedMs, q.timeMs)), correct: true }
  })
}

// ---- what each audience may see ---------------------------------------------------------------------

/**
 * The question as it goes to a screen. `phase` 'ask' never carries the answer; 'reveal' carries it.
 * role 'tv' gets posters and clues that are unlocked so far; 'guest' gets the choices only.
 */
function publicQuestion(q, { role, phase, stage = 0 }) {
  if (!q) return null
  const base = { id: q.id, type: q.type, prompt: q.prompt, timeMs: q.timeMs }
  if (q.type === 'year-guess') { base.min = q.min; base.max = q.max } else base.options = q.options.map((o) => (role === 'tv' ? { ...o } : { id: o.id, text: o.text }))
  if (role === 'tv') {
    if (q.type === 'name-that-movie') {
      base.poster = q.poster
      base.stage = phase === 'reveal' ? 3 : stage
      base.clues = q.clues.filter((c) => phase === 'reveal' || c.stage <= stage)
    } else if (q.poster && q.type !== 'before-after') base.poster = q.poster
    if (q.type === 'before-after' && phase !== 'reveal') base.options = base.options.map((o) => ({ ...o }))
  }
  if (phase === 'reveal') {
    if (q.type === 'year-guess') base.correctYear = q.correctYear
    else base.correctId = q.correctId
    base.title = q.title
    if (q.years) base.years = q.years
    if (q.type === 'name-that-movie') base.year = q.year
  }
  return base
}

// ---- ranking and teams -----------------------------------------------------------------------------

/** rows: [{ id, name, score }] -> the same rows with `rank` (1,1,3 for a tie) sorted best first. */
function rank(rows) {
  const sorted = rows.slice().sort((a, b) => b.score - a.score || String(a.name).localeCompare(String(b.name)))
  let last = null
  let lastRank = 0
  return sorted.map((r, i) => {
    if (last === null || r.score !== last) { lastRank = i + 1; last = r.score }
    return { ...r, rank: lastRank }
  })
}

const TEAM_NAMES = Object.freeze(['Red Team', 'Blue Team', 'Green Team', 'Gold Team'])
const TEAM_COLORS = Object.freeze(['#ff6b6b', '#4dabf7', '#51cf66', '#ffd43b'])

/** A team's score is its members' average, rounded, so an extra person is not an advantage. */
function teamScores(members, teamCount) {
  const out = []
  for (let t = 0; t < teamCount; t++) {
    const mine = members.filter((m) => m.team === t)
    const total = mine.reduce((s, m) => s + m.score, 0)
    out.push({ team: t, name: TEAM_NAMES[t], color: TEAM_COLORS[t], members: mine.length, total, score: mine.length ? Math.round(total / mine.length) : 0 })
  }
  return out
}

/** Which team the next person should join: the smallest one (ties: lowest number). */
function nextTeam(members, teamCount) {
  const sizes = Array.from({ length: teamCount }, (_, t) => members.filter((m) => m.team === t).length)
  return sizes.indexOf(Math.min(...sizes))
}

// ---- VOTE: Pick Tonight's Movie ---------------------------------------------------------------------
// Each voter approves any number of candidates and may veto ONE. A candidate that a majority of the
// voters vetoed is out (unless that would leave nothing). Net score = approvals - vetoes. Ties: fewer
// vetoes, then a fair draw with the secure random generator - never "whoever voted first".

function createVote(candidates) {
  return { candidates: candidates.map((c) => ({ key: c.key, title: c.title, year: c.year || null, poster: c.poster || null, by: c.by || null })), ballots: new Map() }
}

/** One ballot per voter; sending another replaces it. Unknown candidates are ignored. */
function castBallot(vote, voterId, { approve, veto, done } = {}) {
  const keys = new Set(vote.candidates.map((c) => c.key))
  const ap = [...new Set((Array.isArray(approve) ? approve : []).filter((k) => keys.has(k)))]
  const vt = typeof veto === 'string' && keys.has(veto) && !ap.includes(veto) ? veto : null
  // `done` = "I am finished" (the Submit button): the vote may close early once everybody connected is done.
  vote.ballots.set(voterId, { approve: ap, veto: vt, done: done === true })
  return vote.ballots.get(voterId)
}

function tally(vote, voterIds) {
  const voters = voterIds ? voterIds.filter((id) => vote.ballots.has(id)) : [...vote.ballots.keys()]
  const rows = vote.candidates.map((c) => ({ ...c, approvals: 0, vetoes: 0 }))
  const byKey = new Map(rows.map((r) => [r.key, r]))
  for (const id of voters) {
    const b = vote.ballots.get(id)
    for (const k of b.approve) byKey.get(k).approvals++
    if (b.veto) byKey.get(b.veto).vetoes++
  }
  for (const r of rows) r.net = r.approvals - r.vetoes
  return { rows, voters: voters.length }
}

/** -> { winner, tied: [keys that were level], method, rows } */
function decide(vote, rng, voterIds) {
  const { rows, voters } = tally(vote, voterIds)
  let alive = rows.filter((r) => !(voters > 0 && r.vetoes * 2 > voters))
  if (!alive.length) alive = rows
  const bestNet = Math.max(...alive.map((r) => r.net))
  let tied = alive.filter((r) => r.net === bestNet)
  let method = tied.length === 1 ? 'votes' : 'fewest-vetoes'
  if (tied.length > 1) {
    const fewest = Math.min(...tied.map((r) => r.vetoes))
    tied = tied.filter((r) => r.vetoes === fewest)
  }
  let winner = tied[0]
  if (tied.length > 1) {
    method = voters === 0 ? 'draw-no-votes' : 'draw'
    winner = tied[rng.int(tied.length)]
  } else if (method === 'fewest-vetoes') {
    method = 'fewest-vetoes'
  }
  return { winner: winner.key, tied: tied.map((r) => r.key), method, rows: rows.map((r) => ({ ...r, out: !alive.includes(r) })) }
}

module.exports = {
  GAME_INFO, GAME_IDS, ROUND_CHOICES, DEFAULT_TIMING, NAME_STAGE_POINTS, NAME_STAGE_AT, MC_BASE, MC_SPEED, YEAR_EXACT, YEAR_PER_OFF, YEAR_CLOSEST_BONUS,
  TEAM_NAMES, TEAM_COLORS,
  seededRng, cryptoRng, shuffle, sample, norm,
  availability, buildGame, stageAt, validateAnswer, scoreRound, publicQuestion, rank, teamScores, nextTeam,
  createVote, castBallot, tally, decide
}
