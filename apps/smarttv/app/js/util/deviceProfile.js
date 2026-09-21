// The device profile this TV app sends with POST /api/playback/negotiate (docs/HOME-THEATER.md section 2,
// format owned by desktop/apps/desktop/electron/deviceProfile.js). DOM-free: everything the engine can be asked
// is passed in as functions, so the unit tests feed it fake TVs.
//
// HONESTY RULES (the server trusts this declaration, so a claim that is not true means a picture that does not play):
//   * A codec, container or audio format is listed only when the engine itself says it can play it
//     (video.canPlayType, or MediaSource.isTypeSupported where the hls.js path is used). "maybe" counts as yes: that is
//     all a web engine will say, hardware limits are not visible from JavaScript.
//   * HDR is listed only from a display API (Samsung webapis, LG webOS.deviceInfo, the CSS dynamic-range media query).
//     When the platform gives no answer the profile says `hdr: []` (SDR only): the server tone-maps, which is always safe.
//     Dolby Vision profiles are only ever claimed when webOS reports Dolby Vision; HDR10+ is never claimed (no web API).
//   * TrueHD / DTS / DTS-HD / DTS:X are NEVER listed. A web view cannot pass them to a receiver.
//   * Atmos (E-AC-3 JOC) is claimed only when the TV reports Dolby Atmos.
//   * `maxHeight` is 2160 only when the panel is reported as UHD; otherwise 1080.
//   * `streaming` lists `hls-fmp4` only where hls.js (MSE) plays the stream: the native HLS of Tizen / webOS is only
//     claimed for MPEG-TS pieces, because fragmented-MP4 HLS is not something a web engine can be asked about.
//     (So a 4K HDR film that a TV cannot open as a file is converted rather than repackaged, until real-TV testing
//     shows fMP4 HLS works.)
// A profile with nothing probed is just `{ v: 1, client }`: the server then uses its own default for the platform.

export var PROFILE_VERSION = 1

/** Platform kind used by platform.js -> the client name the server knows (deviceProfile.js CLIENT_ALIASES). */
export function clientNameFor(kind) {
  if (kind === 'tizen') return 'samsung'
  if (kind === 'webos') return 'lg'
  if (kind === 'xbox') return 'xbox'
  return 'chrome'
}

// The probe strings. `avc1.6400xx`: High profile, level xx/10. `hvc1.1.6.L153.90` = HEVC Main level 5.1,
// `hvc1.2.4.L153.B0` = Main 10 level 5.1. `vp09.PP.LL.DD`, `av01.P.LLT.DD`.
var H264 = { 40: 'avc1.640028', 41: 'avc1.640029', 51: 'avc1.640033', 52: 'avc1.640034' }
var PROBES = {
  h264Main: 'video/mp4; codecs="avc1.4d401f"',
  h264Base: 'video/mp4; codecs="avc1.42e01e"',
  hevcMain: 'video/mp4; codecs="hvc1.1.6.L120.90"',
  hevcMain51: 'video/mp4; codecs="hvc1.1.6.L153.90"',
  hevcMain10: 'video/mp4; codecs="hvc1.2.4.L153.B0"',
  vp9: 'video/webm; codecs="vp09.00.10.08"',
  vp9p2: 'video/webm; codecs="vp09.02.10.10"',
  av1: 'video/mp4; codecs="av01.0.05M.08"',
  av110: 'video/mp4; codecs="av01.0.05M.10"',
  aac: 'audio/mp4; codecs="mp4a.40.2"',
  ac3: 'audio/mp4; codecs="ac-3"',
  eac3: 'audio/mp4; codecs="ec-3"',
  flac: 'audio/mp4; codecs="flac"',
  flacFile: 'audio/flac',
  opus: 'audio/mp4; codecs="opus"',
  opusWebm: 'audio/webm; codecs="opus"',
  mp3: 'audio/mpeg',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  ts: 'video/mp2t',
  mov: 'video/quicktime',
  hlsA: 'application/vnd.apple.mpegurl',
  hlsB: 'application/x-mpegURL'
}

function h264(env) {
  var top = 0
  var levels = [40, 41, 51, 52]
  for (var i = 0; i < levels.length; i++) {
    if (env.supports('video/mp4; codecs="' + H264[levels[i]] + '"')) top = levels[i]
  }
  if (!top) return null
  var profiles = ['baseline', 'main', 'high']
  return { profiles: profiles, maxLevel: top, bitDepths: [8] }
}

/** Whole-video part of the declaration, or null when nothing can be said. */
function videoPart(env) {
  var video = {}
  var h = h264(env)
  if (h) video.h264 = h
  else if (env.supports(PROBES.h264Main) || env.supports(PROBES.h264Base)) video.h264 = { profiles: ['baseline', 'main', 'high'], maxLevel: 41, bitDepths: [8] }
  var hevc10 = env.supports(PROBES.hevcMain10)
  if (env.supports(PROBES.hevcMain) || env.supports(PROBES.hevcMain51) || hevc10) {
    video.hevc = hevc10
      ? { profiles: ['main', 'main10'], maxLevel: 153, bitDepths: [8, 10] }
      : { profiles: ['main'], maxLevel: env.supports(PROBES.hevcMain51) ? 153 : 120, bitDepths: [8] }
  }
  if (env.supports(PROBES.vp9)) video.vp9 = env.supports(PROBES.vp9p2) ? { profiles: ['profile0', 'profile2'], bitDepths: [8, 10] } : { profiles: ['profile0'], bitDepths: [8] }
  if (env.supports(PROBES.av1)) video.av1 = env.supports(PROBES.av110) ? { profiles: ['main'], bitDepths: [8, 10] } : { profiles: ['main'], bitDepths: [8] }
  return Object.keys(video).length ? video : null
}

/** ["hdr10","hlg","dv:5,8"] from what the display API said. Unknown or false -> [] (SDR only). */
export function hdrList(display) {
  var d = display || {}
  var out = []
  if (d.hdr10 === true) out.push('hdr10')
  if (d.hdr10plus === true) out.push('hdr10plus')
  if (d.hlg === true) out.push('hlg')
  if (d.dvProfiles && d.dvProfiles.length) out.push('dv:' + d.dvProfiles.join(','))
  return out
}

function audioPart(env, display) {
  var audio = {}
  var ac3 = env.supports(PROBES.ac3)
  var eac3 = env.supports(PROBES.eac3)
  var multi = ac3 || eac3
  if (env.supports(PROBES.aac) || multi) audio.aac = { maxChannels: multi ? 6 : 2 }
  if (ac3) audio.ac3 = { maxChannels: 6 }
  if (eac3) audio.eac3 = display && display.atmos === true ? { maxChannels: 8, atmos: true } : { maxChannels: 6 }
  if (env.supports(PROBES.flac) || env.supports(PROBES.flacFile)) audio.flac = { maxChannels: 2 }
  if (env.supports(PROBES.opus) || env.supports(PROBES.opusWebm)) audio.opus = { maxChannels: 2 }
  if (env.supports(PROBES.mp3)) audio.mp3 = { maxChannels: 2 }
  // Deliberately absent: truehd, dts, dtshd, dtsx (see the honesty rules above).
  return Object.keys(audio).length ? audio : null
}

function containerList(env) {
  var out = []
  if (env.supports('video/mp4')) out.push('mp4')
  if (env.supports(PROBES.mkv)) out.push('mkv')
  if (env.supports(PROBES.webm)) out.push('webm')
  if (env.supports(PROBES.ts)) out.push('ts')
  if (env.supports(PROBES.mov)) out.push('mov')
  return out
}

function streamingList(env) {
  var out = []
  var hlsJs = env.hlsJs === true
  var native = env.hlsNative === true || env.supports(PROBES.hlsA) || env.supports(PROBES.hlsB)
  if (native || hlsJs) out.push('hls-ts')
  if (hlsJs) out.push('hls-fmp4')
  return out
}

/**
 * env = {
 *   platform: 'tizen' | 'webos' | 'xbox' | 'browser',
 *   name: string (shown to the owner; optional),
 *   supports(mime): boolean         canPlayType / MediaSource.isTypeSupported answered non-empty
 *   hlsNative: boolean, hlsJs: boolean
 *   display: { uhd, hdr10, hdr10plus, hlg, dvProfiles: number[], atmos }   each true / false / null (unknown)
 * }
 * Returns the declaration object (never throws).
 */
export function buildDeviceProfile(env) {
  var e = env || {}
  var profile = { v: PROFILE_VERSION, client: clientNameFor(e.platform) }
  if (typeof e.name === 'string' && e.name) profile.name = e.name.replace(/[^\w .,'()-]/g, '').slice(0, 60)
  if (typeof e.supports !== 'function') return profile // nothing can be probed: the server's default for the platform applies
  var supports = function (m) { try { return !!e.supports(m) } catch (x) { return false } }
  var safe = { supports: supports, hlsNative: e.hlsNative, hlsJs: e.hlsJs }
  var display = e.display || {}

  var video = videoPart(safe)
  if (video) profile.video = video
  profile.hdr = hdrList(display)
  if (display.uhd === true) { profile.maxHeight = 2160; profile.maxWidth = 3840 } else profile.maxHeight = 1080
  var audio = audioPart(safe, display)
  if (audio) {
    profile.audio = audio
    profile.maxAudioChannels = audio.eac3 && audio.eac3.maxChannels === 8 ? 8 : (audio.ac3 || audio.eac3 ? 6 : 2)
  }
  var containers = containerList(safe)
  if (containers.length) profile.containers = containers
  var streaming = streamingList(safe)
  if (streaming.length) profile.streaming = streaming
  // The app draws WebVTT (and only that) itself; picture subtitles are never offered, so none is ever burnt in.
  profile.subtitles = ['vtt']
  return profile
}

/** A short line for the About / diagnostics screen, e.g. "hevc h264 · HDR10 · ac3 eac3 aac · 2160p". */
export function describeProfile(p) {
  if (!p || typeof p !== 'object') return ''
  var video = p.video ? Object.keys(p.video).join(' ') : 'default'
  var hdr = p.hdr && p.hdr.length ? p.hdr.join(' ') : 'SDR'
  var audio = p.audio ? Object.keys(p.audio).join(' ') : 'default'
  return video + ' · ' + hdr + ' · ' + audio + (p.maxHeight ? ' · ' + p.maxHeight + 'p' : '')
}
