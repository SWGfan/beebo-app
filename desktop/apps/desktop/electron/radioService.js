'use strict'
// Internet radio: a person's favourites and their own station addresses, and live listening
// sessions that relay a station's stream through the household server.
//
// Why relay instead of pointing the player at the station: the server can (1) pull the ICY "now
// playing" text out of the stream, (2) reconnect by itself when the station drops so the player
// just hears a short gap, (3) refuse anything that is not audio, and (4) do all of it through the
// SSRF-guarded client (outboundFetch.js): a station address someone typed cannot reach the
// household's network unless the owner switched that on. Several listeners of the same session
// share ONE upstream connection.
//
// Recording to a file is OFF unless the owner switches it on in the settings; it is per session and
// explicit, capped in size, and only ever saves for the person who started it. Only listen to and
// record what you have the right to.
//
// Personal data (favourites, custom stations, recordings) is per account: radio/state.json
// { users: { [userId]: { favorites, custom, recent, recordings } } }, written atomically
// (safeJson.js), removed with the account (removeUser).

const fs = require('fs')
const fsp = require('fs/promises')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { readJsonSafe, writeJsonAtomic } = require('./safeJson')
const feedLib = require('./podcastFeed')
const icy = require('./icy')
const { createFetcher } = require('./outboundFetch')
const { UUID_RE } = require('./radioBrowser')

const SETTINGS_KEY = 'radioSettings'
const MB = 1024 * 1024
const MAX_FAVORITES = 200
const MAX_CUSTOM = 100
const MAX_RECENT = 20
const MAX_RECORDINGS = 100
const MAX_SESSIONS_TOTAL = 24
const MAX_LISTENER_BUFFER = 4 * MB
const SESSION_ID_RE = /^[a-f0-9]{16}$/
const STATION_ID_RE = /^(rb:[0-9a-f-]{36}|c:[a-f0-9]{12})$/
const REC_ID_RE = /^[a-f0-9]{20}$/

const DEFAULT_SETTINGS = Object.freeze({ allowPrivateNetwork: false, recordingEnabled: false, maxRecordingMb: 512, recordingsCapMb: 2048, maxSessionsPerUser: 3 })

const fail = (status, code) => Object.assign(new Error(code), { status, code })
const own = (o, k) => (o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined)
const clip = (s, n) => String(s == null ? '' : s).replace(/[\x00-\x1f\s]+/g, ' ').trim().slice(0, n)
const clampInt = (v, lo, hi, dflt) => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt
}

function cleanSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  return {
    allowPrivateNetwork: r.allowPrivateNetwork === true,
    recordingEnabled: r.recordingEnabled === true,
    maxRecordingMb: clampInt(r.maxRecordingMb, 10, 4096, DEFAULT_SETTINGS.maxRecordingMb),
    recordingsCapMb: clampInt(r.recordingsCapMb, 0, 1024 * 1024, DEFAULT_SETTINGS.recordingsCapMb),
    maxSessionsPerUser: clampInt(r.maxSessionsPerUser, 1, 10, DEFAULT_SETTINGS.maxSessionsPerUser)
  }
}

const userFolder = (root, userId) => path.join(root, crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 32))
const slug = (s) => String(s || 'radio').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'radio'

function defaultDir(store) {
  return store && store.path ? path.join(path.dirname(store.path), 'radio') : path.join(os.tmpdir(), 'beebo-radio')
}

/** What is kept of a station: only fields this app itself defines, every address re-validated. */
function cleanStation(s) {
  if (!s || typeof s !== 'object' || !STATION_ID_RE.test(String(s.id || ''))) return null
  const url = feedLib.cleanUrl(s.url)
  if (!url) return null
  return {
    id: String(s.id), name: clip(s.name, 120) || 'Unnamed station', url,
    homepage: feedLib.cleanUrl(s.homepage), favicon: feedLib.cleanUrl(s.favicon),
    tags: Array.isArray(s.tags) ? s.tags.map((t) => clip(t, 40)).filter(Boolean).slice(0, 8) : [],
    country: clip(s.country, 80), countryCode: /^[A-Z]{2}$/.test(String(s.countryCode || '')) ? s.countryCode : '',
    language: clip(s.language, 80), codec: clip(s.codec, 20), bitrate: Math.max(0, Math.round(Number(s.bitrate) || 0)),
    source: s.id.startsWith('c:') ? 'custom' : 'radio-browser'
  }
}

/**
 * @param {object} o
 * @param {object} o.store
 * @param {string} [o.dir]
 * @param {object} [o.fetcher]   stream + playlist fetcher (guarded; the owner's LAN setting applies)
 * @param {object} o.browser     radioBrowser instance
 * @param {object} [o.timing]    { backoffMs, maxFailures, idleMs, graceMs, connectMs } (tests shorten these)
 */
function createRadio({ store, dir, fetcher, browser, now = Date.now, log, timing = {} } = {}) {
  const say = typeof log === 'function' ? log : () => {}
  const root = dir || defaultDir(store)
  const stateFile = path.join(root, 'state.json')
  const recRoot = path.join(root, 'recordings')
  const T = { backoffMs: [1000, 2000, 4000, 8000, 15000, 30000], maxFailures: 8, idleMs: 20000, graceMs: 30000, connectMs: 15000, ...timing }
  const settings = () => { let raw; try { raw = store && store.get(SETTINGS_KEY) } catch {} return cleanSettings(raw) }
  const net = fetcher || createFetcher({ allowPrivateNetwork: () => settings().allowPrivateNetwork })

  const loaded = readJsonSafe(stateFile, () => ({}))
  const state = loaded.data && typeof loaded.data === 'object' && !Array.isArray(loaded.data) ? loaded.data : {}
  if (!state.users || typeof state.users !== 'object') state.users = {}
  let saveTimer = null
  function saveNow() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
    try { writeJsonAtomic(stateFile, state, { indent: 0, backupEveryMs: 10 * 60 * 1000 }) } catch (err) { say(`radio: could not save: ${err && err.code || err}`) }
  }
  function saveSoon() { if (!saveTimer) { saveTimer = setTimeout(saveNow, 1500); if (saveTimer.unref) saveTimer.unref() } }
  // Half-written recordings from a crash are not recordings.
  try {
    for (const d of fs.readdirSync(recRoot)) for (const f of fs.readdirSync(path.join(recRoot, d))) if (f.endsWith('.part')) fs.rmSync(path.join(recRoot, d, f), { force: true })
  } catch {}

  function userOf(userId, create) {
    if (!userId) throw fail(401, 'unauthorized')
    let u = own(state.users, userId)
    if (!u && create) { u = { favorites: [], custom: [], recent: [], recordings: [] }; state.users[userId] = u }
    return u || null
  }

  // ----- favourites and custom stations ---------------------------------------------------------
  const favorites = (uid) => { const u = userOf(uid, false); return u ? u.favorites.slice() : [] }
  const customList = (uid) => { const u = userOf(uid, false); return u ? u.custom.slice() : [] }

  async function addFavorite(uid, { id, station } = {}) {
    const u = userOf(uid, true)
    if (!STATION_ID_RE.test(String(id || ''))) throw fail(400, 'bad_station')
    if (u.favorites.some((f) => f.id === id)) return { favorites: u.favorites.slice() }
    if (u.favorites.length >= MAX_FAVORITES) throw fail(409, 'too_many_favorites')
    let snap = null
    if (id.startsWith('c:')) snap = u.custom.find((c) => c.id === id) || null
    else {
      // The directory's own record is preferred; a station snapshot from the app is the fallback when it is unreachable.
      try { snap = await browser.byUuid(id.slice(3)) } catch {}
      if (!snap && station && station.id === id) snap = cleanStation(station)
    }
    if (!snap) throw fail(404, 'station_not_found')
    u.favorites.unshift({ ...snap, addedAt: now() })
    saveNow()
    return { favorites: u.favorites.slice() }
  }
  function removeFavorite(uid, id) {
    const u = userOf(uid, false)
    if (u) { u.favorites = u.favorites.filter((f) => f.id !== id); saveNow() }
    return { favorites: u ? u.favorites.slice() : [] }
  }

  function addCustom(uid, { name, url, homepage } = {}) {
    const clean = feedLib.cleanUrl(url)
    if (!clean) throw fail(400, 'bad_url')
    const label = clip(name, 120) || (() => { try { return new URL(clean).hostname } catch { return 'Custom station' } })()
    const u = userOf(uid, true)
    const dup = u.custom.find((c) => c.url === clean)
    if (dup) return { station: dup, custom: u.custom.slice() }
    if (u.custom.length >= MAX_CUSTOM) throw fail(409, 'too_many_custom')
    const st = cleanStation({ id: 'c:' + crypto.randomBytes(6).toString('hex'), name: label, url: clean, homepage })
    u.custom.unshift(st)
    saveNow()
    return { station: st, custom: u.custom.slice() }
  }
  function updateCustom(uid, id, patch = {}) {
    const u = userOf(uid, false)
    const st = u && u.custom.find((c) => c.id === id)
    if (!st) throw fail(404, 'not_found')
    if (patch.name !== undefined) st.name = clip(patch.name, 120) || st.name
    if (patch.url !== undefined) { const c = feedLib.cleanUrl(patch.url); if (!c) throw fail(400, 'bad_url'); st.url = c }
    for (const f of u.favorites) if (f.id === id) { f.name = st.name; f.url = st.url }
    saveNow()
    return { station: st }
  }
  function removeCustom(uid, id) {
    const u = userOf(uid, false)
    if (!u) return { custom: [] }
    u.custom = u.custom.filter((c) => c.id !== id)
    u.favorites = u.favorites.filter((f) => f.id !== id)
    for (const s of sessions.values()) if (s.userId === uid && s.station.id === id) closeSession(s)
    saveNow()
    return { custom: u.custom.slice() }
  }

  async function stationFor(uid, { stationId, url, name }) {
    const u = userOf(uid, true)
    if (stationId) {
      if (!STATION_ID_RE.test(String(stationId))) throw fail(400, 'bad_station')
      const known = u.custom.find((c) => c.id === stationId) || u.favorites.find((f) => f.id === stationId) || u.recent.find((r) => r.id === stationId)
      if (known) return known
      if (stationId.startsWith('rb:')) {
        let st = null
        try { st = await browser.byUuid(stationId.slice(3)) } catch {}
        if (st) return st
      }
      throw fail(404, 'station_not_found')
    }
    const clean = feedLib.cleanUrl(url)
    if (!clean) throw fail(400, 'bad_url')
    let host = 'Custom station'
    try { host = new URL(clean).hostname } catch {}
    return { id: '', name: clip(name, 120) || host, url: clean, homepage: '', favicon: '', tags: [], country: '', countryCode: '', language: '', codec: '', bitrate: 0, source: 'adhoc' }
  }

  // ----- live sessions --------------------------------------------------------------------------
  const sessions = new Map()

  function sessionShape(s) {
    return {
      id: s.id,
      station: { id: s.station.id, name: s.station.name, favicon: s.station.favicon || '', homepage: s.station.homepage || '', source: s.station.source },
      state: s.state, error: s.lastError || '',
      nowPlaying: s.nowPlaying, history: s.history.slice(-10).reverse(),
      info: { name: s.info.name || '', genre: s.info.genre || '', bitrate: s.info.bitrate || s.station.bitrate || 0, contentType: s.mime || '', hasMetadata: !!s.info.metaint },
      reconnects: s.reconnects, listeners: s.listeners.size, startedAt: s.startedAt,
      recording: s.rec ? { active: true, bytes: s.rec.bytes, startedAt: s.rec.startedAt, id: s.rec.id } : { active: false },
      stream: `/api/radio/session/${s.id}/stream`
    }
  }

  // Connects to the station (following playlists), returns { up, info, kind }.
  async function connect(s) {
    let target = s.station.url
    for (let depth = 0; depth < 3; depth++) {
      const up = await net.open(target, { headers: { 'Icy-MetaData': '1', Accept: 'audio/*, application/ogg;q=0.9, */*;q=0.5', 'Accept-Encoding': 'identity' }, timeoutMs: T.connectMs, lenientHttp: true })
      if (up.status !== 200) { up.close(); throw fail(502, 'http_' + up.status) }
      const info = icy.icyHeaders(up.headers)
      if (icy.isPlaylistType(info.contentType) || (icy.isPlaylistUrl(target) && !/^audio\//.test(info.contentType))) {
        const chunks = []
        let size = 0
        for await (const c of up.stream) { size += c.length; if (size > 64 * 1024) break; chunks.push(c) }
        up.close()
        const pl = icy.parsePlaylist(Buffer.concat(chunks).toString('utf8'))
        if (pl.error) throw fail(422, pl.error)
        target = new URL(pl.url, target).toString()
        continue
      }
      const kind = icy.audioKind(info.contentType)
      if (!kind.ok) { up.close(); throw fail(422, 'not_audio') }
      return { up, info, kind }
    }
    throw fail(422, 'too_many_playlists')
  }

  function onMeta(s, meta) {
    const raw = meta.title || ''
    if (!raw || (s.nowPlaying && s.nowPlaying.raw === raw)) return
    const { artist, title } = icy.splitArtistTitle(raw)
    s.nowPlaying = { raw, artist, title, at: now() }
    s.history.push({ raw, artist, title, at: now() })
    if (s.history.length > 50) s.history.shift()
    if (s.rec) s.rec.titles.push({ raw, at: now() })
  }

  function fanout(s, chunk) {
    for (const res of s.listeners) {
      if (res.writableLength > MAX_LISTENER_BUFFER) { s.listeners.delete(res); try { res.destroy() } catch {}; continue }
      try { res.write(chunk) } catch {}
    }
    if (s.rec) {
      s.rec.bytes += chunk.length
      if (s.rec.bytes > settings().maxRecordingMb * MB) stopRecording(s).catch(() => {})
      else s.rec.stream.write(chunk)
    }
  }

  // Reads one upstream connection until it ends. Resolves with the audio bytes it delivered.
  function pump(s, conn) {
    return new Promise((resolve) => {
      let bytes = 0
      const stripper = icy.createIcyStripper(conn.info.metaint, (m) => onMeta(s, m))
      s.current = conn.up
      const sock = conn.up.stream.socket
      if (sock && sock.setTimeout) sock.setTimeout(T.idleMs, () => { try { conn.up.stream.destroy(new Error('idle')) } catch {} })
      stripper.on('data', (chunk) => { bytes += chunk.length; fanout(s, chunk) })
      stripper.on('error', () => {})
      conn.up.stream.on('error', () => {})
      conn.up.stream.on('close', () => { s.current = null; resolve(bytes) })
      conn.up.stream.pipe(stripper)
    })
  }

  const wanted = (s) => !s.closed && (s.listeners.size > 0 || !!s.rec || now() < s.graceUntil)

  function sleep(s, ms) {
    return new Promise((resolve) => { s.wake = resolve; s.sleepTimer = setTimeout(resolve, ms); if (s.sleepTimer.unref) s.sleepTimer.unref() })
  }

  async function run(s) {
    if (s.running) return
    s.running = true
    let failures = 0
    try {
      while (wanted(s)) {
        try {
          s.state = failures ? 'reconnecting' : 'connecting'
          const conn = await connect(s)
          if (!wanted(s)) { conn.up.close(); break }
          s.info = conn.info
          s.mime = conn.kind.mime
          s.ext = conn.kind.ext
          s.state = 'live'
          s.lastError = ''
          if (!s.everLive) { s.everLive = true; s.resolveReady() }
          const bytes = await pump(s, conn)
          if (bytes > 0) { failures = 0; s.reconnects++ } else failures++
        } catch (err) {
          failures++
          s.lastError = err && err.code ? String(err.code) : 'error'
          say(`radio: connection to "${s.station.name}" failed (${s.lastError})`)
          if (!s.everLive) { s.state = 'failed'; s.rejectReady(err); return }
        }
        if (!wanted(s)) break
        if (failures > T.maxFailures) { s.state = 'failed'; s.lastError = s.lastError || 'gave_up'; for (const r of s.listeners) { try { r.end() } catch {} } s.listeners.clear(); if (s.rec) await stopRecording(s).catch(() => {}); return }
        s.state = 'reconnecting'
        await sleep(s, T.backoffMs[Math.min(failures - 1, T.backoffMs.length - 1)])
      }
      if (!s.closed) s.state = 'idle'
    } finally {
      s.running = false
    }
  }

  function closeSession(s) {
    if (s.closed) return
    s.closed = true
    s.state = 'closed'
    if (s.rec) stopRecording(s).catch(() => {})
    for (const r of s.listeners) { try { r.end() } catch {} }
    s.listeners.clear()
    if (s.current) { try { s.current.close() } catch {} }
    if (s.wake) s.wake()
    clearTimeout(s.sleepTimer)
    if (!s.everLive) { try { s.rejectReady(fail(499, 'closed')) } catch {} }
    sessions.delete(s.id)
  }

  /** Close sessions nobody listens to any more (after a short grace period), and recordings' sessions stay while recording. */
  function reap() {
    const t = now()
    for (const s of [...sessions.values()]) {
      if (s.listeners.size === 0 && !s.rec && t >= s.graceUntil) closeSession(s)
      else if (t - s.startedAt > 12 * 3600000 && s.listeners.size === 0) closeSession(s)
    }
  }
  const reaper = setInterval(reap, 5000)
  if (reaper.unref) reaper.unref()

  async function startSession(uid, { stationId, url, name } = {}) {
    const station = await stationFor(uid, { stationId, url, name })
    const mine = [...sessions.values()].filter((s) => s.userId === uid)
    for (const old of mine.slice(0, Math.max(0, mine.length - settings().maxSessionsPerUser + 1))) closeSession(old)
    if (sessions.size >= MAX_SESSIONS_TOTAL) throw fail(503, 'too_many_streams')
    const s = {
      id: crypto.randomBytes(8).toString('hex'), userId: uid, station, state: 'connecting', lastError: '', startedAt: now(), graceUntil: now() + T.graceMs,
      listeners: new Set(), info: {}, mime: 'audio/mpeg', ext: 'mp3', nowPlaying: null, history: [], reconnects: 0, rec: null, closed: false, running: false, everLive: false, current: null
    }
    s.ready = new Promise((resolve, reject) => { s.resolveReady = resolve; s.rejectReady = reject })
    s.ready.catch(() => {})
    sessions.set(s.id, s)
    run(s).catch((err) => say(`radio: session ended unexpectedly: ${err && err.message}`))
    try {
      await Promise.race([s.ready, new Promise((_, rej) => { const t = setTimeout(() => rej(fail(504, 'connect_timeout')), T.connectMs + 2000); if (t.unref) t.unref() })])
    } catch (err) {
      closeSession(s)
      if (err && err.status) throw err
      const code = (err && err.code) || 'stream_failed'
      throw fail(code === 'bad_url' || code === 'blocked_address' || code === 'blocked_private' ? 400 : 502, code)
    }
    // Recently played, per person (newest first, no repeats).
    if (station.id) {
      const u = userOf(uid, true)
      u.recent = [{ ...station }, ...u.recent.filter((r) => r.id !== station.id)].slice(0, MAX_RECENT)
      saveSoon()
      if (station.id.startsWith('rb:') && UUID_RE.test(station.id.slice(3))) browser.click(station.id.slice(3)).catch(() => {})
    }
    return sessionShape(s)
  }

  function mySession(uid, id) {
    const s = SESSION_ID_RE.test(String(id)) ? sessions.get(id) : null
    if (!s || s.userId !== uid) throw fail(404, 'not_found')
    return s
  }
  const getSession = (uid, id) => sessionShape(mySession(uid, id))
  const listSessions = (uid) => [...sessions.values()].filter((s) => s.userId === uid).map(sessionShape)
  function stopSession(uid, id) { closeSession(mySession(uid, id)); return { ok: true } }

  /**
   * The audio for a session (the HTTP layer authenticated the caller: `uid` is the bearer's account, or null
   * when a media token for this session id was presented, which by itself is the capability).
   */
  function attach(uid, id, req, res) {
    const s = SESSION_ID_RE.test(String(id)) ? sessions.get(id) : null
    if (!s || (uid && s.userId !== uid)) throw fail(404, 'not_found')
    if (s.state === 'failed' || s.closed) throw fail(502, s.lastError || 'stream_failed')
    res.writeHead(200, { 'Content-Type': s.mime, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Connection: 'keep-alive', 'icy-name': encodeURIComponent(s.station.name).slice(0, 100) })
    if (req.method === 'HEAD') { res.end(); return }
    s.listeners.add(res)
    s.graceUntil = 0
    res.on('close', () => {
      s.listeners.delete(res)
      if (!s.listeners.size) s.graceUntil = now() + T.graceMs
    })
    run(s).catch(() => {})
  }

  // ----- recording (off unless the owner allows it) ----------------------------------------------
  const recRows = (uid) => { const u = userOf(uid, false); return u ? u.recordings : [] }
  const recPath = (uid, row) => path.join(userFolder(recRoot, uid), `${row.id}.${row.ext}`)
  const recShape = (r) => ({ id: r.id, station: r.station, startedAt: r.startedAt, endedAt: r.endedAt, bytes: r.bytes, mime: r.mime, titles: (r.titles || []).slice(0, 200) })
  function recordingsBytes() {
    let n = 0
    for (const u of Object.values(state.users)) for (const r of u.recordings || []) n += r.bytes || 0
    return n
  }

  async function startRecording(uid, id) {
    const cfg = settings()
    if (!cfg.recordingEnabled) throw fail(403, 'recording_disabled')
    const s = mySession(uid, id)
    if (s.state !== 'live') throw fail(409, 'not_live')
    if (s.rec) return recShape({ ...s.rec, endedAt: 0, station: s.station.name })
    const u = userOf(uid, true)
    if (u.recordings.length >= MAX_RECORDINGS) throw fail(409, 'too_many_recordings')
    if (cfg.recordingsCapMb <= 0 || recordingsBytes() >= cfg.recordingsCapMb * MB) throw fail(507, 'recording_space_full')
    const recId = crypto.randomBytes(10).toString('hex')
    const folder = userFolder(recRoot, uid)
    await fsp.mkdir(folder, { recursive: true })
    const file = path.join(folder, `${recId}.${s.ext}.part`)
    const stream = fs.createWriteStream(file, { flags: 'wx' })
    stream.on('error', () => { if (s.rec && s.rec.stream === stream) s.rec = null })
    s.rec = { id: recId, stream, file, bytes: 0, startedAt: now(), titles: [], uid }
    return { id: recId, station: s.station.name, startedAt: s.rec.startedAt, endedAt: 0, bytes: 0, mime: s.mime, titles: [] }
  }

  async function stopRecording(s) {
    const rec = s.rec
    if (!rec) return null
    s.rec = null
    await new Promise((resolve) => { rec.stream.end(resolve); rec.stream.on('error', resolve) })
    if (rec.bytes === 0) { await fsp.rm(rec.file, { force: true }).catch(() => {}); return null }
    const final = rec.file.slice(0, -'.part'.length)
    await fsp.rename(rec.file, final)
    const u = userOf(rec.uid, true)
    const row = { id: rec.id, station: s.station.name, ext: s.ext, mime: s.mime, startedAt: rec.startedAt, endedAt: now(), bytes: rec.bytes, titles: rec.titles.slice(0, 200) }
    u.recordings.unshift(row)
    saveNow()
    return recShape(row)
  }

  async function stopRecordingFor(uid, id) {
    const s = mySession(uid, id)
    if (!s.rec) throw fail(409, 'not_recording')
    const row = await stopRecording(s)
    return row || { ok: true }
  }

  const listRecordings = (uid) => recRows(uid).filter((r) => fs.existsSync(recPath(uid, r))).map(recShape)
  function findRecording(uid, id) {
    if (!uid || !REC_ID_RE.test(String(id))) return null
    const row = recRows(uid).find((r) => r.id === id)
    return row ? { path: recPath(uid, row), mime: row.mime, recording: recShape(row), filename: `${slug(row.station)}-${new Date(row.startedAt).toISOString().slice(0, 10)}.${row.ext}` } : null
  }
  async function removeRecording(uid, id) {
    const hit = findRecording(uid, id)
    if (!hit) throw fail(404, 'not_found')
    const u = userOf(uid, false)
    u.recordings = u.recordings.filter((r) => r.id !== id)
    await fsp.rm(hit.path, { force: true }).catch(() => {})
    saveNow()
    return { ok: true }
  }

  // ----- misc ------------------------------------------------------------------------------------
  async function removeUser(uid) {
    for (const s of [...sessions.values()]) if (s.userId === uid) closeSession(s)
    if (own(state.users, uid)) { delete state.users[uid]; saveNow() }
    await fsp.rm(userFolder(recRoot, uid), { recursive: true, force: true }).catch(() => {})
  }
  async function close() {
    clearInterval(reaper)
    for (const s of [...sessions.values()]) closeSession(s)
    await new Promise((r) => setImmediate(r))
    saveNow()
  }
  const setSettings = (patch) => { const next = cleanSettings({ ...settings(), ...(patch && typeof patch === 'object' ? patch : {}) }); store.set(SETTINGS_KEY, next); return next }
  const status = () => ({ settings: settings(), sessions: sessions.size, recordings: { bytes: recordingsBytes(), capBytes: settings().recordingsCapMb * MB } })

  return {
    favorites, addFavorite, removeFavorite, customList, addCustom, updateCustom, removeCustom,
    recent: (uid) => { const u = userOf(uid, false); return u ? u.recent.slice() : [] },
    startSession, getSession, listSessions, stopSession, attach,
    startRecording, stopRecording: stopRecordingFor, listRecordings, findRecording, removeRecording,
    getSettings: settings, setSettings, status, removeUser, close, reap, saveNow, root,
    browse: (q) => browser.search(q), lists: (kind, o) => browser.list(kind, o),
    _sessions: sessions, _state: state
  }
}

module.exports = { createRadio, cleanSettings, cleanStation, DEFAULT_SETTINGS, SESSION_ID_RE, STATION_ID_RE }
