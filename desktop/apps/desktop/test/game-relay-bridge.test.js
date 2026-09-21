// Home Game Server "Away Play": proves the WebRTC-reuse approach for Part A.
//
// A real Minecraft client speaks raw TCP, not HTTP, so this is NOT the proven
// "http" data-channel bridge (rtc-host.e2e.test.js) — it is a SECOND, raw byte
// pipe ("mc" data channel) added to beebo-rtc-host.js, joined from the other
// side by resources/beebo-rtc-host/beebo-game-client.js. This test proves both
// halves together, through the REAL Worker fetch handler (in-memory D1) and a
// real werift RTCPeerConnection on each side, exactly as rtc-host.e2e.test.js
// proves the video bridge: no shortcuts, no mocked WebRTC.
//
// Needs werift, which is not committed. Point BEEBO_RTC_NODE_MODULES at a
// node_modules folder that has it (see rtc-host.e2e.test.js). Skips cleanly
// when it can't find one. Run: node --test test/game-relay-bridge.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const net = require('node:net')
const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')
const { fork } = require('node:child_process')
const { pathToFileURL } = require('node:url')

const appRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(appRoot, '..', '..', '..')
const HOST_AGENT = path.join(appRoot, 'resources', 'beebo-rtc-host', 'beebo-rtc-host.js')
const CLIENT_AGENT = path.join(appRoot, 'resources', 'beebo-rtc-host', 'beebo-game-client.js')
const NM = [process.env.BEEBO_RTC_NODE_MODULES, path.join(appRoot, 'resources', 'beebo-rtc-host', 'node_modules')]
  .filter(Boolean).find((d) => fs.existsSync(path.join(d, 'werift', 'package.json')))
const skip = require('./helpers/privateParts').skipIfMissing('worker/worker.js') || (NM ? false : 'werift not found (set BEEBO_RTC_NODE_MODULES)')

const NAME = 'gamehouse'
const OWNER = 'owner@example.com'
const PASSWORD = 'e2e password'
// A UDP range distinct from rtc-host.e2e.test.js's (separate process, but keep well clear).
const TEST_MIN = 46970, TEST_MAX = 46979
const TEST_PORTS = `${TEST_MIN}-${TEST_MAX}`
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
// Copied from rtc-host.e2e.test.js on purpose (see that file's own note on why
// beebo-game-client.js copies frame()/unframe() rather than sharing a module).
let workerOnce = null
function startWorker() { if (!workerOnce) workerOnce = startWorkerNow(); return workerOnce }
async function startWorkerNow() {
  const worker = (await import(pathToFileURL(path.join(repoRoot, 'worker', 'worker.js')).href)).default
  const { _test } = await import(pathToFileURL(path.join(repoRoot, 'worker', 'worker.js')).href)
  const { makeD1, fakeRequest } = await import(pathToFileURL(path.join(repoRoot, 'worker', 'test', 'd1-mock.mjs')).href)
  const keys = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  const ctl = { relay: null } // stand-in for the Beebo Relay credentials endpoint; unset: real Worker answers 404
  const env = { DB: makeD1(), LICENSE_PUBLIC_KEY: keys.publicKey, LICENSE_PRIVATE_KEY: keys.privateKey }
  await _test.ensureAuthSchema(env)
  await _test.upsertUserPassword(env, OWNER, PASSWORD)
  const now = Math.floor(Date.now() / 1000)
  await env.DB.prepare('INSERT INTO licenses (license_key, email, plan, status, current_period_end, max_devices, revoked, created_at) VALUES (?,?,?,?,?,?,0,?)')
    .bind('KEY-GAME-E2E', OWNER, 'beebo-standard', 'active', now + 30 * 86400, 1, now).run()
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const headers = { ...req.headers }
    delete headers.host
    if (ctl.relay && req.url.startsWith('/rtc/relay/')) {
      const out = await ctl.relay(req.method, req.url.split('?')[0], req.headers)
      res.writeHead(out.status, { 'content-type': 'application/json' })
      return res.end(JSON.stringify(out.body))
    }
    const fr = fakeRequest(`https://${NAME}.beebo.tv${req.url}`, { method: req.method, headers, body: Buffer.concat(chunks).toString('utf8') })
    const out = await worker.fetch(fr, env)
    res.writeHead(out.status, { 'content-type': out.headers.get('content-type') || 'application/json' })
    res.end(Buffer.from(await out.arrayBuffer()))
  })
  const port = await listen(server)
  return { server, base: `http://127.0.0.1:${port}`, ctl, env, _test, keys }
}

function startHostAgent(env) {
  const out = { text: '' }
  const child = fork(HOST_AGENT, [], {
    env: { ...process.env, NODE_PATH: NM, BEEBO_NAME: NAME, BEEBO_VERBOSE: '1', BEEBO_ICE_PORTS: TEST_PORTS, ...env },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  child.stdout.on('data', (d) => { out.text += d })
  child.stderr.on('data', (d) => { out.text += d })
  return { child, out }
}

function startJoinClient(env) {
  const out = { text: '' }
  const child = fork(CLIENT_AGENT, [], {
    env: { ...process.env, NODE_PATH: NM, BEEBO_JOIN_VERBOSE: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  child.stdout.on('data', (d) => { out.text += d })
  child.stderr.on('data', (d) => { out.text += d })
  return { child, out }
}

// A stand-in "Minecraft" TCP server: echoes back whatever it is sent, so a
// byte-exact round trip through the whole WebRTC hop is easy to prove, and
// tags what it saw so both ends of one connection can be told apart.
function startFakeMinecraft() {
  let connections = 0
  const server = net.createServer((sock) => {
    connections++
    sock.on('error', () => {}) // killing the host agent mid-test resets this end; not a test failure
    sock.on('data', (chunk) => { sock.write(Buffer.concat([Buffer.from('echo:'), chunk])) })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, connections: () => connections })))
}

// One local TCP connection into the joiner's listener, collecting everything
// it writes back until the socket ends.
function localConnect(port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1')
    const chunks = []
    sock.once('connect', () => { sock.removeListener('error', reject); sock.on('error', () => {}); resolve({ sock, chunks }) })
    sock.once('error', reject)
    sock.on('data', (c) => chunks.push(c))
  })
}
function waitClosed(sock, ms = 10000) {
  return new Promise((resolve, reject) => {
    if (sock.destroyed) return resolve()
    sock.once('close', resolve)
    setTimeout(() => reject(new Error('socket did not close')), ms)
  })
}

test('a real Minecraft-shaped TCP round trip over the SAME direct WebRTC path Beebo video already uses, multiplexed', { skip, timeout: 90000 }, async () => {
  const w = await startWorker()
  const mc = await startFakeMinecraft()
  // A real, unexpired licence token for the owner, signed with this test Worker's own key.
  const token = await w._test.signToken({ type: 'subscription', email: OWNER, deviceId: 'dev-e2e', expiresAt: Math.floor(Date.now() / 1000) + 86400 }, w.keys.privateKey)
  const agent = startHostAgent({ BEEBO_HOST_URL: w.base, BEEBO_HOST_TOKEN: token, BEEBO_LOCAL_URL: 'http://127.0.0.1:1' })
  const client = startJoinClient({ BEEBO_JOIN_URL: w.base, BEEBO_JOIN_NAME: NAME, BEEBO_JOIN_EMAIL: OWNER, BEEBO_JOIN_PASSWORD: PASSWORD, BEEBO_JOIN_LOCAL_PORT: '0' })
  try {
    await waitFor(() => /registered as gamehouse\.beebo\.tv/.test(agent.out.text), 20000, 'host agent registration')
    // Turn Home Game Server "on" — the same message gameHostIpc.js sends via remoteHostAgent.js.
    agent.child.send({ type: 'game', game: { enabled: true, port: mc.port } })
    await waitFor(() => /game host on, bridging to 127\.0\.0\.1/.test(agent.out.text), 5000, 'the agent to enable the game bridge')

    // BEEBO_JOIN_LOCAL_PORT=0 isn't a real option (net.Server.listen(0,...) IS
    // valid though) — read back the port the client actually chose to bind.
    await waitFor(() => /ready — point your Minecraft client/.test(client.out.text), 20000, 'the joiner\'s local listener')
    const m = /port (\d+)\)/.exec(client.out.text)
    assert.ok(m, 'the joiner logs which local port it is listening on: ' + client.out.text)
    const localPort = Number(m[1])

    // An UNMODIFIED "Minecraft client" is just a plain TCP socket to "localhost".
    const a = await localConnect(localPort)
    const payloadA = crypto.randomBytes(4096)
    a.sock.write(payloadA)
    await waitFor(() => Buffer.concat(a.chunks).length >= 5 + payloadA.length, 15000, 'echo back to connection A')
    assert.ok(Buffer.concat(a.chunks).equals(Buffer.concat([Buffer.from('echo:'), payloadA])), 'byte-exact round trip through the WebRTC data channel')

    // A SECOND local connection, concurrent with the first, proves the id-based
    // framing multiplexes more than one Minecraft-shaped TCP stream over the
    // one already-open "mc" data channel (no second handshake needed).
    const b = await localConnect(localPort)
    const payloadB = crypto.randomBytes(2048)
    b.sock.write(payloadB)
    await waitFor(() => Buffer.concat(b.chunks).length >= 5 + payloadB.length, 15000, 'echo back to connection B')
    assert.ok(Buffer.concat(b.chunks).equals(Buffer.concat([Buffer.from('echo:'), payloadB])), 'second, concurrent connection is also byte-exact')
    assert.equal(mc.connections(), 2, 'the fake Minecraft server saw two independent TCP connections, multiplexed over one data channel')

    // Ending the local ("Minecraft client") side closes just that one stream,
    // not the shared data channel: connection A can still be used after.
    a.sock.end()
    await waitClosed(a.sock)
    const c = await localConnect(localPort)
    const payloadC = Buffer.from('still working')
    c.sock.write(payloadC)
    await waitFor(() => Buffer.concat(c.chunks).length >= 5 + payloadC.length, 15000, 'a third connection after the first ended')
    c.sock.end()
    b.sock.end()
  } finally {
    agent.child.kill(); client.child.kill(); mc.server.close()
  }
})

test('Home Game Server "off": a joiner is told plainly, not left hanging', { skip, timeout: 60000 }, async () => {
  const w = await startWorker()
  const token = await w._test.signToken({ type: 'subscription', email: OWNER, deviceId: 'dev-e2e-2', expiresAt: Math.floor(Date.now() / 1000) + 86400 }, w.keys.privateKey)
  const agent = startHostAgent({ BEEBO_HOST_URL: w.base, BEEBO_HOST_TOKEN: token, BEEBO_LOCAL_URL: 'http://127.0.0.1:1' })
  const client = startJoinClient({ BEEBO_JOIN_URL: w.base, BEEBO_JOIN_NAME: NAME, BEEBO_JOIN_EMAIL: OWNER, BEEBO_JOIN_PASSWORD: PASSWORD, BEEBO_JOIN_LOCAL_PORT: '0' })
  try {
    await waitFor(() => /registered as gamehouse\.beebo\.tv/.test(agent.out.text), 20000, 'host agent registration')
    // Deliberately never sending {type:'game', enabled:true}: Home Game Server was never turned on.
    await waitFor(() => /ready — point your Minecraft client/.test(client.out.text), 20000, 'the joiner\'s local listener')
    const m = /port (\d+)\)/.exec(client.out.text)
    const localPort = Number(m[1])
    const a = await localConnect(localPort)
    a.sock.write(Buffer.from('hello'))
    await waitClosed(a.sock, 15000)
  } finally {
    agent.child.kill(); client.child.kill()
  }
})

test.after(async () => {
  if (workerOnce) (await workerOnce).server.close()
})
