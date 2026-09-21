'use strict'
// ============================================================================
// playbackDecision.js - DIRECT PLAY, DIRECT STREAM or TRANSCODE, decided stream by stream.
// ----------------------------------------------------------------------------
// Pure: no process is started and no file is read. Inputs are what the file IS (playbackTracks.parseTracks
// output, i.e. mediaClassify.js facts), what the device CAN do (deviceProfile.js), what the owner allows
// (homeTheaterSettings.js) and what the viewer asked for. The answer is a plan, with a machine-readable
// list of reasons:
//
//   DirectPlay    the device plays the ORIGINAL FILE as it is (HTTP range requests, no ffmpeg at all).
//   DirectStream  a remux: the picture and (where the device can) the sound are COPIED, untouched, into
//                 fragmented MP4 / HLS (hlsRemux.js). Cheap: no encoder runs. Used when only the container,
//                 the Dolby Vision profile or one audio stream needs work ("audio codec not supported ->
//                 transcode audio only").
//   Transcode     the picture is re-encoded (H.264, SDR - HDR is tone-mapped) by the live conversion
//                 (hlsTranscoder.js). Sound is still decided separately: copied when the device plays it.
//
// Video and audio are judged separately, so a 4K Dolby Vision film with a DTS-HD MA track on a device that plays
// Dolby Vision but not DTS becomes DirectStream: video copied (Dolby Vision kept), audio converted to Dolby
// Digital Plus. `reasons` says why, in words and in codes.
//
// What is deliberately NOT decided here: whether ffmpeg can do it on this computer (the caller passes
// `remuxAvailable`) and encoder choice (encoderCapabilities.js).
// ============================================================================

const dp = require('./deviceProfile')

// Audio codecs the HLS / fMP4 carriage can hold as they are, and the most channels each is copied with.
// (TrueHD and DTS can be written to fMP4 by ffmpeg but no HLS player plays them: see docs/HOME-THEATER.md.)
const HLS_FMP4_COPY = { aac: 8, ac3: 6, eac3: 8 }
const HLS_TS_COPY_CHANNELS = 6
const REMUX_VIDEO = new Set(['h264', 'hevc'])
const SURROUND_ENCODER_ORDER = ['eac3', 'ac3', 'aac']

const REASONS = Object.freeze({
  FORCED_TRANSCODE: 'FORCED_TRANSCODE',
  DIRECT_PLAY_NOT_PREFERRED: 'DIRECT_PLAY_NOT_PREFERRED',
  DIRECT_STREAM_OFF: 'DIRECT_STREAM_OFF',
  NO_STREAMING_FORMAT: 'NO_STREAMING_FORMAT',
  QUALITY_REQUESTED: 'QUALITY_REQUESTED',
  AWAY_QUALITY_CAP: 'AWAY_QUALITY_CAP',
  SUBTITLE_BURN_IN: 'SUBTITLE_BURN_IN',
  BITRATE_EXCEEDS_LIMIT: 'BITRATE_EXCEEDS_LIMIT',
  CONTAINER_NOT_SUPPORTED: 'CONTAINER_NOT_SUPPORTED',
  VIDEO_CODEC_NOT_SUPPORTED: 'VIDEO_CODEC_NOT_SUPPORTED',
  VIDEO_PROFILE_NOT_SUPPORTED: 'VIDEO_PROFILE_NOT_SUPPORTED',
  VIDEO_LEVEL_TOO_HIGH: 'VIDEO_LEVEL_TOO_HIGH',
  VIDEO_BIT_DEPTH_NOT_SUPPORTED: 'VIDEO_BIT_DEPTH_NOT_SUPPORTED',
  VIDEO_CHROMA_NOT_SUPPORTED: 'VIDEO_CHROMA_NOT_SUPPORTED',
  RESOLUTION_TOO_HIGH: 'RESOLUTION_TOO_HIGH',
  FRAMERATE_TOO_HIGH: 'FRAMERATE_TOO_HIGH',
  HDR_NOT_SUPPORTED: 'HDR_NOT_SUPPORTED',
  HDR_LOST_IN_TRANSCODE: 'HDR_LOST_IN_TRANSCODE',
  DV_PROFILE_NOT_SUPPORTED: 'DV_PROFILE_NOT_SUPPORTED',
  DV_PROFILE5_NO_FALLBACK: 'DV_PROFILE5_NO_FALLBACK',
  DV_BASE_LAYER_FALLBACK: 'DV_BASE_LAYER_FALLBACK',
  HDR10PLUS_PLAYS_AS_HDR10: 'HDR10PLUS_PLAYS_AS_HDR10',
  AUDIO_CODEC_NOT_SUPPORTED: 'AUDIO_CODEC_NOT_SUPPORTED',
  AUDIO_PASSTHROUGH_DISABLED: 'AUDIO_PASSTHROUGH_DISABLED',
  AUDIO_CHANNELS_EXCEED_LIMIT: 'AUDIO_CHANNELS_EXCEED_LIMIT',
  AUDIO_CODEC_NOT_CARRIED_BY_HLS: 'AUDIO_CODEC_NOT_CARRIED_BY_HLS',
  AUDIO_OBJECTS_NOT_PRESERVED: 'AUDIO_OBJECTS_NOT_PRESERVED',
  AUDIO_CORE_ONLY: 'AUDIO_CORE_ONLY',
  NO_AUDIO: 'NO_AUDIO',
  NO_VIDEO: 'NO_VIDEO'
})

const R = (stream, code, text, severity = 'info', extra = {}) => ({ stream, code, text, severity, ...extra })
const linesOf = (v) => Math.max(Number(v && v.height) || 0, Math.round(((Number(v && v.width) || 0) * 9) / 16))
const hasText = (s) => String(s || '').length > 0

// ------------------------------------------------------------- the file
/** 'mkv' | 'webm' | 'mp4' | 'mov' | 'ts' | 'avi' | ... from ffprobe's format_name and the extension. */
function sourceContainer(tracks, ext) {
  const f = String((tracks && tracks.formatName) || '').toLowerCase()
  const e = String(ext || '').toLowerCase().replace(/^\./, '')
  if (f.includes('matroska') || f.includes('webm')) return e === 'webm' ? 'webm' : 'mkv'
  if (f.includes('mov') || f.includes('mp4')) return e === 'mov' ? 'mov' : 'mp4'
  if (f === 'mpegts' || f.includes('mpegts')) return 'ts'
  if (f === 'avi') return 'avi'
  if (f.includes('asf')) return 'asf'
  if (f === 'flv') return 'flv'
  if (f.includes('mpeg')) return 'mpeg'
  if (f.includes('ogg')) return 'ogg'
  if (['mkv', 'webm', 'mp4', 'm4v', 'mov', 'ts', 'm2ts', 'mts', 'avi', 'wmv', 'flv'].includes(e)) return { m4v: 'mp4', m2ts: 'ts', mts: 'ts', wmv: 'asf' }[e] || e
  return e || 'unknown'
}

/** The audio key a device profile uses for one source track. */
function audioKeyOf(track) {
  const c = String((track && track.codec) || '').toLowerCase()
  if (c === 'dts') {
    if (track.family === 'dtshd') return track.objectAudio === 'dtsx' ? 'dtsx' : 'dtshd'
    return 'dts'
  }
  if (c === 'mlp') return 'truehd'
  if (/^pcm_/.test(c)) return 'pcm'
  return c
}

/** Which of the file's audio tracks is played: the requested one, else the default, else the first. */
function pickAudio(tracks, streamIndex) {
  const list = (tracks && tracks.audio) || []
  if (streamIndex !== undefined && streamIndex !== null && streamIndex !== '') {
    const t = list.find((a) => a.streamIndex === Number(streamIndex))
    if (t) return t
  }
  return list.find((a) => a.isDefault) || list[0] || null
}

function subtitleKey(codec) {
  const c = String(codec || '').toLowerCase()
  if (c === 'hdmv_pgs_subtitle') return 'pgs'
  if (c === 'dvd_subtitle') return 'vobsub'
  if (c === 'subrip' || c === 'srt') return 'srt'
  if (c === 'webvtt') return 'vtt'
  if (c === 'ass' || c === 'ssa') return 'ass'
  if (c === 'mov_text') return 'mov_text'
  return c
}

// ------------------------------------------------------------------ video
function hdrLabel(video) {
  const dv = video.dolbyVision
  const parts = (video.hdrFormats || []).map((f) => (f === 'Dolby Vision' && dv && dv.label ? `Dolby Vision ${dv.label}` : f))
  return parts.length ? parts.join(' / ') : 'SDR'
}

/** Can this picture be delivered without re-encoding it, and in what HDR form? */
function evaluateVideo(video, profile, limitKbps, totalKbps) {
  const issues = []
  const out = { canCopy: true, issues, hdr: { source: 'SDR', action: 'none', delivered: 'SDR', tonemap: false }, dvStrip: false, dvBaseFallback: false, tag: '' }
  if (!video) return { ...out, canCopy: false, issues: [R('video', REASONS.NO_VIDEO, 'The file has no video stream.', 'warn')] }
  const codec = String(video.codec || '').toLowerCase()
  const entry = profile.video[codec]
  const fatal = (code, text) => { issues.push(R('video', code, text, 'info', { fatal: true })); out.canCopy = false }
  const name = { h264: 'H.264', hevc: 'HEVC', av1: 'AV1', vp9: 'VP9', mpeg2video: 'MPEG-2' }[codec] || codec.toUpperCase()

  if (!entry) fatal(REASONS.VIDEO_CODEC_NOT_SUPPORTED, `Video codec ${name} is not supported by this device -> converting the picture`)
  else {
    const pk = dp.profileKey(codec, video.profile)
    if (entry.profiles.length && pk && !entry.profiles.includes(pk)) {
      // an H.264 device that lists 'high' also plays 'main' / 'baseline' (a higher profile includes the lower ones)
      const rank = dp.H264_RANK
      const okByRank = codec === 'h264' && rank[pk] !== undefined && entry.profiles.some((p) => rank[p] !== undefined && rank[p] >= rank[pk]) && rank[pk] <= 3
      if (!okByRank) fatal(REASONS.VIDEO_PROFILE_NOT_SUPPORTED, `Video profile ${name} ${video.profile || pk} is not supported by this device -> converting the picture`)
    }
    if (video.bitDepth && !entry.bitDepths.includes(video.bitDepth)) fatal(REASONS.VIDEO_BIT_DEPTH_NOT_SUPPORTED, `${video.bitDepth}-bit ${name} is not supported by this device -> converting the picture`)
    if (entry.maxLevel && video.level && video.level > entry.maxLevel) fatal(REASONS.VIDEO_LEVEL_TOO_HIGH, `${name} level ${(video.level / (codec === 'hevc' ? 30 : 10)).toFixed(1)} is above what this device decodes -> converting the picture`)
  }
  const chroma = String(video.pixFmt || '')
  if (/444|422/.test(chroma) && codec !== 'prores') fatal(REASONS.VIDEO_CHROMA_NOT_SUPPORTED, 'The picture is not 4:2:0, which devices of this kind cannot decode -> converting the picture')
  // Height judges a device's limit (a 4096x2160 cinema file plays wherever 3840x2160 does); width only when the device states one.
  if (profile.maxHeight && (Number(video.height) || linesOf(video)) > profile.maxHeight * 1.02) fatal(REASONS.RESOLUTION_TOO_HIGH, `The picture (${video.width}x${video.height}) is larger than this device plays (${profile.maxHeight}p) -> converting the picture`)
  if (profile.maxWidth && Number(video.width) > profile.maxWidth * 1.02) fatal(REASONS.RESOLUTION_TOO_HIGH, `The picture is wider (${video.width}) than this device plays (${profile.maxWidth}) -> converting the picture`)
  if (profile.maxFps && video.fps && video.fps > profile.maxFps * 1.02) fatal(REASONS.FRAMERATE_TOO_HIGH, `${video.fps} frames per second is above what this device plays (${profile.maxFps}) -> converting the picture`)
  if (limitKbps && totalKbps && totalKbps > limitKbps) fatal(REASONS.BITRATE_EXCEEDS_LIMIT, `The file's bitrate (${Math.round(totalKbps / 100) / 10} Mbps) is above the limit (${Math.round(limitKbps / 100) / 10} Mbps) -> converting the picture`)

  // ---- HDR: keep it, strip the Dolby Vision layer, or tone-map
  if (video.hdr) {
    const h = profile.hdr
    const dv = video.dolbyVision
    out.hdr.source = hdrLabel(video)
    const baseOk = (kind) => (kind === 'HDR10' ? h.hdr10 : kind === 'HLG' ? h.hlg : kind === 'SDR')
    if (dv && h.dv.includes(String(dv.profile))) {
      out.hdr.action = 'keep'
      out.hdr.delivered = `Dolby Vision ${dv.label}`
    } else if (dv) {
      if (dv.baseLooksLike !== 'None' && dv.baseLooksLike !== 'Unknown' && baseOk(dv.baseLooksLike)) {
        // Profile 8 / 7 with a compatible base layer: play the base layer (RPU stripped), or (profile 8) let the player fall back itself.
        out.hdr.action = 'strip-dv'
        out.hdr.delivered = dv.baseLooksLike === 'SDR' ? 'SDR' : (video.hdr10Plus && dv.baseLooksLike === 'HDR10' && h.hdr10plus ? 'HDR10+' : dv.baseLooksLike)
        out.dvStrip = true
        out.dvBaseFallback = h.dvFallback && dv.profile === 8 // only profile 8 (HDR10 / HLG / SDR base): what players are known to fall back on
        issues.push(R('video', out.dvBaseFallback ? REASONS.DV_BASE_LAYER_FALLBACK : REASONS.DV_PROFILE_NOT_SUPPORTED,
          `Dolby Vision profile ${dv.label} is not supported by this device -> playing its ${dv.baseLooksLike} base layer`, 'info'))
      } else {
        out.hdr.action = 'tonemap'
        out.hdr.tonemap = true
        out.hdr.delivered = 'SDR (tone-mapped)'
        issues.push(R('video', dv.profile === 5 ? REASONS.DV_PROFILE5_NO_FALLBACK : REASONS.HDR_NOT_SUPPORTED,
          dv.profile === 5
            ? 'Dolby Vision profile 5 has no HDR10 layer and this device has no Dolby Vision -> converting the picture to SDR (needs libplacebo for correct colours)'
            : `Dolby Vision ${dv.label} needs a ${dv.baseLooksLike} display this device does not report -> converting the picture to SDR`, 'warn', { fatal: true }))
        out.canCopy = false
      }
    } else if (video.hdrBase === 'PQ') {
      if (h.hdr10) {
        out.hdr.action = 'keep'
        out.hdr.delivered = video.hdr10Plus && h.hdr10plus ? 'HDR10+' : 'HDR10'
        if (video.hdr10Plus && !h.hdr10plus) issues.push(R('video', REASONS.HDR10PLUS_PLAYS_AS_HDR10, 'The picture has HDR10+ metadata; this device shows it as HDR10', 'info'))
      } else {
        out.hdr.action = 'tonemap'; out.hdr.tonemap = true; out.hdr.delivered = 'SDR (tone-mapped)'
        issues.push(R('video', REASONS.HDR_NOT_SUPPORTED, 'This device has no HDR display support -> converting the picture to SDR (tone-mapped)', 'info', { fatal: true }))
        out.canCopy = false
      }
    } else if (video.hdrBase === 'HLG') {
      if (h.hlg) { out.hdr.action = 'keep'; out.hdr.delivered = 'HLG' } else {
        out.hdr.action = 'tonemap'; out.hdr.tonemap = true; out.hdr.delivered = 'SDR (tone-mapped)'
        issues.push(R('video', REASONS.HDR_NOT_SUPPORTED, 'This device does not report HLG support -> converting the picture to SDR', 'info', { fatal: true }))
        out.canCopy = false
      }
    } else {
      // an HDR file whose base layer is neither (a bare DV-only signal on a non-DV device)
      out.hdr.action = 'tonemap'; out.hdr.tonemap = true; out.hdr.delivered = 'SDR (tone-mapped)'
      out.canCopy = false
    }
  }
  // The sample-entry tag fragmented MP4 needs: hvc1 for HEVC (Apple / browsers refuse hev1), dvh1 when Dolby Vision is kept, avc1 for H.264.
  if (codec === 'hevc') out.tag = out.hdr.action === 'keep' && video.dolbyVision && !out.dvStrip ? 'dvh1' : 'hvc1'
  else if (codec === 'h264') out.tag = 'avc1'
  return out
}

// ------------------------------------------------------------------ audio
/**
 * Is one audio track playable by the device, and how? The key falls back the way the formats do:
 * DTS:X -> DTS-HD -> DTS core; a device that plays only the core plays the core of a DTS-HD stream.
 */
function audioSupport(track, profile, settings) {
  const key = audioKeyOf(track)
  const chain = key === 'dtsx' ? ['dtsx', 'dtshd', 'dts'] : key === 'dtshd' ? ['dtshd', 'dts'] : [key]
  const notes = []
  for (let i = 0; i < chain.length; i++) {
    const k = chain[i]
    const entry = profile.audio[k]
    if (!entry) continue
    const viaDecode = entry.decode
    const viaPass = entry.passthrough && settings.allowPassthrough
    if (!viaDecode && !viaPass) {
      if (entry.passthrough && !settings.allowPassthrough) notes.push(R('audio', REASONS.AUDIO_PASSTHROUGH_DISABLED, `Passing ${k.toUpperCase()} to a receiver is switched off in Settings -> converting the sound`, 'info'))
      continue
    }
    // A decoded track is limited by the device's own output; a passed-through one by the receiver (declared per codec).
    const limit = viaDecode ? Math.min(entry.maxChannels || 2, profile.maxAudioChannels || 99) : (entry.maxChannels || 8)
    return { key, used: k, entry, playable: true, via: viaDecode ? 'decode' : 'passthrough', coreOnly: i > 0, limit, notes }
  }
  return { key, used: null, entry: null, playable: false, via: null, coreOnly: false, limit: 0, notes }
}

/** The best format to convert to: what the device plays, surround when it can and the source is surround. */
function chooseAudioTarget(track, profile, settings, carrier) {
  const srcCh = Number(track && track.channels) || 2
  const playableTarget = (c) => {
    const e = profile.audio[c]
    return !!e && (e.decode || (e.passthrough && settings.allowPassthrough))
  }
  const deviceLimit = profile.maxAudioChannels || 2
  const codecLimit = (c) => Math.min((profile.audio[c] && profile.audio[c].maxChannels) || 2, deviceLimit, 6)
  const order = SURROUND_ENCODER_ORDER.filter(playableTarget)
  // Surround only when the device plays 6 channels in some codec we can encode and the source has at least 5.
  const surroundCodec = order.find((c) => codecLimit(c) >= 6)
  if (srcCh >= 5 && surroundCodec) return { codec: surroundCodec, channels: 6, layout: '5.1', downmix: srcCh > 6 }
  const c = playableTarget('aac') || !order.length ? 'aac' : order[0]
  const ch = Math.max(1, Math.min(2, codecLimit(c)))
  return { codec: c, channels: ch === 1 ? 1 : 2, layout: ch === 1 ? 'Mono' : 'Stereo', downmix: srcCh > 2 }
}

/**
 * The audio verdict for one track and one carrier:
 *   carrier 'file'     the device plays the original file
 *   carrier 'hls-fmp4' remux (copy) into fragmented MP4 / HLS
 *   carrier 'hls-ts'   the live conversion's MPEG-TS pieces
 */
function evaluateAudio(track, profile, settings, carrier) {
  if (!track) return { action: 'none', reasons: [R('audio', REASONS.NO_AUDIO, 'The file has no audio', 'info')], asIs: true, playsAs: '' }
  const reasons = []
  const sup = audioSupport(track, profile, settings)
  reasons.push(...sup.notes)
  const srcCh = Number(track.channels) || 0
  const name = track.formatName || String(track.codec || '').toUpperCase()
  const key = sup.key
  let copy = sup.playable
  let why = ''
  if (!sup.playable) {
    copy = false
    if (!sup.notes.some((n) => n.code === REASONS.AUDIO_PASSTHROUGH_DISABLED)) reasons.push(R('audio', REASONS.AUDIO_CODEC_NOT_SUPPORTED, `Audio codec ${name} is not supported by this device -> transcode audio only`, 'info', { fatal: true }))
    why = 'unsupported'
  } else if (srcCh > sup.limit && sup.via === 'decode') {
    copy = false
    reasons.push(R('audio', REASONS.AUDIO_CHANNELS_EXCEED_LIMIT, `${srcCh} audio channels are more than this device plays (${sup.limit}) -> transcode audio only`, 'info', { fatal: true }))
    why = 'channels'
  }
  const asIs = copy // the device can play this track as it is inside the ORIGINAL file
  if (copy && carrier !== 'file') {
    const codec = String(track.codec || '').toLowerCase()
    const cap = carrier === 'hls-ts' ? Math.min(HLS_TS_COPY_CHANNELS, HLS_FMP4_COPY[codec] || 0) : HLS_FMP4_COPY[codec]
    if (!cap) {
      copy = false
      why = 'carrier'
      reasons.push(R('audio', REASONS.AUDIO_CODEC_NOT_CARRIED_BY_HLS, `${name} cannot travel inside HLS -> transcode audio only (it plays as it is only from the original file)`, 'info', { fatal: true }))
    } else if (srcCh > cap) {
      copy = false
      why = 'carrier'
      reasons.push(R('audio', REASONS.AUDIO_CHANNELS_EXCEED_LIMIT, `${srcCh} channels do not fit in this stream format (${cap}) -> transcode audio only`, 'info', { fatal: true }))
    }
  }
  const out = { streamIndex: track.streamIndex, sourceCodec: track.codec, sourceChannels: srcCh, sourceName: name, key, via: sup.via, asIs, why }
  if (copy) {
    out.action = 'copy'
    out.codec = track.codec
    out.channels = srcCh
    out.layout = track.layout || ''
    out.passthrough = sup.via === 'passthrough' || ['truehd', 'dtshd', 'dtsx'].includes(sup.key)
    out.objectsKept = !!track.objectAudio && (track.objectAudio === 'atmos' ? !!(sup.entry && sup.entry.atmos) : !!(sup.entry && (sup.entry.dtsx || sup.used === 'dtsx')))
    if (track.objectAudio && !out.objectsKept) reasons.push(R('audio', REASONS.AUDIO_OBJECTS_NOT_PRESERVED, `${track.objectAudio === 'atmos' ? 'Dolby Atmos' : 'DTS:X'} objects are not decoded by this device -> plays as ${track.layout || 'surround'} without them`, 'info'))
    if (sup.coreOnly) reasons.push(R('audio', REASONS.AUDIO_CORE_ONLY, `This device plays only the DTS core of ${name}`, 'info'))
    out.playsAs = `${out.objectsKept || !track.objectAudio ? name : name.replace(/ \+ (Dolby Atmos|DTS:X)/, '')} ${out.layout}`.trim()
    // Through the live conversion (MPEG-TS pieces) the copy is asked for the way hlsAudio.js knows: mode passthrough, this codec.
    if (carrier === 'hls-ts') out.request = { audioMode: 'passthrough', audioCaps: { maxChannels: Math.min(srcCh, 6), codecs: [String(track.codec).toLowerCase()] } }
  } else {
    const t = chooseAudioTarget(track, profile, settings, carrier)
    out.action = 'transcode'
    out.codec = t.codec
    out.channels = t.channels
    out.layout = t.layout
    out.downmix = t.downmix
    out.passthrough = false
    out.objectsKept = false
    if (track.objectAudio) reasons.push(R('audio', REASONS.AUDIO_OBJECTS_NOT_PRESERVED, `${track.objectAudio === 'atmos' ? 'Dolby Atmos' : 'DTS:X'} object audio cannot be kept in a conversion -> plays as regular ${t.layout}`, 'info'))
    out.playsAs = `${({ eac3: 'Dolby Digital Plus', ac3: 'Dolby Digital', aac: 'AAC' })[t.codec]} ${t.layout} (converted from ${name})`
    // the request hlsAudio.js understands: surround or stereo, the codec order the device prefers, its channel limit
    out.request = { audioMode: t.channels > 2 ? 'surround' : 'stereo', downmix: 'standard', audioCaps: { maxChannels: t.channels, codecs: [t.codec] } }
  }
  out.reasons = reasons
  return out
}

// ----------------------------------------------------------------- decide
const QUALITY_LINES = { '1080p': 1080, '720p': 720, '480p': 480 }
const QUALITY_KBPS = { '1080p': 8192, '720p': 4160, '480p': 1628 }

/**
 * decide({ tracks, ext, profile, settings, request, remuxAvailable })
 *   tracks         playbackTracks.parseTracks output
 *   ext            the file's extension (".mkv")
 *   profile        deviceProfile.resolveProfile() result
 *   settings       homeTheaterSettings.effective() result
 *   request        { audioStreamIndex, quality: 'original'|'auto'|'1080p'|..., subtitle: { streamIndex, codec, kind },
 *                    maxBitrateKbps, awayCapHeight }
 *   remuxAvailable false when this computer cannot remux (no ffmpeg / fMP4)
 */
function decide({ tracks, ext = '', profile, settings, request = {}, remuxAvailable = true } = {}) {
  const set = { directPlayPreferred: true, maxBitrateKbps: 0, allowPassthrough: true, allowDirectStream: true, forceTranscode: false, ...(settings || {}) }
  const prof = profile || dp.defaultProfile('generic')
  const video = (tracks && tracks.video) || null
  const container = sourceContainer(tracks, ext)
  const reasons = []
  const track = pickAudio(tracks, request.audioStreamIndex)
  const totalKbps = (tracks && tracks.bitrateKbps) || (video && video.bitrateKbps) || 0
  const limits = [prof.maxBitrateKbps, set.maxBitrateKbps, request.maxBitrateKbps].map((n) => Number(n) || 0).filter((n) => n > 0)
  const limitKbps = limits.length ? Math.min(...limits) : 0

  // --- what forces a re-encode regardless of the picture itself
  let forceVideo = false
  if (set.forceTranscode) { forceVideo = true; reasons.push(R('session', REASONS.FORCED_TRANSCODE, 'Forced transcode is switched on (Settings > Playback > Home theater)', 'info', { fatal: true })) }
  const q = String(request.quality || '')
  let targetQuality = ''
  if (QUALITY_LINES[q] && video && linesOf(video) > QUALITY_LINES[q] * 1.05) {
    forceVideo = true
    targetQuality = q
    reasons.push(R('video', REASONS.QUALITY_REQUESTED, `${q} was chosen, lower than the original -> converting the picture`, 'info', { fatal: true }))
  }
  if (Number(request.awayCapHeight) > 0 && video && linesOf(video) > Number(request.awayCapHeight) * 1.05) {
    forceVideo = true
    reasons.push(R('video', REASONS.AWAY_QUALITY_CAP, `The household plan caps quality away from home at ${request.awayCapHeight}p -> converting the picture`, 'info', { fatal: true }))
  }
  const sub = request.subtitle || null
  let burn = false
  if (sub && sub.kind === 'image' && !prof.subtitles.includes(subtitleKey(sub.codec))) {
    burn = true
    forceVideo = true
    reasons.push(R('subtitle', REASONS.SUBTITLE_BURN_IN, 'Picture subtitles (Blu-ray / DVD) are burnt into the picture -> converting the picture', 'info', { fatal: true }))
  }

  // --- video and container
  const v = evaluateVideo(video, prof, limitKbps, totalKbps)
  reasons.push(...v.issues)
  const containerOk = prof.containers.includes(container)
  const containerReason = containerOk ? null : R('container', REASONS.CONTAINER_NOT_SUPPORTED, `The ${String(container).toUpperCase()} container is not played by this device -> delivered as HLS instead`, 'info')

  // --- can a stream (remux) be made at all?
  const canFmp4 = prof.streaming.includes('hls-fmp4')
  const remuxOk = remuxAvailable && set.allowDirectStream && canFmp4 && !!video && REMUX_VIDEO.has(String(video.codec).toLowerCase())
  const videoCopy = v.canCopy && !forceVideo

  // --- audio for each carrier the plan could use
  const audioFile = evaluateAudio(track, prof, set, 'file')
  const audioFmp4 = evaluateAudio(track, prof, set, 'hls-fmp4')
  const audioTs = evaluateAudio(track, prof, set, 'hls-ts')

  let method
  let audio
  let carrier
  const directOk = videoCopy && containerOk && audioFile.asIs && (!v.dvStrip || v.dvBaseFallback) && !burn
  if (directOk && (set.directPlayPreferred || !remuxOk)) {
    method = 'DirectPlay'; audio = audioFile; carrier = 'file'
    if (v.dvBaseFallback) { /* the player falls back to the base layer by itself */ }
  } else if (videoCopy && remuxOk) {
    method = 'DirectStream'; audio = audioFmp4; carrier = 'hls-fmp4'
    if (directOk && !set.directPlayPreferred) reasons.push(R('session', REASONS.DIRECT_PLAY_NOT_PREFERRED, 'Direct play is not preferred in Settings -> repackaging (remux) instead', 'info'))
  } else {
    method = 'Transcode'; audio = audioTs; carrier = 'hls-ts'
    if (videoCopy && !remuxOk) {
      if (!set.allowDirectStream) reasons.push(R('session', REASONS.DIRECT_STREAM_OFF, 'Direct stream is switched off in Settings -> converting the picture', 'info', { fatal: true }))
      else if (!canFmp4) reasons.push(R('session', REASONS.NO_STREAMING_FORMAT, 'This device does not play fragmented-MP4 HLS, which a remux needs -> converting the picture', 'info', { fatal: true }))
      else if (video && !REMUX_VIDEO.has(String(video.codec).toLowerCase())) reasons.push(R('session', REASONS.VIDEO_CODEC_NOT_SUPPORTED, `A ${String(video.codec).toUpperCase()} picture cannot be remuxed here -> converting the picture`, 'info', { fatal: true }))
      else reasons.push(R('session', REASONS.DIRECT_STREAM_OFF, 'Remux is not available on this computer -> converting the picture', 'info', { fatal: true }))
    }
  }
  if (containerReason && method !== 'DirectPlay') reasons.push(containerReason)
  reasons.push(...audio.reasons.filter((r) => !reasons.includes(r)))
  if (method === 'DirectStream' && audio.action === 'copy' && !audio.why && audio.reasons.length === 0) { /* copy: nothing to add */ }

  // --- the picture that is delivered
  const deliveredVideo = {
    action: method === 'Transcode' ? 'transcode' : 'copy',
    sourceCodec: video ? video.codec : null,
    targetCodec: method === 'Transcode' ? 'h264' : (video ? video.codec : null),
    tag: method === 'DirectStream' ? v.tag : '',
    hdr: { ...v.hdr },
    dvStrip: method === 'DirectStream' ? v.dvStrip : false,
    resolution: video ? `${video.width}x${video.height}` : null
  }
  if (method === 'Transcode') {
    // today's live conversion writes 8-bit SDR H.264: HDR is tone-mapped whatever the device could show
    const couldKeep = video && video.hdr && v.hdr.action !== 'tonemap'
    deliveredVideo.hdr = { source: v.hdr.source, action: video && video.hdr ? 'tonemap' : 'none', delivered: video && video.hdr ? 'SDR (tone-mapped)' : 'SDR', tonemap: !!(video && video.hdr) }
    if (couldKeep) reasons.push(R('video', REASONS.HDR_LOST_IN_TRANSCODE, `The conversion writes SDR H.264, so the ${v.hdr.source} picture is tone-mapped to SDR (this device could have shown HDR)`, 'warn'))
    let quality = targetQuality
    if (!quality) {
      const fitsLimit = (k) => !limitKbps || QUALITY_KBPS[k] <= limitKbps
      // never a bigger picture than the source has: a 720p film is converted "at 720p", not padded to 1080p
      const h = video ? (Number(video.height) || linesOf(video)) : 1080
      const bySize = h <= 500 ? ['480p'] : h <= 760 ? ['720p', '480p'] : ['1080p', '720p', '480p']
      quality = bySize.find(fitsLimit) || '480p'
    }
    deliveredVideo.quality = quality
  }

  const plan = {
    v: 1,
    method,
    carrier,
    client: prof.client,
    profileSource: prof.source,
    container: { source: container, delivered: method === 'DirectPlay' ? container : method === 'DirectStream' ? 'hls-fmp4' : 'hls-ts', action: method === 'DirectPlay' ? 'none' : 'remux' },
    video: deliveredVideo,
    audio: audio.action === 'none' ? { action: 'none' } : {
      streamIndex: audio.streamIndex, action: audio.action, sourceCodec: audio.sourceCodec, sourceChannels: audio.sourceChannels,
      codec: audio.codec, channels: audio.channels, layout: audio.layout, passthrough: !!audio.passthrough, objectsKept: !!audio.objectsKept,
      downmix: !!audio.downmix, playsAs: audio.playsAs, ...(audio.request ? { request: audio.request } : {})
    },
    subtitles: { action: burn ? 'burn' : sub ? 'sidecar' : 'none' },
    reasons: dedupe(reasons),
    hdrKept: method !== 'Transcode' && v.hdr.action === 'keep',
    playsAs: {
      video: method === 'Transcode' ? `H.264 ${deliveredVideo.hdr.delivered}` : `${video ? video.codec : ''} ${v.hdr.delivered}`.trim(),
      audio: audio.playsAs || ''
    }
  }
  plan.summary = summarize(plan)
  plan.reasonCodes = plan.reasons.map((r) => r.code)
  return plan
}

function dedupe(list) {
  const seen = new Set()
  return list.filter((r) => { const k = `${r.stream}|${r.code}|${r.text}`; if (seen.has(k)) return false; seen.add(k); return true })
}

function summarize(plan) {
  if (plan.method === 'DirectPlay') return 'Direct play'
  const bits = []
  if (plan.method === 'DirectStream') {
    bits.push('Direct stream')
    if (plan.audio && plan.audio.action === 'transcode') bits.push('audio converted')
    if (plan.video.dvStrip) bits.push('Dolby Vision layer removed')
    if (plan.video.hdr && plan.video.hdr.action === 'keep') bits.push(`${plan.video.hdr.delivered} kept`)
  } else {
    bits.push('Transcode')
    if (plan.video.hdr && plan.video.hdr.tonemap) bits.push('tone-mapped to SDR')
    if (plan.audio && plan.audio.action === 'copy') bits.push('audio copied')
  }
  return bits.join(' · ')
}

/** The reasons as plain sentences, for logs and the "Now playing" line. */
function explain(plan) {
  return (plan.reasons || []).filter((r) => r.severity !== 'debug').map((r) => r.text)
}

module.exports = {
  REASONS,
  HLS_FMP4_COPY,
  REMUX_VIDEO,
  sourceContainer,
  audioKeyOf,
  pickAudio,
  subtitleKey,
  evaluateVideo,
  evaluateAudio,
  audioSupport,
  chooseAudioTarget,
  decide,
  explain,
  summarize
}
