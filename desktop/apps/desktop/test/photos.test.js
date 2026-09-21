const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const crypto = require('node:crypto')
const { createRequire } = require('node:module')
const { testPort } = require('./helpers/testPort')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))
const exif = localRequire('./electron/photoExif')
const { createPhotoLibrary } = localRequire('./electron/photoLibrary')
const { createPhotoBackup, safeSegment, numbered } = localRequire('./electron/photoBackup')
const photosApi = localRequire('./electron/photosApi')

/* ------------------------------ fixtures ------------------------------ */

// A minimal little-endian TIFF block: IFD0 (orientation, Exif pointer, GPS pointer), an Exif IFD
// (DateTimeOriginal, OffsetTimeOriginal) and a GPS IFD. Offsets are relative to the TIFF start.
function tiffBlock({ original = '2021:07:04 18:30:05', offset = null, gps = null, orientation = 6, dateTime = '2024:01:01 00:00:00' } = {}) {
  const chunks = []
  let cursor = 0
  const alloc = (buf) => { const at = cursor; chunks.push(buf); cursor += buf.length; return at }
  const ascii = (s) => Buffer.from(s + '\0', 'latin1')
  // IFD layout helper: entries first, then out-of-line data.
  const ifd = (base, entries) => {
    const head = Buffer.alloc(2 + entries.length * 12 + 4)
    head.writeUInt16LE(entries.length, 0)
    let dataAt = base + head.length
    const data = []
    entries.forEach((e, k) => {
      const o = 2 + k * 12
      head.writeUInt16LE(e.tag, o); head.writeUInt16LE(e.type, o + 2); head.writeUInt32LE(e.count, o + 4)
      if (e.inline !== undefined) { if (e.type === 3) head.writeUInt16LE(e.inline, o + 8); else head.writeUInt32LE(e.inline, o + 8) }
      else if (e.data.length <= 4) e.data.copy(head, o + 8) // values of 4 bytes or less live in the entry
      else { head.writeUInt32LE(dataAt, o + 8); data.push(e.data); dataAt += e.data.length }
    })
    return Buffer.concat([head, ...data])
  }
  const rat = (vals) => { const b = Buffer.alloc(vals.length * 8); vals.forEach(([n, d], i) => { b.writeUInt32LE(n, i * 8); b.writeUInt32LE(d, i * 8 + 4) }); return b }
  const header = Buffer.from([0x49, 0x49, 42, 0, 8, 0, 0, 0])
  alloc(header)
  // Sizes are fixed so pointers can be computed up front.
  const dt = ascii(dateTime)
  const ifd0Entries = (exifAt, gpsAt) => [
    { tag: 0x0112, type: 3, count: 1, inline: orientation },
    { tag: 0x0132, type: 2, count: dt.length, data: dt },
    { tag: 0x8769, type: 4, count: 1, inline: exifAt },
    ...(gps ? [{ tag: 0x8825, type: 4, count: 1, inline: gpsAt }] : [])
  ]
  const ifd0Len = ifd(8, ifd0Entries(0, 0)).length
  const exifAt = 8 + ifd0Len
  const exifEntries = [
    { tag: 0x9003, type: 2, count: original.length + 1, data: ascii(original) },
    ...(offset ? [{ tag: 0x9011, type: 2, count: offset.length + 1, data: ascii(offset) }] : [])
  ]
  const exifLen = ifd(exifAt, exifEntries).length
  const gpsAt = exifAt + exifLen
  alloc(ifd(8, ifd0Entries(exifAt, gpsAt)))
  alloc(ifd(exifAt, exifEntries))
  if (gps) {
    alloc(ifd(gpsAt, [
      { tag: 1, type: 2, count: 2, data: ascii(gps.latRef).subarray(0, 2) },
      { tag: 2, type: 5, count: 3, data: rat([[gps.lat[0], 1], [gps.lat[1], 1], [gps.lat[2] * 100, 100]]) },
      { tag: 3, type: 2, count: 2, data: ascii(gps.lonRef).subarray(0, 2) },
      { tag: 4, type: 5, count: 3, data: rat([[gps.lon[0], 1], [gps.lon[1], 1], [gps.lon[2] * 100, 100]]) }
    ]))
  }
  return Buffer.concat(chunks)
}

function jpegWithExif(opts) {
  const tiff = tiffBlock(opts)
  const app1Body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff])
  const app1 = Buffer.alloc(4); app1[0] = 0xff; app1[1] = 0xe1; app1.writeUInt16BE(app1Body.length + 2, 2)
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00])
  const com = Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0x07]), Buffer.from('owner', 'latin1')])
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x11, 0x22, 0x33, 0xff, 0xd9])
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, app1, app1Body, com, sos])
}

function mp4WithCreation(date) {
  const secs = Math.floor(date.getTime() / 1000) + 2082844800
  const ftyp = Buffer.alloc(16); ftyp.writeUInt32BE(16, 0); ftyp.write('ftypisom', 4, 'latin1')
  const mvhd = Buffer.alloc(8 + 100); mvhd.writeUInt32BE(mvhd.length, 0); mvhd.write('mvhd', 4, 'latin1')
  mvhd[8] = 0; mvhd.writeUInt32BE(secs, 12)
  const mdat = Buffer.alloc(8 + 64); mdat.writeUInt32BE(mdat.length, 0); mdat.write('mdat', 4, 'latin1')
  const moov = Buffer.alloc(8); moov.writeUInt32BE(8 + mvhd.length, 0); moov.write('moov', 4, 'latin1')
  // moov after mdat, the way most phones write it.
  return Buffer.concat([ftyp, mdat, moov, mvhd])
}

async function tmpdir(tag) { return fs.mkdtemp(path.join(os.tmpdir(), 'beebo-photos-test-' + tag + '-')) }
async function cleanup(dir) {
  assert.ok(path.basename(dir).startsWith('beebo-photos-test-'))
  await fs.rm(dir, { recursive: true, force: true })
}
const memStore = (data = {}) => ({ get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] }, data })
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
const OWNER = { id: 'owner', name: 'Nick', username: 'nick', isAdmin: true, status: 'approved' }
const MEMBER = { id: 'member', name: 'Sam', username: 'sam', isAdmin: false, status: 'approved' }

/* ------------------------------ EXIF dates ------------------------------ */

test('EXIF date parsing: wall-clock, offsets, bad and future values', () => {
  const local = exif.parseExifDate('2021:07:04 18:30:05')
  const d = new Date(local)
  assert.deepEqual([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()], [2021, 6, 4, 18, 30, 5])
  assert.equal(exif.parseExifDate('2021:07:04 18:30:05', '+02:00'), Date.UTC(2021, 6, 4, 16, 30, 5))
  assert.equal(exif.parseExifDate('2021:07:04 18:30:05', '-0500'), Date.UTC(2021, 6, 4, 23, 30, 5))
  for (const bad of ['0000:00:00 00:00:00', '    :  :     :  :  ', '2021:02:30 10:00:00', '2021:13:01 10:00:00', 'yesterday', '', null, 42]) {
    assert.equal(exif.parseExifDate(bad), null, String(bad))
  }
  assert.equal(exif.parseExifDate('2099:01:01 00:00:00'), null, 'future dates are camera clock errors')
  assert.ok(exif.parseExifDate('2026-09-17 08:00:00'), 'dash separators (some phone apps) still parse')
})

test('EXIF from JPEG, HEIC-style and TIFF-less buffers; location and orientation', () => {
  const jpg = jpegWithExif({ original: '2019:12:25 09:15:00', offset: '+01:00', orientation: 6, gps: { latRef: 'N', lat: [51, 30, 26.5], lonRef: 'W', lon: [0, 7, 39.25] } })
  const info = exif.exifFromBuffer(jpg)
  assert.equal(info.takenAt, Date.UTC(2019, 11, 25, 8, 15, 0))
  assert.equal(info.orientation, 6)
  assert.ok(Math.abs(info.location.lat - 51.507361) < 1e-5)
  assert.ok(Math.abs(info.location.lon + 0.127569) < 1e-5)
  // HEIC keeps the Exif item as "<4-byte offset>Exif\0\0<TIFF>" somewhere inside the meta box.
  const heic = Buffer.concat([Buffer.from('....ftypheic....meta....iinf....', 'latin1'), Buffer.alloc(4), Buffer.from('Exif\0\0', 'latin1'), tiffBlock({ original: '2023:03:03 03:03:03', gps: null })])
  assert.equal(new Date(exif.exifFromBuffer(heic).takenAt).getFullYear(), 2023)
  // DateTimeOriginal missing its value falls back to IFD0 DateTime.
  const fallback = exif.exifFromBuffer(jpegWithExif({ original: '0000:00:00 00:00:00', dateTime: '2018:05:06 07:08:09' }))
  assert.equal(new Date(fallback.takenAt).getFullYear(), 2018)
  // Garbage and truncation never throw.
  assert.deepEqual(exif.exifFromBuffer(Buffer.from('not an image at all')), {})
  const truncated = jpg.subarray(0, 60)
  assert.doesNotThrow(() => exif.exifFromBuffer(truncated))
  for (let i = 0; i < 200; i++) {
    const noisy = Buffer.from(jpg); noisy[20 + (i * 7) % (jpg.length - 20)] ^= 0xff
    assert.doesNotThrow(() => exif.exifFromBuffer(noisy))
  }
})

test('Metadata stripping removes Exif/COM segments and keeps the image', () => {
  const jpg = jpegWithExif({ gps: { latRef: 'N', lat: [1, 2, 3], lonRef: 'E', lon: [4, 5, 6] } })
  const out = exif.stripJpegMetadata(jpg)
  assert.equal(out.indexOf('Exif', 0, 'latin1'), -1)
  assert.equal(out.indexOf('owner', 0, 'latin1'), -1)
  assert.notEqual(out.indexOf('JFIF', 0, 'latin1'), -1)
  assert.deepEqual([...out.subarray(-2)], [0xff, 0xd9])
  assert.deepEqual(exif.exifFromBuffer(out), {})
  const png = Buffer.from('\x89PNG....', 'latin1')
  assert.equal(exif.stripJpegMetadata(png), png)
})

test('Video creation time, filename dates and file-time fallback', async () => {
  const dir = await tmpdir('meta')
  try {
    const when = new Date(Date.UTC(2022, 4, 17, 12, 0, 0))
    const mp4 = path.join(dir, 'clip.mp4')
    await fs.writeFile(mp4, mp4WithCreation(when))
    const vi = await exif.readMediaInfo(mp4, await fs.stat(mp4))
    assert.equal(vi.takenFrom, 'video'); assert.equal(vi.takenAt, when.getTime())
    const named = path.join(dir, 'PXL_20200102_030405123.jpg')
    await fs.writeFile(named, 'no exif here')
    const ni = await exif.readMediaInfo(named, await fs.stat(named))
    assert.equal(ni.takenFrom, 'name')
    assert.equal(new Date(ni.takenAt).getFullYear(), 2020)
    const plain = path.join(dir, 'holiday.jpg')
    await fs.writeFile(plain, 'no exif, no date in name')
    const t = new Date(2015, 1, 3)
    await fs.utimes(plain, t, t)
    const pi = await exif.readMediaInfo(plain, await fs.stat(plain))
    assert.equal(pi.takenFrom, 'file')
    assert.ok(pi.takenAt <= t.getTime() + 1000)
    assert.equal(exif.dateFromName('IMG-20261301-WA0001.jpg'), null, 'month 13 is not a date')
    assert.equal(exif.dateFromName('Screenshot_2024-02-29-10-11-12.png') !== null, true)
  } finally { await cleanup(dir) }
})

/* ------------------------------ library ------------------------------ */

test('Library: timeline by date taken, albums per folder, location hidden by default', async () => {
  const dir = await tmpdir('lib')
  const data = await tmpdir('libdata')
  try {
    const pics = path.join(dir, 'Pictures')
    await fs.mkdir(path.join(pics, 'Holiday'), { recursive: true })
    await fs.mkdir(path.join(pics, '.hidden'), { recursive: true })
    await fs.writeFile(path.join(pics, 'Holiday', 'beach.jpg'), jpegWithExif({ original: '2010:08:01 10:00:00', gps: { latRef: 'N', lat: [10, 0, 0], lonRef: 'E', lon: [20, 0, 0] } }))
    await fs.writeFile(path.join(pics, 'new.jpg'), jpegWithExif({ original: '2024:02:02 10:00:00' }))
    await fs.writeFile(path.join(pics, 'clip.mp4'), mp4WithCreation(new Date(2017, 5, 5)))
    await fs.writeFile(path.join(pics, 'notes.txt'), 'not media')
    await fs.writeFile(path.join(pics, '.hidden', 'secret.jpg'), jpegWithExif({}))
    const store = memStore({ photosDirs: [pics] })
    const lib = createPhotoLibrary({ store, dataDir: data, ffmpeg: null })
    const owner = lib.access(OWNER)
    const tl = await lib.timeline(new URLSearchParams(), owner)
    assert.deepEqual(tl.items.map((x) => x.name), ['new.jpg', 'clip.mp4', 'beach.jpg'])
    assert.equal(tl.items[2].location, undefined, 'location is off by default, even for the owner')
    assert.equal(tl.items.some((x) => 'full' in x || 'root' in x), false, 'no PC paths on the wire')
    assert.deepEqual(tl.months.map((m) => m.key), ['2024-02', '2017-06', '2010-08'])
    lib.setShowLocation(true)
    const withLoc = await lib.timeline(new URLSearchParams(), owner)
    assert.equal(withLoc.items[2].location.lat, 10)
    const asMember = await lib.timeline(new URLSearchParams(), { view: true, backup: false, owner: false })
    assert.equal(asMember.items[2].location, undefined, 'never shown to anyone but the owner')
    const videos = await lib.timeline(new URLSearchParams({ type: 'video' }), owner)
    assert.deepEqual(videos.items.map((x) => x.name), ['clip.mp4'])
    const al = await lib.albums(owner)
    assert.deepEqual(al.albums.map((a) => a.name).sort(), ['Holiday', 'Pictures'])
    const holiday = al.albums.find((a) => a.name === 'Holiday')
    const inAlbum = await lib.timeline(new URLSearchParams({ album: holiday.id }), owner)
    assert.deepEqual(inAlbum.items.map((x) => x.name), ['beach.jpg'])
    const page = await lib.timeline(new URLSearchParams({ limit: '2' }), owner)
    assert.equal(page.items.length, 2); assert.equal(page.nextOffset, 2)
  } finally { await cleanup(dir); await cleanup(data) }
})

test('Library: map points are owner-only, location-only and follow the showLocation switch', async () => {
  const dir = await tmpdir('map')
  const data = await tmpdir('mapdata')
  try {
    const pics = path.join(dir, 'Pictures')
    await fs.mkdir(pics, { recursive: true })
    await fs.writeFile(path.join(pics, 'beach.jpg'), jpegWithExif({ original: '2010:08:01 10:00:00', gps: { latRef: 'N', lat: [10, 0, 0], lonRef: 'E', lon: [20, 0, 0] } }))
    await fs.writeFile(path.join(pics, 'no-gps.jpg'), jpegWithExif({ original: '2024:02:02 10:00:00' }))
    const store = memStore({ photosDirs: [pics] })
    const lib = createPhotoLibrary({ store, dataDir: data, ffmpeg: null })
    const owner = lib.access(OWNER)
    const member = { view: true, backup: false, owner: false }
    assert.deepEqual(await lib.mapPoints(owner), { ok: true, enabled: false, items: [] }, 'off by default, even for the owner')
    assert.deepEqual(await lib.mapPoints(member), { ok: true, enabled: false, items: [] })
    lib.setShowLocation(true)
    assert.deepEqual(await lib.mapPoints(member), { ok: true, enabled: false, items: [] }, 'never shown to anyone but the owner')
    const on = await lib.mapPoints(owner)
    assert.equal(on.enabled, true)
    assert.deepEqual(on.items.map((x) => x.name), ['beach.jpg'], 'only the photo carrying GPS is a pin')
    assert.equal(on.items[0].lat, 10); assert.equal(on.items[0].lon, 20)
    assert.equal(on.items.some((x) => 'full' in x || 'root' in x), false, 'no PC paths on the wire')
  } finally { await cleanup(dir); await cleanup(data) }
})

test('Library path safety: ids only, no traversal, no links out, only configured folders', async () => {
  const dir = await tmpdir('safe')
  const data = await tmpdir('safedata')
  try {
    const pics = path.join(dir, 'Pictures')
    const outside = path.join(dir, 'Private')
    await fs.mkdir(pics, { recursive: true }); await fs.mkdir(outside, { recursive: true })
    await fs.writeFile(path.join(pics, 'ok.jpg'), jpegWithExif({}))
    await fs.writeFile(path.join(outside, 'tax.jpg'), jpegWithExif({}))
    await fs.symlink(outside, path.join(pics, 'Linked'), 'junction')
    const lib = createPhotoLibrary({ store: memStore({ photosDirs: [pics] }), dataDir: data, ffmpeg: null })
    const tl = await lib.timeline(new URLSearchParams(), lib.access(OWNER))
    assert.deepEqual(tl.items.map((x) => x.name), ['ok.jpg'], 'junctions are not followed while scanning')
    for (const bad of ['../../etc/passwd', path.join(outside, 'tax.jpg'), '', 'ABCDEF', '0'.repeat(23) + 'g']) {
      await assert.rejects(lib.resolveItem(bad), (e) => e.status === 400, bad)
    }
    await assert.rejects(lib.resolveItem('0'.repeat(24)), (e) => e.status === 404)
    await assert.rejects(lib.assertSafePath(path.join(outside, 'tax.jpg')), (e) => e.status === 403)
    await assert.rejects(lib.assertSafePath(path.join(pics, '..', 'Private', 'tax.jpg')), (e) => e.status === 403)
    await assert.rejects(lib.assertSafePath(path.join(pics, 'Linked', 'tax.jpg')), (e) => e.status === 403)
    assert.ok((await lib.assertSafePath(path.join(pics, 'ok.jpg'))).st.isFile())
    // Folder settings: local, existing, absolute only.
    await assert.rejects(lib.setFolders(['\\\\nas\\photos']), (e) => e.status === 400)
    await assert.rejects(lib.setFolders(['relative\\photos']), (e) => e.status === 400)
    await assert.rejects(lib.setFolders([path.join(dir, 'missing')]), (e) => e.status === 404)
    await assert.rejects(lib.setFolders([path.join(pics, 'ok.jpg')]), (e) => e.status === 400)
    assert.deepEqual(await lib.setFolders([pics, pics]), [path.resolve(pics)])
  } finally { await cleanup(dir); await cleanup(data) }
})

test('Access switches: owner always, members only when allowed, revoked never', () => {
  const store = memStore({})
  const lib = createPhotoLibrary({ store, dataDir: os.tmpdir(), ffmpeg: null })
  assert.deepEqual(lib.access(OWNER), { view: true, backup: true, owner: true })
  assert.deepEqual(lib.access(MEMBER), { view: false, backup: false, owner: false })
  assert.deepEqual(lib.access(null), { view: false, backup: false, owner: false })
  lib.setAccess('member', { view: true, backup: false })
  assert.deepEqual(lib.access(MEMBER), { view: true, backup: false, owner: false })
  lib.setAccess('member', { view: false, backup: true })
  assert.deepEqual(lib.access(MEMBER), { view: true, backup: true, owner: false }, 'backing up implies seeing your photos')
  assert.deepEqual(lib.access({ ...MEMBER, status: 'revoked' }), { view: false, backup: false, owner: false })
  assert.deepEqual(lib.access({ ...OWNER, status: 'revoked' }), { view: false, backup: false, owner: false })
})

/* ------------------------------ backup ------------------------------ */

function fakeReq(buf, headers = {}) {
  const { Readable } = require('node:stream')
  const r = Readable.from(buf.length ? [buf] : [])
  r.headers = { 'content-length': String(buf.length), ...headers }
  return r
}

async function backupFixture() {
  const dir = await tmpdir('backup')
  const pics = path.join(dir, 'Pictures')
  await fs.mkdir(pics, { recursive: true })
  const store = memStore({ photosDirs: [pics] })
  const library = createPhotoLibrary({ store, dataDir: path.join(dir, 'data'), ffmpeg: null })
  const backup = createPhotoBackup({ library, dataDir: path.join(dir, 'data'), freeSpace: async () => 1e12 })
  return { dir, pics, store, library, backup }
}

async function sendAll(backup, user, begin, bytes, chunkSize = 7) {
  let offset = begin.offset
  while (offset < bytes.length) {
    const part = bytes.subarray(offset, offset + chunkSize)
    const r = await backup.chunk(user, fakeReq(part, { 'x-chunk-sha256': sha(part) }), new URLSearchParams({ uploadId: begin.uploadId, offset: String(offset) }))
    offset = r.offset
  }
  return backup.finish(user, { uploadId: begin.uploadId })
}

test('Chunked backup: resume after a drop, exact offsets, saved under device/YYYY/MM', async () => {
  const f = await backupFixture()
  try {
    const bytes = jpegWithExif({ original: '2025:03:09 11:00:00' })
    const takenAt = new Date(2025, 2, 9, 11).getTime()
    const meta = { device: 'Pixel 8', name: 'PXL_20250309.jpg', size: bytes.length, sha256: sha(bytes), takenAt }
    const b1 = await f.backup.begin(OWNER, meta)
    assert.equal(b1.status, 'new'); assert.equal(b1.offset, 0)
    // First 20 bytes arrive, then the connection drops.
    const first = bytes.subarray(0, 20)
    assert.equal((await f.backup.chunk(OWNER, fakeReq(first), new URLSearchParams({ uploadId: b1.uploadId, offset: '0' }))).offset, 20)
    // The app restarts (or is reinstalled): begin again resumes at 20 with the same id.
    const b2 = await f.backup.begin(OWNER, meta)
    assert.equal(b2.status, 'resume'); assert.equal(b2.offset, 20); assert.equal(b2.uploadId, b1.uploadId)
    assert.equal((await f.backup.status(OWNER, b1.uploadId)).offset, 20)
    // A retried chunk at a stale offset is refused and says where to continue.
    await assert.rejects(f.backup.chunk(OWNER, fakeReq(first), new URLSearchParams({ uploadId: b1.uploadId, offset: '0' })), (e) => e.status === 409 && e.extra.offset === 20)
    // Finishing early is refused.
    await assert.rejects(f.backup.finish(OWNER, { uploadId: b1.uploadId }), (e) => e.status === 409 && e.extra.offset === 20)
    // Too much data is refused.
    await assert.rejects(f.backup.chunk(OWNER, fakeReq(Buffer.alloc(bytes.length)), new URLSearchParams({ uploadId: b1.uploadId, offset: '20' })), (e) => e.status === 400)
    const done = await sendAll(f.backup, OWNER, b2, bytes)
    assert.equal(done.status, 'saved')
    assert.equal(done.path, 'Pixel 8/2025/03/PXL_20250309.jpg')
    const saved = path.join(f.pics, 'Phone backups', 'Pixel 8', '2025', '03', 'PXL_20250309.jpg')
    assert.deepEqual(await fs.readFile(saved), bytes)
    assert.equal(Math.abs((await fs.stat(saved)).mtimeMs - takenAt) < 2000, true, 'file time is the date taken')
    assert.deepEqual(await fs.readdir(path.join(f.pics, 'Phone backups', '.beebo-incoming')), [], 'no partial files left')
    const sum = await f.backup.summary(OWNER, new URLSearchParams({ device: 'Pixel 8' }))
    assert.equal(sum.device.files, 1); assert.ok(sum.device.lastBackupAt > 0)
    // It shows up in the library as a Phone backups album.
    const tl = await f.library.timeline(new URLSearchParams(), f.library.access(OWNER))
    assert.deepEqual(tl.items.map((x) => x.name), ['PXL_20250309.jpg'])
  } finally { await cleanup(f.dir) }
})

test('Dedupe by SHA-256 across devices and reinstalls; same name, different photo is kept as (2)', async () => {
  const f = await backupFixture()
  try {
    const a = jpegWithExif({ original: '2025:05:01 10:00:00' })
    const b = jpegWithExif({ original: '2025:05:02 10:00:00' })
    const takenAt = new Date(2025, 4, 1).getTime()
    const r1 = await sendAll(f.backup, OWNER, await f.backup.begin(OWNER, { device: 'Phone', name: 'IMG_1.jpg', size: a.length, sha256: sha(a), takenAt }), a)
    assert.equal(r1.status, 'saved')
    // Same bytes from another phone (or after reinstalling): nothing to send.
    const again = await f.backup.begin(OWNER, { device: 'Tablet', name: 'copy.jpg', size: a.length, sha256: sha(a), takenAt })
    assert.equal(again.status, 'done'); assert.equal(again.duplicate, true)
    const check = await f.backup.check(OWNER, { items: [{ sha256: sha(a), size: a.length }, { sha256: sha(b), size: b.length }, { sha256: 'nope' }] })
    assert.deepEqual(check.results.map((x) => x.have), [true, false, false])
    // A different picture with the same name in the same month.
    const r2 = await sendAll(f.backup, OWNER, await f.backup.begin(OWNER, { device: 'Phone', name: 'IMG_1.jpg', size: b.length, sha256: sha(b), takenAt }), b)
    assert.equal(r2.status, 'saved'); assert.equal(r2.path, 'Phone/2025/05/IMG_1 (2).jpg')
    assert.deepEqual(await fs.readFile(path.join(f.pics, 'Phone backups', 'Phone', '2025', '05', 'IMG_1.jpg')), a, 'the first one is untouched')
    // The index forgets a file the owner deleted on the PC, so it can be backed up again.
    await fs.rm(path.join(f.pics, 'Phone backups', 'Phone', '2025', '05', 'IMG_1.jpg'))
    assert.equal((await f.backup.begin(OWNER, { device: 'Phone', name: 'IMG_1.jpg', size: a.length, sha256: sha(a), takenAt })).status, 'new')
    assert.equal(numbered('a.b.jpg', 3), 'a.b (3).jpg')
    assert.equal(/[\\/]/.test(safeSegment('..\\..\\CON', 'x')), false)
    assert.equal(safeSegment('../../evil', 'x').includes('/'), false)
    assert.equal(safeSegment('nul.txt', 'x'), '_nul.txt')
    assert.equal(safeSegment('   ', 'Phone'), 'Phone')
  } finally { await cleanup(f.dir) }
})

test('Checksums: a bad chunk is not written; a bad whole file is discarded', async () => {
  const f = await backupFixture()
  try {
    const bytes = jpegWithExif({ original: '2025:06:01 10:00:00' })
    const begin = await f.backup.begin(OWNER, { device: 'Phone', name: 'x.jpg', size: bytes.length, sha256: sha(bytes) })
    const part = bytes.subarray(0, 10)
    await assert.rejects(
      f.backup.chunk(OWNER, fakeReq(part, { 'x-chunk-sha256': sha(Buffer.from('other')) }), new URLSearchParams({ uploadId: begin.uploadId, offset: '0' })),
      (e) => e.status === 422 && e.code === 'chunk_checksum_mismatch' && e.extra.offset === 0)
    assert.equal((await f.backup.status(OWNER, begin.uploadId)).offset, 0)
    // The phone claims a hash that the bytes do not have (a flipped bit on the way).
    const wrong = Buffer.from(bytes); wrong[wrong.length - 5] ^= 1
    const lie = await f.backup.begin(OWNER, { device: 'Phone', name: 'y.jpg', size: bytes.length, sha256: sha(bytes).replace(/^./, (c) => c === 'a' ? 'b' : 'a') })
    let off = 0
    while (off < wrong.length) off = (await f.backup.chunk(OWNER, fakeReq(wrong.subarray(off, off + 50)), new URLSearchParams({ uploadId: lie.uploadId, offset: String(off) }))).offset
    await assert.rejects(f.backup.finish(OWNER, { uploadId: lie.uploadId }), (e) => e.status === 422 && e.code === 'checksum_mismatch')
    await assert.rejects(f.backup.status(OWNER, lie.uploadId), (e) => e.status === 404, 'discarded, so the phone starts over')
    // Chunk size cap.
    await assert.rejects(f.backup.chunk(OWNER, fakeReq(Buffer.alloc(0), { 'content-length': String(5 * 1024 * 1024) }), new URLSearchParams({ uploadId: begin.uploadId, offset: '0' })), (e) => e.status === 413)
    // Bad input.
    await assert.rejects(f.backup.begin(OWNER, { device: 'Phone', name: 'evil.exe', size: 10, sha256: sha(bytes) }), (e) => e.status === 415)
    await assert.rejects(f.backup.begin(OWNER, { device: 'Phone', name: 'a.jpg', size: -1, sha256: sha(bytes) }), (e) => e.status === 400)
    await assert.rejects(f.backup.begin(OWNER, { device: 'Phone', name: 'a.jpg', size: 10, sha256: 'xyz' }), (e) => e.status === 400)
    await assert.rejects(f.backup.status(OWNER, '../../x'), (e) => e.status === 400)
    // Names cannot escape the device folder.
    const evil = jpegWithExif({})
    const r = await sendAll(f.backup, OWNER, await f.backup.begin(OWNER, { device: '..\\..\\Windows', name: '..\\..\\evil.jpg', size: evil.length, sha256: sha(evil), takenAt: new Date(2020, 0, 1).getTime() }), evil)
    const segs = r.path.split('/')
    assert.equal(segs.length, 4, r.path)
    assert.equal(segs.includes('..'), false)
    assert.deepEqual(segs.slice(1), ['2020', '01', 'evil.jpg'])
    assert.ok((await fs.stat(path.join(f.pics, 'Phone backups', ...segs))).isFile())
  } finally { await cleanup(f.dir) }
})

test('Backup permission gating: members need the switch, uploads are per person', async () => {
  const f = await backupFixture()
  try {
    const bytes = jpegWithExif({})
    const meta = { device: 'Phone', name: 'a.jpg', size: bytes.length, sha256: sha(bytes) }
    await assert.rejects(f.backup.begin(MEMBER, meta), (e) => e.status === 403)
    await assert.rejects(f.backup.check(MEMBER, { items: [] }), (e) => e.status === 403)
    f.library.setAccess('member', { view: true, backup: false })
    await assert.rejects(f.backup.begin(MEMBER, meta), (e) => e.status === 403, 'seeing photos is not backing up')
    const ownerBegin = await f.backup.begin(OWNER, meta)
    f.library.setAccess('member', { backup: true })
    const memberBegin = await f.backup.begin(MEMBER, meta)
    assert.notEqual(memberBegin.uploadId, ownerBegin.uploadId)
    await assert.rejects(f.backup.status(MEMBER, ownerBegin.uploadId), (e) => e.status === 404, "someone else's upload is invisible")
    await assert.rejects(f.backup.chunk(MEMBER, fakeReq(bytes), new URLSearchParams({ uploadId: ownerBegin.uploadId, offset: '0' })), (e) => e.status === 404)
    f.library.setAccess('member', { view: false, backup: false })
    await assert.rejects(f.backup.finish(MEMBER, { uploadId: memberBegin.uploadId }), (e) => e.status === 403, 'switching off applies to uploads in flight')
  } finally { await cleanup(f.dir) }
})

/* ------------------------------ HTTP ------------------------------ */

test('HTTP: real stream server gates /api/photos, media tokens, chunk upload over the wire', async () => {
  const server = localRequire('./electron/streamServer')
  const dir = await tmpdir('http')
  let info
  try {
    const pics = path.join(dir, 'Pictures')
    await fs.mkdir(pics, { recursive: true })
    const photo = jpegWithExif({ original: '2024:04:04 04:04:04', gps: { latRef: 'N', lat: [1, 1, 1], lonRef: 'E', lon: [2, 2, 2] } })
    await fs.writeFile(path.join(pics, 'p.jpg'), photo)
    await fs.writeFile(path.join(pics, 'v.mp4'), mp4WithCreation(new Date(2023, 1, 1)))
    const users = [{ ...OWNER }, { ...MEMBER }]
    const store = memStore({ photosDirs: [pics], authUsers: users })
    store.path = path.join(dir, 'config.json') // photos cache lives beside the settings file
    const port = testPort()
    info = server.startStreamServer({ port, store, getMoviesDir: () => dir, getTvShowsDir: () => dir, getAllMoviesDirs: () => [], getAllTvShowsDirs: () => [], log: () => {} })
    const base = 'http://127.0.0.1:' + info.port
    for (let i = 0; i < 50; i++) { try { await (await fetch(base + '/api/ping')).arrayBuffer(); break } catch { await new Promise((r) => setTimeout(r, 100)) } }
    const ownerTok = server.makeApiToken(store, 'owner'), memberTok = server.makeApiToken(store, 'member')
    const call = async (route, token, opts = {}) => {
      const r = await fetch(base + route, { ...opts, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(opts.headers || {}) } })
      const buf = Buffer.from(await r.arrayBuffer())
      let json = null; try { json = JSON.parse(buf.toString('utf8')) } catch {}
      return { status: r.status, json, buf, headers: r.headers }
    }
    assert.equal((await call('/api/photos/timeline')).status, 401)
    assert.equal((await call('/api/photos/timeline', memberTok)).status, 403)
    assert.equal((await call('/api/photos/settings', memberTok)).status, 403)
    let r = await call('/api/photos/timeline?tokens=1', ownerTok)
    assert.equal(r.status, 200)
    assert.deepEqual(r.json.items.map((x) => x.name), ['p.jpg', 'v.mp4'])
    const p = r.json.items[0], v = r.json.items[1]
    assert.equal(p.location, undefined)
    // Map pins: gated the same as location - needs view access, and off until the owner shows it.
    assert.equal((await call('/api/photos/map', memberTok)).status, 403)
    r = await call('/api/photos/map?tokens=1', ownerTok)
    assert.equal(r.status, 200)
    assert.deepEqual(r.json, { ok: true, enabled: false, items: [] })
    r = await call('/api/photos/settings', ownerTok, { method: 'POST', body: JSON.stringify({ showLocation: true }) })
    assert.equal(r.status, 200); assert.equal(r.json.showLocation, true)
    r = await call('/api/photos/map?tokens=1', ownerTok)
    assert.equal(r.status, 200); assert.equal(r.json.enabled, true)
    assert.deepEqual(r.json.items.map((x) => x.name), ['p.jpg'], 'only the item with GPS is a pin')
    assert.ok(Math.abs(r.json.items[0].lat - 1.017) < 0.01)
    assert.ok(r.json.items[0].mt.thumb, 'reuses the same thumbnail tokens as the timeline')
    // Owner shares Photos (view only) with the member.
    r = await call('/api/photos/access', ownerTok, { method: 'POST', body: JSON.stringify({ userId: 'member', view: true, backup: false }) })
    assert.equal(r.status, 200)
    assert.equal(r.json.users.find((u) => u.id === 'member').view, true)
    r = await call('/api/photos/timeline?tokens=1', memberTok)
    assert.equal(r.status, 200)
    assert.equal(r.json.items[0].mt.original, undefined, 'no photo original token for members')
    assert.ok(r.json.items[1].mt.original, 'videos can be played')
    assert.deepEqual((await call('/api/photos/map?tokens=1', memberTok)).json, { ok: true, enabled: false, items: [] }, 'a member with view access still never gets pins')
    assert.equal((await call('/api/photos/original?id=' + p.id, memberTok)).status, 403)
    r = await call('/api/photos/original?id=' + p.id, ownerTok, { headers: { Range: 'bytes=0-1' } })
    assert.equal(r.status, 206); assert.deepEqual([...r.buf], [0xff, 0xd8])
    r = await call('/api/photos/original?id=' + v.id, memberTok, { headers: { Range: 'bytes=4-11' } })
    assert.equal(r.status, 206); assert.equal(r.buf.toString('latin1'), 'ftypisom')
    // Without ffmpeg in the test the viewing copy falls back to the stripped original: no Exif.
    r = await call('/api/photos/view?id=' + p.id, memberTok)
    if (r.status === 200) assert.equal(r.buf.indexOf('Exif', 0, 'latin1'), -1)
    // Media tokens: right item + rendition only.
    r = await call('/api/photos/media/thumb?id=' + p.id + '&mt=' + encodeURIComponent(p.mt.thumb))
    assert.notEqual(r.status, 403)
    assert.equal((await call('/api/photos/media/original?id=' + p.id + '&mt=' + encodeURIComponent(p.mt.thumb))).status, 403)
    assert.equal((await call('/api/photos/media/thumb?id=' + v.id + '&mt=' + encodeURIComponent(p.mt.thumb))).status, 403)
    assert.equal((await call('/api/photos/media/thumb?id=' + p.id)).status, 403)
    // Traversal through the API.
    assert.equal((await call('/api/photos/item?id=' + encodeURIComponent('..\\..\\Windows\\win.ini'), ownerTok)).status, 400)
    // Member without backup permission cannot upload; owner can, in chunks, over HTTP.
    const bytes = jpegWithExif({ original: '2026:09:01 12:00:00' })
    const meta = { device: 'Galaxy', name: 'IMG_9.jpg', size: bytes.length, sha256: sha(bytes), takenAt: new Date(2026, 8, 1).getTime() }
    assert.equal((await call('/api/photos/backup/begin', memberTok, { method: 'POST', body: JSON.stringify(meta) })).status, 403)
    r = await call('/api/photos/backup/begin', ownerTok, { method: 'POST', body: JSON.stringify(meta) })
    assert.equal(r.status, 200)
    const id = r.json.uploadId
    let off = 0
    while (off < bytes.length) {
      const part = bytes.subarray(off, off + 64)
      r = await call(`/api/photos/backup/chunk?uploadId=${id}&offset=${off}`, ownerTok, { method: 'PUT', body: part, headers: { 'Content-Type': 'application/octet-stream', 'X-Chunk-Sha256': sha(part) } })
      assert.equal(r.status, 200, JSON.stringify(r.json))
      off = r.json.offset
    }
    r = await call(`/api/photos/backup/chunk?uploadId=${id}&offset=0`, ownerTok, { method: 'PUT', body: bytes.subarray(0, 4) })
    assert.equal(r.status, 409); assert.equal(r.json.offset, bytes.length)
    r = await call('/api/photos/backup/finish', ownerTok, { method: 'POST', body: JSON.stringify({ uploadId: id }) })
    assert.equal(r.status, 200); assert.equal(r.json.path, 'Galaxy/2026/09/IMG_9.jpg')
    r = await call('/api/photos/backup/summary?device=Galaxy', ownerTok)
    assert.equal(r.json.device.files, 1)
    // The web page is behind the website sign-in.
    const pageRes = await fetch(base + '/photos', { redirect: 'manual' })
    await pageRes.arrayBuffer()
    assert.equal(pageRes.status, 302)
  } finally {
    if (info) { try { info.closeAllConnections() } catch {} await new Promise((r) => info.close(r)) }
    await cleanup(dir)
  }
})
