'use strict'
// ============================================================================
// encoderCapabilities.js - what can THIS computer's ffmpeg encode with, proven.
// ----------------------------------------------------------------------------
// ffmpeg lists h264_nvenc even on a PC with no NVIDIA card, so a listing proves
// nothing. This module test-encodes ONE SECOND of picture with every candidate
// (NVIDIA NVENC h264/hevc, Intel Quick Sync, AMD AMF, Apple VideoToolbox, VAAPI on
// Linux with the /dev/dri render node auto-detected, then the software encoders:
// x264 only if the owner's own ffmpeg has it, and the LGPL OpenH264 the bundled
// build ships) and records which ones really work - and, for the ones that do not,
// a plain-words reason. It also proves each HDR->SDR tone-map method the same way.
//
//   * Every probe is one short child process with a timeout, run one after another
//     (never two graphics drivers initialising at once). A probe that fails, hangs or
//     cannot even start is just a "no": nothing here can throw.
//   * The result is cached (memory + the settings store) and re-probed when the ffmpeg
//     binary changes (path / size / modified time), after a few days, or on demand.
//   * planEncoders() turns the result + the owner's choice (Automatic / Processor only /
//     Prefer <encoder>) + what failed while people were watching into the ORDERED list
//     the session manager walks when an encoder dies mid-film (hlsTranscoder.js).
//   * performanceProfile() picks gentle defaults for an old PC (threads, preset,
//     how many conversions at once).
//
// Licensing: nothing here needs libx264 or any GPL/nonfree component; the LGPL
// libopenh264 is the guaranteed floor. See THIRD_PARTY_LICENSES/FFMPEG-SETUP.md.
// ============================================================================

const fs = require('fs')
const os = require('os')
const { execFile } = require('child_process')
const chainLib = require('./hlsVideoChain')
const logRedact = require('./logRedact')

const CACHE_VERSION = 2
const CACHE_KEY = 'transcodeProbeCache'
const DEFAULT_CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000

// Order = preference for "Automatic": graphics hardware first, then the processor.
const ENCODERS = [
  { id: 'h264_nvenc', codec: 'h264', family: 'nvidia', hardware: true, hls: true, platforms: ['win32', 'linux'], word: 'NVIDIA graphics card', label: 'NVIDIA graphics card (NVENC H.264)' },
  { id: 'hevc_nvenc', codec: 'hevc', family: 'nvidia', hardware: true, hls: false, platforms: ['win32', 'linux'], word: 'NVIDIA graphics card (HEVC)', label: 'NVIDIA graphics card (NVENC HEVC)' },
  { id: 'h264_qsv', codec: 'h264', family: 'intel', hardware: true, hls: true, platforms: ['win32', 'linux'], word: 'Intel Quick Sync', label: 'Intel Quick Sync (H.264)' },
  { id: 'h264_amf', codec: 'h264', family: 'amd', hardware: true, hls: true, platforms: ['win32', 'linux'], word: 'AMD graphics card', label: 'AMD graphics card (AMF H.264)' },
  { id: 'h264_videotoolbox', codec: 'h264', family: 'apple', hardware: true, hls: true, platforms: ['darwin'], word: 'Apple VideoToolbox', label: 'Apple VideoToolbox (H.264)' },
  { id: 'h264_vaapi', codec: 'h264', family: 'vaapi', hardware: true, hls: true, platforms: ['linux'], word: 'graphics card (VAAPI)', label: 'Intel / AMD graphics on Linux (VAAPI H.264)' },
  // Only present when the owner supplied their own ffmpeg with x264; the bundled build has none.
  { id: 'libx264', codec: 'h264', family: 'cpu', hardware: false, hls: true, platforms: ['win32', 'linux', 'darwin'], word: 'processor (x264)', label: 'Processor (x264, only if your ffmpeg has it)' },
  { id: 'libopenh264', codec: 'h264', family: 'cpu', hardware: false, hls: true, platforms: ['win32', 'linux', 'darwin'], word: 'processor (OpenH264)', label: 'Processor (OpenH264, built in)' }
]
const ENCODER_BY_ID = new Map(ENCODERS.map((e) => [e.id, e]))
/** The H.264 encoders a live conversion can use, in "Automatic" order. */
const HLS_ENCODER_IDS = ENCODERS.filter((e) => e.hls).map((e) => e.id)

const isHardware = (id) => !!(ENCODER_BY_ID.get(id) || {}).hardware
const encoderWord = (id) => (ENCODER_BY_ID.get(id) || {}).word || id

// ------------------------------------------------------------ running ffmpeg
function defaultRun(ffmpegPath, args, timeoutMs) {
  return new Promise((resolve) => {
    try {
      execFile(ffmpegPath, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
        resolve({
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          timedOut: !!(err && err.killed)
        })
      })
    } catch (e) {
      resolve({ code: 1, stdout: '', stderr: String((e && e.message) || e), timedOut: false })
    }
  })
}

// The picture a live conversion really sees: an interlaced 480i-style broadcast frame (top field first),
// which is what makes the de-interlacer and the encoder's interlace handling do real work.
const INTERLACED_SOURCE = 'testsrc2=size=720x480:rate=30000/1001:duration=1,setfield=tff'
const DEINTERLACE = 'yadif=mode=0:parity=-1:deint=1'

/**
 * The self-test encode: one second (30 frames) of an interlaced 720x480 picture through the SAME
 * chain and the SAME encoder settings a real 480p conversion uses - de-interlace, scale, the
 * encoder's pixel format (and VAAPI upload), then hlsTranscoder.encoderArgs with the real bitrate,
 * profile, key-frame and GOP options. A trivial "black frame, default settings" test can pass on an
 * encoder whose real settings the driver refuses (a hardware encoder that then dies at once on a
 * real conversion), so nothing about the test is simpler than the real thing except its length.
 *   deinterlace  put yadif in the chain (only when this ffmpeg has it; the probe checks)
 */
function testEncodeArgs(encoder, { device = '', deinterlace = false } = {}) {
  const base = ['-hide_banner', '-nostdin', '-v', 'error']
  const plan = chainLib.videoFilterPlan({ encoder, size: { width: 854, height: 480 }, device })
  const vf = [...(deinterlace ? [DEINTERLACE] : []), ...plan.chain].join(',')
  // Lazy: hlsTranscoder requires this module, so it is not loaded yet when this file is.
  let enc = ['-c:v', encoder]
  const spec = ENCODER_BY_ID.get(encoder)
  if (!spec || spec.hls) {
    try {
      const hls = require('./hlsTranscoder')
      const real = hls.encoderArgs(encoder, hls.QUALITIES['480p'])
      if (real[real.indexOf('-c:v') + 1] === encoder) enc = real // an encoder it does not know would get x264's flags
    } catch { /* the plain -c:v below still proves the encoder starts */ }
  }
  return [...base, ...plan.initArgs, '-f', 'lavfi', '-i', INTERLACED_SOURCE, '-vf', vf, '-frames:v', '30',
    ...enc, '-g', '60', '-force_key_frames', 'expr:gte(t,n_forced*2)', '-f', 'null', '-']
}

/** Linux graphics render nodes, e.g. ['/dev/dri/renderD128']. Empty anywhere else. */
function defaultRenderNodes(platform = process.platform, readdir = fs.readdirSync) {
  if (platform !== 'linux') return []
  try {
    return readdir('/dev/dri').filter((n) => /^renderD\d+$/.test(n)).sort().map((n) => `/dev/dri/${n}`)
  } catch { return [] }
}

// -------------------------------------------------------- reading listings
function parseFfmpegVersion(text) {
  const t = String(text || '')
  const m = /ffmpeg version (\S+)/i.exec(t)
  const license = /--enable-nonfree/.test(t) ? 'nonfree' : /--enable-gpl/.test(t) ? 'gpl' : t ? 'lgpl' : ''
  return { version: m ? m[1] : '', license }
}

/** Is `name` a video encoder in `ffmpeg -encoders` output? (Loose on purpose: tests pass bare words.) */
function listsWord(text, name) {
  return new RegExp(`\\b${name}\\b`).test(text)
}

// -------------------------------------------------- explaining a failure
// Turns ffmpeg's technical stderr into one plain sentence. Anything unknown becomes a
// short redacted excerpt - never a path or a ticket.
function redactReason(text, max = 140) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  let line = lines.length ? lines[lines.length - 1] : ''
  line = line.replace(/@ [0-9a-fA-Fx]{6,}/g, '@').replace(/\b[A-Za-z]:[\\/][^\s'"]*/g, '<path>').replace(/(?<![\w<])\/(?:[\w.-]+\/)+[\w.-]*/g, '<path>')
  try { line = logRedact.redact(line, { files: true }) } catch { /* keep what we have */ }
  return line.length > max ? line.slice(0, max - 1) + '…' : line
}

const REASONS = {
  h264_nvenc: [
    [/nvcuda|libcuda|CUDA_ERROR_NO_DEVICE|No CUDA-capable|Cannot load .*cuda|cuInit/i, 'No NVIDIA graphics card or driver found.'],
    [/driver does not support the required nvenc API|nvenc API version|Minimum required Nvidia driver/i, 'The NVIDIA driver is too old. Update it to use this card.'],
    [/OpenEncodeSessionEx|NV_ENC_ERR|Failed to open|out of memory|too many|concurrent/i, 'The NVIDIA card refused to start an encode (driver too old, or its session limit is full).']
  ],
  h264_qsv: [
    [/MFX|libmfx|libvpl|Quick ?Sync|QSV|No device available/i, 'No Intel Quick Sync graphics found (or its driver is missing).']
  ],
  h264_amf: [
    [/amfrt|AMF|DLL .* failed to open/i, 'No AMD graphics card or driver found.']
  ],
  h264_videotoolbox: [
    [/VideoToolbox|compression session/i, 'VideoToolbox is not available on this Mac.']
  ],
  h264_vaapi: [
    [/permission denied|EACCES/i, 'This account is not allowed to use the graphics device (add it to the "render" group).'],
    [/vaapi|libva|vaInitialize|Failed to (open|initiali[sz]e)|No usable/i, 'VAAPI graphics support is missing or the driver did not start.']
  ],
  libopenh264: [
    [/openh264|Failed to load|library/i, 'The OpenH264 library could not be loaded.']
  ]
}

function classifyFailure(id, { stderr = '', timedOut = false, timeoutMs = 0, code = 1 } = {}) {
  if (timedOut) return { reason: `Did not answer within ${Math.round((timeoutMs || 0) / 1000) || 'a few'} s (driver stuck?).`, detail: '' }
  const text = String(stderr || '')
  const list = REASONS[id === 'hevc_nvenc' ? 'h264_nvenc' : id] || []
  for (const [re, reason] of list) if (re.test(text)) return { reason, detail: redactReason(text) }
  const excerpt = redactReason(text)
  return { reason: excerpt ? `Test encode failed: ${excerpt}` : `Test encode failed (exit ${code}).`, detail: excerpt }
}

/**
 * Sorts a failed conversion's ffmpeg message into what to do next.
 *   'input'   the FILE is unreadable: every encoder would fail the same way, so don't cycle (and
 *             don't blame the graphics card)
 *   'filter'  a picture filter (tone-map, burn-in) failed: try the next tone-map method
 *   'encoder' the encoder or its driver died: skip to a different encoder
 *   'unknown' cannot tell: just take the next step of the ladder
 */
function classifyRunFailure(text) {
  const t = String(text || '')
  if (/No such file|does not contain any stream|moov atom not found|Invalid data found when processing input|Permission denied|Input\/output error|Is a directory/i.test(t)) return 'input'
  if (/Error (?:re)?initializing (?:a )?filter|Impossible to convert between the formats|No such filter|Error while filtering|Filter .* has an unconnected|Invalid argument.*(?:zscale|tonemap|libplacebo)|(?:zscale|libplacebo|tonemap[_a-z]*)\b.*(?:fail|error|cannot)|no path between colorspaces|Vulkan|OpenCL/i.test(t)) return 'filter'
  if (/nvcuda|CUDA_ERROR|NV_ENC_ERR|OpenEncodeSessionEx|MFX|AMF|vaapi|libva|VideoToolbox|Error while opening encoder|Could not open encoder|Error initializing output stream|Cannot load|Failed to open|encoder/i.test(t)) return 'encoder'
  return 'unknown'
}

function toneMapReason(method, stderr) {
  const t = String(stderr || '')
  if (method === 'libplacebo' && /vulkan|libplacebo|external library|no device|gpu/i.test(t)) return 'No working Vulkan graphics driver.'
  if (method === 'tonemap_opencl' && /opencl|no such device|device/i.test(t)) return 'No OpenCL graphics device found.'
  if (method === 'tonemap_vaapi' && /vaapi|libva|hwupload|device/i.test(t)) return 'VAAPI could not tone-map on this graphics device.'
  return redactReason(t) || 'Test failed.'
}

// -------------------------------------------------------------- the probe
function emptyCaps(reason, now = Date.now) {
  return {
    v: CACHE_VERSION, probedAt: now(), platform: process.platform, installed: false, problem: reason || 'ffmpeg is not installed',
    ffmpeg: { version: '', license: '' },
    encoders: [],
    tonemap: { methods: [], working: [], best: 'none' },
    audio: { aac: false, ac3: false, eac3: false }
  }
}

function audioEncodersFrom(encodersText) {
  const text = String(encodersText || '')
  if (!text) return { aac: true, ac3: false, eac3: false }
  const has = (name) => new RegExp(`^\\s*A\\S*\\s+${name}\\s`, 'm').test(text)
  return { aac: true, ac3: has('ac3'), eac3: has('eac3') }
}

/**
 * Test-encodes every candidate and proves every tone-map method.
 *   run(args) -> { code, stdout, stderr, timedOut? }   (defaults to really running ffmpeg)
 *   candidates  encoder ids to try (default: all of ENCODERS)
 *   stopAtFirst stop at the first working candidate (the quick "which one encoder" question)
 *   proveTonemap run each HDR tone-map method for real (default). When false, tone-mapping is judged
 *               by ffmpeg's filter listing alone (zscale + tonemap present).
 * Never throws.
 */
async function probeCapabilities({
  ffmpegPath, run, candidates, timeoutMs = 20000, platform = process.platform, listRenderNodes,
  stopAtFirst = false, proveTonemap = !stopAtFirst, ignorePlatform = false, now = Date.now, log = () => {}
} = {}) {
  if (!ffmpegPath) return emptyCaps('ffmpeg is not installed', now)
  const rawRun = run || ((args) => defaultRun(ffmpegPath, args, timeoutMs))
  const exec = async (args) => {
    try {
      const r = (await rawRun(args)) || {}
      return { code: typeof r.code === 'number' ? r.code : 1, stdout: String(r.stdout || ''), stderr: String(r.stderr || ''), timedOut: !!r.timedOut }
    } catch (e) {
      return { code: 1, stdout: '', stderr: String((e && e.message) || e), timedOut: false }
    }
  }
  const nodesOf = listRenderNodes || (() => defaultRenderNodes(platform))

  const [versionRun, encodersRun, filtersRun] = [await exec(['-hide_banner', '-version']), await exec(['-hide_banner', '-encoders']), await exec(['-hide_banner', '-filters'])]
  const encText = encodersRun.stdout
  const filtText = filtersRun.stdout
  const ver = parseFfmpegVersion(versionRun.stdout)
  // Live TV de-interlaces with yadif (LGPL, in the bundled build); the self-test does too when it can.
  const hasYadif = !filtText || /\byadif\b/.test(filtText)
  const audio = audioEncodersFrom(encText)
  const ids = Array.isArray(candidates) && candidates.length ? candidates : ENCODERS.map((e) => e.id)
  const entries = []
  let renderNodes = null
  let vaapiDevice = ''

  for (const id of ids) {
    const spec = ENCODER_BY_ID.get(id) || { id, codec: 'h264', family: 'other', hardware: !/^lib/.test(id), hls: true, platforms: [platform], word: id, label: id }
    const entry = { id, codec: spec.codec, family: spec.family, label: spec.label, hardware: !!spec.hardware, usedForHls: spec.hls !== false, ok: false, state: 'unavailable', reason: '', detail: '', ms: 0, device: '' }
    entries.push(entry)
    if (!ignorePlatform && !spec.platforms.includes(platform)) { entry.state = 'skipped'; entry.reason = `Not used on ${platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : 'Linux'}.`; continue }
    if (encText && !listsWord(encText, id)) { entry.reason = 'Not built into this ffmpeg.'; continue }

    const started = Date.now()
    let devices = ['']
    if (id === 'h264_vaapi') {
      if (renderNodes === null) renderNodes = nodesOf() || []
      if (!renderNodes.length) { entry.reason = 'No graphics render device (/dev/dri/renderD*) found.'; continue }
      devices = renderNodes
    }
    let last = null
    for (const device of devices) {
      const r = await exec(testEncodeArgs(id, { device, deinterlace: hasYadif }))
      last = r
      if (r.code === 0 && !r.timedOut) { entry.ok = true; entry.state = 'ok'; entry.device = device; break }
    }
    entry.ms = Date.now() - started
    if (entry.ok) {
      if (id === 'h264_vaapi') vaapiDevice = entry.device
    } else {
      const c = classifyFailure(id, { stderr: last && last.stderr, timedOut: last && last.timedOut, timeoutMs, code: last && last.code })
      entry.reason = c.reason
      entry.detail = c.detail
    }
    if (stopAtFirst && entry.ok && entry.usedForHls) break
  }

  // ---- HDR -> SDR tone-mapping methods: listed AND proven.
  const methods = []
  for (const id of chainLib.TONEMAP_ORDER) {
    const m = { id, label: chainLib.TONEMAP_LABELS[id], ok: false, reason: '', ms: 0 }
    methods.push(m)
    const need = chainLib.TONEMAP_FILTERS[id]
    if (filtText && !need.every((f) => new RegExp(`\\b${f}\\b`).test(filtText))) { m.reason = 'Not built into this ffmpeg.'; continue }
    if (!proveTonemap) { m.ok = id === 'zscale' && !!filtText; m.reason = m.ok ? '' : 'Not checked.'; continue }
    if (id === 'tonemap_vaapi') {
      if (platform !== 'linux') { m.reason = 'Linux only.'; continue }
      if (!vaapiDevice) { m.reason = 'Needs a working VAAPI encoder.'; continue }
    }
    const started = Date.now()
    const r = await exec(chainLib.testTonemapArgs(id, { device: vaapiDevice }))
    m.ms = Date.now() - started
    if (r.code === 0 && !r.timedOut) m.ok = true
    else m.reason = r.timedOut ? 'Did not answer in time.' : toneMapReason(id, r.stderr)
  }
  const working = methods.filter((m) => m.ok).map((m) => m.id)

  return {
    v: CACHE_VERSION,
    probedAt: now(),
    platform,
    installed: true,
    problem: '',
    ffmpeg: ver,
    encoders: entries,
    tonemap: { methods, working, best: working[0] || 'none' },
    audio
  }
}

// ----------------------------------------------------------- choosing order
/**
 * The ordered list of encoders a conversion may use.
 *   mode ''            Automatic: working graphics hardware first, then the processor. Hardware that
 *                      failed while people were watching is tried last.
 *   mode 'software'    processor only (falls back to Automatic if no processor encoder works)
 *   mode '<encoder>'   that encoder first, then Automatic
 * A conversion is never left with an empty list while ANY encoder works.
 */
function planEncoders(caps, { mode = '', health = null, now = Date.now() } = {}) {
  const ok = ((caps && caps.encoders) || []).filter((e) => e.ok && e.usedForHls)
  const demoted = (id) => { const h = health && health.get ? health.get(id) : null; return !!(h && h.demotedUntil > now) }
  const hw = ok.filter((e) => e.hardware)
  const sw = ok.filter((e) => !e.hardware)
  const auto = [...hw.filter((e) => !demoted(e.id)), ...sw, ...hw.filter((e) => demoted(e.id))]
  const m = String(mode || '').trim()
  let order = auto
  let note = ''
  if (m === 'software') {
    if (sw.length) order = sw
    else note = 'No processor encoder is working, so the graphics card is used instead.'
  } else if (m && m !== 'auto') {
    const want = ok.find((e) => e.id === m)
    if (want) order = [want, ...auto.filter((e) => e.id !== m)]
    else note = `Your preferred encoder (${encoderWord(m)}) is not working on this computer, so Beebo chose automatically.`
  }
  const devices = {}
  for (const e of ok) if (e.device) devices[e.id] = e.device
  return {
    chain: order.map((e) => e.id),
    primary: order[0] || null,
    entries: order,
    devices,
    note
  }
}

// ---------------------------------------------------- old-PC friendly settings
/**
 * How hard a live conversion may lean on this computer. An old or small PC gets: fewer encoder
 * threads, the fastest x264 preset, a cheaper scaler and one conversion at a time. Everything is
 * overridable in Settings (cpuMode 'gentle' forces the low tier, 'normal' the middle one).
 */
function performanceProfile({ cpus = null, totalMem = null, cpuMode = '', platform = process.platform } = {}) {
  let list = cpus
  if (!list) { try { list = os.cpus() || [] } catch { list = [] } }
  let mem = totalMem
  if (mem == null) { try { mem = os.totalmem() } catch { mem = 0 } }
  const cores = Math.max(1, Array.isArray(list) ? list.length : Number(list) || 1)
  const speeds = (Array.isArray(list) ? list : []).map((c) => Number(c && c.speed) || 0).filter((s) => s > 0)
  const mhz = speeds.length ? speeds.reduce((a, b) => a + b, 0) / speeds.length : 0
  const mode = String(cpuMode || '').trim()
  let tier
  let why
  if (mode === 'gentle') { tier = 'low'; why = 'Gentle mode is switched on in Settings.' }
  else if (mode === 'normal') { tier = 'normal'; why = 'Normal mode is switched on in Settings.' }
  else if (cores <= 2) { tier = 'low'; why = `Only ${cores} processor core${cores === 1 ? '' : 's'}.` }
  else if (cores <= 4 && mhz > 0 && mhz < 2500) { tier = 'low'; why = `${cores} slower processor cores.` }
  else if (mem > 0 && mem < 4 * 1024 ** 3) { tier = 'low'; why = 'Less than 4 GB of memory.' }
  else if (cores >= 8) { tier = 'high'; why = `${cores} processor cores.` }
  else { tier = 'normal'; why = `${cores} processor cores.` }
  const threads = tier === 'low' ? Math.max(1, Math.floor(cores / 2)) : tier === 'high' ? Math.min(8, Math.max(2, cores - 2)) : Math.max(1, Math.min(6, cores - 1))
  return {
    tier,
    cores,
    reason: why,
    threads,
    filterThreads: tier === 'low' ? 1 : Math.min(4, threads),
    x264Preset: tier === 'low' ? 'ultrafast' : 'veryfast',
    scaleFlags: tier === 'low' ? 'bilinear' : '',
    // OpenH264 has no presets; these two switches are its cheap-CPU mode.
    openh264Cheap: tier === 'low',
    platform
  }
}

/** How many conversions at once when the owner has not chosen: gentle on a weak PC, more with a GPU. */
function defaultMaxConcurrent(profile, hardwareActive) {
  const tier = (profile && profile.tier) || 'normal'
  const base = { low: 1, normal: 2, high: 3 }[tier] || 2
  return base + (hardwareActive ? 1 : 0)
}

// ---------------------------------------------------------------- service
/**
 * One per app: owns the cached probe and the "what failed while people were watching" memory.
 *   getFfmpegPath   () => path | null
 *   store           optional settings store ({get,set}) for the on-disk cache
 */
function createEncoderService({
  getFfmpegPath, store = null, run = null, platform = process.platform, listRenderNodes,
  cpus, totalMem, getCpuMode = () => '', now = Date.now, log = () => {},
  timeoutMs = 20000, cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  demoteAfter = 2, demoteMs = 10 * 60 * 1000, statFn = fs.statSync
} = {}) {
  let memo = null // { fp, caps }
  let inflight = null // { fp, promise }
  const health = new Map() // encoder id -> { failures, lastReason, lastFailAt, demotedUntil }

  const exePath = () => { try { return typeof getFfmpegPath === 'function' ? getFfmpegPath() : getFfmpegPath } catch { return null } }

  function fingerprint(exe) {
    try {
      const st = statFn(exe)
      return `${exe}|${st.size}|${Math.round(st.mtimeMs)}`
    } catch { return String(exe) }
  }
  const readDisk = (fp) => {
    if (!store || typeof store.get !== 'function') return null
    try {
      const c = store.get(CACHE_KEY)
      if (!c || c.v !== CACHE_VERSION || c.fp !== fp || c.platform !== platform || !c.caps || !Array.isArray(c.caps.encoders)) return null
      if (now() - Number(c.at || 0) > cacheTtlMs) return null
      return c.caps
    } catch { return null }
  }
  const writeDisk = (fp, caps) => {
    if (!store || typeof store.set !== 'function') return
    try { store.set(CACHE_KEY, { v: CACHE_VERSION, fp, platform, at: now(), caps }) } catch { /* cache is optional */ }
  }

  /** The proven capabilities. Probes at most once per ffmpeg binary; never rejects. */
  async function capabilities({ force = false } = {}) {
    const exe = exePath()
    if (!exe) return emptyCaps('ffmpeg is not installed', now)
    const fp = fingerprint(exe)
    if (!force && memo && memo.fp === fp) return memo.caps
    if (!force && inflight && inflight.fp === fp) return inflight.promise
    if (!force) {
      const disk = readDisk(fp)
      if (disk) { memo = { fp, caps: disk }; return disk }
    }
    let promise
    promise = probeCapabilities({ ffmpegPath: exe, run, timeoutMs, platform, listRenderNodes, now, log })
      .catch((e) => emptyCaps(String((e && e.message) || e), now))
      .then((caps) => {
        memo = { fp, caps }
        writeDisk(fp, caps)
        const good = caps.encoders.filter((e) => e.ok && e.usedForHls).map((e) => e.id)
        log(`encoder check: working ${good.length ? good.join(', ') : 'none'}; HDR tone-map ${caps.tonemap.best}${caps.ffmpeg && caps.ffmpeg.license && caps.ffmpeg.license !== 'lgpl' ? `; NOTE this ffmpeg is a ${caps.ffmpeg.license.toUpperCase()} build` : ''}`)
        return caps
      })
      .finally(() => { if (inflight && inflight.promise === promise) inflight = null })
    inflight = { fp, promise }
    return promise
  }

  const peek = () => (memo ? memo.caps : null)

  function profile() {
    let mode = ''
    try { mode = getCpuMode() || '' } catch { mode = '' }
    return performanceProfile({ cpus, totalMem, cpuMode: mode, platform })
  }

  /** What a conversion should use right now. */
  async function selection({ mode = '' } = {}) {
    const exe = exePath()
    if (!exe) return { encoder: null, label: '', hardware: false, chain: [], devices: {}, tonemap: false, tonemapMethods: [], tried: [], audio: { aac: false, ac3: false, eac3: false }, note: '', profile: profile() }
    const caps = await capabilities()
    const plan = planEncoders(caps, { mode, health, now: now() })
    const spec = plan.primary
    return {
      encoder: spec ? spec.id : null,
      label: spec ? encoderWord(spec.id) : '',
      hardware: !!(spec && spec.hardware),
      chain: plan.chain,
      devices: plan.devices,
      tonemap: caps.tonemap.working.length > 0,
      tonemapMethods: caps.tonemap.working.slice(),
      tried: caps.encoders.filter((e) => e.usedForHls).map((e) => ({ encoder: e.id, ok: e.ok, reason: e.reason })),
      audio: caps.audio,
      note: plan.note,
      profile: profile()
    }
  }

  function noteFailure(id, reason = '') {
    if (!id) return
    const h = health.get(id) || { failures: 0, lastReason: '', lastFailAt: 0, demotedUntil: 0 }
    h.failures++
    h.lastReason = String(reason || '').slice(0, 160)
    h.lastFailAt = now()
    if (isHardware(id) && h.failures >= demoteAfter) h.demotedUntil = now() + demoteMs
    health.set(id, h)
  }
  function noteSuccess(id) {
    const h = id ? health.get(id) : null
    if (h) { h.failures = 0; h.demotedUntil = 0 }
  }

  /** The default number of simultaneous conversions when the owner has not chosen one. */
  function defaultMax(mode = '') {
    const caps = peek()
    const active = caps ? planEncoders(caps, { mode, health, now: now() }).primary : null
    return defaultMaxConcurrent(profile(), !!(active && active.hardware))
  }

  /** Everything Settings > Playback > Hardware acceleration shows. */
  async function status({ mode = '', force = false } = {}) {
    const exe = exePath()
    if (!exe) {
      return { ok: false, installed: false, encoder: '', label: '', hardware: false, mode, detected: [], tonemap: { methods: [], working: [], best: 'none' }, profile: profile(), message: 'The converter (ffmpeg) is not installed, so live conversion is off.' }
    }
    const caps = await capabilities({ force })
    const sel = await selection({ mode })
    const detected = caps.encoders.map((e) => {
      const h = health.get(e.id)
      return {
        id: e.id, label: e.label, hardware: e.hardware, codec: e.codec, usedForHls: e.usedForHls,
        ok: e.ok, state: e.state, reason: e.reason, device: e.device || '',
        failedInUse: !!(h && h.failures > 0), failedReason: h && h.failures > 0 ? h.lastReason : '',
        demoted: !!(h && h.demotedUntil > now())
      }
    })
    let message
    if (!sel.encoder) message = 'No working video encoder was found, so live conversion is off.'
    else {
      message = `Converting with your ${sel.label}${sel.hardware ? ' (hardware - fast and quiet)' : ''}.`
      if (!sel.hardware) message += ' No graphics acceleration was found, so the processor does the work' + (sel.profile.tier === 'low' ? ' in a gentle mode for this computer.' : '.')
    }
    if (sel.note) message += ' ' + sel.note
    return {
      ok: !!sel.encoder,
      installed: true,
      encoder: sel.encoder || '',
      label: sel.label,
      hardware: sel.hardware,
      message,
      mode: mode || '',
      chain: sel.chain,
      detected,
      tonemap: caps.tonemap,
      hdr: caps.tonemap.best === 'none' ? 'No HDR to SDR conversion is available in this ffmpeg: HDR films played at a lower quality may look dull. Original quality is unaffected.' : `HDR films are converted to normal colours using: ${chainLibLabel(caps.tonemap.best)}.`,
      profile: sel.profile,
      defaultMax: defaultMax(mode),
      ffmpeg: caps.ffmpeg,
      probedAt: caps.probedAt
    }
  }

  return { capabilities, peek, selection, status, profile, defaultMax, noteFailure, noteSuccess, health: () => new Map(health), invalidate: () => { memo = null; inflight = null } }
}

function chainLibLabel(id) { return chainLib.TONEMAP_LABELS[id] || id }

module.exports = {
  CACHE_KEY,
  CACHE_VERSION,
  ENCODERS,
  HLS_ENCODER_IDS,
  isHardware,
  encoderWord,
  defaultRun,
  testEncodeArgs,
  defaultRenderNodes,
  parseFfmpegVersion,
  audioEncodersFrom,
  redactReason,
  classifyFailure,
  classifyRunFailure,
  probeCapabilities,
  planEncoders,
  performanceProfile,
  defaultMaxConcurrent,
  createEncoderService,
  emptyCaps
}
