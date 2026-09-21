'use strict'
// ============================================================================
// watchTogetherHttp.js - Watch together over HTTP: JSON commands + Server-Sent Events.
// ----------------------------------------------------------------------------
// Mounted twice by streamServer.js, both times AFTER the sign-in gate, so a request
// only gets here with a signed-in person of this server:
//     /watch-together-api/*   the web player, signed in with the website's login cookie
//     /api/watch-together/*   the apps, signed in with a bearer token
//     /watch-together/join    the invite link people open (redirects into the player)
//
//   GET  /events?code=     Server-Sent Events: the room's state, chat, reactions (server -> viewer)
//   GET  /poll?code=&since= the same, as a plain request, for networks that break streams
//   GET  /room?code=       what an invite points at (title, host)
//   POST /create /join /leave /command /ready /chat /react /settings /transfer /kick /close /ping
//
// No new dependencies: an SSE stream is an ordinary long response, a command an ordinary POST.
// Every POST body is JSON, capped at 4 KB, and refused when it comes from another site (the
// cookie rides along on cross-site requests). Replies never carry HTML.
// ============================================================================

const wt = require('./watchTogether')

const BODY_MAX = 4096
const HEARTBEAT_MS = 15000
const SLOW_CLIENT_BYTES = 256 * 1024
const MAX_STREAMS = 400

const ERROR_TEXT = {
  unauthorized: 'Sign in to use Watch together.',
  not_found: 'That room has ended, or the link is not valid.',
  bad_media: 'That title cannot be shared.',
  unavailable: 'This account is not allowed to watch that title.',
  rate_limited: 'Slow down a little.',
  locked: 'Too many wrong codes. Try again in a few minutes.',
  room_full: 'That room is full.',
  too_many_rooms: 'You already have the most rooms open that you can. Close one first.',
  server_busy: 'This server is hosting as many rooms as it can right now.',
  not_allowed: 'Only the host can do that in this room.',
  chat_off: 'The host turned chat off.',
  empty: 'Type a message first.',
  too_long: 'That message is too long.',
  stale: 'The room moved on; try again.'
}

/** One Server-Sent Events frame. The event name is a fixed lowercase token; data is one JSON line per `data:`. */
function sseFrame(event, dataText, id) {
  const name = /^[a-z][a-z0-9-]{0,30}$/.test(String(event)) ? String(event) : 'message'
  let out = ''
  if (id !== undefined && id !== null && /^\d{1,15}$/.test(String(id))) out += `id: ${id}\n`
  out += `event: ${name}\n`
  // A frame ends at a blank line and a line ends at CR, LF or CRLF: split on all three so no payload can
  // ever start a second field or close the frame early.
  for (const line of String(dataText).split(/\r\n|\r|\n/)) out += `data: ${line}\n`
  return out + '\n'
}

function isCrossSite(headers) {
  const h = headers || {}
  const site = String(h['sec-fetch-site'] || '').toLowerCase()
  if (site === 'cross-site' || site === 'same-site') return true
  const origin = h.origin
  if (origin && origin !== 'null') {
    try { return new URL(String(origin)).host !== String(h.host || '') } catch { return true }
  }
  return origin === 'null'
}

async function readJson(req, max = BODY_MAX) {
  const declared = Number(req.headers && req.headers['content-length'])
  if (Number.isFinite(declared) && declared > max) { try { req.resume() } catch {} return { error: 413 } }
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > max) return { error: 413 } // leaving the loop stops reading the rest
    chunks.push(chunk)
  }
  if (!total) return { body: {} }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? { body: parsed } : { error: 400 }
  } catch {
    return { error: 400 }
  }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

function messagePage(message) {
  return '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Watch together</title>' +
    '<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:520px;margin:14vh auto;padding:0 22px;text-align:center;color:#222">' +
    `<h1 style="font-size:22px">${esc(message)}</h1><p><a href="/">Back to the library</a></p></div>`
}

/**
 * deps: { manager, getUser(userId) -> { id, name, username } | null, getClientIp(req), getOrigin() -> 'https://name.beebo.tv',
 *         log, setInterval (tests) }
 */
function createWatchTogetherHttp(deps) {
  const manager = deps.manager
  const log = deps.log || (() => {})
  const getIp = deps.getClientIp || ((req) => (req.socket && req.socket.remoteAddress) || '')
  const requestRate = wt.createRateLimiter({ limit: 300, windowMs: 60000 })
  const streamRate = wt.createRateLimiter({ limit: 30, windowMs: 60000 })
  const pingRate = wt.createRateLimiter({ limit: 60, windowMs: 60000 })
  let streams = 0

  const timer = (deps.setInterval || setInterval)(() => { try { manager.sweep() } catch (e) { log(`[watch-together] sweep failed: ${e && e.message}`) } }, 1000)
  if (timer && timer.unref) timer.unref()

  const userOf = (userId) => {
    const u = deps.getUser ? deps.getUser(userId) : null
    return u && u.id ? { id: u.id, name: u.name, username: u.username } : null
  }

  function reply(send, result) {
    if (result && result.ok) { send(200, result); return }
    const r = result || {}
    const status = r.status || 400
    const { status: _s, ...rest } = r
    send(status, { ...rest, ok: false, message: ERROR_TEXT[r.error] || 'That did not work.' })
  }

  function openStream(req, res, userId, code, lastEventId) {
    if (streams >= MAX_STREAMS) return { ok: false, status: 503, error: 'server_busy' }
    let attached = null
    let closed = false
    const cleanup = () => {
      if (closed) return
      closed = true
      streams--
      clearInterval(hb)
      if (attached) attached.detach()
    }
    const sink = {
      write(event, data, id) {
        if (closed) throw new Error('closed')
        if (res.writableLength > SLOW_CLIENT_BYTES) { cleanup(); try { res.destroy() } catch {} throw new Error('slow client') }
        res.write(sseFrame(event, data, id))
      },
      close() { cleanup(); try { res.end() } catch {} }
    }
    // Check the seat before committing to a stream response.
    const probe = manager.poll({ userId, code })
    if (!probe.ok) return probe
    streams++
    try { req.socket.setKeepAlive(true); req.socket.setNoDelay(true); req.socket.setTimeout(0) } catch {}
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff'
    })
    res.write('retry: 3000\n\n')
    const hb = setInterval(() => { try { if (!closed) res.write(': hb\n\n') } catch { cleanup() } }, HEARTBEAT_MS)
    if (hb.unref) hb.unref()
    req.on('close', cleanup)
    res.on('error', cleanup)
    attached = manager.attach({ userId, code, sink, lastEventId })
    if (!attached.ok) { cleanup(); try { res.end() } catch {} }
    return { streaming: true }
  }

  /** The API. `sub` is the path after the mount point, e.g. '/command'. Returns true when it answered. */
  async function handle(req, res, url, sub, ctx) {
    const send = ctx.send
    const userId = ctx.userId
    const method = req.method
    const ip = getIp(req)
    const user = userOf(userId)
    if (!userId || !user) { send(401, { ok: false, error: 'unauthorized', message: ERROR_TEXT.unauthorized }); return true }
    const gate = requestRate.hit('u:' + userId)
    if (!gate.ok) { reply(send, { ok: false, status: 429, error: 'rate_limited', retryAfterSeconds: gate.retryAfterSeconds }); return true }
    const q = (k) => url.searchParams.get(k) || ''

    if (method === 'GET' && sub === '/events') {
      const s = streamRate.hit('u:' + userId)
      if (!s.ok) { reply(send, { ok: false, status: 429, error: 'rate_limited', retryAfterSeconds: s.retryAfterSeconds }); return true }
      const out = openStream(req, res, userId, q('code'), req.headers['last-event-id'] || q('since'))
      if (!out.streaming) reply(send, out)
      return true
    }
    if (method === 'GET' && sub === '/poll') {
      reply(send, manager.poll({ userId, code: q('code'), since: q('since') }))
      return true
    }
    if (method === 'GET' && sub === '/room') {
      reply(send, await manager.preview({ user, code: q('code'), ip }))
      return true
    }
    if (method !== 'POST') return false

    // Everything below changes something: JSON only, from this site only, small.
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] || '')) || isCrossSite(req.headers)) {
      try { req.resume() } catch {}
      send(415, { ok: false, error: 'json_only' })
      return true
    }
    const parsed = await readJson(req)
    if (parsed.error) { send(parsed.error, { ok: false, error: parsed.error === 413 ? 'too_long' : 'bad_request', message: ERROR_TEXT.too_long }); return true }
    const b = parsed.body
    const code = typeof b.code === 'string' ? b.code : ''

    switch (sub) {
      case '/create':
        reply(send, await manager.createRoom({ user, media: { kind: b.kind, id: b.id, title: b.title }, settings: b.settings, ip }))
        return true
      case '/join':
        reply(send, await manager.join({ user, code, ip }))
        return true
      case '/leave':
        reply(send, manager.leave({ userId, code }))
        return true
      case '/command': {
        if (b.type === 'next' || b.type === 'media') { reply(send, await manager.changeMedia({ userId, code, media: { kind: b.kind, id: b.id, title: b.title } })); return true }
        reply(send, manager.command({ userId, code, cmd: b }))
        return true
      }
      case '/ready':
        reply(send, manager.ready({ userId, code, ready: b.ready, seq: b.seq, duration: b.duration }))
        return true
      case '/chat':
        reply(send, manager.chat({ userId, code, text: b.text }))
        return true
      case '/react':
        reply(send, manager.react({ userId, code, emoji: b.emoji }))
        return true
      case '/settings':
        reply(send, manager.setSettings({ userId, code, settings: b.settings || b }))
        return true
      case '/transfer':
        reply(send, manager.transferHost({ userId, code, target: b.target }))
        return true
      case '/kick':
        reply(send, manager.kick({ userId, code, target: b.target }))
        return true
      case '/close':
        reply(send, manager.close({ userId, code }))
        return true
      case '/ping': {
        const t1 = manager.now()
        const p = pingRate.hit('u:' + userId)
        if (!p.ok) { reply(send, { ok: false, status: 429, error: 'rate_limited', retryAfterSeconds: p.retryAfterSeconds }); return true }
        send(200, manager.pingReply(b.t0, t1))
        return true
      }
      default:
        return false
    }
  }

  /** GET /watch-together/join?code= : the address an invite is. Sends the person into the player. */
  async function landing(req, res, url, ctx) {
    const userId = ctx.userId
    const user = userOf(userId)
    const page = (status, message) => {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
      res.end(messagePage(message))
    }
    if (!user) { res.writeHead(302, { Location: '/login' }); res.end(); return }
    const code = wt.normalizeCode(url.searchParams.get('code') || '')
    const found = await manager.preview({ user, code, ip: getIp(req) })
    if (!found.ok) {
      page(found.status === 429 ? 429 : 404, found.status === 429 ? ERROR_TEXT.locked : ERROR_TEXT.not_found)
      return
    }
    const sep = found.media.href.includes('?') ? '&' : '?'
    res.writeHead(302, { Location: `${found.media.href}${sep}wt=${code}`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
    res.end()
  }

  /** The desktop app: start a room for the owner and get the invite link back. */
  async function createInvite({ userId, kind, id, title }) {
    const user = userOf(userId)
    if (!user) return { ok: false, error: 'unauthorized' }
    const made = await manager.createRoom({ user, media: { kind, id, title } })
    if (!made.ok) return { ...made, message: ERROR_TEXT[made.error] || 'That did not work.' }
    const path = `/watch-together/join?code=${made.code}`
    let origin = ''
    try { origin = deps.getOrigin ? String(deps.getOrigin() || '') : '' } catch {}
    return { ok: true, code: made.code, invitePath: path, inviteUrl: origin ? origin + path : path, watchPath: `${made.room.media.href}&wt=${made.code}` }
  }

  function close() {
    clearInterval(timer)
    try { manager.closeAll('server_stopped') } catch {}
  }

  return { handle, landing, createInvite, close, manager }
}

module.exports = { createWatchTogetherHttp, sseFrame, isCrossSite, readJson, messagePage, ERROR_TEXT, BODY_MAX }
