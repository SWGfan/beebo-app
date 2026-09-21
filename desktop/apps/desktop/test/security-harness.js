// Shared helper for the security regression tests: a real server on a spare port with a one-film
// library, one signed-in admin (API token + session cookie) and a raw http request function that
// lets a test set any Host header.
const fs = require('node:fs/promises')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))

function rawRequest(port, { method = 'GET', pathname = '/', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : (typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: { ...(data != null ? { 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try { json = JSON.parse(text) } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json })
      })
    })
    req.on('error', reject)
    if (data != null) req.write(data)
    req.end()
  })
}

async function withServer(options, fn) {
  const server = localRequire('./electron/streamServer')
  const auth = localRequire('./electron/auth')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'beebo-sec-test-'))
  const data = {}
  const store = { get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] }, onDidChange: () => () => {} }
  const logged = []
  let info
  try {
    await fs.writeFile(path.join(dir, 'Clip (2020).mp4'), '0123456789'.repeat(100))
    const { user } = auth.createUser(store, 'Owner', 'owner@example.com')
    store.set('authUsers', store.get('authUsers').map((u) => (u.id === user.id ? { ...u, isAdmin: true } : u)))
    const token = server.makeApiToken(store, user.id)
    const cookie = 'beebo_session=' + auth.signSession(store, user.id)
    const port = 46000 + Math.floor(Math.random() * 900) + 50
    info = server.startStreamServer({
      port, store, getMoviesDir: () => dir, getTvShowsDir: () => dir,
      getAllMoviesDirs: () => [dir], getAllTvShowsDirs: () => [],
      log: (m) => logged.push(String(m)), ...(options || {})
    })
    for (let i = 0; i < 50; i++) {
      try { await (await fetch(`http://127.0.0.1:${info.port}/api/ping`)).arrayBuffer(); break } catch { await new Promise((r) => setTimeout(r, 100)) }
    }
    const p = info.port
    const api = (method, pathname, body, headers = {}) => rawRequest(p, { method, pathname, body, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', ...headers } })
    await fn({ port: p, dir, store, user, token, cookie, logged, server, auth, api, raw: (o) => rawRequest(p, o) })
  } finally {
    if (info) await new Promise((r) => info.close(r))
    await fs.rm(dir, { recursive: true, force: true })
  }
}

module.exports = { withServer, rawRequest, localRequire }
