'use strict'
// The benchmark's viewer as its own process, so it can run under the same Node as the product's
// host agent (Electron's) and so its CPU and memory are measured on their own. Started by
// bench-tunnel.js; talks to it over IPC. Not meant to be run by hand.
const H = require('../helpers/rtcHarness')
const { runViewerDownload } = require('./tunnelViewer')

process.on('message', async (m) => {
  if (!m || m.type !== 'run') return
  try {
    const n = m.mode === 'conns' ? m.conns : 1
    const viewers = []
    // Connections are made one after the other: each takes one of the agent's fixed UDP ports.
    for (let i = 0; i < n; i++) viewers.push(await H.connectViewer(m.base, { viaForward: !!m.viaForward }))
    process.send({ type: 'connected' })
    // The parent samples the host's CPU right after this signal, then tells us to go.
    await new Promise((resolve) => process.once('message', (g) => g && g.type === 'go' && resolve()))
    const cpu0 = process.cpuUsage()
    const r = await runViewerDownload(viewers, m)
    const cpu = process.cpuUsage(cpu0)
    process.send({
      type: 'result', seconds: r.seconds, bytes: r.bytes, sha: r.sha, hello: r.hello, maxFrame: r.maxFrame,
      cpuSeconds: (cpu.user + cpu.system) / 1e6, rssMB: process.memoryUsage().rss / 1048576,
    })
    for (const v of viewers) { try { v.pc.close() } catch {} }
  } catch (e) {
    process.send({ type: 'error', message: String((e && e.stack) || e) })
  }
})
process.send({ type: 'ready' })
