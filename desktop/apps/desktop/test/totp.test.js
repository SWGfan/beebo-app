// RFC 4226 / RFC 6238 authenticator codes: published test vectors, clock drift, replay, and the
// otpauth:// URI a QR code carries.
// Run: node --test test/totp.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const totp = require(path.join(__dirname, '..', 'electron', 'totp.js'))

const SHA1_KEY = Buffer.from('12345678901234567890')
const SHA256_KEY = Buffer.from('12345678901234567890123456789012')
const SHA512_KEY = Buffer.from('1234567890123456789012345678901234567890123456789012345678901234')

test('RFC 4226 appendix D: the HOTP values for counters 0-9', () => {
  const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489']
  expected.forEach((code, counter) => assert.equal(totp.hotp(SHA1_KEY, counter), code))
})

test('RFC 6238 appendix B: the SHA-1, SHA-256 and SHA-512 vectors (8 digits)', () => {
  const vectors = [
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826']
  ]
  for (const [seconds, sha1, sha256, sha512] of vectors) {
    const time = seconds * 1000
    assert.equal(totp.totp(SHA1_KEY, { time, digits: 8, algorithm: 'sha1' }), sha1, `sha1 @${seconds}`)
    assert.equal(totp.totp(SHA256_KEY, { time, digits: 8, algorithm: 'sha256' }), sha256, `sha256 @${seconds}`)
    assert.equal(totp.totp(SHA512_KEY, { time, digits: 8, algorithm: 'sha512' }), sha512, `sha512 @${seconds}`)
  }
})

test('base32 round-trips and forgives the spacing and case authenticator apps show', () => {
  for (let len = 1; len <= 40; len++) {
    const buf = Buffer.from(Array.from({ length: len }, (_, i) => (i * 37 + len) & 255))
    assert.deepEqual(totp.base32Decode(totp.base32Encode(buf)), buf)
  }
  assert.equal(totp.base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI')
  assert.deepEqual(totp.base32Decode('mzxw 6ytb-oi=='), Buffer.from('foobar'))
  assert.equal(totp.base32Decode('not*base32'), null)
  assert.equal(totp.base32Decode(''), null)
  const secret = totp.generateSecret()
  assert.match(secret, /^[A-Z2-7]{32}$/, '160 bits of randomness')
  assert.notEqual(secret, totp.generateSecret())
})

test('verifyTotp accepts the current step and one step of clock drift either way, no more', () => {
  const secret = totp.generateSecret()
  const now = 1700000000000
  const at = (offsetSteps) => totp.totp(secret, { time: now + offsetSteps * 30000 })
  assert.deepEqual(totp.verifyTotp(secret, at(0), { time: now }), { ok: true, step: totp.stepAt(now) })
  assert.equal(totp.verifyTotp(secret, at(-1), { time: now }).ok, true)
  assert.equal(totp.verifyTotp(secret, at(1), { time: now }).ok, true)
  assert.equal(totp.verifyTotp(secret, at(-2), { time: now }).ok, false)
  assert.equal(totp.verifyTotp(secret, at(2), { time: now }).ok, false)
  assert.equal(totp.verifyTotp(secret, at(2), { time: now, window: 2 }).ok, true)
})

test('a code cannot be used twice: anything at or before lastStep is a replay (RFC 6238 5.2)', () => {
  const secret = totp.generateSecret()
  const now = 1700000000000
  const code = totp.totp(secret, { time: now })
  const first = totp.verifyTotp(secret, code, { time: now })
  assert.equal(first.ok, true)
  const again = totp.verifyTotp(secret, code, { time: now, lastStep: first.step })
  assert.deepEqual(again, { ok: false, replay: true })
  // Even a moment later, inside the drift window.
  assert.equal(totp.verifyTotp(secret, code, { time: now + 20000, lastStep: first.step }).ok, false)
  // An OLDER step's code is refused once a newer one was accepted.
  const older = totp.totp(secret, { time: now - 30000 })
  assert.equal(totp.verifyTotp(secret, older, { time: now, lastStep: first.step }).ok, false)
  // The next step's code is fine.
  assert.equal(totp.verifyTotp(secret, totp.totp(secret, { time: now + 30000 }), { time: now + 30000, lastStep: first.step }).ok, true)
})

test('malformed codes are refused without throwing, and typed spacing is ignored', () => {
  const secret = totp.generateSecret()
  const now = 1700000000000
  const code = totp.totp(secret, { time: now })
  for (const bad of ['', null, undefined, '12345', '1234567', 'abcdef', '12 34 5x', {}, [], '000000\n000000']) {
    assert.equal(totp.verifyTotp(secret, bad, { time: now }).ok, false)
  }
  assert.equal(totp.verifyTotp(secret, code.slice(0, 3) + ' ' + code.slice(3), { time: now }).ok, true)
  assert.equal(totp.verifyTotp('not*a*secret', code, { time: now }).ok, false)
})

test('comparison is constant-time: timingSafeEqual for every step, and no early exit on a match', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'electron', 'totp.js'), 'utf8')
  assert.match(source, /crypto\.timingSafeEqual/)
  // The window loop never breaks or returns early.
  const loop = source.slice(source.indexOf('for (let i = -window'), source.indexOf('if (matched >= 0)'))
  assert.doesNotMatch(loop, /\b(break|return)\b/)
  assert.equal(totp.safeEqual('123456', '12345'), false, 'different lengths are unequal, not an exception')
  assert.equal(totp.safeEqual('123456', '123456'), true)
})

test('otpauth URI: label, secret, issuer; defaults left off', () => {
  const uri = totp.otpauthUri({ secret: 'jbsw y3dp ehpk 3pxp', account: 'nick@home', issuer: 'Beebo Entertainment' })
  assert.equal(uri, 'otpauth://totp/Beebo%20Entertainment:nick%40home?secret=JBSWY3DPEHPK3PXP&issuer=Beebo%20Entertainment')
  const custom = totp.otpauthUri({ secret: 'JBSWY3DPEHPK3PXP', account: 'a', digits: 8, period: 60, algorithm: 'sha256' })
  assert.match(custom, /algorithm=SHA256/)
  assert.match(custom, /digits=8/)
  assert.match(custom, /period=60/)
})
