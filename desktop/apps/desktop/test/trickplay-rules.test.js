// Pure math behind seek-bar preview thumbnails ("trickplay") - no ffmpeg, no filesystem.
// See trickplay.test.js for the real-ffmpeg / HTTP route coverage.
// Run: node --test test/trickplay-rules.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { createRequire } = require('node:module')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))
const tp = localRequire('./electron/trickplayRules')

test('eligibility: only files at least 30s long qualify', () => {
  assert.equal(tp.isEligible(29.9), false)
  assert.equal(tp.isEligible(30), true)
  assert.equal(tp.isEligible(7200), true)
  assert.equal(tp.isEligible(0), false)
  assert.equal(tp.isEligible(null), false)
  assert.equal(tp.isEligible(undefined), false)
  assert.equal(tp.isEligible(NaN), false)
})

test('effective interval: the default, unless a very long file would blow past MAX_THUMBNAILS', () => {
  assert.equal(tp.effectiveIntervalSec(600), tp.DEFAULT_INTERVAL_SEC)
  assert.equal(tp.effectiveIntervalSec(7200), tp.DEFAULT_INTERVAL_SEC)
  // A file long enough that 10s intervals would exceed MAX_THUMBNAILS widens instead.
  const veryLongSec = tp.MAX_THUMBNAILS * tp.DEFAULT_INTERVAL_SEC * 3
  const widened = tp.effectiveIntervalSec(veryLongSec)
  assert.ok(widened > tp.DEFAULT_INTERVAL_SEC)
  assert.ok(tp.countFor(veryLongSec, widened) <= tp.MAX_THUMBNAILS)
  // Ineligible durations just fall back to the requested interval.
  assert.equal(tp.effectiveIntervalSec(5), tp.DEFAULT_INTERVAL_SEC)
  // A bogus interval falls back to the default rather than dividing by zero elsewhere.
  assert.equal(tp.effectiveIntervalSec(600, 0), tp.DEFAULT_INTERVAL_SEC)
  assert.equal(tp.effectiveIntervalSec(600, -5), tp.DEFAULT_INTERVAL_SEC)
})

test('count: one frame at t=0 plus one every interval, floored', () => {
  assert.equal(tp.countFor(95, 10), 10) // 0,10,...,90
  assert.equal(tp.countFor(100, 10), 11) // 0,10,...,100
  assert.equal(tp.countFor(29, 10), 0, 'too short to be eligible at all')
  assert.equal(tp.countFor(600, 0), 0, 'a zero interval never divides')
})

test('frame index: nearest frame to a requested timestamp, clamped to what was generated', () => {
  const count = tp.countFor(95, 10) // 10 frames: indices 0..9, covering t=0..90
  assert.equal(tp.frameIndexFor(0, 10, count), 0)
  assert.equal(tp.frameIndexFor(4, 10, count), 0) // rounds to the nearer frame
  assert.equal(tp.frameIndexFor(5, 10, count), 1) // exactly halfway rounds up (Math.round)
  assert.equal(tp.frameIndexFor(33, 10, count), 3)
  assert.equal(tp.frameIndexFor(1000, 10, count), count - 1, 'never past the last real frame')
  assert.equal(tp.frameIndexFor(-5, 10, count), 0, 'never before the first')
  assert.equal(tp.frameIndexFor(10, 10, 0), -1, 'nothing generated -> no frame at all')
})

test('frame file names are zero-padded and match -start_number 0', () => {
  assert.equal(tp.frameFileName(0), '000000.jpg')
  assert.equal(tp.frameFileName(7), '000007.jpg')
  assert.equal(tp.frameFileName(123456), '123456.jpg')
  assert.equal(tp.frameFileName(-3), '000000.jpg', 'never a negative index')
})

test('cache key changes with the file version and the generation settings', () => {
  const a = tp.cacheKeyFor('/movies/x.mkv', 1000, 5000, 10, 160)
  assert.match(a, /^[0-9a-f]{40}$/)
  assert.equal(tp.cacheKeyFor('/movies/x.mkv', 1000, 5000, 10, 160), a, 'same inputs -> same key')
  assert.notEqual(tp.cacheKeyFor('/movies/x.mkv', 1001, 5000, 10, 160), a, 'different size (re-encoded file)')
  assert.notEqual(tp.cacheKeyFor('/movies/x.mkv', 1000, 5001, 10, 160), a, 'different mtime (replaced file)')
  assert.notEqual(tp.cacheKeyFor('/movies/x.mkv', 1000, 5000, 20, 160), a, 'different interval')
  assert.notEqual(tp.cacheKeyFor('/movies/x.mkv', 1000, 5000, 10, 320), a, 'different width')
})

test('ffmpeg args: one pass, key frames only, fps filter at the chosen interval, scaled, never upscaled', () => {
  const args = tp.ffmpegArgs('/movies/x.mkv', 10, 160, '/tmp/out/%06d.jpg')
  assert.deepEqual(args, [
    '-hide_banner', '-nostdin', '-v', 'error', '-y',
    '-skip_frame', 'nokey',
    '-protocol_whitelist', 'file,crypto,pipe', '-i', 'file:/movies/x.mkv',
    '-an', '-sn', '-dn',
    '-vf', "fps=1/10,scale='min(160,iw)':-2",
    '-start_number', '0',
    '-qscale:v', '4',
    '/tmp/out/%06d.jpg'
  ])
})

test('ffmpeg args: the full-decode fallback simply leaves the key-frame flag out', () => {
  const args = tp.ffmpegArgs('/movies/x.mkv', 10, 160, '/tmp/out/%06d.jpg', { keyframesOnly: false })
  assert.equal(args.includes('-skip_frame'), false)
  assert.deepEqual(args.slice(args.indexOf('-protocol_whitelist')), ['-protocol_whitelist', 'file,crypto,pipe', '-i', 'file:/movies/x.mkv', '-an', '-sn', '-dn', '-vf', "fps=1/10,scale='min(160,iw)':-2", '-start_number', '0', '-qscale:v', '4', '/tmp/out/%06d.jpg'])
})

test('identity: path + size + mtime, independent of interval and width', () => {
  assert.equal(tp.identityFor('/m/x.mkv', 10, 20), '/m/x.mkv|10|20')
})
