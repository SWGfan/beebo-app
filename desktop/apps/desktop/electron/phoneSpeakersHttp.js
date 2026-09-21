'use strict'
// ============================================================================
// phoneSpeakersHttp.js - Phone speakers over HTTP: JSON calls, Server-Sent Events, the audio pieces and the guest page.
// ----------------------------------------------------------------------------
// Two doors, and only these:
//
//   PUBLIC (no sign-in, for guests' phones and the room's screen), mounted before the sign-in gate by streamServer.js:
//     GET  /speakers/join                   the phone page (static: no room data in it; the key is in the address you scanned)
//     GET  /speakers/client.js              the phone / screen script (the same file the tests run)
//     POST /speakers/api/join               { k, name, token? }  the room code is the key
//     GET  /speakers/api/events             Server-Sent Events (token in the X-Speaker-Token HEADER)
//     GET  /speakers/api/poll               the same as one request, for networks that break streams
//     POST /speakers/api/ping|status|tune|leave
//     POST /speakers/api/host/command|sync|settings|seat|autoseat|beep|kick|close     the room's SCREEN token only
//     GET  /speakers/api/host/info          the join link + QR code (screen token only: the room code is the key)
//     GET  /speakers/audio/<FEED>/<n>.wav   one 5-second mono piece of this room's film, for a token of this room
//   OWNER (signed in as a person of this server; mounted after the sign-in gate as /phone-speakers-api/*):
//     POST /create { kind, id, title? } -> a room for a film the person may watch (parental controls), with the screen token
//     POST /resume { code }             -> a fresh screen token for the person's own room (the player page reloaded)
//     GET  /mine                        -> the person's rooms
//
// Guests need no account, so nothing here can rely on a session cookie: every guest call carries a token in a custom header
// (a web page on another site cannot send one without a CORS preflight, which this server never answers). Every POST is JSON,
// capped at 4 KB, and refused when it says it comes from another site. Replies never carry HTML. Requests from outside the
// home network are refused unless the owner switched that on (the sound is timed for a living room, not the internet).
// ============================================================================

const fs = require('fs')
const path = require('path')
const wtHttp = require('./watchTogetherHttp')
const ch = require('./phoneSpeakersChannels')

const BODY_MAX = 4096
const HEARTBEAT_MS = 15000
const SLOW_CLIENT_BYTES = 256 * 1024
const MAX_STREAMS = 64

const ERROR_TEXT = {
  unauthorized: 'This phone is not part of the room any more.',
  not_found: 'That room has ended, or the link is not valid.',
  locked: 'Too many wrong tries. Wait a few minutes.',
  rate_limited: 'Slow down a little.',
  room_full: 'That room is full.',
  room_locked: 'The host has closed the room to new phones.',
  not_allowed: 'Only the screen can do that.',
  bad_media: 'That title cannot be shared.',
  unavailable: 'This account is not allowed to watch that title.',
  no_audio: 'This film has no sound to share.',
  server_busy: 'The computer is busy with other rooms or conversions.',
  disabled: 'Phone speakers are switched off in Settings.',
  home_only: 'Phone speakers only work on the home network.',
  stale: 'The room moved on; asking again.',
  bad_mode: 'That is not a mode.',
  bad_seat: 'That is not a seat.',
  no_such_guest: 'That phone is not in the room.',
  json_only: 'That request was not accepted.'
}

const PAGE_CSS = `
:root{color-scheme:dark;--bg:#0f1116;--card:#181b23;--fg:#f2f4f8;--mut:#9aa3b5;--ac:#5aa9ff;--good:#3ecf7a;--warn:#f0b429;--bad:#f0616d}
*{box-sizing:border-box}[hidden]{display:none!important}html,body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
main{max-width:520px;margin:0 auto;padding:max(16px,env(safe-area-inset-top)) 16px 40px}
.spk-card{background:var(--card);border-radius:18px;padding:18px 16px;box-shadow:0 8px 30px rgba(0,0,0,.4)}
.spk-title{font-size:22px;margin:0 0 4px;word-break:break-word}.spk-sub{color:var(--mut);margin:0 0 14px}
.spk-h2{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--mut);margin:18px 0 6px}
.spk-label{display:block;color:var(--mut);font-size:14px;margin:6px 0}
.spk-input{width:100%;padding:12px;font-size:18px;border-radius:10px;border:1px solid #333a49;background:#0f1218;color:var(--fg)}
.spk-btn{font:inherit;font-weight:600;border:0;border-radius:12px;padding:12px 16px;color:var(--fg);background:#2a3040;cursor:pointer;min-height:44px}
.spk-btn:disabled{opacity:.5}.spk-primary{background:var(--ac);color:#04121f;margin-top:12px;width:100%}
.spk-gate{width:100%;background:var(--warn);color:#241a00;font-size:20px;padding:18px;margin:12px 0}
.spk-danger{margin-top:18px;background:#3a2226;color:#ffb3ba;width:100%}.spk-small{padding:8px 12px;min-height:38px}
.spk-seat{background:#0f1218;border-radius:14px;padding:14px;margin:8px 0;text-align:center}
.spk-seat-big{font-size:28px;font-weight:700}.spk-seat-small{color:var(--mut);margin-top:4px;font-size:14px}
.spk-sync{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:10px 0}.spk-sync-detail{color:var(--mut);margin-left:auto}
.spk-dot{width:12px;height:12px;border-radius:50%;background:#555;display:inline-block;flex:none}
[data-level=good]>.spk-dot,.spk-dot[data-level=good]{background:var(--good)}[data-level=warn]>.spk-dot,.spk-dot[data-level=warn]{background:var(--warn)}
[data-level=bad]>.spk-dot,.spk-dot[data-level=bad]{background:var(--bad)}.spk-dot[data-level=away]{background:#555}.spk-dot[data-level=locked]{background:var(--warn)}
.spk-notice{background:#2b2410;border:1px solid #6d5a1a;border-radius:10px;padding:10px 12px;margin:10px 0;font-size:14px}
.spk-beep{background:#10233a;border:1px solid #2b5a8f;border-radius:10px;padding:10px 12px;font-size:14px}
.spk-row{display:flex;align-items:center;gap:10px;margin:10px 0}.spk-row .spk-label{width:70px;margin:0}.spk-range{flex:1}.spk-trim{min-width:70px;text-align:center;font-variant-numeric:tabular-nums}
.spk-help{display:block;color:var(--mut);font-size:13px}.spk-check{gap:8px;font-size:14px}
.spk-roster{list-style:none;margin:0;padding:0}.spk-person{display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid #232838}
.spk-pn{flex:1;word-break:break-word}.spk-ps{color:var(--mut)}.spk-line{color:var(--mut);min-height:1.4em}
`

/** The phone page: no data in it at all. The script reads the key from the address and removes it from the address bar. */
function guestPage() {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
    '<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow">' +
    '<title>Phone speaker</title><style>' + PAGE_CSS + '</style></head><body>' +
    '<main id="spk-root"><p>Loading...</p></main><noscript><main><p>This page needs JavaScript.</p></main></noscript>' +
    '<script src="/speakers/client.js"></script></body></html>'
}
const PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; media-src 'self' blob: data:; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

let clientCache = null
let clientStamp = ''
function clientSource() {
  const file = path.join(__dirname, 'phoneSpeakersClient.js')
  let stamp = ''
  try { const st = fs.statSync(file); stamp = `${st.size}:${st.mtimeMs}` } catch {}
  if (!clientCache || stamp !== clientStamp) { clientCache = fs.readFileSync(file, 'utf8'); clientStamp = stamp } // re-read only when the file changed
  return clientCache
}

/**
 * deps: { manager, audio, getSession(audioKey) -> audio session | null, getIp(req), isHomeRequest(req), isEnabled(), allowRemote(),
 *         getJoinOrigins() -> ['http://192.168.1.20:47811', ...] best first, qrSvg(text, opts), getUser(userId), log, setInterval (tests) }
 */
function createPhoneSpeakersHttp(deps) {
  const manager = deps.manager
  const log = deps.log || (() => {})
  const getIp = deps.getIp || ((req) => (req.socket && req.socket.remoteAddress) || '')
  let streams = 0
  const timer = (deps.setInterval || setInterval)(() => { try { manager.sweep() } catch (e) { log(`[phone-speakers] sweep failed: ${e && e.message}`) } }, 1000)
  if (timer && timer.unref) timer.unref()
  const ipRate = require('./watchTogether').createRateLimiter({ limit: 900, windowMs: 60000 })

  const claims = (pathname) => pathname === '/speakers' || pathname.startsWith('/speakers/')

  function sendJson(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' })
    res.end(JSON.stringify(obj))
  }
  function reply(res, result) {
    if (result && result.ok) { sendJson(res, 200, result); return }
    const r = result || {}
    const { status: st, ...rest } = r
    sendJson(res, st || 400, { ...rest, ok: false, message: r.message || ERROR_TEXT[r.error] || 'That did not work.' })
  }
  const tokenOf = (req) => { const t = req.headers['x-speaker-token']; return typeof t === 'string' ? t : '' }
  const homeOk = (req) => (deps.isHomeRequest ? !!deps.isHomeRequest(req) : true) || (deps.allowRemote ? !!deps.allowRemote() : false)

  function openStream(req, res, token) {
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
        res.write(wtHttp.sseFrame(event, data, id))
      },
      close() { cleanup(); try { res.end() } catch {} }
    }
    const probe = manager.poll({ token })
    if (!probe.ok) return probe
    streams++
    try { req.socket.setKeepAlive(true); req.socket.setNoDelay(true); req.socket.setTimeout(0) } catch {}
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'
    })
    res.write('retry: 3000\n\n')
    const hb = setInterval(() => { try { if (!closed) res.write(': hb\n\n') } catch { cleanup() } }, HEARTBEAT_MS)
    if (hb.unref) hb.unref()
    req.on('close', cleanup)
    res.on('error', cleanup)
    attached = manager.attach({ token, sink })
    if (!attached.ok) { cleanup(); try { res.end() } catch {} }
    return { streaming: true }
  }

  function joinLinks(code) {
    let origins = []
    try { origins = deps.getJoinOrigins ? deps.getJoinOrigins().map(String) : (deps.getJoinOrigin ? [String(deps.getJoinOrigin() || '')] : []) } catch {}
    const origin = origins[0] || ''
    const urlOf = (o) => `${o}/speakers/join?k=${encodeURIComponent(code)}`
    const url = urlOf(origin)
    let qr = ''
    try { qr = deps.qrSvg ? deps.qrSvg(url, { size: 260, margin: 2, label: 'Scan to join with your phone' }) : '' } catch {}
    // the other addresses this computer has, for "the QR code does not work" (a phone on a different network name, a guest network)
    return { joinUrl: url, qrSvg: qr, origin, otherUrls: origins.slice(1, 4).map(urlOf) }
  }

  // ---------------------------------------------------------------- the audio pieces
  async function serveAudio(req, res, url) {
    const m = /^\/speakers\/audio\/([A-Z]{2,3})\/(\d{1,6})\.wav$/.exec(url.pathname)
    if (!m || req.method !== 'GET') { sendJson(res, 404, { ok: false, error: 'not_found' }); return }
    const feed = m[1]
    const n = Number(m[2])
    if (!ch.isFeed(feed)) { sendJson(res, 404, { ok: false, error: 'not_found' }); return }
    const access = manager.audioAccess({ token: tokenOf(req), seq: req.headers['x-speaker-seq'] })
    if (!access.ok) { reply(res, access); return }
    const session = deps.getSession ? deps.getSession(access.audioKey) : null
    if (!session) { sendJson(res, 410, { ok: false, error: 'gone', message: 'The sound for this film is no longer available.' }); return }
    let aborted = false
    req.on('close', () => { aborted = true })
    let file
    try {
      file = await deps.audio.segment(session, feed, n, { aborted: () => aborted })
    } catch (e) {
      log(`[phone-speakers] audio piece failed: ${String(e && e.message || e).slice(0, 160)}`)
      res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '2', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ ok: false, error: 'not_ready', message: 'The computer could not prepare the sound yet.' }))
      return
    }
    if (aborted) return
    if (!file) { sendJson(res, 404, { ok: false, error: 'not_found' }); return }
    let size = 0
    try { size = fs.statSync(file).size } catch { sendJson(res, 404, { ok: false, error: 'not_found' }); return }
    res.writeHead(200, {
      'Content-Type': 'audio/wav', 'Content-Length': size, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'
    })
    const stream = fs.createReadStream(file)
    stream.on('error', () => { try { res.destroy() } catch {} })
    res.on('close', () => { try { stream.destroy() } catch {} })
    stream.pipe(res)
  }

  // ---------------------------------------------------------------- the public door
  /** Returns true when it answered (everything under /speakers is ours). */
  async function handle(req, res, url) {
    const p = url.pathname
    if (!deps.isEnabled || deps.isEnabled()) { /* on */ } else { sendJson(res, 404, { ok: false, error: 'disabled', message: ERROR_TEXT.disabled }); return true }
    if (!homeOk(req)) { sendJson(res, 403, { ok: false, error: 'home_only', message: ERROR_TEXT.home_only }); return true }
    const ip = getIp(req)
    const gate = ipRate.hit('ip:' + ip)
    if (!gate.ok) { reply(res, { ok: false, status: 429, error: 'rate_limited', retryAfterSeconds: gate.retryAfterSeconds }); return true }

    if (p === '/speakers/join' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': PAGE_CSP, 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' })
      res.end(guestPage())
      return true
    }
    if (p === '/speakers/client.js' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' })
      res.end(clientSource())
      return true
    }
    if (p.startsWith('/speakers/audio/')) { await serveAudio(req, res, url); return true }
    if (!p.startsWith('/speakers/api/')) { sendJson(res, 404, { ok: false, error: 'not_found' }); return true }
    const sub = p.slice('/speakers/api'.length)
    const token = tokenOf(req)

    if (req.method === 'GET' && sub === '/events') {
      const out = openStream(req, res, token)
      if (!out.streaming) reply(res, out)
      return true
    }
    if (req.method === 'GET' && sub === '/poll') { reply(res, manager.poll({ token })); return true }
    if (req.method === 'GET' && sub === '/host/info') {
      const info = manager.hostInfo({ token })
      if (!info.ok) { reply(res, info); return true }
      reply(res, { ok: true, ...joinLinks(info.code), code: info.code })
      return true
    }
    if (req.method !== 'POST') { sendJson(res, 404, { ok: false, error: 'not_found' }); return true }

    // everything below changes something: JSON only, from this site only, small
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] || '')) || wtHttp.isCrossSite(req.headers)) {
      try { req.resume() } catch {}
      sendJson(res, 415, { ok: false, error: 'json_only', message: ERROR_TEXT.json_only })
      return true
    }
    const parsed = await wtHttp.readJson(req, BODY_MAX)
    if (parsed.error) { sendJson(res, parsed.error, { ok: false, error: parsed.error === 413 ? 'too_long' : 'bad_request', message: 'That request was not accepted.' }); return true }
    const b = parsed.body
    switch (sub) {
      case '/join': {
        const ua = /iPhone|iPad|iPod/.test(String(req.headers['user-agent'] || '')) ? 'ios' : /Android/.test(String(req.headers['user-agent'] || '')) ? 'android' : 'other'
        const j = manager.join({ code: typeof b.k === 'string' ? b.k : '', name: b.name, token: typeof b.token === 'string' ? b.token : '', ip, ua })
        reply(res, j)
        return true
      }
      case '/leave': reply(res, manager.leave({ token })); return true
      case '/status': reply(res, manager.status({ token, status: b.status })); return true
      case '/tune': reply(res, manager.tune({ token, target: typeof b.target === 'string' ? b.target : '', patch: b.patch })); return true
      case '/ping': {
        const t1 = manager.now()
        reply(res, manager.ping({ token, t0: b.t0, t1 }))
        return true
      }
      case '/host/command': reply(res, manager.command({ token, cmd: b })); return true
      case '/host/sync': reply(res, manager.sync({ token, seq: b.seq, pos: b.pos, at: b.at })); return true
      case '/host/settings': reply(res, manager.setSettings({ token, settings: b.settings || b })); return true
      case '/host/seat': reply(res, manager.setSeat({ token, gid: b.gid, seat: b.seat })); return true
      case '/host/autoseat': reply(res, manager.autoSeat({ token })); return true
      case '/host/beep': reply(res, manager.beep({ token, action: b.action, pattern: b.pattern })); return true
      case '/host/kick': reply(res, manager.kick({ token, gid: b.gid })); return true
      case '/host/close': reply(res, manager.close({ token })); return true
      default: sendJson(res, 404, { ok: false, error: 'not_found' }); return true
    }
  }

  // ---------------------------------------------------------------- the owner's door (signed in)
  /** sub is '/create', '/resume' or '/mine'. ctx: { userId, send(status, obj) }. Returns true when it answered. */
  async function handleOwner(req, res, url, sub, ctx) {
    const send = ctx.send
    const userId = ctx.userId
    const user = deps.getUser ? deps.getUser(userId) : null
    if (!userId || !user) { send(401, { ok: false, error: 'unauthorized', message: 'Sign in to start phone speakers.' }); return true }
    if (deps.isEnabled && !deps.isEnabled()) { send(403, { ok: false, error: 'disabled', message: ERROR_TEXT.disabled }); return true }
    if (req.method === 'GET' && sub === '/mine') { send(200, { ok: true, rooms: manager.roomsOf(userId) }); return true }
    if (req.method !== 'POST') return false
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] || '')) || wtHttp.isCrossSite(req.headers)) { try { req.resume() } catch {} send(415, { ok: false, error: 'json_only' }); return true }
    const parsed = await wtHttp.readJson(req, BODY_MAX)
    if (parsed.error) { send(parsed.error, { ok: false, error: 'bad_request' }); return true }
    const b = parsed.body
    if (sub === '/create') {
      const made = await manager.createRoom({ user, media: { kind: b.kind, id: b.id, title: b.title }, mode: b.mode, settings: b.settings && typeof b.settings === 'object' ? b.settings : (deps.defaults ? deps.defaults() : undefined) })
      if (!made.ok) { const { status: st, ...rest } = made; send(st || 400, { ...rest, message: made.message || ERROR_TEXT[made.error] || 'That did not work.' }); return true }
      send(200, { ok: true, resumed: !!made.resumed, code: made.code, token: made.token, gid: made.gid, room: made.room, ...joinLinks(made.code) })
      return true
    }
    if (sub === '/resume') {
      const r = manager.resumeHost({ userId, code: typeof b.code === 'string' ? b.code : '' })
      if (!r.ok) { const { status: st, ...rest } = r; send(st || 404, { ...rest, message: ERROR_TEXT[r.error] || 'That did not work.' }); return true }
      send(200, { ok: true, code: r.code, token: r.token, gid: r.gid, room: r.room, ...joinLinks(r.code) })
      return true
    }
    return false
  }

  /** The desktop app: start a room for the owner. Returns { ok, code, token, joinUrl, ... } */
  async function createForOwner({ userId, kind, id, title }) {
    const user = deps.getUser ? deps.getUser(userId) : null
    if (!user) return { ok: false, error: 'unauthorized' }
    if (deps.isEnabled && !deps.isEnabled()) return { ok: false, error: 'disabled', message: ERROR_TEXT.disabled }
    const made = await manager.createRoom({ user, media: { kind, id, title }, settings: deps.defaults ? deps.defaults() : undefined })
    if (!made.ok) return { ...made, message: made.message || ERROR_TEXT[made.error] || 'That did not work.' }
    return { ok: true, code: made.code, token: made.token, ...joinLinks(made.code) }
  }

  function close() {
    clearInterval(timer)
    try { manager.closeAll('server_stopped') } catch {}
  }

  return { claims, handle, handleOwner, createForOwner, close, manager, joinLinks, guestPage, clientSource }
}

module.exports = { createPhoneSpeakersHttp, guestPage, clientSource, ERROR_TEXT, PAGE_CSP, PAGE_CSS }
