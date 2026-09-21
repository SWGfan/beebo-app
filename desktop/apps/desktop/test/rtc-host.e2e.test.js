// End-to-end: the bundled host agent (resources/beebo-rtc-host) against the REAL
// Worker fetch handler (worker/worker.js on an in-memory D1), a local media
// server, and a werift "viewer" speaking the browser page's exact protocol.
//
// Needs werift, which is not committed. Point BEEBO_RTC_NODE_MODULES at a
// node_modules folder that has it (the build stages one into
// resources/beebo-rtc-host/node_modules, or use D:\MovieAPP\beebo-rtc-host\node_modules).
// Skips cleanly when it can't find one. Run: node --test test/rtc-host.e2e.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')
const { fork } = require('node:child_process')
const { pathToFileURL } = require('node:url')

const appRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(appRoot, '..', '..', '..')
const AGENT = path.join(appRoot, 'resources', 'beebo-rtc-host', 'beebo-rtc-host.js')
const NM = [process.env.BEEBO_RTC_NODE_MODULES, path.join(appRoot, 'resources', 'beebo-rtc-host', 'node_modules')]
  .filter(Boolean).find((d) => fs.existsSync(path.join(d, 'werift', 'package.json')))
const skip = require('./helpers/privateParts').skipIfMissing('worker/worker.js') || (NM ? false : 'werift not found (set BEEBO_RTC_NODE_MODULES)')

const NAME = 'e2ehouse'
const OWNER = 'owner@example.com'
const PASSWORD = 'e2e password'
const MOVIE = crypto.randomBytes(1024 * 1024)
const TEST_MIN = 46990, TEST_MAX = 46999
const TEST_PORTS = `${TEST_MIN}-${TEST_MAX}`
const AGENT_SECRET = crypto.randomBytes(32).toString('hex')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn, ms, what) {
  const until = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > until) throw new Error('timed out waiting for ' + what)
    await sleep(100)
  }
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

// The Worker, served over plain HTTP, pretending every request is for NAME.beebo.tv.
// One instance for the whole file: the Worker module remembers it has created its
// tables, so a second in-memory database would never get them.
let workerOnce = null
let workerKeys = null
function startWorker() {
  if (!workerOnce) workerOnce = startWorkerNow()
  return workerOnce
}
async function startWorkerNow() {
  const worker = (await import(pathToFileURL(path.join(repoRoot, 'worker', 'worker.js')).href)).default
  const { _test } = await import(pathToFileURL(path.join(repoRoot, 'worker', 'worker.js')).href)
  const { makeD1, fakeRequest } = await import(pathToFileURL(path.join(repoRoot, 'worker', 'test', 'd1-mock.mjs')).href)
  const keys = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  const wire = []   // every request the Worker saw, for secret-leak checks
  // ctl.relay: a stand-in for worker/relay.js (Beebo Relay's /rtc/relay/* routes),
  // which isn't in this branch. Unset: the real Worker answers (404).
  const ctl = { relay: null }
  const env = { DB: makeD1(), LICENSE_PUBLIC_KEY: keys.publicKey, LICENSE_PRIVATE_KEY: keys.privateKey }
  await _test.ensureAuthSchema(env)
  await _test.upsertUserPassword(env, OWNER, PASSWORD)
  const now = Math.floor(Date.now() / 1000)
  await env.DB.prepare('INSERT INTO licenses (license_key, email, plan, status, current_period_end, max_devices, revoked, created_at) VALUES (?,?,?,?,?,?,0,?)')
    .bind('KEY-E2E', OWNER, 'beebo-standard', 'active', now + 30 * 86400, 1, now).run()
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const headers = { ...req.headers }
    delete headers.host
    // /n/<name>/... addresses a different <name>.beebo.tv; anything else is NAME.
    const m = /^\/n\/([^/]+)(\/.*)$/.exec(req.url)
    const [host, rest] = m ? [m[1], m[2]] : [NAME, req.url]
    wire.push(JSON.stringify(req.headers) + ' ' + req.url + ' ' + Buffer.concat(chunks).toString('utf8'))
    if (ctl.relay && rest.startsWith('/rtc/relay/')) {
      const out = await ctl.relay(req.method, rest.split('?')[0], req.headers)
      res.writeHead(out.status, { 'content-type': 'application/json' })
      return res.end(JSON.stringify(out.body))
    }
    const fr = fakeRequest(`https://${host}.beebo.tv${rest}`, { method: req.method, headers, body: Buffer.concat(chunks).toString('utf8') })
    const out = await worker.fetch(fr, env)
    res.writeHead(out.status, { 'content-type': out.headers.get('content-type') || 'application/json' })
    res.end(Buffer.from(await out.arrayBuffer()))
  })
  const port = await listen(server)
  workerKeys = keys
  const token = (extra = {}) => _test.signToken({ type: 'subscription', email: OWNER, deviceId: 'dev-e2e', expiresAt: now + 86400, ...extra }, keys.privateKey)
  return { server, base: `http://127.0.0.1:${port}`, token, wire, ctl, keys, env, _test }
}

// The home PC's media server: one file with Range support, plus a header echo.
async function startMedia() {
  const seen = []
  const server = http.createServer(async (req, res) => {
    seen.push({ url: req.url, headers: req.headers })
    // What arrived, for the protocol-2 test: method, headers that matter, and the body.
    if (req.url.startsWith('/echo')) {
      const chunks = []
      for await (const c of req) chunks.push(c)
      const body = Buffer.concat(chunks)
      const out = {
        method: req.method,
        authorization: req.headers.authorization || null,
        mediaToken: req.headers['x-beebo-media-token'] || null,
        cookie: req.headers.cookie || null,
        ctype: req.headers['content-type'] || null,
        remote: req.headers['x-beebo-remote'] || null,
        viewerIp: req.headers['x-beebo-viewer-ip'] || null,
        via: req.headers['x-beebo-remote-via'] || null,
        member: req.headers['x-beebo-remote-member'] || null,
        blen: body.length,
        sha: crypto.createHash('sha256').update(body).digest('hex'),
      }
      const headers = { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-beebo-media-token-header': '1' }
      if (req.url.includes('set=1')) headers['set-cookie'] = ['sid=abc123; Path=/; HttpOnly', 'theme=dark; Path=/']
      if (req.url.includes('logout=1')) headers['set-cookie'] = ['sid=; Path=/; Max-Age=0']
      res.writeHead(200, headers)
      return res.end(JSON.stringify(out))
    }
    if (req.url !== '/movie.bin') { res.writeHead(404); return res.end() }
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '')
    if (m) {
      const start = Number(m[1]), end = m[2] ? Number(m[2]) : MOVIE.length - 1
      res.writeHead(206, { 'content-type': 'application/octet-stream', 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${MOVIE.length}` })
      return res.end(MOVIE.subarray(start, end + 1))
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': MOVIE.length })
    res.end(MOVIE)
  })
  return { server, seen, base: `http://127.0.0.1:${await listen(server)}` }
}

function startAgent(env) {
  const out = { text: '' }
  const child = fork(AGENT, [], {
    // BEEBO_AGENT_NODE: run the agent under another node, e.g. Electron's own (what the product
    // ships it on), for a benchmark that matches the real thing.
    execPath: process.env.BEEBO_AGENT_NODE || process.execPath,
    execArgv: process.env.BEEBO_AGENT_NODE ? [] : process.execArgv,
    // A spare UDP range for the tests, never the product's default 47820-47829.
    env: { ...process.env, ...(process.env.BEEBO_AGENT_NODE ? { ELECTRON_RUN_AS_NODE: '1' } : {}), NODE_PATH: NM, BEEBO_LICENSE_PUBLIC_KEY: (workerKeys && workerKeys.publicKey) || '', BEEBO_NAME: NAME, BEEBO_VERBOSE: '1', BEEBO_ICE_PORTS: TEST_PORTS, ...env },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  child.stdout.on('data', (d) => { out.text += d })
  child.stderr.on('data', (d) => { out.text += d })
  return { child, out }
}

async function post(base, p, body, headers = {}) {
  const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  return { status: r.status, body: await r.json().catch(() => null) }
}

// The browser viewer, in werift: sign in, offer, trickle, then HTTP over "http".
// opts.hidden: keep the viewer's own candidates from the host (as a far-away
// phone whose addresses the house cannot reach). opts.acceptCandidate(c): which
// of the host's candidates to use. opts.seen: collects every host candidate.
async function connectViewer(base, opts = {}) {
  const { RTCPeerConnection } = require(path.join(NM, 'werift'))
  const login = await post(base, '/rtc/login', opts.login || { email: OWNER, password: PASSWORD })
  assert.equal(login.status, 200, 'viewer sign-in')
  for (const s of login.body.iceServers) assert.match(String(s.urls), /^stun:/)
  const pc = new RTCPeerConnection(opts.pcConfig || { iceServers: [] })
  const dc = pc.createDataChannel('http')
  let viewerId = null
  const early = []
  pc.onIceCandidate.subscribe((c) => {
    if (!c || opts.hidden) return
    const cand = { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex }
    if (viewerId) post(base, '/rtc/candidate', { to: 'host', viewerId, token: login.body.token, candidate: cand }).catch(() => {})
    else early.push(cand)
  })
  await pc.setLocalDescription(await pc.createOffer())
  let sdp = pc.localDescription.sdp
  if (opts.hidden) sdp = sdp.split(/\r?\n/).filter((l) => !/^a=(candidate|end-of-candidates)/.test(l)).join('\r\n')
  const offer = await post(base, '/rtc/offer', { token: login.body.token, sdp }, opts.offerHeaders || {})
  assert.equal(offer.status, 200, 'offer accepted: ' + JSON.stringify(offer.body))
  viewerId = offer.body.viewerId
  for (const cand of early) await post(base, '/rtc/candidate', { to: 'host', viewerId, token: login.body.token, candidate: cand })
  let open = false
  dc.stateChanged.subscribe((s) => { if (s === 'open') open = true })
  const timer = setInterval(async () => {
    try {
      const r = await fetch(`${base}/rtc/poll?box=${viewerId}`)
      const j = await r.json()
      for (const m of j.msgs || []) {
        if (m.type === 'answer') {
          if (opts.onAnswer) opts.onAnswer(m)
          let a = m.sdp
          if (opts.acceptCandidate) a = a.split(/\r?\n/).filter((l) => !/^a=candidate/.test(l)).join('\r\n')
          await pc.setRemoteDescription({ type: 'answer', sdp: a })
        } else if (m.type === 'candidate' && m.candidate) {
          if (opts.seen) opts.seen.push(m.candidate)
          if (opts.acceptCandidate && !opts.acceptCandidate(m.candidate)) continue
          await pc.addIceCandidate(m.candidate).catch(() => {})
        }
      }
    } catch { /* next tick */ }
  }, 200)
  try { await waitFor(() => open || dc.readyState === 'open', 30000, 'data channel open') } finally { clearInterval(timer) }

  const waiting = new Map()
  dc.onMessage.subscribe((data) => {
    if (typeof data === 'string') {
      const m = JSON.parse(data)
      const w = waiting.get(m.id)
      if (!w) return
      if (m.kind === 'head') w.head = m
      else if (m.kind === 'end') { waiting.delete(m.id); w.resolve({ head: w.head, body: Buffer.concat(w.parts) }) }
      else if (m.kind === 'err') { waiting.delete(m.id); w.reject(new Error('err ' + m.status)) }
    } else {
      const idLen = data.readUInt16BE(0)
      const id = data.subarray(2, 2 + idLen).toString('utf8')
      const w = waiting.get(id)
      if (!w) return
      if (w.onChunk) w.onChunk(data.subarray(2 + idLen))
      else w.parts.push(Buffer.from(data.subarray(2 + idLen)))
    }
  })
  let nextId = 1
  const request = (p, range) => new Promise((resolve, reject) => {
    const id = String(nextId++)
    waiting.set(id, { parts: [], resolve, reject })
    dc.send(JSON.stringify({ kind: 'req', id, method: 'GET', path: p, range: range || null }))
  })
  const requestStream = (p, { range, headers, onChunk }) => new Promise((resolve, reject) => {
    const id = String(nextId++)
    waiting.set(id, { parts: [], resolve, reject, onChunk })
    dc.send(JSON.stringify({ kind: 'req', id, method: 'GET', path: p, range: range || null, headers }))
  })
  // Protocol 2, as the phone app speaks it (rtc/TunnelProtocol.kt).
  const hello = () => new Promise((resolve, reject) => {
    let done = false
    const t = setTimeout(() => { done = true; reject(new Error('no hello')) }, 5000)
    dc.onMessage.subscribe((data) => {
      if (done || typeof data !== 'string') return
      const m = JSON.parse(data)
      if (m.kind === 'hello') { done = true; clearTimeout(t); resolve(m) }
    })
    dc.send(JSON.stringify({ kind: 'hello', proto: 2 }))
  })
  const request2 = (p, { method = 'GET', headers, body, ctype, cookie, chunk = 0 } = {}) => new Promise((resolve, reject) => {
    const id = String(nextId++)
    waiting.set(id, { parts: [], resolve, reject })
    const msg = { kind: 'req', id, method, path: p, ctype: ctype || undefined, cookie: cookie || undefined, headers }
    if (body && chunk) {
      dc.send(JSON.stringify({ ...msg, bodyChunks: true, blen: body.length }))
      for (let off = 0; off < body.length; off += chunk) {
        const idb = Buffer.from(id)
        const head = Buffer.alloc(2); head.writeUInt16BE(idb.length, 0)
        dc.send(Buffer.concat([head, idb, body.subarray(off, off + chunk)]))
      }
      dc.send(JSON.stringify({ kind: 'bend', id }))
    } else {
      dc.send(JSON.stringify(body ? { ...msg, body: body.toString('base64') } : msg))
    }
  })
  return { pc, request, request2, requestStream, hello }
}

// A big file the size of a film, made of numbered 1 MB blocks so a lost, doubled or reordered
// chunk changes the hash. Served with Range (206) like the real /file route, without ever
// holding more than a block or two in memory.
const BENCH_MB = Math.max(9, Number(process.env.BEEBO_BENCH_MB) || 9)
const BENCH_BLOCK = 1024 * 1024
const BENCH_SEED = crypto.randomBytes(BENCH_BLOCK)
function benchBlock(i, len = BENCH_BLOCK) {
  const b = Buffer.from(BENCH_SEED.subarray(0, len))
  if (len >= 8) b.writeBigUInt64BE(BigInt(i), 0)
  return b
}
function benchRange(start, end) {
  const parts = []
  for (let off = start; off <= end;) {
    const i = Math.floor(off / BENCH_BLOCK)
    const inBlock = off - i * BENCH_BLOCK
    const take = Math.min(BENCH_BLOCK - inBlock, end - off + 1)
    parts.push(benchBlock(i).subarray(inBlock, inBlock + take))
    off += take
  }
  return parts
}
async function startBigMedia(sizeBytes) {
  const server = http.createServer(async (req, res) => {
    if (req.url !== '/big.bin') { res.writeHead(404); return res.end() }
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '')
    let start = 0, end = sizeBytes - 1
    if (m) {
      start = Number(m[1]); if (m[2]) end = Math.min(Number(m[2]), end)
      res.writeHead(206, { 'content-type': 'application/octet-stream', 'accept-ranges': 'bytes', 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${sizeBytes}` })
    } else {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'accept-ranges': 'bytes', 'content-length': sizeBytes })
    }
    let closed = false
    let wrote = 0
    res.on('close', () => { closed = true; if (process.env.BEEBO_BENCH_DEBUG) console.log('MEDIA close', { finished: res.writableFinished, wrote, of: end - start + 1 }) })
    res.on('error', (e) => { if (process.env.BEEBO_BENCH_DEBUG) console.log('MEDIA res error', e && e.message) })
    try {
      for (const part of benchRange(start, end)) {
        if (closed) return
        wrote += part.length
        if (!res.write(part)) await new Promise((r) => res.once('drain', r))
      }
      res.end()
    } catch (e) {
      if (process.env.BEEBO_BENCH_DEBUG) console.log('MEDIA handler error', e && e.stack)
    }
  })
  server.on('clientError', (e) => { if (process.env.BEEBO_BENCH_DEBUG) console.log('MEDIA clientError', e && e.message) })
  return { server, base: `http://127.0.0.1:${await listen(server)}` }
}
function benchHash(start, end) {
  const h = crypto.createHash('sha256')
  for (const p of benchRange(start, end)) h.update(p)
  return h.digest('hex')
}

test('host agent streams byte-exact with seeking, over a signed mailbox', { skip, timeout: 90000 }, async () => {
  const w = await startWorker()
  const media = await startMedia()
  const token = await w.token()
  const agent = startAgent({ BEEBO_HOST_URL: w.base, BEEBO_HOST_TOKEN: token, BEEBO_LOCAL_URL: media.base, BEEBO_AGENT_SECRET: AGENT_SECRET })
  let viewer = null
  try {
    await waitFor(() => /registered as e2ehouse\.beebo\.tv/.test(agent.out.text), 20000, 'agent registration')
    // Once the agent has polled with its token, an anonymous read of the host mailbox is refused.
    await waitFor(async () => (await fetch(`${w.base}/rtc/poll?box=host`)).status === 401, 20000, 'mailbox to lock to the signed host')

    viewer = await connectViewer(w.base, { offerHeaders: { 'cf-connecting-ip': '198.51.100.23' } })
    const full = await viewer.request('/movie.bin')
    assert.equal(full.head.status, 200)
    assert.equal(full.body.length, MOVIE.length)
    assert.ok(full.body.equals(MOVIE), 'full body is byte-exact')

    const part = await viewer.request('/movie.bin', 'bytes=100-199')
    assert.equal(part.head.status, 206)
    assert.equal(part.head.crange, `bytes 100-199/${MOVIE.length}`)
    assert.ok(part.body.equals(MOVIE.subarray(100, 200)), 'range body is byte-exact')

    const hit = media.seen.find((s) => s.url === '/movie.bin')
    assert.equal(hit.headers['x-beebo-remote'], '1', 'bridged requests are marked as away-from-home')
    // The viewer's real address, vouched for with the secret the app gave the agent.
    assert.equal(hit.headers['x-beebo-viewer-ip'], '198.51.100.23')
    assert.equal(hit.headers['x-beebo-agent-key'], AGENT_SECRET)
    // Nothing in the agent's output gives the secret away.
    assert.ok(!agent.out.text.includes(AGENT_SECRET), 'secret not logged')
  } finally {
    try { viewer && viewer.pc.close() } catch {}
    agent.child.kill()
    media.server.close()
  }
})

test('protocol 2 (the phone app): hello, headers, inline and chunked request bodies, cookies across a reconnect', { skip, timeout: 90000 }, async () => {
  const w = await startWorker()
  const media = await startMedia()
  const agent = startAgent({ BEEBO_HOST_URL: w.base, BEEBO_HOST_TOKEN: await w.token(), BEEBO_LOCAL_URL: media.base, BEEBO_AGENT_SECRET: AGENT_SECRET, BEEBO_MAX_BODY: String(512 * 1024) })
  let viewer = null
  try {
    await waitFor(() => /registered as e2ehouse\.beebo\.tv/.test(agent.out.text), 20000, 'agent registration')
    viewer = await connectViewer(w.base)
    const hi = await viewer.hello()
    assert.equal(hi.proto, 2)
    for (const f of ['headers', 'body-chunks', 'set-cookies', 'resp-headers']) assert.ok(hi.features.includes(f), 'feature ' + f)
    assert.equal(hi.maxBody, 512 * 1024)

    // Headers pass through; the ones the agent vouches for can't be forged.
    const echo = async (r) => ({ head: r.head, j: JSON.parse(r.body.toString('utf8')) })
    let r = await echo(await viewer.request2('/echo', { headers: {
      Authorization: 'Bearer phone-token', 'X-Beebo-Media-Token': 'mt-1',
      'X-Beebo-Remote': '0', 'X-Beebo-Viewer-Ip': '6.6.6.6', 'X-Beebo-Agent-Key': 'forged', Host: 'evil', 'Bad Name': 'x', 'X-Split': 'a\r\nInjected: 1',
    } }))
    assert.equal(r.j.authorization, 'Bearer phone-token')
    assert.equal(r.j.mediaToken, 'mt-1')
    assert.equal(r.j.remote, '1')
    assert.notEqual(r.j.viewerIp, '6.6.6.6')
    const lastEcho = media.seen.filter((s) => s.url === '/echo').pop()
    assert.equal(lastEcho.headers['x-beebo-agent-key'], AGENT_SECRET, 'the real key, not the forged one')
    assert.equal(lastEcho.headers['x-split'], undefined, 'a header with a line break is dropped')
    assert.equal(lastEcho.headers.injected, undefined)
    // The fuller head: allowlisted response headers.
    assert.equal(r.head.headers['cache-control'], 'no-store')
    assert.equal(r.head.headers['x-beebo-media-token-header'], '1')

    // A small JSON body inline (sign-in, progress reports, admin actions).
    const small = Buffer.from(JSON.stringify({ username: 'nick', password: 'p' }))
    r = await echo(await viewer.request2('/echo', { method: 'POST', body: small, ctype: 'application/json; charset=utf-8' }))
    assert.equal(r.j.method, 'POST')
    assert.equal(r.j.ctype, 'application/json; charset=utf-8')
    assert.equal(r.j.blen, small.length)
    assert.equal(r.j.sha, crypto.createHash('sha256').update(small).digest('hex'))

    // A form post, inline.
    const form = Buffer.from('tab=users&confirmed=1')
    r = await echo(await viewer.request2('/echo', { method: 'POST', body: form, ctype: 'application/x-www-form-urlencoded' }))
    assert.equal(r.j.sha, crypto.createHash('sha256').update(form).digest('hex'))

    // A big body in 16 KB binary frames, byte-exact.
    const big = crypto.randomBytes(300 * 1024 + 7)
    r = await echo(await viewer.request2('/echo', { method: 'PUT', body: big, ctype: 'application/octet-stream', chunk: 16384 }))
    assert.equal(r.j.method, 'PUT')
    assert.equal(r.j.blen, big.length)
    assert.equal(r.j.sha, crypto.createHash('sha256').update(big).digest('hex'))

    // Over the cap: refused with 413 before the local server sees it.
    const seenBefore = media.seen.length
    await assert.rejects(viewer.request2('/echo', { method: 'POST', body: crypto.randomBytes(600 * 1024), chunk: 16384 }), /err 413/)
    await assert.rejects(viewer.request2('/echo', { method: 'POST', body: crypto.randomBytes(513 * 1024) }), /err 413/)
    assert.equal(media.seen.length, seenBefore, 'refused bodies never reach the server')

    // Cookies: every Set-Cookie comes back, and the connection's jar replays them.
    r = await echo(await viewer.request2('/echo?set=1'))
    assert.deepEqual(r.head.setcookies, ['sid=abc123; Path=/; HttpOnly', 'theme=dark; Path=/'])
    r = await echo(await viewer.request2('/echo'))
    assert.match(r.j.cookie, /sid=abc123/)
    assert.match(r.j.cookie, /theme=dark/)

    // A reconnect is a new connection with an empty jar here; the client's own cookie carries the session.
    viewer.pc.close()
    viewer = await connectViewer(w.base)
    await viewer.hello()
    r = await echo(await viewer.request2('/echo'))
    assert.equal(r.j.cookie, null, 'a new connection starts with an empty jar')
    r = await echo(await viewer.request2('/echo', { cookie: 'sid=abc123; theme=dark' }))
    assert.equal(r.j.cookie, 'sid=abc123; theme=dark')
    // Merged by name, this connection's jar winning, never doubled.
    await viewer.request2('/echo?set=1')
    r = await echo(await viewer.request2('/echo', { cookie: 'sid=stale; other=1' }))
    assert.equal(r.j.cookie, 'sid=abc123; other=1; theme=dark')
    await viewer.request2('/echo?logout=1')
    r = await echo(await viewer.request2('/echo'))
    assert.equal(r.j.cookie, 'theme=dark', 'Max-Age=0 removes it from the jar')

    // The browser page's plain protocol still works on the same channel.
    const part = await viewer.request('/movie.bin', 'bytes=10-19')
    assert.equal(part.head.status, 206)
    assert.ok(part.body.equals(MOVIE.subarray(10, 20)))
  } finally {
    try { viewer && viewer.pc.close() } catch {}
    agent.child.kill()
    media.server.close()
  }
})

test('one sign-in: the agent checks the signed viewer token and tells the server who it is, and nothing forged', { skip, timeout: 90000 }, async () => {
  const w = await startWorker()
  const media = await startMedia()
  const hostTok = await w.token()
  const agent = startAgent({ BEEBO_HOST_URL: w.base, BEEBO_HOST_TOKEN: hostTok, BEEBO_LOCAL_URL: media.base, BEEBO_AGENT_SECRET: AGENT_SECRET })
  let viewer = null
  try {
    await waitFor(() => /registered as e2ehouse\.beebo\.tv/.test(agent.out.text), 20000, 'agent registration')
    // The home computer lists a member with their own home-server password.
    const gen = await w._test.derivePasswordHash('generated-pass-1')
    const own = await w._test.derivePasswordHash('robins own password')
    const pushed = await post(w.base, '/remote/members', { token: hostTok, members: [{ username: 'robin', pw_hash: gen.hash, pw_salt: gen.salt, pw_iter: gen.iterations, login_hash: own.hash, login_salt: own.salt, login_iter: own.iterations }] })
    assert.equal(pushed.status, 200)

    viewer = await connectViewer(w.base, { login: { username: 'robin', pass: 'robins own password' } })
    await viewer.hello()
    const r = JSON.parse((await viewer.request2('/echo', { headers: { 'X-Beebo-Remote-Via': 'owner', 'X-Beebo-Remote-Member': 'mallory' } })).body.toString('utf8'))
    assert.equal(r.via, 'member')
    assert.equal(r.member, 'robin', 'the verified member, not the forged header')
    viewer.pc.close(); viewer = null

    // The owner's own sign-in.
    viewer = await connectViewer(w.base)
    const o = JSON.parse((await viewer.request2('/echo', { headers: { 'X-Beebo-Remote-Member': 'robin' } })).body.toString('utf8'))
    assert.equal(o.via, 'owner')
    assert.equal(o.member, null)
  } finally {
    try { viewer && viewer.pc.close() } catch {}
    agent.child.kill()
    media.server.close()
  }
})

test('verifyViewerToken: good, bad signature, expired, another house, not a viewer', { skip }, async () => {
  const w = await startWorker()
  process.env.NODE_PATH = NM
  require('node:module').Module._initPaths()
  // A token in the environment, so loading the agent never goes looking for the installed app's.
  process.env.BEEBO_HOST_TOKEN = process.env.BEEBO_HOST_TOKEN || 'unit-test-token'
  const { verifyViewerToken } = require(AGENT)
  const now = Math.floor(Date.now() / 1000)
  const sign = (p) => w._test.signToken(p, w.keys.privateKey)
  const opts = { publicKey: w.keys.publicKey, name: NAME, nowS: now }
  assert.deepEqual(verifyViewerToken(await sign({ typ: 'viewer', name: NAME, via: 'member', member: 'Robin', exp: now + 60 }), opts), { via: 'member', member: 'robin' })
  assert.deepEqual(verifyViewerToken(await sign({ typ: 'viewer', name: NAME, exp: now + 60 }), opts), { via: 'owner' })
  assert.deepEqual(verifyViewerToken(await sign({ typ: 'viewer', name: NAME, via: 'household', exp: now + 60 }), opts), { via: 'household' })
  const good = await sign({ typ: 'viewer', name: NAME, via: 'member', member: 'robin', exp: now + 60 })
  // Another key signed it.
  const other = crypto.generateKeyPairSync('ed25519', { privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
  assert.equal(verifyViewerToken(await w._test.signToken({ typ: 'viewer', name: NAME, via: 'member', member: 'robin', exp: now + 60 }, other.privateKey), opts), null)
  // Payload changed after signing.
  const [, sig] = good.split('.')
  const forged = Buffer.from(JSON.stringify({ v: 1, typ: 'viewer', name: NAME, via: 'member', member: 'mallory', exp: now + 60 })).toString('base64url') + '.' + sig
  assert.equal(verifyViewerToken(forged, opts), null)
  assert.equal(verifyViewerToken(await sign({ typ: 'viewer', name: NAME, via: 'member', member: 'robin', exp: now - 1 }), opts), null, 'expired')
  assert.equal(verifyViewerToken(await sign({ typ: 'viewer', name: 'otherhouse', via: 'member', member: 'robin', exp: now + 60 }), opts), null, 'another house')
  assert.equal(verifyViewerToken(await sign({ type: 'subscription', name: NAME, exp: now + 60 }), opts), null, 'a licence is not a viewer')
  assert.equal(verifyViewerToken(await sign({ typ: 'viewer', name: NAME, via: 'member', member: 'a b', exp: now + 60 }), opts), null)
  assert.equal(verifyViewerToken('', opts), null)
  assert.equal(verifyViewerToken('garbage.token', opts), null)
})

// The LAN address the agent binds to (the route to the internet), as it finds it.
function lanAddress() {
  const dgram = require('node:dgram')
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4')
    s.on('error', () => { try { s.close() } catch {} resolve('') })
    s.connect(53, '1.1.1.1', () => { const a = s.address().address; s.close(); resolve(a) })
  })
}

// A stand-in for the home router's UDP forward: a public-side socket on
// 127.0.0.1 that relays to <lan>:<port> and back, as a NAT with a forward does.
async function fakeForward(lan, port) {
  const dgram = require('node:dgram')
  const front = dgram.createSocket('udp4')
  const back = dgram.createSocket('udp4')
  const stats = { in: 0, out: 0 }
  let client = null
  front.on('message', (msg, r) => { client = r; stats.in++; back.send(msg, port, lan) })
  back.on('message', (msg) => { if (client) { stats.out++; front.send(msg, client.port, client.address) } })
  await new Promise((r) => front.bind(0, '127.0.0.1', r))
  await new Promise((r) => back.bind(0, r))
  return { port: front.address().port, stats, close: () => { try { front.close() } catch {} try { back.close() } catch {} } }
}

test('the agent answers on its fixed UDP range and advertises the router forward, which works on its own', { skip, timeout: 90000 }, async (t) => {
  const lan = await lanAddress()
  if (!lan || lan.startsWith('127.')) return t.skip('no LAN address on this machine')
  const w = await startWorker()
  const media = await startMedia()
  const agent = startAgent({ BEEBO_HOST_URL: w.base, BEEBO_HOST_TOKEN: await w.token(), BEEBO_LOCAL_URL: media.base })
  const forwards = []
  let viewer = null
  try {
    await waitFor(() => /registered as e2ehouse\.beebo\.tv/.test(agent.out.text), 20000, 'agent registration')
    assert.match(agent.out.text, new RegExp(`udp= ${TEST_MIN}-${TEST_MAX}`))
    // The supervisor's message after the router mapped the range. The "public"
    // address is our fake forward on 127.0.0.1.
    const mappings = []
    for (let p = TEST_MIN; p <= TEST_MAX; p++) {
      const f = await fakeForward(lan, p)
      forwards.push(f)
      mappings.push({ internal: p, external: f.port })
    }
    agent.child.send({ type: 'portmap', externalIp: '127.0.0.1', localIp: lan, mappings })
    await waitFor(() => /router forwards 10 UDP port\(s\)/.test(agent.out.text), 10000, 'the agent to take the mapping')

    // The viewer hides its own addresses and uses ONLY the advertised forward,
    // so the data channel can only open through it.
    const seen = []
    viewer = await connectViewer(w.base, { hidden: true, seen, acceptCandidate: (c) => /^candidate:beebomap\d+ /.test(c.candidate) })
    const hostCands = seen.filter((c) => / typ host/.test(c.candidate))
    assert.ok(hostCands.length >= 1, 'host candidates arrived')
    for (const c of hostCands) {
      const port = Number(c.candidate.split(' ')[5])
      assert.ok(port >= TEST_MIN && port <= TEST_MAX, 'host candidate on the fixed range: ' + c.candidate)
    }
    assert.ok(hostCands.some((c) => c.candidate.includes(' ' + lan + ' ')), 'bound to the LAN address')
    const twin = seen.filter((c) => /^candidate:beebomap\d+ /.test(c.candidate))
    assert.equal(twin.length, 1, 'exactly one forward advertised')
    assert.match(twin[0].candidate, / 127\.0\.0\.1 \d+ typ srflx raddr /)
    const used = forwards.find((f) => twin[0].candidate.includes(' ' + f.port + ' typ srflx'))
    assert.ok(used && used.stats.in > 0 && used.stats.out > 0, 'traffic went through the forward both ways')

    const part = await viewer.request('/movie.bin', 'bytes=0-65535')
    assert.equal(part.head.status, 206)
    assert.ok(part.body.equals(MOVIE.subarray(0, 65536)), 'bytes through the forward are exact')
  } finally {
    try { viewer && viewer.pc.close() } catch {}
    agent.child.kill()
    media.server.close()
    for (const f of forwards) f.close()
  }
})

test('own relay: off by default; when set, viewers get derived credentials and the secret never leaves the agent', { skip, timeout: 90000 }, async () => {
  const w = await startWorker()
  const media = await startMedia()
  const agent = startAgent({ BEEBO_HOST_URL: w.base, BEEBO_HOST_TOKEN: await w.token(), BEEBO_LOCAL_URL: media.base })
  const SECRET = 'owner-relay-secret-' + crypto.randomBytes(8).toString('hex')
  let viewer = null
  try {
    await waitFor(() => /registered as e2ehouse\.beebo\.tv/.test(agent.out.text), 20000, 'agent registration')

    // Default: no relay, and the answer says nothing about one.
    let answer = null
    viewer = await connectViewer(w.base, { onAnswer: (m) => { answer = m } })
    assert.ok(answer && answer.sdp)
    assert.equal(answer.iceServers, undefined, 'no relay unless the owner sets one up')
    viewer.pc.close(); viewer = null

    // The owner sets up their own TURN server. Nothing listens at this address,
    // so the house can't actually allocate there; the direct path must still work.
    const wireBefore = w.wire.length
    agent.child.send({ type: 'relay', relay: { kind: 'turn', urls: ['turn:127.0.0.1:9?transport=udp', 'turns:relay.example.com:443?transport=tcp'], secret: SECRET } })
    await waitFor(() => /relay ready: turn, 2 address\(es\)/.test(agent.out.text), 10000, 'relay ready')
    answer = null
    viewer = await connectViewer(w.base, { onAnswer: (m) => { answer = m } })
    assert.ok(answer.iceServers && answer.iceServers.length === 1, 'the answer carries the relay')
    const [relay] = answer.iceServers
    assert.deepEqual(relay.urls, ['turn:127.0.0.1:9?transport=udp', 'turns:relay.example.com:443?transport=tcp'])
    const m = /^(\d+):beebo$/.exec(relay.username)
    assert.ok(m, 'TURN REST username')
    const expiry = Number(m[1]), nowS = Math.floor(Date.now() / 1000)
    assert.ok(expiry > nowS + 11 * 3600 && expiry <= nowS + 12 * 3600 + 5, 'lives 12 hours')
    assert.equal(relay.credential, crypto.createHmac('sha1', SECRET).update(relay.username).digest('base64'))
    const part = await viewer.request('/movie.bin', 'bytes=0-999')
    assert.ok(part.body.equals(MOVIE.subarray(0, 1000)), 'still streams')

    // The secret never reached the Worker or the logs; the derived password never hit the logs.
    assert.ok(!w.wire.slice(wireBefore).some((l) => l.includes(SECRET)), 'secret not sent to the Worker')
    assert.ok(!agent.out.text.includes(SECRET), 'secret not logged')
    assert.ok(!agent.out.text.includes(relay.credential), 'derived credential not logged')

    // A relay that answers the reachability probe but never grants an allocation
    // must not stop viewers connecting either.
    viewer.pc.close(); viewer = null
    const dgram = require('node:dgram')
    const stub = dgram.createSocket('udp4')
    stub.on('message', (buf, r) => {
      if (buf.length >= 20 && buf.readUInt16BE(0) === 0x0001) {   // Binding request -> empty success
        const res = Buffer.from(buf.subarray(0, 20)); res.writeUInt16BE(0x0101, 0); res.writeUInt16BE(0, 2)
        stub.send(res, r.port, r.address)
      }
    })
    await new Promise((r) => stub.bind(0, '127.0.0.1', r))
    try {
      agent.child.send({ type: 'relay', relay: { kind: 'turn', urls: [`turn:127.0.0.1:${stub.address().port}?transport=udp`], secret: SECRET } })
      await waitFor(() => (agent.out.text.match(/relay ready: turn/g) || []).length >= 2, 10000, 'relay ready again')
      viewer = await connectViewer(w.base)
      const again = await viewer.request('/movie.bin', 'bytes=0-99')
      assert.ok(again.body.equals(MOVIE.subarray(0, 100)), 'streams despite a relay that never allocates')
    } finally { stub.close() }

    // Turning it off goes back to no relay.
    viewer.pc.close(); viewer = null
    agent.child.send({ type: 'relay', relay: null })
    await waitFor(() => /relay off/.test(agent.out.text), 10000, 'relay off')
    answer = null
    viewer = await connectViewer(w.base, { onAnswer: (x) => { answer = x } })
    assert.equal(answer.iceServers, undefined)
  } finally {
    try { viewer && viewer.pc.close() } catch {}
    agent.child.kill()
    media.server.close()
  }
})

// A small but real TURN server (RFC 8656 over UDP: long-term credentials with a
// TURN REST shared secret, Allocate, Refresh, CreatePermission, ChannelBind,
// Send/Data indications, ChannelData), so relay candidates, relayed data and the
// house's meter are the genuine article. stats.egress counts every byte it sends
// out (to clients and to peers), which is what a TURN provider bills.
async function startFakeTurn(address, secret) {
  const dgram = require('node:dgram')
  const ice = require(path.join(NM, 'werift', 'lib', 'ice', 'src'))
  const { Message, parseMessage, methods, classes } = ice
  const REALM = 'beebo-test', NONCE = Buffer.from(crypto.randomBytes(8).toString('hex'))
  // Short allocations: clients Refresh every 10 s (so Refresh is exercised), and
  // werift's refresh timer, which outlives pc.close(), ends quickly after the test.
  const LIFETIME_S = 12
  const stats = { egress: 0, packets: 0, allocations: 0, usernames: new Set() }
  const ctl = dgram.createSocket('udp4')
  const allocs = new Map()   // "ip:port" of the client -> allocation
  const keyFor = (username) => crypto.createHash('md5').update(`${username}:${REALM}:${crypto.createHmac('sha1', secret).update(username).digest('base64')}`).digest()
  const out = (sock, buf, port, host) => { stats.egress += buf.length; stats.packets++; sock.send(buf, port, host) }
  const reply = (m, cls, attrs, rinfo, key) => {
    const r = new Message(m.messageMethod, cls, m.transactionId)
    for (const [k, v] of attrs) r.setAttribute(k, v)
    if (key) r.addMessageIntegrity(key)
    r.addFingerprint()
    ctl.send(r.bytes, rinfo.port, rinfo.address)
  }
  ctl.on('message', (data, rinfo) => {
    const a = allocs.get(rinfo.address + ':' + rinfo.port)
    if (data.length >= 4 && data[0] >= 0x40 && data[0] <= 0x7f) {       // ChannelData
      const peer = a && a.channels.get(data.readUInt16BE(0))
      if (peer) out(a.relay, data.subarray(4, 4 + data.readUInt16BE(2)), peer[1], peer[0])
      return
    }
    const m = parseMessage(data)
    if (!m) return
    if (m.messageMethod === methods.BINDING && m.messageClass === classes.REQUEST) {
      return reply(m, classes.RESPONSE, [['XOR-MAPPED-ADDRESS', [rinfo.address, rinfo.port]]], rinfo)
    }
    if (m.messageMethod === methods.SEND && m.messageClass === classes.INDICATION) {
      const peer = m.getAttributeValue('XOR-PEER-ADDRESS'), payload = m.getAttributeValue('DATA')
      if (a && peer && payload && a.perms.has(peer[0])) out(a.relay, payload, peer[1], peer[0])
      return
    }
    if (m.messageClass !== classes.REQUEST) return
    const username = m.getAttributeValue('USERNAME')
    const key = username ? keyFor(username) : null
    const expiry = Number(String(username || '').split(':')[0])
    if (!username || !parseMessage(data, key) || !(expiry > Date.now() / 1000)) {
      return reply(m, classes.ERROR, [['ERROR-CODE', [401, 'Unauthorized']], ['REALM', REALM], ['NONCE', NONCE]], rinfo)
    }
    if (m.messageMethod === methods.ALLOCATE) {
      if (a) return reply(m, classes.RESPONSE, [['XOR-RELAYED-ADDRESS', [address, a.relay.address().port]], ['XOR-MAPPED-ADDRESS', [rinfo.address, rinfo.port]], ['LIFETIME', LIFETIME_S]], rinfo, key)
      const relay = dgram.createSocket('udp4')
      const na = { relay, username, perms: new Set(), channels: new Map(), byPeer: new Map(), client: rinfo }
      relay.on('message', (payload, from) => {
        if (!na.perms.has(from.address)) return
        const ch = na.byPeer.get(from.address + ':' + from.port)
        if (ch) {
          const head = Buffer.alloc(4); head.writeUInt16BE(ch, 0); head.writeUInt16BE(payload.length, 2)
          out(ctl, Buffer.concat([head, payload]), na.client.port, na.client.address)
        } else {
          const ind = new Message(methods.DATA, classes.INDICATION).setAttribute('XOR-PEER-ADDRESS', [from.address, from.port]).setAttribute('DATA', payload)
          out(ctl, ind.bytes, na.client.port, na.client.address)
        }
      })
      relay.bind(0, address, () => {
        allocs.set(rinfo.address + ':' + rinfo.port, na)
        stats.allocations++
        stats.usernames.add(username)
        reply(m, classes.RESPONSE, [['XOR-RELAYED-ADDRESS', [address, relay.address().port]], ['XOR-MAPPED-ADDRESS', [rinfo.address, rinfo.port]], ['LIFETIME', LIFETIME_S]], rinfo, key)
      })
      return
    }
    if (!a || a.username !== username) return reply(m, classes.ERROR, [['ERROR-CODE', [441, 'Wrong Credentials']]], rinfo, key)
    if (m.messageMethod === methods.REFRESH) return reply(m, classes.RESPONSE, [['LIFETIME', LIFETIME_S]], rinfo, key)
    const peer = m.getAttributeValue('XOR-PEER-ADDRESS')
    if (peer) a.perms.add(peer[0])
    if (m.messageMethod === methods.CHANNEL_BIND) {
      const ch = m.getAttributeValue('CHANNEL-NUMBER')
      a.channels.set(ch, peer)
      a.byPeer.set(peer[0] + ':' + peer[1], ch)
    }
    return reply(m, classes.RESPONSE, [], rinfo, key)
  })
  await new Promise((r) => ctl.bind(0, address, r))
  return {
    port: ctl.address().port, stats,
    close: () => { for (const a of allocs.values()) { try { a.relay.close() } catch {} } try { ctl.close() } catch {} },
  }
}

test('Beebo Relay: refused politely, then a viewer relayed through TURN is metered at least as high as the relay counted', { skip, timeout: 120000 }, async (t) => {
  const lan = await lanAddress()
  if (!lan || lan.startsWith('127.')) return t.skip('no LAN address on this machine')
  const w = await startWorker()
  const media = await startMedia()
  const TURN_SECRET = 'beebo-relay-static-auth-' + crypto.randomBytes(6).toString('hex')
  const turn = await startFakeTurn(lan, TURN_SECRET)
  const token = await w.token()
  const CUSTOMER = 'b0123456789abcdef01234567'
  let refuse = 'relay_not_enabled'
  const relayCalls = []
  w.ctl.relay = async (method, p, headers) => {
    relayCalls.push(method + ' ' + p)
    if (headers.authorization !== 'Bearer ' + token) return { status: 401, body: { error: 'unauthorized' } }
    if (p === '/rtc/relay/usage/me') return { status: 200, body: { month: new Date().toISOString().slice(0, 7), bytes: 4242, gb: 0 } }
    if (p !== '/rtc/relay/credentials' || method !== 'POST') return { status: 404, body: { error: 'not_found' } }
    if (refuse) return { status: 403, body: { error: refuse } }
    const now = Math.floor(Date.now() / 1000)
    const expiresAt = Math.ceil((now + 8 * 3600) / 3600) * 3600
    const username = `${expiresAt}:${CUSTOMER}`
    return { status: 200, body: { iceServers: [{ urls: [`turn:${lan}:${turn.port}?transport=udp`], username, credential: crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64') }], expiresAt, ttl: expiresAt - now, mode: 'beebo_only' } }
  }
  const agent = startAgent({ BEEBO_HOST_URL: w.base, BEEBO_HOST_TOKEN: token, BEEBO_LOCAL_URL: media.base, BEEBO_METER_FLUSH_MS: '300', BEEBO_RELAY_RETRY_MS: '0' })
  const msgs = []
  agent.child.on('message', (m) => msgs.push(m))
  let viewer = null
  const beeboBytes = () => msgs.filter((m) => m.type === 'relayUsage').reduce((n, m) => n + (m.deltas.beebo || 0), 0)
  try {
    await waitFor(() => /registered as e2ehouse\.beebo\.tv/.test(agent.out.text), 20000, 'agent registration')
    agent.child.send({ type: 'relayPlan', plan: { order: ['beebo'] } })
    await waitFor(() => /relay plan: beebo/.test(agent.out.text), 10000, 'the plan to reach the agent')

    // Not enabled for this account: the viewer still connects directly, and the app is told why.
    let answer = null
    viewer = await connectViewer(w.base, { onAnswer: (m) => { answer = m } })
    assert.equal(answer.iceServers, undefined, 'no relay offered')
    assert.ok((await viewer.request('/movie.bin', 'bytes=0-99')).body.equals(MOVIE.subarray(0, 100)))
    await waitFor(() => msgs.some((m) => m.type === 'relayStatus' && m.beebo && m.beebo.available === false && m.beebo.error === 'relay_not_enabled'), 5000, 'relay_not_enabled reported')
    viewer.pc.close(); viewer = null

    // Enabled: the answer carries Beebo Relay credentials, as the viewer page expects.
    refuse = ''
    answer = null
    viewer = await connectViewer(w.base, { onAnswer: (m) => { answer = m } })
    assert.ok(answer.iceServers && answer.iceServers.length === 1, 'Beebo Relay offered')
    const [bee] = answer.iceServers
    assert.match(bee.username, new RegExp(`^\\d+:${CUSTOMER}$`))
    await waitFor(() => msgs.some((m) => m.type === 'relayStatus' && m.beebo && m.beebo.available === true), 5000, 'Beebo Relay ready reported')
    await waitFor(() => msgs.some((m) => m.type === 'relayStatus' && m.beeboUsage && m.beeboUsage.bytes === 4242), 5000, "Beebo Relay's own meter passed on")
    viewer.pc.close(); viewer = null
    await sleep(700)
    const before = { bytes: beeboBytes(), egress: turn.stats.egress }

    // The viewer page's second attempt: relay only, with the credentials from the answer.
    viewer = await connectViewer(w.base, { pcConfig: { iceServers: [{ urls: bee.urls[0], username: bee.username, credential: bee.credential }], iceTransportPolicy: 'relay' } })
    const full = await viewer.request('/movie.bin')
    assert.ok(full.body.equals(MOVIE), 'byte-exact through the relay')
    assert.ok(turn.stats.usernames.has(bee.username), 'the relay saw the Beebo credential')
    const relayed = turn.stats.egress - before.egress
    assert.ok(relayed > MOVIE.length, 'the film really went through the relay: ' + relayed)
    await waitFor(() => beeboBytes() - before.bytes >= relayed, 15000, `meter to reach what the relay sent (${relayed})`)
    await sleep(1000)
    const metered = beeboBytes() - before.bytes
    const relayedNow = turn.stats.egress - before.egress
    t.diagnostic(`relay sent ${relayedNow} bytes; house metered ${metered} (x${(metered / relayedNow).toFixed(3)})`)
    assert.ok(metered >= relayedNow, `metered ${metered} >= relayed ${relayedNow}`)
    // Conservative, not wild: under 2.5x even if both ends relayed (counted twice).
    assert.ok(metered <= relayedNow * 2.5, `metered ${metered} not far above relayed ${relayedNow}`)
    assert.ok(msgs.filter((m) => m.type === 'relayUsage').every((m) => !m.deltas.cloudflare && !m.deltas.custom), 'all of it attributed to Beebo')
    assert.ok(!agent.out.text.includes(bee.credential), 'credential not logged')
    assert.ok(relayCalls.every((c) => c.startsWith('POST /rtc/relay/credentials') || c.startsWith('GET /rtc/relay/usage/me')))
  } finally {
    try { viewer && viewer.pc.close() } catch {}
    agent.child.kill()
    media.server.close()
    turn.close()
  }
})

test('a renewed licence token handed over IPC brings a refused host back online', { skip, timeout: 60000 }, async () => {
  const w = await startWorker()
  const media = await startMedia()
  const expired = await w.token({ expiresAt: Math.floor(Date.now() / 1000) - 60 })
  const agent = startAgent({ BEEBO_HOST_URL: w.base, BEEBO_HOST_TOKEN: expired, BEEBO_LOCAL_URL: media.base, BEEBO_REGISTER_MS: '600000' })
  try {
    await waitFor(() => /register failed: 401 unauthorized/.test(agent.out.text), 20000, 'the expired token to be refused')
    agent.child.send({ type: 'token', token: await w.token() })
    await waitFor(() => /registered as e2ehouse\.beebo\.tv/.test(agent.out.text), 20000, 'registration with the renewed token')
  } finally {
    agent.child.kill()
    media.server.close()
  }
})

test('the in-app supervisor reports a refused name, and announces a good registration', { skip, timeout: 60000 }, async () => {
  const w = await startWorker()
  const media = await startMedia()
  const { createRemoteHost } = require(path.join(appRoot, 'electron', 'remoteHostAgent.js'))
  // The supervisor passes the parent's environment through to the agent.
  const saved = { url: process.env.BEEBO_HOST_URL, np: process.env.NODE_PATH }
  process.env.BEEBO_HOST_URL = w.base + '/n/hub'
  process.env.NODE_PATH = NM
  let name = 'hub'
  const token = await w.token()
  const problems = [], registered = [], lines = []
  const host = createRemoteHost({
    app: { isPackaged: false },
    getName: () => name,
    getToken: () => token,
    getLocalPort: () => Number(new URL(media.base).port),
    getIcePorts: () => TEST_PORTS,
    onProblem: (c) => problems.push(c),
    onRegistered: (n) => registered.push(n),
    log: (l) => lines.push(l),
  })
  try {
    host.start()
    await waitFor(() => host.status().problem === 'name_reserved', 20000, 'name_reserved to reach status()')
    assert.deepEqual(problems, ['name_reserved'])
    assert.equal(host.status().online, false)

    // Switching to a claimable name (what Settings or pickFreeRemoteName does).
    process.env.BEEBO_HOST_URL = w.base + '/n/' + NAME
    name = NAME
    host.restart()
    await waitFor(() => host.status().online, 20000, 'online after restart')
    assert.equal(host.status().problem, null)
    assert.deepEqual(registered, [NAME])
    assert.equal(host.refreshToken(), false, 'nothing to hand over while the token is unchanged')
    // The router forward reaches the running agent, and a restarted one gets it again.
    host.setPortMap({ externalIp: '81.2.69.142', localIp: '', mappings: [{ internal: TEST_MIN, external: TEST_MIN }] })
    await waitFor(() => lines.some((l) => /router forwards 1 UDP port\(s\) to this PC at 81\.2\.69\.142/.test(l)), 10000, 'portmap to reach the agent')
    assert.ok(lines.some((l) => new RegExp(`udp= ${TEST_MIN}-${TEST_MAX}`).test(l)), 'the agent got the range from getIcePorts')
    lines.length = 0
    host.restart()
    await waitFor(() => lines.some((l) => /router forwards 1 UDP port/.test(l)), 10000, 'portmap re-sent to a restarted agent')
    // The owner's relay: off by default, reported once the agent has it, secret never in the log.
    assert.deepEqual(host.status().relay, { kind: '', state: 'off', detail: '' })
    host.setRelay({ kind: 'turn', urls: ['turn:relay.example.com:3478'], secret: 'supervisor-secret-123' })
    await waitFor(() => host.status().relay.state === 'ready', 10000, 'relay ready in status()')
    assert.equal(host.status().relay.kind, 'turn')
    host.setRelay(null)
    await waitFor(() => host.status().relay.state === 'off', 10000, 'relay off in status()')
    assert.ok(!lines.some((l) => l.includes('supervisor-secret-123')), 'secret not in the supervisor log')
  } finally {
    host.stop()
    process.env.BEEBO_HOST_URL = saved.url || ''
    if (saved.url === undefined) delete process.env.BEEBO_HOST_URL
    if (saved.np === undefined) delete process.env.NODE_PATH; else process.env.NODE_PATH = saved.np
    media.server.close()
  }
})

test('a film-sized download through the tunnel is byte-exact, resumable, and reports its speed', { skip, timeout: 900000 }, async (t) => {
  const w = await startWorker()
  const total = BENCH_MB * BENCH_BLOCK + 12345
  const media = await startBigMedia(total)
  const agent = startAgent({ BEEBO_HOST_URL: w.base, BEEBO_HOST_TOKEN: await w.token(), BEEBO_LOCAL_URL: media.base, BEEBO_AGENT_SECRET: AGENT_SECRET })
  let viewer = null
  try {
    await waitFor(() => /registered as e2ehouse\.beebo\.tv/.test(agent.out.text), 20000, 'agent registration')
    viewer = await connectViewer(w.base)
    const hi = await viewer.hello()

    // The host's own fetch to the local media server can be cut when the machine is starved of
    // CPU (seen once in ~10 runs beside a Gradle build: undici "terminated" -> 502). One retry
    // keeps the byte-exact checks meaningful without making a benchmark flaky.
    const pull = async (range, tries = 2) => {
      const h = crypto.createHash('sha256')
      let bytes = 0
      const t0 = process.hrtime.bigint()
      try {
        const r = await viewer.requestStream('/big.bin', { range, onChunk: (c) => { h.update(c); bytes += c.length } })
        const seconds = Number(process.hrtime.bigint() - t0) / 1e9
        return { head: r.head, bytes, sha: h.digest('hex'), seconds }
      } catch (e) {
        if (tries > 1 && /err 502/.test(String(e))) { t.diagnostic('retrying after a 502 from the host'); return pull(range, tries - 1) }
        throw e
      }
    }

    const first = await pull(null)
    assert.equal(first.head.status, 200)
    assert.equal(first.bytes, total)
    assert.equal(first.sha, benchHash(0, total - 1), 'the whole file is byte-exact')
    const mbps = (first.bytes / 1048576) / first.seconds
    t.diagnostic(`tunnel download: ${(first.bytes / 1048576).toFixed(0)} MB in ${first.seconds.toFixed(2)} s = ${mbps.toFixed(2)} MB/s (host chunk ${hi.bodyChunk} B)`)
    console.log(`BENCH tunnel ${(first.bytes / 1048576).toFixed(0)}MB ${first.seconds.toFixed(2)}s ${mbps.toFixed(2)}MB/s chunk=${hi.bodyChunk}`)

    const from = 7 * BENCH_BLOCK + 555
    const rest = await pull(`bytes=${from}-`)
    assert.equal(rest.head.status, 206)
    assert.equal(rest.head.crange, `bytes ${from}-${total - 1}/${total}`)
    assert.equal(rest.sha, benchHash(from, total - 1), 'a resumed download continues byte-exact')
  } catch (e) {
    console.log(agent.out.text.split('\n').slice(-25).join('\n'))
    throw e
  } finally {
    try { viewer && viewer.pc.close() } catch {}
    agent.child.kill()
    media.server.close()
  }
})

test.after(async () => {
  if (workerOnce) (await workerOnce).server.close()
})
