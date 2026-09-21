'use strict'
// ============================================================================
// movieNight.js - Movie Night rooms: the TV hub, up to 12 guests on phones, games, scores, reactions.
// ----------------------------------------------------------------------------
// The room manager. No HTTP, no timers of its own (the caller drives sweep()), no I/O: everything takes an
// injectable clock and random source, so the whole thing is tested deterministically
// (test/movie-night.test.js). The HTTP + Server-Sent-Events side is movieNightHttp.js, the games'
// rules are movieNightGames.js, the library -> questions pool is movieNightLibrary.js, the pages are
// movieNightWeb.js.
//
// WHO IS IN A ROOM (three kinds of "ticket", each an unguessable 192-bit token)
//   tv       the shared screen. Shows the QR, the lobby, questions, scores. Has every host control.
//   guest    a phone. No account: a nickname and a colour. Answers, votes, reacts, suggests a title.
//            The first guest to join becomes a HOST guest (may start games, skip, pause, kick, end)
//            unless the owner turned that off; if they leave, the next one takes over.
//   overlay  read-only. A movie player page holds one to show reactions over the film. It can do nothing.
//
// HOW SOMEONE JOINS (no account, no internet)
//   The TV shows a QR that carries a room code AND a join key. A guest may also type the short code
//   (unless the host chose "QR only"). Wrong codes / keys are counted per address and lock that address
//   out for a while; the answer is the same for "no such room" and "wrong key".
//
// PRIVACY (this is used in living rooms with children in them)
//   * Nothing is stored: rooms live in memory and end with the night. No accounts, no analytics, no ads.
//   * A guest's nickname is the only thing they give. It is length-capped, stripped of control / bidi
//     characters and links, and shown with textContent only.
//   * Addresses are used to rate-limit and to keep a kicked guest out; in the room they are only kept as a
//     salted hash.
//   * Only titles the host's own profile may see (and inside the owner's rating cap) are ever in a game.
//
// ANSWERS ARE NEVER SENT EARLY: a question goes to the screens without its answer until the reveal.
// ============================================================================

const crypto = require('crypto')
const games = require('./movieNightGames')
const library = require('./movieNightLibrary')
const { createRateLimiter, createAttemptLimiter, REACTIONS } = require('./watchTogether')

const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ' // 31 characters, nothing that looks like another
const CODE_LENGTH = 6
const TICKET_RE = /^[A-Za-z0-9_-]{32}$/
const KEY_RE = /^[A-Za-z0-9_-]{16}$/

const LIMITS = Object.freeze({
  maxRooms: 60,
  maxRoomsPerAddress: 3,
  maxGuests: 12,
  nameMax: 16,
  sinksPerGuest: 2,
  sinksPerTv: 3,
  sinksPerOverlay: 5,
  maxCandidates: 8,
  suggestionsPerGuest: 2,
  voteFill: 5,
  emptyMs: 10 * 60 * 1000, // nobody connected for this long: the room ends
  maxAgeMs: 10 * 3600 * 1000,
  scoreboardMs: 45 * 1000,
  voteMs: 60 * 1000,
  claimMs: 15 * 60 * 1000
})

const COLORS = Object.freeze([
  { id: 'coral', name: 'Coral', hex: '#ff6b6b', glyph: '●' },
  { id: 'orange', name: 'Orange', hex: '#ffa94d', glyph: '■' },
  { id: 'yellow', name: 'Yellow', hex: '#ffe066', glyph: '▲' },
  { id: 'lime', name: 'Lime', hex: '#a9e34b', glyph: '◆' },
  { id: 'mint', name: 'Mint', hex: '#38d9a9', glyph: '★' },
  { id: 'cyan', name: 'Cyan', hex: '#22b8cf', glyph: '✚' },
  { id: 'sky', name: 'Sky', hex: '#4dabf7', glyph: '▼' },
  { id: 'indigo', name: 'Indigo', hex: '#748ffc', glyph: '♥' },
  { id: 'violet', name: 'Violet', hex: '#da77f2', glyph: '♣' },
  { id: 'pink', name: 'Pink', hex: '#f783ac', glyph: '♠' },
  { id: 'white', name: 'White', hex: '#f1f3f5', glyph: '⬢' },
  { id: 'silver', name: 'Silver', hex: '#adb5bd', glyph: '☾' }
])

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  maxGuests: 12,
  games: games.GAME_IDS.filter((g) => g !== 'intermission'),
  ratingCap: 'PG-13',
  includeUnrated: false,
  allowSuggestions: false,
  homeOnly: true,
  anonymousTv: true,
  phoneHost: true,
  sounds: false
})

/** Whatever the store holds -> a complete, safe settings object. */
function normalizeSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const gamesList = Array.isArray(r.games) ? r.games.filter((g) => games.GAME_IDS.includes(g) && g !== 'intermission') : DEFAULT_SETTINGS.games
  const maxGuests = Number.isInteger(r.maxGuests) ? Math.max(1, Math.min(LIMITS.maxGuests, r.maxGuests)) : DEFAULT_SETTINGS.maxGuests
  const caps = ['none', 'G', 'PG', 'PG-13', 'R']
  return {
    enabled: r.enabled !== false,
    maxGuests,
    games: gamesList,
    ratingCap: caps.includes(r.ratingCap) ? r.ratingCap : DEFAULT_SETTINGS.ratingCap,
    includeUnrated: r.includeUnrated === true,
    allowSuggestions: r.allowSuggestions === true,
    homeOnly: r.homeOnly !== false,
    anonymousTv: r.anonymousTv !== false,
    phoneHost: r.phoneHost !== false,
    sounds: r.sounds === true
  }
}

// ---- text and tokens ------------------------------------------------------------------------------

const INVISIBLE_RE = new RegExp('[\\u0000-\\u001F\\u007F-\\u009F\\u00AD\\u061C\\u180E\\u200B-\\u200F\\u2028-\\u202E\\u2060-\\u206F\\uFEFF\\uFFF9-\\uFFFB]', 'g')
function cleanText(value, max) {
  let s = typeof value === 'string' ? value : ''
  if (s.length > max * 4) s = s.slice(0, max * 4)
  try { s = s.normalize('NFC') } catch { /* keep as is */ }
  s = s.replace(INVISIBLE_RE, ' ').replace(/\s+/g, ' ').trim()
  const cps = Array.from(s)
  return cps.length > max ? cps.slice(0, max).join('').trim() : s
}

// A nickname is not a place to advertise: no links, e-mail addresses or "dot com" strings.
const LINKISH_RE = /(https?:|www\.|\.[a-z]{2,4}(\/|$)|@[a-z0-9]|[a-z0-9]\.(com|net|org|io|tv|ly|gg|co|me|xyz)\b)/i
function cleanNickname(value) {
  const s = cleanText(value, LIMITS.nameMax)
  if (!s || LINKISH_RE.test(s)) return ''
  return s
}

const newTicket = () => crypto.randomBytes(24).toString('base64url') // 32 characters
const newKey = () => crypto.randomBytes(12).toString('base64url') // 16 characters

function newCode(isTaken) {
  for (let i = 0; i < 80; i++) {
    let c = ''
    for (let j = 0; j < CODE_LENGTH; j++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]
    if (!isTaken(c)) return c
  }
  return null
}

/** What a person typed -> the canonical room code, or ''. */
function normalizeCode(raw) {
  if (typeof raw !== 'string' || raw.length > 24) return ''
  const s = raw.toUpperCase().replace(/[\s-]/g, '')
  if (s.length !== CODE_LENGTH) return ''
  for (const ch of s) if (!CODE_ALPHABET.includes(ch)) return ''
  return s
}
const normalizeKey = (raw) => (typeof raw === 'string' && KEY_RE.test(raw) ? raw : '')
const normalizeTicket = (raw) => (typeof raw === 'string' && TICKET_RE.test(raw) ? raw : '')

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest()
  const hb = crypto.createHash('sha256').update(String(b)).digest()
  return crypto.timingSafeEqual(ha, hb)
}

const err = (status, error, extra) => ({ ok: false, status, error, ...(extra || {}) })

/**
 * opts: { now, log, rng, randomBytes(no), getSettings() -> owner settings, getPool({ userId, settings }) -> Promise<{ items, stats }>,
 *         timing (test overrides), rates (test overrides) }
 */
function createMovieNight(opts = {}) {
  const now = opts.now || (() => Date.now())
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const rng = opts.rng || games.cryptoRng()
  const timing = { ...games.DEFAULT_TIMING, ...(opts.timing || {}) }
  const getSettings = () => normalizeSettings(typeof opts.getSettings === 'function' ? opts.getSettings() : null)
  const getPool = typeof opts.getPool === 'function' ? opts.getPool : async () => ({ items: [], stats: {} })
  const rates = opts.rates || {}
  const salt = crypto.randomBytes(8).toString('hex')

  const rooms = new Map() // code -> room
  const tokens = new Map() // ticket -> { code, role, gid }
  const joinRate = createRateLimiter({ limit: rates.join || 30, windowMs: 10 * 60 * 1000, now })
  const attempts = createAttemptLimiter({ max: rates.attempts || 10, windowMs: 15 * 60 * 1000, now })
  const createRate = createRateLimiter({ limit: rates.create || 8, windowMs: 3600 * 1000, now })
  const actRate = createRateLimiter({ limit: rates.act || 60, windowMs: 10000, now })
  const answerRate = createRateLimiter({ limit: rates.answer || 20, windowMs: 10000, now })
  const reactRate = createRateLimiter({ limit: rates.react || 8, windowMs: 10000, now })
  const roomReactRate = createRateLimiter({ limit: rates.roomReact || 60, windowMs: 10000, now })
  const suggestRate = createRateLimiter({ limit: rates.suggest || 6, windowMs: 60000, now })
  const searchRate = createRateLimiter({ limit: rates.search || 20, windowMs: 60000, now })

  const hashAddr = (room, ip) => crypto.createHash('sha256').update(`${salt}|${room.code}|${ip || ''}`).digest('hex').slice(0, 16)

  // ---- lookups -----------------------------------------------------------------------------------
  const findRoom = (code) => { const c = normalizeCode(code); return c ? rooms.get(c) || null : null }
  function lookup(ticket) {
    const t = normalizeTicket(ticket)
    const ref = t ? tokens.get(t) : null
    if (!ref) return null
    const room = rooms.get(ref.code)
    if (!room) { tokens.delete(t); return null }
    if (ref.role === 'guest') {
      const guest = room.guests.get(ref.gid)
      if (!guest) return null
      return { room, role: 'guest', guest }
    }
    return { room, role: ref.role, guest: null }
  }
  const connected = (g) => g.sinks.size > 0 || (g.lastSeen && now() - g.lastSeen < 10000)
  const guestList = (room) => Array.from(room.guests.values()).sort((a, b) => a.joinedAt - b.joinedAt)

  // ---- delivering state --------------------------------------------------------------------------
  function emitTo(sinks, event, data, id) {
    const text = typeof data === 'string' ? data : JSON.stringify(data)
    for (const s of Array.from(sinks)) {
      try { s.write(event, text, id) } catch { sinks.delete(s); try { s.close && s.close() } catch { /* gone */ } }
    }
  }

  function broadcast(room) {
    room.dirty = false
    room.lastActivity = now()
    const id = ++room.eventSeq
    emitTo(room.tvSinks, 'state', viewFor(room, 'tv', null), id)
    for (const g of room.guests.values()) if (g.sinks.size) emitTo(g.sinks, 'state', viewFor(room, 'guest', g), id)
  }
  const markDirty = (room) => { room.dirty = true }

  // ---- views: what each kind of screen may see -----------------------------------------------------
  function menuFor(room) {
    const avail = games.availability(room.pool)
    const enabled = new Set(room.settings.games)
    return games.GAME_IDS.filter((id) => id !== 'intermission' && enabled.has(id)).map((id) => ({
      id, title: games.GAME_INFO[id].title, blurb: games.GAME_INFO[id].blurb, ready: !!avail[id].ready, why: avail[id].why, quiz: games.GAME_INFO[id].quiz
    }))
  }

  function guestPublic(room, g, extra) {
    const c = COLORS[g.colorIdx]
    return {
      id: g.id, name: g.name, color: c.hex, colorName: c.name, glyph: c.glyph, team: g.team, host: g.id === room.hostGuestId,
      connected: connected(g), score: g.total, ...(extra || {})
    }
  }

  function teamsView(room) {
    if (!room.teamCount) return null
    const members = guestList(room).map((g) => ({ team: g.team, score: g.total }))
    return games.teamScores(members, room.teamCount)
  }

  function questionRuntime(room, role) {
    const g = room.game
    if (!g || g.kind !== 'quiz') return null
    const q = g.questions[g.index]
    const elapsed = g.paused ? g.paused.at - g.qStart : now() - g.qStart
    const stage = games.stageAt(q, elapsed)
    const pq = games.publicQuestion(q, { role, phase: g.phase, stage })
    return pq
  }

  function leaderboard(room, limit) {
    const g = room.game
    const rows = guestList(room).map((x) => ({ id: x.id, name: x.name, score: g ? g.scores.get(x.id) || 0 : x.total }))
    return games.rank(rows).slice(0, limit || 5).map((r) => {
      const gg = room.guests.get(r.id)
      const c = COLORS[gg.colorIdx]
      return { id: r.id, name: r.name, points: r.score, total: gg.total, rank: r.rank, color: c.hex, glyph: c.glyph }
    })
  }

  function gameView(room, role, guest) {
    const g = room.game
    if (!g) return null
    const t = now()
    if (g.kind === 'quiz') {
      const expected = guestList(room).filter(connected).length
      const answered = guestList(room).filter((x) => g.answers.has(x.id)).length
      const out = {
        type: g.type, title: g.title, kind: 'quiz', index: g.index + 1, total: g.questions.length, phase: g.phase,
        paused: !!g.paused, deadline: g.paused ? null : g.phase === 'ask' ? g.deadline : g.revealDeadline,
        remainingMs: g.paused ? g.paused.remaining : Math.max(0, (g.phase === 'ask' ? g.deadline : g.revealDeadline) - t),
        question: questionRuntime(room, role), answered, expected
      }
      if (g.phase === 'reveal') {
        out.reveal = { results: g.reveal.results, leaderboard: leaderboard(room, 5), correctText: g.reveal.correctText }
      }
      if (role === 'tv') out.answeredIds = guestList(room).filter((x) => g.answers.has(x.id)).map((x) => x.id)
      if (guest) {
        out.mine = { answered: g.answers.has(guest.id), value: g.answers.has(guest.id) ? g.answers.get(guest.id).value : null }
        if (g.phase === 'reveal') out.mine.result = g.reveal.results.find((r) => r.id === guest.id) || null
      }
      return out
    }
    // vote
    const tallyRows = games.tally(g.vote, guestList(room).map((x) => x.id))
    const out = {
      type: g.type, title: g.title, kind: 'vote', phase: g.phase, paused: !!g.paused,
      deadline: g.paused ? null : g.deadline, remainingMs: g.paused ? g.paused.remaining : Math.max(0, g.deadline - t),
      candidates: g.vote.candidates.map((c) => ({ key: c.key, title: c.title, year: c.year, poster: role === 'tv' ? c.poster : null, by: c.by })),
      voted: guestList(room).filter((x) => { const b = g.vote.ballots.get(x.id); return !!(b && b.done) }).length, expected: guestList(room).filter(connected).length
    }
    if (g.phase === 'result') {
      out.decision = { winner: g.decision.winner, method: g.decision.method, tied: g.decision.tied, rows: g.decision.rows.map((r) => ({ key: r.key, approvals: r.approvals, vetoes: r.vetoes, net: r.net, out: r.out })) }
      out.winner = g.vote.candidates.find((c) => c.key === g.decision.winner) || null
      if (out.winner && role !== 'tv') out.winner = { ...out.winner, poster: null }
    } else if (role === 'tv') {
      out.counts = tallyRows.voters
    }
    if (guest) out.mine = { ballot: g.vote.ballots.get(guest.id) || null }
    return out
  }

  function viewFor(room, role, guest) {
    const t = now()
    const view = {
      v: 1, seq: room.eventSeq, now: t, code: room.code, phase: room.phase, paused: !!(room.game && room.game.paused),
      locked: room.locked, qrOnly: room.qrOnly, hostName: room.hostName,
      settings: { teams: room.teamCount, maxGuests: room.maxGuests, allowSuggestions: room.settings.allowSuggestions, rounds: room.rounds, sounds: room.settings.sounds },
      guests: guestList(room).map((g) => guestPublic(room, g, role === 'tv' && room.game && room.game.answers ? { answered: room.game.answers.has(g.id) } : undefined)),
      hostGuestId: room.hostGuestId,
      teams: teamsView(room),
      featured: room.featured ? { key: room.featured.key, title: room.featured.title, year: room.featured.year, poster: role === 'tv' ? room.featured.poster : null } : null,
      suggestions: room.suggestions.map((s) => ({ key: s.key, title: s.title, by: s.byName })),
      pool: { count: room.pool.length, message: room.poolMessage },
      attribution: 'This product uses the TMDB API but is not endorsed or certified by TMDB.'
    }
    if (room.phase === 'lobby' || room.phase === 'scoreboard') view.menu = menuFor(room)
    if (room.phase === 'game' || room.phase === 'result') view.game = gameView(room, role, guest)
    if (room.phase === 'scoreboard') view.scoreboard = room.scoreboard
    if (role === 'tv') {
      view.joinKey = room.joinKey
      view.overlayTicket = room.overlayTicket
      view.tvSounds = room.settings.sounds
      view.launch = room.launchSeq
    }
    if (role === 'guest') {
      const g = guest
      const c = COLORS[g.colorIdx]
      view.me = { id: g.id, name: g.name, color: c.hex, colorName: c.name, glyph: c.glyph, team: g.team, host: g.id === room.hostGuestId, total: g.total, lastPoints: g.lastPoints }
      view.colors = COLORS.map((x) => ({ id: x.id, name: x.name, hex: x.hex, glyph: x.glyph, taken: guestList(room).some((o) => o.colorIdx === COLORS.indexOf(x) && o.id !== g.id) }))
      view.reactions = REACTIONS
      if (g.id === room.hostGuestId) view.hostControls = true
    }
    return view
  }

  // ---- creating rooms ----------------------------------------------------------------------------
  /**
   * { hostUserId, hostName, ip, featured: { key, title } | null, forTv: true (a TV will claim it: the ticket is held) }
   */
  async function createRoom({ hostUserId = null, hostName = '', ip = '', featured = null, awaitTv = false, strictFeatured = false } = {}) {
    const settings = getSettings()
    if (!settings.enabled) return err(403, 'disabled')
    if (rooms.size >= LIMITS.maxRooms) return err(503, 'server_busy')
    const who = hostUserId ? 'u:' + hostUserId : 'ip:' + ip
    const hit = createRate.hit(who)
    if (!hit.ok) return err(429, 'rate_limited', { retryAfterSeconds: hit.retryAfterSeconds })
    const open = Array.from(rooms.values()).filter((r) => (hostUserId ? r.hostUserId === hostUserId : r.creatorAddr === ip))
    if (open.length >= LIMITS.maxRoomsPerAddress) {
      // Do not lock people out of their own living room: end the oldest one and carry on.
      open.sort((a, b) => a.createdAt - b.createdAt)
      closeRoom(open[0], 'replaced')
    }
    const code = newCode((c) => rooms.has(c))
    if (!code) return err(503, 'server_busy')
    let pool = { items: [], stats: {} }
    try { pool = (await getPool({ userId: hostUserId, settings })) || pool } catch (e) { log(`[movie-night] pool failed: ${e && e.message}`) }
    const t = now()
    const room = {
      code, joinKey: newKey(), tvTicket: newTicket(), overlayTicket: newTicket(),
      hostUserId, hostName: cleanText(hostName, 32), creatorAddr: ip, createdAt: t, lastActivity: t, lastPopulated: t, lastConnected: t,
      settings, phase: 'lobby', locked: false, qrOnly: false, teamCount: 0, rounds: 0, maxGuests: settings.maxGuests,
      guests: new Map(), hostGuestId: null, banned: new Set(), pool: pool.items || [], poolStats: pool.stats || {}, poolMessage: '',
      tvSinks: new Set(), overlaySinks: new Set(), eventSeq: 0, dirty: false, launchSeq: 0,
      game: null, scoreboard: null, scoreboardUntil: 0, suggestions: [], featured: null,
      claimUntil: awaitTv ? t + LIMITS.claimMs : 0
    }
    room.poolMessage = poolNote(room)
    if (featured && typeof featured.key === 'string' && /^[A-Za-z0-9_-]{1,700}$/.test(featured.key)) {
      const inPool = room.pool.find((m) => m.key === featured.key)
      if (inPool) room.featured = { key: inPool.key, title: inPool.title, year: inPool.year, poster: inPool.poster, playHref: inPool.playHref }
      else if (!strictFeatured && featured.title) room.featured = { key: featured.key, title: cleanText(featured.title, 120), year: null, poster: null, playHref: `/watch?id=${encodeURIComponent(featured.key)}` }
    }
    rooms.set(code, room)
    tokens.set(room.tvTicket, { code, role: 'tv' })
    tokens.set(room.overlayTicket, { code, role: 'overlay' })
    log(`[movie-night] room ${roomTag(room)} opened (${room.pool.length} titles)`)
    return { ok: true, code, joinKey: room.joinKey, ticket: room.tvTicket, overlayTicket: room.overlayTicket, awaitingTv: !!awaitTv, poolCount: room.pool.length }
  }

  const roomTag = (room) => crypto.createHash('sha256').update('mn|' + room.code).digest('hex').slice(0, 8)

  function poolNote(room) {
    const n = room.pool.length
    if (n >= 4) return ''
    const s = room.poolStats || {}
    if (room.settings.ratingCap !== 'none' && (s.unrated || 0) > 0 && n < 4) return 'Too few films have a rating saved yet. Open some film pages while online, or change the rating limit in Settings.'
    return 'Not enough films with details saved yet. Open some film pages while online so their posters and cast are saved.'
  }

  /** A TV asks for the room the desktop app made for it (once). */
  function claimRoom({ userId = null } = {}) {
    const t = now()
    // An anonymous TV may take any waiting room; a TV that is signed in only takes its own person's.
    const list = Array.from(rooms.values()).filter((r) => r.claimUntil > t && (!userId || r.hostUserId === userId)).sort((a, b) => a.createdAt - b.createdAt)
    const room = list[0]
    if (!room) return null
    room.claimUntil = 0
    return { ok: true, code: room.code, joinKey: room.joinKey, ticket: room.tvTicket, overlayTicket: room.overlayTicket, claimed: true, poolCount: room.pool.length }
  }

  async function refreshPool(room) {
    const t = now()
    if (t - room.lastPopulated < 30000) return
    room.lastPopulated = t
    try {
      const p = await getPool({ userId: room.hostUserId, settings: room.settings })
      if (p && Array.isArray(p.items)) { room.pool = p.items; room.poolStats = p.stats || {}; room.poolMessage = poolNote(room) }
    } catch (e) { log(`[movie-night] pool refresh failed: ${e && e.message}`) }
  }

  // ---- joining -------------------------------------------------------------------------------------
  function preview({ code, key, ip }) {
    const lock = attempts.locked(ip)
    if (lock) return err(429, 'locked', { retryAfterMinutes: lock })
    const room = findRoom(code)
    const keyGiven = normalizeKey(key)
    const ok = room && (keyGiven ? safeEqual(room.joinKey, keyGiven) : !room.qrOnly)
    if (!ok) { attempts.fail(ip); return err(404, 'not_found') }
    return { ok: true, hostName: room.hostName, guests: room.guests.size, max: room.maxGuests, locked: room.locked, colors: COLORS.map((c, i) => ({ id: c.id, name: c.name, hex: c.hex, glyph: c.glyph, taken: guestList(room).some((g) => g.colorIdx === i) })) }
  }

  function join({ code, key, name, colorId, ip }) {
    const lock = attempts.locked(ip)
    if (lock) return err(429, 'locked', { retryAfterMinutes: lock })
    const jr = joinRate.hit('ip:' + ip)
    if (!jr.ok) return err(429, 'rate_limited', { retryAfterSeconds: jr.retryAfterSeconds })
    const room = findRoom(code)
    const keyGiven = normalizeKey(key)
    const authorised = room && (keyGiven ? safeEqual(room.joinKey, keyGiven) : !room.qrOnly)
    if (!authorised) { attempts.fail(ip); return err(404, 'not_found') }
    if (room.locked) return err(403, 'locked_room')
    if (room.guests.size >= room.maxGuests) return err(409, 'room_full')
    const nick = cleanNickname(name)
    if (!nick) return err(400, 'bad_name')
    const addr = hashAddr(room, ip)
    const nameKey = nick.toLowerCase()
    if (room.banned.has(addr + '|' + nameKey)) return err(404, 'not_found')
    // Unique nickname: "Sam", "Sam 2", ...
    let finalName = nick
    const taken = new Set(guestList(room).map((g) => g.name.toLowerCase()))
    for (let n = 2; taken.has(finalName.toLowerCase()); n++) finalName = cleanText(`${nick.slice(0, LIMITS.nameMax - 2)} ${n}`, LIMITS.nameMax)
    const used = new Set(guestList(room).map((g) => g.colorIdx))
    let colorIdx = COLORS.findIndex((c) => c.id === colorId)
    if (colorIdx < 0 || used.has(colorIdx)) colorIdx = COLORS.findIndex((_, i) => !used.has(i))
    if (colorIdx < 0) return err(409, 'room_full')
    const t = now()
    const guest = {
      id: 'g' + crypto.randomBytes(4).toString('hex'), name: finalName, colorIdx, ticket: newTicket(), addr, joinedAt: t, lastSeen: t,
      sinks: new Set(), total: 0, lastPoints: 0, team: room.teamCount ? games.nextTeam(guestList(room), room.teamCount) : null, suggested: 0
    }
    room.guests.set(guest.id, guest)
    tokens.set(guest.ticket, { code: room.code, role: 'guest', gid: guest.id })
    if (room.settings.phoneHost && !room.hostGuestId) room.hostGuestId = guest.id
    room.lastActivity = t
    room.lastConnected = t
    log(`[movie-night] room ${roomTag(room)} guest joined (${room.guests.size})`)
    broadcast(room)
    return { ok: true, ticket: guest.ticket, guestId: guest.id, name: guest.name, host: guest.id === room.hostGuestId }
  }

  function removeGuest(room, guest, reason) {
    room.guests.delete(guest.id)
    tokens.delete(guest.ticket)
    emitTo(guest.sinks, reason === 'kicked' ? 'kicked' : 'closed', { reason })
    for (const s of guest.sinks) { try { s.close && s.close() } catch { /* gone */ } }
    guest.sinks.clear()
    if (room.game && room.game.answers) room.game.answers.delete(guest.id)
    if (room.game && room.game.kind === 'vote') room.game.vote.ballots.delete(guest.id)
    room.suggestions = room.suggestions.filter((s) => s.by !== guest.id)
    if (room.hostGuestId === guest.id) {
      const next = room.settings.phoneHost ? guestList(room).sort((a, b) => (connected(b) ? 1 : 0) - (connected(a) ? 1 : 0) || a.joinedAt - b.joinedAt)[0] : null
      room.hostGuestId = next ? next.id : null
    }
  }

  /** Deal everyone into the teams again, in a fair random order (host: "shuffle teams"). Otherwise teams
   *  are left alone when someone leaves, and each newcomer joins the smallest team. */
  function shuffleTeams(room) {
    const order = games.shuffle(guestList(room), rng)
    order.forEach((g, i) => { g.team = room.teamCount ? i % room.teamCount : null })
  }

  function closeRoom(room, reason) {
    if (!rooms.has(room.code)) return
    try { emitTo(room.tvSinks, 'closed', { reason }); emitTo(room.overlaySinks, 'closed', { reason }) } catch { /* ignore */ }
    for (const g of room.guests.values()) { try { emitTo(g.sinks, 'closed', { reason }) } catch { /* ignore */ } for (const s of g.sinks) { try { s.close && s.close() } catch { /* gone */ } } tokens.delete(g.ticket) }
    for (const s of room.tvSinks) { try { s.close && s.close() } catch { /* gone */ } }
    for (const s of room.overlaySinks) { try { s.close && s.close() } catch { /* gone */ } }
    tokens.delete(room.tvTicket)
    tokens.delete(room.overlayTicket)
    rooms.delete(room.code)
    log(`[movie-night] room ${roomTag(room)} closed (${reason})`)
  }

  // ---- connections (server -> phone / TV) ------------------------------------------------------------
  function attach({ ticket, sink }) {
    const who = lookup(ticket)
    if (!who) return err(404, 'not_found')
    const { room, role, guest } = who
    const set = role === 'guest' ? guest.sinks : role === 'tv' ? room.tvSinks : room.overlaySinks
    const cap = role === 'guest' ? LIMITS.sinksPerGuest : role === 'tv' ? LIMITS.sinksPerTv : LIMITS.sinksPerOverlay
    while (set.size >= cap) { const old = set.values().next().value; set.delete(old); try { old.close && old.close() } catch { /* gone */ } }
    set.add(sink)
    room.lastConnected = now()
    if (guest) guest.lastSeen = now()
    try {
      if (role === 'overlay') sink.write('state', JSON.stringify({ v: 1, code: room.code, phase: room.phase, overlay: true }), ++room.eventSeq)
      else sink.write('state', JSON.stringify(viewFor(room, role, guest)), room.eventSeq)
    } catch { set.delete(sink); return err(500, 'stream_failed') }
    if (role === 'guest') markDirty(room) // presence changed: everyone learns on the next flush
    return { ok: true, detach() { set.delete(sink); if (guest) guest.lastSeen = now(); markDirty(room) } }
  }

  /** The polling twin of the stream, for networks that break streams. */
  function poll({ ticket, since }) {
    const who = lookup(ticket)
    if (!who) return err(404, 'not_found')
    const { room, role, guest } = who
    if (guest) guest.lastSeen = now()
    room.lastConnected = now()
    if (role === 'overlay') return { ok: true, changed: true, state: { v: 1, code: room.code, phase: room.phase, overlay: true }, seq: room.eventSeq }
    const s = Number(since)
    const view = viewFor(room, role, guest)
    // A quiz has a clock in it, so a poll always gets the state; `seq` lets a client skip work if nothing moved.
    return { ok: true, changed: !(Number.isFinite(s) && s === room.eventSeq && !room.dirty && !room.game), state: view, seq: room.eventSeq }
  }

  // ---- actions -----------------------------------------------------------------------------------------
  const isHost = (room, role, guest) => role === 'tv' || (role === 'guest' && guest && guest.id === room.hostGuestId)

  /** Everything a client can do goes through here: { ticket, type, ...payload }. */
  async function act({ ticket, type, ip, ...p }) {
    const who = lookup(ticket)
    if (!who) return err(404, 'not_found')
    const { room, role, guest } = who
    if (role === 'overlay') return err(403, 'not_allowed')
    const gate = actRate.hit(ticket)
    if (!gate.ok) return err(429, 'rate_limited', { retryAfterSeconds: gate.retryAfterSeconds })
    if (guest) { guest.lastSeen = now() }
    room.lastActivity = now()
    switch (type) {
      case 'ping': return { ok: true, seq: room.eventSeq }
      case 'answer': return answer(room, guest, p)
      case 'vote': return castVote(room, guest, p)
      case 'react': return react(room, guest, p)
      case 'suggest': return suggest(room, guest, p)
      case 'rename': return rename(room, guest, p)
      case 'color': return recolor(room, guest, p)
      case 'leave': if (!guest) return err(400, 'bad_request'); removeGuest(room, guest, 'left'); broadcast(room); return { ok: true }
      default: break
    }
    if (!isHost(room, role, guest)) return err(403, 'not_allowed')
    switch (type) {
      case 'start': return startGame(room, p)
      case 'skip': case 'next': return skip(room)
      case 'pause': return pause(room)
      case 'resume': return resume(room)
      case 'endGame': return endGame(room)
      case 'lobby': return toLobby(room)
      case 'kick': return kick(room, guest, p)
      case 'makeHost': return makeHost(room, p)
      case 'lock': room.locked = !!p.value; broadcast(room); return { ok: true }
      case 'qrOnly': room.qrOnly = !!p.value; broadcast(room); return { ok: true }
      case 'teams': return setTeams(room, p)
      case 'shuffleTeams': if (!room.teamCount) return err(400, 'bad_request'); shuffleTeams(room); broadcast(room); return { ok: true }
      case 'rounds': return setRounds(room, p)
      case 'launch': return launch(room)
      case 'close': closeRoom(room, 'ended_by_host'); return { ok: true }
      default: return err(400, 'bad_request')
    }
  }

  // ---- guest actions ---------------------------------------------------------------------------------
  function answer(room, guest, p) {
    if (!guest) return err(403, 'not_allowed')
    const g = room.game
    if (!g || g.kind !== 'quiz' || g.phase !== 'ask' || g.paused) return err(409, 'not_open')
    const r = answerRate.hit(guest.id)
    if (!r.ok) return err(429, 'rate_limited', { retryAfterSeconds: r.retryAfterSeconds })
    if (g.answers.has(guest.id)) return { ok: true, locked: true } // the first answer stands
    const q = g.questions[g.index]
    const value = games.validateAnswer(q, p.value)
    if (value === null) return err(400, 'bad_answer')
    g.answers.set(guest.id, { value, elapsedMs: Math.max(0, now() - g.qStart) })
    markDirty(room)
    return { ok: true, locked: true }
  }

  function castVote(room, guest, p) {
    if (!guest) return err(403, 'not_allowed')
    const g = room.game
    if (!g || g.kind !== 'vote' || g.phase !== 'vote') return err(409, 'not_open')
    const r = answerRate.hit(guest.id)
    if (!r.ok) return err(429, 'rate_limited', { retryAfterSeconds: r.retryAfterSeconds })
    const ballot = games.castBallot(g.vote, guest.id, { approve: Array.isArray(p.approve) ? p.approve.slice(0, 20) : [], veto: p.veto, done: p.done === true })
    markDirty(room)
    return { ok: true, ballot }
  }

  function react(room, guest, p) {
    if (!guest) return err(403, 'not_allowed')
    if (!REACTIONS.includes(p.emoji)) return err(400, 'bad_reaction')
    const a = reactRate.hit(guest.id)
    const b = roomReactRate.hit(room.code)
    if (!a.ok || !b.ok) return err(429, 'rate_limited', { retryAfterSeconds: (a.ok ? b : a).retryAfterSeconds })
    const c = COLORS[guest.colorIdx]
    const ev = { emoji: p.emoji, name: guest.name, color: c.hex, glyph: c.glyph, at: now() }
    emitTo(room.tvSinks, 'reaction', ev)
    emitTo(room.overlaySinks, 'reaction', ev)
    return { ok: true }
  }

  function rename(room, guest, p) {
    if (!guest) return err(403, 'not_allowed')
    const nick = cleanNickname(p.name)
    if (!nick) return err(400, 'bad_name')
    if (guestList(room).some((g) => g.id !== guest.id && g.name.toLowerCase() === nick.toLowerCase())) return err(409, 'name_taken')
    guest.name = nick
    broadcast(room)
    return { ok: true, name: nick }
  }

  function recolor(room, guest, p) {
    if (!guest) return err(403, 'not_allowed')
    const idx = COLORS.findIndex((c) => c.id === p.colorId)
    if (idx < 0) return err(400, 'bad_request')
    if (guestList(room).some((g) => g.id !== guest.id && g.colorIdx === idx)) return err(409, 'color_taken')
    guest.colorIdx = idx
    broadcast(room)
    return { ok: true }
  }

  function suggest(room, guest, p) {
    if (!guest) return err(403, 'not_allowed')
    if (!room.settings.allowSuggestions) return err(403, 'suggestions_off')
    const r = suggestRate.hit(guest.id)
    if (!r.ok) return err(429, 'rate_limited', { retryAfterSeconds: r.retryAfterSeconds })
    const g = room.game
    const votingNow = g && g.kind === 'vote' && g.phase === 'vote'
    if (!(room.phase === 'lobby' || votingNow)) return err(409, 'not_open')
    const item = room.pool.find((m) => m.key === p.key) // only titles this room is allowed to show
    if (!item) return err(404, 'not_found')
    if (room.suggestions.some((s) => s.key === item.key) || (votingNow && g.vote.candidates.some((c) => c.key === item.key))) return err(409, 'already_suggested')
    if (guest.suggested >= LIMITS.suggestionsPerGuest) return err(429, 'too_many_suggestions')
    const total = votingNow ? g.vote.candidates.length : room.suggestions.length
    if (total >= LIMITS.maxCandidates) return err(409, 'ballot_full')
    guest.suggested++
    if (votingNow) g.vote.candidates.push({ key: item.key, title: item.title, year: item.year, poster: item.poster, by: guest.name })
    else room.suggestions.push({ key: item.key, title: item.title, by: guest.id, byName: guest.name })
    broadcast(room)
    return { ok: true }
  }

  /** "Suggest a movie": title search over the room's own (already filtered) pool. */
  function search({ ticket, q }) {
    const who = lookup(ticket)
    if (!who || who.role !== 'guest') return err(404, 'not_found')
    if (!who.room.settings.allowSuggestions) return err(403, 'suggestions_off')
    const r = searchRate.hit(who.guest.id)
    if (!r.ok) return err(429, 'rate_limited', { retryAfterSeconds: r.retryAfterSeconds })
    return { ok: true, results: library.searchPool(who.room.pool, q, 8) }
  }

  // ---- host actions ----------------------------------------------------------------------------------
  async function startGame(room, p) {
    const id = typeof p.game === 'string' ? p.game : ''
    if (!games.GAME_INFO[id]) return err(400, 'unknown_game')
    if (id !== 'intermission' && !room.settings.games.includes(id)) return err(403, 'game_off')
    if (room.game && room.phase === 'game') return err(409, 'busy')
    if (!room.guests.size) return err(409, 'no_players')
    await refreshPool(room)
    if (!rooms.has(room.code) || room.phase === 'game') return err(409, 'busy')
    const t = now()
    if (id === 'pick-tonight') {
      const avail = games.availability(room.pool)['pick-tonight']
      if (!avail.ready) return err(409, 'not_enough_titles', { need: avail.why })
      const picks = []
      const seen = new Set()
      const add = (m, by) => { if (m && !seen.has(m.key) && picks.length < LIMITS.maxCandidates) { seen.add(m.key); picks.push({ key: m.key, title: m.title, year: m.year, poster: m.poster, by: by || null }) } }
      if (room.featured) add(room.pool.find((m) => m.key === room.featured.key), 'Tonight’s pick')
      for (const s of room.suggestions) add(room.pool.find((m) => m.key === s.key), s.byName)
      for (const m of games.shuffle(room.pool, rng)) { if (picks.length >= Math.min(LIMITS.voteFill, room.pool.length)) break; add(m, null) }
      room.game = { kind: 'vote', type: 'pick-tonight', title: games.GAME_INFO['pick-tonight'].title, phase: 'vote', vote: games.createVote(picks), deadline: t + LIMITS.voteMs, paused: null, decision: null, scores: new Map(), answers: null }
      room.suggestions = []
      room.phase = 'game'
      broadcast(room)
      return { ok: true }
    }
    const rounds = Number.isInteger(p.rounds) && games.ROUND_CHOICES.includes(p.rounds) ? p.rounds : room.rounds > 0 ? room.rounds : undefined
    const built = games.buildGame(id, room.pool, { rounds, rng, timing, featured: room.featured })
    if (!built.ok) return err(409, built.error, { need: built.need })
    room.game = {
      kind: 'quiz', type: id, title: built.title, questions: built.questions, index: 0, phase: 'ask', qStart: t, deadline: t + built.questions[0].timeMs,
      revealDeadline: 0, answers: new Map(), scores: new Map(), reveal: null, paused: null, stage: 0
    }
    for (const g of room.guests.values()) g.lastPoints = 0
    room.phase = 'game'
    broadcast(room)
    return { ok: true, questions: built.questions.length }
  }

  function revealQuestion(room, t) {
    const g = room.game
    const q = g.questions[g.index]
    const answers = Array.from(g.answers.entries()).filter(([id]) => room.guests.has(id)).map(([id, a]) => ({ id, value: a.value, elapsedMs: a.elapsedMs }))
    const scored = games.scoreRound(q, answers)
    const byId = new Map(scored.map((s) => [s.id, s]))
    for (const gu of room.guests.values()) gu.lastPoints = 0
    for (const s of scored) {
      const gu = room.guests.get(s.id)
      gu.lastPoints = s.points
      gu.total += s.points
      g.scores.set(s.id, (g.scores.get(s.id) || 0) + s.points)
    }
    const results = guestList(room).map((gu) => {
      const s = byId.get(gu.id)
      const a = g.answers.get(gu.id)
      return { id: gu.id, answered: !!a, value: a ? a.value : null, points: s ? s.points : 0, correct: s ? s.correct : false, ...(s && s.detail ? { detail: s.detail } : {}) }
    })
    const correctOption = q.type === 'year-guess' ? String(q.correctYear) : (q.options.find((o) => o.id === q.correctId) || {}).text
    g.reveal = { results, correctText: correctOption }
    g.phase = 'reveal'
    g.revealDeadline = t + timing.revealMs
  }

  function nextQuestion(room, t) {
    const g = room.game
    g.index++
    if (g.index >= g.questions.length) { finishGame(room, t); return }
    g.phase = 'ask'
    g.answers = new Map()
    g.reveal = null
    g.qStart = t
    g.deadline = t + g.questions[g.index].timeMs
    g.stage = 0
    for (const gu of room.guests.values()) gu.lastPoints = 0
  }

  function finishGame(room, t) {
    const g = room.game
    const rows = games.rank(guestList(room).map((x) => ({ id: x.id, name: x.name, score: g.scores.get(x.id) || 0 })))
    const teamMembers = guestList(room).map((x) => ({ team: x.team, score: g.scores.get(x.id) || 0 }))
    const teams = room.teamCount ? games.rank(games.teamScores(teamMembers, room.teamCount).map((x) => ({ ...x, id: 't' + x.team }))) : null
    room.scoreboard = {
      title: g.title, type: g.type, at: t,
      rows: rows.map((r) => { const x = room.guests.get(r.id); const c = COLORS[x.colorIdx]; return { id: r.id, name: r.name, points: r.score, total: x.total, rank: r.rank, color: c.hex, glyph: c.glyph, team: x.team } }),
      teams
    }
    room.game = null
    room.phase = 'scoreboard'
    room.scoreboardUntil = t + LIMITS.scoreboardMs
  }

  function toLobby(room) {
    room.game = null
    room.scoreboard = null
    room.phase = 'lobby'
    broadcast(room)
    return { ok: true }
  }

  function endGame(room) {
    const g = room.game
    if (!g) { if (room.phase === 'scoreboard') return toLobby(room); return { ok: true } }
    if (g.kind === 'quiz') { finishGame(room, now()) } else { room.game = null; room.phase = 'lobby' }
    broadcast(room)
    return { ok: true }
  }

  function closeVote(room, t) {
    const g = room.game
    const decision = games.decide(g.vote, rng, guestList(room).map((x) => x.id))
    g.decision = decision
    g.phase = 'result'
    room.phase = 'result'
    g.resultUntil = t + 3 * 60 * 1000
    const winner = room.pool.find((m) => m.key === decision.winner) || g.vote.candidates.find((c) => c.key === decision.winner)
    if (winner) room.featured = { key: winner.key, title: winner.title, year: winner.year || null, poster: winner.poster || null, playHref: winner.playHref || `/watch?id=${encodeURIComponent(winner.key)}` }
  }

  function skip(room) {
    const g = room.game
    const t = now()
    if (!g) { if (room.phase === 'scoreboard') return toLobby(room); return err(409, 'not_open') }
    if (g.paused) return err(409, 'paused')
    if (g.kind === 'quiz') {
      if (g.phase === 'ask') revealQuestion(room, t)
      else nextQuestion(room, t)
    } else if (g.phase === 'vote') closeVote(room, t)
    else return toLobby(room)
    broadcast(room)
    return { ok: true }
  }

  function pause(room) {
    const g = room.game
    if (!g || g.paused || g.phase === 'result') return err(409, 'not_open')
    const t = now()
    const target = g.kind === 'quiz' ? (g.phase === 'ask' ? g.deadline : g.revealDeadline) : g.deadline
    g.paused = { at: t, remaining: Math.max(0, (target || t) - t) }
    broadcast(room)
    return { ok: true }
  }

  function resume(room) {
    const g = room.game
    if (!g || !g.paused) return err(409, 'not_open')
    const shift = now() - g.paused.at
    if (g.kind === 'quiz') { g.qStart += shift; g.deadline += shift; if (g.revealDeadline) g.revealDeadline += shift } else g.deadline += shift
    g.paused = null
    broadcast(room)
    return { ok: true }
  }

  function kick(room, actor, p) {
    const target = room.guests.get(String(p.target || ''))
    if (!target) return err(404, 'not_found')
    room.banned.add(target.addr + '|' + target.name.toLowerCase())
    removeGuest(room, target, 'kicked')
    broadcast(room)
    return { ok: true }
  }

  function makeHost(room, p) {
    const target = room.guests.get(String(p.target || ''))
    if (!target) return err(404, 'not_found')
    room.hostGuestId = target.id
    broadcast(room)
    return { ok: true }
  }

  function setTeams(room, p) {
    const n = Number(p.teams)
    if (![0, 2, 3, 4].includes(n)) return err(400, 'bad_request')
    if (room.phase === 'game') return err(409, 'busy')
    room.teamCount = n
    if (n === 0) for (const g of room.guests.values()) g.team = null
    else guestList(room).forEach((g, i) => { g.team = i % n })
    broadcast(room)
    return { ok: true }
  }

  function setRounds(room, p) {
    const n = Number(p.rounds)
    if (n !== 0 && !games.ROUND_CHOICES.includes(n)) return err(400, 'bad_request')
    room.rounds = n
    broadcast(room)
    return { ok: true }
  }

  /** The host presses "Play it": the TV page navigates to the film (its own player page) with reactions on. */
  function launch(room) {
    if (!room.featured) return err(409, 'nothing_to_play')
    room.launchSeq++
    emitTo(room.tvSinks, 'launch', { href: room.featured.playHref, title: room.featured.title, n: room.launchSeq })
    broadcast(room)
    return { ok: true, href: room.featured.playHref }
  }

  // ---- the clock -------------------------------------------------------------------------------------------
  function allAnswered(room) {
    const g = room.game
    const live = guestList(room).filter(connected)
    if (!live.length) return false
    if (g.kind === 'quiz') return live.every((x) => g.answers.has(x.id))
    return live.every((x) => { const b = g.vote.ballots.get(x.id); return !!(b && b.done) }) // early close needs everyone to press Submit
  }

  /** Called every ~250 ms by the HTTP layer. */
  function sweep() {
    const t = now()
    for (const room of Array.from(rooms.values())) {
      try {
        const anyone = room.tvSinks.size > 0 || room.overlaySinks.size > 0 || guestList(room).some(connected)
        if (anyone) room.lastConnected = t
        if (t - room.createdAt > LIMITS.maxAgeMs) { closeRoom(room, 'too_old'); continue }
        if (!anyone && t - room.lastConnected > LIMITS.emptyMs) { closeRoom(room, 'empty'); continue }
        let changed = room.dirty
        const g = room.game
        if (g && !g.paused) {
          if (g.kind === 'quiz') {
            if (g.phase === 'ask') {
              const q = g.questions[g.index]
              const stage = games.stageAt(q, t - g.qStart)
              if (stage !== g.stage) { g.stage = stage; changed = true }
              if (t >= g.deadline || allAnswered(room)) { revealQuestion(room, t); changed = true }
            } else if (g.phase === 'reveal' && t >= g.revealDeadline) { nextQuestion(room, t); changed = true }
          } else if (g.phase === 'vote') {
            if (t >= g.deadline || allAnswered(room)) { closeVote(room, t); changed = true }
          } else if (g.phase === 'result' && t >= g.resultUntil) { room.game = null; room.phase = 'lobby'; changed = true }
        } else if (room.phase === 'scoreboard' && t >= room.scoreboardUntil) { room.scoreboard = null; room.phase = 'lobby'; changed = true }
        if (changed) broadcast(room) // clients keep their own countdown from `deadline`: nothing is sent just for the clock
      } catch (e) { log(`[movie-night] sweep failed: ${e && e.message}`) }
    }
  }

  function closeAll(reason) { for (const room of Array.from(rooms.values())) closeRoom(room, reason || 'server_stopped') }
  function closeByTicket(ticket) {
    const who = lookup(ticket)
    if (!who || who.role !== 'tv') return err(404, 'not_found')
    closeRoom(who.room, 'ended_by_host')
    return { ok: true }
  }

  return {
    createRoom, claimRoom, preview, join, attach, poll, act, search, sweep, closeAll, closeByTicket,
    /** tests and the join page */
    lookup, findRoom, viewFor, now, LIMITS, COLORS,
    stats: () => ({ rooms: rooms.size, tokens: tokens.size }),
    _rooms: rooms
  }
}

// The manager the desktop app's IPC reaches (mirrors watchTogether.setActive / getActive).
let active = null
const setActive = (x) => { active = x }
const getActive = () => active

module.exports = { createMovieNight, normalizeSettings, normalizeCode, normalizeKey, normalizeTicket, cleanNickname, cleanText, LIMITS, COLORS, DEFAULT_SETTINGS, REACTIONS, setActive, getActive }
