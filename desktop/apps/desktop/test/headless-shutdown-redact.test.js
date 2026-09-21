// Headless server: graceful shutdown sequencing, log redaction, self-signed certificate.
// Run: node --test test/headless-shutdown-redact.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createShutdown } = require(path.join(__dirname, '..', 'headless', 'shutdown.js'))
const { redact, installConsoleRedaction } = require(path.join(__dirname, '..', 'headless', 'logRedact.js'))
const selfSigned = require(path.join(__dirname, '..', 'headless', 'selfSigned.js'))

function fakeTimers() {
  const timers = []
  return {
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t },
    clearTimer: (t) => { t.cleared = true },
    timers,
    fire: (i) => { if (!timers[i].cleared) timers[i].fn() }
  }
}

test('SIGTERM: quit handlers run first, then the server closes, then the process exits 0', async () => {
  const order = []
  const timers = fakeTimers()
  let shutdown
  shutdown = createShutdown({
    requestQuit: () => { order.push('before-quit handlers'); shutdown.finish(0) },
    closeServer: (done) => { order.push('server closed'); done() },
    exit: (code) => { order.push('exit ' + code) },
    log: (m) => order.push('log: ' + m),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer
  })
  shutdown.trigger('SIGTERM')
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(order.filter((x) => !x.startsWith('log:')), ['before-quit handlers', 'server closed', 'exit 0'])
  assert.equal(timers.timers[0].cleared, true)
})

test('a quit that never completes is cut off by the hard timeout with exit 1', () => {
  const timers = fakeTimers()
  const exits = []
  const shutdown = createShutdown({ requestQuit: () => {}, closeServer: (d) => d(), exit: (c) => exits.push(c), setTimer: timers.setTimer, clearTimer: timers.clearTimer, hardTimeoutMs: 8000 })
  shutdown.trigger('SIGTERM')
  assert.equal(timers.timers[0].ms, 8000)
  assert.deepEqual(exits, [])
  timers.fire(0)
  assert.deepEqual(exits, [1])
})

test('a second stop signal exits immediately', () => {
  const exits = []
  const shutdown = createShutdown({ requestQuit: () => {}, closeServer: (d) => d(), exit: (c) => exits.push(c), setTimer: fakeTimers().setTimer })
  shutdown.trigger('SIGINT')
  shutdown.trigger('SIGINT')
  assert.deepEqual(exits, [1])
})

test('a server close that hangs does not block exit', async () => {
  const exits = []
  const timers = fakeTimers()
  const shutdown = createShutdown({ requestQuit: () => {}, closeServer: () => {}, exit: (c) => exits.push(c), setTimer: timers.setTimer, clearTimer: timers.clearTimer })
  shutdown.finish(0)
  await new Promise((r) => setImmediate(r))
  const guard = timers.timers[timers.timers.length - 1]
  guard.fn()
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(exits, [0])
})

test('a throwing closeServer still exits', async () => {
  const exits = []
  const shutdown = createShutdown({ requestQuit: () => {}, closeServer: () => { throw new Error('boom') }, exit: (c) => exits.push(c), setTimer: fakeTimers().setTimer })
  shutdown.finish(0)
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(exits, [0])
})

test('redact: media tokens, api tokens, bearer, cookies and JSON secrets never reach the log', () => {
  const cases = [
    ['GET /file?id=abc&mt=1789.SIGNATUREvalue&x=1', 'SIGNATUREvalue'],
    ['url http://h/api?token=abcdef123456&y=2', 'abcdef123456'],
    ['Authorization: Bearer eyJhbGciOi.payload.sig', 'eyJhbGciOi'],
    ['sent Bearer 7c727281-f021-45d6-8732-c58202150078.1821520995013.6x6Gov0LWCjHl', '7c727281-f021'],
    ['Cookie: beebo_session=abc.123.def; theme=dark', 'abc.123.def'],
    ['body {"username":"nick","password":"hunter2hunter2"}', 'hunter2hunter2'],
    ['pw in url ?password=hunter2hunter2', 'hunter2hunter2'],
    ['X-Beebo-Media-Token: 999.abcdef', '999.abcdef']
  ]
  for (const [input, secret] of cases) {
    const out = redact(input)
    assert.equal(out.includes(secret), false, `${input} -> ${out}`)
    assert.match(out, /\[redacted\]/)
  }
  assert.equal(redact('scan finished: 12 titles'), 'scan finished: 12 titles')
})

test('console redaction writes to the given streams with optional timestamps, and can be undone', () => {
  const out = []
  const err = []
  const restore = installConsoleRedaction({ timestamps: true, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } })
  console.log('stream', '/file?mt=SECRET1')
  console.warn('warn token=SECRET2')
  console.error(new Error('failed for ?password=SECRET3').message)
  restore()
  assert.equal(out.length, 1)
  assert.match(out[0], /^\d{4}-\d\d-\d\dT.* stream \/file\?mt=\[redacted\]\n$/)
  assert.equal(err.length, 2)
  assert.equal((out.join('') + err.join('')).includes('SECRET'), false)
})

test('self-signed certificate: parses, has the names and addresses, key matches, 825 days', async () => {
  const { certPem, keyPem, notAfter } = await selfSigned.createSelfSigned({ hostname: 'mynas', addresses: ['192.168.1.20', '127.0.0.1'] })
  const cert = new crypto.X509Certificate(certPem)
  assert.equal(cert.checkPrivateKey(crypto.createPrivateKey(keyPem)), true)
  assert.match(cert.subjectAltName, /DNS:mynas/)
  assert.match(cert.subjectAltName, /DNS:localhost/)
  assert.match(cert.subjectAltName, /IP Address:192\.168\.1\.20/)
  assert.equal(cert.ca, false)
  assert.equal(selfSigned.isOurs(certPem), true)
  const days = (notAfter.getTime() - Date.now()) / 86400000
  assert.ok(days > 820 && days < 826)
  assert.match(String(cert.subject), /CN=Beebo server mynas/)
})

test('self-signed certificate: created once, kept while valid, renewed near expiry, foreign certs left alone', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-cert-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const first = await selfSigned.ensureSelfSignedCertificate({ certDir: dir, hostname: 'mynas', addresses: ['127.0.0.1'] })
  assert.equal(first.created, true)
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'key.pem')).mode & 0o077, 0)
  const before = fs.readFileSync(path.join(dir, 'cert.pem'), 'utf8')
  const second = await selfSigned.ensureSelfSignedCertificate({ certDir: dir })
  assert.equal(second.created, false)
  assert.equal(fs.readFileSync(path.join(dir, 'cert.pem'), 'utf8'), before)
  const soon = new Date(Date.now() + 800 * 86400000)
  assert.equal(selfSigned.needsNewCertificate(dir, soon).needed, true)
  const renewed = await selfSigned.ensureSelfSignedCertificate({ certDir: dir, now: soon, hostname: 'mynas', addresses: ['127.0.0.1'] })
  assert.equal(renewed.created, true)

  const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-cert-foreign-'))
  t.after(() => fs.rmSync(foreign, { recursive: true, force: true }))
  const x509 = require('@peculiar/x509')
  x509.cryptoProvider.set(crypto.webcrypto)
  const alg = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' }
  const keys = await crypto.webcrypto.subtle.generateKey(alg, true, ['sign', 'verify'])
  const other = await x509.X509CertificateGenerator.createSelfSigned({ serialNumber: '01', name: 'CN=someone-else', notBefore: new Date(), notAfter: new Date(Date.now() + 86400000), signingAlgorithm: alg, keys })
  fs.writeFileSync(path.join(foreign, 'cert.pem'), other.toString('pem'))
  fs.writeFileSync(path.join(foreign, 'key.pem'), 'placeholder')
  assert.equal(selfSigned.needsNewCertificate(foreign).needed, false)
})
