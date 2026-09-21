'use strict'
// One real stream server over a fixture library, for the public-API tests (/api/v1, API keys,
// webhooks). No TMDB key and no Electron: the library is a few empty files plus a fixture
// TMDB cache, and the store is a plain object.
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const auth = require('../../electron/auth')
const parental = require('../../electron/parentalControls')
const server = require('../../electron/streamServer')

const PASSWORD = 'Public-api-test-password-77'
const AGENT_SECRET = crypto.randomBytes(32).toString('hex')
let portSequence = 0

const ALIEN = {
  id: 8091,
  name: 'Alien Collection',
  parts: [
    { id: 679, title: 'Aliens', release_date: '1986-07-18', poster_path: '/aliens.jpg' },
    { id: 348, title: 'Alien', release_date: '1979-05-25', poster_path: '/alien.jpg' }
  ]
}

async function createFixture(t, options = {}) {
  const savedKey = process.env.TMDB_API_KEY
  delete process.env.TMDB_API_KEY
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'beebo-public-api-'))
  const moviesDir = path.join(root, 'Movies')
  const tvDir = path.join(root, 'TV Shows')
  const cacheDir = path.join(root, 'tmdb')
  await fs.mkdir(moviesDir, { recursive: true })
  await fs.mkdir(path.join(tvDir, 'Severance', 'Season 1'), { recursive: true })
  await fs.mkdir(path.join(cacheDir, 'posters'), { recursive: true })
  for (const f of ['Alien (1979).mp4', 'Aliens (1986).mkv', 'Heat (1995).mp4']) await fs.writeFile(path.join(moviesDir, f), Buffer.alloc(2048, 1))
  await fs.writeFile(path.join(tvDir, 'Severance', 'Season 1', 'Severance S01E01.mkv'), Buffer.alloc(2048, 2))
  await fs.writeFile(path.join(tvDir, 'Severance', 'Season 1', 'Severance S01E02.mkv'), Buffer.alloc(2048, 3))
  await fs.writeFile(path.join(cacheDir, 'posters', '348.jpg'), 'jpg')
  await fs.writeFile(path.join(cacheDir, 'manifest.json'), JSON.stringify({
    'Alien (1979).mp4': { id: 348, title: 'Alien', release_date: '1979-05-25', poster_path: '/alien.jpg', genre_ids: [27, 878], overview: 'In space no one can hear you scream.', vote_average: 8.1 },
    'Aliens (1986).mkv': { id: 679, title: 'Aliens', release_date: '1986-07-18', poster_path: '/aliens.jpg', genre_ids: [28] },
    'Heat (1995).mp4': { id: 949, title: 'Heat', release_date: '1995-12-15', poster_path: '/heat.jpg', genre_ids: [80] }
  }))
  await fs.writeFile(path.join(cacheDir, 'collections.json'), JSON.stringify({ 348: ALIEN, 679: ALIEN, 949: null }))

  const remote = { pw_hash: 'a'.repeat(64), pw_salt: 'b'.repeat(32), pw_iter: 25000 }
  const data = {
    authUsers: [
      { id: 'owner', name: 'Owner', username: 'owner', status: 'approved', isAdmin: true, adult: true, passwordHash: auth.hashPassword(PASSWORD) },
      { id: 'member', name: 'Member', username: 'member', status: 'approved', adult: true, passwordHash: auth.hashPassword(PASSWORD), email: 'member@example.test', remote },
      { id: 'kid', name: 'Kid', username: 'kid', status: 'approved', passwordHash: auth.hashPassword(PASSWORD) },
      { id: 'hidden', name: 'Hidden', username: 'hidden', status: 'approved', adult: true, viewingHistoryPrivate: true, passwordHash: auth.hashPassword(PASSWORD) },
      { id: 'admin2', name: 'Second admin', username: 'admin2', status: 'approved', isAdmin: true, adult: true, passwordHash: auth.hashPassword(PASSWORD) }
    ],
    ...(options.data || {})
  }
  const store = { get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] }, onDidChange: () => () => {} }
  parental.setPolicy(store, 'kid', parental.presetPolicy('kids'))
  auth.forgetSecrets(); server.forgetSecrets()
  const info = server.startStreamServer({
    port: 45000 + (process.pid % 1400) + ++portSequence,
    store,
    getMoviesDir: () => moviesDir,
    getTvShowsDir: () => tvDir,
    getAllMoviesDirs: () => [moviesDir],
    getAllTvShowsDirs: () => [tvDir],
    getTmdbCacheDir: () => cacheDir,
    agentSecret: AGENT_SECRET,
    log: () => {},
    ...(options.server || {})
  })
  t.after(async () => {
    await new Promise((resolve) => info.close(resolve))
    await fs.rm(root, { recursive: true, force: true })
    if (savedKey !== undefined) process.env.TMDB_API_KEY = savedKey
  })
  const base = 'http://127.0.0.1:' + info.port
  let ready = false
  for (let i = 0; i < 60; i++) {
    try { await (await fetch(base + '/api/ping')).arrayBuffer(); ready = true; break } catch { await new Promise((r) => setTimeout(r, 50)) }
  }
  assert.equal(ready, true, 'fixture server started')

  const tokens = Object.fromEntries(data.authUsers.map((u) => [u.id, server.makeApiToken(store, u.id)]))
  async function call(bearer, route, { method = 'GET', body, headers = {} } = {}) {
    const response = await fetch(base + route, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(bearer ? { Authorization: 'Bearer ' + (tokens[bearer] || bearer) } : {}),
        ...headers
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual'
    })
    const text = await response.text()
    let json = null
    try { json = JSON.parse(text) } catch {}
    return { status: response.status, body: json, text, headers: response.headers }
  }
  // Admin routes over HTTP are TLS-only; the desktop agent key is the local way in (same as the other suites).
  const admin = (route, body, who = 'owner') => call(who, route, { method: body === undefined ? 'GET' : 'POST', body, headers: { 'X-Beebo-Agent-Key': AGENT_SECRET } })
  return { base, info, data, store, tokens, call, admin, moviesDir, tvDir, cacheDir, root, AGENT_SECRET }
}

// The website's /admin pages, over TLS with a throwaway certificate. Null when openssl is missing.
function webAdmin(f, who = 'owner') {
  const https = require('node:https')
  const { execFileSync } = require('node:child_process')
  let cert = null
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(f.root, 'key.pem'), '-out', path.join(f.root, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' })
    cert = { cert: require('node:fs').readFileSync(path.join(f.root, 'cert.pem'), 'utf8'), key: require('node:fs').readFileSync(path.join(f.root, 'key.pem'), 'utf8') }
  } catch {}
  if (!cert) return null
  assert.equal(f.info.applyCertificate(cert).ok, true)
  const cookie = `beebo_session=${auth.signSession(f.store, who)}`
  // `json` (a 4th argument) posts a JSON body instead of a form, for the pages that talk JSON.
  return (method, route, form, json) => new Promise((resolve, reject) => {
    const headers = { Cookie: cookie }
    if (form) headers['Content-Type'] = 'application/x-www-form-urlencoded'
    if (json !== undefined) headers['Content-Type'] = 'application/json'
    const req = https.request({ host: '127.0.0.1', port: f.info.port, method, path: route, headers, rejectUnauthorized: false }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    if (form) req.write(new URLSearchParams(form).toString())
    if (json !== undefined) req.write(JSON.stringify(json))
    req.end()
  })
}

module.exports = { createFixture, webAdmin, PASSWORD, AGENT_SECRET }
