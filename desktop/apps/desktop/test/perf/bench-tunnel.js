#!/usr/bin/env node
'use strict'
// Throughput benchmark for the remote-streaming tunnel: pushes a large file from a local "media
// server" through the REAL host agent (resources/beebo-rtc-host) and its WebRTC data channel to a
// JS stand-in viewer (werift), verifies every byte, and reports MB/s plus the CPU and memory the
// agent and the viewer used. Not a *.test.js file, so the CI runner skips it.
//
//   node test/perf/bench-tunnel.js [--mb 64] [--runs 3] [--json out.json] [--profile dir]
//        [--env BEEBO_CHUNK=16384,BEEBO_MAX_BUFFERED=262144]   agent environment, comma separated
//        [--nm path/to/node_modules]                          a werift install to test (else the bundled one)
//        [--mode single|range|conns] [--conns 3] [--stripe-mb 4]     how the file is fetched (tunnelViewer.js)
//        [--rtt-ms 60] [--loss 0.3] [--mbit 40] [--queue-ms 120]     a bad network in between (netem.js);
//                                                                     --loss is a percent. Default: none, pure loopback
//        [--timeout-s 300] [--no-priority]
//
// Run it under the SAME Node the product's agent runs on, or the numbers mean little: the app
// ships Electron's (Node 20 there), and Node 24's crypto is several times slower for werift's
// per-packet AES-GCM. Windows PowerShell:
//   $env:BEEBO_AGENT_NODE = 'path\to\node_modules\electron\dist\electron.exe'
// makes the agent AND the viewer child use it (this script itself stays on plain node).
//
// Needs the bundled agent's dependencies:  cd resources/beebo-rtc-host && npm ci --workspaces=false
// and the Worker's (worker/) - nothing else. Without --rtt-ms/--loss/--mbit it is loopback only: it
// measures the CPU cost of the tunnel (DTLS, SCTP, framing, copies), NOT the network. Both ends are
// werift and share the machine, so the viewer, which a phone's native WebRTC would not be, can
// limit the result; "host CPU-s/MB" is the number to compare. See docs/TUNNEL-THROUGHPUT.md.
const os = require('node:os')
const path = require('node:path')

const args = process.argv.slice(2)
const argOf = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d }
if (argOf('nm')) process.env.BEEBO_RTC_NODE_MODULES = path.resolve(argOf('nm'))
const H = require('../helpers/rtcHarness')
const { startNetem, lanAddress } = require('./netem')

const MB = Number(argOf('mb', 64))
const RUNS = Number(argOf('runs', 3))
const MODE = argOf('mode', 'single')
const CONNS = Number(argOf('conns', 3))
const STRIPE_MB = Number(argOf('stripe-mb', 4))
const PROFILE = argOf('profile', '')
const NET = { rttMs: Number(argOf('rtt-ms', 0)), loss: Number(argOf('loss', 0)) / 100, mbit: Number(argOf('mbit', 0)), queueMs: Number(argOf('queue-ms', 120)) }
const useNetem = NET.rttMs > 0 || NET.loss > 0 || NET.mbit > 0
const agentEnv = {}
for (const kv of String(argOf('env', '')).split(',').filter(Boolean)) { const i = kv.indexOf('='); agentEnv[kv.slice(0, i)] = kv.slice(i + 1) }

const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d
const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s[Math.floor((s.length - 1) / 2)] }

let currentBase = '', currentTotal = 0
function raisePriority(pid) {
  // A busy machine (a build running beside the benchmark) makes MB/s swing by 2x; raising the
  // agent and viewer above normal priority keeps most of that out of the numbers. Never fails the
  // run: without the right to do it the priority just stays as it was.
  if (args.includes('--no-priority')) return
  try { os.setPriority(pid, os.constants.priority.PRIORITY_ABOVE_NORMAL) } catch { /* not allowed here: leave it */ }
}

// The viewer runs as its own process (default: the same Node as the agent, i.e. Electron's when
// BEEBO_AGENT_NODE is set) so neither end is starved by the other's JS thread.
function startViewerProc() {
  const { fork } = require('node:child_process')
  const node = argOf('viewer-node', process.env.BEEBO_AGENT_NODE || process.execPath)
  const isElectron = /electron/i.test(node)
  const child = fork(path.join(__dirname, 'tunnel-viewer-proc.js'), [], {
    execPath: node, execArgv: [],
    env: { ...process.env, NODE_PATH: H.NM, ...(isElectron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  })
  return new Promise((resolve, reject) => {
    let done
    const result = new Promise((res, rej) => { done = { res, rej } })
    result.catch(() => {})
    child.on('message', (m) => {
      if (m.type === 'ready') {
        raisePriority(child.pid)
        child.send({ type: 'run', base: currentBase, mode: MODE, conns: CONNS, viaForward: useNetem, path: '/big.bin', total: currentTotal, stripeBytes: STRIPE_MB * H.BLOCK })
      } else if (m.type === 'connected') resolve({ child, result })
      else if (m.type === 'result') done.res(m)
      else if (m.type === 'error') { done.rej(new Error(m.message)); reject(new Error(m.message)) }
    })
    child.on('exit', (code) => { if (code) { const e = new Error('viewer exited ' + code); done.rej(e); reject(e) } })
  })
}

async function main() {
  if (!H.NM) { console.error('werift not found: run `npm ci --workspaces=false` in resources/beebo-rtc-host, or pass --nm'); process.exit(2) }
  const guard = setTimeout(() => { console.error('benchmark timed out'); process.exit(3) }, Number(argOf('timeout-s', 300)) * 1000)
  guard.unref()
  const werift = require(path.join(H.NM, 'werift', 'package.json')).version
  const total = MB * H.BLOCK + 12345
  const w = await H.startWorker()
  currentBase = w.base; currentTotal = total
  const media = await H.startBigMedia(total)
  const agent = H.startAgent({
    BEEBO_HOST_URL: w.base, BEEBO_HOST_TOKEN: await w.token(), BEEBO_LOCAL_URL: media.base, BEEBO_AGENT_SECRET: H.AGENT_SECRET,
    ...agentEnv,
  }, { profileDir: PROFILE || '' })
  const result = {
    when: new Date().toISOString(), node: process.version, agentNode: process.env.BEEBO_AGENT_NODE ? 'electron' : process.version, platform: process.platform + ' ' + os.release(),
    cpu: os.cpus()[0].model, cores: os.cpus().length, werift, mode: MODE, conns: MODE === 'conns' ? CONNS : 1,
    network: useNetem ? NET : 'loopback', mb: MB, agentEnv, runs: [],
  }
  let netem = null
  try {
    await H.waitFor(() => /registered as perfhouse\.beebo\.tv/.test(agent.out.text), 30000, 'agent registration')
    raisePriority(agent.child.pid)
    if (useNetem) {
      const lan = await lanAddress()
      if (!lan || lan.startsWith('127.')) throw new Error('no LAN address on this machine: the network model needs one to stand in for the router')
      const [lo, hi] = String(agentEnv.BEEBO_ICE_PORTS || '46980-46989').split('-').map(Number)
      const ports = []
      for (let p = lo; p <= hi; p++) ports.push(p)
      netem = await startNetem({ lan, hostPorts: ports, ...NET })
      agent.child.send({ type: 'portmap', externalIp: '127.0.0.1', localIp: lan, mappings: netem.mappings })
      await H.waitFor(() => /router forwards \d+ UDP port/.test(agent.out.text), 10000, 'the agent to take the port map')
    }
    const { expectedDigest } = require('./tunnelViewer')
    const expected = expectedDigest(total, MODE, STRIPE_MB * H.BLOCK)
    for (let run = 0; run < RUNS; run++) {
      const viewer = await startViewerProc()
      const before = H.procStats(agent.child.pid)
      const lost0 = netem ? netem.stats.lost + netem.stats.tailDropped : 0
      const pk0 = netem ? netem.stats.packetsDown : 0
      viewer.child.send({ type: 'go' })
      const r = await viewer.result
      const after = H.procStats(agent.child.pid)
      const row = {
        seconds: round(r.seconds, 3), mbps: round(total / 1048576 / r.seconds), bytes: r.bytes, byteExact: r.bytes === total && r.sha === expected,
        hello: r.hello || null, largestFrame: r.maxFrame,
        hostCpuSeconds: round(after.cpuSeconds - before.cpuSeconds), hostCpuPercentOfOneCore: round(100 * (after.cpuSeconds - before.cpuSeconds) / r.seconds, 0),
        hostPeakRssMB: round(after.peakRssMB, 0),
        viewerCpuSeconds: round(r.cpuSeconds), viewerRssMB: round(r.rssMB, 0),
      }
      if (netem) { row.packetsDown = netem.stats.packetsDown - pk0; row.packetsDroppedByNetwork = netem.stats.lost + netem.stats.tailDropped - lost0 }
      result.runs.push(row)
      console.log(`run ${run + 1}/${RUNS}: ${row.mbps} MB/s (${row.seconds}s for ${MB} MB) host CPU ${row.hostCpuSeconds}s (${row.hostCpuPercentOfOneCore}% of a core) peak ${row.hostPeakRssMB} MB | viewer CPU ${row.viewerCpuSeconds}s, ${row.viewerRssMB} MB | largest frame ${row.largestFrame} B | ${row.byteExact ? 'byte-exact' : 'MISMATCH'}` +
        (netem ? ` | network dropped ${row.packetsDroppedByNetwork} of ${row.packetsDown} packets` : ''))
      if (!row.byteExact) process.exitCode = 1
      viewer.child.kill()
      await H.sleep(500)
    }
    result.medianMBps = round(median(result.runs.map((x) => x.mbps)))
    result.medianHostCpuPerMB = round(median(result.runs.map((x) => x.hostCpuSeconds)) / MB, 3)
    console.log(`\nwerift ${werift}  mode=${MODE}${MODE === 'conns' ? ' conns=' + CONNS : ''}  network=${useNetem ? JSON.stringify(NET) : 'loopback'}  agentEnv=${JSON.stringify(agentEnv)}`)
    console.log(`median ${result.medianMBps} MB/s over ${RUNS} run(s), ${result.medianHostCpuPerMB} host CPU-seconds per MB`)
    if (argOf('json')) require('node:fs').writeFileSync(argOf('json'), JSON.stringify(result, null, 2))
  } catch (e) {
    console.error(String(e.stack || e))
    console.error(agent.out.text.split('\n').slice(-20).join('\n'))
    process.exitCode = 1
  } finally {
    await agent.stop()
    if (netem) netem.close()
    media.server.close(); w.server.close()
    if (PROFILE) console.log('agent CPU profile written under ' + PROFILE + ' (summarize with test/perf/cpuprof-top.js)')
  }
  setTimeout(() => process.exit(process.exitCode || 0), 200).unref()
}
main()
