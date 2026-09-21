'use strict'
// ============================================================================
// deviceProfile.js - what a playback client can do, in one small declaration.
// ----------------------------------------------------------------------------
// Jellyfin calls it a DeviceProfile, Plex a client profile. A client (Android TV, Fire TV, Apple TV,
// Roku, Samsung, LG, Xbox, a browser) sends this compact object with its playback request:
//
//   {
//     "v": 1, "client": "androidtv", "name": "Living room Shield",
//     "video": {                                   // per codec: what the decoder handles
//       "h264": { "profiles": ["baseline","main","high"], "maxLevel": 52, "bitDepths": [8] },
//       "hevc": { "profiles": ["main","main10"], "maxLevel": 153, "bitDepths": [8, 10] },
//       "av1":  { "profiles": ["main"], "bitDepths": [8, 10] }, "vp9": { "profiles": ["profile0","profile2"] }
//     },
//     "hdr": ["hdr10", "hdr10plus", "hlg", "dv:5,7,8"],   // "dv:<profiles>"; "dvfallback": the player plays a profile 8 file's HDR10 / HLG base layer itself
//     "maxHeight": 2160, "maxWidth": 3840, "maxFps": 60, "maxBitrateKbps": 120000,
//     "audio": {                                   // per codec: decode and/or pass through to an AV receiver
//       "aac":   { "maxChannels": 8 },
//       "ac3":   { "maxChannels": 6, "passthrough": true },
//       "eac3":  { "maxChannels": 8, "passthrough": true, "atmos": true },
//       "truehd":{ "passthrough": true, "decode": false, "atmos": true },
//       "dts":   { "passthrough": true }, "dtshd": { "passthrough": true }, "dtsx": { "passthrough": true }
//     },
//     "maxAudioChannels": 8,
//     "containers": ["mp4", "mkv", "ts", "webm"],     // files it can play as they are (direct play)
//     "streaming": ["hls-fmp4", "hls-ts"],           // stream formats it can play
//     "subtitles": ["vtt", "srt", "ass"]             // formats it renders itself (picture subtitles are burnt in by the server)
//   }
//
// Everything is optional. A client that sends nothing gets the CONSERVATIVE default profile for its
// platform (named by `client`, or worked out from the User-Agent), and a client that sends only a part
// (say "hdr") gets its own answer for that part and the platform default for the rest.
//
// Nothing here trusts the input: unknown keys are dropped, numbers are clamped, lists are capped.
// The result of normalize() is what playbackDecision.js reads.
// ============================================================================

const PROFILE_VERSION = 1
const MAX_LIST = 32

const VIDEO_CODECS = ['h264', 'hevc', 'av1', 'vp9', 'vp8', 'mpeg2video', 'mpeg4', 'vc1']
const AUDIO_KEYS = ['aac', 'ac3', 'eac3', 'truehd', 'dts', 'dtshd', 'dtsx', 'flac', 'opus', 'mp3', 'vorbis', 'pcm', 'alac']
const CONTAINERS = ['mp4', 'mov', 'mkv', 'webm', 'ts', 'avi', 'asf', 'flv', 'mpeg', 'ogg']
const STREAMING = ['hls-ts', 'hls-fmp4']
const SUBTITLE_FORMATS = ['vtt', 'srt', 'ass', 'ssa', 'pgs', 'vobsub', 'mov_text']
const PLATFORMS = ['androidtv', 'firetv', 'appletv', 'ios', 'android', 'roku', 'samsung', 'lg', 'xbox', 'chromecast', 'chrome', 'edge', 'firefox', 'safari', 'generic']

// Client names people (and our own apps) use -> platform id.
const CLIENT_ALIASES = {
  androidtv: 'androidtv', 'android-tv': 'androidtv', googletv: 'androidtv', 'google-tv': 'androidtv', shield: 'androidtv',
  firetv: 'firetv', 'fire-tv': 'firetv', fire: 'firetv', amazon: 'firetv',
  appletv: 'appletv', 'apple-tv': 'appletv', tvos: 'appletv',
  ios: 'ios', iphone: 'ios', ipad: 'ios',
  android: 'android', 'android-phone': 'android',
  roku: 'roku',
  samsung: 'samsung', tizen: 'samsung',
  lg: 'lg', webos: 'lg',
  xbox: 'xbox',
  chromecast: 'chromecast', cast: 'chromecast',
  chrome: 'chrome', edge: 'edge', firefox: 'firefox', safari: 'safari', browser: 'chrome', web: 'chrome', generic: 'generic'
}

/** Platform id from an explicit client name and/or a User-Agent. Unknown -> 'generic' (the conservative profile). */
function detectPlatform({ client = '', userAgent = '' } = {}) {
  const c = String(client || '').toLowerCase().trim().replace(/[^a-z0-9-]/g, '')
  if (c && CLIENT_ALIASES[c]) return CLIENT_ALIASES[c]
  const ua = String(userAgent || '')
  if (/Tizen|SMART-TV.*Samsung|SamsungBrowser.*TV/i.test(ua)) return 'samsung'
  if (/Web0S|webOS|NetCast|LG Browser/i.test(ua)) return 'lg'
  if (/Xbox/i.test(ua)) return 'xbox'
  if (/\bAFT[A-Z0-9]+\b|FireTV|Amazon.*(Silk|AFT)/i.test(ua)) return 'firetv'
  if (/Android.*(TV|Shield|BRAVIA|GoogleTV)|; ?Android TV|Chromecast.*Google TV/i.test(ua)) return 'androidtv'
  if (/Roku/i.test(ua)) return 'roku'
  if (/AppleTV|tvOS/i.test(ua)) return 'appletv'
  if (/CrKey/i.test(ua)) return 'chromecast'
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios'
  if (/Android/i.test(ua)) return 'android'
  if (/Edg\//i.test(ua)) return 'edge'
  if (/Firefox\//i.test(ua)) return 'firefox'
  if (/Chrome\//i.test(ua)) return 'chrome'
  if (/Safari\//i.test(ua)) return 'safari'
  return 'generic'
}

// ------------------------------------------------------------------ helpers
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)
const clampInt = (v, lo, hi, fallback = 0) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : fallback
}
const strList = (v, allowed, max = MAX_LIST) => {
  const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\s]+/) : []
  const out = []
  for (const x of arr) {
    const s = String(x || '').toLowerCase().trim()
    if (s && (!allowed || allowed.includes(s)) && !out.includes(s)) out.push(s)
    if (out.length >= max) break
  }
  return out
}

/** "main", "Main 10", "Main10", "High 10", "Baseline" -> 'main' | 'main10' | 'high10' | 'baseline' ... */
function profileKey(codec, profile) {
  const p = String(profile || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim()
  if (!p) return ''
  if (codec === 'hevc') {
    if (/rext|range|4:?[24]:?[24]|12|444|422/.test(p)) return 'rext'
    if (/still/.test(p)) return 'stillpicture'
    if (/main ?10/.test(p)) return 'main10'
    if (/main/.test(p)) return 'main'
    return p.replace(/ /g, '')
  }
  if (codec === 'h264') {
    if (/444/.test(p)) return 'high444'
    if (/422/.test(p)) return 'high422'
    if (/high ?10/.test(p)) return 'high10'
    if (/constrained baseline/.test(p)) return 'baseline'
    if (/baseline/.test(p)) return 'baseline'
    if (/extended/.test(p)) return 'extended'
    if (/high/.test(p)) return 'high'
    if (/main/.test(p)) return 'main'
    return p.replace(/ /g, '')
  }
  if (codec === 'vp9') { const m = /profile ?(\d)/.exec(p); return m ? `profile${m[1]}` : p.replace(/ /g, '') }
  if (codec === 'av1') return /pro/.test(p) ? 'professional' : /high/.test(p) ? 'high' : 'main'
  return p.replace(/ /g, '')
}
const H264_RANK = { baseline: 0, extended: 1, main: 2, high: 3, high10: 4, high422: 5, high444: 6 }

// ------------------------------------------------------------ normalisation
function normVideo(raw) {
  const out = {}
  if (!isObj(raw)) return out
  for (const codec of VIDEO_CODECS) {
    const v = raw[codec]
    if (v === undefined || v === false || v === null) continue
    const e = isObj(v) ? v : {}
    const entry = { profiles: [], maxLevel: 0, bitDepths: [] }
    entry.profiles = strList(e.profiles, null, 12).map((p) => profileKey(codec, p)).filter(Boolean)
    if (codec === 'h264' && !entry.profiles.length && typeof e.maxProfile === 'string') {
      const top = H264_RANK[profileKey('h264', e.maxProfile)]
      if (top !== undefined) entry.profiles = Object.keys(H264_RANK).filter((k) => H264_RANK[k] <= top && H264_RANK[k] !== 1)
    }
    entry.maxLevel = clampInt(e.maxLevel, 0, 999, 0)
    entry.bitDepths = (Array.isArray(e.bitDepths) ? e.bitDepths : [e.bitDepth]).map((n) => clampInt(n, 0, 16, 0)).filter((n) => n >= 8).slice(0, 4)
    if (!entry.bitDepths.length) entry.bitDepths = [8]
    out[codec] = entry
  }
  return out
}

/** ["hdr10","hdr10plus","hlg","dv:5,7,8", "dvfallback"] or { hdr10: true, dv: [5, 8] } -> { hdr10, hdr10plus, hlg, dv: [..], dvFallback } */
function normHdr(raw) {
  const out = { hdr10: false, hdr10plus: false, hlg: false, dv: [], dvFallback: false }
  const add = (name, value) => {
    const n = String(name).toLowerCase().replace(/[^a-z0-9+]/g, '')
    if (n === 'hdr10' || n === 'hdr') out.hdr10 = value !== false
    else if (n === 'hdr10plus' || n === 'hdr10+') { out.hdr10plus = value !== false; if (value !== false) out.hdr10 = true }
    else if (n === 'hlg') out.hlg = value !== false
    else if (n === 'dvfallback') out.dvFallback = value !== false
    else if (/^(dv|dolbyvision)/.test(n)) {
      const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,\s]+/) : value === true ? [5, 7, 8] : []
      for (const p of list) { const k = String(p).replace(/[^0-9]/g, '').slice(0, 2); if (k && !out.dv.includes(k)) out.dv.push(k) }
      const inline = /^(?:dv|dolbyvision)(\d[\d,]*)$/.exec(n)
      if (inline) for (const p of inline[1].split(',')) if (p && !out.dv.includes(p)) out.dv.push(p)
    }
  }
  if (Array.isArray(raw)) {
    for (const item of raw.slice(0, MAX_LIST)) {
      const s = String(item)
      const m = /^([a-z0-9+_ -]+):(.*)$/i.exec(s)
      if (m) add(m[1], m[2])
      else add(s, true)
    }
  } else if (isObj(raw)) {
    for (const [k, v] of Object.entries(raw).slice(0, MAX_LIST)) add(k, v)
  }
  out.dv.sort()
  return out
}

// Codecs a TV or stick never decodes by itself: it hands the bitstream to an AV receiver, or does not play it at all.
const PASSTHROUGH_FAMILY = ['truehd', 'dtshd', 'dtsx']

function normAudio(raw) {
  const out = {}
  if (!isObj(raw)) return out
  for (const key of AUDIO_KEYS) {
    const v = raw[key]
    if (v === undefined || v === false || v === null) continue
    const e = isObj(v) ? v : {}
    const family = PASSTHROUGH_FAMILY.includes(key)
    // Listing a Dolby TrueHD / DTS-HD codec with no flags means "I pass it to the receiver".
    const passthrough = e.passthrough === true || (family && e.passthrough === undefined && e.decode !== true)
    // Decoding is on for ordinary codecs; a client that says passthrough (and not decode) can only hand it on.
    const decode = e.decode !== undefined ? e.decode === true : (family || e.passthrough === true ? false : true)
    const cap = clampInt(e.maxChannels, 0, 16, 0)
    out[key] = { maxChannels: cap || (passthrough && !decode ? 8 : 2), passthrough, decode, atmos: e.atmos === true, dtsx: key === 'dtsx' || e.dtsx === true }
  }
  return out
}

/**
 * A declaration (or a default profile) -> the canonical profile the decision engine reads.
 * Never throws; garbage in -> an empty (but valid) profile, which callers overlay on a default.
 */
function normalize(raw) {
  const r = isObj(raw) ? raw : {}
  const p = {
    v: PROFILE_VERSION,
    client: PLATFORMS.includes(String(r.client || '').toLowerCase()) ? String(r.client).toLowerCase() : (CLIENT_ALIASES[String(r.client || '').toLowerCase()] || ''),
    name: typeof r.name === 'string' ? r.name.replace(/[^\w .,'()-]/g, '').slice(0, 60) : '',
    video: normVideo(r.video),
    hdr: normHdr(r.hdr),
    maxHeight: clampInt(r.maxHeight, 0, 8640, 0),
    maxWidth: clampInt(r.maxWidth, 0, 15360, 0),
    maxFps: clampInt(r.maxFps, 0, 240, 0),
    maxBitrateKbps: clampInt(r.maxBitrateKbps, 0, 1000000, 0),
    audio: normAudio(r.audio),
    maxAudioChannels: clampInt(r.maxAudioChannels, 0, 16, 0),
    containers: strList(r.containers, CONTAINERS),
    streaming: strList(r.streaming, STREAMING),
    subtitles: strList(r.subtitles, SUBTITLE_FORMATS),
    // which parts the client actually stated (the rest come from the default)
    stated: {}
  }
  if (typeof r.maxResolution === 'string') {
    const m = /^(\d{3,5})x(\d{3,5})$/i.exec(r.maxResolution)
    if (m) { p.maxWidth = p.maxWidth || Number(m[1]); p.maxHeight = p.maxHeight || Number(m[2]) }
  }
  for (const k of ['video', 'audio']) if (isObj(r[k])) p.stated[k] = true
  if (Array.isArray(r.hdr) || isObj(r.hdr)) p.stated.hdr = true
  for (const k of ['containers', 'streaming', 'subtitles']) if (Array.isArray(r[k]) || typeof r[k] === 'string') p.stated[k] = true
  for (const k of ['maxHeight', 'maxWidth', 'maxFps', 'maxBitrateKbps', 'maxAudioChannels']) if (r[k] !== undefined && p[k]) p.stated[k] = true
  if (typeof r.maxResolution === 'string' && /^\d{3,5}x\d{3,5}$/i.test(r.maxResolution)) { p.stated.maxHeight = true; p.stated.maxWidth = true }
  return p
}

// ------------------------------------------------------- platform defaults
// Deliberately CONSERVATIVE: a default is only what the platform is known to do on most devices of its
// kind. A real client should send its own profile (Android: MediaCodecList + AudioCapabilities +
// Display.getHdrCapabilities; tvOS: AVPlayer.availableHDRModes; browsers: MediaCapabilities); the server
// never guesses "Dolby Vision" or "DTS passthrough" for a client that did not say so, except where
// the platform's own player is known to (Apple TV: Dolby Vision).
const H264_ALL = { profiles: ['baseline', 'main', 'high'], maxLevel: 41, bitDepths: [8] }
const H264_HI = { profiles: ['baseline', 'main', 'high'], maxLevel: 52, bitDepths: [8] }
const HEVC_MAIN10 = { profiles: ['main', 'main10'], maxLevel: 153, bitDepths: [8, 10] }
const audioSet = (spec) => normAudio(spec)

const DEFAULTS = {
  generic: {
    video: { h264: H264_ALL }, maxHeight: 1080, maxFps: 30, maxBitrateKbps: 20000,
    audio: { aac: { maxChannels: 2 }, mp3: { maxChannels: 2 } }, maxAudioChannels: 2,
    containers: ['mp4'], streaming: ['hls-ts'], subtitles: ['vtt'], hdr: []
  },
  chrome: {
    video: { h264: H264_HI, vp9: { profiles: ['profile0'], bitDepths: [8] }, av1: { profiles: ['main'], bitDepths: [8, 10] } }, maxHeight: 2160, maxFps: 60,
    audio: { aac: { maxChannels: 6 }, mp3: { maxChannels: 2 }, opus: { maxChannels: 6 }, vorbis: { maxChannels: 2 }, flac: { maxChannels: 2 } }, maxAudioChannels: 6,
    containers: ['mp4', 'webm'], streaming: ['hls-ts', 'hls-fmp4'], subtitles: ['vtt'], hdr: []
  },
  edge: null, // = chrome
  firefox: {
    video: { h264: H264_HI, vp9: { profiles: ['profile0'], bitDepths: [8] }, av1: { profiles: ['main'], bitDepths: [8, 10] } }, maxHeight: 2160, maxFps: 60,
    audio: { aac: { maxChannels: 6 }, mp3: { maxChannels: 2 }, opus: { maxChannels: 6 }, vorbis: { maxChannels: 2 }, flac: { maxChannels: 2 } }, maxAudioChannels: 6,
    containers: ['mp4', 'webm'], streaming: ['hls-ts', 'hls-fmp4'], subtitles: ['vtt'], hdr: []
  },
  safari: {
    video: { h264: H264_HI, hevc: HEVC_MAIN10 }, maxHeight: 2160, maxFps: 60,
    audio: { aac: { maxChannels: 6 }, ac3: { maxChannels: 6 }, eac3: { maxChannels: 6 }, mp3: { maxChannels: 2 }, alac: { maxChannels: 2 }, flac: { maxChannels: 2 } }, maxAudioChannels: 6,
    // A browser cannot tell whether the screen is HDR: HDR is left off (the server tone-maps) unless the page says otherwise.
    containers: ['mp4', 'mov'], streaming: ['hls-fmp4', 'hls-ts'], subtitles: ['vtt'], hdr: []
  },
  ios: {
    video: { h264: H264_HI, hevc: HEVC_MAIN10 }, maxHeight: 2160, maxFps: 60,
    audio: { aac: { maxChannels: 6 }, ac3: { maxChannels: 6 }, eac3: { maxChannels: 6, atmos: true }, mp3: { maxChannels: 2 }, alac: { maxChannels: 2 }, flac: { maxChannels: 2 } }, maxAudioChannels: 6,
    containers: ['mp4', 'mov'], streaming: ['hls-fmp4', 'hls-ts'], subtitles: ['vtt'], hdr: ['hdr10', 'hlg', 'dv:5,8'], dvfallback: false
  },
  appletv: {
    video: { h264: H264_HI, hevc: HEVC_MAIN10 }, maxHeight: 2160, maxFps: 60,
    // AVPlayer decodes Dolby Digital / Digital Plus (incl. Atmos in E-AC-3) and sends it on over HDMI. No TrueHD, no DTS.
    audio: { aac: { maxChannels: 6 }, ac3: { maxChannels: 6, passthrough: true, decode: true }, eac3: { maxChannels: 8, passthrough: true, decode: true, atmos: true }, mp3: { maxChannels: 2 }, alac: { maxChannels: 2 }, flac: { maxChannels: 2 } }, maxAudioChannels: 8,
    // tvOS plays MP4 / MOV files and HLS; it does not open Matroska.
    containers: ['mp4', 'mov'], streaming: ['hls-fmp4', 'hls-ts'], subtitles: ['vtt'],
    hdr: ['hdr10', 'hlg', 'dv:5,8'], dvfallback: false
  },
  androidtv: {
    video: { h264: H264_HI, hevc: HEVC_MAIN10, vp9: { profiles: ['profile0', 'profile2'], bitDepths: [8, 10] } }, maxHeight: 2160, maxFps: 60,
    // Media3 decodes AC-3 / E-AC-3 and passes them to HDMI when the receiver accepts them; DTS / TrueHD only when the app says so.
    audio: { aac: { maxChannels: 6 }, ac3: { maxChannels: 6 }, eac3: { maxChannels: 6 }, mp3: { maxChannels: 2 }, opus: { maxChannels: 2 }, vorbis: { maxChannels: 2 }, flac: { maxChannels: 2 } }, maxAudioChannels: 6,
    containers: ['mp4', 'mkv', 'ts', 'webm'], streaming: ['hls-ts', 'hls-fmp4'], subtitles: ['vtt', 'srt'],
    // Media3 falls back to the HEVC decoder for a Dolby Vision file whose base layer is HDR10 / HLG / SDR.
    hdr: ['hdr10', 'hlg'], dvfallback: true
  },
  firetv: null, // = androidtv
  chromecast: {
    video: { h264: H264_HI, hevc: HEVC_MAIN10, vp9: { profiles: ['profile0', 'profile2'], bitDepths: [8, 10] } }, maxHeight: 2160, maxFps: 60,
    audio: { aac: { maxChannels: 6 }, ac3: { maxChannels: 6, passthrough: true, decode: true }, eac3: { maxChannels: 6, passthrough: true, decode: true }, mp3: { maxChannels: 2 }, opus: { maxChannels: 2 }, vorbis: { maxChannels: 2 }, flac: { maxChannels: 2 } }, maxAudioChannels: 6,
    containers: ['mp4', 'webm'], streaming: ['hls-fmp4', 'hls-ts'], subtitles: ['vtt'], hdr: ['hdr10'], dvfallback: false
  },
  android: {
    video: { h264: H264_HI, hevc: HEVC_MAIN10, vp9: { profiles: ['profile0'], bitDepths: [8] } }, maxHeight: 2160, maxFps: 60,
    audio: { aac: { maxChannels: 6 }, ac3: { maxChannels: 6 }, eac3: { maxChannels: 6 }, mp3: { maxChannels: 2 }, opus: { maxChannels: 2 }, vorbis: { maxChannels: 2 }, flac: { maxChannels: 2 } }, maxAudioChannels: 6,
    containers: ['mp4', 'mkv', 'ts', 'webm'], streaming: ['hls-ts', 'hls-fmp4'], subtitles: ['vtt', 'srt'], hdr: ['hdr10'], dvfallback: true
  },
  roku: {
    video: { h264: H264_HI, hevc: HEVC_MAIN10, vp9: { profiles: ['profile0', 'profile2'], bitDepths: [8, 10] } }, maxHeight: 2160, maxFps: 60,
    audio: { aac: { maxChannels: 6 }, ac3: { maxChannels: 6, passthrough: true, decode: true }, eac3: { maxChannels: 6, passthrough: true, decode: true }, mp3: { maxChannels: 2 }, flac: { maxChannels: 2 }, opus: { maxChannels: 2 } }, maxAudioChannels: 6,
    containers: ['mp4', 'mkv', 'mov', 'ts'], streaming: ['hls-ts', 'hls-fmp4'], subtitles: ['vtt', 'srt'], hdr: ['hdr10'], dvfallback: false
  },
  samsung: {
    // Tizen: no Dolby Vision (Samsung sells HDR10+ instead), no DTS decoding on recent models.
    video: { h264: H264_HI, hevc: HEVC_MAIN10, vp9: { profiles: ['profile0', 'profile2'], bitDepths: [8, 10] }, av1: { profiles: ['main'], bitDepths: [8, 10] } }, maxHeight: 2160, maxFps: 60,
    audio: { aac: { maxChannels: 6 }, ac3: { maxChannels: 6 }, eac3: { maxChannels: 6, atmos: true }, mp3: { maxChannels: 2 }, opus: { maxChannels: 2 }, flac: { maxChannels: 2 } }, maxAudioChannels: 6,
    containers: ['mp4', 'mkv', 'ts', 'webm'], streaming: ['hls-ts', 'hls-fmp4'], subtitles: ['vtt', 'srt'], hdr: ['hdr10', 'hdr10plus', 'hlg'], dvfallback: false
  },
  lg: {
    // webOS: Dolby Vision yes, HDR10+ no.
    video: { h264: H264_HI, hevc: HEVC_MAIN10, vp9: { profiles: ['profile0', 'profile2'], bitDepths: [8, 10] }, av1: { profiles: ['main'], bitDepths: [8, 10] } }, maxHeight: 2160, maxFps: 60,
    audio: { aac: { maxChannels: 6 }, ac3: { maxChannels: 6 }, eac3: { maxChannels: 6, atmos: true }, mp3: { maxChannels: 2 }, opus: { maxChannels: 2 }, flac: { maxChannels: 2 } }, maxAudioChannels: 6,
    containers: ['mp4', 'mkv', 'ts', 'webm'], streaming: ['hls-ts', 'hls-fmp4'], subtitles: ['vtt', 'srt'], hdr: ['hdr10', 'hlg', 'dv:5,8'], dvfallback: false
  },
  xbox: {
    video: { h264: H264_HI, hevc: HEVC_MAIN10, vp9: { profiles: ['profile0'], bitDepths: [8] }, av1: { profiles: ['main'], bitDepths: [8, 10] } }, maxHeight: 2160, maxFps: 60,
    audio: { aac: { maxChannels: 6 }, ac3: { maxChannels: 6 }, eac3: { maxChannels: 6 }, mp3: { maxChannels: 2 }, opus: { maxChannels: 2 }, flac: { maxChannels: 2 } }, maxAudioChannels: 6,
    containers: ['mp4', 'webm'], streaming: ['hls-fmp4', 'hls-ts'], subtitles: ['vtt'], hdr: ['hdr10'], dvfallback: false
  }
}
DEFAULTS.edge = DEFAULTS.chrome
DEFAULTS.firetv = { ...DEFAULTS.androidtv, hdr: ['hdr10', 'hlg'], dvfallback: true }

/** The conservative default profile for a platform, normalised, with `client` and `source` set. */
function defaultProfile(platform) {
  const id = DEFAULTS[platform] ? platform : 'generic'
  const d = DEFAULTS[id]
  const p = normalize({ ...d, client: id })
  p.hdr.dvFallback = d.dvfallback === true
  p.client = id
  p.source = `default:${id}`
  p.stated = {}
  return p
}

/**
 * The profile to use for a request: the client's own declaration laid over the default for its platform.
 *   declared   the client's declaration (object, or a JSON / base64url-JSON string), or null
 *   client     an explicit client name ("androidtv") - a header or a body field
 *   userAgent  the User-Agent header
 * Returns the normalised profile with `source`: 'declared' (everything stated) | 'declared+default:<id>' | 'default:<id>'.
 */
function resolveProfile({ declared = null, client = '', userAgent = '' } = {}) {
  let raw = declared
  if (typeof raw === 'string') raw = parseDeclaration(raw)
  const own = isObj(raw) ? normalize(raw) : null
  const platform = detectPlatform({ client: (own && own.client) || client, userAgent })
  const base = defaultProfile(platform)
  if (!own) return base
  const statedAny = Object.keys(own.stated).length > 0
  if (!statedAny) return { ...base, name: own.name || base.name }
  const merged = { ...base, name: own.name || '', source: `declared+default:${platform}`, client: own.client || platform }
  if (own.stated.video) merged.video = own.video
  if (own.stated.audio) merged.audio = own.audio
  if (own.stated.hdr) merged.hdr = own.hdr
  for (const k of ['maxHeight', 'maxWidth', 'maxFps', 'maxBitrateKbps', 'maxAudioChannels']) if (own.stated[k]) merged[k] = own[k]
  // A stated resolution replaces the default's whole box, so a 4K client is not held to the default's width.
  if (own.stated.maxHeight && !own.maxWidth) merged.maxWidth = 0
  for (const k of ['containers', 'streaming', 'subtitles']) if (own.stated[k]) merged[k] = own[k]
  merged.stated = own.stated
  const all = ['video', 'audio', 'hdr', 'containers', 'streaming', 'subtitles', 'maxHeight'].every((k) => own.stated[k])
  if (all) merged.source = 'declared'
  if (merged.maxAudioChannels === 0) merged.maxAudioChannels = Math.max(2, ...Object.values(merged.audio).map((a) => a.maxChannels || 0))
  return merged
}

/** A header value: base64url(JSON) or plain JSON. Returns the object, or null. */
function parseDeclaration(text) {
  const s = String(text || '').trim()
  if (!s || s.length > 16 * 1024) return null
  try {
    if (s.startsWith('{')) return JSON.parse(s)
    if (/^[A-Za-z0-9_-]+={0,2}$/.test(s)) return JSON.parse(Buffer.from(s, 'base64url').toString('utf8'))
  } catch { /* fall through */ }
  return null
}

/** A short, human-readable line for the API and the docs: "androidtv (default): hevc, h264 · HDR10 HLG · ..." */
function describeProfile(p) {
  const codecs = Object.keys(p.video)
  const hdr = []
  if (p.hdr.hdr10) hdr.push('HDR10')
  if (p.hdr.hdr10plus) hdr.push('HDR10+')
  if (p.hdr.hlg) hdr.push('HLG')
  if (p.hdr.dv.length) hdr.push(`Dolby Vision ${p.hdr.dv.join('/')}`)
  const audio = Object.keys(p.audio).map((k) => (p.audio[k].passthrough ? `${k}*` : k))
  return `${p.client || 'generic'} (${p.source || 'declared'}): video ${codecs.join(', ') || 'none'} · ${hdr.join(' ') || 'SDR only'} · audio ${audio.join(', ') || 'none'} · ${p.maxHeight ? p.maxHeight + 'p' : 'any size'}`
}

/** What a client sends: a declaration in the compact wire form (the inverse of normalize, for tests and docs). */
function toDeclaration(p) {
  const video = {}
  for (const [k, v] of Object.entries(p.video)) video[k] = { profiles: v.profiles, maxLevel: v.maxLevel || undefined, bitDepths: v.bitDepths }
  const hdr = []
  if (p.hdr.hdr10) hdr.push('hdr10')
  if (p.hdr.hdr10plus) hdr.push('hdr10plus')
  if (p.hdr.hlg) hdr.push('hlg')
  if (p.hdr.dv.length) hdr.push(`dv:${p.hdr.dv.join(',')}`)
  if (p.hdr.dvFallback) hdr.push('dvfallback')
  const audio = {}
  for (const [k, v] of Object.entries(p.audio)) audio[k] = { maxChannels: v.maxChannels, ...(v.passthrough ? { passthrough: true } : {}), ...(v.decode === false ? { decode: false } : {}), ...(v.atmos ? { atmos: true } : {}) }
  return { v: PROFILE_VERSION, client: p.client, video, hdr, maxHeight: p.maxHeight || undefined, maxWidth: p.maxWidth || undefined, maxFps: p.maxFps || undefined, maxBitrateKbps: p.maxBitrateKbps || undefined, audio, maxAudioChannels: p.maxAudioChannels || undefined, containers: p.containers, streaming: p.streaming, subtitles: p.subtitles }
}

module.exports = {
  PROFILE_VERSION,
  PLATFORMS,
  VIDEO_CODECS,
  AUDIO_KEYS,
  CONTAINERS,
  H264_RANK,
  detectPlatform,
  profileKey,
  normalize,
  defaultProfile,
  resolveProfile,
  parseDeclaration,
  describeProfile,
  toDeclaration
}
