const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { createRequire } = require('node:module')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))
const castCredits = localRequire('./electron/castCredits')

test('parseCast: maps id, name, character and profile path, capped at the limit', () => {
  const data = { cast: [
    { id: 1, name: 'A', character: 'Hero', profile_path: '/a.jpg' },
    { id: 2, name: 'B', character: 'Villain', profile_path: null },
    { id: 3, name: 'C', character: '', profile_path: '/c.jpg' }
  ] }
  const cast = castCredits.parseCast(data, 2)
  assert.equal(cast.length, 2)
  assert.deepEqual(cast[0], { id: 1, name: 'A', character: 'Hero', profilePath: '/a.jpg' })
  assert.deepEqual(cast[1], { id: 2, name: 'B', character: 'Villain', profilePath: null })
})

test('parseCast: an empty character string reads as null, same as a missing one', () => {
  const cast = castCredits.parseCast({ cast: [{ id: 3, name: 'C', character: '', profile_path: null }] })
  assert.equal(cast[0].character, null)
})

test('parseCast: no cast array, or no data at all, is an empty list, never a throw', () => {
  assert.deepEqual(castCredits.parseCast({}), [])
  assert.deepEqual(castCredits.parseCast(null), [])
  assert.deepEqual(castCredits.parseCast(undefined), [])
})

test('parseCast: defaults to DEFAULT_CAST_LIMIT when no limit is given', () => {
  const data = { cast: Array.from({ length: 30 }, (_, i) => ({ id: i, name: 'N' + i, character: 'C' + i })) }
  assert.equal(castCredits.parseCast(data).length, castCredits.DEFAULT_CAST_LIMIT)
})

test('isStaleCast: a populated array from before `character` existed is stale', () => {
  assert.equal(castCredits.isStaleCast([{ id: 1, name: 'A', profilePath: null }]), true)
})

test('isStaleCast: a freshly-parsed cast (character present, even null) is not stale', () => {
  assert.equal(castCredits.isStaleCast([{ id: 1, name: 'A', character: null, profilePath: null }]), false)
  assert.equal(castCredits.isStaleCast([{ id: 1, name: 'A', character: 'Hero', profilePath: null }]), false)
})

test('isStaleCast: an empty array is a real answer ("no cast found"), not a stale one', () => {
  assert.equal(castCredits.isStaleCast([]), false)
})

test('isStaleCast: anything that is not an array (undefined, null) is not stale', () => {
  assert.equal(castCredits.isStaleCast(undefined), false)
  assert.equal(castCredits.isStaleCast(null), false)
})
