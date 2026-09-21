// Remote-control scrubbing model for the player. DOM-free.
//
// Pressing Left/Right on a TV remote auto-repeats. Setting video.currentTime on every repeat would
// hammer a transcoded HLS stream (each seek can restart the server's conversion), so we accumulate
// a pending target, show it on the bar immediately, and only commit after a short idle gap. Steps
// grow while the key keeps being pressed (10 s, then 30 s, then 60 s, then 120 s).

var STEPS = [10, 10, 10, 30, 30, 60, 60, 120]
var CHAIN_MS = 700 // presses closer together than this count as one continuous scrub

export function createSeeker(opts) {
  var commitDelayMs = (opts && opts.commitDelayMs) || 600
  var pending = null // target seconds, or null when not scrubbing
  var streak = 0
  var lastDir = 0
  var lastAt = -Infinity

  function clamp(t, duration) {
    if (!(duration > 0)) return Math.max(0, t)
    return Math.min(Math.max(0, t), Math.max(0, duration - 1))
  }

  return {
    /** dir = -1 | +1. Returns the new pending target (seconds). */
    press: function (dir, currentTime, duration, nowMs) {
      var chained = pending !== null && dir === lastDir && nowMs - lastAt <= CHAIN_MS
      streak = chained ? streak + 1 : 0
      lastDir = dir
      lastAt = nowMs
      var base = pending !== null ? pending : currentTime
      var step = STEPS[Math.min(streak, STEPS.length - 1)]
      pending = clamp(base + dir * step, duration)
      return pending
    },
    /** True when the idle gap has passed and the pending seek should be applied. */
    due: function (nowMs) { return pending !== null && nowMs - lastAt >= commitDelayMs },
    /** Take the pending target (and clear it). */
    commit: function () { var t = pending; pending = null; streak = 0; lastDir = 0; return t },
    cancel: function () { pending = null; streak = 0; lastDir = 0 },
    pending: function () { return pending },
    /** Position to draw: the pending target while scrubbing, else the real time. */
    displayTime: function (currentTime) { return pending !== null ? pending : currentTime }
  }
}

/** Seconds -> 0..1 fraction for the progress bar (safe against 0/NaN duration). */
export function fraction(t, duration) {
  if (!(duration > 0)) return 0
  var f = t / duration
  return f < 0 ? 0 : f > 1 ? 1 : f
}

/**
 * Where to resume. Movies/episodes that are (nearly) finished start from the top; tiny progress
 * is not worth resuming. Returns seconds.
 */
export function resumePosition(currentTime, duration) {
  var t = Number(currentTime) || 0
  var d = Number(duration) || 0
  if (t < 30) return 0
  if (d > 0 && (t >= d - 60 || t / d >= 0.95)) return 0
  return Math.floor(t)
}
