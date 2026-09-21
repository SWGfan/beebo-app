// Phone speakers over HTTP (electron/phoneSpeakersHttp.js) on a bare server with a real room manager: the public guest page and
// script, the owner's door, guests joining with no account and a header token, Server-Sent Events between the screen and phones,
// the audio pieces, the home-network-only rule, cross-site refusals, body caps and the off switch.
// Run: NODE_PATH=<desktop node_modules> node --test test/phone-speakers-http.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const ch = require('../electron/phoneSpeakersChannels')
const ps = require('../electron/phoneSpeakers')
const web = require('../electron/phoneSpeakersHttp')
const fx = require('./phone-speakers-fixture')

const SRC51 = ch.describeSource({ channels: 6, channelLayout: '5.1(side)', streamIndex: 1, codec: 'eac3' })
const film = { kind: 'movie', id: 'Q2xpcC5ta3Y', title: 'Big Film' }

/** A tiny valid mono WAV, so the audio route has something real to stream. */
function tinyWav(dir, name) {
  const n = 160, buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(32000, 24); buf.writeUInt32LE(64000, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40)
  const f = path.join(dir, name); fs.writeFileSync(f, buf); return f
}

async function boot(o = {}) {
  const dir = fx.tmpDir('beebo-spk-http-')
  const state = { enabled: true, remote: false }
  const asked = []
  const manager = ps.createPhoneSpeakers({
    canView: async (userId, kind, id) => (userId === 'kid' || id === 'BLOCKED' ? { ok: false } : { ok: true, title: 'From library' }),
    prepare: async () => ({ ok: true, source: SRC51, durationSec: 600, audioKey: 'k1', rate: 32000 }),
    rates: o.rates || {}
  })
  const audio = { async segment(session, feed, n, opts) { asked.push([feed, n]); if (n > 99) return null; if (n === 42) throw new Error('boom'); await new Promise((r) => setTimeout(r, 5)); return opts && opts.aborted && opts.aborted() ? null : tinyWav(dir, `${feed}-${n}.wav`) } }
  const h = web.createPhoneSpeakersHttp({
    manager, audio,
    getSession: (k) => (k === 'k1' ? { key: k } : null),
    getIp: (req) => String(req.headers['x-test-ip'] || '127.0.0.1'),
    isHomeRequest: (req) => !req.headers['x-away'],
    isEnabled: () => state.enabled, allowRemote: () => state.remote,
    getJoinOrigin: () => 'http://192.168.1.20:47811', qrSvg: (t) => `<svg xmlns="http://www.w3.org/2000/svg" data-len="${t.length}"><path d="M0 0"/></svg>`,
    getUser: (id) => (id === 'owner' || id === 'kid' ? { id, name: id, username: id } : null),
    defaults: () => ({ fillIn: 'tv' }), setInterval: () => 0
  })
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    if (h.claims(url.pathname)) { await h.handle(req, res, url); return }
    if (url.pathname.startsWith('/phone-speakers-api/')) {
      const send = (s, obj) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }
      const userId = req.headers['x-test-user'] || ''
      if (!userId) { send(302, { error: 'login' }); return }
      if (await h.handleOwner(req, res, url, url.pathname.slice('/phone-speakers-api'.length), { userId, send })) return
      send(404, { ok: false }); return
    }
    res.writeHead(404); res.end()
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const ctl = {
    base, h, manager, state, asked, dir,
    close: () => new Promise((r) => { h.close(); server.closeAllConnections && server.closeAllConnections(); server.close(r) }),
    req: async (method, p, { body, token, headers, raw } = {}) => {
      const r = await fetch(base + p, {
        method, headers: { ...(body !== undefined && !raw ? { 'content-type': 'application/json' } : {}), ...(token ? { 'X-Speaker-Token': token } : {}), ...(headers || {}) },
        body: body === undefined ? undefined : raw ? body : JSON.stringify(body)
      })
      const text = await r.text(); let json = null; try { json = JSON.parse(text) } catch {}
      return { status: r.status, json, text, headers: r.headers }
    },
    async owner(user = 'owner') {
      const r = await ctl.req('POST', '/phone-speakers-api/create', { body: film, headers: { 'x-test-user': user } })
      return r
    }
  }
  return ctl
}

/** Reads a Server-Sent Events response. */
async function stream(base, p, token) {
  const ctl = new AbortController()
  const res = await fetch(base + p, { headers: token ? { 'X-Speaker-Token': token } : {}, signal: ctl.signal })
  const out = { status: res.status, type: res.headers.get('content-type'), events: [], raw: '', waiters: [] }
  if (res.status !== 200) { out.body = await res.text(); return out }
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = ''
  ;(async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) break
        const chunk = dec.decode(value, { stream: true }); out.raw += chunk; buf += chunk
        let i
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2)
          if (frame.startsWith(':') || frame.startsWith('retry:')) continue
          const ev = { event: 'message', data: [] }
          for (const line of frame.split('\n')) { if (line.startsWith('event: ')) ev.event = line.slice(7); else if (line.startsWith('data: ')) ev.data.push(line.slice(6)) }
          ev.data = JSON.parse(ev.data.join('\n')); out.events.push(ev); out.waiters = out.waiters.filter((w) => !w(ev))
        }
      }
    } catch {}
  })()
  out.next = (pred, ms = 3000) => new Promise((resolve, reject) => {
    const hit = out.events.find(pred); if (hit) return resolve(hit)
    const t = setTimeout(() => reject(new Error('timed out; saw ' + out.events.map((e) => e.event).join(','))), ms)
    out.waiters.push((ev) => { if (pred(ev)) { clearTimeout(t); resolve(ev); return true } return false })
  })
  out.close = () => ctl.abort()
  return out
}

test('the guest page and script are public, static, carry no room data and are locked down', async () => {
  const s = await boot()
  try {
    const page = await s.req('GET', '/speakers/join?k=' + 'A'.repeat(26))
    assert.equal(page.status, 200); assert.match(page.headers.get('content-type'), /text\/html/)
    assert.equal(page.text.includes('A'.repeat(26)), false, 'the key is never echoed into the page')
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'.*script-src 'self'.*frame-ancestors 'none'/)
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer'); assert.equal(page.headers.get('x-frame-options'), 'DENY'); assert.equal(page.headers.get('cache-control'), 'no-store')
    assert.match(page.text, /<script src="\/speakers\/client\.js"><\/script>/); assert.ok(!/<script>[^<]/.test(page.text), 'no inline script (a strict CSP works)')
    const js = await s.req('GET', '/speakers/client.js')
    assert.equal(js.status, 200); assert.match(js.headers.get('content-type'), /application\/javascript/); assert.equal(js.text, fs.readFileSync(path.join(__dirname, '..', 'electron', 'phoneSpeakersClient.js'), 'utf8'))
    assert.equal(js.headers.get('x-content-type-options'), 'nosniff')
    assert.equal((await s.req('GET', '/speakers/nothing')).status, 404)
    assert.equal((await s.req('GET', '/speakers/api/nothing')).status, 404)
  } finally { await s.close() }
})

test('the owner starts a room (signed in, may watch it); a kid, an anonymous caller and a cross-site page cannot', async () => {
  const s = await boot()
  try {
    const anon = await s.req('POST', '/phone-speakers-api/create', { body: film })
    assert.equal(anon.status, 302, 'the sign-in gate sends an anonymous caller to log in')
    const kid = await s.owner('kid'); assert.equal(kid.status, 403); assert.equal(kid.json.error, 'unavailable')
    const blocked = await s.req('POST', '/phone-speakers-api/create', { body: { kind: 'movie', id: 'BLOCKED' }, headers: { 'x-test-user': 'owner' } })
    assert.equal(blocked.status, 403)
    assert.equal((await s.req('POST', '/phone-speakers-api/create', { body: { kind: 'movie', id: '../../x' }, headers: { 'x-test-user': 'owner' } })).status, 400)
    for (const h of [{ origin: 'http://evil.example' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }, { origin: 'null' }]) {
      const r = await s.req('POST', '/phone-speakers-api/create', { body: film, headers: { 'x-test-user': 'owner', ...h } })
      assert.equal(r.status, 415, JSON.stringify(h))
    }
    assert.equal((await s.req('POST', '/phone-speakers-api/create', { body: 'x=1', raw: true, headers: { 'x-test-user': 'owner', 'content-type': 'application/x-www-form-urlencoded' } })).status, 415)
    const made = await s.owner()
    assert.equal(made.status, 200); assert.equal(made.json.ok, true)
    assert.match(made.json.code, /^[0-9A-HJKMNP-TV-Z]{26}$/); assert.match(made.json.token, /^[0-9a-f]{12}\.[0-9a-f]{32}$/)
    assert.equal(made.json.joinUrl, `http://192.168.1.20:47811/speakers/join?k=${made.json.code}`)
    assert.match(made.json.qrSvg, /^<svg /)
    assert.equal(made.json.room.you.kind, 'tv')
    const mine = await s.req('GET', '/phone-speakers-api/mine', { headers: { 'x-test-user': 'owner' } })
    assert.deepEqual(mine.json.rooms.map((r) => r.code), [made.json.code])
    assert.deepEqual((await s.req('GET', '/phone-speakers-api/mine', { headers: { 'x-test-user': 'kid' } })).json.rooms, [])
    // the page reloaded: the same person gets a fresh screen token; someone else gets nothing
    const back = await s.req('POST', '/phone-speakers-api/resume', { body: { code: made.json.code }, headers: { 'x-test-user': 'owner' } })
    assert.equal(back.status, 200); assert.notEqual(back.json.token, made.json.token)
    assert.equal((await s.req('POST', '/phone-speakers-api/resume', { body: { code: made.json.code }, headers: { 'x-test-user': 'kid' } })).status, 404)
    assert.equal((await s.req('POST', '/phone-speakers-api/create', { body: 'x'.repeat(9000), raw: true, headers: { 'x-test-user': 'owner', 'content-type': 'application/json' } })).status, 413)
    assert.equal((await s.req('POST', '/phone-speakers-api/create', { body: '{not json', raw: true, headers: { 'x-test-user': 'owner', 'content-type': 'application/json' } })).status, 400)
  } finally { await s.close() }
})

test('a guest joins with only a nickname, gets a header token, and the room is live between the screen and the phone', async () => {
  const s = await boot()
  const opened = []
  try {
    const made = (await s.owner()).json
    const tv = await stream(s.base, '/speakers/api/events', made.token); opened.push(tv)
    assert.equal(tv.status, 200); assert.match(tv.type, /text\/event-stream/)
    const first = await tv.next((e) => e.event === 'state')
    assert.equal(first.data.you.kind, 'tv'); assert.equal(first.data.host.guests.length, 0)
    const info = await s.req('GET', '/speakers/api/host/info', { token: made.token })
    assert.equal(info.json.code, made.code); assert.match(info.json.qrSvg, /^<svg/)
    // no token, or a phone's token, gets no code
    assert.equal((await s.req('GET', '/speakers/api/host/info')).status, 401)
    const j = await s.req('POST', '/speakers/api/join', { body: { k: made.code, name: 'Ann <b>Bold</b>' } })
    assert.equal(j.status, 200); assert.equal(j.json.snapshot.you.seat, 'FL'); assert.equal(j.json.snapshot.you.name, 'Ann <b>Bold</b>')
    assert.equal((await s.req('GET', '/speakers/api/host/info', { token: j.json.token })).status, 403)
    const phone = await stream(s.base, '/speakers/api/events', j.json.token); opened.push(phone)
    await phone.next((e) => e.event === 'state')
    // the phone says it tapped "Enable audio": the screen hears about it
    await s.req('POST', '/speakers/api/status', { token: j.json.token, body: { status: { unlocked: true, ready: true, seq: 1, state: 'ready', errMs: 3, driftMs: 1 } } })
    const seen = await tv.next((e) => e.event === 'state' && e.data.host.guests[0] && e.data.host.guests[0].unlocked)
    assert.equal(seen.data.host.guests[0].name, 'Ann <b>Bold</b>'); assert.equal(seen.data.host.guests[0].level, 'good')
    // the screen moves the seat and starts the film: the phone hears both
    assert.equal((await s.req('POST', '/speakers/api/host/seat', { token: made.token, body: { gid: j.json.gid, seat: 'SR' } })).status, 200)
    await phone.next((e) => e.event === 'state' && e.data.you.seat === 'SR')
    // the screen says its picture is ready (the room waits for everybody), then plays
    await s.req('POST', '/speakers/api/status', { token: made.token, body: { status: { ready: true, seq: 1, state: 'paused' } } })
    assert.equal((await s.req('POST', '/speakers/api/host/command', { token: made.token, body: { type: 'play' } })).json.timeline.state, 'playing')
    const playing = await phone.next((e) => e.event === 'state' && e.data.room.timeline.state === 'playing')
    assert.equal(playing.data.room.timeline.seq, 2)
    // a clock ping answers with server times (the phone measures the offset with these)
    const ping = await s.req('POST', '/speakers/api/ping', { token: j.json.token, body: { t0: 5 } })
    assert.equal(ping.json.t0, 5); assert.ok(ping.json.t2 >= ping.json.t1 && ping.json.t1 > 1e12)
    // measured position, beep test, kick, close
    assert.equal((await s.req('POST', '/speakers/api/host/sync', { token: made.token, body: { seq: 2, pos: 1, at: ping.json.t2 } })).status, 200)
    assert.equal((await s.req('POST', '/speakers/api/host/beep', { token: made.token, body: { action: 'start' } })).json.beep.slots.length, 2)
    assert.equal((await s.req('POST', '/speakers/api/host/kick', { token: made.token, body: { gid: j.json.gid } })).status, 200)
    await phone.next((e) => e.event === 'kicked')
    assert.equal((await s.req('POST', '/speakers/api/status', { token: j.json.token, body: { status: {} } })).status, 401)
    assert.equal((await s.req('POST', '/speakers/api/host/close', { token: made.token, body: {} })).status, 200)
    await tv.next((e) => e.event === 'closed')
  } finally { opened.forEach((o) => o.close()); await s.close() }
})

test('the token is a header, never a URL or a cookie; a page on another site cannot act for a phone', async () => {
  const s = await boot()
  try {
    const made = (await s.owner()).json
    const j = (await s.req('POST', '/speakers/api/join', { body: { k: made.code, name: 'Ann' } })).json
    const tok = j.token.split('.')[1]
    assert.equal((await s.req('GET', `/speakers/api/poll?token=${j.token}&t=${j.token}`)).status, 401, 'a token in the query string means nothing')
    assert.equal((await s.req('GET', '/speakers/api/poll', { headers: { cookie: `beebo_speaker=${j.token}`, authorization: `Bearer ${j.token}` } })).status, 401)
    assert.equal((await s.req('GET', '/speakers/api/poll', { token: j.token })).status, 200)
    for (const h of [{ origin: 'http://evil.example' }, { 'sec-fetch-site': 'cross-site' }]) {
      const r = await s.req('POST', '/speakers/api/status', { token: j.token, body: { status: { unlocked: true } }, headers: h })
      assert.equal(r.status, 415, JSON.stringify(h))
    }
    assert.equal((await s.req('POST', '/speakers/api/status', { token: j.token, body: '{"status":{}}', raw: true, headers: { 'content-type': 'text/plain' } })).status, 415, 'a "simple" cross-site form post is not JSON')
    // the answers never repeat the secret half of a token or the room code
    const poll = await s.req('GET', '/speakers/api/poll', { token: j.token })
    assert.ok(!poll.text.includes(tok) && !poll.text.includes(made.code))
  } finally { await s.close() }
})

test('audio pieces: only for a token of the room, only this room\'s film, real WAV back, and hostile paths get nothing', async () => {
  const s = await boot()
  try {
    const made = (await s.owner()).json
    const j = (await s.req('POST', '/speakers/api/join', { body: { k: made.code, name: 'Ann' } })).json
    const get = async (p, token, headers) => {
      const r = await fetch(s.base + p, { headers: { ...(token ? { 'X-Speaker-Token': token } : {}), ...(headers || {}) } })
      const buf = Buffer.from(await r.arrayBuffer()); return { status: r.status, buf, headers: r.headers }
    }
    const ok = await get('/speakers/audio/FL/0.wav', j.token, { 'X-Speaker-Seq': '1' })
    assert.equal(ok.status, 200); assert.equal(ok.headers.get('content-type'), 'audio/wav'); assert.equal(ok.buf.toString('ascii', 0, 4), 'RIFF'); assert.equal(ok.buf.length, Number(ok.headers.get('content-length')))
    assert.equal(ok.headers.get('x-content-type-options'), 'nosniff'); assert.match(ok.headers.get('cache-control'), /private/)
    assert.equal((await get('/speakers/audio/FL/0.wav')).status, 401)
    assert.equal((await get('/speakers/audio/FL/0.wav', made.token.replace(/.$/, (c) => (c === '0' ? '1' : '0')))).status, 401)
    assert.equal((await get('/speakers/audio/FL/0.wav', made.token)).status, 200, 'the screen plays layers too')
    for (const bad of ['/speakers/audio/../../etc/passwd', '/speakers/audio/FL/0.wav.tmp', '/speakers/audio/fl/0.wav', '/speakers/audio/FL/-1.wav', '/speakers/audio/FL/1234567.wav', '/speakers/audio/ZZ/0.wav', '/speakers/audio/FL/0.mp3', '/speakers/audio/FL//0.wav']) {
      const r = await get(bad, j.token); assert.ok(r.status === 404 || r.status === 400, `${bad}: ${r.status}`)
    }
    assert.equal((await get('/speakers/audio/FL/100.wav', j.token)).status, 404, 'past the end')
    const failing = await get('/speakers/audio/FL/42.wav', j.token)
    assert.equal(failing.status, 503); assert.equal(failing.headers.get('retry-after'), '2'); assert.ok(!failing.buf.toString().includes('boom'), 'the reason stays in the log')
    // a phone that has not caught up with a seek is told so (it asks again with the new plan number)
    await s.req('POST', '/speakers/api/host/command', { token: made.token, body: { type: 'seek', pos: 30 } })
    const stale = await get('/speakers/audio/FL/6.wav', j.token, { 'X-Speaker-Seq': '1' })
    assert.equal(stale.status, 409); assert.equal(JSON.parse(stale.buf.toString()).error, 'stale')
    assert.equal((await get('/speakers/audio/FL/6.wav', j.token, { 'X-Speaker-Seq': '2' })).status, 200)
    // a closed room's pieces are gone with its tokens
    await s.req('POST', '/speakers/api/host/close', { token: made.token, body: {} })
    assert.equal((await get('/speakers/audio/FL/0.wav', j.token)).status, 401)
  } finally { await s.close() }
})

test('POST /speakers/api/join: wrong codes are throttled per address, then locked; bodies are capped; unknown calls are 404', async () => {
  const s = await boot()
  try {
    const made = (await s.owner()).json
    const ip = { 'x-test-ip': '10.1.2.3' }
    const misses = []
    for (let i = 0; i < 8; i++) misses.push(await s.req('POST', '/speakers/api/join', { body: { k: 'Z'.repeat(26), name: 'x' }, headers: ip }))
    assert.ok(misses.every((r) => r.status === 404 && r.json.error === 'not_found'))
    const locked = await s.req('POST', '/speakers/api/join', { body: { k: made.code, name: 'x' }, headers: ip })
    assert.equal(locked.status, 429); assert.equal(locked.json.error, 'locked')
    assert.equal((await s.req('POST', '/speakers/api/join', { body: { k: made.code, name: 'x' }, headers: { 'x-test-ip': '10.1.2.4' } })).status, 200)
    assert.equal((await s.req('POST', '/speakers/api/join', { body: { k: 12345, name: { a: 1 } }, headers: { 'x-test-ip': '10.1.2.5' } })).status, 404)
    assert.equal((await s.req('POST', '/speakers/api/join', { body: 'y'.repeat(5000), raw: true, headers: { 'content-type': 'application/json', 'x-test-ip': '10.1.2.6' } })).status, 413)
    assert.equal((await s.req('POST', '/speakers/api/nothing', { body: {}, token: made.token })).status, 404)
    assert.equal((await s.req('GET', '/speakers/api/host/command', { token: made.token })).status, 404)
    assert.equal((await s.req('PUT', '/speakers/api/status', { body: {}, token: made.token })).status, 404)
  } finally { await s.close() }
})

test('the home network only: a request from outside is refused unless the owner allowed it; the off switch answers "switched off"', async () => {
  const s = await boot()
  try {
    const made = (await s.owner()).json
    for (const p of ['/speakers/join', '/speakers/client.js', '/speakers/api/poll', '/speakers/audio/FL/0.wav']) {
      const r = await s.req('GET', p, { headers: { 'x-away': '1' }, token: made.token }); assert.equal(r.status, 403, p); assert.equal(r.json.error, 'home_only')
    }
    assert.equal((await s.req('POST', '/speakers/api/join', { body: { k: made.code, name: 'far' }, headers: { 'x-away': '1' } })).status, 403)
    s.state.remote = true
    assert.equal((await s.req('GET', '/speakers/join', { headers: { 'x-away': '1' } })).status, 200)
    s.state.remote = false
    s.state.enabled = false
    const off = await s.req('GET', '/speakers/join'); assert.equal(off.status, 404); assert.match(off.json.message, /switched off/)
    assert.equal((await s.owner()).status, 403, 'nobody can start a room while it is off')
    s.state.enabled = true
    assert.equal((await s.req('GET', '/speakers/join')).status, 200)
  } finally { await s.close() }
})

test('streams are capped and a screen that reconnects gets the room again', async () => {
  const s = await boot()
  const opened = []
  try {
    const made = (await s.owner()).json
    const tv = await stream(s.base, '/speakers/api/events', made.token); opened.push(tv)
    await tv.next((e) => e.event === 'state')
    const a = (await s.req('POST', '/speakers/api/join', { body: { k: made.code, name: 'A' } })).json
    const st = await stream(s.base, '/speakers/api/events', a.token); opened.push(st)
    await st.next((e) => e.event === 'state')
    tv.close()
    const tv2 = await stream(s.base, '/speakers/api/events', made.token); opened.push(tv2)
    const again = await tv2.next((e) => e.event === 'state')
    assert.equal(again.data.host.guests.length, 1)
    const noTok = await stream(s.base, '/speakers/api/events'); assert.equal(noTok.status, 401)
    const bad = await stream(s.base, '/speakers/api/events', 'x'.repeat(200)); assert.equal(bad.status, 401)
  } finally { opened.forEach((o) => o.close()); await s.close() }
})
