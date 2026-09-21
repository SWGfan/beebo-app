'use strict'
// ============================================================================
// introDetect.js - finds where a TV episode's INTRO starts/ends and where the END
// CREDITS start (also credits for films), entirely on this computer.
// ----------------------------------------------------------------------------
// INTRO: an opening title sequence is the same audio in every episode of a season,
// so it is found by comparing episodes with each other rather than by "listening
// for music". Each episode's first ~10 minutes are decoded by the bundled ffmpeg to
// mono 8 kHz PCM and turned into a compact fingerprint (one 32-bit hash per 64 ms:
// which of 32 log-spaced bands are spectral peaks - level- and EQ-independent, so it
// survives a different encode of the same audio). Two episodes are then slid against
// each other; the best contiguous run of matching frames is the shared audio. Each
// episode is compared with several others and only the stretch at least two of them
// confirm is kept, so a cold open (intro starting at a different time in each episode)
// is handled and one odd episode cannot invent an intro.
//   - No native dependency: the FFT and the hashing are plain JS. ffmpeg's own
//     chromaprint muxer is not relied on: it exists in full/GPL builds but not in the
//     LGPL build this app ships.
//   - Bounded memory: PCM is consumed as it streams out of ffmpeg; only the 4-byte
//     hashes (and a 1-byte "not silent" flag) are kept, ~45 KB per 10 minutes.
// CREDITS: only the tail is looked at (last ~12 min, or 20% of a short item). ffmpeg's
// blackdetect + silencedetect report where the picture goes dark; the credits start
// where a dark stretch begins AND the rest of the file is mostly dark, and a season's
// episodes must agree on how far from the end that is. Nothing confident -> nothing.
// This file is pure DSP + parsing + argv building; scheduling lives in
// introDetectJob.js and the guards/precedence in markerModel.js.
// ============================================================================

const { spawn } = require('child_process')
const os = require('os')

const DETECTOR_VERSION = 1

const SAMPLE_RATE = 8000
const FRAME = 4096
const HOP = 512
const HOP_SEC = HOP / SAMPLE_RATE
const FRAME_SEC = FRAME / SAMPLE_RATE
const NUM_BANDS = 33
const BAND_LOW_HZ = 150
const BAND_HIGH_HZ = 3800
// A band is a "peak" when it is louder than the mean of the bands within this many steps of it.
const PEAK_RADIUS = 3
// Below about -66 dBFS a frame is "silent": its hash is noise, so it is neutral, never a match.
const SILENCE_RMS = 0.0005

const MIN_INTRO_SECONDS = 15
const MAX_INTRO_SECONDS = 180
const MAX_OFFSET_SECONDS = 300
// A frame differing in fewer than this many of 32 bits pulls a run up; more pulls it down.
// Random content differs in ~16, so unrelated audio never accumulates a run.
const FRAME_GAIN_PIVOT = 12
const MATCH_BITS = 12
const MAX_RUN_BER = 0.33
const MIN_MATCH_FRACTION = 0.65

// A frame's hash reads its own window AND the previous one, and a frame only counts once it is
// mostly inside the shared audio, so the raw run edges sit a little inside the true ones.
// Measured on the synthetic sets in test/intro-detect.test.js (see there); seconds.
const START_BIAS = 0.4
const END_BIAS = 0.1

const INTRO_WINDOW_MIN_SECONDS = 120
const INTRO_WINDOW_MAX_SECONDS = 600
const INTRO_WINDOW_FRACTION = 0.25
const TAIL_WINDOW_MAX_SECONDS = 720
const TAIL_WINDOW_MIN_SECONDS = 90
const TAIL_WINDOW_FRACTION = 0.2

// ------------------------------------------------------------------ FFT
function makeFft(n) {
  const levels = Math.round(Math.log2(n))
  const rev = new Uint16Array(n)
  for (let i = 0; i < n; i++) {
    let r = 0
    let x = i
    for (let b = 0; b < levels; b++) { r = (r << 1) | (x & 1); x >>= 1 }
    rev[i] = r
  }
  const cos = new Float64Array(n / 2)
  const sin = new Float64Array(n / 2)
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((-2 * Math.PI * i) / n)
    sin[i] = Math.sin((-2 * Math.PI * i) / n)
  }
  return function fft(re, im) {
    for (let i = 0; i < n; i++) {
      const j = rev[i]
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t
        t = im[i]; im[i] = im[j]; im[j] = t
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1
      const step = n / size
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = i + j
          const b = a + half
          const tr = re[b] * cos[k] - im[b] * sin[k]
          const ti = re[b] * sin[k] + im[b] * cos[k]
          re[b] = re[a] - tr
          im[b] = im[a] - ti
          re[a] += tr
          im[a] += ti
        }
      }
    }
  }
}

const FFT = makeFft(FRAME)
const HANN = (() => {
  const w = new Float64Array(FRAME)
  for (let i = 0; i < FRAME; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1))
  return w
})()
const BAND_EDGES = (() => {
  const binHz = SAMPLE_RATE / FRAME
  const e = new Int32Array(NUM_BANDS + 1)
  let prev = -1
  for (let m = 0; m <= NUM_BANDS; m++) {
    let b = Math.round((BAND_LOW_HZ * Math.pow(BAND_HIGH_HZ / BAND_LOW_HZ, m / NUM_BANDS)) / binHz)
    if (b <= prev) b = prev + 1
    e[m] = b
    prev = b
  }
  return e
})()
const POP = (() => {
  const t = new Uint8Array(65536)
  for (let i = 1; i < 65536; i++) t[i] = t[i >> 1] + (i & 1)
  return t
})()

// ---------------------------------------------------------- fingerprinting
// Streaming: push() any number of 16-bit mono PCM chunks, then finish(). Two real frames share one
// complex FFT (frame A in the real part, frame B in the imaginary), which halves the cost.
function createFingerprinter({ maxSeconds = 900 } = {}) {
  let cap = Math.ceil((maxSeconds * SAMPLE_RATE) / HOP) + 8
  let hashes = new Int32Array(cap)
  let active = new Uint8Array(cap)
  let frames = 0
  let samples = 0
  const buf = new Float32Array(FRAME * 2)
  let len = 0
  const re = new Float64Array(FRAME)
  const im = new Float64Array(FRAME)
  let slot = 0
  const rms = [0, 0]
  const bandCur = new Float64Array(NUM_BANDS)

  function store(h, act) {
    if (frames >= cap) {
      cap *= 2
      const nh = new Int32Array(cap); nh.set(hashes); hashes = nh
      const na = new Uint8Array(cap); na.set(active); active = na
    }
    hashes[frames] = h | 0
    active[frames] = act ? 1 : 0
    frames++
  }

  function flush(count) {
    if (count === 1) im.fill(0)
    FFT(re, im)
    for (let f = 0; f < count; f++) {
      for (let m = 0; m < NUM_BANDS; m++) {
        let s = 0
        for (let k = BAND_EDGES[m]; k < BAND_EDGES[m + 1]; k++) {
          const j = (FRAME - k) & (FRAME - 1)
          let p
          if (f === 0) {
            const xr = (re[k] + re[j]) * 0.5
            const xi = (im[k] - im[j]) * 0.5
            p = xr * xr + xi * xi
          } else {
            const yr = (im[k] + im[j]) * 0.5
            const yi = (re[j] - re[k]) * 0.5
            p = yr * yr + yi * yi
          }
          s += p
        }
        bandCur[m] = Math.log(s + 1e-12)
      }
      // 32 bits: is band m a spectral peak of THIS frame (louder than the mean of its neighbours)?
      // Unlike a time-difference hash this reads one frame only and, being a shape, does not care about
      // level, a fixed EQ or a different codec's rolloff - which is what separates two encodes of the
      // same theme tune (measured on real episodes: bit-error 0.33 -> 0.2-0.29).
      let h = 0
      for (let m = 0; m < 32; m++) {
        let sum = 0
        let c = 0
        for (let d = -PEAK_RADIUS; d <= PEAK_RADIUS; d++) {
          const k = m + d
          if (d === 0 || k < 0 || k >= NUM_BANDS) continue
          sum += bandCur[k]
          c++
        }
        if (bandCur[m] > sum / c) h |= 1 << m
      }
      store(h, rms[f] >= SILENCE_RMS)
    }
    slot = 0
  }

  function emitFrame() {
    const target = slot === 0 ? re : im
    let ss = 0
    for (let i = 0; i < FRAME; i++) {
      const x = buf[i]
      ss += x * x
      target[i] = x * HANN[i]
    }
    rms[slot] = Math.sqrt(ss / FRAME)
    slot++
    if (slot === 2) flush(2)
  }

  function pushSamples(get, n) {
    let pos = 0
    while (pos < n) {
      const take = Math.min(buf.length - len, n - pos)
      for (let i = 0; i < take; i++) buf[len + i] = get(pos + i) / 32768
      len += take
      pos += take
      samples += take
      while (len >= FRAME) {
        emitFrame()
        buf.copyWithin(0, HOP, len)
        len -= HOP
      }
    }
  }

  return {
    // Int16Array / plain array of samples
    push(int16) { pushSamples((i) => int16[i], int16.length) },
    // Raw little-endian 16-bit bytes, as ffmpeg's s16le writes them (length must be even)
    pushBuffer(bytes) { pushSamples((i) => bytes.readInt16LE(i * 2), bytes.length >> 1) },
    finish() {
      if (slot === 1) flush(1)
      return { hashes: hashes.slice(0, frames), active: active.slice(0, frames), frames, seconds: samples / SAMPLE_RATE }
    }
  }
}

function fingerprintPcm(int16) {
  const f = createFingerprinter({ maxSeconds: int16.length / SAMPLE_RATE + 2 })
  f.push(int16)
  return f.finish()
}

// -------------------------------------------------------------- alignment
const tick = () => new Promise((resolve) => setImmediate(resolve))

// The first pass looks at every 4th frame of `a` (256 ms) but tries every 64 ms offset: 4x cheaper
// than a full scan and, because no offset is skipped, the shared audio still lines up to within
// 32 ms, which keeps the bit-error rate of a genuine match low. The second pass re-scans only the
// found region with every frame and the neighbouring offsets, for exact edges.
const COARSE_STRIDE = 4
const REFINE_PAD_FRAMES = 20

// Maximum-subarray scan of (PIVOT - differing bits) over frames i0..i1 of a at offset d.
function scanRun(ha, hb, aa, ab, d, i0, i1, stride) {
  let cur = 0, s = i0, best = 0, bs = 0, be = -1
  for (let i = i0; i < i1; i += stride) {
    let g = 0
    if (aa[i] & ab[i + d]) {
      const x = ha[i] ^ hb[i + d]
      g = FRAME_GAIN_PIVOT - (POP[x & 0xffff] + POP[x >>> 16])
    }
    cur += g
    if (cur <= 0) { cur = 0; s = i + stride } else if (cur > best) { best = cur; bs = s; be = i }
  }
  return { sum: best, s: bs, e: be }
}

// Slides fingerprint b against a over every offset and returns the single best run of matching
// frames. Unrelated audio has a negative drift and never builds a run, identical audio climbs
// fast, and a few noisy frames inside a genuine run cost almost nothing (no gap rule needed).
async function findCommonRun(a, b, opts = {}) {
  const minSec = opts.minRunSeconds != null ? opts.minRunSeconds : MIN_INTRO_SECONDS
  const maxSec = opts.maxRunSeconds != null ? opts.maxRunSeconds : MAX_INTRO_SECONDS
  const maxOff = Math.round((opts.maxOffsetSeconds != null ? opts.maxOffsetSeconds : MAX_OFFSET_SECONDS) / HOP_SEC)
  const yieldEvery = opts.yieldEvery != null ? opts.yieldEvery : 300
  const minFrames = Math.max(8, Math.ceil(minSec / HOP_SEC))
  const ha = a.hashes, hb = b.hashes, aa = a.active, ab = b.active
  const na = a.frames, nb = b.frames
  let bestSum = 0, bestS = -1, bestE = -1, bestD = 0
  let n = 0
  for (let d = -maxOff; d <= maxOff; d++) {
    let i0 = d < 0 ? -d : 0
    i0 += (COARSE_STRIDE - (i0 % COARSE_STRIDE)) % COARSE_STRIDE
    const i1 = Math.min(na, nb - d)
    if (i1 - i0 >= minFrames) {
      const r = scanRun(ha, hb, aa, ab, d, i0, i1, COARSE_STRIDE)
      if (r.sum > bestSum) { bestSum = r.sum; bestS = r.s; bestE = r.e; bestD = d }
    }
    if (yieldEvery > 0 && ++n % yieldEvery === 0) await tick()
  }
  if (bestS < 0) return { ok: false, reason: 'no_match' }

  let runS = bestS, runE = bestE, runD = bestD, runSum = 0
  for (let d = bestD - 2; d <= bestD + 2; d++) {
    const lo = Math.max(d < 0 ? -d : 0, bestS - REFINE_PAD_FRAMES)
    const hi = Math.min(na, nb - d, bestE + REFINE_PAD_FRAMES + 1)
    if (hi - lo < 4) continue
    const r = scanRun(ha, hb, aa, ab, d, lo, hi, 1)
    if (r.sum > runSum) { runSum = r.sum; runS = r.s; runE = r.e; runD = d }
  }

  let bits = 0, counted = 0, matched = 0
  for (let i = runS; i <= runE; i++) {
    if (aa[i] & ab[i + runD]) {
      const x = ha[i] ^ hb[i + runD]
      const pc = POP[x & 0xffff] + POP[x >>> 16]
      bits += pc
      counted++
      if (pc <= MATCH_BITS) matched++
    }
  }
  const frames = runE - runS + 1
  const meanBer = counted ? bits / (counted * 32) : 1
  const matchFraction = counted ? matched / frames : 0
  const aStart = Math.max(0, runS * HOP_SEC + START_BIAS)
  const aEnd = runE * HOP_SEC + END_BIAS
  const bStart = Math.max(0, (runS + runD) * HOP_SEC + START_BIAS)
  const bEnd = (runE + runD) * HOP_SEC + END_BIAS
  const info = { aStart, aEnd, bStart, bEnd, offsetSeconds: runD * HOP_SEC, meanBer, matchFraction, score: runSum, frames }
  const len = aEnd - aStart
  if (len < minSec) return { ok: false, reason: 'too_short', ...info }
  if (len > maxSec) return { ok: false, reason: 'too_long', ...info }
  if (meanBer > MAX_RUN_BER) return { ok: false, reason: 'noisy', ...info }
  if (matchFraction < MIN_MATCH_FRACTION) return { ok: false, reason: 'patchy', ...info }
  return { ok: true, ...info }
}

// ---------------------------------------------------------------- consensus
function median(values) {
  const v = values.slice().sort((x, y) => x - y)
  const m = v.length >> 1
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
}

// Which pairs of a season to compare: everything for a small season, otherwise each episode with
// its next few neighbours (so every episode still gets ~6 chances to agree with someone).
function choosePairs(n, neighbours = 3, allPairsUpTo = 7) {
  const pairs = []
  if (n < 2) return pairs
  if (n <= allPairsUpTo) {
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) pairs.push([i, j])
    return pairs
  }
  const seen = new Set()
  for (let i = 0; i < n; i++) {
    for (let k = 1; k <= neighbours; k++) {
      const j = (i + k) % n
      const key = i < j ? `${i}|${j}` : `${j}|${i}`
      if (seen.has(key)) continue
      seen.add(key)
      pairs.push(i < j ? [i, j] : [j, i])
    }
  }
  return pairs
}

function introConfidence(meanBer, support) {
  const q = Math.min(1, Math.max(0, (0.34 - meanBer) / 0.24))
  const s = support >= 3 ? 1 : support === 2 ? 0.8 : support === 1 ? 0.3 : 0
  return Math.round((0.55 * q + 0.45 * s) * 1000) / 1000
}

// One episode's candidate intervals (one per partner it matched) -> the stretch at least TWO partners
// confirm, plus how many partners agree with it. Sweeping the intervals (rather than voting on a single
// "best" one) is what copes with real seasons: episodes from the same source match each other over the
// whole title sequence (and sometimes a few seconds more), episodes from another source match it only
// where the two edits coincide - so partners disagree about the edges but agree about the middle, and
// the region two of them confirm is the titles without eating a bit of the story on either side.
// With a single partner (a two-episode season) that one interval stands alone.
function clusterCandidates(cands) {
  if (!cands || !cands.length) return null
  const need = cands.length >= 2 ? 2 : 1
  const events = []
  for (const c of cands) events.push([c.start, 1], [c.end, -1])
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  let cov = 0
  let openAt = null
  let best = null
  for (const [t, d] of events) {
    const before = cov
    cov += d
    if (before < need && cov >= need) openAt = t
    else if (before >= need && cov < need && openAt !== null) {
      if (!best || t - openAt > best.end - best.start) best = { start: openAt, end: t }
      openAt = null
    }
  }
  if (!best || best.end - best.start <= 0) return null
  const len = best.end - best.start
  const agree = cands.filter((c) => (Math.min(c.end, best.end) - Math.max(c.start, best.start)) / len >= 0.5)
  if (!agree.length) return null
  return {
    introStart: best.start,
    introEnd: best.end,
    support: agree.length,
    meanBer: agree.reduce((t, x) => t + x.ber, 0) / agree.length
  }
}

// items: [{ id, fp }] - the episodes of ONE season. Returns Map(id -> { introStart, introEnd,
// confidence, support, meanBer }) for the episodes that got a confident answer.
async function detectSeasonIntros(items, opts = {}) {
  const out = new Map()
  const list = (items || []).filter((x) => x && x.fp && x.fp.frames > 0)
  if (list.length < 2) return out
  const cands = list.map(() => [])
  for (const [i, j] of choosePairs(list.length, opts.neighbours, opts.allPairsUpTo)) {
    const r = await findCommonRun(list[i].fp, list[j].fp, opts)
    if (!r.ok) continue
    cands[i].push({ start: r.aStart, end: r.aEnd, ber: r.meanBer })
    cands[j].push({ start: r.bStart, end: r.bEnd, ber: r.meanBer })
    if (opts.yieldEvery !== 0) await tick()
  }
  const found = []
  list.forEach((it, idx) => {
    const c = clusterCandidates(cands[idx])
    if (c) found.push({ id: it.id, ...c })
  })
  // One episode with a very different "intro" length matched something else (a shared recap or
  // a stinger); drop it rather than show a wrong window. Needs >=3 answers to have a norm.
  let kept = found
  if (found.length >= 3) {
    const L = median(found.map((f) => f.introEnd - f.introStart))
    kept = found.filter((f) => Math.abs(f.introEnd - f.introStart - L) <= Math.max(8, 0.35 * L))
  }
  for (const f of kept) {
    const confidence = introConfidence(f.meanBer, f.support)
    out.set(f.id, {
      introStart: Math.round(f.introStart * 10) / 10,
      introEnd: Math.round(f.introEnd * 10) / 10,
      confidence,
      support: f.support,
      meanBer: Math.round(f.meanBer * 1000) / 1000
    })
  }
  return out
}

// ------------------------------------------------------------------ credits
function parseNumber(s) {
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

// "[blackdetect @ 0x..] black_start:12.5 black_end:15.04 black_duration:2.54"
function parseBlackdetect(text, offsetSeconds = 0) {
  const out = []
  const re = /black_start:\s*(-?[\d.]+)\s+black_end:\s*(-?[\d.]+)\s+black_duration:\s*(-?[\d.]+)/g
  let m
  while ((m = re.exec(String(text || '')))) {
    const s = parseNumber(m[1]), e = parseNumber(m[2])
    if (s === null || e === null || e < s) continue
    out.push({ start: s + offsetSeconds, end: e + offsetSeconds })
  }
  return out
}

// "[silencedetect @ 0x..] silence_start: 12.5" then "silence_end: 15.04 | silence_duration: 2.54".
// A silence still open when the input ended has a start and no end: closed at `closeAt`.
function parseSilencedetect(text, offsetSeconds = 0, closeAt = null) {
  const out = []
  let open = null
  const re = /silence_(start|end):\s*(-?[\d.]+)/g
  let m
  while ((m = re.exec(String(text || '')))) {
    const t = parseNumber(m[2])
    if (t === null) continue
    if (m[1] === 'start') open = t
    else if (open !== null) { if (t >= open) out.push({ start: open + offsetSeconds, end: t + offsetSeconds }); open = null }
    else out.push({ start: offsetSeconds, end: t + offsetSeconds })
  }
  if (open !== null && closeAt !== null && closeAt > open + offsetSeconds) out.push({ start: open + offsetSeconds, end: closeAt })
  return out
}

function mergeIntervals(list) {
  const v = list.filter((x) => x && x.end > x.start).map((x) => ({ start: x.start, end: x.end })).sort((a, b) => a.start - b.start)
  const out = []
  for (const x of v) {
    const last = out[out.length - 1]
    if (last && x.start <= last.end + 0.05) last.end = Math.max(last.end, x.end)
    else out.push(x)
  }
  return out
}

function coverageIn(intervals, from, to) {
  if (to <= from) return 0
  let sum = 0
  for (const x of mergeIntervals(intervals)) {
    const s = Math.max(x.start, from), e = Math.min(x.end, to)
    if (e > s) sum += e - s
  }
  return sum / (to - from)
}

function tailWindow(durationSeconds) {
  const d = Number(durationSeconds)
  if (!Number.isFinite(d) || d <= 0) return null
  const length = Math.min(d, Math.min(TAIL_WINDOW_MAX_SECONDS, Math.max(TAIL_WINDOW_MIN_SECONDS, d * TAIL_WINDOW_FRACTION)))
  return { start: Math.max(0, d - length), length }
}

function introWindowSeconds(durationSeconds) {
  const d = Number(durationSeconds)
  if (!Number.isFinite(d) || d <= 0) return INTRO_WINDOW_MAX_SECONDS
  return Math.min(INTRO_WINDOW_MAX_SECONDS, Math.max(INTRO_WINDOW_MIN_SECONDS, d * INTRO_WINDOW_FRACTION))
}

const CREDITS_MIN_TAIL_SECONDS = 60
const CREDITS_EDGE_SECONDS = 12
const CREDITS_MIN_COVERAGE_TV = 0.55
const CREDITS_MIN_COVERAGE_MOVIE = 0.75

// Every place the credits could start, best-first: a dark stretch that begins in the tail window,
// leaves >= 60 s, and after which the picture is mostly dark until the end. The EARLIEST such
// start is the story->credits transition (later ones are gaps between credit pages).
function creditsCandidates({ black, silence, durationSeconds, kind = 'tv' } = {}) {
  const D = Number(durationSeconds)
  const win = tailWindow(D)
  if (!win) return []
  const minCov = kind === 'movie' ? CREDITS_MIN_COVERAGE_MOVIE : CREDITS_MIN_COVERAGE_TV
  const blacks = mergeIntervals((black || []).map((b) => ({ start: Math.max(b.start, win.start), end: Math.min(b.end, D) })))
  const out = []
  for (const b of blacks) {
    const start = b.start
    if (start < D * 0.5 || start > D - CREDITS_MIN_TAIL_SECONDS) continue
    // Darkness already running when the window opened has no known beginning (the report starts at the
    // first frame we saw), and with key-frame-only sampling that frame can be a GOP later than the
    // window start. Where the darkness really began is unknowable, so no marker.
    if (start <= win.start + CREDITS_EDGE_SECONDS) continue
    const coverage = coverageIn(blacks, start, D)
    if (coverage < minCov) continue
    // The story usually stops talking just before the picture goes dark: a quiet moment around the
    // start corroborates it (a fade in the middle of a loud scene does not get this).
    const quiet = (silence || []).some((s) => s.start <= start + 1 && s.end >= start - 4)
    out.push({ start: Math.round(start * 10) / 10, coverage: Math.round(coverage * 1000) / 1000, tail: Math.round((D - start) * 10) / 10, quiet })
  }
  return out
}

function creditsConfidence(coverage, consensus, quiet = false) {
  let c = 0.35 + 0.65 * Math.min(1, Math.max(0, coverage))
  if (quiet) c += 0.05
  if (consensus === 'agree') c += 0.1
  else if (consensus === 'none') c -= 0.05
  return Math.round(Math.min(1, Math.max(0, c)) * 1000) / 1000
}

// items: [{ id, candidates }] - EVERY analysed item of one season (an episode with no candidates counts:
// it is evidence that the show's credits are not detectable this way). The credits normally start about
// the same distance from the end in every episode of a show, so for a season of 3+ episodes a candidate
// is only believed when enough other episodes have one at a similar distance (at least 2 and at least
// 40% of the season) - an isolated dark scene near the end of one episode is not "the credits".
// Films and seasons of one or two episodes have no such norm: their single best candidate is used, with
// a confidence penalty. Returns Map(id -> { creditsStart, coverage, confidence, consensus }).
function creditsConsensus(items, { kind = 'tv' } = {}) {
  const out = new Map()
  const all = (items || []).filter((x) => x && Array.isArray(x.candidates))
  const rows = all.filter((x) => x.candidates.length)
  if (!rows.length) return out
  const tolFor = (t) => Math.max(20, 0.35 * t)
  const emit = (r, pick, consensus) => out.set(r.id, {
    creditsStart: pick.start,
    coverage: pick.coverage,
    consensus,
    confidence: creditsConfidence(pick.coverage, consensus, !!pick.quiet)
  })
  if (kind === 'movie' || all.length < 3) {
    for (const r of rows) emit(r, r.candidates[0], 'none')
    return out
  }
  let best = null
  for (const r of rows) {
    for (const c of r.candidates) {
      const members = rows.filter((o) => o.candidates.some((x) => Math.abs(x.tail - c.tail) <= tolFor(c.tail)))
      if (!best || members.length > best.members.length) best = { tail: c.tail, members }
    }
  }
  if (!best || best.members.length < Math.max(2, Math.ceil(0.4 * all.length))) return out
  const norm = median(best.members.map((r) => r.candidates.reduce((a, c) => (Math.abs(c.tail - best.tail) < Math.abs(a.tail - best.tail) ? c : a)).tail))
  const tol = tolFor(norm)
  for (const r of best.members) {
    const near = r.candidates.filter((c) => Math.abs(c.tail - norm) <= tol).sort((a, b) => Math.abs(a.tail - norm) - Math.abs(b.tail - norm))
    if (near.length) emit(r, near[0], 'agree')
  }
  return out
}

// ------------------------------------------------------------ ffmpeg argv
// Every argument is its own array element and the input is always `file:`-prefixed, so a path with
// spaces, quotes, `;`, `&`, a leading `-` or a protocol-looking name can never become an option or
// be re-interpreted; nothing here ever goes through a shell.
// The shared helper (electron/ffmpegArgs.js) also adds `-protocol_whitelist file,crypto,pipe`.
const { inputArgs } = require('./ffmpegArgs')
function inputArg(filePath) {
  const p = String(filePath == null ? '' : filePath)
  if (!p || p.includes('\0')) throw new Error('invalid input path')
  return 'file:' + p
}

const secs = (n) => Number(n).toFixed(3)

function buildPcmArgs(filePath, seconds) {
  return [
    '-hide_banner', '-nostdin', '-nostats', '-loglevel', 'error',
    '-t', secs(seconds),
    ...inputArgs(filePath),
    '-map', '0:a:0?', '-vn', '-sn', '-dn',
    '-ac', '1', '-ar', String(SAMPLE_RATE),
    '-f', 's16le', 'pipe:1'
  ]
}

function buildTailArgs(filePath, startSeconds, lengthSeconds, { keyframesOnly = true } = {}) {
  return [
    '-hide_banner', '-nostdin', '-nostats',
    ...(keyframesOnly ? ['-skip_frame', 'nokey'] : []),
    '-ss', secs(startSeconds),
    ...inputArgs(filePath),
    '-t', secs(lengthSeconds),
    '-map', '0:v:0?', '-map', '0:a:0?', '-sn', '-dn',
    '-vf', 'scale=96:54,blackdetect=d=0.4:pic_th=0.90:pix_th=0.12',
    '-af', 'silencedetect=n=-45dB:d=0.4',
    '-f', 'null', '-'
  ]
}

function buildProbeArgs(filePath) {
  return ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', ...inputArgs(filePath)]
}

// --------------------------------------------------------------- processes
// Runs one child to completion: below-normal priority, hard timeout, stdout streamed to onStdout,
// only the lines matching `keep` retained from stderr (blackdetect can be chatty), never throws.
function runProcess(exe, args, opts = {}) {
  const { timeoutMs = 120000, onStdout = null, collectStdout = false, keep = null, spawnFn = spawn, priority = true } = opts
  return new Promise((resolve) => {
    let child
    try {
      child = spawnFn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (e) {
      resolve({ code: -1, error: String((e && e.message) || e), stdout: '', stderr: '', lines: '' })
      return
    }
    if (priority) {
      try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL) } catch (_) {}
    }
    let done = false
    let timedOut = false
    let stdout = ''
    let tail = ''
    let pending = ''
    const kept = []
    let keptChars = 0
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGKILL') } catch (_) {}
    }, timeoutMs)
    if (timer.unref) timer.unref()
    const finish = (code, error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (keep && pending && keep.test(pending)) kept.push(pending)
      resolve({ code, timedOut, error: error || null, stdout, stderr: tail.trim(), lines: kept.join('\n') })
    }
    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        if (onStdout) { try { onStdout(chunk) } catch (_) { try { child.kill('SIGKILL') } catch (e2) {} } }
        if (collectStdout && stdout.length < 4096) stdout += chunk.toString()
      })
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        const text = chunk.toString()
        tail = (tail + text).slice(-1500)
        if (!keep) return
        pending += text
        const lines = pending.split(/\r?\n|\r/)
        pending = lines.pop() || ''
        for (const line of lines) {
          if (keep.test(line) && keptChars < 2000000) { kept.push(line); keptChars += line.length }
        }
      })
    }
    child.on('error', (err) => finish(-1, String((err && err.message) || err)))
    child.on('close', (code) => finish(code))
  })
}

async function probeDuration(filePath, { ffprobePath, timeoutMs = 30000, spawnFn, priority } = {}) {
  if (!ffprobePath) return null
  let args
  try { args = buildProbeArgs(filePath) } catch { return null }
  const r = await runProcess(ffprobePath, args, { timeoutMs, collectStdout: true, spawnFn, priority })
  if (r.code !== 0) return null
  const n = Number(String(r.stdout).trim().split(/\s+/)[0])
  return Number.isFinite(n) && n > 0 ? n : null
}

// Decodes the analysis window to PCM and fingerprints it on the fly.
async function extractFingerprint(filePath, { ffmpegPath, seconds, timeoutMs = 240000, spawnFn, priority } = {}) {
  if (!ffmpegPath) return { ok: false, error: 'no_ffmpeg' }
  let args
  try { args = buildPcmArgs(filePath, seconds) } catch (e) { return { ok: false, error: 'bad_path' } }
  const fp = createFingerprinter({ maxSeconds: seconds + 5 })
  let carry = null
  const onStdout = (chunk) => {
    let b = chunk
    if (carry) { b = Buffer.concat([carry, chunk]); carry = null }
    const usable = b.length & ~1
    if (usable !== b.length) carry = b.subarray(usable)
    if (usable) fp.pushBuffer(usable === b.length ? b : b.subarray(0, usable))
  }
  const r = await runProcess(ffmpegPath, args, { timeoutMs, onStdout, spawnFn, priority })
  if (r.timedOut) return { ok: false, error: 'timeout' }
  if (r.code !== 0) return { ok: false, error: r.error || `ffmpeg exited with code ${r.code}${r.stderr ? ': ' + r.stderr.split('\n').pop() : ''}` }
  const out = fp.finish()
  if (out.frames < Math.ceil(MIN_INTRO_SECONDS / HOP_SEC) + 4) return { ok: false, error: 'no_audio' }
  return { ok: true, fp: out }
}

// One ffmpeg pass over the tail: black + silence intervals in absolute file time.
async function analyseTail(filePath, { ffmpegPath, durationSeconds, timeoutMs = 240000, keyframesOnly = true, spawnFn, priority } = {}) {
  if (!ffmpegPath) return { ok: false, error: 'no_ffmpeg' }
  const win = tailWindow(durationSeconds)
  if (!win) return { ok: false, error: 'no_duration' }
  let args
  try { args = buildTailArgs(filePath, win.start, win.length, { keyframesOnly }) } catch (e) { return { ok: false, error: 'bad_path' } }
  const r = await runProcess(ffmpegPath, args, { timeoutMs, keep: /black_start|silence_(start|end)/, spawnFn, priority })
  if (r.timedOut) return { ok: false, error: 'timeout' }
  if (r.code !== 0) return { ok: false, error: r.error || `ffmpeg exited with code ${r.code}${r.stderr ? ': ' + r.stderr.split('\n').pop() : ''}` }
  return {
    ok: true,
    windowStart: win.start,
    black: parseBlackdetect(r.lines, win.start),
    silence: parseSilencedetect(r.lines, win.start, durationSeconds)
  }
}

module.exports = {
  DETECTOR_VERSION,
  SAMPLE_RATE, FRAME, HOP, HOP_SEC, FRAME_SEC,
  MIN_INTRO_SECONDS, MAX_INTRO_SECONDS,
  CREDITS_MIN_TAIL_SECONDS, CREDITS_MIN_COVERAGE_TV, CREDITS_MIN_COVERAGE_MOVIE,
  createFingerprinter,
  fingerprintPcm,
  findCommonRun,
  choosePairs,
  clusterCandidates,
  introConfidence,
  detectSeasonIntros,
  parseBlackdetect,
  parseSilencedetect,
  mergeIntervals,
  coverageIn,
  tailWindow,
  introWindowSeconds,
  creditsCandidates,
  creditsConfidence,
  creditsConsensus,
  inputArg,
  buildPcmArgs,
  buildTailArgs,
  buildProbeArgs,
  runProcess,
  probeDuration,
  extractFingerprint,
  analyseTail,
  median
}
