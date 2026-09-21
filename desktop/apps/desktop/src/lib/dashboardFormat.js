// Plain-English formatting for the server dashboard (Dashboard.jsx). Pure, so
// the wording is tested without a browser.

export function formatBytes(n) {
  const v = Number(n) || 0
  if (v < 1000) return `${Math.round(v)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let x = v
  let i = -1
  while (x >= 1000 && i < units.length - 1) { x /= 1000; i++ }
  return `${x >= 100 ? Math.round(x) : x.toFixed(1)} ${units[i]}`
}

export function formatBitrate(bitsPerSec) {
  const v = Number(bitsPerSec) || 0
  if (v <= 0) return '0 Mbps'
  if (v < 1e6) return `${Math.round(v / 1000)} kbps`
  return `${(v / 1e6).toFixed(v >= 1e8 ? 0 : 1)} Mbps`
}

export function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`
  if (h) return `${h}h ${m}m`
  return `${m}m`
}

export function formatClock(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

export function timeAgo(ms, now = Date.now()) {
  if (!ms) return 'never'
  const d = Math.max(0, now - Number(ms))
  if (d < 60000) return 'just now'
  if (d < 3600000) return `${Math.floor(d / 60000)} min ago`
  if (d < 86400000) return `${Math.floor(d / 3600000)} h ago`
  return `${Math.floor(d / 86400000)} days ago`
}

export const WHERE_ICON = { home: '🏠', away_direct: '🌍', away_relay: '🛰️', cast: '📺' }
