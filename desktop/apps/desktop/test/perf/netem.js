'use strict'
// A small UDP "bad network" between the benchmark viewer and the host agent: round-trip delay,
// random loss and a bandwidth cap with a drop-tail queue, on loopback. It stands in for the
// home router's UDP forward (like the one in rtc-host.e2e.test.js): the agent is told, over IPC,
// that each of its fixed UDP ports is reachable at a public address on this machine (a "portmap"),
// advertises that address as a candidate, and a viewer that uses ONLY those candidates therefore
// talks to the host through here.
//
// What it can show: how the tunnel behaves when latency and loss, not CPU, set the speed (a phone
// on a friend's Wi-Fi or on mobile data). What it cannot: real routers, bufferbloat, radio
// scheduling, TURN relays. It is a model; docs/TUNNEL-THROUGHPUT.md says what real testing is left.
const dgram = require('node:dgram')

// One direction of the link: a FIFO of packets released at their departure time.
class Lane {
  constructor(opts, stats) {
    this.opts = opts
    this.stats = stats
    this.queue = []        // { at, fn }
    this.freeAt = 0        // ms: when the (shared) transmitter is next idle
    this.timer = null
  }
  push(size, fn) {
    const { oneWayMs, loss, mbit, queueMs } = this.opts
    if (loss > 0 && Math.random() < loss) { this.stats.lost++; return }
    const now = performance.now()
    let depart = now
    if (mbit > 0) {
      const start = Math.max(now, this.freeAt)
      if (start - now > queueMs) { this.stats.tailDropped++; return }   // the queue is full
      this.freeAt = start + (size * 8) / (mbit * 1000)                  // ms on the wire
      depart = this.freeAt
    }
    const at = depart + oneWayMs
    if (at - now < 0.2) return fn()
    this.queue.push({ at, fn })
    this.arm()
  }
  arm() {
    if (this.timer || !this.queue.length) return
    const wait = Math.max(0, this.queue[0].at - performance.now())
    this.timer = setTimeout(() => {
      this.timer = null
      const now = performance.now()
      while (this.queue.length && this.queue[0].at <= now + 0.5) this.queue.shift().fn()
      this.arm()
    }, wait)
  }
  close() { if (this.timer) clearTimeout(this.timer); this.timer = null; this.queue = [] }
}

// hostPorts: the agent's UDP ports (on `lan`). Returns { mappings, stats, close } where mappings
// is what to hand the agent as a `portmap`: { internal: <host port>, external: <front port> }.
async function startNetem({ lan, hostPorts, rttMs = 0, loss = 0, mbit = 0, queueMs = 120 }) {
  const stats = { lost: 0, tailDropped: 0, packetsUp: 0, packetsDown: 0 }
  const opts = { oneWayMs: rttMs / 2, loss, mbit, queueMs }
  const up = new Lane(opts, stats)      // viewer -> host
  const down = new Lane(opts, stats)    // host -> viewer (one shared bottleneck for every connection)
  const socks = []
  const mappings = []
  for (const hostPort of hostPorts) {
    const front = dgram.createSocket('udp4')
    const back = dgram.createSocket('udp4')
    socks.push(front, back)
    let client = null
    front.on('message', (msg, r) => { client = r; stats.packetsUp++; up.push(msg.length, () => back.send(msg, hostPort, lan)) })
    back.on('message', (msg) => { if (client) { stats.packetsDown++; const c = client; down.push(msg.length, () => front.send(msg, c.port, c.address)) } })
    await new Promise((r) => front.bind(0, '127.0.0.1', r))
    await new Promise((r) => back.bind(0, r))
    mappings.push({ internal: hostPort, external: front.address().port })
  }
  return { mappings, stats, close: () => { up.close(); down.close(); for (const s of socks) { try { s.close() } catch {} } } }
}

// The address the OS would use to reach the internet: the one the agent binds its UDP ports to.
function lanAddress() {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4')
    s.on('error', () => { try { s.close() } catch {} resolve('') })
    try { s.connect(53, '1.1.1.1', () => { const a = s.address().address; s.close(); resolve(a) }) } catch { resolve('') }
  })
}

module.exports = { startNetem, lanAddress }
