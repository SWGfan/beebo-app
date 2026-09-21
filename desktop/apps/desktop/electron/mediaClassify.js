'use strict'
// ============================================================================
// mediaClassify.js - what a video file REALLY is, for a home theatre.
// ----------------------------------------------------------------------------
// Pure functions over raw ffprobe JSON (no process is started here). One file in, one precise
// classification out:
//
//   video   resolution class (SD..8K), bit depth, colour primaries / transfer / matrix,
//           HDR type: SDR | HDR10 | HDR10+ | HLG | Dolby Vision (profile 4/5/7/8/9, the
//           base-layer compatibility id, whether an enhancement layer is present)
//   audio   per track: codec family and profile (Dolby Digital, Dolby Digital Plus, Dolby
//           TrueHD, DTS, DTS-ES, DTS-HD HRA, DTS-HD MA, DTS:X, AAC, FLAC ...), whether it is
//           lossless, whether it carries object audio (Dolby Atmos in Dolby Digital Plus
//           "JOC" or in TrueHD, DTS:X), the channel layout ("5.1", "7.1", "7.1.4")
//   badges  "4K", "Dolby Vision", "HDR10+", "Atmos", "DTS:X", "7.1" - the short labels every
//           screen shows (API, library table, details page, Jellyfin-compatible MediaStreams)
//
// What ffprobe can and cannot tell us (kept honest here, repeated in docs/HOME-THEATER.md):
//   * Dolby Vision comes from the stream's "DOVI configuration record" (dv_profile,
//     dv_bl_signal_compatibility_id, rpu/el/bl flags). Present in MP4 (dvcC/dvvC box) and
//     Matroska (BlockAdditionMapping) files. A raw HEVC stream with RPU NAL units but no
//     configuration record is not detected.
//   * HDR10+ is per-frame metadata (SMPTE 2094-40, an SEI message). ffprobe shows it as side
//     data of the FIRST frames, sometimes of the stream. probeFrameSideDataArgs() is the tiny
//     extra ffprobe call the callers make for candidate files (HEVC/AV1/VP9 with a PQ
//     transfer); a file whose first frames carry no SEI is reported as plain HDR10.
//   * Atmos is recognised from ffprobe's audio `profile` ("Dolby Digital Plus + Dolby Atmos",
//     "Dolby TrueHD + Dolby Atmos"), and DTS:X from "DTS-HD MA + DTS:X". Older ffmpeg builds
//     print no such profile; then the track title is used as a hint and the result is marked
//     `inferred: true` (never silently trusted).
// ============================================================================

const CLASSIFY_VERSION = 1

const num = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (v == null || v === '' || v === 'N/A') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const lower = (v) => String(v == null ? '' : v).toLowerCase()

// ---------------------------------------------------------------- resolution
/** 3840x2160 -> '4K', 1920x800 (scope) -> '1080p', 7680x4320 -> '8K'. Null when the size is unknown. */
function resolutionClass(width, height) {
  const w = num(width) || 0
  const h = num(height) || 0
  if (!w && !h) return null
  // A widescreen crop keeps the width of its tier but has fewer lines, so judge by whichever is bigger.
  const lines = Math.max(h, Math.round((w * 9) / 16))
  if (lines >= 4000) return '8K'
  if (lines >= 2000) return '4K'
  if (lines >= 1400) return '1440p'
  if (lines >= 1000) return '1080p'
  if (lines >= 680) return '720p'
  if (lines >= 540) return '576p'
  if (lines >= 440) return '480p'
  return 'SD'
}

// -------------------------------------------------------------------- pixels
/** 8, 10, 12 (or null): from bits_per_raw_sample, else from the pixel format's name. */
function bitDepthOf(stream) {
  const raw = num(stream && stream.bits_per_raw_sample)
  if (raw && raw >= 8 && raw <= 16) return raw
  const pf = lower(stream && stream.pix_fmt)
  if (!pf) return null
  let m = /p0(10|12|16)(le|be)?$/.exec(pf) // semi-planar: p010le, p012le, p016le
  if (!m) m = /(\d{2})(le|be)$/.exec(pf) // yuv420p10le, yuv444p12le, gbrp10le
  return m ? Number(m[1]) : 8
}

function chromaOf(pixFmt) {
  const pf = lower(pixFmt)
  if (!pf) return null
  if (/444|gbr/.test(pf)) return '4:4:4'
  if (/422/.test(pf)) return '4:2:2'
  if (/420|nv12|nv21|p01\d/.test(pf)) return '4:2:0'
  return null
}

// ---------------------------------------------------------------- side data
const sideTypes = (list) => (Array.isArray(list) ? list : []).map((d) => String((d && d.side_data_type) || ''))

function findDovi(list) {
  for (const d of Array.isArray(list) ? list : []) {
    if (d && /dovi|dolby vision/i.test(String(d.side_data_type || ''))) return d
  }
  return null
}

const HDR10PLUS_RE = /2094-?40|hdr10\+|hdr10plus|hdr dynamic metadata/i
const flag = (v) => v === 1 || v === true || v === '1'

/** Base-layer compatibility id -> what the base layer looks like on a non-Dolby display. */
const DV_COMPAT = { 0: 'None', 1: 'HDR10', 2: 'SDR', 4: 'HLG', 6: 'HDR10' }

/**
 * The Dolby Vision facts of a stream, from its DOVI configuration record (ffprobe side data) and,
 * as a fallback, the codec tag (dvh1 / dvhe / dav1 / dvav).
 * Returns null for a file without Dolby Vision.
 */
function dolbyVisionOf(stream) {
  const rec = findDovi(stream && stream.side_data_list)
  const tag = lower(stream && stream.codec_tag_string)
  const tagged = /^(dvh1|dvhe|dav1|dvav|dva1)$/.test(tag)
  if (!rec && !tagged) return null
  const profile = rec ? num(rec.dv_profile) : null
  const level = rec ? num(rec.dv_level) : null
  const compatId = rec && rec.dv_bl_signal_compatibility_id != null ? num(rec.dv_bl_signal_compatibility_id) : null
  const el = rec ? flag(rec.el_present_flag) : false
  const rpu = rec ? (rec.rpu_present_flag != null ? flag(rec.rpu_present_flag) : true) : true
  const bl = rec ? (rec.bl_present_flag != null ? flag(rec.bl_present_flag) : true) : true
  let label = profile == null ? '' : String(profile)
  if (profile === 8 && compatId != null) label = `8.${compatId}`
  else if (profile === 7) label = el ? '7 (dual layer)' : '7'
  else if (profile === 9 && compatId != null) label = `9.${compatId}`
  else if (profile === 10 && compatId != null) label = `10.${compatId}`
  // Profiles 4, 5, 7 have no separate compatibility id in the record for some muxers; profile 5 never has a fallback.
  let baseLooksLike = compatId != null ? (DV_COMPAT[compatId] || 'Unknown') : (profile === 5 ? 'None' : profile === 7 ? 'HDR10' : 'Unknown')
  if (profile === 5) baseLooksLike = 'None'
  return {
    profile,
    label,
    level,
    versionMajor: rec ? num(rec.dv_version_major) : null,
    versionMinor: rec ? num(rec.dv_version_minor) : null,
    compatId,
    baseLooksLike, // 'None' | 'HDR10' | 'HLG' | 'SDR' | 'Unknown'
    rpuPresent: rpu,
    elPresent: el,
    blPresent: bl,
    fromTagOnly: !rec
  }
}

// -------------------------------------------------------------------- video
/**
 * Classify one ffprobe video stream. `opts.frameSideData` is an optional array of side data type
 * names seen on the first frames (see probeFrameSideDataArgs).
 */
function classifyVideoStream(stream, opts = {}) {
  if (!stream || typeof stream !== 'object') return null
  const width = num(stream.width)
  const height = num(stream.height)
  const transfer = lower(stream.color_transfer)
  const primaries = lower(stream.color_primaries)
  const matrix = lower(stream.color_space)
  const bitDepth = bitDepthOf(stream)
  const dv = dolbyVisionOf(stream)
  const seen = [...sideTypes(stream.side_data_list), ...((opts && Array.isArray(opts.frameSideData)) ? opts.frameSideData.map(String) : [])]
  const hdr10Plus = seen.some((t) => HDR10PLUS_RE.test(t))
  const pq = transfer === 'smpte2084'
  const hlg = transfer === 'arib-std-b67'

  // The signal of the base layer: what a plain (non-Dolby) player sees.
  let base = 'SDR'
  if (dv && dv.profile === 5) base = 'DV-only' // IPT-PQ-C2: meaningless without a Dolby Vision decoder
  else if (pq) base = 'PQ'
  else if (hlg) base = 'HLG'
  else if (dv && dv.baseLooksLike === 'HDR10') base = 'PQ'
  else if (dv && dv.baseLooksLike === 'HLG') base = 'HLG'

  const formats = []
  if (dv) formats.push('Dolby Vision')
  if (hdr10Plus && base !== 'HLG') formats.push('HDR10+')
  if (base === 'PQ') formats.push('HDR10')
  if (base === 'HLG') formats.push('HLG')
  const hdrType = formats.length ? formats[0] : 'SDR'
  // The type a client that lacks Dolby Vision would see.
  const fallbackHdrType = base === 'PQ' ? (hdr10Plus ? 'HDR10+' : 'HDR10') : base === 'HLG' ? 'HLG' : base === 'SDR' ? 'SDR' : 'none'

  const cls = resolutionClass(width, height)
  const badges = []
  if (cls && cls !== 'SD') badges.push(cls)
  for (const f of formats) if (!badges.includes(f)) badges.push(f)
  if (bitDepth && bitDepth >= 10 && !formats.length) badges.push(`${bitDepth}-bit`)

  return {
    streamIndex: num(stream.index),
    codec: stream.codec_name || null,
    profile: stream.profile || null,
    level: num(stream.level),
    width, height,
    fps: fpsOf(stream),
    interlaced: /^(tt|bb|tb|bt)$/i.test(String(stream.field_order || '')),
    resolutionClass: cls,
    pixFmt: stream.pix_fmt || null,
    bitDepth,
    chroma: chromaOf(stream.pix_fmt),
    colorPrimaries: primaries || null,
    colorTransfer: transfer || null,
    colorSpace: matrix || null,
    colorRange: stream.color_range || null,
    hdr: hdrType !== 'SDR',
    hdrType,
    hdrFormats: formats,
    hdrBase: base, // 'SDR' | 'PQ' | 'HLG' | 'DV-only'
    fallbackHdrType, // what a player without Dolby Vision gets: HDR10 | HDR10+ | HLG | SDR | none (profile 5)
    hdr10Plus,
    dolbyVision: dv,
    badges
  }
}

function fpsOf(s) {
  for (const raw of [s.avg_frame_rate, s.r_frame_rate]) {
    const m = /^(\d+)\/(\d+)$/.exec(String(raw || ''))
    if (m && Number(m[2]) > 0) {
      const f = Number(m[1]) / Number(m[2])
      if (f > 0 && f < 1000) return Math.round(f * 1000) / 1000
    }
  }
  return null
}

// -------------------------------------------------------------------- audio
/** "5.1(side)" -> "5.1", "stereo" -> "Stereo", 8 -> "7.1", "7.1.4" -> "7.1.4". */
function layoutLabel(channels, layout) {
  const l = lower(layout)
  const m = /^(\d+\.\d+(?:\.\d+)?)/.exec(l)
  if (m) return m[1]
  if (l.startsWith('stereo') || l === '2.0') return 'Stereo'
  if (l.startsWith('mono')) return 'Mono'
  const n = num(channels)
  if (!n || n <= 0) return ''
  const byCount = { 1: 'Mono', 2: 'Stereo', 3: '2.1', 4: '4.0', 5: '5.0', 6: '5.1', 7: '6.1', 8: '7.1', 10: '7.1.2', 12: '7.1.4' }
  return byCount[n] || `${n}ch`
}

const AUDIO_NAMES = {
  aac: 'AAC', ac3: 'Dolby Digital', eac3: 'Dolby Digital Plus', truehd: 'Dolby TrueHD', mlp: 'MLP', dts: 'DTS', mp3: 'MP3', mp2: 'MP2',
  opus: 'Opus', vorbis: 'Vorbis', flac: 'FLAC', alac: 'Apple Lossless', wmav2: 'WMA', wmapro: 'WMA Pro', pcm_bluray: 'PCM', pcm_dvd: 'PCM'
}

/** DTS profile string -> { name, short, lossless, objects } */
function dtsVariant(profile) {
  const p = String(profile || '')
  if (/dts:x|dtsx|dts-x/i.test(p)) return { name: p.includes('IMAX') ? 'DTS:X IMAX' : 'DTS:X', short: 'DTS:X', lossless: true, objects: true, family: 'dtshd' }
  if (/dts-hd\s*ma|master audio/i.test(p)) return { name: 'DTS-HD Master Audio', short: 'DTS-HD MA', lossless: true, objects: false, family: 'dtshd' }
  if (/dts-hd\s*hra|high res/i.test(p)) return { name: 'DTS-HD High Resolution', short: 'DTS-HD HRA', lossless: false, objects: false, family: 'dtshd' }
  if (/dts-es/i.test(p)) return { name: 'DTS-ES', short: 'DTS-ES', lossless: false, objects: false, family: 'dts' }
  if (/96\/24/i.test(p)) return { name: 'DTS 96/24', short: 'DTS 96/24', lossless: false, objects: false, family: 'dts' }
  if (/express/i.test(p)) return { name: 'DTS Express', short: 'DTS Express', lossless: false, objects: false, family: 'dts' }
  if (/dts-hd/i.test(p)) return { name: 'DTS-HD', short: 'DTS-HD', lossless: false, objects: false, family: 'dtshd' }
  return { name: 'DTS', short: 'DTS', lossless: false, objects: false, family: 'dts' }
}

/**
 * Classify one ffprobe audio stream.
 * Returns { codec, family, name, short, lossless, objectAudio: 'atmos' | 'dtsx' | null, inferred,
 *           channels, layout, spatialFormat: 'DolbyAtmos' | 'DTSX' | 'None', badges }
 * `family` is the group an AV receiver / player negotiates on:
 *   'dd' (AC-3) | 'ddp' (E-AC-3, with or without Atmos) | 'truehd' | 'dts' (core, ES, 96/24)
 *   | 'dtshd' (HRA, MA, DTS:X) | 'aac' | 'flac' | 'pcm' | 'opus' | 'other'
 */
function classifyAudioStream(stream) {
  if (!stream || typeof stream !== 'object') return null
  const codec = lower(stream.codec_name)
  const profile = String(stream.profile || '')
  const title = String((stream.tags && (stream.tags.title || stream.tags.TITLE || stream.tags.handler_name)) || '')
  const channels = num(stream.channels)
  const layout = layoutLabel(channels, stream.channel_layout)
  let family = 'other'
  let name = AUDIO_NAMES[codec] || (codec ? codec.toUpperCase() : '')
  let short = name
  let lossless = false
  let objectAudio = null
  let inferred = false

  if (codec === 'ac3') { family = 'dd'; short = 'Dolby Digital' }
  else if (codec === 'eac3') {
    family = 'ddp'
    short = 'Dolby Digital Plus'
    if (/atmos/i.test(profile)) objectAudio = 'atmos'
    else if (/\batmos\b/i.test(title)) { objectAudio = 'atmos'; inferred = true }
    if (objectAudio) name = 'Dolby Digital Plus + Dolby Atmos'
  } else if (codec === 'truehd' || codec === 'mlp') {
    family = 'truehd'
    lossless = true
    short = 'Dolby TrueHD'
    if (/atmos/i.test(profile)) objectAudio = 'atmos'
    else if (/\batmos\b/i.test(title)) { objectAudio = 'atmos'; inferred = true }
    if (objectAudio) name = 'Dolby TrueHD + Dolby Atmos'
  } else if (codec === 'dts') {
    const v = dtsVariant(profile)
    family = v.family
    name = v.name
    short = v.short
    lossless = v.lossless
    if (v.objects) objectAudio = 'dtsx'
    else if (/\bdts[\s:.\-]?x\b/i.test(title)) {
      // The title says DTS:X but this ffmpeg printed no such profile: a hint only, marked as inferred.
      objectAudio = 'dtsx'; inferred = true; short = 'DTS:X'; name = 'DTS:X'; lossless = true; family = 'dtshd'
    }
  } else if (codec === 'aac') { family = 'aac' }
  else if (codec === 'flac' || codec === 'alac') { family = codec === 'flac' ? 'flac' : 'other'; lossless = true }
  else if (/^pcm_/.test(codec)) { family = 'pcm'; lossless = true; short = 'PCM' }
  else if (codec === 'opus') family = 'opus'

  const spatialFormat = objectAudio === 'atmos' ? 'DolbyAtmos' : objectAudio === 'dtsx' ? 'DTSX' : 'None'
  const badges = []
  if (objectAudio === 'atmos') badges.push('Atmos')
  else if (objectAudio === 'dtsx') badges.push('DTS:X')
  else if (family === 'truehd' || family === 'dtshd') badges.push(short)
  return {
    streamIndex: num(stream.index),
    codec: codec || null,
    profile: profile || null,
    family,
    name,
    short,
    lossless,
    objectAudio,
    inferred,
    spatialFormat,
    channels,
    layout,
    sampleRate: num(stream.sample_rate),
    bitDepth: num(stream.bits_per_raw_sample) || null,
    bitrateKbps: num(stream.bit_rate) ? Math.round(num(stream.bit_rate) / 1000) : null,
    language: (stream.tags && (stream.tags.language || stream.tags.LANGUAGE)) || '',
    title: title || '',
    isDefault: !!(stream.disposition && stream.disposition.default),
    badges
  }
}

/** A one-line description: "Dolby TrueHD + Dolby Atmos 7.1". */
function describeAudio(a) {
  if (!a) return ''
  return [a.name, a.layout].filter(Boolean).join(' ')
}

// ------------------------------------------------------------- whole file
/** Which audio track stands for the file in badges and library columns: the default one, else the first. */
function pickMainAudio(audio) {
  return (audio || []).find((a) => a.isDefault) || (audio || [])[0] || null
}

/**
 * Raw ffprobe JSON (streams + format) -> { video, audio[], badges[], objectAudio[], formatName }.
 * Never throws; returns null for something that is not a probe result.
 * `opts.frameSideData` - first-frame side data types (HDR10+), see probeFrameSideDataArgs.
 */
function classifyProbe(raw, opts = {}) {
  if (!raw || typeof raw !== 'object') return null
  const streams = (Array.isArray(raw.streams) ? raw.streams : []).filter(Boolean)
  const vs = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic))
  const video = vs ? classifyVideoStream(vs, opts) : null
  const audio = streams.filter((s) => s.codec_type === 'audio').map(classifyAudioStream).filter(Boolean)
  const main = pickMainAudio(audio)
  const objects = []
  for (const a of audio) if (a.objectAudio && !objects.includes(a.spatialFormat)) objects.push(a.spatialFormat)
  const badges = []
  if (video) badges.push(...video.badges)
  for (const o of objects) badges.push(o === 'DolbyAtmos' ? 'Atmos' : 'DTS:X')
  if (main) {
    // "TrueHD" / "DTS-HD MA" only when there is no object badge for that track already
    for (const b of main.badges) if (!badges.includes(b)) badges.push(b)
    if (main.layout && main.layout !== 'Stereo' && main.layout !== 'Mono') badges.push(main.layout)
  }
  return {
    version: CLASSIFY_VERSION,
    formatName: (raw.format && raw.format.format_name) || null,
    video,
    audio,
    mainAudioIndex: main ? main.streamIndex : null,
    objectAudio: objects,
    badges
  }
}

// ---------------------------------------------------------- extra ffprobe call
/**
 * Arguments of the small second ffprobe call that reveals per-frame HDR metadata (HDR10+) on the first
 * frames of the first video stream. Put the file arguments (ffmpegArgs.inputArgs(path)) after these.
 */
const FRAME_PROBE_ARGS = ['-v', 'error', '-select_streams', 'v:0', '-show_frames', '-read_intervals', '%+#3', '-show_entries', 'frame=side_data_list', '-of', 'json']

/** Is the extra call worth making? Only for codecs that carry HDR10+ and a PQ picture. */
function wantsFrameProbe(stream) {
  if (!stream) return false
  const codec = lower(stream.codec_name)
  if (!['hevc', 'av1', 'vp9'].includes(codec)) return false
  return lower(stream.color_transfer) === 'smpte2084'
}

/** ffprobe -show_frames JSON -> the side data type names seen (deduplicated). */
function parseFrameSideData(json) {
  const out = []
  for (const f of (json && Array.isArray(json.frames) ? json.frames : [])) {
    for (const t of sideTypes(f && f.side_data_list)) if (t && !out.includes(t)) out.push(t)
  }
  return out
}

// ------------------------------------------------------- Jellyfin vocabulary
/** Jellyfin's VideoRangeType for a classified video. */
function jellyfinVideoRangeType(video) {
  if (!video) return 'Unknown'
  const dv = video.dolbyVision
  if (dv) {
    if (dv.elPresent && dv.profile === 7) return video.hdr10Plus ? 'DOVIWithELHDR10Plus' : 'DOVIWithEL'
    if (video.hdr10Plus) return 'DOVIWithHDR10Plus'
    if (dv.profile === 5 || dv.baseLooksLike === 'None') return 'DOVI'
    if (dv.baseLooksLike === 'HLG') return 'DOVIWithHLG'
    if (dv.baseLooksLike === 'SDR') return 'DOVIWithSDR'
    if (dv.baseLooksLike === 'HDR10') return 'DOVIWithHDR10'
    return 'DOVI'
  }
  if (video.hdr10Plus) return 'HDR10Plus'
  if (video.hdrBase === 'PQ') return 'HDR10'
  if (video.hdrBase === 'HLG') return 'HLG'
  return 'SDR'
}

/** Jellyfin's AudioSpatialFormat: 'None' | 'DolbyAtmos' | 'DTSX'. */
function jellyfinAudioSpatialFormat(audio) {
  return audio && audio.spatialFormat ? audio.spatialFormat : 'None'
}

module.exports = {
  CLASSIFY_VERSION,
  FRAME_PROBE_ARGS,
  resolutionClass,
  bitDepthOf,
  chromaOf,
  dolbyVisionOf,
  classifyVideoStream,
  classifyAudioStream,
  classifyProbe,
  describeAudio,
  pickMainAudio,
  layoutLabel,
  wantsFrameProbe,
  parseFrameSideData,
  jellyfinVideoRangeType,
  jellyfinAudioSpatialFormat
}
