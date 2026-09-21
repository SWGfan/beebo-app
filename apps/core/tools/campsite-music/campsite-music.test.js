// Tests for the guest-side synced-music script. Plain node, no dependencies:
//   node --test apps/core/tools/campsite-music/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const M = require('../../app/src/main/assets/campsite-music.js');

const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'src', 'test', 'resources', 'campsite-clock-vectors.json'), 'utf8'));
const asSamples = (rows) => rows.map(([t0, t1, t2, t3]) => ({ t0, t1, t2, t3 }));
const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} ${a} vs ${b}`);

// ---- ClockSync ------------------------------------------------------------------------------

test('clock vectors: estimate matches stored expectation and stays within the RTT/2 bound of the truth', () => {
  for (const v of vectors.vectors) {
    const est = M.ClockSync.estimate(asSamples(v.samples));
    if (v.expect === null) { assert.equal(est, null, v.name); continue; }
    assert.ok(est, v.name);
    close(est.offsetMs, v.expect.offsetMs, 1e-6, v.name + ' offset');
    close(est.rttMs, v.expect.rttMs, 1e-6, v.name + ' rtt');
    close(est.errorMs, v.expect.errorMs, 1e-6, v.name + ' error');
    assert.equal(est.used, v.expect.used, v.name);
    assert.equal(est.total, v.expect.total, v.name);
    assert.ok(Math.abs(est.offsetMs - v.trueOffset) <= est.rttMs / 2 + 0.5, `${v.name}: off by ${est.offsetMs - v.trueOffset}`);
  }
});

test('clock filter vectors', () => {
  const f = new M.ClockSync.ClockFilter();
  for (const step of vectors.filter) {
    f.update(step.in);
    close(f.offsetMs, step.offsetMs, 1e-9, 'filter offset');
    close(f.errorMs, step.errorMs, 1e-9, 'filter error');
  }
  assert.ok(f.offsetMs > 599, 'a 500 ms step is believed at once');
});

test('estimate needs enough samples', () => {
  assert.equal(M.ClockSync.estimate([]), null);
  assert.equal(M.ClockSync.estimate(asSamples([[0, 5, 5.1, 3], [10, 15, 15.1, 13], [20, 25, 25.1, 23], [30, 35, 35.1, 33]])), null);
});

test('spikes on one leg are rejected (many pings, lowest RTT wins)', () => {
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push([i * 100, i * 100 + 1 + 1000, i * 100 + 1.05 + 1000, i * 100 + 2.05]); // clean: offset 1000
  for (let i = 20; i < 30; i++) rows.push([i * 100, i * 100 + 51 + 1000, i * 100 + 51.05 + 1000, i * 100 + 52.05]); // uplink spike
  const est = M.ClockSync.estimate(asSamples(rows));
  close(est.offsetMs, 1000, 0.6, 'offset');
});

// ---- timeline & snapshots ---------------------------------------------------------------------

test('advance rolls over tracks like the host engine', () => {
  const q = [{ ms: 1000 }, { ms: 2000 }, { ms: 3000 }];
  assert.deepEqual(M.advance(q, 0, 100, 50), { idx: 0, epoch: 100, finished: false });
  assert.deepEqual(M.advance(q, 0, 100, 1100), { idx: 1, epoch: 1100, finished: false });
  assert.deepEqual(M.advance(q, 0, 100, 3100), { idx: 2, epoch: 3100, finished: false });
  assert.equal(M.advance(q, 0, 100, 6100).finished, true);
});

test('cleanSnapshot rejects malformed or hostile data', () => {
  const ok = { t: 'state', state: 'playing', index: 0, seq: 1, rev: 1, epochStart: 5, pausedPos: 0, role: 'left', queue: [{ id: 'abc123', title: '<img onerror=x>', artist: 'A', album: 'B', ms: 5000 }] };
  const s = M.cleanSnapshot(ok);
  assert.equal(s.role, 'left');
  assert.equal(s.queue[0].title, '<img onerror=x>'); // kept as text; the page only ever uses textContent
  assert.equal(M.cleanSnapshot({ ...ok, state: 'exploding' }), null);
  assert.equal(M.cleanSnapshot({ ...ok, queue: [{ id: '../etc/passwd', ms: 5000 }] }), null);
  assert.equal(M.cleanSnapshot({ ...ok, queue: [{ id: 'ok', ms: 5 }] }), null);
  assert.equal(M.cleanSnapshot({ ...ok, index: 3 }), null);
  assert.equal(M.cleanSnapshot({ ...ok, role: 'root' }).role, 'everyone');
});

test('syncLevel colours', () => {
  assert.equal(M.syncLevel({ connected: true, clockReady: true, errMs: 3, driftMs: 4, phase: 'playing' }).level, 'good');
  assert.equal(M.syncLevel({ connected: true, clockReady: true, errMs: 3, driftMs: 40, phase: 'playing' }).level, 'warn');
  assert.equal(M.syncLevel({ connected: true, clockReady: true, errMs: 3, driftMs: 200, phase: 'playing' }).level, 'bad');
  assert.equal(M.syncLevel({ connected: false }).level, 'bad');
  assert.equal(M.syncLevel({ connected: true, clockReady: true, errMs: 2, phase: 'locked' }).text, 'Tap to enable audio');
});

// ---- fake Web Audio world -----------------------------------------------------------------------

const LATENCY = 0.03;

function makeWorld(opts) {
  opts = opts || {};
  const w = { perf: 50000, ctxSkew: opts.skew || 0, ctxBase: 1.0, sources: [], gains: [], state: 'running' };
  w.ctxNow = () => w.ctxBase + ((w.perf - 50000) / 1000) * (1 + w.ctxSkew);
  const param = (v) => ({ value: v, events: [], setTargetAtTime(x, t, tc) { this.value = x; this.events.push(['target', x]); }, setValueAtTime(x, t) { this.value = x; this.events.push(['set', x, t]); } });
  w.ctx = {
    get currentTime() { return w.ctxNow(); },
    get state() { return w.state; },
    sampleRate: 48000, destination: {},
    getOutputTimestamp() { return { contextTime: w.ctxNow() - LATENCY, performanceTime: w.perf }; },
    createGain() { const g = { gain: param(1), connect() {}, disconnect() {} }; w.gains.push(g); return g; },
    createChannelSplitter() { return { connect() {} }; },
    createChannelMerger() { return { connect() {} }; },
    createBuffer() { return {}; },
    resume() { w.state = 'running'; return Promise.resolve(); },
    createBufferSource() {
      const s = { buffer: null, playbackRate: param(1), connect() {}, disconnect() {}, started: null, stopped: null,
        start(when, offset) { this.started = { when, offset }; }, stop(when) { this.stopped = when === undefined ? -1 : when; } };
      w.sources.push(s);
      return s;
    }
  };
  return w;
}
const tick = async (p, n) => { for (let i = 0; i < (n || 8); i++) { p.tick(); for (let k = 0; k < 4; k++) await Promise.resolve(); } };
// The unlock blip is a source too; real tracks are the ones with a decoded buffer.
const real = (w) => w.sources.filter((s) => s.buffer && s.buffer.duration);
const track = (id, ms) => ({ id, title: id, artist: 'A', album: 'B', ms });
const snap = (o) => Object.assign({ t: 'state', v: 1, seq: 1, rev: 1, state: 'playing', index: 0, epochStart: 0, pausedPos: 0, role: 'everyone', queue: [track('t1', 60000)] }, o);

function makePlayer(world, hostOffset) {
  const clock = { ready: () => true, offsetMs: () => hostOffset, hostNow: () => world.perf + hostOffset, errorMs: () => 2 };
  const fetched = [];
  const p = M.createPlayer({
    ctx: world.ctx, perfNow: () => world.perf, clock,
    fetchTrack: (id) => { fetched.push(id); return Promise.resolve(new ArrayBuffer(8)); },
    decode: () => Promise.resolve({ duration: 60, numberOfChannels: 2 }),
  });
  p.fetched = fetched;
  return p;
}
const heardCtx = (w) => w.ctxNow() - LATENCY;

test('player: a future epoch is scheduled at the AudioContext time that is HEARD at that host time', async () => {
  const w = makeWorld(), off = 1234.5, p = makePlayer(w, off);
  p.unlock();
  const epoch = w.perf + off + 1500; // host time, 1.5 s away
  p.setSnapshot(snap({ epochStart: epoch }));
  await tick(p);
  assert.equal(real(w).length, 1);
  const s = real(w)[0];
  close(s.started.when, heardCtx(w) + 1.5, 1e-6, 'start when');
  assert.equal(s.started.offset, 0);
  assert.ok(s.stopped > s.started.when + 59, 'stop is scheduled at the host-declared end');
});

test('player: a late joiner starts mid-track at the right offset (position = host time - epoch)', async () => {
  const w = makeWorld(), off = -300, p = makePlayer(w, off);
  p.unlock();
  p.setSnapshot(snap({ epochStart: w.perf + off - 10000 }));
  await tick(p);
  const s = real(w)[0];
  const lead = s.started.when - heardCtx(w);
  assert.ok(lead > 0.1 && lead < 0.2, 'lead ' + lead);
  close(s.started.offset, 10 + lead, 1e-6, 'buffer offset');
});

test('player: trim delays this phone only', async () => {
  const w = makeWorld(), p = makePlayer(w, 0);
  p.unlock(); p.setTrim(50);
  p.setSnapshot(snap({ epochStart: w.perf + 1000 }));
  await tick(p);
  close(real(w)[0].started.when, heardCtx(w) + 1.05, 1e-6, 'trimmed start');
});

test('player: pause stops sound, and a seek (new epoch) restarts at the new place', async () => {
  const w = makeWorld(), p = makePlayer(w, 0);
  p.unlock();
  p.setSnapshot(snap({ epochStart: w.perf - 5000 }));
  await tick(p);
  assert.equal(real(w).length, 1);
  p.setSnapshot(snap({ seq: 2, rev: 2, state: 'paused', pausedPos: 5000 }));
  assert.notEqual(real(w)[0].stopped, null, 'paused stops');
  p.setSnapshot(snap({ seq: 3, rev: 3, epochStart: w.perf - 30000 }));
  await tick(p);
  assert.equal(real(w).length, 2);
  close(real(w)[1].started.offset, 30.12, 0.01, 'seeked offset');
});

test('player: nothing plays until the tab is unlocked, but the audio is downloaded and decoded meanwhile', async () => {
  const w = makeWorld(); w.state = 'suspended';
  const p = makePlayer(w, 0);
  p.setSnapshot(snap({ epochStart: w.perf + 500 }));
  await tick(p);
  assert.equal(real(w).length, 0);
  assert.equal(p.phase, 'locked');
  assert.equal(p.readyTrackId(), 't1', 'ready to go the moment the guest taps');
  await p.unlock();
  await tick(p);
  assert.equal(real(w).length, 1);
});

test('player: role routing sets the channel matrix', async () => {
  const w = makeWorld(), p = makePlayer(w, 0);
  p.unlock();
  p.setSnapshot(snap({ epochStart: w.perf + 500, role: 'left' }));
  const d = p._debug().mixer.g;
  assert.deepEqual([d.LL.gain.value, d.LR.gain.value, d.RL.gain.value, d.RR.gain.value], [1, 1, 0, 0]);
  p.setSnapshot(snap({ seq: 2, rev: 2, epochStart: w.perf + 500, role: 'right' }));
  assert.deepEqual([d.LL.gain.value, d.LR.gain.value, d.RL.gain.value, d.RR.gain.value], [0, 0, 1, 1]);
  p.setSnapshot(snap({ seq: 3, rev: 3, epochStart: w.perf + 500, role: 'voice' }));
  assert.deepEqual([d.LL.gain.value, d.LR.gain.value, d.RL.gain.value, d.RR.gain.value], [1, 0, 0, 1]);
});

test('player: the next track is scheduled gapless at the boundary and promoted without a restart', async () => {
  const w = makeWorld(), p = makePlayer(w, 0);
  p.unlock();
  const q = [track('a', 30000), track('b', 30000)];
  p.setSnapshot(snap({ queue: q, epochStart: w.perf - 26000 }));
  for (let i = 0; i < 6; i++) { w.perf += 250; await tick(p); }
  assert.equal(real(w).length, 2, 'current + pre-scheduled next');
  const boundaryCtx = heardCtx(w) + (30000 - 26000 - 1500) / 1000;
  close(real(w)[1].started.when, boundaryCtx, 0.002, 'next starts on the boundary');
  assert.equal(real(w)[1].started.offset, 0);
  for (let i = 0; i < 20; i++) { w.perf += 250; await tick(p); }
  assert.equal(real(w).length, 2, 'no restart after the rollover');
  assert.equal(p.currentIndex(), 1);
});

function truePos(s, w) { // where the source REALLY is (ms), integrating its recorded playbackRate changes
  let pos = s.started.offset * 1000, c = s.started.when, rate = 1;
  for (const e of s.playbackRate.events) if (e[0] === 'set') { const t = Math.max(e[2], c); pos += (t - c) * 1000 * rate; c = t; rate = e[1]; }
  return pos + (heardCtx(w) - c) * 1000 * rate;
}

for (const skew of [0.0005, 0.002, -0.002]) {
  test('player: closed-loop drift correction keeps an audio clock ' + (skew * 1e6) + ' ppm off within a few ms', async () => {
    const w = makeWorld({ skew }), p = makePlayer(w, 0);
    p.unlock();
    p.setSnapshot(snap({ queue: [track('long', 600000)], epochStart: w.perf + 500 }));
    let worst = 0;
    for (let i = 0; i < 960; i++) { // four minutes in 250 ms steps
      w.perf += 250; await tick(p, 1);
      const list = real(w), s = list[list.length - 1];
      if (i > 120) { // after the first 30 s have settled
        assert.ok(s.playbackRate.value >= 0.994 && s.playbackRate.value <= 1.006, 'nudge stays inaudible: ' + s.playbackRate.value);
        worst = Math.max(worst, Math.abs(truePos(s, w) - (w.perf - 50500)));
      }
    }
    if (process.env.VERBOSE) console.log(`  skew ${skew * 1e6} ppm: worst true error after settling = ${worst.toFixed(1)} ms`);
    assert.equal(real(w).length, 1, 'never needed a hard restart');
    assert.ok(worst < 15, 'true error ' + worst + ' ms');
    assert.ok(real(w)[0].playbackRate.events.length > 0, 'the nudge really did engage');
  });
}

test('player: a huge drift (frozen tab) restarts instead of nudging', async () => {
  const w = makeWorld(), p = makePlayer(w, 0);
  p.unlock();
  p.setSnapshot(snap({ epochStart: w.perf - 1000 }));
  await tick(p);
  for (let i = 0; i < 6; i++) { w.perf += 250; await tick(p, 1); }
  // the host jumps the timeline 2 s without a new snapshot arriving (a clock re-sync step)
  p._debug().active.anchorPosMs += 2000;
  for (let i = 0; i < 6; i++) { w.perf += 250; await tick(p, 1); }
  assert.ok(real(w).length >= 2, 'restarted');
});

// ---- Link: WebSocket + clock sync ---------------------------------------------------------------

test('link: bursts of pings converge on the true offset and re-sync every 30 s', async () => {
  const timers = []; let now = 1000, nextTimer = 1;
  const sched = {
    setTimeout(fn, ms) { const id = nextTimer++; timers.push({ id, at: now + ms, fn }); return id; },
    clearTimeout(id) { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    run(ms) {
      const end = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        if (!timers.length || timers[0].at > end) break;
        const t = timers.shift(); now = t.at; t.fn();
      }
      now = end;
    }
  };
  const HOST_OFFSET = 987654.321;
  let sockets = 0, pingsSeen = 0;
  class FakeWS {
    constructor(url) { this.url = url; this.readyState = 0; sockets++; sched.setTimeout(() => { this.readyState = 1; this.onopen(); }, 5); }
    send(text) {
      const m = JSON.parse(text);
      if (m.t !== 'ping') return;
      pingsSeen++;
      const up = 1.0 + (pingsSeen % 5) * 0.3, down = 1.0 + ((pingsSeen * 7) % 5) * 0.3; // jittery, mildly asymmetric
      sched.setTimeout(() => {
        const r = now + HOST_OFFSET, s = r + 0.05;
        sched.setTimeout(() => this.onmessage({ data: JSON.stringify({ t: 'pong', id: m.id, c: m.c, r, s }) }), down);
      }, up);
    }
    close() { this.readyState = 3; if (this.onclose) this.onclose(); }
  }
  const link = M.createLink({ WebSocket: FakeWS, url: 'ws://x/api/music/ws', perfNow: () => now, setTimeout: sched.setTimeout, clearTimeout: sched.clearTimeout });
  const states = []; link.onState = (s) => states.push(s);
  let clockCalls = 0; link.onClock = () => clockCalls++;
  link.connect();
  sched.run(3000);
  assert.ok(link.clock.ready(), 'clock ready after the first burst');
  close(link.clock.offsetMs(), HOST_OFFSET, 1.5, 'offset');
  assert.ok(link.clock.errorMs() < 3, 'error ' + link.clock.errorMs());
  assert.ok(pingsSeen >= 24, 'first burst is ~24 pings');
  const before = clockCalls;
  sched.run(31000);
  assert.ok(clockCalls > before, 're-synced within 30 s');
  assert.equal(states[0], 'open');
  // a dropped socket reconnects by itself
  link.close(); // (closedByUs) - no reconnect
  const socketsBefore = sockets; sched.run(20000);
  assert.equal(sockets, socketsBefore);
});
