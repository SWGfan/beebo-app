// The audiobook player's arithmetic: speed limits, finding the part and chapter for a position,
// skipping, sleep timers, clocks. The same functions ship in three places (the CommonJS module, the
// website page which inlines them, the React copy in src/lib); this file also checks the copies agree.
// Run: node --test test/audiobook-player.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { createRequire } = require('node:module')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))
const p = localRequire('./electron/audiobookPlayer')
const web = localRequire('./electron/audiobookWeb')
const loadEsm = () => import(pathToFileURL(path.join(appRoot, 'src', 'lib', 'audiobookPlayer.js')).href)

const parts = [{ start: 0, duration: 100 }, { start: 100, duration: 200 }, { start: 300, duration: 50 }]
const chapters = [{ title: 'A', start: 0, end: 120 }, { title: 'B', start: 120, end: 300 }, { title: 'C', start: 300, end: 350 }]

test('clampSpeed: 0.5x to 3x in 0.05 steps, junk becomes 1', () => {
  assert.equal(p.clampSpeed(1), 1)
  assert.equal(p.clampSpeed(0.5), 0.5)
  assert.equal(p.clampSpeed(0.2), 0.5)
  assert.equal(p.clampSpeed(3), 3)
  assert.equal(p.clampSpeed(7), 3)
  assert.equal(p.clampSpeed(1.234), 1.25)
  assert.equal(p.clampSpeed('1.5'), 1.5)
  for (const junk of [NaN, 0, -1, 'fast', null, undefined, Infinity]) assert.equal(p.clampSpeed(junk), 1, String(junk))
})

test('locate and bookPosition: whole-book seconds <-> part + offset', () => {
  assert.deepEqual(p.locate(parts, 0), { index: 0, offset: 0 })
  assert.deepEqual(p.locate(parts, 99.5), { index: 0, offset: 99.5 })
  assert.deepEqual(p.locate(parts, 100), { index: 1, offset: 0 })
  assert.deepEqual(p.locate(parts, 320), { index: 2, offset: 20 })
  assert.deepEqual(p.locate(parts, 9999), { index: 2, offset: 50 }, 'parked at the end of the last part')
  assert.deepEqual(p.locate(parts, -5), { index: 0, offset: 0 })
  assert.deepEqual(p.locate(parts, NaN), { index: 0, offset: 0 })
  assert.deepEqual(p.locate([], 10), { index: 0, offset: 0 })
  assert.equal(p.bookPosition(parts, 1, 25), 125)
  assert.equal(p.bookPosition(parts, 2, -3), 300)
  assert.equal(p.bookPosition(parts, 9, 5), 0)
  for (const s of [0, 42.5, 100, 250, 349]) {
    const l = p.locate(parts, s)
    assert.equal(p.bookPosition(parts, l.index, l.offset), s, 'round trip ' + s)
  }
})

test('chapterIndexAt and chapter jumps', () => {
  assert.equal(p.chapterIndexAt(chapters, 0), 0)
  assert.equal(p.chapterIndexAt(chapters, 119.99), 0)
  assert.equal(p.chapterIndexAt(chapters, 120), 1)
  assert.equal(p.chapterIndexAt(chapters, 1e6), 2)
  assert.equal(p.chapterIndexAt(chapters, -1), -1)
  assert.equal(p.chapterIndexAt([{ start: 10 }], 5), -1, 'before the first chapter')
  assert.equal(p.chapterIndexAt([], 5), -1)
  assert.equal(p.chapterIndexAt(null, 5), -1)
  // "previous" restarts a chapter you are well into, and goes back one when you have just started it.
  assert.equal(p.previousChapterStart(chapters, 200), 120)
  assert.equal(p.previousChapterStart(chapters, 121), 0)
  assert.equal(p.previousChapterStart(chapters, 1), 0)
  assert.equal(p.previousChapterStart([], 5), null)
  assert.equal(p.nextChapterStart(chapters, 0), 120)
  assert.equal(p.nextChapterStart(chapters, 120), 300)
  assert.equal(p.nextChapterStart(chapters, 310), null)
  assert.equal(p.nextChapterStart([], 0), null)
})

test('skipTarget stays inside the book', () => {
  assert.equal(p.skipTarget(100, -15, 1000), 85)
  assert.equal(p.skipTarget(100, 30, 1000), 130)
  assert.equal(p.skipTarget(5, -15, 1000), 0)
  assert.equal(p.skipTarget(990, 30, 1000), 1000)
  assert.equal(p.skipTarget(990, 30, 0), 1020, 'unknown length: no upper bound')
  assert.equal(p.skipTarget(NaN, 30, 1000), 0)
})

test('sleep timers: minutes, end of chapter, extending, fade-out', () => {
  const t0 = 1_000_000
  const timer = p.sleepStart('minutes', 30, t0)
  assert.deepEqual(timer, { mode: 'minutes', endsAt: t0 + 30 * 60000 })
  assert.equal(p.sleepStart('minutes', 0, t0), null)
  assert.equal(p.sleepStart('minutes', 'abc', t0), null)
  assert.equal(p.sleepStart('minutes', 99999, t0).endsAt, t0 + 720 * 60000, 'capped at 12 hours')

  let st = p.sleepStatus(timer, t0, 0)
  assert.equal(st.done, false)
  assert.equal(st.remaining, 1800)
  assert.equal(st.fade, 1)
  st = p.sleepStatus(timer, t0 + 30 * 60000 - 5000, 0)
  assert.equal(st.remaining, 5)
  assert.equal(st.fade, 0.5, 'fades over the last 10 seconds')
  assert.equal(p.sleepStatus(timer, t0 + 30 * 60000, 0).done, true)
  assert.equal(p.sleepStatus(timer, t0 + 31 * 60000, 0).fade, 0)
  assert.deepEqual(p.sleepStatus(null, t0, 0), { done: false, remaining: 0, fade: 1 })

  const ch = p.sleepStart('chapter', 0, t0, chapters, 130)
  assert.deepEqual(ch, { mode: 'chapter', endPos: 300 })
  assert.equal(p.sleepStatus(ch, t0, 130).remaining, 170)
  assert.equal(p.sleepStatus(ch, t0, 130).fade, 1, 'no fade for a chapter timer')
  assert.equal(p.sleepStatus(ch, t0 + 999999, 299.9).done, true, 'wall-clock time does not matter for a chapter timer')
  assert.equal(p.sleepStatus(ch, t0, 250).done, false)
  assert.equal(p.sleepStart('chapter', 0, t0, [], 5), null, 'no chapters, no chapter timer')
  assert.equal(p.sleepStart('chapter', 0, t0, chapters, 999), null)

  const extended = p.sleepExtend(timer, 5, t0 + 60000)
  assert.equal(extended.endsAt, t0 + 35 * 60000)
  assert.equal(p.sleepExtend(ch, 5, t0).mode, 'minutes', 'a chapter timer becomes a minutes one')
  assert.equal(p.sleepExtend(null, 5, t0).endsAt, t0 + 5 * 60000)
  assert.equal(p.sleepExtend(timer, -5, t0), timer)
})

test('clocks', () => {
  assert.equal(p.formatClock(0), '0:00')
  assert.equal(p.formatClock(65), '1:05')
  assert.equal(p.formatClock(3725), '1:02:05')
  assert.equal(p.formatClock(36000), '10:00:00')
  assert.equal(p.formatClock(-4), '0:00')
  assert.equal(p.formatClock('x'), '0:00')
  assert.equal(p.formatLeft(3725), '1 h 2 min')
  assert.equal(p.formatLeft(7200), '2 h')
  assert.equal(p.formatLeft(600), '10 min')
  assert.equal(p.formatLeft(30), 'under a minute')
  assert.equal(p.formatLeft(0), '0 min')
  assert.equal(p.formatLeft(3570), '1 h', '59.5 minutes rounds up to the hour')
})

test('every player function is self-contained (they are inlined into the website page by toString)', () => {
  for (const [name, fn] of Object.entries(p)) {
    const src = fn.toString()
    // Rebuild the function alone, in an empty scope, and run it: any outside reference would throw.
    const alone = new Function('return (' + src + ')')()
    assert.equal(typeof alone, 'function', name)
    for (const other of Object.keys(p)) if (other !== name) assert.ok(!new RegExp('\\b' + other + '\\(').test(src), `${name} must not call ${other}`)
  }
  for (const name of Object.keys(p)) assert.ok(web.INLINED.includes('function ' + name + '('), name + ' is on the website page')
})

test('the React copy in src/lib is the same code', async () => {
  const esm = await loadEsm()
  assert.deepEqual(Object.keys(esm).sort(), Object.keys(p).sort())
  for (const name of Object.keys(p)) assert.equal(esm[name].toString(), p[name].toString(), name + ' differs between electron/audiobookPlayer.js and src/lib/audiobookPlayer.js')
  assert.equal(esm.clampSpeed(9), 3)
  assert.equal(esm.formatClock(3725), '1:02:05')
  const text = fs.readFileSync(path.join(appRoot, 'src', 'lib', 'audiobookPlayer.js'), 'utf8')
  assert.ok(!/module\.exports/.test(text))
})
