'use strict'
// ============================================================================
// totp.js - RFC 4226 (HOTP) and RFC 6238 (TOTP), on node:crypto only.
// ----------------------------------------------------------------------------
// What a phone authenticator (Google Authenticator, Aegis, 1Password, Authy...)
// speaks: an HMAC-SHA1 code of six digits that changes every 30 seconds, from a
// shared secret handed over once as a base32 string or an otpauth:// QR code.
//
// This file is pure: no store, no clock of its own (callers pass `time`), so it
// is checked against the RFC test vectors. Two things matter beyond the maths:
//   - verifyTotp compares in constant time and always looks at every step in the
//     window, so how long it takes says nothing about which digit was wrong.
//   - verifyTotp is told the last step that was accepted for this person and
//     refuses anything at or before it (RFC 6238 section 5.2). A code that has
//     been used once, or shoulder-surfed and typed again, does not work twice.
// ============================================================================
const crypto = require('crypto')

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const DEFAULTS = { step: 30, digits: 6, algorithm: 'sha1', window: 1 }
const ALGORITHMS = { sha1: 'SHA1', sha256: 'SHA256', sha512: 'SHA512' }

function base32Encode(buf) {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

// Forgiving on input the way authenticator apps are: spaces, dashes and lower case
// are ignored. Anything else that is not base32 returns null.
function base32Decode(text) {
  const clean = String(text || '').replace(/[\s-]+/g, '').replace(/=+$/, '').toUpperCase()
  if (!clean || !/^[A-Z2-7]+$/.test(clean)) return null
  let bits = 0
  let value = 0
  const out = []
  for (const ch of clean) {
    value = (value << 5) | BASE32.indexOf(ch)
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

// 20 random bytes (160 bits, the RFC 4226 recommendation), as base32.
function generateSecret(bytes = 20) {
  return base32Encode(crypto.randomBytes(bytes))
}

function counterBuffer(counter) {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64BE(BigInt(counter))
  return buf
}

// RFC 4226 section 5.3 dynamic truncation.
function hotp(secret, counter, { digits = DEFAULTS.digits, algorithm = DEFAULTS.algorithm } = {}) {
  const key = Buffer.isBuffer(secret) ? secret : base32Decode(secret)
  if (!key || !key.length) throw new Error('bad_secret')
  const algo = String(algorithm).toLowerCase()
  if (!ALGORITHMS[algo]) throw new Error('bad_algorithm')
  const mac = crypto.createHmac(algo, key).update(counterBuffer(counter)).digest()
  const offset = mac[mac.length - 1] & 0x0f
  const bin =
    ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3]
  return String(bin % Math.pow(10, digits)).padStart(digits, '0')
}

// The time-step counter for a moment: floor(unix seconds / step).
function stepAt(time = Date.now(), step = DEFAULTS.step) {
  return Math.floor(Math.floor(time / 1000) / step)
}

function totp(secret, { time = Date.now(), step = DEFAULTS.step, digits = DEFAULTS.digits, algorithm = DEFAULTS.algorithm } = {}) {
  return hotp(secret, stepAt(time, step), { digits, algorithm })
}

// A typed code, cleaned: only the digits, and only if it is the right length.
function normalizeCode(raw, digits = DEFAULTS.digits) {
  const clean = String(raw == null ? '' : raw).replace(/[\s-]+/g, '')
  return new RegExp('^\\d{' + digits + '}$').test(clean) ? clean : null
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

/**
 * Check a typed code.
 *   window   how many steps either side of now to allow for clock drift (default 1: +-30 s)
 *   lastStep the highest step already accepted for this person; a match at or below it is
 *            a replay and is refused (returned as replay: true so the caller can say so)
 * Returns { ok, step } on success, { ok: false, replay?: true } otherwise.
 */
function verifyTotp(secret, code, { time = Date.now(), window = DEFAULTS.window, lastStep = -1, step = DEFAULTS.step, digits = DEFAULTS.digits, algorithm = DEFAULTS.algorithm } = {}) {
  const clean = normalizeCode(code, digits)
  if (clean === null) return { ok: false }
  let key = Buffer.isBuffer(secret) ? secret : base32Decode(secret)
  if (!key || !key.length) return { ok: false }
  const now = stepAt(time, step)
  let matched = -1
  let replay = false
  // No early exit: every step in the window is computed and compared.
  for (let i = -window; i <= window; i++) {
    const s = now + i
    if (s < 0) continue
    const expect = hotp(key, s, { digits, algorithm })
    if (safeEqual(expect, clean)) {
      if (s > lastStep) {
        if (s > matched) matched = s
      } else {
        replay = true
      }
    }
  }
  if (matched >= 0) return { ok: true, step: matched }
  return replay ? { ok: false, replay: true } : { ok: false }
}

// The otpauth:// URI a QR code carries (Google Authenticator "Key URI Format").
// The label is "Issuer:account" and issuer is repeated as a parameter, which is
// what every current app expects. Non-default algorithm/digits/period are written
// out, the defaults are left off so the QR stays small and scans reliably.
function otpauthUri({ secret, account, issuer = 'Beebo Entertainment', digits = DEFAULTS.digits, period = DEFAULTS.step, algorithm = DEFAULTS.algorithm } = {}) {
  const label = encodeURIComponent(issuer) + ':' + encodeURIComponent(String(account || 'account'))
  const params = ['secret=' + String(secret).replace(/[\s=-]+/g, '').toUpperCase(), 'issuer=' + encodeURIComponent(issuer)]
  if (String(algorithm).toLowerCase() !== DEFAULTS.algorithm) params.push('algorithm=' + ALGORITHMS[String(algorithm).toLowerCase()])
  if (digits !== DEFAULTS.digits) params.push('digits=' + digits)
  if (period !== DEFAULTS.step) params.push('period=' + period)
  return 'otpauth://totp/' + label + '?' + params.join('&')
}

module.exports = {
  base32Encode, base32Decode, generateSecret, hotp, totp, stepAt, normalizeCode, verifyTotp, otpauthUri, safeEqual, DEFAULTS
}
