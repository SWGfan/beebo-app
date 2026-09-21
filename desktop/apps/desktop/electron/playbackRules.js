'use strict'
// ============================================================================
// playbackRules.js - does this file REALLY need converting, and how much work is it?
// ----------------------------------------------------------------------------
// The old rule decided MKV and AVI by extension alone, so a library full of
// ordinary H.264/AAC .mkv files was queued even though every phone and TV here
// already played them. This module decides from the streams inside the file.
//
// Who has to play the file:
//   * The Android app: Media3 / ExoPlayer 1.4 with platform decoders only (no
//     FFmpeg extension). https://developer.android.com/media/media3/exoplayer/supported-formats
//     lists MP4, WebM, Matroska, MPEG-TS, Ogg containers (AVI is not supported),
//     platform H.264, HEVC, VP9 (and AV1 on Android 10+), and platform AAC, MP3,
//     AC-3, E-AC-3, Opus, Vorbis, FLAC. DTS and TrueHD only via extensions we do
//     not ship. https://developer.android.com/media/platform/supported-formats:
//     HEVC decoder since Android 5, VP9 since 4.4, AV1 since 10.
//   * Google Cast (https://developers.google.com/cast/docs/media): H.264 High
//     profile (level 4.1 on 1st/2nd gen, 5.1 on Chromecast with Google TV),
//     HEVC Main AND Main10 up to 5.1 on Chromecast Ultra / with Google TV /
//     Google TV Streamer, VP9 profile 0/2, AV1 on the Streamer; audio AAC, MP3,
//     Opus, Vorbis, FLAC, with AC-3 / E-AC-3 as passthrough.
//
// Decisions (documented in the tests too):
//   * Containers MP4/MOV/M4V, Matroska/WebM and MPEG-TS play as they are. MKV is
//     not on Cast's list, but it is on ExoPlayer's and in practice the Google TV
//     receivers play it (the owner casts his MKVs every day). AVI, ASF/WMV, FLV,
//     MPEG-PS, OGM, RealMedia -> remux into MP4 when the streams are fine.
//   * HEVC Main and Main10 play as they are: both are on every Cast device that
//     has HEVC at all, and every phone from the last several years decodes them
//     in hardware. Old 1st-3rd gen Chromecasts cannot do HEVC of any bit depth;
//     a device that fails reports it, and that report queues the file.
//   * H.264 Hi10P / 4:2:2 / 4:4:4, HEVC range extensions, and levels above 5.1
//     are re-encoded; so are MPEG-2, MPEG-4 Part 2 (DivX/Xvid), VC-1/WMV, H.263,
//     Theora, MJPEG, RealVideo, ProRes and friends.
//   * AC-3 / E-AC-3 are left alone (platform decoder on Android, passthrough on
//     Cast). DTS, TrueHD, MP2, WMA, 24-bit PCM, ALAC -> audio-only fix to AAC.
//     When a file has several audio tracks it is fine if ANY track plays:
//     ExoPlayer's track selector skips tracks the phone cannot decode.
//   * Subtitles never cause a conversion.
//   * Interlacing alone never causes a conversion: hardware decoders deinterlace
//     or show it as-is, it does not stop playback.
//
// "Strict" mode is the universal target used when a device has actually failed
// or the owner pressed "Convert anyway": MP4 + H.264 (8-bit 4:2:0, level <= 4.1)
// + AAC/MP3, which every Cast generation and every phone plays.
// ============================================================================

const path = require('path')

const RULES_VERSION = 2

const ACTION_RANK = { none: 0, remux: 1, audio: 2, video: 3 }

const CODEC_NAMES = {
  h264: 'H.264', hevc: 'HEVC (H.265)', vp8: 'VP8', vp9: 'VP9', av1: 'AV1',
  mpeg2video: 'MPEG-2', mpeg1video: 'MPEG-1', mpeg4: 'MPEG-4 Part 2 (DivX/Xvid)',
  msmpeg4v1: 'Microsoft MPEG-4 v1', msmpeg4v2: 'Microsoft MPEG-4 v2', msmpeg4v3: 'DivX 3 (MS MPEG-4 v3)',
  wmv1: 'WMV 7', wmv2: 'WMV 8', wmv3: 'WMV 9', vc1: 'VC-1', h263: 'H.263', flv1: 'Flash video (Sorenson)',
  theora: 'Theora', mjpeg: 'Motion JPEG', prores: 'ProRes', dvvideo: 'DV', rv40: 'RealVideo', rv30: 'RealVideo',
  aac: 'AAC', mp3: 'MP3', mp2: 'MP2', opus: 'Opus', vorbis: 'Vorbis', flac: 'FLAC', ac3: 'Dolby Digital (AC-3)',
  eac3: 'Dolby Digital Plus (E-AC-3)', dts: 'DTS', truehd: 'Dolby TrueHD', wmav1: 'WMA', wmav2: 'WMA', wmapro: 'WMA Pro',
  alac: 'Apple Lossless', cook: 'RealAudio', pcm_s16le: 'PCM', pcm_s24le: '24-bit PCM', pcm_bluray: 'Blu-ray PCM', pcm_dvd: 'DVD PCM'
}
const codecName = (c) => CODEC_NAMES[c] || String(c || 'unknown').toUpperCase()

// ------------------------------------------------------------------ probing
// ffprobe arguments that give decide() everything it needs.
const FFPROBE_ARGS = [
  '-v', 'error',
  '-show_entries', 'stream=index,codec_type,codec_name,profile,level,pix_fmt,bits_per_raw_sample,field_order,channels:stream_disposition=default,attached_pic',
  '-show_entries', 'format=format_name,duration',
  '-of', 'json'
]

// Raw ffprobe JSON -> the compact probe decide() reads. Also keeps the legacy
// fields (videoCodec, audioCodec, videoLevel, videoPixFmt, hasAudio, durationSec)
// that older callers and caches use.
function normalizeProbe(parsed) {
  if (!parsed || typeof parsed !== 'object') return null
  const streams = Array.isArray(parsed.streams) ? parsed.streams : []
  const num = (v) => (typeof v === 'number' ? v : (v != null && v !== '' && !isNaN(Number(v)) ? Number(v) : null))
  const videos = streams
    .filter((s) => s && s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic))
    .map((s) => ({ codec: s.codec_name || null, profile: s.profile || null, level: num(s.level), pixFmt: s.pix_fmt || null, bits: num(s.bits_per_raw_sample), fieldOrder: s.field_order || null }))
  const audios = streams
    .filter((s) => s && s.codec_type === 'audio')
    .map((s) => ({ index: num(s.index), codec: s.codec_name || null, profile: s.profile || null, channels: num(s.channels), isDefault: !!(s.disposition && s.disposition.default) }))
  const subs = streams
    .filter((s) => s && s.codec_type === 'subtitle')
    .map((s) => ({ index: num(s.index), codec: s.codec_name || null }))
  const format = parsed.format || {}
  const v = videos[0]
  const a = audios[0]
  return {
    formatName: format.format_name || null,
    durationSec: parseFloat(format.duration) || 0,
    videos, audios, subs,
    videoCodec: v ? v.codec : null,
    videoLevel: v ? v.level : null,
    videoPixFmt: v ? v.pixFmt : null,
    videoProfile: v ? v.profile : null,
    audioCodec: a ? a.codec : null,
    hasAudio: audios.length > 0
  }
}

// Old cached probes only have the flat fields. Treat them as a one-video,
// one-audio file so a cache from the previous release still gives an answer.
function streamsOf(probe) {
  if (!probe) return { videos: [], audios: [], subs: [] }
  const videos = Array.isArray(probe.videos) ? probe.videos
    : (probe.videoCodec ? [{ codec: probe.videoCodec, profile: probe.videoProfile || null, level: probe.videoLevel, pixFmt: probe.videoPixFmt, bits: null }] : [])
  const audios = Array.isArray(probe.audios) ? probe.audios
    : (probe.hasAudio || probe.audioCodec ? [{ codec: probe.audioCodec, channels: null, index: null }] : [])
  const subs = Array.isArray(probe.subs) ? probe.subs : []
  return { videos, audios, subs }
}

// --------------------------------------------------------------- the rules
const MP4_FAMILY = new Set(['.mp4', '.m4v', '.mov'])
const OK_EXT = new Set(['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.ts', '.m2ts', '.mts'])

function containerOf(probe, ext) {
  const f = String((probe && probe.formatName) || '').toLowerCase()
  if (f.includes('mp4') || f.includes('mov')) return 'mp4'
  if (f.includes('matroska') || f.includes('webm')) return 'mkv'
  if (f === 'mpegts') return 'ts'
  if (f) return f.split(',')[0]
  const e = String(ext || '').toLowerCase()
  if (MP4_FAMILY.has(e)) return 'mp4'
  if (e === '.mkv' || e === '.webm') return 'mkv'
  if (e === '.ts' || e === '.m2ts' || e === '.mts') return 'ts'
  return e.replace(/^\./, '') || 'unknown'
}
const CONTAINER_WORDS = { avi: 'AVI', asf: 'WMV/ASF', flv: 'FLV', mpeg: 'MPEG program stream (.mpg/.vob)', ogg: 'Ogg', rm: 'RealMedia', mkv: 'MKV', mp4: 'MP4', ts: 'MPEG-TS' }

const is420_8 = (pf) => !pf || pf === 'yuv420p' || pf === 'yuvj420p' || pf === 'nv12'
const is420_8or10 = (pf) => is420_8(pf) || pf === 'yuv420p10le' || pf === 'yuv420p10be' || pf === 'p010le'

// -> null when this video stream plays as it is, else a plain-English reason.
function videoProblem(v, strict) {
  if (!v || !v.codec) return null
  const c = v.codec
  const profile = String(v.profile || '')
  if (c === 'h264') {
    if (/high 10|4:2:2|4:4:4|cavlc 4:4:4/i.test(profile) || !is420_8(v.pixFmt) || (v.bits && v.bits > 8)) {
      return `Video is H.264 ${profile || v.pixFmt || '10-bit'}, a professional variant phones and TVs can't decode`
    }
    const cap = strict ? 41 : 51
    if (typeof v.level === 'number' && v.level > cap) {
      return `Video is H.264 at level ${(v.level / 10).toFixed(1)}, above what ${strict ? 'older Chromecasts' : 'phones and TVs'} decode`
    }
    return null
  }
  if (strict) return `Video is ${codecName(c)}, which older Chromecasts can't play`
  if (c === 'hevc') {
    if (/rext|4:2:2|4:4:4|12/i.test(profile) || !is420_8or10(v.pixFmt)) return `Video is HEVC ${profile || v.pixFmt}, a variant phones and TVs can't decode`
    if (typeof v.level === 'number' && v.level > 153) return 'Video is HEVC above level 5.1, beyond what phones and TVs decode'
    return null
  }
  if (c === 'vp8') return null
  if (c === 'vp9') return is420_8or10(v.pixFmt) ? null : `Video is VP9 ${v.pixFmt}, a variant phones and TVs can't decode`
  if (c === 'av1') return is420_8or10(v.pixFmt) ? null : `Video is AV1 ${v.pixFmt}, a variant phones and TVs can't decode`
  return `Video is ${codecName(c)}, which phones and TVs can't play`
}

const AUDIO_OK = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'ac3', 'eac3', 'pcm_s16le', 'pcm_u8'])
const AUDIO_OK_STRICT = new Set(['aac', 'mp3'])
const audioOk = (a, strict) => !!(a && a.codec && (strict ? AUDIO_OK_STRICT : AUDIO_OK).has(a.codec))

function estimateSeconds(action, durationSec) {
  const d = Number(durationSec) > 0 ? Number(durationSec) : 45 * 60
  if (action === 'remux') return Math.round(Math.max(30, d / 200))
  if (action === 'audio') return Math.round(Math.max(60, d / 60 + d / 200))
  // Rough: the owner's PC re-encoded a 95-minute Xvid film in about 3 minutes (~30x real time)
  // with libopenh264; 20x leaves room for slower machines.
  if (action === 'video') return Math.round(Math.max(120, d / 20))
  return 0
}
function aboutTime(sec) {
  const m = Math.max(1, Math.round((Number(sec) || 0) / 60))
  return m === 1 ? 'about 1 minute' : `about ${m} minutes`
}
const WORK_WORDS = { remux: 'fast remux', audio: 'fast audio fix', video: 'full re-encode' }

// decide(probe, ext, { strict }) -> {
//   action: 'none' | 'remux' | 'audio' | 'video' | 'unknown',
//   container, videoReason, audioReason, containerReason,
//   estimateSec, work ('fast remux' | 'fast audio fix' | 'full re-encode' | ''),
//   reason (one plain-English sentence), rulesVersion }
function decide(probe, ext, opts = {}) {
  const strict = !!(opts && opts.strict)
  const e = String(ext || '').toLowerCase()
  if (!probe) {
    return { action: 'unknown', reason: "Couldn't read this file's streams, so it was left alone", work: '', estimateSec: 0, rulesVersion: RULES_VERSION }
  }
  const { videos, audios } = streamsOf(probe)
  const container = containerOf(probe, e)
  const v = videos[0]
  const videoReason = v ? videoProblem(v, strict) : null
  let audioReason = null
  if (audios.length && !audios.some((a) => audioOk(a, strict))) {
    const names = Array.from(new Set(audios.map((a) => codecName(a.codec))))
    audioReason = `Audio is ${names.join(' / ')}, which ${strict ? 'older Chromecasts' : 'phones'} can't play`
  }
  let containerReason = null
  if (strict) {
    if (container !== 'mp4') containerReason = `The ${CONTAINER_WORDS[container] || container.toUpperCase()} container isn't on every TV's list`
  } else if (!['mp4', 'mkv', 'ts'].includes(container) || (!probe.formatName && e && !OK_EXT.has(e))) {
    containerReason = `The ${CONTAINER_WORDS[container] || container.toUpperCase()} container isn't supported by phones or TVs`
  }
  if (!v) {
    // Audio-only or damaged: nothing a video conversion would fix.
    return { action: 'none', container, reason: 'No video stream', work: '', estimateSec: 0, rulesVersion: RULES_VERSION }
  }
  let action = 'none'
  if (videoReason) action = 'video'
  else if (audioReason) action = 'audio'
  else if (containerReason) action = 'remux'
  const dur = Number(probe.durationSec) || 0
  const estimateSec = estimateSeconds(action, dur)
  const work = WORK_WORDS[action] || ''
  let reason = 'Plays as it is'
  if (action === 'video') reason = `${videoReason}: ${work}, ${aboutTime(estimateSec)}`
  else if (action === 'audio') reason = `${audioReason}: ${work}, ${aboutTime(estimateSec)}`
  else if (action === 'remux') reason = `${containerReason}, but the picture and sound are fine: ${work}, ${aboutTime(estimateSec)}`
  return { action, strict, container, videoReason, audioReason, containerReason, estimateSec, work, reason, rulesVersion: RULES_VERSION }
}

const needsWork = (d) => !!d && (d.action === 'remux' || d.action === 'audio' || d.action === 'video')

// ffmpeg codec/map arguments for a decision. Output is always an MP4.
//   remux : copy everything that fits in MP4 (video, all audio, text subtitles as mov_text)
//   audio : copy the video, add an AAC track first, keep the original audio as a
//           second track when MP4 can hold it (DTS, AC-3, E-AC-3)
//   video : re-encode to 8-bit H.264 (libopenh264, LGPL), audio copied when it
//           plays, else AAC
function planArgs(decision, probe) {
  const d = decision || { action: 'video' }
  const { audios, subs } = streamsOf(probe)
  const strict = !!d.strict
  const textSubs = (subs || []).filter((s) => ['subrip', 'ass', 'ssa', 'mov_text', 'webvtt', 'text'].includes(s.codec) && s.index != null)
  const subArgs = []
  for (const s of textSubs) subArgs.push('-map', `0:${s.index}`)
  if (textSubs.length) subArgs.push('-c:s', 'mov_text')
  const goodAudio = audios.find((a) => audioOk(a, strict))
  const firstAudio = audios[0]
  const aacChannels = (a) => (a && a.channels && a.channels > 6 ? ['-ac:a:0', '6'] : [])
  const aacRate = (a) => (a && a.channels && a.channels > 2 ? '384k' : '192k')
  const mapAudio = (a) => (a && a.index != null ? `0:${a.index}` : '0:a:0?')

  if (d.action === 'remux' || d.action === 'none') {
    const args = ['-map', '0:v:0']
    for (const a of audios.filter((x) => audioOk(x, strict))) args.push('-map', mapAudio(a))
    if (!audios.length) args.push('-map', '0:a:0?')
    args.push(...subArgs, '-c:v', 'copy', '-c:a', 'copy')
    return { mode: 'remux', args }
  }
  if (d.action === 'audio') {
    const args = ['-map', '0:v:0', '-map', mapAudio(firstAudio)]
    const keep = firstAudio && ['dts', 'ac3', 'eac3'].includes(firstAudio.codec) && !strict
    if (keep) args.push('-map', mapAudio(firstAudio))
    args.push(...subArgs, '-c:v', 'copy', '-c:a:0', 'aac', '-b:a:0', aacRate(firstAudio), ...aacChannels(firstAudio))
    if (keep) args.push('-c:a:1', 'copy', '-disposition:a:1', '0', '-strict', '-2')
    args.push('-disposition:a:0', 'default')
    return { mode: 'audio-only', args }
  }
  // full re-encode
  const a = goodAudio || firstAudio
  const args = ['-map', '0:v:0', '-map', a ? mapAudio(a) : '0:a:0?']
  args.push(...subArgs, '-c:v', 'libopenh264', '-b:v', '2500k', '-pix_fmt', 'yuv420p')
  // Unknown streams (the probe failed): re-encode whatever first audio there is to AAC.
  args.push(...(goodAudio ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', aacRate(a), ...aacChannels(a)]))
  return { mode: 'full', args }
}

// ------------------------------------------------------- real-world evidence
// A watch-history session counts as "it played" once it got past 5 minutes, or
// 20% of a short file. History rows name the file relative to its library folder
// (movie fileName or TV relPath); queue entries hold the absolute path.
const KNOWN_GOOD_SECONDS = 300
const KNOWN_GOOD_FRACTION = 0.2

function normRel(p) { return String(p || '').replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase() }

function playedSessionsIndex(historyRows) {
  const idx = new Map()
  for (const r of Array.isArray(historyRows) ? historyRows : []) {
    if (!r || !r.fileName) continue
    const t = Number(r.currentTime) || 0
    const dur = Number(r.duration) || 0
    const good = t >= KNOWN_GOOD_SECONDS || (dur > 0 && t / dur >= KNOWN_GOOD_FRACTION && t >= 60)
    if (!good) continue
    const key = normRel(r.fileName)
    const prev = idx.get(key)
    if (!prev || t > prev.seconds) idx.set(key, { seconds: t, at: Number(r.lastUpdate) || Number(r.startedAt) || 0, title: r.title || '' })
  }
  return idx
}

// Is this absolute path one that already played for real? Matches the history's
// relative name against the end of the path (on a folder boundary).
function knownGoodFor(index, filePath) {
  if (!index || !index.size || !filePath) return null
  const full = normRel(filePath)
  const parts = full.split('/')
  for (let i = parts.length - 1; i >= 0; i--) {
    const hit = index.get(parts.slice(i).join('/'))
    if (hit) return hit
  }
  return null
}

module.exports = {
  RULES_VERSION,
  ACTION_RANK,
  FFPROBE_ARGS,
  KNOWN_GOOD_SECONDS,
  KNOWN_GOOD_FRACTION,
  normalizeProbe,
  decide,
  needsWork,
  planArgs,
  estimateSeconds,
  aboutTime,
  codecName,
  playedSessionsIndex,
  knownGoodFor
}
