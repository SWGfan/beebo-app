// Watch together: the room manager, the timing maths shared with the browser, the SSE framing, and the
// "names and chat are only ever data" guarantees. No server, no network: an injected clock.
// Run: node --test test/watch-together.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const wt = require('../electron/watchTogether')
const sync = require('../electron/watchTogetherSync')
const httpLayer = require('../electron/watchTogetherHttp')
const web = require('../electron/watchTogetherWeb')

const MEDIA = { kind: 'movie', id: Buffer.from('Clip (2020).mkv').toString('base64url'), title: 'Clip' }

// Character classes are built from code points, so this file holds no escape sequences to be mangled.
const chr = (n) => String.fromCharCode(n)
const classOf = (ranges) => new RegExp("[" + ranges.map((r) => r.split("-").map((h) => chr(92) + "u" + h).join("-")).join("") + "]")
const INVISIBLE_RE = classOf(['0000-001f', '007f-009f', '200b-200f', '2028-202e', '2060-206f', 'feff'])
const LINE_CTRL_RE = new RegExp(classOf(['0000-001f', '007f-009f', '2028-2029']).source, 'g')
const CHAT_BAD_RE = classOf(['0000-001f', '2028-2029', '202a-202e'])
const U = (id, name) => ({ id, name: name || id })

function harness(opts = {}) {
  const clock = { t: 1_000_000 }
  const m = wt.createWatchTogether({
    now: () => clock.t,
    canView: opts.canView,
    rates: { command: 100000, ready: 100000, ...(opts.rates || {}) },
    log: opts.log
  })
  const sinks = new Map()
  const sinkFor = (userId, code) => {
    const rec = { events: [], closed: false }
    const sink = { write: (event, data, id) => rec.events.push({ event, data: JSON.parse(data), id }), close: () => { rec.closed = true } }
    const at = m.attach({ userId, code, sink })
    assert.ok(at.ok, 'attach ' + JSON.stringify(at))
    rec.detach = at.detach
    sinks.set(userId, rec)
    return rec
  }
  const room = async (settings) => {
    const made = await m.createRoom({ user: U('host', 'Host'), media: MEDIA, settings })
    assert.ok(made.ok, JSON.stringify(made))
    return made
  }
  const join = async (id, code, name) => {
    const r = await m.join({ user: U(id, name), code, ip: '10.0.0.' + (id.length % 200) })
    assert.ok(r.ok, JSON.stringify(r))
    return r
  }
  const advance = (ms) => { clock.t += ms }
  return { m, clock, advance, room, join, sinkFor, sinks }
}
const state = (h, code) => h.m._rooms.get(code)
const tl = (h, code) => ({ ...state(h, code).timeline })

// ---------------------------------------------------------------- codes
test('room codes: 128 random bits, unambiguous alphabet, never repeated, forgiving to type', () => {
  const seen = new Set()
  for (let i = 0; i < 2000; i++) {
    const c = wt.generateCode()
    assert.match(c, wt.CODE_RE)
    assert.equal(c.length, 26)
    seen.add(c)
  }
  assert.equal(seen.size, 2000)
  // 26 characters x 5 bits = 130 bits >= the 128 random bits that went in; all-ones and all-zeros both encode.
  assert.match(wt.generateCode(() => Buffer.alloc(16, 0xff)), wt.CODE_RE)
  assert.equal(wt.generateCode(() => Buffer.alloc(16, 0)), '0'.repeat(26))
  const c = wt.generateCode()
  assert.equal(wt.normalizeCode(c.toLowerCase()), c)
  assert.equal(wt.normalizeCode(c.slice(0, 13) + '-' + c.slice(13)), c)
  assert.equal(wt.normalizeCode(' ' + c + ' '), c)
  for (const bad of ['', 'short', 'x'.repeat(25), c + 'A', null, undefined, 42, {}, 'U'.repeat(26)]) assert.equal(wt.normalizeCode(bad), '', String(bad))
})

// ---------------------------------------------------------------- lifecycle
test('lifecycle: create, join, leave, host handover, room ends when empty', async () => {
  const logs = []
  const h = harness({ log: (l) => logs.push(l) })
  const made = await h.room()
  assert.equal(made.room.participants.length, 1)
  assert.equal(made.room.hostPid, made.pid)
  assert.equal(made.room.timeline.state, 'paused')
  const b = await h.join('bob', made.code, 'Bob')
  const c = await h.join('cy', made.code, 'Cy')
  assert.equal(b.room.participants.length, 2)
  assert.equal(c.room.participants.length, 3)
  assert.equal(b.room.participants.find((p) => p.pid === b.pid).role, 'guest')

  // A guest leaving changes nothing about the host.
  assert.ok(h.m.leave({ userId: 'cy', code: made.code }).ok)
  assert.equal(state(h, made.code).participants.size, 2)
  assert.equal(state(h, made.code).hostPid, made.pid)
  // The host leaving hands the room to someone still there.
  assert.ok(h.m.leave({ userId: 'host', code: made.code }).ok)
  assert.equal(state(h, made.code).hostPid, b.pid)
  // The last one out closes it.
  assert.ok(h.m.leave({ userId: 'bob', code: made.code }).ok)
  assert.equal(h.m.roomCount(), 0)
  assert.equal((await h.m.join({ user: U('cy'), code: made.code })).error, 'not_found')
  // A person can be in a room only once: joining again is the same seat.
  const made2 = await h.room()
  const again = await h.m.join({ user: U('host', 'Host'), code: made2.code })
  assert.equal(again.pid, made2.pid)
  assert.equal(state(h, made2.code).participants.size, 1)
  // Logs never carry the code or a name.
  assert.ok(logs.length > 0)
  for (const l of logs) { assert.ok(!l.includes(made.code) && !l.includes(made2.code), l); assert.doesNotMatch(l, /Bob|Cy|Host/) }
})

test('nobody anonymous: every call needs a signed-in person', async () => {
  const h = harness()
  const made = await h.room()
  assert.equal((await h.m.createRoom({ user: null, media: MEDIA })).status, 401)
  assert.equal((await h.m.join({ user: null, code: made.code })).status, 401)
  assert.equal((await h.m.join({ user: {}, code: made.code })).status, 401)
  assert.equal((await h.m.preview({ user: null, code: made.code })).status, 401)
  // Somebody signed in but not in the room can do nothing in it.
  for (const r of [
    h.m.command({ userId: 'stranger', code: made.code, cmd: { type: 'pause' } }),
    h.m.chat({ userId: 'stranger', code: made.code, text: 'hi' }),
    h.m.react({ userId: 'stranger', code: made.code, emoji: '👍' }),
    h.m.ready({ userId: 'stranger', code: made.code, ready: true, seq: 1 }),
    h.m.setSettings({ userId: 'stranger', code: made.code, settings: { control: 'everyone' } }),
    h.m.kick({ userId: 'stranger', code: made.code, target: made.pid }),
    h.m.close({ userId: 'stranger', code: made.code }),
    h.m.leave({ userId: 'stranger', code: made.code }),
    h.m.poll({ userId: 'stranger', code: made.code }),
    h.m.attach({ userId: 'stranger', code: made.code, sink: { write() {} } })
  ]) assert.equal(r.status, 404)
  assert.equal(h.m.roomCount(), 1)
})

test('a title the person may not watch (parental controls, missing file) cannot be opened or joined', async () => {
  const h = harness({ canView: async (userId, kind, id) => (userId === 'kid' ? { ok: false } : id === 'bad' ? { ok: false } : { ok: true, title: 'From library' }) })
  assert.equal((await h.m.createRoom({ user: U('kid'), media: MEDIA })).error, 'unavailable')
  assert.equal((await h.m.createRoom({ user: U('host'), media: { kind: 'movie', id: 'bad' } })).error, 'unavailable')
  const made = await h.m.createRoom({ user: U('host'), media: { kind: 'movie', id: MEDIA.id } })
  assert.ok(made.ok)
  assert.equal(made.room.media.title, 'From library', 'a title the client did not name is taken from the library')
  const j = await h.m.join({ user: U('kid'), code: made.code })
  assert.equal(j.error, 'unavailable')
  assert.equal(state(h, made.code).participants.size, 1)
  // Changing the title to one somebody in the room may not watch is checked for the person changing it.
  assert.equal((await h.m.changeMedia({ userId: 'host', code: made.code, media: { kind: 'movie', id: 'bad' } })).error, 'unavailable')
})

// ---------------------------------------------------------------- permissions
test('permissions: the host drives; "everyone can control" opens play/pause/seek/rate but never host powers', async () => {
  const h = harness()
  const made = await h.room()
  const bob = await h.join('bob', made.code, 'Bob')
  const cy = await h.join('cy', made.code, 'Cy')
  const seeked = { userId: 'bob', code: made.code, cmd: { type: 'seek', pos: 30 } }
  const r = h.m.command(seeked)
  assert.equal(r.status, 403)
  assert.equal(r.error, 'not_allowed')
  assert.equal(tl(h, made.code).anchorPos, 0, 'a refused command changes nothing')
  assert.equal(h.m.command({ userId: 'host', code: made.code, cmd: { type: 'seek', pos: 30 } }).ok, true)
  assert.equal(tl(h, made.code).anchorPos, 30)

  // Chat and reactions are for everyone regardless.
  assert.ok(h.m.chat({ userId: 'bob', code: made.code, text: 'hello' }).ok)
  assert.ok(h.m.react({ userId: 'bob', code: made.code, emoji: '🔥' }).ok)

  // Only the host changes settings...
  assert.equal(h.m.setSettings({ userId: 'bob', code: made.code, settings: { control: 'everyone' } }).status, 403)
  assert.ok(h.m.setSettings({ userId: 'host', code: made.code, settings: { control: 'everyone' } }).ok)
  assert.equal(h.m.command({ userId: 'bob', code: made.code, cmd: { type: 'seek', pos: 45 } }).ok, true)
  assert.equal(tl(h, made.code).anchorPos, 45)
  // ...and even then only the host kicks, hands over, closes or changes the title.
  assert.equal(h.m.kick({ userId: 'bob', code: made.code, target: cy.pid }).status, 403)
  assert.equal(h.m.transferHost({ userId: 'bob', code: made.code, target: bob.pid }).status, 403)
  assert.equal(h.m.close({ userId: 'bob', code: made.code }).status, 403)
  assert.equal(state(h, made.code).participants.size, 3)
  // Back to host-only: bob is refused again.
  h.m.setSettings({ userId: 'host', code: made.code, settings: { control: 'host' } })
  assert.equal(h.m.command({ userId: 'bob', code: made.code, cmd: { type: 'pause' } }).status, 403)
  // Bad values are ignored, not stored.
  h.m.setSettings({ userId: 'host', code: made.code, settings: { control: 'root', waitForBuffering: 'yes', chat: 5 } })
  assert.deepEqual(state(h, made.code).settings, { control: 'host', waitForBuffering: true, chat: true })
})

test('kick bars that person from the room; transfer and close are the host\'s', async () => {
  const h = harness()
  const made = await h.room()
  const bob = await h.join('bob', made.code, 'Bob')
  const bobSink = h.sinkFor('bob', made.code)
  assert.equal(h.m.kick({ userId: 'host', code: made.code, target: made.pid }).error, 'cannot_kick_self')
  assert.equal(h.m.kick({ userId: 'host', code: made.code, target: 'nobody' }).error, 'no_such_participant')
  assert.ok(h.m.kick({ userId: 'host', code: made.code, target: bob.pid }).ok)
  assert.ok(bobSink.events.some((e) => e.event === 'kicked'))
  assert.equal(bobSink.closed, true)
  assert.equal(h.m.command({ userId: 'bob', code: made.code, cmd: { type: 'pause' } }).status, 404)
  // Trying the code again looks exactly like a room that does not exist.
  assert.equal((await h.m.join({ user: U('bob'), code: made.code })).error, 'not_found')
  const cy = await h.join('cy', made.code, 'Cy')
  assert.ok(h.m.transferHost({ userId: 'host', code: made.code, target: cy.pid }).ok)
  assert.equal(h.m.setSettings({ userId: 'host', code: made.code, settings: { chat: false } }).status, 403, 'the old host is a guest now')
  const cySink = h.sinkFor('cy', made.code)
  assert.ok(h.m.close({ userId: 'cy', code: made.code }).ok)
  assert.ok(cySink.events.some((e) => e.event === 'closed'))
  assert.equal(h.m.roomCount(), 0)
})

test('per-room limits: participants, rooms per person, rooms overall', async () => {
  const h = harness()
  const made = await h.room()
  for (let i = 1; i < wt.LIMITS.maxParticipants; i++) await h.join('p' + i, made.code)
  assert.equal((await h.m.join({ user: U('late'), code: made.code })).error, 'room_full')
  // Two rooms per owner.
  await h.m.createRoom({ user: U('host'), media: MEDIA })
  assert.equal((await h.m.createRoom({ user: U('host'), media: MEDIA })).error, 'too_many_rooms')
})

// ---------------------------------------------------------------- the shared timeline
test('timeline: play starts at a scheduled moment, position follows the clock and the rate, pause freezes it', async () => {
  const h = harness()
  const made = await h.room()
  h.m.ready({ userId: 'host', code: made.code, ready: true, seq: 1 })
  assert.equal(h.m.command({ userId: 'host', code: made.code, cmd: { type: 'seek', pos: 100 } }).ok, true)
  const t0 = tl(h, made.code)
  assert.equal(t0.state, 'paused')
  assert.equal(t0.anchorPos, 100)
  h.m.ready({ userId: 'host', code: made.code, ready: true, seq: t0.seq })
  assert.ok(h.m.command({ userId: 'host', code: made.code, cmd: { type: 'play' } }).ok)
  const p = tl(h, made.code)
  assert.equal(p.state, 'playing')
  assert.equal(p.anchorAt, h.clock.t + wt.LIMITS.leadMs, 'a start is scheduled a moment ahead so everyone can begin together')
  assert.equal(sync.wtPositionAt(p, h.clock.t), 100, 'nobody moves before the start')
  assert.equal(sync.wtIsRunning(p, h.clock.t), false)
  assert.equal(sync.wtPositionAt(p, p.anchorAt + 10000), 110)
  h.advance(wt.LIMITS.leadMs + 10000)
  // Double speed re-anchors at "now": the position does not jump.
  assert.ok(h.m.command({ userId: 'host', code: made.code, cmd: { type: 'rate', rate: 2 } }).ok)
  const r2 = tl(h, made.code)
  assert.equal(r2.rate, 2)
  assert.ok(Math.abs(sync.wtPositionAt(r2, h.clock.t) - 110) < 0.001)
  assert.ok(Math.abs(sync.wtPositionAt(r2, h.clock.t + 5000) - 120) < 0.001)
  assert.equal(h.m.command({ userId: 'host', code: made.code, cmd: { type: 'rate', rate: 7 } }).error, 'bad_rate')
  h.advance(5000)
  assert.ok(h.m.command({ userId: 'host', code: made.code, cmd: { type: 'pause' } }).ok)
  const paused = tl(h, made.code)
  assert.equal(paused.state, 'paused')
  assert.ok(Math.abs(paused.anchorPos - 120) < 0.001)
  h.advance(60000)
  assert.ok(Math.abs(sync.wtPositionAt(paused, h.clock.t) - 120) < 0.001, 'paused stays put')
  // Nonsense positions are refused.
  for (const pos of ['abc', NaN, Infinity, {}]) assert.equal(h.m.command({ userId: 'host', code: made.code, cmd: { type: 'seek', pos } }).error, 'bad_position')
  assert.equal(h.m.command({ userId: 'host', code: made.code, cmd: { type: 'seek', pos: -50 } }).ok, true)
  assert.equal(tl(h, made.code).anchorPos, 0)
  assert.equal(h.m.command({ userId: 'host', code: made.code, cmd: { type: 'launch' } }).error, 'bad_command')
  assert.equal(h.m.command({ userId: 'host', code: made.code, cmd: null }).error, 'bad_request')
})

test('commands are applied one at a time in arrival order: unique, gapless seq; every viewer sees them in order', async () => {
  const h = harness()
  const made = await h.room({ control: 'everyone' })
  const ids = ['host', 'a', 'b', 'c']
  await h.join('a', made.code); await h.join('b', made.code); await h.join('c', made.code)
  const sinks = ids.map((id) => h.sinkFor(id, made.code))
  const start = tl(h, made.code).seq
  const kinds = [
    (i) => ({ type: 'seek', pos: i }),
    () => ({ type: 'pause' }),
    () => ({ type: 'play' }),
    (i) => ({ type: 'rate', rate: [0.5, 1, 1.5, 2][i % 4] })
  ]
  const results = await Promise.all(Array.from({ length: 400 }, (_, i) => Promise.resolve().then(() => {
    const who = ids[i % ids.length]
    return { i, who, r: h.m.command({ userId: who, code: made.code, cmd: { ...kinds[i % 4](i), cid: 'c' + i } }) }
  })))
  assert.ok(results.every((x) => x.r.ok))
  const seqs = results.filter((x) => !x.r.noop).map((x) => x.r.timeline.seq)
  assert.equal(new Set(seqs).size, seqs.length, 'no two commands share a seq')
  const sorted = [...seqs].sort((x, y) => x - y)
  assert.deepEqual(seqs, sorted, 'answered in the order applied')
  assert.equal(sorted[0], start + 1)
  assert.equal(sorted[sorted.length - 1], sorted[0] + sorted.length - 1, 'no gaps')
  assert.equal(tl(h, made.code).seq, sorted[sorted.length - 1])
  for (const s of sinks) {
    const seen = s.events.filter((e) => e.event === 'state').map((e) => e.data.timeline.seq)
    for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1], 'a viewer never sees the timeline go backwards')
    assert.equal(seen[seen.length - 1], tl(h, made.code).seq, 'and ends on the final state')
    const ids2 = s.events.filter((e) => e.id !== undefined).map((e) => e.id)
    for (let i = 1; i < ids2.length; i++) assert.ok(ids2[i] > ids2[i - 1], 'event ids strictly increase')
  }
  // The last accepted command decided the final rate.
  const lastRate = results.filter((x) => x.i % 4 === 3).pop()
  assert.equal(tl(h, made.code).rate, [0.5, 1, 1.5, 2][lastRate.i % 4])
})

test('command ids make retries safe; ifSeq refuses a command sent from an out-of-date view', async () => {
  const h = harness()
  const made = await h.room()
  const a = h.m.command({ userId: 'host', code: made.code, cmd: { type: 'seek', pos: 10, cid: 'abc123' } })
  const seq = a.timeline.seq
  const b = h.m.command({ userId: 'host', code: made.code, cmd: { type: 'seek', pos: 10, cid: 'abc123' } })
  assert.equal(b.duplicate, true)
  assert.equal(tl(h, made.code).seq, seq, 'a retried command is answered, not applied twice')
  const stale = h.m.command({ userId: 'host', code: made.code, cmd: { type: 'seek', pos: 99, ifSeq: seq - 1 } })
  assert.equal(stale.status, 409)
  assert.equal(stale.timeline.seq, seq)
  assert.equal(tl(h, made.code).anchorPos, 10)
  assert.equal(h.m.command({ userId: 'host', code: made.code, cmd: { type: 'seek', pos: 99, ifSeq: seq } }).ok, true)
  // A command that changes nothing does not bump the seq (so viewers are not woken for nothing).
  const before = tl(h, made.code).seq
  assert.equal(h.m.command({ userId: 'host', code: made.code, cmd: { type: 'pause' } }).ok, true)
  assert.equal(h.m.command({ userId: 'host', code: made.code, cmd: { type: 'pause', pos: 99 } }).noop, true)
  assert.equal(tl(h, made.code).seq, before)
})

// ---------------------------------------------------------------- readiness
test('waiting for people: buffering pauses everybody, the room resumes by itself', async () => {
  const h = harness()
  const made = await h.room()
  await h.join('bob', made.code, 'Bob')
  const code = made.code
  h.m.ready({ userId: 'host', code, ready: true, seq: 1 })
  h.m.ready({ userId: 'bob', code, ready: true, seq: 1 })
  h.m.command({ userId: 'host', code, cmd: { type: 'play' } })
  h.advance(wt.LIMITS.leadMs + 20000)
  const posBefore = sync.wtPositionAt(tl(h, code), h.clock.t)
  assert.ok(Math.abs(posBefore - 20) < 0.01)
  // Bob's connection stalls.
  h.m.ready({ userId: 'bob', code, ready: false, seq: tl(h, code).seq })
  const held = tl(h, code)
  assert.equal(held.state, 'paused', 'the room stops for everyone')
  assert.ok(Math.abs(held.anchorPos - 20) < 0.01, 'exactly where it was')
  const hs = state(h, code).hold
  assert.equal(hs.reason, 'buffering')
  const snap = h.m.poll({ userId: 'host', code }).room
  assert.deepEqual(snap.hold.waitingFor, ['Bob'])
  assert.equal(snap.participants.find((p) => p.name === 'Bob').buffering, true)
  // Time passing while held does not move the film.
  h.advance(5000)
  assert.ok(Math.abs(sync.wtPositionAt(tl(h, code), h.clock.t) - 20) < 0.01)
  // Bob is back: it starts again from the same spot, a moment ahead.
  h.m.ready({ userId: 'bob', code, ready: true, seq: tl(h, code).seq })
  const resumed = tl(h, code)
  assert.equal(resumed.state, 'playing')
  assert.ok(Math.abs(resumed.anchorPos - 20) < 0.01)
  assert.equal(resumed.anchorAt, h.clock.t + wt.LIMITS.leadMs)
  assert.equal(state(h, code).hold, null)
})

test('pressing play before a friend is ready waits for them; a viewer that stalls too long stops holding the room up', async () => {
  const h = harness()
  const made = await h.room()
  await h.join('bob', made.code, 'Bob')
  const code = made.code
  h.sinkFor('host', code); h.sinkFor('bob', code) // both have a stream open: connected
  h.m.ready({ userId: 'host', code, ready: true, seq: 1 })
  h.m.ready({ userId: 'bob', code, ready: true, seq: 1 })
  h.m.ready({ userId: 'bob', code, ready: false, seq: 1 }) // Bob is loading something
  h.m.command({ userId: 'host', code, cmd: { type: 'play' } })
  assert.equal(tl(h, code).state, 'paused')
  assert.equal(state(h, code).hold.reason, 'waiting')
  h.advance(wt.LIMITS.waitMs - 1000)
  h.m.sweep()
  assert.equal(tl(h, code).state, 'paused')
  h.advance(2000)
  h.m.sweep()
  assert.equal(tl(h, code).state, 'playing', 'started without the viewer that never became ready')
  // He is not punished for ever: when he is ready again he counts again.
  h.m.ready({ userId: 'bob', code, ready: true, seq: tl(h, code).seq })
  h.advance(3000)
  h.m.ready({ userId: 'bob', code, ready: false, seq: tl(h, code).seq })
  assert.equal(tl(h, code).state, 'paused')
})

test('a seek while playing waits until everybody has landed on the new spot and buffered it', async () => {
  const h = harness()
  const made = await h.room()
  await h.join('bob', made.code, 'Bob')
  const code = made.code
  h.m.ready({ userId: 'host', code, ready: true, seq: 1 })
  h.m.ready({ userId: 'bob', code, ready: true, seq: 1 })
  h.m.command({ userId: 'host', code, cmd: { type: 'play' } })
  h.advance(3000)
  h.m.command({ userId: 'host', code, cmd: { type: 'seek', pos: 900 } })
  const s = tl(h, code)
  assert.equal(s.state, 'paused')
  assert.equal(s.anchorPos, 900)
  assert.equal(state(h, code).hold.reason, 'seek')
  // A "ready" that is about the OLD position (an older seq) does not count.
  h.m.ready({ userId: 'host', code, ready: true, seq: s.seq - 1 })
  h.m.ready({ userId: 'bob', code, ready: true, seq: s.seq - 1 })
  assert.equal(tl(h, code).state, 'paused')
  h.m.ready({ userId: 'host', code, ready: true, seq: s.seq })
  assert.equal(tl(h, code).state, 'paused', 'one of two')
  h.m.ready({ userId: 'bob', code, ready: true, seq: s.seq })
  assert.equal(tl(h, code).state, 'playing')
  assert.equal(tl(h, code).anchorPos, 900)
  // Seeking a paused room just moves it and stays paused.
  h.m.command({ userId: 'host', code, cmd: { type: 'pause' } })
  h.m.command({ userId: 'host', code, cmd: { type: 'seek', pos: 30 } })
  assert.equal(tl(h, code).state, 'paused')
  assert.equal(state(h, code).hold, null)
})

test('waitForBuffering off: nobody ever holds the room', async () => {
  const h = harness()
  const made = await h.room({ waitForBuffering: false })
  await h.join('bob', made.code)
  const code = made.code
  h.m.ready({ userId: 'host', code, ready: true, seq: 1 })
  h.m.ready({ userId: 'bob', code, ready: true, seq: 1 })
  h.m.command({ userId: 'host', code, cmd: { type: 'play' } })
  h.advance(2000)
  h.m.ready({ userId: 'bob', code, ready: false, seq: 1 })
  assert.equal(tl(h, code).state, 'playing')
  h.m.command({ userId: 'host', code, cmd: { type: 'seek', pos: 500 } })
  assert.equal(tl(h, code).state, 'playing', 'a seek does not wait either')
})

test('joining mid-movie: the newcomer is handed where the film is now and never stops the others until they are ready', async () => {
  const h = harness()
  const made = await h.room()
  const code = made.code
  h.m.ready({ userId: 'host', code, ready: true, seq: 1 })
  h.m.command({ userId: 'host', code, cmd: { type: 'seek', pos: 600 } })
  h.m.ready({ userId: 'host', code, ready: true, seq: tl(h, code).seq })
  h.m.command({ userId: 'host', code, cmd: { type: 'play' } })
  h.advance(wt.LIMITS.leadMs + 45000)
  const j = await h.join('late', code, 'Late')
  assert.ok(Math.abs(j.catchUp.position - 645) < 0.01, 'position is 600 + 45 s of playing')
  assert.equal(j.catchUp.running, true)
  assert.equal(j.room.timeline.state, 'playing')
  // The client works the same out from the timeline it was given: the maths is shared.
  assert.ok(Math.abs(sync.wtPositionAt(j.room.timeline, h.clock.t + 3000) - 648) < 0.01)
  // Loading (not ready yet) does not pause a running room.
  h.m.ready({ userId: 'late', code, ready: false, seq: 0 })
  assert.equal(tl(h, code).state, 'playing')
  // Once they have caught up and reported ready, they count like anyone else.
  h.m.ready({ userId: 'late', code, ready: true, seq: tl(h, code).seq })
  h.advance(4000)
  h.m.ready({ userId: 'late', code, ready: false, seq: tl(h, code).seq })
  assert.equal(tl(h, code).state, 'paused')
  assert.deepEqual(state(h, code).hold && h.m.poll({ userId: 'host', code }).room.hold.waitingFor, ['Late'])
  // The same person opening the page again keeps their seat but must earn their place again.
  const back = await h.m.join({ user: U('late', 'Late'), code })
  assert.equal(back.pid, j.pid)
})

test('changing the title moves the room to the new one, paused at the start, without anyone holding it up', async () => {
  const h = harness()
  const made = await h.room()
  const code = made.code
  await h.join('bob', code)
  const sink = h.sinkFor('bob', code)
  h.m.command({ userId: 'host', code, cmd: { type: 'seek', pos: 400 } })
  const next = { kind: 'tv', id: Buffer.from('Show/S01E02.mkv').toString('base64url'), title: 'Show S01E02' }
  assert.equal((await h.m.changeMedia({ userId: 'bob', code, media: next })).status, 403)
  assert.ok((await h.m.changeMedia({ userId: 'host', code, media: next })).ok)
  const st = state(h, code)
  assert.equal(st.media.id, next.id)
  assert.equal(st.timeline.anchorPos, 0)
  assert.equal(st.timeline.state, 'paused')
  const ev = sink.events.find((e) => e.event === 'media')
  assert.ok(ev)
  assert.match(ev.data.media.href, /^\/tvwatch\?id=[A-Za-z0-9_%-]+$/)
  assert.equal((await h.m.changeMedia({ userId: 'host', code, media: { kind: 'movie', id: '../../etc/passwd' } })).error, 'bad_media')
})

// ---------------------------------------------------------------- housekeeping
test('sweep: dropped people keep their seat for a while, then go; empty and ancient rooms are retired', async () => {
  const h = harness()
  const made = await h.room()
  const code = made.code
  await h.join('bob', code, 'Bob')
  const hostSink = h.sinkFor('host', code)
  const bobSink = h.sinkFor('bob', code)
  bobSink.detach() // Bob's connection drops
  h.advance(11000) // no longer counted as connected
  h.m.sweep()
  assert.equal(state(h, code).participants.size, 2, 'still holds the seat')
  assert.equal(h.m.poll({ userId: 'host', code }).room.participants.find((p) => p.name === 'Bob').connected, false)
  h.advance(wt.LIMITS.graceMs + 1000)
  h.m.sweep()
  assert.equal(state(h, code).participants.size, 1)
  assert.ok(hostSink.events.filter((e) => e.event === 'state').length > 2)
  // The host's connection drops: the room is not closed at once (a page change), but goes after the grace.
  hostSink.detach()
  h.advance(11000 + wt.LIMITS.graceMs + 1000)
  h.m.sweep()
  assert.equal(h.m.roomCount(), 0)
  const old = await h.room()
  h.m.poll({ userId: 'host', code: old.code })
  h.advance(wt.LIMITS.maxAgeMs + 1)
  h.m.sweep()
  assert.equal(h.m.roomCount(), 0, 'no room lives for ever')
})

test('streams: state first, missed chat replayed, extra streams retire the oldest, a broken stream is dropped', async () => {
  const h = harness()
  const made = await h.room()
  const code = made.code
  h.m.chat({ userId: 'host', code, text: 'one' })
  h.m.chat({ userId: 'host', code, text: 'two' })
  const first = h.sinkFor('host', code)
  assert.equal(first.events[0].event, 'state')
  assert.equal(first.events[0].data.you, made.pid)
  assert.equal(first.events[0].data.code, code)
  h.m.chat({ userId: 'host', code, text: 'three' })
  const chatEvents = first.events.filter((e) => e.event === 'chat')
  assert.deepEqual(chatEvents.map((e) => e.data.text), ['three'])
  // A reconnect names the last event it saw; only what it missed comes again.
  const rec = { events: [] }
  h.m.attach({ userId: 'host', code, sink: { write: (e, d, id) => rec.events.push({ event: e, data: JSON.parse(d), id }) }, lastEventId: chatEvents[0].id - 1 })
  assert.deepEqual(rec.events.filter((e) => e.event === 'chat').map((e) => e.data.text), ['three'])
  // Poll gives the same for clients that cannot stream.
  const polled = h.m.poll({ userId: 'host', code, since: 0 })
  assert.deepEqual(polled.chat.map((c) => c.text), ['one', 'two', 'three'])
  assert.deepEqual(h.m.poll({ userId: 'host', code, since: polled.chat[1].eventId }).chat.map((c) => c.text), ['three'])
  // Only a few streams per person.
  const extra = []
  for (let i = 0; i < 4; i++) { const r = { closed: false }; extra.push(r); h.m.attach({ userId: 'host', code, sink: { write() {}, close() { r.closed = true } } }) }
  assert.ok(extra[0].closed && !extra[3].closed)
  // A sink that throws is forgotten instead of breaking the room for everyone else.
  const bad = { write() { throw new Error('socket gone') }, close() {} }
  h.m.attach({ userId: 'host', code, sink: bad })
  assert.ok(h.m.chat({ userId: 'host', code, text: 'four' }).ok)
})

// ---------------------------------------------------------------- names, chat and titles are only data
const XSS = [
  '<img src=x onerror=alert(1)>', '"><script>alert(document.cookie)</script>', "'; DROP TABLE users; --", '<svg/onload=alert(1)>',
  'javascript:alert(1)', '${7*7}{{7*7}}', chr(0x202e) + 'evil' + chr(0x202c), 'a' + chr(0) + 'b' + chr(7) + 'c', 'line1\nline2\r\nevent: closed\ndata: {}', chr(0x2028) + chr(0x2029)
]

test('names, titles and chat: no control or direction-changing characters, capped in length; markup stays inert text', async () => {
  const h = harness()
  for (const [i, payload] of XSS.entries()) {
    const made = await h.m.createRoom({ user: { id: 'owner' + i, name: payload }, media: { ...MEDIA, title: payload } })
    assert.ok(made.ok)
    const name = made.room.participants[0].name
    assert.ok(name.length >= 1 && Array.from(name).length <= wt.LIMITS.nameMax)
    assert.doesNotMatch(name, INVISIBLE_RE)
    assert.doesNotMatch(made.room.media.title, INVISIBLE_RE)
    assert.ok(Array.from(made.room.media.title).length <= wt.LIMITS.titleMax)
    assert.match(made.room.participants[0].color, /^#[0-9a-f]{6}$/)
    const sink = h.sinkFor('owner' + i, made.code)
    h.m.chat({ userId: 'owner' + i, code: made.code, text: payload || 'x' })
    const chat = sink.events.find((e) => e.event === 'chat')
    if (payload.replace(LINE_CTRL_RE, '').trim()) {
      assert.ok(chat, 'chat accepted for ' + JSON.stringify(payload))
      assert.doesNotMatch(chat.data.text, CHAT_BAD_RE)
      // The message travels in SSE framing as exactly one event whatever it says.
      const frame = httpLayer.sseFrame('chat', JSON.stringify(chat.data), chat.id)
      const parsed = parseSse(frame)
      assert.equal(parsed.length, 1)
      assert.equal(parsed[0].event, 'chat')
      assert.deepEqual(JSON.parse(parsed[0].data), chat.data)
    }
    h.m.closeAll()
  }
  // Very long names are cut, not rejected.
  const long = await h.m.createRoom({ user: { id: 'longname', name: 'x'.repeat(5000) }, media: MEDIA })
  assert.equal(long.room.participants[0].name.length, wt.LIMITS.nameMax)
  // Emoji count as one character each and survive.
  assert.equal(wt.cleanText('🎬'.repeat(500), 300).length, 600)
  assert.equal(Array.from(wt.cleanText('🎬'.repeat(500), 300)).length, 300)
})

test('media references must be a plain library id: no markup, no paths, no oversize', () => {
  for (const id of ['<script>', '../etc/passwd', 'a b', 'x'.repeat(701), '', 'a"b', "a'b", 'a/b']) assert.equal(wt.normalizeMedia({ kind: 'movie', id }), null, id)
  assert.equal(wt.normalizeMedia({ kind: 'song', id: 'abc' }), null)
  assert.equal(wt.normalizeMedia(null), null)
  assert.deepEqual(wt.normalizeMedia({ kind: 'tv', id: 'abc_-9', title: ' <b>x</b> ' }), { kind: 'tv', id: 'abc_-9', title: '<b>x</b>' })
  assert.equal(wt.mediaHref({ kind: 'tv', id: 'abc' }), '/tvwatch?id=abc')
  assert.equal(wt.mediaHref({ kind: 'movie', id: 'abc' }), '/watch?id=abc')
})

test('the page code never builds HTML from room data, and a hostile title cannot break out of its script', () => {
  const src = web.watchTogetherClient.toString() + sync.clientSource()
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\s*\(|new Function|setTimeout\(\s*['"`]|setInterval\(\s*['"`]/)
  assert.doesNotMatch(src, /\.href\s*=\s*[^;]*(?<!safeHref\()\bmessage\b/)
  const html = web.watchTogetherHtml({ kind: 'movie', mediaId: 'abc', title: '</script><script>alert(1)</script>' + chr(0x2028) + '<!--', nextHref: '/tvwatch?id=def' })
  assert.equal((html.match(/<\/script>/g) || []).length, 1, 'only the real closing tag')
  assert.equal((html.match(/<script>/g) || []).length, 1)
  assert.ok(!html.includes('<!--'))
  assert.match(html, /\\u003c\/script\\u003e/)
  const scriptBody = html.split('<script>')[1].split('</script>')[0]
  assert.doesNotThrow(() => new Function(scriptBody), 'the injected script parses')
  // The next-episode button only ever gets a real library id.
  assert.deepEqual(web.mediaFromHref('/tvwatch?id=abc123&t=5'), { kind: 'tv', id: 'abc123', title: '' })
  assert.equal(web.mediaFromHref('https://evil.example/x'), null)
  assert.equal(web.mediaFromHref('/tvwatch?id=<script>'), null)
  // Server-made pages escape what they show.
  assert.ok(!httpLayer.messagePage('<img src=x onerror=1>').includes('<img'))
})

// ---------------------------------------------------------------- rate limits
test('rate limits: chat, reactions, commands, room creation, joins - and each is per person', async () => {
  const h = harness({ rates: { command: 5, chat: 6, react: 10, ready: 8, create: 3, join: 4, attempts: 8 } })
  const made = await h.room({ control: 'everyone' })
  const code = made.code
  await h.join('bob', code)
  for (let i = 0; i < 6; i++) assert.ok(h.m.chat({ userId: 'host', code, text: 'm' + i }).ok)
  const blocked = h.m.chat({ userId: 'host', code, text: 'too many' })
  assert.equal(blocked.status, 429)
  assert.ok(blocked.retryAfterSeconds >= 1)
  assert.ok(h.m.chat({ userId: 'bob', code, text: 'bob is not limited by host' }).ok)
  h.advance(10001)
  assert.ok(h.m.chat({ userId: 'host', code, text: 'later' }).ok)
  for (let i = 0; i < 10; i++) assert.ok(h.m.react({ userId: 'host', code, emoji: '👍' }).ok)
  assert.equal(h.m.react({ userId: 'host', code, emoji: '👍' }).status, 429)
  for (let i = 0; i < 5; i++) assert.ok(h.m.command({ userId: 'bob', code, cmd: { type: 'seek', pos: i } }).ok)
  assert.equal(h.m.command({ userId: 'bob', code, cmd: { type: 'seek', pos: 9 } }).status, 429)
  for (let i = 0; i < 8; i++) assert.ok(h.m.ready({ userId: 'bob', code, ready: true, seq: 1 }).ok)
  assert.equal(h.m.ready({ userId: 'bob', code, ready: true, seq: 1 }).status, 429)
  // Joins: 4 in the window.
  for (let i = 0; i < 3; i++) assert.ok((await h.m.join({ user: U('bob'), code, ip: '1.1.1.1' })).ok) // the first join was above
  assert.equal((await h.m.join({ user: U('bob'), code, ip: '1.1.1.1' })).status, 429)
  // Creating rooms.
  const h2 = harness({ rates: { create: 3 } })
  for (let i = 0; i < 3; i++) { const r = await h2.m.createRoom({ user: U('busy'), media: MEDIA }); if (r.ok) h2.m.close({ userId: 'busy', code: r.code }) }
  assert.equal((await h2.m.createRoom({ user: U('busy'), media: MEDIA })).error, 'rate_limited')
})

test('guessing codes: repeated wrong ones lock that person and that address out, even for the right code', async () => {
  const h = harness()
  const made = await h.room()
  const wrong = wt.generateCode()
  for (let i = 0; i < 8; i++) assert.equal((await h.m.join({ user: U('guesser'), code: wrong, ip: '9.9.9.9' })).error, 'not_found')
  const locked = await h.m.join({ user: U('guesser'), code: made.code, ip: '9.9.9.9' })
  assert.equal(locked.status, 429)
  assert.equal(locked.error, 'locked')
  assert.ok(locked.minutesRemaining >= 1)
  assert.equal((await h.m.preview({ user: U('guesser'), code: made.code, ip: '9.9.9.9' })).error, 'locked', 'looking is guessing too')
  // Another account from the same address is held back as well...
  assert.equal((await h.m.join({ user: U('accomplice'), code: made.code, ip: '9.9.9.9' })).error, 'locked')
  // ...but somebody elsewhere is fine.
  assert.ok((await h.m.join({ user: U('friend'), code: made.code, ip: '8.8.8.8' })).ok)
  // The lock ends.
  h.advance(10 * 60 * 1000 + 1000)
  assert.ok((await h.m.join({ user: U('guesser'), code: made.code, ip: '9.9.9.9' })).ok)
  // A success does not wipe earlier misses (or a person could interleave a room of their own with their guesses).
  const h2 = harness()
  const r2 = await h2.room()
  for (let i = 0; i < 7; i++) await h2.m.join({ user: U('careful'), code: wt.generateCode(), ip: '7.7.7.7' })
  assert.ok((await h2.m.join({ user: U('careful'), code: r2.code, ip: '7.7.7.7' })).ok, 'seven misses is still allowed')
  await h2.m.join({ user: U('careful'), code: wt.generateCode(), ip: '7.7.7.7' })
  assert.equal((await h2.m.join({ user: U('careful'), code: r2.code, ip: '7.7.7.7' })).error, 'locked')
})

test('chat and reactions: size limits, allowed emoji only, chat can be switched off', async () => {
  const h = harness()
  const made = await h.room()
  const code = made.code
  await h.join('bob', code)
  assert.equal(h.m.chat({ userId: 'host', code, text: 'x'.repeat(wt.LIMITS.chatMax * 8 + 1) }).status, 413)
  const long = h.m.chat({ userId: 'host', code, text: 'y'.repeat(2000) })
  assert.ok(long.ok)
  assert.equal(h.m.poll({ userId: 'host', code }).chat.pop().text.length, wt.LIMITS.chatMax)
  for (const bad of ['', '   ', chr(0) + chr(7), 12, null, {}]) assert.ok(!h.m.chat({ userId: 'host', code, text: bad }).ok)
  for (const bad of ['<script>', '👍👍', 'x', '', 5, '💩']) assert.equal(h.m.react({ userId: 'host', code, emoji: bad }).error, 'bad_reaction')
  for (const good of wt.REACTIONS) assert.ok(h.m.react({ userId: 'host', code, emoji: good }).ok || true)
  h.advance(11000) // (rejected messages count toward the rate limit too)
  h.m.setSettings({ userId: 'host', code, settings: { chat: false } })
  assert.equal(h.m.chat({ userId: 'bob', code, text: 'hi' }).error, 'chat_off')
  assert.ok(h.m.chat({ userId: 'host', code, text: 'the host can still say things' }).ok)
  // History is bounded.
  h.m.setSettings({ userId: 'host', code, settings: { chat: true } })
  for (let i = 0; i < 80; i++) { h.advance(20000); h.m.chat({ userId: 'host', code, text: 'n' + i }) }
  assert.equal(h.m.poll({ userId: 'host', code }).chat.length, wt.LIMITS.chatHistory)
})

// ---------------------------------------------------------------- SSE framing
function parseSse(text) {
  // A strict reading of the EventSource wire format: fields end at CR/LF/CRLF, a blank line ends an event.
  const out = []
  let cur = { event: 'message', data: [], id: undefined }
  let any = false
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line === '') { if (any) out.push({ event: cur.event, data: cur.data.join('\n'), id: cur.id }); cur = { event: 'message', data: [], id: undefined }; any = false; continue }
    if (line.startsWith(':')) continue
    const i = line.indexOf(':')
    const field = i < 0 ? line : line.slice(0, i)
    let value = i < 0 ? '' : line.slice(i + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    any = true
    if (field === 'event') cur.event = value
    else if (field === 'data') cur.data.push(value)
    else if (field === 'id') cur.id = value
  }
  return out
}

test('SSE framing: one well-formed event per frame, whatever the payload holds', () => {
  assert.equal(httpLayer.sseFrame('state', '{"a":1}', 7), 'id: 7\nevent: state\ndata: {"a":1}\n\n')
  assert.equal(httpLayer.sseFrame('chat', '{"a":1}'), 'event: chat\ndata: {"a":1}\n\n', 'no id when there is none')
  // A hostile event name or id cannot add fields or events.
  assert.equal(httpLayer.sseFrame('x\nevent: closed', '{}'), 'event: message\ndata: {}\n\n')
  assert.equal(httpLayer.sseFrame('state', '{}', '1\nevent: kicked'), 'event: state\ndata: {}\n\n')
  assert.equal(httpLayer.sseFrame('State', '{}'), 'event: message\ndata: {}\n\n')
  // Line breaks in data (which JSON never produces, but framing must not rely on that) become more data lines.
  const nasty = httpLayer.sseFrame('chat', 'a\nevent: closed\r\ndata: b\rid: 99\n\ndata: c')
  const parsed = parseSse(nasty)
  assert.equal(parsed.length, 1, 'embedded line breaks and blank lines cannot end the frame or start another')
  assert.equal(parsed[0].event, 'chat')
  assert.equal(parsed[0].id, undefined)
  assert.equal(parsed[0].data, 'a\nevent: closed\ndata: b\nid: 99\n\ndata: c')
  // JSON of a whole state always survives a round trip.
  const h = harness()
  return h.room().then((made) => {
    const snap = JSON.stringify(h.m.poll({ userId: 'host', code: made.code }).room)
    const back = parseSse(httpLayer.sseFrame('state', snap, 3))
    assert.equal(back.length, 1)
    assert.equal(back[0].id, '3')
    assert.deepEqual(JSON.parse(back[0].data), JSON.parse(snap))
    assert.ok(!snap.includes('\n'))
  })
})

// ---------------------------------------------------------------- the timing maths (what the browser runs)
test('clock offset: NTP-style samples recover the true offset; the lowest-rtt sample wins; junk is ignored', () => {
  // Server clock = viewer clock + 500 ms. Trip: 40 ms out, 60 ms back (asymmetric), server holds it 2 ms.
  const trueOffset = 500
  const sample = (out, back, t0 = 10000) => {
    const t1 = t0 + out + trueOffset
    const t2 = t1 + 2
    const t3 = t0 + out + 2 + back
    return sync.wtOffsetSample(t0, t1, t2, t3)
  }
  const s = sample(40, 60)
  assert.equal(s.rtt, 100)
  assert.ok(Math.abs(s.offset - trueOffset) <= 10 + 1e-9, 'asymmetry costs at most half the difference (10 ms)')
  const symmetric = sample(50, 50)
  assert.ok(Math.abs(symmetric.offset - trueOffset) < 1e-9)
  const samples = [sample(300, 20), sample(20, 20), sample(150, 250), { offset: NaN, rtt: 1 }, { offset: 9999, rtt: -5 }, { offset: 1, rtt: 99999 }, null]
  const best = sync.wtBestOffset(samples)
  assert.equal(best.rtt, 40)
  assert.ok(Math.abs(best.offset - trueOffset) < 1e-9)
  assert.equal(sync.wtBestOffset([]), null)
  assert.equal(sync.wtBestOffset([{ offset: 1, rtt: -1 }]), null)
  // A small change is smoothed, a jump (the viewer's clock was stepped) is followed at once.
  assert.ok(Math.abs(sync.wtBestOffset([{ offset: 510, rtt: 10 }], 500).offset - 503) < 1e-9)
  assert.equal(sync.wtBestOffset([{ offset: 5000, rtt: 10 }], 500).offset, 5000)
})

test('drift correction: nudge the speed by at most 5% under 1.5 s, seek at 1.5 s or more, no flutter near the edge', () => {
  const plan = sync.wtDriftPlan
  assert.equal(plan(0, 1, false).action, 'none')
  assert.equal(plan(0.05, 1, false).action, 'none', 'inside the dead band')
  assert.equal(plan(-0.079, 1, false).action, 'none')
  const ahead = plan(0.2, 1, false)
  assert.equal(ahead.action, 'nudge')
  assert.ok(ahead.rate < 1 && ahead.rate >= 0.95)
  assert.ok(Math.abs(ahead.rate - 0.95) < 1e-9, '0.2 s ahead is already the maximum 5% nudge... no: 0.2/2.5 = 8%, capped at 5%')
  const behind = plan(-0.2, 1, false)
  assert.ok(behind.rate > 1 && behind.rate <= 1.05)
  const gentle = plan(0.1, 1, false)
  assert.ok(Math.abs(gentle.rate - 0.96) < 1e-9, '0.1 s ahead -> 4% slower')
  for (let e = -1.49; e <= 1.49; e += 0.01) {
    const p = plan(e, 1, false)
    assert.ok(p.rate >= 0.95 - 1e-9 && p.rate <= 1.05 + 1e-9, 'speed stays within 0.95..1.05 for error ' + e)
    assert.notEqual(p.action, 'seek')
  }
  for (const e of [1.5, -1.5, 2, -9, 400]) assert.equal(plan(e, 1, false).action, 'seek')
  assert.equal(plan(1.499, 1, false).action, 'nudge')
  // A room at 1.5x is nudged around 1.5x, not around 1x.
  const fast = plan(0.1, 1.5, false)
  assert.ok(Math.abs(fast.rate - 1.5 * 0.96) < 1e-9)
  assert.equal(plan(0, 1.5, false).rate, 1.5)
  // Hysteresis: once nudging, it keeps going until the error is really small.
  assert.equal(plan(0.05, 1, true).action, 'nudge')
  assert.equal(plan(0.029, 1, true).action, 'none')
  assert.equal(plan(0.05, 1, false).action, 'none')
  // Garbage is harmless.
  assert.equal(plan(NaN, 1, false).action, 'none')
  assert.equal(plan(0.2, -3, false).rate, 0.95)
  // Where to seek to allows for the seek itself taking a moment.
  const running = { state: 'playing', anchorPos: 100, anchorAt: 0, rate: 1 }
  assert.ok(Math.abs(sync.wtSeekTarget(running, 10000, 0.25) - 110.25) < 1e-9)
  assert.equal(sync.wtSeekTarget({ ...running, state: 'paused' }, 10000, 0.25), 100)
})

test('a viewer that starts 0.9 s off is brought into line by speed alone, in bounds, and never seeks', () => {
  const room = { state: 'playing', anchorPos: 500, anchorAt: 0, rate: 1, seq: 4 }
  let cur = 500 + 0.9 // ahead
  let rate = 1
  let nudging = false
  let seeks = 0
  let maxRate = 0
  let minRate = 9
  let t = 0
  for (; t <= 60000; t += 250) {
    const plan = sync.wtReconcile(room, { serverNow: t, cur, paused: false, rate, ready: true, seeking: false, nudging })
    nudging = plan.nudging
    for (const a of plan.actions) { if (a.type === 'seek') { seeks++; cur = a.to } if (a.type === 'rate') rate = a.rate }
    maxRate = Math.max(maxRate, rate); minRate = Math.min(minRate, rate)
    cur += 0.25 * rate // the video plays for a quarter second at its current speed
    if (Math.abs(cur - sync.wtPositionAt(room, t + 250)) < 0.03 && !nudging) break
  }
  assert.equal(seeks, 0)
  assert.ok(Math.abs(cur - sync.wtPositionAt(room, t + 250)) < 0.05, 'converged')
  assert.ok(t < 20000, 'within 20 s (' + t + ' ms)')
  assert.ok(minRate >= 0.95 - 1e-9 && maxRate <= 1.05 + 1e-9)
  assert.equal(rate, 1, 'and settles back to normal speed')
  // The same from behind.
  cur = 500 - 1.2; rate = 1; nudging = false; seeks = 0
  for (t = 0; t <= 60000; t += 250) {
    const plan = sync.wtReconcile(room, { serverNow: t, cur, paused: false, rate, ready: true, seeking: false, nudging })
    nudging = plan.nudging
    for (const a of plan.actions) { if (a.type === 'seek') seeks++; if (a.type === 'rate') rate = a.rate }
    cur += 0.25 * rate
    if (Math.abs(cur - sync.wtPositionAt(room, t + 250)) < 0.03 && !nudging) break
  }
  assert.equal(seeks, 0)
  assert.ok(Math.abs(cur - sync.wtPositionAt(room, t + 250)) < 0.05)
})

test('reconcile: what the player is told to do in each situation', () => {
  const run = (tlp, s) => sync.wtReconcile({ rate: 1, seq: 1, ...tlp }, { rate: 1, ready: true, seeking: false, nudging: false, paused: false, ...s })
  // Paused room: stop, and sit on the spot.
  let r = run({ state: 'paused', anchorPos: 50, anchorAt: 0 }, { serverNow: 5000, cur: 53, paused: false })
  assert.deepEqual(r.actions, [{ type: 'pause' }, { type: 'seek', to: 50 }])
  assert.equal(r.phase, 'paused')
  r = run({ state: 'paused', anchorPos: 50, anchorAt: 0 }, { serverNow: 5000, cur: 50.2, paused: true })
  assert.deepEqual(r.actions, [], 'close enough')
  assert.equal(r.inSync, true)
  // A start that has not happened yet: wait on the start spot.
  r = run({ state: 'playing', anchorPos: 50, anchorAt: 10000 }, { serverNow: 9500, cur: 50, paused: true })
  assert.equal(r.phase, 'pending')
  assert.deepEqual(r.actions, [])
  // The moment arrives: play.
  r = run({ state: 'playing', anchorPos: 50, anchorAt: 10000 }, { serverNow: 10000, cur: 50, paused: true })
  assert.deepEqual(r.actions, [{ type: 'play' }])
  // Joining a film that is 45 s in: jump there (a little ahead) and play.
  r = run({ state: 'playing', anchorPos: 600, anchorAt: 0 }, { serverNow: 45000, cur: 0, paused: true })
  assert.deepEqual(r.actions, [{ type: 'seek', to: 645.25 }, { type: 'play' }])
  // Buffering viewers are not "corrected".
  r = run({ state: 'playing', anchorPos: 600, anchorAt: 0 }, { serverNow: 45000, cur: 640, paused: false, ready: false })
  assert.deepEqual(r.actions, [])
  // Speed changes by the host apply.
  r = run({ state: 'playing', anchorPos: 600, anchorAt: 0, rate: 1.5 }, { serverNow: 4000, cur: 606, paused: false, rate: 1 })
  assert.deepEqual(r.actions, [{ type: 'rate', rate: 1.5 }])
  // Big miss while playing seeks.
  r = run({ state: 'playing', anchorPos: 600, anchorAt: 0 }, { serverNow: 4000, cur: 700, paused: false })
  assert.equal(r.actions[0].type, 'seek')
  assert.equal(sync.wtReconcile(null, {}).actions.length, 0)
})

test('the browser gets the very same functions the server tests: pasted source behaves identically', () => {
  const pasted = new Function(sync.clientSource() + '; return { wtDriftPlan, wtReconcile, wtBestOffset, wtOffsetSample, wtPositionAt }')()
  for (const e of [-3, -1.2, -0.3, -0.05, 0, 0.02, 0.09, 0.4, 1.49, 1.5, 8]) {
    assert.deepEqual(pasted.wtDriftPlan(e, 1.25, e > 0), sync.wtDriftPlan(e, 1.25, e > 0))
  }
  const room = { state: 'playing', anchorPos: 10, anchorAt: 100, rate: 1, seq: 2 }
  const s = { serverNow: 5000, cur: 13, paused: false, rate: 1, ready: true, seeking: false, nudging: false }
  assert.deepEqual(pasted.wtReconcile(room, s), sync.wtReconcile(room, s))
  assert.equal(pasted.wtPositionAt(room, 5100), sync.wtPositionAt(room, 5100))
})

test('the room manager and the clients agree on where "now" is, with a viewer whose clock is 3 minutes off', async () => {
  const h = harness()
  const made = await h.room()
  const code = made.code
  h.m.ready({ userId: 'host', code, ready: true, seq: 1 })
  h.m.command({ userId: 'host', code, cmd: { type: 'play' } })
  const viewerClockSkew = 180000
  const viewerNow = () => h.clock.t - viewerClockSkew
  // The viewer measures its offset with a few pings over a 30 ms + 50 ms path.
  const samples = []
  for (let i = 0; i < 5; i++) {
    const t0 = viewerNow()
    h.advance(30)
    const reply = h.m.pingReply(t0 + viewerClockSkew, h.clock.t) // what the server stamps, in server time
    h.advance(50)
    const t3 = viewerNow()
    samples.push(sync.wtOffsetSample(t0, reply.t1, reply.t2, t3))
  }
  const off = sync.wtBestOffset(samples)
  assert.ok(Math.abs(off.offset - viewerClockSkew) < 30, 'within the path asymmetry: ' + off.offset)
  h.advance(12000)
  const truth = sync.wtPositionAt(tl(h, code), h.clock.t)
  const viewerEstimate = sync.wtPositionAt(tl(h, code), viewerNow() + off.offset)
  assert.ok(Math.abs(truth - viewerEstimate) < 0.03, 'the viewer places the playhead within 30 ms')
})
