// The admin WEBSITE's Markers tab (HTTPS-only, like the rest of /admin): it lists what the scanner
// found and offers "Re-scan intro/credits" and "Clear auto markers" per show.
// Skipped when openssl is unavailable (needed for a throwaway certificate, as backup-restore.test.js).
// Run: node --test test/intro-markers-admin-web.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const https = require('node:https')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const auth = require('../electron/auth')
const server = require('../electron/streamServer')
const M = require('../electron/markerModel')
const { testPort } = require('./helpers/testPort')

function makeCert(dir) {
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' })
    return { cert: fs.readFileSync(path.join(dir, 'cert.pem'), 'utf8'), key: fs.readFileSync(path.join(dir, 'key.pem'), 'utf8') }
  } catch { return null }
}

function request(port, method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port, method, path: p, headers, rejectUnauthorized: false }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

test('admin website: Markers tab shows auto-detected markers with per-show Re-scan and Clear', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-intro-admin-'))
  const cert = makeCert(dir)
  if (!cert) { fs.rmSync(dir, { recursive: true, force: true }); t.skip('openssl not available'); return }
  const tvDir = path.join(dir, 'tv')
  fs.mkdirSync(path.join(tvDir, 'The Show'), { recursive: true })
  const files = [1, 2].map((n) => path.join(tvDir, 'The Show', `The.Show.S01E0${n}.mp4`))
  files.forEach((f, i) => fs.writeFileSync(f, Buffer.alloc(4096, i + 1)))
  const data = { authUsers: [{ id: 'u-owner', name: 'Owner', username: 'owner', status: 'approved', isAdmin: true, passwordHash: auth.hashPassword('Owner-password-1') }] }
  const store = { get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] }, onDidChange: () => () => {} }
  const showKey = server.encodeId('the show')
  const auto = {}
  for (const f of files) {
    const id = M.fileIdentity(f, fs.statSync(f))
    auto[id] = { identity: id, version: 1, kind: 'tv', showKey, showName: 'The Show', durationSec: 1500, introStart: 40, introEnd: 100, introConfidence: 0.9, creditsStart: 1380, creditsConfidence: 0.9, seenAt: Date.now() }
  }
  data.autoMarkers = auto
  auth.forgetSecrets(); server.forgetSecrets()
  const info = server.startStreamServer({
    port: testPort(), store, getMoviesDir: () => dir, getTvShowsDir: () => tvDir,
    getAllMoviesDirs: () => [], getAllTvShowsDirs: () => [tvDir], log: () => {},
    autoMarkers: { startDelayMs: 3600 * 1000, intervalMs: 3600 * 1000 }
  })
  t.after(async () => { await new Promise((r) => info.close(r)); fs.rmSync(dir, { recursive: true, force: true }) })
  assert.equal(info.applyCertificate(cert).ok, true)
  for (let i = 0; i < 50; i++) {
    try { await request(info.port, 'GET', '/login'); break } catch { await new Promise((r) => setTimeout(r, 100)) }
  }
  const cookie = `beebo_session=${auth.signSession(store, 'u-owner')}`

  // The shared library cache is filled by browsing; the tab's counts only cover files the library knows.
  await request(info.port, 'GET', '/tvshows', { headers: { Cookie: cookie } })
  info.autoMarkers.kick && (await info.autoMarkers.kick().catch(() => {}))

  const view = await request(info.port, 'GET', '/admin?tab=markers', { headers: { Cookie: cookie } })
  assert.equal(view.status, 200)
  assert.match(view.body, /Found automatically/)
  assert.match(view.body, /Re-scan intro\/credits/)
  assert.match(view.body, /Clear auto markers/)
  assert.match(view.body, /name="key" value="/)

  const post = await request(info.port, 'POST', '/admin/markers/auto-clear', {
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ tab: 'markers', scope: 'show', key: showKey }).toString()
  })
  assert.equal(post.status, 303)
  for (const rec of Object.values(data.autoMarkers)) assert.equal(rec.cleared, true, 'the records were cleared, not deleted')

  const foreign = await request(info.port, 'POST', '/admin/markers/auto-rescan', {
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' },
    body: new URLSearchParams({ tab: 'markers', scope: 'show', key: showKey }).toString()
  })
  assert.equal(foreign.status, 403, 'the existing cross-site guard applies to the new forms too')
})
