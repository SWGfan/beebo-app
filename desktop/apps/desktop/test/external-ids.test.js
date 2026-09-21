'use strict'
// TMDB id -> IMDb / TVDB id cache used by playback events: answers instantly from what is known,
// fills in from TMDB in the background, remembers across restarts, and does not hammer a failing lookup.
// Run: node --test test/external-ids.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createExternalIds, FILE_NAME, TTL_MS } = require('../electron/externalIds')

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-extids-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function fakeApi(answers) {
  const calls = []
  return { calls, get: async (p) => { calls.push(p); const a = answers[p]; return a === undefined ? { ok: false, status: 404 } : { ok: true, data: a } } }
}

test('peek is instant and empty until a lookup has happened; warm fetches once and then peek has it', async (t) => {
  const api = fakeApi({ '/movie/949/external_ids': { id: 949, imdb_id: 'tt0113277' }, '/tv/95396/external_ids': { id: 95396, imdb_id: 'tt11280740', tvdb_id: 371980 } })
  const ids = createExternalIds({ getApi: () => api, getCacheDir: () => tmpDir(t) })
  assert.equal(ids.peek('movie', 949), null)
  assert.deepEqual(await ids.warm('movie', 949), { imdb: 'tt0113277', tvdb: null })
  assert.deepEqual(ids.peek('movie', 949), { imdb: 'tt0113277', tvdb: null })
  assert.deepEqual(await ids.warm('tv', 95396), { imdb: 'tt11280740', tvdb: 371980 })
  assert.deepEqual(ids.peek('tv', 95396), { imdb: 'tt11280740', tvdb: 371980 })
  await ids.warm('movie', 949)
  assert.deepEqual(api.calls, ['/movie/949/external_ids', '/tv/95396/external_ids'], 'a known id is not fetched again')
  // A movie has no TVDB id whatever TMDB says.
  const odd = createExternalIds({ getApi: () => fakeApi({ '/movie/1/external_ids': { imdb_id: 'tt0000001', tvdb_id: 5 } }), getCacheDir: () => tmpDir(t) })
  assert.deepEqual(await odd.warm('movie', 1), { imdb: 'tt0000001', tvdb: null })
})

test('concurrent lookups of one title make one request', async (t) => {
  const api = fakeApi({ '/movie/949/external_ids': { imdb_id: 'tt0113277' } })
  const ids = createExternalIds({ getApi: () => api, getCacheDir: () => tmpDir(t) })
  await Promise.all([ids.warm('movie', 949), ids.warm('movie', 949), ids.warm('movie', 949)])
  assert.equal(api.calls.length, 1)
})

test('the cache is a file beside the TMDB cache and survives a restart', async (t) => {
  const dir = tmpDir(t)
  const a = createExternalIds({ getApi: () => fakeApi({ '/movie/949/external_ids': { imdb_id: 'tt0113277' } }), getCacheDir: () => dir })
  await a.warm('movie', 949)
  a.flush()
  assert.ok(fs.existsSync(path.join(dir, FILE_NAME)))
  const b = createExternalIds({ getApi: () => null, getCacheDir: () => dir })
  assert.deepEqual(b.peek('movie', 949), { imdb: 'tt0113277', tvdb: null }, 'no API needed to remember')
  assert.equal(b.size(), 1)
})

test('bad ids, no API key, a failing lookup and a garbage file are all harmless', async (t) => {
  const dir = tmpDir(t)
  fs.writeFileSync(path.join(dir, FILE_NAME), '{not json')
  const api = fakeApi({})
  const ids = createExternalIds({ getApi: () => api, getCacheDir: () => dir })
  for (const bad of [0, -1, 1.5, 'x', null, undefined]) { assert.equal(ids.peek('movie', bad), null); assert.equal(await ids.warm('movie', bad), null) }
  assert.equal(ids.peek('person', 5), null)
  assert.equal(await ids.warm('movie', 12), null, 'TMDB does not know it')
  assert.equal(await ids.warm('movie', 12), null)
  assert.equal(api.calls.length, 1, 'a failed lookup is not retried straight away')
  assert.equal(await createExternalIds({ getApi: () => null, getCacheDir: () => dir }).warm('movie', 5), null, 'no TMDB key: nothing to ask')
  // An id TMDB returns in a strange shape is not trusted.
  const weird = createExternalIds({ getApi: () => fakeApi({ '/movie/2/external_ids': { imdb_id: '<script>' } }), getCacheDir: () => dir })
  assert.deepEqual(await weird.warm('movie', 2), { imdb: null, tvdb: null })
})

test('a failed lookup is retried after ten minutes, and an old answer is refreshed but still served meanwhile', async (t) => {
  let now = 1_000_000
  const dir = tmpDir(t)
  const answers = {}
  const api = fakeApi(answers)
  const ids = createExternalIds({ getApi: () => api, getCacheDir: () => dir, now: () => now })
  assert.equal(await ids.warm('movie', 7), null)
  now += 11 * 60 * 1000
  answers['/movie/7/external_ids'] = { imdb_id: 'tt0000007' }
  assert.deepEqual(await ids.warm('movie', 7), { imdb: 'tt0000007', tvdb: null })
  now += TTL_MS + 1
  answers['/movie/7/external_ids'] = { imdb_id: 'tt0000008' }
  assert.deepEqual(ids.peek('movie', 7), { imdb: 'tt0000007', tvdb: null }, 'stale but served')
  assert.deepEqual(await ids.warm('movie', 7), { imdb: 'tt0000008', tvdb: null }, 'and refreshed')
})
