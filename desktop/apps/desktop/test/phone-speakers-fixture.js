'use strict'
// Helpers for the phone-speakers tests (not a test file): find the bundled ffmpeg, synthesize a 5.1 film
// with a different pure tone in every channel, read the WAV pieces back and measure tones (Goertzel).
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const appRoot = path.resolve(__dirname, '..')

function findTool(name) {
  const envName = name === 'ffprobe' ? 'BEEBO_FFPROBE' : 'BEEBO_FFMPEG'
  const exe = process.platform === 'win32' ? `${name}.exe` : name
  const candidates = [process.env[envName], path.join(appRoot, 'resources', 'ffmpeg', exe)]
  if (name === 'ffprobe' && process.env.BEEBO_FFMPEG) candidates.splice(1, 0, path.join(path.dirname(process.env.BEEBO_FFMPEG), exe))
  for (const c of candidates) if (c && fs.existsSync(c)) return c
  const probe = spawnSync(name, ['-version'], { encoding: 'utf8', windowsHide: true })
  return probe.status === 0 ? name : null
}

const FFMPEG = findTool('ffmpeg')
const FFPROBE = findTool('ffprobe')

// One tone per channel of a 5.1(side) film: FL FR FC LFE SL SR. All are far apart and none is a harmonic of another.
const TONES = Object.freeze({ FL: 440, FR: 554, FC: 659, LFE: 60, SL: 880, SR: 1109 })
const ORDER = ['FL', 'FR', 'FC', 'LFE', 'SL', 'SR']

function run(args) {
  const r = spawnSync(FFMPEG, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`ffmpeg failed (${r.status}): ${r.stderr}`)
  return r
}

/** A `seconds`-long 5.1 film (FLAC in a Matroska audio file) with TONES in the channels. */
function makeTone51(file, seconds = 22) {
  const args = ['-hide_banner', '-nostdin', '-v', 'error', '-y']
  for (const ch of ORDER) args.push('-f', 'lavfi', '-i', `sine=frequency=${TONES[ch]}:sample_rate=48000:duration=${seconds}`)
  args.push('-filter_complex', `[0][1][2][3][4][5]join=inputs=6:channel_layout=5.1(side):map=0.0-FL|1.0-FR|2.0-FC|3.0-LFE|4.0-SL|5.0-SR[a]`,
    '-map', '[a]', '-c:a', 'flac', file)
  run(args)
  return file
}

/** A film with a 1 kHz burst (200 ms) at `at` seconds in the FL channel and silence elsewhere; `layout`: '5.1(side)' or 'stereo'. */
function makeBurst(file, { at = 3, seconds = 14, layout = '5.1(side)' } = {}) {
  // One multi-channel generator (a chain of sine + adelay + apad + join hangs ffmpeg now and then; this cannot).
  const n = layout === 'stereo' ? 2 : 6
  const exprs = [`if(between(t,${at},${at + 0.2}),0.5*sin(2*PI*1000*t),0)`, ...Array(n - 1).fill('0')].join('|')
  run(['-hide_banner', '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', `aevalsrc='${exprs}':s=48000:d=${seconds}:c=${layout}`, '-c:a', 'flac', file])
  return file
}

/** Reads a mono 16-bit PCM WAV file -> { rate, samples: Int16Array }. */
function readWav(file) {
  const b = fs.readFileSync(file)
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a wav file')
  let i = 12
  let rate = 0
  let channels = 0
  let bits = 0
  while (i + 8 <= b.length) {
    const id = b.toString('ascii', i, i + 4)
    let len = b.readUInt32LE(i + 4)
    if (id === 'fmt ') { channels = b.readUInt16LE(i + 10); rate = b.readUInt32LE(i + 12); bits = b.readUInt16LE(i + 22) }
    if (id === 'data') {
      if (i + 8 + len > b.length) len = b.length - i - 8
      const copy = Buffer.from(b.subarray(i + 8, i + 8 + len))
      return { rate, channels, bits, samples: new Int16Array(copy.buffer, copy.byteOffset, Math.floor(len / 2)) }
    }
    i += 8 + len + (len & 1)
  }
  throw new Error('no data chunk')
}

/** Power of one frequency in a block of samples (Goertzel), normalised so a full-scale sine of that frequency is about 0.5. */
function tonePower(samples, rate, freq, from = 0, count = samples.length - from) {
  const n = Math.min(count, samples.length - from)
  const w = (2 * Math.PI * freq) / rate
  const coeff = 2 * Math.cos(w)
  let s0 = 0
  let s1 = 0
  let s2 = 0
  for (let i = 0; i < n; i++) {
    s0 = samples[from + i] / 32768 + coeff * s1 - s2
    s2 = s1
    s1 = s0
  }
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2
  return power / (n * n) * 4 // a unit sine gives ~ 1
}
const db = (x) => 10 * Math.log10(Math.max(x, 1e-12))

/** Index of the first sample whose magnitude exceeds `threshold` (fraction of full scale), or -1. */
function onset(samples, threshold = 0.05) {
  const t = threshold * 32768
  for (let i = 0; i < samples.length; i++) if (Math.abs(samples[i]) > t) return i
  return -1
}

function tmpDir(prefix = 'beebo-spk-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

module.exports = { appRoot, FFMPEG, FFPROBE, TONES, ORDER, run, makeTone51, makeBurst, readWav, tonePower, db, onset, tmpDir }
