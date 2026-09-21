'use strict'
// ============================================================================
// trickplayRules.js - the math behind seek-bar preview thumbnails ("trickplay"),
// free of ffmpeg/fs so it can be unit tested on its own. The ffmpeg invocation,
// disk cache and HTTP routes that use this live in playbackApi.js, right next
// to the rest of "Quality & audio" - see the comment at the top of that file.
//
// One small JPEG every intervalSec of video, generated with a SINGLE ffmpeg
// pass (an `fps=1/N` filter, not one -ss seek per thumbnail - seeking into a
// two-hour film ~720 separate times to get a frame every 10s would be far
// slower and harder on the disk than decoding it once and dropping a frame
// every N seconds on the way through).
// ============================================================================

const crypto = require('crypto')

const DEFAULT_INTERVAL_SEC = 10
const DEFAULT_WIDTH = 160
// Shorter than this, a scrub bar is only ever a few seconds wide anyway - previews add
// ffmpeg work for something nobody would notice.
const MIN_DURATION_SEC = 30
// Guards a pathologically long recording (a multi-day security camera dump, say) from turning
// into tens of thousands of tiny files; the interval widens instead - see effectiveIntervalSec.
const MAX_THUMBNAILS = 2000

/** Is this file worth generating previews for at all? Unknown/zero duration never qualifies. */
function isEligible(durationSec) {
  return typeof durationSec === 'number' && isFinite(durationSec) && durationSec >= MIN_DURATION_SEC
}

/**
 * The interval actually used to generate thumbnails: normally [interval], widened just enough
 * that an extremely long file still produces at most MAX_THUMBNAILS frames.
 */
function effectiveIntervalSec(durationSec, interval = DEFAULT_INTERVAL_SEC) {
  const base = interval > 0 ? interval : DEFAULT_INTERVAL_SEC
  if (!isEligible(durationSec)) return base
  const widened = Math.ceil(durationSec / MAX_THUMBNAILS)
  return Math.max(base, widened)
}

/** How many thumbnails a file of this length produces: one at t=0, then one every intervalSec. */
function countFor(durationSec, intervalSec) {
  if (!isEligible(durationSec) || !(intervalSec > 0)) return 0
  return Math.min(MAX_THUMBNAILS, Math.floor(durationSec / intervalSec) + 1)
}

/**
 * The 0-based frame index nearest [t] seconds into the file, clamped to what was actually
 * generated. Used both to name ffmpeg's output frames (-start_number 0) and to look one up.
 */
function frameIndexFor(t, intervalSec, count) {
  if (!(count > 0)) return -1
  const wanted = Math.round((Number(t) || 0) / intervalSec)
  return Math.max(0, Math.min(count - 1, wanted))
}

/** ffmpeg names frames 000000.jpg, 000001.jpg, ... (see ffmpegArgs's -start_number 0). */
function frameFileName(index) {
  return String(Math.max(0, index)).padStart(6, '0') + '.jpg'
}

/**
 * A cache key stable for one file version (path + size + mtime) and one set of generation
 * settings - a re-encoded or replaced file (different size/mtime) gets a fresh set rather than
 * silently reusing stale frames.
 */
function cacheKeyFor(filePath, sizeBytes, mtimeMs, intervalSec, width) {
  return crypto.createHash('sha1').update(`${filePath}|${sizeBytes}|${mtimeMs}|${intervalSec}|${width}`).digest('hex')
}

/**
 * A file's identity for "is there already a set for it?" without knowing its duration (the cache
 * key depends on the interval, which depends on the duration): path + size + mtime.
 */
function identityFor(filePath, sizeBytes, mtimeMs) {
  return `${filePath}|${sizeBytes}|${mtimeMs}`
}

/**
 * The one ffmpeg invocation that produces every frame for a file, in a single pass. No -vsync/
 * -fps_mode is needed: the fps filter alone decides which frames come out, so there's nothing
 * left for the muxer to duplicate or drop.
 *
 * keyframesOnly decodes just the I-frames (about a tenth of the work of a full decode on a normal
 * file); the fps filter repeats the nearest earlier one to fill the gaps, so a file with a long
 * GOP still gets one image per interval. Some files carry unreliable keyframe flags and produce
 * nothing that way, hence the full-decode fallback the caller runs when a pass yields no frames.
 */
function ffmpegArgs(filePath, intervalSec, width, outPattern, { keyframesOnly = true } = {}) {
  return [
    '-hide_banner', '-nostdin', '-v', 'error', '-y',
    ...(keyframesOnly ? ['-skip_frame', 'nokey'] : []),
    ...require('./ffmpegArgs').inputArgs(filePath), // file: prefix + protocol whitelist (review F9)
    '-an', '-sn', '-dn',
    '-vf', `fps=1/${intervalSec},scale='min(${width},iw)':-2`,
    '-start_number', '0',
    '-qscale:v', '4',
    outPattern
  ]
}

module.exports = {
  DEFAULT_INTERVAL_SEC,
  DEFAULT_WIDTH,
  MIN_DURATION_SEC,
  MAX_THUMBNAILS,
  isEligible,
  effectiveIntervalSec,
  countFor,
  frameIndexFor,
  frameFileName,
  cacheKeyFor,
  identityFor,
  ffmpegArgs
}
