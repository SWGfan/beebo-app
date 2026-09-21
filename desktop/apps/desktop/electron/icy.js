'use strict'
// Internet radio wire formats, as pure functions and one stream transform (no network here):
//
//   createIcyStripper(metaint, onMetadata)  a Transform that passes the audio through and lifts out the
//                                           in-band ICY metadata blocks ("StreamTitle='Artist - Song';")
//   parseIcyMetadata(text)                  one block -> { title, url, ... }
//   splitArtistTitle('Artist - Song')       -> { artist, title }
//   icyHeaders(httpHeaders)                 the icy-* response headers -> { name, genre, bitrate, metaint, ... }
//   parsePlaylist(text)                     .pls / .m3u -> the first stream address (HLS is refused)
//   audioKind(contentType)                  is this an audio stream we can relay, and what file type is it
//
// How ICY works: the client asks for metadata with an "Icy-MetaData: 1" request header; the server
// answers with "icy-metaint: N" and then, after every N bytes of audio, one length byte L followed by
// L*16 bytes of text (padded with NULs) - L is 0 when nothing changed. The audio a player receives
// must NOT contain those blocks, so they are removed here.

const { Transform } = require('stream')

const MAX_META_BYTES = 255 * 16
const MAX_TITLE = 300

// Text of one metadata block: UTF-8 when it is valid UTF-8 (most servers now), else Latin-1.
function decodeMeta(buf) {
  let text
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf) } catch { text = buf.toString('latin1') }
  return text.replace(/\0+$/g, '')
}

const cleanText = (s) => String(s == null ? '' : s).replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE)

/**
 * "StreamTitle='Artist - Song';StreamUrl='http://x';" -> { title, url } (empty strings when absent).
 * A title may itself contain a quote, so a value ends at the last "';" before the next key or the end.
 */
function parseIcyMetadata(text) {
  const out = { title: '', url: '' }
  const s = String(text || '')
  const t = /StreamTitle='([\s\S]*?)'\s*(?:;|$)(?=\s*(?:\w+=|$))/.exec(s)
  if (t) out.title = cleanText(t[1])
  const u = /StreamUrl='([\s\S]*?)'\s*(?:;|$)(?=\s*(?:\w+=|$))/.exec(s)
  if (u) {
    const url = cleanText(u[1])
    if (/^https?:\/\/[^\s]+$/i.test(url)) out.url = url
  }
  return out
}

/** "Artist - Song" -> { artist, title }; anything without " - " is all title. */
function splitArtistTitle(raw) {
  const s = cleanText(raw)
  const i = s.indexOf(' - ')
  if (i <= 0 || i + 3 >= s.length) return { artist: '', title: s }
  return { artist: s.slice(0, i).trim(), title: s.slice(i + 3).trim() }
}

/**
 * @param {number} metaint  bytes of audio between metadata blocks (0 = the stream has none: pass everything)
 * @param {(meta: {title: string, url: string, raw: string}) => void} onMetadata  called for every non-empty block
 */
function createIcyStripper(metaint, onMetadata) {
  const interval = Number.isInteger(metaint) && metaint > 0 && metaint <= 1024 * 1024 ? metaint : 0
  let untilMeta = interval // audio bytes left before the next length byte
  let metaLeft = 0 // metadata bytes still to read in the current block
  let metaChunks = []
  return new Transform({
    transform(chunk, _enc, cb) {
      if (!interval) { cb(null, chunk); return }
      const out = []
      let i = 0
      while (i < chunk.length) {
        if (metaLeft > 0) {
          const take = Math.min(metaLeft, chunk.length - i)
          metaChunks.push(chunk.subarray(i, i + take))
          metaLeft -= take
          i += take
          if (metaLeft === 0) {
            const raw = decodeMeta(Buffer.concat(metaChunks))
            metaChunks = []
            const parsed = parseIcyMetadata(raw)
            if (typeof onMetadata === 'function' && (parsed.title || parsed.url)) { try { onMetadata({ ...parsed, raw: cleanText(raw) }) } catch {} }
            untilMeta = interval
          }
        } else if (untilMeta === 0) {
          // The length byte: block length / 16. Zero means "no change" and the audio simply resumes.
          const blocks = chunk[i++]
          const len = Math.min(blocks * 16, MAX_META_BYTES)
          if (len === 0) untilMeta = interval
          else metaLeft = len
        } else {
          const take = Math.min(untilMeta, chunk.length - i)
          out.push(chunk.subarray(i, i + take))
          untilMeta -= take
          i += take
        }
      }
      cb(null, out.length === 1 ? out[0] : Buffer.concat(out))
    }
  })
}

/** Node lower-cases header names; the icy-* set is what Shoutcast and Icecast send. */
function icyHeaders(h) {
  const get = (k) => (h && h[k] !== undefined ? String(Array.isArray(h[k]) ? h[k][0] : h[k]) : '')
  const br = parseInt(get('icy-br').split(',')[0], 10)
  const mi = parseInt(get('icy-metaint'), 10)
  const url = get('icy-url').trim()
  return {
    name: cleanText(get('icy-name') || get('x-audiocast-name')),
    genre: cleanText(get('icy-genre') || get('x-audiocast-genre')),
    description: cleanText(get('icy-description')),
    url: /^https?:\/\/[^\s]+$/i.test(url) ? url : '',
    bitrate: Number.isFinite(br) && br > 0 && br < 5000 ? br : 0,
    metaint: Number.isInteger(mi) && mi > 0 && mi <= 1024 * 1024 ? mi : 0,
    contentType: get('content-type').split(';')[0].trim().toLowerCase()
  }
}

/** .pls or .m3u text -> first http(s) address; { error: 'hls_not_supported' } for a segment playlist. */
function parsePlaylist(text) {
  const s = String(text || '').slice(0, 64 * 1024)
  if (/#EXT-X-(?:STREAM-INF|TARGETDURATION|MEDIA-SEQUENCE|VERSION)/i.test(s)) return { error: 'hls_not_supported' }
  const pls = /^\s*File\d*\s*=\s*(\S+)\s*$/im.exec(s)
  if (pls && /^https?:\/\//i.test(pls[1])) return { url: pls[1] }
  for (const line of s.split(/\r?\n/)) {
    const l = line.trim()
    if (!l || l.startsWith('#')) continue
    if (/^https?:\/\/\S+$/i.test(l)) return { url: l }
  }
  return { error: 'empty_playlist' }
}

const PLAYLIST_TYPES = /^(audio\/x-scpls|application\/pls\+xml|audio\/x-mpegurl|audio\/mpegurl|application\/x-mpegurl|application\/vnd\.apple\.mpegurl|audio\/m3u)$/
const isPlaylistType = (ct) => PLAYLIST_TYPES.test(String(ct || '').split(';')[0].trim().toLowerCase())
const isPlaylistUrl = (u) => { try { return /\.(pls|m3u)$/i.test(new URL(u).pathname) } catch { return false } }

/** { ok, ext, mime } for something we can relay as audio; { ok: false } for a web page or a playlist. */
function audioKind(contentType) {
  const ct = String(contentType || '').split(';')[0].trim().toLowerCase()
  const table = {
    'audio/mpeg': ['mp3', 'audio/mpeg'], 'audio/mp3': ['mp3', 'audio/mpeg'],
    'audio/aac': ['aac', 'audio/aac'], 'audio/aacp': ['aac', 'audio/aacp'], 'audio/x-aac': ['aac', 'audio/aac'],
    'audio/mp4': ['m4a', 'audio/mp4'], 'audio/x-m4a': ['m4a', 'audio/mp4'],
    'audio/ogg': ['ogg', 'audio/ogg'], 'application/ogg': ['ogg', 'audio/ogg'], 'audio/opus': ['opus', 'audio/ogg'], 'audio/vorbis': ['ogg', 'audio/ogg'],
    'audio/flac': ['flac', 'audio/flac'], 'audio/x-flac': ['flac', 'audio/flac'],
    'audio/wav': ['wav', 'audio/wav'], 'audio/x-wav': ['wav', 'audio/wav'], 'audio/webm': ['webm', 'audio/webm']
  }
  if (table[ct]) return { ok: true, ext: table[ct][0], mime: table[ct][1] }
  // Some servers send no type at all, or a generic one; the bytes are still audio.
  if (!ct || ct === 'application/octet-stream' || ct === 'binary/octet-stream') return { ok: true, ext: 'mp3', mime: 'audio/mpeg', guessed: true }
  return { ok: false }
}

module.exports = { createIcyStripper, parseIcyMetadata, splitArtistTitle, icyHeaders, parsePlaylist, isPlaylistType, isPlaylistUrl, audioKind, decodeMeta }
