'use strict'
// Phone-to-PC uploads (security review 2026-09-21, P-1, P-2): begin() looked at the disk / the owner's storage cap once,
// while every .part file was still empty, so any number of uploads could each pass it and then fill the drive; and
// the number of half-sent uploads was unlimited (two files each, named from what the phone sent).
// Now every chunk re-checks the owner's cap and the PC's free-space reserve, and half-sent uploads are bounded.
// Run: node --test test/sec-upload-caps.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { Readable } = require('node:stream')

const { createTripShares } = require('../electron/tripShares')
const { createPhotoBackup, safeSegment } = require('../electron/photoBackup')

const MiB = 1024 * 1024
const fakeSha = (tag) => crypto.createHash('sha256').update(String(tag)).digest('hex')
const chunkReq = (data) => { const r = Readable.from([data]); r.headers = { 'content-length': String(data.length) }; return r }
const params = (uploadId, offset) => new URLSearchParams({ uploadId, offset: String(offset) })
const rejects = (p, code) => assert.rejects(p, (e) => e.code === code || e.message === code, code)

async function tmp(name) { return fsp.mkdtemp(path.join(os.tmpdir(), `beebo-${name}-`)) }

/* ------------------------------ trip sharing ------------------------------ */

const mum = { id: 'u-mum', isAdmin: false }

test('trip upload: many begin()s cannot together exceed the owner\'s storage cap', async () => {
  const dir = await tmp('trip-cap')
  try {
    const svc = createTripShares({ dataDir: dir, freeSpace: async () => 1e13 })
    svc._index().settings.maxStorageBytes = 3 * MiB // below the settings UI's own floor: keeps the test small
    const a = await svc.begin(mum, { tripId: 't1', kind: 'photo', sha256: fakeSha('a'), size: 2 * MiB })
    const b = await svc.begin(mum, { tripId: 't1', kind: 'photo', sha256: fakeSha('b'), size: 2 * MiB }) // each alone fits, so begin() accepts both
    const one = Buffer.alloc(MiB, 1)
    let off = 0
    for (let i = 0; i < 2; i++) off = (await svc.chunk(mum, chunkReq(one), params(a.uploadId, off))).offset
    assert.equal(off, 2 * MiB)
    await svc.chunk(mum, chunkReq(one), params(b.uploadId, 0)) // 3 MiB on disk: exactly the cap
    await rejects(svc.chunk(mum, chunkReq(one), params(b.uploadId, MiB)), 'trip_storage_full')
    const u = await svc.usage()
    assert.ok(u.incoming <= 3 * MiB, `on disk ${u.incoming} of ${3 * MiB}`)
  } finally { await fsp.rm(dir, { recursive: true, force: true }) }
})

test('trip upload: the PC\'s free-space reserve is checked on every chunk, not only at begin()', async () => {
  const dir = await tmp('trip-disk')
  try {
    let free = 1e13
    const svc = createTripShares({ dataDir: dir, freeSpace: async () => free })
    const up = await svc.begin(mum, { tripId: 't1', kind: 'photo', sha256: fakeSha('x'), size: 2 * MiB })
    free = 100 * MiB // the drive filled up meanwhile (other uploads, other programs)
    await rejects(svc.chunk(mum, chunkReq(Buffer.alloc(MiB, 2)), params(up.uploadId, 0)), 'pc_disk_full')
    free = 1e13
    const r = await svc.chunk(mum, chunkReq(Buffer.alloc(MiB, 2)), params(up.uploadId, 0))
    assert.equal(r.offset, MiB, 'once there is room again the same upload carries on')
  } finally { await fsp.rm(dir, { recursive: true, force: true }) }
})

test('trip upload: half-sent uploads are bounded; resuming one is still fine', async () => {
  const dir = await tmp('trip-many')
  try {
    const svc = createTripShares({ dataDir: dir, freeSpace: async () => 1e13, maxIncompleteUploads: 3 })
    const begins = []
    for (let i = 0; i < 3; i++) begins.push(await svc.begin(mum, { tripId: 't1', kind: 'photo', sha256: fakeSha('m' + i), size: MiB }))
    await rejects(svc.begin(mum, { tripId: 't1', kind: 'photo', sha256: fakeSha('m3'), size: MiB }), 'too_many_uploads')
    const again = await svc.begin(mum, { tripId: 't1', kind: 'photo', sha256: fakeSha('m0'), size: MiB })
    assert.equal(again.uploadId, begins[0].uploadId, 'the same upload resumes')
    const files = await fsp.readdir(path.join(dir, 'incoming'))
    assert.equal(files.length, 6, 'three uploads, two files each, and no more')
  } finally { await fsp.rm(dir, { recursive: true, force: true }) }
})

/* ------------------------------ photo backup ------------------------------ */

function backupFixture(over = {}) {
  const state = { free: 1e13 }
  return tmp('photo').then((dir) => {
    const root = path.join(dir, 'Phone backups')
    const library = { backupRoot: () => root, access: () => ({ backup: true, owner: false, view: true }), noteAdded: () => {} }
    const backup = createPhotoBackup({ library, dataDir: path.join(dir, 'data'), freeSpace: async () => state.free, ...over })
    return { dir, root, backup, state }
  })
}

test('photo backup: the free-space reserve is checked on every chunk', async () => {
  const f = await backupFixture()
  try {
    const up = await f.backup.begin(mum, { device: 'Pixel', name: 'IMG_1.jpg', size: 2 * MiB, sha256: fakeSha('p1') })
    f.state.free = 100 * MiB
    await rejects(f.backup.chunk(mum, chunkReq(Buffer.alloc(MiB, 3)), params(up.uploadId, 0)), 'pc_disk_full')
    f.state.free = 1e13
    const r = await f.backup.chunk(mum, chunkReq(Buffer.alloc(MiB, 3)), params(up.uploadId, 0))
    assert.equal(r.offset, MiB)
  } finally { await fsp.rm(f.dir, { recursive: true, force: true }) }
})

test('photo backup: half-sent uploads are bounded', async () => {
  const f = await backupFixture({ maxIncompleteUploads: 2 })
  try {
    await f.backup.begin(mum, { device: 'Pixel', name: 'a.jpg', size: MiB, sha256: fakeSha('q0') })
    await f.backup.begin(mum, { device: 'Pixel', name: 'b.jpg', size: MiB, sha256: fakeSha('q1') })
    await rejects(f.backup.begin(mum, { device: 'Pixel', name: 'c.jpg', size: MiB, sha256: fakeSha('q2') }), 'too_many_uploads')
    const again = await f.backup.begin(mum, { device: 'Pixel', name: 'a.jpg', size: MiB, sha256: fakeSha('q0') })
    assert.equal(again.status, 'new', 'an existing upload resumes')
  } finally { await fsp.rm(f.dir, { recursive: true, force: true }) }
})

test('photo backup: device and file names that Windows treats as devices are neutralised (same rule as electron/safePath.js)', () => {
  for (const bad of ['CON', 'nul', 'COM1', 'COM0', 'LPT9', 'COM¹', 'LPT²', 'NUL.jpg', 'aux.tar.gz', 'CONIN$', 'conout$.jpg', 'con.', 'con ']) {
    const out = safeSegment(bad, 'Phone')
    assert.ok(out.startsWith('_'), `${bad} -> ${out}`)
  }
  for (const ok of ['Pixel 8', 'IMG_0001.jpg', 'console.jpg', 'company', 'My Phone']) assert.equal(safeSegment(ok, 'Phone'), ok)
  assert.equal(safeSegment('a:b\\c/d', 'Phone'), 'a_b_c_d')
  assert.equal(safeSegment('..', 'Phone'), 'Phone')
})

/* ------------------------------ trip page: photos held in memory ------------------------------ */

test('trip page: only a few photos are cleaned and sent from memory at once (a link holder cannot exhaust memory)', async () => {
  const fs = require('node:fs')
  const { EventEmitter } = require('node:events')
  const api = require('../electron/tripShareApi')
  const realRead = fs.promises.readFile
  const pending = []
  fs.promises.readFile = () => new Promise((resolve) => pending.push(resolve))
  const token = 'A'.repeat(43)
  const share = { id: 's1', options: { includeLocation: false, includeSong: false, viewOnly: true }, expiresAt: Date.now() + 1e6 }
  const ctx = {
    clientIp: () => '203.0.113.9',
    limiters: { all: api.createRateLimiter({ windowMs: 60000, max: 1e6 }), bad: api.createRateLimiter({ windowMs: 60000, max: 1e6 }) },
    services: { shares: { resolve: () => share, mediaFile: async () => ({ full: 'photo.jpg', size: 1000, mime: 'image/jpeg', kind: 'photo' }), shareData: async () => null, noteView() {} } }
  }
  const mkRes = () => {
    const res = new EventEmitter()
    res.head = null
    res.writeHead = (status, headers) => { res.status = status; res.head = headers }
    res.end = () => { res.ended = true; setImmediate(() => res.emit('close')) }
    return res
  }
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), Buffer.from('JFIF\0', 'latin1'), Buffer.alloc(9), Buffer.from([0xff, 0xd9])])
  try {
    const url = new URL(`http://x/trip/${token}/m/0`)
    const runs = []
    const responses = []
    for (let i = 0; i < 9; i++) {
      const res = mkRes()
      responses.push(res)
      runs.push(api.handlePublic(ctx, { method: 'GET', headers: {} }, res, url))
    }
    await new Promise((r) => setTimeout(r, 30)) // let every request reach the file read
    assert.equal(pending.length, 6, 'six photos are being read; the others were told to wait')
    const busy = responses.filter((r) => r.status === 503)
    assert.equal(busy.length, 3)
    assert.equal(busy[0].head['Retry-After'], '2')
    pending.forEach((resolve) => resolve(jpeg)) // the six finish and their connections close
    await Promise.all(runs)
    await new Promise((r) => setTimeout(r, 30))
    const again = mkRes()
    const run = api.handlePublic(ctx, { method: 'GET', headers: {} }, again, url)
    await new Promise((r) => setTimeout(r, 10))
    assert.equal(pending.length, 7, 'capacity came back once the responses were finished')
    pending[6](jpeg)
    await run
  } finally { fs.promises.readFile = realRead }
})
