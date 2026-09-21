'use strict'
// readMediaInfo reads 96 KB of a photo instead of 512 KB, and still gives the same answer for every file, including
// one whose Exif block sits later than the first 96 KB.
const test = require('node:test')
const assert = require('node:assert/strict')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const exif = require('../electron/photoExif')
const { jpegWithExif, exifSegment } = require('./perf/gen-synthetic-library')

const BASE = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64')
const META = { date: '2021:06:05 14:30:15', make: 'Canon', model: 'EOS R6', gps: { latRef: 'N', lat: 40.5, lonRef: 'W', lon: 74.25 } }

// The answer the old code gave: parse the first 512 KB.
async function reference(file, st) {
  const fh = await fsp.open(file, 'r')
  try {
    const buf = Buffer.alloc(Math.min(512 * 1024, st.size))
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    return exif.exifFromBuffer(buf.subarray(0, bytesRead))
  } finally { await fh.close() }
}

async function withReadSizes(fn) {
  const sizes = []
  const realOpen = fsp.open
  fsp.open = async function patched(...a) {
    const h = await realOpen.apply(this, a)
    const realRead = h.read.bind(h)
    h.read = (buf, ...rest) => { sizes.push(buf.length); return realRead(buf, ...rest) }
    return h
  }
  try { return { value: await fn(), sizes } } finally { fsp.open = realOpen }
}

test('a normal photo: same answer as reading 512 KB, from a single 96 KB read', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'beebo-exif-'))
  const file = path.join(dir, 'IMG_1.jpg')
  await fsp.writeFile(file, Buffer.concat([jpegWithExif(BASE, META), Buffer.alloc(3 * 1024 * 1024, 7)]))
  const st = await fsp.stat(file)
  const ref = await reference(file, st)
  const { value: info, sizes } = await withReadSizes(() => exif.readMediaInfo(file, st))
  assert.equal(info.takenFrom, 'exif')
  assert.equal(info.takenAt, ref.takenAt)
  assert.equal(info.make, ref.make)
  assert.deepEqual(info.location, ref.location)
  assert.deepEqual(sizes, [96 * 1024], 'one small read')
  await fsp.rm(dir, { recursive: true, force: true })
})

test('Exif that starts after the first 96 KB is still found (the file is read again in full)', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'beebo-exif-late-'))
  const file = path.join(dir, 'late.jpg')
  const filler = (n) => { const seg = Buffer.alloc(4 + n, 1); seg[0] = 0xff; seg[1] = 0xe2; seg.writeUInt16BE(n + 2, 2); return seg }
  const jpeg = Buffer.concat([BASE.subarray(0, 2), filler(60000), filler(60000), exifSegment(META), BASE.subarray(2), Buffer.alloc(600 * 1024, 3)])
  await fsp.writeFile(file, jpeg)
  const st = await fsp.stat(file)
  const ref = await reference(file, st)
  assert.ok(ref.takenAt, 'the reference sees it')
  const { value: info, sizes } = await withReadSizes(() => exif.readMediaInfo(file, st))
  assert.equal(info.takenAt, ref.takenAt)
  assert.equal(info.takenFrom, 'exif')
  assert.deepEqual(sizes, [96 * 1024, 512 * 1024])
  await fsp.rm(dir, { recursive: true, force: true })
})

test('a photo with no Exif falls back to its name or file time exactly as before', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'beebo-exif-none-'))
  const named = path.join(dir, 'IMG_20200102_030405.jpg')
  await fsp.writeFile(named, Buffer.concat([BASE, Buffer.alloc(200 * 1024, 9)]))
  const st = await fsp.stat(named)
  const info = await exif.readMediaInfo(named, st)
  assert.equal(info.takenFrom, 'name')
  assert.equal(new Date(info.takenAt).getFullYear(), 2020)
  const plain = path.join(dir, 'plain.jpg')
  await fsp.writeFile(plain, BASE)
  const pi = await exif.readMediaInfo(plain, await fsp.stat(plain))
  assert.equal(pi.takenFrom, 'file')
  await fsp.rm(dir, { recursive: true, force: true })
})
