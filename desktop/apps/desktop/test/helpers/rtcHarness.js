'use strict'
// Shared pieces for driving the bundled host agent (resources/beebo-rtc-host) over loopback:
// the REAL Worker fetch handler on an in-memory D1 (signalling), a local "media server", the
// agent as a forked child, and a werift "viewer" that speaks the tunnel protocol the way the
// browser page and the phone app do. Used by test/perf/bench-tunnel.js.
//
// werift is not committed: it lives in resources/beebo-rtc-host/node_modules (npm ci there) or in
// the folder BEEBO_RTC_NODE_MODULES points at.
const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')
const { fork } = require('node:child_process')
const { pathToFileURL } = require('node:url')

const appRoot = path.resolve(__dirname, '..', '..')
const repoRoot = path.resolve(appRoot, '..', '..', '..')
// BEEBO_AGENT_FILE: benchmark another copy of the agent (e.g. the one from before a change).
const AGENT = process.env.BEEBO_AGENT_FILE ? path.resolve(process.env.BEEBO_AGENT_FILE) : path.join(appRoot, 'resources', 'beebo-rtc-host', 'beebo-rtc-host.js')
const AGENT_WRAPPER = path.join(__dirname, '..', 'perf', 'agent-wrapper.js')
const NM = [process.env.BEEBO_RTC_NODE_MODULES, path.join(appRoot, 'resources', 'beebo-rtc-host', 'node_modules')]
  .filter(Boolean).find((d) => fs.existsSync(path.join(d, 'werift', 'package.json')))

const NAME = 'perfhouse'
const OWNER = 'owner@example.com'
const PASSWORD = 'perf password'
const AGENT_SECRET = crypto.randomBytes(32).toString('hex')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn, ms, what) {
  const until = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > until) throw new Error('timed out waiting for ' + what)
    await sleep(50)
  }
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

let workerKeys = null
async function startWorker() {
  const workerUrl = pathToFileURL(path.join(repoRoot, 'worker', 'worker.js')).href
  const worker = (await import(workerUrl)).default
  const { _test } = await import(workerUrl)
  const { makeD1, fakeRequest } = await import(pathToFileURL(path.join(repoRoot, 'worker', 'test', 'd1-mock.mjs')).href)
  const keys = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  const env = { DB: makeD1(), LICENSE_PUBLIC_KEY: keys.publicKey, LICENSE_PRIVATE_KEY: keys.privateKey }
  await _test.ensureAuthSchema(env)
  await _test.upsertUserPassword(env, OWNER, PASSWORD)
  const now = Math.floor(Date.now() / 1000)
  await env.DB.prepare('INSERT INTO licenses (license_key, email, plan, status, current_period_end, max_devices, revoked, created_at) VALUES (?,?,?,?,?,?,0,?)')
    .bind('KEY-PERF', OWNER, 'beebo-standard', 'active', now + 30 * 86400, 1, now).run()
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const headers = { ...req.headers }
    delete headers.host
    const fr = fakeRequest(`https://${NAME}.beebo.tv${req.url}`, { method: req.method, headers, body: Buffer.concat(chunks).toString('utf8') })
    const out = await worker.fetch(fr, env)
    res.writeHead(out.status, { 'content-type': out.headers.get('content-type') || 'application/json' })
    res.end(Buffer.from(await out.arrayBuffer()))
  })
  const port = await listen(server)
  workerKeys = keys
  const token = () => _test.signToken({ type: 'subscription', email: OWNER, deviceId: 'dev-perf', expiresAt: now + 86400 }, keys.privateKey)
  return { server, base: `http://127.0.0.1:${port}`, token, keys, env, _test }
}

// opts.profileDir: run the agent under --cpu-prof (through perf/agent-wrapper.js so it can exit
// cleanly and write the profile). The fixed UDP range is a spare one, never the product's.
function startAgent(env, opts = {}) {
  const out = { text: '' }
  const child = fork(opts.profileDir ? AGENT_WRAPPER : AGENT, [], {
    execPath: process.env.BEEBO_AGENT_NODE || process.execPath,
    execArgv: opts.profileDir ? ['--cpu-prof', '--cpu-prof-dir=' + opts.profileDir] : [],
    env: {
      ...process.env,
      ...(process.env.BEEBO_AGENT_NODE ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      NODE_PATH: NM,
      BEEBO_AGENT_TARGET: AGENT,
      BEEBO_LICENSE_PUBLIC_KEY: (workerKeys && workerKeys.publicKey) || '',
      BEEBO_NAME: NAME, BEEBO_VERBOSE: '1', BEEBO_ICE_PORTS: '46980-46989',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  child.stdout.on('data', (d) => { out.text += d })
  child.stderr.on('data', (d) => { out.text += d })
  const stop = () => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode) return resolve()
    const t = setTimeout(() => { try { child.kill() } catch {} resolve() }, 8000)
    child.once('exit', () => { clearTimeout(t); resolve() })
    if (opts.profileDir) { try { child.send({ type: '__perf_exit' }) } catch { child.kill() } } else child.kill()
  })
  return { child, out, stop }
}

async function post(base, p, body, headers = {}) {
  const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  return { status: r.status, body: await r.json().catch(() => null) }
}

// A phone/browser stand-in: sign in, offer, trickle candidates, open the "http" channel.
// opts.viaForward: behave as a far-away phone that can only use the address the host advertises as
// its router forward (candidate "beebomap"): hide the viewer's own addresses from the host and
// ignore the host's, so every packet goes through whatever sits behind that forward (perf/netem.js).
async function connectViewer(base, opts = {}) {
  const { RTCPeerConnection } = require(path.join(NM, 'werift'))
  const login = await post(base, '/rtc/login', opts.login || { email: OWNER, password: PASSWORD })
  if (login.status !== 200) throw new Error('viewer sign-in failed: ' + login.status)
  // A browser or libwebrtc offers a=max-message-size:262144; werift's own default is 65536.
  // opts.maxMessageSize: what this stand-in advertises (default: like a browser).
  const pc = new RTCPeerConnection(opts.pcConfig || { iceServers: [], maxMessageSize: opts.maxMessageSize === undefined ? 262144 : opts.maxMessageSize })
  const channels = [pc.createDataChannel('http')]
  const stripCandidates = (sdp) => sdp.split(/\r?\n/).filter((l) => !/^a=(candidate|end-of-candidates)/.test(l)).join('\r\n')
  let viewerId = null
  const early = []
  pc.onIceCandidate.subscribe((c) => {
    if (!c || opts.viaForward) return
    const cand = { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex }
    if (viewerId) post(base, '/rtc/candidate', { to: 'host', viewerId, token: login.body.token, candidate: cand }).catch(() => {})
    else early.push(cand)
  })
  await pc.setLocalDescription(await pc.createOffer())
  const offer = await post(base, '/rtc/offer', { token: login.body.token, sdp: opts.viaForward ? stripCandidates(pc.localDescription.sdp) : pc.localDescription.sdp })
  if (offer.status !== 200) throw new Error('offer refused: ' + JSON.stringify(offer.body))
  viewerId = offer.body.viewerId
  for (const cand of early) await post(base, '/rtc/candidate', { to: 'host', viewerId, token: login.body.token, candidate: cand })
  // Candidates the host trickles before its answer are held until the answer is set (a browser
  // refuses them earlier).
  let remoteReady = false
  const pending = []
  const timer = setInterval(async () => {
    try {
      const j = await (await fetch(`${base}/rtc/poll?box=${viewerId}`)).json()
      for (const m of j.msgs || []) {
        if (m.type === 'answer') {
          await pc.setRemoteDescription({ type: 'answer', sdp: opts.viaForward ? stripCandidates(m.sdp) : m.sdp })
          remoteReady = true
          for (const c of pending.splice(0)) await pc.addIceCandidate(c).catch(() => {})
        } else if (m.type === 'candidate' && m.candidate) {
          if (opts.viaForward && !/^candidate:beebomap\d+ /.test(m.candidate.candidate)) continue
          if (remoteReady) await pc.addIceCandidate(m.candidate).catch(() => {})
          else pending.push(m.candidate)
        }
      }
    } catch { /* next tick */ }
  }, 100)
  try {
    await waitFor(() => channels.every((c) => c.readyState === 'open'), 30000, 'data channels open')
  } finally { clearInterval(timer) }
  return { pc, channels, dc: channels[0], viewerId }
}

// A big file the size of a film, made of numbered 1 MB blocks so a lost, doubled or reordered
// chunk changes the hash, and served with Range (206) like the real /file route without ever
// holding more than a block or two in memory.
const BLOCK = 1024 * 1024
const SEED = crypto.randomBytes(BLOCK)
function block(i) {
  const b = Buffer.from(SEED)
  b.writeBigUInt64BE(BigInt(i), 0)
  return b
}
function rangeParts(start, end) {
  const parts = []
  for (let off = start; off <= end;) {
    const i = Math.floor(off / BLOCK)
    const inBlock = off - i * BLOCK
    const take = Math.min(BLOCK - inBlock, end - off + 1)
    parts.push(block(i).subarray(inBlock, inBlock + take))
    off += take
  }
  return parts
}
function rangeHash(start, end) {
  const h = crypto.createHash('sha256')
  for (const p of rangeParts(start, end)) h.update(p)
  return h.digest('hex')
}
// /big.bin is served as `contentType`; /video.bin, the same bytes, as video/mp4 (what the away-stream
// limit counts as a stream).
async function startBigMedia(sizeBytes, { contentType = 'application/octet-stream' } = {}) {
  const server = http.createServer(async (req, res) => {
    if (req.url !== '/big.bin' && req.url !== '/video.bin') { res.writeHead(404); return res.end() }
    const contentType2 = req.url === '/video.bin' ? 'video/mp4' : contentType
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '')
    let start = 0, end = sizeBytes - 1
    if (m) {
      start = Number(m[1]); if (m[2]) end = Math.min(Number(m[2]), end)
      res.writeHead(206, { 'content-type': contentType2, 'accept-ranges': 'bytes', 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${sizeBytes}` })
    } else {
      res.writeHead(200, { 'content-type': contentType2, 'accept-ranges': 'bytes', 'content-length': sizeBytes })
    }
    let closed = false
    res.on('close', () => { closed = true })
    res.on('error', () => {})
    try {
      for (const part of rangeParts(start, end)) {
        if (closed) return
        if (!res.write(part)) await new Promise((r) => res.once('drain', r))
      }
      res.end()
    } catch { /* client went away */ }
  })
  server.on('clientError', () => {})
  return { server, base: `http://127.0.0.1:${await listen(server)}` }
}

// CPU seconds and peak memory of ANOTHER process (the agent), without adding anything to it.
// Windows: PowerShell Get-Process; elsewhere: /proc or ps.
function procStats(pid) {
  const { spawnSync } = require('node:child_process')
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('powershell', ['-NoProfile', '-Command', `$p=Get-Process -Id ${Number(pid)}; "$($p.TotalProcessorTime.TotalSeconds) $($p.WorkingSet64) $($p.PeakWorkingSet64)"`], { encoding: 'utf8', timeout: 15000 })
      const [cpu, ws, peak] = String(r.stdout).trim().split(/\s+/).map(Number)
      return { cpuSeconds: cpu, rssMB: ws / 1048576, peakRssMB: peak / 1048576 }
    }
    let peak = 0, rss = 0
    try {
      const st = fs.readFileSync(`/proc/${pid}/status`, 'utf8')
      peak = Number((/VmHWM:\s+(\d+)/.exec(st) || [])[1] || 0) / 1024
      rss = Number((/VmRSS:\s+(\d+)/.exec(st) || [])[1] || 0) / 1024
    } catch {}
    const r = spawnSync('ps', ['-o', 'cputime=', '-p', String(pid)], { encoding: 'utf8' })
    const parts = String(r.stdout).trim().split(':').map(Number)
    const cpu = parts.reduce((a, v) => a * 60 + v, 0)
    return { cpuSeconds: cpu, rssMB: rss, peakRssMB: peak || rss }
  } catch { return { cpuSeconds: NaN, rssMB: NaN, peakRssMB: NaN } }
}

module.exports = { appRoot, repoRoot, AGENT, NM, NAME, AGENT_SECRET, sleep, waitFor, startWorker, startAgent, post, connectViewer, startBigMedia, rangeHash, rangeParts, BLOCK, procStats }
