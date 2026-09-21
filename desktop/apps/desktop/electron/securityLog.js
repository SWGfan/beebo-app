'use strict'
// ============================================================================
// securityLog.js - the owner's record of account-security events.
// ----------------------------------------------------------------------------
// Sign-ins that worked and failed, lockouts, two-factor being turned on / off / used,
// recovery codes spent, password resets issued and used, sessions revoked, policy changes.
// Shown in the desktop app (Users -> Security).
//
// What is NEVER written here, by construction and again by the redactor:
//   - passwords, codes, reset codes, recovery codes, tokens or cookies (callers only pass
//     event names and ids; free text goes through logRedact.redact);
//   - a username that does not belong to a real account. Somebody who pastes their
//     password into the username box would otherwise have it saved in plain text. Failed
//     attempts against unknown names are recorded as "(unknown name)".
//   - a full public IP address: the last IPv4 octet (or the last 80 bits of IPv6) is
//     zeroed, so the owner can tell "same network" without the log becoming a map of
//     other people's addresses. Addresses inside the home network are kept whole.
//
// Storage is the same approach as the failed-login counters in auth.js: an in-memory
// list per store, written to config.json at most every FLUSH_MS (a failed-login flood must
// not rewrite the whole settings file per attempt), and by flush() when the app quits.
// ============================================================================
const crypto = require('crypto')
const { redact } = require('./logRedact')

const KEY = 'securityEvents'
const MAX_EVENTS = 500
const FLUSH_MS = 4000
const MAX_DETAIL = 200

// type -> { label, severity }
const TYPES = {
  login_success: { label: 'Signed in', severity: 'info' },
  login_failed: { label: 'Sign-in failed', severity: 'warn' },
  login_locked: { label: 'Sign-in locked out', severity: 'alert' },
  two_factor_required: { label: 'Password accepted, waiting for second step', severity: 'info' },
  two_factor_success: { label: 'Two-factor code accepted', severity: 'info' },
  two_factor_failed: { label: 'Wrong two-factor code', severity: 'warn' },
  two_factor_replay: { label: 'Two-factor code reused', severity: 'alert' },
  two_factor_locked: { label: 'Two-factor locked after too many wrong codes', severity: 'alert' },
  two_factor_unlocked: { label: 'Two-factor lock cleared by the owner', severity: 'info' },
  two_factor_enabled: { label: 'Two-factor turned on', severity: 'info' },
  two_factor_disabled: { label: 'Two-factor turned off', severity: 'warn' },
  two_factor_disabled_by_owner: { label: 'Two-factor turned off by the owner', severity: 'warn' },
  recovery_code_used: { label: 'Recovery code used to sign in', severity: 'warn' },
  recovery_codes_regenerated: { label: 'New recovery codes made', severity: 'info' },
  two_factor_setup_required: { label: 'Admin without two-factor held at setup (owner policy)', severity: 'info' },
  password_changed: { label: 'Password changed', severity: 'info' },
  password_reset_requested: { label: 'Password reset link requested', severity: 'info' },
  password_reset_code_issued: { label: 'Owner made a one-time reset code', severity: 'info' },
  password_reset_completed: { label: 'Password reset finished', severity: 'warn' },
  password_reset_failed: { label: 'Password reset code refused', severity: 'warn' },
  password_reset_locked: { label: 'Password reset locked after wrong codes', severity: 'alert' },
  session_revoked: { label: 'A device was signed out', severity: 'info' },
  sessions_revoked_all: { label: 'Signed out everywhere', severity: 'info' },
  policy_changed: { label: 'Security policy changed', severity: 'info' }
}

// Events that repeat by the hundred under attack; identical ones within a minute are counted, not listed.
const NOISY = new Set(['login_failed', 'login_locked', 'two_factor_failed', 'two_factor_replay', 'password_reset_failed'])
const COALESCE_MS = 60 * 1000

const states = new WeakMap()

function stateFor(store) {
  let st = states.get(store)
  if (st) return st
  let events = []
  try {
    const saved = store.get(KEY)
    if (Array.isArray(saved)) events = saved.filter((e) => e && typeof e === 'object').slice(0, MAX_EVENTS)
  } catch {}
  st = { events, dirty: false, timer: null }
  states.set(store, st)
  return st
}

function isPrivateV4(a, b) {
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)
}

/** 203.0.113.42 -> 203.0.113.0 ; home-network and loopback addresses are kept whole. */
function maskIp(ip) {
  const raw = String(ip || '').replace(/^::ffff:/i, '').trim()
  if (!raw) return null
  const v4 = raw.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const n = v4.slice(1).map(Number)
    if (n.some((x) => x > 255)) return null
    return isPrivateV4(n[0], n[1]) ? raw : `${n[0]}.${n[1]}.${n[2]}.0`
  }
  const lower = raw.toLowerCase()
  if (lower === '::1' || /^(fe80|fc|fd)/.test(lower)) return lower.slice(0, 45)
  if (/^[0-9a-f:]+$/.test(lower) && lower.includes(':')) {
    const groups = lower.split(':').slice(0, 3).filter(Boolean)
    return groups.join(':') + '::'
  }
  return null
}

function flush(store) {
  const st = states.get(store)
  if (!st) return false
  if (st.timer) {
    clearTimeout(st.timer)
    st.timer = null
  }
  if (!st.dirty) return false
  st.dirty = false
  store.set(KEY, st.events)
  return true
}

function schedule(store, st) {
  st.dirty = true
  if (st.timer) return
  st.timer = setTimeout(() => {
    st.timer = null
    try { flush(store) } catch {}
  }, FLUSH_MS)
  if (typeof st.timer.unref === 'function') st.timer.unref()
}

/**
 * record(store, { type, userId, username, ip, detail, known })
 *   username is kept only when `known` is true (the caller has matched it to a real account).
 * Never throws: a logging problem must not break a sign-in.
 */
function record(store, { type, userId, username, ip, detail, known } = {}) {
  try {
    const meta = TYPES[type]
    if (!meta) return null
    const st = stateFor(store)
    const evt = {
      id: crypto.randomBytes(6).toString('hex'),
      time: Date.now(),
      type,
      severity: meta.severity,
      userId: userId ? String(userId).slice(0, 80) : null,
      username: known && username ? String(username).slice(0, 40) : null,
      ip: maskIp(ip),
      detail: detail ? redact(String(detail)).replace(/\s+/g, ' ').slice(0, MAX_DETAIL) : null
    }
    // A flood of the same noisy event (a guesser hammering one name from one address) is one line with a
    // count, so it cannot push every other event out of the 500 kept.
    if (NOISY.has(type)) {
      const prev = st.events.find((e) => e.type === type && evt.time - e.time < COALESCE_MS && e.userId === evt.userId && e.username === evt.username && e.ip === evt.ip)
      if (prev) {
        prev.count = (prev.count || 1) + 1
        prev.time = evt.time
        st.events.sort((a, b) => b.time - a.time)
        schedule(store, st)
        return prev
      }
    }
    st.events.unshift(evt)
    if (st.events.length > MAX_EVENTS) st.events.length = MAX_EVENTS
    schedule(store, st)
    return evt
  } catch {
    return null
  }
}

/** Newest first. Filters: type, userId, severity, since (ms), limit (default 200). */
function list(store, { type, userId, severity, since, limit = 200 } = {}) {
  const st = stateFor(store)
  const cap = Math.max(1, Math.min(MAX_EVENTS, Number(limit) || 200))
  const out = []
  for (const e of st.events) {
    if (type && e.type !== type) continue
    if (userId && e.userId !== userId) continue
    if (severity && e.severity !== severity) continue
    if (since && e.time < since) continue
    out.push({ ...e, label: (TYPES[e.type] && TYPES[e.type].label) || e.type })
    if (out.length >= cap) break
  }
  return out
}

function clear(store) {
  const st = stateFor(store)
  st.events = []
  st.dirty = false
  if (st.timer) {
    clearTimeout(st.timer)
    st.timer = null
  }
  store.set(KEY, [])
}

module.exports = { record, list, clear, flush, maskIp, TYPES, MAX_EVENTS }
