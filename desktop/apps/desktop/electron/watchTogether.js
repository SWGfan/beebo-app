'use strict'
// ============================================================================
// watchTogether.js - Watch together rooms (SyncPlay / Plex Watch Together style).
// ----------------------------------------------------------------------------
// People signed in to THIS Beebo server, in different places, watching the same
// title at the same moment. This file is the room manager: no HTTP, no timers of
// its own (the caller drives sweep()), no I/O - everything takes an injectable clock,
// so the whole thing is tested deterministically (test/watch-together.test.js).
// The HTTP + Server-Sent-Events side is watchTogetherHttp.js; the timing maths that
// is shared with the browser is watchTogetherSync.js; the web player's panel is
// watchTogetherWeb.js.
//
// WHAT A ROOM HOLDS
//   media      { kind: 'movie'|'tv', id, title }   the one title everybody is on
//   timeline   { state, anchorPos, anchorAt, rate, seq }   the shared playhead (see Sync)
//   hold       null | { reason, resume }  the room is paused waiting for people (buffering,
//              a seek, someone who pressed play before a friend was ready); when everybody
//              is ready it starts again by itself. "Waiting for Sam to buffer..."
//   settings   control: 'host' (only the host drives) | 'everyone'; waitForBuffering; chat
//   participants  one per signed-in person (a second tab of the same person shares it)
//
// SECURITY (why the shapes are what they are)
//   * The room code is 128 random bits (Crockford base32, 26 characters). It is a capability
//     to ASK to join, never a login: every call also needs the person's own signed-in session
//     on this server, so there is no anonymous joining. Joining checks the person may watch
//     the title (parental controls) and is throttled + locked out after repeated wrong codes.
//   * Owner controls are per room: only the host changes settings, kicks (kicked people are
//     barred from that room), hands over the host role, changes title or closes the room.
//   * Names, titles and chat are DATA. They are stripped of control / bidi characters and
//     length-capped here, and the web client only ever puts them on the page with textContent.
//     Reactions come from a fixed list. Every message has a size cap and a rate limit.
//   * Logs carry a short hash of the code (roomId), never the code, and never a name.
// ============================================================================

const crypto = require('crypto')
const sync = require('./watchTogetherSync')

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CODE_BYTES = 16 // 128 bits
const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/

const LIMITS = Object.freeze({
  maxRooms: 200,
  maxRoomsPerUser: 2,
  maxParticipants: 12,
  maxSinksPerParticipant: 3,
  nameMax: 40,
  titleMax: 120,
  chatMax: 300,
  chatHistory: 50,
  idMax: 700,
  maxPosition: 60 * 60 * 48,
  leadMs: 600, // how far ahead of "now" a synchronised start is scheduled
  waitMs: 12000, // a viewer buffering longer than this stops holding the room up
  graceMs: 30000, // a dropped connection keeps its seat this long (page changes, wifi blips)
  emptyMs: 120000, // an empty room is closed after this
  maxAgeMs: 12 * 3600 * 1000
})

const RATES = Object.freeze([0.5, 0.75, 1, 1.25, 1.5, 2])
const REACTIONS = Object.freeze(['👍', '❤️', '😂', '😮', '😢', '👏', '🔥', '🎉'])
const PALETTE = Object.freeze(['#e57373', '#f06292', '#ba68c8', '#9575cd', '#7986cb', '#64b5f6', '#4dd0e1', '#4db6ac', '#81c784', '#aed581', '#ffd54f', '#ffb74d'])

// ---- small helpers -------------------------------------------------------------------------------

const defaultNow = () => (typeof performance !== 'undefined' && performance.timeOrigin ? performance.timeOrigin + performance.now() : Date.now())

/** 128 random bits as 26 Crockford base32 characters. */
function generateCode(randomBytes = crypto.randomBytes) {
  const bytes = randomBytes(CODE_BYTES)
  let bits = 0
  let value = 0
  let out = ''
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
    value &= (1 << bits) - 1
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31]
  return out
}

/** What a person typed or pasted -> the canonical code, or '' if it cannot be one. */
function normalizeCode(raw) {
  if (typeof raw !== 'string' || raw.length > 64) return ''
  let s = raw.toUpperCase().replace(/[\s-]/g, '')
  s = s.replace(/O/g, '0').replace(/[IL]/g, '1') // Crockford: the look-alikes
  return CODE_RE.test(s) ? s : ''
}

// Control characters, bidi overrides / isolates, zero-width and BOM: nothing that can hide or reorder text.
const INVISIBLE_RE = new RegExp("[\\u0000-\\u001F\\u007F-\\u009F\\u00AD\\u061C\\u180E\\u200B-\\u200F\\u2028-\\u202E\\u2060-\\u206F\\uFEFF\\uFFF9-\\uFFFB]", 'g')

function cleanText(value, max) {
  let s = typeof value === 'string' ? value : ''
  if (s.length > max * 4) s = s.slice(0, max * 4)
  try { s = s.normalize('NFC') } catch {}
  s = s.replace(INVISIBLE_RE, ' ').replace(/\s+/g, ' ').trim()
  const cps = Array.from(s)
  return cps.length > max ? cps.slice(0, max).join('').trim() : s
}
const cleanName = (v) => cleanText(v, LIMITS.nameMax) || 'Guest'
const cleanTitle = (v) => cleanText(v, LIMITS.titleMax)

function hashHex(text, len) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, len)
}
const roomIdFor = (code) => hashHex('wt-room|' + code, 8)

function avatarFor(userId, name) {
  const h = parseInt(hashHex('wt-avatar|' + userId, 8), 16)
  const first = Array.from(String(name || '?'))[0] || '?'
  return { color: PALETTE[h % PALETTE.length], initial: first.toUpperCase() }
}

/** A title reference. `id` is the library's own opaque id (base64url of a file path). */
function normalizeMedia(m) {
  if (!m || typeof m !== 'object') return null
  const kind = m.kind === 'tv' ? 'tv' : m.kind === 'movie' ? 'movie' : null
  const id = typeof m.id === 'string' ? m.id : ''
  if (!kind || !id || id.length > LIMITS.idMax || !/^[A-Za-z0-9_-]+$/.test(id)) return null
  return { kind, id, title: cleanTitle(m.title) }
}

function mediaHref(media) {
  return `${media.kind === 'tv' ? '/tvwatch' : '/watch'}?id=${encodeURIComponent(media.id)}`
}

/** Sliding-window rate limiter: allow `limit` hits per `windowMs` per key. */
function createRateLimiter({ limit, windowMs, now = defaultNow }) {
  const hits = new Map()
  let lastPrune = now()
  return {
    hit(key) {
      const k = String(key)
      const t = now()
      if (t - lastPrune > windowMs * 2 || hits.size > 5000) {
        for (const [kk, arr] of hits) if (!arr.length || t - arr[arr.length - 1] >= windowMs) hits.delete(kk)
        lastPrune = t
      }
      const recent = (hits.get(k) || []).filter((at) => t - at < windowMs)
      if (recent.length >= limit) {
        hits.set(k, recent)
        return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((windowMs - (t - recent[0])) / 1000)) }
      }
      recent.push(t)
      hits.set(k, recent)
      return { ok: true, remaining: limit - recent.length }
    },
    reset() { hits.clear() }
  }
}

/** Wrong-code lockout (the parental-PIN / attemptLimiter pattern): `max` misses in the window lock that key. */
function createAttemptLimiter({ max = 8, windowMs = 10 * 60 * 1000, now = defaultNow } = {}) {
  const fails = new Map()
  return {
    locked(key) {
      const f = fails.get(key)
      if (!f) return 0
      const t = now()
      if (f.until && f.until > t) return Math.max(1, Math.ceil((f.until - t) / 60000))
      if (t - f.first > windowMs) fails.delete(key)
      return 0
    },
    fail(key) {
      const t = now()
      if (fails.size > 5000) for (const [k, f] of fails) if (t - f.first > windowMs && !(f.until > t)) fails.delete(k)
      let f = fails.get(key)
      if (!f || (t - f.first > windowMs && !(f.until > t))) f = { first: t, count: 0, until: 0 }
      f.count++
      if (f.count >= max) f.until = t + windowMs
      fails.set(key, f)
    },
    clear(key) { fails.delete(key) }
  }
}

const err = (status, error, extra) => ({ ok: false, status, error, ...(extra || {}) })

// ---- the manager ---------------------------------------------------------------------------------

/**
 * opts: { now, log, randomBytes,
 *         canView(userId, kind, id) -> Promise<{ ok, title? }>   the library / parental-controls check,
 *         rates: { command, chat, react, create, join } overrides (tests) }
 */
function createWatchTogether(opts = {}) {
  const now = opts.now || defaultNow
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const randomBytes = opts.randomBytes || crypto.randomBytes
  const canView = typeof opts.canView === 'function' ? opts.canView : async () => ({ ok: true })
  const rates = opts.rates || {}

  const rooms = new Map() // code -> room
  const cmdRate = createRateLimiter({ limit: rates.command || 40, windowMs: 10000, now })
  const chatRate = createRateLimiter({ limit: rates.chat || 6, windowMs: 10000, now })
  const reactRate = createRateLimiter({ limit: rates.react || 10, windowMs: 10000, now })
  const readyRate = createRateLimiter({ limit: rates.ready || 60, windowMs: 10000, now })
  const createRate = createRateLimiter({ limit: rates.create || 6, windowMs: 3600 * 1000, now })
  const joinRate = createRateLimiter({ limit: rates.join || 20, windowMs: 10 * 60 * 1000, now })
  const attempts = createAttemptLimiter({ max: rates.attempts || 8, now })

  // ---- room plumbing ----
  function publicP(room, p) {
    return {
      pid: p.pid,
      name: p.name,
      color: p.color,
      initial: p.initial,
      role: p.pid === room.hostPid ? 'host' : 'guest',
      ready: p.ready,
      buffering: p.gates && !p.ready,
      connected: isConnected(p)
    }
  }
  function isConnected(p) {
    return p.sinks.size > 0 || (p.lastSeen && now() - p.lastSeen < 10000)
  }
  function isGating(room, p) {
    return room.settings.waitForBuffering && p.gates && !p.stalled && isConnected(p)
  }
  function canControl(room, p) {
    return p.pid === room.hostPid || room.settings.control === 'everyone'
  }
  function positionNow(room) {
    const t = sync.wtPositionAt(room.timeline, now())
    return room.duration > 0 ? Math.min(t, room.duration) : t
  }
  function waitingFor(room) {
    if (!room.hold) return []
    const out = []
    for (const p of room.participants.values()) {
      if (isGating(room, p) && !(p.ready && p.appliedSeq >= room.gateSeq)) out.push(p.name)
    }
    return out
  }
  function snapshot(room) {
    const hold = room.hold ? { reason: room.hold.reason, resume: room.hold.resume, waitingFor: waitingFor(room) } : null
    return {
      code: room.code,
      roomId: room.id,
      media: { ...room.media, href: mediaHref(room.media) },
      settings: { ...room.settings },
      timeline: { ...room.timeline },
      hold,
      hostPid: room.hostPid,
      duration: room.duration || 0,
      participants: Array.from(room.participants.values()).map((p) => publicP(room, p)),
      serverNow: now(),
      eventSeq: room.eventSeq
    }
  }
  function emit(room, event, data) {
    const id = ++room.eventSeq
    const text = JSON.stringify(data)
    for (const p of room.participants.values()) {
      for (const sink of Array.from(p.sinks)) {
        try { sink.write(event, text, id) } catch { p.sinks.delete(sink); try { sink.close && sink.close() } catch {} }
      }
    }
    return id
  }
  function broadcastState(room) {
    room.lastActivity = now()
    return emit(room, 'state', snapshot(room))
  }
  function bumpTimeline(room, patch) {
    room.timeline = { ...room.timeline, ...patch, seq: room.timeline.seq + 1 }
    return room.timeline
  }
  function findRoom(code) {
    const c = normalizeCode(code)
    return c ? rooms.get(c) || null : null
  }
  function participantOf(room, userId) {
    for (const p of room.participants.values()) if (p.userId === userId) return p
    return null
  }
  function touch(p) { p.lastSeen = now() }

  function closeRoom(room, reason) {
    if (!rooms.has(room.code)) return
    try { emit(room, 'closed', { reason }) } catch {}
    for (const p of room.participants.values()) for (const s of p.sinks) { try { s.close && s.close() } catch {} }
    rooms.delete(room.code)
    log(`[watch-together] room ${room.id} closed (${reason})`)
  }

  function pickNewHost(room, excludePid) {
    const list = Array.from(room.participants.values()).filter((p) => p.pid !== excludePid)
    list.sort((a, b) => (isConnected(b) ? 1 : 0) - (isConnected(a) ? 1 : 0) || a.joinedAt - b.joinedAt)
    return list[0] || null
  }
  function removeParticipant(room, p, reason) {
    room.participants.delete(p.pid)
    for (const s of p.sinks) { try { s.close && s.close() } catch {} }
    p.sinks.clear()
    if (room.participants.size === 0) { closeRoom(room, 'empty'); return }
    if (room.hostPid === p.pid) {
      const next = pickNewHost(room, p.pid)
      room.hostPid = next.pid
    }
    log(`[watch-together] room ${room.id} ${reason} (${room.participants.size} left)`)
    resumeIfReady(room)
    broadcastState(room)
  }

  // ---- readiness gating ----
  function allReady(room) {
    for (const p of room.participants.values()) {
      if (isGating(room, p) && !(p.ready && p.appliedSeq >= room.gateSeq)) return false
    }
    return true
  }
  function startPlaying(room) {
    const cur = positionNow(room)
    room.hold = null
    bumpTimeline(room, { state: 'playing', anchorPos: cur, anchorAt: now() + LIMITS.leadMs })
  }
  /** If the room is holding for people and everybody is ready now, start it. Returns true when it did. */
  function resumeIfReady(room) {
    if (!room.hold) return false
    if (!room.hold.resume) { room.hold = null; return true }
    if (!allReady(room)) return false
    startPlaying(room)
    return true
  }
  function pauseAt(room, pos) {
    bumpTimeline(room, { state: 'paused', anchorPos: pos, anchorAt: now() })
  }

  // ---- create / join / leave ----
  function identity(user) {
    const name = cleanName(user && (user.name || user.username))
    return { name, ...avatarFor(user.id, name) }
  }
  function newParticipant(room, user) {
    const who = identity(user)
    const p = {
      pid: hashHex(randomBytes(8).toString('hex'), 12),
      userId: user.id,
      name: who.name,
      color: who.color,
      initial: who.initial,
      joinedAt: now(),
      lastSeen: now(),
      ready: false,
      appliedSeq: 0,
      gates: false, // becomes true on the first "ready" report: a newcomer never stops a room
      stalled: false,
      notReadySince: 0,
      sinks: new Set(),
      cids: new Set()
    }
    room.participants.set(p.pid, p)
    return p
  }

  async function createRoom({ user, media, settings, ip } = {}) {
    if (!user || !user.id) return err(401, 'unauthorized')
    const m = normalizeMedia(media)
    if (!m) return err(400, 'bad_media')
    const gate = createRate.hit('u:' + user.id)
    if (!gate.ok) return err(429, 'rate_limited', { retryAfterSeconds: gate.retryAfterSeconds })
    let owned = 0
    for (const r of rooms.values()) if (r.ownerUserId === user.id) owned++
    if (owned >= LIMITS.maxRoomsPerUser) return err(429, 'too_many_rooms')
    if (rooms.size >= LIMITS.maxRooms) return err(503, 'server_busy')
    const seen = await canView(user.id, m.kind, m.id)
    if (!seen || !seen.ok) return err(403, 'unavailable')
    if (seen.title && !m.title) m.title = cleanTitle(seen.title)
    if (!m.title) m.title = 'Untitled'
    if (rooms.size >= LIMITS.maxRooms) return err(503, 'server_busy')
    const code = generateCode(randomBytes)
    const t = now()
    const s = settings && typeof settings === 'object' ? settings : {}
    const room = {
      code,
      id: roomIdFor(code),
      ownerUserId: user.id,
      createdAt: t,
      lastActivity: t,
      emptySince: 0,
      media: m,
      duration: 0,
      settings: {
        control: s.control === 'everyone' ? 'everyone' : 'host',
        waitForBuffering: s.waitForBuffering !== false,
        chat: s.chat !== false
      },
      timeline: { state: 'paused', anchorPos: 0, anchorAt: t, rate: 1, seq: 1 },
      hold: null,
      gateSeq: 1,
      participants: new Map(),
      banned: new Set(),
      chat: [],
      chatSeq: 0,
      eventSeq: 0
    }
    const p = newParticipant(room, user)
    room.hostPid = p.pid
    rooms.set(code, room)
    log(`[watch-together] room ${room.id} created (${m.kind})`)
    return { ok: true, code, pid: p.pid, room: snapshot(room), chat: [] }
  }

  /** Read-only look at a room for an invite landing page. Counts as a code guess. */
  async function preview({ user, code, ip } = {}) {
    if (!user || !user.id) return err(401, 'unauthorized')
    const gate = guardGuess(user.id, ip)
    if (gate) return gate
    const room = findRoom(code)
    if (!room || room.banned.has(user.id)) return failGuess(user.id, ip)
    const host = room.participants.get(room.hostPid)
    return { ok: true, media: { ...room.media, href: mediaHref(room.media) }, hostName: host ? host.name : '', count: room.participants.size }
  }
  function guardGuess(userId, ip) {
    const wait = Math.max(attempts.locked('u:' + userId), ip ? attempts.locked('ip:' + ip) : 0)
    if (wait) return err(429, 'locked', { minutesRemaining: wait })
    return null
  }
  function failGuess(userId, ip) {
    attempts.fail('u:' + userId)
    if (ip) attempts.fail('ip:' + ip)
    return err(404, 'not_found')
  }

  async function join({ user, code, ip } = {}) {
    if (!user || !user.id) return err(401, 'unauthorized')
    const locked = guardGuess(user.id, ip)
    if (locked) return locked
    const rate = joinRate.hit('u:' + user.id)
    if (!rate.ok) return err(429, 'rate_limited', { retryAfterSeconds: rate.retryAfterSeconds })
    const room = findRoom(code)
    // One answer for "no such room" and "you were removed from it".
    if (!room || room.banned.has(user.id)) return failGuess(user.id, ip)
    const seen = await canView(user.id, room.media.kind, room.media.id)
    if (!seen || !seen.ok) return err(403, 'unavailable')
    if (!rooms.has(room.code)) return failGuess(user.id, ip) // closed while we were checking
    // Misses are NOT cleared by a success (they age out): otherwise a person could open a room of their own,
    // join it between batches of guesses, and never reach the limit.
    let p = participantOf(room, user.id)
    const rejoin = !!p
    if (p) {
      // The same person again (a page change, a second tab): the same seat, but they must re-report readiness.
      p.ready = false
      p.appliedSeq = 0
      p.gates = false
      p.stalled = false
      const who = identity(user)
      p.name = who.name
      p.color = who.color
      p.initial = who.initial
    } else {
      if (room.participants.size >= LIMITS.maxParticipants) return err(409, 'room_full')
      p = newParticipant(room, user)
    }
    touch(p)
    room.emptySince = 0
    log(`[watch-together] room ${room.id} ${rejoin ? 'rejoin' : 'join'} (${room.participants.size})`)
    broadcastState(room)
    return { ok: true, pid: p.pid, room: snapshot(room), chat: room.chat.slice(-LIMITS.chatHistory), catchUp: { position: positionNow(room), running: sync.wtIsRunning(room.timeline, now()) } }
  }

  function leave({ userId, code } = {}) {
    const room = findRoom(code)
    const p = room && participantOf(room, userId)
    if (!p) return err(404, 'not_found')
    removeParticipant(room, p, 'left')
    return { ok: true }
  }

  // ---- streaming attachment (SSE sinks) ----
  /**
   * sink: { write(event, dataText, id?), close?() }. The current state is sent first, then any chat the caller
   * missed (lastEventId, from a reconnect). Returns { ok, detach, pid }.
   */
  function attach({ userId, code, sink, lastEventId } = {}) {
    const room = findRoom(code)
    const p = room && participantOf(room, userId)
    if (!p) return err(404, 'not_found')
    while (p.sinks.size >= LIMITS.maxSinksPerParticipant) {
      const oldest = p.sinks.values().next().value
      p.sinks.delete(oldest)
      try { oldest.close && oldest.close() } catch {}
    }
    p.sinks.add(sink)
    p.disconnectedAt = 0
    touch(p)
    try {
      sink.write('state', JSON.stringify({ ...snapshot(room), you: p.pid }), undefined)
      const since = Number(lastEventId)
      if (Number.isFinite(since) && since > 0) {
        for (const c of room.chat) if (c.eventId > since) sink.write('chat', JSON.stringify(c), c.eventId)
      }
    } catch {}
    broadcastState(room)
    let done = false
    return {
      ok: true,
      pid: p.pid,
      detach() {
        if (done) return
        done = true
        p.sinks.delete(sink)
        if (rooms.has(room.code) && room.participants.has(p.pid)) {
          if (p.sinks.size === 0) p.disconnectedAt = now()
          resumeIfReady(room)
          broadcastState(room)
        }
      }
    }
  }

  /** For clients that cannot hold a stream open: the current state plus chat since `since`. */
  function poll({ userId, code, since } = {}) {
    const room = findRoom(code)
    const p = room && participantOf(room, userId)
    if (!p) return err(404, 'not_found')
    touch(p)
    const s = Number(since)
    return { ok: true, pid: p.pid, room: snapshot(room), chat: room.chat.filter((c) => !(Number.isFinite(s) && c.eventId <= s)) }
  }

  // ---- commands ----
  function memberOf(code, userId) {
    const room = findRoom(code)
    const p = room && participantOf(room, userId)
    if (!p) return { error: err(404, 'not_found') }
    touch(p)
    return { room, p }
  }

  const clampPos = (room, pos) => {
    const n = Number(pos)
    if (!Number.isFinite(n)) return null
    const max = room.duration > 0 ? room.duration : LIMITS.maxPosition
    return Math.min(Math.max(0, n), max)
  }

  /**
   * play | pause | seek | rate. Synchronous end to end, so commands are applied one at a time in the order they
   * arrive: each accepted one bumps timeline.seq by exactly one, and viewers ignore any state older than the
   * newest they hold. cmd: { type, pos?, rate?, cid?, ifSeq? }.
   *   cid    the sender's own id for the command; a repeat (a retry) is answered, not applied twice
   *   ifSeq  optional: refuse (with the current timeline) when the room has moved on since the sender looked
   */
  function command({ userId, code, cmd } = {}) {
    const m = memberOf(code, userId)
    if (m.error) return m.error
    const { room, p } = m
    const gate = cmdRate.hit(room.code + '|' + p.pid)
    if (!gate.ok) return err(429, 'rate_limited', { retryAfterSeconds: gate.retryAfterSeconds })
    if (!cmd || typeof cmd !== 'object') return err(400, 'bad_request')
    if (!canControl(room, p)) return err(403, 'not_allowed', { timeline: { ...room.timeline } })
    const cid = typeof cmd.cid === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(cmd.cid) ? cmd.cid : ''
    if (cid && p.cids.has(cid)) return { ok: true, duplicate: true, timeline: { ...room.timeline } }
    if (cmd.ifSeq !== undefined && cmd.ifSeq !== null && Number(cmd.ifSeq) !== room.timeline.seq) {
      return err(409, 'stale', { timeline: { ...room.timeline } })
    }
    const before = room.timeline.seq
    const type = cmd.type
    if (type === 'play') {
      // Play never moves the playhead (seek does that). Already playing, or already waiting: nothing to change.
      if (room.timeline.state !== 'playing' && !room.hold) {
        if (allReady(room)) startPlaying(room)
        else {
          room.hold = { reason: 'waiting', resume: true }
          bumpTimeline(room, {}) // same position; a new seq so every viewer re-reads the hold
        }
      }
    } else if (type === 'pause') {
      const at = cmd.pos === undefined ? positionNow(room) : clampPos(room, cmd.pos)
      if (at === null) return err(400, 'bad_position')
      const idle = room.timeline.state === 'paused' && !room.hold && Math.abs(at - room.timeline.anchorPos) < 0.001
      if (!idle) {
        room.hold = null
        pauseAt(room, at)
      }
    } else if (type === 'seek') {
      const to = clampPos(room, cmd.pos)
      if (to === null) return err(400, 'bad_position')
      const wasPlaying = room.timeline.state === 'playing' || (room.hold && room.hold.resume)
      // One command, one new timeline (one seq). Everybody has to land on the new spot and buffer it before
      // it runs again: "ready" only counts when it is about this seq or a later one.
      room.gateSeq = room.timeline.seq + 1
      room.hold = null
      if (wasPlaying && (!room.settings.waitForBuffering || allReady(room))) {
        bumpTimeline(room, { state: 'playing', anchorPos: to, anchorAt: now() + LIMITS.leadMs })
      } else {
        if (wasPlaying) room.hold = { reason: 'seek', resume: true }
        pauseAt(room, to)
      }
    } else if (type === 'rate') {
      const r = Number(cmd.rate)
      if (!RATES.includes(r)) return err(400, 'bad_rate')
      if (r !== room.timeline.rate) {
        const t = now()
        const running = sync.wtIsRunning(room.timeline, t)
        // Re-anchor at this moment so the position does not jump; a start still pending keeps its start.
        bumpTimeline(room, running ? { anchorPos: positionNow(room), anchorAt: t, rate: r } : { rate: r })
      }
    } else {
      return err(400, 'bad_command')
    }
    if (cid) { p.cids.add(cid); if (p.cids.size > 64) p.cids.delete(p.cids.values().next().value) }
    if (room.timeline.seq === before) return { ok: true, noop: true, timeline: { ...room.timeline }, hold: room.hold }
    broadcastState(room)
    return { ok: true, timeline: { ...room.timeline }, hold: room.hold }
  }

  /** Change the title for everybody (next episode). Async only for the "may they watch it" check. */
  async function changeMedia({ userId, code, media } = {}) {
    const m0 = memberOf(code, userId)
    if (m0.error) return m0.error
    const gate = cmdRate.hit(m0.room.code + '|' + m0.p.pid)
    if (!gate.ok) return err(429, 'rate_limited', { retryAfterSeconds: gate.retryAfterSeconds })
    if (!canControl(m0.room, m0.p)) return err(403, 'not_allowed')
    const m = normalizeMedia(media)
    if (!m) return err(400, 'bad_media')
    const seen = await canView(userId, m.kind, m.id)
    if (!seen || !seen.ok) return err(403, 'unavailable')
    if (seen.title && !m.title) m.title = cleanTitle(seen.title)
    if (!m.title) m.title = 'Untitled'
    // Re-check after the wait: the room or the person may be gone, or no longer allowed to drive.
    const again = memberOf(code, userId)
    if (again.error) return again.error
    const { room, p } = again
    if (!canControl(room, p)) return err(403, 'not_allowed')
    room.media = m
    room.duration = 0
    room.hold = null
    pauseAt(room, 0)
    room.gateSeq = room.timeline.seq
    // Everyone is about to load the new page: nobody holds the room up until they report ready again.
    for (const q of room.participants.values()) { q.ready = false; q.appliedSeq = 0; q.gates = false; q.stalled = false }
    broadcastState(room)
    emit(room, 'media', { media: { ...room.media, href: mediaHref(room.media) }, by: p.pid })
    log(`[watch-together] room ${room.id} title changed`)
    return { ok: true, room: snapshot(room) }
  }

  /**
   * A viewer's report: ready (enough buffered to play) or not, and the timeline seq it has applied. Buffering while the
   * room plays pauses everybody until they are back ("waiting for X to buffer"); a viewer that stays unready for
   * waitMs stops holding the room up.
   */
  function ready({ userId, code, ready: isReady, seq, duration } = {}) {
    const m = memberOf(code, userId)
    if (m.error) return m.error
    const { room, p } = m
    const gate = readyRate.hit(room.code + '|' + p.pid)
    if (!gate.ok) return err(429, 'rate_limited', { retryAfterSeconds: gate.retryAfterSeconds })
    const d = Number(duration)
    if (Number.isFinite(d) && d > 0 && d <= LIMITS.maxPosition && (!room.duration || canControl(room, p))) room.duration = d
    const s = Number(seq)
    const wasReady = p.ready
    p.ready = isReady === true
    p.appliedSeq = Number.isFinite(s) ? Math.min(Math.max(0, Math.floor(s)), room.timeline.seq) : p.appliedSeq
    if (p.ready) { p.gates = true; p.stalled = false; p.notReadySince = 0 }
    else if (p.gates && wasReady) p.notReadySince = now()
    let changed = wasReady !== p.ready
    if (!p.ready && p.gates && !room.hold && room.settings.waitForBuffering && room.timeline.state === 'playing') {
      // Somebody stalled while the film is running: stop it for everyone, at this moment.
      room.hold = { reason: 'buffering', resume: true }
      pauseAt(room, positionNow(room))
      changed = true
    } else if (p.ready && room.hold) {
      if (resumeIfReady(room)) changed = true
    }
    if (changed) broadcastState(room)
    return { ok: true, timeline: { ...room.timeline }, hold: room.hold ? { reason: room.hold.reason } : null }
  }

  // ---- chat and reactions ----
  function chat({ userId, code, text } = {}) {
    const m = memberOf(code, userId)
    if (m.error) return m.error
    const { room, p } = m
    if (room.settings.chat === false && p.pid !== room.hostPid) return err(403, 'chat_off')
    const gate = chatRate.hit(room.code + '|' + p.pid)
    if (!gate.ok) return err(429, 'rate_limited', { retryAfterSeconds: gate.retryAfterSeconds })
    if (typeof text !== 'string') return err(400, 'bad_request')
    if (text.length > LIMITS.chatMax * 8) return err(413, 'too_long')
    const clean = cleanText(text, LIMITS.chatMax)
    if (!clean) return err(400, 'empty')
    const msg = { id: ++room.chatSeq, pid: p.pid, name: p.name, color: p.color, initial: p.initial, text: clean, at: Date.now() }
    msg.eventId = emit(room, 'chat', msg)
    room.chat.push(msg)
    if (room.chat.length > LIMITS.chatHistory) room.chat.shift()
    room.lastActivity = now()
    return { ok: true, id: msg.id }
  }

  function react({ userId, code, emoji } = {}) {
    const m = memberOf(code, userId)
    if (m.error) return m.error
    const { room, p } = m
    const gate = reactRate.hit(room.code + '|' + p.pid)
    if (!gate.ok) return err(429, 'rate_limited', { retryAfterSeconds: gate.retryAfterSeconds })
    if (typeof emoji !== 'string' || !REACTIONS.includes(emoji)) return err(400, 'bad_reaction')
    emit(room, 'reaction', { pid: p.pid, name: p.name, emoji })
    return { ok: true }
  }

  // ---- host controls ----
  function hostOnly(code, userId) {
    const m = memberOf(code, userId)
    if (m.error) return m
    if (m.p.pid !== m.room.hostPid) return { error: err(403, 'not_allowed') }
    return m
  }

  function setSettings({ userId, code, settings } = {}) {
    const m = hostOnly(code, userId)
    if (m.error) return m.error
    const { room } = m
    const s = settings && typeof settings === 'object' ? settings : {}
    if (s.control === 'host' || s.control === 'everyone') room.settings.control = s.control
    if (typeof s.waitForBuffering === 'boolean') {
      room.settings.waitForBuffering = s.waitForBuffering
      if (!s.waitForBuffering && room.hold) { resumeIfReady(room); if (room.hold) startPlaying(room) }
    }
    if (typeof s.chat === 'boolean') room.settings.chat = s.chat
    broadcastState(room)
    return { ok: true, settings: { ...room.settings } }
  }

  function transferHost({ userId, code, target } = {}) {
    const m = hostOnly(code, userId)
    if (m.error) return m.error
    const { room } = m
    if (typeof target !== 'string' || !room.participants.has(target)) return err(404, 'no_such_participant')
    room.hostPid = target
    broadcastState(room)
    return { ok: true }
  }

  function kick({ userId, code, target } = {}) {
    const m = hostOnly(code, userId)
    if (m.error) return m.error
    const { room, p } = m
    const victim = typeof target === 'string' ? room.participants.get(target) : null
    if (!victim) return err(404, 'no_such_participant')
    if (victim.pid === p.pid) return err(400, 'cannot_kick_self')
    room.banned.add(victim.userId)
    for (const s of victim.sinks) { try { s.write('kicked', JSON.stringify({ reason: 'removed_by_host' })) } catch {} }
    removeParticipant(room, victim, 'removed')
    return { ok: true }
  }

  function close({ userId, code } = {}) {
    const m = hostOnly(code, userId)
    if (m.error) return m.error
    closeRoom(m.room, 'closed_by_host')
    return { ok: true }
  }

  // ---- clock ----
  /** Answer to a viewer's clock ping. t1/t2 are stamped by the caller as close to arrival / departure as it can. */
  function pingReply(t0, t1) {
    const n = Number(t0)
    return { ok: true, t0: Number.isFinite(n) ? n : 0, t1: Number.isFinite(t1) ? t1 : now(), t2: now() }
  }

  // ---- housekeeping ----
  /** Call about once a second. Ends stalls, drops people gone too long, retires empty and ancient rooms. */
  function sweep() {
    const t = now()
    for (const room of Array.from(rooms.values())) {
      if (t - room.createdAt > LIMITS.maxAgeMs) { closeRoom(room, 'expired'); continue }
      let changed = false
      for (const p of Array.from(room.participants.values())) {
        if (isConnected(p)) continue
        if (!p.disconnectedAt) p.disconnectedAt = t
        if (t - p.disconnectedAt > LIMITS.graceMs) {
          removeParticipant(room, p, 'timed out')
          changed = true
          if (!rooms.has(room.code)) break
        }
      }
      if (!rooms.has(room.code)) continue
      for (const p of room.participants.values()) {
        if (p.gates && !p.ready && !p.stalled && p.notReadySince && t - p.notReadySince > LIMITS.waitMs) { p.stalled = true; changed = true }
      }
      if (room.hold && resumeIfReady(room)) changed = true
      if (changed) broadcastState(room)
    }
  }

  function summary() {
    return Array.from(rooms.values()).map((r) => ({ roomId: r.id, kind: r.media.kind, title: r.media.title, participants: r.participants.size, createdAt: r.createdAt }))
  }
  function closeAll(reason = 'server_stopped') {
    for (const room of Array.from(rooms.values())) closeRoom(room, reason)
  }

  return {
    now,
    createRoom, preview, join, leave, attach, poll,
    command, changeMedia, ready, chat, react,
    setSettings, transferHost, kick, close,
    pingReply, sweep, summary, closeAll,
    // for tests and the HTTP layer
    _rooms: rooms,
    roomCount: () => rooms.size
  }
}

let active = null
/** The running server's manager, for the desktop app's IPC (set by the stream server). */
const setActive = (m) => { active = m }
const getActive = () => active

module.exports = {
  createWatchTogether, createRateLimiter, createAttemptLimiter,
  generateCode, normalizeCode, cleanText, cleanName, cleanTitle, normalizeMedia, mediaHref, avatarFor,
  LIMITS, RATES, REACTIONS, CODE_RE,
  setActive, getActive
}
