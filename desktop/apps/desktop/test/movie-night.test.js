// Movie Night room manager, on a fake clock: lifecycle, timing, pause, scoring by the clock, host hand-over, teams,
// the vote, permissions and rate limits. No HTTP, no timers, no I/O.
// Run: node --test test/movie-night.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const mn = require('../electron/movieNight')
const games = require('../electron/movieNightGames')
const { fixturePool } = require('./movie-night-fixture')

function harness(opts = {}) {
  const clock = { t: 1_000_000 }
  const pool = opts.pool || fixturePool()
  const m = mn.createMovieNight({
    now: () => clock.t,
    rng: games.seededRng(opts.seed || 42),
    getSettings: () => ({ ratingCap: 'none', ...(opts.settings || {}) }),
    getPool: async () => ({ items: pool, stats: {} }),
    rates: opts.rates
  })
  const advance = (ms) => { clock.t += ms; m.sweep() }
  return { m, clock, advance }
}

async function open(h, names = ['Sam', 'Kim', 'Lee'], extra = {}) {
  const made = await h.m.createRoom({ ip: '10.0.0.5', ...extra })
  assert.equal(made.ok, true, JSON.stringify(made))
  const room = h.m.findRoom(made.code)
  const guests = names.map((name, i) => {
    const j = h.m.join({ code: made.code, key: made.joinKey, name, ip: '10.0.0.' + (10 + i) })
    assert.equal(j.ok, true, JSON.stringify(j))
    return j
  })
  const view = (who) => h.m.viewFor(room, who === 'tv' ? 'tv' : 'guest', who === 'tv' ? null : room.guests.get(who.guestId))
  const act = (who, type, extra2) => h.m.act({ ticket: who === 'tv' ? made.ticket : who.ticket, type, ip: 'x', ...(extra2 || {}) })
  return { made, room, guests, view, act }
}

test('codes: 6 characters from an unambiguous alphabet, and tickets are 192-bit', async () => {
  const h = harness()
  const seen = new Set()
  for (let i = 0; i < 20; i++) {
    const made = await h.m.createRoom({ ip: 'a' + i })
    assert.match(made.code, /^[2-9A-HJ-NP-Z]{6}$/)
    assert.ok(!/[01OIL]/.test(made.code))
    assert.match(made.ticket, /^[A-Za-z0-9_-]{32}$/)
    assert.match(made.joinKey, /^[A-Za-z0-9_-]{16}$/)
    assert.notEqual(made.ticket, made.overlayTicket)
    seen.add(made.code)
  }
  assert.equal(seen.size, 20)
  assert.equal(mn.normalizeCode('ab c-234'), 'ABC234')
  for (const bad of ['', 'ABC', 'ABCDEFG', 'AB0DEF', 'ABIDEF', 'ab cd e', null, undefined, 5, {}]) assert.equal(mn.normalizeCode(bad), '')
})

test('joining: colours, unique nicknames, the first guest hosts, and the host hands over when they leave', async () => {
  const h = harness()
  const r = await open(h, ['Sam', 'Kim', 'sam'])
  assert.equal(r.guests[0].host, true)
  assert.equal(r.guests[1].host, false)
  assert.notEqual(r.guests[2].name.toLowerCase(), 'sam')
  const tv = r.view('tv')
  assert.equal(new Set(tv.guests.map((g) => g.color)).size, 3)
  assert.equal(tv.hostGuestId, r.guests[0].guestId)
  // Sam leaves: the longest-standing connected guest (Kim) is host.
  assert.equal((await r.act(r.guests[0], 'leave')).ok, true)
  assert.equal(r.view('tv').hostGuestId, r.guests[1].guestId)
  // A colour that is taken is not given twice, even when asked for.
  const j = h.m.join({ code: r.made.code, key: r.made.joinKey, name: 'Pat', colorId: 'sky', ip: '1' })
  const j2 = h.m.join({ code: r.made.code, key: r.made.joinKey, name: 'Ray', colorId: 'sky', ip: '2' })
  const cols = r.view('tv').guests.filter((g) => g.name === 'Pat' || g.name === 'Ray').map((g) => g.color)
  assert.equal(new Set(cols).size, 2)
  assert.ok(j.ok && j2.ok)
})

test('with "phone host" off, nobody but the TV can run the room', async () => {
  const h = harness({ settings: { phoneHost: false } })
  const r = await open(h, ['Sam'])
  assert.equal(r.guests[0].host, false)
  assert.equal((await r.act(r.guests[0], 'start', { game: 'cast-match' })).status, 403)
  assert.equal((await r.act('tv', 'start', { game: 'cast-match' })).ok, true)
})

test('a quiz runs on the clock: ask, reveal, next, scoreboard, then back to the lobby by itself', async () => {
  const h = harness({ settings: { games: ['cast-match', 'year-guess', 'pick-tonight'] } })
  const r = await open(h)
  assert.equal((await r.act('tv', 'start', { game: 'cast-match', rounds: 3 })).ok, true)
  assert.equal(r.room.phase, 'game')
  assert.equal(r.view('tv').game.index, 1)
  assert.equal(r.view('tv').game.phase, 'ask')
  // Nobody answers: the question times out into the reveal, the reveal into the next question.
  h.advance(games.DEFAULT_TIMING['cast-match'] + 1)
  assert.equal(r.view('tv').game.phase, 'reveal')
  h.advance(games.DEFAULT_TIMING.revealMs + 1)
  assert.equal(r.view('tv').game.index, 2)
  h.advance(20001); h.advance(6001)
  h.advance(20001); h.advance(6001)
  assert.equal(r.room.phase, 'scoreboard')
  const board = r.view('tv').scoreboard
  assert.equal(board.rows.length, 3)
  assert.ok(board.rows.every((x) => x.points === 0 && x.rank === 1), 'nobody scored: everyone shares first')
  h.advance(mn.LIMITS.scoreboardMs + 1)
  assert.equal(r.room.phase, 'lobby')
})

test('points follow the clock: an early right answer beats a late one, a wrong one scores nothing', async () => {
  const h = harness()
  const r = await open(h)
  await r.act('tv', 'start', { game: 'cast-match', rounds: 2 })
  const q = r.room.game.questions[0]
  const right = q.correctId
  const wrong = q.options.find((o) => o.id !== right).id
  const [sam, kim, lee] = r.guests
  await r.act(sam, 'answer', { value: right })
  h.advance(10000)
  await r.act(kim, 'answer', { value: right })
  await r.act(lee, 'answer', { value: wrong })
  // Everyone connected has answered only if they are connected: nobody has a stream, so wait out the timer.
  h.advance(q.timeMs)
  const res = r.view('tv').game.reveal.results
  const by = Object.fromEntries(res.map((x) => [x.id, x]))
  assert.equal(by[sam.guestId].points, 1000)
  assert.equal(by[kim.guestId].points, 800)
  assert.equal(by[lee.guestId].points, 0)
  assert.equal(by[lee.guestId].correct, false)
  // The totals carry over to the scoreboard and the running score.
  assert.equal(r.view('tv').guests.find((g) => g.id === sam.guestId).score, 1000)
})

test('the room reveals early once every connected player has answered', async () => {
  const h = harness()
  const r = await open(h, ['Sam', 'Kim'])
  const sinks = r.guests.map(() => ({ write() {}, close() {} }))
  r.guests.forEach((g, i) => h.m.attach({ ticket: g.ticket, sink: sinks[i] }))
  await r.act('tv', 'start', { game: 'before-after', rounds: 2 })
  const q = r.room.game.questions[0]
  await r.act(r.guests[0], 'answer', { value: q.correctId })
  h.advance(50)
  assert.equal(r.view('tv').game.phase, 'ask', 'still waiting for Kim')
  await r.act(r.guests[1], 'answer', { value: q.options[0].id })
  h.advance(50)
  assert.equal(r.view('tv').game.phase, 'reveal')
})

test('pause stops the clock and resume gives back exactly the time that was left', async () => {
  const h = harness()
  const r = await open(h)
  await r.act('tv', 'start', { game: 'name-that-movie', rounds: 2 })
  const total = r.room.game.questions[0].timeMs
  h.advance(10000)
  assert.equal((await r.act('tv', 'pause')).ok, true)
  assert.equal(r.view('tv').game.paused, true)
  assert.equal(r.view('tv').game.remainingMs, total - 10000)
  h.advance(60000) // a long pause: nothing happens
  assert.equal(r.view('tv').game.phase, 'ask')
  assert.equal((await r.act(r.guests[0], 'answer', { value: 'a' })).status, 409, 'no answers while paused')
  assert.equal((await r.act('tv', 'resume')).ok, true)
  assert.equal(r.view('tv').game.paused, false)
  h.advance(total - 10000 - 1)
  assert.equal(r.view('tv').game.phase, 'ask')
  h.advance(2)
  assert.equal(r.view('tv').game.phase, 'reveal')
})

test('Name That Movie reveals its clues stage by stage as the clock runs', async () => {
  const h = harness()
  const r = await open(h)
  await r.act('tv', 'start', { game: 'name-that-movie', rounds: 1 })
  const q = r.room.game.questions[0]
  const stageOf = () => r.view('tv').game.question.stage
  assert.equal(stageOf(), 0)
  assert.equal(r.view('tv').game.question.clues.length, 0)
  h.advance(q.timeMs * 0.4)
  assert.equal(stageOf(), 1)
  h.advance(q.timeMs * 0.25)
  assert.equal(stageOf(), 2)
  h.advance(q.timeMs * 0.2)
  assert.equal(stageOf(), 3)
  assert.ok(r.view('tv').game.question.clues.length >= 1)
})

test('skip moves through ask -> reveal -> next; end game gives the scoreboard; the host can go back to the lobby', async () => {
  const h = harness()
  const r = await open(h)
  await r.act('tv', 'start', { game: 'year-guess', rounds: 3 })
  await r.act(r.guests[1], 'skip').then((x) => assert.equal(x.status, 403))
  assert.equal((await r.act(r.guests[0], 'skip')).ok, true)
  assert.equal(r.view('tv').game.phase, 'reveal')
  assert.equal((await r.act(r.guests[0], 'next')).ok, true)
  assert.equal(r.view('tv').game.index, 2)
  assert.equal((await r.act('tv', 'endGame')).ok, true)
  assert.equal(r.room.phase, 'scoreboard')
  assert.equal((await r.act('tv', 'lobby')).ok, true)
  assert.equal(r.room.phase, 'lobby')
  assert.equal(r.room.game, null)
})

test('a year guess: the closest player wins the round', async () => {
  const h = harness()
  const r = await open(h)
  await r.act('tv', 'start', { game: 'year-guess', rounds: 1 })
  const q = r.room.game.questions[0]
  assert.equal((await r.act(r.guests[0], 'answer', { value: q.max + 1 })).status, 400)
  assert.equal((await r.act(r.guests[0], 'answer', { value: q.correctYear })).ok, true)
  assert.equal((await r.act(r.guests[1], 'answer', { value: Math.min(q.max, q.correctYear + 6) })).ok, true)
  await r.act('tv', 'skip')
  const res = r.view('tv').game.reveal.results
  const a = res.find((x) => x.id === r.guests[0].guestId)
  const b = res.find((x) => x.id === r.guests[1].guestId)
  assert.equal(a.points, 1000)
  assert.ok(b.points < a.points)
  assert.equal(res.find((x) => x.id === r.guests[2].guestId).points, 0)
})

test('teams: balanced, follow joins, shuffle fairly, score as an average', async () => {
  const h = harness()
  const r = await open(h, ['A', 'B', 'C', 'D', 'E'])
  assert.equal((await r.act('tv', 'teams', { teams: 2 })).ok, true)
  const sizes = () => [0, 1].map((t) => r.view('tv').guests.filter((g) => g.team === t).length)
  assert.deepEqual(sizes().sort(), [2, 3])
  h.m.join({ code: r.made.code, key: r.made.joinKey, name: 'F', ip: 'f' })
  assert.deepEqual(sizes(), [3, 3], 'a newcomer joins the smaller team')
  assert.equal((await r.act('tv', 'teams', { teams: 5 })).status, 400)
  assert.equal((await r.act('tv', 'shuffleTeams')).ok, true)
  assert.deepEqual(sizes(), [3, 3])
  // Team scores are averages.
  r.room.guests.forEach((g) => { g.total = g.team === 0 ? 300 : 100 })
  const teams = r.view('tv').teams
  assert.equal(teams[0].score, 300)
  assert.equal(teams[1].score, 100)
  // You cannot change teams in the middle of a game.
  await r.act('tv', 'start', { game: 'year-guess', rounds: 1 })
  assert.equal((await r.act('tv', 'teams', { teams: 3 })).status, 409)
  await r.act('tv', 'endGame')
  const sb = r.view('tv').scoreboard
  assert.equal(sb.teams.length, 2)
})

test('the vote: ballots, the result, a tie settled by the room’s random source, and the film is remembered for "play it"', async () => {
  const h = harness()
  const r = await open(h)
  assert.equal((await r.act('tv', 'start', { game: 'pick-tonight' })).ok, true)
  const g = r.view('tv').game
  assert.equal(g.kind, 'vote')
  assert.equal(g.candidates.length, 5)
  const keys = g.candidates.map((c) => c.key)
  assert.equal((await r.act(r.guests[0], 'vote', { approve: [keys[1]], veto: keys[0] })).ok, true)
  assert.equal((await r.act(r.guests[1], 'vote', { approve: [keys[1], keys[2]] })).ok, true)
  assert.equal((await r.act(r.guests[2], 'vote', { approve: [keys[2]] })).ok, true)
  // a guest sees their own ballot but never anybody else's
  assert.deepEqual(r.view(r.guests[0]).game.mine.ballot.approve, [keys[1]])
  assert.ok(!JSON.stringify(r.view(r.guests[0]).game).includes(r.guests[1].guestId))
  await r.act('tv', 'skip')
  assert.equal(r.room.phase, 'result')
  const res = r.view('tv').game
  assert.ok([keys[1], keys[2]].includes(res.winner.key))
  assert.ok(['votes', 'fewest-vetoes', 'draw'].includes(res.decision.method))
  assert.equal(r.room.featured.key, res.winner.key)
  assert.match(r.room.featured.playHref, /^\/watch\?id=/)
  // voting is closed now
  assert.equal((await r.act(r.guests[0], 'vote', { approve: [keys[3]] })).status, 409)
})

test('the vote ends by itself when everyone connected has voted, or when time is up', async () => {
  const h = harness()
  const r = await open(h, ['Sam', 'Kim'])
  r.guests.forEach((g) => h.m.attach({ ticket: g.ticket, sink: { write() {}, close() {} } }))
  await r.act('tv', 'start', { game: 'pick-tonight' })
  const keys = r.view('tv').game.candidates.map((c) => c.key)
  await r.act(r.guests[0], 'vote', { approve: [keys[0]], done: true })
  h.advance(100)
  await r.act(r.guests[1], 'vote', { approve: [keys[0]] }) // voted but has not pressed Send: the vote stays open
  h.advance(100)
  assert.equal(r.room.phase, 'game')
  await r.act(r.guests[1], 'vote', { approve: [keys[0]], done: true })
  h.advance(100)
  assert.equal(r.room.phase, 'result')
  await r.act('tv', 'lobby')
  await r.act('tv', 'start', { game: 'pick-tonight' })
  h.advance(mn.LIMITS.voteMs + 1)
  assert.equal(r.room.phase, 'result')
  h.advance(3 * 60 * 1000 + 1)
  assert.equal(r.room.phase, 'lobby')
})

test('an intermission quiz starts with questions about the featured film', async () => {
  const h = harness()
  const r = await open(h, ['Sam'], { featured: { key: 'id4' } })
  assert.equal(r.room.featured.key, 'id4')
  assert.equal((await r.act('tv', 'start', { game: 'intermission' })).ok, true)
  assert.equal(r.room.game.questions[0].subject, 'id4')
  assert.equal(r.room.game.questions.length, 3)
})

test('the owner’s settings limit which games can start', async () => {
  const h = harness({ settings: { games: ['year-guess'] } })
  const r = await open(h, ['Sam'])
  assert.equal((await r.act('tv', 'start', { game: 'cast-match' })).status, 403)
  assert.equal((await r.act('tv', 'start', { game: 'nonsense' })).status, 400)
  assert.deepEqual(r.view('tv').menu.map((m) => m.id), ['year-guess'])
  assert.equal((await r.act('tv', 'start', { game: 'year-guess' })).ok, true)
  assert.equal((await r.act('tv', 'start', { game: 'year-guess' })).status, 409, 'one game at a time')
})

test('max guests from the owner’s settings is honoured', async () => {
  const h = harness({ settings: { maxGuests: 3 } })
  const r = await open(h, ['A', 'B', 'C'])
  const over = h.m.join({ code: r.made.code, key: r.made.joinKey, name: 'D', ip: 'q' })
  assert.equal(over.status, 409)
  assert.equal(over.error, 'room_full')
  const clamp = mn.normalizeSettings({ maxGuests: 99 })
  assert.equal(clamp.maxGuests, 12)
  assert.equal(mn.normalizeSettings({ maxGuests: 0 }).maxGuests, 1)
  assert.equal(mn.normalizeSettings({ ratingCap: 'XXX' }).ratingCap, 'PG-13')
  assert.equal(mn.normalizeSettings({ games: ['cast-match', 'hax', 'intermission'] }).games.join(), 'cast-match')
  assert.equal(mn.normalizeSettings(null).enabled, true)
})

test('a room with too few films says so instead of starting a broken game', async () => {
  const h = harness({ pool: fixturePool({ count: 2 }) })
  const r = await open(h, ['Sam'])
  const menu = r.view('tv').menu
  assert.ok(menu.find((m) => m.id === 'pick-tonight').ready === false)
  assert.ok(r.view('tv').pool.message.length > 10)
  const bad = await r.act('tv', 'start', { game: 'pick-tonight' })
  assert.equal(bad.status, 409)
  assert.equal(bad.error, 'not_enough_titles')
})

test('you cannot start a game with nobody in the room', async () => {
  const h = harness()
  const r = await open(h, [])
  assert.equal((await r.act('tv', 'start', { game: 'cast-match' })).error, 'no_players')
})

test('kick and ban: the ticket dies, the same name from the same address cannot return, a lock keeps everyone out', async () => {
  const h = harness()
  const r = await open(h, ['Sam', 'Kim'])
  const sink = { events: [], write(e) { this.events.push(e) }, close() { this.closed = true } }
  h.m.attach({ ticket: r.guests[1].ticket, sink })
  assert.equal((await r.act('tv', 'kick', { target: r.guests[1].guestId })).ok, true)
  assert.ok(sink.events.includes('kicked'))
  assert.ok(sink.closed)
  assert.equal((await r.act(r.guests[1], 'react', { emoji: '👍' })).status, 404)
  const back = h.m.join({ code: r.made.code, key: r.made.joinKey, name: 'Kim', ip: '10.0.0.11' })
  assert.equal(back.ok, false)
  const elsewhere = h.m.join({ code: r.made.code, key: r.made.joinKey, name: 'Kim', ip: '10.0.0.99' })
  assert.equal(elsewhere.ok, true, 'the ban is for that phone (address + name), not the name for everyone')
  await r.act('tv', 'lock', { value: true })
  assert.equal(h.m.join({ code: r.made.code, key: r.made.joinKey, name: 'Zed', ip: 'z' }).error, 'locked_room')
  await r.act('tv', 'lock', { value: false })
  assert.equal(h.m.join({ code: r.made.code, key: r.made.joinKey, name: 'Zed', ip: 'z' }).ok, true)
})

test('making someone else host works, and the old host keeps playing', async () => {
  const h = harness()
  const r = await open(h, ['Sam', 'Kim'])
  assert.equal((await r.act(r.guests[0], 'makeHost', { target: r.guests[1].guestId })).ok, true)
  assert.equal(r.view('tv').hostGuestId, r.guests[1].guestId)
  assert.equal((await r.act(r.guests[0], 'lock', { value: true })).status, 403)
  assert.equal((await r.act(r.guests[1], 'lock', { value: true })).ok, true)
})

test('rename and recolour: unique, validated, and only for yourself', async () => {
  const h = harness()
  const r = await open(h, ['Sam', 'Kim'])
  assert.equal((await r.act(r.guests[0], 'rename', { name: 'Kim' })).status, 409)
  assert.equal((await r.act(r.guests[0], 'rename', { name: 'www.spam.com' })).status, 400)
  assert.equal((await r.act(r.guests[0], 'rename', { name: 'Sammy' })).name, 'Sammy')
  const kimColor = r.view('tv').guests.find((g) => g.name === 'Kim')
  const taken = mn.COLORS.find((c) => c.hex === kimColor.color)
  assert.equal((await r.act(r.guests[0], 'color', { colorId: taken.id })).status, 409)
  assert.equal((await r.act(r.guests[0], 'color', { colorId: 'nonsense' })).status, 400)
})

test('rooms are isolated: a ticket only ever works in its own room', async () => {
  const h = harness()
  const a = await open(h, ['Sam'])
  const b = await h.m.createRoom({ ip: '9.9.9.9' })
  const roomB = h.m.findRoom(b.code)
  assert.notEqual(a.made.code, b.code)
  // Sam's ticket cannot drive room B, and B's TV cannot read room A.
  const seenByA = h.m.lookup(a.guests[0].ticket)
  assert.equal(seenByA.room.code, a.made.code)
  assert.equal(h.m.lookup(b.ticket).room, roomB)
  assert.equal(h.m.poll({ ticket: b.ticket }).state.code, b.code)
  assert.equal(h.m.lookup('x'.repeat(32)), null)
  assert.equal(h.m.lookup(undefined), null)
  assert.equal(h.m.lookup({ toString: () => a.made.ticket }), null, 'only real strings')
})

test('limits: rooms per address, total rooms, create rate; the oldest of your own rooms makes way', async () => {
  const h = harness()
  const codes = []
  for (let i = 0; i < 3; i++) { h.clock.t += 1000; codes.push((await h.m.createRoom({ ip: '1.1.1.1' })).code) }
  assert.equal(h.m.stats().rooms, 3)
  h.clock.t += 1000
  const fourth = await h.m.createRoom({ ip: '1.1.1.1' })
  assert.equal(fourth.ok, true)
  assert.equal(h.m.findRoom(codes[0]), null, 'the oldest room was closed to make way')
  assert.equal(h.m.stats().rooms, 3)
  // Create rate: 8 per hour per address (the 9th is refused).
  const h2 = harness()
  let refused = 0
  for (let i = 0; i < 12; i++) { const r = await h2.m.createRoom({ ip: '2.2.2.2' }); if (!r.ok) refused++ }
  assert.ok(refused >= 3, 'refused ' + refused)
  // Total rooms
  const h3 = harness({ rates: { create: 1000 } })
  let made = 0
  for (let i = 0; made < 60 && i < 100; i++) { const r = await h3.m.createRoom({ ip: '3.3.' + Math.floor(i / 3) + '.' + (i % 3) }); if (r.ok) made++ }
  const full = await h3.m.createRoom({ ip: '4.4.4.4' })
  assert.equal(full.status, 503)
})

test('rate limits: joins, wrong codes, answers and actions are throttled per source', async () => {
  const h = harness({ rates: { join: 5, attempts: 4, act: 10, answer: 3 } })
  const made = await h.m.createRoom({ ip: 'tv' })
  for (let i = 0; i < 5; i++) assert.equal(h.m.join({ code: made.code, key: made.joinKey, name: 'G' + i, ip: '5.5.5.5' }).ok, true)
  assert.equal(h.m.join({ code: made.code, key: made.joinKey, name: 'G9', ip: '5.5.5.5' }).error, 'rate_limited')
  for (let i = 0; i < 4; i++) assert.equal(h.m.join({ code: 'ZZZZZZ', key: made.joinKey, name: 'X', ip: '6.6.6.6' }).error, 'not_found')
  assert.equal(h.m.join({ code: 'ZZZZZZ', key: made.joinKey, name: 'X', ip: '6.6.6.6' }).error, 'locked')
  h.clock.t += 16 * 60 * 1000
  assert.equal(h.m.join({ code: made.code, key: made.joinKey, name: 'Now ok', ip: '6.6.6.6' }).ok, true, 'the lock-out ends')
  const g = h.m.join({ code: made.code, key: made.joinKey, name: 'Busy', ip: '7.7.7.7' })
  let limited = 0
  for (let i = 0; i < 14; i++) if ((await h.m.act({ ticket: g.ticket, type: 'ping', ip: '7' })).status === 429) limited++
  assert.ok(limited >= 4)
})

test('empty rooms end: after ten minutes with nobody connected, and after ten hours regardless', async () => {
  const h = harness()
  const r = await open(h, ['Sam'])
  assert.equal(h.m.stats().rooms, 1)
  h.advance(mn.LIMITS.emptyMs - 1000)
  assert.equal(h.m.stats().rooms, 1)
  h.advance(2000)
  assert.equal(h.m.stats().rooms, 0)
  assert.equal(h.m.poll({ ticket: r.made.ticket }).status, 404)
  // A TV that stays connected keeps its room alive... until it is 10 hours old.
  const r2 = await open(h, ['Kim'])
  h.m.attach({ ticket: r2.made.ticket, sink: { write() {}, close() {} } })
  h.advance(mn.LIMITS.emptyMs * 3)
  assert.equal(h.m.stats().rooms, 1)
  h.advance(mn.LIMITS.maxAgeMs)
  assert.equal(h.m.stats().rooms, 0)
})

test('closing a room tells every screen, drops every ticket and forgets everything', async () => {
  const h = harness()
  const r = await open(h, ['Sam'])
  const events = []
  const sink = { write(e, d) { events.push(e) }, close() { events.push('sink-closed') } }
  h.m.attach({ ticket: r.made.ticket, sink })
  assert.equal((await r.act('tv', 'close')).ok, true)
  assert.ok(events.includes('closed'))
  assert.ok(events.includes('sink-closed'))
  assert.equal(h.m.lookup(r.guests[0].ticket), null)
  assert.equal(h.m.lookup(r.made.overlayTicket), null)
  assert.equal(h.m.stats().tokens, 0)
})

test('streams: a state on connect, changes as they happen, and a broken sink is dropped without hurting the room', async () => {
  const h = harness()
  const r = await open(h, ['Sam', 'Kim'])
  const good = { events: [], write(e, d) { this.events.push([e, JSON.parse(d)]) }, close() {} }
  const bad = { write() { throw new Error('socket gone') }, close() {} }
  const a = h.m.attach({ ticket: r.guests[0].ticket, sink: good })
  assert.equal(a.ok, true)
  assert.equal(good.events[0][0], 'state')
  assert.equal(good.events[0][1].me.name, 'Sam')
  const b = h.m.attach({ ticket: r.guests[1].ticket, sink: bad })
  assert.equal(b.ok, false, 'a sink that cannot take the first frame is refused')
  await r.act(r.guests[0], 'rename', { name: 'Samuel' })
  assert.equal(good.events.at(-1)[1].me.name, 'Samuel')
  const before = good.events.length
  a.detach()
  await r.act(r.guests[0], 'rename', { name: 'Sam again' })
  assert.equal(good.events.length, before, 'nothing is sent after a stream is detached')
  // A guest may have two streams (a phone reload); a third pushes the oldest out.
  const closedFirst = { write() {}, close() { this.gone = true } }
  h.m.attach({ ticket: r.guests[0].ticket, sink: closedFirst })
  h.m.attach({ ticket: r.guests[0].ticket, sink: { write() {}, close() {} } })
  h.m.attach({ ticket: r.guests[0].ticket, sink: { write() {}, close() {} } })
  assert.equal(closedFirst.gone, true)
})

test('answers never leak: no screen gets the answer before the reveal, TV or phone', async () => {
  const h = harness()
  const r = await open(h)
  const seen = []
  const collect = (label) => ({ write(e, d) { seen.push([label, e, d]) }, close() {} })
  h.m.attach({ ticket: r.made.ticket, sink: collect('tv') })
  r.guests.forEach((g, i) => h.m.attach({ ticket: g.ticket, sink: collect('g' + i) }))
  for (const type of ['name-that-movie', 'cast-match', 'year-guess', 'before-after', 'trivia-night']) {
    await r.act('tv', 'start', { game: type, rounds: 3 })
    const q = r.room.game.questions[0]
    const secret = q.type === 'year-guess' ? '"correctYear"' : '"correctId"'
    // ask phase frames
    for (const [, , d] of seen.slice(-12)) {
      const g = JSON.parse(d).game
      if (g && g.phase === 'ask') assert.ok(!d.includes(secret) && !d.includes('correctText'), type + ' leaked in ask')
    }
    await r.act('tv', 'skip')
    await r.act('tv', 'endGame')
    await r.act('tv', 'lobby')
  }
  assert.ok(seen.length > 20)
})

test('reactions go to the TV and the overlay, never to other phones', async () => {
  const h = harness()
  const r = await open(h)
  const heard = { tv: [], overlay: [], guest: [] }
  const mk = (k) => ({ write(e, d) { if (e === 'reaction') heard[k].push(JSON.parse(d)) }, close() {} })
  h.m.attach({ ticket: r.made.ticket, sink: mk('tv') })
  h.m.attach({ ticket: r.made.overlayTicket, sink: mk('overlay') })
  h.m.attach({ ticket: r.guests[1].ticket, sink: mk('guest') })
  assert.equal((await r.act(r.guests[0], 'react', { emoji: '❤️' })).ok, true)
  assert.equal(heard.tv.length, 1)
  assert.equal(heard.overlay.length, 1)
  assert.equal(heard.guest.length, 0)
  assert.equal(heard.overlay[0].name, 'Sam')
  assert.deepEqual(Object.keys(heard.overlay[0]).sort(), ['at', 'color', 'emoji', 'glyph', 'name'], 'a reaction carries no ids')
  // the room-wide cap stops a crowd from flooding the screen
  const h2 = harness({ rates: { react: 100, roomReact: 5 } })
  const r2 = await open(h2, ['A', 'B'])
  let ok = 0
  for (let i = 0; i < 12; i++) if ((await r2.act(r2.guests[i % 2], 'react', { emoji: '😂' })).ok) ok++
  assert.equal(ok, 5)
})

test('launch needs a film; the address is always a local player path', async () => {
  const h = harness()
  const r = await open(h, ['Sam'])
  assert.equal((await r.act('tv', 'launch')).status, 409)
  const withFilm = await open(h, ['Sam'], { featured: { key: 'id2' } })
  const seen = []
  h.m.attach({ ticket: withFilm.made.ticket, sink: { write(e, d) { seen.push([e, d]) }, close() {} } })
  const l = await withFilm.act('tv', 'launch')
  assert.equal(l.href, '/watch?id=id2')
  assert.ok(seen.some(([e, d]) => e === 'launch' && JSON.parse(d).href === '/watch?id=id2'))
  // A featured key that is not a plain id cannot be used to build a link that leaves the server.
  const evil = await h.m.createRoom({ ip: 'e', featured: { key: 'http://evil.example/x', title: 'x' } })
  const room = h.m.findRoom(evil.code)
  assert.ok(!room.featured || room.featured.playHref.startsWith('/watch?id=http%3A'), 'encoded, never a raw URL')
})
