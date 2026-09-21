// Watch together on a real server: sign-in is required, invite links, the JSON API with a bearer token and the
// website's login cookie, a live Server-Sent Events stream between two people, and the player page carrying the panel.
// Run: node --test test/watch-together-http.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const { testPort } = require('./helpers/testPort')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))

async function start() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-wt-'))
  const moviesDir = path.join(root, 'Movies')
  fs.mkdirSync(moviesDir)
  fs.writeFileSync(path.join(moviesDir, 'Clip (2020).mp4'), 'not really a video')
  const server = localRequire('./electron/streamServer')
  const auth = localRequire('./electron/auth')
  const data = {}
  const store = { get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] }, onDidChange: () => () => {} }
  const { user: alice } = auth.createUser(store, 'Alice', 'alice@example.com')
  const { user: bob } = auth.createUser(store, 'Bob', 'bob@example.com')
  const port = testPort()
  const info = server.startStreamServer({
    port, store, getMoviesDir: () => moviesDir, getTvShowsDir: () => null,
    getAllMoviesDirs: () => [moviesDir], getAllTvShowsDirs: () => [], log: () => {}
  })
  const base = 'http://127.0.0.1:' + info.port
  for (let i = 0; i < 50; i++) {
    try { await (await fetch(base + '/api/ping')).arrayBuffer(); break } catch { await new Promise((r) => setTimeout(r, 100)) }
  }
  const bearer = (u) => ({ Authorization: 'Bearer ' + server.makeApiToken(store, u.id) })
  const cookie = (u) => ({ Cookie: 'beebo_session=' + auth.signSession(store, u.id) })
  const api = async (u, sub, body, opts = {}) => {
    const res = await fetch(base + '/api/watch-together' + sub, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...bearer(u), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(opts.headers || {}) },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch {}
    return { status: res.status, json, text }
  }
  return { server, info, base, store, alice, bob, bearer, cookie, api, movieId: server.encodeId('Clip (2020).mp4'), root, close: () => new Promise((r) => info.close(r)) }
}

/** Reads a Server-Sent Events response, collecting events until asked to stop. */
async function openStream(url, headers) {
  const ctl = new AbortController()
  const res = await fetch(url, { headers, signal: ctl.signal })
  const out = { status: res.status, type: res.headers.get('content-type'), events: [], waiters: [], raw: '' }
  if (res.status !== 200) { out.body = await res.text(); return out }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  ;(async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        const chunk = dec.decode(value, { stream: true })
        out.raw += chunk
        buf += chunk
        let i
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i)
          buf = buf.slice(i + 2)
          if (frame.startsWith(':') || frame.startsWith('retry:')) continue
          const ev = { event: 'message', data: [] }
          for (const line of frame.split('\n')) {
            if (line.startsWith('event: ')) ev.event = line.slice(7)
            else if (line.startsWith('data: ')) ev.data.push(line.slice(6))
            else if (line.startsWith('id: ')) ev.id = line.slice(4)
          }
          ev.data = JSON.parse(ev.data.join('\n'))
          out.events.push(ev)
          out.waiters = out.waiters.filter((w) => !w(ev))
        }
      }
    } catch {}
  })()
  out.next = (pred, ms = 4000) => new Promise((resolve, reject) => {
    const hit = out.events.find(pred)
    if (hit) return resolve(hit)
    const t = setTimeout(() => reject(new Error('timed out waiting for an event; saw ' + out.events.map((e) => e.event).join(','))), ms)
    out.waiters.push((ev) => { if (pred(ev)) { clearTimeout(t); resolve(ev); return true } return false })
  })
  out.close = () => ctl.abort()
  return out
}

test('Watch together over HTTP: sign-in, invites, commands, live stream, chat, limits', async (t) => {
  const s = await start()
  const streams = []
  t.after(async () => { streams.forEach((x) => x.close && x.close()); await s.close(); fs.rmSync(s.root, { recursive: true, force: true }) })

  await t.test('nothing works signed out', async () => {
    for (const p of ['/create', '/join', '/command', '/chat']) {
      const r = await fetch(s.base + '/api/watch-together' + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      assert.equal(r.status, 401, p)
      await r.arrayBuffer()
    }
    const web = await fetch(s.base + '/watch-together-api/room?code=' + 'A'.repeat(26), { redirect: 'manual' })
    assert.equal(web.status, 302)
    assert.equal(web.headers.get('location'), '/login')
    await web.arrayBuffer()
    const inv = await fetch(s.base + '/watch-together/join?code=' + 'A'.repeat(26), { redirect: 'manual' })
    assert.equal(inv.status, 302)
    assert.equal(inv.headers.get('location'), '/login', 'an invite link asks you to sign in first')
    await inv.arrayBuffer()
    const es = await fetch(s.base + '/api/watch-together/events?code=' + 'A'.repeat(26))
    assert.equal(es.status, 401)
    await es.arrayBuffer()
  })

  let code
  await t.test('create a room for a real library title; a missing one is refused', async () => {
    const bad = await s.api(s.alice, '/create', { kind: 'movie', id: s.server.encodeId('Nope.mp4') })
    assert.equal(bad.status, 403)
    assert.equal(bad.json.error, 'unavailable')
    const evil = await s.api(s.alice, '/create', { kind: 'movie', id: '<script>alert(1)</script>' })
    assert.equal(evil.status, 400)
    const r = await s.api(s.alice, '/create', { kind: 'movie', id: s.movieId, title: '<img src=x onerror=alert(1)>' })
    assert.equal(r.status, 200, r.text)
    assert.match(r.json.code, /^[0-9A-HJKMNP-TV-Z]{26}$/)
    assert.equal(r.json.room.media.href, '/watch?id=' + encodeURIComponent(s.movieId))
    assert.equal(r.json.room.participants[0].name, 'Alice')
    assert.equal(r.text.includes(String.fromCharCode(0x2028)), false)
    code = r.json.code
  })

  await t.test('only same-site, small JSON bodies are accepted', async () => {
    const wrongType = await s.api(s.bob, '/join', 'code=' + code, { headers: { 'content-type': 'text/plain' } })
    assert.equal(wrongType.status, 415)
    const xsite = await s.api(s.bob, '/join', { code }, { headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } })
    assert.equal(xsite.status, 415)
    const huge = await s.api(s.bob, '/chat', JSON.stringify({ code, text: 'x'.repeat(10000) }))
    assert.equal(huge.status, 413)
    const notJson = await s.api(s.bob, '/join', '{not json')
    assert.equal(notJson.status, 400)
  })

  let alicePid
  let bobPid
  await t.test('the invite link sends a signed-in person to the player; bad links show a safe page', async () => {
    const ok = await fetch(s.base + '/watch-together/join?code=' + code, { headers: s.cookie(s.bob), redirect: 'manual' })
    assert.equal(ok.status, 302)
    assert.equal(ok.headers.get('location'), `/watch?id=${encodeURIComponent(s.movieId)}&wt=${code}`)
    assert.equal(ok.headers.get('referrer-policy'), 'no-referrer')
    await ok.arrayBuffer()
    const evilCode = '"><script>alert(1)</script>'
    const bad = await fetch(s.base + '/watch-together/join?code=' + encodeURIComponent(evilCode), { headers: s.cookie(s.bob), redirect: 'manual' })
    assert.equal(bad.status, 404)
    const html = await bad.text()
    assert.ok(!html.includes('<script>alert') && !html.includes(evilCode), 'nothing the visitor sent comes back')
    const joined = await s.api(s.bob, '/join', { code })
    assert.equal(joined.status, 200)
    bobPid = joined.json.pid
    assert.equal(joined.json.room.participants.length, 2)
    alicePid = joined.json.room.hostPid
    assert.notEqual(alicePid, bobPid)
    // The web player's routes take the login cookie too.
    const viaCookie = await fetch(s.base + '/watch-together-api/room?code=' + code, { headers: s.cookie(s.bob) })
    assert.equal(viaCookie.status, 200)
    const room = await viaCookie.json()
    assert.equal(room.count, 2)
    assert.equal(room.hostName, 'Alice')
  })

  await t.test('a live stream: state on connect, then commands, chat and reactions as they happen', async () => {
    const a = await openStream(s.base + '/api/watch-together/events?code=' + code, s.bearer(s.alice))
    const b = await openStream(s.base + '/watch-together-api/events?code=' + code, s.cookie(s.bob))
    streams.push(a, b)
    assert.equal(a.status, 200)
    assert.match(a.type, /^text\/event-stream/)
    const first = await b.next((e) => e.event === 'state' && e.data.you === bobPid)
    assert.equal(first.data.code, code)
    assert.equal(first.data.timeline.state, 'paused')

    // Bob may not drive; Alice may.
    const denied = await s.api(s.bob, '/command', { code, type: 'seek', pos: 60 })
    assert.equal(denied.status, 403)
    const ok = await s.api(s.alice, '/command', { code, type: 'seek', pos: 60 })
    assert.equal(ok.status, 200)
    const seen = await b.next((e) => e.event === 'state' && e.data.timeline.anchorPos === 60)
    assert.equal(seen.data.timeline.seq, ok.json.timeline.seq)

    // Both report ready, Alice plays: Bob is told to start at a scheduled moment in the future.
    const seq = ok.json.timeline.seq
    await s.api(s.alice, '/ready', { code, ready: true, seq })
    await s.api(s.bob, '/ready', { code, ready: true, seq })
    const played = await s.api(s.alice, '/command', { code, type: 'play' })
    assert.equal(played.status, 200)
    const starting = await b.next((e) => e.event === 'state' && e.data.timeline.state === 'playing')
    assert.ok(starting.data.timeline.anchorAt > starting.data.serverNow - 1, 'the start is scheduled at or after "now"')

    // Chat: the words arrive as data, escaped by JSON, in one event.
    const line = '<img src=x onerror=alert(1)></script>' + String.fromCharCode(0x202e)
    assert.equal((await s.api(s.bob, '/chat', { code, text: line })).status, 200)
    const chat = await a.next((e) => e.event === 'chat')
    assert.equal(chat.data.name, 'Bob')
    assert.ok(chat.data.text.startsWith('<img src=x onerror=alert(1)></script>'), 'markup is kept as plain text, never interpreted')
    assert.ok(!chat.data.text.includes(String.fromCharCode(0x202e)))
    assert.equal((await s.api(s.bob, '/react', { code, emoji: '🎉' })).status, 200)
    assert.equal((await a.next((e) => e.event === 'reaction')).data.emoji, '🎉')
    assert.equal((await s.api(s.bob, '/react', { code, emoji: '<b>' })).status, 400)

    // Bob buffers: everybody is paused and told who they wait for.
    await s.api(s.bob, '/ready', { code, ready: false, seq: played.json.timeline.seq })
    const held = await a.next((e) => e.event === 'state' && e.data.hold && e.data.hold.reason === 'buffering')
    assert.deepEqual(held.data.hold.waitingFor, ['Bob'])
    await s.api(s.bob, '/ready', { code, ready: true, seq: played.json.timeline.seq })
    await a.next((e) => e.event === 'state' && e.data.timeline.state === 'playing' && !e.data.hold && e.data.timeline.seq > held.data.timeline.seq)

    // The clock ping.
    const before = Date.now()
    const ping = await s.api(s.bob, '/ping', { t0: 123.5 })
    assert.equal(ping.status, 200)
    assert.equal(ping.json.t0, 123.5)
    assert.ok(ping.json.t2 >= ping.json.t1)
    assert.ok(Math.abs(ping.json.t1 - before) < 5000, 'server time is on the same scale a viewer can read (ms since epoch)')

    // Poll fallback shows the same room.
    const polled = await s.api(s.bob, `/poll?code=${code}&since=0`)
    assert.equal(polled.status, 200)
    assert.equal(polled.json.room.timeline.seq, held.data.timeline.seq + 1)
    assert.ok(polled.json.chat.some((c) => c.name === 'Bob'))
  })

  await t.test('kick ends that person\'s stream and bars them', async () => {
    const b = await openStream(s.base + '/api/watch-together/events?code=' + code, s.bearer(s.bob))
    streams.push(b)
    await b.next((e) => e.event === 'state')
    assert.equal((await s.api(s.bob, '/kick', { code, target: alicePid })).status, 403)
    assert.equal((await s.api(s.alice, '/kick', { code, target: bobPid })).status, 200)
    await b.next((e) => e.event === 'kicked')
    assert.equal((await s.api(s.bob, '/join', { code })).status, 404)
    const gone = await s.api(s.bob, '/chat', { code, text: 'hello?' })
    assert.equal(gone.status, 404)
  })

  await t.test('the player page carries the panel and stays valid', async () => {
    const page = await fetch(`${s.base}/watch?id=${encodeURIComponent(s.movieId)}`, { headers: s.cookie(s.alice) })
    assert.equal(page.status, 200)
    const html = await page.text()
    assert.ok(html.includes('id="wtBtn"') || html.includes("btn.id = 'wtBtn'"))
    assert.ok(html.includes('/watch-together-api'))
    assert.ok(html.includes('wtReconcile'))
    // Every inline script still parses (a syntax error in ours would silently kill the player's other scripts).
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
    assert.ok(scripts.length >= 2)
    for (const body of scripts) assert.doesNotThrow(() => new Function(body))
  })

  await t.test('wrong codes lock a person out', async () => {
    let last
    for (let i = 0; i < 9; i++) last = await s.api(s.bob, '/join', { code: 'B'.repeat(26) })
    assert.equal(last.status, 429)
    assert.equal(last.json.error, 'locked')
    const right = await s.api(s.bob, '/join', { code })
    assert.equal(right.status, 429)
  })

  await t.test('closing the room ends it for everyone', async () => {
    const a = await openStream(s.base + '/api/watch-together/events?code=' + code, s.bearer(s.alice))
    streams.push(a)
    await a.next((e) => e.event === 'state')
    assert.equal((await s.api(s.alice, '/close', { code })).status, 200)
    await a.next((e) => e.event === 'closed')
    assert.equal((await s.api(s.alice, '/poll?code=' + code)).status, 404)
  })

  await t.test('the desktop app can start a room and gets an invite link', async () => {
    const wt = s.info.watchTogether
    const made = await wt.createInvite({ userId: s.alice.id, kind: 'movie', id: s.movieId, title: 'Clip' })
    assert.ok(made.ok, JSON.stringify(made))
    assert.match(made.invitePath, /^\/watch-together\/join\?code=[0-9A-HJKMNP-TV-Z]{26}$/)
    assert.ok(made.inviteUrl.endsWith(made.invitePath))
    assert.match(made.watchPath, /^\/watch\?id=.+&wt=[0-9A-HJKMNP-TV-Z]{26}$/)
  })
})
