'use strict'
// One answer to "should Beebo's background work hold back right now?", shared by everything that
// runs without anyone asking (intro/credits detection, automatic format conversions, music rescans,
// the daily subtitle and metadata sweeps). On an old or low-power PC these are what make the fan
// spin and a movie stutter, so they wait when:
//   'playback'  someone is watching (a viewer session, a live conversion, a stream),
//   'battery'   the PC is running on battery (a laptop away from its charger),
//   'busy'      the whole CPU has been nearly full for a while (something else is using the PC).
// Work that a person asked for right now (a stuck viewer's conversion, a manual "Sweep now",
// "Rescan") never goes through this; it only holds back the automatic kind.
//
// Settings (electron-store keys, all default on): backgroundPauseOnBattery, backgroundPauseWhenBusy.
// The environment can override them for a server that has no meaningful battery or is a dedicated
// box: BEEBO_BACKGROUND_ALWAYS=1 turns the gate off entirely.

const os = require('os')

const BUSY_PERCENT = 85 // whole-machine CPU use that counts as "busy"
const SAMPLE_MS = 4000 // CPU is sampled at most this often, however many callers ask
const BUSY_NEEDS_SAMPLES = 2 // busy on two samples in a row, so a single spike does not pause anything

let probes = { playing: null, battery: null, setting: null }
let cpu = { at: 0, last: null, busyStreak: 0, percent: 0 }

/**
 * @param {{ playing?: () => boolean, battery?: () => boolean, setting?: (key: string, dflt: any) => any }} p
 * playing: true while someone is watching; battery: true on battery power; setting: reads an owner setting.
 */
function configure(p = {}) {
  probes = { playing: null, battery: null, setting: null, ...probes, ...p }
}

function reset() {
  probes = { playing: null, battery: null, setting: null }
  cpu = { at: 0, last: null, busyStreak: 0, percent: 0 }
}

function readSetting(key, dflt) {
  try {
    if (typeof probes.setting === 'function') {
      const v = probes.setting(key, dflt)
      return v === undefined || v === null || v === '' ? dflt : v
    }
  } catch { /* fall through to the default */ }
  return dflt
}

function cpuTimes() {
  let idle = 0
  let total = 0
  for (const c of os.cpus()) {
    for (const k of Object.keys(c.times)) total += c.times[k]
    idle += c.times.idle
  }
  return { idle, total }
}

// Whole-machine CPU use since the previous sample (0-100), sampled at most every SAMPLE_MS.
function sampleCpu(now = Date.now()) {
  if (cpu.last && now >= cpu.at && now - cpu.at < SAMPLE_MS) return cpu
  let t
  try { t = cpuTimes() } catch { return cpu }
  if (cpu.last) {
    const dTotal = t.total - cpu.last.total
    const dIdle = t.idle - cpu.last.idle
    if (dTotal > 0) {
      cpu.percent = Math.max(0, Math.min(100, 100 * (1 - dIdle / dTotal)))
      cpu.busyStreak = cpu.percent >= BUSY_PERCENT ? cpu.busyStreak + 1 : 0
    }
  }
  cpu.last = t
  cpu.at = now
  return cpu
}

/**
 * @param {{ ignore?: string[], now?: number }} [opts] `now` is for tests. `ignore`: reasons this caller does not care about (e.g. the scanner
 *   that already has its own "someone is watching" check can ignore 'playback').
 * @returns {{ defer: boolean, reason: null | 'playback' | 'battery' | 'busy' }}
 */
function check(opts = {}) {
  if (process.env.BEEBO_BACKGROUND_ALWAYS === '1') return { defer: false, reason: null }
  const ignore = new Set((opts && opts.ignore) || [])
  if (!ignore.has('playback') && typeof probes.playing === 'function') {
    let playing = false
    try { playing = !!probes.playing() } catch { playing = false }
    if (playing) return { defer: true, reason: 'playback' }
  }
  if (!ignore.has('battery') && typeof probes.battery === 'function' && readSetting('backgroundPauseOnBattery', true) !== false) {
    let onBattery = false
    try { onBattery = !!probes.battery() } catch { onBattery = false }
    if (onBattery) return { defer: true, reason: 'battery' }
  }
  if (!ignore.has('busy') && readSetting('backgroundPauseWhenBusy', true) !== false) {
    const s = sampleCpu(opts && opts.now)
    if (s.busyStreak >= BUSY_NEEDS_SAMPLES) return { defer: true, reason: 'busy' }
  }
  return { defer: false, reason: null }
}

const shouldDefer = (opts) => check(opts).defer

/**
 * Runs `fn` now, or - when the gate says wait - tries again every `retryMs` (default 10 minutes)
 * until it is clear. For the daily sweeps: they are late, never skipped. Returns a promise for fn's
 * result. `timers` is injectable for tests.
 */
function runWhenClear(fn, { retryMs = 10 * 60 * 1000, ignore, maxWaits = 144, timers = { setTimeout } } = {}) {
  return new Promise((resolve, reject) => {
    let waits = 0
    const attempt = () => {
      if (waits >= maxWaits || !check({ ignore }).defer) {
        try { Promise.resolve(fn()).then(resolve, reject) } catch (e) { reject(e) }
        return
      }
      waits++
      const t = timers.setTimeout(attempt, retryMs)
      if (t && t.unref) t.unref()
    }
    attempt()
  })
}

module.exports = { configure, reset, check, shouldDefer, runWhenClear, sampleCpu, BUSY_PERCENT, SAMPLE_MS }
