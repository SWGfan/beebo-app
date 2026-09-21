// Dev-only mock of the Beebo home server + static host for app/, so the TV UI can be driven in a
// desktop browser with arrow keys. NOT a real server: fake movies/shows, SVG "posters", a public
// sample video, no persistence, sign-in is demo / demo.
//
//   node dev/mock-server.mjs                 -> http://localhost:8080  (serves app/ AND the mock API)
//   MOCK_SHOWS=1300 MOCK_MOVIES=240          how many fake titles
//   MOCK_LEGACY=1                            /api/v1/... answers 404 (exercises the legacy fallback)
//   MOCK_CORS=1                              add Access-Control-Allow-* (to test cross-origin like a TV app)
//   MOCK_SLOW=400                            add N ms latency to every API answer
//   MOCK_VIDEO=<url>                         the video the fake /hls/... stream redirects to
//
// In the app choose "Type my server address" -> localhost:8080 -> demo / demo.

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

var here = path.dirname(fileURLToPath(import.meta.url))
var appDir = process.env.APP_DIR ? path.resolve(process.env.APP_DIR) : path.resolve(here, '..', 'app') // APP_DIR=dist/webos serves a staged build
var PORT = Number(process.env.PORT || process.env.MOCK_PORT || 8080)
var N_SHOWS = Number(process.env.MOCK_SHOWS || 1300)
var N_MOVIES = Number(process.env.MOCK_MOVIES || 240)
var LEGACY = process.env.MOCK_LEGACY === '1'
var CORS = process.env.MOCK_CORS === '1'
var SLOW = Number(process.env.MOCK_SLOW || 0)
var VIDEO = process.env.MOCK_VIDEO || 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4'
var TOKEN = 'dev-token-not-a-secret'

// ---- fake catalogue ---------------------------------------------------------------------------------------
var W1 = ['Crimson', 'Silent', 'Golden', 'Lost', 'Iron', 'Hidden', 'Electric', 'Midnight', 'Broken', 'Last', 'Wild', 'Paper', 'Velvet', 'Neon', 'Frozen', 'Hollow']
var W2 = ['Harbor', 'Signal', 'Kingdom', 'Garden', 'Horizon', 'Engine', 'Orchard', 'Cascade', 'Lantern', 'Meridian', 'Voyage', 'Frontier', 'Archive', 'Summit', 'Compass', 'Echo']
function title(i) { return W1[i % W1.length] + ' ' + W2[(i * 7 + 3) % W2.length] + (i >= 256 ? ' ' + Math.floor(i / 256 + 1) : '') }
function hue(i) { return (i * 47) % 360 }
var movies = []
for (var i = 0; i < N_MOVIES; i++) movies.push({ id: 'm' + i, title: title(i), year: 1980 + (i % 45), voteAverage: 5 + (i % 40) / 10, overview: 'A fake movie for layout testing. ' + title(i) + ' follows ordinary people through an extraordinary week. '.repeat(3), quality: i % 3 ? '1080p' : '720p', isNew: i % 17 === 0 })
var shows = []
for (var j = 0; j < N_SHOWS; j++) shows.push({ key: 's' + j, name: title(j + 500) + (j % 5 === 0 ? ' (Series)' : ''), year: 1990 + (j % 35), voteAverage: 6 + (j % 30) / 10, episodeCount: 8 + (j % 30), isNew: j % 23 === 0 })
movies.sort(function (a, b) { return a.title.localeCompare(b.title) })
shows.sort(function (a, b) { return a.name.localeCompare(b.name) })

function movieOut(m) {
  return { id: m.id, title: m.title, year: m.year, poster: '/media/poster/' + m.id + '.jpg', backdrop: null, voteAverage: m.voteAverage, quality: m.quality, genres: [], overview: m.overview, isNew: m.isNew, stream: '/file?id=' + m.id + '&mt=fake' }
}
function showOut(s) {
  return { key: s.key, name: s.name, year: s.year, poster: '/media/poster-tv/' + s.key + '.jpg', backdrop: null, voteAverage: s.voteAverage, episodeCount: s.episodeCount, isNew: s.isNew, quality: '1080p', genres: [] }
}

function episodesFor(key) {
  var idx = Number(key.slice(1)) || 0
  var seasons = []
  var nS = 1 + (idx % 4)
  for (var s = 1; s <= nS; s++) {
    var eps = []
    var nE = 8 + ((idx + s) % 5)
    for (var e = 1; e <= nE; e++) {
      eps.push({ id: 'ep-' + key + '-s' + s + 'e' + e, season: s, episode: e, watched: s === 1 && e < 3, watchedAt: null, watchedPercent: s === 1 && e < 3 ? 100 : 0, title: 'S' + s + 'E' + e + ' · Episode ' + e + ' of the fake season', episodeName: 'Episode ' + e + ' of the fake season', quality: '1080p', stream: '/tvfile?id=x&mt=fake' })
    }
    seasons.push({ season: s, missingChecked: false, missingEpisodes: [], episodes: eps })
  }
  return { ok: true, show: { key: key, name: shows.filter(function (x) { return x.key === key })[0].name, poster: '/media/poster-tv/' + key + '.jpg', overview: 'A fake series used to check the season and episode layout. It has several seasons and a long list of episodes so scrolling can be tested.', tmdbId: null }, missingEpisodesSupported: true, seasons: seasons }
}

function posterSvg(id, label) {
  var n = 0
  for (var k = 0; k < id.length; k++) n = (n * 31 + id.charCodeAt(k)) % 100000
  var h1 = n % 360
  var esc = String(label).replace(/[<>&"]/g, '')
  var words = esc.split(' ')
  var l1 = words.slice(0, 2).join(' ')
  var l2 = words.slice(2).join(' ')
  return '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450" viewBox="0 0 300 450"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(' + h1 + ',55%,32%)"/><stop offset="1" stop-color="hsl(' + ((h1 + 60) % 360) + ',60%,14%)"/></linearGradient></defs><rect width="300" height="450" fill="url(#g)"/><circle cx="150" cy="150" r="70" fill="rgba(255,255,255,0.12)"/><text x="150" y="330" font-family="Arial,sans-serif" font-size="30" font-weight="700" fill="#fff" text-anchor="middle">' + l1 + '</text><text x="150" y="370" font-family="Arial,sans-serif" font-size="26" fill="#fff" text-anchor="middle">' + l2 + '</text></svg>'
}

var VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nThis is a fake subtitle line.\nIt has <i>two</i> lines.\n\n00:00:05.000 --> 00:00:08.000\nSubtitles are drawn by the app,\nnot by the browser.\n\n00:00:09.000 --> 00:00:14.000\n<script>alert("not executed")</script> stays inert text.\n'

// ---- http plumbing -----------------------------------------------------------------------------------------
function readBody(req) {
  return new Promise(function (resolve) {
    var b = ''
    req.on('data', function (c) { b += c; if (b.length > 1e6) req.destroy() })
    req.on('end', function () { try { resolve(JSON.parse(b || '{}')) } catch (e) { resolve({}) } })
  })
}
function send(res, status, obj, extra) {
  var body = JSON.stringify(obj)
  var h = Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, corsHeaders(), extra || {})
  res.writeHead(status, h)
  res.end(body)
}
function corsHeaders() {
  return CORS ? { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' } : {}
}
var MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' }

function paged(list, url, out) {
  var q = (url.searchParams.get('q') || '').toLowerCase()
  var filtered = q ? list.filter(function (x) { return (x.title || x.name).toLowerCase().indexOf(q) >= 0 }) : list
  var limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100))
  var offset = Math.max(0, Number(url.searchParams.get('offset')) || 0)
  return { ok: true, apiVersion: 1, total: filtered.length, limit: limit, offset: offset, items: filtered.slice(offset, offset + limit).map(out) }
}

var pairStartedAt = 0
var progressLog = []

async function api(req, res, url) {
  var p = url.pathname.replace(/\/+$/, '')
  var method = req.method
  if (method === 'OPTIONS') { res.writeHead(204, corsHeaders()); res.end(); return }
  if (SLOW) await new Promise(function (r) { setTimeout(r, SLOW) })

  // unauthenticated
  if (p === '/api/ping') return send(res, 200, { ok: true, app: 'beeboentertainment', apiVersion: 3 })
  if (p === '/api/login' && method === 'POST') {
    var b = await readBody(req)
    if (b.username === 'demo' && b.password === 'demo') return send(res, 200, { ok: true, token: TOKEN, user: { id: 'u1', name: 'Demo <b>User</b>', isAdmin: false } })
    return send(res, 401, { ok: false, error: 'bad_credentials' })
  }
  if (p === '/api/viewer-session' && method === 'POST') return send(res, 404, { ok: false })

  var auth = String(req.headers.authorization || '')
  if (auth !== 'Bearer ' + TOKEN) return send(res, 401, { ok: false, error: 'unauthorized' })

  if (p === '/api/me') return send(res, 200, { ok: true, user: { id: 'u1', name: 'Demo <b>User</b>', isAdmin: false } })
  // Movie Night (the real server draws the TV page; the mock only answers the two calls the tile makes)
  if (p === '/api/movie-night/status') return send(res, 200, { ok: true, enabled: true, available: true, reason: null, message: '' })
  if (p === '/api/movie-night/tv/create' && method === 'POST') return send(res, 200, { ok: true, code: 'K7M2QX', ticket: 'mockmockmockmockmockmockmockmock', tvPath: '/movie-night/tv', hash: 'k=mockmockmockmockmockmockmockmock', poolCount: 12 })
  if (p.indexOf('/api/v1/') === 0) {
    if (LEGACY) return send(res, 404, { ok: false, error: 'not_found' })
    if (p === '/api/v1/library/movies') return send(res, 200, paged(movies, url, movieOut))
    if (p === '/api/v1/library/tvshows') {
      var pg = paged(shows, url, showOut)
      pg.items = pg.items.map(function (s) { return { id: s.key, title: s.name, year: s.year, poster: s.poster, backdrop: null, voteAverage: s.voteAverage, episodeCount: s.episodeCount, isNew: s.isNew, quality: s.quality } })
      return send(res, 200, pg)
    }
    return send(res, 404, { ok: false })
  }
  if (p === '/api/movies') {
    var qm = (url.searchParams.get('q') || '').toLowerCase()
    return send(res, 200, { ok: true, genres: [], items: movies.filter(function (m) { return !qm || m.title.toLowerCase().indexOf(qm) >= 0 }).map(movieOut) })
  }
  if (p === '/api/tvshows') {
    var qs = (url.searchParams.get('q') || '').toLowerCase()
    return send(res, 200, { ok: true, genres: [], items: shows.filter(function (s) { return !qs || s.name.toLowerCase().indexOf(qs) >= 0 }).map(showOut) })
  }
  var ep = /^\/api\/tvshows\/([^/]+)\/episodes$/.exec(p)
  if (ep) {
    var key = decodeURIComponent(ep[1])
    if (!shows.some(function (s) { return s.key === key })) return send(res, 404, { ok: false, error: 'not_found' })
    return send(res, 200, episodesFor(key))
  }
  if (p === '/api/continue') {
    return send(res, 200, {
      ok: true,
      items: [
        { id: movies[3].id, kind: 'movie', title: movies[3].title, poster: '/media/poster/' + movies[3].id + '.jpg', stream: '/file?id=' + movies[3].id + '&mt=fake', currentTime: 2100, duration: 5400, percent: 39, watched: false },
        { id: 'ep-' + shows[1].key + '-s1e3', kind: 'tv', title: shows[1].name + ' — S1E3', poster: '/media/poster-tv/' + shows[1].key + '.jpg', stream: '/tvfile?id=x&mt=fake', currentTime: 600, duration: 2700, percent: 22, watched: false },
        { id: 'ep-' + shows[4].key + '-s1e3', kind: 'tv', title: shows[4].name + ' — S1E3', poster: '/media/poster-tv/' + shows[4].key + '.jpg', stream: '/tvfile?id=x&mt=fake', currentTime: 0, duration: 0, percent: 0, watched: false, upNext: true }
      ]
    })
  }
  if (p === '/api/recently-added') {
    var items = movies.slice(10, 20).map(function (m) { return { id: m.id, kind: 'movie', title: m.title, poster: '/media/poster/' + m.id + '.jpg', stream: '/file?id=' + m.id + '&mt=fake', showKey: null } })
      .concat(shows.slice(5, 12).map(function (s) { return { id: s.key, kind: 'tv', title: s.name, poster: '/media/poster-tv/' + s.key + '.jpg', stream: null, showKey: s.key } }))
    return send(res, 200, { ok: true, items: items })
  }
  if (p === '/api/playback/info') {
    var id = url.searchParams.get('id') || ''
    return send(res, 200, {
      ok: true, kind: url.searchParams.get('kind'), id: id, durationSec: 5400, video: { codec: 'h264', width: 1920, height: 1080 },
      direct: { browser: true }, qualities: [{ id: '1080p', label: '1080p' }, { id: '720p', label: '720p' }, { id: '480p', label: '480p' }],
      transcode: { available: true },
      audio: [{ ordinal: 0, streamIndex: 1, label: 'English 5.1', language: 'eng', channels: 6, isDefault: true }, { ordinal: 1, streamIndex: 2, label: 'Commentary', language: 'eng', channels: 2, isDefault: false }],
      subtitles: [
        { key: 'side:0', source: 'sidecar', kind: 'text', label: 'English', language: 'en', forced: false, url: '/subtitles/file?kind=movie&id=' + encodeURIComponent(id) + '&i=0&mt=fake' },
        { key: 'emb:3', source: 'embedded', kind: 'image', label: 'English (picture)', language: 'en', url: '' }
      ]
    })
  }
  if (p === '/api/playback/start' && method === 'POST') {
    var sb = await readBody(req)
    if (sb.id === 'm999') return send(res, 409, { ok: false, error: 'transcode_off', message: 'Live conversion is switched off on the PC.' })
    return send(res, 200, { ok: true, url: '/hls/MOCKTICKET' + Date.now() + '/index.mp4' /* a desktop browser sniffs .m3u8 as HLS; the mock stream is a plain mp4 */, ticket: 'MOCKTICKET', mimeType: 'application/x-mpegURL', quality: sb.quality, height: 1080, durationSec: 5400 })
  }
  if (p === '/api/playback/stop' && method === 'POST') return send(res, 200, { ok: true })
  if (p === '/api/watch-session' && method === 'POST') return send(res, 200, { ok: true, sessionId: 'mock-session-1' })
  if (p === '/api/progress' && method === 'POST') { var pb = await readBody(req); progressLog.push(pb); console.log('[mock] progress', JSON.stringify(pb)); return send(res, 200, { ok: true }) }
  if (p === '/api/upnext') {
    var uid = url.searchParams.get('id') || ''
    var m = /^ep-(s\d+)-s(\d+)e(\d+)$/.exec(uid)
    if (m) return send(res, 200, { ok: true, next: { kind: 'tv', id: 'ep-' + m[1] + '-s' + m[2] + 'e' + (Number(m[3]) + 1), showKey: m[1], title: shows[1].name + ' — S' + m[2] + 'E' + (Number(m[3]) + 1), poster: null, stream: '/tvfile?id=x&mt=fake' }, previous: null, missing: null })
    return send(res, 200, { ok: true, next: null, previous: null, missing: null })
  }
  return send(res, 404, { ok: false, error: 'not_found' })
}

var pairCalls = 0
async function tvpair(req, res, url) {
  if (req.method === 'OPTIONS') { res.writeHead(204, corsHeaders()); res.end(); return }
  if (url.pathname === '/tvpair/start') {
    pairStartedAt = Date.now(); pairCalls = 0
    return send(res, 200, { device_code: 'D'.repeat(43), user_code: 'ABCD-EFGH', verification_uri: 'https://beebo.tv/tv', verification_uri_complete: 'https://beebo.tv/tv?code=ABCD-EFGH', expires_in: 600, interval: 2 })
  }
  if (url.pathname === '/tvpair/poll') {
    pairCalls++
    if (Date.now() - pairStartedAt > 9000) return send(res, 200, { status: 'approved', name: 'devhouse', token: 'FAKE.VIEWER.TOKEN', iceServers: [], expiresAt: 1 })
    return send(res, 200, { status: 'pending', interval: 2 })
  }
  return send(res, 404, { error: 'not_found' })
}

http.createServer(async function (req, res) {
  try {
    var url = new URL(req.url, 'http://localhost')
    var p = url.pathname
    if (p === '/health') return send(res, 200, { ok: true })
    if (p.indexOf('/tvpair/') === 0) return tvpair(req, res, url)
    if (p.indexOf('/api/') === 0 || p === '/api') return api(req, res, url)
    var pm = /^\/media\/poster(?:-tv)?\/(.+)\.jpg$/.exec(p)
    if (pm) {
      var pid = decodeURIComponent(pm[1])
      var label = (movies.filter(function (m) { return m.id === pid })[0] || {}).title || (shows.filter(function (s) { return s.key === pid })[0] || {}).name || pid
      res.writeHead(200, Object.assign({ 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=600' }, corsHeaders()))
      return res.end(posterSvg(pid, label))
    }
    if (p.indexOf('/hls/') === 0 || p === '/file' || p === '/tvfile') { res.writeHead(302, { Location: VIDEO }); return res.end() }
    if (p === '/movie-night/tv') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end('<!doctype html><meta charset="utf-8"><body style="background:#0b0d12;color:#fff;font:32px system-ui;text-align:center;padding-top:20vh">Movie Night (mock page). Press Back to return.') }
    if (p === '/subtitles/file') { res.writeHead(200, Object.assign({ 'Content-Type': 'text/vtt; charset=utf-8' }, corsHeaders())); return res.end(VTT) }
    // static app
    var rel = p === '/' ? '/index.html' : p
    var file = path.normalize(path.join(appDir, rel))
    if (file.indexOf(appDir) !== 0 || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found') }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' })
    fs.createReadStream(file).pipe(res)
  } catch (e) {
    res.writeHead(500); res.end('mock error')
  }
}).listen(PORT, function () {
  console.log('Beebo TV mock server on http://localhost:' + PORT + '  (movies ' + N_MOVIES + ', shows ' + N_SHOWS + ', legacy=' + LEGACY + ', cors=' + CORS + ')')
  console.log('Sign in with demo / demo. Fake video: ' + VIDEO)
})
