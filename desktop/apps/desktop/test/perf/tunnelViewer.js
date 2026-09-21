'use strict'
// The benchmark's viewer half: speaks the tunnel protocol over the data channel(s) that
// helpers/rtcHarness.connectViewer opened, and downloads one file in the mode asked for.
//   single  one GET on one connection (what the browser page and the phone do today)
//   range   the file cut into segments fetched one after the other with Range, one connection
//           (what a downloader that resumes or pipelines in steps does)
//   conns   the same segments spread over N SEPARATE connections (N peer connections, each with
//           its own DTLS and SCTP association and so its own congestion window), several
//           segments in flight at once. The host needs no change for this: each connection is
//           just another viewer. Only two requests for the same file on ONE connection would
//           make the host stop the first (it reads that as a seek).
const crypto = require('node:crypto')
const H = require('../helpers/rtcHarness')

// One tunnel request on one channel; resolves with {head, bytes, sha} once the host says "end".
function makeClient(channels) {
  const waiting = new Map()
  let nextId = 1
  let helloInfo = null
  const frames = { count: 0, max: 0 }
  const onMessage = (data) => {
    if (typeof data === 'string') {
      const m = JSON.parse(data)
      if (m.kind === 'hello') { helloInfo = m; return }
      const w = waiting.get(m.id)
      if (!w) return
      if (m.kind === 'head') w.head = m
      else if (m.kind === 'end') { waiting.delete(m.id); w.resolve({ head: w.head, bytes: w.bytes, sha: w.hash.digest('hex') }) }
      else if (m.kind === 'err') { waiting.delete(m.id); w.reject(new Error('err ' + m.status)) }
    } else {
      const idLen = data.readUInt16BE(0)
      const w = waiting.get(data.subarray(2, 2 + idLen).toString('utf8'))
      if (!w) return
      const payload = data.subarray(2 + idLen)
      w.hash.update(payload)
      w.bytes += payload.length
      frames.count++
      if (payload.length > frames.max) frames.max = payload.length
    }
  }
  for (const ch of channels) ch.onMessage.subscribe(onMessage)
  return {
    frames,
    // stripeOf: the viewerId of the primary connection, when this is an extra connection of it.
    hello: (stripeOf, timeoutMs = 3000) => new Promise((resolve) => {
      const t0 = Date.now()
      channels[0].send(JSON.stringify({ kind: 'hello', proto: 2, stripeOf }))
      const tick = setInterval(() => {
        if (helloInfo || Date.now() - t0 > timeoutMs) { clearInterval(tick); resolve(helloInfo) }
      }, 10)
    }),
    get: (channel, p, range) => new Promise((resolve, reject) => {
      const id = String(nextId++)
      waiting.set(id, { bytes: 0, hash: crypto.createHash('sha256'), resolve, reject })
      channel.send(JSON.stringify({ kind: 'req', id, method: 'GET', path: p, range: range || null }))
    }),
  }
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex')

// What the viewer should have hashed, from the file's definition: a single hash of the whole
// file for `single`, else a hash of the per-segment hashes in order.
function expectedDigest(total, mode, stripeBytes) {
  if (mode === 'single') return H.rangeHash(0, total - 1)
  const parts = []
  for (let off = 0; off < total; off += stripeBytes) parts.push(H.rangeHash(off, Math.min(off + stripeBytes, total) - 1))
  return sha256(parts.join(''))
}

// viewers: what connectViewer returned, one per connection.
async function runViewerDownload(viewers, { path, total, mode, stripeBytes }) {
  const clients = viewers.map((v) => makeClient(v.channels))
  const hello = await clients[0].hello()
  for (let i = 1; i < clients.length; i++) {
    const h = await clients[i].hello(viewers[0].viewerId)
    if (mode === 'conns' && !(h && h.stripeOf)) throw new Error('the host would not add connection ' + (i + 1) + ' to the download: ' + JSON.stringify(h && h.stripeError))
  }
  const t0 = process.hrtime.bigint()
  let bytes = 0, sha = ''
  if (mode === 'single') {
    const r = await clients[0].get(viewers[0].channels[0], path, null)
    bytes = r.bytes; sha = r.sha
  } else {
    const segs = []
    for (let off = 0; off < total; off += stripeBytes) segs.push([off, Math.min(off + stripeBytes, total) - 1])
    const hashes = new Array(segs.length)
    let next = 0
    // One worker per connection: it takes the next unfetched segment whenever it is free.
    const worker = async (i) => {
      for (;;) {
        const s = next++
        if (s >= segs.length) return
        const [a, b] = segs[s]
        const r = await clients[i].get(viewers[i].channels[0], path, `bytes=${a}-${b}`)
        if (r.bytes !== b - a + 1) throw new Error('short segment ' + s)
        hashes[s] = r.sha; bytes += r.bytes
      }
    }
    const use = mode === 'conns' ? viewers.length : 1
    await Promise.all(Array.from({ length: use }, (_, i) => worker(i)))
    sha = sha256(hashes.join(''))
  }
  const seconds = Number(process.hrtime.bigint() - t0) / 1e9
  return { bytes, sha, seconds, hello, maxFrame: Math.max(...clients.map((c) => c.frames.max)) }
}

module.exports = { runViewerDownload, expectedDigest, makeClient }
