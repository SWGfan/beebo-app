'use strict'
// Stale-while-revalidate for the library cache (catalog.js): an old walk that no watcher has reported a change
// to is served at once while a fresh walk runs on the worker, instead of every request after 15 s waiting for
// a walk of the whole library. Everything else (a reported change, no watcher, a walk older than the window,
// SWR off) must still walk first, exactly as before.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const catalog = require('../electron/catalog')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const has = (list, name) => list.some((m) => m.fileName === name)
const FOUR = 'Film Four (2004).mp4'
const deafWatch = () => ({ close() {} })

function lib() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-swr-'))
  const movies = path.join(root, 'movies')
  fs.mkdirSync(movies, { recursive: true })
  for (const n of ['Film One (2001).mp4', 'Film Two (2002).mp4']) fs.writeFileSync(path.join(movies, n), 'x')
  return { root, movies: [movies], add: () => fs.writeFileSync(path.join(movies, FOUR), 'x'), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

// A counting walker: how many fresh walks were started, and the ability to make them slow.
function countingWalker(inner, delayMs = 0) {
  const w = Object.create(inner)
  w.walks = 0
  w.walkFresh = async (...args) => { w.walks++; if (delayMs) await sleep(delayMs); return inner.walkFresh(...args) }
  return w
}

test('quiet and old: served immediately (stale), and the next request has the fresh walk', async () => {
  const l = lib()
  const inner = catalog.createCatalogWalker()
  const walker = countingWalker(inner, 150)
  const library = catalog.createLibraryCatalog({ walker, watch: deafWatch, maxAgeMs: 0, staleWhileRevalidateMs: 60000 })
  try {
    await library.run('first', async () => { await library.prime({ movies: l.movies }) })
    assert.equal(walker.walks, 1)
    l.add()
    await sleep(5)
    const t0 = Date.now()
    await library.run('second', async () => {
      await library.prime({ movies: l.movies })
      assert.equal(has(library.scanMoviesMulti(l.movies), FOUR), false, 'the old walk is what this request reads')
    })
    assert.ok(Date.now() - t0 < 100, 'and it did not wait for the 150 ms walk: ' + (Date.now() - t0))
    await sleep(400)
    assert.ok(walker.walks >= 2, 'a fresh walk was started in the background')
    await library.run('third', async () => {
      await library.prime({ movies: l.movies })
      assert.equal(has(library.scanMoviesMulti(l.movies), FOUR), true, 'the fresh walk is used once it is in')
    })
  } finally { library.close(); inner.close(); l.cleanup() }
})

test('a reported change still waits for a fresh walk', async () => {
  const l = lib()
  const inner = catalog.createCatalogWalker()
  let fire = null
  const watch = (dir, onChange) => { fire = onChange; return { close() {} } }
  const library = catalog.createLibraryCatalog({ walker: inner, watch, maxAgeMs: 0, staleWhileRevalidateMs: 60000 })
  try {
    await library.run('first', async () => { await library.prime({ movies: l.movies }) })
    l.add()
    fire('rename', FOUR)
    await library.run('second', async () => {
      await library.prime({ movies: l.movies })
      assert.equal(has(library.scanMoviesMulti(l.movies), FOUR), true)
    })
  } finally { library.close(); inner.close(); l.cleanup() }
})

test('a walk older than the window, an unwatchable folder and SWR off all walk first, as before', async () => {
  const cases = [
    ['past the window', { watch: deafWatch, maxAgeMs: 0, staleWhileRevalidateMs: 1 }],
    ['unwatchable folder', { watch: () => { throw new Error('EPERM') }, maxAgeMs: 0, staleWhileRevalidateMs: 60000 }],
    ['swr off (the default)', { watch: deafWatch, maxAgeMs: 0 }]
  ]
  for (const [name, opts] of cases) {
    const l = lib()
    const inner = catalog.createCatalogWalker()
    const library = catalog.createLibraryCatalog({ walker: inner, ...opts })
    try {
      await library.run('first', async () => { await library.prime({ movies: l.movies }) })
      l.add()
      await sleep(10)
      await library.run('second', async () => {
        await library.prime({ movies: l.movies })
        assert.equal(has(library.scanMoviesMulti(l.movies), FOUR), true, name)
      })
    } finally { library.close(); inner.close(); l.cleanup() }
  }
})

test('outside a request the synchronous read is served stale too, instead of walking on the calling thread', async () => {
  const l = lib()
  const inner = catalog.createCatalogWalker()
  const walker = countingWalker(inner)
  const library = catalog.createLibraryCatalog({ walker, watch: deafWatch, maxAgeMs: 0, staleWhileRevalidateMs: 60000 })
  try {
    await library.run('first', async () => { await library.prime({ movies: l.movies }) })
    l.add()
    await sleep(5)
    assert.equal(has(library.scanMoviesMulti(l.movies), FOUR), false, 'stale answer, no walk here')
    await sleep(300)
    assert.equal(has(library.scanMoviesMulti(l.movies), FOUR), true, 'and the background walk has landed')
  } finally { library.close(); inner.close(); l.cleanup() }
})

test('the shared catalog turns it on', () => {
  assert.equal(catalog.STALE_WHILE_REVALIDATE_MS > 15000, true)
})

test('quietValidMs: a walk no watcher has spoken about is trusted without any re-walk until the window ends', async () => {
  const l = lib()
  const inner = catalog.createCatalogWalker()
  const walker = countingWalker(inner)
  const library = catalog.createLibraryCatalog({ walker, watch: deafWatch, maxAgeMs: 0, quietValidMs: 60000, staleWhileRevalidateMs: 120000 })
  try {
    await library.run('first', async () => { await library.prime({ movies: l.movies }) })
    for (let i = 0; i < 3; i++) await library.run('again ' + i, async () => { await library.prime({ movies: l.movies }); library.scanMoviesMulti(l.movies) })
    assert.equal(walker.walks, 1, 'three more requests, no walk')
  } finally { library.close(); inner.close(); l.cleanup() }
  const l2 = lib()
  const inner2 = catalog.createCatalogWalker()
  let fire = null
  const library2 = catalog.createLibraryCatalog({ walker: inner2, watch: (d, onChange) => { fire = onChange; return { close() {} } }, maxAgeMs: 0, quietValidMs: 60000 })
  try {
    await library2.run('first', async () => { await library2.prime({ movies: l2.movies }) })
    l2.add(); fire('rename', FOUR)
    await library2.run('after a reported change', async () => {
      await library2.prime({ movies: l2.movies })
      assert.equal(has(library2.scanMoviesMulti(l2.movies), FOUR), true, 'a change the watcher reports is never hidden by the quiet window')
    })
  } finally { library2.close(); inner2.close(); l2.cleanup() }
})

test('the shared catalog trusts a quiet walk for about two minutes', () => {
  assert.equal(catalog.QUIET_VALID_MS >= 60000 && catalog.QUIET_VALID_MS <= 10 * 60 * 1000, true)
})
