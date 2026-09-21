// Phone speakers on the REAL media server (electron/streamServer.js) with the REAL bundled ffmpeg: the owner starts a room over
// the website's login cookie for a synthesized 5.1 film (parental controls checked), a guest with no account joins by the room
// code, and each guest gets ONLY its own channel back as a WAV piece; the player page carries the panel; the details-page button's
// IPC works. Skipped without ffmpeg (set BEEBO_FFMPEG).
// Run: NODE_PATH=<desktop node_modules> node --test test/phone-speakers-server.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const fx = require('./phone-speakers-fixture')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))

const skip = fx.FFMPEG && fx.FFPROBE ? false : 'ffmpeg / ffprobe not found (set BEEBO_FFMPEG)'
if (fx.FFMPEG) process.env.BEEBO_FFMPEG = fx.FFMPEG
if (fx.FFPROBE) process.env.BEEBO_FFPROBE = fx.FFPROBE

async function start() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-spk-srv-'))
  const moviesDir = path.join(root, 'Movies')
  fs.mkdirSync(moviesDir)
  const tones = fx.makeTone51(path.join(root, 'tones.mka'), 16)
  fx.run(['-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', tones, '-c', 'copy', path.join(moviesDir, 'Clip (2020).mkv')])
  const server = localRequire('./electron/streamServer')
  const auth = localRequire('./electron/auth')
  const parental = localRequire('./electron/parentalControls')
  const data = {}
  const store = { get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] }, onDidChange: () => () => {} }
  const { user: created } = auth.createUser(store, 'Nick', 'sam@example.com')
  auth.setUserAdmin(store, created.id, true) // the owner is the administrator
  const owner = auth.getUsers(store).find((u) => u.id === created.id)
  const { user: kid } = auth.createUser(store, 'Kid', 'kid@example.com')
  const port = 47000 + Math.floor(Math.random() * 900) + 50
  const info = server.startStreamServer({
    port, store, getMoviesDir: () => moviesDir, getTvShowsDir: () => null,
    getAllMoviesDirs: () => [moviesDir], getAllTvShowsDirs: () => [], log: () => {}
  })
  const base = 'http://127.0.0.1:' + info.port
  for (let i = 0; i < 50; i++) { try { await (await fetch(base + '/api/ping')).arrayBuffer(); break } catch { await new Promise((r) => setTimeout(r, 100)) } }
  const cookie = (u) => ({ Cookie: 'beebo_session=' + auth.signSession(store, u.id) })
  return { server, info, base, store, owner, kid, auth, parental, cookie, root, movieId: server.encodeId('Clip (2020).mkv'), close: () => new Promise((r) => info.close(r)) }
}
const json = async (r) => { const t = await r.text(); try { return { status: r.status, json: JSON.parse(t), text: t } } catch { return { status: r.status, json: null, text: t } } }
const REF = fx.db(0.125 * 0.125)

test('end to end: start a room as the owner, join as a guest with no account, get your own channel as sound', { skip }, async () => {
  const s = await start()
  try {
    // the guest page is public: no cookie, no sign-in
    const page = await fetch(s.base + '/speakers/join?k=' + 'A'.repeat(26), { redirect: 'manual' })
    assert.equal(page.status, 200); assert.match(page.headers.get('content-type'), /text\/html/)
    assert.equal((await fetch(s.base + '/speakers/client.js', { redirect: 'manual' })).status, 200)
    // but starting a room is not: no cookie -> the login page
    const anon = await fetch(s.base + '/phone-speakers-api/create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'movie', id: s.movieId }), redirect: 'manual' })
    assert.notEqual(anon.status, 200)
    // the owner starts one
    const made = await json(await fetch(s.base + '/phone-speakers-api/create', { method: 'POST', headers: { 'content-type': 'application/json', ...s.cookie(s.owner) }, body: JSON.stringify({ kind: 'movie', id: s.movieId, title: 'Clip' }) }))
    assert.equal(made.status, 200, made.text); assert.equal(made.json.ok, true)
    assert.equal(made.json.room.room.mode, 'surround'); assert.equal(made.json.room.room.source, '5.1')
    assert.match(made.json.joinUrl, /^http:\/\/[0-9.]+:\d+\/speakers\/join\?k=[0-9A-Z]{26}$/)
    assert.match(made.json.qrSvg, /^<svg[^>]*>/)
    // five guests join in order and each is a different seat
    const guests = []
    for (const name of ['Ann', 'Bo', 'Cy', 'Di', 'Ed', 'Flo']) {
      const j = await json(await fetch(s.base + '/speakers/api/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ k: made.json.code, name }) }))
      assert.equal(j.status, 200, j.text)
      guests.push({ name, token: j.json.token, seat: j.json.snapshot.you.seat })
    }
    assert.deepEqual(guests.map((g) => g.seat), ['FL', 'FR', 'FC', 'SL', 'SR', 'LFE'])
    // each guest downloads ITS channel: the real bundled ffmpeg cuts the pieces on demand
    const fetchPiece = async (g, feed, n) => {
      const r = await fetch(s.base + `/speakers/audio/${feed}/${n}.wav`, { headers: { 'X-Speaker-Token': g.token, 'X-Speaker-Seq': '1' } })
      assert.equal(r.status, 200, `${g.name} ${feed}-${n}: ${r.status}`)
      const f = path.join(s.root, `${g.name}-${feed}-${n}.wav`); fs.writeFileSync(f, Buffer.from(await r.arrayBuffer())); return fx.readWav(f)
    }
    for (const g of guests) {
      const w = await fetchPiece(g, g.seat, 0)
      assert.equal(w.channels, 1); assert.equal(w.samples.length, (g.seat === 'LFE' ? 8000 : 32000) * 5)
      const own = fx.db(fx.tonePower(w.samples, w.rate, fx.TONES[g.seat === 'FC' ? 'FC' : g.seat], 2000)) - REF
      assert.ok(Math.abs(own) < 1, `${g.name} (${g.seat}) own tone ${own} dB`)
      for (const other of ['FL', 'FR', 'FC', 'SL', 'SR']) { if (other !== g.seat && g.seat !== 'LFE') assert.ok(fx.db(fx.tonePower(w.samples, w.rate, fx.TONES[other], 2000)) - REF < -60, `${g.name} leaks ${other}`) }
    }
    // a later piece and the last (short) piece; the request after the end is a 404
    assert.equal((await fetchPiece(guests[0], 'FL', 2)).samples.length, 32000 * 5)
    assert.ok((await fetchPiece(guests[0], 'FL', 3)).samples.length > 32000 * 0.9)
    const past = await fetch(s.base + '/speakers/audio/FL/9.wav', { headers: { 'X-Speaker-Token': guests[0].token } })
    assert.equal(past.status, 404)
    // a token of THIS room only
    assert.equal((await fetch(s.base + '/speakers/audio/FL/0.wav', { headers: { 'X-Speaker-Token': 'a'.repeat(12) + '.' + 'b'.repeat(32) } })).status, 401)
    assert.equal((await fetch(s.base + '/speakers/audio/FL/0.wav')).status, 401)
    // the owner asks again for the same film: the same room (the player page reloaded)
    const again = await json(await fetch(s.base + '/phone-speakers-api/create', { method: 'POST', headers: { 'content-type': 'application/json', ...s.cookie(s.owner) }, body: JSON.stringify({ kind: 'movie', id: s.movieId }) }))
    assert.equal(again.json.resumed, true); assert.equal(again.json.code, made.json.code)
    // settings switch the whole thing off
    assert.equal(s.info.phoneSpeakers.setSettings({ enabled: false }).enabled, false)
    assert.equal((await fetch(s.base + '/speakers/join')).status, 404)
    assert.equal((await fetch(s.base + '/speakers/audio/FL/0.wav', { headers: { 'X-Speaker-Token': guests[0].token } })).status, 404, 'no pieces while it is off')
    s.info.phoneSpeakers.setSettings({ enabled: true })
    assert.equal((await fetch(s.base + '/speakers/join')).status, 200)
  } finally { await s.close() }
})

test('parental controls: a person under limits cannot start a room for a film they may not watch, and a missing film is refused', { skip }, async () => {
  const s = await start()
  try {
    s.parental.setPolicy(s.store, s.kid.id, s.parental.presetPolicy('kids'))
    const post = (u, body) => fetch(s.base + '/phone-speakers-api/create', { method: 'POST', headers: { 'content-type': 'application/json', ...s.cookie(u) }, body: JSON.stringify(body) }).then(json)
    const r = await post(s.kid, { kind: 'movie', id: s.movieId })
    assert.equal(r.status, 403, r.text); assert.equal(r.json.error, 'unavailable')
    const missing = await post(s.owner, { kind: 'movie', id: s.server.encodeId('Nothing (1999).mkv') })
    assert.equal(missing.status, 403); assert.equal(missing.json.error, 'unavailable')
    assert.equal((await post(s.owner, { kind: 'movie', id: s.movieId })).status, 200, 'the owner is not limited')
  } finally { await s.close() }
})

test('the player page carries the Phone speakers panel, made without any string-to-markup code', { skip }, async () => {
  const s = await start()
  try {
    const r = await fetch(s.base + '/watch?id=' + encodeURIComponent(s.movieId), { headers: s.cookie(s.owner) })
    const html = await r.text()
    assert.equal(r.status, 200)
    assert.match(html, /<script src="\/speakers\/client\.js"><\/script>/); assert.match(html, /id="spkPanel"|spkPanel/); assert.match(html, /\/phone-speakers-api/)
    const from = html.indexOf('function phoneSpeakersPanel')
    assert.ok(from > 0, 'the panel script is in the page')
    const panel = html.slice(from, html.indexOf('</script>', from))
    assert.ok(panel.length > 5000, 'the whole panel: ' + panel.length)
    for (const banned of ['innerHTML', 'insertAdjacentHTML', 'document.write', 'outerHTML', 'eval(']) assert.ok(!panel.includes(banned), banned + ' must not appear in the panel')
    // the watch together panel is still there beside it
    assert.match(html, /wtPanel/)
  } finally { await s.close() }
})

test('the details-page button: IPC starts a room for the owner, copies the link and opens the player; settings round-trip', { skip }, async () => {
  const s = await start()
  try {
    const ipc = localRequire('./electron/phoneSpeakersIpc')
    const handlers = {}
    const clip = { text: '' }
    const windows = []
    class FakeWin {
      constructor(o) { this.opts = o; this.webContents = { session: { cookies: { set: async (c) => { this.cookie = c } } } }; windows.push(this) }
      async loadURL(u) { this.url = u }
    }
    ipc.register({
      ipcMain: { handle: (n, fn) => { handlers[n] = fn } }, BrowserWindow: FakeWin, clipboard: { writeText: (t) => { clip.text = t } },
      store: s.store, auth: s.auth, getStreamPort: () => s.info.port, log: () => {}
    })
    assert.deepEqual(Object.keys(handlers).sort(), ['phoneSpeakers:getSettings', 'phoneSpeakers:setSettings', 'phoneSpeakers:start'])
    const bad = await handlers['phoneSpeakers:start']({}, { kind: 'movie' })
    assert.equal(bad.ok, false)
    const r = await handlers['phoneSpeakers:start']({}, { kind: 'movie', fileName: 'Clip (2020).mkv', title: 'Clip' })
    assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(clip.text, r.joinUrl)
    assert.equal(windows.length, 1); assert.match(windows[0].url, /^http:\/\/127\.0\.0\.1:\d+\/watch\?id=.*&spk=[0-9A-Z]{26}$/)
    assert.equal(windows[0].cookie.name, 'beebo_session'); assert.ok(windows[0].cookie.httpOnly)
    const nope = await handlers['phoneSpeakers:start']({}, { kind: 'movie', fileName: 'Not There.mkv' })
    assert.equal(nope.ok, false)
    const g = await handlers['phoneSpeakers:getSettings']()
    assert.equal(g.ok, true); assert.equal(g.enabled, true); assert.equal(g.allowRemote, false); assert.equal(g.quality, 'standard'); assert.equal(g.fillIn, 'tv'); assert.equal(g.rooms, 1)
    const set = await handlers['phoneSpeakers:setSettings']({}, { quality: 'high', fillIn: 'neighbour', allowRemote: true, enabled: 'nonsense', junk: 1 })
    assert.equal(set.quality, 'high'); assert.equal(set.fillIn, 'neighbour'); assert.equal(set.allowRemote, true); assert.equal(set.enabled, true, 'a non-boolean is ignored')
    const bogus = await handlers['phoneSpeakers:setSettings']({}, { quality: 'ultra', fillIn: 'always' })
    assert.equal(bogus.quality, 'high'); assert.equal(bogus.fillIn, 'neighbour')
  } finally { await s.close() }
})
