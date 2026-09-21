const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { serveFile, parseRange, etagFor, ifRangeMatches } = require('../electron/fileServe')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-fileserve-'))
const DATA = crypto.randomBytes(100_000)
const file = path.join(dir, 'movie.mp4')
fs.writeFileSync(file, DATA)
const empty = path.join(dir, 'empty.mp4')
fs.writeFileSync(empty, '')

let server
let base
test.before(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    const name = u.searchParams.get('f') || 'movie.mp4'
    serveFile(req, res, path.join(dir, name), { mime: 'video/mp4' })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}/`
})
test.after(async () => {
  server.closeAllConnections()
  await new Promise((r) => server.close(r))
  fs.rmSync(dir, { recursive: true, force: true })
})

const get = (headers = {}, q = '', method = 'GET') => fetch(base + q, { method, headers })
const bytes = async (r) => Buffer.from(await r.arrayBuffer())

test('parseRange: every form a client sends', () => {
  const size = 1000
  assert.deepEqual(parseRange(undefined, size), { kind: 'full' })
  assert.deepEqual(parseRange('', size), { kind: 'full' })
  assert.deepEqual(parseRange('bytes=0-', size), { kind: 'range', start: 0, end: 999 })
  assert.deepEqual(parseRange('bytes=10-19', size), { kind: 'range', start: 10, end: 19 })
  assert.deepEqual(parseRange('bytes=10-99999', size), { kind: 'range', start: 10, end: 999 })
  assert.deepEqual(parseRange('bytes=-100', size), { kind: 'range', start: 900, end: 999 })
  assert.deepEqual(parseRange('bytes=-5000', size), { kind: 'range', start: 0, end: 999 })
  assert.deepEqual(parseRange('  Bytes = 3-4 ', size), { kind: 'range', start: 3, end: 4 })
  assert.equal(parseRange('bytes=-0', size).kind, 'unsatisfiable')
  assert.equal(parseRange('bytes=1000-', size).kind, 'unsatisfiable')
  assert.equal(parseRange('bytes=5-3', size).kind, 'unsatisfiable')
  assert.equal(parseRange('bytes=-', size).kind, 'unsatisfiable')
  assert.equal(parseRange('bytes=abc', size).kind, 'unsatisfiable')
  assert.equal(parseRange('bytes=', size).kind, 'unsatisfiable')
  assert.equal(parseRange('bytes=0-1,5-6', size).kind, 'full', 'several ranges: the whole file')
  assert.equal(parseRange('items=0-5', size).kind, 'full', 'an unknown unit is ignored')
  assert.equal(parseRange('bytes=0-', 0).kind, 'unsatisfiable', 'nothing to range over in an empty file')
  assert.equal(parseRange('bytes=-1', 0).kind, 'unsatisfiable')
})

test('parseRange: offsets past 2^32 and past 2^53 stay exact numbers', () => {
  const big = 5 * 2 ** 30 + 123
  assert.deepEqual(parseRange(`bytes=${4 * 2 ** 30}-`, big), { kind: 'range', start: 4 * 2 ** 30, end: big - 1 })
  assert.deepEqual(parseRange(`bytes=${2 ** 32 + 5}-${2 ** 32 + 9}`, big), { kind: 'range', start: 2 ** 32 + 5, end: 2 ** 32 + 9 })
  assert.deepEqual(parseRange('bytes=-100', big), { kind: 'range', start: big - 100, end: big - 1 })
  assert.equal(parseRange('bytes=99999999999999999999999-', big).kind, 'unsatisfiable')
  assert.deepEqual(parseRange('bytes=10-99999999999999999999999', big), { kind: 'range', start: 10, end: big - 1 })
  assert.equal(parseRange('bytes=-99999999999999999999999', big).start, 0)
})

test('no Range: 200, the whole file, and the validators a resuming client keeps', async () => {
  const r = await get()
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('accept-ranges'), 'bytes')
  assert.equal(r.headers.get('content-length'), String(DATA.length))
  assert.equal(r.headers.get('content-type'), 'video/mp4')
  assert.equal(r.headers.get('content-encoding'), null)
  assert.match(r.headers.get('etag'), /^"[0-9a-f]+-[0-9a-f]+"$/)
  assert.ok(Number.isFinite(Date.parse(r.headers.get('last-modified'))))
  assert.ok((await bytes(r)).equals(DATA))
})

test('ranges: from the start, the middle, a suffix, clamped past the end', async () => {
  let r = await get({ Range: 'bytes=0-' })
  assert.equal(r.status, 206)
  assert.equal(r.headers.get('content-range'), `bytes 0-${DATA.length - 1}/${DATA.length}`)
  assert.ok((await bytes(r)).equals(DATA))

  r = await get({ Range: 'bytes=1000-1999' })
  assert.equal(r.status, 206)
  assert.equal(r.headers.get('content-length'), '1000')
  assert.equal(r.headers.get('content-range'), `bytes 1000-1999/${DATA.length}`)
  assert.ok((await bytes(r)).equals(DATA.subarray(1000, 2000)))

  r = await get({ Range: 'bytes=-500' })
  assert.equal(r.status, 206)
  assert.equal(r.headers.get('content-range'), `bytes ${DATA.length - 500}-${DATA.length - 1}/${DATA.length}`)
  assert.ok((await bytes(r)).equals(DATA.subarray(DATA.length - 500)))

  r = await get({ Range: 'bytes=99000-9999999' })
  assert.equal(r.status, 206)
  assert.equal(r.headers.get('content-range'), `bytes 99000-${DATA.length - 1}/${DATA.length}`)
  assert.ok((await bytes(r)).equals(DATA.subarray(99000)))

  r = await get({ Range: `bytes=${DATA.length - 1}-` })
  assert.equal(r.status, 206)
  assert.equal((await bytes(r)).length, 1)
})

test('ranges that cannot be met are 416 with the size, and nothing is sent', async () => {
  for (const range of [`bytes=${DATA.length}-`, 'bytes=200000-300000', 'bytes=-0', 'bytes=9-2', 'bytes=abc', 'bytes=99999999999999999999-']) {
    const r = await get({ Range: range })
    assert.equal(r.status, 416, range)
    assert.equal(r.headers.get('content-range'), `bytes */${DATA.length}`, range)
    assert.equal((await bytes(r)).length, 0, range)
  }
})

test('several ranges or an unknown unit: the whole file, not an error', async () => {
  for (const range of ['bytes=0-9,20-29', 'items=0-9']) {
    const r = await get({ Range: range })
    assert.equal(r.status, 200, range)
    assert.ok((await bytes(r)).equals(DATA), range)
  }
})

test('HEAD: the headers of a GET, no body, for whole files and ranges alike', async () => {
  let r = await get({}, '', 'HEAD')
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('content-length'), String(DATA.length))
  assert.equal(r.headers.get('accept-ranges'), 'bytes')
  assert.equal((await bytes(r)).length, 0)
  r = await get({ Range: 'bytes=10-19' }, '', 'HEAD')
  assert.equal(r.status, 206)
  assert.equal(r.headers.get('content-range'), `bytes 10-19/${DATA.length}`)
  assert.equal(r.headers.get('content-length'), '10')
  assert.equal((await bytes(r)).length, 0)
})

test('If-Range: a matching ETag or date resumes; anything else starts the file again', async () => {
  const first = await get({}, '', 'HEAD')
  const etag = first.headers.get('etag')
  const modified = first.headers.get('last-modified')

  let r = await get({ Range: 'bytes=100-199', 'If-Range': etag })
  assert.equal(r.status, 206)
  assert.ok((await bytes(r)).equals(DATA.subarray(100, 200)))

  r = await get({ Range: 'bytes=100-199', 'If-Range': modified })
  assert.equal(r.status, 206)
  await bytes(r)

  for (const stale of ['"1-1"', `W/${etag}`, 'Thu, 01 Jan 1970 00:00:00 GMT', 'not a date', modified.replace(/\d{4}/, '1999')]) {
    r = await get({ Range: 'bytes=100-199', 'If-Range': stale })
    assert.equal(r.status, 200, stale)
    assert.equal(r.headers.get('content-range'), null, stale)
    assert.ok((await bytes(r)).equals(DATA), stale)
  }

  r = await get({ 'If-Range': '"1-1"' })
  assert.equal(r.status, 200, 'If-Range without Range is ignored')
  await bytes(r)
})

test('If-Range follows the file: the ETag changes when the file does', async () => {
  const f = path.join(dir, 'changing.bin')
  fs.writeFileSync(f, Buffer.alloc(5000, 1))
  const before = (await get({}, '?f=changing.bin', 'HEAD')).headers.get('etag')
  fs.writeFileSync(f, Buffer.alloc(6000, 2))
  const after = (await get({}, '?f=changing.bin', 'HEAD')).headers.get('etag')
  assert.notEqual(before, after)
  const r = await get({ Range: 'bytes=10-19', 'If-Range': before }, '?f=changing.bin')
  assert.equal(r.status, 200)
  assert.equal((await bytes(r)).length, 6000)
})

test('an empty file: 200 with no body, every range is 416', async () => {
  let r = await get({}, '?f=empty.mp4')
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('content-length'), '0')
  assert.equal((await bytes(r)).length, 0)
  for (const range of ['bytes=0-', 'bytes=0-0', 'bytes=-1']) {
    r = await get({ Range: range }, '?f=empty.mp4')
    assert.equal(r.status, 416, range)
    assert.equal(r.headers.get('content-range'), 'bytes */0')
    await bytes(r)
  }
})

test('a file that is missing, or is a folder, is a 404', async () => {
  let r = await get({}, '?f=gone.mp4')
  assert.equal(r.status, 404)
  await bytes(r)
  fs.mkdirSync(path.join(dir, 'folder.mp4'))
  r = await get({}, '?f=folder.mp4')
  assert.equal(r.status, 404)
  await bytes(r)
})

test('a file larger than 4 GiB: ranges past 2^32 are served from the right byte', async (t) => {
  if (process.platform === 'win32' && !process.env.BEEBO_HUGE_FILE_TEST) {
    t.skip('NTFS zero-fills a 4 GiB file (30+ s); set BEEBO_HUGE_FILE_TEST=1 to run it. Linux CI makes it sparse instantly.')
    return
  }
  const f = path.join(dir, 'huge.mkv')
  const size = 4 * 2 ** 30 + 4096
  const marker = Buffer.from('BEEBO-PAST-4GB')
  const at = 4 * 2 ** 30 + 100
  try {
    const fd = fs.openSync(f, 'w')
    fs.ftruncateSync(fd, size)
    fs.writeSync(fd, marker, 0, marker.length, at)
    fs.closeSync(fd)
  } catch (e) {
    t.skip('this disk cannot make a 4 GiB test file: ' + e.code)
    return
  }
  try {
    let r = await get({ Range: `bytes=${at}-${at + marker.length - 1}` }, '?f=huge.mkv')
    assert.equal(r.status, 206)
    assert.equal(r.headers.get('content-range'), `bytes ${at}-${at + marker.length - 1}/${size}`)
    assert.ok((await bytes(r)).equals(marker))
    r = await get({ Range: 'bytes=-4' }, '?f=huge.mkv')
    assert.equal(r.headers.get('content-range'), `bytes ${size - 4}-${size - 1}/${size}`)
    assert.equal((await bytes(r)).length, 4)
    r = await get({ Range: `bytes=${size}-` }, '?f=huge.mkv')
    assert.equal(r.status, 416)
    assert.equal(r.headers.get('content-range'), `bytes */${size}`)
    await bytes(r)
    r = await get({}, '?f=huge.mkv', 'HEAD')
    assert.equal(r.headers.get('content-length'), String(size))
  } finally {
    fs.rmSync(f, { force: true })
  }
})

test('a client that hangs up mid-file lets the file go', async () => {
  const f = path.join(dir, 'abort.bin')
  fs.writeFileSync(f, crypto.randomBytes(8 * 1024 * 1024))
  const ac = new AbortController()
  const r = await fetch(base + '?f=abort.bin', { signal: ac.signal })
  const reader = r.body.getReader()
  await reader.read()
  ac.abort()
  await reader.cancel().catch(() => {})
  await new Promise((res) => setTimeout(res, 200))
  fs.rmSync(f)
  assert.equal(fs.existsSync(f), false, 'the file can be deleted while nobody is reading it (no handle left open)')
})

test('etagFor and ifRangeMatches agree on what a validator is', () => {
  const stat = { size: 255, mtimeMs: 1_700_000_000_123 }
  assert.equal(etagFor(stat), `"ff-${Math.floor(1_700_000_000_123).toString(16)}"`)
  assert.equal(ifRangeMatches(undefined, stat), true)
  assert.equal(ifRangeMatches(etagFor(stat), stat), true)
  assert.equal(ifRangeMatches(new Date(1_700_000_000_000).toUTCString(), stat), true)
  assert.equal(ifRangeMatches(new Date(1_700_000_001_000).toUTCString(), stat), false)
})
