// /api/podcasts/* and /api/radio/* on a real stream server: sign-in rules, admin-only settings, the
// local-network guard, subscribe / episodes / progress per person, Range streaming through the
// proxy and from a downloaded file, media tokens, OPML over HTTP, and a relayed radio stream.
// Feeds, episodes and stations are a fixture server on 127.0.0.1; no live network.
// Run: node --test test/podcast-radio-http.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))

const AUDIO = Buffer.from(Array.from({ length: 4000 }, (_, i) => i % 251))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 5000) {
  const end = Date.now() + ms
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await sleep(20) }
}

function fixtureServer() {
  const server = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`
    if (req.url === '/feed.xml') {
      const item = (n) => `<item><title>Episode ${n}</title><guid>e${n}</guid><pubDate>${new Date(Date.UTC(2024, 0, n)).toUTCString()}</pubDate><enclosure url="${base}/ep${n}.mp3" length="${AUDIO.length}" type="audio/mpeg"/><description>&lt;p&gt;Notes &lt;script&gt;alert(1)&lt;/script&gt;${n}&lt;/p&gt;</description></item>`
      res.writeHead(200, { 'Content-Type': 'application/rss+xml', ETag: '"f1"' })
      res.end(`<rss version="2.0"><channel><title>Fixture Cast</title>${item(1)}${item(2)}</channel></rss>`)
      return
    }
    const m = /^\/ep(\d)\.mp3$/.exec(req.url)
    if (m) {
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '')
      if (range) {
        const start = Number(range[1])
        const end = range[2] ? Math.min(Number(range[2]), AUDIO.length - 1) : AUDIO.length - 1
        res.writeHead(206, { 'Content-Type': 'audio/mpeg', 'Content-Range': `bytes ${start}-${end}/${AUDIO.length}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' })
        res.end(AUDIO.subarray(start, end + 1))
      } else { res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': AUDIO.length, 'Accept-Ranges': 'bytes' }); res.end(AUDIO) }
      return
    }
    if (req.url === '/station') {
      // ICY station: 200-byte audio blocks, metadata every block, forever
      const interval = 200
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'icy-name': 'Fixture FM', 'icy-metaint': String(interval), 'Cache-Control': 'no-cache' })
      let n = 0
      const t = setInterval(() => {
        res.write(Buffer.alloc(interval, (n % 250) + 1))
        const text = Buffer.from(`StreamTitle='Band - Song ${n}';`)
        const padded = Buffer.alloc(Math.ceil(text.length / 16) * 16)
        text.copy(padded)
        res.write(Buffer.concat([Buffer.from([padded.length / 16]), padded]))
        n++
      }, 5)
      res.on('close', () => clearInterval(t))
      return
    }
    res.writeHead(404); res.end()
  })
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((x) => { server.closeAllConnections(); server.close(x) }) })))
}

test('podcasts and radio over HTTP: sign-in, admin settings, LAN guard, per-person state, Range streaming, tokens, OPML, relayed radio', async () => {
  const serverMod = localRequire('./electron/streamServer')
  const auth = localRequire('./electron/auth')
  const fx = await fixtureServer()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-audio-http-'))
  const data = {}
  const store = { get: (k) => data[k], set: (k, v) => { data[k] = JSON.parse(JSON.stringify(v)) }, delete: (k) => { delete data[k] }, onDidChange: () => () => {} }
  const owner = auth.createOwner(store, { username: 'nick', password: 'nick-owner-test-passphrase' })
  const ownerId = (owner.user || auth.getUsers(store).find((u) => u.isAdmin)).id
  const kid = auth.createUser(store, 'Kid', 'kid@example.com').user
  const tokOwner = serverMod.makeApiToken(store, ownerId)
  const tokKid = serverMod.makeApiToken(store, kid.id)
  const fakeDirectory = {
    async search() { return [{ id: 'rb:960e57c5-0601-11e8-ae97-52543be04c81', name: 'Dir FM', url: fx.base + '/station', homepage: '', favicon: '', tags: [], country: '', countryCode: '', language: '', codec: '', bitrate: 0, source: 'radio-browser' }] },
    async list() { return [{ name: 'Canada', code: 'CA', count: 5 }] },
    async byUuid() { return null },
    async click() {}
  }
  const port = 47000 + Math.floor(Math.random() * 900) + 50
  const info = serverMod.startStreamServer({
    port, store, getMoviesDir: () => null, getTvShowsDir: () => null, getAllMoviesDirs: () => [], getAllTvShowsDirs: () => [], getTmdbCacheDir: () => null, log: () => {},
    podcasts: { dir: path.join(dir, 'podcasts'), autoStart: false },
    radio: { dir: path.join(dir, 'radio'), browser: fakeDirectory, timing: { graceMs: 400 } }
  })
  const base = 'http://127.0.0.1:' + info.port
  try {
    for (let i = 0; i < 50; i++) { try { await (await fetch(base + '/api/ping')).arrayBuffer(); break } catch { await sleep(100) } }
    const call = async (method, u, { token = tokOwner, body, headers, raw } = {}) => {
      const res = await fetch(base + u, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body && !raw ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? (raw ? body : JSON.stringify(body)) : undefined })
      const buf = Buffer.from(await res.arrayBuffer())
      let json = null
      try { json = JSON.parse(buf.toString('utf8')) } catch {}
      return { status: res.status, headers: res.headers, buf, json }
    }

    // ---- sign-in and admin rules ----
    for (const u of ['/api/podcasts/subscriptions', '/api/podcasts/status', '/api/radio/status', '/api/radio/favorites']) assert.equal((await call('GET', u, { token: null })).status, 401, u)
    assert.equal((await call('POST', '/api/podcasts/settings', { token: tokKid, body: { allowPrivateNetwork: true } })).status, 403, 'settings are the owner\'s')
    assert.equal((await call('POST', '/api/radio/settings', { token: tokKid, body: { recordingEnabled: true } })).status, 403)
    assert.equal((await call('POST', '/api/podcasts/cleanup', { token: tokKid })).status, 403)
    assert.equal((await call('POST', '/api/podcasts/refresh', { token: tokKid, body: { all: true } })).status, 403)
    assert.equal((await call('GET', '/api/podcasts/settings', { token: tokKid })).json.settings.allowPrivateNetwork, false)
    assert.equal((await call('GET', '/api/radio/settings', { token: tokKid })).json.settings.recordingEnabled, false, 'recording is off by default')

    // ---- the local network is off limits until the owner allows it ----
    let r = await call('POST', '/api/podcasts/subscriptions', { body: { url: fx.base + '/feed.xml' } })
    assert.equal(r.status, 400)
    assert.equal(r.json.error, 'blocked_private')
    r = await call('POST', '/api/radio/play', { body: { url: fx.base + '/station' } })
    assert.equal(r.json.error, 'blocked_private')
    assert.equal((await call('POST', '/api/podcasts/settings', { body: { allowPrivateNetwork: true } })).json.settings.allowPrivateNetwork, true)
    assert.equal((await call('POST', '/api/radio/settings', { body: { allowPrivateNetwork: true } })).json.settings.allowPrivateNetwork, true)
    assert.equal((await call('POST', '/api/podcasts/subscriptions', { body: { url: 'javascript:alert(1)' } })).json.error, 'bad_url')
    assert.equal((await call('POST', '/api/podcasts/subscriptions', { body: 'not json', raw: true })).status, 400)

    // ---- subscribe, list, episodes ----
    r = await call('POST', '/api/podcasts/subscriptions', { body: { url: fx.base + '/feed.xml' } })
    assert.equal(r.status, 201, JSON.stringify(r.json))
    const show = r.json.show
    assert.equal(show.title, 'Fixture Cast')
    assert.equal(show.unplayed, 2)
    assert.deepEqual((await call('GET', '/api/podcasts/subscriptions')).json.shows.map((s) => s.id), [show.id])
    assert.deepEqual((await call('GET', '/api/podcasts/subscriptions', { token: tokKid })).json.shows, [], 'the kid follows nothing')
    assert.equal((await call('GET', `/api/podcasts/show/${show.id}`, { token: tokKid })).json.error, 'not_subscribed')
    assert.equal((await call('GET', '/api/podcasts/show/../../etc')).status, 404)
    r = await call('GET', `/api/podcasts/show/${show.id}?tokens=1`)
    const [e2, e1] = r.json.episodes
    assert.equal(e2.title, 'Episode 2')
    assert.match(e2.stream, /\/stream\?mt=/)
    const detail = (await call('GET', `/api/podcasts/episode/${e2.key}`)).json.episode
    assert.doesNotMatch(detail.notesHtml, /<script/i, 'notes are sanitized before they leave the server')

    // ---- listening state is per person ----
    assert.equal((await call('POST', `/api/podcasts/episode/${e2.key}/progress`, { token: tokKid, body: { position: 10, duration: 100 } })).status, 403)
    assert.equal((await call('POST', `/api/podcasts/episode/${e2.key}/progress`, { body: { position: 1000, duration: 3600 } })).json.progressSec, 1000)
    assert.equal((await call('GET', '/api/podcasts/continue')).json.episodes[0].key, e2.key)
    assert.equal((await call('POST', `/api/podcasts/episode/${e1.key}/played`, { body: { played: true } })).json.played, true)
    assert.equal((await call('GET', `/api/podcasts/show/${show.id}?unplayed=1`)).json.total, 1)
    assert.equal((await call('POST', '/api/podcasts/queue', { body: { episode: e2.key } })).json.episodes.length, 1)
    assert.equal((await call('POST', '/api/podcasts/queue', { body: { episode: 'nope' } })).status, 400)
    assert.equal((await call('POST', '/api/podcasts/prefs', { body: { speed: 9, skipSilence: true } })).json.prefs.speed, 3)
    assert.equal((await call('GET', '/api/podcasts/prefs', { token: tokKid })).json.prefs.speed, 1)
    await call('POST', `/api/podcasts/subscriptions`, { token: tokKid, body: { url: fx.base + '/feed.xml' } })
    assert.equal((await call('GET', `/api/podcasts/show/${show.id}`, { token: tokKid })).json.feed.unplayed, 2, 'kid has their own played marks')

    // ---- streaming: Range through the proxy, media token, and no credentials = refused ----
    const streamPath = `/api/podcasts/episode/${e2.key}/stream`
    assert.equal((await call('GET', streamPath, { token: null })).status, 401)
    assert.equal((await call('GET', streamPath + '?mt=wrong', { token: null })).status, 401)
    r = await call('GET', streamPath, { headers: { Range: 'bytes=100-199' } })
    assert.equal(r.status, 206)
    assert.equal(r.headers.get('content-range'), `bytes 100-199/${AUDIO.length}`)
    assert.equal(r.headers.get('x-beebo-podcast-source'), 'remote')
    assert.ok(r.buf.equals(AUDIO.subarray(100, 200)))
    const viaToken = await call('GET', e2.stream, { token: null, headers: { Range: 'bytes=0-9' } })
    assert.equal(viaToken.status, 206, 'a media token stands in for the sign-in')
    assert.equal((await call('GET', streamPath.replace(e2.key.split('.')[1], 'f'.repeat(16)), { token: null })).status, 401)

    // ---- download, then the same URL serves the local file ----
    r = await call('POST', `/api/podcasts/episode/${e2.key}/download`)
    assert.equal(r.status, 202)
    await until(async () => (await call('GET', `/api/podcasts/episode/${e2.key}/download`)).json.download.downloaded)
    r = await call('GET', streamPath, { headers: { Range: 'bytes=-100' } })
    assert.equal(r.status, 206)
    assert.equal(r.headers.get('x-beebo-podcast-source'), 'downloaded')
    assert.ok(r.buf.equals(AUDIO.subarray(AUDIO.length - 100)))
    assert.equal((await call('GET', streamPath + '&variant=nosilence'.replace('&', '?'))).json.error, 'not_ready')
    assert.equal((await call('DELETE', `/api/podcasts/episode/${e2.key}/download`)).json.ok, true)
    assert.equal((await call('GET', streamPath, { headers: { Range: 'bytes=0-4' } })).headers.get('x-beebo-podcast-source'), 'remote')

    // ---- OPML out and in ----
    r = await call('GET', '/api/podcasts/opml')
    assert.match(r.headers.get('content-type'), /opml/)
    assert.match(r.buf.toString(), new RegExp(fx.base.replace(/[.]/g, '\\.') + '/feed\\.xml'))
    assert.equal((await call('GET', '/api/podcasts/opml?format=json')).json.ok, true)
    const opml = `<?xml version="1.0"?><opml version="2.0"><body><outline text="Imported" xmlUrl="${fx.base}/feed2.xml"/></body></opml>`
    r = await call('POST', '/api/podcasts/opml', { body: opml, raw: true, headers: { 'Content-Type': 'text/x-opml' } })
    assert.equal(r.json.added, 1)
    assert.equal((await call('POST', '/api/podcasts/opml', { body: '<!DOCTYPE x [<!ENTITY a "b">]><opml><body/></opml>', raw: true, headers: { 'Content-Type': 'text/xml' } })).json.error, 'not_opml')
    assert.equal((await call('POST', '/api/podcasts/opml', { token: null, body: opml, raw: true })).status, 401)
    assert.equal((await call('DELETE', `/api/podcasts/subscriptions/${show.id}`)).json.ok, true)

    // ---- radio: browse, play, relayed stream with the metadata removed, private to the owner ----
    assert.equal((await call('GET', '/api/radio/browse?name=dir')).json.stations[0].name, 'Dir FM')
    assert.equal((await call('GET', '/api/radio/lists/countries')).json.items[0].code, 'CA')
    r = await call('POST', '/api/radio/play?tokens=1', { body: { url: fx.base + '/station', name: 'Fixture FM' } })
    assert.equal(r.status, 201, JSON.stringify(r.json))
    const session = r.json.session
    assert.equal(session.state, 'live')
    assert.match(session.stream, /\/api\/radio\/session\/[a-f0-9]{16}\/stream\?mt=/)
    assert.equal((await call('GET', `/api/radio/session/${session.id}`, { token: tokKid })).status, 404, "someone else's stream is a 404")
    assert.equal((await call('GET', `/api/radio/session/${session.id}/stream`, { token: tokKid })).status, 404)
    assert.equal((await call('GET', `/api/radio/session/${session.id}/stream`, { token: null })).status, 401)
    // read a chunk of the live stream by media token, then drop it
    const ctl = new AbortController()
    const res = await fetch(base + session.stream, { signal: ctl.signal })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'audio/mpeg')
    const chunks = []
    let got = 0
    for await (const c of res.body) { chunks.push(Buffer.from(c)); got += c.length; if (got > 200 * 12) break }
    ctl.abort()
    const bytes = Buffer.concat(chunks)
    const runs = []
    for (const b of bytes) { if (runs.length && runs[runs.length - 1].v === b) runs[runs.length - 1].n++; else runs.push({ v: b, n: 1 }) }
    for (let i = 1; i < runs.length - 1; i++) assert.equal(runs[i].n, 200, 'whole audio blocks: no ICY metadata bytes in what the player receives')
    await until(async () => /Song \d+/.test((((await call('GET', `/api/radio/session/${session.id}`)).json.session.nowPlaying) || {}).title || ''))
    assert.equal((await call('POST', `/api/radio/session/${session.id}/record`)).json.error, 'recording_disabled')
    assert.equal((await call('POST', '/api/radio/custom', { body: { name: 'Mine', url: fx.base + '/station' } })).status, 201)
    assert.equal((await call('GET', '/api/radio/custom', { token: tokKid })).json.custom.length, 0)
    assert.equal((await call('DELETE', `/api/radio/session/${session.id}`)).json.ok, true)
    assert.equal((await call('GET', `/api/radio/session/${session.id}`)).status, 404)
    assert.equal((await call('GET', '/api/radio/nonsense')).status, 404)
    assert.equal((await call('GET', '/api/podcasts/nonsense')).status, 404)
  } finally {
    await new Promise((r) => info.close(r))
    await fx.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
