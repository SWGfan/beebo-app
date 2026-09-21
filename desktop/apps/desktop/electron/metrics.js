'use strict'
// Prometheus metrics: what the server is doing, as numbers a scraper (Prometheus, Grafana Agent,
// VictoriaMetrics, Home Assistant's prometheus integration) can chart.
//
// Off by default. The owner turns it on in Admin > API keys; until then /metrics answers 404 like any
// other path that does not exist. When on it needs a bearer token: an API key that holds the `metrics`
// scope (only an admin can put that on a key) or the admin's own account token.
//
// The text is the Prometheus exposition format 0.0.4 (# HELP / # TYPE / name{labels} value). Only
// numbers and fixed labels: there is no user name, title, file path or address anywhere in it, so
// what a scraper learns is "how busy", never "who is watching what". Stream counts include private
// profiles (they are counts, and the owner's dashboard shows the same).
//
// collect() reads the running server through small injected functions; render() turns the plain
// object it returns into text, and is what the tests pin down.

const METRICS_SETTING = 'metricsEnabled'
const CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8'

const num = (v) => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

// Label values: backslash, double quote and newline are the only characters that need escaping.
const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')
const NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/
const LABEL_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/

// A number the way Prometheus reads it: no exponent surprises for integers, and never NaN/Inf.
function valueText(n) {
  const v = num(n)
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6)
}

// families: [{ name, help, type: 'gauge'|'counter', samples: [{ labels?: {k: v}, value }] }]
function renderFamilies(families) {
  const lines = []
  for (const f of families) {
    if (!NAME_RE.test(f.name)) throw new Error('bad metric name: ' + f.name)
    if (f.type === 'counter' && !f.name.endsWith('_total')) throw new Error('a counter must end in _total: ' + f.name)
    lines.push(`# HELP ${f.name} ${String(f.help).replace(/\\/g, '\\\\').replace(/\n/g, '\\n')}`)
    lines.push(`# TYPE ${f.name} ${f.type}`)
    for (const s of f.samples) {
      const labels = s.labels && Object.keys(s.labels).length
        ? '{' + Object.entries(s.labels).map(([k, v]) => {
            if (!LABEL_RE.test(k)) throw new Error('bad label name: ' + k)
            return `${k}="${esc(v)}"`
          }).join(',') + '}'
        : ''
      lines.push(`${f.name}${labels} ${valueText(s.value)}`)
    }
  }
  return lines.join('\n') + '\n'
}

const gauge = (name, help, samples) => ({ name, help, type: 'gauge', samples })
const counter = (name, help, samples) => ({ name, help, type: 'counter', samples })
const one = (value, labels) => [{ value, ...(labels ? { labels } : {}) }]

// s is what collect() returns (every part optional: a part that could not be read is simply absent).
function render(s) {
  const f = []
  f.push(gauge('beebo_info', 'Beebo server build information (always 1).', one(1, { version: s.version || 'unknown' })))
  if (s.uptimeSeconds !== undefined) f.push(gauge('beebo_uptime_seconds', 'Seconds since the server started.', one(s.uptimeSeconds)))

  if (s.streams) {
    f.push(gauge('beebo_streams_active', 'Streams playing right now, by how they are served.', [
      { labels: { playback: 'direct' }, value: s.streams.direct },
      { labels: { playback: 'transcode' }, value: s.streams.transcode }
    ]))
    f.push(gauge('beebo_streams_paused', 'Streams that are open but paused.', one(s.streams.paused)))
  }
  if (s.transcodes) {
    f.push(gauge('beebo_transcodes_active', 'Live conversions (transcodes) running or holding a slot.', one(s.transcodes.active)))
    f.push(gauge('beebo_transcode_slots', 'How many live conversions the server allows at once.', one(s.transcodes.max)))
  }
  if (s.library) {
    const items = [
      { labels: { kind: 'movies' }, value: s.library.movies },
      { labels: { kind: 'shows' }, value: s.library.shows },
      { labels: { kind: 'episodes' }, value: s.library.episodes },
      ...(s.library.extra || []).filter((x) => x && /^[a-z0-9_]+$/i.test(String(x.kind))).map((x) => ({ labels: { kind: String(x.kind).toLowerCase() }, value: x.count }))
    ]
    f.push(gauge('beebo_library_items', 'Items in the library, by kind.', items))
    if (s.library.bytes) {
      f.push(gauge('beebo_library_bytes', 'Bytes the library files use, by kind.', Object.entries(s.library.bytes).map(([kind, value]) => ({ labels: { kind }, value }))))
    }
    if (Array.isArray(s.library.disks) && s.library.disks.length) {
      f.push(gauge('beebo_disk_free_bytes', 'Free bytes on each disk that holds a library folder.', s.library.disks.map((d) => ({ labels: { disk: d.disk }, value: d.freeBytes }))))
      f.push(gauge('beebo_disk_total_bytes', 'Size in bytes of each disk that holds a library folder.', s.library.disks.map((d) => ({ labels: { disk: d.disk }, value: d.totalBytes }))))
    }
  }
  if (s.bandwidth) {
    f.push(gauge('beebo_bandwidth_bytes_per_second', 'Bytes per second streaming out right now.', one(s.bandwidth.bytesPerSecond)))
    f.push(gauge('beebo_bandwidth_peak_today_bytes_per_second', 'Highest bytes per second seen today.', one(s.bandwidth.peakTodayBytesPerSecond)))
    f.push(gauge('beebo_bandwidth_sent_today_bytes', 'Bytes streamed out since local midnight.', one(s.bandwidth.sentTodayBytes)))
    f.push(counter('beebo_bytes_sent_total', 'Bytes streamed out since the server started (use rate()).', one(s.bandwidth.sentTotalBytes)))
    if (s.bandwidth.relayBytes) {
      f.push(gauge('beebo_relay_bytes', 'Bytes carried by a relay in the current billing period, by relay.', Object.entries(s.bandwidth.relayBytes).map(([provider, value]) => ({ labels: { relay: provider }, value }))))
    }
  }
  if (s.errors24h !== undefined) f.push(gauge('beebo_errors_24h', 'Problems the server logged in the last 24 hours.', one(s.errors24h)))
  if (s.users) f.push(gauge('beebo_users', 'Accounts on this server, by state.', Object.entries(s.users).map(([state, value]) => ({ labels: { state }, value }))))
  if (s.webhooks) {
    f.push(counter('beebo_webhook_deliveries_total', 'Webhook deliveries that finished, by result.', [
      { labels: { result: 'delivered' }, value: s.webhooks.delivered },
      { labels: { result: 'failed' }, value: s.webhooks.failed }
    ]))
    f.push(gauge('beebo_webhook_queue', 'Webhook deliveries waiting to be sent.', one(s.webhooks.queued)))
    f.push(gauge('beebo_webhooks_configured', 'Webhooks the owner has set up.', one(s.webhooks.configured)))
  }
  if (s.apiKeys) {
    f.push(gauge('beebo_api_keys', 'Personal API keys that exist.', one(s.apiKeys.total)))
    f.push(counter('beebo_api_auth_failures_total', 'API key attempts refused since the server started.', one(s.apiKeys.authFailures)))
  }
  if (s.process) {
    if (s.process.cpuPercent !== null && s.process.cpuPercent !== undefined) f.push(gauge('beebo_process_cpu_percent', 'CPU used by the server, percent of the whole machine.', one(s.process.cpuPercent)))
    f.push(gauge('beebo_process_memory_bytes', 'Memory the server uses.', one(s.process.memoryBytes)))
  }
  return renderFamilies(f)
}

// Reads the running server. Every input is a function so a piece that fails or does not exist
// (no library scan yet, no transcoder) drops its metrics instead of failing the scrape.
//   dashboard   serverDashboard instance: nowPlaying(), bandwidth(), health(), library()
//   transcodes  () => [{ lastAccess }] from the live conversion manager, and its slot limit
async function collect({ dashboard, transcodes, transcodeMax, webhookStats, webhooksConfigured, apiKeyCount, apiAuthFailures, users, version, now = () => Date.now() } = {}) {
  const out = { version }
  const safe = (fn, fallback) => { try { const v = fn(); return v === undefined ? fallback : v } catch { return fallback } }
  if (dashboard) {
    const rows = safe(() => dashboard.nowPlaying(), [])
    out.streams = {
      direct: rows.filter((r) => r.playback !== 'transcode').length,
      transcode: rows.filter((r) => r.playback === 'transcode').length,
      paused: rows.filter((r) => r.paused).length
    }
    const bw = safe(() => dashboard.bandwidth(), null)
    if (bw) {
      const health = safe(() => dashboard.health(), null)
      out.bandwidth = {
        bytesPerSecond: num(bw.currentBytesPerSec),
        peakTodayBytesPerSecond: num(bw.peakTodayBytesPerSec),
        sentTodayBytes: num(bw.sentTodayBytes),
        sentTotalBytes: num(bw.sentTotalBytes),
        ...(health && health.relay && health.relay.bytes ? { relayBytes: { beebo: num(health.relay.bytes.beebo), cloudflare: num(health.relay.bytes.cloudflare), custom: num(health.relay.bytes.custom) } } : {})
      }
      if (health) {
        out.uptimeSeconds = num(health.uptimeSeconds)
        out.errors24h = num(health.errors24h && health.errors24h.count)
        out.process = { cpuPercent: health.cpuPercent === null || health.cpuPercent === undefined ? null : num(health.cpuPercent), memoryBytes: num(health.memoryBytes) }
        if (!out.version && health.versions && health.versions.app) out.version = health.versions.app
      }
    }
    try {
      const lib = await dashboard.library()
      const bytes = { movies: 0, tv: 0 }
      for (const fo of (lib.storage && lib.storage.folders) || []) if (fo.kind === 'movies' || fo.kind === 'tv') bytes[fo.kind] += num(fo.usedBytes)
      out.library = {
        movies: num(lib.counts && lib.counts.movies),
        shows: num(lib.counts && lib.counts.shows),
        episodes: num(lib.counts && lib.counts.episodes),
        extra: (lib.counts && lib.counts.extra) || [],
        bytes,
        disks: ((lib.storage && lib.storage.disks) || []).map((d) => ({ disk: String(d.disk || ''), freeBytes: num(d.freeBytes), totalBytes: num(d.totalBytes) }))
      }
    } catch { /* no library numbers this time */ }
  }
  if (typeof transcodes === 'function') {
    const list = safe(transcodes, [])
    const t = now()
    // A conversion nobody has asked a piece of for half a minute is idle, and gives its slot back on demand.
    out.transcodes = { active: list.filter((x) => x && t - num(x.lastAccess) <= 30000).length, max: num(typeof transcodeMax === 'function' ? safe(transcodeMax, 0) : transcodeMax) }
  }
  if (webhookStats) out.webhooks = { ...webhookStats, configured: num(webhooksConfigured) }
  if (apiKeyCount !== undefined) out.apiKeys = { total: num(apiKeyCount), authFailures: num(apiAuthFailures) }
  if (users) out.users = users
  return out
}

function isEnabled(store) {
  try { return store.get(METRICS_SETTING) === true } catch { return false }
}

function setEnabled(store, on) {
  store.set(METRICS_SETTING, on === true)
  return on === true
}

module.exports = { METRICS_SETTING, CONTENT_TYPE, render, renderFamilies, collect, isEnabled, setEnabled }
