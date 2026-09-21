/*
 * Beebo Campsite - synced group music, guest side. Dependency-free; runs in any current mobile
 * browser tab served by the host phone. Inlined into /music by CampsiteMusicPage.kt.
 *
 * Pieces (all exported for tests/campsite-music.test.js, which runs in plain node):
 *   ClockSync   NTP-style offset estimate. MIRRORS CampsiteClockSync.kt; both are checked against
 *               src/test/resources/campsite-clock-vectors.json.
 *   advance()   which track is playing at a host time (track boundaries are computed, not signalled).
 *   createPlayer()  Web Audio scheduling, late-join catch-up, drift correction by playbackRate nudges,
 *               left/right role routing.
 *   createLink()    WebSocket to /api/music/ws with reconnect and the clock-sync bursts.
 *   mount()         the page's DOM.
 *
 * Clocks. The host stamps everything in its own monotonic clock ("host ms"). This tab measures
 * offset = host - performance.now() with ClockSync. The host publishes epochStart: the host-ms at
 * which the current track's position 0 is heard. Position at host time h is h - epochStart.
 * Web Audio is then told to start a source at the AudioContext time whose *heard* moment equals
 * that host time (getOutputTimestamp() maps context time to performance.now() including output
 * latency where the browser reports it).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BeeboMusic = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PROTOCOL = 1;

  // ------------------------------------------------------------------------------------------
  // ClockSync (mirror of CampsiteClockSync.kt - keep in step)
  // ------------------------------------------------------------------------------------------
  var CS = {
    MIN_SAMPLES: 5, MAX_RTT_MS: 2000, KEEP_FRACTION: 0.5, MIN_KEEP: 3,
    OUTLIER_SIGMAS: 3.0, OUTLIER_FLOOR_MS: 3.0, RTT_TOLERANCE_MS: 0.5, MAD_TO_SIGMA: 1.4826,
    FILTER_ALPHA: 0.35, FILTER_STEP_MS: 40.0
  };

  function median(values) {
    var s = values.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(s.length / 2);
    return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }
  function sampleRtt(s) { return (s.t3 - s.t0) - (s.t2 - s.t1); }
  function sampleOffset(s) { return ((s.t1 - s.t0) + (s.t2 - s.t3)) / 2; }
  function finite(s) { return isFinite(s.t0) && isFinite(s.t1) && isFinite(s.t2) && isFinite(s.t3); }

  /** samples: [{t0,t1,t2,t3}] -> {offsetMs, rttMs, errorMs, used, total} or null. */
  function estimate(samples) {
    var valid = samples.filter(function (s) { var r = sampleRtt(s); return finite(s) && r >= -CS.RTT_TOLERANCE_MS && r <= CS.MAX_RTT_MS; });
    if (valid.length < CS.MIN_SAMPLES) return null;
    var byRtt = valid.slice().sort(function (a, b) { return sampleRtt(a) - sampleRtt(b); });
    var keep = byRtt.slice(0, Math.max(CS.MIN_KEEP, Math.ceil(byRtt.length * CS.KEEP_FRACTION)));
    var firstMedian = median(keep.map(sampleOffset));
    var sigma0 = CS.MAD_TO_SIGMA * median(keep.map(function (s) { return Math.abs(sampleOffset(s) - firstMedian); }));
    var limit = Math.max(CS.OUTLIER_SIGMAS * sigma0, CS.OUTLIER_FLOOR_MS);
    var good = keep.filter(function (s) { return Math.abs(sampleOffset(s) - firstMedian) <= limit; });
    if (!good.length) good = keep;
    var offset = median(good.map(sampleOffset));
    var sigma = CS.MAD_TO_SIGMA * median(good.map(function (s) { return Math.abs(sampleOffset(s) - offset); }));
    var rttMin = Math.max(0, sampleRtt(byRtt[0]));
    var error = Math.max(sigma, rttMin / 4, 0.5);
    return {
      offsetMs: offset,
      rttMs: median(good.map(function (s) { return Math.max(0, sampleRtt(s)); })),
      errorMs: error, used: good.length, total: samples.length
    };
  }

  function ClockFilter() {
    this.offsetMs = 0; this.errorMs = Infinity; this.rttMs = 0; this.updates = 0;
  }
  ClockFilter.prototype.update = function (e) {
    if (this.updates === 0 || Math.abs(e.offsetMs - this.offsetMs) > CS.FILTER_STEP_MS) {
      this.offsetMs = e.offsetMs; this.errorMs = e.errorMs;
    } else {
      this.offsetMs += CS.FILTER_ALPHA * (e.offsetMs - this.offsetMs);
      this.errorMs = Math.sqrt((1 - CS.FILTER_ALPHA) * this.errorMs * this.errorMs + CS.FILTER_ALPHA * e.errorMs * e.errorMs);
    }
    this.rttMs = e.rttMs; this.updates++;
    return this.offsetMs;
  };
  ClockFilter.prototype.isReady = function () { return this.updates > 0; };

  var ClockSync = { estimate: estimate, ClockFilter: ClockFilter, median: median, sampleRtt: sampleRtt, sampleOffset: sampleOffset, constants: CS };

  // ------------------------------------------------------------------------------------------
  // Track timeline
  // ------------------------------------------------------------------------------------------

  /**
   * Which track is sounding at (effective) host time `now`, rolling over finished tracks exactly as
   * the host's engine does: track i+1 starts at epochStart(i) + duration(i).
   * Returns {idx, epoch, finished}.
   */
  function advance(queue, index, epoch, now) {
    var idx = index, e = epoch;
    while (idx + 1 < queue.length && now >= e + queue[idx].ms) { e += queue[idx].ms; idx++; }
    return { idx: idx, epoch: e, finished: idx >= queue.length - 1 && now >= e + queue[idx].ms };
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  var ROLES = { everyone: 1, left: 1, right: 1, voice: 1 };
  var STATES = { idle: 1, preparing: 1, playing: 1, paused: 1, ended: 1 };

  /** Validate a host snapshot; the host is trusted but its data ends up in the DOM, so be strict. */
  function cleanSnapshot(m) {
    if (!m || typeof m !== 'object' || m.t !== 'state' || !STATES[m.state]) return null;
    if (!Array.isArray(m.queue) || m.queue.length > 100) return null;
    var queue = [];
    for (var i = 0; i < m.queue.length; i++) {
      var q = m.queue[i];
      if (!q || typeof q.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(q.id) || !(q.ms >= 1000)) return null;
      queue.push({ id: q.id, title: String(q.title || '').slice(0, 80), artist: String(q.artist || '').slice(0, 60), album: String(q.album || '').slice(0, 60), ms: +q.ms });
    }
    var index = m.index | 0;
    if (queue.length && (index < 0 || index >= queue.length)) return null;
    return {
      seq: m.seq | 0, rev: m.rev | 0, state: m.state, index: index, queue: queue,
      epochStart: isFinite(m.epochStart) ? +m.epochStart : 0,
      pausedPos: isFinite(m.pausedPos) ? +m.pausedPos : 0,
      role: ROLES[m.role] ? m.role : 'everyone'
    };
  }

  // ------------------------------------------------------------------------------------------
  // Player: Web Audio scheduling
  // ------------------------------------------------------------------------------------------
  var LEAD_MS = 120;            // how far ahead of "now" a catch-up start is scheduled
  var HARD_RESYNC_MS = 250;     // beyond this a restart beats a nudge
  var ENGAGE_MS = 12;           // start nudging above this median drift
  var RELEASE_MS = 5;           // stop nudging below this
  var CORRECT_WINDOW_MS = 2500; // aim to remove the drift over this long
  var MAX_NUDGE = 0.005;        // +-0.5% playbackRate: about 9 cents, below what people notice
  var DRIFT_HISTORY = 5;
  var DECODE_AHEAD_MS = 30000;  // decode the next track only this close to its start (RAM)
  var PRESCHEDULE_MS = 6000;    // schedule the next track's start this long before it begins
  var MAX_FETCH_TRIES = 12;

  function decodeAudio(ctx, bytes) {
    return new Promise(function (resolve, reject) {
      var p = ctx.decodeAudioData(bytes, resolve, reject);
      if (p && typeof p.then === 'function') p.then(resolve, reject);
    });
  }

  /**
   * env: { ctx, perfNow(), clock:{ready(), hostNow(), errorMs()}, fetchTrack(id)->Promise<ArrayBuffer>,
   *        decode?(bytes)->Promise<AudioBuffer> }
   */
  function createPlayer(env) {
    var ctx = env.ctx;
    var perfNow = env.perfNow;
    var clock = env.clock;
    var decode = env.decode || function (b) { return decodeAudio(ctx, b); };
    var P = {
      snap: null, trimMs: 0, volume: 1, role: 'everyone', unlocked: false,
      note: '', driftMs: 0, phase: 'idle', onChange: null
    };
    var buffers = {};       // trackId -> {state, bytes, buffer, tries, nextTry, error}
    var active = null;      // entry now sounding (or about to)
    var pending = null;     // next track, already scheduled
    var mixer = null;

    function changed() { if (P.onChange) P.onChange(); }

    // ---- audio graph: source -> entry gain -> role mixer -> master -> speakers ----
    function buildMixer() {
      var m = {};
      m.input = ctx.createGain();
      m.master = ctx.createGain();
      m.master.gain.value = P.volume;
      m.splitter = ctx.createChannelSplitter(2);
      m.merger = ctx.createChannelMerger(2);
      m.input.connect(m.splitter);
      m.g = {};
      [['LL', 0, 0], ['LR', 0, 1], ['RL', 1, 0], ['RR', 1, 1]].forEach(function (c) {
        var g = ctx.createGain();
        g.gain.value = 0;
        m.splitter.connect(g, c[1]);
        g.connect(m.merger, 0, c[2]);
        m.g[c[0]] = g;
      });
      m.merger.connect(m.master);
      m.master.connect(ctx.destination);
      return m;
    }
    function applyRole() {
      if (!mixer) return;
      var role = P.role;
      // left/right: this phone plays ONE side of the stereo mix on both of its speakers, so two
      // phones (one each side of the camp) make a stereo pair. voice = everyone until Campfire
      // voice-casting ships.
      var w = role === 'left' ? { LL: 1, LR: 1, RL: 0, RR: 0 }
        : role === 'right' ? { LL: 0, LR: 0, RL: 1, RR: 1 }
        : { LL: 1, LR: 0, RL: 0, RR: 1 };
      var t = ctx.currentTime;
      Object.keys(w).forEach(function (k) {
        var p = mixer.g[k].gain;
        if (p.setTargetAtTime) p.setTargetAtTime(w[k], t, 0.03); else p.value = w[k];
      });
    }
    function ensureMixer() { if (!mixer) { mixer = buildMixer(); applyRole(); } }

    // ---- time mapping ----
    /** AudioContext time at which the sample scheduled there is HEARD at performance time `perfMs`. */
    function ctxForPerf(perfMs) {
      var ts = ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null;
      if (ts && ts.performanceTime > 0 && ts.contextTime > 0 && isFinite(ts.contextTime)) {
        return ts.contextTime + (perfMs - ts.performanceTime) / 1000;
      }
      var lat = (ctx.outputLatency || 0);
      return ctx.currentTime - lat + (perfMs - perfNow()) / 1000;
    }
    function ctxForHost(hostMs) { return ctxForPerf(hostMs - clock.offsetMs()); }
    /** Host time currently being heard from this phone's speakers. */
    function hostHeardNow() { return clock.hostNow(); }

    // ---- buffers ----
    function slot(id) { return buffers[id] || (buffers[id] = { state: 'idle', bytes: null, buffer: null, tries: 0, nextTry: 0, error: '' }); }

    function fetchSlot(id) {
      var s = slot(id);
      if (s.state !== 'idle' || perfNow() < s.nextTry) return;
      s.state = 'fetching';
      Promise.resolve().then(function () { return env.fetchTrack(id); }).then(function (bytes) {
        s.bytes = bytes; s.state = 'fetched'; s.tries = 0; changed();
      }, function () {
        s.tries++; s.state = 'idle';
        s.nextTry = perfNow() + Math.min(8000, 700 * Math.pow(2, Math.min(s.tries, 4)));
        if (s.tries >= MAX_FETCH_TRIES) { s.state = 'error'; s.error = 'Could not download this track from the host.'; }
        changed();
      });
    }
    function decodeSlot(id) {
      var s = slot(id);
      if (s.state !== 'fetched') return;
      s.state = 'decoding';
      var bytes = s.bytes; s.bytes = null;
      Promise.resolve().then(function () { return decode(bytes); }).then(function (buf) {
        s.buffer = buf; s.state = 'ready'; changed();
      }, function () {
        s.state = 'error'; s.error = 'This phone could not play that track.'; changed();
      });
    }
    /** Fetch (and, if wanted, decode) a track; returns true when its buffer is ready to play. */
    function want(id, decodeToo) {
      var s = slot(id);
      if (s.state === 'idle') fetchSlot(id);
      if (decodeToo && s.state === 'fetched') decodeSlot(id);
      return s.state === 'ready';
    }
    function evict(keepIds) {
      Object.keys(buffers).forEach(function (id) { if (keepIds.indexOf(id) < 0) delete buffers[id]; });
    }

    // ---- sources ----
    function makeEntry(idx, epoch, track, startCtx, posMs, endCtx) {
      var s = buffers[track.id];
      var src = ctx.createBufferSource();
      src.buffer = s.buffer;
      var gain = ctx.createGain();
      src.connect(gain);
      gain.connect(mixer.input);
      src.start(startCtx, posMs / 1000);
      if (endCtx > startCtx) src.stop(endCtx);
      var e = { idx: idx, epoch: epoch, trackId: track.id, source: src, gain: gain, startCtx: startCtx,
        anchorCtx: startCtx, anchorPosMs: posMs, rate: 1, hist: [], endCtx: endCtx, lastRateAt: 0 };
      src.onended = function () { try { gain.disconnect(); } catch (x) { /* already gone */ } };
      return e;
    }
    function stopEntry(e, fade) {
      if (!e) return;
      var t = ctx.currentTime;
      try {
        if (fade) { e.gain.gain.setTargetAtTime(0, t, 0.008); e.source.stop(t + 0.05); }
        else e.source.stop();
      } catch (x) { /* never started, or already stopped */ }
    }
    function stopAll(fade) {
      stopEntry(active, fade); stopEntry(pending, fade); active = null; pending = null;
    }
    function posAt(e, ctxT) { return e.anchorPosMs + (ctxT - e.anchorCtx) * 1000 * e.rate; }
    function setRate(e, rate, ctxNow) {
      e.anchorPosMs = posAt(e, ctxNow); e.anchorCtx = ctxNow; e.rate = rate;
      e.source.playbackRate.setValueAtTime(rate, Math.max(ctxNow, ctx.currentTime));
      e.hist = [];
    }

    function startTrack(adv, effHeard) {
      var q = P.snap.queue, track = q[adv.idx];
      ensureMixer();
      var startH = Math.max(adv.epoch + P.trimMs, effHeard + LEAD_MS);
      var posMs = startH - adv.epoch - P.trimMs;
      var buf = buffers[track.id].buffer;
      if (posMs >= track.ms - 150 || posMs / 1000 >= buf.duration) return null;
      var when = ctxForHost(startH);
      var floor = ctx.currentTime + 0.005;
      if (when < floor) { posMs += (floor - when) * 1000; when = floor; }
      var endCtx = ctxForHost(adv.epoch + P.trimMs + track.ms);
      return makeEntry(adv.idx, adv.epoch, track, when, posMs, endCtx);
    }

    function schedulePending(adv, nextIdx) {
      var q = P.snap.queue, track = q[nextIdx];
      var startHost = adv.epoch + q[adv.idx].ms + P.trimMs;
      var when = ctxForHost(startHost);
      if (when < ctx.currentTime + 0.005) return; // too late to be gapless; the normal path will catch it up
      var endCtx = ctxForHost(startHost + track.ms);
      ensureMixer();
      pending = makeEntry(nextIdx, adv.epoch + q[adv.idx].ms, track, when, 0, endCtx);
    }

    function matches(e, adv) { return e && e.idx === adv.idx && Math.abs(e.epoch - adv.epoch) < 1.5 && P.snap.queue[adv.idx] && P.snap.queue[adv.idx].id === e.trackId; }

    // ---- the loop ----
    function tick() {
      var prevPhase = P.phase, prevNote = P.note;
      P.unlocked = !!ctx && ctx.state === 'running';
      P.note = '';
      var snap = P.snap;
      if (!snap || !snap.queue.length || snap.state === 'idle') {
        stopAll(true); P.phase = 'idle'; evict([]); P.driftMs = 0;
      } else {
        var cur = snap.queue[snap.index];
        // Keep the current track (and, near its end, the next) in memory; nothing else.
        var wantDecoded = true;
        var ready = want(cur.id, wantDecoded);
        var keep = [cur.id];
        if (snap.state === 'paused' || snap.state === 'preparing' || snap.state === 'ended') {
          stopAll(true);
          P.phase = ready ? 'ready' : (slot(cur.id).state === 'error' ? 'error' : 'loading');
        } else if (!clock.ready()) {
          P.phase = 'syncing';
        } else {
          playing(snap, keep);
        }
        var s = slot(keep[0]);
        if (s.state === 'error') P.note = s.error;
        else if (s.tries >= 4 && s.state !== 'ready') P.note = 'Still trying to download this track from your host...';
        evict(keep.concat(pending ? [pending.trackId] : []).concat(active ? [active.trackId] : []));
      }
      if (P.phase !== 'playing') P.driftMs = 0;
      if (P.phase !== prevPhase || P.note !== prevNote) changed();
    }

    function playing(snap, keep) {
      var q = snap.queue;
      var effHeard = hostHeardNow() - P.trimMs;
      var adv = advance(q, snap.index, snap.epochStart, effHeard);
      if (adv.finished) { stopAll(true); P.phase = 'ended'; return; }
      var track = q[adv.idx];
      keep[0] = track.id;
      var ready = want(track.id, true);
      var remaining = adv.epoch + track.ms - effHeard;
      var nextIdx = adv.idx + 1 < q.length ? adv.idx + 1 : -1;
      if (nextIdx >= 0) {
        keep.push(q[nextIdx].id);
        // Bytes as soon as the current track is in, decoded only when its turn is near.
        if (ready) want(q[nextIdx].id, remaining <= DECODE_AHEAD_MS);
      }
      // Roll a pre-scheduled next track into "active" once the timeline has moved onto it.
      if (pending && matches(pending, adv)) { active = pending; pending = null; }
      if (active && !matches(active, adv)) { stopEntry(active, true); active = null; }
      if (!ready) { P.phase = slot(track.id).state === 'error' ? 'error' : 'loading'; stopAll(true); return; }
      if (!P.unlocked) { P.phase = 'locked'; return; }
      if (!active) {
        active = startTrack(adv, effHeard);
        if (!active) { P.phase = 'playing'; return; }
      }
      P.phase = 'playing';
      maintain(adv, effHeard, remaining, nextIdx);
    }

    function maintain(adv, effHeard, remaining, nextIdx) {
      var e = active, q = P.snap.queue;
      var cNow = ctxForPerf(perfNow());
      if (cNow >= e.startCtx + 0.4) {
        var drift = posAt(e, cNow) - (effHeard - adv.epoch);
        e.hist.push(drift);
        if (e.hist.length > DRIFT_HISTORY) e.hist.shift();
        if (e.hist.length >= 3) {
          var med = median(e.hist);
          P.driftMs = med;
          if (Math.abs(med) > HARD_RESYNC_MS) {
            stopEntry(e, true); active = null; pending && stopEntry(pending, true); pending = null;
            active = startTrack(adv, effHeard);
            return;
          } else if (Math.abs(med) > ENGAGE_MS) {
            setRate(e, 1 - clamp(med / CORRECT_WINDOW_MS, -MAX_NUDGE, MAX_NUDGE), cNow);
          } else if (Math.abs(med) < RELEASE_MS && e.rate !== 1) {
            setRate(e, 1, cNow);
          }
        }
      } else { P.driftMs = 0; }
      if (!pending && nextIdx >= 0 && remaining <= PRESCHEDULE_MS) {
        var s = buffers[q[nextIdx].id];
        if (s && s.state === 'ready') schedulePending(adv, nextIdx);
      }
    }

    // ---- public surface ----
    P.setSnapshot = function (m) {
      var s = cleanSnapshot(m);
      if (!s) return false;
      if (P.snap && s.rev < P.snap.rev && s.seq === P.snap.seq) return true; // stale copy
      P.snap = s;
      if (s.role !== P.role) { P.role = s.role; applyRole(); }
      tick();
      changed();
      return true;
    };
    P.setTrim = function (ms) { P.trimMs = clamp(+ms || 0, -500, 500); tick(); };
    P.setVolume = function (v) {
      P.volume = clamp(+v, 0, 1);
      if (mixer) { var g = mixer.master.gain; if (g.setTargetAtTime) g.setTargetAtTime(P.volume, ctx.currentTime, 0.02); else g.value = P.volume; }
    };
    /** Must be called from a tap. Resumes the context and plays a silent blip (iOS wants both). */
    P.unlock = function () {
      ensureMixer();
      try {
        var b = ctx.createBuffer(1, 1, 22050), s = ctx.createBufferSource();
        s.buffer = b; s.connect(ctx.destination); s.start(0);
      } catch (x) { /* fine */ }
      var r = ctx.resume ? ctx.resume() : null;
      return Promise.resolve(r).then(function () { tick(); changed(); });
    };
    P.tick = tick;
    P.stop = function () { stopAll(false); };
    /** Position of the current track in ms as this phone believes it, or -1 when nothing is playing. */
    P.positionMs = function () {
      var s = P.snap;
      if (!s || !s.queue.length) return -1;
      if (s.state === 'paused' || s.state === 'preparing') return s.pausedPos;
      if (s.state !== 'playing' || !clock.ready()) return 0;
      var adv = advance(s.queue, s.index, s.epochStart, clock.hostNow() - P.trimMs);
      return clamp(clock.hostNow() - P.trimMs - adv.epoch, 0, s.queue[adv.idx].ms);
    };
    P.currentIndex = function () {
      var s = P.snap;
      if (!s || !s.queue.length) return -1;
      if (s.state !== 'playing' || !clock.ready()) return s.index;
      return advance(s.queue, s.index, s.epochStart, clock.hostNow() - P.trimMs).idx;
    };
    /** Id of the current track if its audio is decoded and waiting, for the host's "everyone ready" gate. */
    P.readyTrackId = function () {
      var s = P.snap;
      if (!s || !s.queue.length) return null;
      var id = s.queue[P.currentIndex()].id;
      return buffers[id] && buffers[id].state === 'ready' ? id : null;
    };
    P._debug = function () { return { active: active, pending: pending, buffers: buffers, mixer: mixer }; };
    return P;
  }

  // ------------------------------------------------------------------------------------------
  // Link: WebSocket + clock sync bursts
  // ------------------------------------------------------------------------------------------
  /** env: { WebSocket, url, perfNow(), setTimeout, clearTimeout } */
  function createLink(env) {
    var L = { state: 'connecting', onState: null, onMessage: null, onClock: null, filter: new ClockFilter(), lastRtt: 0 };
    var ws = null, backoff = 1000, timers = [], sent = {}, nextId = 1, samples = [], closedByUs = false, burstTimer = null, resyncTimer = null;

    function setState(s) { if (L.state !== s) { L.state = s; if (L.onState) L.onState(s); } }
    function later(fn, ms) { var t = env.setTimeout(fn, ms); timers.push(t); return t; }

    function send(obj) { if (ws && ws.readyState === 1) { ws.send(JSON.stringify(obj)); return true; } return false; }
    L.send = send;

    function ping() {
      var id = nextId++;
      sent[id] = env.perfNow();
      if (!send({ t: 'ping', id: id, c: sent[id] })) delete sent[id];
    }

    /** count pings, `spacing` ms apart, then one estimate. */
    L.burst = function (count, spacing) {
      if (burstTimer) return;
      samples = [];
      var n = 0;
      (function step() {
        if (!ws || ws.readyState !== 1) { burstTimer = null; return; }
        ping(); n++;
        if (n < count) burstTimer = later(step, spacing);
        else burstTimer = later(finish, Math.max(400, spacing * 3));
      })();
    };
    function finish() {
      burstTimer = null;
      var est = estimate(samples);
      if (est) {
        L.filter.update(est);
        L.lastRtt = est.rttMs;
        if (L.onClock) L.onClock(est);
        scheduleResync(30000);
      } else {
        scheduleResync(2000); // not enough answers; try again soon
      }
    }
    function scheduleResync(ms) {
      if (resyncTimer) env.clearTimeout(resyncTimer);
      resyncTimer = later(function () { resyncTimer = null; L.burst(L.filter.isReady() ? 10 : 24, L.filter.isReady() ? 100 : 60); }, ms);
    }
    L.resyncNow = function () { if (!burstTimer) L.burst(12, 60); };

    function onMessage(ev) {
      var m;
      try { m = JSON.parse(ev.data); } catch (x) { return; }
      if (!m || typeof m !== 'object') return;
      if (m.t === 'pong') {
        var t0 = sent[m.id];
        if (t0 === undefined) return;
        delete sent[m.id];
        samples.push({ t0: t0, t1: +m.r, t2: +m.s, t3: env.perfNow() });
      } else if (m.t === 'hello') {
        L.guestId = String(m.guest || '');
      } else if (L.onMessage) {
        L.onMessage(m);
      }
    }

    function connect() {
      closedByUs = false;
      setState('connecting');
      try { ws = new env.WebSocket(env.url); } catch (x) { retry(); return; }
      ws.onopen = function () {
        backoff = 1000; setState('open');
        L.burst(24, 60);
      };
      ws.onmessage = onMessage;
      ws.onclose = function () { ws = null; burstTimer = null; samples = []; sent = {}; if (!closedByUs) retry(); };
      ws.onerror = function () { /* onclose follows */ };
    }
    function retry() {
      setState('closed');
      later(connect, backoff);
      backoff = Math.min(backoff * 2, 10000);
    }
    L.connect = connect;
    L.close = function () { closedByUs = true; timers.forEach(env.clearTimeout); timers = []; if (ws) try { ws.close(); } catch (x) { /* ignore */ } };
    L.clock = {
      ready: function () { return L.filter.isReady(); },
      offsetMs: function () { return L.filter.offsetMs; },
      hostNow: function () { return env.perfNow() + L.filter.offsetMs; },
      errorMs: function () { return L.filter.errorMs; },
      rttMs: function () { return L.filter.rttMs; }
    };
    return L;
  }

  // ------------------------------------------------------------------------------------------
  // Page
  // ------------------------------------------------------------------------------------------
  function fmt(ms) {
    var t = Math.max(0, Math.round(ms / 1000)), m = Math.floor(t / 60), s = t % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  var ROLE_LABEL = { everyone: 'Everything', left: 'Left speaker', right: 'Right speaker', voice: 'Voice phone (plays the music too, for now)' };

  function syncLevel(view) {
    // view: {connected, clockReady, errMs, phase, unlocked, driftMs}
    if (!view.connected) return { level: 'bad', text: 'Reconnecting to your host...', detail: '' };
    if (!view.clockReady) return { level: 'warn', text: 'Syncing clocks...', detail: '' };
    var err = view.errMs + Math.abs(view.driftMs || 0);
    var detail = '±' + Math.max(1, Math.round(err)) + ' ms estimated';
    if (view.phase === 'playing') {
      if (err <= 30) return { level: 'good', text: 'In sync', detail: detail };
      if (err <= 80) return { level: 'warn', text: 'Adjusting...', detail: detail };
      return { level: 'bad', text: 'Out of sync', detail: detail };
    }
    if (view.phase === 'loading') return { level: 'warn', text: 'Downloading the track...', detail: detail };
    if (view.phase === 'locked') return { level: 'warn', text: 'Tap to enable audio', detail: detail };
    return { level: err <= 30 ? 'good' : 'warn', text: 'Clock synced', detail: detail };
  }

  function mount(doc) {
    doc = doc || document;
    var $ = function (id) { return doc.getElementById(id); };
    if (!$('mus-root')) return null;
    var AC = window.AudioContext || window.webkitAudioContext;
    var note = $('mus-note');
    var ctx = null;
    try { ctx = AC ? new AC({ latencyHint: 'playback' }) : null; } catch (x) { try { ctx = new AC(); } catch (y) { ctx = null; } }
    if (!ctx) { note.hidden = false; note.textContent = 'This browser cannot play synced audio. Try Chrome or Safari.'; return null; }

    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var link = createLink({
      WebSocket: window.WebSocket, url: proto + '//' + location.host + '/api/music/ws',
      perfNow: function () { return performance.now(); },
      setTimeout: function (f, ms) { return window.setTimeout(f, ms); },
      clearTimeout: function (t) { window.clearTimeout(t); }
    });
    var player = createPlayer({
      ctx: ctx, perfNow: function () { return performance.now(); }, clock: link.clock,
      fetchTrack: function (id) {
        return fetch('/music/track?id=' + encodeURIComponent(id), { credentials: 'same-origin', cache: 'no-store' })
          .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); });
      }
    });

    try { player.setTrim(+localStorage.getItem('beebo.music.trim') || 0); player.setVolume(localStorage.getItem('beebo.music.volume') === null ? 1 : +localStorage.getItem('beebo.music.volume')); } catch (x) { /* storage blocked */ }
    $('mus-volume').value = Math.round(player.volume * 100);
    $('mus-trim-val').textContent = player.trimMs + ' ms';

    link.onMessage = function (m) { if (m.t === 'state') player.setSnapshot(m); };
    link.onClock = function () { player.tick(); render(); };
    link.onState = function () { render(); };

    // Keeps the page counted as "playing media" so phones are less eager to freeze it.
    var keep = null;
    function keepAlive() {
      if (keep) return;
      try {
        var sr = 8000, n = 4000, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
        function s(o, t) { for (var i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); }
        s(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); s(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
        v.setUint16(22, 1, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
        s(36, 'data'); v.setUint32(40, n * 2, true);
        keep = new Audio(URL.createObjectURL(new Blob([buf], { type: 'audio/wav' })));
        keep.loop = true; keep.volume = 0.01; keep.setAttribute('playsinline', '');
        var p = keep.play(); if (p && p.catch) p.catch(function () { keep = null; });
      } catch (x) { keep = null; }
    }

    $('mus-unlock').addEventListener('click', function () {
      player.unlock().then(function () { keepAlive(); render(); });
    });
    ctx.onstatechange = function () { player.tick(); render(); };
    $('mus-volume').addEventListener('input', function () {
      player.setVolume(this.value / 100);
      try { localStorage.setItem('beebo.music.volume', String(player.volume)); } catch (x) { /* ignore */ }
    });
    function trim(delta) {
      player.setTrim(player.trimMs + delta);
      $('mus-trim-val').textContent = player.trimMs + ' ms';
      try { localStorage.setItem('beebo.music.trim', String(player.trimMs)); } catch (x) { /* ignore */ }
    }
    $('mus-trim-minus').addEventListener('click', function () { trim(-10); });
    $('mus-trim-plus').addEventListener('click', function () { trim(10); });

    var lastTrackId = '', lastQueueKey = '';
    function render() {
      var snap = player.snap, connected = link.state === 'open';
      var idx = player.currentIndex();
      var track = snap && idx >= 0 ? snap.queue[idx] : null;
      $('mus-title').textContent = track ? track.title || 'Untitled' : (snap && snap.state === 'ended' ? 'That was the last song' : 'Waiting for your host');
      $('mus-artist').textContent = track ? [track.artist, track.album].filter(Boolean).join(' · ')
        : 'When the host taps "Play together", the same song plays on every phone at once.';
      var pos = player.positionMs();
      $('mus-time').textContent = fmt(Math.max(0, pos));
      $('mus-dur').textContent = fmt(track ? track.ms : 0);
      $('mus-bar').style.width = track && pos >= 0 ? Math.min(100, 100 * pos / track.ms) + '%' : '0';
      $('mus-gate').hidden = player.unlocked;
      var view = { connected: connected, clockReady: link.clock.ready(), errMs: link.clock.errorMs(), phase: player.phase, unlocked: player.unlocked, driftMs: player.driftMs };
      var lvl = syncLevel(view);
      var box = $('mus-sync');
      box.setAttribute('data-level', lvl.level);
      $('mus-sync-text').textContent = lvl.text;
      $('mus-sync-detail').textContent = lvl.detail;
      $('mus-role').textContent = ROLE_LABEL[player.role] || ROLE_LABEL.everyone;
      var msg = player.note || (connected ? '' : (link.state === 'closed' ? 'Lost the connection to your host. Retrying...' : ''));
      note.hidden = !msg; note.textContent = msg;
      if (track && track.id !== lastTrackId) {
        lastTrackId = track.id;
        try {
          if (window.MediaMetadata && navigator.mediaSession) navigator.mediaSession.metadata = new MediaMetadata({ title: track.title, artist: track.artist, album: track.album });
        } catch (x) { /* optional */ }
      }
      var key = snap ? snap.queue.map(function (q) { return q.id; }).join(',') + '#' + idx : '';
      if (key !== lastQueueKey) {
        lastQueueKey = key;
        var ol = $('mus-queue'); ol.textContent = '';
        if (!snap || !snap.queue.length) {
          var li0 = doc.createElement('li'); li0.className = 'mus-empty'; li0.textContent = 'Nothing queued yet.'; ol.appendChild(li0);
        } else {
          snap.queue.slice(idx >= 0 ? idx : 0).forEach(function (q, i) {
            var li = doc.createElement('li');
            if (i === 0) li.setAttribute('aria-current', 'true');
            var d = doc.createElement('div');
            d.appendChild(doc.createTextNode(q.title || 'Untitled'));
            var sm = doc.createElement('small'); sm.textContent = q.artist; d.appendChild(sm);
            li.appendChild(d); ol.appendChild(li);
          });
        }
      }
    }
    player.onChange = render;

    var reportKey = '', lastReport = 0;
    function report() {
      var msg = {
        t: 'status', state: player.unlocked ? player.phase === 'playing' ? 'playing' : (player.phase === 'idle' ? 'idle' : player.phase) : 'locked',
        unlocked: player.unlocked, ready: player.readyTrackId(),
        errMs: link.clock.ready() ? Math.round(link.clock.errorMs() * 10) / 10 : -1,
        driftMs: Math.round(player.driftMs * 10) / 10, rttMs: Math.round(link.lastRtt * 10) / 10
      };
      if (['locked', 'syncing', 'loading', 'ready', 'playing', 'paused', 'idle', 'error'].indexOf(msg.state) < 0) msg.state = 'idle';
      var key = msg.state + '|' + msg.unlocked + '|' + msg.ready;
      var now = Date.now();
      if (key !== reportKey || now - lastReport > 5000) { reportKey = key; lastReport = now; link.send(msg); }
    }

    window.setInterval(function () { player.tick(); render(); report(); }, 250);
    doc.addEventListener('visibilitychange', function () {
      if (!doc.hidden) { link.resyncNow(); player.tick(); render(); if (ctx.state !== 'running') render(); }
    });
    link.connect();
    render();
    return { link: link, player: player, ctx: ctx };
  }

  return {
    PROTOCOL: PROTOCOL, ClockSync: ClockSync, advance: advance, cleanSnapshot: cleanSnapshot, syncLevel: syncLevel,
    createPlayer: createPlayer, createLink: createLink, mount: mount, fmt: fmt
  };
});
