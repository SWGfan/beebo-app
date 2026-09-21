import test from 'node:test'
import assert from 'node:assert/strict'
import { nextFocus, initialFocus, closestTo, score } from '../app/js/nav/spatial.js'
import { keyToAction, directionOf, TIZEN_KEY_NAMES } from '../app/js/nav/keys.js'

// A 3x3 grid of 100x150 posters, 20px apart.
function grid(cols, rows, x0 = 0, y0 = 0, w = 100, h = 150, gap = 20) {
  const out = []
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) out.push({ id: r + ',' + c, x: x0 + c * (w + gap), y: y0 + r * (h + gap), w, h })
  return out
}

test('grid: arrows move one cell', () => {
  const g = grid(3, 3)
  assert.equal(nextFocus(g, '1,1', 'right'), '1,2')
  assert.equal(nextFocus(g, '1,1', 'left'), '1,0')
  assert.equal(nextFocus(g, '1,1', 'down'), '2,1')
  assert.equal(nextFocus(g, '1,1', 'up'), '0,1')
})

test('grid: edges return null (no wrap)', () => {
  const g = grid(3, 3)
  assert.equal(nextFocus(g, '0,0', 'left'), null)
  assert.equal(nextFocus(g, '0,0', 'up'), null)
  assert.equal(nextFocus(g, '2,2', 'right'), null)
  assert.equal(nextFocus(g, '2,2', 'down'), null)
})

test('unknown current id / empty list', () => {
  assert.equal(nextFocus(grid(2, 2), 'nope', 'right'), null)
  assert.equal(nextFocus([], 'x', 'right'), null)
})

test('ragged last row: down from a column with no cell below goes to the nearest one', () => {
  const g = grid(3, 2).filter((r) => r.id !== '1,2') // last row has only 2 cells
  assert.equal(nextFocus(g, '0,2', 'down'), '1,1') // nothing straight below: nearest beyond
  assert.equal(nextFocus(g, '0,1', 'down'), '1,1')
})

test('rows of different widths: Down picks the item under the current one', () => {
  // top row: a wide button at left and a small one at right; below: a rail of posters
  const rects = [
    { id: 'tab-a', x: 0, y: 0, w: 300, h: 60 },
    { id: 'tab-b', x: 320, y: 0, w: 100, h: 60 },
    ...grid(6, 1, 0, 120).map((r) => ({ ...r, id: 'p' + r.id }))
  ]
  // tab-a spans x 0..300 (centre 150) and overlaps posters 0..2; the poster whose centre is nearest (170) wins
  assert.equal(nextFocus(rects, 'tab-a', 'down'), 'p0,1')
  assert.equal(nextFocus(rects, 'tab-b', 'down'), 'p0,3') // centre 370 -> poster at x 360..460
})

test('beam beats a nearer diagonal neighbour', () => {
  const rects = [
    { id: 'cur', x: 100, y: 100, w: 100, h: 100 },
    { id: 'straight', x: 300, y: 100, w: 100, h: 100 }, // same row, 100px gap
    { id: 'near-diag', x: 210, y: 210, w: 100, h: 100 } // closer but not in the beam
  ]
  assert.equal(nextFocus(rects, 'cur', 'right'), 'straight')
})

test('falls back to a non-beam candidate when the beam is empty', () => {
  const rects = [
    { id: 'cur', x: 0, y: 0, w: 100, h: 50 },
    { id: 'lower-right', x: 200, y: 300, w: 100, h: 50 }
  ]
  assert.equal(nextFocus(rects, 'cur', 'right'), 'lower-right')
  assert.equal(nextFocus(rects, 'cur', 'down'), 'lower-right')
})

test('Left/Right stays on the row even if a closer element is on another row', () => {
  const rects = [
    { id: 'cur', x: 0, y: 200, w: 100, h: 100 },
    { id: 'same-row-far', x: 400, y: 200, w: 100, h: 100 },
    { id: 'other-row-near', x: 120, y: 340, w: 100, h: 100 }
  ]
  assert.equal(nextFocus(rects, 'cur', 'right'), 'same-row-far')
})

test('zero-size (hidden) elements are never targets', () => {
  const rects = [
    { id: 'cur', x: 0, y: 0, w: 100, h: 100 },
    { id: 'hidden', x: 150, y: 0, w: 0, h: 0 },
    { id: 'shown', x: 400, y: 0, w: 100, h: 100 }
  ]
  assert.equal(nextFocus(rects, 'cur', 'right'), 'shown')
})

test('overlapping / touching neighbours still count as beyond (tolerance)', () => {
  const rects = [
    { id: 'a', x: 0, y: 0, w: 100, h: 100 },
    { id: 'b', x: 99, y: 0, w: 100, h: 100 } // 1px overlap from rounding
  ]
  assert.equal(nextFocus(rects, 'a', 'right'), 'b')
  assert.equal(nextFocus(rects, 'b', 'left'), 'a')
})

test('a big element and a small one: moving toward each other is symmetric enough to escape', () => {
  const rects = [
    { id: 'hero', x: 0, y: 0, w: 1000, h: 300 },
    { id: 'btn', x: 100, y: 340, w: 200, h: 60 }
  ]
  assert.equal(nextFocus(rects, 'hero', 'down'), 'btn')
  assert.equal(nextFocus(rects, 'btn', 'up'), 'hero')
})

test('score orders candidates by major distance first', () => {
  const from = { x: 0, y: 0, w: 100, h: 100 }
  assert.ok(score('right', from, { x: 150, y: 0, w: 100, h: 100 }) < score('right', from, { x: 400, y: 0, w: 100, h: 100 }))
  assert.ok(score('right', from, { x: 150, y: 0, w: 100, h: 100 }) < score('right', from, { x: 150, y: 90, w: 100, h: 100 }))
})

test('initialFocus: top-most then left-most, ignoring hidden', () => {
  const rects = [
    { id: 'b', x: 300, y: 10, w: 50, h: 50 },
    { id: 'a', x: 100, y: 15, w: 50, h: 50 }, // within 20px of the same row, further left
    { id: 'c', x: 0, y: 200, w: 50, h: 50 },
    { id: 'h', x: 0, y: 0, w: 0, h: 0 }
  ]
  assert.equal(initialFocus(rects), 'a')
  assert.equal(initialFocus([]), null)
})

test('closestTo re-anchors to the nearest centre', () => {
  const g = grid(3, 3)
  assert.equal(closestTo(g, 125, 85), '0,1')
  assert.equal(closestTo([], 0, 0), null)
})

test('walking a full grid with arrows visits every cell exactly as expected', () => {
  const g = grid(4, 3)
  let cur = '0,0'
  const path = []
  for (const d of ['right', 'right', 'right', 'down', 'left', 'left', 'left', 'down', 'right']) {
    const n = nextFocus(g, cur, d)
    if (n) cur = n
    path.push(cur)
  }
  assert.deepEqual(path, ['0,1', '0,2', '0,3', '1,3', '1,2', '1,1', '1,0', '2,0', '2,1'])
})

// ---- keys -----------------------------------------------------------------------------------

test('keys: arrows, enter and both platforms\' Back keys', () => {
  assert.equal(keyToAction({ keyCode: 37 }), 'left')
  assert.equal(keyToAction({ keyCode: 38 }), 'up')
  assert.equal(keyToAction({ keyCode: 39 }), 'right')
  assert.equal(keyToAction({ keyCode: 40 }), 'down')
  assert.equal(keyToAction({ keyCode: 13 }), 'enter')
  assert.equal(keyToAction({ keyCode: 10009 }), 'back') // Tizen
  assert.equal(keyToAction({ keyCode: 461 }), 'back') // webOS
  assert.equal(keyToAction({ keyCode: 8 }), 'back') // desktop dev
  assert.equal(keyToAction({ keyCode: 27 }), 'back')
})

test('keys: media keys', () => {
  assert.equal(keyToAction({ keyCode: 415 }), 'play')
  assert.equal(keyToAction({ keyCode: 19 }), 'pause')
  assert.equal(keyToAction({ keyCode: 10252 }), 'playpause')
  assert.equal(keyToAction({ keyCode: 413 }), 'stop')
  assert.equal(keyToAction({ keyCode: 417 }), 'ff')
  assert.equal(keyToAction({ keyCode: 412 }), 'rw')
  assert.equal(keyToAction({ key: 'MediaPlayPause' }), 'playpause')
})

test('keys: colour keys are ignored gracefully; unknown keys are null (left to the TV)', () => {
  for (const c of [403, 404, 405, 406]) assert.equal(keyToAction({ keyCode: c }), 'ignore')
  assert.equal(keyToAction({ keyCode: 48 }), null) // "0"
  assert.equal(keyToAction({ keyCode: 447 }), null) // volume up
  assert.equal(keyToAction({}), null)
  assert.equal(keyToAction(null), null)
})

test('directionOf and the registered Tizen key list', () => {
  assert.equal(directionOf('left'), 'left')
  assert.equal(directionOf('enter'), null)
  assert.ok(TIZEN_KEY_NAMES.includes('MediaPlayPause'))
  assert.ok(TIZEN_KEY_NAMES.includes('ColorF0Red'))
})
