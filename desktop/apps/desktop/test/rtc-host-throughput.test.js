// The tunnel's speed rules, on their own (see docs/TUNNEL-THROUGHPUT.md for why each exists):
//  - response frames as big as the viewer's data channel accepts, never bigger;
//  - how much may queue, following the connection's speed;
//  - waking on the channel's drain event, not a timer;
//  - "stripes": extra connections that add to one viewer's download, and only that viewer's.
// The first group needs nothing but the agent's functions; the second runs the real agent, the
// real Worker and a werift viewer (like rtc-host.e2e.test.js). Needs werift: see helpers/rtcHarness.
const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const H = require('./helpers/rtcHarness')
const { makeClient } = require('./perf/tunnelViewer')

const skip = H.NM ? false : 'werift not found (set BEEBO_RTC_NODE_MODULES)'
const sleep = H.sleep

let host = null
function agentModule() {
  if (host) return host
  process.env.NODE_PATH = H.NM
  Module._initPaths()
  process.env.BEEBO_HOST_TOKEN = process.env.BEEBO_HOST_TOKEN || 'unit-test-token'
  host = require(H.AGENT)
  return host
}

// A stand-in data channel for the flow-control functions.
function fakeChannel(buffered) {
  const handlers = new Set()
  const ch = {
    bufferedAmount: buffered,
    bufferedAmountLowThreshold: 0,
    bufferedAmountLow: { subscribe(fn) { handlers.add(fn); return { unSubscribe() { handlers.delete(fn) } } } },
    fire() { for (const h of [...handlers]) h() },
    handlerCount: () => handlers.size,
  }
  return ch
}

// ---------------------------------------------------------------------------------------------
// Frame size
// ---------------------------------------------------------------------------------------------

test('frameLimit: as big as the viewer takes up to 64 KiB, header included, never more', { skip }, () => {
  const { frameLimit, peerMaxMessage, FRAME_MAX } = agentModule()
  const pc = (n) => ({ sctp: { remoteMaxMessageSize: n } })
  assert.equal(FRAME_MAX, 65536)
  // A browser or phone: 256 KiB. One-character id: 2 + 1 header bytes.
  assert.equal(frameLimit(pc(262144), '7', 0), 65536 - 3)
  // werift's own default, 64 KiB.
  assert.equal(frameLimit(pc(65536), '7', 0), 65536 - 3)
  // A viewer that accepts less.
  assert.equal(frameLimit(pc(16384), '7', 0), 16384 - 3)
  assert.equal(frameLimit(pc(16384), '1234567890', 0), 16384 - 12)
  // "No limit" in the SDP (0) stays at our own cap; nothing said, or an older werift with no
  // such value, is assumed 64 KiB (the RFC 8841 default).
  assert.equal(frameLimit(pc(0), '7', 0), 65536 - 3)
  assert.equal(peerMaxMessage({}), 65536)
  assert.equal(peerMaxMessage({ sctp: {} }), 65536)
  assert.equal(peerMaxMessage(null), 65536)
  // Silly values fall back rather than build frames nobody can send.
  assert.equal(peerMaxMessage(pc(5)), 65536)
  assert.equal(peerMaxMessage(pc(-1)), 65536)
  // A setting (BEEBO_CHUNK) forces a smaller frame but never a bigger one than the viewer takes.
  assert.equal(frameLimit(pc(262144), '7', 16384), 16384)
  assert.equal(frameLimit(pc(16384), '7', 60000), 16384 - 3)
  assert.equal(frameLimit(pc(262144), '7', 999999), 65536 - 3)
  // Whatever the id, header + payload fits the viewer's limit.
  for (const max of [4096, 16384, 65536, 262144]) {
    for (const id of ['1', '4242', 'a'.repeat(100), 'é'.repeat(30)]) {
      const header = 2 + Buffer.byteLength(id)
      assert.ok(header + frameLimit(pc(max), id, 0) <= Math.min(max, 65536), `max ${max} id ${id.length}`)
    }
  }
})

// ---------------------------------------------------------------------------------------------
// How much may queue
// ---------------------------------------------------------------------------------------------

test('bufferTarget follows the connection speed, within limits; a setting pins it', { skip }, () => {
  const { bufferTarget, BUFFER_MIN, BUFFER_MAX, BUFFER_START } = agentModule()
  assert.equal(bufferTarget(0, 0), BUFFER_START, 'nothing known yet')
  assert.equal(bufferTarget(NaN, 0), BUFFER_START)
  assert.equal(bufferTarget(100 * 1024, 0), BUFFER_MIN, 'a slow link still keeps the pipe fed')
  assert.equal(bufferTarget(10 * 1024 * 1024, 0), BUFFER_MAX, 'a fast one is capped: a seek must not wait behind a second of film')
  const mid = bufferTarget(2 * 1024 * 1024, 0)
  assert.ok(mid > BUFFER_MIN && mid < BUFFER_MAX, 'in between: ' + mid)
  assert.equal(bufferTarget(2 * 1024 * 1024, 300000), 300000, 'pinned wins')
  assert.ok(BUFFER_MAX <= 1024 * 1024)
})

test('noteSent smooths the send rate over quarter-second windows', { skip }, () => {
  const { noteSent } = agentModule()
  const s = {}
  assert.equal(noteSent(s, 1000, 1000), 0, 'the first window is still open')
  noteSent(s, 1000000, 1100)
  const r1 = noteSent(s, 1000000, 1260)   // 2.001 MB in 0.26 s
  assert.ok(r1 > 7e6 && r1 < 8e6, 'first estimate is the window itself: ' + r1)
  // A slower window pulls it down, but not all the way at once.
  const r2 = noteSent(s, 100000, 1520)    // 0.1 MB in 0.26 s = 0.38 MB/s
  assert.ok(r2 < r1 && r2 > 0.38e6 * 2, 'smoothed: ' + r2)
})

// ---------------------------------------------------------------------------------------------
// Waiting for the queue to drain
// ---------------------------------------------------------------------------------------------

test('waitForDrain returns at once when the queue is short, and wakes on the drain event, not a timer', { skip }, async () => {
  const { waitForDrain } = agentModule()
  const ch = fakeChannel(1000)
  const t0 = Date.now()
  await waitForDrain(ch, null, 200000)
  assert.ok(Date.now() - t0 < 20, 'nothing to wait for')

  ch.bufferedAmount = 900000
  const woke = waitForDrain(ch, null, 200000)
  await sleep(40)
  assert.equal(ch.bufferedAmountLowThreshold, 100000, 'the low-water mark is half the limit')
  assert.equal(ch.handlerCount(), 1, 'subscribed to the drain event')
  const t1 = Date.now()
  ch.bufferedAmount = 50000
  ch.fire()
  await woke
  assert.ok(Date.now() - t1 < 40, 'woken by the event within a few ms (a 250 ms slice would be far slower): ' + (Date.now() - t1))
  assert.equal(ch.handlerCount(), 0, 'and unsubscribed')
})

test('waitForDrain stops when the request is aborted, gives up on a queue that never falls, and copes without the event', { skip }, async () => {
  const { waitForDrain } = agentModule()
  // Abort (the viewer sought): out at once, with the queue still full.
  const ch = fakeChannel(900000)
  const ac = new AbortController()
  const p = waitForDrain(ch, ac.signal, 200000)
  await sleep(30)
  const t0 = Date.now()
  ac.abort()
  await p
  assert.ok(Date.now() - t0 < 40)
  assert.equal(ch.handlerCount(), 0)
  // Already aborted: never even waits.
  const t1 = Date.now()
  await waitForDrain(fakeChannel(900000), ac.signal, 200000)
  assert.ok(Date.now() - t1 < 20)

  // A gauge that never moves (the far end went quiet) must not freeze the response for ever.
  const stuck = fakeChannel(900000)
  const t2 = Date.now()
  await waitForDrain(stuck, null, 200000, { sliceMs: 20, staleMs: 120 })
  const stuckFor = Date.now() - t2
  assert.ok(stuckFor >= 100 && stuckFor < 400, 'gave up after about staleMs: ' + stuckFor)
  // ...but one that keeps falling keeps waiting, however long it takes.
  const falling = fakeChannel(900000)
  const t3 = Date.now()
  const iv = setInterval(() => { falling.bufferedAmount -= 40000 }, 30)
  await waitForDrain(falling, null, 200000, { sliceMs: 20, staleMs: 120 })
  clearInterval(iv)
  assert.ok(falling.bufferedAmount <= 200000 && Date.now() - t3 > 120, 'kept waiting while it fell')

  // An older werift with no drain event: polled every few ms instead.
  const old = { bufferedAmount: 900000 }
  setTimeout(() => { old.bufferedAmount = 0 }, 40)
  const t4 = Date.now()
  await waitForDrain(old, null, 200000)
  assert.ok(Date.now() - t4 < 500, 'polled: ' + (Date.now() - t4))
})

test('readOrFlush sends a partial frame when the source stalls, and does not when data keeps coming', { skip }, async () => {
  const { readOrFlush } = agentModule()
  let flushed = 0
  const slow = { read: () => new Promise((r) => setTimeout(() => r({ done: false, value: new Uint8Array(3) }), 80)) }
  const r = await readOrFlush(slow, () => true, async () => { flushed++ }, 20)
  assert.equal(flushed, 1)
  assert.equal(r.value.length, 3, 'and still returns what the read gave')
  flushed = 0
  const quick = { read: () => Promise.resolve({ done: false, value: new Uint8Array(1) }) }
  await readOrFlush(quick, () => true, async () => { flushed++ }, 20)
  assert.equal(flushed, 0)
  // Nothing partial waiting: it is just a read, with no timer.
  await readOrFlush(slow, () => false, async () => { flushed++ }, 20)
  assert.equal(flushed, 0)
  // A read that fails still fails.
  await assert.rejects(readOrFlush({ read: () => Promise.reject(new Error('boom')) }, () => true, async () => {}, 20), /boom/)
})

// ---------------------------------------------------------------------------------------------
// The real agent: frames within the viewer's limit, and stripes
// ---------------------------------------------------------------------------------------------

const TOTAL = 3 * H.BLOCK + 4567
let world = null
async function world_() {
  if (world) return world
  const w = await H.startWorker()
  const media = await H.startBigMedia(TOTAL)
  const token = await w.token()
  const agent = H.startAgent({ BEEBO_HOST_URL: w.base, BEEBO_HOST_TOKEN: token, BEEBO_LOCAL_URL: media.base, BEEBO_AGENT_SECRET: H.AGENT_SECRET, BEEBO_ICE_PORTS: '46960-46979' })
  await H.waitFor(() => /registered as perfhouse\.beebo\.tv/.test(agent.out.text), 30000, 'agent registration')
  world = { w, media, agent, token }
  return world
}
test.after(async () => {
  if (!world) return
  await world.agent.stop()
  world.media.server.close()
  world.w.server.close()
})

// A connected viewer plus a request helper, hashing what comes back.
async function viewer(opts = {}) {
  const { w } = await world_()
  const v = await H.connectViewer(w.base, opts)
  const c = makeClient(v.channels)
  return { v, c, pc: v.pc, channel: v.channels[0], viewerId: v.viewerId }
}

test('a viewer that takes 256 KiB gets 64 KiB frames, one that takes 16 KiB gets small ones, every byte exact', { skip, timeout: 90000 }, async () => {
  const want = H.rangeHash(0, TOTAL - 1)
  for (const [max, biggest] of [[262144, 65533], [65536, 65533], [16384, 16381]]) {
    const x = await viewer({ maxMessageSize: max })
    try {
      const hello = await x.c.hello()
      for (const f of ['headers', 'body-chunks', 'set-cookies', 'resp-headers', 'big-frames', 'stripe']) assert.ok(hello.features.includes(f), f)
      assert.equal(hello.frame, biggest, 'the hello says what this connection will get (max ' + max + ')')
      assert.equal(hello.bodyChunk, 32768)
      assert.equal(hello.stripes, 4)
      const r = await x.c.get(x.channel, '/big.bin', null)
      assert.equal(r.head.status, 200)
      assert.equal(r.bytes, TOTAL)
      assert.equal(r.sha, want, 'byte-exact with max-message-size ' + max)
      assert.ok(x.c.frames.max <= biggest, `frames stay within ${biggest}: ${x.c.frames.max}`)
      assert.ok(x.c.frames.max >= biggest - 100 || x.c.frames.max === biggest, `and use the room: ${x.c.frames.max}`)
    } finally { x.pc.close() }
  }
})

test('a viewer that sought away: the old stream stops and the new range arrives exact, even while the send queue is full', { skip, timeout: 90000 }, async () => {
  const x = await viewer()
  try {
    await x.c.hello()
    // Start a big read, then ask for another part of the same file at once.
    const first = x.c.get(x.channel, '/big.bin', 'bytes=0-').catch((e) => e)
    await sleep(150)
    const t0 = Date.now()
    const from = 2 * H.BLOCK + 99
    const second = await x.c.get(x.channel, '/big.bin', `bytes=${from}-`)
    assert.equal(second.head.status, 206)
    assert.equal(second.sha, H.rangeHash(from, TOTAL - 1))
    assert.ok(Date.now() - t0 < 15000)
    // The first is stopped by the host (a seek), so it never ends.
    const state = await Promise.race([first.then(() => 'ended', () => 'failed'), sleep(300).then(() => 'still open')])
    assert.notEqual(state, 'ended')
  } finally { x.pc.close() }
})

test('stripes: extra connections of the same viewer join a download; nothing else can', { skip, timeout: 120000 }, async () => {
  const { w, token, agent } = await world_()
  const gen = await w._test.derivePasswordHash('generated-pass-1')
  const own = await w._test.derivePasswordHash('robins own password')
  const pushed = await H.post(w.base, '/remote/members', { token, members: [{ username: 'robin', pw_hash: gen.hash, pw_salt: gen.salt, pw_iter: gen.iterations, login_hash: own.hash, login_salt: own.salt, login_iter: own.iterations }] })
  assert.equal(pushed.status, 200)

  const primary = await viewer()
  const extras = []
  try {
    await primary.c.hello()
    // The happy path: three extra connections, each says whose it is.
    for (let i = 0; i < 3; i++) {
      const e = await viewer()
      extras.push(e)
      const h = await e.c.hello(primary.viewerId)
      assert.equal(h.stripeOf, primary.viewerId, 'accepted: ' + JSON.stringify(h))
      assert.equal(h.stripeError, undefined)
    }
    // A download shared out over all four: every segment exact.
    const seg = Math.ceil(TOTAL / 8)
    const parts = new Array(8)
    let next = 0
    const all = [primary, ...extras]
    await Promise.all(all.map(async (x) => {
      for (;;) {
        const i = next++
        if (i >= 8) return
        const a = i * seg, b = Math.min(TOTAL, a + seg) - 1
        const r = await x.c.get(x.channel, '/big.bin', `bytes=${a}-${b}`)
        assert.equal(r.head.status, 206)
        assert.equal(r.sha, H.rangeHash(a, b), 'segment ' + i)
        parts[i] = r.bytes
      }
    }))
    assert.equal(parts.reduce((n, v) => n + v, 0), TOTAL)
    // Two ranges of one file at once on DIFFERENT connections do not stop each other (on one
    // connection they would: that is a seek). Done above; the log has no "seek" line for it.
    assert.ok(!/seek: stopped/.test(agent.out.text.split('data channel open').slice(-1)[0] || ''), 'no seeks in a stripe download')

    // One more than allowed.
    const fifth = await viewer()
    extras.push(fifth)
    assert.equal((await fifth.c.hello(primary.viewerId)).stripeOf, primary.viewerId, 'the 4th extra is the last that fits')
    const sixth = await viewer()
    extras.push(sixth)
    assert.equal((await sixth.c.hello(primary.viewerId)).stripeError, 'too_many')

    // Refusals. A connection that asks for something odd is simply not grouped, and works alone.
    const solo = await viewer()
    extras.push(solo)
    const refusal = async (x, id) => { const h = await x.c.hello(id); return h.stripeError }
    assert.equal(await refusal(solo, 'v-does-not-exist'), 'no_such_primary')
    const solo2 = await viewer(); extras.push(solo2)
    assert.equal(await refusal(solo2, solo2.viewerId), 'no_such_primary', 'not of itself')
    const solo3 = await viewer(); extras.push(solo3)
    assert.equal(await refusal(solo3, extras[0].viewerId), 'no_such_primary', 'not of a connection that is itself an extra one')
    const solo4 = await viewer(); extras.push(solo4)
    assert.equal(await refusal(solo4, 'x'.repeat(200)), 'bad_group')
    const solo5 = await viewer(); extras.push(solo5)
    assert.equal(await refusal(solo5, 42), 'bad_group')
    // ...and it still works on its own.
    const r = await solo.c.get(solo.channel, '/big.bin', 'bytes=0-99')
    assert.equal(r.sha, H.rangeHash(0, 99))
    // Someone ELSE signed in (a household member) cannot add a connection to the owner's session.
    const robin = await viewer({ login: { username: 'robin', pass: 'robins own password' } })
    extras.push(robin)
    assert.equal(await refusal(robin, primary.viewerId), 'not_same_viewer')
    // And a connection that is already in a group cannot be moved to another.
    assert.equal((await extras[0].c.hello('other')).stripeError, 'already_grouped')
  } finally {
    for (const x of [primary, ...extras]) { try { x.pc.close() } catch {} }
  }
})


test('stripes share ONE away-stream slot; separate viewers each take their own', { skip, timeout: 180000 }, async () => {
  const opened = []
  const close = () => { for (const x of opened) { try { x.pc.close() } catch {} } opened.length = 0 }
  // The status of a one-kilobyte range of a "video" file: 206, or 429 when the household is at its limit.
  const start = async (x, from) => {
    const r = await x.c.get(x.channel, '/video.bin', `bytes=${from}-${from + 999}`).catch((e) => ({ head: { status: 0 }, err: e }))
    return r.head && r.head.status
  }
  try {
    // One viewer with four extra connections: five connections, one stream.
    const primary = await viewer(); opened.push(primary)
    await primary.c.hello()
    const group = [primary]
    for (let i = 0; i < 4; i++) { const e = await viewer(); opened.push(e); assert.equal((await e.c.hello(primary.viewerId)).stripeOf, primary.viewerId); group.push(e) }
    const got = []
    for (const [i, x] of group.entries()) got.push(await start(x, i * 1000))
    assert.deepEqual(got, [206, 206, 206, 206, 206], 'all five connections stream: they hold one slot between them')
    // The household allows four streams at once. The group holds exactly one of them: three more
    // separate viewers fit, the fourth is told the household is at its limit.
    const others = []
    for (let i = 0; i < 4; i++) { const x = await viewer(); opened.push(x); others.push(x); await x.c.hello() }
    const more = []
    for (const [i, x] of others.entries()) more.push(await start(x, i * 1000))
    assert.equal(more.filter((s) => s === 206).length, 3, 'the group used one of the four slots: ' + more)
    assert.equal(more.filter((s) => s === 429).length, 1, 'and the fourth is refused: ' + more)
    // The group's own connections keep streaming (the slot is renewed, not lost).
    assert.equal(await start(group[3], 50000), 206)
  } finally { close() }
})
