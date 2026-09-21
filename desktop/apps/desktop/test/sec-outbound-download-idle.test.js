// Security review 2026-09-21 (O-9): an episode download had a 30 minute overall limit and no idle limit, so a
// publisher that sends a byte a minute held the one download slot for the whole half hour and every other
// download queued behind it. A download that receives nothing for idleTimeoutMs now ends with 'timeout'.
// Run: node --test test/sec-outbound-download-idle.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createFetcher } = require('../electron/outboundFetch')

function trickleServer() {
  const S = { closed: 0, sockets: [] }
  const server = net.createServer((sock) => {
    S.sockets.push(sock)
    sock.on('error', () => {})
    sock.on('close', () => { S.closed++ })
    sock.once('data', () => {
      sock.write('HTTP/1.1 200 OK\r\nContent-Type: audio/mpeg\r\nContent-Length: 100000\r\n\r\nabcde')
      // ... and then nothing.
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    S.url = `http://127.0.0.1:${server.address().port}/ep.mp3`
    S.close = () => new Promise((r) => { for (const s of S.sockets) s.destroy(); server.close(() => r()) })
    resolve(S)
  }))
}

test('O-9: a download that stops receiving data ends with "timeout", removes its .part file and closes the connection', async () => {
  const S = await trickleServer()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-dl-idle-'))
  const file = path.join(dir, 'ep.mp3')
  const fetcher = createFetcher({ allowPrivateNetwork: true })
  try {
    const started = Date.now()
    await assert.rejects(fetcher.download(S.url, file, { idleTimeoutMs: 300, maxBytes: 1 << 20 }), (e) => e.code === 'timeout')
    const took = Date.now() - started
    assert.ok(took < 2000, `gave up after ${took} ms`)
    assert.equal(fs.existsSync(file), false)
    assert.equal(fs.existsSync(file + '.part'), false)
    const end = Date.now() + 1500
    while (S.closed < 1 && Date.now() < end) await new Promise((r) => setTimeout(r, 20))
    assert.equal(S.closed, 1, 'the publisher connection was closed')
  } finally {
    await S.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('O-9: a normal download is unaffected by the idle limit', async () => {
  const body = Buffer.alloc(200000, 7)
  const server = require('node:http').createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': body.length }); res.end(body) })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-dl-ok-'))
  try {
    const fetcher = createFetcher({ allowPrivateNetwork: true })
    const file = path.join(dir, 'ok.mp3')
    const r = await fetcher.download(`http://127.0.0.1:${server.address().port}/ok.mp3`, file, { idleTimeoutMs: 300 })
    assert.equal(r.size, body.length)
    assert.equal(fs.readFileSync(file).length, body.length)
  } finally {
    server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
