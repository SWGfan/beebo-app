// The Quality & audio routes on a real server: auth on playlists, pieces and embedded subtitles,
// and (when ffmpeg is on this machine) a real live conversion of a tiny generated clip to HLS.
// Run: node --test test/playback-api.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { createRequire } = require('node:module')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))

function findTool(name) {
  const convert = localRequire('./electron/convert')
  const fromApp = name === 'ffmpeg' ? convert.ffmpegPath() : convert.ffprobePath()
  if (fromApp) return fromApp
  const r = spawnSync(name, ['-version'], { windowsHide: true })
  return r.status === 0 ? name : null
}
const FFMPEG = findTool('ffmpeg')
const FFPROBE = findTool('ffprobe')

async function startServer({ moviesDir, tmpRoot, extra = {} }) {
  const server = localRequire('./electron/streamServer')
  const auth = localRequire('./electron/auth')
  const data = {}
  const store = { get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] }, onDidChange: () => () => {} }
  const { user } = auth.createUser(store, 'Viewer', 'viewer@example.com')
  const { user: other } = auth.createUser(store, 'Other', 'other@example.com')
  const port = 47000 + Math.floor(Math.random() * 900) + 50
  const info = server.startStreamServer({
    port, store, getMoviesDir: () => moviesDir, getTvShowsDir: () => null,
    getAllMoviesDirs: () => [moviesDir], getAllTvShowsDirs: () => [], log: () => {},
    playback: { tmpRoot, ffmpegPath: () => FFMPEG, ffprobePath: () => FFPROBE, ...extra }
  })
  const base = 'http://127.0.0.1:' + info.port
  for (let i = 0; i < 50; i++) {
    try { await (await fetch(base + '/api/ping')).arrayBuffer(); break } catch { await new Promise((r) => setTimeout(r, 100)) }
  }
  const tokenFor = (u) => server.makeApiToken(store, u.id)
  const call = async (u, opts = {}, who = user) => {
    const res = await fetch(base + u, { ...opts, headers: { Authorization: 'Bearer ' + tokenFor(who), 'content-type': 'application/json', ...(opts.headers || {}) } })
    const text = await res.text()
    let body = null
    try { body = JSON.parse(text) } catch {}
    return { status: res.status, body, text, headers: res.headers }
  }
  return { server, info, base, store, data, user, other, call }
}

test('auth: playlists, pieces and embedded subtitles need a valid ticket or media token', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-pb-auth-'))
  const moviesDir = path.join(root, 'Movies')
  fs.mkdirSync(moviesDir)
  fs.writeFileSync(path.join(moviesDir, 'Clip (2020).mkv'), 'not really a video')
  const s = await startServer({ moviesDir, tmpRoot: path.join(root, 'tmp') })
  try {
    const id = s.server.encodeId('Clip (2020).mkv')
    let r = await fetch(s.base + '/hls/hls.min.js')
    assert.equal(r.status, 200, 'hls.js is served from this PC, not a CDN')
    assert.match(r.headers.get('content-type'), /javascript/)
    assert.ok((await r.arrayBuffer()).byteLength > 100000)
    assert.doesNotMatch(fs.readFileSync(path.join(appRoot, 'electron', 'playbackWebUi.js'), 'utf8'), /https?:\/\/cdn|jsdelivr/)
    r = await fetch(s.base + '/hls/notaticketatall/index.m3u8')
    assert.equal(r.status, 403)
    await r.arrayBuffer()
    // A ticket signed with a different secret.
    const fake = Buffer.from(JSON.stringify({ v: 1, k: 'movie', i: id, q: '720p', u: s.user.id })).toString('base64url') + '.9999999999999.AAAA'
    r = await fetch(s.base + `/hls/${fake}/seg-0.ts`)
    assert.equal(r.status, 403)
    await r.arrayBuffer()
    r = await fetch(s.base + `/subtitles/embedded?kind=movie&id=${encodeURIComponent(id)}&s=2`)
    assert.equal(r.status, 403)
    await r.arrayBuffer()
    // A media token for ANOTHER file does not open this one.
    const otherMt = s.server.makeMediaToken(s.store, s.server.encodeId('Other.mkv'))
    r = await fetch(s.base + `/subtitles/embedded?kind=movie&id=${encodeURIComponent(id)}&s=2&mt=${otherMt}`)
    assert.equal(r.status, 403)
    await r.arrayBuffer()
    r = await fetch(s.base + `/api/playback/info?kind=movie&id=${encodeURIComponent(id)}`)
    assert.equal(r.status, 401)
    await r.arrayBuffer()
    r = await fetch(s.base + `/playback-api/playback/info?kind=movie&id=${encodeURIComponent(id)}`, { redirect: 'manual' })
    assert.equal(r.status, 302, 'the web viewer route needs the login cookie')
    await r.arrayBuffer()
    // Tickets are kept out of logs.
    assert.equal(s.server.redactSecrets('GET /hls/eyJ2IjoxfQ.123.abc_DEF/seg-1.ts'), 'GET /hls/[redacted]/seg-1.ts')

    // Preferences are per signed-in user, and per profile when one is named.
    let p = await s.call('/api/playback/prefs', { method: 'POST', body: JSON.stringify({ quality: '720p', audioLanguage: 'fre', subtitleLanguage: 'en', subtitlesOn: true }) })
    assert.deepEqual(p.body.prefs, { quality: '720p', audioLanguage: 'fre', subtitleLanguage: 'en', subtitlesOn: true, subtitleStyle: { size: 100, color: '#FFFFFF', bg: '#000000', bgOpacity: 0, edge: 'shadow', position: 8, font: 'default' }, audioMode: 'auto', downmix: 'standard', night: false, normalize: false, boostDb: 0, audioDelayMs: 0 })
    p = await s.call('/api/playback/prefs', { method: 'POST', body: JSON.stringify({ quality: 'nonsense', profile: 'kid1', audioLanguage: 'spa' }) })
    assert.equal(p.body.prefs.quality, '720p', 'a new profile starts from the account prefs')
    assert.equal(p.body.prefs.audioLanguage, 'spa')
    assert.equal((await s.call('/api/playback/prefs')).body.prefs.audioLanguage, 'fre')
    assert.equal((await s.call('/api/playback/prefs?profile=kid1')).body.prefs.audioLanguage, 'spa')
    assert.equal((await s.call('/api/playback/prefs', {}, s.other)).body.prefs.quality, 'auto')

    const sp = await fetch(s.base + '/api/playback/speedtest?kb=64', { headers: { Authorization: 'Bearer ' + s.server.makeApiToken(s.store, s.user.id) } })
    assert.equal((await sp.arrayBuffer()).byteLength, 64 * 1024)
  } finally {
    await new Promise((r) => s.info.close(r))
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('real ffmpeg: tracks, embedded subtitles, HLS playlist, pieces, seek, busy cap, stop', { skip: !(FFMPEG && FFPROBE) ? 'ffmpeg/ffprobe not found' : false, timeout: 180000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-pb-real-'))
  const moviesDir = path.join(root, 'Movies')
  fs.mkdirSync(moviesDir)
  const srt = path.join(root, 's.srt')
  fs.writeFileSync(srt, '1\n00:00:01,000 --> 00:00:03,000\nHello there\n\n2\n00:00:14,000 --> 00:00:16,000\nSecond line\n')
  const clip = path.join(moviesDir, 'Clip (2020).mkv')
  const enc = spawnSync(FFMPEG, ['-hide_banner', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25:d=24', '-f', 'lavfi', '-i', 'sine=f=440:d=24', '-f', 'lavfi', '-i', 'sine=f=880:d=24', '-i', srt,
    '-map', '0', '-map', '1', '-map', '2', '-map', '3', '-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'aac', '-c:s', 'srt',
    '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=spa', '-metadata:s:s:0', 'language=eng', clip], { encoding: 'utf8', windowsHide: true })
  assert.equal(enc.status, 0, enc.stderr)
  fs.writeFileSync(path.join(moviesDir, 'Clip (2020).fr.srt'), '1\n00:00:01,000 --> 00:00:02,000\nBonjour\n')

  const s = await startServer({ moviesDir, tmpRoot: path.join(root, 'tmp'), extra: { keepAliveMs: 40 } })
  try {
    const id = s.server.encodeId('Clip (2020).mkv')
    const qid = encodeURIComponent(id)
    const info = await s.call(`/api/playback/info?kind=movie&id=${qid}`)
    assert.equal(info.status, 200, info.text)
    const b = info.body
    assert.ok(Math.abs(b.durationSec - 24) < 0.5)
    assert.equal(b.video.width, 640)
    assert.deepEqual(b.audio.map((a) => [a.streamIndex, a.language]), [[1, 'eng'], [2, 'spa']])
    assert.equal(b.direct.android, false, 'MPEG-4 Part 2 needs converting for the phone')
    assert.equal(b.transcode.available, true, JSON.stringify(b.transcode))
    assert.ok(b.transcode.encoder)
    assert.deepEqual(b.subtitles.map((x) => [x.key, x.source, x.kind, x.language]), [['side:0', 'sidecar', 'text', 'fr'], ['emb:3', 'embedded', 'text', 'eng']])
    assert.equal(b.onlineSearch.configured, false)

    // Embedded text track -> WebVTT with the media token from the info answer.
    const vtt = await fetch(s.base + b.subtitles[1].url)
    assert.equal(vtt.status, 200)
    assert.equal(vtt.headers.get('access-control-allow-origin'), '*', 'Chromecast fetches with CORS')
    const vttText = await vtt.text()
    assert.match(vttText, /^WEBVTT/)
    assert.match(vttText, /Hello there/)
    const side = await fetch(s.base + b.subtitles[0].url)
    assert.match(await side.text(), /Bonjour/)

    // Online search is offline-safe with no key.
    const online = await s.call(`/api/subtitles/online?kind=movie&id=${qid}`)
    assert.equal(online.body.ok, false)
    assert.equal(online.body.error, 'not_configured')

    // Only picture subtitles can be burnt in.
    const badBurn = await s.call('/api/playback/start', { method: 'POST', body: JSON.stringify({ kind: 'movie', id, quality: '480p', burnSubtitle: 3 }) })
    assert.equal(badBurn.status, 400)

    const start = await s.call('/api/playback/start', { method: 'POST', body: JSON.stringify({ kind: 'movie', id, quality: '480p', audio: 2 }) })
    assert.equal(start.status, 200, start.text)
    assert.match(start.body.url, /^\/hls\/[A-Za-z0-9_.-]+\/index\.m3u8$/)
    assert.equal(start.body.height, 360, 'never enlarged')

    // No login needed for the playlist or pieces - the ticket is the credential (Cast, tunnel).
    const pl = await fetch(s.base + start.body.url)
    assert.equal(pl.status, 200)
    assert.match(pl.headers.get('content-type'), /mpegurl/)
    const plText = await pl.text()
    const pieces = plText.split('\n').filter((l) => l.startsWith('seg-'))
    assert.equal(pieces.length, 6)

    const dir = start.body.url.replace(/index\.m3u8$/, '')
    const t0 = Date.now()
    const seg0 = await fetch(s.base + dir + 'seg-0.ts')
    assert.equal(seg0.status, 200)
    assert.equal(seg0.headers.get('content-type'), 'video/mp2t')
    const seg0Buf = Buffer.from(await seg0.arrayBuffer())
    assert.ok(seg0Buf.length > 1000)
    assert.equal(seg0Buf[0], 0x47, 'MPEG-TS sync byte')
    const out = path.join(root, 'seg.ts')
    fs.writeFileSync(out, seg0Buf)
    const probe0 = JSON.parse(spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,height,start_time', '-of', 'json', out], { encoding: 'utf8', windowsHide: true }).stdout)
    assert.deepEqual(probe0.streams.map((x) => x.codec_type).sort(), ['audio', 'video'], 'one video + the one chosen audio')
    assert.equal(probe0.streams.find((x) => x.codec_type === 'video').codec_name, 'h264')

    // Seek: piece 4 (16 s) straight away - restarts the conversion there, with real timestamps.
    const seg4 = await fetch(s.base + dir + 'seg-4.ts')
    assert.equal(seg4.status, 200)
    fs.writeFileSync(out, Buffer.from(await seg4.arrayBuffer()))
    const probe4 = JSON.parse(spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_type,start_time', '-of', 'json', out], { encoding: 'utf8', windowsHide: true }).stdout)
    const vStart = Number(probe4.streams.find((x) => x.codec_type === 'video').start_time)
    assert.ok(vStart >= 15.9 && vStart < 18, `piece 4 starts near 16 s (was ${vStart})`)
    assert.ok(Date.now() - t0 < 120000)

    // Past the end.
    const seg9 = await fetch(s.base + dir + 'seg-9.ts')
    assert.equal(seg9.status, 404)
    await seg9.arrayBuffer()

    // Cap of 1: someone else is told the computer is busy; the first viewer can still switch.
    s.data.transcodeMaxConcurrent = 1
    const busy = await s.call('/api/playback/start', { method: 'POST', body: JSON.stringify({ kind: 'movie', id, quality: '720p' }) }, s.other)
    assert.equal(busy.status, 503)
    assert.equal(busy.body.error, 'busy')
    // A friendly "server busy" with a place in an ETA-less line (no time promised), to ask again.
    assert.equal(busy.body.queued, true)
    assert.equal(busy.body.position, 1)
    assert.equal(busy.body.retryAfterSec, 5)
    assert.match(busy.body.message, /server is busy right now.*next in line/)
    assert.equal('eta' in busy.body || 'etaSec' in busy.body, false)
    const again = await s.call('/api/playback/start', { method: 'POST', body: JSON.stringify({ kind: 'movie', id, quality: '720p' }) })
    assert.equal(again.status, 200)

    // Stop frees the slot.
    const stop = await s.call('/api/playback/stop', { method: 'POST', body: JSON.stringify({ ticket: start.body.ticket }) })
    assert.equal(stop.body.ok, true)
    const nowFree = await s.call('/api/playback/start', { method: 'POST', body: JSON.stringify({ kind: 'movie', id, quality: '720p' }) }, s.other)
    assert.equal(nowFree.status, 200)

    const status = await s.call('/api/playback/status')
    assert.equal(status.body.maxConcurrent, 1)
  } finally {
    await new Promise((r) => s.info.close(r))
    await new Promise((r) => setTimeout(r, 300))
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 })
  }
})

test('web viewer sheet: valid script, id safely embedded, uses the cookie routes', () => {
  const w = localRequire('./electron/playbackWebUi')
  const html = w.playbackPanelHtml({ kind: 'tv', mediaId: 'a</script><b>' })
  const scripts = html.split('<script>')
  assert.equal(scripts.length, 2, 'one script block, not broken open by the id')
  const js = scripts[1].split('</script>')[0]
  assert.doesNotThrow(() => new Function(js))
  assert.match(js, /"kind":"tv"/)
  assert.match(js, /r\.queued.*waitTries.*setTimeout/s, 'a busy server puts the viewer in line and the sheet asks again by itself')
  assert.match(js, /\/playback-api/)
  assert.match(js, /Search online/)
})
