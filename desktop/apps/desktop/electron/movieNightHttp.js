'use strict'
// ============================================================================
// movieNightHttp.js - Movie Night over HTTP: the TV page, the join page, JSON actions and Server-Sent Events.
// ----------------------------------------------------------------------------
// Mounted by streamServer.js in two places:
//   handlePublic  BEFORE the sign-in gate (guests have no account):
//        GET  /tv  /movie-night  /movie-night/tv     the shared-screen page (any browser, TV web app, Android TV WebView)
//        GET  /movie-night/join?c=<code>&k=<key>     the phone page (the QR opens this)
//        GET  /movie-night-api/events?ticket=        Server-Sent Events (server -> screen)
//        GET  /movie-night-api/poll?ticket=&since=   the same as one request, for networks that break streams
//        GET  /movie-night-api/preview?c=&k=         "is this room real?" for the join page
//        GET  /movie-night-api/search?ticket=&q=     "suggest a movie" search (guests, only when the owner allows)
//        GET  /movie-night-api/tv/info?ticket=       what the TV needs to draw the QR (join address + QR modules)
//        POST /movie-night-api/tv/create  join  act  JSON bodies
//   handleAuthed  AFTER bearer-token sign-in (the TV apps and the desktop app):
//        POST /api/movie-night/tv/create             a signed-in TV app starts a room as that person
//        GET  /api/movie-night/status
//
// Nothing here needs the internet: pages are self-contained (no third-party scripts, fonts or images).
// Every POST is JSON, at most 2 KB, and refused when it comes from another site. Replies never carry HTML.
// By default (owner setting "home network only") every route answers only on the home network.
// ============================================================================

const mn = require('./movieNight')
const { sseFrame, isCrossSite, readJson } = require('./watchTogetherHttp')
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const { createRateLimiter } = require('./watchTogether')
const web = require('./movieNightWeb')

const BODY_MAX = 2048
const HEARTBEAT_MS = 15000
const SLOW_CLIENT_BYTES = 128 * 1024
const MAX_STREAMS = 300
const MAX_STREAMS_PER_ADDRESS = 16

const ERROR_TEXT = {
  disabled: 'Movie Night is turned off on this server.',
  home_only: 'Movie Night works on the home Wi-Fi. Connect to it and try again.',
  sign_in_needed: 'Sign in on this screen first, then open Movie Night again.',
  not_found: 'That Movie Night has ended, or the link is not right. Ask the host to show the code again.',
  locked: 'Too many wrong tries. Wait a few minutes and try again.',
  locked_room: 'The host has locked this room.',
  room_full: 'This room is full.',
  bad_name: 'Pick a short nickname (no web addresses).',
  name_taken: 'Someone here already has that nickname.',
  color_taken: 'Someone here already has that colour.',
  rate_limited: 'Slow down a little.',
  server_busy: 'This server is running as many Movie Nights as it can right now.',
  not_allowed: 'Only the host can do that.',
  not_open: 'That is not open right now.',
  bad_answer: 'That answer is not valid.',
  bad_reaction: 'That reaction is not available.',
  suggestions_off: 'The host has not turned on suggestions.',
  already_suggested: 'That film is already on the list.',
  ballot_full: 'The list is full.',
  too_many_suggestions: 'You have used your suggestions.',
  no_players: 'Nobody has joined yet.',
  not_enough_titles: 'There are not enough films with details saved for that game yet.',
  game_off: 'The owner turned that game off.',
  unknown_game: 'That game is not available.',
  busy: 'A game is already running.',
  nothing_to_play: 'There is no film picked yet.',
  paused: 'The game is paused.',
  json_only: 'Not accepted.',
  bad_request: 'That did not work.',
  too_long: 'That was too long.',
  unauthorized: 'Sign in first.'
}

const isLoopbackHost = (h) => /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/i.test(String(h || ''))

function createMovieNightHttp(deps) {
  const manager = deps.manager
  const log = deps.log || (() => {})
  const getIp = deps.getClientIp || ((req) => (req.socket && req.socket.remoteAddress) || '')
  const isHome = deps.isHomeRequest || (() => true)
  const getSettings = deps.getSettings || (() => mn.normalizeSettings(null))
  const qrOf = deps.qrModules || defaultQr
  const requestRate = createRateLimiter({ limit: 900, windowMs: 60000 })
  const streamRate = createRateLimiter({ limit: 40, windowMs: 60000 })
  const infoRate = createRateLimiter({ limit: 60, windowMs: 60000 })
  const perAddress = new Map()
  let streams = 0

  const timer = (deps.setInterval || setInterval)(() => { try { manager.sweep() } catch (e) { log(`[movie-night] sweep failed: ${e && e.message}`) } }, 250)
  if (timer && timer.unref) timer.unref()

  const sendJson = (res, status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' })
    res.end(JSON.stringify(obj))
  }
  function reply(res, result) {
    if (result && result.ok) { sendJson(res, 200, result); return }
    const r = result || {}
    const { status, ...rest } = r
    sendJson(res, status || 400, { ...rest, ok: false, message: ERROR_TEXT[r.error] || 'That did not work.' })
  }
  const sendPage = (res, status, html) => {
    const body = Buffer.from(html, 'utf8')
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' })
    res.end(body)
  }
  const messagePage = (res, status, message) => sendPage(res, status, web.messagePageHtml(esc(message)))

  function gate(req) {
    const s = getSettings()
    if (!s.enabled) return { status: 404, error: 'disabled' }
    if (s.homeOnly && !isHome(req)) return { status: 403, error: 'home_only' }
    return null
  }

  // ---- streams ---------------------------------------------------------------------------------------
  function openStream(req, res, ticket, ip) {
    if (streams >= MAX_STREAMS || (perAddress.get(ip) || 0) >= MAX_STREAMS_PER_ADDRESS) return { ok: false, status: 503, error: 'server_busy' }
    let attached = null
    let closed = false
    let hb = null
    const cleanup = () => {
      if (closed) return
      closed = true
      streams--
      perAddress.set(ip, Math.max(0, (perAddress.get(ip) || 1) - 1))
      if (!perAddress.get(ip)) perAddress.delete(ip)
      clearInterval(hb)
      if (attached && attached.detach) attached.detach()
    }
    const sink = {
      write(event, data, id) {
        if (closed) throw new Error('closed')
        if (res.writableLength > SLOW_CLIENT_BYTES) { cleanup(); try { res.destroy() } catch { /* gone */ } throw new Error('slow client') }
        res.write(sseFrame(event, data, id))
      },
      close() { cleanup(); try { res.end() } catch { /* gone */ } }
    }
    // Check the ticket before committing to a stream response.
    const probe = manager.poll({ ticket })
    if (!probe.ok) return probe
    streams++
    perAddress.set(ip, (perAddress.get(ip) || 0) + 1)
    try { req.socket.setKeepAlive(true); req.socket.setNoDelay(true); req.socket.setTimeout(0) } catch { /* fine */ }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'
    })
    res.write('retry: 2000\n\n')
    hb = setInterval(() => { try { if (!closed) res.write(': hb\n\n') } catch { cleanup() } }, HEARTBEAT_MS)
    if (hb.unref) hb.unref()
    req.on('close', cleanup)
    res.on('error', cleanup)
    attached = manager.attach({ ticket, sink })
    if (!attached.ok) { cleanup(); try { res.end() } catch { /* gone */ } }
    return { streaming: true }
  }

  function joinBase(req) {
    try { return deps.getJoinBase ? String(deps.getJoinBase(req) || '') : '' } catch { return '' }
  }

  function tvInfo(req, ticket) {
    const who = manager.lookup(ticket)
    if (!who || who.role !== 'tv') return { ok: false, status: 404, error: 'not_found' }
    const base = joinBase(req) || `${req.socket && req.socket.encrypted ? 'https' : 'http'}://${String(req.headers.host || '')}`
    const room = who.room
    const url = `${base}/movie-night/join?c=${room.code}&k=${room.joinKey}`
    const codeUrl = `${base.replace(/^https?:\/\//, '')}/movie-night/join`
    return { ok: true, joinUrl: url, codeAddress: codeUrl, code: room.code, qr: qrOf(url), loopback: isLoopbackHost(req.headers.host) }
  }

  // ---- the routes --------------------------------------------------------------------------------------
  const TV_PAGES = new Set(['/tv', '/tv/', '/movie-night', '/movie-night/', '/movie-night/tv'])

  function claimsPublic(pathname) {
    return TV_PAGES.has(pathname) || pathname === '/movie-night/join' || pathname.startsWith('/movie-night-api/')
  }

  async function handlePublic(req, res, url) {
    const p = url.pathname
    const method = req.method
    const ip = getIp(req)
    const q = (k) => url.searchParams.get(k) || ''
    const denied = gate(req)

    if (method === 'GET' || method === 'HEAD') {
      if (TV_PAGES.has(p)) {
        if (denied) { messagePage(res, denied.status, ERROR_TEXT[denied.error]); return true }
        sendPage(res, 200, web.tvPageHtml({ sounds: getSettings().sounds }))
        return true
      }
      if (p === '/movie-night/join') {
        if (denied) { messagePage(res, denied.status, ERROR_TEXT[denied.error]); return true }
        sendPage(res, 200, web.joinPageHtml({ code: mn.normalizeCode(q('c')), key: mn.normalizeKey(q('k')) }))
        return true
      }
    }
    if (!p.startsWith('/movie-night-api/')) return false
    const sub = p.slice('/movie-night-api'.length)

    if (denied) { reply(res, { ok: false, status: denied.status, error: denied.error }); return true }
    const rate = requestRate.hit('ip:' + ip)
    if (!rate.ok) { reply(res, { ok: false, status: 429, error: 'rate_limited', retryAfterSeconds: rate.retryAfterSeconds }); return true }

    if (method === 'GET') {
      if (sub === '/events') {
        const s = streamRate.hit('ip:' + ip)
        if (!s.ok) { reply(res, { ok: false, status: 429, error: 'rate_limited', retryAfterSeconds: s.retryAfterSeconds }); return true }
        const out = openStream(req, res, q('ticket'), ip)
        if (!out.streaming) reply(res, out)
        return true
      }
      if (sub === '/poll') { reply(res, manager.poll({ ticket: q('ticket'), since: q('since') })); return true }
      if (sub === '/preview') { reply(res, manager.preview({ code: q('c'), key: q('k'), ip })); return true }
      if (sub === '/search') { reply(res, manager.search({ ticket: q('ticket'), q: q('q') })); return true }
      if (sub === '/tv/info') {
        const r = infoRate.hit('ip:' + ip)
        if (!r.ok) { reply(res, { ok: false, status: 429, error: 'rate_limited' }); return true }
        reply(res, tvInfo(req, q('ticket')))
        return true
      }
      return false
    }
    if (method !== 'POST') return false

    // Everything below changes something: JSON only, from this site only, small.
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] || '')) || isCrossSite(req.headers)) {
      try { req.resume() } catch { /* gone */ }
      sendJson(res, 415, { ok: false, error: 'json_only', message: ERROR_TEXT.json_only })
      return true
    }
    const parsed = await readJson(req, BODY_MAX)
    if (parsed.error) { sendJson(res, parsed.error, { ok: false, error: parsed.error === 413 ? 'too_long' : 'bad_request', message: ERROR_TEXT[parsed.error === 413 ? 'too_long' : 'bad_request'] }); return true }
    const b = parsed.body

    switch (sub) {
      case '/tv/create': {
        const userId = deps.userFromRequest ? deps.userFromRequest(req) : null
        const user = userId && deps.getUser ? deps.getUser(userId) : null
        if (!user && !getSettings().anonymousTv) { reply(res, { ok: false, status: 401, error: 'sign_in_needed' }); return true }
        // The desktop app may have prepared a room for a TV to pick up.
        // The reply is only what the TV needs to connect; the join key reaches it through /tv/info and its own state.
        const strip = ({ joinKey, overlayTicket, ...rest }) => rest
        {
          const claimed = manager.claimRoom({ userId: user ? user.id : null })
          if (claimed) { reply(res, strip(claimed)); return true }
        }
        const made = await manager.createRoom({ hostUserId: user ? user.id : null, hostName: user ? user.name : '', ip })
        reply(res, made && made.ok ? strip(made) : made)
        return true
      }
      case '/join':
        reply(res, manager.join({ code: b.code, key: b.key, name: b.name, colorId: b.colorId, ip }))
        return true
      case '/act': {
        const { ticket, type, ...rest } = b
        if (typeof type !== 'string' || type.length > 24) { reply(res, { ok: false, status: 400, error: 'bad_request' }); return true }
        reply(res, await manager.act({ ticket, type, ip, ...rest }))
        return true
      }
      default:
        return false
    }
  }

  /** After bearer sign-in: the smart-TV apps and other native clients. sub is the path after /api/movie-night. */
  async function handleAuthed(req, res, url, sub, ctx) {
    const send = ctx.send
    const denied = gate(req)
    if (req.method === 'GET' && sub === '/status') {
      send(200, { ok: true, enabled: !(denied && denied.error === 'disabled'), available: !denied, reason: denied ? denied.error : null, message: denied ? ERROR_TEXT[denied.error] : '' })
      return true
    }
    if (req.method === 'POST' && sub === '/tv/create') {
      if (denied) { send(denied.status, { ok: false, error: denied.error, message: ERROR_TEXT[denied.error] }); return true }
      if (!/^application\/json\b/i.test(String(req.headers['content-type'] || '')) && Number(req.headers['content-length'] || 0) > 0) { send(415, { ok: false, error: 'json_only' }); return true }
      const parsed = await readJson(req, BODY_MAX)
      if (parsed.error) { send(parsed.error, { ok: false, error: 'bad_request' }); return true }
      const user = deps.getUser ? deps.getUser(ctx.userId) : null
      if (!user) { send(401, { ok: false, error: 'unauthorized' }); return true }
      const made = await manager.createRoom({ hostUserId: user.id, hostName: user.name, ip: getIp(req), strictFeatured: true, featured: parsed.body.featured && typeof parsed.body.featured.id === 'string' ? { key: parsed.body.featured.id, title: parsed.body.featured.title } : null })
      if (!made.ok) { send(made.status || 400, { ...made, message: ERROR_TEXT[made.error] || 'That did not work.' }); return true }
      send(200, { ok: true, code: made.code, ticket: made.ticket, tvPath: web.TV_PATH, hash: `k=${made.ticket}`, poolCount: made.poolCount })
      return true
    }
    return false
  }

  /** The desktop app's "Start Movie Night": a room as the owner (optionally for one film), and where to show it. */
  async function createForDesktop({ userId, featured, awaitTv }) {
    const user = deps.getUser ? deps.getUser(userId) : null
    if (!user) return { ok: false, error: 'unauthorized', message: ERROR_TEXT.unauthorized }
    const made = await manager.createRoom({ hostUserId: user.id, hostName: user.name, featured, awaitTv: !!awaitTv, ip: '127.0.0.1' })
    if (!made.ok) return { ...made, message: ERROR_TEXT[made.error] || 'That did not work.' }
    let lan = ''
    try { lan = deps.getLanBase ? String(deps.getLanBase() || '') : '' } catch { /* none */ }
    return { ok: true, code: made.code, ticket: made.ticket, tvPath: web.TV_PATH, hash: `k=${made.ticket}`, tvAddress: lan ? `${lan}/tv` : '', poolCount: made.poolCount, awaitingTv: !!awaitTv }
  }

  function close() {
    clearInterval(timer)
    try { manager.closeAll('server_stopped') } catch { /* ignore */ }
  }

  return { claimsPublic, handlePublic, handleAuthed, createForDesktop, close, manager, tvInfo }
}

// A PC often has several private addresses (Wi-Fi, a VirtualBox / WSL / Docker / VPN adapter). A phone can only reach
// the real one, so virtual adapters lose and Wi-Fi / Ethernet win; 192.168.x beats 10.x beats 172.16-31.x.
const VIRTUAL_IFACE = /virtual|vmware|vbox|hyper-?v|vethernet|wsl|docker|loopback|pseudo|tailscale|zerotier|wireguard|\bvpn\b|^tun\d|^tap\d|bluetooth|npcap|host-only/i
const REAL_IFACE = /wi-?fi|wlan|wireless|^en\d|^eth\d|ethernet/i
function pickLanAddress(interfaces) {
  let best = null
  for (const [name, list] of Object.entries(interfaces || {})) {
    for (const a of list || []) {
      if (!a || a.internal || !(a.family === 'IPv4' || a.family === 4)) continue
      const m = /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.exec(String(a.address))
      if (!m) continue
      const score = (VIRTUAL_IFACE.test(name) ? 100 : 0) + (REAL_IFACE.test(name) ? -10 : 0) + (m[1] === '192.168' ? 0 : m[1] === '10' ? 1 : 2)
      if (!best || score < best.score) best = { score, address: a.address }
    }
  }
  return best ? best.address : ''
}
const lanAddress = () => { try { return pickLanAddress(require('os').networkInterfaces()) } catch { return '' } }

/** QR modules as rows of '0'/'1' (the page draws them on a canvas: no markup crosses to the page). */
function defaultQr(text) {
  try {
    const qrcode = require('./vendor/qrcode-generator')
    const qr = qrcode(0, 'M')
    qr.addData(String(text))
    qr.make()
    const n = qr.getModuleCount()
    const rows = []
    for (let r = 0; r < n; r++) { let line = ''; for (let c = 0; c < n; c++) line += qr.isDark(r, c) ? '1' : '0'; rows.push(line) }
    return { n, rows }
  } catch { return null }
}

module.exports = { createMovieNightHttp, ERROR_TEXT, BODY_MAX, defaultQr, pickLanAddress, lanAddress }
