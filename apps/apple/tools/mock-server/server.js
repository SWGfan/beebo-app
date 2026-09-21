'use strict'
// A tiny stand-in for the Beebo home server, for the simulator smoke test in CI and for local
// poking. It speaks only the routes the Apple client uses, with the response shapes the real
// server (desktop/apps/desktop/electron) produces. No dependencies.
//
//   node tools/mock-server/server.js [port]      login: demo / demo
//
// Video: put ffmpeg-made MPEG-TS pieces in ./media (seg-0.ts ... seg-4.ts, 4 s each, see
// make-media.sh). Without them the HLS playlist still answers and the pieces 404.

const http = require('http')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const PORT = Number(process.argv[2] || process.env.PORT || 47811)
const TOKEN = 'demo.99999999999999.mocksig'
const DURATION = 20
const SEGMENT = 4
const MEDIA = path.join(__dirname, 'media')

const MOVIE_NAMES = ['Alien Nights', 'Blue Harbor', 'Copper Sky', 'Distant Signal', 'Echo Valley', 'Frozen Orbit',
  'Golden Hour', 'Hidden Lake', 'Iron Garden', 'Jade Road', 'Kite Season', 'Last Lantern']
const movies = Array.from({ length: 150 }, (_, i) => {
  const n = String(i + 1).padStart(3, '0')
  const base = MOVIE_NAMES[i % MOVIE_NAMES.length]
  return {
    id: 'movie-' + n, title: `${base} ${n}`, year: 1980 + (i % 44),
    overview: 'A quiet story told at length, with enough plot to fill a synopsis on the detail page. '.repeat(3).trim(),
    tmdbId: 1000 + i, voteAverage: 6 + (i % 30) / 10, quality: ['1080p', '720p', '2160p'][i % 3],
    genres: [{ id: 18, name: 'Drama' }, { id: 878, name: 'Science Fiction' }], collection: null, isNew: i % 17 === 0,
    poster: `/media/poster/${i + 1}.png`, backdrop: `/media/backdrop/${i + 1}.png`,
  }
})
const SHOW_NAMES = ['Severance Days', 'Northern Lights', 'The Long Shift', 'Paper Towns', 'Harbor Lights', 'Deep Field', 'Small Hours', 'Open Range']
const shows = Array.from({ length: 60 }, (_, i) => {
  const n = String(i + 1).padStart(2, '0')
  return {
    id: 'show-' + n, title: `${SHOW_NAMES[i % SHOW_NAMES.length]} ${n}`, year: 2000 + (i % 24),
    tmdbId: 5000 + i, voteAverage: 7 + (i % 20) / 10, quality: '1080p', genres: [{ id: 18, name: 'Drama' }],
    episodeCount: 10, isNew: i % 9 === 0, poster: `/media/poster-tv/${i + 1}.png`, backdrop: `/media/backdrop/${i + 200}.png`,
  }
})

const progressLog = []
const nowMs = () => Date.now()

function crcTable() {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
}
const CRC = crcTable()
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, tail])
}
function png(width, height, seed) {
  const hue = (seed * 47) % 360
  const rows = []
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3)
    for (let x = 0; x < width; x++) {
      const t = y / height
      const stripe = ((x + y) >> 4) % 2 ? 12 : 0
      const [r, g, b] = hsv((hue + t * 40) % 360, 0.6, 0.85 - t * 0.5)
      row[1 + x * 3] = Math.min(255, r + stripe)
      row[2 + x * 3] = Math.min(255, g + stripe)
      row[3 + x * 3] = Math.min(255, b + stripe)
    }
    rows.push(row)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0)),
  ])
}
function hsv(h, s, v) {
  const c = v * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = v - c
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)]
}

function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' })
  res.end(text)
}
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch (_e) { resolve({}) }
    })
  })
}
function page(list, url) {
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100))
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0)
  return { ok: true, apiVersion: 1, total: list.length, limit, offset, items: list.slice(offset, offset + limit) }
}
function filterByQuery(list, url) {
  const q = (url.searchParams.get('q') || '').toLowerCase()
  return q ? list.filter((x) => x.title.toLowerCase().includes(q)) : list
}
function episodesFor(key) {
  const show = shows.find((s) => s.id === key)
  if (!show) return null
  const seasons = [1, 2].map((season) => ({
    season, missingChecked: false, missingEpisodes: [],
    episodes: Array.from({ length: 5 }, (_, i) => ({
      id: `${key}-s${season}e${i + 1}`, season, episode: i + 1, title: `${show.title} — S${season}E${i + 1}`,
      episodeName: `Episode name ${season}-${i + 1}`, quality: '1080p',
      watched: season === 1 && i < 2, watchedAt: null, watchedPercent: season === 1 && i < 2 ? 100 : (season === 1 && i === 2 ? 40 : 0),
    })),
  }))
  return { ok: true, show: { key, name: show.title, poster: show.poster, overview: 'A long-running series about ordinary people. '.repeat(3).trim(), tmdbId: show.tmdbId }, missingEpisodesSupported: false, seasons }
}
function playlist() {
  const count = Math.ceil(DURATION / SEGMENT)
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${Math.ceil(SEGMENT + 0.5)}`, '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-INDEPENDENT-SEGMENTS']
  for (let i = 0; i < count; i++) {
    lines.push(`#EXTINF:${(i === count - 1 ? DURATION - SEGMENT * i : SEGMENT).toFixed(6)},`, `seg-${i}.ts`)
  }
  lines.push('#EXT-X-ENDLIST')
  return lines.join('\n') + '\n'
}
const playbackInfo = (kind, id) => ({
  ok: true, kind, id, durationSec: DURATION, bitrateKbps: 6000,
  video: { codec: 'hevc', width: 3840, height: 2160, fps: 24, hdr: false },
  original: { label: 'Original · 4K', height: 2160 }, direct: { android: true, browser: false },
  qualities: [{ id: '1080p', label: '1080p', videoKbps: 8000, height: 1080, upscale: false }, { id: '720p', label: '720p', videoKbps: 4000, height: 720, upscale: false },
    { id: '480p', label: '480p', videoKbps: 1500, height: 480, upscale: false }],
  transcode: { available: true, encoder: 'libx264', encoderLabel: 'processor (x264)', hardware: false, reason: '' },
  audio: [{ ordinal: 0, streamIndex: 1, label: 'English 5.1', language: 'en', codec: 'eac3', channels: 6, isDefault: true },
    { ordinal: 1, streamIndex: 2, label: 'French', language: 'fr', codec: 'aac', channels: 2, isDefault: false }],
  subtitles: [{ key: 'side:0', source: 'sidecar', kind: 'text', label: 'English', language: 'en', forced: false, url: `/subtitles/file?kind=${kind}&id=${encodeURIComponent(id)}&i=0&mt=1.mock` }],
  prefs: { quality: 'auto', audioLanguage: '', subtitleLanguage: '', subtitlesOn: false },
})
const vtt = () => 'WEBVTT\n\n00:00:01.000 --> 00:00:05.000\nMock subtitle one\n\n00:00:06.000 --> 00:00:10.000\n<i>Mock subtitle two</i>\n\n00:00:11.000 --> 00:00:19.000\nMock subtitle three, a little longer so it wraps across the screen on a narrow phone.\n'

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const p = url.pathname.replace(/\/+$/, '') || '/'
  const method = req.method || 'GET'
  const log = (extra = '') => console.log(`${method} ${p}${url.search} ${extra}`)

  const posterMatch = /^\/media\/(poster|poster-tv|backdrop)\/(\d+)\.png$/.exec(p)
  if (posterMatch) {
    const wide = posterMatch[1] === 'backdrop'
    const body = png(wide ? 320 : 200, wide ? 180 : 300, Number(posterMatch[2]))
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=3600' })
    res.end(body)
    return
  }
  if (p === '/api/ping') { log(); return json(res, 200, { ok: true, app: 'beeboentertainment', apiVersion: 1 }) }
  if (p === '/api/login' && method === 'POST') {
    const b = await readBody(req)
    log(`user=${b.username}`)
    if (b.username === 'demo' && b.password === 'demo') return json(res, 200, { ok: true, token: TOKEN, user: { id: 'u1', name: 'Demo', isAdmin: true } })
    return json(res, 401, { ok: false, error: 'bad_credentials' })
  }
  const hls = /^\/hls\/([^/]+)\/(index\.m3u8|seg-(\d+)\.ts)$/.exec(p)
  if (hls) {
    log()
    if (hls[2] === 'index.m3u8') {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-store' })
      return res.end(playlist())
    }
    const file = path.join(MEDIA, `seg-${hls[3]}.ts`)
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end('no media') }
    const data = fs.readFileSync(file)
    res.writeHead(200, { 'content-type': 'video/mp2t', 'content-length': data.length })
    return res.end(data)
  }
  if (p === '/subtitles/file') { log(); res.writeHead(200, { 'content-type': 'text/vtt; charset=utf-8' }); return res.end(vtt()) }

  const auth = String(req.headers.authorization || '')
  if (auth !== `Bearer ${TOKEN}`) { log('401'); return json(res, 401, { ok: false, error: 'unauthorized' }) }
  log()
  if (p === '/api/me') return json(res, 200, { ok: true, user: { id: 'u1', name: 'Demo', isAdmin: true } })
  if (p === '/api/v1/library/movies') return json(res, 200, page(filterByQuery(movies, url), url))
  if (p === '/api/v1/library/tvshows') return json(res, 200, page(filterByQuery(shows, url), url))
  if (p === '/api/v1/library/recently-added') {
    const items = [movies[3], shows[1], movies[10], shows[4], movies[22]].map((x) => ({ id: x.id, kind: x.id.startsWith('show') ? 'tv' : 'movie', title: x.title, addedAt: nowMs(), poster: x.poster }))
    return json(res, 200, page(items, url))
  }
  if (p === '/api/v1/continue') {
    const items = [
      { id: movies[5].id, kind: 'movie', title: movies[5].title, poster: movies[5].poster, positionSeconds: 8, durationSeconds: DURATION, percent: 40, watched: false, upNext: false, updatedAt: nowMs() },
      { id: 'show-02-s1e3', kind: 'tv', title: `${shows[1].title} — S1E3`, poster: shows[1].poster, positionSeconds: 8, durationSeconds: DURATION, percent: 40, watched: false, upNext: false, updatedAt: nowMs() - 1000 },
    ]
    return json(res, 200, page(items, url))
  }
  const eps = /^\/api\/tvshows\/([^/]+)\/episodes$/.exec(p)
  if (eps) {
    const body = episodesFor(decodeURIComponent(eps[1]))
    return body ? json(res, 200, body) : json(res, 404, { ok: false, error: 'not_found' })
  }
  if (p === '/api/upnext') return json(res, 200, { ok: true, next: null, previous: null, missing: null })
  if (p === '/api/playback/info') return json(res, 200, playbackInfo(url.searchParams.get('kind') === 'tv' ? 'tv' : 'movie', url.searchParams.get('id') || ''))
  if (p === '/api/playback/start' && method === 'POST') {
    const b = await readBody(req)
    log(`quality=${b.quality} audio=${b.audio}`)
    return json(res, 200, { ok: true, url: '/hls/MOCKTICKET/index.m3u8', ticket: 'MOCKTICKET', mimeType: 'application/x-mpegURL', quality: b.quality, height: 1080, videoKbps: 8000, encoder: 'libx264', durationSec: DURATION })
  }
  if (p === '/api/playback/stop' && method === 'POST') return json(res, 200, { ok: true })
  if (p === '/api/watch-session' && method === 'POST') return json(res, 200, { ok: true, sessionId: 'mock-session' })
  if (p === '/api/progress' && method === 'POST') {
    const b = await readBody(req)
    progressLog.push(b)
    log(`progress ${b.currentTime}/${b.duration}`)
    return json(res, 200, { ok: true })
  }
  return json(res, 404, { ok: false, error: 'not_found' })
})

server.listen(PORT, '0.0.0.0', () => console.log(`mock beebo server on :${PORT} (demo / demo)`))
