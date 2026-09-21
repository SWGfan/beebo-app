'use strict'
// A stand-in HDHomeRun for tests: a tiny local HTTP server that answers the documented endpoints
// (/discover.json, /lineup.json, /lineup_status.json, POST /lineup.post) and streams MPEG-TS at
// /auto/v<channel>. With ffmpeg the stream is a real (synthetic) MPEG-2 + AC-3 transport stream made
// by lavfi; without it, a plain stream of TS null packets, which is enough for slot/plumbing tests.
// Like the real thing it refuses (503) when every tuner is busy.
const http = require('node:http')
const dgram = require('node:dgram')
const { spawn, spawnSync } = require('node:child_process')
const path = require('node:path')
const { createRequire } = require('node:module')

const appRoot = path.resolve(__dirname, '..', '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))

function findFfmpeg() {
  const convert = localRequire('./electron/convert')
  const fromApp = convert.ffmpegPath()
  if (fromApp) return fromApp
  const r = spawnSync('ffmpeg', ['-version'], { windowsHide: true })
  return r.status === 0 ? 'ffmpeg' : null
}

const NULL_PACKET = (() => { const b = Buffer.alloc(188, 0xff); b[0] = 0x47; b[1] = 0x1f; b[2] = 0xff; b[3] = 0x10; return b })()

const DEFAULT_LINEUP = [
  { GuideNumber: '2.1', GuideName: 'KTST', HD: 1 },
  { GuideNumber: '4.1', GuideName: 'WNEWS', HD: 1 },
  { GuideNumber: '7.1', GuideName: 'PAID', HD: 0, DRM: 1 },
  { GuideNumber: '9.1', GuideName: 'KIDS', HD: 0 }
]

async function createFakeHdhr({ tunerCount = 2, lineup = DEFAULT_LINEUP, deviceId = '1A2B3C4D', real = true, discover } = {}) {
  const ffmpeg = real ? findFfmpeg() : null
  const active = new Set()
  const stats = { started: 0, refused: 0, requests: [] }
  const procs = new Set()
  const timers = new Set()
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    stats.requests.push(req.method + ' ' + url.pathname)
    const json = (obj, status = 200) => { const s = JSON.stringify(obj); res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) }); res.end(s) }
    if (url.pathname === '/discover.json') return json(discover || { FriendlyName: 'HDHomeRun TEST', ModelNumber: 'HDHR5-2US', FirmwareName: 'hdhomerun5_atsc', FirmwareVersion: '20240101', DeviceID: deviceId, TunerCount: tunerCount, BaseURL: 'http://evil.example:80', LineupURL: 'http://evil.example/lineup.json' })
    if (url.pathname === '/lineup.json') return json(lineup.map((c) => ({ ...c, URL: 'http://evil.example/auto/v' + c.GuideNumber })))
    if (url.pathname === '/lineup_status.json') return json({ ScanInProgress: 0, ScanPossible: 1, Source: 'Antenna', SourceList: ['Antenna', 'Cable'] })
    if (url.pathname === '/lineup.post') { res.writeHead(200); res.end(); stats.scanRequested = url.search; return undefined }
    const m = /^\/auto\/v(.+)$/.exec(url.pathname)
    if (m) {
      const ch = lineup.find((c) => c.GuideNumber === decodeURIComponent(m[1]))
      if (!ch) { res.writeHead(404); res.end('no such channel'); return undefined }
      if (active.size >= tunerCount) { stats.refused++; res.writeHead(503, { 'X-HDHomeRun-Error': '805 - All tuners in use' }); res.end('All tuners in use'); return undefined }
      const token = {}
      active.add(token)
      stats.started++
      res.writeHead(200, { 'Content-Type': 'video/mpeg' })
      const done = () => { active.delete(token); for (const p of procs) if (p.token === token) { try { p.kill('SIGKILL') } catch { /* gone */ } procs.delete(p) } }
      res.on('close', done)
      if (ffmpeg) {
        const p = spawn(ffmpeg, ['-hide_banner', '-v', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30000/1001', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
          // setfield (LGPL, in every build) marks the frames top-field-first; `interlace` is GPL and is missing from the bundled
          // ffmpeg, which made this fake tuner emit nothing at all ("tuner ended" with 0 pieces) on a machine using it.
          '-vf', 'setfield=tff', '-c:v', 'mpeg2video', '-b:v', '2M', '-flags', '+ilme+ildct', '-g', '15', '-c:a', 'ac3', '-b:a', '192k', '-ac', '2', '-f', 'mpegts', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
        p.token = token
        procs.add(p)
        p.stdout.pipe(res)
        p.on('exit', () => { procs.delete(p) })
      } else {
        const t = setInterval(() => { res.write(Buffer.concat(Array(60).fill(NULL_PACKET))) }, 50)
        timers.add(t)
        res.on('close', () => { clearInterval(t); timers.delete(t) })
      }
      return undefined
    }
    res.writeHead(404)
    res.end()
    return undefined
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    ip: '127.0.0.1', port: server.address().port, deviceId, tunerCount, real: !!ffmpeg, ffmpeg, stats,
    activeStreams: () => active.size,
    device: () => ({ id: deviceId, ip: '127.0.0.1', apiPort: server.address().port, streamPort: server.address().port, name: 'HDHomeRun TEST', model: 'HDHR5-2US', tunerCount, allowNonLan: true, addedAt: 0, lastSeenAt: 0 }),
    close: () => new Promise((resolve) => {
      for (const p of procs) { try { p.kill('SIGKILL') } catch { /* gone */ } }
      for (const t of timers) clearInterval(t)
      server.closeAllConnections()
      server.close(() => resolve())
    })
  }
}

/** A UDP responder that answers the HDHomeRun discover packet like a real tuner (loopback, test port). */
async function createFakeDiscoveryResponder({ reply, port = 0 } = {}) {
  const sock = dgram.createSocket('udp4')
  const seen = []
  sock.on('message', (msg, rinfo) => { seen.push(msg); if (reply) sock.send(typeof reply === 'function' ? reply(msg) : reply, rinfo.port, rinfo.address) })
  await new Promise((resolve) => sock.bind(port, '127.0.0.1', resolve))
  return { port: sock.address().port, seen, close: () => new Promise((resolve) => sock.close(resolve)) }
}

module.exports = { createFakeHdhr, createFakeDiscoveryResponder, findFfmpeg, NULL_PACKET, DEFAULT_LINEUP }
