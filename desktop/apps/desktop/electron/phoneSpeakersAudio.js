'use strict'
// ============================================================================
// phoneSpeakersAudio.js - makes the per-channel audio pieces for phone speakers, on demand, politely.
// ----------------------------------------------------------------------------
// Plays the same part for phone speakers that hlsTranscoder.js plays for video:
//   * one ffmpeg run per film (per audio track) cuts EVERY feed a room uses at once (phoneSpeakersChannels.js), as
//     5-second mono WAV pieces named FL-0.wav, FL-1.wav ... in a cache folder under the transcode temp;
//   * it only works around where the phones are: a request far from the run restarts ffmpeg right there (a seek),
//     an ffmpeg that has raced far ahead is stopped and started again when the phones catch up;
//   * the same old-PC rules as the video converter (encoderCapabilities.performanceProfile): a weak PC gets fewer
//     threads, one film at a time, a shorter look-ahead and a smaller cache; after the first pieces of a run ffmpeg
//     drops to below-normal priority (a seek must not be starved by a busy PC, but a long run must not hog it);
//   * the cache is least-recently-used: an idle film's ffmpeg is stopped after a while but its pieces stay for a
//     short time (rewinding is free), and when the folder passes its size limit the film nobody asked for longest goes first.
// No HTTP, no clock of its own (the caller drives sweep()), and spawnFn/now/setPriority are injectable, so the
// lifecycle is tested with a fake ffmpeg (test/phone-speakers-audio.test.js) and once with the real one.
// ============================================================================

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const ch = require('./phoneSpeakersChannels')

class BusyError extends Error {
  constructor(max) {
    super(`The server is busy: ${max} film${max === 1 ? ' is' : 's are'} already being prepared for phone speakers.`)
    this.code = 'busy'
  }
}

const MB = 1024 * 1024

/** The old-PC rules for this workload (see encoderCapabilities.performanceProfile). */
function limitsFor(profile) {
  const tier = (profile && profile.tier) || 'normal'
  return {
    low: { maxSessions: 1, maxAheadSegments: 12, keepBehindSegments: 6, maxCacheBytes: 256 * MB },
    normal: { maxSessions: 2, maxAheadSegments: 30, keepBehindSegments: 24, maxCacheBytes: 768 * MB },
    high: { maxSessions: 3, maxAheadSegments: 45, keepBehindSegments: 36, maxCacheBytes: 1536 * MB }
  }[tier] || { maxSessions: 2, maxAheadSegments: 30, keepBehindSegments: 24, maxCacheBytes: 768 * MB }
}

/** level: 'normal' while people are waiting for the first pieces of a run, 'low' once the phones have what they need. */
function defaultSetPriority(pid, level) {
  if (!(pid > 0)) return
  try { os.setPriority(pid, level === 'low' ? os.constants.priority.PRIORITY_BELOW_NORMAL : os.constants.priority.PRIORITY_NORMAL) } catch { /* not every platform lets us */ }
}

function dirBytes(dir) {
  let total = 0
  let names = []
  try { names = fs.readdirSync(dir) } catch { return 0 }
  for (const n of names) { try { total += fs.statSync(path.join(dir, n)).size } catch { /* gone */ } }
  return total
}

function createAudioManager({
  ffmpegPath,
  tmpRoot = path.join(os.tmpdir(), 'beebo-phone-speakers'),
  profile = null,
  maxConcurrent = null, // the owner's own limit (Settings), else the profile decides
  idleMs = 3 * 60 * 1000, // no request for this long: stop ffmpeg (the pieces stay)
  retainMs = 30 * 60 * 1000, // no request for this long: forget the film and delete its folder
  segmentSeconds = ch.SEGMENT_SECONDS,
  seekGapSegments = 3,
  resumeWithinSegments = 12,
  waitTimeoutMs = 25000,
  stallMs = 20000, // a run that has made nothing for this long while a phone waits is killed and started again (a hung ffmpeg must not spin forever)
  maxStalls = 3,
  pollMs = 50,
  errorRetryMs = 10000,
  sweepEveryMs = 15000,
  spawnFn = spawn,
  now = Date.now,
  log = () => {},
  setPriority = defaultSetPriority,
  rate = ch.DEFAULT_RATE,
  overrides = {} // tests: { maxAheadSegments, keepBehindSegments, maxCacheBytes, maxSessions }
} = {}) {
  const sessions = new Map()
  const profileNow = () => { try { return typeof profile === 'function' ? profile() : profile } catch { return null } }
  const limit = (k) => {
    if (overrides[k] != null) return overrides[k]
    if (k === 'maxSessions' && maxConcurrent) { const v = Number(typeof maxConcurrent === 'function' ? maxConcurrent() : maxConcurrent); if (v >= 1) return Math.min(v, 4) }
    return limitsFor(profileNow())[k]
  }
  const resolveFfmpeg = () => (typeof ffmpegPath === 'function' ? ffmpegPath() : ffmpegPath)

  // Anything left by a previous run of the app is garbage now.
  try { fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) } catch {}

  const filePathOf = (s, feed, n) => path.join(s.dir, ch.segmentFile(feed, n))

  /** Highest piece of the first running feed that is complete (the next one exists, or ffmpeg finished). */
  function updateReady(s) {
    const feed = s.runFeeds.values().next().value
    if (!feed) return
    const before = s.readyUpTo
    while (s.readyUpTo + 1 <= s.lastIndex) {
      const k = s.readyUpTo + 1
      const done = fs.existsSync(filePathOf(s, feed, k + 1)) || (s.completed && fs.existsSync(filePathOf(s, feed, k)))
      if (!done) break
      s.readyUpTo = k
    }
    if (s.readyUpTo > before) { s.lastProgressAt = now(); s.stalls = 0 }
    // The first pieces of a run are what everybody is waiting for: they get a normal share of the CPU, so a busy
    // PC cannot starve a seek. Once the phones have two pieces ahead, ffmpeg drops to below-normal for the rest.
    if (s.proc && !s.lowered && s.readyUpTo >= s.runStart + 1) {
      s.lowered = true
      try { setPriority(s.proc.pid, 'low') } catch {}
    }
  }

  function stopProc(s, reason) {
    const p = s.proc
    if (!p) return
    s.proc = null
    p.killedByUs = reason || 'stopped'
    try { p.kill('SIGKILL') } catch {}
  }

  function startRun(s, startNumber) {
    stopProc(s, 'restart')
    const exe = resolveFfmpeg()
    if (!exe) { s.error = 'ffmpeg is not installed'; s.errorAt = now(); return }
    const gen = ++s.generation
    s.runStart = startNumber
    s.readyUpTo = startNumber - 1
    s.runFeeds = new Set(s.feeds)
    s.completed = false
    s.error = null
    s.lastProgressAt = now()
    try { fs.mkdirSync(s.dir, { recursive: true }) } catch {}
    // Pieces from an earlier run at or after this start may be half written: this run writes them again.
    try {
      for (const name of fs.readdirSync(s.dir)) { const p = ch.parseSegmentFile(name); if (p && p.n >= startNumber) { try { fs.unlinkSync(path.join(s.dir, name)) } catch {} } }
    } catch {}
    let args
    try {
      args = ch.buildSessionArgs({ input: s.filePath, source: s.source, feeds: Array.from(s.feeds), startSegment: startNumber, outDir: s.dir, rate: s.rate, profile: profileNow(), segmentSeconds })
    } catch (e) { s.error = String(e && e.message || e); s.errorAt = now(); return }
    let child
    try {
      child = spawnFn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    } catch (e) { s.error = String(e && e.message || e); s.errorAt = now(); return }
    try { setPriority(child.pid, 'normal') } catch {}
    s.lowered = false
    s.proc = child
    s.runs++
    let tail = ''
    let finished = false
    let grace = null
    if (child.stderr) child.stderr.on('data', (d) => { tail = (tail + String(d)).slice(-600) })
    const finish = (code) => {
      if (finished) return
      finished = true
      if (grace) clearTimeout(grace)
      if (s.generation !== gen || child.killedByUs) return
      s.proc = null
      if (code === 0) { s.completed = true; updateReady(s); return }
      s.error = `ffmpeg stopped (${code})${tail ? ': ' + tail.replace(/[A-Za-z]:\\[^\s:]*/g, '[path]').replace(/\s+/g, ' ').trim().slice(-200) : ''}`
      s.errorAt = now()
      log(`[phone-speakers] ${s.id}: ${s.error}`)
    }
    child.on('error', (e) => {
      if (finished || s.generation !== gen) return
      finished = true
      s.proc = null
      s.error = String(e && e.message || e); s.errorAt = now()
    })
    child.on('exit', (code) => { if (!finished) { grace = setTimeout(() => finish(code), 50); if (grace.unref) grace.unref() } })
    child.on('close', (code) => finish(code))
    log(`[phone-speakers] ${s.id}: cutting ${Array.from(s.feeds).join(',')} from piece ${startNumber}`)
  }

  function prune(s, n) {
    let names = []
    try { names = fs.readdirSync(s.dir) } catch { return }
    const keepFrom = n - limit('keepBehindSegments')
    for (const name of names) {
      const p = ch.parseSegmentFile(name)
      if (p && p.n < keepFrom) { try { fs.unlinkSync(path.join(s.dir, name)) } catch {} }
    }
  }

  function removeDir(dir) {
    const rm = (left) => {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch {
        if (left > 0) { const t = setTimeout(() => rm(left - 1), 500); if (t.unref) t.unref() }
      }
    }
    rm(6)
  }

  function closeSession(s, why) {
    if (!sessions.has(s.key)) return
    sessions.delete(s.key)
    s.closed = true
    stopProc(s, why || 'closed')
    removeDir(s.dir)
  }

  /**
   * Open (or find) the session for one film and audio track.
   *   key        a stable id for this film + track + recipe (the caller hashes path, size, mtime, stream, rate)
   *   filePath   the film        source describeSource(...)        durationSec  the film's length
   *   feeds      the feeds to cut (more can be asked for later with ensureFeeds)
   * Throws BusyError when every slot is used by another film that is still being watched.
   */
  function open({ key, filePath, source, durationSec, feeds = [], rate: sr = rate }) {
    const existing = sessions.get(key)
    if (existing) { existing.lastAccess = now(); for (const f of feeds) if (ch.isFeed(f)) existing.feeds.add(f); return existing }
    const lastIndex = ch.segmentCount(durationSec, segmentSeconds) - 1
    if (lastIndex < 0) throw new Error('unknown_duration')
    if (!source || !Number.isInteger(source.streamIndex)) throw new Error('no_audio')
    // Films nobody has asked about for a while make way; a film that is still being played does not.
    const max = Math.max(1, limit('maxSessions'))
    if (sessions.size >= max) {
      const idle = Array.from(sessions.values()).filter((s) => now() - s.lastAccess > 30000).sort((a, b) => a.lastAccess - b.lastAccess)
      while (sessions.size >= max && idle.length) closeSession(idle.shift(), 'idle')
    }
    if (sessions.size >= max) throw new BusyError(max)
    const id = String(key).slice(0, 8)
    const s = {
      key, id, filePath, source, rate: sr, lastIndex, durationSec,
      dir: path.join(tmpRoot, String(key).replace(/[^A-Za-z0-9_-]/g, '_')),
      feeds: new Set(feeds.filter(ch.isFeed)), runFeeds: new Set(), proc: null, generation: 0, runStart: 0, readyUpTo: -1,
      completed: false, error: null, errorAt: 0, stalls: 0, runs: 0, createdAt: now(), lastAccess: now(), lastProgressAt: now(), lastRequested: -1, closed: false
    }
    if (!s.feeds.size) throw new Error('no feeds')
    sessions.set(key, s)
    return s
  }

  function maintain(s, n) {
    s.lastAccess = now()
    updateReady(s)
    if (s.proc && s.readyUpTo - n > limit('maxAheadSegments')) stopProc(s, 'far ahead')
    else if (!s.proc && !s.completed && !s.error && s.readyUpTo < s.lastIndex && s.readyUpTo >= n - 1 && n >= s.readyUpTo - resumeWithinSegments) {
      startRun(s, s.readyUpTo + 1)
    }
    prune(s, n)
  }

  const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref() })
  const isReady = (s, feed, n) => fs.existsSync(filePathOf(s, feed, n + 1)) || (s.completed && fs.existsSync(filePathOf(s, feed, n)))

  /**
   * Path of piece n of a feed once it is complete; null when it never will be (past the end, session closed, the
   * caller went away, or the run was moved on by a seek). Throws when the run failed. A request the running
   * ffmpeg will not reach soon, or for a feed it is not cutting, restarts ffmpeg right there.
   * opts.aborted() -> true when the phone hung up (a seek cancels its old requests): the wait ends at once.
   */
  async function segment(s, feed, n, opts = {}) {
    n = Number(n)
    if (s.closed || !ch.isFeed(feed) || !Number.isInteger(n) || n < 0 || n > s.lastIndex) return null
    const aborted = () => !!(opts && typeof opts.aborted === 'function' && opts.aborted())
    s.lastAccess = now()
    const file = filePathOf(s, feed, n)
    if (isReady(s, feed, n)) { s.lastRequested = n; maintain(s, n); return file }
    s.lastRequested = n
    const waitStart = now()
    if (!s.feeds.has(feed)) s.feeds.add(feed) // a seat moved to a channel nobody used yet: the run is restarted with it
    updateReady(s)
    if (s.error && s.errorAt && now() - s.errorAt > errorRetryMs) { s.error = null; s.errorAt = 0 }
    const covered = s.proc && s.runFeeds.has(feed) && n >= s.runStart && n <= s.readyUpTo + seekGapSegments
    if (!covered && !s.error) startRun(s, n)
    const deadline = waitStart + waitTimeoutMs
    for (;;) {
      if (s.closed || aborted()) return null
      if (isReady(s, feed, n)) { maintain(s, n); return file }
      updateReady(s)
      if (!s.proc) {
        if (s.error) throw new Error(s.error)
        if (s.completed && s.runFeeds.has(feed) && n >= s.runStart) return isReady(s, feed, n) ? file : null
        // stopped by us (far ahead, idle) or by a newer request that did not cover this piece: start here
        startRun(s, n)
        if (s.error) throw new Error(s.error)
      } else if (!s.runFeeds.has(feed) || n < s.runStart) {
        return null // overtaken by a newer run that will never make this piece
      }
      if (s.proc && now() - Math.max(s.lastProgressAt, waitStart) > stallMs) {
        stopProc(s, 'stalled')
        s.stalls++
        log(`[phone-speakers] ${s.id}: no audio for ${Math.round(stallMs / 1000)} s (stall ${s.stalls})`)
        if (s.stalls >= maxStalls) { s.error = 'The computer could not cut the sound for this film (ffmpeg kept stalling).'; s.errorAt = now(); s.stalls = 0; throw new Error(s.error) }
        startRun(s, n)
        continue
      }
      if (now() > deadline) throw new Error('timed out preparing the audio')
      await sleep(pollMs)
    }
  }

  /** Tell the session more feeds are wanted (a seat was moved to a new channel). They are cut from the next request on. */
  function ensureFeeds(s, feeds) {
    for (const f of feeds || []) if (ch.isFeed(f)) s.feeds.add(f)
  }

  function totalBytes() {
    let t = 0
    for (const s of sessions.values()) t += dirBytes(s.dir)
    return t
  }

  /** Least-recently-used housekeeping. Call about every 15 s (a timer does it when sweepEveryMs > 0). */
  function sweep() {
    const t = now()
    for (const s of Array.from(sessions.values())) {
      if (t - s.lastAccess > retainMs) { closeSession(s, 'retention'); continue }
      if (s.proc && t - s.lastAccess > idleMs) stopProc(s, 'idle')
    }
    const cap = limit('maxCacheBytes')
    let bytes = totalBytes()
    if (bytes <= cap) return { bytes, evicted: 0 }
    let evicted = 0
    const byAge = Array.from(sessions.values()).sort((a, b) => a.lastAccess - b.lastAccess)
    while (bytes > cap && byAge.length > 1) {
      const s = byAge.shift()
      closeSession(s, 'cache full')
      evicted++
      bytes = totalBytes()
    }
    if (bytes > cap && byAge.length === 1) {
      // Only the film being watched is left: keep what is near the phones, drop the far-behind pieces.
      const s = byAge[0]
      prune(s, Math.max(0, s.lastRequested) + limit('keepBehindSegments') - 2)
      bytes = totalBytes()
    }
    return { bytes, evicted }
  }
  const timer = sweepEveryMs > 0 ? setInterval(sweep, sweepEveryMs) : null
  if (timer && timer.unref) timer.unref()

  return {
    open, segment, ensureFeeds, sweep,
    get: (key) => sessions.get(key) || null,
    close: (key) => { const s = sessions.get(key); if (s) closeSession(s, 'stopped') },
    closeAll: () => { if (timer) clearInterval(timer); for (const s of Array.from(sessions.values())) closeSession(s, 'shutdown') },
    size: () => sessions.size,
    cacheBytes: totalBytes,
    limits: () => ({ maxSessions: limit('maxSessions'), maxAheadSegments: limit('maxAheadSegments'), keepBehindSegments: limit('keepBehindSegments'), maxCacheBytes: limit('maxCacheBytes') }),
    load: () => ({ sessions: sessions.size, running: Array.from(sessions.values()).filter((s) => s.proc).length, max: limit('maxSessions') }),
    list: () => Array.from(sessions.values()).map((s) => ({ id: s.id, feeds: Array.from(s.feeds), running: !!s.proc, runStart: s.runStart, readyUpTo: s.readyUpTo, runs: s.runs, error: s.error, lastAccess: s.lastAccess }))
  }
}

module.exports = { createAudioManager, BusyError, limitsFor, dirBytes }
