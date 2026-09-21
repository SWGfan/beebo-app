// A tiny stand-in for a Beebo home server, for developing/testing the Roku channel without a
// real library: `node tools/mock-server.mjs [port]` then point the channel at http://<your-pc-ip>:47811
// (sign in as user "demo" / password "demo"). No dependencies. NOTE: the real Beebo server also listens on
// 47811, so run this on another port (`node tools/mock-server.mjs 47999`) if a Beebo is running on the same PC.
//
// It implements just the routes the channel calls, with the SAME shapes as
// desktop/apps/desktop/electron/streamServer.js, /api/v1 (publicApi.js) and playbackApi.js.
// It is NOT a Beebo server and has no video: /hls/... is not served, so playback shows the error screen.
import http from 'node:http'

const PORT = Number(process.argv[2] || process.env.PORT || 47811)
const TOKEN = 'mock-token-not-a-secret'
const b64 = (s) => Buffer.from(s).toString('base64url')

const GENRES = ['Action', 'Drama', 'Comedy', 'Sci-Fi']
const movies = Array.from({ length: 130 }, (_, i) => ({
  id: b64('Movie ' + String(i + 1).padStart(3, '0') + ' (' + (1980 + (i % 44)) + ').mp4'),
  title: 'Mock Movie ' + String(i + 1).padStart(3, '0'),
  year: 1980 + (i % 44),
  overview: 'A made-up film number ' + (i + 1) + ' used to try the Roku channel. '.repeat(6),
  voteAverage: 5 + (i % 50) / 10,
  quality: i % 3 ? '1080p' : '720p',
  poster: '/media/poster/' + (i + 1) + '.jpg',
  backdrop: null,
  isNew: i < 5,
  genres: [{ id: 28, name: GENRES[i % 4] }],
  collection: i % 10 === 0 ? { id: 1, name: 'Mock Collection' } : null,
}))
const shows = Array.from({ length: 60 }, (_, i) => ({
  id: 'mock-show-' + String(i + 1).padStart(2, '0'),
  title: 'Mock Show ' + String(i + 1).padStart(2, '0'),
  year: 2000 + (i % 24),
  voteAverage: 6 + (i % 30) / 10,
  quality: '1080p',
  episodeCount: 12,
  isNew: i < 3,
  poster: '/media/poster-tv/' + (i + 1) + '.jpg',
  backdrop: null,
}))
// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

const send = (res, status, obj, headers = {}) => {
  const body = JSON.stringify(obj)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers })
  res.end(body)
}
const page = (list, q) => {
  const limit = Math.min(500, Math.max(1, Number(q.get('limit')) || 100))
  const offset = Math.max(0, Number(q.get('offset')) || 0)
  const term = (q.get('q') || '').toLowerCase()
  const all = term ? list.filter((x) => x.title.toLowerCase().includes(term)) : list
  return { ok: true, apiVersion: 1, total: all.length, limit, offset, items: all.slice(offset, offset + limit) }
}
const readBody = (req) => new Promise((resolve) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => { try { resolve(JSON.parse(raw || '{}')) } catch { resolve({}) } })
})
const progress = new Map() // sessionId -> last report
const pairPolls = new Map() // device_code -> number of polls so far

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const p = url.pathname.replace(/\/+$/, '') || '/'
  const q = url.searchParams
  console.log(req.method, p + (q.toString() ? '?' + q : '').replace(/(mt|token)=[^&]+/g, '$1=[redacted]'))
  if (p.startsWith('/media/poster')) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PNG) }
  if (p === '/api/ping') return send(res, 200, { ok: true, app: 'beeboentertainment', apiVersion: 1 })
  if (p === '/api/login') {
    const b = await readBody(req)
    if (b.username === 'demo' && b.password === 'demo') return send(res, 200, { ok: true, token: TOKEN, user: { id: 'u_demo', name: 'Demo' } })
    return send(res, 401, { ok: false, error: 'bad_credentials' })
  }
  // Device-code sign-in (worker/tvPair.js shapes). The channel talks to https://beebo.tv for this;
  // to try it against the mock, change baseUrl in components/lib/PairingContract.brs to this server.
  if (p === '/tvpair/start') {
    const code = Buffer.from('mock-device-code-' + Date.now() + '-xxxxxxxxxxxxxxxxxxxx').toString('base64url').slice(0, 43)
    pairPolls.set(code, 0)
    return send(res, 200, { device_code: code, user_code: 'ABCD-EFGH', verification_uri: 'https://beebo.tv/tv', verification_uri_complete: 'https://beebo.tv/tv?code=ABCD-EFGH', expires_in: 600, interval: 2 })
  }
  if (p === '/tvpair/poll') {
    const b = await readBody(req)
    const n = (pairPolls.get(b.device_code) ?? -1) + 1
    if (n < 0) return send(res, 200, { status: 'expired', error: 'expired_token' })
    pairPolls.set(b.device_code, n)
    if (n < 3) return send(res, 200, { status: 'pending', interval: 2 })
    return send(res, 200, { status: 'approved', name: 'demo', token: 'mock-viewer-token', iceServers: [], expiresAt: Math.floor(Date.now() / 1000) + 43200 })
  }
  // everything else needs the bearer token
  if ((req.headers.authorization || '') !== 'Bearer ' + TOKEN) return send(res, 401, { ok: false, error: 'unauthorized' })

  if (p === '/api/me') return send(res, 200, { ok: true, user: { id: 'u_demo', name: 'Demo' } })
  if (p === '/api/v1/library/movies') return send(res, 200, page(movies, q))
  if (p === '/api/v1/library/tvshows') return send(res, 200, page(shows, q))
  if (p === '/api/continue') {
    return send(res, 200, { ok: true, items: [
      { id: movies[3].id, kind: 'movie', title: movies[3].title, poster: movies[3].poster, currentTime: 1200, duration: 6000, percent: 20, watched: false },
      { id: b64('Mock Show 01/S01E02.mkv'), kind: 'tv', title: 'Mock Show 01 - S1E2', poster: shows[0].poster, currentTime: 600, duration: 2400, percent: 25, watched: false },
    ] })
  }
  if (p === '/api/recently-added') return send(res, 200, { ok: true, items: [...movies.slice(0, 6).map((m) => ({ id: m.id, kind: 'movie', title: m.title, poster: m.poster })), ...shows.slice(0, 4).map((s) => ({ id: s.id, kind: 'tv', title: s.title, poster: s.poster, showKey: s.id }))] })
  if (/^\/api\/tvshows\/[^/]+\/episodes$/.test(p)) {
    const key = decodeURIComponent(p.split('/')[3])
    const seasons = [1, 2].map((s) => ({ season: s, episodes: Array.from({ length: 6 }, (_, e) => ({
      id: b64(key + '/S0' + s + 'E0' + (e + 1) + '.mkv'), season: s, episode: e + 1, watched: s === 1 && e < 2, watchedPercent: s === 1 && e < 2 ? 100 : (e === 2 && s === 1 ? 25 : 0),
      title: 'S' + s + 'E' + (e + 1) + ' · Mock episode', episodeName: 'Mock episode',
    })) }))
    return send(res, 200, { ok: true, show: { key, name: key, poster: null, overview: 'A pretend show with two seasons.' }, seasons })
  }
  if (p === '/api/playback/info') return send(res, 200, { ok: true, kind: q.get('kind'), id: q.get('id'), durationSec: 6000,
    qualities: [{ id: '1080p', height: 1080, upscale: false }, { id: '720p', height: 720, upscale: false }, { id: '480p', height: 480, upscale: false }],
    audio: [{ ordinal: 0, streamIndex: 1, label: 'English 5.1', language: 'eng' }, { ordinal: 1, streamIndex: 2, label: 'French', language: 'fra' }],
    subtitles: [{ key: 'side:0', source: 'sidecar', kind: 'text', label: 'English', language: 'en', url: '/subtitles/file?kind=movie&id=x&i=0&mt=mock' }] })
  if (p === '/api/playback/start') { const b = await readBody(req); console.log('  start body', JSON.stringify(b)); return send(res, 200, { ok: true, url: '/hls/mockticket0123456789/index.m3u8', ticket: 'mockticket0123456789', mimeType: 'application/x-mpegURL', quality: b.quality, durationSec: 6000 }) }
  if (p === '/api/playback/stop') return send(res, 200, { ok: true })
  if (p === '/api/watch-session') return send(res, 200, { ok: true, sessionId: 'sess-' + Date.now() })
  if (p === '/api/progress') { const b = await readBody(req); progress.set(b.sessionId, b); console.log('  progress', b.sessionId, b.currentTime + '/' + b.duration); return send(res, 200, { ok: true }) }
  if (p === '/api/playlists') return send(res, 200, { ok: true, playlists: [{ id: 'p1', name: 'Movie night', kind: 'manual', smart: false, itemCount: 3 }, { id: 'p2', name: 'Newest', kind: 'smart', smart: true, itemCount: null }] })
  if (p.startsWith('/api/playlists/')) return send(res, 200, { ok: true, playlist: { id: 'p1', name: 'Movie night' }, items: movies.slice(0, 3).map((m) => ({ entryId: 'e' + m.id, type: 'movie', id: m.id, kind: 'movie', title: m.title, poster: m.poster, available: true, percent: 0, resumeSeconds: 0 })) })
  return send(res, 404, { ok: false, error: 'not_found' })
})
server.listen(PORT, '0.0.0.0', () => console.log('Mock Beebo server on http://0.0.0.0:' + PORT + '  (login: demo / demo)'))
