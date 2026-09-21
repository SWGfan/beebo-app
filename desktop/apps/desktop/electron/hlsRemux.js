'use strict'
// ============================================================================
// hlsRemux.js - "direct stream": copy the picture (and the sound, when the device plays it) into
// fragmented MP4 / HLS without re-encoding anything.
// ----------------------------------------------------------------------------
// Why this exists: some clients (Apple TV, Safari, browsers) only play HLS, and cannot open the MKV a UHD
// remux lives in. The live conversion (hlsTranscoder.js) would re-encode the picture to 8-bit SDR H.264 and lose
// HDR10 / HDR10+ / Dolby Vision. Here the HEVC (or H.264) bitstream is COPIED, so HDR and Dolby Vision survive
// bit for bit; the sound is copied when the device plays it (AAC, Dolby Digital, Dolby Digital Plus incl. Atmos
// JOC) and converted alone (E-AC-3 / AC-3 / AAC, hlsAudio.js) when it does not.
//
// How it works (see docs/HOME-THEATER.md for the measurements behind each choice):
//   * KEY FRAME INDEX. One ffprobe pass over the video packets (I/O only, no decoding) lists every key
//     frame. It is cached on disk. Copy mode can only cut on key frames, so the playlist is built from them:
//     pieces of about 6 s that start and end on key frames, with the real durations in #EXTINF.
//   * ONE ffmpeg per RUN, writing fragmented MP4 to a pipe: ftyp + moov (the init segment) and then one
//     moof+mdat fragment per key frame. Node groups the fragments into the planned pieces and writes
//     seg-<n>.m4s, so the pieces always fall exactly where the playlist says.
//   * SEEKING starts a new run at the wanted piece (`-ss <key frame>`); each run's video timeline is
//     shifted so that every run agrees with the init segment that was served (`normaliseFragment`): ffmpeg's
//     mp4 muxer writes a run-specific edit-list offset, so two runs differ by a constant which is measured
//     from each run's own moov and removed from its `tfdt` boxes.
//   * TAGS. HEVC is written as hvc1 (Apple and browsers refuse hev1), Dolby Vision as dvh1 with `-strict
//     unofficial`, which is the flag ffmpeg needs before it writes the dvcC / dvvC configuration box at all
//     (measured: without it the box is silently dropped). A player without Dolby Vision gets the RPU removed
//     (`-bsf:v dovi_rpu=strip=1`) and plays the HDR10 base layer.
//
// No encoder is involved and nothing here needs a GPL part of ffmpeg: the mov/mp4 muxer, the hevc/h264
// parsers, the dovi_rpu bitstream filter and the ac3/eac3 encoder are all in libavformat / libavcodec proper.
// ============================================================================

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { spawn, execFile } = require('child_process')
const hlsAudio = require('./hlsAudio')
const ffmpegArgs = require('./ffmpegArgs')

const TARGET_SEGMENT_SEC = 6
const MOVFLAGS = 'frag_keyframe+empty_moov+default_base_moof+delay_moov+frag_discont'

// ---------------------------------------------------------------- key frames
/** ffprobe arguments that list the packets of one video stream (put the file arguments after them). */
function keyframeProbeArgs(streamIndex) {
  return ['-v', 'error', '-select_streams', String(Number.isInteger(streamIndex) ? streamIndex : 'v:0'), '-show_entries', 'packet=pts_time,dts_time,flags', '-of', 'csv=p=0']
}

/** ffprobe's "pts,dts,flags" lines -> sorted key frame times in seconds. */
function parseKeyframeCsv(text) {
  const times = []
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line) continue
    const [pts, dts, flags] = line.split(',')
    if (!/K/.test(flags || '')) continue
    const t = Number.isFinite(Number(pts)) ? Number(pts) : Number(dts)
    if (Number.isFinite(t) && t >= -0.001) times.push(Math.max(0, t))
  }
  times.sort((a, b) => a - b)
  const out = []
  for (const t of times) if (!out.length || t - out[out.length - 1] > 0.0005) out.push(Math.round(t * 1e6) / 1e6)
  return out
}

/**
 * The pieces of the playlist: each starts on a key frame and ends on the first key frame at least `target`
 * seconds later (the last one ends at the end of the film). Deterministic in (keyframes, duration, target),
 * which is what lets a run started at any piece cut exactly where the playlist promised.
 * Returns [{ index, start, end, duration, kfStart, kfEnd }] with kfEnd exclusive.
 */
function planSegments(keyframes, durationSec, target = TARGET_SEGMENT_SEC) {
  const kf = Array.isArray(keyframes) ? keyframes : []
  const dur = Number(durationSec) || 0
  if (!kf.length || !(dur > 0)) return []
  const segs = []
  let i = 0
  while (i < kf.length) {
    let j = i + 1
    while (j < kf.length && kf[j] - kf[i] < target - 1e-6) j++
    const start = segs.length === 0 ? 0 : kf[i]
    const end = j < kf.length ? kf[j] : Math.max(dur, kf[i] + 0.001)
    segs.push({ index: segs.length, start, end, duration: Math.max(0.001, end - start), kfStart: i, kfEnd: j })
    i = j
  }
  return segs
}

/** The whole-film VOD playlist (fMP4: EXT-X-MAP). */
function buildMediaPlaylist(segments, { initName = 'init.mp4' } = {}) {
  const max = segments.reduce((m, s) => Math.max(m, s.duration), 0)
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', `#EXT-X-TARGETDURATION:${Math.max(1, Math.ceil(max - 1e-6))}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-INDEPENDENT-SEGMENTS', `#EXT-X-MAP:URI="${initName}"`]
  for (const s of segments) { lines.push(`#EXTINF:${s.duration.toFixed(6)},`); lines.push(`seg-${s.index}.m4s`) }
  lines.push('#EXT-X-ENDLIST')
  return lines.join('\n') + '\n'
}

// ------------------------------------------------------------------- codecs
const hex2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')

/** RFC 6381 / HLS CODECS value for a video stream: avc1.640029, hvc1.2.4.L153.B0, or dvh1.05.06 for Dolby Vision profile 5. */
function videoCodecString(video, { dvKept = false } = {}) {
  if (!video) return ''
  const codec = String(video.codec || '').toLowerCase()
  if (codec === 'h264') {
    const p = String(video.profile || '').toLowerCase()
    const idc = /high 10/.test(p) ? 110 : /high/.test(p) ? 100 : /main/.test(p) ? 77 : /baseline/.test(p) ? 66 : 100
    return `avc1.${hex2(idc)}${hex2(0)}${hex2(video.level || 41)}`
  }
  if (codec === 'hevc') {
    const dv = video.dolbyVision
    if (dvKept && dv && dv.profile === 5) return `dvh1.05.${String(dv.level || 6).padStart(2, '0')}`
    const main10 = /10/.test(String(video.profile || '')) || (video.bitDepth || 8) > 8
    return `hvc1.${main10 ? '2.4' : '1.6'}.L${video.level || 120}.B0`
  }
  if (codec === 'av1') return `av01.0.${String(Math.max(0, Math.min(31, Math.round((video.level || 8) / 1)))).padStart(2, '0')}M.${String(video.bitDepth || 8).padStart(2, '0')}`
  return codec
}

/** The Dolby Vision code for SUPPLEMENTAL-CODECS ("dvh1.08.06/db1p") of a profile 8.x picture that is kept. */
function supplementalCodec(video) {
  const dv = video && video.dolbyVision
  if (!dv || dv.profile !== 8) return ''
  const brand = { 1: 'db1p', 2: 'db2g', 4: 'db4h' }[dv.compatId]
  if (!brand) return ''
  return `dvh1.${String(dv.profile).padStart(2, '0')}.${String(dv.level || 6).padStart(2, '0')}/${brand}`
}

const audioCodecString = (codec) => ({ aac: 'mp4a.40.2', ac3: 'ac-3', eac3: 'ec-3' })[String(codec || '').toLowerCase()] || ''

/** VIDEO-RANGE for the master playlist: what the picture we deliver is. */
function videoRangeOf(hdrDelivered) {
  const d = String(hdrDelivered || '')
  if (/HLG/.test(d)) return 'HLG'
  if (/Dolby Vision|HDR10/.test(d)) return 'PQ'
  return 'SDR'
}

/**
 * master.m3u8 for one remux session: the codec strings and VIDEO-RANGE an HDR / Dolby Vision player (Apple TV)
 * needs before it will switch the display mode. NOT verified on an Apple device (see docs/HOME-THEATER.md).
 *   video       the parsed video (codec, profile, level, size, fps, Dolby Vision)
 *   dvKept      the Dolby Vision layer is delivered (dvh1 in the segments)
 *   range       'PQ' | 'HLG' | 'SDR' of the delivered picture
 */
function buildMasterPlaylist({ video, dvKept = false, range = 'SDR', audioCodec, audioChannels, bandwidth, playlist = 'index.m3u8' }) {
  const vcodec = videoCodecString(video, { dvKept })
  const supp = dvKept ? supplementalCodec(video) : ''
  const codecs = [vcodec, audioCodecString(audioCodec)].filter(Boolean).join(',')
  const attrs = [`BANDWIDTH=${Math.max(100000, Math.round(bandwidth || 20000000))}`, `CODECS="${codecs}"`]
  if (supp) attrs.push(`SUPPLEMENTAL-CODECS="${supp}"`)
  if (video && video.width && video.height) attrs.push(`RESOLUTION=${video.width}x${video.height}`)
  if (video && video.fps) attrs.push(`FRAME-RATE=${Number(video.fps).toFixed(3)}`)
  attrs.push(`VIDEO-RANGE=${['PQ', 'HLG', 'SDR'].includes(range) ? range : 'SDR'}`)
  if (audioChannels) attrs.push(`CHANNELS="${audioChannels}"`)
  return ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS', `#EXT-X-STREAM-INF:${attrs.join(',')}`, playlist, ''].join('\n')
}

// ------------------------------------------------------------------ ffmpeg
/**
 * The ffmpeg command of one run.
 *   input, tracks       the file and playbackTracks.parseTracks output
 *   rx                  the ticket's remux request { a: audio stream, ac: 'copy'|'encode', au: hlsAudio ticket object, t: tag, s: 1 = strip Dolby Vision }
 *   startSec            the key frame to start at (0 = the beginning)
 *   audioEncoders       { aac, ac3, eac3 } this ffmpeg can encode
 * Output: fragmented MP4 on stdout (pipe:1).
 */
function buildRemuxArgs({ input, tracks, rx, startSec = 0, audioEncoders = null }) {
  const video = tracks && tracks.video
  if (!video) throw new Error('no video stream')
  const args = ['-hide_banner', '-nostdin', '-v', 'error', '-y']
  if (startSec > 0) args.push('-ss', Math.max(0, startSec - 0.0005).toFixed(4)) // a hair early: the key frame itself must not be skipped
  args.push(...ffmpegArgs.inputArgs(input))
  args.push('-map', `0:${video.streamIndex != null ? video.streamIndex : 'v:0'}`)
  const audio = rx && rx.a != null ? (tracks.audio || []).find((x) => x.streamIndex === Number(rx.a)) : ((tracks.audio || []).find((x) => x.isDefault) || (tracks.audio || [])[0])
  if (audio && audio.streamIndex != null) args.push('-map', `0:${audio.streamIndex}`)
  args.push('-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1')
  // picture: always a copy
  args.push('-c:v', 'copy')
  if (rx && rx.t) args.push('-tag:v', String(rx.t))
  if (rx && rx.s) args.push('-bsf:v', 'dovi_rpu=strip=1')
  // ffmpeg's mp4 muxer only writes the Dolby Vision configuration box when told to be lenient (measured on ffmpeg 9.0.1).
  if (rx && rx.t === 'dvh1') args.push('-strict', 'unofficial')
  // sound: copy, or the one stream converted by hlsAudio (its filters and codec options)
  if (audio) {
    if (rx && rx.ac === 'copy') args.push('-c:a', 'copy')
    else {
      const plan = hlsAudio.planAudio({ track: audio, au: rx ? rx.au : null, quality: { audioKbps: 192 }, qualityId: '1080p', encoders: audioEncoders })
      args.push(...plan.args)
    }
  }
  // From the start of the film nothing is dropped (not even the encoder-delay packet at a slightly negative time). After a seek,
  // -copypriorss 0 stops ffmpeg copying the sound that precedes the seek point, which would start it seconds ahead of the picture.
  if (startSec > 0) args.push('-copypriorss', '0', '-output_ts_offset', startSec.toFixed(4))
  args.push('-f', 'mp4', '-movflags', MOVFLAGS, 'pipe:1')
  return args
}

// ----------------------------------------------------------------- MP4 boxes
/** Splits a byte stream into top-level MP4 boxes, joining chunks only when a whole box has arrived. */
function createBoxReader(onBox) {
  const state = { chunks: [], len: 0, head: null }
  const concatAll = () => { if (state.chunks.length > 1) state.chunks = [Buffer.concat(state.chunks)]; return state.chunks[0] }
  return {
    push(chunk) {
      state.chunks.push(chunk)
      state.len += chunk.length
      for (;;) {
        if (!state.head) {
          if (state.len < 8) return
          const b = concatAll()
          let size = b.readUInt32BE(0)
          const type = b.toString('latin1', 4, 8)
          if (size === 1) {
            if (b.length < 16) return
            size = Number(b.readBigUInt64BE(8))
          }
          if (size < 8) throw new Error(`bad MP4 box size ${size} (${type})`)
          state.head = { size, type }
        }
        if (state.len < state.head.size) return
        const b = concatAll()
        const box = b.subarray(0, state.head.size)
        const rest = b.subarray(state.head.size)
        const type = state.head.type
        state.head = null
        state.chunks = rest.length ? [rest] : []
        state.len = rest.length
        onBox({ type, buf: Buffer.from(box) })
      }
    }
  }
}

function boxChildren(buf, start, end) {
  const out = []
  let o = start
  while (o + 8 <= end) {
    let size = buf.readUInt32BE(o)
    const type = buf.toString('latin1', o + 4, o + 8)
    let header = 8
    if (size === 1) { size = Number(buf.readBigUInt64BE(o + 8)); header = 16 }
    if (size < header || o + size > end) break
    out.push({ type, off: o, size, header, body: o + header, end: o + size })
    o += size
  }
  return out
}
const child = (buf, parent, type) => boxChildren(buf, parent.body, parent.end).find((b) => b.type === type)

/**
 * What the run's moov says: per track { id, handler: 'vide' | 'soun', timescale, mediaTime } where mediaTime is the
 * first non-empty edit's media_time (the presentation offset the muxer wrote for this run).
 */
function readInitInfo(moovBuf) {
  const top = boxChildren(moovBuf, 0, moovBuf.length)
  const moov = top.find((b) => b.type === 'moov')
  if (!moov) return { tracks: [] }
  const tracks = []
  for (const trak of boxChildren(moovBuf, moov.body, moov.end).filter((b) => b.type === 'trak')) {
    const tkhd = child(moovBuf, trak, 'tkhd')
    const mdia = child(moovBuf, trak, 'mdia')
    if (!tkhd || !mdia) continue
    const ver = moovBuf[tkhd.body]
    const id = moovBuf.readUInt32BE(tkhd.body + (ver === 1 ? 20 : 12))
    const mdhd = child(moovBuf, mdia, 'mdhd')
    const hdlr = child(moovBuf, mdia, 'hdlr')
    const timescale = mdhd ? moovBuf.readUInt32BE(mdhd.body + (moovBuf[mdhd.body] === 1 ? 20 : 12)) : 0
    const handler = hdlr ? moovBuf.toString('latin1', hdlr.body + 8, hdlr.body + 12) : ''
    let mediaTime = 0
    let emptyEdit = false
    const edts = child(moovBuf, trak, 'edts')
    const elst = edts ? child(moovBuf, edts, 'elst') : null
    if (elst) {
      const v = moovBuf[elst.body]
      const n = moovBuf.readUInt32BE(elst.body + 4)
      let found = false
      for (let k = 0; k < n; k++) {
        const o = elst.body + 8 + k * (v === 1 ? 20 : 12)
        const mt = v === 1 ? Number(moovBuf.readBigInt64BE(o + 8)) : moovBuf.readInt32BE(o + 4)
        if (mt === -1) { emptyEdit = true; continue }
        if (!found) { mediaTime = mt; found = true }
      }
    }
    tracks.push({ id, handler, timescale, mediaTime, emptyEdit })
  }
  return { tracks }
}

/**
 * Adds `deltaByTrack[trackId]` (in that track's timescale) to every tfdt of a fragment, in place. Returns the
 * fragment, plus the first track's start times in seconds for sanity checks.
 */
function normaliseFragment(moofBuf, deltaByTrack, timescaleByTrack = {}) {
  const top = boxChildren(moofBuf, 0, moofBuf.length)
  const moof = top.find((b) => b.type === 'moof')
  const starts = {}
  if (!moof) return { buf: moofBuf, starts }
  for (const traf of boxChildren(moofBuf, moof.body, moof.end).filter((b) => b.type === 'traf')) {
    const tfhd = child(moofBuf, traf, 'tfhd')
    const tfdt = child(moofBuf, traf, 'tfdt')
    if (!tfhd || !tfdt) continue
    const id = moofBuf.readUInt32BE(tfhd.body + 4)
    const delta = deltaByTrack[id] || 0
    const ver = moofBuf[tfdt.body]
    let base = ver === 1 ? Number(moofBuf.readBigUInt64BE(tfdt.body + 4)) : moofBuf.readUInt32BE(tfdt.body + 4)
    if (delta) {
      base += delta
      if (base < 0) base = 0
      if (ver === 1) moofBuf.writeBigUInt64BE(BigInt(base), tfdt.body + 4)
      else if (base <= 0xffffffff) moofBuf.writeUInt32BE(base, tfdt.body + 4)
      else throw new Error('tfdt overflow')
    }
    starts[id] = timescaleByTrack[id] ? base / timescaleByTrack[id] : base
  }
  return { buf: moofBuf, starts }
}

// -------------------------------------------------------- keyframe index cache
/**
 * Key frame lists per file, read with ffprobe (one process per file at a time), kept in memory and on disk
 * (`cacheDir`, keyed by path + size + modified time).
 *   get(filePath, streamIndex) -> { state: 'ready', keyframes } | { state: 'scanning' } | { state: 'failed', error }
 *   ensure(...)               -> Promise of the same, resolved when the scan ends
 */
function createKeyframeIndex({ ffprobePath, cacheDir = null, execFileFn = execFile, timeoutMs = 20 * 60 * 1000, maxMemory = 64 } = {}) {
  const memory = new Map()
  const running = new Map()
  const exe = () => { try { return typeof ffprobePath === 'function' ? ffprobePath() : ffprobePath } catch { return null } }
  const keyOf = (filePath, st, streamIndex) => crypto.createHash('sha1').update(`${filePath}|${st.size}|${Math.floor(st.mtimeMs)}|${streamIndex}|v1`).digest('hex').slice(0, 24)

  function readDisk(key) {
    if (!cacheDir) return null
    try { const j = JSON.parse(fs.readFileSync(path.join(cacheDir, key + '.json'), 'utf8')); return Array.isArray(j.keyframes) && j.keyframes.length ? j.keyframes : null } catch { return null }
  }
  function writeDisk(key, keyframes) {
    if (!cacheDir) return
    try {
      fs.mkdirSync(cacheDir, { recursive: true })
      fs.writeFileSync(path.join(cacheDir, key + '.json.tmp'), JSON.stringify({ v: 1, keyframes }))
      fs.renameSync(path.join(cacheDir, key + '.json.tmp'), path.join(cacheDir, key + '.json'))
      const files = fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json')).map((f) => ({ f, t: fs.statSync(path.join(cacheDir, f)).mtimeMs })).sort((a, b) => b.t - a.t)
      for (const x of files.slice(400)) { try { fs.unlinkSync(path.join(cacheDir, x.f)) } catch { /* best effort */ } }
    } catch { /* an index that cannot be saved is just scanned again next time */ }
  }

  function start(filePath, streamIndex) {
    let st
    try { st = fs.statSync(filePath) } catch { return { state: 'failed', error: 'not_found' } }
    const key = keyOf(filePath, st, streamIndex)
    if (memory.has(key)) { const v = memory.get(key); memory.delete(key); memory.set(key, v); return { state: 'ready', keyframes: v, key } }
    const disk = readDisk(key)
    if (disk) { memory.set(key, disk); return { state: 'ready', keyframes: disk, key } }
    if (running.has(key)) return { state: 'scanning', key, promise: running.get(key) }
    const bin = exe()
    if (!bin) return { state: 'failed', error: 'no_ffprobe', key }
    const promise = new Promise((resolve) => {
      let child
      try {
        child = execFileFn(bin, [...keyframeProbeArgs(streamIndex), ...ffmpegArgs.inputArgs(filePath)], { timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
          if (err) return resolve({ state: 'failed', error: 'probe_failed', key })
          const kf = parseKeyframeCsv(stdout)
          if (!kf.length) return resolve({ state: 'failed', error: 'no_keyframes', key })
          memory.set(key, kf)
          while (memory.size > maxMemory) memory.delete(memory.keys().next().value)
          writeDisk(key, kf)
          resolve({ state: 'ready', keyframes: kf, key })
        })
      } catch { return resolve({ state: 'failed', error: 'probe_failed', key }) }
      try { if (child && child.pid) os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL) } catch { /* optional */ }
    }).then((r) => { running.delete(key); return r })
    running.set(key, promise)
    return { state: 'scanning', key, promise }
  }
  return {
    get: (filePath, streamIndex) => { const r = start(filePath, streamIndex); return r.state === 'scanning' ? { state: 'scanning' } : r },
    ensure: (filePath, streamIndex) => { const r = start(filePath, streamIndex); return r.state === 'scanning' ? r.promise : Promise.resolve(r) },
    /** Wait up to `ms` for the index: { state: 'ready' | 'scanning' | 'failed' }. */
    async wait(filePath, streamIndex, ms = 0) {
      const r = start(filePath, streamIndex)
      if (r.state !== 'scanning') return r
      if (!(ms > 0)) return { state: 'scanning' }
      let timer
      const late = new Promise((res) => { timer = setTimeout(() => res({ state: 'scanning' }), ms); if (timer.unref) timer.unref() })
      const out = await Promise.race([r.promise, late])
      clearTimeout(timer)
      return out
    }
  }
}

// ---------------------------------------------------------------- the manager
function defaultSetPriority(pid) {
  if (!(pid > 0)) return
  try { os.setPriority(pid, os.constants.priority.PRIORITY_BELOW_NORMAL) } catch { /* not every platform lets us */ }
}

/**
 * Sessions for direct-stream tickets. Same shape as the live conversion manager's: open(), playlist(), segment(),
 * initSegment(), close(); one ffmpeg run at a time per session, restarted on a seek, stopped when far ahead.
 */
function createRemuxManager({
  ffmpegPath,
  keyframeIndex,
  tmpRoot = path.join(os.tmpdir(), 'beebo-remux'),
  maxConcurrent = 4,
  idleMs = 3 * 60 * 1000,
  targetSegmentSec = TARGET_SEGMENT_SEC,
  maxAheadSegments = 30,
  resumeWithinSegments = 12,
  keepBehindSegments = 6,
  seekGapSegments = 3,
  waitTimeoutMs = 60000,
  pollMs = 50,
  spawnFn = spawn,
  now = Date.now,
  log = () => {},
  sweepEveryMs = 15000,
  setPriority = defaultSetPriority
} = {}) {
  const sessions = new Map()
  const resolveFfmpeg = () => (typeof ffmpegPath === 'function' ? ffmpegPath() : ffmpegPath)
  const maxOf = () => Math.max(1, Number(typeof maxConcurrent === 'function' ? maxConcurrent() : maxConcurrent) || 4)
  try { fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) } catch { /* nothing left over is fine */ }
  const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref() })

  const segFile = (s, n) => path.join(s.dir, `seg-${n}.m4s`)
  const has = (s, n) => fs.existsSync(segFile(s, n))

  function updateReady(s) {
    while (s.readyUpTo + 1 < s.segments.length && has(s, s.readyUpTo + 1)) s.readyUpTo++
  }

  function stopProc(s, why) {
    const p = s.proc
    if (!p) return
    s.proc = null
    p.killedByUs = why || 'stopped'
    try { p.kill('SIGKILL') } catch { /* already gone */ }
  }

  function closeSession(s, why) {
    if (!sessions.has(s.key)) return
    sessions.delete(s.key)
    s.closed = true
    stopProc(s, why || 'closed')
    const rm = (left) => { try { fs.rmSync(s.dir, { recursive: true, force: true }) } catch { if (left > 0) { const t = setTimeout(() => rm(left - 1), 500); if (t.unref) t.unref() } } }
    rm(6)
  }

  /** Write one finished piece atomically. */
  function writePiece(s, n, bufs) {
    const file = segFile(s, n)
    try {
      fs.mkdirSync(s.dir, { recursive: true })
      fs.writeFileSync(file + '.tmp', Buffer.concat(bufs))
      fs.renameSync(file + '.tmp', file)
    } catch (e) { s.error = `could not write a piece: ${e.message}` }
  }

  function startRun(s, segIndex) {
    stopProc(s, 'restart')
    const exe = resolveFfmpeg()
    if (!exe) throw new Error('ffmpeg is not installed')
    const seg = s.segments[segIndex]
    const gen = ++s.generation
    s.runStart = segIndex
    s.completed = false
    s.error = null
    s.lastProgressAt = now()
    // A restart forgets what an earlier run left ahead of the new start so "ready" never lies.
    s.readyUpTo = segIndex - 1
    updateReady(s)
    const args = buildRemuxArgs({ input: s.filePath, tracks: s.tracks, rx: s.rx, startSec: segIndex === 0 ? 0 : s.keyframes[seg.kfStart], audioEncoders: s.audioEncoders })
    let child
    try {
      child = spawnFn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (e) { s.error = String((e && e.message) || e); return }
    try { setPriority(child.pid) } catch { /* optional */ }
    s.proc = child
    s.runs++
    const run = { gen, kf: seg.kfStart, cur: -1, bufs: [], count: 0, moof: null, info: null, delta: {}, timescale: {}, fragments: 0 }
    let tail = ''
    if (child.stderr) child.stderr.on('data', (d) => { tail = (tail + String(d)).slice(-600) })

    const onBox = ({ type, buf }) => {
      if (s.generation !== gen || s.closed) return
      if (type === 'moov') {
        run.info = readInitInfo(buf)
        for (const t of run.info.tracks) run.timescale[t.id] = t.timescale
        const bad = run.info.tracks.find((t) => t.emptyEdit)
        if (bad) { s.error = 'unexpected empty edit in the remux output'; stopProc(s, 'error'); return }
        if (!s.init) {
          // this run's init is the one every later run is measured against
          s.init = Buffer.concat([run.ftyp || Buffer.alloc(0), buf])
          s.initInfo = run.info
        }
        for (const t of run.info.tracks) {
          const served = (s.initInfo.tracks.find((x) => x.id === t.id) || {}).mediaTime || 0
          run.delta[t.id] = served - t.mediaTime
        }
        s.lastRunDelta = { ...run.delta } // kept for diagnostics and tests: the shift that made this run agree with the served init
      } else if (type === 'ftyp') {
        run.ftyp = buf
      } else if (type === 'moof') {
        run.moof = buf
      } else if (type === 'mdat' && run.moof) {
        const { starts } = normaliseFragment(run.moof, run.delta, run.timescale)
        const kfIdx = run.kf + run.fragments
        run.fragments++
        const segNo = s.segOfKf[kfIdx]
        if (segNo === undefined) { run.moof = null; return } // past the last key frame we know: nothing to cut
        // sanity: the fragment must start about where the key frame index says (the reorder delay is well under a second)
        const vid = s.initInfo.tracks.find((t) => t.handler === 'vide')
        if (vid && starts[vid.id] !== undefined && Math.abs(starts[vid.id] - s.keyframes[kfIdx]) > 1.5) {
          s.error = `key frame index does not match the file (fragment ${kfIdx}: ${starts[vid.id].toFixed(2)} s vs ${s.keyframes[kfIdx].toFixed(2)} s)`
          stopProc(s, 'error')
          log(`remux ${s.key}: ${s.error}`)
          return
        }
        if (segNo !== run.cur) {
          if (run.cur >= 0 && run.count === s.segments[run.cur].kfEnd - s.segments[run.cur].kfStart) writePiece(s, run.cur, run.bufs)
          run.cur = segNo; run.bufs = []; run.count = 0
        }
        run.bufs.push(run.moof, buf)
        run.count++
        run.moof = null
        if (run.count === s.segments[run.cur].kfEnd - s.segments[run.cur].kfStart) {
          writePiece(s, run.cur, run.bufs)
          run.cur = -1; run.bufs = []; run.count = 0
          updateReady(s)
          s.lastProgressAt = now()
        }
      }
    }
    const reader = createBoxReader(onBox)
    if (child.stdout) {
      child.stdout.on('data', (d) => { try { reader.push(d) } catch (e) { s.error = `unreadable output from ffmpeg: ${e.message}`; stopProc(s, 'error') } })
    }
    let finished = false
    const finish = (code) => {
      if (finished) return
      finished = true
      if (s.generation !== gen || child.killedByUs) return
      s.proc = null
      updateReady(s)
      if (code === 0) { s.completed = true; return }
      s.error = `ffmpeg stopped (${code})${tail ? ': ' + tail.trim().split(/\r?\n/).pop() : ''}`
      log(`remux ${s.key} failed: ${s.error}`)
    }
    child.on('error', (e) => { if (finished || s.generation !== gen) return; finished = true; s.proc = null; s.error = String((e && e.message) || e) })
    child.on('close', (code) => finish(code))
    log(`remux ${s.key}: copying from piece ${segIndex} (${s.rx && s.rx.ac === 'copy' ? 'audio copied' : 'audio converted'}${s.rx && s.rx.s ? ', Dolby Vision layer removed' : ''})`)
  }

  function prune(s, n) {
    let names = []
    try { names = fs.readdirSync(s.dir) } catch { return }
    for (const name of names) {
      const m = /^seg-(\d+)\.m4s$/.exec(name)
      if (m && Number(m[1]) < n - keepBehindSegments) { try { fs.unlinkSync(path.join(s.dir, name)) } catch { /* in use */ } }
    }
  }

  function maintain(s, n) {
    s.lastAccess = now()
    updateReady(s)
    if (s.proc && s.readyUpTo - n > maxAheadSegments) stopProc(s, 'far ahead')
    else if (!s.proc && !s.completed && !s.error && s.readyUpTo < s.segments.length - 1 && s.readyUpTo >= n - 1 && n >= s.readyUpTo - resumeWithinSegments) {
      startRun(s, s.readyUpTo + 1)
    }
    prune(s, n)
  }

  /**
   * Open (or find) the session for a ticket. `keyframes` must be ready (keyframeIndex.wait).
   * Throws { code: 'busy' } when too many remux sessions of other viewers run.
   */
  function open({ key, owner, fileKey, filePath, tracks, keyframes, rx, audioEncoders = null }) {
    const existing = sessions.get(key)
    if (existing) { existing.lastAccess = now(); return existing }
    for (const s of [...sessions.values()]) if (s.owner === owner && (s.fileKey === fileKey || now() - s.lastAccess > 15000)) closeSession(s, 'replaced')
    if (sessions.size >= maxOf()) {
      const idle = [...sessions.values()].filter((s) => now() - s.lastAccess > 30000).sort((a, b) => a.lastAccess - b.lastAccess)
      while (sessions.size >= maxOf() && idle.length) closeSession(idle.shift(), 'idle')
    }
    if (sessions.size >= maxOf()) { const e = new Error('The server is busy repackaging video for other viewers.'); e.code = 'busy'; throw e }
    const segments = planSegments(keyframes, tracks.durationSec, targetSegmentSec)
    if (!segments.length) throw new Error('no_segments')
    const segOfKf = []
    for (const g of segments) for (let k = g.kfStart; k < g.kfEnd; k++) segOfKf[k] = g.index
    const s = {
      key, owner, fileKey, filePath, tracks, keyframes, rx: rx || {}, audioEncoders, segments, segOfKf,
      dir: path.join(tmpRoot, key), init: null, initInfo: null, proc: null, generation: 0, runStart: 0, readyUpTo: -1,
      completed: false, error: null, runs: 0, createdAt: now(), lastAccess: now(), lastProgressAt: now(), closed: false
    }
    sessions.set(key, s)
    return s
  }

  const playlist = (s) => { s.lastAccess = now(); return buildMediaPlaylist(s.segments) }

  async function waitFor(s, cond, what) {
    const deadline = now() + waitTimeoutMs
    for (;;) {
      if (s.closed) return false
      if (cond()) return true
      if (!s.proc && s.error) throw new Error(s.error)
      if (now() > deadline) throw new Error(`timed out waiting for ${what}`)
      await sleep(pollMs)
    }
  }

  /** The init segment (ftyp + moov): the first run's, made by starting at piece 0 when nothing has run yet. */
  async function initSegment(s) {
    s.lastAccess = now()
    if (s.init) return s.init
    if (!s.proc) { s.error = null; startRun(s, 0) }
    await waitFor(s, () => !!s.init, 'the first bytes from ffmpeg')
    return s.init
  }

  async function segment(s, n) {
    n = Number(n)
    if (s.closed || !Number.isInteger(n) || n < 0 || n >= s.segments.length) return null
    s.lastAccess = now()
    const file = segFile(s, n)
    if (fs.existsSync(file)) { maintain(s, n); return file }
    updateReady(s)
    const covered = s.proc && n >= s.runStart && n <= s.readyUpTo + 1 + seekGapSegments
    if (!covered) {
      if (!s.init) await initSegment(s) // the first run also makes the init the later runs are measured against
      if (!fs.existsSync(file) && !(s.proc && n >= s.runStart && n <= s.readyUpTo + 1 + seekGapSegments)) { s.error = null; startRun(s, n) }
    }
    const deadline = now() + waitTimeoutMs
    for (;;) {
      if (s.closed) return null
      if (fs.existsSync(file)) { maintain(s, n); return file }
      updateReady(s)
      if (!s.proc) {
        if (s.error) throw new Error(s.error)
        if (s.completed) return null
        if (!(n >= s.runStart)) return null
        startRun(s, n)
      }
      if (now() > deadline) throw new Error('timed out waiting for the repackaged piece')
      await sleep(pollMs)
    }
  }

  function sweep() {
    for (const s of [...sessions.values()]) if (now() - s.lastAccess > idleMs) closeSession(s, 'idle')
  }
  const timer = sweepEveryMs > 0 ? setInterval(sweep, sweepEveryMs) : null
  if (timer && timer.unref) timer.unref()

  return {
    open, playlist, initSegment, segment, sweep,
    get: (key) => sessions.get(key) || null,
    close: (key) => { const s = sessions.get(key); if (s) closeSession(s, 'stopped') },
    closeOwner: (owner) => { for (const s of [...sessions.values()]) if (s.owner === owner) closeSession(s, 'stopped') },
    closeAll: () => { if (timer) clearInterval(timer); for (const s of [...sessions.values()]) closeSession(s, 'shutdown') },
    size: () => sessions.size,
    load: () => ({ active: sessions.size, running: [...sessions.values()].filter((s) => s.proc).length, max: maxOf() }),
    list: () => [...sessions.values()].map((s) => ({ key: s.key, owner: s.owner, running: !!s.proc, runStart: s.runStart, readyUpTo: s.readyUpTo, runs: s.runs, error: s.error, file: path.basename(String(s.filePath || '')) }))
  }
}

module.exports = {
  TARGET_SEGMENT_SEC,
  MOVFLAGS,
  keyframeProbeArgs,
  parseKeyframeCsv,
  planSegments,
  buildMediaPlaylist,
  buildMasterPlaylist,
  videoCodecString,
  supplementalCodec,
  audioCodecString,
  videoRangeOf,
  buildRemuxArgs,
  createBoxReader,
  boxChildren,
  readInitInfo,
  normaliseFragment,
  createKeyframeIndex,
  createRemuxManager
}
