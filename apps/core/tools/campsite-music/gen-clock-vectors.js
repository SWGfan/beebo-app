// Regenerates apps/core/app/src/test/resources/campsite-clock-vectors.json.
//
// The vectors are synthetic exchanges with a KNOWN true offset (host clock = client clock + trueOffset),
// so both implementations can be checked against the truth as well as against each other. The
// expected numbers come from the JavaScript ClockSync; CampsiteClockSyncTest.kt must reproduce them,
// which is what keeps the two implementations in step.
//
//   node apps/core/tools/campsite-music/gen-clock-vectors.js
'use strict';
const fs = require('fs');
const path = require('path');
const { ClockSync } = require('../../app/src/main/assets/campsite-music.js');

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const r3 = (x) => Math.round(x * 1000) / 1000;

/** One exchange. up/down are the one-way delays in ms; host processing 0.05 ms. */
function exchange(c0, trueOffset, up, down) {
  const t0 = c0, t1 = c0 + up + trueOffset, t2 = t1 + 0.05, t3 = c0 + up + 0.05 + down;
  return [r3(t0), r3(t1), r3(t2), r3(t3)];
}

function burst(seed, n, trueOffset, model) {
  const rnd = mulberry32(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    const [up, down] = model(rnd, i);
    out.push(exchange(100000 + i * 60, trueOffset, up, down));
  }
  return out;
}

const jitter = (rnd, base, spread) => base + (rnd() - 0.5) * 2 * spread;

const scenarios = [
  { name: 'quiet-wifi', trueOffset: 5000.25, samples: burst(1, 24, 5000.25, (r) => [jitter(r, 1.6, 0.6), jitter(r, 1.6, 0.6)]) },
  // 25% of exchanges get a 25-60 ms queueing spike on ONE leg: the classic asymmetric outlier.
  { name: 'bursty-contention', trueOffset: -812.5, samples: burst(2, 30, -812.5, (r, i) => {
      const spike = r() < 0.25 ? 25 + r() * 35 : 0;
      const up = jitter(r, 2.5, 1.0) + (i % 2 ? spike : 0), down = jitter(r, 2.5, 1.0) + (i % 2 ? 0 : spike);
      return [up, down];
    }) },
  // A constant 2 ms extra on the uplink cannot be seen by any RTT-based method: 1 ms of bias remains.
  { name: 'constant-asymmetry', trueOffset: 42.0, samples: burst(3, 20, 42.0, (r) => [jitter(r, 3.0, 0.3), jitter(r, 1.0, 0.3)]) },
  { name: 'slow-radio', trueOffset: 120000.0, samples: burst(4, 20, 120000.0, (r) => [jitter(r, 18, 6), jitter(r, 18, 6)]) },
  { name: 'too-few', trueOffset: 0, samples: burst(5, 4, 0, (r) => [jitter(r, 2, 0.5), jitter(r, 2, 0.5)]) },
  // Junk mixed in: a sample with a negative RTT and one with a 5-second RTT must be ignored.
  { name: 'junk-rejected', trueOffset: 77.0, samples: burst(6, 12, 77.0, (r) => [jitter(r, 2, 0.5), jitter(r, 2, 0.5)])
      .concat([[1000, 1077, 1077.05, 999], [2000, 2077, 2077.05, 7000]]) },
];

const vectors = scenarios.map((s) => ({
  name: s.name, trueOffset: s.trueOffset, samples: s.samples, expect: ClockSync.estimate(s.samples.map(([t0, t1, t2, t3]) => ({ t0, t1, t2, t3 }))),
}));

// ClockFilter: a stable run, then a step (host clock stepped by 500 ms).
const filterInputs = [
  { offsetMs: 100.0, rttMs: 4, errorMs: 1.0 }, { offsetMs: 101.0, rttMs: 5, errorMs: 1.2 },
  { offsetMs: 99.5, rttMs: 4, errorMs: 0.9 }, { offsetMs: 100.4, rttMs: 6, errorMs: 1.5 },
  { offsetMs: 600.0, rttMs: 4, errorMs: 1.0 }, { offsetMs: 601.0, rttMs: 4, errorMs: 1.0 },
];
const f = new ClockSync.ClockFilter();
const filter = filterInputs.map((e) => { f.update(e); return { in: e, offsetMs: f.offsetMs, errorMs: f.errorMs }; });

const target = path.join(__dirname, '..', '..', 'app', 'src', 'test', 'resources', 'campsite-clock-vectors.json');
fs.writeFileSync(target, JSON.stringify({ vectors, filter }, null, 1) + '\n');
console.log('wrote', target);
vectors.forEach((v) => console.log(v.name.padEnd(20), v.expect ? `offset=${v.expect.offsetMs.toFixed(3)} (true ${v.trueOffset}) err=${v.expect.errorMs.toFixed(2)} rtt=${v.expect.rttMs.toFixed(2)} used=${v.expect.used}/${v.expect.total}` : 'null'));
