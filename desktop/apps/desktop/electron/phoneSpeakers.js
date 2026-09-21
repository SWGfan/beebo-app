'use strict'
// ============================================================================
// phoneSpeakers.js - "Phone speakers": the room manager. The big screen (TV / PC) shows the film; every guest's
// phone plays one channel of its sound, in sync. No HTTP, no timers of its own (the caller drives sweep()), no I/O:
// everything takes an injectable clock, so the whole thing is tested deterministically (test/phone-speakers-room.test.js).
// The HTTP + Server-Sent-Events side is phoneSpeakersHttp.js; the audio pieces are phoneSpeakersAudio.js; what each
// phone plays is phoneSpeakersChannels.js; the browser side is phoneSpeakersClient.js / phoneSpeakersWeb.js.
// ----------------------------------------------------------------------------
// WHO IS IN A ROOM
//   the TV     one per room: the player page (signed in as the person who started the room). It is the timeline
//              master: its play / pause / seek and the measured position of its <video> move the shared timeline.
//              It gets a "tv" token when the room is created (and a fresh one, replacing the old, when the page reloads).
//   phones     guests with NO account: a nickname and a token. The join key is the room code (128 random bits) carried
//              by the QR code / link; anything else is a guess and is throttled and locked out like a wrong PIN.
//              A phone plays one "seat" (a feed: FL, FR, FC, SL, SR, LFE, BL, BR, DL, DR or DM) chosen by join order,
//              re-assignable from the seating chart.
// THE SHARED TIMELINE (same shape as Watch Together, watchTogetherSync.js): { state, anchorPos, anchorAt, rate, seq, rev }
//   "at server time anchorAt the film was at anchorPos seconds". Every device measures its clock offset to the server
//   (NTP style, phoneSpeakersClient.js), so all of them agree on "when". seq changes when play / pause / seek / rate
//   changes (everybody re-plans); rev changes when the TV's measured position corrects the anchor a little (phones nudge).
//   After a seek the room HOLDS until the phones report their pieces are loaded (or a few seconds pass), so nobody
//   misses the first words of a scene; then it starts again together, leadMs in the future.
// SECURITY (why the shapes are what they are)
//   * the room code is 128 random bits (same generator as Watch Together); a miss counts against the caller's address,
//     8 misses lock that address for 10 minutes; "no such room" and "you were removed" look the same.
//   * a guest's token is 128 random bits, kept only as a hash; every guest call needs it, in a header (never a cookie,
//     so another website cannot make a phone's browser act), and it never appears in a URL or a log.
//   * only the room's TV token can drive it (timeline, seating, settings, kick, close); guests can only tune themselves.
//   * names are DATA: control / bidi characters removed, length-capped (watchTogether.cleanText); the pages only ever use
//     textContent. Every call has a rate limit; rooms, guests and streams are capped; nothing is stored on disk.
//   * the film is chosen by a signed-in person and checked with the same parental-controls rules as watching it
//     (canView); guests can only ever fetch the audio of THIS room's film. Logs carry a short hash of the code only.
//   * no data is collected: rooms live in memory and are gone when the room closes or the app stops.
// ============================================================================

const crypto = require('crypto')
const wt = require('./watchTogether')
const sync = require('./watchTogetherSync')
const ch = require('./phoneSpeakersChannels')

const LIMITS = Object.freeze({
  maxRooms: 4,
  maxGuests: 16,
  maxSinksPerGuest: 2,
  nameMax: 24,
  idMax: 700,
  leadMs: 800, // how far ahead a synchronised start is scheduled
  holdMaxMs: 6000, // a phone that is not ready this long stops holding the film up
  graceMs: 90000, // a dropped connection is "away" after this; it keeps its seat
  removeAwayMs: 20 * 60 * 1000, // ... and loses it after this
  tvGoneMs: 10 * 60 * 1000, // a room whose TV has not been seen this long is closed
  maxAgeMs: 10 * 3600 * 1000,
  trimMax: 500,
  avOffsetMax: 500,
  gainMinDb: -24,
  gainMaxDb: 12,
  beepLeadMs: 2500,
  beepIntervalMs: 1400,
  syncSoftMin: 0.012, // seconds: smaller measured errors are ignored
  syncHardMax: 0.6 // seconds: a bigger one is a jump (the video stalled or was moved), not a correction
})

const FILL_IN = Object.freeze(['tv', 'neighbour', 'off'])
const STATES = Object.freeze(['locked', 'syncing', 'loading', 'ready', 'playing', 'paused', 'idle', 'error'])
const RATES = wt.RATES
const err = (status, error, extra) => ({ ok: false, status, error, ...(extra || {}) })
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
const numOr = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const sha = (text, len) => crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, len)
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b))
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

const cleanName = (v) => wt.cleanText(v, LIMITS.nameMax) || 'Guest'

/** Estimated sync error and its colour: green up to 30 ms, amber up to 80 ms, red above (the phone measures errMs and driftMs). */
function syncQuality(status, { connected = true, unlocked = true } = {}) {
  if (!connected) return { level: 'away', estMs: null }
  if (!unlocked) return { level: 'locked', estMs: null }
  const s = status || {}
  if (!(s.errMs >= 0)) return { level: 'syncing', estMs: null }
  const est = Math.round((s.errMs + Math.abs(s.driftMs || 0)) * 10) / 10
  return { level: est <= 30 ? 'good' : est <= 80 ? 'warn' : 'bad', estMs: est }
}

/** The default equalisation for a feed: satellites lose the bass a phone cannot play, the sub keeps only bass. */
function autoEq(feed) {
  const k = ch.FEEDS[feed] && ch.FEEDS[feed].kind
  if (k === 'sub') return { hp: 0, lp: 120 }
  if (k === 'sat' || k === 'mix') return { hp: 100, lp: 0 }
  return { hp: 0, lp: 0 }
}

/**
 * opts: { now, log, randomBytes,
 *   canView(userId, kind, id) -> Promise<{ ok, title? }>          parental controls / the film exists
 *   prepare({ userId, kind, id }) -> Promise<{ ok, source, durationSec, audioKey, title?, error?, message? }>
 *                                                                  probes the film, opens the audio session
 *   rates: { join, ping, status, command, create } overrides (tests) }
 */
function createPhoneSpeakers(opts = {}) {
  const now = opts.now || (() => (typeof performance !== 'undefined' && performance.timeOrigin ? performance.timeOrigin + performance.now() : Date.now()))
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const randomBytes = opts.randomBytes || crypto.randomBytes
  const canView = typeof opts.canView === 'function' ? opts.canView : async () => ({ ok: true })
  const prepare = typeof opts.prepare === 'function' ? opts.prepare : async () => ({ ok: false, error: 'unavailable' })
  const rates = opts.rates || {}

  const rooms = new Map() // code -> room
  const guestIndex = new Map() // gid -> room
  const createRate = wt.createRateLimiter({ limit: rates.create || 8, windowMs: 3600 * 1000, now })
  const joinRate = wt.createRateLimiter({ limit: rates.join || 40, windowMs: 10 * 60 * 1000, now })
  const attempts = wt.createAttemptLimiter({ max: rates.attempts || 8, now })
  const pingRate = wt.createRateLimiter({ limit: rates.ping || 400, windowMs: 10000, now })
  const statusRate = wt.createRateLimiter({ limit: rates.status || 60, windowMs: 10000, now })
  const cmdRate = wt.createRateLimiter({ limit: rates.command || 60, windowMs: 10000, now })
  const tuneRate = wt.createRateLimiter({ limit: rates.tune || 40, windowMs: 10000, now })
  const audioRate = wt.createRateLimiter({ limit: rates.audio || 400, windowMs: 60000, now })

  // ---------------------------------------------------------------- lookups
  const findRoom = (code) => { const c = wt.normalizeCode(code); return c ? rooms.get(c) || null : null }
  const roomIdFor = (code) => sha('ps-room|' + code, 8)

  function parseToken(token) {
    if (typeof token !== 'string' || token.length > 80) return null
    const m = /^([0-9a-f]{12})\.([0-9a-f]{32})$/.exec(token)
    return m ? { gid: m[1], secret: m[2] } : null
  }
  /** Token -> { room, g } or an error result. Touches the guest (it is alive). */
  function auth(token, { kind } = {}) {
    const t = parseToken(token)
    if (!t) return { error: err(401, 'unauthorized') }
    const room = guestIndex.get(t.gid)
    const g = room && room.guests.get(t.gid)
    if (!g || !safeEq(g.tokenHash, sha('ps-tok|' + t.secret, 40))) return { error: err(401, 'unauthorized') }
    if (kind && g.kind !== kind) return { error: err(403, 'not_allowed') }
    g.lastSeen = now()
    return { room, g }
  }
  const isConnected = (g) => g.sinks.size > 0 || (g.lastSeen && now() - g.lastSeen < 10000)
  const isPresent = (g) => g.kind === 'phone' && isConnected(g) && g.status.unlocked === true
  const phones = (room) => Array.from(room.guests.values()).filter((g) => g.kind === 'phone')
  const tvOf = (room) => room.guests.get(room.tvGid)

  function newToken() {
    const gid = randomBytes(6).toString('hex')
    const secret = randomBytes(16).toString('hex')
    return { gid, token: `${gid}.${secret}`, hash: sha('ps-tok|' + secret, 40) }
  }
  function blankStatus() {
    return { state: 'locked', unlocked: false, ready: false, seq: 0, errMs: -1, driftMs: 0, rttMs: 0, outLatencyMs: -1, visible: true }
  }
  function newGuest(room, kind, name, ua) {
    const t = newToken()
    const g = {
      gid: t.gid, kind, name, tokenHash: t.hash, joinedAt: now(), joinOrder: ++room.joinCounter, lastSeen: now(), disconnectedAt: 0,
      sinks: new Set(), status: blankStatus(), seat: '', manual: false, trimMs: 0, gainDb: 0, eq: { mode: 'auto', hp: 100, lp: 0 }, muted: false,
      connLast: true, bt: false, ua: ua === 'ios' || ua === 'android' ? ua : 'other', lastSeenAway: 0
    }
    room.guests.set(g.gid, g)
    guestIndex.set(g.gid, room)
    return { g, token: t.token }
  }

  // ---------------------------------------------------------------- seating
  const seatsTaken = (room, except) => {
    const taken = new Set()
    for (const p of phones(room)) {
      if (p === except || !p.seat || p.seat === 'off') continue
      if (isConnected(p) || now() - (p.disconnectedAt || 0) < LIMITS.graceMs) taken.add(p.seat)
    }
    return taken
  }
  /** The seat a newcomer gets: the first free one in join order for this mode. */
  function suggestSeat(room, g) {
    if (room.mode === 'everyone') return 'DM'
    const order = ch.seatOrder(room.mode, room.source)
    const taken = seatsTaken(room, g)
    const free = order.find((s) => !taken.has(s))
    if (free) return free
    // a stereo pair with more phones: left, right, left, right ... (every phone adds volume to its side)
    if (room.mode === 'stereo') return phones(room).filter((p) => p !== g && (p.seat === 'DL' || p.seat === 'DR')).length % 2 === 0 ? 'DL' : 'DR'
    return 'off'
  }
  /** Everybody re-seated by join order (a new preset). */
  function reseatAll(room) {
    for (const p of phones(room)) { p.seat = ''; p.manual = false }
    for (const p of phones(room).sort((a, b) => a.joinOrder - b.joinOrder)) p.seat = suggestSeat(room, p)
  }
  const exclusive = (seat) => !!seat && seat !== 'off' && seat !== 'DM' && seat !== 'DL' && seat !== 'DR'

  // ---------------------------------------------------------------- what each device plays
  function layersFor(room) {
    const seats = new Map()
    // a phone on "Spare", a muted one and one that has not tapped Enable audio yet play nothing (and cover nothing)
    for (const p of phones(room)) if (isPresent(p) && !p.muted && p.seat && p.seat !== 'off') seats.set(p.gid, p.seat)
    return ch.resolveLayers({ mode: room.mode, source: room.source, seats, fillIn: room.settings.fillIn })
  }
  const eqOf = (g, seat) => {
    if (g.eq.mode === 'full') return { hp: 0, lp: 0 }
    if (g.eq.mode === 'custom') return { hp: g.eq.hp || 0, lp: g.eq.lp || 0 }
    return autoEq(seat)
  }
  const seatLabel = (seat) => (seat === 'off' ? 'Spare' : seat === '' || !seat ? 'Waiting' : (ch.FEEDS[seat] || { label: seat }).label)

  function publicRoster(room, plan) {
    return phones(room).sort((a, b) => a.joinOrder - b.joinOrder).map((p) => {
      const q = syncQuality(p.status, { connected: isConnected(p), unlocked: p.status.unlocked })
      return { name: p.name, seat: p.seat || '', seatLabel: seatLabel(p.seat), level: q.level, present: isPresent(p) }
    })
  }
  function timelineOf(room) { return { ...room.timeline } }
  function holdOf(room) { return room.hold ? { reason: room.hold.reason, resume: room.hold.resume, waitingFor: waitingFor(room) } : null }

  function snapshotFor(room, g) {
    const plan = layersFor(room)
    const isTv = g.kind === 'tv'
    const mine = isTv ? plan.tv : (plan.layers[g.gid] || [])
    const eq = isTv ? { hp: 0, lp: 0 } : eqOf(g, g.seat)
    const seatFeed = g.seat && ch.isFeed(g.seat) ? g.seat : ''
    const you = {
      gid: g.gid, kind: g.kind, name: g.name, seat: isTv ? 'tv' : g.seat, seatLabel: isTv ? 'TV' : seatLabel(g.seat), seatShort: seatFeed ? ch.FEEDS[seatFeed].short : '',
      layers: mine.map((l) => ({ feed: l.feed, gain: l.gain, ...(isTv ? { pan: ch.TV_PAN[l.feed] || [0.7, 0.7] } : {}) })),
      hp: eq.hp, lp: eq.lp, trimMs: g.trimMs, gainDb: g.gainDb, muted: g.muted, bt: g.bt,
      // an ordinary phone plays its layers in the middle of its own speaker; the TV places them left / right
      stereo: isTv
    }
    const snap = {
      v: 1,
      serverNow: now(),
      eventSeq: room.eventSeq,
      room: {
        id: room.id, title: room.media.title, kind: room.media.kind, mode: room.mode, source: room.source.words, sourceKind: room.source.kind,
        duration: room.duration, rate: room.rate, segSec: ch.SEGMENT_SECONDS, locked: room.settings.locked,
        avOffsetMs: room.settings.avOffsetMs, fillIn: room.settings.fillIn,
        timeline: timelineOf(room), hold: holdOf(room), beep: room.beep && room.beep.endAt > now() ? room.beep : null,
        roster: publicRoster(room, plan), presentCount: phones(room).filter(isPresent).length,
        missing: plan.missing, dropped: plan.dropped, tvFills: plan.tv.map((l) => l.feed)
      },
      you
    }
    if (isTv) snap.host = hostView(room, plan)
    return snap
  }

  function hostView(room, plan) {
    const guests = phones(room).sort((a, b) => a.joinOrder - b.joinOrder).map((p) => {
      const connected = isConnected(p)
      const q = syncQuality(p.status, { connected, unlocked: p.status.unlocked })
      const out = p.status.outLatencyMs
      return {
        gid: p.gid, name: p.name, seat: p.seat || '', seatLabel: seatLabel(p.seat), manual: p.manual, connected, unlocked: p.status.unlocked === true, present: isPresent(p),
        state: p.status.state, ready: p.status.ready === true, level: q.level, estMs: q.estMs, errMs: p.status.errMs, driftMs: p.status.driftMs, rttMs: p.status.rttMs,
        outLatencyMs: out, btLikely: p.bt || out >= 90, trimMs: p.trimMs, gainDb: p.gainDb, eqMode: p.eq.mode, hp: p.eq.hp, lp: p.eq.lp, muted: p.muted,
        layers: (plan.layers[p.gid] || []).map((l) => ({ feed: l.feed, gain: l.gain })), device: p.ua, joinedAt: p.joinedAt
      }
    })
    const tv = tvOf(room)
    const tvq = tv ? syncQuality(tv.status, { connected: isConnected(tv), unlocked: tv.status.unlocked !== false }) : { level: 'away', estMs: null }
    return {
      seats: ch.seatOrder(room.mode, room.source).map((s) => ({ seat: s, label: ch.FEEDS[s].label, short: ch.FEEDS[s].short })),
      guests, tv: { level: tvq.level, estMs: tvq.estMs, layers: plan.tv.map((l) => ({ feed: l.feed, gain: l.gain })), // the film's own sound comes back the moment no phone is actually playing anything
      native: !Object.values(plan.layers).some((l) => l.length > 0) },
      settings: { ...room.settings }, modes: ch.MODES.slice(), max: LIMITS.maxGuests, notes: room.notes.slice(0, 6)
    }
  }

  // ---------------------------------------------------------------- events
  function emit(room, event, data) {
    const id = ++room.eventSeq
    for (const g of room.guests.values()) {
      for (const sink of Array.from(g.sinks)) {
        try { sink.write(event, typeof data === 'function' ? JSON.stringify(data(g)) : JSON.stringify(data), id) } catch { g.sinks.delete(sink); try { sink.close && sink.close() } catch {} }
      }
    }
    return id
  }
  function broadcastState(room) {
    room.lastActivity = now()
    return emit(room, 'state', (g) => snapshotFor(room, g))
  }
  function broadcastTimeline(room) {
    room.lastActivity = now()
    return emit(room, 'tl', { timeline: timelineOf(room), hold: holdOf(room), serverNow: now() })
  }
  function closeRoom(room, reason) {
    if (!rooms.has(room.code)) return
    try { emit(room, 'closed', { reason }) } catch {}
    for (const g of room.guests.values()) { for (const s of g.sinks) { try { s.close && s.close() } catch {} } guestIndex.delete(g.gid) }
    rooms.delete(room.code)
    if (typeof opts.onRoomClosed === 'function') { try { opts.onRoomClosed(room) } catch {} }
    log(`[phone-speakers] room ${room.id} closed (${reason})`)
  }

  // ---------------------------------------------------------------- the timeline
  const positionNow = (room) => {
    const t = sync.wtPositionAt(room.timeline, now())
    return room.duration > 0 ? Math.min(t, room.duration) : t
  }
  function bump(room, patch) {
    room.timeline = { ...room.timeline, ...patch, seq: room.timeline.seq + 1, rev: 0 }
    room.planAnchorAt = room.timeline.anchorAt // when this plan (not a later small correction) starts
  }
  function gating(room, g) {
    if (g.kind === 'tv') return isConnected(g)
    return isPresent(g) && (layersFor(room).layers[g.gid] || []).length > 0 && g.status.visible !== false
  }
  function notReady(room) {
    const out = []
    for (const g of room.guests.values()) if (gating(room, g) && !(g.status.ready && g.status.seq >= room.gateSeq)) out.push(g.kind === 'tv' ? 'the screen' : g.name)
    return out
  }
  const waitingFor = (room) => (room.hold ? notReady(room) : [])
  const allReady = (room) => notReady(room).length === 0
  function startPlaying(room) {
    const cur = positionNow(room)
    room.hold = null
    bump(room, { state: 'playing', anchorPos: cur, anchorAt: now() + LIMITS.leadMs })
  }
  function resumeIfReady(room) {
    if (!room.hold) return false
    if (!room.hold.resume) { room.hold = null; return true }
    if (!allReady(room)) return false
    startPlaying(room)
    return true
  }

  // ---------------------------------------------------------------- create / resume / join / leave
  const tvToken = (room) => {
    const old = tvOf(room)
    if (old) { for (const s of old.sinks) { try { s.write('kicked', JSON.stringify({ reason: 'another_screen' })); s.close && s.close() } catch {} } room.guests.delete(old.gid); guestIndex.delete(old.gid) }
    const made = newGuest(room, 'tv', 'The screen')
    made.g.status.unlocked = true
    room.tvGid = made.g.gid
    return made
  }

  async function createRoom({ user, media, settings, mode } = {}) {
    if (!user || !user.id) return err(401, 'unauthorized')
    const m = wt.normalizeMedia(media)
    if (!m) return err(400, 'bad_media')
    // the same person asking again for the same film gets their room back (a reload of the player page), not a second room
    for (const r of rooms.values()) {
      if (r.ownerUserId === user.id && r.media.kind === m.kind && r.media.id === m.id) {
        const made = tvToken(r)
        broadcastState(r)
        return { ok: true, resumed: true, code: r.code, token: made.token, gid: made.g.gid, room: snapshotFor(r, made.g) }
      }
    }
    const gate = createRate.hit('u:' + user.id)
    if (!gate.ok) return err(429, 'rate_limited', { retryAfterSeconds: gate.retryAfterSeconds })
    if (rooms.size >= LIMITS.maxRooms) return err(503, 'server_busy')
    const seen = await canView(user.id, m.kind, m.id)
    if (!seen || !seen.ok) return err(403, 'unavailable')
    const prep = await prepare({ userId: user.id, kind: m.kind, id: m.id })
    if (!prep || !prep.ok) return err(prep && prep.status ? prep.status : 422, (prep && prep.error) || 'no_audio', prep && prep.message ? { message: prep.message } : undefined)
    if (rooms.size >= LIMITS.maxRooms) return err(503, 'server_busy')
    // one room per person: a new film night replaces the old one
    for (const r of Array.from(rooms.values())) if (r.ownerUserId === user.id) closeRoom(r, 'replaced')
    const title = wt.cleanText(m.title || (seen && seen.title) || prep.title || '', 120) || 'Untitled'
    const code = wt.generateCode(randomBytes)
    const t = now()
    const s = settings && typeof settings === 'object' ? settings : {}
    const room = {
      code, id: roomIdFor(code), ownerUserId: user.id, createdAt: t, lastActivity: t,
      media: { kind: m.kind, id: m.id, title }, source: prep.source, duration: Number(prep.durationSec) || 0, audioKey: prep.audioKey, rate: prep.rate || ch.DEFAULT_RATE,
      mode: ch.MODES.includes(mode) ? mode : ch.defaultMode(prep.source),
      settings: {
        fillIn: FILL_IN.includes(s.fillIn) ? s.fillIn : 'tv',
        avOffsetMs: clamp(Math.round(numOr(s.avOffsetMs, 0)), -LIMITS.avOffsetMax, LIMITS.avOffsetMax),
        locked: false
      },
      timeline: { state: 'paused', anchorPos: 0, anchorAt: t, rate: 1, seq: 1, rev: 0 },
      hold: null, gateSeq: 1, guests: new Map(), tvGid: '', joinCounter: 0, beepCounter: 0, bannedIps: new Set(), beep: null, eventSeq: 0, notes: [], dirty: false, planAnchorAt: t
    }
    rooms.set(code, room)
    const made = tvToken(room)
    log(`[phone-speakers] room ${room.id} created (${m.kind}, ${prep.source.words})`)
    return { ok: true, code, token: made.token, gid: made.g.gid, room: snapshotFor(room, made.g) }
  }

  /** A signed-in owner's page reloads: it gets its room back with a fresh screen token (the old one stops working). */
  function resumeHost({ userId, code } = {}) {
    const room = findRoom(code)
    if (!room || !userId || room.ownerUserId !== userId) return err(404, 'not_found')
    const made = tvToken(room)
    broadcastState(room)
    return { ok: true, code: room.code, token: made.token, gid: made.g.gid, room: snapshotFor(room, made.g) }
  }
  function roomsOf(userId) {
    return Array.from(rooms.values()).filter((r) => r.ownerUserId === userId).map((r) => ({ code: r.code, roomId: r.id, kind: r.media.kind, id: r.media.id, title: r.media.title }))
  }

  /** What a scanned QR code leads to: is there such a room, and what is it showing. Counts as a code guess. */
  function preview({ code, ip } = {}) {
    const wait = ip ? attempts.locked('ip:' + ip) : 0
    if (wait) return err(429, 'locked', { minutesRemaining: wait })
    const room = findRoom(code)
    if (!room) { if (ip) attempts.fail('ip:' + ip); return err(404, 'not_found') }
    return { ok: true, title: room.media.title, mode: room.mode, sourceWords: room.source.words, count: phones(room).length, locked: room.settings.locked }
  }

  function join({ code, name, token, ip, ua } = {}) {
    const wait = ip ? attempts.locked('ip:' + ip) : 0
    if (wait) return err(429, 'locked', { minutesRemaining: wait })
    const rate = joinRate.hit('ip:' + (ip || 'none'))
    if (!rate.ok) return err(429, 'rate_limited', { retryAfterSeconds: rate.retryAfterSeconds })
    const room = findRoom(code)
    if (!room || (ip && room.bannedIps.has(sha('ps-ip|' + ip, 16)))) { if (ip) attempts.fail('ip:' + ip); return err(404, 'not_found') }
    // the same phone again (a reload, a Wi-Fi blip, the server restarting its stream): the same seat
    const t = parseToken(token)
    if (t && guestIndex.get(t.gid) === room) {
      const a = auth(token)
      if (!a.error && a.g.kind === 'phone') {
        const g = a.g
        if (typeof name === 'string' && name.trim()) g.name = cleanName(name)
        g.disconnectedAt = 0
        g.status.ready = false; g.status.seq = 0
        broadcastState(room)
        return { ok: true, resumed: true, gid: g.gid, token, snapshot: snapshotFor(room, g) }
      }
    }
    if (room.settings.locked) return err(403, 'room_locked')
    if (phones(room).length >= LIMITS.maxGuests) return err(409, 'room_full')
    // names are shown to everyone: two "Sam"s become "Sam" and "Sam 2"
    let nm = cleanName(name)
    const taken = new Set(phones(room).map((p) => p.name))
    if (taken.has(nm)) { let i = 2; while (taken.has(`${nm} ${i}`)) i++; nm = `${nm} ${i}` }
    const made = newGuest(room, 'phone', nm, ua)
    made.g.ipHash = ip ? sha('ps-ip|' + ip, 16) : ''
    made.g.seat = suggestSeat(room, made.g)
    made.g.eq = { mode: 'auto', hp: autoEq(made.g.seat).hp, lp: autoEq(made.g.seat).lp }
    room.emptySince = 0
    log(`[phone-speakers] room ${room.id} join (${phones(room).length})`)
    broadcastState(room)
    return { ok: true, gid: made.g.gid, token: made.token, snapshot: snapshotFor(room, made.g) }
  }

  function removeGuest(room, g, why) {
    if (g.kind === 'tv') return
    room.guests.delete(g.gid)
    guestIndex.delete(g.gid)
    for (const s of g.sinks) { try { s.close && s.close() } catch {} }
    g.sinks.clear()
    log(`[phone-speakers] room ${room.id} ${why} (${phones(room).length} left)`)
    resumeIfReady(room)
    broadcastState(room)
    broadcastTimeline(room)
  }
  function leave({ token } = {}) {
    const a = auth(token)
    if (a.error) return a.error
    if (a.g.kind === 'tv') return err(400, 'tv_cannot_leave')
    removeGuest(a.room, a.g, 'left')
    return { ok: true }
  }

  // ---------------------------------------------------------------- streaming attachment (SSE sinks)
  function attach({ token, sink } = {}) {
    const a = auth(token)
    if (a.error) return a.error
    const { room, g } = a
    while (g.sinks.size >= LIMITS.maxSinksPerGuest) {
      const oldest = g.sinks.values().next().value
      g.sinks.delete(oldest)
      try { oldest.close && oldest.close() } catch {}
    }
    g.sinks.add(sink)
    g.disconnectedAt = 0
    try { sink.write('state', JSON.stringify(snapshotFor(room, g)), undefined) } catch {}
    broadcastState(room)
    let done = false
    return {
      ok: true, gid: g.gid,
      detach() {
        if (done) return
        done = true
        g.sinks.delete(sink)
        if (rooms.has(room.code) && room.guests.has(g.gid)) {
          if (g.sinks.size === 0) g.disconnectedAt = now()
          resumeIfReady(room)
          broadcastState(room)
        }
      }
    }
  }
  /** For clients that cannot hold a stream open. */
  function poll({ token } = {}) {
    const a = auth(token)
    if (a.error) return a.error
    return { ok: true, ...snapshotFor(a.room, a.g) }
  }

  // ---------------------------------------------------------------- clock
  function ping({ token, t0, t1 } = {}) {
    const a = auth(token)
    if (a.error) return a.error
    const gate = pingRate.hit(a.g.gid)
    if (!gate.ok) return err(429, 'rate_limited', { retryAfterSeconds: gate.retryAfterSeconds })
    const n = Number(t0)
    return { ok: true, t0: Number.isFinite(n) ? n : 0, t1: Number.isFinite(t1) ? t1 : now(), t2: now() }
  }

  // ---------------------------------------------------------------- a device's own report
  function status({ token, status: st } = {}) {
    const a = auth(token)
    if (a.error) return a.error
    const { room, g } = a
    const gate = statusRate.hit(g.gid)
    if (!gate.ok) return err(429, 'rate_limited', { retryAfterSeconds: gate.retryAfterSeconds })
    const s = st && typeof st === 'object' ? st : {}
    const before = { ready: g.status.ready, seq: g.status.seq, unlocked: g.status.unlocked, state: g.status.state, level: syncQuality(g.status, { connected: true, unlocked: g.status.unlocked }).level, bt: g.status.outLatencyMs >= 90 }
    const next = g.status
    if (typeof s.state === 'string' && STATES.includes(s.state)) next.state = s.state
    if (typeof s.unlocked === 'boolean') next.unlocked = s.unlocked
    if (typeof s.ready === 'boolean') next.ready = s.ready
    if (Number.isFinite(Number(s.seq))) next.seq = clamp(Math.floor(Number(s.seq)), 0, room.timeline.seq)
    if (Number.isFinite(Number(s.errMs))) next.errMs = clamp(Number(s.errMs), -1, 100000)
    if (Number.isFinite(Number(s.driftMs))) next.driftMs = clamp(Number(s.driftMs), -100000, 100000)
    if (Number.isFinite(Number(s.rttMs))) next.rttMs = clamp(Number(s.rttMs), 0, 100000)
    if (Number.isFinite(Number(s.outLatencyMs))) next.outLatencyMs = clamp(Number(s.outLatencyMs), -1, 5000)
    if (typeof s.visible === 'boolean') next.visible = s.visible
    if (g.kind === 'phone' && typeof s.bt === 'boolean') g.bt = s.bt
    // a phone that says "ready" for a hold it has not applied does not count (seq is clamped to the room's own)
    const q = syncQuality(g.status, { connected: true, unlocked: g.status.unlocked })
    const changed = before.ready !== next.ready || before.unlocked !== next.unlocked || before.state !== next.state || before.level !== q.level || before.bt !== (next.outLatencyMs >= 90)
    let timelineChanged = false
    if (next.ready && room.hold) timelineChanged = resumeIfReady(room)
    if (timelineChanged) { broadcastState(room); broadcastTimeline(room) }
    else if (before.unlocked !== next.unlocked) broadcastState(room)
    else if (room.hold && (before.ready !== next.ready || before.seq !== next.seq)) broadcastTimeline(room) // "waiting for Bo" changes
    else if (before.ready !== next.ready) broadcastState(room)
    else if (changed) room.dirty = true // only the colour of a sync dot moved: the next sweep tells everyone, at most once a second
    return { ok: true, timeline: timelineOf(room), hold: room.hold ? { reason: room.hold.reason } : null }
  }

  // ---------------------------------------------------------------- the TV drives the timeline
  /** play | pause | seek | rate from the screen. cmd: { type, pos?, rate?, cid? } */
  function command({ token, cmd } = {}) {
    const a = auth(token, { kind: 'tv' })
    if (a.error) return a.error
    const { room, g } = a
    const gate = cmdRate.hit(g.gid)
    if (!gate.ok) return err(429, 'rate_limited', { retryAfterSeconds: gate.retryAfterSeconds })
    if (!cmd || typeof cmd !== 'object') return err(400, 'bad_request')
    const cid = typeof cmd.cid === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(cmd.cid) ? cmd.cid : ''
    if (cid && g.cids && g.cids.has(cid)) return { ok: true, duplicate: true, timeline: timelineOf(room) }
    const before = room.timeline.seq
    const clampPos = (p) => { const n = Number(p); return Number.isFinite(n) ? clamp(n, 0, room.duration > 0 ? room.duration : 172800) : null }
    const t = cmd.type
    if (t === 'play') {
      if (room.timeline.state !== 'playing' && !room.hold) {
        if (allReady(room)) startPlaying(room)
        else { room.hold = { reason: 'waiting', resume: true, since: now() }; bump(room, {}) }
      }
    } else if (t === 'pause') {
      const at = cmd.pos === undefined ? positionNow(room) : clampPos(cmd.pos)
      if (at === null) return err(400, 'bad_position')
      const idle = room.timeline.state === 'paused' && !room.hold && Math.abs(at - room.timeline.anchorPos) < 0.001
      if (!idle) { room.hold = null; bump(room, { state: 'paused', anchorPos: at, anchorAt: now() }) }
    } else if (t === 'seek') {
      const to = clampPos(cmd.pos)
      if (to === null) return err(400, 'bad_position')
      const wasPlaying = room.timeline.state === 'playing' || (room.hold && room.hold.resume) || cmd.playing === true
      room.gateSeq = room.timeline.seq + 1
      room.hold = null
      if (wasPlaying && !allGatesIdle(room)) {
        room.hold = { reason: 'seek', resume: true, since: now() }
        bump(room, { state: 'paused', anchorPos: to, anchorAt: now() })
      } else if (wasPlaying) {
        bump(room, { state: 'playing', anchorPos: to, anchorAt: now() + LIMITS.leadMs })
      } else bump(room, { state: 'paused', anchorPos: to, anchorAt: now() })
    } else if (t === 'rate') {
      const r = Number(cmd.rate)
      if (!RATES.includes(r)) return err(400, 'bad_rate')
      if (r !== room.timeline.rate) {
        const running = sync.wtIsRunning(room.timeline, now())
        bump(room, running ? { anchorPos: positionNow(room), anchorAt: now(), rate: r } : { rate: r })
      }
    } else return err(400, 'bad_command')
    if (cid) { g.cids = g.cids || new Set(); g.cids.add(cid); if (g.cids.size > 64) g.cids.delete(g.cids.values().next().value) }
    if (room.timeline.seq === before) return { ok: true, noop: true, timeline: timelineOf(room), hold: holdOf(room) }
    broadcastState(room)
    return { ok: true, timeline: timelineOf(room), hold: holdOf(room) }
  }
  // Nobody to wait for (no phone plays anything and the screen is the only gate): no need to hold.
  function allGatesIdle(room) {
    return !Array.from(room.guests.values()).some((g) => g.kind === 'phone' && gating(room, g))
  }

  /**
   * The screen's measured position of its <video>: `pos` seconds at server time `at`. While the film is running this
   * nudges the shared anchor to what the picture really does (phones follow the picture, not a prediction).
   * seq must match: a measurement taken before a seek must not undo it.
   */
  function sync_({ token, seq, pos, at } = {}) {
    const a = auth(token, { kind: 'tv' })
    if (a.error) return a.error
    const { room } = a
    const gate = cmdRate.hit(a.g.gid + '|sync')
    if (!gate.ok) return err(429, 'rate_limited', { retryAfterSeconds: gate.retryAfterSeconds })
    const tl = room.timeline
    const p = Number(pos); const t = Number(at)
    if (!Number.isFinite(p) || !Number.isFinite(t) || Number(seq) !== tl.seq) return { ok: true, ignored: true, timeline: timelineOf(room) }
    const n = now()
    if (tl.state !== 'playing' || n < (room.planAnchorAt || tl.anchorAt) + 1200 || Math.abs(t - n) > 3000) return { ok: true, ignored: true, timeline: timelineOf(room) }
    const predicted = sync.wtPositionAt(tl, t)
    const diff = p - predicted
    if (Math.abs(diff) < LIMITS.syncSoftMin) return { ok: true, timeline: timelineOf(room) }
    if (Math.abs(diff) > LIMITS.syncHardMax) {
      // the picture is somewhere else than the timeline says: the room follows the picture (a real jump)
      bump(room, { anchorPos: p, anchorAt: t })
      broadcastState(room)
      return { ok: true, jumped: true, timeline: timelineOf(room) }
    }
    // a small correction, half way at a time so one noisy measurement cannot swing the room
    room.timeline = { ...tl, anchorPos: predicted + diff * 0.5, anchorAt: t, rev: tl.rev + 1 }
    broadcastTimeline(room)
    return { ok: true, timeline: timelineOf(room) }
  }

  // ---------------------------------------------------------------- host controls (the screen's token only)
  function hostOnly(token) {
    const a = auth(token, { kind: 'tv' })
    if (a.error) return a
    const gate = tuneRate.hit(a.g.gid)
    if (!gate.ok) return { error: err(429, 'rate_limited', { retryAfterSeconds: gate.retryAfterSeconds }) }
    return a
  }

  function setSettings({ token, settings } = {}) {
    const a = hostOnly(token)
    if (a.error) return a.error
    const { room } = a
    const s = settings && typeof settings === 'object' ? settings : {}
    if (s.mode !== undefined) {
      if (!ch.MODES.includes(s.mode)) return err(400, 'bad_mode')
      if (s.mode !== room.mode) { room.mode = s.mode; reseatAll(room); for (const p of phones(room)) p.eq = { mode: 'auto', hp: autoEq(p.seat).hp, lp: autoEq(p.seat).lp } }
    }
    if (s.fillIn !== undefined) { if (!FILL_IN.includes(s.fillIn)) return err(400, 'bad_setting'); room.settings.fillIn = s.fillIn }
    if (s.avOffsetMs !== undefined) { const v = Number(s.avOffsetMs); if (!Number.isFinite(v)) return err(400, 'bad_setting'); room.settings.avOffsetMs = clamp(Math.round(v), -LIMITS.avOffsetMax, LIMITS.avOffsetMax) }
    if (typeof s.locked === 'boolean') room.settings.locked = s.locked
    broadcastState(room)
    return { ok: true, settings: { ...room.settings }, mode: room.mode }
  }

  /** "Seating chart": put a phone on a seat. A seat that only one phone can hold is swapped with whoever has it. */
  function setSeat({ token, gid, seat } = {}) {
    const a = hostOnly(token)
    if (a.error) return a.error
    const { room } = a
    const g = typeof gid === 'string' ? room.guests.get(gid) : null
    if (!g || g.kind !== 'phone') return err(404, 'no_such_guest')
    if (!(ch.isFeed(seat) || seat === 'off')) return err(400, 'bad_seat')
    if (exclusive(seat)) {
      const other = phones(room).find((p) => p !== g && p.seat === seat)
      if (other) { other.seat = g.seat && g.seat !== seat ? g.seat : 'off'; other.manual = true; if (other.eq.mode === 'auto') other.eq = { mode: 'auto', hp: autoEq(other.seat).hp, lp: autoEq(other.seat).lp } }
    }
    g.seat = seat
    g.manual = true
    if (g.eq.mode === 'auto') g.eq = { mode: 'auto', hp: autoEq(seat).hp, lp: autoEq(seat).lp }
    broadcastState(room)
    return { ok: true }
  }
  function autoSeat({ token } = {}) {
    const a = hostOnly(token)
    if (a.error) return a.error
    reseatAll(a.room)
    for (const p of phones(a.room)) p.eq = { mode: 'auto', hp: autoEq(p.seat).hp, lp: autoEq(p.seat).lp }
    broadcastState(a.room)
    return { ok: true }
  }

  /** Trim / gain / EQ / mute. A phone tunes itself; the screen can tune any phone. patch: { trimMs, gainDb, muted, bt, eq: 'auto'|'full'|{hp,lp} } */
  function tune({ token, target, patch } = {}) {
    const a = auth(token)
    if (a.error) return a.error
    const { room } = a
    const gate = tuneRate.hit(a.g.gid)
    if (!gate.ok) return err(429, 'rate_limited', { retryAfterSeconds: gate.retryAfterSeconds })
    let g = a.g
    if (typeof target === 'string' && target && target !== a.g.gid) {
      if (a.g.kind !== 'tv') return err(403, 'not_allowed')
      g = room.guests.get(target)
      if (!g) return err(404, 'no_such_guest')
    }
    const p = patch && typeof patch === 'object' ? patch : {}
    if (p.trimMs !== undefined) { const v = Number(p.trimMs); if (!Number.isFinite(v)) return err(400, 'bad_setting'); g.trimMs = clamp(Math.round(v), -LIMITS.trimMax, LIMITS.trimMax) }
    if (p.gainDb !== undefined) { const v = Number(p.gainDb); if (!Number.isFinite(v)) return err(400, 'bad_setting'); g.gainDb = clamp(Math.round(v * 2) / 2, LIMITS.gainMinDb, LIMITS.gainMaxDb) }
    if (typeof p.muted === 'boolean') g.muted = p.muted
    if (typeof p.bt === 'boolean' && g.kind === 'phone') g.bt = p.bt
    if (p.eq !== undefined && g.kind === 'phone') {
      if (p.eq === 'auto') g.eq = { mode: 'auto', hp: autoEq(g.seat).hp, lp: autoEq(g.seat).lp }
      else if (p.eq === 'full') g.eq = { mode: 'full', hp: 0, lp: 0 }
      else if (p.eq && typeof p.eq === 'object') g.eq = { mode: 'custom', hp: clamp(Math.round(numOr(p.eq.hp, 0)), 0, 400), lp: clamp(Math.round(numOr(p.eq.lp, 0)), 0, 20000) }
      else return err(400, 'bad_setting')
    }
    broadcastState(room)
    return { ok: true, trimMs: g.trimMs, gainDb: g.gainDb }
  }

  function kick({ token, gid } = {}) {
    const a = hostOnly(token)
    if (a.error) return a.error
    const { room } = a
    const g = typeof gid === 'string' ? room.guests.get(gid) : null
    if (!g || g.kind !== 'phone') return err(404, 'no_such_guest')
    for (const s of g.sinks) { try { s.write('kicked', JSON.stringify({ reason: 'removed_by_host' })) } catch {} }
    if (g.ipHash) room.bannedIps.add(g.ipHash)
    removeGuest(room, g, 'removed')
    return { ok: true }
  }

  /** The beep test: the screen and every phone beep in turn (or all at once) so the owner can hear whether they line up. */
  function beep({ token, action, pattern } = {}) {
    const a = hostOnly(token)
    if (a.error) return a.error
    const { room } = a
    if (action === 'stop') { room.beep = null; broadcastState(room); return { ok: true } }
    if (action !== 'start') return err(400, 'bad_command')
    const list = phones(room).filter(isPresent).sort((x, y) => x.joinOrder - y.joinOrder)
    const slots = [{ id: 'tv', name: 'The screen' }, ...list.map((g) => ({ id: g.gid, name: g.name }))].map((s, i) => ({ ...s, freq: 700 + 130 * (i % 7) }))
    const together = pattern === 'together'
    const rounds = together ? 8 : 2
    const startAt = now() + LIMITS.beepLeadMs
    const span = together ? LIMITS.beepIntervalMs : LIMITS.beepIntervalMs * slots.length
    room.beep = { id: ++room.beepCounter, pattern: together ? 'together' : 'turns', startAt, intervalMs: LIMITS.beepIntervalMs, rounds, slots: together ? slots.map((s) => ({ ...s, freq: 1000 })) : slots, endAt: startAt + span * rounds + 800 }
    broadcastState(room)
    return { ok: true, beep: room.beep }
  }

  /** The room code, for the screen's QR code and link (only the screen's token may ask: the code is the key to the room). */
  function hostInfo({ token } = {}) {
    const a = hostOnly(token)
    if (a.error) return a.error
    return { ok: true, code: a.room.code }
  }

  function close({ token } = {}) {
    const a = hostOnly(token)
    if (a.error) return a.error
    closeRoom(a.room, 'closed_by_host')
    return { ok: true }
  }

  /** Used by the HTTP layer for audio requests: is this token allowed pieces of this room's film, and is the request stale? */
  function audioAccess({ token, seq } = {}) {
    const a = auth(token)
    if (a.error) return a.error
    const gate = audioRate.hit(a.g.gid)
    if (!gate.ok) return err(429, 'rate_limited', { retryAfterSeconds: gate.retryAfterSeconds })
    // A phone that has not heard about the latest play / pause / seek yet asks for pieces of the OLD plan; answering
    // would make ffmpeg jump back to where it came from. It is told "stale" and asks again once it has caught up.
    const s = Number(seq)
    if (Number.isFinite(s) && s < a.room.timeline.seq) return err(409, 'stale', { timeline: timelineOf(a.room) })
    return { ok: true, audioKey: a.room.audioKey, room: a.room, gid: a.g.gid, timelineSeq: a.room.timeline.seq }
  }

  // ---------------------------------------------------------------- housekeeping
  /** Call about once a second. */
  function sweep() {
    const t = now()
    for (const room of Array.from(rooms.values())) {
      if (t - room.createdAt > LIMITS.maxAgeMs) { closeRoom(room, 'expired'); continue }
      let changed = false
      let timelineChanged = false
      const tv = tvOf(room)
      if (!tv || (!isConnected(tv) && t - (tv.disconnectedAt || tv.lastSeen) > LIMITS.tvGoneMs)) { closeRoom(room, 'screen_gone'); continue }
      for (const g of Array.from(room.guests.values())) {
        if (g.kind !== 'phone') continue
        const c = isConnected(g)
        if (c !== g.connLast) { g.connLast = c; changed = true } // a stream that dropped a few seconds ago has now aged out of "connected"
        if (c) continue
        if (!g.disconnectedAt) { g.disconnectedAt = t; changed = true }
        if (t - g.disconnectedAt > LIMITS.removeAwayMs) { removeGuest(room, g, 'timed out'); changed = false; continue }
      }
      if (!rooms.has(room.code)) continue
      if (room.hold && t - (room.hold.since || t) > LIMITS.holdMaxMs) {
        if (room.hold.resume) startPlaying(room); else room.hold = null
        changed = true; timelineChanged = true
      } else if (room.hold && resumeIfReady(room)) { changed = true; timelineChanged = true }
      if (room.beep && room.beep.endAt < t) { room.beep = null; changed = true }
      if (room.dirty) { room.dirty = false; changed = true }
      if (changed) broadcastState(room)
      if (timelineChanged) broadcastTimeline(room)
    }
  }

  function summary() {
    return Array.from(rooms.values()).map((r) => ({ roomId: r.id, kind: r.media.kind, title: r.media.title, phones: phones(r).length, mode: r.mode, createdAt: r.createdAt }))
  }
  function closeAll(reason = 'server_stopped') { for (const r of Array.from(rooms.values())) closeRoom(r, reason) }

  return {
    now, createRoom, resumeHost, roomsOf, preview, join, leave, attach, poll, ping, status,
    command, sync: sync_, setSettings, setSeat, autoSeat, tune, kick, beep, close, hostInfo, audioAccess,
    sweep, summary, closeAll, statusOf: () => ({ rooms: rooms.size }),
    // for tests and the HTTP layer
    _rooms: rooms, _guestIndex: guestIndex, roomCount: () => rooms.size, snapshotFor, findRoom
  }
}

module.exports = { createPhoneSpeakers, syncQuality, autoEq, LIMITS, FILL_IN, STATES }
