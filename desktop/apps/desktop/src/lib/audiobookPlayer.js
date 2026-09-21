// The audiobook player's arithmetic for the desktop app's React UI (Audiobooks.jsx).
// This is a byte-for-byte copy of the function bodies in electron/audiobookPlayer.js (which the website's
// player inlines); test/audiobook-player.test.js fails if the two ever differ. Change both together.
//
// Units: seconds everywhere, except sleep-timer clocks which are milliseconds (Date.now()).
//
// A book is one or more PARTS (files). `parts` here is [{ start, duration }] where `start` is
// where the part begins on the whole-book timeline. Chapters are [{ title, start, end }] on the
// same whole-book timeline. Position "in the book" is always whole-book seconds.

/** Playback speed: 0.5x to 3x in steps of 0.05, NaN and junk falling back to 1. */
function clampSpeed(v) {
  var n = Number(v)
  if (!isFinite(n) || n <= 0) return 1
  n = Math.round(n * 20) / 20
  return n < 0.5 ? 0.5 : n > 3 ? 3 : n
}

/** The whole-book position -> { index, offset }: which part, and seconds into that part. */
function locate(parts, seconds) {
  var list = parts || []
  if (!list.length) return { index: 0, offset: 0 }
  var pos = Number(seconds)
  if (!isFinite(pos) || pos < 0) pos = 0
  for (var i = list.length - 1; i >= 0; i--) {
    if (pos >= list[i].start) {
      var offset = pos - list[i].start
      // Past the very end of the last part: park at its end rather than beyond it.
      if (i === list.length - 1 && list[i].duration > 0 && offset > list[i].duration) offset = list[i].duration
      return { index: i, offset: offset }
    }
  }
  return { index: 0, offset: 0 }
}

/** Part + seconds into it -> whole-book seconds. */
function bookPosition(parts, index, offset) {
  var p = (parts || [])[index]
  var o = Number(offset)
  if (!p) return 0
  return p.start + (isFinite(o) && o > 0 ? o : 0)
}

/** Index of the chapter playing at `seconds`, or -1 before the first (or with no chapters). */
function chapterIndexAt(chapters, seconds) {
  var list = chapters || []
  var pos = Number(seconds)
  if (!list.length || !isFinite(pos)) return -1
  var lo = 0
  var hi = list.length - 1
  var found = -1
  while (lo <= hi) {
    var mid = (lo + hi) >> 1
    if (list[mid].start <= pos + 0.001) { found = mid; lo = mid + 1 } else hi = mid - 1
  }
  return found
}

/** Skip back / forward: the new whole-book position, kept inside the book. */
function skipTarget(position, delta, duration) {
  var p = Number(position) + Number(delta)
  if (!isFinite(p) || p < 0) p = 0
  var d = Number(duration)
  if (isFinite(d) && d > 0 && p > d) p = d
  return p
}

/**
 * Where "previous chapter" goes: the start of this chapter, or of the one before it when
 * we are already within 3 seconds of this chapter's start. Null when there are no chapters.
 */
function previousChapterStart(chapters, seconds) {
  var list = chapters || []
  var i = -1
  var pos = Number(seconds)
  for (var k = 0; k < list.length; k++) { if (list[k].start <= pos + 0.001) i = k }
  if (i < 0) return list.length ? 0 : null
  if (pos - list[i].start > 3 || i === 0) return list[i].start
  return list[i - 1].start
}

/** Where "next chapter" goes, or null at the last chapter. */
function nextChapterStart(chapters, seconds) {
  var list = chapters || []
  var pos = Number(seconds)
  for (var k = 0; k < list.length; k++) { if (list[k].start > pos + 0.001) return list[k].start }
  return null
}

/**
 * Sleep timers. A timer is a plain object so it can be kept in any state holder:
 *   { mode: 'minutes', endsAt }        stops at a wall-clock time (counts while paused, like a bedside clock)
 *   { mode: 'chapter', endPos }        stops when the whole-book position reaches the end of the chapter
 *                                      that was playing when it was set
 * sleepStart returns null for a chapter timer when the book has no chapters.
 */
function sleepStart(mode, minutes, now, chapters, position) {
  if (mode === 'chapter') {
    var list = chapters || []
    var pos = Number(position)
    for (var k = 0; k < list.length; k++) {
      if (list[k].start <= pos + 0.001 && pos < list[k].end - 0.001) return { mode: 'chapter', endPos: list[k].end }
    }
    return null
  }
  var m = Number(minutes)
  if (!isFinite(m) || m <= 0) return null
  if (m > 720) m = 720
  return { mode: 'minutes', endsAt: Number(now) + m * 60000 }
}

/**
 * What the timer says right now: { done, remaining, fade }.
 *   remaining  seconds until it fires (wall-clock for 'minutes', book seconds for 'chapter')
 *   fade       volume multiplier 0..1: a 10 second fade-out at the end of a minutes timer, 1 otherwise
 */
function sleepStatus(timer, now, position) {
  if (!timer) return { done: false, remaining: 0, fade: 1 }
  var remaining
  if (timer.mode === 'chapter') remaining = timer.endPos - Number(position)
  else remaining = (timer.endsAt - Number(now)) / 1000
  if (!isFinite(remaining)) return { done: false, remaining: 0, fade: 1 }
  if (remaining <= 0.25) return { done: true, remaining: 0, fade: 0 }
  var fade = timer.mode === 'minutes' && remaining < 10 ? Math.max(0, remaining / 10) : 1
  return { done: false, remaining: remaining, fade: fade }
}

/** Add time to a running minutes timer (a tap on "+5 min"); a chapter timer becomes a minutes one. */
function sleepExtend(timer, minutes, now) {
  var m = Number(minutes)
  if (!isFinite(m) || m <= 0) return timer
  var base = timer && timer.mode === 'minutes' && timer.endsAt > now ? timer.endsAt : Number(now)
  var end = base + m * 60000
  var cap = Number(now) + 720 * 60000
  return { mode: 'minutes', endsAt: end > cap ? cap : end }
}

/** 3725 -> "1:02:05", 65 -> "1:05". Used for chapter starts and the whole-book clock. */
function formatClock(seconds) {
  var s = Math.floor(Number(seconds))
  if (!isFinite(s) || s < 0) s = 0
  var h = Math.floor(s / 3600)
  var m = Math.floor((s % 3600) / 60)
  var sec = s % 60
  return (h > 0 ? h + ':' + (m < 10 ? '0' : '') + m : String(m)) + ':' + (sec < 10 ? '0' : '') + sec
}

/** 3725 -> "1 h 2 min"; under a minute "under a minute". For "time left" lines. */
function formatLeft(seconds) {
  var s = Math.round(Number(seconds))
  if (!isFinite(s) || s <= 0) return '0 min'
  if (s < 60) return 'under a minute'
  var h = Math.floor(s / 3600)
  var m = Math.round((s % 3600) / 60)
  if (m === 60) { h += 1; m = 0 }
  return (h > 0 ? h + ' h' : '') + (h > 0 && m > 0 ? ' ' : '') + (m > 0 || h === 0 ? m + ' min' : '')
}

export {
  clampSpeed,
  locate,
  bookPosition,
  chapterIndexAt,
  skipTarget,
  previousChapterStart,
  nextChapterStart,
  sleepStart,
  sleepStatus,
  sleepExtend,
  formatClock,
  formatLeft
}
