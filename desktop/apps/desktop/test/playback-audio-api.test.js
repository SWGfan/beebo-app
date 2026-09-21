// The audio options on a real server: /playback/start takes audioMode & friends, garbage falls back
// to the old stereo behaviour, the ticket separates the sessions, and a converted piece really carries
// the requested sound. Needs ffmpeg/ffprobe; skips without them.
// Run: node --test test/playback-audio-api.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { createRequire } = require('node:module')
const { testPort } = require('./helpers/testPort')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))

function findTool(name) {
  try {
    const convert = localRequire('./electron/convert')
    const fromApp = name === 'ffmpeg' ? convert.ffmpegPath() : convert.ffprobePath()
    if (fromApp) return fromApp
  } catch {}
  const r = spawnSync(name, ['-version'], { windowsHide: true })
  return r.status === 0 ? name : null
}
const FFMPEG = findTool('ffmpeg')
const FFPROBE = findTool('ffprobe')
const SKIP = FFMPEG && FFPROBE ? false : 'ffmpeg/ffprobe not found'

async function startServer({ moviesDir, tmpRoot }) {
  const server = localRequire('./electron/streamServer')
  const auth = localRequire('./electron/auth')
  const data = {}
  const store = { get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] }, onDidChange: () => () => {} }
  const { user } = auth.createUser(store, 'Viewer', 'viewer@example.com')
  const port = testPort()
  const info = server.startStreamServer({
    port, store, getMoviesDir: () => moviesDir, getTvShowsDir: () => null,
    getAllMoviesDirs: () => [moviesDir], getAllTvShowsDirs: () => [], log: () => {},
    playback: { tmpRoot, ffmpegPath: () => FFMPEG, ffprobePath: () => FFPROBE }
  })
  const base = 'http://127.0.0.1:' + info.port
  for (let i = 0; i < 50; i++) {
    try { await (await fetch(base + '/api/ping')).arrayBuffer(); break } catch { await new Promise((r) => setTimeout(r, 100)) }
  }
  const call = async (u, opts = {}) => {
    const res = await fetch(base + u, { ...opts, headers: { Authorization: 'Bearer ' + server.makeApiToken(store, user.id), 'content-type': 'application/json', ...(opts.headers || {}) } })
    const text = await res.text()
    let body = null
    try { body = JSON.parse(text) } catch {}
    return { status: res.status, body, text }
  }
  return { server, info, base, call }
}

const ticketOf = (url) => JSON.parse(Buffer.from(/^\/hls\/([^./]+)\./.exec(url)[1], 'base64url').toString('utf8'))

test('audio options end to end: defaults unchanged, garbage safe, surround and copy real', { skip: SKIP, timeout: 240000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-pb-audio-'))
  const moviesDir = path.join(root, 'Movies')
  fs.mkdirSync(moviesDir)
  const clip = path.join(moviesDir, 'Surround Film (2020).mkv')
  const gen = spawnSync(FFMPEG, ['-hide_banner', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=10',
    '-f', 'lavfi', '-i', 'aevalsrc=0.4*sin(2*PI*220*t)|0.4*sin(2*PI*330*t)|0.4*sin(2*PI*440*t)|0.4*sin(2*PI*55*t)|0.4*sin(2*PI*550*t)|0.4*sin(2*PI*660*t):c=5.1:s=48000:d=10',
    '-map', '0:v', '-map', '1:a', '-c:v', 'mpeg4', '-q:v', '6', '-c:a', 'ac3', '-b:a', '448k', '-metadata:s:a:0', 'language=eng', clip], { encoding: 'utf8', windowsHide: true })
  assert.equal(gen.status, 0, gen.stderr)
  const s = await startServer({ moviesDir, tmpRoot: path.join(root, 'tmp') })
  try {
    const id = s.server.encodeId('Surround Film (2020).mkv')
    const qid = encodeURIComponent(id)
    const start = (extra) => s.call('/api/playback/start', { method: 'POST', body: JSON.stringify({ kind: 'movie', id, quality: '480p', ...extra }) })
    const firstPiece = async (url) => {
      const dir = url.replace(/index\.m3u8$/, '')
      const seg = await fetch(s.base + dir + 'seg-0.ts')
      assert.equal(seg.status, 200)
      const file = path.join(root, `p-${Math.random().toString(36).slice(2)}.ts`)
      fs.writeFileSync(file, Buffer.from(await seg.arrayBuffer()))
      const j = JSON.parse(spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,channels', '-of', 'json', file], { encoding: 'utf8', windowsHide: true }).stdout)
      return j.streams[0]
    }

    const info = await s.call(`/api/playback/info?kind=movie&id=${qid}`)
    assert.equal(info.status, 200, info.text)
    const track = info.body.audio[0]
    assert.equal(track.channels, 6)
    assert.equal(track.codec, 'ac3')
    assert.equal(track.playsAs.label, 'Surround 5.1 · Dolby Digital')
    assert.match(track.channelLayout, /^5\.1/)
    assert.equal(info.body.audioOptions.surroundAvailable, true)
    assert.deepEqual(info.body.audioOptions.modes, ['auto', 'stereo', 'surround', 'passthrough'])
    assert.equal(info.body.audioOptions.delayLimitMs, 500)
    assert.equal(info.body.audioOptions.encoders.aac, true)

    // 1. Old client (no audio fields): ticket has no `au`, sound is stereo AAC.
    const old = await start({})
    assert.equal(old.status, 200, old.text)
    assert.equal('au' in ticketOf(old.body.url), false, 'the ticket is byte-for-byte what old builds made')
    assert.equal(old.body.audioPlan.label, 'Stereo (mixed down from 5.1) · AAC')
    assert.equal(old.body.audioPlan.mixedDown, true)
    const oldPiece = await firstPiece(old.body.url)
    assert.equal(oldPiece.codec_name, 'aac')
    assert.equal(Number(oldPiece.channels), 2)

    // 2. Garbage values are ignored, same ticket as the old client.
    const junk = await start({ audioMode: 'DROP TABLE', downmix: 7, night: 'perhaps', normalize: {}, audioDelayMs: 'later', audioCaps: 'lots' })
    assert.equal(junk.status, 200, junk.text)
    assert.equal('au' in ticketOf(junk.body.url), false)
    assert.match(junk.body.url, /^\/hls\/[A-Za-z0-9_.-]+\/index\.m3u8$/)
    assert.equal(ticketOf(junk.body.url).q, '480p')

    // 3. Explicit surround (AAC 5.1), then with a client that says it can play E-AC-3.
    const sur = await start({ audioMode: 'surround' })
    assert.deepEqual(ticketOf(sur.body.url).au, { s: 1 })
    assert.equal(sur.body.audioPlan.label, 'Surround 5.1 · AAC')
    assert.equal(sur.body.audioPlan.surround, true)
    const surPiece = await firstPiece(sur.body.url)
    assert.equal(surPiece.codec_name, 'aac')
    assert.equal(Number(surPiece.channels), 6)
    assert.notEqual(sur.body.ticket, old.body.ticket)

    const eac3 = await start({ audioMode: 'auto', audioCaps: { maxChannels: 6, codecs: ['aac', 'eac3'] } })
    assert.deepEqual(ticketOf(eac3.body.url).au, { s: 1, c: 'eac3', k: 'aac,eac3', x: 6 })
    assert.equal(eac3.body.audioPlan.label, 'Surround 5.1 · Dolby Digital Plus')
    assert.equal(eac3.body.audioPlan.detail, 'converted from Dolby Digital')
    assert.equal((await firstPiece(eac3.body.url)).codec_name, 'eac3')

    // 4. Passthrough: the original Dolby Digital track is carried as it is.
    const pass = await start({ audioMode: 'passthrough' })
    assert.equal(pass.body.audioPlan.kind, 'copy')
    assert.equal(pass.body.audioPlan.label, 'Surround 5.1 · Dolby Digital')
    const passPiece = await firstPiece(pass.body.url)
    assert.equal(passPiece.codec_name, 'ac3')
    assert.equal(Number(passPiece.channels), 6)

    // 5. Stereo + night + dialogue boost: still one AAC stereo track, different session.
    const night = await start({ audioMode: 'stereo', night: true, downmix: 'dialogue', audioDelayMs: -100 })
    assert.deepEqual(ticketOf(night.body.url).au, { m: 'dialogue', n: 1, d: -100 })
    assert.match(night.body.audioPlan.detail, /dialogue boosted, night mode, -100 ms delay/)
    const nightPiece = await firstPiece(night.body.url)
    assert.equal(nightPiece.codec_name, 'aac')
    assert.equal(Number(nightPiece.channels), 2)

    // 6. Remembered choices per user.
    let p = await s.call('/api/playback/prefs', { method: 'POST', body: JSON.stringify({ audioMode: 'surround', night: true, boostDb: 4.2, audioDelayMs: -130, downmix: 'dialogue', normalize: true }) })
    assert.deepEqual({ ...p.body.prefs }, { quality: 'auto', audioLanguage: '', subtitleLanguage: '', subtitlesOn: false, subtitleStyle: { size: 100, color: '#FFFFFF', bg: '#000000', bgOpacity: 0, edge: 'shadow', position: 8, font: 'default' }, audioMode: 'surround', downmix: 'dialogue', night: true, normalize: true, boostDb: 4, audioDelayMs: -130 })
    p = await s.call('/api/playback/prefs', { method: 'POST', body: JSON.stringify({ audioMode: 'nonsense', boostDb: 99, audioDelayMs: 'x', night: 'yes' }) })
    assert.equal(p.body.prefs.audioMode, 'surround', 'a bad value never replaces a good one')
    assert.equal(p.body.prefs.boostDb, 6)
    assert.equal(p.body.prefs.audioDelayMs, -130)
    assert.equal(p.body.prefs.night, true)
    assert.equal((await s.call('/api/playback/prefs')).body.prefs.audioMode, 'surround')
  } finally {
    await new Promise((r) => s.info.close(r))
    await new Promise((r) => setTimeout(r, 300))
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 })
  }
})
