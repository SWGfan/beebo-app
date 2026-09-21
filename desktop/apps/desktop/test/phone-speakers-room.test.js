// Phone speakers: the room manager (electron/phoneSpeakers.js), deterministic with a fake clock: creating a room (parental
// controls), guests joining with no account (nickname, unguessable code, throttling, lock-out), tokens and who may do what,
// the seating chart and presets, who plays what when a phone leaves (TV fills in / neighbour / off), the shared timeline
// (play / pause / seek with a hold until the phones are ready, measured-position corrections, rejoin and join mid-film),
// the beep test, housekeeping, rate limits and hostile names.
// Run: NODE_PATH=<desktop node_modules> node --test test/phone-speakers-room.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const ch = require('../electron/phoneSpeakersChannels')
const ps = require('../electron/phoneSpeakers')

const SRC51 = ch.describeSource({ channels: 6, channelLayout: '5.1(side)', streamIndex: 1, codec: 'eac3' })
const SRC20 = ch.describeSource({ channels: 2, channelLayout: 'stereo', streamIndex: 1, codec: 'aac' })
const owner = { id: 'u-owner', name: 'Nick' }
const film = { kind: 'movie', id: 'Q2xpcC5ta3Y', title: 'Big Film' }

function make(opts = {}) {
  const clock = { t: 5_000_000 }
  const sources = { [film.id]: opts.source || SRC51 }
  const mgr = ps.createPhoneSpeakers({
    now: () => clock.t,
    canView: opts.canView || (async (userId, kind, id) => (id === 'BLOCKED' ? { ok: false } : { ok: true, title: 'From Library' })),
    prepare: opts.prepare || (async ({ id }) => (sources[id] || sources[film.id] ? { ok: true, source: sources[id] || sources[film.id], durationSec: 7200, audioKey: 'key-' + id, rate: 32000 } : { ok: false, error: 'no_audio' })),
    rates: opts.rates || {},
    onRoomClosed: opts.onRoomClosed
  })
  return { mgr, clock }
}
function sink() {
  const s = { events: [], closed: false, write(event, data, id) { this.events.push({ event, data: JSON.parse(data), id }) }, close() { this.closed = true } }
  s.last = (name) => { for (let i = s.events.length - 1; i >= 0; i--) if (s.events[i].event === name) return s.events[i].data; return null }
  s.count = (name) => s.events.filter((e) => e.event === name).length
  return s
}
async function room(opts) {
  const w = make(opts)
  const made = await w.mgr.createRoom({ user: owner, media: film })
  assert.equal(made.ok, true, JSON.stringify(made))
  Object.assign(w, { code: made.code, tv: made.token, made })
  w.tvSink = sink()
  w.mgr.attach({ token: w.tv, sink: w.tvSink })
  w.guest = (name, ip = '10.0.0.' + (Math.floor(Math.random() * 200) + 20)) => {
    const j = w.mgr.join({ code: w.code, name, ip })
    assert.equal(j.ok, true, JSON.stringify(j))
    return j
  }
  /** a phone that has joined, is connected (a stream) and has tapped "Enable audio" */
  w.phone = (name) => {
    const j = w.guest(name)
    j.sink = sink()
    j.att = w.mgr.attach({ token: j.token, sink: j.sink })
    w.mgr.status({ token: j.token, status: { unlocked: true, state: 'ready', ready: true, seq: 1, errMs: 2, driftMs: 1, rttMs: 4 } })
    return j
  }
  return w
}
const tvView = (w) => w.tvSink.last('state')
const timeline = (w) => w.mgr._rooms.get(w.code).timeline

// ------------------------------------------------------------------ creating a room
test('a room needs a signed-in person, a film they may watch (parental controls) and audio to cut', async () => {
  const w = make()
  assert.equal((await w.mgr.createRoom({ user: null, media: film })).error, 'unauthorized')
  assert.equal((await w.mgr.createRoom({ user: owner, media: { kind: 'movie', id: '../etc' } })).error, 'bad_media')
  assert.equal((await w.mgr.createRoom({ user: owner, media: { kind: 'x', id: 'abc' } })).error, 'bad_media')
  const blocked = await w.mgr.createRoom({ user: owner, media: { kind: 'movie', id: 'BLOCKED' } })
  assert.equal(blocked.status, 403); assert.equal(blocked.error, 'unavailable')
  const silent = make({ prepare: async () => ({ ok: false, error: 'no_audio', message: 'This film has no sound to share.' }) })
  const r = await silent.mgr.createRoom({ user: owner, media: film })
  assert.equal(r.ok, false); assert.equal(r.error, 'no_audio'); assert.equal(r.message, 'This film has no sound to share.')
  assert.equal(w.mgr.roomCount(), 0, 'a refused room leaves nothing behind')
})

test('a new room: 26-character unguessable code, a screen token, sensible defaults', async () => {
  const w = await room()
  assert.match(w.code, /^[0-9A-HJKMNP-TV-Z]{26}$/)
  assert.match(w.tv, /^[0-9a-f]{12}\.[0-9a-f]{32}$/)
  const v = tvView(w)
  assert.equal(v.room.mode, 'surround'); assert.equal(v.room.title, 'Big Film'); assert.equal(v.room.timeline.state, 'paused')
  assert.equal(v.room.settings, undefined); assert.equal(v.room.fillIn, 'tv')
  assert.deepEqual(v.host.seats.map((s) => s.seat), ['FL', 'FR', 'FC', 'SL', 'SR', 'LFE'])
  // a stereo film starts as a stereo pair
  const st = await room({ source: SRC20 })
  assert.equal(tvView(st).room.mode, 'stereo')
  // two rooms never share a code
  const codes = new Set()
  for (let i = 0; i < 50; i++) { const x = make(); codes.add((await x.mgr.createRoom({ user: { id: 'u' + i }, media: film })).code) }
  assert.equal(codes.size, 50)
})

test('asking again for the same film gives the same room back; another film replaces it; rooms and creation are limited', async () => {
  const w = await room()
  const again = await w.mgr.createRoom({ user: owner, media: film })
  assert.equal(again.resumed, true); assert.equal(again.code, w.code); assert.notEqual(again.token, w.tv)
  assert.equal(w.mgr.status({ token: w.tv, status: {} }).error, 'unauthorized', 'the old screen token stopped working')
  assert.ok(w.tvSink.count('kicked') >= 1, 'the old screen was told')
  const other = await w.mgr.createRoom({ user: owner, media: { kind: 'movie', id: 'Other1' } })
  assert.equal(other.ok, true); assert.notEqual(other.code, w.code)
  assert.equal(w.mgr.roomCount(), 1)
  assert.equal(w.mgr.join({ code: w.code, name: 'x', ip: '1.1.1.1' }).error, 'not_found', 'the old room is gone')
  const busy = make()
  for (let i = 0; i < 4; i++) assert.equal((await busy.mgr.createRoom({ user: { id: 'p' + i }, media: film })).ok, true)
  assert.equal((await busy.mgr.createRoom({ user: { id: 'p9' }, media: film })).error, 'server_busy')
  const limited = make({ rates: { create: 2 } })
  await limited.mgr.createRoom({ user: owner, media: { kind: 'movie', id: 'A1' } })
  await limited.mgr.createRoom({ user: owner, media: { kind: 'movie', id: 'A2' } })
  assert.equal((await limited.mgr.createRoom({ user: owner, media: { kind: 'movie', id: 'A3' } })).status, 429)
})

// ------------------------------------------------------------------ joining
test('guests join with just a nickname; seats go out in join order FL FR C SL SR Sub, then Spare', async () => {
  const w = await room()
  const seats = []
  for (const n of ['Ann', 'Bo', 'Cy', 'Di', 'Ed', 'Flo', 'Gus']) seats.push(w.guest(n).snapshot.you.seat)
  assert.deepEqual(seats, ['FL', 'FR', 'FC', 'SL', 'SR', 'LFE', 'off'])
  assert.equal(w.guest('Ann').snapshot.you.name, 'Ann 2', 'names stay distinct')
  const j = w.guest('Hal')
  assert.equal(j.snapshot.you.seatLabel, 'Spare')
  assert.deepEqual(j.snapshot.you.layers, [])
})

test('a stereo pair alternates left / right; everyone takes the mix; 7.1 has back seats', async () => {
  const st = await room({ source: SRC20 })
  assert.deepEqual(['a', 'b', 'c', 'd', 'e'].map((n) => st.guest(n).snapshot.you.seat), ['DL', 'DR', 'DL', 'DR', 'DL'])
  const ev = await room({ source: ch.describeSource({ channels: 1, channelLayout: 'mono', streamIndex: 0 }) })
  assert.deepEqual(['a', 'b', 'c'].map((n) => ev.guest(n).snapshot.you.seat), ['DM', 'DM', 'DM'])
  const big = await room({ source: ch.describeSource({ channels: 8, channelLayout: '7.1', streamIndex: 0 }) })
  const order = Array.from({ length: 9 }, (_, i) => big.guest('p' + i).snapshot.you.seat)
  assert.deepEqual(order, ['FL', 'FR', 'FC', 'SL', 'SR', 'LFE', 'BL', 'BR', 'off'])
})

test('names are data: control and bidi characters go, length is capped, markup stays inert text', async () => {
  const w = await room()
  const evil = w.guest('<img src=x onerror=alert(1)>\u202E\u0000\u200Bbad\n\tname')
  const nm = evil.snapshot.you.name
  assert.ok(!/[\u0000-\u001F\u202E\u200B]/.test(nm), JSON.stringify(nm))
  assert.ok(nm.includes('<img'), 'it is kept as TEXT (the pages use textContent only)')
  assert.ok(w.guest('x'.repeat(500)).snapshot.you.name.length <= 24)
  assert.equal(w.guest('').snapshot.you.name, 'Guest')
  assert.equal(w.guest(null).snapshot.you.name, 'Guest 2')
  assert.equal(w.guest(12345).snapshot.you.name, 'Guest 3')
})

test('the code is the only way in: misses are throttled, then the address is locked out; "no room" looks like "removed"', async () => {
  const w = await room()
  const ip = '192.168.1.77'
  const answers = []
  for (let i = 0; i < 8; i++) answers.push(w.mgr.join({ code: 'Z'.repeat(26), name: 'x', ip }))
  assert.ok(answers.every((a) => a.status === 404 && a.error === 'not_found'))
  const locked = w.mgr.join({ code: w.code, name: 'x', ip })
  assert.equal(locked.status, 429); assert.equal(locked.error, 'locked', 'even the right code is refused after 8 misses')
  assert.ok(locked.minutesRemaining >= 1)
  // another address is not affected
  assert.equal(w.mgr.join({ code: w.code, name: 'ok', ip: '192.168.1.78' }).ok, true)
  // garbage codes
  for (const bad of [undefined, null, 42, '', 'short', 'A'.repeat(300), '../..', { toString() { return w.code } }]) assert.equal(w.mgr.join({ code: bad, name: 'x', ip: '9.9.9.' + Math.floor(Math.random() * 200) }).ok, false)
  // preview counts as a guess too
  const p = w.mgr.preview({ code: w.code, ip: '5.5.5.5' })
  assert.equal(p.ok, true); assert.equal(p.title, 'Big Film')
  for (let i = 0; i < 8; i++) w.mgr.preview({ code: 'Y'.repeat(26), ip: '6.6.6.6' })
  assert.equal(w.mgr.preview({ code: w.code, ip: '6.6.6.6' }).error, 'locked')
  // a code typed in lower case with dashes still works (Crockford normalisation)
  const pretty = w.code.toLowerCase().replace(/(.{5})/g, '$1-')
  assert.equal(w.mgr.join({ code: pretty, name: 'typed', ip: '7.7.7.7' }).ok, true)
})

test('joining is rate-limited per address; a locked room refuses newcomers but not the phones already in it; 16 phones at most', async () => {
  const w = await room({ rates: { join: 5 } })
  for (let i = 0; i < 5; i++) assert.equal(w.mgr.join({ code: w.code, name: 'n' + i, ip: '8.8.8.8' }).ok, true)
  assert.equal(w.mgr.join({ code: w.code, name: 'n6', ip: '8.8.8.8' }).status, 429)
  const full = await room()
  for (let i = 0; i < 16; i++) full.guest('g' + i)
  assert.equal(full.mgr.join({ code: full.code, name: 'late', ip: '1.2.3.4' }).error, 'room_full')
  const lk = await room()
  const inside = lk.guest('Inside')
  assert.equal(lk.mgr.setSettings({ token: lk.tv, settings: { locked: true } }).ok, true)
  assert.equal(lk.mgr.join({ code: lk.code, name: 'new', ip: '2.2.2.2' }).error, 'room_locked')
  const back = lk.mgr.join({ code: lk.code, name: 'Inside', token: inside.token, ip: '3.3.3.3' })
  assert.equal(back.ok, true); assert.equal(back.resumed, true); assert.equal(back.gid, inside.gid)
})

test('the same phone joining again (reload, blip) keeps its seat and its name', async () => {
  const w = await room()
  const a = w.guest('Ann'); const b = w.guest('Bo')
  const again = w.mgr.join({ code: w.code, token: b.token, ip: '4.4.4.4' })
  assert.equal(again.resumed, true); assert.equal(again.snapshot.you.seat, 'FR'); assert.equal(again.snapshot.you.name, 'Bo')
  assert.equal(a.snapshot.you.seat, 'FL')
  // a token from another room is not accepted here
  const other = await room()
  const stranger = w.mgr.join({ code: w.code, token: other.guest('Zed').token, name: 'Zed', ip: '4.4.4.5' })
  assert.notEqual(stranger.resumed, true)
  assert.equal(stranger.snapshot.you.seat, 'FC', 'a new guest, next seat')
})

// ------------------------------------------------------------------ tokens
test('tokens: malformed, forged or foreign tokens do nothing; a phone cannot drive the room; the screen can', async () => {
  const w = await room()
  const p = w.guest('Ann')
  for (const bad of [undefined, null, '', 'abc', 'x'.repeat(200), p.token + 'x', p.token.replace(/.$/, (c) => (c === '0' ? '1' : '0')), p.gid + '.' + '0'.repeat(32), '../' + p.token, { toString() { return p.token } }]) {
    assert.equal(w.mgr.status({ token: bad, status: {} }).error, 'unauthorized', String(bad).slice(0, 30))
    assert.equal(w.mgr.ping({ token: bad, t0: 1 }).error, 'unauthorized')
  }
  for (const call of [
    () => w.mgr.command({ token: p.token, cmd: { type: 'play' } }),
    () => w.mgr.setSettings({ token: p.token, settings: { mode: 'everyone' } }),
    () => w.mgr.setSeat({ token: p.token, gid: p.gid, seat: 'FR' }),
    () => w.mgr.kick({ token: p.token, gid: p.gid }),
    () => w.mgr.beep({ token: p.token, action: 'start' }),
    () => w.mgr.close({ token: p.token }),
    () => w.mgr.autoSeat({ token: p.token }),
    () => w.mgr.sync({ token: p.token, seq: 1, pos: 1, at: w.clock.t })
  ]) { const r = call(); assert.equal(r.error, 'not_allowed', JSON.stringify(r)); assert.equal(r.status, 403) }
  assert.equal(w.mgr.tune({ token: p.token, target: w.made.gid, patch: { trimMs: 5 } }).error, 'not_allowed', 'a phone cannot tune the screen')
  assert.equal(w.mgr.tune({ token: p.token, target: w.guest('Bo').gid, patch: { trimMs: 5 } }).error, 'not_allowed', 'nor another phone')
  assert.equal(w.mgr.command({ token: w.tv, cmd: { type: 'play' } }).ok, true)
})

test('nothing secret leaves the room: snapshots carry no tokens or hashes, and only the screen sees the host view', async () => {
  const w = await room()
  const a = w.phone('Ann')
  const text = JSON.stringify(a.sink.events) + JSON.stringify(w.tvSink.events)
  assert.ok(!text.includes(a.token.split('.')[1]) && !text.includes(w.tv.split('.')[1]) && !text.includes(w.code), 'no secret and no room code in any event')
  assert.ok(!/tokenHash|"token"/.test(text))
  assert.equal(a.sink.last('state').host, undefined)
  assert.ok(tvView(w).host.guests.length === 1)
})

// ------------------------------------------------------------------ seating chart
test('seating chart: moving a phone swaps with whoever has the seat; spare and auto-seat work; bad seats are refused', async () => {
  const w = await room()
  const a = w.guest('Ann'); const b = w.guest('Bo'); const c = w.guest('Cy')
  assert.equal(w.mgr.setSeat({ token: w.tv, gid: a.gid, seat: 'FC' }).ok, true)
  let g = tvView(w).host.guests
  assert.deepEqual(g.map((x) => [x.name, x.seat]), [['Ann', 'FC'], ['Bo', 'FR'], ['Cy', 'FL']], 'Cy had the centre and takes Ann\'s old seat')
  assert.equal(g[0].manual, true)
  assert.equal(w.mgr.setSeat({ token: w.tv, gid: b.gid, seat: 'off' }).ok, true)
  assert.equal(tvView(w).host.guests[1].seatLabel, 'Spare')
  assert.equal(w.mgr.setSeat({ token: w.tv, gid: b.gid, seat: 'LFE' }).ok, true)
  assert.equal(w.mgr.setSeat({ token: w.tv, gid: b.gid, seat: 'nonsense' }).error, 'bad_seat')
  assert.equal(w.mgr.setSeat({ token: w.tv, gid: 'ffffffffffff', seat: 'FL' }).error, 'no_such_guest')
  assert.equal(w.mgr.setSeat({ token: w.tv, gid: w.made.gid, seat: 'FL' }).error, 'no_such_guest', 'the screen has no seat')
  assert.equal(w.mgr.autoSeat({ token: w.tv }).ok, true)
  assert.deepEqual(tvView(w).host.guests.map((x) => x.seat), ['FL', 'FR', 'FC'])
  assert.equal(tvView(w).host.guests.every((x) => !x.manual), true)
  void c
})

test('presets: stereo pair and everyone re-seat by join order and set the right sound for each phone', async () => {
  const w = await room()
  for (const n of ['Ann', 'Bo', 'Cy', 'Di']) w.phone(n)
  assert.equal(w.mgr.setSettings({ token: w.tv, settings: { mode: 'stereo' } }).ok, true)
  assert.deepEqual(tvView(w).host.guests.map((x) => x.seat), ['DL', 'DR', 'DL', 'DR'])
  assert.deepEqual(tvView(w).host.seats.map((s) => s.seat), ['DL', 'DR'])
  assert.equal(w.mgr.setSettings({ token: w.tv, settings: { mode: 'everyone' } }).ok, true)
  assert.deepEqual(tvView(w).host.guests.map((x) => x.seat), ['DM', 'DM', 'DM', 'DM'])
  assert.equal(w.mgr.setSettings({ token: w.tv, settings: { mode: 'surround' } }).ok, true)
  assert.deepEqual(tvView(w).host.guests.map((x) => x.seat), ['FL', 'FR', 'FC', 'SL'])
  assert.equal(w.mgr.setSettings({ token: w.tv, settings: { mode: 'quad' } }).error, 'bad_mode')
})

// ------------------------------------------------------------------ what each device plays
test('a phone plays its seat once it has tapped Enable audio; until then the TV covers it', async () => {
  const w = await room()
  const a = w.guest('Ann')
  a.sink = sink(); w.mgr.attach({ token: a.token, sink: a.sink })
  const me = () => a.sink.last('state')
  assert.deepEqual(me().you.layers, [], 'connected but not unlocked: not present yet')
  assert.equal(tvView(w).host.tv.native, true, 'no phone is playing: the TV keeps its own sound')
  w.mgr.status({ token: a.token, status: { unlocked: true, ready: true, seq: 1, state: 'ready', errMs: 1 } })
  assert.deepEqual(me().you.layers, [{ feed: 'FL', gain: 1 }])
  assert.equal(me().you.hp, 100); assert.equal(me().you.lp, 0)
  assert.equal(tvView(w).host.tv.native, false)
  // one phone is here, so the TV fills in every other channel of the surround mix
  assert.deepEqual(tvView(w).you.layers.map((l) => l.feed), ['FR', 'FC', 'SL', 'SR', 'LFE'])
  assert.deepEqual(tvView(w).you.layers.find((l) => l.feed === 'FR').pan, [0, 1])
  assert.equal(tvView(w).room.tvFills.length, 5)
})

test('the sub phone gets the low-pass, satellites the high-pass; trim and gain are per phone and clamped', async () => {
  const w = await room()
  const phones = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => w.phone(n))
  const sub = phones[5]
  assert.equal(sub.sink.last('state').you.seat, 'LFE')
  assert.equal(sub.sink.last('state').you.lp, 120); assert.equal(sub.sink.last('state').you.hp, 0)
  assert.equal(phones[0].sink.last('state').you.hp, 100)
  assert.equal(w.mgr.tune({ token: phones[0].token, patch: { trimMs: 9999, gainDb: 99 } }).trimMs, 500)
  assert.equal(phones[0].sink.last('state').you.gainDb, 12)
  assert.equal(w.mgr.tune({ token: phones[0].token, patch: { trimMs: -9999, gainDb: -99 } }).trimMs, -500)
  assert.equal(w.mgr.tune({ token: phones[0].token, patch: { trimMs: 'x' } }).error, 'bad_setting')
  assert.equal(w.mgr.tune({ token: phones[0].token, patch: { trimMs: 37.6 } }).trimMs, 38)
  // the screen tunes any phone: full range, custom EQ, back to auto
  assert.equal(w.mgr.tune({ token: w.tv, target: phones[1].gid, patch: { eq: 'full' } }).ok, true)
  assert.equal(phones[1].sink.last('state').you.hp, 0)
  w.mgr.tune({ token: w.tv, target: phones[1].gid, patch: { eq: { hp: 250, lp: 9000 } } })
  assert.deepEqual([phones[1].sink.last('state').you.hp, phones[1].sink.last('state').you.lp], [250, 9000])
  w.mgr.tune({ token: w.tv, target: phones[1].gid, patch: { eq: 'auto' } })
  assert.equal(phones[1].sink.last('state').you.hp, 100)
  assert.equal(w.mgr.tune({ token: w.tv, target: phones[1].gid, patch: { eq: 'weird' } }).error, 'bad_setting')
  // a phone that is muted is treated as absent
  w.mgr.tune({ token: phones[2].token, patch: { muted: true } })
  assert.ok(tvView(w).you.layers.some((l) => l.feed === 'FC'), 'its channel moves to the TV')
})

test('a phone on Spare plays nothing in any mode, and does not count as "a phone is here"', async () => {
  const w = await room()
  const a = w.phone('Ann')
  w.mgr.setSeat({ token: w.tv, gid: a.gid, seat: 'off' })
  assert.deepEqual(a.sink.last('state').you.layers, [])
  assert.equal(tvView(w).host.tv.native, true, 'only a spare phone is here: the TV keeps its own sound')
  w.mgr.setSettings({ token: w.tv, settings: { mode: 'everyone' } })
  assert.equal(a.sink.last('state').you.seat, 'DM', 'a new preset seats everybody again')
  w.mgr.setSeat({ token: w.tv, gid: a.gid, seat: 'off' })
  assert.deepEqual(a.sink.last('state').you.layers, [], 'spare in "everyone" too')
  assert.deepEqual(tvView(w).you.layers, [])
})

test('a phone leaves: the TV fills in, or a neighbour takes over, or the channel is dropped', async () => {
  const w = await room()
  const p = ['Ann', 'Bo', 'Cy', 'Di', 'Ed'].map((n) => w.phone(n)) // FL FR FC SL SR (no sub)
  const di = p[3]
  assert.deepEqual(tvView(w).you.layers.map((l) => l.feed), ['LFE'], 'the sub has no phone, so the TV plays it')
  w.mgr.leave({ token: di.token })
  assert.deepEqual(tvView(w).you.layers.map((l) => l.feed).sort(), ['LFE', 'SL'])
  assert.equal(w.mgr.setSettings({ token: w.tv, settings: { fillIn: 'neighbour' } }).ok, true)
  assert.deepEqual(tvView(w).you.layers, [])
  assert.deepEqual(p[0].sink.last('state').you.layers.map((l) => l.feed), ['FL', 'SL', 'LFE'].filter((f) => p[0].sink.last('state').you.layers.some((l) => l.feed === f)))
  assert.ok(p[0].sink.last('state').you.layers.some((l) => l.feed === 'SL' && l.gain === 0.75), 'the front-left phone also plays the surround-left channel at 0.75')
  assert.equal(w.mgr.setSettings({ token: w.tv, settings: { fillIn: 'off' } }).ok, true)
  assert.deepEqual(tvView(w).you.layers, [])
  assert.deepEqual(tvView(w).room.dropped.sort(), ['LFE', 'SL'])
  assert.equal(w.mgr.setSettings({ token: w.tv, settings: { fillIn: 'sometimes' } }).error, 'bad_setting')
})

// ------------------------------------------------------------------ the timeline
test('play with everyone ready starts at once, leadMs ahead; pause stops where the picture is', async () => {
  const w = await room()
  w.phone('Ann'); w.phone('Bo')
  w.mgr.status({ token: w.tv, status: { ready: true, seq: 1, state: 'paused' } })
  const r = w.mgr.command({ token: w.tv, cmd: { type: 'play' } })
  assert.equal(r.ok, true); assert.equal(r.timeline.state, 'playing'); assert.equal(r.timeline.anchorAt, w.clock.t + 800)
  assert.equal(r.timeline.seq, 2)
  w.clock.t += 10800 // 10 s of film
  const p = w.mgr.command({ token: w.tv, cmd: { type: 'pause' } })
  assert.equal(p.timeline.state, 'paused'); assert.ok(Math.abs(p.timeline.anchorPos - 10) < 0.001)
  const s = w.mgr.command({ token: w.tv, cmd: { type: 'seek', pos: 3600 } })
  assert.equal(s.timeline.anchorPos, 3600); assert.equal(s.timeline.state, 'paused')
  assert.equal(w.mgr.command({ token: w.tv, cmd: { type: 'seek', pos: 1e9 } }).timeline.anchorPos, 7200, 'clamped to the film')
  assert.equal(w.mgr.command({ token: w.tv, cmd: { type: 'seek', pos: 'x' } }).error, 'bad_position')
  assert.equal(w.mgr.command({ token: w.tv, cmd: { type: 'dance' } }).error, 'bad_command')
  assert.equal(w.mgr.command({ token: w.tv, cmd: null }).error, 'bad_request')
})

test('a seek while playing HOLDS the film until every phone has its pieces, then starts together; a slow phone cannot hold it forever', async () => {
  const w = await room()
  const a = w.phone('Ann'); const b = w.phone('Bo')
  w.mgr.status({ token: w.tv, status: { ready: true, seq: 1, state: 'paused' } })
  w.mgr.command({ token: w.tv, cmd: { type: 'play' } })
  w.clock.t += 5000
  const seek = w.mgr.command({ token: w.tv, cmd: { type: 'seek', pos: 1800 } })
  assert.equal(seek.timeline.state, 'paused'); assert.equal(seek.hold.reason, 'seek')
  const seq = seek.timeline.seq
  assert.deepEqual(a.sink.last('state').room.hold.waitingFor.sort(), ['Ann', 'Bo', 'the screen'])
  // everybody reports the new position loaded, one at a time
  w.mgr.status({ token: a.token, status: { ready: true, seq } })
  w.mgr.status({ token: w.tv, status: { ready: true, seq } })
  assert.equal(timeline(w).state, 'paused', 'Bo is still loading')
  assert.deepEqual(w.tvSink.last('tl').hold.waitingFor, ['Bo'], 'the screen is told who it is waiting for')
  w.mgr.status({ token: b.token, status: { ready: true, seq } })
  assert.equal(timeline(w).state, 'playing'); assert.equal(timeline(w).anchorPos, 1800); assert.equal(timeline(w).anchorAt, w.clock.t + 800)
  assert.equal(a.sink.last('state').room.hold, null)
  // a report for an OLDER plan does not count
  w.mgr.command({ token: w.tv, cmd: { type: 'seek', pos: 900 } })
  w.mgr.status({ token: a.token, status: { ready: true, seq: seq } })
  w.mgr.status({ token: b.token, status: { ready: true, seq: seq } })
  w.mgr.status({ token: w.tv, status: { ready: true, seq: seq } })
  assert.equal(timeline(w).state, 'paused', 'still holding: nobody has applied the newest plan')
  // a phone that never answers holds it up for 6 s at most
  w.clock.t += 5000; w.mgr.sweep()
  assert.equal(timeline(w).state, 'paused')
  w.clock.t += 1500; w.mgr.sweep()
  assert.equal(timeline(w).state, 'playing'); assert.equal(timeline(w).anchorPos, 900)
})

test('no phones, no hold: a seek just moves the film; a phone that is not present never holds it up', async () => {
  const w = await room()
  w.mgr.status({ token: w.tv, status: { ready: true, seq: 1 } })
  w.mgr.command({ token: w.tv, cmd: { type: 'play' } })
  w.clock.t += 2000
  const s = w.mgr.command({ token: w.tv, cmd: { type: 'seek', pos: 100 } })
  assert.equal(s.timeline.state, 'playing'); assert.equal(s.hold, null)
  const lazy = w.guest('Lazy') // never tapped "Enable audio"
  void lazy
  const s2 = w.mgr.command({ token: w.tv, cmd: { type: 'seek', pos: 200 } })
  assert.equal(s2.timeline.state, 'playing', 'a locked phone is not waited for')
})

test('play while phones are still loading waits for them (the room holds, then starts by itself)', async () => {
  const w = await room()
  const a = w.phone('Ann')
  w.mgr.status({ token: a.token, status: { ready: false, seq: 1 } })
  w.mgr.status({ token: w.tv, status: { ready: true, seq: 1 } })
  const r = w.mgr.command({ token: w.tv, cmd: { type: 'play' } })
  assert.equal(r.timeline.state, 'paused'); assert.equal(r.hold.reason, 'waiting')
  assert.ok(tvView(w).room.hold.waitingFor.includes('Ann'), 'the screen shows "waiting for Ann"')
  w.mgr.status({ token: a.token, status: { ready: true, seq: r.timeline.seq } })
  assert.equal(timeline(w).state, 'playing')
  // a phone leaving while everybody waits for it releases the room
  const w2 = await room()
  const x = w2.phone('X'); w2.mgr.status({ token: x.token, status: { ready: false, seq: 1 } }); w2.mgr.status({ token: w2.tv, status: { ready: true, seq: 1 } })
  w2.mgr.command({ token: w2.tv, cmd: { type: 'play' } })
  assert.equal(timeline(w2).state, 'paused')
  w2.mgr.leave({ token: x.token })
  assert.equal(timeline(w2).state, 'playing')
})

test('measured position: small errors nudge the anchor (rev), big ones are a jump (seq), stale or early reports are ignored', async () => {
  const w = await room()
  w.mgr.status({ token: w.tv, status: { ready: true, seq: 1 } })
  w.mgr.command({ token: w.tv, cmd: { type: 'play' } })
  const seq = timeline(w).seq
  w.clock.t += 500 // 200 ms after the start time: too early to trust
  assert.equal(w.mgr.sync({ token: w.tv, seq, pos: 0.2, at: w.clock.t }).ignored, true)
  w.clock.t += 9500 // 10 s of playing after the anchor (anchorAt = +800)
  const at = w.clock.t
  const ok = w.mgr.sync({ token: w.tv, seq, pos: 9.2 + 0.001, at }) // predicted (10000-800)/1000 = 9.2
  assert.equal(ok.ignored, undefined); assert.equal(timeline(w).rev, 0, 'a 1 ms difference is ignored')
  const nudge = w.mgr.sync({ token: w.tv, seq, pos: 9.2 + 0.08, at })
  assert.equal(timeline(w).rev, 1); assert.equal(timeline(w).seq, seq, 'seq unchanged: phones nudge, they do not re-plan')
  assert.ok(Math.abs(timeline(w).anchorPos - 9.24) < 1e-9, 'half way: ' + timeline(w).anchorPos)
  assert.equal(w.tvSink.last('tl').timeline.rev, 1)
  assert.equal(w.mgr.sync({ token: w.tv, seq: seq - 1, pos: 50, at }).ignored, true, 'a measurement from before a seek is ignored')
  const jump = w.mgr.sync({ token: w.tv, seq, pos: 30, at })
  assert.equal(jump.jumped, true); assert.equal(timeline(w).seq, seq + 1); assert.equal(timeline(w).anchorPos, 30)
  assert.equal(w.mgr.sync({ token: w.tv, seq: timeline(w).seq, pos: 30, at: at + 999999 }).ignored, true, 'a timestamp far from now is ignored')
  w.mgr.command({ token: w.tv, cmd: { type: 'pause' } })
  assert.equal(w.mgr.sync({ token: w.tv, seq: timeline(w).seq, pos: 5, at: w.clock.t }).ignored, true, 'nothing to correct while paused')
  assert.equal(w.mgr.sync({ token: w.tv, seq: 'x', pos: 5, at: w.clock.t }).ignored, true)
})

test('rate changes re-anchor without a jump; only the known rates are accepted; a repeated command id is answered once', async () => {
  const w = await room()
  w.mgr.status({ token: w.tv, status: { ready: true, seq: 1 } })
  w.mgr.command({ token: w.tv, cmd: { type: 'play' } })
  w.clock.t += 10800
  const r = w.mgr.command({ token: w.tv, cmd: { type: 'rate', rate: 1.5 } })
  assert.equal(r.timeline.rate, 1.5); assert.ok(Math.abs(r.timeline.anchorPos - 10) < 1e-6)
  assert.equal(w.mgr.command({ token: w.tv, cmd: { type: 'rate', rate: 7 } }).error, 'bad_rate')
  const seq = timeline(w).seq
  w.mgr.command({ token: w.tv, cmd: { type: 'pause', cid: 'abc' } })
  assert.equal(w.mgr.command({ token: w.tv, cmd: { type: 'pause', cid: 'abc' } }).duplicate, true)
  assert.equal(timeline(w).seq, seq + 1)
  assert.equal(w.mgr.command({ token: w.tv, cmd: { type: 'pause', cid: '../../' } }).ok, true, 'a hostile command id is simply not remembered')
})

test('join mid-film and rejoin: a phone that arrives late gets the running timeline and needs no special case', async () => {
  const w = await room()
  w.phone('Ann')
  w.mgr.status({ token: w.tv, status: { ready: true, seq: 1 } })
  w.mgr.command({ token: w.tv, cmd: { type: 'play' } })
  w.clock.t += 60800
  const late = w.guest('Late')
  const tl = late.snapshot.room.timeline
  assert.equal(tl.state, 'playing'); assert.ok(Math.abs(tl.anchorPos + (late.snapshot.serverNow - tl.anchorAt) / 1000 - 60) < 0.01)
  // the connection drops and comes back: the state arrives first thing on the new stream
  const s1 = sink(); const att = w.mgr.attach({ token: late.token, sink: s1 })
  att.detach()
  w.clock.t += 5000
  const s2 = sink(); w.mgr.attach({ token: late.token, sink: s2 })
  assert.equal(s2.events[0].event, 'state'); assert.equal(s2.events[0].data.room.timeline.state, 'playing')
  assert.equal(s2.events[0].data.you.name, 'Late')
})

// ------------------------------------------------------------------ beep test, sync quality, bluetooth
test('beep test: the screen and every present phone beep in turn (different pitch), or all at once; stop clears it', async () => {
  const w = await room()
  const a = w.phone('Ann'); const b = w.phone('Bo'); w.guest('Locked')
  const r = w.mgr.beep({ token: w.tv, action: 'start' })
  assert.equal(r.ok, true)
  assert.deepEqual(r.beep.slots.map((s) => s.name), ['The screen', 'Ann', 'Bo'])
  assert.equal(new Set(r.beep.slots.map((s) => s.freq)).size, 3)
  assert.equal(r.beep.startAt, w.clock.t + 2500); assert.equal(r.beep.pattern, 'turns')
  assert.equal(a.sink.last('state').room.beep.id, r.beep.id)
  const t = w.mgr.beep({ token: w.tv, action: 'start', pattern: 'together' })
  assert.equal(t.beep.pattern, 'together'); assert.equal(new Set(t.beep.slots.map((s) => s.freq)).size, 1)
  assert.equal(t.beep.id, r.beep.id + 1)
  w.mgr.beep({ token: w.tv, action: 'stop' })
  assert.equal(b.sink.last('state').room.beep, null)
  assert.equal(w.mgr.beep({ token: w.tv, action: 'bang' }).error, 'bad_command')
  w.mgr.beep({ token: w.tv, action: 'start' })
  w.clock.t += 60000; w.mgr.sweep()
  assert.equal(tvView(w).room.beep, null, 'the test ends by itself')
})

test('sync quality: green up to 30 ms, amber up to 80, red above; away and locked phones are not judged; Bluetooth is flagged', async () => {
  assert.equal(ps.syncQuality({ errMs: 2, driftMs: 3 }).level, 'good')
  assert.equal(ps.syncQuality({ errMs: 10, driftMs: -25 }).level, 'warn')
  assert.equal(ps.syncQuality({ errMs: 30, driftMs: 10 }).level, 'warn')
  assert.equal(ps.syncQuality({ errMs: 60, driftMs: 30 }).level, 'bad')
  assert.equal(ps.syncQuality({ errMs: 30, driftMs: 0 }).level, 'good')
  assert.equal(ps.syncQuality({ errMs: -1 }).level, 'syncing')
  assert.equal(ps.syncQuality({ errMs: 1 }, { connected: false }).level, 'away')
  assert.equal(ps.syncQuality({ errMs: 1 }, { unlocked: false }).level, 'locked')
  const w = await room()
  const a = w.phone('Ann')
  w.mgr.status({ token: a.token, status: { errMs: 4, driftMs: 2, outLatencyMs: 180, rttMs: 7 } })
  w.mgr.sweep()
  const g = tvView(w).host.guests[0]
  assert.equal(g.level, 'good'); assert.equal(g.estMs, 6); assert.equal(g.btLikely, true); assert.equal(g.rttMs, 7)
  w.mgr.status({ token: a.token, status: { errMs: 25, driftMs: 70, outLatencyMs: 20 } }); w.mgr.sweep()
  assert.equal(tvView(w).host.guests[0].level, 'bad'); assert.equal(tvView(w).host.guests[0].btLikely, false)
  w.mgr.tune({ token: a.token, patch: { bt: true } })
  assert.equal(tvView(w).host.guests[0].btLikely, true, 'the phone can say it is on a Bluetooth speaker')
})

// ------------------------------------------------------------------ housekeeping
test('a phone that drops keeps its seat (away), loses it after 20 minutes; a phone that comes back is present again', async () => {
  const w = await room()
  const a = w.phone('Ann')
  a.att.detach()
  w.clock.t += 20000; w.mgr.sweep()
  assert.equal(tvView(w).host.guests[0].connected, false); assert.equal(tvView(w).host.guests[0].level, 'away')
  assert.equal(tvView(w).host.tv.native, true, 'no phone is here any more: the TV keeps the film sound')
  const b = w.guest('Bo') // joins while Ann is away
  assert.equal(b.snapshot.you.seat, 'FR', 'Ann\'s seat is held for her')
  const s = sink(); const back = w.mgr.attach({ token: a.token, sink: s })
  assert.equal(s.last('state').you.seat, 'FL')
  back.detach()
  w.clock.t += 21 * 60 * 1000; w.mgr.sweep()
  assert.equal(w.mgr._rooms.get(w.code).guests.has(a.gid), false, 'removed after 20 minutes away')
  assert.equal(w.mgr.status({ token: a.token, status: {} }).error, 'unauthorized')
})

test('the room closes when the screen is gone for 10 minutes, when it is too old, or when the host closes it; everyone is told', async () => {
  const closed = []
  const w = await room({ onRoomClosed: (r) => closed.push(r.id) })
  const a = w.phone('Ann')
  w.tvSink.events.length = 0
  w.mgr._rooms.get(w.code).guests.get(w.made.gid).sinks.clear()
  w.clock.t += 9 * 60 * 1000; w.mgr.sweep()
  assert.equal(w.mgr.roomCount(), 1)
  w.clock.t += 2 * 60 * 1000; w.mgr.sweep()
  assert.equal(w.mgr.roomCount(), 0); assert.equal(a.sink.last('closed').reason, 'screen_gone'); assert.equal(closed.length, 1)
  assert.equal(w.mgr.join({ code: w.code, name: 'x', ip: '1.1.1.1' }).error, 'not_found')
  const old = await room()
  old.clock.t += 11 * 3600 * 1000; old.mgr.sweep()
  assert.equal(old.mgr.roomCount(), 0)
  const c = await room()
  const p = c.phone('Ann')
  assert.equal(c.mgr.close({ token: c.tv }).ok, true)
  assert.equal(p.sink.last('closed').reason, 'closed_by_host'); assert.equal(p.sink.closed, true)
  assert.equal(c.mgr.status({ token: p.token, status: {} }).error, 'unauthorized')
  const d = await room(); d.mgr.closeAll(); assert.equal(d.mgr.roomCount(), 0)
})

test('kick removes a phone, tells it, and refuses its address for the rest of the room', async () => {
  const w = await room()
  const a = w.phone('Ann')
  const noisy = w.mgr.join({ code: w.code, name: 'Noisy', ip: '10.9.9.9' })
  noisy.sink = sink(); w.mgr.attach({ token: noisy.token, sink: noisy.sink })
  assert.equal(w.mgr.kick({ token: w.tv, gid: noisy.gid }).ok, true)
  assert.equal(noisy.sink.last('kicked').reason, 'removed_by_host')
  assert.equal(w.mgr.status({ token: noisy.token, status: {} }).error, 'unauthorized')
  assert.equal(w.mgr.join({ code: w.code, name: 'Noisy again', ip: '10.9.9.9' }).error, 'not_found', 'looks like a wrong code')
  assert.equal(w.mgr.join({ code: w.code, name: 'Other', ip: '10.9.9.10' }).ok, true)
  assert.equal(w.mgr.kick({ token: w.tv, gid: w.made.gid }).error, 'no_such_guest')
  void a
})

test('every call is rate-limited (status, ping, command, tune, audio) with a retry time', async () => {
  const w = await room({ rates: { status: 3, ping: 3, command: 3, tune: 3, audio: 3 } })
  const a = w.guest('Ann')
  const many = (fn) => Array.from({ length: 6 }, fn)
  assert.ok(many(() => w.mgr.status({ token: a.token, status: {} })).some((r) => r.status === 429 && r.retryAfterSeconds >= 1))
  assert.ok(many(() => w.mgr.ping({ token: a.token, t0: 1 })).some((r) => r.status === 429))
  assert.ok(many(() => w.mgr.command({ token: w.tv, cmd: { type: 'pause', pos: 1 } })).some((r) => r.status === 429))
  assert.ok(many(() => w.mgr.tune({ token: a.token, patch: { trimMs: 1 } })).some((r) => r.status === 429))
  assert.ok(many(() => w.mgr.audioAccess({ token: a.token })).some((r) => r.status === 429))
  w.clock.t += 11000
  assert.equal(w.mgr.ping({ token: a.token, t0: 1 }).ok, true, 'the limit lifts with time')
})

test('audio access: only this room\'s film, and a phone behind on the plan is told it is stale', async () => {
  const w = await room()
  const a = w.guest('Ann')
  const ok = w.mgr.audioAccess({ token: a.token, seq: 1 })
  assert.equal(ok.ok, true); assert.equal(ok.audioKey, 'key-' + film.id)
  assert.equal(w.mgr.audioAccess({ token: 'nope' }).error, 'unauthorized')
  w.mgr.command({ token: w.tv, cmd: { type: 'seek', pos: 10 } })
  const stale = w.mgr.audioAccess({ token: a.token, seq: 1 })
  assert.equal(stale.status, 409); assert.equal(stale.error, 'stale'); assert.ok(stale.timeline.seq >= 2)
  assert.equal(w.mgr.audioAccess({ token: a.token, seq: timeline(w).seq }).ok, true)
  assert.equal(w.mgr.audioAccess({ token: a.token }).ok, true, 'a request that says nothing is served')
})

test('status reports are validated: unknown states, silly numbers and a claimed future plan are clamped or ignored', async () => {
  const w = await room()
  const a = w.guest('Ann')
  w.mgr.status({ token: a.token, status: { state: 'exploding', unlocked: 'yes', errMs: 1e12, driftMs: -1e12, rttMs: 'x', seq: 9999, ready: 1 } })
  const g = w.mgr._rooms.get(w.code).guests.get(a.gid).status
  assert.equal(g.state, 'locked'); assert.equal(g.unlocked, false); assert.equal(g.errMs, 100000); assert.equal(g.driftMs, -100000); assert.equal(g.rttMs, 0)
  assert.equal(g.seq, timeline(w).seq, 'cannot claim to have applied a plan that does not exist yet'); assert.equal(g.ready, false)
  assert.equal(w.mgr.status({ token: a.token, status: null }).ok, true)
})

test('streams: the state comes first, several tabs of one phone are capped, and a dead stream is dropped', async () => {
  const w = await room()
  const a = w.guest('Ann')
  const s1 = sink(); const s2 = sink(); const s3 = sink()
  w.mgr.attach({ token: a.token, sink: s1 }); w.mgr.attach({ token: a.token, sink: s2 }); w.mgr.attach({ token: a.token, sink: s3 })
  assert.equal(s1.events[0].event, 'state'); assert.equal(s1.closed, true, 'the oldest of three streams was closed')
  const dead = { write() { throw new Error('gone') }, close() { this.closed = true } }
  const b = w.guest('Bo'); w.mgr.attach({ token: b.token, sink: dead })
  w.mgr.setSettings({ token: w.tv, settings: { avOffsetMs: 40 } })
  assert.equal(dead.closed, true)
  assert.equal(s3.last('state').room.avOffsetMs, 40)
  assert.equal(w.mgr.setSettings({ token: w.tv, settings: { avOffsetMs: 99999 } }).settings.avOffsetMs, 500)
  assert.equal(w.mgr.poll({ token: a.token }).you.name, 'Ann')
  assert.equal(w.mgr.poll({ token: 'x' }).error, 'unauthorized')
  assert.equal(w.mgr.attach({ token: 'x', sink: sink() }).error, 'unauthorized')
})
