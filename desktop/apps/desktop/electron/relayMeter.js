'use strict';
// ============================================================================
// relayMeter.js — this PC's monthly count of data that went through a relay.
// ----------------------------------------------------------------------------
// The host agent measures (see "Relay metering" in beebo-rtc-host.js) and sends
// billable byte counts per provider; this module keeps the monthly totals in
// the app store so they survive restarts, and starts a new month at the
// customer's billing-month boundary.
//
// Month: from 00:00 UTC on the reset day (1-28, default 1 = calendar month in
// UTC, which is how Cloudflare's free allowance runs) to the same moment next
// month. Days 29-31 are refused: not every month has them.
//
// Units are decimal gigabytes (1 GB = 1e9 bytes), what TURN providers bill in.
// ============================================================================

const GB = 1e9;
const PROVIDERS = ['cloudflare', 'beebo', 'custom'];
const STORE_KEY = 'relayUsage';

function clampResetDay(d) {
  const n = Math.floor(Number(d));
  return n >= 1 && n <= 28 ? n : 1;
}

const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

// The billing month containing `nowMs`.
function periodFor(nowMs, resetDay = 1) {
  const day = clampResetDay(resetDay);
  const d = new Date(nowMs);
  let y = d.getUTCFullYear(), m = d.getUTCMonth();
  if (d.getUTCDate() < day) { m -= 1; if (m < 0) { m = 11; y -= 1; } }
  const start = Date.UTC(y, m, day);
  const end = Date.UTC(m === 11 ? y + 1 : y, m === 11 ? 0 : m + 1, day);
  return { key: ymd(start), start, end, resetDay: day };
}

function emptyBytes() { return { cloudflare: 0, beebo: 0, custom: 0 }; }

function freshState(nowMs, resetDay) {
  const p = periodFor(nowMs, resetDay);
  return {
    periodKey: p.key,
    periodStart: p.start,
    periodEnd: p.end,
    resetDay: p.resetDay,
    bytes: emptyBytes(),
    // Higher figures from elsewhere, preferred when larger than ours:
    // cloudflare = Cloudflare's own analytics; beebo = Beebo Relay's meter.
    reported: { cloudflare: null, beebo: null },
    // Switch-over state for "Cloudflare first, then Beebo Relay" (relayPolicy.js).
    policy: { onBeebo: false, switchedAt: 0, payingCloudflareSince: 0, lastUnavailableNoticeAt: 0 },
    updatedAt: nowMs,
  };
}

// A saved state, repaired, and rolled over when its month has ended (or the
// reset day was changed). The finished month is kept once, as `previous`.
function normalize(saved, nowMs, resetDay) {
  const day = clampResetDay(resetDay);
  const p = periodFor(nowMs, day);
  const base = freshState(nowMs, day);
  if (!saved || typeof saved !== 'object' || !saved.periodKey) return base;
  const savedEnd = Number(saved.periodEnd) || 0;
  const sameMonth = saved.periodKey === p.key && clampResetDay(saved.resetDay) === day;
  // The owner moved the reset day while the counted month is still running: the
  // count can't be split by date, so it carries into the new month (over-counts
  // at worst, never under).
  const movedResetDay = clampResetDay(saved.resetDay) !== day && nowMs < savedEnd && Number(saved.periodStart) < p.end && savedEnd > p.start;
  if (sameMonth || movedResetDay) {
    const s = Object.assign(base, saved, { periodKey: p.key, periodStart: p.start, periodEnd: p.end, resetDay: day });
    s.bytes = sanitizeBytes(saved.bytes);
    s.reported = movedResetDay ? { cloudflare: null, beebo: null } : Object.assign({ cloudflare: null, beebo: null }, saved.reported || {});
    s.policy = Object.assign(freshState(nowMs, day).policy, saved.policy || {});
    return s;
  }
  // A new month: start from zero, keep the finished one for reference.
  base.previous = { periodKey: saved.periodKey, periodEnd: savedEnd, bytes: sanitizeBytes(saved.bytes) };
  return base;
}

function sanitizeBytes(b) {
  const out = emptyBytes();
  for (const k of PROVIDERS) {
    const v = Number(b && b[k]);
    out[k] = Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
  }
  return out;
}

// Add the agent's deltas: { cloudflare: bytes, beebo: bytes, custom: bytes }.
// Deltas that arrive after the month ended count toward the new month (they are
// at most a few seconds old; the agent reports every 15 s).
function addUsage(state, deltas, nowMs, resetDay) {
  const s = normalize(state, nowMs, resetDay);
  for (const k of PROVIDERS) {
    const v = Number(deltas && deltas[k]);
    // Reports come every 15 s, but the agent holds them while the app isn't
    // listening, so allow a lot; 10 TB at once is junk, not video.
    if (Number.isFinite(v) && v > 0 && v < 10000 * GB) s.bytes[k] += Math.floor(v);
  }
  s.updatedAt = nowMs;
  return s;
}

// A figure from the provider itself (only for this same month).
function setReported(state, provider, bytes, periodKey, nowMs, resetDay) {
  const s = normalize(state, nowMs, resetDay);
  const v = Number(bytes);
  if ((provider !== 'cloudflare' && provider !== 'beebo') || !Number.isFinite(v) || v < 0) return s;
  if (periodKey && periodKey !== s.periodKey) return s;
  s.reported[provider] = { bytes: Math.floor(v), at: nowMs };
  return s;
}

// What we believe was billed: the higher of our count and the provider's.
function effectiveBytes(state, provider) {
  const local = (state && state.bytes && state.bytes[provider]) || 0;
  const r = state && state.reported && state.reported[provider];
  return r && r.bytes > local ? r.bytes : local;
}
const effectiveGB = (state, provider) => effectiveBytes(state, provider) / GB;

module.exports = {
  GB, PROVIDERS, STORE_KEY, clampResetDay, periodFor, freshState, normalize, addUsage, setReported, effectiveBytes, effectiveGB,
};
