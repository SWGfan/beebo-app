'use strict'
// ============================================================================
// playbackTracks.js - what is inside one video file, for the "Quality & audio" picker.
// ----------------------------------------------------------------------------
// One ffprobe per file (cached by path + size + modified time) answers:
//   * the video stream (codec, size, frame rate, HDR or not, bitrate)
//   * every audio track: language, codec, channels, title -> a plain-English label
//   * every embedded subtitle track, and whether it is TEXT (can become WebVTT and
//     be shown by any player) or an IMAGE (Blu-ray PGS / DVD VobSub - pictures of
//     words, which can only be shown by burning them into a transcode).
//   * the chapter list (titles cleaned by chapterModel.js; metadata only, never muxed)
// It also extracts one embedded text track to WebVTT on demand, cached on disk.
// Nothing here touches the original file except reading it.
// ============================================================================

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execFile, spawn } = require('child_process')
const ffmpegArgs = require('./ffmpegArgs') // file: prefix + -protocol_whitelist for every library input
const chapterModel = require('./chapterModel')

const PROBE_ARGS = [
  '-v', 'error',
  '-show_entries',
  'stream=index,codec_type,codec_name,profile,level,pix_fmt,bits_per_raw_sample,field_order,channels,channel_layout,width,height,bit_rate,r_frame_rate,avg_frame_rate,color_transfer,start_time' +
    ':stream_tags=language,title' +
    ':stream_disposition=default,forced,hearing_impaired,attached_pic,comment,visual_impaired',
  '-show_entries', 'format=format_name,duration,bit_rate,start_time',
  '-show_chapters',
  '-of', 'json'
]

const TEXT_SUB_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text', 'subviewer', 'subviewer1', 'microdvd', 'sami', 'realtext', 'jacosub', 'mpl2', 'pjs', 'vplayer', 'stl'])
const IMAGE_SUB_CODECS = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub', 'dvb_teletext'])

const LANGUAGES = {
  en: 'English', eng: 'English', es: 'Spanish', spa: 'Spanish', fr: 'French', fra: 'French', fre: 'French',
  de: 'German', deu: 'German', ger: 'German', it: 'Italian', ita: 'Italian', pt: 'Portuguese', por: 'Portuguese',
  ja: 'Japanese', jpn: 'Japanese', ko: 'Korean', kor: 'Korean', zh: 'Chinese', chi: 'Chinese', zho: 'Chinese',
  ru: 'Russian', rus: 'Russian', nl: 'Dutch', dut: 'Dutch', nld: 'Dutch', pl: 'Polish', pol: 'Polish',
  ar: 'Arabic', ara: 'Arabic', hi: 'Hindi', hin: 'Hindi', sv: 'Swedish', swe: 'Swedish', da: 'Danish', dan: 'Danish',
  fi: 'Finnish', fin: 'Finnish', no: 'Norwegian', nor: 'Norwegian', nob: 'Norwegian', tr: 'Turkish', tur: 'Turkish',
  el: 'Greek', ell: 'Greek', gre: 'Greek', he: 'Hebrew', heb: 'Hebrew', th: 'Thai', tha: 'Thai', vi: 'Vietnamese', vie: 'Vietnamese',
  id: 'Indonesian', ind: 'Indonesian', cs: 'Czech', ces: 'Czech', cze: 'Czech', ro: 'Romanian', ron: 'Romanian', rum: 'Romanian',
  hu: 'Hungarian', hun: 'Hungarian', uk: 'Ukrainian', ukr: 'Ukrainian', bg: 'Bulgarian', bul: 'Bulgarian',
  hr: 'Croatian', hrv: 'Croatian', sr: 'Serbian', srp: 'Serbian', sk: 'Slovak', slk: 'Slovak', slo: 'Slovak',
  sl: 'Slovenian', slv: 'Slovenian', ms: 'Malay', msa: 'Malay', may: 'Malay', fa: 'Persian', fas: 'Persian', per: 'Persian',
  ta: 'Tamil', tam: 'Tamil', te: 'Telugu', tel: 'Telugu', tl: 'Filipino', fil: 'Filipino', ca: 'Catalan', cat: 'Catalan',
  et: 'Estonian', est: 'Estonian', lv: 'Latvian', lav: 'Latvian', lt: 'Lithuanian', lit: 'Lithuanian', is: 'Icelandic', ice: 'Icelandic', isl: 'Icelandic'
}
// ISO 639-2 (what containers use) -> the 2-letter code OpenSubtitles and Android use.
const TO_TWO_LETTER = {
  eng: 'en', spa: 'es', fra: 'fr', fre: 'fr', deu: 'de', ger: 'de', ita: 'it', por: 'pt', jpn: 'ja', kor: 'ko',
  chi: 'zh', zho: 'zh', rus: 'ru', dut: 'nl', nld: 'nl', pol: 'pl', ara: 'ar', hin: 'hi', swe: 'sv', dan: 'da',
  fin: 'fi', nor: 'no', nob: 'no', tur: 'tr', ell: 'el', gre: 'el', heb: 'he', tha: 'th', vie: 'vi', ind: 'id',
  ces: 'cs', cze: 'cs', ron: 'ro', rum: 'ro', hun: 'hu', ukr: 'uk', bul: 'bg', hrv: 'hr', srp: 'sr', slk: 'sk',
  slo: 'sk', slv: 'sl', msa: 'ms', may: 'ms', fas: 'fa', per: 'fa', tam: 'ta', tel: 'te', fil: 'tl', cat: 'ca',
  est: 'et', lav: 'lv', lit: 'lt', ice: 'is', isl: 'is'
}

const CODEC_WORDS = {
  aac: 'AAC', ac3: 'Dolby Digital', eac3: 'Dolby Digital Plus', dts: 'DTS', truehd: 'Dolby TrueHD', mp3: 'MP3',
  mp2: 'MP2', opus: 'Opus', vorbis: 'Vorbis', flac: 'FLAC', alac: 'Apple Lossless',
  subrip: 'SRT', ass: 'ASS', ssa: 'SSA', webvtt: 'WebVTT', mov_text: 'MP4 text', hdmv_pgs_subtitle: 'Blu-ray (PGS)',
  dvd_subtitle: 'DVD (VobSub)', dvb_subtitle: 'DVB', xsub: 'XSUB', eia_608: 'Closed captions'
}

function codecWords(codec) {
  const c = String(codec || '').toLowerCase()
  return CODEC_WORDS[c] || c.toUpperCase()
}

function languageCode(raw) {
  const s = String(raw || '').trim().toLowerCase()
  if (!s || s === 'und' || s === 'unk' || s === 'zxx' || s === 'mis') return ''
  return s
}
function languageName(code) {
  const c = languageCode(code)
  if (!c) return ''
  return LANGUAGES[c] || LANGUAGES[c.split(/[-_]/)[0]] || c.toUpperCase()
}
function twoLetter(code) {
  const c = languageCode(code)
  if (!c) return ''
  if (c.length === 2 || /^[a-z]{2}-[a-z]{2}$/.test(c)) return c
  return TO_TWO_LETTER[c] || c.split(/[-_]/)[0]
}
/** Do two language codes (any of en / eng / en-US) name the same language? */
function sameLanguage(a, b) {
  const x = twoLetter(a), y = twoLetter(b)
  return !!x && x === y
}

function channelWords(ch) {
  const n = Number(ch)
  if (!Number.isFinite(n) || n <= 0) return ''
  if (n === 1) return 'Mono'
  if (n === 2) return 'Stereo'
  if (n === 6) return '5.1'
  if (n === 8) return '7.1'
  return n + ' channels'
}

function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (v == null || v === '' || v === 'N/A') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
function fps(rate) {
  const m = /^(\d+)\/(\d+)$/.exec(String(rate || ''))
  if (!m) return null
  const d = Number(m[2])
  if (!d) return null
  const f = Number(m[1]) / d
  return f > 0 && f < 1000 ? Math.round(f * 1000) / 1000 : null
}

function subtitleKind(codec) {
  if (TEXT_SUB_CODECS.has(codec)) return 'text'
  if (IMAGE_SUB_CODECS.has(codec) && codec !== 'dvb_teletext') return 'image'
  return 'unsupported'
}

// Raw ffprobe JSON -> the compact description the picker and the transcoder read.
function parseTracks(parsed) {
  if (!parsed || typeof parsed !== 'object') return null
  const streams = Array.isArray(parsed.streams) ? parsed.streams : []
  const format = parsed.format || {}
  const disp = (s) => s.disposition || {}
  const tags = (s) => s.tags || {}

  const videoStream = streams.find((s) => s && s.codec_type === 'video' && !disp(s).attached_pic)
  let video = null
  if (videoStream) {
    const transfer = String(videoStream.color_transfer || '')
    video = {
      streamIndex: num(videoStream.index),
      codec: videoStream.codec_name || null,
      profile: videoStream.profile || null,
      width: num(videoStream.width),
      height: num(videoStream.height),
      fps: fps(videoStream.avg_frame_rate) || fps(videoStream.r_frame_rate),
      pixFmt: videoStream.pix_fmt || null,
      hdr: transfer === 'smpte2084' || transfer === 'arib-std-b67',
      bitrateKbps: num(videoStream.bit_rate) ? Math.round(num(videoStream.bit_rate) / 1000) : null
    }
  }

  let audioOrdinal = 0
  const audio = streams.filter((s) => s && s.codec_type === 'audio').map((s) => {
    const language = languageCode(tags(s).language)
    const title = String(tags(s).title || '').trim()
    const parts = [languageName(language) || 'Unknown language']
    const ch = channelWords(s.channels)
    if (ch) parts.push(ch)
    parts.push(CODEC_WORDS[s.codec_name] || String(s.codec_name || '').toUpperCase())
    if (disp(s).comment) parts.push('Commentary')
    let label = parts.filter(Boolean).join(' · ')
    if (title && !label.toLowerCase().includes(title.toLowerCase())) label += ` (${title})`
    return {
      ordinal: audioOrdinal++,
      streamIndex: num(s.index),
      codec: s.codec_name || null,
      channels: num(s.channels),
      channelLayout: s.channel_layout ? String(s.channel_layout) : null,
      profile: s.profile ? String(s.profile) : null,
      channelsLabel: channelWords(s.channels),
      language,
      languageName: languageName(language),
      title,
      label,
      isDefault: !!disp(s).default
    }
  })

  let subOrdinal = 0
  const subtitles = streams.filter((s) => s && s.codec_type === 'subtitle').map((s) => {
    const language = languageCode(tags(s).language)
    const title = String(tags(s).title || '').trim()
    const kind = subtitleKind(s.codec_name)
    const forced = !!disp(s).forced || /\bforced\b/i.test(title)
    const hearingImpaired = !!disp(s).hearing_impaired || /\b(sdh|cc)\b/i.test(title)
    let label = languageName(language) || 'Unknown language'
    if (forced) label += ' (Forced)'
    if (hearingImpaired) label += ' (SDH)'
    if (title && !/^(forced|sdh|cc)$/i.test(title) && !label.toLowerCase().includes(title.toLowerCase())) label += ` · ${title}`
    if (kind === 'image') label += ' · picture subtitles'
    return {
      ordinal: subOrdinal++,
      streamIndex: num(s.index),
      codec: s.codec_name || null,
      codecName: CODEC_WORDS[s.codec_name] || String(s.codec_name || '').toUpperCase(),
      kind,
      language,
      languageName: languageName(language),
      title,
      label,
      forced,
      hearingImpaired,
      isDefault: !!disp(s).default
    }
  })

  const durationSec = num(format.duration) || 0
  return {
    formatName: format.format_name || null,
    durationSec,
    bitrateKbps: num(format.bit_rate) ? Math.round(num(format.bit_rate) / 1000) : null,
    video,
    audio,
    subtitles,
    chapters: chapterModel.fromProbe(parsed.chapters, durationSec),
    // The same raw JSON also feeds playbackRules.normalizeProbe (direct play / cast verdicts).
    raw: parsed
  }
}

// ---------------------------------------------------------------- probing
function createTrackProber({ ffprobePath, execFileFn = execFile, maxEntries = 200 } = {}) {
  const cache = new Map()
  const inFlight = new Map()
  const resolvePath = () => (typeof ffprobePath === 'function' ? ffprobePath() : ffprobePath)

  async function probe(filePath) {
    let st
    try { st = fs.statSync(filePath) } catch { return null }
    const key = `${filePath}|${st.size}|${st.mtimeMs}`
    if (cache.has(key)) {
      const v = cache.get(key)
      cache.delete(key); cache.set(key, v)
      return v
    }
    if (inFlight.has(key)) return inFlight.get(key)
    const exe = resolvePath()
    if (!exe) return null
    const p = new Promise((resolve) => {
      execFileFn(exe, [...PROBE_ARGS, ...ffmpegArgs.inputArgs(filePath)], { timeout: 30000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
        if (err) return resolve(null)
        try { resolve(parseTracks(JSON.parse(String(stdout)))) } catch { resolve(null) }
      })
    }).then((result) => {
      inFlight.delete(key)
      if (result) {
        cache.set(key, result)
        while (cache.size > maxEntries) cache.delete(cache.keys().next().value)
      }
      return result
    })
    inFlight.set(key, p)
    return p
  }
  return { probe }
}

// ------------------------------------------------------- subtitle extraction
function extractArgs(filePath, streamIndex, outPath) {
  return [
    '-hide_banner', '-nostdin', '-v', 'error', '-y',
    ...ffmpegArgs.inputArgs(filePath),
    '-map', `0:${Number(streamIndex)}`,
    '-c:s', 'webvtt',
    '-f', 'webvtt',
    outPath
  ]
}

/**
 * Extracts embedded text tracks to WebVTT files in cacheDir, once per file version + track.
 * Reading a text track means reading through the whole file, so the result is kept, and two
 * requests for the same track share one ffmpeg.
 */
function createSubtitleExtractor({ ffmpegPath, cacheDir, spawnFn = spawn, timeoutMs = 10 * 60 * 1000, maxFiles = 200 }) {
  const inFlight = new Map()
  const resolvePath = () => (typeof ffmpegPath === 'function' ? ffmpegPath() : ffmpegPath)

  function pruneCache() {
    try {
      const files = fs.readdirSync(cacheDir).filter((f) => f.endsWith('.vtt'))
        .map((f) => ({ f, t: fs.statSync(path.join(cacheDir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t)
      for (const x of files.slice(maxFiles)) { try { fs.unlinkSync(path.join(cacheDir, x.f)) } catch {} }
    } catch {}
  }

  function extract(filePath, streamIndex) {
    let st
    try { st = fs.statSync(filePath) } catch { return Promise.resolve(null) }
    const key = crypto.createHash('sha1').update(`${filePath}|${st.size}|${st.mtimeMs}|${streamIndex}`).digest('hex').slice(0, 24)
    const out = path.join(cacheDir, key + '.vtt')
    if (fs.existsSync(out)) return Promise.resolve(out)
    if (inFlight.has(key)) return inFlight.get(key)
    const exe = resolvePath()
    if (!exe) return Promise.resolve(null)
    try { fs.mkdirSync(cacheDir, { recursive: true }) } catch {}
    const tmp = path.join(cacheDir, key + '.part.vtt')
    const p = new Promise((resolve) => {
      let child
      try {
        child = spawnFn(exe, extractArgs(filePath, streamIndex, tmp), { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true })
      } catch { return resolve(null) }
      const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, timeoutMs)
      child.on('error', () => { clearTimeout(timer); resolve(null) })
      child.on('exit', (code) => {
        clearTimeout(timer)
        if (code === 0 && fs.existsSync(tmp)) {
          try { fs.renameSync(tmp, out); pruneCache(); return resolve(out) } catch {}
        }
        try { fs.unlinkSync(tmp) } catch {}
        resolve(null)
      })
    }).then((r) => { inFlight.delete(key); return r })
    inFlight.set(key, p)
    return p
  }
  return { extract }
}

module.exports = {
  PROBE_ARGS,
  parseTracks,
  subtitleKind,
  languageName,
  languageCode,
  codecWords,
  twoLetter,
  sameLanguage,
  channelWords,
  createTrackProber,
  createSubtitleExtractor,
  extractArgs
}
