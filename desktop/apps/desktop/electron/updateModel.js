const viewingPrivacy = require('./viewingPrivacy')
// Pure pieces of the desktop updater: no Electron, no network, no timers.
// Everything here takes the clock as an argument so the tests can drive it.
//
//   createEtaEstimator   download speed + "about 2 minutes left"
//   formatEta/Bytes/...  the wording the update panel shows
//   estimateInstallSeconds / recordInstallDuration
//                        "Beebo will close for about 45 seconds", learned from
//                        how long previous installs on this PC really took
//   activeViewers        is anyone watching something right now?
//   decideInstallTiming  install now / when nobody is watching / tonight

// ---------------------------------------------------------------------------
// ETA
// ---------------------------------------------------------------------------
// The speed is an exponential moving average over TIME, not over samples:
// data events arrive at irregular intervals (a burst of 64 KB chunks, then a
// pause), and a per-sample average would swing with the chunk rhythm. Each
// sample moves the average by alpha = 1 - 2^(-dt / halfLife), so a sample
// that covers a longer stretch counts for more.
//
// Stalls: when no new bytes have arrived for stallMs the estimate says
// "stalled" and gives no ETA at all, rather than an ETA that grows forever.
//
// Warm-up: for the first two half-lives the speed is simply the average since
// the (re)start. Starting the moving average from the very first sample would
// make the first estimate far too pessimistic (the first tick often has 0 bytes).
//
// Resume: restart(bytesAlreadyOnDisk) re-anchors the baseline so the bytes
// that were already downloaded before a pause don't count as an enormous burst
// of speed.
function createEtaEstimator(opts = {}) {
  const halfLifeMs = opts.halfLifeMs || 5000
  const minSampleMs = opts.minSampleMs || 250
  const stallMs = opts.stallMs || 8000
  const warmupMs = opts.warmupMs == null ? 1500 : opts.warmupMs
  let total = 0
  let bytes = 0
  let lastT = null
  let lastBytes = 0
  let lastProgressAt = null
  let startedAt = null
  let startBytes = 0
  let rate = null

  function restart(bytesNow, totalBytes, t) {
    bytes = Math.max(0, bytesNow || 0)
    if (totalBytes > 0) total = totalBytes
    lastT = t
    lastBytes = bytes
    lastProgressAt = t
    startedAt = t
    startBytes = bytes
    rate = null
  }

  function sample(bytesNow, t, totalBytes) {
    if (totalBytes > 0) total = totalBytes
    if (lastT === null) { restart(bytesNow, totalBytes, t); return snapshot(t) }
    if (bytesNow > bytes) lastProgressAt = t
    bytes = Math.max(bytes, bytesNow)
    const dt = t - lastT
    if (dt < minSampleMs) return snapshot(t)
    const inst = ((bytes - lastBytes) * 1000) / dt
    const sinceStart = t - startedAt
    if (rate === null || sinceStart < 2 * halfLifeMs) rate = sinceStart > 0 ? ((bytes - startBytes) * 1000) / sinceStart : inst
    else {
      const alpha = 1 - Math.pow(2, -dt / halfLifeMs)
      rate = rate + alpha * (inst - rate)
    }
    lastT = t
    lastBytes = bytes
    return snapshot(t)
  }

  function snapshot(t) {
    const now = t == null ? lastT : t
    const stalled = lastProgressAt !== null && now - lastProgressAt >= stallMs
    const warming = startedAt !== null && now - startedAt < warmupMs && rate === null
    const remaining = total > 0 ? Math.max(0, total - bytes) : null
    let etaSeconds = null
    if (!stalled && !warming && rate && rate > 1 && remaining !== null) etaSeconds = remaining / rate
    if (remaining === 0) etaSeconds = 0
    return {
      bytes,
      total,
      fraction: total > 0 ? Math.min(1, bytes / total) : null,
      speedBps: stalled ? 0 : Math.max(0, rate || 0),
      etaSeconds,
      stalled
    }
  }

  return { sample, restart, snapshot }
}

// ---------------------------------------------------------------------------
// wording
// ---------------------------------------------------------------------------
// Deliberately coarse: a number that changes every second ("2:13", "2:09",
// "2:31") reads as noise. Buckets only move when the estimate really moves.
function formatEta(seconds) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return ''
  if (seconds < 10) return 'a few seconds left'
  if (seconds < 50) return 'less than a minute left'
  if (seconds < 90) return 'about a minute left'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return 'about ' + minutes + ' minutes left'
  const hours = Math.round((seconds / 3600) * 2) / 2
  return 'about ' + (hours === 1 ? '1 hour' : hours + ' hours') + ' left'
}

function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds || 0))
  if (s < 60) return s + ' seconds'
  const m = Math.round(s / 60)
  return m === 1 ? 'a minute' : m + ' minutes'
}

function formatBytes(n) {
  const v = Math.max(0, n || 0)
  if (v < 1024 * 1024) return (v / 1024).toFixed(0) + ' KB'
  if (v < 1024 * 1024 * 1024) return (v / (1024 * 1024)).toFixed(v < 10 * 1024 * 1024 ? 1 : 0) + ' MB'
  return (v / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
}

function formatSpeed(bps) {
  if (!bps || bps < 1) return ''
  const mbit = (bps * 8) / 1e6
  return formatBytes(bps) + '/s' + (mbit >= 1 ? ' (' + mbit.toFixed(mbit < 10 ? 1 : 0) + ' Mbps)' : '')
}

// ---------------------------------------------------------------------------
// how long does an install take on THIS PC?
// ---------------------------------------------------------------------------
// Measured by the app itself: the moment the installer was launched is saved
// before Beebo quits, and the new version subtracts it when it starts. That
// span is exactly what the person experiences as "Beebo was gone".
const DEFAULT_INSTALL_SECONDS = 100
const INSTALL_HISTORY_MAX = 5
const MIN_PLAUSIBLE_INSTALL = 5
const MAX_PLAUSIBLE_INSTALL = 15 * 60

function estimateInstallSeconds(history, fallback = DEFAULT_INSTALL_SECONDS) {
  const ok = (Array.isArray(history) ? history : [])
    .map((h) => (h && typeof h === 'object' ? h.seconds : h))
    .map(Number)
    .filter((s) => Number.isFinite(s) && s >= MIN_PLAUSIBLE_INSTALL && s <= MAX_PLAUSIBLE_INSTALL)
    .slice(-INSTALL_HISTORY_MAX)
  if (!ok.length) return fallback
  const sorted = ok.slice().sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  // Round UP to 5 s: "about 45 seconds" that turns out to be 41 is a pleasant
  // surprise; one that turns out to be 49 is a small lie.
  return Math.max(10, Math.ceil(median / 5) * 5)
}

function recordInstallDuration(history, seconds, meta = {}) {
  const list = Array.isArray(history) ? history.slice() : []
  const s = Math.round(Number(seconds))
  if (!Number.isFinite(s) || s < MIN_PLAUSIBLE_INSTALL || s > MAX_PLAUSIBLE_INSTALL) return list
  list.push({ seconds: s, at: meta.at || Date.now(), from: meta.from || '', to: meta.to || '' })
  return list.slice(-INSTALL_HISTORY_MAX)
}

// After a relaunch: did the pending update land? Pure so it can be tested.
//   pending = { from, to, launchedAt, notes }
// Returns { kind: 'updated' | 'failed' | 'waiting' | 'none', seconds? }
const PENDING_FORGET_MS = 24 * 60 * 60 * 1000
function resolvePendingUpdate(pending, currentVersion, now, cmp) {
  if (!pending || !pending.to || !pending.launchedAt) return { kind: 'none' }
  if (cmp(currentVersion, pending.to) >= 0) {
    return { kind: 'updated', seconds: Math.max(0, (now - pending.launchedAt) / 1000) }
  }
  // Still the old version. Soon after launch that just means THIS process is
  // the old one starting up before the installer closed it; later it means the
  // install was cancelled or failed.
  if (now - pending.launchedAt < 2 * 60 * 1000) return { kind: 'waiting' }
  if (now - pending.launchedAt > PENDING_FORGET_MS) return { kind: 'none' }
  return { kind: 'failed' }
}

// ---------------------------------------------------------------------------
// is anyone watching?
// ---------------------------------------------------------------------------
// Every player page reports progress every 15 s (and on pause). A session whose
// last report is younger than windowMs and that isn't at the very end is
// "watching now". Read-only over the same rows history.js writes; rows from old
// versions without timestamps simply don't count.
const WATCHING_WINDOW_MS = 90 * 1000
function activeViewers(store, now = Date.now(), windowMs = WATCHING_WINDOW_MS) {
  const rows = []
  for (const key of ['watchHistory', 'watchHistoryPending']) {
    try {
      const list = store && store.get(key)
      if (Array.isArray(list)) rows.push(...list)
    } catch (e) {}
  }
  const seen = new Set()
  const out = []
  const hidden = store && typeof store.get === 'function' ? viewingPrivacy.privateUserIds(store) : new Set()
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue
    const at = Number(r.lastUpdate) || 0
    if (!at || now - at > windowMs || at - now > 60000) continue
    const cur = Number(r.currentTime) || 0
    const dur = Number(r.duration) || 0
    if (dur > 0 && cur >= dur - 5) continue
    const id = r.sessionId || (r.userId || '') + '|' + (r.fileName || r.title || '')
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ title: hidden.has(r.userId) || (!r.userId && hidden.size) ? 'Private viewing' : String(r.title || r.fileName || 'Something'), user: String(r.userName || r.user || ''), at })
  }
  return out
}

// ---------------------------------------------------------------------------
// when to install
// ---------------------------------------------------------------------------
// mode 'now'     install straight away (the person pressed the button and
//                confirmed, even with viewers)
// mode 'idle'    as soon as nobody has been watching for idleMs
// mode 'tonight' in the quiet window (quietStartHour..quietEndHour local), and
//                still only when nobody is watching; after the window closes
//                it falls back to 'idle' so it can't slip a whole day
const IDLE_MS = 2 * 60 * 1000
function nextQuietStart(now, hour = 3) {
  const d = new Date(now)
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, 0, 0, 0)
  if (t.getTime() <= now) t.setDate(t.getDate() + 1)
  return t.getTime()
}

function decideInstallTiming({ mode, viewerCount, now, idleSince, requestedAt, quietStartHour = 3, quietEndHour = 6, idleMs = IDLE_MS }) {
  const watching = viewerCount > 0
  if (mode === 'now') return { action: 'install', reason: 'requested' }
  if (mode === 'tonight') {
    const hour = new Date(now).getHours()
    const inWindow = hour >= quietStartHour && hour < quietEndHour
    const quietStartMs = nextQuietStart(requestedAt || now, quietStartHour)
    const windowPassed = now >= quietStartMs + (quietEndHour - quietStartHour) * 3600 * 1000
    if (!inWindow && !windowPassed) {
      return { action: 'wait', reason: 'tonight', installAt: nextQuietStart(now, quietStartHour), nextCheckMs: Math.min(15 * 60 * 1000, Math.max(30000, nextQuietStart(now, quietStartHour) - now)) }
    }
    // in the window (or it has passed): same rule as idle
  }
  if (watching) return { action: 'wait', reason: 'watching', nextCheckMs: 30000 }
  const quietFor = idleSince ? now - idleSince : 0
  if (quietFor >= idleMs) return { action: 'install', reason: 'idle' }
  return { action: 'wait', reason: 'settling', nextCheckMs: Math.max(5000, Math.min(30000, idleMs - quietFor)) }
}

module.exports = {
  createEtaEstimator,
  formatEta,
  formatDuration,
  formatBytes,
  formatSpeed,
  estimateInstallSeconds,
  recordInstallDuration,
  resolvePendingUpdate,
  activeViewers,
  decideInstallTiming,
  nextQuietStart,
  DEFAULT_INSTALL_SECONDS,
  WATCHING_WINDOW_MS,
  IDLE_MS
}
