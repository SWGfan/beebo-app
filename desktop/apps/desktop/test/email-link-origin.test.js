// Security review #20: password-reset and verify links were built from the
// request's Host header, so a forged Host sent the victim's token to the
// attacker's site. Links now come from the configured public address.
// Run: node --test test/email-link-origin.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')

const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))

function post(port, pathname, form, headers) {
  const body = new URLSearchParams(form).toString()
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'content-length': Buffer.byteLength(body),
          ...headers
        }
      },
      (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode))
      }
    )
    req.on('error', reject)
    req.end(body)
  })
}

async function withServer(options, fn) {
  const server = localRequire('./electron/streamServer')
  const auth = localRequire('./electron/auth')
  const mailer = localRequire('./electron/mailer')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'beebo-link-test-'))
  const data = {}
  const store = { get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] }, onDidChange: () => () => {} }
  const sent = []
  const realSend = mailer.sendMail
  mailer.sendMail = async (_store, msg) => { sent.push(msg); return { ok: true } }
  let info
  try {
    auth.createUser(store, 'Victim', 'victim@example.com')
    const port = 46000 + Math.floor(Math.random() * 900) + 50
    info = server.startStreamServer({
      port, store, getMoviesDir: () => dir, getTvShowsDir: () => dir,
      getAllMoviesDirs: () => [dir], getAllTvShowsDirs: () => [],
      log: () => {}, ...options
    })
    for (let i = 0; i < 50; i++) {
      try { await fetch(`http://127.0.0.1:${info.port}/login`); break } catch { await new Promise((r) => setTimeout(r, 100)) }
    }
    await fn({ port: info.port, sent })
  } finally {
    mailer.sendMail = realSend
    if (info) await new Promise((r) => info.close(r))
    await fs.rm(dir, { recursive: true, force: true })
  }
}

const forged = { host: 'evil.example', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' }

test('a forged Host header does not change the emailed reset or verify link (<name>.beebo.tv)', async () => {
  await withServer({ getPublicName: () => 'nick' }, async ({ port, sent }) => {
    await post(port, '/forgot-password', { email: 'victim@example.com' }, forged)
    await post(port, '/signup', { username: 'newperson', email: 'new@example.com', password: 'longenough1' }, forged)
    await new Promise((r) => setTimeout(r, 50))
    const links = sent.map((m) => /https?:\/\/\S+/.exec(m.text)[0])
    assert.equal(links.length, 2)
    assert.match(links[0], /^https:\/\/nick\.beebo\.tv\/reset-password\?token=[0-9a-f]+$/)
    assert.match(links[1], /^https:\/\/nick\.beebo\.tv\/verify\?token=[0-9a-f]+$/)
    for (const l of links) assert.ok(!l.includes('evil.example'))
  })
})

test('without a claimed name the configured domain is used, else the LAN address', async () => {
  await withServer({ getCertDomain: () => 'home.duckdns.org' }, async ({ port, sent }) => {
    await post(port, '/forgot-password', { email: 'victim@example.com' }, forged)
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(sent.length, 1)
    assert.match(sent[0].text, new RegExp(`http://home\\.duckdns\\.org:${port}/reset-password\\?token=`))
    assert.ok(!sent[0].text.includes('evil.example'))
  })
  await withServer({}, async ({ port, sent }) => {
    await post(port, '/forgot-password', { email: 'victim@example.com' }, { host: 'evil.example' })
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(sent.length, 1)
    assert.match(sent[0].text, new RegExp(`http://(\\d{1,3}\\.){3}\\d{1,3}:${port}/reset-password\\?token=`))
    assert.ok(!sent[0].text.includes('evil.example'))
  })
})

test('emailLinkOrigin picks name, then domain (https once a certificate is live), then LAN', () => {
  const { emailLinkOrigin } = localRequire('./electron/streamServer')
  assert.equal(emailLinkOrigin({ publicName: 'Nick', certDomain: 'x.duckdns.org', port: 47811 }), 'https://nick.beebo.tv')
  assert.equal(emailLinkOrigin({ publicName: 'bad name!', certDomain: '', lanIp: '192.168.1.5', port: 47811 }), 'https://badname.beebo.tv')
  assert.equal(emailLinkOrigin({ certDomain: 'x.duckdns.org', tlsActive: true, port: 443 }), 'https://x.duckdns.org')
  assert.equal(emailLinkOrigin({ certDomain: 'x.duckdns.org', tlsActive: true, port: 47811 }), 'https://x.duckdns.org:47811')
  assert.equal(emailLinkOrigin({ certDomain: 'evil.example/path?', port: 47811, lanIp: '192.168.1.5' }), 'http://192.168.1.5:47811')
  assert.equal(emailLinkOrigin({ lanIp: '192.168.1.5', port: 47811 }), 'http://192.168.1.5:47811')
})
