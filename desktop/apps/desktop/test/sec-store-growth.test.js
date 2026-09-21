'use strict'
// One person cannot make the owner's settings file (config.json, re-written in full on every change) grow without
// end (security review 2026-09-21, P-3). The old /api/watched route accepts a file name without checking that the
// file exists, so watchedState must bound what it stores per person. (The other routes with the same problem are in
// streamServer.js; see the review notes.)
// Run: node --test test/sec-store-growth.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const watchedState = require('../electron/watchedState')

const fakeStore = () => { const data = {}; return { get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] }, data } }
const count = (store, user) => Object.keys(watchedState.userFiles(store, user)).length

test('watched state: a file name of several megabytes is not stored', () => {
  const store = fakeStore()
  const huge = 'x'.repeat(5 * 1024 * 1024)
  assert.equal(watchedState.setWatched(store, 'u1', [{ kind: 'movie', fileName: huge }], true), 0)
  assert.equal(count(store, 'u1'), 0)
  assert.equal(JSON.stringify(store.data).length < 1000, true, 'nothing big reached the store')
  assert.deepEqual(watchedState.importWatched(store, 'u1', [{ kind: 'movie', fileName: huge }]), [])
  // an ordinary long relative path still works
  const ok = 'Show Name/Season 01/' + 'a'.repeat(200) + '.mkv'
  assert.equal(watchedState.setWatched(store, 'u1', [{ kind: 'tv', fileName: ok }], true), 1)
  assert.equal(watchedState.isWatched(store, 'u1', 'tv', ok), true)
})

test('watched state: the number of files one person can mark is bounded, and existing ones can still be changed', () => {
  const store = fakeStore()
  const items = []
  for (let i = 0; i < 50200; i++) items.push({ kind: 'movie', fileName: `film-${i}.mkv` })
  watchedState.setWatched(store, 'u1', items, true)
  assert.equal(count(store, 'u1'), 50000)
  // a new file beyond the bound is refused, an existing one can still be unmarked and marked again
  assert.equal(watchedState.setWatched(store, 'u1', [{ kind: 'movie', fileName: 'one-more.mkv' }], true), 0)
  assert.equal(count(store, 'u1'), 50000)
  assert.equal(watchedState.setWatched(store, 'u1', [{ kind: 'movie', fileName: 'film-7.mkv' }], false), 1)
  assert.equal(watchedState.isWatched(store, 'u1', 'movie', 'film-7.mkv'), false)
  // the bound is per person
  assert.equal(watchedState.setWatched(store, 'u2', [{ kind: 'movie', fileName: 'film-7.mkv' }], true), 1)
  // and an import cannot get round it
  assert.deepEqual(watchedState.importWatched(store, 'u1', [{ kind: 'movie', fileName: 'imported-new.mkv' }]), [])
})
