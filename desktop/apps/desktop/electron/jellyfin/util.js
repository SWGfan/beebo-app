'use strict'

const { TICKS_PER_SECOND } = require('./constants')

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Emby-Authorization, X-MediaBrowser-Token, X-Emby-Token, Range, Accept',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
  'Access-Control-Max-Age': '600'
}

function prune(value) {
  if (Array.isArray(value)) return value.map(prune)
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (v === null || v === undefined) continue
      out[k] = prune(v)
    }
    return out
  }
  return value
}

function sendJson(res, status, obj, headers = {}) {
  const payload = obj === undefined ? '' : JSON.stringify(prune(obj))
  const buf = Buffer.from(payload, 'utf8')
  res.writeHead(status, {
    ...CORS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    ...headers
  })
  res.end(res.req && String(res.req.method).toUpperCase() === 'HEAD' ? undefined : buf)
}

function sendEmpty(res, status = 204, headers = {}) {
  res.writeHead(status, { ...CORS, 'Content-Length': 0, ...headers })
  res.end()
}

function sendText(res, status, text, contentType, headers = {}) {
  const buf = Buffer.from(text, 'utf8')
  res.writeHead(status, { ...CORS, 'Content-Type': contentType, 'Content-Length': buf.length, 'Cache-Control': 'no-store', ...headers })
  res.end(buf)
}

function safeDecode(s) {
  try { return decodeURIComponent(s) } catch { return s }
}

// MediaBrowser Client="x", Device="y", DeviceId="z", Version="1", Token="t"
function parseAuthorizationHeader(raw) {
  const text = String(raw || '')
  const head = /^\s*(MediaBrowser|Emby)\s+/i.exec(text)
  if (!head) return null
  const out = {}
  const re = /([A-Za-z]+)="([^"]*)"/g
  let m
  while ((m = re.exec(text.slice(head[0].length)))) out[m[1].toLowerCase()] = safeDecode(m[2]).slice(0, 256)
  return out
}

function readCredentials(req, query) {
  const h = req.headers || {}
  const fromAuth = parseAuthorizationHeader(h.authorization) || parseAuthorizationHeader(h['x-emby-authorization']) || {}
  const token = fromAuth.token || h['x-mediabrowser-token'] || h['x-emby-token'] || query('api_key') || query('apikey') || ''
  return {
    token: String(token || '').trim(),
    device: {
      client: fromAuth.client || query('client') || '',
      name: fromAuth.device || query('devicename') || '',
      id: fromAuth.deviceid || query('deviceid') || '',
      version: fromAuth.version || query('appversion') || ''
    }
  }
}

function makeQuery(url) {
  // Every occurrence is kept: typed SDKs send arrays as repeated parameters (includeItemTypes=Movie&includeItemTypes=Series),
  // others as one comma-separated value; both mean the same list.
  const map = new Map()
  for (const [k, v] of url.searchParams) {
    const key = k.toLowerCase()
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(v)
  }
  const q = (name) => {
    const v = map.get(String(name).toLowerCase())
    return v === undefined ? '' : v[0]
  }
  q.has = (name) => map.has(String(name).toLowerCase())
  q.int = (name, fallback = 0) => {
    const n = parseInt(q(name), 10)
    return Number.isFinite(n) ? n : fallback
  }
  q.bool = (name) => /^(true|1)$/i.test(q(name))
  q.list = (name) => (map.get(String(name).toLowerCase()) || []).flatMap((v) => v.split(/[,|]/)).map((s) => s.trim()).filter(Boolean)
  return q
}

function readBody(req, limit = 1024 * 1024) {
  if (req.__jfBody !== undefined) return Promise.resolve(req.__jfBody)
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    let done = false
    const finish = (v) => { if (!done) { done = true; try { req.__jfBody = v } catch {} resolve(v) } }
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { finish({}); try { req.destroy() } catch {} ; return }
      chunks.push(c)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text.trim()) return finish({})
      try {
        const parsed = JSON.parse(text)
        finish(parsed && typeof parsed === 'object' ? parsed : {})
      } catch {
        try { finish(Object.fromEntries(new URLSearchParams(text))) } catch { finish({}) }
      }
    })
    req.on('error', () => finish({}))
  })
}

const pick = (obj, ...names) => {
  if (!obj || typeof obj !== 'object') return undefined
  const lower = new Map(Object.keys(obj).map((k) => [k.toLowerCase(), k]))
  for (const n of names) {
    const real = lower.get(String(n).toLowerCase())
    if (real !== undefined && obj[real] !== undefined && obj[real] !== null) return obj[real]
  }
  return undefined
}

const toTicks = (seconds) => Math.max(0, Math.round((Number(seconds) || 0) * TICKS_PER_SECOND))
const fromTicks = (ticks) => (Number(ticks) || 0) / TICKS_PER_SECOND

function isoDate(ms) {
  const d = new Date(Number(ms))
  return Number.isFinite(d.getTime()) ? d.toISOString() : undefined
}

module.exports = {
  CORS,
  prune,
  sendJson,
  sendEmpty,
  sendText,
  parseAuthorizationHeader,
  readCredentials,
  makeQuery,
  readBody,
  pick,
  toTicks,
  fromTicks,
  isoDate
}
