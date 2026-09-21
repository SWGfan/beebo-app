'use strict'
// ============================================================================
// guide.js - the programme guide ("What's on").
// ----------------------------------------------------------------------------
// Source: an XMLTV file or URL the owner chooses (see xmltv.js). Beebo does not supply guide data and
// the tuner's own now/next needs a subscription, so with no source the app shows channel names only.
//
// Feasibility note - reading the guide straight from the antenna signal (ATSC PSIP / DVB EIT tables):
// the HDHomeRun's /auto/ stream is filtered to ONE programme and does not carry those tables, ffmpeg
// and ffprobe do not decode them, and reading them would need the raw multiplex plus a table parser
// with the broadcast text encodings. Too heavy for a first version, so XMLTV it is.
// ============================================================================

const fs = require('fs')
const path = require('path')
const guard = require('./netGuard')
const xmltv = require('./xmltv')
const { createStateFile } = require('./stateFile')

const KEEP_PAST_MS = 6 * 3600 * 1000
const KEEP_FUTURE_MS = 15 * 24 * 3600 * 1000
const MAX_FILE_BYTES = 128 * 1024 * 1024
const GUIDE_FILE_EXT = /\.(xml|xmltv|gz)$/i

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '')

function normalizeCache(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const programmes = {}
  if (r.programmes && typeof r.programmes === 'object') {
    for (const [id, list] of Object.entries(r.programmes).slice(0, 5000)) {
      if (!Array.isArray(list)) continue
      programmes[id.slice(0, 200)] = list.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && typeof p[2] === 'string').slice(0, 5000)
    }
  }
  const xc = (Array.isArray(r.channels) ? r.channels : []).filter((c) => c && typeof c.id === 'string').slice(0, 5000)
    .map((c) => ({ id: c.id.slice(0, 200), names: (Array.isArray(c.names) ? c.names : []).map((n) => String(n).slice(0, 80)).slice(0, 8) }))
  return { v: 1, fetchedAt: Number(r.fetchedAt) || 0, channels: xc, programmes }
}

// A programme is stored as a short array: [start, stop, title, subTitle, desc, categories, season, episode, isNew, rating]
const pack = (p) => [p.start, p.stop, p.title, p.subTitle, p.desc, p.categories, p.season, p.episode, p.isNew ? 1 : 0, p.rating]
const unpack = (a, xmltvId) => ({
  xmltvId, start: a[0], stop: a[1], title: a[2], subTitle: a[3] || '', desc: a[4] || '', categories: a[5] || [],
  season: a[6] == null ? null : a[6], episode: a[7] == null ? null : a[7], isNew: a[8] === 1, rating: a[9] || ''
})

function createGuide({ dir, getConfig, updateConfig, getChannels, now = Date.now, log = () => {}, fetchUrl = guard.fetchGuideUrl, readFile = (p) => fs.readFileSync(p), onChange = () => {}, timers = { setTimeout, clearTimeout } }) {
  const cache = createStateFile(path.join(dir, 'guide-cache.json'), { v: 1, programmes: {}, channels: [] }, normalizeCache, { indent: 0 })
  let refreshing = false
  let timer = null
  let status = { lastError: '', lastRefreshAt: 0, programmes: 0, channelsInFile: 0 }

  /** channel key -> xmltv id: the owner's manual choice first, then a match on names and numbers. */
  function mapping() {
    const cfg = getConfig()
    const map = {}
    const xc = cache.get().channels
    const byName = new Map()
    for (const c of xc) {
      for (const cand of [c.id, ...c.names]) {
        const n = norm(cand)
        if (n && !byName.has(n)) byName.set(n, c.id)
        const num = /^(\d{1,4}(?:[.-]\d{1,3})?)(?:\s|$)/.exec(String(cand).trim())
        if (num && !byName.has('n' + num[1].replace('-', '.'))) byName.set('n' + num[1].replace('-', '.'), c.id)
      }
    }
    const have = cache.get().programmes
    for (const ch of getChannels()) {
      const manual = cfg.guide.map[ch.key]
      if (manual && have[manual]) { map[ch.key] = manual; continue }
      const hit = byName.get(norm(ch.guideName)) || byName.get(norm(ch.name)) || byName.get('n' + ch.guideNumber) || byName.get('n' + ch.number)
      if (hit) map[ch.key] = hit
    }
    return map
  }

  function programmesFor(channelKey, from, to, map = mapping()) {
    const id = map[channelKey]
    if (!id) return []
    const list = cache.get().programmes[id] || []
    const out = []
    for (const a of list) {
      if (a[1] <= from) continue
      if (a[0] >= to) break
      out.push(unpack(a, id))
    }
    return out
  }

  function nowNext(channelKey, t = now(), map = mapping()) {
    const list = programmesFor(channelKey, t, t + 12 * 3600 * 1000, map)
    return { now: list.find((p) => p.start <= t && p.stop > t) || null, next: list.find((p) => p.start > t) || null }
  }

  /** Channels x time window. Channels with no guide still appear (with an empty row). */
  function grid({ from = now(), hours = 3, channels = getChannels() } = {}) {
    const start = Math.floor(from / 1800000) * 1800000 - 0
    const end = start + Math.min(12, Math.max(1, hours)) * 3600 * 1000
    const map = mapping()
    return {
      from: start, to: end, hasGuide: Object.keys(cache.get().programmes).length > 0,
      rows: channels.map((ch) => ({ channel: ch.key, number: ch.number, name: ch.name, programmes: programmesFor(ch.key, start, end, map).map((p) => ({ start: p.start, stop: p.stop, title: p.title, subTitle: p.subTitle, isNew: p.isNew, season: p.season, episode: p.episode, categories: p.categories })) }))
    }
  }

  /** Every programme with the channel key attached, for the DVR's series rules. */
  function upcoming(from, to) {
    const map = mapping()
    const out = []
    for (const ch of getChannels()) for (const p of programmesFor(ch.key, from, to, map)) out.push({ ...p, channel: ch.key })
    return out
  }

  function find(channelKey, start) {
    return programmesFor(channelKey, start - 1, start + 1).find((p) => p.start === start) || null
  }

  async function loadSource() {
    const src = getConfig().guide.source
    if (src.type === 'file') {
      if (!GUIDE_FILE_EXT.test(src.path)) throw new guard.GuardError('bad_file', 'Choose an .xml, .xmltv or .xml.gz guide file.')
      let st
      try { st = fs.statSync(src.path) } catch { throw new guard.GuardError('missing_file', 'The guide file was not found.') }
      if (!st.isFile() || st.size > MAX_FILE_BYTES) throw new guard.GuardError('bad_file', 'That guide file cannot be used.')
      return guard.gunzipIfNeeded(readFile(src.path))
    }
    if (src.type === 'url') return fetchUrl(src.url, { allowPrivate: src.allowPrivate === true })
    return null
  }

  async function refresh() {
    if (refreshing) return status
    refreshing = true
    try {
      const buf = await loadSource()
      if (!buf) { status = { ...status, lastError: '' }; return status }
      const parsed = xmltv.parseXmltv(buf)
      if (!parsed.programmes.length) throw new guard.GuardError('empty_guide', 'That file has no programmes in it. Is it an XMLTV file?')
      const t = now()
      const byId = {}
      for (const p of parsed.programmes) {
        if (p.stop < t - KEEP_PAST_MS || p.start > t + KEEP_FUTURE_MS) continue
        ;(byId[p.channel] = byId[p.channel] || []).push(p)
      }
      const programmes = {}
      let count = 0
      for (const [id, list] of Object.entries(byId)) {
        list.sort((a, b) => a.start - b.start)
        programmes[id] = list.map(pack)
        count += list.length
      }
      cache.update((c) => { c.fetchedAt = t; c.channels = parsed.channels; c.programmes = programmes })
      updateConfig((c) => { c.guide.lastRefreshAt = t; c.guide.lastError = '' })
      status = { lastError: '', lastRefreshAt: t, programmes: count, channelsInFile: parsed.channels.length }
      log(`live TV guide: ${count} programmes for ${Object.keys(programmes).length} channels`)
      onChange()
    } catch (e) {
      const msg = e && e.code && e.message ? e.message : 'The guide could not be read.'
      status = { ...status, lastError: msg }
      try { updateConfig((c) => { c.guide.lastError = msg }) } catch { /* reported in status */ }
      log('live TV guide refresh failed: ' + (e && e.code || 'error'))
    } finally {
      refreshing = false
    }
    return status
  }

  function schedule() {
    if (timer) timers.clearTimeout(timer)
    timer = null
    const cfg = getConfig()
    if (cfg.guide.source.type === 'none') return
    const every = cfg.guide.refreshEveryHours * 3600 * 1000
    const due = cfg.guide.lastRefreshAt ? Math.max(30000, cfg.guide.lastRefreshAt + every - now()) : 30000
    timer = timers.setTimeout(async () => { await refresh(); schedule() }, due)
    if (timer && timer.unref) timer.unref()
  }

  return {
    mapping, nowNext, grid, upcoming, find, refresh, schedule, programmesFor,
    unmatched: () => { const m = mapping(); return getChannels().filter((c) => !m[c.key]).map((c) => c.key) },
    xmltvChannels: () => cache.get().channels,
    status: () => ({ ...status, source: getConfig().guide.source.type, lastRefreshAt: getConfig().guide.lastRefreshAt || status.lastRefreshAt, lastError: getConfig().guide.lastError || status.lastError, hasGuide: Object.keys(cache.get().programmes).length > 0, fetchedAt: cache.get().fetchedAt }),
    stop() { if (timer) timers.clearTimeout(timer); timer = null }
  }
}

module.exports = { createGuide, norm, GUIDE_FILE_EXT }
