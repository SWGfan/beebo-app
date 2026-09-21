'use strict'
// Beebo license token — a compact, offline-verifiable, tamper-proof credential.
//
// Format:  base64url(payloadJSON) + "." + base64url(ed25519 signature)
// The signature covers the exact payload bytes, so a customer cannot change any
// field (expiry, plan, device) without invalidating it. The app ships ONLY the
// public key and can verify entirely offline; the private key lives as a secret
// in the licensing backend and never leaves it.
//
// This module is the Node build, used by the Electron desktop app (to verify)
// and by the key-generator CLI (to sign). The Cloudflare Worker signs with an
// equivalent WebCrypto routine that produces byte-identical tokens.

const crypto = require('crypto')

const TOKEN_VERSION = 1

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function b64urlDecode(str) {
  str = String(str).replace(/-/g, '+').replace(/_/g, '/')
  while (str.length % 4) str += '='
  return Buffer.from(str, 'base64')
}

// --- signing (backend / key-gen tool only) ---
function signToken(payload, privateKeyPem) {
  const body = { v: TOKEN_VERSION, ...payload }
  const payloadBytes = Buffer.from(JSON.stringify(body), 'utf8')
  const sig = crypto.sign(null, payloadBytes, privateKeyPem) // ed25519: algorithm is null
  return b64urlEncode(payloadBytes) + '.' + b64urlEncode(sig)
}

// --- verification (client) ---
// Returns { valid, payload, reason }. `valid` means the SIGNATURE is authentic
// and the structure is sane; it does NOT by itself mean the license is active
// (call evaluateLicense for that).
function verifyToken(token, publicKeyPem) {
  try {
    if (typeof token !== 'string' || token.indexOf('.') < 0) {
      return { valid: false, reason: 'malformed' }
    }
    const [payloadPart, sigPart] = token.split('.')
    if (!payloadPart || !sigPart) return { valid: false, reason: 'malformed' }
    const payloadBytes = b64urlDecode(payloadPart)
    const sig = b64urlDecode(sigPart)
    const ok = crypto.verify(null, payloadBytes, publicKeyPem, sig)
    if (!ok) return { valid: false, reason: 'bad_signature' }
    const payload = JSON.parse(payloadBytes.toString('utf8'))
    if (payload.v !== TOKEN_VERSION) return { valid: false, reason: 'version' }
    return { valid: true, payload }
  } catch (e) {
    return { valid: false, reason: 'error:' + (e && e.message) }
  }
}

// --- enforcement logic ---
// Given a verified payload, decide what the app should do right now. `expiresAt`
// is the HARD lock time and already includes the offline-grace buffer that the
// backend baked in, so a paying customer whose renewal is briefly unreachable
// keeps working. deviceId binding stops one activation being copied to many PCs.
//
// state:
//   'active'  -> serve normally
//   'grace'   -> serve normally, but should renew soon (inside renew window)
//   'expired' -> lock: token past its hard expiry
//   'wrong_device' -> lock: token was issued for a different install
//   'invalid' -> lock: no/blank payload
function evaluateLicense(payload, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Math.floor(Date.now() / 1000)
  const deviceId = opts.deviceId
  if (!payload || typeof payload !== 'object') {
    return { state: 'invalid', serve: false, reason: 'no_payload' }
  }
  if (deviceId && payload.deviceId && payload.deviceId !== deviceId) {
    return { state: 'wrong_device', serve: false, reason: 'device_mismatch' }
  }
  const expiresAt = Number(payload.expiresAt) || 0
  if (now >= expiresAt) {
    return { state: 'expired', serve: false, reason: 'past_expiry', expiresAt }
  }
  // Renew window: try to refresh once inside the final `renewWindowDays` (or the
  // last third of the token's life, whichever is larger).
  const issuedAt = Number(payload.issuedAt) || (expiresAt - 30 * 86400)
  const life = Math.max(1, expiresAt - issuedAt)
  const renewWindow = Math.max((Number(payload.renewWindowDays) || 0) * 86400, life / 3)
  const shouldRenew = now >= expiresAt - renewWindow
  return {
    state: shouldRenew ? 'grace' : 'active',
    serve: true,
    shouldRenew,
    expiresAt,
    type: payload.type,
    plan: payload.plan,
  }
}

module.exports = {
  TOKEN_VERSION,
  b64urlEncode,
  b64urlDecode,
  signToken,
  verifyToken,
  evaluateLicense,
}
