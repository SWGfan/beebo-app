'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Conf = require('conf')
const { cacheStoreReads } = require('../electron/storeCache')
const { createSecretSettings, APP_SECRET_KEYS } = require('../electron/secretSettings')
const { openStore } = require('../electron/configStore')

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-store-cache-')) }
function pair(extra) {
  // Two stores on one config.json: `plain` is stock conf, `cached` has the read cache. Every answer must match.
  const dir = tmp()
  const cached = new Conf({ cwd: dir, configName: 'config' })
  const plain = new Conf({ cwd: dir, configName: 'config' })
  cacheStoreReads(cached, extra)
  return { dir, cached, plain, file: cached.path }
}
const noWait = { revalidateMs: 0 } // every get() checks the file: what a test that edits it from outside needs

test('answers are identical to conf for every kind of value, dotted keys and defaults', () => {
  const { cached, plain } = pair()
  const values = { n: 5, s: 'x', b: false, z: 0, e: '', nul: null, arr: [1, { a: 2 }], obj: { a: { b: [3] } }, license: { token: 't', n: 1 } }
  for (const [k, v] of Object.entries(values)) cached.set(k, v)
  for (const k of [...Object.keys(values), 'missing', 'license.token', 'license.n', 'obj.a.b', 'obj.a.b.0', 'nope.deeper']) {
    assert.deepEqual(cached.get(k), plain.get(k), k)
    assert.deepEqual(cached.get(k, 'dflt'), plain.get(k, 'dflt'), k + ' with a default')
  }
  assert.equal(cached.has('n'), true)
  assert.equal(cached.get('missing'), undefined)
  assert.equal(cached.get('missing', 7), 7)
  assert.equal(cached.get('nul'), null)
})

test('a caller mutating a returned object or array never changes what the next caller gets', () => {
  const { cached } = pair()
  cached.set('list', [{ id: 1 }, { id: 2 }])
  cached.set('map', { a: { n: 1 } })
  const a = cached.get('list')
  a.push({ id: 3 }); a[0].id = 99
  assert.deepEqual(cached.get('list'), [{ id: 1 }, { id: 2 }])
  const m = cached.get('map')
  m.a.n = 5; m.b = 1
  assert.deepEqual(cached.get('map'), { a: { n: 1 } })
  assert.notEqual(cached.get('list'), cached.get('list'), 'each call gets its own copy')
})

test('a write through the store is visible to the very next get, including read-modify-write of an array', () => {
  const { cached, plain } = pair()
  cached.set('n', 1)
  assert.equal(cached.get('n'), 1)
  cached.set('n', 2)
  assert.equal(cached.get('n'), 2)
  const rows = cached.get('rows') || []
  rows.push('a')
  cached.set('rows', rows)
  const again = cached.get('rows')
  again.push('b')
  cached.set('rows', again)
  assert.deepEqual(cached.get('rows'), ['a', 'b'])
  assert.deepEqual(plain.get('rows'), ['a', 'b'])
  cached.delete('n')
  assert.equal(cached.get('n'), undefined)
  cached.set('bulk', 1); cached.set({ p: 1, q: 2 })
  assert.equal(cached.get('q'), 2)
  cached.store = { only: 1 }
  assert.equal(cached.get('bulk'), undefined)
  assert.equal(cached.get('only'), 1)
  cached.clear()
  assert.equal(cached.get('only'), undefined)
})

test('a write by another process or store instance is seen (immediately with revalidate 0, within the window otherwise)', async () => {
  const { cached, plain, file } = pair(noWait)
  plain.set('k', 'one')
  assert.equal(cached.get('k'), 'one')
  plain.set('k', 'two')
  assert.equal(cached.get('k'), 'two', 'a second Store writing the same file')
  fs.writeFileSync(file, JSON.stringify({ k: 'three' }))
  assert.equal(cached.get('k'), 'three', 'a hand edit / restore / test writing the file directly')
  fs.writeFileSync(file, JSON.stringify({ k: 'four' })) // same size, possibly same mtime tick
  assert.equal(cached.get('k'), 'four', 'same size edit')

  const dflt = pair() // default 25 ms window
  dflt.plain.set('k', 'one')
  assert.equal(dflt.cached.get('k'), 'one')
  dflt.plain.set('k', 'two')
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(dflt.cached.get('k'), 'two', 'seen once the revalidation window has passed')
})

test('a missing, emptied or corrupt file behaves as conf does and nothing bad is cached', () => {
  const { cached, plain, file } = pair(noWait)
  cached.set('k', 1)
  assert.equal(cached.get('k'), 1)
  fs.rmSync(file)
  assert.equal(cached.get('k'), plain.get('k'))
  assert.equal(cached.get('k'), undefined)
  fs.writeFileSync(file, '{ not json')
  let expected
  try { plain.get('k') } catch (e) { expected = e }
  assert.ok(expected, 'stock conf throws on a corrupt file')
  assert.throws(() => cached.get('k'), (e) => e.name === expected.name)
  fs.writeFileSync(file, JSON.stringify({ k: 'fixed' }))
  assert.equal(cached.get('k'), 'fixed', 'recovers as soon as the file is good again')
})

test('the secrets wrapper sits on top unchanged: encrypted keys, field secrets in authUsers, set/get round trips', () => {
  const { cached, plain } = pair()
  const fake = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(String(s)).reverse(), decryptString: (b) => Buffer.from(b).reverse().toString() }
  createSecretSettings({ store: cached, safeStorage: fake, keys: APP_SECRET_KEYS, log: () => {} }).install()
  cached.set('sessionSecret', 's3cret')
  cached.set('tmdbApiKey', 'abc')
  cached.set('authUsers', [{ id: 'u1', name: 'A', code: '123456', codeHash: 'h' }])
  assert.equal(cached.get('sessionSecret'), 's3cret')
  assert.equal(cached.get('tmdbApiKey'), 'abc')
  assert.deepEqual(cached.get('authUsers'), [{ id: 'u1', name: 'A', code: '123456', codeHash: 'h' }])
  assert.equal(plain.get('sessionSecret'), undefined, 'on disk the secret is not in plain text')
  assert.equal(JSON.stringify(plain.store).includes('s3cret'), false)
  cached.delete('tmdbApiKey')
  assert.equal(cached.get('tmdbApiKey'), undefined)
})

test('openStore installs the cache on a real conf store, and leaves fakes and plain objects alone', () => {
  const dir = tmp()
  class S extends Conf { constructor() { super({ cwd: dir, configName: 'config' }) } }
  const opened = openStore({ Store: S, userDataDir: dir })
  assert.ok(opened.store.__beeboReadCache, 'cache installed')
  opened.store.set('a', 1)
  assert.equal(opened.store.get('a'), 1)
  const fake = { get: () => 1, set: () => {} }
  assert.equal(cacheStoreReads(fake), fake)
  assert.equal(fake.__beeboReadCache, undefined)
  const same = cacheStoreReads(opened.store)
  assert.equal(same, opened.store, 'installing twice is a no-op')
})

test('BEEBO_NO_STORE_CACHE=1 turns it off', () => {
  const saved = process.env.BEEBO_NO_STORE_CACHE
  process.env.BEEBO_NO_STORE_CACHE = '1'
  try {
    const c = new Conf({ cwd: tmp(), configName: 'config' })
    cacheStoreReads(c)
    assert.equal(c.__beeboReadCache, undefined)
  } finally { if (saved === undefined) delete process.env.BEEBO_NO_STORE_CACHE; else process.env.BEEBO_NO_STORE_CACHE = saved }
})

test('reads are served from memory: file reads drop to one per file version', () => {
  const { cached, file } = pair()
  cached.set('a', 1); cached.set('b', { x: 1 })
  const realRead = fs.readFileSync
  let reads = 0
  fs.readFileSync = function counting(p, ...rest) { if (String(p) === file) reads++; return realRead.call(this, p, ...rest) }
  try {
    for (let i = 0; i < 200; i++) { cached.get('a'); cached.get('b'); cached.get('missing') }
  } finally { fs.readFileSync = realRead }
  assert.ok(reads <= 1, 'reads of config.json for 600 gets: ' + reads)
})
