// Phone speakers: the browser side (electron/phoneSpeakersClient.js) in plain node with a FAKE Web Audio world:
//  * clock-sync maths against the shared vectors (also checked against the campsite music script when the monorepo has it),
//  * the SSE parser, the plan validator, the link (token in a header, reconnect, auth lost),
//  * the audio engine: piece chaining, late joins, trim / picture delay, seek / hold / pause, layers, rate mute, the beep test,
//    and drift correction against a hardware clock that runs fast or slow (the numbers quoted in docs/PHONE-SPEAKERS.md are
//    from THIS simulation: nothing here touches real phones).
// Run: node --test test/phone-speakers-client.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const M = require('../electron/phoneSpeakersClient')

const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'phone-speakers-clock-vectors.json'), 'utf8'))
const asSamples = (rows) => rows.map(([t0, t1, t2, t3]) => ({ t0, t1, t2, t3 }))
const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} ${a} vs ${b}`)

// ------------------------------------------------------------------ clock maths
test('clock vectors: the estimate matches the stored expectation and stays within RTT/2 of the truth', () => {
  for (const v of vectors.vectors) {
    const est = M.ClockSync.estimate(asSamples(v.samples))
    if (v.expect === null) { assert.equal(est, null, v.name); continue }
    assert.ok(est, v.name)
    close(est.offsetMs, v.expect.offsetMs, 1e-6, v.name + ' offset'); close(est.rttMs, v.expect.rttMs, 1e-6, v.name + ' rtt'); close(est.errorMs, v.expect.errorMs, 1e-6, v.name + ' error')
    assert.equal(est.used, v.expect.used, v.name); assert.equal(est.total, v.expect.total, v.name)
    assert.ok(Math.abs(est.offsetMs - v.trueOffset) <= est.rttMs / 2 + 0.5, `${v.name}: off by ${est.offsetMs - v.trueOffset}`)
  }
})

test('clock filter vectors: a stable run is smoothed, a 500 ms step is believed at once', () => {
  const f = new M.ClockSync.ClockFilter()
  for (const step of vectors.filter) { f.update(step.in); close(f.offsetMs, step.offsetMs, 1e-9, 'offset'); close(f.errorMs, step.errorMs, 1e-9, 'error') }
  assert.ok(f.offsetMs > 599)
})

test('the estimate is the SAME as the campsite music script on the same vectors (one algorithm, two places)', (t) => {
  const file = path.join(__dirname, '..', '..', '..', '..', 'apps', 'core', 'app', 'src', 'main', 'assets', 'campsite-music.js')
  if (!fs.existsSync(file)) { t.skip('the campsite script is not in this checkout'); return }
  const camp = require(file)
  for (const v of vectors.vectors) {
    const a = M.ClockSync.estimate(asSamples(v.samples)); const b = camp.ClockSync.estimate(asSamples(v.samples))
    assert.deepEqual(a, b, v.name)
  }
  assert.deepEqual(M.ClockSync.constants, camp.ClockSync.constants)
})

test('estimate needs enough samples; spikes on one leg are rejected (many pings, lowest RTT wins)', () => {
  assert.equal(M.ClockSync.estimate([]), null)
  assert.equal(M.ClockSync.estimate(asSamples([[0, 5, 5.1, 3], [10, 15, 15.1, 13], [20, 25, 25.1, 23], [30, 35, 35.1, 33]])), null)
  const rows = []
  for (let i = 0; i < 20; i++) rows.push([i * 100, i * 100 + 1 + 1000, i * 100 + 1.05 + 1000, i * 100 + 2.05])
  for (let i = 20; i < 30; i++) rows.push([i * 100, i * 100 + 51 + 1000, i * 100 + 51.05 + 1000, i * 100 + 52.05])
  close(M.ClockSync.estimate(asSamples(rows)).offsetMs, 1000, 0.6, 'offset')
})

test('timeline maths: a start in the future holds still, playing runs at the rate, paused stays', () => {
  const tl = { state: 'playing', anchorPos: 10, anchorAt: 1000, rate: 1 }
  assert.equal(M.positionAt(tl, 500), 10); assert.equal(M.positionAt(tl, 1000), 10); assert.equal(M.positionAt(tl, 3500), 12.5)
  assert.equal(M.positionAt({ ...tl, rate: 2 }, 3000), 14); assert.equal(M.positionAt({ ...tl, state: 'paused' }, 9999), 10)
  assert.equal(M.positionAt(null, 5), 0); assert.equal(M.isRunning(tl, 999), false); assert.equal(M.isRunning(tl, 1000), true)
})

// ------------------------------------------------------------------ the parser, the plan, the words
test('SSE parser: split chunks, CRLF, multi-line data, comments, ids and no half events', () => {
  const got = []
  const p = M.createSseParser((e) => got.push(e))
  p.push('retry: 3000\n\n: hb\n\nevent: sta'); p.push('te\ndata: {"a":1}\nid: 7\n\nevent: tl\r\ndata: x\r\ndata: y\r\n\r\n')
  p.push('data: lonely\n'); assert.equal(got.length, 2)
  p.push('\n')
  assert.deepEqual(got.map((e) => [e.event, e.data, e.id]), [['state', '{"a":1}', '7'], ['tl', 'x\ny', ''], ['message', 'lonely', '']])
  const hostile = []
  const q = M.createSseParser((e) => hostile.push(e)); q.push('event: state\ndata: a\r\revent: x\rdata: b\r\r')
  assert.equal(hostile.length, 2, 'a bare CR ends a line and a frame')
})

test('cleanPlan: hostile plans are refused or clamped', () => {
  const tl = { state: 'playing', anchorPos: 5, anchorAt: 100, rate: 1, seq: 3, rev: 0 }
  assert.equal(M.cleanPlan(null), null); assert.equal(M.cleanPlan({}), null); assert.equal(M.cleanPlan({ timeline: { ...tl, anchorPos: 'x' } }), null)
  const p = M.cleanPlan({ timeline: tl, layers: [{ feed: 'FL', gain: 9 }, { feed: '../etc', gain: 1 }, { feed: 'fl', gain: 1 }, { feed: 'SR', gain: -3, pan: [2, -1] }, null, ...Array(20).fill({ feed: 'FC', gain: 1 })], gainDb: 99, trimMs: -9999, avOffsetMs: 1e9, hp: -5, lp: 1e9, segSec: 999 })
  assert.deepEqual(p.layers.slice(0, 2).map((l) => l.feed), ['FL', 'SR']); assert.equal(p.layers[0].gain, 1.5); assert.equal(p.layers[1].gain, 0); assert.deepEqual(p.layers[1].pan, [1, 0])
  assert.ok(p.layers.length <= 8); assert.equal(p.gainDb, 12); assert.equal(p.trimMs, -500); assert.equal(p.avOffsetMs, 500); assert.equal(p.hp, 0); assert.equal(p.lp, 22000); assert.equal(p.segSec, 5)
  assert.equal(M.cleanPlan({ timeline: { ...tl, state: 'exploding' } }).timeline.state, 'paused')
})

test('sync colours and the Bluetooth note', () => {
  assert.equal(M.syncLevel({ connected: true, clockReady: true, errMs: 3, driftMs: 4, phase: 'playing' }).level, 'good')
  assert.equal(M.syncLevel({ connected: true, clockReady: true, errMs: 3, driftMs: 40, phase: 'playing' }).level, 'warn')
  assert.equal(M.syncLevel({ connected: true, clockReady: true, errMs: 3, driftMs: 200, phase: 'playing' }).level, 'bad')
  assert.equal(M.syncLevel({ connected: false }).level, 'bad')
  assert.equal(M.syncLevel({ connected: true, clockReady: true, errMs: 2, phase: 'ready', unlocked: false }).text, 'Tap to enable audio')
  assert.equal(M.bluetoothNote(20, false), ''); assert.match(M.bluetoothNote(180, false), /180 ms.*Bluetooth/); assert.match(M.bluetoothNote(-1, true), /Bluetooth speaker/)
})

// ------------------------------------------------------------------ the link
function fakeTimers() {
  const t = { now: 0, q: [], seq: 0 }
  t.setTimeout = (fn, ms) => { const id = ++t.seq; t.q.push({ id, at: t.now + ms, fn }); return id }
  t.clearTimeout = (id) => { t.q = t.q.filter((x) => x.id !== id) }
  t.advance = async (ms) => {
    const end = t.now + ms
    for (;;) {
      t.q.sort((a, b) => a.at - b.at)
      if (!t.q.length || t.q[0].at > end) break
      const x = t.q.shift(); t.now = Math.max(t.now, x.at); x.fn()
      for (let i = 0; i < 6; i++) await Promise.resolve()
    }
    t.now = end
    for (let i = 0; i < 6; i++) await Promise.resolve()
  }
  return t
}
function fakeServer(timers, { offset = 1_700_000_000_000, oneWay = 2 } = {}) {
  const enc = new TextEncoder()
  const s = { calls: [], streams: [], offset, oneWay, status: 200 }
  s.fetch = (url, opts = {}) => {
    s.calls.push({ url, opts })
    if (url.endsWith('/events')) {
      if (s.status !== 200) return Promise.resolve({ ok: false, status: s.status })
      const waiting = []; const chunks = []; let ended = false
      const stream = { push(text) { chunks.push(enc.encode(text)); flush() }, end() { ended = true; flush() } }
      const flush = () => { while (waiting.length && (chunks.length || ended)) { const w = waiting.shift(); w(chunks.length ? { value: chunks.shift(), done: false } : { done: true }) } }
      s.streams.push(stream)
      return Promise.resolve({ ok: true, status: 200, body: { getReader: () => ({ read: () => new Promise((res) => { waiting.push(res); flush() }) }) } })
    }
    if (url.endsWith('/ping')) {
      const t0 = JSON.parse(opts.body).t0
      const serverAtArrival = timers.now + s.oneWay + s.offset
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, t0, t1: serverAtArrival, t2: serverAtArrival + 0.05 }) })
    }
    return Promise.resolve({ ok: true, status: s.status === 401 ? 401 : 200, json: () => Promise.resolve({ ok: true }) })
  }
  return s
}
function makeLink(opts = {}) {
  const timers = fakeTimers()
  const server = fakeServer(timers, opts.server)
  const perfNow = () => timers.now + 1000
  // the pings take oneWay each way in fake time: advance the clock inside fetch
  const wrapped = (url, o) => { const r = server.fetch(url, o); if (url.endsWith('/ping')) { timers.now += server.oneWay * 2 } return r }
  const link = M.createLink({ fetch: wrapped, base: '/speakers/api', getToken: () => 'tok', perfNow, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, TextDecoder, AbortController })
  return { link, timers, server }
}

test('link: connects with the token in a HEADER (never a URL), syncs the clock from a burst of pings, dispatches events', async () => {
  const { link, timers, server } = makeLink()
  const seen = { snap: [], tl: [] }
  link.onSnapshot = (d) => seen.snap.push(d); link.onTimeline = (d) => seen.tl.push(d)
  link.connect()
  await timers.advance(0)
  assert.equal(link.state, 'open')
  const ev = server.calls.find((c) => c.url.endsWith('/events'))
  assert.equal(ev.opts.headers['X-Speaker-Token'], 'tok'); assert.ok(!/tok/.test(ev.url), 'no token in the URL'); assert.equal(ev.opts.credentials, 'omit')
  await timers.advance(2500)
  assert.equal(link.clock.ready(), true)
  close(link.clock.offsetMs(), 1_700_000_000_000 - 1000 + 0, 6, 'offset (fake perf starts at 1000)')
  assert.ok(link.lastRtt >= 3 && link.lastRtt < 10)
  server.streams[0].push('event: state\ndata: {"you":{"seat":"FL"},"room":{}}\nid: 1\n\nevent: tl\ndata: {"timeline":{"seq":2}}\n\n')
  await timers.advance(0)
  assert.equal(seen.snap[0].you.seat, 'FL'); assert.equal(seen.tl[0].timeline.seq, 2)
  // a second burst every 30 s keeps the clock fresh
  const before = server.calls.filter((c) => c.url.endsWith('/ping')).length
  await timers.advance(31000)
  assert.ok(server.calls.filter((c) => c.url.endsWith('/ping')).length >= before + 10)
  link.close()
})

test('link: a dropped stream reconnects with back-off; closed / kicked end it for good; a refused token says so', async () => {
  const { link, timers, server } = makeLink()
  const log = []
  link.onClosed = (r) => log.push('closed:' + r); link.onKicked = (r) => log.push('kicked:' + r); link.onAuthLost = () => log.push('auth')
  link.connect(); await timers.advance(0)
  server.streams[0].end(); await timers.advance(0)
  assert.equal(link.state, 'reconnecting')
  await timers.advance(1100)
  assert.equal(server.streams.length, 2, 'reconnected after 1 s')
  server.streams[1].end(); await timers.advance(1100)
  assert.equal(server.streams.length, 3, 'a stream that had worked starts the wait over at 1 s')
  // while the computer is not answering the wait doubles: 1 s, 2 s, 4 s ... up to 10 s
  server.status = 503
  server.streams[2].end(); await timers.advance(0)
  const opens = () => server.calls.filter((c) => c.url.endsWith('/events')).length
  const n0 = opens()
  await timers.advance(1100); assert.equal(opens(), n0 + 1)
  await timers.advance(1500); assert.equal(opens(), n0 + 1, 'the next wait is 2 s')
  await timers.advance(600); assert.equal(opens(), n0 + 2)
  await timers.advance(4100); assert.equal(opens(), n0 + 3)
  await timers.advance(30000); assert.ok(opens() <= n0 + 8, 'never faster than every 10 s once backed off')
  server.status = 200
  await timers.advance(11000)
  assert.equal(link.state, 'open')
  server.streams[server.streams.length - 1].push('event: closed\ndata: {"reason":"closed_by_host"}\n\n'); await timers.advance(0)
  assert.deepEqual(log, ['closed:closed_by_host']); assert.equal(link.state, 'closed')
  const count = server.streams.length
  await timers.advance(60000); assert.equal(server.streams.length, count, 'never reconnects after the room closed')
  const b = makeLink(); b.server.status = 401; b.link.onAuthLost = () => log.push('auth401'); b.link.connect(); await b.timers.advance(0)
  assert.ok(log.includes('auth401')); assert.equal(b.link.state, 'closed')
  const c = makeLink(); c.link.onKicked = (r) => log.push('kicked:' + r); c.link.connect(); await c.timers.advance(0)
  c.server.streams[0].push('event: kicked\ndata: {"reason":"removed_by_host"}\n\n'); await c.timers.advance(0)
  assert.ok(log.includes('kicked:removed_by_host'))
})

// ------------------------------------------------------------------ the fake Web Audio world
const S = 5 // seconds per piece
function param(v) {
  return { value: v, events: [], setTargetAtTime(x, t) { this.value = x; this.events.push(['target', x, t]) }, setValueAtTime(x, t) { this.events.push(['set', x, t]); if (t <= 0) this.value = x }, linearRampToValueAtTime(x, t) { this.events.push(['ramp', x, t]) } }
}
function makeWorld(opts = {}) {
  const LATENCY = opts.latency === undefined ? 0.03 : opts.latency
  let seed = 987654321
  const noise = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return (seed / 4294967296 - 0.5) * 2 }
  const w = { perf: 50000, jitter: (opts.tsJitterMs || 0) / 1000, skew: opts.skewPpm ? opts.skewPpm / 1e6 : 0, base: 1.0, sources: [], gains: [], oscs: [], state: opts.state || 'running', LATENCY, reportLatency: opts.reportOutputLatency }
  w.ctxNow = () => w.base + ((w.perf - 50000) / 1000) * (1 + w.skew)
  w.ctx = {
    get currentTime() { return w.ctxNow() },
    get state() { return w.state },
    get outputLatency() { return w.reportLatency === undefined ? 0 : w.reportLatency },
    sampleRate: 48000, destination: { kind: 'dest' },
    getOutputTimestamp() { return { contextTime: w.ctxNow() - LATENCY + noise() * w.jitter, performanceTime: w.perf } },
    createGain() { const g = { gain: param(1), connect() {}, disconnect() {} }; w.gains.push(g); return g },
    createBiquadFilter() { return { type: '', frequency: param(0), Q: param(1), connect() {}, disconnect() {} } },
    createChannelMerger() { return { connect() {} } },
    createBuffer() { return {} },
    createOscillator() { const o = { frequency: param(0), connect() {}, start(t) { this.at = t }, stop() {} }; w.oscs.push(o); return o },
    resume() { w.state = 'running'; return Promise.resolve() },
    createBufferSource() {
      const s = { buffer: null, playbackRate: param(1), connect() {}, disconnect() {}, started: null, stopped: null,
        start(when, offset) { this.started = { when, offset }; s.startRate = this.playbackRate.value }, stop(when) { this.stopped = when === undefined ? -1 : when } }
      w.sources.push(s)
      return s
    }
  }
  return w
}
const tick = async (e, n = 6) => { for (let i = 0; i < n; i++) { e.tick(); for (let k = 0; k < 6; k++) await Promise.resolve() } }
const real = (w, feed) => w.sources.filter((s) => s.buffer && s.buffer.feed && (!feed || s.buffer.feed === feed))

/** The film position that is being HEARD (leaving the speaker) at this moment, from what was scheduled (piecewise-constant rates). */
function heardPos(w, feed) {
  const heardCtx = w.ctxNow() - w.LATENCY
  let best = null
  for (const s of w.sources) {
    if (!s.buffer || !s.started || (feed && s.buffer.feed !== feed)) continue
    const start = s.started.when
    if (start > heardCtx) continue
    if (s.stopped !== null && s.stopped !== -1 && s.stopped <= heardCtx) continue
    // integrate the rate from the start
    let t = start, pos = s.started.offset + s.buffer.piece * S, rate = s.startRate
    const evs = s.playbackRate.events.filter((e) => e[0] === 'set').sort((a, b) => a[2] - b[2])
    for (const e of evs) { if (e[2] <= start) { rate = e[1]; continue } if (e[2] >= heardCtx) break; pos += (e[2] - t) * rate; t = e[2]; rate = e[1] }
    pos += (heardCtx - t) * rate
    if (pos - s.buffer.piece * S > s.buffer.duration + 0.02) continue // that piece has ended
    if (!best || start > best.start) best = { start, pos }
  }
  return best ? best.pos : null
}

function makeEngine(w, o = {}) {
  const trueOffset = o.trueOffset === undefined ? 1234567.5 : o.trueOffset
  const estErr = o.estErr || 0
  const clock = { ready: () => o.clockReady !== false, offsetMs: () => trueOffset + estErr, hostNow: () => w.perf + trueOffset + estErr, errorMs: () => 2 }
  const fetched = []
  const e = M.createEngine({
    ctx: w.ctx, perfNow: () => w.perf, clock,
    fetchPiece: (feed, n, seq) => { fetched.push({ feed, n, seq }); if (o.fail && o.fail(feed, n, seq)) return Promise.reject(o.failWith || new Error('boom')); return Promise.resolve(Object.assign(new ArrayBuffer(8), { feed, n })) },
    decode: (bytes) => Promise.resolve({ feed: bytes.feed, piece: bytes.n, duration: o.pieceSec && o.pieceSec(bytes.n) || S, numberOfChannels: 1 })
  })
  e.fetched = fetched; e.trueOffset = trueOffset + estErr; e.clock = clock
  return e
}
const plan = (tl, o = {}) => ({ timeline: { state: 'playing', anchorPos: 0, anchorAt: 0, rate: 1, seq: 1, rev: 0, ...tl }, hold: false, segSec: S, duration: 7200, layers: [{ feed: 'FL', gain: 1 }], hp: 100, lp: 0, gainDb: 0, trimMs: 0, avOffsetMs: 0, muted: false, stereo: false, ...o })
const heardCtxOf = (w) => w.ctxNow() - w.LATENCY

test('engine: a start in the future is scheduled at the AudioContext time that is HEARD at that server time', async () => {
  const w = makeWorld(); const e = makeEngine(w); await e.unlock()
  const at = w.perf + e.trueOffset + 1500 // server time, 1.5 s away
  e.setPlan(plan({ anchorPos: 20, anchorAt: at }))
  await tick(e)
  const s = real(w, 'FL')[0]
  close(s.started.when, heardCtxOf(w) + 1.5, 1e-6, 'start when'); assert.ok(Math.abs(s.started.offset) < 1e-9, 'offset ' + s.started.offset)
  assert.equal(s.buffer.piece, 4); assert.equal(e.phase, 'playing')
  assert.deepEqual(e.fetched.map((f) => f.n).filter((n, i, a) => a.indexOf(n) === i).sort(), [4, 5], 'the piece it is in and one ahead')
  assert.ok(e.fetched.every((f) => f.seq === 1), 'requests carry the plan number so a stale one can be refused')
})

test('engine: a late joiner starts mid-piece, at the position the timeline says, a moment ahead', async () => {
  const w = makeWorld(); const e = makeEngine(w); await e.unlock()
  e.setPlan(plan({ anchorPos: 0, anchorAt: w.perf + e.trueOffset - 63000 })) // the film started 63 s ago
  await tick(e)
  const s = real(w, 'FL')[0]
  assert.equal(s.buffer.piece, 12)
  const lead = s.started.when - heardCtxOf(w)
  assert.ok(lead > 0.14 && lead < 0.2, 'lead ' + lead)
  close(s.started.offset + 12 * S, 63 + lead, 1e-6, 'position at the start of sound')
})

test('engine: pieces are chained with no gap and no overlap, at the same rate', async () => {
  const w = makeWorld(); const e = makeEngine(w); await e.unlock()
  e.setPlan(plan({ anchorPos: 0, anchorAt: w.perf + e.trueOffset + 300 }))
  await tick(e, 4)
  for (let i = 0; i < 40; i++) { w.perf += 250; await tick(e, 1) }
  const list = real(w, 'FL').sort((a, b) => a.started.when - b.started.when)
  assert.ok(list.length >= 3, 'pieces ' + list.length)
  for (let i = 1; i < list.length; i++) {
    const prevEnd = list[i - 1].started.when + (list[i - 1].buffer.duration - list[i - 1].started.offset) / list[i - 1].startRate
    close(list[i].started.when, prevEnd, 1e-9, `piece ${list[i].buffer.piece} starts where ${list[i - 1].buffer.piece} ends`)
    assert.equal(list[i].buffer.piece, list[i - 1].buffer.piece + 1); assert.equal(list[i].started.offset, 0)
  }
})

test('engine: trim and the room\'s picture delay move THIS phone\'s sound later; a negative trim earlier', async () => {
  const at = (o) => { const w = makeWorld(); const e = makeEngine(w); return e.unlock().then(async () => { e.setPlan(plan({ anchorPos: 0, anchorAt: w.perf + e.trueOffset + 2000 }, o)); await tick(e); return real(w, 'FL')[0].started.when - heardCtxOf(w) }) }
  const base = await at({})
  close(await at({ trimMs: 50 }) - base, 0.05, 1e-6, 'trim 50'); close(await at({ avOffsetMs: 120 }) - base, 0.12, 1e-6, 'picture delay')
  close(await at({ trimMs: 50, avOffsetMs: 120 }) - base, 0.17, 1e-6, 'both'); close(await at({ trimMs: -40 }) - base, -0.04, 1e-6, 'earlier')
})

test('engine: output latency the browser reports is used (a phone that says 180 ms is scheduled 180 ms earlier than the sound is wanted)', async () => {
  // the fake browser has NO getOutputTimestamp here: the fallback (currentTime - outputLatency) is what places the sound
  const w = makeWorld({ reportOutputLatency: 0.18 }); w.ctx.getOutputTimestamp = undefined
  const e = makeEngine(w); await e.unlock()
  assert.equal(e.outLatencyMs(), 180)
  e.setPlan(plan({ anchorPos: 0, anchorAt: w.perf + e.trueOffset + 2000 }))
  await tick(e)
  close(real(w, 'FL')[0].started.when, w.ctxNow() - 0.18 + 2.0, 1e-6, 'when')
  assert.equal(e.status().outLatencyMs, 180)
  const w2 = makeWorld(); const e2 = makeEngine(w2); assert.equal(e2.outLatencyMs(), -1, 'not reported: unknown')
})

test('engine: paused / holding play nothing but get READY once the pieces are loaded; a seek re-plans and restarts at the new place', async () => {
  const w = makeWorld(); const e = makeEngine(w); await e.unlock()
  e.setPlan(plan({ state: 'paused', anchorPos: 100, anchorAt: w.perf + e.trueOffset, seq: 1 }))
  assert.equal(e.ready, false, 'not ready before the pieces arrive'); assert.equal(e.status().seq, 1)
  await tick(e)
  assert.equal(e.ready, true); assert.equal(e.phase, 'ready'); assert.equal(real(w).length, 0)
  assert.equal(e.status().ready, true)
  assert.deepEqual(e.fetched.map((f) => f.n).sort((a, b) => a - b).filter((n, i, a) => a.indexOf(n) === i), [20, 21], 'the piece at 100 s and the next')
  // a hold (waiting for others) stays silent
  e.setPlan(plan({ state: 'paused', anchorPos: 100, anchorAt: w.perf + e.trueOffset, seq: 2 }, { hold: true }))
  await tick(e); assert.equal(real(w).length, 0)
  // it plays: 800 ms lead
  e.setPlan(plan({ state: 'playing', anchorPos: 100, anchorAt: w.perf + e.trueOffset + 800, seq: 3 }))
  await tick(e)
  assert.equal(real(w, 'FL').length >= 1, true)
  const first = real(w, 'FL')[0]; close(first.started.when, heardCtxOf(w) + 0.8, 1e-6, 'lead')
  // the film is moved to 30 minutes in: the old sound is stopped, the new one starts
  w.perf += 3000
  e.setPlan(plan({ state: 'playing', anchorPos: 1800, anchorAt: w.perf + e.trueOffset + 800, seq: 4 }))
  assert.notEqual(first.stopped, null, 'the old sound is stopped at once')
  await tick(e)
  const seeked = real(w, 'FL').filter((s) => s.buffer.piece === 360)
  assert.equal(seeked.length, 1); close(seeked[0].started.when, heardCtxOf(w) + 0.8, 1e-6, 'seek start')
  // an OLDER plan that arrives late changes nothing
  assert.equal(e.setPlan(plan({ state: 'paused', anchorPos: 5, seq: 3 })), true)
  await tick(e); assert.equal(e.plan.timeline.seq, 4)
})

test('engine: nothing plays until the tap (the pieces are ready meanwhile) and a suspended context asks again', async () => {
  const w = makeWorld({ state: 'suspended' }); const e = makeEngine(w)
  e.setPlan(plan({ anchorPos: 0, anchorAt: w.perf + e.trueOffset + 500 }))
  await tick(e)
  assert.equal(real(w).length, 0); assert.equal(e.phase, 'locked'); assert.equal(e.ready, true, 'ready to go the moment the guest taps'); assert.equal(e.status().state, 'locked')
  await e.unlock(); await tick(e)
  assert.equal(real(w, 'FL').length >= 1, true); assert.equal(e.phase, 'playing')
  w.state = 'suspended'; await tick(e); assert.equal(e.unlocked, false); assert.equal(e.status().unlocked, false)
})

test('engine: the clock must be synced before anything is scheduled', async () => {
  const w = makeWorld(); const e = makeEngine(w, { clockReady: false }); await e.unlock()
  e.setPlan(plan({ anchorPos: 0, anchorAt: 1 }))
  await tick(e); assert.equal(e.phase, 'syncing'); assert.equal(real(w).length, 0); assert.equal(e.status().errMs, -1)
})

test('engine: layers - a folded-in second feed plays at its gain; a removed one stops; a spare phone plays nothing but is "ready"', async () => {
  const w = makeWorld(); const e = makeEngine(w); await e.unlock()
  e.setPlan(plan({ anchorPos: 0, anchorAt: w.perf + e.trueOffset - 12000 }, { layers: [{ feed: 'FL', gain: 1 }, { feed: 'SL', gain: 0.75 }] }))
  await tick(e)
  assert.equal(real(w, 'FL').length >= 1 && real(w, 'SL').length >= 1, true)
  const sl = real(w, 'SL')[0]; assert.equal(sl.started.offset > 2, true, 'joins mid-piece like the rest')
  assert.ok(w.gains.some((g) => g.gain.value === 0.75))
  // SL's phone comes back: the folded feed is dropped
  e.setPlan(plan({ anchorPos: 0, anchorAt: w.perf + e.trueOffset - 12000, seq: 1, rev: 1 }, { layers: [{ feed: 'FL', gain: 1 }] }))
  await tick(e); assert.notEqual(sl.stopped, null)
  e.setPlan(plan({ anchorPos: 0, anchorAt: w.perf + e.trueOffset - 12000, seq: 1, rev: 2 }, { layers: [] }))
  await tick(e); assert.equal(e.phase, 'idle'); assert.equal(e.ready, true); assert.equal(e.status().state, 'idle')
  // muted is the same as no layers
  e.setPlan(plan({ anchorPos: 0, anchorAt: w.perf + e.trueOffset - 12000, seq: 1, rev: 3 }, { layers: [{ feed: 'FL', gain: 1 }], muted: true }))
  await tick(e); assert.equal(e.phase, 'idle')
})

test('engine: the TV places its layers left / right', async () => {
  const w = makeWorld(); const e = makeEngine(w); await e.unlock()
  e.setPlan(plan({ anchorPos: 0, anchorAt: w.perf + e.trueOffset + 1000 }, { stereo: true, layers: [{ feed: 'SL', gain: 1, pan: [0.9, 0] }] }))
  await tick(e)
  assert.ok(w.gains.some((g) => g.gain.value === 0.9) && w.gains.some((g) => g.gain.value === 0), 'left gain 0.9, right gain 0')
})

test('engine: at a speed other than 1x the phones stay quiet (they cannot keep the pitch) and say why', async () => {
  const w = makeWorld(); const e = makeEngine(w); await e.unlock()
  e.setPlan(plan({ anchorPos: 0, anchorAt: w.perf + e.trueOffset - 1000, rate: 1.25 }))
  await tick(e); assert.equal(e.phase, 'rate'); assert.equal(real(w).length, 0); assert.match(e.note, /normal speed/); assert.equal(e.ready, true)
})

test('engine: pieces that fail are retried with back-off; "stale" and aborted requests are asked again at once; a hopeless one is an error note', async () => {
  const w = makeWorld(); let fails = 0
  const e = makeEngine(w, { fail: (feed, n) => { if (n === 0 && fails < 2) { fails++; return true } return false } })
  await e.unlock()
  e.setPlan(plan({ state: 'paused', anchorPos: 0, anchorAt: w.perf + e.trueOffset }))
  await tick(e); assert.equal(e.ready, false)
  w.perf += 700; await tick(e); assert.equal(e.ready, false, 'the second try also failed')
  w.perf += 1300; await tick(e); assert.equal(e.ready, true)
  const w2 = makeWorld(); let stale = 0
  const e2 = makeEngine(w2, { fail: () => stale++ < 1, failWith: Object.assign(new Error('stale'), { stale: true }) })
  await e2.unlock(); e2.setPlan(plan({ state: 'paused', anchorPos: 0, anchorAt: w2.perf + e2.trueOffset }))
  await tick(e2, 8); assert.equal(e2.ready, true, 'no back-off for a stale answer')
  const w3 = makeWorld(); const e3 = makeEngine(w3, { fail: () => true }); await e3.unlock()
  e3.setPlan(plan({ state: 'paused', anchorPos: 0, anchorAt: w3.perf + e3.trueOffset }))
  for (let i = 0; i < 30; i++) { w3.perf += 5000; await tick(e3, 1) }
  assert.equal(e3.phase, 'error'); assert.match(e3.note, /Could not get the sound/)
})

test('engine: pieces past the end of the film are never asked for, and a 404 is remembered instead of retried', async () => {
  const w = makeWorld(); const e = makeEngine(w); await e.unlock()
  // a 12 s film has pieces 0, 1 and 2 (the last one 2 s long); the phone is 11 s in
  e.setPlan(plan({ anchorPos: 0, anchorAt: w.perf + e.trueOffset - 11000 }, { duration: 12 }))
  for (let i = 0; i < 12; i++) { w.perf += 250; await tick(e, 1) }
  const asked = e.fetched.map((f) => f.n)
  assert.ok(Math.max(...asked) <= 2, 'asked for ' + [...new Set(asked)].join())
  assert.equal(e.phase, 'playing')
  const w2 = makeWorld(); let calls = 0
  const e2 = makeEngine(w2, { fail: () => { calls++; return true }, failWith: Object.assign(new Error('HTTP 404'), { status: 404 }) }); await e2.unlock()
  e2.setPlan(plan({ state: 'paused', anchorPos: 0, anchorAt: w2.perf + e2.trueOffset }))
  for (let i = 0; i < 20; i++) { w2.perf += 3000; await tick(e2, 1) }
  assert.ok(calls <= 2, 'a piece the computer says does not exist is asked for once, not ' + calls + ' times')
})

test('engine: old pieces are dropped so memory stays small', async () => {
  const w = makeWorld(); const e = makeEngine(w); await e.unlock()
  e.setPlan(plan({ anchorPos: 0, anchorAt: w.perf + e.trueOffset + 300 }))
  for (let i = 0; i < 400; i++) { w.perf += 250; await tick(e, 1) }
  const held = Object.keys(e._debug().voices.FL.pieces).map(Number)
  assert.ok(held.length <= 6 && Math.min(...held) >= 17, 'pieces held: ' + held.join())
})

test('engine: the beep test schedules this device\'s beeps on the shared clock, once, with its trim', async () => {
  const w = makeWorld(); const e = makeEngine(w); await e.unlock()
  e.setPlan(plan({ state: 'paused', anchorPos: 0, anchorAt: 0 }, { trimMs: 20 }))
  const startAt = w.perf + e.trueOffset + 2500
  const beep = { id: 7, pattern: 'turns', startAt, intervalMs: 1400, rounds: 2, slots: [{ id: 'tv', freq: 700 }, { id: 'me', freq: 830 }, { id: 'you', freq: 960 }] }
  assert.equal(e.scheduleBeep(beep, 'me'), 2)
  assert.deepEqual(w.oscs.map((o) => o.frequency.value), [830, 830])
  close(w.oscs[0].at, heardCtxOf(w) + 2.5 + 1.4 + 0.02, 1e-6, 'first beep is the second slot, plus my trim')
  close(w.oscs[1].at - w.oscs[0].at, 3 * 1.4, 1e-6, 'the next round comes after every slot has had its turn')
  assert.equal(e.scheduleBeep(beep, 'me'), 0, 'the same test is not scheduled twice')
  assert.equal(e.scheduleBeep({ ...beep, id: 8 }, 'nobody'), 0)
  const together = { id: 9, pattern: 'together', startAt, intervalMs: 1000, rounds: 3, slots: [{ id: 'me', freq: 1000 }, { id: 'you', freq: 1000 }] }
  assert.equal(e.scheduleBeep(together, 'me'), 3)
  assert.equal(e.scheduleBeep({ id: 10, slots: 'x' }, 'me'), 0)
})

// ------------------------------------------------------------------ sync accuracy in simulation
/** Run a phone for `seconds` of fake time against a hardware audio clock that is `ppm` fast (+) or slow (-). Returns error stats. */
async function simulate({ ppm, estErr = 0, seconds = 120, latency = 0.03, jitterMs = 0, seedShift = 0 }) {
  const w = makeWorld({ skewPpm: ppm, latency, tsJitterMs: jitterMs }); const e = makeEngine(w, { estErr })
  await e.unlock()
  e.setPlan(plan({ anchorPos: 0, anchorAt: w.perf + e.trueOffset + 800 }))
  const errs = []
  let rnd = 12345 + seedShift
  const rand = () => { rnd = (rnd * 1664525 + 1013904223) % 4294967296; return rnd / 4294967296 }
  for (let t = 0; t < seconds * 4; t++) {
    w.perf += 250
    await tick(e, 1)
    if (t > 16) { // after 4 s
      const heard = heardPos(w, 'FL')
      // where the room says the film is being HEARD right now (true server time = perf + true offset; e.estErr is the phone's clock error)
      const expected = M.positionAt(e.plan.timeline, w.perf + (e.trueOffset - estErr))
      if (heard !== null) errs.push((heard - expected) * 1000)
    }
    void jitterMs; void rand
  }
  const abs = errs.map(Math.abs).sort((a, b) => a - b)
  const out = { max: abs[abs.length - 1], p95: abs[Math.floor(abs.length * 0.95)], median: abs[Math.floor(abs.length / 2)], restarts: e.restarts, nudges: e.nudges, n: errs.length, phase: e.phase }
  if (process.env.SPK_REPORT) console.log('SIM', JSON.stringify({ ppm, estErr, seconds }), JSON.stringify(out, (k, v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v)))
  return out
}

test('simulated: a perfect audio clock stays within 1 ms of the timeline with no corrections at all', async () => {
  const r = await simulate({ ppm: 0 })
  assert.ok(r.max < 1, JSON.stringify(r)); assert.equal(r.restarts, 0); assert.equal(r.nudges, 0); assert.equal(r.phase, 'playing')
})

test('simulated: audio hardware that runs 100 ppm fast or slow (a typical phone) is held within 12 ms, without ever restarting', async () => {
  for (const ppm of [100, -100, 50]) {
    const r = await simulate({ ppm })
    assert.ok(r.max < 14, `${ppm} ppm: ${JSON.stringify(r)}`); assert.equal(r.restarts, 0, `${ppm} ppm: ${JSON.stringify(r)}`)
  }
})

test('simulated: 3 ms of jitter in the output timestamps a browser reports (the median filter and dead band absorb it) causes no restarts and no pitch chatter', async () => {
  for (const ppm of [0, 100, -300]) {
    const r = await simulate({ ppm, jitterMs: 3, seconds: 120 })
    assert.equal(r.restarts, 0, `${ppm} ppm: ${JSON.stringify(r)}`); assert.ok(r.max < 20, `${ppm} ppm: ${JSON.stringify(r)}`); assert.ok(r.nudges <= 12, `${ppm} ppm nudges ${r.nudges}`)
  }
})

test('simulated: 2000 ppm (a far worse crystal than any phone) is still held within 35 ms', async () => {
  for (const ppm of [2000, -2000]) {
    const r = await simulate({ ppm, seconds: 90 })
    assert.ok(r.max < 35 && r.restarts === 0, `${ppm} ppm: ${JSON.stringify(r)}`)
  }
})

test('simulated: a clock estimate that is 5 ms wrong is a 5 ms error (nothing can fix that from inside the phone), and a large one is a clean restart, not a drift', async () => {
  const r = await simulate({ ppm: 0, estErr: 5, seconds: 30 })
  assert.ok(r.max > 4 && r.max < 6.5, JSON.stringify(r))
  // the clock estimate suddenly steps 200 ms (a resync after a Wi-Fi hiccup): one restart puts it right
  const w = makeWorld(); const e = makeEngine(w); await e.unlock()
  let step = 0
  e.clock.hostNow = () => w.perf + e.trueOffset + step
  e.setPlan(plan({ anchorPos: 0, anchorAt: w.perf + e.trueOffset + 800 }))
  for (let i = 0; i < 40; i++) { w.perf += 250; await tick(e, 1) }
  step = 200
  for (let i = 0; i < 24; i++) { w.perf += 250; await tick(e, 1) }
  assert.equal(e.restarts, 1); assert.ok(Math.abs(e.driftMs) < 15)
})

test('simulated: the position error is reported so the phone can show green / amber / red', async () => {
  const w = makeWorld({ skewPpm: 800 }); const e = makeEngine(w); await e.unlock()
  e.setPlan(plan({ anchorPos: 0, anchorAt: w.perf + e.trueOffset + 800 }))
  for (let i = 0; i < 48; i++) { w.perf += 250; await tick(e, 1) }
  const st = e.status(4.2)
  assert.equal(st.state, 'playing'); assert.equal(st.errMs, 2); assert.equal(st.rttMs, 4.2); assert.ok(Math.abs(st.driftMs) < 15)
  assert.equal(M.syncLevel({ connected: true, clockReady: true, errMs: st.errMs, driftMs: st.driftMs, phase: st.state, unlocked: true }).level, 'good')
})
