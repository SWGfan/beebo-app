// Security review 2026-09-21 (L-1): request bodies were read into memory with no cap, so one
// unauthenticated POST of a few gigabytes to /login or /api/login could exhaust the server's memory.
// Every body reader is now capped (streamServer.js cappedBody). Run: node --test test/sec-body-limit.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { withServer } = require('./security-harness')

// Send `bytes` of body in 64 KB pieces (chunked, or with a declared length) and report how it ended.
function flood(port, pathname, { bytes, declare, contentType = 'application/json' }) {
  return new Promise((resolve) => {
    const headers = { 'content-type': contentType }
    if (declare != null) headers['content-length'] = String(declare)
    else headers['transfer-encoding'] = 'chunked'
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'POST', headers }, (res) => {
      res.resume()
      res.on('end', () => resolve({ status: res.statusCode }))
      res.on('error', () => resolve({ status: 0 }))
    })
    let sent = 0
    let done = false
    const finish = (r) => { if (!done) { done = true; resolve(r) } }
    req.on('error', () => finish({ status: 0, sent }))
    req.on('close', () => finish({ status: 0, sent }))
    const piece = Buffer.alloc(64 * 1024, 0x41)
    const pump = () => {
      if (done) return
      while (sent < bytes) {
        sent += piece.length
        if (!req.write(piece)) { req.once('drain', pump); return }
      }
      req.end()
    }
    pump()
    setTimeout(() => finish({ status: -1, sent }), 15000).unref()
  })
}

async function alive(port) {
  const r = await fetch(`http://127.0.0.1:${port}/api/ping`)
  return (await r.json()).ok === true
}

test('an oversized unauthenticated body is cut off, not buffered, and the server keeps serving', async () => {
  await withServer({}, async ({ port, raw }) => {
    // Declared length far over the cap: refused before a byte is buffered.
    const declared = await flood(port, '/api/login', { bytes: 256 * 1024, declare: 500 * 1024 * 1024 })
    assert.notEqual(declared.status, 200)
    assert.ok(declared.status === 0 || declared.status >= 400, 'declared oversize body is not accepted')
    // No length declared (chunked): cut off once the cap is passed.
    const chunked = await flood(port, '/api/login', { bytes: 12 * 1024 * 1024 })
    assert.ok(chunked.status === 0 || chunked.status >= 400, 'chunked oversize body is not accepted')
    assert.ok(chunked.sent < 12 * 1024 * 1024 || chunked.status === 0, 'the server stopped reading')
    // The website's form readers are capped too (much lower).
    const form = await flood(port, '/login', { bytes: 4 * 1024 * 1024, contentType: 'application/x-www-form-urlencoded' })
    assert.ok(form.status !== 200, 'oversize login form is not accepted')
    assert.equal(await alive(port), true, 'the server is still answering')
    // A normal small request still works exactly as before.
    const ok = await raw({ method: 'POST', pathname: '/api/login', headers: { 'content-type': 'application/json' }, body: { username: 'nobody', password: 'wrong-password-1' } })
    assert.equal(ok.status, 401)
  })
})
