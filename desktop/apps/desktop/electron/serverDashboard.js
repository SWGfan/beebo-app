'use strict'
// ============================================================================
// serverDashboard.js — the owner's server dashboard (Now playing, Activity,
// Library, Server health, Bandwidth).
// ----------------------------------------------------------------------------
// Everything here is read from THIS computer: the watch history in the app
// store, the video bytes this server is sending right now, the library folders
// and the disks they live on. Nothing is sent anywhere.
//
// Two halves:
//   * pure helpers (exported for tests): activity aggregation, watch time,
//     connection/device classification, the owner rule for "stop this
//     stream", disk figures;
//   * createServerDashboard(): the live part. streamServer.js hands every
//     video response to trackStream(), every watch-session/progress request to
//     noteSession(), and log lines to noteLog(); the admin API and the desktop
//     app read snapshot().
//
// Cost: the "now", "bandwidth" and "health" sections are in-memory arithmetic
// and are meant to be polled every few seconds while the dashboard is open.
// "library" walks the (cached) library and statfs()es each folder, so it is
// cached for LIBRARY_TTL_MS. "activity" reads at most the 300 history rows the
// store keeps.
//
// Seams for work happening elsewhere:
//   * setTranscodeProvider(fn): live transcoding (the player/transcoder work)
//     can report which streams it is converting on the fly; until then every
//     tracked stream is a direct play of the file on disk.
//   * setHooks({ getAwayStatus, getUpdateStatus, getProcessMetrics,
//     getAppVersion, getExtraLibraries }): main.js fills in what only the
//     Electron side knows. All optional; each missing one reads as "unknown".
// ============================================================================

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const viewingPrivacy = require('./viewingPrivacy')

const DAY_MS = 24 * 60 * 60 * 1000
// A stream with no bytes sent for this long (and no open response) is over.
const STREAM_IDLE_MS = 30 * 1000
// A watch session reported within this window counts as "playing now".
const SESSION_LIVE_MS = 75 * 1000
// "Stop this stream" also refuses that viewer's next requests for this file
// for a while, or the player would simply ask again.
const STOP_BLOCK_MS = 3 * 60 * 1000
const LIBRARY_TTL_MS = 60 * 1000
const RATE_WINDOW_MS = 5 * 1000
const MAX_LOG_LINES = 400
// Watch time of one session is capped, so a player left open overnight on a
// pause screen can't claim a whole day.
const MAX_SESSION_SECONDS = 6 * 60 * 60
// A session shorter than this is a click-in, click-out, not a play.
const MIN_PLAY_SECONDS = 60

// --------------------------------------------------------------------------
// pure helpers
// --------------------------------------------------------------------------

const num = (v) => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) && n >= 0 ? n : 0
}
const str = (v) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v))

/**
 * Seconds actually watched in one history row. The smaller of: how long the
 * session was open (last report minus start), where the player got to (a row
 * resumed at 1h and watched for 5 min reports currentTime 65 min but was open
 * 5 min), and the length of the film. currentTime 0 (nothing reported) falls
 * back to the open time alone.
 */
function watchSecondsOf(e) {
  if (!e || typeof e !== 'object') return 0
  const span = Math.max(0, (num(e.lastUpdate) - num(e.startedAt)) / 1000)
  let s = span
  const pos = num(e.currentTime)
  if (pos > 0) s = Math.min(s, pos)
  const d = num(e.duration)
  if (d > 0) s = Math.min(s, d)
  return Math.min(Math.floor(s), MAX_SESSION_SECONDS)
}

// The local calendar day of a timestamp, "YYYY-MM-DD". The owner thinks in
// their own days, not UTC ones.
function localDayKey(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// The title a row should be counted under: an episode counts toward its show.
function groupTitleOf(e) {
  const t = str(e && e.title)
  if (str(e && e.kind) === 'tv' || /\s[—-]\s*S\d+E\d+/i.test(t)) {
    const cut = t.split(/\s[—-]\s*S\d+E\d+/i)[0]
    return (cut || t).trim()
  }
  return t.trim()
}

/**
 * Plays per day and week, top titles, top members and watch time per member
 * over the last `days` days, from watch history rows.
 * users: [{ id, name }] so a renamed member shows their current name.
 */
function aggregateActivity(entries, { now = Date.now(), days = 7, users = [], top = 10, privateUserIds = new Set() } = {}) {
  const span = Math.max(1, Math.min(90, Math.floor(num(days)) || 7))
  const rows = Array.isArray(entries) ? entries.filter((e) => e && typeof e === 'object') : []
  // Day buckets, oldest first, ending today.
  const byDay = new Map()
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const startMs = today.getTime() - (span - 1) * DAY_MS
  for (let i = 0; i < span; i++) {
    const d = new Date(startMs)
    d.setDate(d.getDate() + i)
    byDay.set(localDayKey(d.getTime()), { day: localDayKey(d.getTime()), plays: 0, seconds: 0 })
  }
  const nameOf = new Map((Array.isArray(users) ? users : []).filter(Boolean).map((u) => [u.id, u.name || u.username || '']))
  const titles = new Map()
  const members = new Map()
  let plays = 0
  let seconds = 0
  let oldest = null
  for (const e of rows) {
    const at = num(e.startedAt) || num(e.lastUpdate)
    if (!at) continue
    if (oldest === null || at < oldest) oldest = at
    if (at < startMs || at > now + DAY_MS) continue
    const secs = watchSecondsOf(e)
    if (secs < MIN_PLAY_SECONDS) continue
    plays += 1
    seconds += secs
    const bucket = byDay.get(localDayKey(at))
    if (bucket) { bucket.plays += 1; bucket.seconds += secs }
    // Private sessions count toward capacity totals without naming their content.
    if (!privateUserIds.has(str(e.userId))) {
      const title = groupTitleOf(e) || str(e.fileName) || 'Unknown'
      const t = titles.get(title) || { title, kind: str(e.kind) === 'tv' ? 'tv' : 'movie', plays: 0, seconds: 0 }
      t.plays += 1
      t.seconds += secs
      titles.set(title, t)
    }
    const uid = str(e.userId) || 'unknown'
    const m = members.get(uid) || { userId: uid, name: nameOf.get(uid) || str(e.userName) || 'Unknown', plays: 0, seconds: 0 }
    m.plays += 1
    m.seconds += secs
    members.set(uid, m)
  }
  const daily = Array.from(byDay.values())
  // Weeks: consecutive 7-day blocks ending today, oldest first.
  const weekly = []
  for (let end = daily.length; end > 0; end -= 7) {
    const chunk = daily.slice(Math.max(0, end - 7), end)
    weekly.unshift({ from: chunk[0].day, to: chunk[chunk.length - 1].day, plays: chunk.reduce((n, d) => n + d.plays, 0), seconds: chunk.reduce((n, d) => n + d.seconds, 0) })
  }
  const bySize = (a, b) => b.plays - a.plays || b.seconds - a.seconds || String(a.title || a.name).localeCompare(String(b.title || b.name))
  const memberList = Array.from(members.values()).sort((a, b) => b.seconds - a.seconds || b.plays - a.plays || a.name.localeCompare(b.name))
  return {
    days: span,
    totals: { plays, seconds },
    daily,
    weekly,
    topTitles: Array.from(titles.values()).sort(bySize).slice(0, top),
    topUsers: memberList.slice(0, top),
    watchTimeByMember: memberList,
    // History keeps the newest 300 sessions; when the oldest kept row is newer
    // than the start of the window, the window is only partly covered.
    coverageFrom: oldest,
    partial: oldest !== null && oldest > startMs && rows.length >= 300
  }
}

function isPrivateIp(ip) {
  const a = str(ip).replace(/^::ffff:/, '')
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(a) ||
    /^(fc|fd)[0-9a-f]{2}:/i.test(a) || /^fe80:/i.test(a)
}
function isLoopbackIp(ip) {
  const a = str(ip).replace(/^::ffff:/, '')
  return a === '::1' || /^127\./.test(a)
}

/**
 * Where a viewer is watching from.
 *   home          on this house's network (or this very PC)
 *   away_direct   away from home, straight to this PC (home address) or over
 *                 a direct peer-to-peer link from name.beebo.tv
 *   away_relay    away from home, through Beebo Relay or another relay
 *   cast          a Chromecast / TV receiver fetching the file itself
 */
// Does this full path end in that library-relative name (a movie file name, or a show's relPath)?
function fileNameMatches(filePath, name) {
  const f = str(name)
  const p = str(filePath)
  if (!f || !p) return false
  return p === f || p.endsWith(path.sep + f) || p.endsWith('/' + f)
}

function classifyConnection({ socketIp, fromAgent = false, remotePath = '', userAgent = '' } = {}) {
  const ua = str(userAgent)
  let where
  let provider = ''
  if (fromAgent) {
    const p = str(remotePath).toLowerCase()
    if (p.startsWith('relay')) {
      where = 'away_relay'
      provider = p === 'relay-beebo' ? 'beebo' : p.slice(6) || ''
    } else {
      where = 'away_direct'
    }
  } else if (isLoopbackIp(socketIp) || isPrivateIp(socketIp)) {
    where = 'home'
  } else {
    where = 'away_direct'
  }
  if (/CrKey|Chromecast|Google Cast/i.test(ua)) return { where: 'cast', via: where, provider }
  return { where, via: where, provider }
}

const WHERE_LABELS = {
  home: 'At home',
  away_direct: 'Away from home (direct)',
  away_relay: 'Away from home (through Beebo Relay)',
  cast: 'Casting to a TV'
}

/** A short device name from a User-Agent. */
function deviceFromUserAgent(userAgent) {
  const ua = str(userAgent)
  if (!ua) return 'Unknown device'
  if (/CrKey|Chromecast/i.test(ua)) return 'Chromecast'
  if (/BeeboAuto|Android Auto/i.test(ua)) return 'Android Auto'
  if (/AFT[A-Z0-9]|BRAVIA|GoogleTV|Android TV|\bTV\b.*Android|SMART-TV|SmartTV|Tizen|webOS/i.test(ua)) return 'TV'
  if (/Beebo|ExoPlayer|okhttp/i.test(ua) && /Android/i.test(ua)) return 'Beebo app (Android)'
  if (/okhttp|ExoPlayer/i.test(ua)) return 'Beebo app'
  if (/iPhone|iPad|iPod/i.test(ua)) return /iPad/i.test(ua) ? 'iPad' : 'iPhone'
  if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? 'Android phone (browser)' : 'Android tablet (browser)'
  if (/Electron/i.test(ua)) return 'Beebo on this PC'
  if (/Windows/i.test(ua)) return 'Windows PC (browser)'
  if (/Macintosh|Mac OS X/i.test(ua)) return 'Mac (browser)'
  if (/Linux/i.test(ua)) return 'Linux PC (browser)'
  return 'Browser'
}

/**
 * The owner: the longest-standing approved admin. Only they may stop another
 * member's stream. Another admin sees the dashboard but not the button.
 */
function ownerIdOf(users) {
  const admins = (Array.isArray(users) ? users : []).filter((u) => u && u.isAdmin && (u.status || 'approved') === 'approved')
  if (!admins.length) return null
  admins.sort((a, b) => (num(a.createdAt) || Infinity) - (num(b.createdAt) || Infinity) || str(a.id).localeCompare(str(b.id)))
  return admins[0].id || null
}
function canStopStreams(user, users) {
  if (!user || !user.isAdmin || (user.status && user.status !== 'approved')) return false
  const owner = ownerIdOf(users)
  return !!owner && owner === user.id
}

/** Free and total bytes of the disk holding `dir`, or null. statfs is injectable for tests. */
function diskOf(dir, statfs = fs.statfsSync) {
  if (!dir || typeof statfs !== 'function') return null
  try {
    const s = statfs(dir)
    const bsize = num(s.bsize) || num(s.frsize)
    const total = num(s.blocks) * bsize
    const free = num(s.bavail) * bsize
    if (!total) return null
    return { totalBytes: total, freeBytes: free, usedBytes: Math.max(0, total - free) }
  } catch {
    return null
  }
}

/**
 * Storage per library folder plus the free space on each distinct disk.
 * folders: [{ kind, dir }], files: [{ dir, size }] from the library walk.
 */
function storageStats(folders, files, { statfs = fs.statfsSync } = {}) {
  const sizeByDir = new Map()
  const countByDir = new Map()
  for (const f of Array.isArray(files) ? files : []) {
    if (!f || !f.dir) continue
    const k = path.resolve(f.dir)
    sizeByDir.set(k, (sizeByDir.get(k) || 0) + num(f.size))
    countByDir.set(k, (countByDir.get(k) || 0) + 1)
  }
  const disks = new Map()
  const out = []
  const seen = new Set()
  for (const folder of Array.isArray(folders) ? folders : []) {
    if (!folder || !folder.dir) continue
    const k = path.resolve(folder.dir)
    if (seen.has(folder.kind + '|' + k)) continue
    seen.add(folder.kind + '|' + k)
    const disk = diskOf(k, statfs)
    const root = /^[a-z]:/i.test(k) ? k.slice(0, 2).toUpperCase() + '\\' : path.parse(k).root || k
    if (disk && !disks.has(root)) disks.set(root, { disk: root, ...disk })
    out.push({ kind: folder.kind, dir: folder.dir, usedBytes: sizeByDir.get(k) || 0, files: countByDir.get(k) || 0, disk: root, freeBytes: disk ? disk.freeBytes : null, totalBytes: disk ? disk.totalBytes : null })
  }
  return { folders: out, disks: Array.from(disks.values()) }
}

/** Bytes per second over the recent window, from [atMs, bytes] samples. */
function rateFrom(samples, now, windowMs = RATE_WINDOW_MS) {
  let total = 0
  let first = null
  for (const [at, b] of samples) {
    if (at < now - windowMs) continue
    total += b
    if (first === null || at < first) first = at
  }
  if (!total) return 0
  // A stream that just started has a shorter real window; never divide by less than 1 s.
  const span = Math.max(1000, Math.min(windowMs, now - (first === null ? now : first)))
  return Math.round((total * 1000) / span)
}

// --------------------------------------------------------------------------
// the live dashboard
// --------------------------------------------------------------------------

function createServerDashboard({
  store,
  history,
  auth,
  viewerIdentity,
  getAgentSecret = () => '',
  scanLibrary = async () => ({ movies: [], tvFiles: [] }),
  libraryFolders = () => [],
  convertList = () => [],
  introScanStatus = () => null,
  inboxStatus = () => null,
  missingPosters = () => null,
  recentlyAdded = () => [],
  tlsStatus = () => null,
  now = () => Date.now(),
  statfs = fs.statfsSync,
  cpuUsage = () => process.cpuUsage(),
  memoryUsage = () => process.memoryUsage(),
  uptime = () => process.uptime()
} = {}) {
  store = store || { get: () => undefined }
  let hooks = {}
  let transcodeProvider = null
  // streamId -> stream record
  const streams = new Map()
  const streamIdsByKey = new Map()
  // sessionId -> { ip, ua, fromAgent, remotePath, at }
  const sessionClients = new Map()
  // [{ key, until }]
  const blocks = []
  const logLines = []
  let peakToday = { day: localDayKey(now()), bytesPerSec: 0, at: null }
  let bytesToday = { day: localDayKey(now()), bytes: 0 }
  // Since this run started, never reset: the counter /metrics offers (a rate() over it is bandwidth).
  let bytesTotal = 0
  let lastCpu = { at: now(), usage: cpuUsage() }
  let libraryCache = null

  const safe = (fn, fallback) => {
    try {
      const v = fn()
      return v === undefined ? fallback : v
    } catch {
      return fallback
    }
  }

  function clientOf(req) {
    const secret = safe(getAgentSecret, '')
    const socketIp = safe(() => str(req.socket.remoteAddress).replace(/^::ffff:/, ''), '')
    const fromAgent = !!(viewerIdentity && secret && safe(() => viewerIdentity.fromHostAgent(req, secret), false))
    const ip = fromAgent ? safe(() => viewerIdentity.clientIp(req, secret), socketIp) : socketIp
    const ua = safe(() => str(req.headers['user-agent']).slice(0, 300), '')
    // The host agent's word on how this viewer is connected; believed only from the agent.
    const remotePath = fromAgent ? safe(() => str(req.headers['x-beebo-remote-path']).slice(0, 32), '') : ''
    const member = fromAgent && viewerIdentity && typeof viewerIdentity.remoteViewer === 'function'
      ? safe(() => viewerIdentity.remoteViewer(req, secret), null)
      : null
    // Only server-authenticated identity is accepted; never a client header.
    const userId = str(req.beeboUserId)
    return { ip: ip || '', socketIp, ua, fromAgent, remotePath, member, userId }
  }

  const streamKeyFor = (client, filePath) =>
    crypto.createHash('sha256').update(`${client.userId}|${client.ip}|${client.ua}|${path.resolve(filePath)}`).digest('base64url').slice(0, 16)

  function pruneBlocks(t) {
    for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i].until <= t) blocks.splice(i, 1)
  }

  function rollDay(t) {
    const day = localDayKey(t)
    if (peakToday.day !== day) peakToday = { day, bytesPerSec: 0, at: null }
    if (bytesToday.day !== day) bytesToday = { day, bytes: 0 }
  }

  /**
   * Called by the video routes before any byte is written. Returns false when
   * the owner stopped this viewer's stream of this file a moment ago: the
   * route must answer 403 and send nothing.
   */
  function trackStream(req, res, { filePath, kind, fileName, relPath, sizeBytes } = {}) {
    if (!req || !res || !filePath) return true
    const t = now()
    const client = clientOf(req)
    const key = streamKeyFor(client, filePath)
    pruneBlocks(t)
    if (blocks.some((b) => b.key === key)) return false
    let s = streams.get(streamIdsByKey.get(key))
    if (!s) {
      let size = num(sizeBytes)
      if (!size) {
        try { size = fs.statSync(filePath).size } catch { size = 0 }
      }
      s = {
        id: crypto.randomUUID(),
        key,
        filePath: path.resolve(filePath),
        kind: kind === 'tv' ? 'tv' : 'movie',
        fileName: str(fileName) || path.basename(filePath),
        relPath: str(relPath),
        sizeBytes: size,
        client,
        startedAt: t,
        lastByteAt: t,
        bytes: 0,
        samples: [],
        open: new Set()
      }
      streams.set(s.id, s)
      streamIdsByKey.set(key, s.id)
    } else {
      s.client = client
    }
    s.open.add(res)
    const onClose = () => { s.open.delete(res) }
    res.once('close', onClose)
    // Count what really leaves: wrap write/end on this one response.
    const origWrite = res.write
    const origEnd = res.end
    const count = (chunk) => {
      const n = chunk && typeof chunk.length === 'number' ? chunk.length : 0
      if (!n) return
      const at = now()
      s.bytes += n
      s.lastByteAt = at
      s.samples.push([at, n])
      if (s.samples.length > 4096) s.samples.splice(0, s.samples.length - 2048)
      rollDay(at)
      bytesToday.bytes += n
      bytesTotal += n
    }
    res.write = function (chunk, ...rest) {
      try { count(chunk) } catch {}
      return origWrite.call(this, chunk, ...rest)
    }
    res.end = function (chunk, ...rest) {
      try { if (chunk && typeof chunk !== 'function') count(chunk) } catch {}
      return origEnd.call(this, chunk, ...rest)
    }
    return true
  }

  /** From /api/watch-session, /api/progress and /progress: who is on which session. */
  function noteSession(req, sessionId) {
    if (!req || !sessionId) return
    const c = clientOf(req)
    sessionClients.set(String(sessionId), { ip: c.ip, ua: c.ua, fromAgent: c.fromAgent, remotePath: c.remotePath, userId: c.userId, at: now() })
    if (sessionClients.size > 500) {
      const cutoff = now() - 6 * 60 * 60 * 1000
      for (const [k, v] of sessionClients) if (v.at < cutoff) sessionClients.delete(k)
    }
  }

  /** Every server log line passes through here; problems are kept for "errors in the last 24 h". */
  function noteLog(msg) {
    const text = str(msg)
    if (!/\b(error|failed|fail|could not|couldn't|cannot|crash|exception|refused|timed out|EADDRINUSE|ENOSPC|EACCES|EPERM)\b/i.test(text)) return
    logLines.push({ at: now(), message: text.slice(0, 300) })
    if (logLines.length > MAX_LOG_LINES) logLines.splice(0, logLines.length - MAX_LOG_LINES)
  }

  function sweepStreams(t) {
    for (const [id, s] of streams) {
      s.samples = s.samples.filter(([at]) => at >= t - 60 * 1000)
      if (!s.open.size && t - s.lastByteAt > STREAM_IDLE_MS) { streams.delete(id); streamIdsByKey.delete(s.key) }
    }
  }

  function liveSessions(t) {
    let rows = []
    try { rows = (history && history.getHistory ? history.getHistory(store) : []) || [] } catch { rows = [] }
    let pending = []
    try { pending = (history && history.getPendingSessions ? history.getPendingSessions(store) : []) || [] } catch { pending = [] }
    return rows.concat(pending).filter((e) => e && t - num(e.lastUpdate) <= SESSION_LIVE_MS)
  }

  function transcodes() {
    if (typeof transcodeProvider !== 'function') return []
    const list = safe(transcodeProvider, [])
    return Array.isArray(list) ? list : []
  }

  function usersList() {
    try { return (auth && auth.getUsers ? auth.getUsers(store) : []) || [] } catch { return [] }
  }

  /** Who is watching what, right now. */
  function nowPlaying() {
    const t = now()
    sweepStreams(t)
    const sessions = liveSessions(t)
    const privateIds = viewingPrivacy.privateUserIds(store)
    const users = usersList()
    const nameOf = new Map(users.map((u) => [u.id, u.name || u.username || '']))
    const tx = transcodes()
    const used = new Set()
    const out = []
    const matchesFile = (s, e) => {
      const f = str(e.fileName)
      if (!f) return false
      return s.fileName === f || s.relPath === f || s.filePath.endsWith(path.sep + f) || s.filePath.endsWith('/' + f)
    }
    // Newest report first, so two members on the same file each take their own stream.
    sessions.sort((a, b) => num(b.lastUpdate) - num(a.lastUpdate))
    for (const e of sessions) {
      const known = sessionClients.get(str(e.sessionId)) || null
      let stream = null
      for (const s of streams.values()) {
        if (used.has(s.id) || !matchesFile(s, e)) continue
        if (s.client.userId && s.client.userId !== str(e.userId)) continue
        if (known && known.ip && s.client.ip !== known.ip && !/CrKey|Chromecast/i.test(s.client.ua)) continue
        stream = s
        break
      }
      if (!stream) {
        for (const s of streams.values()) {
          if (!used.has(s.id) && matchesFile(s, e) && (!s.client.userId || s.client.userId === str(e.userId))) { stream = s; break }
        }
      }
      if (stream) used.add(stream.id)
      out.push(rowFor({ session: e, stream, known, nameOf, tx, t, privateIds }))
    }
    // Streams nobody reported a session for (a cast receiver, a browser with the
    // progress beacon blocked, an old app): still shown, as an unknown viewer.
    for (const s of streams.values()) {
      if (used.has(s.id)) continue
      if (t - s.lastByteAt > STREAM_IDLE_MS && !s.open.size) continue
      out.push(rowFor({ session: null, stream: s, known: null, nameOf, tx, t, privateIds }))
    }
    return out
  }

  function rowFor({ session, stream, known, nameOf, tx, t, privateIds }) {
    const client = stream ? stream.client : known ? { ip: known.ip, ua: known.ua, fromAgent: known.fromAgent, remotePath: known.remotePath } : { ip: '', ua: '', fromAgent: false, remotePath: '' }
    const conn = classifyConnection({ socketIp: client.fromAgent ? '127.0.0.1' : client.ip, fromAgent: client.fromAgent, remotePath: client.remotePath, userAgent: client.ua })
    const duration = session ? num(session.duration) : 0
    const position = session ? num(session.currentTime) : 0
    const rate = stream ? rateFrom(stream.samples, t) : 0
    const member = client.member && client.member.member ? client.member.member : ''
    const userId = stream && stream.client.userId ? stream.client.userId : session ? str(session.userId) : str(known && known.userId)
    // A live conversion matches by stream, by session, by file, or (its HLS pieces never touch the
    // raw file's stream) by who is converting which file.
    const txInfo = tx.find((x) => x && ((stream && x.streamId === stream.id) || (session && x.sessionId === session.sessionId) || (stream && x.filePath && path.resolve(x.filePath) === stream.filePath) || (session && userId && x.owner && str(x.owner) === userId && fileNameMatches(x.filePath, session.fileName)))) || null
    const hidden = privateIds.has(userId) || (!!stream && !stream.client.userId && privateIds.size > 0)
    const result = {
      id: stream ? stream.id : 'session:' + str(session && session.sessionId),
      streamId: stream ? stream.id : null,
      sessionId: session ? str(session.sessionId) : null,
      userId: userId || null,
      user: nameOf.get(userId) || (session ? str(session.userName) : member) || 'Unknown viewer',
      title: session ? str(session.title) : (stream ? stream.fileName : ''),
      kind: session ? (str(session.kind) === 'tv' ? 'tv' : 'movie') : (stream ? stream.kind : 'movie'),
      device: deviceFromUserAgent(client.ua),
      where: conn.where,
      whereLabel: WHERE_LABELS[conn.where] || conn.where,
      relayProvider: conn.provider || '',
      ip: client.ip || '',
      positionSeconds: position,
      durationSeconds: duration,
      progress: duration > 0 ? Math.min(1, position / duration) : null,
      // Direct play = the file on disk, byte for byte. The live transcoder
      // reports its own streams through setTranscodeProvider().
      playback: txInfo ? 'transcode' : 'direct',
      playbackLabel: txInfo ? (str(txInfo.label) || 'Converting while playing') : 'Direct play',
      transcode: txInfo ? { reason: str(txInfo.reason), videoCodec: str(txInfo.videoCodec), audioCodec: str(txInfo.audioCodec), quality: str(txInfo.quality), speed: num(txInfo.speed) || null } : null,
      currentBitsPerSec: rate * 8,
      // The file's own average bitrate, when its length is known.
      fileBitsPerSec: stream && stream.sizeBytes && duration > 0 ? Math.round((stream.sizeBytes * 8) / duration) : null,
      bytesSent: stream ? stream.bytes : 0,
      startedAt: session ? num(session.startedAt) : stream ? stream.startedAt : null,
      paused: !!(stream && !rate && session && t - num(session.lastUpdate) > 20 * 1000),
      stoppable: !!stream,
      historyPrivate: hidden
    }
    if (hidden) {
      result.title = 'Private viewing'
      result.kind = null
      result.sessionId = null
      result.positionSeconds = null
      result.durationSeconds = null
      result.progress = null
      result.fileBitsPerSec = null
      result.playbackLabel = txInfo ? 'Converting while playing' : 'Direct play'
      result.transcode = txInfo ? { reason: 'Playback compatibility', speed: num(txInfo.speed) || null } : null
    }
    return result
  }

  /**
   * Stop a stream: close every open response for it and refuse that viewer's
   * requests for that file for STOP_BLOCK_MS. Returns { ok, error }.
   */
  function stopStream(streamId) {
    const id = str(streamId)
    const s = streams.get(id)
    if (!s) return { ok: false, error: 'not_found' }
    const t = now()
    blocks.push({ key: s.key, until: t + STOP_BLOCK_MS })
    for (const res of s.open) {
      try { res.destroy() } catch {}
    }
    s.open.clear()
    streams.delete(id)
    streamIdsByKey.delete(s.key)
    return { ok: true, blockedForSeconds: Math.round(STOP_BLOCK_MS / 1000) }
  }

  function bandwidth() {
    const t = now()
    sweepStreams(t)
    rollDay(t)
    const per = []
    const privateIds = viewingPrivacy.privateUserIds(store)
    let total = 0
    for (const s of streams.values()) {
      const r = rateFrom(s.samples, t)
      total += r
      const hidden = privateIds.has(s.client.userId) || (!s.client.userId && privateIds.size > 0)
      per.push({ streamId: s.id, title: hidden ? 'Private viewing' : s.fileName, userId: s.client.userId || null, historyPrivate: hidden, ip: s.client.ip, bytesPerSec: r, bytesSent: s.bytes })
    }
    if (total > peakToday.bytesPerSec) peakToday = { day: peakToday.day, bytesPerSec: total, at: t }
    per.sort((a, b) => b.bytesPerSec - a.bytesPerSec)
    return {
      currentBytesPerSec: total,
      currentBitsPerSec: total * 8,
      peakTodayBytesPerSec: peakToday.bytesPerSec,
      peakTodayAt: peakToday.at,
      sentTodayBytes: bytesToday.bytes,
      sentTotalBytes: bytesTotal,
      streams: per
    }
  }

  function health() {
    const t = now()
    const usage = safe(cpuUsage, null)
    let cpuPercent = null
    if (usage && lastCpu.usage) {
      const elapsedMicros = Math.max(1, (t - lastCpu.at) * 1000)
      const used = (usage.user - lastCpu.usage.user) + (usage.system - lastCpu.usage.system)
      const cores = Math.max(1, safe(() => os.cpus().length, 1))
      if (t - lastCpu.at >= 250) {
        cpuPercent = Math.max(0, Math.min(100, Math.round((used / elapsedMicros / cores) * 1000) / 10))
        lastCpu = { at: t, usage }
      }
    }
    const mem = safe(memoryUsage, {}) || {}
    const metrics = typeof hooks.getProcessMetrics === 'function' ? safe(hooks.getProcessMetrics, null) : null
    const away = typeof hooks.getAwayStatus === 'function' ? safe(hooks.getAwayStatus, null) : null
    const update = typeof hooks.getUpdateStatus === 'function' ? safe(hooks.getUpdateStatus, null) : null
    const cutoff = t - DAY_MS
    // Logs arrive without verified viewer attribution and may contain file paths.
    const hideErrorDetails = viewingPrivacy.privateUserIds(store).size > 0
    const errors = logLines.filter((l) => l.at >= cutoff).map((l) => hideErrorDetails ? { at: l.at, message: 'A server operation failed. Viewing details are private.' } : l)
    const relay = relayUsageSummary()
    const lastBackupAt = num(safe(() => store.get('lastBackupAt'), 0)) || null
    const tls = safe(tlsStatus, null)
    // "Transcode load": conversions running now / allowed / waiting in line (playbackApi.js's manager).
    const tload = typeof hooks.getTranscodeLoad === 'function' ? safe(hooks.getTranscodeLoad, null) : null
    return {
      transcode: tload ? { active: num(tload.active), running: num(tload.running), max: num(tload.max), queued: num(tload.queued), hardware: !!tload.hardware, fallbacks: num(tload.fallbacks) } : null,
      cpuPercent: metrics && metrics.cpuPercent != null ? metrics.cpuPercent : cpuPercent,
      memoryBytes: metrics && metrics.memoryBytes ? metrics.memoryBytes : num(mem.rss),
      systemMemory: { totalBytes: safe(() => os.totalmem(), 0), freeBytes: safe(() => os.freemem(), 0) },
      uptimeSeconds: Math.round(num(safe(uptime, 0))),
      versions: {
        app: typeof hooks.getAppVersion === 'function' ? str(safe(hooks.getAppVersion, '')) : '',
        electron: str(process.versions.electron || ''),
        node: str(process.versions.node || ''),
        os: `${safe(() => os.type(), '')} ${safe(() => os.release(), '')}`.trim()
      },
      away: {
        registered: !!(away && away.registeredName),
        name: away ? str(away.registeredName || away.name) : '',
        address: away && (away.registeredName || away.name) ? `${away.registeredName || away.name}.beebo.tv` : '',
        online: away ? !!away.online : null,
        connection: away ? str(away.connection) : '',
        homeAddress: away && away.homeAddress ? away.homeAddress : null,
        problem: away ? str(away.problem) : ''
      },
      relay,
      https: tls ? { active: !!tls.active, expiresAt: tls.expiresAt || null } : null,
      lastBackupAt,
      errors24h: { count: errors.length, recent: errors.slice(-10).reverse() },
      update: update ? { available: !!update.available, latest: str(update.latest || update.version || ''), checkedAt: update.checkedAt || null } : null
    }
  }

  function relayUsageSummary() {
    const s = safe(() => store.get('relayUsage'), null)
    if (!s || typeof s !== 'object') return { periodStart: null, periodEnd: null, bytes: { beebo: 0, cloudflare: 0, custom: 0 }, totalBytes: 0 }
    const pick = (p) => {
      const local = num(s.bytes && s.bytes[p])
      const r = s.reported && s.reported[p]
      return r && num(r.bytes) > local ? num(r.bytes) : local
    }
    const bytes = { beebo: pick('beebo'), cloudflare: pick('cloudflare'), custom: pick('custom') }
    return { periodStart: s.periodStart || null, periodEnd: s.periodEnd || null, bytes, totalBytes: bytes.beebo + bytes.cloudflare + bytes.custom }
  }

  function activity(days) {
    let rows = []
    try { rows = (history && history.getHistory ? history.getHistory(store) : []) || [] } catch { rows = [] }
    return aggregateActivity(rows, { now: now(), days, users: usersList(), privateUserIds: viewingPrivacy.privateUserIds(store) })
  }

  async function library({ force = false } = {}) {
    const t = now()
    if (!force && libraryCache && t - libraryCache.at < LIBRARY_TTL_MS) return libraryCache.value
    let scan = { movies: [], tvFiles: [] }
    try { scan = (await scanLibrary()) || scan } catch { scan = { movies: [], tvFiles: [] } }
    const movies = Array.isArray(scan.movies) ? scan.movies : []
    const tvFiles = Array.isArray(scan.tvFiles) ? scan.tvFiles : []
    const showKeys = new Set()
    for (const f of tvFiles) if (f && f.showKey) showKeys.add(f.showKey)
    const folders = safe(libraryFolders, []) || []
    const storage = storageStats(folders, movies.concat(tvFiles), { statfs })
    const extras = typeof hooks.getExtraLibraries === 'function' ? safe(hooks.getExtraLibraries, []) || [] : []
    const conversions = safe(convertList, []) || []
    const countStatus = (st) => conversions.filter((c) => c && c.status === st).length
    const converting = conversions.find((c) => c && c.status === 'converting') || null
    const inbox = safe(inboxStatus, null)
    const introScan = safe(introScanStatus, null)
    const value = {
      counts: {
        movies: Number.isFinite(scan.filmCount) ? scan.filmCount : movies.length,
        shows: showKeys.size,
        episodes: tvFiles.length,
        // Present only when a music or photo library exists (see setHooks.getExtraLibraries).
        extra: (Array.isArray(extras) ? extras : []).filter((x) => x && x.kind).map((x) => ({ kind: str(x.kind), label: str(x.label || x.kind), count: num(x.count) }))
      },
      storage,
      recentlyAdded: (safe(recentlyAdded, []) || []).slice(0, 12),
      missingPosters: safe(missingPosters, null),
      converter: {
        queued: countStatus('queued'),
        converting: countStatus('converting'),
        done: countStatus('done'),
        failed: countStatus('error'),
        current: converting ? { title: str(converting.title || path.basename(str(converting.originalPath))), progress: converting.progressPct != null ? num(converting.progressPct) : null } : null,
        paused: !!safe(() => store.get('conversionsPaused'), false)
      },
      // Automatic intro/credits detection (introDetectJob.js): a progress line for the Library panel.
      introScan: introScan
        ? {
            enabled: !!introScan.enabled,
            running: !!introScan.running,
            paused: introScan.paused ? str(introScan.paused) : '',
            phase: str(introScan.phase),
            current: str(introScan.current),
            itemsTotal: num(introScan.itemsTotal),
            itemsDone: num(introScan.itemsDone),
            introFound: num(introScan.introFound),
            creditsFound: num(introScan.creditsFound),
            lastPassAt: introScan.lastPassAt || null
          }
        : null,
      inbox: inbox
        ? {
            enabled: !!inbox.enabled,
            paused: !!inbox.paused,
            watching: !!inbox.watching,
            working: inbox.working ? str(inbox.working.fileName || inbox.working) : '',
            sortedToday: num(inbox.counts && inbox.counts.sortedToday),
            waitingForCopy: num(inbox.counts && inbox.counts.waitingForCopy),
            needsLook: num(inbox.counts && inbox.counts.needsLook),
            lastScanAt: inbox.lastScanAt || null,
            problem: inbox.problem ? str(inbox.problem.message || inbox.problem.code || '') : ''
          }
        : null,
      generatedAt: t
    }
    libraryCache = { at: t, value }
    return value
  }

  const ALL_SECTIONS = ['now', 'activity', 'library', 'health', 'bandwidth']

  /** The dashboard, or just the named sections. */
  async function snapshot({ sections, days = 7, viewer = null } = {}) {
    const want = new Set((Array.isArray(sections) && sections.length ? sections : ALL_SECTIONS).filter((s) => ALL_SECTIONS.includes(s)))
    const out = { ok: true, generatedAt: now() }
    // viewer null = the desktop app itself, which is the owner at the PC.
    out.canStopStreams = viewer ? canStopStreams(viewer, usersList()) : true
    if (want.has('now')) out.nowPlaying = nowPlaying()
    if (want.has('bandwidth')) out.bandwidth = bandwidth()
    if (want.has('health')) out.health = health()
    if (want.has('activity')) out.activity = activity(days)
    if (want.has('library')) out.library = await library()
    return out
  }

  return {
    trackStream,
    noteSession,
    noteLog,
    stopStream,
    nowPlaying,
    bandwidth,
    health,
    activity,
    library,
    snapshot,
    canStopStreams: (user) => canStopStreams(user, usersList()),
    setHooks: (h) => { hooks = Object.assign({}, hooks, h || {}) },
    setTranscodeProvider: (fn) => { transcodeProvider = typeof fn === 'function' ? fn : null },
    _streams: streams
  }
}

module.exports = {
  createServerDashboard,
  aggregateActivity,
  watchSecondsOf,
  classifyConnection,
  deviceFromUserAgent,
  ownerIdOf,
  canStopStreams,
  diskOf,
  storageStats,
  rateFrom,
  localDayKey,
  groupTitleOf,
  WHERE_LABELS,
  STOP_BLOCK_MS,
  MIN_PLAY_SECONDS
}
