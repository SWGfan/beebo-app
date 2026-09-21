'use strict'
// Live TV state shapes (config, per-user prefs) and the channel list built from every tuner's lineup.

const guard = require('./netGuard')
const { GUIDE_NUMBER_RE } = require('./hdhr')

const QUALITY_IDS = ['1080p', '720p', '480p']
const MAX_DEVICES = 8
const CHANNEL_KEY_RE = /^[0-9A-Za-z][0-9A-Za-z._-]{0,15}(@[0-9A-F]{8})?$/

const DEFAULT_SETTINGS = Object.freeze({
  timeshiftMinutes: 90,
  timeshiftMaxMB: 8192,
  timeshiftDir: '',
  quality: '720p',
  dvrEnabled: false,
  recordingsDir: '',
  allowMemberRecording: false,
  padBeforeSec: 60,
  padAfterSec: 120,
  container: 'mkv',
  lookaheadDays: 7
})

const str = (v, max) => String(v == null ? '' : v).replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, max)
const intIn = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d }

function normalizeSettings(raw) {
  const s = raw && typeof raw === 'object' ? raw : {}
  return {
    timeshiftMinutes: intIn(s.timeshiftMinutes, 5, 240, DEFAULT_SETTINGS.timeshiftMinutes),
    timeshiftMaxMB: intIn(s.timeshiftMaxMB, 512, 102400, DEFAULT_SETTINGS.timeshiftMaxMB),
    timeshiftDir: str(s.timeshiftDir, 500),
    quality: QUALITY_IDS.includes(s.quality) ? s.quality : DEFAULT_SETTINGS.quality,
    dvrEnabled: s.dvrEnabled === true,
    recordingsDir: str(s.recordingsDir, 500),
    allowMemberRecording: s.allowMemberRecording === true,
    padBeforeSec: intIn(s.padBeforeSec, 0, 1800, DEFAULT_SETTINGS.padBeforeSec),
    padAfterSec: intIn(s.padAfterSec, 0, 3600, DEFAULT_SETTINGS.padAfterSec),
    container: s.container === 'ts' ? 'ts' : 'mkv',
    lookaheadDays: intIn(s.lookaheadDays, 1, 14, DEFAULT_SETTINGS.lookaheadDays)
  }
}

function normalizeDevice(d) {
  if (!d || typeof d !== 'object') return null
  const id = str(d.id, 8).toUpperCase()
  const check = guard.validateTunerTarget({ host: d.ip, port: d.apiPort }, { confirmNonLan: d.allowNonLan === true })
  if (!/^[0-9A-F]{8}$/.test(id) || !check.ok) return null
  const streamPort = intIn(d.streamPort, 1, 65535, 5004)
  return {
    id, ip: check.ip, apiPort: check.port, streamPort,
    name: str(d.name, 80) || 'HDHomeRun', model: str(d.model, 40), firmware: str(d.firmware, 40),
    tunerCount: intIn(d.tunerCount, 1, 16, 2), allowNonLan: d.allowNonLan === true,
    addedAt: Number(d.addedAt) || 0, lastSeenAt: Number(d.lastSeenAt) || 0
  }
}

function normalizeLineupRow(r) {
  if (!r || typeof r !== 'object') return null
  const guideNumber = str(r.guideNumber, 16)
  if (!GUIDE_NUMBER_RE.test(guideNumber)) return null
  return { guideNumber, guideName: str(r.guideName, 60) || guideNumber, hd: r.hd === true, drm: r.drm === true, videoCodec: str(r.videoCodec, 12), audioCodec: str(r.audioCodec, 12) }
}

function normalizeConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {}
  const devices = []
  for (const d of Array.isArray(c.devices) ? c.devices : []) {
    const n = normalizeDevice(d)
    if (n && !devices.some((x) => x.id === n.id) && devices.length < MAX_DEVICES) devices.push(n)
  }
  const lineups = {}
  for (const d of devices) {
    const l = c.lineups && c.lineups[d.id]
    lineups[d.id] = {
      fetchedAt: Number(l && l.fetchedAt) || 0,
      channels: (Array.isArray(l && l.channels) ? l.channels : []).map(normalizeLineupRow).filter(Boolean).slice(0, 1000)
    }
  }
  const overrides = {}
  if (c.overrides && typeof c.overrides === 'object') {
    for (const [k, v] of Object.entries(c.overrides).slice(0, 2000)) {
      if (!CHANNEL_KEY_RE.test(k) || !v || typeof v !== 'object') continue
      const o = {}
      if (v.hidden === true) o.hidden = true
      if (typeof v.number === 'string' && /^[0-9]{1,5}(\.[0-9]{1,3})?$/.test(v.number.trim())) o.number = v.number.trim()
      if (typeof v.name === 'string' && v.name.trim()) o.name = str(v.name, 60)
      if (Object.keys(o).length) overrides[k] = o
    }
  }
  const g = c.guide && typeof c.guide === 'object' ? c.guide : {}
  const src = g.source && typeof g.source === 'object' ? g.source : {}
  const map = {}
  if (g.map && typeof g.map === 'object') {
    for (const [k, v] of Object.entries(g.map).slice(0, 2000)) if (CHANNEL_KEY_RE.test(k) && typeof v === 'string' && v && v.length <= 200) map[k] = v
  }
  return {
    v: 1,
    enabled: c.enabled === true,
    devices,
    lineups,
    overrides,
    settings: normalizeSettings(c.settings),
    guide: {
      source: {
        type: src.type === 'file' || src.type === 'url' ? src.type : 'none',
        path: str(src.path, 500), url: str(src.url, 1000), allowPrivate: src.allowPrivate === true
      },
      map, lastRefreshAt: Number(g.lastRefreshAt) || 0, lastError: str(g.lastError, 200), refreshEveryHours: intIn(g.refreshEveryHours, 1, 168, 12)
    },
    advanced: { m3uAcknowledged: !!(c.advanced && c.advanced.m3uAcknowledged === true), m3uEnabled: false }
  }
}

function normalizePrefs(raw) {
  const users = {}
  const src = raw && raw.users && typeof raw.users === 'object' ? raw.users : {}
  for (const [id, u] of Object.entries(src).slice(0, 500)) {
    const fav = Array.isArray(u && u.favourites) ? u.favourites.filter((k) => typeof k === 'string' && CHANNEL_KEY_RE.test(k)).slice(0, 500) : []
    users[String(id).slice(0, 128)] = { favourites: [...new Set(fav)] }
  }
  return { v: 1, users }
}

const numberParts = (n) => {
  const m = /^(\d+)(?:\.(\d+))?/.exec(String(n))
  return m ? [Number(m[1]), m[2] === undefined ? -1 : Number(m[2])] : [Infinity, 0]
}
const compareNumbers = (a, b) => {
  const x = numberParts(a)
  const y = numberParts(b)
  return x[0] - y[0] || x[1] - y[1] || String(a).localeCompare(String(b))
}

/**
 * Every tuner's lineup merged into one channel list. The same channel on two tuners (one antenna)
 * is one channel with two devices; a clashing number with a different name stays separate.
 * DRM channels are left out of `channels` and counted in `drmHidden` (Beebo does not play them).
 */
function buildChannels(config) {
  const byNumber = new Map()
  const all = []
  let drmHidden = 0
  for (const d of config.devices) {
    const rows = (config.lineups[d.id] && config.lineups[d.id].channels) || []
    for (const r of rows) {
      if (r.drm) { drmHidden++; continue }
      const existing = byNumber.get(r.guideNumber)
      if (existing && existing.guideName.toLowerCase() === r.guideName.toLowerCase()) {
        if (!existing.devices.includes(d.id)) existing.devices.push(d.id)
        existing.hd = existing.hd || r.hd
        continue
      }
      const key = existing ? `${r.guideNumber}@${d.id}` : r.guideNumber
      const ch = { key, guideNumber: r.guideNumber, guideName: r.guideName, hd: r.hd, devices: [d.id], videoCodec: r.videoCodec, audioCodec: r.audioCodec }
      if (!existing) byNumber.set(r.guideNumber, ch)
      all.push(ch)
    }
  }
  const channels = all.map((ch) => {
    const o = config.overrides[ch.key] || {}
    return { ...ch, number: o.number || ch.guideNumber, name: o.name || ch.guideName, hidden: o.hidden === true }
  })
  channels.sort((a, b) => compareNumbers(a.number, b.number))
  return { channels, drmHidden }
}

const DRM_NOTE = 'Some channels are copy-protected (DRM). Beebo does not play copy-protected channels, so they are hidden.'

module.exports = {
  QUALITY_IDS, DEFAULT_SETTINGS, DRM_NOTE, MAX_DEVICES, CHANNEL_KEY_RE,
  normalizeConfig, normalizePrefs, normalizeSettings, normalizeDevice, buildChannels, compareNumbers
}
