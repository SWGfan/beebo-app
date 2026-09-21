'use strict'
// ============================================================================
// hlsTranscoder.js - live "play at a lower quality" for phones, TVs and browsers.
// ----------------------------------------------------------------------------
// Plex-style: the viewer picks 1080p / 720p / 480p (or Auto picks for them) and
// this computer converts the film WHILE it plays, into HLS - a playlist plus
// short numbered .ts pieces that are ordinary HTTP requests, so they travel over
// the home network, the away-from-home tunnel and Beebo Relay alike.
//
// How it fits together:
//   * The playlist is written up front for the WHOLE film (VOD, fixed 4 s pieces),
//     so every player shows the real length and can seek anywhere.
//   * ffmpeg only makes the pieces around where the viewer is. A request for a
//     piece far from what ffmpeg is making restarts ffmpeg right there (that is
//     the seek). Key frames are forced on every piece boundary and each run is
//     offset to its real position, so pieces from different runs line up.
//   * ffmpeg that has raced far ahead of the viewer is stopped and started again
//     when the viewer catches up - no disk full of a whole film, no CPU burnt.
//   * Pieces the viewer has passed are deleted; a session nobody has asked for
//     in a while is closed and its folder removed.
//   * At most N conversions at once (default: 1 on a weak PC, 2 normally, +1 with a graphics
//     encoder; the owner can change it). Viewers over the limit wait in an ETA-less queue
//     (admit() below) instead of being turned away.
//   * Hardware encoders first (NVIDIA, Intel, AMD, Apple, VAAPI), then libx264 if the owner's own
//     ffmpeg has it, then the LGPL OpenH264 encoder the bundled ffmpeg ships with. Each is proved
//     by a real one-second test encode, because ffmpeg lists NVENC even with no NVIDIA card
//     (encoderCapabilities.js owns the probe, the cache, the owner's override and the old-PC profile).
//   * NEVER a dead player: a session walks a ladder of (encoder, HDR tone-map method) steps. When
//     the step in use dies, or a hardware encoder makes no piece for too long while someone waits,
//     the SAME session restarts where it stopped on the next step, logging one redacted line.
//   * The URL carries a signed ticket (the same secret as the media token) naming
//     the file, quality, audio track and any burnt-in subtitle - that ticket is
//     the only credential a playlist or piece needs (the sound choices - 5.1, mix-down, night mode, delay -
//     ride in it too, see hlsAudio.js, so each is its own session), so Cast receivers and the
//     tunnel can fetch them with no login. A session that was cleaned up is simply
//     rebuilt from the ticket on the next request.
// ============================================================================

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { spawn } = require('child_process')
const hlsAudio = require('./hlsAudio')
const chainLib = require('./hlsVideoChain')
const caps = require('./encoderCapabilities')
const ffmpegArgs = require('./ffmpegArgs') // file: prefix + -protocol_whitelist for every library input

const SEGMENT_SECONDS = 4

const QUALITIES = {
  '1080p': { id: '1080p', label: '1080p', width: 1920, height: 1080, videoKbps: 8000, audioKbps: 192 },
  '720p': { id: '720p', label: '720p', width: 1280, height: 720, videoKbps: 4000, audioKbps: 160 },
  '480p': { id: '480p', label: '480p', width: 854, height: 480, videoKbps: 1500, audioKbps: 128 }
}
const QUALITY_ORDER = ['1080p', '720p', '480p']

// macOS has none of the PC graphics-card encoders; Apple's VideoToolbox (hardware, in the Mac ffmpeg
// build - see THIRD_PARTY_LICENSES/FFMPEG-SETUP.md) comes first there. Every other platform keeps
// the original list, so nothing changes for Windows or Linux.
function encoderCandidatesFor(platform) {
  return platform === 'darwin'
    ? ['h264_videotoolbox', 'libx264', 'libopenh264']
    : ['h264_nvenc', 'h264_qsv', 'h264_amf', 'libx264', 'libopenh264']
}
const ENCODER_CANDIDATES = encoderCandidatesFor(process.platform)
const ENCODER_WORDS = {
  h264_nvenc: 'NVIDIA graphics card',
  h264_qsv: 'Intel Quick Sync',
  h264_amf: 'AMD graphics card',
  h264_videotoolbox: 'Apple hardware encoder (VideoToolbox)',
  h264_vaapi: 'graphics card (VAAPI)',
  libx264: 'processor (x264)',
  libopenh264: 'processor (OpenH264)'
}

// ------------------------------------------------------------ pure helpers
const even = (n) => Math.max(2, Math.round(n / 2) * 2)

/** The output size for a source squeezed into a quality's box, never enlarged. */
function outputSize(srcWidth, srcHeight, quality) {
  const q = QUALITIES[quality]
  if (!q) return null
  const w = Number(srcWidth) || 0
  const h = Number(srcHeight) || 0
  if (!w || !h) return { width: -2, height: q.height }
  const factor = Math.min(1, q.width / w, q.height / h)
  return { width: even(w * factor), height: even(h * factor) }
}

/** Qualities worth offering for a source: anything up to one step above its own height. */
function qualitiesFor(video) {
  const h = video && Number(video.height)
  return QUALITY_ORDER.map((id) => {
    const q = QUALITIES[id]
    const size = video ? outputSize(video.width, video.height, id) : null
    return {
      id,
      label: q.label,
      videoKbps: q.videoKbps,
      audioKbps: q.audioKbps,
      height: size && size.height > 0 ? size.height : q.height,
      // A 720p file converted "at 1080p" is just a 720p file at a higher bitrate.
      upscale: !!h && q.height > h * 1.1
    }
  })
}

function segmentCount(durationSec, segSec = SEGMENT_SECONDS) {
  const d = Number(durationSec) || 0
  if (d <= 0) return 0
  let count = Math.max(1, Math.ceil(d / segSec - 1e-6))
  // A sliver of a last piece (a film 24.02 s long) is folded into the one before it: ffmpeg only
  // cuts on a key frame, and a piece it never makes would stop the player just short of the end.
  if (count > 1 && d - segSec * (count - 1) < 0.5) count--
  return count
}

function segmentName(n) { return `seg-${n}.ts` }

/** The whole-film VOD playlist. Piece names are relative, so they resolve under the ticket path. */
function buildVodPlaylist(durationSec, segSec = SEGMENT_SECONDS) {
  const count = segmentCount(durationSec, segSec)
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${Math.ceil(segSec + 0.5)}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-INDEPENDENT-SEGMENTS'
  ]
  for (let i = 0; i < count; i++) {
    const len = i === count - 1 ? Math.max(0.001, durationSec - segSec * i) : segSec
    lines.push(`#EXTINF:${len.toFixed(6)},`)
    lines.push(segmentName(i))
  }
  lines.push('#EXT-X-ENDLIST')
  return lines.join('\n') + '\n'
}

/**
 * The encoder half of the ffmpeg command. `opts.profile` (encoderCapabilities.performanceProfile)
 * tunes the SOFTWARE encoders for an old PC: fastest x264 preset, fewer threads, OpenH264's cheap
 * mode. Without a profile the arguments are exactly the long-standing defaults.
 */
function encoderArgs(encoder, q, opts = {}) {
  const profile = (opts && opts.profile) || null
  const rate = [
    '-b:v', `${q.videoKbps}k`,
    '-maxrate', `${Math.round(q.videoKbps * 1.5)}k`,
    '-bufsize', `${q.videoKbps * 2}k`
  ]
  switch (encoder) {
    case 'h264_nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-profile:v', 'high', '-rc', 'vbr', '-forced-idr', '1', ...rate]
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-profile:v', 'high', '-forced_idr', '1', ...rate]
    case 'h264_amf':
      return ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'vbr_peak', '-profile:v', 'high', ...rate]
    case 'h264_videotoolbox':
      // allow_sw: a Mac (or VM) without the hardware encoder still converts, in software.
      return ['-c:v', 'h264_videotoolbox', '-profile:v', 'high', '-allow_sw', '1', ...rate]
    case 'h264_vaapi':
      // Frames arrive already uploaded to the graphics card (see hlsVideoChain.videoFilterPlan).
      return ['-c:v', 'h264_vaapi', '-profile:v', 'high', ...rate]
    case 'libopenh264':
      return ['-c:v', 'libopenh264', '-allow_skip_frames', '0', ...(profile && profile.openh264Cheap ? ['-loopfilter', '0', '-coder', 'cavlc'] : []), ...rate]
    case 'libx264':
    default:
      return ['-c:v', 'libx264', '-preset', (profile && profile.x264Preset) || 'veryfast', '-profile:v', 'high', '-level:v', '4.1', '-sc_threshold', '0', ...rate]
  }
}

function pickAudioTrack(tracks, audioStreamIndex = null) {
  const audios = (tracks && tracks.audio) || []
  const chosen = audioStreamIndex != null ? audios.find((a) => a.streamIndex === Number(audioStreamIndex)) : null
  return chosen || audios.find((a) => a.isDefault) || audios[0] || null
}

/** The audio decision for a session (copy / 5.1 / mix-down and its filters); see hlsAudio.planAudio. */
function audioPlanFor({ tracks, quality, audioStreamIndex = null, audio = null, audioEncoders = null }) {
  return hlsAudio.planAudio({ track: pickAudioTrack(tracks, audioStreamIndex), au: audio, quality: QUALITIES[quality], qualityId: quality, encoders: audioEncoders })
}

/**
 * The ffmpeg command for one run of one session.
 *   input            the original file
 *   tracks           playbackTracks.parseTracks output (video size, fps, audio/subtitle streams)
 *   quality          '1080p' | '720p' | '480p'
 *   encoder          an H.264 encoder id (see encoderCapabilities.ENCODERS)
 *   audioStreamIndex absolute ffprobe stream index, or null for the first/default audio
 *   burnSubtitleStreamIndex absolute stream index of an IMAGE subtitle to burn in, or null
 *   audio            the ticket's audio object (hlsAudio.ticketAudio); null = stereo AAC, standard mix-down
 *   audioEncoders    { aac, ac3, eac3 }: what this ffmpeg can encode (default: AAC only)
 *   startNumber      first piece this run makes (the seek point is startNumber * segSec)
 *   tonemap          HDR->SDR method for an HDR source: a method id ('zscale' | 'libplacebo' |
 *                    'tonemap_opencl' | 'tonemap_vaapi'), true (= 'zscale'), or falsy (none)
 *   profile          performanceProfile() for the old-PC settings (threads, preset, scaler); optional
 *   device           VAAPI render node for h264_vaapi
 */
function buildTranscodeArgs({ input, tracks, quality, encoder, audioStreamIndex = null, burnSubtitleStreamIndex = null, startNumber = 0, segmentSeconds = SEGMENT_SECONDS, outDir, tonemap = false, audio = null, audioEncoders = null, profile = null, device = '' }) {
  const q = QUALITIES[quality]
  if (!q) throw new Error(`unknown quality ${quality}`)
  const video = tracks && tracks.video
  const startSec = Math.max(0, Number(startNumber) || 0) * segmentSeconds

  // --- video chain (the picture is made small first, then tone-mapped; see hlsVideoChain.js) ---
  const size = outputSize(video && video.width, video && video.height, quality)
  const method = tonemap === true ? 'zscale' : (typeof tonemap === 'string' && tonemap ? tonemap : null)
  const plan = chainLib.videoFilterPlan({
    encoder, size, tonemap: video && video.hdr ? method : null, device, scaleFlags: (profile && profile.scaleFlags) || ''
  })
  const args = ['-hide_banner', '-nostdin', '-v', 'error', '-y']
  if (profile && profile.filterThreads) args.push('-filter_threads', String(profile.filterThreads))
  args.push(...plan.initArgs)
  if (startSec > 0) args.push('-ss', startSec.toFixed(3))
  args.push(...ffmpegArgs.inputArgs(input)) // file: prefix + protocol whitelist (review F9)
  const chain = plan.chain
  const videoSel = video && video.streamIndex != null ? `0:${video.streamIndex}` : '0:v:0'
  const burn = burnSubtitleStreamIndex != null && Number.isFinite(Number(burnSubtitleStreamIndex))
  if (burn) {
    // Picture subtitles are drawn on a canvas that may be taller than a cropped film; lining the
    // canvas's bottom up with the picture's keeps the words on screen either way.
    args.push('-filter_complex',
      `[${videoSel}][0:${Number(burnSubtitleStreamIndex)}]overlay=x=(main_w-overlay_w)/2:y=main_h-overlay_h:eof_action=pass,${chain.join(',')}[vout]`)
    args.push('-map', '[vout]')
  } else {
    args.push('-map', videoSel, '-vf', chain.join(','))
  }

  // --- audio ---
  const audioTrack = pickAudioTrack(tracks, audioStreamIndex)
  if (audioTrack && audioTrack.streamIndex != null) args.push('-map', `0:${audioTrack.streamIndex}`)

  args.push('-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1')
  args.push(...encoderArgs(encoder, q, { profile }))
  // A weak PC keeps a core or two free: the software encoder's threads are capped (graphics
  // hardware does its own work, so it is left alone).
  if (profile && profile.threads && !caps.isHardware(encoder)) args.push('-threads', String(profile.threads))
  const gop = Math.max(1, Math.round((video && video.fps ? video.fps : 25) * segmentSeconds))
  args.push('-g', String(gop), '-force_key_frames', `expr:gte(t,n_forced*${segmentSeconds})`)
  args.push(...hlsAudio.planAudio({ track: audioTrack, au: audio, quality: q, qualityId: quality, encoders: audioEncoders }).args)

  // Each run's clock starts at its own seek point, so the pieces carry their real place in the film.
  if (startSec > 0) args.push('-output_ts_offset', startSec.toFixed(3))
  args.push(
    '-f', 'hls',
    '-hls_time', String(segmentSeconds),
    '-hls_segment_type', 'mpegts',
    '-hls_list_size', '0',
    '-hls_flags', 'temp_file+independent_segments',
    '-start_number', String(Math.max(0, Number(startNumber) || 0)),
    '-hls_segment_filename', path.join(outDir, 'seg-%d.ts'),
    path.join(outDir, 'ffmpeg.m3u8')
  )
  return args
}

// ---------------------------------------------------------------- tickets
// A ticket is "<payload>.<exp>.<sig>": payload is base64url JSON, and <exp>.<sig> is a media token
// (streamServer.makeMediaToken) over "hls|<payload>". Path-safe, so it lives in the URL path and
// relative piece names in the playlist inherit it.
function makeTicket(sign, fields) {
  const payload = Buffer.from(JSON.stringify({ v: 1, ...fields }), 'utf8').toString('base64url')
  return `${payload}.${sign('hls|' + payload)}`
}
function readTicket(verify, ticket) {
  const t = String(ticket || '')
  if (t.length > 2048) return null
  const dot = t.indexOf('.')
  if (dot < 1) return null
  const payload = t.slice(0, dot)
  const token = t.slice(dot + 1)
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) return null
  if (!verify('hls|' + payload, token)) return null
  try {
    const fields = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (!fields || fields.v !== 1) return null
    return { fields, sessionKey: crypto.createHash('sha1').update(payload).digest('hex').slice(0, 20) }
  } catch { return null }
}

// ---------------------------------------------------------- encoder probe
const testEncodeArgs = caps.testEncodeArgs

/**
 * The simple "which encoders work" question, answered by encoderCapabilities.probeCapabilities:
 * every candidate is listed by `ffmpeg -encoders` and then proved by a real one-second test encode.
 * Resolves { encoder, label, hardware, tonemap, chain, tried: [{encoder, ok, reason}], audio } where
 * `encoder` is the first working candidate and `chain` is every working one, in order - so a
 * caller (live TV) can fall back down it. { encoder: null } without ffmpeg or when none works.
 * (The app itself uses encoderCapabilities.createEncoderService, which also caches the result,
 * proves the HDR tone-map methods and applies the owner's choice.)
 */
async function probeEncoders({ ffmpegPath, run, candidates = ENCODER_CANDIDATES, timeoutMs = 20000, proveTonemap = false } = {}) {
  if (!ffmpegPath) return { encoder: null, label: '', hardware: false, tonemap: false, tonemapMethods: [], chain: [], devices: {}, tried: [], audio: { aac: false, ac3: false, eac3: false } }
  const c = await caps.probeCapabilities({ ffmpegPath, run, candidates, timeoutMs, ignorePlatform: true, proveTonemap })
  const good = c.encoders.filter((e) => e.ok)
  const first = good[0] || null
  const devices = {}
  for (const e of good) if (e.device) devices[e.id] = e.device
  return {
    encoder: first ? first.id : null,
    label: first ? (ENCODER_WORDS[first.id] || first.id) : '',
    hardware: !!(first && first.hardware),
    tonemap: c.tonemap.working.length > 0,
    tonemapMethods: c.tonemap.working.slice(),
    chain: good.map((e) => e.id),
    devices,
    tried: c.encoders.map((e) => ({ encoder: e.id, ok: e.ok, reason: e.reason })),
    audio: c.audio
  }
}

/**
 * Which of ffmpeg's own (LGPL) audio encoders this build lists. AAC, Dolby Digital and Dolby
 * Digital Plus are built into libavcodec, so the list alone is proof enough; libfdk_aac is never used.
 */
const audioEncodersFrom = caps.audioEncodersFrom

/// ------------------------------------------------------- session manager
class BusyError extends Error {
  constructor(max, position = 0) {
    super(`The server is busy right now: ${max} video${max === 1 ? ' is' : 's are'} already being converted for other viewers.${position > 0 ? ` You are number ${position} in line.` : ''}`)
    this.code = 'busy'
    this.position = position
  }
}

/** Below-normal priority for an ffmpeg child so a long conversion never starves the desktop or the server. */
function defaultSetPriority(pid) {
  if (!(pid > 0)) return
  try { os.setPriority(pid, os.constants.priority.PRIORITY_BELOW_NORMAL) } catch { /* not every platform lets us */ }
}

/**
 * The ladder of steps one session walks: for every encoder in the chain, one step per usable HDR
 * tone-map method (GPU methods first), and - for an HDR film - a last step with no tone-map at all
 * (dull colours beat a dead player).
 */
function buildLadder(chain, hdr, methods) {
  const ladder = []
  for (const id of chain) {
    if (!hdr) { ladder.push({ encoder: id, tonemap: null }); continue }
    const usable = chainLib.methodsForEncoder(methods, id)
    for (const m of usable) ladder.push({ encoder: id, tonemap: m })
    if (!usable.length) ladder.push({ encoder: id, tonemap: null })
  }
  const last = ladder[ladder.length - 1]
  if (hdr && last && last.tonemap) ladder.push({ encoder: last.encoder, tonemap: null })
  return ladder
}

function createTranscodeManager({
  ffmpegPath,
  tmpRoot = path.join(os.tmpdir(), 'beebo-hls'),
  maxConcurrent = 2,
  idleMs = 3 * 60 * 1000,
  segmentSeconds = SEGMENT_SECONDS,
  maxAheadSegments = 45,
  resumeWithinSegments = 15,
  keepBehindSegments = 6,
  seekGapSegments = 4,
  waitTimeoutMs = 60000,
  pollMs = 100,
  spawnFn = spawn,
  now = Date.now,
  log = () => {},
  sweepEveryMs = 15000,
  // Old-PC settings (encoderCapabilities.performanceProfile), or a function returning them.
  profile = null,
  // A graphics encoder that makes no piece for this long while a viewer is waiting is given up on.
  hwStallMs = 10000,
  // Told when an encoder dies during a conversion / delivers its first piece (encoderService.noteFailure/noteSuccess).
  onEncoderFailure = null,
  onEncoderSuccess = null,
  setPriority = defaultSetPriority,
  // The waiting line: a viewer who has not asked again for this long has left; a place held for a
  // viewer who was admitted lasts this long before someone else may use it.
  queueTtlMs = 30000,
  reserveMs = 30000,
  // After every step of the ladder failed, the next request may start the ladder again after this long.
  exhaustedRetryMs = 30000
} = {}) {
  const sessions = new Map()
  const reservations = new Map() // "owner|fileKey" -> expiry: a slot promised to an admitted viewer
  const queue = [] // [{ key, owner, fileKey, since, lastPoll }] first come, first served, no time estimates
  let totalFallbacks = 0
  const resolveFfmpeg = () => (typeof ffmpegPath === 'function' ? ffmpegPath() : ffmpegPath)
  const maxOf = () => Math.max(1, Number(typeof maxConcurrent === 'function' ? maxConcurrent() : maxConcurrent) || 2)
  const profileNow = () => { try { return typeof profile === 'function' ? profile() : profile } catch { return null } }
  const report = (fn, ...a) => { if (typeof fn === 'function') { try { fn(...a) } catch { /* advisory only */ } } }
  const wordOf = (id) => ENCODER_WORDS[id] || id

  // Anything left by a previous run of the app is garbage now.
  try { fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) } catch {}

  function segPath(s, n) { return path.join(s.dir, segmentName(n)) }

  function updateReady(s) {
    const before = s.readyUpTo
    while (s.readyUpTo + 1 <= s.lastIndex && fs.existsSync(segPath(s, s.readyUpTo + 1))) s.readyUpTo++
    if (s.readyUpTo > before) {
      s.lastProgressAt = now()
      // The first piece of a run proves the encoder works for real: forgive earlier failures.
      if (!s.okReported && s.readyUpTo >= s.runStart) {
        s.okReported = true
        const att = s.ladder[s.attemptIdx]
        if (att) report(onEncoderSuccess, att.encoder)
      }
    }
  }

  function stopProc(s, reason) {
    const p = s.proc
    if (!p) return
    s.proc = null
    p.killedByUs = reason || 'stopped'
    try { p.kill('SIGKILL') } catch {}
  }

  /** The step to move to after a failure (-1 = none left). A dead encoder skips its other steps. */
  function nextAttempt(s, kind) {
    const cur = s.ladder[s.attemptIdx]
    let i = s.attemptIdx + 1
    if (kind === 'encoder') while (i < s.ladder.length && s.ladder[i].encoder === cur.encoder) i++
    return i < s.ladder.length ? i : -1
  }

  function startRun(s, startNumber) {
    stopProc(s, 'restart')
    const exe = resolveFfmpeg()
    if (!exe) throw new Error('ffmpeg is not installed')
    const gen = ++s.generation
    s.runStart = startNumber
    s.readyUpTo = startNumber - 1
    s.completed = false
    s.error = null
    s.lastProgressAt = now()
    s.okReported = false
    const att = s.ladder[s.attemptIdx]
    s.encoder = att.encoder
    s.tonemapMethod = att.tonemap
    try { fs.mkdirSync(s.dir, { recursive: true }) } catch {}
    const args = buildTranscodeArgs({
      input: s.filePath, tracks: s.tracks, quality: s.quality, encoder: att.encoder, tonemap: att.tonemap,
      audioStreamIndex: s.audioStreamIndex, burnSubtitleStreamIndex: s.burnSubtitleStreamIndex,
      audio: s.audio, audioEncoders: s.audioEncoders,
      startNumber, segmentSeconds, outDir: s.dir, profile: profileNow(), device: s.devices[att.encoder] || ''
    })
    let child
    try {
      child = spawnFn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    } catch (e) {
      s.error = String(e && e.message || e)
      return
    }
    try { setPriority(child.pid) } catch {}
    s.proc = child
    s.runs++
    let tail = ''
    let finished = false
    let grace = null
    if (child.stderr) child.stderr.on('data', (d) => { tail = (tail + String(d)).slice(-800) })
    // ffmpeg's exit can arrive a moment before its last words on stderr: wait briefly for 'close'.
    const finish = (code) => {
      if (finished) return
      finished = true
      if (grace) clearTimeout(grace)
      if (s.generation !== gen || child.killedByUs) return
      s.proc = null
      if (code === 0) { s.completed = true; return }
      runFailed(s, gen, `ffmpeg stopped (${code})`, tail)
    }
    child.on('error', (e) => {
      if (finished || s.generation !== gen) return
      finished = true
      s.proc = null
      runFailed(s, gen, String(e && e.message || e), '', 'fatal')
    })
    child.on('exit', (code) => { if (!finished) { grace = setTimeout(() => finish(code), 50); if (grace.unref) grace.unref() } })
    child.on('close', (code) => finish(code))
    log(`transcode ${s.key}: ${s.quality} with ${att.encoder}${att.tonemap ? ' + ' + att.tonemap : ''} from piece ${startNumber}`)
  }

  /**
   * A run died (or stalled). If a later step of the ladder can take over, the SAME session restarts
   * there, where it stopped - one redacted log line, nothing the viewer has to do. Only when every
   * step has failed does the session report an error.
   */
  function runFailed(s, gen, headline, tail, forcedKind = '') {
    if (s.generation !== gen || s.closed) return
    updateReady(s)
    const failed = s.ladder[s.attemptIdx]
    const why = caps.redactReason(tail)
    const kind = forcedKind || caps.classifyRunFailure(tail)
    // A blameless failure (unreadable file, ffmpeg missing) must not turn people off their graphics card.
    if (kind !== 'input' && kind !== 'fatal' && kind !== 'filter') report(onEncoderFailure, failed.encoder, why || headline)
    const next = kind === 'input' || kind === 'fatal' ? -1 : nextAttempt(s, kind)
    if (next < 0) {
      s.error = `${headline}${why ? ': ' + why : ''}`
      s.exhaustedAt = now()
      log(`transcode ${s.key} failed: ${s.error}`)
      return
    }
    const to = s.ladder[next]
    s.attemptIdx = next
    s.fallbacks++
    totalFallbacks++
    log(`transcode ${s.key}: ${wordOf(failed.encoder)}${failed.tonemap ? ' + ' + failed.tonemap : ''} stopped (${why || headline}) - continuing with ${wordOf(to.encoder)}${to.tonemap ? ' + ' + to.tonemap : ''}`)
    try {
      startRun(s, Math.max(s.runStart, s.readyUpTo + 1))
    } catch (e) {
      s.error = String(e && e.message || e)
    }
  }

  /** A graphics encoder that has made nothing for a while, with someone waiting and another step to go to. */
  function stalled(s, waitStart) {
    const att = s.ladder[s.attemptIdx]
    if (!att || !caps.isHardware(att.encoder) || nextAttempt(s, 'encoder') < 0) return false
    // A 4K source, or a weak PC, needs longer just to decode the first piece: that is not a stuck encoder.
    const height = Number(s.tracks && s.tracks.video && s.tracks.video.height) || 0
    const p = profileNow()
    const window = hwStallMs * (height > 1200 ? 2 : 1) * (p && p.tier === 'low' ? 1.5 : 1)
    return now() - Math.max(s.lastProgressAt, waitStart) > window
  }

  function prune(s, n) {
    let names = []
    try { names = fs.readdirSync(s.dir) } catch { return }
    for (const name of names) {
      const m = /^seg-(\d+)\.ts$/.exec(name)
      if (!m) continue
      const i = Number(m[1])
      if (i < n - keepBehindSegments) { try { fs.unlinkSync(path.join(s.dir, name)) } catch {} }
    }
  }

  function closeSession(s, why) {
    if (!sessions.has(s.key)) return
    sessions.delete(s.key)
    s.closed = true
    stopProc(s, why || 'closed')
    const dir = s.dir
    // Windows keeps a file locked for a moment after its process is killed.
    const rm = (left) => {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch {
        if (left > 0) { const t = setTimeout(() => rm(left - 1), 500); if (t.unref) t.unref() }
      }
    }
    rm(6)
  }

  // ---------------------------------------------------- slots and the waiting line
  const RECENT_MS = 30000
  const pruneLine = () => {
    const t = now()
    for (const [k, until] of [...reservations]) if (until <= t) reservations.delete(k)
    for (let i = queue.length - 1; i >= 0; i--) if (t - queue[i].lastPoll > queueTtlMs) queue.splice(i, 1)
  }
  /** Conversions that count against the limit for this viewer (their own old ones make way; idle ones do not count). */
  const othersCount = (owner, fileKey) => [...sessions.values()].filter((s) => now() - s.lastAccess <= RECENT_MS &&
    !(s.owner === owner && (s.fileKey === fileKey || now() - s.lastAccess > 15000))).length
  const reservedExcept = (rkey) => [...reservations.keys()].filter((k) => k !== rkey).length

  /**
   * Ask for a place before opening a conversion. Resolves { ok: true } (a slot is held for this viewer
   * for a short while) or { ok: false, position, waiting } - the viewer is in the line, first come first
   * served, with no time estimate. Asking again keeps the place; not asking for a while gives it up.
   */
  function admit(owner, fileKey) {
    pruneLine()
    const rkey = `${owner}|${fileKey}`
    if (reservations.has(rkey)) { reservations.set(rkey, now() + reserveMs); return { ok: true } }
    const free = maxOf() - othersCount(owner, fileKey) - reservedExcept(rkey)
    let idx = queue.findIndex((q) => q.key === rkey)
    // Someone switching quality/audio on what they are already watching gives up their own slot
    // for the new one: they do not queue behind people who were waiting for a different slot.
    const holdsOwn = [...sessions.values()].some((s) => s.owner === owner && s.fileKey === fileKey)
    const ahead = holdsOwn ? 0 : idx >= 0 ? idx : queue.length
    if (free > ahead) {
      if (idx >= 0) queue.splice(idx, 1)
      reservations.set(rkey, now() + reserveMs)
      return { ok: true }
    }
    if (idx < 0) { queue.push({ key: rkey, owner, fileKey, since: now(), lastPoll: now() }); idx = queue.length - 1 }
    else queue[idx].lastPoll = now()
    return { ok: false, position: idx + 1, waiting: queue.length }
  }

  /**
   * Open (or find) the session for a ticket. Synchronous: the caller has already probed the file
   * and knows the encoders. Throws BusyError when every slot is in use by someone else.
   *   encoder / chain   the encoder to start on / every encoder to fall back down, in order
   *   tonemapMethods    the HDR->SDR methods proven to work here (or tonemap: true = 'zscale')
   *   devices           { encoderId: device } (VAAPI render node)
   */
  function open({ key, owner, fileKey, filePath, tracks, quality, encoder, chain = null, devices = null, tonemap, tonemapMethods = null, audioStreamIndex = null, burnSubtitleStreamIndex = null, audio = null, audioEncoders = null }) {
    const existing = sessions.get(key)
    if (existing) { existing.lastAccess = now(); reservations.delete(`${owner}|${fileKey}`); return existing }
    if (!QUALITIES[quality]) throw new Error(`unknown quality ${quality}`)
    const lastIndex = segmentCount(tracks && tracks.durationSec, segmentSeconds) - 1
    if (lastIndex < 0) throw new Error('unknown_duration')

    // The same viewer changing quality/audio on the same title, or who moved on from a title they
    // stopped asking for: their old conversion goes first.
    for (const s of [...sessions.values()]) {
      if (s.owner === owner && (s.fileKey === fileKey || now() - s.lastAccess > 15000)) closeSession(s, 'replaced')
    }
    pruneLine()
    const rkey = `${owner}|${fileKey}`
    const used = () => sessions.size + reservedExcept(rkey)
    if (used() >= maxOf()) {
      const idle = [...sessions.values()].filter((s) => now() - s.lastAccess > 30000).sort((a, b) => a.lastAccess - b.lastAccess)
      while (used() >= maxOf() && idle.length) closeSession(idle.shift(), 'idle')
    }
    if (used() >= maxOf()) throw new BusyError(maxOf())
    reservations.delete(rkey)
    const qi = queue.findIndex((q) => q.key === rkey)
    if (qi >= 0) queue.splice(qi, 1)

    const order = []
    for (const id of [encoder, ...(Array.isArray(chain) ? chain : [])]) if (id && !order.includes(id)) order.push(id)
    if (!order.length) throw new Error('no_encoder')
    const methods = Array.isArray(tonemapMethods) ? tonemapMethods : (tonemap ? ['zscale'] : [])
    const hdr = !!(tracks && tracks.video && tracks.video.hdr)
    const ladder = buildLadder(order, hdr, methods)

    const s = {
      key, owner, fileKey, filePath, tracks, quality, encoder: ladder[0].encoder, tonemap: !!(hdr && ladder[0].tonemap), tonemapMethod: ladder[0].tonemap,
      audioStreamIndex, burnSubtitleStreamIndex, audio, audioEncoders,
      ladder, attemptIdx: 0, devices: devices || {}, fallbacks: 0, lastProgressAt: now(), okReported: false, exhaustedAt: 0,
      dir: path.join(tmpRoot, key),
      lastIndex, proc: null, generation: 0, runStart: 0, readyUpTo: -1, completed: false, error: null,
      runs: 0, createdAt: now(), lastAccess: now(), lastRequested: -1, closed: false
    }
    sessions.set(key, s)
    return s
  }

  function playlist(s) {
    s.lastAccess = now()
    return buildVodPlaylist(s.tracks.durationSec, segmentSeconds)
  }

  function maintain(s, n) {
    s.lastAccess = now() // a viewer who has just been given a piece is active, however long the wait was
    updateReady(s)
    if (s.proc && s.readyUpTo - n > maxAheadSegments) stopProc(s, 'far ahead')
    else if (!s.proc && !s.completed && !s.error && s.readyUpTo < s.lastIndex && s.readyUpTo >= n - 1 && n >= s.readyUpTo - resumeWithinSegments) {
      startRun(s, s.readyUpTo + 1)
    }
    prune(s, n)
  }

  const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref() })

  /** Path of piece n once it exists, null when it never will (past the end / session closed). Throws on failure. */
  async function segment(s, n) {
    n = Number(n)
    if (s.closed || !Number.isInteger(n) || n < 0 || n > s.lastIndex) return null
    s.lastAccess = now()
    s.lastRequested = n
    const waitStart = now()
    const file = segPath(s, n)
    if (fs.existsSync(file)) { maintain(s, n); return file }

    updateReady(s)
    // Every step of the ladder failed a while ago: the picture may be fine now (a busy graphics
    // driver, a file that was still being copied) - start again from the best step.
    if (s.error && s.exhaustedAt && now() - s.exhaustedAt > exhaustedRetryMs) { s.attemptIdx = 0; s.exhaustedAt = 0 }
    const covered = s.proc && n >= s.runStart && n <= s.readyUpTo + seekGapSegments
    if (!covered) {
      s.error = null
      startRun(s, n)
    }
    const deadline = now() + waitTimeoutMs
    for (;;) {
      if (s.closed) return null
      if (fs.existsSync(file)) { maintain(s, n); return file }
      updateReady(s)
      if (!s.proc) {
        if (s.error) throw new Error(s.error)
        if (s.completed) return null
        // Stopped by a newer request (a seek elsewhere) that doesn't cover this piece.
        if (!(n >= s.runStart)) return null
        startRun(s, n)
      } else if (stalled(s, waitStart)) {
        const gen = s.generation
        stopProc(s, 'stalled')
        runFailed(s, gen, `no picture from ${wordOf(s.encoder)} for ${Math.round(hwStallMs / 1000)} s`, '', 'encoder')
        continue
      }
      if (now() > deadline) throw new Error('timed out waiting for the conversion')
      await sleep(pollMs)
    }
  }

  function sweep() {
    for (const s of [...sessions.values()]) {
      if (now() - s.lastAccess > idleMs) closeSession(s, 'idle')
    }
    pruneLine()
  }
  const timer = sweepEveryMs > 0 ? setInterval(sweep, sweepEveryMs) : null
  if (timer && timer.unref) timer.unref()

  /** How busy this computer is with live conversions: for the server dashboard and Settings. */
  function load() {
    pruneLine()
    const live = [...sessions.values()].filter((s) => now() - s.lastAccess <= RECENT_MS)
    const encoders = {}
    for (const s of live) encoders[s.encoder] = (encoders[s.encoder] || 0) + 1
    return {
      active: live.length,
      running: live.filter((s) => s.proc).length,
      max: maxOf(),
      queued: queue.length,
      encoders,
      hardware: live.some((s) => caps.isHardware(s.encoder)),
      fallbacks: totalFallbacks
    }
  }

  return {
    open,
    admit,
    get: (key) => sessions.get(key) || null,
    playlist,
    segment,
    sweep,
    load,
    close: (key) => { const s = sessions.get(key); if (s) closeSession(s, 'stopped') },
    closeOwner: (owner) => {
      for (const s of [...sessions.values()]) if (s.owner === owner) closeSession(s, 'stopped')
      for (let i = queue.length - 1; i >= 0; i--) if (queue[i].owner === owner) queue.splice(i, 1)
      for (const k of [...reservations.keys()]) if (k.startsWith(owner + '|')) reservations.delete(k)
    },
    /** A viewer who gave up waiting (closed the picker) leaves the line at once. */
    leaveLine: (owner, fileKey) => {
      const rkey = `${owner}|${fileKey}`
      const i = queue.findIndex((q) => q.key === rkey)
      if (i >= 0) queue.splice(i, 1)
      reservations.delete(rkey)
    },
    closeAll: () => { if (timer) clearInterval(timer); for (const s of [...sessions.values()]) closeSession(s, 'shutdown'); queue.length = 0; reservations.clear() },
    size: () => sessions.size,
    maxConcurrent: maxOf,
    /** Would open() for this viewer find a slot? (Their own sessions and idle ones make way.) */
    hasSlotFor: (owner, fileKey) => {
      pruneLine()
      return othersCount(owner, fileKey) + reservedExcept(`${owner}|${fileKey}`) < maxOf()
    },
    list: () => [...sessions.values()].map((s) => ({
      key: s.key, owner: s.owner, quality: s.quality, encoder: s.encoder, tonemap: s.tonemapMethod || '', hardware: caps.isHardware(s.encoder),
      running: !!s.proc, runStart: s.runStart, readyUpTo: s.readyUpTo, lastRequested: s.lastRequested, runs: s.runs, error: s.error,
      fallbacks: s.fallbacks, file: path.basename(String(s.filePath || '')),
      // For the owner's dashboard and /metrics: which file, in what, and whether anyone is still pulling pieces.
      filePath: s.filePath, fileKey: s.fileKey, lastAccess: s.lastAccess,
      videoCodec: (s.tracks && s.tracks.video && s.tracks.video.codec) || null,
      audioCodec: (s.audio && s.audio.codec) || null
    }))
  }
}

module.exports = {
  SEGMENT_SECONDS,
  QUALITIES,
  QUALITY_ORDER,
  ENCODER_CANDIDATES,
  encoderCandidatesFor,
  ENCODER_WORDS,
  outputSize,
  qualitiesFor,
  segmentCount,
  segmentName,
  buildVodPlaylist,
  encoderArgs,
  pickAudioTrack,
  audioPlanFor,
  audioEncodersFrom,
  buildTranscodeArgs,
  makeTicket,
  readTicket,
  testEncodeArgs,
  probeEncoders,
  buildLadder,
  createTranscodeManager,
  BusyError
}
