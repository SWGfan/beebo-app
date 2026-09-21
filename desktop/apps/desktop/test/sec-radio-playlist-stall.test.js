// Security review 2026-09-21 (O-8): a station that answers "this is a playlist" and then sends no body held the
// playlist read (and its connection) open for good; outboundFetch only bounds the wait for the headers, and the
// radio service read the playlist with no clock of its own. The read now has the connect time limit and the
// connection is closed when it runs out. Run: node --test test/sec-radio-playlist-stall.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createRadio } = require('../electron/radioService')
const { createFetcher } = require('../electron/outboundFetch')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function silentPlaylistServer() {
  const S = { sockets: [], closed: 0 }
  const server = net.createServer((sock) => {
    S.sockets.push(sock)
    sock.on('error', () => {})
    sock.on('close', () => { S.closed++ })
    sock.once('data', () => {
      // Headers say "playlist, 500 bytes" and then: nothing, ever.
      sock.write('HTTP/1.1 200 OK\r\nContent-Type: audio/x-scpls\r\nContent-Length: 500\r\n\r\n[playlist]\n')
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    S.url = `http://127.0.0.1:${server.address().port}/list.pls`
    S.close = () => new Promise((r) => { for (const s of S.sockets) s.destroy(); server.close(() => r()) })
    resolve(S)
  }))
}

test('O-8: a playlist body that never arrives is cut off at the connect time limit and its connection is closed', async () => {
  const S = await silentPlaylistServer()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-radio-stall-'))
  const data = {}
  const store = { get: (k) => data[k], set: (k, v) => { data[k] = v } }
  const radio = createRadio({
    store, dir, log: () => {}, browser: {},
    timing: { connectMs: 300, backoffMs: [10], maxFailures: 1, idleMs: 300, graceMs: 100 },
    fetcher: createFetcher({ allowPrivateNetwork: true })
  })
  try {
    const started = Date.now()
    await assert.rejects(radio.startSession('alice', { url: S.url, name: 'Silent' }), (e) => {
      assert.equal(e.code, 'playlist_failed', 'the failure names the playlist, not the outer 2 s guard')
      return true
    })
    const took = Date.now() - started
    assert.ok(took < 1500, `gave up after ${took} ms (the outer guard alone needs ${300 + 2000} ms)`)
    // The connection to the station is closed, not left dangling.
    const end = Date.now() + 1500
    while (S.closed < 1 && Date.now() < end) await sleep(20)
    assert.equal(S.closed, 1, 'the station connection was closed')
    assert.equal(radio.listSessions('alice').length, 0)
  } finally {
    await radio.close()
    await S.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
