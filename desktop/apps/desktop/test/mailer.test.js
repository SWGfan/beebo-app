// Pins electron/mailer.js against the installed nodemailer major (10.x). The mailer wraps
// nodemailer in a try/require, so a nodemailer that failed to load would silently turn
// every alert email into "not_configured" - these tests make that loud.
const test = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const path = require('node:path')

const nodemailer = require('nodemailer')
const mailerPath = path.join(__dirname, '..', 'electron', 'mailer.js')

function fakeStore(initial = {}) {
  const data = { ...initial }
  return {
    get: (k) => data[k],
    set: (k, v) => { data[k] = v },
    data
  }
}

test('nodemailer loads as a CommonJS module with createTransport', () => {
  assert.equal(typeof nodemailer.createTransport, 'function')
  const major = Number(require('nodemailer/package.json').version.split('.')[0])
  assert.ok(major >= 9, 'nodemailer must be 9.1+ (older majors carry known advisories); got ' + major)
})

test('mailer.isConfigured: true only with both address and app password', () => {
  const mailer = require(mailerPath)
  assert.equal(mailer.isConfigured(fakeStore()), false)
  assert.equal(mailer.isConfigured(fakeStore({ emailUser: 'a@example.test' })), false)
  assert.equal(mailer.isConfigured(fakeStore({ emailUser: 'a@example.test', emailAppPassword: 'pw' })), true)
})

test('mailer.sendMail without a configured account logs not_configured and never opens a transport', async () => {
  const mailer = require(mailerPath)
  const store = fakeStore()
  const real = nodemailer.createTransport
  let created = 0
  nodemailer.createTransport = () => { created++; return {} }
  try {
    const res = await mailer.sendMail(store, { to: 'x@example.test', subject: 's', text: 't' })
    assert.deepEqual(res, { ok: false, error: 'not_configured' })
  } finally {
    nodemailer.createTransport = real
  }
  assert.equal(created, 0)
  const log = mailer.getEmailLog(store)
  assert.equal(log.length, 1)
  assert.equal(log[0].ok, false)
  assert.equal(log[0].error, 'not_configured')
})

test('mailer.sendMail uses the gmail service transport with the stored credentials and logs success/failure', async () => {
  const mailer = require(mailerPath)
  const store = fakeStore({ emailUser: 'owner@example.test', emailAppPassword: 'app-pass' })
  const real = nodemailer.createTransport
  const seen = { options: null, mail: null }
  let failNext = false
  nodemailer.createTransport = (options) => {
    seen.options = options
    return { sendMail: async (mail) => { seen.mail = mail; if (failNext) throw new Error('boom'); return {} } }
  }
  try {
    const ok = await mailer.sendMail(store, { to: 'to@example.test', subject: 'Hello', text: 'Body' })
    assert.deepEqual(ok, { ok: true })
    assert.deepEqual(seen.options, { service: 'gmail', auth: { user: 'owner@example.test', pass: 'app-pass' } })
    assert.deepEqual(seen.mail, { from: 'owner@example.test', to: 'to@example.test', subject: 'Hello', text: 'Body' })

    failNext = true
    const bad = await mailer.sendMail(store, { to: 'to@example.test', subject: 'Hello 2', text: 'Body' })
    assert.equal(bad.ok, false)
    assert.match(bad.error, /boom/)
  } finally {
    nodemailer.createTransport = real
  }
  const log = mailer.getEmailLog(store)
  assert.equal(log.length, 2)
  assert.equal(log[0].ok, false) // newest first
  assert.equal(log[1].ok, true)
})

test('the real createTransport({service:"gmail", auth}) constructs without throwing', () => {
  const t = nodemailer.createTransport({ service: 'gmail', auth: { user: 'a@example.test', pass: 'pw' } })
  assert.equal(typeof t.sendMail, 'function')
  if (typeof t.close === 'function') t.close()
})

// A real SMTP round trip through the installed nodemailer to a throwaway local server,
// proving message composition (from/to/subject/text) still works on this Node.
test('real nodemailer delivers from/to/subject/text to a local SMTP server', async () => {
  let received = ''
  const server = net.createServer((sock) => {
    let inData = false
    sock.setEncoding('utf8')
    sock.write('220 localhost ESMTP fake\r\n')
    let buf = ''
    sock.on('data', (chunk) => {
      buf += chunk
      let idx
      while ((idx = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        if (inData) {
          if (line === '.') { inData = false; sock.write('250 OK queued\r\n') } else { received += line + '\n' }
          continue
        }
        const cmd = line.toUpperCase()
        if (cmd.startsWith('EHLO')) sock.write('250-localhost\r\n250 8BITMIME\r\n')
        else if (cmd.startsWith('HELO')) sock.write('250 localhost\r\n')
        else if (cmd.startsWith('MAIL FROM') || cmd.startsWith('RCPT TO')) sock.write('250 OK\r\n')
        else if (cmd === 'DATA') { inData = true; sock.write('354 go ahead\r\n') }
        else if (cmd === 'QUIT') { sock.write('221 bye\r\n'); sock.end() }
        else sock.write('250 OK\r\n')
      }
    })
    sock.on('error', () => {})
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const t = nodemailer.createTransport({ host: '127.0.0.1', port: server.address().port, secure: false, ignoreTLS: true })
    const info = await t.sendMail({ from: 'owner@example.test', to: 'to@example.test', subject: 'Alert subject', text: 'Alert body line' })
    assert.ok(info.accepted.includes('to@example.test'))
    t.close()
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
  assert.match(received, /^From: .*owner@example\.test/m)
  assert.match(received, /^To: .*to@example\.test/m)
  assert.match(received, /^Subject: Alert subject/m)
  assert.match(received, /Alert body line/)
})
