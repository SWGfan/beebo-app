'use strict'
// The router's uplink is dead but the Wi-Fi is up: nothing outside is ever answered, so only a timeout ends a wait.
// With a TMDB key saved and a film that was never looked up, this is the case that once held the library page open
// for ever (docs/OFFLINE-FIRST.md, finding F1). Run: node --test test/offline-blackhole.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const { scenario } = require('./helpers/offlineScenario')

test('router uplink dead, nothing ever answers (blackhole), with a TMDB key saved and a title never looked up: pages still open at once', { timeout: 420000 }, async (t) => {
  const r = await scenario(t, { mode: 'blackhole', key: 'offline-test-key-not-real-1234567890' })
  assert.deepEqual(r.problems, [], r.problems.join('\n'))
  assert.deepEqual(r.surprises, [], 'unexpected outbound attempt: ' + JSON.stringify(r.surprises))
  assert.deepEqual(r.outstanding, [], 'every call that got no answer was ended by a timeout or an abort: ' + JSON.stringify(r.outstanding))
  assert.ok(r.h.peakConcurrentHung() <= 2, `at most two calls at once waited on one dead host (saw ${r.h.peakConcurrentHung()}): a pile of them ties up the shared worker threads`)
  assert.doesNotMatch(r.h.output(), /uncaught exception|unhandled rejection/i)
})
