'use strict'
// The Jellyfin-style WebSocket at /socket (RFC 6455, no dependency).
//
// What it does, and no more:
//   - a socket is opened only for a signed-in app: the same `jf.` token as every other route, from `?api_key=` / `?ApiKey=`
//     or an Authorization header. No token, a revoked or expired token, or the mode switched off: no upgrade.
//   - the server says ForceKeepAlive on connect; a client KeepAlive is answered with KeepAlive; a silent socket is dropped.
//   - SessionsStart "<delay>,<interval>" pushes the person's OWN sessions (the same list GET /Sessions gives) until SessionsStop.
//   - UserDataChanged is pushed to that person's sockets when a watched / favourite / resume mark changes, so a second app
//     refreshes its home rows.
//   - everything else a client may send (ScheduledTasksInfoStart, ActivityLogEntryStart, ...) is admin-only in Jellyfin and is
//     ignored here. Remote control (Play, Playstate, GeneralCommand) is never sent: Beebo does not let one app steer another.
// Limits: 64 KB per message, 8 sockets per person, 100 in all, 3 minutes of silence.

const crypto = require('crypto')
const idsLib = require('./ids')
const { stripPrefix } = require('./router')
const { makeQuery, readCredentials } = require('./util')

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_MESSAGE = 64 * 1024
const MAX_PER_USER = 8
const MAX_TOTAL = 100
const KEEPALIVE_SECONDS = 60
const SILENCE_MS = 3 * 60 * 1000
const PING_EVERY_MS = 45 * 1000
const MIN_SESSIONS_INTERVAL_MS = 1000
const MAX_SESSIONS_INTERVAL_MS = 5 * 60 * 1000

const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa }

function encodeFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '', 'utf8')
  let head
  if (body.length < 126) head = Buffer.from([0x80 | opcode, body.length])
  else if (body.length < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(body.length, 2) }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(body.length), 2) }
  return Buffer.concat([head, body])
}

// Incremental parser for CLIENT frames (which must be masked). Calls onFrame({opcode, payload}) or onError(closeCode).
function createFrameReader({ onFrame, onError, maxMessage = MAX_MESSAGE }) {
  let buf = Buffer.alloc(0)
  let fragments = []
  let fragmentSize = 0
  let fragmentOpcode = 0
  let dead = false
  return function push(chunk) {
    if (dead) return
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
    while (buf.length >= 2) {
      const b0 = buf[0]
      const b1 = buf[1]
      const fin = !!(b0 & 0x80)
      const opcode = b0 & 0x0f
      if (b0 & 0x70) { dead = true; return onError(1002) }
      if (!(b1 & 0x80)) { dead = true; return onError(1002) }
      let len = b1 & 0x7f
      let offset = 2
      if (len === 126) {
        if (buf.length < 4) return
        len = buf.readUInt16BE(2)
        offset = 4
      } else if (len === 127) {
        if (buf.length < 10) return
        const big = buf.readBigUInt64BE(2)
        if (big > BigInt(maxMessage)) { dead = true; return onError(1009) }
        len = Number(big)
        offset = 10
      }
      const isControl = opcode >= 0x8
      if (isControl && (len > 125 || !fin)) { dead = true; return onError(1002) }
      if (len > maxMessage || fragmentSize + len > maxMessage) { dead = true; return onError(1009) }
      if (buf.length < offset + 4 + len) return
      const mask = buf.subarray(offset, offset + 4)
      const payload = Buffer.from(buf.subarray(offset + 4, offset + 4 + len))
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]
      buf = buf.subarray(offset + 4 + len)
      if (isControl) { onFrame({ opcode, payload }); continue }
      if (opcode === OP.CONT) {
        if (!fragments.length) { dead = true; return onError(1002) }
        fragments.push(payload)
        fragmentSize += payload.length
        if (fin) {
          const whole = Buffer.concat(fragments)
          const op = fragmentOpcode
          fragments = []
          fragmentSize = 0
          onFrame({ opcode: op, payload: whole })
        }
      } else if (opcode === OP.TEXT || opcode === OP.BINARY) {
        if (fragments.length) { dead = true; return onError(1002) }
        if (fin) onFrame({ opcode, payload })
        else { fragments = [payload]; fragmentSize = payload.length; fragmentOpcode = opcode }
      } else { dead = true; return onError(1002) }
    }
  }
}

function refuse(socket, status, text) {
  try {
    socket.write('HTTP/1.1 ' + status + ' ' + text + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
  } catch {}
  try { socket.destroy() } catch {}
}

function createSocketHub({ auth, host, settingEnabled, log = () => {}, now = Date.now }) {
  const sockets = new Set()

  const countFor = (userId) => { let n = 0; for (const s of sockets) if (s.user.id === userId) n++; return n }

  function send(ws, type, data) {
    if (ws.closed) return
    const msg = { MessageType: type, MessageId: crypto.randomUUID(), ServerId: auth.serverId() }
    if (data !== undefined) msg.Data = data
    try { ws.socket.write(encodeFrame(OP.TEXT, JSON.stringify(msg))) } catch { close(ws, 1011) }
  }

  function close(ws, code = 1000) {
    if (ws.closed) return
    ws.closed = true
    clearInterval(ws.timer)
    clearInterval(ws.sessionsTimer)
    sockets.delete(ws)
    try {
      const body = Buffer.alloc(2)
      body.writeUInt16BE(code, 0)
      ws.socket.end(encodeFrame(OP.CLOSE, body))
    } catch { try { ws.socket.destroy() } catch {} }
  }

  function onMessage(ws, text) {
    ws.lastSeen = now()
    let msg = null
    try { msg = JSON.parse(text) } catch { return }
    if (!msg || typeof msg.MessageType !== 'string') return
    switch (msg.MessageType) {
      case 'KeepAlive':
        send(ws, 'KeepAlive')
        break
      case 'SessionsStart': {
        const parts = String(msg.Data || '').split(',').map((s) => parseInt(s, 10))
        const delay = Number.isFinite(parts[0]) && parts[0] >= 0 ? Math.min(parts[0], 60000) : 0
        const every = Math.min(MAX_SESSIONS_INTERVAL_MS, Math.max(MIN_SESSIONS_INTERVAL_MS, Number.isFinite(parts[1]) ? parts[1] : 1500))
        clearInterval(ws.sessionsTimer)
        const push = () => { try { send(ws, 'Sessions', auth.sessionsFor(ws.user)) } catch {} }
        setTimeout(() => { if (!ws.closed) { push(); ws.sessionsTimer = setInterval(push, every); if (ws.sessionsTimer.unref) ws.sessionsTimer.unref() } }, delay).unref?.()
        break
      }
      case 'SessionsStop':
        clearInterval(ws.sessionsTimer)
        break
      default:
        break // admin-only subscriptions and everything else: ignored
    }
  }

  // The 'upgrade' listener of the HTTP servers. Returns true when it took the socket (handled or refused), false when the
  // path is not ours, so the caller can leave it to anything else.
  function handleUpgrade(req, socket, head) {
    let url
    try { url = new URL(req.url, 'http://localhost') } catch { return false }
    if (stripPrefix(url.pathname).replace(/\/$/, '').toLowerCase() !== '/socket') return false
    if (!settingEnabled()) { refuse(socket, 404, 'Not Found'); return true }
    const h = req.headers || {}
    const key = h['sec-websocket-key']
    if (String(h.upgrade || '').toLowerCase() !== 'websocket' || !key || String(h['sec-websocket-version'] || '') !== '13' || Buffer.from(String(key), 'base64').length !== 16) {
      refuse(socket, 400, 'Bad Request')
      return true
    }
    const q = makeQuery(url)
    const creds = readCredentials(req, q)
    const user = auth.userForToken(creds.token)
    if (!user || auth.isRevoked(creds.token)) { refuse(socket, 401, 'Unauthorized'); return true }
    if (sockets.size >= MAX_TOTAL || countFor(user.id) >= MAX_PER_USER) { refuse(socket, 503, 'Service Unavailable'); return true }
    const device = { ...creds.device, id: creds.device.id || q('deviceId') || '' }
    const accept = crypto.createHash('sha1').update(String(key) + GUID).digest('base64')
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')
    socket.setNoDelay(true)
    socket.setTimeout(0)
    auth.touchSession(user, device, host.clientIp ? host.clientIp(req) : '')
    const ws = { socket, user, device, closed: false, lastSeen: now(), timer: null, sessionsTimer: null }
    sockets.add(ws)
    const reader = createFrameReader({
      onFrame: ({ opcode, payload }) => {
        if (opcode === OP.TEXT) onMessage(ws, payload.toString('utf8'))
        else if (opcode === OP.PING) { ws.lastSeen = now(); try { socket.write(encodeFrame(OP.PONG, payload)) } catch {} }
        else if (opcode === OP.PONG) ws.lastSeen = now()
        else if (opcode === OP.CLOSE) close(ws, 1000)
        else close(ws, 1003) // binary is not part of this protocol
      },
      onError: (code) => close(ws, code)
    })
    socket.on('data', (chunk) => reader(chunk))
    socket.on('error', () => close(ws, 1006))
    socket.on('close', () => { ws.closed = true; clearInterval(ws.timer); clearInterval(ws.sessionsTimer); sockets.delete(ws) })
    ws.timer = setInterval(() => {
      if (now() - ws.lastSeen > SILENCE_MS) return close(ws, 1001)
      // Signed out (revoked or expired) while connected: drop it.
      if (!auth.userForToken(creds.token) || auth.isRevoked(creds.token)) return close(ws, 1008)
      try { socket.write(encodeFrame(OP.PING, '')) } catch {}
    }, PING_EVERY_MS)
    if (ws.timer.unref) ws.timer.unref()
    if (head && head.length) reader(head)
    send(ws, 'ForceKeepAlive', KEEPALIVE_SECONDS)
    return true
  }

  // Tell one person's sockets that item marks changed (userDataList: UserItemDataDto[] with ItemId).
  function userDataChanged(user, userDataList) {
    if (!userDataList || !userDataList.length) return
    const data = { UserId: idsLib.normalize(auth.idFor(user)), UserDataList: userDataList }
    for (const ws of sockets) if (ws.user.id === user.id) send(ws, 'UserDataChanged', data)
  }

  function closeAllForUser(userId) { for (const ws of [...sockets]) if (ws.user.id === userId) close(ws, 1008) }
  function closeAll() { for (const ws of [...sockets]) close(ws, 1001) }

  return { handleUpgrade, userDataChanged, closeAllForUser, closeAll, count: () => sockets.size }
}

module.exports = { createSocketHub, createFrameReader, encodeFrame, OP }
