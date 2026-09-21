'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { readJsonSafe, writeJsonAtomic, setEventSink } = require('../electron/safeJson')

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-safejson-')) }
function siblings(file) { return fs.readdirSync(path.dirname(file)).filter((n) => n.startsWith(path.basename(file))).sort() }

test.beforeEach(() => setEventSink(null))

test('round trip: write, read back, second write keeps the previous version as .bak', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'manifest.json')
  writeJsonAtomic(file, { a: 1 })
  assert.deepEqual(readJsonSafe(file, {}), { data: { a: 1 }, source: 'file' })
  assert.equal(fs.existsSync(file + '.bak'), false, 'no backup until there is something to back up')
  writeJsonAtomic(file, { a: 2 })
  assert.deepEqual(JSON.parse(fs.readFileSync(file + '.bak', 'utf8')), { a: 1 })
  assert.deepEqual(readJsonSafe(file, {}).data, { a: 2 })
  assert.equal(fs.existsSync(file + '.tmp'), false, 'no temp file left behind')
})

test('missing file: defaults, nothing created, nothing quarantined', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'none.json')
  const r = readJsonSafe(file, { fresh: true })
  assert.deepEqual(r, { data: { fresh: true }, source: 'missing' })
  assert.deepEqual(fs.readdirSync(dir), [])
})

test('corruption matrix: truncated JSON, empty file, whitespace, garbage bytes, wrong-type text', () => {
  const cases = {
    truncated: '{"a": 1, "b": {"c": [1, 2',
    empty: '',
    whitespace: '   \n\t ',
    garbage: Buffer.from([0xff, 0xfe, 0x00, 0x9c, 0x81, 0x00, 0xde, 0xad]),
    prose: 'this is not json at all',
    nulBytes: Buffer.alloc(64)
  }
  for (const [name, bytes] of Object.entries(cases)) {
    // No backup: falls to defaults, the bad file is kept aside and NOT replaced by {}.
    let dir = tmpDir()
    let file = path.join(dir, 'm.json')
    fs.writeFileSync(file, bytes)
    let r = readJsonSafe(file, { d: 1 })
    assert.equal(r.source, 'defaults', name)
    assert.deepEqual(r.data, { d: 1 }, name)
    assert.ok(r.quarantinedTo && /\.corrupt-\d{8}T\d{6}Z/.test(path.basename(r.quarantinedTo)), name)
    assert.deepEqual(fs.readFileSync(r.quarantinedTo), Buffer.from(bytes), name + ': original bytes preserved')
    assert.equal(fs.existsSync(file), false, name + ': the main file is not silently recreated as {}')

    // With a good backup: restored from it and the main file is usable again.
    dir = tmpDir()
    file = path.join(dir, 'm.json')
    fs.writeFileSync(file + '.bak', JSON.stringify({ good: name }))
    fs.writeFileSync(file, bytes)
    r = readJsonSafe(file, {})
    assert.equal(r.source, 'backup', name)
    assert.deepEqual(r.data, { good: name })
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { good: name }, name + ': restored on disk')
    assert.equal(readJsonSafe(file, {}).source, 'file', name + ': second read is a plain read')
  }
})

test('both the file and the backup are corrupt: defaults, both stay inspectable', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'm.json')
  fs.writeFileSync(file, '{oops')
  fs.writeFileSync(file + '.bak', '[[[')
  const r = readJsonSafe(file, () => ({ made: 'fresh' }))
  assert.deepEqual(r.data, { made: 'fresh' })
  assert.equal(r.source, 'defaults')
  assert.ok(fs.existsSync(r.quarantinedTo))
})

test('a UTF-8 BOM is not corruption', () => {
  const file = path.join(tmpDir(), 'm.json')
  fs.writeFileSync(file, '﻿{"a":1}')
  assert.deepEqual(readJsonSafe(file, {}), { data: { a: 1 }, source: 'file' })
})

test('two corruptions in the same second do not overwrite each other\'s quarantine copy', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'm.json')
  const now = Date.UTC(2026, 8, 21, 12, 0, 0)
  fs.writeFileSync(file, 'first bad')
  const a = readJsonSafe(file, {}, { now })
  fs.writeFileSync(file, 'second bad')
  const b = readJsonSafe(file, {}, { now })
  assert.notEqual(a.quarantinedTo, b.quarantinedTo)
  assert.equal(fs.readFileSync(a.quarantinedTo, 'utf8'), 'first bad')
  assert.equal(fs.readFileSync(b.quarantinedTo, 'utf8'), 'second bad')
})

test('permission error on read is NOT treated as corruption: nothing is renamed or replaced', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'm.json')
  writeJsonAtomic(file, { keep: 'me' })
  writeJsonAtomic(file, { keep: 'me too' })
  const real = fs.readFileSync
  fs.readFileSync = function (p, ...rest) {
    if (p === file) { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e }
    return real.call(fs, p, ...rest)
  }
  try {
    const r = readJsonSafe(file, { d: 1 })
    assert.equal(r.source, 'error')
    assert.equal(r.error.code, 'EACCES')
    assert.deepEqual(r.data, { keep: 'me' }, 'falls back to the readable last-good copy for this read only')
  } finally { fs.readFileSync = real }
  assert.deepEqual(siblings(file), ['m.json', 'm.json.bak'])
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { keep: 'me too' }, 'the real file is untouched')
})

test('permission error on read with no backup returns defaults and touches nothing', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'm.json')
  fs.writeFileSync(file, '{"x":1}')
  const real = fs.readFileSync
  fs.readFileSync = function (p, ...rest) {
    if (p === file) { const e = new Error('EPERM'); e.code = 'EPERM'; throw e }
    return real.call(fs, p, ...rest)
  }
  try {
    const r = readJsonSafe(file, { d: 1 })
    assert.equal(r.source, 'error')
    assert.deepEqual(r.data, { d: 1 })
  } finally { fs.readFileSync = real }
  assert.deepEqual(siblings(file), ['m.json'])
})

test('crash during write: a leftover .tmp never affects the real file and is replaced by the next write', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'm.json')
  writeJsonAtomic(file, { v: 1 })
  fs.writeFileSync(file + '.tmp', '{"v": 2, "half writ')
  assert.deepEqual(readJsonSafe(file, {}), { data: { v: 1 }, source: 'file' })
  writeJsonAtomic(file, { v: 3 })
  assert.equal(fs.existsSync(file + '.tmp'), false)
  assert.deepEqual(readJsonSafe(file, {}).data, { v: 3 })
  assert.deepEqual(JSON.parse(fs.readFileSync(file + '.bak', 'utf8')), { v: 1 })
})

test('crash during write: rename failure leaves the previous file intact and cleans the temp file', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'm.json')
  writeJsonAtomic(file, { v: 1 })
  const real = fs.renameSync
  fs.renameSync = () => { const e = new Error('EXDEV'); e.code = 'EXDEV'; throw e }
  try {
    assert.throws(() => writeJsonAtomic(file, { v: 2 }), /EXDEV/)
  } finally { fs.renameSync = real }
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { v: 1 })
  assert.equal(fs.existsSync(file + '.tmp'), false)
})

test('write failure while writing the temp file leaves the previous file intact', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'm.json')
  writeJsonAtomic(file, { v: 1 })
  const real = fs.writeSync
  fs.writeSync = () => { const e = new Error('ENOSPC'); e.code = 'ENOSPC'; throw e }
  try {
    assert.throws(() => writeJsonAtomic(file, { v: 2 }), /ENOSPC/)
  } finally { fs.writeSync = real }
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { v: 1 })
  assert.equal(fs.existsSync(file + '.tmp'), false)
})

test('a corrupt file never overwrites the last good .bak', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'm.json')
  writeJsonAtomic(file, { v: 1 })
  writeJsonAtomic(file, { v: 2 })
  fs.writeFileSync(file, '{"v": 2, "trunc')
  writeJsonAtomic(file, { v: 3 })
  assert.deepEqual(JSON.parse(fs.readFileSync(file + '.bak', 'utf8')), { v: 1 }, 'still the last good copy, not the damaged one')
  assert.ok(siblings(file).some((n) => n.includes('.corrupt-')), 'the damaged content was kept aside')
  assert.deepEqual(readJsonSafe(file, {}).data, { v: 3 })
})

test('restore from backup after the main file is truncated by a crash', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'manifest.json')
  const big = {}
  for (let i = 0; i < 500; i++) big['Movie ' + i + '.mkv'] = { id: i, title: 'Movie ' + i, manual: i % 7 === 0 }
  writeJsonAtomic(file, big)
  writeJsonAtomic(file, Object.assign({}, big, { extra: { id: 999 } }))
  const full = fs.readFileSync(file)
  fs.writeFileSync(file, full.subarray(0, Math.floor(full.length / 2)))
  const events = []
  setEventSink((e) => events.push(e.type))
  const r = readJsonSafe(file, {})
  assert.equal(r.source, 'backup')
  assert.equal(Object.keys(r.data).length, 500, 'manual match fixes from the last good copy survive')
  assert.deepEqual(events, ['restored-from-backup'])
})

test('data that cannot be serialised does not touch the existing file', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'm.json')
  writeJsonAtomic(file, { v: 1 })
  assert.throws(() => writeJsonAtomic(file, undefined), TypeError)
  const circular = {}
  circular.self = circular
  assert.throws(() => writeJsonAtomic(file, circular))
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { v: 1 })
})

test('tmdbCache uses it: a corrupt manifest is restored, not turned into an empty one', () => {
  const tmdbCache = require('../electron/tmdbCache')
  const dir = tmpDir()
  const p = tmdbCache.ensureDirs(dir)
  tmdbCache.writeJson(p.manifestFile, { 'A.mkv': { id: 1, manual: true } })
  tmdbCache.writeJson(p.manifestFile, { 'A.mkv': { id: 1, manual: true }, 'B.mkv': { id: 2 } })
  fs.writeFileSync(p.manifestFile, '{"A.mkv": {"id": 1, "man')
  const m = tmdbCache.getManifest(dir)
  assert.deepEqual(m, { 'A.mkv': { id: 1, manual: true } })
  assert.deepEqual(tmdbCache.getManifest(dir), m, 'cached after recovery')
  assert.ok(fs.readdirSync(dir).some((n) => n.startsWith('manifest.json.corrupt-')))
})

test('tmdbCache: a transient read error is not cached as an empty manifest', () => {
  const tmdbCache = require('../electron/tmdbCache')
  const dir = tmpDir()
  const p = tmdbCache.ensureDirs(dir)
  tmdbCache.writeJson(p.manifestFile, { 'A.mkv': { id: 1 } })
  tmdbCache.writeJson(p.manifestFile, { 'A.mkv': { id: 1 }, 'B.mkv': { id: 2 } })
  // Let the cached copy go stale so the next getManifest has to read the disk again.
  const future = new Date(Date.now() + 5000)
  fs.utimesSync(p.manifestFile, future, future)
  const real = fs.readFileSync
  fs.readFileSync = function (f, ...rest) {
    if (f === p.manifestFile) { const e = new Error('EBUSY'); e.code = 'EBUSY'; throw e }
    return real.call(fs, f, ...rest)
  }
  try {
    assert.deepEqual(tmdbCache.getManifest(dir), { 'A.mkv': { id: 1 } }, 'last good copy for this call')
  } finally { fs.readFileSync = real }
  assert.deepEqual(tmdbCache.getManifest(dir), { 'A.mkv': { id: 1 }, 'B.mkv': { id: 2 } }, 'the error was not remembered')
})

test('backupEveryMs: the last-good copy is refreshed at most that often, but always created when missing', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'm.json')
  const opts = { backupEveryMs: 60000 }
  writeJsonAtomic(file, { v: 1 }, opts)
  writeJsonAtomic(file, { v: 2 }, opts)
  assert.deepEqual(JSON.parse(fs.readFileSync(file + '.bak', 'utf8')), { v: 1 }, 'first backup made at once')
  writeJsonAtomic(file, { v: 3 }, opts)
  writeJsonAtomic(file, { v: 4 }, opts)
  assert.deepEqual(JSON.parse(fs.readFileSync(file + '.bak', 'utf8')), { v: 1 }, 'not refreshed again inside the interval')
  const old = new Date(Date.now() - 120000)
  fs.utimesSync(file + '.bak', old, old)
  writeJsonAtomic(file, { v: 5 }, opts)
  assert.deepEqual(JSON.parse(fs.readFileSync(file + '.bak', 'utf8')), { v: 4 }, 'refreshed once it is older than the interval')
  assert.deepEqual(readJsonSafe(file, {}).data, { v: 5 })
})

test('assumeValid: the existing file is not parsed again (but an unknown one still is)', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'm.json')
  writeJsonAtomic(file, { v: 1 })
  const real = fs.readFileSync
  let reads = 0
  fs.readFileSync = function (p, ...rest) { if (p === file) reads++; return real.call(fs, p, ...rest) }
  try {
    writeJsonAtomic(file, { v: 2 }, { assumeValid: true })
    assert.equal(reads, 0)
    writeJsonAtomic(file, { v: 3 })
    assert.equal(reads, 1)
  } finally { fs.readFileSync = real }
})
