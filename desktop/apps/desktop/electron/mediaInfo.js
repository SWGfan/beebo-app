'use strict'
// ============================================================================
// mediaInfo.js - what is inside ONE video file, shaped for the details page.
// ----------------------------------------------------------------------------
// The page shows "Video: 1080p (HEVC Main 10)" and offers pickers for the audio
// track ("English (DTS 5.1)") and subtitles (Off + embedded + files next to the
// video). One ffprobe per file, run when the page opens.
//
// The probing and the raw track parsing are playbackTracks.js (the same code the
// player's Quality & audio sheet uses, so the picker's stream numbers are the
// numbers the player understands). This file adds the display wording, the
// subtitle files sitting beside the video, and a bounded cache that survives a
// restart. The library table view has its own probe cache; the two could be
// unified later, nothing here depends on it.
//
// Safe by construction: ffprobe is started with an argument array (no shell), a
// path must be absolute, free of control characters and never starts with "-",
// so a file called `a; rm -rf x.mkv` or `--help.mkv` is just a name.
// ============================================================================

const fs = require('fs')
const path = require('path')
const tracksLib = require('./playbackTracks')
const aiSubtitles = require('./aiSubtitles')
const classify = require('./mediaClassify')

const CACHE_FILE = 'media-info-cache.json'
const MAX_MEMORY = 300
const MAX_DISK = 1500
const SIDECAR_EXTS = new Set(['.srt', '.vtt'])

const VIDEO_CODEC_WORDS = {
  h264: 'H.264', avc: 'H.264', hevc: 'HEVC', h265: 'HEVC', av1: 'AV1', vp9: 'VP9', vp8: 'VP8',
  mpeg2video: 'MPEG-2', mpeg4: 'MPEG-4', msmpeg4v3: 'MPEG-4', vc1: 'VC-1', wmv3: 'WMV', theora: 'Theora', mjpeg: 'MJPEG'
}
// Short names for the picker ("English (DTS 5.1)"); playbackTracks' own labels are the long form.
const AUDIO_CODEC_WORDS = {
  aac: 'AAC', ac3: 'Dolby Digital', eac3: 'Dolby Digital Plus', dts: 'DTS', truehd: 'Dolby TrueHD', mp3: 'MP3',
  mp2: 'MP2', opus: 'Opus', vorbis: 'Vorbis', flac: 'FLAC', alac: 'Apple Lossless', pcm_s16le: 'PCM', pcm_s24le: 'PCM', pcm_s32le: 'PCM'
}

/** 1920x1080 -> "1080p", 1920x800 (scope) -> "1080p", 3840x2160 -> "4K". Null when the size is unknown. */
function resolutionLabel(width, height) {
  const w = Number(width) || 0
  const h = Number(height) || 0
  if (!w && !h) return null
  // A widescreen crop keeps the width of its tier but has fewer lines, so judge by whichever is bigger.
  const lines = Math.max(h, Math.round((w * 9) / 16))
  if (lines >= 2000) return '4K'
  if (lines >= 1400) return '1440p'
  if (lines >= 1000) return '1080p'
  if (lines >= 680) return '720p'
  if (lines >= 540) return '576p'
  if (lines >= 440) return '480p'
  return `${h || lines}p`
}

/** "hevc" + "Main 10" -> "HEVC Main 10". Unknown codecs are shown upper-cased rather than hidden. */
function videoCodecLabel(codec, profile) {
  const c = String(codec || '').toLowerCase()
  if (!c) return ''
  const name = VIDEO_CODEC_WORDS[c] || c.toUpperCase()
  const p = String(profile || '').trim()
  return p && p !== 'unknown' ? `${name} ${p}` : name
}

/** "Dolby Vision 8.1 / HDR10": every HDR format the picture carries, the Dolby Vision profile included. */
function hdrWords(video) {
  const formats = Array.isArray(video.hdrFormats) ? video.hdrFormats : []
  if (!formats.length) return video.hdr ? 'HDR' : ''
  const dv = video.dolbyVision
  return formats.map((f) => (f === 'Dolby Vision' && dv && dv.label ? `Dolby Vision ${dv.label}` : f)).join(' / ')
}

/** The one-line "Video" value: "1080p (HEVC Main 10)", "4K (HEVC Main 10, Dolby Vision 8.1 / HDR10)". */
function describeVideo(video) {
  if (!video) return null
  const res = resolutionLabel(video.width, video.height)
  const codec = videoCodecLabel(video.codec, video.profile)
  const bits = [codec, hdrWords(video)].filter(Boolean).join(', ')
  const label = res && bits ? `${res} (${bits})` : res || bits || null
  return {
    label,
    resolution: res,
    width: video.width || null,
    height: video.height || null,
    codec: video.codec || null,
    profile: video.profile || null,
    fps: video.fps || null,
    hdr: !!video.hdr,
    // Precise picture facts (mediaClassify.js).
    hdrType: video.hdrType || (video.hdr ? 'HDR10' : 'SDR'),
    hdrFormats: video.hdrFormats || [],
    dolbyVision: video.dolbyVision ? { profile: video.dolbyVision.profile, label: video.dolbyVision.label, level: video.dolbyVision.level, compatId: video.dolbyVision.compatId, baseLooksLike: video.dolbyVision.baseLooksLike, elPresent: video.dolbyVision.elPresent } : null,
    hdr10Plus: !!video.hdr10Plus,
    bitDepth: video.bitDepth || null,
    resolutionClass: video.resolutionClass || null,
    colorPrimaries: video.colorPrimaries || null,
    colorTransfer: video.colorTransfer || null,
    bitrateKbps: video.bitrateKbps || null
  }
}

function audioCodecWord(codec, profile) {
  const c = String(codec || '').toLowerCase()
  const p = String(profile || '')
  // Object audio is worth naming in the picker ("English (Dolby TrueHD Atmos 7.1)").
  if (/atmos/i.test(p)) return c === 'truehd' ? 'Dolby TrueHD Atmos' : 'Dolby Digital Plus Atmos'
  if (c === 'dts' && /dts:x/i.test(p)) return 'DTS:X'
  // ffprobe names the DTS family by profile: "DTS-HD MA", "DTS-HD HRA", "DTS-ES".
  if (c === 'dts' && /dts-hd/i.test(p)) return /ma/i.test(p) ? 'DTS-HD MA' : 'DTS-HD'
  return AUDIO_CODEC_WORDS[c] || (c ? c.toUpperCase() : '')
}

/** 6 -> "5.1", 2 -> "Stereo" (the channel wording playbackTracks uses). */
function channelLabel(channels) {
  return tracksLib.channelWords(channels)
}

function audioLabel({ language, codec, profile, channels, title }) {
  const lang = tracksLib.languageName(language) || 'Unknown language'
  const tech = [audioCodecWord(codec, profile), channelLabel(channels)].filter(Boolean).join(' ')
  let label = tech ? `${lang} (${tech})` : lang
  const t = String(title || '').trim()
  // A title that only repeats the codec ("DTS 5.1") adds nothing; "Director's Commentary" does.
  if (t && t.length <= 40 && !/^(dts|dolby|ac-?3|aac|truehd|flac|stereo|surround|mono)\b/i.test(t) && !label.toLowerCase().includes(t.toLowerCase())) label += ` · ${t}`
  return label
}

function subtitleLabel({ languageName, forced, hearingImpaired, kind, title, codecName }) {
  let label = languageName || 'Unknown language'
  if (forced) label += ' (Forced)'
  if (hearingImpaired) label += ' (SDH)'
  const t = String(title || '').trim()
  if (t && !/^(forced|sdh|cc)$/i.test(t) && t.length <= 40 && !label.toLowerCase().includes(t.toLowerCase())) label += ` · ${t}`
  if (kind === 'image') label += ' · picture'
  else if (codecName && kind === 'text') label += ` · ${codecName}`
  return label
}

/**
 * Raw ffprobe JSON -> { durationSec, video, audio: [...], subtitles: [...] }.
 * audio[i]     { ordinal, streamIndex, label, language, languageName, codec, channels, isDefault }
 * subtitles[i] { key, source: 'embedded', streamIndex, label, language, kind: 'text' | 'image', forced, hearingImpaired, isDefault }
 * Subtitle codecs the player cannot show at all are left out. Sidecar files are added by describeFile.
 */
function describeProbe(rawProbe, opts = {}) {
  const parsed = tracksLib.parseTracks(rawProbe, { frameSideData: opts.frameSideData })
  if (!parsed) return null
  const profileByIndex = new Map()
  for (const s of (rawProbe && Array.isArray(rawProbe.streams)) ? rawProbe.streams : []) {
    if (s && typeof s.index === 'number') profileByIndex.set(s.index, s.profile || '')
  }
  const audio = parsed.audio.map((a) => ({
    ordinal: a.ordinal,
    streamIndex: a.streamIndex,
    label: audioLabel({ language: a.language, codec: a.codec, profile: profileByIndex.get(a.streamIndex), channels: a.channels, title: a.title }),
    language: a.language,
    languageName: a.languageName,
    codec: a.codec,
    channels: a.channels,
    isDefault: !!a.isDefault,
    // What the track is (mediaClassify.js): "Dolby TrueHD + Dolby Atmos", 7.1, lossless, object audio.
    formatName: a.formatName || null,
    family: a.family || null,
    layout: a.layout || null,
    lossless: !!a.lossless,
    objectAudio: a.objectAudio || null,
    spatialFormat: a.spatialFormat || 'None'
  }))
  const subtitles = parsed.subtitles
    .filter((s) => s.kind !== 'unsupported')
    .map((s) => ({
      key: `emb:${s.streamIndex}`,
      source: 'embedded',
      streamIndex: s.streamIndex,
      label: subtitleLabel(s),
      language: s.language,
      languageName: s.languageName,
      kind: s.kind,
      forced: s.forced,
      hearingImpaired: s.hearingImpaired,
      isDefault: !!s.isDefault
    }))
  const whole = classify.classifyProbe(rawProbe, { frameSideData: opts.frameSideData })
  return {
    classifyVersion: classify.CLASSIFY_VERSION,
    durationSec: parsed.durationSec,
    video: describeVideo(parsed.video),
    audio,
    subtitles,
    // "4K", "Dolby Vision", "HDR10+", "Atmos", "7.1": the short labels for the details page and every list.
    badges: whole ? whole.badges : []
  }
}

/**
 * Subtitle files next to the video: `<name>.srt`, `<name>.en.srt`, `<name>.en.forced.srt`, `<name>.en.2.srt`.
 * Keys are `side:<lang>#<n>`, n counting that language's files in the order the player lists them (.vtt before
 * .srt, then directory order), which is how the player's own sidecar list is ordered.
 */
function findSidecarSubtitles(filePath, fsImpl = fs) {
  let names
  try { names = fsImpl.readdirSync(path.dirname(filePath)) } catch { return [] }
  const base = path.basename(filePath, path.extname(filePath))
  const baseLc = base.toLowerCase()
  const found = []
  for (const name of names) {
    const ext = path.extname(name).toLowerCase()
    if (!SIDECAR_EXTS.has(ext)) continue
    const stem = path.basename(name, ext)
    const stemLc = stem.toLowerCase()
    if (stemLc !== baseLc && !stemLc.startsWith(baseLc + '.')) continue
    let language = ''
    let forced = false
    let sdh = false
    let copy = ''
    let ai = false
    if (stem.length > base.length + 1) {
      const parts = stem.slice(base.length + 1).split('.').filter(Boolean)
      language = (parts[0] || '').toLowerCase()
      const rest = parts.slice(1).map((x) => x.toLowerCase())
      forced = rest.includes('forced')
      sdh = rest.includes('sdh') || rest.includes('cc')
      ai = rest.some(aiSubtitles.isAiQualifier) // "Name.en.ai.srt" - made by the Speech Pack
      copy = rest.find((x) => /^\d{1,2}$/.test(x)) || ''
    }
    found.push({ name, ext, language, forced, sdh, copy, ai })
  }
  found.sort((a, b) => (a.ext === '.vtt' ? 0 : 1) - (b.ext === '.vtt' ? 0 : 1))
  const seen = new Set()
  const perLang = new Map()
  const out = []
  for (const f of found) {
    const dedupe = `${f.language}|${f.forced}|${f.sdh}|${f.copy}|${f.ai}`
    if (seen.has(dedupe)) continue
    seen.add(dedupe)
    const n = perLang.get(f.language) || 0
    perLang.set(f.language, n + 1)
    const languageName = tracksLib.languageName(f.language)
    let label = languageName || 'Subtitles'
    if (f.forced) label += ' (Forced)'
    if (f.sdh) label += ' (SDH)'
    if (f.copy) label += ` #${f.copy}`
    if (f.ai) label += aiSubtitles.AI_LABEL_SUFFIX
    out.push({
      key: `side:${f.language}#${n}`,
      source: 'file',
      label: `${label} · file`,
      language: f.language,
      languageName,
      kind: 'text',
      forced: f.forced,
      hearingImpaired: f.sdh,
      aiGenerated: f.ai,
      isDefault: false
    })
  }
  return out
}

/** A path safe to hand to ffprobe as its last argument. */
function isSafeMediaPath(filePath) {
  if (typeof filePath !== 'string' || !filePath || filePath.length > 4096) return false
  if (filePath.includes('\0') || /[\r\n]/.test(filePath)) return false
  if (!path.isAbsolute(filePath)) return false
  if (filePath.startsWith('-')) return false
  return true
}

function readDiskCache(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    return data && typeof data === 'object' && data.entries && typeof data.entries === 'object' ? data.entries : {}
  } catch {
    return {}
  }
}

/**
 * createMediaInfo({ ffprobePath, getCacheDir, execFileFn, fsImpl, now })
 *   .info(filePath) -> { ok: true, ...describeProbe, subtitles: [...embedded, ...files] }
 *                   |  { ok: false, error: 'bad_path' | 'not_found' | 'no_ffprobe' | 'unreadable' }
 * Results are kept in memory (MAX_MEMORY files) and in media-info-cache.json in getCacheDir()
 * (MAX_DISK files, oldest dropped), keyed by path + size + modified time so an edited file is re-read.
 */
function createMediaInfo({ ffprobePath, getCacheDir, execFileFn, fsImpl = fs, now = () => Date.now() } = {}) {
  const prober = tracksLib.createTrackProber({ ffprobePath, execFileFn, maxEntries: MAX_MEMORY })
  const memory = new Map()
  const inFlight = new Map()
  let disk = null
  let diskDir = null

  const resolveFfprobe = () => (typeof ffprobePath === 'function' ? ffprobePath() : ffprobePath)

  function loadDisk() {
    const dir = typeof getCacheDir === 'function' ? getCacheDir() : null
    if (!dir) return null
    if (disk && diskDir === dir) return disk
    diskDir = dir
    disk = readDiskCache(path.join(dir, CACHE_FILE))
    return disk
  }

  function saveDisk() {
    if (!disk || !diskDir) return
    const keys = Object.keys(disk)
    if (keys.length > MAX_DISK) {
      keys.sort((a, b) => (disk[a].at || 0) - (disk[b].at || 0))
      for (const k of keys.slice(0, keys.length - MAX_DISK)) delete disk[k]
    }
    try {
      fs.mkdirSync(diskDir, { recursive: true })
      const file = path.join(diskDir, CACHE_FILE)
      const tmp = `${file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, entries: disk }))
      fs.renameSync(tmp, file)
    } catch {
      // a failed write only means the next open probes again
    }
  }

  async function describeFile(filePath, key) {
    const persisted = loadDisk()
    // An entry written before the classification existed lacks HDR10+ / Dolby Vision / Atmos: read the file again.
    if (persisted && persisted[key] && persisted[key].d && persisted[key].d.classifyVersion === classify.CLASSIFY_VERSION) {
      persisted[key].at = now()
      return persisted[key].d
    }
    if (!resolveFfprobe()) return { error: 'no_ffprobe' }
    const tracks = await prober.probe(filePath)
    const described = tracks ? describeProbe(tracks.raw, { frameSideData: tracks.frameSideData }) : null
    if (!described) return { error: 'unreadable' }
    if (persisted) {
      persisted[key] = { at: now(), d: described }
      saveDisk()
    }
    return described
  }

  async function info(filePath) {
    if (!isSafeMediaPath(filePath)) return { ok: false, error: 'bad_path' }
    let st
    try { st = fsImpl.statSync(filePath) } catch { return { ok: false, error: 'not_found' } }
    if (!st.isFile()) return { ok: false, error: 'not_found' }
    const key = `${filePath}|${st.size}|${st.mtimeMs}`
    let described = memory.get(key)
    if (!described) {
      if (!inFlight.has(key)) {
        inFlight.set(key, describeFile(filePath, key).finally(() => inFlight.delete(key)))
      }
      described = await inFlight.get(key)
      if (described && !described.error) {
        memory.set(key, described)
        while (memory.size > MAX_MEMORY) memory.delete(memory.keys().next().value)
      }
    }
    // Files beside the video can change without the video changing, so they are looked up on every open.
    const sidecars = findSidecarSubtitles(filePath, fsImpl)
    if (described && described.error) {
      return { ok: false, error: described.error, subtitles: sidecars }
    }
    return { ok: true, ...described, subtitles: [...described.subtitles, ...sidecars] }
  }

  return { info }
}

module.exports = {
  createMediaInfo,
  describeProbe,
  describeVideo,
  hdrWords,
  resolutionLabel,
  videoCodecLabel,
  audioLabel,
  subtitleLabel,
  findSidecarSubtitles,
  isSafeMediaPath,
  CACHE_FILE,
  MAX_MEMORY,
  MAX_DISK
}
