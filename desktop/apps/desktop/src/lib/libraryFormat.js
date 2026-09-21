// libraryFormat.js — how the Table view writes values down. Pure, so node --test checks it
// (test/library-table.test.js). Every function returns '' for "no value" rather than a
// placeholder: whether that means "not read yet" or "none" is the table's call, not ours.

const finite = (v) => typeof v === 'number' && Number.isFinite(v)

/** Windows-Explorer style sizes: 1024-based, KB/MB/GB/TB. */
export function formatBytes(n) {
  if (!finite(n) || n < 0) return ''
  if (n < 1024) return `${Math.round(n)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  const digits = i === 0 ? 0 : i === 1 ? 1 : 2
  return `${v.toFixed(digits)} ${units[i]}`
}

/** h:mm from seconds, rounded to the nearest minute: 7620 -> "2:07", 2700 -> "0:45". */
export function formatRuntime(seconds) {
  if (!finite(seconds) || seconds <= 0) return ''
  const total = Math.round(seconds / 60)
  const h = Math.floor(total / 60)
  const m = total % 60
  return `${h}:${String(m).padStart(2, '0')}`
}

/** kb/s in, "8.4 Mb/s" or "640 kb/s" out. */
export function formatBitrate(kbps) {
  if (!finite(kbps) || kbps <= 0) return ''
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} Mb/s`
  return `${Math.round(kbps)} kb/s`
}

/** 23.976 -> "23.976", 24 -> "24", 29.97 -> "29.97". */
export function formatFps(fps) {
  if (!finite(fps) || fps <= 0) return ''
  return String(Math.round(fps * 1000) / 1000)
}

/** A rating out of 10 with one decimal, or '' when TMDB has no votes for it. */
export function formatRating(rating) {
  return finite(rating) && rating > 0 ? rating.toFixed(1) : ''
}

/** Local short date from epoch ms. */
export function formatDate(ms) {
  if (!finite(ms) || ms <= 0) return ''
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

/** yyyy-mm-dd in local time, for CSV. */
export function isoDate(ms) {
  if (!finite(ms) || ms <= 0) return ''
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const VIDEO_CODECS = {
  h264: 'H.264', avc1: 'H.264', hevc: 'HEVC', h265: 'HEVC', av1: 'AV1', vp9: 'VP9', vp8: 'VP8',
  mpeg4: 'MPEG-4', mpeg2video: 'MPEG-2', mpeg1video: 'MPEG-1', vc1: 'VC-1', wmv3: 'WMV9', wmv2: 'WMV8',
  wmv1: 'WMV7', msmpeg4v3: 'DivX 3', h263: 'H.263', prores: 'ProRes', theora: 'Theora', mjpeg: 'MJPEG', dvvideo: 'DV'
}
export function formatVideoCodec(codec) {
  const c = String(codec || '').toLowerCase()
  if (!c) return ''
  return VIDEO_CODECS[c] || c.toUpperCase()
}

const AUDIO_CODECS = {
  aac: 'AAC', ac3: 'AC-3', eac3: 'E-AC-3', truehd: 'TrueHD', dts: 'DTS', mp3: 'MP3', mp2: 'MP2',
  opus: 'Opus', vorbis: 'Vorbis', flac: 'FLAC', alac: 'ALAC', wmav2: 'WMA', wmapro: 'WMA Pro',
  pcm_s16le: 'PCM', pcm_s24le: 'PCM', pcm_bluray: 'PCM', pcm_dvd: 'PCM'
}
export function formatAudioCodec(codec, profile) {
  const c = String(codec || '').toLowerCase()
  if (!c) return ''
  if (/atmos/i.test(String(profile || '')) && (c === 'eac3' || c === 'truehd')) return c === 'truehd' ? 'TrueHD Atmos' : 'E-AC-3 Atmos'
  if (c === 'dts') {
    const p = String(profile || '')
    if (/dts:x/i.test(p)) return 'DTS:X'
    if (/\bma\b/i.test(p)) return 'DTS-HD MA'
    if (/\bhra\b/i.test(p)) return 'DTS-HD HRA'
  }
  return AUDIO_CODECS[c] || c.toUpperCase()
}

/** ffprobe channel_layout ("5.1(side)", "stereo") or a plain count -> "5.1", "Stereo". */
export function formatChannels(channels, layout) {
  const l = String(layout || '').toLowerCase()
  const m = /^(\d+\.\d+)/.exec(l)
  if (m) return m[1]
  if (l.startsWith('stereo')) return 'Stereo'
  if (l.startsWith('mono')) return 'Mono'
  const n = Number(channels)
  if (!finite(n) || n <= 0) return ''
  if (n === 1) return 'Mono'
  if (n === 2) return 'Stereo'
  if (n === 6) return '5.1'
  if (n === 8) return '7.1'
  return `${n}ch`
}

/** "AC-3 5.1", "AAC Stereo". */
export function formatAudio(codec, profile, channels, layout) {
  return [formatAudioCodec(codec, profile), formatChannels(channels, layout)].filter(Boolean).join(' ')
}

/** ["English", "French"] -> "English, French"; more than `max` collapses to "English, French +3". */
export function formatList(items, max = 4) {
  const list = (Array.isArray(items) ? items : []).filter(Boolean)
  if (list.length <= max) return list.join(', ')
  return `${list.slice(0, max).join(', ')} +${list.length - max}`
}

/** ".mkv" / "mkv" -> "MKV". */
export function formatContainer(ext) {
  return String(ext || '').replace(/^\./, '').toUpperCase()
}
