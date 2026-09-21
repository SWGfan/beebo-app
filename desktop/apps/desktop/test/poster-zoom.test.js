// Poster size for the library grids (src/lib/posterZoom.js): the clamp / step / wheel maths,
// the slider mapping, which text density a size gets, and the frame-coalescing store behind
// the slider and Alt/Ctrl+wheel. No DOM: raf and the save timer are fakes.
// Run: node --test test/poster-zoom.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const appRoot = path.resolve(__dirname, '..')
const load = () => import(pathToFileURL(path.join(appRoot, 'src', 'lib', 'posterZoom.js')).href)

test('the default size is today\'s grid (160px columns) and is within range', async () => {
  const Z = await load()
  assert.equal(Z.POSTER_DEFAULT, 160)
  assert.ok(Z.POSTER_MIN < Z.POSTER_DEFAULT && Z.POSTER_DEFAULT < Z.POSTER_MAX)
  const css = fs.readFileSync(path.join(appRoot, 'src', 'styles.css'), 'utf8')
  assert.match(css, /minmax\(var\(--poster-size, 160px\), 1fr\)/, 'the grid falls back to the original 160px')
})

test('clamping keeps every value inside the range and rejects non-numbers', async () => {
  const Z = await load()
  assert.equal(Z.clampPosterSize(5), Z.POSTER_MIN)
  assert.equal(Z.clampPosterSize(99999), Z.POSTER_MAX)
  assert.equal(Z.clampPosterSize(200), 200)
  for (const bad of [NaN, undefined, null, '', 'wide', true, Infinity]) assert.equal(Z.clampPosterSize(bad), Z.POSTER_DEFAULT)
  assert.equal(Z.clampPosterSize('180'), 180)
})

test('the slider is monotonic, hits both ends and round-trips every position', async () => {
  const Z = await load()
  assert.equal(Z.sliderToSize(0), Z.POSTER_MIN)
  assert.equal(Z.sliderToSize(Z.SLIDER_STEPS), Z.POSTER_MAX)
  assert.equal(Z.sizeToSlider(Z.POSTER_MIN), 0)
  assert.equal(Z.sizeToSlider(Z.POSTER_MAX), Z.SLIDER_STEPS)
  let last = 0
  for (let p = 0; p <= Z.SLIDER_STEPS; p += 1) {
    const size = Z.sliderToSize(p)
    assert.ok(size >= last, `position ${p} must not shrink`)
    last = size
    assert.equal(Z.sizeToSlider(size), p, `position ${p} round-trips`)
  }
  assert.equal(Z.sliderToSize(-40), Z.POSTER_MIN)
  assert.equal(Z.sliderToSize(400), Z.POSTER_MAX)
})

test('dragging the slider can land exactly on the original size', async () => {
  const Z = await load()
  assert.equal(Z.sliderToSize(Z.sizeToSlider(Z.POSTER_DEFAULT)), Z.POSTER_DEFAULT)
})

test('the slider is logarithmic: the default sits well below the middle of a linear scale', async () => {
  const Z = await load()
  const at = Z.sizeToSlider(Z.POSTER_DEFAULT)
  assert.ok(at > 30 && at < 55, `default at ${at}`)
})

test('stepping moves by at least a pixel, never stalls, and stops at the limits', async () => {
  const Z = await load()
  let size = Z.POSTER_DEFAULT
  const seen = new Set([size])
  for (let i = 0; i < 40; i += 1) {
    const next = Z.stepPosterSize(size, 1)
    assert.ok(next >= size)
    if (next === Z.POSTER_MAX) break
    assert.ok(next > size, 'a bigger step always changes the size')
    assert.ok(!seen.has(next))
    seen.add(next)
    size = next
  }
  assert.equal(Z.stepPosterSize(Z.POSTER_MAX, 1), Z.POSTER_MAX)
  assert.equal(Z.stepPosterSize(Z.POSTER_MIN, -1), Z.POSTER_MIN)
  assert.ok(Z.stepPosterSize(Z.POSTER_MIN + 1, 1) > Z.POSTER_MIN + 1)
  assert.ok(Z.stepPosterSize(Z.POSTER_MIN + 1, -1) === Z.POSTER_MIN)
})

test('the wheel: scrolling up (negative delta) makes posters bigger, down smaller, clamped', async () => {
  const Z = await load()
  assert.ok(Z.wheelPosterSize(160, -100) > 160)
  assert.ok(Z.wheelPosterSize(160, 100) < 160)
  assert.equal(Z.wheelPosterSize(160, 0), 160)
  assert.equal(Z.wheelPosterSize(160, NaN), 160)
  assert.equal(Z.wheelPosterSize(Z.POSTER_MAX, -10000), Z.POSTER_MAX)
  assert.equal(Z.wheelPosterSize(Z.POSTER_MIN, 10000), Z.POSTER_MIN)
  assert.ok(Z.wheelPosterSize(160, 3) < 160 && Z.wheelPosterSize(160, 3) >= 158, 'a trackpad pinch nudge is a small change')
  assert.ok(Z.wheelPosterSize(160, 3, 1) < Z.wheelPosterSize(160, 3, 0), 'line-mode deltas count for more than pixel-mode')
  assert.ok(Z.wheelPosterSize(160, 1, 2) < Z.wheelPosterSize(160, 1, 1), 'and page-mode more still')
})

test('a mouse wheel crosses the whole range in a sensible number of notches', async () => {
  const Z = await load()
  let size = Z.POSTER_MIN
  let notches = 0
  while (size < Z.POSTER_MAX && notches < 100) { size = Z.wheelPosterSize(size, -100); notches += 1 }
  assert.ok(notches >= 5 && notches <= 15, `${notches} notches from smallest to largest`)
})

test('only Alt or Ctrl with the wheel is a zoom gesture; plain and Shift wheel keep scrolling', async () => {
  const Z = await load()
  assert.equal(Z.isPosterZoomWheel({ altKey: true }), true)
  assert.equal(Z.isPosterZoomWheel({ ctrlKey: true }), true)
  assert.equal(Z.isPosterZoomWheel({}), false)
  assert.equal(Z.isPosterZoomWheel({ shiftKey: true }), false)
  assert.equal(Z.isPosterZoomWheel({ ctrlKey: true, shiftKey: true }), false)
  assert.equal(Z.isPosterZoomWheel({ metaKey: true }), false)
  assert.equal(Z.isPosterZoomWheel(null), false)
})

test('keyboard zoom is Alt+plus/minus/0 only, so Ctrl+plus/minus stays the whole-window zoom', async () => {
  const Z = await load()
  assert.equal(Z.posterZoomKeyAction({ altKey: true, key: '+' }), 'bigger')
  assert.equal(Z.posterZoomKeyAction({ altKey: true, key: '=' }), 'bigger')
  assert.equal(Z.posterZoomKeyAction({ altKey: true, key: '-' }), 'smaller')
  assert.equal(Z.posterZoomKeyAction({ altKey: true, key: '0' }), 'reset')
  assert.equal(Z.posterZoomKeyAction({ ctrlKey: true, key: '+' }), null)
  assert.equal(Z.posterZoomKeyAction({ ctrlKey: true, key: '-' }), null)
  assert.equal(Z.posterZoomKeyAction({ ctrlKey: true, key: '0' }), null)
  assert.equal(Z.posterZoomKeyAction({ altKey: true, ctrlKey: true, key: '0' }), null, 'AltGr types characters')
  assert.equal(Z.posterZoomKeyAction({ key: '+' }), null)
  assert.equal(Z.posterZoomKeyAction({ altKey: true, key: 'a' }), null)
})

test('text density: the default keeps the original card, smaller sizes drop detail', async () => {
  const Z = await load()
  assert.equal(Z.densityFor(Z.POSTER_DEFAULT), 'full')
  assert.equal(Z.densityFor(Z.POSTER_MIN), 'mini')
  assert.equal(Z.densityFor(109.9), 'mini')
  assert.equal(Z.densityFor(110), 'compact')
  assert.equal(Z.densityFor(139.9), 'compact')
  assert.equal(Z.densityFor(140), 'full')
  assert.equal(Z.densityFor(239.9), 'full')
  assert.equal(Z.densityFor(240), 'large')
  assert.equal(Z.densityFor(Z.POSTER_MAX), 'large')
})

test('keeping the poster near the top in place: the scroll offset absorbs how far it moved', async () => {
  const Z = await load()
  assert.equal(Z.anchoredScrollTop(1000, 120, 120), 1000)
  assert.equal(Z.anchoredScrollTop(1000, 120, 120.3), 1000, 'sub-pixel drift is ignored')
  assert.equal(Z.anchoredScrollTop(1000, 120, 320), 1200, 'it moved down 200px, scroll down 200px')
  assert.equal(Z.anchoredScrollTop(1000, 120, 20), 900)
  assert.equal(Z.anchoredScrollTop(50, 120, -500), 0, 'never negative')
  assert.equal(Z.anchoredScrollTop(1000, NaN, 5), 1000)
})

function fakeEnv() {
  let frameId = 0
  const frames = new Map()
  let timerId = 0
  const timers = new Map()
  return {
    raf: (fn) => { frameId += 1; frames.set(frameId, fn); return frameId },
    caf: (id) => frames.delete(id),
    setTimer: (fn, ms) => { timerId += 1; timers.set(timerId, { fn, ms }); return timerId },
    clearTimer: (id) => timers.delete(id),
    runFrames() { const all = [...frames.values()]; frames.clear(); all.forEach((fn) => fn()) },
    fireTimers() { const all = [...timers.values()]; timers.clear(); all.forEach((t) => t.fn()) },
    pendingFrames: () => frames.size,
    pendingTimers: () => timers.size
  }
}

test('a burst of wheel events compounds on the latest size but paints once per frame', async () => {
  const Z = await load()
  const env = fakeEnv()
  const painted = []
  const saved = []
  const zoom = Z.createPosterZoom({ apply: (s) => painted.push(s), save: (s) => saved.push(s), raf: env.raf, caf: env.caf, setTimer: env.setTimer, clearTimer: env.clearTimer })
  for (let i = 0; i < 6; i += 1) zoom.wheel(-100)
  assert.equal(env.pendingFrames(), 1)
  assert.deepEqual(painted, [])
  const target = zoom.getSize()
  assert.ok(target > Z.POSTER_DEFAULT * 1.5, 'six notches compound')
  env.runFrames()
  assert.deepEqual(painted, [target])
  assert.equal(env.pendingTimers(), 1, 'saving is debounced into a single write')
  assert.deepEqual(saved, [])
  env.fireTimers()
  assert.deepEqual(saved, [Math.round(target)])
})

test('changes that stop at a limit or do not change the size paint nothing', async () => {
  const Z = await load()
  const env = fakeEnv()
  const painted = []
  const zoom = Z.createPosterZoom({ initial: Z.POSTER_MAX, apply: (s) => painted.push(s), raf: env.raf, caf: env.caf, setTimer: env.setTimer, clearTimer: env.clearTimer })
  zoom.bigger()
  zoom.wheel(-500)
  zoom.set(Z.POSTER_MAX)
  assert.equal(env.pendingFrames(), 0)
  env.runFrames()
  assert.deepEqual(painted, [])
})

test('hydrating from storage paints but is not written straight back', async () => {
  const Z = await load()
  const env = fakeEnv()
  const painted = []
  const saved = []
  const zoom = Z.createPosterZoom({ apply: (s) => painted.push(s), save: (s) => saved.push(s), raf: env.raf, caf: env.caf, setTimer: env.setTimer, clearTimer: env.clearTimer })
  zoom.hydrate(220)
  env.runFrames()
  assert.deepEqual(painted, [220])
  assert.equal(env.pendingTimers(), 0)
  assert.deepEqual(saved, [])
})

test('reset returns to the default and saves it; listeners hear about each painted frame', async () => {
  const Z = await load()
  const env = fakeEnv()
  const saved = []
  const zoom = Z.createPosterZoom({ initial: 250, save: (s) => saved.push(s), raf: env.raf, caf: env.caf, setTimer: env.setTimer, clearTimer: env.clearTimer })
  let heard = 0
  const off = zoom.subscribe(() => { heard += 1 })
  zoom.reset()
  assert.equal(zoom.getSize(), Z.POSTER_DEFAULT)
  env.runFrames()
  env.fireTimers()
  assert.equal(heard, 1)
  assert.deepEqual(saved, [Z.POSTER_DEFAULT])
  off()
  zoom.smaller()
  env.runFrames()
  assert.equal(heard, 1)
})

test('applyNow paints immediately and cancels the pending frame; dispose drops timers', async () => {
  const Z = await load()
  const env = fakeEnv()
  const painted = []
  const zoom = Z.createPosterZoom({ apply: (s) => painted.push(s), raf: env.raf, caf: env.caf, setTimer: env.setTimer, clearTimer: env.clearTimer })
  zoom.set(200)
  zoom.applyNow()
  assert.deepEqual(painted, [200])
  assert.equal(env.pendingFrames(), 0)
  zoom.bigger()
  zoom.dispose()
  assert.equal(env.pendingFrames(), 0)
  assert.equal(env.pendingTimers(), 0)
})
