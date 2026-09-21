'use strict'

// Serves one file from disk the way a download needs it: byte ranges (206/416), a validator a
// resuming client can rely on (ETag/Last-Modified, honoured through If-Range), HEAD, and a
// streaming read with a large buffer that is torn down the moment the client goes away.
//
// Range policy:
//   no header, another unit, or several ranges  -> the whole file, 200 (a server may ignore a Range)
//   one range that overlaps the file             -> 206 with that range, clamped to the file
//   one range that starts past the end, a suffix of 0 bytes, an inverted or empty
//   range, or any range on an empty file         -> 416 with Content-Range: bytes */size
// A range is ignored (200, whole file) when If-Range doesn't match the file as it is now, so a
// client resuming a file that changed on the server starts over instead of splicing two versions.

const fs = require('node:fs')

const STREAM_OPTS = { highWaterMark: 1 << 20 }

// Longer than any file: a number that no byte offset can reach, without losing precision parsing it.
const MAX_DIGITS = 15

function toOffset(digits) {
  return digits.length > MAX_DIGITS ? Infinity : Number(digits)
}

function parseRange(header, size) {
  if (header == null || header === '') return { kind: 'full' }
  const unit = /^\s*bytes\s*=\s*(.*)$/is.exec(String(header))
  if (!unit) return { kind: 'full' }
  const specs = unit[1].split(',').map((s) => s.trim()).filter(Boolean)
  if (specs.length === 0) return { kind: 'unsatisfiable' }
  if (specs.length > 1) return { kind: 'full' }
  const m = /^(\d*)-(\d*)$/.exec(specs[0])
  if (!m || (m[1] === '' && m[2] === '')) return { kind: 'unsatisfiable' }
  if (m[1] === '') {
    const n = toOffset(m[2])
    if (n === 0 || size === 0) return { kind: 'unsatisfiable' }
    return { kind: 'range', start: Math.max(0, size - n), end: size - 1 }
  }
  const start = toOffset(m[1])
  if (start >= size) return { kind: 'unsatisfiable' }
  if (m[2] === '') return { kind: 'range', start, end: size - 1 }
  const last = toOffset(m[2])
  if (last < start) return { kind: 'unsatisfiable' }
  return { kind: 'range', start, end: Math.min(last, size - 1) }
}

function etagFor(stat) {
  return `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`
}

function lastModifiedFor(stat) {
  return new Date(Math.floor(stat.mtimeMs / 1000) * 1000).toUTCString()
}

// A strong ETag must match exactly (a weak one never counts); a date must be the modification time.
function ifRangeMatches(header, stat) {
  if (header == null || header === '') return true
  const v = String(header).trim()
  if (v.startsWith('W/')) return false
  if (v.startsWith('"')) return v === etagFor(stat)
  const at = Date.parse(v)
  return Number.isFinite(at) && at === Math.floor(stat.mtimeMs / 1000) * 1000
}

function streamFile(res, filePath, opts) {
  const rs = fs.createReadStream(filePath, opts)
  res.on('close', () => rs.destroy())
  rs.on('error', () => { try { res.destroy() } catch (e) {} })
  rs.pipe(res)
  return rs
}

// Never throws and never blocks the event loop on the disk: a file that vanished is a 404.
function serveFile(req, res, filePath, { mime = 'application/octet-stream', streamOpts = STREAM_OPTS, headers = {} } = {}) {
  fs.stat(filePath, (err, stat) => {
    if (res.destroyed || res.writableEnded) return
    if (err || !stat.isFile()) {
      res.writeHead(404)
      res.end('Not found')
      return
    }
    const size = stat.size
    const base = {
      'Accept-Ranges': 'bytes',
      'Content-Type': mime,
      ETag: etagFor(stat),
      'Last-Modified': lastModifiedFor(stat),
      ...headers
    }
    const head = String(req.method || 'GET').toUpperCase() === 'HEAD'
    let range = parseRange(req.headers.range, size)
    if (range.kind === 'range' && !ifRangeMatches(req.headers['if-range'], stat)) range = { kind: 'full' }

    if (range.kind === 'unsatisfiable') {
      res.writeHead(416, { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes */${size}` })
      res.end()
      return
    }
    if (range.kind === 'range') {
      res.writeHead(206, { ...base, 'Content-Range': `bytes ${range.start}-${range.end}/${size}`, 'Content-Length': range.end - range.start + 1 })
      if (head) { res.end(); return }
      streamFile(res, filePath, { start: range.start, end: range.end, ...streamOpts })
      return
    }
    res.writeHead(200, { ...base, 'Content-Length': size })
    if (head || size === 0) { res.end(); return }
    streamFile(res, filePath, streamOpts)
  })
}

module.exports = { serveFile, parseRange, etagFor, lastModifiedFor, ifRangeMatches, STREAM_OPTS }
