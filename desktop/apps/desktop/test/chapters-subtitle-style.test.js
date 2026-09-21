// Chapters (cleaned, metadata only) and per-user subtitle style prefs, from the pure models up to the
// real /api/playback/info + /api/playback/prefs routes with real ffprobe/ffmpeg when present.
// Run: node --test test/chapters-subtitle-style.test.js
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
const chapterModel = localRequire('./electron/chapterModel')
const style = localRequire('./electron/subtitleStyle')
const tracks = localRequire('./electron/playbackTracks')
const hlsTranscoder = localRequire('./electron/hlsTranscoder')

function findTool(name) {
  const convert = localRequire('./electron/convert')
  const fromApp = name === 'ffmpeg' ? convert.ffmpegPath() : convert.ffprobePath()
  if (fromApp) return fromApp
  const r = spawnSync(name, ['-version'], { windowsHide: true })
  return r.status === 0 ? name : null
}
const FFMPEG = findTool('ffmpeg')
const FFPROBE = findTool('ffprobe')
const SKIP = !(FFMPEG && FFPROBE) ? 'ffmpeg/ffprobe not found' : false

// ---------------------------------------------------------------- chapters
const ch = (start, end, title) => ({ start_time: String(start), end_time: String(end), ...(title === undefined ? {} : { tags: { title } }) })

test('chapters: ordered, numbered, clamped to the film, titles kept', () => {
  const out = chapterModel.fromProbe([ch(600, 1200, 'Middle'), ch(0, 600, 'Opening'), ch(1200, 9999, 'End')], 1800)
  assert.deepEqual(out, [
    { index: 0, startSec: 0, endSec: 600, title: 'Opening' },
    { index: 1, startSec: 600, endSec: 1200, title: 'Middle' },
    { index: 2, startSec: 1200, endSec: 1800, title: 'End' }
  ])
})

test('chapters: fewer than two is not a chapter list; junk input never throws', () => {
  assert.deepEqual(chapterModel.fromProbe([ch(0, 100, 'Only')], 100), [])
  assert.deepEqual(chapterModel.fromProbe(undefined, 100), [])
  assert.deepEqual(chapterModel.fromProbe('nope', 100), [])
  assert.deepEqual(chapterModel.fromProbe([null, 5, 'x', {}, { start_time: 'abc' }], 100), [])
})

test('chapters: chapters starting past the end, negative, or duplicated are dropped; a missing end runs to the next start', () => {
  const out = chapterModel.fromProbe([
    { start_time: '0', tags: { title: 'A' } },
    { start_time: '0.2', end_time: '5', tags: { title: 'dup of A' } },
    { start_time: '-5', end_time: '3', tags: { title: 'negative' } },
    { start_time: '50', end_time: '80', tags: { title: 'B' } },
    { start_time: '500', end_time: '600', tags: { title: 'past the end' } }
  ], 100)
  assert.deepEqual(out.map((c) => [c.title, c.startSec, c.endSec]), [['A', 0, 50], ['B', 50, 80]])
})

test('chapters: titles are untrusted - controls, bidi overrides and huge text are cleaned; markup is left for the client to escape', () => {
  const C = (n) => String.fromCharCode(n)
  assert.equal(chapterModel.cleanTitle('  Act' + C(0) + ' one' + C(13) + C(10) + ' two ' + C(0x202e) + 'evil' + C(0x2066) + ' '), 'Act one two evil')
  assert.equal(chapterModel.cleanTitle(C(0x200b) + C(0x200e) + C(0xfeff)), '')
  assert.equal(chapterModel.cleanTitle(null), '')
  assert.equal(chapterModel.cleanTitle('<img src=x onerror=alert(1)>'), '<img src=x onerror=alert(1)>', 'kept as text; every client escapes on output')
  const huge = chapterModel.cleanTitle('x'.repeat(100000))
  assert.equal(Array.from(huge).length, chapterModel.MAX_TITLE_CHARS)
  assert.ok(huge.endsWith(chapterModel.ELLIPSIS))
  const emoji = chapterModel.cleanTitle('\u{1F600}'.repeat(500))
  assert.equal(Array.from(emoji).length, chapterModel.MAX_TITLE_CHARS, 'counted in characters, not UTF-16 halves')
})

test('chapters: at most MAX_CHAPTERS come back', () => {
  const many = Array.from({ length: 5000 }, (_, i) => ch(i, i + 1, 'c' + i))
  const out = chapterModel.fromProbe(many, 6000)
  assert.equal(out.length, chapterModel.MAX_CHAPTERS)
  assert.equal(out[out.length - 1].index, chapterModel.MAX_CHAPTERS - 1)
})

test('probe: parseTracks carries the cleaned chapters; the probe asks for them', () => {
  assert.ok(tracks.PROBE_ARGS.includes('-show_chapters'))
  const t = tracks.parseTracks({ streams: [], format: { duration: '100' }, chapters: [ch(0, 40, 'One'), ch(40, 100, 'Two')] })
  assert.deepEqual(t.chapters.map((c) => c.title), ['One', 'Two'])
  assert.deepEqual(tracks.parseTracks({ streams: [], format: { duration: '100' } }).chapters, [])
})

test('the conversion still leaves chapters out of the HLS output (metadata only, cache keys unchanged)', () => {
  const args = hlsTranscoder.buildTranscodeArgs({
    input: '/m/x.mkv', quality: '720p', encoder: 'libx264', outDir: '/tmp/out',
    tracks: { video: { streamIndex: 0, width: 1920, height: 1080, fps: 24 }, audio: [] }
  })
  const i = args.indexOf('-map_chapters')
  assert.ok(i > 0)
  assert.equal(args[i + 1], '-1')
})

// ------------------------------------------------------------ subtitle style
test('style: defaults are complete and valid; garbage falls back per field', () => {
  assert.deepEqual(style.read(undefined), style.DEFAULTS)
  assert.deepEqual(style.read('nope'), style.DEFAULTS)
  const r = style.read({ size: 150, color: 'ff0', bg: 'javascript:alert(1)', bgOpacity: 'lots', edge: 'glow', position: 12, font: 'Comic Sans MS' })
  assert.deepEqual(r, { size: 150, color: '#FFFF00', bg: '#000000', bgOpacity: 0, edge: 'shadow', position: 12, font: 'default' })
})

test('style: numbers are clamped, colours normalised, enums checked', () => {
  assert.equal(style.patch(null, { size: 9999 }).size, style.SIZE_MAX)
  assert.equal(style.patch(null, { size: -3 }).size, style.SIZE_MIN)
  assert.equal(style.patch(null, { size: 87.6 }).size, 88)
  assert.equal(style.patch(null, { bgOpacity: 500 }).bgOpacity, 100)
  assert.equal(style.patch(null, { position: 99 }).position, style.POSITION_MAX)
  assert.equal(style.patch(null, { color: '#abc' }).color, '#AABBCC')
  assert.equal(style.patch(null, { color: 'red' }).color, '#FFFFFF', 'a colour name is not accepted')
  assert.equal(style.patch(null, { color: '#12345' }).color, '#FFFFFF')
  for (const edge of style.EDGES) assert.equal(style.patch(null, { edge }).edge, edge)
  for (const font of style.FONTS) assert.equal(style.patch(null, { font }).font, font)
  assert.equal(style.patch(null, { font: '"><script>' }).font, 'default')
})

test('style: a patch changes only what it names; invalid fields are dropped, not repaired; null / reset restores defaults', () => {
  const a = style.patch(style.DEFAULTS, { size: 130, color: '#00ff00' })
  const b = style.patch(a, { edge: 'outline', size: 'big', position: 20 })
  assert.deepEqual(b, { size: 130, color: '#00FF00', bg: '#000000', bgOpacity: 0, edge: 'outline', position: 20, font: 'default' })
  assert.deepEqual(style.patch(b, undefined), b)
  assert.deepEqual(style.patch(b, [1, 2]), b)
  assert.deepEqual(style.patch(b, null), style.DEFAULTS)
  assert.deepEqual(style.patch(b, { reset: true }), style.DEFAULTS)
  assert.ok(Object.isFrozen(style.DEFAULTS))
  style.patch(b, null).size = 1
  assert.equal(style.DEFAULTS.size, 100, 'defaults are copied, never shared')
})

// -------------------------------------------------------------- real server
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
  return { server, info, store, call }
}

test('real ffprobe + server: /playback/info lists cleaned chapters; prefs save and return the subtitle style', { skip: SKIP, timeout: 60000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-chap-'))
  const moviesDir = path.join(root, 'Movies')
  fs.mkdirSync(moviesDir)
  const meta = path.join(root, 'chapters.txt')
  fs.writeFileSync(meta, [
    ';FFMETADATA1',
    '[CHAPTER]', 'TIMEBASE=1/1000', 'START=0', 'END=10000', 'title=Opening <b>bold</b> & "quoted"',
    '[CHAPTER]', 'TIMEBASE=1/1000', 'START=10000', 'END=25000', 'title=Middle',
    '[CHAPTER]', 'TIMEBASE=1/1000', 'START=25000', 'END=40000', ''
  ].join('\n'))
  const clip = path.join(moviesDir, 'Chaptered (2020).mkv')
  const enc = spawnSync(FFMPEG, ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=10:d=40', '-i', meta, '-map', '0', '-map_metadata', '1', '-map_chapters', '1', '-c:v', 'mpeg4', '-q:v', '5', clip], { encoding: 'utf8', windowsHide: true })
  assert.equal(enc.status, 0, enc.stderr)
  const s = await startServer({ moviesDir, tmpRoot: path.join(root, 'tmp') })
  try {
    const id = encodeURIComponent(s.server.encodeId('Chaptered (2020).mkv'))
    const info = await s.call(`/api/playback/info?kind=movie&id=${id}`)
    assert.equal(info.status, 200, info.text)
    assert.deepEqual(info.body.chapters, [
      { index: 0, startSec: 0, endSec: 10, title: 'Opening <b>bold</b> & "quoted"' },
      { index: 1, startSec: 10, endSec: 25, title: 'Middle' },
      { index: 2, startSec: 25, endSec: 40, title: '' }
    ])
    assert.deepEqual(info.body.prefs.subtitleStyle, style.DEFAULTS)

    let r = await s.call('/api/playback/prefs', { method: 'POST', body: JSON.stringify({ subtitleStyle: { size: 140, color: '#ffea00', bgOpacity: 60, edge: 'outline', font: 'serif', bogus: 1 } }) })
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.body.prefs.subtitleStyle, { size: 140, color: '#FFEA00', bg: '#000000', bgOpacity: 60, edge: 'outline', position: 8, font: 'serif' })
    r = await s.call('/api/playback/prefs', { method: 'POST', body: JSON.stringify({ subtitleStyle: { position: 'high', size: 999 } }) })
    assert.equal(r.body.prefs.subtitleStyle.size, 200)
    assert.equal(r.body.prefs.subtitleStyle.position, 8, 'an invalid field is dropped, the saved one stays')
    assert.equal(r.body.prefs.subtitleStyle.color, '#FFEA00', 'unnamed fields are untouched')
    r = await s.call('/api/playback/prefs')
    assert.equal(r.body.prefs.subtitleStyle.font, 'serif', 'saved per user')
    r = await s.call('/api/playback/prefs', { method: 'POST', body: JSON.stringify({ quality: '720p' }) })
    assert.equal(r.body.prefs.subtitleStyle.font, 'serif', 'saving another pref does not touch the style')
    r = await s.call('/api/playback/prefs', { method: 'POST', body: JSON.stringify({ subtitleStyle: null }) })
    assert.deepEqual(r.body.prefs.subtitleStyle, style.DEFAULTS)
  } finally {
    await new Promise((res) => s.info.close(res))
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }) } catch {}
  }
})
