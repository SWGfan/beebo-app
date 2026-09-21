// Headless server: boots `node headless/main.js` for real (temp data folder, tiny
// fake media folder, ephemeral port) and checks the parts a NAS user depends on.
// Run: node --test test/headless-boot.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const https = require('node:https')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

const APP_DIR = path.join(__dirname, '..')
const SECRET_KEY = 'b'.repeat(64)

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
    s.on('error', reject)
  })
}

function startHeadless({ dataDir, moviesDir, port, extraEnv = {} }) {
  const env = {}
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('BEEBO_') && k !== 'TMDB_API_KEY') env[k] = v
  Object.assign(env, { BEEBO_DATA_DIR: dataDir, BEEBO_MOVIES_DIRS: moviesDir, BEEBO_PORT: String(port), BEEBO_UPNP: '0', BEEBO_SECRET_KEY: SECRET_KEY }, extraEnv)
  const child = spawn(process.execPath, [path.join(APP_DIR, 'headless', 'main.js')], { cwd: APP_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { out += d })
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
  const waitFor = (re, ms = 60000) => new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      const m = re.exec(out)
      if (m) return resolve(m)
      if (Date.now() - started > ms) return reject(new Error(`timed out waiting for ${re}; output so far:\n${out}`))
      setTimeout(tick, 100)
    }
    tick()
  })
  return { child, output: () => out, waitFor, exited, port }
}

function request(port, { method = 'GET', path: p = '/', body, headers = {}, secure = true }) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body)
    const lib = secure ? https : http
    const r = lib.request({ host: '127.0.0.1', port, method, path: p, rejectUnauthorized: false, headers: Object.assign(data !== null ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}, headers) }, (res) => {
      let text = ''
      res.on('data', (c) => { text += c })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }))
    })
    r.on('error', reject)
    if (data !== null) r.write(data)
    r.end()
  })
}

function killTree(h) {
  try { h.child.kill('SIGKILL') } catch { /* already gone */ }
}

test('boots, serves ping, gates first-run setup on the printed code, then closes setup for good', { timeout: 180000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-boot-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dataDir = path.join(root, 'config')
  const moviesDir = path.join(root, 'movies')
  fs.mkdirSync(moviesDir, { recursive: true })
  fs.writeFileSync(path.join(moviesDir, 'Tiny Test Movie (2020).mp4'), Buffer.alloc(2048, 1))
  const port = await freePort()

  const first = startHeadless({ dataDir, moviesDir, port })
  t.after(() => killTree(first))
  const [, code] = await first.waitFor(/Setup code: ([2-9A-Z]{4}-[2-9A-Z]{4}-[2-9A-Z]{4})/)
  assert.match(first.output(), /Beebo Entertainment .* headless server starting/)
  assert.match(first.output(), /secrets are encrypted at rest \(key from env\)/)
  assert.match(first.output(), /Open https:\/\/.*\/setup/)

  const ping = await request(port, { path: '/api/ping' })
  assert.equal(ping.status, 200)
  assert.equal(JSON.parse(ping.text).app, 'beeboentertainment')
  const plainPing = await request(port, { path: '/api/ping', secure: false })
  assert.equal(plainPing.status, 200)

  const page = await request(port, { path: '/setup' })
  assert.equal(page.status, 200)
  assert.match(page.text, /Set up Beebo/)

  const wrong = await request(port, { method: 'POST', path: '/api/headless/setup', body: { code: 'AAAA-AAAA-AAAA', username: 'owner', password: 'correct horse battery' } })
  assert.equal(wrong.status, 403)
  const usersBefore = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')).authUsers || []
  assert.equal(usersBefore.length, 0)

  const created = await request(port, { method: 'POST', path: '/api/headless/setup', body: { code, username: 'owner', password: 'correct horse battery' } })
  assert.equal(created.status, 200)
  await first.waitFor(/owner account was created/)

  const again = await request(port, { method: 'POST', path: '/api/headless/setup', body: { code, username: 'mallory', password: 'another long password' } })
  assert.notEqual(again.status, 200)
  const pageAfter = await request(port, { path: '/setup' })
  assert.notEqual(pageAfter.status, 200)

  const login = await request(port, { method: 'POST', path: '/api/login', body: { username: 'owner', password: 'correct horse battery' } })
  assert.equal(login.status, 200)
  const token = JSON.parse(login.text).token
  assert.ok(token)
  const me = JSON.parse(login.text).user
  assert.equal(me.isAdmin, true)

  const adminHttps = await request(port, { path: '/api/admin/summary', headers: { Authorization: 'Bearer ' + token } })
  assert.equal(adminHttps.status, 200)
  const adminPlain = await request(port, { path: '/api/admin/summary', headers: { Authorization: 'Bearer ' + token }, secure: false })
  assert.notEqual(adminPlain.status, 200)

  const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'))
  assert.equal('apiTokenSecret' in cfg, false)
  assert.ok(cfg.encryptedSettings && cfg.encryptedSettings.apiTokenSecret && cfg.encryptedSettings.apiTokenSecret.startsWith(Buffer.from('BSS1').toString('base64').slice(0, 4)))
  assert.ok(cfg.encryptedSettings['authUsers#fields'])
  assert.equal(cfg.authUsers.length, 1)
  assert.equal(cfg.streamPort, port)
  assert.equal(cfg.moviesDir, moviesDir)
  assert.ok(!fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8').includes('correct horse battery'))
  assert.ok(!first.output().includes('correct horse battery'))
  assert.ok(!first.output().includes(token))
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dataDir, 'config.json')).mode & 0o077, 0, 'config.json must not be readable or writable by other users')
  assert.equal(fs.existsSync(path.join(dataDir, 'secret.key')), false)
  assert.ok(fs.existsSync(path.join(dataDir, 'secret.check')))

  if (process.platform === 'win32') {
    killTree(first)
    await first.exited
  } else {
    first.child.kill('SIGTERM')
    const exit = await Promise.race([first.exited, new Promise((resolve) => setTimeout(() => resolve('timeout'), 15000))])
    assert.notEqual(exit, 'timeout', 'server did not stop within 15 s of SIGTERM')
    assert.equal(exit.code, 0)
    assert.match(first.output(), /stopping \(SIGTERM\)/)
    assert.match(first.output(), /Beebo server stopped/)
  }

  const second = startHeadless({ dataDir, moviesDir, port })
  t.after(() => killTree(second))
  await second.waitFor(/Beebo server .* is up on/)
  assert.doesNotMatch(second.output(), /Setup code:/)
  assert.doesNotMatch(second.output(), /no owner account yet/)
  const pageSecond = await request(port, { path: '/setup' })
  assert.notEqual(pageSecond.status, 200)
  const loginSecond = await request(port, { method: 'POST', path: '/api/login', body: { username: 'owner', password: 'correct horse battery' } })
  assert.equal(loginSecond.status, 200)
  killTree(second)
  await second.exited
})

test('a wrong secret key stops the boot with a clear message instead of signing everyone out', { timeout: 120000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-boot-key-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dataDir = path.join(root, 'config')
  const moviesDir = path.join(root, 'movies')
  fs.mkdirSync(moviesDir, { recursive: true })
  const port = await freePort()
  const a = startHeadless({ dataDir, moviesDir, port })
  t.after(() => killTree(a))
  await a.waitFor(/Beebo server .* is up on/)
  killTree(a)
  await a.exited
  const b = startHeadless({ dataDir, moviesDir, port, extraEnv: { BEEBO_SECRET_KEY: 'c'.repeat(64) } })
  t.after(() => killTree(b))
  const exit = await b.exited
  assert.equal(exit.code, 78)
  assert.match(b.output(), /secret key does not match the one this data folder/)
})

test('bad configuration exits 78 and lists every problem; no plaintext secrets without opt-in', { timeout: 60000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-boot-bad-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const bad = startHeadless({ dataDir: path.join(root, 'c'), moviesDir: path.join(root, 'm'), port: 1, extraEnv: { BEEBO_PORT: 'nope', BEEBO_UPNP: 'perhaps' } })
  t.after(() => killTree(bad))
  const exit = await bad.exited
  assert.equal(exit.code, 78)
  assert.match(bad.output(), /BEEBO_PORT must be a whole number/)
  assert.match(bad.output(), /BEEBO_UPNP must be 1\/0/)

  fs.mkdirSync(path.join(root, 'blocked'), { recursive: true })
  fs.writeFileSync(path.join(root, 'blocked', 'c'), 'a file where the data folder should be')
  const noKey = startHeadless({ dataDir: path.join(root, 'blocked', 'c'), moviesDir: path.join(root, 'm'), port: await freePort(), extraEnv: { BEEBO_SECRET_KEY: '' } })
  t.after(() => killTree(noKey))
  const exit2 = await noKey.exited
  assert.equal(exit2.code, 78)
  assert.match(noKey.output(), /BEEBO_SECRET_KEY/)
  assert.doesNotMatch(noKey.output(), /is up on/)
})
