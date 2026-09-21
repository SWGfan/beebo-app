'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const http = require('node:http')
const path = require('node:path')
const zlib = require('node:zlib')
const { acceptsGzip, gzipIfWorthIt, MIN_BYTES } = require('../electron/compressJson')
const { createFixture } = require('./helpers/publicApiFixture')

const req = (h) => ({ headers: h })

test('acceptsGzip reads Accept-Encoding the way browsers and HTTP libraries send it', () => {
  assert.equal(acceptsGzip(req({})), false)
  assert.equal(acceptsGzip(req({ 'accept-encoding': 'identity' })), false)
  assert.equal(acceptsGzip(req({ 'accept-encoding': 'gzip' })), true)
  assert.equal(acceptsGzip(req({ 'accept-encoding': 'gzip, deflate, br' })), true)
  assert.equal(acceptsGzip(req({ 'accept-encoding': 'deflate, GZIP;q=0.5' })), true)
  assert.equal(acceptsGzip(req({ 'accept-encoding': 'gzip;q=0' })), false)
  assert.equal(acceptsGzip(req({ 'accept-encoding': '*' })), true)
  assert.equal(acceptsGzip(null), false)
})

test('small bodies and clients without gzip are left alone; big ones shrink and round-trip', async () => {
  const gz = req({ 'accept-encoding': 'gzip' })
  const small = Buffer.from('x'.repeat(MIN_BYTES - 1))
  assert.equal(await new Promise((r) => gzipIfWorthIt(gz, small, r)), null)
  const big = Buffer.from(JSON.stringify({ items: Array.from({ length: 500 }, (_, i) => ({ id: i, title: 'Film number ' + i, genres: [1, 2, 3] })) }))
  assert.equal(await new Promise((r) => gzipIfWorthIt(req({}), big, r)), null)
  const out = await new Promise((r) => gzipIfWorthIt(gz, big, r))
  assert.ok(out && out.length < big.length / 3, 'shrinks: ' + (out && out.length) + ' of ' + big.length)
  assert.deepEqual(zlib.gunzipSync(out), big)
})

function get(base, route, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + route)
    const r = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    r.on('error', reject)
    r.end()
  })
}

test('/api/movies: gzip only when asked, identical JSON either way, correct Content-Length', async (t) => {
  const f = await createFixture(t)
  for (let i = 0; i < 120; i++) await fs.writeFile(path.join(f.moviesDir, `Bulk Film ${i} (20${String(i % 25).padStart(2, '0')}).mp4`), 'x')
  const auth = { Authorization: 'Bearer ' + f.tokens.owner }
  const plain = await get(f.base, '/api/movies', { ...auth, 'Accept-Encoding': 'identity' })
  const zipped = await get(f.base, '/api/movies', { ...auth, 'Accept-Encoding': 'gzip, deflate' })
  const bare = await get(f.base, '/api/movies', auth)
  assert.equal(plain.status, 200)
  assert.equal(plain.headers['content-encoding'], undefined)
  assert.equal(bare.headers['content-encoding'], undefined, 'no Accept-Encoding: the bytes clients always got')
  assert.equal(zipped.headers['content-encoding'], 'gzip')
  assert.match(String(zipped.headers.vary), /Accept-Encoding/i)
  assert.equal(Number(zipped.headers['content-length']), zipped.body.length)
  assert.ok(zipped.body.length < plain.body.length / 3, `${zipped.body.length} vs ${plain.body.length}`)
  // Each answer carries freshly signed stream tokens, so compare everything but those.
  const strip = (b) => { const j = JSON.parse(b.toString('utf8')); for (const it of j.items) delete it.stream; return j }
  assert.deepEqual(strip(zlib.gunzipSync(zipped.body)), strip(plain.body))
  assert.equal(plain.headers['cache-control'], 'no-store')
  assert.equal(zipped.headers['cache-control'], 'no-store')
  const small = await get(f.base, '/api/ping', { 'Accept-Encoding': 'gzip' })
  assert.equal(small.headers['content-encoding'], undefined, 'a tiny answer is not compressed')
  const head = await new Promise((resolve, reject) => {
    const u = new URL(f.base + '/api/movies')
    const r = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'HEAD', headers: { ...auth, 'Accept-Encoding': 'gzip' } }, (res) => { res.resume(); res.on('end', () => resolve(res)) })
    r.on('error', reject); r.end()
  })
  assert.equal(head.statusCode, 200)
  assert.equal(head.headers['content-encoding'], 'gzip')
})
