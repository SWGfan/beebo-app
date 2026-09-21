'use strict'
// ============================================================================
// liveHls.js - watching a tuner channel: tuner MPEG-TS in, live HLS out, with a rewind buffer.
// ----------------------------------------------------------------------------
//   * One session per (channel, quality). Everyone watching that channel at that quality shares the
//     session and therefore one tuner (tunerPool.js hands out the tuner).
//   * ffmpeg reads the tuner's stream on stdin, de-interlaces 1080i/480i, converts to H.264 with the
//     encoder hlsTranscoder.js already proved works here (hardware first), sound to stereo AAC
//     (with the same limiter hlsAudio.js uses), and writes 2-second HLS pieces.
//   * The playlist served to players is built HERE from what is on disk: a sliding live window of
//     up to `timeshiftMinutes` (capped by disk), no ENDLIST while the tuner is up, so a player starts
//     at the live edge and can pause and rewind anywhere inside the window.
//   * A viewer that stops asking is dropped; when nobody is left the session closes, ffmpeg stops
//     and the tuner is released. A viewer that only pauses for a long time is dropped as well.
// ============================================================================

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { spawn } = require('child_process')
const hls = require('../hlsTranscoder')
const hlsAudio = require('../hlsAudio')
const encoderCaps = require('../encoderCapabilities')
const chainLib = require('../hlsVideoChain')

// The first bytes the tuner sent are kept (until the first piece exists) so that an encoder that dies
// before making anything can be replaced by the next one WITHOUT losing the start of the stream - even
// when the tuner has already closed. 2 MB is a few seconds of broadcast video.
const HEAD_MAX_BYTES = 2 * 1024 * 1024
// After the tuner closes before any piece exists, ffmpeg is given this long to say whether it choked
// (an encoder failure) or simply ran out of input (a real tuner end).
const TUNER_END_GRACE_MS = 3000

const SEGMENT_SECONDS = 2
const segName = (n) => `seg-${n}.ts`

class LiveError extends Error {
  constructor(code, message) { super(message || code); this.code = code }
}

function videoFilter(quality, encoder) {
  const q = hls.QUALITIES[quality]
  // Quick Sync reads NV12; VAAPI needs NV12 frames uploaded to the graphics card (its render node is
  // opened by buildLiveArgs); everything else takes planar 4:2:0.
  const fmt = encoder === 'h264_qsv' ? 'nv12' : encoder === 'h264_vaapi' ? 'nv12,hwupload' : 'yuv420p'
  return [
    'yadif=mode=0:parity=-1:deint=1',
    "scale=w='trunc(iw*sar/2)*2':h=ih",
    'setsar=1',
    `scale=w='min(${q.width},iw)':h='min(${q.height},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`,
    `format=${fmt}`
  ].join(',')
}

/** The ffmpeg command for one run of a live session (input on stdin). */
function buildLiveArgs({ encoder, quality, outDir, run = 0, startNumber = 0, segmentSeconds = SEGMENT_SECONDS, listSize = 60, device = '' }) {
  const q = hls.QUALITIES[quality]
  if (!q) throw new LiveError('bad_quality', 'Unknown quality.')
  return [
    '-hide_banner', '-nostdin', '-v', 'error', '-y',
    ...(encoder === 'h264_vaapi' ? chainLib.vaapiInit(device) : []),
    '-fflags', '+genpts+discardcorrupt', '-analyzeduration', '2000000', '-probesize', '4000000',
    '-f', 'mpegts', '-i', 'pipe:0',
    '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn', '-map_metadata', '-1',
    '-vf', videoFilter(quality, encoder),
    ...hls.encoderArgs(encoder, q),
    '-g', String(segmentSeconds * 60), '-force_key_frames', `expr:gte(t,n_forced*${segmentSeconds})`,
    '-af', `aresample=async=1:first_pts=0,${hlsAudio.LIMITER_FILTER}`,
    '-c:a', 'aac', '-ac', '2', '-ar', '48000', '-b:a', `${q.audioKbps}k`,
    '-f', 'hls', '-hls_time', String(segmentSeconds), '-hls_segment_type', 'mpegts',
    '-hls_list_size', String(listSize), '-hls_flags', 'independent_segments+temp_file',
    '-start_number', String(startNumber),
    '-hls_segment_filename', path.join(outDir, 'seg-%d.ts'),
    path.join(outDir, `run-${run}.m3u8`)
  ]
}

/** ffmpeg's own playlist text -> [{ seq, dur }] (only the piece lines that look like ours). */
function parseRunPlaylist(text) {
  const out = []
  let dur = null
  for (const line of String(text || '').split(/\r?\n/)) {
    const inf = /^#EXTINF:([0-9.]+)/.exec(line)
    if (inf) { dur = Number(inf[1]); continue }
    const m = /^seg-(\d{1,9})\.ts$/.exec(line.trim())
    if (m && dur !== null && Number.isFinite(dur)) out.push({ seq: Number(m[1]), dur })
    if (line.trim() && !line.startsWith('#')) dur = null
  }
  return out
}

/** The playlist players see. `entries` = [{ seq, dur, disc }] oldest first; discSeq counts discontinuities already dropped. */
function buildLivePlaylist(entries, { discSeq = 0, ended = false } = {}) {
  const target = Math.max(3, Math.ceil(entries.reduce((m, e) => Math.max(m, e.dur), 0)))
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${target}`, `#EXT-X-MEDIA-SEQUENCE:${entries.length ? entries[0].seq : 0}`]
  if (discSeq > 0) lines.push(`#EXT-X-DISCONTINUITY-SEQUENCE:${discSeq}`)
  lines.push('#EXT-X-INDEPENDENT-SEGMENTS')
  for (const e of entries) {
    if (e.disc) lines.push('#EXT-X-DISCONTINUITY')
    lines.push(`#EXTINF:${e.dur.toFixed(3)},`, segName(e.seq))
  }
  if (ended) lines.push('#EXT-X-ENDLIST')
  return lines.join('\n') + '\n'
}

// ---------------------------------------------------------------- tickets
// Same signing as the rest of Beebo's HLS (a media token over the payload); path-safe.
function makeLiveTicket(sign, fields) {
  const payload = Buffer.from(JSON.stringify({ v: 1, ...fields }), 'utf8').toString('base64url')
  return `${payload}.${sign('livetv|' + payload)}`
}
function readLiveTicket(verify, ticket) {
  const t = String(ticket || '')
  if (t.length > 1024) return null
  const dot = t.indexOf('.')
  if (dot < 1) return null
  const payload = t.slice(0, dot)
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) return null
  if (!verify('livetv|' + payload, t.slice(dot + 1))) return null
  try {
    const f = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (!f || f.v !== 1 || typeof f.c !== 'string' || !hls.QUALITIES[f.q]) return null
    return { channel: f.c, quality: f.q, userId: String(f.u || ''), nonce: String(f.n || '').slice(0, 24) }
  } catch { return null }
}

const sessionKeyOf = (channelKey, quality) => crypto.createHash('sha1').update(channelKey + '|' + quality).digest('hex').slice(0, 16)

function createLiveHls({
  pool, ffmpegPath, getEncoder, settings = () => ({}), tmpRoot = path.join(os.tmpdir(), 'beebo-livetv'),
  spawnFn = spawn, now = Date.now, log = () => {}, sweepEveryMs = 5000, viewerIdleMs = 45000, pausedReleaseMs = 20 * 60 * 1000,
  segmentSeconds = SEGMENT_SECONDS, minReadySegments = 2, waitTimeoutMs = 30000, pollMs = 150, maxRestarts = 3, earlyFailMs = 4000,
  // A graphics encoder that has made no piece this long after it started is given up on (the next
  // encoder in the chain takes over, software last).
  hwStallMs = 10000
} = {}) {
  const sessions = new Map()
  const resolveFfmpeg = () => (typeof ffmpegPath === 'function' ? ffmpegPath() : ffmpegPath)
  const windowSegments = () => Math.ceil(Math.max(5, Number(settings().timeshiftMinutes) || 90) * 60 / segmentSeconds)
  const maxBytes = () => Math.max(512, Number(settings().timeshiftMaxMB) || 8192) * 1024 * 1024
  const rootDir = () => { const d = settings().timeshiftDir; return d ? path.join(d, 'beebo-livetv') : tmpRoot }

  try { fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) } catch { /* nothing left over */ }

  function killProc(s) {
    const p = s.proc
    if (!p) return
    s.proc = null
    p.killedByUs = true
    try { p.stdin.destroy() } catch { /* already closed */ }
    try { p.kill('SIGKILL') } catch { /* already gone */ }
  }

  function removeDir(dir) {
    const rm = (left) => {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch { if (left > 0) { const t = setTimeout(() => rm(left - 1), 500); if (t.unref) t.unref() } }
    }
    rm(6)
  }

  function endSession(s, reason, message) {
    if (s.state === 'ended') return
    s.state = 'ended'
    if (s.tunerGrace) { clearTimeout(s.tunerGrace); s.tunerGrace = null }
    s.head = []; s.headBytes = Infinity
    s.endReason = reason
    s.endMessage = message || ''
    if (s.unsub) { s.unsub(); s.unsub = null }
    killProc(s)
    if (s.lease) { s.lease.release(); s.lease = null }
    log(`live TV ${s.channel.key}: ended (${reason})`)
  }

  function closeSession(s, why) {
    if (!sessions.has(s.key)) return
    sessions.delete(s.key)
    endSession(s, why || 'closed')
    s.closed = true
    removeDir(s.dir)
  }

  // ---- what is on disk
  function readRunPlaylist(s) {
    const file = path.join(s.dir, `run-${s.run}.m3u8`)
    let st
    try { st = fs.statSync(file) } catch { return }
    if (s.listStamp === st.mtimeMs + ':' + st.size) return
    s.listStamp = st.mtimeMs + ':' + st.size
    let text
    try { text = fs.readFileSync(file, 'utf8') } catch { return }
    for (const e of parseRunPlaylist(text)) {
      if (s.index.has(e.seq) || e.seq < s.runStartSeq) continue
      let size = 0
      try { size = fs.statSync(path.join(s.dir, segName(e.seq))).size } catch { continue }
      s.index.set(e.seq, { seq: e.seq, dur: e.dur, size, disc: s.pendingDisc && e.seq === s.runStartSeq })
      if (e.seq === s.runStartSeq) s.pendingDisc = false
      s.maxSeq = Math.max(s.maxSeq, e.seq)
    }
    // The first piece of a run proves that encoder works for real: forgive earlier failures.
    if (!s.okReported && s.maxSeq >= s.runStartSeq) {
      s.okReported = true
      s.head = []; s.headBytes = Infinity // a piece exists: the kept start of the stream is no longer needed
      if (s.encoderEvents && typeof s.encoderEvents.noteSuccess === 'function') { try { s.encoderEvents.noteSuccess(s.encoder) } catch { /* advisory */ } }
    }
  }

  /**
   * The encoder in use died before making anything, or a graphics encoder crashed / hung: the SAME
   * session carries on with the next encoder in the chain (software last), so the viewer still gets
   * a picture. One redacted log line. Returns false when there is nothing left to try.
   */
  function fallBack(s, why) {
    // The tuner may have closed in the very same moment the encoder died (s.tunerEnd): the kept start
    // of the stream is then all there is, and the next encoder gets it.
    if (s.chainIdx + 1 >= s.chain.length || s.state === 'ended' || s.closed || !(s.tunerEnd || (s.lease && s.lease.isLive()))) return false
    const from = s.encoder
    if (s.encoderEvents && typeof s.encoderEvents.noteFailure === 'function') { try { s.encoderEvents.noteFailure(from, why) } catch { /* advisory */ } }
    s.chainIdx++
    s.encoder = s.chain[s.chainIdx]
    s.fallbacks++
    log(`live TV ${s.channel.key}: ${hls.ENCODER_WORDS[from] || from} stopped (${why || 'no picture'}) - continuing with ${hls.ENCODER_WORDS[s.encoder] || s.encoder}`)
    try { spawnRun(s) } catch (e) { endSession(s, 'encoder_failed', String((e && e.message) || e)); return true }
    replayHead(s)
    return true
  }

  /**
   * Gives a freshly started ffmpeg the start of the stream again - only when nothing older than that
   * was lost (everything the tuner sent so far is still in the kept head) - and, if the tuner has
   * already closed, closes its input so it finishes what it has.
   */
  function replayHead(s) {
    const p = s.proc
    if (!p || !p.stdin) return
    if (s.head.length && s.bytesIn === s.headBytes && p.stdin.writable) { for (const b of s.head) p.stdin.write(b) }
    if (s.tunerEnd) { try { p.stdin.end() } catch { /* already closed */ } }
  }

  /** A graphics encoder that has made no piece for hwStallMs while people wait: give it up. */
  function checkStall(s) {
    if (!s.proc || s.state === 'ended' || s.maxSeq >= s.runStartSeq) return
    if (!encoderCaps.isHardware(s.encoder) || now() - s.runStartedAt < hwStallMs) return
    if (s.chainIdx + 1 >= s.chain.length) return
    const p = s.proc
    s.proc = null
    p.killedByUs = true
    try { p.stdin.destroy() } catch { /* already closed */ }
    try { p.kill('SIGKILL') } catch { /* already gone */ }
    fallBack(s, `no picture for ${Math.round(hwStallMs / 1000)} s`)
  }

  function prune(s) {
    const win = windowSegments()
    const seqs = [...s.index.keys()].sort((a, b) => a - b)
    let dropCount = Math.max(0, seqs.length - win)
    let total = 0
    for (const q of seqs) total += s.index.get(q).size
    const cap = maxBytes()
    for (let i = 0; i < seqs.length - 2 && (i < dropCount || total > cap); i++) {
      const e = s.index.get(seqs[i])
      total -= e.size
      s.index.delete(seqs[i])
      if (e.disc) s.discSeq++
      try { fs.unlinkSync(path.join(s.dir, segName(e.seq))) } catch { /* already gone */ }
    }
  }

  function refresh(s) {
    readRunPlaylist(s)
    prune(s)
  }

  function entriesOf(s) {
    return [...s.index.values()].sort((a, b) => a.seq - b.seq)
  }

  // ---- ffmpeg runs
  function spawnRun(s) {
    const exe = resolveFfmpeg()
    if (!exe) throw new LiveError('no_ffmpeg', 'The converter (ffmpeg) is not installed on the PC.')
    s.run++
    s.runStartSeq = s.maxSeq + 1
    s.pendingDisc = s.run > 0 && s.index.size > 0
    s.listStamp = ''
    s.runStartedAt = now()
    s.okReported = false
    const args = buildLiveArgs({ encoder: s.encoder, quality: s.quality, outDir: s.dir, run: s.run, startNumber: s.runStartSeq, segmentSeconds, listSize: windowSegments() + 30, device: (s.devices && s.devices[s.encoder]) || '' })
    const child = spawnFn(exe, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true })
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL) } catch { /* not critical */ }
    s.proc = child
    const started = now()
    let tail = ''
    if (child.stderr) child.stderr.on('data', (d) => { tail = (tail + String(d)).slice(-600) })
    if (child.stdin) child.stdin.on('error', () => {})
    child.on('error', (e) => { if (s.proc === child) { s.proc = null; endSession(s, 'encoder_failed', String(e && e.message || e)) } })
    child.on('exit', (code) => {
      if (child.killedByUs || s.proc !== child) return
      s.proc = null
      if (s.state === 'ended' || s.closed) return
      // An encoder that died before its first piece (a graphics encoder refusing to start while
      // other programs use it, say), or a graphics encoder that crashed mid-run, hands over to the
      // next one in the chain instead of ending the session as if the tuner had gone.
      readRunPlaylist(s)
      const madePieces = s.maxSeq >= s.runStartSeq
      if ((!madePieces || (code !== 0 && encoderCaps.isHardware(s.encoder))) && (code !== 0 || !s.tunerEnd) && fallBack(s, encoderCaps.redactReason(tail) || `ffmpeg stopped (${code})`)) return
      // The tuner had already closed and ffmpeg has now drained what it got: a real tuner end (or, with
      // nothing left to fall back to, an encoder that could not use what it got).
      if (s.tunerEnd) {
        if (code !== 0 && !madePieces) endSession(s, 'encoder_failed', `ffmpeg stopped (${code})${tail ? ': ' + encoderCaps.redactReason(tail) : ''}`)
        else endSession(s, s.tunerEnd.reason, s.tunerEnd.message)
        return
      }
      const recent = s.restarts.filter((t) => now() - t < 10 * 60 * 1000)
      if (now() - started < earlyFailMs || recent.length >= maxRestarts || !s.lease || !s.lease.isLive()) {
        endSession(s, 'encoder_failed', `ffmpeg stopped (${code})${tail ? ': ' + tail.trim().split('\n').pop() : ''}`)
        return
      }
      s.restarts = [...recent, now()]
      readRunPlaylist(s)
      try { spawnRun(s) } catch (e) { endSession(s, 'encoder_failed', String(e && e.message || e)) }
    })
  }

  async function startSession({ channel, quality, userId }) {
    const enc = await getEncoder()
    if (!enc || !enc.encoder) throw new LiveError('no_encoder', 'The PC cannot convert video (no ffmpeg or encoder), so live TV cannot be played.')
    if (!resolveFfmpeg()) throw new LiveError('no_ffmpeg', 'The converter (ffmpeg) is not installed on the PC.')
    const key = sessionKeyOf(channel.key, quality)
    // Every encoder proven to work here, best first (probeEncoders / the encoder service give
    // `chain`); a caller that only names one encoder gets a chain of one, exactly as before.
    const chain = [enc.encoder, ...(Array.isArray(enc.chain) ? enc.chain : [])].filter((id, i, all) => id && all.indexOf(id) === i)
    const s = {
      key, channel, quality, encoder: enc.encoder, encoderLabel: enc.label || '', dir: path.join(rootDir(), key),
      chain, chainIdx: 0, fallbacks: 0, okReported: false, runStartedAt: 0, encoderEvents: enc, devices: enc.devices || {},
      bytesIn: 0, head: [], headBytes: 0, tunerEnd: null, tunerGrace: null,
      lease: null, unsub: null, proc: null, run: -1, runStartSeq: 0, pendingDisc: false, maxSeq: -1, index: new Map(), discSeq: 0,
      viewers: new Map(), state: 'starting', endReason: '', endMessage: '', restarts: [], listStamp: '', closed: false, createdAt: now()
    }
    s.lease = await pool.acquire({
      channel, purpose: 'live', label: channel.name || channel.guideNumber, userId,
      onPreempt: (reason) => endSession(s, reason, 'The tuner was needed for a scheduled recording.'),
      onEnd: (err) => { if (s.state !== 'ended') endSession(s, err && err.code ? err.code : 'tuner_lost', err && err.message) }
    })
    try { fs.mkdirSync(s.dir, { recursive: true }) } catch { /* the spawn below reports it */ }
    try {
      s.state = 'running'
      spawnRun(s)
    } catch (e) {
      s.lease.release()
      throw e
    }
    const consumer = {
      write: (buf) => {
        s.bytesIn += buf.length
        // Keep the very start of the stream until the first piece exists (see HEAD_MAX_BYTES).
        if (s.head && s.headBytes < HEAD_MAX_BYTES && s.headBytes === s.bytesIn - buf.length) { s.head.push(buf); s.headBytes += buf.length }
        const p = s.proc
        if (!p || !p.stdin || !p.stdin.writable) return true
        return p.stdin.write(buf)
      },
      buffered: () => (s.proc && s.proc.stdin ? s.proc.stdin.writableLength : 0),
      end: (err) => {
        if (s.state === 'ended') return
        const reason = err && err.code ? err.code : 'tuner_lost'
        const message = err && err.message
        // The tuner closed before any piece exists. That is either a real tuner end or an encoder that
        // choked on the input a moment earlier (its pipe closing looks the same from here), and the two
        // are told apart by ffmpeg itself: give it a moment to drain and exit, then decide. An encoder
        // failure falls back to the next encoder using the kept start of the stream.
        if (s.proc && s.bytesIn > 0 && s.maxSeq < s.runStartSeq && !s.tunerEnd) {
          s.tunerEnd = { reason, message }
          try { s.proc.stdin.end() } catch { /* already closed */ }
          s.tunerGrace = setTimeout(() => { if (s.state !== 'ended') endSession(s, reason, message) }, TUNER_END_GRACE_MS)
          if (s.tunerGrace.unref) s.tunerGrace.unref()
          return
        }
        endSession(s, reason, message)
      }
    }
    s.unsub = s.lease.subscribe(consumer)
    return s
  }

  const starting = new Map()

  /** Joins (or starts) the session for a channel. Throws TunerBusyError / LiveError with a plain-words message. */
  async function open({ channel, quality, userId, nonce }) {
    const key = sessionKeyOf(channel.key, quality)
    let s = sessions.get(key)
    if (s && s.state === 'ended') { closeSession(s, 'replaced'); s = null }
    if (!s) {
      let p = starting.get(key)
      if (!p) {
        p = startSession({ channel, quality, userId }).finally(() => starting.delete(key))
        starting.set(key, p)
      }
      s = await p
      if (!sessions.has(key)) sessions.set(key, s)
    }
    touch(s, nonce || userId, userId, false)
    return s
  }

  function touch(s, viewerId, userId, isSegment) {
    const t = now()
    const v = s.viewers.get(viewerId) || { userId, since: t, lastSeen: t, lastSeg: t }
    v.lastSeen = t
    if (isSegment) v.lastSeg = t
    s.viewers.set(viewerId, v)
  }

  const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref() })

  /** Resolves when a player can start (enough pieces exist) or the session died / took too long. */
  async function ready(s) {
    const deadline = now() + waitTimeoutMs
    for (;;) {
      refresh(s)
      checkStall(s)
      if (s.index.size >= minReadySegments) return true
      if (s.state === 'ended') return s.index.size > 0
      if (now() > deadline) return false
      await sleep(pollMs)
    }
  }

  function playlist(s, viewerId) {
    touch(s, viewerId, '', false)
    refresh(s)
    return buildLivePlaylist(entriesOf(s), { discSeq: s.discSeq, ended: s.state === 'ended' })
  }

  function segmentFile(s, seq, viewerId) {
    touch(s, viewerId, '', true)
    const e = s.index.get(Number(seq))
    return e ? path.join(s.dir, segName(e.seq)) : null
  }

  function info(s) {
    refresh(s)
    const list = entriesOf(s)
    return {
      key: s.key, channelKey: s.channel.key, quality: s.quality, encoder: s.encoder, state: s.state,
      endReason: s.endReason, endMessage: s.endMessage,
      bufferSeconds: Math.round(list.reduce((n, e) => n + e.dur, 0)), pieces: list.length,
      viewers: s.viewers.size, startedAt: s.createdAt, restarts: s.restarts.length, fallbacks: s.fallbacks, bytesIn: s.bytesIn
    }
  }

  function sweep() {
    const t = now()
    for (const s of [...sessions.values()]) {
      for (const [id, v] of [...s.viewers]) {
        if (t - v.lastSeen > viewerIdleMs || t - v.lastSeg > pausedReleaseMs) s.viewers.delete(id)
      }
      if (!s.viewers.size) { closeSession(s, 'idle'); continue }
      if (s.state !== 'ended') { refresh(s); checkStall(s) }
    }
  }
  const timer = sweepEveryMs > 0 ? setInterval(sweep, sweepEveryMs) : null
  if (timer && timer.unref) timer.unref()

  return {
    open, ready, playlist, segmentFile, info, sweep,
    get: (key) => sessions.get(key) || null,
    keyOf: sessionKeyOf,
    leave(key, viewerId) {
      const s = sessions.get(key)
      if (!s) return
      s.viewers.delete(viewerId)
      if (!s.viewers.size) closeSession(s, 'stopped')
    },
    closeWhere(pred) { for (const s of [...sessions.values()]) { if (pred(s)) closeSession(s, 'stopped') } },
    closeAll() { if (timer) clearInterval(timer); for (const s of [...sessions.values()]) closeSession(s, 'shutdown') },
    size: () => sessions.size,
    list: () => [...sessions.values()].map(info)
  }
}

module.exports = {
  SEGMENT_SECONDS, LiveError, videoFilter, buildLiveArgs, parseRunPlaylist, buildLivePlaylist,
  makeLiveTicket, readLiveTicket, sessionKeyOf, createLiveHls
}
