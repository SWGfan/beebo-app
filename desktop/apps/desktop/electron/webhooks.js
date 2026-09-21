'use strict'
// Outbound webhooks: tell another program on the owner's network (Home Assistant, n8n, a script)
// that something happened here.
//
// Shape of the whole thing:
//   - The owner configures targets in Admin > Webhooks (store key 'webhooks'). Each has a URL, the
//     events it wants, and a signing secret that is shown once, when it is made.
//   - Something happens (a request is filed, playback starts...). The call site does
//     `webhooks.emit(store, event, data)` and moves on: emit() never throws, never waits, never blocks.
//   - A small queue posts `{ event, timestamp, data }` to each subscribed target, signed with
//     X-Beebo-Signature: t=<unix>,v1=<hmac-sha256(secret, `${t}.${rawBody}`)>. A failure is retried
//     a couple of times with a growing pause, then dropped; every outcome lands in a capped,
//     owner-visible delivery log (mailer.js's model: never block, always leave a trail).
//
// Outbound connections made from owner-typed config are an SSRF surface, so the target is resolved
// and judged before every attempt (see classifyAddress), the connection is pinned to the address
// that was judged, redirects are never followed, the wait is short, and the response body is read
// only far enough to drop it. Nothing about a response is stored beyond its status code.
//
// Payloads never carry tokens, file paths, addresses or e-mails, and playback events are never
// sent for profiles with private viewing history or parental limits.

const crypto = require('crypto')
const dns = require('dns')
const http = require('http')
const https = require('https')
const net = require('net')
const auth = require('./auth')
const { embeddedIPv4 } = require('./ipEmbedded')
const parental = require('./parentalControls')
const viewingPrivacy = require('./viewingPrivacy')
const titleRequests = require('./titleRequests')
const formats = require('./webhookFormats')

const STORE_KEY = 'webhooks'
const LOG_KEY = 'webhookLog'
const MAX_HOOKS = 10
const MAX_LOG = 100
const NAME_MAX = 60
const URL_MAX = 2000

// What can be subscribed to. `webhook.test` is sent by the Send-test button and is never a choice.
const EVENTS = Object.freeze([
  { id: 'request.added', label: 'Request added', blurb: 'Someone asked for a title.' },
  { id: 'request.approved', label: 'Request approved', blurb: 'A requested title is now in the library, or you marked it found.' },
  { id: 'request.declined', label: 'Request declined', blurb: 'You said no to a request.' },
  { id: 'playback.started', label: 'Playback started', blurb: 'Someone opened a film or episode to watch it.' },
  { id: 'playback.paused', label: 'Playback paused', blurb: 'Someone paused a film or episode.' },
  { id: 'playback.resumed', label: 'Playback resumed', blurb: 'Someone pressed play again after a pause.' },
  { id: 'playback.progress', label: 'Playback progress', blurb: 'A short update about once a minute while someone is watching.' },
  { id: 'playback.stopped', label: 'Playback stopped', blurb: 'The player closed, or playback went quiet for a minute and a half.' },
  { id: 'playback.watched', label: 'Marked watched', blurb: 'A film or episode reached the end, or was ticked as watched.' },
  { id: 'library.item_added', label: 'Library item added', blurb: 'A new film or episode showed up in the library.' }
])
const EVENT_IDS = new Set(EVENTS.map((e) => e.id))
const TEST_EVENT = 'webhook.test'

const MAX_ATTEMPTS = 3
const settings = {
  retryDelaysMs: [2000, 10000],
  timeoutMs: 5000,
  maxConcurrent: 4,
  maxQueue: 200,
  stopAfterMs: 90 * 1000,
  sweepEveryMs: 15 * 1000,
  progressEveryMs: 60 * 1000
}
const RESPONSE_READ_CAP = 4096
const MAX_TRACKED_SESSIONS = 500

function configure(next) {
  Object.assign(settings, next || {})
}

// ----- addresses -----------------------------------------------------------------------------
// 'public'  : goes out to the internet.
// 'lan'     : this machine or the owner's own network: loopback, RFC 1918, carrier-grade NAT (Tailscale
//             lives there), IPv6 unique-local. Refused unless the owner ticks the LAN box.
// 'blocked' : never, whatever the owner ticks: "this network", link-local (which is where every cloud
//             metadata service lives), multicast, broadcast, reserved.

const BLOCKED = new net.BlockList()
const LAN = new net.BlockList()
for (const [addr, bits] of [['0.0.0.0', 8], ['169.254.0.0', 16], ['192.0.0.0', 24], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]]) BLOCKED.addSubnet(addr, bits, 'ipv4')
for (const [addr, bits] of [['::', 128], ['fe80::', 10], ['ff00::', 8], ['fd00:ec2::', 32]]) BLOCKED.addSubnet(addr, bits, 'ipv6')
for (const [addr, bits] of [['127.0.0.0', 8], ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['100.64.0.0', 10]]) LAN.addSubnet(addr, bits, 'ipv4')
for (const [addr, bits] of [['::1', 128], ['fc00::', 7], ['fec0::', 10]]) LAN.addSubnet(addr, bits, 'ipv6')

// 8 sixteen-bit groups for an IPv6 literal (handles :: and a trailing dotted quad), or null.
function expandIpv6(ip) {
  let s = String(ip).toLowerCase().split('%')[0]
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s)
  if (dotted) {
    if (net.isIPv4(dotted[1]) === false) return null
    const o = dotted[1].split('.').map(Number)
    s = s.slice(0, dotted.index) + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16)
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null
  const groups = [...head, ...Array(fill).fill('0'), ...tail].map((g) => parseInt(g || '0', 16))
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null
}

function classifyAddress(ip) {
  const family = net.isIP(ip)
  if (!family) return 'blocked'
  if (family === 6) {
    const g = expandIpv6(ip)
    if (!g) return 'blocked'
    // The shared reader also knows the SIIT form (::ffff:0:a.b.c.d) that the checks below do not.
    const wrapped = embeddedIPv4(ip)
    if (wrapped) return classifyAddress(wrapped)
    // An IPv4 address wearing an IPv6 coat (::ffff:a.b.c.d, ::a.b.c.d, NAT64) is judged as the IPv4 it carries.
    const v4 = () => `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`
    const first5Zero = g.slice(0, 5).every((x) => x === 0)
    if ((first5Zero && g[5] === 0xffff) || (first5Zero && g[5] === 0 && (g[6] || g[7] > 1)) || (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0))) {
      return classifyAddress(v4())
    }
    // 6to4 (2002::/16) also carries an IPv4 address, in groups 1-2.
    if (g[0] === 0x2002) return classifyAddress(`${g[1] >> 8}.${g[1] & 255}.${g[2] >> 8}.${g[2] & 255}`)
    const canon = g.map((x) => x.toString(16)).join(':')
    if (BLOCKED.check(canon, 'ipv6')) return 'blocked'
    if (LAN.check(canon, 'ipv6')) return 'lan'
    return 'public'
  }
  if (BLOCKED.check(ip, 'ipv4')) return 'blocked'
  if (LAN.check(ip, 'ipv4')) return 'lan'
  return 'public'
}

const bareHost = (hostname) => String(hostname || '').replace(/^\[|\]$/g, '')

function lookupAll(host, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('dns_timeout')), timeoutMs)
    dns.lookup(host, { all: true, verbatim: true }, (err, list) => {
      clearTimeout(timer)
      if (err) reject(err)
      else resolve(list || [])
    })
  })
}

// Syntax only: what may be saved as a webhook target.
function parseTargetUrl(raw) {
  const text = String(raw === undefined || raw === null ? '' : raw).trim()
  if (!text || text.length > URL_MAX) return { ok: false, error: 'bad_url' }
  let u
  try { u = new URL(text) } catch { return { ok: false, error: 'bad_url' } }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: 'bad_url' }
  if (!u.hostname || u.username || u.password) return { ok: false, error: 'bad_url' }
  return { ok: true, url: u }
}

// Resolve the target and judge every address it answers with. One bad answer refuses the target:
// a name that resolves to both a public and a private address is exactly what a rebinding
// trick looks like. Returns the addresses to pin the connection to.
async function resolveTarget(rawUrl, { allowPrivateNetwork = false } = {}) {
  const parsed = parseTargetUrl(rawUrl)
  if (!parsed.ok) return parsed
  const host = bareHost(parsed.url.hostname)
  let addresses
  if (net.isIP(host)) {
    addresses = [{ address: host, family: net.isIP(host) }]
  } else {
    try {
      addresses = await lookupAll(host, 3000)
    } catch (err) {
      return { ok: false, error: 'unresolvable', detail: err && err.code ? String(err.code) : 'lookup_failed' }
    }
    if (!addresses.length) return { ok: false, error: 'unresolvable', detail: 'no_address' }
  }
  for (const a of addresses) {
    const cls = classifyAddress(a.address)
    if (cls === 'blocked') return { ok: false, error: 'blocked_address', address: a.address }
    if (cls === 'lan' && !allowPrivateNetwork) return { ok: false, error: 'blocked_private', address: a.address }
  }
  return { ok: true, url: parsed.url, addresses }
}

// ----- signing -------------------------------------------------------------------------------

function sign(secret, timestamp, rawBody) {
  const v1 = crypto.createHmac('sha256', String(secret)).update(`${timestamp}.${rawBody}`).digest('hex')
  return `t=${timestamp},v1=${v1}`
}

// What a receiver does with the header (docs/PUBLIC-API.md shows it in Node and Python).
function verifySignature(secret, header, rawBody, { toleranceSeconds = 300, now = Date.now() } = {}) {
  const parts = Object.fromEntries(String(header || '').split(',').map((kv) => { const i = kv.indexOf('='); return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()] }))
  const t = Number(parts.t)
  if (!Number.isInteger(t) || !parts.v1) return false
  if (Math.abs(Math.floor(now / 1000) - t) > toleranceSeconds) return false
  const want = Buffer.from(sign(secret, t, rawBody).split('v1=')[1], 'hex')
  const got = Buffer.from(parts.v1, 'hex')
  return want.length === got.length && crypto.timingSafeEqual(want, got)
}

// ----- config --------------------------------------------------------------------------------

function rows(store) {
  try {
    const all = store.get(STORE_KEY)
    return Array.isArray(all) ? all.filter((r) => r && typeof r === 'object' && r.id && r.url) : []
  } catch {
    return []
  }
}

// What a screen or a response may show about a hook: never the secret, never a credential (only
// the names of the ones that are set), and never a chat webhook's address path (it is the secret).
function shape(row) {
  const format = row.format && formats.FORMAT_IDS.has(row.format) ? row.format : formats.DEFAULT_FORMAT
  return {
    id: row.id,
    name: row.name,
    url: format === formats.DEFAULT_FORMAT ? row.url : formats.displayUrl(format, row.url),
    format,
    credentialsSet: row.credentials && typeof row.credentials === 'object' ? Object.keys(row.credentials).filter((k) => row.credentials[k]) : [],
    titleTemplate: row.titleTemplate || '',
    messageTemplate: row.messageTemplate || '',
    events: Array.isArray(row.events) ? row.events.slice() : [],
    enabled: row.enabled !== false,
    allowPrivateNetwork: row.allowPrivateNetwork === true,
    createdAt: row.createdAt || null
  }
}

function list(store) {
  return rows(store).map(shape)
}

function cleanEvents(raw) {
  if (!Array.isArray(raw) || !raw.length) return null
  const want = new Set(raw.map((e) => String(e)))
  for (const e of want) if (!EVENT_IDS.has(e)) return null
  return EVENTS.map((e) => e.id).filter((id) => want.has(id))
}

const newSecret = () => 'beebo_whsec_' + crypto.randomBytes(32).toString('base64url')

const blank = (v) => v === undefined || v === null || String(v).trim() === ''

// The format-dependent part of a hook, validated as one unit: which format, the address it posts
// to (Pushover has a fixed one), the credentials that format needs and the optional wording.
// Returns { ok, format, url, credentials, titleTemplate, messageTemplate } or { ok: false, error, field? }.
function cleanFormatConfig({ format, url, credentials, titleTemplate, messageTemplate }, prior = null) {
  const fmt = blank(format) ? (prior && prior.format) || formats.DEFAULT_FORMAT : String(format)
  const info = formats.formatInfo(fmt)
  if (!info) return { ok: false, error: 'bad_format' }
  let address = blank(url) ? (prior ? prior.url : '') : url
  // A service with a fixed address (Pushover) gets it when the hook is switched to it without a new one.
  if (blank(url) && info.defaultUrl && prior && (prior.format || formats.DEFAULT_FORMAT) !== fmt) address = info.defaultUrl
  if (blank(address) && info.defaultUrl) address = info.defaultUrl
  // Credentials given now replace the old set for the fields they name; a field sent empty is removed.
  const merged = { ...(prior && (prior.format || formats.DEFAULT_FORMAT) === fmt && prior.credentials && typeof prior.credentials === 'object' ? prior.credentials : {}) }
  if (credentials && typeof credentials === 'object') {
    for (const [k, v] of Object.entries(credentials)) { if (blank(v)) delete merged[k]; else merged[k] = v }
  }
  const cred = formats.cleanCredentials(fmt, merged)
  if (!cred.ok) return { ok: false, error: 'bad_credentials', field: cred.field }
  const missing = formats.missingCredential(fmt, cred.credentials, address)
  if (missing) return { ok: false, error: 'bad_credentials', field: missing }
  const t = formats.cleanTemplate(titleTemplate === undefined && prior ? prior.titleTemplate : titleTemplate)
  const m = formats.cleanTemplate(messageTemplate === undefined && prior ? prior.messageTemplate : messageTemplate)
  if (!t.ok || !m.ok) return { ok: false, error: 'bad_template' }
  return {
    ok: true,
    format: fmt,
    url: address,
    credentials: cred.credentials,
    // Wording only applies to the notification formats: the signed JSON envelope is never reworded.
    titleTemplate: fmt === formats.DEFAULT_FORMAT ? '' : t.template,
    messageTemplate: fmt === formats.DEFAULT_FORMAT ? '' : m.template
  }
}

async function create(store, { name, url, events, allowPrivateNetwork, format, credentials, titleTemplate, messageTemplate, now = Date.now() } = {}) {
  const label = String(name === undefined || name === null ? '' : name).replace(/\s+/g, ' ').trim()
  if (!label || label.length > NAME_MAX) return { ok: false, error: 'bad_name' }
  const ev = cleanEvents(events)
  if (!ev) return { ok: false, error: 'bad_events' }
  const cfg = cleanFormatConfig({ format, url, credentials, titleTemplate, messageTemplate })
  if (!cfg.ok) return cfg
  const allow = allowPrivateNetwork === true
  const target = await resolveTarget(cfg.url, { allowPrivateNetwork: allow })
  // A name that does not resolve yet is saved anyway (the server may be offline right now);
  // an address that is refused is not.
  if (!target.ok && target.error !== 'unresolvable') return target
  const existing = rows(store)
  if (existing.length >= MAX_HOOKS) return { ok: false, error: 'too_many_hooks' }
  const secret = newSecret()
  const row = {
    id: crypto.randomBytes(6).toString('hex'),
    name: label,
    url: parseTargetUrl(cfg.url).url.toString(),
    format: cfg.format,
    credentials: cfg.credentials,
    titleTemplate: cfg.titleTemplate,
    messageTemplate: cfg.messageTemplate,
    events: ev,
    enabled: true,
    allowPrivateNetwork: allow,
    secret,
    createdAt: now
  }
  store.set(STORE_KEY, [...existing, row])
  return { ok: true, hook: shape(row), secret }
}

async function update(store, id, patch = {}) {
  const all = rows(store)
  const hit = all.find((r) => r.id === String(id || ''))
  if (!hit) return { ok: false, error: 'not_found' }
  const next = { ...hit }
  if (patch.name !== undefined) {
    const label = String(patch.name).replace(/\s+/g, ' ').trim()
    if (!label || label.length > NAME_MAX) return { ok: false, error: 'bad_name' }
    next.name = label
  }
  if (patch.events !== undefined) {
    const ev = cleanEvents(patch.events)
    if (!ev) return { ok: false, error: 'bad_events' }
    next.events = ev
  }
  if (patch.enabled !== undefined) next.enabled = patch.enabled === true
  if (patch.allowPrivateNetwork !== undefined) next.allowPrivateNetwork = patch.allowPrivateNetwork === true
  const formatTouched = ['format', 'credentials', 'titleTemplate', 'messageTemplate'].some((k) => patch[k] !== undefined)
  let newUrl = null
  if (formatTouched) {
    const cfg = cleanFormatConfig({ format: patch.format, url: patch.url, credentials: patch.credentials, titleTemplate: patch.titleTemplate, messageTemplate: patch.messageTemplate }, hit)
    if (!cfg.ok) return cfg
    next.format = cfg.format
    next.credentials = cfg.credentials
    next.titleTemplate = cfg.titleTemplate
    next.messageTemplate = cfg.messageTemplate
    if (patch.url === undefined && cfg.url !== hit.url) newUrl = cfg.url
  }
  if (patch.url !== undefined) newUrl = patch.url
  if (newUrl !== null || patch.allowPrivateNetwork !== undefined) {
    const target = await resolveTarget(newUrl !== null ? newUrl : hit.url, { allowPrivateNetwork: next.allowPrivateNetwork })
    if (!target.ok && target.error !== 'unresolvable') return target
    if (newUrl !== null) next.url = parseTargetUrl(newUrl).url.toString()
  }
  store.set(STORE_KEY, all.map((r) => (r === hit ? next : r)))
  return { ok: true, hook: shape(next) }
}

function remove(store, id) {
  const all = rows(store)
  const hit = all.find((r) => r.id === String(id || ''))
  if (!hit) return { ok: false, error: 'not_found' }
  store.set(STORE_KEY, all.filter((r) => r !== hit))
  return { ok: true, hook: shape(hit) }
}

// The old secret stops verifying the moment this returns; the new one is shown once.
function rotateSecret(store, id) {
  const all = rows(store)
  const hit = all.find((r) => r.id === String(id || ''))
  if (!hit) return { ok: false, error: 'not_found' }
  const secret = newSecret()
  store.set(STORE_KEY, all.map((r) => (r === hit ? { ...r, secret } : r)))
  return { ok: true, hook: shape(hit), secret }
}

// ----- delivery log --------------------------------------------------------------------------

function logDelivery(store, entry) {
  try {
    const log = store.get(LOG_KEY)
    const next = [{ time: Date.now(), ...entry }, ...(Array.isArray(log) ? log : [])].slice(0, MAX_LOG)
    store.set(LOG_KEY, next)
  } catch {
    /* the log is a courtesy: never let it break the thing it describes */
  }
}

function getLog(store) {
  try {
    const log = store.get(LOG_KEY)
    return Array.isArray(log) ? log : []
  } catch {
    return []
  }
}

function clearLog(store) {
  store.set(LOG_KEY, [])
}

// ----- one HTTP attempt ----------------------------------------------------------------------

// Never follows a redirect, gives up after settings.timeoutMs in total, reads at most
// RESPONSE_READ_CAP bytes of the answer and throws them away.
function postOnce({ url, addresses, body, headers }) {
  return new Promise((resolve) => {
    let done = false
    let req = null
    const finish = (result) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { if (req) req.destroy() } catch {}
      resolve(result)
    }
    const timer = setTimeout(() => finish({ status: 0, error: 'timeout' }), settings.timeoutMs)
    if (timer.unref) timer.unref()
    const isHttps = url.protocol === 'https:'
    const host = bareHost(url.hostname)
    const pinned = (_h, opts, cb) => {
      if (opts && opts.all) cb(null, addresses.map((a) => ({ address: a.address, family: a.family })))
      else cb(null, addresses[0].address, addresses[0].family)
    }
    try {
      req = (isHttps ? https : http).request({
        protocol: url.protocol,
        hostname: host,
        port: url.port || (isHttps ? 443 : 80),
        path: (url.pathname || '/') + (url.search || ''),
        method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
        lookup: pinned,
        agent: false,
        ...(isHttps && !net.isIP(host) ? { servername: host } : {})
      }, (res) => {
        const status = res.statusCode || 0
        let seen = 0
        res.on('data', (chunk) => {
          seen += chunk.length
          if (seen > RESPONSE_READ_CAP) finish({ status })
        })
        res.on('end', () => finish({ status }))
        res.on('error', () => finish({ status }))
        res.on('close', () => finish({ status }))
      })
      req.on('error', (err) => finish({ status: 0, error: shortError(err) }))
      req.end(body)
    } catch (err) {
      finish({ status: 0, error: shortError(err) })
    }
  })
}

function shortError(err) {
  const code = err && err.code ? String(err.code) : ''
  if (code === 'ECONNREFUSED') return 'connection refused'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'host not found'
  if (code === 'ECONNRESET') return 'connection reset'
  if (code === 'ETIMEDOUT') return 'timeout'
  if (/CERT|SSL|TLS/i.test(code) || /certificate|self.signed/i.test(String(err && err.message))) return 'TLS certificate problem'
  return code ? code.toLowerCase() : 'network error'
}

const retryable = (status) => status === 0 || status === 408 || status === 425 || status === 429 || status >= 500

// ----- the queue -----------------------------------------------------------------------------

const queue = []
let active = 0
let timersPending = 0
const idleWaiters = []
// Whole-run totals for /metrics (deliveries that ended, not attempts). Never reset by a restart's
// worth of anything else; _reset() zeroes them for tests.
const stats = { delivered: 0, failed: 0 }

function settleIdle() {
  if (active === 0 && queue.length === 0 && timersPending === 0) {
    while (idleWaiters.length) idleWaiters.shift()()
  }
}

// Resolves once nothing is queued, in flight or waiting to retry. For tests.
function whenIdle() {
  return new Promise((resolve) => {
    idleWaiters.push(resolve)
    settleIdle()
  })
}

function enqueue(job) {
  if (queue.length >= settings.maxQueue) {
    const dropped = queue.shift()
    stats.failed++
    logDelivery(dropped.store, { hookId: dropped.hook.id, hookName: dropped.hook.name, event: dropped.event, deliveryId: dropped.deliveryId, ok: false, attempts: dropped.attempt - 1, error: 'queue full: dropped' })
  }
  queue.push(job)
  setImmediate(pump)
}

function pump() {
  while (active < settings.maxConcurrent && queue.length) {
    const job = queue.shift()
    active++
    runAttempt(job)
      .catch(() => {
        // Whatever went wrong, the caller waiting on a test and the log both get an answer.
        logDelivery(job.store, { hookId: job.hook.id, hookName: job.hook.name, event: job.event, deliveryId: job.deliveryId, ok: false, attempts: job.attempt, error: 'internal error' })
        if (job.onDone) job.onDone({ ok: false, status: null, error: 'internal error', attempts: job.attempt, ms: 0 })
      })
      .finally(() => {
        active--
        pump()
        settleIdle()
      })
  }
}

// One attempt at one target. A retryable failure schedules the next attempt on a timer (it does not
// hold a queue slot while it waits); anything final goes to the log.
async function runAttempt(job) {
  const { store, hook, event, body, deliveryId, attempt } = job
  const started = Date.now()
  const final = (result) => {
    stats[result.ok ? 'delivered' : 'failed']++
    logDelivery(store, { hookId: hook.id, hookName: hook.name, event, deliveryId, ok: !!result.ok, status: result.status || null, attempts: attempt, ms: Date.now() - started, ...(result.error ? { error: result.error } : {}) })
    if (job.onDone) job.onDone({ ok: !!result.ok, status: result.status || null, error: result.error || null, attempts: attempt, ms: Date.now() - started })
  }
  const target = await resolveTarget(hook.url, { allowPrivateNetwork: hook.allowPrivateNetwork === true })
  if (!target.ok) {
    const why = target.error === 'blocked_private' ? 'refused: private network address (not allowed for this webhook)'
      : target.error === 'blocked_address' ? 'refused: address is never allowed'
      : target.error === 'unresolvable' ? 'host not found'
      : 'refused: bad URL'
    // A refused address is a permanent answer, not a hiccup: no retry.
    if (target.error === 'unresolvable' && attempt < MAX_ATTEMPTS && !job.noRetry) return scheduleRetry(job)
    final({ ok: false, error: why })
    return
  }
  const timestamp = Math.floor(Date.now() / 1000)
  const res = await postOnce({
    url: target.url,
    addresses: target.addresses,
    body,
    headers: {
      'Content-Type': job.contentType || 'application/json',
      // A formatter's own headers (ntfy Title, a Gotify key) go first so they can never replace the ones below.
      ...(job.extraHeaders || {}),
      'User-Agent': 'Beebo-Webhook/1',
      'X-Beebo-Event': event,
      'X-Beebo-Delivery': deliveryId,
      'X-Beebo-Signature': sign(hook.secret, timestamp, body)
    }
  })
  if (res.status >= 200 && res.status < 300) { final({ ok: true, status: res.status }); return }
  const error = res.error || (res.status >= 300 && res.status < 400 ? `HTTP ${res.status} (redirects are not followed)` : `HTTP ${res.status}`)
  if (retryable(res.status) && attempt < MAX_ATTEMPTS && !job.noRetry) { scheduleRetry(job); return }
  final({ ok: false, status: res.status, error })
}

function scheduleRetry(job) {
  const delay = settings.retryDelaysMs[Math.min(job.attempt - 1, settings.retryDelaysMs.length - 1)] || 0
  timersPending++
  const timer = setTimeout(() => {
    timersPending--
    enqueue({ ...job, attempt: job.attempt + 1 })
  }, delay)
  if (timer.unref) timer.unref()
}

function subscribers(store, event) {
  return rows(store).filter((h) => h.enabled !== false && Array.isArray(h.events) && h.events.includes(event) && h.secret)
}

function wantsEvent(store, event) {
  return subscribers(store, event).length > 0
}

function wantsAnyOf(store, prefix) {
  return rows(store).some((h) => h.enabled !== false && h.secret && Array.isArray(h.events) && h.events.some((e) => e.startsWith(prefix)))
}

function envelope(event, data, timestamp = new Date().toISOString()) {
  return JSON.stringify({ event, timestamp, data })
}

// The bytes one hook receives for one event: the signed JSON envelope, or the formatter's version
// of it (webhookFormats.js). The signature is over whatever body this returns.
function payloadFor(hook, event, data, timestamp) {
  const format = hook.format && hook.format !== formats.DEFAULT_FORMAT ? hook.format : null
  if (format) {
    const r = formats.render(format, event, data, { hook, credentials: hook.credentials || {}, timestamp })
    if (r) return { body: r.body, contentType: r.contentType, extraHeaders: r.headers }
  }
  return { body: envelope(event, data, timestamp), contentType: 'application/json', extraHeaders: {} }
}

// Queue an event for every target that wants it. Returns how many were queued. Never throws, never waits.
function emit(store, event, data) {
  try {
    if (!EVENT_IDS.has(event)) return 0
    const hooks = subscribers(store, event)
    if (!hooks.length) return 0
    const timestamp = new Date().toISOString()
    let queued = 0
    for (const hook of hooks) {
      // One hook whose message cannot be built must not stop the others from hearing about it.
      let payload
      try {
        payload = payloadFor(hook, event, data, timestamp)
      } catch {
        stats.failed++
        logDelivery(store, { hookId: hook.id, hookName: hook.name, event, deliveryId: crypto.randomUUID(), ok: false, attempts: 0, error: 'could not build the message' })
        continue
      }
      enqueue({ store, hook, event, ...payload, deliveryId: crypto.randomUUID(), attempt: 1 })
      queued++
    }
    return queued
  } catch {
    return 0
  }
}

// What the test button carries: a small example of a playback event, so a template such as
// "{{user.name}} is watching {{media.title}}" can be tried before a real event happens.
function testData(hook) {
  return {
    message: 'This is a test event from Beebo.',
    webhook: { id: hook.id, name: hook.name },
    user: { id: 'test', name: 'Test user' },
    media: { kind: 'movie', title: 'Test movie', ids: { tmdb: null, imdb: null, tvdb: null } },
    positionSeconds: 0,
    durationSeconds: 0,
    percent: 0
  }
}

// The Send-test button: one attempt, straight away, and the answer comes back to the caller.
// It goes out in the hook's own format, so it proves the whole path including the wording.
function sendTest(store, id) {
  const hook = rows(store).find((r) => r.id === String(id || ''))
  if (!hook) return Promise.resolve({ ok: false, error: 'not_found' })
  let payload
  try {
    payload = payloadFor(hook, TEST_EVENT, testData(hook), new Date().toISOString())
  } catch {
    return Promise.resolve({ ok: true, delivery: { ok: false, status: null, error: 'could not build the message', attempts: 0, ms: 0 } })
  }
  return new Promise((resolve) => {
    enqueue({ store, hook, event: TEST_EVENT, ...payload, deliveryId: crypto.randomUUID(), attempt: 1, noRetry: true, onDone: (r) => resolve({ ok: true, delivery: r }) })
  })
}

// ----- what events carry ---------------------------------------------------------------------

function requestData(row) {
  const by = Array.isArray(row.requestedBy) ? row.requestedBy.filter(Boolean) : []
  return {
    id: row.id,
    kind: row.kind === 'tv' ? 'tv' : 'movie',
    title: row.title || row.showName || row.collectionName || 'Untitled',
    showName: row.showName || null,
    season: row.season != null ? row.season : null,
    episode: row.episode != null ? row.episode : null,
    year: row.year != null ? row.year : null,
    tmdbId: row.tmdbId != null ? row.tmdbId : null,
    source: row.source || 'upnext',
    status: titleRequests.requestStatus(row),
    requestedAt: row.firstSeenAt || null,
    requesters: by.map((u) => ({ id: u.userId || null, name: u.userName || 'Unknown', note: u.note || null }))
  }
}

// A person just asked (or another person asked for the same thing).
function emitRequestAdded(store, row, requester) {
  if (!row) return 0
  return emit(store, 'request.added', {
    request: requestData(row),
    requester: requester ? { id: requester.userId || null, name: requester.userName || 'Unknown', note: requester.note || null } : null
  })
}

// The same "did this really just turn into added/dismissed" decision the e-mail path uses
// (titleRequests.requestTransition, which requestersToNotify is built on), as a second output channel.
function emitRequestTransition(store, beforeRow, afterRow) {
  let transition = null
  try { transition = titleRequests.requestTransition(beforeRow, afterRow) } catch { transition = null }
  if (!transition) return 0
  return emit(store, transition === 'added' ? 'request.approved' : 'request.declined', {
    request: requestData(afterRow),
    resolvedBy: transition === 'added' ? afterRow.resolvedBy || 'owner' : 'owner'
  })
}

// ----- playback ------------------------------------------------------------------------------

// Whose viewing may leave this server: never someone who keeps their history private, never a
// profile under parental limits, never an account that no longer exists.
function mayAnnounce(store, userId) {
  if (!userId || String(userId).startsWith('share:')) return null
  let user = null
  try { user = auth.getUsers(store).find((u) => u && u.id === userId && u.status === 'approved') || null } catch { user = null }
  if (!user) return null
  if (viewingPrivacy.isPrivate(store, userId)) return null
  if (parental.isRestricted(parental.getPolicy(store, userId))) return null
  return user
}

const kindOfRow = (row) => (row && row.kind === 'tv' ? 'tv' : 'movie')
const secs = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : 0)

// The session id a player reports with is what POST /progress needs to write history, so it is not
// handed out: events carry a short one-way reference that is stable for the session and nothing else.
const sessionRef = (sessionId) => crypto.createHash('sha256').update('beebo-session|' + String(sessionId || '')).digest('base64url').slice(0, 12)

// ----- local listeners -----------------------------------------------------------------------
// The dashboards' event stream (GET /api/v1/events) hears every announced playback event, whether
// or not a webhook asked for it. The same privacy filter applies: the events reaching here already
// left out private and limited profiles.
const listeners = new Set()

function onEvent(fn) {
  if (typeof fn !== 'function') return () => {}
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

function listenerCount() {
  return listeners.size
}

function publish(store, event, data) {
  if (listeners.size) {
    const message = { event, timestamp: new Date().toISOString(), data }
    for (const fn of [...listeners]) { try { fn(message) } catch { /* a bad listener must not stop the others */ } }
  }
  return emit(store, event, data)
}

// ----- what a playback event knows -----------------------------------------------------------
// The session row only says who, what file and how far. Everything else (which device, direct play
// or a live conversion, TMDB / IMDb / TVDB ids, show and episode numbers) comes from the server
// through setPlaybackContext(row) => { device, location, playback, transcode, media: { year, show,
// season, episode, ids: { tmdb, imdb, tvdb } } }. It is asked synchronously and must not wait on the
// network; any of it may be missing.
let playbackContext = null

function setPlaybackContext(fn) {
  playbackContext = typeof fn === 'function' ? fn : null
}

function contextFor(row) {
  if (!playbackContext) return {}
  try {
    const c = playbackContext(row)
    return c && typeof c === 'object' ? c : {}
  } catch {
    return {}
  }
}

const idOrNull = (v) => (v === undefined || v === null || v === '' ? null : v)

function playbackData(user, row, { state = 'playing', ctx = null, extra = {} } = {}) {
  const c = ctx || contextFor(row)
  const position = secs(row.currentTime)
  const duration = secs(row.duration)
  const m = c.media && typeof c.media === 'object' ? c.media : {}
  const ids = m.ids && typeof m.ids === 'object' ? m.ids : {}
  const media = {
    kind: kindOfRow(row),
    title: String(row.title || ''),
    year: idOrNull(m.year),
    ...(kindOfRow(row) === 'tv' ? { show: idOrNull(m.show), season: idOrNull(m.season), episode: idOrNull(m.episode) } : {}),
    ids: { tmdb: idOrNull(ids.tmdb), imdb: idOrNull(ids.imdb), tvdb: idOrNull(ids.tvdb) }
  }
  return {
    user: { id: user.id, name: user.name || user.username || '' },
    media,
    positionSeconds: position,
    durationSeconds: duration,
    percent: duration > 0 ? Math.min(100, Math.round((position / duration) * 100)) : 0,
    session: {
      id: sessionRef(row.sessionId),
      state,
      device: idOrNull(c.device),
      location: idOrNull(c.location),
      playback: c.playback === 'transcode' ? 'transcode' : 'direct',
      transcode: c.playback === 'transcode' && c.transcode && typeof c.transcode === 'object' ? c.transcode : null,
      startedAt: Number(row.startedAt) > 0 ? Number(row.startedAt) : null
    },
    ...extra
  }
}

const live = new Map()
let sweepTimer = null

function ensureSweeper() {
  if (sweepTimer) return
  sweepTimer = setInterval(() => sweepPlayback(Date.now()), settings.sweepEveryMs)
  if (sweepTimer.unref) sweepTimer.unref()
}

function stopSession(sessionId, s) {
  live.delete(sessionId)
  const user = mayAnnounce(s.store, s.userId)
  if (!user) return false
  publish(s.store, 'playback.stopped', playbackData(user, s.row, { state: 'stopped', ctx: s.ctx, extra: { sessionSeconds: secs((s.lastUpdate - s.startedAt) / 1000) } }))
  return true
}

// A session nobody has reported on for a minute and a half has stopped. A player that was closed
// cleanly says so (state "stopped"); one that lost its connection cannot, so silence is the signal.
function sweepPlayback(now = Date.now()) {
  let stopped = 0
  for (const [sessionId, s] of live) {
    if (now - s.lastUpdate < settings.stopAfterMs) continue
    if (stopSession(sessionId, s)) stopped++
  }
  if (!live.size && sweepTimer) { clearInterval(sweepTimer); sweepTimer = null }
  return stopped
}

const REPORTED_STATES = new Set(['playing', 'paused', 'stopped'])

// Players that do not say whether they are paused (the phone apps, a cast receiver) are read from
// their position: it did not move although real time did. A seek is a jump, not a pause.
function inferState(s, position, now) {
  const elapsed = (now - s.lastUpdate) / 1000
  if (elapsed < 5) return s.state
  const moved = position - secs(s.row.currentTime)
  if (Math.abs(moved) <= Math.max(1, elapsed * 0.2)) return 'paused'
  if (moved > elapsed * 0.5) return 'playing'
  return s.state
}

// history.js calls this: phase is 'started' | 'progress' | 'finished'; row is the session row;
// `report.state` is what the player said about itself ('playing' | 'paused' | 'stopped'), if anything.
function notePlayback(store, phase, row, report = {}) {
  try {
    if (!row || (!listeners.size && !wantsAnyOf(store, 'playback.'))) return
    const user = mayAnnounce(store, row.userId)
    if (!user) return
    const now = Date.now()
    const said = report && REPORTED_STATES.has(report.state) ? report.state : null
    if (phase === 'started') {
      if (live.size >= MAX_TRACKED_SESSIONS) live.delete(live.keys().next().value)
      const ctx = contextFor(row)
      live.set(row.sessionId, { store, userId: row.userId, row: { ...row }, startedAt: Number(row.startedAt) || now, lastUpdate: now, state: 'playing', ctx, lastProgressEmit: now })
      ensureSweeper()
      publish(store, 'playback.started', playbackData(user, row, { state: 'playing', ctx }))
    } else if (phase === 'progress') {
      let s = live.get(row.sessionId)
      if (!s) {
        // A session that began before anyone was listening (or before a restart): pick it up quietly.
        if (said === 'stopped') return
        if (live.size >= MAX_TRACKED_SESSIONS) live.delete(live.keys().next().value)
        s = { store, userId: row.userId, row: { ...row }, startedAt: Number(row.startedAt) || now, lastUpdate: now, state: 'playing', ctx: contextFor(row), lastProgressEmit: now }
        live.set(row.sessionId, s)
        ensureSweeper()
        return
      }
      const next = said || inferState(s, secs(row.currentTime), now)
      s.row = { ...s.row, currentTime: row.currentTime, duration: row.duration }
      s.lastUpdate = now
      if (next === 'stopped') { stopSession(row.sessionId, s); return }
      if (next !== s.state) {
        s.state = next
        s.ctx = contextFor(s.row)
        publish(store, next === 'paused' ? 'playback.paused' : 'playback.resumed', playbackData(user, s.row, { state: next, ctx: s.ctx }))
        s.lastProgressEmit = now
      } else if (next === 'playing' && now - s.lastProgressEmit >= settings.progressEveryMs) {
        s.lastProgressEmit = now
        s.ctx = contextFor(s.row)
        publish(store, 'playback.progress', playbackData(user, s.row, { state: 'playing', ctx: s.ctx }))
      }
    } else if (phase === 'finished') {
      const s = live.get(row.sessionId)
      publish(store, 'playback.watched', playbackData(user, row, { state: s ? s.state : 'playing', ctx: s ? s.ctx : null, extra: { source: 'playback' } }))
    }
  } catch {
    /* an announcement must never break a progress report */
  }
}

// Someone ticked things as watched by hand: one event per item that actually changed, capped so a
// "mark the whole show" is not a flood.
const MANUAL_WATCHED_CAP = 25
function emitManualWatched(store, userId, items) {
  try {
    if (!wantsEvent(store, 'playback.watched')) return 0
    const user = mayAnnounce(store, userId)
    if (!user) return 0
    let sent = 0
    for (const it of (items || []).slice(0, MANUAL_WATCHED_CAP)) {
      sent += emit(store, 'playback.watched', {
        user: { id: user.id, name: user.name || user.username || '' },
        media: { kind: it.kind === 'tv' ? 'tv' : 'movie', title: String(it.title || '') },
        source: 'manual'
      })
    }
    return sent
  } catch {
    return 0
  }
}

// ----- library -------------------------------------------------------------------------------

function libraryItemData(item) {
  return { item }
}

function emitLibraryItem(store, item) {
  return emit(store, 'library.item_added', libraryItemData(item))
}

function getStats() {
  return { delivered: stats.delivered, failed: stats.failed, queued: queue.length }
}

function _reset() {
  queue.length = 0
  live.clear()
  listeners.clear()
  playbackContext = null
  stats.delivered = 0
  stats.failed = 0
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null }
}

module.exports = {
  EVENTS,
  EVENT_IDS,
  TEST_EVENT,
  MAX_HOOKS,
  MAX_LOG,
  MAX_ATTEMPTS,
  configure,
  classifyAddress,
  parseTargetUrl,
  resolveTarget,
  sign,
  verifySignature,
  list,
  create,
  update,
  remove,
  rotateSecret,
  getLog,
  clearLog,
  emit,
  sendTest,
  wantsEvent,
  requestData,
  emitRequestAdded,
  emitRequestTransition,
  notePlayback,
  onEvent,
  listenerCount,
  setPlaybackContext,
  sessionRef,
  getStats,
  emitManualWatched,
  sweepPlayback,
  emitLibraryItem,
  whenIdle,
  _reset
}
