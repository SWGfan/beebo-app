'use strict'
// ============================================================================
// phoneSpeakersChannels.js - phone speakers for movies: what each phone plays, and the ffmpeg command
// that makes it. Pure: nothing here runs ffmpeg or touches the network, so every choice is unit-tested
// (test/phone-speakers-channels.test.js also runs the real bundled ffmpeg on a synthesized 5.1 file).
// ----------------------------------------------------------------------------
// A film has N audio channels (mono, 2.0, 5.1, 7.1...). Each phone is a "seat" that plays ONE mono
// "feed" cut from the film's sound:
//
//   FL FR FC   front left / right / centre      SL SR  surround left / right (side or back pair)
//   LFE        the subwoofer feed: the film's bass channel plus the low end of the main channels,
//              low-passed at 120 Hz (a phone cannot play it, but a phone on a speaker or a real sub can)
//   BL BR      the rear pair of a 7.1 film      DL DR  the stereo mix-down, left / right ("stereo pair")
//   DM         the whole film folded to one channel ("everyone", the music-party preset)
//
// A feed the film does not have is DERIVED (the fallback, never silence): a missing centre is the
// phantom centre (left + right), missing surrounds are the front pair at -6 dB, a film with no bass
// channel feeds the sub from the low end of everything.
//
// Why mono WAV pieces and not AAC/Opus: every piece must start exactly on a multiple of SEGMENT_SECONDS
// and hold exactly rate*SEGMENT_SECONDS samples, so the phone can chain pieces with no gap and no
// click. A lossy codec adds priming/padding samples to every piece; 16-bit PCM has none. It is
// also the format every phone browser can decode. The cost is bandwidth (mono 32 kHz = 64 KB/s per
// phone, a few Mbit/s for a whole living room), which a home network does not notice.
// ============================================================================

const path = require('path')
const hlsAudio = require('./hlsAudio')
const ffmpegArgs = require('./ffmpegArgs')

const SEGMENT_SECONDS = 5
const DEFAULT_RATE = 32000
const LFE_RATE = 8000
const ALLOWED_RATES = Object.freeze([16000, 24000, 32000, 44100, 48000])
const LFE_CUTOFF_HZ = 120

const FEEDS = Object.freeze({
  FL: { id: 'FL', label: 'Front left', short: 'FL', kind: 'sat' },
  FR: { id: 'FR', label: 'Front right', short: 'FR', kind: 'sat' },
  FC: { id: 'FC', label: 'Centre (dialogue)', short: 'C', kind: 'sat' },
  SL: { id: 'SL', label: 'Surround left', short: 'SL', kind: 'sat' },
  SR: { id: 'SR', label: 'Surround right', short: 'SR', kind: 'sat' },
  LFE: { id: 'LFE', label: 'Bass (subwoofer)', short: 'Sub', kind: 'sub' },
  BL: { id: 'BL', label: 'Back left', short: 'BL', kind: 'sat' },
  BR: { id: 'BR', label: 'Back right', short: 'BR', kind: 'sat' },
  DL: { id: 'DL', label: 'Stereo left', short: 'L', kind: 'mix' },
  DR: { id: 'DR', label: 'Stereo right', short: 'R', kind: 'mix' },
  DM: { id: 'DM', label: 'Everything (mix)', short: 'All', kind: 'mix' }
})
const FEED_IDS = Object.freeze(Object.keys(FEEDS))
const isFeed = (id) => typeof id === 'string' && Object.prototype.hasOwnProperty.call(FEEDS, id)
const MODES = Object.freeze(['surround', 'stereo', 'everyone'])

/** Where a speaker's sound sits when the TV itself plays a missing feed: [left gain, right gain]. */
const TV_PAN = Object.freeze({
  FL: [1, 0], FR: [0, 1], FC: [0.7, 0.7], SL: [0.9, 0], SR: [0, 0.9], LFE: [0.5, 0.5], BL: [0.8, 0], BR: [0, 0.8],
  DL: [1, 0], DR: [0, 1], DM: [0.7, 0.7]
})

/** When a seat's phone is gone and "fold into a neighbour" is on: who can take over, best first. */
const NEIGHBOURS = Object.freeze({
  FL: ['FC', 'SL'], FR: ['FC', 'SR'], FC: ['FL', 'FR'], SL: ['FL', 'SR', 'BL'], SR: ['FR', 'SL', 'BR'],
  BL: ['SL', 'FL'], BR: ['SR', 'FR'], LFE: ['FC', 'FL', 'FR'], DL: ['DR'], DR: ['DL'], DM: []
})
const FOLD_GAIN = 0.75

// ------------------------------------------------------------------ the film's own channels
/**
 * What the picked audio track is. `track` is a playbackTracks audio entry
 * { channels, channelLayout, streamIndex, codec }. Never throws: an odd or unknown layout still gets an answer.
 */
function describeSource(track) {
  const channels = Number(track && track.channels) > 0 ? Math.min(24, Math.floor(Number(track.channels))) : 0
  const layout = track && track.channelLayout ? String(track.channelLayout) : ''
  let roles = channels ? hlsAudio.channelRoles(layout, channels) : null
  const known = !!roles
  if (!roles && channels) roles = channels === 1 ? ['FC'] : channels === 2 ? ['FL', 'FR'] : null
  const has = (r) => !!roles && roles.includes(r)
  const hasSurroundPair = has('SL') || has('BL') || has('SR') || has('BR')
  const kind = !channels ? 'none' : channels === 1 ? 'mono' : channels === 2 ? 'stereo' : hasSurroundPair || has('FC') ? 'surround' : 'multi'
  return {
    channels, layout, roles: roles || [], rolesKnown: known || channels <= 2,
    kind, hasLfe: has('LFE') || has('LFE2'), hasCentre: has('FC'),
    hasSides: has('SL') || has('SR'), hasBacks: has('BL') || has('BR'),
    streamIndex: track && Number.isInteger(track.streamIndex) ? track.streamIndex : null,
    words: hlsAudio.layoutWords(channels, layout) || (channels ? `${channels} channels` : 'no sound')
  }
}

/** The mode a film starts in: surround for real surround films, a stereo pair for 2.0, everyone for mono. */
function defaultMode(source) {
  if (!source || !source.channels) return 'everyone'
  if (source.kind === 'surround' || (source.kind === 'multi' && source.channels >= 4)) return 'surround'
  if (source.kind === 'stereo') return 'stereo'
  return 'everyone'
}

/** Join order for seats. surround: FL FR C SL SR Sub (+ BL BR on a 7.1); stereo: L R; everyone: all take the mix. */
function seatOrder(mode, source) {
  if (mode === 'stereo') return ['DL', 'DR']
  if (mode === 'everyone') return []
  const r = (source && source.roles) || []
  const has = (x) => r.includes(x)
  const wide = !!source && source.channels >= 5
  const order = ['FL', 'FR']
  if (wide || has('FC')) order.push('FC')
  if (wide || has('SL') || has('BL')) order.push('SL', 'SR')
  if (has('LFE') || (!!source && !source.rolesKnown && source.channels >= 6)) order.push('LFE')
  if (has('SL') && has('BL')) order.push('BL', 'BR')
  return order
}

/** Every feed this room plays, by mode (what the TV "fills in" against). */
function requiredFeeds(mode, source) {
  if (mode === 'stereo') return ['DL', 'DR']
  if (mode === 'everyone') return ['DM']
  return seatOrder('surround', source)
}

// ------------------------------------------------------------------ recipes (pan expressions)
const num = (n) => String(Math.round(n * 1000) / 1000)
const term = (gain, idx) => `${num(gain)}*c${idx}`

function indexOfRole(roles, list) {
  for (const r of list) { const i = roles.indexOf(r); if (i >= 0) return i }
  return -1
}

/** pan terms for the left, right sides of the standard stereo fold-down of these roles. */
function foldTerms(roles, gainSet = 'standard') {
  const g = hlsAudio.DOWNMIX_GAINS[gainSet] || hlsAudio.DOWNMIX_GAINS.standard
  const L = []
  const R = []
  roles.forEach((role, i) => {
    const t = hlsAudio.roleTarget(role)
    if (!t) return
    const gain = g[t[1]]
    if (t[0] === 'L' || t[0] === 'B') L.push([gain, i])
    if (t[0] === 'R' || t[0] === 'B') R.push([gain, i])
  })
  return { L, R }
}

/**
 * How one feed is cut from the film: { filter, derived, note, rate, limiter }.
 * filter is the ffmpeg audio filter chain that turns the film's channels into this mono feed (pan, low-pass, limiter).
 * `roles` are the film's channels in stream order (describeSource(...).roles).
 */
function feedRecipe(feed, roles, { rate = DEFAULT_RATE } = {}) {
  if (!isFeed(feed)) throw new Error(`unknown feed ${feed}`)
  const list = Array.isArray(roles) && roles.length ? roles : ['FL', 'FR']
  const ix = (arr) => indexOfRole(list, arr)
  const fl = ix(['FL']); const fr = ix(['FR']); const fc = ix(['FC'])
  const mono = list.length === 1
  let terms = null
  let derived = false
  let note = ''
  let limiter = false
  let lowpass = 0

  const single = (i) => [[1, i]]
  const front = (own, other) => (own >= 0 ? single(own) : (fc >= 0 ? [[0.707, fc]] : (other >= 0 ? [[1, other]] : single(0))))
  switch (feed) {
    case 'FL':
      terms = mono ? single(0) : front(fl, fr)
      if (fl < 0) { derived = true; note = 'this film has no front-left channel' }
      break
    case 'FR':
      terms = mono ? single(0) : front(fr, fl)
      if (fr < 0) { derived = true; note = 'this film has no front-right channel' }
      break
    case 'FC':
      if (fc >= 0) terms = single(fc)
      else if (fl >= 0 && fr >= 0) { terms = [[0.707, fl], [0.707, fr]]; derived = true; limiter = true; note = 'no centre channel: the phantom centre (left + right)' }
      else { terms = single(0); derived = true; note = 'mono film: the same sound everywhere' }
      break
    case 'SL': case 'SR': {
      const left = feed === 'SL'
      const own = ix(left ? ['SL', 'BL', 'SDL', 'SSL'] : ['SR', 'BR', 'SDR', 'SSR'])
      const bc = ix(['BC'])
      if (own >= 0) terms = single(own)
      else if (bc >= 0) { terms = [[0.707, bc]]; derived = true; note = 'no side channel: the back-centre channel' }
      else { const f = left ? fl : fr; terms = f >= 0 ? [[0.5, f]] : (mono ? [[0.5, 0]] : [[0.5, 0]]); derived = true; note = 'no surround channel: the front speaker at half level' }
      break
    }
    case 'BL': case 'BR': {
      const left = feed === 'BL'
      const own = ix(left ? ['BL'] : ['BR'])
      const side = ix(left ? ['SL', 'SDL', 'SSL'] : ['SR', 'SDR', 'SSR'])
      const bc = ix(['BC'])
      if (own >= 0) terms = single(own)
      else if (side >= 0) { terms = single(side); derived = true; note = 'no rear channel: the side channel' }
      else if (bc >= 0) { terms = [[0.707, bc]]; derived = true; note = 'no rear channel: the back-centre channel' }
      else { const f = left ? fl : fr; terms = [[0.5, f >= 0 ? f : 0]]; derived = true; note = 'no rear channel: the front speaker at half level' }
      break
    }
    case 'LFE': {
      const lfe = ix(['LFE', 'LFE2'])
      const mains = [fl, fr, fc].filter((i) => i >= 0)
      if (mono) { terms = [[0.5, 0]]; derived = true; note = 'mono film: the low end of the sound'; }
      else if (lfe >= 0) { terms = [[1, lfe], ...mains.map((i) => [0.25, i])]; note = 'bass channel plus the low end of the main channels' }
      else { terms = mains.length ? mains.map((i) => [0.4, i]) : [[0.5, 0]]; derived = true; note = 'no bass channel: the low end of the main channels' }
      limiter = true
      lowpass = LFE_CUTOFF_HZ
      break
    }
    case 'DL': case 'DR': case 'DM': {
      if (mono) { terms = single(0); break }
      const { L, R } = foldTerms(list)
      if (!L.length || !R.length) { terms = [[0.5, 0], [0.5, Math.min(1, list.length - 1)]]; derived = true; note = 'unknown channel layout: first two channels'; limiter = true; break }
      if (feed === 'DL') terms = L
      else if (feed === 'DR') terms = R
      else terms = [...L.map(([g, i]) => [g * 0.5, i]), ...R.map(([g, i]) => [g * 0.5, i])]
      limiter = terms.length > 1
      break
    }
    default:
      throw new Error(`unknown feed ${feed}`)
  }
  // Two channels that sum to the same source channel are merged (a centre in both sides of a mono sum).
  const merged = new Map()
  for (const [g, i] of terms) merged.set(i, (merged.get(i) || 0) + g)
  const pan = `pan=mono|c0=${Array.from(merged, ([i, g]) => term(g, i)).join('+')}`
  const chain = [pan]
  if (lowpass) chain.push(`lowpass=f=${lowpass}`, `lowpass=f=${lowpass}`)
  if (limiter) chain.push(hlsAudio.LIMITER_FILTER)
  const outRate = feed === 'LFE' ? LFE_RATE : rate
  return { feed, filter: chain.join(','), derived, note, rate: outRate, limiter, lowpassHz: lowpass }
}

// ------------------------------------------------------------------ file names and the ffmpeg command
const segmentFile = (feed, n) => `${feed}-${n}.wav`
function parseSegmentFile(name) {
  const m = /^([A-Z]{2,3})-(\d{1,6})\.wav$/.exec(String(name || ''))
  return m && isFeed(m[1]) ? { feed: m[1], n: Number(m[2]) } : null
}
const framesFor = (rate) => Math.round(rate / 20) // 50 ms; SEGMENT_SECONDS is a whole number of these for every allowed rate

/**
 * The ffmpeg command for one run of a session: reads the film from `startSegment * SEGMENT_SECONDS` on and writes
 * one mono WAV per feed per piece into outDir (FL-0.wav, FL-1.wav ...).
 *   input          the film file
 *   source         describeSource(...)
 *   feeds          the feeds to cut (FEED_IDS entries)
 *   startSegment   first piece this run makes (a seek starts a run there)
 *   rate           sample rate of the ordinary feeds (the bass feed always uses LFE_RATE)
 *   profile        encoderCapabilities.performanceProfile() (a weak PC decodes on one thread)
 *   codec          'wav' (16-bit PCM, what the phones use) or 'flac' (lossless, half the size, for later)
 */
function buildSessionArgs({ input, source, feeds, startSegment = 0, outDir, rate = DEFAULT_RATE, profile = null, codec = 'wav', segmentSeconds = SEGMENT_SECONDS } = {}) {
  if (!source || !Number.isInteger(source.streamIndex)) throw new Error('no audio track')
  const list = Array.from(new Set((feeds || []).filter(isFeed)))
  if (!list.length) throw new Error('no feeds')
  if (!ALLOWED_RATES.includes(rate)) throw new Error(`unsupported sample rate ${rate}`)
  if (codec !== 'wav' && codec !== 'flac') throw new Error(`unsupported codec ${codec}`)
  const start = Math.max(0, Math.floor(Number(startSegment) || 0))
  const args = ['-hide_banner', '-nostdin', '-v', 'error', '-y']
  if (profile && profile.tier === 'low') args.push('-threads', '1', '-filter_threads', '1')
  else if (profile && profile.filterThreads) args.push('-filter_threads', String(Math.min(2, profile.filterThreads)))
  if (start > 0) args.push('-ss', (start * segmentSeconds).toFixed(3))
  args.push(...ffmpegArgs.inputArgs(input))
  const recipes = list.map((f) => feedRecipe(f, source.roles, { rate }))
  const split = `[0:${source.streamIndex}]aresample=async=1:first_pts=0,asplit=${list.length}${list.map((_, i) => `[s${i}]`).join('')}`
  const legs = recipes.map((r, i) => `[s${i}]${r.filter},aresample=${r.rate},asetnsamples=n=${framesFor(r.rate)}:p=0[o${i}]`)
  args.push('-filter_complex', [split, ...legs].join(';'))
  list.forEach((f, i) => {
    args.push('-map', `[o${i}]`, '-c:a', codec === 'flac' ? 'flac' : 'pcm_s16le')
    args.push('-f', 'segment', '-segment_time', String(segmentSeconds), '-segment_format', codec === 'flac' ? 'flac' : 'wav',
      '-segment_start_number', String(start), '-reset_timestamps', '1', path.join(outDir, `${f}-%d.${codec === 'flac' ? 'flac' : 'wav'}`))
  })
  return args
}

/** How many pieces a film of this length has (the last may be short). */
function segmentCount(durationSec, segmentSeconds = SEGMENT_SECONDS) {
  const d = Number(durationSec) || 0
  return d > 0 ? Math.max(1, Math.ceil(d / segmentSeconds - 1e-6)) : 0
}

// ------------------------------------------------------------------ who plays what
/**
 * Given the seats of the phones that are really here, work out every speaker's layers.
 *   mode        'surround' | 'stereo' | 'everyone'
 *   source      describeSource(...)
 *   seats       Map/obj: speaker id -> seat (a feed id or '') for each PRESENT phone (connected and unlocked)
 *   fillIn      'tv' | 'neighbour' | 'off'
 * Returns { layers: { [speakerId]: [{feed, gain}] }, tv: [{feed, gain}], dropped: [feed] , missing: [feed] }
 *   layers   what each present phone plays: its own seat, plus feeds folded in from an absent neighbour
 *   tv       feeds the TV plays itself (fillIn 'tv': every feed no phone covers)
 *   missing  feeds nobody covers
 *   dropped  missing feeds that are simply not played (fillIn 'off', or 'neighbour' with no neighbour left)
 */
function resolveLayers({ mode, source, seats, fillIn = 'tv' }) {
  const entries = seats instanceof Map ? Array.from(seats) : Object.entries(seats || {})
  const layers = {}
  const covered = new Set()
  for (const [id, seat] of entries) {
    layers[id] = []
    if (isFeed(seat)) { layers[id].push({ feed: seat, gain: 1 }); covered.add(seat) }
    else if (seat === 'DM' || (mode === 'everyone' && !seat)) { layers[id].push({ feed: 'DM', gain: 1 }); covered.add('DM') }
  }
  const present = entries.length > 0
  const required = requiredFeeds(mode, source)
  const missing = present ? required.filter((f) => !covered.has(f)) : []
  const tv = []
  const dropped = []
  if (mode === 'everyone') return { layers, tv: [], dropped: [], missing: [] }
  for (const feed of missing) {
    if (fillIn === 'tv') { tv.push({ feed, gain: 1 }); continue }
    if (fillIn === 'neighbour') {
      const host = (NEIGHBOURS[feed] || []).find((n) => covered.has(n) && required.includes(n))
      if (host) {
        const target = entries.find(([, seat]) => seat === host)
        if (target) { layers[target[0]].push({ feed, gain: FOLD_GAIN }); continue }
      }
    }
    dropped.push(feed)
  }
  return { layers, tv, dropped, missing }
}

module.exports = {
  SEGMENT_SECONDS, DEFAULT_RATE, LFE_RATE, ALLOWED_RATES, LFE_CUTOFF_HZ, FEEDS, FEED_IDS, MODES, TV_PAN, NEIGHBOURS, FOLD_GAIN,
  isFeed, describeSource, defaultMode, seatOrder, requiredFeeds, feedRecipe, foldTerms,
  segmentFile, parseSegmentFile, framesFor, buildSessionArgs, segmentCount, resolveLayers
}
