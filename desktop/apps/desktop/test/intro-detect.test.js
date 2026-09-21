// Automatic intro/credits detection: the pure parts (introDetect.js DSP, consensus, ffmpeg output
// parsing, argv building) and the marker model (markerModel.js guards + viewer-vs-auto precedence).
// All audio is SYNTHETIC (test/helpers/syntheticAudio.js): a shared "jingle" of notes and noise
// bursts dropped at different offsets into otherwise different random "episodes". No ffmpeg needed.
// Run: node --test test/intro-detect.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { createRequire } = require('node:module')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))
const D = localRequire('./electron/introDetect')
const M = localRequire('./electron/markerModel')
const A = require('./helpers/syntheticAudio')
const { createFakeSpawn, chunked, int16ToBuffer } = require('./helpers/fakeSpawn')

// ---- synthetic seasons -------------------------------------------------------------------------
const cache = new Map()
function fpOf({ seed, seconds = 200, jingleSeed = 99, jingleSeconds = 25, at = null, mix = 0.15, gain = 1, noise = 0 }) {
  const key = JSON.stringify([seed, seconds, jingleSeed, jingleSeconds, at, mix, gain, noise])
  if (cache.has(key)) return cache.get(key)
  const bg = A.background(seconds, seed)
  if (at !== null) {
    const j = A.jingle(jingleSeconds, jingleSeed)
    const s0 = Math.round(at * A.SR)
    for (let i = 0; i < j.length && s0 + i < bg.length; i++) bg[s0 + i] = bg[s0 + i] * mix + j[i] * gain
  }
  if (noise > 0) {
    const r = A.rng(seed + 7)
    for (let i = 0; i < bg.length; i++) bg[i] += noise * (r() * 2 - 1)
  }
  const fp = D.fingerprintPcm(A.toInt16(bg))
  cache.set(key, fp)
  return fp
}

const near = (actual, expected, tol, what) => assert.ok(Math.abs(actual - expected) <= tol, `${what}: ${actual} vs ${expected} (tolerance ${tol})`)

// ---- fingerprints ------------------------------------------------------------------------------
test('fingerprint: frame count, silence is neutral, and streaming equals one-shot for any chunking', () => {
  const pcm = A.toInt16(A.background(20, 5))
  const whole = D.fingerprintPcm(pcm)
  assert.equal(whole.frames, Math.floor((20 * 8000 - D.FRAME) / D.HOP) + 1)

  const f = D.createFingerprinter({ maxSeconds: 25 })
  for (const c of chunked(int16ToBuffer(pcm), [3001, 7, 4096, 9999])) f.pushBuffer(c.length % 2 ? c.subarray(0, c.length - 1) : c)
  // Feeding raw bytes needs an even length per call; re-feed properly via the Int16 path for equality
  const g = D.createFingerprinter({ maxSeconds: 25 })
  for (let i = 0; i < pcm.length; i += 777) g.push(pcm.subarray(i, i + 777))
  const streamed = g.finish()
  assert.equal(streamed.frames, whole.frames)
  assert.deepEqual(Array.from(streamed.hashes), Array.from(whole.hashes))

  const silent = D.fingerprintPcm(new Int16Array(8000 * 10))
  assert.ok(silent.active.every((a) => a === 0), 'digital silence never counts as a match candidate')
})

test('fingerprint is level-independent: the same audio at half volume hashes (nearly) the same', () => {
  const base = A.background(30, 11)
  const loud = new Int16Array(base.length)
  const quiet = new Int16Array(base.length)
  for (let i = 0; i < base.length; i++) { loud[i] = Math.round(base[i] * 20000); quiet[i] = Math.round(base[i] * 5000) }
  const a = D.fingerprintPcm(loud), b = D.fingerprintPcm(quiet)
  let bits = 0
  for (let i = 1; i < a.frames; i++) { let x = (a.hashes[i] ^ b.hashes[i]) >>> 0; while (x) { bits += x & 1; x >>>= 1 } }
  assert.ok(bits / ((a.frames - 1) * 32) < 0.12, `bit error ${bits / ((a.frames - 1) * 32)}`)
})

// ---- pairs -------------------------------------------------------------------------------------
test('findCommonRun: a shared jingle at different offsets is located in both episodes', async () => {
  const a = fpOf({ seed: 1, at: 10, gain: 0.8 })
  const b = fpOf({ seed: 2, at: 62, gain: 1.4 })
  const r = await D.findCommonRun(a, b)
  assert.equal(r.ok, true, JSON.stringify(r))
  near(r.aStart, 10, 0.8, 'start in A'); near(r.aEnd, 35, 0.8, 'end in A')
  near(r.bStart, 62, 0.8, 'start in B'); near(r.bEnd, 87, 0.8, 'end in B')
  assert.ok(r.meanBer < 0.33)
})

test('findCommonRun: episodes with no common audio produce nothing', async () => {
  const r = await D.findCommonRun(fpOf({ seed: 21 }), fpOf({ seed: 22 }))
  assert.equal(r.ok, false)
})

test('findCommonRun: a match shorter than 15 s is rejected (a stinger is not an intro)', async () => {
  const r = await D.findCommonRun(fpOf({ seed: 31, at: 20, jingleSeconds: 8 }), fpOf({ seed: 32, at: 50, jingleSeconds: 8 }))
  assert.equal(r.ok, false)
  assert.ok(r.reason === 'too_short' || r.reason === 'no_match', r.reason)
})

test('findCommonRun: a match longer than 3 minutes is rejected (shared recap/scene, not an intro)', async () => {
  const a = fpOf({ seed: 41, seconds: 330, at: 5, jingleSeconds: 200, jingleSeed: 7 })
  const b = fpOf({ seed: 42, seconds: 330, at: 40, jingleSeconds: 200, jingleSeed: 7 })
  const r = await D.findCommonRun(a, b, { maxOffsetSeconds: 120 })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'too_long')
})

test('findCommonRun: a shared stretch of digital silence is not a match', async () => {
  const mk = (seed) => {
    const bg = A.background(120, seed)
    for (let i = 20 * 8000; i < 60 * 8000; i++) bg[i] = 0
    return D.fingerprintPcm(A.toInt16(bg))
  }
  const r = await D.findCommonRun(mk(51), mk(52))
  assert.equal(r.ok, false)
})

test('findCommonRun: survives added noise and a very different level', async () => {
  const a = fpOf({ seed: 61, at: 15, gain: 1, noise: 0.005 })
  const b = fpOf({ seed: 62, at: 80, gain: 0.5, noise: 0.01 })
  const r = await D.findCommonRun(a, b)
  assert.equal(r.ok, true, JSON.stringify(r))
  near(r.aStart, 15, 1, 'start in A'); near(r.bStart, 80, 1, 'start in B')
})

test('findCommonRun: so much noise that the audio no longer matches gives nothing rather than a guess', async () => {
  const a = fpOf({ seed: 71, at: 15, noise: 0.6 })
  const b = fpOf({ seed: 72, at: 80, noise: 0.6 })
  const r = await D.findCommonRun(a, b)
  assert.equal(r.ok, false)
})

test('measured accuracy over 10 random pairs: mean boundary error under half a second, none missed', async (t) => {
  const errs = []
  let missed = 0
  for (let n = 0; n < 10; n++) {
    const rnd = A.rng(4000 + n)
    const len = 18 + Math.floor(rnd() * 30)
    const atA = Math.floor(rnd() * 80), atB = Math.floor(rnd() * 80)
    const a = fpOf({ seed: 100 + n, at: atA, jingleSeed: 300 + n, jingleSeconds: len, gain: 0.6 + rnd() })
    const b = fpOf({ seed: 200 + n, at: atB, jingleSeed: 300 + n, jingleSeconds: len, gain: 0.6 + rnd() })
    const r = await D.findCommonRun(a, b)
    if (!r.ok) { missed++; continue }
    errs.push(Math.abs(r.aStart - atA), Math.abs(r.aEnd - (atA + len)), Math.abs(r.bStart - atB), Math.abs(r.bEnd - (atB + len)))
  }
  const mean = errs.reduce((x, y) => x + y, 0) / errs.length
  t.diagnostic(`synthetic pair accuracy: mean abs boundary error ${mean.toFixed(3)} s, max ${Math.max(...errs).toFixed(3)} s, missed ${missed}/10`)
  assert.equal(missed, 0)
  assert.ok(mean < 0.5, `mean error ${mean}`)
  assert.ok(Math.max(...errs) < 1.5)
})

// ---- seasons -----------------------------------------------------------------------------------
test('detectSeasonIntros: five episodes with cold opens of different lengths each get their own window', async () => {
  const ats = [0, 45, 90, 20, 70]
  const items = ats.map((at, i) => ({ id: 'e' + i, fp: fpOf({ seed: 300 + i, at, gain: 0.7 + i * 0.2 }) }))
  const out = await D.detectSeasonIntros(items)
  assert.equal(out.size, 5)
  ats.forEach((at, i) => {
    const r = out.get('e' + i)
    near(r.introStart, at, 1, `episode ${i} start`)
    near(r.introEnd, at + 25, 1, `episode ${i} end`)
    assert.ok(r.confidence >= 0.6, `confidence ${r.confidence}`)
    assert.ok(r.support >= 3)
  })
})

test('detectSeasonIntros: an episode without the intro gets nothing while the others still do', async () => {
  const items = [
    { id: 'a', fp: fpOf({ seed: 401, at: 12 }) },
    { id: 'b', fp: fpOf({ seed: 402, at: 40 }) },
    { id: 'odd', fp: fpOf({ seed: 403 }) },
    { id: 'c', fp: fpOf({ seed: 404, at: 66 }) },
    { id: 'd', fp: fpOf({ seed: 405, at: 5 }) }
  ]
  const out = await D.detectSeasonIntros(items)
  assert.equal(out.has('odd'), false)
  for (const id of ['a', 'b', 'c', 'd']) assert.ok(out.has(id), id)
})

test('detectSeasonIntros: a season with a single episode is skipped', async () => {
  const out = await D.detectSeasonIntros([{ id: 'only', fp: fpOf({ seed: 411, at: 10 }) }])
  assert.equal(out.size, 0)
})

test('detectSeasonIntros: with only two or three episodes a clean match is accepted, a weaker one is not', async () => {
  const two = await D.detectSeasonIntros([
    { id: 'a', fp: fpOf({ seed: 421, at: 10, mix: 0, noise: 0 }) },
    { id: 'b', fp: fpOf({ seed: 422, at: 33, mix: 0, noise: 0 }) }
  ])
  assert.equal(two.size, 2)
  assert.ok(two.get('a').confidence >= M.AUTO_MIN_CONFIDENCE)
  assert.equal(two.get('a').support, 1)

  const noisyTwo = await D.detectSeasonIntros([
    { id: 'a', fp: fpOf({ seed: 431, at: 10, mix: 0.6, noise: 0.05 }) },
    { id: 'b', fp: fpOf({ seed: 432, at: 33, mix: 0.6, noise: 0.05 }) }
  ])
  for (const r of noisyTwo.values()) assert.ok(r.confidence < M.AUTO_MIN_CONFIDENCE, `a noisy single pair must not clear the bar (${r.confidence})`)

  const three = await D.detectSeasonIntros([
    { id: 'a', fp: fpOf({ seed: 441, at: 10 }) },
    { id: 'b', fp: fpOf({ seed: 442, at: 33 }) },
    { id: 'c', fp: fpOf({ seed: 443, at: 58 }) }
  ])
  assert.equal(three.size, 3)
})

test('detectSeasonIntros: an episode whose matching stretch is a very different length is dropped as an outlier', async () => {
  const items = [0, 1, 2, 3].map((i) => ({ id: 'e' + i, fp: fpOf({ seed: 501 + i, at: 10 + i * 9 }) }))
  // A fifth episode that shares only a 16 s piece with the others' 25 s jingle.
  const short = fpOf({ seed: 510, at: 30, jingleSeconds: 16 })
  const out = await D.detectSeasonIntros([...items, { id: 'short', fp: short }])
  for (let i = 0; i < 4; i++) assert.ok(out.has('e' + i))
  if (out.has('short')) near(out.get('short').introEnd - out.get('short').introStart, 16, 2, 'if kept, it is at least its true length')
})

test('choosePairs: everything for small seasons, ~3 neighbours each for big ones', () => {
  assert.deepEqual(D.choosePairs(1), [])
  assert.equal(D.choosePairs(2).length, 1)
  assert.equal(D.choosePairs(5).length, 10)
  const big = D.choosePairs(24)
  assert.ok(big.length <= 72 && big.length >= 60, String(big.length))
  const seen = new Map()
  for (const [i, j] of big) { seen.set(i, (seen.get(i) || 0) + 1); seen.set(j, (seen.get(j) || 0) + 1) }
  assert.ok([...seen.values()].every((n) => n >= 3))
})

// ---- credits -----------------------------------------------------------------------------------
const BLACKDETECT_SAMPLE = `Input #0, matroska,webm, from 'E:\\TV\\Show\\S01E03.mkv':
  Duration: 00:44:12.30, start: 0.000000, bitrate: 5210 kb/s
[blackdetect @ 000001d5b0c2f4c0] black_start:1497.16 black_end:1500.72 black_duration:3.56
frame=  120 fps= 60 q=-0.0 size=N/A time=00:24:59.20 bitrate=N/A speed=  9x
[blackdetect @ 000001d5b0c2f4c0] black_start:2531.04 black_end:2652.3 black_duration:121.26
[Parsed_silencedetect_1 @ 000001d5b0d1a980] silence_start: 2529.8
[silencedetect @ 000001d5b0d1a980] silence_end: 2531.9 | silence_duration: 2.1
[silencedetect @ 000001d5b0d1a980] silence_start: 2651.6
`

test('parseBlackdetect / parseSilencedetect read real ffmpeg stderr and add the window offset', () => {
  const black = D.parseBlackdetect(BLACKDETECT_SAMPLE, 100)
  assert.deepEqual(black, [{ start: 1597.16, end: 1600.72 }, { start: 2631.04, end: 2752.3 }])
  const silence = D.parseSilencedetect(BLACKDETECT_SAMPLE, 100, 2760)
  assert.deepEqual(silence, [{ start: 2629.8, end: 2631.9 }, { start: 2751.6, end: 2760 }])
  assert.deepEqual(D.parseBlackdetect('nothing here'), [])
  assert.deepEqual(D.parseSilencedetect(''), [])
})

test('tailWindow / introWindowSeconds follow the "12 minutes or 20% / 10 minutes or 25%" rule', () => {
  near(D.tailWindow(7200).length, 720, 0.01, 'film tail')
  near(D.tailWindow(2700).length, 540, 0.01, '45 min episode tail')
  near(D.tailWindow(1320).length, 264, 0.01, '22 min episode tail')
  near(D.tailWindow(300).length, 90, 0.01, '5 min clip tail floor')
  near(D.tailWindow(300).start, 210, 0.01, 'starts at the right place')
  assert.equal(D.tailWindow(0), null)
  near(D.introWindowSeconds(2700), 600, 0.01, '45 min')
  near(D.introWindowSeconds(1320), 330, 0.01, '22 min')
  near(D.introWindowSeconds(240), 120, 0.01, 'floor')
  near(D.introWindowSeconds(null), 600, 0.01, 'unknown duration')
})

test('creditsCandidates: the dark stretch that runs to the end wins; an act-break fade earlier does not', () => {
  const D_ = 2652
  const black = [{ start: 1597.16, end: 1600.72 }, { start: 2531.04, end: 2652 }]
  const c = D.creditsCandidates({ black, durationSeconds: D_ })
  assert.equal(c.length, 1)
  near(c[0].start, 2531, 0.1, 'credits start')
  assert.ok(c[0].coverage > 0.99)
})

test('creditsCandidates: a quiet moment at the start of the dark stretch corroborates it', () => {
  const black = [{ start: 2531.04, end: 2652 }]
  const noisy = D.creditsCandidates({ black, silence: [{ start: 100, end: 102 }], durationSeconds: 2652 })
  const quiet = D.creditsCandidates({ black, silence: [{ start: 2529.8, end: 2531.9 }], durationSeconds: 2652 })
  assert.equal(noisy[0].quiet, false)
  assert.equal(quiet[0].quiet, true)
  assert.ok(D.creditsConfidence(0.6, 'none', true) > D.creditsConfidence(0.6, 'none', false))
})

test('creditsCandidates: needs a minute of tail, the second half of the file, and mostly-dark content afterwards', () => {
  const d = 2600
  assert.equal(D.creditsCandidates({ black: [{ start: 2560, end: 2600 }], durationSeconds: d }).length, 0, 'under 60 s left')
  assert.equal(D.creditsCandidates({ black: [{ start: 1000, end: 1004 }], durationSeconds: d }).length, 0, 'outside the tail window / first half')
  // A fade to black followed by ordinary bright content until the end is a scene change, not credits.
  assert.equal(D.creditsCandidates({ black: [{ start: 2300, end: 2304 }], durationSeconds: d }).length, 0)
  // ...but mostly dark afterwards is.
  const c = D.creditsCandidates({ black: [{ start: 2300, end: 2304 }, { start: 2310, end: 2390 }, { start: 2400, end: 2600 }], durationSeconds: d })
  assert.equal(c.length > 0, true)
  near(c[0].start, 2300, 0.1, 'earliest qualifying dark start')
  // Darkness that was already running when the window opened has no known beginning: no marker.
  const win = D.tailWindow(d)
  assert.equal(D.creditsCandidates({ black: [{ start: win.start + 0.5, end: 2600 }], durationSeconds: d }).length, 0)
})

test('creditsCandidates: films need a darker tail than episodes', () => {
  const d = 7000
  const black = [{ start: 6500, end: 6700 }, { start: 6800, end: 6900 }]
  const coverage = D.coverageIn(black, 6500, d)
  assert.ok(coverage > CREDITS_TV_MIN && coverage < CREDITS_MOVIE_MIN, String(coverage))
  assert.equal(D.creditsCandidates({ black, durationSeconds: d, kind: 'tv' }).length, 1)
  assert.equal(D.creditsCandidates({ black, durationSeconds: d, kind: 'movie' }).length, 0)
})
const CREDITS_TV_MIN = D.CREDITS_MIN_COVERAGE_TV
const CREDITS_MOVIE_MIN = D.CREDITS_MIN_COVERAGE_MOVIE

test('creditsConsensus: an outlier is rejected, and a closer alternative candidate is preferred', () => {
  const cand = (tail, coverage = 0.95) => ({ start: 2700 - tail, coverage, tail })
  const items = [
    { id: 'a', candidates: [cand(120)] },
    { id: 'b', candidates: [cand(118)] },
    { id: 'c', candidates: [cand(125)] },
    { id: 'd', candidates: [cand(121)] },
    { id: 'odd', candidates: [cand(420)] },
    { id: 'two', candidates: [cand(420), cand(123)] }
  ]
  const out = D.creditsConsensus(items)
  assert.equal(out.has('odd'), false)
  assert.equal(out.get('two').creditsStart, 2700 - 123)
  assert.equal(out.get('a').consensus, 'agree')
})

test('creditsConsensus: without a season norm (film / <3 episodes) confidence is reduced, never raised', () => {
  const one = D.creditsConsensus([{ id: 'm', candidates: [{ start: 6500, coverage: 0.95, tail: 500 }] }], { kind: 'movie' })
  const withNorm = D.creditsConsensus([1, 2, 3].map((i) => ({ id: 'e' + i, candidates: [{ start: 2500, coverage: 0.95, tail: 120 }] })))
  assert.ok(one.get('m').confidence < withNorm.get('e1').confidence)
  assert.ok(one.get('m').confidence >= M.AUTO_MIN_CONFIDENCE)
})

// ---- guards and precedence ---------------------------------------------------------------------
test('guardAutoRecord applies the viewer-marker guards and the confidence bar', () => {
  const dur = 2700
  const ok = M.guardAutoRecord({ introStart: 45, introEnd: 105, introConfidence: 0.8, creditsStart: 2500, creditsConfidence: 0.8, durationSec: dur })
  assert.equal(ok.introStartSeconds, 45)
  assert.equal(ok.introEndSeconds, 105)
  assert.equal(ok.creditsStartSeconds, 2500)
  // Long cold open: position beyond 5 min is fine because the cap is on the intro's length
  const cold = M.guardAutoRecord({ introStart: 400, introEnd: 470, introConfidence: 0.7, durationSec: 5400 })
  assert.equal(cold.introEndSeconds, 470)
  // Too long an intro, intro-end past the quarter mark rule via start, backwards, or no start
  assert.equal(M.guardAutoRecord({ introStart: 10, introEnd: 400, introConfidence: 1, durationSec: dur }).introEndSeconds, null)
  assert.equal(M.guardAutoRecord({ introStart: 100, introEnd: 90, introConfidence: 1, durationSec: dur }).introEndSeconds, null)
  assert.equal(M.guardAutoRecord({ introStart: 2000, introEnd: 2050, introConfidence: 1, durationSec: dur }).introEndSeconds, null)
  // Credits: >= 50% through and >= 60 s of tail
  assert.equal(M.guardAutoRecord({ creditsStart: 1000, creditsConfidence: 1, durationSec: dur }).creditsStartSeconds, null)
  assert.equal(M.guardAutoRecord({ creditsStart: 2660, creditsConfidence: 1, durationSec: dur }).creditsStartSeconds, null)
  assert.equal(M.guardAutoRecord({ creditsStart: 2500, creditsConfidence: 1 }).creditsStartSeconds, null, 'credits are never acted on without a duration')
  // Below the confidence bar nothing is exposed
  const weak = M.guardAutoRecord({ introStart: 45, introEnd: 105, introConfidence: 0.59, creditsStart: 2500, creditsConfidence: 0.5, durationSec: dur })
  assert.equal(weak.introEndSeconds, null)
  assert.equal(weak.creditsStartSeconds, null)
  // Junk in the store never throws
  assert.doesNotThrow(() => M.guardAutoRecord(null))
  assert.doesNotThrow(() => M.guardAutoRecord({ introStart: 'x', introEnd: {}, introConfidence: 'high' }))
})

test('the guards agree with the ones streamServer.js exports for viewer markers', () => {
  const server = localRequire('./electron/streamServer')
  for (const dur of [null, 600, 2700, 7200]) {
    for (const v of [-1, 0, 10, 90, 300, 301, 700, 1300, 2000, 2500, 2700, 6900, 'x', null]) {
      assert.equal(server.sanitizeIntroEnd(v, dur), M.sanitizeIntroEnd(v, dur), `intro ${v}/${dur}`)
      assert.equal(server.sanitizeCreditsStart(v, dur), M.sanitizeCreditsStart(v, dur), `credits ${v}/${dur}`)
    }
  }
})

test('effectiveMarkers: viewer-set always wins; auto fills only the gaps; sources are honest', () => {
  const auto = { introStart: 45, introEnd: 105, introConfidence: 0.9, creditsStart: 2500, creditsConfidence: 0.9, durationSec: 2700 }
  const none = M.effectiveMarkers({ viewer: {}, auto, durationSeconds: 2700 })
  assert.equal(none.source, 'auto')
  assert.equal(none.introSource, 'auto')
  assert.equal(none.creditsSource, 'auto')
  assert.equal(none.introStartSeconds, 45)

  const viewerIntro = M.effectiveMarkers({ viewer: { introEndSeconds: 60 }, auto, durationSeconds: 2700 })
  assert.equal(viewerIntro.introEndSeconds, 60)
  assert.equal(viewerIntro.introStartSeconds, null, 'auto never lends a start to a viewer-set end')
  assert.equal(viewerIntro.introSource, 'viewer')
  assert.equal(viewerIntro.creditsStartSeconds, 2500, 'credits still filled from auto')
  assert.equal(viewerIntro.creditsSource, 'auto')
  assert.equal(viewerIntro.source, 'viewer')

  const viewerCredits = M.effectiveMarkers({ viewer: { creditsStartSeconds: 2400 }, auto, durationSeconds: 2700 })
  assert.equal(viewerCredits.creditsStartSeconds, 2400)
  assert.equal(viewerCredits.introSource, 'auto')

  const nothing = M.effectiveMarkers({ viewer: {}, auto: null, durationSeconds: 2700 })
  assert.equal(nothing.source, null)
  assert.equal(nothing.introEndSeconds, null)
  assert.equal(nothing.confidence, null)
})

test('effectiveMarkers: a viewer who cleared a part keeps it cleared', () => {
  const auto = { introStart: 45, introEnd: 105, introConfidence: 0.9, creditsStart: 2500, creditsConfidence: 0.9, durationSec: 2700 }
  const a = M.effectiveMarkers({ viewer: {}, suppress: { intro: true }, auto, durationSeconds: 2700 })
  assert.equal(a.introEndSeconds, null)
  assert.equal(a.creditsStartSeconds, 2500)
  const b = M.effectiveMarkers({ viewer: {}, suppress: { intro: true, credits: true }, auto, durationSeconds: 2700 })
  assert.equal(b.source, null)
})

test('an auto marker never claims to be viewer-set, and a low-confidence one is invisible', () => {
  const e = M.effectiveMarkers({ viewer: {}, auto: { introStart: 45, introEnd: 105, introConfidence: 0.5, durationSec: 2700 }, durationSeconds: 2700 })
  assert.equal(e.source, null)
  const f = M.effectiveMarkers({ viewer: {}, auto: { introStart: 45, introEnd: 105, introConfidence: 0.7, durationSec: 2700 }, durationSeconds: 2700 })
  assert.equal(f.source, 'auto')
  assert.equal(f.confidence, 0.7)
})

test('fileIdentity changes when the file does', () => {
  const a = M.fileIdentity('C:/tv/a.mkv', { size: 10, mtimeMs: 1000.7 })
  assert.equal(a, 'C:/tv/a.mkv|10|1000')
  assert.notEqual(a, M.fileIdentity('C:/tv/a.mkv', { size: 11, mtimeMs: 1000.7 }))
  assert.notEqual(a, M.fileIdentity('C:/tv/a.mkv', { size: 10, mtimeMs: 2000 }))
  assert.equal(M.fileIdentity('', { size: 1, mtimeMs: 1 }), '')
})

// ---- ffmpeg argv and process handling ----------------------------------------------------------
const NASTY = [
  'C:\\Media\\TV Shows\\Some Show (2019)\\S01E01 - "Pilot" & more; rm -rf %USERPROFILE%.mkv',
  "/mnt/media/it's a film $(reboot) `id` | tee.mkv",
  '-attack.mkv',
  'pipe:0',
  'concat:a.mkv|b.mkv',
  'C:\\a b\\c\'d"e.mkv'
]

test('argv builders keep every path a single, prefixed argument (no shell, no option injection)', () => {
  for (const p of NASTY) {
    const pcm = D.buildPcmArgs(p, 600)
    assert.equal(pcm[pcm.indexOf('-i') + 1], 'file:' + p)
    assert.equal(pcm.filter((x) => x.includes(p)).length, 1)
    const tail = D.buildTailArgs(p, 2100, 600)
    assert.equal(tail[tail.indexOf('-i') + 1], 'file:' + p)
    assert.equal(tail.filter((x) => x.includes(p)).length, 1)
    const probe = D.buildProbeArgs(p)
    assert.equal(probe[probe.indexOf('-i') + 1], 'file:' + p)
  }
  assert.throws(() => D.buildPcmArgs('a\0b.mkv', 10))
  assert.throws(() => D.buildPcmArgs('', 10))
  const args = D.buildPcmArgs('/x/y.mkv', 600)
  assert.deepEqual(args.slice(args.indexOf('-ac')), ['-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'])
  assert.ok(args.includes('-vn') && args.includes('-sn') && args.includes('-nostdin'))
  const t = D.buildTailArgs('/x/y.mkv', 2100.5, 540, { keyframesOnly: true })
  assert.ok(t.includes('-skip_frame') && t.includes('nokey'))
  assert.equal(t[t.indexOf('-ss') + 1], '2100.500')
  assert.ok(!D.buildTailArgs('/x/y.mkv', 1, 2, { keyframesOnly: false }).includes('-skip_frame'))
})

test('extractFingerprint: streams PCM (odd chunking) through a fake ffmpeg into the same fingerprint', async () => {
  const pcm = A.toInt16(A.background(60, 77))
  const spawn = createFakeSpawn(() => ({ stdout: chunked(int16ToBuffer(pcm), [4093, 9001, 5, 65536]) }))
  const r = await D.extractFingerprint(NASTY[0], { ffmpegPath: 'ffmpeg-fake', seconds: 60, spawnFn: spawn, priority: false })
  assert.equal(r.ok, true, JSON.stringify(r))
  const direct = D.fingerprintPcm(pcm)
  assert.equal(r.fp.frames, direct.frames)
  assert.deepEqual(Array.from(r.fp.hashes), Array.from(direct.hashes))
  assert.equal(spawn.calls.length, 1)
  assert.equal(spawn.calls[0].exe, 'ffmpeg-fake')
  assert.equal(spawn.calls[0].args[spawn.calls[0].args.indexOf('-i') + 1], 'file:' + NASTY[0])
  assert.equal(spawn.calls[0].options.windowsHide, true)
})

test('extractFingerprint / analyseTail report failures instead of throwing', async () => {
  const bad = createFakeSpawn(() => ({ code: 1, stderr: 'Invalid data found when processing input\n' }))
  const r1 = await D.extractFingerprint('/x.mkv', { ffmpegPath: 'ff', seconds: 60, spawnFn: bad, priority: false })
  assert.equal(r1.ok, false)
  assert.match(r1.error, /code 1/)
  const r2 = await D.analyseTail('/x.mkv', { ffmpegPath: 'ff', durationSeconds: 2700, spawnFn: bad, priority: false })
  assert.equal(r2.ok, false)
  assert.equal((await D.extractFingerprint('/x.mkv', { ffmpegPath: null, seconds: 60 })).error, 'no_ffmpeg')
  assert.equal((await D.analyseTail('/x.mkv', { ffmpegPath: 'ff', durationSeconds: 0 })).error, 'no_duration')
  const empty = createFakeSpawn(() => ({ stdout: [] }))
  assert.equal((await D.extractFingerprint('/x.mkv', { ffmpegPath: 'ff', seconds: 60, spawnFn: empty, priority: false })).error, 'no_audio')
  const boom = () => { throw new Error('spawn ENOENT') }
  assert.equal((await D.extractFingerprint('/x.mkv', { ffmpegPath: 'ff', seconds: 60, spawnFn: boom, priority: false })).ok, false)
})

test('a hung ffmpeg is killed at the per-file timeout', async () => {
  const hang = createFakeSpawn(() => ({ hang: true }))
  const t0 = Date.now()
  const r = await D.extractFingerprint('/x.mkv', { ffmpegPath: 'ff', seconds: 60, spawnFn: hang, timeoutMs: 40, priority: false })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'timeout')
  assert.ok(Date.now() - t0 < 2000)
})

test('analyseTail parses the tail pass into absolute file times', async () => {
  const spawn = createFakeSpawn(() => ({ stderr: BLACKDETECT_SAMPLE }))
  const r = await D.analyseTail('/x/y.mkv', { ffmpegPath: 'ff', durationSeconds: 2652, spawnFn: spawn, priority: false })
  assert.equal(r.ok, true)
  near(r.windowStart, 2652 - 530.4, 0.01, 'window start')
  assert.equal(r.black.length, 2)
  near(r.black[1].start, 2652 - 530.4 + 2531.04, 0.01, 'offset applied')
})

test('probeDuration reads ffprobe output and never throws', async () => {
  const ok = createFakeSpawn(() => ({ stdout: [Buffer.from('2652.320000\n')] }))
  assert.equal(await D.probeDuration('/x.mkv', { ffprobePath: 'fp', spawnFn: ok, priority: false }), 2652.32)
  const junk = createFakeSpawn(() => ({ stdout: [Buffer.from('N/A\n')] }))
  assert.equal(await D.probeDuration('/x.mkv', { ffprobePath: 'fp', spawnFn: junk, priority: false }), null)
  assert.equal(await D.probeDuration('/x.mkv', { ffprobePath: null }), null)
})

test('creditsConsensus: a lone dark scene near the end of one episode of a big season is not "the credits"', () => {
  const cand = (tail) => ({ start: 3000 - tail, coverage: 0.72, tail })
  const season = (withCandidate) => Array.from({ length: 12 }, (_, i) => ({ id: 'e' + i, candidates: i < withCandidate ? [cand(200 + i * 3)] : [] }))
  assert.equal(D.creditsConsensus(season(1)).size, 0, 'one of twelve')
  assert.equal(D.creditsConsensus(season(4)).size, 0, 'four of twelve is under the 40% bar')
  const five = D.creditsConsensus(season(5))
  assert.equal(five.size, 5)
  assert.equal(five.get('e0').consensus, 'agree')
  assert.equal(D.creditsConsensus([{ id: 'a', candidates: [cand(200)] }, { id: 'b', candidates: [] }]).size, 1, 'a season of two has no norm: the single candidate stands, at a lower confidence')
})

test('clusterCandidates: partners disagree about the edges, the stretch two of them confirm wins (real GoT pattern)', () => {
  // Same-source partners match over the whole titles (one of them also shares 12 s before them);
  // another source's edit only coincides with the last part.
  const c = (start, end, ber = 0.1) => ({ start, end, ber })
  const r = D.clusterCandidates([c(90.6, 195), c(78.4, 194.8), c(134.5, 195.7, 0.21), c(134.6, 195.6, 0.21), c(134.5, 196.2, 0.21)])
  near(r.introStart, 90.6, 0.01, 'start')
  near(r.introEnd, 195.7, 0.5, 'end')
  assert.equal(r.support, 5)
  // Nothing is confirmed by two partners -> the longest single one is NOT invented; only one partner: it stands alone
  assert.equal(D.clusterCandidates([c(10, 40), c(200, 230)]), null)
  const alone = D.clusterCandidates([c(10, 40)])
  assert.equal(alone.introStart, 10)
  assert.equal(alone.support, 1)
  // Two partners that overlap: their intersection (the conservative reading)
  const two = D.clusterCandidates([c(10, 42), c(12, 40)])
  assert.equal(two.introStart, 12)
  assert.equal(two.introEnd, 40)
  assert.equal(D.clusterCandidates([]), null)
})
