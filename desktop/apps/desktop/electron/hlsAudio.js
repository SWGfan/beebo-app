'use strict'
// ============================================================================
// hlsAudio.js - what the sound of a live conversion becomes, and the ffmpeg
// options that make it so. Pure: no ffmpeg is run here, so every choice is unit-tested.
// ----------------------------------------------------------------------------
// A viewer (web player, phone, TV) can ask for:
//   audioMode  auto | stereo | surround | passthrough
//     stereo       always two channels (a proper mix-down of 5.1/7.1, see below)
//     surround     5.1 when the picked track has 5 or more channels; 3-4 channel and
//                  smaller tracks stay as they are (there is nothing to widen)
//     passthrough  like surround, and the original audio is copied untouched whenever
//                  it is already something HLS can carry (AAC, Dolby Digital, Dolby Digital Plus)
//     auto         surround (or an untouched copy) only when the client says it can play
//                  it (audioCaps); a client that says nothing gets stereo, exactly as before
//   downmix    standard | dialogue     how 5.1/7.1 folds to two speakers
//   night      gentle dynamic range compression (quiet scenes stay, explosions come down)
//   normalize  single-pass EBU R128 loudness levelling (expensive on 5.1: see NORMALIZE_NOTE)
//   audioDelayMs  -500..500, positive = sound later
//
// Everything a conversion needs to know rides in ONE small object, the ticket's `au` field. It
// holds only what differs from the default, so an old client's ticket (and cache key) is
// byte-identical to what it was before this module existed, and any change of audio choice is a
// different ticket, therefore a different session and pieces folder - never a half-old, half-new
// set of pieces.
// ============================================================================

const tracksLib = require('./playbackTracks')

const AUDIO_MODES = ['auto', 'stereo', 'surround', 'passthrough']
const DOWNMIXES = ['standard', 'dialogue']
const HLS_COPY_CODECS = ['aac', 'ac3', 'eac3']
const SURROUND_CODEC_ORDER = ['eac3', 'ac3', 'aac']
const DELAY_LIMIT_MS = 500
const MAX_COPY_CHANNELS = 6
// -copypriorss 0 matters: a copied track has no accurate seek, so without it the sound would start at the
// key frame BEFORE the seek point (often 5-10 s early) while the re-encoded picture starts on time.
const COPY_ARGS = ['-c:a', 'copy', '-copypriorss', '0']

// Audio kbps for a 5.1 conversion at each video quality (stereo keeps QUALITIES[q].audioKbps).
const SURROUND_KBPS = {
  aac: { '1080p': 448, '720p': 384, '480p': 320 },
  ac3: { '1080p': 448, '720p': 448, '480p': 384 },
  eac3: { '1080p': 640, '720p': 448, '480p': 384 }
}

// A gentle "night" curve: only what rises above about -23 dBFS is pulled down (2.5:1), then a
// little make-up gain. The limiter after it is what guarantees nothing clips.
const NIGHT_FILTER = 'acompressor=threshold=0.07:ratio=2.5:attack=15:release=250:makeup=1.5:knee=3'
// -16 LUFS, -1.5 dBTP: the streaming-service norm. Costs roughly 8% of a core on stereo and about
// a third of a core on 5.1 (measured, see the delivery notes), hence opt-in.
const NORMALIZE_FILTER = 'loudnorm=I=-16:TP=-1.5:LRA=11'
// -1 dBFS ceiling: an AAC/AC-3 round trip overshoots a little, this leaves it room. The look-ahead
// delays the sound by its 5 ms attack, well under what anyone can hear against the picture.
const LIMITER_FILTER = 'alimiter=limit=0.89:attack=5:release=50:level=0'
const NORMALIZE_NOTE = 'Loudness levelling uses roughly a third of one processor core while a 5.1 film converts.'

// Mix-down gains per speaker group: the ITU-R BS.775 / Dolby Lo-Ro shape (centre and surrounds at -3 dB,
// bass folded in at -10 dB). ffmpeg's plain -ac 2 uses the same coefficients but has no limiter, so a loud
// surround scene clips; here the limiter after the pan catches the peaks. 'dialogue' lifts the centre
// channel (where the speech lives) 3 dB over 'standard' and lowers the fronts, surrounds and bass so
// speech stays clear at low volume.
const DOWNMIX_GAINS = {
  standard: { front: 1.0, center: 0.707, side: 0.707, back: 0.5, lfe: 0.3, wide: 0.707, height: 0.5 },
  dialogue: { front: 0.85, center: 1.0, side: 0.5, back: 0.35, lfe: 0.2, wide: 0.6, height: 0.35 }
}

// ffmpeg's own layout names -> channel order (native order of that layout).
const LAYOUTS = {
  mono: 'FC', stereo: 'FL+FR', '2.1': 'FL+FR+LFE', '3.0': 'FL+FR+FC', '3.0(back)': 'FL+FR+BC',
  '4.0': 'FL+FR+FC+BC', quad: 'FL+FR+BL+BR', 'quad(side)': 'FL+FR+SL+SR', '3.1': 'FL+FR+FC+LFE',
  '5.0': 'FL+FR+FC+BL+BR', '5.0(side)': 'FL+FR+FC+SL+SR', '4.1': 'FL+FR+FC+LFE+BC',
  '5.1': 'FL+FR+FC+LFE+BL+BR', '5.1(side)': 'FL+FR+FC+LFE+SL+SR',
  '6.0': 'FL+FR+FC+BC+SL+SR', '6.0(front)': 'FL+FR+FLC+FRC+SL+SR', hexagonal: 'FL+FR+FC+BL+BR+BC',
  '6.1': 'FL+FR+FC+LFE+BC+SL+SR', '6.1(back)': 'FL+FR+FC+LFE+BL+BR+BC', '6.1(front)': 'FL+FR+LFE+FLC+FRC+SL+SR',
  '7.0': 'FL+FR+FC+BL+BR+SL+SR', '7.0(front)': 'FL+FR+FC+FLC+FRC+SL+SR',
  '7.1': 'FL+FR+FC+LFE+BL+BR+SL+SR', '7.1(wide)': 'FL+FR+FC+LFE+BL+BR+FLC+FRC', '7.1(wide-side)': 'FL+FR+FC+LFE+FLC+FRC+SL+SR',
  octagonal: 'FL+FR+FC+BL+BR+BC+SL+SR',
  '3.1.2': 'FL+FR+FC+LFE+TFL+TFR', '5.1.2': 'FL+FR+FC+LFE+SL+SR+TFL+TFR', '5.1.2(back)': 'FL+FR+FC+LFE+BL+BR+TFL+TFR',
  '5.1.4': 'FL+FR+FC+LFE+SL+SR+TFL+TFR+TBL+TBR', '7.1.2': 'FL+FR+FC+LFE+BL+BR+SL+SR+TFL+TFR',
  '7.1.4': 'FL+FR+FC+LFE+BL+BR+SL+SR+TFL+TFR+TBL+TBR'
}
// What ffmpeg assumes when a stream says only "6 channels".
const DEFAULT_LAYOUT_BY_COUNT = { 1: 'mono', 2: 'stereo', 3: '3.0', 4: '4.0', 5: '5.0', 6: '5.1(side)', 7: '6.1', 8: '7.1' }

const KNOWN_ROLES = new Set(['FL', 'FR', 'FC', 'LFE', 'LFE2', 'BL', 'BR', 'BC', 'FLC', 'FRC', 'SL', 'SR', 'TC', 'TFL', 'TFC', 'TFR', 'TBL', 'TBC', 'TBR', 'TSL', 'TSR', 'WL', 'WR', 'DL', 'DR', 'SDL', 'SDR', 'SSL', 'SSR'])

// ------------------------------------------------------------ request parsing
function pickEnum(value, allowed, fallback) {
  if (typeof value !== 'string') return fallback
  const s = value.trim().toLowerCase()
  return allowed.includes(s) ? s : fallback
}

function toBool(value) {
  if (value === true || value === 1) return true
  const s = String(value == null ? '' : value).trim().toLowerCase()
  return s === '1' || s === 'true' || s === 'on' || s === 'yes'
}

function toDelayMs(value) {
  if (value == null || value === '' || typeof value === 'boolean') return 0
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.max(-DELAY_LIMIT_MS, Math.min(DELAY_LIMIT_MS, Math.round(n)))
}

/**
 * What the player says it can play. Accepts { maxChannels, codecs: [...] } or the string form
 * "6:aac,ac3,eac3". maxChannels is 0 when the client did not say.
 */
function parseCaps(raw) {
  let maxChannels = 0
  let codecs = []
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    maxChannels = Number(raw.maxChannels)
    codecs = Array.isArray(raw.codecs) ? raw.codecs : String(raw.codecs || '').split(',')
  } else if (typeof raw === 'string') {
    const [n, list] = raw.split(':')
    maxChannels = Number(n)
    codecs = String(list || '').split(',')
  }
  maxChannels = Number.isFinite(maxChannels) ? Math.max(0, Math.min(8, Math.floor(maxChannels))) : 0
  const seen = new Set()
  for (const c of codecs) {
    const codec = String(c || '').trim().toLowerCase()
    if (HLS_COPY_CODECS.includes(codec)) seen.add(codec)
  }
  return { maxChannels, codecs: HLS_COPY_CODECS.filter((c) => seen.has(c)) }
}

/** Any garbage becomes the safe default: auto, standard mix-down, nothing switched on, no delay, no caps. */
function normalizeAudioRequest(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  return {
    mode: pickEnum(r.audioMode, AUDIO_MODES, 'auto'),
    downmix: pickEnum(r.downmix, DOWNMIXES, 'standard'),
    night: toBool(r.night),
    normalize: toBool(r.normalize),
    delayMs: toDelayMs(r.audioDelayMs),
    caps: parseCaps(r.audioCaps)
  }
}

/**
 * The compact `au` object for the ticket, or null when nothing differs from the legacy default
 * (stereo AAC, standard mix-down). Keys: s=1 surround, c=preferred surround codec, k=codecs
 * that may be copied, x=most channels the client plays, m='dialogue', n=1 night, l=1 levelling,
 * d=delay ms.
 */
function ticketAudio(request) {
  const req = request && request.mode ? request : normalizeAudioRequest(request)
  const au = {}
  const caps = req.caps || { maxChannels: 0, codecs: [] }
  const surround = req.mode === 'surround' || req.mode === 'passthrough' || (req.mode === 'auto' && caps.maxChannels >= 6)
  if (surround) {
    au.s = 1
    const preferred = SURROUND_CODEC_ORDER.find((c) => caps.codecs.includes(c)) || 'aac'
    if (preferred !== 'aac') au.c = preferred
  }
  let copy = []
  if (req.mode === 'passthrough') copy = caps.codecs.length ? caps.codecs : HLS_COPY_CODECS
  else if (req.mode === 'auto' && caps.codecs.length && caps.maxChannels > 0) copy = caps.codecs
  if (copy.length) {
    au.k = copy.join(',')
    au.x = surround ? Math.max(6, caps.maxChannels || 6) : Math.max(2, caps.maxChannels || 2)
    if (au.x > MAX_COPY_CHANNELS) au.x = MAX_COPY_CHANNELS
  }
  if (req.downmix === 'dialogue') au.m = 'dialogue'
  if (req.night) au.n = 1
  if (req.normalize) au.l = 1
  if (req.delayMs) au.d = req.delayMs
  return Object.keys(au).length ? au : null
}

/** Reads a ticket's `au` back, tolerating anything (a forged or old ticket gets defaults). */
function readTicketAudio(au) {
  const a = au && typeof au === 'object' ? au : {}
  const codecs = String(a.k || '').split(',').filter((c) => HLS_COPY_CODECS.includes(c))
  return {
    surround: a.s === 1,
    codec: SURROUND_CODEC_ORDER.includes(a.c) ? a.c : 'aac',
    copyCodecs: codecs,
    maxChannels: Math.max(0, Math.min(MAX_COPY_CHANNELS, Math.floor(Number(a.x)) || 0)),
    downmix: a.m === 'dialogue' ? 'dialogue' : 'standard',
    night: a.n === 1,
    normalize: a.l === 1,
    delayMs: toDelayMs(a.d)
  }
}

// ------------------------------------------------- remembered per-user choices
// Stored with the subtitle-language choice in playbackApi's per-user `playbackPrefs` record, so
// they follow the account (and profile) to every device that reads /playback/prefs. `boostDb` is
// only used by the web player (it applies the gain in the browser, so the server never sees it).
const BOOST_LIMIT_DB = 6
const AUDIO_PREF_DEFAULTS = { audioMode: 'auto', downmix: 'standard', night: false, normalize: false, boostDb: 0, audioDelayMs: 0 }

const audioPrefs = {
  defaults: AUDIO_PREF_DEFAULTS,
  read(stored) {
    const p = stored && typeof stored === 'object' ? stored : {}
    const boost = Number(p.boostDb)
    return {
      audioMode: pickEnum(p.audioMode, AUDIO_MODES, AUDIO_PREF_DEFAULTS.audioMode),
      downmix: pickEnum(p.downmix, DOWNMIXES, AUDIO_PREF_DEFAULTS.downmix),
      night: p.night === true,
      normalize: p.normalize === true,
      boostDb: Number.isFinite(boost) ? Math.max(0, Math.min(BOOST_LIMIT_DB, Math.round(boost * 2) / 2)) : 0,
      audioDelayMs: toDelayMs(p.audioDelayMs)
    }
  },
  /** Only the fields of `patch` that are present and valid; anything else is ignored, never repaired. */
  patch(current, patch) {
    const out = {}
    if (!patch || typeof patch !== 'object') return out
    if (typeof patch.audioMode === 'string' && AUDIO_MODES.includes(patch.audioMode)) out.audioMode = patch.audioMode
    if (typeof patch.downmix === 'string' && DOWNMIXES.includes(patch.downmix)) out.downmix = patch.downmix
    if (typeof patch.night === 'boolean') out.night = patch.night
    if (typeof patch.normalize === 'boolean') out.normalize = patch.normalize
    if (typeof patch.boostDb === 'number' && Number.isFinite(patch.boostDb)) out.boostDb = Math.max(0, Math.min(BOOST_LIMIT_DB, Math.round(patch.boostDb * 2) / 2))
    if (typeof patch.audioDelayMs === 'number' && Number.isFinite(patch.audioDelayMs)) out.audioDelayMs = toDelayMs(patch.audioDelayMs)
    return out
  }
}

// ------------------------------------------------------------- channel maths
/** Channel roles in stream order, or null when the layout cannot be worked out. */
function channelRoles(layout, channels) {
  const n = Number(channels)
  if (!Number.isFinite(n) || n < 1 || n > 24) return null
  const name = String(layout || '').trim()
  let roles = null
  if (LAYOUTS[name]) roles = LAYOUTS[name].split('+')
  else {
    const m = /(?:^|\()([A-Z0-9]+(?:\+[A-Z0-9]+)+)\)?$/.exec(name)
    if (m) roles = m[1].split('+')
  }
  if (!roles || roles.length !== n) roles = DEFAULT_LAYOUT_BY_COUNT[n] ? LAYOUTS[DEFAULT_LAYOUT_BY_COUNT[n]].split('+') : null
  if (!roles || roles.length !== n || !roles.every((r) => KNOWN_ROLES.has(r))) return null
  return roles
}

// role -> [sides it feeds, gain group]. L=left R=right B=both.
function roleTarget(role) {
  switch (role) {
    case 'FL': case 'DL': return ['L', 'front']
    case 'FR': case 'DR': return ['R', 'front']
    case 'FC': return ['B', 'center']
    case 'LFE': case 'LFE2': return ['B', 'lfe']
    case 'BL': case 'SL': case 'SDL': case 'SSL': return ['L', 'side']
    case 'BR': case 'SR': case 'SDR': case 'SSR': return ['R', 'side']
    case 'BC': return ['B', 'back']
    case 'FLC': case 'WL': return ['L', 'wide']
    case 'FRC': case 'WR': return ['R', 'wide']
    case 'TFL': case 'TBL': case 'TSL': return ['L', 'height']
    case 'TFR': case 'TBR': case 'TSR': return ['R', 'height']
    case 'TC': case 'TFC': case 'TBC': return ['B', 'height']
    default: return null
  }
}

const num = (n) => String(Math.round(n * 1000) / 1000)

/** pan expression that folds any known layout to stereo, or null for layouts with 2 or fewer channels. */
function stereoDownmixFilter(roles, kind = 'standard') {
  if (!roles || roles.length <= 2) return null
  const g = DOWNMIX_GAINS[kind] || DOWNMIX_GAINS.standard
  const terms = { L: [], R: [] }
  roles.forEach((role, i) => {
    const t = roleTarget(role)
    if (!t) return
    const gain = g[t[1]]
    if (t[0] === 'L' || t[0] === 'B') terms.L.push(`${num(gain)}*c${i}`)
    if (t[0] === 'R' || t[0] === 'B') terms.R.push(`${num(gain)}*c${i}`)
  })
  if (!terms.L.length || !terms.R.length) return null
  return `pan=stereo|c0=${terms.L.join('+')}|c1=${terms.R.join('+')}`
}

const isExact51 = (roles) => !!roles && roles.length === 6 && roles[0] === 'FL' && roles[1] === 'FR' && roles[2] === 'FC' && roles[3] === 'LFE' &&
  ((roles[4] === 'BL' && roles[5] === 'BR') || (roles[4] === 'SL' && roles[5] === 'SR'))

/** pan that turns 5.0/6.x/7.x into 5.1, or null when the stream already is 5.1 (or cannot be worked out). */
function surround51Filter(roles) {
  if (!roles || roles.length < 5 || isExact51(roles)) return null
  const out = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [] }
  const pairs = (roles.includes('BL') || roles.includes('BR') ? 1 : 0) + (roles.includes('SL') || roles.includes('SR') ? 1 : 0)
  const surroundGain = pairs > 1 ? 0.707 : 1
  const add = (slot, i, gain) => out[slot].push(`${num(gain)}*c${i}`)
  roles.forEach((role, i) => {
    switch (role) {
      case 'FL': add(0, i, 1); break
      case 'FR': add(1, i, 1); break
      case 'FC': add(2, i, 1); break
      case 'LFE': case 'LFE2': add(3, i, 1); break
      case 'BL': case 'SL': add(4, i, surroundGain); break
      case 'BR': case 'SR': add(5, i, surroundGain); break
      case 'BC': add(4, i, 0.707); add(5, i, 0.707); break
      case 'FLC': add(0, i, 0.707); break
      case 'FRC': add(1, i, 0.707); break
      case 'TFL': add(0, i, 0.5); break
      case 'TFR': add(1, i, 0.5); break
      case 'TBL': case 'TSL': add(4, i, 0.5); break
      case 'TBR': case 'TSR': add(5, i, 0.5); break
      case 'TC': case 'TFC': add(2, i, 0.5); break
      case 'TBC': add(4, i, 0.35); add(5, i, 0.35); break
      default: break
    }
  })
  const chans = [0, 1, 2, 3, 4, 5].map((slot) => `c${slot}=${out[slot].length ? out[slot].join('+') : '0*c0'}`)
  return `pan=5.1|${chans.join('|')}`
}

// -------------------------------------------------------------------- words
const codecWords = (codec) => tracksLib.codecWords(codec) || 'audio'

/** "Mono", "Stereo", "5.1", "7.1", "6.1"... plain words for a channel layout. */
function layoutWords(channels, layout) {
  const n = Number(channels)
  if (!Number.isFinite(n) || n <= 0) return ''
  if (n === 1) return 'Mono'
  if (n === 2) return 'Stereo'
  const roles = channelRoles(layout, n)
  if (roles) {
    const lfe = roles.filter((r) => r === 'LFE' || r === 'LFE2').length
    const tops = roles.filter((r) => r.startsWith('T')).length
    const beds = roles.length - lfe - tops
    return tops ? `${beds}.${lfe}.${tops}` : `${beds}.${lfe}`
  }
  return `${n} channels`
}

// -------------------------------------------------------------------- plan
const codecOf = (t) => String((t && t.codec) || '').toLowerCase()

function pickSurroundEncoder(preferred, encoders) {
  const have = encoders && typeof encoders === 'object' ? encoders : { aac: true }
  const order = SURROUND_CODEC_ORDER.slice(SURROUND_CODEC_ORDER.indexOf(preferred))
  return order.find((c) => have[c]) || 'aac'
}

/**
 * Decides what the audio of one run becomes.
 *   track     playbackTracks audio entry { codec, channels, channelLayout, profile }
 *   au        the ticket's audio object (see ticketAudio); null/undefined = legacy default
 *   quality   a QUALITIES entry (for the stereo audio bitrate) and its id (for the 5.1 bitrate)
 *   encoders  { aac, ac3, eac3 } booleans of what this ffmpeg can encode
 * Returns { kind: 'none'|'copy'|'encode', codec, channels, layout, bitrateKbps, filters, args,
 *           mixedDown, surround, ... } - `args` is the exact output-option list.
 */
function planAudio({ track, au, quality, qualityId, encoders } = {}) {
  if (!track) return { kind: 'none', codec: null, channels: 0, filters: [], args: ['-an'], mixedDown: false, surround: false }
  const opts = readTicketAudio(au)
  const srcCodec = codecOf(track)
  const srcCh = Number(track.channels) > 0 ? Number(track.channels) : 0
  const roles = srcCh ? channelRoles(track.channelLayout, srcCh) : null
  const wantsFilter = opts.night || opts.normalize || opts.delayMs !== 0
  const canWiden = opts.surround && srcCh >= 5 && !!roles
  const outSurround = canWiden

  // Untouched copy: the client said it can play this codec and this many channels, nothing needs
  // to be done to the sound, and the source is not wider than what a stereo-only client asked for.
  const copyLimit = opts.maxChannels || (opts.surround ? MAX_COPY_CHANNELS : 2)
  if (opts.copyCodecs.includes(srcCodec) && !wantsFilter && srcCh >= 1 && srcCh <= Math.min(copyLimit, MAX_COPY_CHANNELS) && (srcCh <= 2 || opts.surround)) {
    return {
      kind: 'copy', codec: srcCodec, sourceCodec: srcCodec, channels: srcCh, layout: track.channelLayout || '', bitrateKbps: 0, filters: [],
      args: COPY_ARGS, mixedDown: false, surround: srcCh > 2, sourceChannels: srcCh, sourceLayout: track.channelLayout || '',
      sourceProfile: track.profile || '', night: false, normalize: false, delayMs: 0, downmix: opts.downmix
    }
  }

  const filters = []
  let mixedDown = false
  let panApplied = false
  const chain = () => filters.length ? ['-af', filters.join(',')] : []
  const needsResample = srcCh > 2 || wantsFilter
  if (needsResample) filters.push('aresample=48000:async=1:first_pts=0')

  let codec = 'aac'
  let outChannels = 2
  let bitrate = quality && quality.audioKbps ? quality.audioKbps : 128
  let outLayout = 'stereo'
  if (outSurround) {
    codec = pickSurroundEncoder(opts.codec, encoders)
    outChannels = 6
    outLayout = '5.1'
    bitrate = (SURROUND_KBPS[codec] && SURROUND_KBPS[codec][qualityId]) || SURROUND_KBPS[codec]['720p']
    const pan = surround51Filter(roles)
    if (pan) { filters.push(pan); panApplied = true }
    mixedDown = false
  } else if (srcCh > 2) {
    const pan = roles ? stereoDownmixFilter(roles, opts.downmix) : null
    if (pan) { filters.push(pan); panApplied = true }
    else { filters.push('aformat=channel_layouts=stereo'); panApplied = true }
    mixedDown = true
  } else if (srcCh === 1) outLayout = 'stereo'

  if (opts.delayMs > 0) filters.push(`adelay=${opts.delayMs}:all=1`)
  else if (opts.delayMs < 0) filters.push(`atrim=start=${num(-opts.delayMs / 1000)}`, 'asetpts=PTS-STARTPTS')
  if (opts.night) filters.push(NIGHT_FILTER)
  if (opts.normalize) filters.push(NORMALIZE_FILTER, 'aresample=48000')
  if (panApplied || opts.night) filters.push(LIMITER_FILTER)

  const args = [...chain(), '-c:a', codec]
  if (!outSurround) args.push('-ac', '2')
  args.push('-ar', '48000', '-b:a', `${bitrate}k`)
  return {
    kind: 'encode', codec, sourceCodec: srcCodec, channels: outChannels, layout: outLayout, bitrateKbps: bitrate, filters, args,
    mixedDown, surround: outSurround, sourceChannels: srcCh, sourceLayout: track.channelLayout || '', sourceProfile: track.profile || '',
    night: opts.night, normalize: opts.normalize, delayMs: opts.delayMs, downmix: opts.downmix
  }
}

/**
 * Plain words for what is actually playing. Never says more than the pipeline carries: no
 * "lossless" for a conversion, and object audio (Atmos, DTS:X) is only ever mentioned to say it is
 * not kept.
 */
function describeAudio(plan) {
  if (!plan || plan.kind === 'none') return { label: 'No sound', detail: '' }
  const outWords = plan.channels === 6 ? 'Surround 5.1' : plan.channels > 2 ? `Surround ${layoutWords(plan.channels, plan.layout)}` : plan.channels === 1 ? 'Mono' : 'Stereo'
  const srcWords = layoutWords(plan.sourceChannels, plan.sourceLayout)
  const codecPart = codecWords(plan.codec)
  let label = outWords
  if (plan.mixedDown && srcWords) label += ` (mixed down from ${srcWords})`
  label += ` · ${codecPart}`
  const bits = []
  if (plan.kind === 'copy') bits.push('original audio, not re-encoded')
  else if (plan.sourceCodec && plan.sourceCodec !== plan.codec) bits.push(`converted from ${codecWords(plan.sourceCodec)}`)
  else if (plan.kind === 'encode') bits.push('re-encoded for streaming')
  if (plan.kind === 'encode' && /atmos|dts:x|dts-x/i.test(plan.sourceProfile || '')) bits.push('object audio is not kept, plays as regular surround')
  if (plan.mixedDown && plan.downmix === 'dialogue') bits.push('dialogue boosted')
  if (plan.night) bits.push('night mode')
  if (plan.normalize) bits.push('volume levelled')
  if (plan.delayMs) bits.push(`${plan.delayMs > 0 ? '+' : ''}${plan.delayMs} ms delay`)
  return { label, detail: bits.join(', ') }
}

/** The label for a track played as it is (Original quality): what the file itself carries. */
function describeSourceTrack(track) {
  if (!track) return { label: 'No sound', detail: '' }
  const n = Number(track.channels) || 0
  const words = n === 1 ? 'Mono' : n === 2 ? 'Stereo' : n > 2 ? `Surround ${layoutWords(n, track.channelLayout)}` : 'Audio'
  return { label: `${words} · ${codecWords(track.codec)}`, detail: 'original audio, played as stored' }
}

module.exports = {
  AUDIO_MODES,
  DOWNMIXES,
  HLS_COPY_CODECS,
  DELAY_LIMIT_MS,
  BOOST_LIMIT_DB,
  audioPrefs,
  SURROUND_KBPS,
  NIGHT_FILTER,
  NORMALIZE_FILTER,
  NORMALIZE_NOTE,
  LIMITER_FILTER,
  DOWNMIX_GAINS,
  normalizeAudioRequest,
  parseCaps,
  ticketAudio,
  readTicketAudio,
  channelRoles,
  stereoDownmixFilter,
  surround51Filter,
  layoutWords,
  codecWords,
  planAudio,
  describeAudio,
  describeSourceTrack
}
