'use strict'
// Deterministic synthetic audio for the intro detector tests: a shared "jingle" (notes with
// harmonics plus percussive noise bursts) dropped at different offsets into otherwise different
// random "episodes" (drifting resonant noise and chords, a stand-in for dialogue and scoring).

const SR = 8000

function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function jingle(seconds, seed) {
  const r = rng(seed)
  const out = new Float32Array(Math.round(seconds * SR))
  const scale = [0, 2, 4, 7, 9, 12, 14, 16]
  let t = 0
  while (t < seconds) {
    const len = 0.22 + r() * 0.4
    const f0 = 220 * Math.pow(2, scale[Math.floor(r() * scale.length)] / 12)
    const amp = 0.18 + r() * 0.15
    const s0 = Math.round(t * SR)
    const n = Math.min(out.length - s0, Math.round(len * SR))
    for (let i = 0; i < n; i++) {
      const env = Math.min(1, i / (0.02 * SR)) * Math.exp(-2.2 * (i / n))
      const x = i / SR
      out[s0 + i] += amp * env * (Math.sin(2 * Math.PI * f0 * x) + 0.5 * Math.sin(4 * Math.PI * f0 * x) + 0.25 * Math.sin(6 * Math.PI * f0 * x))
    }
    if (r() < 0.4) {
      const hitLen = Math.round(0.08 * SR)
      for (let i = 0; i < hitLen && s0 + i < out.length; i++) out[s0 + i] += 0.35 * (r() * 2 - 1) * Math.exp(-6 * (i / hitLen))
    }
    t += len
  }
  return out
}

// Drifting resonant noise + chords: every episode (seed) is different, none is silent. Segments are
// short and each carries several random resonances, so unrelated episodes look as unrelated to the
// fingerprint as real speech and score do (random-pair bit error ~0.5).
function background(seconds, seed) {
  const r = rng(seed)
  const out = new Float32Array(Math.round(seconds * SR))
  let i = 0
  while (i < out.length) {
    const segLen = Math.min(out.length - i, Math.round((0.15 + r() * 0.5) * SR))
    const kind = r()
    if (kind < 0.6) {
      const nres = 3 + Math.floor(r() * 4)
      for (let q = 0; q < nres; q++) {
        const f = 200 + r() * 3300
        const bw = 0.02 + r() * 0.12
        const rr = 1 - bw
        const c1 = 2 * rr * Math.cos((2 * Math.PI * f) / SR)
        const c2 = -rr * rr
        let y1 = 0, y2 = 0
        const gain = (0.02 + r() * 0.1) / nres
        for (let k = 0; k < segLen; k++) {
          const y = (r() * 2 - 1) + c1 * y1 + c2 * y2
          y2 = y1; y1 = y
          out[i + k] += gain * y
        }
      }
    } else {
      const nf = 2 + Math.floor(r() * 3)
      const fs = []
      for (let k = 0; k < nf; k++) fs.push(150 + r() * 2000)
      const amp = 0.05 + r() * 0.1
      for (let k = 0; k < segLen; k++) {
        let v = 0
        for (const f of fs) v += Math.sin((2 * Math.PI * f * k) / SR)
        out[i + k] += (amp / nf) * v * Math.min(1, k / 400)
      }
    }
    i += segLen
  }
  return out
}

// A full episode: `bg` of seconds with the jingle mixed in at `at` seconds (null = no jingle).
function episode({ seconds, seed, jingleSamples = null, at = 0, gain = 1, noise = 0, noiseSeed = 1 }) {
  const out = background(seconds, seed)
  if (jingleSamples) {
    const s0 = Math.round(at * SR)
    for (let i = 0; i < jingleSamples.length && s0 + i < out.length; i++) {
      out[s0 + i] = out[s0 + i] * 0.15 + jingleSamples[i] * gain
    }
  }
  if (noise > 0) {
    const r = rng(noiseSeed)
    for (let i = 0; i < out.length; i++) out[i] += noise * (r() * 2 - 1)
  }
  return out
}

function toInt16(f32, peak = 0.9) {
  let max = 1e-9
  for (let i = 0; i < f32.length; i++) { const a = Math.abs(f32[i]); if (a > max) max = a }
  const scale = (peak * 32767) / max
  const out = new Int16Array(f32.length)
  for (let i = 0; i < f32.length; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(f32[i] * scale)))
  return out
}

module.exports = { SR, rng, jingle, background, episode, toInt16 }
