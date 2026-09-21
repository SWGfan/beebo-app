// The desktop app's play queue (src/lib/playQueue.js): playlists in order,
// Play next / Add to queue, and carrying on after something played in between.
// Run: node --test test/play-queue.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const appRoot = path.resolve(__dirname, '..')
const load = () => import(pathToFileURL(path.join(appRoot, 'src', 'lib', 'playQueue.js')).href)

const it = (id, kind = 'movie') => ({ id, kind, title: id.toUpperCase() })
const ids = (q) => q.items.map((x) => x.id)

test('a playlist plays in order from the start index, then finishes', async () => {
  const Q = await load()
  let q = Q.fromPlaylist([it('a'), it('b'), it('c')], { startIndex: 1, playlistId: 'pl_1' })
  assert.equal(Q.peekNext(q).id, 'b', 'nothing playing yet: b is next')
  q = Q.advance(q)
  assert.equal(Q.current(q).id, 'b')
  assert.equal(Q.remaining(q), 1)
  q = Q.advance(q)
  assert.equal(Q.current(q).id, 'c')
  assert.equal(Q.peekNext(q), null)
  q = Q.advance(q)
  assert.equal(Q.current(q), null)
  assert.equal(Q.remaining(q), 0)
  q = Q.back(Q.jump(q, 2))
  assert.equal(Q.current(q).id, 'b')
  assert.equal(Q.fromPlaylist([], {}).pos, -1)
})

test('play next goes straight after the current item; add to queue goes last', async () => {
  const Q = await load()
  let q = Q.advance(Q.fromPlaylist([it('a'), it('b'), it('c')]))
  q = Q.playNext(q, it('x'))
  q = Q.addToQueue(q, [it('y'), it('z')])
  assert.deepEqual(ids(q), ['a', 'x', 'b', 'c', 'y', 'z'])
  assert.equal(Q.peekNext(q).id, 'x')
  // with nothing queued at all
  const empty = Q.playNext(null, it('solo'))
  assert.deepEqual(ids(empty), ['solo'])
  assert.equal(Q.peekNext(empty).id, 'solo')
})

test('starting something else keeps the queue; starting the next item moves onto it', async () => {
  const Q = await load()
  let q = Q.addToQueue(Q.EMPTY, [it('a'), it('b', 'tv')])
  q = Q.startedOutside(q, it('other'))
  assert.equal(q.pos, -1)
  assert.equal(Q.peekNext(q).id, 'a')
  q = Q.startedOutside(q, it('b', 'tv'))
  assert.equal(Q.current(q).id, 'b')
  // same id, other kind, is not the same item
  q = Q.startedOutside(Q.addToQueue(Q.EMPTY, [it('z', 'tv')]), it('z', 'movie'))
  assert.equal(q.pos, -1)
})

test('removing items keeps the current one current', async () => {
  const Q = await load()
  let q = Q.jump(Q.fromPlaylist([it('a'), it('b'), it('c'), it('d')]), 2)
  q = Q.remove(q, 0)
  assert.equal(Q.current(q).id, 'c')
  q = Q.remove(q, 2)
  assert.equal(Q.current(q).id, 'c')
  // removing the playing item: what came before it is 'current', so the next one plays after it
  q = Q.remove(q, 1)
  assert.deepEqual(ids(q), ['b'])
  assert.equal(Q.peekNext(q), null)
})

test('the shared store notifies subscribers', async () => {
  const Q = await load()
  const seen = []
  const off = Q.subscribe((s) => seen.push(s.items.length))
  Q.setQueue(Q.addToQueue(Q.getQueue(), it('a')))
  Q.setQueue(null)
  off()
  Q.setQueue(Q.addToQueue(Q.getQueue(), it('b')))
  assert.deepEqual(seen, [1, 0])
  Q.setQueue(null)
})
