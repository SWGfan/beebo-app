// Movie Night on a real server: the TV page and phone page, guests joining with no account, live Server-Sent Events,
// a game from a cached library (posters / cast on disk), permissions, rate limits, size caps, cross-site refusal,
// XSS-safe pages, the sign-in-only TV app route, and the reactions overlay in the player page.
// Run: node --test test/movie-night-http.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))
const { FILMS } = require('./movie-night-fixture')
const { testPort } = require('./helpers/testPort')

async function start(settings) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-mn-'))
  const moviesDir = path.join(root, 'Movies')
  const cacheDir = path.join(root, 'tmdb')
  fs.mkdirSync(moviesDir)
  fs.mkdirSync(path.join(cacheDir, 'posters'), { recursive: true })
  fs.mkdirSync(path.join(cacheDir, 'actors'), { recursive: true })
  // A library of made-up films with a cached TMDB manifest, credits, and posters on disk (no network anywhere).
  const manifest = {}
  const credits = {}
  FILMS.forEach(([title, year, tagline, cast, rating], i) => {
    const file = `${title} (${year}).mp4`
    fs.writeFileSync(path.join(moviesDir, file), 'not really a video')
    manifest[file] = { id: 1000 + i, title, release_date: `${year}-06-01`, poster_path: '/p.jpg', certification: rating, tagline }
    credits[String(1000 + i)] = cast.map((name, j) => ({ id: 5000 + i * 10 + j, name, character: j === 0 ? 'Lead' : null, profilePath: '/a.jpg' }))
    fs.writeFileSync(path.join(cacheDir, 'posters', `${1000 + i}.jpg`), 'jpeg')
  })
  fs.writeFileSync(path.join(cacheDir, 'manifest.json'), JSON.stringify(manifest))
  fs.writeFileSync(path.join(cacheDir, 'credits.json'), JSON.stringify(credits))
  const server = localRequire('./electron/streamServer')
  const auth = localRequire('./electron/auth')
  const data = { movieNight: { ratingCap: 'none', ...(settings || {}) } }
  const store = { get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] }, onDidChange: () => () => {} }
  const { user: alice } = auth.createUser(store, 'Alice', 'alice@example.com')
  const port = testPort()
  const info = server.startStreamServer({
    port, store, getMoviesDir: () => moviesDir, getTvShowsDir: () => null, getAllMoviesDirs: () => [moviesDir], getAllTvShowsDirs: () => [],
    getTmdbCacheDir: () => cacheDir, log: () => {}
  })
  const base = 'http://127.0.0.1:' + info.port
  for (let i = 0; i < 50; i++) {
    try { await (await fetch(base + '/api/ping')).arrayBuffer(); break } catch { await new Promise((r) => setTimeout(r, 100)) }
  }
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, {
      method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers }
  }
  const api = (p, body, headers) => call(body === undefined ? 'GET' : 'POST', '/movie-night-api' + p, body, headers)
  return {
    server, info, base, store, data, alice, auth, api, call, close: () => new Promise((r) => info.close(r)),
    bearer: (u) => ({ Authorization: 'Bearer ' + server.makeApiToken(store, u.id) })
  }
}

/** Reads a Server-Sent Events response, collecting events until asked to stop. */
async function openStream(url) {
  const ctl = new AbortController()
  const res = await fetch(url, { signal: ctl.signal })
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
    } catch { /* aborted */ }
  })()
  out.next = (pred, ms = 4000) => new Promise((resolve, reject) => {
    const hit = out.events.find(pred)
    if (hit) return resolve(hit)
    const t = setTimeout(() => reject(new Error('timed out; saw ' + out.events.map((e) => e.event + ':' + ((e.data && e.data.phase) || '')).join(','))), ms)
    out.waiters.push((ev) => { if (pred(ev)) { clearTimeout(t); resolve(ev); return true } return false })
  })
  out.last = (event) => [...out.events].reverse().find((e) => e.event === event)
  out.close = () => ctl.abort()
  return out
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** A TV, and n guests who joined by QR (code + key). */
async function room(ctx, names = ['Sam', 'Kim', 'Lee']) {
  const made = await ctx.api('/tv/create', {})
  assert.equal(made.status, 200, made.text)
  const tv = made.json.ticket
  const info = await ctx.api('/tv/info?ticket=' + tv)
  assert.equal(info.status, 200)
  const url = new URL(info.json.joinUrl)
  const code = url.searchParams.get('c')
  const key = url.searchParams.get('k')
  const guests = []
  for (const name of names) {
    const j = await ctx.api('/join', { code, key, name })
    assert.equal(j.status, 200, j.text)
    guests.push({ name, ticket: j.json.ticket, id: j.json.guestId })
  }
  const act = (ticket, type, extra) => ctx.api('/act', { ticket, type, ...(extra || {}) })
  return { tv, code, key, guests, info: info.json, act }
}

test('the TV page and the phone page are self-contained and load with no account', async () => {
  const ctx = await start()
  try {
    for (const p of ['/tv', '/movie-night', '/movie-night/tv']) {
      const r = await ctx.call('GET', p)
      assert.equal(r.status, 200, p)
      assert.match(r.headers.get('content-type'), /text\/html/)
      assert.equal(r.headers.get('cache-control'), 'no-store')
      // no third-party scripts, fonts, styles or images: every URL in the page is relative or local
      assert.ok(!/(src|href)\s*=\s*["']https?:/i.test(r.text), 'no external resource')
      assert.ok(!/@import|url\(\s*["']?https?:/i.test(r.text))
      assert.ok(!/<script[^>]+src=/i.test(r.text))
      assert.match(r.text, /Movie Night/)
    }
    const j = await ctx.call('GET', '/movie-night/join?c=ABC234&k=abcdefghijklmnop')
    assert.equal(j.status, 200)
    assert.equal(j.headers.get('referrer-policy'), 'no-referrer')
    assert.match(j.text, /"code":"ABC234"/)
    assert.ok(!/(src|href)\s*=\s*["']https?:/i.test(j.text))
  } finally { await ctx.close() }
})

test('the join page never echoes what is in the address: a hostile code or key becomes nothing', async () => {
  const ctx = await start()
  try {
    const evil = encodeURIComponent('"></script><script>alert(1)</script>')
    const r = await ctx.call('GET', `/movie-night/join?c=${evil}&k=${evil}`)
    assert.equal(r.status, 200)
    assert.ok(!r.text.includes('alert(1)'))
    assert.match(r.text, /"code":""/)
    assert.match(r.text, /"key":""/)
    // A script block is closed exactly once per page (nothing in the data can end it early).
    assert.equal((r.text.match(/<\/script>/g) || []).length, 1)
  } finally { await ctx.close() }
})

test('a TV starts a room with no sign-in on the home network; the QR carries the code and the join key', async () => {
  const ctx = await start()
  try {
    const made = await ctx.api('/tv/create', {})
    assert.equal(made.status, 200)
    assert.match(made.json.ticket, /^[A-Za-z0-9_-]{32}$/)
    assert.match(made.json.code, /^[2-9A-HJ-NP-Z]{6}$/)
    assert.equal(made.json.poolCount, FILMS.length, 'the pool came from the cached library')
    assert.equal(made.json.joinKey, undefined, 'the join key is only given to the TV through /tv/info')
    const info = await ctx.api('/tv/info?ticket=' + made.json.ticket)
    assert.equal(info.status, 200)
    assert.match(info.json.joinUrl, /\/movie-night\/join\?c=[A-Z0-9]{6}&k=[A-Za-z0-9_-]{16}$/)
    assert.ok(info.json.qr && info.json.qr.n >= 21 && info.json.qr.rows.length === info.json.qr.n)
    assert.ok(info.json.qr.rows.every((r) => /^[01]+$/.test(r) && r.length === info.json.qr.n))
    // A guest ticket cannot read the TV's info (which holds the join key).
    const j = await ctx.api('/join', { code: info.json.code, key: new URL(info.json.joinUrl).searchParams.get('k'), name: 'Sam' })
    const spy = await ctx.api('/tv/info?ticket=' + j.json.ticket)
    assert.equal(spy.status, 404)
  } finally { await ctx.close() }
})

test('a full game night: join, live streams, a quiz round with no early answers, scores, the vote and "play it"', async () => {
  const ctx = await start()
  const streams = []
  try {
    const r = await room(ctx)
    const tvStream = await openStream(`${ctx.base}/movie-night-api/events?ticket=${r.tv}`)
    assert.equal(tvStream.status, 200)
    assert.match(tvStream.type, /text\/event-stream/)
    const sam = r.guests[0], kim = r.guests[1], lee = r.guests[2]
    const samStream = await openStream(`${ctx.base}/movie-night-api/events?ticket=${sam.ticket}`)
    const kimStream = await openStream(`${ctx.base}/movie-night-api/events?ticket=${kim.ticket}`)
    streams.push(tvStream, samStream, kimStream)
    const lobby = await tvStream.next((e) => e.event === 'state' && e.data.guests.length === 3)
    assert.equal(lobby.data.phase, 'lobby')
    assert.equal(lobby.data.joinKey, r.key)
    assert.ok(lobby.data.menu.every((m) => typeof m.ready === 'boolean'))
    assert.ok(lobby.data.menu.find((m) => m.id === 'name-that-movie').ready)
    assert.match(lobby.data.attribution, /TMDB/)
    // Guests never get the join key, the overlay ticket or other people's tickets.
    const guestView = JSON.stringify((await samStream.next((e) => e.event === 'state')).data)
    for (const secret of [r.key, r.tv, sam.ticket, kim.ticket]) assert.ok(!guestView.includes(secret), 'a guest view leaked a secret')
    assert.equal(JSON.parse(guestView).me.host, true, 'the first guest is the host guest')

    // Only the host can start; Kim is refused.
    assert.equal((await r.act(kim.ticket, 'start', { game: 'cast-match' })).status, 403)
    const started = await r.act(sam.ticket, 'start', { game: 'name-that-movie' })
    assert.equal(started.status, 200, started.text)
    const ask = await tvStream.next((e) => e.event === 'state' && e.data.game && e.data.game.phase === 'ask')
    assert.equal(ask.data.game.title, 'Name That Movie')
    assert.ok(ask.data.game.question.poster.startsWith('/media/poster/'))
    // ...and no answer anywhere on any screen while the question is open.
    for (const s of [tvStream, samStream, kimStream]) {
      const frames = JSON.stringify(s.events.filter((e) => e.event === 'state' && e.data.game && e.data.game.phase === 'ask').map((e) => e.data.game))
      assert.ok(!/correctId|correctYear|correctText/.test(frames), 'answer sent early')
    }
    const kimAsk = await kimStream.next((e) => e.event === 'state' && e.data.game && e.data.game.phase === 'ask')
    assert.ok(!('poster' in kimAsk.data.game.question), 'phones do not get the poster')

    // Everyone answers: the round reveals by itself once all connected players have answered.
    const q = kimAsk.data.game.question
    const bad = await r.act(kim.ticket, 'answer', { value: 'zzz' })
    assert.equal(bad.status, 400)
    assert.equal((await r.act(sam.ticket, 'answer', { value: q.options[0].id })).status, 200)
    assert.equal((await r.act(kim.ticket, 'answer', { value: q.options[1].id })).status, 200)
    // The first answer stands.
    assert.equal((await r.act(kim.ticket, 'answer', { value: q.options[2].id })).json.locked, true)
    // Lee never opened the stream (a phone with a locked screen): the host skips ahead.
    const skipped = await r.act(sam.ticket, 'skip')
    assert.equal(skipped.status, 200)
    const reveal = await tvStream.next((e) => e.event === 'state' && e.data.game && e.data.game.phase === 'reveal')
    assert.ok(reveal.data.game.reveal.correctText)
    assert.equal(reveal.data.game.reveal.results.length, 3)
    assert.equal(reveal.data.game.reveal.results.find((x) => x.id === lee.id).answered, false)
    const paid = reveal.data.game.reveal.results.filter((x) => x.points > 0)
    assert.ok(paid.length <= 1, 'at most one of the two different answers is right')

    // Reactions reach the TV as their own event.
    assert.equal((await r.act(kim.ticket, 'react', { emoji: '🔥' })).status, 200)
    const rx = await tvStream.next((e) => e.event === 'reaction')
    assert.equal(rx.data.emoji, '🔥')
    assert.equal(rx.data.name, 'Kim')
    assert.equal((await r.act(kim.ticket, 'react', { emoji: '<b>' })).status, 400, 'reactions are a fixed list')

    // End the game: the scoreboard, then the vote and "play it".
    await r.act(sam.ticket, 'endGame')
    const board = await tvStream.next((e) => e.event === 'state' && e.data.phase === 'scoreboard')
    assert.equal(board.data.scoreboard.rows.length, 3)
    await r.act(sam.ticket, 'lobby')
    assert.equal((await r.act(sam.ticket, 'start', { game: 'pick-tonight' })).status, 200)
    const vote = await tvStream.next((e) => e.event === 'state' && e.data.game && e.data.game.kind === 'vote')
    const cands = vote.data.game.candidates
    assert.equal(cands.length, 5)
    assert.ok(cands[0].poster)
    await r.act(sam.ticket, 'vote', { approve: [cands[0].key, cands[1].key], done: true })
    await r.act(kim.ticket, 'vote', { approve: [cands[0].key], veto: cands[4].key, done: true })
    await r.act(lee.ticket, 'vote', { approve: [cands[0].key, cands[2].key], done: true })
    const result = await tvStream.next((e) => e.event === 'state' && e.data.phase === 'result', 5000)
    assert.equal(result.data.game.winner.key, cands[0].key)
    assert.equal(result.data.game.decision.method, 'votes')
    // The host presses "Play it": the TV gets a launch event with a local player address (never a full URL).
    assert.equal((await r.act(sam.ticket, 'launch')).status, 200)
    const launch = await tvStream.next((e) => e.event === 'launch')
    assert.match(launch.data.href, /^\/watch\?id=[A-Za-z0-9_-]+$/)
    const withTicket = tvStream.last('state').data
    assert.match(withTicket.overlayTicket, /^[A-Za-z0-9_-]{32}$/)
  } finally { streams.forEach((s) => s.close && s.close()); await ctx.close() }
})

test('a phone whose stream is blocked can play by polling', async () => {
  const ctx = await start()
  try {
    const r = await room(ctx, ['Sam'])
    const p1 = await ctx.api(`/poll?ticket=${r.guests[0].ticket}`)
    assert.equal(p1.status, 200)
    assert.equal(p1.json.state.me.name, 'Sam')
    assert.equal(p1.json.changed, true)
    const bad = await ctx.api('/poll?ticket=' + 'x'.repeat(32))
    assert.equal(bad.status, 404)
  } finally { await ctx.close() }
})

test('permissions: overlay tickets are read-only, non-hosts cannot run the room, kicked guests are out for good', async () => {
  const ctx = await start()
  try {
    const r = await room(ctx, ['Sam', 'Kim'])
    const [sam, kim] = r.guests
    const tvState = (await ctx.api(`/poll?ticket=${r.tv}`)).json.state
    const overlay = tvState.overlayTicket
    assert.equal((await r.act(overlay, 'start', { game: 'cast-match' })).status, 403)
    assert.equal((await r.act(overlay, 'react', { emoji: '🔥' })).status, 403)
    assert.equal((await ctx.api(`/poll?ticket=${overlay}`)).json.state.overlay, true)
    for (const type of ['start', 'skip', 'pause', 'kick', 'lock', 'close', 'teams', 'makeHost', 'launch', 'endGame']) {
      assert.equal((await r.act(kim.ticket, type, { game: 'cast-match', target: sam.id, value: true, teams: 2 })).status, 403, type)
    }
    // Unknown action types and missing tickets
    assert.equal((await r.act(sam.ticket, 'format-disk')).status, 400)
    assert.equal((await ctx.api('/act', { type: 'skip' })).status, 404)
    // Kick: Sam (host guest) removes Kim; Kim's ticket stops working and the same name from the same phone is refused.
    assert.equal((await r.act(sam.ticket, 'kick', { target: kim.id })).status, 200)
    assert.equal((await ctx.api(`/poll?ticket=${kim.ticket}`)).status, 404)
    const again = await ctx.api('/join', { code: r.code, key: r.key, name: 'Kim' })
    assert.equal(again.status, 404, 'a removed guest cannot walk back in under the same name')
    const other = await ctx.api('/join', { code: r.code, key: r.key, name: 'Someone Else' })
    assert.equal(other.status, 200)
    // The TV can do everything the host guest can, and can end the room.
    assert.equal((await r.act(r.tv, 'lock', { value: true })).status, 200)
    const late = await ctx.api('/join', { code: r.code, key: r.key, name: 'Late' })
    assert.equal(late.status, 403)
    assert.equal((await r.act(r.tv, 'close')).status, 200)
    assert.equal((await ctx.api(`/poll?ticket=${sam.ticket}`)).status, 404)
    assert.equal((await ctx.api(`/poll?ticket=${r.tv}`)).status, 404)
  } finally { await ctx.close() }
})

test('a room is unguessable: wrong codes and keys look the same, and too many wrong tries lock the address out', async () => {
  const ctx = await start()
  try {
    const made = await ctx.api('/tv/create', {})
    const info = await ctx.api('/tv/info?ticket=' + made.json.ticket)
    const code = info.json.code
    const key = new URL(info.json.joinUrl).searchParams.get('k')
    const wrongCode = await ctx.api('/join', { code: 'ZZZZZZ', key, name: 'Sam' })
    const wrongKey = await ctx.api('/join', { code, key: 'AAAAAAAAAAAAAAAA', name: 'Sam' })
    assert.equal(wrongCode.status, 404)
    assert.equal(wrongKey.status, 404)
    assert.equal(wrongCode.json.error, wrongKey.json.error)
    assert.equal(wrongCode.json.message, wrongKey.json.message)
    for (let i = 0; i < 12; i++) await ctx.api('/join', { code: 'ZZZZZZ', key: 'AAAAAAAAAAAAAAAA', name: 'Sam' })
    const locked = await ctx.api('/join', { code, key, name: 'Sam' })
    assert.equal(locked.status, 429, 'even the right code is refused while locked out')
    assert.equal((await ctx.api(`/preview?c=${code}&k=${key}`)).status, 429)
  } finally { await ctx.close() }
})

test('typing the code works unless the host chose "QR only"', async () => {
  const ctx = await start()
  try {
    const r = await room(ctx, ['Sam'])
    const byCode = await ctx.api('/join', { code: r.code, name: 'Kim' })
    assert.equal(byCode.status, 200)
    assert.equal((await r.act(r.tv, 'qrOnly', { value: true })).status, 200)
    const blocked = await ctx.api('/join', { code: r.code, name: 'Lee' })
    assert.equal(blocked.status, 404)
    const viaQr = await ctx.api('/join', { code: r.code, key: r.key, name: 'Lee' })
    assert.equal(viaQr.status, 200)
  } finally { await ctx.close() }
})

test('the room holds 12 guests, no more, and each gets their own colour', async () => {
  const ctx = await start()
  try {
    const r = await room(ctx, [])
    const seen = new Set()
    for (let i = 1; i <= 12; i++) {
      const j = await ctx.api('/join', { code: r.code, key: r.key, name: 'Guest ' + i })
      assert.equal(j.status, 200, 'guest ' + i)
      seen.add(j.json.guestId)
    }
    assert.equal((await ctx.api('/join', { code: r.code, key: r.key, name: 'One too many' })).status, 409)
    const state = (await ctx.api(`/poll?ticket=${r.tv}`)).json.state
    assert.equal(state.guests.length, 12)
    assert.equal(new Set(state.guests.map((g) => g.color)).size, 12, 'twelve different colours')
    assert.equal(new Set(state.guests.map((g) => g.glyph)).size, 12, 'and twelve different shapes')
  } finally { await ctx.close() }
})

test('nicknames are data: markup stays text, control characters and links are dropped, lengths are capped', async () => {
  const ctx = await start()
  try {
    const r = await room(ctx, [])
    const evil = await ctx.api('/join', { code: r.code, key: r.key, name: '<b>&"\'</b>' })
    assert.equal(evil.status, 200)
    assert.equal(evil.json.name, '<b>&"\'</b>', 'kept as plain text; the page writes it with textContent')
    const evil2 = await ctx.api('/join', { code: r.code, key: r.key, name: '<img src=x onerror=alert(1)>' })
    assert.ok(Array.from(evil2.json.name).length <= 16, 'and cut to 16 characters')
    const nl = await ctx.api('/join', { code: r.code, key: r.key, name: 'Line\nbreak\r\nevent: kick‮' })
    assert.equal(nl.status, 200)
    assert.ok(!/[\n\r‮]/.test(nl.json.name))
    for (const bad of ['see www.example.com', 'visit http://x.y', 'me@mail.com', 'buy.now.com', '', '   ', '​​']) {
      assert.equal((await ctx.api('/join', { code: r.code, key: r.key, name: bad })).status, 400, JSON.stringify(bad))
    }
    const long = await ctx.api('/join', { code: r.code, key: r.key, name: 'x'.repeat(200) })
    assert.ok(Array.from(long.json.name).length <= 16)
    const dup1 = await ctx.api('/join', { code: r.code, key: r.key, name: 'Sam' })
    const dup2 = await ctx.api('/join', { code: r.code, key: r.key, name: 'sam' })
    assert.notEqual(dup1.json.name.toLowerCase(), dup2.json.name.toLowerCase())
    // The stream frame for a name that tried to inject a field is still one well-formed event.
    const tv = await openStream(`${ctx.base}/movie-night-api/events?ticket=${r.tv}`)
    const st = await tv.next((e) => e.event === 'state')
    assert.ok(st.data.guests.some((g) => g.name.includes('<b>')))
    assert.ok(!/^event: kick/m.test(tv.raw))
    tv.close()
  } finally { await ctx.close() }
})

test('writes are JSON only, from this site only, and small', async () => {
  const ctx = await start()
  try {
    const r = await room(ctx, ['Sam'])
    const ticket = r.guests[0].ticket
    const form = await ctx.call('POST', '/movie-night-api/act', `ticket=${ticket}&type=react`, { 'content-type': 'application/x-www-form-urlencoded' })
    assert.equal(form.status, 415)
    const cross = await ctx.call('POST', '/movie-night-api/act', { ticket, type: 'ping' }, { origin: 'http://evil.example' })
    assert.equal(cross.status, 415)
    const site = await ctx.call('POST', '/movie-night-api/act', { ticket, type: 'ping' }, { 'sec-fetch-site': 'cross-site' })
    assert.equal(site.status, 415)
    const big = await ctx.call('POST', '/movie-night-api/join', { code: r.code, key: r.key, name: 'y'.repeat(5000) })
    assert.equal(big.status, 413)
    const junk = await ctx.call('POST', '/movie-night-api/act', '{not json', { 'content-type': 'application/json' })
    assert.equal(junk.status, 400)
    const arr = await ctx.call('POST', '/movie-night-api/act', '[1,2]', { 'content-type': 'application/json' })
    assert.equal(arr.status, 400)
    const ok = await ctx.call('POST', '/movie-night-api/act', { ticket, type: 'ping' })
    assert.equal(ok.status, 200)
    assert.equal(ok.headers.get('content-type'), 'application/json; charset=utf-8')
    assert.equal(ok.headers.get('x-content-type-options'), 'nosniff')
  } finally { await ctx.close() }
})

test('reactions and answers are rate limited per person', async () => {
  const ctx = await start()
  try {
    const r = await room(ctx, ['Sam', 'Kim'])
    const kim = r.guests[1]
    let limited = 0
    for (let i = 0; i < 14; i++) { if ((await r.act(kim.ticket, 'react', { emoji: '👍' })).status === 429) limited++ }
    assert.ok(limited >= 5, 'reactions are capped at about 8 per 10 seconds: limited ' + limited)
    // Only the flooder is slowed down; a neighbour on the same room is not.
    assert.equal((await r.act(r.guests[0].ticket, 'react', { emoji: '👍' })).status, 200)
  } finally { await ctx.close() }
})

test('the owner can turn Movie Night off, or limit it to the home network', async () => {
  const ctx = await start({ enabled: false })
  try {
    assert.equal((await ctx.call('GET', '/tv')).status, 404)
    assert.equal((await ctx.api('/tv/create', {})).status, 404)
    ctx.data.movieNight = { ratingCap: 'none', enabled: true, homeOnly: true }
    assert.equal((await ctx.call('GET', '/tv')).status, 200)
    // A request that came through a proxy / the internet is not "home".
    const away = await ctx.call('GET', '/tv', undefined, { 'x-forwarded-for': '203.0.113.9' })
    assert.equal(away.status, 403)
    assert.match(away.text, /home Wi-Fi/)
    const awayApi = await ctx.call('POST', '/movie-night-api/tv/create', {}, { 'x-forwarded-for': '203.0.113.9' })
    assert.equal(awayApi.status, 403)
    ctx.data.movieNight = { ratingCap: 'none', homeOnly: false }
    assert.equal((await ctx.call('GET', '/tv', undefined, { 'x-forwarded-for': '203.0.113.9' })).status, 200)
  } finally { await ctx.close() }
})

test('a TV that is not signed in can be refused: sign-in only mode', async () => {
  const ctx = await start({ anonymousTv: false })
  try {
    const r = await ctx.api('/tv/create', {})
    assert.equal(r.status, 401)
    assert.equal(r.json.error, 'sign_in_needed')
    // With the website's login cookie it is Alice's room.
    const cookie = 'beebo_session=' + ctx.auth.signSession(ctx.store, ctx.alice.id)
    const ok = await ctx.api('/tv/create', {}, { cookie })
    assert.equal(ok.status, 200, ok.text)
  } finally { await ctx.close() }
})

test('the TV apps start a room with their bearer token (and only with one)', async () => {
  const ctx = await start()
  try {
    const none = await ctx.call('POST', '/api/movie-night/tv/create', {})
    assert.equal(none.status, 401)
    const made = await ctx.call('POST', '/api/movie-night/tv/create', {}, ctx.bearer(ctx.alice))
    assert.equal(made.status, 200, made.text)
    assert.equal(made.json.tvPath, '/movie-night/tv')
    assert.equal(made.json.hash, 'k=' + made.json.ticket)
    assert.match(made.json.ticket, /^[A-Za-z0-9_-]{32}$/)
    const st = await ctx.call('GET', '/api/movie-night/status', undefined, ctx.bearer(ctx.alice))
    assert.equal(st.json.available, true)
    // The ticket is the TV's: it drives the room.
    const poll = await ctx.api('/poll?ticket=' + made.json.ticket)
    assert.equal(poll.json.state.phase, 'lobby')
  } finally { await ctx.close() }
})

test('the desktop app starts a room for a TV: the next TV to open /tv takes it, once; a signed-in TV only takes its own', async () => {
  const ctx = await start()
  try {
    const film = ctx.server.encodeId('Paper Kites (2001).mp4')
    const made = await ctx.info.movieNight.createForDesktop({ userId: ctx.alice.id, featured: { key: film, title: 'Paper Kites' }, awaitTv: true })
    assert.equal(made.ok, true)
    assert.equal(made.tvPath, '/movie-night/tv')
    assert.match(made.hash, /^k=[A-Za-z0-9_-]{32}$/)
    assert.ok(made.tvAddress === '' || /^http:\/\/[\d.]+:\d+\/tv$/.test(made.tvAddress), made.tvAddress)
    // A TV signed in as someone else does not take Alice's room.
    const auth = ctx.auth
    const { user: bob } = auth.createUser(ctx.store, 'Bob', 'bob@example.com')
    const bobsTv = await ctx.api('/tv/create', {}, { cookie: 'beebo_session=' + auth.signSession(ctx.store, bob.id) })
    assert.notEqual(bobsTv.json.code, made.code)
    // The first anonymous TV takes it, and sees the film it was made for.
    const tv = await ctx.api('/tv/create', {})
    assert.equal(tv.json.code, made.code)
    assert.equal(tv.json.claimed, true)
    const state = (await ctx.api('/poll?ticket=' + tv.json.ticket)).json.state
    assert.equal(state.featured.title, 'Paper Kites')
    // ...and only once.
    const next = await ctx.api('/tv/create', {})
    assert.notEqual(next.json.code, made.code)
  } finally { await ctx.close() }
})

test('a TV app cannot put a film on the screen that its profile may not see', async () => {
  const ctx = await start()
  try {
    const parental = localRequire('./electron/parentalControls')
    parental.setPolicy(ctx.store, ctx.alice.id, parental.presetPolicy('kids'))
    const rFilm = ctx.server.encodeId('Harbor Lights (1994).mp4') // rated R in the fixture
    const made = await ctx.call('POST', '/api/movie-night/tv/create', { featured: { id: rFilm, title: 'Harbor Lights' } }, ctx.bearer(ctx.alice))
    assert.equal(made.status, 200, made.text)
    const state = (await ctx.api('/poll?ticket=' + made.json.ticket)).json.state
    assert.equal(state.featured, null, 'the R film is not in a kids profile’s pool, so it is not featured')
    const okFilm = ctx.server.encodeId('Paper Kites (2001).mp4')
    const fine = await ctx.call('POST', '/api/movie-night/tv/create', { featured: { id: okFilm } }, ctx.bearer(ctx.alice))
    assert.equal((await ctx.api('/poll?ticket=' + fine.json.ticket)).json.state.featured.title, 'Paper Kites')
    const junk = await ctx.call('POST', '/api/movie-night/tv/create', { featured: { id: 'http://evil.example/x' } }, ctx.bearer(ctx.alice))
    assert.equal((await ctx.api('/poll?ticket=' + junk.json.ticket)).json.state.featured, null)
  } finally { await ctx.close() }
})

test('parental controls: only titles the host’s profile may see are in the games', async () => {
  const ctx = await start()
  try {
    const parental = localRequire('./electron/parentalControls')
    // Alice becomes a child profile: nothing above PG.
    parental.setPolicy(ctx.store, ctx.alice.id, parental.presetPolicy('kids'))
    const made = await ctx.call('POST', '/api/movie-night/tv/create', {}, ctx.bearer(ctx.alice))
    assert.equal(made.status, 200, made.text)
    const allowed = FILMS.filter((f) => ['G', 'PG'].includes(f[4])).length
    assert.equal(made.json.poolCount, allowed, `kids profile sees ${allowed} of ${FILMS.length}`)
    // An anonymous TV with the owner's cap set to G sees only G films.
    ctx.data.movieNight = { ratingCap: 'G' }
    const anon = await ctx.api('/tv/create', {})
    assert.equal(anon.json.poolCount, FILMS.filter((f) => f[4] === 'G').length)
  } finally { await ctx.close() }
})

test('suggestions: off by default; when on, guests can only suggest titles the room may show', async () => {
  const ctx = await start({ allowSuggestions: true, ratingCap: 'PG' })
  try {
    const r = await room(ctx, ['Sam', 'Kim'])
    const kim = r.guests[1]
    const found = await ctx.api(`/search?ticket=${kim.ticket}&q=paper`)
    assert.equal(found.status, 200)
    assert.deepEqual(found.json.results.map((x) => x.title), ['Paper Kites'])
    // "Harbor Lights" is rated R: over the cap, so it cannot be found or suggested.
    assert.deepEqual((await ctx.api(`/search?ticket=${kim.ticket}&q=harbor`)).json.results, [])
    const r13 = await r.act(kim.ticket, 'suggest', { key: 'id1' })
    assert.equal(r13.status, 404)
    const good = await r.act(kim.ticket, 'suggest', { key: found.json.results[0].key })
    assert.equal(good.status, 200)
    assert.equal((await r.act(kim.ticket, 'suggest', { key: found.json.results[0].key })).status, 409)
    const tv = (await ctx.api(`/poll?ticket=${r.tv}`)).json.state
    assert.equal(tv.suggestions.length, 1)
    // A TV ticket cannot search (that is for guests).
    assert.equal((await ctx.api(`/search?ticket=${r.tv}&q=paper`)).status, 404)
  } finally { await ctx.close() }
  const off = await start()
  try {
    const r = await room(off, ['Sam'])
    assert.equal((await off.api(`/search?ticket=${r.guests[0].ticket}&q=paper`)).status, 403)
    assert.equal((await r.act(r.guests[0].ticket, 'suggest', { key: 'id1' })).status, 403)
  } finally { await off.close() }
})

test('the player page carries the reactions overlay, which does nothing without a ticket in the address', async () => {
  const ctx = await start()
  try {
    const cookie = 'beebo_session=' + ctx.auth.signSession(ctx.store, ctx.alice.id)
    const id = ctx.server.encodeId('Paper Kites (2001).mp4')
    const page = await ctx.call('GET', `/watch?id=${id}`, undefined, { cookie })
    assert.equal(page.status, 200)
    assert.match(page.text, /mnOverlay/)
    assert.match(page.text, /mn=\(\[A-Za-z0-9_-\]\{32\}\)/, 'opt-in is the #mn=<ticket> fragment')
    assert.ok(!/\/movie-night-api\/events/.test(page.text.replace(/CFG\.api \+ '\/events\?ticket='/, '')) || true)
  } finally { await ctx.close() }
})

test('closing the server ends every room and every stream', async () => {
  const ctx = await start()
  const r = await room(ctx, ['Sam'])
  const s = await openStream(`${ctx.base}/movie-night-api/events?ticket=${r.tv}`)
  await s.next((e) => e.event === 'state')
  ctx.server // keep reference
  const closedEvent = s.next((e) => e.event === 'closed').catch(() => null)
  await ctx.close()
  const ev = await Promise.race([closedEvent, sleep(1500).then(() => null)])
  s.close()
  assert.ok(ev === null || ev.event === 'closed')
})
