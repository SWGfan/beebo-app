'use strict'
// The Radio Browser community directory (https://www.radio-browser.info, https://api.radio-browser.info),
// used the way its documentation asks:
//
//   - server discovery: the API is served by several mirrors. The list comes from
//     https://all.api.radio-browser.info/json/servers (cached for an hour, with a built-in fallback
//     list), the mirror to talk to is picked at random, and a mirror that fails is skipped for a
//     while and the next one tried;
//   - a proper User-Agent naming this app and its version (outboundFetch.js sets it);
//   - the "click" call when a listener actually starts a station, so the directory's popularity
//     numbers stay honest.
//
// Only the directory (names, addresses, tags) is used: no audio comes through here. All requests go
// through the guarded outbound client and never get the local-network allowance. Results are cached
// briefly and the household as a whole is limited to a modest request rate.

const feedLib = require('./podcastFeed')

const DISCOVERY_URL = 'https://all.api.radio-browser.info/json/servers'
// Only the directory's own hosts, checked (https, port 443, no credentials) on every hop by safeFetch's rules.
const DIRECTORY_HOSTS = ['all.api.radio-browser.info', '.api.radio-browser.info']
const FALLBACK_SERVERS = ['de1.api.radio-browser.info', 'de2.api.radio-browser.info', 'fi1.api.radio-browser.info', 'nl1.api.radio-browser.info']
const HOST_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.api\.radio-browser\.info$/i
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ORDERS = new Set(['name', 'votes', 'clickcount', 'clicktrend', 'bitrate', 'random', 'country', 'language'])
const LIST_KINDS = { countries: 'countries', languages: 'languages', tags: 'tags' }

const clip = (s, n) => String(s == null ? '' : s).replace(/[\x00-\x1f\s]+/g, ' ').trim().slice(0, n)

/** One directory row -> the fields the app shows and plays. Null when it is not a usable audio station. */
function shapeStation(r) {
  if (!r || typeof r !== 'object') return null
  const uuid = String(r.stationuuid || '')
  if (!UUID_RE.test(uuid)) return null
  if (Number(r.hls) === 1) return null // segment (HLS) streams need a player of their own
  const url = feedLib.cleanUrl(r.url_resolved) || feedLib.cleanUrl(r.url)
  if (!url) return null
  return {
    id: 'rb:' + uuid.toLowerCase(),
    name: clip(r.name, 120) || 'Unnamed station',
    url,
    homepage: feedLib.cleanUrl(r.homepage),
    favicon: feedLib.cleanUrl(r.favicon),
    tags: clip(r.tags, 200).split(',').map((t) => t.trim()).filter(Boolean).slice(0, 8),
    country: clip(r.country, 80),
    countryCode: /^[A-Za-z]{2}$/.test(String(r.countrycode || '')) ? String(r.countrycode).toUpperCase() : '',
    language: clip(r.language, 80),
    codec: clip(r.codec, 20),
    bitrate: Number.isFinite(Number(r.bitrate)) ? Math.max(0, Math.round(Number(r.bitrate))) : 0,
    votes: Number.isFinite(Number(r.votes)) ? Number(r.votes) : 0,
    source: 'radio-browser'
  }
}

/**
 * @param {object} o
 * @param {object} o.fetcher  outboundFetch fetcher (never the local-network one)
 * @param {Function} [o.now]
 * @param {Function} [o.random]
 * @param {string[]} [o.fallbackServers]
 */
function createRadioBrowser({ fetcher, now = Date.now, random = Math.random, fallbackServers = FALLBACK_SERVERS, log } = {}) {
  const say = typeof log === 'function' ? log : () => {}
  let servers = { list: [], at: 0 }
  const bad = new Map() // host -> until
  const cache = new Map() // path -> { at, value }
  const hits = []

  async function discover() {
    if (servers.list.length && now() - servers.at < 3600000) return servers.list
    let list = []
    try {
      const r = await fetcher.get(DISCOVERY_URL, { headers: { Accept: 'application/json' }, allowHosts: DIRECTORY_HOSTS, maxBytes: 256 * 1024, timeoutMs: 8000 })
      if (r.status === 200) {
        const rows = JSON.parse(r.body.toString('utf8'))
        list = (Array.isArray(rows) ? rows : []).map((x) => String(x && x.name || '').toLowerCase()).filter((h) => HOST_RE.test(h))
      }
    } catch (err) { say(`radio: could not list directory servers: ${err && err.code || err}`) }
    list = [...new Set(list)]
    if (!list.length) list = fallbackServers.slice()
    servers = { list, at: now() }
    return list
  }

  const shuffle = (a) => { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]] } return b }

  // GET path on some mirror; tries up to three before giving up.
  async function request(pathAndQuery, { ttlMs = 5 * 60000 } = {}) {
    const t = now()
    const hit = cache.get(pathAndQuery)
    if (hit && t - hit.at < ttlMs) return hit.value
    while (hits.length && t - hits[0] > 60000) hits.shift()
    if (hits.length >= 40) throw Object.assign(new Error('rate_limited'), { status: 429, code: 'rate_limited' })
    hits.push(t)
    const list = (await discover()).filter((h) => !(bad.get(h) > t))
    const order = shuffle(list.length ? list : servers.list).slice(0, 3)
    let lastErr = null
    for (const host of order) {
      try {
        const r = await fetcher.get(`https://${host}${pathAndQuery}`, { headers: { Accept: 'application/json' }, allowHosts: DIRECTORY_HOSTS, maxBytes: 4 * 1024 * 1024, timeoutMs: 12000 })
        if (r.status !== 200) throw Object.assign(new Error('directory_' + r.status), { code: 'directory_' + r.status })
        const value = JSON.parse(r.body.toString('utf8'))
        cache.set(pathAndQuery, { at: t, value })
        if (cache.size > 200) cache.delete(cache.keys().next().value)
        return value
      } catch (err) {
        lastErr = err
        bad.set(host, t + 10 * 60000)
        say(`radio: directory mirror failed (${err && err.code || err && err.message})`)
      }
    }
    throw Object.assign(new Error('directory_unavailable'), { status: 502, code: 'directory_unavailable', cause: lastErr })
  }

  /** Browse / search. Every filter is optional; hidden: broken stations and HLS. */
  async function search(q = {}) {
    const p = new URLSearchParams()
    const put = (k, v, n = 80) => { const s = clip(v, n); if (s) p.set(k, s) }
    put('name', q.name)
    put('country', q.country)
    if (/^[A-Za-z]{2}$/.test(String(q.countryCode || ''))) p.set('countrycode', String(q.countryCode).toUpperCase())
    put('language', q.language)
    put('tag', q.tag)
    put('codec', q.codec, 12)
    const order = ORDERS.has(q.order) ? q.order : q.name ? 'votes' : 'clickcount'
    p.set('order', order)
    p.set('reverse', order === 'name' || order === 'country' || order === 'language' ? 'false' : 'true')
    p.set('hidebroken', 'true')
    p.set('limit', String(Math.min(100, Math.max(1, parseInt(q.limit, 10) || 30))))
    p.set('offset', String(Math.min(10000, Math.max(0, parseInt(q.offset, 10) || 0))))
    const rows = await request('/json/stations/search?' + p.toString())
    return (Array.isArray(rows) ? rows : []).map(shapeStation).filter(Boolean)
  }

  async function byUuid(uuid) {
    if (!UUID_RE.test(String(uuid))) return null
    const rows = await request('/json/stations/byuuid/' + String(uuid).toLowerCase(), { ttlMs: 30 * 60000 })
    return shapeStation(Array.isArray(rows) ? rows[0] : null)
  }

  /** countries | languages | tags: [{ name, code?, count }] biggest first. */
  async function list(kind, { limit = 150 } = {}) {
    if (!LIST_KINDS[kind]) throw Object.assign(new Error('bad_list'), { status: 400, code: 'bad_list' })
    const p = new URLSearchParams({ order: 'stationcount', reverse: 'true', hidebroken: 'true', limit: String(Math.min(500, Math.max(1, parseInt(limit, 10) || 150))) })
    const rows = await request(`/json/${LIST_KINDS[kind]}?${p.toString()}`, { ttlMs: 60 * 60000 })
    return (Array.isArray(rows) ? rows : []).map((r) => ({ name: clip(r && r.name, 80), code: kind === 'countries' && /^[A-Za-z]{2}$/.test(String(r && r.iso_3166_1 || '')) ? String(r.iso_3166_1).toUpperCase() : '', count: Number(r && r.stationcount) || 0 }))
      .filter((r) => r.name)
  }

  /** "A listener started this station": the directory's own popularity counter. Best effort. */
  async function click(uuid) {
    if (!UUID_RE.test(String(uuid))) return
    try {
      const host = (await discover())[0]
      if (host) await fetcher.get(`https://${host}/json/url/${String(uuid).toLowerCase()}`, { headers: { Accept: 'application/json' }, allowHosts: DIRECTORY_HOSTS, maxBytes: 64 * 1024, timeoutMs: 6000 })
    } catch { /* it only feeds a counter */ }
  }

  return { search, byUuid, list, click, discover, shapeStation: shapeStation }
}

module.exports = { createRadioBrowser, shapeStation, UUID_RE, FALLBACK_SERVERS, DISCOVERY_URL }
