'use strict'
// ============================================================================
// passwordPolicy.js - is this a password worth accepting?
// ----------------------------------------------------------------------------
// Offline only. Two jobs:
//   1. Refuse the passwords that are guessed first: too short, on the bundled
//      list of the most-breached passwords (commonPasswords.js, checked with the
//      usual tweaks so "Password1!" and "p4ssw0rd" do not sneak through), a run
//      of one character or an obvious keyboard/number sequence, or the person's
//      own username.
//   2. Give a plain 0-4 strength and a hint for the meter next to the box.
// No network request is ever made; nothing typed here leaves the computer.
// ============================================================================
const { COMMON_PASSWORD_SET } = require('./commonPasswords')

const MIN_LENGTH = 8
const MAX_LENGTH = 256
// Past this a password is long enough that a dictionary word inside it is not the
// weak point ("purple-elephant-password-tuesday" is fine).
const PASSPHRASE_LENGTH = 16

const LEET = { '@': 'a', '4': 'a', '8': 'b', '3': 'e', '6': 'g', '9': 'g', '1': 'l', '!': 'i', '0': 'o', '$': 's', '5': 's', '7': 't', '+': 't' }
const SEQUENCES = ['abcdefghijklmnopqrstuvwxyz', '0123456789', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1qaz2wsx3edc']

function deleet(s) {
  return s.replace(/[@4836915!0$57+]/g, (c) => LEET[c] || c)
}

// The forms of a password that are looked up: as typed, with look-alike symbols
// turned back into letters, and with a trailing run of digits/symbols and one
// leading capital removed.
function lookupForms(password) {
  const lower = String(password).toLowerCase()
  const forms = new Set([lower, deleet(lower)])
  for (const f of [...forms]) {
    const trimmed = f.replace(/[\d!@#$%^&*._-]+$/, '')
    if (trimmed.length >= 3) forms.add(trimmed)
    const both = trimmed.replace(/^[\d!@#$%^&*._-]+/, '')
    if (both.length >= 3) forms.add(both)
  }
  return forms
}

function isBreached(password) {
  const raw = String(password || '')
  if (!raw) return false
  const forms = lookupForms(raw)
  if (raw.length >= PASSPHRASE_LENGTH) {
    // Only the whole password matters once it is long.
    return COMMON_PASSWORD_SET.has(raw.toLowerCase())
  }
  for (const f of forms) if (COMMON_PASSWORD_SET.has(f)) return true
  return false
}

function isRunOfOne(s) {
  return s.length >= 4 && new Set(s.toLowerCase()).size === 1
}

function isSequence(s) {
  const lower = s.toLowerCase()
  if (lower.length < 6) return false
  for (const seq of SEQUENCES) {
    const rev = [...seq].reverse().join('')
    if (seq.includes(lower) || rev.includes(lower)) return true
  }
  return false
}

// Rough guess-space estimate in bits: pool size for the character classes used, times
// length, with deductions for repeats and for a short dictionary-ish password. It is a
// meter, not a proof; the hard refusals above are what actually block a password.
function estimateBits(password) {
  const s = String(password)
  let pool = 0
  if (/[a-z]/.test(s)) pool += 26
  if (/[A-Z]/.test(s)) pool += 26
  if (/\d/.test(s)) pool += 10
  if (/[^A-Za-z0-9]/.test(s)) pool += 32
  if (!pool) return 0
  const distinct = new Set(s).size
  const effectiveLength = Math.min(s.length, distinct * 2 + 2)
  return effectiveLength * Math.log2(pool)
}

const LABELS = ['Too weak', 'Weak', 'Fair', 'Good', 'Strong']

/**
 * checkPassword(password, { username, name, email, minLength })
 *   -> { ok, score (0-4), label, breached, issues: [{ code, message }], suggestions: [] }
 * ok is false only for the hard refusals; a mediocre-but-allowed password is ok with a low score.
 */
function checkPassword(password, { username, name, email, minLength = MIN_LENGTH } = {}) {
  const pw = typeof password === 'string' ? password : ''
  const issues = []
  const suggestions = []
  if (pw.length < minLength) issues.push({ code: 'too_short', message: `Password must be at least ${minLength} characters.` })
  if (pw.length > MAX_LENGTH) issues.push({ code: 'too_long', message: `Password must be at most ${MAX_LENGTH} characters.` })
  let breached = false
  if (pw.length >= 1 && pw.length <= MAX_LENGTH) {
    if (isBreached(pw)) {
      breached = true
      issues.push({ code: 'breached', message: 'That password is on the list of most commonly used passwords, so it is guessed first. Choose something else.' })
    } else if (isRunOfOne(pw) || isSequence(pw)) {
      breached = true
      issues.push({ code: 'pattern', message: 'That is a repeated character or an obvious sequence. Choose something less predictable.' })
    }
  }
  const personal = [username, name, String(email || '').split('@')[0]]
    .map((v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, ''))
    .filter((v) => v.length >= 3)
  const flat = pw.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (personal.some((v) => flat === v || (pw.length < PASSPHRASE_LENGTH && flat.includes(v)))) {
    issues.push({ code: 'personal', message: 'Do not use your name or username in your password.' })
  }
  const bits = estimateBits(pw)
  let score = bits >= 90 ? 4 : bits >= 60 ? 3 : bits >= 40 ? 2 : bits >= 28 ? 1 : 0
  if (pw.length >= PASSPHRASE_LENGTH + 4 && new Set(pw).size >= 8) score = Math.max(score, 3)
  if (issues.length) score = Math.min(score, 1)
  if (pw.length < 12) suggestions.push('Use 12 or more characters; a few unrelated words in a row makes a strong, easy-to-remember password.')
  if (!issues.length && score <= 2) suggestions.push('Add more length or a few more unrelated words.')
  return { ok: issues.length === 0, score, label: LABELS[score], breached, issues, suggestions, minLength }
}

// The one-line refusal a form or API answer shows, or null when the password is fine.
function refusal(password, ctx) {
  const r = checkPassword(password, ctx)
  return r.ok ? null : r.issues[0].message
}

module.exports = { checkPassword, refusal, isBreached, estimateBits, MIN_LENGTH, MAX_LENGTH, PASSPHRASE_LENGTH, LABELS }
