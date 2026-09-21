'use strict'
// gzip for the big JSON answers (/api/movies is ~780 KB for 1,000 films, /api/tvshows ~280 KB for 1,300 shows,
// a music track list several MB). Only when the client says it can read gzip (every browser, OkHttp and
// URLSession do, on their own), only above a size where it pays, and asynchronously so a compression of a big
// list never holds up the other viewers' streams. Clients that do not send Accept-Encoding get exactly the
// bytes they always got.

const zlib = require('zlib')

const MIN_BYTES = 4096

function acceptsGzip(req) {
  const h = req && req.headers && req.headers['accept-encoding']
  if (!h) return false
  // "gzip", "gzip, deflate, br", "gzip;q=0.8"; a q of 0 means "not acceptable".
  for (const part of String(h).split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';')
    if (name !== 'gzip' && name !== '*') continue
    const q = params.map((p) => /^\s*q\s*=\s*([\d.]+)/.exec(p)).find(Boolean)
    if (!q || Number(q[1]) > 0) return true
  }
  return false
}

/** Calls done(gzippedBuffer) or done(null) (too small, not accepted, or failed): the caller then sends `buf` as it is. */
function gzipIfWorthIt(req, buf, done) {
  if (!buf || buf.length < MIN_BYTES || !acceptsGzip(req)) { done(null); return }
  zlib.gzip(buf, { level: 1 }, (err, out) => { done(err || !out || out.length >= buf.length ? null : out) })
}

module.exports = { acceptsGzip, gzipIfWorthIt, MIN_BYTES }
