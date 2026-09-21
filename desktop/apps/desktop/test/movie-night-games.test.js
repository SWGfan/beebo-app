// Movie Night game logic: question generation from a fixture library, scoring, team maths, and the fairness of the vote.
// Also the library adapter: parental controls, rating cap, unrated titles, text hygiene.
// Run: node --test test/movie-night-games.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const g = require('../electron/movieNightGames')
const lib = require('../electron/movieNightLibrary')
const { fixturePool, fixtureLibrary, FILMS } = require('./movie-night-fixture')

const rng = (seed = 7) => g.seededRng(seed)

// ---- generating questions ---------------------------------------------------------------------------------

test('every quiz game builds from the fixture library, with the right answer among distinct options', () => {
  const pool = fixturePool()
  for (const type of ['name-that-movie', 'cast-match', 'year-guess', 'before-after', 'trivia-night', 'intermission']) {
    const built = g.buildGame(type, pool, { rng: rng(3), rounds: 6 })
    assert.equal(built.ok, true, type)
    assert.ok(built.questions.length >= 1, type)
    for (const q of built.questions) {
      assert.ok(q.prompt && q.timeMs > 0)
      if (q.type === 'year-guess') {
        assert.ok(q.correctYear >= q.min && q.correctYear <= q.max)
        continue
      }
      assert.ok(q.options.length >= 2)
      assert.ok(q.options.some((o) => o.id === q.correctId), 'the answer is one of the options')
      const texts = q.options.map((o) => g.norm(o.text))
      assert.equal(new Set(texts).size, texts.length, 'no duplicate options: ' + JSON.stringify(texts))
    }
  }
})

test('the same seed gives the same night, a different seed a different one', () => {
  const pool = fixturePool()
  const a = g.buildGame('trivia-night', pool, { rng: rng(11), rounds: 8 })
  const b = g.buildGame('trivia-night', pool, { rng: rng(11), rounds: 8 })
  const c = g.buildGame('trivia-night', pool, { rng: rng(12), rounds: 8 })
  assert.deepEqual(a.questions.map((q) => q.prompt), b.questions.map((q) => q.prompt))
  assert.notDeepEqual(a.questions.map((q) => q.prompt), c.questions.map((q) => q.prompt))
})

test('no film is asked about twice while there are unused films left', () => {
  const pool = fixturePool()
  const built = g.buildGame('name-that-movie', pool, { rng: rng(5), rounds: 10 })
  const subjects = built.questions.map((q) => q.subject)
  assert.equal(new Set(subjects).size, subjects.length)
})

test('Cast Match: the right actor is in the film, the three others are not in its cast list', () => {
  const pool = fixturePool()
  for (let seed = 1; seed <= 25; seed++) {
    const built = g.buildGame('cast-match', pool, { rng: rng(seed), rounds: 8 })
    for (const q of built.questions) {
      const film = pool.find((m) => m.key === q.subject)
      const inFilm = new Set(film.cast.map((c) => g.norm(c.name)))
      const right = q.options.find((o) => o.id === q.correctId)
      assert.ok(inFilm.has(g.norm(right.text)))
      for (const o of q.options.filter((x) => x.id !== q.correctId)) assert.ok(!inFilm.has(g.norm(o.text)), `${o.text} is in ${film.title}`)
      assert.equal(q.options.length, 4)
    }
  }
})

test('Before or After: the two films are from different years and the answer is the earlier one', () => {
  const pool = fixturePool()
  for (let seed = 1; seed <= 25; seed++) {
    const built = g.buildGame('before-after', pool, { rng: rng(seed), rounds: 8 })
    for (const q of built.questions) {
      const [a, b] = q.options
      assert.notEqual(q.years[a.id], q.years[b.id])
      const first = q.years[a.id] < q.years[b.id] ? a.id : b.id
      assert.equal(q.correctId, first)
    }
  }
})

test('Name That Movie clues unlock in stages and never carry the title', () => {
  const pool = fixturePool()
  const built = g.buildGame('name-that-movie', pool, { rng: rng(2), rounds: 4 })
  for (const q of built.questions) {
    assert.ok(q.clues.every((c) => c.stage >= 1 && c.stage <= 3))
    assert.ok(q.clues.every((c) => !g.norm(c.text).includes(g.norm(q.title))), 'a clue must not give the title away')
    assert.equal(g.stageAt(q, 0), 0)
    assert.equal(g.stageAt(q, q.timeMs * 0.5), 1)
    assert.equal(g.stageAt(q, q.timeMs * 0.7), 2)
    assert.equal(g.stageAt(q, q.timeMs * 0.95), 3)
    const early = g.publicQuestion(q, { role: 'tv', phase: 'ask', stage: 0 })
    assert.equal(early.clues.length, 0)
    const late = g.publicQuestion(q, { role: 'tv', phase: 'ask', stage: 3 })
    assert.ok(late.clues.length >= 1)
  }
})

test('a question never carries its answer before the reveal', () => {
  const pool = fixturePool()
  for (const type of ['name-that-movie', 'cast-match', 'year-guess', 'before-after', 'trivia-night']) {
    for (const q of g.buildGame(type, pool, { rng: rng(4), rounds: 5 }).questions) {
      for (const role of ['tv', 'guest']) {
        const asked = JSON.stringify(g.publicQuestion(q, { role, phase: 'ask', stage: 3 }))
        assert.ok(!('correctId' in JSON.parse(asked)) && !('correctYear' in JSON.parse(asked)), type + ' leaked')
        assert.ok(!asked.includes('"correct"'), type + ' leaked a flag')
        if (q.type !== 'before-after') assert.ok(!('years' in JSON.parse(asked)))
      }
      const shown = g.publicQuestion(q, { role: 'guest', phase: 'reveal' })
      assert.ok('correctId' in shown || 'correctYear' in shown)
    }
  }
})

test('phones get the choices only: no posters, no clues', () => {
  const q = g.buildGame('name-that-movie', fixturePool(), { rng: rng(9), rounds: 1 }).questions[0]
  const p = g.publicQuestion(q, { role: 'guest', phase: 'ask', stage: 3 })
  assert.ok(!('poster' in p) && !('clues' in p))
  assert.ok(p.options.every((o) => Object.keys(o).sort().join() === 'id,text'))
})

test('a library that is too small says what it needs instead of building a broken game', () => {
  const tiny = fixturePool({ count: 2 })
  const r = g.buildGame('name-that-movie', tiny, { rng: rng() })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'not_enough_titles')
  assert.match(r.need, /4 films/)
  const avail = g.availability(tiny)
  assert.equal(avail['pick-tonight'].ready, false)
  assert.equal(avail['before-after'].ready, true)
  assert.equal(g.availability(fixturePool())['trivia-night'].ready, true)
})

test('posters missing: Name That Movie still works from clues', () => {
  const pool = fixturePool({ noPosters: true })
  const built = g.buildGame('name-that-movie', pool, { rng: rng(6), rounds: 3 })
  assert.equal(built.ok, true)
  assert.ok(built.questions.every((q) => q.poster === null && q.clues.length >= 1))
})

test('an intermission starts with questions about the film that just played', () => {
  const pool = fixturePool()
  const built = g.buildGame('intermission', pool, { rng: rng(8), featured: { key: 'id3' } })
  assert.equal(built.questions.length, 3)
  assert.equal(built.questions[0].subject, 'id3')
  assert.ok(built.questions.every((q) => q.timeMs === g.DEFAULT_TIMING.intermissionMs || q.type !== 'cast-match'))
})

// ---- answers and scoring ----------------------------------------------------------------------------------

test('answers are validated against the question; nothing else is trusted', () => {
  const mc = g.buildGame('cast-match', fixturePool(), { rng: rng(1), rounds: 1 }).questions[0]
  assert.equal(g.validateAnswer(mc, 'a'), 'a')
  for (const bad of ['z', '', null, undefined, 1, {}, ['a'], '__proto__', 'a '.repeat(2)]) assert.equal(g.validateAnswer(mc, bad), null)
  const yr = g.buildGame('year-guess', fixturePool(), { rng: rng(1), rounds: 1 }).questions[0]
  assert.equal(g.validateAnswer(yr, yr.min), yr.min)
  assert.equal(g.validateAnswer(yr, String(yr.max)), yr.max)
  for (const bad of [yr.min - 1, yr.max + 1, 1.5, NaN, Infinity, '1e3', 'abc', null, {}]) assert.equal(g.validateAnswer(yr, bad), null)
})

test('multiple choice: 600 for right + up to 400 for speed; wrong scores 0', () => {
  const q = { type: 'cast-match', correctId: 'b', timeMs: 20000, options: [{ id: 'a' }, { id: 'b' }] }
  const out = g.scoreRound(q, [
    { id: 'fast', value: 'b', elapsedMs: 0 },
    { id: 'mid', value: 'b', elapsedMs: 10000 },
    { id: 'last', value: 'b', elapsedMs: 20000 },
    { id: 'wrong', value: 'a', elapsedMs: 0 }
  ])
  assert.deepEqual(out.map((r) => r.points), [1000, 800, 600, 0])
  assert.deepEqual(out.map((r) => r.correct), [true, true, true, false])
})

test('Name That Movie pays by stage: 1000, 700, 400, 200', () => {
  const q = { type: 'name-that-movie', correctId: 'a', timeMs: 30000 }
  const at = (f) => g.scoreRound(q, [{ id: 'x', value: 'a', elapsedMs: q.timeMs * f }])[0].points
  assert.deepEqual([at(0.1), at(0.4), at(0.7), at(0.9)], [1000, 700, 400, 200])
})

test('Year Guess: exact 600, minus 40 per year, closest gets +400 (ties share)', () => {
  const q = { type: 'year-guess', correctYear: 2000, min: 1980, max: 2020 }
  const out = g.scoreRound(q, [
    { id: 'exact', value: 2000 },
    { id: 'near', value: 2003 },
    { id: 'far', value: 1980 },
    { id: 'near2', value: 1997 }
  ])
  const by = Object.fromEntries(out.map((r) => [r.id, r.points]))
  assert.equal(by.exact, 600 + 400)
  assert.equal(by.near, 480)
  assert.equal(by.near2, 480)
  assert.equal(by.far, 0)
  const tie = g.scoreRound(q, [{ id: 'a', value: 2002 }, { id: 'b', value: 1998 }, { id: 'c', value: 2010 }])
  assert.deepEqual(tie.map((r) => r.points), [520 + 400, 520 + 400, 200])
  // Nobody answered: nothing to score, nothing thrown.
  assert.deepEqual(g.scoreRound(q, []), [])
})

// ---- ranking and teams ------------------------------------------------------------------------------------

test('ranking: ties share a rank and the next place is skipped', () => {
  const rows = g.rank([{ id: 'a', name: 'Al', score: 500 }, { id: 'b', name: 'Bo', score: 900 }, { id: 'c', name: 'Cy', score: 500 }, { id: 'd', name: 'Di', score: 100 }])
  assert.deepEqual(rows.map((r) => [r.name, r.rank]), [['Bo', 1], ['Al', 2], ['Cy', 2], ['Di', 4]])
})

test('a team score is its members’ average, so a bigger team is not favoured', () => {
  const members = [
    { team: 0, score: 900 }, { team: 0, score: 900 }, { team: 0, score: 900 },
    { team: 1, score: 1000 }, { team: 1, score: 1000 }
  ]
  const t = g.teamScores(members, 2)
  assert.equal(t[0].score, 900)
  assert.equal(t[1].score, 1000)
  assert.equal(t[0].total, 2700)
  assert.equal(g.teamScores([], 3).every((x) => x.score === 0), true)
})

test('new players join the smallest team; teams stay within one person of each other', () => {
  const members = []
  for (let i = 0; i < 11; i++) members.push({ team: g.nextTeam(members, 3), score: 0 })
  const sizes = [0, 1, 2].map((t) => members.filter((m) => m.team === t).length)
  assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, sizes.join())
})

// ---- the vote ---------------------------------------------------------------------------------------------

const cands = (n) => Array.from({ length: n }, (_, i) => ({ key: 'm' + i, title: 'Movie ' + i }))

test('vote: the most approved film wins; one ballot per person and a new one replaces the old', () => {
  const v = g.createVote(cands(4))
  g.castBallot(v, 'p1', { approve: ['m0', 'm1'] })
  g.castBallot(v, 'p2', { approve: ['m1', 'm2'] })
  g.castBallot(v, 'p3', { approve: ['m1'] })
  g.castBallot(v, 'p1', { approve: ['m3'] }) // p1 changes their mind
  const d = g.decide(v, rng())
  assert.equal(d.winner, 'm1')
  assert.equal(d.method, 'votes')
  assert.equal(g.tally(v).voters, 3)
  assert.equal(d.rows.find((r) => r.key === 'm0').approvals, 0)
})

test('vote: ballots for films that are not on the list, and vetoing what you approved, are ignored', () => {
  const v = g.createVote(cands(3))
  const b = g.castBallot(v, 'p1', { approve: ['m0', 'nope', 'm0', '__proto__'], veto: 'm0' })
  assert.deepEqual(b.approve, ['m0'])
  assert.equal(b.veto, null)
  const b2 = g.castBallot(v, 'p1', { approve: ['m0'], veto: 'ghost' })
  assert.equal(b2.veto, null)
})

test('vote: a veto counts against a film, and a film most people vetoed is out', () => {
  const v = g.createVote(cands(3))
  g.castBallot(v, 'p1', { approve: ['m0', 'm1'], veto: 'm2' })
  g.castBallot(v, 'p2', { approve: ['m0'], veto: 'm1' })
  g.castBallot(v, 'p3', { approve: ['m1', 'm2'], veto: 'm0' })
  const d = g.decide(v, rng())
  // m0: 2 approvals - 1 veto = 1; m1: 2 - 1 = 1; m2: 1 - 1 = 0
  assert.ok(['m0', 'm1'].includes(d.winner))
  assert.equal(d.rows.find((r) => r.key === 'm2').net, 0)
  const v2 = g.createVote(cands(2))
  g.castBallot(v2, 'a', { approve: ['m0'], veto: 'm1' })
  g.castBallot(v2, 'b', { approve: ['m0'], veto: 'm1' })
  g.castBallot(v2, 'c', { approve: ['m1'], veto: 'm0' })
  const d2 = g.decide(v2, rng())
  assert.equal(d2.rows.find((r) => r.key === 'm1').out, true, 'vetoed by a majority')
  assert.equal(d2.winner, 'm0')
})

test('vote: if a majority vetoed everything, the vote still picks something', () => {
  const v = g.createVote(cands(2))
  g.castBallot(v, 'a', { veto: 'm0' })
  g.castBallot(v, 'b', { veto: 'm0' })
  g.castBallot(v, 'c', { veto: 'm1' })
  g.castBallot(v, 'd', { veto: 'm1' })
  assert.ok(['m0', 'm1'].includes(g.decide(v, rng()).winner))
})

test('vote: fewer vetoes breaks a tie before any coin is tossed', () => {
  const v = g.createVote(cands(3))
  g.castBallot(v, 'a', { approve: ['m0', 'm1'], veto: 'm2' })
  g.castBallot(v, 'b', { approve: ['m1', 'm2'] })
  g.castBallot(v, 'c', { approve: ['m0'], veto: 'm1' })
  g.castBallot(v, 'd', { approve: ['m0', 'm2'] })
  // approvals: m0 3, m1 2, m2 2 ; vetoes: m0 0, m1 1, m2 1 -> m0 wins outright
  assert.equal(g.decide(v, rng()).winner, 'm0')
  const w = g.createVote(cands(2))
  g.castBallot(w, 'a', { approve: ['m0'] })
  g.castBallot(w, 'b', { approve: ['m1'], veto: 'm0' })
  g.castBallot(w, 'c', { approve: ['m0', 'm1'] })
  // m0: 2 approvals - 1 veto = 1; m1: 2 approvals - 0 = 2 -> m1
  assert.equal(g.decide(w, rng()).winner, 'm1')
})

test('vote: a real tie is settled by a draw in which every tied film wins about equally often', () => {
  const trials = 6000
  const wins = { m0: 0, m1: 0, m2: 0, m3: 0 }
  for (let i = 0; i < trials; i++) {
    const v = g.createVote(cands(4))
    g.castBallot(v, 'a', { approve: ['m0', 'm1', 'm2'] }) // m3 nobody's choice
    const d = g.decide(v, g.seededRng(1000 + i))
    assert.equal(d.method, 'draw')
    assert.equal(d.tied.length, 3)
    wins[d.winner]++
  }
  assert.equal(wins.m3, 0)
  for (const k of ['m0', 'm1', 'm2']) {
    const share = wins[k] / trials
    assert.ok(share > 0.31 && share < 0.36, `${k} won ${(share * 100).toFixed(1)}% (should be about 33.3%)`)
  }
})

test('vote: the outcome does not depend on the order people voted in, or on who they are', () => {
  const ballots = [['ann', { approve: ['m0', 'm1'] }], ['bob', { approve: ['m1', 'm2'], veto: 'm0' }], ['cat', { approve: ['m2'] }], ['dan', { approve: ['m1'], veto: 'm3' }]]
  const outcome = (order, ids) => {
    const v = g.createVote(cands(4))
    order.forEach(([, b], i) => g.castBallot(v, ids ? ids[i] : order[i][0], b))
    const d = g.decide(v, rng(1))
    return JSON.stringify(d.rows.map((r) => [r.key, r.approvals, r.vetoes]))
  }
  const base = outcome(ballots)
  for (let i = 0; i < 10; i++) assert.equal(outcome(g.shuffle(ballots, rng(i))), base)
  assert.equal(outcome(ballots, ['w', 'x', 'y', 'z']), base)
})

test('vote: nobody voting is a draw, not a crash; only people still in the room are counted', () => {
  const v = g.createVote(cands(3))
  const d = g.decide(v, rng(4))
  assert.equal(d.method, 'draw-no-votes')
  assert.equal(d.tied.length, 3)
  g.castBallot(v, 'gone', { approve: ['m2'] })
  g.castBallot(v, 'here', { approve: ['m0'] })
  assert.equal(g.decide(v, rng(4), ['here']).winner, 'm0')
})

test('the real random source stays in range and is not stuck', () => {
  const r = g.cryptoRng()
  const seen = new Set()
  for (let i = 0; i < 400; i++) { const n = r.int(5); assert.ok(n >= 0 && n < 5); seen.add(n) }
  assert.equal(seen.size, 5)
  assert.equal(r.int(1), 0)
  const f = r.next()
  assert.ok(f >= 0 && f < 1)
})

// ---- the library adapter ----------------------------------------------------------------------------------

function pool(over = {}) {
  const f = fixtureLibrary()
  return lib.buildPool({ movies: f.movies, metaOf: f.metaOf, creditsOf: f.creditsOf, detailsOf: f.detailsOf, hasPoster: f.hasPoster, hasActorPhoto: f.hasActorPhoto, idOf: f.idOf, allow: () => true, cap: 'none', ...over })
}

test('library: builds the pool from cached metadata only and never carries a file path', () => {
  const { items } = pool()
  assert.equal(items.length, FILMS.length)
  const first = items[0]
  assert.equal(first.key, 'id1')
  assert.equal(first.year, 1994)
  assert.equal(first.poster, '/media/poster/1000.jpg')
  assert.equal(first.playHref, '/watch?id=id1')
  assert.ok(first.cast.length >= 3)
  assert.ok(!JSON.stringify(items).includes('/lib'), 'no library path in the pool')
  assert.ok(!JSON.stringify(items).includes('.mp4'))
  assert.ok(items[0].cast.some((c) => c.photo && c.photo.startsWith('/media/actor/')))
})

test('library: the host profile’s own limits decide what can appear', () => {
  const blocked = new Set(['id1', 'id2', 'id5'])
  const { items, stats } = pool({ allow: (id) => !blocked.has(id) })
  assert.ok(items.every((m) => !blocked.has(m.key)))
  assert.equal(items.length, FILMS.length - 3)
  assert.equal(stats.blocked, 3)
})

test('library: a rating cap keeps out anything above it, and unrated titles unless the owner allows them', () => {
  const g1 = pool({ cap: 'PG' }).items
  assert.ok(g1.every((m) => ['G', 'PG'].includes(m.rating)), g1.map((m) => m.rating).join())
  assert.equal(g1.length, FILMS.filter((f) => ['G', 'PG'].includes(f[4])).length)
  const r13 = pool({ cap: 'PG-13' }).items
  assert.ok(r13.every((m) => m.rating !== 'R'))
  const f = fixtureLibrary()
  const noRatings = lib.buildPool({ movies: f.movies, metaOf: (n) => ({ ...f.metaOf(n), certification: null }), creditsOf: f.creditsOf, detailsOf: () => ({}), idOf: f.idOf, allow: () => true, cap: 'PG' })
  assert.equal(noRatings.items.length, 0)
  assert.equal(noRatings.stats.unrated, FILMS.length)
  const lenient = lib.buildPool({ movies: f.movies, metaOf: (n) => ({ ...f.metaOf(n), certification: null }), creditsOf: f.creditsOf, detailsOf: () => ({}), idOf: f.idOf, allow: () => true, cap: 'PG', includeUnrated: true })
  assert.equal(lenient.items.length, FILMS.length)
  // With no cap at all, unrated titles are fine.
  assert.equal(lib.buildPool({ movies: f.movies, metaOf: (n) => ({ ...f.metaOf(n), certification: null }), creditsOf: f.creditsOf, detailsOf: () => ({}), idOf: f.idOf, allow: () => true, cap: 'none' }).items.length, FILMS.length)
})

test('library: a rating found only in the details cache still counts toward the cap', () => {
  const f = fixtureLibrary()
  const r = lib.buildPool({ movies: f.movies, metaOf: (n) => ({ ...f.metaOf(n), certification: null }), creditsOf: f.creditsOf, detailsOf: (id) => ({ tagline: '', certification: FILMS[Number(id) - 1000][4] }), idOf: f.idOf, allow: () => true, cap: 'G' })
  assert.ok(r.items.length >= 1 && r.items.every((m) => m.rating === 'G'))
})

test('library: text from files and metadata is cleaned, capped, and a duplicate TMDB id appears once', () => {
  const evil = { fileName: 'x.mp4', dir: '/d' }
  const r = lib.buildPool({
    movies: [evil, { fileName: 'dup.mp4', dir: '/d' }],
    metaOf: (n) => ({ id: 77, title: 'A‮b<script>alert(1)</script>' + 'x'.repeat(400), release_date: '2001-01-01', certification: 'PG', tagline: 'Tag line​ here' }),
    creditsOf: () => [{ id: 1, name: 'Zed‮ Ryder', character: 'C'.repeat(300) }],
    idOf: (m) => m.fileName, allow: () => true
  })
  assert.equal(r.items.length, 1)
  const m = r.items[0]
  assert.ok(m.title.length <= 120)
  assert.ok(!/[‮ ​]/.test(JSON.stringify(m)))
  assert.ok(m.cast[0].character.length <= 60)
})

test('library: taglines and ratings come from the details-page cache on disk, in any saved language, and a bad file is just empty', () => {
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-details-'))
  assert.equal(lib.readDetails(dir).size, 0, 'no details folder: nothing, no error')
  assert.equal(lib.readDetails(null).size, 0)
  fs.mkdirSync(path.join(dir, 'details'))
  fs.writeFileSync(path.join(dir, 'details', 'movies.fr_CA.json'), JSON.stringify({ v: 1, entries: { 77: { at: 1, v: { tagline: 'Une phrase‮', certification: 'PG' } } } }))
  const fr = lib.readDetails(dir)
  assert.equal(fr.get('77').certification, 'PG')
  assert.ok(!/‮/.test(fr.get('77').tagline))
  fs.writeFileSync(path.join(dir, 'details', 'movies.json'), JSON.stringify({ v: 1, entries: { 5: { at: 1, v: { tagline: 'Hello there', certification: 'G' } } } }))
  assert.equal(lib.readDetails(dir).get('5').tagline, 'Hello there', 'the default file wins')
  fs.writeFileSync(path.join(dir, 'details', 'movies.json'), '{ not json')
  assert.equal(lib.readDetails(dir).size, 0)
})

test('library: a title search only ever sees the pool it is given', () => {
  const { items } = pool({ allow: (id) => id !== 'id1' })
  assert.deepEqual(lib.searchPool(items, 'harbor'), [])
  assert.deepEqual(lib.searchPool(items, 'paper').map((r) => r.title), ['Paper Kites'])
  assert.deepEqual(lib.searchPool(items, 'a'), [], 'one letter matches nothing')
  assert.ok(lib.searchPool(items, 'e').length === 0)
  assert.ok(lib.searchPool(items, 'an').length <= 8)
})
