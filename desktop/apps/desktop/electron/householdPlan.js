'use strict'

// Household people and storage-computer licences are separate limits. This
// module counts only local account records; it never edits or revokes them.
//
// The base cap is 6 (owner + 5). A household can raise it by buying extra
// seats (CA$1/month each, worker/seatAddon.js), up to MAX_EXTRA_SEATS more —
// see docs/GOOGLE-PLAY-BILLING-AND-SEAT-ADDON.md. The seat count reaches this
// module the same way `plan` already does: as a field in the Worker's signed
// licence token (never a locally-editable fact) — license.js's acceptToken()
// copies it to store.get('license.seats') right next to 'license.plan', and
// that's the ONLY place extraSeats() reads it from. A device that has never
// seen a token with a `seats` field (an old Worker reply, or no licence at
// all) gets 0 extra seats, exactly as it already gets the base 'beebo-standard'
// plan when `license.plan` is unset.
const BASE_MAX_MEMBERS = 6
const MAX_EXTRA_SEATS = 6
const MAX_MEMBERS = BASE_MAX_MEMBERS // kept for compatibility: "the base cap specifically"
const INACTIVE_STATUSES = new Set(['revoked', 'denied', 'deleted'])

function extraSeats(store) {
  const n = Number(store.get('license.seats'))
  return Number.isFinite(n) && n > 0 ? Math.min(MAX_EXTRA_SEATS, Math.floor(n)) : 0
}
function maxMembers(store) {
  return BASE_MAX_MEMBERS + extraSeats(store)
}
function fullMessage(limit) {
  return `This household has reached its limit of ${limit} people, including the owner. Pending invitations and unverified signups also use a place. Remove or revoke an unused member before adding another person.`
}
// Kept as a plain string too (the base-cap message), for any caller that
// still imports the constant directly rather than calling admission().
const FULL_MESSAGE = fullMessage(BASE_MAX_MEMBERS)

function occupiesPlace(user) {
  return !!(user && typeof user === 'object' && !INACTIVE_STATUSES.has(String(user.status || 'approved').toLowerCase()))
}

function members(store) {
  const value = store.get('authUsers')
  return Array.isArray(value) ? value.filter(user => user && typeof user === 'object') : []
}

function capacity(store) {
  const users = members(store)
  const occupied = users.filter(occupiesPlace)
  const approved = occupied.filter(user => !user.status || user.status === 'approved').length
  const limit = maxMembers(store)
  return {
    limit,
    used: occupied.length,
    approved,
    pending: occupied.length - approved,
    available: Math.max(0, limit - occupied.length),
    full: occupied.length >= limit,
    overLimit: occupied.length > limit,
    includesOwner: true
  }
}

function admission(store, { userId = null } = {}) {
  const existing = userId ? members(store).find(user => user.id === userId) : null
  // Approving a reserved signup or retrying an already-active account uses its
  // existing place, including legacy households that already exceed the cap.
  if (existing && occupiesPlace(existing)) return { ok: true }
  const cap = capacity(store)
  if (!cap.full) return { ok: true }
  return { ok: false, error: 'household_full', message: fullMessage(cap.limit) }
}

module.exports = { MAX_MEMBERS, BASE_MAX_MEMBERS, MAX_EXTRA_SEATS, FULL_MESSAGE, extraSeats, maxMembers, occupiesPlace, capacity, admission }
