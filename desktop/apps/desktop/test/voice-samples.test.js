const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { ENGLISH_VOICES } = require('../electron/storybookRuntime')
const vs = require('../electron/voiceSamples')
const pkg = require('../package.json')

const APP = path.join(__dirname, '..')
const DIR = path.join(APP, 'resources', 'voice-samples')

test('every storybook voice has a committed sample listed in the manifest', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'))
  const byId = new Map(manifest.voices.map((v) => [v.id, v]))
  assert.equal(byId.size, ENGLISH_VOICES.size)
  for (const id of ENGLISH_VOICES) {
    const entry = byId.get(id)
    assert.ok(entry, `manifest is missing ${id}`)
    assert.equal(entry.file, id + '.mp3')
    assert.equal(entry.name, vs.VOICE_NAMES[id])
    assert.equal(entry.accent, id.startsWith('b') ? 'British' : 'American')
    assert.equal(entry.text, `Hi, I'm ${entry.name}.`)
    const data = fs.readFileSync(path.join(DIR, entry.file))
    assert.ok(data.length > 2000 && data.length < 60000, `${id} sample is ${data.length} bytes`)
    assert.equal(entry.bytes, data.length)
    assert.equal(entry.sha256, crypto.createHash('sha256').update(data).digest('hex'), `${id} sha256`)
    assert.ok(entry.durationSec > 0.4 && entry.durationSec <= 3.5, `${id} lasts ${entry.durationSec}s`)
    // MPEG audio frame sync (no ID3 tag is written).
    assert.equal(data[0], 0xff); assert.equal(data[1] & 0xe0, 0xe0)
    assert.equal(vs.sampleFile(id, DIR), path.join(DIR, id + '.mp3'))
  }
})

test('voice names cover exactly the allowlist and list in picker order', () => {
  assert.deepEqual(new Set(Object.keys(vs.VOICE_NAMES)), ENGLISH_VOICES)
  const list = vs.listVoices(DIR)
  assert.equal(list.length, ENGLISH_VOICES.size)
  assert.deepEqual(list[0], { id: 'af_heart', name: 'Heart', accent: 'American', hasSample: true })
  assert.ok(list.every((v) => v.hasSample))
})

test('the sample route only accepts real voice ids', () => {
  assert.equal(vs.voiceIdFromPath('/api/storybook-voice-sample/af_heart'), 'af_heart')
  assert.equal(vs.voiceIdFromPath('/api/storybook-voice-sample/bm_lewis.mp3'), 'bm_lewis')
  for (const bad of [
    '/api/storybook-voice-sample/', '/api/storybook-voice-sample/zz_nobody',
    '/api/storybook-voice-sample/../manifest', '/api/storybook-voice-sample/..%2Fmanifest.json',
    '/api/storybook-voice-sample/manifest.json', '/api/storybook-voice-sample/af_heart/x',
    '/api/storybook-voice-sample/AF_HEART', '/api/storybook-voice-sample/af_heart%00',
    '/api/storybook-voice-sample/af_heart.wav', '/api/storybook-voice-samplex/af_heart', '', null,
  ]) assert.equal(vs.voiceIdFromPath(bad), null, String(bad))
  assert.equal(vs.sampleFile('../manifest', DIR), null)
  assert.equal(vs.sampleFile('manifest.json', DIR), null)
  assert.equal(vs.sampleFile('af_heart', null), null)
  assert.equal(vs.voiceInfo('nope'), null)
})

test('the server route is behind the sign-in gate and serves via the allowlist', () => {
  const src = fs.readFileSync(path.join(APP, 'electron', 'streamServer.js'), 'utf8')
  const route = src.indexOf("p.startsWith('/api/storybook-voice-sample/')")
  assert.ok(route > 0)
  // Same place as the other storybook routes, i.e. after the bearer-token gate.
  assert.ok(route > src.indexOf("if (p === '/api/storybooks')"))
  const body = src.slice(route, route + 1400)
  assert.match(body, /voiceSamples\.voiceIdFromPath\(p\)/)
  assert.match(body, /voiceSamples\.sampleFile\(voiceId\)/)
  assert.match(body, /'Cache-Control'/)
  assert.match(body, /audio\/mpeg/)
})

test('GET /api/storybook-voice-sample/<id> over a real server: auth, allowlist, caching', async () => {
  const server = require('../electron/streamServer')
  const auth = require('../electron/auth')
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'beebo-vs-test-'))
  let info
  try {
    const data = {}
    const store = { get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] }, onDidChange: () => () => {} }
    const { user } = auth.createUser(store, 'Viewer', 'viewer@example.com')
    const token = server.makeApiToken(store, user.id)
    const port = 47000 + Math.floor(Math.random() * 900) + 50
    info = server.startStreamServer({
      port, store, getMoviesDir: () => root, getTvShowsDir: () => null,
      getAllMoviesDirs: () => [root], getAllTvShowsDirs: () => [], getTmdbCacheDir: () => root, log: () => {},
    })
    const base = 'http://127.0.0.1:' + info.port
    for (let i = 0; i < 50; i++) {
      try { await (await fetch(base + '/api/ping')).arrayBuffer(); break } catch { await new Promise((r) => setTimeout(r, 100)) }
    }
    const get = async (u, headers = {}) => {
      const res = await fetch(base + u, { headers: { Authorization: 'Bearer ' + token, ...headers } })
      return { res, buf: Buffer.from(await res.arrayBuffer()) }
    }
    let r = await fetch(base + '/api/storybook-voice-sample/af_heart')
    assert.equal(r.status, 401, 'signed-in only'); await r.arrayBuffer()

    const ok = await get('/api/storybook-voice-sample/bf_emma')
    assert.equal(ok.res.status, 200)
    assert.equal(ok.res.headers.get('content-type'), 'audio/mpeg')
    assert.match(ok.res.headers.get('cache-control'), /max-age=\d+/)
    assert.ok(ok.buf.equals(fs.readFileSync(path.join(DIR, 'bf_emma.mp3'))))
    const again = await get('/api/storybook-voice-sample/bf_emma', { 'If-None-Match': ok.res.headers.get('etag') })
    assert.equal(again.res.status, 304)

    for (const bad of ['zz_nobody', 'manifest.json', '..%2Fmanifest.json', '..%5Cmanifest.json', 'af_heart%2F..%2F..%2Fpackage.json', 'AF_HEART']) {
      const b = await get('/api/storybook-voice-sample/' + bad)
      assert.equal(b.res.status, 404, bad)
    }
  } finally {
    if (info) await new Promise((r) => info.close(r))
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('samples ship with the app and the desktop UI has accessible play controls', () => {
  const extra = pkg.build.extraResources.find((r) => r.from === 'resources/voice-samples')
  assert.ok(extra, 'voice-samples missing from extraResources')
  assert.equal(extra.to, 'voice-samples')
  const ui = fs.readFileSync(path.join(APP, 'src', 'components', 'StoryVoiceSamples.jsx'), 'utf8')
  assert.match(ui, /aria-label=\{`Play a sample of \$\{v\.name\}`\}/)
  assert.match(ui, /storyVoiceSample\(/)
  assert.match(ui, /stopSample\(\)/)
  assert.match(fs.readFileSync(path.join(APP, 'src', 'components', 'BeeboSchool.jsx'), 'utf8'), /<StoryVoiceSamples \/>/)
  const preload = fs.readFileSync(path.join(APP, 'electron', 'preload.js'), 'utf8')
  assert.match(preload, /storyVoiceSample: \(id\) => ipcRenderer\.invoke\('storybook:voiceSample'/)
  assert.match(fs.readFileSync(path.join(APP, 'electron', 'main.js'), 'utf8'), /ipcMain\.handle\('storybook:voiceSample'/)
})
