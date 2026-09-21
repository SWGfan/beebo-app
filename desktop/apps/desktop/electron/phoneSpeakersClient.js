/*
 * Beebo Phone speakers - the browser side, shared by the guest phones (/speakers/join) and the TV / PC player
 * panel (phoneSpeakersWeb.js). Dependency-free ES5; served as /speakers/client.js; also loaded by node for the tests
 * (test/phone-speakers-client.test.js), with a fake AudioContext.
 *
 * Pieces (all exported):
 *   ClockSync       the NTP-style offset estimate between this device and the server. PORTED from the campsite synced
 *                   music (apps/core .../assets/campsite-music.js); test/fixtures/phone-speakers-clock-vectors.json holds
 *                   the same vectors that file is checked against, so the two cannot drift apart.
 *   positionAt      the shared timeline maths (same as watchTogetherSync.wtPositionAt).
 *   createLink()    fetch-based Server-Sent-Events stream + JSON posts, clock-sync bursts, reconnect with back-off.
 *   createEngine()  Web Audio scheduling: chained 5-second pieces on the shared clock, catch-up when joining late,
 *                   drift correction (small playbackRate nudges, a clean restart when far off), trim, output latency,
 *                   per-layer gain, high / low pass, fill-in layers, the beep test.
 *   mountGuest()    the phone's page.
 *
 * Clocks. The server stamps everything in its own clock ("server ms"). This device measures
 * offset = server - performance.now() with ClockSync. The room's timeline says "at server time anchorAt the film was
 * at anchorPos seconds"; the film position this phone must be playing NOW is positionAt(timeline, serverNow - delay),
 * where delay = this phone's trim + the room's picture delay. Web Audio is told to start a piece at the AudioContext time
 * whose sound is HEARD at the right performance time (getOutputTimestamp() maps context time to performance.now(),
 * output latency included where the browser reports it).
 *
 * NEVER builds markup from data: every string from the room reaches the page through textContent.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.BeeboSpeakers = api;
    // On the guest page (which has an element with id spk-root) start by itself: the page needs no inline script, so a strict CSP works.
    var d = root.document;
    if (d && d.getElementById) {
      var go = function () { if (d.getElementById('spk-root')) api.mountGuest(d, root); };
      if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', go); else go();
    }
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PROTOCOL = 1;

  // ------------------------------------------------------------------------------------------
  // ClockSync (a port of campsite-music.js's; keep the constants and the maths identical)
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

  /** samples: [{t0,t1,t2,t3}] -> {offsetMs, rttMs, errorMs, used, total} or null. offset = server minus this device. */
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
  function ClockFilter() { this.offsetMs = 0; this.errorMs = Infinity; this.rttMs = 0; this.updates = 0; }
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
  // The shared timeline
  // ------------------------------------------------------------------------------------------
  function positionAt(tl, serverMs) {
    if (!tl || !isFinite(tl.anchorPos)) return 0;
    var rate = tl.rate > 0 && isFinite(tl.rate) ? tl.rate : 1;
    if (tl.state !== 'playing') return tl.anchorPos;
    var dt = serverMs - tl.anchorAt;
    if (!(dt > 0)) return tl.anchorPos;
    return tl.anchorPos + (dt / 1000) * rate;
  }
  function isRunning(tl, serverMs) { return !!tl && tl.state === 'playing' && serverMs >= tl.anchorAt; }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  var FEED_RE = /^[A-Z]{2,3}$/;

  /** Validate a plan the server sent. The server is trusted, but its data reaches the DOM and the audio graph: be strict. */
  function cleanPlan(p) {
    if (!p || typeof p !== 'object' || !p.timeline || typeof p.timeline !== 'object') return null;
    var t = p.timeline;
    if (!isFinite(t.anchorPos) || !isFinite(t.anchorAt) || !isFinite(t.seq)) return null;
    var layers = [];
    var src = Array.isArray(p.layers) ? p.layers : [];
    for (var i = 0; i < src.length && layers.length < 8; i++) {
      var l = src[i];
      if (!l || typeof l.feed !== 'string' || !FEED_RE.test(l.feed)) continue;
      var pan = Array.isArray(l.pan) && isFinite(l.pan[0]) && isFinite(l.pan[1]) ? [clamp(+l.pan[0], 0, 1), clamp(+l.pan[1], 0, 1)] : null;
      layers.push({ feed: l.feed, gain: clamp(isFinite(l.gain) ? +l.gain : 1, 0, 1.5), pan: pan });
    }
    return {
      timeline: { state: t.state === 'playing' ? 'playing' : 'paused', anchorPos: +t.anchorPos, anchorAt: +t.anchorAt, rate: t.rate > 0 && isFinite(t.rate) ? +t.rate : 1, seq: t.seq | 0, rev: t.rev | 0 },
      hold: !!p.hold,
      segSec: p.segSec >= 1 && p.segSec <= 30 ? +p.segSec : 5,
      duration: p.duration > 0 ? +p.duration : 0,
      layers: layers,
      hp: clamp(isFinite(p.hp) ? +p.hp : 0, 0, 1000), lp: clamp(isFinite(p.lp) ? +p.lp : 0, 0, 22000),
      gainDb: clamp(isFinite(p.gainDb) ? +p.gainDb : 0, -24, 12),
      trimMs: clamp(isFinite(p.trimMs) ? +p.trimMs : 0, -500, 500),
      avOffsetMs: clamp(isFinite(p.avOffsetMs) ? +p.avOffsetMs : 0, -500, 500),
      muted: !!p.muted, stereo: !!p.stereo
    };
  }

  // ------------------------------------------------------------------------------------------
  // Server-Sent Events parser (fetch streams: the token stays in a header, never in a URL)
  // ------------------------------------------------------------------------------------------
  function createSseParser(onEvent) {
    var buf = '';
    return {
      push: function (text) {
        buf += text;
        var i;
        while ((i = buf.search(/\r\n\r\n|\n\n|\r\r/)) >= 0) {
          var m = /^(\r\n\r\n|\n\n|\r\r)/.exec(buf.slice(i));
          var frame = buf.slice(0, i);
          buf = buf.slice(i + m[1].length);
          var ev = { event: 'message', data: [], id: '' };
          var lines = frame.split(/\r\n|\n|\r/);
          for (var k = 0; k < lines.length; k++) {
            var line = lines[k];
            if (!line || line.charAt(0) === ':') continue;
            var c = line.indexOf(':');
            var field = c < 0 ? line : line.slice(0, c);
            var val = c < 0 ? '' : line.slice(c + 1).replace(/^ /, '');
            if (field === 'event') ev.event = val; else if (field === 'data') ev.data.push(val); else if (field === 'id') ev.id = val;
          }
          if (ev.data.length) onEvent({ event: ev.event, data: ev.data.join('\n'), id: ev.id });
        }
        if (buf.length > 1024 * 1024) buf = '';
      }
    };
  }

  // ------------------------------------------------------------------------------------------
  // Link: the stream, the calls, the clock
  // ------------------------------------------------------------------------------------------
  /**
   * env: { fetch, base ('/speakers/api'), getToken(), perfNow(), setTimeout, clearTimeout, TextDecoder, AbortController }
   * Callbacks: onSnapshot(state), onTimeline(tl event), onClosed(reason), onKicked(reason), onAuthLost(), onState(link state), onClock(est)
   */
  function createLink(env) {
    var L = { state: 'idle', filter: new ClockFilter(), lastRtt: 0, lastError: '' };
    var timers = [];
    var controller = null;
    var backoff = 1000;
    var samples = [];
    var burstTimer = null;
    var resyncTimer = null;
    var closedByUs = false;
    var pollTimer = null;
    var generation = 0;

    function setState(s) { if (L.state !== s) { L.state = s; if (L.onState) L.onState(s); } }
    function later(fn, ms) { var t = env.setTimeout(fn, ms); timers.push(t); return t; }
    function headers(extra) {
      var h = { 'X-Speaker-Token': env.getToken() || '' };
      if (extra) for (var k in extra) h[k] = extra[k];
      return h;
    }

    /** POST JSON with the token header. Resolves the parsed reply, or {ok:false,error} - never rejects. */
    L.post = function (path, body) {
      var h = headers({ 'Content-Type': 'application/json' });
      return env.fetch(env.base + path, { method: 'POST', headers: h, body: JSON.stringify(body || {}), cache: 'no-store', credentials: 'omit' })
        .then(function (r) {
          if (r.status === 401) { if (L.onAuthLost) L.onAuthLost(); }
          return r.json().catch(function () { return { ok: false, error: 'bad_reply', status: r.status }; });
        }, function () { return { ok: false, error: 'network' }; });
    };
    L.get = function (path, extraHeaders) {
      return env.fetch(env.base + path, { headers: headers(extraHeaders), cache: 'no-store', credentials: 'omit' });
    };

    // ---- clock ----
    function ping() {
      var t0 = env.perfNow();
      return L.post('/ping', { t0: t0 }).then(function (r) {
        var t3 = env.perfNow();
        if (r && r.ok && isFinite(r.t1) && isFinite(r.t2)) samples.push({ t0: t0, t1: +r.t1, t2: +r.t2, t3: t3 });
      });
    }
    L.burst = function (count, spacing) {
      if (burstTimer) return;
      samples = [];
      var n = 0;
      (function step() {
        if (L.state !== 'open') { burstTimer = null; return; }
        ping(); n++;
        if (n < count) burstTimer = later(step, spacing);
        else burstTimer = later(finish, Math.max(500, spacing * 4));
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
      } else scheduleResync(2000);
    }
    function scheduleResync(ms) {
      if (resyncTimer) env.clearTimeout(resyncTimer);
      resyncTimer = later(function () { resyncTimer = null; L.burst(L.filter.isReady() ? 10 : 24, L.filter.isReady() ? 100 : 60); }, ms);
    }
    L.resyncNow = function () { if (!burstTimer && L.state === 'open') L.burst(12, 60); };
    L.clock = {
      ready: function () { return L.filter.isReady(); },
      offsetMs: function () { return L.filter.offsetMs; },
      hostNow: function () { return env.perfNow() + L.filter.offsetMs; },
      errorMs: function () { return L.filter.errorMs; },
      rttMs: function () { return L.filter.rttMs; }
    };

    // ---- the stream ----
    function dispatch(ev) {
      var d;
      try { d = JSON.parse(ev.data); } catch (x) { return; }
      if (!d || typeof d !== 'object') return;
      if (ev.event === 'state') { if (L.onSnapshot) L.onSnapshot(d); }
      else if (ev.event === 'tl') { if (L.onTimeline) L.onTimeline(d); }
      else if (ev.event === 'closed') { closedByUs = true; setState('closed'); if (L.onClosed) L.onClosed(String(d.reason || '')); }
      else if (ev.event === 'kicked') { closedByUs = true; setState('closed'); if (L.onKicked) L.onKicked(String(d.reason || '')); }
    }
    function retry() {
      if (closedByUs) return;
      setState('reconnecting');
      later(connect, backoff);
      backoff = Math.min(backoff * 2, 10000);
    }
    function connect() {
      if (closedByUs) return;
      var gen = ++generation;
      setState('connecting');
      controller = env.AbortController ? new env.AbortController() : null;
      var opts = { headers: headers(), cache: 'no-store', credentials: 'omit' };
      if (controller) opts.signal = controller.signal;
      env.fetch(env.base + '/events', opts).then(function (res) {
        if (gen !== generation) return;
        if (res.status === 401 || res.status === 404) { closedByUs = true; setState('closed'); if (L.onAuthLost) L.onAuthLost(); return; }
        if (!res.ok) { retry(); return; }
        if (!res.body || !res.body.getReader) { startPolling(); return; } // a browser that cannot stream: ask once a second instead
        backoff = 1000;
        setState('open');
        L.burst(24, 60);
        var reader = res.body.getReader();
        var dec = new env.TextDecoder();
        var parser = createSseParser(dispatch);
        (function pump() {
          reader.read().then(function (r) {
            if (gen !== generation) return;
            if (r.done) { retry(); return; }
            parser.push(dec.decode(r.value, { stream: true }));
            pump();
          }, function () { if (gen === generation) retry(); });
        })();
      }, function () { if (gen === generation) retry(); });
    }
    function startPolling() {
      if (pollTimer) return;
      setState('open');
      L.burst(24, 60);
      (function once() {
        if (closedByUs) return;
        L.get('/poll').then(function (r) { return r.json(); }).then(function (d) {
          if (d && d.you && L.onSnapshot) L.onSnapshot(d);
        }, function () {}).then(function () { pollTimer = later(once, 1000); });
      })();
    }
    L.connect = connect;
    L.close = function () {
      closedByUs = true; generation++;
      for (var i = 0; i < timers.length; i++) env.clearTimeout(timers[i]);
      timers = [];
      if (controller) { try { controller.abort(); } catch (x) { /* ignore */ } }
      setState('closed');
    };
    return L;
  }

  // ------------------------------------------------------------------------------------------
  // Engine: Web Audio scheduling
  // ------------------------------------------------------------------------------------------
  var LEAD_MS = 150;            // how far ahead of "now" a catch-up start is scheduled (more when the output latency is high)
  var HORIZON_S = 3.0;          // schedule a piece this far ahead of its start, no earlier (a re-plan cancels what is unstarted)
  var HARD_RESYNC_MS = 60;      // beyond this a clean restart beats a nudge
  var ENGAGE_MS = 12;           // start nudging above this median drift
  var RELEASE_MS = 5;           // stop nudging below this
  var CORRECT_WINDOW_MS = 2000; // aim to remove the drift over this long
  var MAX_NUDGE = 0.01;         // +-1% playbackRate: about 17 cents, barely audible and only while correcting
  var DRIFT_HISTORY = 5;
  var MIN_RESTART_GAP_MS = 1500;
  var MAX_TRIES = 12;

  function decodeAudio(ctx, bytes) {
    return new Promise(function (resolve, reject) {
      var p = ctx.decodeAudioData(bytes, resolve, reject);
      if (p && typeof p.then === 'function') p.then(resolve, reject);
    });
  }
  function dbToGain(db) { return Math.pow(10, db / 20); }

  /**
   * env: { ctx, perfNow(), clock:{ready(), offsetMs(), hostNow(), errorMs()},
   *        fetchPiece(feed, n, seq, signal) -> Promise<ArrayBuffer>, decode?(bytes) -> Promise<AudioBuffer>, AbortController? }
   */
  function createEngine(env) {
    var ctx = env.ctx;
    var perfNow = env.perfNow;
    var clock = env.clock;
    var decode = env.decode || function (b) { return decodeAudio(ctx, b); };
    var AC = env.AbortController || (typeof AbortController !== 'undefined' ? AbortController : null);
    var E = { plan: null, phase: 'idle', note: '', driftMs: 0, unlocked: false, ready: false, appliedSeq: 0, onChange: null, restarts: 0, nudges: 0, lastError: '' };
    var voices = {};   // feed -> { feed, gain, pan, pieces:{n:{state,bytes,buffer,tries,nextTry}}, sched:{n:{src,gain,startCtx,endCtx}} }
    var run = null;    // { seq, anchorPos, anchorCtx, nudge, hist:[], startedPerf, lastRestartPerf }
    var graph = null;
    var abort = null;
    var beepSeen = 0;

    function changed() { if (E.onChange) E.onChange(); }

    // ---- audio graph: [voice source -> gain -> (pan) ] -> input -> high-pass -> low-pass -> master -> speakers ----
    function ensureGraph() {
      if (graph) return graph;
      var g = {};
      g.input = ctx.createGain();
      g.hp = ctx.createBiquadFilter(); g.hp.type = 'highpass'; g.hp.frequency.value = 10; g.hp.Q.value = 0.7;
      g.lp = ctx.createBiquadFilter(); g.lp.type = 'lowpass'; g.lp.frequency.value = 22000; g.lp.Q.value = 0.7;
      g.master = ctx.createGain(); g.master.gain.value = 1;
      g.merger = ctx.createChannelMerger(2);
      g.input.connect(g.hp); g.hp.connect(g.lp); g.lp.connect(g.master); g.master.connect(ctx.destination);
      graph = g;
      return g;
    }
    function setParam(param, value, t) {
      if (param.setTargetAtTime) param.setTargetAtTime(value, t, 0.02); else param.value = value;
    }
    function applyTone() {
      if (!graph || !E.plan) return;
      var t = ctx.currentTime, p = E.plan;
      setParam(graph.hp.frequency, p.hp > 0 ? p.hp : 10, t);
      setParam(graph.lp.frequency, p.lp > 0 ? p.lp : 22000, t);
      setParam(graph.master.gain, p.muted ? 0 : dbToGain(p.gainDb), t);
    }

    // ---- time mapping ----
    /** AudioContext time whose sound is HEARD at performance time perfMs. */
    function ctxForPerf(perfMs) {
      var ts = ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null;
      if (ts && ts.performanceTime > 0 && ts.contextTime > 0 && isFinite(ts.contextTime)) return ts.contextTime + (perfMs - ts.performanceTime) / 1000;
      var lat = ctx.outputLatency || 0;
      return ctx.currentTime - lat + (perfMs - perfNow()) / 1000;
    }
    function outLatencyMs() { return ctx.outputLatency > 0 ? Math.round(ctx.outputLatency * 1000) : -1; }
    function delayMs() { return E.plan ? E.plan.trimMs + E.plan.avOffsetMs : 0; }
    function rateTotal() { return run ? (E.plan ? E.plan.timeline.rate : 1) * run.nudge : 1; }
    E.outLatencyMs = outLatencyMs;

    // ---- pieces ----
    function slot(v, n) { return v.pieces[n] || (v.pieces[n] = { state: 'idle', bytes: null, buffer: null, tries: 0, nextTry: 0 }); }
    function fetchPiece(v, n) {
      var s = slot(v, n);
      if (s.state !== 'idle' || perfNow() < s.nextTry) return;
      s.state = 'fetching';
      var seq = E.plan ? E.plan.timeline.seq : 0;
      var sig = abort ? abort.signal : undefined;
      Promise.resolve().then(function () { return env.fetchPiece(v.feed, n, seq, sig); }).then(function (bytes) {
        s.bytes = bytes; s.state = 'fetched'; s.tries = 0; changed();
      }, function (e) {
        s.state = 'idle';
        if (e && (e.stale || e.name === 'AbortError')) { s.nextTry = 0; return; } // a newer plan is on its way: ask again then
        if (e && e.status === 404) { s.state = 'gone'; return; } // past the end of the film: there is no such piece, and never will be
        s.tries++;
        s.nextTry = perfNow() + Math.min(4000, 300 * Math.pow(2, Math.min(s.tries, 5)));
        if (s.tries >= MAX_TRIES) { s.state = 'error'; E.lastError = 'Could not get the sound from the computer.'; }
        changed();
      });
    }
    function decodePiece(v, n) {
      var s = slot(v, n);
      if (s.state !== 'fetched') return;
      s.state = 'decoding';
      var bytes = s.bytes; s.bytes = null;
      Promise.resolve().then(function () { return decode(bytes); }).then(function (buf) {
        s.buffer = buf; s.state = 'ready'; changed();
      }, function () { s.state = 'error'; E.lastError = 'This phone could not play the sound.'; changed(); });
    }
    function beyondEnd(n) { return !!E.plan && E.plan.duration > 0 && n * E.plan.segSec >= E.plan.duration; }
    function want(v, n) {
      if (beyondEnd(n)) return true; // nothing to get there: the film is over
      var s = slot(v, n);
      if (s.state === 'idle') fetchPiece(v, n);
      else if (s.state === 'fetched') decodePiece(v, n);
      return s.state === 'ready';
    }
    function evict(n0) {
      Object.keys(voices).forEach(function (f) {
        var v = voices[f];
        Object.keys(v.pieces).forEach(function (k) { var n = +k; if (n < n0 - 1 || n > n0 + 4) delete v.pieces[k]; });
      });
    }

    // ---- sources ----
    function stopEntry(e, fade) {
      if (!e) return;
      var t = ctx.currentTime;
      try {
        if (fade) { e.gain.gain.setTargetAtTime(0, t, 0.006); e.src.stop(t + 0.04); }
        else e.src.stop();
      } catch (x) { /* never started, or already stopped */ }
    }
    function stopVoiceSources(v, fade, onlyUnstarted) {
      var t = ctx.currentTime;
      Object.keys(v.sched).forEach(function (k) {
        var e = v.sched[k];
        if (onlyUnstarted && e.startCtx <= t + 0.03) return;
        stopEntry(e, fade); delete v.sched[k];
      });
    }
    function stopAll(fade) {
      Object.keys(voices).forEach(function (f) { stopVoiceSources(voices[f], fade, false); });
      run = null;
    }

    function reconcileVoices() {
      var want = {};
      var layers = E.plan ? E.plan.layers : [];
      layers.forEach(function (l) { want[l.feed] = l; });
      Object.keys(voices).forEach(function (f) { if (!want[f]) { stopVoiceSources(voices[f], true, false); delete voices[f]; } });
      layers.forEach(function (l) {
        var v = voices[l.feed];
        if (!v) v = voices[l.feed] = { feed: l.feed, gain: l.gain, pan: l.pan, pieces: {}, sched: {} };
        v.gain = l.gain; v.pan = l.pan;
      });
    }

    function makeEntry(v, n, buf, when, offset, rate) {
      var g = ensureGraph();
      var src = ctx.createBufferSource();
      src.buffer = buf;
      var gain = ctx.createGain();
      gain.gain.value = v.gain;
      src.connect(gain);
      if (E.plan && E.plan.stereo && v.pan) {
        var l = ctx.createGain(); var r = ctx.createGain();
        l.gain.value = v.pan[0]; r.gain.value = v.pan[1];
        gain.connect(l); gain.connect(r);
        var m = ctx.createChannelMerger(2);
        l.connect(m, 0, 0); r.connect(m, 0, 1);
        m.connect(g.input);
      } else gain.connect(g.input);
      src.playbackRate.value = rate;
      src.start(when, offset);
      src.onended = function () { try { gain.disconnect(); } catch (x) { /* gone */ } };
      return { src: src, gain: gain, startCtx: when, offset: offset };
    }

    // ---- the run: where the film is, in AudioContext time ----
    function startRun(tl, heardNow) {
      var lead = Math.max(LEAD_MS, outLatencyMs() + 60);
      var p0, perfTarget;
      var srvTarget = heardNow; // server time being heard now
      if (tl.anchorAt > srvTarget + lead) { // a start in the future: be exactly on it
        p0 = tl.anchorPos;
        perfTarget = tl.anchorAt + delayMs() - clock.offsetMs();
      } else {
        p0 = positionAt(tl, srvTarget + lead);
        perfTarget = perfNow() + lead;
      }
      run = { seq: tl.seq, anchorPos: p0, anchorCtx: ctxForPerf(perfTarget), nudge: 1, hist: [], startedPerf: perfNow(), lastRestartPerf: perfNow() };
      return run;
    }
    function ctxOfPos(p) { return run.anchorCtx + (p - run.anchorPos) / rateTotal(); }
    function posAtCtx(c) { return run.anchorPos + (c - run.anchorCtx) * rateTotal(); }

    function pump() {
      if (!run || !E.plan) return;
      var S = E.plan.segSec, cNow = ctx.currentTime, rt = rateTotal();
      var heardCtx = ctxForPerf(perfNow());
      var nHeard = Math.max(0, Math.floor(posAtCtx(heardCtx) / S));
      var nFirst = Math.max(nHeard, Math.floor(run.anchorPos / S));
      Object.keys(voices).forEach(function (f) {
        var v = voices[f];
        for (var n = nFirst; n <= nFirst + 2; n++) {
          if (v.sched[n]) continue;
          var s = slot(v, n);
          if (s.state !== 'ready') continue;
          var buf = s.buffer, dur = buf.duration;
          var startPos = Math.max(n * S, run.anchorPos);
          var startCtx = ctxOfPos(startPos);
          if (startCtx - cNow > HORIZON_S) break;
          var endCtx = startCtx + (n * S + dur - startPos) / rt;
          if (endCtx < cNow + 0.03) continue; // that piece is already over
          var offset = startPos - n * S, when = startCtx;
          var late = cNow + 0.005 - when;
          if (late > 0) { when += late; offset += late * rt; }
          if (offset >= dur - 0.005) continue;
          v.sched[n] = makeEntry(v, n, buf, when, offset, rt);
          v.sched[n].endCtx = endCtx;
        }
        // forget entries that have finished
        Object.keys(v.sched).forEach(function (k) { if (v.sched[k].endCtx < cNow - 1) delete v.sched[k]; });
      });
    }

    function reanchor(newNudge, heardCtx) {
      var pos = posAtCtx(heardCtx);
      run.anchorPos = pos; run.anchorCtx = heardCtx; run.nudge = newNudge;
      var rt = rateTotal(), cNow = ctx.currentTime;
      Object.keys(voices).forEach(function (f) {
        var v = voices[f];
        stopVoiceSources(v, false, true); // the ones that have not started yet are re-planned on the new map
        Object.keys(v.sched).forEach(function (k) {
          var e = v.sched[k];
          e.src.playbackRate.setValueAtTime(rt, Math.max(cNow, heardCtx));
          e.endCtx = ctxOfPos(+k * E.plan.segSec + (e.src.buffer ? e.src.buffer.duration : E.plan.segSec));
        });
      });
      run.hist = [];
    }

    function maintainDrift(tl, srvHeard) {
      var cHeard = ctxForPerf(perfNow());
      if (cHeard < run.anchorCtx + 0.4) { E.driftMs = 0; return; }
      var actual = posAtCtx(cHeard);
      var expected = positionAt(tl, srvHeard);
      var drift = (actual - expected) * 1000;
      run.hist.push(drift);
      if (run.hist.length > DRIFT_HISTORY) run.hist.shift();
      if (run.hist.length < 3) return;
      var med = median(run.hist);
      E.driftMs = med;
      if (Math.abs(med) > HARD_RESYNC_MS) {
        if (perfNow() - run.lastRestartPerf >= MIN_RESTART_GAP_MS) {
          Object.keys(voices).forEach(function (f) { stopVoiceSources(voices[f], true, false); });
          var again = perfNow();
          startRun(tl, srvHeard);
          run.lastRestartPerf = again;
          E.restarts++;
        }
      } else if (Math.abs(med) > ENGAGE_MS) {
        reanchor(1 - clamp(med / CORRECT_WINDOW_MS, -MAX_NUDGE, MAX_NUDGE), cHeard); E.nudges++;
      } else if (Math.abs(med) < RELEASE_MS && run.nudge !== 1) {
        reanchor(1, cHeard);
      }
    }

    // ---- the loop ----
    E.tick = function () {
      var prev = E.phase + '|' + E.note + '|' + E.ready;
      E.unlocked = !!ctx && ctx.state === 'running';
      E.note = '';
      var p = E.plan;
      if (!p) { E.phase = 'idle'; E.ready = false; return finishTick(prev); }
      var tl = p.timeline;
      if (!p.layers.length || p.muted) {
        stopAll(true); reconcileVoices(); E.phase = 'idle'; E.ready = true; E.driftMs = 0; return finishTick(prev);
      }
      if (tl.rate !== 1) {
        stopAll(true); E.phase = 'rate'; E.ready = true; E.driftMs = 0;
        E.note = 'The picture is not playing at normal speed. Phone speakers stay quiet until it is.';
        return finishTick(prev);
      }
      var S = p.segSec;
      var srvHeard = clock.ready() ? clock.hostNow() - delayMs() : tl.anchorAt;
      var running = clock.ready() && isRunning(tl, srvHeard) && !p.hold;
      var scheduledStart = clock.ready() && tl.state === 'playing' && !p.hold && tl.anchorAt > srvHeard && tl.anchorAt - srvHeard < 5000;
      var refPos = running ? positionAt(tl, srvHeard) : tl.anchorPos;
      var n0 = Math.max(0, Math.floor(refPos / S));
      // the pieces around where we are: the one we are in, and the next when the end is near
      var playingNow = running || scheduledStart;
      var allReady = true;
      Object.keys(voices).forEach(function (f) {
        var v = voices[f];
        var ok = want(v, n0);
        want(v, n0 + 1); // always one piece ahead: paused, so a resume is instant; playing, so the next one is never late
        if (playingNow && refPos - n0 * S > S - 2.5) want(v, n0 + 2);
        if (!ok) allReady = false;
      });
      evict(n0);
      E.ready = allReady && E.appliedSeq === tl.seq;
      var anyError = Object.keys(voices).some(function (f) { var s2 = voices[f].pieces[n0]; return s2 && s2.state === 'error'; });
      if (anyError) E.note = E.lastError;
      if (!clock.ready()) { stopAll(true); E.driftMs = 0; E.phase = 'syncing'; return finishTick(prev); }
      if (!running && !scheduledStart) {
        stopAll(true); E.driftMs = 0;
        E.phase = anyError ? 'error' : (allReady ? 'ready' : 'loading');
        return finishTick(prev);
      }
      if (!allReady) { if (run) { /* a new voice while playing: the run goes on */ } else { E.phase = anyError ? 'error' : 'loading'; return finishTick(prev); } }
      if (!E.unlocked) { E.phase = 'locked'; return finishTick(prev); }
      ensureGraph(); applyTone();
      if (!run || run.seq !== tl.seq) {
        if (run) stopAll(true);
        startRun(tl, srvHeard);
      } else maintainDrift(tl, srvHeard);
      pump();
      E.phase = 'playing';
      return finishTick(prev);
    };
    function finishTick(prev) {
      if (E.phase !== 'playing' && E.phase !== 'ready') E.driftMs = 0;
      if (prev !== E.phase + '|' + E.note + '|' + E.ready) changed();
    }

    // ---- surface ----
    /** Apply a new plan from the server (a `state` snapshot's you + room parts). */
    E.setPlan = function (raw) {
      var p = cleanPlan(raw);
      if (!p) return false;
      var old = E.plan;
      if (old && (p.timeline.seq < old.timeline.seq || (p.timeline.seq === old.timeline.seq && p.timeline.rev < old.timeline.rev))) return true; // an older copy
      var newSeq = !old || old.timeline.seq !== p.timeline.seq;
      E.plan = p;
      if (newSeq) {
        if (abort) { try { abort.abort(); } catch (x) { /* ignore */ } }
        abort = AC ? new AC() : null;
        E.appliedSeq = p.timeline.seq;
        E.ready = false;
        stopAll(true);
      } else if (old && (old.trimMs !== p.trimMs || old.avOffsetMs !== p.avOffsetMs) && run) {
        // the delay changed: the same run, seen from a different moment - restart it cleanly
        stopAll(true);
      }
      reconcileVoices();
      applyTone();
      E.tick();
      changed();
      return true;
    };
    /** Must be called from a tap. Resumes the context and plays a silent blip (iOS wants both). */
    E.unlock = function () {
      ensureGraph();
      try { var b = ctx.createBuffer(1, 1, 22050), s = ctx.createBufferSource(); s.buffer = b; s.connect(ctx.destination); s.start(0); } catch (x) { /* fine */ }
      var r = ctx.resume ? ctx.resume() : null;
      return Promise.resolve(r).then(function () { E.tick(); changed(); });
    };
    E.stop = function () { stopAll(false); };
    /** The film position this device is playing right now, or -1. */
    E.positionSec = function () { return run && E.phase === 'playing' ? posAtCtx(ctxForPerf(perfNow())) : -1; };
    E.status = function (rttMs) {
      return {
        state: E.unlocked ? (E.phase === 'rate' ? 'idle' : E.phase) : 'locked',
        unlocked: E.unlocked, ready: E.ready, seq: E.appliedSeq,
        errMs: clock.ready() ? Math.round(clock.errorMs() * 10) / 10 : -1,
        driftMs: Math.round(E.driftMs * 10) / 10, rttMs: Math.round((rttMs || 0) * 10) / 10, outLatencyMs: outLatencyMs()
      };
    };

    /** The beep test. beep: { id, pattern:'turns'|'together', startAt, intervalMs, rounds, slots:[{id,freq}] }, myId: 'tv' or this phone's gid. */
    E.scheduleBeep = function (beep, myId) {
      if (!beep || !isFinite(beep.id) || beep.id === beepSeen || !E.unlocked || !clock.ready() || !Array.isArray(beep.slots)) return 0;
      beepSeen = beep.id;
      var idx = -1, freq = 1000;
      for (var i = 0; i < beep.slots.length; i++) if (beep.slots[i].id === myId) { idx = i; freq = clamp(+beep.slots[i].freq || 1000, 200, 4000); }
      if (idx < 0) return 0;
      var g = ensureGraph(), count = 0, together = beep.pattern === 'together';
      for (var r = 0; r < clamp(beep.rounds | 0, 0, 12); r++) {
        var srv = together ? beep.startAt + r * beep.intervalMs : beep.startAt + (r * beep.slots.length + idx) * beep.intervalMs;
        var perfT = srv + (E.plan ? E.plan.trimMs : 0) - clock.offsetMs();
        var when = ctxForPerf(perfT);
        if (when < ctx.currentTime + 0.01) continue;
        var osc = ctx.createOscillator(), env2 = ctx.createGain();
        osc.frequency.value = freq;
        var dur = together ? 0.03 : 0.16;
        env2.gain.setValueAtTime(0, when);
        env2.gain.linearRampToValueAtTime(0.5, when + 0.004);
        env2.gain.setValueAtTime(0.5, when + dur - 0.01);
        env2.gain.linearRampToValueAtTime(0, when + dur);
        osc.connect(env2); env2.connect(g.master);
        osc.start(when); osc.stop(when + dur + 0.02);
        count++;
      }
      return count;
    };
    E._debug = function () { return { voices: voices, run: run, graph: graph }; };
    return E;
  }

  // ------------------------------------------------------------------------------------------
  // Words for the page
  // ------------------------------------------------------------------------------------------
  /** {connected, clockReady, errMs, driftMs, phase, unlocked, bt} -> { level, text, detail } */
  function syncLevel(view) {
    if (!view.connected) return { level: 'bad', text: 'Reconnecting to the computer...', detail: '' };
    if (!view.clockReady) return { level: 'warn', text: 'Syncing clocks...', detail: '' };
    var err = view.errMs + Math.abs(view.driftMs || 0);
    var detail = '+/-' + Math.max(1, Math.round(err)) + ' ms estimated';
    if (view.phase === 'playing') {
      if (err <= 30) return { level: 'good', text: 'In sync', detail: detail };
      if (err <= 80) return { level: 'warn', text: 'Adjusting...', detail: detail };
      return { level: 'bad', text: 'Out of sync', detail: detail };
    }
    if (view.phase === 'loading') return { level: 'warn', text: 'Loading the sound...', detail: detail };
    if (!view.unlocked) return { level: 'warn', text: 'Tap to enable audio', detail: detail };
    if (view.phase === 'rate') return { level: 'warn', text: 'Waiting for normal speed', detail: detail };
    return { level: err <= 30 ? 'good' : 'warn', text: view.phase === 'idle' ? 'Ready - no channel yet' : 'Ready', detail: detail };
  }
  var BT_WARN_MS = 90;
  function bluetoothNote(outLatencyMs, declared) {
    if (declared) return 'You said this phone plays through a Bluetooth speaker. Bluetooth adds 100-250 ms: use the beep test and the trim buttons to line it up.';
    if (outLatencyMs >= BT_WARN_MS) return 'This phone reports about ' + Math.round(outLatencyMs) + ' ms of audio delay, which is typical of Bluetooth. Use the beep test and the trim buttons to line it up.';
    return '';
  }

  // ------------------------------------------------------------------------------------------
  // The guest phone's page
  // ------------------------------------------------------------------------------------------
  function h(doc, tag, cls, text) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function store(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (x) { /* private mode */ } }
  function stored(k) { try { return localStorage.getItem(k) || ''; } catch (x) { return ''; } }

  var CODE_RE = /^[0-9A-Za-z-]{20,40}$/;

  function mountGuest(doc, win) {
    doc = doc || document; win = win || window;
    var rootEl = doc.getElementById('spk-root');
    if (!rootEl) return null;
    var AudioCtx = win.AudioContext || win.webkitAudioContext;
    var perf = function () { return win.performance.now(); };
    var code = '';
    try {
      var sp = new URLSearchParams(win.location.search);
      code = sp.get('k') || '';
      if (code && win.history && win.history.replaceState) win.history.replaceState(null, '', win.location.pathname); // the key leaves the address bar
    } catch (x) { /* old browser */ }
    var saved = null;
    try { saved = JSON.parse(stored('beebo.spk.session') || 'null'); } catch (x) { saved = null; }
    if (!CODE_RE.test(code)) code = '';
    if (!code && saved && saved.k) code = saved.k;
    var S = { token: (saved && saved.k === code && saved.token) || '', name: stored('beebo.spk.name'), snap: null, joined: false, error: '', closed: '', btDeclared: stored('beebo.spk.bt') === '1' };

    var ctx = null;
    try { ctx = AudioCtx ? new AudioCtx({ latencyHint: 'playback' }) : null; } catch (x) { try { ctx = new AudioCtx(); } catch (y) { ctx = null; } }

    var link = createLink({
      fetch: function (u, o) { return win.fetch(u, o); }, base: '/speakers/api', getToken: function () { return S.token; }, perfNow: perf,
      setTimeout: function (f, ms) { return win.setTimeout(f, ms); }, clearTimeout: function (t) { win.clearTimeout(t); },
      TextDecoder: win.TextDecoder, AbortController: win.AbortController
    });
    var engine = ctx ? createEngine({
      ctx: ctx, perfNow: perf, clock: link.clock,
      fetchPiece: function (feed, n, seq, signal) {
        return win.fetch('/speakers/audio/' + encodeURIComponent(feed) + '/' + n + '.wav', { headers: { 'X-Speaker-Token': S.token, 'X-Speaker-Seq': String(seq) }, cache: 'no-store', credentials: 'omit', signal: signal })
          .then(function (r) {
            if (r.status === 409) { var e = new Error('stale'); e.stale = true; throw e; }
            if (!r.ok) { var f = new Error('HTTP ' + r.status); f.status = r.status; throw f; }
            return r.arrayBuffer();
          });
      }
    }) : null;

    // ---- the page ----
    var root = rootEl; clear(root);
    var card = h(doc, 'div', 'spk-card');
    var title = h(doc, 'h1', 'spk-title', 'Phone speaker');
    var sub = h(doc, 'p', 'spk-sub', '');
    var seatBox = h(doc, 'div', 'spk-seat');
    var seatBig = h(doc, 'div', 'spk-seat-big', '');
    var seatSmall = h(doc, 'div', 'spk-seat-small', '');
    seatBox.appendChild(seatBig); seatBox.appendChild(seatSmall);
    var syncBox = h(doc, 'div', 'spk-sync'); var dot = h(doc, 'span', 'spk-dot'); var syncText = h(doc, 'span', 'spk-sync-text', ''); var syncDetail = h(doc, 'small', 'spk-sync-detail', '');
    syncBox.appendChild(dot); syncBox.appendChild(syncText); syncBox.appendChild(syncDetail);
    var notice = h(doc, 'p', 'spk-notice', ''); notice.hidden = true;
    var joinBox = h(doc, 'div', 'spk-join');
    var nameIn = h(doc, 'input', 'spk-input'); nameIn.type = 'text'; nameIn.maxLength = 24; nameIn.placeholder = 'Your name'; nameIn.setAttribute('aria-label', 'Your name'); nameIn.autocomplete = 'nickname'; nameIn.value = S.name;
    var joinBtn = h(doc, 'button', 'spk-btn spk-primary', 'Join'); joinBtn.type = 'button';
    joinBox.appendChild(h(doc, 'label', 'spk-label', 'What should we call you?')); joinBox.appendChild(nameIn); joinBox.appendChild(joinBtn);
    var gate = h(doc, 'button', 'spk-btn spk-gate', 'Tap to enable audio'); gate.type = 'button'; gate.hidden = true;
    var ctl = h(doc, 'div', 'spk-controls'); ctl.hidden = true;
    var volRow = h(doc, 'div', 'spk-row'); volRow.appendChild(h(doc, 'span', 'spk-label', 'Volume'));
    var vol = h(doc, 'input', 'spk-range'); vol.type = 'range'; vol.min = '-12'; vol.max = '12'; vol.step = '1'; vol.value = '0'; vol.setAttribute('aria-label', 'Volume trim in dB');
    volRow.appendChild(vol);
    var trimRow = h(doc, 'div', 'spk-row'); trimRow.appendChild(h(doc, 'span', 'spk-label', 'Timing'));
    var trimMinus = h(doc, 'button', 'spk-btn spk-small', '-5 ms'); trimMinus.type = 'button';
    var trimVal = h(doc, 'span', 'spk-trim', '0 ms');
    var trimPlus = h(doc, 'button', 'spk-btn spk-small', '+5 ms'); trimPlus.type = 'button';
    trimRow.appendChild(trimMinus); trimRow.appendChild(trimVal); trimRow.appendChild(trimPlus);
    var trimHelp = h(doc, 'small', 'spk-help', 'If this phone sounds late, use minus (sound earlier). If early, use plus.');
    var btRow = h(doc, 'label', 'spk-row spk-check'); var btBox = h(doc, 'input'); btBox.type = 'checkbox'; btBox.checked = S.btDeclared;
    btRow.appendChild(btBox); btRow.appendChild(h(doc, 'span', '', ' This phone plays through a Bluetooth speaker'));
    var rosterHead = h(doc, 'h2', 'spk-h2', 'Who is here');
    var roster = h(doc, 'ul', 'spk-roster');
    var leaveBtn = h(doc, 'button', 'spk-btn spk-danger', 'Leave'); leaveBtn.type = 'button';
    var beepNote = h(doc, 'p', 'spk-beep', ''); beepNote.hidden = true;
    var line = h(doc, 'p', 'spk-line', '');
    ctl.appendChild(volRow); ctl.appendChild(trimRow); ctl.appendChild(trimHelp); ctl.appendChild(btRow);
    [title, sub, notice, joinBox, seatBox, syncBox, gate, beepNote, ctl, rosterHead, roster, line, leaveBtn].forEach(function (e) { card.appendChild(e); });
    root.appendChild(card);
    rosterHead.hidden = true; roster.hidden = true; leaveBtn.hidden = true; seatBox.hidden = true; syncBox.hidden = true;

    function say(msg) { notice.hidden = !msg; notice.textContent = msg || ''; }
    function saveSession() { store('beebo.spk.session', S.token ? JSON.stringify({ k: code, token: S.token }) : null); }

    // ---- keep the page alive: a silent looping <audio> (works without HTTPS), the wake lock where it exists ----
    var keep = null, wake = null;
    function keepAlive() {
      if (!keep) {
        try {
          var sr = 8000, n = 4000, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
          var w = function (o, t) { for (var i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
          w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
          v.setUint16(22, 1, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
          w(36, 'data'); v.setUint32(40, n * 2, true);
          keep = new win.Audio(win.URL.createObjectURL(new win.Blob([buf], { type: 'audio/wav' })));
          keep.loop = true; keep.volume = 0.01; keep.setAttribute('playsinline', '');
        } catch (x) { keep = null; }
      }
      if (keep) { var p = keep.play(); if (p && p.catch) p.catch(function () { /* the next tap tries again */ }); }
      try { if (win.navigator.wakeLock && !wake) win.navigator.wakeLock.request('screen').then(function (l) { wake = l; l.addEventListener('release', function () { wake = null; }); }, function () { /* http: not allowed */ }); } catch (x) { /* optional */ }
      try {
        if (win.MediaMetadata && win.navigator.mediaSession && S.snap) win.navigator.mediaSession.metadata = new win.MediaMetadata({ title: 'Phone speaker: ' + (S.snap.you.seatLabel || ''), artist: S.snap.room.title || 'Beebo' });
      } catch (x) { /* optional */ }
    }

    // ---- state from the server ----
    function applySnapshot(d) {
      if (!d || !d.you || !d.room) return;
      if (S.snap && d.eventSeq < S.snap.eventSeq) return;
      S.snap = d;
      if (engine) {
        engine.setPlan({
          timeline: d.room.timeline, hold: !!d.room.hold, segSec: d.room.segSec, duration: d.room.duration, layers: d.you.layers,
          hp: d.you.hp, lp: d.you.lp, gainDb: d.you.gainDb, trimMs: d.you.trimMs, avOffsetMs: d.room.avOffsetMs, muted: d.you.muted, stereo: false
        });
        if (d.room.beep) engine.scheduleBeep(d.room.beep, d.you.gid);
      }
      render();
    }
    link.onSnapshot = applySnapshot;
    link.onTimeline = function (d) {
      if (!S.snap || !d || !d.timeline) return;
      S.snap.room.timeline = d.timeline; S.snap.room.hold = d.hold;
      if (engine) engine.setPlan({
        timeline: d.timeline, hold: !!d.hold, segSec: S.snap.room.segSec, duration: S.snap.room.duration, layers: S.snap.you.layers,
        hp: S.snap.you.hp, lp: S.snap.you.lp, gainDb: S.snap.you.gainDb, trimMs: S.snap.you.trimMs, avOffsetMs: S.snap.room.avOffsetMs, muted: S.snap.you.muted, stereo: false
      });
      report(true);
    };
    link.onClosed = function (reason) {
      S.closed = reason === 'closed_by_host' || reason === 'screen_gone' ? 'The movie night has ended.' : 'The room was closed.';
      S.token = ''; saveSession(); if (engine) engine.stop(); render();
    };
    link.onKicked = function () { S.closed = 'You were removed from the room.'; S.token = ''; saveSession(); if (engine) engine.stop(); render(); };
    link.onAuthLost = function () {
      // the computer forgot us (it restarted, or the room ended): try the saved room again once, as a new guest
      if (S.token) { S.token = ''; saveSession(); doJoin(); }
    };
    link.onState = function () { render(); };
    link.onClock = function () { if (engine) engine.tick(); render(); report(true); };
    if (engine) engine.onChange = function () { render(); report(false); };

    function doJoin() {
      if (!code) { say('This page needs the QR code or link from the movie screen.'); return; }
      var name = nameIn.value.replace(/\s+/g, ' ').trim();
      if (name) { S.name = name; store('beebo.spk.name', name); }
      joinBtn.disabled = true;
      win.fetch('/speakers/api/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'omit', cache: 'no-store',
        body: JSON.stringify({ k: code, name: S.name, token: S.token || undefined, ua: /iPhone|iPad|iPod/.test(win.navigator.userAgent) ? 'ios' : /Android/.test(win.navigator.userAgent) ? 'android' : 'other' }) })
        .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'bad_reply' }; }); })
        .then(function (j) {
          joinBtn.disabled = false;
          if (!j || !j.ok) {
            var msg = { not_found: 'That room has ended, or the link is not right. Ask for the QR code again.', locked: 'Too many wrong tries. Wait a few minutes.', room_full: 'That room is full.', room_locked: 'The host has closed the room to new phones.', rate_limited: 'Slow down a little.' }[j && j.error] || 'Could not join.';
            if (j && (j.error === 'not_found')) { S.token = ''; saveSession(); }
            say(msg);
            S.joined = false; render(); return;
          }
          S.token = j.token; S.joined = true; say(''); saveSession();
          var tr = +stored('beebo.spk.trim') || 0;
          if (tr && !j.resumed) link.post('/tune', { patch: { trimMs: tr } });
          if (S.btDeclared) link.post('/tune', { patch: { bt: true } });
          applySnapshot(j.snapshot);
          link.connect();
          render();
        }, function () { joinBtn.disabled = false; say('Could not reach the computer. Are you on the same Wi-Fi?'); });
    }
    joinBtn.addEventListener('click', function () { doJoin(); });
    nameIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') doJoin(); });
    gate.addEventListener('click', function () {
      if (!engine) return;
      engine.unlock().then(function () { keepAlive(); report(true); render(); });
    });
    ctx && (ctx.onstatechange = function () { if (engine) engine.tick(); render(); report(true); });
    vol.addEventListener('input', function () { var db = +vol.value; link.post('/tune', { patch: { gainDb: db } }); });
    function trim(delta) {
      var cur = S.snap ? S.snap.you.trimMs : 0;
      var next = clamp(cur + delta, -500, 500);
      store('beebo.spk.trim', String(next));
      if (S.snap) { S.snap.you.trimMs = next; if (engine) engine.setPlan({ timeline: S.snap.room.timeline, hold: !!S.snap.room.hold, segSec: S.snap.room.segSec, duration: S.snap.room.duration, layers: S.snap.you.layers, hp: S.snap.you.hp, lp: S.snap.you.lp, gainDb: S.snap.you.gainDb, trimMs: next, avOffsetMs: S.snap.room.avOffsetMs, muted: S.snap.you.muted, stereo: false }); }
      link.post('/tune', { patch: { trimMs: next } });
      render();
    }
    trimMinus.addEventListener('click', function () { trim(-5); });
    trimPlus.addEventListener('click', function () { trim(5); });
    btBox.addEventListener('change', function () { S.btDeclared = btBox.checked; store('beebo.spk.bt', S.btDeclared ? '1' : '0'); link.post('/tune', { patch: { bt: S.btDeclared } }); render(); });
    leaveBtn.addEventListener('click', function () {
      link.post('/leave', {}); link.close(); if (engine) engine.stop();
      S.token = ''; S.joined = false; S.snap = null; saveSession(); S.closed = 'You left the room.'; render();
    });

    // ---- reporting ----
    var lastKey = '', lastAt = 0;
    function report(force) {
      if (!S.token || !S.snap || !engine) return;
      var st = engine.status(link.lastRtt);
      st.visible = !doc.hidden;
      var key = st.state + '|' + st.unlocked + '|' + st.ready + '|' + st.seq + '|' + st.visible;
      var t = Date.now();
      if (!force && key === lastKey && t - lastAt < 3000) return;
      lastKey = key; lastAt = t;
      link.post('/status', { status: st });
    }

    // ---- drawing ----
    function render() {
      var joined = !!S.token && !!S.snap && !S.closed;
      if (S.closed) { joinBox.hidden = true; title.textContent = S.closed; sub.textContent = 'You can close this page.'; [seatBox, syncBox, gate, ctl, beepNote, rosterHead, roster, leaveBtn].forEach(function (e) { e.hidden = true; }); return; }
      if (!joined) {
        title.textContent = 'Turn this phone into a speaker';
        sub.textContent = code ? 'Join the movie night: this phone will play part of the film\'s sound.' : 'Scan the QR code on the movie screen to join.';
        if (!ctx) say('This browser cannot play synced audio. Try Chrome or Safari.');
        joinBox.hidden = !code;
        [seatBox, syncBox, gate, ctl, beepNote, rosterHead, roster, leaveBtn].forEach(function (e) { e.hidden = true; });
        return;
      }
      var d = S.snap;
      title.textContent = d.room.title || 'Movie night';
      sub.textContent = d.room.mode === 'surround' ? 'Surround sound (' + d.room.source + ')' : d.room.mode === 'stereo' ? 'Stereo pair' : 'Everyone plays the whole sound';
      joinBox.hidden = true; seatBox.hidden = false; syncBox.hidden = false; ctl.hidden = false; rosterHead.hidden = false; roster.hidden = false; leaveBtn.hidden = false;
      seatBig.textContent = d.you.seatLabel || 'Waiting for a seat';
      var extra = d.you.layers.length > 1 ? ' + covering a missing speaker' : '';
      seatSmall.textContent = d.you.layers.length ? 'This phone plays the ' + d.you.seatLabel.toLowerCase() + ' channel' + extra + '.' : (d.you.seatLabel === 'Spare' ? 'No channel for this phone right now. The host can give it one.' : 'The host will give this phone a channel.');
      var view = { connected: link.state === 'open', clockReady: link.clock.ready(), errMs: link.clock.errorMs(), driftMs: engine ? engine.driftMs : 0, phase: engine ? engine.phase : 'idle', unlocked: engine ? engine.unlocked : false };
      var lvl = syncLevel(view);
      syncBox.setAttribute('data-level', lvl.level); syncText.textContent = lvl.text; syncDetail.textContent = lvl.detail;
      gate.hidden = !engine || engine.unlocked;
      var bt = bluetoothNote(engine ? engine.outLatencyMs() : -1, S.btDeclared);
      var msg = (engine && engine.note) || bt || (link.state === 'reconnecting' ? 'Lost the connection to the computer. Retrying...' : '');
      say(msg);
      trimVal.textContent = (d.you.trimMs > 0 ? '+' : '') + d.you.trimMs + ' ms';
      vol.value = String(Math.round(d.you.gainDb));
      var b = d.room.beep;
      beepNote.hidden = !b;
      if (b) beepNote.textContent = b.pattern === 'together' ? 'Beep test: every speaker ticks together. It should sound like one tick.' : 'Beep test: each speaker beeps in turn. Listen for yours (' + ((b.slots.filter(function (s) { return s.id === d.you.gid; })[0] || {}).freq || '') + ' Hz).';
      clear(roster);
      d.room.roster.forEach(function (p) {
        var li = h(doc, 'li', 'spk-person');
        var dt = h(doc, 'span', 'spk-dot'); dt.setAttribute('data-level', p.level);
        li.appendChild(dt); li.appendChild(h(doc, 'span', 'spk-pn', p.name)); li.appendChild(h(doc, 'small', 'spk-ps', p.seatLabel));
        roster.appendChild(li);
      });
      line.textContent = d.room.hold ? 'Waiting for ' + (d.room.hold.waitingFor || []).slice(0, 3).join(', ') + '...' : '';
    }

    var tickTimer = win.setInterval(function () { if (engine) { engine.tick(); } render(); report(false); }, 250);
    doc.addEventListener('visibilitychange', function () { if (!doc.hidden) { link.resyncNow(); if (engine) engine.tick(); render(); report(true); if (wake === null && engine && engine.unlocked) keepAlive(); } });
    win.addEventListener('pagehide', function () { void tickTimer; });

    // an earlier visit in this browser: try to rejoin by itself
    if (code && S.token) doJoin();
    render();
    var handle = { link: link, engine: engine, ctx: ctx, state: S };
    api.current = handle; // for the browser checks in docs/PHONE-SPEAKERS.md (same-origin script can reach everything anyway)
    return handle;
  }

  var api = {
    PROTOCOL: PROTOCOL, ClockSync: ClockSync, positionAt: positionAt, isRunning: isRunning, cleanPlan: cleanPlan,
    createSseParser: createSseParser, createLink: createLink, createEngine: createEngine, syncLevel: syncLevel, bluetoothNote: bluetoothNote,
    mountGuest: mountGuest, constants: { LEAD_MS: LEAD_MS, HARD_RESYNC_MS: HARD_RESYNC_MS, ENGAGE_MS: ENGAGE_MS, RELEASE_MS: RELEASE_MS, MAX_NUDGE: MAX_NUDGE, HORIZON_S: HORIZON_S }
  };
  return api;
});
